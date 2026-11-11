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
  readManifest,
  resolveTypescriptFallback,
  tsconfigOutputsOf,
  typescriptSiblings,
} from './resolve-typescript.js'
import { diskHost } from '@exodus/stasis-core/host'
import { metroHost, scanResolution, stripTypeDeclaration } from './metro-resolver.js'
import { RELATIVE_REQUEST, createNodeResolver } from './resolve-node.js'
import { hostMemo } from './vfs-bundle/lazy.js'

// Legacy package fields (`react-native`/`browser`/`main`, their redirect maps) and platform suffixes, as Metro resolves
// them: -> { url } | { empty } (mapped to `false`) | { builtin } | null. Targets without Node builtins take a bare builtin
// name (`buffer`) for the installed package so named, as esbuild, webpack 5 and Metro do, else for the builtin.

// Object-valued fields are redirect maps, never an entry.
const packageEntry = (pkg, mainFields) =>
  mainFields.map((name) => pkg[name]).find((entry) => typeof entry === 'string' && entry.length > 0) ?? 'index'

// Earlier mainFields win on conflict. Keys are verbatim: `./x` relative vs bare `x`.
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

// As esbuild maps the package entry: the extension-stripped bare spelling is no candidate, esbuild taking it as a
// bare module name (an extensionless main's is `bare` itself, which it matches).
function resolveEntryThroughMap(map, main) {
  if (map.size === 0) return { entry: main }
  const bare = main.replace(/^\.\//u, '')
  const stripped = bare.replace(/\.(?:js|json)$/u, '')
  for (const cand of [`./${bare}`, bare, `./${stripped}`, `./${stripped}.js`, `${stripped}.js`, `./${stripped}.json`, `${stripped}.json`]) {
    const v = map.get(cand)
    if (typeof v === 'string') return { entry: v }
    if (v === false) return { empty: true }
  }
  return { entry: main }
}

// By real path, as Node, Metro and esbuild record a file: under pnpm a package's imports resolve only from where it lies.
function fileResolution(path, host) {
  try {
    return { url: pathToFileURL(host.realpath(path)).toString() }
  } catch {
    return null
  }
}

// Map keys are strings, so a miss gets undefined.
const matchRedirect = (map, relPath) => map.get([relPath, `${relPath}.js`, `${relPath}.json`].find((cand) => map.has(cand)))

// Each resolver reads its own manifests, so a build on the disk reads each as it is then.
function manifestReader(host) {
  const manifests = hostMemo(host)
  return (path) => manifests(path, () => readManifest(path, host))
}

export const METRO_SOURCE_EXTS = metroDefaults.sourceExts
export const METRO_ASSET_EXTS = new Set(metroDefaults.assetExts)
export const METRO_ASSET_RESOLUTIONS = metroDefaults.assetResolutions
const METRO_OWN_CONDITIONS = new Set(['default', 'import', 'require'])

// --metro --typescript: an absent JS output is its first TS sibling on disk, else an unbuilt output's source.
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

function resolveSourceFile(base, opts) {
  // An entry field naming `dist/index.d.ts` lands on the `dist/index.js` beside it.
  base = stripTypeDeclaration(base)
  const probe = (suffix) => (isSourceFile(`${base}${suffix}`, opts.host) ? `${base}${suffix}` : null)
  const tryExt = (ext) => (opts.platform && probe(`.${opts.platform}${ext}`))
    || (opts.preferNative && ext !== '' && probe(`.native${ext}`))
    || probe(ext)
  const bare = tryExt('')
  if (bare) return bare
  // tsc's substitution comes once the literal file is absent, before the appended extensions, as tsc orders them.
  // Its pick, the first sibling on disk, maps nothing in node_modules, never to a later sibling.
  if (opts.typescript) {
    const sibling = typescriptSiblings(base).find((candidate) => isSourceFile(candidate, opts.host))
    if (sibling !== undefined) return inNodeModules(sibling, opts.host) ? null : sibling
  }
  for (const ext of opts.sourceExts) {
    const hit = tryExt(`.${ext}`)
    if (hit) return hit
  }
  // Not for a directory: resolveFileOrDir probes its index, which maps.
  if (opts.typescript && !isDir(base, opts.host)) {
    const source = (input) => {
      const hit = resolveSourceFile(input, { ...opts, outputs: null })
      return hit === null || inNodeModules(hit, opts.host) ? null : hit
    }
    return fromOutputSource(base, source, opts)
  }
  return null
}

// `exports` is not consulted: Node applies it only to bare package names.
function resolveFileOrDir(base, opts, tried) {
  const asResolution = (hit) => (hit === null ? null : fileResolution(hit, opts.host))
  const file = asResolution(resolveSourceFile(base, opts))
  if (file) return file
  if (isDir(base, opts.host)) {
    const dpkg = opts.read(join(base, 'package.json'))
    if (dpkg) {
      const r = resolveEntryThroughMap(mergeRedirectMap(dpkg, opts.mainFields), packageEntry(dpkg, opts.mainFields))
      if (r.empty) return { empty: true }
      // Node's LOAD_AS_DIRECTORY: `main` as a file, else as a directory index; a broken one falls back to the index.
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

// `kept`: a Map kept across a lazy tree's rounds (untouchedMemo's `across`).
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
  // An importer in node_modules gets no --typescript mapping, wherever its import lands.
  const fromNodeModules = { ...opts, typescript: false }
  // Node answers a builtin name with the builtin, so a package named like one resolves through this, builtins off.
  let packageResolver
  const nodeResolver = () => (packageResolver ??= createNodeResolver(host))
  // --typescript resolves Metro's misses again over typescriptView, never from node_modules, so it never overrides Metro.
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
  // `callConditions`: scan's, by the parent's format. What a miss tried goes in `tried`, the missTargets.
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
        if (typeof error.target === 'string') tried.push(error.target)
        return null
      }
    }
    const viaPackage = (spec) => {
      const loc = locatePackage(dirname(parentFile), spec, host)
      if (!loc) return null
      const pkg = read(join(loc.pkgDir, 'package.json')) ?? {}
      if (pkg.exports != null) return viaNode(spec)
      if (loc.subpath === '') return probe(loc.pkgDir)
      const sub = `./${loc.subpath}`
      const r = matchRedirect(mergeRedirectMap(pkg, mainFields), sub)
      if (r === false) return { empty: true }
      return probe(join(loc.pkgDir, typeof r === 'string' ? r : sub))
    }
    if (metro) return viaMetro(parentFile, specifier, conds)
    if (specifier.startsWith('#')) return viaNode(specifier)

    let spec = specifier
    // The importer's map applies before the builtin check: it can disable or shim a builtin (`{"crypto": false}`).
    const imp = nearestPackage(parentFile, host, read)
    if (imp) {
      const map = mergeRedirectMap(imp.pkg, mainFields)
      let r
      if (spec.startsWith('.') || isAbsolute(spec)) {
        const abs = isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec)
        r = matchRedirect(map, `./${toPosix(relative(imp.pkgDir, abs))}`)
      } else {
        r = map.get(spec)
      }
      if (r === false) return { empty: true }
      if (typeof r === 'string') {
        // A path target is relative to the package root, not the importing file; a bare one is resolved below.
        if (r.startsWith('.') || isAbsolute(r)) return probe(isAbsolute(r) ? r : resolvePath(imp.pkgDir, r))
        spec = r
      }
    }
    if (spec.startsWith('.') || isAbsolute(spec)) return probe(isAbsolute(spec) ? spec : resolvePath(dirname(parentFile), spec))
    if (isBuiltin(spec)) return spec.startsWith('node:') ? { builtin: true } : (viaPackage(spec) ?? { builtin: true })
    return viaPackage(spec)
  }
  // --typescript: a miss of the whole field flow, and only a miss, gets the scanner's fallback too.
  const resolveWithTypescriptFallback = (parentFile, specifier, callConditions, tried) => {
    const resolved = resolve(parentFile, specifier, callConditions, tried)
    // Under --metro an asset is Metro's asset rule's to resolve, as tsc never does.
    if (resolved || !typescript || (metro && isAssetFile(specifier, assetExts))) return resolved
    const conds = new Set(callConditions ?? conditions)
    const hit = resolveTypescriptFallback(parentFile, specifier, { conditions: conds, paths: typescriptPaths, host })
    if (hit != null) return fileResolution(hit, host)
    const aliased = typescriptPaths !== null && !RELATIVE_REQUEST.test(specifier) && !isAbsolute(specifier) && !specifier.startsWith('#') && !inNodeModules(parentFile, host)
    if (aliased) tried.push(...typescriptPaths.matchPaths(specifier, parentFile))
    return null
  }
  // Once per directory (all a file's resolving reads), specifier and conditions, kept as the manifests are and in `kept`.
  const resolutions = hostMemo(host, { across: kept })
  const of = (parentFile, specifier, callConditions) => resolutions(`${dirname(parentFile)}\0${specifier}\0${[...callConditions ?? conditions].join('\0')}`, () => {
    const tried = []
    return { resolution: resolveWithTypescriptFallback(parentFile, specifier, callConditions, tried), tried }
  })
  return Object.assign((parentFile, specifier, callConditions) => of(parentFile, specifier, callConditions).resolution, {
    missTargets: (parentFile, specifier, callConditions) => of(parentFile, specifier, callConditions).tried,
  })
}

// As scan's #conditionSet gives a custom resolver: a bundler's base, not Node's. esbuild, webpack and Metro assert
// `import`/`require` and `default`, never `node`, so an `exports` map listing `node` first can't win over the extras.
export function resolveConditions(format, extras = []) {
  const esm = format === 'module' || format === 'module-typescript'
  return [...new Set([esm ? 'import' : 'require', 'default', ...extras])]
}
