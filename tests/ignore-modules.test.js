import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { addCommand } from '@exodus/stasis-core/add'
import { parseBundleBytes } from '@exodus/stasis-core/brotli'
import { Config } from '@exodus/stasis-core/config'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { parsePolicy } from '@exodus/stasis-core/policy'
import { State } from '@exodus/stasis-core/state'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { bundlePlan, readConfigEntries } from '../stasis/src/cmd/bundle-options.js'
import { withTmp } from './tmp.helper.js'

// stasis.config.json's ignoreModules: dependencies taken for absent. No build or run reaches one, so no
// lockfile or bundle carries one, and an import of one misses as an import of a package not installed does:
// past a require() or import(), where the program can catch it, it falls through; a static import fails.

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
  return { status, stdout, stderr }
}

// The console.warn lines `fn` says.
const warned = async (t, fn) => {
  const said = []
  t.mock.method(console, 'warn', (...args) => said.push(args.join(' ')))
  try {
    await fn()
  } finally {
    console.warn.mock.restore()
  }
  return said.join('\n')
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

test('ignoreModules takes a dependency by either name it goes by, as disallowedModules does', (t) => {
  const policy = parsePolicy('cfg', { ignoreModules: ['opt', '@skip/*'] })
  t.assert.ok(policy.ignoresModules)
  t.assert.equal(parsePolicy('cfg', { disallowedModules: ['opt'] }).ignoresModules, false)
  const none = () => undefined
  t.assert.deepStrictEqual(policy.ignoredAt('node_modules/opt/index.js', none), { dir: 'node_modules/opt', name: 'opt', pattern: 'opt', label: 'cfg' })
  t.assert.equal(policy.ignoredAt('node_modules/.pnpm/opt@1.0.0/node_modules/opt/lib/x.js', none).dir, 'node_modules/.pnpm/opt@1.0.0/node_modules/opt')
  t.assert.equal(policy.ignoredAt('node_modules/@skip/thing/index.js', none).pattern, '@skip/*')
  // Installed under another name, by its package.json's.
  t.assert.equal(policy.ignoredAt('node_modules/nice/index.js', () => 'opt').name, 'opt')
  t.assert.equal(policy.ignoredAt('node_modules/left/index.js', none), undefined)
  // The project's own files are no dependency's.
  t.assert.equal(policy.ignoredAt('opt/index.js', none), undefined)
  t.assert.throws(() => parsePolicy('cfg', { ignoreModules: ['node_modules/opt'] }), { message: 'cfg: ignoreModules: "node_modules/opt" is no package name or pattern of names (such as "left-pad", "@babel/*")' })
  t.assert.throws(() => parsePolicy('cfg', { ignoreModules: 'opt' }), { message: 'cfg: ignoreModules must be an array of non-empty strings' })
  // An artifact carrying one is refused.
  t.assert.throws(() => policy.assertPath('node_modules/opt/index.js', { dir: 'node_modules/opt', name: 'opt', version: '1.0.0' }), {
    message: 'cfg: ignoreModules ignores opt@1.0.0 at node_modules/opt ("opt")',
  })
})

test('Config takes ignoreModules from stasis.config.json alone', (t) => {
  const config = new Config({ env: {}, lock: 'add' })
  config.loadConfig(JSON.stringify({ ignoreModules: ['opt'] }))
  t.assert.equal(config.policy.key, JSON.stringify({ ignoreModules: ['opt'] }))
  t.assert.throws(() => new Config({ env: {}, lock: 'add', ignoreModules: ['opt'] }), /Unknown Config options: ignoreModules/u)
})

test('bundleCommand takes an ignored dependency for absent: a require() or import() of it falls through, a static import fails', withTmp(async (t, tmp) => {
  project(tmp, { ignoreModules: ['opt'] })
  const out = join(tmp, 'stasis.code.br')
  // Built through a State, and with --mainFields' resolver, without one.
  const builds = async (options) => {
    const said = await warned(t, () => bundleCommand({ cwd: tmp, entries: ['a.js'], ...options }))
    t.assert.match(said, /unresolved import\(s\)(?: \(mainFields\))?; they will fall through at load time:\n {2}require opt from a\.js \(ignored by ignoreModules\)/u, JSON.stringify(options))
    const bundle = readBundle(out)
    t.assert.deepStrictEqual(sorted(bundle.sources.keys()), ['a.js', 'node_modules/left/index.js'], 'neither opt nor what only it reaches')
    t.assert.deepStrictEqual(sorted(bundle.modules.keys()), ['.', 'node_modules/left'])

    await bundleCommand({ cwd: tmp, entries: ['c.mjs'], ...options })
    t.assert.deepStrictEqual(sorted(readBundle(out).sources.keys()), ['c.mjs'])
    // As for a miss, a static import past an import() falls through too: the import() catches it.
    await bundleCommand({ cwd: tmp, entries: ['d.mjs'], ...options })
    t.assert.deepStrictEqual(sorted(readBundle(out).sources.keys()), ['d.mjs', 'lazy.mjs'])

    await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['b.mjs'], output: join(tmp, 'b.br'), ...options }), {
      message: /^JS bundle would be broken at load time(?: \(mainFields\))?:\n {2}unresolved import opt from b\.mjs \(ignored by ignoreModules\)$/u,
    })
    t.assert.ok(!existsSync(join(tmp, 'b.br')))
  }
  await builds({})
  await builds({ mainFields: ['main'] })
}))

test('bundleCommand takes for absent what an entry\'s own ignoreModules ignores, in its own build alone', withTmp(async (t, tmp) => {
  project(tmp, { entries: { 'a.js': { ignoreModules: ['opt'] }, 'f.js': {} } })
  const config = readConfigEntries(tmp)
  t.assert.equal(config.get('a.js').policy.key, JSON.stringify({ ignoreModules: ['opt'] }))
  await bundleCommand({ cwd: tmp, builds: bundlePlan({ cwd: tmp, entries: ['a.js', 'f.js'], values: {}, config }).builds })
  const bundle = readBundle(join(tmp, 'stasis.code.br'))
  // f.js reaches opt, which a.js's build takes for absent.
  t.assert.ok(bundle.sources.has('node_modules/opt/index.js'))
  t.assert.equal(bundle.imports.get('*')?.get('a.js')?.has('opt') ?? false, false)
  t.assert.equal(bundle.imports.get('*').get('f.js').get('opt'), 'node_modules/opt/index.js')
  // The config's ignoreModules is every entry's: an entry's build reaching it statically fails.
  project(tmp, { ignoreModules: ['opt'], entries: { 'a.js': {}, 'b.mjs': { jsx: true } } })
  const { builds } = bundlePlan({ cwd: tmp, entries: ['a.js', 'b.mjs'], values: {}, config: readConfigEntries(tmp) })
  t.assert.equal(builds.length, 2)
  await t.assert.rejects(bundleCommand({ cwd: tmp, builds }), /unresolved import opt from b\.mjs \(ignored by ignoreModules\)/u)
}))

test('a lockfile or bundle that carries an ignored dependency is refused, as one carrying a disallowed one', withTmp(async (t, tmp) => {
  project(tmp)
  await bundleCommand({ cwd: tmp, entries: ['f.js'], lockfile: 'stasis.lock.json' })
  writeTree(tmp, { 'stasis.config.json': { ignoreModules: ['opt'] } })
  const hint = /^stasis\.config\.json: ignoreModules ignores opt@1\.0\.0 at node_modules\/opt \("opt"\) -- recorded in stasis\.(?:lock\.json|code\.br); rebuild it \(lock=replace \/ bundle=replace\)$/u
  for (const modes of [{ lock: 'frozen', bundle: 'ignore' }, { lock: 'ignore', bundle: 'load' }, { lock: 'add', bundle: 'add' }]) {
    t.assert.throws(() => new State(tmp, { ...modes, env: {}, claim: false }), { message: hint }, JSON.stringify(modes))
  }
  // A State never records one, nor stasis add.
  const state = new State(tmp, { lock: 'replace', bundle: 'replace', env: {}, claim: false })
  t.assert.throws(() => state.addFile(urlOf(tmp, 'node_modules/opt/index.js')), { message: 'stasis.config.json: ignoreModules ignores opt@1.0.0 at node_modules/opt ("opt")' })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['node_modules/opt/index.js'] }), /ignoreModules ignores opt@1\.0\.0 at node_modules\/opt/u)
}))

test('CLI: stasis run takes an ignored dependency for absent, and records nothing of it', withTmp(async (t, tmp) => {
  project(tmp, { ignoreModules: ['opt'] })
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
  t.assert.match(staticImport.stderr, /Cannot find module 'opt' imported from .*b\.mjs \(stasis\.config\.json: ignoreModules ignores node_modules\/opt \("opt"\)\)/u)
  t.assert.match(staticImport.stderr, /code: 'ERR_MODULE_NOT_FOUND'/u)
}))

test('CLI: stasis run --bundle=load of a bundle with an ignored dependency falls through, in either scope', withTmp(async (t, tmp) => {
  const loads = async (scope) => {
    project(tmp, { ignoreModules: ['opt'], scope })
    await bundleCommand({ cwd: tmp, entries: ['a.js'] })
    const ran = await runCli(['run', '--lock=ignore', '--bundle=load', ...(scope === 'full' ? [] : ['--dependencies']), 'a.js'], tmp)
    t.assert.equal(ran.status, 0, ran.stderr)
    t.assert.equal(ran.stdout, 'absent MODULE_NOT_FOUND unresolved MODULE_NOT_FOUND left\n', scope)
  }
  await loads('full')
  // In node_modules scope, a.js is read from disk, and resolves opt there.
  await loads('node_modules')
}))
