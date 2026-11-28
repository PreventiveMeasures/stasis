# `stasis bundle`

`stasis bundle` builds a `stasis.code.br` from the entries' import graph
without executing anything: the static counterpart of
`stasis run --bundle=add`, for code that can't or shouldn't be run (a React
Native app, a library's entry points).

```sh
stasis bundle [--deptree] [--scope=(node_modules|full)] [--conditions=cond1,cond2] [--mainFields=field1,field2] [--jsx] [--flow] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--define=K=V ...] [--package-json] [--lockfile=path/to/stasis.lock.json] [--lockfile-only] [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx|css) ...
stasis bundle [--deptree] --metro [--metro-resolver] [--babel|--babel-aliases=path/to/aliases.json] --platforms=ios,android [--platforms=web] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--define=K=V ...] [--package-json] [--lockfile=path/to/stasis.lock.json] [--lockfile-only] [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx|css) ...
stasis bundle [--deptree] [--babel] [--metro-resolver] [--flow] [--cargo] [--cargo-target=(triple|host)] [--lockfile=path/to/stasis.lock.json] [--lockfile-only] [--add] [--format=(br|tgz)] [--output=(path|-)] [entry ...]   # the entries' options from stasis.config.json
```

For Solidity, PHP, Bash, Rust and TEAL, see [Other languages](#other-languages).

| Flag | Meaning |
| - | - |
| `--output` / `-o` | Where to write, see [Output](#output). `-` streams to stdout. |
| `--add` | Merge the fresh build into the bundle already at `--output` instead of replacing it. Not with `--output=-`. |
| `--format=(br\|tgz)` | Write a `stasis.code.br` (`br`) or a [`.stasis.tgz`](file-formats.md#stasistgz) (`tgz`). Default: `tgz` for an `--output` named `stasis.tgz` or `<name>.stasis.tgz`, else `br`. Refused if it disagrees with the `--output` name, or with `--brotli-quality` for a tgz. |
| `--deptree` | Lay out the dependencies from the lockfile, with nothing installed, see [Dependencies from the lockfile](#dependencies-from-the-lockfile---deptree). JS and Solidity. |
| `--lockfile=path` | Also write a `stasis.lock.json` attesting every bundled file, see [Companion lockfile](#companion-lockfile---lockfile). |
| `--lockfile-only` | Write only the lockfile, see [Companion lockfile](#companion-lockfile---lockfile). Not with `--output`, `--add`, `--format` or `--brotli-quality`. |
| `--scope` | `full` (default) or `node_modules`, as for `stasis run`. `--mainFields`/`--metro` are always full scope and refuse any other, given here or by the cwd's [`stasis.config.json`](file-formats.md#stasisconfigjson) (which `--scope=full` overrides). |
| `--conditions=a,b` | Extra `exports`/`imports` resolution conditions, see [Conditions](#conditions). |
| `--mainFields=a,b` | Legacy package entry fields to honor, in order (`react-native,browser,main`), see [Resolution](#resolution). |
| `--metro --platforms=ios,android` | Resolve as Metro does and build as its release build does, see [Metro](#metro---metro). |
| `--metro-resolver` | With `--metro`: resolve through the project's own `metro-resolver` instead of the built-in approximation. |
| `--babel` | With `--metro`: resolve through the import aliases of the project's `babel.config.*` (`babel-plugin-module-resolver`). See [Metro](#metro---metro). |
| `--babel-aliases=path.json` | With `--metro`: resolve through import aliases listed in a JSON file of the project, without running anything. See [Metro](#metro---metro). |
| `--jsx` | Parse JSX in `.js`/`.cjs`/`.mjs` files, see [JSX and Flow](#jsx-and-flow). |
| `--flow` | Strip Flow types, see [JSX and Flow](#jsx-and-flow). |
| `--typescript` | Resolve TypeScript sources the way tsc does, see [TypeScript](#typescript---typescript). |
| `--tsconfig=path` | With `--typescript`: the tsconfig whose `compilerOptions.paths` aliases apply. |
| `--resources=png,svg` | Carry reached non-code files as resources instead of failing on them, see [Resources and manifests](#resources-and-manifests). |
| `--define=K=V` | A global's value in the build (`__DEV__=false`); repeatable. See [Defines](#defines---define). |
| `--package-json` | Also bundle each bundled module's `package.json`, see [Resources and manifests](#resources-and-manifests). |
| `--brotli-quality=0..11` | Compression level, default `6`. |

`stasis.config.json` also sets:

- [`extra`](file-formats.md#stasisconfigjson): files the graph never reaches,
  carried by the bundle and its `--lockfile`, for every language.
- [Allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules):
  what the bundle may carry. Every offender is named and nothing is written.
- [`excludeModules`](file-formats.md#excluded-modules): dependencies treated as
  not installed.

## Output

By default a JS bundle is written as `stasis.code.br` in the directory its
paths are relative to: the project root at or above the cwd (for a workspace
package, the workspace root), where `stasis run --bundle=load` looks for it;
with `--mainFields` or `--metro`, the cwd, so run it from the package's
directory. `--output` is relative to the cwd; with `--output=-` the summary
goes to stderr.

A [`.stasis.tgz`](file-formats.md#stasistgz) holds the bundle's files and
their lockfile; every command that reads a bundle accepts one. Without
`--output` it is written as `stasis.tgz` where the `stasis.code.br` would go.
It records no `reason` for `stasis audit --reason` and `--why`. `--add` merges
into one as into a `stasis.code.br`.

Under `--add`, a file both bundles carry with different content fails; with
no bundle on disk, it is a plain write.

```sh
stasis bundle src/index.js            # writes stasis.code.br in the project root
stasis bundle --add src/worker.js     # merges the worker's graph into it
```

`--add` refuses a bundle or `--lockfile` rooted elsewhere than the fresh
build, naming both roots: rebuild without `--add`. That follows writing a
`stasis.lock.json` or `stasis.code.br` in a package nested below the build's
root, which roots later runs and builds there (see
[discovery](file-formats.md#discovery)); `stasis bundle` warns when it does,
naming the path at the root to write it at instead.

## Companion lockfile (`--lockfile`)

`--lockfile=stasis.lock.json` also writes a lockfile of the same graph, with
integrities instead of content. With `--conditions` it attests the
conditions-selected graph, so a plain `stasis run --lock=frozen` fails closed:
pair it with `--bundle=load`, or replay the conditions. Under `--add` it is
merged like the bundle, and refused if none is there (write it from the first
build, or drop it).

A JS build, with or without `--lockfile`, is checked against the lockfile at
the `--lockfile` path, else the project's (`EXODUS_STASIS_LOCK_FILE`, else the
root's), in the project's run mode (`EXODUS_STASIS_LOCK`, or `frozen` where
`stasis.config.json` pins it, see [modes](run.md#modes)); with neither,
`frozen` if the lockfile exists, `add` if it doesn't or under `--add`:

| Mode | Behavior |
| - | - |
| `add` | The build must agree with each file and module the lockfile records; `--lockfile` writes the one built (with `--add`, merged with the one there). |
| `frozen` | As `add`, but the lockfile must exist and attest every file built, and the bundle must load with it under `stasis run --lock=frozen --bundle=load`. It is left unchanged: `--lockfile` and `--lockfile-only` write nothing. |
| `replace` | The existing lockfile is not read; `--lockfile` is required and writes the one built (with `--add`, of the merged bundle). |
| `ignore` | The lockfile there is neither read nor written; `--lockfile` and `--lockfile-only` are refused. |
| `none` | There must be no lockfile there; `--lockfile` and `--lockfile-only` are refused. |

A checked build prints
`[stasis] Held 6591 files in 346 packages from src to stasis.lock.json` to
stderr. To overwrite the lockfile, set `EXODUS_STASIS_LOCK=replace` (or `add`,
to keep what it records). Under `--add`, the existing bundle is checked against
it too. What the lockfile, or the bundle `--add` adds to, records of a
dependency's [`integrity`](file-formats.md#stasiscodebr) and `patch` is
checked against how it was installed.

`--lockfile-only` writes, byte for byte, the lockfile `--lockfile` would, at
`--lockfile`'s path, else the one the build is checked against; under the
default `frozen`, it only checks an existing one. The bundle is still built and
checked, so the lockfile is refused wherever the bundle would be.

```sh
stasis bundle --lockfile-only src/index.js   # writes stasis.lock.json, or checks the build against an existing one
```

## Dependencies from the lockfile (`--deptree`)

`--deptree` lays the dependencies out in memory from the lockfile that
installs the cwd, as [`stasis github-bundle`](github-bundle.md#dependencies)
does, with nothing installed. In a checkout, the bundle is the one a fresh
install and a plain `stasis bundle` give, except that each dependency's `repo`
records the commit it was published from. Without `--deptree`, `stasis bundle`
reads only the installed dependencies, and fetches and caches nothing.

```sh
git clone https://github.com/owner/name && cd name
stasis bundle --deptree --lockfile=stasis.lock.json src/index.js
```

- The lockfile is whichever of `pnpm-lock.yaml`, `yarn.lock`,
  `package-lock.json` and `soldeer.lock` installs the cwd; none, more than one,
  or the other language's (a `soldeer.lock` for JS entries) is refused. The
  config's [`lockfiles`](github-bundle.md#several-lockfiles-lockfiles) replace
  it.
- Nothing may be installed where a tree installs (each of the lockfile's
  projects' `node_modules`, or Soldeer's `dependencies`), not even a link.
  Every refusal comes before anything is fetched.
- Only the bundle and `--lockfile` are written in the project. Fetches are
  cached in the user cache directory, or `STASIS_CACHE_DIR` if set (see
  [audit](audit.md#repository-advisories)).
- The tree is never [lazy](github-bundle.md#lazy---no-lazy): every package is
  fetched first, every tarball and zip checked against the lockfile. An npm
  tarball in npm's cache or stasis's own is read from there. A Soldeer git
  dependency on GitHub is fetched with `GITHUB_TOKEN` if set, a private npm
  package with the token `github-bundle` uses.
- `entries` and `extra` apply as without the flag, and
  [`installDevDependencies`](github-bundle.md#devdependencies-installdevdependencies)
  and a [`.yarnclean`](github-bundle.md#yarnclean) as in `github-bundle`. No
  entry can set `deptree`.
- `--babel` and `--metro-resolver` are refused: they run the project's code from
  disk, where nothing is installed. `--babel-aliases` takes the same aliases
  without running anything.

## Entry options (`stasis.config.json`)

The `entries` of the cwd's [`stasis.config.json`](file-formats.md#stasisconfigjson)
map each entry path, relative to the cwd (or a
[glob pattern](#entry-patterns)), to the flags to build it with, named without
the `--`:

```json
{
  "entries": {
    "index.js": { "metro": true, "metro-resolver": true, "platforms": ["ios", "android"] },
    "node_modules/@react-native-community/cli/build/bin.js": { "metro": false }
  }
}
```

An entry may also restrict what its build carries:

```json
{
  "disallowedModules": ["request"],
  "entries": {
    "src/worker.js": { "allowedPaths": ["src/worker", "node_modules"], "allowedModules": ["@exodus/bytes"] },
    "src/index.js": { "disallowedPaths": ["src/worker"] }
  }
}
```

A boolean flag takes `true` or `false` (the default), any other a string as on
the command line, and a list (`platforms`, `conditions`, `mainFields`,
`resources`, `cargo-features`, `define`) also an array of strings. `output`,
`lockfile`, `lockfile-only`, `brotli-quality`, `add` and `deptree` can only be
flags. `stasis build` reads an entry's `jsx`, `flow`, `define` and
`metro`/`platforms` from the config a bundle carries (see
[build](build.md#entry-options-stasisconfigjson)).

- `stasis bundle` with no entries bundles every entry named there; an entry
  named there is built with its options, and no flag may be given but those
  six and the consent flags below.
- `babel`, `metro-resolver`, `cargo` and `cargo-target` run a program (the
  project's Babel config, its `metro-resolver`, `cargo` and what its
  `.cargo/config.toml` names, `rustc`), so the config alone can't make
  `stasis bundle` run anything: an entry setting one fails unless its flag is
  given too, as consent (`cargo-target` with the same value, as
  `--cargo-target=host`). The flag fails where no entry given sets it, and
  applies only to those that do. `babel-aliases` and `flow` need no consent.
- The entries given must be all named there or none. If none is, they are
  built with the flags exactly as without the config.
- Entries with different options or languages (JS and `.sol`) are built apart
  and merged as `--add` merges; their paths must be relative to the same root.
- The config's `extra` is added once, by the config's `resources` (an entry's
  `resources` applies to its graph only).
- An entry's `allowedPaths`, `disallowedPaths`, `allowedModules` and
  `disallowedModules` (see
  [Allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules))
  apply to its own graph, without `extra`, beside the config's, neither
  overriding the other; entries with the same options and rules are built
  together, and an error names them all. Its `excludeModules` likewise applies
  to its own build, beside the config's (see
  [Excluded modules](file-formats.md#excluded-modules)).

`stasis run` ignores `entries`; `stasis github-bundle` reads them but runs
nothing (see its [Entries](github-bundle.md#entries)).

```sh
stasis bundle --metro-resolver   # bundles index.js with --metro and bin.js without
stasis bundle --metro-resolver --output=app.br index.js
```

### Entry patterns

A key may be a glob pattern, each path it matches an entry with its options:

```json
{ "entries": { "apps/*/src/index.js": { "metro": true, "platforms": ["ios", "android"] } } }
```

Node's `fs.globSync` expands it from the config's directory, as for
[`extra`](file-formats.md#stasisconfigjson): `*`, `?`, `**` (no dotfile
directories), `{a,b}`, `[ab]` and `!(a)`. A key with none of these is a path.

- A pattern matches nothing in a `node_modules` directory: name such an entry
  by its path.
- A pattern matching nothing stands for itself (a missing entry), so
  `app/[id].tsx` can be named by its path, unless that path matches another
  file as a pattern (`app/i.tsx`).
- Two keys naming the same file are refused, whatever options they set: leave
  it out of the pattern (`apps/!(web)/src/index.js` beside
  `apps/web/src/index.js`).
- A pattern with a `.` or `..` segment other than a leading `./`, in a brace
  list too, is refused, as
  [`stasis build`](build.md#entry-options-stasisconfigjson) can't match against
  it. A path's `..` is resolved as usual.
- An entry given on the command line counts as named if a pattern matches it.

## Next.js apps (`next.config.*`)

An entry that is a Next.js app's `next.config.js`, `.mjs`, `.ts` or `.mts`
also stands for the files `next build` takes by name, found as Next 16 finds
them, each an entry with its options:

```sh
stasis bundle --typescript --resources=svg,woff2 apps/web/next.config.ts
```

- `app` and `pages` are looked for in the config's directory, else its `src/`;
  in different directories they are refused. With neither, the config is an
  entry alone.
- From `app`, at any depth: each `page`, `route`, `layout`, `template`,
  `default`, `loading`, `error`, `not-found`, `forbidden` and `unauthorized`,
  and each metadata route's code (`sitemap`, `icon`, `apple-icon`,
  `opengraph-image`, `twitter-image`, and numbered variants of the last four:
  `icon1`), used or not; directly in `app` only, `robots`, `manifest`,
  `global-error` and `global-not-found`. A private folder (`_components`) is
  left out whole. Static metadata files (`favicon.ico`, `robots.txt`) and
  `public` go in [`extra`](file-formats.md#stasisconfigjson).
- From `pages`: every file but a `.d.ts`.
- Beside the directory holding them, `proxy` (`middleware` before Next 16) and
  `instrumentation`; `instrumentation-client` in `src/`, else the config's
  directory.
- Each by an extension of `pageExtensions` (default `tsx`, `ts`, `jsx`, `js`),
  read from the config, not run: a list of strings, as a property or by
  assignment, is taken; any other value (a variable, a spread, a call) is
  refused, as is an entry that isn't a JS/TS file (`page.mdx`). Name the
  entries yourself then.
- A link is followed; one leading nowhere is skipped.
- A file also named directly is one entry. A pattern
  (`apps/*/next.config.ts`, see [Entry patterns](#entry-patterns)) stands for
  each app it matches. `stasis build` finds an entry's options by the key that
  is its path or a pattern matching it (see
  [build](build.md#entry-options-stasisconfigjson)), so it builds an app's
  files, which no key names, with the flags given.

Imports resolve by the build's options, not as Next's compiler does: not
through its aliases (an `app`'s React is Next's own copy), nor under
`react-server` for server components. Stylesheets are followed as code (see
[Stylesheets](#stylesheets-css)); images and fonts need
[`--resources`](#resources-and-manifests); `@/` resolves through
`tsconfig.json` `paths` with [`--typescript`](#typescript---typescript); Next's
build-time `process.env.NODE_ENV` and `process.env.NEXT_RUNTIME` (`"nodejs"`
on the server) can be given with [`--define`](#defines---define).

In a workspace, the bundle's root is the workspace's (see [Output](#output)),
and the `stasis.config.json` naming the entry belongs there too: one in the
app's directory roots the build there, below the `node_modules` its
dependencies are installed in.

```json
{ "entries": { "apps/web/next.config.ts": { "typescript": true, "resources": ["svg", "woff2"] } } }
```

## Resolution

By default imports resolve as Node does: `exports`/`imports` with Node's
conditions, `main`, extension and index probing.

- `--conditions=react-native,browser` adds conditions, without legacy
  `mainFields` or platform suffixes.
- `--mainFields=react-native,browser,main` honors legacy package entry fields
  in that order, including the `browser` field's object form (file redirection
  and `false` stubs).

An import that doesn't resolve, or resolves outside the project root, fails
the build where the entries load it eagerly (static `import` and
`export … from` chains); behind a `require()` or `import()` it is a warning,
and falls through at load. A file outside the root is never carried. Where
only one of a file's `require()` and `import()` leaves the root, the other's
edge is kept. An import inside the root for one `--platforms` target and
outside it for another fails the build.

### Conditions

The conditions each mode asserts for `exports` and `imports` maps (`default`
always matches):

| Mode | Conditions |
| - | - |
| Node (default) | `node`, `import` or `require`, `module-sync`, `node-addons`, then `--conditions` |
| `--mainFields` | `import` or `require`, `module`, then `--conditions` |
| `--metro`, `--metro --metro-resolver` | `import` or `require`, `react-native`, and `browser` on `web` |

Resolving as Node, `import` or `require` follows the edge (`import`,
`export … from` and `import()` assert `import`, `require()` `require`), so
`stasis run --bundle=load` lands on the file Node would. An `exports` map
listing `node` first takes that branch whatever `--conditions` adds. A
specifier a file resolves one way only (an `exports` map with just a `require`
branch, both `require()`d and `import()`ed) is kept under the resolving one's
conditions, and misses the other way under `--bundle=load` too (see
[`imports`](file-formats.md)).

Under `--mainFields` and `--metro`, `import` or `require` follows the importing
file's format. `uuid` 9, whose `exports` lists `node` first, resolves to its
`browser` target under `--mainFields=browser,module,main --conditions=browser`,
and under `--metro` to the first of its `react-native`, `default` and, on
`web`, `browser` targets. `--metro-resolver` is given `react-native` and adds
the rest itself. `--mainFields` also asserts `module`, for an `import` and a
`require()` alike, as esbuild and webpack 5 do; Node and Metro never do. webpack
also asserts `webpack` and `production` or `development`: add them with
`--conditions` where a package's map tells them apart.

### Node builtins

Resolving as Node, a builtin (`fs`, `node:fs`) is left to the runtime, not
bundled. Under `--mainFields` and `--metro`, a bare builtin name (`buffer`,
`events`) is the installed npm package of that name, unless a
`browser`/`react-native` map entry for it (`{"fs": false}`) applies; a `node:`
specifier, or a name no installed package resolves, stays a builtin, recorded
but not bundled (where Metro and webpack would fail the build).

### Native addons

A `require()` whose argument isn't a string literal is a warning and falls
through at load, unless it names a native addon by a partly spelled path:

```js
const target = `${process.platform}-${process.arch}`
module.exports = require(`./native/lib_${target}_nodejs.node`)
```

Resolving as Node, every file there the path can spell is bundled, for every
platform (`native/lib_linux-x64_nodejs.node`,
`native/lib_darwin-arm64_nodejs.node`, …), each with an edge of the specifier
that spells it, as a [resource](#resources-and-manifests) needing no
`--resources` entry.

- The path is a template literal, or strings joined by `+`, starting with `./`
  or `../`, ending in `.node`, with at least one expression.
- An expression stands for any run of characters within one name, never a
  `/`: `` `./prebuilds/${platform}-${arch}/addon.node` `` names each
  `prebuilds/*/addon.node`, none deeper.
- Any other path, one spelling no file, and an `import()` stay a warning.
- Under `--mainFields` and `--metro` none is followed, except in the configs
  and toolchain a `--metro` bundle traces as Node code.

A `.node` file named by a string literal needs `node` in
[`--resources`](#resources-and-manifests), unless a partly spelled path also
names it. Under `stasis run --bundle=load`, Node loads an addon from disk, so
it must be there, checked before it runs against the bundle's bytes or the
lockfile's hash (see [run](run.md#native-addons)).
[`stasis extract`](extract.md) writes addons out with the rest.

### Metro (`--metro`)

`--metro --platforms=ios,android` resolves as Metro does: React Native's
[conditions](#conditions) and `mainFields`, and the `.ios`/`.android`/`.native`
suffixes, each platform separately, all in one bundle. `--platforms` is
repeatable and comma-separated (`web` too). Not with `--conditions` or
`--mainFields`.

- Its files are attributed to the `bundle:metro` consumer in the bundle's
  `reason` map (`stasis audit --reason=bundle:metro`; other builds use
  `bundle`); what only the project's configs reach (below), to `bundle`; a
  file both reach, to both.
- Its code is `generic-javascript` (`.js`, `.jsx`) or `generic-typescript`
  (`.ts`, `.tsx`), which `stasis run --bundle=load` refuses to run under Node,
  except that a file whose name gives its format keeps it (`.json`, `.mjs`,
  `.cjs`, `.mts`, `.cts`), and one Node also loads (a config requiring it) is
  recorded as Node loads it.
- Its assets are Metro's default `assetExts` (`png`, `jpg`, `svg`, `ttf` and
  the like) plus each string the project's `metro.config.js` lists under
  `assetExts` (`assetExts.push('riv')`), read from its source, never run; one
  it filters out is still an asset.

Where the project has an `rn.config.json` (the config of
[`@preventive/rn`](https://github.com/PreventiveMeasures/libraries/tree/main/rn)'s
`rn-bundle`), it is read as `rn-bundle` reads it:

- `assetExts`: Metro's defaults plus its own where it has some (`["riv"]`), no
  Metro config read; the defaults alone with `"metroConfig": false`; else plus
  those of the Metro config its `metroConfig` names, else of
  `metro.config.js`.
- `sourceExts` and `assetResolutions`: Metro's defaults, then its additions.
  Only `sourceExts` of code a bundle carries count (`mjs`, `cjs`, `mts`,
  `cts`).
- One `rn-bundle` refuses fails the bundle: not a JSON object, an option stasis
  reads (these and the restrictions below, at the top level or in
  `development` or `production`) of the wrong type, or an extension added to
  `assetExts` or `sourceExts` that the other has.
- Its `allowedPaths` and `disallowedPaths` (globs of paths from the project
  root), `allowedModules` and `disallowedModules` (globs of package names), and
  those under `production`, each list a rule of its own, apply to the app's
  Metro build as to `rn-bundle`'s; those under `development` don't. A package
  matches by both its `package.json` name and the name it is installed under
  (an npm alias): forbidden if either is, allowed only if both are; a project
  file, by the project's name. Each rule is checked against every file of the
  Metro graph on every platform by real path (what the entries reach, what
  Metro and Babel add, each file of an asset), not the configs and toolchain,
  native build inputs or a transform's input. A violation fails the bundle,
  naming each file and rule:

```
stasis bundle: the --metro build takes what rn.config.json forbids:
  node_modules/nice/index.js is of evil, which matches "evil" of rn.config.json's disallowedModules
```

Without `--metro`, none applies.

A resource the app imports that isn't one of Metro's assets is consumed by a
Babel plugin before Metro collects dependencies (as `@exodus/i18n`'s
`plugin-inline-po` inlines a `require('./messages.po')`): it is carried as the
transform's input, attributed to `bundle:metro`, with no edge from its importer
and no asset registry, and still needs `--resources`.

Under `--metro`, an import or re-export listing only types
(`import { type A } from`, Flow's `import { typeof B } from`,
`export { type C } from`) is no edge; other builds record it. With `--babel`,
a TypeScript file's is an edge where the Babel config runs the TypeScript
transform with `onlyRemoveTypeImports`. `import {} from` is
always an edge; `import type` and `export type` never are.

Where Metro's resolution differs from Node's and esbuild's, it follows
`metro-resolver` 0.87.2 with the context Metro gives it
([`@preventive/rn`](https://github.com/PreventiveMeasures/libraries/tree/main/rn)'s
resolver):

- A package's `browser`/`react-native` map applies before its `exports`; a
  relative import takes the map of the package closest to its target.
- Where `exports` serves nothing (no condition Metro asserts matches),
  resolution falls back to the package's files: `main` through the map.
- The closest `package.json` counts: a subpath directory with its own
  (`ox/erc8010`) resolves through its `main`, not the root `exports`.
- A package can import its own name through its own `exports`.
- A map with a target not starting `./` (a package name, a `../` path), or a
  number or boolean anywhere, is refused whole, as is an `imports` map with a
  key not starting `#`; an `exports` target with an empty, `.`, `..` or
  `node_modules` segment is refused on its own.
- A fallback array takes its first entry in `exports` and serves nothing in
  `imports`; a `null` key shadows the patterns that would match it; a target
  names its file exactly, with no extension or `index` probing.
- Where an `imports` map serves nothing, a `#` specifier falls back to the
  importer's `browser`/`react-native` map, then `node_modules`; from a package
  with no `imports`, it resolves nowhere.
- A directory in `node_modules` that resolves to nothing gives way to the next
  `node_modules` up; a package whose `main` resolves to nothing fails, without
  trying its root `index`.
- A map entry sending a relative path to a package name resolves nowhere; one
  sending a specifier to an absolute path fails it.
- A path ending in `/` names a directory (its `main` or `index`), never a
  file. Platform suffixes are tried with an extension only (`where.ios.js`,
  never `where.ios`).
- A `.d.ts` is no module: an entry field naming one resolves by its stem
  (`dist/index.d.ts` to `dist/index.js`).
- An asset resolves to itself or a scale variant (`@1x` to `@4x`), the lowest
  path that exists, also as a map target and under `--metro-resolver`; a path
  naming a scale variant (`./logo@2x.png`) resolves nowhere. Carrying one needs
  `--resources`. Its other files in its directory come with it, with no edge:
  each scale of its name and type, those for the platform where it has any
  (`logo@3x.ios.png`), else the generic ones; a link by its own name with its
  target's bytes, one from outside the project passed over.

It also carries the native build inputs of the packages shipping native code
(an `ios/` or `android/` directory, or a podspec) that the app links: those
the code graph reaches in `node_modules`; those the app's `package.json` lists
in `dependencies`, `peerDependencies` or `devDependencies`, from the nearest
`node_modules` holding them, none above the project root; and `react-native`.
No `react-native.config.js` is read: a package it disables is carried anyway,
one it adds from elsewhere isn't. Each one's whole tree is carried except the
JS and TypeScript Metro's graph owns, docs, secrets, build output (`build`,
`.gradle`, `.cxx`, `Pods`, `DerivedData`, nested `node_modules`) and prebuilt
binaries; so are its codegen specs, the `.js`, `.jsx`, `.ts` and `.tsx`
modules (not `.d.ts`) named `Native…` or `…NativeComponent` under the
directories its `codegenConfig` names, outside dot, `node_modules` and
`__tests__` directories. A workspace package linked, under any name, into a
`node_modules` its importer resolves from counts as such a package, carried
where it lies; one linked nowhere there is the project's own source. A package
reached only for an asset contributes nothing unless the app's `package.json`
lists it.

It also bundles what the build runs in Node, though the app doesn't import it:

- the cwd's `metro.config.js`, `react-native.config.js` and `rn.config.json`
  with the Metro config its `metroConfig` names, and with `--babel` or
  `--babel-aliases` its `babel.config.js`;
- React Native's CLI (`react-native/cli.js`);
- the `@react-native-community/cli/setup_env.sh` the CLI runs as each command
  starts, as a `shell` script with its executable bit, never traced;
- the `react-native.config.js` of each package `react-native config` reads;
- Metro as React Native's CLI plugin finds it, its workers, transform worker
  and minifier (whether or not the build minifies), and the transformers of
  stasis's Metro plugin where a config requires it (`withStasis()`);
- with `--babel` or `--babel-aliases`, React Native's Babel transformer and the
  plugins and presets the Babel config names, found by reading, never running,
  the modules `babel.config.js` reaches (the plugin and preset lists of the
  project's modules and Babel configs, `require.resolve()` calls,
  plugin-shaped strings in a Babel config) and resolved as `@babel/core`
  resolves them, from the project, else from the module naming them. A name a
  config computes rather than writes isn't found, nor is a project's own
  `transformerPath` or `babelTransformerPath` read.

These are bundled as Node entries (parsed, not run), with what they import
resolved as Node resolves it, each file in the format Node loads it in, even
one the app also imports, and their edges keyed under Node's conditions,
apart from Metro's `*` edges. An import there that Node misses but Metro
resolves is refused. A package only they reach has no native build inputs
carried.

A disabled import (a `browser`/`react-native` map entry set to `false`)
resolves to the project's
`node_modules/metro-runtime/src/modules/empty-module.js` where that file is
empty (only a `"use strict"` directive), else, as with `--mainFields`, to a
synthetic `.stasis/empty-module.js`.

`--babel` applies the aliases the project's Babel config sets (a
`babel-plugin-module-resolver` mapping `#local` to `./src` makes
`import '#local/abc'` reach `src/abc.js`). It runs the project's
`babel.config.(js|cjs|mjs|json)` for each file as Metro's transformer loads it,
with Metro's `caller` and each `--platforms` target, and needs `@babel/core`
installed in the project. Only the aliases apply: each file's own source is
scanned and carried, its edges keyed by the specifiers as written. Every
instance of the plugin the config lists counts, the first to map a path
winning; one a preset brings in doesn't. Not with `github-bundle`.

The Metro plugin (`withStasis()`) keys its edges the same way, each import as
written. An import only Babel or Metro adds (a `@babel/runtime` helper,
`react/jsx-runtime`, `asyncRequire`, an asset's registry) gets no edge, but its
file is carried. Nor does an import a Babel plugin consumes (the `.po` above),
but the resource it names by path from the importer is carried under `metro`
(by real path, none outside the project root), as are an asset's other
scales. Under `--bundle=load`, the plugin refuses such a resource where the
bundle doesn't carry it or its bytes on disk differ, unless `--fs` serves it
(by the path the Babel plugin reads, not a symlink to the carried file); and
it checks every file of an asset, the module's own too, against the bundle's
bytes, unless `--fs=async` serves them and the directory listing Metro finds
them in (so a scale added on disk since the capture isn't part of the asset).

The static build carries those files too, as Metro's code, each scanned for its
own imports:

- under `--babel` or `--babel-aliases`: every `@babel/runtime/helpers/*.js` of
  each `@babel/runtime` a bundled file finds, `metro-runtime`, and the
  polyfills `@react-native/js-polyfills`' `index.js` lists (read, never run);
- with an `import()`: `metro-runtime/src/modules/asyncRequire.js`, resolved
  from the project, else from Metro's package, never outside the project root;
- with JSX: `react/jsx-runtime`;
- with an asset: `react-native/Libraries/Image/AssetRegistry`, resolved from
  its directory with no Babel alias (a project's own `assetRegistryPath` isn't
  read).

`--babel-aliases=aliases.json` takes the aliases from a JSON file of the
project instead, running nothing (the Babel config is still carried): the
object `babel-plugin-module-resolver` takes as its `alias`, mapping each alias
to a string.

```json
{ "#local": "./src", "^@lib/(.+)": "./lib/\\1", "lodash": "lodash-es" }
```

As in the plugin, a key starting with `^` or ending with `$` is a regular
expression whose groups (`\1`) its value can use; any other matches the
specifier it is, or one starting with it and `/`, keeping the rest. The first
key to match wins. A value starting with `./` or `../` is a path from the cwd,
any other a package name. The file must lie in the project, and isn't carried.
The aliases are the same for every `--platforms` target. Not with `--babel`.

Under either, a `package.json` `imports` target must still name the file
itself; an alias of the same name rewrites the specifier first.

It builds as Metro's release build (`react-native bundle --dev false`) does:
with [`--jsx` and `--flow`](#jsx-and-flow), and with `__DEV__` and
`process.env.NODE_ENV` [defined](#defines---define).

```sh
stasis bundle --metro --platforms=ios,android --resources=png,svg,ttf index.js
```

### TypeScript (`--typescript`)

`--typescript` resolves as tsc does: a `./x.js` (`.jsx`, `.mjs`, `.cjs`)
specifier with no such file on disk lands on its `./x.ts` or `./x.tsx`
(`.mts`, `.cts`), and an extensionless `./x` probes `./x.ts`, `./x.tsx` and
`./x/index.ts(x)`, also in package `main`/`exports`/`imports` targets and bare
subpaths. An existing `.js` always wins over its `.ts` twin. None of this
applies from or into `node_modules` by real path, so workspace packages linked
there resolve like the project's own files.

A workspace package whose `tsc` output is missing resolves to its sources: a
path into it naming a file missing under the `outDir` of the `tsconfig.json`
beside its `package.json` (`extends` followed) lands on the same place under
its `rootDir` (`./dist/foo.js` on `./src/foo.ts`). This applies to any path
resolution reaches, including the field `--mainFields` or `--metro` picks, a
`browser` map's target, and each platform file Metro tries first
(`./dist/index.ios.js` lands on `./src/index.ios.ts` before `./dist/index.js`
on `./src/index.ts`):

```json
{
  "exports": {
    ".": { "types": "./src/index.ts", "import": "./dist/index.js", "default": "./dist/index.js" },
    "./foo": { "types": "./src/foo.ts", "import": "./dist/foo.js", "default": "./dist/foo.js" }
  }
}
```

```json
{ "compilerOptions": { "outDir": "./dist", "rootDir": "./src" } }
```

Without `rootDir`, the root is the `tsconfig.json`'s directory, as in
TypeScript 6 (set it for an older tsc).

It is implied when every entry is TypeScript and each of their relative
`./x.js` imports is on disk only as the TS source; `.ts` files importing
`./x.ts` keep Node's resolution. Otherwise an import that would resolve under
it fails, naming the file and `--typescript`
([`stasis github-bundle`](github-bundle.md) builds with it instead).

It applies tsconfig `compilerOptions.paths` (`"@/*": ["./src/*"]`, against
`baseUrl`, `extends` followed) to bare specifiers nothing else resolves, an
extensionless target completing as in tsc (`.ts`, `.tsx`, `.js`, `.jsx`, then
`index`). The tsconfig is `--tsconfig`'s, else the `tsconfig.json`, if any,
beside the importing file's `package.json`: in a monorepo (a
`pnpm-workspace.yaml` or `package.json` `workspaces` at or above the cwd) the
nearest named `package.json` at or above the file, else the nearest named one
at or above the cwd. Never for a file in `node_modules`, and no lookup walks
through one.

Combines with `--jsx`, `--flow`, `--conditions`, `--mainFields` and `--metro`,
not with `--metro-resolver`.

```sh
stasis bundle --typescript src/index.ts
stasis bundle --typescript --tsconfig=tsconfig.build.json src/index.ts
```

## JSX and Flow

`--jsx` parses JSX in `.js`/`.cjs`/`.mjs` files; `.jsx`/`.tsx` files need no
flag, and JSX in TS must be in a `.tsx` file. The source is stored verbatim,
for `stasis build --loader=.js:jsx` (see [build](build.md#jsx-in-jsts)).

`--flow` strips Flow types from `.js`/`.cjs`/`.mjs`/`.jsx` files for the scan;
the original bytes are stored.

- A file with `@flow` anywhere in it is stripped even where oxc parses it, and
  syntax both Flow and JS can read is Flow's (`require<T>('./x')` is a call).
- Any other file is stripped only where oxc can't parse it, and such syntax is
  JS's (`a < b > (c)` compares).

It uses stasis's own `flow-remove-types`, never the project's, and removes
types only: Flow syntax that compiles to code (`component` and `hook`
declarations, `enum`s, `match`) doesn't parse, except in React Native's own
files, which are lowered first. It combines with `--jsx`, `--conditions` and
`--mainFields`.

A file the scanner can't parse fails the bundle (`JS bundle would be broken at
load time`), however it is reached, even by an import inside a function.

## Defines (`--define`)

`--define=KEY=VALUE` gives a global its value in the build; the scan leaves out
imports only in code that value keeps from running:

```sh
stasis bundle --define=__DEV__=false --define=process.env.NODE_ENV='"production"' index.js
```

So `if (__DEV__) require('./devtools')` reaches nothing, and a package
picking its build by `process.env.NODE_ENV === 'production'`, as React does,
only its production build.

- KEY is an identifier or a dotted path of them, matched as written (not
  `process.env['NODE_ENV']` or `process.env?.NODE_ENV`). VALUE is JSON: a
  string, quoted (`'"production"'` in a shell), a number, `true`, `false` or
  `null`.
- Left out is the side of an `if`/`else` or `?:`, or the right of `&&` or `||`,
  that a test folded to a constant keeps from running. A test folds if built of
  the defined names, literals, `!`, `void 0`, `===`, `!==`, `==`, `!=`, and
  `typeof` compared with a string other than `'object'` or `'symbol'`; any
  other (`debug && __DEV__`, a call, `??`) keeps both sides. A static `import`
  is always followed.
- The define doesn't apply in a file that binds the name itself
  (`const __DEV__`, a parameter, an import, `const process`) or writes to it
  (`process.env.NODE_ENV = ...`, `process.env = {}`). A TypeScript
  `declare const` binds nothing.

`--metro` defines `__DEV__` as `false` and `process.env.NODE_ENV` as
`"production"`, as Metro's release build inlines them. A define for either, by
flag or config, replaces its default, the other keeping its own; neither can be
left undefined. The scan folds only tests Metro also folds, so the bundle
carries every file Metro's graph holds. A name a Babel plugin of the project
inlines (`babel-plugin-transform-define`, Expo's `process.env.EXPO_OS`) can be
defined too; defining one the build doesn't inline leaves out files Metro still
bundles.

The config's top-level `define` (a `K=V` string or an array of them) gives
every JS entry, named in `entries` or not, the same defines. No entry may then
set its own (the config is refused), nor may `--define` be given:

```json
{ "define": ["__DEV__=false", "process.env.NODE_ENV=\"production\""], "entries": { "index.js": { "metro": true, "platforms": ["ios"] }, "cli.js": {} } }
```

A bundle built with defines holds only what those values run: where they
don't hold (a dev build against a release bundle, `stasis run --bundle=load`
under another `NODE_ENV`), importing a file it left out fails.

## Stylesheets (CSS)

A `.css` file is code, of format `css`, needing no `--resources` entry; its
imports are followed as webpack's css-loader follows them. It may also be an
entry of a JS bundle (`stasis bundle src/styles.css`).

```css
@import "tailwindcss";               /* the package's `style` export: its index.css */
@import "./theme.css" layer(theme);
.logo { background: url(./logo.svg); }
.button { composes: base from "./base.module.css"; }
```

- Its imports, read from CSS tokens: each `@import`, each `url()` and each
  string of an `image-set()` in a declaration, and a CSS module's
  `composes: … from` and `@value … from`. A `url()` in an at-rule's prelude
  (`@supports`, `@namespace`) is not one.
- An `@import`, `composes` or `@value` resolves relative to the stylesheet
  first, then as a package: by the `style` condition of its `exports`, else its
  `css`, `style` or `main` field, `.css` tried after the name; `~pkg/x.css` is
  the package's only. A `url()` resolves as written, relative first, then by a
  package's `asset` condition.
- A URL's query and fragment are dropped (`font.woff2?v=1#iefix`) and its path
  URL-decoded, reserved characters too (`hash%23mark.svg` names
  `hash#mark.svg`). Not imports:
  `data:` and other schemes, `//cdn…`, `#id`, and a path from the site's root
  (`/grid.svg`, from Next's `public`: name it in
  [`extra`](file-formats.md#stasisconfigjson)).
- A miss, or an image or font `--resources` doesn't carry, fails the build
  where the stylesheet is linked eagerly (see [Resolution](#resolution)), and
  is a warning past an `import()`.
- A stylesheet that isn't UTF-8 fails as one that doesn't parse.
- A preprocessor's stylesheet (`.scss`, `.less`) isn't code: a resource where
  `--resources` names it, its imports not followed. Nor are a PostCSS plugin's
  at-rules (Tailwind's `@config`, `@plugin`, `@source`, `@reference`): name the
  files they read in [`extra`](file-formats.md#stasisconfigjson).
- `stasis build` builds them with esbuild's `css` loader (see
  [build](build.md#scope-and-language)).

A lockfile or bundle an older stasis wrote may record a stylesheet as a
`resource`; a `frozen` run or build is held to that format, so write it anew.

## Resources and manifests

A reached file that isn't code (an imported `.png`, `.svg` or font; a
stylesheet [is code](#stylesheets-css)) fails the build unless `--resources`
names its bare extension or extensionless filename (`png,svg,LICENSE`); it is
then carried as a resource with its import edges (see
[build](build.md#non-code-assets---resources) and
[file formats](file-formats.md#resources-in-the-bundle)). With `--mainFields`
or `--metro`, the list defaults to the cwd's `stasis.config.json` `resources`,
which `--resources` replaces.

`--package-json` also bundles each bundled module's `package.json`, and a
nearer one inside a bundled file's package (an `esm/package.json`'s
`{"type":"module"}`), reached or not, for `stasis run --bundle=load` and
`stasis prune` to read. `"packageJSON": true` in
[`stasis.config.json`](file-formats.md#stasisconfigjson) sets it for every JS
build.

## Other languages

`stasis bundle` also builds bundles from `.sol`, `.php`, `.sh`/`.bash`, `.rs`
and `.teal` entries (see
[file formats](file-formats.md#source-language-bundles-solidity--php--bash--rust--teal)),
one language per invocation, except JS with Solidity. JS and Solidity entries,
given together (`stasis bundle src/index.js src/Token.sol`) or by
[entries](#entry-options-stasisconfigjson), are built apart and merged, their
paths relative to the same root (the JS project's, at the cwd); a directory
entry is Solidity's. A single-language flag (`--conditions`, `--mapping`) is
refused: set it per entry. `--lockfile` is refused; `--deptree` lays out both
trees where [`lockfiles`](github-bundle.md#several-lockfiles-lockfiles) names
them.

```sh
stasis bundle [--deptree] [--mapping=path/to/remappings(.txt|.toml)] [--manifests] [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/(file.sol|dir) ...
stasis bundle [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.php ...
stasis bundle [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.(sh|bash) ...
stasis bundle [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.teal ...
stasis bundle [--cargo] [--cargo-features=a,b,pkg/c] [--cargo-no-default-features] [--cargo-all-features] [--cargo-target=(triple|host)] [--cargo-manifests] [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.rs ...
```

A Solidity directory entry stands for every `.sol` file under it
(`stasis bundle src test script` covers what `forge build` compiles,
`stasis bundle contracts` what Hardhat does). Imports resolve through the
remappings `forge build` uses, else a root `remappings.txt`, then
`node_modules` by file path; they must reach a `.sol` file inside the project,
and a dependency's only other dependencies' files.

| Flag | Meaning |
| - | - |
| `--mapping=path` | Solidity: take exactly the remappings that one file lists instead. |
| `--manifests` | Solidity: also carry `foundry.toml`, `remappings.txt`, `foundry.lock`, `soldeer.lock`, `.gitmodules` and `package.json` of the project and its bundled dependencies, as written, including any RPC/Etherscan keys and URL credentials in them. |
| `--cargo` | Rust: take the feature and dependency resolution from `cargo metadata`. It runs cargo, so only on a project you trust. |
| `--cargo-features=a,b,pkg/c`, `--cargo-no-default-features`, `--cargo-all-features` | Rust: cargo's `--features`, `--no-default-features` and `--all-features` for the entries' packages. |
| `--cargo-target=(triple\|host)` | Rust: ask rustc for the target's cfgs, so `#[cfg(unix)]`-style code for other targets stays out too; otherwise it is all kept. |
| `--cargo-manifests` | Rust: also bundle each bundled package's `Cargo.toml` and build script (a vendored crate's `.cargo-checksum.json` too), the workspace `Cargo.toml`, `Cargo.lock` and cargo configs, as written, including any tokens and URL credentials in them. |

A Rust bundle resolves Cargo features as `cargo build` of the entries'
packages would, leaving out `#[cfg(feature = ...)]` code that is off; a
`Cargo.lock` older than version 3 stops the build.

## `stasis add`

```sh
stasis add [--lockfile-only] path/to/(file|dir) ...
```

`stasis add` adds the listed files to the project's bundle(s) as they are,
with no dependency resolution. The bundles and resource allowlist come from
`stasis.config.json`, which is required (`bundleFile`, `resourcesBundleFile`,
`resources`, `brotliQuality`, all optional). What it adds, and what the
bundles and lockfile already carry, are held to its
[allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules).

A `stasis.lock.json` there is added to as the bundles are (`add`): a file it
records must be the one added. With none, none is written. `--lockfile-only`
writes only the lockfile: the existing one, added to, else one attesting the
bundles as the add leaves them. What they record of a dependency's
[`integrity` and `patch`](file-formats.md#stasiscodebr) is checked against how
it is installed and against each other, a split bundle's untouched half
included. `stasis-core add` is the same without reading the package manager's
install record.

A directory expands to every file under it, minus:

- dotfiles, and everything under a dot-directory (`.env`, `.git/`, ...), not
  counted as skipped;
- files under an `example`/`examples`, `__tests__`, `__mocks__`, `jest` or
  Apple prebuilt slice (`ios-arm64`, ...) directory below the named root
  (`stasis add src/examples` takes its files);
- type declarations (`.d.ts`, `.d.mts`, `.d.cts`), `*.env` files, stasis's own
  artifacts (`stasis.lock.json`, `*.stasis.lock.json`, `*stasis*.br`) and the
  bundles this run writes to;
- what a native walk leaves out: `*.md`, `*.log`, `*.map`, `*.flow` and
  `*.swiftdoc` files (and `*.bat` off Windows), `LICENSE`/`LICENCE`/
  `THIRD-PARTY-LICENSES`, `yarn.lock`, and tool configs such as `.prettierrc`,
  `.flowconfig`, `.editorconfig`, `circle.yml` and `gradle-wrapper.properties`.

Skipped files are counted in the summary. A file named directly is always
taken; a non-code one needs its extension or extensionless filename
(`LICENSE`) in `resources`.

```sh
stasis add a.js icon.svg     # these two files
stasis add src assets        # every file under them, minus the set above
stasis add src src/README.md # the README too, named
```

To add files on every `stasis run` and `stasis bundle`, list them in
[`extra`](file-formats.md#stasisconfigjson), with globs and `!` exclusions:
`"extra": ["a.js", "b/", "c/*.png", "!b/tmp"]`.
