import { constants } from 'node:fs'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { NO_ENTRY, invalidPackageConfig, lexists, packageJSONStat, packageJSONText, parseGithubRepository, readJson, readText } from '@exodus/stasis-core/bundle-util'
import { byName } from '@exodus/stasis-core/host'
import { archiveIntegrity, ATTESTED_METADATA, CONFIG_FILE, hasNodeModulesSegment, isPathWithin, isPlainObject, memoized, moduleInfo, posixPathEscapes, tarballIntegrityOf } from '@exodus/stasis-core/util'
import { buildNpmTree, findNpmWorkspaces } from '@preventive/deptree/npm.js'
import { buildPnpmTree, findPnpmProjects } from '@preventive/deptree/pnpm.js'
import { LockfileError, TomlError, buildSoldeerTree } from '@preventive/deptree/soldeer.js'
import { buildYarn1Tree, findYarn1Workspaces } from '@preventive/deptree/yarn1.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'
import { VfsError } from '@preventive/vfs'
import { installedMetadata } from '../installed.js'
import { ancestors } from '../loaders/paths.js'
import { createNodeResolver } from '../resolve-node.js'
import { globSync, matchesGlob } from './glob.js'
import { lazyView, untouchedMemo } from './lazy.js'
import { settleSoldeer } from './soldeer.js'
import { YARNCLEAN, yarnclean } from './yarnclean.js'
import { isDir, isFile } from '../resolve-typescript.js'

export const nearest = (cwd, holds) => ancestors(cwd).find(holds) ?? null

export const holding = (host, ...names) => (dir) => names.some((name) => isFile(join(dir, name), host))

// Of a dir holding a package.json: an unreadable one is a package all the same; a nameless one is a `type` marker.
function holdsPackage(host, dir) {
  const json = readJson(join(dir, 'package.json'), host)
  return json === null || json.name !== undefined
}

function outsider(host, root, cwd, projects) {
  for (let dir = cwd; dir !== root; dir = dirname(dir)) {
    if (!isFile(join(dir, 'package.json'), host)) continue
    if (projects.has(relative(root, dir))) return null
    if (holdsPackage(host, dir)) return dir
  }
  return null
}

// deptree's refusals name no file for yarn.lock and soldeer.lock.
const naming = (file, promise) => promise.catch((cause) => {
  if (!(cause instanceof LockfileError || cause instanceof TomlError)) throw cause
  throw new Error(`${file}: ${cause.message}`, { cause })
})

export function projectView(host, root) {
  const at = (p) => (p === '/' ? root : join(root, p))
  const typeOf = (st) => (st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other')
  const stat = (p) => {
    const st = host.stat(at(p))
    if (st === null) throw new VfsError('ENOENT', p)
    return st
  }
  return {
    readdir: (p) => host.readdir(at(p)).map((d) => d.name),
    lstat(p) {
      if (host.readlink(at(p)) !== null) return { type: 'symlink', mode: 0o777 }
      const st = stat(p)
      return { type: typeOf(st), mode: st.mode & 0o777 }
    },
    stat: (p) => ({ type: typeOf(stat(p)) }),
    readFile: (p) => host.readFile(at(p)),
  }
}

// detect-libc's familySync by the report alone, 'unknown' (pnpm installs all) where it can't tell; no reverse DNS to stall.
function reportedLibc() {
  if (process.platform !== 'linux' || !process.report) return 'unknown'
  const { excludeNetwork } = process.report
  try {
    process.report.excludeNetwork = true
    const report = process.report.getReport()
    if (report.header?.glibcVersionRuntime) return 'glibc'
    if (report.sharedObjects?.some((file) => file.includes('libc.musl-') || file.includes('ld-musl-'))) return 'musl'
  } catch { /* unknown */ } finally {
    process.report.excludeNetwork = excludeNetwork
  }
  return 'unknown'
}
const currentLibc = memoized(reportedLibc)

// No Node: a tree laid out to be read, not run, is for none, which takes every engines.node. A libc is detected only
// for this machine's os; for another, unless given, pnpm matches none ('unknown').
const target = ({ os = process.platform, cpu = process.arch, libc = os === process.platform ? currentLibc() : 'unknown' }) => ({ os, cpu, libc })

export function checkNonEmpty(name, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && (typeof value !== 'string' || value === '')) throw new TypeError(`${name}: ${key} must be a non-empty string`)
  }
}

// The target a tree is laid out for, and the store it is cached in.
export function checkTree(name, { os, cpu, libc, cache }) {
  checkNonEmpty(name, { os, cpu })
  if (libc !== undefined && !['glibc', 'musl', 'unknown'].includes(libc)) throw new TypeError(`${name}: libc must be one of 'glibc', 'musl', 'unknown'`)
  if (cache === undefined || cache === false || (typeof cache?.read === 'function' && typeof cache?.write === 'function')) return
  throw new TypeError(`${name}: cache must be false, or a store with read and write, or left out`)
}

// yarn installs a workspace from the root declaring it, whatever yarn.lock is nearer; any other package from the nearest.
function yarn1Root(host, cwd) {
  const workspaces = (dir) => {
    const declared = readJson(join(dir, 'package.json'), host)?.workspaces
    return Boolean(Array.isArray(declared) ? declared : declared?.packages)
  }
  const root = nearest(cwd, workspaces)
  if (root !== null && outsider(host, root, cwd, new Set(findYarn1Workspaces({ project: projectView(host, root) }))) === null) return root
  return nearest(cwd, holding(host, 'yarn.lock'))
}

// As npm finds its local prefix: the first directory above `dir` whose workspaces (npm's glob on `os`) take it.
function npmWorkspaceRoot(host, dir, os) {
  return dir === '/' ? null : nearest(dirname(dir), (above) => {
    const declared = readJson(join(above, 'package.json'), host)?.workspaces
    if (!declared) return false
    const globs = Array.isArray(declared.packages) ? declared.packages : declared
    if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== 'string')) throw new Error(`${join(above, 'package.json')}: workspaces: expected a sequence of globs`)
    return findNpmWorkspaces({ project: projectView(host, above), os: os ?? process.platform }).includes(relative(above, dir))
  })
}

// npm installs the package cwd is in from npmWorkspaceRoot's, whatever package-lock.json is nearer; any other from the
// nearest package-lock.json beside a package.json. A nameless package.json is a package where a workspace root takes it.
function npmRoot(host, cwd, os) {
  for (const dir of ancestors(cwd)) {
    if (!isFile(join(dir, 'package.json'), host)) continue
    const root = npmWorkspaceRoot(host, dir, os)
    if (root !== null) return root
    if (holdsPackage(host, dir)) break
  }
  return nearest(cwd, (dir) => isFile(join(dir, 'package-lock.json'), host) && isFile(join(dir, 'package.json'), host))
}

// A JS subtree is laid out alone where nothing above it is read: `file`, nor a .yarnclean, which cleans from above.
const noneAbove = (file) => async (names, above) => !(await above()).some((dir) => dir.includes(file) || dir.includes(YARNCLEAN))
const foundryIn = (names) => names.includes('foundry.toml') || names.includes('soldeer.toml')

const PACKAGE_MANAGERS = {
  pnpm: {
    kind: 'js',
    lockfile: 'pnpm-lock.yaml',
    pin: 'pnpm',
    version: '10.33.4',
    from: 10,
    root: (host, cwd) => nearest(cwd, holding(host, 'pnpm-workspace.yaml')) ?? nearest(cwd, holding(host, 'pnpm-lock.yaml')),
    alone: noneAbove('pnpm-workspace.yaml'),
    projects: (view, pnpm) => findPnpmProjects({ project: view, host: { pnpm } }),
    installs: 'node_modules',
    lazy: true,
    build: (view, pnpm, _file, given) => buildPnpmTree({ project: view, host: { pnpm, ...target(given) }, cache: given.cache, lazy: given.lazy, production: given.production }),
  },
  yarn1: {
    kind: 'js',
    lockfile: 'yarn.lock',
    pin: 'yarn',
    version: '1.22.22',
    root: yarn1Root,
    alone: noneAbove('package.json'),
    // yarn 1 fetches an entry locking a sha1 alone by the registry's sha512.
    integrities: (text) => new Set(Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages).map(({ resolution }) => tarballIntegrityOf(resolution?.integrity)).filter(Boolean)),
    projects: (view) => findYarn1Workspaces({ project: view }),
    installs: 'node_modules',
    build: (view, yarn, file, given) => {
      const { libc: _, ...host } = target({ ...given, libc: 'unknown' }) // yarn 1 matches no libc
      return naming(file, buildYarn1Tree({ project: view, host: { yarn, ...host }, cache: given.cache, production: given.production }))
    },
  },
  npm: {
    kind: 'js',
    lockfile: 'package-lock.json',
    // npm reads no packageManager, so nothing pins it.
    version: '11.21.0',
    root: npmRoot,
    alone: noneAbove('package.json'),
    projects: (view, _npm, given) => findNpmWorkspaces({ project: view, os: given.os ?? process.platform }),
    installs: 'node_modules',
    lazy: true,
    build: (view, npm, file, given) => {
      const { libc, ...host } = target(given)
      const found = (libc === 'glibc' || libc === 'musl') && { libc } // npm finds a libc only as glibc or musl
      return naming(file, buildNpmTree({ project: view, host: { npm, ...host, ...found }, cache: given.cache, lazy: given.lazy, production: given.production }))
    },
  },
  soldeer: {
    kind: 'sol',
    lockfile: 'soldeer.lock',
    version: '0.12.0',
    // Never above the git repository's root.
    root: (host, cwd) => nearest(cwd, (dir) => holding(host, 'foundry.toml', 'soldeer.toml')(dir) || isDir(join(dir, '.git'), host)) ?? cwd,
    alone: async (names, above) => foundryIn(names) || !(await above()).some(foundryIn),
    projects: () => ['.'],
    installs: 'dependencies',
    hides: hasNodeModulesSegment,
    async build(view, soldeer, file, given) {
      const tree = await naming(file, buildSoldeerTree({ project: view, host: { soldeer, os: given.os ?? process.platform }, github: given.client }))
      settleSoldeer(view, tree.vfs, dirname(file))
      return tree
    },
  },
}

const PACKAGE_MANAGER_NAMES = Object.keys(PACKAGE_MANAGERS)

export async function loadTree(options) {
  const tree = await planTree(options).build()
  return { ...tree, host: treeHost(tree, options.project) }
}

export function treeHost(tree, project, reads) {
  const { installs, hides } = tree.trees === undefined ? layoutOf(tree) : tree
  const options = { root: tree.root, outside: project, installs, hides }
  if (tree.lazy === undefined) return vfsHost(tree.vfs, options)
  const host = vfsHost(lazyView(tree.vfs, { ...tree.lazy, reads }), { ...options, touches: () => reads.touches, retouch: () => reads.touches++ })
  host.probing = (fn) => {
    reads.probing++
    try {
      return fn()
    } finally {
      reads.probing--
    }
  }
  return host
}

export function checkLazy(name, packageManager) {
  if (!PACKAGE_MANAGERS[packageManager].lazy) throw new Error(`${name}: lazy is taken with pnpm and npm alone, not ${packageManager}`)
}

export const lazyTaken = (project, packageManager, cwd) => PACKAGE_MANAGERS[packageManager].lazy === true && !yarnclean(project, cwd)?.keeps

export const lockfileOf = (packageManager) => PACKAGE_MANAGERS[packageManager].lockfile

// The root is cwd or above it, so none is without a lockfile there.
function rootOf(host, pm, cwd, os) {
  if (nearest(cwd, holding(host, pm.lockfile)) === null) return null
  const found = pm.root(host, cwd, os)
  return found !== null && isFile(join(found, pm.lockfile), host) ? host.realpath(found) : null
}

export const lockfileRoot = (host, packageManager, cwd, os) => rootOf(host, PACKAGE_MANAGERS[packageManager], host.realpath(cwd), os)

export const NODE_MODULES_MANAGERS = PACKAGE_MANAGER_NAMES.filter((name) => PACKAGE_MANAGERS[name].installs === 'node_modules')

const NOT_GIVEN = 'no packageManager given'

export function detectPackageManager(name, host, cwd, { names = PACKAGE_MANAGER_NAMES, os, why = NOT_GIVEN } = {}) {
  const real = host.realpath(cwd)
  const found = names.map((pm) => [pm, rootOf(host, PACKAGE_MANAGERS[pm], real, os)]).filter(([, root]) => root !== null)
  if (found.length === 1) return found[0][0]
  if (found.length === 0) throw noLockfile(name, real, names, why)
  throw new Error(`${name}: ${why}, and more than one lockfile installs ${real}: ${found.map(([pm, root]) => `${join(root, lockfileOf(pm))} (${pm})`).join(', ')}`)
}

export const noLockfile = (name, place, names = PACKAGE_MANAGER_NAMES, why = NOT_GIVEN) => new Error(`${name}: ${why}, and none of ${names.map(lockfileOf).join(', ')} installs ${place}`)

export const listsFile = (listing, name) => listing.some((entry) => entry.path === name && entry.type === 'blob')

export const lockfilesListed = (listings) => PACKAGE_MANAGER_NAMES.filter((pm) => listings.some((listing) => listsFile(listing, lockfileOf(pm))))

export function checkVersion(name, { packageManager, packageManagerVersion }) {
  if (packageManagerVersion !== undefined && packageManager === undefined) throw new TypeError(`${name}: packageManagerVersion is only valid with packageManager`)
}

export function packageManagerFor(name, host, cwd, { packageManager, packageManagerVersion, os, why }, names = PACKAGE_MANAGER_NAMES) {
  checkVersion(name, { packageManager, packageManagerVersion })
  if (packageManager === undefined) return detectPackageManager(name, host, cwd, { names, os, why })
  packageManagerOf(name, packageManager, names)
  return packageManager
}

const KIND_LABELS = { js: 'JS', sol: 'Solidity' }

export function checkKind(name, kind, names = PACKAGE_MANAGER_NAMES) {
  const builders = Map.groupBy(names, (pm) => PACKAGE_MANAGERS[pm].kind)
  if (builders.has(kind)) return
  throw new Error(names.length === 1
    ? `${name}: only ${KIND_LABELS[PACKAGE_MANAGERS[names[0]].kind]} bundles are built with ${names[0]}`
    : `${name}: only ${[...builders].map(([of, pms]) => `${KIND_LABELS[of]} bundles (${pms.join(', ')})`).join(' and ')} are built`)
}

export function packageManagerOf(name, packageManager, names = PACKAGE_MANAGER_NAMES) {
  if (!names.includes(packageManager)) throw new TypeError(`${name}: packageManager must be one of ${names.map((n) => `'${n}'`).join(', ')}`)
  return PACKAGE_MANAGERS[packageManager]
}

// Duck-typed: a Vfs of another copy of @preventive/vfs is one too.
export function checkVfs(name, vfs) {
  const missing = ['lstat', 'readdir', 'readFile', 'readlink'].some((method) => typeof vfs?.[method] !== 'function')
  if (missing) throw new TypeError(`${name}: vfs must be a @preventive/vfs Vfs holding the project`)
}

// What layOutTrees checks of a tree before any is fetched, and its `build`.
function planTree({ project, packageManager, cwd, packageManagerVersion, os, cpu, libc, lazy = false, refuseInstalled, path, client, cache, installDevDependencies = true }) {
  const pm = PACKAGE_MANAGERS[packageManager]
  const found = pm.root(project, cwd, os)
  if (found === null) throw new Error(`no ${pm.lockfile} found in ${cwd} or any parent directory`)
  const file = join(found, pm.lockfile)
  if (!isFile(file, project)) throw new Error(`no ${pm.lockfile} found in ${found}, where ${cwd} is installed from`)
  const pinned = pm.pin === undefined ? undefined : readJson(join(found, 'package.json'), project)?.packageManager
  const pinnedVersion = String(pinned).startsWith(`${pm.pin}@`) ? /^[^@]+@([^+]+)/u.exec(pinned)[1] : undefined
  // Left out, deptree takes the one packageManager pins, and refuses another package manager.
  const version = packageManagerVersion ?? (pinned === undefined ? pm.version : undefined)
  const taken = version ?? pinnedVersion
  if (Number(/^(\d+)\./u.exec(taken ?? '')?.[1]) < pm.from) {
    const where = packageManagerVersion === undefined ? `${join(found, 'package.json')}: packageManager` : 'packageManagerVersion'
    throw new Error(`${where}: ${packageManager} "${taken}" is not supported: only ${packageManager} ${pm.from} and later are`)
  }
  const view = projectView(project, found)
  const projects = new Set(pm.projects(view, version, { os, cpu, libc }))
  const other = pm.kind === 'js' ? outsider(project, found, cwd, projects) : null
  if (other !== null) throw new Error(`${file} does not install ${other}: it is none of the lockfile's projects`)
  const there = refuseInstalled ? [...projects].map((dir) => join(found, dir, pm.installs)).find((at) => lexists(at, project)) : undefined
  if (there !== undefined) throw new Error(`${there} is there already, and the tree is laid out from ${file} alone, over nothing installed: remove it first`)
  // Read before anything is fetched: matching its patterns needs the optional minimatch.
  const clean = pm.kind === 'js' ? yarnclean(project, cwd) : null
  if (lazy && clean?.keeps) throw new Error(`a ${YARNCLEAN} in ${cwd} or above it keeps paths with \`!\`, which lazy does not take`)
  const root = project.realpath(found)
  const build = async () => {
    const built = await pm.build(view, version, file, { os, cpu, libc, client, cache, lazy, production: !installDevDependencies })
    const cleanAll = () => {
      if (clean !== null) for (const dir of projects) clean(built.vfs, posix.join('/', dir, pm.installs))
    }
    cleanAll()
    const lockText = pm.integrities && readText(view, pm.lockfile)
    const { vfs, stats, installed } = built
    const integrities = pm.integrities && { integrities: () => pm.integrities(lockText) }
    const lazily = lazy ? lazyTree(built, cleanAll) : {}
    return { root, vfs, projects, stats, installed, ...integrities, packageManager, packageManagerVersion: taken, ...lazily }
  }
  return { root, projects, path, pm, build }
}

export const lockfilesManagers = (name, lockfiles) => lockfiles.map((path) => {
  const found = PACKAGE_MANAGER_NAMES.find((pm) => lockfileOf(pm) === posix.basename(path))
  if (found === undefined) throw new Error(`${name}: ${CONFIG_FILE}'s lockfiles names ${path}, which is none of ${PACKAGE_MANAGER_NAMES.map(lockfileOf).join(', ')}`)
  return found
})

export function lockfileSpecs(name, project, cwd, lockfiles, os) {
  const managers = lockfilesManagers(name, lockfiles)
  return lockfiles.map((path, i) => {
    // resolve would stop at `/`.
    if (posixPathEscapes(posix.join(cwd.slice(1), path))) throw new Error(`${CONFIG_FILE}'s lockfiles names ${path}, which climbs out of ${cwd}'s root`)
    const file = resolve(cwd, path)
    if (!isFile(file, project)) throw new Error(`${CONFIG_FILE}'s lockfiles names ${path}, which is no file in ${cwd}`)
    const dir = project.realpath(dirname(file))
    const from = isPathWithin(dir, cwd) ? cwd : dir
    const pm = PACKAGE_MANAGERS[managers[i]]
    const found = pm.root(project, from, os)
    if (found !== dir) throw new Error(`${CONFIG_FILE}'s lockfiles names ${path}, but ${managers[i]} installs ${from} from ${found === null ? `no ${pm.lockfile}` : join(found, pm.lockfile)}`)
    return { packageManager: managers[i], cwd: from, path }
  })
}

export const plannedTrees = ({ specs, ...options }) => specs.map((spec) => planTree({ ...options, ...spec }))

export async function layOutTrees(options) {
  const plans = plannedTrees(options)
  const claimed = new Map()
  for (const plan of plans) {
    const dirs = [...plan.projects].map((dir) => join(plan.root, dir, plan.pm.installs))
    for (const at of dirs) {
      // As [the one claimed, the outer of the two]: the first claimed below it, else the nearest at or above it.
      const below = claimed.keys().find((dir) => dir.startsWith(`${at}/`))
      const outer = nearest(at, (dir) => claimed.has(dir))
      const clash = below !== undefined ? [below, at] : outer === null ? undefined : [outer, outer]
      if (clash !== undefined) throw new Error(`${CONFIG_FILE}'s lockfiles names ${claimed.get(clash[0]).path} and ${plan.path}, which both install ${clash[1]}`)
    }
    for (const at of dirs) claimed.set(at, plan)
  }
  const built = await settled(plans.map((plan) => plan.build()))
  return built.length === 1 ? built[0] : forestOf(built)
}

// Every one settled before the first refusal is thrown.
async function settled(promises) {
  const done = await Promise.allSettled(promises)
  const failed = done.find(({ status }) => status === 'rejected')
  if (failed !== undefined) throw failed.reason
  return done.map(({ value }) => value)
}

// What a tree serves of its root: its projects' installs and the files it writes there; and what it hides of the rest.
function layoutOf(tree) {
  const { installs, hides } = PACKAGE_MANAGERS[tree.packageManager]
  const files = tree.vfs.readdir('/').filter((name) => tree.vfs.lstat(`/${name}`).type === 'file')
  return { installs: [...[...tree.projects].map((dir) => join(dir, installs)), ...files], hides }
}

function mountedVfs(owners) {
  const ownerOf = (p) => {
    for (let at = p.indexOf('/', 1); ; at = p.indexOf('/', at + 1)) {
      const member = owners.get(at === -1 ? p.slice(1) : p.slice(1, at))
      if (member !== undefined) return member
      if (at === -1) throw stackless(() => new VfsError('ENOENT', p))
    }
  }
  const read = (method) => (p) => {
    const member = ownerOf(p)
    return member.tree.vfs[method](p.slice(member.prefix.length))
  }
  return { lstat: read('lstat'), readlink: read('readlink'), readFile: read('readFile'), readdir: read('readdir') }
}

export const unpackedOf = (tree) => (tree.trees === undefined
  ? tree.lazy?.unpacked.size ?? tree.stats.installed ?? tree.stats.dependencies
  : tree.trees.reduce((sum, one) => sum + unpackedOf(one), 0))

function forestOf(trees) {
  const root = ancestors(trees[0].root).find((dir) => trees.every((tree) => isPathWithin(dir, tree.root)))
  const members = trees.map((tree) => {
    const at = posix.relative(root, tree.root)
    return { tree, at, prefix: at === '' ? '' : `${at}/`, ...layoutOf(tree) }
  })
  // layOutTrees checked the plans' installs apart already, but for the files a tree writes at its root.
  const owners = new Map()
  for (const member of members) {
    for (const path of member.installs) {
      const at = `${member.prefix}${path}`
      if (owners.has(at)) throw new Error(`${CONFIG_FILE}'s lockfiles lay out trees which both install ${posix.join(root, at)}`)
      owners.set(at, member)
    }
  }
  const within = (member, rel) => rel === member.at || rel.startsWith(member.prefix)
  const hiders = members.filter((member) => member.hides !== undefined)
  const rooted = members.some((member) => member.at === '')
  const hides = rooted && hiders.length === 0 ? undefined : (rel) => {
    // Out of every tree, a node_modules is none but on the way to one.
    if (!members.some((member) => within(member, rel))) return hasNodeModulesSegment(rel) && !members.some(({ at }) => at.startsWith(`${rel}/`))
    return hiders.some((member) => within(member, rel) && member.hides(rel.slice(member.prefix.length)))
  }
  const forest = {
    root,
    vfs: mountedVfs(owners),
    installs: [...owners.keys()],
    hides,
    projects: new Set(members.filter(({ tree }) => PACKAGE_MANAGERS[tree.packageManager].kind === 'js').flatMap((member) => [...member.tree.projects].map((dir) => posix.join(member.at, dir)))),
    // Read as they are when read: a lazy tree's counts grow as it unpacks.
    get stats() {
      const stats = {}
      const counts = trees.flatMap(({ stats: own }) => Object.entries({ ...own, installed: own.installed ?? own.dependencies, dependencies: undefined }))
      for (const [key, value] of counts) if (typeof value === 'number') stats[key] = (stats[key] ?? 0) + value
      return stats
    },
    get installed() {
      return members.flatMap((member) => member.tree.installed.map((pkg) => ({ ...pkg, path: `${member.prefix}${pkg.path}` })))
    },
    trees,
  }
  const lazy = members.filter(({ tree }) => tree.lazy !== undefined)
  if (lazy.length === 0) return forest
  const packages = new Map(lazy.flatMap((member) => [...member.tree.lazy.roots].map((own) => [`/${member.prefix}${own.slice(1)}`, { member, own }])))
  const unpacked = {
    has(dir) {
      const { member, own } = packages.get(dir)
      return member.tree.lazy.unpacked.has(own)
    },
  }
  const owned = (dirs) => new Set(dirs.map((dir) => packages.get(dir).own))
  // Onto the forest itself, keeping its getters.
  return Object.assign(forest, {
    lazy: { roots: new Set(packages.keys()), unpacked },
    async unpack(asked, read = asked) {
      const byMember = Map.groupBy(asked, (dir) => packages.get(dir).member)
      await settled([...byMember].map(([member, dirs]) => member.tree.unpack(owned(dirs), owned(dirs.filter((dir) => read.has(dir))))))
    },
  })
}

const PACKAGE_NAME = /^(?:@[^/@.][^/]*\/)?[^/@.][^/]*$/u

// The `roots` the package at `dir` depends on, found as Node finds them from it: what the build likely reads next.
function dependenciesOf(vfs, dir, roots) {
  const manifest = readJson(`${dir}/package.json`, vfs)
  if (!isPlainObject(manifest)) return []
  const names = new Set(['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) => (isPlainObject(manifest[field]) ? Object.keys(manifest[field]) : [])))
  const realOrNull = (path) => {
    try {
      return vfs.realpath(path)
    } catch {
      return null
    }
  }
  const dirs = ancestors(dir).filter((at) => posix.basename(at) !== 'node_modules').toArray()
  const found = (name) => dirs.values().map((at) => realOrNull(posix.join(at, 'node_modules', name))).find((real) => real !== null)
  return [...names].filter((name) => PACKAGE_NAME.test(name)).map(found).filter((real) => roots.has(real))
}

// Each package unpacked is cleaned as the full tree's (positive patterns clean each path by its own). What a package
// `read` depends on is unpacked with it, not what a probed one does; one deptree refuses then is left for the build.
function lazyTree({ vfs, installed, unpack }, cleanAll) {
  const roots = new Set(installed.map(({ path }) => `/${path}`).filter((dir) => vfs.isDirectory(dir)))
  const unpacked = new Set()
  const refused = new Set()
  const at = new Map(installed.map(({ path }, i) => [path, i]))
  const unpackOne = async (dir) => {
    const [entry] = await unpack([dir.slice(1)])
    installed[at.get(entry.path)] = entry
    unpacked.add(dir)
  }
  return {
    lazy: { roots, unpacked },
    async unpack(asked, read = asked) {
      const seen = new Set(asked)
      const ahead = []
      await settled([...asked].map(async (dir) => {
        await unpackOne(dir)
        if (!read.has(dir)) return
        for (const dependency of dependenciesOf(vfs, dir, roots)) {
          if (seen.has(dependency) || unpacked.has(dependency) || refused.has(dependency)) continue
          seen.add(dependency)
          ahead.push(unpackOne(dependency).catch(() => refused.add(dependency)))
        }
      })).finally(() => Promise.all(ahead))
      cleanAll()
    },
  }
}

const githubRoot = (url) => {
  const github = parseGithubRepository(url)
  return github === null ? undefined : { github, directory: '' }
}

// Each dependency of `bundle` at the full commit the tree installs it from: an npm package at its gitHead, only where
// the bundle records its repo; a Soldeer git dependency at its `rev`, of its repo's root. One installed from a directory
// (deptree copies it from the project as read) records it, from `root`, tagged npm:directory. -> accounts, by dir
export function pinFromTree(bundle, root, tree) {
  if (tree.trees !== undefined) return new Map(tree.trees.flatMap((one) => [...pinFromTree(bundle, root, one)]))
  const { root: from, installed, packageManager } = tree
  const fromRoot = (path) => posix.relative(root, posix.join(from, path))
  const byDir = new Map(installed.map((pkg) => [fromRoot(pkg.path), pkg]))
  const integrities = tree.integrities?.()
  const locked = ({ integrity, checksum }) => (PACKAGE_MANAGERS[packageManager].kind !== 'js' ? archiveIntegrity('soldeer', checksum) : (integrities?.has(tarballIntegrityOf(integrity)) ?? true) ? integrity : undefined)
  const accounts = new Map()
  for (const [dir, info] of bundle.modules) {
    const pkg = byDir.get(dir)
    if (pkg === undefined) continue
    const at = isValidRepoField('commit', pkg.commit) ? info.repo ?? githubRoot(pkg.git) : undefined
    const directory = pkg.directory === undefined ? undefined : fromRoot(pkg.directory) || '.'
    const pinned = installedMetadata(dir, info.ecosystem, { repo: at && { ...at, commit: pkg.commit }, integrity: locked(pkg), patchHash: pkg.patch?.hash, directory })
    // deptree read it at the path pnpm's settings name, from the lockfile's directory, and held it to its hash.
    if (pinned.patch) pinned.patch.file = fromRoot(pkg.patch.path)
    bundle.modules.set(dir, moduleInfo({ ...info, ...pinned }))
    accounts.set(dir, Object.fromEntries(ATTESTED_METADATA.map((field) => [field, pinned[field]])))
  }
  return accounts
}

// fs.Stats#mode carries the file type above the permission bits a Vfs stat holds.
const TYPE_BITS = { file: constants.S_IFREG, directory: constants.S_IFDIR, symlink: constants.S_IFLNK }

const typePredicates = (type) => ({ isFile: () => type === 'file', isDirectory: () => type === 'directory', isSymbolicLink: () => type === 'symlink' })

const dirent = (name, type) => ({ name, ...typePredicates(type) })

// A resolver probes many names and takes a miss as none: building the stack is most of what a miss costs.
function stackless(make) {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 0
  try {
    return make()
  } finally {
    Error.stackTraceLimit = limit
  }
}

// A `host` over `vfs`; with `root` (a real path) and `outside` (a host of the rest), the Vfs's `/` is `root`, serving
// what it `installs`, a path `hides` takes and a node_modules out of `root` being none. Links are walked as the OS does.
export function vfsHost(vfs, { root, outside, installs = [], hides, cache = true, touches = () => 0, retouch } = {}) {
  if (sep !== '/') throw new Error('The Vfs host is POSIX-only')
  const disk = outside ?? null
  const installed = new Set(installs)
  const prefix = disk === null || root === '/' ? '/' : `${root}/`
  const towardRoot = (p) => p === root || prefix.startsWith(`${p}/`)
  const zoneOf = (p) => {
    if (disk === null) return 'tree'
    if (!p.startsWith(prefix)) return hasNodeModulesSegment(p) && !towardRoot(p) ? 'none' : 'outside'
    const rel = p.slice(prefix.length)
    for (let at = rel.indexOf('/'); at !== -1; at = rel.indexOf('/', at + 1)) {
      if (installed.has(rel.slice(0, at))) return 'tree'
    }
    if (installed.has(rel)) return 'tree'
    return hides?.(rel) ? 'none' : 'outside'
  }
  const installedIn = Map.groupBy(installed, (dir) => join(root, dirname(dir)))
  const inVfs = disk === null ? (p) => p : (p) => `/${p.slice(prefix.length)}`
  // As spelled: realpath resolves a `..` after the link before it.
  const abs = (p) => (p.startsWith('/') ? p : `/${p}`)
  const normal = (p) => resolve('/', p)
  const memo = () => untouchedMemo(touches, { cache, retouch })
  const nodeAt = (real) => {
    try {
      return stackless(() => vfs.lstat(inVfs(real)))
    } catch (err) {
      if (NO_ENTRY.has(err?.code)) return null
      throw err
    }
  }

  // `p` is a real path but for its last name; null when it exists and isn't a link.
  const readlink = (p) => {
    const zone = zoneOf(p)
    if (zone === 'outside') return disk.readlink(p)
    const node = zone === 'none' ? null : nodeAt(p)
    if (node === null) throw stackless(() => new VfsError('ENOENT', p))
    return node.type === 'symlink' ? vfs.readlink(inVfs(p)) : null
  }

  // A miss is kept too, but not where a link led: what it threw turns on the hops taken.
  const realMemo = memo()
  const realOf = (p, hops) => {
    const parentReal = realpath(dirname(p), hops)
    const name = basename(p)
    // A `.` or `..` is taken in the real dir before it, which must be one.
    if (name === '.' || name === '..') {
      if (statOf(parentReal)?.isDirectory() !== true) throw new VfsError('ENOTDIR', p)
      return name === '.' ? parentReal : dirname(parentReal)
    }
    const candidate = join(parentReal, name)
    const link = readlink(candidate)
    if (link !== null && hops >= 40) throw new VfsError('ELOOP', p)
    return link === null ? candidate : realpath(link.startsWith('/') ? link : `${dirname(candidate)}/${link}`, hops + 1)
  }
  const realpath = (p, hops = 0) => {
    if (p === '/') return '/'
    const { result, error } = realMemo(p, () => {
      try {
        return { result: realOf(p, hops) }
      } catch (err) {
        if (hops === 0 && (err.code === 'ENOENT' || err.code === 'ELOOP')) return { error: err }
        throw err
      }
    })
    if (error !== undefined) throw error
    return result
  }

  const nodeOf = (real) => {
    const node = nodeAt(real)
    if (node === null) throw new VfsError('ENOENT', real)
    return node
  }

  // Node's findPackageJSON refuses a manifest that is no JSON object.
  const manifestError = memo()
  const checkManifest = (path) => {
    const error = manifestError(path, () => {
      try {
        return isPlainObject(JSON.parse(packageJSONText(host.readFile(path)))) ? null : invalidPackageConfig(path)
      } catch (cause) {
        return invalidPackageConfig(path, cause)
      }
    })
    if (error !== null) throw error
  }

  const statCache = memo()
  const statOf = (real) => statCache(real, () => {
    if (zoneOf(real) === 'outside') return disk.stat(real)
    const node = nodeAt(real)
    return node !== null && node.type !== 'symlink' ? { ...typePredicates(node.type), mode: TYPE_BITS[node.type] | node.mode } : null
  })
  const listingOf = (real, p) => {
    if (zoneOf(real) === 'tree') {
      if (nodeOf(real).type !== 'directory') throw new VfsError('ENOTDIR', p)
      const dir = inVfs(real)
      return vfs.readdir(dir).map((name) => dirent(name, vfs.lstat(join(dir, name)).type)).toSorted(byName)
    }
    // An outside directory shows the tree's installed paths in place of its own, and nothing that is none.
    const out = disk.readdir(real).filter((d) => zoneOf(join(real, d.name)) === 'outside')
    for (const name of (installedIn.get(real) ?? []).map((dir) => basename(dir))) {
      const node = nodeAt(join(real, name))
      if (node !== null) out.push(dirent(name, node.type))
    }
    return out.toSorted(byName)
  }
  const listings = memo()
  // A path ending in `/` or `/.` names a directory, which path.resolve drops.
  const namesDir = (p) => p.endsWith('/') || p.endsWith('/.')
  const checkDir = (p, real) => {
    if (namesDir(p) && statOf(real)?.isDirectory() === false) throw new VfsError('ENOTDIR', p)
  }

  const host = {
    stat(p) {
      let real
      try {
        real = realpath(abs(p))
      } catch {
        return null
      }
      const stats = statOf(real)
      return stats !== null && namesDir(p) && !stats.isDirectory() ? null : stats
    },
    readFile(p) {
      const real = realpath(abs(p))
      checkDir(p, real)
      if (zoneOf(real) === 'outside') return disk.readFile(real)
      if (nodeOf(real).type !== 'file') throw new VfsError('EISDIR', p)
      const bytes = vfs.readFile(inVfs(real))
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    },
    readdir(p) {
      const real = realpath(abs(p))
      // A copy, the caller's to sort or add to.
      return [...listings(real, () => listingOf(real, p))]
    },
    readlink(p) {
      // One naming a directory is no link, nor is a `..`, as lstat takes it.
      if (namesDir(p) || basename(p) === '..') {
        host.realpath(p)
        return null
      }
      p = abs(p)
      return readlink(join(realpath(dirname(p)), basename(p)))
    },
    realpath(p) {
      const real = realpath(abs(p))
      checkDir(p, real)
      return real
    },
    glob: (pattern, options) => globSync(host, pattern, options),
    matchesGlob,
    // As Node's: never out of a node_modules dir; one there that can't be read is refused (packageJSONStat).
    findPackageJSON(p) {
      let from = normal(p)
      if (host.stat(from)?.isFile()) from = realpath(from)
      for (const dir of ancestors(dirname(from))) {
        if (basename(dir) === 'node_modules') break
        const candidate = join(dir, 'package.json')
        if (packageJSONStat(host, candidate)?.isFile()) {
          checkManifest(candidate)
          return candidate
        }
      }
      return undefined
    },
    resolve: (parentFile, specifier, conditions) => (resolver ?? createNodeResolver(host)).resolve(normal(parentFile), specifier, conditions),
    touches,
    retouch,
  }
  const resolver = cache ? createNodeResolver(host) : undefined
  return host
}
