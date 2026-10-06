import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'

import { isTypeDeclaration } from '@exodus/stasis-core/util'
import { diskHost } from '@exodus/stasis-core/host'

// tsc-style module resolution (`--typescript`), shared by BOTH JS resolvers -- scan.js's built-in
// Node resolver and resolve-fields.js's legacy-field resolver -- so the flag means one thing
// everywhere: when normal resolution misses and tsc would land on an on-disk TypeScript source,
// complete the miss with that file. It never rewrites a resolution that succeeded, so an on-disk
// `.js` always beats its `.ts` twin. The rules, in the shapes they apply to:
//   - extension substitution: `./x.js` -> `./x.ts` (`.jsx` -> `.tsx`, `.mjs` -> `.mts`,
//     `.cjs` -> `.cts`) -- tsc never rewrites specifiers, so TS sources import each other by their
//     OUTPUT names, and the specifier names a file that only exists as its TS source;
//   - extension/index completion for an extensionless path (`./util` -> `./util.ts`,
//     `./dir` -> `./dir/index.ts`), incl. through a directory's package.json `main`;
//   - the same substitution applied to manifest-declared targets: a package `main`, an `exports`
//     target, a `#name` `imports` target naming a compiled file whose only on-disk form is TS;
//   - tsconfig `compilerOptions.paths` aliases (see loadTsconfigPaths), consulted for bare
//     specifiers nothing else resolved. Node never probed an alias target, so its completion also
//     tries the JS extensions after the TS ones (`@/x` -> x.ts, then x.js), as tsc does.
// This module also homes the generic manifest helpers (readJson/locatePackage/nearestPackage)
// both resolvers share -- it is the dependency-free lower layer, importing from neither.

// tsc's extension substitution table: the JS output extensions mapped back to the TS source
// siblings that may sit on disk in their place. JS_OUTPUT_EXTS is derived, so the two cannot drift.
const TS_SIBLING_EXTS = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
])
const JS_OUTPUT_EXTS = new Set(TS_SIBLING_EXTS.keys())

// The TS source siblings of a path/specifier naming a JS output extension (./x.js -> ./x.ts).
// Returns [] for a non-substitutable name (extensionless, already-TS, .json, unknown, dotfile --
// extname sees no extension in './.js', matching the extensionless gates downstream). Candidates
// spelling a type declaration (./x.d.js -> ./x.d.ts) are returned too: every probe site refuses
// declarations (types-only, erased at runtime), so the screen lives at probe time, once.
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
  let dir = fromDir
  while (true) {
    // Skip a dir literally named node_modules (basename, not endsWith — `my-node_modules` must not match).
    if (basename(dir) !== 'node_modules') {
      const pkgDir = join(dir, 'node_modules', pkgName)
      if (isDir(pkgDir, host)) return { pkgDir, subpath }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// Nearest package.json at/above `file`'s dir — the package whose fields (browser/RN map, imports)
// govern the file's own imports.
export function nearestPackage(file, host = diskHost) {
  let dir = dirname(file)
  while (true) {
    const pkgPath = join(dir, 'package.json')
    if (isFile(pkgPath, host)) {
      const pkg = readJson(pkgPath, host)
      if (pkg) return { pkgDir: dir, pkg }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// A probe candidate is a target only if it names a real file that is not a type declaration
// (a `.d.ts` is types-only, erased at runtime -- tsc records it for types, never for emit).
const probe = (p, host) => (!isTypeDeclaration(p) && isFile(p, host) ? p : null)

// The extensions tsc's completion appends, in its order (tryAddingExtensions): .ts, .tsx, then --
// with `js`, for a path Node never probed (a tsconfig paths target) -- .js, .jsx. A path Node
// already completed needs only the TS ones. .d.ts (tsc's third) is never a target (see probe).
const completionExts = (js) => (js ? ['.ts', '.tsx', '.js', '.jsx'] : ['.ts', '.tsx'])

// LOAD_INDEX with tsc's completions: dir/index.ts, dir/index.tsx (+ index.js/index.jsx with `js`).
// Without `js`, Node already probed the .js/.json indexes before the fallback ever runs.
function probeIndex(dir, exts, host) {
  for (const ext of exts) {
    const hit = probe(join(dir, `index${ext}`), host)
    if (hit) return hit
  }
  return null
}

// Probe an absolute `base` the way tsc completes a missed path: the literal file (manifest-declared
// targets are never probed by Node, so a paths/main target can hit literally), its TS siblings,
// the appended-extension completion, and -- when `dir` allows and `base` is a directory -- the
// directory's package.json `main` (substituted + completed like any path, mirroring Node's
// LOAD_AS_DIRECTORY) then its index. `dirOnly` skips the file rules for specs Node treats as
// directory-only ('.', '..', a trailing '/'), so './' never probes the pathological '.ts' dotfile.
// `completion`/`dir` are off for exports/imports targets: Node requires those to name exact files,
// so only substitution applies (matching tsc's node16 rules). `js` completes JS extensions too, for
// a base Node never probed (see completionExts).
function probeTypescriptTarget(base, { js = false, dirOnly = false, completion = true, dir = true, host = diskHost } = {}) {
  const exts = completionExts(js)
  if (!dirOnly) {
    const literal = probe(base, host)
    if (literal) return literal
    for (const cand of typescriptSiblings(base)) {
      const hit = probe(cand, host)
      if (hit) return hit
    }
    if (completion && !NO_COMPLETION_EXTS.has(extname(base))) {
      for (const ext of exts) {
        const hit = probe(`${base}${ext}`, host)
        if (hit) return hit
      }
    }
  }
  if (dir && isDir(base, host)) {
    const pkg = readJson(join(base, 'package.json'), host)
    const main = typeof pkg?.main === 'string' && pkg.main.length > 0 ? pkg.main : null
    if (main) {
      // LOAD_AS_FILE(main) with substitution/completion, then LOAD_INDEX(main); a broken main
      // falls through to the package index, like Node.
      const entry = resolvePath(base, main)
      const hit = probeTypescriptTarget(entry, { js, dir: false, host }) ?? probeIndex(entry, exts, host)
      if (hit) return hit
    }
    return probeIndex(base, exts, host)
  }
  return null
}

// --- package `exports`/`imports` map resolution (candidate generation) ---

// Expand a target value (string | array | conditions object | null) to the target strings the
// active `conditions` select, wildcard-substituted. Mirrors Node's PACKAGE_TARGET_RESOLVE closely
// enough for fallback candidates: a conditions object commits to its FIRST matching key ('default'
// always matches); an array contributes its entries in order (the probe decides).
function expandTarget(value, wildcard, conditions) {
  if (typeof value === 'string') {
    return [wildcard == null ? value : value.replaceAll('*', wildcard)]
  }
  if (Array.isArray(value)) {
    return value.flatMap((v) => expandTarget(v, wildcard, conditions))
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key === 'default' || conditions.has(key)) return expandTarget(v, wildcard, conditions)
    }
  }
  return [] // null (an explicit block) or no matching condition
}

// Resolve `key` through an exports/imports-shaped map: exact key first (a key containing '*' is
// never exact), else the best '*' pattern -- longest prefix, then longest key, exactly Node's
// PATTERN_KEY_COMPARE order -- with the matched wildcard substituted into the targets.
function resolveMapKey(map, key, conditions) {
  if (Object.hasOwn(map, key) && !key.includes('*')) return expandTarget(map[key], null, conditions)
  let best = null
  for (const pattern of Object.keys(map)) {
    const star = pattern.indexOf('*')
    if (star === -1 || pattern.indexOf('*', star + 1) !== -1) continue
    const prefix = pattern.slice(0, star)
    const suffix = pattern.slice(star + 1)
    if (key.length < prefix.length + suffix.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue
    if (best === null || prefix.length > best.prefix.length
      || (prefix.length === best.prefix.length && pattern.length > best.pattern.length)) {
      best = { pattern, prefix, suffix }
    }
  }
  if (!best) return []
  const wildcard = key.slice(best.prefix.length, key.length - best.suffix.length)
  return expandTarget(map[best.pattern], wildcard, conditions)
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
  let byKey = map
  if (typeof map !== 'object' || Array.isArray(map)
    || Object.keys(map).every((k) => !k.startsWith('.') && !k.startsWith('#'))) {
    if (subpathKey !== '.') return []
    byKey = { '.': map }
  }
  return resolveMapKey(byKey, subpathKey, conditions).filter((t) => validRelativeTarget(t))
}

// tsc's mapping of `key` ('.' or './sub') through the `exports` of the package in `pkgDir` (or of
// a '#name' key through its `imports`): the targets `conditions` select, substitution only (Node
// requires exports/imports targets to name exact files), the first on disk; or null.
export function typescriptExportsTarget(pkgDir, exports, key, { conditions = new Set(), host = diskHost } = {}) {
  for (const target of manifestTargets(exports, key, conditions)) {
    const hit = probeTypescriptTarget(resolvePath(pkgDir, target), { completion: false, dir: false, host })
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

// The configs a tsconfig's `extends` chain reads, as { file, raw }: each base (in the order
// `extends` names them) before the config extending it, and `file` last. A base two configs share
// is listed under each, so folding the list in order, later over earlier, is tsc's nested merge,
// where the second extender's resolved options carry the shared base's again. Like tsc's, the
// cycle check is per branch: `extending` holds the configs extending `file`, and only a config that
// extends itself, directly or not, throws.
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

// Load a tsconfig's `compilerOptions.paths` into a matcher, following `extends`. Returns null when
// `file` is null or the effective config declares no paths. matchPaths(spec) returns the absolute
// substituted targets of the BEST-matching key -- exact match first, else the '*' pattern with the
// longest matched prefix, exactly one key, its targets in order (tsc tries no other key when they
// all miss) -- resolved against `baseUrl`, or against the declaring config's dir without one
// (TS 4.1 paths-without-baseUrl), or, starting with `${configDir}`, against `file`'s. Only
// `baseUrl`/`paths` are used; malformed shapes (a non-array value, more than one '*' in a key or
// target) fail closed like tsc's config errors.
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
      let targets = null
      if (Object.hasOwn(paths, spec) && !spec.includes('*')) {
        targets = paths[spec].map((t) => ({ target: t, wildcard: null }))
      } else {
        let best = null
        for (const key of Object.keys(paths)) {
          const star = key.indexOf('*')
          if (star === -1) continue
          const prefix = key.slice(0, star)
          const suffix = key.slice(star + 1)
          if (spec.length < prefix.length + suffix.length || !spec.startsWith(prefix) || !spec.endsWith(suffix)) continue
          if (best === null || prefix.length > best.prefix.length) best = { key, prefix, suffix }
        }
        if (!best) return []
        const wildcard = spec.slice(best.prefix.length, spec.length - best.suffix.length)
        targets = paths[best.key].map((t) => ({ target: t, wildcard }))
      }
      return targets.map(({ target, wildcard }) =>
        tsconfigPath(wildcard == null ? target : target.replace('*', wildcard), base, dirname(file)))
    },
  }
}

// The tsconfig `--typescript` reads: an explicit `--tsconfig` path must exist (fail closed on a
// typo); with none given, the project root's tsconfig.json applies when present, like tsc's own
// discovery from a directory.
export function discoverTsconfig(baseDir, explicit, host = diskHost) {
  if (explicit != null) {
    const p = resolvePath(baseDir, explicit)
    if (!isFile(p, host)) throw new Error(`tsconfig not found: ${explicit}`)
    return p
  }
  const p = join(baseDir, 'tsconfig.json')
  return isFile(p, host) ? p : null
}

// --- the fallback dispatcher ---

// Specs Node resolves as a directory only ('.', '..', a './..'-style tail, a trailing '/'):
// the file rules are skipped for them, exactly as Node skips LOAD_AS_FILE.
const DIR_ONLY_SPEC = /(?:^|\/)\.{1,2}$|\/$/u

// tsconfig paths map first-party aliases; a dependency's own bare imports must never be hijacked
// by the app's aliases (tsc doesn't resolve node_modules files' imports through the app config).
const IN_NODE_MODULES = /(?:^|[\\/])node_modules[\\/]/u

// Resolve `spec` from `parentFile` the way tsc would complete a resolution BOTH Node and the
// legacy-field resolver missed. Returns the absolute path of the on-disk source, or null.
// `conditions` gates exports/imports maps (same set the failed resolution used); `paths` is a
// loadTsconfigPaths matcher (or null). Dispatch by shape:
//   '#name'        -> the parent package's `imports` targets, substitution only;
//   relative/abs   -> path substitution/completion (+ directory main/index);
//   bare           -> tsconfig paths aliases first (tsc consults them before node_modules; JS
//                     completion too, as Node never probed the target), then
//                     the named package: its `exports` targets (substitution only) when it has
//                     them, else its `main`/index (bare root) or subpath (substitution/completion).
export function resolveTypescriptFallback(parentFile, spec, { conditions = new Set(), paths = null, host = diskHost } = {}) {
  if (spec.startsWith('#')) {
    const scope = nearestPackage(parentFile, host)
    return scope?.pkg.imports ? typescriptExportsTarget(scope.pkgDir, scope.pkg.imports, spec, { conditions, host }) : null
  }
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..' || isAbsolute(spec)) {
    const base = isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec)
    return probeTypescriptTarget(base, { dirOnly: DIR_ONLY_SPEC.test(spec), host })
  }
  if (paths && !IN_NODE_MODULES.test(parentFile)) {
    for (const target of paths.matchPaths(spec)) {
      const hit = probeTypescriptTarget(target, { js: true, dirOnly: target.endsWith('/'), host })
      if (hit) return hit
    }
  }
  const loc = locatePackage(dirname(parentFile), spec, host)
  if (!loc) return null
  const pkg = readJson(join(loc.pkgDir, 'package.json'), host) ?? {}
  if (pkg.exports != null) {
    // `exports` fully governs a bare import (main is not a fallback); targets name exact files.
    return typescriptExportsTarget(loc.pkgDir, pkg.exports, loc.subpath === '' ? '.' : `./${loc.subpath}`, { conditions, host })
  }
  if (loc.subpath === '') {
    // Bare package root: LOAD_AS_DIRECTORY only (never `node_modules/dep.ts`).
    return probeTypescriptTarget(loc.pkgDir, { dirOnly: true, host })
  }
  return probeTypescriptTarget(join(loc.pkgDir, loc.subpath), { dirOnly: DIR_ONLY_SPEC.test(spec), host })
}
