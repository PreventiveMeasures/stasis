// --flow (which --metro turns on), for `stasis bundle` and `stasis build`: Flow type syntax stripped, as Metro's
// Babel (@react-native/babel-preset) strips it, from a file marked `@flow` or one the parser can't read as it is,
// by flow-remove-types -- stasis's own dependency, never the project's, loaded lazily.
import { createRequire } from 'node:module'

// Flow type syntax lives in the JS (non-TS) family: flow-remove-types over a .ts/.tsx file would
// corrupt TS-only constructs. .jsx is included (JS + JSX, which can carry Flow types like .js);
// flow-remove-types preserves JSX.
export const FLOW_EXTS = new Set(['.js', '.cjs', '.mjs', '.jsx'])

// Whether `source` holds `@flow`, the pragma marking a Flow file, anywhere in it, as React Native's
// Babel preset finds it (/@flow/), to parse the file with hermes-parser, as Flow throughout: --flow
// strips such a file whether or not it parses as it is.
export const hasFlowPragma = (source) => source.includes('@flow')

// A comment marking a file `@noflow`, in which flow-remove-types reads syntax both Flow and JS can
// read (`f<T>(x)`, `a < b > (c)`) as JS (hermes-parser's `flow: 'detect'`), and none other; and
// what it leaves of it, the pragma blanked.
const NOFLOW = '\n/* @noflow */'
const NOFLOW_STRIPPED = `\n/* ${' '.repeat('@noflow'.length)} */`

let flowRemoveTypes

// `source` with its Flow types blanked in place (offsets kept), read as Metro's Babel reads it: one marked `@flow` as
// Flow throughout (`f<T>(x)` a call), any other with what JS can read too as JS (`a < b > (c)`), as flow-remove-types
// reads a `@noflow` file, marked so past its end. Flow code (`enum`s) stays. Throws where it can't parse `source`.
export function stripFlowTypes(source, { removeEmptyImports = false } = {}) {
  flowRemoveTypes ??= createRequire(import.meta.url)('flow-remove-types')
  if (hasFlowPragma(source)) return flowRemoveTypes(source, { all: true, removeEmptyImports }).toString()
  if (source.includes('@noflow')) return flowRemoveTypes(source, { removeEmptyImports }).toString()
  const stripped = flowRemoveTypes(source + NOFLOW, { removeEmptyImports }).toString()
  if (!stripped.endsWith(NOFLOW_STRIPPED)) throw new Error('flow-remove-types left the @noflow comment stasis appended')
  return stripped.slice(0, -NOFLOW_STRIPPED.length)
}
