# `stasis validate`

`stasis validate` checks that a bundle (`stasis.code.br`) holds what it says it
does: its own code as its repository has it at the commit it was built from,
and each dependency as its published package has it, held to the lockfile that
installed it, those two covering every file it holds.

```sh
stasis validate [--github=owner/name] [--sha=commit] [--directory=path] [--only-deps] [--lockfile=path | --no-lockfile] [--allow-unverified] [--show-valid] path/to/bundle
```

| Flag | Meaning |
| - | - |
| `--github` | The repository its own code and its lockfile are read of, in place of the one the bundle's `repo` names. |
| `--sha` | The commit, in place of the bundle's `repo.commit`. |
| `--directory` | The directory in the repository it was built in, in place of the bundle's `repo.directory`. |
| `--only-deps` | Check the dependencies alone: own code is skipped, and the repository's tree is not read. The patches the bundle holds are checked all the same, where a repository and commit are known (below). |
| `--lockfile=path` | Hold the dependencies to this lockfile, on disk, in place of the repository's. Give it twice for a bundle with both npm packages and crates. |
| `--no-lockfile` | Hold the dependencies to no lockfile: each tarball to its registry's integrity alone. |
| `--allow-unverified` | Exit 0 where the bundle is incomplete: files it was to check went unverified, and nothing failed. |
| `--show-valid` | List the packages that are valid too (those patched), each with its patch; left out otherwise. |

Both checks are on unless turned off. A bundle that records no repository or
commit, with none given, is refused (exit 3), since its own code can't be read:
`--only-deps` validates its dependencies alone. Those still need a lockfile,
which is read of the repository: give one with `--lockfile`, or opt out with
`--no-lockfile`. A bundle with no npm package or crate needs none.

It exits:

| Code | |
| - | - |
| 0 | `valid`: every file it was to check was checked and is as it should be. Own code skipped with `--only-deps` is no file it was to check. |
| 1 | `invalid`: a file differs or is unexpected, a version fails its lockfile, or a copy is installed where another is. |
| 2 | `incomplete`: nothing failed, but files it was to check went unverified (a package that couldn't be fetched, one locked from git, a Composer package, …). 0 with `--allow-unverified`. |
| 3 | It refused the bundle (no repository or commit, a commit of no branch or tag of the repository, no lockfile, a lockfile it can't read, a usage error) or failed (GitHub refusing the repository, say), with the error alone on stderr. |

The report goes to stdout as tables, as `stasis audit` prints its own:

- **Files**: those that differ, then those unexpected, then own code's left
  unverified, each kind of what they are of in one row: own code first, then
  each package (an npm one by its name and version, another with its
  ecosystem), its files listed in it, with why where there is a reason (a
  symlink, a submodule). Past 500, the rest are counted.
- **Packages**: those with something to tell, the invalid first, then the
  unverified: why one is unverified or fails its lockfile, its patch, or the
  directory of the repository it is held to. One failing for its files alone is
  in the files' table; one valid is listed, with its patch, only with
  `--show-valid`. The ecosystem has a column where one is not npm's.
- **Generated**: the files generated as the repository's Prisma schemas
  generate them, which it doesn't hold, one row for each client: the schema,
  its generator and the Prisma it generates as (see [Generated Prisma
  Clients](#generated-prisma-clients)).

The summary (the status, and the files and packages counted, those generated
among them), why own code wasn't checked, why no Prisma Client was generated
where none could be, and the lockfiles the dependencies were held to go to stderr.
The statuses are in colour (failing red, unverified yellow, valid green) where
the stream takes colours, as `@exodus/test` tells it: CI's log (`CI` set), or
a terminal that has them; not a pipe or a file.

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

1. **Own code**, the files of modules naming no ecosystem (the project's own
   and its workspace's packages, see [file formats](file-formats.md)); and the
   root's, and an `npm` one's outside `node_modules`, whatever they record, must be
   the repository's, byte for byte, at its path under the directory the bundle
   was built in. The directory's tree is read with upstream, as
   [`github-bundle`](github-bundle.md) reads one: its tarball, held to the
   tree's id. A file whose only difference is a checkout's CRLF line endings
   passes, and is counted: every line's end a CRLF, as git converts a text
   file whole. Not a binary resource (`resource:base64`), which no checkout
   converts, nor a shell script or an env file, whose commands and values a CR
   changes. A path the repository has as a symlink differs; one
   it hasn't, or has in a submodule, is unexpected.
2. **Dependencies** are fetched with upstream: an npm package from npm's
   registry, a crate from crates.io. Each is held to its lockfile (below): a
   version the lockfile locks of its registry is fetched with the integrity it
   locks (an npm version's sha512, a crate's checksum), which upstream holds the
   tarball to in place of the registry's, refusing one that differs. Each file
   the bundle holds of a package must match the file at its path there. Files
   of a package the bundle leaves out are expected: a bundle holds those its
   code reaches alone. Each installed copy of a version is held to it apart, and
   the version fetched once. An npm copy is held to where it is installed too,
   as Node resolves a package by its path (below). A vendored crate's `.cargo-checksum.json`, which
   `cargo vendor` writes and no crate holds, is held to the crate: its package
   checksum, and the sha256 of each file it lists.
3. **Coverage**: every file the bundle holds must be one or the other, or a
   file of a Prisma Client the repository's schemas generate (below). Stasis's
   own empty stub for an import a package disables (`.stasis/empty-module.js`)
   is allowed.

Composer packages, Soldeer packages, GitHub repos (Foundry's `lib/`) and crates
vendored from git, or with no `.cargo-checksum.json`, have no package upstream
fetches by name and version: their files are left unverified, as are those of a
version that couldn't be fetched (`not published`, `its registry refused it`).

A file differing is `differs`, one neither the repository nor its package has
`unexpected`. The bundle is `valid` where every file was checked and matches,
`invalid` where any differs or is unexpected or a version fails its lockfile,
and `incomplete` where nothing failed but some files weren't checked.

## Generated Prisma Clients

A bundle [`github-bundle`](github-bundle.md#prisma) builds carries the Prisma
Client each project's schema generates, which the repository doesn't hold. Own
code the repository doesn't hold as bundled (a file it hasn't, or has
otherwise) is held to the clients the repository's schemas generate at the
commit, generated as `stasis github-bundle` generates them for a bundle of its
directory: the repository read whole where that directory doesn't stand alone,
its trees laid out from its lockfiles, and every project's schema generated,
apart, with the `prisma` its lockfile installs, fetched (it alone, and what the
generator reads), as the bundle's was. A file in a client's output is:

- **generated** where it is that client's file, byte for byte: counted as it
  should be, and listed with the client;
- **differs** (`not as the repository's Prisma schema generates it`) where the
  client has a file at its path that isn't it;
- **unexpected** (`in a Prisma Client's output, which generates no such file`)
  where the client has none there.

A file in no client's output is told as before, and a file the repository holds
is held to it alone, generated or not: a bundle of a committed client is
checked as own code, and generates none. The clients are generated only where
some own file isn't the repository's, and whatever the repository's
`stasis.config.json` says of `generatePrisma`: what is checked is that a file
is what its schema generates, not that a bundle would have generated it. An
edge runtime's client is held to the query compiler of the `prisma` its
lockfile installs, which it copies.

Generating needs the optional `@prisma/client-generator-ts` 7.10.0 peer
dependency, as `github-bundle` does. Where the clients can't be generated (the
peer missing, the repository or a package not read), the files are told as they
were found, and the summary says why.

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

The lockfile is the repository's at the commit, the one that installs the
bundle's directory, found by the very rules [`github-bundle`](github-bundle.md)
builds by (each package manager's root), of the directories at and above it.
For npm packages it is the one package manager's that installs it:

- **pnpm**: the workspace root's `pnpm-lock.yaml` (the nearest directory at or
  above it holding `pnpm-workspace.yaml`), whatever lockfile is nearer; without
  a workspace, the nearest.
- **npm**: the `package-lock.json` (or `npm-shrinkwrap.json`, which npm takes
  before it in the same directory) of the root whose `package.json`'s
  `workspaces` take the package, whatever lockfile is nearer; else the nearest
  beside a `package.json`.
- **yarn 1**: the workspace root's `yarn.lock`, where the package is the root
  or one of its workspaces; else the nearest.

For crates it is the `Cargo.lock` beside the workspace root's `Cargo.toml` (the
nearest at or above it with a `[workspace]`), else beside the directory's own,
as cargo finds it: one further up is another project's. Lockfiles of two
package managers installing it, a `bun.lock`, or none is refused: give one with
`--lockfile`. One that can't be read (yarn 2's, say) is refused too.

Where the repository's `stasis.config.json` in the bundle's directory names its
[`lockfiles`](github-bundle.md#several-lockfiles-lockfiles), none is found: the
dependencies are held to those it names, as the build lays out a tree of each,
of the repository at the commit. Several of one ecosystem are taken (a root
`pnpm-lock.yaml` and `tools/package-lock.json`, say): each copy is held to
the innermost of them holding it alone, as it alone installs it: where it
installs it, whether it locks the version, and its patch. A copy none holds
fails. One validate doesn't read (a `soldeer.lock`) is
passed over, its packages left unverified as ever. One that is not there, or
outside the repository, is refused, as is a config naming none that locks the
bundle's npm packages or crates. `--lockfile` and `--no-lockfile` take their
place all the same.

Each npm version or crate the bundle holds must be one its lockfile locks:

- **Of its registry** (npm's or a mirror's tarball of it, crates.io): fetched
  with the integrity it locks. A tarball upstream refuses for it fails the
  version (`its registry's tarball is not the one the lockfile locks`), as does
  a version the lockfile locks with two. One locked with no sha512 (a yarn
  entry with a sha1 alone) is left unverified.
- **From git** (a `type: git` resolution, a git host's tarball, GitHub's
  tarball of a commit, a `git+` source) alone: left unverified, as npm may build one as it installs it, and
  the registry's release of its name and version is another package. A
  module's recorded commit is no sign of one, as a registry package's
  `gitHead` is recorded too.
- **From a directory of the project** (a `file:` or `link:` one, an npm link):
  each installed copy's files held to the repository's in that directory at
  the commit, where the lockfile is the repository's (a GitHub repository and
  commit known). With a lockfile given on disk, left unverified.
- **From elsewhere** (another tarball, a `file:` one included, a path crate, a
  package another bundles): left unverified.
- **Not at all**: fails (`not locked by the lockfile`).

A version failing its lockfile is not compared, its files counted unverified.

## Where a package is installed

Node resolves an npm package by its path, so a bundle could otherwise hold a
version where another belongs (an old one the lockfile installs elsewhere, or
another package altogether). Each npm copy must be installed where the bundle
has it:

- **Its name**: the name its path installs it as (after its last
  `node_modules/`) is its own, but for an alias its lockfile has: npm's at that
  location, yarn's (`foo@npm:ms@…`) or pnpm's (`foo: ms@2.1.3`). pnpm's of a
  directory (`foo: lib@file:lib`, as a `file:` override installs one, hoisted
  under the name it overrides) is of the package of that name in the
  directory, any version its lockfile locks no other of: its files are held to
  the directory's (above).
- **pnpm's store**: a copy under `node_modules/.pnpm/<name>@<version>/`
  (its peers or patch after an `_`, a scope's `/` a `+`) is of that name and
  version. One pnpm hashed (a long name, or one with uppercase) tells no
  version, and one that is no registry's (`file+lib`) is held to its lockfile
  alone.
- **npm's lockfile** installs it there: the version `package-lock.json` (or
  `npm-shrinkwrap.json`) locks at its location, the bundle's directory's path
  from the lockfile's added in front. One given on disk takes that path where
  the bundle's directory is one of its workspaces, else its own directory. A
  location npm links to a directory of the project (a `file:` one) has no
  version there: it is held to that directory's files (above).

A copy installed where its path or its lockfile names another fails
(`misplaced`), its files counted unverified, wherever its other copies are. A
copy installed under another name with no lockfile to tell of an alias
(`--no-lockfile`, or none showing one) is unverified (`alias-unverified`), that
copy alone: the version's other copies are checked all the same. A crate is found by its `Cargo.toml`, not its
directory, so its place is not checked.

## Patched dependencies

A version pnpm patches as it installs it (its lockfile's `patchedDependencies`)
is held to its files patched, as pnpm applies the patch (patch-package's
algorithm, which pnpm bundles: each hunk where its header says, else up to 20
lines either side, its lines the same but for the space they end in, a byte
order mark the file starts with kept). The patch is the one the
`pnpm-lock.yaml` locks the version with, read of the bundle where it holds a
file of that hash, else beside the lockfile: of the repository, or of the disk
for one given, and held to that hash (`patch-mismatch` where it isn't). One
the lockfile names by its hash alone, as pnpm 11 does (its file in pnpm's
settings), is the file pnpm names for it (`patches/name@version.patch`, or by
its selector) in the `patches` directory of the bundle's project, else of the
repository's root (beside the lockfile, for one given on disk), whose text is
of that hash; with none, it is `in no file of its hash`. With no
`pnpm-lock.yaml` read (`--no-lockfile`, or npm's or yarn's), it is the patch
the bundle holds named for the version, pnpm's way (`patches/name@version.patch`).

A patch the bundle holds is own code, and is taken as the repository has it
alone: checked with own code, or, with `--only-deps`, checked all the same
(by git's blob id, as the repository's listing has it) where a repository and
commit are known. One the repository has otherwise, or not at all, is refused
(`is the bundle's, not the repository's`), the version held to its files as
published. Where it can't be checked (no repository known), the files only it
makes as they should be are left unverified.

Each patched version is listed, with its patch, where it was read, whether a
patch the bundle holds is as the repository has it, and whether the bundle
holds its files patched or as published. One whose patch couldn't be read or
applied is held to its files as published.

## The commit

GitHub serves a commit pushed to any fork of a repository through the
repository's own name too: its tree, its files and its lockfile read there
all the same. So the commit own code, the lockfile and the patches the bundle
holds are read at must be in the repository's own history: that of its
default branch, or a tag or a branch at it, or that of another of its
branches, as GitHub's compare tells it (the branch `ahead` of the commit, or
the same). One in none, a fork's say, is refused (exit 3), whether the bundle
records it or `--sha` gives it. The report names the ref that has it (`of
main`, `, tag v1.0.0`). Other branches are compared 100 at most: a commit at no
tag or branch head, nor in the default branch's history, of a repository with
more branches than that, is refused unless one of those compared has it
(`history-unread`).

## Access

GitHub is asked with `GITHUB_TOKEN` where it is set, for a private repository.
A repository renamed or transferred, which GitHub's API answers with a redirect
(`301 Moved Permanently`), is followed to the name it has now, asked once by
the id GitHub redirects to; what is read is held to the commit's and tree's ids
all the same, and the report tells the name it was moved from.
A private scoped npm package is fetched with `PREVENTIVE_MEASURES_NPM_TOKEN`,
`STASIS_NPM_TOKEN` or `NPM_TOKEN`, as upstream reads them. Trees and tarballs
are cached where `stasis audit` caches, each held to its id or integrity as it
is read.

## API

`@exodus/stasis/validate` exports the steps apart, for a caller reading a
repository or packages its own way (a server listing a tree's blob ids, say),
with their types (`src/validate.d.ts`):

| Export | |
| - | - |
| `validationPlan(bundle)` | A parsed bundle's own files, its files by package version, and the patches it holds. |
| `validateBundle(plan, own, { fetch, locked, generated, deadline })` | The report. `own` is the repository's files by their paths from its root, each `{ data }` (bytes), `{ sha }` (git's blob id), `{ symlink }` or `{ submodule: true }`, with `repository`, `commit`, `directory` and `cut`; or `{ reason }` it wasn't read (`skipped`, counted apart, as asked), with `entries` where the patches the bundle holds are checked all the same; or a promise of any, the packages fetched meanwhile. `locked` (`lockedBy`'s, null for none): `lock(ecosystem, name, version)` how its lockfile locks a version (`{ from: 'registry', integrity }`, `{ from: 'local', directories }`, `{ from: 'git' }`, `{ from: 'elsewhere' }`, null for not at all, undefined where no lockfile of its ecosystem was read), `tree(directory)` a directory's files of the repository by their paths in it, where it is read, `of(name, version)` the patch pnpm's locks it with (`{ hash, path }`, null for none, undefined where none tells), `read(path)` its text, read of `from` (`repository` or `local`), `installed(dir)` the version npm's lockfile installs at a copy's directory (`<name>@<version>`, null for none, undefined where its lockfile locks no location), `aliased(as, named)` whether it installs `named` under the name `as` (undefined for no lockfile). `fetch(ecosystem, name, version, integrity)` is `fetchPackage`'s. `generated()`, where given, is a promise of the Prisma Clients the repository's schemas generate (`{ dir, files, schema, generator, prisma }` each, `files` by their paths from `dir`, which is by its path from the bundle's root, as `schema` is), asked for once every other own file is checked, and only where one isn't the repository's: the report's `generated` lists the clients its files are generated by (`{ output, schema, generator, prisma, files }`), `counts.generated` counts them, and `generatedError` tells why, where `generated()` failed. |
| `validateRepository(plan, { repository, commit, directory }, { own, lockfile, listTree, strict, fetch, deadline, generated })` | A plan validated against `repository` (`followingMoves`'s, null for none) at `commit`, held to its history (`historyOf`), as `validate` validates a file. Own code is read of the commit's tree, its files' bytes; or, given `listTree(paths)`, of a listing of it (`{ entries, cut }`, as upstream's `listRepoTree` lists it, for the paths of the bundle's own files and of its directory's), by git's blob ids, the lockfile's directories' files named by it too. `lockfile` is `true` (the repository's), lockfiles as `lockedBy` takes them, or `false`. With `strict` false, no repository or commit to read own code or the lockfile of (`no-repository`, `no-commit`), a commit not of the repository's history (`commit-not-in-history`, `history-unread`), or no lockfile to hold the dependencies to is told in the report, not thrown: own code unverified for the `ValidateError`'s code (`own.reason`), and the dependencies held to their registry alone, the code told (`lockfileError`) where their lockfile went unread for it. `generated` is `validateBundle`'s. |
| `validate(file, { client, github, sha, directory, own, lockfile })` | What the CLI runs, with an `@preventive/upstream/github.js` client. `own: false` is `--only-deps`; `lockfile` is `true` (the repository's), an array of paths (`--lockfile`), or `false` (`--no-lockfile`). Throws a `ValidateError`, by its `code`, where it won't check a file. Own code the repository doesn't hold is held to the Prisma Clients its schemas generate (see [Generated Prisma Clients](#generated-prisma-clients)), read with `client`. |
| `exitCodeOf(report, { allowUnverified })` | The exit code a report stands for, as the CLI exits. |
| `printValidationReport(report, { out, err, showValid, colors })` | The report as the CLI prints it, to streams (`process.stdout` and `process.stderr`, else anything with `write`), the packages valid left out but with `showValid`, in colour where `colors` (else where each stream takes colours). |
| `followingMoves(client, github)` | `client`'s reads of a repository, followed where GitHub answers it has moved. |
| `historyOf(repository, commit, { maxCompared, deadline })` | The ref of `repository` (`followingMoves`'s) that has `commit` in its history, `{ branch }` or `{ tag }`, null for none: its default branch, a tag or a branch at it, then its other branches, `maxCompared` (100) at most and none past `deadline`; where one left uncompared might have it, a `ValidateError` (`history-unread`). |
| `lockedBy(lockfiles)` | `locked`, of lockfiles' paths and texts, each with `root`, the bundle's directory's path from the lockfile's, and `at`, the lockfile's directory's path from the bundle's (`''`, the default, for the same): several of one ecosystem where each is `at` another, a copy installed where the innermost holding it says, a version locked as any of them locks it. |
| `configuredLockfiles({ directory, list, read })` | The lockfiles the repository's `stasis.config.json` in `directory` names, by their paths from its root, undefined for none. |
| `lockedNpmPackages(dir)` | The registry's npm versions each lockfile installing a directory on disk locks, `[{ path, name, packages }]`: of those its `stasis.config.json` names, else of the one found (`stasis audit`'s, with no file). |
| `repositoryLockfiles({ directory, ecosystems, list, read })` | The repository's lockfiles that install `directory`, as `lockedBy` takes them. |
| `repositoryFiles`, `fetchPackage`, `fetchFailure`, `tarballFiles`, `gitBlobId`, `parsePatch`, `patchedFiles`, `isPatchOf` | The pieces those use. |

`@exodus/stasis/validate-notes` tells a report in words, as
`printValidationReport` does, and imports nothing, for a browser too (its
types in `src/validate-notes.d.ts`):
`OWN_REASONS`, `PACKAGE_REASONS`, `PATCH_ERRORS`, `FILE_REASONS` and
`LOCKFILE_ERRORS`, the text of each code a report gives (`own.reason`, a
package's `reason`, its `patch.error`, a problem's `reason`, `lockfileError`);
`noteOf(pkg)`, a package's note beside its status as parts, text and its paths
as `{ path }`, for a caller to set the paths apart; `noteText(pkg)`, the
note as text; and `generatedBy(client)`, what a client of the report's
`generated` is generated by (`prisma/schema.prisma's client (Prisma 7.10.0)`).
