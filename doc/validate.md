# `stasis validate`

`stasis validate` checks that a bundle (`stasis.code.br`) holds what it says it
does: its own code as its repository has it at the commit it was built from,
and each dependency as its published package has it, held to the lockfile that
installed it, those two covering every file it holds.

```sh
stasis validate [--github=owner/name] [--sha=commit] [--directory=path] [--only-deps] [--lockfile=path | --no-lockfile] path/to/bundle
```

| Flag | Meaning |
| - | - |
| `--github` | The repository its own code and its lockfile are read of, in place of the one the bundle's `repo` names. |
| `--sha` | The commit, in place of the bundle's `repo.commit`. |
| `--directory` | The directory in the repository it was built in, in place of the bundle's `repo.directory`. |
| `--only-deps` | Check the dependencies alone: own code is left unverified, and the repository's tree is not read. |
| `--lockfile=path` | Hold the dependencies to this lockfile, on disk, in place of the repository's. Give it twice for a bundle with both npm packages and crates. |
| `--no-lockfile` | Hold the dependencies to no lockfile: each tarball to its registry's integrity alone. |

Both checks are on unless turned off. A bundle that records no repository or
commit, with none given, is refused (exit 1), since its own code can't be read:
`--only-deps` validates its dependencies alone. Those still need a lockfile,
which is read of the repository: give one with `--lockfile`, or opt out with
`--no-lockfile`. A bundle with no npm package or crate needs none.

Exits 1 when a file differs or is unexpected, or a version fails its lockfile,
and 0 otherwise, so it composes in CI: files left unverified are told, not
failed. The files failing and the packages patched, failing or not checked go
to stdout, a line each; the summary, why own code wasn't checked, and the
lockfiles the dependencies were held to go to stderr. A refusal (no repository
or commit, no lockfile, a lockfile it can't read) exits 1 with the error alone.

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
   passes, and is counted. A path the repository has as a symlink differs; one
   it hasn't, or has in a submodule, is unexpected.
2. **Dependencies** are fetched with upstream: an npm package from npm's
   registry, a crate from crates.io. Each is held to its lockfile (below): a
   version the lockfile locks of its registry is fetched with the integrity it
   locks (an npm version's sha512, a crate's checksum), which upstream holds the
   tarball to in place of the registry's, refusing one that differs. Each file
   the bundle holds of a package must match the file at its path there. Files
   of a package the bundle leaves out are expected: a bundle holds those its
   code reaches alone. Each installed copy of a version is held to it apart, and
   the version fetched once. A vendored crate's `.cargo-checksum.json`, which
   `cargo vendor` writes and no crate holds, is held to the crate: its package
   checksum, and the sha256 of each file it lists.
3. **Coverage**: every file the bundle holds must be one or the other. Stasis's
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

## Lockfiles

The lockfile is the repository's at the commit, the one that installs the
bundle's directory, found as [`github-bundle`](github-bundle.md) finds each
package manager's root. For npm packages it is the one package manager's that
installs it:

- **pnpm**: the workspace root's `pnpm-lock.yaml` (the nearest directory at or
  above it holding `pnpm-workspace.yaml`), whatever lockfile is nearer; without
  a workspace, the nearest.
- **npm**: the `package-lock.json` (or `npm-shrinkwrap.json`, which npm takes
  before it in the same directory) of the root whose `package.json`'s
  `workspaces` take the package, whatever lockfile is nearer; else the nearest
  beside a `package.json`.
- **yarn 1**: the workspace root's `yarn.lock`, where the package is the root
  or one of its workspaces; else the nearest.

For crates it is the nearest `Cargo.lock`. Lockfiles of two package managers
installing it, a `bun.lock`, or none is refused: give one with `--lockfile`.
One that can't be read (yarn 2's, say) is refused too.

Each npm version or crate the bundle holds must be one its lockfile locks:

- **Of its registry** (npm's or a mirror's tarball of it, crates.io): fetched
  with the integrity it locks. A tarball upstream refuses for it fails the
  version (`its registry's tarball is not the one the lockfile locks`), as does
  a version the lockfile locks with two. One locked with no sha512 (a yarn
  entry with a sha1 alone) is left unverified.
- **From git** (a `type: git` resolution, a git host's tarball, a `git+`
  source) alone: left unverified, as npm may build one as it installs it, and
  the registry's release of its name and version is another package. A
  module's recorded commit is no sign of one, as a registry package's
  `gitHead` is recorded too.
- **From elsewhere** (another tarball, a directory, a path crate, a package
  another bundles): left unverified.
- **Not at all**: fails (`not locked by the lockfile`).

A version failing its lockfile is not compared, its files counted unverified.

## Patched dependencies

A version pnpm patches as it installs it (its lockfile's `patchedDependencies`)
is held to its files patched, as pnpm applies the patch (patch-package's
algorithm, which pnpm bundles: each hunk where its header says, else up to 20
lines either side, its lines the same but for the space they end in, a byte
order mark the file starts with kept). The patch is the one the
`pnpm-lock.yaml` locks the version with, read of the bundle where it holds a
file of that hash (pnpm 11 names a patch by its hash alone), else beside the
lockfile: of the repository, or of the disk for one given, and held to that
hash (`patch-mismatch` where it isn't). With no
`pnpm-lock.yaml` read (`--no-lockfile`, or npm's or yarn's), it is the patch
the bundle holds named for the version, pnpm's way (`patches/name@version.patch`).

Each patched version is listed, with its patch, where it was read, and whether
the bundle holds its files patched or as published. One whose patch couldn't be
read or applied is held to its files as published.

## Access

GitHub is asked with `GITHUB_TOKEN` where it is set, for a private repository.
A private scoped npm package is fetched with `PREVENTIVE_MEASURES_NPM_TOKEN`,
`STASIS_NPM_TOKEN` or `NPM_TOKEN`, as upstream reads them. Trees and tarballs
are cached where `stasis audit` caches, each held to its id or integrity as it
is read.

## API

`@exodus/stasis/validate` exports the steps apart, for a caller reading a
repository or packages its own way (a server listing a tree's blob ids, say):

| Export | |
| - | - |
| `validationPlan(bundle)` | A parsed bundle's own files, its files by package version, and the patches it holds. |
| `validateBundle(plan, own, { fetch, locked, deadline })` | The report. `own` is the repository's files by their paths from its root, each `{ data }` (bytes), `{ sha }` (git's blob id), `{ symlink }` or `{ submodule: true }`, with `repository`, `commit`, `directory` and `cut`; or `{ reason }` it wasn't read. `locked` (`lockedBy`'s, null for none): `lock(ecosystem, name, version)` how its lockfile locks a version (`{ from: 'registry', integrity }`, `{ from: 'git' }`, `{ from: 'elsewhere' }`, null for not at all, undefined where no lockfile of its ecosystem was read), `of(name, version)` the patch pnpm's locks it with (`{ hash, path }`, null for none, undefined where none tells), `read(hash, path)` its text. `fetch(ecosystem, name, version, integrity)` is `fetchPackage`'s. |
| `validate(file, { client, github, sha, directory, own, lockfile })` | What the CLI runs, with an `@preventive/upstream/github.js` client. `own: false` is `--only-deps`; `lockfile` is `true` (the repository's), an array of paths (`--lockfile`), or `false` (`--no-lockfile`). Throws a `ValidateError`, by its `code`, where it won't check a file. |
| `lockedBy(lockfiles)` | `locked`, of lockfiles' paths and texts. |
| `repositoryLockfiles({ directory, ecosystems, list, read })` | The repository's lockfiles that install `directory`, as `lockedBy` takes them. |
| `repositoryFiles`, `fetchPackage`, `fetchFailure`, `tarballFiles`, `gitBlobId`, `parsePatch`, `patchedFiles`, `isPatchOf` | The pieces those use. |
