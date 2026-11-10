import { join, normalize, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readJson } from '@exodus/stasis-core/bundle-util'
import { isAutoExcludedDir, isPlainObject, posixPathEscapes, relativeEscapes } from '@exodus/stasis-core/util'
import { Vfs } from '@preventive/vfs'
import { checkVfsOptions, fieldResolverFor } from '../cmd/bundle.js'
import { configuredBuilds } from '../cmd/bundle-options.js'
import { foundrySourceDir } from '../loaders/foundry.js'
import { resolveConditions } from '../resolve-fields.js'
import { resolveTypescriptFallback, typescriptExportsTarget } from '../resolve-typescript.js'
import { checkKind, checkLazy, checkVersion, packageManagerOf, vfsHost } from './tree.js'

const JS = /\.(?:[cm]?[jt]s|[jt]sx)$/u
// Node's own conditions for require() and for import, which the build's are added to; with
// `mainFields` or `metro`, the field resolver's bundler ones instead (no `node`).
const NODE_CONDITIONS = [['require', 'node', 'node-addons', 'module-sync'], ['import', 'node', 'node-addons', 'module-sync']]
const FIELD_CONDITIONS = ['commonjs', 'module'].map((format) => resolveConditions(format))

// The JS files in `dir` its package.json names, as paths from `dir`, resolved as the build resolves them: by Node plus
// `conditions`, or the field resolver under `mainFields` or `metro` (per platform), a miss mapped as tsc maps it under
// `typescript`. Its `./` entry, each `exports` subpath but a pattern (for require() and import), then each `bin`.
function packageEntries(host, dir, { conditions = [], mainFields, metro = false, platforms = [], typescript = false } = {}) {
  const real = host.realpath(dir)
  const manifest = join(real, 'package.json')
  const pkg = readJson(manifest, host)
  if (!isPlainObject(pkg)) return []
  const found = new Set()
  const add = (file) => {
    const rel = file === undefined ? '' : relative(real, file)
    if (rel !== '' && !relativeEscapes(rel) && JS.test(rel)) found.add(rel)
  }
  const passes = metro || mainFields !== undefined
    ? (metro ? platforms : [null]).map((platform) => fieldResolverFor(platform, { mainFields, metro, conditions, typescript, host }))
    : [{ extras: conditions, mainFields: ['main'] }]
  // Node's resolution of `specifier`, else under `typescript` the miss `mapped` as tsc maps it; a
  // real path either way, or undefined.
  const viaNode = (specifier, names, extras, mapped) => {
    const set = new Set([...names, ...extras])
    try {
      return host.resolve(manifest, specifier, set)
    } catch {
      const hit = typescript ? mapped(set) : null
      return hit === null ? undefined : host.realpath(hit)
    }
  }
  for (const { extras, mainFields: fields, resolver } of passes) {
    const entry = fields.map((name) => pkg[name]).find((value) => typeof value === 'string' && value !== '')
    if (entry !== undefined && posixPathEscapes(entry)) continue
    if (resolver === undefined) {
      add(viaNode('./', NODE_CONDITIONS[0], extras, (set) => resolveTypescriptFallback(manifest, './', { conditions: set, host })))
    } else {
      // A real path, as Node's resolution gives and the scan takes.
      const hit = resolver(manifest, './')
      if (hit?.url !== undefined) add(host.realpath(fileURLToPath(hit.url)))
    }
  }
  const { exports, name } = pkg
  const keyed = isPlainObject(exports) && Object.keys(exports).some((key) => key.startsWith('.'))
  const subpaths = keyed ? Object.keys(exports) : exports === undefined || exports === null ? [] : ['.']
  for (const subpath of typeof name === 'string' ? subpaths : []) {
    if (!subpath.startsWith('.') || subpath.includes('*') || subpath.endsWith('/')) continue
    const specifier = subpath === '.' ? name : `${name}${subpath.slice(1)}`
    for (const { extras, resolver } of passes) {
      for (const names of resolver === undefined ? NODE_CONDITIONS : FIELD_CONDITIONS) add(viaNode(specifier, names, extras, (set) => typescriptExportsTarget(real, exports, subpath, { conditions: set, host })))
    }
  }
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : pkg.bin !== null && typeof pkg.bin === 'object' ? Object.values(pkg.bin) : []
  for (const bin of bins) {
    if (typeof bin === 'string' && !posixPathEscapes(bin) && host.stat(join(real, bin))?.isFile()) add(host.realpath(join(real, bin)))
  }
  return [...found]
}

// Directories whose .sol files are none of a project's entry points: its tests, scripts and mocks,
// what it depends on or builds, and what no walk descends into.
const SKIPPED_DIRS = new Set(['test', 'tests', 'script', 'scripts', 'mock', 'mocks', 'lib', 'node_modules', 'dependencies', 'out', 'cache', 'artifacts', 'build'])
const isSkippedDir = (name) => SKIPPED_DIRS.has(name.toLowerCase()) || isAutoExcludedDir(name)
// A .sol file but a test or script by its name.
const isEntrySol = (entry) => entry.isFile() && entry.name.endsWith('.sol') && !/\.(?:t|s|test|spec)\.sol$/u.test(entry.name)

// The .sol files under the directory `rel` of `real` that are entry points by name, but those in a
// skipped directory; sorted. Links are not followed.
function solidityFiles(host, real, rel) {
  const out = []
  const walk = (sub) => {
    for (const entry of host.readdir(join(real, sub))) {
      const path = sub === '.' ? entry.name : `${sub}/${entry.name}`
      if (entry.isDirectory()) {
        if (!isSkippedDir(entry.name)) walk(path)
      } else if (isEntrySol(entry)) {
        out.push(path)
      }
    }
  }
  walk(rel)
  return out.toSorted()
}

// The entry points of the Soldeer project in `dir`, by name and layout: its own .sol files, then those under
// contracts/, then under its source directory (foundry.toml's default `src`, else `src`); none of its tests,
// scripts, mocks, dependencies or build output. A link to a directory is none.
function solidityEntries(host, dir) {
  const real = host.realpath(dir)
  const isDirectory = (rel) => !posixPathEscapes(rel) && host.stat(join(real, rel))?.isDirectory() && host.readlink(join(real, rel)) === null
  const under = (rel) => (isDirectory(rel) ? solidityFiles(host, real, rel) : [])
  const src = normalize(foundrySourceDir(real, { host })).replace(/\/+$/u, '')
  const own = host.readdir(real).filter(isEntrySol).map((entry) => entry.name).toSorted()
  return [...new Set([...own, ...under('contracts'), ...(src === 'contracts' ? [] : under(src))])]
}

// `prefix*suffix`, one `*` in the last segment, as `{ dir, matches(fileName) }`; null for no pattern.
// Its `*` takes no leading `.`, as a shell's.
export function entryPattern(name, entry) {
  if (typeof entry !== 'string' || !entry.includes('*')) return null
  const dir = entry.slice(0, entry.lastIndexOf('/') + 1)
  const [prefix, suffix, ...more] = entry.slice(dir.length).split('*')
  if (dir.includes('*') || more.length > 0) throw new Error(`${name}: ${JSON.stringify(entry)}: a pattern holds one *, in its last segment (prefix*suffix)`)
  const matches = (file) => file.length >= prefix.length + suffix.length && file.startsWith(prefix) && file.endsWith(suffix) && (prefix !== '' || !file.startsWith('.'))
  return { dir, matches }
}

// Each pattern among `entries` replaced by the files (no symlinks) it matches in `host`, sorted.
export function expandEntries(name, host, cwd, entries) {
  if (!Array.isArray(entries)) return entries
  return entries.flatMap((entry) => {
    const pattern = entryPattern(name, entry)
    if (pattern === null) return [entry]
    const dir = posix.resolve(cwd, pattern.dir)
    const files = host.stat(dir)?.isDirectory() ? host.readdir(dir).filter((dirent) => dirent.isFile() && pattern.matches(dirent.name)) : []
    if (files.length === 0) throw new Error(`${name}: ${JSON.stringify(entry)} matches no file`)
    return files.map((dirent) => `${pattern.dir}${dirent.name}`).toSorted()
  })
}

// By the kind of bundle a package manager builds: an entry its options are checked over before
// there are any, the entries the build takes where none are given, and what having none says.
const KINDS = {
  js: { standIn: 'index.js', entries: packageEntries, none: 'has no package.json naming a JS entry point there' },
  sol: { standIn: 'index.sol', entries: solidityEntries, none: 'has no .sol entry point directly in it, under contracts/, or under its source directory' },
}

const EMPTY = vfsHost(new Vfs())

// -> { entries, none }: the entries a build of the project in `dir` takes where none are given, and what having none
// says of `dir`: its stasis.config.json's `entries` (configuredBuilds), else those its `packageManagers` build by kind
// (KINDS'), `options` checked as the build checks them; none where they build JS and Solidity bundles both.
export function defaultEntries(name, host, dir, packageManagers, options) {
  const configured = configuredBuilds(name, { cwd: dir, host, options })
  if (configured !== null) return { entries: configured.entries, none: 'has a stasis.config.json whose entries name none' }
  const kinds = new Set(packageManagers.map((pm) => packageManagerOf(name, pm).kind))
  if (kinds.size > 1) return { entries: [], none: 'has a stasis.config.json whose lockfiles lay out JS and Solidity trees, and no entries naming which to bundle' }
  const kind = KINDS[[...kinds][0]]
  checkVfsOptions(name, { ...options, entries: [kind.standIn], cwd: '/', host: EMPTY, fetched: false })
  return { entries: kind.entries(host, dir, options), none: kind.none }
}

// The build's checks of `options` before anything is fetched, over an empty tree: for the package manager given or
// any, over the entries given or a stand-in of each kind, but for what one option needs of another, which a
// configured entry's options may set (`partial`). -> the PACKAGE_MANAGERS entry of the one given
export function checkAhead(name, packageManager, options) {
  checkVersion(name, { packageManager, ...options })
  if (options.lazy !== undefined && typeof options.lazy !== 'boolean') throw new TypeError(`${name}: lazy must be a boolean`)
  const pm = packageManager === undefined ? undefined : packageManagerOf(name, packageManager)
  if (options.lazy && pm !== undefined) checkLazy(name, packageManager)
  const refusal = (entries) => {
    try {
      checkKind(name, checkVfsOptions(name, { ...options, entries, cwd: '/', host: EMPTY, fetched: false, partial: true }), packageManager === undefined ? undefined : [packageManager])
      return null
    } catch (error) {
      return error
    }
  }
  // A pattern is checked as an entry of the kind its extension names, if any (not `src/*`).
  const told = Array.isArray(options.entries) ? options.entries.filter((entry) => !entryPattern(name, entry) || /^\.[^*]+$/u.test(posix.extname(entry))) : options.entries
  const entries = told?.length === 0 && options.entries.length > 0 ? undefined : told
  const refusals = entries === undefined ? (pm === undefined ? Object.values(KINDS) : [KINDS[pm.kind]]).map(({ standIn }) => refusal([standIn])) : [refusal(entries)]
  if (!refusals.includes(null)) throw refusals[0]
  return pm
}
