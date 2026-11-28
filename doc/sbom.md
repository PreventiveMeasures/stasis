# `stasis sbom`

`stasis sbom` exports the package inventory that one or more stasis lockfiles
(`stasis.lock.json`) and/or bundles (`stasis.code.br`) record as a Software
Bill of Materials (SBOM). A [`.stasis.tgz`](file-formats.md#stasistgz) is read
as the bundle of its files.

```sh
stasis sbom --format=(spdx|cyclonedx) [--output=(path|-)] path/to/(lockfile|bundle|name.stasis.tgz) ...
```

| Argument | Meaning |
| --- | --- |
| `--format` (**required**) | `spdx` (SPDX 2.3, JSON) or `cyclonedx` (CycloneDX 1.5, JSON). No default. |
| `--output` / `-o` | File to write to. Defaults to stdout; `-` is explicit stdout. Intermediate dirs are created as needed. |
| positional(s) | One or more lockfiles/bundles to inventory. |

The one-line summary always goes to stderr, never into a document written to
stdout (e.g. `stasis sbom --format=spdx stasis.lock.json > sbom.json`).

## What it includes

The SBOM lists first-party/workspace packages as well as dependencies: every
package bucket that records a `name` and `version` becomes one component.

- **Workspace root** (the `"."` bucket) is the document's *primary* component:
  `metadata.component` in CycloneDX, the `DESCRIBES` target in SPDX, typed
  `application`. When inputs (or a monorepo) yield more than one workspace
  package, or a `node_modules`-scope artifact yields none, there is no primary
  component: every package is a plain component, and SPDX `DESCRIBES` the
  workspace packages (or every package, if there are none).
- **Dependencies** are typed `library`. The primary component `DEPENDS_ON` each
  (CycloneDX `dependencies`, SPDX relationships), as a flat graph.

Packages are deduplicated by ecosystem + name + version across all inputs and
sorted by name then version. Inventory is at the **package** level, not the file
level. Legacy `version: 0` bundles record no `name`/`version`, so they contribute nothing.

- **Vendored packages**, copies of other packages that a dependency ships and
  an artifact lists in its record's `vendored` (Next.js's `dist/compiled/<dir>`,
  see `doc/file-formats.md`), are placed inside their host: in CycloneDX, nested
  in its `components`, each `bom-ref` the host's with the directory as a purl
  subpath, and the directory as its `evidence.occurrences` location; in SPDX, as
  packages after the rest, `SPDXRef-Package-<n>-Vendored-<i>`, which the host
  `CONTAINS`, with the directory as `packageFileName`. Only copies holding a
  bundled file are listed, each under the name and (if any) `version` its own
  `package.json` gives, with a purl only if it has a version (most of Next.js's
  copies don't). Across inputs, a host lists the union of its copies. Lockfiles
  record them as bundles do. A dependency's `subpackages` (its own subpath entry
  points, `@hookform/resolvers/zod`) are its own code and not listed.

## Package URLs

Each component carries a [purl](https://github.com/package-url/purl-spec), built
from the `ecosystem` each dependency records:

| Ecosystem | purl | Where it comes from |
| --- | --- | --- |
| `npm` | `pkg:npm/<name>@<version>` | `node_modules`, whatever the bundle language |
| `npm:directory` | — (not the registry's) | npm packages installed from a directory (a `file:` one), which pnpm and yarn copy into `node_modules` |
| `composer` | `pkg:composer/<vendor>/<name>@<version>` | PHP Composer `vendor/` |
| `cargo` | `pkg:cargo/<name>@<version>` | Rust crates vendored by `cargo vendor` from a registry |
| `cargo-git` | — (not crates.io's) | Rust crates vendored by `cargo vendor` from a git checkout (`.cargo-checksum.json` with `"package": null`) |
| `cargo-unknown` | — (maybe not crates.io's) | Rust crates vendored with no `.cargo-checksum.json`, from a registry or a git checkout |
| `github` | `pkg:github/<owner>/<repo>@<version>` | Solidity `forge install` git submodules |
| `soldeer` | — (no purl type) | Solidity Soldeer `dependencies/` |

npm scopes (`@scope/name`), Composer vendors, and GitHub owners map to the purl
namespace and the CycloneDX `group` (an `npm:directory` package's scope to the
`group` too); Composer and GitHub names are lowercased per the purl spec.
`soldeer`, `cargo-git`, `cargo-unknown` and `npm:directory` components carry a
name and version but no purl.
First-party/workspace packages take their purl ecosystem from the project itself.
Artifacts predating the per-dependency `ecosystem` field fall back to npm (or
Composer for a PHP bundle).

## Programmatic API (`@exodus/stasis/sbom`)

It takes already-parsed `@exodus/stasis-core` `Bundle`/`Lockfile` instances,
pulls in **no brotli** (`node:zlib`), and never touches disk; the caller
supplies the artifacts:

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
- `sbom(format, artifacts, opts)` — both of the above in one call.
- `buildPurl(ecosystem, name, version)` — the purl helper.
- `opts` is `{ tool, now, uuid }`, for custom tool identity / deterministic output.

The `stasis sbom` CLI wraps this API, reading and writing the files (with
brotli for `.br` bundles).

## Notes

- The generated document records `@exodus/stasis` (with its version) as the
  creating tool (SPDX `creationInfo.creators`, CycloneDX `metadata.tools`).
- `stasis sbom` makes no network requests; it reports exactly what the input
  artifacts attest. Use `stasis audit` to check those packages against
  published advisories.
