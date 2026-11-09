import { test } from 'node:test'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { diffArtifacts } from '../stasis/src/diff.js'
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
// package-lock.json locking it, each where asked.
function npmProject(dir, { hidden = true, packageLock = true } = {}) {
  writeJson(join(dir, 'package.json'), { name: 'app', version: '1.0.0' })
  writeFileSync(join(dir, 'index.js'), "require('reg')\n")
  mkdirSync(join(dir, 'node_modules', 'reg'), { recursive: true })
  writeJson(join(dir, 'node_modules', 'reg', 'package.json'), { name: 'reg', version: '1.0.0' })
  writeFileSync(join(dir, 'node_modules', 'reg', 'index.js'), 'module.exports = 1\n')
  const lock = { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { 'node_modules/reg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/reg/-/reg-1.0.0.tgz', integrity: SRI } } }
  if (hidden) writeJson(join(dir, 'node_modules', '.package-lock.json'), lock)
  if (packageLock) writeJson(join(dir, 'package-lock.json'), lock)
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
    t.assert.match(result.stderr, /stasis\.lock\.json: module 'node_modules\/reg' integrity mismatch \(.*installed/u, mode)
  }
  t.assert.equal(run('replace').status, 0, 'replaced: rewritten of what is installed')
  t.assert.equal(readJson(lockPath).modules['node_modules/reg'].integrity, SRI)
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
