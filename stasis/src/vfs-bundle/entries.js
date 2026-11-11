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
const NODE_CONDITIONS = [['require', 'node', 'node-addons', 'module-sync'], ['import', 'node', 'node-addons', 'module-sync']]
const FIELD_CONDITIONS = ['commonjs', 'module'].map((format) => resolveConditions(format))

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

const SKIPPED_DIRS = new Set(['test', 'tests', 'script', 'scripts', 'mock', 'mocks', 'lib', 'node_modules', 'dependencies', 'out', 'cache', 'artifacts', 'build'])
const isEntrySol = (entry) => entry.isFile() && entry.name.endsWith('.sol') && !/\.(?:t|s|test|spec)\.sol$/u.test(entry.name)

function solidityFiles(host, real, rel) {
  const walk = (sub) => host.readdir(join(real, sub)).flatMap((entry) => {
    const path = sub === '.' ? entry.name : `${sub}/${entry.name}`
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name.toLowerCase()) || isAutoExcludedDir(entry.name) ? [] : walk(path)
    return isEntrySol(entry) ? [path] : []
  })
  return walk(rel).toSorted()
}

function solidityEntries(host, dir) {
  const real = host.realpath(dir)
  const isDirectory = (rel) => !posixPathEscapes(rel) && host.stat(join(real, rel))?.isDirectory() && host.readlink(join(real, rel)) === null
  const under = (rel) => (isDirectory(rel) ? solidityFiles(host, real, rel) : [])
  const src = normalize(foundrySourceDir(real, { host })).replace(/\/+$/u, '')
  const own = host.readdir(real).filter(isEntrySol).map((entry) => entry.name).toSorted()
  return [...new Set([...own, ...under('contracts'), ...(src === 'contracts' ? [] : under(src))])]
}

// `prefix*suffix`, one `*` in the last segment, whose `*` takes no leading `.`, as a shell's; null for no pattern.
export function entryPattern(name, entry) {
  if (typeof entry !== 'string' || !entry.includes('*')) return null
  const dir = entry.slice(0, entry.lastIndexOf('/') + 1)
  const [prefix, suffix, ...more] = entry.slice(dir.length).split('*')
  if (dir.includes('*') || more.length > 0) throw new Error(`${name}: ${JSON.stringify(entry)}: a pattern holds one *, in its last segment (prefix*suffix)`)
  const matches = (file) => file.length >= prefix.length + suffix.length && file.startsWith(prefix) && file.endsWith(suffix) && (prefix !== '' || !file.startsWith('.'))
  return { dir, matches }
}

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

const KINDS = {
  js: { standIn: 'index.js', entries: packageEntries, none: 'has no package.json naming a JS entry point there' },
  sol: { standIn: 'index.sol', entries: solidityEntries, none: 'has no .sol entry point directly in it, under contracts/, or under its source directory' },
}

const EMPTY = vfsHost(new Vfs())

export function defaultEntries(name, host, dir, packageManagers, options) {
  const configured = configuredBuilds(name, { cwd: dir, host, options })
  if (configured !== null) return { entries: configured.entries, none: 'has a stasis.config.json whose entries name none' }
  const kinds = new Set(packageManagers.map((pm) => packageManagerOf(name, pm).kind))
  if (kinds.size > 1) return { entries: [], none: 'has a stasis.config.json whose lockfiles lay out JS and Solidity trees, and no entries naming which to bundle' }
  const kind = KINDS[[...kinds][0]]
  checkVfsOptions(name, { ...options, entries: [kind.standIn], cwd: '/', host: EMPTY, fetched: false })
  return { entries: kind.entries(host, dir, options), none: kind.none }
}

// Over an empty tree, before anything is fetched, but for what a configured entry's options may set (`partial`).
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
