# `stasis extract`

`stasis extract` writes every source of a `stasis.code.br` bundle to its
project-relative path, verifying the bundle against the `stasis.lock.json`
already there, or with `--lock=add` writing a matching one. The zero-dependency
`stasis-core extract` has the same flags and behaviour.

```sh
stasis extract [--output=path/to/dir] [--lock=(frozen|add|replace|ignore|none)] path/to/bundle.stasis.code.br
stasis-core extract [--output=path/to/dir] [--lock=(frozen|add|replace|ignore|none)] path/to/bundle.stasis.code.br
```

| Argument | Meaning |
| --- | --- |
| `--output` / `-o` | Directory to extract into, created as needed. Defaults to cwd. |
| `--lock=mode` | What to do with the output dir's `stasis.lock.json`, see [The lockfile](#the-lockfile---lock). Defaults to `frozen` when the file is there, else `none`. |
| positional | The brotli-compressed `stasis.code.br` bundle to read. |

Without any stasis package installed, the repository's
[`scripts/stasis-extract.mjs`](../scripts/stasis-extract.mjs), a single file of
Node builtins published in no package, writes what `stasis extract --lock=none`
writes, from v1 bundles only:
`node scripts/stasis-extract.mjs [--output=path/to/dir] path/to/bundle.stasis.code.br`.
It checks nothing of the bundle beyond what decides what is written (the scope,
the files, their formats and execute bits). It refuses an output dir holding a
`stasis.lock.json` or, for a `<name>.stasis.code.br` bundle, a
`<name>.stasis.lock.json`, and a bundle carrying a forbidden file (see
[Untrusted input](#untrusted-input)), naming it.

## What it writes

Code files are written as their source text, resources decoded per their
`formats` entry (`resource:base64` from base64, `resource` from raw UTF-8).

The lockfile it derives hashes each file's recorded UTF-8 bytes (sha512) into
the SRI digest `stasis run` would record, and copies the bundle's `entries`,
package dirs, `name`/`version` and `imports`. `stasis prune` works directly
against the extracted tree; `stasis run --lock=frozen` also needs the project's
`package.json` files, present only if the bundle recorded them.

A legacy `version: 0` bundle records no `name`/`version`, so derives no
lockfile: it extracts only into a directory without one, or with
`--lock=ignore`, and `add` or `replace` skip the lockfile with a warning.

## What is already there

`extract` never overwrites a file with other bytes. A file already at a target
path (or a symlink to one) that holds exactly what the bundle would write there
is not rewritten. In every `--lock` mode, anything else at a target refuses the
extract before the first write:

- a file with other content,
- a directory, or a dangling symlink, where a file goes,
- a file, or a dangling symlink, where a directory goes (the output dir included).

No write, of a bundled path or the lockfile, may land on the bundle being read,
under any name (a symlink or hard link to it). Otherwise the lockfile is the
one file `extract` rewrites, as `--lock` says.

A file that appears between the check and the write, or a second path a
case-insensitive disk folds onto an earlier one, fails that write.

## The lockfile (`--lock`)

| Mode | Behavior |
| - | - |
| `frozen` | The output dir's `stasis.lock.json` must be the lockfile the bundle derives, checked before the first write and never rewritten. |
| `add` | The derived lockfile is merged into the one there, which must agree with it on everything both record: what is new is recorded, nothing recorded changes. Without one there, the derived lockfile is written. |
| `replace` | The derived lockfile is written, replacing any already there. |
| `ignore` | The lockfile is neither read nor written, whether or not one is there. |
| `none` | No lockfile: none is read or written, and one already there is an error. |

`frozen` needs a lockfile in the output dir, and the derived lockfile must equal
it in every field (`config`, `entries`, each package's name, version and file
hashes, `imports`, `formats` and `executable`), compared as parsed, so
formatting doesn't matter. A mismatch is refused, naming the first difference.

`add` lets bundles that each carry part of a tree, such as a split layout's code
bundle and its `--resources-bundle-file`, extract into it, adding their files to
one lockfile. A file both record must carry the same hash, format and execute
bit, a package the same name and version, an import the same target, or the
extract is refused before the first write. Only a payload-free `stat:file` or
`stat:directory` record (a path's kind alone) changes: content the bundle
carries for that path, of the same kind, replaces it (see
[filesystem captures](file-formats.md#filesystem-captures-stasis-run---fssync----fsasync)).

## The execute bit

A bundle records whether each file is executable (see
[file-formats.md](file-formats.md#executable-files)), and that is the only bit
`extract` touches:

- The execute bit is adjusted on *every* extracted file, and only on those: for
  an executable, execute is added wherever the file is readable, and always for
  the owner; re-extracting over a tree already holding the bundle's bytes
  **drops** an execute bit the bundle no longer records.
- Read and write bits are left as the write produced them: umask-derived for a
  file `extract` creates (`0644`, so an executable becomes `0755`), and the
  file's own for one already in place (a `0600` file stays `0600`).
- `setuid`/`setgid`/sticky are cleared from anything `extract` extracts.
- Modes are left alone for a legacy `version: 0` bundle and on Windows.
- A filesystem that can't store modes (vfat/exFAT/CIFS, some bind mounts) is
  tolerated per file: the bytes still land, any lockfile is still written, and
  the count of files whose mode could not be set is reported.

> [!NOTE]
> A target that is itself a **symlink** is never written through or `chmod`ed:
> it is left in place when its target already holds the bundle's bytes, and
> refused otherwise.

## Untrusted input

`extract` treats the bundle as untrusted, refusing before the first write a
bundle with:

- paths that escape the output directory,
- non-canonical paths (mid-path `..` or `.`, empty segments or file names),
- paths holding a `\` (see [file formats](file-formats.md)),
- duplicate paths, or a path used as both a file and a directory,
- non-string file contents,
- a file named `stasis.lock.json` or `<name>.stasis.lock.json`, at any depth and in any case (see [file formats](file-formats.md#stasiscodebr)),
- a package manager's hook (`.pnpmfile.cjs`) or config (`.npmrc`), a Yarn Plug'n'Play file (`.pnp.cjs`) or `.git`, or, in a dependency, a `pnpm-workspace.yaml` or `.env` file, at any depth and in any case (see [file formats](file-formats.md#stasiscodebr) for every name).

The path checks are lexical: writes pass through any symlinked directory
already inside the output directory (e.g. a pnpm-managed `node_modules`),
creating files there. Extract untrusted bundles into a fresh, empty directory,
or one holding nothing but the trusted `stasis.lock.json` to verify them
against.
