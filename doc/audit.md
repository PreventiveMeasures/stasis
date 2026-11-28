# `stasis audit`

`stasis audit` reports published security advisories for the installed
dependencies that one or more lockfiles (`stasis.lock.json`) and/or bundles
(`stasis.code.br`) record; first-party code is never sent to a registry. A
[`.stasis.tgz`](file-formats.md#stasistgz) is audited as the bundle of its
files.

```sh
stasis audit [--why|--why-deep] [--why-full] [--reason=consumer] [--repo-advisories|--no-repo-advisories] path/to/(lockfile|bundle|name.stasis.tgz) ...
stasis audit [--why|--why-deep] [--why-full] [--reason=consumer] [--repo-advisories|--no-repo-advisories]   # stasis.config.json's entries' bundle
```

With no file, it audits the bundle a bare `stasis bundle` would write of the
`entries` of [`stasis.config.json`](file-formats.md#stasisconfigjson) (see
[Entry options](bundle.md#entry-options-stasisconfigjson)): built the same way,
refusals included, but not compressed or written; the build's warnings are
printed only if it fails. Its consumers are `bundle`, `metro` (for `bundle:metro`, see below)
and `extra` (the config's `extra` files). The package manager's lockfile is
also checked, for [malware only](#malware-in-any-dependency).

| Flag | Meaning |
| - | - |
| `--why` | Per advisory, the cross-module import chains that pull the package in. See [Import chains](#import-chains---why). |
| `--why-deep` | Like `--why`, but also keeps chains whose tail is already listed. |
| `--why-full` | Spell every chain out, with no `...` collapse. With `--why-deep`, the complete raw listing. |
| `--reason=consumer` | Audit only the packages that consumer (`run`, `metro`, `bundle:metro`, ...) recorded: no other is scanned, counted, listed as not audited, or sent to OSV or a repository, and `--why` shows only its chains. npm's [malware advisories](#malware-in-any-dependency) for other npm dependencies are still reported. A consumer no input records is refused before any query, naming those recorded; a lockfile records none. |
| `--no-repo-advisories` | Don't query each package's GitHub repository for advisories (the default when `GITHUB_TOKEN` is set). See [Repository advisories](#repository-advisories). |
| `--repo-advisories` | Query them, as by default, but fail without `GITHUB_TOKEN` instead of continuing without them. |

Exits 1 if anything is flagged, in the table or the malware lines, else 0. The
table goes to stdout; the not-audited packages, the summary, then any npm
malware advisories go to stderr (here in a 140-column terminal):

```
┌──────────┬───────────┬─────────────────┬───────────────┬────────┬─────────────────────┬─────────────────────────┬─────────────────────┐
│ severity │ ecosystem │ package         │ installed     │ reason │ vulnerable          │ title                   │ id                  │
├──────────┼───────────┼─────────────────┼───────────────┼────────┼─────────────────────┼─────────────────────────┼─────────────────────┤
│ critical │ npm       │ form-data       │ 4.0.0         │ run    │ >=4.0.0 <4.0.4      │ form-data uses unsafe   │ GHSA-fjxv-7rqg-78g4 │
│          │           │                 │               │        │                     │ random function in      │                     │
│          │           │                 │               │        │                     │ form-data for choosing  │                     │
│          │           │                 │               │        │                     │ boundary                │                     │
│ low      │ npm       │ brace-expansion │ 1.1.11, 2.0.1 │ run    │ >=1.0.0 <=1.1.11 || │ brace-expansion Regular │ GHSA-v6h2-p8h4-qcjw │
│          │           │                 │               │        │ >=2.0.0 <=2.0.1     │ Expression Denial of    │                     │
│          │           │                 │               │        │                     │ Service vulnerability   │                     │
│ unrated  │ cargo     │ atty            │ 0.2.14        │ bundle │                     │ Potential unaligned     │ RUSTSEC-2021-0145   │
│          │           │                 │               │        │                     │ read                    │                     │
└──────────┴───────────┴─────────────────┴───────────────┴────────┴─────────────────────┴─────────────────────────┴─────────────────────┘

Not audited:
  composer acme/tools@dev-main  a Composer dev version, which no advisory database lists

Scanned 42 packages: 3 alerts (1 critical, 1 low, 1 unrated)
```

- `ecosystem` shows only when not every row is npm.
- `reason`, where the artifacts record provenance, names the bundle consumers
  that recorded the package (`run`, `metro`, `esbuild`, ..., `bundle` for
  `stasis bundle`, `bundle:metro` for the sources `stasis bundle --metro`
  bundles, though what its configs reach is `bundle`'s), and with `--why`, how.
  Where no input records `metro` (a build Metro ran), `bundle:metro` is shown
  as `metro` throughout, and `--reason` takes either name.
- `severity` is `malware`, above critical whatever the source rates it, for an
  OSV `MAL-` record (by id or alias), CWE-506, or the word "malware" in the
  title. Those rows, and their count, come first
  (`5 alerts (3 malware, 1 critical, 1 moderate)`).
- Under `--reason`, the summary says whose packages were scanned
  (`Scanned 12 packages recorded by run: ...`).

In a terminal the table is fitted to its width, and each id is preceded by its
source's icon, a sixel image where the terminal draws them, else an emoji:
📦 npm's registry, 🐙 a GitHub repository's advisories, 🌐 OSV (none in the
Linux console, `TERM=linux`). Packagist's has none. Piped or written to a file,
each row stays on one line.

```sh
stasis audit stasis.lock.json
stasis audit --why app.stasis.code.br
stasis audit --reason=metro   # the Metro build of stasis.config.json's entries
stasis audit --reason=run --why app.stasis.code.br
GITHUB_TOKEN=... stasis audit stasis.lock.json   # with each repository's advisories too
stasis audit --no-repo-advisories stasis.lock.json
```

## What is audited

A package is audited only when the artifact records some of its real code, not
just its `package.json` or a corrected file (such as `ws`'s noop `browser.js`
stub). The ecosystem the artifact tags it with (see
[file formats](file-formats.md)) decides what is asked; GitHub is asked with
`GITHUB_TOKEN` if it is set.

| Ecosystem | Dependencies | Asked |
| - | - | - |
| `npm` | `node_modules` packages | npm's advisories, and OSV's for a public package (see [OSV and private packages](#osv-and-private-packages)) |
| `cargo` | crates vendored from a registry | OSV |
| `composer` | Composer packages | OSV, and Packagist's advisories (with the FriendsOfPHP ones OSV lacks); a dev version (`dev-main`, `1.x-dev`) is listed as not audited |
| `soldeer` | Soldeer packages | the advisories their GitHub repository publishes: for a git dependency the one its artifact records, else the one Soldeer's registry names |
| `github` | GitHub repos (Foundry's `lib/`) | the advisories the repository publishes, and OSV's records of it as a GitHub Action |
| `cargo-git`, `cargo-unknown` | crates vendored from git, or with no `.cargo-checksum.json` | nothing: listed as not audited, never sent to OSV |
| `npm:directory` | npm packages installed from a directory (a `file:` one) | nothing: listed as not audited, its name never sent to a public database |

A copy of a package that a dependency ships inside itself, listed in its
`vendored` (Next.js's `dist/compiled`, see [file formats](file-formats.md)), is
audited as its own package, by the same rule; with no version in its
`package.json` (most of Next.js's), it is listed as not audited. Its
`installed` cell says where (`19.3.0 (vendored in next@16.4.0)`, or
`also vendored in` if the package is also installed on its own). A consumer
that recorded one of its files is a reason for both copy and host, and `--why`
chains end at the copy (`next -> react-is`).

## Import chains (`--why`)

A chain, `run: a -> b -> c`, is the `node_modules` packages from one a
first-party file imports directly, or one nothing else in `node_modules`
imports, to the flagged one. A consumer shows a chain only if it recorded the
file forming every edge, and a bare `run: c` if it recorded the package without
importing it through the graph. A single-consumer bundle's chains have no
prefix. Artifacts without a resolution graph (`imports`) contribute none.

By default a chain whose full tail is already listed as a chain of its own is
skipped, and repeated tails collapse to `a -> b -> ... -> d`, the hidden part
spelled out on an earlier line. On pathological graphs chains are capped per
package, with a marker line.

## Malware in any dependency

Whatever `--reason`, npm's registry's malware advisories for any npm dependency
are printed after the summary, a line each: package and version, id, title,
and the consumers that recorded it. Checked against npm's registry alone, for
malware, are:

- under `--reason`, the npm packages its consumer didn't record;
- with no file, the registry versions the bundle doesn't hold (devDependencies,
  say) that the package manager's lockfile installs (`pnpm-lock.yaml`,
  `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`, found as the build
  finds it), or that each JS one in the config's
  [`lockfiles`](github-bundle.md#several-lockfiles-lockfiles) locks. Such a
  package is named by its lockfile, not consumers (with `lockfiles`, by the path
  of every one locking it: `tools/package-lock.json`). If it can't be told
  which lockfile installs the directory (more than one package manager's, or
  bun's, which isn't read), a note says so and the audit goes on.

```
malware in 2 dependencies:
  flatmap-stream 0.1.1  GHSA-9x64-5r7x-2q53  Malicious Package in flatmap-stream  webpack
  ua-parser-js 0.7.29   GHSA-pjwm-rvh2-c87w  Embedded malware in ua-parser-js     webpack
```

## OSV and private packages

An npm package is sent to OSV only if its name is public: npm's registry
answers a `HEAD` for it, sent with no token. A private package or one only
another registry has (both answer 404), or a name the registry doesn't answer
for, is checked against npm's registry alone, which is queried for every npm
package. A public name is cached for a month in the user cache directory
(below).

## Repository advisories

Where `GITHUB_TOKEN` is set, each package's GitHub repository is also queried,
one request per package, for the advisories its maintainers published there.
Without a token they are skipped, with a line above the table saying so
(`Repository advisories require GITHUB_TOKEN; continuing without them`) unless
`--no-repo-advisories` is given.

A package's repository is the one its artifact records (`repo` in
[file formats](file-formats.md): its `package.json`'s, or a Composer package's
git source's); else, for an npm package whose `package.json` a bundle carries,
the one that manifest names; else it is looked up, an npm package's in the
registry's document of its newest version audited (cached for good), a
Composer package's or crate's in Packagist or crates.io (cached for a month).
A name recorded with two repositories, by two of its versions or two
artifacts, takes neither and is looked up. These lookups are cached in the user
cache directory:

| Platform | Cache directory |
| - | - |
| Linux, BSDs | `$XDG_CACHE_HOME/stasis`, else `~/.cache/stasis` |
| macOS | `~/Library/Caches/stasis` |
| Windows | `%LOCALAPPDATA%\stasis\Cache`, else `~\AppData\Local\stasis\Cache` |

`STASIS_CACHE_DIR`, if set, is the cache directory itself on every platform; a
relative one is refused, an empty one taken as unset. Otherwise only an
absolute `XDG_CACHE_HOME`, `LOCALAPPDATA` or home directory counts, and with
none the command is refused.
