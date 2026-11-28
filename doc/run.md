# `stasis run`

`stasis run` runs a Node entry under stasis's loader, which records every module
it loads into a lockfile (`stasis.lock.json`), a bundle (`stasis.code.br`), or
both; verifies the run against them; or serves it from the bundle alone.

```sh
stasis run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|frozen|ignore)] [--bundle-file=path/to/(bundle.br|name.stasis.tgz)] [--resources-bundle-file=path/to/resources.br] [--dependencies] [--child-process] [--package-json] [--mock] [--import=module ...] [--fs=(sync|async)] [--resources=ext,ext] [--brotli-quality=0..11] path/to/file.js ...
```

Arguments after the options go to node as is. The exit code is the entry's, or
128 plus the signal number if a signal killed it. The effective configuration
is printed to stderr first.

| Flag | Meaning |
| - | - |
| `--lock=mode` | What to do with `stasis.lock.json`, see [modes](#modes). |
| `--bundle=mode` | What to do with `stasis.code.br`, see [modes](#modes). |
| `--bundle-file=path` | The bundle to use instead of `stasis.code.br` in the project root, or a [`.stasis.tgz`](#a-stasistgz). Needs `--bundle`. |
| `--resources-bundle-file=path` | Keep non-code files in this separate bundle. Needs `--bundle=add\|replace\|load\|frozen`. |
| `--dependencies` | `node_modules` scope: attest the dependencies only, not the project's own files. |
| `--child-process` | Also attest what forked child processes load, see [Child processes](#child-processes---child-process). |
| `--package-json` | Also bundle each module's `package.json`, and the nearest one above each bundled file. Needs `--bundle=add\|replace`. |
| `--mock` | Deny the app's side effects, see [Mock](#mock---mock). Not with `--bundle=load`. |
| `--import=module` | A preload module, run after stasis's loader; repeatable. See [Preloads](#preloads---import). |
| `--fs=(sync\|async)` | Also capture the files read through `fs` (`async`: their callback and `fs.promises` forms too). Needs `--bundle=add\|replace\|load`. See [filesystem captures](file-formats.md#filesystem-captures-stasis-run---fssync----fsasync). |
| `--resources=ext,ext` | The non-code files a `--fs` capture may carry, by extension or filename (`png,svg,LICENSE`). |
| `--brotli-quality=0..11` | Compression of a written bundle, default `6`. |

Each flag is also a [`stasis.config.json`](file-formats.md#stasisconfigjson) key
and an `EXODUS_STASIS_*` variable; a variable already set to another value is a
conflict. Modes come only from flags and variables, except that the config can
pin `lock` to `frozen`.

```sh
stasis run --lock=add app.js                      # build just a lockfile
stasis run --lock=frozen app.js                   # verify disk against the lockfile
stasis run --bundle=add app.js                    # build just a bundle
stasis run --bundle=frozen app.js                 # verify disk against the bundle alone
stasis run --bundle=load app.js                   # run from the bundle alone
stasis run --lock=add --bundle=add app.js         # build a lockfile and bundle together
stasis run --lock=frozen --bundle=load app.js     # run from the bundle, verified against the lockfile
stasis run --lock=add --bundle=add --mock app.js  # build without the app's side effects
```

`stasis.config.json` also sets:

- [`extra`](file-formats.md#stasisconfigjson): files to attest that the run
  never loads, added by a writing run (`add` or `replace`).
- [Allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules):
  a refused file fails its import or read, and the run writes nothing even if
  the program catches the error. An artifact recording one is refused up front.
- [`excludeModules`](file-formats.md#excluded-modules): dependencies treated as
  not installed (`MODULE_NOT_FOUND`), never recorded.

`stasis-core run` is the same loader without `--mock` and `--package-json`, and
without checking [`integrity`](file-formats.md#stasiscodebr) and `patch`
against the package manager's install record.

## Modes

| Mode | Behavior |
| - | - |
| `add` | Load what is recorded, record what is new, refuse to change what is recorded |
| `replace` | Ignore what is recorded, rebuild from scratch |
| `frozen` | Load read-only; every file the run observes must match |
| `ignore` | Tolerate a file on disk without loading or writing it |
| `load` | Bundle only: serve the recorded bytes instead of reading disk |

At least one of `--lock` and `--bundle` is required. `--bundle=load` runs alone
or with `--lock=frozen` or `ignore`, never `add` or `replace`. `--bundle=frozen`
works with any lock mode and needs no lockfile. Both files are looked up in the
project root, see [discovery](file-formats.md#discovery).

## A .stasis.tgz

`--bundle-file` (or the config's `bundleFile`) may name a
[`.stasis.tgz`](file-formats.md#stasistgz) under `--bundle=load` or `frozen`;
it is never written. Its files must be exactly those of its own
`stasis.lock.json`, or the run fails before anything runs. `--lock` still means
the project's lockfile. `stasis-core run` refuses a tgz.

```sh
stasis run --bundle=load --bundle-file=app.stasis.tgz app.js                 # run from the tgz alone
stasis run --lock=frozen --bundle=load --bundle-file=app.stasis.tgz app.js   # verified against the project's lockfile too
stasis run --lock=ignore --bundle=frozen --bundle-file=app.stasis.tgz app.js # verify disk against the tgz
```

## Native addons

A run records the edge to a native addon (a `.node` file), not its bytes, and
Node loads it from disk even under `--bundle=load`. Where the artifact attests
an addon (only [`stasis bundle`](bundle.md#native-addons) records one), `add`,
`frozen` and `load` check it before it runs, however it is loaded
(`require()`, `process.dlopen()`, a child process or a worker). A mismatch
fails the load, and the run writes nothing:

```
stasis: refusing to load the native addon native/lib_linux-x64_nodejs.node: it is not the one the lockfile records
```

An addon no artifact attests loads unchecked. One swapped on disk between the
check and Node opening it is not caught.

## Preloads (`--import`)

A preload's own module graph is not captured. Modules the app also reaches, or
that run through a `require()` pipeline a preload installs, are. Under `--mock`,
preloads run under its denials.

## Mock (`--mock`)

`--mock` captures the import graph with the app's side effects denied: Node's
`--permission` blocks filesystem writes outside the cwd and the bundle targets'
directories, child processes, workers, native addons and the inspector, and the
network and timers throw. Reads are allowed.

## Child processes (`--child-process`)

`--child-process` also attests the modules forked child processes load, such as
Metro's transform workers: each child sends the paths and edges it captured to
the root process, which reads their content from disk. It takes effect with a
writing `--lock` or `--bundle` mode.
