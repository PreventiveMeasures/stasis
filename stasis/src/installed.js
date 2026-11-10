import { hash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { parseGithubRepository, readJson, readText } from '@exodus/stasis-core/bundle-util'
import { diskHost } from '@exodus/stasis-core/host'
import { hexIntegrity, isNpmDependency, isPlainObject, relativeEscapes, tarballIntegrityOf, toPosix } from '@exodus/stasis-core/util'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'

// What the package manager that laid out a node_modules recorded there of each package, `{ version,
// repo, integrity, patchHash }`: npm in its hidden lockfile, pnpm in its lockfile copy, yarn 1 in
// yarn.lock as .yarn-integrity has it. One missing or unreadable names nothing, and fails nothing.

// `{ github, commit }` of `repo`, a git URL, at `commit`, where that is a GitHub repository and a full
// commit id; else undefined.
function githubCommit(repo, commit) {
  const github = parseGithubRepository(repo)
  return github !== null && isValidRepoField('commit', commit) ? { github, commit } : undefined
}

// GitHub's tarball of a commit, as yarn 1 and pnpm fetch a GitHub dependency.
const CODELOAD = /^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\/([^/]+)$/u
const githubTarball = (url) => {
  const [, github, commit] = CODELOAD.exec(url) ?? []
  return isValidRepoField('github', github) ? githubCommit(github, commit) : undefined
}

// githubCommit of a git or tarball resolution @preventive/lockfile reads.
export const resolutionCommit = (resolution) => {
  if (resolution?.type === 'git') return githubCommit(resolution.repo, resolution.commit)
  return resolution?.type === 'tarball' ? githubTarball(resolution.tarball ?? '') : undefined
}

// pnpm's patch hash, a sha256 in hex, as an SRI integrity; undefined for another.
export const patchIntegrity = (patchHash) => (/^[\da-f]{64}$/u.test(patchHash ?? '') ? hexIntegrity('sha256', patchHash) : undefined)

// A record's `repo` of a commit: at its repository's root, or `path` in it.
const repoAt = (commit, path = '') => {
  const directory = path.replace(/^\/+|\/+$/gu, '')
  return commit && { github: commit.github, ...(isValidRepoField('directory', directory) && { directory }), commit: commit.commit }
}

// The lookup of a record that finds nothing: one unreadable, or none.
const NONE = () => undefined

// The commit a `resolved` npm's lockfile records names: a git dependency's is the URL npm clones,
// `#` and the commit.
const npmCommit = (resolved) => {
  if (typeof resolved !== 'string') return undefined
  if (!/^git(?:\+[\w.-]+)?:/u.test(resolved)) return githubTarball(resolved)
  const at = resolved.lastIndexOf('#')
  return at === -1 ? undefined : githubCommit(resolved.slice(0, at), resolved.slice(at + 1))
}

// A lockfile of `file` beside an install record, which can't be read.
const unreadable = (file, cause) => new Error(`${file}: ${cause?.message ?? 'not a lockfile'}`, { cause })

// The text of `file`, without the byte order mark npm, pnpm and yarn read past: null where there is
// none, or, unless `strict`, where it can't be read.
function lockText(file, host, strict) {
  const text = readText(host, file)
  if (text === null && strict && host.stat(file) !== null) throw new Error(`${file}: can't be read`)
  return text?.charCodeAt(0) === 0xFE_FF ? text.slice(1) : text
}

// The name a package is installed as at `location`, the last of it.
const nameAt = (location) => location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)

// A lockfile's record of each package by its name and version, or `name@` (a directory's): of two that
// differ, either may be the one installed, so its version alone, `ambiguous`. Of `location`'s package
// by its own `name` (an alias's, `helmet: npm:ms@2.1.3`), else the name it is installed as.
function byId(entries) {
  const records = new Map()
  for (const [id, record] of entries) {
    const known = records.get(id)
    records.set(id, known === undefined || JSON.stringify(known) === JSON.stringify(record) ? record : { version: record.version, ambiguous: true })
  }
  const find = (name, version) => records.get(`${name}@${version}`) ?? records.get(`${name}@`)
  return (location, version, name) => (name === undefined ? undefined : find(name, version)) ?? find(nameAt(location), version)
}

// npm's lockfile `file`, what it locks at each location from its directory: undefined where there is
// none, or, unless `strict`, where it can't be read.
function npmLocks(file, host, strict) {
  const text = lockText(file, host, strict)
  if (text === null) return undefined
  let packages
  try {
    packages = JSON.parse(text).packages
  } catch (cause) {
    if (strict) throw unreadable(file, cause)
  }
  if (!isPlainObject(packages)) {
    if (strict) throw unreadable(file)
    return undefined
  }
  return (location) => {
    const entry = Object.hasOwn(packages, location) ? packages[location] : undefined
    return isPlainObject(entry) ? { version: entry.version, repo: repoAt(npmCommit(entry.resolved)), integrity: entry.integrity } : undefined
  }
}

// A yarn.lock entry's resolution, as its `resolved` spells it.
const resolutionOf = (resolution) => (resolution?.type === 'git' ? `${resolution.repo}#${resolution.commit}` : resolution?.sha1 === undefined ? resolution?.tarball : `${resolution.tarball}#${resolution.sha1}`)

// yarn.lock `file`'s entries by id, with their patterns: undefined where there is none, or, unless
// `strict`, where it can't be read.
function yarnEntries(file, host, strict) {
  const text = lockText(file, host, strict)
  if (text === null) return undefined
  try {
    return [...new Set(Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages))].map(({ patterns, name, version, resolution }) => ({
      id: `${name}@${version}`,
      patterns,
      record: { version, resolved: resolutionOf(resolution), repo: repoAt(resolutionCommit(resolution)), integrity: resolution?.integrity },
    }))
  } catch (cause) {
    if (strict) throw unreadable(file, cause) // whatever the reader refuses
    return undefined
  }
}

// The names pnpm 10 to 12 may give snapshot `key`'s directory in node_modules/.pnpm, as depPathToFilename spells
// them: what a path can't hold, and `#`, made `+`, a peer's parentheses `_`; and, for one cut short (too long or
// capitalized, where virtualStoreDirMaxLength says), the `_` and 32 hex of its SHA-256 it then ends with.
const storeNames = (key) => {
  let name = key.replace(/[\\/:*?"<>|#]/gu, '+')
  if (name.includes('(')) name = name.replace(/\)$/u, '').replace(/\)\(|\(|\)/gu, '_')
  return [name, `_${hash('sha256', name).slice(0, 32)}`]
}
// The hash pnpm ends a store directory's name with where it cuts a long one short.
export const STORE_HASH = /_[\da-f]{32}$/u

// pnpm's lockfile `file`, what it locks of each package by its directory in node_modules/.pnpm (`stored`) and by id
// (`named`, as a hoisted node_modules holds it): undefined where there is none, or, unless `strict`, can't be read.
// A git dependency's repo is its commit (or GitHub's tarball of it), at its `#path:` where it is not at the root.
function pnpmLocks(file, host, strict) {
  const text = lockText(file, host, strict)
  if (text === null) return undefined
  let lockfile
  try {
    ;({ lockfile } = parsePnpmLockfile(text))
  } catch (cause) {
    if (strict) throw unreadable(file, cause)
    return undefined
  }
  const stored = new Map()
  const keyed = new Map()
  const ids = []
  for (const [key, { name, version, resolution, patchHash }] of Object.entries(lockfile?.packages ?? {})) {
    const record = { version, repo: repoAt(resolutionCommit(resolution), resolution?.path), integrity: resolution?.integrity, patchHash }
    for (const store of storeNames(key)) stored.set(store, record)
    keyed.set(key, record)
    ids.push([`${name}@${version ?? ''}`, record])
  }
  // What the importers install at a top-level location, by the name it is installed as: an alias's
  // or an override's (`ms: ms-fork@file:local-ms`) too; none where two install different ones.
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

// Each package manager that lays out a node_modules: its record there (`marker`), its lockfiles, and of `dir`, what
// the record names by location and version (`installed`), what a lockfile locks there (`locks`) and says of none.
// npm's record is its hidden lockfile; yarn 1's, yarn.lock as .yarn-integrity has it; pnpm's (hoisting), lock.yaml.
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
      // Of an entry .yarn-integrity has installed otherwise, what it has (a yarn.lock changed since often moves a git
      // dependency to another commit of one version).
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

// What a package manager recorded of the node_modules it laid out in `dir`, and the lockfile beside it it is held
// to: null where there is neither. Of several lockfiles, the one whose package manager alone left its record, else
// refused; of several records, none is read, as which was last is not known.
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

// pnpm's, where it isolates: lock.yaml in `store`, a node_modules/.pnpm, its copy of the lockfile it
// installed there, held to the pnpm-lock.yaml of the directory the store is in.
function storeOf(store, host) {
  const lockfile = join(dirname(dirname(store)), 'pnpm-lock.yaml')
  return { installed: pnpmLocks(join(store, 'lock.yaml'), host)?.stored ?? NONE, lockfile, locks: pnpmLocks(lockfile, host, true)?.stored, none: () => 'it locks none there' }
}

// A repo's commit, as a message names it.
const commitLabel = (repo) => (repo ? `${repo.github}${repo.directory ? `/${repo.directory}` : ''}@${repo.commit}` : 'none')

// How the package of `version` installed at `dir` differs from what its lockfile locks there
// (`locked`, undefined for none), and what its install record names of it (`installed`, undefined for
// none) from that; undefined where neither does.
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

// The package installed at `dir` as its lockfile locks it (lockDiffers), else what is installed isn't
// what the lockfile installs.
function holdToLockfile(lockfile, dir, ...of) {
  const differs = lockDiffers(...of)
  if (differs) throw new Error(`${lockfile} doesn't lock ${dir} as installed (${differs}): install from it again`)
}

// A pnpm package's real path, <store>/<dir>/node_modules/<name>, its store a node_modules/.pnpm.
const PNPM_PACKAGE = /^(.*\/node_modules\/\.pnpm)\/([^/]+)\/node_modules\/(?:@[^/]+\/)?[^/]+$/u

// The metadata an install record names of bucket `dir`: its repository at a commit, its archive's
// integrity (an npm tarball's sha512 alone), and an npm dependency's patch.
export function installedMetadata(dir, ecosystem, { repo, integrity, patchHash } = {}) {
  const npm = isNpmDependency(dir, ecosystem)
  const tarball = npm ? tarballIntegrityOf(integrity) : integrity
  const patch = npm ? patchIntegrity(patchHash) : undefined
  return { ...(repo && { repo }), ...(tarball && { integrity: tarball }), ...(patch && { patch: { integrity: patch } }) }
}

// The account of how each npm dependency of `modules` (paths from `root`) was installed, by its dir:
// what its install record names (installedMetadata), found by its real path and held to the lockfile
// beside it (holdToLockfile), else, `locked`, what that lockfile locks. `cache` keeps what was read.
export function installedRecords(modules, root, host = diskHost, { stores = new Map(), layouts = new Map() } = {}) {
  const accounts = new Map()
  let top // the bundle root's real path, as each package's is compared with it
  const layoutAt = (dir) => {
    if (!layouts.has(dir)) layouts.set(dir, layoutOf(dir, host))
    return layouts.get(dir)
  }
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
      if (!stores.has(store)) stores.set(store, storeOf(store, host))
      ;[layout, at] = [stores.get(store), [name]]
    } else {
      try {
        top ??= resolve(host.realpath(resolve(root)))
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
    if (locks) holdToLockfile(lockfile, dir, info.version, record, locked, none)
    const told = record ?? locked
    if (told !== undefined && !told.ambiguous) accounts.set(dir, { ...installedMetadata(dir, info.ecosystem, told), ...(record === undefined && { locked: true }) })
  }
  return accounts
}

// `bundle`'s npm dependencies with what their install records name. -> their accounts (installedRecords).
export function pinInstalled(bundle, root, host = diskHost) {
  const accounts = installedRecords(bundle.modules, root, host)
  for (const [dir, { locked, ...metadata }] of accounts) if (!locked) bundle.modules.set(dir, { ...bundle.modules.get(dir), ...metadata })
  return accounts
}
