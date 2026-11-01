import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { Bundle } from '@exodus/stasis-core/bundle'
import { State } from '@exodus/stasis-core/state'
import { toPosix } from '@exodus/stasis-core/util'
import { StasisEsbuild } from '@exodus/stasis-plugins/esbuild'
import { bundleDirHost } from '@exodus/stasis-plugins/metro-native'
import { assetsDestFiles } from '@preventive/rn/assets-dest.js'
import { assetData, assetModule } from '@preventive/rn/metro-assets.js'
import { HERMES_UNSUPPORTED, createBabelConfigTransform, createHermesTransform } from '../babel.js'
import { bundleFromLockfile } from '../bundle-from-lockfile.js'
import { METRO_RELEASE_DEFINE } from '../define.js'
import { FLOW_EXTS, hasFlowPragma, stripFlowTypes } from '../flow.js'
import { ASSET_REGISTRY, assetRegistryResolver } from '../metro-assets.js'
import { parseFileWithKind } from '../parse.js'
import { writeFile } from './output.js'

export { bundleFromLockfile }

const JS_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx'])

// Allowlist (not blocklist) of per-file formats `stasis build` accepts, so a bundle
// format added later fails closed here rather than in a cryptic esbuild error.
const BUILDABLE_FORMATS = new Set([
  'module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript',
  'resource', 'resource:base64', 'directory', 'stat:file', 'stat:directory',
])

// esbuild is an optional peer dep; resolve it from the local install, else fall back
// to a global one.
async function importEsbuild() {
  let mod
  try {
    mod = await import('esbuild')
  } catch (cause) {
    // Only a genuine "not installed" miss falls through to the global lookup; surface other failures.
    if (cause?.code !== 'ERR_MODULE_NOT_FOUND' && cause?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw cause
    }
    const globalMain = resolveGlobalEsbuild()
    if (!globalMain) {
      throw new Error(
        'stasis build requires esbuild, which could not be found.\n' +
        'Install it as a dev dependency (npm i -D esbuild / pnpm add -D esbuild / yarn add -D esbuild) ' +
        'or globally (npm i -g esbuild).',
        { cause }
      )
    }
    mod = await import(pathToFileURL(globalMain).href)
  }
  // A globally-imported CJS copy may land its exports on `default` -- accept both shapes.
  return typeof mod.build === 'function' ? mod : mod.default
}

function resolveGlobalEsbuild() {
  const probes = [
    ['npm', ['root', '-g']],
    ['pnpm', ['root', '-g']],
    ['yarn', ['global', 'dir']],
  ]
  for (const [cmd, args] of probes) {
    let out
    try {
      out = spawnSync(cmd, args, { encoding: 'utf8' })
    } catch {
      continue
    }
    if (!out || out.status !== 0 || !out.stdout) continue
    const base = out.stdout.trim()
    if (!base) continue
    // `npm/pnpm root -g` print the global node_modules dir; `yarn global dir` prints a
    // dir whose node_modules holds the packages. Try both shapes.
    for (const nm of [base, join(base, 'node_modules')]) {
      if (!existsSync(join(nm, 'esbuild', 'package.json'))) continue
      try {
        return createRequire(join(nm, 'noop.js')).resolve('esbuild')
      } catch {
      }
    }
  }
  return undefined
}

// Preconditions independent of which entry we build. Per-entry language checks are deferred
// to assertBuildableEntry, once selectEntry has picked one.
function assertBuildableArtifact(artifact, label) {
  if (artifact.config.scope !== 'full') {
    throw new Error(
      `stasis build requires a full-scope artifact; ${label} is scope='${artifact.config.scope}'. ` +
      `node_modules-scope artifacts omit the entry and workspace code, so there is nothing to build.`
    )
  }
  if (artifact.entries.size === 0) {
    throw new Error(`stasis build: ${label} declares no entries to build`)
  }
}

// The entry plus its transitive imports in the recorded graph -- the exact set esbuild loads
// (all conditions buckets; a --metro edge's per-platform targets included).
function reachableFiles(entry, imports) {
  const seen = new Set([entry])
  const stack = [entry]
  while (stack.length > 0) {
    const parent = stack.pop()
    for (const [, byParent] of imports) {
      const specifiers = byParent.get(parent)
      if (specifiers === undefined) continue
      for (const [, target] of specifiers) {
        // A plain edge is a file string; a --metro edge is a {platform: file} Map.
        const targets = typeof target === 'string' ? [target] : [...target.values()]
        for (const file of targets) {
          if (!seen.has(file)) {
            seen.add(file)
            stack.push(file)
          }
        }
      }
    }
  }
  return seen
}

// Language checks scoped to the built entry: it must be JS/TS, and every file reachable from
// it must be buildable. A non-JS file elsewhere (another entry, or a `stasis add` attachment)
// isn't reached, so it doesn't block the build. imports/formats are null on a legacy lockfile.
function assertBuildableEntry(artifact, entry, label) {
  if (!JS_EXTS.has(extname(entry))) {
    throw new Error(`stasis build only builds JavaScript/TypeScript entries (esbuild); got non-JS entry '${entry}' in ${label}`)
  }
  const reachable = reachableFiles(entry, artifact.imports ?? new Map())
  // A reachable resource (plugin captures DO record asset edges) stays allowed via BUILDABLE_FORMATS;
  // an entry that imports an unbuildable asset fails later at esbuild, not here.
  for (const [file, format] of artifact.formats ?? new Map()) {
    if (!reachable.has(file)) continue
    if (!BUILDABLE_FORMATS.has(format)) {
      throw new Error(`stasis build only supports JavaScript/TypeScript bundles (esbuild); ${label} carries a '${format}' file (${file})`)
    }
  }
}

// Pick which recorded entry to build; required only when several are recorded. Matched
// against the recorded project-relative entries (verbatim, `./`-stripped, or cwd-relative).
function selectEntry(entryArg, entries, { cwd, root, label }) {
  const recorded = [...entries]
  const list = recorded.map((e) => `  ${e}`).join('\n')
  if (entryArg === undefined) {
    if (recorded.length === 1) return recorded[0]
    // length === 0 is impossible here (assertBuildableArtifact required >= 1 entry).
    throw new Error(`stasis build: ${label} has ${recorded.length} entry points; pass one as the second argument:\n${list}`)
  }
  const candidates = new Set([
    entryArg,
    entryArg.replace(/^\.\//u, ''),
    relative(root, resolve(cwd, entryArg)).split(sep).join('/'),
  ])
  const match = recorded.find((e) => candidates.has(e))
  if (match === undefined) {
    throw new Error(`stasis build: '${entryArg}' is not an entry point of ${label}; available:\n${list}`)
  }
  return match
}

// Build a bundle-load State that serves an in-memory Bundle. skipDiscovery does NO
// filesystem discovery (no package.json walk, no on-disk config, no stray stasis.code.br).
function loadStateForBundle(root, bundle) {
  const state = new State(root, { bundle: 'load', lock: 'ignore', scope: bundle.config.scope, skipDiscovery: true })
  const sources = new Map()
  const resources = new Map()
  for (const [file, content] of bundle.sources) {
    if (Bundle.isResourceFormat(bundle.formats.get(file))) resources.set(file, content)
    else sources.set(file, content)
  }
  state.sources = sources
  state.resources = resources
  state.formats = bundle.formats
  state.imports = bundle.imports
  state.entries = new Set(bundle.entries)
  // Not state.executable either: like state.modules below, the load path never reads it, and every
  // consumer narrows against state.modules -- which is empty here -- so copying it would be inert.
  // Not state.modules: the load path never reads it (only the capture paths write it).
  return state
}

// A file's bytes as the State serves them: a Buffer for a base64 resource, else a string.
const asBytes = (source) => (Buffer.isBuffer(source) ? source : Buffer.from(source))

// The bytes the artifact carries for `file` (a path from the State's root, or an absolute one), verified
// by getFile.
const readCarried = (state, file) => asBytes(state.getFile(pathToFileURL(resolve(state.root, file)).toString()).source)

// --metro=PLATFORM's resource hook (StasisEsbuild's `resource`): each resource the build reaches -- in a
// --metro bundle, a Metro asset, as it records an import edge to no other -- served as the module
// Metro builds of it for `platform` (@preventive/rn's assetData and assetModule), from the files of the
// asset the artifact carries in its directory, at its path from the project root. The module's require
// of the asset registry resolves to the file the artifact carries for it (metro-assets.js), an edge
// added to the State's graph: the bundle records none, as Metro adds it past the source. `built`
// collects each asset's data for --assets-dest.
function metroAssetResource(state, platform, built) {
  const listing = bundleDirHost(state)
  const registryFor = assetRegistryResolver(platform, state.sources)
  return (source, { path }) => {
    const rel = toPosix(state.relative(path))
    // The files the artifact carries, the asset's own bytes those the plugin serves it by.
    const host = {
      readdir: (dir) => listing.readdir(dir).map(({ name }) => name),
      readFile: (file) => (file === path ? asBytes(source) : readCarried(state, file)),
    }
    const data = assetData(path, { urlPath: rel, platform, host })
    state.addImport(pathToFileURL(path).href, ASSET_REGISTRY, pathToFileURL(resolve(state.root, registryFor(rel))).href)
    built.set(rel, data)
    return { contents: assetModule(data, ASSET_REGISTRY), loader: 'js' }
  }
}

// --flow's per-file transform (StasisEsbuild's `transform` hook shape), as `stasis bundle --flow` reads
// a file: a JS-family one marked `@flow` (hasFlowPragma) that esbuild can't parse gets its Flow types
// stripped (flow.js), an import listing types alone dropped whole, as Babel's Flow transform drops it
// (a --metro bundle records no edge for it). One not marked, or that parses, is never touched, as
// stripping plain JS as Flow can misread it (`a < b > (c)` as a call). A file still unparseable fails
// the build in esbuild: Flow syntax that is code, which stripping leaves, or one flow-remove-types
// itself can't parse, served as it is.
function createFlowTransform(esbuild) {
  return async (source, { path, loader }) => {
    if (!FLOW_EXTS.has(extname(path)) || !hasFlowPragma(String(source))) return undefined
    try {
      await esbuild.transform(source, { loader, sourcefile: path, logLevel: 'silent' })
      return undefined
    } catch {
      try {
        return { contents: stripFlowTypes(source, { removeEmptyImports: true }), loader }
      } catch {
        return undefined
      }
    }
  }
}

// Two transform hooks over a file in turn, the second over what the first made of it.
const chainTransforms = (first, second) => async (source, file) => {
  const firstMade = await first(source, file)
  return (await second(firstMade?.contents ?? source, { ...file, loader: firstMade?.loader ?? file.loader })) ?? firstMade
}

const CONFIG_FILE = 'stasis.config.json'

// A list option as the command line takes one, as an array of strings or one string, each split at commas.
const listOf = (value) => [value].flat().flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)

// The options of `entry` in the `entries` of the stasis.config.json the artifact carries at its root
// (`state`'s), read by `stasis build` itself, apart from how `stasis bundle` builds by them: of each
// entry's options, those that say how its code is built -- `jsx` (as --loader=.js:jsx), `flow`,
// `define` (its K=V strings, one or an array) and `metro` with its `platforms` (a list, as on the
// command line); the rest are the bundle's. An entry is named as `stasis bundle` names it, by its path
// from the config's directory. -> { jsx, flow, define, platforms } (`platforms` only under `metro`),
// or null where the artifact carries no config, or it names no such entry
function configEntryOptions(state, entry) {
  if (!state.sources.has(CONFIG_FILE) && !state.resources.has(CONFIG_FILE)) return null
  let config
  try {
    config = JSON.parse(readCarried(state, CONFIG_FILE).toString('utf8'))
  } catch (cause) {
    throw new Error(`stasis build: the artifact's ${CONFIG_FILE} is not valid JSON`, { cause })
  }
  const entries = config?.entries
  if (entries === undefined) return null
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isObject(entries)) throw new Error(`stasis build: the artifact's ${CONFIG_FILE}: entries must be an object`)
  const name = Object.keys(entries).find((key) => toPosix(relative(state.root, resolve(state.root, key))) === entry)
  if (name === undefined) return null
  const what = `the artifact's ${CONFIG_FILE}: entries ${JSON.stringify(name)}`
  const options = entries[name]
  if (!isObject(options)) throw new Error(`stasis build: ${what} must be an object of options`)
  for (const flag of ['jsx', 'flow', 'metro']) {
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean') throw new Error(`stasis build: ${what}: ${flag} must be true or false`)
  }
  const strings = (flag) => {
    const value = options[flag] ?? []
    if (typeof value !== 'string' && !(Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
      throw new Error(`stasis build: ${what}: ${flag} must be a string or an array of strings`)
    }
    return [value].flat()
  }
  const define = {}
  for (const pair of strings('define')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new Error(`stasis build: ${what}: define must be KEY=VALUE (got '${pair}')`)
    define[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  let platforms
  if (options.metro === true) {
    platforms = [...new Set(listOf(strings('platforms')))]
    if (platforms.length === 0) throw new Error(`stasis build: ${what} sets metro but names no platforms`)
  }
  return { name, jsx: options.jsx === true, flow: options.flow === true, define, platforms }
}

// Run `stasis build`: run esbuild over one recorded entry, following the artifact's
// recorded import graph EXACTLY (not esbuild's resolver). A specifier the artifact records
// is always followed from the artifact; `external` only steers the specifiers it doesn't.
export async function buildCommand({
  cwd = process.cwd(),
  artifact,
  entry,
  output,
  format,
  platform = 'node',
  babel = false,
  flow = false,
  minify = false,
  sourcemap = false,
  define = {},
  external = [],
  loader = {},
  metro,
  assetsDest,
} = {}) {
  if (!artifact) throw new Error('stasis build: an artifact (bundle or lockfile) is required')
  if (!output) throw new Error('stasis build: --output is required (a .js/.cjs/.mjs file, or a directory)')
  if (!Array.isArray(external)) throw new Error('stasis build: external must be an array of esbuild patterns')
  if (metro !== undefined && (typeof metro !== 'string' || !/^[^/,]+$/u.test(metro))) {
    throw new Error(`stasis build: --metro takes the platform to build for, e.g. --metro=ios (got '${metro}')`)
  }
  if (flow && babel) {
    throw new Error('stasis build: --babel hands the project\'s Babel config each file as it is, Flow included, for it to compile; --flow strips Flow before esbuild without it -- pass one')
  }
  // --platform=hermes is a stasis-level target, not an esbuild platform (esbuild gets
  // 'neutral'): every code file is downleveled to Hermes' dialect before the final bundle,
  // and the bundle itself must avoid ESM -- Hermes has no import/export.
  const hermes = platform === 'hermes'
  format ??= hermes ? 'iife' : 'esm'
  if (hermes && format === 'esm') {
    throw new Error('stasis build: --platform=hermes cannot emit ESM (Hermes has no import/export); use --format=iife (the hermes default) or cjs')
  }
  const artifactAbs = resolve(cwd, artifact)
  const { kind, artifact: parsed } = parseFileWithKind(artifactAbs)
  assertBuildableArtifact(parsed, artifact)

  // Anchor artifact-relative paths at the artifact's own directory; a lockfile's sources
  // are read + verified from there.
  const root = dirname(artifactAbs)
  const selectedEntry = selectEntry(entry, parsed.entries, { cwd, root, label: artifact })
  assertBuildableEntry(parsed, selectedEntry, artifact)

  const bundle = kind === 'lockfile' ? bundleFromLockfile(parsed, { root }) : parsed
  const state = loadStateForBundle(root, bundle)
  // Make the entry absolute against the State's root so resolution is independent of process cwd.
  const entryPoint = resolve(state.root, selectedEntry)

  // The entry's options in the stasis.config.json the artifact carries, under the flags given: jsx as
  // --loader=.js:jsx, flow as --flow (not under --babel, whose config compiles Flow itself), its define
  // under --define's, and metro as --metro for its one platform; of several, --metro picks one, which
  // must be one of them.
  const configured = configEntryOptions(state, selectedEntry)
  if (configured !== null) {
    const taken = []
    if (configured.jsx && loader['.js'] === undefined) {
      loader = { ...loader, '.js': 'jsx' }
      taken.push('--loader=.js:jsx')
    }
    if (configured.flow && !flow && !babel) {
      flow = true
      taken.push('--flow')
    }
    for (const [key, value] of Object.entries(configured.define)) {
      if (Object.hasOwn(define, key)) continue
      define = { ...define, [key]: value }
      taken.push(`--define=${key}=${value}`)
    }
    const { platforms } = configured
    if (platforms !== undefined) {
      const choices = platforms.map((name) => `--metro=${name}`).join(' or ')
      const what = `${CONFIG_FILE} bundles ${selectedEntry} for ${platforms.join(', ')}`
      if (metro === undefined && platforms.length > 1) throw new Error(`stasis build: ${what}: pass ${choices}`)
      if (metro !== undefined && !platforms.includes(metro)) throw new Error(`stasis build: --metro=${metro}, but ${what} alone: pass ${choices}`)
      if (metro === undefined) {
        metro = platforms[0]
        taken.push(`--metro=${metro}`)
      }
    }
    if (taken.length > 0) console.warn(`[stasis] ${selectedEntry}: ${taken.join(' ')}, as ${CONFIG_FILE}'s entries ${JSON.stringify(configured.name)} sets`)
  }
  // --metro, given or the config's, builds as `stasis bundle --metro` reads the files: JSX in .js
  // (--loader=.js:jsx, where no --loader names .js), Flow stripped (--flow, not under --babel, whose
  // config compiles it), and each of METRO_RELEASE_DEFINE's names defined as Metro's release build
  // defines it, where neither --define nor the config gives it a value, as esbuild takes one (JS):
  // outside Metro's prelude, `__DEV__` is no global at all.
  if (metro !== undefined) {
    if (loader['.js'] === undefined) loader = { ...loader, '.js': 'jsx' }
    if (!babel) flow = true
    for (const [key, value] of Object.entries(METRO_RELEASE_DEFINE)) {
      if (!Object.hasOwn(define, key)) define = { ...define, [key]: JSON.stringify(value) }
    }
  }
  if (assetsDest !== undefined && metro === undefined) {
    throw new Error('stasis build: --assets-dest copies the assets --metro builds; pass --metro=PLATFORM with it')
  }

  const esbuild = await importEsbuild()
  // Per-file code rewrites the plugin applies before esbuild parses a served file:
  // --babel runs the project's own babel.config.* over the original source (no esbuild
  // pre-transform), and otherwise --platform=hermes uses the built-in downlevel pipeline.
  // Both resolve Babel from the project (cwd), never from stasis's own dependencies. --flow
  // strips Flow types first, from what esbuild can't parse.
  let transform
  if (babel) transform = createBabelConfigTransform({ projectDir: cwd })
  else if (hermes) transform = createHermesTransform({ projectDir: cwd, esbuild })
  if (flow) transform = transform === undefined ? createFlowTransform(esbuild) : chainTransforms(createFlowTransform(esbuild), transform)
  // --metro=PLATFORM: PLATFORM's target of each per-platform edge, and each asset as Metro builds it.
  const builtAssets = new Map()
  const resource = metro === undefined ? undefined : metroAssetResource(state, metro, builtAssets)

  const outAbs = resolve(cwd, output)
  const asFile = /\.[cm]?js$/u.test(output)
  // Never overwrite a file the artifact attests: esbuild's own overwrite check fires only
  // after writing (corrupting a lockfile's hash), so we build write:false and refuse to
  // clobber any recorded file before touching disk.
  const attested = new Set([...state.sources.keys(), ...state.resources.keys()].map((f) => resolve(state.root, f)))

  let result
  try {
    result = await esbuild.build({
      entryPoints: [entryPoint],
      absWorkingDir: state.root,
      bundle: true,
      write: false,
      platform: hermes ? 'neutral' : platform,
      format,
      logLevel: 'silent',
      ...(hermes ? { supported: HERMES_UNSUPPORTED } : {}),
      ...(minify ? { minify: true } : {}),
      ...(sourcemap ? { sourcemap: true } : {}),
      ...(external.length > 0 ? { external } : {}),
      ...(Object.keys(define).length > 0 ? { define } : {}),
      ...(asFile ? { outfile: outAbs } : { outdir: outAbs }),
      // Loader overrides go through the plugin: it serves every in-bundle file, so esbuild's
      // own `loader` option never sees them. e.g. { '.js': 'jsx' } to parse JSX in .js files.
      plugins: [new StasisEsbuild(state, { loaders: new Map(Object.entries(loader)), transform, resource, platform: metro })],
    })
  } catch (err) {
    // Under logLevel:'silent' esbuild puts the real errors on err.errors; surface them, then fail.
    if (Array.isArray(err?.errors) && err.errors.length > 0) {
      const formatted = await esbuild.formatMessages(err.errors, { kind: 'error', color: false })
      for (const line of formatted) process.stderr.write(line)
      // A resource the build reaches with no loader for its extension: what builds one.
      const unloaded = err.errors.map((e) => /^No loader is configured for "([^"]+)" files/u.exec(e.text)?.[1]).find(Boolean)
      if (unloaded !== undefined) {
        process.stderr.write(
          `[stasis] Build a "${unloaded}" resource with --loader=${unloaded}:NAME (an esbuild loader: dataurl, file, text, ...), ` +
          `or with --metro=PLATFORM as the asset module Metro builds of it\n`
        )
      }
      if (metro === undefined && err.errors.some((e) => e.detail?.code === 'ERR_STASIS_PLATFORM_SPECIFIC')) {
        process.stderr.write('[stasis] A --metro multi-platform bundle builds for one platform at a time: pass --metro=PLATFORM (e.g. --metro=ios)\n')
      }
      throw new Error(`stasis build failed: esbuild reported ${err.errors.length} error(s)`, { cause: err })
    }
    throw err
  }

  // --assets-dest's copies of the assets built, as `react-native bundle --assets-dest` lays them out for
  // the platform (@preventive/rn's assetsDestFiles), from the bytes the artifact carries, in a stable
  // order (esbuild loads in parallel).
  const assetFiles = assetsDest === undefined
    ? []
    : assetsDestFiles([...builtAssets.keys()].toSorted().map((rel) => builtAssets.get(rel)), metro)
        .map(({ dest, src, contents }) => ({ path: resolve(cwd, assetsDest, dest), contents: contents ?? readCarried(state, src) }))
  const writes = [...result.outputFiles, ...assetFiles]

  // Refuse to clobber an attested source, checked against the actual output paths before any write.
  for (const { path } of writes) {
    if (attested.has(path)) {
      throw new Error(
        `stasis build: refusing to write '${relative(cwd, path)}' -- it is a source the artifact records; ` +
        `choose an --output${assetsDest === undefined ? '' : '/--assets-dest'} path outside the artifact's own files`
      )
    }
  }

  if (result.warnings.length > 0) {
    const formatted = await esbuild.formatMessages(result.warnings, { kind: 'warning', color: false })
    for (const line of formatted) process.stderr.write(line)
  }

  for (const { path, contents } of writes) writeFile(path, contents)

  console.warn(`[stasis] Built ${selectedEntry} from ${kind} ${artifact} to ${output}`)
  if (assetsDest !== undefined) {
    console.warn(`[stasis] Copied ${builtAssets.size} asset${builtAssets.size === 1 ? '' : 's'} (${assetFiles.length} file${assetFiles.length === 1 ? '' : 's'}) for ${metro} to ${assetsDest}`)
  } else if (builtAssets.size > 0) {
    console.warn(`[stasis] Built ${builtAssets.size} asset${builtAssets.size === 1 ? '' : 's'} for ${metro}; pass --assets-dest to copy their files out`)
  }
  return { entry: selectedEntry, dir: asFile ? undefined : outAbs, outfile: asFile ? outAbs : undefined }
}
