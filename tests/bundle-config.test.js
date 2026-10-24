import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Config } from '@exodus/stasis-core/config'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { bundlePlan, readConfigEntries } from '../stasis/src/cmd/bundle-options.js'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-bundle-config-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const writeTree = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
}

// A project with an app entry (platform files, for --metro) and a Node CLI entry.
const project = (dir, entries) => writeTree(dir, {
  'package.json': { name: 'app', version: '1.0.0' },
  'index.js': "require('./a')\n",
  'a.ios.js': "module.exports = 'ios'\n",
  'a.android.js': "module.exports = 'android'\n",
  'cli.js': "require('./b')\n",
  'b.js': 'module.exports = 1\n',
  ...(entries === undefined ? {} : { 'stasis.config.json': { entries } }),
})

const readBundle = (path) => Bundle.parse(brotliDecompressSync(readFileSync(path)).toString('utf8'))

const runCli = async (args, cwd) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))
  const child = spawn(process.execPath, [cli, ...args], { cwd, env })
  child.stdin.end()
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const [status] = await once(child, 'close')
  return { status, stderr }
}

test('readConfigEntries is null without a stasis.config.json or its entries', withTmp((t, tmp) => {
  t.assert.equal(readConfigEntries(tmp), null)
  writeTree(tmp, { 'stasis.config.json': { scope: 'full' } })
  t.assert.equal(readConfigEntries(tmp), null)
  writeTree(tmp, { 'stasis.config.json': { lock: 'frozen', extra: ['a.js'] } })
  t.assert.equal(readConfigEntries(tmp), null)
}))

test('readConfigEntries reads each entry\'s options as the flags they alias', withTmp((t, tmp) => {
  writeTree(tmp, {
    'stasis.config.json': {
      entries: {
        './src/index.js': { metro: true, 'metro-resolver': true, flow: true, jsx: false, platforms: ['ios', 'android'], resources: 'png,svg' },
        'node_modules/@react-native-community/cli/build/bin.js': { metro: false, conditions: ['node', 'require'] },
      },
    },
  })
  t.assert.deepStrictEqual([...readConfigEntries(tmp)], [
    ['src/index.js', { entry: './src/index.js', values: { metro: true, 'metro-resolver': true, flow: true, platforms: ['ios,android'], resources: 'png,svg' } }],
    ['node_modules/@react-native-community/cli/build/bin.js', { entry: 'node_modules/@react-native-community/cli/build/bin.js', values: { conditions: 'node,require' } }],
  ])
}))

test('readConfigEntries refuses what is no entry\'s options', withTmp((t, tmp) => {
  const refused = (entries, message) => {
    writeTree(tmp, { 'stasis.config.json': { entries } })
    t.assert.throws(() => readConfigEntries(tmp), { message })
  }
  refused(['index.js'], /entries must be an object of each entry's stasis bundle options/u)
  refused({ '../index.js': {} }, /entries "\.\.\/index\.js": an entry must be a path relative to the directory of stasis\.config\.json/u)
  refused({ '/abs/index.js': {} }, /an entry must be a path relative/u)
  refused({ 'index.js': {}, './index.js': {} }, /entries "\.\/index\.js" names the same entry as "index\.js"/u)
  refused({ 'index.js': true }, /entries "index\.js" must be an object of stasis bundle options/u)
  refused({ 'index.js': { minify: true } }, /entries "index\.js": unknown option "minify"/u)
  refused({ 'index.js': { output: 'x.br' } }, /output is the bundle's option, not an entry's: pass --output/u)
  refused({ 'index.js': { metro: 'yes' } }, /metro must be true or false/u)
  refused({ 'index.js': { platforms: 3 } }, /platforms must be a string or an array of strings/u)
  refused({ 'index.js': { tsconfig: ['a.json'] } }, /tsconfig must be a string$/u)
  writeTree(tmp, { 'stasis.config.json': '{' })
  t.assert.throws(() => readConfigEntries(tmp), { message: 'stasis.config.json is not valid JSON' })
}))

test('bundlePlan builds unnamed entries with the flags, as without the config', withTmp((t, tmp) => {
  project(tmp, { 'index.js': { metro: true, platforms: 'ios' } })
  const plan = bundlePlan({ cwd: tmp, entries: ['cli.js'], values: { jsx: true, output: 'x.br' }, config: readConfigEntries(tmp) })
  t.assert.deepStrictEqual(plan.entries, ['cli.js'])
  t.assert.equal(plan.jsx, true)
  t.assert.equal(plan.metro, false)
  t.assert.equal(plan.output, 'x.br')
  t.assert.equal(plan.builds, undefined)
  // Its consent rules don't apply either: a flag that runs the project's code is just the flag.
  const consented = bundlePlan({ cwd: tmp, entries: ['cli.js', 'b.js'], values: { metro: true, platforms: ['ios'], 'metro-resolver': true, babel: true }, config: readConfigEntries(tmp) })
  t.assert.deepStrictEqual([consented.entries, consented.metroResolver, consented.babel], [['cli.js', 'b.js'], true, true])
}))

test('bundlePlan builds named entries with their own options, the same ones together', withTmp((t, tmp) => {
  project(tmp, {
    'index.js': { metro: true, platforms: ['ios', 'android'], jsx: true },
    'cli.js': { metro: false },
    'b.js': {},
  })
  const plan = bundlePlan({ cwd: tmp, entries: ['index.js', 'cli.js', './b.js'], values: { lockfile: 'l.json', add: true }, config: readConfigEntries(tmp) })
  t.assert.equal(plan.entries, undefined)
  t.assert.deepStrictEqual([plan.lockfile, plan.add], ['l.json', true])
  t.assert.deepStrictEqual(plan.builds.map((b) => [b.entries, b.metro, b.platforms, b.jsx]), [
    [['index.js'], true, ['ios', 'android'], true],
    [['cli.js', './b.js'], false, [], false],
  ])
}))

test('bundlePlan refuses flags for named entries, and naming only some', withTmp((t, tmp) => {
  project(tmp, { 'index.js': { metro: true, platforms: 'ios' }, 'cli.js': {} })
  const config = readConfigEntries(tmp)
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js'], values: { jsx: true }, config }),
    { message: "--jsx can't be given for index.js, whose options stasis.config.json's entries set: set it there" })
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js', 'b.js'], values: {}, config }),
    { message: "stasis.config.json's entries name index.js but not b.js: bundle either the entries it names or others, not both" })
  writeTree(tmp, { 'stasis.config.json': { entries: { 'index.js': { metro: true } } } })
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js'], values: {}, config: readConfigEntries(tmp) }),
    { message: 'stasis.config.json: entries "index.js": --metro requires --platforms (e.g. --platforms=ios,android)' })
}))

test('bundlePlan takes an option that runs the project\'s code from the config only with its flag as consent', withTmp((t, tmp) => {
  project(tmp, {
    'index.js': { metro: true, platforms: 'ios', 'metro-resolver': true },
    'cli.js': { metro: true, platforms: 'ios' },
    'b.js': {},
  })
  const config = readConfigEntries(tmp)
  // Set for an entry, but not given.
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js', 'cli.js'], values: {}, config }),
    { message: 'stasis.config.json: entries "index.js" sets metro-resolver, which runs the project\'s metro-resolver: pass --metro-resolver to allow it' })
  // Given, but set for none of the entries.
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['cli.js', 'b.js'], values: { 'metro-resolver': true }, config }),
    { message: "--metro-resolver is given, but stasis.config.json's entries set metro-resolver for none of cli.js, b.js" })
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js'], values: { 'metro-resolver': true, babel: true }, config }),
    { message: "--babel is given, but stasis.config.json's entries set babel for none of index.js" })
  // Given, and set for some: it applies to those alone.
  const plan = bundlePlan({ cwd: tmp, entries: ['index.js', 'cli.js'], values: { 'metro-resolver': true }, config })
  t.assert.deepStrictEqual(plan.builds.map((b) => [b.entries, b.metroResolver]), [[['index.js'], true], [['cli.js'], false]])
  // cargo-target runs rustc: its consent is the flag with the same value.
  writeTree(tmp, { 'stasis.config.json': { entries: { 'a.rs': { 'cargo-target': 'host' }, 'b.rs': {} } } })
  const rust = readConfigEntries(tmp)
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['a.rs'], values: {}, config: rust }),
    { message: 'stasis.config.json: entries "a.rs" sets cargo-target=host, which runs rustc: pass --cargo-target=host to allow it' })
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['a.rs', 'b.rs'], values: { 'cargo-target': 'aarch64-apple-darwin' }, config: rust }),
    { message: "--cargo-target=aarch64-apple-darwin is given, but stasis.config.json's entries set cargo-target=aarch64-apple-darwin for none of a.rs, b.rs" })
  const targeted = bundlePlan({ cwd: tmp, entries: ['a.rs', 'b.rs'], values: { 'cargo-target': 'host' }, config: rust })
  t.assert.deepStrictEqual(targeted.builds.map((b) => [b.entries, b.cargoTarget]), [[['a.rs'], 'host'], [['b.rs'], null]])
}))

test('bundlePlan takes an entry\'s flow from the config alone, as stasis strips with its own flow-remove-types', withTmp((t, tmp) => {
  project(tmp, { 'index.js': { flow: true }, 'cli.js': {} })
  const config = readConfigEntries(tmp)
  const plan = bundlePlan({ cwd: tmp, entries: ['index.js', 'cli.js'], values: {}, config })
  t.assert.deepStrictEqual(plan.builds.map((b) => [b.entries, b.flow]), [[['index.js'], true], [['cli.js'], false]])
  // It is an entry's option like any other: set there, not as a flag.
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js'], values: { flow: true }, config }),
    { message: "--flow can't be given for index.js, whose options stasis.config.json's entries set: set it there" })
}))

test('bundlePlan takes an entry\'s babel-aliases from the config alone, as reading a JSON file runs nothing', withTmp((t, tmp) => {
  project(tmp, { 'index.js': { metro: true, platforms: 'ios', 'babel-aliases': 'aliases.json' } })
  const config = readConfigEntries(tmp)
  t.assert.equal(bundlePlan({ cwd: tmp, entries: ['index.js'], values: {}, config }).builds[0].babelAliases, 'aliases.json')
  // It is an entry's option like any other: set there, not as a flag.
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js'], values: { 'babel-aliases': 'aliases.json' }, config }),
    { message: "--babel-aliases can't be given for index.js, whose options stasis.config.json's entries set: set it there" })
  writeTree(tmp, { 'stasis.config.json': { entries: { 'index.js': { 'babel-aliases': 'aliases.json' } } } })
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js'], values: {}, config: readConfigEntries(tmp) }),
    { message: 'stasis.config.json: entries "index.js": --babel-aliases is only valid with --metro' })
}))

test('bundleCommand builds each of builds and writes their union: bundle:metro beside bundle', withTmp(async (t, tmp) => {
  project(tmp)
  await bundleCommand({
    cwd: tmp,
    lockfile: 'stasis.lock.json',
    builds: [
      { entries: ['index.js'], metro: true, platforms: ['ios', 'android'] },
      { entries: ['cli.js'] },
    ],
  })
  const bundle = readBundle(join(tmp, 'stasis.code.br'))
  t.assert.deepStrictEqual([...bundle.entries].toSorted(), ['cli.js', 'index.js'])
  t.assert.deepStrictEqual(bundle.reason, { 'bundle': ['b.js', 'cli.js'], 'bundle:metro': ['a.android.js', 'a.ios.js', 'index.js'] })
  // The lockfile attests both builds' files.
  const lock = Lockfile.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))
  t.assert.deepStrictEqual(Object.keys(lock.modules.get('.').files).toSorted(), ['a.android.js', 'a.ios.js', 'b.js', 'cli.js', 'index.js'])
}))

test('bundleCommand adds the config\'s extra once, beside each build\'s own consumer', withTmp(async (t, tmp) => {
  project(tmp)
  writeTree(tmp, { 'tool.js': 'module.exports = 2\n', 'stasis.config.json': { extra: ['tool.js'] } })
  await bundleCommand({ cwd: tmp, output: 'metro.br', metro: true, platforms: ['ios'], entries: ['index.js'] })
  // A --metro build's files stay bundle:metro's alone.
  t.assert.deepStrictEqual(readBundle(join(tmp, 'metro.br')).reason, { 'bundle:metro': ['a.ios.js', 'index.js'], 'extra': ['tool.js'] })
  await bundleCommand({ cwd: tmp, output: 'both.br', builds: [{ entries: ['index.js'], metro: true, platforms: ['ios'] }, { entries: ['cli.js'] }] })
  t.assert.deepStrictEqual(readBundle(join(tmp, 'both.br')).reason, { 'bundle': ['b.js', 'cli.js'], 'bundle:metro': ['a.ios.js', 'index.js'], 'extra': ['tool.js'] })
}))

test('bundleCommand adds builds\' extra by the config\'s resources, whatever their number and order', withTmp(async (t, tmp) => {
  project(tmp)
  writeTree(tmp, { 'logo.png': 'png\n', 'stasis.config.json': { extra: ['logo.png'] } })
  const builds = [{ entries: ['index.js'], metro: true, platforms: ['ios'], resources: ['png'] }, { entries: ['cli.js'] }]
  // An entry's `resources` is its graph's, not the bundle's: neither order takes logo.png by it,
  // nor that entry built alone.
  await t.assert.rejects(bundleCommand({ cwd: tmp, output: 'x.br', builds }), /logo\.png/u)
  await t.assert.rejects(bundleCommand({ cwd: tmp, output: 'x.br', builds: builds.toReversed() }), /logo\.png/u)
  await t.assert.rejects(bundleCommand({ cwd: tmp, output: 'x.br', builds: builds.slice(0, 1) }), /logo\.png/u)
  writeTree(tmp, { 'stasis.config.json': { extra: ['logo.png'], resources: ['png'] } })
  await bundleCommand({ cwd: tmp, output: 'a.br', builds })
  await bundleCommand({ cwd: tmp, output: 'b.br', builds: builds.toReversed() })
  t.assert.equal(readBundle(join(tmp, 'a.br')).serialize(), readBundle(join(tmp, 'b.br')).serialize())
  t.assert.deepStrictEqual(readBundle(join(tmp, 'a.br')).reason.extra, ['logo.png'])
  t.assert.equal(readBundle(join(tmp, 'a.br')).formats.get('logo.png'), 'resource')
}))

test('bundleCommand refuses builds with entries, or whose bundles are rooted apart', withTmp(async (t, tmp) => {
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['index.js'], builds: [{ entries: ['cli.js'] }] }),
    { message: "bundleCommand: entries can't be combined with builds (each build sets its own)" })
  // A workspace package: a Node build's paths are relative to the workspace root, a Metro build's to cwd.
  writeTree(tmp, { 'package.json': { name: 'root', version: '1.0.0' } })
  const pkg = join(tmp, 'pkg')
  project(pkg)
  await t.assert.rejects(bundleCommand({ cwd: pkg, builds: [{ entries: ['index.js'], metro: true, platforms: ['ios'] }, { entries: ['cli.js'] }] }),
    { message: /^bundleCommand: index\.js and cli\.js can't be bundled together: their bundles' paths are relative to different roots/u })
}))

test('Config takes stasis bundle\'s entries, and nothing from them', (t) => {
  const config = new Config({ env: {}, lock: 'add', bundle: 'add' })
  config.loadConfig(JSON.stringify({ entries: { 'index.js': { metro: true } }, scope: 'full' }))
  t.assert.deepStrictEqual([config.lock, config.bundleMode, config.scope], ['add', 'add', 'full'])
  t.assert.throws(() => new Config({ env: {}, lock: 'add' }).loadConfig(JSON.stringify({ bundle: { 'index.js': {} } })), /bundle can not be set here/u)
})

test('CLI: stasis bundle alone bundles the entries stasis.config.json names, each with its options', withTmp(async (t, tmp) => {
  project(tmp, { 'index.js': { metro: true, platforms: ['ios', 'android'] }, 'cli.js': { metro: false } })
  const r = await runCli(['bundle'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  const bundle = readBundle(join(tmp, 'stasis.code.br'))
  t.assert.deepStrictEqual(Object.keys(bundle.reason), ['bundle', 'bundle:metro'])
  t.assert.deepStrictEqual(bundle.reason['bundle:metro'], ['a.android.js', 'a.ios.js', 'index.js'])
  // As naming them would.
  const named = await runCli(['bundle', '--output=named.br', 'index.js', 'cli.js'], tmp)
  t.assert.equal(named.status, 0, named.stderr)
  t.assert.equal(readBundle(join(tmp, 'named.br')).serialize(), bundle.serialize())
}))

test('CLI: stasis bundle refuses a flag for an entry stasis.config.json names', withTmp(async (t, tmp) => {
  project(tmp, { 'index.js': { metro: true, platforms: 'ios' } })
  const r = await runCli(['bundle', '--jsx', 'index.js'], tmp)
  t.assert.equal(r.status, 1)
  t.assert.match(r.stderr, /Error: --jsx can't be given for index\.js, whose options stasis\.config\.json's entries set/u)
  // An option that runs the project's code needs its flag as consent.
  writeTree(tmp, { 'stasis.config.json': { entries: { 'index.js': { metro: true, platforms: 'ios', babel: true } } } })
  const unconsented = await runCli(['bundle'], tmp)
  t.assert.equal(unconsented.status, 1)
  t.assert.match(unconsented.stderr, /Error: stasis\.config\.json: entries "index\.js" sets babel, which runs the project's Babel config: pass --babel to allow it/u)
  // An entry it doesn't name takes flags, as without it.
  const plain = await runCli(['bundle', '--mainFields=main', '--output=plain.br', 'cli.js'], tmp)
  t.assert.equal(plain.status, 0, plain.stderr)
  t.assert.deepStrictEqual(Object.keys(readBundle(join(tmp, 'plain.br')).reason), ['bundle'])
}))

test('CLI: stasis bundle strips an entry\'s Flow types with stasis\'s own flow-remove-types, no --flow given', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'app', version: '1.0.0', type: 'module' },
    'index.js': 'import type { T } from "./types.js"\nimport { dep } from "./dep.js"\nexport const v: number = dep\n',
    'dep.js': 'export const dep = 1\n',
    'types.js': 'export const T = 1\n',
    'stasis.config.json': { entries: { 'index.js': { flow: true } } },
    // The project's own copy, which marks itself loaded: never the one stasis runs.
    'node_modules/flow-remove-types/package.json': { name: 'flow-remove-types', version: '2.0.0', main: 'index.js' },
    'node_modules/flow-remove-types/index.js': "require('fs').writeFileSync(require('path').join(__dirname, 'loaded'), '')\nmodule.exports = () => { throw new Error('the project copy') }\n",
  })
  const r = await runCli(['bundle'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.deepStrictEqual(readBundle(join(tmp, 'stasis.code.br')).reason, { bundle: ['dep.js', 'index.js'] })
  t.assert.throws(() => readFileSync(join(tmp, 'node_modules/flow-remove-types/loaded')), { code: 'ENOENT' })
}))

test('readConfigEntries reads an entry\'s define as the --define flags it gives, each one whole', withTmp((t, tmp) => {
  writeTree(tmp, {
    'stasis.config.json': {
      entries: {
        'index.js': { define: ['__DEV__=false', 'process.env.NODE_ENV="production,min"'] },
        'cli.js': { define: '__DEV__=true' },
      },
    },
  })
  t.assert.deepStrictEqual([...readConfigEntries(tmp)].map(([key, { values }]) => [key, values]), [
    ['index.js', { define: ['__DEV__=false', 'process.env.NODE_ENV="production,min"'] }],
    ['cli.js', { define: ['__DEV__=true'] }],
  ])
  writeTree(tmp, { 'stasis.config.json': { entries: { 'index.js': { define: { __DEV__: false } } } } })
  t.assert.throws(() => readConfigEntries(tmp), /entries "index\.js": define must be a string or an array of strings/u)
}))

test('bundlePlan parses --define, and builds entries whose defines differ apart', withTmp((t, tmp) => {
  const plan = bundlePlan({ cwd: tmp, entries: ['index.js'], values: { define: ['__DEV__=false', 'process.env.NODE_ENV="production"', 'LEVEL=2', 'TAG=null'] } })
  t.assert.deepStrictEqual(plan.define, { __DEV__: false, 'process.env.NODE_ENV': 'production', LEVEL: 2, TAG: null })
  t.assert.equal(bundlePlan({ cwd: tmp, entries: ['index.js'], values: {} }).define, undefined)
  const refused = (values, entries, message) => t.assert.throws(() => bundlePlan({ cwd: tmp, entries, values }), { message })
  refused({ define: ['__DEV__'] }, ['index.js'], '--define must be KEY=VALUE (e.g. --define=__DEV__=false), not "__DEV__"')
  refused({ define: ['=false'] }, ['index.js'], '--define must be KEY=VALUE (e.g. --define=__DEV__=false), not "=false"')
  refused({ define: ['process.env.NODE_ENV=production'] }, ['index.js'],
    '--define\'s value for process.env.NODE_ENV must be JSON: a string, quoted (--define=process.env.NODE_ENV=\'"production"\'), a number, true, false or null, not "production"')
  refused({ define: ['__DEV__=[]'] }, ['index.js'], '--define\'s value for __DEV__ must be a string, number, boolean or null, not []')
  refused({ define: ['process.env["X"]=1'] }, ['index.js'], '--define names an identifier or a dotted path of them (e.g. __DEV__, process.env.NODE_ENV), not "process.env[\\"X\\"]"')
  refused({ define: ['A=1', 'A=2'] }, ['index.js'], '--define gives A a value twice')
  refused({ define: ['A=1'] }, ['src/A.sol'], '--define is only valid for JS bundles')

  project(tmp, {
    'index.js': { define: ['__DEV__=false'] },
    'cli.js': { define: '__DEV__=true' },
    'b.js': { define: ['__DEV__=false'] },
  })
  const builds = bundlePlan({ cwd: tmp, entries: ['index.js', 'cli.js', 'b.js'], values: {}, config: readConfigEntries(tmp) }).builds
  t.assert.deepStrictEqual(builds.map((b) => [b.entries, b.define]), [[['index.js', 'b.js'], { __DEV__: false }], [['cli.js'], { __DEV__: true }]])
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js'], values: { define: ['__DEV__=true'] }, config: readConfigEntries(tmp) }),
    { message: "--define can't be given for index.js, whose options stasis.config.json's entries set: set it there" })
  writeTree(tmp, { 'stasis.config.json': { entries: { 'index.js': { define: [] } } } })
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['index.js'], values: {}, config: readConfigEntries(tmp) }),
    { message: 'stasis.config.json: entries "index.js": --define must give at least one KEY=VALUE (e.g. --define=__DEV__=false)' })
}))

test('CLI: stasis bundle --define leaves out the imports of the branches it keeps from running', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'app', version: '1.0.0' },
    'index.js': "if (__DEV__) require('./dev.js')\nif (process.env.NODE_ENV !== 'production') require('./notProd.js')\nrequire('./b.js')\n",
    'dev.js': 'module.exports = 1\n',
    'notProd.js': 'module.exports = 1\n',
    'b.js': 'module.exports = 1\n',
  })
  const r = await runCli(['bundle', '--define=__DEV__=false', '--define', 'process.env.NODE_ENV="production"', '--output=release.br', 'index.js'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.deepStrictEqual([...readBundle(join(tmp, 'release.br')).sources.keys()].toSorted(), ['b.js', 'index.js'])
  // stasis.config.json's entries give it too.
  writeTree(tmp, { 'stasis.config.json': { entries: { 'index.js': { define: ['__DEV__=true'] } } } })
  const configured = await runCli(['bundle', '--output=dev.br'], tmp)
  t.assert.equal(configured.status, 0, configured.stderr)
  t.assert.deepStrictEqual([...readBundle(join(tmp, 'dev.br')).sources.keys()].toSorted(), ['b.js', 'dev.js', 'index.js', 'notProd.js'])
  const bad = await runCli(['bundle', '--define=process.env.NODE_ENV=production', 'b.js'], tmp)
  t.assert.equal(bad.status, 1)
  t.assert.match(bad.stderr, /Error: --define's value for process\.env\.NODE_ENV must be JSON/u)
}))
