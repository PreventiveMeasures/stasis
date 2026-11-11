import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { Bundle } from '@exodus/stasis-core/bundle'
import { assertCodeUtf8, assertPersistableAttributes, attestedImport, ownOrResolvedState, rebuildRefused, unsupportedExtension } from './plugins.js'
import { State } from '@exodus/stasis-core/state'
// Pre-patch snapshot, not `import { readFile }`: under --fs=async that builtin is patched, and
// this plugin loads after, so a direct import would route esbuild's reads through the capture hook.
import { realReadFile } from '@exodus/stasis-core/state-util'
import { EMPTY_MODULE_PATH, classifyExtension, upsert } from '@exodus/stasis-core/util'

// The build options esbuild's resolver reads, replayed into the disabled-import probe.
const RESOLVE_OPTIONS = ['absWorkingDir', 'alias', 'conditions', 'external', 'mainFields', 'nodePaths',
  'packages', 'platform', 'preserveSymlinks', 'resolveExtensions', 'tsconfig', 'tsconfigRaw']

// One import of `specifier` as `kind` would issue it, as the probe's stdin.
function probeSource(specifier, kind) {
  const quoted = JSON.stringify(specifier)
  if (kind === 'require-call' || kind === 'require-resolve') return { contents: `require(${quoted})`, loader: 'js' }
  if (kind === 'dynamic-import') return { contents: `import(${quoted})`, loader: 'js' }
  if (kind === 'import-rule' || kind === 'composes-from') return { contents: `@import ${quoted};`, loader: 'css' }
  if (kind === 'url-token') return { contents: `a { b: url(${quoted}) }`, loader: 'css' }
  return { contents: `import ${quoted}`, loader: 'js' }
}

// A `browser` map key or a path, loosened past esbuild's matching (bare, plus each resolve extension, plus `/index`,
// with or without './'): equal loose keys are a SUPERSET of esbuild's matches -- only a probe decides.
function looseBrowserKey(path) {
  const parts = path.replaceAll('\\', '/').split('/').filter((part) => part !== '' && part !== '.')
  while (parts.length > 0) {
    const stem = parts.at(-1).replace(/\..*$/su, '')
    if (stem !== 'index' || parts.length === 1) {
      parts[parts.length - 1] = stem
      break
    }
    parts.pop()
  }
  return parts.join('/')
}

// The loose keys a directory's package.json `browser` map sends to `false` (esbuild's "disabled").
async function browserFalseKeys(dir) {
  let pkg
  try {
    pkg = JSON.parse(await realReadFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    return new Set()
  }
  const browser = pkg?.browser
  if (browser === null || typeof browser !== 'object' || Array.isArray(browser)) return new Set()
  return new Set(Object.keys(browser).filter((key) => browser[key] === false).map((key) => looseBrowserKey(key)))
}

export class StasisEsbuild {
  #seen = new Set()
  #state
  #resources
  #loaders
  #transform
  #resource
  #platform
  #emptyModule // URL of the empty module disabled imports point at, once capture recorded it
  #browserScopes = new Map() // dir -> Promise<[{ dir, keys }]>: `false` keys of it and its ancestors
  #probes = new Map() // [kind, resolveDir, specifier] -> Promise<disabled path | null>
  #captureBuildCount = 0

  // Only for load mode: `loaders` per-extension overrides (RN's '.js' -> 'jsx'), `transform(source, { path, loader })`
  // a code rewrite (`stasis build --platform=hermes`), `resource(source, { path })` a module for a resource no loader
  // names (`stasis build --metro`'s asset module), `platform` the one a --metro per-platform edge resolves for.
  constructor(options = {}, { loaders, transform, resource, platform } = {}) {
    const state = ownOrResolvedState('StasisEsbuild', options)
    this.#state = state
    this.#resources = state?.config.resources ?? new Set()
    this.#loaders = loaders ?? new Map()
    this.#transform = transform
    this.#resource = resource
    this.#platform = platform
  }

  // A configured override, else from the extension (.cjs/.mjs/.cts/.mts drop their module letter).
  #loaderFor(path) {
    const ext = extname(path)
    return this.#loaders.get(ext) ?? ext.replace(/^\.[cm]?/u, '')
  }

  get name() {
    return 'stasis'
  }

  // Every directory from `dir` up whose `browser` map disables something, nearest first: a superset, as esbuild
  // consults only the nearest map.
  #browserFalseScopes(dir) {
    return upsert(this.#browserScopes, dir, () => {
      const parent = dirname(dir)
      return Promise.all([browserFalseKeys(dir), parent === dir ? [] : this.#browserFalseScopes(parent)])
        .then(([keys, above]) => (keys.size > 0 ? [{ dir, keys }, ...above] : above))
    })
  }

  // Whether some `browser` map `false` entry could match this resolution: the resolved path (and, for a relative
  // specifier, the path it names) under each map's dir, or a bare specifier as is or as './<importer dir>/<specifier>'
  // (a Browserify quirk esbuild keeps).
  async #mayBeDisabled(path, specifier, resolveDir) {
    const isPackagePath = !isAbsolute(specifier) && !/^\.\.?(?:\/|$)/u.test(specifier) && !specifier.startsWith('/')
    const paths = isPackagePath ? [path] : [path, resolvePath(resolveDir, specifier)]
    const dirs = new Set([resolveDir, ...paths.map((p) => dirname(p))])
    const scopes = (await Promise.all([...dirs].map((dir) => this.#browserFalseScopes(dir)))).flat()
    return scopes.some((scope) => {
      const candidates = paths.map((p) => relative(scope.dir, p))
      if (isPackagePath) candidates.push(specifier, join(relative(scope.dir, resolveDir), specifier))
      return candidates.some((candidate) => scope.keys.has(looseBrowserKey(candidate)))
    })
  }

  // esbuild's own verdict: a one-import build with the build's resolve options and every load stubbed empty, whose
  // metafile still names a disabled module `(disabled):<path>`. -> that path (absolute), or null
  #probeDisabled(specifier, kind, resolveDir, { esbuild, initialOptions }) {
    return upsert(this.#probes, JSON.stringify([kind, resolveDir, specifier]), () => {
      const options = Object.fromEntries(RESOLVE_OPTIONS.filter((k) => initialOptions[k] !== undefined).map((k) => [k, initialOptions[k]]))
      const cwd = initialOptions.absWorkingDir ?? process.cwd()
      return esbuild.build({
        ...options,
        stdin: { ...probeSource(specifier, kind), resolveDir },
        bundle: true,
        write: false,
        metafile: true,
        logLevel: 'silent',
        plugins: [{ name: 'stasis-probe', setup: (build) => build.onLoad({ filter: /$/ }, () => ({ contents: '', loader: 'empty' })) }],
      }).then(({ metafile }) => {
        const found = metafile.inputs['<stdin>']?.imports.find((i) => i.original === specifier)?.path
        if (!found?.startsWith('(disabled):')) return null
        return resolvePath(cwd, found.slice('(disabled):'.length))
      }, () => null)
    })
  }

  // A `browser` field `false` makes esbuild resolve an import to an empty "disabled" module, but its resolve API
  // drops that flag: a bare name comes back namespace-less, a file as its plain path, which a probe confirms where a
  // `false` entry could match.
  async #isDisabled(res, specifier, { kind, resolveDir }, build) {
    if (res.external) return false
    if (res.namespace === '') return true
    if (res.namespace !== 'file' || (build.initialOptions.platform ?? 'browser') !== 'browser') return false
    if (!(await this.#mayBeDisabled(res.path, specifier, resolveDir))) return false
    // A sibling plugin may have resolved the import to something else entirely.
    return (await this.#probeDisabled(specifier, kind, resolveDir, build)) === res.path
  }

  setup = ({ onResolve, onLoad, onStart, onEnd, resolve, initialOptions, esbuild }) => {
    if (!this.#state) return
    const emptyModuleURL = pathToFileURL(resolvePath(this.#state.root, EMPTY_MODULE_PATH)).toString()

    // Rebuilds re-fire onStart against the same registrations.
    if (!this.#state.config.loadBundle) {
      onStart(() => {
        this.#captureBuildCount += 1
        return this.#captureBuildCount === 1 ? undefined : { errors: [{ text: rebuildRefused('StasisEsbuild') }] }
      })
    }

    // The preload writes itself; a failed build mustn't overwrite the user's good file.
    if (this.#state !== State.preload) {
      onEnd((result) => {
        if (result.errors.length === 0) this.#state.write()
      })
    }

    // Load mode resolves through the bundle's import map: the file may not be on disk. namespace 'file' with the
    // original path (esbuild doesn't stat a plugin's) keeps the output (banners, asset names, maps) a capture's.
    onResolve({ filter: /$/ }, ({ path: specifier, importer, kind: resolveKind, with: attrs }) => {
      if (!this.#state.config.loadBundle) return undefined
      const isEntry = resolveKind === 'entry-point'
      let url
      if (isEntry) {
        // Anchored to cwd, as the run loader does, so the file needn't be on disk.
        url = specifier.startsWith('file:') ? specifier : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
        if (this.#state.config.full) this.#state.assertEntry(url)
      } else {
        // Looked up even for a built-in's name: a browser build records `fs` where a `browser` field disables it or a
        // package by that name serves it. KNOWN GAP: a Node-loader-captured bundle keys an attributed edge under
        // specific conditions, which this `*` lookup won't match.
        const parentURL = pathToFileURL(importer).toString()
        const attested = attestedImport(this.#state, parentURL, specifier, { importAttributes: attrs, platform: this.#platform })
        if (attested === undefined) return undefined
        ;({ url } = attested)
      }
      const format = this.#state.getFormat(url)
      const kind = url === emptyModuleURL ? 'empty' : Bundle.isResourceFormat(format) ? 'resource' : 'code'
      return { path: fileURLToPath(url), namespace: 'file', pluginData: { isEntry, kind } }
    })

    onResolve({ filter: /$/, namespace: 'file' }, async ({ path: specifier, with: attrs, ...args }) => {
      const isEntry = !args.importer
      // A synthetic namespace runs esbuild's own resolver without re-entering this hook.
      const res = await resolve(specifier, { ...args, with: attrs, namespace: 'stasis' })
      // A miss is esbuild's to report, or tolerate (a require() in a try/catch): decline, recording no edge.
      if (res.errors.length > 0) return undefined
      // Declined, esbuild re-resolves a disabled import into its own empty module, the attested one bundle=load serves.
      if (!isEntry && await this.#isDisabled(res, specifier, args, { esbuild, initialOptions })) {
        if (!this.#state.config.loadBundle) {
          this.#emptyModule ??= this.#state.addEmptyModule({ reason: 'esbuild' })
          this.#state.addImport(pathToFileURL(args.importer).toString(), specifier, this.#emptyModule, { importAttributes: attrs })
        }
        return undefined
      }
      assert.equal(res.suffix, '',
        `StasisEsbuild: a sibling plugin set res.suffix='${res.suffix}' on '${specifier}'; ` +
        `stasis can't persist suffixes to the bundle. Disable that plugin or drop suffix from its resolve result.`)

      let kind = 'skip'
      if (res.namespace === 'file' && !res.external) {
        kind = classifyExtension(res.path, this.#resources)
        if (kind === 'unknown') return { errors: [{ text: unsupportedExtension('StasisEsbuild', `'${res.path}'`) }] }
        // Resources too: load mode resolves every specifier through this map, so one with no edge would fall through
        // to esbuild's disk resolver, unattested.
        const url = pathToFileURL(res.path).toString()
        if (!isEntry) this.#state.addImport(pathToFileURL(args.importer).toString(), specifier, url, { importAttributes: attrs })
      }
      return { ...res, pluginData: { ...res.pluginData, isEntry, kind } }
    })

    onLoad({ filter: /$/, namespace: 'file' }, async ({ path, pluginData, with: attrs }) => {
      const kind = pluginData?.kind ?? 'skip'
      if (kind === 'skip') return undefined
      assertPersistableAttributes(attrs)

      // getFile verifies the hash and throws on a file the bundle doesn't carry: no disk fallback.
      if (this.#state.config.loadBundle) {
        const { source } = this.#state.getFile(pathToFileURL(path).toString())
        // esbuild's own loader for disabled modules, which a CSS @import, `composes` or url() accepts too.
        if (kind === 'empty') return { contents: source, loader: 'empty' }
        if (kind === 'resource') {
          const override = this.#loaders.get(extname(path))
          if (override) return { contents: source, loader: override }
          const built = await this.#resource?.(source, { path })
          if (built) return built
          // The build's own loader for it, so a resource none loads fails as at capture, not parsed as js.
          return { contents: source, loader: 'default' }
        }
        const loader = this.#loaderFor(path)
        return (await this.#transform?.(source, { path, loader })) ?? { contents: source, loader }
      }

      const source = await realReadFile(path)
      const resource = kind === 'resource'
      if (!resource) assertCodeUtf8('StasisEsbuild', path, source)
      if (!this.#seen.has(path)) {
        this.#seen.add(path)
        this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, resource, reason: 'esbuild' })
      }
      // A resource is emitted by esbuild, through the build's own `loader` config.
      return resource ? undefined : { contents: source, loader: this.#loaderFor(path) }
    })
  }
}
