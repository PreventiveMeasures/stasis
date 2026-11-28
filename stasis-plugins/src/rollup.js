import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bundle } from '@exodus/stasis-core/bundle'
import { PluginState, assertPersistableAttributes, fileURL, ownOrResolvedState } from './plugins.js'
// Pre-patch snapshot, not `import { readFile }`: under --fs=async that builtin is patched, and
// this plugin loads after, so a direct import would route rollup's reads through the capture hook.
import { inScope, realReadFile, servedByBundle } from '@exodus/stasis-core/state-util'
import { isPathWithin } from '@exodus/stasis-core/util'

// An on-disk file by its absolute path, not a sibling plugin's virtual module (\0-prefixed or relative) or no importer.
const isDiskId = (id) => Boolean(id) && isAbsolute(id) && !id.startsWith('\0')

// Rollup chains resolveId/load hooks first-non-null-wins, so this plugin goes FIRST in `plugins`: listed later, a
// sibling resolver answers before stasis sees the edge (file BYTES still fail closed at the load hook).
export class StasisRollup {
  #stasis

  name = 'stasis'

  constructor(options = {}, unsupported = undefined) {
    // Transforms run as ordinary rollup plugins after this one: refuse a port's esbuild-style bag, not drop it.
    assert.equal(unsupported, undefined,
      'StasisRollup takes a single options argument')
    this.#stasis = new PluginState('StasisRollup', 'rollup', ownOrResolvedState('StasisRollup', options))
    const { state } = this.#stasis
    if (!state) return // inert: rollup sees only `name`

    // Rollup binds `this` to its PluginContext, so a hook gets it as `ctx` and the instance via the closure.
    const plugin = this
    const hook = (method) => function (...args) {
      return method.call(plugin, this, ...args)
    }
    this.resolveId = hook(this.#resolveId)
    this.load = hook(this.#load)

    // A warm `cache:` object reuses modules and resolutions WITHOUT calling resolveId/load, so they'd go unattested
    // at capture and unverified at load. Rollup still builds a fresh cache for this run.
    this.options = (inputOptions) => {
      if (typeof inputOptions.cache !== 'object' || inputOptions.cache === null) return null
      console.warn(
        '[stasis] StasisRollup: ignoring the `cache` option for this build'
      )
      return { ...inputOptions, cache: undefined }
    }

    if (!state.config.loadBundle) {
      // Watch rebuilds, and a second rollup() call reusing this instance, re-fire buildStart.
      this.buildStart = () => {
        const refusal = this.#stasis.startBuild()
        if (refusal) throw new Error(refusal)
      }
      this.buildEnd = hook(this.#buildEnd)
    }
  }

  // Rollup asset plugins read their files from disk in their own load hook, with no seam for attested bytes.
  #refuseResourceLoad(path) {
    throw new Error(
      `StasisRollup: bundle=load can't serve resource '${path}'`
    )
  }

  // A '?'/'#'-suffixed variant of an on-disk path ('./icon.svg?url') feeds the file's bytes to the build under a key
  // that can't be persisted, so skipping it would leave a build input unattested. A wholly virtual id is skippable.
  #refuseSuffixedOnDisk(id) {
    const stripped = id.split(/[?#]/u, 1)[0]
    if (stripped !== id && existsSync(stripped)) {
      throw new Error(
        `StasisRollup: can't attest suffixed module id '${id}' (the on-disk file '${stripped}' with a '?'/'#' suffix)`
      )
    }
  }

  // An on-disk id under the project root.
  #inRoot(id) {
    return isDiskId(id) && isPathWithin(this.#stasis.state.root, id)
  }

  async #resolveId(ctx, source, importer, opts) {
    // Left to the user's external config. SECURITY: never consult getImport for a builtin, so a tampered bundle
    // can't redirect `fs`.
    if (isBuiltin(source)) return null
    const { isEntry, attributes: attrs = {} } = opts
    const stasis = this.#stasis

    // Load mode resolves through the bundle's import map: the file may not be on disk.
    if (stasis.state.config.loadBundle) {
      if (isEntry) {
        // Rollup defaults isEntry to !importer, so this covers bare sibling probes too: the load hook asserts entries
        // from the graph instead. Anchored as rollup's resolver does, else to cwd as the run loader is.
        if (source.startsWith('file:')) return { id: fileURLToPath(source) }
        const base = isDiskId(importer) ? dirname(importer) : process.cwd()
        return { id: resolvePath(base, source) }
      }
      if (!this.#inRoot(importer)) return null
      assertPersistableAttributes(attrs)
      const attested = stasis.attestedImport(importer, source, { importAttributes: attrs })
      if (attested === undefined) return null
      const { url, format } = attested
      const path = fileURLToPath(url)
      // An out-of-scope resource comes from disk through the user's asset plugin, as at capture.
      if (Bundle.isResourceFormat(format) && inScope(stasis.state, url)) this.#refuseResourceLoad(path)
      // KNOWN GAP: a sibling's resolution metadata (moduleSideEffects, syntheticNamedExports, meta) isn't in the
      // bundle, so tree-shaking may differ from the capture build's.
      return { id: path }
    }

    // Capture: the remaining resolveId hooks and rollup's own algorithm, passed through with the edge recorded.
    const resolution = await ctx.resolve(source, importer, { ...opts, skipSelf: true })
    if (!resolution || resolution.external) return resolution
    const { id } = resolution
    if (!isDiskId(id)) return resolution
    if (!existsSync(id)) {
      this.#refuseSuffixedOnDisk(id)
      return resolution
    }
    stasis.classify(id)

    // Code and resource targets alike, but never for an entry, flagged from the graph in buildEnd (opts.isEntry is
    // a sibling's probe too), nor an out-of-root importer, which load mode defers too.
    if (!isEntry && this.#inRoot(importer)) {
      assertPersistableAttributes(attrs)
      if (!this.#inRoot(id)) {
        throw new Error(
          `StasisRollup: '${source}' imported from ${importer} resolves outside the project root and can't be attested: ${id}`
        )
      }
      stasis.addImport(importer, source, id, attrs)
    }
    return resolution
  }

  async #load(ctx, id) {
    const stasis = this.#stasis
    const { state } = stasis
    // getFile verifies the hash and throws on a file the bundle doesn't carry: no disk fallback. Ids other plugins
    // resolved land here too.
    if (state.config.loadBundle) {
      if (!isDiskId(id) || !servedByBundle(state, id)) return null
      const url = fileURL(id)
      // The graph's isEntry: a sibling's resolve() probe carries isEntry too but never loads.
      if (state.config.full && ctx.getModuleInfo(id)?.isEntry) state.assertEntry(url)
      const { source, format } = state.getFile(url)
      if (Bundle.isResourceFormat(format)) this.#refuseResourceLoad(id)
      return source
    }

    // A sibling resolver may have minted ids our resolveId never saw. The read is the existence check.
    if (!isDiskId(id)) return null
    let source
    try {
      source = await realReadFile(id)
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
      this.#refuseSuffixedOnDisk(id)
      return null
    }
    const kind = stasis.classify(id)
    if (!this.#inRoot(id)) {
      throw new Error(`StasisRollup: module is outside the project root and can't be attested: ${id}`)
    }
    // Rollup loads an id once per build.
    if (stasis.claim(id)) stasis.addFile(id, source, kind)
    // A resource is the user's asset plugin's to load; code is served as recorded (transform hooks still run after).
    return kind === 'resource' ? null : source.toString('utf8')
  }

  // Flags the graph's real entries (resolveId's opts.isEntry would take a sibling's bare probe for one), then writes
  // a standalone or sidecar State on a clean build. buildEnd, not closeBundle, which only bundle.close() fires.
  async #buildEnd(ctx, error) {
    if (error) return
    const stasis = this.#stasis
    const entryIds = [...ctx.getModuleIds()].filter((id) => {
      if (!stasis.seen.has(id)) return false
      const info = ctx.getModuleInfo(id)
      return Boolean(info?.isEntry) && !info.isExternal
    })
    // addFile re-verifies the bytes, and refuses a RESOURCE entry, as StasisEsbuild does.
    const sources = await Promise.all(entryIds.map((id) => realReadFile(id)))
    for (const [i, id] of entryIds.entries()) stasis.addFile(id, sources[i], stasis.classify(id), true)
    if (stasis.ownsWrite) stasis.state.write()
  }
}
