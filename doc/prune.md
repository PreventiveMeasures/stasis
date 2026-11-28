# `stasis prune`

`stasis prune` (also exported as `@exodus/stasis/prune`) constrains an
installed `node_modules` tree to the files recorded in `stasis.lock.json`.

```json
// package.json
{ "scripts": { "postinstall": "stasis prune" } }
```

It walks `node_modules`, keeps and verifies (sha512) every file the lockfile
lists, failing if one is missing, rewrites recognised modules' `package.json`
(below), and deletes everything else, `package.json` files under unlisted
directories included. Any error aborts before anything is deleted or rewritten.

## `package.json` rewriting

A rewritten `package.json` keeps only these fields:

| Field | Handling |
| --- | --- |
| `name`, `version` | Taken from the **lockfile**, not disk. |
| `license` | Copied only if an ASCII string shorter than 64 bytes. |
| `type` | Copied only if exactly `"module"` or `"commonjs"`. |
| `main`, `module`, `jsnext:main`, `jsnext`, `source`, `browser`, `react-native`, `bin`, `sideEffects`, `exports`, `imports` | Copied, but filtered so every file referenced is one the lockfile records for that module. |

- `exports`/`imports` targets are matched verbatim; `main`, `module`,
  `jsnext:main`, `jsnext`, `source`, `browser` and `bin` get Node's
  extension/index expansion.
- `sideEffects` also accepts a boolean.
- `browser`/`react-native` keep `false` stubs and bare-module targets; `imports`
  keeps bare specifiers; `exports` keeps neither. Subpath patterns (`./*`) are
  kept as-is; targets that escape the module (`..` or absolute) are dropped.
- A field that filters down to nothing is dropped, never emitted as an empty
  `{}`/`[]`.

Two cases differ:

- A `package.json` the lockfile lists (imported directly, e.g.
  `require('pkg/package.json')`) is hash-verified and kept in full.
- A **nested** `package.json` (e.g. a `dist/cjs/package.json` of
  `{"type":"commonjs"}`) is kept, reduced to the fields that govern resolution
  within its subtree (`type`, `main`/`module`/`browser`/`react-native`,
  `exports`/`imports`), filtered (relative to its directory) to present files.

Rewriting is idempotent, and **replaces** the file (a new one renamed over it),
so a hardlink into pnpm's store is left untouched.

## Symlinks

A symlink is left in place only if it is already dangling or its real target
stays **inside `node_modules`**, as pnpm's `node_modules/<pkg>` links into
`node_modules/.pnpm/...` do (`prune` walks and verifies the real files there,
pruning unreferenced ones like any other). One whose target **escapes**
`node_modules`, even to a workspace package under the bundle root, is refused.

## pnpm workspaces

In a pnpm workspace root (one with a `pnpm-workspace.yaml`):

- `prune` covers **every** package's `node_modules` (the root's too), found
  without walking into a `node_modules`, a dotdir, or outside the root.
- A symlink may point anywhere in the **whole workspace**: a dependency's link
  to a sibling package's source directory is left in place, its target **not**
  content-validated. One escaping the workspace root is still refused.
- It only deletes files **inside a `node_modules`**, and never accesses
  anything outside the workspace root.

`prune` also refuses up front if pnpm's `enableGlobalVirtualStore` is on
(checked via `npm_config_enable_global_virtual_store`).
