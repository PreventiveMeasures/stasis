import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { withTmp } from './tmp.helper.js'

// `stasis bundle` from disk records each git dependency at the commit the record its package manager
// left in node_modules names: npm's hidden lockfile, pnpm's copy of its lockfile, yarn 1's yarn.lock
// as .yarn-integrity vouches for it; and holds each package to the lockfile beside its node_modules,
// where there is one. Each project here is laid out by hand as the package manager lays one out,
// through a State and through the field resolver.

const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))
const SHA = { dep: 'a'.repeat(40), fork: 'b'.repeat(40), tar: 'c'.repeat(40), lab: 'd'.repeat(40), sub: 'e'.repeat(64), moved: 'f'.repeat(40) }
const BUILDS = [['state', {}], ['resolver', { mainFields: ['main'] }]]

// The project in `dir`, its index.js requiring each of `requires`.
function writeProject(dir, requires) {
  writeJson(join(dir, 'package.json'), { name: 'app', version: '1.0.0' })
  writeFileSync(join(dir, 'index.js'), requires.map((name) => `require('${name}')\n`).join(''))
}

// A package at `at` in `dir`, its package.json `pkg` beside version 1.0.0, its index.js requiring each
// of `requires`.
function writePackage(dir, at, { requires = [], ...pkg }) {
  mkdirSync(join(dir, at), { recursive: true })
  writeJson(join(dir, at, 'package.json'), { version: '1.0.0', ...pkg })
  writeFileSync(join(dir, at, 'index.js'), `${requires.map((name) => `require('${name}')\n`).join('')}module.exports = 1\n`)
}

// Each bucket's repo, by its dir, of `stasis bundle` with `options` in `dir`, written to `label`.br.
async function bundled(dir, label, options = {}) {
  await bundleCommand({ cwd: dir, entries: ['index.js'], output: `${label}.br`, ...options })
  return Object.fromEntries(Object.entries(modulesOf(dir, label)).map(([at, { repo }]) => [at, repo]))
}

// The records of the bundle `stasis bundle` wrote to `label`.br in `dir`, by their dirs.
const modulesOf = (dir, label) => JSON.parse(brotliDecompressSync(readFileSync(join(dir, `${label}.br`))).toString('utf8')).modules

// [label, bundled()] of each of BUILDS.
const bundledEach = (dir) => Promise.all(BUILDS.map(async ([label, options]) => [label, await bundled(dir, label, options)]))

// A sha512 integrity, as a lockfile locks a tarball with.
const SRI = `sha512-${'A'.repeat(86)}==`

test("npm: the hidden lockfile's `resolved` names a git dependency's repository and commit, by its location", withTmp(async (t, dir) => {
  writeProject(dir, ['dep', 'fork', 'reg', 'lab', 'short', 'stale'])
  writePackage(dir, 'node_modules/dep', { name: 'dep', repository: 'github:o/dep', requires: ['tar'] })
  writePackage(dir, 'node_modules/dep/node_modules/tar', { name: 'tar' })
  writePackage(dir, 'node_modules/fork', { name: 'fork', repository: { url: 'git+https://github.com/upstream/fork.git', directory: 'packages/fork' } })
  writePackage(dir, 'node_modules/reg', { name: 'reg', repository: 'github:o/reg' })
  writePackage(dir, 'node_modules/lab', { name: 'lab', repository: 'github:o/lab' })
  writePackage(dir, 'node_modules/short', { name: 'short' })
  writePackage(dir, 'node_modules/stale', { name: 'stale' })
  writeJson(join(dir, 'node_modules', '.package-lock.json'), {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      'node_modules/dep': { version: '1.0.0', resolved: `git+ssh://git@github.com/o/dep.git#${SHA.dep}`, dependencies: { tar: 'github:o/tar' } },
      'node_modules/dep/node_modules/tar': { version: '1.0.0', resolved: `https://codeload.github.com/o/tar/tar.gz/${SHA.tar}`, integrity: `sha512-${'A'.repeat(86)}==` },
      'node_modules/fork': { version: '1.0.0', resolved: `git+https://github.com/me/fork.git#${SHA.fork}` },
      'node_modules/reg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/reg/-/reg-1.0.0.tgz', integrity: `sha512-${'A'.repeat(86)}==` },
      'node_modules/lab': { version: '1.0.0', resolved: `git+ssh://git@gitlab.com/o/lab.git#${SHA.lab}` },
      'node_modules/short': { version: '1.0.0', resolved: 'git+ssh://git@github.com/o/short.git#abc1234' },
      'node_modules/stale': { version: '2.0.0', resolved: `git+ssh://git@github.com/o/stale.git#${SHA.dep}` },
    },
  })
  for (const [label, repos] of await bundledEach(dir)) {
    t.assert.deepStrictEqual(repos['node_modules/dep'], { github: 'o/dep', directory: '', commit: SHA.dep }, `${label}: a git dependency, at the repository's root`)
    t.assert.deepStrictEqual(repos['node_modules/dep/node_modules/tar'], { github: 'o/tar', directory: '', commit: SHA.tar }, `${label}: GitHub's tarball of a commit, nested`)
    t.assert.deepStrictEqual(repos['node_modules/fork'], { github: 'me/fork', directory: '', commit: SHA.fork }, `${label}: the repository installed from, not the one its package.json names`)
    t.assert.deepStrictEqual(repos['node_modules/reg'], { github: 'o/reg' }, `${label}: a registry package, as its package.json has it`)
    t.assert.deepStrictEqual(repos['node_modules/lab'], { github: 'o/lab' }, `${label}: another host's repository, no commit`)
    t.assert.equal(repos['node_modules/short'], undefined, `${label}: an abbreviated commit, none`)
    t.assert.equal(repos['node_modules/stale'], undefined, `${label}: a record of another version, none`)
  }
  t.assert.deepStrictEqual(['node_modules/reg', 'node_modules/dep/node_modules/tar', 'node_modules/dep'].map((at) => modulesOf(dir, 'state')[at].integrity), [SRI, SRI, undefined], 'the integrity it names')
}))

test('a Solidity bundle records its npm git dependencies at their commits, and holds them to the lockfile beside them, as a JS bundle does', withTmp(async (t, dir) => {
  cpSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'solidity-bundle', 'with-node-modules'), dir, { recursive: true })
  const lock = (commit) => ({ name: 'my-app', version: '0.1.0', lockfileVersion: 3, requires: true, packages: {
    'node_modules/foo': { version: '1.2.3', resolved: `git+ssh://git@github.com/o/foo.git#${commit}` },
    'node_modules/@oz/contracts': { version: '5.0.0', resolved: 'https://registry.npmjs.org/@oz/contracts/-/contracts-5.0.0.tgz', integrity: SRI },
  } })
  const build = () => bundleCommand({ cwd: dir, entries: ['src/A.sol'], mappingFile: 'remappings.txt', output: 'out.br' })
  writeJson(join(dir, 'node_modules', '.package-lock.json'), lock(SHA.dep))
  await build()
  const { modules } = JSON.parse(brotliDecompressSync(readFileSync(join(dir, 'out.br'))).toString('utf8'))
  t.assert.deepStrictEqual(modules['node_modules/foo'].repo, { github: 'o/foo', directory: '', commit: SHA.dep })
  writeJson(join(dir, 'package-lock.json'), lock(SHA.fork))
  await t.assert.rejects(build(), new RegExp(`package-lock\\.json doesn't lock node_modules/foo as installed \\(at o/foo@${SHA.dep}; it locks o/foo@${SHA.fork}\\)`, 'u'))
}))

// As yarn 1 writes them: yarn.lock's header, and .yarn-integrity's resolution of each pattern.
const YARN_LOCK = '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n'
const integrity = (lockfileEntries) => ({ systemParams: 'linux-x64-137', modulesFolders: ['node_modules'], flags: ['ignoreScripts'], linkedModules: [], topLevelPatterns: Object.keys(lockfileEntries), lockfileEntries, files: [], artifacts: {} })

test("yarn 1: yarn.lock names a git dependency's repository and commit, by its name and version, where .yarn-integrity has it installed so", withTmp(async (t, dir) => {
  writeProject(dir, ['dep', 'gh', 'reg', 'dup', 'lab', 'short'])
  writePackage(dir, 'node_modules/dep', { name: 'dep', repository: 'github:o/elsewhere', requires: ['dup'] })
  writePackage(dir, 'node_modules/dep/node_modules/dup', { name: 'dup', repository: 'github:o/dup' })
  writePackage(dir, 'node_modules/dup', { name: 'dup', repository: 'github:o/dup' })
  writePackage(dir, 'node_modules/gh', { name: 'gh' })
  writePackage(dir, 'node_modules/reg', { name: 'reg', repository: 'github:o/reg' })
  writePackage(dir, 'node_modules/lab', { name: 'lab' })
  writePackage(dir, 'node_modules/short', { name: 'short' })
  const sha1 = '0'.repeat(40)
  const entries = [
    ['"dep@git+https://github.com/o/dep.git"', `git+https://github.com/o/dep.git#${SHA.dep}`, '  dependencies:\n    dup "git+https://github.com/me/dup.git"\n'],
    ['"dup@git+https://github.com/me/dup.git"', `git+https://github.com/me/dup.git#${SHA.lab}`],
    ['"dup@git+https://github.com/o/dup.git"', `git+https://github.com/o/dup.git#${SHA.fork}`],
    ['"gh@github:o/gh"', `https://codeload.github.com/o/gh/tar.gz/${SHA.tar}`],
    ['reg@^1.0.0', `https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#${sha1}`],
    ['"lab@git+https://gitlab.com/o/lab.git"', `git+https://gitlab.com/o/lab.git#${SHA.lab}`],
    ['"short@https://codeload.github.com/o/short/tar.gz/abc1234"', `https://codeload.github.com/o/short/tar.gz/abc1234#${sha1}`],
  ]
  writeFileSync(join(dir, 'yarn.lock'), YARN_LOCK + entries.map(([key, resolved, rest = '']) => `${key}:\n  version "1.0.0"\n  resolved "${resolved}"\n${rest}`).join('\n'))
  const installed = Object.fromEntries(entries.map(([key, resolved]) => [JSON.parse(key.startsWith('"') ? key : `"${key}"`), resolved]))
  writeJson(join(dir, 'node_modules', '.yarn-integrity'), integrity(installed))
  for (const [label, repos] of await bundledEach(dir)) {
    t.assert.deepStrictEqual(repos['node_modules/dep'], { github: 'o/dep', directory: '', commit: SHA.dep }, `${label}: a git dependency, in the repository installed from`)
    t.assert.deepStrictEqual(repos['node_modules/gh'], { github: 'o/gh', directory: '', commit: SHA.tar }, `${label}: GitHub's tarball of a commit`)
    t.assert.deepStrictEqual(repos['node_modules/reg'], { github: 'o/reg' }, `${label}: a registry package, as its package.json has it`)
    t.assert.deepStrictEqual(repos['node_modules/dup'], { github: 'o/dup' }, `${label}: two git dependencies of one name and version, either the one installed: none`)
    t.assert.deepStrictEqual(repos['node_modules/dep/node_modules/dup'], { github: 'o/dup' }, `${label}: for neither`)
    t.assert.equal(repos['node_modules/lab'], undefined, `${label}: another host's repository, none`)
    t.assert.equal(repos['node_modules/short'], undefined, `${label}: an abbreviated commit, none`)
  }
  // Installed at the commit yarn.lock had before it moved the dependency to another.
  writeJson(join(dir, 'node_modules', '.yarn-integrity'), integrity({ ...installed, 'dep@git+https://github.com/o/dep.git': `git+https://github.com/o/dep.git#${SHA.moved}` }))
  await t.assert.rejects(bundled(dir, 'moved'), new RegExp(`yarn\\.lock doesn't lock node_modules/dep as installed \\(installed from git\\+https://github\\.com/o/dep\\.git#${SHA.moved}; it locks git\\+https://github\\.com/o/dep\\.git#${SHA.dep}\\)`, 'u'), 'a yarn.lock changed since the install')
}))

// A project pnpm installed `packages` into, as it installs each: in node_modules/.pnpm/<store>/
// node_modules/<name>, linked into the project's node_modules, its snapshot in the lockfile
// node_modules/.pnpm/lock.yaml copies; one from the registry with no version of its own there; one
// patched with its `patch`, its key naming its hash, as its snapshot's key alone does.
function writePnpmProject(dir, packages) {
  writeProject(dir, packages.map(({ name }) => name))
  for (const { name, store, pkg } of packages) {
    writePackage(dir, `node_modules/.pnpm/${store}/node_modules/${name}`, { name, ...pkg })
    symlinkSync(`.pnpm/${store}/node_modules/${name}`, join(dir, 'node_modules', name))
  }
  const importer = packages.map(({ name, key }) => `      ${name}:\n        specifier: x\n        version: '${key.slice(name.length + 1)}'\n`)
  const id = (key) => key.replace(/\(patch_hash=[\da-f]+\)$/u, '')
  const snapshots = packages.map(({ key, resolution }) => `  '${id(key)}':\n    resolution: ${resolution}\n${resolution.startsWith('{integrity') ? '' : '    version: 1.0.0\n'}`)
  const patched = packages.filter(({ patch }) => patch).map(({ key, patch }) => `  ${id(key)}:\n    hash: ${patch}\n    path: patches/${id(key)}.patch\n`)
  writeFileSync(join(dir, 'node_modules', '.pnpm', 'lock.yaml'), `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
${patched.length === 0 ? '' : `\npatchedDependencies:\n${patched.join('')}`}
importers:

  .:
    dependencies:
${importer.join('')}
packages:

${snapshots.join('\n')}
snapshots:

${packages.map(({ key }) => `  '${key}': {}\n`).join('\n')}`)
}

// Its commit and repository, a capital in its key, as pnpm 10.33.4 installs it.
const XTEND = '4e34185527a9cb93ec5651ca0f70c198df19faa0'
const xtend = (store) => ({ name: 'xtend', key: `xtend@git+https://git@github.com:Raynos/xtend.git#${XTEND}`, store, resolution: `{commit: ${XTEND}, repo: 'git@github.com:Raynos/xtend.git', type: git}` })

test("pnpm: its copy of the lockfile names a git dependency's repository, commit and path, by the directory pnpm 10 installs it in", withTmp(async (t, dir) => {
  writePnpmProject(dir, [
    { name: 'dep', key: `dep@git+https://git@github.com:o/dep.git#${SHA.dep}`, store: `dep@git+https+++git@github.com+o+dep.git+${SHA.dep}`, resolution: `{commit: ${SHA.dep}, repo: 'git@github.com:o/dep.git', type: git}`, pkg: { repository: 'github:o/elsewhere' } },
    { name: 'sub', key: `sub@https://codeload.github.com/o/mono/tar.gz/${SHA.sub}#path:/packages/sub`, store: `sub@https+++codeload.github.com+o+mono+tar.gz+${SHA.sub}+path++packages+sub`, resolution: `{path: /packages/sub, tarball: 'https://codeload.github.com/o/mono/tar.gz/${SHA.sub}'}` },
    // Cut short, and a SHA-256 of it.
    xtend('xtend@git+https+++git@github.com+Raynos+xtend.git+4e34185527a9cb93ec5651ca0f70c198df19f_4ead222ae5cf13da0fd1048f2c447bd5'),
    { name: 'reg', key: 'reg@1.0.0', store: 'reg@1.0.0', resolution: `{integrity: sha512-${'A'.repeat(86)}==}`, pkg: { repository: 'github:o/reg' } },
    { name: 'lab', key: `lab@git+https://gitlab.com/o/lab.git#${SHA.lab}`, store: `lab@git+https+++gitlab.com+o+lab.git+${SHA.lab}`, resolution: `{commit: ${SHA.lab}, repo: 'https://gitlab.com/o/lab.git', type: git}` },
    { name: 'short', key: 'short@https://codeload.github.com/o/short/tar.gz/abc1234', store: 'short@https+++codeload.github.com+o+short+tar.gz+abc1234', resolution: "{tarball: 'https://codeload.github.com/o/short/tar.gz/abc1234'}" },
  ])
  for (const [label, byDir] of await bundledEach(dir)) {
    // By name: a State's bucket is where the package is, the field resolver's where it is linked.
    const repos = Object.fromEntries(Object.entries(byDir).map(([at, repo]) => [at.slice(at.lastIndexOf('/') + 1), repo]))
    t.assert.deepStrictEqual(repos.dep, { github: 'o/dep', directory: '', commit: SHA.dep }, `${label}: a git dependency, in the repository installed from`)
    t.assert.deepStrictEqual(repos.sub, { github: 'o/mono', directory: 'packages/sub', commit: SHA.sub }, `${label}: GitHub's tarball of a commit, at its path`)
    t.assert.deepStrictEqual(repos.xtend, { github: 'Raynos/xtend', directory: '', commit: XTEND }, `${label}: in a directory pnpm names by a hash`)
    t.assert.deepStrictEqual(repos.reg, { github: 'o/reg' }, `${label}: a registry package, as its package.json has it`)
    t.assert.equal(repos.lab, undefined, `${label}: another host's repository, none`)
    t.assert.equal(repos.short, undefined, `${label}: an abbreviated commit, none`)
  }
}))

test("pnpm: pnpm 9's store directories are not read", withTmp(async (t, dir) => {
  writePnpmProject(dir, [
    { name: 'dep', key: `dep@git+https://git@github.com:o/dep.git#${SHA.dep}`, store: `dep@git+https+++git@github.com+o+dep.git#${SHA.dep}`, resolution: `{commit: ${SHA.dep}, repo: 'git@github.com:o/dep.git', type: git}`, pkg: { repository: 'github:o/dep' } },
    xtend(`xtend@git+https+++git@github.com+Raynos+xtend.git#${XTEND}_566luz3wrwstne6n4ddwqdopme`),
  ])
  const repos = await bundled(dir, 'state')
  t.assert.deepStrictEqual(repos[`node_modules/.pnpm/dep@git+https+++git@github.com+o+dep.git#${SHA.dep}/node_modules/dep`], { github: 'o/dep' })
  t.assert.equal(repos[`node_modules/.pnpm/xtend@git+https+++git@github.com+Raynos+xtend.git#${XTEND}_566luz3wrwstne6n4ddwqdopme/node_modules/xtend`], undefined)
}))


test('pnpm: a git dependency with peers, by the directory its snapshot key names, peers and all', withTmp(async (t, dir) => {
  // The lockfile keys a package by its id in `packages`, and by its peers too in `snapshots`, whose
  // key pnpm names the directory after: `(peer@1.0.0)` made `_peer@1.0.0`.
  const key = `lib@https://codeload.github.com/o/lib/tar.gz/${SHA.tar}`
  const store = `lib@https+++codeload.github.com+o+lib+tar.gz+${SHA.tar}_peer@1.0.0`
  writeProject(dir, ['lib'])
  writePackage(dir, `node_modules/.pnpm/${store}/node_modules/lib`, { name: 'lib', peerDependencies: { peer: '^1.0.0' } })
  symlinkSync(`.pnpm/${store}/node_modules/lib`, join(dir, 'node_modules', 'lib'))
  writeFileSync(join(dir, 'node_modules', '.pnpm', 'lock.yaml'), [
    "lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '',
    'importers:', '', '  .:', '    dependencies:',
    '      lib:', '        specifier: x', `        version: '${key.slice('lib@'.length)}(peer@1.0.0)'`,
    '      peer:', '        specifier: 1.0.0', '        version: 1.0.0', '',
    'packages:', '',
    `  '${key}':`, `    resolution: {tarball: 'https://codeload.github.com/o/lib/tar.gz/${SHA.tar}'}`, '    version: 1.0.0', '    peerDependencies:', '      peer: ^1.0.0', '',
    '  peer@1.0.0:', `    resolution: {integrity: sha512-${'A'.repeat(86)}==}`, '',
    'snapshots:', '',
    `  '${key}(peer@1.0.0)':`, '    dependencies:', '      peer: 1.0.0', '',
    '  peer@1.0.0: {}', '',
  ].join('\n'))
  for (const [label, byDir] of await bundledEach(dir)) {
    const repos = Object.fromEntries(Object.entries(byDir).map(([at, repo]) => [at.slice(at.lastIndexOf('/') + 1), repo]))
    t.assert.deepStrictEqual(repos.lib, { github: 'o/lib', directory: '', commit: SHA.tar }, label)
  }
}))

test('npm: a project beneath a directory named node_modules is found by its own record, never one outside it', withTmp(async (t, tmp) => {
  const dir = join(tmp, 'node_modules', 'app')
  mkdirSync(dir, { recursive: true })
  writeProject(dir, ['dep'])
  writePackage(dir, 'node_modules/dep', { name: 'dep' })
  // A record outside the project, of the directory above it, naming it at another commit.
  writeJson(join(tmp, 'node_modules', '.package-lock.json'), { lockfileVersion: 3, packages: { 'node_modules/app/node_modules/dep': { version: '1.0.0', resolved: `git+ssh://git@github.com/o/outer.git#${SHA.fork}` } } })
  for (const [label, byDir] of await bundledEach(dir)) t.assert.equal(byDir['node_modules/dep'], undefined, `${label}: no record of its own, none`)
  writeJson(join(dir, 'node_modules', '.package-lock.json'), { lockfileVersion: 3, packages: { 'node_modules/dep': { version: '1.0.0', resolved: `git+ssh://git@github.com/o/dep.git#${SHA.dep}` } } })
  for (const [label, byDir] of await bundledEach(dir)) t.assert.deepStrictEqual(byDir['node_modules/dep'], { github: 'o/dep', directory: '', commit: SHA.dep }, `${label}: its own`)
}))

test("npm's and yarn's records: one missing or unreadable, or both at once, records nothing, and fails no build; a yarn.lock that can't be read does", withTmp(async (t, dir) => {
  writeProject(dir, ['dep'])
  writePackage(dir, 'node_modules/dep', { name: 'dep', repository: 'github:o/dep' })
  const npm = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/dep': { version: '1.0.0', resolved: `git+ssh://git@github.com/o/dep.git#${SHA.dep}` } } })
  const yarn = `${YARN_LOCK}"dep@git+https://github.com/o/dep.git":\n  version "1.0.0"\n  resolved "git+https://github.com/o/dep.git#${SHA.dep}"\n`
  const yarnIntegrity = JSON.stringify(integrity({ 'dep@git+https://github.com/o/dep.git': `git+https://github.com/o/dep.git#${SHA.dep}` }))
  const pinned = { github: 'o/dep', directory: '', commit: SHA.dep }
  const layouts = [
    ["npm's", { 'node_modules/.package-lock.json': npm }, pinned],
    ["yarn's", { 'node_modules/.yarn-integrity': yarnIntegrity, 'yarn.lock': yarn }, pinned],
    ['none', {}],
    ['an unreadable hidden lockfile', { 'node_modules/.package-lock.json': '{"packages":' }],
    ['a hidden lockfile of no packages', { 'node_modules/.package-lock.json': '{"packages":[1]}' }],
    ['an unreadable .yarn-integrity', { 'node_modules/.yarn-integrity': '{', 'yarn.lock': yarn }],
    ['yarn.lock alone', { 'yarn.lock': yarn }],
    ["npm's and yarn's", { 'node_modules/.package-lock.json': npm, 'node_modules/.yarn-integrity': yarnIntegrity, 'yarn.lock': yarn }],
  ]
  for (const [i, [label, files, repo = { github: 'o/dep' }]] of layouts.entries()) {
    for (const file of ['node_modules/.package-lock.json', 'node_modules/.yarn-integrity', 'yarn.lock']) rmSync(join(dir, file), { force: true })
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
    // eslint-disable-next-line no-await-in-loop -- each build reads the records the one before it left
    t.assert.deepStrictEqual((await bundled(dir, `b${i}`))['node_modules/dep'], repo, label)
  }
  writeFileSync(join(dir, 'yarn.lock'), yarn.replace('# THIS', '# this'))
  await t.assert.rejects(bundled(dir, 'unreadable'), /yarn\.lock: expected yarn's header/u, 'a yarn.lock yarn would not write')
}))

test("pnpm's lockfile copy missing or unreadable records nothing, and fails no build", withTmp(async (t, dir) => {
  writePnpmProject(dir, [{ name: 'dep', key: `dep@git+https://git@github.com:o/dep.git#${SHA.dep}`, store: `dep@git+https+++git@github.com+o+dep.git+${SHA.dep}`, resolution: `{commit: ${SHA.dep}, repo: 'git@github.com:o/dep.git', type: git}`, pkg: { repository: 'github:o/dep' } }])
  const lock = join(dir, 'node_modules', '.pnpm', 'lock.yaml')
  const text = readFileSync(lock, 'utf8')
  const cases = [['read', text, { github: 'o/dep', directory: '', commit: SHA.dep }], ['unreadable', text.replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'")], ['missing', null]]
  for (const [label, written, repo = { github: 'o/dep' }] of cases) {
    rmSync(lock, { force: true })
    if (written !== null) writeFileSync(lock, written)
    // eslint-disable-next-line no-await-in-loop -- each build reads the lockfile copy the one before it left
    t.assert.deepStrictEqual(Object.values(await bundled(dir, label)).filter(Boolean), [repo], label)
  }
}))

test("pnpm and npm: the record of what they installed is held to the project's lockfile beside it, where there is one", withTmp(async (t, dir) => {
  writePnpmProject(dir, [
    { name: 'plain', key: 'plain@1.0.0', store: 'plain@1.0.0', resolution: `{integrity: ${SRI}}` },
    { name: 'dep', key: `dep@git+https://git@github.com:o/dep.git#${SHA.dep}`, store: `dep@git+https+++git@github.com+o+dep.git+${SHA.dep}`, resolution: `{commit: ${SHA.dep}, repo: 'git@github.com:o/dep.git', type: git}`, pkg: { repository: 'github:o/elsewhere' } },
  ])
  const installed = readFileSync(join(dir, 'node_modules', '.pnpm', 'lock.yaml'), 'utf8')
  const build = () => bundleCommand({ cwd: dir, entries: ['index.js'], output: 'out.br' })
  writeFileSync(join(dir, 'pnpm-lock.yaml'), installed)
  for (const [label, byDir] of await bundledEach(dir)) {
    const repos = Object.fromEntries(Object.entries(byDir).map(([at, repo]) => [at.slice(at.lastIndexOf('/') + 1), repo]))
    t.assert.deepStrictEqual(repos.dep, { github: 'o/dep', directory: '', commit: SHA.dep }, `${label}: as it locks it, at the commit installed`)
  }
  for (const [lockfile, differs] of [
    [installed.replace(`{commit: ${SHA.dep},`, `{commit: ${SHA.fork},`), `at o/dep@${SHA.dep}; it locks o/dep@${SHA.fork}`],
    [installed.replaceAll('plain@1.0.0', 'plain@1.0.1').replace("version: '1.0.0'", "version: '1.0.1'"), 'it locks none there'],
  ]) {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lockfile)
    // eslint-disable-next-line no-await-in-loop -- one lockfile at a time
    await t.assert.rejects(build(), (err) => err.message.includes(`pnpm-lock.yaml doesn't lock `) && err.message.endsWith(`as installed (${differs}): install from it again`), differs)
  }
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'not: [a lockfile')
  await t.assert.rejects(build(), /pnpm-lock\.yaml: /u, 'one that can\'t be read stops the build')

  const npm = join(dir, 'npm')
  mkdirSync(npm)
  writeProject(npm, ['reg'])
  writePackage(npm, 'node_modules/reg', { name: 'reg' })
  const lock = (entry) => ({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { 'node_modules/reg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/reg/-/reg-1.0.0.tgz', integrity: SRI, ...entry } } })
  writeJson(join(npm, 'node_modules', '.package-lock.json'), lock())
  const npmBuild = () => bundleCommand({ cwd: npm, entries: ['index.js'], output: 'out.br' })
  writeJson(join(npm, 'package-lock.json'), lock())
  await npmBuild()
  for (const [entry, differs] of [[{ resolved: `git+ssh://git@github.com/o/reg.git#${SHA.dep}` }, `at none; it locks o/reg@${SHA.dep}`], [{ version: '2.0.0' }, '1.0.0; it locks 2.0.0']]) {
    writeJson(join(npm, 'package-lock.json'), lock(entry))
    // eslint-disable-next-line no-await-in-loop -- one lockfile at a time
    await t.assert.rejects(npmBuild(), (err) => err.message.includes('package-lock.json doesn\'t lock ') && err.message.includes(`node_modules/reg as installed (${differs})`), differs)
  }
  writeFileSync(join(npm, 'package-lock.json'), '{"packages":')
  await t.assert.rejects(npmBuild(), /package-lock\.json: /u, 'one that can\'t be read stops the build')
}))

// An npm project in `dir` requiring `reg` and each of `installed`, at the version it gives (else
// 1.0.0); its hidden lockfile (unless null) and package-lock.json (where `packageLock`) each locking
// `reg` and those it names, at 1.0.0 from the registry, or as it gives.
function npmProject(dir, { lock = {}, hidden = lock, installed = {}, packageLock = true } = {}) {
  const names = Object.keys({ reg: {}, ...installed })
  mkdirSync(dir, { recursive: true })
  writeProject(dir, names)
  for (const name of names) writePackage(dir, `node_modules/${name}`, { name, version: installed[name] ?? '1.0.0' })
  const of = (entries) => ({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: Object.fromEntries(Object.entries({ reg: {}, ...entries }).map(([name, more]) => [`node_modules/${name}`, { version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, ...more }])) })
  if (hidden !== null) writeJson(join(dir, 'node_modules', '.package-lock.json'), of(hidden))
  if (packageLock) writeJson(join(dir, 'package-lock.json'), of(lock))
}
const build = (dir) => bundleCommand({ cwd: dir, entries: ['index.js'], output: 'out.br' })

test('a package installed otherwise than the lockfile beside it locks it stops a disk build, whatever its install record says', withTmp(async (t, dir) => {
  const at = (name) => join(dir, name)
  // Its package.json of another version than both lockfiles.
  npmProject(at('a'), { installed: { reg: '1.0.1' } })
  await t.assert.rejects(build(at('a')), /package-lock\.json doesn't lock node_modules\/reg as installed \(1\.0\.1; it locks 1\.0\.0\): install from it again$/u)
  // A package neither records.
  npmProject(at('b'), { installed: { stray: '1.0.0' }, lock: {}, hidden: {} })
  await t.assert.rejects(build(at('b')), /package-lock\.json doesn't lock node_modules\/stray as installed \(it locks none there\)/u)
  // No hidden lockfile: package-lock.json alone.
  npmProject(at('c'), { installed: { reg: '1.0.1' }, hidden: null })
  await t.assert.rejects(build(at('c')), /package-lock\.json doesn't lock node_modules\/reg as installed \(1\.0\.1; it locks 1\.0\.0\)/u)
  // npm-shrinkwrap.json, over package-lock.json.
  npmProject(at('s'), { installed: { reg: '1.0.1' }, lock: { reg: { version: '1.0.1' } } })
  await build(at('s'))
  cpSync(at('a/package-lock.json'), at('s/npm-shrinkwrap.json'))
  await t.assert.rejects(build(at('s')), /npm-shrinkwrap\.json doesn't lock node_modules\/reg as installed \(1\.0\.1; it locks 1\.0\.0\)/u)
  // yarn 1: yarn.lock.
  npmProject(at('d'), { installed: { reg: '1.0.1' }, hidden: null, packageLock: false })
  writeFileSync(at('d/yarn.lock'), `${YARN_LOCK}reg@1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#${'0'.repeat(40)}"\n  integrity ${SRI}\n`)
  await t.assert.rejects(build(at('d')), /yarn\.lock doesn't lock node_modules\/reg as installed \(1\.0\.1; it locks none\)/u)
  // pnpm's hoisted layout: pnpm-lock.yaml.
  npmProject(at('e'), { installed: { reg: '1.0.1' }, hidden: null, packageLock: false })
  writeFileSync(at('e/node_modules/.modules.yaml'), 'nodeLinker: hoisted\npackageManager: pnpm@10.33.4\n')
  writeFileSync(at('e/pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      reg:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  reg@1.0.0:\n    resolution: {integrity: ${SRI}}\n\nsnapshots:\n\n  reg@1.0.0: {}\n`)
  await t.assert.rejects(build(at('e')), /pnpm-lock\.yaml doesn't lock node_modules\/reg as installed \(1\.0\.1; it locks 1\.0\.0\)/u)
  // A git dependency installed at another commit than it locks.
  const git = (commit) => ({ resolved: `git+ssh://git@github.com/o/reg.git#${commit}` })
  npmProject(at('f'), { lock: { reg: git(SHA.fork) }, hidden: { reg: git(SHA.dep) } })
  await t.assert.rejects(build(at('f')), new RegExp(`package-lock\\.json doesn't lock node_modules/reg as installed \\(at o/reg@${SHA.dep}; it locks o/reg@${SHA.fork}\\)`, 'u'))
}))

test("a disk build holds an alias by its package's own name, reads past a lockfile's byte order mark, and stops at one that can't be read", withTmp(async (t, dir) => {
  const at = (...parts) => join(dir, ...parts)
  // pnpm, hoisted: helmet, an alias of ms@2.1.3.
  mkdirSync(at('a'))
  writeProject(at('a'), ['helmet'])
  writePackage(at('a'), 'node_modules/helmet', { name: 'ms', version: '2.1.3' })
  writeFileSync(at('a/node_modules/.modules.yaml'), 'nodeLinker: hoisted\npackageManager: pnpm@10.33.4\n')
  writeFileSync(at('a/pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      helmet:\n        specifier: npm:ms@2.1.3\n        version: ms@2.1.3\n\npackages:\n\n  ms@2.1.3:\n    resolution: {integrity: ${SRI}}\n\nsnapshots:\n\n  ms@2.1.3: {}\n`)
  await build(at('a'))
  // pnpm, hoisted: a directory, of no version locked, under its own name and under the one an
  // override installs it as.
  const directory = (as, key) => `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      ${as}:\n        specifier: file:local-ms\n        version: ${key}\n\npackages:\n\n  ms-fork@file:local-ms:\n    resolution: {directory: local-ms, type: directory}\n\nsnapshots:\n\n  ms-fork@file:local-ms: {}\n`
  for (const [as, key] of [['ms-fork', 'file:local-ms'], ['ms', 'ms-fork@file:local-ms']]) {
    const project = at(`dir-${as}`)
    mkdirSync(project)
    writeProject(project, [as])
    writePackage(project, `node_modules/${as}`, { name: 'ms-fork', version: '2.0.0' })
    writeFileSync(join(project, 'node_modules', '.modules.yaml'), 'nodeLinker: hoisted\npackageManager: pnpm@10.33.4\n')
    writeFileSync(join(project, 'pnpm-lock.yaml'), directory(as, key))
    // eslint-disable-next-line no-await-in-loop -- one project at a time
    await build(project)
  }
  // npm: a package-lock.json starting with a byte order mark, then one that can't be read.
  npmProject(at('b'))
  writeFileSync(at('b/package-lock.json'), `\uFEFF${readFileSync(at('b/package-lock.json'), 'utf8')}`)
  await build(at('b'))
  rmSync(at('b/package-lock.json'))
  mkdirSync(at('b/package-lock.json'))
  await t.assert.rejects(build(at('b')), /package-lock\.json: can't be read$/u)
}))

test("pnpm, hoisted: its copy of the lockfile names a git dependency's repository and commit, by its name and version, held to pnpm-lock.yaml", withTmp(async (t, dir) => {
  writeProject(dir, ['dep'])
  writePackage(dir, 'node_modules/dep', { name: 'dep', repository: 'github:o/elsewhere' })
  writeFileSync(join(dir, 'node_modules', '.modules.yaml'), 'nodeLinker: hoisted\npackageManager: pnpm@10.33.4\n')
  const key = `dep@git+https://git@github.com:o/dep.git#${SHA.dep}`
  const lockfile = (commit) => `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      dep:\n        specifier: x\n        version: '${key.slice('dep@'.length)}'\n\npackages:\n\n  '${key}':\n    resolution: {commit: ${commit}, repo: 'git@github.com:o/dep.git', type: git}\n    version: 1.0.0\n\nsnapshots:\n\n  '${key}': {}\n`
  mkdirSync(join(dir, 'node_modules', '.pnpm'))
  writeFileSync(join(dir, 'node_modules', '.pnpm', 'lock.yaml'), lockfile(SHA.dep))
  const pinned = { github: 'o/dep', directory: '', commit: SHA.dep }
  for (const [label, repos] of await bundledEach(dir)) t.assert.deepStrictEqual(repos['node_modules/dep'], pinned, `${label}: no pnpm-lock.yaml`)
  writeFileSync(join(dir, 'pnpm-lock.yaml'), lockfile(SHA.dep))
  for (const [label, repos] of await bundledEach(dir)) t.assert.deepStrictEqual(repos['node_modules/dep'], pinned, `${label}: as pnpm-lock.yaml locks it`)
  writeFileSync(join(dir, 'pnpm-lock.yaml'), lockfile(SHA.fork))
  await t.assert.rejects(build(dir), new RegExp(`pnpm-lock\\.yaml doesn't lock node_modules/dep as installed \\(at o/dep@${SHA.dep}; it locks o/dep@${SHA.fork}\\)`, 'u'))
}))

test('of two lockfiles beside a node_modules, a package is held to the one whose package manager alone left its record there, else the build stops', withTmp(async (t, dir) => {
  const both = /: package-lock\.json and yarn\.lock are both there, and which installed its node_modules isn't known$/u
  npmProject(dir)
  // A yarn.lock beside package-lock.json, locking none of it.
  writeFileSync(join(dir, 'yarn.lock'), YARN_LOCK)
  await build(dir)
  writeJson(join(dir, 'node_modules', '.yarn-integrity'), integrity({}))
  await t.assert.rejects(build(dir), both, "npm's and yarn's records both there")
  rmSync(join(dir, 'node_modules', '.package-lock.json'))
  await t.assert.rejects(build(dir), /yarn\.lock doesn't lock node_modules\/reg as installed \(1\.0\.0; it locks none\)/u, "yarn's alone")
  rmSync(join(dir, 'node_modules', '.yarn-integrity'))
  await t.assert.rejects(build(dir), both, 'neither record there')
}))

const PATCH_TEXT = 'diff --git a/index.js b/index.js\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1\n+module.exports = 2\n'
const PATCH = createHash('sha256').update(PATCH_TEXT).digest('hex')
const PATCHED = { integrity: `sha256-${Buffer.from(PATCH, 'hex').toString('base64')}`, file: 'patches/reg@1.0.0.patch' }
const OWN = { ...PATCHED, file: 'patches/own.patch' }
// pnpm's copy of its lockfile and the pnpm-lock.yaml beside node_modules, both of its text `edit`ed; -> the text.
function relock(dir, edit) {
  const files = [join(dir, 'node_modules', '.pnpm', 'lock.yaml'), join(dir, 'pnpm-lock.yaml')]
  const text = edit(readFileSync(files[0], 'utf8'))
  for (const file of files) writeFileSync(file, text)
  return text
}
function patchedProject(dir, edit = (text) => text) {
  writePnpmProject(dir, [
    { name: 'reg', key: `reg@1.0.0(patch_hash=${PATCH})`, store: `reg@1.0.0_patch_hash=${PATCH}`, resolution: `{integrity: ${SRI}}`, patch: PATCH },
    { name: 'plain', key: 'plain@1.0.0', store: 'plain@1.0.0', resolution: `{integrity: ${SRI}}` },
  ])
  return relock(dir, edit)
}
// By name: a State's bucket is where the package is, the field resolver's where it is linked.
const npmRecords = (dir, label) => Object.fromEntries(Object.values(modulesOf(dir, label)).filter(({ ecosystem }) => ecosystem === 'npm').map((info) => [info.name, [info.integrity, info.patch]]))

test('pnpm and npm: the tarball and patch a package was installed with are recorded, by its directory, and held to the lockfile beside it', withTmp(async (t, dir) => {
  const OTHER = `sha512-${'B'.repeat(85)}A==`
  const installed = patchedProject(dir)
  mkdirSync(join(dir, 'patches'))
  writeFileSync(join(dir, 'patches', 'reg@1.0.0.patch'), PATCH_TEXT)
  await bundledEach(dir)
  for (const [label] of BUILDS) t.assert.deepStrictEqual(npmRecords(dir, label), { reg: [SRI, PATCHED], plain: [SRI, undefined] }, label)
  for (const [lockfile, differs] of [
    [installed.replace(`plain@1.0.0':\n    resolution: {integrity: ${SRI}}`, `plain@1.0.0':\n    resolution: {integrity: ${OTHER}}`), `installed with ${SRI}; it locks ${OTHER}`],
    [installed.replaceAll(PATCH, 'd'.repeat(64)), 'it locks none there'],
  ]) {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), lockfile)
    // eslint-disable-next-line no-await-in-loop -- one lockfile at a time
    await t.assert.rejects(build(dir), (err) => err.message.includes("pnpm-lock.yaml doesn't lock ") && err.message.endsWith(`as installed (${differs}): install from it again`), differs)
  }
  npmProject(join(dir, 'npm'), { lock: { reg: { integrity: OTHER } }, hidden: { reg: { integrity: SRI } } })
  await t.assert.rejects(build(join(dir, 'npm')), new RegExp(`package-lock\\.json doesn't lock npm/node_modules/reg as installed \\(installed with ${SRI}; it locks ${OTHER}\\): install from it again$`, 'u'))
}))

test("pnpm: a patch's file is the one its lockfile names, else (pnpm 11) the settings', held to its hash; none found stops the build", withTmp(async (t, dir) => {
  patchedProject(dir)
  const refused = (why) => new RegExp(`lock\\.yaml patches reg@1\\.0\\.0 with ${PATCH}: ${why}$`, 'u')
  await t.assert.rejects(build(dir), refused(".*patches/reg@1\\.0\\.0\\.patch can't be read"))
  mkdirSync(join(dir, 'patches'))
  writeFileSync(join(dir, 'patches', 'reg@1.0.0.patch'), `${PATCH_TEXT}\n`)
  await t.assert.rejects(build(dir), refused('.*patches/reg@1\\.0\\.0\\.patch is a patch of another hash'))
  writeFileSync(join(dir, 'patches', 'reg@1.0.0.patch'), PATCH_TEXT.replaceAll('\n', '\r\n'))
  await bundled(dir, 'crlf')
  t.assert.deepStrictEqual(npmRecords(dir, 'crlf').reg, [SRI, PATCHED], 'pnpm hashes its text with its CRLFs as LFs')
  // pnpm 11's lockfile names a patch by its hash alone, its file in pnpm-workspace.yaml.
  relock(dir, (text) => text.replace(`hash: ${PATCH}\n    path: patches/reg@1.0.0.patch`, PATCH).replace('reg@1.0.0:\n    ', 'reg@1.0.0: '))
  await t.assert.rejects(build(dir), refused('neither it nor .*pnpm-workspace\\.yaml names the patch\'s file'))
  rmSync(join(dir, 'patches', 'reg@1.0.0.patch'))
  writeFileSync(join(dir, 'patches', 'own.patch'), PATCH_TEXT)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'patchedDependencies:\n  reg@1.0.0: patches/own.patch\n')
  await bundled(dir, 'settings', { lockfile: 'stasis.lock.json' })
  t.assert.deepStrictEqual(npmRecords(dir, 'settings').reg, [SRI, OWN])
  const lockPath = join(dir, 'stasis.lock.json')
  const locked = JSON.parse(readFileSync(lockPath, 'utf8'))
  const reg = Object.keys(locked.modules).find((at) => at.includes('reg@'))
  t.assert.deepStrictEqual(locked.modules[reg].patch, OWN, 'and the lockfile records it too')
  // A lockfile from before a patch's file was recorded holds the build all the same, its patch the same text.
  delete locked.modules[reg].patch.file
  writeFileSync(lockPath, JSON.stringify(locked))
  await bundled(dir, 'frozen', { env: { ...process.env, EXODUS_STASIS_LOCK: 'frozen' } })
  t.assert.deepStrictEqual(npmRecords(dir, 'frozen').reg, [SRI, OWN])
  // One recording another file is refused, never replaced.
  locked.modules[reg].patch.file = 'patches/old.patch'
  writeFileSync(lockPath, JSON.stringify(locked))
  await t.assert.rejects(bundled(dir, 'stale', { env: { ...process.env, EXODUS_STASIS_LOCK: 'frozen' } }), /stasis\.lock\.json: module '[^']+reg' patch mismatch \(.*"file":"patches\/old\.patch"\} vs .*"file":"patches\/own\.patch"\}\)/u)
}))

test("pnpm: of two patches of one text, each file is held to it, the first named recorded, as deptree records it", withTmp(async (t, dir) => {
  writePnpmProject(dir, ['reg', 'twin'].map((name) => ({ name, key: `${name}@1.0.0(patch_hash=${PATCH})`, store: `${name}@1.0.0_patch_hash=${PATCH}`, resolution: `{integrity: ${SRI}}`, patch: PATCH })))
  relock(dir, (text) => text)
  mkdirSync(join(dir, 'patches'))
  for (const name of ['reg', 'twin']) writeFileSync(join(dir, 'patches', `${name}@1.0.0.patch`), PATCH_TEXT)
  await bundled(dir, 'twins')
  t.assert.deepStrictEqual(npmRecords(dir, 'twins'), { reg: [SRI, PATCHED], twin: [SRI, PATCHED] })
  rmSync(join(dir, 'patches', 'twin@1.0.0.patch'))
  await t.assert.rejects(build(dir), new RegExp(`lock\\.yaml patches twin@1\\.0\\.0 with ${PATCH}: .*patches/twin@1\\.0\\.0\\.patch can't be read$`, 'u'))
}))

test("pnpm: a patch's file outside the bundle root is recorded from it", withTmp(async (t, dir) => {
  const project = join(dir, 'project')
  mkdirSync(project)
  patchedProject(project, (text) => text.replace('path: patches/reg@1.0.0.patch', 'path: ../shared/reg.patch'))
  mkdirSync(join(dir, 'shared'))
  writeFileSync(join(dir, 'shared', 'reg.patch'), PATCH_TEXT)
  await bundled(project, 'out')
  t.assert.deepStrictEqual(npmRecords(project, 'out').reg, [SRI, { ...PATCHED, file: '../shared/reg.patch' }])
}))
