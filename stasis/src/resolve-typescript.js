import { basename, dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'

import { isTypeDeclaration, memoized, relativeEscapes } from '@exodus/stasis-core/util'
import { diskHost } from '@exodus/stasis-core/host'
import { hostMemo } from './vfs-bundle/lazy.js'

// tsc-style module resolution (`--typescript`), shared by scan.js's Node resolver and resolve-fields.js's
// field resolver: where normal resolution misses and tsc would land on an on-disk TypeScript source, the
// miss completes with that file, and a resolution that succeeded is never rewritten (an on-disk `.js`
// beats its `.ts` twin). tsc's rules: extension substitution (`./x.js` -> `./x.ts`: TS sources import
// each other by their output names) and extension/index completion, of a path and of a manifest's
// targets (`main`, `exports`, `imports`); an unbuilt output's source (fromOutputSource); and tsconfig
// `paths` aliases (loadTsconfigPaths), completed with the JS extensions too, as Node never probed them.
// It also homes the manifest helpers both resolvers share, importing from neither.

// tsc's extension substitution table: the JS output extensions mapped back to the TS source
// siblings that may sit on disk in their place. JS_OUTPUT_EXTS is derived, so the two cannot drift.
const TS_SIBLING_EXTS = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
])
const JS_OUTPUT_EXTS = new Set(TS_SIBLING_EXTS.keys())

// The TS source siblings of a name with a JS output extension (./x.js -> ./x.ts), else [] (extname sees
// none in a dotfile like './.js'). A declaration's spelling (./x.d.js -> ./x.d.ts) is among them: every
// probe site refuses one.
export function typescriptSiblings(name) {
  const ext = extname(name)
  const exts = TS_SIBLING_EXTS.get(ext)
  if (!exts) return []
  const stem = name.slice(0, -ext.length)
  return exts.map((e) => `${stem}${e}`)
}

// Extensions that never take the appended-`.ts` completion: JS outputs (substitution territory)
// and the extensions a resolver could already land on directly. Anything else (`./x.service`) is
// completed like an extensionless name, matching tsc's candidate list.
const NO_COMPLETION_EXTS = new Set([...JS_OUTPUT_EXTS, '.ts', '.tsx', '.mts', '.cts', '.json'])

// `path`'s real path, or `path` itself where it has none (not on disk).
function realpathOr(path, host) {
  try {
    return host.realpath(path)
  } catch {
    return path
  }
}

export function isFile(p, host = diskHost) {
  return host.stat(p)?.isFile() ?? false
}

export function isDir(p, host = diskHost) {
  return host.stat(p)?.isDirectory() ?? false
}

export function readJson(file, host = diskHost) {
  let text
  try {
    text = host.readFile(file).toString('utf8')
  } catch {
    return null // absent / unreadable -- no manifest here
  }
  // A manifest that EXISTS but is malformed must fail closed (Node throws rather than resolving past it).
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`Invalid package.json: ${file}`, { cause })
  }
}

// Nearest node_modules/<pkg> up from `fromDir` (handles @scope/name). Returns { pkgDir, subpath }
// (subpath '' = bare package import), or null if not installed up the tree.
export function locatePackage(fromDir, spec, host = diskHost) {
  const parts = spec.split('/')
  const pkgLen = spec.startsWith('@') ? 2 : 1
  if (parts.length < pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const pkgName = parts.slice(0, pkgLen).join('/')
  const subpath = parts.slice(pkgLen).join('/')
  for (let dir = fromDir; ; dir = dirname(dir)) {
    // Skip a dir literally named node_modules (basename, not endsWith — `my-node_modules` must not match).
    if (basename(dir) !== 'node_modules') {
      const pkgDir = join(dir, 'node_modules', pkgName)
      if (isDir(pkgDir, host)) return { pkgDir, subpath }
    }
    if (dirname(dir) === dir) return null
  }
}

// Nearest package.json at/above `file`'s dir — the package whose fields (browser/RN map, imports)
// govern the file's own imports. `read` reads a manifest, as readJson does.
export function nearestPackage(file, host = diskHost, read = readJson) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const pkgPath = join(dir, 'package.json')
    const pkg = isFile(pkgPath, host) ? read(pkgPath, host) : null
    if (pkg) return { pkgDir: dir, pkg }
    if (dirname(dir) === dir) return null
  }
}

// Whether `path` is a file a resolution may land on: on disk, and no type declaration (a `.d.ts` is
// types-only, erased at runtime -- tsc records it for types, never for emit).
export const isSourceFile = (path, host = diskHost) => !isTypeDeclaration(path) && isFile(path, host)
const firstSource = (candidates, host) => candidates.find((path) => isSourceFile(path, host)) ?? null

// The extensions tsc's completion appends, in its order (tryAddingExtensions): .ts, .tsx, then -- with
// `js`, for a path Node never probed (a tsconfig paths target) -- .js, .jsx. .d.ts (tsc's third) is
// never a target (isSourceFile).
const completionExts = (js) => (js ? ['.ts', '.tsx', '.js', '.jsx'] : ['.ts', '.tsx'])

// LOAD_INDEX with tsc's completions: dir/index.ts, dir/index.tsx (+ index.js/index.jsx with `js`).
// Without `js`, Node already probed the .js/.json indexes before the fallback ever runs.
const probeIndex = (dir, exts, host) => firstSource(exts.map((ext) => join(dir, `index${ext}`)), host)

// Probe an absolute `base` as tsc completes a missed path: the literal file (Node never probed a
// manifest's target), its TS siblings, the appended extensions, then with `dir`, a directory's `main`
// (as Node's LOAD_AS_DIRECTORY) and index. `dirOnly` skips the file rules ('.', '..', a trailing '/');
// `completion`/`dir` are off for exports/imports targets, which name exact files (tsc's node16 rules).
// `js`: see completionExts. `outputs` maps what still misses to an unbuilt output's source.
function probeTypescriptTarget(base, { js = false, dirOnly = false, completion = true, dir = true, outputs = null, host = diskHost } = {}) {
  const exts = completionExts(js)
  if (!dirOnly) {
    const completed = completion && !NO_COMPLETION_EXTS.has(extname(base)) ? exts.map((ext) => `${base}${ext}`) : []
    const hit = firstSource([base, ...typescriptSiblings(base), ...completed], host)
    if (hit) return hit
  }
  if (dir && isDir(base, host)) {
    const pkg = readJson(join(base, 'package.json'), host)
    const main = typeof pkg?.main === 'string' && pkg.main.length > 0 ? pkg.main : null
    if (main) {
      // LOAD_AS_FILE(main) with substitution/completion, then LOAD_INDEX(main), each of its source
      // too where it is unbuilt; a broken main falls through to the package index, like Node.
      const entry = resolvePath(base, main)
      const fromMain = (path) => probeTypescriptTarget(path, { js, dir: false, host }) ?? probeIndex(path, exts, host)
      const hit = fromMain(entry) ?? fromOutputSource(entry, fromMain, { outputs, host, pkgDir: base })
      if (hit) return hit
    }
    const hit = probeIndex(base, exts, host)
    if (hit) return hit
  }
  return fromOutputSource(base, (input) => probeTypescriptTarget(input, { js, dirOnly, completion, dir, host }), { outputs, host })
}

// --- tsc's `outDir` -> `rootDir` inversion ---

// A package's tsc layout, by the tsconfig.json beside its package.json; null without `outDir`
// (outputs then sit beside their sources, which substitution maps) or in node_modules (installed
// packages are used as published). Without `rootDir` the root is the tsconfig's directory, as
// TypeScript 6 takes it; an older tsc infers it from its inputs, which this cannot.
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

// tsconfigOutputs, cached as a lazy tree allows (untouchedMemo). `lenient` is for builds that only
// hint, where a tsconfig.json that does not load maps nothing rather than failing the build.
export function tsconfigOutputsOf({ host = diskHost, lenient = false } = {}) {
  const layouts = hostMemo(host)
  return (pkgDir) => {
    const dir = realpathOr(pkgDir, host)
    return layouts(dir, () => leniently(lenient, () => tsconfigOutputs(dir, host)))
  }
}

// The package whose tsc build `path` would be an output of: the nearest package.json beside a
// tsconfig.json, named or not. One without (a `type` marker, a manifest copied into `dist/` to
// publish from) builds nothing. An installed package is none.
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

// tsc's mapping of an output back to its input (tryLoadInputFileForPath): where `path` lies under its
// package's `outDir`, `probeSource` of the same place under `rootDir`, else null. Call it only once `path`
// missed: only then is the tsconfig.json read. `pkgDir`: the package naming `path`, whose `outDir` may lie outside it.
export function fromOutputSource(path, probeSource, { outputs, host = diskHost, pkgDir } = {}) {
  if (outputs == null) return null
  const owner = pkgDir ?? packageHolding(path, host)
  const layout = owner === null ? null : outputs(owner)
  if (layout === null) return null
  const rel = relative(layout.outDir, join(layout.dir, relative(owner, path))) // by the package's real path
  return relativeEscapes(rel) ? null : probeSource(join(layout.rootDir, rel))
}

// --- package `exports`/`imports` map resolution (candidate generation) ---

// Expand a target value (string | array | conditions object | null) to the target strings the
// active `conditions` select, wildcard-substituted. Mirrors Node's PACKAGE_TARGET_RESOLVE closely
// enough for fallback candidates: a conditions object commits to its FIRST matching key ('default'
// always matches); an array contributes its entries in order (the probe decides).
function expandTarget(value, wildcard, conditions) {
  if (typeof value === 'string') return [wildcard == null ? value : value.replaceAll('*', wildcard)]
  if (Array.isArray(value)) return value.flatMap((v) => expandTarget(v, wildcard, conditions))
  if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'default' || conditions.has(key)) return expandTarget(v, wildcard, conditions)
    }
  }
  return [] // null (an explicit block) or no matching condition
}

// The single-'*' key of `map` that `spec` matches with the longest prefix (with `longest`, then the
// longest key), the first of a tie: -> { key, wildcard } (what the '*' matched), or null.
function bestStarMatch(map, spec, { longest = false } = {}) {
  let best = null
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*')
    if (star === -1 || key.indexOf('*', star + 1) !== -1) continue
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue
    if (best === null || prefix.length > best.prefix.length
      || (longest && prefix.length === best.prefix.length && key.length > best.key.length)) {
      best = { key, prefix, suffix }
    }
  }
  return best && { key: best.key, wildcard: spec.slice(best.prefix.length, spec.length - best.suffix.length) }
}

// Resolve `key` through an exports/imports-shaped map: exact key first (a key containing '*' is
// never exact), else the best '*' pattern -- longest prefix, then longest key, exactly Node's
// PATTERN_KEY_COMPARE order -- with the matched wildcard substituted into the targets.
function resolveMapKey(map, key, conditions) {
  if (Object.hasOwn(map, key) && !key.includes('*')) return expandTarget(map[key], null, conditions)
  const match = bestStarMatch(map, key, { longest: true })
  return match === null ? [] : expandTarget(map[match.key], match.wildcard, conditions)
}

// A './' map target is only followed when it stays inside the package, like Node's
// PACKAGE_TARGET_RESOLVE invalid-target rules ('..' hops and node_modules re-entry are refused).
function validRelativeTarget(target) {
  return target.startsWith('./')
    && !target.split('/').some((seg) => seg === '..' || seg === 'node_modules')
}

// Candidate targets for `subpathKey` ('.', './sub', or '#name') through a package's exports or
// imports map. Exports sugar (a bare string/array/conditions object) is the '.' target.
function manifestTargets(map, subpathKey, conditions) {
  if (map == null) return []
  const sugar = typeof map !== 'object' || Array.isArray(map) || Object.keys(map).every((k) => !k.startsWith('.') && !k.startsWith('#'))
  if (sugar && subpathKey !== '.') return []
  return resolveMapKey(sugar ? { '.': map } : map, subpathKey, conditions).filter(validRelativeTarget)
}

// tsc's mapping of `key` ('.' or './sub') through the `exports` of the package in `pkgDir` (or of
// a '#name' key through its `imports`): the targets `conditions` select, substitution only (Node
// requires exports/imports targets to name exact files) or an unbuilt output's source (`outputs`);
// the first on disk, or null.
export function typescriptExportsTarget(pkgDir, exports, key, { conditions = new Set(), outputs = (dir) => tsconfigOutputs(dir, host), host = diskHost } = {}) {
  const probeTarget = (path) => probeTypescriptTarget(path, { completion: false, dir: false, host })
  for (const target of manifestTargets(exports, key, conditions)) {
    const base = resolvePath(pkgDir, target)
    const hit = probeTarget(base) ?? fromOutputSource(base, probeTarget, { outputs, host, pkgDir })
    if (hit) return hit
  }
  return null
}

// --- tsconfig `compilerOptions.paths` ---

// tsconfig.json is JSONC: strip // and /* */ comments and trailing commas (never inside string
// literals), then JSON.parse. A config that exists but does not parse must fail closed.
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
    if (c === ',') {
      pendingComma = out.length
    } else if (c === '}' || c === ']') {
      if (pendingComma !== -1) out = `${out.slice(0, pendingComma)}${out.slice(pendingComma + 1)}`
      pendingComma = -1
    } else if (pendingComma !== -1 && !/\s/u.test(c)) {
      pendingComma = -1
    }
    out += c
  }
  try {
    return JSON.parse(out)
  } catch (cause) {
    throw new Error(`Invalid tsconfig: ${file}`, { cause })
  }
}

// Resolve an `extends` target like tsc: relative/absolute against the extending file (with the
// implied .json), bare through node_modules (the spelled path, its .json twin, or the package's
// tsconfig.json). A named base that cannot be found fails closed -- its options are load-bearing.
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

// The configs a tsconfig's `extends` chain reads, as { file, raw }: each base, in the order `extends`
// names them, before the config extending it, and `file` last (a shared base under each, so folding the
// list in order is tsc's nested merge). As tsc's, the cycle check is per branch (`extending`).
function* tsconfigChain(file, host, extending = new Set()) {
  if (extending.has(file)) throw new Error(`tsconfig extends cycle at ${file}`)
  const raw = parseJsonc(host.readFile(file).toString('utf8'), file)
  extending.add(file)
  for (const base of [].concat(raw?.extends ?? [])) yield* tsconfigChain(resolveExtendsTarget(file, base, host), host, extending)
  extending.delete(file)
  yield { file, raw }
}

// tsc's path-valued compilerOptions (a list's element by element), each made absolute against the
// dir of the config declaring it, or, when it starts with `${configDir}`, against the loaded one's.
const TSCONFIG_PATH_OPTIONS = new Set(['baseUrl', 'declarationDir', 'generateCpuProfile', 'generateTrace', 'outDir', 'outFile', 'rootDir', 'tsBuildInfoFile'])
const TSCONFIG_PATH_LIST_OPTIONS = new Set(['rootDirs', 'typeRoots'])
const CONFIG_DIR = '${configDir}'
const tsconfigPath = (value, dir, configDir) => {
  if (typeof value !== 'string') return value
  return value.startsWith(CONFIG_DIR) ? resolvePath(configDir, value.replace(CONFIG_DIR, './')) : resolvePath(dir, value)
}

// The `compilerOptions` a tsconfig resolves to across its `extends` chain, merged one level deep
// as tsc merges them: each base in order, the extending file's own over them (`null` unsetting an
// option), each path-valued option absolute, and `paths` as declared, with tsc's `pathsBasePath`,
// the dir of the config declaring it.
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

// A tsconfig's `compilerOptions.paths` (following `extends`) as a matcher, or null for no `file` or no
// paths. matchPaths(spec): the targets of the one best key (exact, else the '*' pattern with the longest
// prefix; tsc tries no other when they miss), against `baseUrl`, else the declaring config's dir (or
// `file`'s, for `${configDir}`). A malformed shape fails closed, as tsc's config errors do.
export function loadTsconfigPaths(file, host = diskHost) {
  if (file == null) return null
  const { paths, pathsBasePath, baseUrl } = loadTsconfigCompilerOptions(file, host)
  if (paths == null || typeof paths !== 'object' || Object.keys(paths).length === 0) return null
  const starCount = (s) => s.split('*').length - 1
  for (const [key, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || targets.some((t) => typeof t !== 'string')) {
      throw new Error(`tsconfig paths['${key}'] must be an array of strings (${file})`)
    }
    for (const t of [key, ...targets]) {
      if (starCount(t) > 1) throw new Error(`tsconfig paths pattern '${t}' has more than one '*' (${file})`)
    }
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

// The tsconfig an explicit `--tsconfig` names, resolved against `baseDir`; it must exist (fail
// closed on a typo). Without one, each package's own applies (packageTsconfigPaths).
export function discoverTsconfig(baseDir, explicit, host = diskHost) {
  const p = resolvePath(baseDir, explicit)
  if (!isFile(p, host)) throw new Error(`tsconfig not found: ${explicit}`)
  return p
}

// Whether `dir` holds a package: a package.json naming one. One with no name is a `type` marker,
// its files the package's above (as vfs-bundle's holdsPackage reads it).
const holdsNamedPackage = (dir, host) => isFile(join(dir, 'package.json'), host) && readJson(join(dir, 'package.json'), host)?.name !== undefined

// Whether `dir` declares a monorepo's workspaces: a pnpm-workspace.yaml, or a package.json
// `workspaces` (npm's and yarn's).
const declaresWorkspaces = (dir, host) => isFile(join(dir, 'pnpm-workspace.yaml'), host) || Boolean(readJson(join(dir, 'package.json'), host)?.workspaces)

// The `paths` --typescript honours without --tsconfig: those of the tsconfig.json of the package the
// importing file is in (matchPaths(spec, parentFile)). The project is read up from `cwd` as the State
// reads it, up to .git, pnpm-workspace.yaml or `projectCwd`. In a monorepo (one declaring workspaces) a
// file's package is the nearest named package.json up to the workspace root (else the root); outside one,
// the nearest named one at or above `cwd` (else the top-most). Never in node_modules. Each config loads
// once; with `lenient`, one that doesn't load matches nothing.
export function packageTsconfigPaths(cwd, { host = diskHost, lenient = false, projectCwd } = {}) {
  const stop = projectCwd ? realpathOr(resolvePath(projectCwd), host) : null
  const dirs = [] // cwd and above, while the State's walk would go on; real paths, as importers are read
  for (let dir = realpathOr(resolvePath(cwd), host); basename(dir) !== 'node_modules'; dir = dirname(dir)) {
    dirs.push(dir)
    if (dir === stop) break
    if (host.stat(join(dir, '.git')) !== null || isFile(join(dir, 'pnpm-workspace.yaml'), host)) break
    if (dirname(dir) === dir) break
  }
  const workspaceRoot = dirs.find((dir) => declaresWorkspaces(dir, host)) ?? null
  const projectPackage = workspaceRoot === null
    ? dirs.find((dir) => holdsNamedPackage(dir, host)) ?? dirs.findLast((dir) => isFile(join(dir, 'package.json'), host)) ?? null
    : null
  // The package directory `parentFile` is in, or null outside the workspace root. By its real path,
  // as inNodeModules reads it: a linked workspace package reached through node_modules takes its
  // own config, read where it lies, so a relative `extends` resolves as tsc resolves it.
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

// --- the fallback dispatcher ---

// Specs Node resolves as a directory only ('.', '..', a './..'-style tail, a trailing '/'):
// the file rules are skipped for them, exactly as Node skips LOAD_AS_FILE.
const DIR_ONLY_SPEC = /(?:^|\/)\.{1,2}$|\/$/u

// A node_modules path segment, the last one included (the directory itself).
const IN_NODE_MODULES = /(?:^|[\\/])node_modules(?:[\\/]|$)/u

// Whether `file` lies in node_modules, by its real path where it has one (by its own, where it
// doesn't): --typescript maps nothing from or into an installed package. A monorepo's workspace
// packages, linked in through node_modules, really lie outside it, so they keep the mapping.
export const inNodeModules = (file, host = diskHost) => IN_NODE_MODULES.test(realpathOr(file, host))

// Resolve `spec` from `parentFile` as tsc would complete a resolution Node (or the field resolver)
// missed: the absolute path of the on-disk source, or null (always, from or into node_modules).
// `conditions` gates exports/imports maps; `paths` is a tsconfig paths matcher, or null. A '#name' takes
// the parent package's `imports` targets; a path, its substitution/completion (+ a directory's main/index);
// a bare spec, `paths` aliases first, then the named package's `exports` targets, else its main/index or
// subpath. An unbuilt output maps to its source (by `paths.outputs` where given).
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
  const pkg = readJson(join(loc.pkgDir, 'package.json'), host) ?? {}
  if (pkg.exports != null) {
    // `exports` fully governs a bare import (main is not a fallback); targets name exact files.
    return typescriptExportsTarget(loc.pkgDir, pkg.exports, loc.subpath === '' ? '.' : `./${loc.subpath}`, { conditions, outputs, host })
  }
  if (loc.subpath === '') {
    // Bare package root: LOAD_AS_DIRECTORY only (never `node_modules/dep.ts`).
    return probeTypescriptTarget(loc.pkgDir, { dirOnly: true, outputs, host })
  }
  return probeTypescriptTarget(join(loc.pkgDir, loc.subpath), { dirOnly: DIR_ONLY_SPEC.test(spec), outputs, host })
}
