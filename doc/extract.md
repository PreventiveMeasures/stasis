# `stasis extract`

`stasis extract` unpacks a `stasis.code.br` bundle back onto disk: it writes
every bundled source to its original project-relative path, verifying the
bundle against the `stasis.lock.json` already there, or with `--lock=add` drops
a matching one next to them. It is the inverse of `stasis bundle`. Because
unpacking needs no scanner or loaders, the command also ships on the
zero-dependency core CLI as `stasis-core extract` (identical flags and behaviour).

```sh
stasis extract [--output=path/to/dir] [--lock=(frozen|add|replace|ignore|none)] path/to/bundle.stasis.code.br
stasis-core extract [--output=path/to/dir] [--lock=(frozen|add|replace|ignore|none)] path/to/bundle.stasis.code.br
```

| Argument | Meaning |
| --- | --- |
| `--output` / `-o` | Directory to extract into. Defaults to cwd; intermediate dirs are created as needed. |
| `--lock=mode` | What extract does with the output dir's `stasis.lock.json`: `frozen`, `add`, `replace`, `ignore` or `none`, see [The lockfile](#the-lockfile---lock). Defaults to `frozen` when the file is there, else `none`. |
| positional | The brotli-compressed `stasis.code.br` bundle to read. |

## What it writes

A `scope = full` bundle writes workspace sources under their relative paths
(`src/index.js`, …) and dependencies under `node_modules/<pkg>/…`; a
`scope = node_modules` bundle writes only the `node_modules` tree. With
`--lock=add` or `--lock=replace` a `stasis.lock.json` lands in the output
directory too (see [The lockfile](#the-lockfile---lock)).

That lockfile is derived from the bundle: each file's recorded UTF-8 bytes are
hashed (sha512) into the same SRI digest `stasis run` would record, and the
bundle's `entries`, package dirs, `name`/`version`, and `imports` are carried
across verbatim. The extracted tree validates out of the box — `stasis prune`
works directly against it; `stasis run --lock=frozen` additionally needs the
project's `package.json` files, present only if the bundle recorded them.

Legacy `version: 0` bundles record no `name`/`version`, so no lockfile can be
derived: sources are still extracted, and `add` or `replace` skip the lockfile
with a warning.

## What is already there

`extract` never overwrites a file with other bytes. A file already at a target
path must hold exactly what the bundle would write there, and is then left as it
is, not even rewritten; a symlink to such a file counts. Anything else at a
target refuses the extract before the first write, in every `--lock` mode:

- a file with other content,
- a directory, or a dangling symlink, where a file goes,
- a file, or a dangling symlink, where a directory goes (the output dir included).

Nothing `extract` writes may land on the bundle it reads either: not one of its
paths, nor the lockfile `add` or `replace` writes, under the bundle's own name or
another (a symlink or hard link to it). The lockfile is otherwise the one file
`extract` rewrites, as `--lock` says.

Files are created exclusively, so one that appears between the check and the
write, or a second path a case-insensitive disk folds onto an earlier one, fails
that write rather than being overwritten. To extract a newer bundle over an
older tree, extract it into a fresh directory, or remove the old tree first.

## The lockfile (`--lock`)

| Mode | Behavior |
| - | - |
| `frozen` | The output dir's `stasis.lock.json` must be the lockfile the bundle derives, checked before the first write and never rewritten. |
| `add` | The lockfile the bundle derives is merged into the one there, which must agree with it on everything both record: what is new is recorded, nothing recorded changes. Without one there, the derived lockfile is written. |
| `replace` | The lockfile derived from the bundle is written, replacing any already there. |
| `ignore` | The lockfile is neither read nor written, whether or not one is there. |
| `none` | No lockfile: none is read or written, and one already there is an error. |

The modes mean what they do for [`stasis run --lock`](run.md#modes), with the
bundle in the place of the run.

Unset, `--lock` is `frozen` when the output dir holds a `stasis.lock.json` and
`none` when it doesn't: extracting into a fresh directory writes the sources
alone, and re-extracting into a tree that has a lockfile only succeeds for the
bundle that lockfile attests. That makes `extract` into a checkout with a committed
lockfile a verified unpack of a bundle from anywhere, and re-extracting the
same bundle a no-op. A newer bundle over an older tree is refused, both for its
lockfile and for the files it would change (see [What is already
there](#what-is-already-there)).

`frozen` checks the whole lockfile, not just the files it writes: the derived
lockfile must equal the one on disk in every field (`config`, `entries`, each
package's name, version and file hashes, `imports`, `formats` and
`executable`), so a bundle carrying more, less or other than the lockfile
attests is refused, naming the first difference. The two are compared as
parsed, so the on-disk file's formatting doesn't matter. A `frozen` extract
fails without a lockfile in the output dir.

`add` is how bundles that each carry part of a tree extract into it, such as a
split layout's code bundle and its `--resources-bundle-file`: each adds its
files to one lockfile. A file both record must carry the same hash, format and
execute bit, a package the same name and version, and an import the same
target; anything else is refused before the first write. The one record that
does change is a payload-free `stat:file` or `stat:directory`, a path's kind
alone: content the bundle carries for that path, of the same kind, takes its
place, as a `stasis run --lock=add` that reads the path does (see [filesystem
captures](file-formats.md#filesystem-captures-stasis-run---fssync----fsasync)).

A legacy `version: 0` bundle derives no lockfile, so it extracts only into a
directory without one, or with `--lock=ignore`.

## The execute bit

A bundle attests exactly one permission fact per file — whether it is executable (see
[file-formats.md](file-formats.md#executable-files)) — and that is the only bit
`extract` touches. Read and write bits are left exactly as the write produced them:
umask-derived for a file `extract` creates (`0644`, so an executable becomes `0755`),
and the file's own for one already in place. Normalizing the whole mode would widen a
deliberately restricted pre-existing file — turning a `0600` secret into `0644` — and
`extract` has no standing to decide that.

The adjustment runs on *every* extracted file, not only the executable ones, which is what
makes the extracted tree match the artifact: re-extracting over a tree already holding the
bundle's bytes also **drops** an execute bit the bundle stopped attesting, so extraction is idempotent.
Execute is added wherever the file is readable, with owner-execute as a floor so an
aggressive umask can't quietly produce a file the bundle calls runnable and isn't.
`setuid`/`setgid`/sticky are cleared from anything `extract` extracts — the bytes are the
bundle's, and a privileged bit a stale target carried must not survive to arm them.

Only files `extract` extracted are touched, and the derived `stasis.lock.json`
carries the same list. Modes are left entirely alone for a legacy `version: 0` bundle,
which attests nothing about them, and on Windows, which reports no POSIX execute bits.
A filesystem that can't store modes (vfat/exFAT/CIFS, some bind mounts) is tolerated per
file: the bytes still land, any lockfile is still written, and the count of files whose
mode could not be set is reported.

> [!NOTE]
> A target that is itself a **symlink** is never written through: it is left in place
> when its target already holds the bundle's bytes, and refused otherwise. Nor is it
> `chmod`ed, which would let a bundle make a file outside the output directory runnable.

## Untrusted input

`extract` treats the bundle as untrusted and plans the whole tree before writing
anything, so a malformed bundle fails before the first write. It refuses bundles with:

- paths that escape the output directory (checked as not-`..`-relative to it and as lexically under `<dir>/`),
- non-canonical paths (mid-path `..` or `.`, empty segments or file names),
- paths holding a `\` (no stasis path does: see [file formats](file-formats.md)),
- duplicate paths, or a path used as both a file and a directory,
- non-string file contents,
- a file named `stasis.lock.json`, at any depth and in any case, which no bundle carries (see [file formats](file-formats.md#stasiscodebr)).

The path checks are lexical: `extract` does not resolve symlinks, so writes pass
through any symlinked directory already present inside the output directory (e.g.
a pnpm-managed `node_modules`), creating files there. Extract untrusted bundles into a fresh, empty
directory, or one holding nothing but the trusted `stasis.lock.json` to verify
them against.

> [!NOTE]
> Code files are written as their source text; resource files are decoded back to
> their original bytes (`resource:base64` from base64, `resource` from raw UTF-8)
> per their `formats` entry.
