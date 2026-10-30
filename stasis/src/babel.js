// Per-file Babel pre-transforms for `stasis build`, serving two flags:
//
// --platform=hermes downlevels every code file to the dialect Hermes (React Native's
// engine) executes -- no classes, class fields, let/const, arrows, async generators or
// for-await. Two steps per file, then a constrained final bundle:
//   1. esbuild.transform lowers class fields / private members / static blocks / `using`
//      into plain class syntax (stripping TS types and compiling JSX on the way), the
//      shape Babel's class transform can consume.
//   2. A Babel worker pool applies transform-block-scoping + transform-classes -- the two
//      lowerings esbuild refuses to do itself.
//   3. The final esbuild bundle runs with HERMES_UNSUPPORTED (arrow/async-generator/
//      for-await lowered by esbuild; class and const-and-let declared unsupported both so
//      esbuild's own helpers stay Hermes-safe and as a fail-closed check that none
//      survived Babel).
//
// --babel instead runs each code file through the project's own babel.config.* verbatim --
// no esbuild pre-transform, Babel sees the original source exactly as the project's own
// toolchain (e.g. Metro) would hand it over.
//
// `stasis bundle --metro --babel` takes only the import aliases from that config (see
// createBabelAliases): the scan still reads each file's own source. `--babel-aliases` takes the same
// aliases from a JSON file instead, mapped here as the plugin maps them (createAliases), so nothing
// of the project's runs.
//
// Babel is the PROJECT's dev dependency, not stasis's: @babel/core (and, for hermes, the
// two transform plugins) resolve from the project directory, so the project pins its own
// Babel toolchain and config semantics.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

const require = createRequire(import.meta.url)

// esbuild `supported` map for the FINAL hermes bundle (spread into esbuild.build options).
export const HERMES_UNSUPPORTED = {
  arrow: false,
  class: false, // already lowered by Babel; unsupporting it doubles as a safeguard check
  'async-generator': false,
  'const-and-let': false, // ditto, and keeps esbuild-emitted helpers off let/const
  'for-await': false,
}

// Class-syntax extensions the hermes pre-transform lowers into plain classes for Babel,
// which handles none of them without extra plugins (and Hermes supports none of them either).
const PRE_TRANSFORM_UNSUPPORTED = {
  'class-field': false,
  'class-private-accessor': false,
  'class-private-brand-check': false,
  'class-private-field': false,
  'class-private-method': false,
  'class-private-static-accessor': false,
  'class-private-static-field': false,
  'class-private-static-method': false,
  'class-static-blocks': false,
  'class-static-field': false,
  'import-attributes': false,
  using: false,
}

const HERMES_BABEL_PLUGINS = ['@babel/plugin-transform-block-scoping', '@babel/plugin-transform-classes']

// Only real JS-family sources are transformed; anything else the plugin serves (json, or a
// --loader override like .svg:text) passes through untouched.
const TRANSFORMABLE_LOADERS = new Set(['js', 'ts', 'jsx', 'tsx'])

// Resolved up front on the main thread so a missing install fails with instructions, not a
// worker crash mid-build. Returns absolute paths: the worker loads @babel/core by path, and
// plugin paths bypass Babel's own name resolution (which would look in the wrong dir).
function resolveFromProject(projectDir, deps, flag, command = 'stasis build') {
  const projectRequire = createRequire(join(projectDir, 'noop.js'))
  try {
    return deps.map((dep) => projectRequire.resolve(dep))
  } catch (cause) {
    throw new Error(
      `${command}: ${flag} needs ${deps.join(', ')} installed in the project ` +
      `(e.g. \`npm i -D ${deps.join(' ')}\`); resolution failed from ${projectDir}`,
      { cause }
    )
  }
}

// The hermes per-file pre-transform, in StasisEsbuild's load-mode `transform` hook shape:
// (source, { path, loader }) => { contents, loader } | undefined.
export function createHermesTransform({ projectDir, esbuild }) {
  const [babelPath, ...plugins] = resolveFromProject(
    projectDir, ['@babel/core', ...HERMES_BABEL_PLUGINS], '--platform=hermes'
  )
  const { transformAsync } = require('./babel-worker.cjs')
  return async (source, { path, loader }) => {
    if (!TRANSFORMABLE_LOADERS.has(loader)) return undefined
    const { code, warnings } = await esbuild.transform(source, {
      sourcemap: 'inline',
      sourcefile: path,
      loader,
      supported: PRE_TRANSFORM_UNSUPPORTED,
    })
    if (warnings.length > 0) {
      const formatted = await esbuild.formatMessages(warnings, { kind: 'warning', color: false })
      for (const line of formatted) process.stderr.write(line)
    }
    const result = await transformAsync(babelPath, code, {
      compact: false,
      babelrc: false,
      configFile: false,
      plugins,
    })
    // TS is stripped and JSX compiled by the pre-transform, so the result is always plain js.
    return { contents: result.code, loader: 'js' }
  }
}

// The --babel per-file transform (same hook shape): the project's own babel.config.* over
// the original source. Its output must be esbuild-parseable js -- a config that leaves TS/JSX
// in place fails the build in Babel or esbuild, which is the project's config to fix.
export function createBabelConfigTransform({ projectDir }) {
  const configFile = findBabelConfig(projectDir, 'stasis build')
  const [babelPath] = resolveFromProject(projectDir, ['@babel/core'], '--babel')
  const { transformAsync } = require('./babel-worker.cjs')
  return async (source, { path, loader }) => {
    if (!TRANSFORMABLE_LOADERS.has(loader)) return undefined
    // filename makes per-file config (overrides, .babelrc lookup) behave as in a real run.
    const result = await transformAsync(babelPath, source, {
      cwd: projectDir,
      root: projectDir,
      configFile,
      filename: path,
      compact: false,
    })
    return { contents: result.code, loader: 'js' }
  }
}

// The project's babel.config.(js|cjs|mjs|json), the one --babel takes.
function findBabelConfig(projectDir, command) {
  const configFile = ['babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json']
    .map((name) => join(projectDir, name))
    .find((file) => existsSync(file))
  if (!configFile) {
    throw new Error(`${command}: --babel found no babel.config.(js|cjs|mjs|json) in ${projectDir}`)
  }
  return configFile
}

// --babel for `stasis bundle --metro`: the project's babel.config.* for each file, loaded as Metro's
// transformer loads it (its `metro` caller, for `platform`) by @babel/core's `method` (loadPartialConfig,
// loadOptions) -- the config is project code, run here. -> (file) => what it loads, once a file
function projectBabelConfig({ projectDir, platform }, method) {
  const configFile = findBabelConfig(projectDir, 'stasis bundle')
  const [babelPath] = resolveFromProject(projectDir, ['@babel/core'], '--babel', 'stasis bundle')
  const babel = require(babelPath)
  const caller = { name: 'metro', bundler: 'metro', platform }
  const byFile = new Map()
  return (file) => {
    if (!byFile.has(file)) {
      try {
        byFile.set(file, babel[method]({ cwd: projectDir, root: projectDir, configFile, filename: file, caller }))
      } catch (cause) {
        throw new Error(`stasis bundle: --babel could not load ${configFile} for ${file}`, { cause })
      }
    }
    return byFile.get(file)
  }
}

// The file a plugin item names babel-plugin-module-resolver by resolves into this.
const MODULE_RESOLVER = /[\\/]node_modules[\\/]babel-plugin-module-resolver[\\/]/u

// --babel for `stasis bundle --metro`: the import aliases babel-plugin-module-resolver applies to
// each file under the project's babel.config.* (projectBabelConfig's partial config). The plugin's own
// resolvePath (or the config's custom one) maps each specifier, its `cwd` the project's where the
// config sets none, as Metro started there has it. Every instance the config lists, by name or as a
// value (`require`d or imported), counts, in order; one a preset adds doesn't.
// -> (file, specifier) => the specifier the plugin rewrites it to, else null
export function createBabelAliases({ projectDir, platform }) {
  const partialConfig = projectBabelConfig({ projectDir, platform }, 'loadPartialConfig')
  // The project's own copy, which a config passing the plugin as a value passes; none where the
  // project installs none.
  let projectPlugin
  try {
    projectPlugin = require(createRequire(join(projectDir, 'noop.js')).resolve('babel-plugin-module-resolver'))
  } catch {
    projectPlugin = null
  }
  // The module of a module-resolver plugin item, else null.
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
      // The first instance mapping it wins: the plugin marks the path it writes resolved, which
      // later instances leave as it is.
      if (mapped) return typeof mapped === 'string' && mapped !== specifier ? mapped : null
    }
    return null
  }
}

// --babel for `stasis bundle --metro`: whether Babel keeps a statement listing types alone in `file`
// (`import { type A } from` as `import {} from`), as its TypeScript transform does under
// `onlyRemoveTypeImports`, under the project's babel.config.* (projectBabelConfig's options).
// -> (file) => boolean
export function createBabelTypeImportsKept({ projectDir, platform }) {
  const options = projectBabelConfig({ projectDir, platform }, 'loadOptions')
  // No options: the config ignores the file.
  return (file) => (options(file)?.plugins ?? []).some((plugin) => plugin.key === 'transform-typescript' && plugin.options?.onlyRemoveTypeImports === true)
}

// babel-plugin-module-resolver's path tests, as it writes them.
const isRelativePath = (path) => /^\.?\.\//u.test(path)
const toLocalPath = (path) => {
  const local = path.replace(/\/index$/u, '')
  return isRelativePath(local) ? local : `./${local}`
}
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

// --babel-aliases for `stasis bundle --metro`: the import aliases of `alias`, babel-plugin-module-resolver's
// `alias` option as data (a JSON file's), mapped as the plugin maps them with `cwd` its own, as
// createBabelAliases has it: a key starting with `^` or ending with `$` is a regular expression whose
// groups the value's `\N` take, any other matches the specifier it is or one it starts with and `/`,
// whose rest the value keeps; the first key matching wins. A value starting with `./` or `../` is a
// path from `cwd`, written relative to the importing file; any other is the specifier as it is.
// -> (file, specifier) => the specifier it rewrites it to, else null
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
      // None where the mapping is empty.
      const mapped = substitute(groups)
      if (!mapped) return null
      const rewritten = isRelativePath(mapped) ? toLocalPath(relative(dirname(file), resolve(cwd, mapped)).replace(/\\/gu, '/')) : mapped
      return rewritten === specifier ? null : rewritten
    }
    return null
  }
}
