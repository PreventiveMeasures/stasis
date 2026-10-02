import { test } from 'node:test'
import { posix } from 'node:path'

import { Vfs, buildVfsBundle, loadNodeModules } from '../stasis/src/vfs-bundle.js'
import { lockfileRoot, vfsHost } from '../stasis/src/vfs-bundle/tree.js'

// @exodus/stasis/vfs-bundle with npm, over a project held in a Vfs, which @preventive/deptree reads
// the package-lock.json, the package.json of the root and of every workspace, and the .npmrc from.
// Every lockfile here locks no registry package, so nothing is fetched.

// JSON as npm writes it, which its lockfile reader holds package-lock.json to.
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

const project = (files) => {
  const vfs = new Vfs()
  for (const [rel, text] of Object.entries(files)) {
    vfs.mkdir(posix.dirname(`/${rel}`), { recursive: true })
    vfs.writeFile(`/${rel}`, typeof text === 'string' ? text : json(text))
  }
  return vfs
}

const load = (options) => loadNodeModules({ packageManager: 'npm', ...options })

// The package-lock.json npm writes for `root`, the root's entry, and `packages` beside it.
const lockOf = (root, packages = {}) => ({ name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages: { '': root, ...packages } })

const ROOT = { name: 'p', version: '1.0.0' }

test('npm: lays out, into a Vfs of its own, the package-lock.json of cwd or the nearest parent, with npm 11.21.0 unless another is given', async (t) => {
  const files = { 'package.json': ROOT, 'package-lock.json': lockOf(ROOT), 'src/deep/a.js': '' }
  const vfs = project(files)
  const tree = await load({ vfs, cwd: '/src/deep' })
  t.assert.equal(tree.root, '/')
  t.assert.equal(tree.packageManager, 'npm')
  t.assert.equal(tree.packageManagerVersion, '11.21.0')
  t.assert.deepEqual([...tree.projects], ['.'])
  t.assert.equal(vfs.isDirectory('/node_modules'), false, 'the project\'s Vfs is only read')
  t.assert.equal(tree.host.stat('/src/deep/a.js').isFile(), true)
  // npm reads no packageManager, so one naming another npm changes nothing.
  t.assert.equal((await load({ vfs: project({ ...files, 'package.json': { ...ROOT, packageManager: 'npm@10.9.4' } }) })).packageManagerVersion, '11.21.0')
  t.assert.equal((await load({ vfs: project(files), packageManagerVersion: '10.9.4' })).packageManagerVersion, '10.9.4')
  // Node 24.14.0's own npm, 11.9.0, is not one deptree reproduces, nor is npm 12.
  await t.assert.rejects(load({ vfs: project(files), packageManagerVersion: '11.9.0' }), /host\.npm: npm "11\.9\.0" is not supported: only 10\.9\.3 to 10\.9\.9, and 11\.11\.1 to 11\.21\.0$/u)
  await t.assert.rejects(load({ vfs: project(files), packageManagerVersion: '12.2.0' }), /host\.npm: npm "12\.2\.0" is not supported/u)
})

test('npm: links each workspace, and cwd may be in any of them', async (t) => {
  const files = {
    'package.json': { name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'] },
    'package-lock.json': lockOf({ name: 'root', version: '1.0.0', workspaces: ['packages/*'] }, {
      'node_modules/a': { resolved: 'packages/a', link: true },
      'node_modules/b': { resolved: 'packages/b', link: true },
      'packages/a': { version: '1.0.0' },
      'packages/b': { version: '1.0.0', dependencies: { a: '1.0.0' } },
    }),
    'packages/a/package.json': { name: 'a', version: '1.0.0' },
    'packages/a/index.js': 'module.exports = 1\n',
    'packages/b/package.json': { name: 'b', version: '1.0.0', dependencies: { a: '1.0.0' } },
    'packages/b/index.js': 'require("a")\n',
  }
  const tree = await load({ vfs: project(files), cwd: '/packages/b' })
  t.assert.deepEqual([...tree.projects], ['.', 'packages/a', 'packages/b'])
  t.assert.equal(tree.vfs.readlink('/node_modules/a'), '../packages/a')
  t.assert.equal(tree.host.resolve('/packages/b/index.js', 'a'), '/packages/a/index.js')
  // Below a package.json that is only a `type` marker, still the root's; a package of its own, not.
  t.assert.deepEqual([...(await load({ vfs: project({ ...files, 'src/package.json': { type: 'module' } }), cwd: '/src' })).projects], ['.', 'packages/a', 'packages/b'])
  await t.assert.rejects(load({ vfs: project({ ...files, 'tools/package.json': { name: 'tools', version: '1.0.0' } }), cwd: '/tools' }), (err) => err.message === "/package-lock.json does not install /tools: it is none of the lockfile's projects")
  // A workspace is installed from the root that declares it, whatever package-lock.json is nearer; a
  // package that is no workspace, from its own.
  t.assert.equal((await load({ vfs: project({ ...files, 'packages/b/package-lock.json': lockOf({ name: 'b', version: '1.0.0' }) }), cwd: '/packages/b' })).root, '/')
  const website = await load({ vfs: project({ ...files, 'website/package.json': { name: 'website', version: '1.0.0' }, 'website/package-lock.json': lockOf({ name: 'website', version: '1.0.0' }) }), cwd: '/website' })
  t.assert.deepEqual([website.root, [...website.projects]], ['/website', ['.']])
})

test('npm: takes a workspace root for the os given, whose glob matches as npm\'s does there', async (t) => {
  // On macOS npm's glob takes `Packages/*` for packages/b, whatever the case: b is a workspace there,
  // installed from the root whatever package-lock.json it holds.
  const files = {
    'package.json': { name: 'root', version: '1.0.0', private: true, workspaces: ['Packages/*'] },
    'package-lock.json': lockOf({ name: 'root', version: '1.0.0', workspaces: ['Packages/*'] }, {
      'node_modules/b': { resolved: 'packages/b', link: true },
      'packages/b': { version: '1.0.0' },
    }),
    'packages/b/package.json': { name: 'b', version: '1.0.0' },
    'packages/b/package-lock.json': lockOf({ name: 'b', version: '1.0.0' }),
    'packages/b/index.js': '',
  }
  const host = vfsHost(project(files))
  t.assert.equal(lockfileRoot(host, 'npm', '/packages/b', 'darwin'), '/')
  // There the root's package-lock.json is read, not b's own -- which deptree's lockfile reader,
  // matching the root's workspaces by case, refuses.
  await t.assert.rejects(load({ vfs: project(files), cwd: '/packages/b', os: 'darwin' }), /^Error: \/package-lock\.json: packages\["node_modules\/b"\]: nothing installed leads to it/u)
  // On Linux the glob takes no workspace: b is installed from its own package-lock.json.
  t.assert.equal(lockfileRoot(host, 'npm', '/packages/b', 'linux'), '/packages/b')
  const linux = await load({ vfs: project(files), cwd: '/packages/b', os: 'linux' })
  t.assert.deepEqual([linux.root, [...linux.projects]], ['/packages/b', ['.']])
})

test('npm: refuses, naming the file, what it cannot reproduce', async (t) => {
  const manifest = { 'package.json': ROOT }
  await t.assert.rejects(load({ vfs: project(manifest) }), /^Error: no package-lock\.json found in \/ or any parent directory/u)
  await t.assert.rejects(load({ vfs: project({ ...manifest, 'yarn.lock': '# yarn lockfile v1\n' }) }), /^Error: no package-lock\.json found/u, 'packageManager says which lockfile is read')
  await t.assert.rejects(load({ vfs: project({ ...manifest, 'package-lock.json': JSON.stringify(lockOf(ROOT)) }) }), (err) => err.message.startsWith('/package-lock.json: expected "{" alone on the first line') && err.cause?.name === 'LockfileError')
  await t.assert.rejects(load({ vfs: project({ 'package.json': { ...ROOT, dependencies: { ms: '2.1.3' } }, 'package-lock.json': lockOf(ROOT) }) }), /manifests\["\."\]: asks for "ms" as prod "2\.1\.3", and the lockfile as nothing, which npm ci refuses or resolves again$/u)
  await t.assert.rejects(load({ vfs: project({ ...manifest, 'package-lock.json': lockOf(ROOT), 'npm-shrinkwrap.json': lockOf(ROOT) }) }), /npm-shrinkwrap\.json: an npm-shrinkwrap\.json, which npm reads in place of package-lock\.json, is not supported$/u)
  await t.assert.rejects(load({ vfs: project({ ...manifest, 'package-lock.json': lockOf(ROOT), '.npmrc': 'omit=dev\n' }) }), /\.npmrc:1: "omit" is a setting not supported here: it may change what npm installs$/u)
})

test('npm: builds a JS bundle from the lockfile, detected where it alone installs cwd', async (t) => {
  const files = { 'package.json': ROOT, 'package-lock.json': lockOf(ROOT), 'src/a.js': 'module.exports = 1\n' }
  const { bundle, packageManager } = await buildVfsBundle({ vfs: project(files), entries: ['src/a.js'] })
  t.assert.equal(packageManager, 'npm')
  t.assert.deepEqual([...bundle.sources.keys()], ['src/a.js'])
  await t.assert.rejects(buildVfsBundle({ vfs: project(files), packageManager: 'npm', entries: ['a.sol'] }), /^Error: buildVfsBundle: only JS bundles are built with npm$/u)
})
