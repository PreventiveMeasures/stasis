// --flow, for `stasis bundle` (the scan) and `stasis build`: Flow type syntax stripped from a JS-family
// file the parser can't read otherwise, by flow-remove-types -- stasis's own dependency, resolved from
// stasis itself (never from the project) and loaded lazily, only under --flow.
import { createRequire } from 'node:module'

// Flow type syntax lives in the JS (non-TS) family: flow-remove-types over a .ts/.tsx file would
// corrupt TS-only constructs. .jsx is included (JS + JSX, which can carry Flow types like .js);
// flow-remove-types preserves JSX.
export const FLOW_EXTS = new Set(['.js', '.cjs', '.mjs', '.jsx'])

let flowRemoveTypes

// `source` with its Flow type syntax blanked to whitespace in place, so byte offsets and every import
// specifier are kept. `all: true` ignores the @flow/@noflow pragma (React Native's sources mix both).
// Types only: Flow syntax that is code -- `component` and `hook` declarations, `enum`s -- stays. An
// import listing types alone (`import { type A } from`) stays as `import {} from`, or with
// `removeEmptyImports` goes whole, as Babel's Flow transform drops it. Throws where flow-remove-types
// can't parse `source`.
export function stripFlowTypes(source, { removeEmptyImports = false } = {}) {
  flowRemoveTypes ??= createRequire(import.meta.url)('flow-remove-types')
  return flowRemoveTypes(source, { all: true, removeEmptyImports }).toString()
}
