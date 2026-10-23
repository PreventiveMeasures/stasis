'use strict'

// Stand-in for `metro-transform-worker`'s JS path, used by the StasisMetro transformer tests (Metro
// isn't a dependency): it requires `config.babelTransformerPath` from its own dir, as the worker
// does, hands it the source with Metro's caller-side args, then collects dependencies from the AST
// it returns -- replacing each `require`'s specifier with a dependency-map lookup, as Metro's
// collectDependencies does. Returns `{ config, dependencies, output }`, so a test can see the config
// it was handed (and so which Babel transformer ran) and how each dependency came out.
const { types: t } = require('@babel/core')

exports.transform = async (config, projectRoot, filename, data, options) => {
  const { ast } = await require(config.babelTransformerPath).transform({
    filename,
    options: { ...options, projectRoot },
    plugins: [],
    src: data.toString('utf8'),
  })
  const dependencies = []
  const register = (literal) => {
    if (!dependencies.some((dep) => dep.name === literal.value)) dependencies.push({ name: literal.value, data: { key: literal.value } })
    return t.memberExpression(t.identifier('_dependencyMap'), t.numericLiteral(dependencies.findIndex((dep) => dep.name === literal.value)), true)
  }
  t.traverseFast(ast, (node) => {
    if (node.type === 'ImportDeclaration') register(node.source)
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]?.type === 'StringLiteral') {
      node.arguments[0] = register(node.arguments[0])
    }
  })
  return { config, dependencies, output: [] }
}

exports.getCacheKey = () => 'mock-worker-cache-key'
