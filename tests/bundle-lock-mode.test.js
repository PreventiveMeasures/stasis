import { test } from 'node:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { withTmp } from './tmp.helper.js'

// `stasis bundle` and the stasis.lock.json there: what it builds held to what the lockfile records,
// by the lock mode the project's runs take (EXODUS_STASIS_LOCK, or frozen where stasis.config.json
// pins it; add by default).

const OTHER = `sha512-${'B'.repeat(85)}A==`
const { EXODUS_STASIS_LOCK: _lock, EXODUS_STASIS_LOCK_FILE: _file, ...env } = process.env
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

// A project in `dir` of index.js alone.
function project(dir) {
  writeJson(join(dir, 'package.json'), { name: 'app', version: '1.0.0' })
  writeFileSync(join(dir, 'index.js'), 'module.exports = 1\n')
}
const build = (dir, { lock, ...options } = {}) => bundleCommand({ cwd: dir, entries: ['index.js'], output: 'out.br', env: lock === undefined ? env : { ...env, EXODUS_STASIS_LOCK: lock }, ...options })

test('stasis bundle in lock = add holds what it builds to the stasis.lock.json there, with --lockfile or not, and writes the one built, or with --add both merged', withTmp(async (t, dir) => {
  project(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const written = readFileSync(lockPath, 'utf8')
  const lock = JSON.parse(written)
  lock.sources['.'].files['index.js'] = OTHER
  writeJson(lockPath, lock)
  const edited = readFileSync(lockPath, 'utf8')
  await t.assert.rejects(build(dir), /^Error: stasis\.lock\.json: content mismatch for 'index\.js'$/u, 'without --lockfile: read all the same')
  await t.assert.rejects(build(dir, { lockfile: 'stasis.lock.json' }), /content mismatch for 'index\.js'/u, 'with it: not overwritten')
  t.assert.equal(readFileSync(lockPath, 'utf8'), edited, 'left as it was')
  // Held to what it records, the lockfile written is the one built, which the bundle beside it pairs
  // with; with --add, both merged.
  writeFileSync(lockPath, written)
  writeFileSync(join(dir, 'more.js'), 'module.exports = 2\n')
  const entriesOf = (file) => JSON.parse(brotliDecompressSync(readFileSync(join(dir, file))).toString('utf8')).entries.toSorted()
  await build(dir, { entries: ['more.js'], lockfile: 'stasis.lock.json' })
  t.assert.deepStrictEqual([readJson(lockPath).entries, entriesOf('out.br')], [['more.js'], ['more.js']])
  writeFileSync(lockPath, written)
  await build(dir, { lockfile: 'stasis.lock.json' })
  await build(dir, { entries: ['more.js'], lockfile: 'stasis.lock.json', add: true })
  const merged = readJson(lockPath)
  t.assert.deepStrictEqual([Object.keys(merged.sources['.'].files).toSorted(), merged.entries.toSorted(), entriesOf('out.br')], [['index.js', 'more.js'], ['index.js', 'more.js'], ['index.js', 'more.js']])
  // One changed since, as for a run: lock = replace records it anew.
  writeFileSync(join(dir, 'more.js'), 'module.exports = 3\n')
  await t.assert.rejects(build(dir, { entries: ['more.js'] }), /stasis\.lock\.json: content mismatch for 'more\.js'/u)
}))

test('stasis bundle in lock = ignore leaves stasis.lock.json alone, in replace rewrites it, in none refuses one: as a run takes them', withTmp(async (t, dir) => {
  project(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const lock = readJson(lockPath)
  const recorded = lock.sources['.'].files['index.js']
  lock.sources['.'].files['index.js'] = OTHER
  writeJson(lockPath, lock)
  const edited = readFileSync(lockPath, 'utf8')
  await build(dir, { lock: 'ignore' })
  t.assert.equal(readFileSync(lockPath, 'utf8'), edited)
  await t.assert.rejects(build(dir, { lockfile: 'stasis.lock.json', lock: 'ignore' }), /^Error: bundleCommand: --lockfile: lock = ignore writes no lockfile$/u)
  await t.assert.rejects(build(dir, { lock: 'replace' }), /^Error: bundleCommand: lock = replace rewrites stasis\.lock\.json: give --lockfile$/u)
  await build(dir, { lockfile: 'stasis.lock.json', lock: 'replace' })
  t.assert.equal(readJson(lockPath).sources['.'].files['index.js'], recorded)
  await t.assert.rejects(build(dir, { lock: 'none' }), /^Error: stasis\.lock\.json is there, which lock = none refuses$/u)
  rmSync(lockPath)
  await build(dir, { lock: 'none' })
  await t.assert.rejects(build(dir, { lockfile: 'stasis.lock.json', lock: 'none' }), /^Error: bundleCommand: --lockfile: lock = none writes no lockfile$/u)
}))

test('stasis bundle in lock = frozen holds everything it builds to stasis.lock.json, and refuses --lockfile', withTmp(async (t, dir) => {
  project(dir)
  writeJson(join(dir, 'stasis.config.json'), { lock: 'frozen' })
  await t.assert.rejects(build(dir), /^Error: stasis\.lock\.json isn't there, and lock = frozen holds the build to it$/u)
  await t.assert.rejects(build(dir, { lock: 'add' }), /^Error: Flags\/env can not override stasis\.config\.json$/u, 'another mode the pin refuses, as a run is')
  // The lockfile, written as lock = add would, and pinned frozen after.
  writeFileSync(join(dir, 'stasis.config.json'), '{}\n')
  await build(dir, { lockfile: 'stasis.lock.json' })
  writeJson(join(dir, 'stasis.config.json'), { lock: 'frozen' })
  const lockPath = join(dir, 'stasis.lock.json')
  const before = readFileSync(lockPath, 'utf8')
  await build(dir)
  await t.assert.rejects(build(dir, { lockfile: 'stasis.lock.json' }), /^Error: bundleCommand: --lockfile: lock = frozen writes no lockfile$/u)
  t.assert.equal(readFileSync(lockPath, 'utf8'), before, 'not written')
  writeFileSync(join(dir, 'more.js'), 'module.exports = 2\n')
  await t.assert.rejects(build(dir, { entries: ['index.js', 'more.js'] }), /^Error: stasis\.lock\.json \(lock = frozen\) doesn't attest more\.js$/u)
  t.assert.equal(readFileSync(lockPath, 'utf8'), before, 'still not written')
  // A format it doesn't record.
  const lock = readJson(lockPath)
  delete lock.formats['index.js']
  writeJson(lockPath, lock)
  await t.assert.rejects(build(dir), /^Error: stasis\.lock\.json \(lock = frozen\) doesn't attest the format of index\.js$/u)
  writeFileSync(lockPath, before)
  // --add: what the bundle there carries too.
  writeFileSync(join(dir, 'stasis.config.json'), '{}\n')
  await build(dir, { entries: ['more.js'], lock: 'ignore' })
  writeJson(join(dir, 'stasis.config.json'), { lock: 'frozen' })
  await t.assert.rejects(build(dir, { add: true }), /^Error: stasis\.lock\.json \(lock = frozen\) doesn't attest more\.js$/u)
}))

test('stasis bundle in lock = frozen attests as a frozen run does: entries in full scope alone, an import of any condition set agreeing', withTmp(async (t, dir) => {
  project(dir)
  writeFileSync(join(dir, 'index.js'), "require('dep')\n")
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeJson(join(dir, 'node_modules', 'dep', 'package.json'), { name: 'dep', version: '1.0.0', main: 'index.js' })
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  const lockPath = join(dir, 'stasis.lock.json')
  const frozen = (options) => {
    writeJson(join(dir, 'stasis.config.json'), { lock: 'frozen' })
    return build(dir, options)
  }
  // node_modules scope, whose lockfile records no entries.
  writeFileSync(join(dir, 'stasis.config.json'), '{}\n')
  await build(dir, { scope: 'node_modules', lockfile: 'stasis.lock.json' })
  await frozen({ scope: 'node_modules' })
  // A run's lockfile, of concrete condition sets: the build's '*' held to them where they agree.
  writeFileSync(join(dir, 'stasis.config.json'), '{}\n')
  await build(dir, { lockfile: 'stasis.lock.json', lock: 'replace' })
  const lock = readJson(lockPath)
  const edges = lock.imports['*']
  lock.imports = { 'node, require': edges, 'import, node': edges }
  writeJson(lockPath, lock)
  await frozen()
  lock.imports = { 'node, require': edges, 'import, node': { 'index.js': { dep: 'node_modules/dep/other.js' } } }
  writeJson(lockPath, lock)
  await t.assert.rejects(frozen(), /^Error: stasis\.lock\.json \(lock = frozen\) doesn't attest import 'dep' from 'index\.js' consistently across condition sets$/u)
}))

test('stasis bundle in lock = frozen builds every entry the lockfile attests, as the bundle loads beside it', withTmp(async (t, dir) => {
  project(dir)
  writeFileSync(join(dir, 'more.js'), 'module.exports = 2\n')
  await build(dir, { entries: ['index.js', 'more.js'], lockfile: 'stasis.lock.json' })
  writeJson(join(dir, 'stasis.config.json'), { lock: 'frozen' })
  await t.assert.rejects(build(dir), /^Error: bundleCommand: stasis\.lock\.json \(lock = frozen\) attests the entry more\.js, which the bundle doesn't build$/u)
  await build(dir, { entries: ['index.js', 'more.js'] })
}))

test('stasis bundle takes a relative EXODUS_STASIS_LOCK_FILE of the working directory, as a run does', withTmp(async (t, dir) => {
  project(dir)
  const sub = join(dir, 'sub')
  mkdirSync(sub)
  await build(dir, { lockfile: 'sub/custom.lock.json' })
  writeJson(join(dir, 'stasis.config.json'), { lock: 'frozen' })
  const at = process.cwd()
  process.chdir(sub)
  try {
    await bundleCommand({ cwd: dir, entries: ['index.js'], output: 'out.br', env: { ...env, EXODUS_STASIS_LOCK_FILE: 'custom.lock.json' } })
  } finally {
    process.chdir(at)
  }
}))

test('stasis bundle --deptree holds its build to the stasis.lock.json there', withTmp(async (t, dir) => {
  // A lockfile of no registry package: nothing is fetched.
  project(dir)
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n")
  await build(dir, { deptree: true, lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const lock = readJson(lockPath)
  lock.sources['.'].files['index.js'] = OTHER
  writeJson(lockPath, lock)
  await t.assert.rejects(build(dir, { deptree: true }), /content mismatch for 'index\.js'/u)
}))
