# `stasis diff`

`stasis diff` compares two stasis artifacts, lockfiles (`stasis.lock.json`)
or bundles (`stasis.code.br`) in any combination, and reports what changed at
the **module** (package) and the **file** level. A
[`.stasis.tgz`](file-formats.md#stasistgz) is compared as the bundle of its files.

```sh
stasis diff --stat [--imports] path/to/(lockfile|bundle|name.stasis.tgz) path/to/(lockfile|bundle|name.stasis.tgz)
```

| Flag | Meaning |
| - | - |
| `--stat` (**required** for now) | Print *what* changed (added/removed/changed modules, added/removed/differing files), not the differing contents. |
| `--imports` (optional) | Also diff the **resolution graphs**: added/removed/redirected import edges (see below). Off by default. |

`--stat` is the only mode and must be explicit (a future content-level diff
will take the bare invocation). Pass exactly two positionals: the baseline
(`from`), then the comparison (`to`).

Exits **0** when equivalent, **1** when they differ (a read/parse error also
exits non-zero).

## Comparing across kinds (lockfile vs bundle)

A lockfile records each file as an SRI digest (`sha512-<base64>`); a bundle
records the bytes. `stasis diff` hashes each bundle file into that digest
(decoding `resource:base64` first), so a byte-identical file never shows as a
difference.

## What it reports

**Modules** (whole-package granularity):

- **added** / **removed** — a package directory on only one side (the
  workspace `"."` bucket, a `node_modules/<pkg>` dependency, …), shown with its
  `name@version` and file count.
- **changed** — a package on both sides whose `name`, `version` or `repo` (the
  dependency's GitHub repository) differs, when both sides record one. A `repo`
  differs in any of its fields (`github` compared case-insensitively), including
  a `directory` or `commit` only one side records. A legacy `version: 0` bundle
  records no name or version, and a lockfile or a bundle from before `repo`
  records no `repo`, so neither is flagged for lacking one. An `integrity` or
  `patch` that differs, or that only one side records, is a change.

**Files** (within packages present on **both** sides):

- **added** / **removed** — a file that appears or disappears inside a shared package.
- **differing** — a file present on both sides whose content digest differs.

Files are counted only within shared packages: a package on one side only is
counted once as an added/removed **module** (with its file count), and its files
are *not* listed. So removing a whole 200-file dependency shows as
`- pkg (200 files)` under **Modules** while the Files line stays `0 removed`.

| Marker | Meaning |
| - | - |
| `-` | only in the first (baseline) file |
| `+` | only in the second file |
| `*` | changed in place |

## Import resolutions (`--imports`)

Lockfiles and bundles record a **resolution graph**: per condition set, the
file each `(parent, specifier)` import resolved to. `--imports` compares the
files each `(parent, specifier)` resolves to and reports each as:

- **removed** — resolved only by the first artifact;
- **added** — resolved only by the second;
- **changed** — resolved on both sides but to a *different* file (a **redirect**).

`--imports` exits non-zero on a redirect even when every file hash is
unchanged. Conditions are ignored, so a statically built `"*"` bundle and a
runtime lockfile's precise condition sets (e.g. `"node, import"`) compare
cleanly. When either side doesn't record resolutions (a lockfile written before
stasis recorded `imports`), the import diff is skipped with a note.

## Scope differences

Each artifact records its `scope` (`full` or `node_modules`); a mismatch is noted
in the header. Diffing a `full` side against a `node_modules` side reports
workspace/first-party packages as **removed** modules; diffing a full lockfile
against a code-only `stasis.code.br` reports resource files as **removed**
within their packages.

## Programmatic API (`@exodus/stasis/diff`)

It takes already-parsed `@exodus/stasis-core` `Bundle`/`Lockfile` instances and
pulls in **no disk, brotli (`node:zlib`), or crypto (`node:crypto`)**: the
caller supplies the artifacts (each paired with its `kind`) and, to compare a
bundle, the **hash function** that turns its bytes into a lockfile-style digest.

```js
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { diffArtifacts, formatDiffStat, hasDifferences, normalizeArtifact } from '@exodus/stasis/diff'

const lock = { artifact: Lockfile.parse(lockText), kind: 'lockfile' }
const bundle = { artifact: Bundle.parse(bundleJson), kind: 'bundle' } // you read/decompress it yourself

// `hash` is required when a bundle is involved; a lockfile↔lockfile diff omits it.
const diff = diffArtifacts(lock, bundle, { hash: sha512integrity, imports: true })
if (hasDifferences(diff)) console.log(formatDiffStat(diff, { left: 'a', right: 'b', leftKind: 'lockfile', rightKind: 'bundle' }))
```

- `normalizeArtifact({ artifact, kind }, { hash })` — project an artifact onto the
  shared digest space (`kind` is `'lockfile' | 'bundle'`; `hash` required for bundles).
- `diffArtifacts(left, right, { hash, imports })` — the structured
  `{ scope, modules, files, imports? }` report (`left` is the baseline; `imports`
  included only when `imports: true`).
- `hasDifferences(diff)` — whether any module/file/import edge changed.
- `formatDiffStat(diff, labels)` — render the `--stat` summary string.

The `stasis diff` CLI wraps this API: it reads the files (with brotli for `.br`
bundles) and passes `sha512integrity` as the hash.
