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
// The globals whose references are resolved by scope.
const GLOBALS = new Set(['Proxy', 'Symbol', 'require'])
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
// A constant property key: a string, or a number as the string it names (`xs[0]`, `{ 0: x }`).
const keyValue = (node) => stringValue(node) ?? (node?.type === 'Literal' && typeof node.value === 'number' ? String(node.value) : undefined)
const nameOf = (node) => (node?.type === 'Identifier' ? node.name : keyValue(node))
const propKey = (key, computed) => (computed ? keyValue(key) : nameOf(key))
// The key a property read names, or undefined where only the runtime knows it.
const staticKey = (member) => propKey(member.property, member.computed)
const isModuleExports = (node) => node?.type === 'MemberExpression' && node.object.type === 'Identifier' &&
  node.object.name === 'module' && (node.computed ? stringValue(node.property) : node.property.name) === 'exports'
const isExportsTarget = (node) => (node?.type === 'Identifier' && node.name === 'exports') || isModuleExports(node)
// `module[key]`: the name of the key, for the caller to resolve once every declaration is in.
const moduleKeyName = (node) => (node?.type === 'MemberExpression' && node.computed && node.object.type === 'Identifier' &&
  node.object.name === 'module' && node.property.type === 'Identifier' ? node.property.name : undefined)
const isRequire = (node) => node.type === 'CallExpression' && node.callee.type === 'Identifier' &&
  node.callee.name === 'require' && node.arguments.length === 1
const requireSpecifier = (node) => (isRequire(node) ? stringValue(node.arguments[0]) : undefined)
// The specifiers a require() argument names, as esbuild splits it (`cond ? './a' : './b'` is both), or null for one
// only the runtime knows (`require(process.env.DEP)`).
const requireSpecifiers = (node) => {
  if (node.type === 'ConditionalExpression') {
    const [consequent, alternate] = [requireSpecifiers(node.consequent), requireSpecifiers(node.alternate)]
    return consequent && alternate ? [...consequent, ...alternate] : null
  }
  const string = stringValue(node)
  return string === undefined ? null : [string]
}

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

// What each name a destructuring pattern binds may get from `value`: the element or property it selects (an
// ElementOf node, keyed by the index or the property's static name), its default, or a rest: an array pattern's
// holds the elements from its position on (a RestOf node), an object pattern's the value itself less some keys.
function patternSources(pattern, value, sources = new Map()) {
  switch (pattern?.type) {
    case 'Identifier':
      sources.set(pattern.name, [...(sources.get(pattern.name) ?? []), value])
      break
    case 'AssignmentPattern':
      patternSources(pattern.left, value, sources)
      patternSources(pattern.left, pattern.right, sources)
      break
    case 'ArrayPattern':
      for (const [index, element] of pattern.elements.entries()) {
        if (element?.type === 'RestElement') patternSources(element.argument, { type: 'RestOf', object: value, from: index }, sources)
        else if (element) patternSources(element, { type: 'ElementOf', object: value, key: String(index) }, sources)
      }
      break
    case 'ObjectPattern': {
      const keyOf = (prop) => propKey(prop.key, prop.computed)
      for (const prop of pattern.properties) {
        if (prop.type !== 'RestElement') patternSources(prop.value, { type: 'ElementOf', object: value, key: keyOf(prop) }, sources)
        // The rest copies the remaining own properties: none named `__esModule` where the pattern took that key.
        else if (!pattern.properties.some((other) => other.type !== 'RestElement' && keyOf(other) === '__esModule')) patternSources(prop.argument, value, sources)
      }
      break
    }
  }
  return sources
}

// An index past this is any (`[cmd, ...rest] = args` in a loop shifts it each round).
const MAX_INDEX = 64
const arrayIndex = (key) => (typeof key === 'string' && /^(?:0|[1-9]\d*)$/u.test(key) ? Number(key) : undefined)

// The values an array or object literal holds for what a pattern or property read takes from it: the property
// `key` names (every one where it's undefined), an array's element at that index (or past one where a spread
// before it shifts it), a property whose computed key or a spread that may be it, what a getter returns, what a
// `__proto__:` prototype holds, and a class's static; a name's are the caller's to follow (out.elements).
function elementsOf(node, out, key) {
  switch (node?.type) {
    case 'ArrayExpression': {
      const index = arrayIndex(key)
      if (key !== undefined && index === undefined) return []  // `length`, a method: not an element
      const values = []
      let fixed = 0
      let spread = false
      for (const element of node.elements) {
        if (element?.type === 'SpreadElement') {
          if (index === undefined || fixed <= index) values.push(...elementsOf(element.argument, out, undefined))
          spread = true
          continue
        }
        if (element && (index === undefined || (spread ? fixed <= index : fixed === index))) values.push(element)
        fixed++
      }
      return values
    }
    case 'RestOf': {
      // An array pattern's rest holds the source's elements from its position on.
      const index = arrayIndex(key)
      if (key !== undefined && index === undefined) return []
      return elementsOf(node.object, out, index === undefined || node.from + index > MAX_INDEX ? undefined : String(node.from + index))
    }
    case 'ObjectExpression':
      return node.properties.flatMap((prop) => {
        if (prop.type === 'SpreadElement') return elementsOf(prop.argument, out, key)
        const name = propKey(prop.key, prop.computed)
        if (!prop.computed && !prop.shorthand && !prop.method && prop.kind === 'init' && name === '__proto__') return elementsOf(prop.value, out, key)
        if (key !== undefined && name !== undefined && name !== key) return []
        return prop.kind === 'get' ? returnedValues(prop.value) : prop.kind === 'set' ? [] : [prop.value]
      })
    case 'ElementOf':
      return elementsOf(node.object, out, node.key).flatMap((element) => elementsOf(element, out, key))
    // A read off a read (`({ inner: { … } }).inner.load`) resolves where the first one lands on a literal; through a
    // name (`h.inner.load`) it isn't followed: a name stands for every declaration of it in the file, and a chain of
    // keys through a bundle's names multiplies past what a build can wait for.
    case 'MemberExpression':
      return elementsOf(node.object, { elements: [] }, staticKey(node)).flatMap((element) => elementsOf(element, out, key))
    case 'ClassExpression':
    case 'ClassDeclaration':
      // A class's statics, and its superclass's, which it inherits.
      return [...node.body.body.flatMap((member) => {
        if (!member.static || !('key' in member)) return []
        const name = propKey(member.key, member.computed)
        if (key !== undefined && name !== undefined && name !== key) return []
        return member.kind === 'get' ? returnedValues(member.value) : member.kind === 'set' || member.value == null ? [] : [member.value]
      }), ...elementsOf(node.superClass, out, key)]
    case 'ConditionalExpression':
      return [...elementsOf(node.consequent, out, key), ...elementsOf(node.alternate, out, key)]
    case 'LogicalExpression':
      return [...elementsOf(node.left, out, key), ...elementsOf(node.right, out, key)]
    case 'Identifier':
      out.elements.push([node.name, key])
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


// The properties an assignment target writes: the target itself, or a destructuring pattern's members.
function patternMembers(pattern, members = []) {
  switch (pattern?.type) {
    case 'MemberExpression':
      members.push(pattern)
      break
    case 'ObjectPattern':
      for (const prop of pattern.properties) patternMembers(prop.type === 'RestElement' ? prop.argument : prop.value, members)
      break
    case 'ArrayPattern':
      for (const element of pattern.elements) patternMembers(element, members)
      break
    case 'AssignmentPattern':
      patternMembers(pattern.left, members)
      break
    case 'RestElement':
      patternMembers(pattern.argument, members)
      break
  }
  return members
}

// A constant `__esModule` key: a string (`'__es' + 'Module'` folded at the top of the concatenation only, as a
// part of one names something else), or the name in a property, member or JSX attribute position.
function isEsModuleToken(node, parent) {
  switch (node.type) {
    case 'Identifier':
    case 'JSXIdentifier':
      return node.name === '__esModule'
    case 'Literal':
    case 'TemplateLiteral':
    case 'BinaryExpression':
      return (node.type !== 'BinaryExpression' || node.operator === '+') && !(parent?.type === 'BinaryExpression' && parent.operator === '+') &&
        stringValue(node) === '__esModule'
    default:
      return false
  }
}

// Whether a constant `__esModule` key (isEsModuleToken) may define the key on something, wherever that goes (a
// fail-safe: no value flow is followed): a property write (context.writeTargets), an object literal's or a class's
// member that isn't falsy or a setter alone (a descriptor map's included), a JSX attribute, any call's argument --
// a callee's semantics aren't checked: a read builtin handed a Proxy runs its trap with the key, and a function
// handed a falsy descriptor may define what it likes -- and a string anywhere it can flow from (`const key =
// '__esModule'`). A read, a comparison, a `case`, a destructuring pattern's key and a variable's name don't.
function definesEsModule(node, parent, key, grandparent, context) {
  const string = node.type !== 'Identifier' && node.type !== 'JSXIdentifier'
  switch (parent?.type) {
    case 'MemberExpression':
      return key === 'property' && (string || !parent.computed) && context.writeTargets.has(parent)
    case 'Property':
      if (key !== 'key') return string
      if (!string && parent.computed) return false
      if (grandparent?.type === 'ObjectPattern') return false
      return parent.kind === 'get' || (parent.kind === 'init' && (parent.method || !isFalsy(parent.value)))
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'AccessorProperty':
      if (key !== 'key') return string
      if (!string && parent.computed) return false
      return parent.type === 'MethodDefinition' ? parent.kind !== 'set' : parent.value != null && !isFalsy(parent.value)
    case 'CallExpression':
    case 'NewExpression':
      return key === 'arguments'
    case 'JSXAttribute':
    case 'TSEnumMember':
    case 'TSParameterProperty':  // `constructor(public __esModule)` sets it on the instance
      return true
    case 'AssignmentPattern':
      return key === 'left' && grandparent?.type === 'TSParameterProperty'  // the argument replaces a default
    case 'BinaryExpression':
    case 'UnaryExpression':
    case 'SwitchCase':
    case 'ExpressionStatement':
    case 'ImportDeclaration':
    case 'ImportExpression':
    case 'ImportSpecifier':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportSpecifier':
    case 'ImportAttribute':
      return false
    default:
      return string
  }
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

// Whether a class's static (or else instance and prototype) members' computed keys may put `__esModule` on what
// they define (a constant one is the token check's): sets out.marked, or collects a key's name for the caller to
// resolve (out.keys).
function scanMembers(cls, statics, out) {
  for (const member of cls.body.body) {
    if (!('key' in member) || Boolean(member.static) !== statics || member.kind === 'set') continue
    if (member.type !== 'MethodDefinition' && (member.value == null || isFalsy(member.value))) continue
    if (member.computed && mayNameEsModule(member.key, out)) out.marked = true
  }
}

// The `Symbol` a symbol expression names (`Symbol.iterator`, `Symbol('x')`), whose scope the caller resolves.
const symbolName = (node) => {
  const name = node?.type === 'MemberExpression' ? node.object : node?.type === 'CallExpression' ? node.callee : undefined
  return name?.type === 'Identifier' && name.name === 'Symbol' ? name : undefined
}

// Whether a computed key of what becomes the exports may name `__esModule`: a constant compares (`'__es' +
// 'Module'`), another literal can't (`0`), nor can a symbol (`Symbol.iterator`) where `Symbol` is the global
// (the caller's to tell: out.symbols), a name is the caller's to resolve once every declaration is in
// (out.keys), and anything else -- `process.env.KEY`, a call -- may.
function mayNameEsModule(key, out) {
  const string = stringValue(key)
  if (string !== undefined) return string === '__esModule'
  if (key.type === 'Literal') return false
  if (symbolName(key)) {
    out.symbols.add(symbolName(key))
    return false
  }
  if (key.type !== 'Identifier') return true
  out.keys.push(key)
  return false
}

// What an instance of `callee` (`new Box()`) gets from its class and superclasses: instance fields and
// prototype members, and what a constructor returns, which replaces the instance (returned, for the caller to
// scan as values). A class reached by name is the caller's to follow (out.instances); one a require() returns
// is another module's.
// `direct` where callee is what `new` is handed, not a value a name it's handed was given.
function scanInstance(callee, out, direct = true) {
  const returned = []
  for (const leaf of leavesOf(callee)) scanConstructor(leaf, out, returned, direct)
  return returned
}
// One constructor `new` may run: a class and its superclasses, a function, a name to follow -- or the global Proxy,
// whose trap can answer `__esModule`: by its name (the caller decides whether it's the global's: out.proxies), or
// read off an object as `Proxy` (`globalThis.Proxy`), or right at the `new` by a key only the runtime knows. (A name
// is followed into every declaration of it, unrelated ones in a bundle's other scopes included: a runtime key
// there is no sign of a Proxy.)
function scanConstructor(callee, out, returned, direct) {
  if (callee.type === 'MemberExpression') {
    const key = staticKey(callee)
    if (key === 'Proxy' || (direct && key === undefined)) out.marked = true
    return
  }
  // What a destructuring took (`const { Proxy: P } = globalThis`): by its key (or one only the runtime knows,
  // `{ [name]: P }`), or the literal value it selects.
  if (callee.type === 'ElementOf') {
    if (callee.key === 'Proxy' || callee.key === undefined) out.marked = true
    else for (const value of elementsOf(callee.object, { elements: [] }, callee.key)) for (const leaf of leavesOf(value)) scanConstructor(leaf, out, returned, false)
    return
  }
  for (let cls = callee; cls; cls = cls.superClass) {
    if (cls.type === 'Identifier') {
      if (cls.name === 'Proxy') out.proxies.add(cls)
      out.instances.add(cls.name)
      break
    }
    if (FUNCTIONS.has(cls.type)) {
      returned.push(...returnedValues(cls))
      break
    }
    if (cls.type !== 'ClassExpression' && cls.type !== 'ClassDeclaration') break
    scanMembers(cls, false, out)
    const constructor = cls.body.body.find((member) => member.type === 'MethodDefinition' && member.kind === 'constructor')
    if (constructor) returned.push(...returnedValues(constructor.value))
  }
}

// What an expression may evaluate to, for calling or constructing: past a sequence (`(0, fn)`), either branch, a TS
// wrapper, and a bound function (`fn.bind(…)`) to its target.
function leavesOf(node) {
  const found = []
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    switch (current?.type) {
      case undefined:
        break
      case 'SequenceExpression':
        stack.push(current.expressions.at(-1))
        break
      case 'ConditionalExpression':
        stack.push(current.consequent, current.alternate)
        break
      case 'LogicalExpression':
        stack.push(current.left, current.right)
        break
      case 'AssignmentExpression':
        stack.push(current.right)
        break
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'ChainExpression':
        stack.push(current.expression)
        break
      case 'CallExpression':
        if (current.callee.type === 'MemberExpression' && staticKey(current.callee) === 'bind') stack.push(current.callee.object)
        else found.push(current)
        break
      default:
        found.push(current)
    }
  }
  return found
}
// The functions or names of functions among them.
const functionsOf = (node) => leavesOf(node).filter((leaf) => leaf.type === 'Identifier' || FUNCTIONS.has(leaf.type))

// What a call runs: its callee's functions or methods (a MemberExpression), the function `.call`/`.apply` invoke,
// and the one `Reflect.apply` is handed.
function calledFunctions(call) {
  const { callee } = call
  const invoked = callee.type === 'MemberExpression' && ['call', 'apply'].includes(staticKey(callee)) ? [callee.object] : []
  if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'Reflect' &&
    staticKey(callee) === 'apply' && call.arguments[0]) invoked.push(call.arguments[0])
  return [callee, ...invoked].flatMap(leavesOf).filter((leaf) => leaf.type === 'Identifier' || leaf.type === 'MemberExpression' || FUNCTIONS.has(leaf.type))
}

// What calling `object[key]()` returns: what each function that property may hold returns (a method, a getter's
// value, a class's static). A function's name is the caller's to follow (out.callees), and so is a name the
// object may be held by (out.methods).
function methodReturns(object, key, out) {
  const sink = { elements: [] }
  const values = []
  for (const value of elementsOf(object, sink, key)) {
    for (const fn of functionsOf(value)) {
      if (FUNCTIONS.has(fn.type)) values.push(...returnedValues(fn))
      else out.callees.add(fn.name)
    }
  }
  out.methods.push(...sink.elements)
  return values
}

// What can become the value an expression assigns to module.exports (or copies into it): the expression
// itself, either branch of a conditional or logical, the last of a sequence, the end of an assignment chain,
// what a function it calls returns (an IIFE, through `.call`/`.apply`, a bound one), what an object literal
// spreads, a class's superclass, and what a call or `new` is handed (it may return or copy it) -- not an
// object literal's other property values, which only end up nested in the exports. Collects
// `require('<literal>')` specifiers, identifiers, callee names and the classes of instances (followed through
// their declarations and function returns by the caller), and whether a computed key of an object literal, a
// class's static or an instance's member there may be `__esModule` (`out.marked`; a constant one is the token
// check's), or one the caller resolves (`out.keys`: `{ [marker]: true }`).
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
        stack.push(...elementsOf(current.object, out, current.key))
        break
      // A property read (`obj.selected`) takes the value the object holds there, as destructuring does.
      case 'MemberExpression':
        stack.push({ type: 'ElementOf', object: current.object, key: staticKey(current) })
        break
      case 'ChainExpression':
        stack.push(current.expression)
        break
      case 'NewExpression':
        // A Proxy can answer `__esModule` from its trap, which only a bundler-interop read runs (see scanConstructor).
        stack.push(...scanInstance(current.callee, out))
        for (const arg of current.arguments) stack.push(arg.type === 'SpreadElement' ? arg.argument : arg)
        break
      case 'ObjectExpression':
        for (const prop of current.properties) {
          // A spread's properties are the object's own; a `__proto__: value` (not computed, shorthand or a method)
          // sets its prototype, whose properties it inherits.
          if (prop.type === 'SpreadElement') stack.push(prop.argument)
          else if (!prop.computed && !prop.shorthand && !prop.method && prop.kind === 'init' && nameOf(prop.key) === '__proto__') stack.push(prop.value)
          // A setter alone reads as undefined.
          else if (isFalsy(prop.value) || prop.kind === 'set') continue
          else if (prop.computed && mayNameEsModule(prop.key, out)) out.marked = true
        }
        break
      case 'CallExpression': {
        if (isRequire(current)) {
          // Whether `require` is CommonJS's is the caller's to resolve (out.requires).
          out.requires.push([current.callee, requireSpecifiers(current.arguments[0])])
          break
        }
        for (const fn of calledFunctions(current)) {
          if (FUNCTIONS.has(fn.type)) stack.push(...returnedValues(fn))
          else if (fn.type === 'Identifier') out.callees.add(fn.name)
          else stack.push(...methodReturns(fn.object, staticKey(fn), out))
        }
        // `Reflect.construct(target, args)` is `new target(...args)`.
        if (current.callee.type === 'MemberExpression' && current.callee.object.type === 'Identifier' && current.callee.object.name === 'Reflect' &&
          staticKey(current.callee) === 'construct' && current.arguments[0]) stack.push(...scanInstance(current.arguments[0], out))
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
//   setsEsModule  something that may mark the exports __esModule: a constant `__esModule` key anywhere it may be
//               defined on something (fail-safe: where the value goes isn't followed; a read, a comparison or a
//               falsy value doesn't count), or a key in what becomes the exports that may be `__esModule` at
//               runtime (a computed one, a Proxy's trap, a require() only the runtime resolves)
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
  // Scopes binding the names whose references are resolved: `module`/`exports` (CommonJS use), the GLOBALS,
  // and imported locals (whether the code reads the import). At the module scope an
  // import/let/const/function/class shadows the CommonJS binding for every reference, while a `var` merges
  // with it; a nested scope just binds the name.
  const root = { names: new Set(), parent: null }
  const shadowed = new Set()
  const hoistedVar = new Set()
  const references = []  // [name, scope]
  const globalRefs = new Map()  // Identifier node of one of the GLOBALS -> its scope
  const scoped = new Set(['module', 'exports', 'require', 'Proxy', 'Symbol', 'arguments'])
  const topArguments = []  // scopes of `arguments` references outside any function of their own
  for (const statement of parsed.program.body) {
    if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue
    for (const spec of statement.specifiers) if (spec.importKind !== 'type') scoped.add(spec.local.name)
  }
  const tracked = (name) => scoped.has(name)
  // Every name a nested scope declares is recorded (a computed key resolves through them); at the module scope,
  // only the tracked ones.
  const declare = (scope, name, kind) => {
    if (scope !== root) {
      scope.names.add(name)
      if (kind === 'param') (scope.params ??= new Set()).add(name)
    } else if (tracked(name)) (kind === 'var' ? hoistedVar : shadowed).add(name)
  }
  const keyRefs = new Map()  // computed key Identifier node -> its scope
  const declarators = new Map()  // name -> [init]: a declarator's, or the class a class declaration binds
  const functionDecls = new Map()  // name -> [FunctionDeclaration]
  // What a call may copy into a local it's handed first (`Object.assign(out, src)`): it reaches the exports if out does.
  const copies = new Map()  // name -> [argument]
  const assignments = new Map()  // name -> [assigned value]: `out = value` (destructuring: the whole right side)
  // A property set on a local (`h.load = fn`): what a read or a call of that key gets.
  const memberWrites = new Map()  // name -> [[key, or undefined for one only the runtime knows, value]]
  const writtenAt = (name, key) => (memberWrites.get(name) ?? []).filter(([written]) => key === undefined || written === undefined || written === key).map(([, value]) => value)
  const reassigned = new Set()
  // Where a constant `__esModule` key may be defined (see definesEsModule): the properties writes target. A write
  // of a key whose value isn't known doesn't count, unlike a computed key in what becomes the exports: dynamic
  // writes run all over CommonJS, the exports included (fs-extra's `exports[method] = u(fs[method])` loop).
  const tokenContext = { writeTargets: new Set() }
  const keyedWrites = []  // [key name, values]: written to (or copied into) `module[key]`, the exports where key is 'exports'
  const exported = { specifiers: new Set(), identifiers: new Set(), callees: new Set(), instances: new Set(), elements: [], methods: [], keys: [], symbols: new Set(), proxies: new Set(), requires: [], marked: false }
  // Writes to the exports: [`exports` or `module`, the scope of the write, the values], counted where the name is
  // CommonJS's there or a parameter (a UMD factory's `module`), not a local of its own (`let exports`).
  const exportWrites = []
  // Imported bindings, whose references say whether they're used: an unused one is dropped by tree shaking, so
  // its value is never observed (the import's evaluation stays).
  const importBindings = []  // [specifier, local, interop]
  let directEval = false

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
    if (!facts.setsEsModule && isEsModuleToken(node, parent) && definesEsModule(node, parent, key, grandparent, tokenContext)) facts.setsEsModule = true
    switch (node.type) {
      case 'ImportDeclaration':
        if (node.importKind === 'type') continue
        facts.esmImports = true
        if (node.specifiers.length === 0) useImport(node.source.value, {})
        for (const spec of node.specifiers) {
          if (spec.importKind === 'type') continue
          const interop = spec.type !== 'ImportSpecifier' || nameOf(spec.imported) === 'default' || node.phase != null
          useImport(node.source.value, {})
          importBindings.push([node.source.value, spec.local.name, interop])
          declare(root, spec.local.name, 'import')
        }
        break
      case 'ExportNamedDeclaration':
        facts.esmExports = true
        // `export { local }` reads the local, at the module scope.
        if (!node.source) for (const spec of node.specifiers) if (tracked(nameOf(spec.local))) references.push([nameOf(spec.local), root])
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
      case 'JSXIdentifier':
        // A value reference: a capitalized tag name, or the object of a member tag (`<a.b>`); a lowercase tag is an
        // intrinsic element's string, and attribute and member-property names aren't references.
        if (tracked(node.name) && ((key === 'name' && (parent.type === 'JSXOpeningElement' || parent.type === 'JSXClosingElement') &&
          /^[A-Z_$]/u.test(node.name)) || (key === 'object' && parent.type === 'JSXMemberExpression'))) references.push([node.name, scope])
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
        if (node.callee.type === 'Identifier' && node.callee.name === 'eval' && !node.optional) {
          cjsCertain ??= 'a direct `eval`'
          directEval = true
        }
        const required = requireSpecifier(node)
        if (required !== undefined) {
          const consumed = !(parent?.type === 'ExpressionStatement' && key === 'expression')
          facts.requires.set(required, { consumed: consumed || (facts.requires.get(required)?.consumed ?? false) })
        }
        // Object.defineProperties(target, { key: descriptor, ... }) copies no values in: its map holds descriptors.
        if (node.callee.type === 'MemberExpression' && staticKey(node.callee) === 'defineProperties' && node.arguments[1]?.type === 'ObjectExpression' &&
          node.arguments[1].properties.every((prop) => prop.type === 'Property' && !prop.computed)) break
        if (node.arguments[0]?.type === 'Identifier' && !isExportsTarget(node.arguments[0]) && node.arguments.length > 1) {
          const [{ name }, ...rest] = node.arguments
          copies.set(name, [...(copies.get(name) ?? []), ...rest.map((arg) => (arg.type === 'SpreadElement' ? arg.argument : arg))])
        }
        // Copying into the exports: Object.assign(module.exports, require(x)), __exportStar(require(x), exports),
        // Object.defineProperties(exports, { __esModule: ... }).
        const exportsArg = node.arguments.find(isExportsTarget)
        if (exportsArg) exportWrites.push([exportsArg.type === 'Identifier' ? 'exports' : 'module', scope, node.arguments.filter((arg) => !isExportsTarget(arg))])
        for (const arg of node.arguments) {
          const name = moduleKeyName(arg)
          if (name !== undefined) keyedWrites.push([name, node.arguments.filter((other) => other !== arg)])
        }
        break
      }
      case 'UpdateExpression':
        // `exports.__esModule++` makes a falsy mark truthy (0 → 1).
        if (node.argument.type === 'MemberExpression') tokenContext.writeTargets.add(node.argument)
        break
      case 'AssignmentExpression':
        // A property it writes (but `= <falsy>`), destructuring targets included (`[exports.__esModule] = [true]`).
        if (!(node.operator === '=' && isFalsy(node.right))) for (const target of patternMembers(node.left)) tokenContext.writeTargets.add(target)
        if (node.left.type === 'MemberExpression' && node.left.object.type === 'Identifier') {
          const { name } = node.left.object
          if (!memberWrites.has(name)) memberWrites.set(name, [])
          memberWrites.get(name).push([staticKey(node.left), node.right])
        }
        for (const [name, values] of patternSources(node.left, node.right)) {
          reassigned.add(name)
          assignments.set(name, [...(assignments.get(name) ?? []), ...values])
        }
        if (isExportsTarget(node.left)) exportWrites.push([node.left.type === 'Identifier' ? 'exports' : 'module', scope, [node.right]])
        else if (moduleKeyName(node.left) !== undefined) keyedWrites.push([moduleKeyName(node.left), [node.right]])  // module[key] = value
        // `exports.__proto__ = proto` sets the prototype, whose properties the exports inherit; set on a local, it
        // reaches the exports if the local does.
        if (node.operator === '=' && node.left.type === 'MemberExpression' &&
          (node.left.computed ? stringValue(node.left.property) : nameOf(node.left.property)) === '__proto__') {
          const { object } = node.left
          if (isExportsTarget(object)) exportWrites.push([object.type === 'Identifier' ? 'exports' : 'module', scope, [node.right]])
          else if (object.type === 'Identifier') copies.set(object.name, [...(copies.get(object.name) ?? []), node.right])
        }
        break
      case 'VariableDeclarator':
        if (node.id.type === 'Identifier' && node.init) {
          declarators.set(node.id.name, [...(declarators.get(node.id.name) ?? []), node.init])
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
        // `for (o of xs)` assigns o, as `o = x` does (`for (exports.__esModule of [true])` the property).
        if (node.left && node.left.type !== 'VariableDeclaration') {
          for (const name of patternNames(node.left)) reassigned.add(name)
          for (const target of patternMembers(node.left)) tokenContext.writeTargets.add(target)
        }
        childScope = { names: new Set(), parent: scope }
        break
      case 'SwitchStatement':
      case 'TSModuleBlock':
        childScope = { names: new Set(), parent: scope }
        break
      case 'Identifier':
        if (parent && !isNonReference(parent, key)) {
          if (key === 'key' && parent.computed) keyRefs.set(node, scope)
          if (!binding && tracked(node.name)) {
            references.push([node.name, scope])
            if (GLOBALS.has(node.name)) globalRefs.set(node, scope)
            if (node.name === 'arguments' && thisDepth === 0) topArguments.push(scope)
          }
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

  // Whether a reference reaches the module scope, no scope around it binding the name (all declarations are in
  // by now, so hoisting is covered). There, a `module`/`exports` one is CommonJS use unless a shadowing
  // declaration binds it; one of the GLOBALS is the global's unless any declaration does.
  const reachesModuleScope = (name, scope) => {
    for (let current = scope; current !== root; current = current.parent) if (current.names.has(name)) return false
    return true
  }
  // A module-scope `var` of the name binds its own, `require` included: esbuild renames that one (`require2`, undefined
  // without a value) and bundles no call of it.
  const isGlobal = (node) => globalRefs.has(node) && reachesModuleScope(node.name, globalRefs.get(node)) &&
    !shadowed.has(node.name) && !hoistedVar.has(node.name)
  const commonjs = (name) => name === 'module' || name === 'exports'
  // A top-level `arguments` is the module wrapper's unless a lexical declaration binds the name (`const
  // arguments`); a `var` of it in the wrapper's body is the arguments object itself.
  facts.topArguments = topArguments.some((scope) => reachesModuleScope('arguments', scope)) && !shadowed.has('arguments')
  const free = references.find(([name, scope]) => commonjs(name) && reachesModuleScope(name, scope) && !shadowed.has(name))?.[0] ??
    [...hoistedVar].find(commonjs)
  if (cjsCertain !== null) {
    facts.cjsUsage = 'yes'
    facts.cjsDetail = cjsCertain
  } else if (free !== undefined) {
    facts.cjsUsage = 'yes'
    facts.cjsDetail = `\`${free}\``
  }

  // An imported binding the code reads (or every one, past a direct eval) observes the import's value.
  const read = new Set(references.filter(([name, scope]) => reachesModuleScope(name, scope)).map(([name]) => name))
  for (const [specifier, local, interop] of importBindings) {
    if (directEval || read.has(local)) useImport(specifier, { bindings: true, interop })
  }

  // Follow what becomes module.exports through declarations and assignments (`const lib = require('./lib');
  // module.exports = lib`), the returns of local functions it calls (`module.exports = load()`) and the local
  // classes of instances it constructs (`module.exports = new Box()`), transitively.
  // A computed key names the string a declaration or assignment of that name gives it.
  const names = (name, string) => [...(declarators.get(name) ?? []), ...(assignments.get(name) ?? [])].some((value) => stringValue(value) === string)
  // A parameter of the name is taken for the CommonJS object handed in (a UMD factory's `module`), a declaration
  // for a local of its own (`let exports`).
  const isCommonJS = (name, scope) => {
    for (let current = scope; current !== root; current = current.parent) {
      if (current.names.has(name)) return current.params?.has(name) ?? false
    }
    return !shadowed.has(name)
  }
  for (const [name, at, values] of exportWrites) {
    if (!isCommonJS(name, at)) continue
    for (const value of values) scanValue(value.type === 'SpreadElement' ? value.argument : value, exported)
  }
  for (const [name, written] of keyedWrites) {
    if (!names(name, 'exports')) continue
    for (const value of written) scanValue(value.type === 'SpreadElement' ? value.argument : value, exported)
  }
  const done = { value: new Set(), call: new Set(), instance: new Set(), elements: new Set(), method: new Set() }
  const pending = []
  const follow = (found) => {
    for (const identifier of found.identifiers) pending.push(['value', identifier])
    for (const callee of found.callees) pending.push(['call', callee])
    for (const cls of found.instances) pending.push(['instance', cls])
    for (const [name, key] of found.elements) pending.push(['elements', name, key])
    for (const [name, key] of found.methods) pending.push(['method', name, key])
    if (found.marked) exported.marked = true
    for (const name of found.symbols) exported.symbols.add(name)
    for (const name of found.proxies) exported.proxies.add(name)
  }
  follow(exported)
  while (pending.length > 0) {
    const [kind, name, key] = pending.pop()
    const id = kind === 'elements' || kind === 'method' ? `${name}\u0000${key ?? '*'}` : name
    if (done[kind].has(id)) continue
    done[kind].add(id)
    const inits = declarators.get(name) ?? []
    const assigned = assignments.get(name) ?? []
    const found = { specifiers: exported.specifiers, identifiers: new Set(), callees: new Set(), instances: new Set(), elements: [], methods: [], keys: exported.keys, symbols: new Set(), proxies: new Set(), requires: exported.requires, marked: false }
    if (kind === 'value') for (const origin of [...inits, ...assigned, ...(copies.get(name) ?? [])]) scanValue(origin, found)
    else if (kind === 'instance') {
      for (const origin of [...(functionDecls.get(name) ?? []), ...inits, ...assigned]) for (const value of scanInstance(origin, found, false)) scanValue(value, found)
    }
    else if (kind === 'elements') {
      for (const origin of [...inits, ...assigned]) for (const value of elementsOf(origin, found, key)) scanValue(value, found)
      for (const value of writtenAt(name, key)) scanValue(value, found)
    } else if (kind === 'method') {
      for (const origin of [...inits, ...assigned, ...(copies.get(name) ?? [])]) for (const value of methodReturns(origin, key, found)) scanValue(value, found)
      for (const fn of writtenAt(name, key).flatMap(functionsOf)) {
        if (FUNCTIONS.has(fn.type)) for (const value of returnedValues(fn)) scanValue(value, found)
        else found.callees.add(fn.name)
      }
    }
    else {
      for (const fn of [...(functionDecls.get(name) ?? []), ...[...inits, ...assigned].flatMap(functionsOf)]) {
        if (FUNCTIONS.has(fn.type)) for (const value of returnedValues(fn)) scanValue(value, found)
        else found.callees.add(fn.name)  // an alias (`const load = make`)
      }
    }
    follow(found)
  }
  // A require() is CommonJS's where `require` is the free binding (a bundle's own `require` parameter is another
  // function): a literal one re-exports its target, one only the runtime resolves hands over exports this check
  // can't read.
  for (const [callee, specifiers] of exported.requires) {
    if (!isGlobal(callee)) continue
    if (specifiers) for (const specifier of specifiers) exported.specifiers.add(specifier)
    else exported.marked = true
  }
  facts.reexports = exported.specifiers
  // A computed key of what becomes the exports may name `__esModule` unless every value its name is given is a
  // constant or a symbol: one with none (a parameter, an import, a global) is unknown, and so is a symbol where
  // the file binds `Symbol` itself.
  const isSymbol = (value) => symbolName(value) !== undefined && isGlobal(symbolName(value)) && !reassigned.has('Symbol')
  const mayName = (name) => {
    const given = [...(declarators.get(name) ?? []), ...(assignments.get(name) ?? [])]
    return given.length === 0 || given.some((value) => {
      const string = stringValue(value)
      return string === undefined ? value.type !== 'Literal' && !isSymbol(value) : string === '__esModule'
    })
  }
  const unknownSymbol = [...exported.symbols].some((name) => !isGlobal(name) || reassigned.has('Symbol'))
  // A computed key named by a parameter is unknown; one any other binding names, judged by the values it's given.
  const mayNameKey = (node) => {
    for (let current = keyRefs.get(node); current && current !== root; current = current.parent) {
      if (current.names.has(node.name)) {
        if (current.params?.has(node.name)) return true
        break
      }
    }
    return mayName(node.name)
  }
  if (unknownSymbol || [...exported.proxies].some(isGlobal) || exported.keys.some(mayNameKey)) exported.marked = true
  if (exported.marked) facts.setsEsModule = true
  return facts
}
