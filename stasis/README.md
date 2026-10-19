# <img src="./logo.svg" alt="" width="39" height="39" valign="bottom" /> `@exodus/stasis`

*Analyzeable source code bundles with resolutions + fine-grained lockfiles.*

[![Node.js](https://img.shields.io/badge/Node.js-338750?style=for-the-badge&logo=Node.js&logoColor=FFF)](https://nodejs.org/)
[![esbuild](https://img.shields.io/badge/esbuild-191919?style=for-the-badge&logo=esbuild)](https://esbuild.github.io/)
[![metro](https://img.shields.io/badge/metro-FFF?style=for-the-badge&logo=Metro&logoColor=Ef4242)](https://metrobundler.dev/)
[![rollup](https://img.shields.io/badge/Rollup-EC4A3F?style=for-the-badge&logo=rollupdotjs&logoColor=FFF)](https://rollupjs.org/)
[![webpack](https://img.shields.io/badge/WebPack-2B3A42?style=for-the-badge&logo=WebPack)](https://webpack.js.org/)

Both lockfiles and bundles only include what is actually _used_.\
Generally about 10x smaller than production-focused `node_modules` install.

Enforcing these lets you focus automated code scanning and alerts only on code that matters,
and makes the analysis import graph aware.

Ideal workflow: create bundle -> analyze -> ship _that exact bundle_ to production.

Lockfile can attest the bundle in a readable form, but that's not required - bundle itself can be an attestation.

| Lockfile | Bundle |
| -------- | ------ |
| `stasis.lock.json` | `stasis.code.br` |
| Asserts per-file content integrity and the import graph | Contains per-file content (source) and the import graph |
| Human-readable | Compressed |
| Asserts only, files are read from disk | Loads or asserts (can be used as a lockfile)|
| Modes: `add`, `replace`, `frozen`, `ignore` | Modes: `load`, `add`, `replace`, `frozen`, `ignore` |

The main difference between lockfiles and bundles is that lockfiles contain integrities, and bundles contain full content.\
See [file formats](https://github.com/PreventiveMeasures/stasis/blob/main/doc/file-formats.md).

Both can be run in full scope (default) or just in `node_modules` scope.

## Why a separate bundle format?

| | Stasis | JS bundlers | Sourcemaps | SEA | source + deps tarball | Containers |
| - | - | - | - | - | - | - |
| Runnable | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| Contains original sources | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Sources match runtime | ✅ | ➖ | ❌ Deps can misreport | ➖ | ✅ | ✅ |
| Dependency versions | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Import edges | ✅ | ❌ | ❌ | ❌ | 🔍 Implicit | 🔍 Implicit |
| Constrained to related code | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |

_Lockfiles (npm/pnpm/etc) not mentioned: they are like the "tarball" column, but also require network, install step and are not self-contained._

## Commands

| Command | What it does |
| - | - |
| `stasis run --lock=add app.js` | build just a lockfile |
| `stasis run --lock=frozen app.js` | verify disk against the lockfile |
| `stasis run --bundle=add app.js` | build just a bundle |
| `stasis run --bundle=frozen app.js` | verify disk against the bundle alone (self-attesting) |
| `stasis run --bundle=load app.js` | run from the bundle alone |
| `stasis run --lock=add --bundle=add app.js` | build a lockfile and bundle together |
| `stasis run --lock=frozen --bundle=load app.js` | run from the bundle, verified against the lockfile |
| `stasis run --lock=add --bundle=add --mock app.js` | build without the app's side effects (network, fs writes) |
| `stasis run --lock=add --child-process app.js` | also attest modules loaded in forked child processes (e.g. Metro transform workers) |
| `stasis run --bundle=add --fs=sync app.js` | build a bundle that also captures sync `fs.readFileSync`/`readdirSync` reads |
| `stasis run --lock=add --import=./instrument.mjs app.js` | also load a preload module; its own graph is runner infrastructure, not attested |
| `stasis bundle src/index.js` | build a bundle statically, without executing it |
| `stasis bundle --add src/worker.js` | merge more entries into the existing bundle |
| `stasis bundle --conditions=react-native,browser app.js` | statically bundle with extra `exports`/`imports` resolution conditions |
| `stasis bundle --mainFields=react-native,browser,main app.js` | statically bundle honoring legacy package `mainFields` |
| `stasis bundle --metro --platforms=ios,android app.js` | statically bundle the way Metro resolves, all platforms at once |
| `stasis bundle --typescript src/index.ts` | statically bundle TS sources, resolving `./x.js` imports to `./x.ts` as tsc does |
| `stasis bundle --include-dirs=include src/main.cpp` | statically bundle C/C++ sources: their includes, and each header's implementation file |
| `stasis add src assets` | add files to the project's bundles as-is, with no dependency resolution |
| `stasis github-bundle --github=owner/name --sha=<commit> src/index.js` | statically bundle a GitHub repo at a commit, with nothing installed |
| `stasis build --output=out.js app.stasis.code.br [entry]` | rebuild a runnable JS bundle with esbuild, following the bundle's recorded import graph exactly |
| `stasis build --output=out.js stasis.lock.json [entry]` | same, reading + verifying sources from disk against the lockfile |
| `stasis extract app.stasis.code.br` | unpack a bundle back to sources + a `stasis.lock.json` |
| `stasis diff --stat a.lock.json b.stasis.code.br` | summarize module/file differences between two lockfiles/bundles |
| `stasis prune` | trim `node_modules` to the lockfile, verifying the rest |
| `stasis audit stasis.lock.json` | report advisories for a lockfile's or bundle's dependencies |
| `stasis audit --why app.stasis.code.br` | same, with the import chains that pull each flagged package in |
| `stasis sbom --format=spdx stasis.lock.json` | export an SPDX SBOM for a lockfile or bundle |
| `stasis sbom --format=cyclonedx app.stasis.code.br` | export a CycloneDX SBOM for a lockfile or bundle |

Each command's options are documented in [doc/](https://github.com/PreventiveMeasures/stasis/tree/main/doc):
[`run`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/run.md),
[`bundle`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/bundle.md) (and `add`),
[`github-bundle`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/github-bundle.md),
[`build`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/build.md),
[`extract`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/extract.md),
[`diff`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/diff.md),
[`prune`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/prune.md),
[`audit`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/audit.md),
[`sbom`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/sbom.md).
`stasis bundle` also bundles Solidity, PHP, Bash, Rust and C/C++ sources, see [file formats](https://github.com/PreventiveMeasures/stasis/blob/main/doc/file-formats.md#source-language-bundles-solidity--php--bash--rust).

## Runtime

The zero-dependency [`@exodus/stasis-core`](../stasis-core) CLI provides the `run`, `add`, `extract` and `prune` commands only.\
The bundler plugins live in [`@exodus/stasis-plugins`](../stasis-plugins).

## License

[MIT](./LICENSE)
