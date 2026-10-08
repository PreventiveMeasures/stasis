// Static facts about a file StasisEsbuild serves, for spotting where esbuild's output would depend on
// the package.json `type` it can't see on a plugin-served file. esbuild takes a .js/.jsx/.ts/.tsx
// file's module type from the nearest package.json only when its own resolver resolved the file; a
// plugin's onResolve result carries no module type (esbuild 0.27 and 0.28 alike), so every file this
// plugin serves parses as if its package had no `type`. The facts below decide whether that changes
// what the build does, so the plugin can abort instead of diverging from a plain esbuild build.

import { createRequire } from 'node:module'

// The extensions esbuild types from package.json `type`; .mjs/.cjs/.mts/.cts are typed by name, which a
// plugin-served file keeps, and any other extension has no module type either way.
export const PACKAGE_TYPED_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx'])

const LANGS = new Set(['js', 'jsx', 'ts', 'tsx'])

// An optional peer dependency, required lazily: only this plugin's check parses, and only a build that
// serves a file it must check needs it (metro, webpack and rollup users never load it).
let parser
function getParser() {
  if (parser) return parser
  try {
    parser = createRequire(import.meta.url)('oxc-parser')
  } catch (cause) {
    throw new Error(
      "StasisEsbuild: checking a file of a package.json-typed package needs the optional peer dependency 'oxc-parser'; " +
      'install it (e.g. `npm i -D oxc-parser`)',
      { cause }
    )
  }
  return parser
}

const errorsOf = (parsed) => parsed.errors.filter((e) => e.severity !== 'Warning' && e.severity !== 'Advice')

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
// Whole type-level declarations: nothing in them runs, so nothing in them is a reference.
const TYPE_ONLY = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction'])
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'superTypeArguments', 'implements'])
const SKIP_KEYS = new Set(['type', 'start', 'end', 'range', 'loc', ...TYPE_KEYS])

const stringValue = (node) => {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) return node.quasis[0].value.cooked
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    // Constant concatenation (`'__es' + 'Module'`), folded as esbuild does; the left spine iteratively, as
    // minified concatenations run long.
    const parts = []
    let current = node
    for (; current.type === 'BinaryExpression' && current.operator === '+'; current = current.left) parts.push(current.right)
    let value = stringValue(current)
    for (const part of parts.toReversed()) {
      const next = value === undefined ? undefined : stringValue(part)
      value = next === undefined ? undefined : value + next
    }
    return value
  }
  return undefined
}
const nameOf = (node) => (node?.type === 'Identifier' ? node.name : stringValue(node))
const isModuleExports = (node) => node?.type === 'MemberExpression' && node.object.type === 'Identifier' &&
  node.object.name === 'module' && (node.computed ? stringValue(node.property) : node.property.name) === 'exports'
const isExportsTarget = (node) => (node?.type === 'Identifier' && node.name === 'exports') || isModuleExports(node)
// `module[key]`: the name of the key, for the caller to resolve once every declaration is in.
const moduleKeyName = (node) => (node?.type === 'MemberExpression' && node.computed && node.object.type === 'Identifier' &&
  node.object.name === 'module' && node.property.type === 'Identifier' ? node.property.name : undefined)
const requireSpecifier = (node) => (node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
  node.callee.name === 'require' && node.arguments.length === 1 ? stringValue(node.arguments[0]) : undefined)

// Child nodes of an ESTree node, with the key each sits under.
function* children(node) {
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') yield [item, key]
    } else if (value && typeof value.type === 'string') {
      yield [value, key]
    }
  }
}

// An Identifier named `module`/`exports` that is not a reference: a property name, label, or a name in an
// import/export clause. Binding positions are references here too (counted, and flagged as declared).
function isNonReference(parent, key) {
  switch (parent.type) {
    case 'MemberExpression':
      return key === 'property' && !parent.computed
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'AccessorProperty':
    case 'TSPropertySignature':
      return key === 'key' && !parent.computed
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return key === 'label'
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
    case 'ExportAllDeclaration':
    case 'MetaProperty':
    case 'TSQualifiedName':
    case 'TSEnumMember':
      return true
    default:
      return false
  }
}

// Whether a child sits in a binding position: a declaration's name or binding pattern, not an
// assignment target (`[module] = values` assigns the existing name). `binding` is the parent's own state.
const PATTERNS = new Set(['ObjectPattern', 'ArrayPattern', 'RestElement', 'TSParameterProperty'])
function bindsChild(node, childKey, binding) {
  switch (node.type) {
    case 'VariableDeclarator':
      return childKey === 'id'
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return childKey === 'params' || childKey === 'id'
    case 'ClassDeclaration':
    case 'ClassExpression':
      return childKey === 'id'
    case 'CatchClause':
      return childKey === 'param'
    case 'AssignmentPattern':
      return binding && childKey === 'left'
    case 'Property':
      return binding && childKey === 'value'
    default:
      return binding && PATTERNS.has(node.type)
  }
}

// The names a declaration's binding pattern declares.
function patternNames(pattern, names = []) {
  switch (pattern?.type) {
    case 'Identifier':
      names.push(pattern.name)
      break
    case 'ObjectPattern':
      for (const prop of pattern.properties) patternNames(prop.type === 'RestElement' ? prop.argument : prop.value, names)
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) patternNames(element, names)
      break
    case 'AssignmentPattern':
      patternNames(pattern.left, names)
      break
    case 'RestElement':
      patternNames(pattern.argument, names)
      break
  }
  return names
}

// What each name a destructuring pattern binds may get from `value`: an element of it (`[a] = value`, `{ a } =
// value`, as an ElementOf node), its default (`[a = fallback] = value`), or, for an object pattern's rest, the
// value itself less some keys.
function patternSources(pattern, value, sources = new Map()) {
  const elementOf = { type: 'ElementOf', object: value }
  switch (pattern?.type) {
    case 'Identifier':
      sources.set(pattern.name, [...(sources.get(pattern.name) ?? []), value])
      break
    case 'AssignmentPattern':
      patternSources(pattern.left, value, sources)
      patternSources(pattern.left, pattern.right, sources)
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) if (element?.type !== 'RestElement') patternSources(element, elementOf, sources)
      break
    case 'ObjectPattern':
      for (const prop of pattern.properties) patternSources(prop.type === 'RestElement' ? prop.argument : prop.value, prop.type === 'RestElement' ? value : elementOf, sources)
      break
  }
  return sources
}

// The values an array or object literal holds (elements, property values), for what a pattern takes from it;
// a name's are the caller's to follow (out.elements).
function elementsOf(node, out) {
  switch (node?.type) {
    case 'ArrayExpression':
      return node.elements.flatMap((element) => (element === null ? [] : element.type === 'SpreadElement' ? elementsOf(element.argument, out) : [element]))
    case 'ObjectExpression':
      return node.properties.flatMap((prop) => (prop.type === 'SpreadElement' ? elementsOf(prop.argument, out) : [prop.value]))
    case 'ElementOf':
      return elementsOf(node.object, out).flatMap((element) => elementsOf(element, out))
    case 'ConditionalExpression':
      return [...elementsOf(node.consequent, out), ...elementsOf(node.alternate, out)]
    case 'LogicalExpression':
      return [...elementsOf(node.left, out), ...elementsOf(node.right, out)]
    case 'Identifier':
      out.elements.add(node.name)
      return []
    default:
      return []
  }
}

// Whether a statement list opens with a "use strict" directive.
function hasUseStrict(statements) {
  for (const statement of statements) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') return false
    if (statement.directive === 'use strict') return true
  }
  return false
}

// Whether an expression is falsy whatever runs: an `__esModule` set to one marks nothing. Not the name
// `undefined`, which a local declaration can rebind; `void 0` can't be.
function isFalsy(node) {
  switch (node?.type) {
    case 'Literal':
      return node.regex === undefined && node.bigint === undefined && !node.value
    case 'UnaryExpression':
      return node.operator === 'void' || (node.operator === '!' && node.argument.type === 'Literal' && node.argument.regex === undefined && Boolean(node.argument.value))
    default:
      return false
  }
}

// Whether a defineProperty descriptor may define a truthy value: not a literal whose `value` is falsy and has no getter.
function mayDefineTruthy(descriptor) {
  if (descriptor?.type !== 'ObjectExpression') return true
  const key = (prop) => (prop.type === 'Property' && !prop.computed ? nameOf(prop.key) : undefined)
  if (descriptor.properties.some((prop) => prop.type !== 'Property' || prop.computed || key(prop) === 'get')) return true
  const value = descriptor.properties.find((prop) => key(prop) === 'value')
  return value !== undefined && !isFalsy(value.value)
}

// The values a call of a function returns: its expression body, or each `return` outside nested functions --
// none for an async function or a generator, whose call returns a Promise or an iterator instead.
function returnedValues(fn) {
  if (fn.async || fn.generator) return []
  if (fn.body.type !== 'BlockStatement') return [fn.body]
  const values = []
  const stack = [fn.body]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current.type === 'ReturnStatement') values.push(current.argument)
    for (const [child] of children(current)) if (!FUNCTIONS.has(child.type) && child.type !== 'ClassBody') stack.push(child)
  }
  return values
}

// Whether a class's static (or else instance and prototype) members put `__esModule` on what they define:
// sets out.marked, or collects a computed key's name for the caller to resolve (out.keys).
function scanMembers(cls, statics, out) {
  for (const member of cls.body.body) {
    if (!('key' in member) || Boolean(member.static) !== statics || member.kind === 'set') continue
    if (member.type !== 'MethodDefinition' && (member.value == null || isFalsy(member.value))) continue
    if (member.computed ? mayNameEsModule(member.key, out) : nameOf(member.key) === '__esModule') out.marked = true
  }
}

const isSymbol = (node) => (node?.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'Symbol') ||
  (node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Symbol')

// Whether a computed key of what becomes the exports may name `__esModule`: a constant compares (`'__es' +
// 'Module'`), another literal can't (`0`), nor can a symbol (`Symbol.iterator`) unless the file binds `Symbol`
// itself (the caller's to tell: out.symbols), a name is the caller's to resolve once every declaration is in
// (out.keys), and anything else -- `process.env.KEY`, a call -- may.
function mayNameEsModule(key, out) {
  const string = stringValue(key)
  if (string !== undefined) return string === '__esModule'
  if (key.type === 'Literal') return false
  if (isSymbol(key)) {
    out.symbols = true
    return false
  }
  if (key.type !== 'Identifier') return true
  out.keys.add(key.name)
  return false
}

// What an instance of `callee` (`new Box()`) gets from its class and superclasses: instance fields and
// prototype methods. A class reached by name is the caller's to follow (out.instances); one a require()
// returns is another module's.
function scanInstance(callee, out) {
  for (let cls = callee; cls; cls = cls.superClass) {
    if (cls.type === 'Identifier') {
      out.instances.add(cls.name)
      return
    }
    if (cls.type !== 'ClassExpression' && cls.type !== 'ClassDeclaration') return
    scanMembers(cls, false, out)
  }
}

// What can become the value an expression assigns to module.exports (or copies into it): the expression
// itself, either branch of a conditional or logical, the last of a sequence, the end of an assignment chain,
// what an IIFE returns, what an object literal spreads, a class's superclass, and what a call or `new` is
// handed (it may return or copy it) -- not an object literal's other property values, which only end up
// nested in the exports. Collects `require('<literal>')` specifiers, identifiers, callee names and the
// classes of instances (followed through their declarations and function returns by the caller), and whether
// an object literal's key, a class's static or an instance's member there is `__esModule` (`out.marked`), or a
// computed key the caller resolves (`out.keys`: `{ [marker]: true }`).
function scanValue(node, out) {
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    switch (current?.type) {
      case 'Identifier':
        out.identifiers.add(current.name)
        break
      case 'ConditionalExpression':
        stack.push(current.consequent, current.alternate)
        break
      case 'LogicalExpression':
        stack.push(current.left, current.right)
        break
      case 'SequenceExpression':
        stack.push(current.expressions.at(-1))
        break
      case 'AssignmentExpression':
        stack.push(current.right)
        break
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
        stack.push(current.expression)
        break
      case 'ClassExpression':
      case 'ClassDeclaration':
        // Its statics are the exports' own properties, and its superclass's statics inherited ones.
        scanMembers(current, true, out)
        stack.push(current.superClass)
        break
      case 'ElementOf':
        stack.push(...elementsOf(current.object, out))
        break
      case 'NewExpression':
        scanInstance(current.callee, out)
        for (const arg of current.arguments) stack.push(arg.type === 'SpreadElement' ? arg.argument : arg)
        break
      case 'ObjectExpression':
        for (const prop of current.properties) {
          if (prop.type === 'SpreadElement') stack.push(prop.argument)
          // A setter alone reads as undefined.
          else if (isFalsy(prop.value) || prop.kind === 'set') continue
          else if (prop.computed ? mayNameEsModule(prop.key, out) : nameOf(prop.key) === '__esModule') out.marked = true
        }
        break
      case 'CallExpression': {
        const spec = requireSpecifier(current)
        if (spec !== undefined) {
          out.specifiers.add(spec)
          break
        }
        if (FUNCTIONS.has(current.callee.type)) stack.push(...returnedValues(current.callee))
        if (current.callee.type === 'Identifier') out.callees.add(current.callee.name)
        for (const arg of current.arguments) stack.push(arg.type === 'SpreadElement' ? arg.argument : arg)
        break
      }
    }
  }
}

// -> null for contents esbuild doesn't parse as JS/TS, else:
//   esmExports  an export (type-only included), import.meta or top-level await: ESM whatever the package type
//   esmImports  a static value import statement
//   cjsUsage    'yes' | 'no': whether esbuild would see CommonJS use: a `module`/`exports` reference no enclosing
//               scope binds (a module-scope `var` of the name doesn't either: esbuild merges it with the CommonJS
//               binding), top-level this/return, a direct eval, TS `export =`
//   cjsDetail   what that use is, for messages
//   strictOnly  why the file is valid only as a sloppy-mode script (null if it parses as a module)
//   blockFunction  a function declared in a nested block of sloppy-mode code (hoisted differently than in strict)
//   topArguments  an `arguments` outside any function of its own: a CommonJS wrapper's where the file is wrapped
//   imports     Map specifier -> { bindings, interop }: whether a static import/re-export of it observes its
//               exports at all, and whether through its default export or namespace (where interop decides the value)
//   requires    Map specifier -> { consumed }: whether a `require()` of it uses the result (not a bare statement)
//   dynamicImports  Map specifier -> { consumed }: the same for an `import()` (not a bare or awaited statement)
//   setsEsModule  something that may mark the exports __esModule: an `__esModule` assignment or defineProperty on
//               anything but a fresh local object that never becomes them (bundled output names its exports
//               arbitrarily), or an `__esModule` key in a literal that becomes them
//   reexports   require() specifiers whose result can become this file's module.exports
//   parseError  the parse failed; the facts above are a best effort
export function analyzeModule(source, { path, loader }) {
  if (!LANGS.has(loader)) return null
  const { parseSync } = getParser()
  const text = typeof source === 'string' ? source : Buffer.from(source).toString('utf8')
  // `commonjs`, not `script`: a top-level `return` is legal there, as in Node's (and esbuild's) CJS.
  const parse = (sourceType, showSemanticErrors) => parseSync(path, text, { lang: loader, sourceType, showSemanticErrors, preserveParens: false })

  // Semantic errors are where strict mode shows (`with`, octal literals, `delete x`), so try both goals
  // with them first; if both still fail, the file is broken either way, and only a syntax-clean parse is
  // kept so that semantic noise doesn't discard a complete AST.
  let parsed = parse('module', true)
  let strictOnly = null
  let parseError = null
  const moduleErrors = errorsOf(parsed)
  if (moduleErrors.length > 0) {
    const asScript = parse('commonjs', true)
    if (errorsOf(asScript).length === 0) {
      strictOnly = moduleErrors[0].message
      parsed = asScript
    } else {
      const syntaxModule = parse('module', false)
      const syntaxScript = errorsOf(syntaxModule).length === 0 ? null : parse('commonjs', false)
      if (syntaxScript === null) parsed = syntaxModule
      else if (errorsOf(syntaxScript).length === 0) [parsed, strictOnly] = [syntaxScript, errorsOf(syntaxModule)[0].message]
      else parseError = moduleErrors[0].message
    }
  }

  const facts = {
    esmExports: false, esmImports: false, cjsUsage: 'no', cjsDetail: null, strictOnly, blockFunction: false, topArguments: false,
    imports: new Map(), requires: new Map(), dynamicImports: new Map(), setsEsModule: false, reexports: new Set(), parseError,
  }
  const useImport = (specifier, { bindings = false, interop = false }) => {
    const prior = facts.imports.get(specifier) ?? { bindings: false, interop: false }
    facts.imports.set(specifier, { bindings: prior.bindings || bindings || interop, interop: prior.interop || interop })
  }
  let cjsCertain = null
  // Scopes binding `module`/`exports`. At the module scope an import/let/const/function/class shadows the
  // CommonJS binding for every reference, while a `var` merges with it; a nested scope just binds the name.
  const root = { names: new Set(), parent: null }
  const shadowed = new Set()
  const hoistedVar = new Set()
  const references = []  // [name, scope]
  const tracked = (name) => name === 'module' || name === 'exports'
  const declare = (scope, name, kind) => {
    if (!tracked(name)) return
    if (scope !== root) scope.names.add(name)
    else (kind === 'var' ? hoistedVar : shadowed).add(name)
  }
  const declarators = new Map()  // name -> [init]: a declarator's, or the class a class declaration binds
  const functionDecls = new Map()  // name -> [FunctionDeclaration]
  // What a call may copy into a local it's handed first (`Object.assign(out, src)`): it reaches the exports if out does.
  const copies = new Map()  // name -> [argument]
  const assignments = new Map()  // name -> [assigned value]: `out = value` (destructuring: the whole right side)
  // A fresh local object (every binding of the name an object-literal declarator, never reassigned): an
  // `__esModule` mark on one only reaches the exports if the object does.
  const bindingCounts = new Map()
  const objectDecls = new Map()
  const reassigned = new Set()
  const pendingMarks = new Set()
  const count = (map, name) => map.set(name, (map.get(name) ?? 0) + 1)
  const markReceiver = (receiver) => {
    if (receiver?.type === 'Identifier') pendingMarks.add(receiver.name)
    else facts.setsEsModule = true
  }
  // A key set on a receiver: `__esModule` marks it; a computed name (`exports[marker] = true`) may, resolved once
  // every declaration is in. A key whose value isn't known doesn't count here, unlike in what becomes the exports:
  // dynamic writes run all over CommonJS, the exports included (fs-extra's `exports[method] = u(fs[method])` loop).
  const keyMarks = []  // [key name, receiver]
  const keyedWrites = []  // [key name, values]: written to (or copied into) `module[key]`, the exports where key is 'exports'
  const markKey = (key, computed, receiver) => {
    if ((computed ? stringValue(key) : nameOf(key)) === '__esModule') markReceiver(receiver)
    else if (computed && key?.type === 'Identifier') keyMarks.push([key.name, receiver])
  }
  const exported = { specifiers: new Set(), identifiers: new Set(), callees: new Set(), instances: new Set(), elements: new Set(), keys: new Set(), symbols: false, marked: false }

  // Iterative: minified code nests deeper than the call stack allows. fnDepth counts every function
  // (return/await scope), thisDepth only what has its own `this` (non-arrow functions, class field values,
  // static blocks); strict is whether the code around the node is strict-mode (a directive, a class); scope
  // and fnScope are the innermost scope and the one a `var` lands in; binding is whether the node sits in a
  // binding position.
  const stack = [[parsed.program, null, null, null, 0, 0, hasUseStrict(parsed.program.body), root, root, false]]
  while (stack.length > 0) {
    const [node, parent, key, grandparent, fnDepth, thisDepth, strict, scope, fnScope, binding] = stack.pop()
    if (TYPE_ONLY.has(node.type) || node.declare) continue
    let childScope = scope
    let childFnScope = fnScope
    switch (node.type) {
      case 'ImportDeclaration':
        if (node.importKind === 'type') continue
        facts.esmImports = true
        if (node.specifiers.length === 0) useImport(node.source.value, {})
        for (const spec of node.specifiers) {
          if (spec.importKind === 'type') continue
          const interop = spec.type !== 'ImportSpecifier' || nameOf(spec.imported) === 'default' || node.phase != null
          useImport(node.source.value, { bindings: true, interop })
          declare(root, spec.local.name, 'import')
          count(bindingCounts, spec.local.name)
        }
        break
      case 'ExportNamedDeclaration':
        facts.esmExports = true
        if (node.source && node.exportKind !== 'type') {
          for (const spec of node.specifiers) {
            if (spec.exportKind === 'type') continue
            useImport(node.source.value, { bindings: true, interop: nameOf(spec.local) === 'default' })
          }
        }
        break
      case 'ExportDefaultDeclaration':
        facts.esmExports = true
        break
      case 'ExportAllDeclaration':
        facts.esmExports = true
        if (node.exportKind !== 'type') useImport(node.source.value, { bindings: true, interop: node.exported != null })
        break
      case 'MetaProperty':
        if (node.meta.name === 'import') facts.esmExports = true
        break
      case 'AwaitExpression':
        if (fnDepth === 0) facts.esmExports = true
        break
      case 'VariableDeclaration':
        if (node.kind === 'await using' && fnDepth === 0) facts.esmExports = true
        for (const declarator of node.declarations) {
          for (const name of patternNames(declarator.id)) declare(node.kind === 'var' ? fnScope : scope, name, node.kind)
        }
        break
      case 'ClassDeclaration':
        if (node.id) {
          declare(scope, node.id.name, 'class')
          declarators.set(node.id.name, [...(declarators.get(node.id.name) ?? []), node])
        }
        break
      case 'ClassExpression':
        if (node.id) {
          childScope = { names: new Set(), parent: scope }
          declare(childScope, node.id.name, 'class')
        }
        break
      case 'ThisExpression':
        if (thisDepth === 0) cjsCertain ??= 'top-level `this`'
        break
      case 'ReturnStatement':
        if (fnDepth === 0) cjsCertain ??= 'a top-level `return`'
        break
      case 'TSExportAssignment':
        cjsCertain ??= '`export =`'
        break
      case 'ImportExpression': {
        const imported = stringValue(node.source)
        if (imported !== undefined) {
          const consumed = !(parent?.type === 'ExpressionStatement' && key === 'expression') &&
            !(parent?.type === 'AwaitExpression' && grandparent?.type === 'ExpressionStatement')
          facts.dynamicImports.set(imported, { consumed: consumed || (facts.dynamicImports.get(imported)?.consumed ?? false) })
        }
        break
      }
      case 'CallExpression': {
        if (node.callee.type === 'Identifier' && node.callee.name === 'eval' && !node.optional) cjsCertain ??= 'a direct `eval`'
        const required = requireSpecifier(node)
        if (required !== undefined) {
          const consumed = !(parent?.type === 'ExpressionStatement' && key === 'expression')
          facts.requires.set(required, { consumed: consumed || (facts.requires.get(required)?.consumed ?? false) })
        }
        // defineProperty-style: (target, '__esModule', descriptor), aliases included (esbuild's __defProp).
        if (node.arguments.length >= 3 && mayDefineTruthy(node.arguments[2])) markKey(node.arguments[1], true, node.arguments[0])
        if (node.arguments[0]?.type === 'Identifier' && !isExportsTarget(node.arguments[0]) && node.arguments.length > 1) {
          const [{ name }, ...rest] = node.arguments
          copies.set(name, [...(copies.get(name) ?? []), ...rest.map((arg) => (arg.type === 'SpreadElement' ? arg.argument : arg))])
        }
        // Copying into the exports: Object.assign(module.exports, require(x)), __exportStar(require(x), exports),
        // Object.defineProperties(exports, { __esModule: ... }).
        if (node.arguments.some(isExportsTarget)) {
          for (const arg of node.arguments) if (!isExportsTarget(arg)) scanValue(arg, exported)
        }
        for (const arg of node.arguments) {
          const name = moduleKeyName(arg)
          if (name !== undefined) keyedWrites.push([name, node.arguments.filter((other) => other !== arg)])
        }
        break
      }
      case 'AssignmentExpression':
        if (node.left.type === 'MemberExpression' && !(node.operator === '=' && isFalsy(node.right))) {
          markKey(node.left.property, node.left.computed, node.left.object)
        }
        for (const [name, values] of patternSources(node.left, node.right)) {
          reassigned.add(name)
          assignments.set(name, [...(assignments.get(name) ?? []), ...values])
        }
        if (isExportsTarget(node.left)) scanValue(node.right, exported)
        else if (moduleKeyName(node.left) !== undefined) keyedWrites.push([moduleKeyName(node.left), [node.right]])  // module[key] = value
        break
      case 'VariableDeclarator':
        if (node.id.type === 'Identifier' && node.init) {
          declarators.set(node.id.name, [...(declarators.get(node.id.name) ?? []), node.init])
          if (node.init.type === 'ObjectExpression') count(objectDecls, node.id.name)
        } else if (node.init) {
          for (const [name, values] of patternSources(node.id, node.init)) declarators.set(name, [...(declarators.get(name) ?? []), ...values])
        }
        break
      case 'FunctionDeclaration': {
        if (node.id) {
          declare(scope, node.id.name, 'function')
          functionDecls.set(node.id.name, [...(functionDecls.get(node.id.name) ?? []), node])
        }
        const inFunctionBody = parent?.type === 'BlockStatement' && key === 'body' && FUNCTIONS.has(grandparent?.type)
        if (!strict && !inFunctionBody &&
          !['Program', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'TSModuleBlock', 'StaticBlock'].includes(parent?.type)) {
          facts.blockFunction = true
        }
        break
      }
      case 'CatchClause':
        childScope = { names: new Set(), parent: scope }
        for (const name of patternNames(node.param)) declare(childScope, name, 'let')
        break
      case 'BlockStatement':
        // A function's body block is the function's body scope, made with its parameters' scope below.
        if (!(FUNCTIONS.has(parent?.type) && key === 'body')) childScope = { names: new Set(), parent: scope }
        break
      case 'StaticBlock':
        childScope = childFnScope = { names: new Set(), parent: scope }
        break
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
        if (node.await && fnDepth === 0) facts.esmExports = true
        // `for (o of xs)` assigns o, as `o = x` does.
        if (node.left && node.left.type !== 'VariableDeclaration') for (const name of patternNames(node.left)) reassigned.add(name)
        childScope = { names: new Set(), parent: scope }
        break
      case 'SwitchStatement':
      case 'TSModuleBlock':
        childScope = { names: new Set(), parent: scope }
        break
      case 'Identifier':
        if (parent && !isNonReference(parent, key)) {
          if (binding) count(bindingCounts, node.name)
          else if (tracked(node.name)) references.push([node.name, scope])
          else if (node.name === 'arguments' && thisDepth === 0) facts.topArguments = true
        }
        break
    }
    // A function's parameters (and a function expression's own name) get a scope of their own, and its
    // body one inside that: a default parameter value can't see the body's declarations, `var` included.
    let bodyScope
    if (FUNCTIONS.has(node.type)) {
      childScope = childFnScope = { names: new Set(), parent: scope }
      if (node.type !== 'FunctionDeclaration' && node.id) declare(childScope, node.id.name, 'function')
      for (const param of node.params) for (const name of patternNames(param)) declare(childScope, name, 'param')
      bodyScope = { names: new Set(), parent: childScope }
    }
    // Non-arrow functions have their own `this`; in a class, field initializers and static blocks do too, but a
    // computed key and `extends` see the outer one.
    const ownsThis = (childKey) => node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' ||
      node.type === 'StaticBlock' || ((node.type === 'PropertyDefinition' || node.type === 'AccessorProperty') && childKey === 'value')
    const childFnDepth = FUNCTIONS.has(node.type) ? fnDepth + 1 : fnDepth
    const childStrict = strict || node.type === 'ClassDeclaration' || node.type === 'ClassExpression' ||
      (FUNCTIONS.has(node.type) && node.body?.type === 'BlockStatement' && hasUseStrict(node.body.body))
    for (const [child, childKey] of children(node)) {
      const [inScope, inFnScope] = bodyScope && childKey === 'body' ? [bodyScope, bodyScope] : [childScope, childFnScope]
      const childThisDepth = ownsThis(childKey) ? thisDepth + 1 : thisDepth
      stack.push([child, node, childKey, parent, childFnDepth, childThisDepth, childStrict, inScope, inFnScope, bindsChild(node, childKey, binding)])
    }
  }

  // A reference is CommonJS use unless a scope around it binds the name (all declarations are in by now,
  // so hoisting is covered); at the module scope only a shadowing declaration does.
  const isFree = (name, scope) => {
    for (let current = scope; current !== root; current = current.parent) if (current.names.has(name)) return false
    return !shadowed.has(name)
  }
  const free = references.find(([name, scope]) => isFree(name, scope))?.[0] ?? [...hoistedVar][0]
  if (cjsCertain !== null) {
    facts.cjsUsage = 'yes'
    facts.cjsDetail = cjsCertain
  } else if (free !== undefined) {
    facts.cjsUsage = 'yes'
    facts.cjsDetail = `\`${free}\``
  }

  // Follow what becomes module.exports through declarations and assignments (`const lib = require('./lib');
  // module.exports = lib`), the returns of local functions it calls (`module.exports = load()`) and the local
  // classes of instances it constructs (`module.exports = new Box()`), transitively.
  // A computed key names the string a declaration or assignment of that name gives it.
  const names = (name, string) => [...(declarators.get(name) ?? []), ...(assignments.get(name) ?? [])].some((value) => stringValue(value) === string)
  for (const [name, written] of keyedWrites) {
    if (!names(name, 'exports')) continue
    for (const value of written) scanValue(value.type === 'SpreadElement' ? value.argument : value, exported)
  }
  const done = { value: new Set(), call: new Set(), instance: new Set(), elements: new Set() }
  const pending = []
  const follow = (found) => {
    for (const identifier of found.identifiers) pending.push(['value', identifier])
    for (const callee of found.callees) pending.push(['call', callee])
    for (const cls of found.instances) pending.push(['instance', cls])
    for (const name of found.elements) pending.push(['elements', name])
    if (found.marked) exported.marked = true
    if (found.symbols) exported.symbols = true
  }
  follow(exported)
  while (pending.length > 0) {
    const [kind, name] = pending.pop()
    if (done[kind].has(name)) continue
    done[kind].add(name)
    const inits = declarators.get(name) ?? []
    const assigned = assignments.get(name) ?? []
    const found = { specifiers: exported.specifiers, identifiers: new Set(), callees: new Set(), instances: new Set(), elements: new Set(), keys: exported.keys, symbols: false, marked: false }
    if (kind === 'value') for (const origin of [...inits, ...assigned, ...(copies.get(name) ?? [])]) scanValue(origin, found)
    else if (kind === 'instance') for (const origin of [...inits, ...assigned]) scanInstance(origin, found)
    else if (kind === 'elements') for (const origin of [...inits, ...assigned]) for (const value of elementsOf(origin, found)) scanValue(value, found)
    else {
      const fns = [...(functionDecls.get(name) ?? []), ...[...inits, ...assigned].filter((init) => FUNCTIONS.has(init.type))]
      for (const value of fns.flatMap((fn) => returnedValues(fn))) scanValue(value, found)
    }
    follow(found)
  }
  facts.reexports = exported.specifiers
  // A computed key of what becomes the exports may name `__esModule` unless every value its name is given is a
  // constant or a symbol: one with none (a parameter, an import, a global) is unknown, and so is a symbol where
  // the file binds `Symbol` itself.
  const symbolBound = bindingCounts.has('Symbol') || reassigned.has('Symbol')
  const mayName = (name) => {
    const given = [...(declarators.get(name) ?? []), ...(assignments.get(name) ?? [])]
    return given.length === 0 || given.some((value) => {
      const string = stringValue(value)
      return string === undefined ? value.type !== 'Literal' && (symbolBound || !isSymbol(value)) : string === '__esModule'
    })
  }
  if ((exported.symbols && symbolBound) || [...exported.keys].some(mayName)) exported.marked = true
  for (const [name, receiver] of keyMarks) if (names(name, '__esModule')) markReceiver(receiver)
  const fresh = (name) => (objectDecls.get(name) ?? 0) > 0 && objectDecls.get(name) === bindingCounts.get(name) && !reassigned.has(name)
  if (exported.marked || [...pendingMarks].some((name) => !fresh(name) || done.value.has(name) || exported.identifiers.has(name))) {
    facts.setsEsModule = true
  }
  return facts
}
