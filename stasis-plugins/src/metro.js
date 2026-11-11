import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertCodeUtf8, classifyOrThrow, resolvePluginState } from './plugins.js'
import { AUTO_INCLUDES, FILE_STAT, RN_CORE_INCLUDE_FILES, bundleDirHost, looksNative, metroAssetFiles, nativeInputs } from './metro-native.js'
import { diskHost } from '@exodus/stasis-core/host'
import { State } from '@exodus/stasis-core/state'
// realReadFileSync throughout: the plugin's own reads, which --fs must not record as the program's.
import { inScope, realReadFileSync } from '@exodus/stasis-core/state-util'
import { classifyExtension, classifyFormat, isPathWithin, nodeExtFormat, splitNodeModulesPath } from '@exodus/stasis-core/util'

const require = createRequire(import.meta.url)

const TRANSFORMER = fileURLToPath(new URL('./metro-transformer.js', import.meta.url))

// A graph module's absolute path, or undefined for a virtual one (require.context's ?ctx=, __prelude__).
function diskPath(module) {
  const modPath = module?.path
  return typeof modPath === 'string' && isAbsolute(modPath) && existsSync(modPath) ? modPath : undefined
}

// Metro's `graph.entryPoints` is a Set, an Array before ~0.71.
const entrySet = ({ entryPoints }) => new Set(entryPoints instanceof Set || Array.isArray(entryPoints) ? entryPoints : [])

// The files Metro's transform worker hashes into its cache key for its transform plugins: from the project, else
// through metro and its transform worker (a pnpm install links metro-transform-plugins only beside them).
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

const WORKER_TOOLCHAIN = 'babel.config.js, @babel/core, the RN preset + plugins'

// `react-native config`'s output, or null without the RN CLI; a failing CLI throws, as under-attesting breaks frozen runs.
function loadReactNativeConfig(projectDir) {
  let cliPath
  try {
    cliPath = require.resolve('react-native/cli.js', { paths: [projectDir] })
  } catch {
    return null
  }
  // As vanilla Node: with stasis's env or an inherited loader, it would join this capture nondeterministically.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_') && key !== 'NODE_OPTIONS'))
  const res = spawnSync(process.execPath, [cliPath, 'config'], { cwd: projectDir, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env })
  if (res.error) throw new Error(`StasisMetro: failed to run 'react-native config': ${res.error.message}`, { cause: res.error })
  if (res.status !== 0) {
    const detail = (res.stderr || '').trim()
    throw new Error(
      `StasisMetro: 'react-native config' exited ${res.status}${res.signal ? ` on signal ${res.signal}` : ''}${detail ? `: ${detail}` : ''}`
    )
  }
  try {
    return JSON.parse(res.stdout)
  } catch (cause) {
    throw new Error("StasisMetro: couldn't parse 'react-native config' output as JSON", { cause })
  }
}

// An all-null dep is JS-only, already in the graph.
function isNativeDependency(dep) {
  const platforms = dep?.platforms
  return typeof platforms === 'object' && platforms !== null && Object.values(platforms).some((p) => p != null)
}

// Metro exports no default serializer: its internal one is under metro/src through ~0.82, metro/private from 0.81.4.
let metroDefault
function metroDefaultSerializer() {
  if (metroDefault) return metroDefault
  const M = 'metro'
  const load = (dir) => ['DeltaBundler/Serializers/baseJSBundle', 'lib/bundleToString'].map((lib) => {
    const mod = require(`${M}/${dir}/${lib}`)
    return mod.default ?? mod
  })
  let baseJSBundle, bundleToString
  try {
    [baseJSBundle, bundleToString] = load('src')
  } catch {
    try {
      [baseJSBundle, bundleToString] = load('private')
    } catch (cause) {
      throw new Error(
        "StasisMetro: couldn't load Metro's default serializer (tried metro/src and " +
        'metro/private). Pass your existing customSerializer to withStasis()/customSerializer() instead.',
        { cause }
      )
    }
  }
  metroDefault = (entryPoint, preModules, graph, options) => bundleToString(baseJSBundle(entryPoint, preModules, graph, options)).code
  return metroDefault
}

// Hooks Metro's serializer, which runs once in the main process with the full graph (a worker's State could never
// be merged); ./metro-transformer.js is the worker half. Under bundle=load it asserts each edge against the bundle.
// Prefer withStasis: serializerHook never sees preModules, and only withStasis can drop Metro's transform cache.
export class StasisMetro {
  #seen = new Set()
  #realRoot
  #bundleDirs
  #state
  #resources
  // Snapshotted so a later chdir can't skew capture.
  #projectDir = process.cwd()
  #ran = false
  #ownsConfig

  constructor(options = {}, { ownsConfig = false } = {}) {
    const { state } = resolvePluginState('StasisMetro', options, process.cwd())
    this.#state = state
    this.#ownsConfig = ownsConfig
    // The worker toolchain is only ever loaded in workers, so a writing capture needs --child-process.
    if (state && (state.config.writeLockfile || state.config.writeBundle)) {
      assert.ok(
        state.config.childProcess,
        'StasisMetro: child-process capture must be enabled -- Metro transforms in worker processes, ' +
        `and without it the toolchain they load (${WORKER_TOOLCHAIN}) ` +
        'is never attested. Enable it: `stasis run --child-process ...`, EXODUS_STASIS_CHILD_PROCESS=1, ' +
        'or "childProcess": true in stasis.config.json.'
      )
      // Opt the children into the loader's SIGTERM shard flush, else jest-worker's forceExit drops a shard. Keyed on
      // the preload's mode, which the shard channel follows; `||=` honours an explicit opt-out.
      const channel = State.preload ?? state
      if (channel.config.writeLockfile || channel.config.writeBundle) {
        process.env.EXODUS_STASIS_SHARD_SIGNAL_FLUSH ||= '1'
      }
    }
    this.#resources = state?.config.resources ?? new Set()
  }

  // Whether the build relies on Metro really transforming files (capture, frozen and load all do), which a cached
  // transform would skip.
  get needsTransforms() {
    const config = this.#state?.config
    return config !== undefined && (config.useLockfile || config.bundle)
  }

  customSerializer(baseSerializer = undefined) {
    if (baseSerializer !== undefined && typeof baseSerializer !== 'function') {
      throw new TypeError('StasisMetro.customSerializer(base?): base must be a function or omitted')
    }
    // Inert: the base as is, never loading Metro's internals.
    if (!this.#state) return baseSerializer
    return (entryPoint, preModules, graph, options) => {
      this.#run(graph, preModules)
      return (baseSerializer ?? metroDefaultSerializer())(entryPoint, preModules, graph, options)
    }
  }

  serializerHook = (graph, _delta) => {
    this.#run(graph)
  }

  #run(graph, preModules) {
    if (!this.#state) return
    // Before the one-shot guard: load records nothing, and may re-serialize under a dev server.
    if (this.#state.config.loadBundle) {
      this.#assertEdges(graph, preModules)
      return
    }
    if (this.#ran) {
      throw new Error(
        'StasisMetro: watch/dev-server rebuilds are not supported for capture -- use a one-shot `metro build`'
      )
    }
    this.#ran = true
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
    // The preload writes itself; a failed build never reaches serialization.
    if (this.#state !== State.preload) this.#state.write()
  }

  #capture(graph, preModules) {
    const entries = entrySet(graph)
    const platform = graph.transformOptions?.platform ?? null
    if (preModules) this.#captureModules(preModules, entries, platform)
    this.#captureModules(graph.dependencies.values(), entries, platform)
    this.#captureAutoIncludes()
    this.#captureTransformPlugins()
    // Last, past what is already captured: the native build inputs no module graph carries.
    this.#captureNativeModules()
  }

  #recordCapture(full, source, { format, resource, inferFormat = true, reason = 'metro' }) {
    this.#state.addFile(pathToFileURL(full).toString(), { source, format: format ?? undefined, resource, inferFormat, reason })
  }

  // Each of AUTO_INCLUDES resolving within the project root, tagged by the shared classifier so it agrees with any
  // other path meeting the file (setup_env.sh is 'shell'), else a resource.
  #captureAutoIncludes() {
    for (const specifier of AUTO_INCLUDES) {
      let modPath
      try {
        modPath = require.resolve(specifier, { paths: [this.#projectDir] })
      } catch {
        continue
      }
      if (this.#seen.has(modPath) || !this.#within(modPath)) continue
      this.#seen.add(modPath)
      const source = realReadFileSync(modPath)
      const format = classifyFormat(modPath, { content: source })
      this.#recordCapture(modPath, source, { format, resource: format === undefined, inferFormat: false, reason: 'run' })
    }
  }

  // Metro's worker hashes every transform plugin into its cache key, but loads each only as the build's options call
  // for it, so a capture loads them all, as the loader then records with their imports, and records each under `run`.
  #captureTransformPlugins() {
    for (const file of metroTransformPluginFiles(this.#projectDir)) {
      if (this.#seen.has(file) || !this.#within(file)) continue
      this.#seen.add(file)
      try {
        require(file)
      } catch { /* one that can't load can't run under Metro either: its bytes are still recorded */ }
      this.#recordCapture(file, realReadFileSync(file), { reason: 'run' })
    }
  }

  // The native build inputs of the deps autolinking reports, of those the graph reached that ship native code
  // (integrated by hand), and of RN core, which config names only as reactNativePath. One outside the root is skipped.
  #captureNativeModules() {
    const config = loadReactNativeConfig(this.#projectDir)
    if (!config) return
    const roots = new Set()
    for (const dep of Object.values(config.dependencies ?? {})) {
      if (isNativeDependency(dep) && typeof dep.root === 'string' && isAbsolute(dep.root)) roots.add(dep.root)
    }
    for (const root of this.#reachedNativePackageRoots()) roots.add(root)
    const rnPath = typeof config.reactNativePath === 'string' && isAbsolute(config.reactNativePath) ? config.reactNativePath : null
    if (rnPath !== null) roots.add(rnPath)
    for (const root of roots) if (this.#within(root)) this.#captureNativeTree(root)
    // RN core's `.js` build scripts, which the walk leaves to Metro but its graph never has.
    if (rnPath !== null && this.#within(rnPath)) for (const file of RN_CORE_INCLUDE_FILES) this.#captureNativeFile(join(rnPath, file))
  }

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

  // RN core is walked as reactNativePath.
  #reachedNativePackageRoots() {
    const reached = this.#seen.values().map((abs) => splitNodeModulesPath(abs)).filter((nm) => nm && nm.name !== 'react-native')
    return [...new Set(reached.map((nm) => nm.dir))].filter((root) => looksNative(root, diskHost))
  }

  // In the format nativeInputs gives (none for a codegen source, as Metro's code has none, so none is inferred).
  #captureNativeTree(root) {
    for (const { file, source, action, format } of nativeInputs(root, diskHost, { resources: this.#resources, skip: (f) => this.#seen.has(f) })) {
      this.#seen.add(file)
      this.#recordCapture(file, source, { format, resource: action === 'resource', inferFormat: false })
    }
  }

  // bundle=load: Metro resolved every import itself, so each edge must be the one the bundle attests, for the
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

  // A module's edges, keyed as the source wrote them (`stasisAsWritten`, where Babel rewrote one), to code and resource
  // targets alike. One the source doesn't write (`stasisInserted`: a Babel helper, Metro's asyncRequire) is no edge.
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
      const kind = classifyOrThrow('StasisMetro', modPath, this.#resources)
      const url = pathToFileURL(modPath).toString()
      for (const [specifier, target] of this.#edges(module)) this.#state.addImport(url, specifier, target)
      if (!this.#captureRead(modPath, kind, entries.has(modPath))) continue
      this.#captureConsumed(module, modPath)
      this.#captureAssetFiles(module, modPath, platform)
    }
  }

  #within(path) {
    return isPathWithin(this.#state.root, path)
  }

  // `path`'s real path, where it lies within the project root (not linked out of it), else null.
  #realWithin(path) {
    let real
    try {
      real = diskHost.realpath(path)
      this.#realRoot ??= diskHost.realpath(this.#state.root)
    } catch {
      return null
    }
    return this.#within(real) && isPathWithin(this.#realRoot, real) ? real : null
  }

  // The resources a Babel plugin read and inlined in transforming `module` (`stasisConsumed`: @exodus/i18n's
  // plugin-inline-po's `require('./messages.po')`): no module of Metro's, so no edge, but build inputs. Each named by
  // a path from the module's dir, by its real path within the root; one naming code (babel-plugin-lodash's) is passed
  // over, one the resources don't carry refused. -> each as { file: its real path, read: the path read }
  * #consumedResources(module, modPath) {
    for (const specifier of module.output?.[0]?.data?.stasisConsumed ?? []) {
      if (typeof specifier !== 'string' || !(isAbsolute(specifier) || /^\.\.?\//u.test(specifier))) continue
      const read = resolve(dirname(modPath), specifier)
      const file = diskHost.stat(read)?.isFile() ? this.#realWithin(read) : null
      if (file === null) continue
      if (classifyOrThrow('StasisMetro', file, this.#resources, `'${file}', which a Babel plugin inlines into '${modPath}'`) === 'code') continue
      yield { file, read }
    }
  }

  #captureConsumed(module, modPath) {
    for (const { file } of this.#consumedResources(module, modPath)) this.#captureRead(file, 'resource')
  }

  // Capture `path` once, as the `kind` classifyExtension gives it: code with only the format its name gives
  // (nodeExtFormat), as Metro transforms it from source. From disk: addFile re-reads it to assert the bytes.
  // -> whether it was new
  #captureRead(path, kind, isEntry = false) {
    if (this.#seen.has(path)) return false
    this.#seen.add(path)
    const source = realReadFileSync(path)
    if (kind === 'code') assertCodeUtf8('StasisMetro', path, source)
    const format = kind === 'code' ? nodeExtFormat(path) : undefined
    const resource = kind === 'resource'
    this.#state.addFile(pathToFileURL(path).toString(), { source, format, isEntry, resource, inferFormat: false, reason: 'metro' })
    return true
  }

  #assertConsumed(module, modPath) {
    for (const files of this.#consumedResources(module, modPath)) {
      this.#assertOnDisk(files, { what: `which a Babel plugin inlines into '${modPath}'`, servedBy: ['sync', 'async'] })
    }
  }

  // The files Metro reads to build the asset module `module` (its `scales` and `hash`) and copies out with it: it
  // and its other scales (metroAssetFiles, Metro's own rule for `platform`). No import names one, so no edge.
  #assetFiles(module, modPath, platform) {
    return module.output?.[0]?.type === 'js/module/asset' ? metroAssetFiles(modPath, platform, this.#assetDirHost()) : []
  }

  // Where Metro lists an asset's files: on disk, but under load with --fs=async, which serves the listing, the
  // bundle's (a file added on disk since is none of the asset's; one gone from disk holds no drift).
  #assetDirHost() {
    const state = this.#state
    if (!state.config.loadBundle || state.config.fs !== 'async') return diskHost
    return {
      readdir: (dir) => state.getFsDirFamily(pathToFileURL(dir).toString())?.map((name) => ({ name })) ?? diskHost.readdir(dir),
      stat: (path) => diskHost.stat(path) ?? (state.getFsStatFamily(pathToFileURL(path).toString()) === 'file' ? FILE_STAT : null),
    }
  }

  #bundleDirHost() {
    return (this.#bundleDirs ??= bundleDirHost(this.#state))
  }

  // By the name Metro reads each by, with the bytes it reads there, so a load holds that name to them. One linked
  // from outside the project is passed over, as is one of a kind unknown (the module itself was refused).
  #captureAssetFiles(module, modPath, platform) {
    for (const read of this.#assetFiles(module, modPath, platform)) {
      const kind = classifyExtension(read, this.#resources)
      if (kind !== 'unknown' && this.#realWithin(read) !== null) this.#captureRead(read, kind)
    }
  }

  // Metro reads an asset's files from disk, past the stasis transformer: each must be the bundle's under that name (a
  // scale added since the capture, or one a symlink redirects, is drift), and each the bundle carries must still be
  // there (one gone builds another asset) -- unless --fs=async serves them.
  #assertAssetFiles(module, modPath, platform) {
    const read = this.#assetFiles(module, modPath, platform)
    if (read.length === 0) return
    const what = `a file of the asset '${modPath}' Metro builds`
    for (const path of read) {
      if (diskHost.stat(path)?.isFile()) this.#assertOnDisk({ file: path, read: path }, { what, servedBy: ['async'] })
    }
    if (!inScope(this.#state, pathToFileURL(modPath).toString())) return
    for (const file of metroAssetFiles(modPath, platform, this.#bundleDirHost())) {
      if (read.includes(file)) continue
      throw new Error(`StasisMetro: '${file}', ${what} as the bundle carries it, is gone -- Metro would build the asset without it under load; restore it`)
    }
  }

  // `read`, a file Metro reads from disk past the stasis transformer, held to the bundle's bytes for `file` where in
  // scope (getFile throws on one it doesn't carry) -- unless --fs, in a mode of `servedBy`, serves it by the path read.
  #assertOnDisk({ file, read }, { what, servedBy }) {
    const state = this.#state
    const url = pathToFileURL(file).toString()
    if (!inScope(state, url)) return
    if (servedBy.includes(state.config.fs) && state.getFsFileFamily(pathToFileURL(read).toString()) !== undefined) return
    const { source } = state.getFile(url)
    if (realReadFileSync(file).equals(Buffer.isBuffer(source) ? source : Buffer.from(source))) return
    throw new Error(
      `StasisMetro: '${file}', ${what}, differs on disk from the bundle -- ` +
      'Metro\'s build reads it from disk under load; restore it, or run with --fs to serve it from the bundle'
    )
  }
}

// A new Metro config whose customSerializer captures the graph and preModules while the existing serializer (else
// Metro's default) still produces the bundle, and whose transformer runs through ./metro-transformer.js.
export function withStasis(config = {}, options = {}) {
  const stasis = new StasisMetro(options, { ownsConfig: true })
  const existing = config.serializer?.customSerializer ?? undefined
  // Metro's transform cache decides which modules Metro loads: a hit skips the worker, so its toolchain goes
  // unattested and a frozen run passes vacuously, and the default store is shared with every other Metro run. Dropped
  // under load too: an enabled cache resolves its cache-key files, which a bundle can't know, failing getImport.
  const active = stasis.needsTransforms
  // `undefined` is Metro's own default store; an array or a factory is the user's, so replacing it is announced.
  const stores = config.cacheStores
  if (active && (typeof stores === 'function' || stores?.length > 0)) {
    console.warn(
      '[stasis] StasisMetro: ignoring the `cacheStores` in your Metro config for this build -- a cached ' +
      'transform skips the worker, leaving the toolchain it loads unattested'
    )
  }
  // Metro hands `transformer` to each worker's transformer as is.
  return {
    ...config,
    ...(active && {
      cacheStores: [],
      transformerPath: TRANSFORMER,
      transformer: { ...config.transformer, stasisBaseTransformerPath: config.transformerPath },
    }),
    serializer: { ...config.serializer, customSerializer: stasis.customSerializer(existing) },
  }
}
