'use strict'

// Stand-in for `metro-transform-worker`'s JS path, used by the StasisMetro transformer tests (Metro
// isn't a dependency): it requires `config.babelTransformerPath` from its own dir, as the worker
// does, hands it the source with Metro's caller-side args, then collects dependencies from the AST
// it returns -- replacing each `require`'s specifier with a dependency-map lookup, as Metro's
// collectDependencies does, which takes a `require()` argument that evaluates to a string with
// confidence (a template, a concatenation), not only a literal. Returns `{ config, dependencies,
// output }`, so a test can see the config it was handed (and so which Babel transformer ran) and how
// each dependency came out; `output` is the one JS entry the worker returns, with no code.
const { traverse, types: t } = require('@babel/core')

exports.transform = async (config, projectRoot, filename, data, options) => {
  const { ast } = await require(config.babelTransformerPath).transform({
    filename,
    options: { ...options, projectRoot },
    plugins: [],
    src: data.toString('utf8'),
  })
  const dependencies = []
  const register = (name) => {
    if (!dependencies.some((dep) => dep.name === name)) dependencies.push({ name, data: { key: name } })
    return t.memberExpression(t.identifier('_dependencyMap'), t.numericLiteral(dependencies.findIndex((dep) => dep.name === name)), true)
  }
  traverse(ast, {
    ImportDeclaration(path) {
      register(path.node.source.value)
    },
    CallExpression(path) {
      if (!path.get('callee').isIdentifier({ name: 'require' })) return
      const evaluated = path.get('arguments.0').evaluate()
      if (evaluated.confident && typeof evaluated.value === 'string') path.node.arguments[0] = register(evaluated.value)
    },
  })
  return { config, dependencies, output: [{ type: 'js/module', data: {} }] }
}

exports.getCacheKey = () => 'mock-worker-cache-key'
