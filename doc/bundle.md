# `stasis bundle`

`stasis bundle` builds a `stasis.code.br` bundle statically, from the entries'
import graph alone, without executing anything: each entry is parsed, its
imports resolved, and every reached file read, recursively. It is the static
counterpart of `stasis run --bundle=add`, for code that can't or shouldn't run
to be captured (a React Native app, a library's entry points).

```sh
stasis bundle [--scope=(node_modules|full)] [--conditions=cond1,cond2] [--mainFields=field1,field2] [--jsx] [--flow] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--define=K=V ...] [--package-json] [--lockfile=path/to/stasis.lock.json] [--add] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx) ...
stasis bundle --metro [--metro-resolver] [--babel|--babel-aliases=path/to/aliases.json] --platforms=ios,android [--platforms=web] [--jsx] [--flow] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--define=K=V ...] [--package-json] [--lockfile=path/to/stasis.lock.json] [--add] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx) ...
stasis bundle [--babel] [--metro-resolver] [--flow] [--cargo] [--cargo-target=(triple|host)] [--lockfile=path/to/stasis.lock.json] [--add] [--output=(path|-)] [entry ...]   # the entries' options from stasis.config.json
```

This page covers JS/TS bundles. `stasis bundle` also builds Solidity, PHP, Bash
and Rust bundles, see [Other languages](#other-languages).

Files the graph never reaches, but which are to be bundled anyway, are named in
`stasis.config.json`'s [`extra`](file-formats.md#stasisconfigjson), for every
language: the bundle (and its `--lockfile`) carries them too.

| Flag | Meaning |
| - | - |
| `--output` / `-o` | Where to write. Default: `stasis.code.br` in the project root, or in the cwd with `--mainFields`/`--metro`, see [Output](#output). `-` streams to stdout. |
| `--add` | Merge the fresh build into the bundle already at `--output` instead of replacing it. Not with `--output=-`. |
| `--lockfile=path` | Also write a `stasis.lock.json` attesting every bundled file. See [Companion lockfile](#companion-lockfile---lockfile). |
| `--scope` | `full` (default) or `node_modules`, as `stasis run`'s. `--mainFields`/`--metro` always emit full scope, and refuse any other, given here or set by the cwd's [`stasis.config.json`](file-formats.md#stasisconfigjson) (which `--scope=full` overrides). |
| `--conditions=a,b` | Extra `exports`/`imports` resolution conditions, on top of Node's (with `--mainFields`, on top of a bundler's). See [Conditions](#conditions). |
| `--mainFields=a,b` | Legacy package entry fields to honor, in order (e.g. `react-native,browser,main`), incl. the `browser` field's object redirection. |
| `--metro --platforms=ios,android` | Resolve the way Metro does. See [Metro](#metro---metro). |
| `--metro-resolver` | With `--metro`: resolve through the project's own `metro-resolver` instead of the built-in approximation. |
| `--babel` | With `--metro`: resolve through the import aliases of the project's `babel.config.*` (`babel-plugin-module-resolver`). See [Metro](#metro---metro). |
| `--babel-aliases=path.json` | With `--metro`: resolve through the import aliases a JSON file of the project lists, as `--babel` would, without running anything. See [Metro](#metro---metro). |
| `--jsx` | Parse JSX in `.js`/`.cjs`/`.mjs` files. `.jsx`/`.tsx` files need no flag. See [JSX and Flow](#jsx-and-flow). |
| `--flow` | Strip Flow types from `.js`/`.cjs`/`.mjs` files oxc can't parse. Needs the optional `flow-remove-types` dependency. |
| `--typescript` | Resolve TypeScript sources the way tsc does. See [TypeScript](#typescript---typescript). |
| `--tsconfig=path` | With `--typescript`: the tsconfig whose `compilerOptions.paths` aliases apply. |
| `--resources=png,svg` | Carry reached non-code files as resources instead of failing on them. With `--mainFields`/`--metro`, the cwd's `stasis.config.json` `resources` where not given. See [Resources and manifests](#resources-and-manifests). |
| `--define=K=V` | A global's value as the build gives it (`__DEV__=false`): imports only in branches it keeps from running are left out. Repeatable. See [Defines](#defines---define). |
| `--package-json` | Also bundle each bundled module's `package.json`, even ones the scan never reached. |
| `--brotli-quality=0..11` | Compression level, default `9`. |

## Output

By default a JS bundle is written to `stasis.code.br` in the directory its
paths are relative to. Resolving as Node does (the default, with `--conditions`
or `--typescript` too), that is the project root at or above the cwd, which for
a workspace package is the workspace root: where `stasis run --bundle=load`
looks for it; written below the root, it would load as rooted there, and root
the next `stasis bundle` there too, out of the files above it. With
`--mainFields` or `--metro`, the bundle's paths are relative to the cwd
instead, and so the default `stasis.code.br` is the cwd's: run it from the
package's directory. `--output` names another path (relative to the cwd), and
`--output=-` streams the bundle to stdout, the summary going to stderr.

`--add` unions the fresh build into the bundle already on disk at `--output`,
to merge more entries and their import graph into one bundle; a file both
carry with different content is a conflict and fails. With nothing on disk
yet it is a plain write.

```sh
stasis bundle src/index.js            # writes stasis.code.br in the project root
stasis bundle --add src/worker.js     # merges the worker's graph into it
```

## Companion lockfile (`--lockfile`)

`--lockfile=stasis.lock.json` also writes a lockfile attesting every bundled
file: the same import graph with integrities instead of content. With
`--conditions` it attests the conditions-selected graph, so a plain
`stasis run --lock=frozen` (which doesn't replay them) fails closed: pair it
with `--bundle=load`, or replay the conditions. Under `--add`, an existing
lockfile at that path is merged the same way as the bundle; with none there it
refuses rather than write a lockfile that doesn't attest the pre-existing
bundle's files (write `--lockfile` from the first build, or drop it).

## Entry options (`stasis.config.json`)

The `entries` of the cwd's [`stasis.config.json`](file-formats.md#stasisconfigjson)
give entries their options: each key is an entry, a path relative to that
directory, and its value the flags building it, named as they are without the
`--`.

```json
{
  "entries": {
    "index.js": { "metro": true, "metro-resolver": true, "platforms": ["ios", "android"], "flow": true, "jsx": true },
    "node_modules/@react-native-community/cli/build/bin.js": { "metro": false }
  }
}
```

A boolean flag takes `true` or `false` (its default, as leaving it out is); one
taking a value, a string as on the command line, and one taking a list
(`platforms`, `conditions`, `mainFields`, `resources`, `cargo-features`) an
array of strings too. `define`, repeated rather than comma-separated, takes an
array of its `K=V` strings (`["__DEV__=false", "process.env.NODE_ENV=\"production\""]`),
or one. `output`, `lockfile`, `brotli-quality` and `add` say how
the bundle is written, not how an entry is built, so they stay flags.

With it:

- `stasis bundle` alone bundles every entry it names, as `stasis bundle` with
  each of them would.
- An entry it names is built with its options there, and no flag but those four
  and the consent below may be given with it: it is set there instead.
- `babel`, `metro-resolver`, `flow`, `cargo` and `cargo-target` run a program
  (the project's Babel config, its `metro-resolver`, the `flow-remove-types` it
  installs, `cargo` and what its `.cargo/config.toml` names, `rustc`), so set
  there they take effect only with their flag given too, `cargo-target` with
  the same value (`--cargo-target=host`), as consent: the config can't make a
  bare `stasis bundle` run anything. An entry setting one fails without its
  flag, and its flag fails where no entry given sets it; given, it applies to
  the entries setting it alone. So entries setting different `cargo-target`s
  are bundled apart. `babel-aliases` reads a JSON file and runs nothing, so it
  needs no consent.
- The entries given are all named there, or none is, the two never mixed. Where
  none is, whatever else it names, they are built with the flags exactly as
  without it.
- Entries with different options are built apart, and their bundles merged as
  `--add` merges (a file both carry with different content fails) into one,
  whose paths must be relative to the same root. So one bundle may hold a
  Metro build's files, attributed to the `bundle:metro` consumer, and a Node
  one's, attributed to `bundle`.
- The config's `extra` is the bundle's, not an entry's: added once, to the
  builds' union however many there are, by the config's own `resources` (an
  entry's `resources` is its graph's alone).

`stasis run` takes nothing from it.

```sh
stasis bundle --metro-resolver --flow   # bundles index.js with --metro and bin.js without
stasis bundle --metro-resolver --flow --output=app.br index.js
```

## Resolution

By default imports resolve as Node resolves them: `exports`/`imports` with
Node's conditions, `main`, extension and index probing.

- `--conditions=react-native,browser` merges extra conditions onto Node's
  defaults. It doesn't honor legacy `mainFields` or platform suffixes.
- `--mainFields=react-native,browser,main` honors legacy package entry fields
  in that order, including the `browser` field's object form (file redirection
  and `false` stubs). Always a full-scope bundle.

### Conditions

The conditions each mode asserts for `exports` and `imports` maps (`default`
always matches):

| Mode | Conditions |
| - | - |
| Node (default) | `node`, `import` or `require`, `module-sync`, `node-addons`, then `--conditions` |
| `--mainFields` | `import` or `require`, `module`, then `--conditions` |
| `--metro`, `--metro --metro-resolver` | `import` or `require`, `react-native`, and `browser` on `web` |

Resolving as Node, `import` or `require` follows the edge (an `import`,
`export ... from` or `import()` asserts `import`, a `require()` `require`),
and the set is the one Node itself asserts, so `stasis run --bundle=load`
lands on the file Node would. An `exports` map listing `node` first therefore
takes that branch whatever `--conditions` adds.

`--mainFields` and `--metro` resolve as a bundler does: `import` or `require`
follows the importing file's format, and `node`, `node-addons` and
`module-sync` are never asserted. A package whose `exports` lists `node` first
(`uuid` 9: `node`, `browser`, `default`) resolves to its `browser` target
under `--mainFields=browser,module,main --conditions=browser`, as esbuild
(platform `browser`) and webpack 5 (target `web`) do, and under `--metro` to
the first of its `react-native`, `default` and, on `web`, `browser` targets,
as Metro with React Native's config does. `--metro` asserts Metro's own set:
under `--metro-resolver` the project's `metro-resolver` is given `react-native`
and adds the rest itself.

`--mainFields` also asserts `module`, the bundler-only condition esbuild and
webpack 5 assert on every platform, from an `import` and a `require()` alike:
a package listing its ESM build under `module` (`xstate`, `@emotion/react`,
`@reduxjs/toolkit`) resolves to it, as those bundlers resolve it. Node and
Metro never assert it. webpack also asserts `webpack` and `production` or
`development`: add them with `--conditions` where a package's map tells them
apart.

### Node builtins

Resolving as Node, a builtin (`fs`, `buffer`, `node:fs`) is left to the
runtime and not bundled. Browser and React Native targets have no Node
builtins, so under `--mainFields` and `--metro` a bare builtin name (`buffer`,
`events`, `util`, `process`) is the installed npm package of that name, as
esbuild (platform `browser`), webpack 5 (target `web`) and Metro bundle it. A
`browser`/`react-native` map entry for the name (`{"fs": false}`,
`{"crypto": "crypto-browserify"}`) still wins. A `node:` specifier, or a name
no installed package resolves (`fs` with nothing installed), stays a builtin:
it is recorded but not bundled, where Metro and webpack would fail the build.

### Metro (`--metro`)

`--metro --platforms=ios,android` resolves the way Metro does: React Native's
[conditions](#conditions) and `mainFields`, and the `.ios`/`.android`/`.native`
file suffixes, each platform resolved on its own and all of them recorded in
one bundle. `--platforms` is repeatable and/or comma-separated
(`--platforms=web` too). It sets its own conditions and `mainFields`, so it
doesn't combine with `--conditions` or `--mainFields`.

Its files are attributed to the `bundle:metro` consumer in the bundle's
`reason` map, where every other `stasis bundle` build names `bundle`, so
`stasis audit --reason=bundle:metro` keeps to what the Metro build carries.

It takes Metro's own steps, as `metro-resolver` takes them, where they differ
from Node's and esbuild's:

- A package's `browser`/`react-native` map applies before its `exports`, so
  `@noble/hashes` 1.x's `{ "./crypto": "./crypto.js" }` wins over the
  `exports` `import` branch.
- Where `exports` serves nothing (no condition Metro asserts matches, as with
  `exports` offering only `browser` and `node` on iOS), resolution falls back
  to the package's files: `main` through the map, so `rpc-websockets` resolves
  to its `index.browser.cjs`.
- The `package.json` closest to the path counts, a nested one included: a
  subpath directory with a `package.json` of its own (`ox/erc8010`) resolves
  through its own `main`, not the root `exports`.
- A relative import takes the map of the package closest to its target.
- A package can import its own name through its own `exports`.
- A directory in `node_modules` that resolves to nothing gives way to the next
  `node_modules` up, but a package whose `main` resolves to nothing fails, as
  in Metro, without falling back to its root `index`.
- A map entry sending a relative path to a package name is taken as a path in
  the package, as Metro takes it, and so resolves nowhere.
- An asset (an extension in Metro's default `assetExts`: `png`, `jpg`, `svg`,
  `ttf`, ...) resolves to itself or one of its scale variants (`@1x` to `@4x`),
  the lowest path among those that exist, so `./logo.png` reaches
  `logo@3x.png` where only that exists, as does an `exports` or `imports`
  target naming one (`"./logo": "./logo.png"`). A path naming a scale variant itself
  (`./logo@2x.png`) resolves nowhere, as in Metro. `--metro-resolver` resolves
  assets the same way. Carrying one needs `--resources` (e.g. `--resources=png`).

It also carries each bundled dependency's native build inputs: for every
`node_modules` package the code graph reaches, its `ios/` and `android/`
sources and its podspecs (for `react-native` itself, its whole native tree).
That includes a workspace package linked, under any name, into a
`node_modules` its importer resolves packages from, carried where it lies
(`packages/<name>/...`) however the import reaches it; one linked nowhere
there is the project's own source.
A package reached only for an asset through `--resources` is not a linked
native dependency and contributes none. Build output (`build`, `.gradle`,
`.cxx`, `Pods`, `DerivedData`, nested `node_modules`) is skipped.

A disabled import (a `browser`/`react-native` map entry set to `false`)
resolves, as Metro resolves it, to Metro's own empty module: the project's
`node_modules/metro-runtime/src/modules/empty-module.js`, carried in
`metro-runtime`'s package, where that file is in fact empty (nothing but a
`"use strict"` directive). Otherwise it resolves, as with `--mainFields`, to a
synthetic empty `.stasis/empty-module.js`.

`--metro-resolver` resolves through the project's own installed
`metro-resolver` (it ships with `react-native`/`metro`) for byte-for-byte
Metro fidelity, instead of the built-in approximation. It can't substitute
`.js` for `.ts`, so it doesn't combine with `--typescript`.

`--babel` resolves the import aliases the project's Babel config sets, which
Metro applies before it resolves: a `babel-plugin-module-resolver` that maps
`#local` to `./src` makes `import '#local/abc'` reach `src/abc.js`. The
project's `babel.config.(js|cjs|mjs|json)` is loaded for each file as Metro's
transformer loads it, with Metro's `caller` and each `--platforms` target, so a
config that aliases per platform resolves per platform. That runs the config,
which is why it is opt-in; it needs `@babel/core` installed in the project. Only
the aliases apply: each file's own source is what is scanned and carried, and
an edge stays keyed by the specifier written there (`#local/abc`). Every
instance of the plugin the config lists counts, by name or as a `require`d or
imported value, the first to map a path winning as in Babel; one a preset brings
in does not. Not with `github-bundle`.

The Metro plugin keys its edges the same way: `withStasis()` runs Metro's
transformer through stasis's, which records each import as written, before any
Babel plugin rewrites it.

`--babel-aliases=aliases.json` resolves the same aliases from a JSON file of the
project instead, running nothing: the object a `babel-plugin-module-resolver`
takes as its `alias` option, each alias to the string it maps to, the shape a
`babel.config.js` can `require` (`alias: require('./aliases.json')`).

```json
{ "#local": "./src", "^@lib/(.+)": "./lib/\\1", "lodash": "lodash-es" }
```

They map as the plugin maps them: a key starting with `^` or ending with `$` is
a regular expression whose groups `\1`, `\2`... in its value take, any other
matches the specifier it is or one it starts with and `/`, keeping the rest
(`#local/abc` to `./src/abc`); the first key to match wins. A value starting
with `./` or `../` is a path from the cwd, as the plugin's is from Metro's
project root; any other is the specifier it maps to, a package's name. The
file must lie in the project, and is not carried. The same for every
`--platforms` target; not with `--babel`.

A `package.json` `imports` specifier (`#local/abc`) keeps Metro's exact rule
under either, as `babel-plugin-module-resolver` leaves it: its target must name
the file itself. An alias of the same name, in the aliases file or the Babel
config, rewrites it first, as it would under Metro.

What only a dev build imports (`if (__DEV__) require(...)`) is bundled too,
unless `--define` gives the values a release build inlines: see
[Defines](#defines---define).

```sh
stasis bundle --metro --platforms=ios,android --jsx --resources=png,svg,ttf index.js
```

### TypeScript (`--typescript`)

`--typescript` resolves TS sources that import by output name the way tsc
does: a `./x.js` (or `.jsx`/`.mjs`/`.cjs`) specifier with no such file on disk
lands on its on-disk `./x.ts` or `./x.tsx` (`.mts`/`.cts`) source, and an
extensionless `./x` probes `./x.ts`, `./x.tsx` and `./x/index.ts(x)`. The same
substitution applies to package `main`/`exports`/`imports` targets and bare
subpaths. An existing `.js` always wins over its `.ts` twin.

None of this applies from or into `node_modules`, by real path: an installed
package is used as published, while a monorepo's workspace packages, linked in
through `node_modules`, really live outside it and resolve like the project's
own files.

It is implied without the flag when every entry is TypeScript and their
relative imports of JS outputs (`./x.js`) are each only on disk as the TS
source (`./x.ts`), tsc's convention; a project of Node-compatible `.ts` files
importing `./x.ts` keeps Node's resolution. Otherwise an import that fails but
would resolve under it names the file and `--typescript` in the error.

It honors tsconfig `compilerOptions.paths` aliases (e.g. `"@/*": ["./src/*"]`,
resolved against `baseUrl`, `extends` followed) for bare specifiers nothing
else resolves, an extensionless target completing as tsc's does (`.ts`, `.tsx`,
then `.js`, `.jsx`, then the directory's `index`). `--tsconfig=path` names the
config; without it, the `tsconfig.json` beside the importing file's
`package.json` applies when present: in a monorepo (a `pnpm-workspace.yaml` or
`package.json` `workspaces` at or above the cwd) the nearest named
`package.json` at or above the file, else the project's one (the nearest named
`package.json` at or above the cwd). Never for a file in `node_modules`, and no
lookup walks through one.

Combines with `--jsx`, `--flow`, `--conditions`, `--mainFields` and `--metro`,
not with `--metro-resolver`.

```sh
stasis bundle --typescript src/index.ts
stasis bundle --typescript --tsconfig=tsconfig.build.json src/index.ts
```

## JSX and Flow

`--jsx` has the scanner parse JSX in `.js`/`.cjs`/`.mjs` files, whose extension
can't tell whether they hold JSX (the React Native convention); it is off by
default, and `.jsx`/`.tsx` files are parsed as JSX by extension with no flag.
JSX in TS goes in a `.tsx` file, as TypeScript itself requires. The JSX source
is stored verbatim, for `stasis build --loader=.js:jsx` to transform later: see
[build](build.md#jsx-in-jsts).

`--flow` strips Flow type syntax from a `.js`/`.cjs`/`.mjs` file oxc can't
parse and retries, so the import graph resolves; the stored source stays the
original bytes. It needs the optional `flow-remove-types` dependency, and
combines with `--jsx`, `--conditions`, `--mainFields` and `--metro`.

## Defines (`--define`)

`--define=KEY=VALUE` gives a global the value the build gives it, and the scan
leaves out what only the code that value keeps from running imports:

```sh
stasis bundle --metro --platforms=ios,android --define=__DEV__=false --define=process.env.NODE_ENV='"production"' index.js
```

With those, `if (__DEV__) require('./devtools')` reaches nothing, and a package
picking its build by `process.env.NODE_ENV === 'production'`, as React does,
reaches only its production build.

- KEY is an identifier or a dotted path of them, matched as written:
  `process.env.NODE_ENV`, not `process.env['NODE_ENV']` or
  `process.env?.NODE_ENV`. VALUE is JSON, as esbuild's `--define` takes it: a
  string, quoted (`'"production"'` in a shell), a number, `true`, `false` or
  `null`. Repeat the flag for each.
- What is left out is the side of an `if`/`else` or `?:`, or the right of `&&`
  or `||`, that a test it folds to a constant keeps from running. A test folds
  where it is built of the defined names, literals, `!`, `void 0`, `===`, `!==`,
  `==` and `!=`, and `typeof` compared with a string (other than `'object'` or
  `'symbol'`). A test it can't fold (`debug && __DEV__`, one making a call, or
  `??`) keeps both sides, as without `--define`. A static `import` is never in
  a branch, and is always followed.
- A file that binds a defined name itself (`const __DEV__ = ...`, a parameter,
  an import, `const process = ...`) or writes to it (`process.env.NODE_ENV =
  ...`, `process.env = {}`) keeps its own: there the define doesn't apply. A
  TypeScript `declare const __DEV__: boolean` binds nothing.

Metro's release build (`dev: false`) inlines `__DEV__` as `false` and
`process.env.NODE_ENV` as `"production"`, folds away the branches they decide,
and only then collects a file's dependencies. Its dev build inlines neither.
So under `--metro`, those two defines bundle what a release build reaches, and
no define what a dev build reaches. The scan folds only tests Metro's constant
folding folds too, and leaves alone those React Native's Babel transforms keep
it from folding: `??`, which becomes an assignment, and a `typeof` compared
with anything but a string, which becomes a call. So the bundle carries every
file Metro's graph holds. Metro may fold tests the scan doesn't; what those
import is carried anyway. A name a Babel plugin of the project inlines
(`babel-plugin-transform-define`, Expo's `process.env.EXPO_OS`) can be defined
the same way. One the build doesn't inline leaves out files Metro still
bundles.

A bundle built with defines holds what those values run, and no more. Where
they don't hold (a dev build against a bundle built for release, or
`stasis run --bundle=load` under another `NODE_ENV`), an import of a file it
left out fails, as an import of any file the bundle doesn't carry does.

## Resources and manifests

A reached file that is not code (an imported `.png`, `.svg` or font) fails the
build by default. `--resources=png,svg,ttf` carries the allowlisted ones (by
bare extension, or extensionless filename such as `LICENSE`) as resources, with
their import edges recorded: see [build](build.md#non-code-assets---resources)
and [file formats](file-formats.md#resources-in-the-bundle). With `--mainFields`
or `--metro`, the allowlist is the `resources` of the `stasis.config.json` in
the cwd, the directory these bundles' paths are relative to, where
`--resources` isn't given; given, it replaces the config's rather than adding
to it.

`--package-json` bundles each bundled module's `package.json`, even one the
scan never reached, so `stasis run --bundle=load` and `stasis prune` can read
every dependency's manifest. It is the `packageJSON` key of
[`stasis.config.json`](file-formats.md#stasisconfigjson).

## Other languages

`stasis bundle` also builds Solidity, PHP, Bash and Rust bundles, from `.sol`,
`.php`, `.sh`/`.bash` and `.rs` entries, all the entries of one invocation in
one language. How each is resolved and what the bundle carries is in
[file formats](file-formats.md#source-language-bundles-solidity--php--bash--rust).

```sh
stasis bundle [--mapping=path/to/remappings(.txt|.toml)] [--manifests] [--add] [--output=(path|-)] path/to/(file.sol|dir) ...
stasis bundle [--add] [--output=(path|-)] path/to/file.php ...
stasis bundle [--add] [--output=(path|-)] path/to/file.(sh|bash) ...
stasis bundle [--cargo] [--cargo-features=a,b,pkg/c] [--cargo-no-default-features] [--cargo-all-features] [--cargo-target=(triple|host)] [--cargo-manifests] [--add] [--output=(path|-)] path/to/file.rs ...
```

A Solidity directory entry stands for every `.sol` file under it (a missing or
empty one is skipped): `stasis bundle src test script` is what `forge build`
compiles, `stasis bundle contracts` what Hardhat does. Imports resolve through
the remappings `forge build` uses (`remappings.txt`, `foundry.toml`'s profile,
`FOUNDRY_PROFILE`, `lib/` auto-detection, dependencies' own configs included),
else a root `remappings.txt`, then `node_modules` by file path; an import must
reach a `.sol` file inside the project, and a dependency's only other
dependencies' files.

| Flag | Meaning |
| - | - |
| `--mapping=path` | Solidity: take exactly the remappings that one file lists instead. |
| `--manifests` | Solidity: also carry `foundry.toml`, `remappings.txt`, `foundry.lock`, `soldeer.lock`, `.gitmodules` and `package.json` of the project and its bundled dependencies, as written: RPC/Etherscan keys and URL credentials in them included. |
| `--cargo` | Rust: take the feature and dependency resolution from `cargo metadata`. It runs cargo, so only on a project you trust. |
| `--cargo-features=a,b,pkg/c`, `--cargo-no-default-features`, `--cargo-all-features` | Rust: cargo's `--features`, `--no-default-features` and `--all-features` for the entries' packages. |
| `--cargo-target=(triple\|host)` | Rust: ask rustc for the target's cfgs, so `#[cfg(unix)]`-style code for other targets stays out too; otherwise it is all kept. |
| `--cargo-manifests` | Rust: also bundle each bundled package's `Cargo.toml` and build script (a vendored crate's `.cargo-checksum.json` too), the workspace `Cargo.toml`, `Cargo.lock` and cargo configs, as written: tokens and URL credentials in them included. |

A Rust bundle resolves each crate's Cargo features from `Cargo.toml` and
`Cargo.lock` like `cargo build` of the entries' packages, so `#[cfg(feature =
...)]` code that is off stays out: by cargo's own resolver where there is a
`Cargo.lock` (version 3 or 4; an older one stops the build), `--cargo-target`
and every locked package in-tree, else by replaying the manifests (said, with
why).

## `stasis add`

```sh
stasis add path/to/(file|dir) ...
```

`stasis add` adds the listed files to the project's bundle(s) as they are, with
no dependency resolution, where a file the import graph never reaches has to
be attested anyway. It takes no options: the bundle files and the resource
allowlist come from `stasis.config.json` (`bundleFile`, `resourcesBundleFile`,
`resources`, `brotliQuality`, all optional; the file itself is required). A
`stasis.lock.json` is updated only when one already exists. It also ships on
the core CLI as `stasis-core add`.

A directory expands to every file under it, minus what a sweep leaves out:

- dotfiles, and everything under a dot-directory (`.env`, `.git/`, ...): the
  sweep never finds them, so they aren't counted as skipped either;
- files under an `example`/`examples`, `__tests__`, `__mocks__`, `jest` or
  Apple prebuilt slice (`ios-arm64`, ...) directory, below the named root only:
  `stasis add src/examples` sweeps the directory it was pointed at, `stasis add
  src` skips an `examples` it merely found;
- type declarations (`.d.ts`, `.d.mts`, `.d.cts`), `*.env` files, stasis's own
  artifacts (`stasis.lock.json`, `*stasis*.br`) and the bundles this run
  writes to;
- what a native walk leaves out: `*.md`, `*.log`, `*.map`, `*.flow` and
  `*.swiftdoc` files (and `*.bat` off Windows), `LICENSE`/`LICENCE`/
  `THIRD-PARTY-LICENSES`, `yarn.lock`, and tool configs such as `.prettierrc`,
  `.flowconfig`, `.editorconfig`, `circle.yml` and `gradle-wrapper.properties`.

So `stasis add src` does not attest everything under `src`. The skipped files
are counted in the summary, the dotfiles aside. A file the command names is
always taken, exclusions aside, and validated like any other: a non-code file
needs its extension, or its extensionless filename (`LICENSE`), in the
`resources` allowlist.

```sh
stasis add a.js icon.svg     # these two files
stasis add src assets        # every file under them, minus the set above
stasis add src src/README.md # the README too, named
```

To have `stasis run` and `stasis bundle` add the same files each time, name them
in `stasis.config.json`'s [`extra`](file-formats.md#stasisconfigjson), globs
included (`"extra": ["a.js", "b/", "c/*.png"]`).
