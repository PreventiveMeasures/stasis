# `stasis run`

`stasis run` runs a Node entry under stasis's loader, which records every
module the run loads into a lockfile (`stasis.lock.json`), a bundle
(`stasis.code.br`), or both; verifies the run against ones recorded before;
or serves the run from a bundle alone, with nothing read from disk. The flags
are the keys of [`stasis.config.json`](file-formats.md#stasisconfigjson) and
their `EXODUS_STASIS_*` environment variables: each sets its variable for the
node process it spawns, and a variable already set to another value is a
conflict. The zero-dependency core CLI runs the same loader as
`stasis-core run`, without `--mock` and `--package-json`.

```sh
stasis run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|frozen|ignore)] [--bundle-file=path/to/bundle.br] [--resources-bundle-file=path/to/resources.br] [--dependencies] [--child-process] [--package-json] [--mock] [--import=module ...] [--fs=(sync|async)] [--resources=ext,ext] [--brotli-quality=0..11] path/to/file.js ...
```

Everything after the options goes to node as is: the entry and its arguments.
The exit code is the entry's, or 128 plus the signal's number where a signal
killed it. The effective configuration is printed to stderr first.

| Flag | Meaning |
| - | - |
| `--lock=mode` | What the run does with `stasis.lock.json`: `add`, `replace`, `frozen` or `ignore`, see [modes](#modes). |
| `--bundle=mode` | Likewise for `stasis.code.br`: `add`, `replace`, `frozen`, `load` or `ignore`. `load` serves the recorded bytes instead of reading disk. |
| `--bundle-file=path` | The bundle to read or write, instead of `stasis.code.br` in the project root. Needs `--bundle`. |
| `--resources-bundle-file=path` | A split layout: the run's non-code files are read from and written to this sidecar bundle, the code bundle holding code alone. Needs `--bundle=add\|replace\|load\|frozen`. |
| `--dependencies` | `node_modules` scope: attest the dependencies only, not the project's own files (the `scope` key). |
| `--child-process` | Also attest the modules forked child processes load, see [Child processes](#child-processes---child-process). |
| `--package-json` | Also bundle each module's `package.json`, even one the run never reached. Needs `--bundle=add\|replace`. |
| `--mock` | Run with the app's side effects denied, see [Mock](#mock---mock). Not with `--bundle=load`. |
| `--import=module` | A preload module for the node process, after stasis's own loader; repeatable. See [Preloads](#preloads---import). |
| `--fs=(sync\|async)` | Also capture the files the run reads through `fs` into the bundle: `sync` the sync readers, `async` their callback and `fs.promises` forms too. Needs `--bundle=add\|replace\|load`. See [filesystem captures](file-formats.md#filesystem-captures-stasis-run---fssync----fsasync). |
| `--resources=ext,ext` | The non-code files a `--fs` capture may carry, by bare extension or extensionless filename (`png,svg,LICENSE`); the `resources` key. |
| `--brotli-quality=0..11` | Compression of a written bundle, default `9`. |

```sh
stasis run --lock=add app.js                      # build just a lockfile
stasis run --lock=frozen app.js                   # verify disk against the lockfile
stasis run --bundle=add app.js                    # build just a bundle
stasis run --bundle=frozen app.js                 # verify disk against the bundle alone (self-attesting)
stasis run --bundle=load app.js                   # run from the bundle alone
stasis run --lock=add --bundle=add app.js         # build a lockfile and bundle together
stasis run --lock=frozen --bundle=load app.js     # run from the bundle, verified against the lockfile
stasis run --lock=add --bundle=add --mock app.js  # build without the app's side effects
```

## Modes

| Mode | Behavior |
| - | - |
| `add` | Load what is recorded, record what is new, refuse to change what is recorded |
| `replace` | Ignore what is recorded, rebuild from scratch |
| `frozen` | Load read-only; every file the run observes must match |
| `ignore` | Tolerate a file on disk without loading or writing it |
| `load` | Bundle only: serve the recorded bytes instead of reading disk |

At least one of `--lock` and `--bundle` is set. `--bundle=load` runs from the
bundle alone with no `--lock`, or verified against the lockfile with
`--lock=frozen` (`--lock=ignore` tolerates one on disk); never with `add` or
`replace`. `--bundle=frozen` composes with any lock mode, and makes the bundle
its own attestation, so a frozen bundle needs no sibling lockfile. Both files
are looked up in the project root, see [discovery](file-formats.md#discovery).

## Preloads (`--import`)

`--import=./instrument.mjs` forwards a preload module to the node process
running the entry, after stasis's own loader (repeatable), for a setup or
instrumentation preload. A preload's own module graph is runner infrastructure
like the loader itself: evaluated, not captured, so it stays out of the lockfile
and bundle. Modules the app graph also reaches, or that execute through a
`require()` pipeline a preload installs, are still attested like any other app
code, so frozen replays and `--bundle=load` stay fail-closed. Under `--mock`,
preloads run under its denials: one that spawns helper processes fails there.

## Mock (`--mock`)

`--mock` captures the import graph by running the app with its side effects
denied, failing closed: Node's `--permission` blocks filesystem writes outside
the cwd (and the bundle targets' directories), child processes, workers, native
addons and the inspector, and the network and timers are neutralized in JS,
every callable of a denied builtin replaced by a thrower, so higher-level
clients fall closed too. Reads stay open, so resolution works as in a plain
run. It is for building, so it doesn't combine with `--bundle=load`.

## Child processes (`--child-process`)

`--child-process` also attests the modules that forked child processes load,
such as Metro's transform workers: each child forwards what it captured to the
root process as a signed shard carrying keys and resolution edges only, whose
content the root re-reads from its own disk, so a shard can't inject content.
It takes effect with a writing `--lock` or `--bundle` mode.
