import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { Bundle } from '@exodus/stasis-core/bundle'
import { State } from '@exodus/stasis-core/state'
import { CONFIG_FILE, isPlainObject, JS_EXTENSIONS, toPosix } from '@exodus/stasis-core/util'
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

// An allowlist, so that a bundle format added later fails closed here rather than in a cryptic esbuild error.
const BUILDABLE_FORMATS = new Set([
  'module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript',
  'resource', 'resource:base64', 'directory', 'stat:file', 'stat:directory',
])

// esbuild is an optional peer dependency: the local install's, else a global one.
async function importEsbuild() {
  let mod
  try {
    mod = await import('esbuild')
  } catch (cause) {
    if (cause?.code !== 'ERR_MODULE_NOT_FOUND' && cause?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw cause
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
  // A globally-imported CJS copy may land its exports on `default`.
  return typeof mod.build === 'function' ? mod : mod.default
}

function resolveGlobalEsbuild() {
  for (const [cmd, args] of [['npm', ['root', '-g']], ['pnpm', ['root', '-g']], ['yarn', ['global', 'dir']]]) {
    let out
    try {
      out = spawnSync(cmd, args, { encoding: 'utf8' })
    } catch {
      continue
    }
    const base = out?.status === 0 ? out.stdout?.trim() : undefined
    if (!base) continue
    // `npm/pnpm root -g` print the global node_modules; `yarn global dir` a dir whose node_modules holds them.
    for (const nm of [base, join(base, 'node_modules')]) {
      if (!existsSync(join(nm, 'esbuild', 'package.json'))) continue
      try {
        return createRequire(join(nm, 'noop.js')).resolve('esbuild')
      } catch { /* try the next */ }
    }
  }
  return undefined
}

function assertBuildableArtifact(artifact, label) {
  if (artifact.config.scope !== 'full') {
    throw new Error(
      `stasis build requires a full-scope artifact; ${label} is scope='${artifact.config.scope}'. ` +
      `node_modules-scope artifacts omit the entry and workspace code, so there is nothing to build.`
    )
  }
  if (artifact.entries.size === 0) throw new Error(`stasis build: ${label} declares no entries to build`)
}

// As esbuild loads them: every conditions bucket's edges, every platform's target (a Set visits what is added to it).
function reachableFiles(entry, imports) {
  const seen = new Set([entry])
  for (const parent of seen) {
    for (const byParent of imports.values()) {
      for (const target of byParent.get(parent)?.values() ?? []) {
        for (const file of typeof target === 'string' ? [target] : target.values()) seen.add(file)
      }
    }
  }
  return seen
}

// Only what the entry reaches must be buildable: another entry or a `stasis add` attachment doesn't block it.
function assertBuildableEntry(artifact, entry, label) {
  if (!JS_EXTENSIONS.has(extname(entry))) {
    throw new Error(`stasis build only builds JavaScript/TypeScript entries (esbuild); got non-JS entry '${entry}' in ${label}`)
  }
  const reachable = reachableFiles(entry, artifact.imports ?? new Map())
  for (const [file, format] of artifact.formats ?? new Map()) {
    if (reachable.has(file) && !BUILDABLE_FORMATS.has(format)) {
      throw new Error(`stasis build only supports JavaScript/TypeScript bundles (esbuild); ${label} carries a '${format}' file (${file})`)
    }
  }
}

function selectEntry(entryArg, entries, { cwd, root, label }) {
  const recorded = [...entries]
  const list = recorded.map((e) => `  ${e}`).join('\n')
  if (entryArg === undefined) {
    if (recorded.length === 1) return recorded[0]
    throw new Error(`stasis build: ${label} has ${recorded.length} entry points; pass one as the second argument:\n${list}`)
  }
  const candidates = new Set([entryArg, entryArg.replace(/^\.\//u, ''), relative(root, resolve(cwd, entryArg)).split(sep).join('/')])
  const match = recorded.find((e) => candidates.has(e))
  if (match === undefined) throw new Error(`stasis build: '${entryArg}' is not an entry point of ${label}; available:\n${list}`)
  return match
}

// A bundle-load State serving `bundle`, with no discovery on disk (no package.json, config or stray stasis.code.br).
function loadStateForBundle(root, bundle) {
  const state = new State(root, { bundle: 'load', lock: 'ignore', scope: bundle.config.scope, skipDiscovery: true })
  state.sources = new Map()
  state.resources = new Map()
  for (const [file, content] of bundle.sources) {
    if (Bundle.isResourceFormat(bundle.formats.get(file))) state.resources.set(file, content)
    else state.sources.set(file, content)
  }
  state.formats = bundle.formats
  state.imports = bundle.imports
  state.entries = new Set(bundle.entries)
  // Not state.modules or state.executable: the load path reads neither.
  return state
}

const asBytes = (source) => (Buffer.isBuffer(source) ? source : Buffer.from(source))

// The bytes the artifact carries for `file`, verified by getFile.
const readCarried = (state, file) => asBytes(state.getFile(pathToFileURL(resolve(state.root, file)).toString()).source)

// Each Metro asset served as the module Metro builds of it, its require of the registry added as Metro adds it.
function metroAssetResource(state, platform, built) {
  const listing = bundleDirHost(state)
  const registryFor = assetRegistryResolver(platform, state.sources)
  return (source, { path }) => {
    const rel = toPosix(state.relative(path))
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

// --flow, as Metro's Babel builds a file: Flow types stripped from a file marked `@flow`, else only where
// esbuild can't parse it; what still doesn't parse fails the build in esbuild.
function createFlowTransform(esbuild) {
  return async (source, { path, loader }) => {
    if (!FLOW_EXTS.has(extname(path))) return undefined
    const text = String(source)
    if (!hasFlowPragma(text)) {
      try {
        await esbuild.transform(text, { loader, sourcefile: path, logLevel: 'silent' })
        return undefined
      } catch { /* stripped below */ }
    }
    try {
      return { contents: stripFlowTypes(text, { removeEmptyImports: true }), loader }
    } catch {
      return undefined
    }
  }
}

const chainTransforms = (first, second) => async (source, file) => {
  const firstMade = await first(source, file)
  return (await second(firstMade?.contents ?? source, { ...file, loader: firstMade?.loader ?? file.loader })) ?? firstMade
}

// `entry`'s options in the stasis.config.json the artifact carries that say how its code is built, or null.
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
  if (!isPlainObject(entries)) throw new Error(`stasis build: the artifact's ${CONFIG_FILE}: entries must be an object`)
  const name = Object.keys(entries).find((key) => toPosix(relative(state.root, resolve(state.root, key))) === entry)
  if (name === undefined) return null
  const what = `the artifact's ${CONFIG_FILE}: entries ${JSON.stringify(name)}`
  const options = entries[name]
  if (!isPlainObject(options)) throw new Error(`stasis build: ${what} must be an object of options`)
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
    platforms = [...new Set(strings('platforms').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean))]
    if (platforms.length === 0) throw new Error(`stasis build: ${what} sets metro but names no platforms`)
  }
  return { name, jsx: options.jsx === true, flow: options.flow === true, define, platforms }
}

// Run `stasis build`: esbuild over one recorded entry, following the artifact's recorded import graph exactly,
// not esbuild's resolver: `external` only steers the specifiers it doesn't record.
export async function buildCommand({
  cwd = process.cwd(), artifact, entry, output, format, platform = 'node', babel = false, flow = false, minify = false,
  sourcemap = false, define = {}, external = [], loader = {}, metro, assetsDest,
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
  // --platform=hermes is stasis's target, esbuild's 'neutral': code downleveled to Hermes' dialect, and no ESM.
  const hermes = platform === 'hermes'
  format ??= hermes ? 'iife' : 'esm'
  if (hermes && format === 'esm') {
    throw new Error('stasis build: --platform=hermes cannot emit ESM (Hermes has no import/export); use --format=iife (the hermes default) or cjs')
  }
  const artifactAbs = resolve(cwd, artifact)
  const { kind, artifact: parsed } = parseFileWithKind(artifactAbs)
  assertBuildableArtifact(parsed, artifact)

  // Paths are the artifact's directory's, where a lockfile's sources are read and verified.
  const root = dirname(artifactAbs)
  const selectedEntry = selectEntry(entry, parsed.entries, { cwd, root, label: artifact })
  assertBuildableEntry(parsed, selectedEntry, artifact)

  const bundle = kind === 'lockfile' ? bundleFromLockfile(parsed, { root }) : parsed
  const state = loadStateForBundle(root, bundle)
  const entryPoint = resolve(state.root, selectedEntry)

  // The config's options for the entry, under the flags given (flow not under --babel, whose config compiles it).
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
  // As `stasis bundle --metro` reads the files; METRO_RELEASE_DEFINE's names too, since outside Metro's
  // prelude `__DEV__` is no global at all.
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
  let transform
  if (babel) transform = createBabelConfigTransform({ projectDir: cwd })
  else if (hermes) transform = createHermesTransform({ projectDir: cwd, esbuild })
  if (flow) transform = transform === undefined ? createFlowTransform(esbuild) : chainTransforms(createFlowTransform(esbuild), transform)
  const builtAssets = new Map()
  const resource = metro === undefined ? undefined : metroAssetResource(state, metro, builtAssets)

  const outAbs = resolve(cwd, output)
  const asFile = /\.[cm]?js$/u.test(output)
  // Never overwrite a file the artifact attests: esbuild's own overwrite check fires only after writing
  // (corrupting a lockfile's hash), so it builds write:false and each output is checked before any is written.
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
      // Loaders go through the plugin: it serves every file, so esbuild's own `loader` option never sees them.
      plugins: [new StasisEsbuild(state, { loaders: new Map(Object.entries(loader)), transform, resource, platform: metro })],
    })
  } catch (err) {
    // Under logLevel:'silent' esbuild puts the real errors on err.errors.
    if (Array.isArray(err?.errors) && err.errors.length > 0) {
      for (const line of await esbuild.formatMessages(err.errors, { kind: 'error', color: false })) process.stderr.write(line)
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

  // As `react-native bundle --assets-dest` lays them out, in a stable order (esbuild loads in parallel).
  const assetFiles = assetsDest === undefined
    ? []
    : assetsDestFiles([...builtAssets.keys()].toSorted().map((rel) => builtAssets.get(rel)), metro)
        .map(({ dest, src, contents }) => ({ path: resolve(cwd, assetsDest, dest), contents: contents ?? readCarried(state, src) }))
  const writes = [...result.outputFiles, ...assetFiles]
  for (const { path } of writes) {
    if (attested.has(path)) {
      throw new Error(
        `stasis build: refusing to write '${relative(cwd, path)}' -- it is a source the artifact records; ` +
        `choose an --output${assetsDest === undefined ? '' : '/--assets-dest'} path outside the artifact's own files`
      )
    }
  }

  if (result.warnings.length > 0) {
    for (const line of await esbuild.formatMessages(result.warnings, { kind: 'warning', color: false })) process.stderr.write(line)
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
