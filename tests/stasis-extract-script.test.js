import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync } from 'node:zlib'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { extractCommand } from '@exodus/stasis-core/extract'
import { withTmp } from './tmp.helper.js'

// scripts/stasis-extract.mjs is a self-contained copy of `stasis extract --lock=none`, without lockfile
// support. Each case extracts one bundle both ways, into two output dirs set up alike, and holds the
// script to the command: both refuse with the same error, or both write the same tree.
const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'stasis-extract.mjs')
const solFixtures = join(here, 'fixtures', 'solidity-bundle')

const runScript = (args, opts = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8', ...opts })

const v1 = (files, extra = {}) => ({
  version: 1,
  config: { scope: 'full' },
  entries: [],
  sources: { '.': { name: 'app', files } },
  modules: {},
  formats: {},
  imports: {},
  ...extra,
})
const raw = (json) => brotliCompressSync(JSON.stringify(json))

// Every entry under `dir`: its kind, and a file's bytes and mode, a symlink's target.
function snapshot(dir, prefix = '') {
  const out = {}
  for (const name of readdirSync(dir).toSorted()) {
    const abs = join(dir, name)
    const rel = prefix + name
    const stats = lstatSync(abs)
    if (stats.isSymbolicLink()) out[rel] = { link: readlinkSync(abs) }
    else if (stats.isDirectory()) Object.assign(out, { [rel]: 'dir' }, snapshot(abs, `${rel}/`))
    else out[rel] = { bytes: readFileSync(abs).toString('base64'), mode: (stats.mode & 0o7777).toString(8) }
  }
  return out
}

// Extracts `bundleFile` with extractCommand (--lock=none) into `<tmp>/a` and with the script into `<tmp>/b`,
// each set up by `setup(dir)` first, and asserts the same outcome. -> the script's run
function assertParity(t, tmp, bundleFile, { setup = () => {}, outcome } = {}) {
  const [a, b] = [join(tmp, 'a'), join(tmp, 'b')]
  for (const dir of [a, b]) {
    mkdirSync(dir)
    setup(dir)
  }
  let expected = null
  t.mock.method(console, 'warn', () => {})
  try {
    expected = extractCommand({ bundleFile, output: a, lock: 'none' })
  } catch (error) {
    expected = { error }
  } finally {
    console.warn.mock.restore()
  }
  const r = runScript(['-o', b, bundleFile])
  if (expected.error) {
    t.assert.equal(r.status, 1, `the script must refuse as extract does (${expected.error.message}); stderr: ${r.stderr}`)
    t.assert.ok(r.stderr.includes(`Error: ${expected.error.message}\n`), `stderr: ${r.stderr}`)
    const cause = expected.error.cause?.message
    if (cause) t.assert.ok(r.stderr.includes(cause), `the script's error must carry extract's cause (${cause}); stderr: ${r.stderr}`)
  } else {
    t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    t.assert.match(r.stderr, new RegExp(String.raw`^\[stasis-extract\] Extracted ${expected.files} file\(s\)`, 'mu'))
  }
  if (outcome) t.assert.equal(expected.error ? 'refused' : 'extracted', outcome, expected.error?.message)
  t.assert.deepStrictEqual(snapshot(b), snapshot(a))
  return r
}

// Raw bundle JSON, accepted and refused, the adversarial shapes a real build never writes included.
const RAW_CASES = {
  'a plain v1 bundle': [v1({ 'src/a.js': 'a\n', 'src/deep/b.json': '{}\n' }, { entries: ['src/a.js'] }), 'extracted'],
  'an empty bundle': [v1({}), 'extracted'],
  'executable files, and an execute bit the bundle does not attest dropped': [v1({ 'bin/run.sh': '#!/bin/sh\n', 'lib/x.sh': 'x\n' }, {
    formats: { 'bin/run.sh': 'shell', 'lib/x.sh': 'shell' },
    executable: ['bin/run.sh'],
  }), 'extracted'],
  'resources, raw and base64': [v1({ 'a.txt': 'plain', 'b.bin': Buffer.from([0, 255, 1, 128]).toString('base64') }, {
    formats: { 'a.txt': 'resource', 'b.bin': 'resource:base64' },
  }), 'extracted'],
  'non-canonical base64': [v1({ 'b.bin': 'AAE=!' }, { formats: { 'b.bin': 'resource:base64' } }), 'refused'],
  'a scope=node_modules bundle': [{
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/foo': { name: 'foo', version: '1.2.3', files: { 'index.js': '1\n' } } },
    formats: {},
    imports: {},
  }, 'extracted'],
  'a legacy v0 bundle, its executable ignored': [{
    version: 0,
    config: { scope: 'full' },
    sources: { 'src/a.js': 'x\n', 'node_modules/foo/index.js': 'y\n', 'node_modules/@s/p/i.js': 'z\n' },
    formats: {},
    imports: {},
    executable: ['src/a.js'],
  }, 'extracted'],
  'a directory listing, skipped': [{
    ...v1({ 'src/assets/a.txt': 'A', 'src/assets': '["a.txt"]' }),
    modules: { 'node_modules/dep': { name: 'dep', version: '2.0.0', files: { '': '["index.js"]', 'index.js': '1\n' } } },
    formats: { 'src/assets': 'directory', 'src/assets/a.txt': 'resource', 'node_modules/dep': 'directory' },
  }, 'extracted'],
  'names beginning with ".."': [v1({ '..foo/a.js': '1', '...': '2', 'x/..bar': '3' }), 'extracted'],
  'a __proto__ file name': [JSON.parse('{"version":1,"config":{"scope":"full"},"sources":{".":{"name":"app","files":{"__proto__":"p\\n"}}},"modules":{},"formats":{},"imports":{}}'), 'extracted'],
  'metadata: repo, package, vendored and subpackages': [{
    ...v1({ 'a.js': '1' }),
    repo: { github: 'o/r', directory: 'pkg', commit: 'a'.repeat(40) },
    package: { npm: { name: 'app', version: '1.0.0' } },
    modules: {
      'node_modules/next': {
        name: 'next',
        version: '1.0.0',
        repo: { github: 'vercel/next.js' },
        vendored: { 'dist/compiled/react-is': { name: 'react-is', version: '19.0.0' } },
        subpackages: { sub: { name: 'next/sub' } },
        files: { 'dist/compiled/react-is/index.js': '1', 'sub/index.js': '2' },
      },
    },
  }, 'extracted'],
  'an older stasis\'s repo root': [{ ...v1({ 'a.js': '1' }), repo: { github: 'o/r', root: true } }, 'extracted'],

  'a path escaping the output dir': [{ ...v1({}), sources: { 'x/../../../escape': { name: 'e', files: { 'p.js': '1' } } } }, 'refused'],
  'a sibling sharing the output dir name as a prefix': [{ ...v1({}), sources: { '../a-sibling': { name: 'e', files: { 'p.js': '1' } } } }, 'refused'],
  'an absolute path': [v1({ '/etc/x': '1' }), 'refused'],
  'a backslash': [v1({ 'a\\b.js': '1' }), 'refused'],
  'an empty file name': [v1({ 'src/': '1' }), 'refused'],
  'a mid-path "."': [v1({ 'src/./a.js': '1' }), 'refused'],
  'a rel of "" outside a directory listing': [{ ...v1({}), modules: { 'node_modules/foo': { name: 'foo', version: '1', files: { '': 'x' } } } }, 'refused'],
  'duplicate paths across buckets': [{
    ...v1({ 'node_modules/foo/a.js': '1' }),
    modules: { 'node_modules/foo': { name: 'foo', version: '1', files: { 'a.js': '1' } } },
  }, 'refused'],
  'a path used as both file and directory': [{
    ...v1({}),
    modules: { 'node_modules/foo': { name: 'foo', version: '1', files: { bar: 'x', 'bar/baz.js': 'y' } } },
  }, 'refused'],
  'non-string content': [{ ...v1({}), modules: { 'node_modules/foo': { name: 'foo', version: '1', files: { 'x.js': 42 } } } }, 'refused'],
  'a stasis.lock.json': [v1({ 'sub/STASIS.LOCK.JSON': '{}' }), 'refused'],
  'a v0 stasis.lock.json': [{ version: 0, config: { scope: 'full' }, sources: { 'stasis.lock.json': '{}' }, formats: {}, imports: {} }, 'refused'],
  'content for a payload-free stat record': [v1({ 'a.js': '1' }, { formats: { 'a.js': 'stat:file' } }), 'refused'],
  'an unknown format': [v1({ 'a.js': '1' }, { formats: { 'a.js': 'cobol' } }), 'refused'],
  'formats aliasing "" and "."': [v1({}, { formats: { '': 'directory', '.': 'directory' } }), 'refused'],
  'an executable naming no file': [v1({ 'a.js': '1' }, { executable: ['b.js'] }), 'refused'],
  'an executable listed twice': [v1({ 'a.js': '1' }, { executable: ['a.js', 'a.js'] }), 'refused'],
  'an executable directory listing': [v1({ d: '[]' }, { formats: { d: 'directory' }, executable: ['d'] }), 'refused'],
  'an executable outside node_modules in a node_modules-scope bundle': [{
    version: 1,
    config: { scope: 'node_modules' },
    modules: { 'node_modules/foo': { name: 'foo', version: '1', files: { 'a.js': '1' } } },
    formats: {},
    imports: {},
    executable: ['a.js'],
  }, 'refused'],
  'entries listed twice': [v1({ 'a.js': '1' }, { entries: ['a.js', 'a.js'] }), 'refused'],
  'an escaping import': [v1({ 'a.js': '1' }, { imports: { '*': { 'a.js': { x: '../x.js' } } } }), 'refused'],
  'an empty platform map import': [v1({ 'a.js': '1' }, { imports: { '*': { 'a.js': { x: {} } } } }), 'refused'],
  'a node_modules bucket without a version': [{ ...v1({}), modules: { 'node_modules/foo': { name: 'foo', files: { 'a.js': '1' } } } }, 'refused'],
  'a workspace bucket under node_modules': [{ ...v1({}), sources: { 'node_modules/foo': { name: 'foo', files: { 'a.js': '1' } } } }, 'refused'],
  'sources in a node_modules-scope bundle': [{ version: 1, config: { scope: 'node_modules' }, sources: {}, formats: {}, imports: {} }, 'refused'],
  'an unknown scope': [{ ...v1({}), config: { scope: 'all' } }, 'refused'],
  'an unknown version': [{ ...v1({}), version: 2 }, 'refused'],
  'a bad bundle repo': [{ ...v1({}), repo: { github: 'not a repo' } }, 'refused'],
  'an unknown bundle repo key': [{ ...v1({}), repo: { github: 'o/r', branch: 'main' } }, 'refused'],
  'a bad bundle package': [{ ...v1({}), package: { npm: { name: 'a b' } } }, 'refused'],
  'a repo on a workspace bucket': [{ ...v1({}), sources: { '.': { name: 'app', repo: { github: 'o/r' }, files: {} } } }, 'refused'],
  'a dependency repo without github': [{ ...v1({}), modules: { 'node_modules/foo': { name: 'foo', version: '1', repo: { commit: 'a'.repeat(40) }, files: { 'a.js': '1' } } } }, 'refused'],
  'vendored holding none of the files': [{ ...v1({}), modules: { 'node_modules/foo': { name: 'foo', version: '1', vendored: { v: { name: 'v' } }, files: { 'a.js': '1' } } } }, 'refused'],
  'a misnamed subpackage': [{ ...v1({}), modules: { 'node_modules/foo': { name: 'foo', version: '1', subpackages: { s: { name: 'bar/s' } }, files: { 's/a.js': '1' } } } }, 'refused'],
  'a non-string ecosystem': [{ ...v1({}), modules: { 'node_modules/foo': { name: 'foo', version: '1', ecosystem: 1, files: { 'a.js': '1' } } } }, 'refused'],
  'JSON null': [null, 'refused'],
}

for (const [name, [json, outcome]] of Object.entries(RAW_CASES)) {
  test(`stasis-extract.mjs matches stasis extract: ${name}`, withTmp((t, tmp) => {
    const bundleFile = join(tmp, 'bundle.code.br')
    writeFileSync(bundleFile, raw(json))
    assertParity(t, tmp, bundleFile, { outcome })
  }))
}

test('stasis-extract.mjs matches stasis extract: bytes that are no bundle, or carry trailing junk', withTmp((t, tmp) => {
  for (const [name, bytes] of Object.entries({
    garbage: Buffer.from('not brotli at all'),
    'not JSON': brotliCompressSync('{'),
    'trailing junk': Buffer.concat([raw(v1({ 'a.js': '1' })), Buffer.from('junk')]),
  })) {
    const dir = join(tmp, name)
    mkdirSync(dir)
    const bundleFile = join(dir, 'bundle.code.br')
    writeFileSync(bundleFile, bytes)
    assertParity(t, dir, bundleFile, { outcome: 'refused' })
  }
}))

for (const [fixture, extra] of [['basic', {}], ['with-node-modules', { mappingFile: 'remappings.txt' }]]) {
  test(`stasis-extract.mjs matches stasis extract on a real bundle: ${fixture}`, withTmp(async (t, tmp) => {
    const bundleFile = join(tmp, 'out.code.br')
    await bundleCommand({ cwd: join(solFixtures, fixture), entries: ['src/A.sol'], output: bundleFile, ...extra })
    assertParity(t, tmp, bundleFile, { outcome: 'extracted' })
  }))
}

// What is already in the output dir: each setup is applied to both dirs before the extract.
const BUNDLE = v1({ 'src/a.js': 'a\n', 'bin/run.sh': '#!/bin/sh\n' }, { formats: { 'bin/run.sh': 'shell' }, executable: ['bin/run.sh'] })
const DISK_CASES = {
  'files already holding their bytes, a 0600 one and a stray execute bit included': [(dir) => {
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'src/a.js'), 'a\n', { mode: 0o755 })
    chmodSync(join(dir, 'src/a.js'), 0o755)
    writeFileSync(join(dir, 'bin/run.sh'), '#!/bin/sh\n')
    chmodSync(join(dir, 'bin/run.sh'), 0o600)
  }, 'extracted'],
  'a symlink to a file holding its bytes': [(dir) => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'real.js'), 'a\n')
    symlinkSync('../real.js', join(dir, 'src/a.js'))
  }, 'extracted'],
  'a file with other content': [(dir) => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src/a.js'), 'other\n')
  }, 'refused'],
  'a directory where a file goes': [(dir) => mkdirSync(join(dir, 'src/a.js'), { recursive: true }), 'refused'],
  'a file where a directory goes': [(dir) => writeFileSync(join(dir, 'src'), ''), 'refused'],
  'a dangling symlink where a file goes': [(dir) => {
    mkdirSync(join(dir, 'src'))
    symlinkSync('nowhere', join(dir, 'src/a.js'))
  }, 'refused'],
  'a dangling symlink where a directory goes': [(dir) => symlinkSync('nowhere', join(dir, 'bin')), 'refused'],
}

for (const [name, [setup, outcome]] of Object.entries(DISK_CASES)) {
  test(`stasis-extract.mjs matches stasis extract over ${name}`, withTmp((t, tmp) => {
    const bundleFile = join(tmp, 'bundle.code.br')
    writeFileSync(bundleFile, raw(BUNDLE))
    assertParity(t, tmp, bundleFile, { setup, outcome })
  }))
}

test('stasis-extract.mjs matches stasis extract: never writes over the bundle it reads', withTmp((t, tmp) => {
  const bundleFile = join(tmp, 'bundle.code.br')
  writeFileSync(bundleFile, raw(BUNDLE))
  const setup = (dir) => {
    mkdirSync(join(dir, 'src'))
    linkSync(bundleFile, join(dir, 'src/a.js'))
  }
  assertParity(t, tmp, bundleFile, { setup, outcome: 'refused' })
}))

test('stasis-extract.mjs refuses an output dir that is a file, as stasis extract does', withTmp((t, tmp) => {
  const bundleFile = join(tmp, 'bundle.code.br')
  writeFileSync(bundleFile, raw(BUNDLE))
  writeFileSync(join(tmp, 'out'), '')
  const r = runScript(['--output', join(tmp, 'out'), bundleFile])
  t.assert.equal(r.status, 1)
  t.assert.ok(r.stderr.includes(`Error: extract: output dir ${join(tmp, 'out')} is not a directory\n`), r.stderr)
}))

test('stasis-extract.mjs refuses a stasis.lock.json in the output dir, a dangling symlink included, writing nothing', withTmp((t, tmp) => {
  const bundleFile = join(tmp, 'bundle.code.br')
  writeFileSync(bundleFile, raw(BUNDLE))
  for (const [name, plant] of Object.entries({
    file: (lock) => writeFileSync(lock, '{}'),
    'dangling symlink': (lock) => symlinkSync('nowhere', lock),
  })) {
    const out = join(tmp, name)
    mkdirSync(out)
    const lock = join(out, 'stasis.lock.json')
    plant(lock)
    const r = runScript(['-o', out, bundleFile])
    t.assert.equal(r.status, 1, name)
    t.assert.match(r.stderr, /Error: extract: unexpected .*stasis\.lock\.json: stasis-extract has no lockfile support/, name)
    t.assert.deepStrictEqual(readdirSync(out), ['stasis.lock.json'], `${name}: nothing may be written`)
  }
  // The cwd's, when no --output is given.
  const r = runScript([bundleFile], { cwd: join(tmp, 'file') })
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /no lockfile support/)
}))

test('stasis-extract.mjs refuses the <name>.stasis.lock.json of a <name>.stasis.code.br bundle, writing nothing', withTmp((t, tmp) => {
  const bundleFile = join(tmp, 'app.stasis.code.br')
  writeFileSync(bundleFile, raw(BUNDLE))
  for (const [name, plant] of Object.entries({
    file: (lock) => writeFileSync(lock, '{}'),
    'dangling symlink': (lock) => symlinkSync('nowhere', lock),
  })) {
    const out = join(tmp, name)
    mkdirSync(out)
    plant(join(out, 'app.stasis.lock.json'))
    const r = runScript(['-o', out, bundleFile])
    t.assert.equal(r.status, 1, name)
    t.assert.ok(r.stderr.includes(`Error: extract: unexpected ${join(out, 'app.stasis.lock.json')}: stasis-extract has no lockfile support`), `${name}: ${r.stderr}`)
    t.assert.deepStrictEqual(readdirSync(out), ['app.stasis.lock.json'], `${name}: nothing may be written`)
  }
  // The cwd's, when no --output is given.
  const r = runScript([bundleFile], { cwd: join(tmp, 'file') })
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /app\.stasis\.lock\.json: stasis-extract has no lockfile support/)
}))

test('stasis-extract.mjs extracts beside a lockfile of another bundle\'s name', withTmp((t, tmp) => {
  // Neither another <name>'s lockfile, nor one a bundle not named *.stasis.code.br would pair with, is the bundle's.
  for (const [bundleName, lockName] of [['app.stasis.code.br', 'other.stasis.lock.json'], ['app.code.br', 'app.stasis.lock.json'], ['app.stasis.code.br', 'app.lock.json']]) {
    const dir = join(tmp, `${bundleName}-${lockName}`)
    const out = join(dir, 'out')
    mkdirSync(out, { recursive: true })
    const bundleFile = join(dir, bundleName)
    writeFileSync(bundleFile, raw(BUNDLE))
    writeFileSync(join(out, lockName), '{}')
    const r = runScript(['-o', out, bundleFile])
    t.assert.equal(r.status, 0, `${bundleName} beside ${lockName}: ${r.stderr}`)
    t.assert.equal(readFileSync(join(out, 'src/a.js'), 'utf8'), 'a\n')
  }
}))

test('stasis-extract.mjs refuses a <name>.stasis.code.br bundle that writes its own <name>.stasis.lock.json, writing nothing', withTmp((t, tmp) => {
  const bundleFile = join(tmp, 'app.stasis.code.br')
  writeFileSync(bundleFile, raw(v1({ 'src/a.js': 'a\n', 'app.stasis.lock.json': '{}' })))
  const out = join(tmp, 'out')
  mkdirSync(out)
  const r = runScript(['-o', out, bundleFile])
  t.assert.equal(r.status, 1)
  t.assert.ok(r.stderr.includes('Error: extract: app.stasis.lock.json is the lockfile of app.stasis.code.br, which stasis-extract never writes\n'), r.stderr)
  t.assert.deepStrictEqual(readdirSync(out), [])
  // Only the output dir's: one further down pairs with no bundle there.
  writeFileSync(bundleFile, raw(v1({ 'sub/app.stasis.lock.json': '{}' })))
  const nested = runScript(['-o', out, bundleFile])
  t.assert.equal(nested.status, 0, nested.stderr)
  t.assert.equal(readFileSync(join(out, 'sub/app.stasis.lock.json'), 'utf8'), '{}')
}))

test('stasis-extract.mjs extracts into the cwd by default and writes no lockfile', withTmp((t, tmp) => {
  const bundleFile = join(tmp, 'bundle.code.br')
  writeFileSync(bundleFile, raw(BUNDLE))
  const out = join(tmp, 'out')
  mkdirSync(out)
  const r = runScript([bundleFile], { cwd: out })
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.equal(r.stderr, `[stasis-extract] Extracted 2 file(s) (1 executable) to ${out}\n`)
  t.assert.equal(readFileSync(join(out, 'src/a.js'), 'utf8'), 'a\n')
  t.assert.ok(!existsSync(join(out, 'stasis.lock.json')))
  // Re-extracting the same bundle is a no-op.
  const again = runScript(['--output=out', bundleFile], { cwd: tmp })
  t.assert.equal(again.status, 0, again.stderr)
  t.assert.match(again.stderr, /Extracted 2 file\(s\) \(1 executable, 2 already in place\)/)
}))

test('stasis-extract.mjs: usage', withTmp((t, tmp) => {
  for (const flag of ['--help', '-h']) {
    const r = runScript([flag])
    t.assert.equal(r.status, 0)
    t.assert.match(r.stderr, /^Usage:\n stasis-extract \[--output=path\/to\/dir\] path\/to\/bundle\.stasis\.code\.br/u)
  }
  for (const [args, message] of [
    [[], 'Nothing to extract: no bundle file given'],
    [['a.br', 'b.br'], 'Error: extract takes exactly one bundle file'],
    [['a.br', '--output=x'], 'Error: extract takes exactly one bundle file'],
    [['--lock=none', 'a.br'], "Error: Unknown option '--lock'"],
    [['--output'], "Error: Option '-o, --output <value>' argument missing"],
  ]) {
    const r = runScript(args, { cwd: tmp })
    t.assert.equal(r.status, 1, args.join(' '))
    t.assert.ok(r.stderr.startsWith(`${message}`), `${args.join(' ')}: ${r.stderr}`)
    t.assert.match(r.stderr, /Run 'stasis-extract --help' for usage\.\n$/u)
  }
  const missing = runScript(['nope.br'], { cwd: tmp })
  t.assert.equal(missing.status, 1)
  t.assert.ok(missing.stderr.includes(`Error: extract: bundle file not found: ${join(tmp, 'nope.br')}\n`), missing.stderr)
}))
