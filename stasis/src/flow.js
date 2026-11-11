// --flow (which --metro turns on): Flow type syntax stripped as Metro's Babel (@react-native/babel-preset) strips it,
// by flow-remove-types -- stasis's own dependency, never the project's, loaded lazily.
import { createRequire } from 'node:module'

// The JS family alone: flow-remove-types would corrupt TS-only constructs. It preserves JSX.
export const FLOW_EXTS = new Set(['.js', '.cjs', '.mjs', '.jsx'])

// Anywhere in the file, as React Native's Babel preset finds it (/@flow/), to parse the file as Flow throughout.
export const hasFlowPragma = (source) => source.includes('@flow')

// In a file marked `@noflow`, flow-remove-types reads syntax both Flow and JS can read (`f<T>(x)`, `a < b > (c)`) as
// JS (hermes-parser's `flow: 'detect'`). NOFLOW_STRIPPED is what it leaves of the comment.
const NOFLOW = '\n/* @noflow */'
const NOFLOW_STRIPPED = `\n/* ${' '.repeat('@noflow'.length)} */`

let flowRemoveTypes

// `source` with its Flow types blanked in place (offsets kept): one marked `@flow` as Flow throughout (`f<T>(x)` a
// call), any other as a `@noflow` file, marked so past its end. Flow code (`enum`s) stays. Throws where it can't parse.
export function stripFlowTypes(source, { removeEmptyImports = false } = {}) {
  flowRemoveTypes ??= createRequire(import.meta.url)('flow-remove-types')
  if (hasFlowPragma(source)) return flowRemoveTypes(source, { all: true, removeEmptyImports }).toString()
  if (source.includes('@noflow')) return flowRemoveTypes(source, { removeEmptyImports }).toString()
  const stripped = flowRemoveTypes(source + NOFLOW, { removeEmptyImports }).toString()
  if (!stripped.endsWith(NOFLOW_STRIPPED)) throw new Error('flow-remove-types left the @noflow comment stasis appended')
  return stripped.slice(0, -NOFLOW_STRIPPED.length)
}
