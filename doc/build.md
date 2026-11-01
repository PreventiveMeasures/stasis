# `stasis build`

`stasis build` runs [esbuild](https://esbuild.github.io/) over a stasis
artifact's entry point to produce a conventional, runnable JavaScript bundle,
following the artifact's **recorded import graph exactly** instead of esbuild's
own resolution: every import resolves to the edge stasis attested and every
module's bytes come from the artifact, not disk.

```sh
stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral|hermes)] [--babel|--flow] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] [--metro=(ios|android|...) [--assets-dest=dir]] path/to/(stasis.code.br|stasis.lock.json) [entry]
```

- First positional (**required**): the `stasis.code.br` bundle or `stasis.lock.json` lockfile to build from.
- Second positional (optional): the **entry point** to build (see [Entry point](#entry-point)).

| Flag | Meaning |
| - | - |
| `--output` / `-o` (**required**) | Where to write. A path ending in `.js`/`.cjs`/`.mjs` names a single file; anything else is a directory. |
| `--format` | esbuild output format `esm`\|`cjs`\|`iife`. Default `esm` (`iife` under `--platform=hermes`). |
| `--platform` | Target platform `node`\|`browser`\|`neutral` (esbuild's), or `hermes`. Default `node`. See [Hermes](#hermes---platformhermes). |
| `--babel` | Transform every code file with the project's own `babel.config.*` before bundling. See [`--babel`](#the-projects-babel-config---babel). |
| `--flow` | Strip Flow types from a `.js`/`.cjs`/`.mjs`/`.jsx` file esbuild can't parse, as `stasis bundle --flow` does. See [Flow](#flow). |
| `--minify`, `--sourcemap` | Forwarded to esbuild. |
| `--define=KEY=VALUE` (repeatable) | esbuild [define](https://esbuild.github.io/api/#define); value forwarded verbatim, must be valid JS as esbuild's CLI expects (e.g. `--define=process.env.NODE_ENV='"production"'`, `--define=__DEV__=false`). |
| `--external=PATTERN` (repeatable) | esbuild [external](https://esbuild.github.io/api/#external). See [Externals](#externals). |
| `--loader=.EXT:NAME` (repeatable) | esbuild [loader](https://esbuild.github.io/api/#loader) override for an extension, e.g. `--loader=.js:jsx`, `--loader=.png:dataurl`. See [JSX in `.js`/`.ts`](#jsx-in-jsts). |
| `--metro=PLATFORM` | Build a `--metro` bundle for one platform as Metro builds it: its per-platform edges, and each asset as Metro's asset module. See [Metro](#metro---metroplatform). |
| `--assets-dest=DIR` | With `--metro`: copy the assets' files to `DIR` as `react-native bundle --assets-dest` does. |

Where the artifact carries a `stasis.config.json` naming the entry, its options
for it set some of these flags too: see [Entry options](#entry-options-stasisconfigjson).

`--format`/`--platform`/`--minify`/`--sourcemap`/`--define` only steer esbuild's
output; the import graph is fixed by the artifact. `--platform=hermes` and
`--babel` additionally transform each file's *content* on its way into the
bundle — the graph they follow is still exactly the recorded one. `--metro`
picks one platform's targets of the recorded per-platform edges, and gives each
asset the one edge Metro adds to it: to the asset registry the artifact carries.

## Entry options (`stasis.config.json`)

A bundle carries the project's `stasis.config.json` at its root when the config
sets [`extra`](file-formats.md#stasisconfigjson) (`"extra": []` adds the config
alone). If the config's [`entries`](bundle.md#entry-options-stasisconfigjson)
names the entry being built, `stasis build` reads that entry's options from it.
It reads them itself, apart from how `stasis bundle` uses them, and takes only
the ones that say how the code is built:

| Option | Becomes |
| - | - |
| `"jsx": true` | `--loader=.js:jsx` |
| `"flow": true` | `--flow` (not with `--babel`, whose config compiles Flow itself) |
| `"define": ["K=V", ...]` | `--define=K=V` for each, under the `--define`s given, which take precedence per key |
| `"metro": true` | `--metro=PLATFORM` for its one `platforms` entry. With several, `--metro` is required, one of them |

```json
{ "extra": [], "entries": { "index.js": { "metro": true, "platforms": ["ios", "android"], "jsx": true, "flow": true, "define": ["__DEV__=false"] } } }
```

```sh
stasis build --platform=hermes --metro=ios --output=main.js stasis.code.br   # --loader=.js:jsx --flow --define=__DEV__=false from the config
```

- A flag given always wins: an explicit `--loader=.js:...` takes precedence over
  `jsx`, and a `--define` over the config's value for its key.
- An explicit `--metro` must be one of the config's `platforms`, since those are
  the platforms the bundle was made for.
- `stasis build` prints the flags it took from the config.
- The config's other options (`resources`, `conditions`, `babel` and so on) say
  how the bundle was made and are not read.
- An entry is named as `stasis bundle` names it: by its path from the config's
  directory, which is the artifact's root.

## Externals

`--external=PATTERN` only affects specifiers the artifact does **not** record —
handed back to esbuild as misses. Re-declare capture-time externals with it so
esbuild leaves them as runtime imports; it can't un-inline an attested edge.

```sh
# the captured bundle imported a native module that was external at capture; keep it external
stasis build --output=out.cjs --format=cjs --external=better-sqlite3 app.code.br
```

## Hermes (`--platform=hermes`)

Hermes (React Native's engine) executes a dialect without classes, class fields,
private members, `let`/`const`, arrow functions, async generators or `for await`.
`--platform=hermes` downlevels every code file before the final bundle:

1. **esbuild pre-transform** — lowers class fields / private members / static
   blocks / `using` into plain class syntax (stripping TypeScript and compiling
   JSX on the way), the shape Babel's class transform can consume.
2. **Babel worker pool** — applies `@babel/plugin-transform-block-scoping` and
   `@babel/plugin-transform-classes`, the two lowerings esbuild refuses to do.
3. **Final esbuild bundle** — lowers arrows, async generators and `for await`,
   keeps its own helpers off `let`/`const`, and fails closed if a `class` or
   `let`/`const` somehow survived.

`--format` defaults to `iife` and `esm` is rejected (Hermes has no
`import`/`export`); `cjs` stays available for post-processing pipelines. esbuild
itself runs as platform `neutral`.

```sh
stasis build --platform=hermes --output=out.js app.code.br   # feed out.js to hermesc
```

Babel is resolved **from the project** (the directory you run `stasis build`
in), never from stasis's own dependencies — add the deps to the project:

```sh
npm i -D @babel/core @babel/plugin-transform-block-scoping @babel/plugin-transform-classes
```

## Metro (`--metro=PLATFORM`)

A [`stasis bundle --metro --platforms=ios,android`](bundle.md#metro---metro) bundle
is for every platform it names at once; Metro builds one platform at a time.
`--metro=PLATFORM` builds the bundle for `PLATFORM` the way Metro does:

- **Per-platform edges.** An import that resolves differently per platform
  (`./where` to `where.ios.js` or `where.android.js`) takes `PLATFORM`'s
  target. If an edge records no target for `PLATFORM`, the build fails: the
  bundle wasn't made for it. Without `--metro`, such an edge fails the build.
- **Assets.** Each asset an import reaches (`require('./img/logo.png')`, a
  resource carried with `--resources`) becomes the module Metro builds of it:

  ```js
  module.exports = require('react-native/Libraries/Image/AssetRegistry').registerAsset({
    __packager_asset: true, httpServerLocation: '/assets/img', width: 20, height: 10,
    scales: [1, 2, 3], hash: '…', name: 'logo', type: 'png' })
  ```

  so `require()` returns the asset's registry id, as `<Image source>` expects.
  The descriptor comes from every file of the asset that the bundle carries
  in its directory, the same files Metro reads for `PLATFORM`: each scale
  (`logo@2x.png`, `logo@3x.png`), and `PLATFORM`'s own files (`logo.ios.png`)
  where it has any. `scales` lists them in order, `hash` is the md5 of their
  bytes, and `width`/`height` are the first file's dimensions divided by its
  scale (images only). `httpServerLocation` is the asset's directory, relative
  to the artifact's root, under `/assets`. This is Metro 0.87's
  `getAssetData`, image-size parsing included, as
  [`@preventive/rn`](https://github.com/PreventiveMeasures/libraries/tree/main/rn)
  builds it, computed from the bytes the artifact carries.
- **The asset registry.** `react-native/Libraries/Image/AssetRegistry` (React
  Native's `assetRegistryPath`) resolves to the copy the bundle carries.
  `stasis bundle --metro` carries one for each asset but records no edge to
  it, because Metro adds it after the source. The build takes the nearest
  `node_modules/react-native` above the asset, otherwise the only copy the
  bundle carries (pnpm's). It fails if the bundle carries none (bundle from a
  project with `react-native` installed).

`--assets-dest=DIR` copies each asset's files out the way `react-native bundle
--assets-dest` (React Native 0.88's) does for `PLATFORM`: `android` uses
Android's `res/` layout (`drawable-mdpi/img_logo.png` … `drawable-xxhdpi/`, a
scale with no density of its own as `drawable-<dpi>dpi/`, `raw/` for
non-drawable types, plus `raw/keep.xml`). Any other platform uses iOS's layout
(`assets/img/logo@2x.png`, scales 1x–3x only). The copies use the artifact's
bytes, and the build refuses to overwrite a file the artifact carries.

```sh
stasis bundle --metro --platforms=ios,android --jsx --resources=png,ttf index.js
stasis build --platform=hermes --metro=ios --loader=.js:jsx --assets-dest=ios/build --output=ios/build/main.js stasis.code.br
stasis build --platform=hermes --metro=android --loader=.js:jsx --assets-dest=android/app/src/main/res --output=android/app/src/main/assets/index.android.js stasis.code.br
```

`--output` names a file only when it ends in `.js`/`.cjs`/`.mjs` (`main.jsbundle`
would be a directory), so compile the `.js` into the bundle the app loads with
hermesc, e.g. `hermesc -emit-binary -out ios/build/main.jsbundle ios/build/main.js`.

A `--loader` naming an asset's extension takes precedence over the asset
module. A project's own Metro `assetRegistryPath`, `transformer.publicPath`
and `transformer.assetPlugins` are not applied, because they live in its Metro
config, which is code. iOS asset catalogs (`--asset-catalog-dest`) are not
written. A bundle records no list of the platforms it was made for, so an
asset or edge that has no per-platform variant can't reveal that a bundle
made only for `ios` is being built for `android`.

## The project's Babel config (`--babel`)

`--babel` runs every code file through the project's own
`babel.config.(js|cjs|mjs|json)` — resolved from the project directory, plugins
and presets included — **instead of** the built-in pipeline, with no esbuild
pre-transform: Babel sees each file's attested bytes verbatim, exactly as the
project's own toolchain (e.g. Metro) would hand them over. The config's output
must be plain JS that esbuild can parse (a config that leaves TS/JSX in place
fails the build).

Combined with `--platform=hermes`, the project config **replaces** steps 1–2 of
the built-in downlevel while the final bundle's Hermes feature checks still
apply — so a config that doesn't lower classes or `let`/`const` fails closed
rather than shipping a bundle Hermes can't parse.

```sh
stasis build --babel --platform=hermes --output=out.js app.code.br
```

`--babel` needs `@babel/core` installed in the project (a dev dependency is
fine); a missing config or a missing install fails with instructions.

## esbuild is an optional peer dependency

esbuild is not a hard dependency of `@exodus/stasis`. Install it where stasis can find it:

```sh
npm i -D esbuild      # local (a peer dep, or any project copy)
npm i -g esbuild      # or globally
```

`stasis build` resolves a local install first, then a global one, and errors if neither is present.

## Entry point

The entry point is the optional second positional argument:

| Artifact records | Entry argument |
| - | - |
| **one** entry | Optional; that entry is used. |
| **several** entries | Required; omitting it (or naming an unrecorded entry) fails with the list of available entries. |

The selector matches the artifact's recorded, project-relative entry paths (e.g.
`src/index.js`); a leading `./` is tolerated and a cwd-relative path is normalized
into the project root before matching.

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
bytes and a lockfile fails the build closed.

## Scope and language

`stasis build` requires a **full-scope** artifact — a `node_modules`-scope one
omits the entry and the workspace's own code.

Only JavaScript/TypeScript is supported. The entry being built may be
`.js`/`.cjs`/`.mjs`/`.ts`/`.cts`/`.mts`/`.jsx`/`.tsx`, loader chosen from the
extension. JSX compiles to esbuild's default classic runtime
(`React.createElement`), overridable per file with a `/** @jsx ... */` pragma;
esbuild's `jsx`/`jsxFactory` options are not exposed and `--platform` does not
affect the JSX runtime. Solidity/PHP/Bash/Rust entries are rejected.

### JSX in `.js`/`.ts`

JSX is parsed automatically only in `.jsx`/`.tsx` files. JSX in plain `.js` files
(the React Native convention) otherwise fails with *"The JSX syntax extension is
not currently enabled"*. Opt in per extension with `--loader` (any esbuild
loader, e.g. `--loader=.mjs:jsx`):

```sh
stasis build --output=out.js --loader=.js:jsx app.code.br   # parse JSX in .js
```

The static `stasis bundle` scanner has the same blind spot for the same reason:
JSX in a `.js`/`.cjs`/`.mjs` file is an *"Unexpected token"* parse error, which
fails the bundle (`JS bundle would be broken at load time`), as every parse error
does: a file the scanner can't parse has an import graph it can't record. Pass `--jsx` (its
counterpart to `build`'s `--loader`) so the scanner parses past the JSX to the
import graph and stores the JSX source verbatim for `stasis build --loader=.js:jsx`
to transform later:

```sh
stasis bundle --metro --platforms=ios,android --jsx index.js   # React Native JSX-in-.js
```

`--jsx` is off by default and only covers the `.js`/`.cjs`/`.mjs` family, whose
extension can't tell whether a file holds JSX; the `.ts` family is left JSX-free
because its `<T>` generics collide with JSX (put JSX-in-TS in a `.tsx` file, as
TypeScript itself requires). `.jsx`/`.tsx` files need no flag: like esbuild, the
scanner parses them as JSX/TSX by extension, so a `.jsx`/`.tsx` entry — or a
dependency reached through one, e.g. a package whose React Native entry is
`src/index.tsx` — is scanned and bundled (its JSX source stored verbatim for
`stasis build` to transform), and the `--metro`/`--mainFields` resolver probes
`.jsx`/`.tsx` for extensionless imports, in Metro's default order (`js`, `jsx`,
`json`, `ts`, `tsx`).

### Flow

esbuild doesn't parse Flow. `--flow` strips Flow type syntax from a
`.js`/`.cjs`/`.mjs`/`.jsx` file esbuild can't parse, with the same
`flow-remove-types` that `stasis bundle --flow` uses (stasis's own dependency,
never the project's), then hands the result to esbuild, or to the
`--platform=hermes` downlevel:

```sh
stasis bundle --metro --platforms=ios,android --jsx --flow index.js
stasis build --platform=hermes --metro=ios --loader=.js:jsx --flow --output=main.js stasis.code.br
```

- A file esbuild already parses is left as written. Stripping plain JS as Flow can
  misread it: `a < b > (c)` would become a call.
- An import listing types alone (`import { type A } from`) is dropped whole, as
  Babel's Flow transform drops it. A `--metro` bundle records no edge for it.
- Stripping removes types only. Flow syntax that compiles to code (`component`
  and `hook` declarations, `enum`s) stays, so such a file fails the build, as it
  fails `stasis bundle --flow`. React Native 0.81's `View.js` and `VirtualView.js`
  are two such files.

[`--babel`](#the-projects-babel-config---babel) compiles all of Flow instead:
React Native's preset strips the types and compiles `component`, `hook` and
`enum` too, as Metro does. The project's config gets each file's bytes as they
are, so `--flow` and `--babel` don't combine.

### Non-code assets (`--resources`)

Not every import graph is loadable purely in JS: a React Native entry may
`import logo from './logo.png'`, and Metro consumes such assets from the bundle.
By default a reached non-code file is fatal — it *"a source bundle can't carry"*.
Pass `--resources=<ext-or-name>[,…]` to carry the allowlisted files as resources
instead, with their import edges recorded:

```sh
stasis bundle --metro --platforms=ios,android --resources=png,svg,ttf index.js
```

Each carried file is stored by content — `resource` for UTF-8 (e.g. `.svg`),
`resource:base64` for binary (e.g. `.png`) — the same formats the `--metro` native
capture and the esbuild/webpack plugins use. The allowlist entries are bare
extensions (`png`) or extensionless filenames (`LICENSE`); code extensions are
rejected (they're always tracked as code). Only files *reached through the import
graph* are carried — an allowlisted extension that nothing imports adds nothing.
`--resources` is JS-only and pairs with plain, `--mainFields`, and `--metro` alike.

A resource is carried, not built: `stasis build` (esbuild) needs either a matching
`--loader` (e.g. `--loader=.png:dataurl`) to emit one, or
[`--metro=PLATFORM`](#metro---metroplatform) to build it as Metro's asset module.
An entry that imports an asset with neither fails at build time with esbuild's
*No loader is configured for ".png" files*. The bundle or lockfile carries the
bytes for attestation and for Metro regardless.

## Known limitation: CommonJS default-import interop

When an ESM module default-imports a CommonJS dependency that marks itself
`__esModule` (the Babel/TypeScript shape — `exports.__esModule = true;
exports.default = …`), `import dep from 'cjs-pkg'` binds differently under the two
interop conventions:

| | `dep` binds to | Reach the value via |
| - | - | - |
| **Node** / `stasis run` (ignores `__esModule`) | the whole `module.exports` | `dep.default` |
| **esbuild** / `stasis build` (bundler convention) | `module.exports.default` directly | `dep` |

Only the interop shim differs; the recorded graph is followed exactly. Named
imports (`import { x } from …`) and CommonJS packages that don't set `__esModule`
are unaffected. This matches the esbuild/webpack capture plugins, so the
divergence is only against `stasis run` and a plain on-disk `esbuild` build.
