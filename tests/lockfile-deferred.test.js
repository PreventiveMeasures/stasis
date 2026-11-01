import { test } from 'node:test'
import crypto, { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'

import { Lockfile } from '@exodus/stasis-core/lockfile'
import { State } from '@exodus/stasis-core/state'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { githubBundleCommand } from '../stasis/src/cmd/github-bundle.js'
import { buildGitHubBundle } from '../stasis/src/vfs-bundle.js'
import { fakeClient, json, lockfile } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

// A companion lockfile is built only once it is wanted: by --lockfile, or by a read of
// buildVfsBundle's (and buildGitHubBundle's) `lockfile`. A State hashes each file it adds all the
// same, its lockfile alone waiting; a build without one (--mainFields, --metro) and the files
// stasis.config.json's `extra` names are hashed only then.

const GITHUB = 'ExodusOSS/example'
const SHA = 'a'.repeat(40)

const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

// Write `files` (a path from `dir` -> its bytes) under `dir`, with their directories.
const writeTree = (dir, files) => {
  for (const [rel, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), bytes)
  }
}

// A project whose index.js reaches lib.js and logo.png, a resource whose bytes are no UTF-8 (carried
// as base64), and whose stasis.config.json's `extra` names data.txt; its pnpm-lock.yaml locks nothing.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00])
const PROJECT = {
  'package.json': json({ name: 'p', version: '1.0.0' }),
  'pnpm-lock.yaml': lockfile('.'),
  'stasis.config.json': json({ resources: ['png', 'txt'], extra: ['data.txt'] }),
  'index.js': "require('./lib.js')\nrequire('./logo.png')\n",
  'lib.js': 'module.exports = 1\n',
  'logo.png': PNG,
  'data.txt': 'extra\n',
}

// How many times a State has built its lockfile since: State#lockfile, counted until the test ends.
function stateLockfiles(t) {
  const descriptor = Object.getOwnPropertyDescriptor(State.prototype, 'lockfile')
  let built = 0
  Object.defineProperty(State.prototype, 'lockfile', { ...descriptor, get() {
    built++
    return descriptor.get.call(this)
  } })
  t.after(() => Object.defineProperty(State.prototype, 'lockfile', descriptor))
  return () => built
}

// How many sha512 digests node:crypto's hash (sha512integrity's) has taken since, counted until the test ends.
function sha512s(t) {
  const real = crypto.hash
  let taken = 0
  crypto.hash = function (algorithm, ...rest) {
    if (algorithm === 'sha512') taken++
    return real.call(this, algorithm, ...rest)
  }
  syncBuiltinESMExports()
  t.after(() => {
    crypto.hash = real
    syncBuiltinESMExports()
  })
  return () => taken
}

// That `lock` attests `files` alone, each by the integrity of `bytesOf(file)`.
function attests(t, lock, files, bytesOf) {
  const attested = lock.modules.get('.').files
  t.assert.deepStrictEqual(Object.keys(attested).toSorted(), files.toSorted())
  for (const file of files) t.assert.equal(attested[file], integrity(bytesOf(file)), file)
}

test('stasis bundle --deptree builds its State\'s lockfile for --lockfile alone', withTmp(async (t, tmp) => {
  writeTree(tmp, PROJECT)
  t.mock.method(console, 'warn', () => {})
  const built = stateLockfiles(t)
  await bundleCommand({ cwd: tmp, env: {}, entries: ['index.js'], deptree: true, resources: ['png', 'txt'], output: 'a.br' })
  t.assert.equal(built(), 0, 'none without --lockfile')
  await bundleCommand({ cwd: tmp, env: {}, entries: ['index.js'], deptree: true, resources: ['png', 'txt'], output: 'b.br', lockfile: 'b.lock.json' })
  t.assert.equal(built(), 1, 'one with it')
  const files = ['data.txt', 'index.js', 'lib.js', 'logo.png', 'stasis.config.json']
  attests(t, Lockfile.parse(readFileSync(join(tmp, 'b.lock.json'), 'utf8')), files, (file) => PROJECT[file])
}))

test('stasis bundle --mainFields hashes nothing without --lockfile, extra neither; with it, the lockfile attests the bytes read', withTmp(async (t, tmp) => {
  writeTree(tmp, PROJECT)
  t.mock.method(console, 'warn', () => {})
  const digests = sha512s(t)
  await bundleCommand({ cwd: tmp, env: {}, entries: ['index.js'], mainFields: ['main'], output: 'a.br' })
  t.assert.equal(digests(), 0, 'nothing hashed without --lockfile')
  await bundleCommand({ cwd: tmp, env: {}, entries: ['index.js'], mainFields: ['main'], output: 'b.br', lockfile: 'b.lock.json' })
  const files = ['data.txt', 'index.js', 'lib.js', 'logo.png', 'stasis.config.json']
  t.assert.equal(digests(), files.length, 'each file hashed once with it')
  attests(t, Lockfile.parse(readFileSync(join(tmp, 'b.lock.json'), 'utf8')), files, (file) => PROJECT[file])
}))

test('buildGitHubBundle builds its lockfile once it is read, the same one after: a State\'s, or one hashed only then', async (t) => {
  // Its files as the fake client serves them (text alone, so the binary logo.png is left out).
  const { 'logo.png': _png, ...repo } = { ...PROJECT, 'index.js': "require('./lib.js')\n" }
  const built = stateLockfiles(t)
  const state = await buildGitHubBundle({ github: GITHUB, sha: SHA, packageManager: 'pnpm', client: fakeClient(repo), entries: ['index.js'] })
  t.assert.equal(built(), 0, 'not built with the bundle')
  const lock = state.lockfile
  t.assert.ok(lock instanceof Lockfile)
  t.assert.equal(state.lockfile, lock, 'the same one on every read')
  t.assert.equal(built(), 1)
  t.assert.equal(state.directory, undefined, 'the directory bundled, the repo root')
  attests(t, lock, ['data.txt', 'index.js', 'lib.js', 'stasis.config.json'], (file) => repo[file])
  // Without a State: nothing hashed, of the build or of `extra`, until the lockfile is read.
  const digests = sha512s(t)
  const fields = await buildGitHubBundle({ github: GITHUB, sha: SHA, packageManager: 'pnpm', client: fakeClient(repo), entries: ['index.js'], mainFields: ['main'] })
  t.assert.equal(digests(), 0)
  attests(t, fields.lockfile, ['data.txt', 'index.js', 'lib.js', 'stasis.config.json'], (file) => repo[file])
  t.assert.equal(digests(), 4)
  t.assert.equal(fields.lockfile, fields.lockfile)
  t.assert.equal(digests(), 4, 'hashed once')
})

test('stasis github-bundle builds the lockfile for --lockfile alone', withTmp(async (t, tmp) => {
  const repo = { 'package.json': json({ name: 'p', version: '1.0.0' }), 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': 'module.exports = 1\n' }
  t.mock.method(console, 'warn', () => {})
  const built = stateLockfiles(t)
  const bundle = (options) => githubBundleCommand({ cwd: tmp, github: GITHUB, sha: SHA, packageManager: 'pnpm', client: fakeClient(repo), entries: ['src/a.js'], ...options })
  await bundle({ output: 'a.br' })
  t.assert.equal(built(), 0, 'none without --lockfile')
  await bundle({ output: 'b.br', lockfile: 'b.lock.json' })
  t.assert.equal(built(), 1, 'one with it')
  t.assert.deepStrictEqual(readdirSync(tmp).toSorted(), ['a.br', 'b.br', 'b.lock.json'])
  attests(t, Lockfile.parse(readFileSync(join(tmp, 'b.lock.json'), 'utf8')), ['src/a.js'], (file) => repo[file])
}))
