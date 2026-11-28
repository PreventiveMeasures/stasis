# `stasis audit`

`stasis audit` reports published security advisories for the dependencies one
or more lockfiles (`stasis.lock.json`) and/or bundles (`stasis.code.br`)
record. Only installed dependencies are audited; first-party code is never
sent to a registry. A [`.stasis.tgz`](file-formats.md#stasistgz) is audited
as the bundle of its files.

```sh
stasis audit [--why|--why-deep] [--why-full] [--reason=consumer] [--repo-advisories|--no-repo-advisories] path/to/(lockfile|bundle|name.stasis.tgz) ...
stasis audit [--why|--why-deep] [--why-full] [--reason=consumer] [--repo-advisories|--no-repo-advisories]   # stasis.config.json's entries' bundle
```

With no file, in a directory whose [`stasis.config.json`](file-formats.md#stasisconfigjson)
names `entries`, it audits the bundle a bare `stasis bundle` there would write
(see [Entry options](bundle.md#entry-options-stasisconfigjson)), built the same
way and with the same refusals, but not compressed or written. The build's
warnings (`[stasis] Bundle has 6 unresolved import(s) ...`) are printed only if
it fails, before its error. Its consumers, which `--reason` takes, are `bundle`,
`metro` (for `bundle:metro`, see below) and `extra` (the files the config's
`extra` adds).

An entry setting an option that needs consent (`babel`, `metro-resolver`,
`cargo`, `cargo-target`) is refused, as with bare `stasis bundle`, which takes
no flag; bundle such entries with `stasis bundle` and audit the file.

The package manager's lockfile for the directory (`pnpm-lock.yaml`,
`package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`, found as the build
finds it, or each one `stasis.config.json`'s
[`lockfiles`](github-bundle.md#several-lockfiles-lockfiles) names) is also
checked, for malware only: see
[Malware in any dependency](#malware-in-any-dependency).

| Flag | Meaning |
| - | - |
| `--why` | Per advisory, the cross-module import chains that pull the package in. See [Import chains](#import-chains---why). |
| `--why-deep` | Like `--why`, but also keeps chains whose tail is already listed. |
| `--why-full` | Spell every chain out, with no `...` collapse. With `--why-deep`, the complete raw listing. |
| `--reason=consumer` | Only the packages that consumer (`run`, `metro`, `bundle:metro`, ...) recorded are scanned, counted and queried; with `--why`, only its chains are shown. npm's malware advisories for every other npm dependency are still reported, separately (see [Malware in any dependency](#malware-in-any-dependency)). A consumer no input records is an error naming those they do. |
| `--no-repo-advisories` | Don't query each package's GitHub repository for advisories (the default when `GITHUB_TOKEN` is set). See [Repository advisories](#repository-advisories). |
| `--repo-advisories` | Query them, as by default, but fail without `GITHUB_TOKEN` instead of continuing without them. |

Exits 0 when nothing is flagged and 1 otherwise, including npm's malware
advisories for a dependency outside `--reason`. The table goes to stdout; the
not-audited packages, the summary, then any npm malware advisories (see
[Malware in any dependency](#malware-in-any-dependency)) go to stderr
(here in a 140-column terminal):

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

In a terminal the table is fitted to its width: the title, reason, vulnerable
and installed columns wrap, widest first, keeping words whole where they fit
(a `--why` chain's further lines indented). Piped or written to a file, each
row stays on one line. Where the stream takes colours (a terminal that has
them, or a CI log), severities and the summary's counts are coloured (malware
white on red, critical magenta, high red, moderate yellow, low cyan, unrated
dimmed).

Where the terminal draws sixel images (detected by a Primary Device Attributes
query), each id is preceded by an icon for the advisory's source: npm's
registry, a GitHub repository's advisories, or OSV (Packagist's has none). The
icon fits two terminal cells, whose size comes from iTerm2's `ReportCellSize`,
else `CSI 16 t`, else defaults to 16 pixels. Where the terminal draws no
images, the icon is an emoji instead: 📦 for npm's registry, 🐙 for a GitHub repository's
advisories, 🌐 for OSV (none in the Linux console, `TERM=linux`). Piped or
written to a file, an id has neither.

A malware advisory is rated `malware`, above critical, whatever its source
rates it. An advisory is malware if it is an OSV `MAL-` record (by id or
alias), has CWE-506, or has the word "malware" in its title. Those rows come
first, and the summary counts them first
(`5 alerts (3 malware, 1 critical, 1 moderate)`).

With `--reason`, the summary says whose packages were scanned
(`Scanned 12 packages recorded by run: ...`).

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
stub). Where it is queried depends on the ecosystem the artifact tags it with
(see [file formats](file-formats.md)):

| Ecosystem | Dependencies | Asked |
| - | - | - |
| `npm` | `node_modules` packages | npm's advisories, and OSV's for a public package (see [OSV and private packages](#osv-and-private-packages)) |
| `cargo` | crates vendored from a registry | OSV |
| `composer` | Composer packages | OSV, and Packagist's advisories (with the FriendsOfPHP ones OSV lacks); a dev version (`dev-main`, `1.x-dev`) is listed as not audited |
| `soldeer` | Soldeer packages | the advisories their GitHub repository publishes: for a git dependency the one its artifact records, else the one Soldeer's registry names |
| `github` | GitHub repos (Foundry's `lib/`) | the advisories the repository publishes, and OSV's records of it as a GitHub Action, unless its repo is stamped private (see [OSV and private packages](#osv-and-private-packages)) |
| `cargo-git`, `cargo-unknown` | crates vendored from git, or with no `.cargo-checksum.json` | nothing: listed as not audited, never sent to OSV |
| `npm:directory` | npm packages installed from a directory (a `file:` one) | nothing: listed as not audited, its name never sent to a public database |

A copy of a package that a dependency ships inside itself, listed in the
dependency's `vendored` (Next.js compiles about 140 into `dist/compiled`, see
[file formats](file-formats.md)), is audited as its own package, by the same
rule over the copy's files; its host is audited as usual. The `installed` cell
says where it is (`19.3.0 (vendored in next@16.4.0)`, or `also vendored in`
if the package is also installed on its own). A bundle consumer that recorded
one of its files is a reason for both copy and host, and `--why` chains end at
the copy (`next -> react-is`). A copy whose `package.json` gives no version
(most of Next.js's) is listed as not audited, naming its host.

GitHub is queried with `GITHUB_TOKEN` if it is set. Each flagged advisory is
one row: severity, ecosystem (when not all npm), package, installed and
vulnerable versions, title and id. Where the artifacts record provenance, a
`reason` column names the bundle consumers that recorded the package (`run`,
`metro`, `esbuild`, ..., `bundle` for `stasis bundle`, `bundle:metro` for the
sources `stasis bundle --metro` bundles, though what its configs reach is
`bundle`'s), and with `--why`, how. Where no input records `metro` (a
build Metro ran), `bundle:metro` is shown as `metro` in the table, the chains,
the summary and the consumers an unknown `--reason` names, and both
`--reason=metro` and `--reason=bundle:metro` select it. Otherwise the two are
shown separately.

## Import chains (`--why`)

`--why` lists, per advisory and per consumer, the cross-module import chains
that pull the package in, as `run: a -> b -> c`: `node_modules` packages ending
at the flagged one, starting at a package a first-party file imports directly,
or one nothing else in `node_modules` imports. Chains are file-level: a consumer
shows a chain only if it recorded the file forming every edge, so each consumer
shows its own maximal path, and one that recorded the package without importing
it through the graph shows a bare `run: c`. A bundle with a single consumer
shows chains with no prefix.

By default a chain is skipped when its full tail is already listed as a chain
of its own; `--why-deep` keeps every chain. Repeated tails are collapsed to
`a -> b -> ... -> d`, the hidden part spelled out on an earlier line;
`--why-full` spells every chain out instead. `--why-deep --why-full` is the
complete raw listing. On pathological graphs chains are capped per package,
and a marker line says so.

`--reason=run` audits only the packages that consumer recorded: no other is
scanned, counted, listed as not audited, or sent to OSV or a repository. The
other npm packages are checked against npm's registry alone, for malware (see
below). With `--why`, only its chains are shown. A consumer that no input
records stops the audit before any query, naming the consumers they do record;
a lockfile records none. Artifacts without a resolution graph (`imports`)
contribute no chains.

## Malware in any dependency

Whatever `--reason`, npm's registry's malware advisories for any npm dependency
are printed after the summary, apart from the table: a line per advisory, with
its package and version, id and title, and the consumers that recorded it.
Under `--reason`, the npm packages its consumer didn't record are checked
against npm's registry alone, for malware. With no file, so are the registry
versions the package manager's lockfile installs that the bundle doesn't hold
(devDependencies, say), deduplicated with the bundle's; such a package is named
by the lockfile instead of consumers. Where `stasis.config.json` names its
`lockfiles`, so are the versions each JS one locks, each package named by the
path of every lockfile locking it (`tools/package-lock.json`). If it can't be
told which lockfile installs the directory (more than one package manager's, or
bun's, which isn't read), a note says so and the audit goes on. Any such
advisory makes the audit exit 1, even with an empty table.

```
malware in 2 dependencies:
  flatmap-stream 0.1.1  GHSA-9x64-5r7x-2q53  Malicious Package in flatmap-stream  webpack
  ua-parser-js 0.7.29   GHSA-pjwm-rvh2-c87w  Embedded malware in ua-parser-js     webpack
```

## OSV and private packages

OSV has what npm's advisories lack, above all records of malicious packages
(`MAL-...`), which npm takes down rather than lists. An npm package is sent to
OSV only if its name is public: npm's registry answers a `HEAD` for it, sent
with no token. A private package, or one only another registry has, answers
404 and is checked against npm's registry alone; so is a name the registry
doesn't answer for. The name decides, not the version. A public name is cached
for a month in the user cache directory (below).

npm's registry is queried for every npm package, private ones included.

A GitHub repo dependency (ecosystem `github`) is sent to OSV by its
repository's name, as a GitHub Action, unless any record of it in the files,
in any spelling and whether or not it carries code, stamps its `repo`
`"private": true` (see `repo` in [file formats](file-formats.md)): then it is
checked against its repository's advisories alone. No build writes the stamp.
Other ecosystems send OSV package names, never a repository's.

## Repository advisories

By default, where `GITHUB_TOKEN` is set, each package's GitHub repository is
also queried, one request per package, for the advisories its maintainers
published there, which the databases above carry only once GitHub reviews them.
Without a token they are skipped, and a line above the table says so
(`Repository advisories require GITHUB_TOKEN; continuing without them`).
`--no-repo-advisories` skips them silently; `--repo-advisories` fails without a
token.

Each package's repository is the one its artifact records (its `package.json`'s,
or for a Composer package its git source's, see `repo` in
[file formats](file-formats.md)); else, for an npm package whose `package.json`
a bundle carries without a `repo` (one built before the field), the one that
manifest names; else it is looked up: an npm package's in the registry's
document of its newest version audited, cached for good, and a Composer
package's or crate's in Packagist or crates.io, cached for a month, in the user
cache directory:

| Platform | Cache directory |
| - | - |
| Linux, BSDs | `$XDG_CACHE_HOME/stasis`, else `~/.cache/stasis` |
| macOS | `~/Library/Caches/stasis` |
| Windows | `%LOCALAPPDATA%\stasis\Cache`, else `~\AppData\Local\stasis\Cache` |

Only an absolute `XDG_CACHE_HOME`, `LOCALAPPDATA` or home directory counts;
with none of them, and no `STASIS_CACHE_DIR`, the command is refused.

On every platform, `STASIS_CACHE_DIR` is the cache directory itself, nothing
added under it. It must be an absolute path; a relative one is refused before
anything is read or written. Empty, it is taken as unset.

A name recorded with two repositories, by two of its versions or two artifacts,
takes neither and is looked up as above.
