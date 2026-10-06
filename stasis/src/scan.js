import { dirname, extname, resolve as resolvePath, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import assert from 'node:assert/strict'
import { packageType } from '@exodus/stasis-core/bundle-util'
import { classifyExtension, classifyFormat, isTypeDeclaration, relativeEscapes } from '@exodus/stasis-core/util'
import { resolveTypescriptFallback, typescriptSiblings } from './resolve-typescript.js'
import { diskHost } from '@exodus/stasis-core/host'

// Static require/import graph walker: parses source, never loads or executes user code.
// Dynamic specifiers (`require(name)`, `import('./'+x)`) are recorded as unresolved.

// .jsx/.tsx need no flag: oxc parses them as JSX/TSX purely from the filename, so a reached one
// -- e.g. a package whose React Native entry is src/index.tsx -- is parsed and carried like any .ts.
const SCRIPT_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx'])
const RESOLVABLE_EXTS = new Set([...SCRIPT_EXTS, '.json'])
// The extensions whose name can't tell whether they hold JSX, parsed with JSX enabled only under
// `jsx` (React Native's JSX-in-.js convention). Excludes the .ts family: TypeScript's `<T>`
// generics collide with JSX, so tsc/oxc reserve JSX for .tsx — JSX-in-TS belongs in a .tsx file.
const JSX_EXTS = new Set(['.js', '.cjs', '.mjs'])

// Flow type syntax lives in the JS (non-TS) family; oxc parses TS natively, and running
// flow-remove-types over a .ts/.tsx file would corrupt TS-only constructs, so --flow only strips
// these. .jsx is included (it's JS + JSX, and can carry Flow types like .js); .tsx is not (it's
// TypeScript). flow-remove-types preserves JSX, so a stripped .jsx re-parses under lang:jsx.
const FLOW_EXTS = new Set(['.js', '.cjs', '.mjs', '.jsx'])
const TS_EXTS = new Set(['.ts', '.cts', '.mts', '.tsx'])

// Required lazily so non-JS bundlers don't load the native oxc parser.
let _parser
export function getParser() {
  _parser ??= createRequire(import.meta.url)('oxc-parser')
  return _parser
}

// flow-remove-types is an optional dependency, loaded lazily and only under --flow: it strips
// Flow type syntax down to plain JS before oxc (which parses JS/TS, not Flow) sees it. A missing
// dep is an env error, so surface it with an actionable install hint rather than a bare resolve throw.
let _flowRemoveTypes
function getFlowRemoveTypes() {
  if (_flowRemoveTypes) return _flowRemoveTypes
  try {
    _flowRemoveTypes = createRequire(import.meta.url)('flow-remove-types')
  } catch (cause) {
    throw new Error(
      "--flow needs the optional 'flow-remove-types' dependency; install it (e.g. `npm i flow-remove-types`)",
      { cause }
    )
  }
  return _flowRemoveTypes
}

// classifyFormat is the shared name->format authority (static and runtime bundles must agree); it
// returns null for the .js/.ts family whose module system comes from package.json `type` (null =
// detect from syntax, signaled up as null).
function formatForFile(file, host) {
  const format = classifyFormat(file)
  if (format != null) return format
  const type = packageType(file, host)
  if (type === null) return null
  return `${type}${extname(file) === '.ts' ? '-typescript' : ''}`
}

// The errors oxc reports for a parse, but its warnings and advice.
export const syntaxErrors = (parsed) => (parsed.errors ?? []).filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')

export function literalSpec(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked
  }
  return null
}

// Walks require()/import() calls only; ESM static imports/re-exports come from oxc module records.
function findCallSpecifiers(ast, push) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const c of node) visit(c)
      return
    }
    if (typeof node.type !== 'string') return

    if (node.type === 'CallExpression') {
      const { callee, arguments: args } = node
      if (callee.type === 'Identifier' && callee.name === 'require' && args.length >= 1) {
        const spec = literalSpec(args[0])
        if (spec != null) push({ kind: 'require', spec })
        else push({ kind: 'require', dynamic: true })
      }
    } else if (node.type === 'ImportExpression') {
      const spec = literalSpec(node.source)
      if (spec != null) push({ kind: 'dynamic-import', spec })
      else push({ kind: 'dynamic-import', dynamic: true })
    } else if (node.type === 'TSImportEqualsDeclaration') {
      // `import lib = require('./dep.cts')`: TS-only CJS import; record the real edge.
      // Qualified-name form (`import A = B.C`) carries no file edge.
      if (node.moduleReference?.type === 'TSExternalModuleReference') {
        const spec = literalSpec(node.moduleReference.expression)
        if (spec != null) push({ kind: 'require', spec })
        else push({ kind: 'require', dynamic: true })
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
      visit(node[key])
    }
  }
  visit(ast)
}

// The import specifiers `program` holds, as { kind, spec } ({ kind, dynamic: true } for a computed
// one). STATEMENT-level type-ness decides an edge, matching what survives type erasure at runtime
// (verbatimModuleSyntax / Node's own type stripping): an `import type` / `export type` statement is
// erased whole, so no edge; a statement that merely lists inline `type` specifiers
// (`import { type A }`, `export { type B } from`) -- or none at all (`import {}`, `export {} from`)
// -- still loads its module, so its edge is real. oxc's module records can't draw that line
// (`import type { A }` and `import { type A }` yield identical all-isType entries, and
// `export {} from` yields no entry at all), so the statements are read off the AST, where
// importKind/exportKind carry it.
function collectSpecifiers(program) {
  const specs = []
  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind !== 'type') specs.push({ kind: 'import', spec: node.source.value })
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.source != null && node.exportKind !== 'type') specs.push({ kind: 'export-from', spec: node.source.value })
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exportKind !== 'type') specs.push({ kind: 'export-from', spec: node.source.value })
    }
  }
  findCallSpecifiers(program, (s) => specs.push(s))
  return specs
}

// Whether `entries` (absolute paths) import TS sources by their OUTPUT names -- tsc's convention,
// which only --typescript resolves -- so the build can take --typescript as given: every entry is
// TypeScript, they hold at least one relative import naming a JS output (`./a.js`, or .jsx/.mjs/
// .cjs), and not one of those is on disk while the TS source it maps to is (`./a.ts`; see
// typescriptSiblings). Any part missing is no tell, and neither is an entry that doesn't parse (the
// scan reports it). Read off the entries alone, before the scan.
export function importsTypescriptByOutputName(entries, host = diskHost) {
  if (!entries.every((entry) => TS_EXTS.has(extname(entry)))) return false
  const parser = getParser()
  const targets = []
  for (const entry of entries) {
    let parsed
    try {
      parsed = parser.parseSync(entry, host.readFile(entry).toString('utf8'), { sourceType: 'unambiguous' })
    } catch {
      return false
    }
    if (syntaxErrors(parsed).length > 0) return false
    for (const { spec } of collectSpecifiers(parsed.program)) {
      if (spec?.startsWith('./') || spec?.startsWith('../')) {
        const target = resolvePath(dirname(entry), spec)
        if (typescriptSiblings(target).length > 0) targets.push(target)
      }
    }
  }
  const isSource = (file) => !isTypeDeclaration(file) && (host.stat(file)?.isFile() ?? false)
  return targets.length > 0 && targets.every((target) => host.stat(target) === null && typescriptSiblings(target).some(isSource))
}

function condKey(set) {
  return [...set].join(', ')
}

export class Scan {
  files = new Map()
  imports = new Map()
  unresolved = []
  parseErrors = []
  entries = new Set()

  // `conditions` is additive on top of the edge-context base set. `resolve` optionally
  // replaces Node's resolver (resolve-fields.js): returns `{ url } | { empty } | { builtin } | null`
  // (`empty` = a browser/react-native `false` redirect) and owns builtin handling when set.
  // `jsx` opts the .js/.cjs/.mjs family into JSX syntax (React Native's JSX-in-.js convention);
  // off by default because oxc, like tsc, only auto-enables JSX for .jsx/.tsx by extension.
  // `flow`: strip Flow type syntax from JS-family sources before parsing (see #scanFile).
  // `typescript`: retry a failed resolution with tsc's mapping (see #typescriptResolve), with
  // `typescriptPaths` (a loadTsconfigPaths matcher) adding tsconfig alias support; only consulted
  // on the built-in (Node) resolver -- a custom `resolve` owns its own TS handling. Without it, the
  // mapping only names the file a miss would resolve to under --typescript (see #typescriptCandidate).
  // `typescriptResolve`: the custom `resolve`'s --typescript twin (same shape), consulted only for
  // that hint; null when there is no custom resolver or `typescript` is on.
  // `resources` (a `parseResourcesOption` Set of extensions/filenames): reached files matching it
  // are carried as opaque resources (bytes only) rather than rejected as un-carryable -- for graphs
  // that aren't fully loadable in JS (e.g. Metro consuming .png/.svg assets).
  // `host`: the filesystem the walk reads and resolves through (@exodus/stasis-core/host).
  constructor({ conditions = [], resolve = null, jsx = false, flow = false, typescript = false, typescriptPaths = null, typescriptResolve = null, resources = new Set(), host = diskHost } = {}) {
    this.extraConditions = [...conditions]
    this.customResolve = resolve
    this.typescriptResolve = typescriptResolve
    this.jsx = jsx
    this.flow = flow
    this.typescript = typescript
    this.typescriptPaths = typescriptPaths
    this.resources = resources
    this.host = host
  }

  // A reached file whose extension/filename is in the --resources allowlist: carried as an opaque
  // resource (bytes only, no parse, no edges), not rejected as "a source bundle can't carry".
  // classifyExtension returns 'resource' only for non-code names in the allowlist, so this never
  // shadows a script/json extension (parseResourcesOption rejects code extensions).
  #isResource(file) {
    return this.resources.size > 0 && classifyExtension(file, this.resources) === 'resource'
  }

  walk(entries) {
    const queue = []
    for (const entry of entries) {
      const abs = resolvePath(entry)
      assert.ok(this.host.stat(abs) !== null, `entry not found: ${abs}`)
      const url = pathToFileURL(abs).toString()
      this.entries.add(url)
      queue.push(url)
    }
    while (queue.length > 0) {
      const url = queue.shift()
      if (this.files.has(url)) continue
      this.#scanFile(url, queue)
    }
    return this
  }

  // Must match the runtime resolver's condition set (omitting one resolves `exports`-gated
  // packages to a different file) AND its order: the recorded key must equal the runtime
  // hooks' string for exact lookups. Extras go where Node puts user conditions in each set.
  #conditionSet(context) {
    return context === 'import'
      ? new Set(['node', 'import', 'module-sync', 'node-addons', ...this.extraConditions])
      : new Set(['require', 'node', 'node-addons', ...this.extraConditions, 'module-sync'])
  }

  // `recovered`: false = parser crashed, nothing salvaged; true = oxc returned but we
  // discarded its partial module records (module-family only; see #scanFile).
  #recordParseError(url, format, message, recovered) {
    this.files.set(url, { format, edges: [], parseError: message })
    this.parseErrors.push({ url, format, message, recovered })
  }

  // --typescript: resolve `spec` the way tsc maps TS sources, invoked only AFTER Node's own
  // resolution missed -- so an on-disk `.js` (or any Node-resolvable target) always wins, and the
  // mapping only completes a failed resolution, never rewrites a successful one. The rules
  // (extension substitution, extensionless/index completion, manifest-target and tsconfig-paths
  // mapping) live in the shared dispatcher (resolve-typescript.js), so this resolver and the
  // legacy-field one cannot drift. The hit is realpathed to match req.resolve's canonical output
  // (every other recorded edge is a realpath).
  #typescriptResolve(parentFile, spec, conditions) {
    const hit = resolveTypescriptFallback(parentFile, spec, {
      conditions,
      paths: this.typescriptPaths,
      host: this.host,
    })
    if (hit == null) return null
    try {
      return this.host.realpath(hit)
    } catch {
      return null
    }
  }

  // The file: URL a miss would resolve to under --typescript, or null: a hint for the unresolved
  // report only, never an edge. A custom resolver asks its --typescript twin; the built-in one
  // tsc's mapping, as #typescriptResolve gives it under --typescript.
  #typescriptCandidate(parentFile, spec, conditions) {
    if (this.typescript) return null
    if (this.customResolve) return this.typescriptResolve?.(parentFile, spec, conditions)?.url ?? null
    const hit = this.#typescriptResolve(parentFile, spec, conditions)
    return hit == null ? null : pathToFileURL(hit).toString()
  }

  // Strip Flow type syntax to plain JS via the optional flow-remove-types dep (resolved lazily; a
  // missing dep is an env error and propagates). Only invoked as a parse fallback (see #scanFile),
  // so plain-JS files never reach it. Returns the rewritten source, or null when the transform
  // itself fails on this file -- the caller then keeps oxc's original parse error.
  #stripFlow(src, file) {
    const flowRemoveTypes = getFlowRemoveTypes()
    try {
      // `all: true` ignores the @flow/@noflow pragma (RN sources mix both); the transform blanks
      // types with whitespace, so byte offsets and every import specifier are preserved.
      return flowRemoveTypes(src, { all: true }).toString()
    } catch (cause) {
      console.warn(`[stasis] --flow: could not strip Flow types from ${file}; leaving it to oxc (${cause.message})`)
      return null
    }
  }

  #scanFile(url, queue) {
    const file = fileURLToPath(url)
    const ext = extname(file)
    if (ext === '.json') {
      this.files.set(url, { format: 'json', edges: [] })
      return
    }
    if (this.#isResource(file)) {
      // Allowlisted asset: carry it as a resource with no parse and no edges. `resource: true` is
      // the authoritative signal (both bundle builders key off it); the concrete format
      // (resource vs resource:base64) is byte-derived by the builder, so leave it unset here.
      this.files.set(url, { format: null, edges: [], resource: true })
      return
    }
    if (!SCRIPT_EXTS.has(ext)) {
      this.files.set(url, { format: null, edges: [] })
      return
    }

    // declared === null: typeless package; Node decides .js/.ts by syntax, resolved after parse.
    const declared = formatForFile(file, this.host)
    const src = this.host.readFile(file).toString('utf8')

    // Resolve the parser outside the try: a missing oxc-parser is an env error, not this
    // file's — it must not be swallowed into a silent zero-edge leaf.
    const parser = getParser()
    // oxc picks JS/TS + JSX from the filename; the .js family lands on plain JS (no JSX), so
    // force the JSX variant when opted in (`--jsx`) to parse React Native's JSX-in-.js source.
    const lang = this.jsx && JSX_EXTS.has(ext) ? 'jsx' : undefined
    const parseOptions = (sourceType) => (lang ? { sourceType, lang } : { sourceType })
    // `commonjs`, not `script`: Node runs CJS inside its module wrapper function, where a top-level
    // `return` or `new.target` is legal; oxc's `commonjs` accepts both and is otherwise `script`.
    const baseSourceType = declared === null ? 'unambiguous'
      : declared.startsWith('module') ? 'module' : 'commonjs'
    let parsed
    try {
      parsed = parser.parseSync(file, src, parseOptions(baseSourceType))
    } catch (cause) {
      this.#recordParseError(url, declared, cause.message, false)
      return
    }

    // Match Node's syntax detection for typeless packages: ESM syntax picks the module variant
    // (mislabeling as commonjs makes `--bundle=load` feed the wrong translator). Only .ts takes the
    // `-typescript` suffix; .jsx/.tsx deliberately land on plain module/commonjs (like a JSX-in-.js
    // file) — they're bundler-transformed, keyed by extension in `stasis build`, not Node-strippable,
    // so the "needs a JSX/TS transform" signal rides the .jsx/.tsx extension, not the format tag.
    const tsSuffix = ext === '.ts' ? '-typescript' : ''
    const detectedFormat = (p) => `${p.module.hasModuleSyntax ? 'module' : 'commonjs'}${tsSuffix}`
    let format = declared ?? detectedFormat(parsed)

    // oxc recovers from syntax errors (reports them in parsed.errors) rather than throwing;
    // Warning/Advice severities aren't real parse errors.
    let errors = syntaxErrors(parsed)

    // oxc's `unambiguous` mode counts top-level await as module syntax (since 0.109; before, a
    // TLA-only ESM file parsed here as a broken script). Keep mirroring Node for any script parse
    // that still fails: retry as module and prefer a clean module parse.
    if (errors.length > 0 && declared === null && !format.startsWith('module')) {
      try {
        const asModule = parser.parseSync(file, src, parseOptions('module'))
        if (syntaxErrors(asModule).length === 0) {
          parsed = asModule
          format = `module${tsSuffix}`
          errors = []
        }
      } catch { /* keep the script parse and its recorded errors */ }
    }

    // A typeless file Node detects as CJS runs inside the module wrapper too, but `unambiguous`
    // parses it as a plain script, so a top-level `return` still fails there: retry as `commonjs`
    // and prefer a clean parse (the detected commonjs format stands).
    if (errors.length > 0 && declared === null && !format.startsWith('module')) {
      try {
        const asCommonjs = parser.parseSync(file, src, parseOptions('commonjs'))
        if (syntaxErrors(asCommonjs).length === 0) {
          parsed = asCommonjs
          errors = []
        }
      } catch { /* keep the script parse and its recorded errors */ }
    }

    // --flow: oxc parses JS/TS but not Flow, so a Flow-typed .js/.cjs/.mjs file lands here with
    // parse errors. Only now -- after a raw oxc parse actually failed -- strip Flow types and
    // re-parse, so plain-JS files never pay the transform cost. Only the parse input is rewritten;
    // the bundle stores the pristine on-disk source (State/buildResolvedJsBundle re-read it), so
    // attestation still covers the real bytes. A clean re-parse replaces the errored one; otherwise
    // we keep the original result so a genuine (non-Flow) parse error still surfaces.
    if (errors.length > 0 && this.flow && FLOW_EXTS.has(ext)) {
      const flowSrc = this.#stripFlow(src, file)
      if (flowSrc !== null) {
        try {
          const asFlow = parser.parseSync(file, flowSrc, parseOptions(baseSourceType))
          if (syntaxErrors(asFlow).length === 0) {
            parsed = asFlow
            format = declared ?? detectedFormat(parsed)
            errors = []
          }
        } catch { /* keep the original parse + its errors */ }
      }
    }

    let parseError
    if (errors.length > 0) {
      parseError = errors.map((e) => e.message).join('; ')
      // A partially-parsed module file may be missing link-time edges we can't enumerate.
      if (format.startsWith('module')) {
        this.#recordParseError(url, format, parseError, true)
        return
      }
      // Script (CJS) files: oxc's recovered AST still yields the require()/import() edges — salvage them.
      this.parseErrors.push({ url, format, message: parseError, recovered: true })
    }

    const specs = collectSpecifiers(parsed.program)

    // The edge KIND picks the resolution context, not the parent's format: createRequire()d
    // require() inside ESM resolves under REQUIRE conditions, literal import() inside CJS under
    // IMPORT conditions -- the parent-format set baked the wrong `exports` branch into the bundle.
    // The custom (legacy-field) resolver keeps the format set: bundlers don't split per edge.
    const formatContext = ['module', 'module-typescript'].includes(format) ? 'import' : 'require'
    const edges = []
    const specMaps = new Map() // condition key -> specifier -> child URL
    const addChild = (s, key, childURL, childPath) => {
      edges.push({ ...s, child: childURL })
      if (!specMaps.has(key)) specMaps.set(key, new Map())
      specMaps.get(key).set(s.spec, childURL)
      if (RESOLVABLE_EXTS.has(extname(childPath)) || this.#isResource(childPath)) queue.push(childURL)
    }
    // Records the file --typescript would land the miss on too (typescriptURL), resolved as the miss was.
    const addUnresolved = (s, reason, conditions) => {
      edges.push({ ...s, error: reason })
      const typescriptURL = this.#typescriptCandidate(file, s.spec, conditions)
      this.unresolved.push({ parentURL: url, kind: s.kind, spec: s.spec, reason, ...(typescriptURL ? { typescriptURL } : {}) })
    }

    for (const s of specs) {
      if (s.dynamic) {
        edges.push(s)
        this.unresolved.push({ parentURL: url, kind: s.kind, reason: 'dynamic' })
        continue
      }
      const context = this.customResolve ? formatContext : (s.kind === 'require' ? 'require' : 'import')
      const conditions = this.#conditionSet(context)
      const key = condKey(conditions)
      // Custom (legacy-field) resolver owns builtin handling and the `empty` outcome (browser/RN
      // `false` redirect): an empty edge is recorded but neither queued nor counted as unresolved.
      if (this.customResolve) {
        const r = this.customResolve(file, s.spec, conditions)
        if (r?.builtin) {
          edges.push({ ...s, builtin: true })
        } else if (r?.empty) {
          edges.push({ ...s, empty: true })
        } else if (r?.url) {
          addChild(s, key, r.url, fileURLToPath(r.url))
        } else {
          addUnresolved(s, 'MODULE_NOT_FOUND', conditions)
        }
        continue
      }
      if (isBuiltin(s.spec)) {
        edges.push({ ...s, builtin: true })
        continue
      }
      let childPath
      try {
        childPath = this.host.resolve(file, s.spec, conditions)
      } catch (cause) {
        // --typescript: complete the miss with tsc's mapping (see #typescriptResolve); the edge
        // stays keyed by the ORIGINAL specifier -- only the target is the mapped file.
        if (this.typescript) childPath = this.#typescriptResolve(file, s.spec, conditions)
        if (childPath == null) {
          addUnresolved(s, cause.code ?? cause.message, conditions)
          continue
        }
      }
      addChild(s, key, pathToFileURL(childPath).toString(), childPath)
    }

    for (const [key, specMap] of specMaps) {
      if (!this.imports.has(key)) this.imports.set(key, new Map())
      this.imports.get(key).set(url, specMap)
    }
    this.files.set(url, parseError ? { format, edges, parseError } : { format, edges })
  }

  toRelative(root) {
    const rel = (url) => {
      const abs = fileURLToPath(url)
      const r = relative(root, abs)
      if (relativeEscapes(r)) throw new Error(`Path outside root: ${abs}`)
      return r
    }
    const relEdge = (e) => (e.child ? { ...e, child: rel(e.child) } : e)
    return {
      entries: new Set([...this.entries].map(rel)),
      files: new Map(
        [...this.files].map(([k, v]) => [rel(k), { ...v, edges: v.edges.map(relEdge) }])
      ),
      imports: new Map(
        [...this.imports].map(([cond, byParent]) => [
          cond,
          new Map(
            [...byParent].map(([p, specs]) => [
              rel(p),
              new Map([...specs].map(([spec, child]) => [spec, rel(child)])),
            ])
          ),
        ])
      ),
      unresolved: this.unresolved.map(({ parentURL, typescriptURL, ...rest }) => ({ parent: rel(parentURL), ...rest, ...(typescriptURL ? { typescript: rel(typescriptURL) } : {}) })),
      parseErrors: this.parseErrors.map(({ url, ...rest }) => ({ file: rel(url), ...rest })),
    }
  }
}

export function scan(entries, options = {}) {
  return new Scan(options).walk(entries)
}
