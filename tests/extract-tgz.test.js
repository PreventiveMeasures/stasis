import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { gunzipSync, gzipSync } from 'node:zlib'

import { compressBundle } from '@exodus/stasis-core/brotli'
import { Bundle } from '@exodus/stasis-core/bundle'
import { extractCommand, lockfileFromBundle } from '@exodus/stasis-core/extract'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { ARCHIVED } from '@exodus/stasis-core/util'
import { pack, unpack } from '@preventive/archive/tar.js'
import { writeStasisTgz } from '../stasis/src/parse.js'
import { tgzOf, tgzOfBundle } from './stasis-tgz.helper.js'
import { withTmp } from './tmp.helper.js'

// What `stasis extract` imports before it extracts: a .stasis.tgz's reader, which stasis-core has none of.
await import('../stasis/src/run-archived.js')

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const coreCli = join(here, '..', 'stasis-core', 'bin', 'stasis-core.js')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))
const run = (bin, args) => {
  const r = spawnSync(process.execPath, [bin, 'extract', ...args], { encoding: 'utf-8', env })
  return { status: r.status, stderr: stripVTControlCharacters(r.stderr) }
}
const bytes = (text) => new TextEncoder().encode(text)

// Code with a byte order mark and non-ASCII, a base64 resource, an executable, and a dependency.
const BUNDLE = new Bundle({
  entries: new Set(['src/a.js']),
  executable: new Set(['bin/run.sh']),
  formats: new Map([['src/a.js', 'module'], ['src/logo.png', 'resource:base64'], ['bin/run.sh', 'shell'], ['node_modules/dep/index.js', 'commonjs']]),
  imports: new Map([['*', new Map([['src/a.js', new Map([['dep', 'node_modules/dep/index.js']])]])]]),
  modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': '﻿import "dep" // é😀\n', 'src/logo.png': 'AP8BgA==', 'bin/run.sh': '#!/bin/sh\necho\n' } }],
    ['node_modules/dep', { name: 'dep', version: '2.0.0', files: { 'index.js': 'module.exports = 1\n' } }],
  ]),
})
const PLAIN = new Bundle({
  entries: new Set(['src/a.js']),
  formats: new Map([['src/a.js', 'module'], ['src/b.js', 'module']]),
  modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'a\n', 'src/b.js': 'b\n' } }]]),
})

// Every entry under `dir`: a dir, or a file's bytes and whether it is executable.
function snapshot(dir, prefix = '') {
  const out = {}
  for (const name of readdirSync(dir).toSorted()) {
    const [abs, rel] = [join(dir, name), prefix + name]
    const stats = lstatSync(abs)
    if (stats.isDirectory()) Object.assign(out, { [rel]: 'dir' }, snapshot(abs, `${rel}/`))
    else out[rel] = [readFileSync(abs, 'base64'), (stats.mode & 0o111) !== 0]
  }
  return out
}

test('stasis extract writes a .stasis.tgz as a stasis.code.br of its bundle, in every --lock mode, --lock=add writing the lockfile it carries', withTmp((t, tmp) => {
  const tgz = join(tmp, 'app.stasis.tgz')
  writeFileSync(tgz, writeStasisTgz(BUNDLE))
  const br = join(tmp, 'app.stasis.code.br')
  writeFileSync(br, compressBundle(BUNDLE))
  for (const [bundle, out] of [[tgz, 'from-tgz'], [br, 'from-br']]) {
    const r = run(cli, ['--lock=add', '-o', join(tmp, out), bundle])
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /^\[stasis\] Extracted 4 file\(s\) \(1 executable\) and stasis\.lock\.json to /u)
  }
  const tree = snapshot(join(tmp, 'from-tgz'))
  t.assert.deepStrictEqual(tree, snapshot(join(tmp, 'from-br')))
  t.assert.deepStrictEqual([tree['bin/run.sh'][1], tree['src/a.js'][1]], [true, false])
  // The lockfile at the tgz's top, as `tar -xzf` unpacks it.
  const carried = unpack(gunzipSync(readFileSync(tgz))).find(({ name }) => name === 'stasis.lock.json')
  t.assert.equal(readFileSync(join(tmp, 'from-tgz', 'stasis.lock.json'), 'utf8'), new TextDecoder().decode(carried.data))

  // Verified against that lockfile (frozen, the default over one), then each other mode.
  const frozen = run(cli, ['-o', join(tmp, 'from-tgz'), tgz])
  t.assert.equal(frozen.status, 0, frozen.stderr)
  t.assert.match(frozen.stderr, /Extracted 4 file\(s\) \(1 executable, 4 already in place\) to .*, verified against stasis\.lock\.json/u)
  for (const lock of ['add', 'replace', 'ignore']) t.assert.equal(run(cli, [`--lock=${lock}`, '-o', join(tmp, 'from-tgz'), tgz]).status, 0, lock)
  t.assert.deepStrictEqual(snapshot(join(tmp, 'from-tgz')), tree)
  // stasis.tgz as <name>.stasis.tgz; --lock=none writes the files alone.
  const bare = join(tmp, 'stasis.tgz')
  writeFileSync(bare, readFileSync(tgz))
  const none = run(cli, ['--lock=none', '-o', join(tmp, 'none'), bare])
  t.assert.equal(none.status, 0, none.stderr)
  const { 'stasis.lock.json': _, ...files } = tree
  t.assert.deepStrictEqual(snapshot(join(tmp, 'none')), files)
}))

test('stasis extract refuses a .stasis.tgz other than its stasis.lock.json\'s files, or with a byte past its streams but zeros, writing nothing', withTmp((t, tmp) => {
  t.mock.method(console, 'warn', () => {})
  const out = join(tmp, 'out')
  const refused = (name, tgz, message) => {
    const bundleFile = join(tmp, name)
    writeFileSync(bundleFile, tgz)
    t.assert.throws(() => extractCommand({ bundleFile, output: out }), (error) => {
      t.assert.equal(error.message, `extract: not a valid stasis bundle: ${bundleFile}`, name)
      t.assert.match(error.cause.message, new RegExp(`^${RegExp.escape(bundleFile)}: ${message.source}$`, 'u'), name)
      return true
    })
    t.assert.ok(!existsSync(out), `${name}: nothing written`)
  }
  const lock = lockfileFromBundle(PLAIN).serialize()
  const entries = [{ name: 'stasis.lock.json', data: bytes(lock) }, { name: 'src/a.js', data: bytes('a\n') }, { name: 'src/b.js', data: bytes('b\n') }]
  // What it holds is Bundle.fromTar's to hold to its lockfile (bundle-tar.test.js), told of the tgz.
  refused('tampered.stasis.tgz', tgzOfBundle(PLAIN, { 'src/b.js': 'B\n' }), /stasis: src\/b\.js does not match the lockfile \(expected sha512-\S+, got sha512-\S+\)/u)
  refused('extra.stasis.tgz', tgzOfBundle(PLAIN, { 'src/extra.js': 'x\n' }), /src\/extra\.js is in it, but not in its stasis\.lock\.json/u)
  refused('missing.stasis.tgz', tgzOf(entries.slice(0, 2)), /src\/b\.js, which its stasis\.lock\.json attests, is not in it/u)
  refused('exec.stasis.tgz', tgzOf([...entries.slice(0, 2), { ...entries[2], mode: 0o755 }]), /src\/b\.js's execute bit is not the one its stasis\.lock\.json attests/u)
  refused('link.stasis.tgz', tgzOf([...entries, { name: 'src/c.js', type: 'symlink', linkname: 'a.js' }]), /src\/c\.js is a symlink, which no stasis\.lock\.json attests/u)
  refused('unlocked.stasis.tgz', tgzOf(entries.slice(1)), /holds no stasis\.lock\.json at its top/u)
  refused('nested.stasis.tgz', tgzOf(entries.map((entry) => ({ ...entry, name: `package/${entry.name}` }))), /holds no stasis\.lock\.json at its top/u)
  const listing = JSON.parse(lock)
  listing.formats.src = 'directory'
  listing.sources['.'].files.src = sha512integrity('["a.js","b.js"]')
  refused('listing.stasis.tgz', tgzOf([{ name: 'stasis.lock.json', data: bytes(JSON.stringify(listing)) }, ...entries.slice(1)]), /its stasis\.lock\.json records 'src' as a directory capture, which a \.stasis\.tgz can't carry/u)
  const tar = pack(entries)
  refused('junk.stasis.tgz', Buffer.concat([gzipSync(tar), Buffer.from([0, 0, 0x41])]), /bytes past its gzip stream/u)
  refused('trailing.stasis.tgz', gzipSync(Buffer.concat([tar, Buffer.alloc(512, 0x41)])), /data after the end of the archive at byte \d+/u)
  // Zeros past either are padding.
  const padded = join(tmp, 'padded.stasis.tgz')
  writeFileSync(padded, Buffer.concat([gzipSync(Buffer.concat([tar, Buffer.alloc(1024)])), Buffer.alloc(9)]))
  t.assert.equal(extractCommand({ bundleFile: padded, output: out }).files, 2)
}))

test('stasis extract refuses a tgz of another name, and anything else under its name; stasis-core extract a .stasis.tgz, writing nothing', withTmp((t, tmp) => {
  t.mock.method(console, 'warn', () => {})
  const out = join(tmp, 'out')
  const tgz = writeStasisTgz(PLAIN)
  for (const name of ['app.tgz', 'app.stasis.code.br', 'stasis.tgz.br']) {
    const bundleFile = join(tmp, name)
    writeFileSync(bundleFile, tgz)
    // As it is, not as an invalid bundle: one, of another name.
    t.assert.throws(() => extractCommand({ bundleFile, output: out }), { message: `stasis: ${bundleFile} is a tgz, which is read as stasis.tgz or <name>.stasis.tgz alone` })
  }
  const brotli = join(tmp, 'br.stasis.tgz')
  writeFileSync(brotli, compressBundle(PLAIN))
  t.assert.throws(() => extractCommand({ bundleFile: brotli, output: out }), (error) => error.message === `extract: not a valid stasis bundle: ${brotli}` && error.cause.message === `${brotli}: incorrect header check`)
  t.assert.ok(!existsSync(out))

  const bundleFile = join(tmp, 'app.stasis.tgz')
  writeFileSync(bundleFile, tgz)
  const cannot = `stasis: ${bundleFile} is a .stasis.tgz, which stasis reads and writes and stasis-core can't (it writes a stasis.code.br)`
  const core = run(coreCli, ['-o', out, bundleFile])
  t.assert.equal(core.status, 1)
  t.assert.ok(core.stderr.includes(`Error: ${cannot}\n`), core.stderr)
  // As stasis-core's own reads are, without what stasis registers.
  const archived = globalThis[ARCHIVED]
  delete globalThis[ARCHIVED]
  try {
    t.assert.throws(() => extractCommand({ bundleFile, output: out }), { message: cannot })
  } finally {
    globalThis[ARCHIVED] = archived
  }
  t.assert.ok(!existsSync(out))
  t.assert.equal(extractCommand({ bundleFile, output: out }).files, 2)
}))

test('stasis extract holds a .stasis.tgz to the output dir as a stasis.code.br: its lockfile, and the files already there', withTmp((t, tmp) => {
  t.mock.method(console, 'warn', () => {})
  const bundleFile = join(tmp, 'app.stasis.tgz')
  writeFileSync(bundleFile, writeStasisTgz(PLAIN))
  const other = new Bundle({ ...PLAIN, modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'A\n', 'src/b.js': 'b\n' } }]]) })
  const over = (name, setUp) => {
    const out = join(tmp, name)
    mkdirSync(join(out, 'src'), { recursive: true })
    setUp(out)
    return out
  }
  const locked = over('locked', (out) => writeFileSync(join(out, 'stasis.lock.json'), lockfileFromBundle(other).serialize()))
  t.assert.throws(() => extractCommand({ bundleFile, output: locked }), /^Error: extract: --lock=frozen: the bundle does not match .*stasis\.lock\.json: \["sources"\]\["\."\]\["files"\]\["src\/a\.js"\] differs$/u)
  t.assert.throws(() => extractCommand({ bundleFile, output: locked, lock: 'add' }), /extract: --lock=add: the bundle conflicts with .*: lockfile merge: content mismatch for 'src\/a\.js'/u)
  t.assert.throws(() => extractCommand({ bundleFile, output: locked, lock: 'none' }), /extract: unexpected .*stasis\.lock\.json with --lock=none/u)
  t.assert.deepStrictEqual(readdirSync(join(locked, 'src')), [])
  const taken = over('taken', (out) => writeFileSync(join(out, 'src', 'b.js'), 'other\n'))
  t.assert.throws(() => extractCommand({ bundleFile, output: taken, lock: 'add' }), /extract: src\/b\.js exists with other content, which extract never overwrites/u)
  t.assert.deepStrictEqual(readdirSync(taken).toSorted(), ['src'])
  t.assert.deepStrictEqual(readdirSync(join(taken, 'src')), ['b.js'])
}))
