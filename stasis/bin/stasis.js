#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { homedir, constants as osConstants } from 'node:os'
import assert from 'node:assert/strict'
import { parseBrotliQuality, parseLeadingOptions, parseResourcesOption } from '@exodus/stasis-core/util'
import pkg from '../package.json' with { type: 'json' }

const argv = [...process.argv]
assert(['node', 'node.exe'].includes(basename(argv.shift())))
assert(['node', 'node.exe'].includes(basename(process.argv0)))

const jsname = argv.shift()
const pathsEqual = (a, b) => a === b || (existsSync(a) && realpathSync(a) === b)
assert(basename(jsname) === 'stasis' || pathsEqual(jsname, fileURLToPath(import.meta.url)))

const HELP = `Usage:
 stasis run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|frozen|ignore)] [--bundle-file=path/to/bundle.br] [--resources-bundle-file=path/to/resources.br] [--dependencies] [--child-process] [--package-json] [--mock] [--import=module ...] [--fs=(sync|async)] [--resources=ext,ext] [--brotli-quality=0..11] path/to/file.js ...
 stasis bundle [--scope=(node_modules|full)] [--conditions=cond1,cond2] [--mainFields=field1,field2] [--metro [--metro-resolver] --platforms=ios,android] [--jsx] [--flow] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--package-json] [--lockfile=path/to/stasis.lock.json] [--brotli-quality=0..11] [--add] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx) ...
 stasis bundle [--mapping=path/to/remappings(.txt|.toml)] [--manifests] [--add] [--output=(path|-)] path/to/(file.sol|dir) ...
 stasis bundle [--cargo] [--cargo-features=a,b,pkg/c] [--cargo-no-default-features] [--cargo-all-features] [--cargo-target=(triple|host)] [--cargo-manifests] [--add] [--output=(path|-)] path/to/file.rs ...
 stasis bundle [--add] [--output=(path|-)] path/to/file.(php|sh|bash) ...
 stasis github-bundle --github=owner/name [--sha=commit|--tag=name] [--directory=path] [--package-manager=(pnpm|yarn1|npm|soldeer) [--package-manager-version=version]] [--generate=prisma] [--lockfile=path/to/stasis.lock.json] [--output=(path|-)] [stasis bundle's options for the entries] [path/in/repo/to/(file.(js|ts|jsx|tsx)|file.sol|dir) ...]
 stasis add path/to/(file|dir) ...
 stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral|hermes)] [--babel] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] path/to/(stasis.code.br|stasis.lock.json) [entry]
 stasis extract [--output=path/to/dir] path/to/bundle.stasis.code.br
 stasis diff --stat [--imports] path/to/(lockfile|bundle) path/to/(lockfile|bundle)
 stasis prune [path/to/project]
 stasis audit [--why|--why-deep] [--why-full] [--reason=consumer] [--repo-advisories] path/to/(lockfile|bundle) ...
 stasis sbom --format=(spdx|cyclonedx) [--output=(path|-)] path/to/(lockfile|bundle) ...
 stasis --version

Each command's options: https://github.com/PreventiveMeasures/stasis/blob/main/doc/<command>.md
(run, bundle, github-bundle, build, extract, diff, prune, audit, sbom; add is in bundle.md)`

// The help, on stderr. Exits 0 when asked for (--help), 1 when printed for want of a command.
function usage(asked = false) {
  console.error(HELP)
  process.exit(asked ? 0 : 1)
}

// A usage error: the message and where the help is, never the help itself.
function fail(message) {
  console.error(`${message}\nRun 'stasis --help' for usage.`)
  process.exit(1)
}

function setEnv(name, value) {
  const env = process.env[name]
  if (env && env !== value) throw new Error(`env conflict: ${name}="${env}", effective: "${value}"`)
  process.env[name] = value === undefined ? '' : value
}

// The per-user cache directory, as each platform names it (XDG ignores a relative path).
function userCacheDir() {
  if (isAbsolute(process.env.XDG_CACHE_HOME ?? '')) return join(process.env.XDG_CACHE_HOME, 'stasis')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'stasis')
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'stasis', 'Cache')
  return join(homedir(), '.cache', 'stasis')
}

const command = argv.shift()

if (command === '-v' || command === '--version') {
  console.log(`v${pkg.version}`)
  process.exit(0)
} else if (command === '-h' || command === '--help') {
  usage(true)
} else if (command === 'run') {
  const options = {
    lock: { type: 'string', default: 'none' },
    bundle: { type: 'string', default: 'none' },
    'bundle-file': { type: 'string' },
    'resources-bundle-file': { type: 'string' },
    debug: { type: 'boolean' },
    dependencies: { type: 'boolean' },
    'child-process': { type: 'boolean' },
    'package-json': { type: 'boolean' },
    mock: { type: 'boolean' },
    import: { type: 'string', multiple: true },
    fs: { type: 'string' },
    resources: { type: 'string' },
    'brotli-quality': { type: 'string' },
  }
  const values = parseLeadingOptions(argv, options, {
    valueFlags: ['--bundle', '--bundle-file', '--resources-bundle-file', '--lock', '--import', '--resources', '--brotli-quality'],
    onError: fail,
  })
  if (argv.length === 0) fail('Nothing to run: no path to file given')
  if (!['none', 'ignore', 'add', 'replace', 'frozen'].includes(values.lock)) fail('Error: invalid --lock value')
  const lock = values.lock
  const scope = values.dependencies ? 'node_modules' : 'full'
  const bundle = values.bundle
  const bundleFile = values['bundle-file'] ? resolve(values['bundle-file']) : ''
  const resourcesBundleFile = values['resources-bundle-file'] ? resolve(values['resources-bundle-file']) : ''
  const debug = values.debug ? '1' : ''
  if (!['none', 'ignore', 'add', 'replace', 'load', 'frozen'].includes(bundle)) fail('Error: invalid --bundle value')
  if (bundleFile && bundle === 'none') fail('Error: --bundle-file requires --bundle=(add|replace|load|frozen|ignore)')
  // --resources-bundle-file needs an active bundle mode (unlike --bundle-file, inert under ignore).
  if (resourcesBundleFile && (bundle === 'none' || bundle === 'ignore')) fail('Error: --resources-bundle-file requires --bundle=(add|replace|load|frozen)')
  if (bundle === 'load' && lock !== 'frozen' && lock !== 'none' && lock !== 'ignore') fail('Error: --bundle=load is incompatible with --lock=(add|replace)')
  if (lock === 'none' && bundle === 'none') fail('Error: stasis needs a lockfile or a bundle: set --lock or --bundle')
  if (values.mock && bundle === 'load') fail('Error: --mock is for capturing imports while building a bundle; not compatible with --bundle=load')
  // --fs requires a bundle mode (add|replace|load); `sync` patches the sync fs readers,
  // `async` adds their callback + fs.promises counterparts on top.
  if (values.fs !== undefined && !['sync', 'async'].includes(values.fs)) fail("Error: --fs must be 'sync' or 'async'")
  if (values.fs !== undefined && !['add', 'replace', 'load'].includes(bundle)) fail('Error: --fs requires --bundle=(add|replace|load)')
  const captureFs = values.fs ?? ''
  // --resources: comma-separated extension/filename allowlist for `--fs` captures.
  const resources = values.resources ?? ''
  let brotliQuality
  if (values['brotli-quality'] !== undefined) {
    try {
      brotliQuality = parseBrotliQuality('--brotli-quality', values['brotli-quality'])
    } catch (cause) {
      fail(`Error: ${cause.message}`)
    }
  }
  // --import: extra preload module(s) passed through to the spawned node. Node resolves each
  // against the project cwd; they ride AFTER stasis's own loader import.
  const imports = values.import ?? []
  if (imports.some((s) => s === '')) fail('Error: --import requires a module specifier (e.g. --import=./instrument.mjs)')
  // Not a usage error: plain instrumentation/setup preloads still work under the mock; only ones
  // that need the denied surfaces (spawning helper processes, network) die, and they do so loudly.
  if (values.mock && imports.length > 0) {
    console.warn("[stasis] Warning: --import preloads run under --mock's side-effect denials; a preload that spawns helper processes will fail there")
  }
  // --child-process: forward forked-child (e.g. Metro worker) capture to the root via per-pid shards.
  const childProcess = values['child-process'] ? '1' : ''
  // --package-json: auto-include every bundled module's package.json. Only meaningful while WRITING
  // a bundle (add|replace) -- there's nothing to fold the manifests into otherwise.
  if (values['package-json'] && bundle !== 'add' && bundle !== 'replace') {
    fail('Error: --package-json requires --bundle=(add|replace)')
  }
  const packageJSON = values['package-json'] ? '1' : ''
  console.warn('[stasis] Running stasis with config:', { lock, scope, bundle, ...(bundleFile && { bundleFile }), ...(resourcesBundleFile && { resourcesBundleFile }), ...(childProcess && { childProcess: true }), ...(packageJSON && { packageJSON: true }), ...(values.mock && { mock: true }), ...(imports.length > 0 && { import: imports }), ...(values.fs && { fs: values.fs }), ...(resources && { resources }), ...(brotliQuality !== undefined && { brotliQuality }) })
  if (debug) console.warn(`[stasis] Warning: stasis debug mode active`)
  setEnv('EXODUS_STASIS_LOCK', lock)
  setEnv('EXODUS_STASIS_SCOPE', scope)
  setEnv('EXODUS_STASIS_BUNDLE', bundle)
  setEnv('EXODUS_STASIS_BUNDLE_FILE', bundleFile)
  setEnv('EXODUS_STASIS_RESOURCES_BUNDLE_FILE', resourcesBundleFile)
  setEnv('EXODUS_STASIS_DEBUG', debug)
  setEnv('EXODUS_STASIS_CHILD_PROCESS', childProcess)
  setEnv('EXODUS_STASIS_PACKAGE_JSON', packageJSON)
  setEnv('EXODUS_STASIS_FS', captureFs)
  setEnv('EXODUS_STASIS_RESOURCES', resources)
  // Only set when given; an unconditional setEnv('') would conflict with an ambient value.
  if (brotliQuality !== undefined) setEnv('EXODUS_STASIS_BROTLI_QUALITY', String(brotliQuality))
  // --mock: capture imports by running user code with side-effects denied (fail-closed).
  // --permission blocks fs writes/child procs/workers/addons/inspector at the kernel level;
  // src/mock.js neutralizes network + timers in JS (no --allow-* for those). Reads stay open
  // so node_modules resolution works.
  // Node 24 dropped comma-separated --allow-fs-write; repeat the flag instead.
  const nodeArgs = []
  if (values.mock) {
    const writeAllow = [process.cwd()]
    // --allow-fs-write paths must already exist on disk, so for each out-of-cwd bundle target
    // walk up to the nearest existing ancestor and grant write there.
    for (const [flag, file] of [['--bundle-file', bundleFile], ['--resources-bundle-file', resourcesBundleFile]]) {
      if (!file || file.startsWith(`${process.cwd()}/`)) continue
      let p = dirname(file)
      while (!existsSync(p) && dirname(p) !== p) p = dirname(p)
      // Refuse write access to the filesystem root -- it would disable the --permission layer everywhere.
      if (p === dirname(p)) {
        fail(`Error: no existing parent directory for ${flag}=${file}; create one first or choose a path under an existing directory`)
      }
      if (!writeAllow.includes(p)) writeAllow.push(p)
    }
    nodeArgs.push('--permission', '--allow-fs-read=*')
    for (const p of writeAllow) nodeArgs.push(`--allow-fs-write=${p}`)
    // Restore the node-addons resolution condition (dropped by --permission) so the captured
    // import map matches a non-mock run; native addons still can't load (--allow-addons off).
    nodeArgs.push('--conditions=node-addons')
  }
  // --mock uses stasis's loader-mock entry (composes the mock before installing the hooks).
  const loaderEntry = values.mock ? '../src/loader-mock.js' : '@exodus/stasis-core/loader'
  nodeArgs.push('--import', import.meta.resolve(loaderEntry))
  // Passthrough preloads ride after the loader (and after --mock's denials), so they evaluate
  // under its hooks; their module graphs pass through uncaptured unless the app graph reaches
  // them -- then they're promoted into the capture (see core hooks.js).
  for (const specifier of imports) nodeArgs.push('--import', specifier)
  const child = spawn(process.execPath, [...nodeArgs, ...argv], { stdio: 'inherit' })
  const [code, signal] = await once(child, 'close')
  // code is null when the child died from a signal; report 128+signo (shell convention) instead of the implicit 0
  process.exitCode = code ?? 128 + (osConstants.signals[signal] ?? 0)
} else if (command === 'bundle') {
  const options = {
    mapping: { type: 'string' },
    manifests: { type: 'boolean' },
    output: { type: 'string', short: 'o' },
    scope: { type: 'string' },
    lockfile: { type: 'string' },
    conditions: { type: 'string' },
    mainFields: { type: 'string' },
    metro: { type: 'boolean' },
    'metro-resolver': { type: 'boolean' },
    platforms: { type: 'string', multiple: true },
    jsx: { type: 'boolean' },
    flow: { type: 'boolean' },
    typescript: { type: 'boolean' },
    tsconfig: { type: 'string' },
    resources: { type: 'string' },
    'package-json': { type: 'boolean' },
    cargo: { type: 'boolean' },
    'cargo-features': { type: 'string', multiple: true },
    'cargo-no-default-features': { type: 'boolean' },
    'cargo-all-features': { type: 'boolean' },
    'cargo-target': { type: 'string' },
    'cargo-manifests': { type: 'boolean' },
    'brotli-quality': { type: 'string' },
    add: { type: 'boolean' },
  }
  const values = parseLeadingOptions(argv, options, {
    valueFlags: ['--mapping', '--output', '--scope', '--lockfile', '--conditions', '--mainFields', '--platforms', '--resources', '--tsconfig', '--cargo-features', '--cargo-target', '--brotli-quality', '-o'],
    onError: fail,
  })
  if (argv.length === 0) fail('Nothing to bundle: no entry file given')
  // A directory entry stands for the .sol files under it (Solidity only); an extensionless path
  // that doesn't exist is a missing one (skipped with a warning).
  const { directoryEntryError, isSolidityEntry } = await import('../src/cmd/bundle.js')
  const dirError = directoryEntryError(argv)
  if (dirError !== null) fail(`Error: ${dirError}`)
  const allSol = argv.every((f) => isSolidityEntry(f))
  const allPhp = argv.every((f) => f.endsWith('.php'))
  const allJs = argv.every((f) => /\.(?:js|cjs|mjs|ts|cts|mts|jsx|tsx)$/u.test(f))
  const allBash = argv.every((f) => /\.(?:sh|bash)$/u.test(f))
  const allRust = argv.every((f) => f.endsWith('.rs'))
  if (!allSol && !allPhp && !allJs && !allBash && !allRust) {
    fail('Error: bundle entries must all be .sol, all be .php, all be .js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx, all be .sh/.bash, or all be .rs')
  }
  if (values.mapping && !allSol) fail('Error: --mapping is only valid for .sol bundles')
  // --manifests: carry the Solidity build's description files (foundry.toml, remappings.txt, ...).
  const manifests = Boolean(values.manifests)
  if (manifests && !allSol) fail('Error: --manifests is only valid for .sol bundles')
  // --cargo: take the Rust feature/dependency resolution from `cargo metadata` (runs cargo; opt-in).
  const cargo = Boolean(values.cargo)
  if (cargo && !allRust) fail('Error: --cargo is only valid for Rust bundles')
  // --cargo-features / --cargo-no-default-features / --cargo-all-features: cargo's own feature flags
  // for the entries' packages (`pkg/feat` targets one, or a dependency). --cargo-features is
  // repeatable and/or comma-separated; parseFeatureList is the one splitter (the resolver reuses it).
  const { parseFeatureList } = await import('../src/loaders/cargo.js')
  const cargoFeatures = parseFeatureList(values['cargo-features'] ?? [])
  if (values['cargo-features'] !== undefined && cargoFeatures.length === 0) {
    fail('Error: --cargo-features must list at least one feature (e.g. --cargo-features=serde,app/tls)')
  }
  const cargoNoDefaultFeatures = Boolean(values['cargo-no-default-features'])
  const cargoAllFeatures = Boolean(values['cargo-all-features'])
  // --cargo-target=<triple|host>: the build's target, whose cfgs (from `rustc --print cfg`) decide
  // `#[cfg(unix)]`-style code. A triple is letters, digits, `-`, `_` and `.` (`x86_64-unknown-linux-gnu`).
  const cargoTarget = values['cargo-target'] ?? null
  if (cargoTarget !== null && !/^[\w.-]+$/u.test(cargoTarget)) {
    fail('Error: --cargo-target must be a target triple or "host" (e.g. --cargo-target=aarch64-apple-darwin)')
  }
  // --cargo-manifests: carry each bundled package's Cargo.toml and build script, the workspace
  // Cargo.toml, Cargo.lock and .cargo/config.toml too (the Rust counterpart of --package-json).
  const cargoManifests = Boolean(values['cargo-manifests'])
  if (!allRust) {
    const given = { 'cargo-features': cargoFeatures.length > 0, 'cargo-no-default-features': cargoNoDefaultFeatures, 'cargo-all-features': cargoAllFeatures, 'cargo-target': cargoTarget !== null, 'cargo-manifests': cargoManifests }
    for (const [flag, on] of Object.entries(given)) if (on) fail(`Error: --${flag} is only valid for Rust bundles`)
  }
  if (values.scope && !allJs) fail('Error: --scope is only valid for JS bundles')
  if (values.scope && !['node_modules', 'full'].includes(values.scope)) {
    fail('Error: --scope must be node_modules or full')
  }
  if (values.lockfile && !allJs) fail('Error: --lockfile is only valid for JS bundles')
  // --mainFields/--metro always emit a full-scope bundle, so they'd silently ignore --scope.
  if (values.scope !== undefined && (values.mainFields !== undefined || values.metro)) {
    fail('Error: --scope is not supported with --mainFields or --metro')
  }
  // --conditions: extra exports/imports resolution conditions merged onto Node's defaults;
  // they don't honour legacy `mainFields` or platform suffixes (see --mainFields).
  if (values.conditions !== undefined && !allJs) fail('Error: --conditions is only valid for JS bundles')
  const conditions = values.conditions === undefined
    ? []
    : values.conditions.split(',').map((s) => s.trim()).filter(Boolean)
  if (values.conditions !== undefined && conditions.length === 0) {
    fail('Error: --conditions must list at least one condition name (e.g. --conditions=react-native,browser)')
  }
  // --flow: strip Flow type syntax (via the optional flow-remove-types dep) before parsing; JS-only.
  if (values.flow && !allJs) fail('Error: --flow is only valid for JS bundles')
  const flow = Boolean(values.flow)
  // --typescript: resolve like tsc -- a specifier naming a missing JS output (./x.js, .mjs, .cjs,
  // extensionless) lands on its on-disk TS source (./x.ts, .mts, .cts); an existing .js always wins.
  if (values.typescript && !allJs) fail('Error: --typescript is only valid for JS bundles')
  const typescript = Boolean(values.typescript)
  // --tsconfig: the config whose compilerOptions.paths aliases --typescript honours (default: the
  // tsconfig.json beside each importing file's package.json). Meaningless without --typescript.
  if (values.tsconfig !== undefined && !typescript) fail('Error: --tsconfig is only valid with --typescript')
  // --mainFields: legacy package entry fields (e.g. react-native,browser,main) for the non-exports resolver.
  if (values.mainFields !== undefined && !allJs) fail('Error: --mainFields is only valid for JS bundles')
  const mainFields = values.mainFields === undefined
    ? undefined
    : values.mainFields.split(',').map((s) => s.trim()).filter(Boolean)
  if (values.mainFields !== undefined && mainFields.length === 0) {
    fail('Error: --mainFields must list at least one field (e.g. --mainFields=react-native,browser,main)')
  }
  // --metro: resolve like Metro/RN (its own conditions + mainFields, platform suffixes per
  // --platforms target). --platforms is repeatable and/or comma-separated; the values union.
  const metro = Boolean(values.metro)
  // --metro-resolver: resolve through the project's own metro-resolver instead of the built-in
  // approximation. Only meaningful alongside --metro (enforced below and in classifyEntries).
  const metroResolver = Boolean(values['metro-resolver'])
  const platforms = [...new Set((values.platforms ?? []).flatMap((p) => p.split(',')).map((s) => s.trim()).filter(Boolean))]
  // A platform name becomes an edge key: reject '/' (parsers reject it) and '*' (reserved placeholder).
  for (const p of platforms) {
    if (p === '*' || p.includes('/')) fail(`Error: invalid --platforms value '${p}' (a platform name can't contain '/' or be '*')`)
  }
  if ((metro || platforms.length > 0) && !allJs) fail('Error: --metro is only valid for JS bundles')
  // --jsx: parse React Native's JSX-in-.js source in the static scanner (off by default; oxc,
  // like tsc, auto-enables JSX for .jsx/.tsx only). Orthogonal to the resolver, so it pairs with
  // plain/--mainFields/--metro alike -- JS-only, since no other entry language is scanned.
  const jsx = Boolean(values.jsx)
  if (jsx && !allJs) fail('Error: --jsx is only valid for JS bundles')
  // --package-json: fold each bundled module's package.json into the bundle. JS-only (only JS
  // modules carry an npm package.json; the sol/php/bash/rust bucketizers have no such manifest).
  const packageJSON = Boolean(values['package-json'])
  if (packageJSON && !allJs) fail('Error: --package-json is only valid for JS bundles')
  // --resources: comma-separated extension/filename allowlist for assets reached through the graph
  // (e.g. --resources=png,svg). They're carried as resources instead of failing "can't carry" --
  // for graphs that aren't fully loadable in JS (Metro consumes such assets). JS-only.
  if (values.resources !== undefined && !allJs) fail('Error: --resources is only valid for JS bundles')
  const resources = values.resources === undefined
    ? []
    : values.resources.split(',').map((s) => s.trim()).filter(Boolean)
  if (values.resources !== undefined && resources.length === 0) {
    fail('Error: --resources must list at least one extension or filename (e.g. --resources=png,svg)')
  }
  try {
    parseResourcesOption('--resources', resources) // validate early for a clean usage error (code exts / bad chars rejected)
  } catch (cause) {
    fail(`Error: ${cause.message}`)
  }
  if (metro) {
    if (conditions.length > 0) fail("Error: --conditions can't be combined with --metro (it sets its own conditions)")
    if (mainFields !== undefined) fail("Error: --mainFields can't be combined with --metro (it sets its own mainFields)")
    if (platforms.length === 0) fail('Error: --metro requires --platforms (e.g. --platforms=ios,android)')
  } else if (platforms.length > 0) {
    fail('Error: --platforms is only valid with --metro')
  }
  if (metroResolver && !metro) fail('Error: --metro-resolver is only valid with --metro')
  // metro-resolver can't substitute .js -> .ts, so --typescript would silently not apply -- reject it.
  if (typescript && metroResolver) fail("Error: --typescript is not supported with --metro-resolver (the project's metro-resolver doesn't substitute .js -> .ts)")
  // --brotli-quality: valid for every entry language (no allJs gate).
  let brotliQuality
  if (values['brotli-quality'] !== undefined) {
    try {
      brotliQuality = parseBrotliQuality('--brotli-quality', values['brotli-quality'])
    } catch (cause) {
      fail(`Error: ${cause.message}`)
    }
  }
  // --add merges into the existing bundle at --output, so it can't target write-only stdout.
  const add = Boolean(values.add)
  if (add && values.output === '-') fail('Error: --add cannot be combined with --output=-')
  const { bundleCommand } = await import('../src/cmd/bundle.js')
  await bundleCommand({
    cwd: process.cwd(),
    entries: argv,
    mappingFile: values.mapping,
    manifests,
    output: values.output,
    scope: values.scope,
    lockfile: values.lockfile,
    conditions,
    mainFields,
    metro,
    metroResolver,
    platforms,
    jsx,
    flow,
    typescript,
    tsconfig: values.tsconfig,
    resources,
    packageJSON,
    cargo,
    cargoFeatures,
    cargoNoDefaultFeatures,
    cargoAllFeatures,
    cargoTarget,
    cargoManifests,
    brotliQuality,
    add,
  })
} else if (command === 'github-bundle') {
  const values = parseLeadingOptions(argv, {
    github: { type: 'string' },
    sha: { type: 'string' },
    tag: { type: 'string' },
    directory: { type: 'string' },
    'package-manager': { type: 'string' },
    'package-manager-version': { type: 'string' },
    mapping: { type: 'string' },
    manifests: { type: 'boolean' },
    output: { type: 'string', short: 'o' },
    scope: { type: 'string' },
    lockfile: { type: 'string' },
    conditions: { type: 'string' },
    mainFields: { type: 'string' },
    metro: { type: 'boolean' },
    platforms: { type: 'string', multiple: true },
    jsx: { type: 'boolean' },
    flow: { type: 'boolean' },
    typescript: { type: 'boolean' },
    tsconfig: { type: 'string' },
    resources: { type: 'string' },
    'package-json': { type: 'boolean' },
    'brotli-quality': { type: 'string' },
    generate: { type: 'string', multiple: true },
  }, {
    valueFlags: ['--github', '--sha', '--tag', '--directory', '--package-manager', '--package-manager-version', '--mapping', '--output', '--scope', '--lockfile', '--conditions', '--mainFields', '--platforms', '--tsconfig', '--resources', '--brotli-quality', '--generate', '-o'],
    onError: fail,
  })
  if (values.github === undefined) fail('Error: github-bundle requires --github=owner/name, the repo to bundle')
  if (values.sha !== undefined && values.tag !== undefined) fail('Error: github-bundle takes --sha or --tag, not both')
  // Whether each option applies to the entries is buildGitHubBundle's to say.
  const list = (value) => [value ?? []].flat().flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean)
  let brotliQuality
  if (values['brotli-quality'] !== undefined) {
    try {
      brotliQuality = parseBrotliQuality('--brotli-quality', values['brotli-quality'])
    } catch (cause) {
      fail(`Error: ${cause.message}`)
    }
  }
  // Tarballs, zips and GitHub trees are cached where `stasis audit` caches.
  const { setCacheDir } = await import('../src/vfs-bundle.js')
  setCacheDir(userCacheDir())
  const { githubBundleCommand } = await import('../src/cmd/github-bundle.js')
  await githubBundleCommand({
    github: values.github,
    sha: values.sha,
    tag: values.tag,
    directory: values.directory,
    packageManager: values['package-manager'],
    packageManagerVersion: values['package-manager-version'],
    entries: argv.length === 0 ? undefined : argv,
    mappingFile: values.mapping,
    manifests: Boolean(values.manifests),
    output: values.output,
    lockfile: values.lockfile,
    scope: values.scope,
    conditions: list(values.conditions),
    mainFields: values.mainFields === undefined ? undefined : list(values.mainFields),
    metro: Boolean(values.metro),
    platforms: list(values.platforms),
    jsx: Boolean(values.jsx),
    flow: Boolean(values.flow),
    typescript: Boolean(values.typescript),
    tsconfig: values.tsconfig,
    resources: list(values.resources),
    packageJSON: Boolean(values['package-json']),
    generate: list(values.generate),
    brotliQuality,
  })
} else if (command === 'add') {
  // add packs the listed files (no resolver), taking split targets + resource allowlist from
  // stasis.config.json; it takes no flags.
  if (argv.length === 0) fail('Nothing to add: no file given')
  if (argv.some((a) => a.startsWith('-'))) fail('Error: add takes no options; its targets and resource allowlist come from stasis.config.json')
  const { addCommand } = await import('@exodus/stasis-core/add')
  // Let addCommand's runtime errors propagate as-is; wrapping in fail() would bury the cause.
  addCommand({ cwd: process.cwd(), entries: argv, logLabel: 'stasis' })
} else if (command === 'build') {
  const options = {
    output: { type: 'string', short: 'o' },
    format: { type: 'string' },
    platform: { type: 'string' },
    babel: { type: 'boolean' },
    minify: { type: 'boolean' },
    sourcemap: { type: 'boolean' },
    // Repeatable esbuild passthroughs (--define=K=V, --external=PATTERN, --loader=.ext:name).
    define: { type: 'string', multiple: true },
    external: { type: 'string', multiple: true },
    loader: { type: 'string', multiple: true },
  }
  const values = parseLeadingOptions(argv, options, {
    valueFlags: ['--output', '-o', '--format', '--platform', '--define', '--external', '--loader'],
    onError: fail,
  })
  if (argv.length === 0) fail('Nothing to build: no bundle or lockfile given')
  if (argv.length > 2) fail('Error: build takes a bundle or lockfile and an optional entry point')
  // esbuild output knobs; the import graph itself is fixed by the artifact, not these.
  if (values.format !== undefined && !['esm', 'cjs', 'iife'].includes(values.format)) {
    fail('Error: --format must be esm, cjs, or iife')
  }
  if (values.platform !== undefined && !['node', 'browser', 'neutral', 'hermes'].includes(values.platform)) {
    fail('Error: --platform must be node, browser, neutral, or hermes')
  }
  // Hermes has no import/export; --format defaults to iife under --platform=hermes (see buildCommand).
  if (values.platform === 'hermes' && values.format === 'esm') {
    fail('Error: --platform=hermes cannot emit ESM; use --format=iife (the hermes default) or cjs')
  }
  if (!values.output) fail('Error: --output is required (a .js/.cjs/.mjs file, or a directory)')
  // build can't stream to stdout; without this, --output=- would create a dir literally named `-`.
  if (values.output === '-') fail('Error: stasis build cannot stream to stdout; --output must be a .js/.cjs/.mjs file or a directory')
  // --define=KEY=VALUE -> esbuild define map; VALUE is forwarded verbatim and must be valid JS
  // (a JSON literal or an identifier), e.g. --define=DEBUG=false.
  const define = {}
  for (const entry of values.define ?? []) {
    const eq = entry.indexOf('=')
    if (eq <= 0) fail(`Error: --define must be KEY=VALUE (got '${entry}')`)
    define[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  // --loader=.ext:NAME -> esbuild loader override for that extension (e.g. --loader=.js:jsx).
  const loader = {}
  for (const entry of values.loader ?? []) {
    const colon = entry.indexOf(':')
    if (colon <= 0 || !entry.startsWith('.')) fail(`Error: --loader must be .EXT:LOADER (got '${entry}')`)
    loader[entry.slice(0, colon)] = entry.slice(colon + 1)
  }
  const { buildCommand } = await import('../src/cmd/build.js')
  await buildCommand({
    cwd: process.cwd(),
    artifact: argv[0],
    entry: argv[1],
    output: values.output,
    format: values.format,
    platform: values.platform,
    babel: Boolean(values.babel),
    minify: values.minify,
    sourcemap: values.sourcemap,
    define,
    external: values.external ?? [],
    loader,
  })
} else if (command === 'extract') {
  const options = {
    output: { type: 'string', short: 'o' },
  }
  const values = parseLeadingOptions(argv, options, { valueFlags: ['--output', '-o'], onError: fail })
  if (argv.length === 0) fail('Nothing to extract: no bundle file given')
  if (argv.length > 1) fail('Error: extract takes exactly one bundle file')
  const { extractCommand } = await import('@exodus/stasis-core/extract')
  extractCommand({ cwd: process.cwd(), bundleFile: argv[0], output: values.output, logLabel: 'stasis' })
} else if (command === 'diff') {
  const options = {
    stat: { type: 'boolean' },
    imports: { type: 'boolean' },
  }
  const values = parseLeadingOptions(argv, options, { onError: fail })
  // --stat is required for now (it reports what changed, not the content); bare `stasis diff`
  // is reserved for a future content-level diff.
  if (!values.stat) fail('Error: stasis diff currently requires --stat')
  if (argv.length !== 2) fail('Error: stasis diff takes exactly two files (lockfile or bundle)')
  // --imports also diffs the resolution graphs (added/removed/redirected edges); off by default (verbose).
  const { diffCommand } = await import('../src/cmd/diff.js')
  const { differences } = diffCommand({ cwd: process.cwd(), left: argv[0], right: argv[1], stat: true, imports: values.imports })
  // Exit non-zero when the artifacts differ, so it composes in CI.
  process.exitCode = differences ? 1 : 0
} else if (command === 'prune') {
  if (argv.length > 1) fail('Error: prune takes at most one path argument')
  const root = argv[0] ? resolve(argv[0]) : process.cwd()
  const { prune } = await import('@exodus/stasis-core/prune')
  const { removed, validated } = prune({ root })
  console.warn(`[stasis] prune: validated ${validated.length} file(s), removed ${removed.length} file(s)`)
} else if (command === 'audit') {
  const values = parseLeadingOptions(argv, { why: { type: 'boolean' }, 'why-deep': { type: 'boolean' }, 'why-full': { type: 'boolean' }, reason: { type: 'string' }, 'repo-advisories': { type: 'boolean' } }, { valueFlags: ['--reason'], onError: fail })
  if (argv.length === 0) fail('Nothing to audit: no path to file given')
  const repoAdvisories = Boolean(values['repo-advisories'])
  if (repoAdvisories && !process.env.GITHUB_TOKEN) fail('Error: --repo-advisories requires a GitHub token in GITHUB_TOKEN')
  // A Soldeer package's and a GitHub repo's advisories are their repository's, asked of GitHub with
  // GITHUB_TOKEN where it is set; the client asks nothing for any other package by itself.
  const github = (await import('@preventive/upstream/github.js')).createClient({ token: process.env.GITHUB_TOKEN || null })
  // Upstream caches what it looks up (a package's GitHub repo, a month each) only where told to, and
  // answers from it without asking: a per-user directory, never one shared with less trusted jobs.
  const { setCacheDir } = await import('@preventive/upstream/npm.js')
  setCacheDir(userCacheDir())
  const { audit, printAuditReport } = await import('../src/audit.js')
  const files = argv.map((f) => resolve(f))
  const report = await audit(files, { why: Boolean(values.why), whyDeep: Boolean(values['why-deep']), whyFull: Boolean(values['why-full']), reason: values.reason, repoAdvisories, github })
  printAuditReport(report)
  process.exitCode = report.rows.length === 0 ? 0 : 1
} else if (command === 'sbom') {
  const options = {
    format: { type: 'string' },
    output: { type: 'string', short: 'o' },
  }
  const values = parseLeadingOptions(argv, options, { valueFlags: ['--format', '--output', '-o'], onError: fail })
  if (!values.format) fail('Error: stasis sbom requires --format=(spdx|cyclonedx)')
  if (!['spdx', 'cyclonedx'].includes(values.format)) fail('Error: --format must be spdx or cyclonedx')
  if (argv.length === 0) fail('Nothing to export: no lockfile or bundle given')
  const { sbomCommand } = await import('../src/cmd/sbom.js')
  sbomCommand({
    cwd: process.cwd(),
    files: argv,
    format: values.format,
    output: values.output,
  })
} else if (command === undefined) {
  usage()
} else {
  fail(`Error: unknown command '${command}'`)
}
