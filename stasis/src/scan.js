import { dirname, extname, resolve as resolvePath, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import assert from 'node:assert/strict'
import { packageType } from '@exodus/stasis-core/bundle-util'
import { classifyExtension, classifyFormat, isTypeDeclaration, nestedMap, relativeEscapes } from '@exodus/stasis-core/util'
import { inNodeModules, resolveTypescriptFallback, typescriptSiblings } from './resolve-typescript.js'
import { branchFolder, parseDefine } from './define.js'
import { diskHost } from '@exodus/stasis-core/host'
import { untouchedMemo } from './vfs-bundle/lazy.js'

// Static require/import graph walker: parses source, never loads or executes user code.
// Dynamic specifiers (`require(name)`, `import('./'+x)`) are recorded as unresolved. With
// `define`, a branch the defined values keep from running is not walked (see define.js).

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

// Required lazily so non-JS bundlers don't load the native oxc parser. Its parseSync hands each AST
// over by raw transfer where the platform takes it (oxc's rawTransferSupported), read from the
// parser's own buffer, rather than as JSON, which takes longer to parse than the source did.
let _parser
export function getParser() {
  if (_parser === undefined) {
    const oxc = createRequire(import.meta.url)('oxc-parser')
    _parser = oxc.rawTransferSupported() ? { ...oxc, parseSync: (file, source, options) => oxc.parseSync(file, source, { experimentalRawTransfer: true, ...options }) } : oxc
  }
  return _parser
}

// flow-remove-types is stasis's own dependency, resolved from stasis itself (never from the project
// being bundled) and loaded lazily, only under --flow: it strips Flow type syntax down to plain JS
// before oxc (which parses JS/TS, not Flow) sees it.
let _flowRemoveTypes
function getFlowRemoveTypes() {
  _flowRemoveTypes ??= createRequire(import.meta.url)('flow-remove-types')
  return _flowRemoveTypes
}

// classifyFormat is the shared name->format authority (static and runtime bundles must agree); it
// returns null for the .js/.ts family whose module system comes from package.json `type` (null =
// detect from syntax, signaled up as null).
function formatForFile(file, host, kept) {
  const format = classifyFormat(file)
  if (format != null) return format
  const type = packageType(file, host, kept)
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
// `fold` (define.js's branchFolder, or null) names the children of a branch whose test folds: the
// side that can't run is never walked.
function findCallSpecifiers(ast, push, fold = null) {
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const c of node) visit(c)
      return
    }
    if (typeof node.type !== 'string') return
    const live = fold?.(node)
    if (live !== undefined) {
      for (const c of live) visit(c)
      return
    }

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
// importKind/exportKind carry it. `defines` (parseDefine's) leave out the calls in branches they
// keep from running; static import statements are never in one. `typesOnly(node)`, where given,
// leaves out a statement it holds lists types alone (see listsTypesOnly).
function collectSpecifiers(program, defines = new Map(), typesOnly = () => false) {
  const specs = []
  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind !== 'type' && !typesOnly(node)) specs.push({ kind: 'import', spec: node.source.value })
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.source != null && node.exportKind !== 'type' && !typesOnly(node)) specs.push({ kind: 'export-from', spec: node.source.value })
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exportKind !== 'type') specs.push({ kind: 'export-from', spec: node.source.value })
    }
  }
  findCallSpecifiers(program, (s) => specs.push(s), branchFolder(defines, program))
  return specs
}

// Whether `entries` (absolute paths) import TS sources by their OUTPUT names -- tsc's convention,
// which only --typescript resolves -- so the build can take --typescript as given: every entry is
// TypeScript, they hold at least one relative import naming a JS output (`./a.js`, or .jsx/.mjs/
// .cjs), and not one of those is on disk while the TS source it maps to is (`./a.ts`; see
// typescriptSiblings), outside node_modules as the resolver requires. Any part missing is no tell, and neither is an entry that doesn't parse as
// the scan parses it (Scan#parseFile; the scan reports it), nor one in node_modules, where
// --typescript maps nothing. Read off the entries alone, before the scan.
export function importsTypescriptByOutputName(entries, host = diskHost) {
  if (!entries.every((entry) => TS_EXTS.has(extname(entry)) && !inNodeModules(entry, host))) return false
  // Outside the try, as in the scan: a missing oxc-parser is an env error, not an entry's.
  getParser()
  const scanner = new Scan({ host })
  const targets = []
  for (const entry of entries) {
    let result
    try {
      result = scanner.parseFile(entry)
    } catch {
      return false // unreadable: the scan reports it
    }
    if (result.crash !== undefined || result.errors.length > 0) return false
    for (const { spec } of collectSpecifiers(result.parsed.program)) {
      if (spec?.startsWith('./') || spec?.startsWith('../')) {
        const target = resolvePath(dirname(entry), spec)
        if (typescriptSiblings(target).length > 0) targets.push(target)
      }
    }
  }
  // tsc's pick, the first TS source on disk, as the resolver maps it: none where it lies in node_modules.
  const isSource = (file) => !isTypeDeclaration(file) && (host.stat(file)?.isFile() ?? false)
  const mapsTo = (target) => {
    const pick = typescriptSiblings(target).find(isSource)
    return pick !== undefined && !inNodeModules(pick, host)
  }
  return targets.length > 0 && targets.every((target) => host.stat(target) === null && mapsTo(target))
}

const TYPE_KINDS = new Set(['type', 'typeof'])

// Whether the import or re-export statement `node` lists specifiers, every one an inline type
// (`import { type A, typeof B } from`, `export { type C } from`), which Babel's Flow and TypeScript
// transforms erase whole, as Metro builds (Node keeps one, as `import {} from`). A file --flow
// stripped has lost them, blanked to whitespace in place in its `strippedSource`, so there the
// statement lists types alone where it reads otherwise in its `source` (a comment in it stays);
// a statement written with none (`import {} from`) lists no types. The Metro plugin's transformer
// draws the same line (typesOnly).
function listsTypesOnly(node, { source, strippedSource }) {
  const specifiers = node.specifiers ?? []
  if (specifiers.length > 0) return specifiers.every((specifier) => TYPE_KINDS.has(specifier.importKind ?? specifier.exportKind))
  return strippedSource !== null && source.slice(node.start, node.end) !== strippedSource.slice(node.start, node.end)
}

function condKey(set) {
  return [...set].join(', ')
}

// How many files the scans parsed, and with a `memo` (#scanKept) resolved again from a parse kept,
// and took as kept, all told: what a build is reported by (EXODUS_STASIS_DEBUG).
export const scanCounts = { parsed: 0, resolved: 0, replayed: 0 }

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
  // `typescriptPaths` (a tsconfig paths matcher; see resolveTypescriptFallback) adding tsconfig alias support; only consulted
  // on the built-in (Node) resolver -- a custom `resolve` owns its own TS handling. Without it, the
  // mapping only names the file a miss would resolve to under --typescript (see #typescriptCandidate).
  // `typescriptResolve`: the custom `resolve`'s --typescript twin (same shape), consulted only for
  // that hint; null when there is no custom resolver or `typescript` is on.
  // `resources` (a `parseResourcesOption` Set of extensions/filenames): reached files matching it
  // are carried as opaque resources (bytes only) rather than rejected as un-carryable -- for graphs
  // that aren't fully loadable in JS (e.g. Metro consuming .png/.svg assets).
  // `host`: the filesystem the walk reads and resolves through (@exodus/stasis-core/host).
  // `define` (each global name -> its value, see define.js): a require()/import() in a branch they
  // keep from running (`if (__DEV__)` under `{ __DEV__: false }`) is no edge.
  // `babel`: the files are built through Babel (Metro), whose Flow and TypeScript transforms erase an
  // import or re-export listing types alone (`import { type A } from`), so it's no edge either, but
  // in a TypeScript file `keepsTypeImports(file)` holds Babel keeps them for (its transform's
  // `onlyRemoveTypeImports`, as --babel reads the project's config); Flow's erases them always.
  // `memo`: what scans before this one, with these options, read of each file, and where to keep
  // what this one reads (see #scanKept).
  constructor({ conditions = [], resolve = null, jsx = false, flow = false, typescript = false, typescriptPaths = null, typescriptResolve = null, resources = new Set(), define, babel = false, keepsTypeImports = null, host = diskHost, memo = null } = {}) {
    this.extraConditions = [...conditions]
    this.customResolve = resolve
    this.typescriptResolve = typescriptResolve
    this.jsx = jsx
    this.flow = flow
    this.typescript = typescript
    this.typescriptPaths = typescriptPaths
    this.resources = resources
    this.defines = parseDefine('scan', define)
    this.babel = babel
    this.keepsTypeImports = keepsTypeImports
    this.host = host
    this.memo = memo
    this.#types = untouchedMemo(host.touches, { retouch: host.retouch })
  }

  // The `type` of each package.json the files scanned are under, read once (formatForFile's), as
  // a host's own reads are kept (vfs-bundle/lazy.js's untouchedMemo).
  #types

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
    // FIFO by an index, not shift(): the queue holds every edge's target, and shift() copies a large one.
    for (let head = 0; head < queue.length; head++) {
      const url = queue[head]
      if (this.files.has(url)) continue
      if (this.memo === null) {
        scanCounts.parsed++
        this.#scanFile(url, queue)
      } else {
        this.#scanKept(url, queue)
      }
    }
    return this
  }

  // The parse of the file being scanned a scan before kept (#scanKept), and the parse of it made here.
  #reparse
  #parse

  // With a `memo` (url -> what a scan read of it, kept across the rounds a lazy tree is read in,
  // vfs-bundle/lazy.js): a file a scan before kept is taken as it read it, what it found and queued
  // and the warnings it gave alike. One scanned here is kept where reading it touched no package not
  // unpacked yet (`host.touches()` counts each such read, through a host that caches nothing such a
  // read reads), so read what the full tree holds: the next scan reads only the files that did, and
  // those it reaches. Of one that did, its parse is kept alone, which is the file's whatever the tree
  // holds, or of that, what it imports (#scanFile): the next scan resolves its imports again, but
  // parses it no more.
  #scanKept(url, queue) {
    const kept = this.memo.get(url)
    scanCounts[kept?.queued !== undefined ? 'replayed' : kept?.parse === undefined ? 'parsed' : 'resolved'] += 1
    if (kept?.queued !== undefined) {
      this.files.set(url, kept.file)
      for (const [key, specMap] of kept.imports) nestedMap(this.imports, key).set(url, specMap)
      this.unresolved.push(...kept.unresolved)
      this.parseErrors.push(...kept.parseErrors)
      queue.push(...kept.queued)
      for (const args of kept.warnings) console.warn(...args)
      return
    }
    const touches = this.host.touches()
    const at = { unresolved: this.unresolved.length, parseErrors: this.parseErrors.length, queue: queue.length }
    // The scan of a file is synchronous: what console.warn is given meanwhile is the file's.
    const warnings = []
    const warn = console.warn
    console.warn = (...args) => {
      warnings.push(args)
      warn.apply(console, args)
    }
    this.#reparse = kept?.parse
    this.#parse = undefined
    try {
      this.#scanFile(url, queue)
    } finally {
      console.warn = warn
      this.#reparse = undefined
    }
    if (this.host.touches() !== touches) {
      if (this.#parse !== undefined) this.memo.set(url, { parse: this.#parse })
      return
    }
    this.memo.set(url, {
      file: this.files.get(url),
      imports: [...this.imports].filter(([, byParent]) => byParent.has(url)).map(([key, byParent]) => [key, byParent.get(url)]),
      unresolved: this.unresolved.slice(at.unresolved),
      parseErrors: this.parseErrors.slice(at.parseErrors),
      queued: queue.slice(at.queue),
      warnings,
    })
  }

  // Node's resolver: must match the runtime resolver's condition set (omitting one resolves
  // `exports`-gated packages to a different file) AND its order: the recorded key must equal the
  // runtime hooks' string for exact lookups. Extras go where Node puts user conditions in each set.
  // A custom resolver (--mainFields/--metro) resolves for a bundler instead, so it gets what
  // esbuild, webpack and Metro all assert: `import`/`require`, `default` (which Node's resolver
  // matches anyway) and the extras, never `node`, `node-addons` or `module-sync`; the same set as
  // resolve-fields.js's resolveConditions.
  #conditionSet(context) {
    if (this.customResolve) return new Set([context, 'default', ...this.extraConditions])
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

  // Strip Flow type syntax to plain JS via stasis's flow-remove-types (loaded lazily). Only invoked
  // as a parse fallback (see #scanFile), so plain-JS files never reach it. Returns the rewritten
  // source, or null when the transform itself fails on this file -- the caller then keeps oxc's
  // original parse error.
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

  // Parse `file` (a script extension) as Node loads it: under the format its name and package
  // declare, or for a typeless .js/.ts the one Node detects from its syntax. -> { format, parsed,
  // errors } (`errors`: what the parse still reports), or { declared, crash } where the parser
  // itself threw on the file, salvaging nothing.
  parseFile(file) {
    const ext = extname(file)
    // declared === null: typeless package; Node decides .js/.ts by syntax, resolved after parse.
    const declared = formatForFile(file, this.host, this.#types)
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
      return { declared, crash: cause.message }
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
    let strippedSource = null
    if (errors.length > 0 && this.flow && FLOW_EXTS.has(ext)) {
      const flowSrc = this.#stripFlow(src, file)
      if (flowSrc !== null) {
        try {
          const asFlow = parser.parseSync(file, flowSrc, parseOptions(baseSourceType))
          if (syntaxErrors(asFlow).length === 0) {
            parsed = asFlow
            format = declared ?? detectedFormat(parsed)
            errors = []
            strippedSource = flowSrc
          }
        } catch { /* keep the original parse + its errors */ }
      }
    }

    // `source`, and `strippedSource` where `parsed` is of its Flow-stripped form, for listsTypesOnly.
    return { format, parsed, errors, source: src, strippedSource }
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

    const result = this.#reparse ?? this.parseFile(file)
    this.#parse = result
    if (result.crash !== undefined) {
      this.#recordParseError(url, result.declared, result.crash, false)
      return
    }
    const { format, parsed, errors } = result

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

    const typesErased = () => result.strippedSource !== null || !this.keepsTypeImports?.(file)
    let { specs } = result
    if (specs === undefined) {
      const touches = this.memo === null ? 0 : this.host.touches()
      specs = collectSpecifiers(parsed.program, this.defines, this.babel ? (node) => listsTypesOnly(node, result) && typesErased() : undefined)
      // What a scan keeps of a file whose reading touched a package not unpacked yet (#scanKept): of
      // its parse, what it imports, where finding that touched none, the parse itself let go.
      if (this.memo !== null && this.host.touches() === touches) this.#parse = { format, errors, specs }
    }

    // The edge KIND picks the resolution context, not the parent's format: createRequire()d
    // require() inside ESM resolves under REQUIRE conditions, literal import() inside CJS under
    // IMPORT conditions -- the parent-format set baked the wrong `exports` branch into the bundle.
    // The custom (legacy-field) resolver keeps the format set: bundlers don't split per edge.
    const formatContext = ['module', 'module-typescript'].includes(format) ? 'import' : 'require'
    const edges = []
    const specMaps = new Map() // condition key -> specifier -> child URL
    const addChild = (s, key, childURL, childPath) => {
      edges.push({ ...s, child: childURL })
      nestedMap(specMaps, key).set(s.spec, childURL)
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

    for (const [key, specMap] of specMaps) nestedMap(this.imports, key).set(url, specMap)
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
