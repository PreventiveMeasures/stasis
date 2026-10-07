#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { basename, resolve } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import assert from 'node:assert/strict'
import { parseBrotliQuality, parseLeadingOptions } from '../src/util.js'
import pkg from '../package.json' with { type: 'json' }

const argv = [...process.argv]
assert(['node', 'node.exe'].includes(basename(argv.shift())))
assert(['node', 'node.exe'].includes(basename(process.argv0)))

const jsname = argv.shift()
const pathsEqual = (a, b) => a === b || (existsSync(a) && realpathSync(a) === b)
assert(basename(jsname) === 'stasis-core' || pathsEqual(jsname, fileURLToPath(import.meta.url)))

const HELP = `Usage:
 stasis-core run --lock=(add|replace|frozen|ignore) [--bundle=(add|replace|load|frozen|ignore)] [--bundle-file=path/to/bundle.br] [--resources-bundle-file=path/to/resources.br] [--dependencies] [--child-process] [--import=module ...] [--fs=(sync|async)] [--resources=ext,ext] [--brotli-quality=0..11] path/to/file.js ...
 stasis-core add path/to/(file|dir) ...
 stasis-core extract [--output=path/to/dir] path/to/bundle.stasis.code.br
 stasis-core prune [path/to/project]
 stasis-core --version

Each command's options: https://github.com/PreventiveMeasures/stasis/blob/main/doc/<command>.md
(run, extract, prune; add is in bundle.md)`

// The help, on stderr. Exits 0 when asked for (--help), 1 when printed for want of a command.
function usage(asked = false) {
  console.error(HELP)
  process.exit(asked ? 0 : 1)
}

// A usage error: the message and where the help is, never the help itself.
function fail(message) {
  console.error(`${message}\nRun 'stasis-core --help' for usage.`)
  process.exit(1)
}

function setEnv(name, value) {
  const env = process.env[name]
  if (env && env !== value) throw new Error(`env conflict: ${name}="${env}", effective: "${value}"`)
  process.env[name] = value === undefined ? '' : value
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
  if (resourcesBundleFile && (bundle === 'none' || bundle === 'ignore')) fail('Error: --resources-bundle-file requires --bundle=(add|replace|load|frozen)')
  if (bundle === 'load' && lock !== 'frozen' && lock !== 'none' && lock !== 'ignore') fail('Error: --bundle=load is incompatible with --lock=(add|replace)')
  if (lock === 'none' && bundle === 'none') fail('Error: stasis needs a lockfile or a bundle: set --lock or --bundle')
  if (values.fs !== undefined && !['sync', 'async'].includes(values.fs)) fail("Error: --fs must be 'sync' or 'async'")
  if (values.fs !== undefined && !['add', 'replace', 'load'].includes(bundle)) fail('Error: --fs requires --bundle=(add|replace|load)')
  const captureFs = values.fs ?? ''
  const resources = values.resources ?? ''
  let brotliQuality
  if (values['brotli-quality'] !== undefined) {
    try {
      brotliQuality = parseBrotliQuality('--brotli-quality', values['brotli-quality'])
    } catch (cause) {
      fail(`Error: ${cause.message}`)
    }
  }
  const childProcess = values['child-process'] ? '1' : ''
  // --import: extra preload module(s) passed through to the spawned node. Node resolves each
  // against the project cwd; they ride AFTER stasis's own loader import.
  const imports = values.import ?? []
  if (imports.some((s) => s === '')) fail('Error: --import requires a module specifier (e.g. --import=./instrument.mjs)')
  console.warn('[stasis-core] Running stasis with config:', { lock, scope, bundle, ...(bundleFile && { bundleFile }), ...(resourcesBundleFile && { resourcesBundleFile }), ...(childProcess && { childProcess: true }), ...(imports.length > 0 && { import: imports }), ...(values.fs && { fs: values.fs }), ...(resources && { resources }), ...(brotliQuality !== undefined && { brotliQuality }) })
  if (debug) console.warn(`[stasis-core] Warning: stasis debug mode active`)
  setEnv('EXODUS_STASIS_LOCK', lock)
  setEnv('EXODUS_STASIS_SCOPE', scope)
  setEnv('EXODUS_STASIS_BUNDLE', bundle)
  setEnv('EXODUS_STASIS_BUNDLE_FILE', bundleFile)
  setEnv('EXODUS_STASIS_RESOURCES_BUNDLE_FILE', resourcesBundleFile)
  setEnv('EXODUS_STASIS_DEBUG', debug)
  setEnv('EXODUS_STASIS_CHILD_PROCESS', childProcess)
  setEnv('EXODUS_STASIS_FS', captureFs)
  setEnv('EXODUS_STASIS_RESOURCES', resources)
  // Only set when given: an unconditional setEnv('') would reject an ambient EXODUS_STASIS_BROTLI_QUALITY as a conflict.
  if (brotliQuality !== undefined) setEnv('EXODUS_STASIS_BROTLI_QUALITY', String(brotliQuality))
  const nodeArgs = ['--import', import.meta.resolve('../src/loader.js')]
  // Passthrough preloads ride after the loader, so they evaluate under its hooks; their module
  // graphs pass through uncaptured unless the app graph reaches them -- then they're promoted
  // into the capture (see src/hooks.js).
  for (const specifier of imports) nodeArgs.push('--import', specifier)
  const child = spawn(process.execPath, [...nodeArgs, ...argv], { stdio: 'inherit' })
  const [code, signal] = await once(child, 'close')
  // code is null when the child died from a signal; report 128+signo (shell convention) instead of the implicit 0
  process.exitCode = code ?? 128 + (osConstants.signals[signal] ?? 0)
} else if (command === 'prune') {
  if (argv.length > 1) fail('Error: prune takes at most one path argument')
  const root = argv[0] ? resolve(argv[0]) : process.cwd()
  const { prune } = await import('../src/prune.js')
  const { removed, validated, minimized } = prune({ root })
  console.warn(`[stasis-core] prune: validated ${validated.length} file(s), removed ${removed.length} file(s), minimized ${minimized.length} package.json file(s)`)
} else if (command === 'add') {
  if (argv.length === 0) fail('Nothing to add: no file given')
  if (argv.some((a) => a.startsWith('-'))) fail('Error: add takes no options; its targets and resource allowlist come from stasis.config.json')
  const { addCommand } = await import('../src/add.js')
  addCommand({ cwd: process.cwd(), entries: argv, logLabel: 'stasis-core' })
} else if (command === 'extract') {
  const options = {
    output: { type: 'string', short: 'o' },
  }
  const values = parseLeadingOptions(argv, options, { valueFlags: ['--output', '-o'], onError: fail })
  if (argv.length === 0) fail('Nothing to extract: no bundle file given')
  if (argv.length > 1) fail('Error: extract takes exactly one bundle file')
  const { extractCommand } = await import('../src/extract.js')
  extractCommand({ cwd: process.cwd(), bundleFile: argv[0], output: values.output, logLabel: 'stasis-core' })
} else if (command === undefined) {
  usage()
} else {
  fail(`Error: unknown command '${command}'`)
}
