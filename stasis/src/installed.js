import { hash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { parseGithubRepository, readJson, readText } from '@exodus/stasis-core/bundle-util'
import { diskHost } from '@exodus/stasis-core/host'
import { isPlainObject, relativeEscapes, toPosix } from '@exodus/stasis-core/util'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'

// What the package manager that laid out a node_modules on disk recorded there of each package it
// installed: npm in its hidden lockfile, pnpm in its copy of the lockfile, yarn 1 in yarn.lock as its
// .yarn-integrity has it installed. A record, `{ version, repo }`, names a git dependency's GitHub
// repository at its commit. One missing or unreadable names nothing, and fails nothing; each package
// is held to the lockfile beside it, where there is one, whatever its record names.

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

// The name a package is installed as at `location`, the last of it.
const nameAt = (location) => location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)

// What a lockfile locks of each package, `{ version, repo }`, by its name and version (an id): of two
// entries of one id that differ, either may be the one installed, so its version alone.
function byId(entries) {
  const records = new Map()
  for (const [id, record] of entries) {
    const known = records.get(id)
    records.set(id, known === undefined || JSON.stringify(known) === JSON.stringify(record) ? record : { version: record.version })
  }
  return (location, version) => records.get(`${nameAt(location)}@${version}`)
}

// npm's lockfile `file`, what it locks at each location from its directory: undefined where there is
// none, or, unless `strict`, where it can't be read.
function npmLocks(file, host, strict) {
  const text = readText(host, file)
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
    return isPlainObject(entry) ? { version: entry.version, repo: repoAt(npmCommit(entry.resolved)) } : undefined
  }
}

// A yarn.lock entry's resolution, as its `resolved` spells it.
const resolutionOf = (resolution) => (resolution?.type === 'git' ? `${resolution.repo}#${resolution.commit}` : resolution?.sha1 === undefined ? resolution?.tarball : `${resolution.tarball}#${resolution.sha1}`)

// yarn.lock `file`'s entries by id, with their patterns: undefined where there is none, or, unless
// `strict`, where it can't be read.
function yarnEntries(file, host, strict) {
  const text = readText(host, file)
  if (text === null) return undefined
  try {
    return [...new Set(Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages))].map(({ patterns, name, version, resolution }) => ({
      id: `${name}@${version}`,
      patterns,
      record: { version, resolved: resolutionOf(resolution), repo: repoAt(resolutionCommit(resolution)) },
    }))
  } catch (cause) {
    if (strict) throw unreadable(file, cause) // whatever the reader refuses
    return undefined
  }
}

// The names pnpm 10 to 12 may give snapshot `key`'s directory in node_modules/.pnpm, as its
// depPathToFilename (@pnpm/dependency-path) spells them: each character a path can't hold, and `#`,
// made `+`, and a peer's parentheses `_`; where that is too long or has a capital, cut short before
// `_` and 32 hex of a SHA-256 of it, of which the hash alone is kept, as where it is cut depends on
// the install's virtualStoreDirMaxLength.
const storeNames = (key) => {
  let name = key.replace(/[\\/:*?"<>|#]/gu, '+')
  if (name.includes('(')) name = name.replace(/\)$/u, '').replace(/\)\(|\(|\)/gu, '_')
  return [name, `_${hash('sha256', name).slice(0, 32)}`]
}
// The hash pnpm ends a store directory's name with where it cuts a long one short.
export const STORE_HASH = /_[\da-f]{32}$/u

// pnpm's lockfile `file`, what it locks of each package by the directory under node_modules/.pnpm it
// installs it in (`stored`) and by id (`named`, as a node_modules it lays out hoisted holds it):
// undefined where there is none, or, unless `strict`, where it can't be read. A git dependency's
// resolution is the repository and commit, or GitHub's tarball of the commit, and the package's
// `path` in it (`#path:`) where it is not at the root.
function pnpmLocks(file, host, strict) {
  const text = readText(host, file)
  if (text === null) return undefined
  let packages
  try {
    packages = parsePnpmLockfile(text).lockfile?.packages
  } catch (cause) {
    if (strict) throw unreadable(file, cause)
    return undefined
  }
  const stored = new Map()
  const ids = []
  for (const [key, { name, version, resolution }] of Object.entries(packages ?? {})) {
    const record = { version, repo: repoAt(resolutionCommit(resolution), resolution?.path) }
    for (const store of storeNames(key)) stored.set(store, record)
    ids.push([`${name}@${version}`, record])
  }
  return { stored: (name) => stored.get(name) ?? stored.get(STORE_HASH.exec(name)?.[0]), named: byId(ids) }
}

// Each package manager that lays out a node_modules: the record it leaves there of what it installed
// (`marker`), its lockfiles, and of `dir`, a directory it laid out a node_modules in, that record of
// each package by its location from `dir` and its version (`installed`), what a lockfile of it locks
// there (`locks`), and what tells it locks none there. npm's record is the hidden lockfile npm 7 on
// writes into the node_modules it lays out, held to npm-shrinkwrap.json, else package-lock.json;
// yarn 1's, yarn.lock as the .yarn-integrity it writes there has it installed: of each entry, the
// resolution for each of its patterns, as yarn.lock's `resolved` spells it (a yarn.lock changed since
// often moves a git dependency to another commit of one version); pnpm's, where it hoists, its copy
// of the lockfile it installed from in node_modules/.pnpm, held to pnpm-lock.yaml.
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
      // Of an entry .yarn-integrity has installed otherwise, what it has.
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

// What a package manager recorded of the node_modules it laid out in `dir`, and the lockfile beside
// it it is held to: null where there is neither. Where several lockfiles are there, the one whose
// package manager alone left its record; where several left theirs, neither's, as which was last is
// not known.
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

// Each npm dependency of `bundle`, its buckets' paths from `root`, that is a git dependency of a GitHub
// repository, recorded as its package manager's record has it installed: that repository, over the
// one its package.json names (a fork's, where that names the one forked), at its root (`''`) or the
// subdirectory pnpm records, at that commit; each one held to the lockfile beside that record, where
// there is one, whatever the record names of it (holdToLockfile). A dependency is found by its real
// path, through the link pnpm installs it by: in a node_modules/.pnpm, by its directory there; else
// by its location from the nearest directory a package manager laid out a node_modules in or locks
// one of (layoutOf), from the one its outermost node_modules below the bundle root is in up to that
// root, whatever a directory above the root is named: a record outside the root is another project's.
export function pinInstalled(bundle, root, host = diskHost) {
  const stores = new Map()
  const layouts = new Map()
  let top // the bundle root's real path, as each package's is compared with it
  const layoutAt = (dir) => {
    if (!layouts.has(dir)) layouts.set(dir, layoutOf(dir, host))
    return layouts.get(dir)
  }
  for (const [dir, info] of bundle.modules) {
    if (info.ecosystem !== 'npm') continue
    let real
    try {
      real = toPosix(host.realpath(resolve(root, dir)))
    } catch {
      continue
    }
    let record
    const pnpm = PNPM_PACKAGE.exec(real)
    if (pnpm !== null) {
      const [, store, name] = pnpm
      if (!stores.has(store)) stores.set(store, storeOf(store, host))
      const { installed, lockfile, locks, none } = stores.get(store)
      record = installed(name)
      if (locks) holdToLockfile(lockfile, dir, info.version, record, locks(name), none)
    } else {
      try {
        top ??= resolve(host.realpath(resolve(root)))
      } catch {
        return
      }
      const rel = relative(top, real)
      const parts = toPosix(rel).split('/')
      const at = parts.indexOf('node_modules')
      if (relativeEscapes(rel) || at === -1) continue
      let from = resolve(top, ...parts.slice(0, at))
      while (layoutAt(from) === null && from !== top) from = dirname(from)
      const { installed, lockfile, locks, none } = layoutAt(from) ?? { installed: NONE }
      const location = toPosix(relative(from, real))
      record = installed(location, info.version)
      if (locks) holdToLockfile(lockfile, dir, info.version, record, locks(location, info.version), none)
    }
    if (record?.repo) bundle.modules.set(dir, { ...info, repo: record.repo })
  }
}
