import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { classifyFormat } from '@exodus/stasis-core/util'
import { buildBundle, buildTealBundle } from '../stasis/src/cmd/bundle.js'
import { bundlePlan } from '../stasis/src/cmd/bundle-options.js'
import { buildTealTree, collectTealFilesFromDisk } from '../stasis/src/loaders/teal.js'
import { withTmp } from './tmp.helper.js'
import { captureWarnings, captureWarningsAsync } from './warnings.helper.js'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')

// The environment with no inherited stasis setting, which the CLI would refuse beside its flags.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))

const runCli = async (args, opts = {}) => {
  const child = spawn(process.execPath, [cli, ...args], { env: cleanEnv, ...opts })
  child.stdin.end()
  const stdout = []
  const stderr = []
  child.stdout.on('data', (d) => stdout.push(d))
  child.stderr.on('data', (d) => stderr.push(d))
  const [status] = await once(child, 'close')
  return { status, stdout: Buffer.concat(stdout), stderr: stripVTControlCharacters(Buffer.concat(stderr).toString('utf8')) }
}

// Write `files` (a path from `dir` -> its content) under `dir`, with their directories.
const writeTree = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
}

// An app's two programs, as AlgoKit lays out what Puya compiles: the approval program with a macro
// and a comment naming another program, which TEAL can't import.
const APPROVAL = [
  '#pragma version 10',
  '#define ONE int 1',
  '// deploys ./Child.approval.teal by its compiled bytes, not by its path',
  'txn ApplicationID',
  'bz create',
  'ONE',
  'return',
  'create:',
  'ONE',
  'return',
  '',
].join('\n')
const CLEAR = '#pragma version 10\nint 1\nreturn\n'
const app = (dir) => writeTree(dir, {
  'artifacts/Counter/Counter.approval.teal': APPROVAL,
  'artifacts/Counter/Counter.clear.teal': CLEAR,
  'artifacts/Counter/Child.approval.teal': CLEAR,
})
const ENTRIES = ['artifacts/Counter/Counter.approval.teal', 'artifacts/Counter/Counter.clear.teal']

test('.teal is the teal code format', (t) => {
  t.assert.equal(classifyFormat('contracts/App.approval.teal'), 'teal')
  t.assert.equal(classifyFormat('App.TEAL'), 'teal')
})

test('collectTealFilesFromDisk reads each entry as written, and buildTealTree gives it no edges', withTmp((t, tmp) => {
  app(tmp)
  const sources = collectTealFilesFromDisk(tmp, [...ENTRIES, ENTRIES[0]])
  t.assert.deepStrictEqual([...sources.keys()], ENTRIES)
  t.assert.equal(sources.get(ENTRIES[0]), APPROVAL)
  const { resolutions } = buildTealTree(sources)
  t.assert.deepStrictEqual([...resolutions].map(([path, edges]) => [path, edges.size]), ENTRIES.map((path) => [path, 0]))
}))

test('buildTealBundle carries its entries alone, each a teal file with no imports', withTmp(async (t, tmp) => {
  app(tmp)
  const bundle = await buildTealBundle({ cwd: tmp, entries: ENTRIES })

  t.assert.ok(bundle instanceof Bundle)
  t.assert.deepStrictEqual(bundle.config, { scope: 'full' })
  t.assert.deepStrictEqual([...bundle.entries], ENTRIES)
  // Child.approval.teal, which the comment names, is no import: not bundled.
  t.assert.deepStrictEqual([...bundle.sources.keys()].toSorted(), ENTRIES)
  t.assert.equal(bundle.sources.get(ENTRIES[0]), APPROVAL)
  t.assert.equal(bundle.sources.get(ENTRIES[1]), CLEAR)
  // No package.json: the workspace bucket's placeholder identity.
  t.assert.deepStrictEqual([...bundle.modules.keys()], ['.'])
  t.assert.equal(bundle.modules.get('.').name, 'teal-bundle')
  t.assert.equal(bundle.modules.get('.').version, '0.0.0')
  t.assert.deepStrictEqual([...bundle.formats.values()], ['teal', 'teal'])
  t.assert.deepStrictEqual([...bundle.imports.keys()], ['teal'])
  t.assert.deepStrictEqual([...bundle.imports.get('teal')].map(([path, edges]) => [path, edges.size]).toSorted(), ENTRIES.map((path) => [path, 0]))
  t.assert.deepStrictEqual(bundle.reason.bundle.toSorted(), ENTRIES)
  // It round-trips.
  t.assert.equal(Bundle.parse(bundle.serialize()).serialize(), bundle.serialize())
}))

test('buildTealBundle buckets by the nearest package.json, and records an execute bit', withTmp(async (t, tmp) => {
  writeTree(tmp, { 'package.json': '{ "name": "my-app", "version": "2.1.0" }\n', 'a.teal': CLEAR })
  chmodSync(join(tmp, 'a.teal'), 0o755)
  const bundle = await buildTealBundle({ cwd: tmp, entries: ['a.teal'] })
  t.assert.equal(bundle.modules.get('.').name, 'my-app')
  t.assert.equal(bundle.modules.get('.').version, '2.1.0')
  if (process.platform !== 'win32') t.assert.deepStrictEqual([...bundle.executable], ['a.teal'])
}))

test('buildTealBundle refuses a missing entry', withTmp(async (t, tmp) => {
  app(tmp)
  const { warnings } = await captureWarningsAsync(() => t.assert.rejects(
    () => buildTealBundle({ cwd: tmp, entries: [ENTRIES[0], 'artifacts/Gone.approval.teal'] }),
    /^Error: TEAL bundle has unresolved programs:\n {2}Missing entry: artifacts\/Gone\.approval\.teal$/u,
  ))
  t.assert.deepStrictEqual(warnings, ['[loader.teal] Missing file: artifacts/Gone.approval.teal'])
}))

test('buildTealBundle refuses a program that is not UTF-8', withTmp(async (t, tmp) => {
  writeTree(tmp, { 'a.teal': Buffer.from([0x69, 0x6e, 0x74, 0x20, 0x31, 0x0a, 0xff, 0x0a]) })
  await t.assert.rejects(() => buildTealBundle({ cwd: tmp, entries: ['a.teal'] }), /TEAL program is not valid UTF-8: a\.teal/u)
}))

test('buildTealBundle refuses a symlink out of the bundle root, and follows one in it', { skip: process.platform === 'win32' }, withTmp(async (t, tmp) => {
  writeTree(tmp, { 'outside/secret.teal': CLEAR, 'root/real/a.teal': CLEAR })
  symlinkSync(join(tmp, 'outside', 'secret.teal'), join(tmp, 'root', 'escape.teal'))
  symlinkSync(join('real', 'a.teal'), join(tmp, 'root', 'linked.teal'))
  const root = join(tmp, 'root')
  await t.assert.rejects(() => buildTealBundle({ cwd: root, entries: ['escape.teal'] }), /Refusing to follow symlink escaping bundle root: escape\.teal/u)
  const bundle = await buildTealBundle({ cwd: root, entries: ['linked.teal'] })
  t.assert.equal(bundle.sources.get('linked.teal'), CLEAR)
}))

test('collectTealFilesFromDisk leaves out an entry that is no regular file, warning', { skip: process.platform === 'win32' }, withTmp((t, tmp) => {
  mkdirSync(join(tmp, 'dir.teal'))
  const { result, warnings } = captureWarnings(() => collectTealFilesFromDisk(tmp, ['dir.teal']))
  t.assert.equal(result.size, 0)
  t.assert.deepStrictEqual(warnings, ['[loader.teal] Not a regular file: dir.teal'])
}))

test('buildTealBundle refuses an entry that is no .teal file', async (t) => {
  await t.assert.rejects(() => buildTealBundle({ entries: [] }), /at least one entry \.teal file is required/u)
  await t.assert.rejects(() => buildTealBundle({ entries: ['a.teal', 'b.sh'] }), /buildTealBundle: not a \.teal file: b\.sh/u)
})

test('buildBundle builds .teal entries as a TEAL bundle, and refuses them beside another language', withTmp(async (t, tmp) => {
  app(tmp)
  const bundle = await buildBundle({ cwd: tmp, entries: ENTRIES })
  t.assert.deepStrictEqual([...bundle.formats.values()], ['teal', 'teal'])
  t.assert.deepStrictEqual([...bundle.imports.keys()], ['teal'])
  await t.assert.rejects(
    () => buildBundle({ cwd: tmp, entries: [ENTRIES[0], 'index.js'] }),
    /entries must all be \.sol, all be \.php, all be \.js\/\.cjs\/\.mjs\/\.ts\/\.cts\/\.mts\/\.jsx\/\.tsx, all be \.sh\/\.bash, all be \.rs, or all be \.teal \(no mixing\)/u,
  )
  await t.assert.rejects(() => buildBundle({ cwd: tmp, entries: ENTRIES, define: { __DEV__: false } }), /--define is only valid for JS bundles/u)
}))

test('bundlePlan takes .teal entries as one language, and refuses the flags of another', withTmp((t, tmp) => {
  app(tmp)
  t.assert.deepStrictEqual(bundlePlan({ cwd: tmp, entries: ENTRIES, values: {} }).entries, ENTRIES)
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: [ENTRIES[0], 'run.sh'], values: {} }), /all be \.rs, or all be \.teal, or be \.js/u)
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ENTRIES, values: { scope: 'full' } }), /--scope is only valid for JS bundles/u)
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ENTRIES, values: { cargo: true } }), /--cargo is only valid for Rust bundles/u)
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ENTRIES, values: { lockfile: 'stasis.lock.json' } }), /--lockfile is only valid for JS bundles/u)
}))

test('a JS bundle carries the .teal files stasis.config.json\'s extra names as teal', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': '{ "name": "app", "version": "1.0.0", "type": "module" }\n',
    'deploy.js': 'export const deploy = () => {}\n',
    'stasis.config.json': '{ "extra": ["artifacts/**/*.teal"] }\n',
  })
  app(tmp)
  const bundle = await buildBundle({ cwd: tmp, entries: ['deploy.js'] })
  t.assert.equal(bundle.formats.get('deploy.js'), 'module')
  for (const rel of [...ENTRIES, 'artifacts/Counter/Child.approval.teal']) t.assert.equal(bundle.formats.get(rel), 'teal', rel)
  t.assert.equal(bundle.sources.get(ENTRIES[0]), APPROVAL)
}))

test('CLI: bundle writes a TEAL bundle for .teal entries', withTmp(async (t, tmp) => {
  app(tmp)
  const out = join(tmp, 'out.stasis.code.br')
  const r = await runCli(['bundle', '-o', out, ...ENTRIES], { cwd: tmp })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(out)).toString('utf8'))
  t.assert.deepStrictEqual([...parsed.entries], ENTRIES)
  t.assert.deepStrictEqual([...parsed.formats.values()], ['teal', 'teal'])
  t.assert.equal(parsed.sources.get(ENTRIES[0]), APPROVAL)
}))

test('CLI: run --bundle=load refuses to execute a teal-tagged file', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': '{ "name": "p", "version": "1.0.0", "type": "module" }\n',
    'src/entry.js': "import { greet } from './hello.js'\nconsole.log(greet())\n",
    'src/hello.js': "export const greet = () => 'hello'\n",
  })
  const bundlePath = join(tmp, 'snapshot.br')
  const save = await runCli(['run', '--lock=ignore', '--bundle=add', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.equal(save.status, 0, `save stderr: ${save.stderr}`)
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundlePath)))
  decoded.formats['src/hello.js'] = 'teal'
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'src'), { recursive: true })
  const r = await runCli(['run', '--lock=ignore', '--bundle=load', `--bundle-file=${bundlePath}`, 'src/entry.js'], { cwd: tmp })
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /cannot execute a 'teal' bundle: teal bundles are produced for external analysis/u)
  t.assert.doesNotMatch(r.stdout.toString('utf8'), /hello/u)
}))
