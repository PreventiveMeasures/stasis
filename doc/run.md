# `stasis run`

`stasis run` runs a Node entry under stasis's loader, which records every
module the run loads into a lockfile (`stasis.lock.json`), a bundle
(`stasis.code.br`), or both; verifies the run against them; or serves the run
from a bundle alone, with nothing read from disk.

Each flag is a key of [`stasis.config.json`](file-formats.md#stasisconfigjson)
and sets its `EXODUS_STASIS_*` environment variable for the node process; a
variable already set to another value is a conflict. Modes come from flags
only, except that a config file can pin `lock` to `frozen`, which the run must
then be given.

`stasis-core run` runs the same loader without `--mock` and `--package-json`,
and doesn't read the package manager's install record, which `stasis run`
holds [`integrity`](file-formats.md#stasiscodebr) and `patch` to.

```sh
stasis run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|frozen|ignore)] [--bundle-file=path/to/(bundle.br|name.stasis.tgz)] [--resources-bundle-file=path/to/resources.br] [--dependencies] [--child-process] [--package-json] [--mock] [--import=module ...] [--fs=(sync|async)] [--resources=ext,ext] [--brotli-quality=0..11] path/to/file.js ...
```

Files to attest that the run never loads go in `stasis.config.json`'s
[`extra`](file-formats.md#stasisconfigjson); a writing run (`add` or `replace`)
adds them.

`allowedPaths`, `disallowedPaths`, `allowedModules` and `disallowedModules`
restrict what the run may load, read and record. A refused file fails its import
or read, and the run writes nothing, even if the program catches the error. A
lockfile or bundle that records one is refused before the entry runs. See
[Allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules).

`excludeModules` names dependencies the run treats as absent: resolving one
fails as for a missing package (`MODULE_NOT_FOUND`, or `ERR_MODULE_NOT_FOUND`
for an `import`), and nothing of it is recorded. Under `--fs` their files read
as missing. A lockfile or bundle that records one is refused before the entry
runs. See [Excluded modules](file-formats.md#excluded-modules).

Everything after the options goes to node as is. The exit code is the entry's,
or 128 plus the signal number if a signal killed it. The effective
configuration is printed to stderr first.

| Flag | Meaning |
| - | - |
| `--lock=mode` | What the run does with `stasis.lock.json`: `add`, `replace`, `frozen` or `ignore`, see [modes](#modes). |
| `--bundle=mode` | Likewise for `stasis.code.br`: `add`, `replace`, `frozen`, `load` or `ignore`. `load` serves the recorded bytes instead of reading disk. |
| `--bundle-file=path` | The bundle to read or write, instead of `stasis.code.br` in the project root. Needs `--bundle`. A `.stasis.tgz` is read alone, see [A .stasis.tgz](#a-stasistgz). |
| `--resources-bundle-file=path` | A split layout: the run's non-code files are read from and written to this sidecar bundle, the code bundle holding code alone. Needs `--bundle=add\|replace\|load\|frozen`. |
| `--dependencies` | `node_modules` scope: attest the dependencies only, not the project's own files (the `scope` key). |
| `--child-process` | Also attest the modules forked child processes load, see [Child processes](#child-processes---child-process). |
| `--package-json` | Also bundle each module's `package.json`, and the nearest one above each bundled file (an `esm/package.json`), even one the run never reached. Needs `--bundle=add\|replace`. |
| `--mock` | Run with the app's side effects denied, see [Mock](#mock---mock). Not with `--bundle=load`. |
| `--import=module` | A preload module for the node process, after stasis's own loader; repeatable. See [Preloads](#preloads---import). |
| `--fs=(sync\|async)` | Also capture the files the run reads through `fs` into the bundle: `sync` the sync readers, `async` their callback and `fs.promises` forms too. Needs `--bundle=add\|replace\|load`. See [filesystem captures](file-formats.md#filesystem-captures-stasis-run---fssync----fsasync). |
| `--resources=ext,ext` | The non-code files a `--fs` capture may carry, by bare extension or extensionless filename (`png,svg,LICENSE`); the `resources` key. |
| `--brotli-quality=0..11` | Compression of a written bundle, default `6`. |

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

At least one of `--lock` and `--bundle` is required. `--bundle=load` runs from
the bundle alone with no `--lock`, or verified against the lockfile with
`--lock=frozen` (`--lock=ignore` tolerates one on disk); never with `add` or
`replace`. `--bundle=frozen` works with any lock mode and needs no lockfile.
Both files are looked up in the project root, see [discovery](file-formats.md#discovery).

## A .stasis.tgz

`--bundle-file` or `stasis.config.json`'s `bundleFile` may name a
[`.stasis.tgz`](file-formats.md#stasistgz), and a `stasis.tgz` at the project
root is found as a `stasis.code.br` is ([discovery](file-formats.md#discovery)).
It is read with `--bundle=load` or `frozen` as a `stasis.code.br` would be, and
never written: `add` and `replace` are refused.

```sh
stasis run --bundle=load --bundle-file=app.stasis.tgz app.js                 # run from the tgz alone
stasis run --lock=frozen --bundle=load --bundle-file=app.stasis.tgz app.js   # verified against the project's lockfile too
stasis run --lock=ignore --bundle=frozen --bundle-file=app.stasis.tgz app.js # verify disk against the tgz
```

At start, the tgz is checked against its own `stasis.lock.json`: one that isn't
exactly its lockfile's files fails the run before anything runs. `--lock` is
still the project's lockfile. `stasis-core run` refuses one.

## Native addons

Node loads a native addon (a `.node` file) from disk, past the loader. A run
records the edge to an addon, not its bytes; `--bundle=load` resolves it by
that edge, but the addon must still be on disk.

[`stasis bundle`](bundle.md#native-addons) does carry the addons it follows, as
resources. In every mode that reads the artifact (`add`, `frozen` and `load`),
such an addon is checked before it runs against the bytes the bundle carries,
else the hash the lockfile records, and refused if it differs.

```
stasis: refusing to load the native addon native/lib_linux-x64_nodejs.node: it is not the one the lockfile records
```

- The check applies however the addon is loaded: `require()`,
  `process.dlopen()`, a forked child process or a worker.
- The refusal is the load's own error, which the program may catch. The addon
  doesn't run either way, and the run writes nothing.
- An addon neither artifact attests loads unchecked and isn't recorded.
  `replace` checks no addon and records none; only `stasis bundle` attests one.
- In `node_modules` scope (`--dependencies`) the project's own addons aren't
  checked.
- An addon a [preload](#preloads---import) loads before the artifacts are read
  is checked once they are, before the entry runs.
- The addon is read, then Node opens it by its path: one swapped in between
  the two is loaded unchecked.

## Preloads (`--import`)

`--import=./instrument.mjs` (repeatable) passes a preload module to node,
after stasis's own loader. A preload's own module graph is not captured.
Modules the app also reaches, or that run through a `require()` pipeline a
preload installs, are attested like other app code. Under `--mock`, preloads
run under its denials: one that spawns helper processes fails.

## Mock (`--mock`)

`--mock` captures the import graph with the app's side effects denied: Node's
`--permission` blocks filesystem writes outside the cwd and the bundle targets'
directories, child processes, workers, native addons and the inspector, and
the network and timers throw. Reads stay open, so resolution works as usual.
Not with `--bundle=load`.

## Child processes (`--child-process`)

`--child-process` also attests the modules forked child processes load, such
as Metro's transform workers. Each child sends the root process the paths and
edges it captured, and the root reads their content from its own disk. It takes
effect with a writing `--lock` or `--bundle` mode.
