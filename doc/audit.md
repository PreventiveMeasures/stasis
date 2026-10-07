# `stasis audit`

`stasis audit` reports published security advisories for the dependencies one
or more lockfiles (`stasis.lock.json`) and/or bundles (`stasis.code.br`)
record. Only installed dependencies are audited; first-party code is never
sent to a registry.

```sh
stasis audit [--why|--why-deep] [--why-full] [--reason=consumer] [--repo-advisories] path/to/(lockfile|bundle) ...
```

| Flag | Meaning |
| - | - |
| `--why` | Per advisory, the cross-module import chains that pull the package in. See [Import chains](#import-chains---why). |
| `--why-deep` | Like `--why`, also keeping a chain a shorter listed chain is the tail of. |
| `--why-full` | Spell every chain out, with no `...` collapse. With `--why-deep`, the complete raw listing. |
| `--reason=consumer` | Only advisories tied to that consumer (`run`, `metro`, ...); with `--why`, only its chains. |
| `--repo-advisories` | Also ask each package's GitHub repository for its advisories. Needs `GITHUB_TOKEN`. See [Repository advisories](#repository-advisories---repo-advisories). |

Exits 0 when nothing is flagged and 1 otherwise, so it composes in CI. The
summary (`Scanned N packages: ...`) and the not-audited lines go to stderr; the
table goes to stdout.

```sh
stasis audit stasis.lock.json
stasis audit --why app.stasis.code.br
stasis audit --reason=run --why app.stasis.code.br
GITHUB_TOKEN=... stasis audit --repo-advisories stasis.lock.json
```

## What is audited

A package is audited only when the artifact records some of its real code: not
one it carries only the `package.json` of, or only a corrected file (such as
`ws`'s noop `browser.js` stub). Where it is asked depends on the ecosystem the
artifact tags it with (see [file formats](file-formats.md)):

| Ecosystem | Dependencies | Asked |
| - | - | - |
| `npm` | `node_modules` packages | npm's advisories |
| `cargo` | crates vendored from a registry | OSV |
| `composer` | Composer packages | OSV; a dev version (`dev-main`, `1.x-dev`) is listed as not audited, no database having one |
| `soldeer` | Soldeer packages | the advisories their GitHub repository publishes: a git dependency's, the one its artifact records, else the one Soldeer's registry names |
| `github` | GitHub repos (Foundry's `lib/`) | the advisories the repository publishes |
| `cargo-git`, `cargo-unknown` | crates vendored from git, or with no `.cargo-checksum.json` | nothing: listed as not audited, never sent to OSV, whose crate of that name may be another |

GitHub is asked with `GITHUB_TOKEN` where it is set. Each flagged advisory is
one row: severity, ecosystem (when not all npm), package, installed and
vulnerable versions, title and id, plus a `reason` column where the artifacts
record provenance: which bundle consumers (`run`, `metro`, `esbuild`, ...)
recorded the package, and with `--why`, how.

## Import chains (`--why`)

`--why` lists, per advisory and per consumer, the cross-module import chains
that pull the package in, as `run: a -> b -> c`: a chain of `node_modules`
packages ending at the flagged one, starting at a package a first-party file
imports directly, or one nothing else in `node_modules` imports. The chain is
file-level: a consumer owns it only when it recorded the file forming every
edge, so each consumer shows its own maximal path, and one that recorded the
package without importing it through the graph shows a bare `run: c`. A bundle
with a single consumer shows chains with no prefix.

By default a chain is skipped when its full tail is already listed as a chain
of its own; `--why-deep` keeps every chain. Repeated tails are then collapsed
to `a -> b -> ... -> d`, the hidden part being spelled out by an earlier line;
`--why-full` spells every chain out instead. The two compose: `--why-deep
--why-full` is the complete raw listing. Chains are capped per package on
pathological graphs, which is reported on a marker line rather than dropped.

`--reason=run` keeps only the advisories tied to that consumer, and with
`--why`, only its chains. Artifacts without a resolution graph (`imports`)
contribute no chains.

## Repository advisories (`--repo-advisories`)

`--repo-advisories` also asks each package's GitHub repository for the
advisories its maintainers published there, which the databases above carry
only once GitHub reviews them. It needs a GitHub token in `GITHUB_TOKEN`.

Each package's repository is the one its artifact records for it (its
`package.json`'s, or for a Composer package its git source's, see `repo` in
[file formats](file-formats.md)); else, for an
npm package a bundle carries the `package.json` of but records no `repo` for
(one built before the field), the one that manifest names; else it is looked
up: an npm package's in the registry's document of its newest version audited,
cached for good (the registry never takes a version twice), and a Composer
package's or crate's in Packagist or crates.io, cached for a month, in the user
cache directory:

| Platform | Cache directory |
| - | - |
| Linux | `$XDG_CACHE_HOME/stasis`, else `~/.cache/stasis` |
| macOS | `~/Library/Caches/stasis` |
| Windows | `%LOCALAPPDATA%\stasis\Cache` |

A name recorded with two repositories, by two of its versions or two artifacts,
takes neither and is looked up as before.
