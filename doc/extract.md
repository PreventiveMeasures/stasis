# `stasis extract`

`stasis extract` unpacks a `stasis.code.br` bundle onto disk: it writes every
bundled source to its project-relative path, verifying the bundle against the
`stasis.lock.json` already there, or with `--lock=add` writing a matching one.
The zero-dependency core CLI has it too, as `stasis-core extract`, with
identical flags and behaviour.

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
[`scripts/stasis-extract.mjs`](../scripts/stasis-extract.mjs), a single file
using only Node's builtins, writes what `stasis extract --lock=none` writes:
`node scripts/stasis-extract.mjs [--output=path/to/dir] path/to/bundle.stasis.code.br`.
It takes v1 bundles only, and checks nothing of the bundle beyond what decides
what is written (the scope, the files, their formats and execute bits). It has
no lockfile support: it refuses an output dir holding a `stasis.lock.json`, or,
for a `<name>.stasis.code.br` bundle, a `<name>.stasis.lock.json`. Like
`stasis extract`, it refuses a bundle carrying a forbidden file (a
`stasis.lock.json` or `<name>.stasis.lock.json`, a package manager's hook or
config, a Yarn Plug'n'Play file or `.git`, see [Untrusted input](#untrusted-input)),
naming it: `extract: the bundle carries a forbidden file: node_modules/dep/.pnpmfile.cjs`.
It is not published in any package.

## What it writes

A `scope = full` bundle writes workspace sources under their relative paths
(`src/index.js`, …) and dependencies under `node_modules/<pkg>/…`; a
`scope = node_modules` bundle writes only the `node_modules` tree. With
`--lock=add` or `--lock=replace` a `stasis.lock.json` is written to the output
directory too (see [The lockfile](#the-lockfile---lock)).

That lockfile is derived from the bundle: each file's recorded UTF-8 bytes are
hashed (sha512) into the SRI digest `stasis run` would record, and the bundle's
`entries`, package dirs, `name`/`version` and `imports` are copied verbatim.
`stasis prune` works directly against the extracted tree; `stasis run
--lock=frozen` also needs the project's `package.json` files, present only if
the bundle recorded them.

A legacy `version: 0` bundle records no `name`/`version`, so derives no
lockfile: its sources are still extracted, and `add` or `replace` skip the
lockfile with a warning.

## What is already there

`extract` never overwrites a file with other bytes. A file already at a target
path must hold exactly what the bundle would write there, and is then not
rewritten; a symlink to such a file counts. Anything else at a target refuses
the extract before the first write, in every `--lock` mode:

- a file with other content,
- a directory, or a dangling symlink, where a file goes,
- a file, or a dangling symlink, where a directory goes (the output dir included).

Nothing `extract` writes may land on the bundle it reads, under its own name or
another (a symlink or hard link to it): neither a bundled path nor the lockfile.
The lockfile is otherwise the one file `extract` rewrites, as `--lock` says.

A file that appears between the check and the write, or a second path a
case-insensitive disk folds onto an earlier one, fails that write rather than
being overwritten. To extract a newer bundle over an older tree, extract it into
a fresh directory, or remove the old tree first.

## The lockfile (`--lock`)

| Mode | Behavior |
| - | - |
| `frozen` | The output dir's `stasis.lock.json` must be the lockfile the bundle derives, checked before the first write and never rewritten. |
| `add` | The derived lockfile is merged into the one there, which must agree with it on everything both record: what is new is recorded, nothing recorded changes. Without one there, the derived lockfile is written. |
| `replace` | The derived lockfile is written, replacing any already there. |
| `ignore` | The lockfile is neither read nor written, whether or not one is there. |
| `none` | No lockfile: none is read or written, and one already there is an error. |

The modes mean what they do for [`stasis run --lock`](run.md#modes), with the
bundle in place of the run.

By default, extracting into a fresh directory writes the sources alone, and
extracting into a tree with a lockfile succeeds only for the bundle that
lockfile attests: into a checkout with a committed lockfile it is a verified
unpack, and re-extracting the same bundle is a no-op. A newer bundle over an
older tree is refused, both for its lockfile and for the files it would change
(see [What is already there](#what-is-already-there)).

`frozen` checks the whole lockfile, not just the files written: the derived
lockfile must equal the one on disk in every field (`config`, `entries`, each
package's name, version and file hashes, `imports`, `formats` and
`executable`), compared as parsed, so formatting doesn't matter. A bundle
carrying more, less or other than the lockfile attests is refused, naming the
first difference. A `frozen` extract fails without a lockfile in the output dir.

`add` lets bundles that each carry part of a tree extract into it, such as a
split layout's code bundle and its `--resources-bundle-file`, each adding its
files to one lockfile. A file both record must carry the same hash, format and
execute bit, a package the same name and version, and an import the same
target; anything else is refused before the first write. The one record that
does change is a payload-free `stat:file` or `stat:directory` (a path's kind
alone): content the bundle carries for that path, of the same kind, replaces it
(see [filesystem captures](file-formats.md#filesystem-captures-stasis-run---fssync----fsasync)).

A legacy `version: 0` bundle derives no lockfile, so it extracts only into a
directory without one, or with `--lock=ignore`.

## The execute bit

A bundle records one permission fact per file, whether it is executable (see
[file-formats.md](file-formats.md#executable-files)), and that is the only bit
`extract` touches. Read and write bits are left as the write produced them:
umask-derived for a file `extract` creates (`0644`, so an executable becomes
`0755`), and the file's own for one already in place (a `0600` file stays
`0600`).

The execute bit is adjusted on *every* extracted file, not only the executable
ones: re-extracting over a tree already holding the bundle's bytes also **drops**
an execute bit the bundle no longer records, so extraction is idempotent. For an
executable, execute is added wherever the file is readable, and always for the
owner.
`setuid`/`setgid`/sticky are cleared from anything `extract` extracts.

Only files `extract` extracted are touched, and the derived `stasis.lock.json`
records the same executables. Modes are left alone for a legacy `version: 0`
bundle and on Windows. A filesystem that can't store modes (vfat/exFAT/CIFS,
some bind mounts) is tolerated per file: the bytes still land, any lockfile is
still written, and the count of files whose mode could not be set is reported.

> [!NOTE]
> A target that is itself a **symlink** is never written through: it is left in place
> when its target already holds the bundle's bytes, and refused otherwise. Nor is it
> `chmod`ed.

## Untrusted input

`extract` treats the bundle as untrusted and plans the whole tree before writing
anything, so a malformed bundle fails before the first write. It refuses bundles with:

- paths that escape the output directory,
- non-canonical paths (mid-path `..` or `.`, empty segments or file names),
- paths holding a `\` (see [file formats](file-formats.md)),
- duplicate paths, or a path used as both a file and a directory,
- non-string file contents,
- a file named `stasis.lock.json` or `<name>.stasis.lock.json`, at any depth and in any case (see [file formats](file-formats.md#stasiscodebr)),
- a package manager's hook (`.npm-extension.mjs`, `.pnpmfile.cjs`) or config (`.npmrc`, `.yarnrc.yml`, `bunfig.toml`), a Yarn Plug'n'Play file (`.pnp.cjs`) or `.git` in the project or any package, or a `pnpm-workspace.yaml` or `.env` file in a dependency, at any depth and in any case (see [file formats](file-formats.md#stasiscodebr) for every name).

The path checks are lexical: `extract` does not resolve symlinks, so writes pass
through any symlinked directory already inside the output directory (e.g. a
pnpm-managed `node_modules`), creating files there. Extract untrusted bundles
into a fresh, empty directory, or one holding nothing but the trusted
`stasis.lock.json` to verify them against.

> [!NOTE]
> Code files are written as their source text; resource files are decoded per
> their `formats` entry (`resource:base64` from base64, `resource` from raw UTF-8).
