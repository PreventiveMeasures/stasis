#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import assert from 'node:assert/strict'
import { parseLeadingOptions, valueFlagsOf } from '@exodus/stasis-core/util'
import { addCli, brotliQualityOption, extractCli, parseRunOptions, pruneCli, runProgram, setEnv, setRunEnv } from '@exodus/stasis-core/cli'
import pkg from '../package.json' with { type: 'json' }

const argv = [...process.argv]
assert(['node', 'node.exe'].includes(basename(argv.shift())))
assert(['node', 'node.exe'].includes(basename(process.argv0)))

const jsname = argv.shift()
const pathsEqual = (a, b) => a === b || (existsSync(a) && realpathSync(a) === b)
assert(basename(jsname) === 'stasis' || pathsEqual(jsname, fileURLToPath(import.meta.url)))

const HELP = `Usage:
 stasis run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|frozen|ignore)] [--bundle-file=path/to/bundle.br] [--resources-bundle-file=path/to/resources.br] [--dependencies] [--child-process] [--package-json] [--mock] [--import=module ...] [--fs=(sync|async)] [--resources=ext,ext] [--brotli-quality=0..11] path/to/file.js ...
 stasis bundle [--scope=(node_modules|full)] [--conditions=cond1,cond2] [--mainFields=field1,field2] [--metro [--metro-resolver] [--babel|--babel-aliases=path/to/aliases.json] --platforms=ios,android] [--jsx] [--flow] [--typescript [--tsconfig=path/to/tsconfig.json]] [--resources=ext,ext] [--define=K=V ...] [--package-json] [--lockfile=path/to/stasis.lock.json] [--brotli-quality=0..11] [--add] [--output=(path|-)] path/to/file.(js|ts|jsx|tsx) ...
 stasis bundle [--mapping=path/to/remappings(.txt|.toml)] [--manifests] [--add] [--output=(path|-)] path/to/(file.sol|dir) ...
 stasis bundle [--cargo] [--cargo-features=a,b,pkg/c] [--cargo-no-default-features] [--cargo-all-features] [--cargo-target=(triple|host)] [--cargo-manifests] [--add] [--output=(path|-)] path/to/file.rs ...
 stasis bundle [--add] [--output=(path|-)] path/to/file.(php|sh|bash) ...
 stasis bundle [--babel] [--metro-resolver] [--cargo] [--cargo-target=(triple|host)] [--lockfile=path/to/stasis.lock.json] [--brotli-quality=0..11] [--add] [--output=(path|-)] [entry ...]  (the entries' options from stasis.config.json's entries)
 stasis github-bundle (owner/name[/path]|--github=owner/name [--directory=path]) [--sha=commit|--tag=name] [--package-manager=(pnpm|yarn1|npm|soldeer) [--package-manager-version=version]] [--lazy] [--generate=prisma] [--lockfile=path/to/stasis.lock.json] [--output=(path|-)] [stasis bundle's options for the entries] [path/in/repo/to/(file.(js|ts|jsx|tsx)|file.sol|dir) ...]
 stasis add path/to/(file|dir) ...
 stasis build --output=(dir|file.js) [--format=(esm|cjs|iife)] [--platform=(node|browser|neutral|hermes)] [--babel] [--minify] [--sourcemap] [--define=K=V ...] [--external=pkg ...] [--loader=.ext:name ...] path/to/(stasis.code.br|stasis.lock.json) [entry]
 stasis extract [--output=path/to/dir] [--lock=(frozen|add|replace|ignore|none)] path/to/bundle.stasis.code.br
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
  const run = parseRunOptions(argv, { options: { 'package-json': { type: 'boolean' }, mock: { type: 'boolean' } }, fail })
  const { values, bundle, bundleFile, resourcesBundleFile } = run
  if (values.mock && bundle === 'load') fail('Error: --mock is for capturing imports while building a bundle; not compatible with --bundle=load')
  // Not a usage error: plain instrumentation/setup preloads still work under the mock; only ones
  // that need the denied surfaces (spawning helper processes, network) die, and they do so loudly.
  if (values.mock && run.imports.length > 0) {
    console.warn("[stasis] Warning: --import preloads run under --mock's side-effect denials; a preload that spawns helper processes will fail there")
  }
  // --package-json: auto-include every bundled module's package.json. Only meaningful while WRITING
  // a bundle (add|replace) -- there's nothing to fold the manifests into otherwise.
  if (values['package-json'] && bundle !== 'add' && bundle !== 'replace') {
    fail('Error: --package-json requires --bundle=(add|replace)')
  }
  const packageJSON = values['package-json'] ? '1' : ''
  setRunEnv('stasis', run, { ...(packageJSON && { packageJSON: true }), ...(values.mock && { mock: true }) })
  setEnv('EXODUS_STASIS_PACKAGE_JSON', packageJSON)
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
  // --mock uses stasis's loader-mock entry (composes the mock before installing the hooks), whose
  // denials the --import preloads then run under.
  const loader = import.meta.resolve(values.mock ? '../src/loader-mock.js' : '@exodus/stasis-core/loader')
  await runProgram(argv, { nodeArgs, loader, imports: run.imports })
} else if (command === 'bundle') {
  const { BUNDLE_FLAGS, bundlePlan, readConfigEntries } = await import('../src/cmd/bundle-options.js')
  const values = parseLeadingOptions(argv, BUNDLE_FLAGS, { valueFlags: valueFlagsOf(BUNDLE_FLAGS), onError: fail })
  const cwd = process.cwd()
  let plan
  try {
    // stasis.config.json's `bundle`, where it is an object: its entries' options, and with no entry
    // given, the entries.
    const config = readConfigEntries(cwd)
    const entries = argv.length > 0 ? argv : [...(config?.values() ?? [])].map(({ entry }) => entry)
    if (entries.length === 0) fail('Nothing to bundle: no entry file given')
    plan = bundlePlan({ cwd, entries, values, config })
  } catch (cause) {
    fail(`Error: ${cause.message}`)
  }
  const { bundleCommand } = await import('../src/cmd/bundle.js')
  await bundleCommand({ cwd, ...plan })
} else if (command === 'github-bundle') {
  const options = {
    github: { type: 'string' },
    sha: { type: 'string' },
    tag: { type: 'string' },
    directory: { type: 'string' },
    'package-manager': { type: 'string' },
    'package-manager-version': { type: 'string' },
    lazy: { type: 'boolean' },
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
    define: { type: 'string', multiple: true },
    'package-json': { type: 'boolean' },
    'brotli-quality': { type: 'string' },
    generate: { type: 'string', multiple: true },
  }
  const parse = (args) => parseLeadingOptions(args, options, { valueFlags: valueFlagsOf(options), onError: fail })
  // The repo as `owner/name[/path]`, for --github=owner/name [--directory=path]: the first argument
  // that is no option, where no --github comes before it, with options on either side of it.
  const rest = [...argv]
  const bare = parse(rest).github === undefined && rest.length > 0 ? argv.splice(argv.length - rest.length, 1)[0] : undefined
  const values = parse(argv)
  let { github, directory } = values
  if (bare !== undefined) {
    if (github !== undefined || directory !== undefined) fail('Error: github-bundle takes owner/name[/path] or --github=owner/name [--directory=path], not both')
    const [owner, name, ...path] = bare.split('/')
    if (name === undefined) fail(`Error: github-bundle: '${bare}' is not owner/name[/path], the repo to bundle`)
    github = `${owner}/${name}`
    directory = path.join('/') || undefined
  }
  if (github === undefined) fail('Error: github-bundle requires the repo to bundle: owner/name[/path], or --github=owner/name')
  if (values.sha !== undefined && values.tag !== undefined) fail('Error: github-bundle takes --sha or --tag, not both')
  // Whether each option applies to the entries is buildGitHubBundle's to say.
  const list = (value) => [value ?? []].flat().flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean)
  const brotliQuality = brotliQualityOption(values['brotli-quality'], fail)
  let define
  if (values.define !== undefined) {
    const { parseDefineFlags } = await import('../src/define.js')
    try {
      define = parseDefineFlags(null, values.define)
    } catch (cause) {
      fail(`Error: ${cause.message}`)
    }
  }
  // Tarballs, zips and GitHub trees are cached where `stasis audit` caches.
  const { setCacheDir } = await import('../src/vfs-bundle.js')
  setCacheDir(userCacheDir())
  const { githubBundleCommand } = await import('../src/cmd/github-bundle.js')
  await githubBundleCommand({
    github,
    sha: values.sha,
    tag: values.tag,
    directory,
    packageManager: values['package-manager'],
    packageManagerVersion: values['package-manager-version'],
    lazy: Boolean(values.lazy),
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
    resources: values.resources === undefined ? undefined : list(values.resources),
    define,
    packageJSON: Boolean(values['package-json']),
    generate: list(values.generate),
    brotliQuality,
  })
} else if (command === 'add') {
  await addCli(argv, { label: 'stasis', fail })
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
  const values = parseLeadingOptions(argv, options, { valueFlags: valueFlagsOf(options), onError: fail })
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
  await extractCli(argv, { label: 'stasis', fail })
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
  await pruneCli(argv, { label: 'stasis', fail })
} else if (command === 'audit') {
  const options = { why: { type: 'boolean' }, 'why-deep': { type: 'boolean' }, 'why-full': { type: 'boolean' }, reason: { type: 'string' }, 'repo-advisories': { type: 'boolean' } }
  const values = parseLeadingOptions(argv, options, { valueFlags: valueFlagsOf(options), onError: fail })
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
  const values = parseLeadingOptions(argv, options, { valueFlags: valueFlagsOf(options), onError: fail })
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
