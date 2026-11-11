import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'

// Stands in for the project's Babel transformer under ./metro-transformer.js, to keep each import as WRITTEN: Metro
// names a dependency by the specifier Babel leaves, so a rewrite (babel-plugin-module-resolver's) would leave it only
// that. An added plugin records each specifier in its `pre` (Babel runs every `pre` before any visitor) and reads it
// again once Babel is done; one a plugin consumed, with nothing left naming its module, is kept apart.

const require = createRequire(import.meta.url)

// Per worker transform: `babelTransformerPath` the project's, `asWritten` each specifier Babel left -> the ones
// written, and `consumed` each one a plugin consumed, as Babel last left it.
export const transformContext = new AsyncLocalStorage()

// The nodes Metro's collectDependencies takes a specifier from.
const DECLARATIONS = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'])
const REQUIRE_MEMBERS = new Set(['context', 'resolveWeak', 'unstable_importMaybeSync'])

function isDependency(node) {
  if (node.type !== 'CallExpression') return DECLARATIONS.has(node.type)
  const { callee } = node
  if (callee.type === 'Import') return true
  if (callee.type === 'Identifier') return callee.name === 'require' || callee.name === '__prefetchImport'
  return callee.type === 'MemberExpression' && !callee.computed &&
    callee.object.type === 'Identifier' && callee.object.name === 'require' &&
    callee.property.type === 'Identifier' && REQUIRE_MEMBERS.has(callee.property.name)
}

// A literal, a template with no substitutions, or a `+` of such, which collectDependencies evaluates as a literal.
function constantString(node) {
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? undefined
  if (node?.type !== 'BinaryExpression' || node.operator !== '+') return undefined
  const left = constantString(node.left)
  const right = left === undefined ? undefined : constantString(node.right)
  return right === undefined ? undefined : left + right
}

// A plugin rewriting a specifier replaces the literal, never the node holding it.
function specifierOf(node) {
  return constantString(node.type === 'CallExpression' ? node.arguments[0] : node.source)
}

const TYPE_KINDS = new Set(['type', 'typeof'])

// A declaration of types alone, which Babel may erase: Flow's or TypeScript's `import type`, `export type ... from`,
// or one whose every specifier is a type (which TypeScript's `onlyRemoveTypeImports` keeps as `import {} from`).
function typesOnly(node) {
  if (TYPE_KINDS.has(node.importKind ?? node.exportKind)) return true
  const specifiers = node.specifiers ?? []
  return specifiers.length > 0 && specifiers.every((specifier) => TYPE_KINDS.has(specifier.importKind ?? specifier.exportKind))
}

function dependenciesLeft(t, ast) {
  const nodes = new Set()
  const specifiers = new Set()
  t.traverseFast(ast, (node) => {
    if (!isDependency(node)) return
    nodes.add(node)
    const specifier = specifierOf(node)
    if (specifier !== undefined) specifiers.add(specifier)
  })
  return { nodes, specifiers }
}

function asWrittenPlugin({ types: t }) {
  return {
    name: 'stasis-as-written',
    pre(file) {
      const context = transformContext.getStore()
      context.types = t
      const { slots } = context
      let evaluate = false
      t.traverseFast(file.ast, (node) => {
        if (!isDependency(node)) return
        const written = specifierOf(node)
        if (written !== undefined) slots.push({ node, written, types: node.type !== 'CallExpression' && typesOnly(node) })
        else if (node.type === 'CallExpression' && node.arguments.length > 0) evaluate = true
      })
      // Metro also takes an argument Babel evaluates to a string with confidence (`const name = './x'; require(name)`),
      // which only a path, with its scope, can evaluate.
      if (!evaluate) return
      file.path.traverse({
        CallExpression(path) {
          if (!isDependency(path.node) || specifierOf(path.node) !== undefined || path.node.arguments.length === 0) return
          const { confident, value } = path.get('arguments.0').evaluate()
          if (confident && typeof value === 'string') slots.push({ node: path.node, written: value })
        },
      })
    },
    visitor: {
      // Babel exits a node only if no plugin removed it on the way in, so a types-only declaration it erased never
      // exits; one it kept (`import {} from`) does, still naming its module.
      'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration': {
        exit(path) {
          transformContext.getStore().kept.add(path.node)
        },
      },
    },
  }
}

export function transform(args) {
  const context = transformContext.getStore()
  assert.ok(context, 'StasisMetro: the stasis Babel transformer runs only under the stasis metro-transformer')
  const slots = []
  const kept = new Set()
  Object.assign(context, { slots, kept })
  // Each specifier as Babel left it in the node that held it as written, but an erased types-only declaration's. A
  // node a plugin replaced (lowered to a require, or split in two) names the same module, its specifier as rewritten
  // before; one gone from the output with no node there naming its module was consumed.
  const collect = (result) => {
    const left = result?.ast && context.types ? dependenciesLeft(context.types, result.ast) : null
    for (const { node, written, types } of slots) {
      if (types && !kept.has(node)) continue
      // One evaluated through its scope stays as written: no plugin rewrites what isn't a literal.
      const specifier = specifierOf(node) ?? written
      if (left !== null && !left.nodes.has(node) && !left.specifiers.has(specifier)) {
        context.consumed.add(specifier)
        continue
      }
      if (!context.asWritten.has(specifier)) context.asWritten.set(specifier, new Set())
      context.asWritten.get(specifier).add(written)
    }
    return result
  }
  // Sync or async, as the project's transformer is.
  const result = require(context.babelTransformerPath).transform({ ...args, plugins: [...(args.plugins ?? []), asWrittenPlugin] })
  return typeof result?.then === 'function' ? result.then(collect) : collect(result)
}
