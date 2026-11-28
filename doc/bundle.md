# `stasis bundle`

`stasis bundle` builds a `stasis.code.br` bundle statically, from the entries'
import graph, without executing anything. It is the static counterpart of
`stasis run --bundle=add`, for code that can't or shouldn't be run to capture
it (a React Native app, a library's entry points).

```sh
stasis bundle [--deptree] [--scope=(node_modules|full)] [--conditions=cond1,cond2] [--mainFields=field1,field2] [--jsx] [--flow] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--define=K=V ...] [--package-json] [--lockfile=path/to/stasis.lock.json] [--lockfile-only] [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx|css) ...
stasis bundle [--deptree] --metro [--metro-resolver] [--babel|--babel-aliases=path/to/aliases.json] --platforms=ios,android [--platforms=web] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--define=K=V ...] [--package-json] [--lockfile=path/to/stasis.lock.json] [--lockfile-only] [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx|css) ...
stasis bundle [--deptree] [--babel] [--metro-resolver] [--flow] [--cargo] [--cargo-target=(triple|host)] [--lockfile=path/to/stasis.lock.json] [--lockfile-only] [--add] [--format=(br|tgz)] [--output=(path|-)] [entry ...]   # the entries' options from stasis.config.json
```

This page covers JS/TS bundles and the stylesheets they import (see
[Stylesheets](#stylesheets-css)). For Solidity, PHP, Bash, Rust and TEAL
bundles, see [Other languages](#other-languages).

Files to bundle that the graph never reaches go in `stasis.config.json`'s
[`extra`](file-formats.md#stasisconfigjson), for every language; the bundle and
its `--lockfile` carry them.

`allowedPaths`, `disallowedPaths`, `allowedModules` and `disallowedModules`
restrict what the bundle may carry: every offender is named and nothing is
written. See
[Allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules).

`excludeModules` names dependencies the build treats as absent: importing one
misses as for a package that isn't installed. See
[Excluded modules](file-formats.md#excluded-modules).

| Flag | Meaning |
| - | - |
| `--output` / `-o` | Where to write. Default: `stasis.code.br` in the project root, or in the cwd with `--mainFields`/`--metro`, see [Output](#output). `-` streams to stdout. |
| `--add` | Merge the fresh build into the bundle already at `--output` instead of replacing it. Not with `--output=-`. |
| `--format=(br\|tgz)` | Write a `stasis.code.br` (`br`) or a [`.stasis.tgz`](file-formats.md#stasistgz) (`tgz`, default name `stasis.tgz`). Default: from the `--output` name, `tgz` for `stasis.tgz` or `<name>.stasis.tgz`, else `br`. Refused if it disagrees with the `--output` name, with `--brotli-quality` for a tgz, or with `--lockfile-only`. |
| `--deptree` | Lay out the dependencies in memory from the lockfile, with nothing installed: see [Dependencies from the lockfile](#dependencies-from-the-lockfile---deptree). JS and Solidity. |
| `--lockfile=path` | Also write a `stasis.lock.json` attesting every bundled file. If one is already there, the build is checked against it and, under the default `frozen`, it is left unchanged. See [Companion lockfile](#companion-lockfile---lockfile). |
| `--lockfile-only` | Write only the lockfile: at `--lockfile`'s path, else the one the build is checked against (the project's `stasis.lock.json`). If it exists, under the default `frozen`, nothing is written. Not with `--output`, `--add` or `--brotli-quality`. See [Companion lockfile](#companion-lockfile---lockfile). |
| `--scope` | `full` (default) or `node_modules`, as for `stasis run`. `--mainFields`/`--metro` always emit full scope and refuse any other, whether given here or set by the cwd's [`stasis.config.json`](file-formats.md#stasisconfigjson) (which `--scope=full` overrides). |
| `--conditions=a,b` | Extra `exports`/`imports` resolution conditions, on top of Node's (with `--mainFields`, on top of a bundler's). See [Conditions](#conditions). |
| `--mainFields=a,b` | Legacy package entry fields to honor, in order (e.g. `react-native,browser,main`), incl. the `browser` field's object redirection. |
| `--metro --platforms=ios,android` | Resolve as Metro does and build as its release build does: `--jsx`, `--flow` and Metro's release defines. See [Metro](#metro---metro). |
| `--metro-resolver` | With `--metro`: resolve through the project's own `metro-resolver` instead of the built-in approximation. |
| `--babel` | With `--metro`: resolve through the import aliases of the project's `babel.config.*` (`babel-plugin-module-resolver`). See [Metro](#metro---metro). |
| `--babel-aliases=path.json` | With `--metro`: resolve through import aliases listed in a JSON file of the project, without running anything. See [Metro](#metro---metro). |
| `--jsx` | Parse JSX in `.js`/`.cjs`/`.mjs` files. `.jsx`/`.tsx` files need no flag. On under `--metro`. See [JSX and Flow](#jsx-and-flow). |
| `--flow` | Strip Flow types from `.js`/`.cjs`/`.mjs`/`.jsx` files: those marked `@flow`, and any other oxc can't parse. On under `--metro`. See [JSX and Flow](#jsx-and-flow). |
| `--typescript` | Resolve TypeScript sources the way tsc does. See [TypeScript](#typescript---typescript). |
| `--tsconfig=path` | With `--typescript`: the tsconfig whose `compilerOptions.paths` aliases apply. |
| `--resources=png,svg` | Carry reached non-code files as resources instead of failing on them. With `--mainFields`/`--metro`, defaults to the cwd's `stasis.config.json` `resources`. See [Resources and manifests](#resources-and-manifests). |
| `--define=K=V` | A global's value in the build (`__DEV__=false`): imports only in branches it rules out are left out. Repeatable. Under `--metro`, `__DEV__` and `process.env.NODE_ENV` default to Metro's release values. `stasis.config.json`'s `define` sets it for every entry instead. See [Defines](#defines---define). |
| `--package-json` | Also bundle each bundled module's `package.json`, and the nearest one above each bundled file (an `esm/package.json`), even ones the scan never reached. |
| `--brotli-quality=0..11` | Compression level, default `6`. |

## Output

By default a JS bundle is written to `stasis.code.br` in the directory its
paths are relative to. Resolving as Node does (the default, also with
`--conditions` or `--typescript`), that is the project root at or above the
cwd (for a workspace package, the workspace root), where `stasis run
--bundle=load` looks for it. With `--mainFields` or `--metro`, paths are
relative to the cwd, so the bundle goes there: run it from the package's
directory. `--output` names another path (relative to the cwd); `--output=-`
streams the bundle to stdout and the summary to stderr.

An `--output` named `stasis.tgz` or `<name>.stasis.tgz`, or `--format=tgz`
(written to `stasis.tgz` where the `stasis.code.br` would go, without
`--output`), writes a [`.stasis.tgz`](file-formats.md#stasistgz) instead: the
lockfile of the bundle's files plus the files, which every command that reads
a bundle accepts as that bundle. It records no `reason`, so `stasis audit
--reason` and `--why` have none to read. `--add` merges into one as into a
`stasis.code.br`.

`--add` merges the fresh build into the bundle already at `--output`; a file
both carry with different content is a conflict and fails. With nothing on
disk yet it is a plain write.

```sh
stasis bundle src/index.js            # writes stasis.code.br in the project root
stasis bundle --add src/worker.js     # merges the worker's graph into it
```

The bundle on disk and the `--lockfile` must be rooted where the fresh build
is: `--add` refuses one whose paths are relative to another directory, naming
both roots. This happens after a build wrote its `stasis.lock.json` or
`stasis.code.br` in a package nested below its root, as that file roots the
next build at the package (see [discovery](file-formats.md#discovery)).
Rebuild without `--add`.

`stasis bundle` warns when it writes a `stasis.lock.json` or `stasis.code.br`
in a package nested below its root, naming the path at the root to write it at
instead: later runs and builds in the package would be rooted at the package,
while the file's paths are relative to the build's root, so a
`stasis run --lock=frozen` there finds none of its files.

## Companion lockfile (`--lockfile`)

`--lockfile=stasis.lock.json` also writes a lockfile attesting every bundled
file: the same import graph with integrities instead of content. With
`--conditions` it attests the conditions-selected graph, so a plain
`stasis run --lock=frozen` fails closed: pair it with `--bundle=load`, or
replay the conditions. Under `--add`, an existing lockfile at that path is
merged like the bundle; with none there it is refused, as it wouldn't attest
the existing bundle's files (write `--lockfile` from the first build, or drop
it).

With or without `--lockfile`, a JS build is checked against the
`stasis.lock.json` at the `--lockfile` path, else the project's (as a run finds
it: `EXODUS_STASIS_LOCK_FILE`, else the one at the root). The mode is the one
the project's runs take (`EXODUS_STASIS_LOCK`, or `frozen` where its
`stasis.config.json` pins it, see [modes](run.md#modes)); with neither, it is
`frozen` if the lockfile exists, and `add` if it doesn't or under `--add`:

| Mode | Behavior |
| - | - |
| `add` | What it builds must agree with each file and module the lockfile records; `--lockfile` writes the one built, attesting the bundle beside it (with `--add`, merged with the one there). |
| `frozen` | As `add`, but the lockfile must exist and attest every file built, and the bundle must load with it under `stasis run --lock=frozen --bundle=load`. It is left unchanged: `--lockfile` and `--lockfile-only` write nothing. |
| `replace` | The existing lockfile is not read; `--lockfile` is required and writes the one built (with `--add`, of the merged bundle). |
| `ignore` | The lockfile there is neither read nor written; `--lockfile` and `--lockfile-only` are refused. |
| `none` | There must be no lockfile there; `--lockfile` and `--lockfile-only` are refused. |

A build checked against a lockfile says so on stderr, before its summary:
`[stasis] Held 6591 files in 346 packages from src to stasis.lock.json`. To
overwrite the lockfile, set `EXODUS_STASIS_LOCK=replace` (or `add`, to keep
what it records). Under `--add`, the existing bundle is checked against it too.

What the lockfile, or the bundle `--add` adds to, records of a dependency's
`integrity` and `patch` is checked against how that package was installed (see
[`integrity`](file-formats.md#stasiscodebr)).

`--lockfile-only` writes only the lockfile, byte for byte the one `--lockfile`
writes beside the bundle: at `--lockfile`'s path, else the one the build is
checked against. If that exists, under the default `frozen`, it only checks the
build against it. The bundle is still built and checked, so the lockfile is
refused wherever the bundle would be; only compressing and writing the bundle
is skipped. The bundle's default path is still never taken into
[`extra`](file-formats.md#stasisconfigjson). `--output`, `--add` and
`--brotli-quality` are refused with it.

```sh
stasis bundle --lockfile-only src/index.js   # writes stasis.lock.json, or checks the build against an existing one
```

## Dependencies from the lockfile (`--deptree`)

`--deptree` builds the bundle from the project on disk with nothing installed:
the dependencies are laid out in memory from the lockfile that installs the
cwd, as [`stasis github-bundle`](github-bundle.md#dependencies) lays them out
(pnpm, yarn 1 or npm's `node_modules` for a JS bundle, Soldeer's dependencies
folder for a Solidity one). In a checkout, the result is the bundle a fresh
install and a plain `stasis bundle` give, except that each dependency's `repo`
records the commit it was published from. Without `--deptree`,
`stasis bundle` reads only the installed dependencies, and fetches and caches
nothing.

```sh
git clone https://github.com/owner/name && cd name
stasis bundle --deptree --lockfile=stasis.lock.json src/index.js
```

- The lockfile is the one of `pnpm-lock.yaml`, `yarn.lock`,
  `package-lock.json` and `soldeer.lock` that installs the cwd. With none, or
  more than one, it refuses, as it does for a lockfile of the other kind of
  bundle (a `soldeer.lock` for JS entries). Where the cwd's
  `stasis.config.json` names `lockfiles`, none is detected: a tree is laid out
  of each (see [Several lockfiles](github-bundle.md#several-lockfiles-lockfiles)).
- Nothing may be installed: wherever a tree installs (each of the lockfile's
  projects' `node_modules`, or Soldeer's `dependencies` folder) the project
  must hold nothing, not even a link, or it refuses. Every refusal comes before
  anything is fetched.
- Nothing is written in the project but the bundle (and `--lockfile`). Fetched
  npm tarballs and version documents, Soldeer zips and GitHub trees are cached
  where `stasis github-bundle` caches them: the user cache directory, or
  `STASIS_CACHE_DIR` if set (see [audit](audit.md#repository-advisories)), so a
  second build doesn't fetch them again.
- The tree is never [lazy](github-bundle.md#lazy---no-lazy): every package is
  fetched before the build, and every tarball and zip is checked against the
  lockfile. An npm tarball is read from npm's cache or stasis's own if there,
  else fetched from the registry, as is each Soldeer zip; a Soldeer git
  dependency on GitHub is fetched with `GITHUB_TOKEN` if set.
- A private (scoped) npm package is fetched with the first of
  `PREVENTIVE_MEASURES_NPM_TOKEN`, `STASIS_NPM_TOKEN` and `NPM_TOKEN` that is
  set. With none set, it falls back to the token `~/.npmrc` gives npm's own
  registry on a line that is exactly `//registry.npmjs.org/:_authToken=npm_…`
  (the last such line). Another registry's token, or one written any other way
  (`${NPM_TOKEN}`, quoted, with spaces), is not read; an `~/.npmrc` that isn't
  valid UTF-8 is refused.
- The project's `stasis.config.json` `entries` and `extra` apply as without the
  flag. Its `lockfiles` set the trees laid out, `installDevDependencies: false`
  lays them out without devDependencies (see
  [devDependencies](github-bundle.md#devdependencies-installdevdependencies)),
  and a [`.yarnclean`](github-bundle.md#yarnclean) cleans them, as in
  `github-bundle`. No entry's options can set `deptree`.
- `--babel` and `--metro-resolver` are refused, as they run the project's code
  from disk, where nothing is installed. `--babel-aliases` takes the same aliases without running
  anything.

## Entry options (`stasis.config.json`)

The `entries` of the cwd's [`stasis.config.json`](file-formats.md#stasisconfigjson)
give entries their options: each key is an entry path relative to that
directory (or a [glob pattern](#entry-patterns)), and its value the flags to
build it with, named without the `--`.

```json
{
  "entries": {
    "index.js": { "metro": true, "metro-resolver": true, "platforms": ["ios", "android"] },
    "node_modules/@react-native-community/cli/build/bin.js": { "metro": false }
  }
}
```

An entry's options may also restrict what its build carries, in addition to
the config's own restrictions (see below):

```json
{
  "disallowedModules": ["request"],
  "entries": {
    "src/worker.js": { "allowedPaths": ["src/worker", "node_modules"], "allowedModules": ["@exodus/bytes"] },
    "src/index.js": { "disallowedPaths": ["src/worker"] }
  }
}
```

`stasis build` reads an entry's `jsx`, `flow`, `define` and `metro`/`platforms`
from the config a bundle carries (see [build](build.md#entry-options-stasisconfigjson)).

A boolean flag takes `true` or `false` (the default, same as leaving it out);
a flag taking a value takes a string as on the command line; one taking a list
(`platforms`, `conditions`, `mainFields`, `resources`, `cargo-features`) also
takes an array of strings. `define` takes one `K=V` string or an array of them
(`["__DEV__=false", "process.env.NODE_ENV=\"production\""]`). The config's
top-level `define` gives every JS entry its defines instead: see
[Defines](#defines---define). `output`, `lockfile`, `lockfile-only`,
`brotli-quality`, `add` and `deptree` can only be flags.

With it:

- `stasis bundle` with no entries bundles every entry it names.
- An entry it names is built with its options there; no flag may be given with
  it but those six and the consent flags below.
- `babel`, `metro-resolver`, `cargo` and `cargo-target` run a program (the
  project's Babel config, its `metro-resolver`, `cargo` and what its
  `.cargo/config.toml` names, `rustc`), so set there they take effect only
  when their flag is given too, as consent (`cargo-target` with the same
  value, `--cargo-target=host`): the config alone can't make `stasis bundle`
  run anything. An entry setting one fails without its flag, and the flag
  fails where no entry given sets it. It applies only to the entries setting
  it, so entries setting different `cargo-target`s are bundled apart.
  `babel-aliases` and `flow` run nothing of the project's and need no consent.
- The entries given must be all named there or none. If none is, they are
  built with the flags exactly as without the config.
- Entries with different options, or of different languages (JS and `.sol`),
  are built apart and their bundles merged into one as `--add` merges (a file
  both carry with different content fails); their paths must be relative to
  the same root. So one bundle may hold a Metro build's files, attributed to
  the `bundle:metro` consumer, and a Node build's, attributed to `bundle`.
- The config's `extra` is added once to the merged bundle, by the config's own
  `resources` (an entry's `resources` applies to its graph only).
- An entry may set `allowedPaths`, `disallowedPaths`, `allowedModules` and
  `disallowedModules` (not flags), as the config does at its top level (see
  [Allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules)).
  They apply to its own build's graph, without the config's `extra`, in
  addition to the config's, neither overriding the other. Entries with the
  same options and rules are built together, and an error names them all. An
  entry's `excludeModules` likewise applies to its own build, in addition to
  the config's (see [Excluded modules](file-formats.md#excluded-modules)).

`stasis run` ignores `entries`. `stasis github-bundle` reads them but runs
nothing: see its [Entries](github-bundle.md#entries).

```sh
stasis bundle --metro-resolver   # bundles index.js with --metro and bin.js without
stasis bundle --metro-resolver --output=app.br index.js
```

An entry that is a `next.config.*` stands for its Next.js app's files, each
built with the entry's options: see [Next.js apps](#nextjs-apps-nextconfig).

### Entry patterns

A key may be a glob pattern, standing for every path it matches, each an entry
built with its options:

```json
{ "entries": { "apps/*/src/index.js": { "metro": true, "platforms": ["ios", "android"] } } }
```

Node's `fs.globSync` expands it from the config's directory, as it expands
[`extra`](file-formats.md#stasisconfigjson)'s: `*` is any run of a name's
characters, `?` one character, `**` any number of directories (none matching
a dotfile), `{a,b}` either, `[ab]` a class, `!(a)` any name but `a`. A key with
none of these is a path.

- A pattern matches nothing in a `node_modules` directory: name an entry there
  by its path. So it matches the same files whether or not the dependencies are
  installed, as with `--deptree` and
  [`stasis github-bundle`](github-bundle.md#entries).
- A pattern matching nothing stands for itself, so it is reported as a missing
  entry. A file whose name holds one of those characters (`app/[id].tsx`) can
  be named by its path, unless that path matches another file as a pattern
  (`app/i.tsx`).
- Two keys naming the same file (a pattern and a path, or two patterns) are
  refused, whatever options they set. To give a file its own options, leave it
  out of the pattern (`apps/!(web)/src/index.js` beside
  `apps/web/src/index.js`).
- A pattern with a `.` or `..` segment other than a leading `./`, in a brace
  list too (`{apps/a,lib}/../index.js`), is refused, as
  [`stasis build`](build.md#entry-options-stasisconfigjson) can't match an
  entry's path against it. A path's `..` is resolved as usual.
- An entry given on the command line counts as named by the config if a
  pattern there matches it.

## Next.js apps (`next.config.*`)

A Next.js app has no single entry: `next build` takes its files by name, from
its `app` and `pages` directories and beside them. An entry that is its
`next.config.js`, `.mjs`, `.ts` or `.mts` also stands for those files, found as
Next 16 finds them, each built as an entry of the bundle with its options:

```sh
stasis bundle --typescript --resources=svg,woff2 apps/web/next.config.ts
```

- `app` and `pages` are each looked for in the config's directory, else in its
  `src/`. The two in different directories are refused, as in Next; with
  neither, the config is an entry alone.
- From `app`: at any depth, each `page`, `route`, `layout`, `template`,
  `default`, `loading`, `error`, `not-found`, `forbidden` and `unauthorized`
  file, and the code of each metadata route (`sitemap`, `icon`, `apple-icon`,
  `opengraph-image`, `twitter-image`, and a numbered variant of the last four:
  `icon1`), whether or not a page below uses it; and, directly in `app` only,
  `robots`, `manifest`, `global-error` and `global-not-found`. A private folder
  (`_components`) is left out with everything under it. A static metadata file
  (`favicon.ico`, `robots.txt`) isn't code: name it in
  [`extra`](file-formats.md#stasisconfigjson), as the `public` directory.
- From `pages`: every file but a `.d.ts`, including `_app`, `_document` and
  `api/`.
- Beside the directory holding them, `proxy` (`middleware` before Next 16) and
  `instrumentation`; and `instrumentation-client` in `src/`, else in the
  config's directory.
- Each by an extension of the config's `pageExtensions` (default `tsx`, `ts`,
  `jsx`, `js`; `page.page.tsx` and `index.page.tsx` with
  `pageExtensions: ['page.tsx']`). The config is read, not run: a list of
  strings given to `pageExtensions`, as a property or by assignment, is taken;
  any other value (a variable, a spread, a call) is refused, as is an entry
  that isn't a JS/TS file (`page.mdx`). Name the app's entries yourself then.
- A link is followed; one leading nowhere is skipped.
- A file also named directly is one entry. A pattern among `entries`
  (`apps/*/next.config.ts`, see [Entry patterns](#entry-patterns)) stands for
  each config it matches, and so for each app's files. `stasis build` finds an
  entry's options by the key that is its path or a pattern matching it (see
  [build](build.md#entry-options-stasisconfigjson)), so it builds an app's
  files, which no key names, with the flags given.

The import graph is resolved by the build's options, not as Next's compiler
does: not through its aliases (an `app`'s React is Next's own copy), nor under
the `react-server` condition of its server components. Stylesheets are
followed as code (see [Stylesheets](#stylesheets-css)); images and fonts need
[`--resources`](#resources-and-manifests); `@/` resolves through
`tsconfig.json` `paths` with [`--typescript`](#typescript---typescript); and
Next's build-time `process.env.NODE_ENV` and `process.env.NEXT_RUNTIME`
(`"nodejs"` on the server) can be given with [`--define`](#defines---define).

In a workspace (Turborepo's, say), the bundle's root is the workspace's (see
[Output](#output)), and the `stasis.config.json` naming the entry belongs
there too: one in the app's directory roots the build there, below the
`node_modules` its dependencies are installed in.

```json
{ "entries": { "apps/web/next.config.ts": { "typescript": true, "resources": ["svg", "woff2"] } } }
```

## Resolution

By default imports resolve as Node resolves them: `exports`/`imports` with
Node's conditions, `main`, extension and index probing.

- `--conditions=react-native,browser` merges extra conditions onto Node's
  defaults. It doesn't honor legacy `mainFields` or platform suffixes.
- `--mainFields=react-native,browser,main` honors legacy package entry fields
  in that order, including the `browser` field's object form (file redirection
  and `false` stubs). Always a full-scope bundle.

An import that doesn't resolve fails the build if the entries load it eagerly,
through static `import` and `export … from` chains. Behind a `require()` or
`import()` it is only a warning, and it falls through at load. An import that
resolves to a file outside the project root is treated the same way, and that
file is never carried (e.g. a lazy `require('typescript')` for an optional
peer dependency hoisted above the root, left out with a warning naming it).
Where only one of a file's `require()` and `import()` leaves the root, the
other's edge is kept and the one left out misses at load, as under
[Conditions](#conditions). An import that resolves within the root for one
`--platforms` target and outside it for another fails the build.

### Conditions

The conditions each mode asserts for `exports` and `imports` maps (`default`
always matches):

| Mode | Conditions |
| - | - |
| Node (default) | `node`, `import` or `require`, `module-sync`, `node-addons`, then `--conditions` |
| `--mainFields` | `import` or `require`, `module`, then `--conditions` |
| `--metro`, `--metro --metro-resolver` | `import` or `require`, `react-native`, and `browser` on `web` |

Resolving as Node, `import` or `require` follows the edge (`import`,
`export ... from` and `import()` assert `import`; `require()` asserts
`require`), and the set is Node's own, so `stasis run --bundle=load` lands on
the file Node would. An `exports` map listing `node` first takes that branch
whatever `--conditions` adds. A specifier a file resolves one way and fails the
other (say, an `exports` map with only a `require` branch, for a file that
both `require()`s and `import()`s it) is kept under the resolving one's
conditions, and misses in the other under `--bundle=load` too: a bare or `#`
specifier is never served the other's target (see [`imports`](file-formats.md)).

`--mainFields` and `--metro` resolve as a bundler does: `import` or `require`
follows the importing file's format, and `node`, `node-addons` and
`module-sync` are never asserted. A package whose `exports` lists `node` first
(`uuid` 9: `node`, `browser`, `default`) resolves to its `browser` target
under `--mainFields=browser,module,main --conditions=browser`, as in esbuild
(platform `browser`) and webpack 5 (target `web`), and under `--metro` to the
first of its `react-native`, `default` and, on `web`, `browser` targets. Under
`--metro-resolver` the project's `metro-resolver` is given `react-native` and
adds the rest itself.

`--mainFields` also asserts `module`, as esbuild and webpack 5 do on every
platform, for an `import` and a `require()` alike: a package listing its ESM
build under `module` (`xstate`, `@emotion/react`, `@reduxjs/toolkit`) resolves
to it. Node and Metro never assert it. webpack also asserts `webpack` and
`production` or `development`: add them with `--conditions` where a package's
map tells them apart.

### Node builtins

Resolving as Node, a builtin (`fs`, `buffer`, `node:fs`) is left to the
runtime and not bundled. Under `--mainFields` and `--metro`, a bare builtin
name (`buffer`, `events`, `util`, `process`) is the installed npm package of
that name, as in esbuild, webpack 5 and Metro, though a
`browser`/`react-native` map entry for the name (`{"fs": false}`,
`{"crypto": "crypto-browserify"}`) wins. A `node:` specifier, or a name no
installed package resolves (`fs` with nothing installed), stays a builtin:
recorded but not bundled, where Metro and webpack would fail the build.

### Native addons

A `require()` whose argument isn't a string literal can't be followed: it is a
warning, and falls through at load. But where it names a native addon by a
partly spelled path, the files it can name are followed:

```js
const target = `${process.platform}-${process.arch}`
module.exports = require(`./native/lib_${target}_nodejs.node`)
```

Resolving as Node, every file there the path can spell is bundled, for every
platform at once (`native/lib_linux-x64_nodejs.node`,
`native/lib_darwin-arm64_nodejs.node`, …), each with an edge of the specifier
that spells it (`./native/lib_linux-x64_nodejs.node`). They are carried as
[resources](#resources-and-manifests) without a `--resources` entry, and
attested by the `--lockfile` like any file.

- The path is a template literal, or strings joined by `+`, that starts with
  `./` or `../` and ends in `.node`, with one expression or more in it.
- An expression stands for any run of characters within one file or directory
  name, never a `/`: `` `./prebuilds/${platform}-${arch}/addon.node` `` names
  the `addon.node` of each matching directory of `prebuilds`, none deeper.
- Where it spells no file, it stays a warning. So does any other path: one
  that starts with an expression (`` `${__dirname}/native/…` ``) or names a
  package (`` `@scope/lib-${target}` ``), one that doesn't end in `.node`, and
  an `import()`: only a `require()` is followed.
- Under `--mainFields` and `--metro` none is followed, except in the configs
  and toolchain a `--metro` bundle traces as Node code.

A `.node` file named by a string literal (`require('./addon.node')`) is a
non-code file, carried with `node` in `--resources` (see
[Resources and manifests](#resources-and-manifests)), or when a partly spelled
path also names it.

`stasis run --bundle=load` resolves the addon by the bundle's edge, but Node
loads it from disk, so it must be there; the run checks it against the bytes
the bundle carries, or the hash the lockfile records, before it runs (see
[run](run.md#native-addons)). [`stasis extract`](extract.md) writes them out
with the rest.

### Metro (`--metro`)

`--metro --platforms=ios,android` resolves as Metro does: React Native's
[conditions](#conditions) and `mainFields`, and the `.ios`/`.android`/`.native`
file suffixes, each platform resolved separately and all recorded in one
bundle. `--platforms` is repeatable and/or comma-separated (`--platforms=web`
too). It doesn't combine with `--conditions` or `--mainFields`.

Its files are attributed to the `bundle:metro` consumer in the bundle's
`reason` map (other `stasis bundle` builds use `bundle`), so
`stasis audit --reason=bundle:metro` keeps to what the Metro build carries.
What only the project's configs reach (below) is attributed to `bundle`; a
file both reach, to both.

The code it carries is `generic-javascript` (`.js`, `.jsx`) or
`generic-typescript` (`.ts`, `.tsx`), as the Metro plugin records it, not
`module` or `commonjs`. A file whose name gives its format keeps it, whatever
it holds or its package declares: `.json` is `json`, `.mjs` `module`, `.cjs`
`commonjs` (and `.mts`, `.cts`). A file Metro builds that Node also loads (a
config requiring it) is recorded in the format Node loads it in. Assets keep
their `resource` formats and native build inputs theirs.
`stasis run --bundle=load` refuses to run such a bundle's code under Node.

Metro's assets are the extensions in its `assetExts`: its defaults (`png`,
`jpg`, `svg`, `ttf` and the like) plus each string the project's
`metro.config.js` lists under `assetExts`
(`assetExts: [...defaultConfig.resolver.assetExts, 'riv']`,
`config.resolver.assetExts.push('riv')`), read from its source, never run. One
the config filters out (`assetExts.filter((ext) => ext !== 'svg')`) is still
an asset.

Where the project has an `rn.config.json` (the config of
[`@preventive/rn`](https://github.com/PreventiveMeasures/libraries/tree/main/rn)'s
`rn-bundle`), Metro's resolver lists are read as `rn-bundle` reads them:

- `assetExts`: Metro's defaults plus those `rn.config.json` adds, where it has
  `assetExts` (`["riv"]`), no Metro config read; Metro's defaults alone where
  it has `"metroConfig": false`; else those the Metro config adds, as above,
  from the file its `metroConfig` names (`"config/metro.js"`), else
  `metro.config.js`.
- `sourceExts` and `assetResolutions`: Metro's defaults and what
  `rn.config.json` adds, after them (`["mjs"]`, `[0.75]`). Of the `sourceExts`,
  only those of code a bundle carries count (`mjs`, `cjs`, `mts`, `cts`).

An `rn.config.json` that `rn-bundle` refuses fails the bundle: not JSON, not an
object, an option stasis reads (these and the restrictions below, at the top
level or in `development` or `production`) of the wrong type, or an extension
added to one of `assetExts` and `sourceExts` that the other has.

Its restrictions apply to the app's Metro build as to `rn-bundle`'s:
`allowedPaths` and `disallowedPaths`, globs of file paths from the project root
(`"src"`, which covers a directory's files; `"src/**/*.js"`), and
`allowedModules` and `disallowedModules`, globs of the names of the packages
files belong to (`"react-native"`, `"@react-native/*"`). An installed package
is matched by both the name its `package.json` has and the one it is installed
under (an npm alias): forbidden if either is, allowed only if both are. A
project file is matched by the project's name. The restrictions of
`production` apply too, each list a rule of its own beside the top level's;
those of `development` don't. Each rule is checked separately against each
file of the app's Metro graph on every platform, by its real path: what the
entries reach, what Metro and Babel add, and each file of an asset. The
configs and toolchain carried beside it, the native build inputs and a
transform's input (a `.po` a Babel plugin inlines) aren't checked. A violation
fails the bundle, naming each file and the rule it breaks:

```
stasis bundle: the --metro build takes what rn.config.json forbids:
  node_modules/nice/index.js is of evil, which matches "evil" of rn.config.json's disallowedModules
```

Without `--metro`, none applies.

A resource the app imports that isn't one of Metro's assets is consumed by a
Babel plugin before Metro collects dependencies, as `@exodus/i18n`'s
`plugin-inline-po` inlines a `require('./messages.po')`. It is carried as the
transform's input: attributed to `bundle:metro`, with no edge from its importer
and no asset registry, as the Metro plugin records it (below). It still needs
`--resources`.

An import or re-export listing only types (`import { type A } from`, Flow's
`import { typeof B } from`, `export { type C } from`) is no edge under
`--metro`, as Babel erases it and the Metro plugin records none; other builds
record it, as Node keeps it as `import {} from`. With `--babel`, a TypeScript
file's is an edge where the project's Babel config runs the TypeScript
transform with `onlyRemoveTypeImports` (React Native's preset doesn't; Flow's
transform has no such option). One with no specifiers (`import {} from`, with
or without a comment in it) is an edge either way. `import type` and
`export type` statements are never an edge.

Where Metro's resolution differs from Node's and esbuild's, it follows
`metro-resolver` 0.87.2 with the context Metro gives it
([`@preventive/rn`](https://github.com/PreventiveMeasures/libraries/tree/main/rn)'s
resolver):

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
- `exports` and `imports` maps read as Metro reads them. A map with any target
  not starting `./` (a package name, a `../` path) is refused whole, as is an
  `imports` map with a key not starting `#`; an `exports` target with an empty,
  `.`, `..` or `node_modules` segment is refused on its own. A fallback array
  takes its first entry in `exports` and serves nothing in `imports`, a number
  or boolean anywhere in a map refuses it too, a `null` key shadows the
  patterns that would match it, and a target names its file exactly, with no
  extension or `index` probing. Where a map serves nothing, resolution falls
  back to the files: for a `#` specifier, the importer's
  `browser`/`react-native` map, then `node_modules`. A `#` specifier from a
  package with no `imports` resolves nowhere.
- A directory in `node_modules` that resolves to nothing gives way to the next
  `node_modules` up, but a package whose `main` resolves to nothing fails,
  without falling back to its root `index`.
- A map entry sending a relative path to a package name is taken as a path in
  the package, and so resolves nowhere; one sending a specifier to an absolute
  path fails it.
- A path ending in `/` names a directory: its `main` or `index`, never a file
  of that name. Platform suffixes are tried with an extension only
  (`where.ios.js`, never `where.ios`).
- A type declaration (`.d.ts`) is no module: a package whose entry field names
  one (`"main": "dist/index.d.ts"`) resolves by its stem, to the `dist/index.js`
  beside it.
- An asset (an extension in Metro's `assetExts`, as above) resolves to itself
  or one of its scale variants (`@1x` to `@4x`), the lowest path among those
  that exist, so `./logo.png` reaches `logo@3x.png` where only that exists, as
  does an `exports` or `imports` target naming one (`"./logo": "./logo.png"`).
  A path naming a scale variant itself (`./logo@2x.png`) resolves nowhere.
  `--metro-resolver` resolves assets the same way. Carrying one needs
  `--resources` (e.g. `--resources=png`). An asset's other files are carried
  with it, with no edge to them: in its directory, each of its name and type at
  any scale (`logo.png`, `logo@2x.png`, `logo@3x.png`), those for the platform
  (`logo.ios.png`, `logo@3x.ios.png`) where it has any, else the generic ones;
  each by the name Metro reads it by (one linked in, with its target's bytes;
  one linked from outside the project passed over).

It also carries the native build inputs of the packages the app links:

- every `node_modules` package the code graph reaches that ships native code
  (an `ios/` or `android/` directory, or a podspec);
- every package that ships native code and is listed in the app's
  `package.json` `dependencies`, `peerDependencies` or `devDependencies`,
  imported or not: the packages `react-native config` links, found as it finds
  them, in the nearest `node_modules` holding them. A `react-native.config.js`
  isn't read: a package it disables is carried anyway, and one it adds from
  elsewhere isn't. A package found above the project root is passed over;
- `react-native` itself.

Each one's whole tree is walked (a podspec may compile a `cpp/` beside
`ios/`), carrying every file except the JS and TypeScript Metro's graph owns,
docs, secrets, build output (`build`, `.gradle`, `.cxx`, `Pods`,
`DerivedData`, nested `node_modules`) and prebuilt binaries.

It also carries a package's codegen specs, which Metro's graph needn't reach:
each `.js`, `.jsx`, `.ts` and `.tsx` module (not a `.d.ts`) named `Native…` or
`…NativeComponent` under each directory its `package.json` names in
`codegenConfig` (`jsSrcsDir`, or each of `codegenConfig.libraries`', as React
Native names its own `src`), except in a dot, `node_modules` or `__tests__`
directory. They are `generic-javascript` or `generic-typescript`. Other JS
there isn't carried as a spec.

This includes a workspace package linked, under any name, into a
`node_modules` its importer resolves packages from, carried where it lies
(`packages/<name>/...`) however the import reaches it; one linked nowhere there
is the project's own source. A package reached only for an asset (through
`--resources`) contributes nothing unless the app's `package.json` lists it.

It also bundles the project's Metro and React Native configs, though the app
doesn't import them: the `metro.config.js` and `react-native.config.js` in the
cwd, and the `rn.config.json` there with the Metro config its `metroConfig`
names; with `--babel` or `--babel-aliases`, the `babel.config.js` there as
well. And it bundles what else the build runs in Node:

- React Native's CLI (`react-native/cli.js`), and the script it runs as each
  command starts (`@react-native-community/cli/setup_env.sh`, which the Metro
  plugin carries for every build, under `run`): resolved as a `require()` from
  the project resolves it, carried as a `shell` script with its executable bit
  kept, never traced;
- the `react-native.config.js` of each package `react-native config` reads;
- Metro itself, as React Native's CLI plugin finds it
  (`@react-native/community-cli-plugin`, else as the project does);
- Metro's worker (`metro/src/DeltaBundler/Worker.js`), the child process
  `jest-worker` forks it in, and `metro-file-map`'s Haste worker;
- the transformers stasis's Metro plugin points Metro at, where a config
  requires it (`withStasis()`);
- Metro's transform worker (`metro-transform-worker`, metro-config's default
  `transformerPath`) and its minifier (`metro-minify-terser`, the default
  `minifierPath`): whatever the worker's `require()` of it from its own
  directory finds, a stub a pnpm override puts in its place included, whether
  or not the build minifies;
- with `--babel` or `--babel-aliases`, the Babel transformer React Native's
  Metro config names (`@react-native/metro-babel-transformer`, its
  `babelTransformerPath`, resolved from `@react-native/metro-config`), which
  runs `@babel/core` and React Native's Babel preset with its plugins; and the
  plugins and presets the Babel config names (below).

The Babel config's plugins and presets are read from the source of the modules
`babel.config.js` reaches, never run:

- each string (or the first of a `[name, options]` pair) in a list of plugins
  or presets, in the project's own modules and a Babel config's, under the name
  Babel requires (`module-resolver` as `babel-plugin-module-resolver`,
  `module:@react-native/babel-preset` as `@react-native/babel-preset`). A list
  is an array under a `plugins` or `presets` key at any depth, a variable or
  property so named or assigned (`exports.presets = [...]`), or one pushed onto
  either (`plugins.push(x)`, `unshift`, or `concat` of an array, inline or held
  in a variable), spread in or held in a variable, or made of another
  (`base.concat(more)`, `[a, isProd && b].filter(Boolean)`, `flat`, `slice`);
- in such a list too, a path the module computes from its own directory and
  strings (`path.resolve(__dirname, 'node_modules/@org/x/plugin')`,
  `path.join(__dirname, ...)`), or what `require.resolve('x')` resolves to
  from the module, as Node resolves it. A path computed for anything else (a
  module-resolver `alias` or `root`) names no plugin;
- in any module `babel.config.js` reaches, a plugin's own included, what it
  names by `require.resolve('x')` (a plugin running Babel with plugins of its
  own, as react-native-reanimated's does:
  `require.resolve('@babel/plugin-transform-template-literals')`), resolved as
  Node resolves it (with the `paths` it gives), with Node's edge and
  conditions; one resolving nowhere (an optional package it probes) names
  nothing;
- in a Babel config's module, known by its name (`babel` and `config` in its
  file's name, as `babel.config.js` and `create-babel-config.js`, or in its
  package's, as `@org/babel-config`), any string shaped like a plugin or
  preset, wherever it is: `module:` names, `babel-plugin-` and `babel-preset-`
  packages, `@babel/plugin-` and `@babel/preset-` ones, paths through a
  `babel/plugin` or `babel-plugin` directory
  (`path.resolve(__dirname, 'node_modules/@org/x-babel/babel/plugin-inline.js')`),
  in an array kept in a variable (`['babel-plugin-transform-remove-console']`)
  or spread into `plugins`.

Each is resolved as `@babel/core` resolves it, from the project, else from the
module naming it (a path, from either), and what it reaches is read in turn: a
shared config found by its name can name more. A project's own
`transformerPath` or `babelTransformerPath` isn't read, nor is a name a config
computes rather than writes.

Each of these is bundled as a Node entry (parsed, not run): with everything it
imports, resolved as Node resolves it (`@react-native/metro-config` and what it
requires, say), each file in the
format Node loads it in (`commonjs` or `module` by its package's `type` or
syntax, `json`), even one the app also imports. Their edges are keyed under
Node's conditions, never under `*`: `require, node, node-addons, module-sync`
for a `require()`, `node, import, module-sync, node-addons` for an `import`. In
a file the app's build also reaches, they sit apart from Metro's `*` edges. An
import there that Node misses but Metro resolves is refused. A package only
they reach isn't a native dependency of the app, and its native build inputs
aren't carried.

A disabled import (a `browser`/`react-native` map entry set to `false`)
resolves to Metro's own empty module, the project's
`node_modules/metro-runtime/src/modules/empty-module.js`, carried in
`metro-runtime`'s package, where that file is in fact empty (only a
`"use strict"` directive). Otherwise it resolves, as with `--mainFields`, to a
synthetic empty `.stasis/empty-module.js`.

`--metro-resolver` resolves through the project's own installed
`metro-resolver` (it ships with `react-native`/`metro`) instead of the built-in
one, for exact fidelity to that project's Metro. It doesn't combine with
`--typescript`.

`--babel` resolves the import aliases the project's Babel config sets: a
`babel-plugin-module-resolver` that maps `#local` to `./src` makes
`import '#local/abc'` reach `src/abc.js`. The project's
`babel.config.(js|cjs|mjs|json)` is loaded for each file as Metro's transformer
loads it, with Metro's `caller` and each `--platforms` target, so a config that
aliases per platform resolves per platform. This runs the config, and needs
`@babel/core` installed in the project. Only the aliases apply: each file's own
source is scanned and carried, and an edge stays keyed by the specifier as
written (`#local/abc`). Every instance of the plugin the config lists counts,
by name or as a `require`d or imported value, the first to map a path winning;
one a preset brings in does not. Not with `github-bundle`.

The Metro plugin (`withStasis()`) keys its edges the same way: it records each
import as written, before any Babel plugin rewrites it. An import only Babel or
Metro adds (a `@babel/runtime` helper, `react/jsx-runtime`, Metro's
`asyncRequire`, an asset's registry) gets no edge, as in the static build, but
the file is still carried, like every module of Metro's graph. An import a
Babel plugin consumes (the `.po` above) gets no edge either, but a resource it
names by path from the importer is carried under `metro` (by its real path,
none outside the project root). Under `--bundle=load` the Babel plugin reads it
from disk, so the Metro plugin refuses one the bundle doesn't carry or whose
bytes on disk differ from the bundle's, unless `--fs` serves it from the bundle
(by the path the plugin reads it by, not a symlink to the file the bundle
carries). An asset module's other files (its other scales, as above) are carried the same way,
under `metro`, with no edge. Under `--bundle=load` Metro reads every file of an
asset from disk, the module's own too, so the Metro plugin checks each against
the bundle's bytes, unless `--fs=async` serves it (and the directory listing
Metro finds them in, so a scale added on disk since the capture isn't part of
the asset).

The static build carries those files too, as Metro's code, each scanned for its
own imports:

- under `--babel` or `--babel-aliases`, Babel's helpers: every
  `@babel/runtime/helpers/*.js` of each `@babel/runtime` a bundled file finds;
- also under either, Metro's module system (`metro-runtime`), and the
  polyfills React Native's Metro config prepends: the files
  `@react-native/js-polyfills`' `index.js` lists, which is read but never run;
- with an `import()` in a bundled file, Metro's `asyncRequire`
  (`metro-runtime/src/modules/asyncRequire.js`), resolved as a `require()` from
  the project resolves it, else from Metro's package (where an install that
  nests it, or a pnpm one, links it); one outside the project root is passed
  over;
- for JSX (`--jsx`, or a `.jsx` or `.tsx` file), the JSX runtime Babel
  imports, `react/jsx-runtime`;
- for an asset (a file `--resources` carries, `require('./logo.png')`), the
  asset registry Metro's module for it requires:
  `react-native/Libraries/Image/AssetRegistry`, the `assetRegistryPath` of
  React Native's Metro config, resolved from the asset's directory, with no
  Babel alias. A project's own `assetRegistryPath` isn't read.

`--babel-aliases=aliases.json` takes the same aliases from a JSON file of the
project instead, running nothing (the project's Babel config is still carried,
as above). The file is the object `babel-plugin-module-resolver` takes as its
`alias` option, mapping each alias to a string, the shape a `babel.config.js`
can `require` (`alias: require('./aliases.json')`).

```json
{ "#local": "./src", "^@lib/(.+)": "./lib/\\1", "lodash": "lodash-es" }
```

They map as in the plugin: a key starting with `^` or ending with `$` is a
regular expression whose groups `\1`, `\2`... its value can use; any other key
matches the specifier it is, or one starting with it and `/`, keeping the rest
(`#local/abc` to `./src/abc`). The first key to match wins. A value starting
with `./` or `../` is a path from the cwd; any other is the specifier it maps
to, a package's name. The file must lie in the project, and is not carried.
The aliases are the same for every `--platforms` target. Not with `--babel`.

Under either, a `package.json` `imports` specifier (`#local/abc`) keeps Metro's
exact rule: its target must name the file itself. An alias of the same name, in
the aliases file or the Babel config, rewrites it first.

It builds as Metro's release build (`react-native bundle --dev false`) does:

- `--jsx` and `--flow` are on. See [JSX and Flow](#jsx-and-flow).
- `__DEV__` is defined as `false` and `process.env.NODE_ENV` as
  `"production"`, so what only a dev build imports (`if (__DEV__) require(...)`)
  is left out. A `--define`, or an entry's `define`, for either name gives it
  that value instead, the other keeping its default: see
  [Defines](#defines---define).

```sh
stasis bundle --metro --platforms=ios,android --resources=png,svg,ttf index.js
```

### TypeScript (`--typescript`)

`--typescript` resolves TS sources that import by output name the way tsc
does: a `./x.js` (or `.jsx`/`.mjs`/`.cjs`) specifier with no such file on disk
lands on its on-disk `./x.ts` or `./x.tsx` (`.mts`/`.cts`) source, and an
extensionless `./x` probes `./x.ts`, `./x.tsx` and `./x/index.ts(x)`. The same
substitution applies to package `main`/`exports`/`imports` targets and bare
subpaths. An existing `.js` always wins over its `.ts` twin.

None of this applies from or into `node_modules`, by real path: an installed
package is used as published, while workspace packages linked into
`node_modules` resolve like the project's own files.

A workspace package that names its `tsc` output, which a checkout lacks,
resolves to its sources: where a path into it names a file missing under the
`outDir` of the `tsconfig.json` beside its `package.json` (`extends` followed),
the file at the same place under its `rootDir` stands in, substituted as above
(`./dist/foo.js` lands on `./src/foo.ts`). This applies to any path resolution
reaches: its `main`, an `exports` or `imports` target, a bare subpath, a
relative import, and with `--mainFields` or `--metro` the field the resolver
picks (`react-native`, `browser`) or a `browser` map's target, each platform
file Metro tries first included (`./dist/index.ios.js` lands on
`./src/index.ios.ts` before `./dist/index.js` on `./src/index.ts`):

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
TypeScript 6; with an older tsc, set `rootDir`. An output on disk is used as
is.

It is implied without the flag when every entry is TypeScript and each of
their relative imports of JS outputs (`./x.js`) is on disk only as the TS
source (`./x.ts`); a project of Node-compatible `.ts` files importing `./x.ts`
keeps Node's resolution. Otherwise an import that fails but would resolve
under it names the file and `--typescript` in the error
([`stasis github-bundle`](github-bundle.md) builds with it instead).

It honors tsconfig `compilerOptions.paths` aliases (e.g. `"@/*": ["./src/*"]`,
resolved against `baseUrl`, `extends` followed) for bare specifiers nothing
else resolves, an extensionless target completing as in tsc (`.ts`, `.tsx`,
then `.js`, `.jsx`, then the directory's `index`). `--tsconfig=path` names the
config; without it, the `tsconfig.json` beside the importing file's
`package.json` applies if present: in a monorepo (a `pnpm-workspace.yaml` or
`package.json` `workspaces` at or above the cwd) the nearest named
`package.json` at or above the file, else the project's (the nearest named
`package.json` at or above the cwd). Never for a file in `node_modules`, and no
lookup walks through one.

Combines with `--jsx`, `--flow`, `--conditions`, `--mainFields` and `--metro`,
not with `--metro-resolver`.

```sh
stasis bundle --typescript src/index.ts
stasis bundle --typescript --tsconfig=tsconfig.build.json src/index.ts
```

## JSX and Flow

`--jsx` parses JSX in `.js`/`.cjs`/`.mjs` files (the React Native convention).
It is off by default and on under `--metro`; `.jsx`/`.tsx` files are parsed as
JSX with no flag, and JSX in TS must be in a `.tsx` file. The JSX source is
stored verbatim, for `stasis build --loader=.js:jsx` to transform later: see
[build](build.md#jsx-in-jsts).

`--flow` strips Flow type syntax from `.js`/`.cjs`/`.mjs`/`.jsx` files so the
import graph resolves; the stored source stays the original bytes. `.ts`/`.tsx`
files are never stripped.

- A file with `@flow` anywhere in it is Flow: it is stripped whether or not oxc
  parses it as is, and syntax both Flow and JS can read is Flow's
  (`require<T>('./x')` is a call).
- Any other file is stripped only where oxc can't parse it (Flow types without
  the pragma, as in `react-native-prompt-android`'s `index.ios.js`), and syntax
  both can read is JS's (`a < b > (c)` compares).

It strips with stasis's own `flow-remove-types`, never the project's, and
combines with `--jsx`, `--conditions` and `--mainFields`; `--metro` turns it
on. It removes types only: a file using Flow syntax that compiles to code
(`component` and `hook` declarations, `enum`s, `match`) doesn't parse, unless
it is React Native's own, which is lowered first.

A file the scanner can't parse fails the bundle (`JS bundle would be broken at
load time`), however it is reached, even by an import inside a function.

## Defines (`--define`)

`--define=KEY=VALUE` gives a global the value the build gives it, and the scan
leaves out imports only in code that value keeps from running:

```sh
stasis bundle --define=__DEV__=false --define=process.env.NODE_ENV='"production"' index.js
```

With those, `if (__DEV__) require('./devtools')` reaches nothing, and a package
picking its build by `process.env.NODE_ENV === 'production'`, as React does,
reaches only its production build.

- KEY is an identifier or a dotted path of them, matched as written:
  `process.env.NODE_ENV`, not `process.env['NODE_ENV']` or
  `process.env?.NODE_ENV`. VALUE is JSON, as for esbuild's `--define`: a
  string, quoted (`'"production"'` in a shell), a number, `true`, `false` or
  `null`. Repeat the flag for each.
- What is left out is the side of an `if`/`else` or `?:`, or the right of `&&`
  or `||`, that a test folded to a constant keeps from running. A test folds
  if it is built of the defined names, literals, `!`, `void 0`, `===`, `!==`,
  `==` and `!=`, and `typeof` compared with a string (other than `'object'` or
  `'symbol'`). A test it can't fold (`debug && __DEV__`, one making a call, or
  `??`) keeps both sides. A static `import` is never in a branch, and is always
  followed.
- In a file that binds a defined name itself (`const __DEV__ = ...`, a
  parameter, an import, `const process = ...`) or writes to it
  (`process.env.NODE_ENV = ...`, `process.env = {}`), the define doesn't
  apply. A TypeScript `declare const __DEV__: boolean` binds nothing.

`--metro` defines `__DEV__` as `false` and `process.env.NODE_ENV` as
`"production"` by default, as Metro's release build (`dev: false`) inlines them
before it collects a file's dependencies, so its bundle carries what a release
build reaches. A define for either name replaces its default
(`--define=__DEV__=true`), the other keeping its own. Neither can be left
undefined under `--metro`, so a `--metro` bundle never holds a dev build's
whole graph. The scan folds only tests Metro also folds (not `??`, nor a
`typeof` compared with anything but a string), so the bundle carries every
file Metro's graph holds; what a test Metro folds but the scan doesn't imports
is carried anyway. A name a Babel plugin of the project inlines
(`babel-plugin-transform-define`, Expo's `process.env.EXPO_OS`) can be defined
the same way; defining one the build doesn't inline leaves out files Metro
still bundles.

`stasis.config.json`'s top-level `define` gives every JS entry the same
defines, whether or not `entries` names it (there may be no `entries` at all):

```json
{ "define": ["__DEV__=false", "process.env.NODE_ENV=\"production\""], "entries": { "index.js": { "metro": true, "platforms": ["ios"] }, "cli.js": {} } }
```

- It takes a `K=V` string or an array of them.
- No entry may set its own `define` beside it, whatever it gives: the config
  is refused.
- `--define` can't be given beside it either. `stasis github-bundle` accepts a
  `--define` that is the same, and refuses another.
- A `.sol`, `.php`, `.sh`, `.rs` or `.teal` entry ignores it.
- Under `--metro`, a name it gives replaces Metro's default.

A bundle built with defines holds only what those values run. Where they
don't hold (a dev build against a bundle built for release, or
`stasis run --bundle=load` under another `NODE_ENV`), importing a file it left
out fails.

## Stylesheets (CSS)

A `.css` file is code, of format `css`: one an entry imports is carried
without a `--resources` entry (`css` there changes nothing), and its own
imports are followed as webpack's css-loader (which Next.js uses) follows
them. A `.css` file may also be an entry of a JS bundle
(`stasis bundle src/styles.css`).

```css
@import "tailwindcss";               /* the package's `style` export: its index.css */
@import "./theme.css" layer(theme);
.logo { background: url(./logo.svg); }
.button { composes: base from "./base.module.css"; }
```

- Its imports are read from CSS tokens, so comments, strings and escapes hide
  or spell one as for the loader: each `@import`, each `url()` and the strings
  of an `image-set()` in a declaration, and a CSS module's `composes: … from`
  and `@value … from`. A `url()` in an at-rule's prelude
  (`@supports (background: url(x.png))`, `@namespace`) is not an import.
- An `@import`, `composes` or `@value` resolves as css-loader's import resolver
  does: relative to the stylesheet first (`x.css` is `./x.css`), then as a
  package (`@import "tailwindcss"`), by the `style` condition of its
  `exports`, else its `css`, `style` or `main` field, `.css` tried after the
  name; `~pkg/x.css` is the package's only. A `url()` resolves the file as
  written, relative first, then a package's by the `asset` condition.
- A URL's query and fragment are not part of the file (`font.woff2?v=1#iefix`),
  and its path is URL-decoded, reserved characters too (`hash%23mark.svg` names
  `hash#mark.svg`). A URL naming no file isn't an import: `data:`, any other
  scheme (`https:`), `//cdn…`, `#id`, and a path from the site's root
  (`/grid.svg`), which Next serves from `public`: name that in
  [`extra`](file-formats.md#stasisconfigjson).
- Its edges are static: a miss, or an image or font no `--resources` entry
  carries, fails the build where the stylesheet is linked eagerly (see
  [Resolution](#resolution)); reached past an `import()`, it is a warning.
- A stylesheet that isn't UTF-8 text fails as a file that doesn't parse.
- Only CSS is followed: a preprocessor's stylesheet (`.scss`, `.less`) is not
  code, carried as a resource where `--resources` names it, its imports not
  followed. Nor are a PostCSS plugin's own at-rules (Tailwind's `@config`,
  `@plugin`, `@source` and `@reference`): name the files they read in
  [`extra`](file-formats.md#stasisconfigjson).
- `stasis build` builds a stylesheet an entry imports with esbuild's `css`
  loader, and what its `url()`s name with the build's `--loader`s, keeping each
  URL's query and fragment (see [build](build.md#scope-and-language)).

An older stasis carried a stylesheet as a `resource`, where `--resources` named
`css`: a lockfile or bundle it wrote records that format, which a `frozen` run
or build is held to, so it has to be written anew.

## Resources and manifests

A reached file that is not code (an imported `.png`, `.svg` or font; a
stylesheet is code, see [Stylesheets](#stylesheets-css)) fails the build by
default. `--resources=png,svg,ttf` carries the allowlisted ones (by bare
extension, or extensionless filename such as `LICENSE`) as resources, with
their import edges recorded: see [build](build.md#non-code-assets---resources)
and [file formats](file-formats.md#resources-in-the-bundle). With `--mainFields`
or `--metro`, the allowlist defaults to the `resources` of the cwd's
`stasis.config.json`; `--resources` replaces it rather than adding to it.
Native addons a `require()` names by a partly spelled path need no entry
there: see [Native addons](#native-addons).

`--package-json` bundles each bundled module's `package.json`, even one the
scan never reached, so `stasis run --bundle=load` and `stasis prune` can read
every dependency's manifest. A nearer `package.json` inside a bundled file's
package, such as the `{"type":"module"}` marker of an `esm/package.json`, is
bundled too. `"packageJSON": true` in
[`stasis.config.json`](file-formats.md#stasisconfigjson) does the same without
the flag, for every JS build.

## Other languages

`stasis bundle` also builds Solidity, PHP, Bash, Rust and TEAL bundles, from
`.sol`, `.php`, `.sh`/`.bash`, `.rs` and `.teal` entries. One invocation takes
entries of one language, except that JS and Solidity may be given together.
How each is resolved and what the bundle carries is in
[file formats](file-formats.md#source-language-bundles-solidity--php--bash--rust--teal).

JS and Solidity entries given together (`stasis bundle src/index.js src/Token.sol`,
or named in `stasis.config.json`'s [entries](#entry-options-stasisconfigjson))
are built apart and their bundles merged into one, whose paths must be relative
to the same root (the JS project's, at the cwd). A directory entry beside them
is Solidity's. A flag applies to both, so one for a single language
(`--conditions`, `--mapping`) is refused: set their options apart in
`stasis.config.json`'s entries. `--lockfile` is refused; `--deptree` lays out
both trees where `stasis.config.json`'s
[`lockfiles`](github-bundle.md#several-lockfiles-lockfiles) names them.

```sh
stasis bundle [--deptree] [--mapping=path/to/remappings(.txt|.toml)] [--manifests] [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/(file.sol|dir) ...
stasis bundle [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.php ...
stasis bundle [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.(sh|bash) ...
stasis bundle [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.teal ...
stasis bundle [--cargo] [--cargo-features=a,b,pkg/c] [--cargo-no-default-features] [--cargo-all-features] [--cargo-target=(triple|host)] [--cargo-manifests] [--add] [--format=(br|tgz)] [--output=(path|-)] path/to/file.rs ...
```

A Solidity directory entry stands for every `.sol` file under it (a missing or
empty one is skipped): `stasis bundle src test script` covers what
`forge build` compiles, `stasis bundle contracts` what Hardhat does. Imports
resolve through the remappings `forge build` uses (`remappings.txt`,
`foundry.toml`'s profile, `FOUNDRY_PROFILE`, `lib/` auto-detection,
dependencies' own configs included), else a root `remappings.txt`, then
`node_modules` by file path; an import must reach a `.sol` file inside the
project, and a dependency's only other dependencies' files.

| Flag | Meaning |
| - | - |
| `--mapping=path` | Solidity: take exactly the remappings that one file lists instead. |
| `--manifests` | Solidity: also carry `foundry.toml`, `remappings.txt`, `foundry.lock`, `soldeer.lock`, `.gitmodules` and `package.json` of the project and its bundled dependencies, as written, including any RPC/Etherscan keys and URL credentials in them. |
| `--cargo` | Rust: take the feature and dependency resolution from `cargo metadata`. It runs cargo, so only on a project you trust. |
| `--cargo-features=a,b,pkg/c`, `--cargo-no-default-features`, `--cargo-all-features` | Rust: cargo's `--features`, `--no-default-features` and `--all-features` for the entries' packages. |
| `--cargo-target=(triple\|host)` | Rust: ask rustc for the target's cfgs, so `#[cfg(unix)]`-style code for other targets stays out too; otherwise it is all kept. |
| `--cargo-manifests` | Rust: also bundle each bundled package's `Cargo.toml` and build script (a vendored crate's `.cargo-checksum.json` too), the workspace `Cargo.toml`, `Cargo.lock` and cargo configs, as written, including any tokens and URL credentials in them. |

A Rust bundle resolves each crate's Cargo features from `Cargo.toml` and
`Cargo.lock` as `cargo build` of the entries' packages would, so
`#[cfg(feature = ...)]` code that is off stays out: by cargo's own resolver
where there is a `Cargo.lock` (version 3 or 4; an older one stops the build),
`--cargo-target` and every locked package in-tree, else by replaying the
manifests (which it says, with why).

## `stasis add`

```sh
stasis add [--lockfile-only] path/to/(file|dir) ...
```

`stasis add` adds the listed files to the project's bundle(s) as they are,
with no dependency resolution, for files the import graph never reaches. Its
only option is `--lockfile-only` (below). The bundle files and resource
allowlist come from `stasis.config.json` (`bundleFile`, `resourcesBundleFile`,
`resources`, `brotliQuality`, all optional; the file itself is required). What
it adds is held to its
[allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules),
as is what the bundles and lockfile it adds to already carry.

A `stasis.lock.json` there is added to like the bundles (`add`): a file it
records must be the one added, and it is written with the added files; if
there is none, none is written. `--lockfile-only` writes only the lockfile: the
existing one, added to, or if there is none, one attesting the bundles as the
add leaves them, including the files they already carry. What those record of
a dependency's [`integrity` and `patch`](file-formats.md#stasiscodebr) is
checked against how it is installed and against each other, including a split
bundle's half that no file is added to. The core CLI has it as
`stasis-core add`, which doesn't read the package manager's install record.

A directory expands to every file under it, minus what a sweep leaves out:

- dotfiles, and everything under a dot-directory (`.env`, `.git/`, ...),
  which aren't counted as skipped;
- files under an `example`/`examples`, `__tests__`, `__mocks__`, `jest` or
  Apple prebuilt slice (`ios-arm64`, ...) directory, below the named root only:
  `stasis add src/examples` sweeps the directory it was pointed at, `stasis add
  src` skips an `examples` it merely found;
- type declarations (`.d.ts`, `.d.mts`, `.d.cts`), `*.env` files, stasis's own
  artifacts (`stasis.lock.json`, `*.stasis.lock.json`, `*stasis*.br`) and the
  bundles this run writes to;
- what a native walk leaves out: `*.md`, `*.log`, `*.map`, `*.flow` and
  `*.swiftdoc` files (and `*.bat` off Windows), `LICENSE`/`LICENCE`/
  `THIRD-PARTY-LICENSES`, `yarn.lock`, and tool configs such as `.prettierrc`,
  `.flowconfig`, `.editorconfig`, `circle.yml` and `gradle-wrapper.properties`.

So `stasis add src` does not attest everything under `src`. The skipped files
are counted in the summary, the dotfiles aside. A file named directly is
always taken, whatever the sweep leaves out, and validated like any other: a
non-code file needs its extension, or its extensionless filename (`LICENSE`),
in the `resources` allowlist.

```sh
stasis add a.js icon.svg     # these two files
stasis add src assets        # every file under them, minus the set above
stasis add src src/README.md # the README too, named
```

To have `stasis run` and `stasis bundle` add the same files each time, list
them in `stasis.config.json`'s [`extra`](file-formats.md#stasisconfigjson),
which takes globs and `!` entries leaving some out:
`"extra": ["a.js", "b/", "c/*.png", "!b/tmp"]`.
