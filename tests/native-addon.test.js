// End-to-end `stasis run` over a native addon `stasis bundle` followed and carries. Node loads one from disk by its
// path, past the load hook: a run resolves it by the artifacts' edge, and holds the file there to what they attest
// of it before it runs (hooks.js's patchDlopen, State's assertNativeAddon). One that nothing attests is loaded as
// it is, and no run captures it.
import { describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { hash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { sha512integrity } from '@exodus/stasis-core/state-util'
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
// Another addon that loads just as well: a loader reads nothing past the end of the image.
const SWAPPED = ADDON && Buffer.concat([ADDON, Buffer.alloc(1)])
const skip = ADDON === null && 'no native addon of this platform in the workspace to load'

// As a package ships one for each platform, and loads its own.
const NATIVE = `native/lib_${process.platform}.node`
const REQUIRE = 'require(`./native/lib_${process.platform}.node`)'
const LOADS = `const addon = ${REQUIRE}\nconsole.log('loaded', typeof addon)\n`

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

// A run of `args` that refuses the addon at `file` for the one the `source` attests, having printed `stdout`.
async function refuses(t, dir, args, source, stdout = '', file = NATIVE) {
  const r = await run(['run', ...args], { cwd: dir })
  t.assert.notEqual(r.status, 0, args.join(' '))
  t.assert.ok(r.stderr.includes(`refusing to load the native addon ${file}: it is not the one the ${source}`), `${args.join(' ')}: ${r.stderr}`)
  t.assert.equal(r.stdout, stdout, args.join(' '))
}

const swap = (dir, file = NATIVE) => writeFileSync(join(dir, file), SWAPPED)

const ARTIFACTS = ['stasis.lock.json', 'stasis.code.br']
const digest = (bytes) => hash('sha256', bytes, 'hex')
const artifact = (dir, name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : null)
// By digest: a failed comparison of the bytes themselves would print megabytes of them.
const artifacts = (dir) => ARTIFACTS.map((name) => artifact(dir, name)).map((bytes) => bytes && digest(bytes))
const lockfileOf = (dir) => JSON.parse(artifact(dir, 'stasis.lock.json'))

// What each artifact there records of the addon, the lockfile its hash and the bundle its bytes: undefined where
// it records none, null where there is no such artifact.
function attested(dir) {
  const bundle = artifact(dir, 'stasis.code.br')
  const carried = bundle && JSON.parse(brotliDecompressSync(bundle)).sources['.'].files[NATIVE]
  return { lockfile: artifact(dir, 'stasis.lock.json') && lockfileOf(dir).sources['.'].files[NATIVE], bundle: carried && digest(Buffer.from(carried, 'base64')) }
}

// Each way a run takes the artifacts.
const MODES = [
  ['--lock=frozen'], ['--lock=add'], ['--bundle=frozen'], ['--bundle=load'], ['--bundle=add'],
  ['--lock=frozen', '--bundle=load'], ['--lock=frozen', '--bundle=frozen'], ['--lock=add', '--bundle=add'],
]

describe('stasis run over a native addon stasis bundle carries (spawned, concurrent)', { concurrency: 4 }, () => {
  for (const flags of MODES) {
    test(`run ${flags.join(' ')} loads the addon the artifacts carry, and refuses another in its place`, { skip }, withTmp(async (t, tmp) => {
      project(tmp)
      await attest(t, tmp, flags)
      const recorded = attested(tmp)
      const bundled = recorded.bundle !== null
      t.assert.deepStrictEqual(recorded, { lockfile: recorded.lockfile && sha512integrity(ADDON), bundle: bundled ? digest(ADDON) : null })
      t.assert.ok(recorded.lockfile || bundled)

      await loads(t, tmp, [...flags, 'index.js'])
      // A run that adds writes its artifacts anew, each with what it recorded of the addon before.
      t.assert.deepStrictEqual(attested(tmp), recorded)

      const before = artifacts(tmp)
      swap(tmp)
      // Before it runs: the bundle's bytes where one carries it, else the lockfile's hash.
      await refuses(t, tmp, [...flags, 'index.js'], bundled ? 'bundle carries' : 'lockfile records')
      t.assert.deepStrictEqual(artifacts(tmp), before, 'a refused run writes nothing')
    }))
  }

  test('run loads an addon no artifact attests as it is, and captures none', { skip }, withTmp(async (t, tmp) => {
    project(tmp)
    // A run records the edge to the addon it loads, and none of its bytes.
    await loads(t, tmp, ['--lock=add', '--bundle=add', 'index.js'])
    const lockfile = lockfileOf(tmp)
    t.assert.deepStrictEqual(Object.keys(lockfile.sources['.'].files), ['index.js'])
    t.assert.deepStrictEqual(Object.values(lockfile.imports)[0]['index.js'], { [`./${NATIVE}`]: NATIVE })
    t.assert.deepStrictEqual(attested(tmp), { lockfile: undefined, bundle: undefined })

    // So an addon an install builds anew, or another platform's, breaks no run.
    swap(tmp)
    // The two that write nothing at once, and then the one that writes.
    await Promise.all([['--lock=frozen', '--bundle=load'], ['--lock=frozen', '--bundle=frozen']].map((flags) => loads(t, tmp, [...flags, 'index.js'])))
    await loads(t, tmp, ['--lock=add', '--bundle=add', 'index.js'])
  }))

  test('run --lock=replace reads no lockfile to hold the addon to, and records none of it', { skip }, withTmp(async (t, tmp) => {
    project(tmp)
    await attest(t, tmp, ['--lock=replace'])
    t.assert.equal(attested(tmp).lockfile, sha512integrity(ADDON))
    swap(tmp)
    await loads(t, tmp, ['--lock=replace', 'index.js'])
    t.assert.deepStrictEqual(Object.keys(lockfileOf(tmp).sources['.'].files), ['index.js'])
  }))

  test('run holds an addon however it is loaded: process.dlopen, a forked child, a worker', { skip }, withTmp(async (t, tmp) => {
    project(tmp, {
      'direct.js': `const m = { exports: {} }\nprocess.dlopen(m, require('node:path').join(__dirname, '${NATIVE}'))\nconsole.log('loaded', typeof m.exports)\n`,
      'fork.js': [
        "if (process.argv[2] === 'child') return require('./index.js')",
        "require('node:child_process').fork(__filename, ['child']).on('exit', (code) => { process.exitCode = code })",
      ].join('\n'),
      'worker.js': [
        "const { Worker, isMainThread } = require('node:worker_threads')",
        "if (!isMainThread) return require('./index.js')",
        'new Worker(__filename).on(\'error\', (error) => { console.error(error.message); process.exitCode = 1 })',
      ].join('\n'),
    })
    const entries = ['direct.js', 'fork.js', 'worker.js']
    await attest(t, tmp, ['--lock=frozen'], ['index.js', ...entries])
    // A frozen run writes nothing, so the three run at once.
    await Promise.all(entries.map((entry) => loads(t, tmp, ['--lock=frozen', entry])))
    swap(tmp)
    await Promise.all(entries.map((entry) => refuses(t, tmp, ['--lock=frozen', entry], 'lockfile records')))
  }))

  test('run holds the addon a preload loaded once the app reaches it, and not before', { skip }, withTmp(async (t, tmp) => {
    project(tmp, {
      'plain.js': "console.log('ran')\n",
      'preload.cjs': `console.log('preloaded', typeof ${REQUIRE})\n`,
      // As a preload loads a package whose module loads its addon, and the app requires that package too.
      'wrapper.js': `module.exports = ${REQUIRE}\n`,
      'wrapped.js': "console.log('wrapped', typeof require('./wrapper.js'))\n",
      'preload-wrapper.cjs': "require('./wrapper.js')\nconsole.log('preloaded')\n",
      // As a preload that wraps the app requires its entry, which is then run from the cache.
      'preload-entry.cjs': "require('./index.js')\n",
    })
    await attest(t, tmp, ['--lock=frozen'], ['index.js', 'plain.js', 'wrapped.js'])
    const preloaded = (entry, preload = 'preload.cjs') => ['--lock=frozen', `--import=./${preload}`, entry]

    await Promise.all([
      loads(t, tmp, preloaded('index.js'), 'preloaded object\nloaded object\n'),
      loads(t, tmp, preloaded('wrapped.js', 'preload-wrapper.cjs'), 'preloaded\nwrapped object\n'),
      loads(t, tmp, preloaded('index.js', 'preload-entry.cjs')),
    ])
    swap(tmp)
    await Promise.all([
      // A preload's own is runner infrastructure, as its modules are.
      loads(t, tmp, preloaded('plain.js'), 'preloaded object\nran\n'),
      // The app's require() of it is served the one the preload loaded, from the require cache.
      refuses(t, tmp, preloaded('index.js'), 'lockfile records', 'preloaded object\n'),
      // As is its require() of the preload's module that loaded it, cached with it.
      refuses(t, tmp, preloaded('wrapped.js', 'preload-wrapper.cjs'), 'lockfile records', 'preloaded\n'),
      // And the entry itself, where the preload ran it: the run has no State until it resolves.
      refuses(t, tmp, preloaded('index.js', 'preload-entry.cjs'), 'lockfile records', 'loaded object\n'),
    ])
  }))

  test('run writes nothing where the program catches the refusal and runs on', { skip }, withTmp(async (t, tmp) => {
    project(tmp, {
      // As a package falls back from its addon to its JS; `later.js` is what --lock=add would add.
      'index.js': `try { ${REQUIRE} } catch (error) { console.log('caught', error.message) }\nrequire('./later.js')\n`,
      'later.js': "console.log('ran on')\n",
    })
    await attest(t, tmp, ['--lock=add'])
    // The scan followed `later.js` too: drop it from the lockfile, as one written before it was required.
    const lockfile = lockfileOf(tmp)
    delete lockfile.sources['.'].files['later.js']
    delete Object.values(lockfile.imports)[0]['index.js']['./later.js']
    delete lockfile.formats['later.js']
    const before = JSON.stringify(lockfile, null, 2)
    writeFileSync(join(tmp, 'stasis.lock.json'), before)

    await loads(t, tmp, ['--lock=add', 'index.js'], 'ran on\n')
    t.assert.ok(Object.hasOwn(lockfileOf(tmp).sources['.'].files, 'later.js'), 'a run that loads the addon attested adds what it reaches')

    writeFileSync(join(tmp, 'stasis.lock.json'), before)
    swap(tmp)
    await loads(t, tmp, ['--lock=add', 'index.js'], `caught stasis: refusing to load the native addon ${NATIVE}: it is not the one the lockfile records\nran on\n`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'), before, 'a run that refused an addon attests nothing')
  }))

  test('run in node_modules scope holds a dependency\'s addon, and not the project\'s own', { skip }, withTmp(async (t, tmp) => {
    project(tmp, { 'index.js': `${LOADS}console.log('dep', typeof require('dep'))\n` })
    const dep = join(tmp, 'node_modules', 'dep')
    mkdirSync(dep, { recursive: true })
    writeFileSync(join(dep, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
    writeFileSync(join(dep, 'index.js'), 'module.exports = require(`./lib_${process.platform}.node`)\n')
    const own = `node_modules/dep/lib_${process.platform}.node`
    writeFileSync(join(tmp, own), ADDON)
    const built = await run(['bundle', '--scope=node_modules', '--lockfile=stasis.lock.json', '--lockfile-only', 'index.js'], { cwd: tmp })
    t.assert.equal(built.status, 0, built.stderr)
    const args = ['--lock=frozen', '--dependencies', 'index.js']

    // The project's own files are none of a node_modules scope's, whatever the lockfile may say of them.
    swap(tmp)
    await loads(t, tmp, args, 'loaded object\ndep object\n')
    swap(tmp, own)
    await refuses(t, tmp, args, 'lockfile records', 'loaded object\n', own)
  }))
})
