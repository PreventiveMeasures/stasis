import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'
import { servedByBundle } from '@exodus/stasis-core/state-util'
import { transformContext } from './metro-babel-transformer.js'

// The worker half of StasisMetro, wired by withStasis() as `transformerPath` around the project's transformer. It
// keeps each import as written for the serializer (./metro-babel-transformer.js), and is the LOAD half: a per-worker
// seam, as load only reads an immutable bundle, replacing Metro's `data` with the bundle's hash-verified bytes. Metro
// reads and hashes each file before this runs, so sources must stay on disk: attested bytes, fail closed on drift.

const require = createRequire(import.meta.url)

// The project's transformer: the `transformerPath` withStasis() replaced, else EXODUS_STASIS_METRO_BASE_TRANSFORMER,
// else Metro's default, a name resolved from the project root first, as Metro requires it from its own dir. This
// transformer itself (wired by hand as well) means Metro's default.
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

const baseConfig = ({ stasisBaseTransformerPath: _, ...config } = {}) => config

// The worker's load State, null outside load (a pass-through, so wiring this permanently is safe). A failure is
// cached and rethrown on every call, never passed through after the first. It never writes, so claims no write path.
let loaded
function getLoadState() {
  if (loaded === undefined) {
    try {
      const state = new State(process.cwd(), { claim: false })
      loaded = { state: state.config.loadBundle ? state : null }
    } catch (error) {
      loaded = { error }
    }
  }
  if ('error' in loaded) throw loaded.error
  return loaded.state
}

const BABEL_TRANSFORMER = fileURLToPath(new URL('./metro-babel-transformer.js', import.meta.url))

// Metro resolves a configured Babel transformer; its default stays a name, which the base requires from its own dir.
const resolveBabelTransformer = (base, path) => (isAbsolute(path) ? path : createRequire(base.file).resolve(path))

// Each dependency as the source wrote it: `stasisAsWritten` where Babel rewrote its specifier (several written apart
// may be rewritten alike), `stasisInserted` where no specifier in the source names it (a Babel helper, Metro's
// asyncRequire). The imports a Babel plugin consumed ride on the module's first output's data, as `stasisConsumed`.
function withAsWritten(result, { asWritten, consumed }) {
  if (!Array.isArray(result?.dependencies)) return result
  const dependencies = result.dependencies.map((dep) => {
    const written = asWritten.get(dep.name)
    if (written === undefined) return { ...dep, stasisInserted: true }
    if (written.size === 1 && written.has(dep.name)) return dep
    return { ...dep, stasisAsWritten: [...written] }
  })
  if (consumed.size === 0 || !Array.isArray(result.output) || result.output.length === 0) return { ...result, dependencies }
  const [first, ...rest] = result.output
  return { ...result, dependencies, output: [{ ...first, data: { ...first.data, stasisConsumed: [...consumed] } }, ...rest] }
}

export async function transform(config, projectRoot, filename, data, options) {
  const base = baseOf(config, projectRoot)
  config = baseConfig(config)
  const state = getLoadState()
  if (state) {
    // `filename` is project-relative in Metro's contract.
    const absolute = resolvePath(projectRoot, filename)
    // getFile re-verifies the hash and throws on a file the bundle doesn't carry: no disk fallback.
    if (servedByBundle(state, absolute)) {
      const { source } = state.getFile(pathToFileURL(absolute).toString())
      data = Buffer.isBuffer(source) ? source : Buffer.from(source)
    }
  }
  if (typeof config.babelTransformerPath !== 'string') return base.transformer.transform(config, projectRoot, filename, data, options)
  const context = { babelTransformerPath: resolveBabelTransformer(base, config.babelTransformerPath), asWritten: new Map(), consumed: new Set() }
  const result = await transformContext.run(context, () =>
    base.transformer.transform({ ...config, babelTransformerPath: BABEL_TRANSFORMER }, projectRoot, filename, data, options))
  return withAsWritten(result, context)
}

// The base's key, marked by the load State transform() goes by, so a load result never shares a disk build's entry.
export function getCacheKey(config, opts) {
  const { transformer } = baseOf(config, opts?.projectRoot)
  const baseKey = typeof transformer.getCacheKey === 'function' ? transformer.getCacheKey(baseConfig(config), opts) : ''
  const state = getLoadState()
  const marker = state ? `load:${state.config.bundleFile || 'default'}` : 'off'
  return `${baseKey}$stasis-metro-transformer:${marker}`
}
