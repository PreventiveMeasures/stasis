# `stasis build`

`stasis build` runs [esbuild](https://esbuild.github.io/) over a stasis
artifact's entry point to produce a conventional, runnable JavaScript bundle,
following the artifact's **recorded import graph exactly** instead of esbuild's
own resolution: every import resolves to the edge stasis attested and every
module's bytes come from the artifact, not disk.

```sh
stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral|hermes)] [--babel] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] path/to/(stasis.code.br|stasis.lock.json) [entry]
```

- First positional (**required**): the `stasis.code.br` bundle or `stasis.lock.json` lockfile to build from.
- Second positional (optional): the **entry point** to build (see [Entry point](#entry-point)).

| Flag | Meaning |
| - | - |
| `--output` / `-o` (**required**) | Where to write. A path ending in `.js`/`.cjs`/`.mjs` names a single file; anything else is a directory. |
| `--format` | esbuild output format `esm`\|`cjs`\|`iife`. Default `esm` (`iife` under `--platform=hermes`). |
| `--platform` | Target platform `node`\|`browser`\|`neutral` (esbuild's), or `hermes`. Default `node`. See [Hermes](#hermes---platformhermes). |
| `--babel` | Transform every code file with the project's own `babel.config.*` before bundling. See [`--babel`](#the-projects-babel-config---babel). |
| `--minify`, `--sourcemap` | Forwarded to esbuild. |
| `--define=KEY=VALUE` (repeatable) | esbuild [define](https://esbuild.github.io/api/#define); value forwarded verbatim, must be valid JS as esbuild's CLI expects (e.g. `--define=process.env.NODE_ENV='"production"'`, `--define=__DEV__=false`). |
| `--external=PATTERN` (repeatable) | esbuild [external](https://esbuild.github.io/api/#external). See [Externals](#externals). |
| `--loader=.EXT:NAME` (repeatable) | esbuild [loader](https://esbuild.github.io/api/#loader) override for an extension, e.g. `--loader=.js:jsx`. See [JSX in `.js`/`.ts`](#jsx-in-jsts). |

`--format`/`--platform`/`--minify`/`--sourcemap`/`--define` only steer esbuild's
output; the import graph is fixed by the artifact. `--platform=hermes` and
`--babel` additionally transform each file's *content* on its way into the
bundle — the graph they follow is still exactly the recorded one.

## Externals

`--external=PATTERN` only affects specifiers the artifact does **not** record —
handed back to esbuild as misses. Re-declare capture-time externals with it so
esbuild leaves them as runtime imports; it can't un-inline an attested edge.

```sh
# the captured bundle imported a native module that was external at capture; keep it external
stasis build --output=out.cjs --format=cjs --external=better-sqlite3 app.code.br
```

In a cjs/iife build an external import becomes a `require()`, and a plain esbuild
build gives one in a `"type": "module"` file Node's default-import interop, which a
build through the plugin can't (see [package.json `type`](#packagejson-type-built-as-plain-esbuild-does-or-refused)).
Since the external's exports are only known at runtime, a default or namespace
import of one from such a file is refused there; `--format=esm` keeps it an import.

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

The [package.json `type` checks](#packagejson-type-built-as-plain-esbuild-does-or-refused)
see Babel's output: a config that compiles ES modules to CommonJS makes the files
of a `"type": "module"` package CommonJS, which a plain esbuild build would still
read as ESM, so such a build is refused.

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
| Needs on disk | Nothing — not even a `package.json` (one there only informs the [`type` check](#packagejson-type-built-as-plain-esbuild-does-or-refused)) | Each attested file, read from disk |
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
JSX in a `.js`/`.cjs`/`.mjs` file is an *"Unexpected token"* parse error, which is
fatal for an ESM file whose static import graph can't be enumerated from the
partial parse (`JS bundle would be broken at load time`). Pass `--jsx` (its
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

A resource is carried, not built: `stasis build` (esbuild) still needs a matching
`--loader` (e.g. `--loader=.png:dataurl`) to emit one, so an entry that imports an
asset without a configured loader fails at build time — the bundle/lockfile carries
the bytes for attestation and for Metro regardless.

## package.json `type`: built as plain esbuild does, or refused

esbuild gives a `.js`/`.jsx`/`.ts`/`.tsx` file the module type of its nearest
`package.json` `type` only when its own resolver loaded the file. `stasis build`
serves every file through the stasis esbuild plugin, and a plugin's resolve result
can't carry a module type (esbuild 0.27 and 0.28 alike), so esbuild parses each one as
if its package had no `type`. (`.mjs`/`.cjs`/`.mts`/`.cts` are typed by extension
and unaffected.) Where that would change the build, `stasis build` — and the esbuild
plugin, at capture and at `bundle=load` alike — **refuses it** rather than produce
output that behaves differently from a plain esbuild build of the same tree:

| Refused | A plain esbuild build | Through the plugin | Way out |
| - | - | - | - |
| A `"type": "module"` file default- or namespace-imports (or `import()`s) a CommonJS module whose exports may carry `__esModule` (the Babel/TypeScript shape `exports.__esModule = true; exports.default = …`, directly or through a `module.exports = require(…)` re-export — of an external too, or of a require esbuild can't resolve and leaves for runtime, whose exports are unknown) | Node's interop: the default import is the whole `module.exports`, as under Node | The bundler interop: `module.exports.default` | Import named exports, or rename the importer `.mjs` |
| A `"type": "module"` file default- or namespace-imports a non-builtin [external](#externals) with `--format=cjs`/`iife`, or `import()`s one where esbuild lowers `import()` (a target without it) | The `require()` it becomes gets Node's interop | The bundler interop — on exports only the runtime knows | Import named exports, rename the importer `.mjs`, or `--format=esm` |
| A `"type": "module"` file with no `export`, `import.meta` or top-level `await` uses `module`/`exports`, top-level `this` or `return`, or a direct `eval` | ESM: `module`/`exports` stay free, `this` is `undefined` | CommonJS | Make the file ESM, or `.cjs` |
| A `"type": "module"` file with no `import` or `export` at all is required or imported for its exports, or parses differently in strict mode (`with`, a block-level function) | An ES module without exports, strict | CommonJS / sloppy | Add an `export`, or `.cjs` |
| A `"type": "commonjs"` file with `import`s but no `export` or CommonJS use is required or imported for its exports | CommonJS | ESM | Make it consistently one or the other |
| A file of a typed package reads `arguments` outside any function, and the builds wrap it differently (a `"type": "commonjs"` file without CommonJS use, a `"type": "module"` file without `import`/`export`) | The wrapper by its `type`: CommonJS's, or none/ESM's | The wrapper by its syntax | Read `arguments` only inside a function |
| A `"type": "commonjs"` entry with no `export` or CommonJS use, built with `--format=esm` | Re-exports its `module.exports` as the output's default export | No default export | `--format=cjs` or `--format=iife` |

Whether a CommonJS module's exports may carry `__esModule` is decided fail-safe: any
`__esModule` key the module defines on anything counts, wherever that value ends up. That
includes a property write, an object literal or class member, a `defineProperty`, and a
string constant that could become a key. Reads, comparisons and falsy values don't count. A
key only the runtime knows, such as a computed key or a `Proxy` trap, counts where it reaches
the exports.

Everything else builds as before and behaves as a plain esbuild build does — named
imports, CommonJS modules that don't carry `__esModule`, files of packages without a
`type`. The checks parse each served file with [`oxc-parser`](https://www.npmjs.com/package/oxc-parser),
a dependency of `@exodus/stasis` and an optional peer dependency of
`@exodus/stasis-plugins`: an esbuild build using the plugin directly needs it
installed once it serves a file of a typed package.

A bundle records each file's Node format (`module`/`commonjs`), not its package's
`type`, and a typeless package's file shares those formats (Node detects them from
syntax). So at load the check reads the `package.json` a plain esbuild build would
read there, when the disk has one that agrees with the recorded format (it only
decides whether to refuse, never what is built). With none — a bundle built in a
bare directory — it takes the `type` the format implies, so it may refuse a build of
a typeless package's file that a plain build would leave alone; the message says so.
