import { satisfies, valid } from '@preventive/upstream/semver.js'

// Manual corrections to audit findings: files that must NOT count as evidence
// that a (potentially vulnerable) package's code is present. An import edge whose
// target is one of these files is not evidence the package is really used, so a
// package pulled in only through corrected files is skipped by the audit (see
// collectPackagesFromFile) -- none of its real code ships, so no advisory applies.
//
// Each entry names a package, the audit-irrelevant files (relative to the module
// dir), and `range` -- the semver range VERIFIED to match the rationale. The
// correction never applies outside it: a release could change the file, so the
// range is widened only after re-checking the file in the new versions.
const CORRECTIONS = [
  {
    // ws's browser build is a noop stub -- `module.exports = function () { throw
    // new Error('ws does not work in the browser...') }` -- with none of the
    // WebSocket implementation in it. Verified against the ws 8.22.0 tarball
    // (latest at the time of writing; browser.js is byte-identical since 8.21.1);
    // re-check browser.js before widening.
    name: 'ws',
    files: new Set(['browser.js']),
    range: '<=8.22.0',
  },
  {
    // node-fetch's browser build re-exports the environment's native fetch
    // (`module.exports = globalObject.fetch`, plus Headers/Request/Response) --
    // none of the node-fetch implementation, where its advisories live, is in it.
    // browser.js ships only through 2.7.0 (3.x dropped it); verified 2.6.13/2.7.0.
    name: 'node-fetch',
    files: new Set(['browser.js']),
    range: '<=2.7.0',
  },
]

// Is `rel` (a file path relative to the module dir) audit-irrelevant for
// `name@version`? Unknown or unparsable versions are never corrected (fail
// closed: the package stays audited).
function isCorrectedFile(name, version, rel) {
  for (const { name: pkg, files, range } of CORRECTIONS) {
    if (pkg !== name || !files.has(rel)) continue
    if (valid(version) && satisfies(version, range)) return true
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
// (or an edge targeting it) only when it passes. Manifests never do; corrected
// files (npm's) don't within their verified range.
export function isEvidenceFile(name, version, rel, ecosystem = 'npm') {
  return !isManifest(rel, ecosystem) && (ecosystem !== 'npm' || !isCorrectedFile(name, version, rel))
}
