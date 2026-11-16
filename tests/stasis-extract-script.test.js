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
