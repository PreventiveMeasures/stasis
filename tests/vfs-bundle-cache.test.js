import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { Vfs, buildGitHubBundle, buildVfsBundle, loadNodeModules } from '../stasis/src/vfs-bundle.js'
import { HEAD, fakeClient, json, lockfile } from './vfs-bundle-github.helper.js'

// @exodus/stasis/vfs-bundle with a `cache` store of the caller's, which @preventive/deptree keeps each
// npm package's tarball and version document in, in place of setCacheDir's cache. Here the store
// answers both for the one package the lockfile locks, so nothing is fetched: the commit its document
// names (gitHead) is the one the bundle records.

const NAME = 'stasis-pinned-fixture'
const DIR = `node_modules/.pnpm/${NAME}@1.0.0/node_modules/${NAME}`
const COMMIT = 'c'.repeat(40)

const encoder = new TextEncoder()

// The package as published with `manifest` in its package.json: its tarball, as npm packs one, and
// the registry's document of it, with `about` (gitHead, repository) in it.
async function published(manifest = {}, about = {}) {
  const files = { 'package.json': json({ name: NAME, version: '1.0.0', main: 'index.js', ...manifest }), 'index.js': 'module.exports = 1\n' }
  const tarball = await compress(pack(Object.entries(files).map(([name, text]) => ({ name: `package/${name}`, data: encoder.encode(text), mode: 0o644 }))), 'gzip')
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  const document = { name: NAME, version: '1.0.0', dist: { tarball: `https://registry.npmjs.org/${NAME}/-/${NAME}-1.0.0.tgz`, integrity }, ...about }
  return { tarball, integrity, document }
}

// A store holding the package's tarball and document, which records what it is asked.
function storeOf({ tarball, document }) {
  const calls = []
  const kept = new Map([[`npm/tarballs ${NAME}@1.0.0`, tarball], [`npm/versions ${NAME}@1.0.0`, document]])
  return {
    calls,
    async read(type, key) {
      calls.push(['read', type, key])
      return kept.get(`${type} ${key}`)
    },
    async write(type, key) {
      calls.push(['write', type, key])
    },
  }
}

// A project depending on the package alone, as pnpm locks it.
const projectFiles = ({ integrity }) => ({
  'package.json': json({ name: 'p', version: '1.0.0', dependencies: { [NAME]: '1.0.0' } }),
  'pnpm-lock.yaml': [
    "lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '',
    'importers:', '', '  .:', '    dependencies:', `      ${NAME}:`, '        specifier: 1.0.0', '        version: 1.0.0', '',
    'packages:', '', `  ${NAME}@1.0.0:`, `    resolution: {integrity: ${integrity}}`, '',
    'snapshots:', '', `  ${NAME}@1.0.0: {}`, '',
  ].join('\n'),
  'src/a.js': `require('${NAME}')\n`,
})

const vfsOf = (files) => {
  const vfs = new Vfs()
  for (const [path, text] of Object.entries(files)) {
    vfs.mkdir(posix.dirname(`/${path}`), { recursive: true })
    vfs.writeFile(`/${path}`, text)
  }
  return vfs
}

const build = (options) => buildVfsBundle({ packageManager: 'pnpm', entries: ['src/a.js'], ...options })
const asked = (store) => store.calls.map((call) => call.join(' ')).toSorted()

test('buildVfsBundle and loadNodeModules keep npm packages in the cache store given, and the bundle records each at the commit its document names', async (t) => {
  const pkg = await published({ repository: 'github:o/pinned' }, { gitHead: COMMIT })
  const store = storeOf(pkg)
  const { bundle, lockfile: lock } = await build({ vfs: vfsOf(projectFiles(pkg)), cache: store })
  t.assert.deepStrictEqual({ ...bundle.modules.get(DIR).repo }, { github: 'o/pinned', commit: COMMIT })
  t.assert.equal(JSON.parse(lock.serialize()).modules[DIR].repo, undefined, 'metadata: never in the lockfile')
  t.assert.deepStrictEqual(asked(store), [`read npm/tarballs ${NAME}@1.0.0`, `read npm/versions ${NAME}@1.0.0`], 'both answered from the store, nothing written to it')

  const tree = await loadNodeModules({ vfs: vfsOf(projectFiles(pkg)), packageManager: 'pnpm', cache: storeOf(pkg) })
  t.assert.deepStrictEqual(tree.installed.map(({ path, commit }) => ({ path, commit })), [{ path: DIR, commit: COMMIT }])
})

test('buildVfsBundle records a commit only in the GitHub repository the package.json names, and only a full one', async (t) => {
  const cases = [
    [{}, { gitHead: COMMIT }, undefined, 'no repository named: a commit of none'],
    [{ repository: 'https://gitlab.com/o/pinned' }, { gitHead: COMMIT }, undefined, 'not a GitHub one'],
    [{ repository: { url: 'git+https://github.com/o/mono.git', directory: 'packages/pinned' } }, { gitHead: COMMIT }, { github: 'o/mono', directory: 'packages/pinned', commit: COMMIT }, 'at its directory'],
    [{ repository: 'github:o/pinned' }, { gitHead: 'c'.repeat(7) }, { github: 'o/pinned' }, 'an abbreviated gitHead: none'],
    [{ repository: 'github:o/pinned' }, {}, { github: 'o/pinned' }, 'no gitHead'],
  ]
  const recorded = await Promise.all(cases.map(async ([manifest, about]) => {
    const pkg = await published(manifest, about)
    const { repo } = (await build({ vfs: vfsOf(projectFiles(pkg)), cache: storeOf(pkg) })).bundle.modules.get(DIR)
    return repo === undefined ? undefined : { ...repo }
  }))
  for (const [i, [, , repo, why]] of cases.entries()) t.assert.deepStrictEqual(recorded[i], repo, why)
})

test('buildGitHubBundle passes the cache store to buildVfsBundle: the repo at its commit, each dependency at its own', async (t) => {
  const pkg = await published({ repository: 'github:o/pinned' }, { gitHead: COMMIT })
  const store = storeOf(pkg)
  const client = fakeClient(projectFiles(pkg))
  const { bundle } = await buildGitHubBundle({ github: 'ExodusOSS/example', client, packageManager: 'pnpm', entries: ['src/a.js'], cache: store })
  t.assert.deepStrictEqual({ ...bundle.repo }, { github: 'ExodusOSS/example', directory: '', commit: HEAD })
  t.assert.deepStrictEqual({ ...bundle.modules.get(DIR).repo }, { github: 'o/pinned', commit: COMMIT })
  t.assert.deepStrictEqual(asked(store), [`read npm/tarballs ${NAME}@1.0.0`, `read npm/versions ${NAME}@1.0.0`])
})

test('a cache that is neither false nor a store is refused before anything is fetched', async (t) => {
  const files = { 'package.json': json({ name: 'p', version: '1.0.0' }), 'pnpm-lock.yaml': lockfile('.'), 'src/a.js': 'module.exports = 1\n' }
  const refused = (name) => new RegExp(`^TypeError: ${name}: cache must be false, or a store with read and write, or left out$`, 'u')
  await Promise.all([true, null, 'dir', {}, { read() {} }].map(async (cache) => {
    const client = fakeClient(files)
    await Promise.all([
      t.assert.rejects(build({ vfs: vfsOf(files), cache }), refused('buildVfsBundle'), JSON.stringify(cache)),
      t.assert.rejects(loadNodeModules({ vfs: vfsOf(files), packageManager: 'pnpm', cache }), refused('loadNodeModules')),
      t.assert.rejects(buildGitHubBundle({ github: 'ExodusOSS/example', client, packageManager: 'pnpm', entries: ['src/a.js'], cache }), refused('buildGitHubBundle')),
    ])
    t.assert.deepStrictEqual(client.calls, [], 'nothing asked of GitHub')
  }))
  // false keeps nothing: nothing to keep here, and nothing refused.
  t.assert.ok((await build({ vfs: vfsOf(files), cache: false })).bundle.sources.has('src/a.js'))
})
