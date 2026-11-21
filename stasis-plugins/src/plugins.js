import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { pathToFileURL } from 'node:url'

import { DEFAULT_LOCK, assertKnownKeys, assertOption } from '@exodus/stasis-core/config'
import { ensureStateForLoader, isLoaderInstalled } from '@exodus/stasis-core/hooks'
import { State } from '@exodus/stasis-core/state'
import { classifyExtension, extSetsEqual, parseResourcesOption } from '@exodus/stasis-core/util'

// The Config options a plugin takes; not `lockFile`, as the lockfile is always the preload's.
const PLUGIN_OPTION_KEYS = ['scope', 'lock', 'bundle', 'bundleFile', 'resourcesBundleFile', 'debug', 'childProcess', 'packageJSON', 'resources']

// Validated as Config validates them, without constructing one (which has side effects).
export function validatePluginOptions(label, options) {
  assertKnownKeys(Object.keys(options), PLUGIN_OPTION_KEYS, label)
  for (const key of PLUGIN_OPTION_KEYS) {
    if (options[key] === undefined) continue
    if (key === 'resources') parseResourcesOption(label, options.resources)
    else assertOption(key, options[key])
  }
}

// The active Config is authoritative; `resources`, a Set, is coordinated in resolvePluginState instead.
export function assertOptionsMatchConfig(config, options) {
  try {
    for (const key of PLUGIN_OPTION_KEYS) {
      if (key !== 'resources' && options[key] !== undefined) assert.equal(config[key === 'bundle' ? 'bundleMode' : key], options[key])
    }
  } catch (cause) {
    throw new Error(`Plugin options conflict with active stasis state: ${cause.message}`, { cause })
  }
}

// The State a bundler plugin runs against, given its options and the ambient preload: { state: null, isNoop: true }
// (inert: register no hooks), else { state, isNoop: false }. The lockfile is always the preload's; only the bundle
// may split off, to a sidecar State at its own bundleFile.
export function resolvePluginState(label, options, cwd) {
  validatePluginOptions(label, options)
  const { lock, bundle, bundleFile, resourcesBundleFile, resources } = options
  // The loader is installed but its lazy init hasn't fired (webpack builds plugins before user code). Never for a
  // separate stasis-core copy: that would mint a phantom State.preload racing the real loader's write.
  if (!State.preload && isLoaderInstalled()) ensureStateForLoader()
  const ambient = State.preload

  if (!ambient) {
    // `stasis run` always exports EXODUS_STASIS_LOCK, whichever stasis-core copy hosts this code.
    const underStasisRun = process.env.EXODUS_STASIS_LOCK !== undefined
    // Inert in a plain build, as where both are 'none' (a framework plugin switched off by env).
    if ((!underStasisRun && lock === undefined && bundle === undefined) || (lock === 'none' && bundle === 'none')) {
      return { state: null, isNoop: true }
    }
    // A partial opt-out would otherwise meet a misleading throw; an active bundle with lock='none' is legitimate.
    if ((lock === 'none' && bundle === undefined) || (bundle === 'none' && lock === undefined)) {
      throw new Error(
        `${label}: to opt out of stasis without a preload, pass BOTH lock='none' and bundle='none' ` +
        `(got lock=${lock === undefined ? `default '${DEFAULT_LOCK}'` : `'${lock}'`}, ` +
        `bundle=${bundle === undefined ? 'default' : `'${bundle}'`})`
      )
    }
    // A writing or verifying lock would miss the bundler's own deps without a preload, but under `stasis run`.
    const effectiveLock = lock ?? DEFAULT_LOCK
    if (!underStasisRun && effectiveLock !== 'none' && effectiveLock !== 'ignore') {
      const phrasing = lock === undefined ? `the default lockfile mode ('${DEFAULT_LOCK}')` : `lockfile mode '${lock}'`
      throw new Error(
        `${label}: ${phrasing} requires a stasis preload; ` +
        `pass lock='none' or lock='ignore' to opt out, or run under the stasis loader`
      )
    }
    return { state: new State(cwd, options), isNoop: false }
  }

  // These must agree with the preload, which a reuse adopts and a sidecar copies.
  const pc = ambient.config
  const shown = (value) => (typeof value === 'string' ? `'${value}'` : value)
  for (const key of ['lock', 'scope', 'debug', 'childProcess', 'packageJSON']) {
    if (options[key] !== undefined && options[key] !== pc[key]) {
      throw new Error(`${label}: ${key}=${shown(options[key])} conflicts with active preload ${key}=${shown(pc[key])}`)
    }
  }
  // resources is process-wide: compared as parsed sets, so that no plugin silently widens the asset set.
  if (resources !== undefined) {
    const parsed = parseResourcesOption(label, resources)
    if (!extSetsEqual(parsed, pc.resources)) {
      throw new Error(
        `${label}: resources=[${[...parsed].join(', ')}] conflicts with active preload resources=[${[...pc.resources].join(', ')}]`
      )
    }
  }

  // So the preload's `reason` map can tell files merely fs-read during the build from the run's own dependencies.
  ambient.markPluginAttached()

  // Sidecars skip stasis.config.json discovery, so carry the preload's settings over.
  const sidecar = (mode) => {
    const inherited = Object.fromEntries(['scope', 'lock', 'debug', 'childProcess', 'packageJSON', 'brotliQuality'].map((key) => [key, pc[key]]))
    const state = new State(cwd, { parent: ambient, ...inherited, bundle: mode, bundleFile, resourcesBundleFile, resources: [...pc.resources] })
    return { state, isNoop: false }
  }

  if (pc.bundle) {
    if (bundle !== undefined && bundle !== pc.bundleMode) {
      throw new Error(`${label}: bundle='${bundle}' conflicts with active preload bundle='${pc.bundleMode}'`)
    }
    if (bundleFile !== undefined && bundleFile !== pc.bundleFile) return sidecar(pc.bundleMode)
  } else if (bundle === undefined || bundle === 'none' || bundle === 'ignore') {
    // 'ignore' and the preload's 'none' both mean no bundle; the assert pins that to today's no-bundle modes, so
    // that a future one can't silently mask a disagreement.
    assert.ok(pc.bundleMode === 'none' || pc.bundleMode === 'ignore',
      `unexpected preload bundleMode='${pc.bundleMode}' in the no-bundle branch`)
  } else {
    if (!bundleFile) {
      throw new Error(`${label}: bundle='${bundle}' alongside a preload without bundle requires an explicit bundleFile`)
    }
    return sidecar(bundle)
  }
  // The bundle field is settled above, and leaves the cross-check.
  assertOptionsMatchConfig(pc, { ...options, bundle: undefined })
  return { state: ambient, isNoop: false }
}

// A State the caller owns (`stasis build`'s), else resolvePluginState's; a foreign copy's State fails the instanceof.
export const ownOrResolvedState = (label, options) =>
  (options instanceof State ? options : resolvePluginState(label, options, process.cwd()).state)

export const unsupportedExtension = (label, what) =>
  `${label}: unsupported extension for ${what} -- add its extension or filename to the plugin's resources option or stop importing it`

// Refuse non-UTF-8 code rather than silently encode it as a resource.
export function assertCodeUtf8(label, path, source) {
  assert.ok(isUtf8(source), `${label}: code-classified file has non-UTF-8 bytes: ${path}`)
}

// Only the `type` import attribute persists to the lockfile.
export function assertPersistableAttributes(attrs) {
  for (const k of Object.keys(attrs)) assert.equal(k, 'type', `unsupported import attribute: ${k}`)
}

export const fileURL = (path) => pathToFileURL(path).toString()

// The lifecycle every bundler plugin shares over the State it runs against (null: inert), by file path: a one-shot
// capture deduped by path, its edges and files recorded, edges looked up at load, and the write.
export class PluginState {
  seen = new Set()
  #builds = 0

  constructor(label, reason, state) {
    this.label = label
    this.reason = reason
    this.state = state
  }

  // Dedupe is by path, so a rebuild with new bytes would emit them while the bundle and lockfile keep the old ones.
  // -> `refusal` for each build after the first
  startBuild(refusal = `${this.label}: watch/rebuild is not supported for capture -- run a one-shot build (rebuilds would silently attest stale content)`) {
    this.#builds += 1
    if (this.#builds === 1) return undefined
    return refusal
  }

  // A file's kind (code|resource), or a throw naming it as `what` where it's neither.
  classify(path, what = `'${path}'`) {
    const kind = classifyExtension(path, this.state.config.resources)
    if (kind === 'unknown') throw new Error(unsupportedExtension(this.label, what))
    return kind
  }

  // Whether `path` is new to this plugin, marking it seen.
  claim(path) {
    if (this.seen.has(path)) return false
    this.seen.add(path)
    return true
  }

  // `options` go on to State#addFile as given (Metro's format and inferFormat).
  addFile(path, source, kind, isEntry, options) {
    if (kind === 'code') assertCodeUtf8(this.label, path, source)
    this.state.addFile(fileURL(path), { source, isEntry, resource: kind === 'resource', reason: this.reason, ...options })
  }

  addImport(importer, specifier, target, importAttributes) {
    this.state.addImport(fileURL(importer), specifier, fileURL(target), { importAttributes })
  }

  // `state.getImport(...)`, or undefined where the bundle attests no such edge: an EXTERNAL at capture, which the
  // bundler resolves as without us (file BYTES still fail closed where the plugin loads them).
  attestedImport(importer, specifier, options) {
    try {
      return this.state.getImport(fileURL(importer), specifier, options)
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND') return undefined
      throw err
    }
  }

  // The preload writes itself.
  get ownsWrite() {
    return this.state !== State.preload
  }
}
