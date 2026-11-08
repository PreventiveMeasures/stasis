import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
import { buildVfsBundle } from '../stasis/src/vfs-bundle.js'
import { json, lockfile, vfsOf } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

// stasis.config.json's allowedPaths / disallowedPaths / allowedModules / disallowedModules, at its
// top level and in each of its `entries`: every rule checked on its own, none overriding another.

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')

const writeTree = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
}

const readBundle = (path) => parseBundleBytes(readFileSync(path))
const readLock = (dir, file = 'stasis.lock.json') => Lockfile.parse(readFileSync(join(dir, file), 'utf8'))
// The file URL of `rel` in `dir`, as a State takes it.
const urlOf = (dir, rel) => pathToFileURL(join(dir, rel)).href

const runCli = async (args, cwd) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))
  const child = spawn(process.execPath, [cli, ...args], { cwd, env })
  child.stdin.end()
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const [status] = await once(child, 'close')
  return { status, stderr }
}

// A project of two entries: a.js reaching the dependency `left` and src/util.js, b.js reaching
// `right` and test/fixture.js.
const project = (dir, config) => writeTree(dir, {
  'package.json': { name: 'app', version: '1.0.0' },
  'a.js': "require('left')\nrequire('./src/util.js')\n",
  'b.js': "require('right')\nrequire('./test/fixture.js')\n",
  'src/util.js': 'module.exports = 1\n',
  'test/fixture.js': 'module.exports = 2\n',
  'node_modules/left/package.json': { name: 'left', version: '1.0.0', main: 'index.js' },
  'node_modules/left/index.js': 'module.exports = "left"\n',
  'node_modules/right/package.json': { name: 'right', version: '2.0.0', main: 'index.js' },
  'node_modules/right/index.js': 'module.exports = "right"\n',
  ...(config === undefined ? {} : { 'stasis.config.json': config }),
})

// The message of the error `fn` throws, or null.
const messageOf = (fn) => {
  try {
    fn()
    return null
  } catch (error) {
    return error.message
  }
}

// Whether the rule `key` of `patterns` refuses the path `path` (of the dependency `name`, if any).
// Parsed outside messageOf: a refused pattern fails the test rather than count as a match.
const refuses = (key, patterns, path, name) => {
  const policy = parsePolicy('cfg', { [key]: patterns })
  return messageOf(() => policy.assertPath(path, name === undefined ? undefined : { dir: `node_modules/${name}`, name, version: '1.0.0' })) !== null
}

test('a path pattern matches the path or a directory above it, its wildcards dotfiles too', (t) => {
  const matches = (pattern, path) => refuses('disallowedPaths', [pattern], path)
  t.assert.ok(matches('src', 'src/a.js'))
  t.assert.ok(matches('src/', 'src/a/b.js'))
  t.assert.ok(matches('./src', 'src/a.js'))
  t.assert.ok(!matches('src', 'srcs/a.js'))
  t.assert.ok(matches('src/**', 'src'))
  t.assert.ok(matches('**/*.pem', '.secrets/key.pem'))
  t.assert.ok(matches('secrets/**', 'secrets/.key'))
  t.assert.ok(matches('**', '.env'))
  t.assert.ok(matches('*.js', 'a.js'))
  t.assert.ok(!matches('*.js', 'src/a.ts'))
  t.assert.ok(matches('a/**/b', 'a/b'))
  t.assert.ok(matches('a/**/b', 'a/x/y/b/c.js'))
  t.assert.ok(matches('{src,lib}/x', 'lib/x/y.js'))
  t.assert.ok(!matches('{src,lib}/x', 'test/x/y.js'))
  t.assert.ok(matches('x/?b.md', 'x/ab.md'))
  t.assert.ok(!matches('x/?b.md', 'x/aab.md'))
  t.assert.ok(matches('a?b', 'a*b'))
  t.assert.ok(matches('node_modules/.pnpm/**/left', 'node_modules/.pnpm/left@1.0.0/node_modules/left/index.js'))
  // A name may hold a line break, which `**` and a directory's paths take in too.
  for (const pattern of ['secrets', 'secrets/**', '**', '**/*.js', 'secrets/*']) t.assert.ok(matches(pattern, 'secrets/key\n.js'), pattern)
  t.assert.ok(matches('a/**/b', 'a/x\ny/b'))
  // `?` is one character of a name, never a `/`: what matches one that is no supported one.
  t.assert.ok(!matches('a?b', 'a/b'))
  t.assert.ok(matches('app/?group?/+page@1.js', 'app/(group)/+page@1.js'))
  // A name an object inherits is a name like any other.
  for (const pattern of ['constructor', '__proto__', '{toString,hasOwnProperty}']) t.assert.ok(matches(pattern, pattern.replace(/^\{(\w+),.*/u, '$1')), pattern)
  t.assert.ok(!matches('__proto__', 'other'))
  // `.` is the config's directory: everything; the root's own listing is `.` and `**`'s alone.
  t.assert.ok(matches('.', 'a/b.js'))
  t.assert.ok(matches('.', '.'))
  t.assert.ok(matches('**', '.'))
  t.assert.ok(!matches('*', '.'))
})

test('a module pattern matches a dependency by its name, or as a glob of names', (t) => {
  const matches = (pattern, name) => refuses('disallowedModules', [pattern], `node_modules/${name}/index.js`, name)
  t.assert.ok(matches('left-pad', 'left-pad'))
  t.assert.ok(!matches('lodash', 'lodash.get'))
  t.assert.ok(matches('lodash*', 'lodash.get'))
  t.assert.ok(matches('@babel/*', '@babel/core'))
  t.assert.ok(!matches('*', '@babel/core'))
  t.assert.ok(matches('**', '@babel/core'))
  // The project's own files are no dependency's.
  t.assert.ok(!refuses('disallowedModules', ['**'], 'src/a.js'))
  t.assert.ok(!refuses('allowedModules', [], 'src/a.js'))
  t.assert.ok(refuses('allowedModules', [], 'node_modules/x/index.js', 'x'))
})

test('parsePolicy refuses what is no list of patterns within the config\'s directory', (t) => {
  t.assert.equal(parsePolicy('cfg', { scope: 'full' }), null)
  const refused = (config, message) => t.assert.throws(() => parsePolicy('cfg', config), { message })
  refused({ allowedPaths: 'src' }, /^cfg: allowedPaths must be an array of non-empty strings$/u)
  refused({ disallowedModules: [''] }, /^cfg: disallowedModules must be an array of non-empty strings$/u)
  refused({ allowedPaths: ['../x'] }, /^cfg: allowedPaths: "\.\.\/x" must be a path or pattern within the directory of stasis\.config\.json$/u)
  refused({ disallowedPaths: ['/etc'] }, /must be a path or pattern within/u)
  refused({ disallowedPaths: ['{a,..}/x'] }, /must be a path or pattern within/u)
  refused({ allowedPaths: ['{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}{o,p}{q,r}'] }, /expands to more than 256 patterns/u)
})

test('parsePolicy supports simple patterns alone, refusing any other a glob may read otherwise', (t) => {
  const refused = (key, pattern) => t.assert.throws(() => parsePolicy('cfg', { [key]: [pattern] }), { message: `cfg: ${key}: ${JSON.stringify(pattern)} is not supported: a pattern is names of letters, digits and \`_.@+-\`, with \`*\`, \`?\`, \`**\` as a whole name and \`{a,b}\` lists (none nested); match any other character with \`?\`` }, pattern)
  const unsupported = [
    'src\\a.js', 'app/[id].tsx', 'x]y', 'a[[:digit:]]', // a class, an escape
    '@(a|b).js', '!(a)', '{@,x}(a)', '(group)/page.js', 'a$b', 'a b', 'a,b', // an extglob, and what one is made of
    'v{1..3}', '{a}', 'x${a,b}', '{{a,b}}', '{a,{b,c}}', 'a{b', 'a}b', '{a,b}}', // a range, a lone or nested brace
    'a**', '**b/c', 'src/a**/b', 'a/***/b', '{**,x}/y', // a `**` within a name
  ]
  for (const pattern of unsupported) refused('disallowedPaths', pattern)
  for (const pattern of ['@scope/[ab]*', 'left-{1..3}', '@(left|right)', 'evil pkg']) refused('allowedModules', pattern)
  for (const pattern of ['{1..3,4}', 'src/{a,b}/*.{js,ts}', '@scope/*', 'node_modules/.pnpm/left@1.0.0+x/**', 'ünï/**']) parsePolicy('cfg', { allowedPaths: [pattern] })
  // As Node's glob, an empty alternative is dropped.
  t.assert.ok(!refuses('allowedPaths', ['{src,}'], 'src/a.js'))
  t.assert.ok(refuses('allowedPaths', ['{src,}'], 'lib/a.js'))
  t.assert.throws(() => parsePolicy('cfg', { allowedPaths: ['{,}'] }), { message: 'cfg: allowedPaths: "{,}" expands to no pattern' })
})

test('a Policy names every offender of every rule at once', (t) => {
  const policy = parsePolicy('stasis.config.json', { allowedPaths: ['src', 'node_modules'], disallowedPaths: ['**/*.pem'], allowedModules: ['left'], disallowedModules: ['right'] })
  const contents = {
    paths: new Set(['src/a.js', 'lib/b.js', 'src/key.pem', 'node_modules/right/index.js']),
    packages: [{ dir: 'node_modules/right', name: 'right', version: '2.0.0' }],
  }
  t.assert.throws(() => policy.assert(contents), {
    message: 'stasis.config.json: allowedPaths does not allow lib/b.js; disallowedPaths refuses src/key.pem ("**/*.pem"); ' +
      'allowedModules does not allow right@2.0.0 at node_modules/right; disallowedModules refuses right@2.0.0 at node_modules/right ("right")',
  })
})

test('Config takes the four rules from stasis.config.json alone', (t) => {
  const config = new Config({ env: {}, lock: 'add' })
  t.assert.equal(config.policy, null)
  config.loadConfig(JSON.stringify({ disallowedModules: ['right'], allowedPaths: ['src'] }))
  t.assert.equal(config.policy.key, JSON.stringify({ allowedPaths: ['src'], disallowedModules: ['right'] }))
  t.assert.throws(() => new Config({ env: {}, lock: 'add' }).loadConfig(JSON.stringify({ allowedModules: 'left' })), /allowedModules must be an array/u)
  t.assert.throws(() => new Config({ env: {}, lock: 'add', allowedModules: ['left'] }), /Unknown Config options: allowedModules/u)
})

test('State refuses a path or dependency its config refuses as it records it, and at write', withTmp((t, tmp) => {
  project(tmp, { disallowedModules: ['right'], disallowedPaths: ['test'] })
  const url = (rel) => urlOf(tmp, rel)
  const state = new State(tmp, { lock: 'add', env: {}, claim: false })
  state.addFile(url('a.js'))
  state.addFile(url('node_modules/left/index.js'))
  t.assert.throws(() => state.addFile(url('node_modules/right/index.js')), { message: 'stasis.config.json: disallowedModules refuses right@2.0.0 at node_modules/right ("right")' })
  t.assert.throws(() => state.addFile(url('test/fixture.js')), { message: 'stasis.config.json: disallowedPaths refuses test/fixture.js ("test")' })
  t.assert.throws(() => state.addFsStat(url('test/fixture.js'), 'file'), /disallowedPaths refuses test\/fixture\.js/u)
  state.write()
  const lock = readLock(tmp)
  t.assert.deepStrictEqual([...lock.modules.keys()].toSorted(), ['.', 'node_modules/left'])
  // A run checks no path of the project's own in node_modules scope, which it doesn't record.
  const scoped = new State(tmp, { lock: 'ignore', bundle: 'add', scope: 'node_modules', env: {}, claim: false })
  scoped.addFile(url('test/fixture.js'))
}))

test('State refuses a lockfile or bundle it loads that records what its config refuses', withTmp((t, tmp) => {
  project(tmp)
  const url = (rel) => urlOf(tmp, rel)
  const writer = new State(tmp, { lock: 'add', bundle: 'add', env: {}, claim: false })
  writer.addFile(url('a.js'), { isEntry: true })
  writer.addFile(url('node_modules/right/index.js'))
  writer.write()
  writeTree(tmp, { 'stasis.config.json': { allowedModules: ['left'] } })
  const hint = /^stasis\.config\.json: allowedModules does not allow right@2\.0\.0 at node_modules\/right -- recorded in stasis\.(?:lock\.json|code\.br); rebuild it \(lock=replace \/ bundle=replace\)$/u
  for (const modes of [{ lock: 'frozen', bundle: 'ignore' }, { lock: 'frozen', bundle: 'load' }, { lock: 'add', bundle: 'add' }, { lock: 'ignore', bundle: 'frozen' }]) {
    t.assert.throws(() => new State(tmp, { ...modes, env: {}, claim: false }), { message: hint }, JSON.stringify(modes))
  }
  // A replace starts over, loading none.
  new State(tmp, { lock: 'replace', bundle: 'replace', env: {}, claim: false }).addFile(url('node_modules/left/index.js'))
}))

test('CLI: stasis run refuses to load a dependency its config refuses, and writes nothing', withTmp(async (t, tmp) => {
  project(tmp, { disallowedModules: ['right'] })
  const refused = await runCli(['run', '--lock=add', 'b.js'], tmp)
  t.assert.notEqual(refused.status, 0)
  t.assert.match(refused.stderr, /stasis\.config\.json: disallowedModules refuses right@2\.0\.0 at node_modules\/right \("right"\)/u)
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')))
  const ran = await runCli(['run', '--lock=add', 'a.js'], tmp)
  t.assert.equal(ran.status, 0, ran.stderr)
  t.assert.deepStrictEqual([...readLock(tmp).modules.keys()].toSorted(), ['.', 'node_modules/left'])
}))

test('CLI: stasis add refuses a file its config refuses, before anything is written', withTmp((t, tmp) => {
  project(tmp, { disallowedPaths: ['test'] })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src', 'test'] }), { message: 'stasis.config.json: disallowedPaths refuses test/fixture.js ("test")' })
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')))
  addCommand({ cwd: tmp, entries: ['src'] })
  // What the bundle there carries already is held to it too.
  writeTree(tmp, { 'stasis.config.json': { allowedPaths: ['test'] } })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['test'] }), { message: /^stasis\.config\.json: allowedPaths does not allow src\/util\.js -- recorded in stasis\.code\.br already$/u })
}))

test('bundleCommand holds the bundle to the config\'s rules, whatever builds it', withTmp(async (t, tmp) => {
  project(tmp, { disallowedModules: ['right'], disallowedPaths: ['test'] })
  // A State-built bundle names every offender at once, as one built without a State does.
  const message = 'stasis.config.json: disallowedPaths refuses test/fixture.js ("test"); disallowedModules refuses right@2.0.0 at node_modules/right ("right")'
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['b.js'] }), { message })
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['b.js'], mainFields: ['main'] }), { message })
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')))
  await bundleCommand({ cwd: tmp, entries: ['a.js'] })
  t.assert.deepStrictEqual([...readBundle(join(tmp, 'stasis.code.br')).sources.keys()].toSorted(), ['a.js', 'node_modules/left/index.js', 'src/util.js'])
}))

test('bundleCommand --add holds what the bundle on disk carries to the config\'s rules too', withTmp(async (t, tmp) => {
  project(tmp)
  await bundleCommand({ cwd: tmp, entries: ['b.js'] })
  writeTree(tmp, { 'stasis.config.json': { disallowedModules: ['right'] } })
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'], add: true }), { message: /^stasis\.config\.json: disallowedModules refuses right@2\.0\.0 at node_modules\/right \("right"\) -- recorded in stasis\.code\.br already$/u })
}))

test('bundleCommand --add --lockfile holds what the lockfile on disk records to the config\'s rules too, beyond its bundle', withTmp(async (t, tmp) => {
  project(tmp)
  await bundleCommand({ cwd: tmp, entries: ['a.js'], lockfile: 'stasis.lock.json' })
  // A lockfile recording more than the bundle beside it: b.js's graph too.
  await bundleCommand({ cwd: tmp, entries: ['b.js'], output: 'b.br', lockfile: 'b.lock.json' })
  writeFileSync(join(tmp, 'stasis.lock.json'), readLock(tmp).merge(readLock(tmp, 'b.lock.json')).serialize())
  const before = readFileSync(join(tmp, 'stasis.lock.json'), 'utf8')
  writeTree(tmp, { 'stasis.config.json': { disallowedModules: ['right'] } })
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'], add: true, lockfile: 'stasis.lock.json' }), {
    message: /^stasis\.config\.json: disallowedModules refuses right@2\.0\.0 at node_modules\/right \("right"\) -- recorded in stasis\.lock\.json already$/u,
  })
  t.assert.equal(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'), before)
}))

test('readConfigEntries reads an entry\'s rules apart from its flags', withTmp((t, tmp) => {
  project(tmp, { entries: { 'a.js': { jsx: true, allowedModules: ['left'] }, 'b.js': {} } })
  const entries = readConfigEntries(tmp)
  t.assert.deepStrictEqual(entries.get('a.js').values, { jsx: true })
  t.assert.equal(entries.get('a.js').policy.key, JSON.stringify({ allowedModules: ['left'] }))
  t.assert.equal(entries.get('b.js').policy, undefined)
  writeTree(tmp, { 'stasis.config.json': { entries: { 'a.js': { allowedModules: 'left' } } } })
  t.assert.throws(() => readConfigEntries(tmp), { message: 'stasis.config.json: entries "a.js": allowedModules must be an array of non-empty strings' })
}))

test('bundlePlan builds entries held to different rules apart, the same ones together', withTmp((t, tmp) => {
  project(tmp, { entries: { 'a.js': { allowedModules: ['left'] }, 'b.js': { allowedModules: ['left'] }, 'src/util.js': {} } })
  const plan = (entries) => bundlePlan({ cwd: tmp, entries, values: {}, config: readConfigEntries(tmp) })
  const { builds } = plan(['a.js', 'b.js', 'src/util.js'])
  t.assert.deepStrictEqual(builds.map((build) => build.entries), [['a.js', 'b.js'], ['src/util.js']])
  t.assert.equal(builds[0].policy.label, 'stasis.config.json: entries "a.js", "b.js"')
  t.assert.equal(builds[1].policy, undefined)
}))

test('bundleCommand holds each entry\'s build to its own rules and the config\'s, every rule on its own', withTmp(async (t, tmp) => {
  const build = async (config) => {
    project(tmp, config)
    try {
      await bundleCommand({ cwd: tmp, builds: bundlePlan({ cwd: tmp, entries: ['a.js', 'b.js'], values: {}, config: readConfigEntries(tmp) }).builds })
      return null
    } catch (error) {
      return error.message
    }
  }
  // An entry's rule is its own build's: b.js reaches `right`, which a.js's alone refuses.
  t.assert.equal(await build({ entries: { 'a.js': { disallowedModules: ['right'] }, 'b.js': {} } }), null)
  t.assert.equal(await build({ entries: { 'a.js': {}, 'b.js': { disallowedModules: ['right'] } } }),
    'stasis.config.json: entries "b.js": disallowedModules refuses right@2.0.0 at node_modules/right ("right")')
  // The config's rule is every entry's: an entry allowing it doesn't take it back.
  t.assert.equal(await build({ disallowedModules: ['right'], entries: { 'a.js': {}, 'b.js': { allowedModules: ['right'] } } }),
    'stasis.config.json: disallowedModules refuses right@2.0.0 at node_modules/right ("right")')
  t.assert.equal(await build({ disallowedPaths: ['test'], entries: { 'a.js': {}, 'b.js': { allowedPaths: ['.'] } } }),
    'stasis.config.json: disallowedPaths refuses test/fixture.js ("test")')
  // An allowlist of each is met on its own: the config's by the union, an entry's by its build.
  t.assert.equal(await build({ allowedModules: ['left', 'right'], entries: { 'a.js': { allowedModules: ['left'] }, 'b.js': { allowedModules: ['right'] } } }), null)
  t.assert.equal(await build({ allowedModules: ['left'], entries: { 'a.js': { allowedModules: ['left'] }, 'b.js': { allowedModules: ['right'] } } }),
    'stasis.config.json: allowedModules does not allow right@2.0.0 at node_modules/right')
  t.assert.equal(await build({ allowedModules: ['left', 'right'], entries: { 'a.js': { allowedModules: ['right'] }, 'b.js': {} } }),
    'stasis.config.json: entries "a.js": allowedModules does not allow left@1.0.0 at node_modules/left')
  // An entry's rules are checked against its own graph, never the `extra` the bundle adds once.
  t.assert.equal(await build({ extra: ['test'], entries: { 'a.js': { disallowedPaths: ['test'] }, 'b.js': {} } }), null)
  t.assert.equal(await build({ extra: ['test'], disallowedPaths: ['test'], entries: { 'a.js': {}, 'b.js': {} } }),
    'stasis.config.json: disallowedPaths refuses test/fixture.js ("test")')
}))

test('CLI: stasis bundle alone holds the entries stasis.config.json names to their rules', withTmp(async (t, tmp) => {
  project(tmp, { entries: { 'a.js': {}, 'b.js': { disallowedPaths: ['test/*.js'] } } })
  const r = await runCli(['bundle'], tmp)
  t.assert.notEqual(r.status, 0)
  t.assert.match(r.stderr, /stasis\.config\.json: entries "b\.js": disallowedPaths refuses test\/fixture\.js \("test\/\*\.js"\)/u)
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')))
}))

test('buildVfsBundle (stasis github-bundle) holds the bundle to the config\'s rules and each entry\'s', async (t) => {
  const projectOf = (config) => vfsOf({
    'package.json': json({ name: 'p', version: '1.0.0' }),
    'pnpm-lock.yaml': lockfile('.'),
    'a.js': "require('./src/util.js')\n",
    'b.js': "require('./test/fixture.js')\n",
    'src/util.js': '',
    'test/fixture.js': '',
    'stasis.config.json': json(config),
  })
  await t.assert.rejects(buildVfsBundle({ vfs: projectOf({ disallowedPaths: ['test'] }), entries: ['b.js'] }), {
    message: 'buildVfsBundle: stasis.config.json: disallowedPaths refuses test/fixture.js ("test")',
  })
  await t.assert.rejects(buildVfsBundle({ vfs: projectOf({ entries: { 'a.js': {}, 'b.js': { allowedPaths: ['b.js', 'src'] } } }) }), {
    message: 'buildVfsBundle: stasis.config.json: entries "b.js": allowedPaths does not allow test/fixture.js',
  })
  const built = await buildVfsBundle({ vfs: projectOf({ allowedPaths: ['*.js', 'src', 'test'], entries: { 'a.js': { allowedPaths: ['a.js', 'src'] }, 'b.js': { disallowedPaths: ['src'] } } }) })
  t.assert.deepStrictEqual([...built.bundle.sources.keys()].toSorted(), ['a.js', 'b.js', 'src/util.js', 'test/fixture.js'])
})

test('a module pattern is the shape of a name: one segment, or a scope\'s two', (t) => {
  for (const pattern of ['left-pad', '@babel/core', '@babel/*', '@scope/**', '**', 'lodash.*', '{left,right}']) parsePolicy('cfg', { disallowedModules: [pattern] })
  for (const pattern of ['node_modules/evil', './evil', 'a/b/c', '{left,node_modules/evil}', '@scope/', '..']) {
    t.assert.throws(() => parsePolicy('cfg', { disallowedModules: [pattern] }), { message: `cfg: disallowedModules: ${JSON.stringify(pattern)} is no package name or pattern of names (such as "left-pad", "@babel/*")` }, pattern)
  }
})

test('a dependency is refused by either name it goes by, and allowed by both', (t) => {
  // Its package.json names it `left`; installed at node_modules/evil (a package naming itself otherwise, or an alias).
  const contents = { paths: [], packages: [{ dir: 'node_modules/evil', name: 'left', version: '1.0.0' }] }
  const refusal = (rules) => messageOf(() => parsePolicy('cfg', rules).assert(contents))
  t.assert.equal(refusal({ disallowedModules: ['evil'] }), 'cfg: disallowedModules refuses left@1.0.0 at node_modules/evil (installed as evil) ("evil")')
  t.assert.equal(refusal({ disallowedModules: ['left'] }), 'cfg: disallowedModules refuses left@1.0.0 at node_modules/evil (installed as evil) ("left")')
  t.assert.equal(refusal({ allowedModules: ['left'] }), 'cfg: allowedModules does not allow left@1.0.0 at node_modules/evil (installed as evil)')
  t.assert.equal(refusal({ allowedModules: ['evil'] }), 'cfg: allowedModules does not allow left@1.0.0 at node_modules/evil (installed as evil)')
  t.assert.equal(refusal({ allowedModules: ['left', 'evil'] }), null)
  // pnpm's layout installs it under its name in .pnpm, which is the directory taken.
  const pnpm = { paths: [], packages: [{ dir: 'node_modules/.pnpm/@scope+evil@1.0.0/node_modules/@scope/evil', name: '@scope/evil', version: '1.0.0' }] }
  t.assert.doesNotThrow(() => parsePolicy('cfg', { allowedModules: ['@scope/*'] }).assert(pnpm))
})

// A project of a package installed as `evil` whose package.json names it `left`.
const renamed = (dir, config) => writeTree(dir, {
  'package.json': { name: 'app', version: '1.0.0' },
  'a.js': "require('evil')\n",
  'node_modules/evil/package.json': { name: 'left', version: '1.0.0', main: 'index.js' },
  'node_modules/evil/index.js': 'module.exports = 1\n',
  'stasis.config.json': config,
})

test('bundleCommand and stasis run hold a dependency to the rules by the name it is installed under too', withTmp(async (t, tmp) => {
  renamed(tmp, { disallowedModules: ['evil'] })
  const message = 'stasis.config.json: disallowedModules refuses left@1.0.0 at node_modules/evil (installed as evil) ("evil")'
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'] }), { message })
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'], mainFields: ['main'] }), { message })
  const ran = await runCli(['run', '--lock=add', 'a.js'], tmp)
  t.assert.notEqual(ran.status, 0)
  t.assert.ok(ran.stderr.includes(message), ran.stderr)
  t.assert.ok(!existsSync(join(tmp, 'stasis.lock.json')))
  renamed(tmp, { allowedModules: ['left'] })
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'] }), { message: 'stasis.config.json: allowedModules does not allow left@1.0.0 at node_modules/evil (installed as evil)' })
  renamed(tmp, { allowedModules: ['left', 'evil'] })
  await bundleCommand({ cwd: tmp, entries: ['a.js'] })
}))

// A project whose src/link.js links to secrets/key.js, src/dep.js to node_modules/evil's index.js, and
// src/nice.js to node_modules/nice's, whose package.json names it `evil`; `configure` rewrites its config.
const configure = (dir, config) => writeTree(dir, { 'stasis.config.json': config })
const linked = (dir, config) => {
  writeTree(dir, {
    'package.json': { name: 'app', version: '1.0.0' },
    'a.js': '',
    'r.js': "require('node:fs').readFileSync(require('node:path').join(__dirname, 'src/link.js'))\n",
    'secrets/key.js': 'module.exports = "secret"\n',
    'node_modules/evil/package.json': { name: 'evil', version: '1.0.0' },
    'node_modules/evil/index.js': 'module.exports = 1\n',
    'node_modules/nice/package.json': { name: 'evil', version: '2.0.0' },
    'node_modules/nice/index.js': 'module.exports = 2\n',
    'stasis.config.json': config,
  })
  mkdirSync(join(dir, 'src'))
  symlinkSync('../secrets/key.js', join(dir, 'src/link.js'))
  symlinkSync('../node_modules/evil/index.js', join(dir, 'src/dep.js'))
  symlinkSync('../node_modules/nice/index.js', join(dir, 'src/nice.js'))
}

test('a file stasis add names or sweeps is held to the rules as the file it links to too', withTmp((t, tmp) => {
  linked(tmp, { disallowedPaths: ['secrets'] })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/link.js'] }), { message: 'stasis.config.json: disallowedPaths refuses src/link.js (a link to secrets/key.js) ("secrets")' })
  configure(tmp, { allowedPaths: ['src', 'a.js'] })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src'] }), { message: 'stasis.config.json: allowedPaths allows none of 3 paths: src/dep.js (a link to node_modules/evil/index.js), src/link.js (a link to secrets/key.js), src/nice.js (a link to node_modules/nice/index.js)' })
  configure(tmp, { disallowedModules: ['evil'] })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/dep.js'] }), { message: 'stasis.config.json: disallowedModules refuses evil@1.0.0 at node_modules/evil (linked from src/dep.js) ("evil")' })
  // A link into a package is held to the rules by both its names too: its package.json's, and its directory's.
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/nice.js'] }), { message: 'stasis.config.json: disallowedModules refuses evil@2.0.0 at node_modules/nice (installed as nice) (linked from src/nice.js) ("evil")' })
  configure(tmp, { allowedModules: ['nice'] })
  t.assert.throws(() => addCommand({ cwd: tmp, entries: ['src/nice.js'] }), { message: 'stasis.config.json: allowedModules does not allow evil@2.0.0 at node_modules/nice (installed as nice) (linked from src/nice.js)' })
  // So does a State, as it records the link.
  configure(tmp, { disallowedModules: ['evil'] })
  const state = new State(tmp, { lock: 'add', env: {}, claim: false })
  t.assert.throws(() => state.addFile(urlOf(tmp, 'src/nice.js'), { inferFormat: false }), { message: /disallowedModules refuses evil@2\.0\.0 at node_modules\/nice \(installed as nice\) \(linked from src\/nice\.js\)/u })
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')))
}))

test('a file extra names, or a run reads, is held to the rules as the file it links to too', withTmp(async (t, tmp) => {
  linked(tmp, { disallowedPaths: ['secrets'], extra: ['src/link.js'] })
  const message = 'stasis.config.json: disallowedPaths refuses src/link.js (a link to secrets/key.js) ("secrets")'
  // Without a State and with one (the extra a run adds, as a State-built bundle does).
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'], mainFields: ['main'] }), { message })
  await t.assert.rejects(bundleCommand({ cwd: tmp, entries: ['a.js'] }), { message })
  const extra = await runCli(['run', '--lock=add', 'a.js'], tmp)
  t.assert.notEqual(extra.status, 0)
  t.assert.ok(extra.stderr.includes(message), extra.stderr)
  configure(tmp, { disallowedPaths: ['secrets'] })
  const read = await runCli(['run', '--bundle=add', '--fs=sync', 'r.js'], tmp)
  t.assert.ok(!existsSync(join(tmp, 'stasis.code.br')), read.stderr)
  // A State records the link's path, refused as it is recorded.
  const state = new State(tmp, { lock: 'add', env: {}, claim: false })
  t.assert.throws(() => state.addFile(urlOf(tmp, 'src/link.js'), { inferFormat: false }), { message })
}))
