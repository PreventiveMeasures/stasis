# `stasis diff`

`stasis diff` compares two artifacts, lockfiles (`stasis.lock.json`) or
bundles (`stasis.code.br`) in any combination, by module (package) and by
file. A [`.stasis.tgz`](file-formats.md#stasistgz) is compared as the bundle of
its files.

```sh
stasis diff --stat [--imports] path/to/(lockfile|bundle|name.stasis.tgz) path/to/(lockfile|bundle|name.stasis.tgz)
```

| Flag | Meaning |
| - | - |
| `--stat` | Required for now: print *what* changed, not the differing contents. A bare `stasis diff` is kept for a future content-level diff. |
| `--imports` | Also diff the [resolution graphs](#import-resolutions---imports). |

Pass exactly two files: the baseline (`from`), then the comparison (`to`).
Exits 0 when they are equivalent, 1 when they differ; a read or parse error
also exits non-zero.

## Comparing across kinds (lockfile vs bundle)

A lockfile records each file as an SRI digest (`sha512-<base64>`), a bundle its
bytes, which `stasis diff` hashes into that digest (decoding `resource:base64`
first): a byte-identical file never shows as a difference.

## What it reports

**Modules**:

- **added** / **removed** — a package directory on only one side (the
  workspace `"."` bucket, a `node_modules/<pkg>` dependency, …), shown with its
  `name@version` and file count.
- **changed** — a package on both sides whose `name`, `version` or `repo` (its
  GitHub repository) differs, where both sides record one; a `repo` differs in
  any field (`github` compared case-insensitively), including a `directory` or
  `commit` only one side records. An `integrity` or `patch` that differs, or
  that only one side records, is a change too.

**Files** (within packages present on **both** sides):

- **added** / **removed** — a file that appears or disappears inside a shared package.
- **differing** — a file present on both sides whose content digest differs.

| Marker | Meaning |
| - | - |
| `-` | only in the first (baseline) file |
| `+` | only in the second file |
| `*` | changed in place |

## Import resolutions (`--imports`)

Lockfiles and bundles record a resolution graph: per condition set, the file
each `(parent, specifier)` import resolved to. `--imports` compares those files
with conditions ignored, so a statically built `"*"` bundle and a runtime
lockfile's precise condition sets (such as `"node, import"`) compare cleanly:

- **removed** — resolved only by the first artifact;
- **added** — only by the second;
- **changed** — on both sides, but to a *different* file (a **redirect**),
  which exits non-zero even when every file hash is unchanged.

When either side records no resolutions (a lockfile written before stasis
recorded `imports`), the import diff is skipped with a note.

## Scope differences

Each artifact records its `scope` (`full` or `node_modules`); a mismatch is
noted in the header. A `full` side against a `node_modules` one shows the
workspace/first-party packages as **removed** modules, and a full lockfile
against a code-only `stasis.code.br` shows resource files as **removed**.

## Programmatic API (`@exodus/stasis/diff`)

It takes parsed `@exodus/stasis-core` `Bundle`/`Lockfile` instances, each
paired with its `kind`, and uses no disk, brotli (`node:zlib`) or crypto
(`node:crypto`): a bundle needs the caller's `hash`, which turns its bytes into
a lockfile-style digest.

```js
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { diffArtifacts, formatDiffStat, hasDifferences, normalizeArtifact } from '@exodus/stasis/diff'

const lock = { artifact: Lockfile.parse(lockText), kind: 'lockfile' }
const bundle = { artifact: Bundle.parse(bundleJson), kind: 'bundle' } // you read/decompress it yourself

// `hash` is needed only when a bundle is involved.
const diff = diffArtifacts(lock, bundle, { hash: sha512integrity, imports: true })
if (hasDifferences(diff)) console.log(formatDiffStat(diff, { left: 'a', right: 'b', leftKind: 'lockfile', rightKind: 'bundle' }))
```

- `normalizeArtifact({ artifact, kind }, { hash })` — project an artifact onto
  the shared digest space.
- `diffArtifacts(left, right, { hash, imports })` — the structured
  `{ scope, modules, files, imports? }` report (`left` is the baseline;
  `imports` included only when `imports: true`).
- `hasDifferences(diff)` — whether any module/file/import edge changed.
- `formatDiffStat(diff, labels)` — render the `--stat` summary string.

The CLI reads the files (with brotli for `.br` bundles) and passes
`sha512integrity` as the hash.
