# `stasis sbom`

`stasis sbom` exports a Software Bill of Materials (SBOM) from one or more
stasis lockfiles (`stasis.lock.json`) and/or bundles (`stasis.code.br`), emitting
the package inventory they record in a standard, tool-agnostic format.

```sh
stasis sbom --format=(spdx|cyclonedx) [--output=(path|-)] path/to/(lockfile|bundle) ...
```

| Argument | Meaning |
| --- | --- |
| `--format` (**required**) | `spdx` (SPDX 2.3, JSON) or `cyclonedx` (CycloneDX 1.5, JSON). No default. |
| `--output` / `-o` | File to write to. Defaults to stdout; `-` is explicit stdout. Intermediate dirs are created as needed. |
| positional(s) | One or more lockfiles/bundles to inventory. |

The one-line summary always goes to stderr, so it never corrupts a document
streamed to stdout (e.g. `stasis sbom --format=spdx stasis.lock.json > sbom.json`).

## What it includes

Unlike `stasis audit` (installed dependencies only), an SBOM is the **full** bill
of materials: first-party/workspace packages alongside dependencies. Every package
bucket that records a `name` and `version` becomes one component.

- **Workspace root** (the `"."` bucket) is the document's *primary* component:
  `metadata.component` in CycloneDX, the `DESCRIBES` target in SPDX, typed
  `application`. When inputs (or a monorepo) yield more than one workspace package
  — or a `node_modules`-scope artifact yields none — there is no single subject:
  every package is listed as a plain component and SPDX `DESCRIBES` the workspace
  packages (or all of them, if none).
- **Dependencies** are typed `library`. The primary component `DEPENDS_ON` each
  (CycloneDX `dependencies`, SPDX relationships) — a flat graph.

Packages are deduplicated by ecosystem + name + version across all inputs and
sorted by name then version. Inventory is at the **package** level, not the file
level. Legacy `version: 0` bundles record no `name`/`version`, so they contribute nothing.

- **Vendored packages**, the copies a dependency keeps of others that a bundle
  lists in its record's `vendored` (Next.js's `dist/compiled/<dir>`, see
  `doc/file-formats.md`), are contained in it: nested in its `components` in
  CycloneDX, each `bom-ref` the host's with the directory as a purl subpath and
  the directory as its `evidence.occurrences` location; in SPDX, packages after
  the rest, `SPDXRef-Package-<n>-Vendored-<i>`, which the host `CONTAINS`, the
  directory as `packageFileName`. Only those a bundled file is in are listed,
  each under the name its own `package.json` gives, with the `version` it gives
  if any, and a purl only beside a version: Next.js's copies mostly record
  none, and a name without one names no release, nor always a registry package
  (Next.js calls its React `react-builtin`). Across inputs, a host lists the
  union of its copies. A lockfile records none. A dependency's `subpackages`
  (its own subpath entry points, `@hookform/resolvers/zod`) are its own code,
  not packages: none is listed.

## Package URLs

Each component carries a [purl](https://github.com/package-url/purl-spec), built
from the `ecosystem` each dependency records:

| Ecosystem | purl | Where it comes from |
| --- | --- | --- |
| `npm` | `pkg:npm/<name>@<version>` | `node_modules`, whatever the bundle language |
| `composer` | `pkg:composer/<vendor>/<name>@<version>` | PHP Composer `vendor/` |
| `cargo` | `pkg:cargo/<name>@<version>` | Rust crates vendored by `cargo vendor` from a registry |
| `cargo-git` | — (not crates.io's) | Rust crates vendored by `cargo vendor` from a git checkout (`.cargo-checksum.json` with `"package": null`) |
| `cargo-unknown` | — (maybe not crates.io's) | Rust crates vendored with no `.cargo-checksum.json`, from a registry or a git checkout |
| `github` | `pkg:github/<owner>/<repo>@<version>` | Solidity `forge install` git submodules |
| `soldeer` | — (no purl type) | Solidity Soldeer `dependencies/` |

npm scopes (`@scope/name`), Composer vendors, and GitHub owners map to the purl
namespace and the CycloneDX `group`; Composer and GitHub names are lowercased per
the purl spec. `soldeer`, `cargo-git` and `cargo-unknown` components carry a
name + version but no purl: `pkg:cargo` names crates.io's crate, which a crate
vendored from git, or from a source not known, may not be.
First-party/workspace packages take their purl ecosystem from the project itself.
Artifacts predating the per-dependency `ecosystem` field fall back to npm (or
Composer for a PHP bundle).

## Programmatic API (`@exodus/stasis/sbom`)

Exported as `@exodus/stasis/sbom`. It operates on already-parsed
`@exodus/stasis-core` `Bundle`/`Lockfile` instances, pulls in **no brotli**
(`node:zlib`), and never touches disk — the caller supplies the artifacts:

```js
import { Bundle } from '@exodus/stasis-core/bundle'
import { collectComponents, generateSbom, sbom, toCyclonedx, toSpdx } from '@exodus/stasis/sbom'

const bundle = Bundle.parse(json) // you read/decompress the artifact yourself
const doc = sbom('cyclonedx', [bundle]) // → a CycloneDX document (plain object)

// …or step by step:
const components = collectComponents([bundle])
const spdx = toSpdx(components, { now, uuid, tool })
```

- `collectComponents(artifacts)` — dedup + classify packages across instances.
- `toSpdx` / `toCyclonedx` / `generateSbom(format, …)` — render a document object.
- `sbom(format, artifacts, opts)` — the one-shot of the two above.
- `buildPurl(ecosystem, name, version)` — the purl helper.
- `opts` is `{ tool, now, uuid }`, for custom tool identity / deterministic output.

The `stasis sbom` CLI is the thin file-reading/-writing wrapper that brings in
brotli to read `.br` bundles off disk.

## Notes

- The generated document records `@exodus/stasis` (with its version) as the
  creating tool (SPDX `creationInfo.creators`, CycloneDX `metadata.tools`).
- `stasis sbom` does not reach the network — it reports exactly what the input
  artifacts attest. Pair it with `stasis audit` to cross-check those packages
  against published advisories.
