import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { extractCommand } from '@exodus/stasis-core/extract'
import { withTmp } from './tmp.helper.js'

// No bundle carries an npm extension (`.npm-extension.mjs`, `.cjs`, ...) or a pnpmfile (`.pnpmfile.cjs`, `pnpmfile.js`, ...):
// the package manager runs one as it installs the project it is the root of, before it resolves the tree, and a
// package's own would be one once extracted or installed on its own. Each is a forbidden file name, as
// stasis.lock.json is (see bundle-lockfile.test.js): Bundle refuses one both ways, in the project or in any package
// it carries, so every producer and every reader does.
const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_PID: _pid,
  ...cleanEnv
} = process.env

// Each forbidden name's stem, what the refusal calls a file of it, and names that only resemble it.
const FORBIDDEN = [
  ['.npm-extension', 'an npm extension', ['npm-extension.mjs', '.npm-extension', '.npm-extension.json', '.npm-extension.jsx', '.npm-extension.xjs', '.npm-extension.mjs.map', 'a.npm-extension.mjs']],
  ['.pnpmfile', 'a pnpmfile', ['.pnpmfile', '.pnpmfile.json', '.pnpmfile.cjsx', '.pnpmfile.cjs.bak', 'my.pnpmfile.cjs', '..pnpmfile.cjs']],
  ['pnpmfile', 'a pnpmfile', ['pnpmfile', 'pnpmfile.json', 'pnpmfile.jsx', 'pnpmfile.js.map', 'my-pnpmfile.js', 'pnpmfiles.js']],
]
const EXTS = ['js', 'ts', 'mjs', 'mts', 'cjs', 'cts']

const refusal = (key, what) => new RegExp(`bundle: ${key.replaceAll('.', '\\.')} is ${what}, which no bundle may carry`)

const DEP = 'node_modules/dep/'

// A full-scope bundle carrying src/a.js and a file at `key`, in the package node_modules/dep where `key` is in it.
const bundleWith = (key) => {
  const nm = key.startsWith(DEP)
  const modules = new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'a\n', ...(!nm && { [key]: 'export {}\n' }) } }]])
  if (nm) modules.set('node_modules/dep', { name: 'dep', version: '1.0.0', files: { [key.slice(DEP.length)]: 'export {}\n' } })
  return new Bundle({ config: { scope: 'full' }, modules, formats: new Map([['src/a.js', 'module'], [key, 'module']]) })
}

// Where a file named `stem.<ext>` goes: in a package, at any depth and in any case, and in the project itself.
const keysOf = (stem) => [
  ...EXTS.map((ext) => `${DEP}${stem}.${ext}`),
  `${DEP}lib/${stem}.mjs`,
  `${DEP}${stem.toUpperCase()}.CJS`,
  `${stem}.cjs`,
  `packages/x/${stem}.mjs`,
]

test('Bundle.serialize refuses a forbidden name in any package, at any depth and in any case', (t) => {
  for (const [stem, what, lookalikes] of FORBIDDEN) {
    for (const key of keysOf(stem)) t.assert.throws(() => bundleWith(key).serialize(), refusal(key, what), key)
    // A name that only resembles one is a file like any other, as is a file in a directory of that name.
    for (const name of [...lookalikes, `${stem}.mjs/index.js`]) {
      const key = `${DEP}${name}`
      t.assert.ok(Bundle.parse(bundleWith(key).serialize()).sources.has(key), key)
    }
  }
})

test('Bundle.parse refuses a forbidden name in any package, a node_modules-scope or legacy v0 bundle included', (t) => {
  for (const [stem, what] of FORBIDDEN) {
    for (const key of keysOf(stem)) {
      const json = JSON.parse(bundleWith('src/b.js').serialize())
      if (key.startsWith(DEP)) {
        json.modules = { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { [key.slice(DEP.length)]: 'export {}\n' } } }
      } else {
        json.sources['.'].files[key] = 'export {}\n'
      }
      t.assert.throws(() => Bundle.parse(JSON.stringify(json)), refusal(key, what), key)
      const v0 = { version: 0, config: { scope: 'full' }, sources: { 'src/a.js': 'a\n', [key]: 'export {}\n' }, formats: {}, imports: {} }
      t.assert.throws(() => Bundle.parse(JSON.stringify(v0)), refusal(key, what), `v0 ${key}`)
    }
    const nm = { version: 1, config: { scope: 'node_modules' }, formats: {}, imports: {}, modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'export {}\n', [`${stem}.mjs`]: 'export {}\n' } } } }
    t.assert.throws(() => Bundle.parse(JSON.stringify(nm)), refusal(`${DEP}${stem}.mjs`, what))
  }
})

test('extract refuses a bundle carrying a forbidden name, writing nothing', withTmp((t, tmp) => {
  for (const [stem, what] of FORBIDDEN) {
    const bundleFile = join(tmp, 'evil.code.br')
    const json = { version: 1, config: { scope: 'node_modules' }, formats: {}, imports: {}, modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'export {}\n', [`${stem}.cjs`]: 'module.exports = {}\n' } } } }
    writeFileSync(bundleFile, brotliCompressSync(JSON.stringify(json)))
    const output = join(tmp, 'out')
    t.assert.throws(() => extractCommand({ bundleFile, output }), (err) => /extract: not a valid stasis bundle: /u.test(err.message) &&
      refusal(`${DEP}${stem}.cjs`, what).test(err.cause?.message), stem)
    t.assert.ok(!existsSync(output), stem)
  }
}))

// A project whose dependency reaches a file named `name` of its own: dep's index.js imports it.
const forbiddenReachingProject = (dir, name) => {
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', dependencies: { dep: '1.0.0' } }))
  write('src/entry.js', "import dep from 'dep'\nexport default dep\n")
  write(`${DEP}package.json`, JSON.stringify({ name: 'dep', version: '1.0.0', type: 'module', main: 'index.js' }))
  write(`${DEP}index.js`, `import hook from './${name}'\nexport default hook\n`)
  write(`${DEP}${name}`, name.endsWith('.cjs') ? 'module.exports = {}\n' : 'export default {}\n')
}

test('no producer ships a package\'s file of a forbidden name: run and bundle refuse, writing nothing', withTmp((t, tmp) => {
  for (const [stem, what] of FORBIDDEN) {
    for (const name of [`${stem}.mjs`, `${stem}.cjs`]) {
      const dir = join(tmp, name)
      forbiddenReachingProject(dir, name)
      for (const args of [
        ['run', '--lock=ignore', '--bundle=add', 'src/entry.js'],
        ['run', '--lock=ignore', '--dependencies', '--bundle=add', 'src/entry.js'],
        ['bundle', '--output=stasis.code.br', 'src/entry.js'],
        ['bundle', '--scope=node_modules', '--output=stasis.code.br', 'src/entry.js'],
      ]) {
        const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, env: cleanEnv, encoding: 'utf-8' })
        const where = `${name}: ${args.join(' ')}`
        t.assert.notEqual(r.status, 0, `${where} must fail`)
        t.assert.match(stripVTControlCharacters(r.stderr), refusal(`${DEP}${name}`, what), where)
        t.assert.ok(!existsSync(join(dir, 'stasis.code.br')), `${where} must write no bundle`)
      }
    }
  }
}))
