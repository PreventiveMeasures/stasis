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
import { createAliases } from '../stasis/src/babel.js'
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
  // The graph's files are carried, and the project's Babel config, as with --babel, with what it
  // imports: the aliases file here, which it requires.
  t.assert.deepStrictEqual([...aliased.sources.keys()].toSorted(), ['aliases.json', 'babel.config.js', 'index.js', 'lib/util.js', 'src/abc.js'])
  t.assert.equal(aliased.formats.get('aliases.json'), 'json')
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

test('buildBundle --babel-aliases leaves package.json imports to Metro\'s exact rule, unless an alias names them', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': { name: 'imp', version: '1.0.0', imports: { '#local/*': './src/*' } },
    'index.js': "import a from '#local/abc'\nexport default a\n",
    'src/abc.js': 'export default 1\n',
    'aliases.json': {},
  })
  const options = { cwd: tmp, entries: ['index.js'], metro: true, platforms: ['ios'], babelAliases: 'aliases.json' }
  // As module-resolver leaves them: the target must name the file itself.
  await t.assert.rejects(() => buildBundle(options), /unresolved import #local\/abc from index\.js/u)
  writeTree(tmp, { 'aliases.json': { '#local': './src' } })
  t.assert.deepStrictEqual(edgesOf(await buildBundle(options)), { '#local/abc': 'src/abc.js' })
}))
