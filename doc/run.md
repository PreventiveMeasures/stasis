# `stasis run`

`stasis run` runs a Node entry under stasis's loader, which records every
module the run loads into a lockfile (`stasis.lock.json`), a bundle
(`stasis.code.br`), or both; verifies the run against ones recorded before;
or serves the run from a bundle alone, with nothing read from disk. The flags
are the keys of [`stasis.config.json`](file-formats.md#stasisconfigjson) and
their `EXODUS_STASIS_*` environment variables: each sets its variable for the
node process it spawns, and a variable already set to another value is a
conflict. The modes are the flags' alone, save that a config file can pin
`lock` to `frozen`, which a run must then be given. The zero-dependency core CLI
runs the same loader as `stasis-core run`, without `--mock` and `--package-json`,
and reads no package manager's record of the install, which `stasis run` holds
the lockfile's and bundle's `integrity` and `patch` to, and records of the
packages it captures anew (see [`integrity`](file-formats.md#stasiscodebr)).

```sh
stasis run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|frozen|ignore)] [--bundle-file=path/to/(bundle.br|name.stasis.tgz)] [--resources-bundle-file=path/to/resources.br] [--dependencies] [--child-process] [--package-json] [--mock] [--import=module ...] [--fs=(sync|async)] [--resources=ext,ext] [--brotli-quality=0..11] path/to/file.js ...
```

Files the run never loads, but which are to be attested anyway, are named in
`stasis.config.json`'s [`extra`](file-formats.md#stasisconfigjson): a run that
writes a lockfile or bundle (`add` or `replace`) adds them.

Its `allowedPaths`, `disallowedPaths`, `allowedModules` and `disallowedModules`
restrict what the run may load, read and record: a file one refuses fails its
import or read as the run reaches it, and the run then writes nothing, even where
the program catches the error. A lockfile or bundle the run loads that records
one is refused before the entry runs. See
[Allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules).

Its `excludeModules` names dependencies the run takes for absent: a resolution into
one fails as one of a missing package does (`MODULE_NOT_FOUND`, or
`ERR_MODULE_NOT_FOUND` for an `import`), which the program may catch, and nothing
of it is recorded. Under `--fs` its files read as missing. A lockfile or bundle the
run loads that records one is refused before the entry runs. See
[Excluded modules](file-formats.md#excluded-modules).

Everything after the options goes to node as is: the entry and its arguments.
The exit code is the entry's, or 128 plus the signal's number where a signal
killed it. The effective configuration is printed to stderr first.

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

At least one of `--lock` and `--bundle` is set. `--bundle=load` runs from the
bundle alone with no `--lock`, or verified against the lockfile with
`--lock=frozen` (`--lock=ignore` tolerates one on disk); never with `add` or
`replace`. `--bundle=frozen` composes with any lock mode, and makes the bundle
its own attestation, so a frozen bundle needs no sibling lockfile. Both files
are looked up in the project root, see [discovery](file-formats.md#discovery).

## A .stasis.tgz

`--bundle-file` may name a `.stasis.tgz` (`stasis.tgz` or `<name>.stasis.tgz`):
a gzipped tar of a `stasis.lock.json` at its top and exactly the files it
attests, as [`stasis validate`](validate.md#what-is-checked) takes one. The run
serves the bundle of those files, as it would the `stasis.code.br` of them,
with `--bundle=load` or `frozen`; it is never written, so `add` and `replace`
are refused.

```sh
stasis run --bundle=load --bundle-file=app.stasis.tgz app.js                 # run from the tgz alone
stasis run --lock=frozen --bundle=load --bundle-file=app.stasis.tgz app.js   # verified against the project's lockfile too
stasis run --lock=ignore --bundle=frozen --bundle-file=app.stasis.tgz app.js # verify disk against the tgz
```

The tgz is read before the program starts, as `stasis validate` reads it: each
file the bytes and execute bit its `stasis.lock.json` attests, nothing else in
it, no byte past its gzip stream or tar's end but zeros. One that isn't fails
the run before any of it runs, naming the path. The bundle the run takes is of
the bytes read then alone: a tgz changed on disk since serves nothing. `--lock`
is the project's lockfile as with any bundle; the tgz's own attests its files
as it is read.

- A `directory` capture (a `readdir` under `--fs`) is a listing's hash in a
  lockfile, so the tgz holds no listing to serve: such a `readdir` fails, as one
  of a file not attested does.
- Only `--bundle-file` names one: a `bundleFile` in `stasis.config.json`
  naming a `.stasis.tgz` is refused, as is one given to `stasis-core run`,
  which reads no tar. A tgz under any other name is refused too.

## Native addons

Node loads a native addon (a `.node` file) from disk by its path, as a process
can't load one from memory, past the loader that sees every other module. So a
run records the edge to an addon it loads and none of its bytes, as one an
install builds differs from install to install; and `--bundle=load` resolves an
addon by the bundle's edge, but it has to be on disk still.

A lockfile or bundle may attest one all the same: [`stasis bundle`](bundle.md#native-addons)
carries the addons it follows, as resources. A run holds such an addon to it as
it loads, in every mode that reads the artifact (`add`, `frozen` and `load`):
before the addon runs, its bytes on disk are compared to the ones the bundle
carries, else to the hash the lockfile records, and another in its place is
refused.

```
stasis: refusing to load the native addon native/lib_linux-x64_nodejs.node: it is not the one the lockfile records
```

- It is held however it is loaded: by `require()`, by a call of
  `process.dlopen()`, in a forked child process or in a worker.
- The refusal is the load's own error, which the program may catch, as a
  package that falls back from its addon to JavaScript does. The addon doesn't
  run either way, and the run then writes nothing.
- An addon neither artifact attests is loaded as it is, and none is recorded:
  one built on install, or another platform's, breaks no run. `replace` reads
  no artifact, so it holds no addon to one, and what it writes records none:
  `stasis bundle` is what attests one.
- In `node_modules` scope (`--dependencies`) the project's own addons are none
  of the run's, as its other files aren't.
- One loaded before the run has read its artifacts, as a
  [preload](#preloads---import) loads its own, is held as soon as it has,
  before the entry runs: the process keeps the one the preload loaded,
  whatever requires it next. So a preload's addon is held wherever an artifact
  attests it, though its modules are held only where the app reaches them.
- The addon is read, and then Node opens it by its path: one put in its place
  between the two is loaded unseen.

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
