# `stasis validate`

`stasis validate` checks that a bundle (`stasis.code.br`) holds its own code as
its repository has it at the commit it was built from, and each dependency as
published, held to the lockfile that installed it.

```sh
stasis validate [--github=owner/name] [--sha=commit] [--directory=path] [--only-deps] [--lockfile=path | --no-lockfile] [--allow-unverified] [--show-valid] path/to/(bundle|stasis.lock.json|name.stasis.tgz)
```

| Flag | Meaning |
| - | - |
| `--github` | The repository to read own code and the lockfile from, instead of the `repo` the file records. |
| `--sha` | The commit, instead of `repo.commit`. |
| `--directory` | The directory in the repository it was built in, instead of `repo.directory`. |
| `--only-deps` | Skip own code; the repository's tree is not read. The bundle's patches are still checked where a repository and commit are known, see [Patched dependencies](#patched-dependencies). |
| `--lockfile=path` | Hold the dependencies to this lockfile on disk instead of the repository's. Give it twice for a bundle with both npm packages and crates. |
| `--no-lockfile` | Hold each tarball to its registry's integrity alone. |
| `--allow-unverified` | Exit 0, not 2, when the bundle is `incomplete`. |
| `--show-valid` | Also list valid packages (the patched ones), each with its patch. |

With no repository or commit recorded or given, only `--only-deps` validates a
bundle, with `--lockfile` or `--no-lockfile`. Only npm packages and crates need
a lockfile.

It exits:

| Code | |
| - | - |
| 0 | `valid`: every file to check was checked and matches. Own code skipped with `--only-deps` doesn't count. |
| 1 | `invalid`: a file differs or is unexpected, a version fails its lockfile or what it records, a copy is installed where another belongs, or it contradicts the `stasis.lock.json` the repository commits. |
| 2 | `incomplete`: nothing failed, but some files went unverified (a package that couldn't be fetched, one locked from git, a Composer package, …). |
| 3 | Refused (no repository or commit, a commit of no branch or tag of the repository, no lockfile, an unreadable lockfile, a tgz that isn't exactly its `stasis.lock.json`'s files, a usage error) or failed (GitHub refusing the repository, say), with only the error on stderr. |

The report goes to stdout as tables:

- **Files**: those that differ or are unexpected, and own code left
  unverified, each with its reason, if any. Past 500, the rest are counted.
- **Packages**: invalid, then unverified, with why, its patch, or the
  repository directory it is held to.
- **Generated**: files the repository's
  [Prisma schemas generate](#generated-prisma-clients) but it doesn't hold, a
  row per client.

Stderr gets the summary, why own code wasn't checked or no Prisma Client could
be generated, and the lockfiles used.

```text
┌────────────┬──────────┬───────────────────────────────────────────┐
│ status     │ of       │ files                                     │
├────────────┼──────────┼───────────────────────────────────────────┤
│ differs    │ own code │ src/main.js                               │
│ differs    │ ms@2.1.3 │ node_modules/ms/index.js                  │
│            │          │ node_modules/ms/readme.md                 │
│ unexpected │ own code │ src/link.js (a symlink in the repository) │
└────────────┴──────────┴───────────────────────────────────────────┘

┌────────────┬────────────┬─────────────────────────────────┐
│ status     │ package    │ note                            │
├────────────┼────────────┼─────────────────────────────────┤
│ invalid    │ gone@1.0.0 │ not locked by the lockfile      │
│ unverified │ tool@2.0.0 │ locked from git, not a registry │
└────────────┴────────────┴─────────────────────────────────┘
invalid: 4 of 10 files as they should be, 3 differ, 1 unexpected, 2 unverified; 1 of 4 packages as published, 1 failing their lockfile
Own code held to org/repo at 0123456789abcdef0123456789abcdef01234567 of main under web
Dependencies held to pnpm-lock.yaml
```

```sh
stasis validate app.stasis.code.br
GITHUB_TOKEN=... stasis validate --sha=<commit> app.stasis.code.br
stasis validate --only-deps --lockfile=pnpm-lock.yaml app.stasis.code.br
stasis validate --only-deps --no-lockfile app.stasis.code.br
```

## What is checked

1. **Own code**: the files of modules naming no ecosystem (the project's own
   and its workspace's packages, see [file formats](file-formats.md)) and,
   whatever they record, of the root module and of `npm` modules outside
   `node_modules`. Each must be the repository's, byte for byte, at its path
   under the bundle's directory, the tree read as
   [`github-bundle`](github-bundle.md) reads one, held to its id. A file
   differing only by CRLF line endings on every line passes, unless a binary
   resource, a shell script or an env file. A path the repository has as a
   symlink differs; one it lacks, or has in a submodule, is unexpected.
2. **Dependencies**: npm packages are fetched from npm's registry, crates from
   crates.io, held to their [lockfile](#lockfiles). Each installed copy's files
   must match the published ones at their paths (files left out are fine), and
   an npm copy must be [where it belongs](#where-a-package-is-installed). A
   vendored crate's `.cargo-checksum.json` is held to the crate's checksum and
   its files' sha256.
3. **Coverage**: every file must be own code, a dependency's, a file of a
   [generated Prisma Client](#generated-prisma-clients), or stasis's empty stub
   for an import a package disables (`.stasis/empty-module.js`).
4. **The stasis.lock.json the repository commits** in that directory, if any:
   the bundle must agree with it on each file both record, and on each module's
   name, version, `integrity` and `patch` (even one only the lockfile records).
   A contradiction is reported on stderr (`stasisLockfile`).

A file that differs is `differs`; one neither the repository nor its package has
is `unexpected`.

A `stasis.lock.json` is validated like a bundle, each file by its recorded
integrity; one [`stasis github-bundle`](github-bundle.md#local-lockfile) didn't
write needs `--github` and `--sha`. Against a listing of the tree (git blob ids
only), its own code is unverified; a vendored crate's `.cargo-checksum.json`,
checked by its bytes, is skipped. A [`.stasis.tgz`](file-formats.md#stasistgz)
is validated as a bundle of its files, against the repository and commit its
`stasis.lock.json` records; a tgz by another name is refused.

Left unverified, as none can be fetched by name and version: Composer packages,
Soldeer zips, and crates vendored from git or with no `.cargo-checksum.json`.
Still:

- A Composer or Soldeer package is held to the `composer.lock` or
  `soldeer.lock` in the bundle's directory at the commit (or `--lockfile`'s),
  if any: a version it doesn't lock fails, its `integrity` must be the one
  locked, and one locked from git is held to its repository at that commit, as
  for npm.
- A Foundry `lib/` submodule (`github`) is held to the repository it records,
  at the commit the repository's tree pins at its path: one recording another
  commit fails, and one where the tree has no submodule is unverified.

## Generated Prisma Clients

Own code the repository lacks or has otherwise is held to the Prisma Clients
its schemas generate at the commit, generated as
[`stasis github-bundle`](github-bundle.md#prisma) would for that directory, each
with the `prisma` its lockfile installs. A file in a client's output is:

- **generated** (counted as it should be) if it is that client's file, byte for
  byte;
- **differs** if the client has another file at its path;
- **unexpected** if the client has none there.

Clients are generated only where some own file isn't the repository's, from
trees laid out with their devDependencies, whatever the repository's
`stasis.config.json` says of `generatePrisma` and `installDevDependencies`.
Generating needs the optional `@prisma/client-generator-ts` 7.10.0 peer
dependency; where clients can't be generated, the files are reported as found,
and the summary says why.

```text
┌────────────┬──────────┬─────────────────────────────────────────────────────────────────────────────────────────────┐
│ status     │ of       │ files                                                                                       │
├────────────┼──────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
│ differs    │ own code │ src/generated/prisma/internal/class.ts (not as the repository's Prisma schema generates it) │
│ unexpected │ own code │ src/generated/prisma/extra.ts (in a Prisma Client's output, which generates no such file)   │
└────────────┴──────────┴─────────────────────────────────────────────────────────────────────────────────────────────┘

┌───────────┬──────────────────────────────────────────────┬──────────────────────────────────────────────────┐
│ status    │ of                                           │ files                                            │
├───────────┼──────────────────────────────────────────────┼──────────────────────────────────────────────────┤
│ generated │ prisma/schema.prisma's client (Prisma 7.9.0) │ src/generated/prisma/client.ts                   │
│           │                                              │ src/generated/prisma/enums.ts                    │
│           │                                              │ src/generated/prisma/internal/prismaNamespace.ts │
│           │                                              │ src/generated/prisma/models/User.ts              │
└───────────┴──────────────────────────────────────────────┴──────────────────────────────────────────────────┘
invalid: 7 of 9 files as they should be, 1 differ, 1 unexpected, 0 unverified; 0 of 0 packages as published; 4 generated by the repository's Prisma schemas
Own code held to org/app at 0123456789abcdef0123456789abcdef01234567 of main
Dependencies held to pnpm-lock.yaml
```

## Lockfiles

The lockfile is the one installing the bundle's directory, read from the
repository at the commit, found at or above it as
[`github-bundle`](github-bundle.md) finds one:

- **pnpm**: the workspace root's `pnpm-lock.yaml` (the nearest at or above
  with a `pnpm-workspace.yaml`), even if another lockfile is nearer; else the
  nearest.
- **npm**: the `package-lock.json` (or `npm-shrinkwrap.json` beside it, which
  wins) of the root whose `workspaces` include the package, even if another is
  nearer; else the nearest beside a `package.json`.
- **yarn 1**: the workspace root's `yarn.lock`, for the root or one of its
  workspaces; else the nearest.
- **crates**: the `Cargo.lock` beside the workspace root's `Cargo.toml` (the
  nearest at or above with a `[workspace]`), else beside the directory's own;
  never one further up.

Lockfiles of two package managers, a `bun.lock`, or none is refused (give one
with `--lockfile`), as is an unreadable one (yarn 2's, say).

Where the repository's `stasis.config.json` in the bundle's directory names
[`lockfiles`](github-bundle.md#several-lockfiles-lockfiles), those are used
instead, several of one ecosystem allowed: each copy is held only to the
innermost one holding it, and fails if none does. A named lockfile missing or
outside the repository is refused, as is a config naming none that locks the
bundle's npm packages or crates. `--lockfile` and `--no-lockfile` override it.

Each npm version or crate must be one its lockfile locks:

- **Of its registry** (npm's or a mirror's tarball of it, crates.io): fetched
  with the integrity locked (an npm version's sha512, a crate's checksum), else
  (no lockfile read, a yarn entry with only a sha1) the one recorded, else
  unverified. A tarball that doesn't match, or two integrities locked or
  recorded, fails it.
- **From git** (a `type: git` resolution, a git host's tarball, GitHub's
  tarball of a commit, a `git+` source): one at one full commit of a GitHub
  repository is held to its tree there, under the path it names, where a file
  it lacks (an install may build it) is unverified. Any other (another host's,
  a crate's) is unverified. A module's recorded commit doesn't make it from git.
- **From a directory of the project** (`file:`, `link:`, an npm link): each
  copy is held to the repository's files there; unverified with a lockfile
  given on disk.
- **From elsewhere** (another tarball, a `file:` one included, a path crate, a
  package another bundles): unverified.
- **Not at all**: fails.

A recorded `integrity` must be the one locked, wherever from. A version that
fails its lockfile isn't compared; its files count as unverified.

## Packages installed from a directory

An `npm:directory` dependency (see
[file formats](file-formats.md#stasiscodebr)), a `file:` package pnpm or yarn
copied into `node_modules`, is held, in each copy, to the repository's files at
the commit in the directory it records (relative to the bundle's directory); a
bin whose `#!` line ends in CRLF there may have that CR dropped, as pnpm before
12 copies it. It needs no lockfile, so is checked even with `--no-lockfile` and
`--only-deps`. An npm lockfile read must install a package of its name from
that very directory, else it fails. One outside the repository, or with no
repository and commit to read, is unverified. It needs no alias.

An older stasis records such a package as `npm`, with no integrity: it is held
to the directory its lockfile installs a package of its name from. Such a record
with an integrity fails.

## Where a package is installed

Each npm copy must be installed where the bundle has it:

- **Its name**: the one after its last `node_modules/`, unless its lockfile
  aliases it (npm's at that location, yarn's or pnpm's). A pnpm alias of a
  directory (`foo: lib@file:lib`, from a `file:` override) is of that
  directory's package of that name, at any version its lockfile doesn't
  otherwise lock, its files held to the directory's.
- **pnpm's store**: a copy under `node_modules/.pnpm/<name>@<version>/` is of
  that name and version; one from no registry (`file+lib`) is held to its
  lockfile alone.
- **npm's lockfile**: the version it locks at that location, prefixed with the
  bundle's directory's path from the lockfile's; for one given on disk, only
  where the bundle's directory is one of its workspaces, else from its own
  directory.

A copy where its path or its lockfile names another fails (`misplaced`), its
files counted unverified, wherever its other copies are. A copy under another
name with no lockfile read showing an alias is unverified (`alias-unverified`);
the version's other copies are still checked. A crate's place is not checked.

## Patched dependencies

A version pnpm patches on install (its lockfile's `patchedDependencies`) is
held, in every copy, to its files patched as pnpm applies the patch. The patch
is the bundle's file of the hash `pnpm-lock.yaml` locks, else:

- the file the lockfile names, read from beside it (in the repository, or on
  disk for one given), held to that hash (`patch-mismatch`);
- for one named by hash alone (pnpm 11), the file of that hash pnpm names for
  it (`patches/name@version.patch`, or by its selector) in the `patches`
  directory of the bundle's project, else of the repository's root (beside a
  lockfile given on disk); with none, `in no file of its hash`.

With no `pnpm-lock.yaml` read, it is the patch the bundle holds named for the
version (`patches/name@version.patch`), and each copy is held to its files
patched or as published.

A copy recording its [`patch`](file-formats.md#stasiscodebr) is held to its
files patched with it; with no npm lockfile read, the recorded hash picks the
patch. Its version fails if its copies record different patches
(`patch-conflict`) or the npm lockfile read locks another or none
(`patch-not-locked`). A copy whose recorded `file` isn't, from the bundle's
root, the file the patch was found in fails (`patch-file-mismatch`).

A copy recording an [`integrity`](file-formats.md#stasiscodebr) and no patch is
held to its files as published. Its version fails if another copy records a
patch (`patch-conflict`) or the lockfile read patches it (`patch-not-recorded`).

A patch the bundle holds is own code, so must be the repository's: one the
repository has otherwise or lacks is refused
(`is the bundle's, not the repository's`); with no repository known, files that
match only with it applied are unverified. A copy to be patched by a patch that
couldn't be read or applied, or was refused, is never valid: its files as
published are unverified, the others fail.

## The commit

The commit must be in the repository's own history (GitHub serves forks'
commits under its name too): its default branch's, a tag or branch at it, or
another branch's. Any other is refused, recorded or given by `--sha`. At most
100 other branches are compared: in a repository with more, a commit at no tag
or branch head nor in the default branch's history is refused unless a
compared branch has it (`history-unread`).

## Access

GitHub is asked with `GITHUB_TOKEN` if set. A moved repository is followed,
still held to the commit's and tree's ids. A private (scoped) npm package is
fetched as [github-bundle](github-bundle.md#dependencies) fetches one: with the
first set of `PREVENTIVE_MEASURES_NPM_TOKEN`, `STASIS_NPM_TOKEN` and
`NPM_TOKEN`, else the token of the last `~/.npmrc` line that is exactly
`//registry.npmjs.org/:_authToken=npm_…`; an `~/.npmrc` that isn't valid UTF-8
is refused. Trees and tarballs are cached where `stasis audit` caches, each held
to its id or integrity when read.

## API

`@exodus/stasis/validate` exports each step (types in `src/validate.d.ts`):

| Export | |
| - | - |
| `validationPlan(bundle)` | A parsed bundle's own files, its files by package version, and the patches it holds. |
| `validateBundle(plan, own, { fetch, locked, generated, deadline })` | The report. `own` is the repository's files by path from its root, each `{ data }` (bytes), `{ sha }` (git's blob id), `{ symlink }` or `{ submodule: true }`, with `repository`, `commit`, `directory` and `cut`; or `{ reason }` it wasn't read (`skipped` when asked, counted separately), with `entries` where the bundle's patches are still checked; or a promise of either, packages being fetched meanwhile. `locked` (`lockedBy`'s, null for none): `lock(ecosystem, name, version)` how its lockfile locks a version (`{ from: 'registry', integrity }`, `{ from: 'local', directories }`, `{ from: 'git' }`, `{ from: 'elsewhere' }`, null for not at all, undefined if no lockfile of its ecosystem was read); `tree(directory)` the repository's files in a directory by path within it, where read; `of(name, version)` the patch pnpm's lockfile locks it with (`{ hash, path }`, null for none, undefined if unknown); `read(path)` its text, read from `from` (`repository` or `local`); `installed(dir)` the version npm's lockfile installs at a copy's directory (`<name>@<version>`, null for none, undefined if its lockfile locks no location); `aliased(as, named)` whether it installs `named` under the name `as` (undefined for no lockfile). `fetch(ecosystem, name, version, integrity)` is `fetchPackage`'s. `generated()`, if given, returns a promise of the Prisma Clients the repository's schemas generate (each `{ dir, files, schema, generator, prisma }`, `files` by path from `dir`, and `dir` and `schema` by path from the bundle's root); it is called once every other own file is checked, and only if one isn't the repository's. The report's `generated` lists the clients its files are generated by (`{ output, schema, generator, prisma, files }`), `counts.generated` counts them, and `generatedError` says why `generated()` failed. |
| `validateRepository(plan, { repository, commit, directory }, { own, lockfile, listTree, strict, fetch, deadline, generated })` | Validates a plan against `repository` (`followingMoves`'s, null for none) at `commit`, which must be in its history (`historyOf`), as `validate` does a file. Own code is read from the commit's tree by bytes; or, given `listTree(paths)`, from a listing of it (`{ entries, cut }`, as upstream's `listRepoTree` gives it, for the paths of the bundle's own files and its directory's) by git's blob ids, which also lists the lockfile's directories. `lockfile` is `true` (the repository's), lockfiles as `lockedBy` takes them, or `false`. With `strict` false, no repository or commit (`no-repository`, `no-commit`), a commit outside the repository's history (`commit-not-in-history`, `history-unread`), or no lockfile is reported, not thrown: own code is unverified with the `ValidateError`'s code as `own.reason`, and the dependencies are held to their registry alone, with the code in `lockfileError` where their lockfile went unread for it. `generated` is `validateBundle`'s. |
| `validate(file, { client, github, sha, directory, own, lockfile })` | What the CLI runs, with an `@preventive/upstream/github.js` client: `file` is a bundle, a `stasis.lock.json`, or a tgz of one and its files (above). `own: false` is `--only-deps`; `lockfile` is `true` (the repository's), an array of paths (`--lockfile`), or `false` (`--no-lockfile`). Throws a `ValidateError` (with a `code`) where it won't check a file. Own code the repository doesn't hold is held to the Prisma Clients its schemas generate (see [Generated Prisma Clients](#generated-prisma-clients)), read with `client`. |
| `exitCodeOf(report, { allowUnverified })` | The exit code for a report, as the CLI exits. |
| `printValidationReport(report, { out, err, showValid, colors })` | Prints the report as the CLI does, to `out` and `err` (default `process.stdout` and `process.stderr`, else anything with `write`), valid packages only with `showValid`, in colour if `colors` (by default, where each stream supports it). |
| `followingMoves(client, github)` | `client`'s reads of a repository, following GitHub's answer that it has moved. |
| `historyOf(repository, commit, { maxCompared, deadline })` | The ref of `repository` (`followingMoves`'s) with `commit` in its history, `{ branch }` or `{ tag }`, null for none: its default branch, a tag or branch at it, then its other branches, at most `maxCompared` (100) and none past `deadline`. Throws a `ValidateError` (`history-unread`) where an uncompared branch might have it. |
| `lockedBy(lockfiles)` | `locked`, from lockfiles' paths and texts, each with `root` (the bundle's directory's path from the lockfile's) and `at` (the lockfile's directory's path from the bundle's; `''`, the default, for the same). Several of one ecosystem are allowed where each is `at` another: a copy is installed where the innermost holding it says, and a version is locked as any of them locks it. |
| `configuredLockfiles({ directory, list, read })` | The lockfiles the repository's `stasis.config.json` in `directory` names, by their paths from its root, undefined for none. |
| `lockedNpmPackages(dir)` | The registry npm versions locked by each lockfile installing a directory on disk, `[{ path, name, packages }]`: those its `stasis.config.json` names, else the one found (what `stasis audit` uses with no file). |
| `repositoryLockfiles({ directory, ecosystems, list, read })` | The repository's lockfiles that install `directory`, as `lockedBy` takes them. |
| `repositoryFiles`, `fetchPackage`, `fetchFailure`, `tarballFiles`, `gitBlobId`, `parsePatch`, `patchedFiles`, `isPatchOf` | The pieces those use. |

`@exodus/stasis/validate-notes` words a report as `printValidationReport` does,
and imports nothing, so it runs in a browser too (types in
`src/validate-notes.d.ts`):

- `OWN_REASONS`, `PACKAGE_REASONS`, `PATCH_ERRORS`, `FILE_REASONS`,
  `LOCKFILE_ERRORS`: the text of each code a report gives (`own.reason`, a
  package's `reason`, its `patch.error`, a problem's `reason`,
  `lockfileError`).
- `noteOf(pkg)`: a package's note as parts, text and its paths as `{ path }`.
- `noteText(pkg)`: the note as text.
- `generatedBy(client)`: what a client in the report's `generated` is generated
  by (`prisma/schema.prisma's client (Prisma 7.10.0)`).
