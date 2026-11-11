import { isPlainObject, memoized } from '@exodus/stasis-core/util'

// --define: globals' values (`__DEV__`, `process.env.NODE_ENV`) the scan takes as constants, leaving out the imports in
// branches they keep from running. No test folds that Metro wouldn't fold, so a --metro bundle lacks no file Metro holds.

// What Metro's release build (`dev: false`) inlines and its prelude gives the globals: --metro's default defines.
export const METRO_RELEASE_DEFINE = Object.freeze({ __DEV__: false, 'process.env.NODE_ENV': 'production' })

const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u

const usageError = (name, message, ErrorType = Error) => new ErrorType(name ? `${name}: ${message}` : message)

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

// `--define=KEY=VALUE` texts -> parseDefine's object. VALUE is JSON, as esbuild's --define takes it.
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
// Gone by the time Metro folds (Babel keeps no parentheses, and TypeScript's are stripped first).
const WRAPPERS = new Set(['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion'])
const EQUALITY = new Set(['===', '!==', '==', '!='])
const SKIP_KEYS = new Set(['type', 'loc', 'range', 'start', 'end', 'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments'])
// The child a node of each type binds or writes; functions, `delete` and for-in/of are ownPaths' own.
const BINDS = {
  __proto__: null,
  VariableDeclarator: 'id', ClassDeclaration: 'id', ClassExpression: 'id',
  TSImportEqualsDeclaration: 'id', TSEnumDeclaration: 'id', TSModuleDeclaration: 'id',
  ImportSpecifier: 'local', ImportDefaultSpecifier: 'local', ImportNamespaceSpecifier: 'local',
  CatchClause: 'param', AssignmentExpression: 'left', UpdateExpression: 'argument',
}
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

// Plain property accesses alone, as Metro inlines them: not `process.env['NODE_ENV']` or `process.env?.NODE_ENV`.
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

// As far as it is static from its root identifier (`process.env[name]` writes `process.env`).
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

// A declaration of `process` or an assignment to `process.env.NODE_ENV` makes it the file's own, not the define's.
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
    if (node.type in BINDS) target(node[BINDS[node.type]])
    else if (FUNCTIONS.has(node.type)) for (const p of [node.id, ...node.params]) target(p)
    else if (node.type === 'UnaryExpression' && node.operator === 'delete') target(node.argument)
    else if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left.type !== 'VariableDeclaration') target(node.left)
    for (const key of Object.keys(node)) if (!SKIP_KEYS.has(key)) visit(node[key])
  }
  visit(program)
  return paths
}

function owned(own, key) {
  for (let i = key.length; i > 0; i = key.lastIndexOf('.', i - 1)) {
    if (own.has(key.slice(0, i))) return true
  }
  return false
}

// For a branch whose test folds, the children to walk: the test and the side that runs. null where no define applies
// to the file (each one given is the file's own).
export function branchFolder(defines, program) {
  if (defines.size === 0) return null
  const own = ownPaths(program)
  const values = new Map([...defines].filter(([key]) => !owned(own, key)))
  if (values.size === 0) return null

  const folded = memoized((node) => evaluate(node))
  const fold = (node) => (node ? folded(node) : UNKNOWN)
  // What Metro's constant folding evaluates once it has inlined the defines (Babel's path.evaluate()), and less: a
  // value it can't be sure Metro folds is UNKNOWN, as the bundle may never leave out a file Metro's graph holds.
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
        // eslint-disable-next-line eqeqeq -- the source's own loose comparison, of primitives
        const equal = node.operator.length === 3 ? left === right : left == right
        return node.operator.startsWith('=') ? equal : !equal
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

  // A `typeof` only beside a string other than 'symbol' and 'object', the one Babel's typeof-symbol transform leaves
  // as it is (it makes any other a call).
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
    // `??` never folds: Babel's nullish-coalescing transform makes it an assignment, which Metro doesn't fold.
    if (node.type === 'LogicalExpression' && node.operator !== '??') {
      const left = fold(node.left)
      if (left === UNKNOWN || rightRuns(node.operator, left)) return undefined
      return [node.left]
    }
    return undefined
  }
}

const rightRuns = (operator, left) => (operator === '&&' ? Boolean(left) : !left)
