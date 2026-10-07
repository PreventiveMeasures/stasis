# `stasis github-bundle`

`stasis github-bundle` builds the bundle `stasis bundle` would build of a
GitHub repository once cloned and installed, with nothing cloned or installed:
the repository's tree is fetched at a commit, and its dependencies are laid out
in memory from its lockfile alone. No package script runs, and nothing of the
repository executes.

```sh
stasis github-bundle --github=owner/name [--sha=commit|--tag=name] [--directory=path] [--package-manager=(pnpm|yarn1|npm|soldeer) [--package-manager-version=version]] [--generate=prisma] [--lockfile=path/to/stasis.lock.json] [--output=(path|-)] [stasis bundle's options for the entries] [path/in/repo/to/(file.(js|ts|jsx|tsx)|file.sol|dir) ...]
```

| Flag | Meaning |
| - | - |
| `--github=owner/name` (**required**) | The repository. Fetched with `GITHUB_TOKEN` where it is set. |
| `--sha=commit` / `--tag=name` | The commit to bundle, or the one the tag names; one or the other. Default: the default branch's head. |
| `--directory=path` | A directory in the repo to bundle, such as a monorepo package. The entries, the lockfile and the bundle's paths are its. |
| `--package-manager` | `pnpm`, `yarn1`, `npm`, or `soldeer` (for `.sol` entries). Default: the one whose lockfile installs the directory, where only one's does. |
| `--package-manager-version` | With `--package-manager` only: the version whose layout to reproduce. Otherwise the root `package.json`'s `packageManager` pin, else pnpm 10.33.4, yarn 1.22.22, npm 11.21.0 (which no `packageManager` pins) or Soldeer 0.12.0. |
| `--generate=prisma` | Generate each project's Prisma Client first. See [Prisma](#prisma---generateprisma). |
| `--lockfile=path` | Also write a `stasis.lock.json` of a JS bundle, as [`stasis bundle --lockfile`](bundle.md#companion-lockfile---lockfile) does. |
| `--output` / `-o` | Where to write. Default: a name after the repo and commit, see [Output](#output). `-` streams to stdout. |
| [`stasis bundle`'s options](bundle.md) | For the entries: `--conditions`, `--mainFields`, `--metro --platforms`, `--jsx`, `--flow`, `--typescript`, `--tsconfig`, `--resources`, `--package-json`, `--scope`, `--brotli-quality`, and `--mapping`/`--manifests` for Solidity. Not `--metro-resolver`, `--cargo*` or `--add`. |

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

## Entries

The entries are paths in `--directory`, or in the repo. Without any:

- a JS bundle takes the JS files the directory's `package.json` names (`main`,
  each subpath of `exports`, each `bin`), resolved as the build resolves them
  (`--conditions`, `--mainFields`, `--metro --platforms`, `--typescript`);
- a Soldeer bundle takes its `.sol` files directly in it, under `contracts/`,
  and under its source directory (`foundry.toml`'s `src`, else `src/`), but not
  its tests, scripts, mocks, or dependency and build directories.

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
  by its `path` with the `commit` its version document names.
- Those three take `cache`: where npm packages' tarballs and version documents
  are kept, as `@preventive/upstream`'s `CacheOptions` take it. Left out, in
  `setCacheDir`'s cache; a store of the caller's, `{ read(type, key),
  write(type, key, value) }`, in place of it; or `false`, nowhere, though
  `setCacheDir`'s cache is still read. Anything else is a `TypeError`, before
  anything is fetched. GitHub's trees and Soldeer's zips are kept in
  `setCacheDir`'s cache whatever it is.
- `suggestedEntries({ github, ... } | { vfs, ... })` returns the entries the
  command would take without any, of a GitHub repo or a `Vfs`.
- `setCacheDir(dir)` is where tarballs, zips and trees are cached; the CLI
  points it at the user cache directory.
