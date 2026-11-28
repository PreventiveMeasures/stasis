import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { pack } from '@preventive/archive/tar.js'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { writeStasisTgz } from '../stasis/src/parse.js'
import { extractCommand, lockfileFromBundle } from '@exodus/stasis-core/extract'
import { withTmp } from './tmp.helper.js'

// What `stasis extract` imports before it extracts: a .stasis.tgz's reader.
await import('../stasis/src/run-archived.js')

// scripts/stasis-extract.mjs is `stasis extract --lock=none` in one file: on each bundle below, a stasis.code.br or
// a .stasis.tgz, both refuse, or both write the same tree.
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
  'a stat record of a stasis.lock.json': [v1({ 'a.js': '1', 'stasis.lock.json': '' }, { formats: { 'stasis.lock.json': 'stat:file' } }), 'refused'],
  'an app.stasis.lock.json in the project': [v1({ 'a.js': '1', 'app.stasis.lock.json': '{}' }), 'refused'],
  'an x.stasis.lock.json in a dependency': [v1({ 'a.js': '1' }, { modules: dep({ 'index.js': '1', 'lib/x.stasis.lock.json': '{}' }) }), 'refused'],
  'names only resembling a stasis.lock.json': [v1({ 'my-stasis.lock.json': '{}', 'stasis.lock.json.bak': '{}', 'src/stasis.lock.jsonc': '{}' }), 'extracted'],
  'an npm extension in a dependency': [v1({ 'src/a.js': '1' }, { modules: dep({ 'index.js': '1', '.npm-extension.mjs': 'x' }) }), 'refused'],
  'an npm extension in a node_modules-scope bundle': [{ version: 1, config: { scope: 'node_modules' }, modules: dep({ 'lib/.npm-extension.cjs': 'x' }), formats: {}, imports: {} }, 'refused'],
  'an npm extension in the project, in any case': [v1({ 'packages/x/.NPM-Extension.MTS': 'x' }), 'refused'],
  'a stat record of an npm extension': [v1({ 'a.js': '1' }, { modules: dep({ '.npm-extension.js': '' }), formats: { 'node_modules/foo/.npm-extension.js': 'stat:file' } }), 'refused'],
  'a directory listing named as an npm extension': [v1({ 'src/.npm-extension.ts': '[]' }, { formats: { 'src/.npm-extension.ts': 'directory' } }), 'refused'],
  'names only resembling an npm extension': [v1({ 'npm-extension.mjs': '1', '.npm-extension.json': '{}', '.npm-extension.mjs.map': '{}', 'a.npm-extension.cjs': '1', '.npm-extension.mjs/index.js': '1' }), 'extracted'],
  'a pnpmfile in a dependency': [v1({ 'src/a.js': '1' }, { modules: dep({ 'index.js': '1', '.pnpmfile.cjs': 'x' }) }), 'refused'],
  'a pnpmfile in the project, in any case': [v1({ '.PNPMFILE.MJS': 'x' }), 'refused'],
  'a stat record of a pnpmfile': [v1({ 'a.js': '1' }, { modules: dep({ '.pnpmfile.ts': '' }), formats: { 'node_modules/foo/.pnpmfile.ts': 'stat:file' } }), 'refused'],
  'a pnpmfile named without its dot': [v1({ 'a.js': '1' }, { modules: dep({ 'pnpmfile.js': 'x' }) }), 'refused'],
  'names only resembling a pnpmfile': [v1({ '.pnpmfile': '1', '.pnpmfile.json': '{}', 'my.pnpmfile.cjs': '1', 'my-pnpmfile.js': '1', 'pnpmfile.jsx': '1' }), 'extracted'],
  'an .npmrc in a dependency': [v1({ 'a.js': '1' }, { modules: dep({ '.npmrc': 'registry=x' }), formats: { 'node_modules/foo/.npmrc': 'resource' } }), 'refused'],
  'a .yarnrc.yml in the project': [v1({ 'packages/x/.yarnrc.yml': 'yarnPath: x.cjs' }), 'refused'],
  'a .yarnrc in a dependency, in any case': [v1({ 'a.js': '1' }, { modules: dep({ 'lib/.YarnRC': 'yarn-path x.js' }) }), 'refused'],
  'a bunfig.toml in a dependency': [v1({ 'a.js': '1' }, { modules: dep({ 'bunfig.toml': 'preload = []' }) }), 'refused'],
  'a .bunfig.toml in the project': [v1({ '.bunfig.toml': 'preload = []' }), 'refused'],
  'a Yarn Plug\'n\'Play file in a dependency': [v1({ 'a.js': '1' }, { modules: dep({ '.pnp.cjs': 'x', 'index.js': '1' }) }), 'refused'],
  'a .pnp.data.json in the project': [v1({ '.pnp.data.json': '{}' }), 'refused'],
  'a .git directory in a dependency': [v1({ 'a.js': '1' }, { modules: dep({ '.git/config': '[core]' }) }), 'refused'],
  'a .git file in the project, in any case': [v1({ 'sub/.GIT': 'gitdir: ../x' }), 'refused'],
  'a stat record of git metadata': [v1({ 'a.js': '1', '.git/HEAD': '' }, { formats: { '.git/HEAD': 'stat:file' } }), 'refused'],
  'names only resembling a config or git metadata': [v1({
    npmrc: '1', '.npmrc.bak': '1', '.yarnrc.yaml': '1', 'bunfig.json': '1', '.pnp.mjs': '1', '.gitignore': '1', '.github/x.yml': '1', 'git/config': '1', 'a.git/config': '1',
  }), 'extracted'],
  'a pnpm-workspace.yaml in a dependency': [v1({ 'a.js': '1' }, { modules: dep({ 'pnpm-workspace.yaml': 'packages: []' }) }), 'refused'],
  'an env file in a nested dependency': [v1({ 'a.js': '1' }, { modules: { 'node_modules/foo/node_modules/bar': { name: 'bar', version: '1.0.0', files: { '.ENV.local': 'x' } } } }), 'refused'],
  'a stat record of a dependency\'s .env': [v1({ 'a.js': '1' }, { modules: dep({ '.env': '' }), formats: { 'node_modules/foo/.env': 'stat:file' } }), 'refused'],
  'the project\'s own pnpm-workspace.yaml and env files': [v1({ 'pnpm-workspace.yaml': 'packages: []', '.env': 'x', 'packages/x/prod.env': 'x', 'x_node_modules/.env': 'x' }), 'extracted'],
  'names in a dependency only resembling a pnpm workspace manifest or env file': [v1({}, { modules: dep({ 'pnpm-workspace.yml': '1', '.envrc': '1', 'x.env.bak': '1', '.environment': '1' }) }), 'extracted'],
  'a node_modules-scope bundle carrying sources': [{ ...v1({ 'src/a.js': '1' }), config: { scope: 'node_modules' }, modules: dep({ 'i.js': '1' }) }, 'refused'],
  'no scope': [{ ...v1({ 'a.js': '1' }), config: undefined }, 'refused'],
  'a dependency bucket outside node_modules': [v1({}, { modules: { src: { name: 's', version: '1.0.0', files: { 'a.js': '1' } } } }), 'refused'],
  'sources as an array': [{ ...v1({}), sources: [{ name: 'app', files: { 'a.js': '1' } }] }, 'refused'],
  'files as an array': [{ ...v1({}), sources: { '.': { name: 'app', files: ['x'] } } }, 'refused'],
  'files as a string': [{ ...v1({}), sources: { '.': { name: 'app', files: 'xy' } } }, 'refused'],
  'formats as an array': [v1({ '0': 'zero', 'a.js': '1' }, { formats: ['directory'] }), 'refused'],
  'a format that is no string': [v1({ 'a.js': '1', 'b.js': '2' }, { formats: { 'b.js': ['stat:file'] } }), 'refused'],
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
  // Nor may that bundle write its own, in any case: a case-insensitive disk takes one for the other.
  for (const lock of ['app.stasis.lock.json', 'APP.Stasis.Lock.JSON']) {
    writeBundle(join(tmp, 'app.stasis.code.br'), v1({ 'a.js': 'a\n', [lock]: '{}' }))
    const r = runScript(['-o', join(tmp, 'out'), join(tmp, 'app.stasis.code.br')])
    t.assert.equal(r.status, 1, lock)
    t.assert.ok(r.stderr.includes(`extract: the bundle carries a forbidden file: ${lock}`), r.stderr)
    t.assert.ok(!existsSync(join(tmp, 'out')))
  }
}))

test('stasis-extract.mjs refuses a file of a forbidden name, naming it and writing nothing', withTmp((t, tmp) => {
  for (const file of ['stasis.lock.json', '.npm-extension.mjs', 'lib/.pnpmfile.cjs', 'PNPMFILE.MTS', '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.pnp.loader.mjs', '.git', '.git/hooks/post-checkout', 'pnpm-workspace.yaml', '.env']) {
    writeBundle(join(tmp, 'bundle.code.br'), v1({ 'a.js': 'a\n' }, { modules: dep({ 'index.js': '1\n', [file]: 'x\n' }) }))
    const r = runScript(['-o', join(tmp, 'out'), join(tmp, 'bundle.code.br')])
    t.assert.equal(r.status, 1, file)
    t.assert.ok(r.stderr.includes(`extract: the bundle carries a forbidden file: node_modules/foo/${file}`), r.stderr)
    t.assert.ok(!existsSync(join(tmp, 'out')), file)
  }
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

// --- .stasis.tgz ---

const bytes = (text) => (typeof text === 'string' ? new TextEncoder().encode(text) : text)
const tgzOfJson = (json) => writeStasisTgz(Bundle.parse(JSON.stringify(json)))
// What Bundle#toTar packs of a bundle: its lockfile, then each file.
const entriesOf = (json) => Bundle.parse(JSON.stringify(json)).toTar({ integrityOf: sha512integrity })
const APP = v1({ 'src/a.js': 'a\n', 'bin/run.sh': '#!/bin/sh\n' }, { executable: ['bin/run.sh'], modules: dep({ 'index.js': '1\n' }) })
// A tar of `entries` with no end marker (pack's blocking 1 pads none past it), to which another's can be joined.
const unended = (entries) => pack(entries, { blocking: 1 }).subarray(0, -1024)
const LONG = `src/${'d'.repeat(90)}/${'é'.repeat(60)}/a-long-name.js`

const TGZ_CASES = {
  'a plain bundle': [tgzOfJson(APP), 'extracted'],
  'an empty bundle': [tgzOfJson(v1({})), 'extracted'],
  'a node_modules-scope bundle': [tgzOfJson({ version: 1, config: { scope: 'node_modules' }, modules: dep({ 'index.js': '1\n', 'bin/x': 'x\n' }), formats: {}, imports: {}, executable: ['node_modules/foo/bin/x'] }), 'extracted'],
  'resources, raw and base64, and code with a byte order mark': [tgzOfJson(v1({ 'a.txt': 'plain', 'b.bin': 'AP8BgA==', 'c.js': '﻿é😀\n' }, { formats: { 'a.txt': 'resource', 'b.bin': 'resource:base64' } })), 'extracted'],
  'stat records': [tgzOfJson(v1({ 'a.js': '1' }, { formats: { 'gone.js': 'stat:file', lib: 'stat:directory' } })), 'extracted'],
  'names beginning with ".."': [tgzOfJson(v1({ '..foo/a.js': '1', '...': '2' })), 'extracted'],
  'a name longer than a header holds, as GNU tar writes it (a long name header)': [tgzOfJson(v1({ [LONG]: 'x\n' })), 'extracted'],
  'a name longer than a header holds, as pax writes it (a path record)': [gzipSync(pack(entriesOf(v1({ [LONG]: 'x\n', 'src/b.js': 'é' })), { format: 'pax' })), 'extracted'],
  'a ustar name prefix': [gzipSync(pack(entriesOf(v1({ [`${'p'.repeat(120)}/a.js`]: 'x\n' })), { format: 'ustar' })), 'extracted'],
  'directories, the root among them': [gzipSync(pack([{ name: './', type: 'directory' }, ...entriesOf(APP), { name: 'src/', type: 'directory' }])), 'extracted'],
  'its lockfile last': [gzipSync(pack(entriesOf(APP).toReversed())), 'extracted'],
  'zeros past its tar and gzip stream': [Buffer.concat([gzipSync(Buffer.concat([pack(entriesOf(APP)), Buffer.alloc(2048)])), Buffer.alloc(7)]), 'extracted'],
  'a second gzip member': (() => {
    const tar = pack(entriesOf(APP))
    return [Buffer.concat([gzipSync(tar.subarray(0, 700)), gzipSync(tar.subarray(700))]), 'extracted']
  })(),
  // Refused alike: a tar other than its lockfile's files.
  'a file of other bytes': [gzipSync(pack(entriesOf(APP).map((entry) => (entry.name === 'src/a.js' ? { ...entry, data: bytes('A\n') } : entry)))), 'refused'],
  'a file it does not attest': [gzipSync(pack([...entriesOf(APP), { name: 'src/extra.js', data: bytes('x') }])), 'refused'],
  'a file it attests missing': [gzipSync(pack(entriesOf(APP).filter(({ name }) => name !== 'src/a.js'))), 'refused'],
  'an execute bit it does not attest': [gzipSync(pack(entriesOf(APP).map((entry) => ({ ...entry, mode: 0o755 })))), 'refused'],
  'no execute bit where it attests one': [gzipSync(pack(entriesOf(APP).map((entry) => ({ ...entry, mode: 0o644 })))), 'refused'],
  'a symlink': [gzipSync(pack([...entriesOf(APP), { name: 'src/b.js', type: 'symlink', linkname: 'a.js' }])), 'refused'],
  'a hard link': [gzipSync(pack([...entriesOf(APP), { name: 'src/b.js', type: 'hardlink', linkname: 'src/a.js' }])), 'refused'],
  'a fifo': [gzipSync(pack([...entriesOf(APP), { name: 'src/fifo', type: 'fifo' }])), 'refused'],
  'no lockfile': [gzipSync(pack(entriesOf(APP).slice(1))), 'refused'],
  'its lockfile under a directory': [gzipSync(pack(entriesOf(APP).map((entry) => ({ ...entry, name: `package/${entry.name}` })))), 'refused'],
  'a lockfile that does not parse': [gzipSync(pack([{ name: 'stasis.lock.json', data: bytes('{') }, ...entriesOf(APP).slice(1)])), 'refused'],
  'a lockfile with a byte order mark': [gzipSync(pack(entriesOf(APP).map((entry) => (entry.name === 'stasis.lock.json' ? { ...entry, data: bytes(`﻿${new TextDecoder().decode(entry.data)}`) } : entry)))), 'refused'],
  'a directory capture': [gzipSync(pack(lockedTar(v1({ 'src/a.js': 'a\n', src: '["a.js"]' }, { formats: { src: 'directory' } }), ['src']))), 'refused'],
  'content for a stat record': [gzipSync(pack(lockedTar(v1({ 'a.js': '1', 'b.js': '2' }), [], (lock) => (lock.formats['b.js'] = 'stat:file')))), 'refused'],
  'code that is no UTF-8': [gzipSync(pack(lockedTar(v1({ 'a.js': '1' }), [], (lock) => (lock.sources['.'].files['b.js'] = sha512integrity(Uint8Array.of(0xe9))), [{ name: 'b.js', data: Uint8Array.of(0xe9) }]))), 'refused'],
  'a file no bundle carries': [gzipSync(pack(lockedTar(v1({ 'a.js': '1' }), [], (lock) => (lock.sources['.'].files['.npmrc'] = sha512integrity('x')), [{ name: '.npmrc', data: bytes('x') }]))), 'refused'],
  'a name twice across buckets': [gzipSync(pack(lockedTar(v1({ 'a.js': '1', 'node_modules/foo/a.js': '2' }), [], (lock) => (lock.modules = dep({ 'a.js': sha512integrity('2') }))))), 'refused'],
  'an entry inside a file': [gzipSync(Buffer.concat([unended(entriesOf(APP)), pack([{ name: 'src/a.js/x', data: bytes('x') }])])), 'refused'],
  'a file where a directory is': [gzipSync(Buffer.concat([unended([...entriesOf(v1({ 'src/a.js': 'a\n' }))]), pack([{ name: 'src', data: bytes('x') }])])), 'refused'],
  'an entry repeated otherwise': [gzipSync(Buffer.concat([unended(entriesOf(APP)), pack([{ name: 'src/a.js', data: bytes('A\n') }])])), 'refused'],
  // Refused alike: a stream other than a gzip of a tar and zeros.
  'a byte past its gzip stream': [Buffer.concat([tgzOfJson(APP), Buffer.from([0x41])]), 'refused'],
  'a byte past zeros past its gzip stream': [Buffer.concat([tgzOfJson(APP), Buffer.from([0, 0, 0x41])]), 'refused'],
  'a gzip member past zeros past it': [Buffer.concat([tgzOfJson(APP), Buffer.alloc(2), gzipSync(new Uint8Array(0))]), 'refused'],
  'data past its tar': [gzipSync(Buffer.concat([pack(entriesOf(APP)), Buffer.alloc(512, 0x41)])), 'refused'],
  'a lone zero block': [gzipSync(pack(entriesOf(APP), { blocking: 1 }).subarray(0, -512)), 'refused'],
  'no end marker': [gzipSync(unended(entriesOf(APP))), 'refused'],
  'a truncated tar': [gzipSync(pack(entriesOf(APP)).subarray(0, 1300)), 'refused'],
  'a truncated gzip stream': [tgzOfJson(APP).subarray(0, -6), 'refused'],
  // The lockfile's header's name field, past its NUL; the first byte past its data.
  'a header of another checksum': [gzipSync(corrupted(pack(entriesOf(APP)), 99, 0x41)), 'refused'],
  'padding that is not zero': [gzipSync(corrupted(pack(entriesOf(APP)), 512 + entriesOf(APP)[0].data.length, 0x41)), 'refused'],
  'no gzip stream': [brotliCompressSync(JSON.stringify(APP)), 'refused'],
}

// A tar of `json`'s lockfile, `edit`ed, and its files, but `skip`'s, then `extra`.
function lockedTar(json, skip = [], edit = () => {}, extra = []) {
  const bundle = Bundle.parse(JSON.stringify(json))
  const lock = JSON.parse(lockfileFromBundle(bundle).serialize())
  edit(lock)
  const files = [...bundle.sources].filter(([file]) => !skip.includes(file)).map(([name, data]) => ({ name, data: bytes(data) }))
  return [{ name: 'stasis.lock.json', data: bytes(JSON.stringify(lock)) }, ...files, ...extra]
}

function corrupted(tar, at, byte) {
  const copy = Uint8Array.from(tar)
  copy[at] = byte
  return copy
}

for (const [name, [tgz, outcome]] of Object.entries(TGZ_CASES)) {
  test(`stasis-extract.mjs as stasis extract, of a .stasis.tgz: ${name}`, withTmp((t, tmp) => {
    writeFileSync(join(tmp, 'app.stasis.tgz'), tgz)
    assertParity(t, tmp, join(tmp, 'app.stasis.tgz'), outcome)
  }))
}

const gnuTar = spawnSync('tar', ['--version'], { encoding: 'utf-8' }).stdout?.startsWith('tar (GNU tar)')

test('stasis-extract.mjs as stasis extract, of a .stasis.tgz GNU tar packs of what stasis extract --lock=add writes, refusing a link in it', { skip: !gnuTar && 'no GNU tar' }, withTmp((t, tmp) => {
  const tree = join(tmp, 'tree')
  writeFileSync(join(tmp, 'app.stasis.tgz'), tgzOfJson(v1({ ...APP.sources['.'].files, [LONG]: 'x\n' }, { executable: ['bin/run.sh'], modules: dep({ 'index.js': '1\n' }) })))
  t.mock.method(console, 'warn', () => {})
  extractCommand({ bundleFile: join(tmp, 'app.stasis.tgz'), output: tree, lock: 'add' })
  console.warn.mock.restore()
  let n = 0
  const packed = (args, outcome) => {
    const dir = join(tmp, `${n++}`)
    mkdirSync(dir)
    const r = spawnSync('tar', ['-czf', join(dir, 'app.stasis.tgz'), '-C', tree, ...args], { encoding: 'utf-8' })
    t.assert.equal(r.status, 0, r.stderr)
    assertParity(t, dir, join(dir, 'app.stasis.tgz'), outcome)
  }
  for (const format of ['gnu', 'posix']) packed([`--format=${format}`, '.'], 'extracted')
  packed(['stasis.lock.json', 'src', 'bin', 'node_modules'], 'extracted')
  symlinkSync('a.js', join(tree, 'src', 'link.js'))
  packed(['.'], 'refused')
  rmSync(join(tree, 'src', 'link.js'))
  linkSync(join(tree, 'src', 'a.js'), join(tree, 'src', 'b.js'))
  packed(['.'], 'refused')
}))

// An extended header of `type` ('x', 'g') and its pax records, as a tar holds it.
function extended(type, records) {
  const body = Buffer.from(records.map(([key, value]) => {
    const line = ` ${key}=${value}\n`
    return `${line.length + String(line.length + 2).length}${line}`
  }).join(''))
  const header = Buffer.alloc(512)
  header.write('PaxHeaders/x', 0, 'latin1')
  header.write('0000644\0', 100, 'latin1')
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  header.write(type, 156, 'latin1')
  header.write('ustar\u000000', 257, 'latin1')
  header.fill(0x20, 148, 156)
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return Buffer.concat([header, body, Buffer.alloc(512 - (body.length % 512 || 512))])
}

test('stasis-extract.mjs refuses, where stasis takes them, a tar repeating an entry as it was, a pax record it does not read, and a global header', withTmp((t, tmp) => {
  const entries = entriesOf(APP)
  const cases = [
    [Buffer.concat([unended(entries), pack([entries[1]])]), 'its tar holds bin/run.sh twice, or as a file and a directory'],
    [Buffer.concat([unended(entries.slice(0, 1)), extended('x', [['comment', 'hi'], ['path', 'bin/run.sh']]), pack(entries.slice(1))]), 'the pax record "comment" at byte'],
    [Buffer.concat([extended('g', [['comment', 'hi']]), pack(entries)]), 'the entry at byte 0 is of type "g"'],
  ]
  t.mock.method(console, 'warn', () => {})
  for (const [i, [tar, message]] of cases.entries()) {
    const bundleFile = join(tmp, `${i}.stasis.tgz`)
    writeFileSync(bundleFile, gzipSync(tar))
    t.assert.equal(extractCommand({ bundleFile, output: join(tmp, `${i}-stasis`), lock: 'none' }).files, 3, message)
    const r = runScript(['-o', join(tmp, `${i}-script`), bundleFile])
    t.assert.equal(r.status, 1, message)
    t.assert.ok(r.stderr.includes(`extract: not a valid stasis bundle: ${bundleFile}`) && r.stderr.includes(message), r.stderr)
    t.assert.ok(!existsSync(join(tmp, `${i}-script`)))
  }
}))

test('stasis-extract.mjs refuses a tgz of another name, anything else under its name, and a <name>.stasis.lock.json for <name>.stasis.tgz', withTmp((t, tmp) => {
  const tgz = tgzOfJson(APP)
  for (const name of ['app.tgz', 'app.stasis.code.br']) {
    writeFileSync(join(tmp, name), tgz)
    const r = runScript(['-o', join(tmp, 'out'), join(tmp, name)])
    t.assert.equal(r.status, 1, name)
    t.assert.ok(r.stderr.includes(`extract: ${join(tmp, name)} is a tgz, which is read as stasis.tgz or <name>.stasis.tgz alone`), r.stderr)
  }
  writeFileSync(join(tmp, 'br.stasis.tgz'), brotliCompressSync(JSON.stringify(APP)))
  const brotli = runScript(['-o', join(tmp, 'out'), join(tmp, 'br.stasis.tgz')])
  t.assert.equal(brotli.status, 1)
  t.assert.match(brotli.stderr, /extract: not a valid stasis bundle: .*br\.stasis\.tgz[^]*incorrect header check/u)
  t.assert.ok(!existsSync(join(tmp, 'out')))

  const out = join(tmp, 'locked')
  mkdirSync(out)
  writeFileSync(join(out, 'app.stasis.lock.json'), '{}')
  writeFileSync(join(tmp, 'app.stasis.tgz'), tgz)
  const locked = runScript(['-o', out, join(tmp, 'app.stasis.tgz')])
  t.assert.equal(locked.status, 1)
  t.assert.ok(locked.stderr.includes(`extract: unexpected ${join(out, 'app.stasis.lock.json')}: no lockfile support here`), locked.stderr)
  writeFileSync(join(tmp, 'stasis.tgz'), tgz)
  const bare = runScript(['-o', out, join(tmp, 'stasis.tgz')])
  t.assert.equal(bare.status, 0, bare.stderr)
  t.assert.deepStrictEqual(readdirSync(out).toSorted(), ['app.stasis.lock.json', 'bin', 'node_modules', 'src'])
}))
