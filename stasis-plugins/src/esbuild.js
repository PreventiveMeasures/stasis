import { isUtf8 } from 'node:buffer'
import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { Bundle } from '@exodus/stasis-core/bundle'
import { resolvePluginState } from './plugins.js'
import { State } from '@exodus/stasis-core/state'
// Pre-patch snapshot, not `import { readFile }`: under --fs=async that builtin is patched, and
// this plugin loads after, so a direct import would route esbuild's reads through the capture hook.
import { realReadFile } from '@exodus/stasis-core/state-util'
import { EMPTY_MODULE_PATH, classifyExtension } from '@exodus/stasis-core/util'

// The build options esbuild's resolver reads, replayed into the disabled-import probe so it
// resolves exactly as the build does.
const RESOLVE_OPTIONS = ['absWorkingDir', 'alias', 'conditions', 'external', 'mainFields', 'nodePaths',
  'packages', 'platform', 'preserveSymlinks', 'resolveExtensions', 'tsconfig', 'tsconfigRaw']

// One import of `specifier` as `kind` would issue it, as the probe's stdin.
function probeSource(specifier, kind) {
  const quoted = JSON.stringify(specifier)
  switch (kind) {
    case 'require-call':
    case 'require-resolve':
      return { contents: `require(${quoted})`, loader: 'js' }
    case 'dynamic-import':
      return { contents: `import(${quoted})`, loader: 'js' }
    case 'import-rule':
    case 'composes-from':
      return { contents: `@import ${quoted};`, loader: 'css' }
    case 'url-token':
      return { contents: `a { b: url(${quoted}) }`, loader: 'css' }
    default:
      return { contents: `import ${quoted}`, loader: 'js' }
  }
}

// A `browser` map key or a path to test against one, loosened past esbuild's matching (it tries a
// path bare, plus each resolve extension, plus `/index`, with or without './'): no './' or `.`
// segments, every extension stripped, trailing index segments dropped. Equal loose keys are a
// SUPERSET of esbuild's matches -- only a probe decides.
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
    return new Set() // no (readable) package.json: no map
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
  #emptyModule  // URL of the empty module disabled imports point at, once capture recorded it
  #browserScopes = new Map()  // dir -> Promise<[{ dir, keys }]>: `false` keys of it and its ancestors
  #probes = new Map()  // [kind, resolveDir, specifier] -> Promise<disabled path | null>

  // Build starts observed by this instance (across rebuilds and separate build()/context() calls);
  // the second is refused in onStart.
  #captureBuildCount = 0

  constructor(options = {}, { loaders, transform } = {}) {
    // A caller that owns a State (e.g. `stasis build`) can pass it directly; a foreign-copy State
    // fails closed via the instanceof miss.
    const state = options instanceof State
      ? options
      : resolvePluginState('StasisEsbuild', options, process.cwd()).state
    this.#state = state  // null when plugin should be inert
    // Cache the resolved resources Set for the per-file classify hot path.
    this.#resources = state?.config.resources ?? new Set()
    // Per-extension esbuild loader overrides (e.g. { '.js' -> 'jsx' } for RN's JSX-in-.js),
    // keyed by extname with the dot; falls back to #loaderFor.
    this.#loaders = loaders ?? new Map()
    // Load-mode-only code rewrite hook (e.g. `stasis build --platform=hermes` downleveling):
    // (source, { path, loader }) => { contents, loader } | undefined, may be async. Never
    // runs at capture -- capture attests the file's raw bytes.
    this.#transform = transform
  }

  // esbuild loader for a served file: configured override, else derived from extension
  // (.cjs/.mjs/.cts/.mts strip their module letter to js/ts).
  #loaderFor(path) {
    const ext = extname(path)
    return this.#loaders.get(ext) ?? ext.replace(/^\.[cm]?/u, '')
  }

  get name() {
    return 'stasis'
  }

  // Every directory from `dir` up whose package.json `browser` map disables something, nearest first.
  // esbuild consults only the nearest `browser` map, so this is a superset.
  #browserFalseScopes(dir) {
    let scopes = this.#browserScopes.get(dir)
    if (scopes === undefined) {
      const parent = dirname(dir)
      scopes = Promise.all([browserFalseKeys(dir), parent === dir ? [] : this.#browserFalseScopes(parent)])
        .then(([keys, above]) => (keys.size > 0 ? [{ dir, keys }, ...above] : above))
      this.#browserScopes.set(dir, scopes)
    }
    return scopes
  }

  // Whether some `browser` map `false` entry could match this resolution: the resolved path (and, for
  // a relative specifier, the path it names) under each map's dir, or a bare specifier as is or as
  // './<importer dir>/<specifier>' (a Browserify quirk esbuild keeps).
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

  // esbuild's own verdict: a one-import build from the importer's dir with the build's resolve options
  // and every load stubbed empty, whose metafile still names a disabled module `(disabled):<path>`.
  // -> that path (absolute), or null when esbuild doesn't disable the import.
  #probeDisabled(specifier, kind, resolveDir, { esbuild, initialOptions }) {
    const key = JSON.stringify([kind, resolveDir, specifier])
    let probe = this.#probes.get(key)
    if (probe === undefined) {
      const options = Object.fromEntries(RESOLVE_OPTIONS.filter((k) => initialOptions[k] !== undefined).map((k) => [k, initialOptions[k]]))
      const cwd = initialOptions.absWorkingDir ?? process.cwd()
      probe = esbuild.build({
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
      this.#probes.set(key, probe)
    }
    return probe
  }

  // A `browser` field mapping this import to `false` makes esbuild resolve it to an empty "disabled"
  // module, but its resolve API drops that flag: a bare name comes back as a namespace-less path, a
  // file as its plain path. The file case is confirmed by a probe, and only where a `false` entry
  // could match (browser platform, see #mayBeDisabled).
  async #isDisabled(res, specifier, { kind, resolveDir }, build) {
    if (res.external) return false
    if (res.namespace === '') return true // only a disabled bare name resolves to no namespace
    if (res.namespace !== 'file' || (build.initialOptions.platform ?? 'browser') !== 'browser') return false
    if (!(await this.#mayBeDisabled(res.path, specifier, resolveDir))) return false
    // Compare the paths: a sibling plugin may have resolved the import to something else entirely.
    return (await this.#probeDisabled(specifier, kind, resolveDir, build)) === res.path
  }

  setup = ({ onResolve, onLoad, onStart, onEnd, resolve, initialOptions, esbuild }) => {
    if (!this.#state) return  // noop plugin

    // Watch/rebuild capture is unsupported: dedupe is keyed by PATH not content, so a rebuild with
    // changed bytes would emit new bytes while the bundle/lockfile keep the OLD ones. Rebuilds re-fire
    // onStart against the same registrations, so an instance counter catches the second and errors.
    if (!this.#state.config.loadBundle) {
      onStart(() => {
        this.#captureBuildCount += 1
        if (this.#captureBuildCount === 1) return undefined
        return {
          errors: [{
            text: 'StasisEsbuild: watch/rebuild is not supported for capture -- run a one-shot build (rebuilds would silently attest stale content)',
          }],
        }
      })
    }

    // The preload writes itself (hooks.js); standalone/sidecar States are written on build finish --
    // only on a clean build (a partial one would overwrite the user's good file).
    if (this.#state !== State.preload) {
      onEnd((result) => {
        if (result.errors.length > 0) return
        this.#state.write()
      })
    }

    // Load mode: resolution comes from the bundle's import map, not esbuild's resolver -- the file
    // may not be on disk. Keep namespace:'file' with the original absolute path (esbuild doesn't stat
    // plugin-returned paths) so output bytes -- banners, asset names, source maps -- match a capture build.
    onResolve({ filter: /$/ }, ({ path: specifier, importer, kind: resolveKind, with: attrs }) => {
      if (!this.#state.config.loadBundle) return undefined
      const isEntry = resolveKind === 'entry-point'
      let url
      if (isEntry) {
        // Bare/relative entries are anchored to cwd (like the run loader), so the file needn't be on disk.
        url = specifier.startsWith('file:')
          ? specifier
          : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
        if (this.#state.config.full) this.#state.assertEntry(url)
      } else {
        const parentURL = pathToFileURL(importer).toString()
        // Forward import attributes (`with { type: 'json' }`) so plugin-capture round-trips to
        // plugin-load, both keyed under `* (with: ...)`. KNOWN GAP: a Node-loader-captured bundle
        // keys attributed edges under specific conditions the plugin's `*` lookup won't match.
        // The edge is looked up even for a built-in's name: a browser build records `fs` when a
        // `browser` field disables it (an edge to the empty module) or a package by that name serves it.
        try {
          ;({ url } = this.#state.getImport(parentURL, specifier, { importAttributes: attrs }))
        } catch (err) {
          // No attested edge -- at a successful capture that's a built-in or another EXTERNAL (never
          // recorded as an edge), so hand it back to esbuild, which externalizes it as without us
          // (built-ins under platform:'node'). File BYTES still fail closed at onLoad.
          // A non-MODULE_NOT_FOUND error is a real fault -- rethrow.
          if (err?.code === 'ERR_MODULE_NOT_FOUND') return undefined
          throw err
        }
      }
      const format = this.#state.getFormat(url)
      const isEmpty = url === pathToFileURL(resolvePath(this.#state.root, EMPTY_MODULE_PATH)).toString()
      const kind = isEmpty ? 'empty' : Bundle.isResourceFormat(format) ? 'resource' : 'code'
      return { path: fileURLToPath(url), namespace: 'file', pluginData: { isEntry, kind } }
    })

    onResolve({ filter: /$/, namespace: 'file' }, async ({ path: specifier, with: attrs, ...args }) => {
      const isEntry = !args.importer

      // Recurse with a synthetic namespace so esbuild's default resolver runs without re-entering us
      const res = await resolve(specifier, { ...args, with: attrs, namespace: 'stasis' })
      // A miss is esbuild's to report -- or to tolerate, as it does a require() in a try/catch (debug's
      // optional supports-color). Decline so it re-resolves exactly as without us; no edge.
      if (res.errors.length > 0) return undefined
      // A disabled import (`browser` field `false`): returning `res` would bundle the real file or fail
      // on a bare name, so decline and let esbuild re-resolve it into its own empty module. Capture
      // points the edge at the attested empty module, which is what bundle=load serves.
      if (!isEntry && await this.#isDisabled(res, specifier, args, { esbuild, initialOptions })) {
        if (!this.#state.config.loadBundle) {
          this.#emptyModule ??= this.#state.addEmptyModule({ reason: 'esbuild' })
          this.#state.addImport(pathToFileURL(args.importer).toString(), specifier, this.#emptyModule, { importAttributes: attrs })
        }
        return undefined
      }
      // A non-empty `suffix` (some CSS-modules plugins set one) can't be persisted to the bundle,
      // so refuse it rather than silently dropping it at capture.
      assert.equal(res.suffix, '',
        `StasisEsbuild: a sibling plugin set res.suffix='${res.suffix}' on '${specifier}'; ` +
        `stasis can't persist suffixes to the bundle. Disable that plugin or drop suffix from its resolve result.`)

      let kind = 'skip'
      if (res.namespace === 'file' && !res.external) {
        kind = classifyExtension(res.path, this.#resources)
        if (kind === 'unknown') {
          return {
            errors: [{
              text: `StasisEsbuild: unsupported extension for '${res.path}' -- add its extension or filename to the plugin's resources option or stop importing it`,
            }],
          }
        }
        // Record the edge for BOTH code and resource targets (never entries): load mode resolves
        // every specifier through this map, so a resource with no edge would miss at bundle=load and
        // fall through to esbuild's disk resolver -- serving the asset UNATTESTED. kind is code|resource here.
        if (!isEntry) {
          const parentURL = pathToFileURL(args.importer).toString()
          const url = pathToFileURL(res.path).toString()
          // Forward import attributes symmetrically with load: addImport keys by attributes so
          // getImport finds the same edge.
          this.#state.addImport(parentURL, specifier, url, { importAttributes: attrs })
        }
      }

      return { ...res, pluginData: { ...res.pluginData, isEntry, kind } }
    })

    onLoad({ filter: /$/, namespace: 'file' }, async ({ path, pluginData, with: attrs }) => {
      const kind = pluginData?.kind ?? 'skip'
      if (kind === 'skip') return undefined
      // Accept only the `type` import attribute; other attributes aren't persistable to the lockfile yet.
      for (const k of Object.keys(attrs)) {
        assert.equal(k, 'type', `unsupported import attribute: ${k}`)
      }

      // Load mode: serve bytes the bundle attested. getFile verifies the hash and throws on a file
      // the bundle doesn't carry -- a missing in-scope file is a hard error, not a disk fallback.
      if (this.#state.config.loadBundle) {
        const { source } = this.#state.getFile(pathToFileURL(path).toString())
        // A disabled import's stand-in gets esbuild's own loader for disabled modules: `empty` is the
        // one a CSS @import, `composes` or url() accepts, so one empty module serves JS and CSS importers.
        if (kind === 'empty') return { contents: source, loader: 'empty' }
        if (kind === 'resource') {
          // Plugin-provided contents with no `loader` default to `js` (esbuild applies the build's
          // per-extension loader only on its own load path), so replay the configured loader from
          // initialOptions.loader. No configured loader fails symmetrically with a capture build.
          const loader = initialOptions.loader?.[extname(path)]
          return loader ? { contents: source, loader } : { contents: source }
        }
        const loader = this.#loaderFor(path)
        // A transform that declines (undefined) serves the attested bytes unchanged.
        const transformed = await this.#transform?.(source, { path, loader })
        return transformed ?? { contents: source, loader }
      }

      const source = await realReadFile(path)

      if (kind === 'resource') {
        // Mark as a resource (State picks 'resource' vs 'resource:base64' from bytes). Return no
        // contents/loader: emission is esbuild's job via the build's own `loader` config.
        if (!this.#seen.has(path)) {
          this.#seen.add(path)
          this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, resource: true, reason: 'esbuild' })
        }
        return undefined
      }

      // Code-classified files must be UTF-8; refuse non-UTF-8 rather than silently encode as a resource.
      assert.ok(isUtf8(source), `StasisEsbuild: code-classified file has non-UTF-8 bytes: ${path}`)

      if (!this.#seen.has(path)) {
        this.#seen.add(path)
        this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, reason: 'esbuild' })
      }

      return { contents: source, loader: this.#loaderFor(path) }
    })
  }
}
