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
  return undefined
}
const nameOf = (node) => (node?.type === 'Identifier' ? node.name : stringValue(node))
const isModuleExports = (node) => node?.type === 'MemberExpression' && node.object.type === 'Identifier' &&
  node.object.name === 'module' && (node.computed ? stringValue(node.property) : node.property.name) === 'exports'
const isExportsTarget = (node) => (node?.type === 'Identifier' && node.name === 'exports') || isModuleExports(node)
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

function isBinding(parent, key, grandparent) {
  switch (parent.type) {
    case 'VariableDeclarator':
      return key === 'id'
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return key === 'id' || key === 'params'
    case 'ClassDeclaration':
    case 'ClassExpression':
    case 'CatchClause':
      return key === 'id' || key === 'param'
    case 'AssignmentPattern':
      return key === 'left'
    case 'RestElement':
    case 'ArrayPattern':
      return true
    case 'Property':
      return key === 'value' && grandparent?.type === 'ObjectPattern'
    default:
      return false
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

// Whether a statement list opens with a "use strict" directive.
function hasUseStrict(statements) {
  for (const statement of statements) {
    if (statement.type !== 'ExpressionStatement' || typeof statement.directive !== 'string') return false
    if (statement.directive === 'use strict') return true
  }
  return false
}

// The values a function returns: its expression body, or each `return` outside nested functions.
function returnedValues(fn) {
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

// What can become the value an expression assigns to module.exports (or copies into it): the expression
// itself, either branch of a conditional or logical, the last of a sequence, the end of an assignment chain,
// what an IIFE returns, what an object literal spreads, and what a call is handed (it may return or copy
// it) -- not an object literal's other property values, which only end up nested in the exports. Collects
// `require('<literal>')` specifiers, identifiers (followed through their declarations by the caller), and
// whether an object literal there has an `__esModule` key (`out.marked`).
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
      case 'ObjectExpression':
        for (const prop of current.properties) {
          if (prop.type === 'SpreadElement') stack.push(prop.argument)
          else if ((prop.computed ? stringValue(prop.key) : nameOf(prop.key)) === '__esModule') out.marked = true
        }
        break
      case 'CallExpression': {
        const spec = requireSpecifier(current)
        if (spec !== undefined) {
          out.specifiers.add(spec)
          break
        }
        if (FUNCTIONS.has(current.callee.type)) stack.push(...returnedValues(current.callee))
        for (const arg of current.arguments) stack.push(arg.type === 'SpreadElement' ? arg.argument : arg)
        break
      }
    }
  }
}

// -> null for contents esbuild doesn't parse as JS/TS, else:
//   esmExports  an export (type-only included), import.meta or top-level await: ESM whatever the package type
//   esmImports  a static value import statement
//   cjsUsage    'yes' | 'no' | 'maybe': whether esbuild would see CommonJS use (a free module/exports, top-level
//               this/return, direct eval, TS `export =`); 'maybe' when a module/exports reference might be bound by a
//               nested declaration. A module-scope import/let/const/function/class of the name binds every reference
//               to it; a module-scope `var` doesn't (esbuild merges it with the CommonJS one)
//   cjsDetail   what that use is, for messages
//   strictOnly  why the file is valid only as a sloppy-mode script (null if it parses as a module)
//   blockFunction  a function declared in a nested block of sloppy-mode code (hoisted differently than in strict)
//   imports     Map specifier -> { bindings, interop }: whether a static import/re-export of it observes its
//               exports at all, and whether through its default export or namespace (where interop decides the value)
//   setsEsModule  something that may mark the exports __esModule: an `__esModule` assignment or defineProperty on any
//               object (bundled output names its exports arbitrarily), an `__esModule` key in a literal that becomes them
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
    esmExports: false, esmImports: false, cjsUsage: 'no', cjsDetail: null, strictOnly, blockFunction: false,
    imports: new Map(), setsEsModule: false, reexports: new Set(), parseError,
  }
  const useImport = (specifier, { bindings = false, interop = false }) => {
    const prior = facts.imports.get(specifier) ?? { bindings: false, interop: false }
    facts.imports.set(specifier, { bindings: prior.bindings || bindings || interop, interop: prior.interop || interop })
  }
  let cjsCertain = null
  // `module`/`exports`: referenced, bound at module scope (shadowing every reference), declared as a
  // module-scope `var` (merged with the CommonJS binding), or declared in a nested scope.
  const referenced = new Set()
  const shadowed = new Set()
  const hoistedVar = new Set()
  const nested = new Set()
  const shadow = (name) => (name === 'module' || name === 'exports') && shadowed.add(name)
  const declarators = new Map()  // name -> [init]
  const exported = { specifiers: new Set(), identifiers: new Set(), marked: false }

  // Iterative: minified code nests deeper than the call stack allows. fnDepth counts every function
  // (return/await scope), thisDepth only those with their own `this` (non-arrow functions, class bodies);
  // strict is whether the code around the node is strict-mode (a directive, a class).
  const stack = [[parsed.program, null, null, null, 0, 0, hasUseStrict(parsed.program.body)]]
  while (stack.length > 0) {
    const [node, parent, key, grandparent, fnDepth, thisDepth, strict] = stack.pop()
    if (TYPE_ONLY.has(node.type) || node.declare) continue
    switch (node.type) {
      case 'ImportDeclaration':
        if (node.importKind === 'type') continue
        facts.esmImports = true
        if (node.specifiers.length === 0) useImport(node.source.value, {})
        for (const spec of node.specifiers) {
          if (spec.importKind === 'type') continue
          const interop = spec.type !== 'ImportSpecifier' || nameOf(spec.imported) === 'default' || node.phase != null
          useImport(node.source.value, { bindings: true, interop })
          shadow(spec.local.name)
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
      case 'ForOfStatement':
        if (node.await && fnDepth === 0) facts.esmExports = true
        break
      case 'VariableDeclaration': {
        if (node.kind === 'await using' && fnDepth === 0) facts.esmExports = true
        const names = node.declarations.flatMap((declarator) => patternNames(declarator.id))
        if (node.kind === 'var' && fnDepth === 0) {
          for (const name of names) if (name === 'module' || name === 'exports') hoistedVar.add(name)
        } else if (parent?.type === 'Program') {
          for (const name of names) shadow(name)
        }
        break
      }
      case 'ClassDeclaration':
        if (parent?.type === 'Program' && node.id) shadow(node.id.name)
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
      case 'CallExpression':
        if (node.callee.type === 'Identifier' && node.callee.name === 'eval' && !node.optional) cjsCertain ??= 'a direct `eval`'
        // defineProperty-style: (target, '__esModule', descriptor), aliases included (esbuild's __defProp).
        if (node.arguments.length >= 3 && stringValue(node.arguments[1]) === '__esModule') facts.setsEsModule = true
        // Copying into the exports: Object.assign(module.exports, require(x)), __exportStar(require(x), exports),
        // Object.defineProperties(exports, { __esModule: ... }).
        if (node.arguments.some(isExportsTarget)) {
          for (const arg of node.arguments) if (!isExportsTarget(arg)) scanValue(arg, exported)
        }
        break
      case 'AssignmentExpression':
        if (node.left.type === 'MemberExpression' &&
          (node.left.computed ? stringValue(node.left.property) : node.left.property.name) === '__esModule') facts.setsEsModule = true
        if (isExportsTarget(node.left)) scanValue(node.right, exported)
        break
      case 'VariableDeclarator':
        if (node.id.type === 'Identifier' && node.init) declarators.set(node.id.name, [...(declarators.get(node.id.name) ?? []), node.init])
        break
      case 'FunctionDeclaration': {
        if (parent?.type === 'Program' && node.id) shadow(node.id.name)
        const inFunctionBody = parent?.type === 'BlockStatement' && key === 'body' && FUNCTIONS.has(grandparent?.type)
        if (!strict && !inFunctionBody &&
          !['Program', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'TSModuleBlock', 'StaticBlock'].includes(parent?.type)) {
          facts.blockFunction = true
        }
        break
      }
      case 'Identifier':
        if ((node.name === 'module' || node.name === 'exports') && parent && !isNonReference(parent, key)) {
          if (isBinding(parent, key, grandparent)) nested.add(node.name)
          else referenced.add(node.name)
        }
        break
    }
    const ownsThis = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassBody'
    const childFnDepth = FUNCTIONS.has(node.type) ? fnDepth + 1 : fnDepth
    const childThisDepth = ownsThis ? thisDepth + 1 : thisDepth
    const childStrict = strict || node.type === 'ClassDeclaration' || node.type === 'ClassExpression' ||
      (FUNCTIONS.has(node.type) && node.body?.type === 'BlockStatement' && hasUseStrict(node.body.body))
    for (const [child, childKey] of children(node)) stack.push([child, node, childKey, parent, childFnDepth, childThisDepth, childStrict])
  }

  const used = ['module', 'exports'].filter((name) => !shadowed.has(name) && (referenced.has(name) || hoistedVar.has(name)))
  // Free for sure: never declared in a nested scope, or merged into the CommonJS binding by a module-scope `var`.
  const free = used.find((name) => hoistedVar.has(name) || !nested.has(name))
  if (cjsCertain !== null) {
    facts.cjsUsage = 'yes'
    facts.cjsDetail = cjsCertain
  } else if (used.length > 0) {
    facts.cjsUsage = free ? 'yes' : 'maybe'
    facts.cjsDetail = `\`${free ?? used[0]}\``
  }

  // Follow identifiers assigned to module.exports through their declarations (`const lib = require('./lib');
  // module.exports = lib`), transitively.
  const seen = new Set()
  const pending = [...exported.identifiers]
  while (pending.length > 0) {
    const name = pending.pop()
    if (seen.has(name)) continue
    seen.add(name)
    for (const init of declarators.get(name) ?? []) {
      const found = { specifiers: exported.specifiers, identifiers: new Set(), marked: false }
      scanValue(init, found)
      pending.push(...found.identifiers)
      if (found.marked) exported.marked = true
    }
  }
  facts.reexports = exported.specifiers
  if (exported.marked) facts.setsEsModule = true
  return facts
}
