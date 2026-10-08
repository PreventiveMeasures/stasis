import { isUtf8 } from 'node:buffer'
import { isBuiltin } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

import { Bundle } from '@exodus/stasis-core/bundle'
import { PACKAGE_TYPED_EXTENSIONS, analyzeModule } from './esbuild-module-type.js'
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
  #served = new Map()  // path -> Promise<{ contents, loader }>: what esbuild parses for a served code file
  #facts = new Map()  // path -> Promise<analyzeModule facts | null>
  #typeScopes = new Map()  // dir -> Promise<'module' | 'commonjs' | null | undefined>: its nearest package.json `type`
  #build  // { resolve, initialOptions, esbuild } of the build being set up
  #lowersImport  // Promise<boolean>: whether the build turns `import()` into a require()

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

  // ---- package.json `type` checks ----
  // esbuild gives a .js/.jsx/.ts/.tsx file the module type of its nearest package.json only when its own
  // resolver resolved the file; a plugin's onResolve result can't carry one, so every file served here
  // parses as if its package had no `type`. Where that changes what the build does (Node's default-import
  // interop, whether a file is ESM or CommonJS, strict mode), refuse the build instead of diverging from a
  // plain esbuild build. Each check returns an error text, or null.

  // What esbuild parses for a code file this plugin serves, read once for onLoad and the checks: load
  // mode's attested bytes (through any transform), capture's disk bytes.
  #serve(path) {
    let served = this.#served.get(path)
    if (served === undefined) {
      const loader = this.#loaderFor(path)
      served = this.#state.config.loadBundle
        ? (async () => {
            const { source } = this.#state.getFile(pathToFileURL(path).toString())
            // A transform that declines (undefined) serves the attested bytes unchanged.
            return (await this.#transform?.(source, { path, loader })) ?? { contents: source, loader }
          })()
        : realReadFile(path).then((contents) => ({ contents, loader }))
      this.#served.set(path, served)
    }
    return served
  }

  // analyzeModule facts for a code file this plugin serves, else null.
  #factsOf(path) {
    let facts = this.#facts.get(path)
    if (facts === undefined) {
      let code
      if (this.#state.config.loadBundle) {
        // Attested non-resource bytes, whether or not a format is recorded (a plugin capture records none
        // for .jsx/.tsx); a JSON file or other non-JS loader analyzes to null.
        code = this.#state.sources.has(this.#state.relative(path).split(sep).join('/')) &&
          pathToFileURL(path).toString() !== pathToFileURL(resolvePath(this.#state.root, EMPTY_MODULE_PATH)).toString()
      } else {
        code = classifyExtension(path, this.#resources) === 'code'
      }
      facts = code ? this.#serve(path).then(({ contents, loader }) => analyzeModule(contents, { path, loader })) : Promise.resolve(null)
      this.#facts.set(path, facts)
    }
    return facts
  }

  // The `type` of the package.json nearest `dir` (esbuild's enclosing one): 'module', 'commonjs', null for
  // none, or undefined when no package.json is there at all.
  #typeScope(dir) {
    let scope = this.#typeScopes.get(dir)
    if (scope === undefined) {
      const parent = () => (dirname(dir) === dir ? undefined : this.#typeScope(dirname(dir)))
      scope = realReadFile(join(dir, 'package.json'), 'utf8').then((text) => {
        let pkg
        try {
          pkg = JSON.parse(text)
        } catch {
          return parent() // malformed: walked past, as esbuild does
        }
        return pkg?.type === 'module' || pkg?.type === 'commonjs' ? pkg.type : null
      }, parent)
      this.#typeScopes.set(dir, scope)
    }
    return scope
  }

  // Which package.json `type` a plain esbuild build could give this file: { module, commonjs, exact }.
  // Capture reads it off disk, as esbuild's resolver does. A bundle records only the file's Node format,
  // which a typeless package's file shares (Node then detects it from syntax): load reads the package.json
  // a plain build would here where the disk has one the format agrees with (it only decides whether to
  // refuse, never what is built), and otherwise takes both readings, so a `module` format counts as
  // "type": "module" and `commonjs` as "type": "commonjs".
  async #packageTypes(path) {
    if (!PACKAGE_TYPED_EXTENSIONS.has(extname(path))) return { module: false, commonjs: false, exact: true }
    const type = await this.#typeScope(dirname(path))
    if (!this.#state.config.loadBundle) return { module: type === 'module', commonjs: type === 'commonjs', exact: true }
    const format = this.#state.getFormat(pathToFileURL(path).toString())
    const module = format === 'module' || format === 'module-typescript'
    const commonjs = format === 'commonjs' || format === 'commonjs-typescript'
    if (type !== undefined && (type === null || (!module && !commonjs) || (type === 'module' ? module : commonjs))) {
      return { module: type === 'module', commonjs: type === 'commonjs', exact: true }
    }
    return { module: module || !commonjs, commonjs: commonjs || !module, exact: false, format }
  }

  // Where `require(specifier)` in `fromPath` leads, as this build resolves it: { path } for a file this
  // plugin serves, { opaque: true } for exports it can't read (a non-builtin external, one esbuild can't
  // resolve and leaves for runtime -- a require in a try/catch -- or another plugin's namespace), or null for
  // nothing to follow (a builtin, a disabled import).
  async #resolveRequire(fromPath, specifier) {
    if (this.#state.config.loadBundle) {
      try {
        return { path: fileURLToPath(this.#state.getImport(pathToFileURL(fromPath).toString(), specifier).url) }
      } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
        return isBuiltin(specifier) ? null : { opaque: true }
      }
    }
    const res = await this.#build.resolve(specifier, { kind: 'require-call', resolveDir: dirname(fromPath), importer: fromPath, namespace: 'stasis' })
    if (res.errors.length > 0) return isBuiltin(specifier) ? null : { opaque: true }
    // An external resolves to no namespace too, so ask before taking that as a disabled import -- which the
    // build replaces with an empty module, a disabled file included (a `browser` map's `"./x.js": false`).
    if (res.external) return isBuiltin(specifier) ? null : { opaque: true }
    if (await this.#isDisabled(res, specifier, { kind: 'require-call', resolveDir: dirname(fromPath) }, this.#build)) return null
    return res.namespace === 'file' ? { path: res.path } : { opaque: true }
  }

  // Whether a module this build bundles may have an `__esModule` mark on its module.exports. For the
  // module an ESM file imports (depth 0), an ES module never is: esbuild only wraps CommonJS in __toESM.
  // Past a `module.exports = require(...)`-style re-export it is: a required ES module gets esbuild's
  // __toCommonJS mark. A file that doesn't parse might, as might exports this plugin can't read. Of the
  // rest, only re-exported JSON can carry one (`{ "__esModule": true }`): esbuild imports JSON as a whole.
  async #mayCarryEsModule(path, depth, seen) {
    const facts = await this.#factsOf(path)
    if (facts === null) {
      if (depth === 0 || this.#loaderFor(path) !== 'json') return false
      const { contents } = await this.#serve(path)
      try {
        return Boolean(JSON.parse(contents)?.__esModule)
      } catch {
        return true
      }
    }
    if (facts.esmExports || (facts.esmImports && facts.cjsUsage === 'no')) return depth > 0
    if (facts.setsEsModule || facts.parseError) return true
    const targets = await Promise.all([...facts.reexports].map((specifier) => this.#resolveRequire(path, specifier)))
    if (targets.some((target) => target?.opaque)) return true
    const next = [...new Set(targets.map((target) => target?.path).filter((target) => target !== undefined && !seen.has(target)))]
    for (const target of next) seen.add(target)
    return (await Promise.all(next.map((target) => this.#mayCarryEsModule(target, depth + 1, seen)))).some(Boolean)
  }

  #refuse(path, types, why, fix) {
    const file = relative(this.#state.root, path).split(sep).join('/')
    const assumed = types.exact ? '' : ` (the bundle records its Node format, '${types.format}', but not its package.json "type", and no package.json ` +
      'on disk agrees with that format, so the "type" the format implies is assumed)'
    return `StasisEsbuild: refusing to build '${file}'${assumed}: ${why}. esbuild applies a package.json "type" only to files its own resolver ` +
      `loads, not to ones a plugin serves, so this build would not match a plain esbuild build.${fix ? ` ${fix}.` : ''}`
  }

  // A file whose own parse depends on its package type.
  async #checkFile(path) {
    const types = await this.#packageTypes(path)
    if (!types.module && !types.commonjs) return null
    const facts = await this.#factsOf(path)
    if (facts === null || facts.esmExports) return null
    // Top-level `arguments` is the wrapper's where a build wraps the file, and the builds wrap differently: a plain
    // one by the package type (a "type": "module" file as ESM, a "type": "commonjs" one as CommonJS), this
    // plugin's by syntax, as CommonJS where it sees CommonJS use and no import.
    const pluginCjs = facts.cjsUsage === 'yes' && !facts.esmImports
    if (facts.topArguments && ((types.module && !facts.esmImports && !pluginCjs) || (types.commonjs && !pluginCjs))) {
      return this.#refuse(path, types, 'it reads `arguments` outside any function, where a plain esbuild build and this plugin\'s ' +
        `build give it different module wrappers (a plain build treats the file as ${types.module ? 'ESM' : 'CommonJS'} by its ` +
        `package.json "type", this plugin's build as ${pluginCjs ? 'CommonJS' : 'ESM'} by its syntax)`, 'Read `arguments` only inside a function')
    }
    if (!types.module) return null
    if (facts.cjsUsage !== 'no') {
      return this.#refuse(path, types, `it has no \`export\`, \`import.meta\` or top-level \`await\` but uses ${facts.cjsDetail}, ` +
        'which a plain esbuild build treats as ESM in a "type": "module" package (no CommonJS `module`/`exports`, `this` undefined) ' +
        'and this plugin\'s build as CommonJS')
    }
    if (!facts.esmImports && (facts.strictOnly || facts.blockFunction)) {
      return this.#refuse(path, types, 'it has no `import` or `export`, so a plain esbuild build parses it as a strict-mode ES module ' +
        `in a "type": "module" package and this plugin's build as a sloppy-mode script (${facts.strictOnly ?? 'a block-level function declaration'})`)
    }
    return null
  }

  // An import from `importer` of `target`, which this plugin serves as code.
  async #checkEdge(importer, specifier, kind, target) {
    if (kind !== 'import-statement' && kind !== 'dynamic-import' && kind !== 'require-call') return null
    const [importerTypes, targetTypes] = await Promise.all([this.#packageTypes(importer), this.#packageTypes(target)])
    const targetTyped = targetTypes.module || targetTypes.commonjs
    // What the import sees of the target: its exports at all, or its default/namespace (the interop's say).
    let usage = { bindings: kind === 'dynamic-import', interop: kind === 'dynamic-import' }
    if (kind !== 'require-call' && (importerTypes.module || targetTyped)) {
      const facts = await this.#factsOf(importer)
      // An importer the check couldn't read sees everything, as far as it can tell; an `import()` whose result is
      // discarded sees nothing.
      const readable = facts && !facts.parseError
      if (kind === 'import-statement') usage = (readable && facts.imports.get(specifier)) || { bindings: true, interop: true }
      else if (readable && facts.dynamicImports.get(specifier)?.consumed === false) usage = { bindings: false, interop: false }
    }
    // A require whose result is discarded (`require('./side.js')` as a statement) sees nothing of the target.
    let required = kind === 'require-call'
    if (required && targetTyped) {
      const facts = await this.#factsOf(importer)
      required = !facts || Boolean(facts.parseError) || (facts.requires.get(specifier)?.consumed ?? true)
    }

    if (usage.interop && importerTypes.module && await this.#mayCarryEsModule(target, 0, new Set([target]))) {
      return this.#refuse(importer, importerTypes, `it ${kind === 'dynamic-import' ? 'dynamically imports' : 'imports the default export or namespace of'} ` +
        `'${specifier}', a CommonJS module whose exports may carry \`__esModule\`: a plain esbuild build gives a "type": "module" ` +
        'file Node\'s interop (the default export is the whole module.exports), this plugin\'s build the bundler one (module.exports.default)',
        'Import its named exports instead, or rename the importer to .mjs, which esbuild types by extension')
    }

    if (!targetTyped) return null
    const facts = await this.#factsOf(target)
    if (facts === null || facts.esmExports) return null
    const how = kind === 'require-call' ? 'requires' : 'imports'
    if (targetTypes.module && !facts.esmImports && facts.cjsUsage === 'no' && (usage.bindings || required)) {
      return this.#refuse(target, targetTypes, `'${relative(this.#state.root, importer).split(sep).join('/')}' ${how} it, and it has no \`import\` or \`export\`: ` +
        'a plain esbuild build makes it an ES module without exports in a "type": "module" package, this plugin\'s build CommonJS, ' +
        `so what the ${kind === 'require-call' ? 'require' : 'import'} yields differs`)
    }
    // Without an import statement either, esbuild makes an imported file CommonJS anyway.
    if (targetTypes.commonjs && facts.esmImports && facts.cjsUsage !== 'yes' && (usage.bindings || required)) {
      return this.#refuse(target, targetTypes, `'${relative(this.#state.root, importer).split(sep).join('/')}' ${how} it, and it has \`import\`s but no ` +
        '`export` and no CommonJS `module`/`exports` use: a plain esbuild build wraps it as CommonJS in a "type": "commonjs" package, ' +
        `this plugin's build makes it an ES module, so what the ${kind === 'require-call' ? 'require' : 'import'} yields differs`)
    }
    return null
  }

  // The build's output format, defaulted as esbuild does for a bundle.
  #outputFormat() {
    const { format, platform } = this.#build.initialOptions
    return format ?? (platform === 'neutral' ? 'esm' : platform === 'node' ? 'cjs' : 'iife')
  }

  // An import from `importer` of a non-builtin external. esbuild keeps it for runtime: as an import where the
  // output is ESM, as a require() where it's CommonJS or an IIFE (and wherever it lowers `import()`), and that
  // require gets the importer's interop -- on exports only the runtime knows, so this build can't tell whether
  // they carry `__esModule`.
  async #checkExternal(importer, specifier, kind) {
    if (isBuiltin(specifier)) return null
    const turnsIntoRequire = kind === 'import-statement' ? this.#outputFormat() !== 'esm'
      : kind === 'dynamic-import' && await this.#lowersDynamicImport()
    if (!turnsIntoRequire) return null
    const types = await this.#packageTypes(importer)
    if (!types.module) return null
    const facts = await this.#factsOf(importer)
    if (facts && !facts.parseError) {
      if (kind === 'import-statement' ? !facts.imports.get(specifier)?.interop : facts.dynamicImports.get(specifier)?.consumed === false) return null
    }
    return this.#refuse(importer, types, `it ${kind === 'dynamic-import' ? 'dynamically imports' : 'imports the default export or namespace of'} ` +
      `'${specifier}', an external this build turns into a require() whose exports only the runtime knows: a plain esbuild build ` +
      'gives a "type": "module" file Node\'s interop (the default export is the whole module.exports), this plugin\'s build the bundler ' +
      'one (module.exports.default where the exports carry `__esModule`)',
      kind === 'dynamic-import' ? 'Rename the importer to .mjs, which esbuild types by extension, or build for a target with dynamic import'
        : "Import its named exports instead, rename the importer to .mjs, which esbuild types by extension, or build with format 'esm'")
  }

  // Whether this build lowers `import()` to a require() (a target without dynamic import), asked of esbuild itself.
  #lowersDynamicImport() {
    const { target, supported, platform } = this.#build.initialOptions
    this.#lowersImport ??= this.#build.esbuild.transform("import('x')", { format: this.#outputFormat(), target, supported, platform })
      .then(({ code }) => /\brequire\(/.test(code))
    return this.#lowersImport
  }

  // An entry point: built as ESM, a "type": "commonjs" entry gains a default export only in a plain build.
  async #checkEntry(path) {
    if (this.#outputFormat() !== 'esm') return null
    const types = await this.#packageTypes(path)
    if (!types.commonjs) return null
    const facts = await this.#factsOf(path)
    if (facts === null || facts.esmExports || facts.cjsUsage === 'yes') return null
    return this.#refuse(path, types, 'it is an entry point with no `export` and no CommonJS `module`/`exports` use, built as ESM: a plain esbuild build ' +
      'wraps it as CommonJS in a "type": "commonjs" package and exports its module.exports as the output\'s default export, this plugin\'s ' +
      'build exports nothing', "Build it with format 'cjs' or 'iife'")
  }

  setup = ({ onResolve, onLoad, onStart, onEnd, resolve, initialOptions, esbuild }) => {
    if (!this.#state) return  // noop plugin
    this.#build = { resolve, initialOptions, esbuild }
    this.#lowersImport = undefined

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
    onResolve({ filter: /$/ }, async ({ path: specifier, importer, kind: resolveKind, with: attrs }) => {
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
      const path = fileURLToPath(url)
      if (kind === 'code') {
        const error = isEntry ? await this.#checkEntry(path) : await this.#checkEdge(importer, specifier, resolveKind, path)
        if (error) return { errors: [{ text: error }] }
      }
      return { path, namespace: 'file', pluginData: { isEntry, kind } }
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
      if (kind === 'code') {
        const error = isEntry ? await this.#checkEntry(res.path) : await this.#checkEdge(args.importer, specifier, args.kind, res.path)
        if (error) return { errors: [{ text: error }] }
      } else if (res.external && !isEntry) {
        const error = await this.#checkExternal(args.importer, specifier, args.kind)
        if (error) return { errors: [{ text: error }] }
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
        if (kind === 'code') {
          const served = await this.#serve(path)
          const error = await this.#checkFile(path)
          return error ? { errors: [{ text: error }] } : served
        }
        const { source } = this.#state.getFile(pathToFileURL(path).toString())
        // A disabled import's stand-in gets esbuild's own loader for disabled modules: `empty` is the
        // one a CSS @import, `composes` or url() accepts, so one empty module serves JS and CSS importers.
        if (kind === 'empty') return { contents: source, loader: 'empty' }
        // A resource. Plugin-provided contents with no `loader` default to `js` (esbuild applies the build's
        // per-extension loader only on its own load path), so replay the configured loader from
        // initialOptions.loader. No configured loader fails symmetrically with a capture build.
        const loader = initialOptions.loader?.[extname(path)]
        return loader ? { contents: source, loader } : { contents: source }
      }

      if (kind === 'resource') {
        const source = await realReadFile(path)
        // Mark as a resource (State picks 'resource' vs 'resource:base64' from bytes). Return no
        // contents/loader: emission is esbuild's job via the build's own `loader` config.
        if (!this.#seen.has(path)) {
          this.#seen.add(path)
          this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, resource: true, reason: 'esbuild' })
        }
        return undefined
      }

      const { contents: source, loader } = await this.#serve(path)
      // Code-classified files must be UTF-8; refuse non-UTF-8 rather than silently encode as a resource.
      assert.ok(isUtf8(source), `StasisEsbuild: code-classified file has non-UTF-8 bytes: ${path}`)

      if (!this.#seen.has(path)) {
        this.#seen.add(path)
        this.#state.addFile(pathToFileURL(path).toString(), { source, isEntry: pluginData?.isEntry, reason: 'esbuild' })
      }

      const error = await this.#checkFile(path)
      return error ? { errors: [{ text: error }] } : { contents: source, loader }
    })
  }
}
