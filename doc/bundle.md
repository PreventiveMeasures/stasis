# `stasis bundle`

`stasis bundle` builds a `stasis.code.br` bundle statically, from the entries'
import graph alone, without executing anything: each entry is parsed, its
imports resolved, and every reached file read, recursively. It is the static
counterpart of `stasis run --bundle=add`, for code that can't or shouldn't run
to be captured (a React Native app, a library's entry points).

```sh
stasis bundle [--scope=(node_modules|full)] [--conditions=cond1,cond2] [--mainFields=field1,field2] [--jsx] [--flow] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--package-json] [--lockfile=path/to/stasis.lock.json] [--add] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx) ...
stasis bundle --metro [--metro-resolver] --platforms=ios,android [--platforms=web] [--jsx] [--flow] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--package-json] [--lockfile=path/to/stasis.lock.json] [--add] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx) ...
```

This page covers JS/TS bundles. `stasis bundle` also builds Solidity, PHP, Bash
and Rust bundles, see [Other languages](#other-languages).

| Flag | Meaning |
| - | - |
| `--output` / `-o` | Where to write. Default: `stasis.code.br` in the project root, or in the cwd with `--mainFields`/`--metro`, see [Output](#output). `-` streams to stdout. |
| `--add` | Merge the fresh build into the bundle already at `--output` instead of replacing it. Not with `--output=-`. |
| `--lockfile=path` | Also write a `stasis.lock.json` attesting every bundled file. See [Companion lockfile](#companion-lockfile---lockfile). |
| `--scope` | `full` (default) or `node_modules`, as `stasis run`'s. Not with `--mainFields`/`--metro`, which always emit full scope. |
| `--conditions=a,b` | Extra `exports`/`imports` resolution conditions, on top of Node's (with `--mainFields`, on top of a bundler's). See [Conditions](#conditions). |
| `--mainFields=a,b` | Legacy package entry fields to honor, in order (e.g. `react-native,browser,main`), incl. the `browser` field's object redirection. |
| `--metro --platforms=ios,android` | Resolve the way Metro does. See [Metro](#metro---metro). |
| `--metro-resolver` | With `--metro`: resolve through the project's own `metro-resolver` instead of the built-in approximation. |
| `--jsx` | Parse JSX in `.js`/`.cjs`/`.mjs` files. `.jsx`/`.tsx` files need no flag. See [JSX and Flow](#jsx-and-flow). |
| `--flow` | Strip Flow types from `.js`/`.cjs`/`.mjs` files oxc can't parse. Needs the optional `flow-remove-types` dependency. |
| `--typescript` | Resolve TypeScript sources the way tsc does. See [TypeScript](#typescript---typescript). |
| `--tsconfig=path` | With `--typescript`: the tsconfig whose `compilerOptions.paths` aliases apply. |
| `--resources=png,svg` | Carry reached non-code files as resources instead of failing on them. See [Resources and manifests](#resources-and-manifests). |
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

`--metro-resolver` resolves through the project's own installed
`metro-resolver` (it ships with `react-native`/`metro`) for byte-for-byte
Metro fidelity, instead of the built-in approximation. It can't substitute
`.js` for `.ts`, so it doesn't combine with `--typescript`.

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

## Resources and manifests

A reached file that is not code (an imported `.png`, `.svg` or font) fails the
build by default. `--resources=png,svg,ttf` carries the allowlisted ones (by
bare extension, or extensionless filename such as `LICENSE`) as resources, with
their import edges recorded: see [build](build.md#non-code-assets---resources)
and [file formats](file-formats.md#resources-in-the-bundle).

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
