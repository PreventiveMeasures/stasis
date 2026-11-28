# Stasis File Formats

Stasis writes up to three files at the project root, next to `package.json`:

| File | Purpose | Encoding |
| --- | --- | --- |
| `stasis.config.json` | Tool configuration | JSON |
| `stasis.lock.json` | Per-file integrity lockfile | JSON |
| `stasis.code.br` | Bundled sources **and** resources | Brotli-compressed JSON |

Lockfiles and bundles each carry an integer `version`, versioned independently.
Paths are POSIX-style, relative to the directory holding the lockfile, and may
not start with `..` or hold a `\` (a file so named is refused when bundling,
writing an artifact or reading one).

## `stasis.config.json`

```json
{ "scope": "node_modules", "lock": "frozen", "debug": false }
```

| Key | Values | Default | Env var |
| --- | --- | --- | --- |
| `scope` | `"node_modules"`, `"full"` | `"full"` | `EXODUS_STASIS_SCOPE` |
| `lock` | `"frozen"` | the flag's or env var's, else `"add"` | `EXODUS_STASIS_LOCK` |
| `debug` | boolean | `false` | `EXODUS_STASIS_DEBUG` |
| `packageJSON` | boolean | `false` | `EXODUS_STASIS_PACKAGE_JSON` |
| `fs` | `"sync"`, `"async"` | unset | `EXODUS_STASIS_FS` |
| `brotliQuality` | integer `0`–`11` | `6` | `EXODUS_STASIS_BROTLI_QUALITY` |
| `extra` | array of paths and glob patterns | unset | none |
| `entries` | object of each entry's `stasis bundle` options, by its path or a glob pattern (see [Entry options](bundle.md#entry-options-stasisconfigjson)) | unset | none |
| `define` | `"K=V"` or an array of them: every JS entry's `--define`s; no entry may then set its own `define` (see [Defines](bundle.md#defines---define)) | unset | none |
| `installDevDependencies` | boolean | `true` | none |
| `lazyDependencies` | boolean | `true` | none |
| `generatePrisma` | boolean | `true` | none |
| `lockfiles` | array of lockfile paths (see [Several lockfiles](github-bundle.md#several-lockfiles-lockfiles)) | unset: the one detected | none |
| `allowedPaths` | array of paths and glob patterns | unset | none |
| `disallowedPaths` | array of paths and glob patterns | unset | none |
| `allowedModules` | array of package names and glob patterns | unset | none |
| `disallowedModules` | array of package names and glob patterns | unset | none |
| `excludeModules` | array of package names and glob patterns | unset | none |

The file may pin `lock` to `frozen` and set no other mode: a file setting
another `lock` mode, or any `bundle` mode, is refused (they come from
`--lock`/`--bundle` or `EXODUS_STASIS_LOCK`/`EXODUS_STASIS_BUNDLE`). With
`frozen` pinned, a run must be given `--lock=frozen`, and a JS `stasis bundle`
built through a State (without `--mainFields`/`--metro`) is refused.

`lock`/`bundle` modes:

| Mode | Behavior |
| --- | --- |
| `ignore` | Tolerate existing data without loading or writing it |
| `add` | Load existing data, refuse to modify it |
| `replace` | Ignore existing data, rebuild from scratch |
| `frozen` | Load read-only; require every observed file to match |
| `load` | Bundle only — *serve* recorded bytes instead of reading disk |

An unset `bundle` produces no bundle, and a stray one on disk is rejected.

Composition rules:
- At least one of `lock`/`bundle` must be set.
- `bundle = load` is incompatible with `lock = add | replace`.
- `bundle = frozen` composes with any `lock` mode and needs no lockfile.
- `fs` requires `bundle = add | replace | load`.

`brotliQuality` sets only a written bundle's compression: content and hashes
are the same at any quality, and read-only bundle modes ignore it.

`packageJSON` (`--package-json`) also bundles, and attests, each bundled
module's `package.json` and the nearest one above each bundled file (an
`esm/package.json`), even if the run or scan never reached it, only while
writing a bundle (`bundle = add | replace`). `stasis bundle` reads it from the
`stasis.config.json` at the bundle's root (the cwd's under
`--mainFields`/`--metro`) for every JS build; other languages ignore it.

`extra` names files the import graph never reaches, to attest anyway:

```json
{ "resources": ["png"], "extra": ["a.js", "b/", "c/*.png"] }
```

- Each entry is a path or glob pattern relative to the config's directory,
  which it may not climb out of. Patterns expand with Node's `fs.globSync`:
  `*` skips dotfiles, and a pattern matching nothing is reported as a missing
  file.
- Each resulting path is taken as [`stasis add`](bundle.md#stasis-add) takes
  an argument: a directory expands to the files under it, minus what a sweep
  leaves out.
- A file the command itself writes (its lockfile or bundle) is never taken,
  nor through a symlink or hard link to it.
- Every file must be a recognized source file or have its extension (or
  extensionless filename) in `resources`, except `.nvmrc`, `.ruby-version` and
  `.bundle/config`, which are resources regardless. All offenders are named in
  one error before anything is written.
- An entry starting with `!` excludes what it matches, however it was named,
  matched or swept, wherever it sits in the list; a matched directory is never
  walked, so a pattern whose every match is excluded matches nothing. An
  exclusion matching nothing is no error. It matches with Node's
  `path.matchesGlob` against the path from the config's directory (`./` and a
  trailing `/` ignored):

```json
{ "extra": ["ios", "ios/.xcode.env", "!ios/Pods", "!ios/build", "!**/xcuserdata"] }
```

A `stasis.config.json` that sets `extra` adds itself too (`"extra": []` adds it
alone), unless an exclusion matches it:

```json
{ "extra": ["scripts/", "!stasis.config.json"] }
```

| Command | Adds the `extra` files |
| --- | --- |
| `stasis run` | only when `lock` or `bundle` is `add` or `replace`. A file the run loaded keeps the run's record; any other is recorded as a `--fs` read is: a resource by its bytes, a JS-family file with no loader format. Under `lock = add`/`bundle = add`, one whose bytes changed since it was recorded is refused. Under `scope = node_modules`, the project's own files are left out. |
| `stasis bundle` | to the bundle and its `--lockfile`, checked against `--resources` instead of `resources` where given: for a JS bundle scanned through a State, from the `stasis.config.json` at its root and as `stasis run` records them; for any other (`--mainFields`/`--metro`, another language), from the cwd's and packed as `stasis add` does. Under `entries`, once to the union of its builds, packed as `stasis add` does, by the config's `resources`. |
| [`stasis github-bundle`](github-bundle.md#extra-files) | from the repository's tree, never folding case. Without the optional dependency `minimatch`, an `extra` naming anything, even only the config itself, is refused. |

In a bundle's provenance (the `reason` [`stasis audit`](audit.md) shows), each
`extra` file has the `extra` consumer, beside `run` or `bundle` where the run
or build also reached it. They are never entries.

`entries` names the entries, each with its build flags, of `stasis bundle` (see
[Entry options](bundle.md#entry-options-stasisconfigjson)) and of `stasis
github-bundle`, except those that run a program (see its
[Entries](github-bundle.md#entries)). A key is an entry's path or a
[glob pattern](bundle.md#entry-patterns). `stasis audit` with no file audits
what a bare `stasis bundle` would build of them, without writing it (see
[audit](audit.md)). `stasis run` ignores it.

`installDevDependencies: false` leaves out what only devDependencies reach from
the trees stasis lays out from the lockfile itself, so a build that reaches one
fails to resolve it (see
[`stasis github-bundle`](github-bundle.md#devdependencies-installdevdependencies)).
It doesn't set `process.env.NODE_ENV` or `__DEV__`. `stasis run` and `stasis
bundle` read `node_modules` as installed and ignore it.

`lazyDependencies: false` (`--no-lazy`) has `stasis github-bundle` fetch and
unpack every package before the build, not only those the build reads (see
[Lazy](github-bundle.md#lazy---no-lazy)): the bundle is the same, but a broken
tarball the build never reaches is refused.

`generatePrisma: false` (`--no-generate`) has `stasis github-bundle` generate no
Prisma Client (see [Prisma](github-bundle.md#prisma)); `--generate=prisma`
beside it is refused.

`lockfiles` replaces the detected lockfile with a list, a tree laid out of each
and read as one, checked by `stasis github-bundle` and `stasis bundle
--deptree` as they lay it out (see
[Several lockfiles](github-bundle.md#several-lockfiles-lockfiles)). Each is a
path from the config's directory, which may climb, to a `pnpm-lock.yaml`,
`yarn.lock`, `package-lock.json` or `soldeer.lock`:

```json
{ "lockfiles": ["pnpm-lock.yaml", "tools/package-lock.json", "contracts/soldeer.lock"] }
```

`stasis run` ignores it, but refuses one that isn't a non-empty array of paths.

Unknown keys are rejected. A key set by both file and env var must match.
`extra`, `entries`, `installDevDependencies`, `lazyDependencies`,
`generatePrisma`, `lockfiles`, the four rules below and `excludeModules` can be
set only in the file. Only `scope` is persisted into the lockfile/bundle
`config` block; `debug`, `childProcess`, `packageJSON`, `fs` and `brotliQuality`
are run-time flags, and the other keys show only through their effects.

### Allowed and disallowed paths and modules

`allowedPaths`, `disallowedPaths`, `allowedModules` and `disallowedModules`
restrict what a lockfile or bundle may carry, for every command that builds,
loads or writes one:

```json
{
  "allowedPaths": ["src", "node_modules"],
  "disallowedPaths": ["**/*.pem", "**/__fixtures__"],
  "allowedModules": ["@babel/*", "react", "react-dom"],
  "disallowedModules": ["request"]
}
```

- Every path it carries must match one of `allowedPaths`, where set, and none
  of `disallowedPaths`: the project's files and the dependencies' alike
  (`node_modules/…` as the artifact spells them, `.pnpm/` included), the
  `.stasis/empty-module.js` recorded for a disabled import, and the directories
  and stat records of a `--fs` capture. A link (which `extra`, `stasis add` or a
  `--fs` read can carry) is also held to the rules as the file it links to,
  wherever that is on disk: allowed only where both are, refused where either
  is; a link to a file in `node_modules` belongs to the package installed
  there.
- Every dependency it carries (a `modules` record, of any ecosystem) must be
  named by one of `allowedModules`, where set, and none of
  `disallowedModules`. A dependency goes by its record's `name` and, in
  `node_modules`, also by its install directory (`node_modules/nice`, or
  pnpm's `.pnpm/…/node_modules/nice`), which differ under an alias (`"nice":
  "npm:evil@1"`): it is refused where either name matches `disallowedModules`,
  and allowed only where both match `allowedModules`. A `vendored` package
  counts as its host; the project's own packages (`sources`) are not
  dependencies.
- An empty list allows nothing: `"allowedModules": []` allows no dependency.

A path pattern is a path or glob relative to the config's directory, which it
may not climb out of (`./` and a trailing `/` ignored; `.` matches everything),
matching a path or any directory above it (`src` covers everything under
`src/`). It is made of letters, digits and `_.@+-`, and:

| Syntax | Matches |
| --- | --- |
| `*` | any run of characters but `/` |
| `?` | one character; use it for any other character (`app/?id?.tsx`) |
| `**`, as a whole segment | zero or more segments (`a/**` matches `a`) |
| `{a,b}` | either; lists don't nest, an empty alternative is dropped (`{src,}` is `src`) |

These wildcards match dotfiles, and paths are matched as the artifact spells
them, never folding case. Any other pattern is refused: a `[`, a `\`, an
extglob, a range, a lone or nested brace, a `**` within a name.

A module pattern is a package name or a glob of names, matching as a path
pattern does but not a directory above: `@babel/*`, not `*`, covers
`@babel/core`, and `**` covers every name. It must have the shape of a name,
one segment or a scope's two, none of them `.`, `..` or `node_modules`
(`node_modules/evil` is refused). Two segments without a scope are a Composer
name (`vendor/package`, which may hold a `.`).

An entry of `entries` may set the four for its own build (see
[Entry options](bundle.md#entry-options-stasisconfigjson)); the config's apply
to everything a command carries, `extra` and every entry's build included. Each
list is checked on its own; none overrides another. All offenders of all rules
are named in one error, and nothing is written:

| Command | Holds to the rules |
| --- | --- |
| `stasis run`, and the bundler plugins' builds | each file before it is loaded or read, so its import fails, and the run writes nothing even if the program catches the error; a lockfile or bundle it loads, before the entry runs (rebuild it: `--lock=replace`, `--bundle=replace`) |
| `stasis bundle` | what it builds; with `--add`, also what the bundle and `--lockfile` on disk carry, the lockfile's records beyond the bundle included |
| `stasis github-bundle`, `@exodus/stasis/vfs-bundle`, `stasis bundle --deptree` | what they build, by the repository's `stasis.config.json` |
| `stasis add` | the files it adds, and what the bundles and lockfile it adds them to already carry |
| `stasis audit` with no file | the bundle it audits |

`stasis bundle --metro` also holds the app's Metro graph to `rn.config.json`'s
keys of the same names (see [Metro](bundle.md#metro---metro)), which match as
`@preventive/rn` matches them, the project's own files by its package's name:
a rule copied between the two files may not refuse the same files.

### Excluded modules

`excludeModules` names dependencies to treat as not installed, such as an
optional one a `require()` in a `try` reaches:

```json
{ "excludeModules": ["bufferutil", "@react-native-community/cli-server-api"] }
```

Its files are missing wherever stasis looks, the error saying why: `stasis
bundle` lets a `require()` or `import()` of one fall through and fails a static
import; `stasis run` throws `MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND`;
`stasis add`, `extra`, `--fs` reads and `stasis bundle` entries don't find its
files. Nothing of one is recorded, and a lockfile or bundle recording one is
refused wherever it is loaded, as is a bundler plugin's build reaching one.

A pattern matches as `disallowedModules`' does, by `package.json` name or real
install directory (for a pnpm alias, its real package's name). The project's
own packages are never excluded. An entry of `entries` may set it for its own
build, beside the config's. A lazy `stasis github-bundle` tree never fetches
one Node's resolution reaches; the `--mainFields` and `--metro` resolvers do,
though the build still leaves it out.

## `stasis.lock.json`

```json
{
  "version": 0,
  "config": { "scope": "full" },
  "entries": ["src/index.js"],
  "sources": {
    ".": {
      "name": "@exodus/stasis",
      "version": "1.0.0-alpha.0",
      "files": { "src/index.js": "sha512-…", "scripts/build.sh": "sha512-…" }
    }
  },
  "modules": {
    "node_modules/@exodus/bytes": {
      "name": "@exodus/bytes",
      "version": "1.15.0",
      "ecosystem": "npm",
      "files": { "index.js": "sha512-…", "package.json": "sha512-…" }
    }
  },
  "imports": {
    "node, import": { "src/index.js": { "@exodus/bytes": "node_modules/@exodus/bytes/index.js" } }
  },
  "formats": {
    "src/index.js": "module",
    "scripts/build.sh": "shell",
    "node_modules/@exodus/bytes/index.js": "commonjs"
  },
  "executable": ["scripts/build.sh"]
}
```

- `entries` and `sources` are present only when `scope = full`; `modules` is
  always present.
- `sources` keys are workspace package dirs (`"."` for top-level,
  workspace-relative paths otherwise; none may contain `node_modules`); `modules`
  keys are dependency dirs (must contain `node_modules`). Classification is by
  the file's **real** path: a workspace package that pnpm symlinks into
  `node_modules` from outside any `node_modules` is a source under its real
  path. A lockfile predating this rule must be regenerated, or `lock = frozen`
  flags the moved path as a mismatch.
- Each module's `name`/`version` come from its `package.json`. `files` maps
  package-dir-relative paths to SRI digests (`sha512-<base64(sha512(bytes))>`).
- Dependency records carry an `ecosystem` naming where the package physically
  resolved, not the bundle's language, in the SBOM/Package-URL `type`
  vocabulary where one exists: `npm`, `npm:directory` (an npm package pnpm or
  yarn copied into `node_modules` from a `file:` directory), `composer`
  (Composer `vendor/…`), `cargo`, `cargo-git`, `cargo-unknown`, `github` or
  `soldeer` (see the
  [layouts](#source-language-bundles-solidity--php--bash--rust--teal)).
  An npm package linked instead (`link:`, a workspace's, npm's `file:`
  directory) is first-party, under its real path. `npm:directory`,
  `cargo-git`, `cargo-unknown` and `soldeer` have no purl type, and the first
  three aren't audited. First-party buckets (`sources`) omit `ecosystem`;
  artifacts predating the field lack it and still load. One from before
  `cargo-git`/`cargo-unknown` has every vendored crate `cargo`: regenerate it
  (adding to it fails on the ecosystem mismatch). One from before
  `npm:directory` records such a package `npm`, with no `integrity`: it still
  loads and is checked as before, and a merge takes it as `npm:directory`.
- An npm dependency's record carries `integrity` and `patch`, an
  `npm:directory` one its `directory`, and any may carry `vendored`, held and
  merged as in a bundle (see [`stasis.code.br`](#stasiscodebr)). A record
  carries no `repo` or `subpackages`: those are bundle-only.
- A file under a dependency belongs to the dependency whose `package.json`
  directory holds it, and a `package.json` nested inside it must not name
  another package or version, except:
  - in a package `@exodus/stasis-core`'s `bundle-util.js` lists as keeping
    copies of others in a directory, each beside a `package.json` naming it
    (Next.js, `dist/compiled`): a file there is still the host's, and a bundle
    lists the copy (`vendored`);
  - a subpackage's, named in the package's namespace for its exact directory
    (`@hookform/resolvers/zod` at `zod/`): its files are the package's, its
    `version` its own, and a bundle lists it (`subpackages`). One named for
    another directory is still held to the package's version;
  - a `"private": true` one (terser's `dist/package.json`), passed over, though
    its `type` still applies;
  - a few known upstream mismatches `bundle-util.js` lists (`@redis/client`'s
    `dist/package.json`, `hashids`'s `esm/package.json`).
- `imports` records observed resolutions (conditions → parent file → specifier →
  resolved project-relative path). Under `lock = frozen`, a disk resolution that
  diverges from the recorded target is fatal; so is an unrecorded edge, except
  from a workspace parent in `scope = node_modules`. Under `bundle = load`, the
  loader and the esbuild and webpack plugins resolve through the recorded edges,
  and the Metro plugin checks every edge Metro resolved against them before any
  output. An import Babel or Metro adds (a `@babel/runtime` helper,
  `react/jsx-runtime`, Metro's `asyncRequire`) is neither recorded nor checked,
  though its file is carried like any other in Metro's graph.
- Per-platform edges: when `stasis bundle --metro --platforms=…` resolves one
  `(parent, specifier)` to **different** files across platforms (`./Button` →
  `Button.ios.js` on `ios` but `Button.js` on `web`), the target is a `{
  "<platform>": "<file>" }` object keyed by exactly the requested platforms (no
  `"*"`) instead of a file string. The file set is the union across platforms,
  in bundle and lockfile alike. `stasis run --bundle=load` fails closed on a
  per-platform edge (`ERR_STASIS_PLATFORM_SPECIFIC`).
- `formats` records each file's format:
  - Node loader: `module`, `commonjs`, `json`, `module-typescript`,
    `commonjs-typescript`;
  - source-language: `solidity`, `php`, `shell`, `rust`, `teal`;
  - native build-input, from the Metro native capture: `java`, `kotlin`,
    `gradle`, `objc`, `objcpp`, `swift`, `c`, `cpp`, `c-header`, `cpp-header`,
    `ruby`, `python`, `cmake`, `podspec`, `podfile`, `podfile-lock`, `gemfile`,
    `gemfile-lock`, `template`, `xml`, `env`, `fastlane`, and `pbxproj` (an
    Xcode project file added via `stasis add`);
  - Metro's: `generic-javascript`, `generic-typescript`;
  - `css`: a stylesheet, whose imports a bundler's CSS loader follows (see
    [Stylesheets](bundle.md#stylesheets-css));
  - `patch`: a `.patch` unified diff, as UTF-8 text;
  - `resource` (raw UTF-8) / `resource:base64` (binary);
  - filesystem captures: `directory`, `stat:file`, `stat:directory`.

  Native, `css` and `patch` files aren't runnable by Node. Code Metro builds
  (the Metro plugin or `stasis bundle --metro`) is `generic-javascript` (`.js`,
  `.jsx`) or `generic-typescript` (`.ts`, `.tsx`), unless its name gives its
  format (`.json`, `.mjs`, …); `stasis run --bundle=load` refuses to run
  generic code. A file Node also loads is recorded in Node's format, whichever
  records it first; an artifact from before these formats carries Metro's code
  with no format, which attests the generic one. A frozen run accepts Metro's
  capture against either. The loader picks module-vs-commonjs and (for
  `*-typescript`) type-stripping from this value alone. A mismatch is fatal; on
  disk only the attested zone is enforced (`node_modules` files in
  `node_modules` scope, everything in `full`).
- `executable` lists the recorded files carrying a POSIX execute bit (see
  [Executable files](#executable-files)); the key is omitted when none do.
- `repo` (optional, right after `config`) records where a
  [`stasis github-bundle`](github-bundle.md#local-lockfile) build was built,
  with the fields and checks of the bundle's `repo`. Only `github-bundle`
  writes one, and holds a build to the one a lockfile it loads records;
  [`stasis validate`](validate.md) reads own code from the repository and
  commit it records. `stasis bundle` and `stasis run` neither read nor write
  one, and neither a lockfile `stasis extract` writes nor a merge records one.
- File and module maps are sorted by the project's `sortPaths` rule (files in a
  dir before sub-dirs; `*` first, `node_modules` last).

## `stasis.code.br`

Brotli-compressed JSON, written when `bundle = add | replace`, read when
`bundle = add | load | frozen`. Every reader refuses bytes after the brotli
stream. Under `bundle = frozen`, each file, resolution and format observed on
disk is verified against it: an unrecorded file, a byte or format mismatch, or
a resolution redirected to a different recorded file is fatal.

A run whose frozen or lockfile verification rejects something writes nothing;
one that exits non-zero for its own reasons (a SIGINT shutdown) still writes
what it cleanly captured.

A bundle never carries a `stasis.lock.json` or a `<name>.stasis.lock.json`, at
any depth and in any case: extracted, one could replace the lockfile
[`stasis extract`](extract.md#the-lockfile---lock) or a build checks against,
or root a stasis project of its own (see [discovery](#discovery)). Such a
bundle is refused, written or read, so a run, `stasis bundle` or `stasis add`
whose files reach the project's lockfile fails.

Nor does it carry files a tool would pick up, once extracted or installed, to
run code or choose where to resolve or install from. These names are forbidden
in the project and in any package a bundle carries, at any depth and in any
case:

| Name | What it is |
| --- | --- |
| `.npm-extension.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, `.cts` | npm 12's [extension](https://docs.npmjs.com/cli/v12/configuring-npm/npm-extension/), code npm runs before it resolves the tree |
| `.pnpmfile.js`, `pnpmfile.js` (an older pnpm's), and either with `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts` | pnpm's [hooks](https://pnpm.io/pnpmfile), code pnpm runs as it resolves the tree |
| `.npmrc` | npm's and pnpm's config: `node-options` runs code in every script, it names the registries, and it holds their tokens |
| `.yarnrc`, `.yarnrc.yml` | Yarn's config: `yarnPath` (`yarn-path` to Yarn 1) is run in place of Yarn, `plugins` are loaded, and it names the registries |
| `bunfig.toml`, `.bunfig.toml` | Bun's config: `preload` runs before every `bun run` and `bun test`, and it names the registries |
| `.pnp.cjs`, `.pnp.js`, `.pnp.loader.mjs`, `.pnp.data.json` | Yarn's Plug'n'Play: the runtime Yarn preloads, and the map Yarn and bundlers resolve imports with |
| `.git`, a directory or a file, anywhere in the path | git's: the commands its config names (`core.fsmonitor`, `core.hooksPath`) and its hooks, which git runs |

Two more are forbidden only in a dependency, under `node_modules`:

| Name | What it is |
| --- | --- |
| `pnpm-workspace.yaml` | pnpm's workspace manifest: it roots a workspace of its own, with its settings (`pnpmfile`, `overrides`, ...) |
| `.env`, `.env.*`, `*.env` | env files, which Bun and others load as the project's, and which hold secrets |

A bundle holding one is refused, writing and reading alike, as is `stasis build`
of a lockfile attesting one:

```
bundle: node_modules/dep/.npmrc is a file no bundle may carry
```

```json
{
  "version": 1,
  "config": { "scope": "full" },
  "entries": ["src/index.js"],
  "formats": { "src/index.js": "module", "scripts/build.sh": "shell" },
  "imports": {
    "*": { "src/index.js": { "@exodus/bytes": "node_modules/@exodus/bytes/index.js" } },
    "node, import": { "node_modules/foo/index.js": { "./impl.js": "node_modules/foo/impl.js" } }
  },
  "executable": ["scripts/build.sh"],
  "sources": {
    ".": {
      "name": "@exodus/stasis",
      "version": "1.0.0-alpha.0",
      "files": { "src/index.js": "export const x = 1\n", "scripts/build.sh": "#!/bin/sh\n…" }
    }
  },
  "modules": {
    "node_modules/@exodus/bytes": {
      "name": "@exodus/bytes",
      "version": "1.15.0",
      "ecosystem": "npm",
      "files": { "index.js": "..." }
    }
  }
}
```

- `entries`/`sources`/`modules` mirror the lockfile shape, but `files` records
  each file's contents: raw UTF-8, or base64 for `resource:base64`.
  `entries`/`sources` are present only when `scope = full`; a missing `modules`
  is empty. A bundle carrying code in `scope = full` must declare an entry.
- An `npm:directory` record, and no other, carries `directory` after
  `ecosystem`, in place of `integrity` and `patch` (a build refuses a patch to
  a package installed from a directory): the directory its package was copied
  from, relative to the bundle root, spelled as a patch's `file` is but `.` for
  the root itself and `..` for one above it (`../shared/lib`). An empty one,
  one leading with `/` or `./`, ending with `/`, with a `..` or `.` past its
  start, or with a `\` is refused, as is the tag without it; an `npm` record
  given a directory becomes `npm:directory`. A build from a lockfile alone
  records the directory deptree copies the package from; a build from disk,
  the one pnpm's copy of its lockfile (`resolution.directory`) or yarn 1's
  `yarn.lock` (`file:`) names, held to the lockfile beside `node_modules` as an
  integrity is.

  It is held to the install record as `integrity` is (below), and, where the
  directory exists, each file of the record that the copy holds must match the
  directory's (`<dir>/<file> is not <directory>/<file>, which it was installed
  from: install from it again`), but for pnpm before 12 turning a bin's CRLF
  `#!` line into LF. With no directory there, nothing is checked. A merge takes
  an `npm` record that attests nothing (an older stasis's) as `npm:directory`'s,
  for the files it was recorded with alone; one with an `integrity` disagrees
  with it. [`stasis validate`](validate.md#packages-installed-from-a-directory)
  holds it to that directory of the repository at the commit.
- A dependency record may carry `integrity` after `ecosystem`: the SRI of the
  archive it was installed from, as its lockfile locks it (an npm tarball's
  sha512; a vendored crate's sha256, its `.cargo-checksum.json` package
  checksum, which `Cargo.lock` must lock; a Composer dist's `shasum` sha1, none
  where installed from its source; a Soldeer zip's `checksum` sha256). A build
  from a lockfile alone records what deptree fetches it with; a build from
  disk, what the package manager's install record names (yarn 1's only where
  `yarn.lock` locks a sha512).

  Wherever a build, `--add`, `stasis add` or a run meets a recorded `integrity`
  or `patch`, bundled or not, it is held to how the package was installed: the
  install record, else the lockfile beside its `node_modules`, else, from a
  lockfile alone, deptree's; under `--add`, a Soldeer, Composer or vendored
  Cargo dependency's to the source its integrity is read from. A value that
  differs, or that the install doesn't name, stops it; where nothing tells, it
  is kept. A value belongs to the files recorded with it: two records of one
  package must agree, and a merge or run that would give it to a file it wasn't
  recorded with stops (`lock = replace` records anew). A build held to
  `stasis.lock.json` merges nothing into it.
- An npm dependency record may carry `patch` after `integrity`: the pnpm
  `patchedDependencies` patch it was installed with, `{ "integrity":
  "sha256-…", "file": "patches/name@version.patch" }`, `file` from the bundle
  root (led by `../` where it is above), as the lockfile names it, else (pnpm
  11) as `pnpm-workspace.yaml` does. A build from a lockfile alone records the
  one deptree applies, a build from disk the one `node_modules/.pnpm/lock.yaml`
  names; npm and yarn patch nothing. Where a build, `stasis run` or `stasis add`
  records one, a patch whose file isn't found, or whose text doesn't match the
  hash, is refused; holding a record to the install (`--bundle=load`) reads no
  file. The patch itself is bundled only by [`extra`](#stasisconfigjson). Two
  records of one patch must agree on its `integrity`, and on its `file` where
  both record one, or are refused (`patch mismatch`), never replaced; a merge
  takes the side that records one.
  A record with an `integrity` and no `patch` is of an unpatched install: it
  disagrees with a record of a patch, and with an install that applied one. It
  is held as `integrity` is, and
  [`stasis validate`](validate.md#patched-dependencies) holds it to the
  lockfile.
- A dependency record (one with an `ecosystem`, or under `node_modules`) may
  carry a `repo` after `ecosystem`, `integrity` and `patch`: the GitHub
  repository its own manifest names,
  `{ "github": "owner/name", "directory": "packages/dep", "commit": "<sha>" }`,
  validated as the bundle's own `repo` (below), but with `github` required. An
  npm package's comes from its `package.json` by the bundle's own `repo` rules:
  only `repository` names the repository (not `bugs` or `homepage`), and
  `repository.directory`, else a GitHub tree `homepage` of it, the directory
  (`""` only from a `repository.directory` that comes to the repository root;
  none with a `..` part). A `commit` is recorded where what installed the
  dependency names a full one:
  - an npm package's `gitHead`, with the `github` its `package.json` names:
    its `package.json`'s, or, over that in a build from a lockfile alone
    (`stasis github-bundle`, `stasis bundle --deptree`, `buildVfsBundle`), its
    registry version document's, fetched beside its tarball and held to the
    lockfile's integrity;
  - over that, in a build from disk (`stasis bundle`, `buildBundle`) of any
    language, a git dependency's full commit of a GitHub repository (a git URL,
    or `https://codeload.github.com/owner/name/tar.gz/<sha>`) as its install
    record names it, with that repository, at its root or pnpm's `#path:`
    subdirectory. The install record is npm 7+'s
    `node_modules/.package-lock.json` (by location, where it records the version
    installed there), pnpm 10–12's `node_modules/.pnpm/lock.yaml` (by the
    directory under `node_modules/.pnpm`, or by name and version where pnpm
    hoists) or yarn 1's `yarn.lock` (by name and version, where exactly one
    entry has both and `node_modules/.yarn-integrity` shows it installed as
    `yarn.lock` resolves it now, else the build stops); npm's record beside
    yarn's in one `node_modules` names none;
  - a Soldeer git dependency on GitHub: that repository and `soldeer.lock`'s
    `rev`, on disk only where its folder is a git checkout at that commit; a
    Foundry `lib/` submodule, on disk: the repository `.gitmodules` names and
    its checkout's HEAD (none with no `.git`); a Composer package: its git
    `source`'s GitHub repository and the `source.reference` `composer.lock`
    (else `installed.json`) records, only where the clone's HEAD (if installed
    from source: as `installed.json` says, with no `dist`, or with a `.git` in
    its directory), else its `dist`, is at it. Each at the repository root.

  Each is the publisher's or the package manager's word, checked against no
  repository; an unreadable lockfile, save the one beside a `node_modules`,
  records none rather than stopping the build. First-party buckets carry none.
  Like the bundle's own `repo`, it is metadata: never written to the lockfile,
  never attested, never checked against a `package.json` or another artifact.
  A run fills it in where a record has none, and a merge (`stasis add`,
  `--add`, `bundle = add`) takes the side that records one, or the existing
  bundle's whole where both do. `stasis audit` looks up advisories by it, else
  by the one the bundled `package.json` names.

  A build from disk also holds every npm package to the lockfile beside its
  `node_modules` (not read for `repo`), whatever its record says:
  `npm-shrinkwrap.json`, else `package-lock.json`, by location; `yarn.lock`, by
  name and version; `pnpm-lock.yaml`, keyed as pnpm's install record. One that
  doesn't lock the package there, locks another version or, of what its record
  names, another resolution, commit, integrity or patch, or can't be read stops
  the build (`<lockfile> doesn't lock <dir> as installed (…): install from it
  again`). Of several lockfiles there, the one whose package manager alone left
  its install record is used, else the build is refused; with none, nothing is
  checked.
- A dependency record may carry `vendored` after `patch` and `repo`: the
  packages copied into the dependency whose files the bundle carries, keyed by
  the directory of each one's own `package.json`, with its `name` and, where
  given, `version`:

  ```json
  "node_modules/next": {
    "name": "next",
    "version": "16.4.0",
    "ecosystem": "npm",
    "vendored": {
      "dist/compiled/react-is": { "name": "react-is", "version": "19.3.0-canary-278794d7-20261002" },
      "dist/compiled/ua-parser-js": { "name": "ua-parser-js" }
    },
    "files": { "dist/compiled/react-is/index.js": "…", "dist/compiled/ua-parser-js/ua-parser.js": "…" }
  }
  ```

  A file belongs to the copy whose listed directory is the deepest above it.
  Each bundle (each half of a split layout apart) lists only the copies holding
  its own files. Parse rejects a listed directory holding none of the record's
  files or reached through a `node_modules`, an entry without a `name` or with
  another key, and one on first-party code. The `name` is what the copy calls
  itself, checked against no registry. It is metadata, never attested and held
  to nothing, and a lockfile records it too; a run fills in a directory a
  record doesn't list, and a merge takes the union, the existing side's where
  both list one. `stasis audit` audits each copy that records a version as the
  package it is, and `stasis sbom` lists each copy as contained in its host.
- A dependency record may carry `subpackages` after `vendored`: its subpath
  entry points with a `package.json` of their own whose files the bundle
  carries, keyed by directory, each with that `package.json`'s `name`, which
  must be the package's name for the directory, and, where given, `version`:

  ```json
  "node_modules/@hookform/resolvers": {
    "name": "@hookform/resolvers",
    "version": "5.9.1",
    "ecosystem": "npm",
    "subpackages": { "zod": { "name": "@hookform/resolvers/zod", "version": "1.0.0" } },
    "files": { "zod/dist/zod.js": "…" }
  }
  ```

  A file is in a subpackage when its `package.json` is the nearest named one
  above it, skipping `{"type":"module"}` markers. The rest is as for
  `vendored`, except that `stasis sbom` lists none: they are the package's own
  code.
- `formats`: as the lockfile's, but may be missing for code whose format Node
  infers. TypeScript sources are stored verbatim; Node strips types at load.
- `imports`: as the lockfile's. The conditions key is `"*"`, a comma-joined
  list (`"node, import"`), or a source-language bundle's language tag.
  Statically built JS bundles use `"*"`, except that a `(parent, specifier)`
  resolving differently under the require() and import() contexts, or that
  only one of them resolves (or keeps within the root), keeps each target under
  its real condition key. Under `bundle = load`, a lookup missing its exact key
  takes the `"*"` one, else the edge's one target under the keys related to its
  conditions, or, where those diverge, the one the keys of its own context
  (naming `require`, or `import`) agree on. Every key is related, except, for a
  bare or `#` specifier, one naming the other context. Lookups naming no
  conditions (the bundler plugins', Metro's) take any key.
- With a `stasis.lock.json` loaded alongside, the bundle's `entries`,
  module/source dirs, `name`/`version` and per-module file lists must match it,
  and each loaded source is hash-verified against it. Where it records
  `imports`, every bundle edge must land on the file it attests for that
  `(parent, specifier)`, under the same conditions key, else only if every
  condition set it records agrees on that target; an unknown or inconsistently
  attested edge is fatal.
- In `bundle = load` with `scope = full`, entry-point resolutions are checked
  against `entries`.
- `executable` mirrors the lockfile's, restricted to the files that bundle
  carries (each half of a split layout its own).
- `repo` (optional, right after `config`) records where the bundle was built,
  `{ "github": "owner/name", "directory": "packages/app", "commit": "<sha>" }`,
  each field optional and validated only when present:

  | Field | Value |
  | --- | --- |
  | `github` | a GitHub `owner/name`: the owner 1–39 alphanumerics or single inner hyphens, the name 1–100 characters of `[A-Za-z0-9._-]`, not `.` or `..` |
  | `directory` | a string, the bundle root's repo-relative POSIX path, at most 1024 characters: `""` for the repository root, else `/`-separated segments of `[A-Za-z0-9._~@+-]`, none empty, `.` or `..` (safe unencoded in a GitHub URL). Missing means "unknown", never "the root" |
  | `commit` | a full lowercase git object id (a 40-hex SHA-1 or a 64-hex SHA-256) |

  Unknown keys and invalid values are rejected on serialize and parse; a
  `Bundle` freezes the value and validates a new one assigned. It is **purely
  informational**: never attested, never written to the lockfile but by
  `stasis github-bundle`, and ignored by every verification. Adding to a bundle
  (`stasis add`, `stasis bundle --add`, `bundle = add`) keeps only the fields
  both agree on, and none if `github` differs or the new build has none.

  `stasis run` (and the bundler plugins), `stasis bundle` and `stasis add` fill
  it in from the nearest work tree root (a directory holding `.git`) at or above
  the bundle root: `github` from `.git/config`'s `[remote "origin"]` url,
  `directory` from the bundle root's path below it (`""` at it), `commit` from
  `HEAD` (a detached sha, a loose ref or a `packed-refs` entry); stasis only
  reads files under `.git`, never runs git. With no GitHub origin, they take the
  nearest `package.json` declaring a `repository`, at or above the bundle root
  up to the work tree root (nothing if it isn't GitHub's), and record no
  `commit` (never a `gitHead`). `github` comes from its GitHub URL or
  `github:`/`owner/name` shorthand (a `#committish` dropped, `www.github.com`
  taken for `github.com`; a URL whose authority ends before `github.com`, such
  as `https://evil.example?@github.com/a/b`, names none). `directory` comes from
  `repository.directory`, else the path of a GitHub `homepage` of the same
  repository (`…/tree/main/packages/app#readme` gives `packages/app`; the branch
  is one segment), joined with the bundle root's path below that `package.json`,
  empty and `.` parts dropped; none with neither, with a `..` part, or from a
  homepage that comes to the root. Only a `repository.directory` that comes to
  the root (`./`, `/`) gives `""`.

  `stasis github-bundle` records the fetched tree's own layout, `""` at its
  root. A detected value the rules above would reject is left out rather than
  failing the write. An older bundle's `"root": true` in place of
  `"directory": ""` is read as unknown and dropped. In a split layout
  (`resourcesBundleFile`), each half records the origin of its own contents: a
  fresh write gives both the detected `repo`; adding to one half merges only
  its own.
- `package` (optional, right after `repo`) records which package the bundle is:
  `{ "npm": { "name": "pkg", "version": "0.0.1" } }`, an optional block per
  ecosystem (`npm`, `composer` and `cargo`, in that order), each with an
  optional `name` and `version`: non-empty strings of `A-Z`, `a-z`, `0-9` and
  `._-+@/~'!()*`, no ecosystem's own rules applying. Unknown keys and invalid
  values are rejected on serialize and parse, and an empty block is not
  written. Like `repo`, it is frozen on a `Bundle`, **purely informational**,
  and never written to the lockfile. No build sets it. A merge keeps only the
  fields that agree, per ecosystem: a block is cleared whole when the names
  differ (exactly) or either side has none, and a block or field one side lacks
  is dropped, so adding to a stamped bundle clears it.

Bundles are always written as `version: 1`. A legacy `version: 0` bundle (flat
top-level `sources` keyed by project-relative path, with no
`entries`/`modules`/`formats`/`imports`) is still read by `stasis extract`,
`diff`, `audit` and `sbom`, its sources regrouped by inferred module dir, but
**`stasis run` refuses it**: rebuild it with `--bundle=replace` or `stasis
bundle`.

### Contents-free bundles

`Bundle.fromJSON(value)` is `Bundle.parse` on an already-parsed value. A
streaming reader replaces each file's contents with a symbol as they arrive
(`Bundle.fileKeyAt(path)` names the file at a key path in the bundle JSON) and
calls `Bundle.fromJSON(value, { contents: false })`, which validates the bundle
as `Bundle.parse` does and rejects any file still holding contents. The result
keeps every field and each bucket's file list, but reading a file's contents
throws, as do `sources`, `serialize()` and `merge()`.

### Streaming reader (`@exodus/stasis/bundle-reader`)

`readBundle` decompresses and parses a bundle chunk by chunk, where the
built-in readers, which the stasis commands use, peak at several times its
decompressed size.

```js
import { readBundle } from '@exodus/stasis/bundle-reader'

// The same Bundle the built-in readers give.
const bundle = await readBundle('app.stasis.code.br')

// Or take each file as it streams, and keep only the metadata (a contents-free Bundle).
const meta = await readBundle('app.stasis.code.br', {
  onFile: async (file, contents, { signal, format }) => { /* ... */ },
})
```

- `source`: a path or file `URL`, the compressed bytes (any `ArrayBuffer` or
  view), or an (async) iterable of compressed chunks such as a `Readable`.
  Bytes after the brotli stream are refused.
- `signal` aborts the read at once, queued `onFile` calls included; `onFile`
  gets it too.
- Without `onFile`, it accepts exactly what `Bundle.parse` accepts.
- With `onFile`, each file's stored contents (base64 for `resource:base64`) go
  to `await onFile(file, contents, { signal, format })`, one call at a time, in
  stream order, keyed like `bundle.sources`, then are dropped; it resolves to a
  contents-free `Bundle`. `format` is the file's `formats` entry if `formats`
  has already streamed by (always in newer bundles, which write `sources` and
  `modules` after the metadata), else `undefined`; a final `formats`
  disagreeing with a format already passed is rejected. `onFile` runs before
  the bundle is validated: treat what it receives as provisional until the
  promise resolves. A non-canonical or escaping path is never passed, nor a
  file twice. This mode rejects a few bundles `Bundle.parse` accepts:
  - a repeated JSON key that carries file contents
  - a v0 bundle with `modules`
  - a non-string content value, or a `files` array instead of an object

### Source-language bundles (Solidity / PHP / Bash / Rust / TEAL)

`stasis bundle` dispatches on the entry file extension; a directory entry is
Solidity's. Languages don't mix in one invocation, except JS and Solidity (see
[bundle](bundle.md#other-languages)):

| Extension(s) | Language | How the graph is found | `format` / `imports` key |
| --- | --- | --- | --- |
| `.js` `.cjs` `.mjs` `.ts` `.cts` `.mts` | JavaScript / TypeScript | static require/import scan | Node format / `"*"` + conditions |
| `.sol` (or a directory) | Solidity | `import` statements, resolved as the project's build tool does (see below) | `solidity` |
| `.php` | PHP | literal `require`/`include` paths + Composer-autoloaded class references (PSR-4/PSR-0/classmap/files) | `php` |
| `.sh` `.bash` | Shell | `source`/`.`, `bash`/`sh` exec, direct `./x.sh`, `# Depends on:`, `# shellcheck source=` | `shell` |
| `.rs` | Rust | `mod` declarations (incl. `#[path = …]` / `#[cfg_attr(…, path = …)]`, inside inline modules too) + `use`/`extern crate` of a crate whose source is in-tree | `rust` |
| `.teal` | TEAL (Algorand) | none: each entry is carried alone, with no edges | `teal` |

The non-JS five are **`scope = full`, produce-only artifacts**, for external
static analysis: `stasis run --bundle=load` rejects a non-JS `format`. Every
reachable file is read from disk (a symlink whose real target escapes the
bundle root is refused, as is a source file that isn't UTF-8 text) and bucketed
by its nearest manifest:

- `package.json`, by default;
- PHP: `composer.json` (`vendor/<vendor>/<pkg>`), with versions from
  `composer.lock`, read strictly with `composer.json` as `composer install`
  reads them, else from `vendor/composer/installed.json`; where both exist,
  installed.json must match the lockfile's install exactly, or the build stops;
- Rust: `Cargo.toml` `[package]`, a workspace member its own bucket
  (`version.workspace = true` resolves through the workspace root).

With none above a file, the workspace bucket is `solidity-bundle`,
`php-bundle`, `bash-bundle`, `rust-bundle` or `teal-bundle` at `0.0.0`.

A Solidity directory entry stands for every `.sol` file under it, imported or
not (not Yul sources), walked as forge walks it (a symlinked directory already
on the walk is skipped). A directory entry that is missing or holds no `.sol`
file is skipped with a warning; it is an error only when no entry yields a
file. Imports (comments and string literals skipped) resolve as solc does under
the project's build tool:

- A relative import (`./`, `../`) is resolved against the importing file; one
  that climbs above the bundle root is refused.
- Remappings then apply as solc applies them: the longest matching context
  wins, then the longest prefix, then the one listed last. With a root
  `foundry.toml` they are those `forge build` uses (a port of foundry v1.8.3's
  discovery): `FOUNDRY_REMAPPINGS`/`DAPP_REMAPPINGS`, the root
  `remappings.txt`, `[profile.default]`'s `remappings` overlaid by the
  `FOUNDRY_PROFILE` profile (with its `extends` base), those of every
  dependency that is itself a Foundry project, transitively, and those forge
  auto-detects under the `libs` dirs (`lib/` and/or `node_modules/` when
  unset), contextual ones included; aliases of the project's own
  `src`/`test`/`script` dirs are dropped, and `auto_detect_remappings = false`
  turns detection off. Profiles are `[profile.<name>]` tables and legacy
  top-level `[<name>]` ones (the former wins key by key, and alone takes
  `extends`), matched case-insensitively; an unknown one is warned about.
  `~/.foundry/foundry.toml`, `FOUNDRY_CONFIG` and the other `FOUNDRY_*`
  overrides are not read. `stasis bundle` says on stderr when `FOUNDRY_PROFILE`
  or a remapping variable shapes the result; the bundle doesn't record it.

  These are errors, whosever the file and in every mode, naming the file and
  line or entry but never its text: a `foundry.toml` or `extends` base that
  isn't TOML; a config (`foundry.toml`, `remappings.txt`, `.gitmodules`) or
  `.sol` file that isn't UTF-8; a setting of the wrong type (`libs = "deps"`);
  a remapping that isn't `[context:]prefix=target`; a config that isn't a
  regular file (never read) or can't be read (a link loop, an unsearchable
  directory). Only nothing there (a dangling link included) is no file. A
  dependency's config forge rejects for its settings (a missing `extends` base,
  nested inheritance) is skipped with a warning.

  Without a `foundry.toml`, a root `remappings.txt` applies as written
  (`@oz/=lib/oz` makes `@oz/X.sol` `lib/ozX.sol`). `--mapping=<file>` takes
  exactly the remappings that file lists: a `foundry.toml`'s selected profile
  (with its `extends` base; a top-level `remappings` key too), or a
  `remappings.txt`. A remapping forge reads (from a `foundry.toml`, or a
  `remappings.txt` next to one) gets forge's trailing `/` on prefix and target.
- An unremapped non-relative import is looked up inside the importing Foundry
  library first (each directory from the importer directory's parent up to the
  lib dir), then as a project file (solc's base path), then in `node_modules`,
  from the importer's directory up (a package's `exports` map doesn't apply).
  `--mapping` changes none of these lookups: a root `foundry.toml` still gives
  the `libs` (the defaults, with a warning, when forge would reject the file),
  and it and its `extends` base count among the config files read.

However resolved, an import must reach a `.sol` file inside the bundle root, or
is refused. A file's owner is decided by its real path, as the filesystem
spells it (on a case-insensitive one, `LIB/evil` is `lib/evil`). The
dependencies are every `node_modules` package and:

- the entries of forge's `libs` (an absolute one by its real path; a symlinked
  `lib/forge-std` is the dependency where it points);
- Soldeer's `dependencies/`;
- git submodules, from `.gitmodules` as git reads it (with
  `@preventive/lockfile`'s reader); a url relative to the superproject's
  remote, or none, gives no GitHub name. A file the reader refuses (something
  git reads two ways, or doesn't check) is warned about and read a submodule at
  a time, a branch or url that doesn't read dropped with a warning; one whose
  path doesn't read stays an unnamed dependency where it names a directory
  inside the repository; only one outside it is skipped. Every path a
  submodule is given is a dependency. A `.gitmodules` git itself refuses is an
  error.

A file is a dependency's when its real path lies in one. An import from a
dependency must land on a dependency's file, its own or another's, never the
project's, whether through a relative path, a base-path lookup, its own
remappings or a symlink. A symlink no one trusted placed is never followed: one
inside a dependency leading out of it to anything but another dependency, or
one outside the project leading back into it. Links are followed one by one
and checked against the OS's realpath: a path the two resolve differently (a
non-UTF-8 link target, a `\` the OS reads as part of a name), or one the OS
can't resolve (past `PATH_MAX`, `/dev/stdin` on a pipe), is refused; only
nothing there is missing. An `extends` path is joined as forge joins it and
resolved by the OS, from disk or a Vfs alike.

A refused path refuses the import, rejects the entry, and leaves the manifest
uncarried; a dependency's own `foundry.toml`, `extends` base or
`remappings.txt` so refused is skipped with a warning. A dependency's config
reaches only what the path from the root does: one found through an absolute
or `/proc/self/cwd` lib is judged by its real path, a dependency outside the
root reads nothing, and a dir a dependency's `libs` names must be a dependency
itself.

A `package.json` that decides a file's package is refused the same way when a
dependency planted it as a link. In a Solidity bundle, one that doesn't parse
(a leading byte-order mark aside), isn't a regular file or can't be read is an
error, rather than giving its files to the parent package; a dangling link is
no `package.json`. Other bundles walk past a malformed or unreadable one, but
the JS bundler's own lookups refuse one they can't read
(`ERR_INVALID_PACKAGE_CONFIG`).

A link the project placed (a workspace package in `node_modules`, a linked
`lib/` entry), or one on the path the project was named by, may lead anywhere
in the root; a workspace package is the project's own code.

Config files are read, not bundled, unless `--manifests` is given. It bundles
(as `json` for a `package.json`, `resource` otherwise) every config file the
resolution read, whatever it's called, by its path in the project (its real path
where a `..` or an absolute or `/proc/self/cwd` lib leads elsewhere; one past
`PATH_MAX` is refused), the root's `foundry.lock`, `soldeer.lock`, `.gitmodules`
and `package.json`, and the `package.json`, `foundry.toml` and `remappings.txt`
of every package the bundle holds files of. They are carried unedited, **secrets
included** (an RPC URL's API key, an `[etherscan]` key, `.gitmodules` URL
credentials): keep secrets in the environment (`${VAR}` in `foundry.toml`), or
don't pass `--manifests`. `hardhat.config.*` and `.env` files are never carried.
A config the resolution read that can't be carried (outside the bundle root, a
`.env` one such as `base.env`, `.env.toml` or `.env.local`, or one the ownership
rules refuse) fails `--manifests`.

Rust entries are crate roots (`src/main.rs`, `src/lib.rs`, `src/bin/*.rs`,
`tests/*.rs`, …), each with its own module tree. A `tests/*.rs` or
`benches/*.rs` entry is compiled as `cargo test` does (`cfg(test)` holds, and
the package's dev-dependencies take part in feature resolution); an
`examples/*.rs` entry links the dev-dependencies too, without `cfg(test)`.
Module files are found as rustc finds them:

- A root's `mod` declarations resolve as siblings, as do those of a file a
  `#[path = …]` loaded; one inside inline modules resolves under their
  directories, each an inline module's name or its own `#[path = "…"]`.
- A `mod` inside an `include!`d file is the including module's child, but its
  file is looked up beside the included file.
- A `mod` a `macro_rules!` body declares is declared at each outermost
  invocation, in each module of its package invoking the macro (of every crate,
  for a `#[macro_export]`ed one): beside that module's file, in the inline
  module the invocation sits in, under the cfgs the invoking file mounts the
  definition's file with. One nothing invokes is looked up beside the
  definition.
- Of several `#[path]` / `#[cfg_attr(<pred>, path = …)]` attributes on one
  `mod`, the first whose predicate holds decides the file and ends the list,
  and the default `name.rs` / `name/mod.rs` lookup is off; variants whose
  predicate is undecided stay as cfg-keyed candidates.
- A file whose inner `#![cfg(…)]` can never hold is carried but compiled
  empty, nothing in it followed.

A `use`/`extern crate` naming a crate found in-tree pulls that crate's root in:
the package's own lib target, a Cargo `path` dependency (incl. `workspace =
true` ones and `package = …` renames, honouring `[lib] path`), or a `cargo
vendor`ed crate under `vendor/` (or the `directory` of the source the cargo
config replaces crates.io with, through any chain of `replace-with`s, relative
to the directory holding the `.cargo` of the config that sets it). The cargo
config is what cargo reads when run in the directory of the first entry's
package: the config of that directory and of each one above it (above the bundle
root too, read but never bundled; not `$CARGO_HOME`'s), merged key by key,
nearest first. The vendor directory, the `[patch]` tables and the rustflags come
from it.

A crate name refers to the dependency tables of the code asking, as cargo
links them: a build script and its modules use the `[build-dependencies]`; a
test, bench or example the `[dependencies]` and `[dev-dependencies]`; other
code the `[dependencies]`; each only for the platforms the code is compiled
for. Tables that may each apply (a `cfg(windows)` and a `cfg(unix)` one
without a target) are each followed, and the edge is a cfg-keyed map of their
crates.

A `path` or `[patch]` dependency outside the bundle root is not in-tree, nor
ever bound to a vendored crate of its name; the loader says so, as of a `path`
naming a directory with no `Cargo.toml` holding a `[package]`.
`~/.cargo/registry` is never read: vendor dependencies first (`cargo vendor`).
`stasis bundle` lists the declared dependencies a `use` or an expression names
that the bundle lacks (none in-tree, or one whose root the walk refused), and,
as `md-5 (a dependency of app 0.1.0)`, every dependency a bundled package's
build links that nothing in-tree provides, named in the code or not: one in an
active (or maybe active) table of the build's platforms, a dev-dependency only
for a test, bench or example entry, a build-dependency only with
`--cargo-manifests` and a build script. A lead a glob into a crate that isn't
in-tree may explain is not reported, unless the file's package declares a
dependency of that name.

Dependency buckets carry an `ecosystem`, from the install layout each file
resolves out of:

| Bundler | Layout | `ecosystem` |
| --- | --- | --- |
| any | dep under `node_modules` | `npm` |
| any | the same, installed (copied) from a directory, a `file:` one | `npm:directory` (`directory` from the install record) |
| Solidity | Soldeer `dependencies/<name>-<version>/` | `soldeer` (name/version from dir) |
| Solidity | `forge install` submodule `lib/<dir>/` | `github` (`owner/repo` from `.gitmodules` URL) |
| Rust | `use <crate>` → `cargo vendor`'s `vendor/<crate>/`, a registry's copy | `cargo` (name/version from `Cargo.toml`) |
| Rust | the same, a git checkout's copy | `cargo-git` (name/version from `Cargo.toml`) |
| Rust | the same, a copy with no `.cargo-checksum.json` | `cargo-unknown` (name/version from `Cargo.toml`) |

A git submodule is `github` only where its `.gitmodules` url is `https`, `ssh`,
`git` or scp-like (`git@github.com:`) at `github.com` or `www.github.com`; any
other (another host, a path, a form only a `package.json` reads as GitHub's,
such as `github:o/n`, `git+https://`, `HTTPS://` or a `#committish`) is
first-party, bucketed by its nearest `package.json`. A submodule with no
`package.json`/`branch`, or a Soldeer dir with no version suffix, is `0.0.0`. A
crate reached through a Cargo `path` dependency is first-party. A vendored
crate is `cargo` only where its `.cargo-checksum.json` has a package checksum
(a registry's copy, an alternate registry's too): `stasis audit` asks OSV about
it as crates.io's crate, and `stasis sbom` gives it a `pkg:cargo` purl. A
`cargo-git` or `cargo-unknown` crate is neither sent to a public advisory
database nor given a purl.

What counts as a fatal unresolved reference differs by language:

| Language | Fatal if unresolved | Best-effort / tolerated |
| --- | --- | --- |
| Solidity | every `import` | — |
| PHP | every literal `require`/`include` path | Composer-autoloaded class refs (unresolved ones usually built-in/extension classes); a dynamic include with a static dir prefix pulls in that dir's `.php` files as candidates |
| Bash | every in-root `.sh`/`.bash` reference | PATH commands, `$VAR`/absolute/system paths, `../`-escaping sources (external); dynamic `source "${VAR}/x.sh"` followed via `# shellcheck source=` when present |
| Rust | every `mod foo;` not gated on an undecidable cfg (see the cfg rules below), incl. one whose `#[path]` names no file, or escapes the bundle root | a `mod` gated on a cfg the loader can't decide (`unix`, a feature of a package outside the resolved build, …); a `mod` inside a macro invocation body (`cfg_if! { … }` emits real ones, other macros may not — followed when the file exists); every path edge (`crate::`/`self::`/`super::`/relative `use`s, recorded best-effort and never widening the walk); crates not in-tree (see above); an `include!`/`include_str!`/`include_bytes!` whose literal path names no file, or whose argument is no literal the loader can read (a `concat!` of anything but `env!("CARGO_MANIFEST_DIR")` and literals, a macro variable) -- both warned; a vendored crate's include, `#[path]` or build script that reaches outside its own package (refused and warned; a `mod` so refused is missing) |

A missing entry is always fatal.

Rust items whose cfg can never hold in the build are skipped whole (a
`#[cfg(test)] mod tests;`, a `#[test]` fn body), so vendored crates' tests, and
the dev-dependencies only they reach, stay out. Two kinds of cfg are decided:

- `test`, `doctest`, `doc` and `#[test]` are never on when a program is built.
- `feature = "…"`, per crate, by **Cargo feature resolution** of a `cargo build`
  of the entries' packages, from every in-tree `Cargo.toml`, the `Cargo.lock`
  beside the entries' workspace root manifest (a vendored crate's own plays no
  part) and the cargo config's `[patch]`, read with `@preventive/lockfile`'s
  Cargo reader. The build stops, naming the file, on what cargo would refuse or
  might read another way: a `Cargo.toml` key cargo doesn't know, a feature
  naming nothing, a `dep?/x` of a dependency no table makes optional,
  `[replace]`; a `Cargo.lock` older than version 3, one listing a registry's
  package without its checksum, or one that could be read two ways; text that
  isn't TOML, or TOML these files are never written in (a local date, a byte
  order mark, U+FFFD). So does such a `foundry.toml`.
  - **Cargo's resolver** runs when the loader has the lockfile,
    `--cargo-target`, every locked package in-tree (path packages inside the
    bundle root, the rest vendored with their `.cargo-checksum.json`) and
    entries whose packages are workspace members. A lockfile out of date with
    the manifests, a vendored copy whose checksum isn't the lockfile's, or a
    feature asked of a package that lacks it stops the build.
  - **The replay** runs otherwise, and `stasis bundle` says why: the same
    feature resolver, by cargo's rules, over the in-tree package the loader
    picks for each dependency table (below). A dependency's own
    dev-dependencies never count; an entries' package's count under resolver
    1, and where an entry is its test, bench or example. Resolvers 2 and 3
    resolve what is built for the host (build-dependencies, proc-macro crates
    and what they depend on) apart from the target's; resolver 1 unifies it
    all, every table included. The resolver is the workspace's `resolver`, else
    its edition's. A dependency no in-tree package provides takes the features
    asked of it and is listed as lacking. The entries' packages are the
    members, each given the `--cargo-features` it has; one no package has stops
    the build.

  Either way, a target-specific dependency table counts as `--cargo-target`
  says (a build-dependency's against the host). Where the loader can't tell
  (no target; the host, unless the target is `host`; a cfg it doesn't decide,
  such as `cfg(loom)` or `cfg(debug_assertions)`), a dependency or feature only
  such a table enables is on *maybe*: its gated code is kept, but a missing
  module behind it is not fatal.

  In the replay, each dependency table is a dependency of its own, as in cargo,
  resolved to a vendored copy from its source (a git checkout's for a git
  dependency or git `[patch]`, else a registry's) at the version `Cargo.lock`
  lists that the requirement allows (semver crate rules), else at the one
  vendored version it allows (a lock listing only others is reported out of
  date). A `[patch]`, from the workspace root's manifest or the cargo config
  (ahead of the manifest's, its `path` relative to the directory holding
  `.cargo`), replaces a crate of its table's source only, where its version
  fits the dependent's requirement, else is reported and unused. Where the
  locked version isn't vendored, none fits, or several do and no lock says
  which, the loader warns (of linked dependencies only) and doesn't follow it.
  A package the resolved build doesn't pull in has unknown features, its gated
  code kept. A member bundled from its own directory takes what it inherits,
  the resolver and the `[patch]` from its workspace root's manifest above the
  bundle root (never bundled; no lockfile there or beside the member is read,
  so cargo's resolver doesn't run), passing a root whose `exclude` takes it; a
  `[workspace]` whose `members` don't list the package is still its own.
- With `--cargo-target=<triple|host>`, **target cfgs** are decided too, from
  `rustc --print cfg --target <triple>` (`host`: rustc's own, from `rustc -vV`):
  `unix`, `windows`, `target_os`, `target_family`, `target_arch`, `target_env`,
  `target_vendor`, `target_abi`, `target_pointer_width`, `target_endian`,
  `target_has_atomic`. `target_feature`, `target_thread_local`, profile cfgs
  (`debug_assertions`, `panic = …`) and custom ones stay undecided. Build
  scripts, build-dependencies and proc-macro crates compile for the host:
  `--cargo-target=host` decides them too; another target decides no platform cfg
  in them, and a `[target.'cfg(…)'.build-dependencies]` table is on maybe
  (resolver 2). A crate compiled for both is followed as both. With `--cargo`,
  the triple also goes to `cargo metadata --filter-platform`.

  It runs `$RUSTC`, else `rustc` from `PATH`, from the user's home directory
  (the filesystem root when there is none, or when it is or lies inside the
  bundle root), never from the project or a temp dir, so no
  `rust-toolchain(.toml)` there chooses what a rustup proxy runs (set
  `RUSTUP_TOOLCHAIN` or `RUSTC` for a pinned one). It has a 60-second limit and
  `RUSTUP_AUTO_INSTALL=0` (an uninstalled toolchain is an error, never a
  download), and needs only rustc's built-in knowledge of the target; one only
  another toolchain knows needs that toolchain's rustc (Solana's
  `sbf-solana-solana`:
  `RUSTC=~/.cache/solana/<release>/platform-tools/rust/bin/rustc`).

How cfgs are read:

- `all(…)`/`any(…)`/`not(…)` compose, and `true`/`false` are literal (`r#true`
  and `r#false` are custom cfgs). A predicate that reduces to true (`not(test)`,
  an enabled feature) is as firm as no cfg: a missing module behind it is fatal.
  A predicate is decided where it comes out the same whatever its undecided
  leaves are (`any(unix, not(unix))` holds). A leaf's value is taken as written
  (`"a b"` is not `"ab"`). Without a target, target cfgs stay undecided. A
  `cfg_attr` applying a non-cfg attribute gates nothing.
- A positive cfg neither rustc nor cargo sets (`loom`, `docsrs`,
  `tokio_unstable`) is a `--cfg` a default build lacks, so code under its
  negation (`not(loom)`) counts as certain. One the package's build may set is
  presumed neither off nor on: one its build script prints as
  `cargo:rustc-cfg=…` (itself or through a build-dependency it calls), or a
  rustflags `--cfg` sets (the cargo config's `rustflags`, `RUSTFLAGS`,
  `CARGO_ENCODED_RUSTFLAGS`, `CARGO_BUILD_RUSTFLAGS`); every custom cfg of a
  package whose build script formats a cfg name, writes the directive apart
  from the name or uses `autocfg`, or that has a build-dependency the bundle
  root lacks.
- A `cfg_if!` branch is under its own predicate and the negation of every
  branch before it.
- What a macro invocation's body declares is under a `#[cfg(…)]` on the
  invocation; for a `cfg_<x>!` gate macro (tokio's `cfg_io_uring!`), under the
  cfg its package's `macro_rules!` definition puts on each item it wraps, the
  same in every arm. A gate whose definition can't be read so (none in the
  package, arms that differ or write no cfg, two that differ) is opaque: its
  items are never certainly compiled nor ruled out.
- A file mounted by several declarations is under any of their cfgs; a module
  reached by several glob paths is under either's, as is everything its own
  globs reach.
- An `any(…)` of more than 16 alternatives is undecided: never certain, never
  ruled out, exclusive with nothing.

`stasis bundle --cargo` takes the dependency graph and features from `cargo
metadata` instead. It runs cargo: nothing is compiled and no build script runs,
but cargo reads the project's `.cargo/config.toml` (which can point
`build.rustc` or a wrapper at any executable), may refresh the registry index,
and writes a missing `Cargo.lock`, so use it only on a project you trust. A
registry package is matched to its vendored copy by name and version. Each
package gets one feature set, the union across dependency kinds, targets and
platforms, each feature in it on only *maybe* (code under it or its negation
is kept) and any other off. `EXODUS_STASIS_DEBUG=1` prints the resolved
features per package and context, and which resolution they come from.

`stasis bundle --cargo-manifests` also carries, as `resource` files in their
package's bucket (the workspace's for root-level ones), a project package's
`Cargo.toml` and the workspace `Cargo.toml` above it, the entries' workspace (or
package) `Cargo.lock` and the cargo configs read (`.cargo/config` before
`.cargo/config.toml`) inside the bundle root (not a path dependency's own), and
a vendored crate's `Cargo.toml` and `.cargo-checksum.json` (not the lock and
config it was published with). They are carried unedited, **secrets included**
(a `[registries]` token or `[http]` proxy, credentials in a `git = …` URL or a
lockfile `source`): keep tokens in `~/.cargo/credentials.toml` or
`CARGO_REGISTRIES_<NAME>_TOKEN`, or don't pass `--cargo-manifests`. A file that
isn't UTF-8 text is refused, not altered. With the flag, each package's build
script (`[package] build = "…"`, else `build.rs` beside the manifest; none with
`build = false`) is walked as a crate root compiled for the host, its modules
and the in-tree `[build-dependencies]` it reaches (and their build scripts)
carried as Rust code. Nothing runs.

With or without the flag, a vendored file the bundle reads, and the
`Cargo.toml` of every vendored crate the bundle or its resolution takes in, is
checked against its `.cargo-checksum.json`: one changed since `cargo vendor`
stops the bundle, as does a crate the bundle reads whose package checksum isn't
the one `Cargo.lock` locks (in the replay too). A vendored crate is held to its
own package directory: an `include!`/`include_str!`/`include_bytes!`, `#[path
= …]` or `build = "…"` in it that reaches outside, a file of it that really
lies outside (through a symlink), or a `[lib] path` outside is refused with a
warning. The project's own code may include anything under the bundle root.

The root packages' features follow `cargo build`'s flags, in either mode:
`--cargo-features=a,b` (repeatable; `x/feat` is a feature of the entries'
package named `x`, else of their dependency `x`; a name matching neither stops
the build), `--cargo-no-default-features`, `--cargo-all-features`; by default,
their `default` feature. For a `workspace = true` dependency, a member's
`default-features = false` is ignored unless the workspace entry has it too.

Rust edge specs:

| Spec | Target |
| --- | --- |
| the path as written (`crate::net::client::Client`, `super::config::Config`; a `use crate::{a::B, c::D}` group flattened to one edge per path) | the item's file (best-effort, below) |
| `mod <name>` (`mod outer::inner` when declared inside inline module `outer`) | a module file |
| `use <crate>` | a crate root |
| `include <path>`, `include_str <path>`, `include_bytes <path>` | the file an include macro names with a plain string (escapes read), a raw string, or `concat!(env!("CARGO_MANIFEST_DIR"), "/…")` (from the package root), in a `#[doc = …]` attribute as in an expression. Anything else can't be followed, and is warned about unless it is `OUT_DIR` build output |
| `<name>!` | a `macro_rules!` defined in another file the invocation can see |

A `mod` whose files vary by cfg (`#[cfg_attr(<pred>, path = …)]` variants,
same-name declarations under exclusive `#[cfg(<pred>)]`s, or `cfg_if!`
branches, each later one keyed by the earlier not holding: `all(not(unix),
windows)`) records a `{ <pred>: file, …, "*": <default file> }` map, the shape
of a per-platform JS edge, or the one file every predicate names. A
declaration a gate macro emits is keyed by the macro (`cfg_has_atomic_u64!`); a
second file under a used key gets it numbered (`*#2`).

`include!` splices Rust source, carried and scanned as a file of its own; the
other two carry an asset as `resource` / `resource:base64`, each relative to the
including file. Rust source (a module, an `include!`d file, a build script) and
an `include_str!` file must be UTF-8 text, or the build stops, naming the file;
an `include_bytes!` file is any bytes (`resource:base64` when not UTF-8). A file
one place names with `mod` or `include!` and another with `include_str!` is
Rust. An include or bare macro call inside a `macro_rules!` body resolves at
each outermost invocation, relative to the invoking file, whose edge it is.

By bare name, `<name>!` sees rustc's textual scope: the files above it in the
module tree, each up to the `mod` that mounts the next; what a `#[macro_use]
mod` hands the file mounting it, from that `mod` on; the later of two
same-named definitions, up to each call; and, in the crate root's file, the
`#[macro_export]`ed ones. By path, it goes through the module's imports, into
another crate too, whose macro is resolved by that crate's own build; a crate
root's `#[macro_use] extern crate dep;` brings dep's exported macros to every
module.

A path edge resolves best-effort, module by module along the crate's tree,
through the imports of each module reached: a `use` naming the segment, as far
as its visibility reaches, and a glob into a module of this crate that has the
name; an `extern crate x as y;` at the crate root makes `y` resolve from every
file. An import leading to another in-tree crate records that crate; one
leading out of the bundle binds the name to the importing file. Where a module
has several files or imports under exclusive cfgs (a cfg and its negation, two
values of a single-valued key such as `target_os`, `windows` against `unix`),
a path means, of the candidates compatible with the cfgs its file was mounted
under (and the target's), the first those cfgs entail, else a cfg-keyed map of
those under no custom cfg, else the first under a custom cfg, and one under a
cfg the build rules out only when nothing else fits. A `use` is an import only
when a use tree follows it (not syn's `Token![use]`, nor `use #path` in a
`quote!`). The body of a `quote!`, `quote_spanned!`,
`parse_quote!` or `parse_quote_spanned!` is skipped whole, unless the package
defines a `macro_rules!` of that name itself.

## `.stasis.tgz`

A gzipped tar of a `stasis.lock.json` at its top and exactly the files it
attests (what `tar -czf` makes of what `stasis extract --lock=add` writes),
named `stasis.tgz` or `<name>.stasis.tgz`. `stasis bundle` and `stasis
github-bundle` write one with `--format=tgz` or an `--output` so named.
`stasis validate`, `run` (`--bundle=load` or `frozen`), `build`, `audit`,
`diff` and `sbom` read it as the bundle of its files, with its lockfile beside
it; a tgz under any other name (by gzip's leading bytes), and anything else
under its name, is refused. It is refused, naming the path, unless it holds:

- each file the lockfile attests, at its path from the tgz's top, with the
  bytes of its integrity and the execute bit it attests (any of `0o111`);
- no other file, nor a symlink, hard link or device: only directories besides;
- its files as `stasis build` reads a lockfile's (code as UTF-8), held to the
  rules a `stasis.code.br` parses by: no content for a `stat:*` record, no file
  no bundle may carry;
- no byte past the gzip stream, nor past the tar's end marker, but zero
  padding. A second gzip member is read on into.

A `stasis.lock.json` in a subdirectory (npm's `package/`) is not at its top.
Its lockfile may record a `stat:*` record but no `directory` capture: one that
does is refused.

In `@exodus/stasis-core/bundle`, `Bundle.fromTar(entries, { integrityOf })`
applies these rules to `@preventive/archive`'s `unpack` entries (`{ name, type,
mode, data }`), `integrityOf(bytes)` giving the SRI sha512 (`state-util`'s
`sha512integrity`), with no Node builtin; it builds the bundle with
`Bundle.fromLockfile(lockfile, { read, integrityOf })`. `bundle.toTar({
integrityOf })` gives the entries to `pack` (`{ name, mode, data }`): the
lockfile, recording its repository, then each file, an executable one `0o755`.
A tgz carries no `reason` or `package`, and a `stat:*` record only in its
lockfile. A bundle recording a `directory` capture can't be written as a tgz.

## Resources in the bundle

Resources (any non-code file a build references) live in the usual
`sources`/`modules` buckets beside code, tagged in `formats` by payload
encoding:

- `resource` — valid UTF-8, stored raw (an SVG).
- `resource:base64` — binary bytes, base64-encoded.

```json
{
  "version": 1,
  "config": { "scope": "full" },
  "entries": ["src/index.js"],
  "formats": {
    "src/index.js": "module",
    "src/icon.svg": "resource",
    "src/logo.png": "resource:base64"
  },
  "imports": { "*": { "src/index.js": {} } },
  "sources": {
    ".": { "name": "...", "version": "...", "files": {
      "src/index.js": "…source…",
      "src/icon.svg": "<svg>…</svg>",
      "src/logo.png": "<base64>"
    } }
  },
  "modules": {}
}
```

In the lockfile a resource is hashed like any other file (sha512 of its raw
bytes), with the same `formats` tag, so a frozen run verifies it.

## Executable files

Both the lockfile and the bundle carry an `executable` array: the
project-relative paths of the **recorded files** whose on-disk mode had any
POSIX execute bit (`0o111`) when they were captured, sorted by `sortPaths`, and
**omitted when empty**.

```json
{ "executable": ["scripts/build.sh", "node_modules/dep/bin/cli.js"] }
```

`serialize` (naming the offending path) and `parse` reject an entry for
anything but the artifact's files, and a workspace path in a `scope =
node_modules` artifact.

- Files only: an entry naming a `directory` capture or a `stat:*` record is
  rejected, as is a duplicate. A legacy `version: 0` bundle grants no bit.
- The bit is read at capture from a **regular file**, following symlinks; a
  path that can't be stat'd never clears a recorded bit. Re-reading a file
  under `lock = add` / `bundle = add` refreshes its bit; a file carried over
  and never re-read keeps its entry unverified. **Windows records none and
  clears none.**
- A merge (`stasis add`, `stasis bundle --add`) unions the lists, the
  **incoming** artifact winning for the files it records.
- `stasis diff` reports execute-bit changes, even on byte-identical files;
  `stasis extract` restores the bit (see [extract.md](extract.md)).
- It is **not** part of what `lock = frozen` / `bundle = frozen` verify: an
  artifact predating the field still loads, and a mode-only change is not a
  hash mismatch.

> [!NOTE]
> The bit reflects the tree on disk: `core.fileMode=false`, zip/`git archive`
> round-trips, and `COPY`/`tar` without mode preservation flatten it, so two
> checkouts of one commit can produce different `executable` arrays.

## Filesystem captures (`stasis run --fs=sync` / `--fs=async`)

`--fs` (the config's `fs`) also patches explicit `fs` calls, so a program's own
reads, and the kind (file or directory) of each path it stats, are recorded
into the bundle (`--bundle=add|replace`) and served back (`--bundle=load`, with
the same `--fs`). An uncaptured read falls through to disk.

| Patched call (sync forms) | Captured as | Load behavior |
| --- | --- | --- |
| `readFileSync` | file bytes (see below) | serves bytes |
| `readdirSync` (no options) | `directory` — sorted JSON name array | serves listing |
| `lstatSync` / `statSync` (no options) | payload-free `stat:file` / `stat:directory` | answers kind |
| `existsSync` / `accessSync` / `realpathSync` | **not captured** (serve-only) | serves if path already carried |

`--fs=async` also patches the callback forms
(`readFile`/`readdir`/`lstat`/`stat`/`access`/`realpath`) and `fs.promises.*`,
each as its sync form; a served callback is always invoked asynchronously. A
bundle captured in either mode loads in either. Not patched: streams,
`fs.opendir`, `fs.readlink`, the deprecated callback `fs.exists`. Captures live
in the usual `sources`/`modules` buckets, tagged in `formats`.

- **`readFileSync`**: a recognized code extension
  (`.json`/`.mjs`/`.cjs`/`.mts`/`.cts`/`.js`/`.ts`) with UTF-8 bytes keeps its
  Node loader format; anything else is `resource`/`resource:base64`. A file both
  imported and read is one entry. The encoding argument is honored when serving.
- **`readdirSync`**: a single-argument call is stored as a sorted,
  JSON-serialized `directory`, so a load run sees sorted names; calls with
  options pass through. A listing of a package bucket root sits at rel `''` in
  the bucket's `files`, its format keyed at the bucket dir (`.` for the project
  root).
- **`lstatSync`/`statSync`**: a single-argument call's **kind** only, after
  the real call runs, as a **payload-free** `stat:file`/`stat:directory` (no
  bytes, hash or `files` entry). A bundle carrying content for a `stat:*` path
  fails to parse (`stasis extract`, `validate` and `run` refuse it whole) and
  is never written; `stasis build` refuses a lockfile attesting a file for such
  a path. Only regular files and directories are recorded, a `statSync`
  through an in-root symlink recording the target's kind at the requested
  path. A path carried as content, or whose real location escapes the root,
  gets no stat record; reading a stat-only path later (same run or an `add`
  re-run) upgrades it to a content record. On load, `.isFile()` and
  `.isDirectory()` answer from the bundle for any carried path or ancestor
  directory of one; other `Stats` fields are the real stat's while the file is
  on disk, else synthetic defaults. Uncarried paths and calls with options pass
  through.
- **`existsSync`/`accessSync`/`realpathSync`** (`.native` too, and the async
  `access`/`realpath` and `fs.promises.*` forms) are **never captured**: served
  for a carried path (a stat record included), else passed through to disk.
  `accessSync` serves a carried path **read-only** (`F_OK`/`R_OK` succeed;
  `W_OK`/`X_OK` defer to the real fs); `realpathSync` returns the real path
  while the file is on disk, else the **lexically** resolved request path.

> [!NOTE]
> Build tools check a file *before* reading it: `@babel/core` `existsSync`s and
> realpaths `babel.config.js` before `require()`ing it, so an unserved probe
> makes a bundled-but-absent config read as missing, and Babel silently runs
> with no config.

Source maps (`*.map`) are **non-existent** under `--fs`, in capture and load
and whatever the bundle mode: never captured or served, an `ENOENT` to
`readFileSync`/`readFile`, `statSync`/`lstatSync`, `accessSync`/`realpathSync`,
and `false` from `existsSync`. To capture a `.map` as data instead, add `map` to
the `resources` allowlist; a `.map` in the bundle is served on load even if that
run omits `--resources=map`.

Content captures are hashed like any content (a `directory`'s integrity is the
sha512 of its JSON text), so a frozen run verifies them; a stat record has only
its `formats` entry, cross-checked between bundle and lockfile.

When a bundler plugin runs with its own `bundleFile` (a *sidecar*), a read the
sidecar already attests is skipped in the main bundle at capture and served from
the sidecar at load.

## Discovery

Stasis walks up from the run's cwd looking for `package.json`, stopping at a
`.git` dir, `pnpm-workspace.yaml`, or `$PROJECT_CWD`. Any of the three stasis
files in a directory without a sibling `package.json` is fatal, and they may
appear in only one directory along the path.
