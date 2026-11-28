# `stasis github-bundle`

`stasis github-bundle` builds the bundle `stasis bundle` would build of a
cloned and installed GitHub repository, without cloning or installing: the
tree is fetched at a commit, and dependencies are laid out in memory from the
lockfile alone. No package script runs, and nothing of the repository executes.

So a workspace package's `tsc` outputs (`dist/`) are missing: with
[`--typescript`](bundle.md#typescript---typescript), an import of one resolves
to its source by the package's `tsconfig.json` `outDir` and `rootDir`, and a JS
build without it that would be [broken at load](bundle.md#resolution) by an
import only it resolves is built with it.

```sh
stasis github-bundle (owner/name[/path]|--github=owner/name [--directory=path]) [--sha=commit [--branch=name]|--tag=name|--branch=name] [--package-manager=(pnpm|yarn1|npm|soldeer) [--package-manager-version=version]] [--no-lazy] [--generate=prisma|--no-generate] [--lockfile=path/to/stasis.lock.json] [--lockfile-only] [--format=(br|tgz)] [--output=(path|-)] [stasis bundle's options for the entries] [path/in/repo/to/(file.(js|ts|jsx|tsx)|file.sol|dir) ...]
```

| Flag | Meaning |
| - | - |
| `owner/name[/path]` | The repository, as the first non-option argument, optionally with a directory in it (as `--directory=path`) or a file, see [A file's project](#a-files-project). Not with `--github` or `--directory`. |
| `--github=owner/name` | The repository, instead of `owner/name[/path]`. Fetched with `GITHUB_TOKEN` if set. |
| `--sha=commit` / `--tag=name` | The commit to bundle, or the tag naming it; not both. Default: the default branch's head. A `--sha` commit must be in the history of one of the repo's own branches or tags, as in [`stasis validate`](validate.md#the-commit), else it is refused before anything is fetched. |
| `--branch=name` | The branch whose head to bundle. With `--sha`, the commit's branch, see [A commit's branch](#a-commits-branch---branch). Not with `--tag`. |
| `--directory=path` | With `--github` only: a directory in the repo to bundle. The entries, the lockfile and the bundle's paths are its. |
| `--package-manager` | `pnpm`, `yarn1`, `npm`, or `soldeer` (for `.sol` entries). Default: the one whose lockfile installs the directory, if only one does; or one tree for each of its `stasis.config.json` [`lockfiles`](#several-lockfiles-lockfiles), with which the flag is refused. |
| `--package-manager-version` | With `--package-manager` only: the version whose layout to reproduce. Otherwise the root `package.json`'s `packageManager` pin, else pnpm 10.33.4, yarn 1.22.22, npm 11.21.0 (never pinned by `packageManager`) or Soldeer 0.12.0. |
| `--no-lazy` | Fetch and unpack every package the tree installs before the build. Without it, a pnpm or npm tree is lazy, see [Lazy](#lazy---no-lazy). |
| `--generate=prisma` / `--no-generate` | Generate every project's Prisma Client first, warning of what can't be generated; or none. Without either, those of the projects the entries reach are generated, silently. See [Prisma](#prisma). |
| `--lockfile=path` | The [local lockfile](#local-lockfile) of a JS bundle, instead of the default name. Written if missing, as by [`stasis bundle --lockfile`](bundle.md#companion-lockfile---lockfile). |
| `--lockfile-only` | Write only the [local lockfile](#local-lockfile), as [`stasis bundle --lockfile-only`](bundle.md#companion-lockfile---lockfile) does. Not with `--output` or `--brotli-quality`; refused before anything is fetched. |
| `--output` / `-o` | Where to write. Default: a name after the repo and commit, see [Output](#output). `-` streams to stdout. |
| `--format=(br\|tgz)` | Write a `stasis.code.br` (`br`) or a [`.stasis.tgz`](file-formats.md#stasistgz) (`tgz`). Default: from `--output`'s name, `tgz` for `stasis.tgz` or `<name>.stasis.tgz`, else `br`. Refused if it disagrees with `--output`'s name, with `--brotli-quality` for a tgz, or with `--lockfile-only`. |
| [`stasis bundle`'s options](bundle.md) | For the entries: `--conditions`, `--mainFields`, `--metro --platforms`, `--jsx`, `--flow`, `--typescript`, `--tsconfig`, `--resources`, `--define`, `--package-json`, `--scope`, `--brotli-quality`, and `--mapping`/`--manifests` for Solidity. Not `--metro-resolver`, `--cargo*` or `--add`. |

```sh
stasis github-bundle --github=owner/name --sha=0123abc src/index.js
stasis github-bundle --github=owner/name --tag=v1.2.0 --directory=packages/api --typescript src/index.ts
stasis github-bundle owner/name/packages/api --tag=v1.2.0 --typescript src/index.ts
stasis github-bundle owner/name/packages/api/src/index.ts --tag=v1.2.0 --typescript
stasis github-bundle 'owner/name/packages/api/src/*.entry.ts' --tag=v1.2.0 --typescript
stasis github-bundle --github=owner/name --package-manager=soldeer src/Token.sol
stasis github-bundle --github=owner/name --sha=0123abc --branch=release/1.2 src/index.js
```

### A commit's branch (`--branch`)

A `--sha` commit is looked for as in [The commit](validate.md#the-commit),
which compares at most 100 other branches, so in a repo with more it may not be
found. `--branch=name` names its branch, checked first, with nothing listed. If
the repo has no such branch, or it hasn't the commit (deleted or force-pushed
since), the commit is searched for as without `--branch`, so a fork's commit is
still refused.

## Dependencies

The tree is fetched and checked against its git tree id. Dependencies are laid
out as the package manager would install them with scripts off:

| `--package-manager` | Lays out as | Versions reproduced |
| - | - | - |
| `pnpm` | `pnpm install --frozen-lockfile --ignore-scripts` | pnpm 10, 11 or 12 |
| `yarn1` | `yarn install --frozen-lockfile --ignore-scripts` | yarn 1.22 |
| `npm` | `npm ci --ignore-scripts` | npm 10.9.3 to 10.9.9, or 11.11.1 to 11.21.0 |
| `soldeer` | `soldeer install` | Soldeer 0.12 |

devDependencies are included unless
[`installDevDependencies`](#devdependencies-installdevdependencies) is `false`.

The layout is for no Node version in particular: each package's `engines.node`
and the root's `devEngines.runtime` accept any Node, `engine-strict` or not, and
no optional package is left out for its `engines.node`, though pnpm still lays
the tree out for a `nodeVersion` in the repo's pnpm settings. It is for this
machine's os, cpu and libc: an optional package of another platform is left
out.

Every tarball and zip is checked against the lockfile, and so is each npm
package's registry version document, fetched for the commit it was published
from (`gitHead`), which its `repo` records: like everything in `repo` (see
[file formats](file-formats.md)), the publisher's word, checked against no
repository. A Soldeer git dependency on GitHub is fetched as the repo is. All
of it is cached in the user cache directory, as for
[audit](audit.md#repository-advisories).

A private (scoped) npm package is fetched with the first set of
`PREVENTIVE_MEASURES_NPM_TOKEN`, `STASIS_NPM_TOKEN` and `NPM_TOKEN`, else with
the npm registry token from the last `~/.npmrc` line that is exactly
`//registry.npmjs.org/:_authToken=npm_…`. Another registry's token, or one
written any other way (`${NPM_TOKEN}`, quoted, with spaces), is not read; a
`~/.npmrc` that is not valid UTF-8 is refused.

### Several lockfiles (`lockfiles`)

Where the bundled directory's `stasis.config.json` names `lockfiles`, none is
detected: a tree is laid out from each, and the build reads the project through
all of them at once, each entry built from the tree that installs it, so JS and
Solidity entries are bundled together:

```json
{ "lockfiles": ["pnpm-lock.yaml", "tools/package-lock.json", "contracts/soldeer.lock"] }
```

- Each path, from the config's directory, may climb (`../../pnpm-lock.yaml`),
  not out of the repo.
- Each is laid out from its own directory, which must be one its package
  manager installs from, or, if the bundled directory is in it, the one it
  installs that directory from: a `pnpm-lock.yaml` in a workspace member, which
  pnpm installs from the workspace root, is refused.
- No two may install the same directory, or one inside another's (a
  `pnpm-lock.yaml` with a `package-lock.json` beside it, or a lockfile of a
  project in another's workspace). Every refusal comes before anything is
  fetched.
- A lockfile no tree is laid out of (a `Podfile.lock`, say) is refused.
- A single lockfile acts as the detected one would, so it can choose between
  two package managers' lockfiles that both install the directory, which
  detection refuses.
- Each tree reproduces the version its own root `package.json` pins, else the
  default.
- A `.sol` entry is built from the root of the innermost Soldeer project a
  `soldeer.lock` lays out holding it (`contracts/` for
  `contracts/soldeer.lock`), reading the `foundry.toml` and remappings there,
  its paths put under that root; one in none of them, from the config's
  directory.

Without [entries](#entries) given or in the config, they are those of the kind
its lockfiles' package managers build, or none if they build both JS and
Solidity.

### devDependencies (`installDevDependencies`)

Where the bundled directory's `stasis.config.json` sets `installDevDependencies`
to `false`, the tree is laid out as a production install:

```json
{ "installDevDependencies": false }
```

| `--package-manager` | Lays out as |
| - | - |
| `pnpm` | `pnpm install --frozen-lockfile --ignore-scripts --prod` |
| `yarn1` | `yarn install --frozen-lockfile --ignore-scripts --production` |
| `npm` | `npm ci --ignore-scripts --omit=dev` |
| `soldeer` | `soldeer install` (Soldeer has no devDependencies) |

A package only devDependencies reach is left out, so a build that reaches one
fails to resolve it. Every workspace's devDependencies are left out, not only
the directory's. With pnpm and npm, a left-out package is never fetched; yarn 1
still fetches and checks the root's devDependencies, which still take the
places they would be hoisted to, as with yarn's `--production`. `true`, the
default, installs them.

Only this setting does it: the project's own (`.npmrc`'s `omit`, `production`
or `only`, `.yarnrc`'s `--production`) stay refused.

### `.yarnclean`

A `.yarnclean` in the bundled directory, or any directory above it in the repo,
cleans the laid-out `node_modules` as
[`yarn autoclean`](https://classic.yarnpkg.com/en/docs/cli/autoclean) would,
whatever the package manager:

```
# tests and docs
test
__tests__
docs
*.md
!lodash/README.md
```

Each line is a pattern of paths to remove (a directory with everything below
it); a line starting `!` is of paths to keep (a directory holding one keeps only
that); a line starting `#` is a comment. A path matches by its name, or by its
path from the `node_modules` holding its package (`lodash/README.md`, in pnpm's
`.pnpm` store too), case-insensitively, dotfiles included, as in Yarn 1.22. The
package manager's own entries (`.bin`, `.pnpm`, `.modules.yaml`) never match. A
cleaned file is missing to the build.

Matching needs the optional `minimatch`: without it, a `.yarnclean` holding a
pattern is refused before any package is fetched.

### Lazy (`--no-lazy`)

pnpm and npm trees are lazy: laid out from the lockfile with nothing fetched,
not even a version document. A package is fetched and unpacked, with its
`package.json`'s dependencies but not theirs, once the build reads anything in
it, if only to resolve an import into it. Any other is never fetched, unless
deptree needs it to lay out another as the full tree has it. The bundle and
lockfile are byte for byte those of the full tree.

```sh
stasis github-bundle --github=owner/name src/index.js            # lazy
stasis github-bundle --github=owner/name --no-lazy src/index.js  # every package fetched first
```

With `EXODUS_STASIS_DEBUG=1`, each step is logged to stderr with its time,
and each round of a lazy build with the packages it asks for:

```text
[stasis] Lazy round 3: built in 1.05 s (files 492 parsed, 164 resolved, 4221 replayed; scan 0.20 s, Metro's additions 0.09 s, configs and toolchain 0.76 s), asked for 40 packages: color-name, ee-first, concat-map, balanced-match, regjsgen, …
[stasis] Lazy round 3: unpacked in 0.17 s
```

Each unpacked package is checked against the lockfile, so a broken tarball the
build reaches is refused; one it never reaches is not, fetched or not, unless
with `--no-lazy`.

These are always fetched and unpacked first, as with `--no-lazy`: yarn 1 and
Soldeer trees, a pnpm or npm tree under a [`.yarnclean`](#yarnclean) that keeps
paths with `!`, and the tree of a directory whose `stasis.config.json` sets
`lazyDependencies` to `false`:

```json
{ "lazyDependencies": false }
```

## Entries

Entries are paths in `--directory`, or in the repo. Without any (and no file
given as `owner/name/path`), they are the directory's `stasis.config.json`
[`entries`](bundle.md#entry-options-stasisconfigjson), if it has `entries`, with
no fallback, so an empty one is refused. Else:

- a JS bundle takes the JS files the directory's `package.json` names (`main`,
  each subpath of `exports`, each `bin`), resolved as the build resolves them;
  or, if it names none, the directory's `next.config.*` (the first of `.js`,
  `.mjs`, `.ts` and `.mts`), standing for its
  [Next.js app's files](bundle.md#nextjs-apps-nextconfig);
- a Soldeer bundle takes its `.sol` files directly in it, under `contracts/`,
  and under its source directory (`foundry.toml`'s `src`, else `src/`), but not
  its tests, scripts, mocks, or dependency and build directories.

Entries named in `stasis.config.json`'s `entries`, given or taken by default,
are built with their options there, as in
[`stasis bundle`](bundle.md#entry-options-stasisconfigjson). With such a
config:

- An option given must be the one each entry is built with there, or the build
  is refused (`--platforms=ios` for an entry built with
  `--platforms=ios,android`); one left out keeps each entry's own.
- A `--define` given must match the config's own
  [`define`](bundle.md#defines---define), or the build is refused.
- An entry setting `babel`, `metro-resolver`, `cargo` or `cargo-target` is
  refused, whatever the flags, as each runs a program.
- The config's `allowedPaths`, `disallowedPaths`, `allowedModules` and
  `disallowedModules` (see
  [Allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules))
  also apply to a bundle of entries it doesn't name, and its
  [`excludeModules`](file-formats.md#excluded-modules) to every build.

### A file's project

A file given as `owner/name/path/to/file` is bundled from the nearest directory
at or above it holding a `package.json` (for a `.sol` file, a `foundry.toml` or
`soldeer.toml`), else from the repo root. That directory is the `--directory`
and the file its first entry; any other entries given are relative to it too:

```sh
# Where packages/api has a package.json and src/ has none: as
# stasis github-bundle --github=owner/name --directory=packages/api src/index.js src/worker.js
stasis github-bundle owner/name/packages/api/src/index.js src/worker.js
```

A path that is not a file in the commit's tree, or is a symlink or under one,
is taken as a directory.

## Extra files

Files named in `stasis.config.json`'s [`extra`](file-formats.md#stasisconfigjson)
are bundled from the commit's tree as [`stasis bundle`](bundle.md) bundles them
from a checkout, globs and `!` entries included:

```json
{ "extra": ["ios", "ios/.xcode.env", "!ios/build", "!ios/Pods", "!ios/*.xcodeproj/project.xcworkspace", "!ios/fastlane/*.{md,xml}"] }
```

The tree is globbed by Node's own `fs.globSync` and `path.matchesGlob`, on the
`minimatch` they are built on, always case-sensitively. A
[glob pattern](bundle.md#entry-patterns) in the config's `entries` is globbed
the same way. So both need `minimatch`, an optional dependency of
`@exodus/stasis` that `stasis bundle` and `stasis run` don't use: without it,
an `extra` naming anything, even the config itself (see
[`extra`](file-formats.md#stasisconfigjson)), is refused.

## Roots and paths

The bundle's paths, and the directory its `repo` names (see
[file formats](file-formats.md)), are `--directory`'s. For a JS bundle they are
those of the innermost package at or above it holding every bundled file: the
project root, if a file is outside it (in a sibling workspace package or the
root's `node_modules`, say).

## Output

By default the bundle is written to `owner-name.<commit's first 7>.stasis.code.br`,
or `owner-name.<directory>.<commit's first 7>.stasis.code.br` with
`--directory` (or one from `owner/name/path`), its `/` replaced by `-`. Each
character outside `[A-Za-z0-9._-]` becomes `_`, and a directory too long for a
255-character name is cut, with a hash of it appended. With `--format=tgz` it
is a [`.stasis.tgz`](file-formats.md#stasistgz), named `….stasis.tgz` likewise.
On stderr it reports what it unpacked and fetched, then what it bundled:

```text
[stasis] Unpacked 412 of 836 packages: 41210 files, 289.3 MiB, 430 tarballs fetched
[stasis] Bundled 6591 files in 346 packages from owner/name@0123456789abcdef0123456789abcdef01234567 to owner-name.0123456.stasis.code.br
```

A JS build is checked against the repository root's `stasis.lock.json` by its
lock mode, as by [`stasis bundle`](bundle.md#companion-lockfile---lockfile)
(`frozen` if present, unless `EXODUS_STASIS_LOCK` gives another), and against
the [local lockfile](#local-lockfile).

## Local lockfile

The local lockfile is at `--lockfile`'s path, else the bundle's default name
with `.stasis.lock.json` for `.stasis.code.br`, whatever `--output` says:
`owner-name[.<directory>].<commit's first 7>.stasis.lock.json` in the working
directory. Its name carries the commit, so a build of another commit isn't
checked against it.

If it's missing, `--lockfile` and `--lockfile-only` write it; without either,
nothing is written. If present, a JS build is checked against it by the lock
mode `EXODUS_STASIS_LOCK` gives, `frozen` by default:

| Mode | Behavior |
| - | - |
| `frozen` (default) | It must agree with the build on every file both record, and attest every file built. It is left unchanged: `--lockfile` and `--lockfile-only` write nothing. |
| `add` | It must agree with the build on every file both record. `--lockfile` and `--lockfile-only` write the one built over it. |
| `replace` | It isn't read. `--lockfile` and `--lockfile-only` write the one built over it. |
| `ignore` | It isn't read. `--lockfile` and `--lockfile-only` are refused, there or not. |
| `none` | It must not be there. `--lockfile` and `--lockfile-only` are refused, there or not. |

A refused build writes nothing. A build checked against it says so on stderr,
before what it bundled or locked:

```sh
stasis github-bundle owner/name/packages/app --lockfile-only   # writes owner-name.packages-app.0123456.stasis.lock.json alone
stasis github-bundle owner/name/packages/app                   # the bundle, checked against it: same commit, frozen
EXODUS_STASIS_LOCK=replace stasis github-bundle owner/name/packages/app --lockfile-only   # writes it anew
```

```text
[stasis] Held 6591 files in 346 packages from owner/name@0123456789abcdef0123456789abcdef01234567/packages/app to owner-name.packages-app.0123456.stasis.lock.json
```

Only the environment sets the mode: a repository's `stasis.config.json`
pinning `lock: frozen` pins its own `stasis.lock.json`, not the local one.
Unlike with `stasis bundle` under `frozen`, the bundle isn't loaded beside it.

The lockfile it writes records the repository, commit and directory in its
[`repo`](file-formats.md#stasislockjson), so [`stasis validate`](validate.md)
validates it with no `--github` or `--sha`. A local lockfile's `repo` must
match the build's in each field it records (`github` case-insensitively), or
the build is refused:

```text
owner-name.0123456.stasis.lock.json records the repo owner/name@<another commit>, and the build is of owner/name@0123456789abcdef0123456789abcdef01234567
```

One recording none is still checked. A `repo` in the repository's committed
`stasis.lock.json` is ignored.

## Prisma

For each project whose schema has a `prisma-client` generator, a JS bundle
first writes the Prisma Client its `prisma generate` would write, byte for
byte, at the generator's `output`, and carries it like any other source. The
schema is the one the project's Prisma config names (as a string literal, or a
`path.join` of them), else `schema.prisma` or `prisma/schema.prisma`.

Nothing of the repo runs: the schema, the config's `schema` path, and the
`tsconfig.json` and `package.json` the generator reads are read as data, and
the project's installed `prisma` only for its version (and, for an edge
runtime's client, the query compiler it ships). The client is generated by the
optional `@prisma/client-generator-ts` 7.10.0 peer dependency and rewritten as
the installed version writes it: Prisma 7.4.0 to 7.10.0, its `prisma`, or
beside Prisma 8, the one its `@prisma/prisma7` runs. Other generators
(`prisma-client-js`, Pothos's `prisma-pothos-types`, ...) are not run. A panic
of Prisma's schema engine refuses the schema being read.
[`stasis validate`](validate.md#generated-prisma-clients) checks the clients a
bundle carries against what its schemas generate at the commit.

Which projects, and what is reported:

- **By default**, the projects the entries are in, and the workspace packages
  they depend on (by name, in any dependency field), transitively. What can't
  be generated (a generator stasis doesn't run, a Prisma version it doesn't
  generate as, a schema it can't take, the optional peer missing) is silent,
  unless the bundle reaches it.
- **`--generate=prisma`**: every project the lockfile installs. A project or
  generator it can't generate for is warned of, and a schema it can't take is
  refused.
- **`--no-generate`**, or `stasis.config.json`'s `generatePrisma: false`: none.
  The schemas of the projects the entries reach are still read, without their
  `prisma`, for what their generators would write. `--generate=prisma` beside
  `generatePrisma: false` is refused.

In every case, two generators writing one output are refused, and an import of
a missing file a generator would write fails the bundle, even by `import()` or
`require()` (which otherwise only warn), saying why the file is missing (with
generation off, `generation is off:` and what turned it off):

```
JS bundle would be broken at load time:
  unresolved dynamic-import ./generated/pothos-types.ts from /src/index.ts (MODULE_NOT_FOUND): /prisma/schema.prisma's generator pothos would write it, but stasis generates the "prisma-client" provider's alone
```

Such an import is one whose resolution lands in a generator's `output`, or on
a directory whose index is the output, or one into a default output:
`.prisma/client` (`prisma-client-js`'s) or `@pothos/plugin-prisma/generated`
(Pothos's). Left to the scan like any other miss are a miss inside a client
stasis generated, a specifier built at run time, an output named by `env()`,
and a miss of Metro's own resolution under `--metro`.

If a generator stasis doesn't run has its `output` in the repo already, the
bundle takes what it reaches there as committed, even if older than the schema.
A warning names it: by default if the bundle carries a file of it; with
`--generate=prisma`, always.

```sh
stasis github-bundle --github=owner/name --generate=prisma packages/api/src/index.ts
```

To generate none for a repo, whoever bundles it:

```json
{ "generatePrisma": false }
```

## Programmatic API (`@exodus/stasis/vfs-bundle`)

- `buildGitHubBundle(options)` builds the same bundle from a GitHub repo at a
  commit, a tag's commit or a `branch`'s head. A `sha` is checked as `--sha`
  is (with the `client`'s `getRepoHead`, `compareCommits`, `listRepoTags` and
  `listRepoBranches`), the `branch` given with it first, as with
  [`--branch`](#a-commits-branch---branch). It takes `path` instead of
  `directory`, as the command takes `owner/name/path`: a directory or a file
  (see [A file's project](#a-files-project)). It returns the `directory` it
  bundled, plus `buildVfsBundle`'s `bundle`, `lockfile` (recording the
  bundle's `repo` too, where `buildVfsBundle`'s records none), `stats`,
  `packageManager`, `packageManagers` and `root`. `packageManagers` is each
  tree's package manager, `packageManager` the single one, undefined where
  [`lockfiles`](#several-lockfiles-lockfiles) lay out several, and `stats`
  add up each tree's.
- `buildVfsBundle(options)` builds from a project in a `Vfs` (exported too),
  which it only reads. It takes a project's `stasis.config.json` entries as the
  command does, and all of them if given none.
- `loadNodeModules(options)` lays out only a project's `node_modules`, with
  deptree's `installed`, each package by its `path` with the `commit` its
  version document names. It installs every package, and detects the one
  lockfile, taking no `lockfiles`.
- `buildGitHubBundle` and `buildVfsBundle` do as the command does: they add
  the [`extra`](#extra-files) files; check the build against the project's
  `stasis.lock.json` by the lock mode `lock`, as the command by
  `EXODUS_STASIS_LOCK` (see [Output](#output)); generate the
  [Prisma](#prisma) Clients, `generate: ['prisma']` as `--generate=prisma`,
  `generate: []` as `--no-generate`, and without `generate`, those of the
  projects the entries reach; lay out a tree of each of
  [`lockfiles`](#several-lockfiles-lockfiles), refusing a `packageManager`
  given with it; and lay out a [lazy](#lazy---no-lazy) tree where the command
  does. `lazy: false` installs every package, as `--no-lazy` does;
  `lazy: true` is refused before anything is fetched for a tree always fetched
  first. `stats` are deptree's, and `stats.unpacked` the packages unpacked.
- All three clean `node_modules` by each [`.yarnclean`](#yarnclean) in `cwd`
  and above it in the `Vfs`, and honor the
  [`installDevDependencies`](#devdependencies-installdevdependencies) of the
  `stasis.config.json` in `cwd` (`directory`).
- All three take `cache`, where npm tarballs and version documents are kept,
  as `@preventive/upstream`'s `CacheOptions` take it: left out, `setCacheDir`'s
  cache; a caller's store, `{ read(type, key), write(type, key, value) }`,
  instead; or `false`, nowhere, though `setCacheDir`'s cache is still read.
  Anything else is a `TypeError`, before anything is fetched. GitHub trees and
  Soldeer zips always go in `setCacheDir`'s cache.
- `suggestedEntries({ github, ... } | { vfs, ... })` returns the entries the
  command would take without any; for a `path` to a file, that file.
- `setCacheDir(dir)` sets where tarballs, zips and trees are cached; the CLI
  points it at the user cache directory.
