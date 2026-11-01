// --flow, for `stasis bundle` (the scan) and `stasis build`: Flow type syntax stripped from a JS-family
// file, as Metro's Babel strips it (@react-native/babel-preset): one marked `@flow` (hasFlowPragma)
// whatever else it holds, any other where the parser can't read it as it is. By flow-remove-types --
// stasis's own dependency, resolved from stasis itself (never from the project) and loaded lazily,
// only under --flow, which --metro turns on.
import { createRequire } from 'node:module'

// Flow type syntax lives in the JS (non-TS) family: flow-remove-types over a .ts/.tsx file would
// corrupt TS-only constructs. .jsx is included (JS + JSX, which can carry Flow types like .js);
// flow-remove-types preserves JSX.
export const FLOW_EXTS = new Set(['.js', '.cjs', '.mjs', '.jsx'])

// Whether `source` holds `@flow`, the pragma marking a Flow file, anywhere in it, as React Native's
// Babel preset finds it (/@flow/), to parse the file with hermes-parser, as Flow throughout: --flow
// strips such a file whether or not it parses as it is.
export const hasFlowPragma = (source) => source.includes('@flow')

let flowRemoveTypes
// A comment marking a file `@noflow`, in which flow-remove-types reads syntax both Flow and JS can
// read (`f<T>(x)`, `a < b > (c)`) as JS (hermes-parser's `flow: 'detect'`), and none other; and
// what it leaves of it, the pragma blanked.
const NOFLOW = '\n/* @noflow */'
const NOFLOW_STRIPPED = `\n/* ${' '.repeat('@noflow'.length)} */`

// `source` with its Flow type syntax blanked to whitespace in place, so byte offsets and every import
// specifier are kept, read as Metro's Babel reads it: a file marked `@flow` (hasFlowPragma) as Flow
// throughout (`all: true`), as hermes-parser parses it there, so `f<T>(x)` is a call with a type
// argument; any other as Babel's own Flow parser reads it (`all: false`), its annotations Flow's and
// syntax JS can read too JS's (`a < b > (c)`, comparisons). flow-remove-types reads it so only in a
// file marked `@noflow`, so one not marked yet is, past its end, and cut off again.
// Types only: Flow syntax that is code -- `component` and `hook` declarations, `enum`s -- stays. An
// import listing types alone (`import { type A } from`) stays as `import {} from`, or with
// `removeEmptyImports` goes whole, as Babel's Flow transform drops it. Throws where flow-remove-types
// can't parse `source`.
export function stripFlowTypes(source, { removeEmptyImports = false } = {}) {
  flowRemoveTypes ??= createRequire(import.meta.url)('flow-remove-types')
  if (hasFlowPragma(source)) return flowRemoveTypes(source, { all: true, removeEmptyImports }).toString()
  if (source.includes('@noflow')) return flowRemoveTypes(source, { removeEmptyImports }).toString()
  const stripped = flowRemoveTypes(source + NOFLOW, { removeEmptyImports }).toString()
  if (!stripped.endsWith(NOFLOW_STRIPPED)) throw new Error('flow-remove-types left the @noflow comment stasis appended')
  return stripped.slice(0, -NOFLOW_STRIPPED.length)
}
