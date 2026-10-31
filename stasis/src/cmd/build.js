import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { Bundle } from '@exodus/stasis-core/bundle'
import { State } from '@exodus/stasis-core/state'
import { StasisEsbuild } from '@exodus/stasis-plugins/esbuild'
import { metroAssetFiles } from '@exodus/stasis-plugins/metro-native'
import { HERMES_UNSUPPORTED, createBabelConfigTransform, createHermesTransform } from '../babel.js'
import { bundleFromLockfile } from '../bundle-from-lockfile.js'
import { ASSET_REGISTRY, assetRegistryFile, metroAssetCopies, metroAssetDescriptor, metroAssetModule } from '../metro-assets.js'
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

const DIRECTORY_FORMATS = new Set(['directory', 'stat:directory'])
const FILE_STAT = { isFile: () => true }

// The bytes the artifact carries for `file` (a path from the State's root), verified by getFile.
function readCarried(state, file) {
  const { source } = state.getFile(pathToFileURL(resolve(state.root, file)).toString())
  return Buffer.isBuffer(source) ? source : Buffer.from(source)
}

// --metro=PLATFORM's resource hook (StasisEsbuild's `resource`): each resource the build reaches -- in a
// --metro bundle, a Metro asset, as it records an import edge to no other -- served as the module
// Metro builds of it for `platform` (metro-assets.js), from the files of the asset the artifact carries
// in its directory. The module's require of the asset registry resolves to the file the artifact
// carries for it (assetRegistryFile), an edge added to the State's graph: the bundle records none, as
// Metro adds it past the source. `built` collects each asset's { descriptor, files } for --assets-dest.
function metroAssetResource(state, platform, built) {
  const toRel = (abs) => relative(state.root, abs).split(sep).join('/') || '.'
  const carried = new Set(state.sources.keys())
  const listed = [...state.sources.keys(), ...state.resources.keys()].filter((file) => !DIRECTORY_FORMATS.has(state.formats.get(file)))
  const byDir = Map.groupBy(listed, (file) => posix.dirname(file))
  const host = {
    readdir: (dir) => (byDir.get(toRel(dir)) ?? []).map((file) => ({ name: posix.basename(file) })),
    stat: () => FILE_STAT,
  }
  const read = (file) => readCarried(state, file)
  // A copy of the '*' bucket takes the registry edges: the State shares the parsed artifact's maps.
  const edges = new Map(state.imports.get('*') ?? [])
  state.imports = new Map(state.imports).set('*', edges)
  return (source, { path }) => {
    const rel = toRel(path)
    const files = metroAssetFiles(path, platform, host).map(toRel)
    const { descriptor, files: byScale } = metroAssetDescriptor(rel, { platform, files, read })
    const registry = assetRegistryFile(rel, platform, carried)
    edges.set(rel, new Map([...(edges.get(rel) ?? []), [ASSET_REGISTRY, registry]]))
    built.set(rel, { descriptor, files: byScale })
    return { contents: metroAssetModule(descriptor), loader: 'js' }
  }
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
  if (assetsDest !== undefined && metro === undefined) {
    throw new Error('stasis build: --assets-dest copies the assets --metro builds; pass --metro=PLATFORM with it')
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

  const esbuild = await importEsbuild()
  // Per-file code rewrites the plugin applies before esbuild parses a served file:
  // --babel runs the project's own babel.config.* over the original source (no esbuild
  // pre-transform), and otherwise --platform=hermes uses the built-in downlevel pipeline.
  // Both resolve Babel from the project (cwd), never from stasis's own dependencies.
  let transform
  if (babel) transform = createBabelConfigTransform({ projectDir: cwd })
  else if (hermes) transform = createHermesTransform({ projectDir: cwd, esbuild })
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
      if (metro === undefined && err.errors.some((e) => /is platform-specific/u.test(e.text))) {
        process.stderr.write('[stasis] A --metro multi-platform bundle builds for one platform at a time: pass --metro=PLATFORM (e.g. --metro=ios)\n')
      }
      throw new Error(`stasis build failed: esbuild reported ${err.errors.length} error(s)`, { cause: err })
    }
    throw err
  }

  // What --assets-dest copies of the assets built, as `react-native bundle --assets-dest` copies them
  // for the platform, from the bytes the artifact carries; in a stable order (esbuild loads in parallel).
  const assetsAbs = assetsDest === undefined ? undefined : resolve(cwd, assetsDest)
  const assetCopies = assetsAbs === undefined
    ? []
    : metroAssetCopies(metro, [...builtAssets].toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([, asset]) => asset))
        .map((copy) => ({ ...copy, dest: resolve(assetsAbs, copy.dest) }))

  // Refuse to clobber an attested source, checked against esbuild's actual output paths before any write.
  for (const path of [...result.outputFiles.map((file) => file.path), ...assetCopies.map((copy) => copy.dest)]) {
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

  for (const file of result.outputFiles) writeFile(file.path, file.contents)

  console.warn(`[stasis] Built ${selectedEntry} from ${kind} ${artifact} to ${output}`)
  if (assetsAbs !== undefined) {
    for (const { dest, file, contents } of assetCopies) writeFile(dest, contents ?? readCarried(state, file))
    console.warn(`[stasis] Copied ${builtAssets.size} asset${builtAssets.size === 1 ? '' : 's'} (${assetCopies.length} file${assetCopies.length === 1 ? '' : 's'}) for ${metro} to ${assetsDest}`)
  } else if (builtAssets.size > 0) {
    console.warn(`[stasis] Built ${builtAssets.size} asset${builtAssets.size === 1 ? '' : 's'} for ${metro}; pass --assets-dest to copy their files out`)
  }
  return { entry: selectedEntry, dir: asFile ? undefined : outAbs, outfile: asFile ? outAbs : undefined }
}
