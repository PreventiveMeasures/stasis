import { test, describe } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const helper = join(here, 'esbuild-run.helper.js')
const fullFixture = join(here, 'fixtures', 'esbuild-full')
const nmFixture = join(here, 'fixtures', 'esbuild-nm')
const jsonFixture = join(here, 'fixtures', 'esbuild-json')
const assetsFixture = join(here, 'fixtures', 'esbuild-assets')
const optionalRequireFixture = join(here, 'fixtures', 'esbuild-optional-require')
const browserMapFixture = join(here, 'fixtures', 'esbuild-browser-map')

// Route png/svg through esbuild's native `file` loader (copies the asset, returns a URL).
const FILE_LOADER = JSON.stringify({ '.png': 'file', '.svg': 'file' })

// drop inherited stasis env so child processes get a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  ...cleanEnv
} = process.env

// Async child-process runner. Blocking spawnSync would stall the node:test event
// loop, collapsing the describe-level `concurrency` below to wall-clock-sequential.
// spawn() + once('close') yields between tests, so the concurrent esbuild builds
// actually overlap. Each test still gets its own subprocess -- and thus a fresh
// preload singleton -- so the isolation the spawn model provides is unchanged.
const run = async (entries, { cwd, env = {} }) => runNode([helper, ...entries], { cwd, env })

const runNode = async (args, { cwd, env = {} }) => {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...cleanEnv, ...env },
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))
  const [status] = await once(child, 'close')
  return {
    status,
    stdout: stripVTControlCharacters(Buffer.concat(stdoutChunks).toString('utf-8')),
    stderr: stripVTControlCharacters(Buffer.concat(stderrChunks).toString('utf-8')),
  }
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-esbuild-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// node --test already runs test files in parallel (~= CPU count), and each test
// here spawns a build subprocess. Running every test at once would oversubscribe
// CPU/RAM (files-in-parallel x tests-in-file); a small per-file cap keeps the
// total concurrent-subprocess count bounded while capturing most of the speedup.
const CONCURRENCY = 4 // matches CI runner cores; higher barely helps here (see commit msg)

describe('StasisEsbuild (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('lock=add records the entry and its imports', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepStrictEqual(lock.config, { scope: 'full' })
    t.assert.deepStrictEqual(lock.entries, ['src/entry.js'])
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
    t.assert.deepStrictEqual(lock.modules, {})
  }))

  test('lock=add is idempotent against the committed lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const after = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')
    t.assert.equal(after, before)
  }))

  test('lock=frozen succeeds with the committed lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite lockfile')
  }))

  test('lock=frozen rejects a changed source file', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
  }))

  test('lock=add rejects a changed source file', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
  }))

  test('lock=frozen rejects a brand-new entry not listed in the lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'fresh.js'), "console.log('fresh')\n")

    const r = await run(['src/fresh.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
  }))

  test('lock=add rejects a changed package.json version', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const pkgPath = join(tmp, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    pkg.version = '99.99.99'
    writeFileSync(pkgPath, JSON.stringify(pkg, undefined, 2) + '\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
  }))

  test('lock=replace rewrites the lockfile after a source change', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockPath = join(tmp, 'stasis.lock.json')
    const before = readFileSync(lockPath, 'utf-8')
    writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = (n) => `bonjour, ${n}`\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'replace', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const after = JSON.parse(readFileSync(lockPath, 'utf-8'))
    const oldHash = JSON.parse(before).sources['.'].files['src/hello.js']
    const newHash = after.sources['.'].files['src/hello.js']
    t.assert.notEqual(newHash, oldHash)
    t.assert.ok(newHash.startsWith('sha512-'))
    t.assert.deepStrictEqual(after.entries, ['src/entry.js'])
  }))

  test('lock=replace drops stale entries from the previous lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockPath = join(tmp, 'stasis.lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
    lock.sources['.'].files['src/stale.js'] = 'sha512-deadbeef'
    lock.entries.push('src/stale.js')
    writeFileSync(lockPath, JSON.stringify(lock, undefined, 2) + '\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'replace', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const after = JSON.parse(readFileSync(lockPath, 'utf-8'))
    t.assert.equal(after.sources['.'].files['src/stale.js'], undefined)
    t.assert.ok(!after.entries.includes('src/stale.js'))
  }))

  test('lock=ignore tolerates the committed lockfile and does not touch it', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockPath = join(tmp, 'stasis.lock.json')
    const before = readFileSync(lockPath, 'utf-8')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'ignore', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(lockPath, 'utf-8'), before, 'lock=ignore must not touch the lockfile')
  }))

  test('bundle=add writes a bundle whose sources match disk', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath))

    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.equal(decoded.version, 1)
    t.assert.deepStrictEqual(decoded.config, { scope: 'full' })
    t.assert.deepStrictEqual(decoded.entries, ['src/entry.js'])
    t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
    t.assert.equal(decoded.sources['.'].files['src/hello.js'], readFileSync(join(tmp, 'src/hello.js'), 'utf-8'))
    t.assert.equal(decoded.formats['src/entry.js'], 'module')
  }))

  test('bundle=load rejects a tampered source in the bundle', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const save = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      },
    })
    t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

    // tamper: swap hello.js source for an attacker payload
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    decoded.sources['.'].files['src/hello.js'] = 'export const greet = (n) => `pwned, ${n}`\n'
    writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

    // re-running with bundle=add (which pre-loads the bundle) must catch the disk/bundle disagreement
    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'frozen',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
  }))

  test('bundle=load fails closed when an in-scope file is missing from the bundle (does NOT silently fall through to disk)', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-capture'),
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    // Tamper: drop src/hello.js from sources. The import-map edge entry.js ->
    // ./hello.js is still attested, so onResolve picks the same URL -- but
    // onLoad's state.getFile call must error (no disk fallback) when the source
    // bytes aren't there. The sources stay on disk so silent disk fallback would
    // succeed; the fix is that it must not.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    delete decoded.sources['.'].files['src/hello.js']
    writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

    const loadDir = join(tmp, 'load')
    cpSync(capDir, loadDir, { recursive: true })
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    rmSync(join(loadDir, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-load'),
      },
    })
    t.assert.notEqual(r.status, 0, 'load must fail when an in-scope file is missing from the bundle')
    t.assert.match(r.stderr, /hello\.js/)
  }))

  // Fail-closed on the genuinely-new branch: the externals defer must NOT become a disk
  // fallback for an in-scope FILE. The test above drops only the SOURCE (keeping the edge),
  // so getImport still succeeds and never reaches the new catch. Here we drop BOTH the edge
  // AND the bytes for an in-scope relative import: getImport's resolveBundled fallback can't
  // recover it (bytes gone) -> it throws ERR_MODULE_NOT_FOUND -> the new catch returns
  // undefined -> esbuild re-resolves ./hello.js -> onLoad's getFile throws (not in bundle).
  // The build MUST fail even though hello.js is present on disk in the load dir.
  test('bundle=load still fails closed when an in-scope edge AND its bytes are dropped (defer is not a disk fallback)', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-capture'),
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    // Drop both the import edge from src/entry.js and the bytes of src/hello.js -- the only
    // way to reach the defer branch for an in-scope file (with either intact, getImport
    // resolves it from the bundle instead of throwing).
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    for (const k of Object.keys(decoded.imports)) delete decoded.imports[k]['src/entry.js']
    delete decoded.sources['.'].files['src/hello.js']
    writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

    const loadDir = join(tmp, 'load')
    cpSync(capDir, loadDir, { recursive: true })  // full source tree stays on disk
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    rmSync(join(loadDir, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-load'),
      },
    })
    t.assert.notEqual(r.status, 0, 'defer must not silently read the in-scope file from disk')
    t.assert.match(r.stderr, /hello\.js/)
  }))

  test('bundle=load runs from a clean dir holding only the bundle + a minimal package.json', withTmp(async (t, tmp) => {
    // Phase 1 in a capture-side dir (full fixture: sources, lockfile, config).
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ESBUILD_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

    // Phase 2 in a clean load-side dir holding nothing but the bundle file and the
    // bare-minimum package.json State needs to anchor its root discovery. NO sources,
    // no lockfile, no stasis.config.json, no pnpm-workspace.yaml -- just the bundle.
    // This is the deployment shape we want to support: ship the bundle, drop it on
    // a host, run the bundler again, get the same output.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')
    // Sanity: confirm the load-side dir really doesn't have the source tree.
    t.assert.ok(!existsSync(join(loadDir, 'src')), 'load dir must not contain src/')
    t.assert.ok(!existsSync(join(loadDir, 'src/entry.js')), 'load dir must not contain entry')
    t.assert.ok(!existsSync(join(loadDir, 'stasis.lock.json')), 'load dir must not contain a lockfile')

    const outB = join(tmp, 'out-load')
    // lock=none: in this clean-dir scenario the bundle is self-authoritative -- no
    // lockfile is required to verify content. getFile's hash check is gated on
    // useLockfile, which is false under lock=none, so the bundle's own bytes
    // round-trip without a sibling attestation.
    const replay = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_ESBUILD_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

    // Round-trip faithfulness: the bundler's emitted JS bytes must match. Load mode
    // returns the same absolute paths under namespace='file' as capture mode, so
    // esbuild's path-banner comments are written relative to cwd in both runs (which
    // resolve to the same `src/entry.js` / `src/hello.js`).
    t.assert.equal(replayOutput, captureOutput)
  }))

  // Regression: a Node.js built-in (`node:constants`, `path`, ...) imported by an
  // in-scope file must NOT be looked up in the bundle's import map under bundle=load.
  // Built-ins are never carried in the bundle and never recorded as import edges -- the
  // capture side defers isBuiltin() specifiers before addImport sees them. So the
  // load-mode onResolve hook has to return undefined for them and let esbuild externalize
  // them (platform:'node'), exactly as in a build without this plugin. Pre-fix,
  // state.getImport found no edge and threw ERR_MODULE_NOT_FOUND, which esbuild surfaced
  // as `[plugin: stasis] Cannot find module 'node:constants' imported from <file>`
  // (the same class of failure the webpack plugin hit with graceful-fs's require('constants')).
  test('bundle=load defers Node built-ins to esbuild instead of looking them up in the bundle', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
    // A node:-prefixed builtin and a bare builtin alongside the normal relative import:
    // the relative edge IS attested and served from the bundle; the builtins must defer
    // to esbuild's own externalization.
    writeFileSync(join(capDir, 'src', 'entry.js'),
      "import { O_RDONLY } from 'node:constants'\n" +
      "import { sep } from 'path'\n" +
      "import { greet } from './hello.js'\n" +
      "console.log(greet('world'), O_RDONLY, sep)\n")
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ESBUILD_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

    // Clean load dir: only the bundle + a minimal package.json. No sources on disk, so a
    // working load mode is the only path to a build -- and the builtins, which the bundle
    // never carried, must resolve through esbuild's own externalization.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')

    const outB = join(tmp, 'out-load')
    const replay = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_ESBUILD_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

    // Round-trip faithfulness AND builtin externalization: the load output equals the
    // capture output, and esbuild externalized the builtins rather than failing to resolve.
    t.assert.equal(replayOutput, captureOutput)
    t.assert.match(replayOutput, /from "node:constants"/)
    t.assert.match(replayOutput, /from "path"/)
  }))

  // Regression (generalizes the built-in case to ALL externals): a non-builtin module the
  // user marks `external` (esbuild has no electron preset, so externals are declared in
  // config) is never bundled and never recorded as an import edge. At bundle=load,
  // state.getImport throws ERR_MODULE_NOT_FOUND; the load-mode onResolve hook must treat
  // that miss as "external" and return undefined so esbuild externalizes it, instead of
  // failing the build with `Cannot find module 'electron'`. The byte-level fail-closed
  // gate (onLoad -> getFile) is unaffected -- see the missing-file test above.
  test('bundle=load defers user externals (electron) to esbuild instead of looking them up in the bundle', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(fullFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'))  // entry is rewritten below; build a fresh lockfile
    writeFileSync(join(capDir, 'src', 'entry.js'),
      "import { app } from 'electron'\n" +
      "import { greet } from './hello.js'\n" +
      "console.log(greet(typeof app))\n")
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ESBUILD_EXTERNAL: '["electron"]',
        STASIS_TEST_ESBUILD_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')

    const outB = join(tmp, 'out-load')
    const replay = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        EXODUS_STASIS_LOCK: 'none',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
        STASIS_TEST_ESBUILD_EXTERNAL: '["electron"]',
        STASIS_TEST_ESBUILD_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

    t.assert.equal(replayOutput, captureOutput)
    t.assert.match(replayOutput, /from "electron"/)
  }))

  test('bundle=load: import attributes (with { type: "json" }) round-trip', withTmp(async (t, tmp) => {
    // The Node run loader stores edges under a conditions-with-attributes key when
    // an import carries `with { type: 'json' }` (state.#conditionsKey). The esbuild
    // plugin must forward those attributes both at capture (addImport) and at load
    // (getImport) for the round-trip to find the same key. Without the forwarding,
    // load-mode getImport would use the '*' wildcard and miss the attributed entry.
    const capDir = join(tmp, 'cap')
    cpSync(jsonFixture, capDir, { recursive: true })
    // Rewrite the entry to use the `with { type: 'json' }` syntax. The fixture's
    // src/entry.js currently imports the JSON without attributes; switching the
    // syntax produces a bundle whose imports map is keyed with the attribute.
    writeFileSync(
      join(capDir, 'src/entry.js'),
      `import data from './data.json' with { type: 'json' }\nconsole.log(\`hello, \${data.who}\`)\n`,
    )
    rmSync(join(capDir, 'stasis.lock.json'))
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-cap')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ESBUILD_OUTDIR: outA,
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    // Sanity: the captured bundle's imports map keys the edge under the
    // attribute-bearing conditions string. If this assertion fails, the capture
    // side dropped the attribute and the load-side fix below would be untestable.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    const importsKeys = Object.keys(decoded.imports)
    t.assert.ok(
      importsKeys.some((k) => k.includes('"type":"json"')),
      `expected at least one imports key to carry the type=json attribute; got ${JSON.stringify(importsKeys)}`,
    )

    // Load mode: tear down sources, re-run with bundle=load. The plugin's
    // load-mode getImport must pass the same attributes to find the keyed edge.
    rmSync(join(capDir, 'src'), { recursive: true })
    const outB = join(tmp, 'out-load')
    const replay = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        EXODUS_STASIS_LOCK: 'frozen',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'load',
        EXODUS_STASIS_BUNDLE_FILE: capBundle,
        STASIS_TEST_ESBUILD_OUTDIR: outB,
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    t.assert.equal(
      readFileSync(join(outB, 'entry.js'), 'utf-8'),
      readFileSync(join(outA, 'entry.js'), 'utf-8'),
      'with-attributes import must round-trip byte-identically under bundle=load',
    )
  }))

  test('bundle=replace rewrites a bundle that had stale orphan entries', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const save = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      },
    })
    t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)

    // forge a stale orphan into the existing bundle
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    decoded.sources['.'].files['src/orphan.js'] = 'export const x = 0\n'
    writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'replace',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'replace',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const after = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.equal(after.sources['.'].files['src/orphan.js'], undefined)
  }))

  test('node_modules scope records package files and skips src/', withTmp(async (t, tmp) => {
    cpSync(nmFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'node_modules' },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepStrictEqual(lock.config, { scope: 'node_modules' })
    t.assert.equal(lock.entries, undefined)
    t.assert.equal(lock.sources, undefined)
    t.assert.ok(lock.modules['node_modules/fake-esm-pkg'])
    t.assert.ok(lock.modules['node_modules/fake-esm-pkg'].files['index.js'].startsWith('sha512-'))
  }))

  test('node_modules scope lock=frozen rejects a changed node_modules file', withTmp(async (t, tmp) => {
    cpSync(nmFixture, tmp, { recursive: true })
    writeFileSync(
      join(tmp, 'node_modules', 'fake-esm-pkg', 'index.js'),
      'export const greet = (n) => `pwned, ${n}`\n'
    )

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
  }))

  test('node_modules scope lock=frozen tolerates changes to non-tracked src/ files', withTmp(async (t, tmp) => {
    cpSync(nmFixture, tmp, { recursive: true })
    // src/ is outside node_modules scope, so changes here must not affect the lockfile check
    writeFileSync(join(tmp, 'src', 'helper.js'), "export const who = 'mars'\n")

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  }))

  test('lock=add records a .json import alongside the entry', withTmp(async (t, tmp) => {
    cpSync(jsonFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepStrictEqual(lock.entries, ['src/entry.js'])
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/data.json'].startsWith('sha512-'))
  }))

  test('lock=frozen succeeds with a committed .json import', withTmp(async (t, tmp) => {
    cpSync(jsonFixture, tmp, { recursive: true })
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
  }))

  test('lock=frozen rejects a changed .json import', withTmp(async (t, tmp) => {
    cpSync(jsonFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'data.json'), '{ "who": "mars" }\n')

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Build failed|ERR_ASSERTION/)
  }))

  test('bundle=add captures a .json import in the bundle', withTmp(async (t, tmp) => {
    cpSync(jsonFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_LOCK: 'add',
        EXODUS_STASIS_SCOPE: 'full',
        EXODUS_STASIS_BUNDLE: 'add',
        EXODUS_STASIS_BUNDLE_FILE: bundlePath,
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.equal(decoded.sources['.'].files['src/data.json'], readFileSync(join(tmp, 'src/data.json'), 'utf-8'))
    t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  }))

  test('config scope conflict with env is reported', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    // committed config is scope=full; setting node_modules via env must conflict
    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules' },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Flags\/env can not override stasis\.config\.json/)
  }))

  // ----- Plugin options coverage --------------------------------------------------------

  const withOpts = (opts, extra = {}) => ({ STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify(opts), ...extra })

  test('options.lock=add records the entry like the env path', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add' }) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepStrictEqual(lock.entries, ['src/entry.js'])
    t.assert.ok(lock.sources['.'].files['src/hello.js'].startsWith('sha512-'))
  }))

  test('options.lock=frozen succeeds with the committed lockfile', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'frozen' }) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before)
  }))

  test('options.bundle=add with bundleFile writes the bundle at the chosen path', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath }),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath))
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  }))

  test('options conflict with env is reported', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { ...withOpts({ lock: 'frozen' }), EXODUS_STASIS_LOCK: 'add' },
    })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Config options can not override stasis env/)
  }))

  test('unknown plugin option is rejected', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', bogus: 'x' }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Unknown StasisEsbuild options/)
  }))

  test('invalid plugin option value is rejected', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'bogus' }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /Invalid lock/)
  }))

  // ----- Plugin↔preload coordination paths ----------------------------------------------

  const standalone = (extra = {}) => ({ STASIS_TEST_PRELOAD: '0', ...extra })

  test('rule 1: plugin lockfile without preload is a hard throw', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    const r = await run(['src/entry.js'], { cwd: tmp, env: standalone(withOpts({ lock: 'add' })) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /lockfile mode 'add' requires a stasis preload/)
  }))

  test('rule 0: plugin with no options, no preload, not under stasis run does nothing', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    // No capture options and not under `stasis run` -> the plugin is inert (Rule 0). Wiring
    // StasisEsbuild into a config is a no-op on a plain build; it neither throws nor writes.
    const r = await run(['src/entry.js'], { cwd: tmp, env: standalone(withOpts({})) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
      'inert plugin must not touch the lockfile')
  }))

  test('rule 7: plugin with lock=none + bundle=none and no preload is a no-op', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const lockBefore = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: standalone(withOpts({ lock: 'none', bundle: 'none' })),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), lockBefore,
      'noop plugin must not touch the lockfile')
  }))

  test('plugin standalone with bundle writes the bundle via onEnd', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))
    const bundlePath = join(tmp, 'standalone.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(bundlePath), 'plugin must write the bundle on done')
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.equal(decoded.sources['.'].files['src/entry.js'], readFileSync(join(tmp, 'src/entry.js'), 'utf-8'))
  }))

  test('failed build does not write the bundle (no clobber)', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(
      join(tmp, 'src', 'entry.js'),
      "import './does-not-exist.js'\nimport { greet } from './hello.js'\nconsole.log(greet('world'))\n"
    )
    const bundlePath = join(tmp, 'standalone.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: standalone(withOpts({ lock: 'ignore', bundle: 'add', bundleFile: bundlePath })),
    })
    t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
    t.assert.equal(existsSync(bundlePath), false, 'failed build must not write the bundle')
  }))

  test('unknown extension throws unless it is in the resources allowlist', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    // The plugin must refuse rather than silently widen lockfile coverage to a file the
    // Node loader could never serve back.
    writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
    writeFileSync(
      join(tmp, 'src', 'entry.js'),
      "import './styles.css'\nimport { greet } from './hello.js'\nconsole.log(greet('world'))\n"
    )
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
    t.assert.match(r.stderr, /unsupported extension/)
  }))

  test("resources allowlist attests opted-in extensions", withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    writeFileSync(join(tmp, 'src', 'styles.css'), '.x { color: red }\n')
    writeFileSync(
      join(tmp, 'src', 'entry.js'),
      "import './styles.css'\nimport { greet } from './hello.js'\nconsole.log(greet('world'))\n"
    )
    rmSync(join(tmp, 'stasis.lock.json'))

    const r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', resources: ['css'] }) })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/styles.css'].startsWith('sha512-'),
      'allowlisted resource is hash-attested')
  }))

  test("resources rejects code extensions and malformed entries", withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })

    let r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', resources: ['js'] }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /resources entry 'js' is a code extension/)

    r = await run(['src/entry.js'], { cwd: tmp, env: withOpts({ lock: 'add', resources: ['../etc/passwd'] }) })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /is not a valid extension/)
  }))

  test("esbuild plugin accepts import attributes (with { type: 'json' })", withTmp(async (t, tmp) => {
    cpSync(jsonFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'))
    writeFileSync(
      join(tmp, 'src', 'entry.js'),
      "import data from './data.json' with { type: 'json' }\nconsole.log(data)\n"
    )

    const r = await run(['src/entry.js'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full' } })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  }))

  test('sidecar bundle (rule 6) is emitted by the plugin alongside preload bundle', withTmp(async (t, tmp) => {
    cpSync(fullFixture, tmp, { recursive: true })
    const preloadBundle = join(tmp, 'preload.br')
    const sidecarBundle = join(tmp, 'sidecar.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: preloadBundle }),
        STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ lock: 'add', bundle: 'add', bundleFile: sidecarBundle }),
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.ok(existsSync(preloadBundle), 'preload bundle must be written by loader hooks')
    t.assert.ok(existsSync(sidecarBundle), 'sidecar bundle must be written by plugin onEnd hook')
    t.assert.ok(existsSync(join(tmp, 'stasis.lock.json')))
  }))

  // ----- file-loader: binary assets copied to output (png/svg) --------------------------

  test('file-loader png/svg assets throw without the resources allowlist', withTmp(async (t, tmp) => {
    cpSync(assetsFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'), { force: true })

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_ESBUILD_LOADER: FILE_LOADER },
    })
    t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
    t.assert.match(r.stderr, /unsupported extension/)
  }))

  test('file-loader png/svg assets are hash-attested and tagged with per-file resource format', withTmp(async (t, tmp) => {
    // Post-collapse: code and resources share one bundle, distinguished per file by
    // formats[file]: 'resource' (raw UTF-8, e.g. SVG) or 'resource:base64' (binary,
    // e.g. PNG). Both appear in the bundle's per-package files; the format tag is
    // what tells a reader "this is asset content, not code".
    cpSync(assetsFixture, tmp, { recursive: true })
    rmSync(join(tmp, 'stasis.lock.json'), { force: true })
    const bundlePath = join(tmp, 'snapshot.br')

    const r = await run(['src/entry.js'], {
      cwd: tmp,
      env: {
        STASIS_TEST_ESBUILD_LOADER: FILE_LOADER,
        ...withOpts({ lock: 'add', bundle: 'add', bundleFile: bundlePath, resources: ['png', 'svg'] }),
      },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)

    // Lockfile attests bytes (sha512 of raw bytes) for all three files.
    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'))
    t.assert.ok(lock.sources['.'].files['src/entry.js'].startsWith('sha512-'))
    t.assert.ok(lock.sources['.'].files['src/logo.png'].startsWith('sha512-'), 'png hash-attested')
    t.assert.ok(lock.sources['.'].files['src/icon.svg'].startsWith('sha512-'), 'svg hash-attested')

    // Lockfile formats: code stays its loader format; resources get resource/resource:base64.
    t.assert.equal(lock.formats['src/icon.svg'], 'resource', 'UTF-8 asset tagged "resource"')
    t.assert.equal(lock.formats['src/logo.png'], 'resource:base64', 'binary asset tagged "resource:base64"')

    // Bundle: all three files live together; resources are tagged in formats.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
    t.assert.ok(decoded.sources['.'].files['src/entry.js'], 'JS entry is in the bundle')
    t.assert.ok(decoded.sources['.'].files['src/logo.png'], 'png is in the bundle (tagged as a resource)')
    t.assert.ok(decoded.sources['.'].files['src/icon.svg'], 'svg is in the bundle (tagged as a resource)')
    t.assert.equal(decoded.formats['src/icon.svg'], 'resource')
    t.assert.equal(decoded.formats['src/logo.png'], 'resource:base64')
  }))

  test('file-loader frozen run passes against committed asset hashes and rejects a tampered asset', withTmp(async (t, tmp) => {
    cpSync(assetsFixture, tmp, { recursive: true })  // ships a committed lockfile with png/svg
    const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8')

    let r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { STASIS_TEST_ESBUILD_LOADER: FILE_LOADER, ...withOpts({ lock: 'frozen', resources: ['png', 'svg'] }) },
    })
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf-8'), before, 'frozen must not rewrite')

    // tamper the svg, frozen must reject
    writeFileSync(join(tmp, 'src', 'icon.svg'), '<svg>tampered</svg>\n')
    r = await run(['src/entry.js'], {
      cwd: tmp,
      env: { STASIS_TEST_ESBUILD_LOADER: FILE_LOADER, ...withOpts({ lock: 'frozen', resources: ['png', 'svg'] }) },
    })
    t.assert.notEqual(r.status, 0, `expected frozen rejection; stderr=${r.stderr}`)
    t.assert.match(r.stderr, /Build failed|ERR_ASSERTION|sha512-/)
  }))

  // Regression: a RESOURCE import (`import logo from './logo.png'` under esbuild's file
  // loader) must round-trip under bundle=load from a clean dir, exactly like a code
  // import. Two capture-side gaps used to break this: (1) the resolve hook recorded an
  // import edge only for kind==='code', so the asset edge was absent from the bundle and
  // load-mode onResolve couldn't map './logo.png' to its bundled path (it deferred to
  // esbuild's disk resolver, which fails in a clean dir); and (2) load-mode onLoad returned
  // the asset `contents` with no `loader`, so esbuild parsed the bytes as JS instead of
  // replaying the configured file loader. With both fixed the load output is byte-identical
  // to the capture output.
  test('bundle=load round-trips resource imports (png/svg) from a clean dir', withTmp(async (t, tmp) => {
    // Phase 1: capture in a full-fixture dir (sources + config), writing a bundle.
    const capDir = join(tmp, 'cap')
    cpSync(assetsFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'), { force: true })
    const capBundle = join(capDir, 'snapshot.br')
    const outA = join(tmp, 'out-capture')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        STASIS_TEST_ESBUILD_LOADER: FILE_LOADER,
        STASIS_TEST_ESBUILD_OUTDIR: outA,
        ...withOpts({ lock: 'add', bundle: 'add', bundleFile: capBundle, resources: ['png', 'svg'] }),
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(outA, 'entry.js'), 'utf-8')

    // The bundle must carry the resource edges (this is the fix): without them the clean-dir
    // load below can't resolve './logo.png' / './icon.svg'.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    t.assert.equal(decoded.imports['*']['src/entry.js']['./logo.png'], 'src/logo.png', 'png edge recorded')
    t.assert.equal(decoded.imports['*']['src/entry.js']['./icon.svg'], 'src/icon.svg', 'svg edge recorded')

    // Phase 2: clean load dir holding only the bundle + a minimal package.json. NO sources on
    // disk, so serving the assets from the bundle is the only path to a build.
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')
    t.assert.ok(!existsSync(join(loadDir, 'src')), 'load dir must not contain src/')

    const outB = join(tmp, 'out-load')
    const replay = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        STASIS_TEST_ESBUILD_LOADER: FILE_LOADER,
        STASIS_TEST_ESBUILD_OUTDIR: outB,
        ...withOpts({ lock: 'none', bundle: 'load', bundleFile: join(loadDir, 'snapshot.br'), resources: ['png', 'svg'] }),
      },
    })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(outB, 'entry.js'), 'utf-8')

    // Byte-identical round-trip: esbuild's file loader hashes the asset bytes into the emitted
    // filename, so the load run (fed bundle bytes) must produce the same output as capture (fed
    // disk bytes). If the loader replay were wrong the asset filename -- and thus this JS -- would differ.
    t.assert.equal(replayOutput, captureOutput)
  }))

  // Regression (integrity, resource counterpart of the missing-code-file test above): with
  // the resource edge now recorded, a resource whose BYTES were dropped from the bundle must
  // fail closed at bundle=load -- it must NOT silently fall through to the asset still sitting
  // on disk. Before the edge was recorded, load mode deferred every asset import to esbuild's
  // disk resolver, reading it unattested; recording the edge routes it through onLoad's getFile
  // gate, which throws when the bundle doesn't carry the bytes.
  test('bundle=load fails closed when a resource\'s bytes are dropped from the bundle (no silent disk fallback)', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(assetsFixture, capDir, { recursive: true })
    rmSync(join(capDir, 'stasis.lock.json'), { force: true })
    const capBundle = join(capDir, 'snapshot.br')

    const capture = await run(['src/entry.js'], {
      cwd: capDir,
      env: {
        STASIS_TEST_ESBUILD_LOADER: FILE_LOADER,
        STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-capture'),
        ...withOpts({ lock: 'add', bundle: 'add', bundleFile: capBundle, resources: ['png', 'svg'] }),
      },
    })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    // Drop the png BYTES from the bundle but keep its edge + format tag: onResolve still maps
    // './logo.png' to src/logo.png, so onLoad's getFile is the fail-closed gate.
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    delete decoded.sources['.'].files['src/logo.png']
    writeFileSync(capBundle, brotliCompressSync(JSON.stringify(decoded)))

    // Load dir keeps the FULL source tree on disk (asset present), so a silent disk fallback
    // would succeed -- the point is that it must not.
    const loadDir = join(tmp, 'load')
    cpSync(capDir, loadDir, { recursive: true })
    copyFileSync(capBundle, join(loadDir, 'snapshot.br'))
    rmSync(join(loadDir, 'stasis.lock.json'), { force: true })

    const r = await run(['src/entry.js'], {
      cwd: loadDir,
      env: {
        STASIS_TEST_ESBUILD_LOADER: FILE_LOADER,
        STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-load'),
        ...withOpts({ lock: 'none', bundle: 'load', bundleFile: join(loadDir, 'snapshot.br'), resources: ['png', 'svg'] }),
      },
    })
    t.assert.notEqual(r.status, 0, 'load must fail when a resource\'s bytes are missing from the bundle')
    t.assert.match(r.stderr, /logo\.png/)
  }))

  // ----- Resolution parity: imports esbuild fails or disables --------------------------
  //
  // The plugin re-resolves every import with build.resolve(). Two results of that API must go back
  // to esbuild rather than be returned: a failure (esbuild tolerates one inside try/catch) and an
  // import a `browser` field maps to `false` (the API drops esbuild's "disabled" flag). Each test
  // pins the capture output byte-for-byte to a build without the plugin (STASIS_TEST_ESBUILD_PLAIN).
  // The entries are .mjs, which esbuild types by extension: a plugin-resolved .js loses its package.json
  // `type`, which the section at the end covers.

  const plainBuild = (cwd, outdir, env = {}) => run(['src/entry.mjs'], {
    cwd,
    env: { STASIS_TEST_PRELOAD: '0', STASIS_TEST_ESBUILD_PLAIN: '1', STASIS_TEST_ESBUILD_OUTDIR: outdir, ...env },
  })
  const captureEnv = (bundleFile, outdir, env = {}) => ({
    EXODUS_STASIS_LOCK: 'add',
    EXODUS_STASIS_SCOPE: 'full',
    EXODUS_STASIS_BUNDLE: 'add',
    EXODUS_STASIS_BUNDLE_FILE: bundleFile,
    STASIS_TEST_ESBUILD_OUTDIR: outdir,
    ...env,
  })
  // A load-side dir holding only the bundle + a minimal package.json (see the clean-dir test above).
  const cleanLoadDir = (tmp, bundleFile) => {
    const loadDir = join(tmp, 'load')
    mkdirSync(loadDir)
    copyFileSync(bundleFile, join(loadDir, 'snapshot.br'))
    writeFileSync(join(loadDir, 'package.json'), '{ "name": "stasis-load", "version": "0.0.0", "private": true, "type": "module" }')
    return loadDir
  }
  const loadEnv = (loadDir, outdir, env = {}) => ({
    EXODUS_STASIS_LOCK: 'none',
    EXODUS_STASIS_SCOPE: 'full',
    EXODUS_STASIS_BUNDLE: 'load',
    EXODUS_STASIS_BUNDLE_FILE: join(loadDir, 'snapshot.br'),
    STASIS_TEST_ESBUILD_OUTDIR: outdir,
    ...env,
  })
  const BROWSER = { STASIS_TEST_ESBUILD_PLATFORM: 'browser' }

  // debug@4's src/node.js does `try { require('supports-color') } catch {}`; esbuild leaves an
  // unresolvable require() in a try/catch as is. Returning build.resolve()'s errors failed the build
  // with `Could not resolve "supports-color"`; declining lets esbuild tolerate it, with no edge.
  test('a require() esbuild cannot resolve inside try/catch is tolerated as without the plugin (no edge)', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(optionalRequireFixture, capDir, { recursive: true })
    const plain = await plainBuild(capDir, join(tmp, 'out-plain'))
    t.assert.equal(plain.status, 0, `plain stderr: ${plain.stderr}`)

    const capBundle = join(capDir, 'snapshot.br')
    const capture = await run(['src/entry.mjs'], { cwd: capDir, env: captureEnv(capBundle, join(tmp, 'out-capture')) })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(tmp, 'out-capture', 'entry.js'), 'utf-8')
    t.assert.equal(captureOutput, readFileSync(join(tmp, 'out-plain', 'entry.js'), 'utf-8'))
    t.assert.match(captureOutput, /require\("supports-color"\)/, 'the miss stays a runtime require, as esbuild leaves it')

    const lock = JSON.parse(readFileSync(join(capDir, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepStrictEqual(lock.imports['*']['node_modules/fake-debug/src/node.js'], undefined, 'no edge for the miss')
    t.assert.equal(lock.imports['*']['src/entry.mjs']['fake-debug'], 'node_modules/fake-debug/src/node.js')

    // Load mode has no edge to serve either, so esbuild tolerates the same miss there.
    const loadDir = cleanLoadDir(tmp, capBundle)
    const replay = await run(['src/entry.mjs'], { cwd: loadDir, env: loadEnv(loadDir, join(tmp, 'out-load')) })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'out-load', 'entry.js'), 'utf-8'), captureOutput)
  }))

  // browser-map's package.json maps ./lib/server.js, fs and the installed node-only package to
  // `false`. build.resolve() returns the bare `fs` with no namespace (esbuild: "returned a
  // non-absolute path: fs") and the two files as plain paths (bundled for real). Declining lets
  // esbuild emit its own empty `(disabled):` modules.
  test('platform=browser: imports a `browser` field maps to false are disabled as without the plugin, never bundled or attested', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(browserMapFixture, capDir, { recursive: true })
    const plain = await plainBuild(capDir, join(tmp, 'out-plain'), BROWSER)
    t.assert.equal(plain.status, 0, `plain stderr: ${plain.stderr}`)

    const capBundle = join(capDir, 'snapshot.br')
    const capture = await run(['src/entry.mjs'], { cwd: capDir, env: captureEnv(capBundle, join(tmp, 'out-capture'), BROWSER) })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(tmp, 'out-capture', 'entry.js'), 'utf-8')
    t.assert.equal(captureOutput, readFileSync(join(tmp, 'out-plain', 'entry.js'), 'utf-8'))
    t.assert.match(captureOutput, /\(disabled\):node_modules\/browser-map\/lib\/server\.js/)
    t.assert.match(captureOutput, /\(disabled\):fs/)
    t.assert.match(captureOutput, /\(disabled\):node_modules\/node-only\/index\.js/)
    t.assert.doesNotMatch(captureOutput, /SERVER-ONLY-CODE|NODE-ONLY-CODE/)

    // Every disabled edge points at the one attested empty module; the real files are never attested.
    const lock = JSON.parse(readFileSync(join(capDir, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepStrictEqual(lock.imports['*']['node_modules/browser-map/index.js'], {
      './lib/server.js': '.stasis/empty-module.js',
      './lib/shared.js': 'node_modules/browser-map/lib/shared.js',
      fs: '.stasis/empty-module.js',
      'node-only': '.stasis/empty-module.js',
    })
    t.assert.deepStrictEqual(Object.keys(lock.modules['node_modules/browser-map'].files).toSorted(), ['index.js', 'lib/shared.js'])
    t.assert.equal(lock.modules['node_modules/node-only'], undefined)
    t.assert.ok(lock.sources['.'].files['.stasis/empty-module.js'].startsWith('sha512-'))
    t.assert.equal(lock.formats['.stasis/empty-module.js'], 'commonjs')
    const decoded = JSON.parse(brotliDecompressSync(readFileSync(capBundle)))
    t.assert.equal(decoded.sources['.'].files['.stasis/empty-module.js'], '')

    // The recorded edges replay: a frozen re-capture attests the same graph.
    const frozen = await run(['src/entry.mjs'], {
      cwd: capDir,
      env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full', STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-frozen'), ...BROWSER },
    })
    t.assert.equal(frozen.status, 0, `frozen stderr: ${frozen.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'out-frozen', 'entry.js'), 'utf-8'), captureOutput)
  }))

  // Load mode resolves the disabled edges through the bundle to the empty module, which it serves
  // from the bundle like any file: no package.json or browser map on disk is needed. It renders as
  // one `.stasis/empty-module.js` module rather than esbuild's per-import `(disabled):` ones, so the
  // bytes differ from capture's; what the bundle evaluates to doesn't.
  test('platform=browser: bundle=load serves the empty module for disabled imports from a clean dir', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(browserMapFixture, capDir, { recursive: true })
    const capBundle = join(capDir, 'snapshot.br')
    const capture = await run(['src/entry.mjs'], { cwd: capDir, env: captureEnv(capBundle, join(tmp, 'out-capture'), BROWSER) })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)

    const loadDir = cleanLoadDir(tmp, capBundle)
    const replay = await run(['src/entry.mjs'], { cwd: loadDir, env: loadEnv(loadDir, join(tmp, 'out-load'), BROWSER) })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    const replayOutput = readFileSync(join(tmp, 'out-load', 'entry.js'), 'utf-8')
    t.assert.match(replayOutput, /"\.stasis\/empty-module\.js"\(\) \{/)
    t.assert.doesNotMatch(replayOutput, /SERVER-ONLY-CODE|NODE-ONLY-CODE/)

    const ranCapture = await runNode([join(tmp, 'out-capture', 'entry.js')], { cwd: tmp })
    const ranReplay = await runNode([join(tmp, 'out-load', 'entry.js')], { cwd: tmp })
    t.assert.equal(ranCapture.status, 0, `capture output stderr: ${ranCapture.stderr}`)
    t.assert.equal(ranReplay.status, 0, `replay output stderr: ${ranReplay.stderr}`)
    t.assert.equal(ranCapture.stdout, '{"server":{},"fs":{},"nodeOnly":{},"shared":"shared"}\n')
    t.assert.equal(ranReplay.stdout, ranCapture.stdout)
  }))

  // esbuild gives a disabled module its `empty` loader, the one a CSS @import, `composes` or url()
  // accepts. Load mode serves the shared empty module with it too, so a CSS importer replays:
  // under the `js` loader esbuild rejects it (`Cannot import ".stasis/empty-module.js" into a CSS file`).
  test('platform=browser: disabled CSS @import and url() replay at bundle=load', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(browserMapFixture, capDir, { recursive: true })
    const pkg = join(capDir, 'node_modules', 'css-map')
    mkdirSync(pkg)
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'css-map', version: '1.0.0', main: './index.js', browser: { './server.css': false, './server.png': false } }))
    writeFileSync(join(pkg, 'index.js'), "require('./style.css')\n")
    writeFileSync(join(pkg, 'style.css'), '@import "./server.css";\n.a { color: red; background: url(./server.png) }\n')
    writeFileSync(join(pkg, 'server.css'), '.server-only { color: blue }\n')
    writeFileSync(join(pkg, 'server.png'), 'PNG')
    writeFileSync(join(capDir, 'src', 'entry.mjs'), "import 'css-map'\n")
    const css = {
      ...BROWSER,
      STASIS_TEST_ESBUILD_LOADER: JSON.stringify({ '.css': 'css', '.png': 'file' }),
      STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ resources: ['css', 'png'] }),
    }

    const plain = await plainBuild(capDir, join(tmp, 'out-plain'), css)
    t.assert.equal(plain.status, 0, `plain stderr: ${plain.stderr}`)
    const capBundle = join(capDir, 'snapshot.br')
    const capture = await run(['src/entry.mjs'], { cwd: capDir, env: captureEnv(capBundle, join(tmp, 'out-capture'), css) })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureCss = readFileSync(join(tmp, 'out-capture', 'entry.css'), 'utf-8')
    t.assert.equal(captureCss, readFileSync(join(tmp, 'out-plain', 'entry.css'), 'utf-8'))
    t.assert.doesNotMatch(captureCss, /server-only/)

    const lock = JSON.parse(readFileSync(join(capDir, 'stasis.lock.json'), 'utf-8'))
    t.assert.deepStrictEqual(lock.imports['*']['node_modules/css-map/style.css'], {
      './server.css': '.stasis/empty-module.js',
      './server.png': '.stasis/empty-module.js',
    })

    const loadDir = cleanLoadDir(tmp, capBundle)
    const replay = await run(['src/entry.mjs'], { cwd: loadDir, env: loadEnv(loadDir, join(tmp, 'out-load'), css) })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'out-load', 'entry.css'), 'utf-8'), captureCss)
  }))

  // `browser` maps apply only under platform:'browser': on node the same package bundles the real
  // files and externalizes fs, and the plugin must attest them as usual.
  test('platform=node: `browser` field maps stay inert, as without the plugin', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    cpSync(browserMapFixture, capDir, { recursive: true })
    const plain = await plainBuild(capDir, join(tmp, 'out-plain'))
    t.assert.equal(plain.status, 0, `plain stderr: ${plain.stderr}`)

    const capture = await run(['src/entry.mjs'], { cwd: capDir, env: captureEnv(join(capDir, 'snapshot.br'), join(tmp, 'out-capture')) })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    const captureOutput = readFileSync(join(tmp, 'out-capture', 'entry.js'), 'utf-8')
    t.assert.equal(captureOutput, readFileSync(join(tmp, 'out-plain', 'entry.js'), 'utf-8'))
    t.assert.match(captureOutput, /SERVER-ONLY-CODE/)

    const lock = JSON.parse(readFileSync(join(capDir, 'stasis.lock.json'), 'utf-8'))
    t.assert.equal(lock.imports['*']['node_modules/browser-map/index.js']['./lib/server.js'], 'node_modules/browser-map/lib/server.js')
    t.assert.ok(lock.modules['node_modules/node-only'].files['index.js'].startsWith('sha512-'))
    t.assert.equal(lock.sources['.'].files['.stasis/empty-module.js'], undefined)
  }))

  test('a disabled import refuses a real file at the reserved empty-module path', withTmp(async (t, tmp) => {
    cpSync(browserMapFixture, tmp, { recursive: true })
    mkdirSync(join(tmp, '.stasis'))
    writeFileSync(join(tmp, '.stasis', 'empty-module.js'), "module.exports = 'REAL'\n")

    const r = await run(['src/entry.mjs'], { cwd: tmp, env: captureEnv(join(tmp, 'snapshot.br'), join(tmp, 'out'), BROWSER) })
    t.assert.notEqual(r.status, 0, `expected build failure; stderr=${r.stderr}`)
    t.assert.match(r.stderr, /reserved path \.stasis\/empty-module\.js/)
  }))

  // ----- package.json `type`: build as plain esbuild does, or refuse ------------------------
  //
  // esbuild takes a .js file's module type from its package.json `type` only when its own resolver
  // loaded the file; the plugin serves every file, so esbuild never sees one. Where that changes the
  // build -- here Node's default-import interop in a "type": "module" package -- capture and load must
  // refuse; otherwise they must match a build without the plugin.

  const TYPE_MODULE = '{ "name": "interop-app", "version": "0.0.0", "private": true, "type": "module" }'
  const BABELISH = "exports.__esModule = true\nexports.default = 'the-default'\n"
  const interopProject = (dir, entry) => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), TYPE_MODULE)
    writeFileSync(join(dir, 'src', 'babelish.cjs'), BABELISH)
    writeFileSync(join(dir, 'src', entry), "import x from './babelish.cjs'\nconsole.log(JSON.stringify(x))\n")
  }

  test('capture refuses a "type": "module" default import of a CommonJS module marked __esModule, writing nothing', withTmp(async (t, tmp) => {
    interopProject(tmp, 'entry.js')
    const plain = await run(['src/entry.js'], {
      cwd: tmp,
      env: { STASIS_TEST_PRELOAD: '0', STASIS_TEST_ESBUILD_PLAIN: '1', STASIS_TEST_ESBUILD_OUTDIR: join(tmp, 'out-plain') },
    })
    t.assert.equal(plain.status, 0, `plain stderr: ${plain.stderr}`)
    t.assert.match(readFileSync(join(tmp, 'out-plain', 'entry.js'), 'utf-8'), /__toESM\(require_babelish\(\), 1\)/)

    const capBundle = join(tmp, 'snapshot.br')
    const capture = await run(['src/entry.js'], { cwd: tmp, env: captureEnv(capBundle, join(tmp, 'out-capture')) })
    t.assert.notEqual(capture.status, 0)
    t.assert.match(capture.stderr, /refusing to build 'src\/entry\.js': it imports the default export or namespace of '\.\/babelish\.cjs'/)
    t.assert.equal(existsSync(capBundle), false, 'no bundle is written')
  }))

  test('capture and load of a .mjs importer (typed by extension) match a build without the plugin', withTmp(async (t, tmp) => {
    const capDir = join(tmp, 'cap')
    interopProject(capDir, 'entry.mjs')
    const plain = await plainBuild(capDir, join(tmp, 'out-plain'))
    t.assert.equal(plain.status, 0, `plain stderr: ${plain.stderr}`)
    const plainOutput = readFileSync(join(tmp, 'out-plain', 'entry.js'), 'utf-8')

    const capBundle = join(capDir, 'snapshot.br')
    const capture = await run(['src/entry.mjs'], { cwd: capDir, env: captureEnv(capBundle, join(tmp, 'out-capture')) })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'out-capture', 'entry.js'), 'utf-8'), plainOutput)

    const loadDir = cleanLoadDir(tmp, capBundle)
    const replay = await run(['src/entry.mjs'], { cwd: loadDir, env: loadEnv(loadDir, join(tmp, 'out-load')) })
    t.assert.equal(replay.status, 0, `replay stderr: ${replay.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'out-load', 'entry.js'), 'utf-8'), plainOutput)
  }))

  test('capture refuses a "type": "module" default import of an external built to cjs, and matches plain esbuild otherwise', withTmp(async (t, tmp) => {
    // An external stays a runtime require() in a cjs output, and that require gets the importer's interop:
    // whether the exports carry __esModule only the runtime knows.
    mkdirSync(join(tmp, 'src'), { recursive: true })
    mkdirSync(join(tmp, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(tmp, 'package.json'), TYPE_MODULE)
    writeFileSync(join(tmp, 'node_modules', 'dep', 'package.json'), '{ "name": "dep", "version": "1.0.0", "main": "index.js" }')
    writeFileSync(join(tmp, 'node_modules', 'dep', 'index.js'), BABELISH)
    writeFileSync(join(tmp, 'src', 'entry.js'), "import x from 'dep'\nconsole.log(JSON.stringify(x))\n")
    writeFileSync(join(tmp, 'src', 'chain.js'), "import x from './reexport.cjs'\nconsole.log(JSON.stringify(x))\n")
    writeFileSync(join(tmp, 'src', 'reexport.cjs'), "module.exports = require('dep')\n")
    const external = { STASIS_TEST_ESBUILD_EXTERNAL: '["dep"]', EXODUS_STASIS_LOCK: 'none' }
    const cjs = { ...external, STASIS_TEST_ESBUILD_FORMAT: 'cjs' }
    const plain = (entry, outdir, env) => run([entry], {
      cwd: tmp,
      env: { STASIS_TEST_PRELOAD: '0', STASIS_TEST_ESBUILD_PLAIN: '1', STASIS_TEST_ESBUILD_OUTDIR: join(tmp, outdir), ...env },
    })

    const capture = await run(['src/entry.js'], { cwd: tmp, env: captureEnv(join(tmp, 'cjs.br'), join(tmp, 'out-cjs'), cjs) })
    t.assert.notEqual(capture.status, 0)
    t.assert.match(capture.stderr, /refusing to build 'src\/entry\.js': it imports the default export or namespace of 'dep', an external this build turns into a require\(\)/)
    // Re-exported by a bundled CommonJS file, the external's exports are as unknown.
    const chain = await run(['src/chain.js'], { cwd: tmp, env: captureEnv(join(tmp, 'chain.br'), join(tmp, 'out-chain'), cjs) })
    t.assert.notEqual(chain.status, 0)
    t.assert.match(chain.stderr, /refusing to build 'src\/chain\.js': it imports the default export or namespace of '\.\/reexport\.cjs'/)

    // Built as ESM, the import stays an import for Node to resolve: the output matches a build without the plugin.
    t.assert.equal((await plain('src/entry.js', 'out-plain', external)).status, 0)
    const esm = await run(['src/entry.js'], { cwd: tmp, env: captureEnv(join(tmp, 'esm.br'), join(tmp, 'out-esm'), external) })
    t.assert.equal(esm.status, 0, `esm stderr: ${esm.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'out-esm', 'entry.js'), 'utf-8'), readFileSync(join(tmp, 'out-plain', 'entry.js'), 'utf-8'))
    // A named import gets no interop: the cjs output matches too.
    writeFileSync(join(tmp, 'src', 'entry.js'), "import { named } from 'dep'\nconsole.log(named)\n")
    t.assert.equal((await plain('src/entry.js', 'out-plain-cjs', cjs)).status, 0)
    const named = await run(['src/entry.js'], { cwd: tmp, env: captureEnv(join(tmp, 'named.br'), join(tmp, 'out-named'), cjs) })
    t.assert.equal(named.status, 0, `named stderr: ${named.stderr}`)
    t.assert.equal(readFileSync(join(tmp, 'out-named', 'entry.js'), 'utf-8'), readFileSync(join(tmp, 'out-plain-cjs', 'entry.js'), 'utf-8'))
  }))

  test('capture refuses a "type": "module" default import of a re-export esbuild leaves for runtime (an optional require)', withTmp(async (t, tmp) => {
    // esbuild tolerates the unresolvable require in a try/catch, and whatever the runtime loads there gets the
    // importer's interop.
    mkdirSync(join(tmp, 'src'), { recursive: true })
    writeFileSync(join(tmp, 'package.json'), TYPE_MODULE)
    writeFileSync(join(tmp, 'src', 'optional.cjs'), "try { module.exports = require('optional-dep') } catch { module.exports = {} }\n")
    writeFileSync(join(tmp, 'src', 'entry.js'), "import x from './optional.cjs'\nconsole.log(JSON.stringify(x))\n")
    const capture = await run(['src/entry.js'], { cwd: tmp, env: captureEnv(join(tmp, 'snapshot.br'), join(tmp, 'out'), { EXODUS_STASIS_LOCK: 'none' }) })
    t.assert.notEqual(capture.status, 0)
    t.assert.match(capture.stderr, /refusing to build 'src\/entry\.js': it imports the default export or namespace of '\.\/optional\.cjs'/)
  }))

  test('capture follows a re-export to JSON, whose object can carry __esModule', withTmp(async (t, tmp) => {
    mkdirSync(join(tmp, 'src'), { recursive: true })
    writeFileSync(join(tmp, 'package.json'), TYPE_MODULE)
    writeFileSync(join(tmp, 'src', 'marked.json'), '{ "__esModule": true, "default": "value" }')
    writeFileSync(join(tmp, 'src', 'plain.json'), '{ "default": "value" }')
    writeFileSync(join(tmp, 'src', 'marked.cjs'), "module.exports = require('./marked.json')\n")
    writeFileSync(join(tmp, 'src', 'plain.cjs'), "module.exports = require('./plain.json')\n")
    writeFileSync(join(tmp, 'src', 'entry.js'), "import x from './marked.cjs'\nconsole.log(JSON.stringify(x))\n")
    const env = { EXODUS_STASIS_LOCK: 'none' }
    const marked = await run(['src/entry.js'], { cwd: tmp, env: captureEnv(join(tmp, 'marked.br'), join(tmp, 'out-marked'), env) })
    t.assert.notEqual(marked.status, 0)
    t.assert.match(marked.stderr, /refusing to build 'src\/entry\.js': it imports the default export or namespace of '\.\/marked\.cjs'/)
    writeFileSync(join(tmp, 'src', 'entry.js'), "import x from './plain.cjs'\nconsole.log(JSON.stringify(x))\n")
    const plain = await run(['src/entry.js'], { cwd: tmp, env: captureEnv(join(tmp, 'plain.br'), join(tmp, 'out-plain'), env) })
    t.assert.equal(plain.status, 0, `plain stderr: ${plain.stderr}`)
  }))

  test('capture does not follow a re-export to a file the browser map disables: the build serves the empty module', withTmp(async (t, tmp) => {
    mkdirSync(join(tmp, 'src'), { recursive: true })
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ ...JSON.parse(TYPE_MODULE), browser: { './src/babelish.cjs': false } }))
    writeFileSync(join(tmp, 'src', 'babelish.cjs'), BABELISH)
    writeFileSync(join(tmp, 'src', 'reexport.cjs'), "module.exports = require('./babelish.cjs')\n")
    writeFileSync(join(tmp, 'src', 'entry.js'), "import x from './reexport.cjs'\nconsole.log(JSON.stringify(x))\n")
    const capture = await run(['src/entry.js'], { cwd: tmp, env: captureEnv(join(tmp, 'snapshot.br'), join(tmp, 'out'), { ...BROWSER, EXODUS_STASIS_LOCK: 'none' }) })
    t.assert.equal(capture.status, 0, `capture stderr: ${capture.stderr}`)
  }))

  test('load refuses a bundle whose "type": "module" importer default-imports a CommonJS module marked __esModule', withTmp(async (t, tmp) => {
    // As `stasis bundle` records it: Node's formats, the importer 'module'.
    const bundle = {
      version: 1,
      config: { scope: 'full' },
      entries: ['src/entry.js'],
      sources: {
        '.': {
          name: 'stasis-load',
          version: '0.0.0',
          files: { 'src/entry.js': "import x from './babelish.cjs'\nconsole.log(JSON.stringify(x))\n", 'src/babelish.cjs': BABELISH },
        },
      },
      formats: { 'src/entry.js': 'module', 'src/babelish.cjs': 'commonjs' },
      imports: { '*': { 'src/entry.js': { './babelish.cjs': 'src/babelish.cjs' } } },
    }
    const bundleFile = join(tmp, 'app.br')
    writeFileSync(bundleFile, brotliCompressSync(JSON.stringify(bundle)))
    const loadDir = cleanLoadDir(tmp, bundleFile)
    const replay = await run(['src/entry.js'], { cwd: loadDir, env: loadEnv(loadDir, join(tmp, 'out-load')) })
    t.assert.notEqual(replay.status, 0)
    t.assert.match(replay.stderr, /refusing to build 'src\/entry\.js': it imports the default export or namespace of '\.\/babelish\.cjs'/)
  }))
})
