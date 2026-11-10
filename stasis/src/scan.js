import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import assert from 'node:assert/strict'
import { packageType } from '@exodus/stasis-core/bundle-util'
import { classifyExtension, classifyFormat, nestedMap, relativeEscapes } from '@exodus/stasis-core/util'
import { inNodeModules, isSourceFile, resolveTypescriptFallback, typescriptSiblings } from './resolve-typescript.js'
import { RELATIVE_REQUEST } from './resolve-node.js'
import { branchFolder, parseDefine } from './define.js'
import { diskHost } from '@exodus/stasis-core/host'
import { untouchedMemo } from './vfs-bundle/lazy.js'
import { FLOW_EXTS, hasFlowPragma, stripFlowTypes } from './flow.js'

// Static require/import graph walker: parses source, never loads or executes user code.
// Dynamic specifiers (`require(name)`, `import('./'+x)`) are recorded as unresolved. With
// `define`, a branch the defined values keep from running is not walked (see define.js).

// .jsx/.tsx need no flag: oxc parses them as JSX/TSX purely from the filename, so a reached one
// -- e.g. a package whose React Native entry is src/index.tsx -- is parsed and carried like any .ts.
const SCRIPT_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx'])
const RESOLVABLE_EXTS = new Set([...SCRIPT_EXTS, '.json'])
// Whether a file of extension `ext` (`.mjs`) is code a bundle carries as such.
export const isResolvableExt = (ext) => RESOLVABLE_EXTS.has(ext)
// The extensions whose name can't tell whether they hold JSX, parsed with JSX enabled only under
// `jsx` (React Native's JSX-in-.js convention). Excludes the .ts family: TypeScript's `<T>`
// generics collide with JSX, so tsc/oxc reserve JSX for .tsx — JSX-in-TS belongs in a .tsx file.
const JSX_EXTS = new Set(['.js', '.cjs', '.mjs'])

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

// Walks require()/import() calls only; static imports/re-exports are collectSpecifiers' own.
// `fold` (define.js's branchFolder, or null) names the children of a branch whose test folds: the
// side that can't run is never walked.
function findCallSpecifiers(ast, push, fold = null) {
  const pushSpec = (kind, node) => {
    const spec = literalSpec(node)
    push(spec == null ? { kind, dynamic: true } : { kind, spec })
  }
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
      if (callee.type === 'Identifier' && callee.name === 'require' && args.length >= 1) pushSpec('require', args[0])
    } else if (node.type === 'ImportExpression') {
      pushSpec('dynamic-import', node.source)
    } else if (node.type === 'TSImportEqualsDeclaration') {
      // `import lib = require('./dep.cts')`: TS-only CJS import; record the real edge.
      // Qualified-name form (`import A = B.C`) carries no file edge.
      if (node.moduleReference?.type === 'TSExternalModuleReference') pushSpec('require', node.moduleReference.expression)
    }

    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue
      visit(node[key])
    }
  }
  visit(ast)
}

// The import specifiers `program` holds, as { kind, spec } ({ kind, dynamic: true } for a computed one).
// Statement-level type-ness decides an edge, as type erasure does: an `import type`/`export type` is
// erased whole, while `import { type A }` or `import {}` still loads its module. oxc's module records
// can't tell them apart, so the statements are read off the AST. `defines` leave out the calls in the
// branches they keep from running; `typesOnly(node)`, a statement listing types alone (listsTypesOnly).
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

// Whether `entries` (absolute paths) import TS sources by their OUTPUT names, tsc's convention, so the
// build can take --typescript as given: every entry is TypeScript (none in node_modules) and parses, and
// their relative imports naming a JS output (`./a.js`) are each absent while its TS source (outside
// node_modules) is there. Read off the entries alone, before the scan.
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
  const mapsTo = (target) => {
    const pick = typescriptSiblings(target).find((file) => isSourceFile(file, host))
    return pick !== undefined && !inNodeModules(pick, host)
  }
  return targets.length > 0 && targets.every((target) => host.stat(target) === null && mapsTo(target))
}

const TYPE_KINDS = new Set(['type', 'typeof'])

// Whether the import or re-export `node` lists specifiers, every one an inline type (`import { type A }`),
// which Babel's Flow and TypeScript transforms erase whole (Node keeps it, as `import {} from`). A file
// --flow stripped has them blanked in place in `strippedSource`: there it is a statement reading otherwise
// in `source`. One written with none lists no types. The Metro plugin's transformer draws the same line.
function listsTypesOnly(node, { source, strippedSource }) {
  const specifiers = node.specifiers ?? []
  if (specifiers.length > 0) return specifiers.every((specifier) => TYPE_KINDS.has(specifier.importKind ?? specifier.exportKind))
  return strippedSource !== null && source.slice(node.start, node.end) !== strippedSource.slice(node.start, node.end)
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

  // `conditions`: added to the edge-context base set. `resolve`: a replacement for Node's resolver
  // (resolve-fields.js), returning `{ url } | { empty } | { builtin } | null` and owning builtins.
  // `jsx`: JSX in the .js/.cjs/.mjs family (React Native's convention; oxc enables it for .jsx/.tsx alone).
  // `flow`: strip Flow types, as Metro's Babel does (parseFile). `typescript`: retry a miss of the built-in
  // resolver with tsc's mapping (#typescriptResolve), `typescriptPaths` its aliases; without it, the mapping
  // only hints where a miss would land (#typescriptCandidate), a custom resolver's by `typescriptResolve`.
  // `missTargets`: record where each miss would have landed. `resources` (parseResourcesOption's): reached
  // files carried as opaque resources (Metro's assets). `host`: the filesystem walked. `define` (define.js):
  // a require()/import() in a branch its values keep from running is no edge. `babel`: built by Babel
  // (Metro), whose transforms erase an import listing types alone, but in a TypeScript file
  // `keepsTypeImports(file)` holds (`onlyRemoveTypeImports`). `memo`: what earlier scans read (#scanKept).
  constructor({ conditions = [], resolve = null, jsx = false, flow = false, typescript = false, typescriptPaths = null, typescriptResolve = null, resources = new Set(), define, babel = false, keepsTypeImports = null, host = diskHost, memo = null, missTargets = false } = {}) {
    this.extraConditions = [...conditions]
    this.customResolve = resolve
    this.typescriptResolve = typescriptResolve
    this.jsx = jsx
    this.flow = flow
    this.typescript = typescript
    this.typescriptPaths = typescriptPaths
    this.missTargets = missTargets
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

  // A reached file the --resources allowlist names: carried as an opaque resource (bytes only, no parse,
  // no edges). classifyExtension gives 'resource' only for a non-code name.
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

  // With a `memo` (url -> what a scan read of it, kept across a lazy tree's rounds): a file a scan before
  // kept is replayed as it read it, edges, queue and warnings alike. One scanned here is kept where reading
  // it touched no package not unpacked yet (`host.touches()`); of one that did, its parse alone (or what it
  // imports, #scanFile), so the next scan resolves its imports again but parses it no more.
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

  // Node's resolver: the runtime resolver's condition set AND its order (the recorded key must equal the
  // runtime hooks' string), extras where Node puts user conditions. A custom resolver (--mainFields/--metro)
  // gets what esbuild, webpack and Metro assert: `import`/`require`, `default` and the extras, never `node`,
  // `node-addons` or `module-sync` (resolve-fields.js's resolveConditions).
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

  // --typescript: tsc's mapping of `spec` (resolve-typescript.js, shared with the field resolver), only
  // once Node's resolution missed, so it never rewrites a successful one. The hit is realpathed, as
  // every recorded edge is.
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

  // Where a miss of `spec` from `parentFile` would have landed (vfs-bundle/prisma.js's generatedMiss matches
  // them to generator outputs): a path's file; the file the resolver's error names (`target`), or what a
  // custom resolver tried (its missTargets); and under --typescript, where a tsconfig alias points.
  #missTargets(parentFile, spec, target) {
    const path = RELATIVE_REQUEST.test(spec) || isAbsolute(spec)
    const aliased = !path && !spec.startsWith('#') && this.typescript && this.typescriptPaths !== null && !inNodeModules(parentFile, this.host)
    return [
      ...(path ? [resolvePath(dirname(parentFile), spec)] : []),
      ...(typeof target === 'string' ? [target] : Array.isArray(target) ? target : []),
      ...(aliased ? this.typescriptPaths.matchPaths(spec, parentFile) : []),
    ].map((at) => this.#realTarget(at))
  }

  // Where a missing file `path` would be, as a real path, as every recorded edge is: its deepest ancestor
  // that is there realpathed (a package reached through node_modules is a link to it), the rest kept.
  #realTarget(path) {
    const rest = []
    for (let at = path; ; at = dirname(at)) {
      try {
        return join(this.host.realpath(at), ...rest)
      } catch {
        if (dirname(at) === at) return path
        rest.unshift(basename(at))
      }
    }
  }

  // flow.js's stripFlowTypes of `src`, or null where it fails on the file: the caller keeps oxc's parse,
  // saying so where that failed (`failed`).
  #stripFlow(src, file, failed) {
    try {
      return stripFlowTypes(src)
    } catch (cause) {
      if (failed) console.warn(`[stasis] --flow: could not strip Flow types from ${file}; leaving it to oxc (${cause.message})`)
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
    // A retry's parse of `source`, where it is clean; else null, the first parse and its errors kept.
    const cleanParse = (source, sourceType) => {
      try {
        const retried = parser.parseSync(file, source, parseOptions(sourceType))
        return syntaxErrors(retried).length === 0 ? retried : null
      } catch {
        return null
      }
    }
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

    // Node's syntax detection for a typeless file: ESM syntax picks the module variant. Only .ts takes the
    // `-typescript` suffix: .jsx/.tsx are bundler-transformed, keyed by their extension, not Node-strippable.
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
      const asModule = cleanParse(src, 'module')
      if (asModule !== null) {
        parsed = asModule
        format = `module${tsSuffix}`
        errors = []
      }
    }

    // A typeless file Node detects as CJS runs inside the module wrapper too, but `unambiguous`
    // parses it as a plain script, so a top-level `return` still fails there: retry as `commonjs`
    // and prefer a clean parse (the detected commonjs format stands).
    if (errors.length > 0 && declared === null && !format.startsWith('module')) {
      const asCommonjs = cleanParse(src, 'commonjs')
      if (asCommonjs !== null) {
        parsed = asCommonjs
        errors = []
      }
    }

    // --flow: strip Flow types and re-parse, as Metro's Babel reads the file: one marked `@flow` whether or
    // not oxc parses it (where `f<T>(x)` is a comparison), any other only where the oxc parse failed. Only
    // the parse input is rewritten (the bundle stores the on-disk bytes); a re-parse that still fails keeps
    // the original, so a genuine parse error surfaces.
    let strippedSource = null
    if (this.flow && FLOW_EXTS.has(ext) && (errors.length > 0 || hasFlowPragma(src))) {
      const flowSrc = this.#stripFlow(src, file, errors.length > 0)
      const asFlow = flowSrc === null ? null : cleanParse(flowSrc, baseSourceType)
      if (asFlow !== null) {
        parsed = asFlow
        format = declared ?? detectedFormat(parsed)
        errors = []
        strippedSource = flowSrc
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
      // Script (CJS) files: walk on through oxc's recovered AST, so a scan reports the rest of the
      // graph's errors too; the parse error itself fails a bundle (analyzeScanner).
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

    // The edge KIND picks Node's resolution context, not the parent's format: a createRequire()d require()
    // in ESM resolves under REQUIRE conditions, an import() in CJS under IMPORT ones. A custom resolver
    // keeps the format's: bundlers don't split per edge.
    const formatContext = ['module', 'module-typescript'].includes(format) ? 'import' : 'require'
    const edges = []
    const specMaps = new Map() // condition key -> specifier -> child URL
    const addChild = (s, key, childURL, childPath) => {
      edges.push({ ...s, child: childURL })
      nestedMap(specMaps, key).set(s.spec, childURL)
      if (RESOLVABLE_EXTS.has(extname(childPath)) || this.#isResource(childPath)) queue.push(childURL)
    }
    // Records the file --typescript would land the miss on too (typescriptURL), resolved as the miss was,
    // and with `missTargets`, where it would have landed (targets; `target`, the resolver's error's).
    const addUnresolved = (s, reason, conditions, target) => {
      edges.push({ ...s, error: reason })
      const typescriptURL = this.#typescriptCandidate(file, s.spec, conditions)
      const targets = this.missTargets ? this.#missTargets(file, s.spec, target) : []
      this.unresolved.push({ parentURL: url, kind: s.kind, spec: s.spec, reason, ...(typescriptURL ? { typescriptURL } : {}), ...(targets.length > 0 ? { targets } : {}) })
    }

    for (const s of specs) {
      if (s.dynamic) {
        edges.push(s)
        this.unresolved.push({ parentURL: url, kind: s.kind, reason: 'dynamic' })
        continue
      }
      const context = this.customResolve ? formatContext : (s.kind === 'require' ? 'require' : 'import')
      const conditions = this.#conditionSet(context)
      const key = [...conditions].join(', ')
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
          addUnresolved(s, 'MODULE_NOT_FOUND', conditions, this.missTargets ? this.customResolve.missTargets?.(file, s.spec, conditions) : undefined)
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
          addUnresolved(s, cause.code ?? cause.message, conditions, cause.target)
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
      unresolved: this.unresolved.map(({ parentURL, typescriptURL, targets: _, ...rest }) => ({ parent: rel(parentURL), ...rest, ...(typescriptURL ? { typescript: rel(typescriptURL) } : {}) })),
      parseErrors: this.parseErrors.map(({ url, ...rest }) => ({ file: rel(url), ...rest })),
    }
  }
}

export function scan(entries, options = {}) {
  return new Scan(options).walk(entries)
}
