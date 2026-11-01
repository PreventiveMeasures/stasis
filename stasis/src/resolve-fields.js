import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isAssetFile } from '@preventive/rn/metro-assets.js'
import { createMetroResolver, defaults as metroDefaults } from '@preventive/rn/metro-resolver.js'
import { isTypeDeclaration, stripTypeDeclaration, toPosix } from '@exodus/stasis-core/util'
import {
  fromOutputSource,
  inNodeModules,
  isDir,
  isFile,
  locatePackage,
  nearestPackage,
  readJson,
  resolveTypescriptFallback,
  tsconfigOutputsOf,
  typescriptSiblings,
} from './resolve-typescript.js'
import { diskHost } from '@exodus/stasis-core/host'
import { metroHost, scanResolution } from './metro-resolver.js'
import { createNodeResolver } from './resolve-node.js'
import { untouchedMemo } from './vfs-bundle/lazy.js'

// Static module resolver for legacy package fields (`react-native`/`browser`/`main` + browser-spec
// redirect maps) and platform suffixes (`.ios`/`.android`/`.native`), reproducing Metro/React-Native
// resolution that Node's own resolver (used by scan.js) can't. `exports`-bearing packages are
// delegated to Node's algorithm, under a bundler's conditions rather than Node's (see
// resolveConditions). Under `metro`, Metro's own resolution instead: metro-resolver's steps, as
// @preventive/rn takes them (viaMetro).
// No user code is executed (only package.json is stat/read).
//
// Returns, for each specifier:
//   { url }      resolved to a file, by its real path (file: URL string; see fileResolution)
//   { empty }    a browser/react-native field mapped it to `false` (empty module)
//   { builtin }  a Node builtin: a `node:` specifier, or a builtin name no installed package resolves
//   null         unresolved
//
// Browser and React Native targets have no Node builtins, so a bare builtin name (`buffer`,
// `events`, `util`, `process`, ...) resolves to the installed npm package of that name, as esbuild
// (platform browser), webpack 5 (target web) and Metro bundle it. Where nothing is installed it
// stays a builtin, as the --metro-resolver adapter reports Metro's miss on one (metro-resolver.js),
// rather than an unresolved edge: Metro and webpack fail the build there.

// First mainFields entry that's a non-empty string, else `index` (object-valued fields are redirect maps).
function packageEntry(pkg, mainFields) {
  for (const name of mainFields) {
    if (typeof pkg?.[name] === 'string' && pkg[name].length > 0) return pkg[name]
  }
  return 'index'
}

// Merge object-valued mainFields (browser-spec maps) into one redirect map. Iterate in REVERSE
// so earlier mainFields win on conflict. Keys are verbatim: `./x` relative vs bare `x` (kept bare).
function mergeRedirectMap(pkg, mainFields) {
  const map = new Map()
  for (let i = mainFields.length - 1; i >= 0; i--) {
    const field = pkg?.[mainFields[i]]
    if (!field || typeof field !== 'object') continue
    for (const [key, value] of Object.entries(field)) {
      if (typeof value !== 'string' && value !== false) continue
      map.set(key, value)
    }
  }
  return map
}

// Resolve the package ENTRY (from mainFields) through the package's own redirect map, as esbuild
// does. Returns { entry } (the redirected or original entry to resolve) or { empty: true }: a string
// redirects, `false` empties the entry. The extension-STRIPPED bare spelling is not probed: for an
// extensioned main, esbuild treats it as a bare module name, not the entry. (For an extensionless
// main the `bare` candidate covers it -- esbuild does match that spelling; verified empirically.)
function resolveEntryThroughMap(map, main) {
  if (map.size === 0) return { entry: main }
  const bare = main.replace(/^\.\//u, '')
  const stripped = bare.replace(/\.(?:js|json)$/u, '')
  const cands = [
    `./${bare}`, bare,
    `./${stripped}`,
    `./${stripped}.js`, `${stripped}.js`,
    `./${stripped}.json`, `${stripped}.json`,
  ]
  for (const cand of cands) {
    const v = map.get(cand)
    if (typeof v === 'string') return { entry: v }
    if (v === false) return { empty: true }
  }
  return { entry: main }
}

// A resolved file by its REAL path (through `host`, so a Vfs host's links are followed too), as Node,
// Metro and esbuild record one: under pnpm's isolated layout `node_modules/debug` links into
// `node_modules/.pnpm/debug@x/node_modules/debug`, whose own imports (a sibling `ms`) resolve only
// from where it really lies. Probing stays on the path as reached; only the hit is realpathed. null
// where the file has no real path (gone since it was probed).
function fileResolution(path, host) {
  let real
  try {
    real = host.realpath(path)
  } catch {
    return null
  }
  return { url: pathToFileURL(real).toString() }
}

// Match a package-relative path (`./x`) against the redirect map, trying `.js`/`.json` appended.
function matchRedirect(map, relPath) {
  if (map.size === 0) return undefined
  for (const cand of [relPath, `${relPath}.js`, `${relPath}.json`]) {
    if (map.has(cand)) return map.get(cand)
  }
  return undefined
}

// What readJson gives for each manifest a resolver reads, read once, as for a tree that holds still:
// but one whose reading read what a lazy tree does not hold yet (`host.touches`) read again, or with
// `host.retouch` taken as read again (untouchedMemo's). Each resolver reads its own, so a build on the
// disk reads each manifest as it is then.
function manifestReader(host) {
  const manifests = untouchedMemo(host.touches, { retouch: host.retouch })
  return (path) => manifests(path, () => readJson(path, host))
}

// React Native's Metro config defaults: the extensions its resolver probes, in order, and those it
// takes as assets.
export const METRO_SOURCE_EXTS = metroDefaults.sourceExts
export const METRO_ASSET_EXTS = new Set(metroDefaults.assetExts)
// The conditions Metro asserts itself, by the kind of import.
const METRO_OWN_CONDITIONS = new Set(['default', 'import', 'require'])

// --metro --typescript: `view` (a metroHost over `host`) with tsc's extension substitution, as
// resolveSourceFile's: a file named for a JS output that is absent (`native.js`) is the first of its TS
// source siblings on disk (`native.ts`), unless that lies in node_modules by its real path, else an
// unbuilt output's source (`dist/native.js` -> `src/native.ts`; fromOutputSource). So Metro's own
// steps -- the entry its mainFields pick, a browser-map or `exports` target, the path itself, each
// platform file it tries -- land on the source of a compiled file that exists only as that source.
function typescriptView(view, { outputs, host, read }) {
  const sibling = (path) => typescriptSiblings(path).find((candidate) => view.isFile(candidate)) ?? null
  const source = (path) => {
    const pick = sibling(path) ?? fromOutputSource(path, (input) => (view.isFile(input) ? input : sibling(input)), { outputs, host, read })
    return pick === null || inNodeModules(pick, host) ? null : pick
  }
  const substituted = (path) => (view.isFile(path) || view.isDirectory(path) ? null : source(path))
  return {
    ...view,
    isFile: (path) => view.isFile(path) || substituted(path) !== null,
    realpath: (path) => view.realpath(substituted(path) ?? path),
  }
}

// Probe `base` for a source file in platform order: bare name first, then per ext
// `base.<platform>.<ext>`, `base.native.<ext>` (native only), `base.<ext>`. `platform: null`
// disables suffixes. Returns a path, or null.
function resolveSourceFile(base, opts) {
  // A path that literally names a `.d.ts` names no runtime module (types are erased). Probe its
  // declaration-free stem instead, so an entry field pointing at `dist/index.d.ts` lands on the real
  // `dist/index.js` beside it rather than bundling the declaration -- or failing the package
  // outright by falling back to a different index. The probe below still refuses a literal hit.
  base = stripTypeDeclaration(base)
  // A `.d.ts` is types-only, erased at runtime: never a resolution target, so a package whose
  // entry field points at one falls through to its real `.js` instead of bundling the declaration.
  const probePath = (p) => (!isTypeDeclaration(p) && isFile(p, opts.host) ? p : null)
  // `suffix` is everything appended to `base`.
  const probe = (suffix) => probePath(`${base}${suffix}`)
  const tryExt = (sourceExt) => {
    if (opts.platform) {
      const hit = probe(`.${opts.platform}${sourceExt}`)
      if (hit) return hit
    }
    if (opts.preferNative && sourceExt !== '') {
      const hit = probe(`.native${sourceExt}`)
      if (hit) return hit
    }
    return probe(sourceExt)
  }
  const bare = tryExt('')
  if (bare) return bare
  // --typescript: tsc's extension substitution. A base naming a JS output extension probes its TS
  // source siblings once the literal file (the bare probe above) is absent, so the on-disk `.js`
  // always wins over its `.ts` twin. Literal siblings only -- no platform suffixes (tsc has none);
  // extensionless bases keep going through the appended-extension loop below (sourceExts carries
  // ts and tsx). Placed before that loop so `x.js` -> `x.ts` beats a pathological
  // `x.js.<ext>`, matching tsc's candidate order. Never into node_modules: where tsc's pick, the
  // first sibling on disk, lies there by its real path, nothing maps (inNodeModules), as the shared
  // fallback refuses its own -- never a later sibling tsc wouldn't pick. The resolver drops
  // `typescript` for an importer there.
  if (opts.typescript) {
    for (const cand of typescriptSiblings(base)) {
      const hit = probePath(cand)
      if (hit === null) continue
      return inNodeModules(hit, opts.host) ? null : hit
    }
  }
  for (const ext of opts.sourceExts) {
    const hit = tryExt(`.${ext}`)
    if (hit) return hit
  }
  // --typescript: an unbuilt output's source, probed the same way (fromOutputSource). Not for a
  // directory: resolveFileOrDir probes its index, which maps.
  if (opts.typescript && !isDir(base, opts.host)) return fromOutputSource(base, (input) => resolveSourceFile(input, { ...opts, outputs: null }), opts)
  return null
}

// Resolve absolute `base` as a file (ext probing) else as a directory (package.json `main` via
// mainFields + entry redirect, else `index`). `exports` is NOT consulted — Node applies it only to
// bare package-name imports, not to a path landing on a directory.
function resolveFileOrDir(base, opts) {
  const asResolution = (hit) => (hit === null ? null : fileResolution(hit, opts.host))
  const file = asResolution(resolveSourceFile(base, opts))
  if (file) return file
  if (isDir(base, opts.host)) {
    const dpkg = opts.read(join(base, 'package.json'))
    if (dpkg) {
      const r = resolveEntryThroughMap(mergeRedirectMap(dpkg, opts.mainFields), packageEntry(dpkg, opts.mainFields))
      if (r.empty) return { empty: true }
      // Node's LOAD_AS_DIRECTORY resolves `main` as a file, else as a directory index
      // (`main: "./lib/"` -> lib/index.js); a broken `main` falls back to the package index below.
      const entryBase = join(base, r.entry)
      const entryOpts = { ...opts, pkgDir: base } // the package naming the entry, for its unbuilt output
      const inner = asResolution(resolveSourceFile(entryBase, entryOpts) ?? resolveSourceFile(join(entryBase, 'index'), entryOpts))
      if (inner) return inner
    }
    const index = asResolution(resolveSourceFile(join(base, 'index'), opts))
    if (index) return index
  }
  return null
}

// Build a resolver bound to options: `conditions` (a resolveConditions set) gates `exports`
// packages (delegated to Node's algorithm), `mainFields`/`platform`/`preferNative`/`sourceExts`
// drive the legacy-field + suffix probing.
// `metro` resolves as Metro does instead (viaMetro), taking `assetExts` (Metro's defaults, else the
// project's) as assets; leave it off for the esbuild-parity `--mainFields` path. `typescript` adds
// tsc's extension substitution (a missing `x.js` probes its `x.ts` sibling) and unbuilt outputs'
// sources (see resolveSourceFile; under `metro`, typescriptView) plus the shared miss fallback (see
// below), and `typescriptPaths` (a tsconfig paths matcher, with the packages' layouts; see
// resolveTypescriptFallback) its tsconfig alias mapping.
// `host` is the filesystem view (@exodus/stasis-core/host), the real disk by default. `kept`, a Map
// kept across a lazy tree's rounds, keeps there each resolution that read nothing the tree does not
// hold yet (untouchedMemo's `across`), for the rounds after.
export function createFieldResolver({
  conditions = [],
  mainFields = ['main'],
  platform = null,
  preferNative = false,
  sourceExts = METRO_SOURCE_EXTS,
  metro = false,
  assetExts = METRO_ASSET_EXTS,
  typescript = false,
  typescriptPaths = null,
  host = diskHost,
  kept,
} = {}) {
  const read = manifestReader(host)
  const outputs = typescript ? typescriptPaths?.outputs ?? tsconfigOutputsOf({ host }) : null
  const opts = { platform, preferNative, sourceExts, mainFields, typescript, outputs, host, read }
  // An importer in node_modules gets no --typescript mapping (inNodeModules), wherever its import lands.
  const fromNodeModules = { ...opts, typescript: false }
  // Node answers a builtin name with the builtin itself, so an `exports`-bearing package named like
  // one (see the header) resolves through this instead, with builtins off; built on first use.
  let packageResolver
  const nodeResolver = () => (packageResolver ??= createNodeResolver(host))
  // --metro: Metro's own resolution, @preventive/rn's, over `host` as stasis reads it (metroHost). Metro
  // asserts `default` and `import` or `require` by the kind of import itself, and takes the rest of an
  // importer's conditions as its `conditionNames`: one resolver for each such set, made on first use.
  // Off web it prefers `.native` files (preferNative). --typescript resolves what that misses again,
  // over the view of tsc's extension substitution (typescriptView), but for an importer in
  // node_modules (inNodeModules), so it never overrides what Metro resolves. A builtin it fails to
  // resolve, one the importer's browser map doesn't remap, is a builtin (see the header).
  const metroResolvers = new Map()
  const metroResolver = (conditionNames, substituting) => {
    const key = `${substituting}\0${conditionNames.join('\0')}`
    if (!metroResolvers.has(key)) {
      const view = metroHost(host, mainFields)
      metroResolvers.set(key, createMetroResolver({ host: substituting ? typescriptView(view, opts) : view, sourceExts, assetExts, mainFields, conditionNames, conditionsByPlatform: {}, preferNativePlatform: preferNative }))
    }
    return metroResolvers.get(key)
  }
  const viaMetro = (parentFile, specifier, conds) => {
    const conditionNames = [...conds].filter((name) => !METRO_OWN_CONDITIONS.has(name))
    const request = { platform, isESMImport: conds.has('import') }
    let resolution = metroResolver(conditionNames, false)(parentFile, specifier, request)
    if (resolution === null && typescript && !inNodeModules(parentFile, host)) resolution = metroResolver(conditionNames, true)(parentFile, specifier, request)
    const remapped = () => {
      const imp = nearestPackage(parentFile, host, read)
      return imp !== null && matchRedirect(mergeRedirectMap(imp.pkg, mainFields), specifier) !== undefined
    }
    return scanResolution(resolution, resolution === null && isBuiltin(specifier) && !remapped())
  }
  // `callConditions` (from scan) is the parent's format-driven condition set, so `exports`
  // delegation matches Node resolving from THAT file; falls back to configured `conditions`.
  const resolve = function resolve(parentFile, specifier, callConditions) {
    const fileOpts = typescript && inNodeModules(parentFile, host) ? fromNodeModules : opts
    const conds = new Set(callConditions ?? conditions)
    const viaNode = (spec) => {
      try {
        if (!isBuiltin(spec)) return fileResolution(host.resolve(parentFile, spec, conds), host)
        return fileResolution(nodeResolver().resolve(parentFile, spec, conds, { builtins: false }), host)
      } catch {
        return null
      }
    }
    // A bare specifier (`mod`, `mod/sub`) through node_modules.
    const viaPackage = (spec) => {
      const loc = locatePackage(dirname(parentFile), spec, host)
      if (!loc) return null
      const pkg = read(join(loc.pkgDir, 'package.json')) ?? {}
      // `exports` wins over mainFields; Node's algorithm resolves it (with conditions) correctly.
      if (pkg.exports != null) return viaNode(spec)
      // A bare package import resolves its directory via the same dir algorithm as any other.
      if (loc.subpath === '') return resolveFileOrDir(loc.pkgDir, fileOpts)
      const sub = `./${loc.subpath}`
      const r = matchRedirect(mergeRedirectMap(pkg, mainFields), sub)
      if (r === false) return { empty: true }
      const target = typeof r === 'string' ? r : sub
      return resolveFileOrDir(join(loc.pkgDir, target), fileOpts)
    }
    if (metro) return viaMetro(parentFile, specifier, conds)
    // `#name` subpath imports use the `imports` field + conditions; Node's algorithm handles them.
    if (specifier.startsWith('#')) return viaNode(specifier)

    let spec = specifier
    // Redirect via the IMPORTER's browser/react-native map, BEFORE the builtin check on purpose:
    // a map entry can disable or shim a builtin (`{"crypto": false}` / `"crypto-browserify"`).
    const imp = nearestPackage(parentFile, host, read)
    if (imp) {
      const map = mergeRedirectMap(imp.pkg, mainFields)
      let r
      if (spec.startsWith('.') || isAbsolute(spec)) {
        const abs = isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec)
        r = matchRedirect(map, `./${toPosix(relative(imp.pkgDir, abs))}`)
      } else {
        r = map.get(spec) // a bare specifier (`mod`, `mod/sub`) matches the map's bare keys
      }
      if (r === false) return { empty: true }
      if (typeof r === 'string') {
        // Browser-map targets are relative to the PACKAGE ROOT, not the importing file; a
        // bare-module target re-enters resolution below.
        if (r.startsWith('.') || isAbsolute(r)) {
          return resolveFileOrDir(isAbsolute(r) ? r : resolvePath(imp.pkgDir, r), fileOpts)
        }
        spec = r
      }
    }

    if (spec.startsWith('.') || isAbsolute(spec)) {
      const base = isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec)
      return resolveFileOrDir(base, fileOpts)
    }

    // A builtin the browser map did not remap: its `node:` form names the builtin itself; a bare
    // name is the installed package of that name (see the header), the builtin where none resolves.
    if (isBuiltin(spec)) return spec.startsWith('node:') ? { builtin: true } : (viaPackage(spec) ?? { builtin: true })
    return viaPackage(spec)
  }
  // Each resolution made once for each directory, specifier and conditions: a file's directory is all
  // of it resolving from it reads (its package, the node_modules above it, its tsconfig `paths`).
  // Kept as the resolver's manifests are (manifestReader), and in `kept` across rounds.
  const resolutions = untouchedMemo(host.touches, { retouch: host.retouch, across: kept })
  const once = (resolveFn) => (parentFile, specifier, callConditions) => resolutions(`${dirname(parentFile)}\0${specifier}\0${[...callConditions ?? conditions].join('\0')}`, () => resolveFn(parentFile, specifier, callConditions))
  if (!typescript) return once(resolve)
  // --typescript: when the whole field flow leaves the specifier unresolved, give tsc's mapping
  // the same shot the scanner's fallback gets, via the shared dispatcher. On this path it covers
  // the layers the field resolver delegates to Node -- `exports`-bearing packages and `#` subpath
  // imports, whose targets may name compiled files existing only as TS source -- plus tsconfig
  // `paths` aliases; misses only, so no field/redirect/suffix resolution is ever overridden.
  // (Relative paths re-probe tsc-style too -- redundant after resolveSourceFile, but harmless.)
  return once(function resolveWithTypescriptFallback(parentFile, specifier, callConditions) {
    const resolved = resolve(parentFile, specifier, callConditions)
    if (resolved) return resolved
    // Under --metro an asset is Metro's asset rule's to resolve, as tsc never does.
    if (metro && isAssetFile(specifier, assetExts)) return null
    const hit = resolveTypescriptFallback(parentFile, specifier, {
      conditions: new Set(callConditions ?? conditions),
      paths: typescriptPaths,
      host,
    })
    return hit == null ? null : fileResolution(hit, host)
  })
}

// True when `format` is an ESM family (drives the base condition set, mirroring scan).
function isModuleFormat(format) {
  return format === 'module' || format === 'module-typescript'
}

// Condition set for a parent of the given format, as scan's #conditionSet gives a custom resolver:
// `import` or `require` by format, `default` (which Node's resolver matches anyway), plus extras.
// A bundler's base, not Node's: esbuild, webpack and Metro assert `import`/`require` and
// `default`, never `node`, so an `exports` map listing `node` first can't win over the extras.
// Order is irrelevant (Node membership-tests against exports key order).
export function resolveConditions(format, extras = []) {
  return [...new Set([isModuleFormat(format) ? 'import' : 'require', 'default', ...extras])]
}
