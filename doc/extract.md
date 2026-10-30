# `stasis extract`

`stasis extract` unpacks a `stasis.code.br` bundle back onto disk: it writes
every bundled source to its original project-relative path and drops a matching
`stasis.lock.json` next to them, or, where one is already there, verifies the
bundle against it. It is the inverse of `stasis bundle`. Because
unpacking needs no scanner or loaders, the command also ships on the
zero-dependency core CLI as `stasis-core extract` (identical flags and behaviour).

```sh
stasis extract [--output=path/to/dir] [--lock=(frozen|none)] path/to/bundle.stasis.code.br
stasis-core extract [--output=path/to/dir] [--lock=(frozen|none)] path/to/bundle.stasis.code.br
```

| Argument | Meaning |
| --- | --- |
| `--output` / `-o` | Directory to extract into. Defaults to cwd; intermediate dirs are created as needed. |
| `--lock=mode` | What extract does with the output dir's `stasis.lock.json`: `frozen` or `none`, see [The lockfile](#the-lockfile---lock). Defaults to `frozen` when the file is there, else `none`. |
| positional | The brotli-compressed `stasis.code.br` bundle to read. |

## What it writes

A `scope = full` bundle writes workspace sources under their relative paths
(`src/index.js`, …) and dependencies under `node_modules/<pkg>/…`; a
`scope = node_modules` bundle writes only the `node_modules` tree. Either way a
`stasis.lock.json` lands in the output directory, unless one is already there
(see [The lockfile](#the-lockfile---lock)).

The lockfile is derived from the bundle: each file's recorded UTF-8 bytes are
hashed (sha512) into the same SRI digest `stasis run` would record, and the
bundle's `entries`, package dirs, `name`/`version`, and `imports` are carried
across verbatim. The extracted tree validates out of the box — `stasis prune`
works directly against it; `stasis run --lock=frozen` additionally needs the
project's `package.json` files, present only if the bundle recorded them.

Legacy `version: 0` bundles record no `name`/`version`, so no lockfile can be
restored: sources are still extracted, the lockfile is skipped with a warning.

Existing files at target paths are overwritten.

## The lockfile (`--lock`)

| Mode | Behavior |
| - | - |
| `frozen` | The output dir's `stasis.lock.json` is the attestation: every file `extract` would write must be in it, with the same bytes and the same execute bit. It is checked before the first write and never rewritten. |
| `none` | No lockfile is checked: the one derived from the bundle is written, replacing any already there. |

Unset, `--lock` is `frozen` when the output dir holds a `stasis.lock.json` and
`none` when it doesn't: extracting into a fresh directory derives a lockfile,
and re-extracting into a tree that has one only succeeds for a bundle that
lockfile attests. That makes `extract` into a checkout with a committed
lockfile a verified unpack of a bundle from anywhere, and re-extracting the
same bundle a no-op. A newer bundle over an older tree is a mismatch:
`--lock=none` (or deleting the lockfile first) takes it.

`frozen` checks what reaches disk and nothing more. The bundle's `entries`,
`imports` and `formats` are not written anywhere (the lockfile stays as it is),
and a `stasis run --lock=frozen` of the extracted tree checks resolutions and
formats against the lockfile itself. The lockfile may attest more than the
bundle carries, such as the other half of a split layout, so a code bundle and
its `--resources-bundle-file` each extract against the lockfile they were
recorded with. A `frozen` extract fails without a lockfile in the output dir,
and for a legacy `version: 0` bundle, whose execute bits are unattested.

## The execute bit

A bundle attests exactly one permission fact per file — whether it is executable (see
[file-formats.md](file-formats.md#executable-files)) — and that is the only bit
`extract` touches. Read and write bits are left exactly as the write produced them:
umask-derived for a file `extract` creates (`0644`, so an executable becomes `0755`),
and the target's own when overwriting. Normalizing the whole mode would widen a
deliberately restricted pre-existing file — turning a `0600` secret into `0644` — and
`extract` has no standing to decide that.

The adjustment runs on *every* written file, not only the executable ones, which is what
makes the extracted tree match the artifact: re-extracting over an older tree also
**drops** an execute bit the bundle stopped attesting, so extraction is idempotent.
Execute is added wherever the file is readable, with owner-execute as a floor so an
aggressive umask can't quietly produce a file the bundle calls runnable and isn't.
`setuid`/`setgid`/sticky are cleared from anything `extract` rewrites — the bytes are the
bundle's now, and a privileged bit a stale target carried must not survive to arm them.

Only files `extract` actually wrote are touched, and the derived `stasis.lock.json`
carries the same list. Modes are left entirely alone for a legacy `version: 0` bundle,
which attests nothing about them, and on Windows, which reports no POSIX execute bits.
A filesystem that can't store modes (vfat/exFAT/CIFS, some bind mounts) is tolerated per
file: the bytes still land, the lockfile is still written, and the count of files whose
mode could not be set is reported.

> [!NOTE]
> A target that is itself a **symlink** is written through (see below) but never
> `chmod`ed: an overwrite can only change a link target's contents, whereas granting it
> `+x` would let a bundle make a file outside the output directory runnable.

## Untrusted input

`extract` treats the bundle as untrusted and plans the whole tree before writing
anything, so a malformed bundle fails before the first write. It refuses bundles with:

- paths that escape the output directory (checked as not-`..`-relative to it and as lexically under `<dir>/`),
- non-canonical paths (mid-path `..` or `.`, empty segments or file names),
- paths holding a `\` (no stasis path does: see [file formats](file-formats.md)),
- duplicate paths, or a path used as both a file and a directory,
- non-string file contents,
- a bundled file named `stasis.lock.json` (collides with the lockfile).

The path checks are lexical: `extract` does not resolve symlinks, so writes pass
through any symlink already present inside the output directory (e.g. a
pnpm-managed `node_modules`). Extract untrusted bundles into a fresh, empty
directory, or one holding nothing but the trusted `stasis.lock.json` to verify
them against.

> [!NOTE]
> Code files are written as their source text; resource files are decoded back to
> their original bytes (`resource:base64` from base64, `resource` from raw UTF-8)
> per their `formats` entry.
