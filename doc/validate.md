# `stasis validate`

`stasis validate` checks that a bundle (`stasis.code.br`) holds what it claims:
its own code as its repository has it at the commit it was built from, and each
dependency as its published package has it, held to the lockfile that installed
it. Together these must cover every file it holds.

```sh
stasis validate [--github=owner/name] [--sha=commit] [--directory=path] [--only-deps] [--lockfile=path | --no-lockfile] [--allow-unverified] [--show-valid] path/to/(bundle|stasis.lock.json|name.stasis.tgz)
```

| Flag | Meaning |
| - | - |
| `--github` | The repository to read own code and the lockfile from, instead of the bundle's (or lockfile's) `repo`. |
| `--sha` | The commit, instead of the bundle's (or lockfile's) `repo.commit`. |
| `--directory` | The directory in the repository it was built in, instead of the bundle's (or lockfile's) `repo.directory`. |
| `--only-deps` | Check only the dependencies: own code is skipped and the repository's tree is not read. The bundle's patches are still checked where a repository and commit are known (below). |
| `--lockfile=path` | Hold the dependencies to this lockfile on disk instead of the repository's. Give it twice for a bundle with both npm packages and crates. |
| `--no-lockfile` | Use no lockfile: hold each tarball to its registry's integrity alone. |
| `--allow-unverified` | Exit 0 when the bundle is `incomplete` (files went unverified, nothing failed). |
| `--show-valid` | Also list valid packages (the patched ones), each with its patch. |

Own code and dependencies are both checked unless turned off. A bundle that
records no repository or commit, with none given, is refused (exit 3);
`--only-deps` validates its dependencies alone. They still need a lockfile,
normally read from the repository: give one with `--lockfile`, or opt out with
`--no-lockfile`. A bundle with no npm package or crate needs none.

It exits:

| Code | |
| - | - |
| 0 | `valid`: every file to check was checked and matches. Own code skipped with `--only-deps` doesn't count. |
| 1 | `invalid`: a file differs or is unexpected, a version fails its lockfile or what it records, a copy is installed where another belongs, or it contradicts the `stasis.lock.json` the repository commits. |
| 2 | `incomplete`: nothing failed, but some files went unverified (a package that couldn't be fetched, one locked from git, a Composer package, …). 0 with `--allow-unverified`. |
| 3 | Refused (no repository or commit, a commit of no branch or tag of the repository, no lockfile, an unreadable lockfile, a tgz that isn't exactly its `stasis.lock.json`'s files, a usage error) or failed (GitHub refusing the repository, say), with only the error on stderr. |

The report goes to stdout as tables:

- **Files**: those that differ, then unexpected ones, then own code left
  unverified. Each status has one row for own code, then one per package (npm
  by name and version, others with their ecosystem), listing its files, each
  with a reason where there is one (a symlink, a submodule). Past 500, the rest
  are counted.
- **Packages**: those with something to report, invalid first, then
  unverified: why one is unverified or fails its lockfile, its patch, or the
  repository directory it is held to. One failing only for its files is in the
  Files table; a valid one is listed, with its patch, only with `--show-valid`.
  An ecosystem column appears when one isn't npm.
- **Generated**: files the repository's Prisma schemas generate but it doesn't
  hold, one row per client: the schema, its generator and the Prisma version
  (see [Generated Prisma Clients](#generated-prisma-clients)).

To stderr go the summary (the status, and counts of files and packages,
generated files among them), why own code wasn't checked, why no Prisma Client
could be generated, and the lockfiles the dependencies were held to. Statuses
are coloured (failing red, unverified yellow, valid green) in CI (`CI` set) or a
colour terminal; not in a pipe or a file.

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
   and its workspace's packages, see [file formats](file-formats.md)), plus the
   root module's and those of an `npm` module outside `node_modules`, whatever
   they record. Each must be the repository's, byte for byte, at its path under
   the directory the bundle was built in. The tree is read as
   [`github-bundle`](github-bundle.md) reads one: its tarball, held to the
   tree's id. A file whose only difference is CRLF line endings (on every line)
   passes, and is counted; not a binary resource (`resource:base64`), a shell
   script or an env file. A path the repository has as a symlink differs; one
   it hasn't, or has in a submodule, is unexpected.
2. **Dependencies** are fetched: an npm package from npm's registry, a crate
   from crates.io. Each is held to its lockfile (below): a registry version is
   fetched with the integrity the lockfile locks (an npm version's sha512, a
   crate's checksum), and a tarball that doesn't match it is refused. Each file
   the bundle holds of a package must match the file at its path there; files
   the bundle leaves out are fine. Each installed copy of a version is checked
   separately. An npm copy is also held to where it is installed (below). A
   vendored crate's `.cargo-checksum.json` is held to the crate: its package
   checksum, and the sha256 of each file it lists.
3. **Coverage**: every file the bundle holds must be own code or a
   dependency's, or a file of a Prisma Client the repository's schemas generate
   (below). Stasis's empty stub for an import a package disables
   (`.stasis/empty-module.js`) is allowed.
4. **The stasis.lock.json the repository commits** in that directory, if any:
   the bundle must agree with it on each file both record, and on each module's
   name, version, `integrity` and `patch` (including a patch the lockfile
   records and the bundle doesn't). A contradiction makes it `invalid`, reported
   on stderr (`stasisLockfile`).

A `stasis.lock.json` is validated like a bundle, each file by the integrity it
records, against the repository's bytes (or their CRLF form) and the package's.
One [`stasis github-bundle`](github-bundle.md#local-lockfile) writes records the
repository, commit and directory; for one written otherwise, give `--github` and
`--sha`. Against a listing of the repository's tree (git blob ids only), its own
code is left unverified; a vendored crate's `.cargo-checksum.json`, checked by
its bytes, is skipped.

A [`.stasis.tgz`](file-formats.md#stasistgz) is validated as a bundle of its
files, against the repository and commit its `stasis.lock.json` records. One
that isn't exactly the files its lockfile attests, or a tgz by another name, is
refused (exit 3), naming the path.

Composer packages, Soldeer zips, and crates vendored from git or with no
`.cargo-checksum.json` can't be fetched by name and version: their files are
left unverified, as are those of a version that couldn't be fetched
(`not published`, `its registry refused it`). A Composer or Soldeer package is
held to the `composer.lock` or `soldeer.lock` in the bundle's directory at the
commit, if there is one (or one `--lockfile` gives): a version it doesn't lock
fails, its `integrity` must be the one locked, and one locked from git
(Composer's git source, Soldeer's `rev`) is held to its repository at that
commit, as for npm (below). A Foundry `lib/` submodule (`github`) is held to the
repository it records, at the commit the repository's tree pins at its path:
one recording another commit fails
(`records another commit than its repository's tree pins it at`), and one at a
path with no submodule in the tree is left unverified.

A file that differs is `differs`; one neither the repository nor its package has
is `unexpected`.

## Generated Prisma Clients

A bundle [`github-bundle`](github-bundle.md#prisma) builds carries the Prisma
Client each project's schema generates, which the repository doesn't hold. Own
code that doesn't match the repository (a file it lacks, or has otherwise) is
held to the clients the repository's schemas generate at the commit, generated
as `stasis github-bundle` would for a bundle of that directory, each with the
`prisma` its lockfile installs. A file in a client's output is:

- **generated** if it is that client's file, byte for byte: counted as it should
  be, and listed with the client;
- **differs** (`not as the repository's Prisma schema generates it`) if the
  client has another file at its path;
- **unexpected** (`in a Prisma Client's output, which generates no such file`)
  if the client has none there.

A file in no client's output is reported as usual, and a file the repository
holds is held to the repository alone, so a committed client is checked as own
code. Clients are generated only where some own file isn't the repository's,
whatever the repository's `stasis.config.json` says of `generatePrisma` and
`installDevDependencies` (the trees are laid out with their devDependencies):
what is checked is that a file is what its schema
generates, not that a bundle would have generated it. An output two generators
write is held to each. An edge runtime's client is held to the query compiler of
the `prisma` its lockfile installs.

Generating needs the optional `@prisma/client-generator-ts` 7.10.0 peer
dependency. If the clients can't be generated (the peer missing, the repository
or a package not read), the files are reported as found, and the summary says
why.

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
bundle's directory, found among the directories at and above it by the rules
[`github-bundle`](github-bundle.md) uses (each package manager's root). For npm
packages it is that of the one package manager installing it:

- **pnpm**: the workspace root's `pnpm-lock.yaml` (the nearest directory at or
  above it holding `pnpm-workspace.yaml`), even if another lockfile is nearer;
  without a workspace, the nearest.
- **npm**: the `package-lock.json` (or `npm-shrinkwrap.json`, which takes
  precedence in the same directory) of the root whose `package.json`
  `workspaces` include the package, even if another lockfile is nearer; else the
  nearest beside a `package.json`.
- **yarn 1**: the workspace root's `yarn.lock`, where the package is the root
  or one of its workspaces; else the nearest.

For crates it is the `Cargo.lock` beside the workspace root's `Cargo.toml` (the
nearest at or above it with a `[workspace]`), else beside the directory's own;
never one further up. Lockfiles of two package managers, a `bun.lock`, or none
is refused: give one with `--lockfile`. An unreadable one (yarn 2's, say) is
refused too.

If the repository's `stasis.config.json` in the bundle's directory names
[`lockfiles`](github-bundle.md#several-lockfiles-lockfiles), none is searched
for: the dependencies are held to those named, read from the repository at the
commit. Several of one ecosystem are allowed (a root `pnpm-lock.yaml` and
`tools/package-lock.json`, say): each copy is held only to the innermost one
holding it, for where it is installed, whether its version is locked, its
integrity and its patch. A copy none holds fails. A `composer.lock` or
`soldeer.lock` among them holds its packages as above. A named lockfile that is
missing or outside the repository is refused, as is a config naming none that
locks the bundle's npm packages or crates. `--lockfile` and `--no-lockfile`
still override it.

Each npm version or crate the bundle holds must be one its lockfile locks:

- **Of its registry** (npm's or a mirror's tarball of it, crates.io): fetched
  with the integrity it locks. A tarball that doesn't match fails the version
  (`its registry's tarball is not the one it is locked or recorded with`), as
  does a version locked or recorded with two. Where no sha512 is locked (no
  lockfile read, a yarn entry with only a sha1), its recorded integrity is
  used; with neither, it is left unverified.
- **From git** (a `type: git` resolution, a git host's tarball, GitHub's
  tarball of a commit, a `git+` source): a version locked at one full commit of
  a GitHub repository is held to that repository's tree at the commit, under
  the path it names: a file there with other bytes differs, and one missing
  there (an install may build it) is left unverified (`git-built`). Any other
  (another host's, a crate's) is left unverified. Only the lockfile marks a
  version as from git: a module's recorded commit doesn't, as registry packages
  record `gitHead` too.
- **From a directory of the project** (a `file:` or `link:` one, an npm link):
  each installed copy's files are held to the repository's in that directory
  at the commit, when the lockfile is the repository's. With a lockfile given
  on disk, left unverified.
- **From elsewhere** (another tarball, a `file:` one included, a path crate, a
  package another bundles): left unverified.
- **Not at all**: fails (`not locked by the lockfile`).

An `integrity` a copy records must be the one the lockfile locks, wherever it is
locked from.

A version that fails its lockfile isn't compared; its files count as
unverified.

## Packages installed from a directory

A dependency the bundle records as `npm:directory` (see
[file formats](file-formats.md#stasiscodebr)), a `file:` directory's package
that pnpm or yarn copied into `node_modules`, names the directory it was
installed from. Each copy's files are held to the repository's in that
directory (relative to the bundle's directory) at the commit: a file with other
bytes differs, and one missing there is unexpected. A bin whose `#!` line ends
in CRLF there may have that CR dropped, as pnpm before 12 copies it (likewise
for an older `npm` record, below). Nothing is fetched and no lockfile is needed,
so it is checked even with `--no-lockfile` and `--only-deps` (the repository is
read for it). Where an npm lockfile is read (the repository's, if there is one,
though it is required only for registry packages; or one `--lockfile` gives),
it must install a package of that name from that very directory, else it fails
(`records a directory its lockfile doesn't install it from`). One outside the
repository is left unverified, as is any with no repository and commit to read
it from. It is held to the directory's files whatever name it is installed
under, so no alias is required; its place in pnpm's store is checked as any
copy's (below).

An older stasis records such a package as `npm`, with no integrity. It is held
to the directory its lockfile installs a package of its name from (above,
`From a directory of the project`). Such a record with an integrity fails.

## Where a package is installed

Each npm copy must be installed where the bundle has it, so a bundle can't put a
version where another belongs (an old one, or another package):

- **Its name**: the name in its path (after its last `node_modules/`) is its
  own, unless its lockfile has an alias: npm's at that location, yarn's
  (`foo@npm:ms@…`) or pnpm's (`foo: ms@2.1.3`). A pnpm alias of a directory
  (`foo: lib@file:lib`, as a `file:` override installs one, under the name it
  overrides) is of the package of that name in the directory, at any version
  its lockfile doesn't otherwise lock: its files are held to the directory's
  (above).
- **pnpm's store**: a copy under `node_modules/.pnpm/<name>@<version>/` (its
  peers or patch after an `_`, a scope's `/` a `+`) is of that name and
  version. One pnpm hashed (a long name, or one with uppercase) gives no
  version, and one from no registry (`file+lib`) is held to its lockfile alone.
- **npm's lockfile** installs it there: the version `package-lock.json` (or
  `npm-shrinkwrap.json`) locks at its location, prefixed with the bundle's
  directory's path from the lockfile's. A lockfile given on disk uses that
  prefix where the bundle's directory is one of its workspaces, else its own
  directory. A location npm links to a directory of the project (a `file:` one)
  has no version there: it is held to that directory's files (above).

A copy installed where its path or its lockfile names another fails
(`misplaced`), its files counted unverified, wherever its other copies are. A
copy installed under another name with no lockfile showing an alias
(`--no-lockfile`, or none showing one) is unverified (`alias-unverified`); the
version's other copies are still checked. A crate's place is not checked.

## Patched dependencies

A version pnpm patches on install (its lockfile's `patchedDependencies`) is
held, in every copy, to its files patched as pnpm applies the patch (each hunk
where its header says, else up to 20 lines either side, ignoring trailing
whitespace, keeping a leading byte order mark), so a copy bundled as published
differs. The patch is the one `pnpm-lock.yaml` locks the version with, read from
the bundle if it holds a file of that hash, else from beside the lockfile (in
the repository, or on disk for one given), and held to that hash
(`patch-mismatch` if not). One the lockfile names by hash alone, as pnpm 11
does, is the file pnpm names for it (`patches/name@version.patch`, or by its
selector) in the `patches` directory of the bundle's project, else of the
repository's root (beside the lockfile, for one given on disk), whose text has
that hash; with none, it is `in no file of its hash`. With no `pnpm-lock.yaml`
read (`--no-lockfile`, or npm's or yarn's), it is the patch the bundle holds
named for the version (`patches/name@version.patch`), and each copy is held to
its files patched or as published.

A copy that records its patch ([`patch`](file-formats.md#stasiscodebr)) is
held to its files patched with it. Its version fails if its copies record
different patches (`patch-conflict`), or the npm lockfile read locks another or
none (`patch-not-locked`); with none read, the recorded hash picks the patch. A
copy recording the patch's `file` fails if that isn't, from the bundle's root,
the file the patch was found in (`patch-file-mismatch`): the bundle's, or the
one the lockfile names or its hash picks in a patches directory.

A copy that records an [`integrity`](file-formats.md#stasiscodebr) and no patch
is taken as installed unpatched, and held to its files as published; the
bundle's patch for its version isn't tried. Its version fails if another copy
records a patch (`patch-conflict`), or the lockfile read patches it
(`patch-not-recorded`).

A patch the bundle holds is own code, and must be the repository's: it is
checked with own code, or, with `--only-deps`, still checked (by git's blob id)
where a repository and commit are known. One the repository has otherwise, or
not at all, is refused (`is the bundle's, not the repository's`), like one that
couldn't be read (below). Where it can't be checked (no repository known), the
files that match only with it applied are left unverified.

Each patched version is listed with its patch, where it was read from, whether a
patch the bundle holds matches the repository, whether its copies record it, and
whether the bundle holds its files patched or as published. A copy to be
patched by a patch that couldn't be read or applied is never valid: its files
as published are left unverified, the others fail.

## The commit

GitHub serves a commit pushed to any fork of a repository through the
repository's own name too. So the commit that own code, the lockfile and the
bundle's patches are read at must be in the repository's own history: that of
its default branch, a tag or branch at it, or another branch's, as GitHub's
compare reports it (the branch `ahead` of the commit, or identical). Any other,
a fork's say, is refused (exit 3), whether the bundle records it or `--sha`
gives it. The report names the ref that has it (`of main`, `, tag v1.0.0`). At
most 100 other branches are compared: in a repository with more, a commit at no
tag or branch head and not in the default branch's history is refused unless a
compared branch has it (`history-unread`).

## Access

GitHub is asked with `GITHUB_TOKEN` if set, for a private repository. A renamed
or transferred repository (a `301 Moved Permanently` from GitHub's API) is
followed to its current name; what is read is still held to the commit's and
tree's ids, and the report names the old name. A private (scoped) npm package
is fetched with the first set of `PREVENTIVE_MEASURES_NPM_TOKEN`,
`STASIS_NPM_TOKEN` and `NPM_TOKEN`; with none set, with the token `~/.npmrc`
gives npm's registry on a line that is exactly
`//registry.npmjs.org/:_authToken=npm_…` (the last, if several), as
[github-bundle](github-bundle.md#dependencies) does. An `~/.npmrc` that isn't
valid UTF-8 is refused. Trees and tarballs are cached where `stasis audit`
caches, each held to its id or integrity when read.

## API

`@exodus/stasis/validate` exports the steps separately, for a caller reading a
repository or packages its own way (a server listing a tree's blob ids, say),
with types in `src/validate.d.ts`:

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

`@exodus/stasis/validate-notes` puts a report into words as
`printValidationReport` does, and imports nothing, so it runs in a browser too
(types in `src/validate-notes.d.ts`): `OWN_REASONS`, `PACKAGE_REASONS`,
`PATCH_ERRORS`, `FILE_REASONS` and `LOCKFILE_ERRORS`, the text of each code a
report gives (`own.reason`, a package's `reason`, its `patch.error`, a
problem's `reason`, `lockfileError`); `noteOf(pkg)`, a package's note as parts,
text and its paths as `{ path }`, so a caller can set the paths apart;
`noteText(pkg)`, the note as text; and `generatedBy(client)`, what a client in
the report's `generated` is generated by
(`prisma/schema.prisma's client (Prisma 7.10.0)`).
