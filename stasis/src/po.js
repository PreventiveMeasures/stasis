// --po, for `stasis build`: each gettext `.po` file the build reaches built into the module
// @exodus/i18n builds of it, from the bytes the artifact carries.
//
// @exodus/i18n imports a translation catalog as a `.po` file (`import de from './locales/de/messages.po'`),
// which two build steps of @exodus/i18n-babel-webpack (@exodus/i18n's own before 5.x) turn into code:
//
// - Its webpack loader (webpack-loader, webpack5-loader) makes the `.po` a module of its own.
// - Its Babel plugin-inline-po, for a build without webpack (Metro), puts the same catalog in place of each
//   `require('./messages.po')`. It reads the file by its path from the requiring file's directory. A
//   `--metro` bundle records no edge to the `.po`, as Metro never sees the import.
//
// Both go through the same `babel/transform.js`, which parses the file with @exodus/pofile and compiles
// each entry's message into ICU tokens, keyed by the entry's id:
//
//   module.exports={"Hello {}":[{"type":"text","value":"Hallo "},{"type":"arg","name":"name","position":0}]};
//
// The id and the tokens depend on the version: @exodus/pofile 3.4 keeps a message's `\n` escape as
// written, 3.3 unescapes it, and @exodus/i18n 4.x keys an entry by its msgid alone, without its context.
// The @exodus/i18n client in the app looks an entry up by the id its own @exodus/pofile computes. So the
// build compiles with the project's own transform, as the project's own build does. A copy in stasis would
// drift from the app's version, and its translations would quietly fall back to the source text.
// Like --babel's Babel, the transform is the project's dependency, never stasis's.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PO_EXT = '.po'

const TRANSFORM = '@exodus/i18n-babel-webpack/babel/transform.js'

// `specifier` resolved by `require`, else null.
function tryResolve(require, specifier) {
  try {
    return require.resolve(specifier)
  } catch {
    return null
  }
}

// The project's catalog transform: its own @exodus/i18n-babel-webpack's, as its webpack config or
// babel.config.* names it, else that of its @exodus/i18n, the @exodus/i18n-babel-webpack 5.x depends
// on or 4.x's own babel/transform.js. -> its absolute path, else null
export function resolvePoTransform(projectDir) {
  const projectRequire = createRequire(join(projectDir, 'noop.js'))
  const own = tryResolve(projectRequire, TRANSFORM)
  if (own !== null) return own
  const i18n = tryResolve(projectRequire, '@exodus/i18n/package.json')
  if (i18n === null) return null
  const viaI18n = tryResolve(createRequire(i18n), TRANSFORM)
  if (viaI18n !== null) return viaI18n
  const legacy = join(dirname(i18n), 'babel', 'transform.js')
  return existsSync(legacy) ? legacy : null
}

// The project's catalog transform, loaded: (content) => the catalog module's code, as the webpack loader
// calls it. Resolved from `projectDir` up front, so a missing install fails with instructions before
// esbuild runs, not on the first `.po`.
export async function loadPoTransform(projectDir) {
  const file = resolvePoTransform(projectDir)
  if (file === null) {
    throw new Error(
      'stasis build: --po builds each .po with the project\'s @exodus/i18n-babel-webpack (or its @exodus/i18n\'s), ' +
      `which could not be resolved from ${projectDir}; install it in the project (e.g. \`npm i -D @exodus/i18n-babel-webpack\`)`
    )
  }
  let mod
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (cause) {
    // Its compile.js requires @babel/generator and @babel/types, peer dependencies the project installs.
    throw new Error(`stasis build: --po could not load ${file} (it needs @babel/generator and @babel/types installed in the project)`, { cause })
  }
  const transform = mod.default
  if (typeof transform !== 'function') throw new Error(`stasis build: --po expected ${file} to export the .po transform as its default, a function`)
  return { file, transform, name: packageOf(file) ?? file }
}

// `name@version` of the package whose babel/transform.js `file` is, else null.
function packageOf(file) {
  try {
    const { name, version } = JSON.parse(readFileSync(join(dirname(dirname(file)), 'package.json'), 'utf8'))
    return typeof name === 'string' && typeof version === 'string' ? `${name}@${version}` : null
  } catch {
    return null
  }
}

// StasisEsbuild's `resource` hook for a `.po`: the module the transform makes of the file, from the bytes
// the artifact carries, decoded as UTF-8, as the webpack loader decodes the file it reads. One it can't
// compile is the file's error, as esbuild reports a load's. `relativeOf(path)` names the file in it.
export function createPoModule({ file, transform }, relativeOf) {
  return (source, { path }) => {
    const content = Buffer.isBuffer(source) ? source.toString('utf8') : source
    let contents
    try {
      contents = transform(content)
    } catch (err) {
      return { errors: [{ text: `--po could not compile ${relativeOf(path)} with ${file}: ${err?.message ?? err}` }] }
    }
    if (typeof contents !== 'string') return { errors: [{ text: `--po: ${file} made no code of ${relativeOf(path)}` }] }
    return { contents, loader: 'js' }
  }
}

// A `.po` that plugin-inline-po would read: one an import names relative to the importing file, as `./`
// or `../`. plugin-inline-po reads a path by joining it to the file's directory, and the Metro capture
// carries only such paths.
export const isRelativePo = (specifier) => /^\.\.?\//u.test(specifier) && specifier.endsWith(PO_EXT)
