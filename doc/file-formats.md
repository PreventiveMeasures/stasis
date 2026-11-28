# Stasis File Formats

Stasis writes up to three files at the project root, next to `package.json`:

| File | Purpose | Encoding |
| --- | --- | --- |
| `stasis.config.json` | Tool configuration | JSON |
| `stasis.lock.json` | Per-file integrity lockfile | JSON |
| `stasis.code.br` | Bundled sources **and** resources | Brotli-compressed JSON |

One bundle holds both code and resources, told apart **per file** by `format`:
code files carry their loader format, resources `resource`/`resource:base64`.

Every stasis-generated file carries an integer `version`; lockfiles and bundles
are versioned independently. Paths are POSIX-style, relative to the directory
holding the lockfile, and may not start with `..`. No path may hold a `\`:
stasis refuses a file so named when bundling, writing an artifact or reading
one.

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

The file can pin `lock` to `frozen` and set no other mode: every other `lock`
mode, and every `bundle` mode, comes from the flags or env vars
(`--lock`/`--bundle`, `EXODUS_STASIS_LOCK`/`EXODUS_STASIS_BUNDLE`), and a file
that sets one is refused. With `frozen` pinned, a run must be given
`--lock=frozen` (any other lock mode is refused), and a JS `stasis bundle` built
through a State (without `--mainFields`/`--metro`), which ignores the lockfile,
is refused.

`lock`/`bundle` modes:

| Mode | Behavior |
| --- | --- |
| `ignore` | Tolerate existing data without loading or writing it |
| `add` | Load existing data, refuse to modify it |
| `replace` | Ignore existing data, rebuild from scratch |
| `frozen` | Load read-only; require every observed file to match |
| `load` | Bundle only — *serve* recorded bytes instead of reading disk |

For `bundle`, `frozen` reads disk and verifies it against the bundle, so a
frozen bundle needs no lockfile. An unset `bundle` produces no bundle, and a
stray one on disk is rejected.

Composition rules:
- `bundle = load` is incompatible with `lock = add | replace`.
- `bundle = frozen` composes with any `lock` mode.
- At least one of `lock`/`bundle` must be set.
- `fs` (`--fs`; see "Filesystem captures") requires a read/write bundle mode
  (`bundle = add | replace | load`).

`brotliQuality` (`--brotli-quality`) sets bundle-write compression: lower is
faster, higher is smaller. Content and hashes are the same at any quality, and
read-only bundle modes ignore it.

`packageJSON` (`--package-json` on `stasis run`/`stasis bundle`) adds each
bundled module's `package.json` to a written bundle, and the nearest one above
each bundled file where that differs (a `{"type":"module"}` marker such as
`esm/package.json`), even if the run or scan never reached it, so `bundle =
load` and `prune` can read every dependency's manifest. It takes effect only
while writing a bundle (`bundle = add | replace`); the added files are attested
like any other, and the flag itself is not serialized. In `stasis bundle` it
applies to every JS build, read from the `stasis.config.json` at the bundle's
root (the cwd's under `--mainFields`/`--metro`); other languages ignore it (Rust
has `--cargo-manifests`, see below).

`extra` names files to attest that the import graph never reaches (assets,
scripts, data), as `stasis add` takes them:

```json
{ "resources": ["png"], "extra": ["a.js", "b/", "c/*.png"] }
```

Each entry is a path or glob pattern relative to the directory holding
`stasis.config.json`, and may not climb out of it. Patterns expand with Node's
`fs.globSync`, as a shell would: `*` skips dotfiles, and a pattern matching
nothing is reported as a missing file. Each resulting path is taken as
[`stasis add`](bundle.md#stasis-add) takes an argument: a file is kept, and a
directory expands to the files under it, minus what a sweep leaves out. A file
the command itself writes (its lockfile or bundle) is never taken, whether
named, matched or swept, nor through a symlink or hard link to it. Every file
must be a recognized source file or have its extension (or extensionless
filename) in `resources`, except `.nvmrc`, `.ruby-version` and
`.bundle/config`, which are resources regardless. All offenders are named in
one error before anything is written.

An entry starting with `!` excludes: whatever it matches is left out however it
was named, matched or swept, and a matched directory is left out whole, never
walked (so a pattern whose every match is excluded matches nothing). Exclusions
apply wherever they sit in the list, and one matching nothing is no error. They
match with Node's `path.matchesGlob` against the path relative to the config's
directory (`./` and a trailing `/` are ignored). This sweeps an `ios` directory
without build and IDE leftovers (named dotfiles are taken as always):

```json
{ "extra": ["ios", "ios/.xcode.env", "!ios/Pods", "!ios/build", "!**/xcuserdata"] }
```

A `stasis.config.json` that sets `extra` adds itself too (`"extra": []` adds the
config alone), unless an exclusion matches it (`!stasis.config.json`,
`!*.json`):

```json
{ "extra": ["scripts/", "!stasis.config.json"] }
```

- `stasis run` adds them only when `lock` or `bundle` is `add` or `replace`; a
  `frozen`, `load` or `ignore` run never reads `extra`. A file the run loaded
  keeps the run's record; any other is recorded as a `--fs` read is: a resource
  by its bytes, a JS-family file with no loader format. Under `lock =
  add`/`bundle = add`, an extra file whose bytes changed since it was recorded
  is refused. Under `scope = node_modules`, the project's own files are left
  out.
- `stasis bundle` adds them to the bundle and to its `--lockfile`, checked
  against `--resources` instead of `resources` where given. A JS bundle scanned
  through a State reads the `stasis.config.json` at its root and records them
  as `stasis run` does. A `--mainFields`/`--metro`, Solidity, PHP, Bash, Rust or
  TEAL bundle reads the one in the cwd and packs them as `stasis add` does.
  Where `entries` builds the bundle, they are added once to the union of its
  builds, packed as `stasis add` does, by the config's `resources` (an entry's
  own applies to its graph alone).
- [`stasis github-bundle`](github-bundle.md#extra-files) adds them as `stasis
  bundle` does, from the repository's tree, globbed and matched as on disk but
  never folding case. It needs the optional dependency `minimatch`: without it,
  an `extra` naming anything, even only the config itself, is refused.

In a bundle's provenance (the `reason` [`stasis audit`](audit.md) shows), every
file `extra` names has the `extra` consumer, beside its own (`run`, `bundle`)
where the run or build also reached it. They are never entries.

`entries` names the entries of `stasis bundle`, each with its build flags (see
[Entry options](bundle.md#entry-options-stasisconfigjson)), and of `stasis
github-bundle`, except those that run a program (see its
[Entries](github-bundle.md#entries)). A key is an entry's path or a
[glob pattern](bundle.md#entry-patterns). `stasis audit` with no file audits
the bundle a bare `stasis bundle` would build of them, without writing it (see
[audit](audit.md)). `stasis run` ignores it.

`installDevDependencies` applies to the trees stasis lays out from the lockfile
itself: `false` leaves out what only devDependencies reach, as `pnpm install
--prod`, `npm ci --omit=dev` and `yarn install --production` do, so a build that
reaches one fails to resolve it. See
[`stasis github-bundle`](github-bundle.md#devdependencies-installdevdependencies).
It doesn't set `process.env.NODE_ENV` or `__DEV__` (an entry's `define` does,
or its `metro` by default). `stasis run` and `stasis bundle` read `node_modules`
as installed and ignore it.

`lazyDependencies: false` (`--no-lazy`) has `stasis github-bundle` fetch and
unpack every package of the tree it lays out from the lockfile before the build,
rather than only those the build reads (a pnpm or npm tree; see
[Lazy](github-bundle.md#lazy---no-lazy)). The bundle is the same either way,
but with it a broken tarball the build never reaches is refused.

`generatePrisma: false` (`--no-generate`) has `stasis github-bundle` generate no
Prisma Client for the projects the entries reach (see
[Prisma](github-bundle.md#prisma)); `--generate=prisma` beside it is refused.

`lockfiles` replaces the detected lockfile with a list: stasis lays out one tree
of each, read as one, e.g. for a subproject with its own lockfile or a Soldeer
project beside a JS one. Each is a path from the config's directory, which may
climb (`../../pnpm-lock.yaml`), to a `pnpm-lock.yaml`, `yarn.lock`,
`package-lock.json` or `soldeer.lock`, checked by `stasis github-bundle` and
`stasis bundle --deptree` as they lay it out (see
[Several lockfiles](github-bundle.md#several-lockfiles-lockfiles)):

```json
{ "lockfiles": ["pnpm-lock.yaml", "tools/package-lock.json", "contracts/soldeer.lock"] }
```

`stasis run` ignores it, but refuses one that isn't a non-empty array of paths.
Without it, the one lockfile is detected.

Unknown keys are rejected. A key set by both file and env var must match.
`extra`, `entries`, `installDevDependencies`, `lazyDependencies`,
`generatePrisma`, `lockfiles`, the four rules below and `excludeModules` can be
set only in the file. Only `scope` is persisted into the lockfile/bundle
`config` block; `debug`, `childProcess`, `packageJSON`, `fs` and `brotliQuality`
are run-time flags, not attested, and the other keys show only through their
effects (files added, packages reachable or fetched, clients generated, trees
laid out, artifacts refused, imports that miss).

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
  `--fs` read can carry, with the bytes of its target) is also held to the
  rules as the file it links to, wherever that is on disk: allowed only where
  both are, refused where either is (`src/link.js (a link to
  secrets/key.js)`); a link to a file in `node_modules` belongs to the package
  installed there.
- Every dependency it carries (a record of the lockfile's `modules`, of any
  ecosystem) must be named by one of `allowedModules`, where set, and none of
  `disallowedModules`. A dependency goes by its record's `name` (its
  `package.json`'s) and, in `node_modules`, also by its install directory
  (`node_modules/nice`, or pnpm's `.pnpm/…/node_modules/nice`), which differ
  under an alias (`"nice": "npm:evil@1"`). It is refused where either name
  matches `disallowedModules`, and allowed only where both match
  `allowedModules`, so allowing an alias takes both names. A `vendored` package
  counts as its host. The project's own packages (`sources`) are not
  dependencies.
- An empty list allows nothing: `"allowedModules": []` allows no dependency.

A path pattern is a path or glob relative to the directory holding
`stasis.config.json`, which it may not climb out of; `./` and a trailing `/` are
ignored, and `.` is that directory, so everything. A pattern matches a path or a
directory above it: `src` covers everything under `src/`, `**/test` every `test`
directory. A pattern is made of letters, digits and `_.@+-`, with `*` any run of
characters but `/`, `?` one character, `**` as a whole segment zero or more
segments (`a/**` matches `a`, `**/b` matches `b`), and `{a,b}` either (lists
don't nest; an empty alternative is dropped, so `{src,}` is `src`). Unlike
`extra`'s, these wildcards match dotfiles, so `.env` doesn't slip past `**`, and
paths are matched as the artifact spells them, never folding case. Any other
pattern is refused: a `[` (`app/[id].tsx` would be a class to Node's glob), a
`\`, an extglob, a range, a lone or nested brace, a `**` within a name. Match
any other character with `?` (`app/?id?.tsx`).

A module pattern is a package name or a glob of names, matching as a path
pattern does but without matching a directory above: `*` doesn't cross a
scope's `/`, so `@babel/*`, not `*`, covers `@babel/core`, and `**` covers every
name. Each must have the shape of a name, one segment or a scope's two, none of
them `.`, `..` or `node_modules`, so a path such as `node_modules/evil` is
refused. Two segments without a scope are a Composer name (`vendor/package`,
which may hold a `.`), so `evil/index.js` matches only a package of that name.

Each of the four, and each of the four an entry of `entries` sets (see
[Entry options](bundle.md#entry-options-stasisconfigjson)), is checked on its
own; none overrides another. The config's apply to everything a command
carries, every entry's build included; an entry's to its own build. So a module
the config disallows stays disallowed whatever an entry allows, an entry's
`allowedPaths` applies to its own graph, and the config's to the whole bundle,
`extra` included. All offenders of all rules are named in one error, and
nothing is written:

- `stasis run` refuses each file as the run reaches it, before it is loaded or
  read, so its import fails, and the run then writes nothing, even if the
  program catches the error. A lockfile or bundle it loads that records an
  offender is refused before the entry runs, in every mode that loads one:
  rebuild it (`--lock=replace`, `--bundle=replace`). The bundler plugins'
  builds are refused the same way.
- `stasis bundle` holds what it builds to them, each entry's build to its own
  too, and with `--add`, also what the bundle and `--lockfile` on disk already
  carry, including whatever the lockfile records beyond the bundle.
- `stasis github-bundle`, `@exodus/stasis/vfs-bundle` and `stasis bundle
  --deptree` hold what they build to the repository's `stasis.config.json` and
  its entries' own rules, as `stasis bundle` does.
- `stasis add` holds the files it adds to them, and what the bundles and
  lockfile it adds them to already carry.
- `stasis audit` with no file holds the bundle it audits to them.

In `scope = node_modules`, an artifact carries none of the project's own files,
so no rule refuses them.

`rn.config.json`'s keys of the same names belong to `rn-bundle`; `stasis bundle
--metro` holds the app's Metro graph to them as well (see
[Metro](bundle.md#metro---metro)). They match as `@preventive/rn` matches, with
no `[...]` classes or `\` escapes, and the project's own files by its package's
name, so a rule copied between the two files may not refuse the same files.

### Excluded modules

`excludeModules` names dependencies to treat as not installed, such as an
optional one a `require()` in a `try` reaches:

```json
{ "excludeModules": ["bufferutil", "@react-native-community/cli-server-api"] }
```

Its files are missing wherever stasis looks, with the reason in the error
(`excludeModules excludes node_modules/bufferutil ("bufferutil")`). `stasis
bundle` lets a `require()` or `import()` of one fall through and fails a static
import (`excluded by excludeModules`); `stasis run` throws as Node does for a
missing package (`MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND`). `stasis add`,
`extra` and `--fs` reads don't find its files, nor does `stasis bundle` an entry
in one. Nothing of one is recorded, and a lockfile or bundle that records one is
refused wherever it is loaded (`… -- recorded in stasis.lock.json; rebuild it`),
as is a bundler plugin's build reaching one.

A pattern matches as `disallowedModules`' does: by a dependency's `package.json`
name or the directory it is really installed in (for a pnpm alias, its real
package's name). The project's own packages, linked into `node_modules` or not,
are never excluded. An entry of `entries` may set it for its own build, beside
the config's. A lazy `stasis github-bundle` tree never fetches one that Node's
resolution reaches; the `--mainFields` and `--metro` resolvers do fetch it,
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
  keys are dependency dirs (must contain `node_modules`). Classification is by the
  file's **real** path: a workspace package that pnpm symlinks into `node_modules`
  from outside any `node_modules` is a **source** under its real path, not a
  dependency under the symlink path. A lockfile predating this rule must be
  regenerated, or `lock = frozen` flags the moved path as a mismatch.
- Each module's `name`/`version` come from its `package.json`. `files` maps
  package-dir-relative paths to SRI digests (`sha512-<base64(sha512(bytes))>`).
- Dependency records carry an `ecosystem` (beside `name`/`version`) naming where
  the package resolved, in the SBOM/Package-URL `type` vocabulary: `npm`
  (`node_modules`), `composer` (Composer `vendor/…`), `cargo` (`cargo vendor`
  crates copied from a registry), `github` (`forge install` git submodules from
  github.com), `soldeer` (the Foundry Solidity package manager; no purl type
  exists). A `cargo vendor` crate copied from a git checkout is `cargo-git`, and
  one with no `.cargo-checksum.json` is `cargo-unknown`: neither has a purl type
  or is audited (see the Rust bundle's table below). An artifact from before
  these two tags has every vendored crate `cargo`; regenerate it (adding to it
  fails on the ecosystem mismatch). An npm package installed from a `file:`
  directory, which pnpm and yarn copy into `node_modules` (pnpm into
  `node_modules/.pnpm/<name>@file+<dir>/…`), is `npm:directory`: it has no purl
  type, is not audited, and its record names the directory instead of an
  `integrity` (see `directory` under `stasis.code.br`). One linked instead
  (`link:`, a workspace's, npm's `file:` directory) is first-party, under its
  real path (above). An artifact from before this tag records such a package
  `npm`, with no `integrity`: it still loads and is checked as before, and a
  merge takes it as `npm:directory` (see there). The ecosystem is where the
  package physically resolved, not the bundle's language: a Solidity or Bash
  import out of `node_modules` is `npm`. First-party buckets (`sources`) omit
  `ecosystem`. Artifacts predating this field lack it and still load.
- A record carries no `repo` or `subpackages`: those are bundle-only metadata
  (see `modules` under `stasis.code.br`). An npm dependency's record carries
  `integrity` and `patch`, and an `npm:directory` one its `directory`, held and
  merged as in a bundle (see `directory` and `integrity` under
  `stasis.code.br`). A record may carry `vendored` after `ecosystem`, as in a
  bundle, so `stasis audit` and `stasis sbom` see vendored packages from a
  lockfile alone; it is metadata, never attested.
- A file under a dependency belongs to the dependency whose `package.json`
  directory holds it, and a `package.json` nested inside it must not name
  another package or version. These exceptions are accepted, and recorded in
  the bundle:
  - A package listed in `@exodus/stasis-core`'s `bundle-util.js` as keeping
    copies of others in a directory, each beside a `package.json` naming it
    (Next.js, `dist/compiled`): a file there is still the host's, and a bundle
    lists the copy it is in (`vendored`).
  - A subpackage: a subpath entry point whose own `package.json` is named in
    the package's namespace for its exact directory (`@hookform/resolvers/zod`
    at `zod/`, as microbundle lays them out). Its files are the package's, its
    `version` (a placeholder, `1.0.0`) its own, and a bundle lists it
    (`subpackages`). One named for another directory is still held to the
    package's version.
  - A `"private": true` one, such as terser's `dist/package.json`, is passed
    over, though its `type` still applies.
  - A few known upstream mismatches listed in `bundle-util.js` pass:
    `@redis/client`'s stale `dist/package.json`, and `hashids`'s
    `esm/package.json`, a `type` marker named `hashids-esm`.
- `imports` records observed resolutions (conditions → parent file → specifier →
  resolved project-relative path). Under `lock = frozen`, disk resolutions are
  checked: one that diverges from the recorded target is fatal (a specifier
  redirected to a *different* attested file); an unrecorded edge is fatal in
  `scope = full` but tolerated for workspace parents in `scope = node_modules`.
  Under `bundle = load`, the loader and the esbuild and webpack plugins resolve
  through the recorded edges, and the Metro plugin checks every edge Metro
  resolved against them before any output. An import Babel or Metro adds (a
  `@babel/runtime` helper, `react/jsx-runtime`, Metro's `asyncRequire`) is not
  an edge: it is neither recorded nor checked, though its file is carried like
  any other in Metro's graph.
- Per-platform edges (`stasis bundle --metro --platforms=…`): when `--metro`
  resolves one `(parent, specifier)` edge to **different** files across
  platforms (e.g. `./Button` → `Button.ios.js` on `ios` but `Button.js` on
  `web`), the target is a `{ "<platform>": "<file>" }` object keyed by exactly
  the requested platforms (no `"*"`) instead of a file string. Edges every
  platform agrees on stay a string, and a single requested platform never
  produces a map. The file set is the union across platforms; bundle and
  lockfile share this shape. `stasis run --bundle=load` fails closed on a
  per-platform edge (`ERR_STASIS_PLATFORM_SPECIFIC`).
- `formats` records each file's format. Values:
  Node loader (`module`, `commonjs`, `json`, `module-typescript`,
  `commonjs-typescript`); source-language (`solidity`, `php`, `shell`, `rust`, `teal`);
  native build-input (`java`, `kotlin`, `gradle`, `objc`, `objcpp`, `swift`, `c`,
  `cpp`, `c-header`, `cpp-header`, `ruby`, `python`, `cmake`, `podspec`, `podfile`,
  `podfile-lock`, `gemfile`, `gemfile-lock`, `template`, `xml`, `env`, `fastlane`,
  `pbxproj`); Metro's (`generic-javascript`, `generic-typescript`); `css` (a
  stylesheet, whose imports a bundler's CSS loader follows: see
  [Stylesheets](bundle.md#stylesheets-css)); `patch` (a `.patch` unified diff,
  e.g. pnpm `patchedDependencies` or patch-package, as UTF-8 text); `resource`
  (raw UTF-8) / `resource:base64` (binary); and the filesystem-capture tags
  `directory`, `stat:file`, `stat:directory` (see "Filesystem captures"). Native
  tags come from the Metro native capture; `pbxproj` is an Xcode project file
  added via `stasis add`. Native, `css` and `patch` files aren't runnable by
  Node. Code Metro builds (the Metro plugin or `stasis bundle --metro`) is
  `generic-javascript` (`.js`, `.jsx`) or `generic-typescript` (`.ts`, `.tsx`),
  except a file whose name gives its format (`.json` `json`, `.mjs` `module`,
  and so on); `stasis run --bundle=load` refuses to run generic code. A file
  Node also loads is recorded in Node's format, whichever records it first, and
  a frozen run accepts Metro's capture of it. A bundle or lockfile written
  before these formats carries Metro's code with no format, which attests the
  generic one, and a frozen run accepts Metro's capture against it. The loader
  picks module-vs-commonjs and (for `*-typescript`) type-stripping from this
  value alone. Checked like `imports`: a mismatch is fatal, and on disk only the
  attested zone is enforced (`node_modules` files in `node_modules` scope,
  everything in `full`).
- `executable` lists the recorded files carrying a POSIX execute bit (see
  "Executable files"); the key is omitted when none do.
- `repo` (optional, right after `config`) records where a
  [`stasis github-bundle`](github-bundle.md#local-lockfile) build was built,
  with the fields and checks of the bundle's (see `repo` under
  `stasis.code.br`). Only `github-bundle` writes one, and it holds a build to
  the one a lockfile it loads records: each recorded field must be the build's
  (`github` compared case-insensitively). [`stasis validate`](validate.md)
  reads own code from the repository and commit it records, as for a bundle.
  `stasis bundle` and `stasis run` neither read nor write one, and neither a
  lockfile `stasis extract` writes nor a merge of two records one.
- File and module maps are sorted by the project's `sortPaths` rule (files in a
  dir before sub-dirs; `*` first, `node_modules` last).

## `stasis.code.br`

Brotli-compressed JSON, written when `bundle = add | replace`, read when
`bundle = add | load | frozen`. The file is one brotli stream and nothing after
it: every reader refuses trailing bytes. `bundle = frozen` needs no lockfile: the
bundle loads read-only and each file, resolution and format observed on disk is
verified against it, so an unrecorded file, a byte or format mismatch, or a
resolution redirected to a different recorded file is fatal.

A run whose frozen or lockfile verification rejects something writes nothing.
The write depends on verification, not exit code: a run that exits non-zero for
its own reasons (a SIGINT shutdown, a CLI reporting failures) still writes what
it cleanly captured.

A bundle never carries a `stasis.lock.json` or a `<name>.stasis.lock.json`, at
any depth and in any case (`STASIS.LOCK.JSON` too): extracted, one could replace
the lockfile [`stasis extract`](extract.md#the-lockfile---lock) or a build
checks against, or root a stasis project of its own (see
[discovery](#discovery)). Writing such a bundle is refused, so a run, `stasis
bundle` or `stasis add` whose files reach the project's lockfile fails, and
reading one is refused too.

Nor does it carry files a tool would pick up as the project's own, once
extracted or installed, to run code or to choose where to resolve or install
from. These names are forbidden in the project and in any package a bundle
carries, at any depth and in any case:

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

- `entries`/`sources`/`modules` mirror the lockfile shape, but `files` records the
  file's bytes instead of SRI digests. Code and `resource` files store raw UTF-8;
  `resource:base64` files store base64. `entries`/`sources` are present only when
  `scope = full`; `modules` may be omitted (treated as empty). A bundle carrying
  code in `scope = full` must declare at least one entry; a resources-only bundle
  may have none.
- An `npm:directory` record, and no other, carries `directory` after
  `ecosystem`: the directory its package was installed (copied) from, relative
  to the bundle root, spelled as a patch's `file` is but `.` for the root itself
  and `..` for one above it (`../shared/lib`). An empty one, one leading with
  `/` or `./`, ending with `/`, with a `..` or `.` past its start, or with a
  `\` is refused, as is the tag without it. It takes the place of an
  `integrity`: such a record carries neither `integrity` nor `patch` (a build
  refuses a patch to a package installed from a directory, as deptree does). A
  build from a lockfile alone records the directory deptree copies it from (a
  pnpm `file:` override's, a yarn 1 `file:` dependency's); a build from disk,
  the one pnpm's copy of its lockfile names (`resolution.directory`, from the
  lockfile's directory) or yarn 1's `yarn.lock` does (its `file:` spec, from
  `yarn.lock`'s directory, a workspace's too), held to the lockfile beside
  `node_modules` as an integrity is (`<lockfile> doesn't lock <dir> as
  installed (installed from …; it locks …)`). An `npm` record given a directory
  becomes `npm:directory`.

  It is held to the install record as `integrity` is (below), wherever a build,
  `--add`, `stasis add` or a run meets one. Where the directory exists, each
  file of the record that the copy holds must match the directory's, so a copy
  left stale by an edit to either side (or by an editor saving anew over a pnpm
  hardlink) fails: `<dir>/<file> is not <directory>/<file>, which it was
  installed from: install from it again`. The one difference allowed is pnpm
  before 12 turning a bin's CRLF `#!` line into LF in its copy. With no
  directory there (an image of `node_modules` alone), nothing is checked. A
  merge takes an `npm` record that attests nothing (no `integrity`, `patch` or
  `directory`: an older stasis's record of such a package) as `npm:directory`'s,
  for the files it was recorded with alone, like any attested value; a record
  with an `integrity`, installed from no directory, disagrees with it
  (`directory mismatch (none vs …)`).
  [`stasis validate`](validate.md#packages-installed-from-a-directory) holds
  it to that directory of the repository at the commit.
- A dependency record may carry `integrity` after `ecosystem`: the SRI of the
  archive it was installed from, as its lockfile locks it. That is an npm
  tarball's sha512, a vendored crate's sha256 (its `.cargo-checksum.json`'s
  package checksum, which `Cargo.lock` must lock), a Composer dist's sha1
  (`shasum`; none where installed from its source) or a Soldeer zip's sha256
  (`checksum`). A build from a lockfile alone records what deptree fetches it
  with; a build from disk, what the package manager's install record names
  (yarn 1's only where `yarn.lock` locks a sha512).

  Wherever a build, `--add`, `stasis add` or a run meets a recorded `integrity`
  or `patch`, it is held to how the package was installed, whether the build
  bundles it or not: the install record, else the lockfile beside its
  `node_modules`, else, from a lockfile alone, deptree's. `--add` holds a
  Soldeer, Composer or vendored Cargo dependency's to the source a build reads
  its integrity from (above). A value that differs, or that the install doesn't
  name, stops it (`<file>: module '<dir>' (recorded vs installed) patch
  mismatch (… vs none)`); where nothing tells, it is kept. A value belongs to
  the files recorded with it: two records of one package must agree, and a
  merge or run that would give it to a file it wasn't recorded with stops
  (`lock = replace` records anew). A build held to `stasis.lock.json` merges
  nothing into it. `stasis add` adds a file of a package as the artifact records
  it where an install record tells of it; to an artifact recording none of the
  package, as a split bundle's other half records it, else its other
  artifacts, else as that record names it.
- A dependency record (one with an `ecosystem`, or under `node_modules`) may
  carry a `repo` after `ecosystem`, `integrity` and `patch`: the GitHub
  repository its own manifest names,
  `{ "github": "owner/name", "directory": "packages/dep", "commit": "<sha>" }`,
  with the fields and checks of the bundle's own `repo` (see `repo` below),
  except that `github` is required: a `repo` without it (`{}` too) is rejected
  on both serialize and parse. Builds record one for an npm package from its
  `package.json`, by the bundle's own `repo` rules: only `repository` names the
  repository (not `bugs` or `homepage`), and `repository.directory`, else a
  GitHub tree `homepage` of it, gives the directory: `""` where
  `repository.directory` comes to the repository root (`./`, `/`), which a
  homepage never gives. A manifest that names no directory, or one with a `..`
  part, records no `directory`. A `commit` is recorded where what installed a
  dependency names a full one:
  - Any build records an npm package's `gitHead` from its `package.json`, with
    the `github` it names, unless a source below names one over it.
  - A build from a lockfile alone (`stasis github-bundle`, `stasis bundle
    --deptree`, `buildVfsBundle`) takes, over the `package.json`'s, the
    `gitHead` of the package's registry version document, fetched beside its
    tarball and held to the lockfile's integrity, and only with a `github` its
    `package.json` names.
  - A build from disk (`stasis bundle`, `buildBundle`), of any language (a
    Solidity import out of `node_modules` is an npm package too), records a git
    dependency's from the install record the package manager left in
    `node_modules`: npm 7+'s hidden lockfile, `node_modules/.package-lock.json`,
    by the package's location, where it records the version installed there;
    pnpm 10–12's copy of its lockfile, `node_modules/.pnpm/lock.yaml`, by the
    directory under `node_modules/.pnpm` the package is installed in, or by
    name and version where pnpm hoists; yarn 1's `yarn.lock`, by the installed
    name and version, where exactly one entry has both and the
    `node_modules/.yarn-integrity` yarn wrote shows that entry installed as
    `yarn.lock` resolves it now (otherwise the build stops: `yarn.lock` changed
    since). Where that resolution is a full commit of a GitHub repository (a
    git URL, or GitHub's tarball
    `https://codeload.github.com/owner/name/tar.gz/<sha>`), the record takes
    that repository, at its root (`""`) or the subdirectory pnpm records
    (`#path:`), and the commit, in place of the `repo` its `package.json` names
    (so a fork's, where the manifest names the original). A registry package
    records none here (only its `gitHead`, above), nor does another host's
    repository, an abbreviated commit, or npm's record beside yarn's in one
    `node_modules`. The lockfile beside `node_modules` is not read for this, but
    every npm package is held to it whatever its record says
    (`npm-shrinkwrap.json`, else `package-lock.json`, by location; `yarn.lock`,
    by name and version; `pnpm-lock.yaml`, by the directory under
    `node_modules/.pnpm`, or by name and version where pnpm hoists): a lockfile
    that doesn't lock the package there, locks another version or, of what its
    record names, another resolution, commit, integrity or patch, or can't be
    read stops the build (`<lockfile> doesn't lock <dir> as installed (…):
    install from it again`). Of several lockfiles there, the one whose package
    manager alone left its install record is used, else the build is refused.
    With no lockfile there, nothing is checked.
  - A Soldeer git dependency on GitHub records that repository at its root
    (`""`) and `soldeer.lock`'s `rev`: from a lockfile alone, the commit
    deptree fetches; on disk, only where its folder is a git checkout whose
    HEAD is that commit (none where it is at another commit or has no `.git`).
  - A Foundry `lib/` submodule (ecosystem `github`), on disk, records the
    GitHub repository `.gitmodules` names at its root and its checkout's HEAD,
    read from its git directory as the bundle's own `commit` is (see `repo`
    below); one with no `.git` (`forge install --no-git`) records none.
  - A Composer package records the GitHub repository of its git `source`, at
    its root, and the `source.reference` that `composer.lock` (else
    `installed.json`) records. If installed from source (as `installed.json`
    says, as it must be with no `dist`, or as a `.git` in its directory shows),
    only where the clone's HEAD is still that reference; else only where its
    `dist` is at the same reference.

  Each is the publisher's or the package manager's word, checked against no
  repository; a lockfile that can't be read, save the one beside a
  `node_modules` (above), records none rather than stopping the build.
  First-party buckets carry none. Like the bundle's own `repo`, it is metadata:
  never written to the lockfile, never attested, and never checked against a
  dependency's `package.json` or another artifact's record. A run fills it in
  where a record has none, and a merge (`stasis add`, `--add`, `bundle = add`)
  takes the side that records one, or the existing bundle's whole where both
  do (a `commit` only the added side records is dropped). `stasis audit` uses
  it to look up advisories, and for a record with none, the one its bundled
  `package.json` names by the same rules (see the `stasis` README).
- An npm dependency record may carry `patch` after `integrity`: the patch pnpm
  installed it with (`patchedDependencies`), as `{ "integrity": "sha256-…",
  "file": "patches/name@version.patch" }`, its hash and its path from the bundle
  root (led by `../` where it is above). A build from a lockfile alone records
  the one deptree applies, a build from disk the one
  `node_modules/.pnpm/lock.yaml` names; npm and yarn patch nothing. Its `file`
  is the one the lockfile names, else (pnpm 11's lockfile names only the hash)
  the one `pnpm-workspace.yaml`'s `patchedDependencies` names. Where a build, `stasis
  run` or `stasis add` records one, a patch whose file isn't found, or whose
  text doesn't match the hash, is refused; holding a record to the install
  (`--bundle=load`) reads no file. The patch itself is not bundled:
  [`extra`](#stasisconfigjson) adds it. Two records of one patch must agree on
  its `integrity`, and on its `file` where both record one: a conflict is
  refused (`patch mismatch`), never replaced, and a merge takes the side that
  records one. A record with an `integrity` and no `patch` is of a package
  installed unpatched: it disagrees with a record of a patch, and with an
  install that applied one (`patch mismatch (none vs …)`). One with neither
  says nothing of either. It is held as `integrity` is, and
  [`stasis validate`](validate.md#patched-dependencies) holds it to the
  lockfile.
- A dependency record may carry `vendored` after `patch` and `repo`: the
  packages copied into the dependency (Next.js compiles ~140 into
  `dist/compiled`) whose files the bundle carries, keyed by the directory of
  each one's own `package.json`, with its `name` and, where given, `version`:

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
  Only copies holding a bundled file are listed, and each bundle (a split
  layout's code and resources halves apart) lists those of its own files. Parse
  rejects a listed directory holding none of the record's files, one through a
  `node_modules`, an entry without a `name` or with another key, and one on
  first-party code. The directory is what the host calls the copy, the `name`
  what the copy calls itself (Next.js's `loader-utils2` is `loader-utils`, its
  React `react-builtin`); neither is checked against a registry. Like `repo`,
  it is metadata, never attested and held to nothing; a run fills in a
  directory a record doesn't list, and a merge takes the union, the existing
  side's where both list one. Unlike `repo`, a lockfile records it too, by the
  same rules. `stasis audit` audits each copy that records a version as the
  package it is (see `doc/audit.md`), and `stasis sbom` lists each copy as a
  package contained in its host (see `doc/sbom.md`).
- A dependency record may carry `subpackages` after `vendored`: its subpath
  entry points with a `package.json` of their own whose files the bundle
  carries, keyed by directory, each with that `package.json`'s `name`, which
  must be the package's name for the directory (`@hookform/resolvers/zod` at
  `zod/`), and, where given, `version`:

  ```json
  "node_modules/@hookform/resolvers": {
    "name": "@hookform/resolvers",
    "version": "5.9.1",
    "ecosystem": "npm",
    "subpackages": { "zod": { "name": "@hookform/resolvers/zod", "version": "1.0.0" } },
    "files": { "zod/dist/zod.js": "…" }
  }
  ```

  A file is in a subpackage when that subpackage's `package.json` is the
  nearest named one above it, skipping `{"type":"module"}` markers. The rest is
  as for `vendored`: only those holding a bundled file are listed, each half of
  a split layout its own; parse rejects an entry holding none of the record's
  files, misnamed, or on first-party code; and it is metadata, held to nothing
  and merged by union. `stasis sbom` lists none: they are the package's own
  code.
- `formats`: project-relative path → format, same vocabulary as the lockfile's
  `formats`. May be missing per file for code whose format Node infers. TypeScript
  sources are stored verbatim (types intact); Node strips types at load time.
- `imports`: conditions → parent file → specifier → resolved project-relative
  path. The conditions key is `"*"`, a comma-joined list (e.g. `"node, import"`),
  or, for source-language bundles, the language tag
  (`solidity`/`php`/`shell`/`rust`/`teal`). Statically built JS bundles use
  `"*"`, except that a `(parent, specifier)` that resolves differently under the
  require() and import() contexts, or that only one of them resolves (or keeps
  within the root), keeps each target under its real condition key. Under
  `bundle = load`, a lookup missing its exact key takes the `"*"` one, else the
  edge's one target under the keys related to its conditions, or, where those
  diverge, the target the keys of its own context (those naming `require`, or
  `import`) agree on, so a `--conditions` build loads under plain node. Every
  key is related, except that for a bare or `#` specifier a key naming the
  other context is not. Lookups that name no conditions (the bundler plugins',
  Metro's) take any key.
- When a `stasis.lock.json` is loaded alongside, the bundle's `entries`,
  module/source dirs, `name`/`version`, and per-module file lists must match; each
  loaded source is hash-verified against the lockfile.
- When the lockfile records `imports`, every bundle resolution edge must land on
  the file the lockfile attests for that `(parent, specifier)`. The conditions key
  is matched exactly first; on a miss the edge passes only if every condition set
  the lockfile records for that parent+specifier agrees on the same target. Unknown
  or inconsistently-attested edges are fatal.
- In `bundle = load` with `scope = full`, entry-point resolutions are checked
  against `entries`.
- `executable` mirrors the lockfile's (see "Executable files"), restricted to the
  files that bundle carries — in a split layout each half lists only its own.
- `repo` (optional, right after `config`) records where the bundle was built:
  `{ "github": "owner/name", "directory": "packages/app", "commit": "<sha>" }`.
  Every field is optional and is validated only when present:
  - `github` must be a valid GitHub `owner/name`. The owner is 1–39 alphanumerics
    or single inner hyphens. The name is 1–100 characters of `[A-Za-z0-9._-]` and
    can't be `.` or `..`.
  - `directory` must be a string: the bundle root's repo-relative POSIX path, at
    most 1024 characters, with `""` meaning the repository root. Any other value
    must be safe to use
    unencoded in a GitHub URL (`https://github.com/<github>/tree/<ref>/<directory>`):
    `/`-separated segments of `[A-Za-z0-9._~@+-]`, none empty, `.` or `..`. A
    missing `directory` means "unknown", never "the root".
  - `commit` must be a full lowercase git object id (a 40-hex SHA-1 or a 64-hex
    SHA-256).

  Unknown keys and invalid values are rejected on both serialize and parse. A
  `Bundle` freezes the value it holds; assigning a new one validates it. The
  field is **purely informational**: never attested, never written to the
  lockfile but by `stasis github-bundle` (see `repo` under `stasis.lock.json`),
  and ignored by every verification. Adding to an existing bundle (`stasis add`,
  `stasis bundle --add`, `stasis run` with `bundle = add`) keeps only the fields
  that agree between the existing bundle and the new build, and none if
  `github` differs or the new build has none: the same repository and directory
  at a different commit keeps `github` and `directory` and drops `commit`.

  Bundles written by `stasis run` (and the bundler plugins), `stasis bundle` and
  `stasis add` fill in `repo` automatically, from git first:
  1. **Git:** the nearest work tree root (a directory holding `.git`) at or above
     the bundle root. `github` comes from the `[remote "origin"]` url in
     `.git/config`, `directory` from the bundle root's path below the work tree
     root (`""` at the work tree root), and `commit` from `HEAD` (a detached sha,
     or the branch's loose ref or `packed-refs` entry). stasis only reads files
     under `.git` and never runs git.
  2. **package.json:** if git yields no GitHub origin, the nearest `package.json`
     at or above the bundle root, up to the work tree root, that declares a
     `repository`. `github` comes from its GitHub URL or `github:`/`owner/name`
     shorthand (a `#committish` dropped, `www.github.com` taken for
     `github.com`; a URL whose authority ends before `github.com`, such as
     `https://evil.example?@github.com/a/b`, names none), and `directory` from
     `repository.directory` joined with the bundle root's path below that
     `package.json`. When `repository.directory` is unset, a GitHub `homepage`
     of the same repository such as
     `https://github.com/owner/name/tree/main/packages/app#readme` supplies it
     (`packages/app`; the branch is taken as one path segment). With neither,
     with a `..` part, or with a homepage that comes to the root
     (`/tree/main/.`), no directory is recorded: only `repository.directory`
     declares the root. Empty and `.` parts are dropped, and a
     `repository.directory` that comes to the repository root (`./`, `/`) is
     `""`. No `commit` is recorded: the bundle's own is git's `HEAD` alone,
     never a `package.json`'s `gitHead`. A `package.json` naming a non-GitHub
     repository records nothing.

  A `stasis github-bundle` build records the fetched tree's own layout, `""` at
  its root. A detected value the rules above would reject is left out instead of
  failing the write, so a directory that isn't URL-safe records no
  `directory`. An older bundle's `"root": true` in place of `"directory": ""` is
  read as unknown and dropped. In a split layout (`resourcesBundleFile`), each
  half records the origin of its own contents: a fresh write gives both the
  detected `repo`, and adding to one half merges only that half's.
- `package` (optional, right after `repo`) records which package the bundle is:
  `{ "npm": { "name": "pkg", "version": "0.0.1" } }`, one block per ecosystem,
  named as a module's `ecosystem` is: `npm`, `composer` and `cargo`, in that
  order. A block holds a `name` and a `version`; the block and each field are
  optional, and each is validated only when present. No ecosystem's naming or
  versioning rules apply: each field must be a non-empty string of `A-Z`,
  `a-z`, `0-9` and `._-+@/~'!()*`, i.e. any printable ASCII but space and
  ``"#$%&,:;<=>?[\]^`{|}``.

  Unknown keys and invalid values are rejected on both serialize and parse, and
  an empty block (`{}`, `{ "npm": {} }`) is not written. Like `repo`, it is
  frozen on a `Bundle` and **purely informational**: never attested, never
  written to the lockfile, and ignored by every verification. No build sets it.
  Merging two bundles keeps only the fields that agree, each ecosystem on its
  own: a block is cleared whole when the two names differ (compared exactly) or
  either side has none, and a block or field one side lacks is dropped. So
  adding to a stamped bundle (`stasis add`, `stasis bundle --add`, `stasis run`
  with `bundle = add`) clears it.

A legacy `version: 0` shape (flat top-level `sources` keyed by project-relative
path, with no `entries`/`modules`/`formats`/`imports`) is still accepted by
**offline tooling** (`stasis extract`, `stasis diff`, `stasis audit`,
`stasis sbom`): `Bundle.parse` regroups its flat sources by inferred module dir.

**`stasis run` refuses v0 bundles.** Upgrade with `stasis run --bundle=replace`
or `stasis bundle`. Bundles are always written as `version: 1`.

### Contents-free bundles

`Bundle.fromJSON(value)` is `Bundle.parse` on an already-parsed value. A
streaming reader takes each file's contents out as they arrive
(`Bundle.fileKeyAt(path)` names the file at a key path in the bundle JSON),
leaves a symbol in its place, and calls
`Bundle.fromJSON(value, { contents: false })`, which validates the bundle as
`Bundle.parse` does and rejects any file still holding contents. The result
keeps every field and each bucket's file list (`Object.keys`, `Object.hasOwn`),
but reading a file's contents throws, as do `sources`, `serialize()` and
`merge()`. Metadata-only consumers such as the `@exodus/stasis/sbom` API need
no more.

### Streaming reader (`@exodus/stasis/bundle-reader`)

The built-in readers decompress a bundle whole and `Bundle.parse` its full JSON
text, peaking at several times the decompressed size. `readBundle` decompresses
and parses chunk by chunk instead. The stasis commands still use the one-shot
path.

```js
import { readBundle } from '@exodus/stasis/bundle-reader'

// The same Bundle the built-in readers give.
const bundle = await readBundle('app.stasis.code.br')

// Or take each file as it streams, and keep only the metadata (a contents-free Bundle).
const meta = await readBundle('app.stasis.code.br', {
  onFile: async (file, contents, { signal, format }) => { /* ... */ },
})
```

- `source` is a path or file `URL` object, the compressed bytes (any
  `ArrayBuffer` or view), or an (async) iterable of compressed chunks, such as a
  `Readable`. Bytes after the end of the brotli stream are refused, however the
  chunks split them.
- `signal` aborts the read at once, including any `onFile` calls still queued.
  `onFile` gets it as `{ signal }`, so it can stop its own work.
- Without `onFile`, it accepts exactly what `Bundle.parse` accepts and builds the
  same `Bundle`.
- With `onFile`, each file's stored contents (a `resource:base64` file stays
  base64) are passed to `await onFile(file, contents, { signal, format })`. Calls are
  one at a time, in stream order, keyed like `bundle.sources`, and the contents
  are then dropped. It resolves to a contents-free `Bundle` (see above). Files
  arrive in the bundle's order: newer bundles write `sources` and `modules`
  after the metadata, older ones before it.
- `format` is the file's entry in `formats` when `formats` has already streamed
  by (always, in newer bundles), else `undefined`; read `bundle.formats` once
  the promise resolves. A bundle whose final `formats` disagrees with a format
  already passed to `onFile` is rejected.
- `onFile` runs before the bundle as a whole is validated, so treat what it
  receives as provisional until the promise resolves, and discard it if the
  promise rejects. A non-canonical or escaping path is never passed to
  `onFile`, and no file is passed twice.
  This mode rejects a few bundles `Bundle.parse` accepts:
  - a repeated JSON key that carries file contents
  - a v0 bundle with `modules`
  - a non-string content value, or a `files` array instead of an object

### Source-language bundles (Solidity / PHP / Bash / Rust / TEAL)

`stasis bundle` dispatches on the entry file extension. Languages don't mix in
one invocation, except JS and Solidity entries, each built apart and their
bundles merged (see [bundle](bundle.md#other-languages)); a directory entry is
Solidity's (see below):

| Extension(s) | Language | How the graph is found | `format` / `imports` key |
| --- | --- | --- | --- |
| `.js` `.cjs` `.mjs` `.ts` `.cts` `.mts` | JavaScript / TypeScript | static require/import scan | Node format / `"*"` + conditions |
| `.sol` (or a directory) | Solidity | `import` statements, resolved as the project's build tool does (see below) | `solidity` |
| `.php` | PHP | literal `require`/`include` paths + Composer-autoloaded class references (PSR-4/PSR-0/classmap/files) | `php` |
| `.sh` `.bash` | Shell | `source`/`.`, `bash`/`sh` exec, direct `./x.sh`, `# Depends on:`, `# shellcheck source=` | `shell` |
| `.rs` | Rust | `mod` declarations (incl. `#[path = …]` / `#[cfg_attr(…, path = …)]`, inside inline modules too) + `use`/`extern crate` of a crate whose source is in-tree | `rust` |
| `.teal` | TEAL (Algorand) | none: each entry is carried alone, with no edges | `teal` |

These five are **`scope = full`, produce-only artifacts** in the
`stasis.code.br` shape, tagged with a language `format` and keyed under a
language `imports` condition, for external static analysis. `stasis run
--bundle=load` rejects a non-JS `format`. Every reachable file is read from disk
(a symlink whose real target escapes the bundle root is refused, as is a source
file that isn't UTF-8 text) and bucketed by the nearest `package.json`, except
PHP, by the nearest `composer.json` (`vendor/<vendor>/<pkg>`, versions from
`composer.lock`, read strictly with `composer.json` as `composer install` reads
them, else from `vendor/composer/installed.json`; where both exist,
installed.json must match the lockfile's install exactly, or the build stops),
and Rust, by the nearest `Cargo.toml` `[package]` (a workspace member is its own
bucket; `version.workspace = true` resolves through the workspace root). With no
manifest above a file, the workspace bucket gets a placeholder identity
(`solidity-bundle`/`php-bundle`/`bash-bundle`/`rust-bundle`/`teal-bundle` at
`0.0.0`).

Solidity entries are `.sol` files or directories: a directory stands for every
`.sol` file under it, imported or not (`stasis bundle src test script` is what
`forge build` compiles, `stasis bundle contracts` what Hardhat compiles; Yul
sources are not collected). Symlinks are followed as forge's walker (walkdir)
follows them: a symlinked directory already on the walk is a loop and skipped,
anything else is walked, so two links to one directory give two copies. A
directory entry that is missing or holds no `.sol` file is skipped with a
warning; only when no entry yields a file is it an error (`no such file or
directory` when none exists). The import scan skips comments (a `//` comment
ends at `\n` or `\r`) and string literals (read as bytes: `\xNN` is one byte,
and the path is those bytes as UTF-8). Imports resolve as solc does under the
project's build tool:

- A relative import (`./`, `../`) is resolved against the importing file; one
  that climbs above the bundle root is refused.
- Remappings then apply as solc applies them: the longest matching context
  wins, then the longest prefix, then the one listed last. With a `foundry.toml`
  at the root they are the ones `forge build` uses (a port of foundry v1.8.3's
  discovery): `FOUNDRY_REMAPPINGS`/`DAPP_REMAPPINGS`, the root
  `remappings.txt`, the `remappings` of `[profile.default]` overlaid by the
  `FOUNDRY_PROFILE` profile (with its `extends` base), the remappings of every
  dependency that is itself a Foundry project (its `foundry.toml` and
  `remappings.txt`, relativised onto it, transitively), and the ones forge
  auto-detects under the `libs` dirs (`lib/` and/or `node_modules/` when unset),
  including the contextual ones that scope a dependency's imports to its own
  copy of a package; aliases of the project's own `src`/`test`/`script` dirs
  are dropped, and `auto_detect_remappings = false` turns detection off.
  The following are errors, whosever the file and in every mode, naming the
  file (from the root) and the line or entry but never its text, with no
  fallback to a default: a `foundry.toml` or `extends` base that isn't TOML; a
  config (`foundry.toml`, `remappings.txt`, `.gitmodules`) or `.sol` file that
  isn't UTF-8; a setting of the wrong type (`libs = "deps"`, a `src` that isn't
  a string, an `extends` that isn't a path or `{ path, strategy }`); an invalid
  remapping (a `remappings.txt` line or `FOUNDRY_REMAPPINGS` entry that isn't
  `[context:]prefix=target`, or a `remappings` value that isn't an array of
  such strings); a config that isn't a regular file (a FIFO, a device or a link
  to one, such as `remappings.txt -> /dev/stdin`, is never read); and one that
  can't be read (a link loop, a file in a directory that may not be searched).
  Only nothing there (a link to nothing included) counts as no file. A
  `remappings.txt` line is trimmed as forge trims it, so a byte-order mark
  stays part of the first remapping. A dependency's config forge rejects for
  its settings (a missing `extends` base, nested inheritance) is skipped with a
  warning, as forge skips it.
  Profiles are `[profile.<name>]` tables and the legacy top-level `[<name>]`
  ones (the former wins key by key; `extends` counts only in the former);
  names match case-insensitively. Not read: `~/.foundry/foundry.toml`,
  `FOUNDRY_CONFIG` and the other `FOUNDRY_*` overrides. When `FOUNDRY_PROFILE`
  (a profile the `foundry.toml` has; one it hasn't is warned about) or a
  remapping variable shapes the result, `stasis bundle` says so on stderr; the
  bundle doesn't record it.
  Without a `foundry.toml`, a root `remappings.txt` applies as written, as solc
  and Hardhat apply it (`@oz/=lib/oz` makes `@oz/X.sol` `lib/ozX.sol`; `x/=`
  makes `x/A.sol` `A.sol`).
  `--mapping=<file>` replaces the remappings with exactly the ones that file
  lists: a `foundry.toml`'s selected profile (with its `extends` base; a
  `remappings` key outside any table is taken too), or a `remappings.txt`. A
  remapping forge reads (from a `foundry.toml`, or a `remappings.txt` next to
  one) gets forge's trailing `/` on prefix and target
  (`forge-std=lib/forge-std/src` is `forge-std/=lib/forge-std/src/`).
- An unremapped non-relative import is looked up inside the importing Foundry
  library first (the include path forge adds for `lib/dep/src/A.sol` importing
  `src/B.sol`: each directory from the importer directory's parent up to the
  lib dir, as foundry-compilers tries them), then as a project file (solc's
  base path: `import "src/A.sol"`), then as a package file in `node_modules`,
  from the importer's directory up (Hardhat and Node: `hardhat/console.sol`,
  `@scope/pkg/contracts/X.sol`; a package's `exports` map doesn't apply).
  `--mapping` changes none of these lookups: a root `foundry.toml` still gives
  the `libs` (the default ones, with a warning, when forge would reject the
  file), and `FOUNDRY_PROFILE` picking them is reported (an unknown profile is
  warned about instead, as without `--mapping`); that `foundry.toml` and its
  `extends` base count among the config files read.

Whatever resolves an import, the result must be a `.sol` file inside the bundle
root (an `import ".env";` or a remapping to `/opt/x/` is refused, saying why).
Who owns a file is decided by where it really is, spelled as the filesystem
spells it (on a case-insensitive one, `LIB/evil` is `lib/evil`). The
dependencies are every `node_modules` package and:

- the entries of forge's `libs` (an absolute one by its real path; a symlinked
  `lib/forge-std` is the dependency where it points);
- Soldeer's `dependencies/`;
- git submodules, from `.gitmodules` read with `@preventive/lockfile`'s reader,
  as git reads it. A url relative to the superproject's remote, or none, is
  taken as written, and the submodule has no GitHub name to bucket it by. A file
  the reader refuses (something git reads two ways, or doesn't check, such as
  `update = none`, `active` or a `[core]` section) never fails the bundle: it's
  warned about and read a submodule at a time (`[submodule.x]` as git reads it,
  `[submodule "x"]`), taking each submodule's last `path`, `url` and `branch`,
  and dropping with a warning a branch or url that doesn't read. One whose path
  doesn't read fails closed: a path naming a directory inside the repository,
  such as `./lib/x` or `lib/x/`, still makes it an unnamed dependency, and only
  one outside it is skipped. Every other path a submodule is given (a `path`
  twice, or a second section of its name) is a dependency too. A `.gitmodules`
  git itself refuses (a "bad config line", such as a header `[submodule x]`,
  `[submodule.lib/x]` or `[submodule "x"` with no `]`, or a value with no
  closing quote) is an error.

A file is a dependency's when its real path lies in one, however the path got
there (`src/vendor -> ../lib/dep/src` holds the dependency's code). An import
from a dependency must land on a dependency's file: its own or another
dependency's (forge-std's `ds-test`), never the project's, whether through a
relative path, a base-path lookup, its own remappings or a symlink. A symlink
no one trusted placed is never followed: one inside a dependency that leads out
of it to anything but another dependency (`lib/evil/src/Evil.sol ->
../../../.env`), and one outside the project that leads back into it (a
dependency linked from elsewhere, `lib/evil -> ../../shared/evil`, holding a
link to the project's `.env`). Links are followed one by one and the result
checked against the OS's own realpath: a path the two resolve differently (a
link target that isn't UTF-8, one whose `\` the OS reads as part of a name), or
one the OS can't resolve at all (a real path past `PATH_MAX`, a link whose end
it can't name: `/proc/self/fd/0` or `/dev/stdin` on a pipe), is refused; only a
path with nothing there counts as missing. An `extends` path is joined as forge
joins it and resolved by the OS, so a `..` after a symlink leads where forge's
does, in the project's config and a dependency's alike, and in a bundle built
from a Vfs (`stasis github-bundle`, `buildVfsBundle`) too.

Whosever import, entry or manifest a refused path is, the import is refused, the
entry rejected, the manifest not carried, and a dependency's own
`foundry.toml`, `extends` base or `remappings.txt` skipped with a warning (one
that is another dependency's file is read). A dependency's config reaches only
what the path from the root does: one found through an absolute or
`/proc/self/cwd` lib is judged by its real path, a dependency outside the root
reads nothing, and a dir a dependency's `libs` names must be a dependency
itself; a refused config says why.

A `package.json` that decides a file's package is refused the same way when a
dependency planted it as a link. One that doesn't parse (a leading byte-order
mark is skipped, as npm skips it), isn't a regular file or can't be read (a link
loop, a directory that may not be searched) is an error naming it (not quoting
it) rather than giving its files to the parent package; a link to nothing is no
`package.json`, as to Node. Other bundles walk past a malformed or unreadable
one, but the JS bundler's own lookups (its resolver and its packages' names, on
disk and in a Vfs) refuse one they can't read, as Node does
(`ERR_INVALID_PACKAGE_CONFIG`).

A link the project placed (a workspace package linked into `node_modules`, a
linked `lib/` entry, `src/vendor`) may lead anywhere in the root, as may one on
the path the project was named by (a symlinked checkout); a workspace package
is the project's own code.

Config files are read, not bundled, unless `--manifests` is given. It bundles
every config file the resolution read, whatever it's called (an `extends =
"base.conf"`, a `--mapping=remaps`), by its path in the project (by its real
path once a `..` or an absolute or `/proc/self/cwd` lib leads elsewhere; one
whose real path the OS can't give, past `PATH_MAX`, is refused), the root's
`foundry.lock`, `soldeer.lock`, `.gitmodules` and `package.json`, and the
`package.json`, `foundry.toml` and `remappings.txt` of every package the bundle
holds files of: `json` for a `package.json`, `resource` otherwise, so `stasis
extract` restores them. They are carried unedited, so whatever they hold (an
`eth_rpc_url` or `[rpc_endpoints]` URL with its API key, an `[etherscan]` key,
the credentials in a `.gitmodules` URL) is in the bundle too. Keep secrets in
the environment (`${VAR}` in `foundry.toml`) rather than in these files, or
don't pass `--manifests`. `hardhat.config.*` and `.env` files are never
carried. A config the resolution read that can't be carried (one outside the
bundle root, such as `extends = "../shared-base.toml"`; a `.env` one, such as
`base.env`, `.env.toml` or `.env.local`; or one the ownership rules refuse)
fails `--manifests`, naming it.

Rust entries are crate roots (`src/main.rs`, `src/lib.rs`, `src/bin/*.rs`,
`tests/*.rs`, …). Each root gets its own module tree, so a lib and its bin
bundled together don't collide on `crate::`. Module files are found as rustc
finds them:

- A root's `mod` declarations resolve as siblings, as do those of a file a
  `#[path = …]` loaded. A `mod` declared inside inline modules resolves under
  their directories, each an inline module's name or its own `#[path = "…"]`
  (solana-program's `#[path = ""] mod non_bpf_modules { mod account_keys; }`
  finds `account_keys.rs` beside the file).
- A `mod` inside an `include!`d file is the including module's child, but its
  file is looked up beside the included file: `include!("gen/list.rs")` with
  `mod bar;` in it finds `gen/bar.rs`, whose own submodules sit under
  `gen/bar/`.
- A `mod` a `macro_rules!` body declares is declared in each module of its
  package that invokes the macro, by bare name or by path (`crate::m!()`, a
  `$crate::m!()` in another macro's body), through the macros whose bodies
  invoke it, at the outermost call. It is found beside that module's file, in
  the inline module the invocation sits in (not the ones around the
  definition), under the cfgs the invoking file mounts the definition's file
  with (serde_core's `crate_root!`, defined in crate_root.rs and invoked in
  lib.rs, declares lib.rs's `de`: `src/de/mod.rs`). A `#[macro_export]`ed
  macro's `mod` is declared in every crate invoking it (`#[macro_use] extern
  crate a; decl!();` declares the app's module). A `mod` in a `macro_rules!` that
  another's body defines is that inner macro's, declared where it is invoked.
  One nothing invokes is looked up beside the definition.
- When several `#[path]` / `#[cfg_attr(<pred>, path = …)]` attributes sit on
  one `mod`, the first whose predicate holds decides the file and ends the
  list, and the default `name.rs` / `name/mod.rs` lookup is off; variants whose
  predicate is undecided stay as cfg-keyed candidates.

A `tests/*.rs` or `benches/*.rs` entry is compiled as `cargo test` does:
`cfg(test)` holds, its `#[test]` fns and `#[cfg(test)]` modules are live, and
the package's dev-dependencies take part in the feature resolution; an
`examples/*.rs` entry links the dev-dependencies too, without `cfg(test)`.

A `use`/`extern crate` naming a crate found in-tree pulls that crate's root in:
the package's own lib target (`use my_app::…` from `main.rs`), a Cargo `path`
dependency (incl. `workspace = true` ones and `package = …` renames, honouring
`[lib] path`), or a `cargo vendor`ed crate under `vendor/` (or the `directory`
of the source the cargo config replaces crates.io with, through any chain of
`replace-with`s, whatever its name, relative to the directory holding the
`.cargo` of the config that sets it).

The cargo config is what cargo reads when run in the directory of the first
entry's package (its workspace root found from there): the config of that
directory and of each one above it (above the bundle root too, read but never
bundled; not `$CARGO_HOME`'s), merged key by key, nearest first, as cargo merges
them (a nested workspace's `[source.vendored-sources] directory = "third"`
beside the bundle root's `replace-with`). The vendor directory, the `[patch]`
tables and the rustflags all come from that one reading.

Which of a package's dependency tables a name refers to depends on the code
asking, as cargo links them: a build script and its modules (a file it shares
with the lib through `#[path]` too) use the `[build-dependencies]`; a test,
bench or example the `[dependencies]` and `[dev-dependencies]`; other code the
`[dependencies]`. Of those, only the tables of the platforms the code is
compiled for count (`[target.'cfg(windows)'.dependencies] foo = "2"` is no
crate of a Linux build). Tables that may each apply (a `cfg(windows)` and a
`cfg(unix)` one without a target, or a shared file's two) are each followed,
and the edge is a cfg-keyed map of their crates.

A `path` or `[patch]` dependency outside the bundle root is not in-tree, and
never bound to a vendored crate of its name instead: the loader says so, as it
does of a `path` naming a directory with no `Cargo.toml` holding a `[package]`.
Registry dependencies in `~/.cargo/registry` are never read: vendor them first
(`cargo vendor`). `stasis bundle` lists the crates a bundle references but lacks
(none in-tree, or one whose root the walk refused, such as a symlink leading out
of the bundle root), `vendor/` dir or not: a dependency the package declares,
whether a `use` or only an expression (`serde_json::to_string(…)`) names it. It
also lists, as `md-5 (a dependency of app 0.1.0)`, every dependency a bundled
package's build links that nothing in-tree provides, however the code names it,
if at all (`md-5`, used as `md5`): one in an active table of the build's
platforms (or one only maybe applying), a dev-dependency only for a test, bench
or example entry, a build-dependency only with `--cargo-manifests` and a build
script. With no `vendor/` dir it also suggests `cargo vendor`.

A path edge (`crate::a::b::Item`, `super::x`, a relative `child::y`) resolves
module by module along the crate's tree, inline `mod x { … }` blocks included
(a `mod imp;` file wins over an inline `mod imp { … }` of the same name under
another cfg). A segment that names no module may be bound by an import of the
module reached, which is followed:

- a `use` naming it outright (`pub use serde_core as serde`, `extern crate
  serde_core as s`, `pub(crate) use helper` of a `macro_rules!` macro), as far
  as its visibility reaches: a plain `use` only for a path written in that
  module or below, `pub(super)` / `pub(in …)` within that scope;
- a glob (`pub use external::*`), when the module it names is one of this crate
  and that module has the name: a `pub` child module (a private `mod` is not
  glob-importable), an item it defines (a `struct`, `fn`, `const`, … at module
  level, an `extern "C"` block's too, not an `impl`'s associated items or a
  fn's local ones; libc's `crate::sigset_t` lands on the platform file whose
  `s! { … }` defines it, not on a later platform's re-export of the name), or a
  name a `use` of its own binds.

A segment with more path after it names a module or a type-namespace item: a
`fn log` or `const libc` beside `use log::info` / `*const libc::c_char` never
stands for the crate, nor does a `use crate::util::log;` of such a fn
(`log::info!` names the crate `log`, whose root the bundle loads).

Where a module has several files or imports under cfgs that can't hold together
(libc's platform modules, each glob re-exported from a `cfg_if!` branch; mio's
two `pub use … Waker` in two branches of one file; tokio's macro-keyed `mod imp`
variants), a path means a candidate compatible with the cfgs its own file was
mounted under, checked along the whole chain of imports followed. Exclusive
cfgs are a cfg and its negation, two values of a single-valued key such as
`target_os`, two variants of one `mod`, `windows` against `unix`, and an
`any(…)` none of whose alternatives can hold (libc's `any(target_os = "linux",
target_os = "l4re")` branch against a file under `target_os = "aix"`); so a
file under `#[cfg(unix)] mod unix;` never resolves through the fuchsia or
windows branch. Of the compatible candidates, the path means:

1. the first whose cfgs its file's own entail (a candidate under the same
   `target_os` leaf it was mounted under, over one under an `any(…)` nothing
   rules out);
2. when none is entailed, every compatible one under no custom cfg, each under
   its own cfgs: the edge is a cfg-keyed map of their files, the shape of a
   `mod`'s variants below, or that file when they agree (a file under no
   platform cfg asking libc's `crate::sockaddr`, defined per platform, maps
   each platform's file, not the first written). So does a path through such a
   module, the rest of it walked through each (`use unix as imp;` beside `use
   windows as imp;`, or a module two cfg-gated globs bring in: `crate::imp::X`
   maps unix.rs and windows.rs), and through a module there under a cfg the
   file doesn't hold beside another binding of its name (`#[cfg(not(unix))] mod
   sys;` and `#[cfg(unix)] use fallback as sys;`);
3. else the first under a custom cfg;
4. and a candidate under a cfg the build rules out (a feature that is off,
   another target) only when nothing else fits.

When the asking file is itself under a cfg the build rules out, the build says
nothing: the file asks as it would where it is compiled, under its own cfgs
rather than the target's (tokio's atomic_u64_as_mutex.rs submodules'
`super::AtomicU64` is as_mutex's, not the native one, under a 64-bit target),
and one whose own cfgs contradict each other, compiled nowhere, maps every
candidate.

A positive cfg that neither rustc nor cargo sets (`loom`, `docsrs`,
`tokio_unstable`, mio's `mio_unsupported_force_poll_poll`, an `any(…)` of such
and of alternatives the file rules out) is a `--cfg` a default build lacks: a
candidate under one is taken only after those under none, and one under its
negation (`not(loom)`) counts as certain. Unless the package's build may set
it: a name its build script prints as `cargo:rustc-cfg=…`, itself or through a
build-dependency it calls (that crate's code, and that of what it depends on),
or that a rustflags `--cfg` sets (the `build`/`target.<…>` `rustflags` of each
cargo config the build reads, see above, `RUSTFLAGS`, `CARGO_ENCODED_RUSTFLAGS`,
`CARGO_BUILD_RUSTFLAGS`) is presumed neither off nor on. Build-script code that
formats a name, whole or in part (`cargo::rustc-cfg=os_{}`, cfg_aliases'
`cfg_aliases!`), writes the directive apart from the name (build-rs's
`rustc_cfg`) or uses `autocfg` makes every custom cfg of its package so, as
does a build-dependency the bundle root lacks. Full-line comments count for
nothing.

A child module the build rules out, or one under a custom cfg it presumably
lacks, gives way to whatever else its module has of the name, as such a
candidate does to any other (serde's docsrs-only `mod de` to the `pub use
serde_core::de` of every other build, a `#[cfg(loom)] mod imp` to the `imp` a
`use other::*` brings in), but only when none of its files may be there: a
`#[cfg_attr(loom, path = "loom.rs")] mod imp;` falls back to imp.rs in every
other build, and shadows the glob.

With `--cargo-target`, every file compiled for the target is under the target's
cfgs too, so a `windows` candidate is out for every file and a `target_os =
"linux"` file takes the `any(android, linux)` branch over the `any(aix,
solaris)` one (mio's `sys::Waker` is the eventfd one under a Linux target;
without one, the edge maps each branch's). An item a module defines in several
of its files follows the same ranking, the module's own tree file first within
a rank.

What cfgs code is under:

- A `cfg_if!` branch is under its own predicate and the negation of every
  branch before it, nested chains each on their own.
- A `#[cfg(…)]` on a macro invocation gates everything its body declares (mio's
  `#[cfg(unix)] cfg_os_poll! { mod unix; … }`).
- The body of a `cfg_<x>!` gate macro (tokio's `cfg_io_uring!`, mio's
  `cfg_os_poll!`) is under the cfg its package's `macro_rules!` definition puts
  on each item it wraps (`$( #[cfg(feature = "rt")] $item )*`, the same in
  every arm), so `cfg_x!` and `cfg_not_x!` are told apart by their
  definitions, not their names. A gate whose definition the loader can't read
  (none in the package, arms that differ or write no cfg, two definitions that
  differ) is one it can't see into: its items are never certainly compiled nor
  ruled out.
- A file mounted by several declarations is under any of their cfgs; a module
  reached by several glob paths is under either's, and so is everything its own
  globs reach.
- An `any(…)` of more than 16 alternatives (a module reached along every path
  of a dense cycle of cfg-gated globs, a cfg listing a score of platforms) is
  undecided: never certain, never ruled out, exclusive with nothing, so
  whatever stands under it is one candidate of the cfg-keyed map, beside the
  others.

A glob into the sysroot or into another crate claims nothing. Since a glob into
a crate that isn't in-tree may still provide a name, an unresolved lead in a
file with such a glob (`use syn::*; … punctuated::Punctuated`) is not reported
as an unresolved crate, unless the file's package declares a dependency of that
name, which the lead then is: one missing from the bundle is reported whatever
the globs beside it. A glob into an in-tree crate explains only the names the
module its path names there has, or its own globs bring in (tokio's `use
tokio::sync::*;` explains `mpsc`; tracing's `use tracing_core::*;` does not hide
its `tracing_attributes`), and a glob into the sysroot or an enum explains none.

An `extern crate x as y;` at the crate root puts `y` in the extern prelude, so
`y::…` and `::y::…` resolve from every file of the crate, and `extern crate self
as y;` puts the crate itself there (syn's `use syn::parse::ParseStream` in syn
is syn's own parse.rs).

At the crate root the final segment may be a `#[macro_export]` macro
(`$crate::name!`), which lives in the file defining it. An invocation
(`crate::helper!()`, recorded as `crate::helper!`) names the macro before a
module of that name, each definition under its file's cfgs, ranked with an
import of the name that leads to a macro (a `pub use inner::m;` of the builds a
`#[cfg(docsrs)]` copy isn't in); an ordinary path (`crate::helper()`) names the
module first. An invocation is looked up among macros throughout: an item a
module defines (`fn m`), a module, an import of a module or crate, or one
leading to a file that defines no macro of the name (`pub use util::helper;` of
a `fn helper`) is no `m!`, so a `fn m` beside `use crate::macros::*` leaves the
glob's `m!` in place. A one-segment path written at the crate root names such a
macro when no crate has the name (anyhow's `pub use anyhow as format_err;` in
lib.rs; a child module's `use x;` does not reach it).

The answers don't depend on the order the files are listed in: each module's
files count in tree order, the variants of a `mod` as declared. Anything else is
an item of the module reached, whose file is the edge's target (a plain item
behind a glob re-export can't be placed more precisely).

An import that leads to another in-tree crate records that crate (`use
serde_core`). One that leads out of the bundle, to the sysroot (`pub use
core::result::Result`) or to a crate that isn't vendored, binds the name to its
own file (serde's `$crate::__private::Result` records the file of the `lib`
module that re-exports `core::result`), a candidate like any other, under its
cfgs: tokio's `imp::AtomicU64` is std's, re-exported in one variant file, or
the mutex-based one the other defines. A module's own items rank with its named
imports, ahead of what its globs bring in, which never shadows them (tokio's
`crate::trace::trace_leaf` is the fn defined under `cfg_not_taskdump!`, not the
import under the `cfg_taskdump!` that is off).

The module an import was first followed from is a dependency too: when nothing
else in the file points at its file, the path's prefix naming it is recorded
(`crate::__private` → private/mod.rs), unless that file is the crate root. An
edge from a file to itself is never recorded.

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

A dep under `node_modules` is `npm` (or `npm:directory`) whatever the language.
A git submodule is `github` only where its `.gitmodules` url is GitHub's:
`https`, `ssh`, `git` or scp-like (`git@github.com:`) at `github.com` or
`www.github.com`. Any other is first-party, bucketed by its nearest
`package.json` like any file outside `node_modules`: another host's, even one
holding `github.com` (`https://notgithub.com/o/n`), a path, and one a
`package.json` takes for GitHub's that git reads another way or not at all
(`github:o/n`; `ssh://git@github.com:o/n`, whose host is `github.com:o`; a
`#committish`; `git+https://` or `HTTPS://`). A git submodule with no
`package.json`/`branch`, or a Soldeer dir with no version suffix, falls back to
`0.0.0`; the workspace bucket carries no `ecosystem`. A Rust crate reached
through a Cargo `path` dependency is first-party (its own `Cargo.toml` bucket,
no `ecosystem`). A vendored crate's `.cargo-checksum.json` tells where it was
copied from: `cargo vendor` writes a registry crate's with the package's
checksum, a git dependency's with `"package": null`. Only a registry's copy (an
alternate registry's too) is `cargo`, which `stasis audit` asks OSV about as
crates.io's crate and `stasis sbom` gives a `pkg:cargo` purl; a `cargo-git` or
`cargo-unknown` crate is neither sent to a public advisory database nor given a
purl.

What counts as a fatal unresolved reference differs by language:

| Language | Fatal if unresolved | Best-effort / tolerated |
| --- | --- | --- |
| Solidity | every `import` | — |
| PHP | every literal `require`/`include` path | Composer-autoloaded class refs (unresolved ones usually built-in/extension classes); a dynamic include with a static dir prefix pulls in that dir's `.php` files as candidates |
| Bash | every in-root `.sh`/`.bash` reference | PATH commands, `$VAR`/absolute/system paths, `../`-escaping sources (external); dynamic `source "${VAR}/x.sh"` followed via `# shellcheck source=` when present |
| Rust | every `mod foo;` not gated on an undecidable cfg (see the cfg rules below), incl. one whose `#[path]` names no file, or escapes the bundle root | a `mod` gated on a cfg the loader can't decide (`unix`, a feature of a package outside the resolved build, …); a `mod` inside a macro invocation body (`cfg_if! { … }` emits real ones, other macros may not — followed when the file exists); every path edge (`crate::`/`self::`/`super::`/relative `use`s, recorded best-effort and never widening the walk); crates not in-tree (see above); an `include!`/`include_str!`/`include_bytes!` whose literal path names no file, or whose argument is no literal the loader can read (a `concat!` of anything but `env!("CARGO_MANIFEST_DIR")` and literals, a macro variable) -- both warned; a vendored crate's include, `#[path]` or build script that reaches outside its own package (refused and warned; a `mod` so refused is missing) |

A missing entry is always fatal.

Rust items whose cfg can never hold in the build are skipped whole (a
`#[cfg(test)] mod tests;` file, an inline `mod tests { … }` with every module and
`use` in it, a `#[test]` fn body), so vendored crates' test modules stay out,
and with them the dev-dependencies only test code reaches for. Two kinds of cfg
are decided:

- `test`, `doctest`, `doc` and `#[test]` are never on when a program is built.
- `feature = "…"` is decided per crate from **Cargo feature resolution**: what
  `cargo build` of the entries' packages turns on. The loader reads the
  `Cargo.toml` of every package in-tree (the root package or workspace, `path`
  dependencies, `vendor/`), the `Cargo.lock` of the entries' workspace (beside
  its root manifest, below the bundle root too; a vendored crate's own published
  lock plays no part) and the `[patch]` of the cargo config with
  `@preventive/lockfile`'s Cargo reader, which reads them as cargo does and
  refuses what cargo would refuse or what it can't tell how cargo reads: a
  `Cargo.toml` with a key cargo doesn't know, a feature naming nothing, a
  `dep?/x` of a dependency no table makes optional, `[replace]`; a `Cargo.lock`
  older than version 3 (no `version`), one listing a registry's package without
  its checksum, or one that could be read two ways. Any of those stops the
  build, naming the file, as does text that isn't TOML (naming the line) or TOML
  those files are never written in (a local date, a byte order mark, U+FFFD
  where bytes weren't UTF-8); so does such a `foundry.toml`.
  - **Cargo's resolver**, when the loader holds all it needs: the lockfile,
    `--cargo-target`, every package the lockfile has in-tree (each path package
    inside the bundle root, every other one vendored with its
    `.cargo-checksum.json`), and entries whose packages are workspace members.
    `@preventive/lockfile` lays the lockfile's graph over the manifests and
    turns on the features the build does, by cargo's rules throughout: each
    dependency table its own source (a git dependency the git checkout, a
    registry one the registry's copy, whatever their versions), a `[patch]` from
    the root manifest or the cargo config, proc-macro crates and
    build-dependencies built for the host, `--cargo-features` distributed among
    the packages as cargo does. A lockfile out of date with the manifests, a
    vendored copy whose checksum isn't the lockfile's, or a feature asked of a
    package that lacks it stops the build. A vendored copy the lockfile doesn't
    list needs no `.cargo-checksum.json`.
  - **The replay**, otherwise (no lockfile, no target, a locked package not
    vendored or without its checksums, an entry outside the workspace), and
    `stasis bundle` says so and why (`[stasis] Rust features from a replay of
    the manifests, not cargo's resolver: no --cargo-target`). The manifests are
    laid out as the lockfile's graph would be, each dependency table resolved
    to the in-tree package the loader picks for it (see below), and handed to
    the same `@preventive/lockfile` feature resolver, by cargo's rules: the
    roots start from their `default` feature; features imply features (`std =
    ["alloc", "dep:serde", "serde?/std"]`; `serde/derive` turns on the
    package's feature `serde` too, written or the one an optional dependency
    gets), enable optional dependencies and request dependency features; and
    every active dependency gets `default` plus what its dependents ask for. A
    dependency's own dev-dependencies never count (sha2's `[dev-dependencies]
    digest = { features = ["dev"] }` doesn't turn on digest's `dev`); an
    entries' package's own count under resolver 1, and where an entry is a
    test, bench or example of it. Resolver 2 (edition 2021, or `resolver =
    "2"`) also resolves what is built for the host (build-dependencies,
    proc-macro crates and what they depend on) apart from what is built for the
    target: a feature a build-dependency asks of a crate isn't on in that crate
    as a normal dependency. Resolver 1 unifies it all, every table included.
    Resolver 3 (edition 2024, or `resolver = "3"`) resolves features as
    resolver 2 does. The resolver is the workspace's: its `resolver`, else its
    edition's. A dependency no in-tree package provides stands in for itself:
    it takes the features asked of it, and is listed as a dependency the bundle
    lacks (see above). The entries' packages are the members, each given the
    `--cargo-features` it has; one no package has stops the build.

  Either way, a target-specific dependency table counts when `--cargo-target`
  says it applies (a build-dependency's table against the host), and not when
  it says it doesn't. Where the loader can't tell (no target; the host, when
  the target isn't `host`; a cfg it doesn't decide on the platform, such as
  `cfg(loom)`, which rustflags may set, or `cfg(debug_assertions)`), the build
  is resolved both ways, and a dependency or feature only such a table enables
  is on *maybe*: its gated code is kept, but a missing module behind it is not
  fatal, and a candidate under it is never taken as certain.

  In the replay, each dependency table is a dependency of its own, as in cargo:
  `rand = "0.7"` under `[dependencies]` beside `rand = "0.8"` under
  `[build-dependencies]` (or a `[dev-dependencies] fake = { package = "rand",
  version = "0.6" }`) is two crates, and a file is followed into the one its
  code uses (see above). A git dependency (or one a git `[patch]` replaces)
  resolves to a git checkout's vendored copy (one whose `.cargo-checksum.json`
  has no package checksum), any other to a registry's; of those, to the version
  `Cargo.lock` lists for the crate from that source that the requirement
  allows, so two vendored versions of one crate each get their own features and
  edges. A lock that lists only versions the requirement doesn't allow is out
  of date: the loader says so and goes by the requirement, as when there is no
  lock entry, taking the one vendored version the requirement allows.
  Requirements are read by the semver crate's rules (`@preventive/lockfile`'s
  `rust-semver.js`): `1` takes no prerelease, `=2.0.0-rc.1` takes that one. A
  `[patch]`, in the workspace root's manifest (one above the bundle root too)
  or in the cargo config the build reads (see above: nearest first, ahead of
  the manifest's, its `path` relative to the directory holding `.cargo`),
  replaces a crate of its table's source only (`[patch.crates-io]` crates.io's,
  `[patch."https://github.com/…"]` that repository's), and only where its
  version fits the dependent's requirement; one that doesn't is reported and
  not used. When the locked version isn't vendored, no vendored version fits,
  or several do and no lock says which, the loader warns and doesn't follow the
  dependency. It warns only of dependencies the build links: not of another
  platform's table, nor of a dev-dependency where no entry is a test, bench or
  example.

  A package the resolved build doesn't pull in has unknown features, and its
  gated code is kept. A member bundled from its own directory, with its
  workspace root above the bundle root, takes what it inherits
  (`edition.workspace = true`, `dep = { workspace = true }`), the resolver and
  the `[patch]` from that root, as cargo does: the loader reads that manifest
  for those, never bundling it, nor reading the lockfile beside it or a stale
  one beside the member, so cargo's resolver doesn't run. Where that root's
  `exclude` takes the package, it looks further up, as cargo does. A
  `[workspace]` whose `members` don't list the package is still its own, as it
  is to cargo.

- With `--cargo-target=<triple|host>`, **target cfgs** are decided too: the
  loader asks `rustc --print cfg --target <triple>` (`host`: the running
  rustc's own target, from `rustc -vV`) for the target's cfg set (`unix`,
  `windows`, `target_os`, `target_family`, `target_arch`, `target_env`,
  `target_vendor`, `target_abi`, `target_pointer_width`, `target_endian`,
  `target_has_atomic`), so `#[cfg(windows)]` code, a `#[cfg_attr(windows, path
  = …)]` variant or a `[target.'cfg(windows)'.dependencies]` table stays out of
  a Linux bundle. `target_feature`, `target_thread_local`, profile cfgs
  (`debug_assertions`, `panic = …`) and custom ones stay undecided. Build
  scripts (see `--cargo-manifests`), build-dependencies and proc-macro crates
  compile for the host: with `--cargo-target=host` its cfgs decide them as they
  decide the rest; with another target no platform cfg is decided in them, and
  a `[target.'cfg(…)'.build-dependencies]` table is on maybe (resolver 2). A
  crate compiled for both (a dependency that is also a build-dependency) is
  followed as both.
  This runs `$RUSTC` when set, else `rustc` from `PATH`, from the user's home
  directory (the filesystem root when there is none, or when the home directory
  is the bundle root or lies inside it, real paths compared), never from the
  project being bundled nor from a temp dir, so no `rust-toolchain(.toml)`
  there chooses what a rustup proxy runs. To use a project's pinned toolchain,
  set `RUSTUP_TOOLCHAIN` or `RUSTC` yourself. It runs with a 60-second limit
  and `RUSTUP_AUTO_INSTALL=0`, so an uninstalled toolchain is an error, never a
  download, and needs only rustc's built-in knowledge of the target, not its
  standard library. A target only another toolchain knows needs that
  toolchain's rustc: Solana's `sbf-solana-solana` needs the rustc in its
  platform-tools (`RUSTC=~/.cache/solana/<release>/platform-tools/rust/bin/rustc`),
  not a rustup one. With `--cargo`, the same triple goes to `cargo metadata
  --filter-platform`.

`all(…)`/`any(…)`/`not(…)` compose, and `true` and `false` are what they say (a
raw `r#name` is the name; `r#true` and `r#false` are names, custom cfgs like any
other). A predicate that reduces to true (`not(test)`, an enabled feature) is as
firm as no cfg, so a missing module behind it is fatal. A leaf's value is taken
as written, spacing outside its quotes aside: `my = "a b"` and `my = "ab"` (or
`"a  b"`) are different values. A predicate an undecided leaf occurs in more
than once is decided when it comes out the same whatever that leaf is: an
item's cfg joined with its enclosing blocks', `all(any(test, kani),
not(kani))`, never holds (zerocopy's test-only `use rand::…`), and `any(unix,
not(unix))` always does. Without a target, target cfgs stay undecided and their
code is kept. A `cfg_attr` that applies a non-cfg attribute
(`#[cfg_attr(docsrs, doc(cfg(…)))]`) gates nothing.

`stasis bundle --cargo` takes the dependency graph and features from `cargo
metadata` instead of resolving them itself. It runs cargo: nothing is compiled
and no build script runs, but cargo reads the project's `.cargo/config.toml`
(which can point `build.rustc` or a wrapper at any executable), may refresh the
registry index, and writes `Cargo.lock` when there is none, so use it only on a
project you trust. It works with or without a `.cargo/config.toml` that
redirects crates.io to `vendor/`: a registry package cargo read from
`~/.cargo/registry` is matched to its vendored copy by name and version. `cargo
metadata` resolves the whole workspace with dev-dependencies and all targets,
and gives one feature set per package, the union across normal, dev and build
dependency kinds and across platforms. So `--cargo` takes each of those features
as on only *maybe*, in the target's build and the host's alike: code under it,
or under its negation (`cfg(not(feature = "x"))`), is kept, and only a feature
outside the union is off. It describes everything cargo would ever compile for
the workspace, tests included; the loader's own resolution describes the `cargo
build` of the entries' packages. Set `EXODUS_STASIS_DEBUG=1` to have `stasis
bundle` print the resolved features per package and context (target, host), and
which resolution they come from.

`stasis bundle --cargo-manifests` also carries what describes each bundled
package's build, as `--package-json` carries npm manifests. For a package of the
project (the root package, a workspace member, a path dependency): its
`Cargo.toml` and the workspace `Cargo.toml` above it, and the build's
`Cargo.lock` and cargo configs: the lockfile of the entries' workspace (or of
their package, outside any) and the configs cargo reads when run in the entries'
package's directory (see above; `.cargo/config` before `.cargo/config.toml`)
that lie inside the bundle root, not a path dependency's own lockfile or
config. For a vendored crate: its `Cargo.toml` and the `.cargo-checksum.json`
cargo checks its files against, not the lock and config it was published with.
All are `resource` files in their package's bucket, or the workspace bucket for
the root-level ones.

A vendored file the bundle reads is checked against that checksum list in any
case, as is the `Cargo.toml` of every vendored crate the bundle or its
resolution takes in: one changed since `cargo vendor` stops the bundle, as does
a vendored crate the bundle reads whose package checksum isn't the one
`Cargo.lock` locks its version with (in the replay too).

The manifests are carried unedited, so whatever they hold (a `[registries]`
token or `[http]` proxy in the cargo config, the credentials in a `git = …` URL
or a lockfile's `source = "git+https://…"`) is in the bundle too. Keep registry
tokens in `~/.cargo/credentials.toml` or the environment
(`CARGO_REGISTRIES_<NAME>_TOKEN`) rather than in these files, or don't pass
`--cargo-manifests`. A file that isn't UTF-8 text is refused, not altered. With
`--cargo-manifests`, each package's build script (`[package] build = "…"`, else
`build.rs` beside the manifest; `build = false` means none) is walked like a
crate root of its own, compiled for the host, so its modules and the in-tree
`[build-dependencies]` it reaches (and their build scripts, in turn) come along
as Rust code. Nothing runs.

A vendored crate (one under the `vendor/` directory) is held to its own package
directory: an `include!`/`include_str!`/`include_bytes!`, a `#[path = …]` or a
`build = "…"` in it that reaches outside (`include_str!("../../../.git/config")`,
`concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env")`, an inline module's
`#[path = "../../.."]`) is refused with a warning; the project's own code may
include anything under the bundle root. The check follows symlinks: a file of a
vendored crate that really lies outside its package (a link to the project's
`.env`, a linked directory of modules, a linked manifest) is refused too, as is
a `[lib] path` outside the package.

The root packages' features follow the same flags as `cargo build`, in either
mode: `--cargo-features=a,b` (repeatable; `x/feat` is a feature of the entries'
package named `x`, else of their dependency `x`, cargo's `dep/feat` form; a name
that matches neither stops the build), `--cargo-no-default-features`,
`--cargo-all-features`. Without them, the roots get their `default` feature. For
a `workspace = true` dependency the workspace entry decides `default-features`:
a member's `false` is ignored unless the workspace disabled them too, as cargo
warns.

Rust edge specs are:

- the path as written (`crate::net::client::Client`, `super::config::Config`, a
  `use crate::{a::B, c::D}` group flattened to one edge per path);
- `mod <name>` for a module file (`mod outer::inner` when declared inside inline
  module `outer`);
- `use <crate>` for a crate root;
- `include <path>`, `include_str <path>` and `include_bytes <path>` for the file
  an include macro names with a literal: a plain string with its escapes read
  (`"a \"b\".txt"`), a raw string (`r#"…"#`), or
  `concat!(env!("CARGO_MANIFEST_DIR"), "/…")`, the one `concat!` form the
  loader can read, relative to the package root, inside a `#[doc = …]`
  attribute as much as in an expression. Anything else, build output under
  `concat!(env!("OUT_DIR"), …)` included, can't be followed, and is warned about
  unless it is `OUT_DIR`;
- `<name>!` for a `macro_rules!` defined in another file (below).

`include!` splices Rust source, carried and scanned as a file of its own; the
other two carry an asset as `resource` / `resource:base64`, each relative to the
including file. Rust source (a module, an `include!`d file, a build script) and
an `include_str!` file are UTF-8 text, as rustc requires: one that isn't stops
the build, naming the file, never carried with its bytes replaced; an
`include_bytes!` file is any bytes, carried as `resource:base64` when it isn't
UTF-8. A file one place names with `mod` or `include!` and another with
`include_str!` is Rust: scanned and followed, never a resource.

An include written inside a `macro_rules!` body resolves relative to each file
that invokes the macro, through the macros whose bodies invoke it, at the
outermost call (the edge is that file's, at the invocation, by bare name or by
path). The bare macro calls a body makes are made and resolved where it is
invoked too: the body's own, even past a `macro_rules!` it defines inside,
whose own includes and calls are its own, made where it is invoked in turn.

`<name>!` marks a `macro_rules!` defined in another file the invocation can see.
By bare name, it can see what is in textual scope, as in rustc:

- the files above it in the module tree, each up to the `mod` that mounts the
  next (a macro defined after `mod early;` is not early.rs's);
- what a `#[macro_use] mod` hands the file mounting it, from that `mod` on
  (tokio's `ready!` through `#[macro_use] mod macros;`; a nested
  `#[macro_use]` reaches its own parent, not the crate);
- the later definition of a name shadowing the earlier in source order,
  whichever kind each is (serde's `tri!`, defined by its root's `crate_root!()`
  after `#[macro_use] mod crate_root;`, is the root's), as far as each call (a
  `macro_rules!` written after a call doesn't reach it);
- a `macro_rules!` a macro's body declares, standing where that macro is first
  invoked in the file, and a `mod` it declares at the invocation in each file
  hosting it (see above: serde's `crate_root!`, declared in
  core/crate_root.rs and invoked in lib.rs after `#[macro_use] mod macros;`, so
  `de` sees `forward_to_deserialize_any!`);
- in the crate root's file, whose items they are, the `#[macro_export]`ed ones.

By path, it goes through the module's imports (`use
crate::combinator::dispatch;`, a `use super::*` from the root), into another
crate too (`use dep::mac;` or an alias of it, a prelude's `pub use dep::mac;`
behind a glob; the macro is in the file defining it). A crate root's
`#[macro_use] extern crate dep;` brings dep's exported macros to every module;
`dep::mac!(…)` has an edge to that file beside the crate's. Another crate's
macro is the one its root names, resolved as a path there is: each definition
under its file's cfgs, judged by that crate's own build (serde's docsrs-only
copies of serde_core's macros give way to its `pub use
serde_core::forward_to_deserialize_any`, followed on into serde_core), and
per-platform definitions a cfg-keyed map. A path's lead is the crate even where
the module imports a macro of the same name (`use helper::{helper, mk}`: `mk!`
is helper's). A `macro_rules!` in a sibling file is otherwise out of scope.

A file whose inner `#![cfg(…)]` can never hold is carried but compiled empty, so
nothing in it is followed (a `#![cfg]` inside a macro invocation's body gates
nothing). A `mod` whose files vary by cfg (`#[cfg_attr(<pred>, path = …)]`
variants, or same-name declarations under exclusive `#[cfg(<pred>)]`s:
`#[cfg(unix)] #[path = "u.rs"] mod sys;` beside `#[cfg(windows)] #[path =
"w.rs"] mod sys;`, or the `if #[cfg(unix)] { … }` branches of a `cfg_if!`, each
later branch keyed by the earlier cfgs not holding: `all(not(unix), windows)`,
`all(not(unix), not(windows))`) records a `{ <pred>: file, …, "*": <default
file> }` map, the same shape as a JS edge that diverges per Metro platform; when
every predicate names one file (libc's `mod primitives` under a dozen) the edge
is that file. A declaration a gate macro emits (tokio's `cfg_has_atomic_u64! {
mod imp; }` beside `cfg_not_has_atomic_u64! { mod imp; }`) is keyed by the macro
(`cfg_has_atomic_u64!`), whose definition's cfg decides between them; a second
file under an already used key gets it numbered (`*#2`) rather than dropped.

A `use` is an import only when a use tree follows it: the word in macro input
(syn's `Token![use]`) or a tree interpolating a metavariable (`use #path as
_serde;` in a `quote!`) is not one. The body of a `quote!`, `quote_spanned!`,
`parse_quote!` or `parse_quote_spanned!` is a token template for another crate's
code and is skipped whole, unless the package defines a `macro_rules!` of that
name itself, in whichever of its files (syn's `parse_quote!`): then it is that
macro's input like any other, while the files are read from disk too, so a
`mod` such a body declares is found whichever file the walk meets first.

## `.stasis.tgz`

A gzipped tar of a `stasis.lock.json` at its top and exactly the files it
attests (what `tar -czf` makes of what `stasis extract --lock=add` writes),
named `stasis.tgz` or `<name>.stasis.tgz`. `stasis bundle` and `stasis
github-bundle` write one with `--format=tgz` or an `--output` so named (`stasis
run` writes none). `stasis validate`, `run` (`--bundle=load` or `frozen`),
`build`, `audit`, `diff` and `sbom` read it as the bundle of its files, with
its lockfile beside it; a tgz under any other name (by gzip's leading bytes),
and anything else under its name, is refused. Its tar is read with
`@preventive/archive`, and it is refused, naming the path, unless it holds:

- each file the lockfile attests, at its path from the tgz's top, with the
  bytes of its integrity and the execute bit it attests (any of `0o111`);
- no other file, nor a symlink, hard link or device: only directories besides;
- its files as `stasis build` reads a lockfile's (code as UTF-8), held to the
  rules a `stasis.code.br` parses by: no content for a payload-free `stat:*`
  record, no file no bundle may carry (a `.npmrc`, say);
- no byte past the gzip stream, nor past the tar's end marker, but zero
  padding. A second gzip member is read on into, as gzip(1) does.

A `stasis.lock.json` in a subdirectory (npm's `package/`) is not at its top.
Its lockfile may record a `stat:*` record but no `directory` capture (a `stasis
run --fs` capture of a `readdir`): one that does is refused, whatever the tar
holds at its path.

In `@exodus/stasis-core/bundle`, `Bundle.fromTar(entries, { integrityOf })`
applies these rules to an unpacked tar: `entries` as `@preventive/archive`'s
`unpack` gives them (`{ name, type, mode, data }`), and `integrityOf(bytes)` the
SRI sha512 each file is held to (`state-util`'s `sha512integrity`); it imports
no gzip or tar reader and no Node builtin. It builds the bundle with
`Bundle.fromLockfile(lockfile, { read, integrityOf })`: the bundle of a
lockfile's files as `read(file)` reads them, of the repository it records, as
`stasis build` reads a lockfile's from disk. `bundle.toTar({ integrityOf })` is
the inverse: the entries to pack (`{ name, mode, data }`, as
`@preventive/archive`'s `pack` takes them), the lockfile of its files at the
top, recording its repository, then each file, an executable one `0o755`. A tgz
carries no `reason` or `package`, as a lockfile records neither. A bundle
recording a `directory` capture can't be written as a tgz, by `stasis bundle
--format=tgz` or anything else. A `stat:*` record is carried, in its lockfile
alone.

## Resources in the bundle

Resources (images, fonts, any non-code file a build references) live in
`stasis.code.br` beside code, in the usual `sources`/`modules` buckets, tagged in
`formats` by payload encoding:

- `resource` — valid UTF-8, stored raw (human-readable; e.g. SVG).
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

In the lockfile a resource is hashed like any other file (sha512 of its raw bytes)
and carries the same `formats` tag, so a frozen run verifies it byte-for-byte.

## Executable files

Both the lockfile and the bundle carry an `executable` array: the project-relative
paths of the **recorded files** whose on-disk mode had any POSIX execute bit
(`0o111`) when they were captured. Sorted by the same `sortPaths` rule as
`entries`, and **omitted when empty**.

```json
{ "executable": ["scripts/build.sh", "node_modules/dep/bin/cli.js"] }
```

Two rules are enforced at both `serialize`, naming the offending path, and
`parse`:

1. **`executable` is a subset of the artifact's files.** An entry for anything
   else is malformed.
2. **A non-full scope lists only `node_modules` files.** A workspace path in a
   `scope = node_modules` artifact is rejected.

- Files only: an entry naming a `directory` capture or a `stat:*` record is
  rejected, as is a duplicate.
- Ignored on a legacy `version: 0` bundle: no bit is granted.
- The bit is read from disk at capture, from a **regular file**, following
  symlinks (a link records its target's mode). A path that can't be stat'd is
  unknown, not "not executable": it never clears a recorded bit.
- Disk wins on re-capture: re-reading a file under `lock = add` / `bundle = add`
  refreshes its bit, dropping the entry of a file that has since lost it, with
  no `--lock=replace` needed. A file carried over from an existing artifact and
  never re-read keeps its entry unverified.
- **Windows records none and clears none**: a capture there adds no entry and
  strips none a POSIX capture recorded.
- Merging two artifacts (`stasis add`, `stasis bundle --add`) unions the lists,
  except that the **incoming** artifact wins for the files it records:
  re-adding a file that lost its bit clears its entry.
- `stasis diff` reports execute-bit changes, even on byte-identical files.
- `stasis extract` restores the bit; see [extract.md](extract.md). It is
  metadata, **not** part of what `lock = frozen` / `bundle = frozen` verify: an
  artifact predating the field still loads, and a mode-only change is not a
  hash mismatch.

> [!NOTE]
> The bit reflects the tree on disk, so it depends on how that tree got there.
> npm/pnpm preserve the modes in a package tarball, but git tracks only
> `100644`/`100755`, and `core.fileMode=false`, zip/`git archive` round-trips,
> and `COPY`/`tar` without mode preservation flatten it: two checkouts of one
> commit can produce different `executable` arrays.

## Filesystem captures (`stasis run --fs=sync` / `--fs=async`)

`--fs` also patches explicit `fs` calls, so a program's own reads, and the kind
(file or directory) of each path it stats, are recorded into the bundle
(`--bundle=add|replace`) and served back (`--bundle=load`). The load run needs
the same `--fs` flag; an uncaptured read falls through to disk. It can also be
set as `"fs": "sync" | "async"` in `stasis.config.json` (or `EXODUS_STASIS_FS`),
and requires a bundle mode of `add`, `replace` or `load`.

| Patched call (sync forms) | Captured as | Load behavior |
| --- | --- | --- |
| `readFileSync` | file bytes (see below) | serves bytes |
| `readdirSync` (no options) | `directory` — sorted JSON name array | serves listing |
| `lstatSync` / `statSync` (no options) | payload-free `stat:file` / `stat:directory` | answers kind |
| `existsSync` / `accessSync` / `realpathSync` | **not captured** (serve-only) | serves if path already carried |

`--fs=sync` patches the sync forms above; `--fs=async` also patches the callback
forms (`readFile`/`readdir`/`lstat`/`stat`/`access`/`realpath`) and the promise
forms `fs.promises.*` (`node:fs/promises`), each recording and serving as its
sync form does; a served callback is always invoked asynchronously. A bundle
captured in either mode loads in either. Not patched: streams, `fs.opendir`,
`fs.readlink`, the deprecated callback `fs.exists`.

Captures live in the usual `sources`/`modules` buckets, tagged in `formats`.

**`readFileSync`** is stored by extension: a recognized code extension
(`.json`/`.mjs`/`.cjs`/`.mts`/`.cts`/`.js`/`.ts`) with UTF-8 bytes keeps its Node
loader format; anything else (or non-UTF-8 bytes) is
`resource`/`resource:base64`. A file both imported and read is one entry. The
optional encoding argument (string or `{ encoding }`) is honored when serving;
an invalid encoding throws as fs does.

**`readdirSync`** stores a single-argument call as a sorted, JSON-serialized
`directory`, so a `--bundle=load` run sees sorted names where capture saw OS
order. Calls with options (`encoding`, `withFileTypes`, `recursive`) pass
through untouched. A listing captured at a package bucket root sits at the
bucket's own key: rel `''` in its `files`, format keyed at the bucket dir (`.`
for the project root).

**`lstatSync`/`statSync`** record a single-argument call's **kind** only. The
real call runs first (the program gets the genuine `Stats` and errors); the
kind is stored as a **payload-free** `stat:file`/`stat:directory`, with no
bytes, hash or `files` entry. A bundle that carries content for a path its
`formats` records as `stat:*` fails to parse, so `stasis extract`, `stasis
validate` and `stasis run` refuse it whole, `stasis build` refuses a lockfile
attesting a file for such a path, and no such bundle is written. Only regular
files and directories are recorded: a symlink (under `lstat`), socket or FIFO
records nothing; a `statSync` through an in-root symlink records the
*target's* kind, keyed at the requested path. A path already carried as
content, or whose real location escapes the root, gets no stat record; reading
a stat-only path later (same run or a `lock=add`/`bundle=add` re-run) upgrades
its stat record to a content record. On load, `.isFile()`/`.isDirectory()`
answer from the bundle for any carried path: a recorded file, `directory`, stat
record, or an ancestor directory of a recorded path (a bundled
`node_modules/dep/index.js` makes `node_modules` and `node_modules/dep`
directories). Other `Stats` fields are the real stat's while the file is on
disk, else synthetic defaults (`0`/epoch/a file-or-directory `mode`).
Uncarried paths and calls with options (`bigint`, `throwIfNoEntry`) pass through
untouched.

**`existsSync`/`accessSync`/`realpathSync`** (and the async `access`/`realpath`
and `fs.promises.*` forms) are served for a carried path and otherwise passed
through. They are **never captured**: a file only probed isn't in the bundle,
and its probe falls through to disk on load, but a path the program also
`lstat`s or `stat`s gets a stat record they answer from. `existsSync` answers
`true`/`false`; `accessSync` serves a carried path **read-only** (`F_OK`/`R_OK`
succeed; `W_OK`/`X_OK` defer to the real fs); `realpathSync` returns the real
symlink-resolved path while the file is on disk, else the **lexically**
resolved request path. The `.native` variant is covered.

> [!NOTE]
> Build tools check a file *before* reading it: e.g. `@babel/core`
> `fs.existsSync`s and realpath-canonicalizes `babel.config.js` before
> `require()`ing it — so an unserved probe makes a bundled-but-absent config read
> as missing (Babel then silently runs with no config).

Source-map sidecars (`*.map`) are **non-existent** under `--fs`, in capture and
load and whatever the bundle mode: never captured or served, an `ENOENT` to
`readFileSync`/`readFile`, `statSync`/`lstatSync`, `accessSync`/`realpathSync`,
and `false` from `existsSync`. To capture a `.map` as data instead, add `map` to
the `resources` allowlist; a `.map` in the bundle is served on load even if that
run omits `--resources=map`.

Content captures are hashed like any content (a `directory`'s integrity is the
sha512 of its JSON text), so a frozen run verifies them; a stat record has no
content, and its `formats` entry is cross-checked between bundle and lockfile
like every other format.

When a bundler plugin runs with its own `bundleFile` (a *sidecar*), a read the
sidecar already attests is skipped in the main bundle at capture and served from
the sidecar at load.

## Discovery

Stasis walks up from the run's cwd looking for `package.json`, stopping at a
`.git` dir, `pnpm-workspace.yaml`, or `$PROJECT_CWD`. Any of the three stasis
files in a directory without a sibling `package.json` is fatal, and they may
appear in only one directory along the path.
