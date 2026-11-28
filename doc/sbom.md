# `stasis sbom`

`stasis sbom` exports the package inventory that one or more lockfiles
(`stasis.lock.json`) and/or bundles (`stasis.code.br`) record as a Software
Bill of Materials (SBOM). A [`.stasis.tgz`](file-formats.md#stasistgz) is read
as the bundle of its files.

```sh
stasis sbom --format=(spdx|cyclonedx) [--output=(path|-)] path/to/(lockfile|bundle|name.stasis.tgz) ...
```

| Argument | Meaning |
| --- | --- |
| `--format` (**required**) | `spdx` (SPDX 2.3, JSON) or `cyclonedx` (CycloneDX 1.5, JSON). |
| `--output` / `-o` | File to write, its directories created as needed. Default `-`, stdout. |
| positional(s) | One or more lockfiles/bundles to inventory. |

The one-line summary goes to stderr.

## What it includes

Every package bucket that records a `name` and `version`, first-party or
dependency, becomes one component, deduplicated by ecosystem + name + version
across inputs and sorted by name then version.

- **Workspace root** (the `"."` bucket) is the document's *primary* component,
  typed `application`: `metadata.component` in CycloneDX, the `DESCRIBES`
  target in SPDX. With more than one workspace package (several inputs, or a
  monorepo) or none (a `node_modules`-scope artifact), there is no primary:
  every package is a plain component, and SPDX `DESCRIBES` the workspace
  packages, else every package.
- **Dependencies** are typed `library`. The primary `DEPENDS_ON` each, as a
  flat graph (CycloneDX `dependencies`, SPDX relationships).
- **Vendored packages**, copies of other packages listed in a dependency's
  `vendored` (Next.js's `dist/compiled/<dir>`, see `doc/file-formats.md`), are
  placed inside their host:
  - CycloneDX: nested in its `components`, each `bom-ref` the host's with the
    directory as a purl subpath, the directory as `evidence.occurrences`
    location.
  - SPDX: `SPDXRef-Package-<n>-Vendored-<i>`, after the other packages, which
    the host `CONTAINS`, the directory as `packageFileName`.

  Only copies holding a bundled file are listed, under the name and `version`
  (if any) of their own `package.json`, with a purl only if versioned. A host
  lists the union of its copies across inputs; lockfiles record them as
  bundles do. A dependency's `subpackages` (its own subpath entry points,
  `@hookform/resolvers/zod`) are its own code, not listed.

## Package URLs

A component's [purl](https://github.com/package-url/purl-spec), if any, is built
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

npm scopes (`@scope/name`), Composer vendors and GitHub owners map to the purl
namespace and the CycloneDX `group` (an `npm:directory` package's scope to the
`group` too); Composer and GitHub names are lowercased per the purl spec.
Workspace packages take their purl ecosystem from the project itself;
artifacts predating the per-dependency `ecosystem` field fall back to npm (or
Composer for a PHP bundle).

## Programmatic API (`@exodus/stasis/sbom`)

It takes parsed `@exodus/stasis-core` `Bundle`/`Lockfile` instances and uses
no disk or brotli (`node:zlib`):

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

The CLI reads and writes the files (with brotli for `.br` bundles).

## Notes

- The document records `@exodus/stasis` (with its version) as the creating
  tool (SPDX `creationInfo.creators`, CycloneDX `metadata.tools`).
- `stasis sbom` makes no network requests; it reports exactly what the
  artifacts attest.
