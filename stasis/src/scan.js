import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import assert from 'node:assert/strict'
import { packageType } from '@exodus/stasis-core/bundle-util'
import { classifyExtension, classifyFormat, JS_EXTENSIONS, nestedMap, relativeEscapes } from '@exodus/stasis-core/util'
import { inNodeModules, isSourceFile, resolveTypescriptFallback, typescriptSiblings } from './resolve-typescript.js'
import { RELATIVE_REQUEST } from './resolve-node.js'
import { branchFolder, parseDefine } from './define.js'
import { diskHost } from '@exodus/stasis-core/host'
import { hostMemo } from './vfs-bundle/lazy.js'
import { FLOW_EXTS, hasFlowPragma, stripFlowTypes } from './flow.js'

// Static require/import graph walker: parses source, never loads or executes user code.

const RESOLVABLE_EXTS = new Set([...JS_EXTENSIONS, '.json'])
export const isResolvableExt = (ext) => RESOLVABLE_EXTS.has(ext)
// Parsed with JSX only under `jsx` (React Native's JSX-in-.js). Not the .ts family: TypeScript's `<T>` generics
// collide with JSX, so tsc and oxc reserve JSX for .tsx.
const JSX_EXTS = new Set(['.js', '.cjs', '.mjs'])

const TS_EXTS = new Set(['.ts', '.cts', '.mts', '.tsx'])

// Required lazily so non-JS bundlers don't load the native oxc parser. Raw transfer, where the platform takes it,
// hands each AST over from the parser's own buffer rather than as JSON, which takes longer to parse than the source.
let _parser
export function getParser() {
  if (_parser === undefined) {
    const oxc = createRequire(import.meta.url)('oxc-parser')
    _parser = oxc.rawTransferSupported() ? { ...oxc, parseSync: (file, source, options) => oxc.parseSync(file, source, { experimentalRawTransfer: true, ...options }) } : oxc
  }
  return _parser
}

// null for a typeless .js/.ts: Node detects its format from its syntax.
function formatForFile(file, host, kept) {
  const format = classifyFormat(file)
  if (format != null) return format
  const type = packageType(file, host, kept)
  return type === null ? null : `${type}${extname(file) === '.ts' ? '-typescript' : ''}`
}

export const syntaxErrors = (parsed) => (parsed.errors ?? []).filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')

export function literalSpec(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked
  return null
}

const NO_CHILD_KEYS = new Set(['type', 'loc', 'range', 'start', 'end'])

// `fold`: define.js's branchFolder, or null. The side of a branch that can't run is never walked.
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
      // `import lib = require('./dep.cts')`; the qualified-name form (`import A = B.C`) carries no file edge.
      if (node.moduleReference?.type === 'TSExternalModuleReference') pushSpec('require', node.moduleReference.expression)
    }

    for (const key of Object.keys(node)) if (!NO_CHILD_KEYS.has(key)) visit(node[key])
  }
  visit(ast)
}

// Statement-level type-ness decides an edge, as type erasure does (`import { type A }` still loads its module). oxc's
// module records can't tell them apart, so the statements are read off the AST.
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

// Whether `entries` import TS sources by their output names (`./a.js` absent, its TS source there), tsc's convention,
// so the build can take --typescript as given.
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

// Babel's Flow and TypeScript transforms erase such a statement whole (Node keeps it, as `import {} from`). --flow blanks
// the types in place in `strippedSource`. The Metro plugin's transformer draws the same line.
function listsTypesOnly(node, { source, strippedSource }) {
  const specifiers = node.specifiers ?? []
  if (specifiers.length > 0) return specifiers.every((specifier) => TYPE_KINDS.has(specifier.importKind ?? specifier.exportKind))
  return strippedSource !== null && source.slice(node.start, node.end) !== strippedSource.slice(node.start, node.end)
}

// What a build is reported by (EXODUS_STASIS_DEBUG); see #scanKept.
export const scanCounts = { parsed: 0, resolved: 0, replayed: 0 }

export class Scan {
  files = new Map()
  imports = new Map()
  unresolved = []
  parseErrors = []
  entries = new Set()

  // `resolve`: a replacement for Node's resolver (resolve-fields.js), owning builtins. Without `typescript`, tsc's
  // mapping only hints where a miss would land (#typescriptCandidate). `babel`: built by Babel (Metro), whose transforms
  // erase an import listing types alone, but in a TypeScript file `keepsTypeImports(file)` holds.
  constructor({ conditions = [], resolve = null, jsx = false, flow = false, typescript = false, typescriptPaths = null, typescriptResolve = null, resources = new Set(), define, babel = false, keepsTypeImports = null, host = diskHost, memo = null, missTargets = false } = {}) {
    this.extraConditions = [...conditions]
    this.customResolve = resolve
    this.defines = parseDefine('scan', define)
    Object.assign(this, { typescriptResolve, jsx, flow, typescript, typescriptPaths, missTargets, resources, babel, keepsTypeImports, host, memo })
    this.#types = hostMemo(host)
  }

  // The `type` of each package.json the files scanned are under (formatForFile's).
  #types

  // classifyExtension gives 'resource' only for a non-code name.
  #isResource(file) {
    return classifyExtension(file, this.resources) === 'resource'
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

  // The parse of the file being scanned a scan before kept, and the parse of it made here.
  #reparse
  #parse

  // `memo`: url -> what a scan read of it, kept across a lazy tree's rounds. A file is kept whole where reading it
  // touched no package not unpacked yet (`host.touches()`); else its parse alone, so the next scan parses it no more.
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

  // Node's: the runtime resolver's conditions in its order (the recorded key must equal the runtime hooks' string).
  // A custom resolver's: what esbuild, webpack and Metro assert (resolve-fields.js's resolveConditions).
  #conditionSet(context) {
    if (this.customResolve) return new Set([context, 'default', ...this.extraConditions])
    return context === 'import'
      ? new Set(['node', 'import', 'module-sync', 'node-addons', ...this.extraConditions])
      : new Set(['require', 'node', 'node-addons', ...this.extraConditions, 'module-sync'])
  }

  // `recovered`: false where the parser crashed; true where oxc's partial module records were discarded.
  #recordParseError(url, format, message, recovered) {
    this.files.set(url, { format, edges: [], parseError: message })
    this.parseErrors.push({ url, format, message, recovered })
  }

  // Only once Node's resolution missed, so it never rewrites a successful one; realpathed, as every edge is.
  #typescriptResolve(parentFile, spec, conditions) {
    const hit = resolveTypescriptFallback(parentFile, spec, { conditions, paths: this.typescriptPaths, host: this.host })
    if (hit == null) return null
    try {
      return this.host.realpath(hit)
    } catch {
      return null
    }
  }

  // The file: URL a miss would resolve to under --typescript: a hint for the unresolved report only, never an edge.
  #typescriptCandidate(parentFile, spec, conditions) {
    if (this.typescript) return null
    if (this.customResolve) return this.typescriptResolve?.(parentFile, spec, conditions)?.url ?? null
    const hit = this.#typescriptResolve(parentFile, spec, conditions)
    return hit == null ? null : pathToFileURL(hit).toString()
  }

  // Where a miss would have landed, for vfs-bundle/prisma.js to match to generator outputs: a path's file, the
  // resolver's `target` (a custom one's missTargets), and under --typescript where a tsconfig alias points.
  #missTargets(parentFile, spec, target) {
    const path = RELATIVE_REQUEST.test(spec) || isAbsolute(spec)
    const aliased = !path && !spec.startsWith('#') && this.typescript && this.typescriptPaths !== null && !inNodeModules(parentFile, this.host)
    return [
      ...(path ? [resolvePath(dirname(parentFile), spec)] : []),
      ...(typeof target === 'string' ? [target] : Array.isArray(target) ? target : []),
      ...(aliased ? this.typescriptPaths.matchPaths(spec, parentFile) : []),
    ].map((at) => this.#realTarget(at))
  }

  // A missing file by its deepest ancestor that is there, realpathed (a package reached through node_modules is a link).
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

  // null where stripping fails: the caller keeps oxc's parse, saying so where that failed (`failed`).
  #stripFlow(src, file, failed) {
    try {
      return stripFlowTypes(src)
    } catch (cause) {
      if (failed) console.warn(`[stasis] --flow: could not strip Flow types from ${file}; leaving it to oxc (${cause.message})`)
      return null
    }
  }

  // As Node loads it: under the format its name and package declare, or for a typeless .js/.ts the one Node detects.
  parseFile(file) {
    const ext = extname(file)
    const declared = formatForFile(file, this.host, this.#types)
    const src = this.host.readFile(file).toString('utf8')
    // Outside the try: a missing oxc-parser is an env error, not this file's, never a silent zero-edge leaf.
    const parser = getParser()
    const lang = this.jsx && JSX_EXTS.has(ext) ? 'jsx' : undefined
    const parseOptions = (sourceType) => (lang ? { sourceType, lang } : { sourceType })
    const cleanParse = (source, sourceType) => {
      try {
        const retried = parser.parseSync(file, source, parseOptions(sourceType))
        return syntaxErrors(retried).length === 0 ? retried : null
      } catch {
        return null
      }
    }
    // `commonjs`, not `script`: Node runs CJS in its module wrapper, where a top-level `return` or `new.target` is legal.
    const baseSourceType = declared === null ? 'unambiguous' : declared.startsWith('module') ? 'module' : 'commonjs'
    let parsed
    try {
      parsed = parser.parseSync(file, src, parseOptions(baseSourceType))
    } catch (cause) {
      return { declared, crash: cause.message }
    }

    // Only .ts takes `-typescript`: .jsx/.tsx are bundler-transformed, not Node-strippable.
    const tsSuffix = ext === '.ts' ? '-typescript' : ''
    const detectedFormat = (p) => `${p.module.hasModuleSyntax ? 'module' : 'commonjs'}${tsSuffix}`
    let format = declared ?? detectedFormat(parsed)
    let errors = syntaxErrors(parsed)

    // Mirror Node for a typeless script that fails: a clean module parse makes it ESM, else a clean `commonjs` parse
    // (`unambiguous` refuses the CJS wrapper's top-level `return`) keeps it CJS.
    if (errors.length > 0 && declared === null && !format.startsWith('module')) {
      const asModule = cleanParse(src, 'module')
      const clean = asModule ?? cleanParse(src, 'commonjs')
      if (clean !== null) {
        parsed = clean
        if (asModule !== null) format = `module${tsSuffix}`
        errors = []
      }
    }

    // --flow, as Metro's Babel reads the file: one marked `@flow` even where oxc parses it (`f<T>(x)` a comparison
    // there), any other only where oxc's parse failed. A re-parse that still fails keeps the original's errors.
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
    return { format, parsed, errors, source: src, strippedSource }
  }

  #scanFile(url, queue) {
    const file = fileURLToPath(url)
    const ext = extname(file)
    // `resource: true` is what both bundle builders key off; they derive its format from its bytes.
    const leaf = ext === '.json' ? { format: 'json', edges: [] }
      : this.#isResource(file) ? { format: null, edges: [], resource: true }
      : JS_EXTENSIONS.has(ext) ? null
      : { format: null, edges: [] }
    if (leaf !== null) {
      this.files.set(url, leaf)
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
      // A script walks on through oxc's recovered AST, so a scan reports the rest of the graph's errors too.
      this.parseErrors.push({ url, format, message: parseError, recovered: true })
    }

    const typesErased = () => result.strippedSource !== null || !this.keepsTypeImports?.(file)
    let { specs } = result
    if (specs === undefined) {
      const touches = this.memo === null ? 0 : this.host.touches()
      specs = collectSpecifiers(parsed.program, this.defines, this.babel ? (node) => listsTypesOnly(node, result) && typesErased() : undefined)
      // Where finding the specifiers touched no package not unpacked yet, they are kept in place of the parse.
      if (this.memo !== null && this.host.touches() === touches) this.#parse = { format, errors, specs }
    }

    // The edge kind picks Node's resolution context, not the parent's format: a createRequire()d require() in ESM
    // resolves under require conditions. A custom resolver keeps the format's: bundlers don't split per edge.
    const formatContext = ['module', 'module-typescript'].includes(format) ? 'import' : 'require'
    const edges = []
    const specMaps = new Map() // condition key -> specifier -> child URL
    const addChild = (s, key, childURL, childPath) => {
      edges.push({ ...s, child: childURL })
      nestedMap(specMaps, key).set(s.spec, childURL)
      if (RESOLVABLE_EXTS.has(extname(childPath)) || this.#isResource(childPath)) queue.push(childURL)
    }
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
      // An `empty` edge (a browser/RN `false` redirect) is recorded but neither queued nor counted as unresolved.
      if (this.customResolve) {
        const r = this.customResolve(file, s.spec, conditions)
        if (r?.builtin) edges.push({ ...s, builtin: true })
        else if (r?.empty) edges.push({ ...s, empty: true })
        else if (r?.url) addChild(s, key, r.url, fileURLToPath(r.url))
        else addUnresolved(s, 'MODULE_NOT_FOUND', conditions, this.missTargets ? this.customResolve.missTargets?.(file, s.spec, conditions) : undefined)
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
        // The edge stays keyed by the original specifier; only the target is the mapped file.
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
    const remap = (map, entry) => new Map(map.entries().map(entry))
    return {
      entries: new Set([...this.entries].map(rel)),
      files: remap(this.files, ([k, v]) => [rel(k), { ...v, edges: v.edges.map(relEdge) }]),
      imports: remap(this.imports, ([cond, byParent]) => [
        cond,
        remap(byParent, ([p, specs]) => [rel(p), remap(specs, ([spec, child]) => [spec, rel(child)])]),
      ]),
      unresolved: this.unresolved.map(({ parentURL, typescriptURL, targets: _, ...rest }) => ({ parent: rel(parentURL), ...rest, ...(typescriptURL ? { typescript: rel(typescriptURL) } : {}) })),
      parseErrors: this.parseErrors.map(({ url, ...rest }) => ({ file: rel(url), ...rest })),
    }
  }
}

export function scan(entries, options = {}) {
  return new Scan(options).walk(entries)
}
