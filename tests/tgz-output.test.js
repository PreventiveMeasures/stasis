import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { bundleFormat } from '../stasis/src/cmd/output.js'
import { parseFile, readStasisTgz } from '../stasis/src/parse.js'
import { withTmp } from './tmp.helper.js'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))
// A project of two entries, each of its own file, one executable.
const project = (dir) => {
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', private: true }))
  writeFileSync(join(dir, 'src', 'a.js'), "console.log('a')\n")
  writeFileSync(join(dir, 'src', 'b.js'), "#!/usr/bin/env node\nconsole.log('b')\n", { mode: 0o755 })
  return dir
}
// A bundle as its lockfile records it: no `reason`, which a .stasis.tgz carries none of.
const recorded = (bundle) => ({ ...JSON.parse(bundle.serialize()), reason: undefined })

test('stasis bundle writes a .stasis.tgz where --output is named so, or --format=tgz (stasis.tgz by default): the bundle a stasis.code.br of it would be; --add merges into one', withTmp(async (t, tmp) => {
  t.mock.method(console, 'warn', () => {})
  const cwd = project(tmp)
  await bundleCommand({ cwd, entries: ['src/a.js'], output: 'app.stasis.code.br' })
  await bundleCommand({ cwd, entries: ['src/a.js'], output: 'app.stasis.tgz' })
  const br = parseFile(join(cwd, 'app.stasis.code.br'))
  const tgz = parseFile(join(cwd, 'app.stasis.tgz'))
  t.assert.deepStrictEqual(recorded(tgz), recorded(br))
  t.assert.ok(br.reason !== undefined && tgz.reason === undefined, 'a lockfile records no reason, nor its tgz')

  await bundleCommand({ cwd, entries: ['src/a.js'], format: 'tgz' })
  t.assert.deepStrictEqual(recorded(parseFile(join(cwd, 'stasis.tgz'))), recorded(br), 'stasis.tgz at the root, as stasis.code.br')
  t.assert.ok(!existsSync(join(cwd, 'stasis.code.br')))

  // Read back as it was written, and written again with what is added.
  await bundleCommand({ cwd, entries: ['src/b.js'], output: 'app.stasis.tgz', add: true })
  const added = parseFile(join(cwd, 'app.stasis.tgz'))
  t.assert.deepStrictEqual([[...added.entries], [...added.sources.keys()], [...added.executable]], [['src/a.js', 'src/b.js'], ['src/a.js', 'src/b.js'], ['src/b.js']])
}))

test('bundleFormat: --format, else the --output\'s name\'s, else br; refused where they disagree, or a tgz is to be brotli\'d', (t) => {
  t.assert.deepStrictEqual([
    bundleFormat('', {}), bundleFormat('', { output: 'x.br' }), bundleFormat('', { output: 'x.stasis.tgz' }), bundleFormat('', { output: 'stasis.tgz' }),
    bundleFormat('', { format: 'tgz' }), bundleFormat('', { format: 'tgz', output: '-' }), bundleFormat('', { format: 'br', output: 'x.stasis.code.br' }),
  ], ['br', 'br', 'tgz', 'tgz', 'tgz', 'tgz', 'br'])
  const refused = (options, message) => t.assert.throws(() => bundleFormat('p: ', options), { message: `p: ${message}` })
  refused({ format: 'tgz', output: 'app.br' }, "--format=tgz writes a .stasis.tgz: name --output stasis.tgz or <name>.stasis.tgz (got 'app.br')")
  refused({ format: 'tgz', output: 'app.tgz' }, "--format=tgz writes a .stasis.tgz: name --output stasis.tgz or <name>.stasis.tgz (got 'app.tgz')")
  refused({ format: 'br', output: 'app.stasis.tgz' }, "--format=br writes a stasis.code.br, not --output=app.stasis.tgz, a .stasis.tgz's name")
  refused({ format: 'zip' }, "--format must be br or tgz (got 'zip')")
  refused({ format: 'tgz', brotliQuality: 5 }, '--brotli-quality compresses a stasis.code.br, not a .stasis.tgz')
  refused({ output: 'app.stasis.tgz', brotliQuality: 5 }, '--brotli-quality compresses a stasis.code.br, not a .stasis.tgz')
})

test('stasis bundle --format: to stdout, refused as a usage error where it conflicts with the --output, --brotli-quality or --lockfile-only', withTmp((t, tmp) => {
  const cwd = project(tmp)
  const run = (...args) => spawnSync(process.execPath, [cli, 'bundle', ...args, 'src/a.js'], { cwd, env })
  const streamed = run('--format=tgz', '--output=-')
  t.assert.equal(streamed.status, 0, streamed.stderr.toString())
  t.assert.deepStrictEqual([...readStasisTgz(streamed.stdout, '<stdout>').artifact.sources.keys()], ['src/a.js'])
  for (const [args, message] of [
    [['--format=tgz', '--output=app.br'], "--format=tgz writes a .stasis.tgz: name --output stasis.tgz or <name>.stasis.tgz (got 'app.br')"],
    [['--format=br', '--output=app.stasis.tgz'], "--format=br writes a stasis.code.br, not --output=app.stasis.tgz, a .stasis.tgz's name"],
    [['--output=app.stasis.tgz', '--brotli-quality=5'], '--brotli-quality compresses a stasis.code.br, not a .stasis.tgz'],
    [['--format=tgz', '--lockfile=x.lock.json', '--lockfile-only'], "--lockfile-only can't be combined with --format (no bundle is written)"],
  ]) {
    const refused = run(...args)
    t.assert.deepStrictEqual([refused.status, refused.stderr.toString()], [1, `Error: ${message}\nRun 'stasis --help' for usage.\n`], args.join(' '))
  }
  t.assert.ok(!existsSync(join(cwd, 'app.br')) && !existsSync(join(cwd, 'app.stasis.tgz')), 'nothing written')
  t.assert.equal(readFileSync(join(cwd, 'src', 'a.js'), 'utf8'), "console.log('a')\n")
}))

test('bundleFormat: stasis.config.json\'s format where no --format is given, else the bundle at the root; each held to the other and to the --output', (t) => {
  const there = (...names) => (name) => names.includes(name)
  t.assert.deepStrictEqual([
    bundleFormat('', { configured: 'tgz' }), bundleFormat('', { format: 'tgz', configured: 'tgz' }), bundleFormat('', { configured: 'br', output: 'x.br' }),
    bundleFormat('', { exists: there('stasis.tgz') }), bundleFormat('', { exists: there() }), bundleFormat('', { exists: there('stasis.code.br') }),
    bundleFormat('', { output: 'x.br', exists: there('stasis.tgz') }), bundleFormat('', { configured: 'br', exists: there('stasis.tgz') }),
  ], ['tgz', 'tgz', 'br', 'tgz', 'br', 'br', 'br', 'br'])
  const refused = (options, message) => t.assert.throws(() => bundleFormat('p: ', options), { message: `p: ${message}` })
  refused({ format: 'br', configured: 'tgz' }, "--format=br disagrees with stasis.config.json's format, tgz")
  refused({ configured: 'tgz', output: 'app.br' }, "stasis.config.json's format tgz writes a .stasis.tgz: name --output stasis.tgz or <name>.stasis.tgz (got 'app.br')")
  refused({ configured: 'br', output: 'app.stasis.tgz' }, "stasis.config.json's format br writes a stasis.code.br, not --output=app.stasis.tgz, a .stasis.tgz's name")
  refused({ configured: 'zip' }, "stasis.config.json's format must be br or tgz (got 'zip')")
  t.assert.throws(() => bundleFormat('', { exists: there('stasis.code.br', 'stasis.tgz') }), /stasis\.code\.br and stasis\.tgz are both there/u)
})

test('stasis bundle writes the root\'s bundle as stasis.config.json\'s format says, else as the bundle there is', withTmp(async (t, tmp) => {
  t.mock.method(console, 'warn', () => {})
  const cwd = project(tmp)
  writeFileSync(join(cwd, 'stasis.config.json'), JSON.stringify({ format: 'tgz' }))
  await bundleCommand({ cwd, entries: ['src/a.js'] })
  t.assert.deepStrictEqual([existsSync(join(cwd, 'stasis.tgz')), existsSync(join(cwd, 'stasis.code.br'))], [true, false])
  await t.assert.rejects(bundleCommand({ cwd, entries: ['src/a.js'], format: 'br' }), { message: "bundleCommand: --format=br disagrees with stasis.config.json's format, tgz" })
  // No format: the stasis.tgz there, added to.
  writeFileSync(join(cwd, 'stasis.config.json'), JSON.stringify({}))
  await bundleCommand({ cwd, entries: ['src/b.js'], add: true })
  t.assert.deepStrictEqual([[...parseFile(join(cwd, 'stasis.tgz')).sources.keys()], existsSync(join(cwd, 'stasis.code.br'))], [['src/a.js', 'src/b.js'], false])
  writeFileSync(join(cwd, 'stasis.code.br'), 'either\n')
  await t.assert.rejects(bundleCommand({ cwd, entries: ['src/a.js'] }), /stasis\.code\.br and stasis\.tgz are both there/u)
  // A run's bundleFile naming a .stasis.tgz is no write of the build's, which writes its own output.
  writeFileSync(join(cwd, 'stasis.config.json'), JSON.stringify({ bundleFile: 'run.stasis.tgz' }))
  await bundleCommand({ cwd, entries: ['src/a.js'], output: 'other.stasis.code.br' })
  t.assert.ok(existsSync(join(cwd, 'other.stasis.code.br')))
}))
