// End-to-end `stasis run` over a native addon `stasis bundle` followed and carries. Node loads one from disk by its
// path, past the load hook: a run resolves it by the artifacts' edge, and takes the file there.
import { describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { withTmp } from './tmp.helper.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_RESOURCES_BUNDLE_FILE: _rbf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_SHARD_SIGNAL_FLUSH: _ssf,
  EXODUS_STASIS_FS: _fs,
  ...cleanEnv
} = process.env

// spawn() + once('close'), not spawnSync, so the describe's concurrent runs overlap.
const run = async (args, opts = {}) => {
  const child = spawn(process.execPath, [cli, ...args], { env: cleanEnv, ...opts })
  const chunks = { stdout: [], stderr: [] }
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', (data) => chunks[stream].push(data))
  const [status] = await once(child, 'close')
  const text = (stream) => stripVTControlCharacters(Buffer.concat(chunks[stream]).toString('utf8'))
  return { status, stdout: text('stdout'), stderr: text('stderr') }
}

// A native addon of this platform, which only a real one loads as: oxc-parser's, which the scan itself runs on.
// None where it runs on its WebAssembly build instead.
function findAddon() {
  const require = createRequire(join(here, '..', 'stasis', 'package.json'))
  try {
    if (typeof require('oxc-parser').parseSync !== 'function') return null
  } catch {
    return null
  }
  const file = Object.keys(require.cache).find((name) => name.endsWith('.node'))
  return file === undefined ? null : readFileSync(file)
}

const ADDON = findAddon()
const skip = ADDON === null && 'no native addon of this platform in the workspace to load'

// As a package ships one for each platform, and loads its own.
const NATIVE = `native/lib_${process.platform}.node`
const LOADS = "const addon = require(`./native/lib_${process.platform}.node`)\nconsole.log('loaded', typeof addon)\n"

// A project whose entry loads the addon at NATIVE, under `dir`, and its `files` beside.
function project(dir, files = {}) {
  mkdirSync(join(dir, 'native'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'native-addon', version: '0.0.0' }))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), '') // the root, whatever lies above the tmpdir
  for (const [name, content] of Object.entries({ 'index.js': LOADS, ...files })) writeFileSync(join(dir, name), content)
  writeFileSync(join(dir, NATIVE), ADDON)
}

// The artifacts `stasis bundle` writes of `entries`, each where a run finds it: those the run's `flags` take.
async function attest(t, dir, flags, entries = ['index.js']) {
  const [lock, bundle] = ['--lock=', '--bundle='].map((flag) => flags.some((given) => given.startsWith(flag)))
  const args = ['bundle', ...(lock ? ['--lockfile=stasis.lock.json'] : []), ...(bundle ? ['--brotli-quality=0'] : ['--lockfile-only']), ...entries]
  const built = await run(args, { cwd: dir })
  t.assert.equal(built.status, 0, built.stderr)
}

// A run of `args` that loads the addon, and prints `stdout`.
async function loads(t, dir, args, stdout = 'loaded object\n') {
  const r = await run(['run', ...args], { cwd: dir })
  t.assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`)
  t.assert.equal(r.stdout, stdout, args.join(' '))
}

// Each way a run takes the artifacts.
const MODES = [
  ['--lock=frozen'], ['--lock=add'], ['--bundle=frozen'], ['--bundle=load'], ['--bundle=add'],
  ['--lock=frozen', '--bundle=load'], ['--lock=frozen', '--bundle=frozen'], ['--lock=add', '--bundle=add'],
]

describe('stasis run over a native addon stasis bundle carries (spawned, concurrent)', { concurrency: 4 }, () => {
  for (const flags of MODES) {
    test(`run ${flags.join(' ')} loads the addon the artifacts carry`, { skip }, withTmp(async (t, tmp) => {
      project(tmp)
      await attest(t, tmp, flags)
      await loads(t, tmp, [...flags, 'index.js'])
    }))
  }
})
