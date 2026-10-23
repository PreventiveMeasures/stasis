import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { createAliases, createImportsAliases } from '../stasis/src/babel.js'
import { buildBundle } from '../stasis/src/cmd/bundle.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

const runCli = async (args, cwd) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))
  const child = spawn(process.execPath, [cli, ...args], { cwd, env })
  child.stdin.end()
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const [status] = await once(child, 'close')
  return { status, stderr }
}

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-aliases-'))
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

const ALIAS = { '#local': './src', '^@lib/(.+)': './lib/\\1' }

// A project importing through ALIAS, with it in aliases.json and a babel.config.js taking it, and the
// workspace's @babel/core and babel-plugin-module-resolver installed where --babel resolves them.
const aliasProject = (tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'aliased', version: '1.0.0' },
    'index.js': "import x from '#local/abc'\nimport y from '@lib/util'\nexport default [x, y]\n",
    'src/abc.js': 'export default 1\n',
    'lib/util.js': 'export default 2\n',
    'aliases.json': ALIAS,
    'babel.config.js': "module.exports = { plugins: [['module-resolver', { alias: require('./aliases.json') }]] }\n",
  })
  symlinkSync(join(here, '..', 'node_modules'), join(tmp, 'node_modules'), 'dir')
}

const edgesOf = (bundle) => Object.fromEntries([...bundle.imports.values()].map((m) => m.get('index.js')).find(Boolean))

test('createAliases maps as babel-plugin-module-resolver\'s resolvePath does', (t) => {
  const { resolvePath } = createRequire(import.meta.url)('babel-plugin-module-resolver')
  const cwd = '/p'
  const alias = {
    '#local': './src', '#up': '../shared', 'lodash': 'lodash-es', '^@(.+)/(.+)$': './lib/\\1/\\2', '^~(.*)': './src\\1',
    'idx': './src/index', 'empty': '', 'same': 'same', 'dot.name': './dot', 'x$': './exact',
  }
  const aliases = createAliases(alias, cwd)
  const specifiers = ['#local', '#local/abc', '#localx', '#up/y', 'lodash', 'lodash/fp', '@a/b', '@a/b/c', '~/x', '~', 'idx', 'empty', 'same', 'dot.name', 'dotxname', 'x', './rel', '../rel', 'none']
  // The plugin warns of a package it can't find, outside production.
  const { NODE_ENV } = process.env
  process.env.NODE_ENV = 'production'
  try {
    for (const file of ['/p/index.js', '/p/src/a/b.js', '/q/other.js']) {
      for (const specifier of specifiers) {
        const mapped = resolvePath(specifier, file, { cwd, alias })
        t.assert.equal(aliases(file, specifier), mapped && mapped !== specifier ? mapped : null, `${specifier} from ${file}`)
      }
    }
  } finally {
    if (NODE_ENV === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = NODE_ENV
  }
})

test('buildBundle --metro --babel-aliases resolves a JSON file\'s aliases as --babel resolves the config taking it', withTmp(async (t, tmp) => {
  aliasProject(tmp)
  const options = { cwd: tmp, entries: ['index.js'], metro: true, platforms: ['ios', 'android'] }
  await t.assert.rejects(() => buildBundle(options), /unresolved import #local\/abc from index\.js/u)
  const aliased = await buildBundle({ ...options, babelAliases: 'aliases.json' })
  t.assert.deepStrictEqual(edgesOf(aliased), { '#local/abc': 'src/abc.js', '@lib/util': 'lib/util.js' })
  // Not carried: only the graph's files are.
  t.assert.deepStrictEqual([...aliased.sources.keys()].toSorted(), ['index.js', 'lib/util.js', 'src/abc.js'])
  t.assert.equal(aliased.serialize(), (await buildBundle({ ...options, babel: true })).serialize())
}))

test('buildBundle --babel-aliases is only valid with --metro, not with --babel, and reads a JSON object in the project', withTmp(async (t, tmp) => {
  aliasProject(tmp)
  const options = { cwd: tmp, entries: ['index.js'], metro: true, platforms: ['ios'] }
  await t.assert.rejects(() => buildBundle({ cwd: tmp, entries: ['index.js'], mainFields: ['main'], babelAliases: 'aliases.json' }), /^Error: buildBundle: --babel-aliases is only valid with --metro$/u)
  await t.assert.rejects(() => buildBundle({ ...options, babel: true, babelAliases: 'aliases.json' }), /^Error: buildBundle: --babel-aliases can't be combined with --babel/u)
  await t.assert.rejects(() => buildBundle({ ...options, babelAliases: '../aliases.json' }), /--babel-aliases must name a file in the project: \.\.\/aliases\.json$/u)
  await t.assert.rejects(() => buildBundle({ ...options, babelAliases: 'none.json' }), /--babel-aliases file not found: none\.json$/u)
  const refused = async (content, message) => {
    writeFileSync(join(tmp, 'bad.json'), content)
    await t.assert.rejects(() => buildBundle({ ...options, babelAliases: 'bad.json' }), message)
  }
  await refused('{', /--babel-aliases file bad\.json is not valid JSON$/u)
  await refused('["./src"]', /--babel-aliases file bad\.json must be an object mapping each alias to a string$/u)
  await refused('{ "#local": ["./src"] }', /must be an object mapping each alias to a string$/u)
  await refused('{ "^(": "./src" }', /--babel-aliases file bad\.json: "\^\(" is not a valid regular expression$/u)
  // A link out of the project is refused as a path out of it is.
  const outside = mkdtempSync(join(tmpdir(), 'stasis-aliases-out-'))
  try {
    writeFileSync(join(outside, 'aliases.json'), JSON.stringify(ALIAS))
    symlinkSync(join(outside, 'aliases.json'), join(tmp, 'linked.json'))
    await t.assert.rejects(() => buildBundle({ ...options, babelAliases: 'linked.json' }), /Refusing to follow symlink escaping bundle root: linked\.json/u)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
}))

test('CLI: bundle --metro --babel-aliases, and an entry\'s babel-aliases with no flag given', withTmp(async (t, tmp) => {
  aliasProject(tmp)
  const flagged = await runCli(['bundle', '--metro', '--babel-aliases=aliases.json', '--platforms=ios', '--output=flag.br', 'index.js'], tmp)
  t.assert.equal(flagged.status, 0, flagged.stderr)
  const read = (file) => Bundle.parse(brotliDecompressSync(readFileSync(join(tmp, file))).toString('utf8'))
  t.assert.deepStrictEqual(edgesOf(read('flag.br')), { '#local/abc': 'src/abc.js', '@lib/util': 'lib/util.js' })
  writeTree(tmp, { 'stasis.config.json': { entries: { 'index.js': { metro: true, platforms: 'ios', 'babel-aliases': 'aliases.json' } } } })
  const configured = await runCli(['bundle', '--output=config.br'], tmp)
  t.assert.equal(configured.status, 0, configured.stderr)
  t.assert.equal(read('config.br').serialize(), read('flag.br').serialize())
}))

test('createImportsAliases selects a package.json imports key as Node does, mapping a string target as an alias', (t) => {
  const aliases = createImportsAliases({
    '#exact': './src/exact.js',
    '#local/*': './src/*',
    '#local/deep/*': './deep/*/index',
    '#both/*': './a/*/b/*',
    '#ext/*.js': './ext/*.js',
    '#dep': 'lodash-es',
    '#cond': { 'react-native': './rn.js', 'default': './web.js' },
    '#none/*': null,
    'local': './nope',
  }, '/p')
  const file = '/p/src/x/f.js'
  t.assert.equal(aliases(file, '#exact'), '../exact.js')
  t.assert.equal(aliases(file, '#exact/more'), null, 'a key without * matches only itself')
  t.assert.equal(aliases(file, '#local/abc'), '../abc')
  t.assert.equal(aliases(file, '#local/deep/x'), '../../deep/x', 'the longest prefix wins, and /index drops as the plugin drops it')
  t.assert.equal(aliases(file, '#both/m'), '../../a/m/b/m', 'every * in the target takes the match')
  t.assert.equal(aliases(file, '#ext/y.js'), '../../ext/y.js')
  t.assert.equal(aliases(file, '#dep'), 'lodash-es')
  t.assert.equal(aliases(file, '#cond'), null, 'conditions are left to Node')
  t.assert.equal(aliases(file, '#none/z'), null)
  t.assert.equal(aliases(file, 'local'), null, 'only # specifiers')
})

test('buildBundle --babel-aliases and --babel take the project\'s package.json imports as aliases, for its own files', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'imp', version: '1.0.0', imports: { '#local/*': './src/*', '#cond': { 'react-native': './src/rn.js', 'default': './src/abc.js' } } },
    'index.js': "import a from '#local/abc'\nimport c from '#cond'\nimport d from 'dep'\nexport default [a, c, d]\n",
    'src/abc.js': 'export default 1\n',
    'src/rn.js': 'export default 2\n',
    'other/abc.js': 'export default 3\n',
    'aliases.json': {},
    'babel.config.js': 'module.exports = {}\n',
    // A dependency's own `#local/*` stays its own.
    'node_modules/dep/package.json': { name: 'dep', version: '1.0.0', main: 'index.js', imports: { '#local/*': './lib/*.js' } },
    'node_modules/dep/index.js': "module.exports = require('#local/x')\n",
    'node_modules/dep/lib/x.js': "module.exports = 'x'\n",
  })
  symlinkSync(join(here, '..', 'node_modules', '@babel'), join(tmp, 'node_modules', '@babel'), 'dir')
  const options = { cwd: tmp, entries: ['index.js'], metro: true, platforms: ['ios'] }
  // Without either, Node's exact target finds no extensionless file.
  await t.assert.rejects(() => buildBundle(options), /unresolved import #local\/abc from index\.js/u)
  const edgesBy = (bundle) => Object.fromEntries([...bundle.imports.values()].flatMap((m) => [...m]).map(([parent, specs]) => [parent, Object.fromEntries(specs)]))
  const expected = {
    'index.js': { '#local/abc': 'src/abc.js', '#cond': 'src/rn.js', 'dep': 'node_modules/dep/index.js' },
    'node_modules/dep/index.js': { '#local/x': 'node_modules/dep/lib/x.js' },
  }
  t.assert.deepStrictEqual(edgesBy(await buildBundle({ ...options, babelAliases: 'aliases.json' })), expected)
  t.assert.deepStrictEqual(edgesBy(await buildBundle({ ...options, babel: true })), expected)
  // The aliases --babel-aliases sets come first.
  writeTree(tmp, { 'aliases.json': { '#local': './other' } })
  t.assert.equal(edgesBy(await buildBundle({ ...options, babelAliases: 'aliases.json' }))['index.js']['#local/abc'], 'other/abc.js')
}))
