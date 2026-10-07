import { satisfies, valid } from '@preventive/upstream/semver.js'

// Manual corrections to audit findings: files that must NOT count as evidence
// that a (potentially vulnerable) package's code is present. An import edge whose
// target is one of these files is not evidence the package is really used, so a
// package pulled in only through corrected files is skipped by the audit (see
// collectPackagesFromFile) -- none of its real code ships, so no advisory applies.
//
// Exported as `@exodus/stasis/audit-corrections`, as plain data, so a tool that
// lays out or reads packages without stasis -- a tree @preventive/deptree builds,
// a server reading bundles -- can apply the same corrections without its own copy.
// Each entry names a package of `ecosystem`, one audit-irrelevant `file` (relative
// to the module dir), `range` -- the semver range VERIFIED to match the rationale --
// and `integrity`, the sha512 of every distinct copy of `file` the versions in
// `range` publish, as a stasis lockfile records a file: a holder of the file's bytes
// can tell they are one of the copies verified. The correction never applies outside
// the range: a release could change the file, so the range is widened only after
// re-checking the file in the new versions, adding any new copy's integrity. Frozen,
// as the audit reads these very objects.
export const CORRECTIONS = Object.freeze([
  {
    // ws's browser build is a noop stub -- `module.exports = function () { throw
    // new Error('ws does not work in the browser...') }` -- with none of the
    // WebSocket implementation in it. browser.js ships from 6.0.0 on; every copy
    // through 8.22.0 (latest at the time of writing) is one of these two, which
    // differ only in a space; re-check browser.js before widening.
    ecosystem: 'npm',
    name: 'ws',
    file: 'browser.js',
    range: '<=8.22.0',
    integrity: [
      'sha512-98uEc4/THUpHCA7AQwBKLHHmxV6leyGmPkDAYZsoBiigxjKL8//TIb/oUKDUJLc+s/pwdGA9LR0F9e7nZHfXUQ==', // `function ()`: 6.0.0 - 6.1.1, 7.3.1 - 8.22.0
      'sha512-F7vx6oiX9vsFoxNPTudk20Hjp7IzJePAJCYaSoX9FMJ2JaGVcFx4Bkw5W7+I3a1DsonitnosbpuG1qAMsUwH7w==', // `function()`: 6.1.2 - 7.3.0
    ],
  },
  {
    // node-fetch's browser build re-exports the environment's native fetch
    // (`module.exports = globalObject.fetch`, plus Headers/Request/Response) --
    // none of the node-fetch implementation, where its advisories live, is in it.
    // browser.js ships only from 2.0.0 through 2.7.0 (3.x dropped it); every copy
    // in the range is one of these, which differ in how they find the global.
    ecosystem: 'npm',
    name: 'node-fetch',
    file: 'browser.js',
    range: '<=2.7.0',
    integrity: [
      'sha512-uCZB0X6rUVIf5lZU2NN9/Z1Fd6cPCLg4M9eduYxOgSP3QZNwi0/xSa/s6AUFtvLz4y4MK02SJihOIhDoFIzdiA==', // 2.0.0 - 2.1.1
      'sha512-toQ4RDdyjsAxTaxnaLs2AE56rXws+jMZV896U8pP0MSuKRiq8ZGKkOTMsvyCJoAJTbrgoQpr89H2n8+Z1ALcYA==', // 2.1.2
      'sha512-LOd+I1R3xYSCHFN9oj3xeN3wa7fYYx5XQKTiKkvWn4dSYVgHI2jsXZp0mJt5KlQg3ECXXh5UtpEW7kGu1dG/aQ==', // 2.2.0 - 2.2.1
      'sha512-2yo4Ysl+g09ocycwEBcN7IkSvM/KPpO9CW+1FI+0QfzvWJfaQepo+WEqn1/o5Og1weM14flcdv23hqZtxFXFUw==', // 2.3.0 - 2.6.0
      'sha512-WgHaZJVwFovVrKVySaKzxzXssn5kY8y3x8NJThodDRL9nwUxV7Q1z/RRzuLZ2lNkxabHLpG/l+vu7KQ2tGbP8g==', // 2.6.1 - 2.6.7
      'sha512-84sQFcu3uzgEsJOjIhz6tE8vInV1STCA4sX5EI9NK3Tt8n/Kb1serbKMz+YkdOAuCspHRiSUW2qV01z0wOgIXg==', // 2.6.8
      'sha512-SkBfLO20d2Ngr6nhxgh/Pt6Yqe6oW8EB99KSPq0lrW0se8jIiRF3YpOe7hHbfNWxuNCsKoZZT98uCJI9OJAa/Q==', // 2.6.9 - 2.7.0
    ],
  },
].map((correction) => Object.freeze({ ...correction, integrity: Object.freeze(correction.integrity) })))

// Is `rel` (a file path relative to the module dir) audit-irrelevant for
// `name@version` of `ecosystem`? Unknown or unparsable versions are never
// corrected (fail closed: the package stays audited).
function isCorrectedFile(name, version, rel, ecosystem) {
  for (const correction of CORRECTIONS) {
    if (correction.ecosystem !== ecosystem || correction.name !== name || correction.file !== rel) continue
    if (valid(version) && satisfies(version, correction.range)) return true
  }
  return false
}

// A manifest (top-level or nested) is never code: the resolution graph records
// resolver/metadata reads of `package.json` as edges (react-native scans sibling
// packages' manifests for Haste/asset resolution) and consumers record them
// alongside bundled files, but no package code ships through one. So too for the
// manifests the other ecosystems' bundles carry beside a dependency's code
// (--cargo-manifests, --manifests): its Cargo.toml and the checksums cargo vendored
// it with (a registry's copy, a git checkout's, or one whose source isn't known),
// its composer.json, a Solidity dependency's foundry.toml and remappings.
const CARGO_MANIFESTS = new Set(['Cargo.toml', 'Cargo.lock', '.cargo-checksum.json'])
const MANIFESTS = {
  npm: new Set(['package.json']),
  cargo: CARGO_MANIFESTS,
  'cargo-git': CARGO_MANIFESTS,
  'cargo-unknown': CARGO_MANIFESTS,
  composer: new Set(['composer.json', 'composer.lock']),
  soldeer: new Set(['package.json', 'foundry.toml', 'remappings.txt', 'soldeer.toml']),
  github: new Set(['package.json', 'foundry.toml', 'remappings.txt', 'soldeer.toml']),
}
const isManifest = (rel, ecosystem) => MANIFESTS[ecosystem]?.has(rel.slice(rel.lastIndexOf('/') + 1)) ?? false

// Is `rel` evidence that `name@version`'s REAL code is present, of a dependency of
// `ecosystem` (npm by default)? This is the one rule every audit surface shares --
// package presence, the reason column, and the --why chain graph all count a file
// (or an edge targeting it) only when it passes. Manifests never do; CORRECTIONS'
// files don't within their verified range.
export function isEvidenceFile(name, version, rel, ecosystem = 'npm') {
  return !isManifest(rel, ecosystem) && !isCorrectedFile(name, version, rel, ecosystem)
}
