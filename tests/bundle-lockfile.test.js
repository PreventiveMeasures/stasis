import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { Bundle } from '@exodus/stasis-core/bundle'
import { withTmp } from './tmp.helper.js'

// No bundle carries a stasis.lock.json, or a <name>.stasis.lock.json: extracted, it would replace the lockfile a
// frozen extract checks the bundle against, or a build is held to, or root a stasis project of its own. Bundle
// refuses one both ways, so every producer and every reader does.
const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const coreCli = join(here, '..', 'stasis-core', 'bin', 'stasis-core.js')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_PID: _pid,
  ...cleanEnv
} = process.env

const refusal = (key) => new RegExp(`bundle: ${key.replaceAll('.', '\\.')} is a file no bundle may carry`)

// A full-scope bundle carrying src/a.js and a file at `key`.
const bundleWith = (key) => {
  const nm = key.startsWith('node_modules/')
  const modules = new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'a\n', ...(!nm && { [key]: '{}\n' }) } }]])
  if (nm) modules.set('node_modules/dep', { name: 'dep', version: '1.0.0', files: { [key.slice('node_modules/dep/'.length)]: '{}\n' } })
  return new Bundle({ config: { scope: 'full' }, modules, formats: new Map([['src/a.js', 'module'], [key, 'json']]) })
}

const LOCKFILE_KEYS = [
  'stasis.lock.json', 'STASIS.LOCK.JSON', 'Stasis.Lock.json', 'packages/x/stasis.lock.json', 'node_modules/dep/stasis.lock.json',
  'app.stasis.lock.json', 'a.b.stasis.lock.json', '.stasis.lock.json', 'APP.Stasis.Lock.JSON', 'packages/x/app.stasis.lock.json', 'node_modules/dep/x.stasis.lock.json',
]

test('Bundle.serialize refuses a stasis.lock.json or a <name>.stasis.lock.json at any depth and in any case', (t) => {
  for (const key of LOCKFILE_KEYS) t.assert.throws(() => bundleWith(key).serialize(), refusal(key))
  // A name that only resembles it is a file like any other.
  for (const key of ['stasis.lock.json.bak', 'src/stasis.lock.jsonc', 'my-stasis.lock.json']) {
    t.assert.ok(Bundle.parse(bundleWith(key).serialize()).sources.has(key))
  }
})

test('Bundle.parse refuses a stasis.lock.json or a <name>.stasis.lock.json at any depth and in any case, a legacy v0 bundle included', (t) => {
  for (const key of LOCKFILE_KEYS) {
    const json = JSON.parse(bundleWith('src/b.json').serialize())
    if (key.startsWith('node_modules/')) {
      json.modules = { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { [key.slice('node_modules/dep/'.length)]: '{}\n' } } }
    } else {
      json.sources['.'].files[key] = '{}\n'
    }
    t.assert.throws(() => Bundle.parse(JSON.stringify(json)), refusal(key))
    const v0 = { version: 0, config: { scope: 'full' }, sources: { 'src/a.js': 'a\n', [key]: '{}\n' }, formats: {}, imports: {} }
    t.assert.throws(() => Bundle.parse(JSON.stringify(v0)), refusal(key))
  }
})

// A project whose entries reach `lock`, its stasis.lock.json or a copy of it (src/read.js reads it, src/import.js
// imports it), recorded by a run of src/plain.js.
const lockReadingProject = (dir, lock) => {
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module' }))
  writeFileSync(join(dir, 'src', 'read.js'), `import { readFileSync } from 'node:fs'\nreadFileSync(new URL('../${lock}', import.meta.url))\n`)
  writeFileSync(join(dir, 'src', 'import.js'), `import lock from '../${lock}' with { type: 'json' }\nexport default lock\n`)
  writeFileSync(join(dir, 'src', 'plain.js'), 'export default 1\n')
  const r = spawnSync(process.execPath, [cli, 'run', '--lock=add', 'src/plain.js'], { cwd: dir, env: cleanEnv, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`fixture lockfile: ${r.stderr}`)
  const text = readFileSync(join(dir, 'stasis.lock.json'), 'utf8')
  writeFileSync(join(dir, lock), text)
  return text
}

for (const lock of ['stasis.lock.json', 'app.stasis.lock.json']) {
  test(`no producer ships ${lock}: run, bundle and add all refuse, writing nothing`, withTmp((t, tmp) => {
    const lockText = lockReadingProject(tmp, lock)
    const bundle = lock.replace(/lock\.json$/u, 'code.br')
    for (const [bin, args] of [
      [cli, ['run', '--lock=ignore', '--bundle=add', '--fs=sync', 'src/read.js']],
      [cli, ['run', '--lock=ignore', '--bundle=add', 'src/import.js']],
      // A run writing the lockfile as well serializes the bundle before writing either, so it changes neither.
      [cli, ['run', '--lock=add', '--bundle=add', 'src/import.js']],
      [coreCli, ['run', '--lock=add', '--bundle=add', 'src/import.js']],
      [cli, ['run', '--lock=add', '--bundle=add', '--resources-bundle-file=resources.br', 'src/import.js']],
      [cli, ['bundle', `--output=${bundle}`, 'src/import.js']],
      [cli, ['bundle', `--lockfile=${lock}`, '--add', `--output=${bundle}`, 'src/import.js']],
      // Writing no bundle, it serializes the one the lockfile is of all the same, so is refused where it would be.
      [cli, ['bundle', `--lockfile=${lock}`, '--lockfile-only', 'src/import.js']],
      [coreCli, ['add', lock]],
    ]) {
      if (bin === coreCli && args[0] === 'add') writeFileSync(join(tmp, 'stasis.config.json'), '{}\n')
      // A bundle in add, past the frozen hold a stasis.lock.json there has by default, which attests src/plain.js alone.
      const env = args[0] === 'bundle' ? { ...cleanEnv, EXODUS_STASIS_LOCK: 'add' } : cleanEnv
      const r = spawnSync(process.execPath, [bin, ...args], { cwd: tmp, env, encoding: 'utf-8' })
      const what = args.join(' ')
      t.assert.notEqual(r.status, 0, `${what} must fail`)
      t.assert.match(stripVTControlCharacters(r.stderr), refusal(lock), what)
      for (const file of ['stasis.code.br', bundle, 'resources.br']) t.assert.ok(!existsSync(join(tmp, file)), `${what} must write no ${file}`)
      for (const file of ['stasis.lock.json', lock]) t.assert.equal(readFileSync(join(tmp, file), 'utf8'), lockText, `${what} must leave ${file} alone`)
    }
  }))
}
