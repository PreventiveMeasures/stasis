import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'

import { readText } from '@exodus/stasis-core/bundle-util'
import { isTypeDeclaration, memoized, relativeEscapes, withoutBom } from '@exodus/stasis-core/util'
import { diskHost } from '@exodus/stasis-core/host'
import { RELATIVE_REQUEST } from './resolve-node.js'
import { hostMemo } from './vfs-bundle/lazy.js'

// tsc-style module resolution (`--typescript`) for scan.js and resolve-fields.js: it only completes a miss with
// an on-disk TypeScript source, so a resolution that succeeded is never rewritten (an on-disk `.js` beats its `.ts`).

const TS_SIBLING_EXTS = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
])

// A declaration's spelling (./x.d.js -> ./x.d.ts) is among them: every probe site refuses one.
export function typescriptSiblings(name) {
  const ext = extname(name)
  const stem = name.slice(0, -ext.length)
  return TS_SIBLING_EXTS.get(ext)?.map((e) => `${stem}${e}`) ?? []
}

// Never completed by appending `.ts`; any other extension (`./x.service`) is, as tsc's candidate list has it.
const NO_COMPLETION_EXTS = new Set([...TS_SIBLING_EXTS.keys(), '.ts', '.tsx', '.mts', '.cts', '.json'])

export function realpathOr(path, host, fallback = path) {
  try {
    return host.realpath(path)
  } catch {
    return fallback
  }
}

export const isFile = (p, host = diskHost) => host.stat(p)?.isFile() ?? false
export const isDir = (p, host = diskHost) => host.stat(p)?.isDirectory() ?? false

export function readManifest(file, host = diskHost) {
  const text = readText(host, file)
  if (text === null) return null
  // A manifest that exists but is malformed fails closed, as Node throws rather than resolving past it.
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`Invalid package.json: ${file}`, { cause })
  }
}

export function locatePackage(fromDir, spec, host = diskHost) {
  const parts = spec.split('/')
  const pkgLen = spec.startsWith('@') ? 2 : 1
  if (parts.length < pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const pkgName = parts.slice(0, pkgLen).join('/')
  const subpath = parts.slice(pkgLen).join('/')
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const pkgDir = join(dir, 'node_modules', pkgName)
    if (basename(dir) !== 'node_modules' && isDir(pkgDir, host)) return { pkgDir, subpath }
    if (dirname(dir) === dir) return null
  }
}

export function nearestPackage(file, host = diskHost, read = readManifest) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const pkgPath = join(dir, 'package.json')
    const pkg = isFile(pkgPath, host) ? read(pkgPath, host) : null
    if (pkg) return { pkgDir: dir, pkg }
    if (dirname(dir) === dir) return null
  }
}

// `dir` and each directory above it, up to the nearest node_modules or the root: those a package there may hold.
function* packageDirs(dir) {
  for (; basename(dir) !== 'node_modules'; dir = dirname(dir)) {
    yield dir
    if (dirname(dir) === dir) return
  }
}

// A `.d.ts` is types-only, erased at runtime: no resolution lands on one.
export const isSourceFile = (path, host = diskHost) => !isTypeDeclaration(path) && isFile(path, host)
const firstSource = (candidates, host) => candidates.find((path) => isSourceFile(path, host)) ?? null
// tsc's pick for a JS output, the first of its TS siblings on disk: null for none.
export const typescriptSource = (output, host) => firstSource(typescriptSiblings(output), host)

function probeFile(base, exts, host) {
  const completed = NO_COMPLETION_EXTS.has(extname(base)) ? [] : exts.map((ext) => `${base}${ext}`)
  return firstSource([base, ...typescriptSiblings(base), ...completed], host)
}

const probeIndex = (dir, exts, host) => firstSource(exts.map((ext) => join(dir, `index${ext}`)), host)

// `dirOnly` skips the file rules ('.', '..', a trailing '/'). An unbuilt output's source is probed without `outputs`.
function probeTypescriptTarget(base, { js = false, dirOnly = false, outputs, host }) {
  // tsc's tryAddingExtensions order; `.js`/`.jsx` only with `js`, for a path Node never probed (a tsconfig paths target).
  const exts = js ? ['.ts', '.tsx', '.js', '.jsx'] : ['.ts', '.tsx']
  const fromMain = (path) => probeFile(path, exts, host) ?? probeIndex(path, exts, host)
  const probe = (path, mapping) => {
    const file = dirOnly ? null : probeFile(path, exts, host)
    if (file !== null || !isDir(path, host)) return file
    const pkg = readManifest(join(path, 'package.json'), host)
    if (typeof pkg?.main === 'string' && pkg.main.length > 0) {
      // A broken main falls through to the package index, like Node.
      const entry = resolvePath(path, pkg.main)
      const hit = fromMain(entry) ?? fromOutputSource(entry, fromMain, { outputs: mapping, host, pkgDir: path })
      if (hit) return hit
    }
    return probeIndex(path, exts, host)
  }
  return probe(base, outputs) ?? fromOutputSource(base, (input) => probe(input, null), { outputs, host })
}

function leniently(lenient, read) {
  try {
    return read()
  } catch (error) {
    if (!lenient) throw error
    return null
  }
}

// dir -> the compiler options of its tsconfig.json, each loaded once: null where it has none. `lenient` is for builds
// that only hint: a tsconfig.json that doesn't load maps nothing rather than failing them.
function tsconfigsOf(host, lenient) {
  const configs = hostMemo(host)
  return (dir) => configs(dir, () => {
    const file = join(dir, 'tsconfig.json')
    return isFile(file, host) ? leniently(lenient, () => loadTsconfigCompilerOptions(file, host)) : null
  })
}

// Without `rootDir` the root is the tsconfig's dir, as TypeScript 6 takes it (an older tsc infers it from its inputs).
export function tsconfigOutputsOf({ host = diskHost, configs = tsconfigsOf(host, false) } = {}) {
  return (pkgDir) => {
    const dir = realpathOr(pkgDir, host)
    const options = IN_NODE_MODULES.test(dir) ? null : configs(dir)
    if (typeof options?.outDir !== 'string') return null
    return { dir, outDir: options.outDir, rootDir: typeof options.rootDir === 'string' ? options.rootDir : dir }
  }
}

// A package.json with no tsconfig.json beside it builds nothing (a `type` marker, a manifest copied into `dist/`).
function packageHolding(path, host) {
  for (const dir of packageDirs(dirname(path))) {
    if (!isFile(join(dir, 'package.json'), host)) continue
    if (inNodeModules(dir, host)) return null
    if (isFile(join(dir, 'tsconfig.json'), host)) return dir
  }
  return null
}

// tsc's tryLoadInputFileForPath. Call it only once `path` missed, as it reads the tsconfig.json. `pkgDir`: the
// package naming `path`, whose `outDir` may lie outside it.
export function fromOutputSource(path, probeSource, { outputs, host = diskHost, pkgDir } = {}) {
  if (outputs == null) return null
  const owner = pkgDir ?? packageHolding(path, host)
  const layout = owner === null ? null : outputs(owner)
  if (layout === null) return null
  const rel = relative(layout.outDir, join(layout.dir, relative(owner, path))) // by the package's real path
  return relativeEscapes(rel) ? null : probeSource(join(layout.rootDir, rel))
}

// As Node's PACKAGE_TARGET_RESOLVE, a conditions object commits to its first matching key; an array yields all.
function expandTarget(value, wildcard, conditions) {
  if (typeof value === 'string') return [wildcard == null ? value : value.replaceAll('*', wildcard)]
  if (Array.isArray(value)) return value.flatMap((v) => expandTarget(v, wildcard, conditions))
  if (value === null || typeof value !== 'object') return []
  const key = Object.keys(value).find((k) => k === 'default' || conditions.has(k))
  return key === undefined ? [] : expandTarget(value[key], wildcard, conditions)
}

// Exact key first (never one with a '*'), else the longest prefix (with `longest`, then the longest key), the first of
// a tie: with `longest`, Node's PATTERN_KEY_COMPARE order.
function bestKey(map, spec, longest) {
  if (Object.hasOwn(map, spec) && !spec.includes('*')) return { key: spec, wildcard: null }
  let best = null
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*')
    if (star === -1 || key.indexOf('*', star + 1) !== -1) continue
    const suffix = key.slice(star + 1)
    if (spec.length < key.length - 1 || !spec.startsWith(key.slice(0, star)) || !spec.endsWith(suffix)) continue
    if (best === null || star > best.star || (longest && star === best.star && key.length > best.key.length)) {
      best = { key, star, wildcard: spec.slice(star, spec.length - suffix.length) }
    }
  }
  return best
}

// Node's PACKAGE_TARGET_RESOLVE refuses a target leaving the package ('..' hops and node_modules re-entry).
const validRelativeTarget = (target) => target.startsWith('./') && !target.split('/').some((seg) => seg === '..' || seg === 'node_modules')

// `key`: '.', './sub' or '#name'. Exports sugar (a bare string, array or conditions object) is the '.' target.
// Substitution only, as Node requires exports and imports targets to name exact files.
export function typescriptExportsTarget(pkgDir, exports, key, { conditions = new Set(), host = diskHost, outputs = tsconfigOutputsOf({ host }) } = {}) {
  if (exports == null) return null
  const sugar = typeof exports !== 'object' || Array.isArray(exports) || Object.keys(exports).every((k) => !k.startsWith('.') && !k.startsWith('#'))
  if (sugar && key !== '.') return null
  const keyed = sugar ? { '.': exports } : exports
  const match = bestKey(keyed, key, true)
  const targets = match === null ? [] : expandTarget(keyed[match.key], match.wildcard, conditions)
  const probeTarget = (path) => probeFile(path, [], host)
  for (const target of targets.filter(validRelativeTarget)) {
    const base = resolvePath(pkgDir, target)
    const hit = probeTarget(base) ?? fromOutputSource(base, probeTarget, { outputs, host, pkgDir })
    if (hit) return hit
  }
  return null
}

// tsconfig.json is JSONC: its comments go, then any comma before a closing bracket, each but in a string (one left
// open runs to the end). A config that exists but does not parse fails closed.
const JSONC_STRING = String.raw`"(?:[^"\\]|\\[^]?)*(?:"|$)`
const JSONC_COMMENTS = new RegExp(String.raw`(${JSONC_STRING})|//[^\n]*|/\*[^]*?(?:\*/|$)`, 'gu')
const JSONC_TRAILING_COMMAS = new RegExp(String.raw`(${JSONC_STRING})|,(?=\s*[\]}])`, 'gu')
const keepString = (_, string) => string ?? ''

function parseJsonc(text, file) {
  try {
    return JSON.parse(withoutBom(text).replace(JSONC_COMMENTS, keepString).replace(JSONC_TRAILING_COMMAS, keepString))
  } catch (cause) {
    throw new Error(`Invalid tsconfig: ${file}`, { cause })
  }
}

// A named base that cannot be found fails closed: its options are load-bearing.
function resolveExtendsTarget(fromFile, target, host) {
  if (target.startsWith('./') || target.startsWith('../') || isAbsolute(target)) {
    const p = resolvePath(dirname(fromFile), target)
    if (isFile(p, host)) return p
    if (isFile(`${p}.json`, host)) return `${p}.json`
  } else {
    for (const cand of [target, `${target}.json`, `${target}/tsconfig.json`]) {
      try {
        return host.resolve(fromFile, cand)
      } catch { /* not this spelling -- try the next */ }
    }
  }
  throw new Error(`tsconfig extends target not found: '${target}' (from ${fromFile})`)
}

// Each base before the config extending it, so folding them in order is tsc's nested merge. The cycle check is per branch.
function* tsconfigChain(file, host, extending = new Set()) {
  if (extending.has(file)) throw new Error(`tsconfig extends cycle at ${file}`)
  const raw = parseJsonc(host.readFile(file).toString('utf8'), file)
  extending.add(file)
  for (const base of [].concat(raw?.extends ?? [])) yield* tsconfigChain(resolveExtendsTarget(file, base, host), host, extending)
  extending.delete(file)
  yield { file, raw }
}

// tsc's path-valued options: against the declaring config's dir, or for `${configDir}` the loaded one's.
const TSCONFIG_PATH_OPTIONS = new Set(['baseUrl', 'declarationDir', 'generateCpuProfile', 'generateTrace', 'outDir', 'outFile', 'rootDir', 'tsBuildInfoFile'])
const TSCONFIG_PATH_LIST_OPTIONS = new Set(['rootDirs', 'typeRoots'])
const CONFIG_DIR = '${configDir}'
const tsconfigPath = (value, dir, configDir) => {
  if (typeof value !== 'string') return value
  return value.startsWith(CONFIG_DIR) ? resolvePath(configDir, value.replace(CONFIG_DIR, './')) : resolvePath(dir, value)
}

// Merged one level deep across the `extends` chain, as tsc merges them (`null` unsetting an option).
export function loadTsconfigCompilerOptions(file, host = diskHost) {
  let options = {}
  for (const { file: at, raw } of tsconfigChain(file, host)) {
    const own = { ...raw?.compilerOptions }
    for (const [name, value] of Object.entries(own)) {
      if (TSCONFIG_PATH_OPTIONS.has(name)) own[name] = tsconfigPath(value, dirname(at), dirname(file))
      else if (TSCONFIG_PATH_LIST_OPTIONS.has(name) && Array.isArray(value)) own[name] = value.map((p) => tsconfigPath(p, dirname(at), dirname(file)))
    }
    delete own.pathsBasePath // tsc's own, never a config's
    if (own.paths != null) own.pathsBasePath = dirname(at)
    options = { ...options, ...own }
  }
  return options
}

export const loadTsconfigPaths = (file, host = diskHost) => pathsMatcher(loadTsconfigCompilerOptions(file, host), file)

// Only the one best key's targets: tsc tries no other when they miss. A malformed shape fails closed.
function pathsMatcher({ paths, pathsBasePath, baseUrl }, file) {
  if (paths == null || typeof paths !== 'object' || Object.keys(paths).length === 0) return null
  for (const [key, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.some((t) => typeof t !== 'string')) {
      throw new Error(`tsconfig paths['${key}'] must be an array of strings (${file})`)
    }
    const starred = [key, ...targets].find((t) => t.split('*').length > 2)
    if (starred !== undefined) throw new Error(`tsconfig paths pattern '${starred}' has more than one '*' (${file})`)
  }
  const base = typeof baseUrl === 'string' ? baseUrl : pathsBasePath
  return {
    matchPaths(spec) {
      const match = bestKey(paths, spec, false)
      if (match === null) return []
      return paths[match.key].map((target) =>
        tsconfigPath(match.wildcard === null ? target : target.replace('*', match.wildcard), base, dirname(file)))
    },
  }
}

export function discoverTsconfig(baseDir, explicit, host = diskHost) {
  const p = resolvePath(baseDir, explicit)
  if (!isFile(p, host)) throw new Error(`tsconfig not found: ${explicit}`)
  return p
}

// A package.json with no name is a `type` marker: its files are the package's above.
const holdsNamedPackage = (dir, host) => isFile(join(dir, 'package.json'), host) && readManifest(join(dir, 'package.json'), host)?.name !== undefined
const declaresWorkspaces = (dir, host) => isFile(join(dir, 'pnpm-workspace.yaml'), host) || Boolean(readManifest(join(dir, 'package.json'), host)?.workspaces)

// The project is read up from `cwd` as the State reads it. In a monorepo a file's package is the nearest named one up
// to the workspace root (else the root); outside one, the nearest named one at or above `cwd` (else the top-most).
export function packageTsconfigPaths(cwd, { host = diskHost, lenient = false, projectCwd } = {}) {
  const stop = projectCwd ? realpathOr(resolvePath(projectCwd), host) : null
  const dirs = [] // real paths, as importers are read
  for (const dir of packageDirs(realpathOr(resolvePath(cwd), host))) {
    dirs.push(dir)
    if (dir === stop || host.stat(join(dir, '.git')) !== null || isFile(join(dir, 'pnpm-workspace.yaml'), host)) break
  }
  const workspaceRoot = dirs.find((dir) => declaresWorkspaces(dir, host)) ?? null
  const projectPackage = workspaceRoot === null
    ? dirs.find((dir) => holdsNamedPackage(dir, host)) ?? dirs.findLast((dir) => isFile(join(dir, 'package.json'), host)) ?? null
    : null
  // By real path: a linked workspace package takes its own config, so a relative `extends` resolves as tsc's does.
  const packageOf = (parentFile) => {
    if (workspaceRoot === null) return projectPackage
    return packageDirs(dirname(realpathOr(parentFile, host))).find((dir) => dir === workspaceRoot || holdsNamedPackage(dir, host)) ?? null
  }
  // A package's tsconfig.json is loaded once, for its `paths` and its outputs alike.
  const configs = tsconfigsOf(host, lenient)
  const matcherOf = memoized((dir) => {
    const options = configs(dir)
    return options === null ? null : leniently(lenient, () => pathsMatcher(options, join(dir, 'tsconfig.json')))
  })
  return {
    matchPaths(spec, parentFile) {
      const dir = packageOf(parentFile)
      return dir === null ? [] : (matcherOf(dir)?.matchPaths(spec) ?? [])
    },
    outputs: tsconfigOutputsOf({ host, configs }),
  }
}

// Specs Node resolves as a directory only, skipping LOAD_AS_FILE: '.', '..', a './..'-style tail, a trailing '/'.
const DIR_ONLY_SPEC = /(?:^|\/)\.{1,2}$|\/$/u
const IN_NODE_MODULES = /(?:^|[\\/])node_modules(?:[\\/]|$)/u

// By real path: workspace packages linked in through node_modules really lie outside it, so they keep the mapping.
export const inNodeModules = (file, host = diskHost) => IN_NODE_MODULES.test(realpathOr(file, host))
// `path` (null for none) where it lies outside node_modules, else null.
export const outsideNodeModules = (path, host) => (path == null || inNodeModules(path, host) ? null : path)

// A specifier naming a path: relative, as Node takes one, or absolute.
export const isPathRequest = (spec) => RELATIVE_REQUEST.test(spec) || isAbsolute(spec)

// Where a tsconfig `paths` alias points a bare specifier imported from outside node_modules.
export function typescriptAliasTargets(parentFile, spec, paths, host) {
  if (paths === null || isPathRequest(spec) || spec.startsWith('#') || inNodeModules(parentFile, host)) return []
  return paths.matchPaths(spec, parentFile)
}

// Always null from or into node_modules. `paths`: a tsconfig paths matcher, whose `outputs` map unbuilt outputs.
export function resolveTypescriptFallback(parentFile, spec, { conditions = new Set(), paths = null, host = diskHost } = {}) {
  if (inNodeModules(parentFile, host)) return null
  return outsideNodeModules(typescriptTarget(parentFile, spec, { conditions, paths, host }), host)
}

function typescriptTarget(parentFile, spec, { conditions, paths, host }) {
  const outputs = paths?.outputs ?? tsconfigOutputsOf({ host })
  if (spec.startsWith('#')) {
    const scope = nearestPackage(parentFile, host)
    return scope?.pkg.imports ? typescriptExportsTarget(scope.pkgDir, scope.pkg.imports, spec, { conditions, outputs, host }) : null
  }
  if (isPathRequest(spec)) {
    const base = isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec)
    return probeTypescriptTarget(base, { dirOnly: DIR_ONLY_SPEC.test(spec), outputs, host })
  }
  if (paths) {
    for (const target of paths.matchPaths(spec, parentFile)) {
      const hit = probeTypescriptTarget(target, { js: true, dirOnly: target.endsWith('/'), outputs, host })
      if (hit) return hit
    }
  }
  const loc = locatePackage(dirname(parentFile), spec, host)
  if (!loc) return null
  const pkg = readManifest(join(loc.pkgDir, 'package.json'), host) ?? {}
  if (pkg.exports != null) {
    return typescriptExportsTarget(loc.pkgDir, pkg.exports, loc.subpath === '' ? '.' : `./${loc.subpath}`, { conditions, outputs, host })
  }
  // A bare package root is LOAD_AS_DIRECTORY only (never `node_modules/dep.ts`).
  return probeTypescriptTarget(join(loc.pkgDir, loc.subpath), { dirOnly: loc.subpath === '' || DIR_ONLY_SPEC.test(spec), outputs, host })
}
