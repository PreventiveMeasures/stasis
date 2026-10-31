import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildGitHubBundle, createVfsHost, loadNodeModules } from '../stasis/src/vfs-bundle.js'
import { yarnclean } from '../stasis/src/vfs-bundle/yarnclean.js'
import { HIDE_MINIMATCH, fakeClient, json, lockfile, vfsOf } from './vfs-bundle-github.helper.js'

// vfs-bundle/yarnclean.js: the node_modules deptree lays out, cleaned by each .yarnclean in the
// directory installed and above it as `yarn autoclean` cleans Yarn's, whatever installs it.

const here = dirname(fileURLToPath(import.meta.url))

// What is left under `dir`, from it.
const left = (vfs, dir) => [...vfs.walk(dir)].slice(1).map(({ path }) => path.slice(dir.length + 1))
// A project holding .yarnclean files, cleaning its node_modules from `cwd`.
const cleaner = (yarncleans, cwd = '/') => yarnclean(createVfsHost(vfsOf(yarncleans)), cwd)

test('a .yarnclean cleans node_modules as Yarn autoclean does: by name or path from node_modules, a directory with all below it, `!` keeping', (t) => {
  const clean = cleaner({ '.yarnclean': '# docs and tests\n\ntest\n*.md\ndocs/\n!q/docs/keep.md\nq/lib/extra.js\n*.YML\n' })
  const vfs = vfsOf({
    'node_modules/q/index.js': '',
    'node_modules/q/README.md': '',
    'node_modules/q/test/t.js': '',
    'node_modules/q/test/fixtures/f.js': '',
    'node_modules/q/docs/keep.md': '',
    'node_modules/q/docs/other.txt': '',
    'node_modules/q/lib/extra.js': '',
    'node_modules/q/lib/main.js': '',
    'node_modules/q/.travis.yml': '',
    'node_modules/q/node_modules/r/README.MD': '',
    'node_modules/q/node_modules/r/index.js': '',
    'node_modules/.bin/q': { symlink: '../q/index.js' },
    'node_modules/.yarn-integrity': '',
  })
  clean(vfs, '/node_modules')
  t.assert.deepStrictEqual(left(vfs, '/node_modules'), [
    // The package manager's own, never matched.
    '.bin', '.bin/q', '.yarn-integrity',
    // docs/ holds the one kept: it stays with that alone.
    'q', 'q/docs', 'q/docs/keep.md', 'q/index.js', 'q/lib', 'q/lib/main.js',
    // A nested package's, matched from its own node_modules, case aside.
    'q/node_modules', 'q/node_modules/r', 'q/node_modules/r/index.js',
  ])
})

test("a .yarnclean matches a package's files from the node_modules holding it, as Yarn's hoisted layout has them, and never pnpm's store", (t) => {
  const clean = cleaner({ '.yarnclean': 'q/README.md\n.*\n' })
  const vfs = vfsOf({
    'node_modules/.pnpm/q@1.0.0/node_modules/q/README.md': '',
    'node_modules/.pnpm/q@1.0.0/node_modules/q/index.js': '',
    'node_modules/.pnpm/q@1.0.0/node_modules/q/.npmignore': '',
    'node_modules/.pnpm/node_modules/q': { symlink: '../q@1.0.0/node_modules/q' },
    'node_modules/.modules.yaml': '',
    'node_modules/q': { symlink: '.pnpm/q@1.0.0/node_modules/q' },
  })
  clean(vfs, '/node_modules')
  t.assert.deepStrictEqual(left(vfs, '/node_modules'), ['.modules.yaml', '.pnpm', '.pnpm/node_modules', '.pnpm/node_modules/q', '.pnpm/q@1.0.0', '.pnpm/q@1.0.0/node_modules', '.pnpm/q@1.0.0/node_modules/q', '.pnpm/q@1.0.0/node_modules/q/index.js', 'q'])
})

test('every .yarnclean in the directory installed and above it cleans, and one with no pattern is none', (t) => {
  const clean = cleaner({ '.yarnclean': '*.md\n', 'apps/.yarnclean': '# none\n', 'apps/p/.yarnclean': 'test\r\n', 'other/.yarnclean': '*.js\n' }, '/apps/p')
  const vfs = vfsOf({ 'node_modules/q/index.js': '', 'node_modules/q/README.md': '', 'node_modules/q/test/t.js': '' })
  clean(vfs, '/node_modules')
  t.assert.deepStrictEqual(left(vfs, '/node_modules'), ['q', 'q/index.js'], "the root's and the directory's, not a sibling's")
  t.assert.equal(cleaner({ '.yarnclean': '# nothing\n\n  \n!\n' }), null)
  t.assert.equal(cleaner({ 'other/.yarnclean': '*.js\n' }, '/apps'), null)
})

// A repo whose root depends on `q`, a directory pnpm installs as a package of its own, from
// node_modules/.pnpm, as it would from the registry; `.yarnclean` beside it where given.
const QDIR = 'node_modules/.pnpm/q@file+q/node_modules/q'
const qRepo = (extra = {}) => ({
  'package.json': json({ name: 'p', version: '1.0.0', devDependencies: { q: '1.0.0' }, pnpm: { overrides: { q: 'file:q' } } }),
  'pnpm-lock.yaml': lockfile('.').replace('importers:\n\n  .: {}\n', 'overrides:\n  q: file:q\n\nimporters:\n\n  .:\n    devDependencies:\n      q:\n        specifier: file:q\n        version: file:q\n\npackages:\n\n  q@file:q:\n    resolution: {directory: q, type: directory}\n\nsnapshots:\n\n  q@file:q: {}\n'),
  'src/a.js': "module.exports = require('q')\n",
  'q/package.json': json({ name: 'q', version: '1.0.0' }),
  'q/index.js': "module.exports = require('./lib')\n",
  'q/lib.js': 'module.exports = 1\n',
  'q/README.md': '# q\n',
  'q/test/t.js': '',
  ...extra,
})
const build = (files, options) => buildGitHubBundle({ github: 'ExodusOSS/example', sha: 'a'.repeat(40), packageManager: 'pnpm', client: fakeClient(files), entries: ['src/a.js'], ...options })

test('buildGitHubBundle and loadNodeModules take node_modules as a .yarnclean cleans it, whatever installs it', async (t) => {
  const { bundle } = await build(qRepo({ '.yarnclean': 'test\n*.md\n' }), { packageJSON: true })
  t.assert.deepStrictEqual([...bundle.sources.keys()].toSorted(), [`${QDIR}/index.js`, `${QDIR}/lib.js`, `${QDIR}/package.json`, 'package.json', 'src/a.js'])
  const vfs = vfsOf(qRepo({ '.yarnclean': '*.md\n' }))
  t.assert.deepStrictEqual(left((await loadNodeModules({ vfs, packageManager: 'pnpm' })).vfs, `/${QDIR}`), ['index.js', 'lib.js', 'package.json', 'test', 'test/t.js'])
  t.assert.deepStrictEqual(left((await loadNodeModules({ vfs: vfsOf(qRepo()), packageManager: 'pnpm' })).vfs, `/${QDIR}`), ['README.md', 'index.js', 'lib.js', 'package.json', 'test', 'test/t.js'], 'without one, as installed')
})

test('a file a .yarnclean cleans is missing to the build, as after `yarn autoclean`', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const { bundle } = await build(qRepo({ '.yarnclean': 'lib.js\n' }))
  t.assert.deepStrictEqual([...bundle.sources.keys()].toSorted(), [`${QDIR}/index.js`, 'src/a.js'])
  t.assert.match(warn.mock.calls.map((call) => call.arguments.join(' ')).join('\n'), new RegExp(`require \\./lib from ${RegExp.escape(QDIR)}/index\\.js \\(MODULE_NOT_FOUND\\)`, 'u'))
})

test('a .yarnclean needs the optional minimatch, refused before anything is installed without it', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'stasis-vfs-bundle-yarnclean-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  const script = `
    import fs from 'node:fs'
    const { buildGitHubBundle } = await import(${JSON.stringify(pathToFileURL(join(here, '..', 'stasis', 'src', 'vfs-bundle.js')).href)})
    const { fakeClient } = await import(${JSON.stringify(pathToFileURL(join(here, 'vfs-bundle-github.helper.js')).href)})
    const files = ${JSON.stringify(qRepo())}
    const sources = async (yarnclean) => {
      const { bundle } = await buildGitHubBundle({ github: 'ExodusOSS/example', sha: ${JSON.stringify('a'.repeat(40))}, packageManager: 'pnpm', client: fakeClient({ ...files, '.yarnclean': yarnclean }), entries: ['src/a.js'] })
      return [...bundle.sources.keys()]
    }
    const out = { refused: await sources('*.md\\n').then(() => null, (error) => error.message), comments: await sources('# none\\n') }
    fs.writeFileSync('out.json', JSON.stringify(out))
  `
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(HIDE_MINIMATCH)}`, '--input-type=module', '-e', script], { cwd: tmp })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const [status] = await once(child, 'close')
  t.assert.equal(status, 0, `stderr: ${Buffer.concat(stderr).toString('utf8')}`)
  const out = JSON.parse(await readFile(join(tmp, 'out.json'), 'utf8'))
  t.assert.equal(out.refused, "A .yarnclean, which cleans the node_modules a lockfile lays out, needs the optional 'minimatch' 10 dependency; install it (e.g. `npm i minimatch@10`)")
  t.assert.deepStrictEqual(out.comments.toSorted(), [`${QDIR}/index.js`, `${QDIR}/lib.js`, 'src/a.js'], 'no pattern, nothing to match')
})
