# `stasis validate`

`stasis validate` checks that a bundle (`stasis.code.br`) holds what it says it
does: its own code as its repository has it at the commit it was built from,
and each dependency as its published package has it, those two covering every
file it holds.

```sh
stasis validate [--github=owner/name] [--sha=commit] [--directory=path] [--no-own] path/to/bundle
```

| Flag | Meaning |
| - | - |
| `--github` | The repository its own code is checked against, in place of the one the bundle's `repo` names. |
| `--sha` | The commit, in place of the bundle's `repo.commit`. |
| `--directory` | The directory in the repository it was built in, in place of the bundle's `repo.directory`. |
| `--no-own` | Check the dependencies alone: own code is left unverified, and the repository is not read. |

Exits 1 when a file differs or is unexpected, and 0 otherwise, so it composes
in CI: files left unverified are told, not failed. The files failing and the
packages patched, failing or not checked go to stdout, a line each; the summary,
and why own code wasn't checked, go to stderr.

```sh
stasis validate app.stasis.code.br
GITHUB_TOKEN=... stasis validate --sha=<commit> app.stasis.code.br
stasis validate --no-own app.stasis.code.br
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
2. **Dependencies** are fetched with upstream, which holds each tarball to the
   integrity its registry publishes for it (not the lockfile's): an npm package
   from npm's registry, by its `dist.integrity`, a crate from crates.io, by its
   index's checksum. Each
   file the bundle holds of a package must match the file at its path there.
   Files of a package the bundle leaves out are expected: a bundle holds those
   its code reaches alone. Each installed copy of a version is held to it apart,
   and the version fetched once. A vendored crate's `.cargo-checksum.json`,
   which `cargo vendor` writes and no crate holds, is held to the crate: its
   package checksum, and the sha256 of each file it lists.
3. **Coverage**: every file the bundle holds must be one or the other. Stasis's
   own empty stub for an import a package disables (`.stasis/empty-module.js`)
   is allowed.

Composer packages, Soldeer packages, GitHub repos (Foundry's `lib/`) and crates
vendored from git, or with no `.cargo-checksum.json`, have no package upstream
fetches by name and version: their files are left unverified, as are those of a
version that couldn't be fetched (`not published`, `its registry refused it`).
So are an npm version's the lockfile locks from git alone (a `type: git`
resolution, or a git host's tarball, `gitHosted`): npm may build one as it
installs it, and the registry's release of its name and version is another
package, never held to it. A module's recorded commit is no sign of one, as a
registry package's `gitHead` is recorded too. With no lockfile read, such a
version is held to the registry's, and likely fails.

A file differing is `differs`, one neither the repository nor its package has
`unexpected`. The bundle is `valid` where every file was checked and matches,
`invalid` where any differs or is unexpected, and `incomplete` where nothing
failed but some files weren't checked.

## Patched dependencies

A version pnpm patches as it installs it (its lockfile's `patchedDependencies`)
is held to its files patched, as pnpm applies the patch (patch-package's
algorithm, which pnpm bundles: each hunk where its header says, else up to 20
lines either side, its lines the same but for the space they end in, a byte
order mark the file starts with kept). The patch
is the one the `pnpm-lock.yaml` pnpm installs the bundle's directory from locks
the version with (the workspace root's, the nearest directory at or above it
holding `pnpm-workspace.yaml`, whatever lockfile is nearer; else the nearest), read of the bundle where it holds a file of that hash (pnpm 11
names a patch by its hash alone), else of the repository. With no lockfile read
(`--no-own`, or a bundle naming no repository), it is the patch the bundle holds
named for the version, pnpm's way (`patches/name@version.patch`).

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
| `validateBundle(plan, own, { fetch, locked, deadline })` | The report. `own` is the repository's files by their paths from its root, each `{ data }` (bytes), `{ sha }` (git's blob id), `{ symlink }` or `{ submodule: true }`, with `repository`, `commit`, `directory` and `cut`; or `{ reason }` it wasn't read. `locked.of(name, version)` gives the lockfile's patch (`{ hash, path }`, null for none, undefined where no lockfile tells), `locked.read(hash, path)` its text, `locked.git(name, version)` whether it is locked from git alone. |
| `validate(file, { client, github, sha, directory, own })` | What the CLI runs, with an `@preventive/upstream/github.js` client. |
| `repositoryFiles`, `lockedPatches`, `fetchPackage`, `tarballFiles`, `gitBlobId`, `parsePatch`, `patchedFiles`, `isPatchOf` | The pieces those use. |
