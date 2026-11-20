import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Config } from '@exodus/stasis-core/config'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { bundlePlan, configEntries, readConfigDefine, readConfigEntries } from '../stasis/src/cmd/bundle-options.js'
import { withTmp } from './tmp.helper.js'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')

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
  refused({ 'index.js': { 'lockfile-only': true } }, /lockfile-only is the bundle's option, not an entry's: pass --lockfile-only/u)
  refused({ 'index.js': { metro: 'yes' } }, /metro must be true or false/u)
  refused({ 'index.js': { platforms: 3 } }, /platforms must be a string or an array of strings/u)
  refused({ 'index.js': { tsconfig: ['a.json'] } }, /tsconfig must be a string$/u)
  writeTree(tmp, { 'stasis.config.json': '{' })
  t.assert.throws(() => readConfigEntries(tmp), { message: 'stasis.config.json is not valid JSON' })
}))

// Two apps and what no pattern takes: a dot directory's, and a dependency's.
const apps = (dir, config) => writeTree(dir, {
  'package.json': { name: 'apps', version: '1.0.0' },
  'apps/b/src/index.js': "require('./own')\n",
  'apps/b/src/own.js': 'module.exports = 2\n',
  'apps/a/src/index.js': "require('../../../lib/shared')\n",
  'apps/a/src/worker.ts': 'export default 1\n',
  'apps/.cache/src/index.js': '',
  'apps/a/node_modules/dep/index.js': '',
  'lib/shared.js': 'module.exports = 1\n',
  'stasis.config.json': config,
})

test('readConfigEntries takes a glob pattern as the paths it matches, each an entry of its options', withTmp((t, tmp) => {
  const read = (entries, config) => {
    apps(tmp, { ...config, entries })
    return readConfigEntries(tmp)
  }
  t.assert.deepStrictEqual([...read({ 'apps/*/src/index.js': { jsx: true }, 'lib/shared.js': {} })], [
    ['apps/a/src/index.js', { entry: 'apps/*/src/index.js', values: { jsx: true } }],
    ['apps/b/src/index.js', { entry: 'apps/*/src/index.js', values: { jsx: true } }],
    ['lib/shared.js', { entry: 'lib/shared.js', values: {} }],
  ], 'sorted, no dot directory')
  const keys = (entries) => [...read(entries).keys()]
  // As Node's glob reads it, past a leading `./`; `**` skips a node_modules, and no pattern reaches into one.
  t.assert.deepStrictEqual(keys({ 'apps/**/index.js': {} }), ['apps/a/src/index.js', 'apps/b/src/index.js'])
  t.assert.deepStrictEqual(keys({ 'apps/*/node_modules/*/index.js': {} }), ['apps/*/node_modules/*/index.js'])
  t.assert.deepStrictEqual(keys({ './apps/*/src/*.{js,ts}': {} }), ['apps/a/src/index.js', 'apps/a/src/worker.ts', 'apps/b/src/index.js', 'apps/b/src/own.js'])
  t.assert.deepStrictEqual(keys({ 'apps/!(a)/src/[io]*.js': {} }), ['apps/b/src/index.js', 'apps/b/src/own.js'])
  t.assert.deepStrictEqual(keys({ 'apps/.*/src/index.js': {} }), ['apps/.cache/src/index.js'])
  // Matching nothing, it stands for itself, as a shell's: a missing entry, or a file of that very name.
  t.assert.deepStrictEqual([...read({ 'nope/*/index.js': { jsx: true } })], [['nope/*/index.js', { entry: 'nope/*/index.js', values: { jsx: true } }]])
  writeTree(tmp, { 'app/[id].js': '' })
  t.assert.deepStrictEqual([...read({ './app/[id].js': {} })], [['app/[id].js', { entry: './app/[id].js', values: {} }]])
  // The config's own define is each JS match's, and an entry's rules are held once.
  const typed = read({ 'apps/a/src/*': { allowedPaths: ['apps/a'] }, 'contracts/*.sol': {} }, { define: 'A=1' })
  t.assert.deepStrictEqual([...typed].map(([key, { values }]) => [key, values]), [['apps/a/src/index.js', { define: ['A=1'] }], ['apps/a/src/worker.ts', { define: ['A=1'] }], ['contracts/*.sol', {}]])
  t.assert.equal(typed.get('apps/a/src/index.js').policy, typed.get('apps/a/src/worker.ts').policy)
  // With no entry given: each as written, a pattern's as matched.
  t.assert.deepStrictEqual(configEntries(read({ './lib/shared.js': {}, 'apps/*/src/index.js': {}, 'nope/*.js': {} })), ['./lib/shared.js', 'apps/a/src/index.js', 'apps/b/src/index.js', 'nope/*.js'])
  t.assert.deepStrictEqual(configEntries(null), [])
}))

test('readConfigEntries refuses two keys naming the same file, a pattern and a path or two patterns, and a pattern walking through . or .. or matching out of the directory', withTmp((t, tmp) => {
  const refused = (entries, message) => {
    apps(tmp, { entries })
    t.assert.throws(() => readConfigEntries(tmp), { message })
  }
  refused({ 'apps/*/src/index.js': {}, 'apps/b/src/index.js': { jsx: true } }, 'stasis.config.json: entries "apps/b/src/index.js" names the same entry as "apps/*/src/index.js": apps/b/src/index.js')
  refused({ './apps/b/src/index.js': {}, 'apps/*/src/index.js': {} }, 'stasis.config.json: entries "apps/*/src/index.js" names the same entry as "./apps/b/src/index.js": apps/b/src/index.js')
  refused({ 'apps/*/src/index.js': {}, 'apps/**/*.ts': {}, 'apps/{a,c}/src/*.js': {} }, 'stasis.config.json: entries "apps/{a,c}/src/*.js" names the same entry as "apps/*/src/index.js": apps/a/src/index.js')
  // A path's `..` is resolved; a pattern's would be walked by the glob alone, which `stasis build` has none of.
  apps(tmp, { entries: { './apps/a/../b/src/index.js': {} } })
  t.assert.deepStrictEqual([...readConfigEntries(tmp).keys()], ['apps/b/src/index.js'])
  for (const pattern of ['apps/*/../a/src/index.js', '{apps/a,lib}/../lib/shared.js', '{./apps,lib}/*.js', './apps/./*/src/index.js', '{..,apps}/*.js']) {
    refused({ [pattern]: {} }, `stasis.config.json: entries ${JSON.stringify(pattern)}: a glob pattern may hold no . or .. segment but a leading ./`)
  }
  const outside = /an entry must be a path relative to the directory of stasis\.config\.json, within it$/u
  refused({ '../*.js': {} }, outside)
  writeTree(tmp, { 'sub/a.js': '', 'sub/stasis.config.json': { entries: { '..{,x}/lib/*.js': {} } } })
  t.assert.throws(() => readConfigEntries(join(tmp, 'sub')), { message: outside }, 'a brace list building a .. to climb out')
}))

test('bundlePlan builds what a pattern matches with its options, an entry given among them too', withTmp((t, tmp) => {
  apps(tmp, { entries: { 'apps/*/src/index.js': { jsx: true, allowedPaths: ['apps', 'lib'] }, 'apps/a/src/*.ts': { typescript: true }, 'lib/*.js': { jsx: true } } })
  const config = readConfigEntries(tmp)
  const plan = bundlePlan({ cwd: tmp, entries: configEntries(config), values: {}, config })
  t.assert.deepStrictEqual(plan.builds.map((b) => [b.entries, b.jsx, b.typescript, b.policy?.label]), [
    [['apps/a/src/index.js', 'apps/b/src/index.js'], true, false, 'stasis.config.json: entries "apps/*/src/index.js"'],
    [['apps/a/src/worker.ts'], false, true, undefined],
    [['lib/shared.js'], true, false, undefined],
  ])
  const one = bundlePlan({ cwd: tmp, entries: ['./apps/b/src/index.js'], values: {}, config })
  t.assert.deepStrictEqual(one.builds.map((b) => [b.entries, b.jsx]), [[['./apps/b/src/index.js'], true]])
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['apps/b/src/index.js'], values: { flow: true }, config }),
    { message: "--flow can't be given for apps/b/src/index.js, whose options stasis.config.json's entries set: set it there" })
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['apps/b/src/index.js', 'apps/b/src/own.js'], values: {}, config }),
    { message: "stasis.config.json's entries name apps/b/src/index.js but not apps/b/src/own.js: bundle either the entries it names or others, not both" })
  // The pattern itself, given, is no entry it names: a shell would have expanded it.
  t.assert.deepStrictEqual(bundlePlan({ cwd: tmp, entries: ['apps/*/src/index.js'], values: { flow: true }, config }).entries, ['apps/*/src/index.js'])
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

test('bundleCommand carries an entry\'s Metro, React Native and Babel configs where it builds with --metro', withTmp(async (t, tmp) => {
  project(tmp)
  writeTree(tmp, {
    'metro.config.js': 'module.exports = {}\n',
    'react-native.config.js': 'module.exports = {}\n',
    'babel.config.js': 'module.exports = {}\n',
    'aliases.json': {},
  })
  const metro = { entries: ['index.js'], metro: true, platforms: ['ios'] }
  await bundleCommand({ cwd: tmp, output: 'a.br', lockfile: 'a.lock.json', builds: [metro, { entries: ['cli.js'] }] })
  // The configs under `bundle`: they're the bundler's, not the source Metro bundles.
  t.assert.deepStrictEqual(readBundle(join(tmp, 'a.br')).reason, {
    'bundle': ['b.js', 'cli.js', 'metro.config.js', 'react-native.config.js'],
    'bundle:metro': ['a.ios.js', 'index.js'],
  })
  const lock = Lockfile.parse(readFileSync(join(tmp, 'a.lock.json'), 'utf8'))
  t.assert.ok(Object.hasOwn(lock.modules.get('.').files, 'metro.config.js'), 'the lockfile attests a config too')
  // The Babel config with --babel-aliases (or --babel); a Node build alone carries none of them.
  await bundleCommand({ cwd: tmp, output: 'b.br', builds: [{ ...metro, babelAliases: 'aliases.json' }, { entries: ['cli.js'] }] })
  t.assert.ok(readBundle(join(tmp, 'b.br')).reason.bundle.includes('babel.config.js'))
  await bundleCommand({ cwd: tmp, output: 'c.br', builds: [{ entries: ['cli.js'] }] })
  t.assert.deepStrictEqual([...readBundle(join(tmp, 'c.br')).sources.keys()].toSorted(), ['b.js', 'cli.js'])
}))

test('bundleCommand adds the config\'s extra once, beside each build\'s own consumer', withTmp(async (t, tmp) => {
  project(tmp)
  writeTree(tmp, { 'tool.js': 'module.exports = 2\n', 'stasis.config.json': { extra: ['tool.js'] } })
  await bundleCommand({ cwd: tmp, output: 'metro.br', metro: true, platforms: ['ios'], entries: ['index.js'] })
  // A --metro build's files stay bundle:metro's alone.
  t.assert.deepStrictEqual(readBundle(join(tmp, 'metro.br')).reason, { 'bundle:metro': ['a.ios.js', 'index.js'], 'extra': ['stasis.config.json', 'tool.js'] })
  await bundleCommand({ cwd: tmp, output: 'both.br', builds: [{ entries: ['index.js'], metro: true, platforms: ['ios'] }, { entries: ['cli.js'] }] })
  t.assert.deepStrictEqual(readBundle(join(tmp, 'both.br')).reason, { 'bundle': ['b.js', 'cli.js'], 'bundle:metro': ['a.ios.js', 'index.js'], 'extra': ['stasis.config.json', 'tool.js'] })
}))

test('bundleCommand keeps the repo its builds detect where it adds the config\'s extra to them', withTmp(async (t, tmp) => {
  project(tmp)
  const commit = 'a'.repeat(40)
  writeTree(tmp, {
    'tool.js': 'module.exports = 2\n',
    'stasis.config.json': { extra: ['tool.js'] },
    '.git/config': '[remote "origin"]\n\turl = git@github.com:o/app.git\n',
    '.git/HEAD': `${commit}\n`,
  })
  const repo = { github: 'o/app', directory: '', commit }
  const cases = [
    ['one entry', { entries: ['cli.js'] }],
    ['one build', { builds: [{ entries: ['cli.js'] }] }],
    ['two builds', { builds: [{ entries: ['index.js'], metro: true, platforms: ['ios'] }, { entries: ['cli.js'] }] }],
  ]
  for (const [label, options] of cases) {
    // eslint-disable-next-line no-await-in-loop -- one build at a time, over the same tree
    await bundleCommand({ cwd: tmp, output: 'out.br', ...options })
    const bundle = readBundle(join(tmp, 'out.br'))
    t.assert.deepStrictEqual(bundle.reason.extra, ['stasis.config.json', 'tool.js'], `${label}: extra added`)
    t.assert.deepStrictEqual({ ...bundle.repo }, repo, `${label}: repo kept`)
  }
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
  t.assert.deepStrictEqual(readBundle(join(tmp, 'a.br')).reason.extra, ['logo.png', 'stasis.config.json'])
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

test('Config takes stasis bundle\'s entries and define, and nothing from them', (t) => {
  const config = new Config({ env: {}, lock: 'add', bundle: 'add' })
  config.loadConfig(JSON.stringify({ entries: { 'index.js': { metro: true } }, define: ['__DEV__=false'], scope: 'full' }))
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

test('CLI: stasis bundle alone bundles what a glob pattern in stasis.config.json\'s entries matches, as naming each would', withTmp(async (t, tmp) => {
  apps(tmp, { entries: { 'apps/*/src/index.js': { jsx: true } } })
  const r = await runCli(['bundle'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  const bundle = readBundle(join(tmp, 'stasis.code.br'))
  t.assert.deepStrictEqual([...bundle.entries], ['apps/a/src/index.js', 'apps/b/src/index.js'])
  t.assert.deepStrictEqual([...bundle.sources.keys()].toSorted(), ['apps/a/src/index.js', 'apps/b/src/index.js', 'apps/b/src/own.js', 'lib/shared.js'])
  const named = await runCli(['bundle', '--output=named.br', 'apps/a/src/index.js', 'apps/b/src/index.js'], tmp)
  t.assert.equal(named.status, 0, named.stderr)
  t.assert.equal(readBundle(join(tmp, 'named.br')).serialize(), bundle.serialize())
  // One of them, with its options there.
  const one = await runCli(['bundle', '--output=one.br', 'apps/b/src/index.js'], tmp)
  t.assert.equal(one.status, 0, one.stderr)
  t.assert.deepStrictEqual([...readBundle(join(tmp, 'one.br')).sources.keys()].toSorted(), ['apps/b/src/index.js', 'apps/b/src/own.js'])
  // A pattern matching nothing is a missing entry.
  apps(tmp, { entries: { 'nope/*/index.js': {} } })
  const none = await runCli(['bundle'], tmp)
  t.assert.notEqual(none.status, 0)
  t.assert.match(none.stderr, /entry not found: .*nope\/\*\/index\.js/u)
}))

test('CLI: stasis bundle --lockfile-only writes the lockfile of the entries stasis.config.json names alone', withTmp(async (t, tmp) => {
  project(tmp, { 'index.js': { metro: true, platforms: ['ios', 'android'] }, 'cli.js': { metro: false } })
  const r = await runCli(['bundle', '--lockfile=only.lock.json', '--lockfile-only'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')), 'no bundle written')
  // The one a build writing the bundle too writes beside it.
  const beside = await runCli(['bundle', '--lockfile=beside.lock.json'], tmp)
  t.assert.equal(beside.status, 0, beside.stderr)
  t.assert.equal(readFileSync(join(tmp, 'only.lock.json'), 'utf8'), readFileSync(join(tmp, 'beside.lock.json'), 'utf8'))
  t.assert.deepStrictEqual([...Lockfile.parse(readFileSync(join(tmp, 'only.lock.json'), 'utf8')).entries].toSorted(), ['cli.js', 'index.js'])
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

test('CLI: stasis bundle builds an entry stasis.config.json sets metro for, or --metro, with JSX, Flow and Metro\'s release defines', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'app', version: '1.0.0' },
    'index.js': "// @flow\nconst f = (x: number): number => x\nif (__DEV__) require('./dev.js')\nif (process.env.NODE_ENV !== 'production') require('./notProd.js')\nrequire('./b.js')\nmodule.exports = <View>{f(1)}</View>\n",
    'dev.js': 'module.exports = 1\n',
    'notProd.js': 'module.exports = 1\n',
    'b.js': 'module.exports = 1\n',
    'stasis.config.json': { entries: { 'index.js': { metro: true, platforms: ['ios'] } } },
  })
  const files = (bundle) => [...readBundle(join(tmp, bundle)).sources.keys()].toSorted()
  const configured = await runCli(['bundle', '--output=configured.br'], tmp)
  t.assert.equal(configured.status, 0, configured.stderr)
  t.assert.deepStrictEqual(files('configured.br'), ['b.js', 'index.js'])
  // The entry's define takes the place of the default for its name alone.
  writeTree(tmp, { 'stasis.config.json': { entries: { 'index.js': { metro: true, platforms: ['ios'], define: '__DEV__=true' } } } })
  const dev = await runCli(['bundle', '--output=dev.br'], tmp)
  t.assert.equal(dev.status, 0, dev.stderr)
  t.assert.deepStrictEqual(files('dev.br'), ['b.js', 'dev.js', 'index.js'])
  // And as flags.
  writeTree(tmp, { 'stasis.config.json': {} })
  const flags = await runCli(['bundle', '--metro', '--platforms=ios', '--output=flags.br', 'index.js'], tmp)
  t.assert.equal(flags.status, 0, flags.stderr)
  t.assert.deepStrictEqual(files('flags.br'), ['b.js', 'index.js'])
}))

// A JS project with a Foundry one at its root: src/A.sol imports dep/D.sol by remappings.txt.
const mixed = (dir, config) => writeTree(dir, {
  'package.json': { name: 'app', version: '1.0.0' },
  'src/a.js': "require('./b.js')\n",
  'src/b.js': '',
  'foundry.toml': '[profile.default]\nlibs = ["dependencies"]\n\n[dependencies]\n',
  'remappings.txt': 'dep/=lib/dep/\n',
  'lib/dep/D.sol': 'pragma solidity ^0.8.0;\ncontract D {}\n',
  'src/A.sol': 'pragma solidity ^0.8.0;\nimport "dep/D.sol";\ncontract A {}\n',
  ...(config === undefined ? {} : { 'stasis.config.json': config }),
})

test('bundlePlan builds JS and Solidity entries apart, a build of each language, their flags valid for each', withTmp((t, tmp) => {
  mixed(tmp)
  const plan = bundlePlan({ cwd: tmp, entries: ['src/a.js', 'src/A.sol', 'src'], values: { output: 'x.br' } })
  t.assert.equal(plan.entries, undefined)
  t.assert.equal(plan.output, 'x.br')
  t.assert.deepStrictEqual(plan.builds.map((build) => build.entries), [['src/a.js'], ['src/A.sol', 'src']], 'a directory entry is Solidity')
  t.assert.deepStrictEqual(bundlePlan({ cwd: tmp, entries: ['src/a.js', 'src/A.sol'], values: { deptree: true } }).deptree, true)
  // A flag of one language alone, or a lockfile, which no Solidity bundle has: refused.
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['src/a.js', 'src/A.sol'], values: { conditions: 'x' } }), { message: "--conditions is only valid for JS bundles, and src/A.sol is not of one: give the JS and .sol entries' options apart, in stasis.config.json's entries" })
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['src/a.js', 'src/A.sol'], values: { lockfile: 'l.json' } }), { message: '--lockfile is only valid for JS bundles' })
  // Other languages together still not.
  writeTree(tmp, { 'x.php': '<?php\n' })
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['src/a.js', 'x.php'], values: {} }), /^Error: bundle entries must all be \.sol, .* or be \.js\/.* and \.sol together$/u)
  // stasis.config.json's entries of both, with the same options: one build of each all the same.
  mixed(tmp, { entries: { 'src/a.js': {}, 'src/A.sol': {} } })
  t.assert.deepStrictEqual(bundlePlan({ cwd: tmp, entries: ['src/a.js', 'src/A.sol'], values: {}, config: readConfigEntries(tmp) }).builds.map((build) => build.entries), [['src/a.js'], ['src/A.sol']])
}))

test('CLI: stasis bundle bundles JS and Solidity entries together, each as its own bundle would, given or named in stasis.config.json', withTmp(async (t, tmp) => {
  mixed(tmp)
  const r = await runCli(['bundle', '--output=both.br', 'src/a.js', 'src/A.sol'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  const both = readBundle(join(tmp, 'both.br'))
  t.assert.deepStrictEqual([...both.entries].toSorted(), ['src/A.sol', 'src/a.js'])
  t.assert.deepStrictEqual([...both.sources.keys()].toSorted(), ['lib/dep/D.sol', 'src/A.sol', 'src/a.js', 'src/b.js'], 'D.sol by the remapping')
  // Each language's files as its own bundle has them.
  for (const [entry, out] of [['src/a.js', 'js.br'], ['src/A.sol', 'sol.br']]) {
    // eslint-disable-next-line no-await-in-loop -- one bundle at a time
    t.assert.equal((await runCli(['bundle', `--output=${out}`, entry], tmp)).status, 0)
    for (const [path, content] of readBundle(join(tmp, out)).sources) t.assert.equal(both.sources.get(path), content, path)
  }
  // stasis.config.json's entries, bare: the same bundle.
  mixed(tmp, { entries: { 'src/a.js': {}, 'src/A.sol': {} } })
  const bare = await runCli(['bundle', '--output=bare.br'], tmp)
  t.assert.equal(bare.status, 0, bare.stderr)
  t.assert.deepStrictEqual([...readBundle(join(tmp, 'bare.br')).sources.keys()].toSorted(), [...both.sources.keys()].toSorted())
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

test("readConfigEntries gives every JS entry the config's own define, which no entry's own may be beside", withTmp((t, tmp) => {
  const define = ['__DEV__=false', 'process.env.NODE_ENV="production"']
  mixed(tmp, { define, entries: { 'src/a.js': { jsx: true }, 'src/b.js': {}, 'src/A.sol': {} } })
  t.assert.deepStrictEqual([...readConfigEntries(tmp)].map(([key, { values }]) => [key, values]), [
    ['src/a.js', { jsx: true, define }],
    ['src/b.js', { define }],
    ['src/A.sol', {}],
  ])
  t.assert.deepStrictEqual(readConfigDefine(tmp), define)
  // Without entries too: it is every entry's, named there or not.
  writeTree(tmp, { 'stasis.config.json': { define: '__DEV__=false' } })
  t.assert.equal(readConfigEntries(tmp), null)
  t.assert.deepStrictEqual(readConfigDefine(tmp), ['__DEV__=false'])
  t.assert.equal(readConfigDefine(join(tmp, 'src')), undefined)
  const refused = (config, message) => {
    writeTree(tmp, { 'stasis.config.json': config })
    t.assert.throws(() => readConfigEntries(tmp), { message })
    t.assert.throws(() => readConfigDefine(tmp), { message })
  }
  // An entry's own, whichever entry, and whatever it gives.
  refused({ define: '__DEV__=false', entries: { 'src/a.js': {}, 'src/b.js': { define: [] } } },
    'stasis.config.json: define can\'t be combined with entries "src/b.js"\'s define: give every entry\'s in define, or each entry\'s in its own options')
  refused({ define: { __DEV__: false } }, 'stasis.config.json: define must be a string or an array of strings')
  refused({ define: [] }, 'stasis.config.json: define: --define must give at least one KEY=VALUE (e.g. --define=__DEV__=false)')
  refused({ define: ['__DEV__=yes'] }, 'stasis.config.json: define: --define\'s value for __DEV__ must be JSON: a string, quoted (--define=__DEV__=\'"production"\'), a number, true, false or null, not "yes"')
}))

test("bundlePlan builds every JS entry with the config's own define, named in its entries or not, and refuses --define beside it", withTmp((t, tmp) => {
  mixed(tmp, { define: ['__DEV__=false'], entries: { 'src/a.js': { jsx: true }, 'src/b.js': {} } })
  const named = bundlePlan({ cwd: tmp, entries: ['src/a.js', 'src/b.js'], values: {}, config: readConfigEntries(tmp) })
  t.assert.deepStrictEqual(named.builds.map((b) => [b.entries, b.jsx, b.define]), [[['src/a.js'], true, { __DEV__: false }], [['src/b.js'], false, { __DEV__: false }]])
  const message = "--define can't be given, as stasis.config.json's define gives every entry's: set it there"
  t.assert.throws(() => bundlePlan({ cwd: tmp, entries: ['src/a.js'], values: { define: ['__DEV__=false'] }, config: readConfigEntries(tmp) }), { message })
  // Entries it names none of: of a config naming others, or none.
  const unnamed = bundlePlan({ cwd: tmp, entries: ['src/c.js'], values: { jsx: true }, config: readConfigEntries(tmp) })
  t.assert.deepStrictEqual([unnamed.entries, unnamed.jsx, unnamed.define], [['src/c.js'], true, { __DEV__: false }])
  writeTree(tmp, { 'stasis.config.json': { define: '__DEV__=false' } })
  // Only the JS ones: a .sol entry has no defines.
  const both = bundlePlan({ cwd: tmp, entries: ['src/a.js', 'src/A.sol'], values: {}, config: readConfigEntries(tmp) })
  t.assert.deepStrictEqual(both.builds.map((b) => [b.entries, b.define]), [[['src/a.js'], { __DEV__: false }], [['src/A.sol'], undefined]])
  t.assert.equal(bundlePlan({ cwd: tmp, entries: ['src/A.sol'], values: {}, config: null }).define, undefined)
  for (const entries of [['src/a.js'], ['src/A.sol']]) {
    t.assert.throws(() => bundlePlan({ cwd: tmp, entries, values: { define: ['__DEV__=false'] }, config: null }), { message }, entries[0])
  }
}))

test("CLI: stasis bundle builds every entry with stasis.config.json's own define, named in its entries or not", withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'app', version: '1.0.0' },
    'index.js': "if (__DEV__) require('./dev.js')\nif (process.env.NODE_ENV !== 'production') require('./notProd.js')\nrequire('./b.js')\n",
    'cli.js': "if (__DEV__) import('./dev.js')\n",
    'dev.js': 'module.exports = 1\n',
    'notProd.js': 'module.exports = 1\n',
    'b.js': 'module.exports = 1\n',
  })
  const define = ['__DEV__=false', 'process.env.NODE_ENV="production"']
  const bundled = async (config, args) => {
    writeTree(tmp, { 'stasis.config.json': config })
    const r = await runCli(['bundle', '--output=out.br', ...args], tmp)
    t.assert.equal(r.status, 0, r.stderr)
    return [...readBundle(join(tmp, 'out.br')).sources.keys()].toSorted()
  }
  t.assert.deepStrictEqual(await bundled({ define }, ['index.js', 'cli.js']), ['b.js', 'cli.js', 'index.js'])
  t.assert.deepStrictEqual(await bundled({ define, entries: { 'index.js': {}, 'cli.js': {} } }, []), ['b.js', 'cli.js', 'index.js'])
  // Under --metro, in the place of its default for the name it gives.
  writeTree(tmp, { 'stasis.config.json': { define: '__DEV__=true', entries: { 'index.js': { metro: true, platforms: ['ios'] } } } })
  const metro = await runCli(['bundle', '--output=metro.br'], tmp)
  t.assert.equal(metro.status, 0, metro.stderr)
  t.assert.deepStrictEqual([...readBundle(join(tmp, 'metro.br')).sources.keys()].toSorted(), ['b.js', 'dev.js', 'index.js'])
  const refused = async (config, args, message) => {
    writeTree(tmp, { 'stasis.config.json': config })
    const r = await runCli(['bundle', '--output=no.br', ...args], tmp)
    t.assert.equal(r.status, 1)
    t.assert.match(r.stderr, message)
    t.assert.equal(existsSync(join(tmp, 'no.br')), false)
  }
  await refused({ define }, ['--define=__DEV__=false', 'index.js'], /^Error: --define can't be given, as stasis\.config\.json's define gives every entry's: set it there$/mu)
  await refused({ define, entries: { 'index.js': {}, 'cli.js': { define: '__DEV__=true' } } }, ['index.js'], /^Error: stasis\.config\.json: define can't be combined with entries "cli\.js"'s define/mu)
}))
