import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'

import { isTypeDeclaration, memoized, relativeEscapes } from '@exodus/stasis-core/util'
import { diskHost } from '@exodus/stasis-core/host'
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

function realpathOr(path, host) {
  try {
    return host.realpath(path)
  } catch {
    return path
  }
}

export const isFile = (p, host = diskHost) => host.stat(p)?.isFile() ?? false
export const isDir = (p, host = diskHost) => host.stat(p)?.isDirectory() ?? false

export function readManifest(file, host = diskHost) {
  let text
  try {
    text = host.readFile(file).toString('utf8')
  } catch {
    return null
  }
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

// A `.d.ts` is types-only, erased at runtime: no resolution lands on one.
export const isSourceFile = (path, host = diskHost) => !isTypeDeclaration(path) && isFile(path, host)
const firstSource = (candidates, host) => candidates.find((path) => isSourceFile(path, host)) ?? null

// tsc's tryAddingExtensions order; `.js`/`.jsx` only with `js`, for a path Node never probed (a tsconfig paths target).
const completionExts = (js) => (js ? ['.ts', '.tsx', '.js', '.jsx'] : ['.ts', '.tsx'])

const probeIndex = (dir, exts, host) => firstSource(exts.map((ext) => join(dir, `index${ext}`)), host)

// `dirOnly` skips the file rules ('.', '..', a trailing '/'). Exports and imports targets name exact files, so they
// take neither `completion` nor `dir`.
function probeTypescriptTarget(base, { js = false, dirOnly = false, completion = true, dir = true, outputs = null, host = diskHost } = {}) {
  const exts = completionExts(js)
  if (!dirOnly) {
    const completed = completion && !NO_COMPLETION_EXTS.has(extname(base)) ? exts.map((ext) => `${base}${ext}`) : []
    const hit = firstSource([base, ...typescriptSiblings(base), ...completed], host)
    if (hit) return hit
  }
  if (dir && isDir(base, host)) {
    const pkg = readManifest(join(base, 'package.json'), host)
    if (typeof pkg?.main === 'string' && pkg.main.length > 0) {
      // A broken main falls through to the package index, like Node.
      const entry = resolvePath(base, pkg.main)
      const fromMain = (path) => probeTypescriptTarget(path, { js, dir: false, host }) ?? probeIndex(path, exts, host)
      const hit = fromMain(entry) ?? fromOutputSource(entry, fromMain, { outputs, host, pkgDir: base })
      if (hit) return hit
    }
    const hit = probeIndex(base, exts, host)
    if (hit) return hit
  }
  return fromOutputSource(base, (input) => probeTypescriptTarget(input, { js, dirOnly, completion, dir, host }), { outputs, host })
}

// Without `rootDir` the root is the tsconfig's dir, as TypeScript 6 takes it (an older tsc infers it from its inputs).
export function tsconfigOutputs(pkgDir, host = diskHost) {
  const dir = realpathOr(pkgDir, host)
  if (IN_NODE_MODULES.test(dir)) return null
  const file = join(dir, 'tsconfig.json')
  if (!isFile(file, host)) return null
  const { outDir, rootDir } = loadTsconfigCompilerOptions(file, host)
  if (typeof outDir !== 'string') return null
  return { dir, outDir, rootDir: typeof rootDir === 'string' ? rootDir : dir }
}

function leniently(lenient, read) {
  try {
    return read()
  } catch (error) {
    if (!lenient) throw error
    return null
  }
}

// `lenient` is for builds that only hint: a tsconfig.json that doesn't load maps nothing rather than failing them.
export function tsconfigOutputsOf({ host = diskHost, lenient = false } = {}) {
  const layouts = hostMemo(host)
  return (pkgDir) => {
    const dir = realpathOr(pkgDir, host)
    return layouts(dir, () => leniently(lenient, () => tsconfigOutputs(dir, host)))
  }
}

// A package.json with no tsconfig.json beside it builds nothing (a `type` marker, a manifest copied into `dist/`).
function packageHolding(path, host) {
  for (let dir = dirname(path); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
    if (isFile(join(dir, 'package.json'), host)) {
      if (inNodeModules(dir, host)) return null
      if (isFile(join(dir, 'tsconfig.json'), host)) return dir
    }
    if (dirname(dir) === dir) return null
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

// The longest prefix wins (with `longest`, then the longest key), the first of a tie.
function bestStarMatch(map, spec, { longest = false } = {}) {
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

// Exact key first (never one with a '*'), else the best pattern, in Node's PATTERN_KEY_COMPARE order.
function resolveMapKey(map, key, conditions) {
  if (Object.hasOwn(map, key) && !key.includes('*')) return expandTarget(map[key], null, conditions)
  const match = bestStarMatch(map, key, { longest: true })
  return match === null ? [] : expandTarget(map[match.key], match.wildcard, conditions)
}

// Node's PACKAGE_TARGET_RESOLVE refuses a target leaving the package ('..' hops and node_modules re-entry).
const validRelativeTarget = (target) => target.startsWith('./') && !target.split('/').some((seg) => seg === '..' || seg === 'node_modules')

// Exports sugar (a bare string, array or conditions object) is the '.' target.
function manifestTargets(map, subpathKey, conditions) {
  if (map == null) return []
  const sugar = typeof map !== 'object' || Array.isArray(map) || Object.keys(map).every((k) => !k.startsWith('.') && !k.startsWith('#'))
  if (sugar && subpathKey !== '.') return []
  return resolveMapKey(sugar ? { '.': map } : map, subpathKey, conditions).filter(validRelativeTarget)
}

// `key`: '.', './sub' or '#name'. Substitution only, as Node requires exports and imports targets to name exact files.
export function typescriptExportsTarget(pkgDir, exports, key, { conditions = new Set(), outputs = (dir) => tsconfigOutputs(dir, host), host = diskHost } = {}) {
  const probeTarget = (path) => probeTypescriptTarget(path, { completion: false, dir: false, host })
  for (const target of manifestTargets(exports, key, conditions)) {
    const base = resolvePath(pkgDir, target)
    const hit = probeTarget(base) ?? fromOutputSource(base, probeTarget, { outputs, host, pkgDir })
    if (hit) return hit
  }
  return null
}

// tsconfig.json is JSONC. A config that exists but does not parse fails closed.
function parseJsonc(text, file) {
  if (text.charCodeAt(0) === 0xFE_FF) text = text.slice(1) // BOM
  let out = ''
  let pendingComma = -1 // index in `out` of a comma that may turn out to be trailing
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
      pendingComma = -1
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = (nl === -1 ? text.length : nl) - 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if ((c === '}' || c === ']') && pendingComma !== -1) out = `${out.slice(0, pendingComma)}${out.slice(pendingComma + 1)}`
    if (c === ',') pendingComma = out.length
    else if (!/\s/u.test(c)) pendingComma = -1
    out += c
  }
  try {
    return JSON.parse(out)
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

// Only the one best key's targets: tsc tries no other when they miss. A malformed shape fails closed.
export function loadTsconfigPaths(file, host = diskHost) {
  if (file == null) return null
  const { paths, pathsBasePath, baseUrl } = loadTsconfigCompilerOptions(file, host)
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
      const exact = Object.hasOwn(paths, spec) && !spec.includes('*')
      const match = exact ? { key: spec, wildcard: null } : bestStarMatch(paths, spec)
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
  for (let dir = realpathOr(resolvePath(cwd), host); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
    dirs.push(dir)
    if (dir === stop || host.stat(join(dir, '.git')) !== null || isFile(join(dir, 'pnpm-workspace.yaml'), host)) break
    if (dirname(dir) === dir) break
  }
  const workspaceRoot = dirs.find((dir) => declaresWorkspaces(dir, host)) ?? null
  const projectPackage = workspaceRoot === null
    ? dirs.find((dir) => holdsNamedPackage(dir, host)) ?? dirs.findLast((dir) => isFile(join(dir, 'package.json'), host)) ?? null
    : null
  // By real path: a linked workspace package takes its own config, so a relative `extends` resolves as tsc's does.
  const packageOf = (parentFile) => {
    if (workspaceRoot === null) return projectPackage
    for (let dir = dirname(realpathOr(parentFile, host)); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
      if (dir === workspaceRoot || holdsNamedPackage(dir, host)) return dir
      if (dirname(dir) === dir) return null
    }
    return null
  }
  const matcherOf = memoized((dir) => {
    const file = join(dir, 'tsconfig.json')
    return isFile(file, host) ? leniently(lenient, () => loadTsconfigPaths(file, host)) : null
  })
  return {
    matchPaths(spec, parentFile) {
      const dir = packageOf(parentFile)
      return dir === null ? [] : (matcherOf(dir)?.matchPaths(spec) ?? [])
    },
    outputs: tsconfigOutputsOf({ host, lenient }),
  }
}

// Specs Node resolves as a directory only, skipping LOAD_AS_FILE: '.', '..', a './..'-style tail, a trailing '/'.
const DIR_ONLY_SPEC = /(?:^|\/)\.{1,2}$|\/$/u
const IN_NODE_MODULES = /(?:^|[\\/])node_modules(?:[\\/]|$)/u

// By real path: workspace packages linked in through node_modules really lie outside it, so they keep the mapping.
export const inNodeModules = (file, host = diskHost) => IN_NODE_MODULES.test(realpathOr(file, host))

// Always null from or into node_modules. `paths`: a tsconfig paths matcher, whose `outputs` map unbuilt outputs.
export function resolveTypescriptFallback(parentFile, spec, { conditions = new Set(), paths = null, host = diskHost } = {}) {
  if (inNodeModules(parentFile, host)) return null
  const hit = typescriptTarget(parentFile, spec, { conditions, paths, host })
  return hit == null || inNodeModules(hit, host) ? null : hit
}

function typescriptTarget(parentFile, spec, { conditions, paths, host }) {
  const outputs = paths?.outputs ?? ((dir) => tsconfigOutputs(dir, host))
  if (spec.startsWith('#')) {
    const scope = nearestPackage(parentFile, host)
    return scope?.pkg.imports ? typescriptExportsTarget(scope.pkgDir, scope.pkg.imports, spec, { conditions, outputs, host }) : null
  }
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..' || isAbsolute(spec)) {
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
