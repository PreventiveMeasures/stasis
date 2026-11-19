import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { addCommand } from '@exodus/stasis-core/add'
import { parseBundleBytes } from '@exodus/stasis-core/brotli'
import { Config } from '@exodus/stasis-core/config'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { moduleExcluder, parsePolicy } from '@exodus/stasis-core/policy'
import { State } from '@exodus/stasis-core/state'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { bundlePlan, readConfigEntries } from '../stasis/src/cmd/bundle-options.js'
import { withTmp } from './tmp.helper.js'
import { captureWarningsAsync } from './warnings.helper.js'

// stasis.config.json's excludeModules: dependencies taken for absent. No build or run reaches one, so no
// lockfile or bundle carries one, and an import of one misses as an import of a package not installed does:
// past a require() or import(), where the program can catch it, it falls through; a static import fails. A file
// of one is missing wherever stasis looks for one, and a lockfile or bundle that carries one is refused.

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')

const writeTree = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
}

const readBundle = (path) => parseBundleBytes(readFileSync(path))
const readLock = (dir) => Lockfile.parse(readFileSync(join(dir, 'stasis.lock.json'), 'utf8'))
const urlOf = (dir, rel) => pathToFileURL(join(dir, rel)).href
const sorted = (keys) => [...keys].toSorted()

const runCli = async (args, cwd) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))
  const child = spawn(process.execPath, [cli, ...args], { cwd, env })
  child.stdin.end()
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const [status] = await once(child, 'close')
  // Stripped of the colors Node prints a value in where FORCE_COLOR is set, as in CI.
  return { status, stdout: stripVTControlCharacters(stdout), stderr: stripVTControlCharacters(stderr) }
}

// `opt` is the dependency taken for absent, reaching `optdep`, which nothing else reaches; `left` is another.
// a.js requires opt where it catches the miss, and require.resolve()s it; b.mjs imports it statically, c.mjs
// with import(); d.mjs import()s lazy.mjs, which imports it statically.
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
  'node_modules/opt/package.json': { name: 'opt', version: '1.0.0', main: 'index.js' },
  'node_modules/opt/index.js': "module.exports = 'opt ' + require('optdep')\n",
  'node_modules/optdep/package.json': { name: 'optdep', version: '1.0.0', main: 'index.js' },
  'node_modules/optdep/index.js': "module.exports = 'optdep'\n",
  'node_modules/left/package.json': { name: 'left', version: '1.0.0', main: 'index.js' },
  'node_modules/left/index.js': "module.exports = 'left'\n",
  ...(config === undefined ? {} : { 'stasis.config.json': config }),
})

test('excludeModules takes a dependency by any name it goes by, but never a workspace package', withTmp((t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'app', version: '1.0.0' },
    'node_modules/opt/package.json': { name: 'opt', version: '1.0.0' },
    'node_modules/opt/index.js': '',
    'node_modules/@skip/thing/package.json': { name: '@skip/thing', version: '1.0.0' },
    'node_modules/renamed/package.json': { name: 'opt', version: '1.0.0' },
    'node_modules/left/package.json': { name: 'left', version: '1.0.0' },
    'node_modules/.pnpm/pnpmopt@1.0.0/node_modules/pnpmopt/package.json': { name: 'pnpmopt', version: '1.0.0' },
    'packages/opt/package.json': { name: 'opt', version: '1.0.0' },
  })
  symlinkSync('.pnpm/pnpmopt@1.0.0/node_modules/pnpmopt', join(tmp, 'node_modules/nice'))
  symlinkSync('../packages/opt', join(tmp, 'node_modules/linked'))
  const policy = parsePolicy('cfg', { excludeModules: ['opt', '@skip/*', 'nice'] })
  t.assert.ok(policy.excludesModules)
  t.assert.equal(parsePolicy('cfg', { disallowedModules: ['opt'] }).excludesModules, false)
  t.assert.equal(moduleExcluder([parsePolicy('cfg', { disallowedModules: ['opt'] })], tmp), null)
  const excluded = moduleExcluder([policy], tmp)
  const at = (rel, options) => excluded(join(tmp, rel), options)
  t.assert.deepStrictEqual(at('node_modules/opt/index.js'), { dir: 'node_modules/opt', pattern: 'opt', label: 'cfg' })
  // The package's own directory too.
  t.assert.equal(at('node_modules/opt').dir, 'node_modules/opt')
  t.assert.equal(at('node_modules/@skip/thing/x.js').pattern, '@skip/*')
  t.assert.equal(at('node_modules/@skip'), undefined)
  // Installed under another name: by its package.json's, which `installed` doesn't read.
  t.assert.equal(at('node_modules/renamed/index.js').dir, 'node_modules/renamed')
  t.assert.equal(at('node_modules/renamed/index.js', { installed: true }), undefined)
  // A pnpm alias, by the name it is installed under, though its real path's differs; a bare specifier's too.
  t.assert.equal(at('node_modules/nice/index.js', { installed: true }).pattern, 'nice')
  t.assert.equal(at('node_modules/.pnpm/pnpmopt@1.0.0/node_modules/pnpmopt/index.js'), undefined)
  t.assert.equal(at('node_modules/.pnpm/pnpmopt@1.0.0/node_modules/pnpmopt/index.js', { alias: 'nice' }).pattern, 'nice')
  t.assert.equal(at('node_modules/left/index.js'), undefined)
  // The project's own: a workspace package, though linked into node_modules by an excluded name.
  t.assert.equal(at('packages/opt/index.js'), undefined)
  t.assert.equal(at('node_modules/linked/index.js', { alias: 'opt' }), undefined)
  t.assert.throws(() => parsePolicy('cfg', { excludeModules: ['node_modules/opt'] }), { message: 'cfg: excludeModules: "node_modules/opt" is no package name or pattern of names (such as "left-pad", "@babel/*")' })
  t.assert.throws(() => parsePolicy('cfg', { excludeModules: 'opt' }), { message: 'cfg: excludeModules must be an array of non-empty strings' })
  // An artifact carrying one is refused.
  t.assert.throws(() => policy.assertPath('node_modules/opt/index.js', { dir: 'node_modules/opt', name: 'opt', version: '1.0.0' }), {
    message: 'cfg: excludeModules excludes opt@1.0.0 at node_modules/opt ("opt")',
  })
}))

test('Config takes excludeModules from stasis.config.json alone', (t) => {
  const config = new Config({ env: {}, lock: 'add' })
  config.loadConfig(JSON.stringify({ excludeModules: ['opt'] }))
  t.assert.equal(config.policy.key, JSON.stringify({ excludeModules: ['opt'] }))
  t.assert.throws(() => new Config({ env: {}, lock: 'add', excludeModules: ['opt'] }), /Unknown Config options: excludeModules/u)
})

test('bundleCommand takes an excluded dependency for absent: a require() or import() of it falls through, a static import fails', withTmp(async (t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  const out = join(tmp, 'stasis.code.br')
  // Built through a State, and with --mainFields' resolver, without one.
  const builds = async (options) => {
    const said = (await captureWarningsAsync(() => bundleCommand({ cwd: tmp, entries: ['a.js'], ...options }))).warnings.join('\n')
    t.assert.match(said, /unresolved import\(s\)(?: \(mainFields\))?; they will fall through at load time:\n {2}require opt from a\.js \(excluded by excludeModules\)/u, JSON.stringify(options))
    const bundle = readBundle(out)
    t.assert.deepStrictEqual(sorted(bundle.sources.keys()), ['a.js', 'node_modules/left/index.js'], 'neither opt nor what only it reaches')
    t.assert.deepStrictEqual(sorted(bundle.modules.keys()), ['.', 'node_modules/left'])

    await bundleCommand({ cwd: tmp, entries: ['c.mjs'], ...options })
    t.assert.deepStrictEqual(sorted(readBundle(out).sources.keys()), ['c.mjs'])
    // As for a miss, a static import past an import() falls through too: the import() catches it.
    await bundleCommand({ cwd: tmp, entries: ['d.mjs'], ...options })
    t.assert.deepStrictEqual(sorted(readBundle(out).sources.keys()), ['d.mjs', 'lazy.mjs'])

    await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['b.mjs'], output: join(tmp, 'b.br'), ...options }), {
      message: /^JS bundle would be broken at load time(?: \(mainFields\))?:\n {2}unresolved import opt from b\.mjs \(excluded by excludeModules\)$/u,
    })
    t.assert.ok(!existsSync(join(tmp, 'b.br')))
  }
  await builds({})
  await builds({ mainFields: ['main'] })
}))

test('bundleCommand takes for absent what an entry\'s own excludeModules excludes, in its own build alone', withTmp(async (t, tmp) => {
  project(tmp, { entries: { 'a.js': { excludeModules: ['opt'] }, 'f.js': {} } })
  const config = readConfigEntries(tmp)
  t.assert.equal(config.get('a.js').policy.key, JSON.stringify({ excludeModules: ['opt'] }))
  await bundleCommand({ cwd: tmp, builds: bundlePlan({ cwd: tmp, entries: ['a.js', 'f.js'], values: {}, config }).builds })
  const bundle = readBundle(join(tmp, 'stasis.code.br'))
  // f.js reaches opt, which a.js's build takes for absent.
  t.assert.ok(bundle.sources.has('node_modules/opt/index.js'))
  t.assert.equal(bundle.imports.get('*')?.get('a.js')?.has('opt') ?? false, false)
  t.assert.equal(bundle.imports.get('*').get('f.js').get('opt'), 'node_modules/opt/index.js')
  // The config's excludeModules is every entry's: an entry's build reaching it statically fails.
  project(tmp, { excludeModules: ['opt'], entries: { 'a.js': {}, 'b.mjs': { jsx: true } } })
  const { builds } = bundlePlan({ cwd: tmp, entries: ['a.js', 'b.mjs'], values: {}, config: readConfigEntries(tmp) })
  t.assert.equal(builds.length, 2)
  await t.assert.rejects(bundleCommand({ cwd: tmp, builds }), /unresolved import opt from b\.mjs \(excluded by excludeModules\)/u)
}))

test('a lockfile or bundle that carries an excluded dependency is refused, as one that conflicts', withTmp(async (t, tmp) => {
  project(tmp)
  await bundleCommand({ cwd: tmp, entries: ['f.js'], lockfile: 'stasis.lock.json' })
  writeTree(tmp, { 'stasis.config.json': { excludeModules: ['opt'] } })
  const hint = /^stasis\.config\.json: excludeModules excludes opt@1\.0\.0 at node_modules\/opt \("opt"\) -- recorded in stasis\.(?:lock\.json|code\.br); rebuild it \(lock=replace \/ bundle=replace\)$/u
  for (const modes of [{ lock: 'frozen', bundle: 'ignore' }, { lock: 'frozen', bundle: 'load' }, { lock: 'ignore', bundle: 'frozen' }, { lock: 'add', bundle: 'add' }]) {
    t.assert.throws(() => new State(tmp, { ...modes, env: {}, claim: false }), { message: hint }, JSON.stringify(modes))
  }
  const ran = await runCli(['run', '--lock=add', '--bundle=add', 'a.js'], tmp)
  t.assert.notEqual(ran.status, 0)
  t.assert.match(ran.stderr, /excludeModules excludes opt@1\.0\.0 at node_modules\/opt \("opt"\) -- recorded in stasis\.lock\.json; rebuild it/u)
  const recorded = /excludeModules excludes opt@1\.0\.0 at node_modules\/opt \("opt"\) -- recorded in stasis\.code\.br already/u
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['package.json'] }), recorded)
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'], add: true }), recorded)
  // A replace starts over, recording none: a State refuses one as it would a file it can't record.
  const state = new State(tmp, { lock: 'replace', bundle: 'replace', env: {}, claim: false })
  t.assert.throws(() => state.addFile(urlOf(tmp, 'node_modules/opt/index.js')), { message: 'stasis.config.json: excludeModules excludes opt@1.0.0 at node_modules/opt ("opt")' })
}))

test('stasis add and extra take a file of an excluded dependency for missing: named, not found; swept, never found', withTmp(async (t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  mkdirSync(join(tmp, 'src'))
  symlinkSync('../node_modules/opt/index.js', join(tmp, 'src/link.js'))
  const notFound = (rel) => `file not found: ${rel} (stasis.config.json: excludeModules excludes node_modules/opt ("opt"))`
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['node_modules/opt/index.js'] }), { message: `add: ${notFound('node_modules/opt/index.js')}` })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['node_modules/opt'] }), { message: `add: ${notFound('node_modules/opt')}` })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/link.js'] }), { message: `add: ${notFound('src/link.js')}` })
  addCommand({ cwd: tmp, entries: ['node_modules', 'src'] })
  t.assert.deepStrictEqual(sorted(readBundle(join(tmp, 'stasis.code.br')).sources.keys()),
    ['node_modules/left/index.js', 'node_modules/left/package.json', 'node_modules/optdep/index.js', 'node_modules/optdep/package.json'])

  // extra, by stasis run and stasis bundle alike: a glob matching an excluded package's files alone matches none.
  const fresh = (extra) => {
    project(tmp, { excludeModules: ['opt'], extra })
    rmSync(join(tmp, 'stasis.code.br'), { force: true })
  }
  fresh(['node_modules/opt/*.js'])
  const named = await runCli(['run', '--lock=add', 'a.js'], tmp)
  t.assert.notEqual(named.status, 0)
  t.assert.ok(named.stderr.includes(`extra: ${notFound('node_modules/opt/*.js')}`), named.stderr)
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'], mainFields: ['main'] }), { message: `extra: ${notFound('node_modules/opt/*.js')}` })
  fresh(['node_modules'])
  rmSync(join(tmp, 'stasis.lock.json'), { force: true })
  await bundleCommand({ cwd: tmp, entries: ['a.js'] })
  t.assert.ok(![...readBundle(join(tmp, 'stasis.code.br')).sources.keys()].some((path) => path.startsWith('node_modules/opt/')))
}))

test('stasis bundle takes an entry in an excluded dependency for missing', withTmp(async (t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['node_modules/opt/index.js'] }),
    { message: `entry not found: ${join(tmp, 'node_modules/opt/index.js')} (stasis.config.json: excludeModules excludes node_modules/opt ("opt"))` })
}))

test('CLI: stasis run --fs reads a file of an excluded dependency as missing, and writes what it captured', withTmp(async (t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  writeTree(tmp, {
    'r.js': [
      "const fs = require('node:fs')",
      "let read; try { read = fs.readFileSync('node_modules/opt/package.json', 'utf8') } catch (e) { read = e.code }",
      "console.log(read, fs.existsSync('node_modules/opt'), fs.existsSync('node_modules/left/package.json'))",
      '',
    ].join('\n'),
  })
  const ran = await runCli(['run', '--lock=add', '--bundle=add', '--fs=sync', 'r.js'], tmp)
  t.assert.equal(ran.status, 0, ran.stderr)
  t.assert.equal(ran.stdout, 'ENOENT false true\n')
  t.assert.ok(existsSync(join(tmp, 'stasis.code.br')))
  t.assert.ok(![...readBundle(join(tmp, 'stasis.code.br')).sources.keys()].some((path) => path.startsWith('node_modules/opt')))
}))

test('a pnpm alias is excluded by the name it is installed under, when bundled and when run', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'app', version: '1.0.0' },
    'a.js': "let nice; try { nice = require('nice') } catch (e) { nice = 'absent ' + e.code }\nconsole.log(nice)\n",
    'node_modules/.pnpm/opt@1.0.0/node_modules/opt/package.json': { name: 'opt', version: '1.0.0', main: 'index.js' },
    'node_modules/.pnpm/opt@1.0.0/node_modules/opt/index.js': "module.exports = 'opt'\n",
    'stasis.config.json': { excludeModules: ['nice'] },
  })
  symlinkSync('.pnpm/opt@1.0.0/node_modules/opt', join(tmp, 'node_modules/nice'))
  await bundleCommand({ cwd: tmp, entries: ['a.js'], output: join(tmp, 'a.br') })
  t.assert.deepStrictEqual(sorted(readBundle(join(tmp, 'a.br')).sources.keys()), ['a.js'])
  const ran = await runCli(['run', '--lock=add', 'a.js'], tmp)
  t.assert.equal(ran.status, 0, ran.stderr)
  t.assert.equal(ran.stdout, 'absent MODULE_NOT_FOUND\n')
}))

test('CLI: stasis run takes an excluded dependency for absent though a preload loaded it from the same directory', withTmp(async (t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  writeTree(tmp, { 'preload.mjs': "import { createRequire } from 'node:module'\ncreateRequire(import.meta.url)('opt')\n" })
  const ran = await runCli(['run', '--lock=add', '--import=./preload.mjs', 'a.js'], tmp)
  t.assert.equal(ran.status, 0, ran.stderr)
  t.assert.equal(ran.stdout, 'absent MODULE_NOT_FOUND unresolved MODULE_NOT_FOUND left\n')
}))

test('CLI: stasis run takes an excluded dependency for absent, and records nothing of it', withTmp(async (t, tmp) => {
  project(tmp, { excludeModules: ['opt'] })
  const ran = await runCli(['run', '--lock=add', 'a.js'], tmp)
  t.assert.equal(ran.status, 0, ran.stderr)
  t.assert.equal(ran.stdout, 'absent MODULE_NOT_FOUND unresolved MODULE_NOT_FOUND left\n')
  const lock = readLock(tmp)
  t.assert.deepStrictEqual(sorted(lock.modules.keys()), ['.', 'node_modules/left'])
  t.assert.ok(![...lock.imports.values()].some((byParent) => byParent.get('a.js')?.has('opt')))
  // As it records it: a frozen run takes it for absent too.
  const frozen = await runCli(['run', '--lock=frozen', 'a.js'], tmp)
  t.assert.equal(frozen.status, 0, frozen.stderr)
  t.assert.equal(frozen.stdout, ran.stdout)

  const dynamic = await runCli(['run', '--lock=add', 'c.mjs'], tmp)
  t.assert.equal(dynamic.status, 0, dynamic.stderr)
  t.assert.equal(dynamic.stdout, 'absent ERR_MODULE_NOT_FOUND\n')

  const staticImport = await runCli(['run', '--lock=add', 'b.mjs'], tmp)
  t.assert.notEqual(staticImport.status, 0)
  t.assert.match(staticImport.stderr, /Cannot find module 'opt' imported from .*b\.mjs \(stasis\.config\.json: excludeModules excludes node_modules\/opt \("opt"\)\)/u)
  t.assert.match(staticImport.stderr, /code: 'ERR_MODULE_NOT_FOUND'/u)
}))

test('CLI: stasis run --bundle=load of a bundle with an excluded dependency falls through, in either scope', withTmp(async (t, tmp) => {
  const loads = async (scope) => {
    project(tmp, { excludeModules: ['opt'], scope })
    await bundleCommand({ cwd: tmp, entries: ['a.js'] })
    const ran = await runCli(['run', '--lock=ignore', '--bundle=load', ...(scope === 'full' ? [] : ['--dependencies']), 'a.js'], tmp)
    t.assert.equal(ran.status, 0, ran.stderr)
    // As for any miss under --bundle=load: where the resolve hook sees a require() first (Node 24.22), getImport's.
    t.assert.match(ran.stdout, /^absent (ERR_)?MODULE_NOT_FOUND unresolved (ERR_)?MODULE_NOT_FOUND left\n$/u, scope)
  }
  await loads('full')
  // In node_modules scope, a.js is read from disk, and resolves opt there.
  await loads('node_modules')
}))

test('a workspace package linked into node_modules is the project\'s own, which excludeModules never takes for absent', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'app', version: '1.0.0' },
    'a.js': "console.log(require('foo'))\n",
    'packages/foo/package.json': { name: 'foo', version: '1.0.0', main: 'index.js' },
    'packages/foo/index.js': "module.exports = 'foo'\n",
    'stasis.config.json': { excludeModules: ['foo'] },
  })
  mkdirSync(join(tmp, 'node_modules'))
  symlinkSync('../packages/foo', join(tmp, 'node_modules/foo'))
  await bundleCommand({ cwd: tmp, entries: ['a.js'], output: join(tmp, 'a.br') })
  t.assert.deepStrictEqual(sorted(readBundle(join(tmp, 'a.br')).sources.keys()), ['a.js', 'packages/foo/index.js'])
  const ran = await runCli(['run', '--lock=add', 'a.js'], tmp)
  t.assert.equal(ran.status, 0, ran.stderr)
  t.assert.equal(ran.stdout, 'foo\n')
}))
