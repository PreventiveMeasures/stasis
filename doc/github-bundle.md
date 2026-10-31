# `stasis github-bundle`

`stasis github-bundle` builds the bundle `stasis bundle` would build of a
GitHub repository once cloned and installed, with nothing cloned or installed:
the repository's tree is fetched at a commit, and its dependencies are laid out
in memory from its lockfile alone. No package script runs, and nothing of the
repository executes.

```sh
stasis github-bundle --github=owner/name [--sha=commit|--tag=name] [--directory=path] [--package-manager=(pnpm|yarn1|npm|soldeer) [--package-manager-version=version]] [--lazy] [--generate=prisma] [--lockfile=path/to/stasis.lock.json] [--output=(path|-)] [stasis bundle's options for the entries] [path/in/repo/to/(file.(js|ts|jsx|tsx)|file.sol|dir) ...]
```

| Flag | Meaning |
| - | - |
| `--github=owner/name` (**required**) | The repository. Fetched with `GITHUB_TOKEN` where it is set. |
| `--sha=commit` / `--tag=name` | The commit to bundle, or the one the tag names; one or the other. Default: the default branch's head. |
| `--directory=path` | A directory in the repo to bundle, such as a monorepo package. The entries, the lockfile and the bundle's paths are its. |
| `--package-manager` | `pnpm`, `yarn1`, `npm`, or `soldeer` (for `.sol` entries). Default: the one whose lockfile installs the directory, where only one's does. |
| `--package-manager-version` | With `--package-manager` only: the version whose layout to reproduce. Otherwise the root `package.json`'s `packageManager` pin, else pnpm 10.33.4, yarn 1.22.22, npm 11.21.0 (which no `packageManager` pins) or Soldeer 0.12.0. |
| `--lazy` | With pnpm or npm: fetch and unpack only the packages the build reads. See [Lazy](#lazy---lazy). |
| `--generate=prisma` | Generate each project's Prisma Client first. See [Prisma](#prisma---generateprisma). |
| `--lockfile=path` | Also write a `stasis.lock.json` of a JS bundle, as [`stasis bundle --lockfile`](bundle.md#companion-lockfile---lockfile) does. |
| `--output` / `-o` | Where to write. Default: a name after the repo and commit, see [Output](#output). `-` streams to stdout. |
| [`stasis bundle`'s options](bundle.md) | For the entries: `--conditions`, `--mainFields`, `--metro --platforms`, `--jsx`, `--flow`, `--typescript`, `--tsconfig`, `--resources`, `--define`, `--package-json`, `--scope`, `--brotli-quality`, and `--mapping`/`--manifests` for Solidity. Not `--metro-resolver`, `--cargo*` or `--add`. |

```sh
stasis github-bundle --github=owner/name --sha=0123abc src/index.js
stasis github-bundle --github=owner/name --tag=v1.2.0 --directory=packages/api --typescript src/index.ts
stasis github-bundle --github=owner/name --package-manager=soldeer src/Token.sol
```

## Dependencies

The tree is fetched and held to its git tree id. The dependencies are laid out
in memory from the lockfile alone, as the package manager would install them
with scripts off:

| `--package-manager` | Lays out as | Versions reproduced |
| - | - | - |
| `pnpm` | `pnpm install --frozen-lockfile --ignore-scripts` | pnpm 9, 10, 11 or 12 |
| `yarn1` | `yarn install --frozen-lockfile --ignore-scripts` | yarn 1.22 |
| `npm` | `npm ci --ignore-scripts` | npm 10.9.3 to 10.9.9, or 11.11.1 to 11.21.0 |
| `soldeer` | `soldeer install` | Soldeer 0.12 |

With every devDependency, unless the project's `stasis.config.json` says it is
installed without them: see [devDependencies](#devdependencies-installdevdependencies).

Every tarball and zip is held to the lockfile. Beside each npm package's
tarball, the registry's version document of it is fetched, held to the same
integrity, for the commit it was published from (`gitHead`). A Soldeer git
dependency on GitHub is fetched as the repo is. All of it is cached where
`stasis audit` caches: the user cache directory, see [audit](audit.md#repository-advisories---repo-advisories).

Each dependency's `repo` records that commit beside the GitHub repository its
`package.json` names, and a Soldeer git dependency's the repository it is
fetched from, at its root, and the lockfile's `rev` (see
[file formats](file-formats.md)). Like everything in `repo`, it is the
publisher's word, held to no repository.

### devDependencies (`installDevDependencies`)

Where the `stasis.config.json` in the directory bundled sets
`installDevDependencies` to `false`, the tree is laid out as the project is
installed where it ships:

```json
{ "installDevDependencies": false }
```

| `--package-manager` | Lays out as |
| - | - |
| `pnpm` | `pnpm install --frozen-lockfile --ignore-scripts --prod` |
| `yarn1` | `yarn install --frozen-lockfile --ignore-scripts --production` |
| `npm` | `npm ci --ignore-scripts --omit=dev` |
| `soldeer` | `soldeer install`, as without it: Soldeer has no devDependencies |

A package devDependencies alone reach is left out, and one a dependency
reaches too is kept: a build that reaches one fails to resolve it, as the
shipped project would. It applies to the whole lockfile, so every workspace's
devDependencies are left out, not only the directory's. With pnpm and npm, a
package left out is never fetched; yarn 1 fetches and checks the root's
devDependencies all the same, and they still take the places they would be
hoisted to, as `--production` has yarn do. `true`, the default, installs
them, as a plain install does.

It is the file's alone. The project's own settings for it (`.npmrc`'s `omit`,
`production` or `only`, `.yarnrc`'s `--production`) stay refused, as they
change a developer's install too. Nor is it `process.env.NODE_ENV`, which an
entry's [`define`](bundle.md#entry-options-stasisconfigjson) sets: the two are
independent.

### `.yarnclean`

A `.yarnclean` in the directory bundled, or in any directory above it in the
repo, cleans the `node_modules` laid out as
[`yarn autoclean`](https://classic.yarnpkg.com/en/docs/cli/autoclean) cleans
Yarn's (which `yarn install` does where the lockfile's directory holds one),
whatever the package manager:

```
# tests and docs
test
__tests__
docs
*.md
!lodash/README.md
```

Each line is a pattern of paths to remove, a directory with everything below
it, and one starting `!` of paths to keep, a directory holding one staying with
that alone; one starting `#` is a comment. A path matches by its name, or by
its path from the `node_modules` holding its package (`lodash/README.md`, as
Yarn's hoisted layout has it, for pnpm's `.pnpm` store too), whatever its case,
dotfiles included, as Yarn 1.22 matches them. The package manager's own entries
there (`.bin`, `.pnpm`, `.modules.yaml`) never match.

A file cleaned is missing to the build, as after `yarn autoclean`: an import of
one is unresolved, as any missing file's. Matching takes the optional
`minimatch`: where it isn't installed, a `.yarnclean` holding a pattern is
refused before any package is fetched. A `--directory` with a `.yarnclean`
above it is fetched with the whole repo, never alone.

### Lazy (`--lazy`)

With `--lazy`, pnpm's and npm's trees are laid out from the lockfile alone with
nothing fetched, not even a version document, each package's directory empty.
A package is fetched and unpacked once the build reads anything in it: resolving
an import into it, which reads its `package.json`, is enough. What its
`package.json` depends on is fetched and unpacked with it, as the build would
likely read it next, but not what those depend on in turn: a package's
dependencies are often its tools, which an app's build never reads. A package
the build only checks for files (with `--metro`, each dependency of the project,
for a `react-native.config.js` and native code, as React Native's CLI does) is
unpacked alone. A package neither read nor depended on by one read is never
fetched, but where deptree needs it to lay one out as the full tree has it. With
pnpm, a package whose files linking bins would change (a bin pnpm makes
executable, say) is unpacked once the packages whose bins pnpm reads beside it
are fetched: those the lockfile says have bins, and some others pnpm reads
(see deptree's `lazy`). With pnpm's hoisted linker from 10.21 to before 11.25,
where a patch is configured, a package of more than one copy, one with a
`node_modules`, is fetched with the tree, as pnpm drops that `node_modules`
where it builds the package. The bundle and lockfile are the ones the full tree
gives, byte for byte, its warnings said once.

```sh
stasis github-bundle --github=owner/name --lazy src/index.js
```

The build reads synchronously, so it runs in rounds: a round that reads in a
package not yet unpacked is set aside once it has scanned what it reaches,
those packages are unpacked, and the build runs again, until a round reads none
it has not unpacked. What a round scans of a file is kept for the rounds after
it, unless scanning it read in a package not yet unpacked: each file is scanned
once, but those, whose imports are resolved again in the next round, from the
parse kept.

Each package unpacked is held to the lockfile, and checked as without
`--lazy`, so a broken tarball the build reaches is refused as before. One it
never reaches is never refused, whether it is fetched or not: such a lockfile
builds with `--lazy`, and is refused without it. yarn 1 and Soldeer lay out their trees by
what the packages hold, and refuse `--lazy`, before anything is fetched; so
does a [`.yarnclean`](#yarnclean) that keeps paths with `!`, as what it keeps
of one package turns on what the others hold. `--lazy` is a flag of the
command alone: `stasis.config.json` does not set it.

## Entries

The entries are paths in `--directory`, or in the repo. Without any, they are
those the directory's `stasis.config.json` names in its
[`entries`](bundle.md#entry-options-stasisconfigjson), where it has `entries`:
nothing else stands in for them, so an empty one is refused. Else:

- a JS bundle takes the JS files the directory's `package.json` names (`main`,
  each subpath of `exports`, each `bin`), resolved as the build resolves them
  (`--conditions`, `--mainFields`, `--metro --platforms`, `--typescript`);
- a Soldeer bundle takes its `.sol` files directly in it, under `contracts/`,
  and under its source directory (`foundry.toml`'s `src`, else `src/`), but not
  its tests, scripts, mocks, or dependency and build directories.

The entries `stasis.config.json`'s `entries` names, given or taken by default,
are built with their options there, as [`stasis bundle`](bundle.md#entry-options-stasisconfigjson)
builds them: those with different options apart, their bundles merged into one.
With it:

- An option given for them must be the one each of them is built with there,
  or the build is refused: `--platforms=ios` for an entry it builds with
  `--platforms=ios,android`, or `--jsx` for one it builds without. An option
  left out leaves each entry's own, so `--metro` alone builds an entry it
  builds with `--metro --platforms=ios,android`.
- The entries given are all named there, or none is, the two never mixed.
  Where none is, they are built with the options given, as without it.
- An entry setting `babel`, `metro-resolver`, `cargo` or `cargo-target` is
  refused, whatever the flags: each runs a program (the project's Babel config,
  its `metro-resolver`, `cargo`, `rustc`), and nothing of the repo runs here.
  No flag consents to it, as `stasis bundle`'s do.

## Extra files

The files `stasis.config.json`'s [`extra`](file-formats.md#stasisconfigjson)
names are bundled as [`stasis bundle`](bundle.md) bundles them from a checkout,
globs and `!` entries included, from the commit's tree:

```json
{ "extra": ["ios", "ios/.xcode.env", "!ios/build", "!ios/Pods", "!ios/*.xcodeproj/project.xcworkspace", "!ios/fastlane/*.{md,xml}"] }
```

The tree is globbed as Node globs the disk, by Node's own `fs.globSync` and
`path.matchesGlob` (as Node 24.22.2 and 26.13.0 have them) run over it, on the
`minimatch` 10 they are built on. Unlike Node's on macOS and Windows, its
matching never folds case: git's names differ by case alone.

`minimatch` is an optional dependency of `@exodus/stasis`. Where it isn't
installed, a `stasis.config.json` whose `extra` names anything is refused; one
of `!` entries alone globs nothing. `stasis bundle` and `stasis run` glob the
disk with Node's own, without it.

## Roots and paths

The bundle's paths, and the directory its `repo` names (see
[file formats](file-formats.md)), are `--directory`'s. For a JS bundle they are
the innermost package's at or above it that holds every file it bundles: the
project root's, where one is outside it, such as a sibling workspace package or
the root's `node_modules`.

## Output

By default the bundle is written to `owner-name.<commit's first 7>.stasis.code.br`,
or `owner-name.<directory>.<commit's first 7>.stasis.code.br` with
`--directory`, its `/` made `-`. Each character outside `[A-Za-z0-9._-]` is made
`_`, and a directory too deep to fit the name in 255 characters is cut, with a
hash of it appended. `--output=-` streams to stdout.

On stderr it says how many of the packages installed it unpacked, the files
written and their size, and the tarballs fetched for them (pnpm and npm), then
what it bundled:

```text
[stasis] Unpacked 412 of 836 packages: 41210 files, 289.3 MiB, 430 tarballs fetched
[stasis] Bundled 6591 files in 346 packages from owner/name@0123456789abcdef0123456789abcdef01234567 to owner-name.0123456.stasis.code.br
```

Without `--lazy` every package installed is unpacked; with it, those the build
reads, and deptree may fetch a few more than it unpacks (see [Lazy](#lazy---lazy)).

## Prisma (`--generate=prisma`)

`--generate=prisma` first writes, for each project the lockfile installs with
a `prisma-client` generator in its schema, the Prisma Client its
`prisma generate` would write, byte for byte, where the generator's `output`
says; the bundle then carries it as a source like any other. The schema is the
one the project's Prisma config names (as a string literal, or a `path.join` of
them), else `schema.prisma` or `prisma/schema.prisma`.

Nothing of the repo runs: the schema, the config's `schema` path, and the
`tsconfig.json` and `package.json` the generator infers its module format and
import extensions from are read as data, and the project's installed `prisma`
only for its version (and, for an edge runtime's client, the query compiler it
ships). The client is generated by the optional `@prisma/client-generator-ts`
7.10.0 peer dependency and rewritten as the version installed writes it: Prisma
7.4.0 to 7.10.0, its `prisma`, or beside Prisma 8, the one its
`@prisma/prisma7` runs. A project it can't generate for is skipped with a
warning.

```sh
stasis github-bundle --github=owner/name --generate=prisma packages/api/src/index.ts
```

## Programmatic API (`@exodus/stasis/vfs-bundle`)

- `buildGitHubBundle(options)` builds the same bundle from a GitHub repo, at a
  commit or the one a tag names; `buildVfsBundle(options)` from a project held
  in a `Vfs` (exported too), which is only read. `loadNodeModules(options)` lays
  out a project's `node_modules` alone, with deptree's `installed`, each package
  by its `path` with the `commit` its version document names. All three clean
  `node_modules` by each [`.yarnclean`](#yarnclean) in `cwd` and the directories
  above it in the `Vfs`.
- Those three take `cache`: where npm packages' tarballs and version documents
  are kept, as `@preventive/upstream`'s `CacheOptions` take it. Left out, in
  `setCacheDir`'s cache; a store of the caller's, `{ read(type, key),
  write(type, key, value) }`, in place of it; or `false`, nowhere, though
  `setCacheDir`'s cache is still read. Anything else is a `TypeError`, before
  anything is fetched. GitHub's trees and Soldeer's zips are kept in
  `setCacheDir`'s cache whatever it is.
- `buildGitHubBundle` and `buildVfsBundle` add the files
  `stasis.config.json`'s `extra` names, as the command does (see
  [Extra files](#extra-files)).
- All three lay out the tree without devDependencies where the
  `stasis.config.json` in `cwd` (`directory`) sets `installDevDependencies` to
  `false`, as the command does (see
  [devDependencies](#devdependencies-installdevdependencies)).
- `buildGitHubBundle` and `buildVfsBundle` take `lazy: true`, as the command
  takes [`--lazy`](#lazy---lazy); their `stats` then count what is unpacked.
  `stats` are deptree's, and `stats.unpacked` the packages unpacked: each one
  installed, or with `lazy` those unpacked.
- `suggestedEntries({ github, ... } | { vfs, ... })` returns the entries the
  command would take without any, of a GitHub repo or a `Vfs`.
  `buildVfsBundle` takes a project's `stasis.config.json` entries as the
  command does, and every one where it is given none.
- `setCacheDir(dir)` is where tarballs, zips and trees are cached; the CLI
  points it at the user cache directory.
