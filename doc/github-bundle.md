# `stasis github-bundle`

`stasis github-bundle` builds the bundle `stasis bundle` would build of a
cloned and installed GitHub repository, without cloning or installing: the
tree is fetched at a commit, and dependencies are laid out in memory from the
lockfile alone. No package script runs, and nothing of the repository executes.

So nothing is built: a workspace package's `tsc` outputs (`dist/`) are missing,
as in a fresh checkout. With `--typescript`, an import of one resolves to its
source by the package's `tsconfig.json` `outDir` and `rootDir`, as in
[`stasis bundle`](bundle.md#typescript---typescript).

Without `--typescript`, a JS build that would be
[broken at load](bundle.md#resolution) by an import only `--typescript`
resolves (`./b` from `a/c.ts`, for `a/b.ts`) is built with it. One that builds
without it is unchanged.

```sh
stasis github-bundle (owner/name[/path]|--github=owner/name [--directory=path]) [--sha=commit [--branch=name]|--tag=name|--branch=name] [--package-manager=(pnpm|yarn1|npm|soldeer) [--package-manager-version=version]] [--no-lazy] [--generate=prisma|--no-generate] [--lockfile=path/to/stasis.lock.json] [--lockfile-only] [--format=(br|tgz)] [--output=(path|-)] [stasis bundle's options for the entries] [path/in/repo/to/(file.(js|ts|jsx|tsx)|file.sol|dir) ...]
```

| Flag | Meaning |
| - | - |
| `owner/name[/path]` | The repository, optionally with a directory or file in it, as the first non-option argument. A directory acts as `--directory=path`; a file is an entry of the nearest project above it, see [A file's project](#a-files-project). Not with `--github` or `--directory`. |
| `--github=owner/name` | The repository, instead of `owner/name[/path]`. Fetched with `GITHUB_TOKEN` if set. |
| `--sha=commit` / `--tag=name` | The commit to bundle, or the tag naming it; not both. Default: the default branch's head. A `--sha` commit must be in the history of one of the repo's own branches or tags, as in [`stasis validate`](validate.md#the-commit) (GitHub also serves forks' commits under the repo's name), else it is refused before anything is fetched. |
| `--branch=name` | The branch whose head to bundle, instead of the default branch. With `--sha`, the branch the commit is on, see [A commit's branch](#a-commits-branch---branch). Not with `--tag`. |
| `--directory=path` | With `--github` only: a directory in the repo to bundle, such as a monorepo package. The entries, the lockfile and the bundle's paths are its. |
| `--package-manager` | `pnpm`, `yarn1`, `npm`, or `soldeer` (for `.sol` entries). Default: the one whose lockfile installs the directory, if only one does; or one tree for each of its `stasis.config.json` [`lockfiles`](#several-lockfiles-lockfiles), with which the flag is refused. |
| `--package-manager-version` | With `--package-manager` only: the version whose layout to reproduce. Otherwise the root `package.json`'s `packageManager` pin, else pnpm 10.33.4, yarn 1.22.22, npm 11.21.0 (never pinned by `packageManager`) or Soldeer 0.12.0. |
| `--no-lazy` | Fetch and unpack every package the tree installs before the build. Without it, a pnpm or npm tree is lazy: only the packages the build reads are fetched and unpacked. See [Lazy](#lazy---no-lazy). |
| `--generate=prisma` / `--no-generate` | Generate every project's Prisma Client first, warning of what can't be generated; or none. Without either, those of the projects the entries reach are generated, silently. See [Prisma](#prisma). |
| `--lockfile=path` | The [local lockfile](#local-lockfile) of a JS bundle, instead of the default name. Written if missing, as by [`stasis bundle --lockfile`](bundle.md#companion-lockfile---lockfile); if present, the build is checked against it and, under the default `frozen`, it is left unchanged. |
| `--lockfile-only` | Write only the [local lockfile](#local-lockfile), as [`stasis bundle --lockfile-only`](bundle.md#companion-lockfile---lockfile) does: at `--lockfile`'s path, else the bundle's default name with `.stasis.lock.json` for `.stasis.code.br`. If present, the build is checked against it and, under the default `frozen`, nothing is written. Not with `--output` or `--brotli-quality`; refused before anything is fetched. |
| `--output` / `-o` | Where to write. Default: a name after the repo and commit, see [Output](#output). `-` streams to stdout. |
| `--format=(br\|tgz)` | Write a `stasis.code.br` (`br`) or a [`.stasis.tgz`](file-formats.md#stasistgz) (`tgz`); also the default name's suffix (see [Output](#output)). Default: from `--output`'s name, `tgz` for `stasis.tgz` or `<name>.stasis.tgz`, else `br`. Refused if it disagrees with `--output`'s name, with `--brotli-quality` for a tgz, or with `--lockfile-only`. |
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

A `--sha` commit in the default branch's history is verified in two requests.
For any other, the repo's tags, then all its branches, are listed for one at
the commit, and then up to 100 other branches are compared with it one by one,
so in a repo with more branches the commit may not be found (see
[The commit](validate.md#the-commit)).

`--branch=name` names the commit's branch, which is checked first: one request
for a commit at its head, two for one in its history, with nothing listed. The
branch isn't trusted: it must be the repo's own, and GitHub's compare tells
whether it has the commit. If it hasn't, or there is no such branch (deleted or
force-pushed since), the commit is searched for as without `--branch`, so a
fork's commit is still refused.

## Dependencies

The tree is fetched and checked against its git tree id. Dependencies are laid
out in memory from the lockfile alone, as the package manager would install
them with scripts off:

| `--package-manager` | Lays out as | Versions reproduced |
| - | - | - |
| `pnpm` | `pnpm install --frozen-lockfile --ignore-scripts` | pnpm 10, 11 or 12 |
| `yarn1` | `yarn install --frozen-lockfile --ignore-scripts` | yarn 1.22 |
| `npm` | `npm ci --ignore-scripts` | npm 10.9.3 to 10.9.9, or 11.11.1 to 11.21.0 |
| `soldeer` | `soldeer install` | Soldeer 0.12 |

devDependencies are included unless the project's `stasis.config.json` says
otherwise: see [devDependencies](#devdependencies-installdevdependencies).

The layout is for no Node version in particular: each package's `engines.node`
and the root's `devEngines.runtime` accept any Node, `engine-strict` or not, and
no optional package is left out for its `engines.node`. A `nodeVersion` in the
repo's pnpm settings is still the Node pnpm lays the tree out for. The layout is
for this machine's os, cpu and libc, though: an optional package of another
platform is left out.

Every tarball and zip is checked against the lockfile. Each npm package's
registry version document is fetched too, checked against the same integrity,
for the commit it was published from (`gitHead`). A Soldeer git dependency on
GitHub is fetched as the repo is. All of it is cached in the user cache
directory, as for [audit](audit.md#repository-advisories).

A private (scoped) npm package is fetched with the first set of
`PREVENTIVE_MEASURES_NPM_TOKEN`, `STASIS_NPM_TOKEN` and `NPM_TOKEN`, else with
the npm registry token from the last `~/.npmrc` line that is exactly
`//registry.npmjs.org/:_authToken=npm_…`. Another registry's token, or one
written any other way (`${NPM_TOKEN}`, quoted, with spaces), is not read; a
`~/.npmrc` that is not valid UTF-8 is refused.

Each dependency's `repo` records that commit beside the GitHub repository its
`package.json` names; a Soldeer git dependency's records the repository it is
fetched from, at its root, and the lockfile's `rev` (see
[file formats](file-formats.md)). Like everything in `repo`, it is the
publisher's word, checked against no repository.

### Several lockfiles (`lockfiles`)

Where the bundled directory's `stasis.config.json` names `lockfiles`, none is
detected: a tree is laid out from each, by the package manager its file name
implies (`pnpm-lock.yaml` pnpm, `yarn.lock` yarn 1, `package-lock.json` npm,
`soldeer.lock` Soldeer), and the build reads the project through all of them at
once. So a subproject with its own lockfile gets its dependencies too, and JS
and Solidity entries are bundled together, each built from the tree that
installs it:

```json
{ "lockfiles": ["pnpm-lock.yaml", "tools/package-lock.json", "contracts/soldeer.lock"] }
```

- Each path is relative to the config's directory, and may climb to a
  workspace root's (`../../pnpm-lock.yaml`), not out of the repo.
- Each is laid out from its own directory, which must be one its package
  manager installs from, or, if the bundled directory is in it, the one it
  installs that directory from: a `pnpm-lock.yaml` in a workspace member, which
  pnpm installs from the workspace root, is refused.
- No two may install the same directory, or one inside another's: a
  `pnpm-lock.yaml` with a `package-lock.json` beside it, or a lockfile of a
  project in another's workspace, is refused. Every refusal comes before
  anything is fetched.
- A single lockfile acts as the detected one would, so it can choose between
  two package managers' lockfiles that both install the directory, which
  detection refuses.
- `--package-manager` is refused, and `--package-manager-version` with it: each
  tree reproduces the version its own root `package.json` pins, else the
  default.
- Each tree is [lazy](#lazy---no-lazy) where it can be (yarn 1 and Soldeer
  trees are installed whole); `--no-lazy` installs each whole. A lazy build
  unpacks a package of any tree when the build reads it.
- A directory whose config names `lockfiles` is built from the whole repo.
- A `.sol` entry is built from the root of the innermost Soldeer project
  holding it among those the `soldeer.lock`s lay out (`contracts/` for
  `contracts/soldeer.lock`), reading the `foundry.toml` and remappings there,
  and its paths are put under that directory, beside the JS entries'. So each
  project's `.sol` entries resolve by its own remappings, and several projects'
  entries are built apart. A `.sol` entry in none of them is built from the
  config's directory.
- A lockfile no tree is laid out of (a `Podfile.lock`, say) is refused.
  Without `lockfiles`, the one lockfile is detected as above.
- [`stasis validate`](validate.md#lockfiles) checks the bundle's dependencies
  against these lockfiles of the repository at the commit, instead of the one
  it finds, and [`stasis audit`](audit.md#malware-in-any-dependency) with no
  file checks each JS lockfile's packages for malware.

Without [entries](#entries) given, the config's `entries` are taken; if it names
none, those of the kind its lockfiles' package managers build, or none if they
build both JS and Solidity.

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

A package only devDependencies reach is left out; one a dependency also
reaches is kept. A build that reaches a left-out package fails to resolve it.
This applies to the whole lockfile: every workspace's devDependencies are left
out, not only the directory's. With pnpm and npm, a left-out package is never
fetched; yarn 1 still fetches and checks the root's devDependencies, and they
still take the places they would be hoisted to, as with yarn's `--production`.
`true`, the default, installs them.

Only this setting does it. The project's own settings for it (`.npmrc`'s
`omit`, `production` or `only`, `.yarnrc`'s `--production`) stay refused. It is
independent of `process.env.NODE_ENV`, which an entry's (or the config's)
[`define`](bundle.md#entry-options-stasisconfigjson) or, by default, its
`metro` sets.

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
path from the `node_modules` holding its package (`lodash/README.md`, as in
Yarn's hoisted layout, for pnpm's `.pnpm` store too), case-insensitively,
dotfiles included, as in Yarn 1.22. The package manager's own entries (`.bin`,
`.pnpm`, `.modules.yaml`) never match.

A cleaned file is missing to the build: an import of one is unresolved.
Matching needs the optional `minimatch`: if it isn't installed, a `.yarnclean`
holding a pattern is refused before any package is fetched. A `--directory`
with a `.yarnclean` above it is fetched with the whole repo.

### Lazy (`--no-lazy`)

pnpm and npm trees are lazy: laid out from the lockfile with nothing fetched,
not even a version document, and every package directory empty. A package is
fetched and unpacked once the build reads anything in it; resolving an import
into it, which reads its `package.json`, is enough. Its `package.json`'s
dependencies are fetched and unpacked with it, but not theirs in turn. A
package the build only checks for files (with `--metro`, each dependency of the
project, for a `react-native.config.js` and native code) is unpacked alone. A
package neither read nor a dependency of one read is never fetched, unless
deptree needs it to lay out another as the full tree has it. With pnpm, a
package whose files bin linking would change (a bin pnpm makes executable, say)
is unpacked once the packages whose bins pnpm reads beside it are fetched: those
the lockfile says have bins, and some others (see deptree's `lazy`). With
pnpm's hoisted linker from 10.21 to before 11.25, where a patch is configured,
a package with several copies, one of them with a `node_modules`, is fetched
with the tree. The bundle and lockfile are byte for byte those of the full
tree, and its warnings are printed once.

```sh
stasis github-bundle --github=owner/name src/index.js            # lazy
stasis github-bundle --github=owner/name --no-lazy src/index.js  # every package fetched first
```

The build runs in rounds: a round that reads into packages not yet unpacked is
set aside once it has scanned what it reaches, those packages are unpacked,
and the build runs again, until a round needs none. Each file is parsed once;
one whose scan reached a package not yet unpacked has its imports resolved
again in the next round. Where `stasis.config.json`'s entries make several
builds, each runs in every round, so a round asks for what they all read.

With `EXODUS_STASIS_DEBUG=1`, each step is logged to stderr as it ends, with
its time: checking a `--sha` commit against the repo's history, fetching the
repo, laying out (or, if not lazy, installing) the tree, generating the Prisma
Clients (see [Prisma](#prisma)), each build (for a lazy tree, each round, the
packages it asks for and how long unpacking them takes), and writing the
bundle. A build reports the files its scans parsed, resolved again from a kept
parse, and took as kept, and under `--metro` each stage's time: scanning what
the app imports, what Metro and Babel add, configs and toolchain, and carrying
the files into the bundle.

```text
[stasis] Lazy round 3: built in 1.05 s (files 492 parsed, 164 resolved, 4221 replayed; scan 0.20 s, Metro's additions 0.09 s, configs and toolchain 0.76 s), asked for 40 packages: color-name, ee-first, concat-map, balanced-match, regjsgen, …
[stasis] Lazy round 3: unpacked in 0.17 s
```

Each unpacked package is checked against the lockfile as with `--no-lazy`, so
a broken tarball the build reaches is refused. One it never reaches is never
refused, fetched or not: such a lockfile builds lazily, and is refused with
`--no-lazy`.

With `--no-lazy`, every package is fetched and unpacked first. yarn 1 and
Soldeer trees always are, and nothing is refused for it. So is a pnpm or npm
tree under a [`.yarnclean`](#yarnclean) that keeps paths with `!`, and the tree
of a directory whose `stasis.config.json` sets `lazyDependencies` to `false`:

```json
{ "lazyDependencies": false }
```

## Entries

Entries are paths in `--directory`, or in the repo. Without any (and no file
given as `owner/name/path`), they are the directory's `stasis.config.json`
[`entries`](bundle.md#entry-options-stasisconfigjson), if it has `entries`, with
no fallback, so an empty one is refused. A
[glob pattern](bundle.md#entry-patterns) among them matches files of the
commit's tree. Else:

- a JS bundle takes the JS files the directory's `package.json` names (`main`,
  each subpath of `exports`, each `bin`), resolved as the build resolves them
  (`--conditions`, `--mainFields`, `--metro --platforms`, `--typescript`); or,
  if it names none, the directory's `next.config.*` (the first of `.js`,
  `.mjs`, `.ts` and `.mts`), standing for its Next.js app's files, as in
  [`stasis bundle`](bundle.md#nextjs-apps-nextconfig)
  (`stasis github-bundle owner/name/apps/web`);
- a Soldeer bundle takes its `.sol` files directly in it, under `contracts/`,
  and under its source directory (`foundry.toml`'s `src`, else `src/`), but not
  its tests, scripts, mocks, or dependency and build directories.

Entries named in `stasis.config.json`'s `entries`, given or taken by default,
are built with their options there, as in
[`stasis bundle`](bundle.md#entry-options-stasisconfigjson): entries with
different options, or of different languages, are built apart and their bundles
merged, so a JS and a `.sol` entry are bundled together, each from the tree that
installs it, where [`lockfiles`](#several-lockfiles-lockfiles) lays out both.
With such a config:

- An option given must be the one each entry is built with there, or the build
  is refused: `--platforms=ios` for an entry built with
  `--platforms=ios,android`, or `--jsx` for one built without. An option left
  out keeps each entry's own, so `--metro` alone builds an entry configured
  with `--metro --platforms=ios,android`.
- The entries given must all be named there, or none. If none is, they are
  built with the options given.
- The config's own [`define`](bundle.md#defines---define) applies to every JS
  entry, named there or not; a `--define` given must match it, or the build is
  refused.
- An entry setting `babel`, `metro-resolver`, `cargo` or `cargo-target` is
  refused, whatever the flags, as each runs a program (the project's Babel
  config, its `metro-resolver`, `cargo`, `rustc`). Unlike in `stasis bundle`,
  no flag allows it.
- An entry's `allowedPaths`, `disallowedPaths`, `allowedModules` and
  `disallowedModules` restrict what its build carries, and the config's own the
  whole bundle, each rule on its own, as in
  [`stasis bundle`](bundle.md#entry-options-stasisconfigjson) (see
  [Allowed and disallowed paths and modules](file-formats.md#allowed-and-disallowed-paths-and-modules)).
  The config's also apply to a bundle of entries it doesn't name. An entry's
  `excludeModules` applies to its build, the config's to every build, treating
  those dependencies as absent (see [Excluded modules](file-formats.md#excluded-modules));
  a lazy tree fetches none of them that Node's resolution reaches
  (`--mainFields` and `--metro` read one to resolve it).

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

The directory is found from the commit's tree listings, before the tree is
fetched. A path that is not a file there, or is a symlink or under one, is taken
as a directory.

## Extra files

Files named in `stasis.config.json`'s [`extra`](file-formats.md#stasisconfigjson)
are bundled from the commit's tree as [`stasis bundle`](bundle.md) bundles them
from a checkout, globs and `!` entries included:

```json
{ "extra": ["ios", "ios/.xcode.env", "!ios/build", "!ios/Pods", "!ios/*.xcodeproj/project.xcworkspace", "!ios/fastlane/*.{md,xml}"] }
```

The tree is globbed by Node's own `fs.globSync` and `path.matchesGlob` (as in
Node 24.22.2 and 26.13.0), run over it on the `minimatch` 10 they are built on.
Unlike Node on macOS and Windows, matching is always case-sensitive.

`minimatch` is an optional dependency of `@exodus/stasis`. If it isn't
installed, a `stasis.config.json` whose `extra` names anything is refused, and
one that sets `extra` names itself (see
[`extra`](file-formats.md#stasisconfigjson)); an `extra` of `!` entries alone,
`!stasis.config.json` among them, globs nothing. `stasis bundle` and
`stasis run` glob the disk with Node's own glob, without it.

A [glob pattern](bundle.md#entry-patterns) in the config's `entries` is globbed
the same way, so it needs `minimatch` too and is case-sensitive; `entries` that
are all paths glob nothing.

## Roots and paths

The bundle's paths, and the directory its `repo` names (see
[file formats](file-formats.md)), are `--directory`'s. For a JS bundle they are
those of the innermost package at or above it holding every bundled file: the
project root, if a file is outside it, such as in a sibling workspace package
or the root's `node_modules`.

## Output

By default the bundle is written to `owner-name.<commit's first 7>.stasis.code.br`,
or `owner-name.<directory>.<commit's first 7>.stasis.code.br` with
`--directory` (or one from `owner/name/path`), its `/` replaced by `-`. Each
character outside `[A-Za-z0-9._-]` becomes `_`, and a directory too long for a
255-character name is cut, with a hash of it appended. `--output=-` streams to
stdout. With `--format=tgz` it is a [`.stasis.tgz`](file-formats.md#stasistgz),
named `….stasis.tgz` likewise.

On stderr it reports how many installed packages it unpacked, the files written
and their size, and the tarballs fetched (pnpm and npm), then what it bundled:

```text
[stasis] Unpacked 412 of 836 packages: 41210 files, 289.3 MiB, 430 tarballs fetched
[stasis] Bundled 6591 files in 346 packages from owner/name@0123456789abcdef0123456789abcdef01234567 to owner-name.0123456.stasis.code.br
```

A lazy tree unpacks only the packages the build reads, and deptree may fetch a
few more (see [Lazy](#lazy---no-lazy)); any other unpacks every installed
package.

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
[`repo`](file-formats.md#stasislockjson), as the bundle does, so
[`stasis validate`](validate.md) validates it with no `--github` or `--sha`. A
local lockfile that records a `repo` must match the build's in each field it
records (`github` case-insensitively), or the build is refused:

```text
owner-name.0123456.stasis.lock.json records the repo owner/name@<another commit>, and the build is of owner/name@0123456789abcdef0123456789abcdef01234567
```

One recording none, such as one an earlier stasis wrote, is still checked, and
under `frozen` left recording none. A `repo` in the repository's committed
`stasis.lock.json` is ignored.

## Prisma

For each project whose schema has a `prisma-client` generator, a JS bundle
first writes the Prisma Client its `prisma generate` would write, byte for
byte, at the generator's `output`; the bundle then carries it like any other
source. The schema is the one the project's Prisma config names (as a string
literal, or a `path.join` of them), else `schema.prisma` or
`prisma/schema.prisma`.

Nothing of the repo runs: the schema, the config's `schema` path, and the
`tsconfig.json` and `package.json` the generator infers its module format and
import extensions from are read as data, and the project's installed `prisma`
only for its version (and, for an edge runtime's client, the query compiler it
ships). The client is generated by the optional `@prisma/client-generator-ts`
7.10.0 peer dependency and rewritten as the installed version writes it: Prisma
7.4.0 to 7.10.0, its `prisma`, or beside Prisma 8, the one its `@prisma/prisma7`
runs. Other generators in the schema (Prisma's older `prisma-client-js`,
Pothos's `prisma-pothos-types`, ...) are not run. Each schema gets its own
Prisma schema engine, so nothing one schema leaves in it (after a panic, say)
reaches another's client, in this bundle or a later one; a panic refuses the
schema being read, with the engine's message.
[`stasis validate`](validate.md#generated-prisma-clients) checks the clients a
bundle carries, which the repository doesn't hold, against what its schemas
generate at the commit.

Which projects, and what is reported:

- **By default**, the projects the entries are in, and the workspace packages
  they depend on (by name, in any dependency field), transitively. What can't
  be generated (a generator stasis doesn't run, a Prisma version it doesn't
  generate as, a schema it can't take, the optional peer missing) is silent,
  unless the bundle reaches it.
- **`--generate=prisma`** (`generate: ['prisma']`): every project the lockfile
  installs. A project or generator it can't generate for is warned of, and a
  schema it can't take is refused.
- **`--no-generate`** (`generate: []`), or `stasis.config.json`'s
  `generatePrisma: false`: none. The schemas of the projects the entries reach
  are still read, without their `prisma`, for what their generators would
  write. `--generate=prisma` beside `generatePrisma: false` is refused.

In every case, two generators writing one output are refused, and an import of
a missing file a generator would write fails the bundle, whether static or by
`import()` or `require()` (which otherwise only warn of failing at run time).
The failure says why the file is missing (with generation off,
`generation is off:` and what turned it off):

```
JS bundle would be broken at load time:
  unresolved dynamic-import ./generated/pothos-types.ts from /src/index.ts (MODULE_NOT_FOUND): /prisma/schema.prisma's generator pothos would write it, but stasis generates the "prisma-client" provider's alone
```

Such an import is one whose resolution lands in a generator's `output`, or on
a directory whose index is the output: by a relative or absolute path; by a
package's `exports`, `imports` or `main`, or a subpath of a package without
`exports`; under `--mainFields`, by a `browser` or `react-native` field's
redirect; or under `--typescript`, by a `tsconfig.json` `paths` alias. It may
also be an import into a generator's default output: `.prisma/client`
(`prisma-client-js`'s, which `@prisma/client` requires) or
`@pothos/plugin-prisma/generated` (Pothos's).

The generators are those of the schema the installed Prisma takes; with
generation off, which reads no `prisma`, those of each schema Prisma 7.4.0 to
7.10.0 would take (only 7.10.0 reads `prisma7.config.*`). A miss inside a client
stasis generated is left to the scan like any other miss (the client's own
`?module` imports, say). So are a specifier built at run time, an output named
by `env()`, and a miss of Metro's own resolution under `--metro`, which can't be
told apart.

If a generator stasis doesn't run has its `output` in the repo already, the
bundle takes what it reaches there as committed, so a copy older than the
schema is bundled stale. A warning names it: by default if the bundle carries a
file of it; with `--generate=prisma`, always. Pothos's `prisma-pothos-types`
with no `output`, which writes only types into its own package, is never warned
of, unless it sets `generateDatamodel = "true"`, which writes code there too.

The clients are generated once, before anything is built. For a
[lazy](#lazy---no-lazy) tree, they are generated in rounds of their own, which
fetch the `prisma` they read; a project with no schema never has its `prisma`
read or fetched.

```sh
stasis github-bundle --github=owner/name --generate=prisma packages/api/src/index.ts
```

To generate none for a repo, whoever bundles it:

```json
{ "generatePrisma": false }
```

## Programmatic API (`@exodus/stasis/vfs-bundle`)

- `buildGitHubBundle(options)` builds the same bundle from a GitHub repo at a
  commit, a tag's commit or a `branch`'s head. A `sha` is checked against the
  repo's history as `--sha` is (with the `client`'s `getRepoHead`,
  `compareCommits`, `listRepoTags` and `listRepoBranches`), the `branch` given
  with it first, as with [`--branch`](#a-commits-branch---branch).
  `buildVfsBundle(options)` builds from a project in a `Vfs` (exported too),
  which it only reads. `loadNodeModules(options)` lays out only a project's
  `node_modules`, with deptree's `installed`, each package by its `path` with
  the `commit` its version document names. All three clean `node_modules` by
  each [`.yarnclean`](#yarnclean) in `cwd` and the directories above it in the
  `Vfs`.
- All three take `cache`, where npm tarballs and version documents are kept,
  as `@preventive/upstream`'s `CacheOptions` take it: left out, `setCacheDir`'s
  cache; a caller's store, `{ read(type, key), write(type, key, value) }`,
  instead; or `false`, nowhere, though `setCacheDir`'s cache is still read.
  Anything else is a `TypeError`, before anything is fetched. GitHub trees and
  Soldeer zips always go in `setCacheDir`'s cache.
- `buildGitHubBundle` and `buildVfsBundle` add the files `stasis.config.json`'s
  `extra` names (see [Extra files](#extra-files)), and check the build against
  the project's `stasis.lock.json` by the lock mode `lock`, as the command does
  by `EXODUS_STASIS_LOCK` (see [Output](#output)).
- All three lay out the tree without devDependencies where the
  `stasis.config.json` in `cwd` (`directory`) sets `installDevDependencies` to
  `false` (see [devDependencies](#devdependencies-installdevdependencies)).
- `buildGitHubBundle` and `buildVfsBundle` generate the Prisma Clients as the
  command does (see [Prisma](#prisma)): `generate: ['prisma']` as
  `--generate=prisma`, `generate: []` as `--no-generate`, and without
  `generate`, those of the projects the entries reach.
- `buildGitHubBundle` and `buildVfsBundle` lay out a lazy tree where the
  command does (see [Lazy](#lazy---no-lazy)). `lazy: false` installs every
  package, as `--no-lazy` does; `lazy: true` is refused before anything is
  fetched where the tree can't be lazy (yarn 1, Soldeer, a `.yarnclean` that
  keeps paths), or `stasis.config.json` sets `lazyDependencies` to `false`.
  `loadNodeModules` installs every package. `stats` are deptree's, and
  `stats.unpacked` the packages unpacked: all those installed, or for a lazy
  tree those unpacked.
- `buildGitHubBundle` takes `path` instead of `directory`, as the command takes
  `owner/name/path`: a directory or a file (see
  [A file's project](#a-files-project)). It returns the `directory` it bundled,
  plus `buildVfsBundle`'s `bundle`, `lockfile` (recording the bundle's `repo`
  too, where `buildVfsBundle`'s records none), `stats`, `packageManager`,
  `packageManagers` and `root`. `packageManagers` is each tree's package
  manager, and `packageManager` the single one, undefined where
  `stasis.config.json`'s [`lockfiles`](#several-lockfiles-lockfiles) lay out
  several. `stats` add up each tree's.
- `buildGitHubBundle` and `buildVfsBundle` lay out a tree of each lockfile in
  `stasis.config.json`'s `lockfiles` (see
  [Several lockfiles](#several-lockfiles-lockfiles)), and refuse a
  `packageManager` given with it. `loadNodeModules` takes none of them, and
  detects the one lockfile.
- `suggestedEntries({ github, ... } | { vfs, ... })` returns the entries the
  command would take without any, of a GitHub repo or a `Vfs`; for a `path` to
  a file, that file. `buildVfsBundle` takes a project's `stasis.config.json`
  entries as the command does, and all of them if given none.
- `setCacheDir(dir)` sets where tarballs, zips and trees are cached; the CLI
  points it at the user cache directory.
