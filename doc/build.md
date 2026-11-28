# `stasis build`

`stasis build` runs [esbuild](https://esbuild.github.io/) over a stasis
artifact's entry point to produce a runnable JavaScript bundle. It follows the
artifact's **recorded import graph exactly**, not esbuild's resolution: every
import resolves to the attested edge and every module's bytes come from the
artifact, not disk.

```sh
stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral|hermes)] [--babel|--flow] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] [--metro=(ios|android|...) [--assets-dest=dir]] path/to/(stasis.code.br|stasis.lock.json|name.stasis.tgz) [entry]
```

- First positional (**required**): the `stasis.code.br` bundle or `stasis.lock.json` lockfile to build from.
- Second positional (optional): the **entry point** to build (see [Entry point](#entry-point)).

| Flag | Meaning |
| - | - |
| `--output` / `-o` (**required**) | Where to write. A path ending in `.js`/`.cjs`/`.mjs` names a single file; anything else is a directory. |
| `--format` | esbuild output format `esm`\|`cjs`\|`iife`. Default `esm` (`iife` under `--platform=hermes`). |
| `--platform` | Target platform `node`\|`browser`\|`neutral` (esbuild's), or `hermes`. Default `node`. See [Hermes](#hermes---platformhermes). |
| `--babel` | Transform every code file with the project's own `babel.config.*` before bundling. See [`--babel`](#the-projects-babel-config---babel). |
| `--flow` | Strip Flow types from `.js`/`.cjs`/`.mjs`/`.jsx` files marked `@flow` or that esbuild can't parse. On under `--metro` (not with `--babel`). See [Flow](#flow). |
| `--minify`, `--sourcemap` | Forwarded to esbuild. |
| `--define=KEY=VALUE` (repeatable) | esbuild [define](https://esbuild.github.io/api/#define); the value is passed verbatim and must be valid JS (e.g. `--define=process.env.NODE_ENV='"production"'`, `--define=__DEV__=false`). Under `--metro`, `__DEV__` and `process.env.NODE_ENV` default to Metro's release values. |
| `--external=PATTERN` (repeatable) | esbuild [external](https://esbuild.github.io/api/#external). See [Externals](#externals). |
| `--loader=.EXT:NAME` (repeatable) | esbuild [loader](https://esbuild.github.io/api/#loader) override for an extension, e.g. `--loader=.js:jsx`, `--loader=.png:dataurl`. See [JSX in `.js`/`.ts`](#jsx-in-jsts). |
| `--metro=PLATFORM` | Build a `--metro` bundle for one platform as Metro's release build does: that platform's edges, assets as Metro asset modules, JSX in `.js`, Flow stripped, Metro's release defines. See [Metro](#metro---metroplatform). |
| `--assets-dest=DIR` | With `--metro`: copy the assets' files to `DIR` as `react-native bundle --assets-dest` does. |

If the artifact's `stasis.config.json` names the entry, its options set some of
these flags: see [Entry options](#entry-options-stasisconfigjson).

`--format`/`--platform`/`--minify`/`--sourcemap`/`--define` only steer esbuild's
output; the import graph is fixed by the artifact. `--platform=hermes` and
`--babel` also transform each file's *content*, still following the recorded
graph. `--metro` picks one platform's targets of the per-platform edges, and
adds one edge to each asset: to the asset registry the artifact carries.

## Entry options (`stasis.config.json`)

A bundle carries the project's `stasis.config.json` at its root when the config
sets [`extra`](file-formats.md#stasisconfigjson) (`"extra": []` adds the config
alone). If the config's [`entries`](bundle.md#entry-options-stasisconfigjson)
names the entry being built, `stasis build` takes the entry's options that say
how the code is built:

| Option | Becomes |
| - | - |
| `"jsx": true` | `--loader=.js:jsx` |
| `"flow": true` | `--flow`, unless `--babel` |
| `"define": ["K=V", ...]` | `--define=K=V` for each |
| `"metro": true` | `--metro=PLATFORM` for its one `platforms` entry, with all `--metro` implies. With several, `--metro` is required, one of them |

```json
{ "extra": [], "entries": { "index.js": { "metro": true, "platforms": ["ios", "android"], "define": ["process.env.API=\"https://api.example.com\""] } } }
```

```sh
stasis build --platform=hermes --metro=ios --output=main.js stasis.code.br   # --define=process.env.API=... from the config
```

- The config's top-level `define` (see [Defines](bundle.md#defines---define))
  applies to every entry, named in `entries` or not. A config that sets it
  beside an entry's own is refused.
- A flag given always wins: an explicit `--loader=.js:...` over `jsx`, and a
  `--define` over the config's value for its key.
- An explicit `--metro` must be one of the config's `platforms`.
- `stasis build` prints the flags it took from the config.
- The config's other options (`resources`, `conditions`, `babel` and so on) are
  not read.
- An entry is named as in `stasis bundle`: by its path from the config's
  directory (the artifact's root), or by a
  [glob pattern](bundle.md#entry-patterns) matching that path by Node's
  `path.matchesGlob`, never an entry in a `node_modules`. An exact path key is
  taken before a pattern, and a pattern with a `.` or `..` segment is refused.

## Externals

`--external=PATTERN` only affects specifiers the artifact does **not** record,
which are handed back to esbuild. Re-declare capture-time externals with it to
keep them as runtime imports; it can't un-inline an attested edge.

```sh
# the captured bundle imported a native module that was external at capture; keep it external
stasis build --output=out.cjs --format=cjs --external=better-sqlite3 app.code.br
```

## Hermes (`--platform=hermes`)

Hermes (React Native's engine) executes a dialect without classes, class fields,
private members, `let`/`const`, arrow functions, async generators or `for await`.
`--platform=hermes` downlevels every code file before the final bundle:

1. **esbuild pre-transform** — lowers class fields / private members / static
   blocks / `using` into plain class syntax, stripping TypeScript and compiling
   JSX.
2. **Babel worker pool** — applies `@babel/plugin-transform-block-scoping` and
   `@babel/plugin-transform-classes`.
3. **Final esbuild bundle** — lowers arrows, async generators and `for await`,
   and fails if a `class` or `let`/`const` survived.

`--format` defaults to `iife`; `esm` is rejected, `cjs` allowed. esbuild runs
as platform `neutral`.

```sh
stasis build --platform=hermes --output=out.js app.code.br   # feed out.js to hermesc
```

Babel is resolved **from the project** (the directory you run `stasis build`
in), never from stasis's own dependencies:

```sh
npm i -D @babel/core @babel/plugin-transform-block-scoping @babel/plugin-transform-classes
```

## Metro (`--metro=PLATFORM`)

A [`stasis bundle --metro --platforms=ios,android`](bundle.md#metro---metro) bundle
covers every platform it names. `--metro=PLATFORM` builds it for one, as Metro
does:

- **Per-platform edges.** An import that resolves differently per platform
  (`./where` to `where.ios.js` or `where.android.js`) takes `PLATFORM`'s
  target; an edge with no target for `PLATFORM` fails the build. Without
  `--metro`, any such edge fails the build.
- **Assets.** Each asset an import reaches (`require('./img/logo.png')`, a
  resource carried with `--resources`) becomes Metro's asset module:

  ```js
  module.exports = require('react-native/Libraries/Image/AssetRegistry').registerAsset({
    __packager_asset: true, httpServerLocation: '/assets/img', width: 20, height: 10,
    scales: [1, 2, 3], hash: '…', name: 'logo', type: 'png' })
  ```

  so `require()` returns the asset's registry id, as `<Image source>` expects.
  The descriptor is built from the asset's files the bundle carries in its
  directory, those Metro reads for `PLATFORM`: each scale (`logo@2x.png`,
  `logo@3x.png`), and `PLATFORM`'s own files (`logo.ios.png`) if any. `scales`
  lists them in order, `hash` is the md5 of their bytes, and `width`/`height`
  are the first file's dimensions divided by its scale (images only).
  `httpServerLocation` is `/assets` plus the asset's directory relative to the
  artifact's root. This is Metro 0.87's `getAssetData`, image-size parsing
  included, as
  [`@preventive/rn`](https://github.com/PreventiveMeasures/libraries/tree/main/rn)
  builds it, run on the artifact's bytes.
- **As a release build.** It builds as `react-native bundle --dev false` does:
  JSX in `.js` parses (`--loader=.js:jsx`, unless a `--loader` names `.js`),
  Flow types are stripped (`--flow`, unless `--babel`), `__DEV__` is defined as
  `false` and `process.env.NODE_ENV` as `"production"`. A `--define`, or the
  entry's `define`, for either name overrides that one only
  (`--define=__DEV__=true`).
- **The asset registry.** `react-native/Libraries/Image/AssetRegistry` (React
  Native's `assetRegistryPath`) resolves to a copy the bundle carries
  (`stasis bundle --metro` carries one but records no edge to it): the nearest
  `node_modules/react-native` above the asset, else the bundle's only copy
  (pnpm's). The build fails if the bundle carries none (bundle from a project
  with `react-native` installed).

`--assets-dest=DIR` copies each asset's files as React Native 0.88's
`react-native bundle --assets-dest` does for `PLATFORM`: `android` uses
Android's `res/` layout (`drawable-mdpi/img_logo.png` … `drawable-xxhdpi/`, a
scale with no density of its own as `drawable-<dpi>dpi/`, `raw/` for
non-drawable types, plus `raw/keep.xml`). Any other platform uses iOS's layout
(`assets/img/logo@2x.png`, scales 1x–3x only). The copies use the artifact's
bytes, and the build refuses to overwrite a file the artifact carries.

```sh
stasis bundle --metro --platforms=ios,android --resources=png,ttf index.js
stasis build --platform=hermes --metro=ios --assets-dest=ios/build --output=ios/build/main.js stasis.code.br
stasis build --platform=hermes --metro=android --assets-dest=android/app/src/main/res --output=android/app/src/main/assets/index.android.js stasis.code.br
```

`--output` names a file only when it ends in `.js`/`.cjs`/`.mjs`
(`main.jsbundle` would be a directory), so compile the `.js` with hermesc, e.g.
`hermesc -emit-binary -out ios/build/main.jsbundle ios/build/main.js`.

A `--loader` naming an asset's extension takes precedence over the asset
module. A project's Metro config `assetRegistryPath`, `transformer.publicPath`
and `transformer.assetPlugins` are not applied. iOS asset catalogs
(`--asset-catalog-dest`) are not written. A bundle doesn't record the platforms
it was made for, so building an `ios`-only bundle for `android` goes unnoticed
wherever no asset or edge has a per-platform variant.

## The project's Babel config (`--babel`)

`--babel` runs every code file through the project's own
`babel.config.(js|cjs|mjs|json)` (resolved from the project directory, plugins
and presets included) **instead of** the built-in pipeline: Babel gets each
file's attested bytes verbatim. Its output must be plain JS that esbuild can
parse; a config that leaves TS/JSX in place fails the build.

With `--platform=hermes`, the config **replaces** steps 1–2 of the downlevel;
step 3's Hermes checks still apply, so a config that doesn't lower classes or
`let`/`const` fails the build.

```sh
stasis build --babel --platform=hermes --output=out.js app.code.br
```

`--babel` needs `@babel/core` installed in the project (a dev dependency is
fine); a missing config or install fails with instructions.

## esbuild is an optional peer dependency

esbuild is not a hard dependency of `@exodus/stasis`. Install it:

```sh
npm i -D esbuild      # locally (a peer dep, or any project copy)
npm i -g esbuild      # or globally
```

`stasis build` resolves a local install first, then a global one, and errors if neither is present.

## Entry point

| Artifact records | Entry argument |
| - | - |
| **one** entry | Optional; that entry is used. |
| **several** entries | Required; omitting it (or naming an unrecorded entry) fails with the list of available entries. |

The entry matches the artifact's recorded project-relative entry paths (e.g.
`src/index.js`); a leading `./` is allowed, and a cwd-relative path is made
relative to the project root before matching.

```sh
stasis build app.stasis.code.br src/worker.js   # build the src/worker.js entry
```

## Bundle vs. lockfile

| | Bundle (`stasis.code.br`) | Lockfile (`stasis.lock.json`) |
| - | - | - |
| Carries | Every reachable source | The graph + per-file digests, no content |
| Needs on disk | Nothing — not even a `package.json` | Each attested file, read from disk |
| Resolution / bytes | `imports` map + `sources` bytes | Reads the file, verifies its `sha512` before use |

A specifier the artifact doesn't record is handed back to esbuild, which
externalizes it. Where disk bytes differ from the artifact, a bundle uses its own
bytes and a lockfile fails the build.

A [`.stasis.tgz`](file-formats.md#stasistgz) builds like a bundle, needing
nothing on disk; each of its files is checked against its `sha512` as the tgz
is read, before the build starts.

## Scope and language

`stasis build` requires a **full-scope** artifact; a `node_modules`-scope one
lacks the entry and the workspace's own code.

Only JavaScript/TypeScript is supported, plus the stylesheets it imports
(`css`, by esbuild's `css` loader, each `url()` by its extension's loader: see
[Stylesheets](bundle.md#stylesheets-css)). The entry may be
`.js`/`.cjs`/`.mjs`/`.ts`/`.cts`/`.mts`/`.jsx`/`.tsx`, its loader chosen by
extension. JSX compiles to esbuild's default classic runtime
(`React.createElement`), overridable per file with a `/** @jsx ... */` pragma;
esbuild's `jsx`/`jsxFactory` options are not exposed and `--platform` does not
affect the JSX runtime. Solidity/PHP/Bash/Rust entries are rejected.

### JSX in `.js`/`.ts`

JSX is parsed automatically only in `.jsx`/`.tsx` files; JSX in a `.js` file
fails with *"The JSX syntax extension is not currently enabled"*. Opt in per
extension with `--loader` (e.g. `--loader=.mjs:jsx`):

```sh
stasis build --output=out.js --loader=.js:jsx app.code.br   # parse JSX in .js
```

`stasis bundle` fails the same way: JSX in a `.js`/`.cjs`/`.mjs` file is an
*"Unexpected token"* parse error, which fails the bundle (`JS bundle would be
broken at load time`). Pass it `--jsx` to parse past the JSX and store the
source verbatim for `stasis build --loader=.js:jsx` to transform:

```sh
stasis bundle --jsx index.js                          # JSX-in-.js
stasis bundle --metro --platforms=ios,android index.js  # React Native: --metro turns --jsx on
```

`--jsx` is off by default and only covers `.js`/`.cjs`/`.mjs`; the `.ts` family
is never parsed as JSX (put JSX-in-TS in a `.tsx` file). `.jsx`/`.tsx` files
need no flag: the scanner parses them as JSX/TSX by extension, as an entry or as
a dependency (e.g. a package whose React Native entry is `src/index.tsx`), and
stores their source verbatim for `stasis build` to transform. The
`--metro`/`--mainFields` resolver probes `.jsx`/`.tsx` for extensionless
imports, in Metro's default order (`js`, `jsx`, `json`, `ts`, `tsx`).

### Flow

esbuild doesn't parse Flow. `--flow` strips Flow types from
`.js`/`.cjs`/`.mjs`/`.jsx` files as React Native's Babel preset does, using
stasis's own `flow-remove-types` (not the project's), before esbuild or the
`--platform=hermes` downlevel. `--metro` turns it on:

```sh
stasis bundle --flow index.js
stasis build --flow --output=main.js stasis.code.br
stasis build --platform=hermes --metro=ios --output=main.js stasis.code.br   # --flow too
```

- A file marked `@flow` anywhere is always stripped, and syntax both Flow and JS
  can read is read as Flow (`id<number>(5)` calls `id`).
- Any other file is stripped only if esbuild can't parse it, and syntax both can
  read is read as JS (`a < b > (c)` compares).
- An import of types alone (`import { type A } from`) is dropped whole; a
  `--metro` bundle records no edge for it.
- Stripping removes types only: a file with Flow syntax that compiles to code
  (`component` and `hook` declarations, `enum`s, `match`) fails the build, as
  it fails `stasis bundle --flow`, unless it is React Native's own, which is
  lowered first.

[`--babel`](#the-projects-babel-config---babel) compiles all of Flow instead:
React Native's preset also compiles `component`, `hook` and `enum`. `--flow`
and `--babel` don't combine.

### Non-code assets (`--resources`)

A React Native entry may `import logo from './logo.png'`. By default a reached
non-code file is fatal (*"a source bundle can't carry"*). Pass
`--resources=<ext-or-name>[,…]` to carry the allowlisted files as resources
instead, with their import edges recorded:

```sh
stasis bundle --metro --platforms=ios,android --resources=png,svg,ttf index.js
```

Each file is stored as `resource` if UTF-8 (e.g. `.svg`), else
`resource:base64` (e.g. `.png`). Allowlist entries are bare extensions (`png`)
or extensionless filenames (`LICENSE`); code extensions are rejected. Only files
*reached through the import graph* are carried. `--resources` is JS-only and
works with plain, `--mainFields` and `--metro` alike.

To emit a resource, `stasis build` needs a matching `--loader` (e.g.
`--loader=.png:dataurl`) or [`--metro=PLATFORM`](#metro---metroplatform), which
builds it as Metro's asset module. With neither, an entry that imports one fails
with esbuild's *No loader is configured for ".png" files*.

## Known limitation: CommonJS default-import interop

When an ESM module default-imports a CommonJS dependency that sets `__esModule`
(`exports.__esModule = true; exports.default = …`), `import dep from 'cjs-pkg'`
binds differently:

| | `dep` binds to | Reach the value via |
| - | - | - |
| **Node** / `stasis run` (ignores `__esModule`) | the whole `module.exports` | `dep.default` |
| **esbuild** / `stasis build` (bundler convention) | `module.exports.default` directly | `dep` |

The recorded graph is still followed exactly. Named imports (`import { x } from
…`) and CommonJS packages that don't set `__esModule` are unaffected. The
esbuild/webpack capture plugins match `stasis build`, so the divergence is only
against `stasis run` and a plain on-disk `esbuild` build.
