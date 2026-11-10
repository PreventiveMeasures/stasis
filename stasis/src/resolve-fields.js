import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isAssetFile } from '@preventive/rn/metro-assets.js'
import { createMetroResolver, defaults as metroDefaults } from '@preventive/rn/metro-resolver.js'
import { memoized, toPosix } from '@exodus/stasis-core/util'
import {
  fromOutputSource,
  inNodeModules,
  isDir,
  isSourceFile,
  locatePackage,
  nearestPackage,
  readJson,
  resolveTypescriptFallback,
  tsconfigOutputsOf,
  typescriptSiblings,
} from './resolve-typescript.js'
import { diskHost } from '@exodus/stasis-core/host'
import { metroHost, scanResolution, stripTypeDeclaration } from './metro-resolver.js'
import { RELATIVE_REQUEST, createNodeResolver } from './resolve-node.js'
import { untouchedMemo } from './vfs-bundle/lazy.js'

// Static module resolver for legacy package fields (`react-native`/`browser`/`main` + browser-spec
// redirect maps) and platform suffixes (`.ios`/`.android`/`.native`), as Metro/React Native resolve
// and Node can't; `exports` packages go to Node's algorithm under a bundler's conditions
// (resolveConditions), and under `metro`, everything to Metro's own (viaMetro). It runs no user code.
//
// Returns, for each specifier:
//   { url }      resolved to a file, by its real path (file: URL string; see fileResolution)
//   { empty }    a browser/react-native field mapped it to `false` (empty module)
//   { builtin }  a Node builtin: a `node:` specifier, or a builtin name no installed package resolves
//   null         unresolved
//
// Browser and React Native targets have no Node builtins, so a bare builtin name (`buffer`) is the
// installed package of that name, as esbuild, webpack 5 and Metro bundle it; with none installed it
// stays a builtin (as metro-resolver.js reports Metro's miss on one), not an unresolved edge.

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
  for (const name of mainFields.toReversed()) {
    const field = pkg?.[name]
    if (!field || typeof field !== 'object') continue
    for (const [key, value] of Object.entries(field)) {
      if (typeof value === 'string' || value === false) map.set(key, value)
    }
  }
  return map
}

// The package ENTRY (from mainFields) through the package's own redirect map, as esbuild takes it:
// { entry } (redirected or not) or { empty: true }. The extension-stripped bare spelling is no candidate:
// esbuild takes it as a bare module name (an extensionless main's is `bare` itself, which it matches).
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

// A resolved file by its REAL path (through `host`), as Node, Metro and esbuild record one: under pnpm a
// package's own imports resolve only from where it really lies. Probing stays on the path as reached;
// only the hit is realpathed. null where it has no real path (gone since it was probed).
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
  for (const cand of [relPath, `${relPath}.js`, `${relPath}.json`]) {
    if (map.has(cand)) return map.get(cand)
  }
  return undefined
}

// readJson of each manifest a resolver reads, once, as a lazy tree allows (untouchedMemo). Each resolver
// reads its own, so a build on the disk reads each manifest as it is then.
function manifestReader(host) {
  const manifests = untouchedMemo(host.touches, { retouch: host.retouch })
  return (path) => manifests(path, () => readJson(path, host))
}

// React Native's Metro config defaults: the extensions its resolver probes, in order, those it
// takes as assets, and the scales an asset's files are of.
export const METRO_SOURCE_EXTS = metroDefaults.sourceExts
export const METRO_ASSET_EXTS = new Set(metroDefaults.assetExts)
export const METRO_ASSET_RESOLUTIONS = metroDefaults.assetResolutions
// The conditions Metro asserts itself, by the kind of import.
const METRO_OWN_CONDITIONS = new Set(['default', 'import', 'require'])

// --metro --typescript: `view` (a metroHost over `host`) with resolveSourceFile's substitution: an absent
// JS output (`native.js`) is its first TS sibling on disk (none in node_modules), else an unbuilt
// output's source (fromOutputSource), so each of Metro's own steps lands on a compiled file's source.
function typescriptView(view, { outputs, host }) {
  const sibling = (path) => typescriptSiblings(path).find((candidate) => view.isFile(candidate)) ?? null
  const source = (path) => {
    const pick = sibling(path) ?? fromOutputSource(path, (input) => (view.isFile(input) ? input : sibling(input)), { outputs, host })
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
  // A `.d.ts` names no runtime module: probe its declaration-free stem, so an entry field naming
  // `dist/index.d.ts` lands on the real `dist/index.js` beside it (isSourceFile refuses a literal hit).
  base = stripTypeDeclaration(base)
  const probe = (suffix) => (isSourceFile(`${base}${suffix}`, opts.host) ? `${base}${suffix}` : null)
  const tryExt = (ext) => (opts.platform && probe(`.${opts.platform}${ext}`))
    || (opts.preferNative && ext !== '' && probe(`.native${ext}`))
    || probe(ext)
  const bare = tryExt('')
  if (bare) return bare
  // --typescript: tsc's substitution once the literal file is absent (so an on-disk `.js` wins), before
  // the appended extensions, as tsc orders its candidates. tsc's pick, the first sibling on disk, maps
  // nothing where it lies in node_modules by its real path (inNodeModules), never to a later sibling.
  if (opts.typescript) {
    const sibling = typescriptSiblings(base).find((candidate) => isSourceFile(candidate, opts.host))
    if (sibling !== undefined) return inNodeModules(sibling, opts.host) ? null : sibling
  }
  for (const ext of opts.sourceExts) {
    const hit = tryExt(`.${ext}`)
    if (hit) return hit
  }
  // --typescript: an unbuilt output's source, probed the same way (fromOutputSource), never in
  // node_modules. Not for a directory: resolveFileOrDir probes its index, which maps.
  if (opts.typescript && !isDir(base, opts.host)) {
    const source = (input) => {
      const hit = resolveSourceFile(input, { ...opts, outputs: null })
      return hit === null || inNodeModules(hit, opts.host) ? null : hit
    }
    return fromOutputSource(base, source, opts)
  }
  return null
}

// Resolve absolute `base` as a file (ext probing) else as a directory (package.json `main` via
// mainFields + entry redirect, else `index`). `exports` is NOT consulted — Node applies it only to
// bare package-name imports, not to a path landing on a directory. An entry it finds missing is put
// in `tried`.
function resolveFileOrDir(base, opts, tried) {
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
      tried.push(entryBase)
    }
    const index = asResolution(resolveSourceFile(join(base, 'index'), opts))
    if (index) return index
  }
  return null
}

// A resolver bound to options: `conditions` (resolveConditions') gates `exports` packages (Node's
// algorithm); `mainFields`/`platform`/`preferNative`/`sourceExts` drive the legacy-field and suffix
// probing. `metro` resolves as Metro does instead (viaMetro), `assetExts` as assets at the scales
// `assetResolutions`. `typescript` adds tsc's substitution and unbuilt outputs' sources (resolveSourceFile;
// under `metro`, typescriptView) and the shared miss fallback, with `typescriptPaths`' aliases. `kept`, a
// Map kept across a lazy tree's rounds, keeps each resolution that read nothing it lacks (untouchedMemo's `across`).
export function createFieldResolver({
  conditions = [],
  mainFields = ['main'],
  platform = null,
  preferNative = false,
  sourceExts = METRO_SOURCE_EXTS,
  metro = false,
  assetExts = METRO_ASSET_EXTS,
  assetResolutions = METRO_ASSET_RESOLUTIONS,
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
  // --metro: @preventive/rn's Metro resolution over metroHost, a resolver for each set of an importer's
  // conditions but those Metro asserts itself (its `conditionNames`). --typescript resolves what that
  // misses again over typescriptView, but from node_modules, so it never overrides Metro. A builtin it
  // misses, unless the importer's browser map remaps it, is a builtin (see the header).
  const metroResolver = memoized(({ conditionNames, substituting }) => {
    const view = metroHost(host, mainFields)
    return createMetroResolver({ host: substituting ? typescriptView(view, opts) : view, sourceExts, assetExts, assetResolutions, mainFields, conditionNames, conditionsByPlatform: {}, preferNativePlatform: preferNative })
  }, ({ conditionNames, substituting }) => `${substituting}\0${conditionNames.join('\0')}`)
  const viaMetro = (parentFile, specifier, conds) => {
    const conditionNames = [...conds].filter((name) => !METRO_OWN_CONDITIONS.has(name))
    const request = { platform, isESMImport: conds.has('import') }
    let resolution = metroResolver({ conditionNames, substituting: false })(parentFile, specifier, request)
    if (resolution === null && typescript && !inNodeModules(parentFile, host)) resolution = metroResolver({ conditionNames, substituting: true })(parentFile, specifier, request)
    const remapped = () => {
      const imp = nearestPackage(parentFile, host, read)
      return imp !== null && matchRedirect(mergeRedirectMap(imp.pkg, mainFields), specifier) !== undefined
    }
    return scanResolution(resolution, resolution === null && isBuiltin(specifier) && !remapped())
  }
  // `callConditions` (from scan) is the parent's format-driven condition set, so `exports` delegation
  // matches Node resolving from THAT file; else the configured `conditions`. Each file or directory a
  // miss tried (a redirect's target, a package's `main`) is put in `tried`, the resolver's missTargets.
  const resolve = function resolve(parentFile, specifier, callConditions, tried) {
    const fileOpts = typescript && inNodeModules(parentFile, host) ? fromNodeModules : opts
    const conds = new Set(callConditions ?? conditions)
    const probe = (base) => {
      const hit = resolveFileOrDir(base, fileOpts, tried)
      if (hit === null) tried.push(base)
      return hit
    }
    const viaNode = (spec) => {
      try {
        if (!isBuiltin(spec)) return fileResolution(host.resolve(parentFile, spec, conds), host)
        return fileResolution(nodeResolver().resolve(parentFile, spec, conds, { builtins: false }), host)
      } catch (error) {
        // The file a package target named, where one did (resolve-node's `target`).
        if (typeof error.target === 'string') tried.push(error.target)
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
      if (loc.subpath === '') return probe(loc.pkgDir)
      const sub = `./${loc.subpath}`
      const r = matchRedirect(mergeRedirectMap(pkg, mainFields), sub)
      if (r === false) return { empty: true }
      return probe(join(loc.pkgDir, typeof r === 'string' ? r : sub))
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
          return probe(isAbsolute(r) ? r : resolvePath(imp.pkgDir, r))
        }
        spec = r
      }
    }

    if (spec.startsWith('.') || isAbsolute(spec)) {
      return probe(isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec))
    }

    // A builtin the browser map did not remap: its `node:` form names the builtin itself; a bare
    // name is the installed package of that name (see the header), the builtin where none resolves.
    if (isBuiltin(spec)) return spec.startsWith('node:') ? { builtin: true } : (viaPackage(spec) ?? { builtin: true })
    return viaPackage(spec)
  }
  // Each resolution made once per directory, specifier and conditions (a file's directory is all its
  // resolving reads), kept as the manifests are and in `kept` across rounds, with what a miss tried
  // (the resolver's `missTargets`, Scan's for vfs-bundle/prisma.js).
  const resolutions = untouchedMemo(host.touches, { retouch: host.retouch, across: kept })
  const once = (resolveFn) => {
    const of = (parentFile, specifier, callConditions) => resolutions(`${dirname(parentFile)}\0${specifier}\0${[...callConditions ?? conditions].join('\0')}`, () => {
      const tried = []
      return { resolution: resolveFn(parentFile, specifier, callConditions, tried), tried }
    })
    return Object.assign((parentFile, specifier, callConditions) => of(parentFile, specifier, callConditions).resolution, {
      missTargets: (parentFile, specifier, callConditions) => of(parentFile, specifier, callConditions).tried,
    })
  }
  if (!typescript) return once(resolve)
  // --typescript: a miss of the whole field flow gets the scanner's fallback too (resolveTypescriptFallback),
  // covering what it delegates to Node (`exports` packages, `#` imports) and tsconfig `paths` aliases;
  // misses only, so no field/redirect/suffix resolution is ever overridden.
  return once(function resolveWithTypescriptFallback(parentFile, specifier, callConditions, tried) {
    const resolved = resolve(parentFile, specifier, callConditions, tried)
    if (resolved) return resolved
    // Under --metro an asset is Metro's asset rule's to resolve, as tsc never does.
    if (metro && isAssetFile(specifier, assetExts)) return null
    const hit = resolveTypescriptFallback(parentFile, specifier, {
      conditions: new Set(callConditions ?? conditions),
      paths: typescriptPaths,
      host,
    })
    if (hit != null) return fileResolution(hit, host)
    // A miss tried where a tsconfig alias points, as the scan's own fallback records it (Scan's missTargets).
    const aliased = typescriptPaths !== null && !RELATIVE_REQUEST.test(specifier) && !isAbsolute(specifier) && !specifier.startsWith('#') && !inNodeModules(parentFile, host)
    if (aliased) tried.push(...typescriptPaths.matchPaths(specifier, parentFile))
    return null
  })
}

// Condition set for a parent of the given format, as scan's #conditionSet gives a custom resolver:
// `import` or `require` by format, `default` (which Node's resolver matches anyway), plus extras.
// A bundler's base, not Node's: esbuild, webpack and Metro assert `import`/`require` and
// `default`, never `node`, so an `exports` map listing `node` first can't win over the extras.
// Order is irrelevant (Node membership-tests against exports key order).
export function resolveConditions(format, extras = []) {
  const esm = format === 'module' || format === 'module-typescript'
  return [...new Set([esm ? 'import' : 'require', 'default', ...extras])]
}
