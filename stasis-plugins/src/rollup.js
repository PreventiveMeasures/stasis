import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Bundle } from '@exodus/stasis-core/bundle'
import { assertCodeUtf8, assertPersistableAttributes, attestedImport, classifyOrThrow, ownOrResolvedState, rebuildRefused } from './plugins.js'
import { State } from '@exodus/stasis-core/state'
// Pre-patch snapshot, not `import { readFile }`: under --fs=async that builtin is patched, and
// this plugin loads after, so a direct import would route rollup's reads through the capture hook.
import { inScope, realReadFile } from '@exodus/stasis-core/state-util'
import { classifyExtension, isPathWithin } from '@exodus/stasis-core/util'

// An on-disk file by its absolute path, not a sibling plugin's virtual module (\0-prefixed or relative) or no importer.
const isDiskId = (id) => Boolean(id) && isAbsolute(id) && !id.startsWith('\0')

// Rollup chains resolveId/load hooks first-non-null-wins, so this plugin goes FIRST in `plugins`: listed later, a
// sibling resolver answers before stasis sees the edge (file BYTES still fail closed at the load hook).
export class StasisRollup {
  #seen = new Set()
  #state
  #resources
  #captureBuildCount = 0

  name = 'stasis'

  constructor(options = {}, unsupported = undefined) {
    // Transforms run as ordinary rollup plugins after this one: refuse a port's esbuild-style bag, not drop it.
    assert.equal(unsupported, undefined,
      'StasisRollup takes a single options argument -- there is no esbuild-style { loaders, transform } bag (run transforms as rollup plugins after this one)')
    const state = ownOrResolvedState('StasisRollup', options)
    this.#state = state
    this.#resources = state?.config.resources ?? new Set()
    if (!state) return // inert: rollup sees only `name`

    // Rollup binds `this` to its PluginContext, so the instance arrives via the closure.
    const plugin = this
    this.resolveId = function (source, importer, opts) {
      return plugin.#resolveId(this, source, importer, opts)
    }
    this.load = function (id) {
      return plugin.#load(this, id)
    }

    // A warm `cache:` object reuses modules and resolutions WITHOUT calling resolveId/load, so they'd go unattested
    // at capture and unverified at load. Rollup still builds a fresh cache for this run.
    this.options = (inputOptions) => {
      if (typeof inputOptions.cache !== 'object' || inputOptions.cache === null) return null
      console.warn(
        '[stasis] StasisRollup: ignoring the `cache` option for this build -- cached modules ' +
        'bypass the stasis hooks, so their imports and bytes would go unattested at capture and ' +
        'unverified at load'
      )
      return { ...inputOptions, cache: undefined }
    }

    if (!state.config.loadBundle) {
      // Watch rebuilds, and a second rollup() call reusing this instance, re-fire buildStart.
      this.buildStart = () => {
        plugin.#captureBuildCount += 1
        if (plugin.#captureBuildCount > 1) throw new Error(rebuildRefused('StasisRollup'))
      }
      this.buildEnd = function (error) {
        return plugin.#buildEnd(this, error)
      }
    }
  }

  // Rollup asset plugins read their files from disk in their own load hook, with no seam for attested bytes.
  #refuseResourceLoad(path) {
    throw new Error(
      `StasisRollup: bundle=load can't serve resource '${path}' -- rollup asset plugins read ` +
      'from disk directly, so attested replay is not possible; keep sources on disk and use a ' +
      'capture/verify mode instead'
    )
  }

  // A '?'/'#'-suffixed variant of an on-disk path ('./icon.svg?url') feeds the file's bytes to the build under a key
  // that can't be persisted, so skipping it would leave a build input unattested. A wholly virtual id is skippable.
  #refuseSuffixedOnDisk(id) {
    const stripped = id.split(/[?#]/u, 1)[0]
    if (stripped !== id && existsSync(stripped)) {
      throw new Error(
        `StasisRollup: can't attest suffixed module id '${id}' (the on-disk file '${stripped}' ` +
        "with a '?'/'#' suffix) -- stasis can't persist suffixes; disable the plugin minting it " +
        'or import the file directly'
      )
    }
  }

  #inRoot(path) {
    return isPathWithin(this.#state.root, path)
  }

  async #resolveId(ctx, source, importer, opts) {
    // Left to the user's external config. SECURITY: never consult getImport for a builtin, so a tampered bundle
    // can't redirect `fs`.
    if (isBuiltin(source)) return null
    const { isEntry, attributes: attrs = {} } = opts

    // Load mode resolves through the bundle's import map: the file may not be on disk.
    if (this.#state.config.loadBundle) {
      if (isEntry) {
        // Rollup defaults isEntry to !importer, so this covers bare sibling probes too: the load hook asserts entries
        // from the graph instead. Anchored as rollup's resolver does, else to cwd as the run loader is.
        if (source.startsWith('file:')) return { id: fileURLToPath(source) }
        const base = isDiskId(importer) ? dirname(importer) : process.cwd()
        return { id: resolvePath(base, source) }
      }
      if (!isDiskId(importer) || !this.#inRoot(importer)) return null
      assertPersistableAttributes(attrs)
      const attested = attestedImport(this.#state, pathToFileURL(importer).toString(), source, { importAttributes: attrs })
      if (attested === undefined) return null
      const { url, format } = attested
      const path = fileURLToPath(url)
      // An out-of-scope resource comes from disk through the user's asset plugin, as at capture.
      if (Bundle.isResourceFormat(format) && inScope(this.#state, url)) this.#refuseResourceLoad(path)
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
    classifyOrThrow('StasisRollup', id, this.#resources)

    // Code and resource targets alike, but never for an entry, flagged from the graph in buildEnd (opts.isEntry is
    // a sibling's probe too), nor an out-of-root importer, which load mode defers too.
    if (!isEntry && isDiskId(importer) && this.#inRoot(importer)) {
      assertPersistableAttributes(attrs)
      if (!this.#inRoot(id)) {
        throw new Error(
          `StasisRollup: '${source}' imported from ${importer} resolves outside the project root and can't be attested: ${id}`
        )
      }
      this.#state.addImport(pathToFileURL(importer).toString(), source, pathToFileURL(id).toString(), { importAttributes: attrs })
    }
    return resolution
  }

  async #load(ctx, id) {
    // getFile verifies the hash and throws on a file the bundle doesn't carry: no disk fallback. Ids other plugins
    // resolved land here too.
    if (this.#state.config.loadBundle) {
      if (!isDiskId(id) || !this.#inRoot(id)) return null
      const url = pathToFileURL(id).toString()
      // The graph's isEntry: a sibling's resolve() probe carries isEntry too but never loads.
      if (this.#state.config.full && ctx.getModuleInfo(id)?.isEntry) this.#state.assertEntry(url)
      if (!inScope(this.#state, url)) return null
      const { source, format } = this.#state.getFile(url)
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
    const resource = classifyOrThrow('StasisRollup', id, this.#resources) === 'resource'
    if (!this.#inRoot(id)) {
      throw new Error(`StasisRollup: module is outside the project root and can't be attested: ${id}`)
    }
    if (!resource) assertCodeUtf8('StasisRollup', id, source)
    if (!this.#seen.has(id)) {
      this.#seen.add(id)
      this.#state.addFile(pathToFileURL(id).toString(), { source, resource, reason: 'rollup' })
    }
    // A resource is the user's asset plugin's to load; code is served as recorded (transform hooks still run after).
    return resource ? null : source.toString('utf8')
  }

  // Flags the graph's real entries (resolveId's opts.isEntry would take a sibling's bare probe for one), then writes
  // a standalone or sidecar State on a clean build. buildEnd, not closeBundle, which only bundle.close() fires.
  async #buildEnd(ctx, error) {
    if (error) return
    const entryIds = [...ctx.getModuleIds()].filter((id) => {
      if (!this.#seen.has(id)) return false
      const info = ctx.getModuleInfo(id)
      return Boolean(info?.isEntry) && !info.isExternal
    })
    // addFile re-verifies the bytes, and refuses a RESOURCE entry, as StasisEsbuild does.
    const sources = await Promise.all(entryIds.map((id) => realReadFile(id)))
    for (const [i, id] of entryIds.entries()) {
      const resource = classifyExtension(id, this.#resources) === 'resource'
      this.#state.addFile(pathToFileURL(id).toString(), { source: sources[i], isEntry: true, resource, reason: 'rollup' })
    }
    if (this.#state !== State.preload) this.#state.write()
  }
}
