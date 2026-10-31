import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { Vfs, buildGitHubBundle, buildVfsBundle } from '../stasis/src/vfs-bundle.js'
import { inRounds, lazyView } from '../stasis/src/vfs-bundle/lazy.js'
import { Scan } from '../stasis/src/scan.js'
import { githubBundleCommand } from '../stasis/src/cmd/github-bundle.js'
import { HEAD, fakeClient, json } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'
import { captureWarningsAsync } from './warnings.helper.js'

// @exodus/stasis/vfs-bundle with `lazy`: the tree laid out from the lockfile alone, each package
// fetched and unpacked once the build reads it. The packages are kept in a cache store of the
// test's, which answers for each, so nothing is fetched, and what the store is asked tells what the
// build fetched. `used` requires `deep`; `unused` and `broken` are dependencies nothing requires,
// and `broken`'s tarball is not the lockfile's. `phantom` requires `deep`, which it does not
// declare; `declares` depends on `deep` and `broken`, and requires `deep` alone; `top` requires
// `used`. `mconf` is what a Metro config requires, and `babel-plugin-plug` the plugin a Babel config
// names.

const here = dirname(fileURLToPath(import.meta.url))
const encoder = new TextEncoder()
const COMMIT = 'c'.repeat(40)

// A package as published: its tarball, as npm packs one, with `files` and its package.json, and
// the registry's document of it, with `about` in it.
async function published(name, files, { manifest = {}, about = {} } = {}) {
  const all = { 'package.json': json({ name, version: '1.0.0', main: 'index.js', ...manifest }), ...files }
  const tarball = await compress(pack(Object.entries(all).map(([path, text]) => ({ name: `package/${path}`, data: encoder.encode(text), mode: 0o644 }))), 'gzip')
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  return { name, tarball, integrity, document: { name, version: '1.0.0', dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity }, ...about } }
}

const PACKAGES = await Promise.all([
  published('used', { 'index.js': "module.exports = require('deep')\n", 'README.md': 'used\n' }, { manifest: { dependencies: { deep: '1.0.0' }, repository: 'github:o/used' }, about: { gitHead: COMMIT } }),
  published('deep', { 'index.js': 'module.exports = 1\n' }),
  published('unused', { 'index.js': 'module.exports = 2\n' }),
  published('broken', { 'index.js': 'module.exports = 3\n' }),
  published('phantom', { 'index.js': "module.exports = require('deep')\n" }),
  published('declares', { 'index.js': "module.exports = require('deep')\n" }, { manifest: { dependencies: { deep: '1.0.0', broken: '1.0.0' } } }),
  published('mconf', { 'index.js': 'module.exports = {}\n' }),
  published('babel-plugin-plug', { 'index.js': 'module.exports = () => ({})\n' }),
  published('top', { 'index.js': "module.exports = require('used')\n" }, { manifest: { dependencies: { used: '1.0.0' } } }),
])
const BY_NAME = Object.fromEntries(PACKAGES.map((pkg) => [pkg.name, pkg]))
const DEPENDENCIES = { used: { deep: '1.0.0' }, declares: { deep: '1.0.0', broken: '1.0.0' }, top: { used: '1.0.0' } }
// What the lockfile holds broken to, which its tarball is not.
const LOCKED = { ...Object.fromEntries(PACKAGES.map(({ name, integrity }) => [name, integrity])), broken: BY_NAME.unused.integrity }

// A store holding every package's tarball and document, which records what it is asked.
function store() {
  const calls = []
  const kept = new Map(PACKAGES.flatMap(({ name, tarball, document }) => [[`npm/tarballs ${name}@1.0.0`, tarball], [`npm/versions ${name}@1.0.0`, document]]))
  return {
    calls,
    async read(type, key) {
      calls.push(`${type} ${key}`)
      return kept.get(`${type} ${key}`)
    },
    async write() {},
  }
}
// The packages whose tarball the store was asked for.
const tarballs = ({ calls }) => calls.filter((call) => call.startsWith('npm/tarballs ')).map((call) => call.slice('npm/tarballs '.length, -'@1.0.0'.length)).toSorted()

// The project, depending on each of `names`, as pnpm and npm lock it.
const ROOT = ['used', 'unused', 'broken']
// `names` and what they depend on, and so on.
const closure = (names) => {
  const all = new Set()
  const add = (name) => {
    if (all.has(name)) return
    all.add(name)
    for (const dep of Object.keys(DEPENDENCIES[name] ?? {})) add(dep)
  }
  for (const name of names) add(name)
  return [...all].toSorted()
}
const pnpmLock = (names = ROOT) => {
  const all = closure(names)
  return [
    "lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '',
    'importers:', '', '  .:', '    dependencies:', ...names.flatMap((name) => [`      ${name}:`, '        specifier: 1.0.0', '        version: 1.0.0']), '',
    'packages:', '', ...all.flatMap((name) => [`  ${name}@1.0.0:`, `    resolution: {integrity: ${LOCKED[name]}}`, '']),
    'snapshots:', '', ...all.flatMap((name) => (DEPENDENCIES[name] ? [`  ${name}@1.0.0:`, '    dependencies:', ...Object.entries(DEPENDENCIES[name]).map(([dep, v]) => `      ${dep}: ${v}`), ''] : [`  ${name}@1.0.0: {}`, ''])),
  ].join('\n')
}
const npmLock = (names = ROOT) => {
  const all = closure(names)
  const packages = { '': { name: 'p', version: '1.0.0', dependencies: Object.fromEntries(names.map((name) => [name, '1.0.0'])) } }
  for (const name of all) packages[`node_modules/${name}`] = { version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity: LOCKED[name], ...DEPENDENCIES[name] ? { dependencies: DEPENDENCIES[name] } : {} }
  return `${JSON.stringify({ name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`
}
const LOCKFILES = { pnpm: ['pnpm-lock.yaml', pnpmLock], npm: ['package-lock.json', npmLock] }

const projectFiles = (packageManager, { names = ROOT, entry = "require('used')\n", files = {} } = {}) => {
  const [lockfileName, lockOf] = LOCKFILES[packageManager]
  return { 'package.json': json({ name: 'p', version: '1.0.0', dependencies: Object.fromEntries(names.map((name) => [name, '1.0.0'])) }), [lockfileName]: lockOf(names), 'src/a.js': entry, ...files }
}
const vfsOf = (files) => {
  const vfs = new Vfs()
  for (const [path, text] of Object.entries(files)) {
    vfs.mkdir(posix.dirname(`/${path}`), { recursive: true })
    vfs.writeFile(`/${path}`, text)
  }
  return vfs
}
const build = (packageManager, options = {}, files = {}) => buildVfsBundle({ vfs: vfsOf(projectFiles(packageManager, files)), packageManager, entries: ['src/a.js'], scope: 'full', ...options })

for (const packageManager of ['pnpm', 'npm']) {
  test(`${packageManager}: lazily, the bundle and lockfile of the full tree, of the packages the build reads alone`, async (t) => {
    // The full tree of the packages but broken, which the full tree refuses.
    const names = ['used', 'unused']
    const full = await build(packageManager, { cache: store() }, { names })
    const cache = store()
    const lazy = await build(packageManager, { cache, lazy: true }, { names })
    t.assert.equal(lazy.bundle.serialize(), full.bundle.serialize())
    t.assert.equal(lazy.lockfile.serialize(), full.lockfile.serialize())
    t.assert.equal(lazy.root, full.root)
    t.assert.deepStrictEqual(tarballs(cache), ['deep', 'used'], 'unused is never fetched')
    t.assert.equal(lazy.stats.tarballs, 2)
    t.assert.equal(full.stats.tarballs, 3)
    t.assert.equal(lazy.stats.unpacked, 2)
    t.assert.equal(full.stats.unpacked, 3)
    const dir = [...lazy.bundle.modules.keys()].find((path) => path.endsWith('/used'))
    t.assert.deepStrictEqual({ ...lazy.bundle.modules.get(dir).repo }, { github: 'o/used', commit: COMMIT }, 'at the commit its document names, which it is fetched with')
  })

  test(`${packageManager}: lazily, a tarball the build never reads is never fetched, nor refused; one it reads is refused as without lazy`, async (t) => {
    await t.assert.rejects(build(packageManager, { cache: store() }), /integrity|is not sha512-/u, 'the full tree is refused for broken')
    const cache = store()
    const { bundle } = await build(packageManager, { cache, lazy: true })
    t.assert.ok(bundle.sources.has('src/a.js'))
    t.assert.deepStrictEqual(tarballs(cache), ['deep', 'used'])
    const entry = "require('broken')\n"
    const refused = await build(packageManager, { cache: store() }, { entry }).then(() => t.assert.fail('refused'), (error) => error)
    await t.assert.rejects(build(packageManager, { cache: store(), lazy: true }, { entry }), { message: refused.message })
  })

  // A round asks for phantom, the next for deep, which phantom requires and does not declare, and
  // the last is the build. Each file is parsed once: one whose scan read a package not unpacked yet
  // (b.js too, though src/a.js resolved its `phantom` first, from the same directory) is scanned
  // again in the round after, its imports resolved again, but from the parse kept.
  test(`${packageManager}: lazily, each file is parsed once, though scanned again in the round after one it reads a package not unpacked yet in`, async (t) => {
    const files = { names: ['phantom', 'used'], entry: "require('./b.js')\nrequire('phantom')\n", files: { 'src/b.js': "require('phantom')\n" } }
    const full = await build(packageManager, { cache: store() }, files)
    const parsed = new Map()
    const parse = Scan.prototype.parseFile
    t.mock.method(Scan.prototype, 'parseFile', function (file) {
      const name = file.endsWith('index.js') ? posix.basename(posix.dirname(file)) : posix.basename(file)
      parsed.set(name, (parsed.get(name) ?? 0) + 1)
      return parse.call(this, file)
    })
    const walks = t.mock.method(Scan.prototype, 'walk')
    const lazy = await build(packageManager, { cache: store(), lazy: true }, files)
    t.assert.equal(lazy.bundle.serialize(), full.bundle.serialize())
    t.assert.equal(walks.mock.callCount(), 3)
    t.assert.deepStrictEqual(Object.fromEntries(parsed), { 'a.js': 1, 'b.js': 1, phantom: 1, deep: 1 })
  })

  test(`${packageManager}: lazily, what a package read depends on is unpacked with it, but one deptree refuses is left for the build to read`, async (t) => {
    const cache = store()
    const walks = t.mock.method(Scan.prototype, 'walk')
    const { bundle } = await build(packageManager, { cache, lazy: true }, { names: ['declares'], entry: "require('declares')\n" })
    t.assert.equal(walks.mock.callCount(), 2, 'deep unpacked with declares, a round before the build reads it')
    t.assert.deepStrictEqual(tarballs(cache), ['broken', 'declares', 'deep'])
    t.assert.ok([...bundle.modules.keys()].some((dir) => dir.endsWith('/deep')))
    const entry = "require('declares')\nrequire('broken')\n"
    await t.assert.rejects(build(packageManager, { cache: store(), lazy: true }, { names: ['declares', 'broken'], entry }), /integrity|is not sha512-/u)
  })

  // Under --metro, the first round reads on past src/a.js's import of `used`, not unpacked yet, which
  // would break the bundle, through both platforms and the configs, reporting nothing: it asks for
  // used, mconf and babel-plugin-plug at once, and the next is the build, which traces the plugin too. Each round scans the entry for
  // each platform and the configs; the build, the plugin as well.
  test(`${packageManager}: lazily under --metro, a round that asks reads on through the configs, as the full tree's build`, async (t) => {
    const names = ['used', 'mconf', 'babel-plugin-plug']
    const files = { 'metro.config.js': "module.exports = require('mconf')\n", 'babel.config.js': "module.exports = { plugins: ['plug'] }\n", 'aliases.json': '{}\n' }
    const options = { metro: true, platforms: ['ios', 'android'], babelAliases: 'aliases.json' }
    const entry = "import used from 'used'\nexport default used\n"
    const full = await build(packageManager, { cache: store(), ...options }, { names, entry, files })
    const cache = store()
    const walks = t.mock.method(Scan.prototype, 'walk')
    const lazy = await build(packageManager, { cache, lazy: true, ...options }, { names, entry, files })
    t.assert.equal(lazy.bundle.serialize(), full.bundle.serialize())
    t.assert.equal(lazy.lockfile.serialize(), full.lockfile.serialize())
    t.assert.ok([...lazy.bundle.modules.keys()].some((dir) => dir.endsWith('/babel-plugin-plug')))
    t.assert.deepStrictEqual(tarballs(cache), ['babel-plugin-plug', 'deep', 'mconf', 'used'])
    t.assert.equal(walks.mock.callCount(), 3 + 4)
  })

  // A round reads top, which is unpacked with used, which it depends on; the next reads used, and
  // asks for deep, which used depends on, and which was not unpacked with top: the last is the build.
  test(`${packageManager}: lazily, what a package read depends on is unpacked with it, but not what that depends on`, async (t) => {
    const full = await build(packageManager, { cache: store() }, { names: ['top'], entry: "require('top')\n" })
    const cache = store()
    const walks = t.mock.method(Scan.prototype, 'walk')
    const lazy = await build(packageManager, { cache, lazy: true }, { names: ['top'], entry: "require('top')\n" })
    t.assert.equal(lazy.bundle.serialize(), full.bundle.serialize())
    t.assert.equal(walks.mock.callCount(), 3)
    t.assert.deepStrictEqual(tarballs(cache), ['deep', 'top', 'used'])
  })

  // Under --metro, the build checks each dependency of the project for a react-native.config.js and
  // for native code, as React Native's CLI does: declares, which nothing imports, is unpacked for it,
  // but not what it depends on, which nothing reads. broken is never fetched, so never refused.
  test(`${packageManager}: lazily under --metro, a dependency only checked for its files is unpacked alone`, async (t) => {
    const cache = store()
    const { bundle } = await build(packageManager, { cache, lazy: true, metro: true, platforms: ['ios', 'android'] }, { names: ['used', 'declares'], entry: "import used from 'used'\nexport default used\n" })
    t.assert.ok([...bundle.modules.keys()].some((dir) => dir.endsWith('/deep')))
    t.assert.deepStrictEqual(tarballs(cache), ['declares', 'deep', 'used'])
  })

  test(`${packageManager}: lazily, the warnings of the build are said once, as without lazy`, async (t) => {
    const entry = "require('used')\nrequire('missing')\n"
    const warned = async (options) => {
      const warn = t.mock.method(console, 'warn', () => {})
      try {
        await build(packageManager, { cache: store(), ...options }, { names: ['used'], entry })
        return warn.mock.calls.map((call) => call.arguments.join(' '))
      } finally {
        warn.mock.restore()
      }
    }
    const full = await warned({})
    t.assert.equal(full.filter((line) => line.includes('missing')).length, 1)
    t.assert.deepStrictEqual(await warned({ lazy: true }), full)
    t.assert.notEqual(console.warn.name, 'warnHeld', 'console.warn is left as it was')
  })

  test(`${packageManager}: lazily, a .yarnclean of patterns cleans each package as it is unpacked, as the full tree's`, async (t) => {
    const files = { names: ['used'], entry: "require('used')\n", files: { '.yarnclean': '*.md\n' } }
    const lazy = await build(packageManager, { cache: store(), lazy: true }, files)
    t.assert.equal(lazy.bundle.serialize(), (await build(packageManager, { cache: store() }, files)).bundle.serialize())
    // One that keeps paths with `!` is refused before anything is fetched.
    const cache = store()
    await t.assert.rejects(build(packageManager, { cache, lazy: true }, { ...files, files: { '.yarnclean': '*.md\n!used/README.md\n' } }), /^Error: a \.yarnclean in \/ or above it keeps paths with `!`, which lazy does not take/u)
    t.assert.deepStrictEqual(cache.calls, [])
  })
}

test('lazy is refused for yarn 1 and Soldeer, and taken only as a boolean, before anything is fetched', async (t) => {
  const yarn = { 'package.json': json({ name: 'p', version: '1.0.0' }), 'yarn.lock': '# yarn lockfile v1\n\n\n', 'src/a.js': '' }
  await t.assert.rejects(buildVfsBundle({ vfs: vfsOf(yarn), packageManager: 'yarn1', entries: ['src/a.js'], lazy: true }), /^Error: buildVfsBundle: lazy is taken with pnpm and npm alone, which lay out a tree from the lockfile alone; yarn1's is not$/u)
  const soldeer = { 'foundry.toml': '[profile.default]\n', 'soldeer.lock': '', 'src/A.sol': 'pragma solidity ^0.8.0;\n' }
  await t.assert.rejects(buildVfsBundle({ vfs: vfsOf(soldeer), packageManager: 'soldeer', entries: ['src/A.sol'], lazy: true }), /^Error: buildVfsBundle: lazy is taken with pnpm and npm alone, which lay out a tree from the lockfile alone; soldeer's is not$/u)
  await t.assert.rejects(build('pnpm', { lazy: 'yes' }), /^TypeError: buildVfsBundle: lazy must be a boolean$/u)
  // Of a GitHub repo, before its tree is fetched.
  const client = fakeClient(yarn)
  await t.assert.rejects(buildGitHubBundle({ github: 'o/n', client, packageManager: 'yarn1', entries: ['src/a.js'], lazy: true }), /^Error: buildGitHubBundle: lazy is taken with pnpm and npm alone/u)
  await t.assert.rejects(buildGitHubBundle({ github: 'o/n', client, packageManager: 'pnpm', entries: ['src/a.js'], lazy: 1 }), /^TypeError: buildGitHubBundle: lazy must be a boolean$/u)
  t.assert.deepStrictEqual(client.calls, [])
})

test('buildGitHubBundle lazily: the repo as fetched, its dependencies as the build reads them', async (t) => {
  const cache = store()
  const files = projectFiles('pnpm', { names: ['used', 'unused'] })
  const lazy = await buildGitHubBundle({ github: 'o/n', client: fakeClient(files), packageManager: 'pnpm', entries: ['src/a.js'], cache, lazy: true })
  const full = await buildGitHubBundle({ github: 'o/n', client: fakeClient(files), packageManager: 'pnpm', entries: ['src/a.js'], cache: store() })
  t.assert.equal(lazy.bundle.serialize(), full.bundle.serialize())
  t.assert.deepStrictEqual({ ...lazy.bundle.repo }, { github: 'o/n', directory: '', commit: HEAD })
  t.assert.deepStrictEqual(tarballs(cache), ['deep', 'used'])
})

test('stasis github-bundle says how many packages it unpacked, of those installed, lazily or not', withTmp(async (t, dir) => {
  const files = projectFiles('pnpm', { names: ['used', 'unused'] })
  const said = async (lazy) => {
    const options = { cwd: dir, github: 'o/n', client: fakeClient(files), packageManager: 'pnpm', entries: ['src/a.js'], cache: store(), lazy, output: 'out.br' }
    const { warnings } = await captureWarningsAsync(() => githubBundleCommand(options))
    return warnings.filter((line) => line.startsWith('[stasis] Unpacked'))
  }
  const [full] = await said(false)
  t.assert.match(full, /^\[stasis\] Unpacked 3 of 3 packages: 7 files, 0\.0 MiB, 3 tarballs fetched$/u)
  t.assert.deepStrictEqual(await said(true), [full.replace('3 of 3 packages: 7 files', '2 of 3 packages: 5 files').replace('3 tarballs', '2 tarballs')])
}))

test('stasis github-bundle takes --lazy, and refuses it for yarn 1 before anything is fetched', async (t) => {
  const child = spawn(process.execPath, [join(here, '..', 'stasis', 'bin', 'stasis.js'), 'github-bundle', '--github=o/n', '--package-manager=yarn1', '--lazy', 'a.js'])
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  const [status] = await once(child, 'close')
  t.assert.equal(status, 1)
  t.assert.match(Buffer.concat(stderr).toString('utf8'), /buildGitHubBundle: lazy is taken with pnpm and npm alone, which lay out a tree from the lockfile alone; yarn1's is not/u)
})

test('lazyView asks for a package read under before it is unpacked, but not for its directory or those above it; one probed alone is not read', (t) => {
  const vfs = new Vfs()
  for (const dir of ['/node_modules/a', '/node_modules/a/node_modules/b', '/node_modules/@s/c']) vfs.mkdir(dir, { recursive: true })
  vfs.writeFile('/node_modules/a/index.js', '')
  vfs.symlink('a', '/node_modules/link')
  const roots = new Set(['/node_modules/a', '/node_modules/a/node_modules/b', '/node_modules/@s/c'])
  const unpacked = new Set()
  const reads = { asked: new Set(), read: new Set(), probing: 0, touches: 0 }
  const { asked } = reads
  const view = lazyView(vfs, { roots, unpacked, reads })
  view.lstat('/node_modules/a')
  view.lstat('/node_modules/@s')
  view.readdir('/node_modules')
  view.readlink('/node_modules/link')
  view.lstat('/node_modules/a/node_modules')
  view.lstat('/node_modules/a/node_modules/b')
  t.assert.deepStrictEqual([...asked], [], 'the layout alone')
  t.assert.throws(() => view.lstat('/node_modules/a/node_modules/b/package.json'), { code: 'ENOENT' })
  t.assert.deepStrictEqual([...asked], ['/node_modules/a/node_modules/b'], 'the innermost package')
  view.readdir('/node_modules/@s/c')
  view.readFile('/node_modules/a/index.js')
  t.assert.deepStrictEqual([...asked], ['/node_modules/a/node_modules/b', '/node_modules/@s/c', '/node_modules/a'], 'a listing of a package itself, and a file of it')
  t.assert.equal(reads.touches, 3, 'each read so')
  view.readFile('/node_modules/a/index.js')
  t.assert.equal(reads.touches, 4, 'again, as many times as it is read')
  asked.clear()
  unpacked.add('/node_modules/a')
  view.readFile('/node_modules/a/index.js')
  t.assert.deepStrictEqual([...asked], [], 'once unpacked, nothing')
  t.assert.equal(reads.touches, 4)
  t.assert.deepStrictEqual([...reads.read], ['/node_modules/a/node_modules/b', '/node_modules/@s/c', '/node_modules/a'], 'each read')
  // A read while probing asks for the package, which it does not read.
  const probed = { asked: new Set(), read: new Set(), probing: 1, touches: 0 }
  t.assert.throws(() => lazyView(vfs, { roots, unpacked: new Set(), reads: probed }).lstat('/node_modules/@s/c/react-native.config.js'), { code: 'ENOENT' })
  t.assert.deepStrictEqual([[...probed.asked], [...probed.read], probed.touches], [['/node_modules/@s/c'], [], 1], 'probed alone')
})

test('inRounds: a round that asks is void, warnings and all; the first that asks nothing is the build', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  const unpacked = []
  let round = 0
  const result = await inRounds(async ({ asked }) => {
    round++
    console.warn(`round ${round}`)
    if (round < 3) asked.add(`/p${round}`)
    if (round === 1) throw new Error('void, so never thrown')
    return round
  }, async (asked) => {
    unpacked.push([...asked])
  })
  t.assert.equal(result, 3)
  t.assert.deepStrictEqual(unpacked, [['/p1'], ['/p2']])
  t.assert.deepStrictEqual(warn.mock.calls.map((call) => call.arguments[0]), ['round 3'])
  await t.assert.rejects(inRounds(async () => {
    throw new Error('the build fails')
  }, () => t.assert.fail('nothing asked')), /^Error: the build fails$/u)
  // A warning given beside a round, not within it, is said as it is.
  const beside = inRounds(async () => {
    await new Promise((resolve) => setImmediate(resolve))
    return 0
  }, () => {})
  console.warn('beside')
  await beside
  t.assert.ok(warn.mock.calls.some((call) => call.arguments[0] === 'beside'))
})
