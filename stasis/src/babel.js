// Per-file Babel pre-transforms for `stasis build` (--platform=hermes, --babel), and the import aliases `stasis bundle
// --metro --babel` takes from the project's config. Babel is the project's dev dependency, never stasis's own.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

import { memoized } from '@exodus/stasis-core/util'

const require = createRequire(import.meta.url)

// esbuild `supported` map for the FINAL hermes bundle (spread into esbuild.build options).
export const HERMES_UNSUPPORTED = {
  arrow: false,
  class: false, // already lowered by Babel; unsupporting it doubles as a safeguard check
  'async-generator': false,
  'const-and-let': false, // ditto, and keeps esbuild-emitted helpers off let/const
  'for-await': false,
}

// What Babel can't take without extra plugins (and Hermes supports none of), lowered into plain classes first.
const PRE_TRANSFORM_UNSUPPORTED = Object.fromEntries([
  'class-field', 'class-private-accessor', 'class-private-brand-check', 'class-private-field', 'class-private-method',
  'class-private-static-accessor', 'class-private-static-field', 'class-private-static-method', 'class-static-blocks',
  'class-static-field', 'import-attributes', 'using',
].map((feature) => [feature, false]))

const HERMES_BABEL_PLUGINS = ['@babel/plugin-transform-block-scoping', '@babel/plugin-transform-classes']

// Anything else the plugin serves (json, or a --loader override like .svg:text) passes through untouched.
const TRANSFORMABLE_LOADERS = new Set(['js', 'ts', 'jsx', 'tsx'])

// On the main thread, so a missing install fails with instructions, not a worker crash mid-build. Absolute paths:
// the worker loads @babel/core by path, and plugin paths bypass Babel's own name resolution (from the wrong dir).
function resolveFromProject(projectDir, deps, flag, command = 'stasis build') {
  const projectRequire = createRequire(join(projectDir, 'noop.js'))
  try {
    return deps.map((dep) => projectRequire.resolve(dep))
  } catch (cause) {
    throw new Error(`${command}: ${flag} needs ${deps.join(', ')} installed in the project `
      + `(e.g. \`npm i -D ${deps.join(' ')}\`); resolution failed from ${projectDir}`, { cause })
  }
}

// In StasisEsbuild's load-mode `transform` hook shape: (source, { path, loader }) => { contents, loader } | undefined.
export function createHermesTransform({ projectDir, esbuild }) {
  const [babelPath, ...plugins] = resolveFromProject(projectDir, ['@babel/core', ...HERMES_BABEL_PLUGINS], '--platform=hermes')
  const { transformAsync } = require('./babel-worker.cjs')
  return async (source, { path, loader }) => {
    if (!TRANSFORMABLE_LOADERS.has(loader)) return undefined
    const { code, warnings } = await esbuild.transform(source, {
      sourcemap: 'inline', sourcefile: path, loader, supported: PRE_TRANSFORM_UNSUPPORTED,
    })
    if (warnings.length > 0) {
      const formatted = await esbuild.formatMessages(warnings, { kind: 'warning', color: false })
      for (const line of formatted) process.stderr.write(line)
    }
    const result = await transformAsync(babelPath, code, { compact: false, babelrc: false, configFile: false, plugins })
    // TS is stripped and JSX compiled by the pre-transform, so the result is always plain js.
    return { contents: result.code, loader: 'js' }
  }
}

// Its output must be esbuild-parseable js: a config that leaves TS/JSX in place is the project's to fix.
export function createBabelConfigTransform({ projectDir }) {
  const configFile = findBabelConfig(projectDir, 'stasis build')
  const [babelPath] = resolveFromProject(projectDir, ['@babel/core'], '--babel')
  const { transformAsync } = require('./babel-worker.cjs')
  return async (source, { path, loader }) => {
    if (!TRANSFORMABLE_LOADERS.has(loader)) return undefined
    // `filename` makes per-file config (overrides, .babelrc lookup) behave as in a real run.
    const result = await transformAsync(babelPath, source, { cwd: projectDir, root: projectDir, configFile, filename: path, compact: false })
    return { contents: result.code, loader: 'js' }
  }
}

function findBabelConfig(projectDir, command) {
  const configFile = ['babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json']
    .map((name) => join(projectDir, name))
    .find((file) => existsSync(file))
  if (!configFile) throw new Error(`${command}: --babel found no babel.config.(js|cjs|mjs|json) in ${projectDir}`)
  return configFile
}

// Loaded as Metro's transformer loads it (its `metro` caller): the config is project code, run here.
function projectBabelConfig({ projectDir, platform }, method) {
  const configFile = findBabelConfig(projectDir, 'stasis bundle')
  const [babelPath] = resolveFromProject(projectDir, ['@babel/core'], '--babel', 'stasis bundle')
  const babel = require(babelPath)
  const caller = { name: 'metro', bundler: 'metro', platform }
  return memoized((file) => {
    try {
      return babel[method]({ cwd: projectDir, root: projectDir, configFile, filename: file, caller })
    } catch (cause) {
      throw new Error(`stasis bundle: --babel could not load ${configFile} for ${file}`, { cause })
    }
  })
}

const MODULE_RESOLVER = /[\\/]node_modules[\\/]babel-plugin-module-resolver[\\/]/u

// The aliases babel-plugin-module-resolver applies under the project's babel.config.*: each instance the config lists
// counts, in order; one a preset adds doesn't. -> (file, specifier) => the specifier it is rewritten to, else null
export function createBabelAliases({ projectDir, platform }) {
  const partialConfig = projectBabelConfig({ projectDir, platform }, 'loadPartialConfig')
  // The project's own copy, which a config passing the plugin as a value passes.
  let projectPlugin
  try {
    projectPlugin = createRequire(join(projectDir, 'noop.js'))('babel-plugin-module-resolver')
  } catch {
    projectPlugin = null
  }
  const moduleOf = (plugin) => {
    const resolved = plugin.file?.resolved
    if (resolved !== undefined) return MODULE_RESOLVER.test(resolved) ? require(resolved) : null
    return plugin.value === projectPlugin?.default ? projectPlugin : null
  }
  return (file, specifier) => {
    // No partial config: the config ignores the file.
    for (const plugin of partialConfig(file)?.options.plugins ?? []) {
      const module = moduleOf(plugin)
      if (module === null) continue
      const options = { cwd: projectDir, ...plugin.options }
      const resolvePath = typeof options.resolvePath === 'function' ? options.resolvePath : module.resolvePath
      const mapped = resolvePath(specifier, file, options)
      // The first instance mapping it wins: the plugin marks the path it writes resolved, which later ones leave be.
      if (mapped) return typeof mapped === 'string' && mapped !== specifier ? mapped : null
    }
    return null
  }
}

// Whether Babel keeps a statement listing types alone (as `import {} from`), as `onlyRemoveTypeImports` has it.
// No options: the config ignores the file.
export function createBabelTypeImportsKept({ projectDir, platform }) {
  const options = projectBabelConfig({ projectDir, platform }, 'loadOptions')
  return (file) => (options(file)?.plugins ?? []).some((plugin) => plugin.key === 'transform-typescript' && plugin.options?.onlyRemoveTypeImports === true)
}

// babel-plugin-module-resolver's path tests, as it writes them.
const isRelativePath = (path) => /^\.?\.\//u.test(path)
const toLocalPath = (path) => {
  const local = path.replace(/\/index$/u, '')
  return isRelativePath(local) ? local : `./${local}`
}
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

// --babel-aliases: babel-plugin-module-resolver's `alias` option as data, mapped as the plugin maps it, the first key
// matching winning. A `./` or `../` value is a path from `cwd`.
export function createAliases(alias, cwd) {
  const matchers = Object.entries(alias).map(([key, value]) => {
    // As the plugin builds them: a key's own pattern, unflagged (`u` would refuse some it takes).
    if (!key.startsWith('^') && !key.endsWith('$')) return [new RegExp(`^${escapeRegExp(key)}(/.*|)$`), ([, rest]) => `${value}${rest}`]
    const parts = value.split('\\\\')
    return [new RegExp(key), (groups) => parts.map((part) => part.replace(/\\\d+/gu, (n) => groups[n.slice(1)] || '')).join('\\')]
  })
  return (file, specifier) => {
    if (isRelativePath(specifier)) return null
    for (const [regExp, substitute] of matchers) {
      const groups = regExp.exec(specifier)
      if (groups === null) continue
      const mapped = substitute(groups)
      if (!mapped) return null
      const rewritten = isRelativePath(mapped) ? toLocalPath(relative(dirname(file), resolve(cwd, mapped)).replace(/\\/gu, '/')) : mapped
      return rewritten === specifier ? null : rewritten
    }
    return null
  }
}
