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
// createBabelAliases): the scan still reads each file's own source.
//
// Babel is the PROJECT's dev dependency, not stasis's: @babel/core (and, for hermes, the
// two transform plugins) resolve from the project directory, so the project pins its own
// Babel toolchain and config semantics.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

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

// A plugin item of babel-plugin-module-resolver, however the config names it (by its resolved file).
const MODULE_RESOLVER = /[\\/]node_modules[\\/]babel-plugin-module-resolver[\\/]/u

// --babel for `stasis bundle --metro`: the import aliases babel-plugin-module-resolver applies to
// each file under the project's babel.config.*, loaded as Metro's transformer loads it (its `metro`
// caller, for `platform`) -- the config is project code, run here. The plugin's own resolvePath (or
// the config's custom one) maps each specifier, its `cwd` the project's where the config sets none,
// as Metro started there has it. Only a plugin the config lists itself counts, not one a preset adds.
// -> (file, specifier) => the specifier the plugin rewrites it to, else null
export function createBabelAliases({ projectDir, platform }) {
  const configFile = findBabelConfig(projectDir, 'stasis bundle')
  const [babelPath] = resolveFromProject(projectDir, ['@babel/core'], '--babel', 'stasis bundle')
  const babel = require(babelPath)
  const caller = { name: 'metro', bundler: 'metro', platform }
  // file -> { resolvePath, options } of the module-resolver its config applies, else null.
  const byFile = new Map()
  const aliasingOf = (file) => {
    if (byFile.has(file)) return byFile.get(file)
    let partial
    try {
      partial = babel.loadPartialConfig({ cwd: projectDir, root: projectDir, configFile, filename: file, caller })
    } catch (cause) {
      throw new Error(`stasis bundle: --babel could not load ${configFile} for ${file}`, { cause })
    }
    // null: the config ignores the file.
    const item = partial?.options.plugins?.find((plugin) => MODULE_RESOLVER.test(plugin.file?.resolved ?? ''))
    let aliasing = null
    if (item) {
      const options = { cwd: projectDir, ...item.options }
      aliasing = { resolvePath: typeof options.resolvePath === 'function' ? options.resolvePath : require(item.file.resolved).resolvePath, options }
    }
    byFile.set(file, aliasing)
    return aliasing
  }
  return (file, specifier) => {
    const aliasing = aliasingOf(file)
    const mapped = aliasing?.resolvePath(specifier, file, aliasing.options)
    return typeof mapped === 'string' && mapped !== specifier ? mapped : null
  }
}
