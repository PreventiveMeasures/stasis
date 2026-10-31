import { posix } from 'node:path'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { posixPathEscapes } from '@exodus/stasis-core/util'
import { decompress } from '@preventive/archive/compression.js'
import { ArchiveError, unpack } from '@preventive/archive/tar.js'
import { createClient } from '@preventive/upstream/github.js'
import { vfsFromEntries } from '@preventive/vfs'
import { buildVfsBundle, debugTimed } from '../cmd/bundle.js'
import { KINDS, checkAhead, defaultEntries } from './entries.js'
import { checkCache, checkTarget, detectPackageManager, installedAlone, lockfileOf, lockfilesListed, noLockfile, packageManagerOf, vfsHost } from './tree.js'
import { YARNCLEAN } from './yarnclean.js'

// As upstream's tree verification bounds a tarball's unpacked size.
const MAX_TAR_BYTES = 2 ** 30
// What a git tree holds (upstream's verification refuses anything else from GitHub).
const TREE_TYPES = new Set(['file', 'directory', 'symlink'])
// Lockfile references to a path above the lockfile's directory (conservatively: any importer's):
// pnpm's and yarn's specs, and package-lock.json's package keys and `resolved` paths, `..` itself
// (`link:..`, npm's `".."`) or under it.
const LOCKFILE_ESCAPE = /(?:link:|file:|directory: |["'])\.\.(?![^/"'\s])/u
const TSCONFIG = /(?:^|\/)[jt]sconfig[^/]*\.json$/u

// Whether `target`, a path relative to the file `from`, resolves outside the tree.
const resolvesOutside = (from, target) => target.startsWith('/') || posixPathEscapes(posix.join(posix.dirname(from), target))

// The mode a checkout gives an entry under the usual umask 022. Git keeps only a file's executable
// bit (upstream verifies that much), and GitHub's tarballs are written with git archive's tar.umask
// 0002, which makes them 664 and 775 besides.
const checkoutMode = ({ type, mode }) => (type === 'symlink' ? mode : type === 'directory' || mode & 0o100 ? 0o755 : 0o644)

// A GitHub tarball's entries, its one top directory dropped, with the modes a checkout has.
async function treeEntries(tarball, where) {
  const entries = []
  for (const entry of unpack(await decompress(tarball, 'gzip', { limit: MAX_TAR_BYTES }))) {
    const name = entry.name.slice(entry.name.indexOf('/') + 1)
    if (!TREE_TYPES.has(entry.type)) throw new Error(`${where}: unexpected ${entry.type} ${JSON.stringify(name)} in the tarball`)
    if (entry.name.includes('/')) entries.push({ ...entry, name, mode: checkoutMode(entry) })
  }
  return entries
}

// The first symlink pointing outside the tree, which would otherwise resolve within it.
const escapingLink = (entries) => entries.find((entry) => entry.type === 'symlink' && resolvesOutside(entry.name, entry.linkname))

// Whether a subtree's files refer to a path above it: a lockfile link or a [jt]sconfig path.
function refersAbove(entries, lockfile) {
  const text = (entry) => new TextDecoder().decode(entry.data)
  return entries.some((entry) => entry.type === 'file' && (entry.name === lockfile
    ? LOCKFILE_ESCAPE.test(text(entry))
    : TSCONFIG.test(entry.name) && [...text(entry).matchAll(/"(\.\.?\/[^"]*)"/gu)].some(([, path]) => resolvesOutside(entry.name, path))))
}

// The directories above `directory`, the repo's root (undefined) last.
function ancestorsOf(directory) {
  const out = []
  for (let dir = posix.dirname(directory); dir !== '.'; dir = posix.dirname(dir)) out.push(dir)
  return [...out, undefined]
}

// The files of the subtree `tree` at `directory`, or null where one is a symlink out of it. Upstream
// refuses a tarball whose symlinks climb above its root, unless told how far they may: as far as the
// repo's root, as many levels as `directory` is deep, less one (its tarball's top directory).
async function treeFiles(client, { github, tree, directory, where }) {
  let files
  try {
    files = await treeEntries(await client.getRepoTreeTarball({ repo: github, tree, symlinksAbove: directory.split('/').length - 1 }), where)
  } catch (error) {
    if (error instanceof ArchiveError) return null // e.g. a symlink out of the subtree
    throw error
  }
  return escapingLink(files) ? null : files
}

// The whole repo's files at `sha`.
async function repoFiles(client, { github, sha, where }) {
  const files = await treeEntries(await client.getRepoTarball({ repo: github, sha }), where)
  const link = escapingLink(files)
  if (link) throw new Error(`${where}: symlink ${JSON.stringify(link.name)} points outside the repo`)
  return files
}

// Checked as the Bundle checks them, before anything is fetched; a tag's name is upstream's to check,
// and a `path` is checked as a `directory`, which it may be.
function checkRepo(name, { github, sha, tag, directory, path }) {
  if (github === undefined) throw new Error(`${name}: github is required`)
  if (tag !== undefined && (typeof tag !== 'string' || tag === '')) throw new TypeError(`${name}: tag must be a non-empty string`)
  if (sha !== undefined && tag !== undefined) throw new Error(`${name}: sha and tag both name the commit: give one`)
  if (directory !== undefined && path !== undefined) throw new Error(`${name}: directory and path both name the directory: give one`)
  for (const [key, value] of Object.entries({ github, commit: sha, directory: directory || undefined })) {
    if (value !== undefined && !isValidRepoField(key, value)) throw new Error(`${name}: invalid ${key}: ${JSON.stringify(value)}`)
  }
  if (path && !isValidRepoField('directory', path)) throw new Error(`${name}: invalid path: ${JSON.stringify(path)}`)
}

// The files that make a directory a project's root, for an entry of each kind: a JS project's
// package.json, and the foundry.toml or soldeer.toml Soldeer installs from.
const PROJECT_FILES = { js: ['package.json'], sol: ['foundry.toml', 'soldeer.toml'] }
// A symlink's mode in a git tree.
const SYMLINK = '120000'

// `path` in the repo, by `list`'s listings, as `{ directory, entry }`: a file (no symlink) is an
// entry of the nearest directory at or above it holding one of PROJECT_FILES of its kind, the repo's
// root (undefined) where none does, and a path from there; anything else, or what the listings can't
// tell (a symlink on the way), is the directory, with no entry.
async function splitPath(list, path) {
  const above = ancestorsOf(path)
  let listings
  try {
    listings = await Promise.all(above.map(list))
  } catch {
    // No plain directory in git (a symlink, or under one); the root's failure is GitHub's.
    await list(undefined)
    return { directory: path }
  }
  const name = posix.basename(path)
  if (!listings[0].some((entry) => entry.path === name && entry.type === 'blob' && entry.mode !== SYMLINK)) return { directory: path }
  const files = PROJECT_FILES[path.endsWith('.sol') ? 'sol' : 'js']
  const at = listings.findIndex((listing) => listing.some((entry) => files.includes(entry.path) && entry.type === 'blob'))
  const directory = at === -1 ? undefined : above[at]
  return { directory, entry: directory === undefined ? path : posix.relative(directory, path) }
}

// listRepoDir's listing of a directory of the repo at `sha`, each listed once.
function lister(client, { github, sha }) {
  const listings = new Map()
  return (directory) => {
    if (!listings.has(directory)) listings.set(directory, client.listRepoDir({ repo: github, sha, directory }))
    return listings.get(directory)
  }
}

// Of no package manager given, the one whose lockfile alone `directory` (or the repo's root) and
// the directories above it list, which is then the only one that may install it; refused where
// none does; undefined where more than one does, or the listings can't tell, for the tree to tell.
async function listedPackageManager(list, { directory, where }) {
  let listings
  try {
    listings = await Promise.all((directory ? [directory, ...ancestorsOf(directory)] : [undefined]).map(list))
  } catch {
    // No plain directory in git (a symlink, or under one); the root's failure is GitHub's.
    await list(undefined)
    return undefined
  }
  const listed = lockfilesListed(listings)
  if (listed.length === 0) throw noLockfile(where, posix.resolve('/', directory || '.'))
  return listed.length === 1 ? listed[0] : undefined
}

// The files of `directory` alone, when it holds the lockfile, is installed from itself and stands
// alone, nor does a .yarnclean above it clean the node_modules it installs; else null.
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
  // Installed from a root above it (a workspace's), it is built from there.
  if (!(await installedAlone(packageManager, listing.map((entry) => entry.path), () => Promise.all(above.map(names))))) return null
  if (packageManagerOf('buildGitHubBundle', packageManager).kind === 'js' && (await Promise.all(above.map(names))).some((dir) => dir.includes(YARNCLEAN))) return null
  // Its tree id, as the listing above it holds it, held to that directory's own.
  const tree = (await list(above[0])).find((entry) => entry.path === posix.basename(directory) && entry.type === 'tree')?.sha
  const files = tree === undefined ? null : await treeFiles(client, { github, tree, directory, where })
  return files === null || refersAbove(files, lockfileOf(packageManager)) ? null : files
}

// The repo as buildGitHubBundle downloads it, for `name`: at `sha`, else the commit `tag` names (an
// annotated tag followed to it), else the default branch's head; `directory` alone where it stands
// alone for the package manager installing it, else the whole repo. That package manager is
// `packageManager` if given, else the one the listings tell, before the tree is fetched, else the
// tree; `options` are checked for it once it is known. A `path` is the `directory`, or a file in
// it which is an entry ahead of `options.entries` (splitPath).
// -> { vfs, host, cwd, subtree, sha, where, packageManager, kind, directory, entries }
async function repoTree(name, { github, sha, tag, directory, path, client, packageManager }, options) {
  checkAhead(name, packageManager, options)
  checkRepo(name, { github, sha, tag, directory, path })
  client ??= createClient({ token: null })
  sha ??= tag === undefined ? (await client.getRepoHead({ repo: github })).oid : (await client.getRepoTag({ repo: github, tag })).oid
  const where = `${name}: ${github}@${sha}`
  const list = lister(client, { github, sha })
  if (path) {
    const split = await splitPath(list, path)
    directory = split.directory
    if (split.entry !== undefined) {
      options = { ...options, entries: [split.entry, ...(options.entries ?? [])] }
      checkAhead(name, packageManager, options)
    }
  }
  let found = packageManager
  if (found === undefined) {
    found = await listedPackageManager(list, { directory, where })
    if (found !== undefined) checkAhead(name, found, options)
  }
  const subtree = directory && found !== undefined ? await subtreeEntries(client, list, { github, directory, packageManager: found, where }) : null
  const vfs = vfsFromEntries(subtree ?? await repoFiles(client, { github, sha, where }))
  const host = vfsHost(vfs)
  const cwd = posix.resolve('/', subtree ? '.' : directory ?? '.')
  if (packageManager === undefined) {
    const detected = detectPackageManager(where, host, cwd, { os: options.os })
    if (detected !== found) checkAhead(name, detected, options)
    found = detected
  }
  return { vfs, host, cwd, subtree, sha, where, packageManager: found, kind: KINDS[packageManagerOf(name, found).kind], directory, entries: options.entries }
}

// A GitHub repo at a full commit, or the one `tag` names, the default branch's head without either,
// as buildVfsBundle builds it: `directory` downloaded alone where it stands alone, else the whole
// repo, and without a `packageManager`, the one whose lockfile installs it, where only one's does
// (repoTree). Without `entries`, they are the ones suggestedEntries suggests: those its
// stasis.config.json's `entries` names, where it has `entries`. The bundle's paths are
// relative to `directory`, or for a JS bundle, to the innermost package directory at or above it
// holding every file it bundles (buildJsBundle's innermostRoot), which is the project's root where
// one is outside the others; `repo` names that directory and the commit. Nothing is read from disk:
// the tree's bytes come from GitHub, or from the cache setCacheDir names, held to the git tree id
// either way (@preventive/upstream), and are unpacked into a Vfs that buildVfsBundle reads alone.
// `cache` and `lazy` are buildVfsBundle's, for the npm packages the tree installs: the repo's tree is
// cached where setCacheDir says, whatever it is, and fetched whole.
// `path`, in place of `directory`, is a path in the repo at the commit: a directory is the
// `directory`, and a file an entry ahead of `entries`, of the nearest directory at or above it with
// a package.json (with a foundry.toml or soldeer.toml, for a .sol file), else of the repo's root,
// which is then the `directory` (splitPath).
// -> buildVfsBundle's, and the `directory` bundled
export async function buildGitHubBundle({ github, sha, tag, directory, path, client, packageManager, ...options } = {}) {
  checkTarget('buildGitHubBundle', options)
  checkCache('buildGitHubBundle', options.cache)
  // Its own, for a Soldeer git dependency too.
  client ??= createClient({ token: null })
  const tree = await debugTimed('Fetched the repo', () => repoTree('buildGitHubBundle', { github, sha, tag, directory, path, client, packageManager }, options))
  let { entries } = tree
  if (entries === undefined) {
    // As suggestedEntries suggests them, from the tree at hand.
    const suggested = defaultEntries('buildGitHubBundle', tree.host, tree.cwd, tree.kind, options)
    entries = suggested.entries
    if (entries.length === 0) throw new Error(`${tree.where}: no entries given, and ${tree.directory || 'the repo root'} ${suggested.none}`)
  }
  const repo = { github, commit: tree.sha }
  const built = await buildVfsBundle({ ...options, entries, packageManager: tree.packageManager, vfs: tree.vfs, cwd: tree.cwd, innermostRoot: true, repo, client })
  // The Vfs is the repo's tree, or the subtree at `directory`: a layout known, so its root is `''`.
  const at = posix.join(tree.subtree ? tree.directory : '.', posix.relative('/', built.root)).replace(/^\.$/u, '')
  built.bundle.repo = { ...repo, ...(isValidRepoField('directory', at) ? { directory: at } : {}) }
  return { ...built, directory: tree.directory }
}

// suggestedEntries of a GitHub repo, `{ github, sha, tag, directory | path, client, packageManager }`,
// as buildGitHubBundle downloads it: a `path` to a file, that file.
export async function suggestedRepoEntries(repo, resolution) {
  const tree = await repoTree('suggestedEntries', repo, resolution)
  return tree.entries ?? defaultEntries('suggestedEntries', tree.host, tree.cwd, tree.kind, resolution).entries
}
