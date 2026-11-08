import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { Config } from '@exodus/stasis-core/config'
import { parseLockfilesOption } from '@exodus/stasis-core/util'
import { buildCommandBundle } from '../stasis/src/cmd/bundle.js'
import { buildGitHubBundle, buildVfsBundle, suggestedEntries } from '../stasis/src/vfs-bundle.js'
import { fakeClient, json, lockfile, vfsOf } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

// stasis.config.json's `lockfiles`: the lockfiles a project's dependencies are laid out from, a tree
// of each, in place of the one detected. The packages are kept in a cache store of the test's, which
// answers for each, so nothing is fetched, and what it is asked tells what was. `used` is what the
// root project depends on, `tool` what tools/, a project of its own with its own lockfile, does.

const GITHUB = 'ExodusOSS/example'
const SHA = 'a'.repeat(40)
const encoder = new TextEncoder()

// A package as published: its tarball, as npm packs one, and the registry's document of it.
async function published(name, files) {
  const all = { 'package.json': json({ name, version: '1.0.0', main: 'index.js' }), ...files }
  const tarball = await compress(pack(Object.entries(all).map(([path, text]) => ({ name: `package/${path}`, data: encoder.encode(text), mode: 0o644 }))), 'gzip')
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  return { name, tarball, integrity, document: { name, version: '1.0.0', dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity } } }
}
const PACKAGES = Object.fromEntries((await Promise.all([
  published('used', { 'index.js': 'module.exports = 1\n' }),
  published('tool', { 'index.js': 'module.exports = 2\n' }),
])).map((pkg) => [pkg.name, pkg]))

// A store holding every package's tarball and document, which records what it is asked.
function store() {
  const calls = []
  const kept = new Map(Object.values(PACKAGES).flatMap(({ name, tarball, document }) => [[`npm/tarballs ${name}@1.0.0`, tarball], [`npm/versions ${name}@1.0.0`, document]]))
  return {
    calls,
    async read(type, key) {
      calls.push(`${type} ${key}`)
      return kept.get(`${type} ${key}`)
    },
    async write() {},
  }
}

// pnpm's lockfile of importers by id, each depending on the packages it names.
const pnpmLock = (importers) => {
  const names = [...new Set(Object.values(importers).flat())].toSorted()
  const importer = ([id, deps]) => (deps.length === 0 ? [`  ${id}: {}`, ''] : [`  ${id}:`, '    dependencies:', ...deps.flatMap((name) => [`      ${name}:`, '        specifier: 1.0.0', '        version: 1.0.0']), ''])
  return [
    "lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '',
    'importers:', '', ...Object.entries(importers).flatMap(importer),
    ...names.length === 0 ? [] : ['packages:', '', ...names.flatMap((name) => [`  ${name}@1.0.0:`, `    resolution: {integrity: ${PACKAGES[name].integrity}}`, '']), 'snapshots:', '', ...names.flatMap((name) => [`  ${name}@1.0.0: {}`, ''])],
  ].join('\n')
}
// npm's lockfile of the project `root`, depending on the packages it names.
const npmLock = (root, names) => {
  const packages = { '': { name: root, version: '1.0.0', ...names.length > 0 ? { dependencies: Object.fromEntries(names.map((name) => [name, '1.0.0'])) } : {} } }
  for (const name of names) packages[`node_modules/${name}`] = { version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity: PACKAGES[name].integrity }
  return `${JSON.stringify({ name: root, version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`
}
const manifest = (name, names = []) => json({ name, version: '1.0.0', ...names.length > 0 ? { dependencies: Object.fromEntries(names.map((dep) => [dep, '1.0.0'])) } : {} })
const SOLDEER = { 'foundry.toml': '[profile.default]\nlibs = ["dependencies"]\n\n[dependencies]\n', 'soldeer.lock': 'dependencies = []\n' }

// `files` moved under the directory `dir`.
const under = (dir, files) => Object.fromEntries(Object.entries(files).map(([path, text]) => [`${dir}/${path}`, text]))

// The root project, installed by pnpm, and tools/, by npm from its own lockfile, which no lockfile
// the root's detection finds installs.
const TWO = {
  'package.json': manifest('p', ['used']),
  'pnpm-lock.yaml': pnpmLock({ '.': ['used'] }),
  'src/a.js': "require('used')\n",
  'tools/package.json': manifest('tools', ['tool']),
  'tools/package-lock.json': npmLock('tools', ['tool']),
  'tools/cli.js': "require('tool')\n",
}
const LOCKFILES = ['pnpm-lock.yaml', 'tools/package-lock.json']
const configured = (files, config) => ({ ...files, 'stasis.config.json': json(config) })

test('parseLockfilesOption takes the paths, normalized, and refuses what names no lockfile file', (t) => {
  t.assert.equal(parseLockfilesOption('x', undefined), undefined)
  t.assert.deepStrictEqual(parseLockfilesOption('x', ['pnpm-lock.yaml', './ios/../contracts/soldeer.lock', '../../yarn.lock']), ['pnpm-lock.yaml', 'contracts/soldeer.lock', '../../yarn.lock'])
  for (const [value, message] of [
    ['pnpm-lock.yaml', /^TypeError: x: lockfiles must be a non-empty array of paths$/u],
    [[], /^TypeError: x: lockfiles must be a non-empty array of paths$/u],
    [[1], /^TypeError: x: lockfiles entry must be a non-empty string, got 1$/u],
    [[''], /^TypeError: x: lockfiles entry must be a non-empty string, got ""$/u],
    [['/repo/pnpm-lock.yaml'], /^Error: x: lockfiles entry '\/repo\/pnpm-lock\.yaml' must be a POSIX path relative to the directory holding stasis\.config\.json$/u],
    [['a\\pnpm-lock.yaml'], /must be a POSIX path relative to the directory holding stasis\.config\.json$/u],
    [['..'], /^Error: x: lockfiles entry '\.\.' must name a file$/u],
    [['a/'], /^Error: x: lockfiles entry 'a\/' must name a file$/u],
    [['a/pnpm-lock.yaml', './a/pnpm-lock.yaml'], /^Error: x: lockfiles names a\/pnpm-lock\.yaml twice$/u],
  ]) t.assert.throws(() => parseLockfilesOption('x', value), message, JSON.stringify(value))
})

test("stasis run takes stasis.config.json's lockfiles, which it takes nothing from, and refuses one malformed", (t) => {
  // Any name: which lockfiles a tree is laid out from is the tree's to say.
  new Config({ env: {} }).loadConfig(json({ lockfiles: ['pnpm-lock.yaml', 'ios/Podfile.lock'] }))
  t.assert.throws(() => new Config({ env: {} }).loadConfig(json({ lockfiles: 'pnpm-lock.yaml' })), /^TypeError: stasis\.config\.json: lockfiles must be a non-empty array of paths$/u)
})

test("buildVfsBundle lays out a tree of each lockfile stasis.config.json names, lazily or not, as one", async (t) => {
  const files = configured(TWO, { lockfiles: LOCKFILES, entries: { 'src/a.js': {}, 'tools/cli.js': {} } })
  const full = await buildVfsBundle({ vfs: vfsOf(files), cache: store(), lazy: false })
  // tools/'s tool of its own lockfile, npm's, and the root's used of pnpm's.
  t.assert.deepStrictEqual([...full.bundle.sources.keys()].toSorted(), ['node_modules/.pnpm/used@1.0.0/node_modules/used/index.js', 'src/a.js', 'tools/cli.js', 'tools/node_modules/tool/index.js'])
  t.assert.deepStrictEqual([...full.bundle.imports.get('*').get('tools/cli.js')], [['tool', 'tools/node_modules/tool/index.js']])
  t.assert.equal(full.packageManager, undefined, 'no one package manager')
  t.assert.deepStrictEqual(full.packageManagers, ['pnpm', 'npm'])
  t.assert.equal(full.root, '/')
  t.assert.deepStrictEqual({ unpacked: full.stats.unpacked, tarballs: full.stats.tarballs }, { unpacked: 2, tarballs: 2 }, 'the counts of both')
  const cache = store()
  const lazy = await buildVfsBundle({ vfs: vfsOf(files), cache, lazy: true })
  t.assert.equal(lazy.bundle.serialize(), full.bundle.serialize())
  t.assert.equal(lazy.lockfile.serialize(), full.lockfile.serialize())
  t.assert.deepStrictEqual({ unpacked: lazy.stats.unpacked, tarballs: lazy.stats.tarballs }, { unpacked: 2, tarballs: 2 })
  // Lazily by default too, each tree unpacking what the build reads alone.
  const reached = configured(TWO, { lockfiles: LOCKFILES, entries: { 'src/a.js': {} } })
  const only = store()
  const built = await buildVfsBundle({ vfs: vfsOf(reached), cache: only })
  t.assert.ok(built.bundle.sources.has('node_modules/.pnpm/used@1.0.0/node_modules/used/index.js'))
  t.assert.deepStrictEqual(only.calls.filter((call) => call.startsWith('npm/tarballs ')), ['npm/tarballs used@1.0.0'], "tools/'s tool is never fetched")
  t.assert.equal(built.stats.unpacked, 1)
})

test("buildVfsBundle detects the one lockfile without stasis.config.json's lockfiles, which tools/'s is not", async (t) => {
  const built = await buildVfsBundle({ vfs: vfsOf(TWO), cache: store(), entries: ['src/a.js', 'tools/cli.js'] })
  t.assert.equal(built.packageManager, 'pnpm')
  t.assert.deepStrictEqual(built.packageManagers, ['pnpm'])
  t.assert.ok(!built.bundle.sources.has('tools/node_modules/tool/index.js'), 'no tree installs tools/')
})

test("buildVfsBundle builds JS and Solidity entries together of a pnpm tree and a Soldeer one", async (t) => {
  const files = {
    'package.json': manifest('p', ['used']),
    'pnpm-lock.yaml': pnpmLock({ '.': ['used'] }),
    'src/a.js': "require('used')\n",
    ...under('contracts', SOLDEER),
    'contracts/src/A.sol': 'pragma solidity ^0.8.0;\ncontract A {}\n',
  }
  // Built apart, as entries with other options are, their bundles merged.
  const entries = { 'src/a.js': {}, 'contracts/src/A.sol': { manifests: true } }
  // Detected, pnpm's alone, which builds no Solidity bundle.
  await t.assert.rejects(buildVfsBundle({ vfs: vfsOf(configured(files, { entries })), cache: store() }), /^Error: buildVfsBundle: only JS bundles are built with pnpm$/u)
  const built = await buildVfsBundle({ vfs: vfsOf(configured(files, { lockfiles: ['pnpm-lock.yaml', 'contracts/soldeer.lock'], entries })), cache: store() })
  t.assert.deepStrictEqual([...built.bundle.entries].toSorted(), ['contracts/src/A.sol', 'src/a.js'])
  t.assert.ok(built.bundle.sources.has('node_modules/.pnpm/used@1.0.0/node_modules/used/index.js'))
  t.assert.deepStrictEqual(built.packageManagers, ['pnpm', 'soldeer'])
  // Without entries, none are taken: which kind is not the lockfiles' to say.
  t.assert.deepStrictEqual(await suggestedEntries({ vfs: vfsOf(configured(files, { lockfiles: ['pnpm-lock.yaml', 'contracts/soldeer.lock'] })) }), [])
  t.assert.deepStrictEqual(await suggestedEntries({ vfs: vfsOf(configured(files, { lockfiles: ['pnpm-lock.yaml', 'contracts/soldeer.lock'], entries })) }), ['src/a.js', 'contracts/src/A.sol'])
})

test("buildVfsBundle takes a lockfile stasis.config.json names above it, its workspace root's, as the one detected", async (t) => {
  const files = {
    'package.json': json({ name: 'root', version: '1.0.0', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
    'pnpm-lock.yaml': pnpmLock({ '.': [], 'apps/p': ['used'] }),
    'apps/p/package.json': manifest('p', ['used']),
    'apps/p/src/a.js': "require('used')\n",
  }
  // Each with a stasis.config.json in apps/p, which roots the bundle there.
  const detected = await buildVfsBundle({ vfs: vfsOf({ ...files, 'apps/p/stasis.config.json': json({}) }), cwd: '/apps/p', entries: ['src/a.js'], cache: store() })
  const named = await buildVfsBundle({ vfs: vfsOf({ ...files, 'apps/p/stasis.config.json': json({ lockfiles: ['../../pnpm-lock.yaml'] }) }), cwd: '/apps/p', entries: ['src/a.js'], cache: store() })
  t.assert.equal(named.bundle.serialize(), detected.bundle.serialize())
  t.assert.equal(named.packageManager, 'pnpm')
  t.assert.deepStrictEqual(named.stats, detected.stats)
  t.assert.equal(named.root, detected.root)
})

test("buildVfsBundle refuses stasis.config.json's lockfiles a tree can't be laid out of, before anything is fetched", async (t) => {
  const refused = async (files, options, message) => {
    const cache = store()
    await t.assert.rejects(buildVfsBundle({ vfs: vfsOf(files), cache, entries: ['src/a.js'], ...options }), message)
    t.assert.deepStrictEqual(cache.calls, [], 'nothing fetched')
  }
  // A lockfile no tree is laid out of (yet).
  await refused(configured({ ...TWO, 'ios/Podfile.lock': 'PODS: []\n' }, { lockfiles: ['pnpm-lock.yaml', 'ios/Podfile.lock'] }), {}, /^Error: buildVfsBundle: stasis\.config\.json's lockfiles names ios\/Podfile\.lock, which is none of pnpm-lock\.yaml, yarn\.lock, package-lock\.json, soldeer\.lock, the lockfiles a tree is laid out from$/u)
  // One above the root, which the Vfs has not: none is taken for it.
  await refused(configured(TWO, { lockfiles: ['pnpm-lock.yaml', '../tools/package-lock.json'] }), {}, /^Error: stasis\.config\.json's lockfiles names \.\.\/tools\/package-lock\.json, which climbs out of \/'s root$/u)
  // One that is not there.
  await refused(configured(TWO, { lockfiles: ['pnpm-lock.yaml', 'web/pnpm-lock.yaml'] }), {}, /^Error: stasis\.config\.json's lockfiles names web\/pnpm-lock\.yaml, which is no file in \/$/u)
  // One its package manager installs its directory from another's: the workspace's.
  const workspace = {
    'package.json': manifest('root'),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'pnpm-lock.yaml': lockfile('.', 'packages/q'),
    'packages/q/package.json': manifest('q'),
    'packages/q/pnpm-lock.yaml': lockfile('.'),
    'src/a.js': '',
  }
  await refused(configured(workspace, { lockfiles: ['pnpm-lock.yaml', 'packages/q/pnpm-lock.yaml'] }), {}, /^Error: stasis\.config\.json's lockfiles names packages\/q\/pnpm-lock\.yaml, but pnpm installs \/packages\/q from \/pnpm-lock\.yaml$/u)
  // Two installing the same node_modules: pnpm's and npm's of one project, and one of a project another's workspace holds.
  await refused(configured({ ...TWO, 'package-lock.json': npmLock('p', ['used']) }, { lockfiles: ['pnpm-lock.yaml', 'package-lock.json'] }), {}, /^Error: stasis\.config\.json's lockfiles names pnpm-lock\.yaml and package-lock\.json, which both install \/node_modules$/u)
  await refused(configured({ ...workspace, 'packages/q/package-lock.json': npmLock('q', []) }, { lockfiles: ['pnpm-lock.yaml', 'packages/q/package-lock.json'] }), {}, /^Error: stasis\.config\.json's lockfiles names pnpm-lock\.yaml and packages\/q\/package-lock\.json, which both install \/packages\/q\/node_modules$/u)
  // A pnpm older than any taken, pinned by the root package.json of its tree.
  await refused(configured({ ...TWO, 'package.json': json({ name: 'p', version: '1.0.0', packageManager: 'pnpm@9.15.0', dependencies: { used: '1.0.0' } }) }, { lockfiles: LOCKFILES }), {}, /^Error: \/package\.json: packageManager: pnpm "9\.15\.0" is not supported: only pnpm 10 and later are$/u)
  // A package manager given, which the lockfiles name in its place.
  await refused(configured(TWO, { lockfiles: LOCKFILES }), { packageManager: 'pnpm' }, /^Error: buildVfsBundle: packageManager is given, and stasis\.config\.json's lockfiles names the lockfiles to lay out$/u)
  // lazy, which a Soldeer tree can't be.
  await refused(configured({ ...TWO, ...under('contracts', SOLDEER) }, { lockfiles: ['pnpm-lock.yaml', 'contracts/soldeer.lock'] }), { lazy: true }, /^Error: buildVfsBundle: lazy is taken with pnpm and npm alone, which lay out a tree from the lockfile alone; soldeer's is not$/u)
  // Malformed.
  await refused(configured(TWO, { lockfiles: [] }), {}, /^TypeError: buildVfsBundle: stasis\.config\.json: lockfiles must be a non-empty array of paths$/u)
})

test("buildGitHubBundle lays out a tree of each lockfile stasis.config.json names, of the whole repo", async (t) => {
  const files = configured(TWO, { lockfiles: LOCKFILES, entries: { 'src/a.js': {}, 'tools/cli.js': {} } })
  const client = fakeClient(files)
  const built = await buildGitHubBundle({ github: GITHUB, sha: SHA, client, cache: store() })
  t.assert.ok(built.bundle.sources.has('tools/node_modules/tool/index.js'))
  t.assert.ok(built.bundle.sources.has('node_modules/.pnpm/used@1.0.0/node_modules/used/index.js'))
  t.assert.deepStrictEqual(built.packageManagers, ['pnpm', 'npm'])
  t.assert.deepStrictEqual(client.calls.map(([method]) => method), ['listRepoDir', 'getRepoTarball'])
  // A directory that stands alone is downloaded alone, and then, its lockfiles named, the whole repo they may climb out of.
  const nested = fakeClient({ 'README.md': 'x\n', ...under('apps/x', files) })
  const alone = await buildGitHubBundle({ github: GITHUB, sha: SHA, client: nested, directory: 'apps/x', cache: store() })
  t.assert.deepStrictEqual([...alone.bundle.sources.keys()].toSorted(), [...built.bundle.sources.keys()].toSorted())
  t.assert.deepStrictEqual({ ...alone.bundle.repo }, { github: GITHUB, directory: 'apps/x', commit: SHA })
  t.assert.deepStrictEqual(nested.calls.map(([method, , , path]) => (method === 'listRepoDir' ? `${method} ${path}` : method)), ['listRepoDir apps/x', 'listRepoDir apps', 'listRepoDir undefined', 'getRepoTreeTarball', 'getRepoTarball'])
  // No lockfile listed, but a stasis.config.json, which may name them: the tree tells.
  const unlisted = configured({ 'package.json': manifest('root'), 'app/package.json': manifest('app'), 'app/pnpm-lock.yaml': lockfile('.'), 'app/b.js': '' }, { lockfiles: ['app/pnpm-lock.yaml'], entries: { 'app/b.js': {} } })
  const told = await buildGitHubBundle({ github: GITHUB, sha: SHA, client: fakeClient(unlisted) })
  t.assert.deepStrictEqual([...told.bundle.entries], ['app/b.js'])
  // ...and where it names none, the tree refuses as the listings would.
  const none = fakeClient({ 'package.json': manifest('p'), 'apps/p/stasis.config.json': json({}), 'apps/p/a.js': '' })
  await t.assert.rejects(buildGitHubBundle({ github: GITHUB, sha: SHA, client: none, directory: 'apps/p', entries: ['a.js'] }), new RegExp(`^Error: buildGitHubBundle: ${GITHUB}@${SHA}: no packageManager given, and none of pnpm-lock\\.yaml, yarn\\.lock, package-lock\\.json, soldeer\\.lock installs /apps/p$`, 'u'))
  t.assert.deepStrictEqual(none.calls.map(([method]) => method), ['listRepoDir', 'listRepoDir', 'listRepoDir', 'getRepoTarball'])
})

test("stasis bundle --deptree lays out the lockfiles stasis.config.json names, of which detection can't tell one", withTmp(async (t, tmp) => {
  const files = {
    'package.json': manifest('p'),
    'pnpm-lock.yaml': lockfile('.'),
    // Another package manager's, which detection can't tell from pnpm's.
    'yarn.lock': '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n',
    'src/a.js': "require('./b.js')\n",
    'src/b.js': '',
    'tools/package.json': manifest('tools'),
    'tools/package-lock.json': npmLock('tools', []),
    'tools/cli.js': '',
  }
  const write = (more) => {
    for (const [rel, text] of Object.entries({ ...files, ...more })) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true })
      writeFileSync(join(tmp, rel), text)
    }
  }
  write({})
  const entries = ['src/a.js', 'tools/cli.js']
  await t.assert.rejects(buildCommandBundle({ cwd: tmp, deptree: true, entries }), /: --deptree lays out the dependencies from a lockfile, and more than one lockfile installs .*: .*\/pnpm-lock\.yaml \(pnpm\), .*\/yarn\.lock \(yarn1\)$/u)
  write({ 'stasis.config.json': json({ lockfiles: ['pnpm-lock.yaml', 'tools/package-lock.json'] }) })
  const bundle = await buildCommandBundle({ cwd: tmp, deptree: true, entries })
  t.assert.deepStrictEqual([...bundle.entries].toSorted(), ['src/a.js', 'tools/cli.js'])
  t.assert.ok(bundle.sources.has('src/b.js'))
}))
