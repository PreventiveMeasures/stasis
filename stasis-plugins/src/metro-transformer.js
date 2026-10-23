import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'
import { transformContext } from './metro-babel-transformer.js'

// Companion to the StasisMetro serializer: the LOAD half of stasis for Metro. Load only READS an
// immutable bundle and every worker reads the same bytes (no IPC), so a per-worker transformer is
// the natural seam. Wire it permanently in metro.config.js (transformerPath); outside `stasis run`
// it is a transparent pass-through, and under load the serializer is too -- the mode picks the
// active half. In load mode, wrap the user's real transformer and replace Metro's on-disk `data`
// with the bundle's hash-verified bytes (fail-closed; out-of-scope files pass their disk bytes through).
// KNOWN LIMITATION: does NOT build with sources absent from disk -- Metro reads + hashes each file
// before this runs, so the guarantee is "build attested bytes, fail closed on disk drift."
//
// Under `stasis run` it also keeps each import as written for the serializer, through the Babel
// transformer it swaps in (./metro-babel-transformer.js): a dependency Babel rewrote (e.g. through
// babel-plugin-module-resolver) carries the specifiers written in the source as `stasisAsWritten`.

const require = createRequire(import.meta.url)

// The real transformer we wrap (default matches Metro's; override for a custom TS/Babel preset).
// Required lazily per worker so a non-load build pays nothing.
const BASE_TRANSFORMER = process.env.EXODUS_STASIS_METRO_BASE_TRANSFORMER || 'metro-transform-worker'

let base
function getBase() {
  base ??= require(BASE_TRANSFORMER)
  return base
}

// Per-worker load State, built once from the usual env + stasis.config.json. Non-load mode -> null
// -> transparent pass-through, so wiring it permanently is safe. A construction failure is cached
// and rethrown on every call -- never throw-once-then-silently-pass-through.
let stateInited = false
let loadState = null
let stateError = null
function getLoadState() {
  if (!stateInited) {
    try {
      const state = new State(process.cwd())
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

// Whether this build runs under `stasis run`, whose bin exports EXODUS_STASIS_LOCK to the whole
// process tree, Metro's workers included: the signal the serializer's Rule 0 keys on too.
const underStasisRun = () => process.env.EXODUS_STASIS_LOCK !== undefined

// The Babel transformer swapped in for the project's, by path as metro-transform-worker requires it.
const BABEL_TRANSFORMER = fileURLToPath(new URL('./metro-babel-transformer.js', import.meta.url))

// The project's Babel transformer, absolute. Metro resolves a configured one; its default
// ('metro-babel-transformer') stays a name, which the base transformer requires from its own dir.
const babelTransformers = new Map()
function resolveBabelTransformer(path) {
  if (isAbsolute(path)) return path
  if (!babelTransformers.has(path)) {
    babelTransformers.set(path, createRequire(require.resolve(BASE_TRANSFORMER)).resolve(path))
  }
  return babelTransformers.get(path)
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
  // In every mode under `stasis run`, load included, so the modules a worker loads are the same
  // when recorded and when replayed.
  if (!underStasisRun() || typeof config?.babelTransformerPath !== 'string') {
    return getBase().transform(config, projectRoot, filename, data, options)
  }
  const context = { babelTransformerPath: resolveBabelTransformer(config.babelTransformerPath), asWritten: new Map() }
  const result = await transformContext.run(context, () =>
    getBase().transform({ ...config, babelTransformerPath: BABEL_TRANSFORMER }, projectRoot, filename, data, options))
  return withAsWritten(result, context.asWritten)
}

export function getCacheKey(config) {
  // Fold in the base transformer's cache key, then add a stasis discriminator so neither load
  // results (which can differ from a disk build even when disk == bundle) nor ones carrying
  // `stasisAsWritten` cross-pollinate the cache with a plain build's. Derive the load marker from
  // the resolved load State (not the env) so config.json activation keys too.
  const baseKey = typeof getBase().getCacheKey === 'function' ? getBase().getCacheKey(config) : ''
  const state = getLoadState()
  const marker = state ? `load:${state.config.bundleFile || 'default'}` : underStasisRun() ? 'as-written' : 'off'
  return `${baseKey}$stasis-metro-transformer:${marker}`
}
