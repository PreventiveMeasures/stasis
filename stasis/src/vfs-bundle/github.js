import { posix } from 'node:path'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { CONFIG_FILE, memoized, posixPathEscapes } from '@exodus/stasis-core/util'
import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { createClient } from '@preventive/upstream/github.js'
import { vfsFromEntries } from '@preventive/vfs'
import { buildVfsBundle, configuredLockfiles, debugTimed, prismaClientsOf } from '../cmd/bundle.js'
import { checkAhead, defaultEntries, entryPattern, expandEntries } from './entries.js'
import { checkCache, checkTarget, detectPackageManager, installedAlone, listsFile, lockfileOf, lockfilesListed, lockfilesManagers, noLockfile, packageManagerOf, vfsHost } from './tree.js'
import { YARNCLEAN } from './yarnclean.js'

// As upstream's tree verification bounds a tarball's unpacked size.
const MAX_TAR_BYTES = 2 ** 30
// Upstream's verification refuses anything else from GitHub.
const TREE_TYPES = new Set(['file', 'directory', 'symlink'])
// A lockfile's reference to `..` or under it (conservatively: any importer's).
const LOCKFILE_ESCAPE = /(?:link:|file:|directory: |["'])\.\.(?![^/"'\s])/u
const TSCONFIG = /(?:^|\/)[jt]sconfig[^/]*\.json$/u

const resolvesOutside = (from, target) => target.startsWith('/') || posixPathEscapes(posix.join(posix.dirname(from), target))

// As a checkout under umask 022 makes them: git keeps only the executable bit, and GitHub's tar.umask is 0002.
const checkoutMode = ({ type, mode }) => (type === 'symlink' ? mode : type === 'directory' || mode & 0o100 ? 0o755 : 0o644)

async function treeEntries(tarball, where) {
  const entries = []
  for (const entry of unpack(await decompress(tarball, 'gzip', { limit: MAX_TAR_BYTES }))) {
    const name = entry.name.slice(entry.name.indexOf('/') + 1)
    if (!TREE_TYPES.has(entry.type)) throw new Error(`${where}: unexpected ${entry.type} ${JSON.stringify(name)} in the tarball`)
    if (entry.name.includes('/')) entries.push({ ...entry, name, mode: checkoutMode(entry) })
  }
  return entries
}

const escapingLink = (entries) => entries.find((entry) => entry.type === 'symlink' && resolvesOutside(entry.name, entry.linkname))

function refersAbove(entries, lockfile) {
  const text = (entry) => new TextDecoder().decode(entry.data)
  return entries.some((entry) => entry.type === 'file' && (entry.name === lockfile
    ? LOCKFILE_ESCAPE.test(text(entry))
    : TSCONFIG.test(entry.name) && [...text(entry).matchAll(/"(\.\.?\/[^"]*)"/gu)].some(([, path]) => resolvesOutside(entry.name, path))))
}

// The repo's root (undefined) last.
function ancestorsOf(directory) {
  const out = []
  for (let dir = posix.dirname(directory); dir !== '.'; dir = posix.dirname(dir)) out.push(dir)
  return [...out, undefined]
}

// Upstream refuses symlinks above the tarball's root (its top directory) unless told how far they may climb: to the repo's.
async function treeFiles(client, { github, tree, directory, where }) {
  try {
    const files = await treeEntries(await client.getRepoTreeTarball({ repo: github, tree, symlinksAbove: directory.split('/').length - 1 }), where)
    return escapingLink(files) ? null : files
  } catch (error) {
    if (error instanceof ArchiveError) return null // e.g. a symlink out of the subtree
    throw error
  }
}

async function repoFiles(client, { github, sha, where }) {
  const files = await treeEntries(await client.getRepoTarball({ repo: github, sha }), where)
  const link = escapingLink(files)
  if (link) throw new Error(`${where}: symlink ${JSON.stringify(link.name)} points outside the repo`)
  return files
}

// Checked as the Bundle checks them, before anything is fetched; a `path` as a `directory`, but for a pattern's `*`.
function checkRepo(name, { github, sha, tag, directory, path }) {
  if (github === undefined) throw new Error(`${name}: github is required`)
  if (tag !== undefined && (typeof tag !== 'string' || tag === '')) throw new TypeError(`${name}: tag must be a non-empty string`)
  if (sha !== undefined && tag !== undefined) throw new Error(`${name}: sha and tag both name the commit: give one`)
  if (directory !== undefined && path !== undefined) throw new Error(`${name}: directory and path both name the directory: give one`)
  for (const [key, value] of Object.entries({ github, commit: sha, directory: directory || undefined })) {
    if (value !== undefined && !isValidRepoField(key, value)) throw new Error(`${name}: invalid ${key}: ${JSON.stringify(value)}`)
  }
  if (path && !isValidRepoField('directory', entryPattern(name, path) ? path.replace('*', '_') : path)) throw new Error(`${name}: invalid path: ${JSON.stringify(path)}`)
}

const SYMLINK = '120000'

// Null where one is no plain directory in git (a symlink, or under one); the root's failure is GitHub's.
async function listingsOf(list, dirs) {
  try {
    return await Promise.all(dirs.map(list))
  } catch {
    await list(undefined)
    return null
  }
}

async function splitPath(list, path, where) {
  const pattern = entryPattern(where, path)
  const matches = pattern?.matches ?? ((file) => file === posix.basename(path))
  const above = ancestorsOf(path)
  const listings = await listingsOf(list, above)
  const names = (listings?.[0] ?? []).filter((entry) => entry.type === 'blob' && entry.mode !== SYMLINK && matches(entry.path)).map((entry) => entry.path).toSorted()
  if (names.length === 0 && pattern) throw new Error(`${where}: ${JSON.stringify(path)} matches no file`)
  if (names.length === 0) return { directory: path }
  const files = names.every((file) => file.endsWith('.sol')) ? ['foundry.toml', 'soldeer.toml'] : ['package.json']
  const at = listings.findIndex((listing) => listing.some((entry) => files.includes(entry.path) && entry.type === 'blob'))
  const directory = at === -1 ? undefined : above[at]
  const paths = names.map((file) => posix.join(posix.dirname(path), file))
  return { directory, entries: directory === undefined ? paths : paths.map((file) => posix.relative(directory, file)) }
}

async function listedPackageManager(list, { directory, where }) {
  const listings = await listingsOf(list, directory ? [directory, ...ancestorsOf(directory)] : [undefined])
  if (listings === null) return { listed: undefined, configured: false }
  const configured = listsFile(listings[0], CONFIG_FILE)
  const listed = lockfilesListed(listings)
  if (listed.length === 0 && !configured) throw noLockfile(where, posix.resolve('/', directory || '.'))
  return { listed: listed.length === 1 ? listed[0] : undefined, configured }
}

async function subtreeEntries(client, list, { github, directory, packageManager, where }) {
  const names = async (path) => (await list(path)).map((entry) => entry.path)
  let listing
  try {
    listing = await list(directory)
  } catch {
    return null // no plain directory in git (a symlink, or under one): the whole repo resolves it
  }
  if (!lockfilesListed([listing]).includes(packageManager)) return null
  const above = ancestorsOf(directory)
  const aboveNames = () => Promise.all(above.map(names))
  if (!(await installedAlone(packageManager, listing.map((entry) => entry.path), aboveNames))) return null
  if (packageManagerOf('buildGitHubBundle', packageManager).kind === 'js' && (await aboveNames()).some((dir) => dir.includes(YARNCLEAN))) return null
  // Its tree id, as the listing above it holds it, held to that directory's own.
  const tree = (await list(above[0])).find((entry) => entry.path === posix.basename(directory) && entry.type === 'tree')?.sha
  const files = tree === undefined ? null : await treeFiles(client, { github, tree, directory, where })
  return files === null || refersAbove(files, lockfileOf(packageManager)) ? null : files
}

async function repoTree(name, { github, sha, tag, directory, path, client, packageManager }, options) {
  checkAhead(name, packageManager, options)
  checkRepo(name, { github, sha, tag, directory, path })
  client ??= createClient({ token: null })
  sha ??= tag === undefined ? (await client.getRepoHead({ repo: github })).oid : (await client.getRepoTag({ repo: github, tag })).oid
  const where = `${name}: ${github}@${sha}`
  const list = memoized((dir) => client.listRepoDir({ repo: github, sha, directory: dir }))
  if (path) {
    const split = await splitPath(list, path, where)
    directory = split.directory
    if (split.entries !== undefined) {
      options = { ...options, entries: [...split.entries, ...(options.entries ?? [])] }
      checkAhead(name, packageManager, options)
    }
  }
  const told = packageManager === undefined ? await listedPackageManager(list, { directory, where }) : { listed: packageManager }
  let found = told.listed
  // Unchecked where stasis.config.json may name the lockfiles in place of the one listed.
  const checked = packageManager ?? (told.configured ? undefined : found)
  if (checked !== packageManager) checkAhead(name, checked, options)
  const open = (files, at) => {
    const vfs = vfsFromEntries(files)
    return { vfs, host: vfsHost(vfs), cwd: posix.resolve('/', at) }
  }
  let subtree = directory && found !== undefined ? await subtreeEntries(client, list, { github, directory, packageManager: found, where }) : null
  let opened = open(subtree ?? await repoFiles(client, { github, sha, where }), subtree ? '.' : directory ?? '.')
  // Lockfiles it names may climb out of the directory: the whole repo, which holds the same config there.
  const lockfiles = configuredLockfiles(where, opened.cwd, opened.host)
  if (lockfiles !== undefined && subtree !== null) {
    subtree = null
    opened = open(await repoFiles(client, { github, sha, where }), directory)
  }
  options = { ...options, entries: expandEntries(where, opened.host, opened.cwd, options.entries) }
  if (lockfiles === undefined && packageManager === undefined) {
    found = detectPackageManager(where, opened.host, opened.cwd, { os: options.os })
    if (found !== checked) checkAhead(name, found, options)
  }
  // With lockfiles, none detected: a package manager given is the build's to refuse.
  const packageManagers = lockfiles === undefined || packageManager !== undefined ? [found] : lockfilesManagers(where, lockfiles)
  return { ...opened, client, subtree, sha, where, packageManager: lockfiles === undefined ? found : packageManager, packageManagers, directory, entries: options.entries }
}

// Nothing is read from disk: the tree comes from GitHub or setCacheDir's cache, held to its git tree id.
export async function buildGitHubBundle({ github, sha, tag, directory, path, client, packageManager, ...options } = {}) {
  checkTarget('buildGitHubBundle', options)
  checkCache('buildGitHubBundle', options.cache)
  const tree = await debugTimed('Fetched the repo', () => repoTree('buildGitHubBundle', { github, sha, tag, directory, path, client, packageManager }, options))
  let { entries } = tree
  if (entries === undefined) {
    const suggested = defaultEntries('buildGitHubBundle', tree.host, tree.cwd, tree.packageManagers, options)
    entries = suggested.entries
    if (entries.length === 0) throw new Error(`${tree.where}: no entries given, and ${tree.directory || 'the repo root'} ${suggested.none}`)
  }
  const repo = { github, commit: tree.sha }
  const built = await buildVfsBundle({ ...options, entries, packageManager: tree.packageManager, vfs: tree.vfs, cwd: tree.cwd, innermostRoot: true, repo, client: tree.client })
  // The Vfs is the repo's tree, or the subtree at `directory`: a layout known, so its root is `''`.
  const at = posix.join(tree.subtree ? tree.directory : '.', posix.relative('/', built.root)).replace(/^\.$/u, '')
  built.bundle.repo = { ...repo, ...(isValidRepoField('directory', at) && { directory: at }) }
  // Onto buildVfsBundle's own, not a copy, which would read its lockfile, built only when read.
  built.directory = tree.directory
  return built
}

export async function repoPrismaClients({ github, sha, directory, client }) {
  const tree = await repoTree('repoPrismaClients', { github, sha, directory: directory || undefined, client }, {})
  const outputs = await prismaClientsOf({ vfs: tree.vfs, cwd: tree.cwd, packageManager: tree.packageManager, client })
  const from = (path) => posix.relative(tree.cwd, path)
  return outputs.map((output) => ({ ...output, dir: from(output.dir), schema: from(output.schema) })).filter(({ dir }) => !posixPathEscapes(dir))
}

export async function suggestedRepoEntries(repo, resolution) {
  const tree = await repoTree('suggestedEntries', repo, resolution)
  return tree.entries ?? defaultEntries('suggestedEntries', tree.host, tree.cwd, tree.packageManagers, resolution).entries
}
