import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { extractCommand } from '@exodus/stasis-core/extract'
import { withTmp } from './tmp.helper.js'

// scripts/stasis-extract.mjs is `stasis extract --lock=none` in one file: on each bundle below, both refuse, or
// both write the same tree.
const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'stasis-extract.mjs')
const runScript = (args, opts) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8', ...opts })

const v1 = (files, extra = {}) => ({ version: 1, config: { scope: 'full' }, sources: { '.': { name: 'app', files } }, modules: {}, formats: {}, imports: {}, ...extra })
const writeBundle = (path, json) => writeFileSync(path, brotliCompressSync(JSON.stringify(json)))
const dep = (files) => ({ 'node_modules/foo': { name: 'foo', version: '1.0.0', files } })

// Every entry under `dir`: a dir, a symlink's target, or a file's bytes and mode.
function snapshot(dir, prefix = '') {
  const out = {}
  for (const name of readdirSync(dir).toSorted()) {
    const [abs, rel] = [join(dir, name), prefix + name]
    const stats = lstatSync(abs)
    if (stats.isSymbolicLink()) out[rel] = readlinkSync(abs)
    else if (stats.isDirectory()) Object.assign(out, { [rel]: 'dir' }, snapshot(abs, `${rel}/`))
    else out[rel] = [readFileSync(abs, 'base64'), (stats.mode & 0o7777).toString(8)]
  }
  return out
}

function assertParity(t, tmp, bundleFile, outcome, setup = () => {}) {
  const [a, b] = [join(tmp, 'a'), join(tmp, 'b')]
  for (const dir of [a, b]) {
    mkdirSync(dir)
    setup(dir)
  }
  t.mock.method(console, 'warn', () => {})
  let refused = false
  try {
    extractCommand({ bundleFile, output: a, lock: 'none' })
  } catch {
    refused = true
  }
  console.warn.mock.restore()
  t.assert.equal(refused ? 'refused' : 'extracted', outcome, 'stasis extract')
  const r = runScript(['-o', b, bundleFile])
  t.assert.equal(r.status, refused ? 1 : 0, r.stderr)
  t.assert.deepStrictEqual(snapshot(b), snapshot(a))
}

const CASES = {
  'a plain bundle': [v1({ 'src/a.js': 'a\n', 'src/deep/b.json': '{}\n' }, { modules: dep({ 'index.js': '1\n' }) }), 'extracted'],
  'an empty bundle': [v1({}), 'extracted'],
  'a node_modules-scope bundle': [{ version: 1, config: { scope: 'node_modules' }, modules: dep({ 'index.js': '1\n' }), formats: {}, imports: {} }, 'extracted'],
  'executable files': [v1({ 'bin/run.sh': '#!/bin/sh\n', 'lib/x.sh': 'x\n' }, { executable: ['bin/run.sh'] }), 'extracted'],
  'resources, raw and base64': [v1({ 'a.txt': 'plain', 'b.bin': 'AP8BgA==' }, { formats: { 'a.txt': 'resource', 'b.bin': 'resource:base64' } }), 'extracted'],
  'directory listings': [v1({ 'src/assets/a.txt': 'A', 'src/assets': '["a.txt"]' }, {
    modules: dep({ '': '["index.js"]', 'index.js': '1\n' }),
    formats: { 'src/assets': 'directory', 'node_modules/foo': 'directory' },
  }), 'extracted'],
  'names beginning with ".."': [v1({ '..foo/a.js': '1', '...': '2' }), 'extracted'],
  'non-canonical base64': [v1({ 'b.bin': 'AAE=!' }, { formats: { 'b.bin': 'resource:base64' } }), 'refused'],
  'an escaping path': [{ ...v1({}), sources: { 'x/../..': { name: 'e', files: { 'p.js': '1' } } } }, 'refused'],
  'an absolute path': [v1({ '/etc/x': '1' }), 'refused'],
  'a backslash': [v1({ 'a\\b.js': '1' }), 'refused'],
  'an empty segment': [v1({ 'src//a.js': '1' }), 'refused'],
  'a "." segment': [v1({ 'src/./a.js': '1' }), 'refused'],
  'a bucket\'s own path outside a listing': [v1({}, { modules: dep({ '': 'x' }) }), 'refused'],
  'a duplicate path': [v1({ 'node_modules/foo/a.js': '1' }, { modules: dep({ 'a.js': '1' }) }), 'refused'],
  'a path both file and directory': [v1({ bar: 'x', 'bar/baz.js': 'y' }), 'refused'],
  'a nested path both file and directory': [v1({ 'new/a': 'x', 'new/a/b': 'y' }), 'refused'],
  'non-string content': [v1({ 'x.js': 42 }), 'refused'],
  'a stasis.lock.json': [v1({ 'sub/STASIS.LOCK.JSON': '{}' }), 'refused'],
}

for (const [name, [json, outcome]] of Object.entries(CASES)) {
  test(`stasis-extract.mjs as stasis extract: ${name}`, withTmp((t, tmp) => {
    writeBundle(join(tmp, 'bundle.code.br'), json)
    assertParity(t, tmp, join(tmp, 'bundle.code.br'), outcome)
  }))
}

// Over what is already in the output dir.
const DISK = {
  'files holding their bytes, a 0600 one and a stray execute bit included': ['extracted', (dir) => {
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'a.js'), 'a\n')
    chmodSync(join(dir, 'a.js'), 0o755)
    writeFileSync(join(dir, 'bin/run.sh'), '#!/bin/sh\n')
    chmodSync(join(dir, 'bin/run.sh'), 0o600)
  }],
  'a symlink to a file holding its bytes': ['extracted', (dir) => {
    writeFileSync(join(dir, 'real.js'), 'a\n')
    symlinkSync('real.js', join(dir, 'a.js'))
  }],
  'a file with other content': ['refused', (dir) => writeFileSync(join(dir, 'a.js'), 'other\n')],
  'a directory where a file goes': ['refused', (dir) => mkdirSync(join(dir, 'a.js'))],
  'a file where a directory goes': ['refused', (dir) => writeFileSync(join(dir, 'bin'), '')],
  'a dangling symlink where a file goes': ['refused', (dir) => symlinkSync('nowhere', join(dir, 'a.js'))],
  'a dangling symlink where a directory goes': ['refused', (dir) => symlinkSync('nowhere', join(dir, 'bin'))],
}

for (const [name, [outcome, setup]] of Object.entries(DISK)) {
  test(`stasis-extract.mjs as stasis extract over ${name}`, withTmp((t, tmp) => {
    writeBundle(join(tmp, 'bundle.code.br'), v1({ 'a.js': 'a\n', 'bin/run.sh': '#!/bin/sh\n' }, { executable: ['bin/run.sh'] }))
    assertParity(t, tmp, join(tmp, 'bundle.code.br'), outcome, setup)
  }))
}

test('stasis-extract.mjs as stasis extract: a real bundle', withTmp(async (t, tmp) => {
  const cwd = join(here, 'fixtures', 'solidity-bundle', 'with-node-modules')
  await bundleCommand({ cwd, entries: ['src/A.sol'], output: join(tmp, 'out.code.br'), mappingFile: 'remappings.txt' })
  assertParity(t, tmp, join(tmp, 'out.code.br'), 'extracted')
}))

test('stasis-extract.mjs refuses a v0 bundle, or bytes that are no bundle', withTmp((t, tmp) => {
  const v0 = brotliCompressSync(JSON.stringify({ version: 0, config: { scope: 'full' }, sources: { 'a.js': '1' }, formats: {}, imports: {} }))
  const junk = Buffer.concat([brotliCompressSync(JSON.stringify(v1({ 'a.js': '1' }))), Buffer.from('junk')])
  for (const bytes of [v0, junk, Buffer.from('garbage')]) {
    writeFileSync(join(tmp, 'bundle.code.br'), bytes)
    const r = runScript(['-o', join(tmp, 'out'), join(tmp, 'bundle.code.br')])
    t.assert.equal(r.status, 1)
    t.assert.match(r.stderr, /extract: not a valid stasis bundle: /)
    t.assert.ok(!existsSync(join(tmp, 'out')))
  }
}))

test('stasis-extract.mjs skips a stat record, writing no content for it', withTmp((t, tmp) => {
  writeBundle(join(tmp, 'bundle.code.br'), v1({ 'a.js': '1', 'b.js': '2' }, { formats: { 'b.js': 'stat:file' } }))
  const r = runScript(['-o', join(tmp, 'out'), join(tmp, 'bundle.code.br')])
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.deepStrictEqual(readdirSync(join(tmp, 'out')), ['a.js'])
}))

test('stasis-extract.mjs refuses a stasis.lock.json, or a <name>.stasis.lock.json for <name>.stasis.code.br', withTmp((t, tmp) => {
  writeBundle(join(tmp, 'app.stasis.code.br'), v1({ 'a.js': 'a\n' }))
  for (const lock of ['stasis.lock.json', 'app.stasis.lock.json']) {
    const out = join(tmp, lock)
    mkdirSync(out)
    symlinkSync('nowhere', join(out, lock)) // a dangling symlink is one too
    const r = runScript([join(tmp, 'app.stasis.code.br')], { cwd: out })
    t.assert.equal(r.status, 1, lock)
    t.assert.ok(r.stderr.includes(`extract: unexpected ${join(out, lock)}: no lockfile support here`), r.stderr)
    t.assert.deepStrictEqual(readdirSync(out), [lock])
  }
  // Nor may that bundle write its own.
  writeBundle(join(tmp, 'app.stasis.code.br'), v1({ 'a.js': 'a\n', 'app.stasis.lock.json': '{}' }))
  const r = runScript(['-o', join(tmp, 'out'), join(tmp, 'app.stasis.code.br')])
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /extract: the bundle carries a lockfile: app\.stasis\.lock\.json/)
  t.assert.ok(!existsSync(join(tmp, 'out')))
}))

test('stasis-extract.mjs extracts beside a lockfile of another bundle\'s name', withTmp((t, tmp) => {
  for (const [bundle, lock] of [['app.stasis.code.br', 'other.stasis.lock.json'], ['app.code.br', 'app.stasis.lock.json']]) {
    const out = join(tmp, bundle, 'out')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, lock), '{}')
    writeBundle(join(tmp, bundle, bundle), v1({ 'a.js': 'a\n' }))
    const r = runScript([`--output=${out}`, join(tmp, bundle, bundle)])
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.deepStrictEqual(readdirSync(out).toSorted(), ['a.js', lock].toSorted())
  }
}))

test('stasis-extract.mjs takes exactly one bundle', (t) => {
  for (const args of [[], ['a.br', 'b.br']]) {
    const r = runScript(args)
    t.assert.equal(r.status, 1)
    t.assert.match(r.stderr, /^Usage: node scripts\/stasis-extract\.mjs /u)
  }
})
