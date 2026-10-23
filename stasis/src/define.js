import { isPlainObject } from '@exodus/stasis-core/util'

// --define: the values a build gives globals (`__DEV__`, `process.env.NODE_ENV`), which the static
// scan takes as constants, to leave out the imports of code they keep from running: under
// `__DEV__=false`, `if (__DEV__) require('./dev')` reaches nothing. Only a branch whose test folds
// to a constant is left out -- `if`/`else`, `?:` and the right of `&&` and `||` -- as Metro's
// release build drops it (its inline and constant-folding transforms, run before it collects a
// file's dependencies); a test that doesn't fold walks both sides, as without a define. It folds
// no test Metro wouldn't, after React Native's Babel transforms, so a --metro bundle never lacks a
// file Metro's graph holds.

// A defined name: an identifier, or a dotted path of them (`process.env.NODE_ENV`).
const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u

// A usage error, prefixed with `name` where there is one.
const usageError = (name, message, ErrorType = Error) => new ErrorType(name ? `${name}: ${message}` : message)

// `define` (each name -> its value: a string, number, boolean or null) checked, `name` (if any)
// prefixing errors. -> Map, empty where it is undefined.
export function parseDefine(name, define) {
  if (define === undefined) return new Map()
  if (!isPlainObject(define)) throw usageError(name, "define must be an object of each name's value", TypeError)
  for (const [key, value] of Object.entries(define)) {
    if (!NAME.test(key)) throw usageError(name, `--define names an identifier or a dotted path of them (e.g. __DEV__, process.env.NODE_ENV), not ${JSON.stringify(key)}`)
    if (!(value === null || ['string', 'boolean'].includes(typeof value) || Number.isFinite(value))) {
      throw usageError(name, `--define's value for ${key} must be a string, number, boolean or null, not ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    }
  }
  return new Map(Object.entries(define))
}

// `--define=KEY=VALUE` texts (`texts`, as given) -> parseDefine's object, `name` (if any) prefixing
// errors. VALUE is JSON, as esbuild's --define takes it: `__DEV__=false`,
// `process.env.NODE_ENV="production"`.
export function parseDefineFlags(name, texts) {
  if (texts.length === 0) throw usageError(name, '--define must give at least one KEY=VALUE (e.g. --define=__DEV__=false)')
  const define = {}
  for (const text of texts) {
    const eq = text.indexOf('=')
    if (eq <= 0) throw usageError(name, `--define must be KEY=VALUE (e.g. --define=__DEV__=false), not ${JSON.stringify(text)}`)
    const key = text.slice(0, eq)
    if (Object.hasOwn(define, key)) throw usageError(name, `--define gives ${key} a value twice`)
    try {
      define[key] = JSON.parse(text.slice(eq + 1))
    } catch {
      throw usageError(name, `--define's value for ${key} must be JSON: a string, quoted (--define=${key}='"production"'), a number, true, false or null, not ${JSON.stringify(text.slice(eq + 1))}`)
    }
  }
  parseDefine(name, define)
  return define
}

const UNKNOWN = Symbol('unknown')
// The wrappers that are gone by the time Metro folds (Babel keeps no parentheses, and TypeScript's
// are stripped first), so leave the value as it is.
const WRAPPERS = new Set(['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion'])
const EQUALITY = new Set(['===', '!==', '==', '!='])
const SKIP_KEYS = new Set(['type', 'loc', 'range', 'start', 'end', 'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments'])

// The dotted path `node` names (`process.env.NODE_ENV`), or null: plain property accesses alone, as
// Metro inlines them, not `process.env['NODE_ENV']` or `process.env?.NODE_ENV`.
function dottedPath(node) {
  const parts = []
  for (;;) {
    if (WRAPPERS.has(node.type)) node = node.expression
    else if (node.type === 'MemberExpression' && !node.computed && !node.optional) {
      parts.unshift(node.property.name)
      node = node.object
    } else break
  }
  if (node.type !== 'Identifier') return null
  parts.unshift(node.name)
  return parts.join('.')
}

// The path a write to `node` (an assignment target) reaches, as far as it is static from its root
// identifier (`process.env[name]` writes `process.env`), or null where it has no root identifier.
function writtenPath(node) {
  const parts = []
  while (WRAPPERS.has(node.type) || node.type === 'MemberExpression') {
    if (node.type === 'MemberExpression') {
      const property = node.computed
        ? (node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null)
        : node.property.name
      // A computed part cuts the path there: what lies past it, it can't name.
      if (property === null) parts.length = 0
      else parts.unshift(property)
      node = node.object
    } else {
      node = node.expression
    }
  }
  if (node.type !== 'Identifier') return null
  parts.unshift(node.name)
  return parts.join('.')
}

// The paths `program` binds or writes itself, each as far as it is static: a declaration of
// `process` or an assignment to `process.env.NODE_ENV` makes it the file's own, not the define's.
// What is only declared for the type checker (`declare const __DEV__: boolean`) binds nothing.
function ownPaths(program) {
  const paths = new Set()
  const target = (node) => {
    if (!node) return
    if (node.type === 'Identifier') paths.add(node.name)
    else if (node.type === 'ObjectPattern') for (const p of node.properties) target(p.type === 'RestElement' ? p.argument : p.value)
    else if (node.type === 'ArrayPattern') for (const e of node.elements) target(e)
    else if (node.type === 'AssignmentPattern') target(node.left)
    else if (node.type === 'RestElement') target(node.argument)
    else if (node.type === 'TSParameterProperty') target(node.parameter)
    else if (node.type === 'MemberExpression' || WRAPPERS.has(node.type)) {
      const path = writtenPath(node)
      if (path !== null) paths.add(path)
    }
  }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const c of node) visit(c)
      return
    }
    if (typeof node.type !== 'string' || node.declare === true) return
    switch (node.type) {
      case 'VariableDeclarator':
        target(node.id)
        break
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        target(node.id)
        for (const p of node.params) target(p)
        break
      case 'ClassDeclaration':
      case 'ClassExpression':
      case 'TSImportEqualsDeclaration':
      case 'TSEnumDeclaration':
      case 'TSModuleDeclaration':
        target(node.id)
        break
      case 'CatchClause':
        target(node.param)
        break
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
        target(node.local)
        break
      case 'AssignmentExpression':
        target(node.left)
        break
      case 'UpdateExpression':
        target(node.argument)
        break
      case 'UnaryExpression':
        if (node.operator === 'delete') target(node.argument)
        break
      case 'ForInStatement':
      case 'ForOfStatement':
        if (node.left.type !== 'VariableDeclaration') target(node.left)
        break
      default:
    }
    for (const key of Object.keys(node)) if (!SKIP_KEYS.has(key)) visit(node[key])
  }
  visit(program)
  return paths
}

// Whether `own` (ownPaths') holds `key` or a path above it.
function owned(own, key) {
  for (let i = key.length; i > 0; i = key.lastIndexOf('.', i - 1)) {
    if (own.has(key.slice(0, i))) return true
  }
  return false
}

// The branch folder of `program` under `defines` (parseDefine's): for a node, the children the scan
// is to walk where it is a branch whose test folds (the test itself, and the side that runs), else
// undefined. null where no define applies to the file: none given, or every one bound or written by
// the file itself.
export function branchFolder(defines, program) {
  if (defines.size === 0) return null
  const own = ownPaths(program)
  const values = new Map([...defines].filter(([key]) => !owned(own, key)))
  if (values.size === 0) return null

  const cache = new WeakMap()
  // The value `node` folds to, or UNKNOWN.
  const fold = (node) => {
    if (!node) return UNKNOWN
    if (cache.has(node)) return cache.get(node)
    const value = evaluate(node)
    cache.set(node, value)
    return value
  }
  // What Metro's constant folding evaluates, once it has inlined the defines (Babel's
  // path.evaluate()), and less: a value it can't be sure Metro folds is UNKNOWN, as the bundle may
  // never leave out a file Metro's graph holds.
  const evaluate = (node) => {
    if (WRAPPERS.has(node.type)) return fold(node.expression)
    switch (node.type) {
      case 'Literal':
        return node.regex === undefined && node.bigint === undefined ? node.value : UNKNOWN
      case 'TemplateLiteral':
        return node.expressions.length === 0 && typeof node.quasis[0].value.cooked === 'string' ? node.quasis[0].value.cooked : UNKNOWN
      case 'Identifier':
      case 'MemberExpression': {
        const path = dottedPath(node)
        return path !== null && values.has(path) ? values.get(path) : UNKNOWN
      }
      case 'UnaryExpression': {
        // Metro folds a `void` of a literal alone (`void 0`).
        if (node.operator === 'void') return node.argument.type === 'Literal' ? undefined : UNKNOWN
        if (node.operator !== '!') return UNKNOWN // `typeof`: see BinaryExpression
        const value = fold(node.argument)
        return value === UNKNOWN ? UNKNOWN : !value
      }
      case 'BinaryExpression': {
        if (!EQUALITY.has(node.operator)) return UNKNOWN
        const left = operand(node.left, node.right)
        const right = left === UNKNOWN ? UNKNOWN : operand(node.right, node.left)
        if (right === UNKNOWN) return UNKNOWN
        switch (node.operator) {
          case '===': return left === right
          case '!==': return left !== right
          // eslint-disable-next-line eqeqeq -- the source's own loose comparison, of primitives
          case '==': return left == right
          // eslint-disable-next-line eqeqeq
          default: return left != right
        }
      }
      case 'LogicalExpression': {
        const left = node.operator === '??' ? UNKNOWN : fold(node.left)
        if (left === UNKNOWN) return UNKNOWN
        return rightRuns(node.operator, left) ? fold(node.right) : left
      }
      case 'ConditionalExpression': {
        const test = fold(node.test)
        if (test === UNKNOWN) return UNKNOWN
        return fold(test ? node.consequent : node.alternate)
      }
      default:
        return UNKNOWN
    }
  }

  // The value of `node`, compared with `other`: a `typeof` only beside a string other than 'symbol'
  // and 'object', the one Babel's typeof-symbol transform leaves as it is (it makes any other a call).
  const operand = (node, other) => {
    while (WRAPPERS.has(node.type)) node = node.expression
    if (node.type !== 'UnaryExpression' || node.operator !== 'typeof') return fold(node)
    while (WRAPPERS.has(other.type)) other = other.expression
    if (other.type !== 'Literal' || typeof other.value !== 'string' || ['symbol', 'object'].includes(other.value)) return UNKNOWN
    const value = fold(node.argument)
    return value === UNKNOWN ? UNKNOWN : typeof value
  }

  return (node) => {
    if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
      const test = fold(node.test)
      if (test === UNKNOWN) return undefined
      return [node.test, test ? node.consequent : node.alternate]
    }
    // `??` never folds: Babel's nullish-coalescing transform makes it an assignment, which Metro
    // doesn't fold.
    if (node.type === 'LogicalExpression' && node.operator !== '??') {
      const left = fold(node.left)
      if (left === UNKNOWN || rightRuns(node.operator, left)) return undefined
      return [node.left]
    }
    return undefined
  }
}

// Whether the right of `left <operator> right` (`&&` or `||`) runs, `left` its left's value.
const rightRuns = (operator, left) => (operator === '&&' ? Boolean(left) : !left)
