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

// Every `require('<literal>')` in `node`'s subtree, plus the identifiers it references, without entering
// a function body unless the function is called right there (an IIFE): a require inside a function that
// runs later doesn't produce the value being assigned.
function scanValue(node, out) {
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.pop()
    const spec = requireSpecifier(current)
    if (spec !== undefined) out.specifiers.add(spec)
    if (current.type === 'Identifier') out.identifiers.add(current.name)
    if (FUNCTIONS.has(current.type) || current.type === 'ClassBody') continue
    if (current.type === 'CallExpression' && FUNCTIONS.has(current.callee.type)) stack.push(current.callee.body)
    for (const [child] of children(current)) stack.push(child)
  }
}

// -> null for contents esbuild doesn't parse as JS/TS, else:
//   esmExports  an export (type-only included), import.meta or top-level await: ESM whatever the package type
//   esmImports  a static value import statement
//   cjsUsage    'yes' | 'no' | 'maybe': whether esbuild would see CommonJS use (a free module/exports, top-level
//               this/return, direct eval, TS `export =`); 'maybe' when a module/exports reference might be bound locally
//   cjsDetail   what that use is, for messages
//   strictOnly  why the file is valid only as a sloppy-mode script (null if it parses as a module)
//   blockFunction  a function declared in a nested block (hoisted differently in sloppy mode)
//   imports     Map specifier -> { bindings, interop }: whether a static import/re-export of it observes its
//               exports at all, and whether through its default export or namespace (where interop decides the value)
//   setsEsModule  something that marks an exports object __esModule
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
  let cjsReference = null
  let declaresModuleOrExports = false
  const declarators = new Map()  // name -> [init]
  const exported = { specifiers: new Set(), identifiers: new Set() }

  // Iterative: minified code nests deeper than the call stack allows. fnDepth counts every function
  // (return/await scope), thisDepth only those with their own `this` (non-arrow functions, class bodies).
  const stack = [[parsed.program, null, null, null, 0, 0]]
  while (stack.length > 0) {
    const [node, parent, key, grandparent, fnDepth, thisDepth] = stack.pop()
    if (TYPE_ONLY.has(node.type)) continue
    switch (node.type) {
      case 'ImportDeclaration':
        if (node.importKind === 'type') continue
        facts.esmImports = true
        if (node.specifiers.length === 0) useImport(node.source.value, {})
        for (const spec of node.specifiers) {
          if (spec.importKind === 'type') continue
          const interop = spec.type !== 'ImportSpecifier' || nameOf(spec.imported) === 'default' || node.phase != null
          useImport(node.source.value, { bindings: true, interop })
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
      case 'VariableDeclaration':
        if (node.kind === 'await using' && fnDepth === 0) facts.esmExports = true
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
        // Copying into the exports: Object.assign(module.exports, require(x)), __exportStar(require(x), exports).
        if (node.arguments.some(isExportsTarget)) {
          for (const arg of node.arguments) if (!isExportsTarget(arg)) scanValue(arg, exported)
        }
        break
      case 'AssignmentExpression':
        if (node.left.type === 'MemberExpression' &&
          (node.left.computed ? stringValue(node.left.property) : node.left.property.name) === '__esModule') facts.setsEsModule = true
        if (isExportsTarget(node.left)) scanValue(node.right, exported)
        break
      case 'Property':
        if (parent?.type === 'ObjectExpression' && (node.computed ? stringValue(node.key) : nameOf(node.key)) === '__esModule') facts.setsEsModule = true
        break
      case 'VariableDeclarator':
        if (node.id.type === 'Identifier' && node.init) declarators.set(node.id.name, [...(declarators.get(node.id.name) ?? []), node.init])
        break
      case 'FunctionDeclaration': {
        const inFunctionBody = parent?.type === 'BlockStatement' && key === 'body' && FUNCTIONS.has(grandparent?.type)
        if (!['Program', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'TSModuleBlock', 'StaticBlock'].includes(parent?.type) && !inFunctionBody) {
          facts.blockFunction = true
        }
        break
      }
      case 'Identifier':
        if ((node.name === 'module' || node.name === 'exports') && parent && !isNonReference(parent, key)) {
          if (isBinding(parent, key, grandparent)) declaresModuleOrExports = true
          else cjsReference ??= `\`${node.name}\``
        }
        break
    }
    const ownsThis = node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassBody'
    const childFnDepth = FUNCTIONS.has(node.type) ? fnDepth + 1 : fnDepth
    const childThisDepth = ownsThis ? thisDepth + 1 : thisDepth
    for (const [child, childKey] of children(node)) stack.push([child, node, childKey, parent, childFnDepth, childThisDepth])
  }

  if (cjsCertain !== null) {
    facts.cjsUsage = 'yes'
    facts.cjsDetail = cjsCertain
  } else if (cjsReference !== null) {
    facts.cjsUsage = declaresModuleOrExports ? 'maybe' : 'yes'
    facts.cjsDetail = cjsReference
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
      const found = { specifiers: exported.specifiers, identifiers: new Set() }
      scanValue(init, found)
      pending.push(...found.identifiers)
    }
  }
  facts.reexports = exported.specifiers
  return facts
}
