// The commands both CLIs take, `stasis-core` and `stasis`, from their arguments: `add`, `extract` and
// `prune` whole, and `run` in steps, so `stasis run` can add its own options on top -- its options
// parsed and checked, the config the loader reads set in the environment, and the program run under
// the loader. Each names itself `label` (the CLI's name) and leaves a usage error to `fail(message)`,
// which exits.

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants as osConstants } from 'node:os'
import { resolve } from 'node:path'
import { parseBrotliQuality, parseLeadingOptions } from './util.js'

const RUN_OPTIONS = {
  lock: { type: 'string', default: 'none' },
  bundle: { type: 'string', default: 'none' },
  'bundle-file': { type: 'string' },
  'resources-bundle-file': { type: 'string' },
  debug: { type: 'boolean' },
  dependencies: { type: 'boolean' },
  'child-process': { type: 'boolean' },
  import: { type: 'string', multiple: true },
  fs: { type: 'string' },
  resources: { type: 'string' },
  'brotli-quality': { type: 'string' },
}
// `--fs` is taken only as `--fs=<mode>`: a bare `--fs` is refused rather than given the program as its mode.
const RUN_VALUE_FLAGS = ['--bundle', '--bundle-file', '--resources-bundle-file', '--lock', '--import', '--resources', '--brotli-quality']

// `run`'s options, and the caller's own `options` (boolean ones), shifted off the front of `argv`,
// which keeps the program and its arguments; checked, a usage error being `fail(message)`'s (which
// exits). -> the run: `values` as parsed, and the config they set.
export function parseRunOptions(argv, { options = {}, fail }) {
  const values = parseLeadingOptions(argv, { ...RUN_OPTIONS, ...options }, { valueFlags: RUN_VALUE_FLAGS, onError: fail })
  if (argv.length === 0) fail('Nothing to run: no path to file given')
  const { lock, bundle } = values
  if (!['none', 'ignore', 'add', 'replace', 'frozen'].includes(lock)) fail('Error: invalid --lock value')
  const bundleFile = values['bundle-file'] ? resolve(values['bundle-file']) : ''
  const resourcesBundleFile = values['resources-bundle-file'] ? resolve(values['resources-bundle-file']) : ''
  if (!['none', 'ignore', 'add', 'replace', 'load', 'frozen'].includes(bundle)) fail('Error: invalid --bundle value')
  if (bundleFile && bundle === 'none') fail('Error: --bundle-file requires --bundle=(add|replace|load|frozen|ignore)')
  // --resources-bundle-file needs an active bundle mode (unlike --bundle-file, inert under ignore).
  if (resourcesBundleFile && (bundle === 'none' || bundle === 'ignore')) fail('Error: --resources-bundle-file requires --bundle=(add|replace|load|frozen)')
  if (bundle === 'load' && lock !== 'frozen' && lock !== 'none' && lock !== 'ignore') fail('Error: --bundle=load is incompatible with --lock=(add|replace)')
  if (lock === 'none' && bundle === 'none') fail('Error: stasis needs a lockfile or a bundle: set --lock or --bundle')
  // --fs requires a bundle mode (add|replace|load); `sync` patches the sync fs readers,
  // `async` adds their callback + fs.promises counterparts on top.
  if (values.fs !== undefined && !['sync', 'async'].includes(values.fs)) fail("Error: --fs must be 'sync' or 'async'")
  if (values.fs !== undefined && !['add', 'replace', 'load'].includes(bundle)) fail('Error: --fs requires --bundle=(add|replace|load)')
  const brotliQuality = brotliQualityOption(values['brotli-quality'], fail)
  // --import: extra preload module(s) passed through to the spawned node. Node resolves each
  // against the project cwd; they ride AFTER stasis's own loader import.
  const imports = values.import ?? []
  if (imports.some((s) => s === '')) fail('Error: --import requires a module specifier (e.g. --import=./instrument.mjs)')
  return {
    values,
    lock,
    scope: values.dependencies ? 'node_modules' : 'full',
    bundle,
    bundleFile,
    resourcesBundleFile,
    debug: values.debug ? '1' : '',
    // --child-process: forward forked-child (e.g. Metro worker) capture to the root via per-pid shards.
    childProcess: values['child-process'] ? '1' : '',
    fs: values.fs ?? '',
    // --resources: comma-separated extension/filename allowlist for `--fs` captures.
    resources: values.resources ?? '',
    brotliQuality,
    imports,
  }
}

// The `--brotli-quality` given as `value`, a usage error where it's no quality. -> it, or undefined
export function brotliQualityOption(value, fail) {
  if (value === undefined) return undefined
  try {
    return parseBrotliQuality('--brotli-quality', value)
  } catch (cause) {
    return fail(`Error: ${cause.message}`)
  }
}

// Sets the environment variable `name` to `value` (a string), refusing one the environment already
// sets otherwise.
export function setEnv(name, value) {
  const env = process.env[name]
  if (env && env !== value) throw new Error(`env conflict: ${name}="${env}", effective: "${value}"`)
  process.env[name] = value
}

// Announces `run` on stderr as `label` (the CLI's name), with the caller's own `extra` config after
// childProcess, and sets it in the environment the loader reads it from.
export function setRunEnv(label, run, extra = {}) {
  const { lock, scope, bundle, bundleFile, resourcesBundleFile, debug, childProcess, fs, resources, brotliQuality, imports } = run
  console.warn(`[${label}] Running stasis with config:`, { lock, scope, bundle, ...(bundleFile && { bundleFile }), ...(resourcesBundleFile && { resourcesBundleFile }), ...(childProcess && { childProcess: true }), ...extra, ...(imports.length > 0 && { import: imports }), ...(fs && { fs }), ...(resources && { resources }), ...(brotliQuality !== undefined && { brotliQuality }) })
  if (debug) console.warn(`[${label}] Warning: stasis debug mode active`)
  setEnv('EXODUS_STASIS_LOCK', lock)
  setEnv('EXODUS_STASIS_SCOPE', scope)
  setEnv('EXODUS_STASIS_BUNDLE', bundle)
  setEnv('EXODUS_STASIS_BUNDLE_FILE', bundleFile)
  setEnv('EXODUS_STASIS_RESOURCES_BUNDLE_FILE', resourcesBundleFile)
  setEnv('EXODUS_STASIS_DEBUG', debug)
  setEnv('EXODUS_STASIS_CHILD_PROCESS', childProcess)
  setEnv('EXODUS_STASIS_FS', fs)
  setEnv('EXODUS_STASIS_RESOURCES', resources)
  // Only set when given: an unconditional setEnv('') would reject an ambient EXODUS_STASIS_BROTLI_QUALITY as a conflict.
  if (brotliQuality !== undefined) setEnv('EXODUS_STASIS_BROTLI_QUALITY', String(brotliQuality))
}

// Runs the program `argv` in a node taking `nodeArgs`, then `--import`ing `loader` (a URL) and the
// run's `imports`. Those preloads ride after the loader, so they evaluate under its hooks; their
// module graphs pass through uncaptured unless the app graph reaches them -- then they're promoted
// into the capture (see hooks.js). Exits as the program does: its code, or 128+signo when a signal
// killed it (the shell's convention) instead of the implicit 0.
export async function runProgram(argv, { nodeArgs = [], loader, imports }) {
  const args = [...nodeArgs, '--import', loader, ...imports.flatMap((specifier) => ['--import', specifier]), ...argv]
  const child = spawn(process.execPath, args, { stdio: 'inherit' })
  const [code, signal] = await once(child, 'close')
  process.exitCode = code ?? 128 + (osConstants.signals[signal] ?? 0)
}

// `add`: packs the listed files (no resolver), taking split targets + resource allowlist from
// stasis.config.json; it takes no flags. Its runtime errors propagate as they are: wrapping them in
// fail() would bury the cause.
export async function addCli(argv, { label, fail }) {
  if (argv.length === 0) fail('Nothing to add: no file given')
  if (argv.some((a) => a.startsWith('-'))) fail('Error: add takes no options; its targets and resource allowlist come from stasis.config.json')
  const { addCommand } = await import('./add.js')
  addCommand({ cwd: process.cwd(), entries: argv, logLabel: label })
}

// `extract`: a bundle's files written out, as `--output` and `--lock` say.
export async function extractCli(argv, { label, fail }) {
  const options = {
    output: { type: 'string', short: 'o' },
    lock: { type: 'string' },
  }
  const values = parseLeadingOptions(argv, options, { valueFlags: ['--output', '-o', '--lock'], onError: fail })
  if (argv.length === 0) fail('Nothing to extract: no bundle file given')
  if (argv.length > 1) fail('Error: extract takes exactly one bundle file')
  // Unset: frozen when the output dir holds a stasis.lock.json, else none (see extractCommand).
  if (values.lock !== undefined && !['frozen', 'add', 'replace', 'ignore', 'none'].includes(values.lock)) fail('Error: invalid --lock value')
  const { extractCommand } = await import('./extract.js')
  extractCommand({ cwd: process.cwd(), bundleFile: argv[0], output: values.output, lock: values.lock, logLabel: label })
}

// `prune`: the project's node_modules (the one given, else the cwd's) cut down to its lockfile.
export async function pruneCli(argv, { label, fail }) {
  if (argv.length > 1) fail('Error: prune takes at most one path argument')
  const root = argv[0] ? resolve(argv[0]) : process.cwd()
  const { prune } = await import('./prune.js')
  const { removed, validated, minimized } = prune({ root })
  console.warn(`[${label}] prune: validated ${validated.length} file(s), removed ${removed.length} file(s), minimized ${minimized.length} package.json file(s)`)
}
