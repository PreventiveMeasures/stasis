import { test } from 'node:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { diffArtifacts } from '../stasis/src/diff.js'
import { patchIntegrity } from '../stasis/src/installed.js'
import { withTmp } from './tmp.helper.js'

// Every place a dependency record's `integrity` and `patch` meet an anchor -- the package manager's
// lockfile, an existing stasis.lock.json, what is installed -- each holds them to it, or refuses.

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const SRI = `sha512-${'A'.repeat(86)}==`
const OTHER = `sha512-${'B'.repeat(85)}A==`
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// An npm project in `dir` requiring `reg`, installed as npm lays it out, its hidden lockfile and
// package-lock.json locking it with `integrity` (null for none), each where asked, and there alone.
function npmProject(dir, { hidden = true, packageLock = true, integrity = SRI } = {}) {
  writeJson(join(dir, 'package.json'), { name: 'app', version: '1.0.0' })
  writeFileSync(join(dir, 'index.js'), "require('reg')\n")
  mkdirSync(join(dir, 'node_modules', 'reg'), { recursive: true })
  writeJson(join(dir, 'node_modules', 'reg', 'package.json'), { name: 'reg', version: '1.0.0' })
  writeFileSync(join(dir, 'node_modules', 'reg', 'index.js'), 'module.exports = 1\n')
  const lock = { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { 'node_modules/reg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/reg/-/reg-1.0.0.tgz', ...(integrity && { integrity }) } } }
  for (const [file, written] of [[join(dir, 'node_modules', '.package-lock.json'), hidden], [join(dir, 'package-lock.json'), packageLock]]) {
    if (written) writeJson(file, lock)
    else rmSync(file, { force: true })
  }
}
// A patch's integrity, as a record names the one pnpm installed its package with.
const PATCHED = { integrity: patchIntegrity('a'.repeat(64)) }
// stasis.lock.json's record of `reg`, edited.
function editLock(dir, edit) {
  const lock = readJson(join(dir, 'stasis.lock.json'))
  edit(lock.modules['node_modules/reg'])
  writeJson(join(dir, 'stasis.lock.json'), lock)
}
const build = (dir, options = {}) => bundleCommand({ cwd: dir, entries: ['index.js'], output: 'out.br', ...options })
const recordOf = (dir, at = 'node_modules/reg', file = 'out.br') => JSON.parse(brotliDecompressSync(readFileSync(join(dir, file))).toString('utf8')).modules[at]

// stasis bundle and an existing stasis.lock.json.

test('stasis bundle holds its records to the stasis.lock.json present, in lock = add: neither ignored nor overwritten', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const written = readFileSync(lockPath, 'utf8')
  writeFileSync(lockPath, written.replace(SRI, OTHER))
  await t.assert.rejects(build(dir), /stasis\.lock\.json: module 'node_modules\/reg' integrity mismatch/u, 'without --lockfile: read all the same')
  await t.assert.rejects(build(dir, { lockfile: 'stasis.lock.json' }), /stasis\.lock\.json: module 'node_modules\/reg' integrity mismatch/u, 'with it: not overwritten')
  t.assert.ok(readFileSync(lockPath, 'utf8').includes(OTHER), 'left as it was')
  // A file it attests otherwise, too.
  const lock = readJson(lockPath)
  lock.modules['node_modules/reg'].integrity = SRI
  lock.modules['node_modules/reg'].files['index.js'] = SRI
  writeJson(lockPath, lock)
  await t.assert.rejects(build(dir), /content mismatch for 'node_modules\/reg\/index\.js'/u)
}))

test('stasis bundle in lock = ignore leaves stasis.lock.json alone, in lock = replace rewrites it', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const edited = readFileSync(lockPath, 'utf8').replace(SRI, OTHER)
  writeFileSync(lockPath, edited)
  await build(dir, { env: { ...process.env, EXODUS_STASIS_LOCK: 'ignore' } })
  t.assert.equal(readFileSync(lockPath, 'utf8'), edited)
  await build(dir, { lockfile: 'stasis.lock.json', env: { ...process.env, EXODUS_STASIS_LOCK: 'replace' } })
  t.assert.equal(readJson(lockPath).modules['node_modules/reg'].integrity, SRI)
}))

test('stasis bundle in lock = frozen holds its records to stasis.lock.json too', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const frozen = { env: { ...process.env, EXODUS_STASIS_LOCK: 'frozen' } }
  await build(dir, frozen)
  writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace(SRI, OTHER))
  await t.assert.rejects(build(dir, frozen), /stasis\.lock\.json: module 'node_modules\/reg' integrity mismatch/u)
}))

// What stasis.lock.json alone records of a package: held to the account of how it was installed, the
// install's record's, else the lockfile's beside it; one the account has none of is refused, never
// dropped. With no account, it is kept, the build's too.

test('stasis bundle refuses an integrity or patch stasis.lock.json records that the install\'s record names none of, rather than drop it', withTmp(async (t, dir) => {
  const frozen = { env: { ...process.env, EXODUS_STASIS_LOCK: 'frozen' } }
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  // A patch, which npm's record of the install names none of.
  const written = readFileSync(lockPath, 'utf8')
  editLock(dir, (record) => { record.patch = PATCHED })
  const patch = /stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs installed\) patch mismatch \(\{"integrity":"sha256-[^"]+"\} vs none\)/u
  await t.assert.rejects(build(dir), patch, 'add')
  await t.assert.rejects(build(dir, frozen), patch, 'frozen')
  await t.assert.rejects(build(dir, { lockfile: 'stasis.lock.json' }), patch, 'add, to be written')
  t.assert.deepStrictEqual(readJson(lockPath).modules['node_modules/reg'].patch, PATCHED, 'left as it was')
  await build(dir, { env: { ...process.env, EXODUS_STASIS_LOCK: 'ignore' } })
  // An integrity, the install's records naming none now.
  writeFileSync(lockPath, written)
  npmProject(dir, { integrity: null })
  const integrity = /stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch \("sha512-A+==" vs none\)/u
  await t.assert.rejects(build(dir), integrity, 'add')
  await t.assert.rejects(build(dir, frozen), integrity, 'frozen')
  await t.assert.rejects(build(dir, { lockfile: 'stasis.lock.json' }), integrity, 'add, to be written')
  t.assert.equal(readFileSync(lockPath, 'utf8'), written, 'left as it was')
  await build(dir, { lockfile: 'stasis.lock.json', env: { ...process.env, EXODUS_STASIS_LOCK: 'replace' } })
  t.assert.equal(readJson(lockPath).modules['node_modules/reg'].integrity, undefined, 'replaced: rewritten of what is installed')
}))

test('stasis bundle holds what stasis.lock.json records to the lockfile beside a package no install record tells of, and keeps it where nothing tells', withTmp(async (t, dir) => {
  const frozen = { env: { ...process.env, EXODUS_STASIS_LOCK: 'frozen' } }
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const kept = () => [readJson(lockPath).modules['node_modules/reg'].integrity, recordOf(dir).integrity]
  // package-lock.json locks it so: kept, the bundle's and the rewritten lockfile's.
  npmProject(dir, { hidden: false })
  await build(dir, { lockfile: 'stasis.lock.json' })
  t.assert.deepStrictEqual(kept(), [SRI, SRI])
  // It locks another, or none.
  for (const integrity of [OTHER, null]) {
    npmProject(dir, { hidden: false, integrity })
    // eslint-disable-next-line no-await-in-loop -- one case at a time
    for (const options of [{}, frozen]) await t.assert.rejects(build(dir, options), /stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs locked\) integrity mismatch/u, String(integrity))
  }
  // Nothing tells how it was installed: neither dropped nor replaced, its files held by their hashes.
  npmProject(dir, { hidden: false, packageLock: false })
  await build(dir, { lockfile: 'stasis.lock.json' })
  t.assert.deepStrictEqual(kept(), [SRI, SRI], 'add')
  await build(dir, frozen)
  t.assert.deepStrictEqual(kept(), [SRI, SRI], 'frozen')
  editLock(dir, (record) => { record.patch = PATCHED })
  await build(dir)
  t.assert.deepStrictEqual(recordOf(dir).patch, PATCHED, 'its patch too')
  await build(dir, { env: { ...process.env, EXODUS_STASIS_LOCK: 'ignore' } })
  t.assert.deepStrictEqual([recordOf(dir).integrity, recordOf(dir).patch], [undefined, undefined], 'ignored: the build\'s own, which names none')
}))

test('stasis bundle --add holds what the bundle there records to how its packages are installed, and keeps what it alone records', withTmp(async (t, dir) => {
  const env = { ...process.env, EXODUS_STASIS_LOCK: 'ignore' }
  npmProject(dir)
  await build(dir, { env })
  npmProject(dir, { integrity: OTHER })
  await t.assert.rejects(build(dir, { env, add: true }), /module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch/u, 'another')
  npmProject(dir, { integrity: null })
  await t.assert.rejects(build(dir, { env, add: true }), /out\.br: module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch \("sha512-A+==" vs none\)/u, 'none')
  npmProject(dir, { hidden: false, packageLock: false })
  await build(dir, { env, add: true })
  t.assert.equal(recordOf(dir).integrity, SRI, 'kept, where nothing tells')
}))

// A Solidity bundle of npm packages.

test('a Solidity bundle\'s npm packages are pinned and held to their lockfile, as a JS bundle\'s are', withTmp(async (t, dir) => {
  cpSync(join(here, 'fixtures', 'solidity-bundle', 'with-node-modules'), dir, { recursive: true })
  const lock = (integrity) => ({ name: 'my-app', version: '0.1.0', lockfileVersion: 3, requires: true, packages: {
    'node_modules/foo': { version: '1.2.3', resolved: 'https://registry.npmjs.org/foo/-/foo-1.2.3.tgz', integrity },
    'node_modules/@oz/contracts': { version: '5.0.0', resolved: 'https://registry.npmjs.org/@oz/contracts/-/contracts-5.0.0.tgz', integrity: SRI },
  } })
  writeJson(join(dir, 'node_modules', '.package-lock.json'), lock(SRI))
  writeJson(join(dir, 'package-lock.json'), lock(SRI))
  await bundleCommand({ cwd: dir, entries: ['src/A.sol'], mappingFile: 'remappings.txt', output: 'out.br' })
  t.assert.equal(recordOf(dir, 'node_modules/foo').integrity, SRI)
  writeJson(join(dir, 'package-lock.json'), lock(OTHER))
  await t.assert.rejects(bundleCommand({ cwd: dir, entries: ['src/A.sol'], mappingFile: 'remappings.txt', output: 'out.br' }), /package-lock\.json doesn't lock node_modules\/foo as installed/u)
}))

// A run holds what stasis.lock.json and a bundle attest to what is installed.

test('stasis run holds stasis.lock.json\'s integrities to what is installed', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace(SRI, OTHER))
  const run = (mode) => spawnSync(process.execPath, [cli, 'run', `--lock=${mode}`, 'index.js'], { cwd: dir, encoding: 'utf8', env: { ...process.env, EXODUS_STASIS_LOCK: '' } })
  for (const mode of ['frozen', 'add']) {
    const result = run(mode)
    t.assert.notEqual(result.status, 0, mode)
    t.assert.match(result.stderr, /stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch/u, mode)
  }
  t.assert.equal(run('replace').status, 0, 'replaced: rewritten of what is installed')
  t.assert.equal(readJson(lockPath).modules['node_modules/reg'].integrity, SRI)
}))

test('stasis run refuses an integrity or patch its lockfile records that the install names none of, an untagged record\'s too', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const written = readFileSync(lockPath, 'utf8')
  const run = (mode) => spawnSync(process.execPath, [cli, 'run', `--lock=${mode}`, 'index.js'], { cwd: dir, encoding: 'utf8', env: { ...process.env, EXODUS_STASIS_LOCK: '' } })
  const refused = (pattern, label) => {
    for (const mode of ['frozen', 'add']) {
      const result = run(mode)
      t.assert.notEqual(result.status, 0, `${label}: ${mode}`)
      t.assert.match(result.stderr, pattern, `${label}: ${mode}`)
    }
  }
  // A patch, which npm's record names none of: installed unpatched.
  editLock(dir, (record) => { record.patch = PATCHED })
  refused(/stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs installed\) patch mismatch \(.* vs none\)/u, 'patch')
  // A record from before the `ecosystem` tag is npm's all the same.
  writeFileSync(lockPath, written)
  editLock(dir, (record) => {
    delete record.ecosystem
    record.integrity = OTHER
  })
  refused(/stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch/u, 'untagged')
  // An integrity the install's record names none of; then, with no record, the lockfile beside it.
  writeFileSync(lockPath, written)
  npmProject(dir, { integrity: null })
  refused(/\(recorded vs installed\) integrity mismatch \("sha512-A+==" vs none\)/u, 'integrity')
  npmProject(dir, { hidden: false, integrity: OTHER })
  refused(/\(recorded vs locked\) integrity mismatch/u, 'locked')
  // Nothing tells how it was installed (as where a bundle is run from): kept as recorded.
  npmProject(dir, { hidden: false, packageLock: false })
  t.assert.equal(run('frozen').status, 0)
  t.assert.equal(run('add').status, 0)
  t.assert.equal(readJson(lockPath).modules['node_modules/reg'].integrity, SRI, 'neither dropped nor replaced')
}))

// yarn 1's integrity; stasis diff.

test('a disk build of a yarn 1 install records each package\'s integrity yarn.lock names, where .yarn-integrity has it installed', withTmp(async (t, dir) => {
  npmProject(dir, { hidden: false, packageLock: false })
  writeFileSync(join(dir, 'yarn.lock'), `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\nreg@1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#${'0'.repeat(40)}"\n  integrity ${SRI}\n`)
  writeJson(join(dir, 'node_modules', '.yarn-integrity'), { systemParams: 'linux-x64-137', modulesFolders: ['node_modules'], flags: [], linkedModules: [], topLevelPatterns: ['reg@1.0.0'], lockfileEntries: { 'reg@1.0.0': `https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#${'0'.repeat(40)}` }, files: [], artifacts: {} })
  await build(dir)
  t.assert.equal(recordOf(dir).integrity, SRI)
}))

test('stasis diff tells a dependency\'s integrity and patch changing', (t) => {
  const patch = (text) => ({ integrity: `sha256-${createHash('sha256').update(text).digest('base64')}` })
  const of = (more) => new Bundle({ config: { scope: 'node_modules' }, modules: new Map([['node_modules/reg', { name: 'reg', version: '1.0.0', ecosystem: 'npm', ...more, files: { 'index.js': 'x\n' } }]]) })
  const [change] = diffArtifacts({ artifact: of({ integrity: SRI, patch: patch('a') }), kind: 'bundle' }, { artifact: of({ integrity: OTHER, patch: patch('b') }), kind: 'bundle' }, { hash: (x) => x }).modules.changed
  t.assert.deepStrictEqual([change.integrityChange, change.patchChange], [{ from: SRI, to: OTHER }, { from: patch('a'), to: patch('b') }])
})
