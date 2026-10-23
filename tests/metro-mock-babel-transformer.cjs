'use strict'

// Stand-in for a Metro Babel transformer (`babelTransformerPath`, e.g.
// @react-native/metro-babel-transformer), used by the StasisMetro transformer tests: runs the
// project's babel.config.js over the source with Metro's caller and the plugins Metro passes, and
// returns the AST, as the RN one does. STASIS_TEST_BABEL_ASYNC=1 returns it in a promise instead.
const { transformSync } = require('@babel/core')
const { join } = require('node:path')

exports.transform = ({ filename, options, plugins, src }) => {
  const { ast } = transformSync(src, {
    ast: true,
    code: false,
    babelrc: false,
    caller: { name: 'metro', bundler: 'metro', platform: options.platform },
    configFile: join(options.projectRoot, 'babel.config.js'),
    cwd: options.projectRoot,
    filename: join(options.projectRoot, filename),
    plugins,
    sourceType: 'module',
  })
  return process.env.STASIS_TEST_BABEL_ASYNC === '1' ? Promise.resolve({ ast }) : { ast }
}
