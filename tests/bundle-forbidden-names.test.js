import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { extractCommand } from '@exodus/stasis-core/extract'
import { withTmp } from './tmp.helper.js'

// Package manager hooks and configs, Yarn PnP files and git metadata are refused as stasis.lock.json is
// (bundle-lockfile.test.js), in the project and in any package.
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
const FORBIDDEN = [
  ...EXTS.flatMap((ext) => [`.npm-extension.${ext}`, `.pnpmfile.${ext}`, `pnpmfile.${ext}`]),
  '.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.bunfig.toml', '.pnp.cjs', '.pnp.js', '.pnp.loader.mjs', '.pnp.data.json',
  '.git', '.git/config', '.git/hooks/post-checkout',
]
const LOOKALIKES = [
  'npm-extension.mjs', '.npm-extension', '.npm-extension.json', '.npm-extension.jsx', '.npm-extension.mjs.map', 'a.npm-extension.mjs', '.npm-extension.mjs/index.js',
  '.pnpmfile', '.pnpmfile.cjsx', 'my.pnpmfile.cjs', '..pnpmfile.cjs', 'pnpmfile', 'pnpmfile.jsx', 'my-pnpmfile.js', 'pnpmfiles.js',
  'npmrc', '.npmrc.bak', 'my.npmrc', '.npmrc/index.js', 'yarnrc', '.yarnrc.yaml', '.yarnrc.yml.bak', 'bunfig', 'bunfig.json', 'my-bunfig.toml',
  'pnp.cjs', '.pnp.mjs', '.pnp.data.js', '.pnp.loader.cjs', '.pnp.cjs.map',
  '.gitignore', '.gitattributes', '.gitmodules', '.github/workflows/ci.yml', 'git/config', '.git.js', 'a.git/config', '.gits/config',
]

// Forbidden in a dependency only.
const IN_PACKAGE = ['pnpm-workspace.yaml', '.env', '.env.local', '.env.production.local', 'prod.env']
const IN_PACKAGE_LOOKALIKES = ['pnpm-workspace.yml', 'pnpm-workspace.json', 'my-pnpm-workspace.yaml', '.envrc', 'env', '.environment', 'x.env.bak', '.env.local/index.js']

const refusal = (key) => new RegExp(`bundle: ${key.replaceAll('.', '\\.')} is a file no bundle may carry`)

const DEP = 'node_modules/dep/'

const bundleWith = (key) => {
  const nm = key.startsWith(DEP)
  const modules = new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'a\n', ...(!nm && { [key]: 'export {}\n' }) } }]])
  if (nm) modules.set('node_modules/dep', { name: 'dep', version: '1.0.0', files: { [key.slice(DEP.length)]: 'export {}\n' } })
  return new Bundle({ config: { scope: 'full' }, modules, formats: new Map([['src/a.js', 'module'], [key, 'module']]) })
}

const keysOf = (name) => [`${DEP}${name}`, `${DEP}lib/${name}`, `${DEP}${name.toUpperCase()}`, name, `packages/x/${name}`]

test('Bundle.serialize refuses a forbidden name in any package, at any depth and in any case', (t) => {
  for (const key of FORBIDDEN.flatMap(keysOf)) t.assert.throws(() => bundleWith(key).serialize(), refusal(key), key)
  for (const key of LOOKALIKES.map((name) => `${DEP}${name}`)) t.assert.ok(Bundle.parse(bundleWith(key).serialize()).sources.has(key), key)
})

test('Bundle.parse refuses a forbidden name in any package, a node_modules-scope or legacy v0 bundle included', (t) => {
  for (const key of FORBIDDEN.flatMap(keysOf)) {
    const json = JSON.parse(bundleWith('src/b.js').serialize())
    if (key.startsWith(DEP)) {
      json.modules = { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { [key.slice(DEP.length)]: 'export {}\n' } } }
    } else {
      json.sources['.'].files[key] = 'export {}\n'
    }
    t.assert.throws(() => Bundle.parse(JSON.stringify(json)), refusal(key), key)
    const v0 = { version: 0, config: { scope: 'full' }, sources: { 'src/a.js': 'a\n', [key]: 'export {}\n' }, formats: {}, imports: {} }
    t.assert.throws(() => Bundle.parse(JSON.stringify(v0)), refusal(key), `v0 ${key}`)
  }
  for (const name of FORBIDDEN) {
    const nm = { version: 1, config: { scope: 'node_modules' }, formats: {}, imports: {}, modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'export {}\n', [name]: 'x\n' } } } }
    t.assert.throws(() => Bundle.parse(JSON.stringify(nm)), refusal(`${DEP}${name}`), name)
  }
})

test('Bundle refuses a dependency\'s pnpm workspace manifest or env file, and carries the project\'s own', (t) => {
  for (const name of IN_PACKAGE) {
    for (const key of [`${DEP}${name}`, `${DEP}lib/${name}`, `${DEP}${name.toUpperCase()}`, `node_modules/.pnpm/dep@1.0.0/${DEP}${name}`]) {
      t.assert.throws(() => bundleWith(key).serialize(), refusal(key), key)
    }
    const nm = { version: 1, config: { scope: 'node_modules' }, formats: {}, imports: {}, modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { [name]: 'x\n' } } } }
    t.assert.throws(() => Bundle.parse(JSON.stringify(nm)), refusal(`${DEP}${name}`), name)
    for (const key of [name, `packages/x/${name}`, `x_node_modules/${name}`]) t.assert.ok(Bundle.parse(bundleWith(key).serialize()).sources.has(key), key)
  }
  for (const key of IN_PACKAGE_LOOKALIKES.map((name) => `${DEP}${name}`)) t.assert.ok(Bundle.parse(bundleWith(key).serialize()).sources.has(key), key)
})

test('extract refuses a bundle carrying a forbidden name, writing nothing', withTmp((t, tmp) => {
  for (const name of [...FORBIDDEN, ...IN_PACKAGE]) {
    const bundleFile = join(tmp, 'evil.code.br')
    const json = { version: 1, config: { scope: 'node_modules' }, formats: {}, imports: {}, modules: { 'node_modules/dep': { name: 'dep', version: '1.0.0', files: { 'index.js': 'export {}\n', [name]: 'x\n' } } } }
    writeFileSync(bundleFile, brotliCompressSync(JSON.stringify(json)))
    const output = join(tmp, 'out')
    t.assert.throws(() => extractCommand({ bundleFile, output }), (err) => /extract: not a valid stasis bundle: /u.test(err.message) &&
      refusal(`${DEP}${name}`).test(err.cause?.message), name)
    t.assert.ok(!existsSync(output), name)
  }
}))

// dep's index.js imports its own `name`, or with `read`, reads it.
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

const assertRefused = (t, dir, name, args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, env: cleanEnv, encoding: 'utf-8' })
  const where = `${name}: ${args.join(' ')}`
  t.assert.notEqual(r.status, 0, where)
  t.assert.match(stripVTControlCharacters(r.stderr), refusal(`${DEP}${name}`), where)
  t.assert.ok(!existsSync(join(dir, 'stasis.code.br')), where)
}

test('no producer ships a package\'s hook it imports: run and bundle refuse, writing nothing', withTmp((t, tmp) => {
  for (const name of ['.npm-extension.mjs', '.npm-extension.cjs', '.pnpmfile.cjs', 'pnpmfile.mjs', '.pnp.cjs', '.pnp.loader.mjs']) {
    const dir = join(tmp, name)
    reachingProject(dir, name)
    for (const args of [
      ['run', '--lock=ignore', '--bundle=add', 'src/entry.js'],
      ['run', '--lock=ignore', '--dependencies', '--bundle=add', 'src/entry.js'],
      ['bundle', '--output=stasis.code.br', 'src/entry.js'],
      ['bundle', '--scope=node_modules', '--output=stasis.code.br', 'src/entry.js'],
    ]) assertRefused(t, dir, name, args)
  }
}))

test('no run ships a package\'s config or git metadata it reads, even one declared a resource, writing nothing', withTmp((t, tmp) => {
  for (const [name, resource] of [['.npmrc', 'npmrc'], ['.yarnrc', 'yarnrc'], ['.yarnrc.yml', 'yml'], ['bunfig.toml', 'toml'], ['.pnp.data.json'], ['.git/config', 'config'], ['.git', 'git']]) {
    const dir = join(tmp, name)
    reachingProject(dir, name, { read: true, resources: resource && [resource] })
    for (const args of [
      ['run', '--lock=ignore', '--bundle=add', '--fs=sync', 'src/entry.js'],
      ['run', '--lock=ignore', '--dependencies', '--bundle=add', '--fs=sync', 'src/entry.js'],
    ]) assertRefused(t, dir, name, args)
  }
}))

test('bundle and add refuse a dependency\'s pnpm workspace manifest or env file that extra or add names, and take the project\'s own', withTmp((t, tmp) => {
  const coreCli = join(here, '..', 'stasis-core', 'bin', 'stasis-core.js')
  for (const name of ['pnpm-workspace.yaml', '.env']) {
    const dir = join(tmp, name)
    reachingProject(dir, 'index.js')
    for (const path of [name, `${DEP}${name}`]) writeFileSync(join(dir, path), 'x: 1\n')
    writeFileSync(join(dir, 'stasis.config.json'), JSON.stringify({ resources: ['yaml', 'env'], extra: [`${DEP}${name}`] }))
    assertRefused(t, dir, name, ['bundle', '--output=stasis.code.br', 'src/entry.js'])
    writeFileSync(join(dir, 'stasis.config.json'), JSON.stringify({ resources: ['yaml', 'env'] }))
    const r = spawnSync(process.execPath, [coreCli, 'add', `${DEP}${name}`], { cwd: dir, env: cleanEnv, encoding: 'utf-8' })
    t.assert.notEqual(r.status, 0, `add ${name}`)
    t.assert.match(stripVTControlCharacters(r.stderr), refusal(`${DEP}${name}`), `add ${name}`)
    writeFileSync(join(dir, 'stasis.config.json'), JSON.stringify({ resources: ['yaml', 'env'], extra: [name] }))
    const own = spawnSync(process.execPath, [cli, 'bundle', '--output=stasis.code.br', 'src/entry.js'], { cwd: dir, env: cleanEnv, encoding: 'utf-8' })
    t.assert.equal(own.status, 0, own.stderr)
    t.assert.ok(Bundle.parse(brotliDecompressSync(readFileSync(join(dir, 'stasis.code.br'))).toString('utf8')).sources.has(name), name)
  }
}))
