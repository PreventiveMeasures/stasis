// foundry.toml profiles (with `extends`) and the remappings `forge build` hands solc: a port of foundry
// v1.8.3's `RemappingsProvider` and foundry-compilers' `Remapping::find_many_with_context`. Not read:
// ~/.foundry/foundry.toml, `FOUNDRY_CONFIG`, FOUNDRY_*/DAPP_* other than the profile and remappings.

import { posix, resolve } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { nestedMap, toPosix } from '@exodus/stasis-core/util'
import { isDir } from '../resolve-typescript.js'
import { projectOwnership, projectRelative, readUtf8OrNull, realpathOrNull } from './solidity-ownership.js'
import { isTomlTable, readToml } from './toml.js'

export const FOUNDRY_TOML = 'foundry.toml'
export const REMAPPINGS_TXT = 'remappings.txt'

// Paths are absolute POSIX, compared by component as Rust compares `Path`s.
const isAbs = (p) => p.startsWith('/')
const normalComps = (p) => p.split('/').filter((c) => c !== '' && c !== '.')
const compCount = (p) => normalComps(p).length + (isAbs(p) ? 1 : 0)
const fileName = (p) => normalComps(p).at(-1) ?? null
const pathKey = (p) => (isAbs(p) ? '/' : '') + normalComps(p).join('/')
const pathEq = (a, b) => pathKey(a) === pathKey(b)
// `Path::strip_prefix`: the remaining components, or null.
function stripPrefix(p, base) {
  if (isAbs(p) !== isAbs(base)) return null
  const a = normalComps(p)
  const b = normalComps(base)
  if (b.length > a.length || !b.every((c, i) => a[i] === c)) return null
  return a.slice(b.length).join('/')
}
const pathStartsWith = (p, base) => stripPrefix(p, base) !== null
const rustJoin = (base, p) => (isAbs(p) ? p : base.endsWith('/') ? `${base}${p}` : `${base}/${p}`)
const parentOf = (p) => {
  const c = normalComps(p)
  if (c.length === 0) return null
  return (isAbs(p) ? '/' : '') + c.slice(0, -1).join('/')
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
function cmpPath(a, b) {
  if (isAbs(a) !== isAbs(b)) return isAbs(a) ? -1 : 1
  const x = normalComps(a)
  const y = normalComps(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const c = cmpStr(x[i], y[i])
    if (c !== 0) return c
  }
  return x.length - y.length
}

function canonicalize(p, host) {
  const real = realpathOrNull(p, host)
  return real === null ? null : toPosix(real)
}

// How messages name a file of the project at `root`: from the root, by its lexical or its canonical path.
export function shownFrom(root, host = diskHost, canonicalRoot = canonicalize(root, host) ?? root) {
  return (abs) => stripPrefix(abs, root) || stripPrefix(abs, canonicalRoot) || abs
}

const isSymlinkPath = (p, host) => {
  try {
    return host.readlink(p) !== null
  } catch {
    return false
  }
}

// In the filesystem's own order where the host has one: forge walks `read_dir` unsorted, and where two
// packages share a lib window the first one listed decides a remapping. A dangling symlink is dropped.
function listDir(dir, host) {
  let entries
  try {
    entries = host.readdirUnsorted ? host.readdirUnsorted(dir) : host.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    const path = rustJoin(dir, e.name)
    const kind = e.isSymbolicLink() ? host.stat(path) : e
    if (kind === null) continue
    out.push({ path, name: e.name, isFile: kind.isFile(), isDir: kind.isDirectory(), isSymlink: e.isSymbolicLink() })
  }
  return out
}

const readDir = (dir, host) => listDir(dir, host).filter((e) => !e.name.startsWith('.'))

// Rust's `str::trim`: a byte-order mark (U+FEFF, which JS's `trim` takes) stays, as it does for forge.
const rustTrim = (s) => s.replaceAll(/^\p{White_Space}+|\p{White_Space}+$/gu, '')

// `[context:]name=path`, split as forge and solc split it. An empty name or path is invalid (null),
// but for solc (`emptyPath`) only an empty name is: `x/=` maps `x/A.sol` to `A.sol`.
function parseRemapping(entry, { emptyPath = false } = {}) {
  const eq = entry.indexOf('=')
  if (eq === -1) return null
  const colon = entry.slice(0, eq).indexOf(':')
  const name = entry.slice(colon + 1, eq)
  const path = entry.slice(eq + 1)
  let context = colon === -1 ? null : entry.slice(0, colon)
  if (rustTrim(name) === '' || (!emptyPath && rustTrim(path) === '')) return null
  if (context !== null && rustTrim(context) === '') context = null
  return { context, name, path }
}

// Errors name where an invalid remapping is, never its text, which may be anything (a secret included).
const REMAPPING_FORM = 'expected [context:]prefix=target'

// One remapping per non-blank line; a line that isn't one throws, as forge and solc refuse the file.
export function parseRemappingLines(text, { label = 'remappings', emptyPath = false } = {}) {
  const out = []
  text.split('\n').forEach((raw, i) => {
    const line = rustTrim(raw)
    if (line === '') return
    const r = parseRemapping(line, { emptyPath })
    if (r === null) throw new Error(`${label}:${i + 1}: invalid remapping, ${REMAPPING_FORM}`)
    out.push(r)
  })
  return out
}

function configRemappings(value, file) {
  const where = `${file === null ? '' : `${file}: `}\`remappings\``
  if (!Array.isArray(value)) throw new Error(`${where} is not an array of strings`)
  return value.map((entry, i) => {
    if (typeof entry !== 'string') throw new Error(`${where} entry ${i + 1} is not a string`)
    const r = parseRemapping(entry)
    if (r === null) throw new Error(`${where} entry ${i + 1}: invalid remapping, ${REMAPPING_FORM}`)
    return r
  })
}

// A config forge refuses for its settings, or that a dependency may not read: a dependency's is
// skipped, as forge skips it. Anything else wrong with a config is fatal.
class ConfigRefused extends Error {}

const withSlash = (s) => (s.endsWith('/') || s.endsWith('.sol') ? s : `${s}/`)
const withTrailing = (s) => (s.endsWith('/') ? s : `${s}/`)
const trimSlashes = (s) => s.replace(/\/+$/u, '')

export const toSolcRemapping = (r) => ({ context: r.context, prefix: withSlash(r.name), target: withSlash(r.path) })

// Profile names are case-insensitive (figment's `Profile`).
export const foundryProfile = (env) => (env.FOUNDRY_PROFILE || 'default').toLowerCase()

// `RelativeRemappingPathBuf::with_root`.
function withRoot(parent, path) {
  const rest = stripPrefix(path, parent)
  if (rest !== null) return { parent, path: rest }
  return { parent: isAbs(path) ? null : parent, path }
}

// `RelativeRemapping::new`.
const toRelative = (r, root) => ({ context: r.context === null ? null : withRoot(root, r.context).path, name: r.name, path: withRoot(root, r.path) })

// `From<RelativeRemapping> for Remapping`.
function fromRelative(rr) {
  const { parent, path } = rr.path
  const joined = isAbs(path) || parent === null ? path : rustJoin(parent, path)
  return { context: rr.context, name: withSlash(rr.name), path: withSlash(joined) }
}

// `relative_remapping_preserving_context_boundary`: a context's trailing `/` bounds its directory.
function relativePreservingBoundary(r, root) {
  const rr = toRelative(r, root)
  if (r.context?.endsWith('/') && rr.context !== null) rr.context = withTrailing(rr.context)
  return rr
}

// `Display for RelativeRemapping`.
const displayRelative = (rr) => withSlash(`${rr.context === null ? '' : `${rr.context}:`}${rr.name}=${rr.path.path}`)

const relKey = (rr) => `${rr.context}\0${rr.name}\0${rr.path.parent === null ? '\u0001' : pathKey(rr.path.parent)}\0${pathKey(rr.path.path)}`

// `Remappings`: takes an alias only when no equal or shorter one claims it (in the same context), and
// never an alias of the project's own src/test/script dirs.
class Remappings {
  constructor(remappings, projectPaths = []) {
    this.remappings = remappings
    this.projectPaths = projectPaths
  }

  push(r) {
    if (r.name.endsWith('.sol') && !r.path.endsWith('.sol')) return
    const conflicting = this.remappings.some((e) => {
      if (r.name.endsWith('.sol')) return e.name === r.name && e.context === r.context && e.path === r.path
      return r.name.startsWith(withTrailing(e.name)) && e.context === r.context
    })
    if (conflicting) return
    if (this.projectPaths.some((p) => p.toLowerCase() === r.name.toLowerCase())) return
    this.remappings.push(r)
  }

  intoInner() {
    return [...Map.groupBy(this.remappings, (r) => `${r.context}\0${r.name}`).values()].map(([r]) => r)
  }
}

// `remapping_name_is_prefix`: `prefix` names `name` or a parent namespace of it.
function nameIsPrefix(prefix, name) {
  const p = trimSlashes(prefix)
  const n = trimSlashes(name)
  return p === n || (n.startsWith(p) && n.slice(p.length).startsWith('/'))
}

const SRC_DIR = 'src'
const JS_SRC_DIR = 'contracts'
const isSourceDir = (p) => [SRC_DIR, JS_SRC_DIR].includes(fileName(p))
const isLibName = (name) => name === 'lib' || name === 'node_modules'
const isLibDir = (p) => isLibName(fileName(p))
const noRecurse = (name) => name === 'tests' || name === 'test' || name === 'demo'

// `root`'s child on the way to `current`. (Upstream loops `while !is_lib_dir(next) ||
// !next.ends_with("contracts")`, which always holds on the first component.)
function nextNestedWindow(root, current) {
  if (!isLibDir(root)) return root
  const first = normalComps(stripPrefix(current, root) ?? '')[0]
  return first === undefined ? root : rustJoin(root, first)
}

function lastNestedSourceDir(root, dir) {
  if (isSourceDir(dir)) return dir
  for (let parent = parentOf(dir); parent !== null; parent = parentOf(parent)) {
    if (pathEq(parent, root)) return root
    if (isSourceDir(parent)) return parent
  }
  return root
}

const endsWithJsSource = (c) => fileName(c.sourceDir) === JS_SRC_DIR || normalComps(c.sourceDir).slice(-2).join('/') === 'contracts/src'

function mergeOnSameLevel(candidates, currentDir, level, windowStart, insideNodeModules) {
  const srcs = candidates.filter((c) => fileName(c.sourceDir) === SRC_DIR)
  if (srcs.length === 1) return srcs
  // Else the current dir absorbs the candidates of its level (`current/{auth,tokens}/*.sol`).
  const rest = candidates.filter((c) => c.level !== level)
  const sourceDir = insideNodeModules ? windowStart : currentDir
  // `<dep>/src/lib/` mistaken for a package of its own.
  if (level > 0 && pathEq(sourceDir, windowStart) && (isSourceDir(sourceDir) || isLibDir(sourceDir))) return rest
  return [...rest, { windowStart, sourceDir, level }]
}

// A window opens at each `lib`/`node_modules` barrier, and a dir holding `.sol` files is a source dir
// of the window it lies in. Symlinked dirs are followed, except back into the current traversal path.
function findRemappingCandidates(currentDir, open, level, insideNodeModules, visited, host) {
  let isCandidate = false
  let current
  const search = []
  for (const e of readDir(currentDir, host)) {
    if (!isCandidate && e.isFile && e.name.endsWith('.sol')) {
      isCandidate = true
    } else if (e.isDir) {
      let seen = visited
      if (e.isSymlink) {
        const target = canonicalize(e.path, host)
        if (target !== null) {
          current ??= canonicalize(currentDir, host)
          if (visited.has(target) || (current !== null && pathStartsWith(current, target))) continue
          seen = new Set(visited).add(target)
        }
      }
      if (!noRecurse(e.name)) search.push([e, seen])
    }
  }

  const candidates = search.flatMap(([{ path, name }, seen]) => (isLibName(name)
    ? findRemappingCandidates(path, path, level + 1, insideNodeModules, seen, host)
    : findRemappingCandidates(path, open, level, insideNodeModules, seen, host)))

  const windowStart = nextNestedWindow(open, currentDir)
  if (isCandidate || candidates.filter((c) => c.level === level && pathEq(c.windowStart, windowStart)).length > 1) {
    return mergeOnSameLevel(candidates, currentDir, level, windowStart, insideNodeModules)
  }
  // A single nested candidate: `current/nested/contracts/c.sol` maps to `current`.
  const c = candidates.find((x) => x.level === level)
  if (c) {
    const distance = normalComps(stripPrefix(c.sourceDir, c.windowStart) ?? '').length
    if (distance > 1 && endsWithJsSource(c)) c.sourceDir = windowStart
    else if (!isSourceDir(c.sourceDir) && !pathEq(c.sourceDir, c.windowStart)) c.sourceDir = lastNestedSourceDir(open, c.sourceDir)
  }
  return candidates
}

function insertPrioritized(map, key, path) {
  const existing = map.get(key)
  if (existing === undefined || compCount(existing) > compCount(path) || (fileName(path) === SRC_DIR && fileName(existing) !== SRC_DIR)) {
    map.set(key, path)
  }
}

// The path before the last `lib`/`node_modules` component below `root` (null at the top level).
function dependencyOwner(root, windowStart) {
  const rest = stripPrefix(windowStart, root)
  if (rest === null) return null
  const parts = normalComps(rest)
  const barrier = parts.findLastIndex(isLibName)
  return barrier > 0 ? parts.slice(0, barrier).reduce((p, c) => rustJoin(p, c), root) : null
}

const byContextDepth = (a, b) => {
  const x = a.context ?? ''
  const y = b.context ?? ''
  return compCount(y) - compCount(x) || cmpStr(x, y)
}

const sortedEntries = (map, cmp) => [...map].toSorted(([a], [b]) => cmp(a, b))

// `contextual` is keyed by the dependency whose own lib dir holds the package.
export function findRemappingsWithContext(dir, host = diskHost) {
  const insideNodeModules = fileName(dir) === 'node_modules'
  const candidates = readDir(dir, host)
    .filter((e) => e.isDir)
    .flatMap((e) => findRemappingCandidates(e.path, e.path, 0, insideNodeModules, new Set(), host))
    .toSorted((a, b) => cmpPath(a.sourceDir, b.sourceDir))

  const global = new Map()
  const contextual = new Map()
  for (const c of candidates) {
    const name = fileName(c.windowStart)
    if (name === null) continue
    const key = `${name}/`
    const owner = dependencyOwner(dir, c.windowStart)
    if (owner !== null) insertPrioritized(nestedMap(contextual, owner), key, c.sourceDir)
    insertPrioritized(global, key, c.sourceDir)
  }
  return {
    global: sortedEntries(global, cmpStr).map(([name, path]) => ({ context: null, name, path: `${path}/` })),
    contextual: sortedEntries(contextual, cmpPath)
      .flatMap(([owner, map]) => sortedEntries(map, cmpStr).map(([name, path]) => ({ context: `${owner}/`, name, path: `${path}/` })))
      .toSorted(byContextDepth),
  }
}

const snakeCase = (k) => k.replaceAll(/([a-z0-9])([A-Z])/gu, '$1_$2').replaceAll('-', '_').toLowerCase()

// Top-level tables that are sections of their own, not (legacy) profiles (`Config::STANDALONE_SECTIONS`).
const STANDALONE_SECTIONS = new Set([
  'profile', 'external', 'rpc_endpoints', 'etherscan', 'fmt', 'lint', 'doc', 'fuzz', 'invariant', 'symbolic',
  'coverage', 'mutation', 'tracing', 'labels', 'dependencies', 'soldeer', 'vyper', 'bind_json',
])

// `[profile.<name>]` over the legacy `[<name>]`, key by key; `topLevel`: values outside any table.
function parseFoundryToml(text, file = null) {
  const current = new Map()
  const legacy = new Map()
  const topLevel = new Map()
  const read = (map, name, table) => {
    const profile = name.toLowerCase()
    const dict = nestedMap(map, profile)
    for (const [key, value] of Object.entries(table)) {
      const k = snakeCase(key)
      if (k !== 'extends' || map === current) dict.set(k, value) // forge reads `extends` from `[profile.<name>]` only
    }
  }
  for (const [key, value] of Object.entries(readToml(text, file))) {
    if (!isTomlTable(value)) topLevel.set(snakeCase(key), value)
    else if (key === 'profile') {
      for (const [name, table] of Object.entries(value)) if (isTomlTable(table)) read(current, name, table)
    } else if (!STANDALONE_SECTIONS.has(key)) read(legacy, key, value)
  }
  const profiles = new Map([...legacy].map(([name, dict]) => [name, new Map(dict)]))
  for (const [name, dict] of current) profiles.set(name, new Map([...(profiles.get(name) ?? []), ...dict]))
  return { profiles, topLevel }
}

// Figment's merge of an `extends` base: local keys win; `extend-arrays` appends a local array to the base's.
function mergeExtended(base, local, strategy) {
  const out = new Map([...base].map(([p, dict]) => [p, new Map(dict)]))
  for (const [p, dict] of local) {
    const merged = nestedMap(out, p)
    for (const [k, v] of dict) {
      const prev = merged.get(k)
      merged.set(k, strategy === 'extend-arrays' && Array.isArray(prev) && Array.isArray(v) ? [...prev, ...v] : v)
    }
  }
  return out
}

const EXTEND_STRATEGIES = new Set(['extend-arrays', 'replace-arrays', 'no-collision'])
const isExtends = (v) => typeof v === 'string'
  || (isTomlTable(v) && typeof v.path === 'string' && (v.strategy === undefined || EXTEND_STRATEGIES.has(v.strategy)))

// Forge's `TomlFileProvider`. Throws where forge refuses the config, or `refused` refuses the file or its base.
function readFoundryProfiles(file, profile, { refused = () => null, show, host }) {
  const name = show(file)
  const refusal = refused(file)
  if (refusal) throw new ConfigRefused(`${name}: refusing to read it: ${refusal}`)
  const text = readUtf8OrNull(file, name, host)
  if (text === null) return { profiles: new Map(), topLevel: new Map(), files: [] }
  let { profiles, topLevel } = parseFoundryToml(text, name)
  const files = [file]
  const ext = profiles.get(profile)?.get('extends')
  if (ext !== undefined) {
    if (!isExtends(ext)) throw new Error(`${name}: \`extends\` must be a path, or a table with a \`path\` and an optional \`strategy\` (${[...EXTEND_STRATEGIES].join(', ')})`)
    const { path: extPath, strategy = 'extend-arrays' } = typeof ext === 'string' ? { path: ext } : ext
    // Joined, not normalized: the read resolves a `..` after a symlink as forge's does, from where the link leads.
    const baseFile = rustJoin(posix.dirname(file), extPath)
    const baseRefusal = refused(baseFile)
    if (baseRefusal) throw new ConfigRefused(`${name}: refusing to extend ${extPath}: ${baseRefusal}`)
    const baseName = show(baseFile)
    const baseText = readUtf8OrNull(baseFile, baseName, host)
    if (baseText === null) throw new ConfigRefused(`${name}: the inherited config file does not exist: ${extPath}`)
    const base = parseFoundryToml(baseText, baseName).profiles
    if (base.get(profile)?.has('extends')) {
      throw new ConfigRefused(`${name}: nested inheritance is not allowed (${extPath} has an 'extends' field in profile '${profile}')`)
    }
    if (strategy === 'no-collision') {
      const collisions = [...(profiles.get(profile)?.keys() ?? [])].filter((k) => k !== 'extends' && base.get(profile)?.has(k))
      if (collisions.length > 0) throw new ConfigRefused(`${name}: key collision in profile '${profile}' when extending ${extPath}: ${collisions.join(', ')}`)
    }
    profiles = mergeExtended(base, profiles, strategy)
    files.push(baseFile)
  }
  return { profiles, topLevel, files }
}

// A missing selected profile falls back to the default, as forge does for dependency configs.
const selectProfile = (profiles, profile) => new Map([...(profiles.get('default') ?? []), ...(profiles.get(profile) ?? [])])

// Else the file's top-level `remappings` (a mapping file written for stasis).
function profileRemappings({ profiles, topLevel }, profile, file = null) {
  const value = selectProfile(profiles, profile).get('remappings') ?? topLevel.get('remappings')
  return value === undefined ? [] : configRemappings(value, file)
}

export function foundryTomlRemappings(text, profile = 'default') {
  return profileRemappings(parseFoundryToml(text), profile)
}

// What `--mapping=foundry.toml` takes; `profiled`: whether the selected `profile` is one of the file's.
export function readFoundryTomlRemappings(file, profile, { show, host = diskHost }) {
  const abs = toPosix(resolve(file))
  const read = readFoundryProfiles(abs, profile, { show, host })
  return { remappings: profileRemappings(read, profile, show(abs)), files: read.files, profiled: hasProfile(read.profiles, profile) }
}

const hasProfile = (profiles, profile) => profile !== 'default' && profiles.has(profile)

// For the root foundry.toml: a profile that isn't there is warned about.
function profileApplies(profiles, profile) {
  if (profile !== 'default' && !profiles.has(profile)) {
    console.warn(`[loader.solidity] FOUNDRY_PROFILE=${profile} is not a profile in foundry.toml; using [profile.default]`)
  }
  return hasProfile(profiles, profile)
}

// `ProjectPathsConfig::find_source_dir`.
const findSourceDir = (root, host) => (isDir(rustJoin(root, 'src'), host) || !isDir(rustJoin(root, JS_SRC_DIR), host) ? 'src' : JS_SRC_DIR)

// `DappHardhatDirProvider`: `lib` and/or `node_modules`, whichever exist (`lib` when neither).
function detectLibs(root, host) {
  if (!isDir(rustJoin(root, 'node_modules'), host)) return ['lib']
  return isDir(rustJoin(root, 'lib'), host) ? ['lib', 'node_modules'] : ['node_modules']
}

function loadFoundryConfig(root, profile, { refused, host, show = shownFrom(root, host) }) {
  const file = rustJoin(root, FOUNDRY_TOML)
  const name = show(file)
  const { profiles, files } = readFoundryProfiles(file, profile, { refused, show, host })
  const dict = selectProfile(profiles, profile)
  // A setting of the wrong type throws, as forge refuses the config: no quiet default.
  const setting = (key, ok, what) => {
    const value = dict.get(key)
    if (value !== undefined && !ok(value)) throw new Error(`${name}: \`${key}\` must be ${what}`)
    return value
  }
  const isString = (v) => typeof v === 'string'
  return {
    profiles,
    files,
    src: setting('src', isString, 'a string') ?? findSourceDir(root, host),
    test: setting('test', isString, 'a string') ?? 'test',
    script: setting('script', isString, 'a string') ?? 'script',
    libs: setting('libs', (v) => Array.isArray(v) && v.every(isString), 'an array of strings') ?? detectLibs(root, host),
    remappings: dict.has('remappings') ? configRemappings(dict.get('remappings'), name) : [],
    autoDetect: setting('auto_detect_remappings', (v) => typeof v === 'boolean', 'a boolean') !== false,
  }
}

// `foundry_toml_dir_entries`: `dir` and its direct subdirs (symlinks resolved) that hold a foundry.toml.
function foundryTomlDirEntries(dir, host) {
  const out = []
  const consider = (path, isSymlink) => {
    if (host.stat(rustJoin(path, FOUNDRY_TOML)) === null) return
    const canonical = canonicalize(path, host)
    if (canonical !== null) out.push({ canonical, path, isSymlink })
  }
  consider(dir, isSymlinkPath(dir, host))
  for (const e of listDir(dir, host)) if (e.isDir) consider(e.path, e.isSymlink)
  return out
}

const cmpEntry = (a, b) => cmpPath(a.canonical, b.canonical) || cmpPath(a.path, b.path)

function rebaseNested(r, canonical, lexical) {
  const rebase = (v) => {
    const rest = stripPrefix(v, canonical)
    return rest === null ? v : rustJoin(lexical, rest)
  }
  const out = { ...r, path: rebase(r.path) }
  if (r.context === null) return out
  let context
  if (isAbs(r.context)) {
    context = rebase(r.context)
  } else {
    const parts = []
    for (const c of normalComps(rustJoin(lexical, r.context))) {
      if (c === '..') parts.pop()
      else parts.push(c)
    }
    context = `/${parts.join('/')}`
  }
  out.context = r.context.endsWith('/') ? withTrailing(context) : context
  return out
}

// Forge's `load_nested_config`, remappings rebased onto the canonical root; null (warned) where forge
// rejects it or `refused` refuses it. One that isn't TOML throws, where forge would quietly skip it.
function loadNestedConfig(canonical, profile, { refused, show, host }) {
  let config
  try {
    config = loadFoundryConfig(canonical, profile, { refused, show, host })
  } catch (err) {
    if (!(err instanceof ConfigRefused)) throw err
    console.warn(`[loader.solidity] Skipping a dependency's config: ${err.message}`)
    return null
  }
  const txt = rustJoin(canonical, REMAPPINGS_TXT)
  const txtName = show(txt)
  const refusal = refused(txt)
  if (refusal) console.warn(`[loader.solidity] Skipping a dependency's ${txtName}: ${refusal}`)
  const text = refusal ? null : readUtf8OrNull(txt, txtName, host)
  return {
    src: config.src,
    libs: config.libs,
    files: [...config.files, ...(text === null ? [] : [txt])],
    // `sanitized()` roots them, then `Remapping::from` makes the path absolute and slash-terminated.
    remappings: config.remappings.map((r) => fromRelative(relativePreservingBoundary(fromRelative({ ...r, path: { parent: null, path: r.path } }), canonical))),
    fileRemappings: text === null ? [] : parseRemappingLines(text, { label: txtName }),
  }
}

// `find_nested_foundry_remappings`: `[lexicalLibPath, remapping, isPackageEntry]`. A dependency's config
// reads only its own files and other dependencies' (by real path: `ownership`).
function findNestedFoundryRemappings(root, libPaths, profile, files, ownership, host) {
  const canonicalRoot = canonicalize(root, host) ?? root
  const shown = shownFrom(root, host, canonicalRoot)
  // A dependency's file under its lexical path: where the bundle sees it, and how messages name it.
  const lexical = (entry, file) => rustJoin(entry.path, stripPrefix(file, entry.canonical) ?? file)
  // Why the dependency at `entry` may not read `file`, judged from the root by its lexical, else
  // canonical path; one a dependency's `libs` named must be a dependency itself.
  const refused = (entry) => (file) => {
    const dir = stripPrefix(entry.path, root) ?? stripPrefix(entry.canonical, canonicalRoot)
    if (dir === null) return 'the dependency lies outside the project root'
    if (entry.viaDependency && !ownership.of(dir).dependency) return `${dir}, which a dependency's \`libs\` names, isn't a dependency`
    // `file` is as joined (an `extends` path unnormalized, for the walk to resolve as the read does).
    if (!file.startsWith(`${entry.canonical}/`)) return 'it lies outside the dependency'
    const o = ownership.of(`${dir}/${file.slice(entry.canonical.length + 1)}`)
    if (o.reason) return o.reason
    if (o.outside) return `it resolves to ${o.real}, outside the project root`
    if (o.real === null || o.dependency || pathStartsWith(rustJoin(canonicalRoot, o.real), entry.canonical)) return null
    return `it resolves to the project's own ${o.real}`
  }
  const show = (entry) => (file) => shown(lexical(entry, file))
  // A BTreeSet popped in (canonical, path) order.
  const pending = new Map()
  const addPending = (e) => pending.set(`${e.canonical}\0${e.path}`, e)
  for (const lib of libPaths) for (const e of foundryTomlDirEntries(rustJoin(root, lib), host)) addPending(e)
  const seen = new Set([canonicalRoot])
  const configs = new Map()
  const out = []
  while (pending.size > 0) {
    const [key, entry] = [...pending].reduce((min, e) => (cmpEntry(e[1], min[1]) < 0 ? e : min))
    pending.delete(key)
    if (entry.canonical === canonicalRoot) continue
    if (!configs.has(entry.canonical)) {
      const config = loadNestedConfig(entry.canonical, profile, { refused: refused(entry), show: show(entry), host })
      configs.set(entry.canonical, config)
      for (const f of config?.files ?? []) files.add(lexical(entry, f))
    }
    const config = configs.get(entry.canonical)
    if (!config) continue
    for (const r of config.remappings) out.push([entry.path, rebaseNested(r, entry.canonical, entry.path), false])
    for (const r of config.fileRemappings) out.push([entry.path, fromRelative(toRelative(r, entry.path)), false])
    if (!entry.isSymlink && !seen.has(entry.canonical)) {
      seen.add(entry.canonical)
      for (const lib of config.libs) {
        for (const e of foundryTomlDirEntries(rustJoin(entry.path, lib), host)) if (!e.isSymlink) addPending({ ...e, viaDependency: true })
      }
    }
    // A custom (or missing) source dir isn't auto-detected: forge synthesizes `<dep>/=<dep>/<src>/`.
    const standard = ['src', 'contracts', 'lib'].some((s) => pathEq(s, config.src))
    const name = fileName(entry.path)
    if ((!standard || !isDir(rustJoin(entry.canonical, config.src), host)) && name !== null) {
      out.push([entry.path, { context: null, name: `${name}/`, path: withTrailing(rustJoin(entry.path, config.src)) }, true])
    }
  }
  return out
}

// `configured_auto_remapping`: an auto-detected alias a dependency's config redirects takes that target.
function configuredAutoRemapping(r, packageEntries) {
  let best = null
  for (const [lib, configured] of packageEntries) {
    if (configured.name !== r.name) continue
    if (r.context !== null && (pathEq(lib, r.context) || !pathStartsWith(lib, r.context))) continue
    let rank
    if (pathStartsWith(r.path, lib)) rank = [0, Number.MAX_SAFE_INTEGER - compCount(lib)]
    else if (r.context !== null && pathStartsWith(lib, r.context) && pathStartsWith(lib, r.path)) rank = [1, compCount(lib)]
    else continue
    // `min_by` rank, then lib path: the first minimum wins.
    const order = best === null ? -1 : (rank[0] - best.rank[0] || rank[1] - best.rank[1] || cmpPath(lib, best.lib))
    if (order < 0) best = { rank, lib, configured }
  }
  return best === null ? r : { ...r, path: best.configured.path }
}

// `contextual_overlays`: null when an applicable authoritative alias already covers the refinement.
function contextualOverlays(authoritative, refinement) {
  const applicable = authoritative.filter((m) => m.context === null || (refinement.context !== null && pathStartsWith(refinement.context, m.context)))
  if (applicable.some((m) => nameIsPrefix(m.name, refinement.name))) return null
  return applicable
    .filter((m) => nameIsPrefix(refinement.name, m.name))
    .toSorted((a, b) => b.name.length - a.name.length)
    .map((m) => ({ ...m, context: refinement.context }))
}

// `expand_scoped_contextual_remapping`: one remapping per package of a `node_modules/@scope/`.
function expandScopedContextual(r, host) {
  const scope = trimSlashes(r.name)
  if (!scope.startsWith('@') || fileName(r.path) !== scope || fileName(parentOf(r.path) ?? '') !== 'node_modules') return [r]
  const packages = listDir(r.path, host)
    .filter((e) => e.isDir)
    .map((e) => ({ context: r.context, name: `${scope}/${e.name}/`, path: `${e.path}/` }))
    .toSorted((a, b) => cmpStr(a.name, b.name))
  return packages.length === 0 ? [r] : packages
}

// Forge's closest-path choice per alias: fewer components, then `src`, then path order.
function insertClosest(m, key, path) {
  const existing = m.get(key)
  const srcRank = (p) => (fileName(p) === SRC_DIR ? 0 : 1)
  if (existing === undefined || (compCount(path) - compCount(existing) || srcRank(path) - srcRank(existing) || cmpPath(path, existing)) < 0) {
    m.set(key, path)
  }
}

const withOverlays = (authoritative, r) => {
  const overlays = contextualOverlays(authoritative, r)
  return overlays ? [...overlays, r] : []
}

// `RemappingsProvider::get_remappings`: the remappings in the order forge settles them.
function providerRemappings(root, { userRemappings, libs, autoDetect, profile, files, ownership, host }) {
  const authoritativeUser = userRemappings.map((r) => (r.context === null ? r : { ...r, context: rustJoin(root, r.context) }))
  const all = new Remappings([...userRemappings])
  if (!autoDetect) return all.intoInner()

  const nested = findNestedFoundryRemappings(root, libs, profile, files, ownership, host)
  const auto = libs.map((lib) => findRemappingsWithContext(rustJoin(root, lib), host))

  const packageEntries = nested.filter(([, , pkg]) => pkg)
  const configured = (rs) => rs.map((r) => configuredAutoRemapping(r, packageEntries)).filter((r) => !['lib/', 'src/', 'contracts/'].includes(r.name))
  const global = configured(auto.flatMap((found) => found.global))
  const contextual = configured(auto.flatMap((found) => found.contextual))
  const detected = [...global, ...contextual]

  const ambiguous = new Set()
  for (const [name, rs] of Map.groupBy(detected, (r) => r.name)) {
    if (new Set(rs.map((r) => pathKey(r.path))).size > 1) ambiguous.add(name)
  }

  const explicitContextual = nested.filter(([, r]) => r.context !== null).flatMap(([, r]) => withOverlays(authoritativeUser, r))
  const authoritative = [...authoritativeUser, ...explicitContextual]
  // Forge's per-(context, alias) closest paths; only global remappings ever reach it.
  const closest = new Map()
  const contextualRemappings = []
  for (const [lib, r, isPackageEntry] of nested) {
    if (r.context !== null) continue
    // A dependency refining an auto-detected package root to its source dir: scope the refinement
    // to that dependency so root imports keep the broader mapping.
    const refines = !isPackageEntry && detected.some((a) => a.name === r.name && !pathEq(r.path, a.path)
      && ((a.context !== null && pathEq(a.context, lib)) || (a.context === null && pathStartsWith(r.path, a.path))))
    if (refines) contextualRemappings.push(...withOverlays(authoritative, { ...r, context: `${lib}/` }))
    insertClosest(closest, r.name, r.path)
  }
  for (const r of contextual.filter((c) => ambiguous.has(c.name)).flatMap((c) => expandScopedContextual(c, host))) {
    contextualRemappings.push(...withOverlays(authoritative, r))
  }
  for (const r of global) insertClosest(closest, r.name, r.path)

  const explicit = new Set(all.remappings.map((r) => relKey(relativePreservingBoundary(r, root))))
  for (const c of [...explicitContextual.toSorted(byContextDepth), ...contextualRemappings.toSorted(byContextDepth)]) {
    if (!explicit.has(relKey(relativePreservingBoundary(c, root)))) all.push(c)
  }
  for (const [name, path] of sortedEntries(closest, cmpStr)) all.push({ context: null, name, path })
  return all.intoInner()
}

// The detected lib dirs, warned, where forge would reject the foundry.toml's settings (a pinned mapping file reads nothing else).
export function foundryLibs(baseDir, { env = process.env, host = diskHost } = {}) {
  const root = toPosix(resolve(baseDir))
  const profile = foundryProfile(env)
  try {
    const config = loadFoundryConfig(root, profile, { host })
    return { libs: config.libs, profiled: profileApplies(config.profiles, profile), files: config.files }
  } catch (err) {
    if (!(err instanceof ConfigRefused)) throw err
    console.warn(`[loader.solidity] Using the default lib dirs: ${err.message}`)
    return { libs: detectLibs(root, host), profiled: false, files: [rustJoin(root, FOUNDRY_TOML)] }
  }
}

export function foundrySourceDir(baseDir, { host = diskHost } = {}) {
  return loadFoundryConfig(toPosix(resolve(baseDir)), 'default', { host }).src
}

// `remappings` relative to the root, in forge's order; `envUsed`: the env vars that shaped them.
export function foundryProject(baseDir, { env = process.env, host = diskHost } = {}) {
  const root = toPosix(resolve(baseDir))
  const profile = foundryProfile(env)
  const config = loadFoundryConfig(root, profile, { host })
  const profiled = profileApplies(config.profiles, profile)
  const ownership = projectOwnership(baseDir, config.libs, { soldeer: true, host })
  const files = new Set(config.files)

  const envName = env.DAPP_REMAPPINGS !== undefined ? 'DAPP_REMAPPINGS' : env.FOUNDRY_REMAPPINGS !== undefined ? 'FOUNDRY_REMAPPINGS' : null
  const envRemappings = envName === null ? [] : parseRemappingLines(env[envName], { label: envName })
  const txtFile = rustJoin(root, REMAPPINGS_TXT)
  const txt = readUtf8OrNull(txtFile, REMAPPINGS_TXT, host)
  if (txt !== null) files.add(txtFile)
  const userRemappings = [...envRemappings, ...(txt === null ? [] : parseRemappingLines(txt, { label: REMAPPINGS_TXT })), ...config.remappings]

  const provided = providerRemappings(root, { userRemappings, libs: config.libs, autoDetect: config.autoDetect, profile, files, ownership, host })
    .map((r) => displayRelative(relativePreservingBoundary(r, root)))

  // `forge build` re-reads them as config remappings, dropping aliases of its own input dirs...
  const build = new Remappings([], [config.src, config.test, config.script].map((p) => `${p}/`))
  for (const r of provided.map((s) => parseRemapping(s)).filter(Boolean)) build.push(r)
  // ...and hands them to solc as the config's `RelativeRemapping`s: slash-terminated.
  const remappings = build.intoInner()
    .map((r) => parseRemapping(displayRelative(relativePreservingBoundary(r, root))))
    .filter(Boolean)
    .map(toSolcRemapping)

  // One read from outside the root (`extends = "../base.toml"`) stays `../`, for --manifests to refuse.
  const relFiles = [...files].map((f) => projectRelative(root, f, host))
  const envUsed = [...(profiled ? [`FOUNDRY_PROFILE=${env.FOUNDRY_PROFILE}`] : []), ...(envName === null ? [] : [envName])]
  return { remappings, libs: config.libs, files: relFiles, envUsed, ownership }
}
