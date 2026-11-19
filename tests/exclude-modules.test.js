import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { addCommand } from '@exodus/stasis-core/add'
import { parseBundleBytes } from '@exodus/stasis-core/brotli'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { moduleExcluder, parsePolicy } from '@exodus/stasis-core/policy'
import { State } from '@exodus/stasis-core/state'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { bundlePlan, readConfigEntries } from '../stasis/src/cmd/bundle-options.js'
import { withTmp } from './tmp.helper.js'
import { captureWarningsAsync } from './warnings.helper.js'

// stasis.config.json's excludeModules: dependencies taken for absent. A file of one is missing wherever stasis looks
// for one, so a require() or import() of one falls through and a static import fails, and a lockfile or bundle that
// records one is refused.

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')

const writeTree = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
}

const sourcesOf = (path) => [...parseBundleBytes(readFileSync(path)).sources.keys()].toSorted()

// Stripped of the colors Node prints a value in where FORCE_COLOR is set, as in CI.
const runCli = (args, cwd) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8' })
  return { status, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) }
}

const EXCLUDES = 'stasis.config.json: excludeModules excludes node_modules/opt ("opt")'
const ABSENT = 'absent MODULE_NOT_FOUND unresolved MODULE_NOT_FOUND left\n'

// `opt` is the dependency excluded, reaching `optdep`, which nothing else reaches. a.js requires it where it catches
// the miss; b.mjs imports it statically, c.mjs with import(); d.mjs import()s lazy.mjs, which imports it statically.
const project = (dir, config) => writeTree(dir, {
  'package.json': { name: 'app', version: '1.0.0' },
  'a.js': [
    "let opt; try { opt = require('opt') } catch (e) { opt = 'absent ' + e.code }",
    "let at; try { at = require.resolve('opt') } catch (e) { at = 'unresolved ' + e.code }",
    "console.log(opt, at, require('left'))",
    '',
  ].join('\n'),
  'b.mjs': "import opt from 'opt'\nconsole.log(opt)\n",
  'c.mjs': "console.log(await import('opt').then((m) => m.default, (e) => 'absent ' + e.code))\n",
  'd.mjs': "console.log(await import('./lazy.mjs').then((m) => m.default, (e) => 'absent ' + e.code))\n",
  'lazy.mjs': "import opt from 'opt'\nexport default opt\n",
  'f.js': "console.log(require('opt'))\n",
  'preload.mjs': "import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)('opt')\n",
  'node_modules/opt/package.json': { name: 'opt', version: '1.0.0', main: 'index.js' },
  'node_modules/opt/index.js': "module.exports = 'opt ' + require('optdep')\n",
  'node_modules/optdep/package.json': { name: 'optdep', version: '1.0.0', main: 'index.js' },
  'node_modules/optdep/index.js': "module.exports = 'optdep'\n",
  'node_modules/left/package.json': { name: 'left', version: '1.0.0', main: 'index.js' },
  'node_modules/left/index.js': "module.exports = 'left'\n",
  ...(config === undefined ? {} : { 'stasis.config.json': config }),
})

test('excludeModules takes a dependency by its package.json name or the directory it is really installed in, never a workspace package', withTmp((t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'app', version: '1.0.0' },
    'node_modules/opt/index.js': '',
    'node_modules/renamed/package.json': { name: 'opt' },
    'node_modules/left/index.js': '',
    'node_modules/.pnpm/real@1.0.0/node_modules/real/index.js': '',
    'packages/opt/index.js': '',
  })
  symlinkSync('.pnpm/real@1.0.0/node_modules/real', join(tmp, 'node_modules/nice'))
  symlinkSync('../packages/opt', join(tmp, 'node_modules/linked'))
  t.assert.equal(moduleExcluder([parsePolicy('cfg', { disallowedModules: ['opt'] })], tmp), null)
  const excluded = moduleExcluder([parsePolicy('cfg', { excludeModules: ['opt', 'real'] })], tmp)
  const at = (rel, options) => excluded(join(tmp, rel), options)?.dir
  t.assert.deepStrictEqual(excluded(join(tmp, 'node_modules/opt/index.js')), { dir: 'node_modules/opt', pattern: 'opt', label: 'cfg' })
  t.assert.equal(at('node_modules/opt'), 'node_modules/opt')
  t.assert.equal(at('node_modules/left/index.js'), undefined)
  // By its package.json's name, which `installed` doesn't read.
  t.assert.equal(at('node_modules/renamed/index.js'), 'node_modules/renamed')
  t.assert.equal(at('node_modules/renamed/index.js', { installed: true }), undefined)
  // A pnpm alias, by the directory it is really installed in, as disallowedModules matches it.
  t.assert.equal(at('node_modules/nice/index.js', { installed: true }), 'node_modules/.pnpm/real@1.0.0/node_modules/real')
  t.assert.equal(moduleExcluder([parsePolicy('cfg', { excludeModules: ['nice'] })], tmp)(join(tmp, 'node_modules/nice/index.js')), undefined)
  t.assert.equal(at('packages/opt/index.js'), undefined)
  t.assert.equal(at('node_modules/linked/index.js'), undefined)
  // An artifact's path of a dependency it has no record of (a --fs stat), by its directory.
  t.assert.throws(() => parsePolicy('cfg', { excludeModules: ['opt'] }).assert({ paths: ['node_modules/opt/index.js'], packages: [] }),
    { message: 'cfg: excludeModules excludes opt at node_modules/opt ("opt")' })
}))

test('bundleCommand misses an excluded dependency: a require() or import() of it falls through, a static import fails', withTmp(async (t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  const out = join(tmp, 'stasis.code.br')
  // Through a State, and with --mainFields' resolver, without one.
  const builds = async (options) => {
    const said = (await captureWarningsAsync(() => bundleCommand({ cwd: tmp, entries: ['a.js'], ...options }))).warnings.join('\n')
    t.assert.match(said, /fall through at load time:\n {2}require opt from a\.js \(excluded by excludeModules\)/u)
    t.assert.deepStrictEqual(sourcesOf(out), ['a.js', 'node_modules/left/index.js'], 'neither opt nor what only it reaches')
    await bundleCommand({ cwd: tmp, entries: ['c.mjs'], ...options })
    t.assert.deepStrictEqual(sourcesOf(out), ['c.mjs'])
    // As for a miss, a static import past an import() falls through too.
    await bundleCommand({ cwd: tmp, entries: ['d.mjs'], ...options })
    t.assert.deepStrictEqual(sourcesOf(out), ['d.mjs', 'lazy.mjs'])
    await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['b.mjs'], ...options }), {
      message: /^JS bundle would be broken at load time(?: \(mainFields\))?:\n {2}unresolved import opt from b\.mjs \(excluded by excludeModules\)$/u,
    })
  }
  await builds({})
  await builds({ mainFields: ['main'] })
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['node_modules/opt/index.js'] }),
    { message: `entry not found: ${join(tmp, 'node_modules/opt/index.js')} (${EXCLUDES})` })
}))

test('bundleCommand misses what an entry\'s own excludeModules excludes, in its build alone', withTmp(async (t, tmp) => {
  project(tmp, { entries: { 'a.js': { excludeModules: ['opt'] }, 'f.js': {} } })
  await bundleCommand({ cwd: tmp, builds: bundlePlan({ cwd: tmp, entries: ['a.js', 'f.js'], values: {}, config: readConfigEntries(tmp) }).builds })
  const { imports } = parseBundleBytes(readFileSync(join(tmp, 'stasis.code.br')))
  t.assert.equal(imports.get('*').get('a.js').has('opt'), false)
  t.assert.equal(imports.get('*').get('f.js').get('opt'), 'node_modules/opt/index.js')
}))

test('a lockfile or bundle that records an excluded dependency is refused, as one that conflicts', withTmp(async (t, tmp) => {
  project(tmp)
  await bundleCommand({ cwd: tmp, entries: ['f.js'], lockfile: 'stasis.lock.json' })
  writeTree(tmp, { 'stasis.config.json': { excludeModules: ['opt'] } })
  const refused = 'excludeModules excludes opt@1.0.0 at node_modules/opt ("opt") -- recorded in stasis.'
  for (const modes of [{ lock: 'frozen', bundle: 'load' }, { lock: 'ignore', bundle: 'frozen' }, { lock: 'add', bundle: 'add' }]) {
    t.assert.throws(() => new State(tmp, { ...modes, env: {}, claim: false }), { message: new RegExp(`${RegExp.escape(refused)}(lock\\.json|code\\.br); rebuild it`, 'u') })
  }
  t.assert.ok(runCli(['run', '--lock=add', '--bundle=add', 'a.js'], tmp).stderr.includes(`${refused}lock.json; rebuild it`))
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['package.json'] }), { message: new RegExp(RegExp.escape(`${refused}code.br already`), 'u') })
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'], add: true }), { message: new RegExp(RegExp.escape(`${refused}code.br already`), 'u') })
  const state = new State(tmp, { lock: 'replace', bundle: 'replace', env: {}, claim: false })
  t.assert.throws(() => state.addFile(pathToFileURL(join(tmp, 'node_modules/opt/index.js')).href), { message: /excludeModules excludes opt@1\.0\.0/u })
}))

test('stasis add and extra take an excluded dependency\'s file for missing: named, not found; swept, never found', withTmp(async (t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  mkdirSync(join(tmp, 'src'))
  symlinkSync('../node_modules/opt/index.js', join(tmp, 'src/link.js'))
  for (const rel of ['node_modules/opt/index.js', 'node_modules/opt', 'src/link.js']) {
    t.assert.throws(() => addCommand({ cwd: tmp, entries: [rel] }), { message: `add: file not found: ${rel} (${EXCLUDES})` })
  }
  addCommand({ cwd: tmp, entries: ['node_modules', 'src'] })
  t.assert.deepStrictEqual(sourcesOf(join(tmp, 'stasis.code.br')).filter((path) => path.includes('opt')), ['node_modules/optdep/index.js', 'node_modules/optdep/package.json'])
  rmSync(join(tmp, 'stasis.code.br'))
  // A glob matching an excluded dependency's files alone matches none.
  project(tmp, { excludeModules: ['opt'], extra: ['node_modules/opt/*.js'] })
  const notFound = `extra: file not found: node_modules/opt/*.js (${EXCLUDES})`
  t.assert.ok(runCli(['run', '--lock=add', 'a.js'], tmp).stderr.includes(notFound))
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'], mainFields: ['main'] }), { message: notFound })
}))

test('CLI: stasis run misses an excluded dependency, records nothing of it, and a preload\'s copy is no more found', withTmp((t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  const ran = runCli(['run', '--lock=add', 'a.js'], tmp)
  t.assert.equal(ran.stdout, ABSENT, ran.stderr)
  t.assert.deepStrictEqual([...Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8')).modules.keys()].toSorted(), ['.', 'node_modules/left'])
  t.assert.equal(runCli(['run', '--lock=frozen', 'a.js'], tmp).stdout, ABSENT)
  t.assert.equal(runCli(['run', '--lock=add', '--import=./preload.mjs', 'a.js'], tmp).stdout, ABSENT)
  t.assert.equal(runCli(['run', '--lock=add', 'c.mjs'], tmp).stdout, 'absent ERR_MODULE_NOT_FOUND\n')
  const staticImport = runCli(['run', '--lock=add', 'b.mjs'], tmp)
  t.assert.notEqual(staticImport.status, 0)
  t.assert.match(staticImport.stderr, new RegExp(`Cannot find module 'opt' imported from .*b\\.mjs \\(${RegExp.escape(EXCLUDES)}\\)[^]*code: 'ERR_MODULE_NOT_FOUND'`, 'u'))
}))

test('CLI: stasis run --fs reads an excluded dependency\'s files as missing, a link to one from anywhere too', withTmp((t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  writeTree(tmp, {
    'r.js': "const fs = require('node:fs')\nconst read = (path) => { try { return fs.readFileSync(path, 'utf8') } catch (e) { return e.code } }\n" +
      "console.log(read('node_modules/opt/package.json'), read('link.js'), read('node_modules/left/link.js'), fs.existsSync('node_modules/opt'), fs.existsSync('node_modules/left'))\n",
  })
  symlinkSync('node_modules/opt/index.js', join(tmp, 'link.js'))
  symlinkSync('../opt/index.js', join(tmp, 'node_modules/left/link.js'))
  for (const fs of ['sync', 'async']) {
    const ran = runCli(['run', '--lock=replace', '--bundle=replace', `--fs=${fs}`, 'r.js'], tmp)
    t.assert.equal(ran.stdout, 'ENOENT ENOENT ENOENT false true\n', ran.stderr)
    t.assert.ok(!sourcesOf(join(tmp, 'stasis.code.br')).some((path) => path.startsWith('node_modules/opt')))
    // A require() of one still misses as a module does.
    t.assert.equal(runCli(['run', '--lock=replace', '--bundle=replace', `--fs=${fs}`, 'a.js'], tmp).stdout, ABSENT, fs)
  }
}))

test('CLI: stasis run --bundle=load misses an excluded dependency, in either scope', withTmp(async (t, tmp) => {
  const loads = async (scope) => {
    project(tmp, { excludeModules: ['opt'], scope })
    await bundleCommand({ cwd: tmp, entries: ['a.js'] })
    // As any miss under --bundle=load: getImport's code where the resolve hook sees a require() first (Node 24.22).
    const ran = runCli(['run', '--lock=ignore', '--bundle=load', ...(scope === 'full' ? [] : ['--dependencies']), 'a.js'], tmp)
    t.assert.match(ran.stdout, /^absent (ERR_)?MODULE_NOT_FOUND unresolved (ERR_)?MODULE_NOT_FOUND left\n$/u, ran.stderr)
  }
  await loads('full')
  await loads('node_modules')
}))

test('a pnpm alias is excluded by its real name, through any resolver; a linked workspace package, or the project itself, never', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'app', version: '1.0.0', exports: './self.js' },
    'a.js': "let nice; try { nice = require('nice') } catch (e) { nice = e.code }\nconsole.log(nice, require('foo'), require('app'))\n",
    'self.js': "module.exports = 'self'\n",
    'n.js': "try { require('nice') } catch {}\n",
    'node_modules/app/package.json': { name: 'app', version: '2.0.0' },
    'node_modules/.pnpm/opt@1.0.0/node_modules/opt/package.json': { name: 'opt', version: '1.0.0' },
    'node_modules/.pnpm/opt@1.0.0/node_modules/opt/index.js': "module.exports = 'opt'\n",
    'packages/foo/package.json': { name: 'foo', version: '1.0.0' },
    'packages/foo/index.js': "module.exports = 'foo'\n",
    'stasis.config.json': { excludeModules: ['opt', 'foo', 'app'] },
  })
  symlinkSync('.pnpm/opt@1.0.0/node_modules/opt', join(tmp, 'node_modules/nice'))
  symlinkSync('../packages/foo', join(tmp, 'node_modules/foo'))
  await bundleCommand({ cwd: tmp, entries: ['a.js'], output: join(tmp, 'a.br') })
  t.assert.deepStrictEqual(sourcesOf(join(tmp, 'a.br')), ['a.js', 'packages/foo/index.js', 'self.js'])
  // And through --mainFields' resolver.
  await bundleCommand({ cwd: tmp, entries: ['n.js'], mainFields: ['main'], output: join(tmp, 'n.br') })
  t.assert.deepStrictEqual(sourcesOf(join(tmp, 'n.br')), ['n.js'])
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')))
  t.assert.equal(runCli(['run', '--lock=add', 'a.js'], tmp).stdout, 'MODULE_NOT_FOUND foo self\n')
}))
