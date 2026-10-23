import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'

// stasis.config.json's `extra`: files attested beside what `stasis run` (when it writes) and
// `stasis bundle` reach, named as `stasis add` takes its arguments from a shell.

const here = dirname(fileURLToPath(import.meta.url))
const stasisCli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const coreCli = join(here, '..', 'stasis-core', 'bin', 'stasis-core.js')

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))

const runCli = (cli, args, cwd) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf-8', env: cleanEnv, cwd })
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-extra-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
const EXTRA = ['scripts/tool.js', 'assets/', 'src/*.js']

// An ESM project whose entry imports src/util.js; scripts/tool.js and the assets are never reached.
const seed = (tmp, config = { resources: ['png', 'svg'], extra: EXTRA }) => {
  const write = (rel, content) => {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true })
    writeFileSync(join(tmp, rel), content)
  }
  write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }))
  write('stasis.config.json', JSON.stringify(config))
  write('src/entry.js', "import { u } from './util.js'\nconsole.log('ok', u)\n")
  write('src/util.js', 'export const u = 1\n')
  write('src/notes.txt', 'not matched by src/*.js\n')
  write('scripts/tool.js', 'export const tool = 1\n')
  write('assets/logo.png', PNG)
  write('assets/icon.svg', '<svg/>\n')
  // Left out of a directory sweep, as `stasis add assets` leaves them.
  write('assets/README.md', '# assets\n')
  write('assets/examples/demo.png', PNG)
  write('assets/.hidden.png', PNG)
}

const decode = (path) => Bundle.parse(brotliDecompressSync(readFileSync(path)).toString('utf8'))
const filesOf = (artifact) => Object.keys(artifact.modules.get('.').files).toSorted()
const EXTRA_FILES = ['assets/icon.svg', 'assets/logo.png', 'scripts/tool.js']

// --- stasis run --------------------------------------------------------------

test('run --lock=add --bundle=add attests the extra files beside what the run reached', withTmp(async (t, tmp) => {
  seed(tmp)
  const r = runCli(stasisCli, ['run', '--lock=add', '--bundle=add', 'src/entry.js'], tmp)
  t.assert.equal(r.status, 0, r.stderr)

  const all = [...EXTRA_FILES, 'src/entry.js', 'src/util.js'].toSorted()
  const bundle = decode(join(tmp, 'stasis.code.br'))
  t.assert.deepStrictEqual(filesOf(bundle), all)
  const lock = Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))
  t.assert.deepStrictEqual(filesOf(lock), all)

  // Read, not loaded: a resource by its bytes, JS with no loader format (the loader's to decide).
  t.assert.equal(bundle.formats.get('assets/logo.png'), 'resource:base64')
  t.assert.equal(bundle.formats.get('assets/icon.svg'), 'resource')
  t.assert.equal(bundle.formats.has('scripts/tool.js'), false)
  // A file the run loaded itself (src/*.js) keeps the run's own record.
  t.assert.equal(bundle.formats.get('src/util.js'), 'module')
  t.assert.deepStrictEqual(bundle.reason, { extra: EXTRA_FILES, run: ['src/entry.js', 'src/util.js'] })
  t.assert.deepStrictEqual([...bundle.entries], ['src/entry.js'], 'extra files are no entries')

  // The bundle runs on its own, and a frozen replay of both passes.
  const load = runCli(stasisCli, ['run', '--lock=frozen', '--bundle=load', 'src/entry.js'], tmp)
  t.assert.equal(load.status, 0, load.stderr)
  const frozen = runCli(stasisCli, ['run', '--lock=frozen', '--bundle=frozen', 'src/entry.js'], tmp)
  t.assert.equal(frozen.status, 0, frozen.stderr)
}))

test('run takes extra into a lockfile alone, and on the core CLI too', withTmp(async (t, tmp) => {
  seed(tmp)
  const r = runCli(coreCli, ['run', '--lock=add', 'src/entry.js'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')))
  const lock = Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))
  t.assert.deepStrictEqual(filesOf(lock), [...EXTRA_FILES, 'src/entry.js', 'src/util.js'].toSorted())
}))

test('run adds extra only when it writes: frozen and load runs never read it', withTmp(async (t, tmp) => {
  seed(tmp, { resources: ['png', 'svg'] })
  t.assert.equal(runCli(stasisCli, ['run', '--lock=add', '--bundle=add', 'src/entry.js'], tmp).status, 0)
  // An `extra` naming a missing file would fail any run that took it.
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ resources: ['png', 'svg'], extra: ['missing.js'] }))
  for (const modes of [['--lock=frozen', '--bundle=frozen'], ['--lock=frozen', '--bundle=load']]) {
    const r = runCli(stasisCli, ['run', ...modes, 'src/entry.js'], tmp)
    t.assert.equal(r.status, 0, `${modes}: ${r.stderr}`)
  }
  const add = runCli(stasisCli, ['run', '--lock=add', '--bundle=add', 'src/entry.js'], tmp)
  t.assert.notEqual(add.status, 0)
  t.assert.match(add.stderr, /extra: file not found: missing\.js/)
}))

test('run refuses an extra file that changed since it was recorded, as any recorded file', withTmp(async (t, tmp) => {
  seed(tmp)
  t.assert.equal(runCli(stasisCli, ['run', '--lock=add', '--bundle=add', 'src/entry.js'], tmp).status, 0)
  writeFileSync(join(tmp, 'scripts/tool.js'), 'export const tool = 2\n')
  const r = runCli(stasisCli, ['run', '--lock=add', '--bundle=add', 'src/entry.js'], tmp)
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /Conflict for "scripts\/tool\.js"/)
}))

test('run names every extra offender at once and writes nothing', withTmp(async (t, tmp) => {
  seed(tmp, { resources: ['png'], extra: ['missing.js', 'nomatch/*.png', 'assets/', 'src/notes.txt'] })
  const r = runCli(stasisCli, ['run', '--lock=add', '--bundle=add', 'src/entry.js'], tmp)
  t.assert.notEqual(r.status, 0)
  // A pattern matching nothing stands for itself, as in a shell.
  t.assert.match(r.stderr, /extra: 2 files not found: missing\.js, nomatch\/\*\.png; 2 files are neither recognized source files nor declared resources; add their extensions to "resources" in stasis\.config\.json: assets\/icon\.svg, src\/notes\.txt/)
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')))
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')))
}))

test('run never sweeps the bundle it writes into extra, so it is repeatable', withTmp(async (t, tmp) => {
  seed(tmp, { resources: ['br'], bundleFile: 'dist/code.br', extra: ['dist/'] })
  mkdirSync(join(tmp, 'dist'))
  writeFileSync(join(tmp, 'dist', 'helper.js'), 'export const h = 1\n')
  for (let i = 0; i < 2; i++) {
    const r = runCli(stasisCli, ['run', '--bundle=add', 'src/entry.js'], tmp)
    t.assert.equal(r.status, 0, r.stderr)
  }
  t.assert.deepStrictEqual(filesOf(decode(join(tmp, 'dist', 'code.br'))), ['dist/helper.js', 'src/entry.js', 'src/util.js'])
}))

test('run never takes the artifacts it writes into extra, even matched by a glob', withTmp(async (t, tmp) => {
  seed(tmp, { resources: ['br'], extra: ['*.json', '*.br'] })
  writeFileSync(join(tmp, 'top.br'), PNG)
  for (let i = 0; i < 2; i++) {
    const r = runCli(stasisCli, ['run', '--lock=add', '--bundle=add', 'src/entry.js'], tmp)
    t.assert.equal(r.status, 0, r.stderr)
  }
  const files = ['package.json', 'src/entry.js', 'src/util.js', 'stasis.config.json', 'top.br']
  t.assert.deepStrictEqual(filesOf(decode(join(tmp, 'stasis.code.br'))), files)
  t.assert.deepStrictEqual(filesOf(Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))), files)
}))

test('run --fs never captures the extra sweep itself as the program\'s reads', withTmp(async (t, tmp) => {
  seed(tmp)
  const r = runCli(stasisCli, ['run', '--bundle=add', '--fs=sync', 'src/entry.js'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  const bundle = decode(join(tmp, 'stasis.code.br'))
  t.assert.deepStrictEqual(filesOf(bundle), [...EXTRA_FILES, 'src/entry.js', 'src/util.js'].toSorted())
  // No directory listing or stat record of the swept tree.
  t.assert.deepStrictEqual([...bundle.formats.values()].filter((format) => format === 'directory' || format.startsWith('stat:')), [])
}))

// --- stasis bundle -----------------------------------------------------------

test('bundle adds the extra files beside what the scan reached, into its lockfile too', withTmp(async (t, tmp) => {
  seed(tmp)
  const r = runCli(stasisCli, ['bundle', '--lockfile=stasis.lock.json', 'src/entry.js'], tmp)
  t.assert.equal(r.status, 0, r.stderr)

  const all = [...EXTRA_FILES, 'src/entry.js', 'src/util.js'].toSorted()
  const bundle = decode(join(tmp, 'stasis.code.br'))
  t.assert.deepStrictEqual(filesOf(bundle), all)
  t.assert.deepStrictEqual(filesOf(Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))), all)
  // As `stasis run` records them.
  t.assert.equal(bundle.formats.get('assets/logo.png'), 'resource:base64')
  t.assert.equal(bundle.formats.has('scripts/tool.js'), false)
  t.assert.deepStrictEqual(bundle.reason, { bundle: ['src/entry.js', 'src/util.js'], extra: EXTRA_FILES })

  const load = runCli(stasisCli, ['run', '--lock=frozen', '--bundle=load', 'src/entry.js'], tmp)
  t.assert.equal(load.status, 0, load.stderr)
}))

test('bundle without extra keeps a single `bundle` consumer', withTmp(async (t, tmp) => {
  seed(tmp, { resources: ['png', 'svg'] })
  t.assert.equal(runCli(stasisCli, ['bundle', 'src/entry.js'], tmp).status, 0)
  t.assert.deepStrictEqual(decode(join(tmp, 'stasis.code.br')).reason, { bundle: ['src/entry.js', 'src/util.js'] })
}))

test('bundle never takes its own --output or --lockfile into extra, swept or matched', withTmp(async (t, tmp) => {
  for (const [extra, mainFields] of [[['dist/'], []], [['dist/*'], []], [['dist/*'], ['--mainFields=main']]]) {
    rmSync(join(tmp, 'dist'), { recursive: true, force: true })
    seed(tmp, { resources: ['br'], extra })
    mkdirSync(join(tmp, 'dist'))
    writeFileSync(join(tmp, 'dist', 'helper.js'), 'export const h = 1\n')
    for (let i = 0; i < 2; i++) {
      const r = runCli(stasisCli, ['bundle', ...mainFields, '--output=dist/app.br', '--lockfile=dist/lock.json', 'src/entry.js'], tmp)
      t.assert.equal(r.status, 0, `${extra} ${mainFields}: ${r.stderr}`)
    }
    const files = ['dist/helper.js', 'src/entry.js', 'src/util.js']
    t.assert.deepStrictEqual(filesOf(decode(join(tmp, 'dist', 'app.br'))), files, `${extra} ${mainFields}`)
    t.assert.deepStrictEqual(filesOf(Lockfile.parse(readFileSync(join(tmp, 'dist', 'lock.json'), 'utf8'))), files, `${extra} ${mainFields}`)
  }
}))

test('bundle never takes its default output into extra, matched by a glob', withTmp(async (t, tmp) => {
  for (const mainFields of [[], ['--mainFields=main']]) {
    seed(tmp, { resources: ['br'], extra: ['*.br'] })
    writeFileSync(join(tmp, 'top.br'), PNG)
    for (let i = 0; i < 2; i++) {
      const r = runCli(stasisCli, ['bundle', ...mainFields, 'src/entry.js'], tmp)
      t.assert.equal(r.status, 0, `${mainFields}: ${r.stderr}`)
    }
    t.assert.deepStrictEqual(filesOf(decode(join(tmp, 'stasis.code.br'))), ['src/entry.js', 'src/util.js', 'top.br'], `${mainFields}`)
    rmSync(join(tmp, 'stasis.code.br'))
  }
}))

test('bundle validates extra against --resources where given, else the config\'s resources', withTmp(async (t, tmp) => {
  for (const mainFields of [[], ['--mainFields=main']]) {
    seed(tmp, { extra: ['assets/'] })
    const r = runCli(stasisCli, ['bundle', ...mainFields, '--resources=png,svg', 'src/entry.js'], tmp)
    t.assert.equal(r.status, 0, `${mainFields}: ${r.stderr}`)
    t.assert.deepStrictEqual(filesOf(decode(join(tmp, 'stasis.code.br'))), ['assets/icon.svg', 'assets/logo.png', 'src/entry.js', 'src/util.js'], `${mainFields}`)

    // A flag narrower than the config's list is the one that holds.
    seed(tmp, { resources: ['png', 'svg'], extra: ['assets/'] })
    const narrow = runCli(stasisCli, ['bundle', ...mainFields, '--resources=png', 'src/entry.js'], tmp)
    t.assert.notEqual(narrow.status, 0, `${mainFields}`)
    t.assert.match(narrow.stderr, /extra: assets\/icon\.svg is neither a recognized source file nor a declared resource/, `${mainFields}`)
    rmSync(join(tmp, 'stasis.code.br'), { force: true })
  }
}))

test('bundle --mainFields adds extra as `stasis add` adds files, into its lockfile too', withTmp(async (t, tmp) => {
  seed(tmp)
  const r = runCli(stasisCli, ['bundle', '--mainFields=main', '--lockfile=stasis.lock.json', 'src/entry.js'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  const all = [...EXTRA_FILES, 'src/entry.js', 'src/util.js'].toSorted()
  const bundle = decode(join(tmp, 'stasis.code.br'))
  t.assert.deepStrictEqual(filesOf(bundle), all)
  t.assert.deepStrictEqual(filesOf(Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))), all)
  // `add`'s format: the package's `type`.
  t.assert.equal(bundle.formats.get('scripts/tool.js'), 'module')
  t.assert.deepStrictEqual(bundle.reason, { bundle: ['src/entry.js', 'src/util.js'], extra: EXTRA_FILES })

  const load = runCli(stasisCli, ['run', '--lock=frozen', '--bundle=load', 'src/entry.js'], tmp)
  t.assert.equal(load.status, 0, load.stderr)
}))

test('bundle of a Bash entry takes extra into its own workspace bucket', withTmp(async (t, tmp) => {
  seed(tmp)
  // No package.json: the bundle names its workspace bucket itself, where `add` would say `workspace`.
  rmSync(join(tmp, 'package.json'))
  writeFileSync(join(tmp, 'run.sh'), '#!/bin/sh\necho ok\n')
  const r = runCli(stasisCli, ['bundle', 'run.sh'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  const bundle = decode(join(tmp, 'stasis.code.br'))
  const files = ['assets/icon.svg', 'assets/logo.png', 'run.sh', 'scripts/tool.js', 'src/entry.js', 'src/util.js']
  t.assert.deepStrictEqual(filesOf(bundle), files)
  t.assert.equal(bundle.modules.get('.').name, 'bash-bundle')
}))

test('bundle refuses an invalid extra', withTmp(async (t, tmp) => {
  seed(tmp, { extra: ['../outside.js'] })
  const r = runCli(stasisCli, ['bundle', 'src/entry.js'], tmp)
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /extra entry '\.\.\/outside\.js' must be a path or pattern within the project root/)
}))
