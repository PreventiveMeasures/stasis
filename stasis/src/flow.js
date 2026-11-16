// --flow (which --metro turns on): Flow type syntax stripped as Metro's Babel (@react-native/babel-preset) strips it,
// by flow-remove-types, and react-native's Flow code lowered by hermes-parser -- stasis's own dependencies, never the
// project's, loaded lazily.
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

// `source` with its Flow types blanked in place (offsets kept): one marked `@flow` as Flow throughout (`f<T>(x)` a
// call), any other as a `@noflow` file, marked so past its end. Flow code (`enum`s) stays. Throws where it can't parse.
function stripFlowTypes(source, { removeEmptyImports = false } = {}) {
  flowRemoveTypes ??= require('flow-remove-types')
  if (hasFlowPragma(source)) return flowRemoveTypes(source, { all: true, removeEmptyImports }).toString()
  if (source.includes('@noflow')) return flowRemoveTypes(source, { removeEmptyImports }).toString()
  const stripped = flowRemoveTypes(source + NOFLOW, { removeEmptyImports }).toString()
  if (!stripped.endsWith(NOFLOW_STRIPPED)) throw new Error('flow-remove-types left the @noflow comment stasis appended')
  return stripped.slice(0, -NOFLOW_STRIPPED.length)
}

// A file of the package installed as `react-native` (not of one nested in it), whose own sources use Flow code.
export const inReactNative = (path) => splitNodeModulesPath(toPosix(path))?.name === 'react-native'

// `source` with its Flow code (`component`, `hook`, `match`, `enum`) lowered as Metro's Babel lowers it, types kept:
// an `enum` as a call of `require('flow-enums-runtime')`. Throws where it can't parse.
function lowerFlowSyntax(source) {
  hermesParser ??= require('hermes-parser')
  generate ??= require('@babel/generator').default
  const flow = hasFlowPragma(source)
  const ast = hermesParser.parse(source, {
    babel: true,
    flow: flow ? 'all' : 'detect',
    sourceType: 'unambiguous',
    transformOptions: { TransformEnumSyntax: { enable: true } },
  })
  // On the lines it was read from, marked `@flow` as the source is (`comments: false` drops the mark).
  return (flow ? '/* @flow */' : '') + generate(ast, { comments: false, retainLines: true }).code
}

// `text` with its Flow types stripped, as `parse` reads it (falsy where it can't): `{ parsed, source, stripped }`,
// `stripped` blanking the types of `source` in place -- `text`, or in a file of react-native that stripping alone
// leaves unread, `text` with its Flow code lowered. Where neither is read, the plain strip, `parsed` null, with the
// `error` of an attempt that threw.
export function stripFlow(text, path, parse, { removeEmptyImports = false } = {}) {
  const read = (source) => {
    const stripped = stripFlowTypes(source, { removeEmptyImports })
    return { parsed: parse(stripped) || null, source, stripped }
  }
  let plain
  try {
    plain = read(text)
  } catch (error) {
    plain = { parsed: null, error }
  }
  if (plain.parsed !== null || !inReactNative(path)) return plain
  try {
    const lowered = read(lowerFlowSyntax(text))
    return lowered.parsed === null ? plain : lowered
  } catch (error) {
    return { ...plain, error }
  }
}
