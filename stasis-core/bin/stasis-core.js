#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'
import assert from 'node:assert/strict'
import { addCli, extractCli, parseRunOptions, pruneCli, runProgram, setRunEnv } from '../src/cli.js'
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
 stasis-core extract [--output=path/to/dir] [--lock=(frozen|add|replace|ignore|none)] path/to/bundle.stasis.code.br
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

const command = argv.shift()

if (command === '-v' || command === '--version') {
  console.log(`v${pkg.version}`)
  process.exit(0)
} else if (command === '-h' || command === '--help') {
  usage(true)
} else if (command === 'run') {
  const run = parseRunOptions(argv, { fail })
  setRunEnv('stasis-core', run)
  await runProgram(argv, { loader: import.meta.resolve('../src/loader.js'), imports: run.imports })
} else if (command === 'prune') {
  await pruneCli(argv, { label: 'stasis-core', fail })
} else if (command === 'add') {
  await addCli(argv, { label: 'stasis-core', fail })
} else if (command === 'extract') {
  await extractCli(argv, { label: 'stasis-core', fail })
} else if (command === undefined) {
  usage()
} else {
  fail(`Error: unknown command '${command}'`)
}
