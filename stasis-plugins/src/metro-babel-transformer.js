import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'

// Stands in for the project's Babel transformer (`babelTransformerPath`) under ./metro-transformer.js,
// which swaps it in for each worker transform, to keep each import as WRITTEN in the source. Metro
// names a dependency by the specifier Babel leaves in its output, so a plugin rewriting it (e.g.
// babel-plugin-module-resolver mapping `#local/abc` to `./src/abc`) leaves the serializer only the
// rewrite. This adds one plugin that records every specifier in its `pre` -- Babel runs every
// plugin's `pre` before any plugin's visitor, so nothing has rewritten one yet -- and reads each
// again once Babel is done, before Metro's own passes replace them in the AST, but one importing
// types alone that Babel erased. One a plugin consumed, gone from Babel's output with nothing left
// naming its module (`require('./messages.po')`, which @exodus/i18n's plugin-inline-po reads and
// inlines), it keeps apart. The real transformer runs as it would; its output is untouched.

const require = createRequire(import.meta.url)

// One per worker transform, run by ./metro-transformer.js: `babelTransformerPath` is the project's
// (absolute), `asWritten` maps each specifier Babel left to the ones written there, and `consumed`
// holds each one a plugin consumed, as Babel last left it.
export const transformContext = new AsyncLocalStorage()

// The nodes Metro's collectDependencies takes a specifier from: these declarations, and the calls
// below (`import()`, `require()`, `__prefetchImport()`, `require.<member>()`).
const DECLARATIONS = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'])
const REQUIRE_MEMBERS = new Set(['context', 'resolveWeak', 'unstable_importMaybeSync'])

function isDependencyCall(callee) {
  if (callee.type === 'Import') return true
  if (callee.type === 'Identifier') return callee.name === 'require' || callee.name === '__prefetchImport'
  return callee.type === 'MemberExpression' && !callee.computed &&
    callee.object.type === 'Identifier' && callee.object.name === 'require' &&
    callee.property.type === 'Identifier' && REQUIRE_MEMBERS.has(callee.property.name)
}

// The string `node` holds as a constant: a literal, a template with no substitutions, or a `+` of
// such, which Metro's collectDependencies evaluates to the specifier as it does a literal.
function constantString(node) {
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? undefined
  if (node?.type !== 'BinaryExpression' || node.operator !== '+') return undefined
  const left = constantString(node.left)
  const right = left === undefined ? undefined : constantString(node.right)
  return right === undefined ? undefined : left + right
}

// The specifier a dependency node holds as a constant: an import/export's source, a call's first
// argument. A plugin rewriting it replaces the literal, never the node holding it.
function specifierOf(node) {
  return constantString(node.type === 'CallExpression' ? node.arguments[0] : node.source)
}

const TYPE_KINDS = new Set(['type', 'typeof'])

// A declaration of types alone, which Babel may erase, and then it names no module Metro depends on:
// Flow's `import type`/`import typeof`, TypeScript's `import type`, `export type ... from`, and one
// whose every specifier is a type (`import { type A }`, which TypeScript's `onlyRemoveTypeImports`
// keeps as `import {} from`).
function typesOnly(node) {
  if (TYPE_KINDS.has(node.importKind ?? node.exportKind)) return true
  const specifiers = node.specifiers ?? []
  return specifiers.length > 0 && specifiers.every((specifier) => TYPE_KINDS.has(specifier.importKind ?? specifier.exportKind))
}

// The dependency nodes in Babel's output, and the specifiers they hold as constants.
function dependenciesLeft(t, ast) {
  const nodes = new Set()
  const specifiers = new Set()
  t.traverseFast(ast, (node) => {
    if (node.type === 'CallExpression' ? !isDependencyCall(node.callee) : !DECLARATIONS.has(node.type)) return
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
        if (node.type === 'CallExpression' ? !isDependencyCall(node.callee) : !DECLARATIONS.has(node.type)) return
        const written = specifierOf(node)
        if (written !== undefined) slots.push({ node, written, types: node.type !== 'CallExpression' && typesOnly(node) })
        else if (node.type === 'CallExpression' && node.arguments.length > 0) evaluate = true
      })
      // Metro takes any argument Babel evaluates to a string with confidence, one bound to a constant
      // too (`const name = './x'; require(name)`), which only a path, and its scope, can evaluate.
      if (!evaluate) return
      file.path.traverse({
        CallExpression(path) {
          if (!isDependencyCall(path.node.callee) || specifierOf(path.node) !== undefined || path.node.arguments.length === 0) return
          const { confident, value } = path.get('arguments.0').evaluate()
          if (confident && typeof value === 'string') slots.push({ node: path.node, written: value })
        },
      })
    },
    visitor: {
      // Babel exits a node only if no plugin removed it on the way in, so a declaration of types
      // alone that Babel erased never exits: flow-strip-types removes it as it enters it, the TS
      // plugin before the traversal gets there. One it kept (`import {} from` under
      // `onlyRemoveTypeImports`) exits, still naming its module.
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
  // Once Babel is done: each specifier as it left it, from the node that held it as written, but a
  // declaration of types alone Babel erased. One a plugin replaced keeps it too: lowered to a require
  // (the commonjs transform), or split in two (`export * as ns from` into an import and an export,
  // the export-namespace-from transform), it names the same module, its specifier as rewritten
  // before (module-resolver rewrites every one as the program enters). One gone from the output,
  // with no node there naming its module, a plugin consumed in its stead.
  const collect = (result) => {
    const left = result?.ast && context.types ? dependenciesLeft(context.types, result.ast) : null
    for (const { node, written, types } of slots) {
      if (types && !kept.has(node)) continue
      // One evaluated through its scope stays as written: no plugin rewrites what isn't a literal.
      const specifier = specifierOf(node) ?? (node.type === 'CallExpression' ? written : undefined)
      if (specifier === undefined) continue
      if (left !== null && !left.nodes.has(node) && !left.specifiers.has(specifier)) {
        context.consumed.add(specifier)
        continue
      }
      if (!context.asWritten.has(specifier)) context.asWritten.set(specifier, new Set())
      context.asWritten.get(specifier).add(written)
    }
    return result
  }
  // Sync or async, as the project's transformer is (the RN one is sync).
  const result = require(context.babelTransformerPath).transform({ ...args, plugins: [...(args.plugins ?? []), asWrittenPlugin] })
  return typeof result?.then === 'function' ? result.then(collect) : collect(result)
}
