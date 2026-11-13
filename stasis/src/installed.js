import { hash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { parseGithubRepository, readJson, readText } from '@exodus/stasis-core/bundle-util'
import { diskHost } from '@exodus/stasis-core/host'
import { hexIntegrity, isNpmDependency, isPlainObject, memoized, relativeEscapes, tarballIntegrityOf, toPosix, upsert, withoutBom } from '@exodus/stasis-core/util'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYaml } from '@preventive/lockfile/yaml.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'

// What the package manager that laid out a node_modules recorded there; one missing or unreadable names nothing.

function githubCommit(repo, commit) {
  const github = parseGithubRepository(repo)
  return github !== null && isValidRepoField('commit', commit) ? { github, commit } : undefined
}

const CODELOAD = /^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\/([^/]+)$/u
const githubTarball = (url) => {
  const [, github, commit] = CODELOAD.exec(url) ?? []
  return isValidRepoField('github', github) ? githubCommit(github, commit) : undefined
}

export const resolutionCommit = (resolution) => {
  if (resolution?.type === 'git') return githubCommit(resolution.repo, resolution.commit)
  return resolution?.type === 'tarball' ? githubTarball(resolution.tarball ?? '') : undefined
}

// As pnpm hashes a patch: a sha256 in hex of its text with its CRLFs as LFs, or as it is.
export const patchHashes = (text) => new Set([text.replaceAll('\r\n', '\n'), text].map((one) => hash('sha256', one)))
export const isPatchOf = (text, patchHash) => patchHashes(text).has(patchHash)

export const patchIntegrity = (patchHash) => (/^[\da-f]{64}$/u.test(patchHash ?? '') ? hexIntegrity('sha256', patchHash) : undefined)

const repoAt = (commit, path = '') => {
  const directory = path.replace(/^\/+|\/+$/gu, '')
  return commit && { github: commit.github, ...(isValidRepoField('directory', directory) && { directory }), commit: commit.commit }
}

const NONE = () => undefined

// A git dependency's `resolved` is the URL npm clones, `#` and the commit.
const npmCommit = (resolved) => {
  if (typeof resolved !== 'string') return undefined
  if (!/^git(?:\+[\w.-]+)?:/u.test(resolved)) return githubTarball(resolved)
  const at = resolved.lastIndexOf('#')
  return at === -1 ? undefined : githubCommit(resolved.slice(0, at), resolved.slice(at + 1))
}

const unreadable = (file, cause) => new Error(`${file}: ${cause?.message ?? 'not a lockfile'}`, { cause })

function parseLock(file, host, strict, parse) {
  const text = readText(host, file)
  if (text === null && strict && host.stat(file) !== null) throw new Error(`${file}: can't be read`)
  if (text === null) return undefined
  try {
    return parse(withoutBom(text))
  } catch (cause) {
    if (strict) throw unreadable(file, cause)
    return undefined
  }
}

export const nameAt = (location) => location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)

// By name and version, or `name@` (a directory's): of two that differ, either may be the one installed, so its version
// alone, `ambiguous`. Of `location`'s package by its own `name` (an alias's), else the name it is installed as.
function byId(entries) {
  const records = new Map()
  for (const [id, record] of entries) {
    const known = records.get(id)
    records.set(id, known === undefined || JSON.stringify(known) === JSON.stringify(record) ? record : { version: record.version, ambiguous: true })
  }
  const find = (name, version) => records.get(`${name}@${version}`) ?? records.get(`${name}@`)
  return (location, version, name) => (name === undefined ? undefined : find(name, version)) ?? find(nameAt(location), version)
}

function npmLocks(file, host, strict) {
  const parsed = parseLock(file, host, strict, (text) => ({ packages: JSON.parse(text).packages }))
  if (parsed === undefined) return undefined
  const { packages } = parsed
  if (!isPlainObject(packages)) {
    if (strict) throw unreadable(file)
    return undefined
  }
  return (location) => {
    const entry = Object.hasOwn(packages, location) ? packages[location] : undefined
    return isPlainObject(entry) ? { version: entry.version, repo: repoAt(npmCommit(entry.resolved)), integrity: entry.integrity } : undefined
  }
}

const resolutionOf = (resolution) => (resolution?.type === 'git' ? `${resolution.repo}#${resolution.commit}` : resolution?.sha1 === undefined ? resolution?.tarball : `${resolution.tarball}#${resolution.sha1}`)

const yarnEntries = (file, host, strict) => parseLock(file, host, strict, (text) => {
  const entries = new Set(Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages))
  return [...entries].map(({ patterns, name, version, resolution }) => ({
    id: `${name}@${version}`,
    patterns,
    record: { version, resolved: resolutionOf(resolution), repo: repoAt(resolutionCommit(resolution)), integrity: resolution?.integrity },
  }))
})

// As pnpm 10 to 12's depPathToFilename names `key`'s store directory, and the `_<hash>` one cut short ends with.
const storeNames = (key) => {
  let name = key.replace(/[\\/:*?"<>|#]/gu, '+')
  if (name.includes('(')) name = name.replace(/\)$/u, '').replace(/\)\(|\(|\)/gu, '_')
  return [name, `_${hash('sha256', name).slice(0, 32)}`]
}
export const STORE_HASH = /_[\da-f]{32}$/u

// Of the lockfile `file` and the `patchers` (`[selector, { hash, path }]`) it locks: the file each hash's patch is in.
function patchLocator(file, patchers, host) {
  // node_modules/.pnpm/lock.yaml copies the pnpm-lock.yaml beside node_modules, its paths from there.
  const base = basename(file) === 'lock.yaml' ? resolve(file, '../../..') : dirname(file)
  const settings = join(base, 'pnpm-workspace.yaml')
  const named = memoized(() => {
    const patches = parseLock(settings, host, true, parseYaml)?.patchedDependencies
    return isPlainObject(patches) ? patches : {}
  })
  // Every file named for the hash held to it; of two of one text, the first named, as deptree records it.
  return memoized((patchHash) => {
    const [first] = patchers.filter(([, patch]) => patch.hash === patchHash).map(([selector, patch]) => {
      const refused = (why) => new Error(`${file} patches ${selector} with ${patchHash}: ${why}`)
      // pnpm 11's lockfile names a patch by its hash alone, its file in pnpm-workspace.yaml.
      const path = patch.path ?? named()[selector]
      if (typeof path !== 'string') throw refused(`neither it nor ${settings} names the patch's file`)
      const at = resolve(base, path)
      const text = readText(host, at)
      if (text === null) throw refused(`${at} can't be read`)
      if (!isPatchOf(text, patchHash)) throw refused(`${at} is a patch of another hash`)
      return at
    })
    return first
  })
}

function pnpmLocks(file, host, strict) {
  const parsed = parseLock(file, host, strict, (text) => ({ lockfile: parsePnpmLockfile(text).lockfile }))
  if (parsed === undefined) return undefined
  const { lockfile } = parsed
  // Of its patches alone: the cache keeps a run's locators, which must not hold the lockfile.
  const patchers = Object.entries(lockfile?.patchedDependencies ?? {})
  const patchAt = patchers.length === 0 ? undefined : patchLocator(file, patchers, host)
  const stored = new Map()
  const keyed = new Map()
  const ids = []
  for (const [key, { name, version, resolution, patchHash }] of Object.entries(lockfile?.packages ?? {})) {
    const record = { version, repo: repoAt(resolutionCommit(resolution), resolution?.path), integrity: resolution?.integrity, patchHash, ...(patchHash !== undefined && { patchAt }) }
    for (const store of storeNames(key)) stored.set(store, record)
    keyed.set(key, record)
    ids.push([`${name}@${version ?? ''}`, record])
  }
  // By the name it is installed as at a top-level location (an alias's or an override's too); none where two differ.
  const top = new Map()
  for (const importer of Object.values(lockfile?.importers ?? {})) {
    for (const [as, key] of [importer.dependencies, importer.devDependencies, importer.optionalDependencies].flatMap((deps) => Object.entries(deps ?? {}))) {
      const record = keyed.get(key)
      if (record) top.set(as, top.has(as) && top.get(as) !== record ? undefined : record)
    }
  }
  const named = byId(ids)
  return {
    stored: (name) => stored.get(name) ?? stored.get(STORE_HASH.exec(name)?.[0]),
    named: (location, ...of) => (location === `node_modules/${nameAt(location)}` ? top.get(nameAt(location)) : undefined) ?? named(location, ...of),
  }
}

const MANAGERS = [
  {
    marker: '.package-lock.json',
    lockfiles: ['npm-shrinkwrap.json', 'package-lock.json'],
    installed: (dir, host) => {
      const locks = npmLocks(join(dir, 'node_modules', '.package-lock.json'), host)
      return locks && ((location, version) => {
        const record = locks(location)
        return record?.version === version ? record : undefined
      })
    },
    locks: (file, host) => npmLocks(file, host, true),
    none: () => 'it locks none there',
  },
  {
    marker: '.yarn-integrity',
    lockfiles: ['yarn.lock'],
    installed: (dir, host) => {
      const integrity = readJson(join(dir, 'node_modules', '.yarn-integrity'), host)?.lockfileEntries
      const entries = isPlainObject(integrity) && yarnEntries(join(dir, 'yarn.lock'), host)
      if (!entries) return undefined
      // What .yarn-integrity has of an entry installed otherwise: a changed yarn.lock often moves a git dependency's commit.
      const installedAs = ({ patterns, record }) => patterns.map((pattern) => (Object.hasOwn(integrity, pattern) ? integrity[pattern] : 'none')).find((resolved) => resolved !== record.resolved)
      return byId(entries.map((entry) => {
        const resolved = installedAs(entry)
        return [entry.id, resolved === undefined ? entry.record : { version: entry.record.version, resolved }]
      }))
    },
    locks: (file, host) => byId(yarnEntries(file, host, true).map(({ id, record }) => [id, record])),
    none: (version) => `${version}; it locks none`,
  },
  {
    marker: '.modules.yaml',
    lockfiles: ['pnpm-lock.yaml'],
    installed: (dir, host) => pnpmLocks(join(dir, 'node_modules', '.pnpm', 'lock.yaml'), host)?.named,
    locks: (file, host) => pnpmLocks(file, host, true).named,
    none: (version) => `${version}; it locks none`,
  },
]

// Null where there is neither record nor lockfile. Of several lockfiles, the one whose package manager alone left its
// record, else refused; of several records, none is read, as which was last is not known.
function layoutOf(dir, host) {
  const marked = MANAGERS.filter(({ marker }) => host.stat(join(dir, 'node_modules', marker)) !== null)
  const locking = MANAGERS.flatMap((manager) => manager.lockfiles.map((name) => join(dir, name)).filter((file) => host.stat(file) !== null).slice(0, 1).map((file) => [manager, file]))
  if (marked.length === 0 && locking.length === 0) return null
  const held = locking.length > 1 ? locking.filter(([manager]) => marked.length === 1 && marked[0] === manager) : locking
  if (locking.length > 1 && held.length === 0) throw new Error(`${dir}: ${locking.map(([, file]) => basename(file)).join(' and ')} are both there, and which installed its node_modules isn't known`)
  const [manager = marked.length === 1 ? marked[0] : undefined, lockfile] = held[0] ?? []
  const installed = (marked.length === 1 && marked[0] === manager && manager.installed(dir, host)) || NONE
  return { installed, lockfile, locks: lockfile && manager.locks(lockfile, host), none: manager?.none }
}

// pnpm's, where it isolates: `store`'s lock.yaml held to the pnpm-lock.yaml of the directory the store is in.
function storeOf(store, host) {
  const lockfile = join(dirname(dirname(store)), 'pnpm-lock.yaml')
  return { installed: pnpmLocks(join(store, 'lock.yaml'), host)?.stored ?? NONE, lockfile, locks: pnpmLocks(lockfile, host, true)?.stored, none: () => 'it locks none there' }
}

const commitLabel = (repo) => (repo ? `${repo.github}${repo.directory ? `/${repo.directory}` : ''}@${repo.commit}` : 'none')

function lockDiffers(version, installed, locked, none) {
  if (locked === undefined) return none(version)
  if (locked.version !== undefined && locked.version !== version) return `${version}; it locks ${locked.version}`
  if (installed === undefined) return undefined
  if (installed.resolved !== undefined && installed.resolved !== locked.resolved) return `installed from ${installed.resolved}; it locks ${locked.resolved ?? 'none'}`
  if (commitLabel(installed.repo) !== commitLabel(locked.repo)) return `at ${commitLabel(installed.repo)}; it locks ${commitLabel(locked.repo)}`
  if (tarballIntegrityOf(installed.integrity) !== tarballIntegrityOf(locked.integrity)) return `installed with ${installed.integrity ?? 'no integrity'}; it locks ${locked.integrity ?? 'none'}`
  if (installed.patchHash !== locked.patchHash) return `installed with the patch ${installed.patchHash ?? 'none'}; it locks ${locked.patchHash ?? 'none'}`
  return undefined
}

const PNPM_PACKAGE = /^(.*\/node_modules\/\.pnpm)\/([^/]+)\/node_modules\/(?:@[^/]+\/)?[^/]+$/u

// An npm tarball's integrity is its sha512 alone; only an npm dependency has a patch.
export function installedMetadata(dir, ecosystem, { repo, integrity, patchHash } = {}) {
  const npm = isNpmDependency(dir, ecosystem)
  const tarball = npm ? tarballIntegrityOf(integrity) : integrity
  const patch = npm ? patchIntegrity(patchHash) : undefined
  return { ...(repo && { repo }), ...(tarball && { integrity: tarball }), ...(patch && { patch: { integrity: patch } }) }
}

// With `locate`, a patch's record carries its file, from `root`: found and held to its hash, else refused.
export function installedRecords(modules, root, host = diskHost, { stores = new Map(), layouts = new Map(), locate = false } = {}) {
  const accounts = new Map()
  let top // the bundle root's real path, as each package's is compared with it
  const rootReal = () => (top ??= resolve(host.realpath(resolve(root))))
  const layoutAt = (dir) => upsert(layouts, dir, () => layoutOf(dir, host))
  for (const [dir, info] of modules) {
    // An untagged bucket under node_modules is npm's too (an artifact from before the tag).
    if (!isNpmDependency(dir, info.ecosystem)) continue
    let real
    try {
      real = toPosix(host.realpath(resolve(root, dir)))
    } catch {
      continue
    }
    let layout
    let at
    const pnpm = PNPM_PACKAGE.exec(real)
    if (pnpm !== null) {
      const [, store, name] = pnpm
      ;[layout, at] = [upsert(stores, store, () => storeOf(store, host)), [name]]
    } else {
      try {
        rootReal()
      } catch {
        return accounts
      }
      const rel = relative(top, real)
      const parts = toPosix(rel).split('/')
      const segment = parts.indexOf('node_modules')
      if (relativeEscapes(rel) || segment === -1) continue
      let from = resolve(top, ...parts.slice(0, segment))
      while (layoutAt(from) === null && from !== top) from = dirname(from)
      ;[layout, at] = [layoutAt(from) ?? { installed: NONE }, [toPosix(relative(from, real)), info.version, info.name]]
    }
    const { installed, lockfile, locks, none } = layout
    const record = installed(...at)
    const locked = locks?.(...at)
    const differs = locks && lockDiffers(info.version, record, locked, none)
    if (differs) throw new Error(`${lockfile} doesn't lock ${dir} as installed (${differs}): install from it again`)
    const told = record ?? locked
    if (told === undefined || told.ambiguous) continue
    const metadata = installedMetadata(dir, info.ecosystem, told)
    // A record of the lockfile alone is held to, never recorded: its patch is not looked for.
    if (locate && record !== undefined && metadata.patch) metadata.patch.file = toPosix(relative(rootReal(), told.patchAt(told.patchHash)))
    accounts.set(dir, { ...metadata, ...(record === undefined && { locked: true }) })
  }
  return accounts
}

export function pinInstalled(bundle, root, host = diskHost) {
  const accounts = installedRecords(bundle.modules, root, host, { locate: true })
  for (const [dir, { locked, ...metadata }] of accounts) if (!locked) bundle.modules.set(dir, { ...bundle.modules.get(dir), ...metadata })
  return accounts
}
