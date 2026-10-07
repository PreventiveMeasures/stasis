import { hash } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'

import { toBase32 } from '@exodus/bytes/base32.js'
import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { parseGithubRepository, readJson, readText } from '@exodus/stasis-core/bundle-util'
import { diskHost } from '@exodus/stasis-core/host'
import { isPlainObject, toPosix } from '@exodus/stasis-core/util'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'

// The commit each git dependency in a node_modules on disk is installed at, as the package manager
// that laid it out recorded it there: npm in its hidden lockfile, pnpm in its copy of the lockfile,
// yarn 1 in yarn.lock, as its .yarn-integrity has it installed. Nothing on disk names a registry
// package's. A record missing, unreadable, or naming no full commit of a GitHub repository records
// nothing, and fails nothing.

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
const resolutionCommit = (resolution) => {
  if (resolution?.type === 'git') return githubCommit(resolution.repo, resolution.commit)
  return resolution?.type === 'tarball' ? githubTarball(resolution.tarball ?? '') : undefined
}

// The lookup of a record that finds nothing: one unreadable, or none.
const NONE = () => undefined

// npm's, from npm 7: the hidden lockfile it writes into `dir`'s node_modules as it lays it out, by
// each package's location from `dir`, where it records the version installed there. A git
// dependency's `resolved` is the URL npm clones, `#` and the commit.
function npmRecord(dir, host) {
  const packages = readJson(join(dir, 'node_modules', '.package-lock.json'), host)?.packages
  if (!isPlainObject(packages)) return NONE
  return (location, version) => {
    const entry = Object.hasOwn(packages, location) ? packages[location] : undefined
    if (!isPlainObject(entry) || entry.version !== version || typeof entry.resolved !== 'string') return undefined
    const { resolved } = entry
    if (!/^git(?:\+[\w.-]+)?:/u.test(resolved)) return githubTarball(resolved)
    const at = resolved.lastIndexOf('#')
    return at === -1 ? undefined : githubCommit(resolved.slice(0, at), resolved.slice(at + 1))
  }
}

// yarn 1's: yarn.lock in `dir`, by the name a package is installed as, the last of its location, and
// its version, where one entry alone has both. The .yarn-integrity yarn writes into the node_modules
// it lays out has to hold the entry's resolution for each of its patterns, as yarn.lock's `resolved`
// spells it: a yarn.lock changed since often moves a git dependency to another commit of one version.
function yarnRecord(dir, host) {
  const installed = readJson(join(dir, 'node_modules', '.yarn-integrity'), host)?.lockfileEntries
  const text = readText(host, join(dir, 'yarn.lock'))
  if (!isPlainObject(installed) || text === null) return NONE
  let packages
  try {
    packages = parseYarn1Lockfile(text, { checkVersions: false }).packages
  } catch {
    return NONE // whatever the reader refuses
  }
  const byVersion = new Map()
  for (const { patterns, name, version, resolution } of new Set(Object.values(packages))) {
    let commit = resolutionCommit(resolution)
    const resolved = resolution?.type === 'git' ? `${resolution.repo}#${resolution.commit}` : resolution?.sha1 === undefined ? resolution?.tarball : `${resolution.tarball}#${resolution.sha1}`
    if (!patterns.every((pattern) => Object.hasOwn(installed, pattern) && installed[pattern] === resolved)) commit = undefined
    // Of two entries of one name and version, either may be the one installed.
    const id = `${name}@${version}`
    byVersion.set(id, byVersion.has(id) ? undefined : commit)
  }
  return (location, version) => byVersion.get(`${location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)}@${version}`)
}

// What npm and yarn leave in a node_modules they lay out, and the reader of each one's record.
const LAYOUTS = [['.package-lock.json', npmRecord], ['.yarn-integrity', yarnRecord]]

// The names pnpm 9 to 12 may give snapshot `key`'s directory in node_modules/.pnpm, as its
// depPathToFilename (@pnpm/dependency-path) spells them: each character a path can't hold made `+`,
// `#` too from pnpm 10, and a peer's parentheses `_`; where that is too long or has a capital, cut
// short before `_` and a hash of it, 26 base32 of an MD5 for pnpm 9, 32 hex of a SHA-256 from pnpm 10,
// of which the hash alone is kept, as where it is cut depends on the install's
// virtualStoreDirMaxLength.
const STORE_NAMES = [
  [/[\\/:*?"<>|]/gu, (name) => toBase32(hash('md5', name, 'buffer'), { padding: false }).toLowerCase()],
  [/[\\/:*?"<>|#]/gu, (name) => hash('sha256', name).slice(0, 32)],
]
const storeNames = (key) => STORE_NAMES.flatMap(([unsafe, digest]) => {
  let name = key.replace(unsafe, '+')
  if (name.includes('(')) name = name.replace(/\)$/u, '').replace(/\)\(|\(|\)/gu, '_')
  return [name, `_${digest(name)}`]
})
const STORE_HASH = /_(?:[\da-f]{32}|[a-z2-7]{26})$/u

// pnpm's: lock.yaml in `store`, a node_modules/.pnpm, the lockfile of what pnpm 9 to 12 installed
// there, by the directory there each snapshot is in. A git dependency's resolution is the repository
// and commit, or GitHub's tarball of the commit, and the package's `path` in it (`#path:`) where it is
// not at the root.
function pnpmRecord(store, host) {
  const text = readText(host, join(store, 'lock.yaml'))
  let packages
  try {
    packages = text === null ? undefined : parsePnpmLockfile(text).lockfile?.packages
  } catch {
    return NONE // whatever the reader refuses
  }
  const byName = new Map()
  for (const [key, { resolution }] of Object.entries(packages ?? {})) {
    const commit = resolutionCommit(resolution)
    if (commit === undefined) continue
    const directory = (resolution.path ?? '').replace(/^\/+|\/+$/gu, '')
    const repo = { github: commit.github, ...(isValidRepoField('directory', directory) && { directory }), commit: commit.commit }
    for (const name of storeNames(key)) byName.set(name, repo)
  }
  return (name) => byName.get(name) ?? byName.get(STORE_HASH.exec(name)?.[0])
}

// A pnpm package's real path, <store>/<dir>/node_modules/<name>, its store a node_modules/.pnpm.
const PNPM_PACKAGE = /^(.*\/node_modules\/\.pnpm)\/([^/]+)\/node_modules\/(?:@[^/]+\/)?[^/]+$/u

// Each npm dependency of `bundle`, its buckets' paths from `root`, that is a git dependency of a GitHub
// repository, recorded as its package manager's record has it installed: that repository, over the
// one its package.json names (a fork's, where that names the one forked), at its root (`''`) or the
// subdirectory pnpm records, at that commit. A dependency is found by its real path, through the link
// pnpm installs it by: in a node_modules/.pnpm, by its directory there; else by its location from the
// nearest directory, at or above the one its outermost node_modules is in, whose node_modules npm or
// yarn laid out. Metadata, as `repo` is: never checked against the files installed.
export function pinInstalledCommits(bundle, root, host = diskHost) {
  const stores = new Map()
  const layouts = new Map()
  // The record of `dir`'s node_modules, or null where neither npm nor yarn laid it out; where both
  // left theirs, neither's, as which was last is not known.
  const layoutAt = (dir) => {
    if (!layouts.has(dir)) {
      const found = LAYOUTS.filter(([file]) => host.stat(join(dir, 'node_modules', file)) !== null)
      layouts.set(dir, found.length === 0 ? null : found.length === 1 ? found[0][1](dir, host) : NONE)
    }
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
    let repo
    const pnpm = PNPM_PACKAGE.exec(real)
    if (pnpm !== null) {
      const [, store, name] = pnpm
      if (!stores.has(store)) stores.set(store, pnpmRecord(store, host))
      repo = stores.get(store)(name)
    } else {
      const at = real.indexOf('/node_modules/')
      if (at === -1) continue
      let from = resolve(real.slice(0, at) || '/')
      while (layoutAt(from) === null && dirname(from) !== from) from = dirname(from)
      const commit = (layoutAt(from) ?? NONE)(toPosix(relative(from, real)), info.version)
      if (commit !== undefined) repo = { github: commit.github, directory: '', commit: commit.commit }
    }
    if (repo !== undefined) bundle.modules.set(dir, { ...info, repo })
  }
}
