import { existsSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertCodeUtf8, attestedImport, classifyOrThrow, resolvePluginState } from './plugins.js'
import { State } from '@exodus/stasis-core/state'
import { realReadFileSync, servedByBundle } from '@exodus/stasis-core/state-util'

const require = createRequire(import.meta.url)

// The package.json "imports" subpaths ('#app/abc.js') babel-plugin-module-resolver rewrote, by (importer, rewritten
// request) -> the '#'-specifiers (several aliases can collide on one key). Shared by the one patch and every instance.
const subpathOriginals = new Map()
const edgeKey = (importerAbsolute, request) => `${importerAbsolute}\u0000${request}`

const PATCHED = Symbol('stasis.modresolver.patched')

// For a bundle-served file under load: webpack's resolver needs only existence and size, the hash attests content.
function bundleStat(size, isDir = false) {
  return {
    isFile: () => !isDir,
    isDirectory: () => isDir,
    ...Object.fromEntries(['isSymbolicLink', 'isBlockDevice', 'isCharacterDevice', 'isFIFO', 'isSocket'].map((name) => [name, () => false])),
    size,
    ...Object.fromEntries(['mtime', 'atime', 'ctime', 'birthtime'].flatMap((name) => [[name, new Date(0)], [`${name}Ms`, 0]])),
    mode: isDir ? 0o040755 : 0o100644,
    uid: 0, gid: 0, ino: 0, nlink: 1, rdev: 0, blksize: 4096, blocks: 0, dev: 0,
  }
}

export class StasisWebpack {
  #seen = new Set()
  #state
  #resources
  // The compilers this instance drives, final by the first `done`: N for a MultiCompiler, whose write is deferred.
  #captureApplyCount = 0
  #deferredWriteArmed = false
  #deferredWriteDirty = false

  constructor(options = {}) {
    const { state } = resolvePluginState('StasisWebpack', options, process.cwd())
    this.#state = state
    this.#resources = state?.config.resources ?? new Set()
  }

  apply(compiler) {
    if (!this.#state) return
    if (this.#state.config.loadBundle) this.#applyLoadMode(compiler)
    else this.#applyCaptureMode(compiler)
  }

  // As `stasis run --bundle=load`: an in-scope path comes from the bundle (getFile re-verifies the hash), never from
  // disk. The bundle is the FAMILY: this State, then its parent where it is a sidecar (one shared lockfile). KNOWN
  // LIMITATION: a package.json the resolver reads that no family bundle carries fails closed (tests/webpack.test.js).
  #applyLoadMode(compiler) {
    const state = this.#state
    const orig = compiler.inputFileSystem
    const served = (p) => typeof p === 'string' && p !== '' && servedByBundle(state, p)
    const family = state.parent ? [state, state.parent] : [state]
    const ownerOf = (url) => family.find((s) => s.getFsStat(url) !== undefined)
    // Throws on a miss: the fail-closed gate.
    const serveFromBundle = (p) => {
      const url = pathToFileURL(p).toString()
      return (ownerOf(url) ?? state).getFile(url).source
    }

    const wrappedReadFile = (p, options, callback) => {
      if (typeof options === 'function') { callback = options; options = undefined }
      if (served(p)) {
        try {
          const src = serveFromBundle(p)
          return callback(null, Buffer.isBuffer(src) ? src : Buffer.from(src))
        } catch (err) {
          return callback(err)
        }
      }
      // CachedInputFileSystem.readFile is (path, callback): an undefined middle arg would land in the callback slot.
      if (options === undefined) return orig.readFile(p, callback)
      return orig.readFile(p, options, callback)
    }
    const wrappedStat = (p, callback) => {
      if (served(p)) {
        // The resolver stat()s the dirs it walks, which have no bundle content but an existence record.
        const url = pathToFileURL(p).toString()
        if (ownerOf(url)?.getFsStat(url) === 'directory') return callback(null, bundleStat(0, true))
        try {
          const src = serveFromBundle(p)
          return callback(null, bundleStat(typeof src === 'string' ? Buffer.byteLength(src) : src.length))
        } catch (err) {
          return callback(err)
        }
      }
      return orig.stat(p, callback)
    }
    // A Proxy, not Object.assign: CachedInputFileSystem keeps its state on `this`, so forwarded calls keep orig.
    compiler.inputFileSystem = new Proxy(orig, {
      get(target, prop) {
        if (prop === 'readFile') return wrappedReadFile
        if (prop === 'stat') return wrappedStat
        const v = Reflect.get(target, prop, target)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })

    compiler.hooks.normalModuleFactory.tap('Stasis', (nmf) => {
      nmf.hooks.beforeResolve.tap('Stasis', (data) => {
        const issuer = data.contextInfo?.issuer
        // An entry is absolute already, and an out-of-scope parent webpack's to resolve.
        if (!issuer || !served(issuer)) return
        // SECURITY: never consult getImport for a builtin, so a tampered bundle can't redirect `fs`.
        if (isBuiltin(data.request)) return
        const resolved = attestedImport(state, pathToFileURL(issuer).toString(), data.request)
        if (resolved === undefined) return
        // The stat wrapper then reports it exists.
        data.request = fileURLToPath(resolved.url)
      })
    })
  }

  // webpack 4's enhanced-resolve has no imports field, so babel-plugin-module-resolver rewrites '#app/abc.js' before
  // the parser and afterResolve sees only the rewrite. Wrapping its rewrite chokepoint (v5's lib/mapPath default, or
  // v3/v4's lib/utils.mapPathString) records the original, so the edge is keyed by the portable specifier.
  #patchModuleResolver() {
    const paths = [this.#state.root, process.cwd()]
    for (const [sub, prop] of [['babel-plugin-module-resolver/lib/mapPath', 'default'], ['babel-plugin-module-resolver/lib/utils', 'mapPathString']]) {
      let mod
      try {
        mod = require(require.resolve(sub, { paths }))
      } catch {
        continue // absent, or a major without this submodule
      }
      const original = mod?.[prop]
      if (typeof original !== 'function' || original[PATCHED]) continue
      const wrapped = function stasisModuleResolverHook(nodePath, state) {
        const before = nodePath?.node?.value
        const result = original.apply(this, arguments)
        try {
          const after = nodePath?.node?.value
          const importer = state?.file?.opts?.filename
          if (typeof before === 'string' && before.startsWith('#') &&
              typeof after === 'string' && after !== before && typeof importer === 'string') {
            const key = edgeKey(path.resolve(importer), after)
            const originals = subpathOriginals.get(key) ?? []
            if (!originals.includes(before)) subpathOriginals.set(key, [...originals, before])
          }
        } catch {
          // A recorder fault must never break the build: the rewrite already ran.
        }
        return result
      }
      wrapped[PATCHED] = true
      mod[prop] = wrapped
    }
  }

  #applyCaptureMode(compiler) {
    this.#captureApplyCount += 1
    // apply() runs at webpack() construction, before compiler.run(), so before any afterResolve.
    this.#patchModuleResolver()
    compiler.hooks.normalModuleFactory.tap('Stasis', (nmf) => {
      // webpack 4 reuses rrd.context.issuer across factory calls, so by afterResolve it can hold an earlier
      // resolution's (tests/fixtures/webpack-stale-issuer-repro/NOTES.md); beforeResolve's is fresh, by dep[0].
      const issuerByDep = new WeakMap()
      nmf.hooks.beforeResolve.tap('Stasis', (data) => {
        const dep = data?.dependencies?.[0]
        const issuer = data?.contextInfo?.issuer
        if (dep && issuer) issuerByDep.set(dep, issuer)
      })

      nmf.hooks.afterResolve.tap('Stasis', (data) => {
        // webpack 5 nests rawRequest/resourceResolveData under createData.
        const cd = data.createData ?? data
        // No on-disk file to hash: data: URIs, null-loader stubs.
        const filePath = cd.resourceResolveData?.path
        if (!filePath || !path.isAbsolute(filePath) || !existsSync(filePath)) return
        const kind = classifyOrThrow('StasisWebpack', filePath, this.#resources)
        const url = pathToFileURL(filePath).toString()
        // rrd.context.issuer is webpack 4's alone, removed in enhanced-resolve 5.
        const dep = data?.dependencies?.[0]
        const issuer = (dep && issuerByDep.get(dep)) ?? data.contextInfo?.issuer ?? cd.resourceResolveData?.context?.issuer
        const isEntry = !issuer
        const rawRequest = cd.rawRequest ?? data.rawRequest
        if (kind === 'code' && !isEntry) {
          const issuerAbsolute = path.resolve(issuer)
          const parentURL = pathToFileURL(issuerAbsolute).toString()
          for (const specifier of subpathOriginals.get(edgeKey(issuerAbsolute, rawRequest)) ?? [rawRequest]) {
            this.#state.addImport(parentURL, specifier, url)
          }
        }
        if (!this.#seen.has(filePath)) {
          this.#seen.add(filePath)
          const source = realReadFileSync(filePath)
          if (kind === 'code') assertCodeUtf8('StasisWebpack', filePath, source)
          this.#state.addFile(url, { source, isEntry, resource: kind === 'resource', reason: 'webpack' })
        }
      })
    })

    // Dedupe is by path, so a rebuild with new bytes would emit them while the artifacts keep the old ones. watchRun
    // fires only under compiler.watch(), before the first build, so this refuses the whole session.
    compiler.hooks.watchRun.tap('Stasis', () => {
      throw new Error(
        'StasisWebpack: watch mode is not supported for capture -- ' +
        'run a one-shot build (watch rebuilds would silently attest stale content)'
      )
    })

    // The preload writes itself; a failed build mustn't overwrite a good lockfile.
    if (this.#state !== State.preload) {
      compiler.hooks.done.tap('Stasis', (stats) => {
        if (stats.hasErrors()) return
        // `done` fires per child of a MultiCompiler: one write, not N brotli passes over a growing bundle.
        if (this.#captureApplyCount === 1) this.#state.write()
        else this.#deferWrite()
      })
    }
  }

  // A single flush at beforeExit, with exit as the sync backstop for process.exit(). KNOWN LIMITATION: a signal death
  // bypasses it, as it does the preload's write.
  #deferWrite() {
    this.#deferredWriteDirty = true
    if (this.#deferredWriteArmed) return
    this.#deferredWriteArmed = true
    const flush = () => {
      if (!this.#deferredWriteDirty) return
      this.#state.write() // on a throw, dirty stays set so exit retries
      this.#deferredWriteDirty = false
    }
    process.on('beforeExit', flush)
    process.on('exit', flush)
  }
}
