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

// No bundle carries a file a tool takes for the project's own, to run code of its choosing or to resolve or install
// from where it says, once it is extracted or the package holding it is installed on its own: a package manager's
// hook (`.npm-extension.mjs`, `.pnpmfile.cjs`) or config (`.npmrc`, `.yarnrc.yml`, `bunfig.toml`), a Yarn
// Plug'n'Play file (`.pnp.cjs`), or git metadata (`.git/config`). Each is a forbidden file name, as stasis.lock.json
// is (see bundle-lockfile.test.js): Bundle refuses one both ways, in the project or in any package it carries, so
// every producer and every reader does.
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

const EXTS = ['js', 'ts', 'mjs', 'mts', 'cjs', 'cts']

// Each kind of forbidden file: what the refusal calls one, the names of it, and names that only resemble one (or a
// file in a directory of such a name), which are files like any other.
const FORBIDDEN = [
  ['an npm extension', EXTS.map((ext) => `.npm-extension.${ext}`),
    ['npm-extension.mjs', '.npm-extension', '.npm-extension.json', '.npm-extension.jsx', '.npm-extension.xjs', '.npm-extension.mjs.map', 'a.npm-extension.mjs', '.npm-extension.mjs/index.js']],
  ['a pnpmfile', EXTS.flatMap((ext) => [`.pnpmfile.${ext}`, `pnpmfile.${ext}`]),
    ['.pnpmfile', '.pnpmfile.json', '.pnpmfile.cjsx', '.pnpmfile.cjs.bak', 'my.pnpmfile.cjs', '..pnpmfile.cjs', 'pnpmfile', 'pnpmfile.jsx', 'my-pnpmfile.js', 'pnpmfiles.js', 'pnpmfile.cjs/index.js']],
  ['an npm config', ['.npmrc'], ['npmrc', '.npmrc.bak', '.npmrc.json', 'my.npmrc', '.npmrcs', '.npmrc/index.js']],
  ['a Yarn config', ['.yarnrc', '.yarnrc.yml'], ['yarnrc', '.yarnrc.yaml', '.yarnrc.json', '.yarnrc.yml.bak', 'my.yarnrc', '.yarnrc/index.js']],
  ['a Bun config', ['bunfig.toml', '.bunfig.toml'], ['bunfig', 'bunfig.json', 'bunfig.toml.bak', 'my-bunfig.toml', 'bunfig.toml/index.js']],
  ['a Yarn Plug\'n\'Play file', ['.pnp.cjs', '.pnp.js', '.pnp.loader.mjs', '.pnp.data.json'],
    ['pnp.cjs', '.pnp.mjs', '.pnp.data.js', '.pnp.loader.cjs', '.pnp.cjs.map', 'my.pnp.cjs', '.pnp.cjs/index.js']],
  ['git metadata', ['.git', '.git/config', '.git/hooks/post-checkout', '.git/HEAD'],
    ['.gitignore', '.gitattributes', '.gitmodules', '.github/workflows/ci.yml', 'git/config', '.git.js', 'a.git/config', '.gits/config']],
]

const refusal = (key, what) => new RegExp(`bundle: ${key.replaceAll('.', '\\.')} is ${what}, which no bundle may carry`)

const DEP = 'node_modules/dep/'

// A full-scope bundle carrying src/a.js and a file at `key`, in the package node_modules/dep where `key` is in it.
const bundleWith = (key) => {
  const nm = key.startsWith(DEP)
  const modules = new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'a\n', ...(!nm && { [key]: 'export {}\n' }) } }]])
  if (nm) modules.set('node_modules/dep', { name: 'dep', version: '1.0.0', files: { [key.slice(DEP.length)]: 'export {}\n' } })
  return new Bundle({ config: { scope: 'full' }, modules, formats: new Map([['src/a.js', 'module'], [key, 'module']]) })
}

// Where a file named `name` goes: in a package, at any depth and in any case, and in the project itself.
const keysOf = (name) => [`${DEP}${name}`, `${DEP}lib/${name}`, `${DEP}${name.toUpperCase()}`, name, `packages/x/${name}`]

test('Bundle.serialize refuses a forbidden name in any package, at any depth and in any case', (t) => {
  for (const [what, names, lookalikes] of FORBIDDEN) {
    for (const key of names.flatMap(keysOf)) t.assert.throws(() => bundleWith(key).serialize(), refusal(key, what), key)
    for (const name of lookalikes) {
      const key = `${DEP}${name}`
      t.assert.ok(Bundle.parse(bundleWith(key).serialize()).sources.has(key), key)
    }
  }
})

test('Bundle.parse refuses a forbidden name in any package, a node_modules-scope or legacy v0 bundle included', (t) => {
  for (const [what, names] of FORBIDDEN) {
    for (const key of names.flatMap(keysOf)) {
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
    const nm = { version: 1, config: { scope: 'node_modules' }, formats: {}, imports: {}, modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'export {}\n', [names[0]]: 'x\n' } } } }
    t.assert.throws(() => Bundle.parse(JSON.stringify(nm)), refusal(`${DEP}${names[0]}`, what), what)
  }
})

test('extract refuses a bundle carrying a forbidden name, writing nothing', withTmp((t, tmp) => {
  for (const [what, names] of FORBIDDEN) {
    const bundleFile = join(tmp, 'evil.code.br')
    const json = { version: 1, config: { scope: 'node_modules' }, formats: {}, imports: {}, modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'export {}\n', [names.at(-1)]: 'x\n' } } } }
    writeFileSync(bundleFile, brotliCompressSync(JSON.stringify(json)))
    const output = join(tmp, 'out')
    t.assert.throws(() => extractCommand({ bundleFile, output }), (err) => /extract: not a valid stasis bundle: /u.test(err.message) &&
      refusal(`${DEP}${names.at(-1)}`, what).test(err.cause?.message), what)
    t.assert.ok(!existsSync(output), what)
  }
}))

// A project whose dependency reaches a file named `name` of its own: dep's index.js imports it, or reads it.
const reachingProject = (dir, name, { read = false, resources } = {}) => {
  const write = (path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  write('package.json', JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', dependencies: { dep: '1.0.0' } }))
  if (resources) write('stasis.config.json', JSON.stringify({ resources }))
  write('src/entry.js', "import dep from 'dep'\nexport default dep\n")
  write(`${DEP}package.json`, JSON.stringify({ name: 'dep', version: '1.0.0', type: 'module', main: 'index.js' }))
  write(`${DEP}index.js`, read
    ? `import { readFileSync } from 'node:fs'\nexport default readFileSync(new URL('./${name}', import.meta.url), 'utf8')\n`
    : `import hook from './${name}'\nexport default hook\n`)
  write(`${DEP}${name}`, name.endsWith('.cjs') ? 'module.exports = {}\n' : name.endsWith('.json') ? '{}\n' : 'export default {}\n')
}

const runIn = (dir, args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, env: cleanEnv, encoding: 'utf-8' })
  return { ...r, stderr: stripVTControlCharacters(r.stderr) }
}

test('no producer ships a package\'s hook it imports: run and bundle refuse, writing nothing', withTmp((t, tmp) => {
  for (const [name, what] of [['.npm-extension.mjs', 'an npm extension'], ['.npm-extension.cjs', 'an npm extension'],
    ['.pnpmfile.cjs', 'a pnpmfile'], ['pnpmfile.mjs', 'a pnpmfile'], ['.pnp.cjs', 'a Yarn Plug\'n\'Play file'], ['.pnp.loader.mjs', 'a Yarn Plug\'n\'Play file']]) {
    const dir = join(tmp, name)
    reachingProject(dir, name)
    for (const args of [
      ['run', '--lock=ignore', '--bundle=add', 'src/entry.js'],
      ['run', '--lock=ignore', '--dependencies', '--bundle=add', 'src/entry.js'],
      ['bundle', '--output=stasis.code.br', 'src/entry.js'],
      ['bundle', '--scope=node_modules', '--output=stasis.code.br', 'src/entry.js'],
    ]) {
      const r = runIn(dir, args)
      const where = `${name}: ${args.join(' ')}`
      t.assert.notEqual(r.status, 0, `${where} must fail`)
      t.assert.match(r.stderr, refusal(`${DEP}${name}`, what), where)
      t.assert.ok(!existsSync(join(dir, 'stasis.code.br')), `${where} must write no bundle`)
    }
  }
}))

test('no run ships a package\'s config or git metadata it reads, even one declared a resource, writing nothing', withTmp((t, tmp) => {
  for (const [name, what, resource] of [['.npmrc', 'an npm config', 'npmrc'], ['.yarnrc', 'a Yarn config', 'yarnrc'], ['.yarnrc.yml', 'a Yarn config', 'yml'],
    ['bunfig.toml', 'a Bun config', 'toml'], ['.pnp.data.json', 'a Yarn Plug\'n\'Play file'], ['.git/config', 'git metadata', 'config'], ['.git', 'git metadata', 'git']]) {
    const dir = join(tmp, name)
    reachingProject(dir, name, { read: true, resources: resource && [resource] })
    for (const args of [
      ['run', '--lock=ignore', '--bundle=add', '--fs=sync', 'src/entry.js'],
      ['run', '--lock=ignore', '--dependencies', '--bundle=add', '--fs=sync', 'src/entry.js'],
    ]) {
      const r = runIn(dir, args)
      const where = `${name}: ${args.join(' ')}`
      t.assert.notEqual(r.status, 0, `${where} must fail`)
      t.assert.match(r.stderr, refusal(`${DEP}${name}`, what), where)
      t.assert.ok(!existsSync(join(dir, 'stasis.code.br')), `${where} must write no bundle`)
    }
  }
}))
