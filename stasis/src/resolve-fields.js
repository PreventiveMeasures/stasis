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
  outsideNodeModules,
  readManifest,
  realpathOr,
  resolveTypescriptFallback,
  tsconfigOutputsOf,
  typescriptAliasTargets,
  typescriptSource,
} from './resolve-typescript.js'
import { diskHost } from '@exodus/stasis-core/host'
import { metroHost, scanResolution, stripTypeDeclaration } from './metro-resolver.js'
import { createNodeResolver } from './resolve-node.js'
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

// Map keys are strings, so a miss gets undefined.
const redirect = (map, candidates) => map.get(candidates.find((cand) => map.has(cand)))
const matchRedirect = (map, relPath) => redirect(map, [relPath, `${relPath}.js`, `${relPath}.json`])

// As esbuild maps the package entry: the extension-stripped bare spelling is no candidate, esbuild taking it as a
// bare module name (an extensionless main's is `bare` itself, which it matches). False where the map disables it.
function entryThroughMap(map, main) {
  const bare = main.replace(/^\.\//u, '')
  const stripped = bare.replace(/\.(?:js|json)$/u, '')
  return redirect(map, [`./${bare}`, bare, `./${stripped}`, `./${stripped}.js`, `${stripped}.js`, `./${stripped}.json`, `${stripped}.json`]) ?? main
}

// By real path, as Node, Metro and esbuild record a file: under pnpm a package's imports resolve only from where it lies.
function fileResolution(path, host) {
  const real = realpathOr(path, host, null)
  return real === null ? null : { url: pathToFileURL(real).toString() }
}

const isPathSpec = (spec) => spec.startsWith('.') || isAbsolute(spec)
const pathFrom = (dir, spec) => (isAbsolute(spec) ? spec : resolvePath(dir, spec))

export const METRO_SOURCE_EXTS = metroDefaults.sourceExts
export const METRO_ASSET_EXTS = new Set(metroDefaults.assetExts)
export const METRO_ASSET_RESOLUTIONS = metroDefaults.assetResolutions
const METRO_OWN_CONDITIONS = new Set(['default', 'import', 'require'])

// --metro --typescript: an absent JS output is its first TS sibling on disk, else an unbuilt output's source. `view`'s
// files are the sources on disk (metroHost's).
function typescriptView(view, { outputs, host }) {
  const source = (path) => {
    const pick = typescriptSource(path, host) ?? fromOutputSource(path, (input) => (view.isFile(input) ? input : typescriptSource(input, host)), { outputs, host })
    return outsideNodeModules(pick, host)
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
  const sibling = opts.typescript ? typescriptSource(base, opts.host) : null
  if (sibling !== null) return outsideNodeModules(sibling, opts.host)
  for (const ext of opts.sourceExts) {
    const hit = tryExt(`.${ext}`)
    if (hit) return hit
  }
  // Not for a directory: resolveFileOrDir probes its index, which maps.
  if (!opts.typescript || isDir(base, opts.host)) return null
  return fromOutputSource(base, (input) => outsideNodeModules(resolveSourceFile(input, { ...opts, outputs: null }), opts.host), opts)
}

// `exports` is not consulted: Node applies it only to bare package names.
function resolveFileOrDir(base, opts, tried) {
  const asResolution = (hit) => (hit === null ? null : fileResolution(hit, opts.host))
  const file = asResolution(resolveSourceFile(base, opts))
  if (file) return file
  if (isDir(base, opts.host)) {
    const dpkg = opts.read(join(base, 'package.json'))
    if (dpkg) {
      const entry = entryThroughMap(mergeRedirectMap(dpkg, opts.mainFields), packageEntry(dpkg, opts.mainFields))
      if (entry === false) return { empty: true }
      // Node's LOAD_AS_DIRECTORY: `main` as a file, else as a directory index; a broken one falls back to the index.
      const entryBase = join(base, entry)
      const entryOpts = { ...opts, pkgDir: base } // the package naming the entry, for its unbuilt output
      const inner = asResolution(resolveSourceFile(entryBase, entryOpts) ?? resolveSourceFile(join(entryBase, 'index'), entryOpts))
      if (inner) return inner
      tried.push(entryBase)
    }
    return asResolution(resolveSourceFile(join(base, 'index'), opts))
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
  // Each resolver reads its own manifests, so a build on the disk reads each as it is then.
  const manifests = hostMemo(host)
  const read = (path) => manifests(path, () => readManifest(path, host))
  const outputs = typescript ? typescriptPaths?.outputs ?? tsconfigOutputsOf({ host }) : null
  const opts = { platform, preferNative, sourceExts, mainFields, typescript, outputs, host, read }
  // An importer in node_modules gets no --typescript mapping, wherever its import lands.
  const fromNodeModules = { ...opts, typescript: false }
  // Node answers a builtin name with the builtin, so a package named like one resolves through this, builtins off.
  const packageResolver = createNodeResolver(host)
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
  // `conds`: scan's, by the parent's format. What a miss tried goes in `tried`, the missTargets.
  const resolve = (parentFile, specifier, conds, tried) => {
    const fileOpts = typescript && inNodeModules(parentFile, host) ? fromNodeModules : opts
    const probe = (base) => {
      const hit = resolveFileOrDir(base, fileOpts, tried)
      if (hit === null) tried.push(base)
      return hit
    }
    const viaNode = (spec) => {
      try {
        if (!isBuiltin(spec)) return fileResolution(host.resolve(parentFile, spec, conds), host)
        return fileResolution(packageResolver.resolve(parentFile, spec, conds, { builtins: false }), host)
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
      const r = isPathSpec(spec) ? matchRedirect(map, `./${toPosix(relative(imp.pkgDir, pathFrom(dirname(parentFile), spec)))}`) : map.get(spec)
      if (r === false) return { empty: true }
      if (typeof r === 'string') {
        // A path target is relative to the package root, not the importing file; a bare one is resolved below.
        if (isPathSpec(r)) return probe(pathFrom(imp.pkgDir, r))
        spec = r
      }
    }
    if (isPathSpec(spec)) return probe(pathFrom(dirname(parentFile), spec))
    if (isBuiltin(spec)) return spec.startsWith('node:') ? { builtin: true } : (viaPackage(spec) ?? { builtin: true })
    return viaPackage(spec)
  }
  // --typescript: a miss of the whole field flow, and only a miss, gets the scanner's fallback too.
  const resolveWithTypescriptFallback = (parentFile, specifier, conds, tried) => {
    const resolved = resolve(parentFile, specifier, conds, tried)
    // Under --metro an asset is Metro's asset rule's to resolve, as tsc never does.
    if (resolved || !typescript || (metro && isAssetFile(specifier, assetExts))) return resolved
    const hit = resolveTypescriptFallback(parentFile, specifier, { conditions: conds, paths: typescriptPaths, host })
    if (hit != null) return fileResolution(hit, host)
    tried.push(...typescriptAliasTargets(parentFile, specifier, typescriptPaths, host))
    return null
  }
  // Once per directory (all a file's resolving reads), specifier and conditions, kept as the manifests are and in `kept`.
  const resolutions = hostMemo(host, { across: kept })
  const of = (parentFile, specifier, callConditions) => resolutions(`${dirname(parentFile)}\0${specifier}\0${[...callConditions ?? conditions].join('\0')}`, () => {
    const tried = []
    return { resolution: resolveWithTypescriptFallback(parentFile, specifier, new Set(callConditions ?? conditions), tried), tried }
  })
  return Object.assign((parentFile, specifier, callConditions) => of(parentFile, specifier, callConditions).resolution, {
    missTargets: (parentFile, specifier, callConditions) => of(parentFile, specifier, callConditions).tried,
  })
}

// What scan.js gives a custom resolver: a bundler's base, not Node's. esbuild, webpack and Metro assert
// `import`/`require` and `default`, never `node`, so an `exports` map listing `node` first can't win over the extras.
export function resolveConditions(format, extras = []) {
  const esm = format === 'module' || format === 'module-typescript'
  return [...new Set([esm ? 'import' : 'require', 'default', ...extras])]
}
