# `stasis audit`

`stasis audit` reports published security advisories for the dependencies one
or more lockfiles (`stasis.lock.json`) and/or bundles (`stasis.code.br`)
record. Only installed dependencies are audited; first-party code is never
sent to a registry.

```sh
stasis audit [--why|--why-deep] [--why-full] [--reason=consumer] [--repo-advisories] path/to/(lockfile|bundle) ...
stasis audit [--why|--why-deep] [--why-full] [--reason=consumer] [--repo-advisories]   # stasis.config.json's entries' bundle
```

With no file, in a directory whose [`stasis.config.json`](file-formats.md#stasisconfigjson)
names `entries`, it audits the bundle a bare `stasis bundle` there would write
(see [Entry options](bundle.md#entry-options-stasisconfigjson)), as if it were
written and then given: built the same way, with the same warnings and
refusals, but neither compressed nor written. Its consumers are the builds'
(`bundle`, `bundle:metro`, and `extra` for the files the config's `extra`
adds), which `--reason` takes. Bare `stasis bundle` takes no flag, so an entry
setting an option that needs consent (`babel`, `metro-resolver`, `cargo`,
`cargo-target`) is refused here as it is there; bundle such entries with
`stasis bundle` and audit the file.

| Flag | Meaning |
| - | - |
| `--why` | Per advisory, the cross-module import chains that pull the package in. See [Import chains](#import-chains---why). |
| `--why-deep` | Like `--why`, also keeping a chain a shorter listed chain is the tail of. |
| `--why-full` | Spell every chain out, with no `...` collapse. With `--why-deep`, the complete raw listing. |
| `--reason=consumer` | Only the packages that consumer (`run`, `metro`, `bundle:metro`, ...) recorded are scanned, counted and asked about; with `--why`, only its chains. npm's malware advisories of every other npm dependency are still told, apart (see [Malware in any dependency](#malware-in-any-dependency)). A consumer no input records is an error naming those they do. |
| `--repo-advisories` | Also ask each package's GitHub repository for its advisories. Needs `GITHUB_TOKEN`. See [Repository advisories](#repository-advisories---repo-advisories). |

Exits 0 when nothing is flagged and 1 otherwise, npm's malware advisories of a
dependency outside `--reason` included, so it composes in CI. The table goes to
stdout; the not-audited packages, then the summary, then any malware npm's
advisories tell of (see [Malware in any dependency](#malware-in-any-dependency))
go to stderr (here in a 140-column terminal):

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
and installed columns wrap, the widest first, a word kept whole where the
column can take it (a `--why` chain's further lines indented). Piped or
written to a file, each row stays on one line. Where the stream takes colours
(a terminal that has them, or a CI log), severities are coloured (malware
white on red, critical magenta, high red, moderate yellow, low cyan, unrated
dimmed), and so is the summary's count of each. Where the terminal draws sixel
images (it answers a Primary Device Attributes query with sixel graphics among
what it has), each id has an icon before it for where the advisory comes from:
npm's registry, a GitHub repository's advisories, or OSV. The icon is sized to
fit two of the terminal's cells, as it reports their size: iTerm2's
`ReportCellSize` (in points, by its Retina scale), else `CSI 16 t`; 16 pixels
where it reports none. It is an eighth of a row shorter than the row, and set
in its middle, so icons on lines one under another don't touch. Where the
terminal reports its background colour (`OSC 11`), what an icon leaves undrawn
is that colour in iTerm2, which draws it opaque; other terminals leave it
transparent.

An advisory of malware, not a vulnerability, is rated `malware`, above
critical, whatever its source rates it. `@preventive/upstream` flags it as
malware: an OSV `MAL-` record (by id or alias), CWE-506 (how GitHub files
malware), or a title with the word "malware". Those rows come first, and the
summary counts them first (`5 alerts (3 malware, 1 critical, 1 moderate)`).

With `--reason`, the summary says whose packages were scanned
(`Scanned 12 packages recorded by run: ...`).

```sh
stasis audit stasis.lock.json
stasis audit --why app.stasis.code.br
stasis audit --reason=bundle:metro   # the Metro build of stasis.config.json's entries
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
| `npm` | `node_modules` packages | npm's advisories, and OSV's for a public package (see [OSV and private packages](#osv-and-private-packages)) |
| `cargo` | crates vendored from a registry | OSV |
| `composer` | Composer packages | OSV; a dev version (`dev-main`, `1.x-dev`) is listed as not audited, no database having one |
| `soldeer` | Soldeer packages | the advisories their GitHub repository publishes: a git dependency's, the one its artifact records, else the one Soldeer's registry names |
| `github` | GitHub repos (Foundry's `lib/`) | the advisories the repository publishes |
| `cargo-git`, `cargo-unknown` | crates vendored from git, or with no `.cargo-checksum.json` | nothing: listed as not audited, never sent to OSV, whose crate of that name may be another |

A copy of a package that a dependency ships inside itself, which the
artifact lists in the dependency's `vendored` (Next.js compiles about 140 into
`dist/compiled`, see [file formats](file-formats.md)), is audited as the
package it is, by the same rule over the files the copy holds, and its host is
audited as before. The `installed` cell says where it is
(`19.3.0 (vendored in next@16.4.0)`, or `also vendored in` where the package
is installed on its own too), a bundle consumer that recorded one of its files
is a reason for both, and `--why` chains end at the copy (`next -> react-is`).
A copy whose `package.json` gives no version, as most of Next.js's don't,
can't be matched to an advisory: it is listed as not audited, naming its host.

GitHub is asked with `GITHUB_TOKEN` where it is set. Each flagged advisory is
one row: severity, ecosystem (when not all npm), package, installed and
vulnerable versions, title and id, plus a `reason` column where the artifacts
record provenance: which bundle consumers (`run`, `metro`, `esbuild`, ...,
`bundle` for `stasis bundle`, `bundle:metro` for the source `stasis bundle --metro`
bundles, whose configs are `bundle`'s)
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

`--reason=run` audits only the packages that consumer recorded: no other is
scanned, counted, listed as not audited, or sent to OSV or a repository. The
other npm packages are asked of npm's registry alone, for malware (see below).
With `--why`, only its chains are shown. A consumer that no input records stops the
audit before anything is asked, naming the consumers they do record; a lockfile
records none. Artifacts without a resolution graph (`imports`) contribute no
chains.

## Malware in any dependency

Whatever `--reason`, what npm's registry tells of malware in any npm dependency
is printed apart from the table, after the summary: each advisory a line, its
package and version, id and title, and the consumers that recorded it. Under
`--reason`, the npm packages its consumer didn't record are asked of npm's
registry alone for it, which is fast, where OSV and their repositories are not.
Any such advisory makes the audit exit 1, an empty table or not.

```
malware in 2 dependencies, as npm's advisories tell:
  flatmap-stream 0.1.1  GHSA-9x64-5r7x-2q53  Malicious Package in flatmap-stream  webpack
  ua-parser-js 0.7.29   GHSA-pjwm-rvh2-c87w  Embedded malware in ua-parser-js     webpack
```

## OSV and private packages

OSV has what npm's advisories lack, above all its records of malicious
packages (`MAL-...`), which npm takes down rather than lists. An npm package
is asked of OSV only where its name is public: npm's registry answers a `HEAD`
for it, sent with no token. A private package, or one only another registry
has, answers 404 and is asked of npm's registry alone; so is a name the
registry doesn't answer for. The name decides, not the version, as npm takes
down malicious versions but keeps their name. A public name is cached for a
month in the user cache directory (below).

npm's registry is asked about every npm package, private ones included, as
`npm audit` asks it.

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
