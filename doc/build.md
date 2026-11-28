# `stasis build`

`stasis build` runs [esbuild](https://esbuild.github.io/) over a stasis
artifact's entry point to produce a runnable JavaScript bundle. It follows the
artifact's **recorded import graph exactly**, not esbuild's resolution, and
takes every module's bytes from the artifact.

```sh
stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral|hermes)] [--babel|--flow] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] [--metro=(ios|android|...) [--assets-dest=dir]] path/to/(stasis.code.br|stasis.lock.json|name.stasis.tgz) [entry]
```

The first argument (**required**) is the artifact to build from, the second
(optional) the [entry point](#entry-point).

| Flag | Meaning |
| - | - |
| `--output` / `-o` (**required**) | Where to write. A path ending in `.js`/`.cjs`/`.mjs` names a single file; anything else is a directory. |
| `--format` | esbuild output format `esm`\|`cjs`\|`iife`. Default `esm` (`iife` under `--platform=hermes`). |
| `--platform` | Target platform `node`\|`browser`\|`neutral` (esbuild's), or `hermes`. Default `node`. See [Hermes](#hermes---platformhermes). |
| `--babel` | Transform every code file with the project's own `babel.config.*` before bundling. See [`--babel`](#the-projects-babel-config---babel). |
| `--flow` | Strip Flow types from `.js`/`.cjs`/`.mjs`/`.jsx` files marked `@flow` or that esbuild can't parse. On under `--metro` (not with `--babel`). See [Flow](#flow). |
| `--minify`, `--sourcemap` | Forwarded to esbuild. |
| `--define=KEY=VALUE` (repeatable) | esbuild [define](https://esbuild.github.io/api/#define); the value is passed verbatim and must be valid JS (e.g. `--define=process.env.NODE_ENV='"production"'`, `--define=__DEV__=false`). |
| `--external=PATTERN` (repeatable) | esbuild [external](https://esbuild.github.io/api/#external). See [Externals](#externals). |
| `--loader=.EXT:NAME` (repeatable) | esbuild [loader](https://esbuild.github.io/api/#loader) override for an extension, e.g. `--loader=.js:jsx`, `--loader=.png:dataurl`. See [JSX in `.js`/`.ts`](#jsx-in-jsts). |
| `--metro=PLATFORM` | Build a `--metro` bundle for one platform, as Metro's release build does. See [Metro](#metro---metroplatform). |
| `--assets-dest=DIR` | With `--metro`: copy the assets' files to `DIR` as `react-native bundle --assets-dest` does. |

## Entry options (`stasis.config.json`)

If the artifact carries a `stasis.config.json` (one setting
[`extra`](file-formats.md#stasisconfigjson) adds itself) whose
[`entries`](bundle.md#entry-options-stasisconfigjson) names the entry being
built, the entry's options below become flags:

| Option | Becomes |
| - | - |
| `"jsx": true` | `--loader=.js:jsx` |
| `"flow": true` | `--flow`, unless `--babel` |
| `"define": ["K=V", ...]` | `--define=K=V` for each |
| `"metro": true` | `--metro=PLATFORM` for its one `platforms` entry, with all `--metro` implies. With several, `--metro` is required |

```json
{ "extra": [], "entries": { "index.js": { "metro": true, "platforms": ["ios", "android"], "define": ["process.env.API=\"https://api.example.com\""] } } }
```

```sh
stasis build --platform=hermes --metro=ios --output=main.js stasis.code.br   # --define=process.env.API=... from the config
```

- The config's top-level `define` (see [Defines](bundle.md#defines---define))
  applies to every entry, named in `entries` or not; a config setting it beside
  an entry's own is refused.
- A flag given always wins: `--loader=.js:...` over `jsx`, a `--define` over
  the config's value for its key.
- An explicit `--metro` must be one of the config's `platforms`.
- The flags taken from the config are printed.
- The config's other options (`resources`, `conditions`, `babel`, …) are not
  read.
- An entry is named as in `stasis bundle`: by its path from the config's
  directory (the artifact's root) or by a
  [glob pattern](bundle.md#entry-patterns), an exact path before a pattern. A
  pattern with a `.` or `..` segment is refused.

## Externals

A specifier the artifact doesn't record is handed back to esbuild, which
externalizes it. `--external=PATTERN` only affects those: it can't un-inline an
attested edge.

```sh
# the captured bundle imported a native module that was external at capture; keep it external
stasis build --output=out.cjs --format=cjs --external=better-sqlite3 app.code.br
```

## Hermes (`--platform=hermes`)

`--platform=hermes` downlevels every code file to the dialect of Hermes (React
Native's engine) before the final bundle:

1. **esbuild pre-transform** — lowers class fields, private members, static
   blocks and `using` to plain classes, stripping TypeScript and compiling JSX.
2. **Babel worker pool** — applies `@babel/plugin-transform-block-scoping` and
   `@babel/plugin-transform-classes`.
3. **Final esbuild bundle** — lowers arrows, async generators and `for await`,
   and fails if a `class` or `let`/`const` survived.

`--format=esm` is rejected. esbuild runs as platform `neutral`.

```sh
stasis build --platform=hermes --output=out.js app.code.br   # feed out.js to hermesc
```

Babel is resolved **from the project** (the cwd), never from stasis's own
dependencies:

```sh
npm i -D @babel/core @babel/plugin-transform-block-scoping @babel/plugin-transform-classes
```

## Metro (`--metro=PLATFORM`)

`--metro=PLATFORM` builds a
[`stasis bundle --metro --platforms=ios,android`](bundle.md#metro---metro)
bundle for one of its platforms, as Metro does:

- **Per-platform edges.** An import that resolves differently per platform
  (`./where` to `where.ios.js` or `where.android.js`) takes `PLATFORM`'s
  target; one with no target for `PLATFORM` fails the build, as does any
  per-platform edge without `--metro`.
- **Assets.** Each asset an import reaches (`require('./img/logo.png')`, a
  resource carried with `--resources`) becomes Metro's asset module, so
  `require()` returns its registry id:

  ```js
  module.exports = require('react-native/Libraries/Image/AssetRegistry').registerAsset({
    __packager_asset: true, httpServerLocation: '/assets/img', width: 20, height: 10,
    scales: [1, 2, 3], hash: '…', name: 'logo', type: 'png' })
  ```

  The descriptor is Metro 0.87's `getAssetData`, image-size parsing included,
  as [`@preventive/rn`](https://github.com/PreventiveMeasures/libraries/tree/main/rn)
  builds it, over the files Metro reads for `PLATFORM` that the bundle carries
  in the asset's directory: each scale (`logo@2x.png`), and `PLATFORM`'s own
  files (`logo.ios.png`) if any.
- **As a release build** (`react-native bundle --dev false`): `--metro` implies
  `--loader=.js:jsx` (unless a `--loader` names `.js`) and `--flow` (unless
  `--babel`), and defines `__DEV__` as `false` and `process.env.NODE_ENV` as
  `"production"`; a `--define`, or the entry's `define`, for either name
  overrides that one only (`--define=__DEV__=true`).
- **The asset registry.** `react-native/Libraries/Image/AssetRegistry`
  resolves to the bundle's copy in the nearest `node_modules/react-native`
  above the asset, else its only copy (pnpm's); `stasis bundle --metro`
  carries one, recording no edge to it. A bundle with none fails the build
  (bundle from a project with `react-native` installed).

`--assets-dest=DIR` copies each asset's files, with the artifact's bytes, as
React Native 0.88's `react-native bundle --assets-dest` lays them out for
`PLATFORM`: Android's `res/` layout for `android` (`drawable-mdpi/img_logo.png`
… `drawable-xxhdpi/`, `raw/` for non-drawable types, plus `raw/keep.xml`),
iOS's for any other (`assets/img/logo@2x.png`, scales 1x–3x only). The build
refuses to overwrite a file the artifact carries.

```sh
stasis bundle --metro --platforms=ios,android --resources=png,ttf index.js
stasis build --platform=hermes --metro=ios --assets-dest=ios/build --output=ios/build/main.js stasis.code.br
stasis build --platform=hermes --metro=android --assets-dest=android/app/src/main/res --output=android/app/src/main/assets/index.android.js stasis.code.br
```

Compile the `.js` with hermesc (`--output=main.jsbundle` would be a directory),
e.g. `hermesc -emit-binary -out ios/build/main.jsbundle ios/build/main.js`.

A `--loader` naming an asset's extension takes precedence over the asset
module. A project's Metro config `assetRegistryPath`, `transformer.publicPath`
and `transformer.assetPlugins` are not applied, and iOS asset catalogs
(`--asset-catalog-dest`) are not written. A bundle doesn't record the platforms
it was made for, so building an `ios`-only bundle for `android` goes unnoticed
wherever no asset or edge has a per-platform variant.

## The project's Babel config (`--babel`)

`--babel` passes each code file's attested bytes, verbatim, through the
project's own `babel.config.(js|cjs|mjs|json)` (resolved from the project
directory, plugins and presets included) **instead of** the built-in pipeline.
Its output must be plain JS esbuild can parse: a config that leaves TS/JSX in
place fails the build. With `--platform=hermes` it **replaces** steps 1–2 of
the downlevel, and step 3 still fails on a surviving `class` or `let`/`const`.

```sh
stasis build --babel --platform=hermes --output=out.js app.code.br
```

It needs `@babel/core` installed in the project; a missing config or install
fails with instructions.

## esbuild is an optional peer dependency

`stasis build` uses a local install of esbuild, else a global one, and fails
without either:

```sh
npm i -D esbuild      # locally (a peer dep, or any project copy)
npm i -g esbuild      # or globally
```

## Entry point

| Artifact records | Entry argument |
| - | - |
| **one** entry | Optional; that entry is used. |
| **several** entries | Required; omitting it (or naming an unrecorded entry) fails with the list of available entries. |

The entry is a recorded project-relative entry path (`src/index.js`), a
leading `./` allowed; a cwd-relative path is first made relative to the project
root.

```sh
stasis build app.stasis.code.br src/worker.js   # build the src/worker.js entry
```

## Bundle vs. lockfile

| | Bundle (`stasis.code.br`) | Lockfile (`stasis.lock.json`) |
| - | - | - |
| Carries | Every reachable source | The graph + per-file digests, no content |
| Needs on disk | Nothing — not even a `package.json` | Each attested file, read from disk |
| Resolution / bytes | `imports` map + `sources` bytes | Reads the file, verifies its `sha512` before use: a mismatch fails the build |

A [`.stasis.tgz`](file-formats.md#stasistgz) builds like a bundle, each of its
files checked against its `sha512` before the build starts.

## Scope and language

`stasis build` requires a **full-scope** artifact, not a `node_modules`-scope
one.

Only JavaScript/TypeScript is supported, plus the
[stylesheets](bundle.md#stylesheets-css) it imports. The entry may be
`.js`/`.cjs`/`.mjs`/`.ts`/`.cts`/`.mts`/`.jsx`/`.tsx`, its loader chosen by
extension; Solidity/PHP/Bash/Rust entries are rejected. JSX compiles to
esbuild's default classic runtime (`React.createElement`), overridable per file
with a `/** @jsx ... */` pragma; esbuild's `jsx`/`jsxFactory` options are not
exposed.

### JSX in `.js`/`.ts`

JSX is parsed automatically only in `.jsx`/`.tsx` files; JSX in a `.js` file
fails with *"The JSX syntax extension is not currently enabled"*. Opt in per
extension with `--loader` (e.g. `--loader=.mjs:jsx`):

```sh
stasis build --output=out.js --loader=.js:jsx app.code.br   # parse JSX in .js
```

To carry JSX in `.js`/`.cjs`/`.mjs`, `stasis bundle` needs
[`--jsx`](bundle.md#jsx-and-flow), which stores the source verbatim for
`--loader=.js:jsx` to transform:

```sh
stasis bundle --jsx index.js                          # JSX-in-.js
stasis bundle --metro --platforms=ios,android index.js  # React Native: --metro turns --jsx on
```

### Flow

`--flow` strips Flow types as React Native's Babel preset does, with stasis's
own `flow-remove-types` (not the project's), before esbuild or the
`--platform=hermes` downlevel:

```sh
stasis bundle --flow index.js
stasis build --flow --output=main.js stasis.code.br
stasis build --platform=hermes --metro=ios --output=main.js stasis.code.br   # --flow too
```

| File | Stripped | Syntax both Flow and JS can read is read as |
| - | - | - |
| Marked `@flow` anywhere | Always | Flow (`id<number>(5)` calls `id`) |
| Any other | Only if esbuild can't parse it | JS (`a < b > (c)` compares) |

- An import of types alone (`import { type A } from`) is dropped whole; a
  `--metro` bundle records no edge for it.
- Stripping removes types only: a file with Flow syntax that compiles to code
  (`component` and `hook` declarations, `enum`s, `match`) fails the build,
  unless it is React Native's own, which is lowered first.

[`--babel`](#the-projects-babel-config---babel) compiles all of Flow instead:
React Native's preset also compiles `component`, `hook` and `enum`. `--flow`
and `--babel` don't combine.

### Non-code assets (`--resources`)

A reached non-code file is fatal (*"a source bundle can't carry"*) unless
[`--resources`](bundle.md#resources-and-manifests) allowlists it (code
extensions are rejected); it is then carried as a
[resource](file-formats.md#resources-in-the-bundle), with its import edges
recorded. `--resources` is JS-only, with or without `--mainFields` or
`--metro`.

```sh
stasis bundle --metro --platforms=ios,android --resources=png,svg,ttf index.js
```

`stasis build` emits a resource by a matching `--loader` (e.g.
`--loader=.png:dataurl`) or, under [`--metro=PLATFORM`](#metro---metroplatform),
as Metro's asset module; with neither, importing one fails (*No loader is
configured for ".png" files*).

## Known limitation: CommonJS default-import interop

When an ESM module default-imports a CommonJS dependency that sets `__esModule`
(`exports.__esModule = true; exports.default = …`), `import dep from 'cjs-pkg'`
binds differently:

| | `dep` binds to | Reach the value via |
| - | - | - |
| **Node** / `stasis run` (ignores `__esModule`) | the whole `module.exports` | `dep.default` |
| **esbuild** / `stasis build` (bundler convention) | `module.exports.default` directly | `dep` |

Named imports (`import { x } from …`), and CommonJS packages that don't set
`__esModule`, are unaffected. The esbuild/webpack capture plugins bind as
`stasis build` does.
