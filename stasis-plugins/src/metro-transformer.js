import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'
import { transformContext } from './metro-babel-transformer.js'

// Companion to the StasisMetro serializer, which withStasis() wires as Metro's `transformerPath`
// whenever stasis attests the build (wire it yourself only alongside a hand-wired serializer). It
// wraps the project's own transformer, and does two things in each worker:
//  - keeps each import as written for the serializer, through the Babel transformer it swaps in
//    (./metro-babel-transformer.js): a dependency Babel rewrote (e.g. through
//    babel-plugin-module-resolver) carries the specifiers written in the source as `stasisAsWritten`;
//  - is the LOAD half of stasis for Metro (under load the serializer only asserts edges). Load only
//    READS an immutable bundle and every worker reads the same bytes (no IPC), so a per-worker
//    transformer is the natural seam: it replaces Metro's on-disk `data` with the bundle's
//    hash-verified bytes (fail-closed; out-of-scope files pass their disk bytes through).
//    KNOWN LIMITATION: does NOT build with sources absent from disk -- Metro reads + hashes each
//    file before this runs, so the guarantee is "build attested bytes, fail closed on disk drift."

const require = createRequire(import.meta.url)

// The project's own transformer, which this one runs: the `transformerPath` withStasis() replaced,
// handed over in Metro's transformer config, else EXODUS_STASIS_METRO_BASE_TRANSFORMER, else
// Metro's default. Metro requires a name from its own dir, which only the project's node_modules
// is sure to reach, so a name resolves from the project root, then from here. A base that is this
// transformer itself (wired by hand as well) is passed over for Metro's default.
const bases = new Map()
function baseOf(config, projectRoot = process.cwd()) {
  const path = config?.stasisBaseTransformerPath ?? (process.env.EXODUS_STASIS_METRO_BASE_TRANSFORMER || 'metro-transform-worker')
  const key = `${projectRoot}\0${path}`
  if (!bases.has(key)) {
    const resolve = (name) => require.resolve(name, { paths: [projectRoot, dirname(fileURLToPath(import.meta.url))] })
    let file = resolve(path)
    if (require(file).transform === transform) file = resolve('metro-transform-worker')
    bases.set(key, { file, transformer: require(file) })
  }
  return bases.get(key)
}

// The config the project's transformer sees: its own, without what withStasis() handed over.
function baseConfig({ stasisBaseTransformerPath: _, ...config } = {}) {
  return config
}

// Per-worker load State, built once from the usual env + stasis.config.json. Non-load mode -> null
// -> transparent pass-through, so wiring it permanently is safe. A construction failure is cached
// and rethrown on every call -- never throw-once-then-silently-pass-through. It never writes, so it
// claims no write path: a capturing worker's own preload State already holds them.
let stateInited = false
let loadState = null
let stateError = null
function getLoadState() {
  if (!stateInited) {
    try {
      const state = new State(process.cwd(), { claim: false })
      loadState = state.config.loadBundle ? state : null
    } catch (err) {
      stateError = err
      throw err
    } finally {
      stateInited = true
    }
  }
  if (stateError) throw stateError
  return loadState
}

// True iff `absolute` is in scope for load mode. state.relative throws outside the project root
// (out-of-scope: system files, scratch) -> defer to disk. Mirrors the webpack plugin's inScope.
function inScope(state, absolute) {
  try {
    state.relative(absolute)
  } catch {
    return false
  }
  if (state.config.full) return true
  return state.inNodeModules(pathToFileURL(absolute).toString())
}

// The Babel transformer swapped in for the project's, by path as metro-transform-worker requires it.
const BABEL_TRANSFORMER = fileURLToPath(new URL('./metro-babel-transformer.js', import.meta.url))

// The project's Babel transformer, absolute. Metro resolves a configured one; its default
// ('metro-babel-transformer') stays a name, which the base transformer requires from its own dir.
function resolveBabelTransformer(base, path) {
  return isAbsolute(path) ? path : createRequire(base.file).resolve(path)
}

// Each dependency named by a specifier Babel rewrote, with the ones written in the source. One
// Metro dependency can stand for several, written apart and rewritten alike (`#local/abc` and
// `./src/abc`); a dependency written as Metro names it is left as is.
function withAsWritten(result, asWritten) {
  if (asWritten.size === 0 || !Array.isArray(result?.dependencies)) return result
  const dependencies = result.dependencies.map((dep) => {
    const written = asWritten.get(dep.name)
    if (written === undefined || (written.size === 1 && written.has(dep.name))) return dep
    return { ...dep, stasisAsWritten: [...written] }
  })
  return { ...result, dependencies }
}

export async function transform(config, projectRoot, filename, data, options) {
  const base = baseOf(config, projectRoot)
  config = baseConfig(config)
  const state = getLoadState()
  if (state) {
    // `filename` is project-relative in Metro's contract; resolve against projectRoot.
    const absolute = resolvePath(projectRoot, filename)
    if (inScope(state, absolute)) {
      // getFile re-verifies the hash and throws on a file the bundle doesn't carry (fail-closed,
      // no disk fallback). Code sources come back as strings; resources as Buffers.
      const { source } = state.getFile(pathToFileURL(absolute).toString())
      data = Buffer.isBuffer(source) ? source : Buffer.from(source)
    }
  }
  if (typeof config.babelTransformerPath !== 'string') return base.transformer.transform(config, projectRoot, filename, data, options)
  const context = { babelTransformerPath: resolveBabelTransformer(base, config.babelTransformerPath), asWritten: new Map() }
  const result = await transformContext.run(context, () =>
    base.transformer.transform({ ...config, babelTransformerPath: BABEL_TRANSFORMER }, projectRoot, filename, data, options))
  return withAsWritten(result, context.asWritten)
}

export function getCacheKey(config, opts) {
  // Fold in the base transformer's cache key, then add a stasis-load discriminator so load results
  // (which can differ from a disk build even when disk == bundle) don't cross-pollinate the cache.
  // Derive the marker from the resolved load State, which transform() goes by.
  const { transformer } = baseOf(config, opts?.projectRoot)
  const baseKey = typeof transformer.getCacheKey === 'function' ? transformer.getCacheKey(baseConfig(config), opts) : ''
  const state = getLoadState()
  const marker = state ? `load:${state.config.bundleFile || 'default'}` : 'off'
  return `${baseKey}$stasis-metro-transformer:${marker}`
}
