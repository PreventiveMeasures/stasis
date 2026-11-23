import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import { totalmem } from 'node:os'
import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import { packageType, readJson } from '@exodus/stasis-core/bundle-util'
import { excludedText } from '@exodus/stasis-core/policy'
import { classifyExtension, classifyFormat, JS_EXTENSIONS, nestedMap, relativeEscapes, stylesheetFormat, upsert } from '@exodus/stasis-core/util'
import { CSS_KINDS, createCssResolver, cssRequests, cssSpecifiers } from './css.js'
import { inNodeModules, isSourceFile, locatePackage, resolveTypescriptFallback, typescriptSiblings } from './resolve-typescript.js'
import { RELATIVE_REQUEST } from './resolve-node.js'
import { branchFolder, parseDefine } from './define.js'
import { diskHost } from '@exodus/stasis-core/host'
import { hostMemo } from './vfs-bundle/lazy.js'
import { FLOW_EXTS, hasFlowPragma, stripFlow } from './flow.js'

// Static require/import graph walker: parses source, never loads or executes user code.

const RESOLVABLE_EXTS = new Set([...JS_EXTENSIONS, '.json'])
export const isResolvableExt = (ext) => RESOLVABLE_EXTS.has(ext)
// Parsed with JSX only under `jsx` (React Native's JSX-in-.js). Not the .ts family: TypeScript's `<T>` generics
// collide with JSX, so tsc and oxc reserve JSX for .tsx.
const JSX_EXTS = new Set(['.js', '.cjs', '.mjs'])

const TS_EXTS = new Set(['.ts', '.cts', '.mts', '.tsx'])

const EXCLUDED_REASON = 'excluded by excludeModules'
// The conditions a stylesheet's edge is keyed by: those of the css-loader resolver resolving it.
const CSS_IMPORT_CONDITIONS = new Set(['style'])
const CSS_URL_CONDITIONS = new Set(['asset'])

// Raw transfer reserves 6 GiB for the parser's buffer, of which a parse writes only what it takes. Linux refuses one
// mapping past its RAM and swap, so on a smaller machine (a 4 GiB function) that buffer can't be had: a RangeError on
// the main thread, and in a worker under Node 26 the worker terminated as out of heap, past any catch. The machine's
// memory, or its process's where that is less, is to hold that buffer and the rest of the process. Never on Vercel
// (VERCEL_ENV set, in its builds and functions alike), whose functions are that small machine.
const RAW_TRANSFER_MEMORY = 8 * 2 ** 30
export const rawTransferFits = (memory = Math.min(totalmem(), process.constrainedMemory() || Infinity), env = process.env) =>
  env.VERCEL_ENV === undefined && memory >= RAW_TRANSFER_MEMORY

// Required lazily so non-JS bundlers don't load the native oxc parser. Raw transfer, where the platform takes it and
// its buffer fits, hands each AST over from the parser's own buffer rather than as JSON, which takes longer to parse
// than the source.
let _parser
export function getParser() {
  if (_parser === undefined) {
    const oxc = createRequire(import.meta.url)('oxc-parser')
    _parser = oxc.rawTransferSupported() && rawTransferFits() ? { ...oxc, parseSync: (file, source, options) => oxc.parseSync(file, source, { experimentalRawTransfer: true, ...options }) } : oxc
  }
  return _parser
}

export const syntaxErrors = (parsed) => (parsed.errors ?? []).filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')

export function literalSpec(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked
  return null
}

// Stands in a path for an expression, which no path spells.
const HOLE = '\0'
const NATIVE_EXT = '.node'

// What `node` spells of a string: each literal, and null for an expression among them.
function spelledParts(node, parts = []) {
  if (node.type === 'ParenthesizedExpression') return spelledParts(node.expression, parts)
  if (node.type === 'Literal' && typeof node.value === 'string') {
    parts.push(node.value)
  } else if (node.type === 'TemplateLiteral') {
    for (const [i, quasi] of node.quasis.entries()) {
      parts.push(quasi.value.cooked)
      if (i < node.expressions.length) spelledParts(node.expressions[i], parts)
    }
  } else if (node.type === 'BinaryExpression' && node.operator === '+') {
    spelledParts(node.left, parts)
    spelledParts(node.right, parts)
  } else {
    parts.push(null)
  }
  return parts
}

// A relative path to a native addon spelled only in part, by a template literal or a `+` of strings
// (`./native/lib_${target}_nodejs.node`): the path, a HOLE for each expression. Else null.
function nativePattern(node) {
  const parts = spelledParts(node)
  if (!parts.includes(null) || parts.some((part) => part?.includes(HOLE))) return null
  const path = parts.map((part) => part ?? HOLE).join('')
  return RELATIVE_REQUEST.test(path) && path.endsWith(NATIVE_EXT) ? path : null
}

// Keys no node is under.
const NO_CHILD_KEYS = new Set(['type', 'loc', 'range', 'start', 'end'])

// `fn` called on each node of an AST, parent before children; where it returns a list, that is walked in place of the
// node's children.
export function walkAst(node, fn) {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, fn)
    return
  }
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
  const children = fn(node)
  if (children !== undefined) return walkAst(children, fn)
  for (const key of Object.keys(node)) if (!NO_CHILD_KEYS.has(key)) walkAst(node[key], fn)
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
  const pushSpec = (kind, node) => {
    const spec = literalSpec(node)
    if (spec != null) return specs.push({ kind, spec })
    // A require() alone is followed to a native addon.
    const pattern = kind === 'require' ? nativePattern(node) : null
    specs.push({ kind, dynamic: true, ...(pattern === null ? {} : { pattern }) })
  }
  // The side of a branch that can't run is never walked.
  const fold = branchFolder(defines, program)
  walkAst(program, (node) => {
    const live = fold?.(node)
    if (live !== undefined) return live
    if (node.type === 'CallExpression') {
      const { callee, arguments: args } = node
      if (callee.type === 'Identifier' && callee.name === 'require' && args.length >= 1) pushSpec('require', args[0])
    } else if (node.type === 'ImportExpression') {
      pushSpec('dynamic-import', node.source)
    } else if (node.type === 'TSImportEqualsDeclaration') {
      // `import lib = require('./dep.cts')`; the qualified-name form (`import A = B.C`) carries no file edge.
      if (node.moduleReference?.type === 'TSExternalModuleReference') pushSpec('require', node.moduleReference.expression)
    }
  })
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
  // `excludes`: policy.js's moduleExcluder.
  constructor({ conditions = [], resolve = null, jsx = false, flow = false, typescript = false, typescriptPaths = null, typescriptResolve = null, resources = new Set(), define, babel = false, keepsTypeImports = null, host = diskHost, memo = null, missTargets = false, excludes = null } = {}) {
    this.extraConditions = [...conditions]
    this.customResolve = resolve
    this.defines = parseDefine('scan', define)
    Object.assign(this, { typescriptResolve, jsx, flow, typescript, typescriptPaths, missTargets, resources, babel, keepsTypeImports, host, memo, excludes })
    this.#types = hostMemo(host)
  }

  // The `type` of each package.json the files scanned are under (parseFile's).
  #types

  // classifyExtension gives 'resource' only for a non-code name.
  #isResource(file) {
    return classifyExtension(file, this.resources) === 'resource'
  }

  // The native addons a require() names by a path spelled in part, resources with no `resources` entry.
  #natives = new Set()

  // css.js's, once a stylesheet is reached.
  #cssResolver
  #resolveCss(file, kind, spec) {
    this.#cssResolver ??= createCssResolver({ host: this.host })
    return this.#cssResolver(file, kind, spec)
  }

  // The specifiers of the files there that `pattern` (nativePattern's) spells, each expression of it any run of
  // characters within one name: never a `/`, so the files are those of the directories it spells.
  #spelledBy(parentFile, pattern) {
    const from = dirname(parentFile)
    let found = [[]]
    for (const segment of pattern.split('/')) {
      if (!segment.includes(HOLE)) {
        found = found.map((names) => [...names, segment])
        continue
      }
      const spelled = new RegExp(`^${segment.split(HOLE).map(RegExp.escape).join('.*')}$`, 'su')
      found = found.flatMap((names) => this.#namesIn(join(from, ...names)).filter((name) => spelled.test(name)).map((name) => [...names, name]))
    }
    return found.map((names) => names.join('/'))
  }

  // Sorted, as the host lists them. None of what is no directory, or isn't there.
  #namesIn(dir) {
    try {
      return this.host.readdir(dir).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  walk(entries) {
    const queue = []
    for (const entry of entries) {
      const abs = resolvePath(entry)
      const excluded = this.excludes?.(abs)
      assert.ok(this.host.stat(abs) !== null && excluded === undefined, `entry not found: ${abs}${excluded ? ` (${excludedText(excluded)})` : ''}`)
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
      for (const e of kept.file.edges) if (e.native && e.child) this.#natives.add(e.child)
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

  // `${dir}\0${name}` -> whether excludeModules excludes the package Node finds the name in.
  #excludedPackages = new Map()

  // Before Node's resolution reads the package (a lazy tree fetches it), by the directory it is installed in; but for
  // a package's reference to itself, which resolves through its own exports first.
  #excludedPackage(parentFile, spec) {
    if (this.excludes === null || RELATIVE_REQUEST.test(spec) || isAbsolute(spec) || spec.startsWith('#')) return undefined
    const name = spec.split('/', spec.startsWith('@') ? 2 : 1).join('/')
    const dir = dirname(parentFile)
    const excluded = upsert(this.#excludedPackages, `${dir}\0${name}`, () => {
      const found = locatePackage(dir, name, this.host)
      return found !== null && this.excludes(join(found.pkgDir, 'package.json'), { installed: true }) !== undefined
    })
    if (!excluded) return undefined
    const own = this.host.findPackageJSON(parentFile)
    const pkg = own && readJson(own, this.host)
    return pkg?.name === name && pkg.exports !== undefined ? undefined : EXCLUDED_REASON
  }

  // As Node loads it: under the format its name and package declare, or for a typeless .js/.ts the one Node detects.
  parseFile(file) {
    const ext = extname(file)
    // Only .ts takes `-typescript`: .jsx/.tsx are bundler-transformed, not Node-strippable.
    const tsSuffix = ext === '.ts' ? '-typescript' : ''
    // null for a typeless .js/.ts: Node detects its format from its syntax.
    let declared = classifyFormat(file)
    if (declared == null) {
      const type = packageType(file, this.host, this.#types)
      declared = type === null ? null : `${type}${tsSuffix}`
    }
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
    let source = src
    let strippedSource = null
    if (this.flow && FLOW_EXTS.has(ext) && (errors.length > 0 || hasFlowPragma(src))) {
      const flow = stripFlow(src, file, (text) => cleanParse(text, baseSourceType))
      if (flow.parsed !== null) {
        ({ parsed, source, stripped: strippedSource } = flow)
        format = declared ?? detectedFormat(parsed)
        errors = []
      } else if (flow.error && errors.length > 0) {
        console.warn(`[stasis] --flow: could not strip Flow types from ${file}; leaving it to oxc (${flow.error.message})`)
      }
    }
    return { format, parsed, errors, source, strippedSource }
  }

  // A stylesheet as its loader reads it: its specifiers, or a crash where it is no UTF-8 text.
  #parseStylesheet(file, format) {
    const buf = this.host.readFile(file)
    if (!isUtf8(buf)) return { declared: format, crash: 'not UTF-8 text' }
    return { format, errors: [], specs: cssSpecifiers(buf.toString('utf8')) }
  }

  #scanFile(url, queue) {
    const file = fileURLToPath(url)
    const ext = extname(file)
    const stylesheet = stylesheetFormat(file)
    // `resource: true` is what both bundle builders key off; they derive its format from its bytes.
    const leaf = stylesheet !== undefined ? null
      : ext === '.json' ? { format: 'json', edges: [] }
      : this.#isResource(file) || this.#natives.has(url) ? { format: null, edges: [], resource: true }
      : JS_EXTENSIONS.has(ext) ? null
      : { format: null, edges: [] }
    if (leaf !== null) {
      this.files.set(url, leaf)
      return
    }

    const result = this.#reparse ?? (stylesheet === undefined ? this.parseFile(file) : this.#parseStylesheet(file, stylesheet))
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
    // A miss, never read.
    const addExcluded = (s, reason) => {
      edges.push({ ...s, error: reason })
      this.unresolved.push({ parentURL: url, kind: s.kind, spec: s.spec, reason })
    }
    const addChild = (s, conditions, childURL, childPath) => {
      if (this.excludes?.(childPath) !== undefined) {
        addExcluded(s, EXCLUDED_REASON)
        return
      }
      edges.push({ ...s, child: childURL })
      nestedMap(specMaps, [...conditions].join(', ')).set(s.spec, childURL)
      if (s.native) this.#natives.add(childURL)
      if (s.native || RESOLVABLE_EXTS.has(extname(childPath)) || stylesheetFormat(childPath) !== undefined || this.#isResource(childPath)) queue.push(childURL)
    }
    // Each native addon there that a path spelled in part names is an edge of the specifier spelling it, as a run
    // records the one it loads. Only as Node resolves: a browser or React Native target loads no native addon.
    const addNatives = (s) => {
      if (s.pattern === undefined || this.customResolve) return false
      const conditions = this.#conditionSet('require')
      let named = false
      for (const spec of this.#spelledBy(file, s.pattern)) {
        let childPath
        try {
          childPath = this.host.resolve(file, spec, conditions)
        } catch {
          continue // a directory, which names no file
        }
        if (extname(childPath) !== NATIVE_EXT) continue
        addChild({ kind: s.kind, spec, native: true }, conditions, pathToFileURL(childPath).toString(), childPath)
        named = true
      }
      return named
    }
    const addUnresolved = (s, reason, conditions, target) => {
      edges.push({ ...s, error: reason })
      const typescriptURL = this.#typescriptCandidate(file, s.spec, conditions)
      const targets = this.missTargets ? this.#missTargets(file, s.spec, target) : []
      this.unresolved.push({ parentURL: url, kind: s.kind, spec: s.spec, reason, ...(typescriptURL ? { typescriptURL } : {}), ...(targets.length > 0 ? { targets } : {}) })
    }

    for (const s of specs) {
      // A stylesheet's edge, as its loader resolves it (css.js), whatever resolves the JS: a static one, so a miss
      // breaks the build as it breaks the loader's. One naming no file (`data:`, `https:`, `/public.png`) is none.
      if (CSS_KINDS.has(s.kind)) {
        const conditions = s.kind === 'css-url' ? CSS_URL_CONDITIONS : CSS_IMPORT_CONDITIONS
        const hit = this.#resolveCss(file, s.kind, s.spec)
        if (hit !== null) addChild(s, conditions, hit.url, fileURLToPath(hit.url))
        else if (cssRequests(s.spec).length > 0) {
          edges.push({ ...s, error: 'MODULE_NOT_FOUND' })
          this.unresolved.push({ parentURL: url, kind: s.kind, spec: s.spec, reason: 'MODULE_NOT_FOUND' })
        }
        continue
      }
      if (s.dynamic) {
        if (addNatives(s)) continue
        edges.push({ kind: s.kind, dynamic: true })
        this.unresolved.push({ parentURL: url, kind: s.kind, reason: 'dynamic' })
        continue
      }
      const context = this.customResolve ? formatContext : (s.kind === 'require' ? 'require' : 'import')
      const conditions = this.#conditionSet(context)
      // An `empty` edge (a browser/RN `false` redirect) is recorded but neither queued nor counted as unresolved.
      if (this.customResolve) {
        const r = this.customResolve(file, s.spec, conditions)
        if (r?.builtin) edges.push({ ...s, builtin: true })
        else if (r?.empty) edges.push({ ...s, empty: true })
        else if (r?.url) addChild(s, conditions, r.url, fileURLToPath(r.url))
        else addUnresolved(s, 'MODULE_NOT_FOUND', conditions, this.missTargets ? this.customResolve.missTargets?.(file, s.spec, conditions) : undefined)
        continue
      }
      if (isBuiltin(s.spec)) {
        edges.push({ ...s, builtin: true })
        continue
      }
      const excluded = this.#excludedPackage(file, s.spec)
      if (excluded !== undefined) {
        addExcluded(s, excluded)
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
      addChild(s, conditions, pathToFileURL(childPath).toString(), childPath)
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
