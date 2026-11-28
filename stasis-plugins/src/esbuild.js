import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { Bundle } from '@exodus/stasis-core/bundle'
import { PluginState, assertCodeUtf8, assertPersistableAttributes, fileURL, ownOrResolvedState, unsupportedExtension } from './plugins.js'
// Pre-patch snapshot, not `import { readFile }`: under --fs=async that builtin is patched, and
// this plugin loads after, so a direct import would route esbuild's reads through the capture hook.
import { realReadFile } from '@exodus/stasis-core/state-util'
import { EMPTY_MODULE_PATH, classifyExtension, isPlainObject, memoized } from '@exodus/stasis-core/util'

// The build options esbuild's resolver reads, replayed into the disabled-import probe.
const RESOLVE_OPTIONS = ['absWorkingDir', 'alias', 'conditions', 'external', 'mainFields', 'nodePaths',
  'packages', 'platform', 'preserveSymlinks', 'resolveExtensions', 'tsconfig', 'tsconfigRaw']

// A stylesheet's imports, whose URL's query and fragment (`./icons.svg#check`) esbuild keeps as the result's suffix.
const CSS_RESOLVE_KINDS = new Set(['import-rule', 'composes-from', 'url-token'])
const urlSuffix = (specifier) => {
  const at = specifier.search(/[?#]/u)
  return at === -1 ? '' : specifier.slice(at)
}

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
  const stem = (part) => part.replace(/\..*$/su, '')
  while (parts.length > 1 && stem(parts.at(-1)) === 'index') parts.pop()
  if (parts.length > 0) parts[parts.length - 1] = stem(parts.at(-1))
  return parts.join('/')
}

// The loose keys a directory's package.json `browser` map sends to `false` (esbuild's "disabled").
async function browserFalseKeys(dir) {
  const browser = await realReadFile(join(dir, 'package.json'), 'utf8')
    .then((text) => JSON.parse(text)?.browser)
    .catch(() => undefined)
  if (!isPlainObject(browser)) return new Set()
  return new Set(Object.keys(browser).filter((key) => browser[key] === false).map(looseBrowserKey))
}

export class StasisEsbuild {
  name = 'stasis'
  #stasis
  #loaders
  #transform
  #resource
  #platform
  #emptyModule // URL of the empty module disabled imports point at, once capture recorded it

  // Only for load mode: `loaders` per-extension overrides (RN's '.js' -> 'jsx'), `transform(source, { path, loader })`
  // a code rewrite (`stasis build --platform=hermes`), `resource(source, { path })` a module for a resource no loader
  // names (`stasis build --metro`'s asset module), `platform` the one a --metro per-platform edge resolves for.
  constructor(options = {}, { loaders, transform, resource, platform } = {}) {
    this.#stasis = new PluginState('StasisEsbuild', 'esbuild', ownOrResolvedState('StasisEsbuild', options))
    this.#loaders = loaders ?? new Map()
    this.#transform = transform
    this.#resource = resource
    this.#platform = platform
  }

  // A configured override, else from the extension (.cjs/.mjs/.cts/.mts drop their module letter, .css keeps it).
  #loaderFor(path) {
    const ext = extname(path)
    return this.#loaders.get(ext) ?? ext.slice(1).replace(/^[cm](?=[jt]s$)/u, '')
  }

  // dir -> Promise<[{ dir, keys }]>: every directory from `dir` up whose `browser` map disables something, nearest
  // first. A superset, as esbuild consults only the nearest map.
  #browserFalseScopes = memoized((dir) => {
    const parent = dirname(dir)
    return Promise.all([browserFalseKeys(dir), parent === dir ? [] : this.#browserFalseScopes(parent)])
      .then(([keys, above]) => (keys.size > 0 ? [{ dir, keys }, ...above] : above))
  })

  // Whether some `browser` map `false` entry could match this resolution: the resolved path (and, for a relative
  // specifier, the path it names) under each map's dir, or a bare specifier as is or as './<importer dir>/<specifier>'
  // (a Browserify quirk esbuild keeps).
  async #mayBeDisabled(path, specifier, resolveDir) {
    const isPackagePath = !isAbsolute(specifier) && !/^\.\.?(?:\/|$)/u.test(specifier)
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
  #probeDisabled = memoized(({ specifier, kind, resolveDir, build: { esbuild, initialOptions } }) => {
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
  }, ({ specifier, kind, resolveDir }) => JSON.stringify([kind, resolveDir, specifier]))

  // A `browser` field `false` makes esbuild resolve an import to an empty "disabled" module, but its resolve API
  // drops that flag: a bare name comes back namespace-less, a file as its plain path, which a probe confirms where a
  // `false` entry could match.
  async #isDisabled(res, specifier, { kind, resolveDir }, build) {
    if (res.external) return false
    if (res.namespace === '') return true
    if (res.namespace !== 'file' || (build.initialOptions.platform ?? 'browser') !== 'browser') return false
    if (!(await this.#mayBeDisabled(res.path, specifier, resolveDir))) return false
    // A sibling plugin may have resolved the import to something else entirely.
    return (await this.#probeDisabled({ specifier, kind, resolveDir, build })) === res.path
  }

  setup = ({ onResolve, onLoad, onStart, onEnd, resolve, initialOptions, esbuild }) => {
    const stasis = this.#stasis
    const { state } = stasis
    if (!state) return
    const { loadBundle } = state.config
    const emptyModuleURL = fileURL(resolvePath(state.root, EMPTY_MODULE_PATH))

    // Rebuilds re-fire onStart against the same registrations.
    if (!loadBundle) {
      onStart(() => {
        const text = stasis.startBuild()
        return text && { errors: [{ text }] }
      })
    }

    // A failed build mustn't overwrite the user's good file.
    if (stasis.ownsWrite) {
      onEnd((result) => {
        if (result.errors.length === 0) state.write()
      })
    }

    // Load mode resolves through the bundle's import map: the file may not be on disk. namespace 'file' with the
    // original path (esbuild doesn't stat a plugin's) keeps the output (banners, asset names, maps) a capture's.
    if (loadBundle) {
      onResolve({ filter: /$/ }, ({ path: specifier, importer, kind: resolveKind, with: attrs }) => {
        const isEntry = resolveKind === 'entry-point'
        let url
        if (isEntry) {
          // Anchored to cwd, as the run loader does, so the file needn't be on disk.
          url = specifier.startsWith('file:') ? specifier : fileURL(resolvePath(process.cwd(), specifier))
          if (state.config.full) state.assertEntry(url)
        } else {
          // Looked up even for a built-in's name: a browser build records `fs` where a `browser` field disables it or
          // a package by that name serves it. KNOWN GAP: a Node-loader-captured bundle keys an attributed edge under
          // specific conditions, which this `*` lookup won't match.
          url = stasis.attestedImport(importer, specifier, { importAttributes: attrs, platform: this.#platform })?.url
          if (url === undefined) return undefined
        }
        const format = state.getFormat(url)
        const kind = url === emptyModuleURL ? 'empty' : Bundle.isResourceFormat(format) ? 'resource' : 'code'
        // A stylesheet URL's query and fragment, which the emitted URL carries, as esbuild's own resolution keeps them.
        const suffix = CSS_RESOLVE_KINDS.has(resolveKind) ? urlSuffix(specifier) : ''
        return { path: fileURLToPath(url), namespace: 'file', ...(suffix && { suffix }), pluginData: { isEntry, kind } }
      })
    }

    onResolve({ filter: /$/, namespace: 'file' }, async ({ path: specifier, with: attrs, ...args }) => {
      const isEntry = !args.importer
      // A synthetic namespace runs esbuild's own resolver without re-entering this hook.
      const res = await resolve(specifier, { ...args, with: attrs, namespace: 'stasis' })
      // A miss is esbuild's to report, or tolerate (a require() in a try/catch): decline, recording no edge.
      if (res.errors.length > 0) return undefined
      // Declined, esbuild re-resolves a disabled import into its own empty module, the attested one bundle=load serves.
      if (!isEntry && await this.#isDisabled(res, specifier, args, { esbuild, initialOptions })) {
        if (!loadBundle) {
          this.#emptyModule ??= state.addEmptyModule({ reason: 'esbuild' })
          state.addImport(fileURL(args.importer), specifier, this.#emptyModule, { importAttributes: attrs })
        }
        return undefined
      }
      // But a stylesheet URL's own query and fragment, esbuild's suffix of it, which load mode reads off the specifier.
      assert.ok(res.suffix === '' || (CSS_RESOLVE_KINDS.has(args.kind) && res.suffix === urlSuffix(specifier)),
        `StasisEsbuild: a sibling plugin set res.suffix='${res.suffix}' on '${specifier}', which stasis can't persist`)

      let kind = 'skip'
      if (res.namespace === 'file' && !res.external) {
        kind = classifyExtension(res.path, state.config.resources)
        if (kind === 'unknown') return { errors: [{ text: unsupportedExtension('StasisEsbuild', `'${res.path}'`) }] }
        // Resources too: load mode resolves every specifier through this map, so one with no edge would fall through
        // to esbuild's disk resolver, unattested.
        if (!isEntry) stasis.addImport(args.importer, specifier, res.path, attrs)
      }
      return { ...res, pluginData: { ...res.pluginData, isEntry, kind } }
    })

    onLoad({ filter: /$/, namespace: 'file' }, async ({ path, pluginData, with: attrs }) => {
      const kind = pluginData?.kind ?? 'skip'
      if (kind === 'skip') return undefined
      assertPersistableAttributes(attrs)

      // getFile verifies the hash and throws on a file the bundle doesn't carry: no disk fallback.
      if (loadBundle) {
        const { source } = state.getFile(fileURL(path))
        // esbuild's own loader for disabled modules, which a CSS @import, `composes` or url() accepts too.
        if (kind === 'empty') return { contents: source, loader: 'empty' }
        if (kind === 'resource') {
          const override = this.#loaders.get(extname(path))
          if (override) return { contents: source, loader: override }
          // Else the build's own loader for it, so a resource none loads fails as at capture, not parsed as js.
          return (await this.#resource?.(source, { path })) || { contents: source, loader: 'default' }
        }
        const loader = this.#loaderFor(path)
        return (await this.#transform?.(source, { path, loader })) ?? { contents: source, loader }
      }

      const source = await realReadFile(path)
      // A file loads once per set of import attributes: each read is checked, the first recorded.
      if (stasis.claim(path)) stasis.addFile(path, source, kind, pluginData.isEntry)
      else if (kind === 'code') assertCodeUtf8('StasisEsbuild', path, source)
      // A resource is emitted by esbuild, through the build's own `loader` config.
      return kind === 'resource' ? undefined : { contents: source, loader: this.#loaderFor(path) }
    })
  }
}
