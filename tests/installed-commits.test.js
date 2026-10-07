import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'

// `stasis bundle` from disk records each git dependency at the commit the record its package manager
// left in node_modules names: npm's hidden lockfile, pnpm's copy of its lockfile, yarn 1's yarn.lock
// as .yarn-integrity vouches for it. Each project here is laid out by hand as the package manager
// lays one out, through a State and through the field resolver.

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-installed-commits-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

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
  const { modules } = JSON.parse(brotliDecompressSync(readFileSync(join(dir, `${label}.br`))).toString('utf8'))
  return Object.fromEntries(Object.entries(modules).map(([at, { repo }]) => [at, repo]))
}

// [label, bundled()] of each of BUILDS.
const bundledEach = (dir) => Promise.all(BUILDS.map(async ([label, options]) => [label, await bundled(dir, label, options)]))

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
}))

// As yarn 1 writes them: yarn.lock's header, and .yarn-integrity's resolution of each pattern.
const YARN_LOCK = '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n'
const integrity = (lockfileEntries) => ({ systemParams: 'linux-x64-137', modulesFolders: ['node_modules'], flags: ['ignoreScripts'], linkedModules: [], topLevelPatterns: Object.keys(lockfileEntries), lockfileEntries, files: [], artifacts: {} })

test("yarn 1: yarn.lock names a git dependency's repository and commit, by its name and version, where .yarn-integrity has it installed so", withTmp(async (t, dir) => {
  writeProject(dir, ['dep', 'gh', 'reg', 'dup', 'lab', 'short', 'moved'])
  writePackage(dir, 'node_modules/dep', { name: 'dep', repository: 'github:o/elsewhere', requires: ['dup'] })
  writePackage(dir, 'node_modules/dep/node_modules/dup', { name: 'dup', repository: 'github:o/dup' })
  writePackage(dir, 'node_modules/dup', { name: 'dup', repository: 'github:o/dup' })
  writePackage(dir, 'node_modules/gh', { name: 'gh' })
  writePackage(dir, 'node_modules/reg', { name: 'reg', repository: 'github:o/reg' })
  writePackage(dir, 'node_modules/lab', { name: 'lab' })
  writePackage(dir, 'node_modules/short', { name: 'short' })
  writePackage(dir, 'node_modules/moved', { name: 'moved' })
  const sha1 = '0'.repeat(40)
  const entries = [
    ['"dep@git+https://github.com/o/dep.git"', `git+https://github.com/o/dep.git#${SHA.dep}`, '  dependencies:\n    dup "git+https://github.com/me/dup.git"\n'],
    ['"dup@git+https://github.com/me/dup.git"', `git+https://github.com/me/dup.git#${SHA.lab}`],
    ['"dup@git+https://github.com/o/dup.git"', `git+https://github.com/o/dup.git#${SHA.fork}`],
    ['"gh@github:o/gh"', `https://codeload.github.com/o/gh/tar.gz/${SHA.tar}`],
    ['reg@^1.0.0', `https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#${sha1}`],
    ['"lab@git+https://gitlab.com/o/lab.git"', `git+https://gitlab.com/o/lab.git#${SHA.lab}`],
    ['"short@https://codeload.github.com/o/short/tar.gz/abc1234"', `https://codeload.github.com/o/short/tar.gz/abc1234#${sha1}`],
    ['"moved@git+https://github.com/o/moved.git"', `git+https://github.com/o/moved.git#${SHA.moved}`],
  ]
  writeFileSync(join(dir, 'yarn.lock'), YARN_LOCK + entries.map(([key, resolved, rest = '']) => `${key}:\n  version "1.0.0"\n  resolved "${resolved}"\n${rest}`).join('\n'))
  const installed = Object.fromEntries(entries.map(([key, resolved]) => [JSON.parse(key.startsWith('"') ? key : `"${key}"`), resolved]))
  // Installed at the commit yarn.lock had before it moved the dependency to another.
  installed['moved@git+https://github.com/o/moved.git'] = `git+https://github.com/o/moved.git#${SHA.dep}`
  writeJson(join(dir, 'node_modules', '.yarn-integrity'), integrity(installed))
  for (const [label, repos] of await bundledEach(dir)) {
    t.assert.deepStrictEqual(repos['node_modules/dep'], { github: 'o/dep', directory: '', commit: SHA.dep }, `${label}: a git dependency, in the repository installed from`)
    t.assert.deepStrictEqual(repos['node_modules/gh'], { github: 'o/gh', directory: '', commit: SHA.tar }, `${label}: GitHub's tarball of a commit`)
    t.assert.deepStrictEqual(repos['node_modules/reg'], { github: 'o/reg' }, `${label}: a registry package, as its package.json has it`)
    t.assert.deepStrictEqual(repos['node_modules/dup'], { github: 'o/dup' }, `${label}: two git dependencies of one name and version, either the one installed: none`)
    t.assert.deepStrictEqual(repos['node_modules/dep/node_modules/dup'], { github: 'o/dup' }, `${label}: for neither`)
    t.assert.equal(repos['node_modules/lab'], undefined, `${label}: another host's repository, none`)
    t.assert.equal(repos['node_modules/short'], undefined, `${label}: an abbreviated commit, none`)
    t.assert.equal(repos['node_modules/moved'], undefined, `${label}: a yarn.lock changed since the install, none`)
  }
}))

// A project pnpm installed `packages` into, as it installs each: in node_modules/.pnpm/<store>/
// node_modules/<name>, linked into the project's node_modules, its snapshot in the lockfile
// node_modules/.pnpm/lock.yaml copies; one from the registry with no version of its own there.
function writePnpmProject(dir, packages) {
  writeProject(dir, packages.map(({ name }) => name))
  for (const { name, store, pkg } of packages) {
    writePackage(dir, `node_modules/.pnpm/${store}/node_modules/${name}`, { name, ...pkg })
    symlinkSync(`.pnpm/${store}/node_modules/${name}`, join(dir, 'node_modules', name))
  }
  const importer = packages.map(({ name, key }) => `      ${name}:\n        specifier: x\n        version: '${key.slice(name.length + 1)}'\n`)
  const snapshots = packages.map(({ key, resolution }) => `  '${key}':\n    resolution: ${resolution}\n${resolution.startsWith('{integrity') ? '' : '    version: 1.0.0\n'}`)
  writeFileSync(join(dir, 'node_modules', '.pnpm', 'lock.yaml'), `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
${importer.join('')}
packages:

${snapshots.join('\n')}
snapshots:

${packages.map(({ key }) => `  '${key}': {}\n`).join('\n')}`)
}

// Its commit and repository, a capital in its key, as pnpm 9.15.9 and 10.33.4 install it.
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

test('pnpm: by the directory pnpm 9 installs it in, its `#` kept, and an MD5 in base32 where hashed', withTmp(async (t, dir) => {
  writePnpmProject(dir, [
    { name: 'dep', key: `dep@git+https://git@github.com:o/dep.git#${SHA.dep}`, store: `dep@git+https+++git@github.com+o+dep.git#${SHA.dep}`, resolution: `{commit: ${SHA.dep}, repo: 'git@github.com:o/dep.git', type: git}` },
    xtend(`xtend@git+https+++git@github.com+Raynos+xtend.git#${XTEND}_566luz3wrwstne6n4ddwqdopme`),
  ])
  const repos = await bundled(dir, 'state')
  t.assert.deepStrictEqual(repos[`node_modules/.pnpm/dep@git+https+++git@github.com+o+dep.git#${SHA.dep}/node_modules/dep`], { github: 'o/dep', directory: '', commit: SHA.dep })
  t.assert.deepStrictEqual(repos[`node_modules/.pnpm/xtend@git+https+++git@github.com+Raynos+xtend.git#${XTEND}_566luz3wrwstne6n4ddwqdopme/node_modules/xtend`], { github: 'Raynos/xtend', directory: '', commit: XTEND })
}))


test("npm's and yarn's records: one missing or unreadable, or both at once, records nothing, and fails no build", withTmp(async (t, dir) => {
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
    ['a yarn.lock yarn would not write', { 'node_modules/.yarn-integrity': yarnIntegrity, 'yarn.lock': yarn.replace('# THIS', '# this') }],
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
