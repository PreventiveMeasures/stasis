# `stasis prune`

`stasis prune` (also exported as `@exodus/stasis/prune`) constrains an
installed `node_modules` tree to the files recorded in `stasis.lock.json`.

```json
// package.json
{ "scripts": { "postinstall": "stasis prune" } }
```

`prune` walks `node_modules`, keeps and verifies (sha512) every file listed in
the lockfile, rewrites recognised modules' `package.json` down to a minimal
field set (below), deletes everything else (including `package.json` files
under unlisted directories), and fails if a lockfile-listed file is missing on
disk. Any error aborts before anything is deleted or rewritten.

## `package.json` rewriting

The lockfile doesn't record `package.json` contents, so `prune` overwrites each
one with only the fields needed to resolve and load the package, dropping
everything else (`scripts`, `dependencies`, `engines`, `config`, …):

| Field | Handling |
| --- | --- |
| `name`, `version` | Taken from the **lockfile**, not disk. |
| `license` | Copied only if an ASCII string shorter than 64 bytes. |
| `type` | Copied only if exactly `"module"` or `"commonjs"`. |
| `main`, `module`, `jsnext:main`, `jsnext`, `source`, `browser`, `react-native`, `bin`, `sideEffects`, `exports`, `imports` | Copied, but filtered so every file referenced is one the lockfile records for that module. See below. |

Filtering rules for that last group:

- `jsnext:main`/`jsnext` (Vite's default `mainFields`) and `source` (Parcel,
  Metro/React Native) are filtered as `main`/`module` are.
- `exports`/`imports` targets are matched verbatim; `main`/`module`/`browser`/`bin`
  get Node's extension/index expansion.
- `sideEffects` also accepts a boolean.
- `browser`/`react-native` keep `false` stubs and bare-module targets; `imports`
  keeps bare specifiers; `exports` keeps neither. Subpath patterns (`./*`) are
  kept as-is; targets that escape the module (`..` or absolute) are dropped.
- A field that filters down to nothing is dropped entirely (never emitted as an
  empty `{}`/`[]`).

Two cases are handled differently:

- A `package.json` that **is** in the lockfile's file list (imported directly,
  e.g. `require('pkg/package.json')`) is hash-verified and kept in full.
- A **nested** `package.json` (e.g. a `dist/cjs/package.json` of
  `{"type":"commonjs"}`) is kept, reduced to the fields that govern resolution
  *within* its subtree (`type`, the directory entry points
  `main`/`module`/`browser`/`react-native`, and `exports`/`imports`), filtered
  (relative to the nested dir) to present files.

Rewriting is idempotent (byte-identical on re-run). Each `package.json` is
**replaced** (a new file renamed over it), never written in place, so a
hardlink into pnpm's store is left untouched.

## Symlinks

`prune` leaves a symlink in place only when its real target stays **inside
`node_modules`**. pnpm's public `node_modules/<pkg>` entries link into
`node_modules/.pnpm/...`, whose real files `prune` walks and verifies directly;
unreferenced store files are pruned like any other untracked file, and an
already-dangling link is left as-is. A symlink whose target **escapes**
`node_modules`, even to a workspace package under the bundle root, is refused
(`prune` aborts before touching disk).

## pnpm workspaces

In a pnpm workspace root (one with a `pnpm-workspace.yaml`):

- `prune` covers **every** package's `node_modules` (each workspace package's,
  plus the root's), found by walking the workspace (never into a `node_modules`,
  a dotdir, or outside the root).
- A symlink may point anywhere in the **whole workspace**, not just
  `node_modules`. A workspace dependency linking to a sibling package's source
  directory is left in place, its target **not** content-validated. A link
  whose target escapes the workspace root is still refused.
- It only deletes files **inside a `node_modules`**, never workspace source
  files, and never accesses anything outside the workspace root.

`prune` also refuses up front if pnpm's `enableGlobalVirtualStore` is on
(checked via `npm_config_enable_global_virtual_store`).
