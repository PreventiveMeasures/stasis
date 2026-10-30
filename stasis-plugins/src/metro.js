import assert from 'node:assert/strict'
import { Buffer, isUtf8 } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { resolvePluginState } from './plugins.js'
import { looksNative, nativeInputs } from './metro-native.js'
import { diskHost } from '@exodus/stasis-core/host'
import { State } from '@exodus/stasis-core/state'
import { realReadFileSync } from '@exodus/stasis-core/state-util'
import { RN_CORE_INCLUDE_FILES, classifyExtension, classifyFormat, isPathWithin, metroAssetFiles, nodeExtFormat, splitNodeModulesPath } from '@exodus/stasis-core/util'

const require = createRequire(import.meta.url)

// The companion worker transformer withStasis() wires as Metro's `transformerPath`.
const TRANSFORMER = fileURLToPath(new URL('./metro-transformer.js', import.meta.url))

// A graph module's absolute path (graph modules and preModules both carry it), or undefined for a
// synthetic/virtual one (require.context's ?ctx=, __prelude__), with no on-disk bytes to hash.
function diskPath(module) {
  const modPath = module?.path
  return typeof modPath === 'string' && isAbsolute(modPath) && existsSync(modPath) ? modPath : undefined
}

// Metro's `graph.entryPoints` is a Set now, an Array before ~0.71; normalize to a Set.
function entrySet(graph) {
  const ep = graph?.entryPoints
  if (ep instanceof Set) return ep
  if (Array.isArray(ep)) return new Set(ep)
  return new Set()
}

// Files a React Native build requires that Metro's module graph never carries; attested (tagged by
// the shared classifier, see #captureAutoIncludes) when they resolve from the project, each under the
// consumer that uses it: Metro bundles asyncRequire.js into the app (for an `import()`); the React
// Native CLI runs setup_env.sh (`execFileSync`) as every command of it starts, `react-native config`
// the plugin runs included, which is the run's toolchain, none of it the app's.
const AUTO_INCLUDES = [
  { specifier: 'metro-runtime/src/modules/asyncRequire.js', reason: 'metro' },
  { specifier: '@react-native-community/cli/setup_env.sh', reason: 'run' },
]

// Metro's own transform plugins, as its transform worker names them for its cache key: the file
// `metro-transform-plugins` resolves to from the project, else through metro and its transform
// worker, which depend on it (a pnpm install links it only beside them). -> [] where none resolves
function metroTransformPluginFiles(projectDir) {
  for (const chain of [['metro-transform-plugins'], ['metro', 'metro-transform-worker', 'metro-transform-plugins']]) {
    let file
    try {
      for (const name of chain) file = require.resolve(name, { paths: [file === undefined ? projectDir : dirname(file)] })
    } catch {
      continue
    }
    const { getTransformPluginCacheKeyFiles } = require(file)
    return typeof getTransformPluginCacheKeyFiles === 'function' ? getTransformPluginCacheKeyFiles() : []
  }
  return []
}

// The worker-side toolchain that only Metro's transform workers load, named in both the
// --child-process assert and the transform-cache warning so the two can't describe different sets.
const WORKER_TOOLCHAIN = 'babel.config.js, @babel/core, the RN preset + plugins'

// Run `react-native config` (RN's autolinking resolver) for native deps. Null when the RN CLI
// isn't installed; THROWS when present but failing -- silently under-attesting breaks frozen runs.
function loadReactNativeConfig(projectDir) {
  let cliPath
  try {
    cliPath = require.resolve('react-native/cli.js', { paths: [projectDir] })
  } catch {
    return null
  }
  // Run the child as vanilla Node: strip stasis's env and any inherited loader, else it joins
  // this capture nondeterministically or aborts on a config it can't satisfy.
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('EXODUS_STASIS_')) delete env[key]
  }
  delete env.NODE_OPTIONS
  const res = spawnSync(process.execPath, [cliPath, 'config'], {
    cwd: projectDir,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024, // a large monorepo's config JSON can be many MB
    env,
  })
  if (res.error) {
    throw new Error(`StasisMetro: failed to run 'react-native config': ${res.error.message}`, { cause: res.error })
  }
  if (res.status !== 0) {
    const detail = (res.stderr || '').trim()
    throw new Error(
      `StasisMetro: 'react-native config' exited ${res.status}${res.signal ? ` on signal ${res.signal}` : ''}` +
      `${detail ? `: ${detail}` : ''}`
    )
  }
  try {
    return JSON.parse(res.stdout)
  } catch (cause) {
    throw new Error("StasisMetro: couldn't parse 'react-native config' output as JSON", { cause })
  }
}

// Native when at least one platform config is non-null; an all-null dep is JS-only (already in the graph).
function isNativeDependency(dep) {
  const platforms = dep?.platforms
  if (!platforms || typeof platforms !== 'object') return false
  return Object.values(platforms).some((p) => p != null)
}

// Metro has no public default-serializer export; reproduce its default output via internal
// baseJSBundle + bundleToString. Path moved: metro/src/* through ~0.82, metro/private/* from
// 0.81.4 on (the only option from 0.83), so the two-tier require below spans the range.
let metroDefault
function metroDefaultSerializer() {
  if (metroDefault) return metroDefault
  const M = 'metro'
  let baseJSBundle, bundleToString
  try {
    baseJSBundle = require(`${M}/src/DeltaBundler/Serializers/baseJSBundle`)
    bundleToString = require(`${M}/src/lib/bundleToString`)
  } catch {
    try {
      baseJSBundle = require(`${M}/private/DeltaBundler/Serializers/baseJSBundle`)
      bundleToString = require(`${M}/private/lib/bundleToString`)
    } catch (cause) {
      throw new Error(
        "StasisMetro: couldn't load Metro's default serializer (tried metro/src and " +
        'metro/private). Pass your existing customSerializer to withStasis()/customSerializer() instead.',
        { cause }
      )
    }
  }
  // Metro ships CJS; require exposes the fn as the namespace or under `.default`.
  baseJSBundle = baseJSBundle.default ?? baseJSBundle
  bundleToString = bundleToString.default ?? bundleToString
  metroDefault = (entryPoint, preModules, graph, options) =>
    bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code
  return metroDefault
}

// Stasis capture plugin for Metro (React Native). Hooks Metro's serializer, which runs ONCE in
// the MAIN process with the full module graph -- a per-worker transformer's process-local State
// could never be merged. This is the CAPTURE half; the companion ./metro-transformer.js runs in
// the workers, recording each import as written and serving the LOAD half, and withStasis wires
// both. Under bundle=load this serializer records nothing: Metro resolved every import itself,
// so it asserts each edge against the bundle (see #assertEdges).
// Capture is one-shot (dev-server rebuilds refused, see #run) and REQUIRES --child-process so the
// worker-side toolchain (babel, RN preset) is attested (enforced in the constructor). withStasis
// wires the stable customSerializer -- the only surface that receives preModules; serializerHook
// is a lower-coverage fallback that never sees them. Prefer withStasis for a second reason too: a
// hand-wired serializer leaves the Metro config -- and therefore its transform cache and
// transformerPath -- out of stasis's hands (see withStasis).
export class StasisMetro {
  #seen = new Set()
  // The project root's real path, once a consumed resource needs it (#consumedResources).
  #realRoot
  #state
  #resources

  // Base dir for resolution; snapshotted at construction so a later chdir can't skew capture.
  #projectDir = process.cwd()

  // Whether this instance already captured; the dev-server rebuild guard in #run trips on the second.
  #ran = false

  // Set by withStasis, which returns the Metro config and can therefore drop its transform cache;
  // a hand-wired customSerializer/serializerHook can't, so #run warns instead. Internal wiring, in
  // the second options bag like StasisEsbuild's -- not a user-facing option.
  #ownsConfig

  constructor(options = {}, { ownsConfig = false } = {}) {
    const { state } = resolvePluginState('StasisMetro', options, process.cwd())
    this.#state = state // null when the plugin should be inert (Rule 0 or Rule 7)
    this.#ownsConfig = ownsConfig
    // A capture-that-writes REQUIRES --child-process: the worker toolchain (babel, RN preset) is
    // observed only in workers. Gate on writeLockfile||writeBundle so it's demanded only when
    // forwarding does something (frozen/load verify per-process and need no channel).
    if (state && (state.config.writeLockfile || state.config.writeBundle)) {
      assert.ok(
        state.config.childProcess,
        'StasisMetro: child-process capture must be enabled -- Metro transforms in worker processes, ' +
        `and without it the toolchain they load (${WORKER_TOOLCHAIN}) ` +
        'is never attested. Enable it: `stasis run --child-process ...`, EXODUS_STASIS_CHILD_PROCESS=1, ' +
        'or "childProcess": true in stasis.config.json.'
      )
      // Opt this build's children into the loader's SIGTERM shard flush (handler in hooks.js) so
      // jest-worker forceExit doesn't silently drop a non-draining worker's shard. Key on the
      // PRELOAD's mode where one exists (the shard channel follows it, not a Rule-6 sidecar), and
      // use `||=` not `=` so an explicit ambient opt-out ('0'/'false') is honored.
      const channel = State.preload ?? state
      if (channel.config.writeLockfile || channel.config.writeBundle) {
        process.env.EXODUS_STASIS_SHARD_SIGNAL_FLUSH ||= '1'
      }
    }
    // Cache the resolved resources Set for the per-file classify hot path.
    this.#resources = state?.config.resources ?? new Set()
  }

  // True when this build's guarantees depend on Metro actually TRANSFORMING files: a capture records
  // what the workers load, frozen checks it, and load REPLAYS it -- all three break if a cached
  // transform skips the work. False only when inert or attesting nothing ('none'/'ignore', what
  // useLockfile/bundle exclude). Read by withStasis to decide whether to drop the transform cache.
  get needsTransforms() {
    const config = this.#state?.config
    if (!config) return false
    return config.useLockfile || config.bundle
  }

  // Build a Metro `serializer.customSerializer`: captures the graph + preModules (which the
  // experimental hook never sees), then delegates to base or reproduces Metro's default output.
  customSerializer(baseSerializer = undefined) {
    if (baseSerializer !== undefined && typeof baseSerializer !== 'function') {
      throw new TypeError('StasisMetro.customSerializer(base?): base must be a function or omitted')
    }
    // Inert (#state === null): hand the base straight back -- the wrapper below would otherwise
    // fall back to metroDefaultSerializer(), loading Metro internals a do-nothing plugin mustn't touch.
    if (!this.#state) return baseSerializer
    return (entryPoint, preModules, graph, options) => {
      this.#run(graph, preModules)
      const serialize = baseSerializer ?? metroDefaultSerializer()
      return serialize(entryPoint, preModules, graph, options)
    }
  }

  // `serializer.experimentalSerializerHook`: observation-only, and LOWER COVERAGE -- Metro never
  // passes preModules here, so the prepended polyfills/runtime go unattested. Prefer customSerializer.
  serializerHook = (graph, _delta) => {
    this.#run(graph)
  }

  #run(graph, preModules) {
    if (!this.#state) return
    // bundle=load: assert, don't record (the worker transformer serves the bundle's bytes). Checked
    // BEFORE the one-shot guard -- load captures nothing and legitimately re-serializes under a dev server.
    if (this.#state.config.loadBundle) {
      this.#assertEdges(graph, preModules)
      return
    }
    // Watch/dev-server capture is unsupported: dedupe is keyed by PATH not content, so a rebuild
    // with changed bytes would emit new bytes while the bundle/lockfile keep the OLD ones. Refuse
    // the second serialization loudly (the first rebuild is the earliest refusal point Metro allows).
    if (this.#ran) {
      throw new Error(
        'StasisMetro: watch/dev-server rebuilds are not supported for capture -- use a one-shot `metro build`'
      )
    }
    this.#ran = true
    // Keyed on ownership: a withStasis-built instance already dropped the stores (see withStasis).
    // Nothing here can detect a cache hit, so say it once rather than silently under-attest.
    if (!this.#ownsConfig && this.needsTransforms) {
      console.warn(
        "[stasis] StasisMetro: wired without withStasis(), so Metro's transform cache is outside " +
        `stasis's control -- a cached transform skips the worker and the toolchain it loads ` +
        `(${WORKER_TOOLCHAIN}) goes unattested. Wrap your config in withStasis(), or set ` +
        '`cacheStores: []` yourself for every stasis build.'
      )
    }
    this.#capture(graph, preModules)

    // The preload writes itself (hooks.js); standalone/sidecar States are written here. Reaching
    // serialization means a clean build (a failed build throws first), so no error gate is needed.
    if (this.#state !== State.preload) this.#state.write()
  }

  #capture(graph, preModules) {
    const entries = entrySet(graph)
    const platform = graph.transformOptions?.platform ?? null
    // preModules first (Metro's prepended polyfills/runtime; synthetic ones like __prelude__ are
    // skipped by the existsSync guard below), then the app graph.
    if (preModules) this.#captureModules(preModules, entries, platform)
    this.#captureModules(graph.dependencies.values(), entries, platform)
    // AFTER the graph so #seen already holds graph modules -- an auto-include that landed in the
    // graph (asyncRequire, when the app uses dynamic import()) is deduped, not re-recorded.
    this.#captureAutoIncludes()
    this.#captureTransformPlugins()
    // AFTER the graph + auto-includes (same dedupe reason): the native pass only adds the native
    // build-input surface (podspec/gradle/sources) that no module graph carries.
    this.#captureNativeModules()
  }

  // Shared epilogue for the classify-driven capture paths: record under the given format/resource,
  // attributed to `reason`. `format` null/undefined lets addFile pick (loader format for JS unless
  // `inferFormat` is false, byte-derived for a resource); addFile already asserts UTF-8 for a
  // non-resource (code) source, so no guard is needed here.
  #recordCapture(full, source, { format, resource, inferFormat = true, reason = 'metro' }) {
    this.#state.addFile(pathToFileURL(full).toString(), { source, format: format ?? undefined, resource, inferFormat, reason })
  }

  // Attest the AUTO_INCLUDES list. Per entry, skip: unresolvable, already-seen, or resolving
  // outside the project root (keys are root-relative). Attested entries ride the normal addFile path.
  #captureAutoIncludes() {
    for (const { specifier, reason } of AUTO_INCLUDES) {
      let modPath
      try {
        modPath = require.resolve(specifier, { paths: [this.#projectDir] })
      } catch {
        continue
      }
      if (this.#seen.has(modPath)) continue
      try {
        this.#state.relative(modPath)
      } catch {
        continue
      }
      this.#seen.add(modPath)
      // Real reader: plugin bookkeeping, not a program fs read -- must not be re-recorded by --fs.
      const source = realReadFileSync(modPath)
      // Tag from the ONE shared classifier so an auto-include agrees with any other path meeting
      // the same file (native walk, --fs): setup_env.sh -> 'shell', not a forced 'resource' that
      // would collide at the format noupsert. Unrecognized -> resource (vetted list, so no allowlist).
      // JS (asyncRequire.js) is code Metro builds, so it takes no format, as the graph's doesn't.
      const format = classifyFormat(modPath, { content: source })
      this.#recordCapture(modPath, source, { format, resource: format === undefined, inferFormat: false, reason })
    }
  }

  // Attest each of Metro's own transform plugins (metroTransformPluginFiles). Its transform worker
  // hashes every one into its cache key, but loads one only as the build's options call for it
  // (import-export-plugin under `experimentalImportSupport`, inline-requires-plugin under
  // `inlineRequires`, constant-folding-plugin outside dev, normalizePseudoGlobals when minifying), so
  // a capture loads them all, as Metro would: under `stasis run` the loader then records each with
  // what it imports, so a bundle builds under any of those options. Each is recorded besides, as the
  // Node module it is, where no loader records it, attributed to `run` as one Metro loads is: the
  // build's toolchain, none of it the app's. One outside the project root is passed over.
  #captureTransformPlugins() {
    for (const file of metroTransformPluginFiles(this.#projectDir)) {
      if (this.#seen.has(file)) continue
      try {
        this.#state.relative(file)
      } catch {
        continue
      }
      this.#seen.add(file)
      try {
        require(file)
      } catch { /* one that can't load can't run under Metro either: its bytes are still recorded */ }
      // Real reader: plugin bookkeeping, not a program fs read -- must not be re-recorded by --fs.
      this.#recordCapture(file, realReadFileSync(file), { reason: 'run' })
    }
  }

  // Attest each native dependency's build-input surface. Discovery is `react-native config`; each
  // dep root is walked (isSkippedNativeWalkDir pruned) and its native sources are attested as code,
  // other assets as resources, plus each package.json. Node-runnable JS/TS is skipped (already in
  // Metro's graph). Skipped when the RN CLI is absent or a root is outside root.
  #captureNativeModules() {
    const config = loadReactNativeConfig(this.#projectDir)
    if (!config) return
    const roots = new Set()
    // Autolinked native deps: linked into the app regardless of whether their JS is imported.
    for (const dep of Object.values(config.dependencies ?? {})) {
      if (isNativeDependency(dep) && typeof dep.root === 'string' && isAbsolute(dep.root)) roots.add(dep.root)
    }
    // Native modules the app imports but autolinking never reports (manually integrated via Podfile).
    for (const root of this.#reachedNativePackageRoots()) roots.add(root)
    // RN CORE isn't a `dependencies` entry (config reports only reactNativePath) and autolinking
    // never lists it, but its native source (React/, ReactCommon/, ReactAndroid/, sdks/, ...) is a
    // build input like any other dep's -- walk it in full, the same way.
    const rnPath = config.reactNativePath
    if (typeof rnPath === 'string' && isAbsolute(rnPath)) roots.add(rnPath)
    for (const root of roots) {
      try {
        this.#state.relative(root) // asserts the package lives inside the project root
      } catch {
        continue
      }
      this.#captureNativeTree(root)
    }
    // RN core's `.js` build scripts the walk skips (Metro-owned by extension, but never in the graph).
    if (typeof rnPath === 'string' && isAbsolute(rnPath)) {
      try {
        this.#state.relative(rnPath)
        for (const file of RN_CORE_INCLUDE_FILES) this.#captureNativeFile(join(rnPath, file))
      } catch { /* react-native resolved outside the project root -- unattestable */ }
    }
  }

  // Attest a single vetted file (RN_CORE_INCLUDE_FILES) the tree walk skips; absent -> skipped.
  // Tagged via the shared classifier like every other path (a `.js` build script -> code).
  #captureNativeFile(full) {
    if (this.#seen.has(full)) return
    let source
    try {
      source = realReadFileSync(full)
    } catch {
      return
    }
    this.#seen.add(full)
    const format = classifyFormat(full, { content: source })
    this.#recordCapture(full, source, { format, resource: format === undefined })
  }

  // node_modules roots the graph reached that also ship native code (podspec or ios/android dir):
  // the manually-integrated native modules `react-native config` omits. Derived from #seen; RN core
  // is skipped here because it's added to the walk explicitly (via reactNativePath).
  #reachedNativePackageRoots() {
    const pkgRoots = new Set()
    for (const abs of this.#seen) {
      const nm = splitNodeModulesPath(abs)
      if (!nm || nm.name === 'react-native') continue
      pkgRoots.add(nm.dir)
    }
    return [...pkgRoots].filter((root) => looksNative(root, diskHost))
  }

  // Attest the native build inputs of the package at `root` (nativeInputs, shared with `stasis bundle
  // --metro`), but what is already captured as a graph module or auto-include. Real readers: plugin
  // bookkeeping, not re-recorded by --fs.
  #captureNativeTree(root) {
    for (const { file, source, action, format } of nativeInputs(root, diskHost, { resources: this.#resources, skip: (f) => this.#seen.has(f) })) {
      this.#seen.add(file)
      this.#recordCapture(file, source, { format, resource: action === 'resource' })
    }
  }

  // bundle=load: Metro resolved every import itself (the loader and the esbuild/webpack plugins
  // take theirs from the bundle), so before any output each edge must be the one the bundle attests
  // -- the edges a capture records, from the same modules.
  // A per-platform edge (a `stasis bundle --metro --platforms=...` bundle added to) is checked for the
  // platform Metro builds.
  #assertEdges(graph, preModules) {
    const platform = graph.transformOptions?.platform ?? undefined
    for (const module of [...(preModules ?? []), ...graph.dependencies.values()]) {
      const modPath = diskPath(module)
      if (modPath === undefined) continue
      const url = pathToFileURL(modPath).toString()
      for (const [specifier, target] of this.#edges(module)) this.#state.assertImport(url, specifier, target, { platform })
      this.#assertConsumed(module, modPath)
      this.#assertAssetFiles(module, modPath, platform ?? null)
    }
  }

  // A module's outgoing edges, keyed as written, to `dep.absolutePath`. Metro names a dependency
  // (`dep.data.name`) by the specifier Babel left; where a plugin rewrote it, the stasis transformer
  // (./metro-transformer.js) carries the ones written in the source. Code and resource targets alike,
  // as `stasis bundle --metro` and the esbuild plugin record them: an asset is resolved as code is.
  // One the source doesn't write (`stasisInserted`: a Babel helper, the JSX runtime, Metro's
  // asyncRequire) is no edge, as `stasis bundle --metro` has none: its file is carried, as every
  // module of the graph is, and under load Metro resolves it unasserted.
  #edges(module) {
    const edges = []
    for (const dep of module.dependencies?.values?.() ?? []) {
      if (dep?.data?.stasisInserted === true) continue
      const target = dep?.absolutePath
      if (typeof target !== 'string' || !isAbsolute(target) || !existsSync(target)) continue
      if (classifyExtension(target, this.#resources) === 'unknown') continue
      for (const specifier of dep.data?.stasisAsWritten ?? [dep.data?.name]) {
        if (typeof specifier === 'string') edges.push([specifier, pathToFileURL(target).toString()])
      }
    }
    return edges
  }

  #captureModules(modules, entries, platform) {
    for (const module of modules) {
      const modPath = diskPath(module)
      if (modPath === undefined) continue

      const kind = classifyExtension(modPath, this.#resources)
      if (kind === 'unknown') {
        throw new Error(
          `StasisMetro: unsupported extension for '${modPath}' -- ` +
          `add its extension or filename to the plugin's resources option or stop importing it`
        )
      }
      const url = pathToFileURL(modPath).toString()
      for (const [specifier, target] of this.#edges(module)) this.#state.addImport(url, specifier, target)

      if (this.#seen.has(modPath)) continue
      this.#seen.add(modPath)

      // Read from disk, not module.getSource() -- addFile re-reads disk and asserts byte-equality.
      // Real reader (state-util.js): a --fs-patched readFileSync would re-record the graph into the preload.
      const source = realReadFileSync(modPath)
      // Code-classified files must be UTF-8; refuse non-UTF-8 rather than silently encode as a resource.
      if (kind === 'code') {
        assert.ok(isUtf8(source), `StasisMetro: code-classified file has non-UTF-8 bytes: ${modPath}`)
      }
      // No format for a code file: Metro transforms it from source, so Node's module/commonjs isn't
      // what runs. But the one its name alone gives it (.json, .mjs, .cjs: nodeExtFormat), as Node
      // loads it too, which a --fs read of it records besides (a resource still takes its
      // byte-derived format).
      const format = kind === 'code' ? nodeExtFormat(modPath) : undefined
      this.#state.addFile(url, { source, format, isEntry: entries.has(modPath), resource: kind === 'resource', inferFormat: false, reason: 'metro' })
      this.#captureConsumed(module, modPath)
      this.#captureAssetFiles(module, modPath, platform)
    }
  }

  // The resources a Babel plugin consumed in transforming `module`, read and inlined in their imports'
  // stead (`require('./messages.po')`, @exodus/i18n's plugin-inline-po), as the stasis transformer
  // carries them (`stasisConsumed`): no module of Metro's, so no edge, but the build's input all the
  // same. One named by path, as such a plugin reads it, from the module's dir, by its real path, as
  // Metro names its modules. One naming code (an import a plugin split into others, as
  // babel-plugin-lodash does), no file, or one whose real path is outside the project root (a
  // symlink out of it too) is passed over; one the resources don't carry is refused. -> each as
  // { file: its real path, read: the path the plugin reads it by }
  * #consumedResources(module, modPath) {
    for (const specifier of module.output?.[0]?.data?.stasisConsumed ?? []) {
      if (typeof specifier !== 'string' || !(isAbsolute(specifier) || /^\.\.?\//u.test(specifier))) continue
      const lexical = resolve(dirname(modPath), specifier)
      if (diskHost.stat(lexical)?.isFile() !== true) continue
      let file
      try {
        file = diskHost.realpath(lexical)
      } catch {
        continue
      }
      this.#realRoot ??= diskHost.realpath(this.#state.root)
      if (!isPathWithin(this.#realRoot, file)) continue
      try {
        this.#state.relative(file)
      } catch {
        continue
      }
      const kind = classifyExtension(file, this.#resources)
      if (kind === 'code') continue
      if (kind === 'unknown') {
        throw new Error(
          `StasisMetro: unsupported extension for '${file}', which a Babel plugin inlines into '${modPath}' -- ` +
          `add its extension or filename to the plugin's resources option or stop importing it`
        )
      }
      yield { file, read: lexical }
    }
  }

  // Capture: each, attributed to `metro`, as `stasis bundle --metro` records them under `bundle:metro`.
  #captureConsumed(module, modPath) {
    for (const { file } of this.#consumedResources(module, modPath)) {
      if (this.#seen.has(file)) continue
      this.#seen.add(file)
      // Real reader: plugin bookkeeping, not a program fs read -- must not be re-recorded by --fs.
      this.#recordCapture(file, realReadFileSync(file), { resource: true, inferFormat: false })
    }
  }

  // Load: the Babel plugin reads each from disk, past the stasis transformer (#assertOnDisk).
  #assertConsumed(module, modPath) {
    for (const files of this.#consumedResources(module, modPath)) {
      this.#assertOnDisk(files, { what: `which a Babel plugin inlines into '${modPath}'`, servedBy: ['sync', 'async'] })
    }
  }

  // The files of the asset module `module` Metro builds, but `modPath` itself, which it records as
  // every module: as Metro reads them to build it (its `scales` and `hash`) and copies them out with
  // it, its other scales (`logo@2x.png`, `logo@3x.png`; metroAssetFiles, Metro's own rule for
  // `platform`), by real path, as `stasis bundle --metro` carries them. No import names one, so no
  // edge. One whose real path is outside the project root is passed over. -> as #consumedResources
  * #assetFiles(module, modPath, platform) {
    if (module.output?.[0]?.type !== 'js/module/asset') return
    for (const read of metroAssetFiles(modPath, platform, this.#assetDirHost())) {
      const file = diskHost.realpath(read)
      this.#realRoot ??= diskHost.realpath(this.#state.root)
      if (!isPathWithin(this.#realRoot, file)) continue
      try {
        this.#state.relative(file)
      } catch {
        continue
      }
      yield { file, read }
    }
  }

  // The directory listing Metro finds an asset's files in (fs.promises.readdir): the disk's, but under
  // load with --fs=async, which serves it, the bundle's where it has one (a file added on disk since
  // is no file of the asset Metro builds), each name in it a file where it is one on disk (one gone
  // from disk is served, so holds no drift).
  #assetDirHost() {
    const state = this.#state
    if (!state.config.loadBundle || state.config.fs !== 'async') return diskHost
    return {
      readdir: (dir) => state.getFsDirFamily(pathToFileURL(dir).toString())?.map((name) => ({ name })) ?? diskHost.readdir(dir),
      stat: (path) => diskHost.stat(path),
    }
  }

  // Capture: each but the module itself, attributed to `metro`, as `stasis bundle --metro` records them.
  #captureAssetFiles(module, modPath, platform) {
    for (const { file } of this.#assetFiles(module, modPath, platform)) {
      if (this.#seen.has(file)) continue
      const kind = classifyExtension(file, this.#resources)
      if (kind === 'unknown') continue // as the module itself, which the graph capture refused
      this.#seen.add(file)
      const format = kind === 'code' ? nodeExtFormat(file) : undefined
      // Real reader: plugin bookkeeping, not a program fs read -- must not be re-recorded by --fs.
      this.#recordCapture(file, realReadFileSync(file), { format, resource: kind === 'resource', inferFormat: false })
    }
  }

  // Load: Metro's asset transformer reads each from disk (fs.promises), the module itself too, past
  // the stasis transformer, which serves the module's `data` that it never reads (#assertOnDisk).
  #assertAssetFiles(module, modPath, platform) {
    for (const files of this.#assetFiles(module, modPath, platform)) {
      this.#assertOnDisk(files, { what: `a file of the asset '${modPath}' Metro builds`, servedBy: ['async'] })
    }
  }

  // Load: a file Metro's build reads from disk by `read`, past the stasis transformer, which serves only
  // the module it transforms. One in scope (as the transformer's: any under scope=full, else one in
  // node_modules) must be in the bundle (getFile throws on one it doesn't carry), and its disk bytes the
  // bundle's -- unless --fs, in a mode of `servedBy` (async patches fs.promises too), serves the read
  // from the bundle itself, which it does by the path read (not a symlink to the file the bundle
  // carries). Fail closed on drift.
  #assertOnDisk({ file, read }, { what, servedBy }) {
    const url = pathToFileURL(file).toString()
    if (!this.#state.config.full && !this.#state.inNodeModules(url)) return
    const { source } = this.#state.getFile(url)
    if (servedBy.includes(this.#state.config.fs) && this.#state.getFsFileFamily(pathToFileURL(read).toString()) !== undefined) return
    if (!realReadFileSync(file).equals(Buffer.isBuffer(source) ? source : Buffer.from(source))) {
      throw new Error(
        `StasisMetro: '${file}', ${what}, differs on disk from the bundle -- ` +
        'Metro\'s build reads it from disk under load; restore it, or run with --fs to serve it from the bundle'
      )
    }
  }
}

// Idiomatic Metro-config wrapper: returns a new config with `serializer.customSerializer` wired
// so stasis captures the graph + preModules while your existing serializer (or Metro's default)
// still produces the bundle, with Metro's transform cache dropped so the workers really run, and
// with Metro's transformer run through stasis's (./metro-transformer.js).
// Pure -- returns a new object, doesn't mutate `config`.
export function withStasis(config = {}, options = {}) {
  const stasis = new StasisMetro(options, { ownsConfig: true })
  const existing = config.serializer?.customSerializer ?? undefined
  // Metro's transform cache is a CORRECTNESS hazard here, not a speed knob: it decides which modules
  // Metro itself LOADS. On a cache hit Metro returns the stored result without calling a worker, so
  // the worker-side toolchain is never loaded in any process and never reaches the root -- exactly
  // what the constructor's --child-process assert exists to guarantee. The default store is a
  // FileStore in the OS tmpdir shared with every other Metro run, so ONE earlier `metro build`/dev
  // server silently decides what gets attested: a capture over a warm cache drops the toolchain
  // (exit 0, no warning) and a later frozen run rejects the lockfile it wrote, while a frozen run
  // over a warm cache passes vacuously (it verifies transforms nobody performed).
  //
  // Dropped in EVERY active mode, load included, so the module set can't diverge between record and
  // replay. `new Transformer` calls getTransformCacheKey() only when the cache is enabled
  // (metro/src/DeltaBundler/Transformer.js: `this._cache.isDisabled ? '' : ...`), and that call tree
  // resolves the transformer plus its plugins' cache-key files. Disabled during capture, those edges
  // are never recorded; left enabled under load they resolve for real and getImport fails closed on
  // a bundle that cannot know them ("Cannot find module 'metro-transform-worker' imported from
  // .../getTransformCacheKey.js" -- Metro reports it as "Failed to construct transformer").
  //
  // Slower, but the loaded set stops depending on what ran before. These builds are one-shot anyway.
  const dropCache = stasis.needsTransforms
  // `undefined` is Metro's own default store, which the user never chose; an array or a
  // `(MetroCache) => stores` factory is theirs, so replacing it is worth saying out loud.
  const stores = config.cacheStores
  if (dropCache && (typeof stores === 'function' || stores?.length > 0)) {
    console.warn(
      '[stasis] StasisMetro: ignoring the `cacheStores` in your Metro config for this build -- a cached ' +
      'transform skips the worker, leaving the toolchain it loads unattested'
    )
  }
  // The workers run the project's transformer through stasis's, which records each import as
  // written, before Babel rewrites it, and serves bundle=load: handed over in `transformer`, which
  // Metro passes to each worker's transformer as is. In every active mode, load included, so the
  // modules a worker loads are the same when recorded and when replayed.
  const transformer = stasis.needsTransforms && {
    transformerPath: TRANSFORMER,
    transformer: { ...config.transformer, stasisBaseTransformerPath: config.transformerPath },
  }
  return {
    ...config,
    ...(dropCache && { cacheStores: [] }),
    ...transformer,
    serializer: {
      ...config.serializer,
      customSerializer: stasis.customSerializer(existing),
    },
  }
}
