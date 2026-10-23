import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'

// Stands in for the project's Babel transformer (`babelTransformerPath`) under ./metro-transformer.js,
// which swaps it in for each worker transform, to keep each import as WRITTEN in the source. Metro
// names a dependency by the specifier Babel leaves in its output, so a plugin rewriting it (e.g.
// babel-plugin-module-resolver mapping `#local/abc` to `./src/abc`) leaves the serializer only the
// rewrite. This adds one plugin that records every specifier in its `pre` -- Babel runs every
// plugin's `pre` before any plugin's visitor, so nothing has rewritten one yet -- and reads each
// again once Babel is done, before Metro's own passes replace them in the AST, unless Babel erased
// it. The real transformer runs as it would; its output is untouched.

const require = createRequire(import.meta.url)

// One per worker transform, run by ./metro-transformer.js: `babelTransformerPath` is the project's
// (absolute), and `asWritten` maps each specifier Babel left to the ones written there.
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

// The specifier a dependency node holds as a string literal: an import/export's source, a call's
// first argument. A plugin rewriting it replaces the literal, never the node holding it.
function specifierOf(node) {
  const literal = node.type === 'CallExpression' ? node.arguments[0] : node.source
  return literal?.type === 'StringLiteral' ? literal.value : undefined
}

function asWrittenPlugin({ types: t }) {
  return {
    name: 'stasis-as-written',
    pre(file) {
      const { slots } = transformContext.getStore()
      t.traverseFast(file.ast, (node) => {
        if (node.type === 'CallExpression' ? !isDependencyCall(node.callee) : !DECLARATIONS.has(node.type)) return
        const written = specifierOf(node)
        if (written !== undefined) slots.push({ node, written })
      })
    },
    visitor: {
      // Babel exits a node only if no plugin removed it on the way in, so a declaration erased for
      // importing types alone (`import type`, `import { type A }`, a TS import used only as a type)
      // never exits: flow-strip-types removes it as it enters it, the TS plugin before the
      // traversal gets there. One lowered to a require exits first: wherever it is listed,
      // @babel/plugin-transform-modules-commonjs takes the declarations away as the program exits.
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
  // Once Babel is done: each specifier as it left it, from the node that held it as written.
  const collect = (result) => {
    for (const { node, written } of slots) {
      if (DECLARATIONS.has(node.type) && !kept.has(node)) continue
      const left = specifierOf(node)
      if (left === undefined) continue
      if (!context.asWritten.has(left)) context.asWritten.set(left, new Set())
      context.asWritten.get(left).add(written)
    }
    return result
  }
  // Sync or async, as the project's transformer is (the RN one is sync).
  const result = require(context.babelTransformerPath).transform({ ...args, plugins: [...(args.plugins ?? []), asWrittenPlugin] })
  return typeof result?.then === 'function' ? result.then(collect) : collect(result)
}
