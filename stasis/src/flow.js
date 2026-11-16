// --flow (which --metro turns on): Flow type syntax stripped as Metro's Babel (@react-native/babel-preset) strips it,
// by flow-remove-types -- stasis's own dependency, never the project's, loaded lazily.
import { createRequire } from 'node:module'
import { splitNodeModulesPath, toPosix } from '@exodus/stasis-core/util'

const require = createRequire(import.meta.url)

// The JS family alone: flow-remove-types would corrupt TS-only constructs. It preserves JSX.
export const FLOW_EXTS = new Set(['.js', '.cjs', '.mjs', '.jsx'])

// Anywhere in the file, as React Native's Babel preset finds it (/@flow/), to parse the file as Flow throughout.
export const hasFlowPragma = (source) => source.includes('@flow')

// In a file marked `@noflow`, flow-remove-types reads syntax both Flow and JS can read (`f<T>(x)`, `a < b > (c)`) as
// JS (hermes-parser's `flow: 'detect'`). NOFLOW_STRIPPED is what it leaves of the comment.
const NOFLOW = '\n/* @noflow */'
const NOFLOW_STRIPPED = `\n/* ${' '.repeat('@noflow'.length)} */`

let flowRemoveTypes
let hermesParser
let generate

// `source` with its Flow types blanked in place (offsets kept): one marked `@flow` (or `all`) as Flow throughout
// (`f<T>(x)` a call), any other as a `@noflow` file, marked so past its end. Flow code (`enum`s) stays. Throws where
// it can't parse.
export function stripFlowTypes(source, { removeEmptyImports = false, all = hasFlowPragma(source) } = {}) {
  flowRemoveTypes ??= require('flow-remove-types')
  if (all) return flowRemoveTypes(source, { all: true, removeEmptyImports }).toString()
  if (source.includes('@noflow')) return flowRemoveTypes(source, { removeEmptyImports }).toString()
  const stripped = flowRemoveTypes(source + NOFLOW, { removeEmptyImports }).toString()
  if (!stripped.endsWith(NOFLOW_STRIPPED)) throw new Error('flow-remove-types left the @noflow comment stasis appended')
  return stripped.slice(0, -NOFLOW_STRIPPED.length)
}

// A file of the package installed as `react-native` (not of one nested in it). Its own sources use Flow syntax that
// compiles to code, which stripping leaves (`component` in View.js since 0.81, in Text.js since 0.85): only there is
// that syntax lowered, and only where stripping alone fails.
export const inReactNative = (path) => splitNodeModulesPath(toPosix(path))?.name === 'react-native'

// `source` with its Flow syntax that compiles to code lowered as Metro's Babel lowers it, by hermes-parser (stasis's
// own, as flow-remove-types is): `component` and `hook` declarations as functions, `match` as conditionals, and an
// `enum` as a call of `require('flow-enums-runtime')`, as babel-plugin-transform-flow-enums builds it. A component's
// `ref` goes through `React.forwardRef`, hermes-parser's default `reactRuntimeTarget`: RN's preset passes '19' to
// babel-plugin-syntax-hermes-parser, which never hands it to the parser. `lowered` keeps the types, which `stripped`
// blanks in place. Throws where it can't parse.
export function lowerFlowSyntax(source, { removeEmptyImports = false } = {}) {
  hermesParser ??= require('hermes-parser')
  generate ??= require('@babel/generator').default
  const all = hasFlowPragma(source)
  const ast = hermesParser.parse(source, {
    babel: true,
    flow: all ? 'all' : 'detect',
    sourceType: 'unambiguous',
    transformOptions: { TransformEnumSyntax: { enable: true } },
  })
  // On the lines it was read from, so a diagnostic in it names the source's line.
  const lowered = generate(ast, { comments: false, retainLines: true }).code
  return { lowered, stripped: stripFlowTypes(lowered, { removeEmptyImports, all }) }
}
