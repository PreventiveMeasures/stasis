import { test } from 'node:test'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { diffArtifacts } from '../stasis/src/diff.js'
import { patchIntegrity } from '../stasis/src/installed.js'
import { withTmp } from './tmp.helper.js'

// Every place a dependency record's `integrity` and `patch` meet an anchor -- the package manager's
// lockfile, an existing stasis.lock.json, what is installed -- each holds them to it, or refuses.

/* eslint-disable no-await-in-loop -- each case's builds run in order, on the files the one before left */

const here = dirname(fileURLToPath(import.meta.url))
const SRI = `sha512-${'A'.repeat(86)}==`
const OTHER = `sha512-${'B'.repeat(85)}A==`
// A patch's integrity, as a record names the one pnpm installed its package with.
const PATCHED = { integrity: patchIntegrity('a'.repeat(64)) }
const LOCK = 'stasis.lock.json'
const NOTHING_TELLS = { hidden: false, packageLock: false }
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// An npm project in `dir` requiring `reg`, installed as npm lays it out, its hidden lockfile and
// package-lock.json locking it with `integrity` (null for none), each where asked, and there alone.
function npmProject(dir, { hidden = true, packageLock = true, integrity = SRI } = {}) {
  writeJson(join(dir, 'package.json'), { name: 'app', version: '1.0.0' })
  writeFileSync(join(dir, 'index.js'), "require('reg')\n")
  mkdirSync(join(dir, 'node_modules', 'reg'), { recursive: true })
  writeJson(join(dir, 'node_modules', 'reg', 'package.json'), { name: 'reg', version: '1.0.0' })
  writeFileSync(join(dir, 'node_modules', 'reg', 'index.js'), 'module.exports = 1\n')
  const lock = { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { 'node_modules/reg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/reg/-/reg-1.0.0.tgz', ...(integrity && { integrity }) } } }
  for (const [file, written] of [[join(dir, 'node_modules', '.package-lock.json'), hidden], [join(dir, 'package-lock.json'), packageLock]]) {
    if (written) writeJson(file, lock)
    else rmSync(file, { force: true })
  }
}

// stasis.lock.json's text, its record of `reg`, and that record (and the lockfile) edited.
const lockText = (dir) => readFileSync(join(dir, LOCK), 'utf8')
const lockOf = (dir) => readJson(join(dir, LOCK)).modules['node_modules/reg']
function editLock(dir, edit) {
  const lock = readJson(join(dir, LOCK))
  edit(lock.modules['node_modules/reg'], lock)
  writeJson(join(dir, LOCK), lock)
}
const mode = (lock) => ({ env: { ...process.env, EXODUS_STASIS_LOCK: lock } })
const build = (dir, options = {}) => bundleCommand({ cwd: dir, entries: ['index.js'], output: 'out.br', ...options })
const recordOf = (dir, file = 'out.br', at = 'node_modules/reg') => JSON.parse(brotliDecompressSync(readFileSync(join(dir, file))).toString('utf8')).modules[at]
// `stasis run` of `entry` in `dir`, with these flags and no lock mode from the environment.
const stasis = (dir, ...args) => spawnSync(process.execPath, [join(here, '..', 'stasis', 'bin', 'stasis.js'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, EXODUS_STASIS_LOCK: '' } })
const stasisRun = (dir, flags, entry = 'index.js') => stasis(dir, 'run', ...flags, entry)
const stasisAdd = (dir, ...files) => stasis(dir, 'add', ...files)
function editBundle(dir, file, edit) {
  const bundle = JSON.parse(brotliDecompressSync(readFileSync(join(dir, file))))
  edit(bundle.modules['node_modules/reg'])
  writeFileSync(join(dir, file), brotliCompressSync(JSON.stringify(bundle)))
}

test('stasis bundle and stasis run refuse what stasis.lock.json records otherwise than the install, which lock = ignore leaves and replace rewrites', withTmp(async (t, dir) => {
  const integrity = /stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch/u
  const none = /stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch \("sha512-A+==" vs none\)/u
  const patch = /stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs installed\) patch mismatch \(\{"integrity":"sha256-[^"]+"\} vs none\)/u
  const locked = /stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs locked\) integrity mismatch/u
  // [label, the edit, what stasis bundle refuses it with, and stasis run (null: not run), the integrity replace writes]
  const cases = [
    ['another integrity', () => editLock(dir, (record) => { record.integrity = OTHER }), /stasis\.lock\.json: module 'node_modules\/reg' integrity mismatch/u, integrity, SRI],
    // A record from before the `ecosystem` tag is npm's all the same.
    ['another integrity, untagged', () => editLock(dir, (record) => Object.assign(record, { ecosystem: undefined, integrity: OTHER })), null, integrity, SRI],
    ['another hash of a file', () => editLock(dir, (record) => { record.files['index.js'] = SRI }), /content mismatch for 'node_modules\/reg\/index\.js'/u, null, SRI],
    // The build's record, of an integrity and no patch, is of a package installed unpatched.
    ['a patch the install names none of', () => editLock(dir, (record) => { record.patch = PATCHED }), /stasis\.lock\.json: module 'node_modules\/reg' patch mismatch \(\{"integrity":"sha256-[^"]+"\} vs none\)/u, patch, SRI],
    ['an integrity the install names none of', () => npmProject(dir, { integrity: null }), none, none, undefined],
    ['another integrity, package-lock.json alone locking it', () => npmProject(dir, { hidden: false, integrity: OTHER }), locked, locked, undefined],
    ['no integrity, package-lock.json alone locking it', () => npmProject(dir, { hidden: false, integrity: null }), locked, null, undefined],
  ]
  for (const [label, edit, bundled, ran, replaced] of cases) {
    npmProject(dir)
    await build(dir, { lockfile: LOCK, ...mode('replace') })
    edit()
    const edited = lockText(dir)
    for (const [how, options] of bundled ? [['add', {}], ['add, to be written', { lockfile: LOCK }], ['frozen', mode('frozen')]] : []) await t.assert.rejects(build(dir, options), bundled, `${label}: bundle, ${how}`)
    for (const lock of ran ? ['frozen', 'add'] : []) {
      const { status, stderr } = stasisRun(dir, [`--lock=${lock}`])
      t.assert.notEqual(status, 0, `${label}: run, ${lock}`)
      t.assert.match(stderr, ran, `${label}: run, ${lock}`)
    }
    await build(dir, mode('ignore'))
    t.assert.equal(lockText(dir), edited, `${label}: left as it was`)
    await build(dir, { lockfile: LOCK, ...mode('replace') })
    t.assert.deepStrictEqual([lockOf(dir).integrity, lockOf(dir).patch], [replaced, undefined], `${label}: replaced, of what is installed`)
  }
}))

test('stasis bundle and stasis run keep what stasis.lock.json records where the install agrees, the lockfile beside locks it so, or nothing tells', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: LOCK })
  for (const [label, layout] of [['as installed', {}], ['package-lock.json locks it so', { hidden: false }], ['nothing tells', NOTHING_TELLS]]) {
    npmProject(dir, layout)
    for (const [how, options] of [['add', { lockfile: LOCK }], ['frozen', mode('frozen')]]) {
      await build(dir, options)
      t.assert.deepStrictEqual([lockOf(dir).integrity, recordOf(dir).integrity], [SRI, SRI], `${label}: bundle, ${how}`)
    }
    for (const lock of ['frozen', 'add']) t.assert.equal(stasisRun(dir, [`--lock=${lock}`]).status, 0, `${label}: run, ${lock}`)
    t.assert.equal(lockOf(dir).integrity, SRI, `${label}: run, neither dropped nor replaced`)
  }
  editLock(dir, (record) => { record.patch = PATCHED })
  await build(dir)
  t.assert.deepStrictEqual(recordOf(dir).patch, PATCHED, 'its patch too')
  await build(dir, mode('ignore'))
  t.assert.deepStrictEqual([recordOf(dir).integrity, recordOf(dir).patch], [undefined, undefined], "ignored: the build's own, which names none")
}))

test("stasis run records the install's integrity of what it reads anew, not onto a record of files it may not have read", withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: LOCK })
  writeFileSync(join(dir, 'node_modules', 'reg', 'more.js'), 'module.exports = 2\n')
  writeFileSync(join(dir, 'more.js'), "require('reg/more.js')\n")
  const added = stasisRun(dir, ['--lock=add'], 'more.js')
  t.assert.equal(added.status, 0, added.stderr)
  t.assert.deepStrictEqual([Object.keys(lockOf(dir).files).toSorted(), lockOf(dir).integrity], [['index.js', 'more.js'], SRI], 'a file it adds: of the integrity the install names')
  editLock(dir, (record) => { delete record.integrity })
  t.assert.equal(stasisRun(dir, ['--lock=add']).status, 0)
  t.assert.equal(lockOf(dir).integrity, undefined, 'added to: no claim of the files recorded before')
  t.assert.equal(stasisRun(dir, ['--lock=replace']).status, 0)
  t.assert.equal(lockOf(dir).integrity, SRI, 'replaced: of the files it read')
}))

test('stasis bundle --add holds what the bundle there records to how its packages are installed, and keeps what it alone records', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, mode('ignore'))
  writeFileSync(join(dir, 'none.js'), '')
  for (const [label, integrity, entries = ['index.js']] of [['another', OTHER], ['none', null], ['another, of a package this build bundles none of', OTHER, ['none.js']]]) {
    npmProject(dir, { integrity })
    await t.assert.rejects(build(dir, { ...mode('ignore'), add: true, entries }), /out\.br: module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch/u, label)
  }
  npmProject(dir, NOTHING_TELLS)
  await build(dir, { ...mode('ignore'), add: true })
  t.assert.equal(recordOf(dir).integrity, SRI, 'kept, where nothing tells')
}))

test('stasis bundle --add --lockfile holds what stasis.lock.json records of a package the build bundles none of to how it is installed', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: LOCK })
  writeFileSync(join(dir, 'none.js'), '')
  await build(dir, { ...mode('ignore'), entries: ['none.js'], output: 'none.br' })
  const none = { ...mode('add'), add: true, lockfile: LOCK, entries: ['none.js'], output: 'none.br' }
  await build(dir, none)
  t.assert.equal(lockOf(dir).integrity, SRI, 'kept, as installed')
  for (const [label, integrity] of [['another', OTHER], ['none', null]]) {
    npmProject(dir, { integrity })
    await t.assert.rejects(build(dir, none), /stasis\.lock\.json: module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch/u, label)
  }
}))

test('stasis bundle --add holds what the bundle there records of a Soldeer, Composer or vendored Cargo dependency it bundles none of to how it is installed', withTmp(async (t, tmp) => {
  const fixtures = join(here, 'fixtures')
  const write = (dir, files) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      writeFileSync(join(dir, rel), text)
    }
  }
  // Composer's record of acme/lib's dist, in composer.lock and installed.json alike, with `shasum`.
  const composerDist = (dir, shasum) => {
    for (const file of ['composer.lock', 'vendor/composer/installed.json']) {
      const json = readJson(join(dir, file))
      Object.assign(json.packages.find((p) => p.name === 'acme/lib'), { dist: { type: 'zip', url: 'https://example.com/acme/lib.zip', shasum }, ...(file !== 'composer.lock' && { 'installation-source': 'dist' }) })
      writeFileSync(join(dir, file), `${JSON.stringify(json, null, 4)}\n`)
    }
  }
  const crate = (checksum) => ({ 'vendor/itoa/.cargo-checksum.json': JSON.stringify({ files: {}, package: checksum.repeat(64) }) })
  // Each: its project, the entries bundling its dependency (at `at`) and none of it, and it installed otherwise.
  const cases = {
    soldeer: {
      project: (dir) => {
        cpSync(join(fixtures, 'soldeer-bundle', 'project'), dir, { recursive: true })
        cpSync(join(fixtures, 'soldeer-bundle', 'dependencies'), join(dir, 'dependencies'), { recursive: true })
        write(dir, { 'alone/Alone.sol': 'pragma solidity ^0.8.20;\n\ncontract Alone {}\n' })
      },
      entries: ['src'], alone: ['alone'], at: 'dependencies/stasis-sol-lib-1.0.0',
      otherwise: (dir) => writeFileSync(join(dir, 'soldeer.lock'), readFileSync(join(dir, 'soldeer.lock'), 'utf8').replace(/checksum = "../u, 'checksum = "ff')),
    },
    composer: {
      project: (dir) => {
        cpSync(join(fixtures, 'php-bundle', 'composer-lock'), dir, { recursive: true })
        composerDist(dir, 'ab'.repeat(20))
        write(dir, { 'alone.php': '<?php\necho 1;\n' })
      },
      entries: ['index.php'], alone: ['alone.php'], at: 'vendor/acme/lib',
      otherwise: (dir) => composerDist(dir, 'cd'.repeat(20)),
    },
    cargo: {
      project: (dir) => write(dir, {
        'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nitoa = "1"\n',
        'src/main.rs': 'use itoa::Buffer;\nfn main() {}\n',
        'src/bin/alone.rs': 'fn main() {}\n',
        'vendor/itoa/Cargo.toml': '[package]\nname = "itoa"\nversion = "1.0.18"\n',
        'vendor/itoa/src/lib.rs': 'pub struct Buffer;\n',
        ...crate('a'),
      }),
      entries: ['src/main.rs'], alone: ['src/bin/alone.rs'], at: 'vendor/itoa',
      otherwise: (dir) => write(dir, crate('b')),
    },
  }
  for (const [name, { project, entries, alone, at, otherwise }] of Object.entries(cases)) {
    const dir = join(tmp, name)
    project(dir)
    const add = () => build(dir, { entries: alone, add: true, env: {} })
    const recorded = () => Bundle.parse(brotliDecompressSync(readFileSync(join(dir, 'out.br'))).toString('utf8')).modules.get(at)
    await build(dir, { entries, env: {} })
    const { integrity, files } = recorded()
    t.assert.ok(integrity, name)
    await add()
    t.assert.deepStrictEqual([recorded().integrity, Object.keys(recorded().files)], [integrity, Object.keys(files)], `${name}: kept, as installed`)
    otherwise(dir)
    await t.assert.rejects(add(), new RegExp(`out\\.br: module '${at}' \\(recorded vs installed\\) integrity mismatch`, 'u'), name)
  }
}))

test('stasis add holds what the bundle and stasis.lock.json record to the install, and to each other, and adds a file as its install record names it', withTmp(async (t, dir) => {
  npmProject(dir)
  writeJson(join(dir, 'stasis.config.json'), {})
  writeFileSync(join(dir, 'node_modules', 'reg', 'more.js'), 'module.exports = 2\n')
  writeFileSync(join(dir, 'own.js'), '')
  const code = 'stasis.code.br'
  await build(dir, { output: code, lockfile: LOCK })
  const [bundle, lock] = [readFileSync(join(dir, code)), lockText(dir)]
  const restore = () => {
    writeFileSync(join(dir, code), bundle)
    writeFileSync(join(dir, LOCK), lock)
  }
  const added = stasisAdd(dir, 'node_modules/reg/more.js')
  t.assert.equal(added.status, 0, added.stderr)
  for (const record of [recordOf(dir, code), lockOf(dir)]) t.assert.deepStrictEqual([Object.keys(record.files).toSorted(), record.integrity], [['index.js', 'more.js'], SRI], 'a file of it: of the integrity its install record names')
  for (const [label, options, of] of [['another', { integrity: OTHER }, 'installed'], ['none', { integrity: null }, 'installed'], ['another, locked alone', { hidden: false, integrity: OTHER }, 'locked']]) {
    restore()
    npmProject(dir, options)
    const refused = stasisAdd(dir, 'own.js')
    t.assert.notEqual(refused.status, 0, label)
    t.assert.match(refused.stderr, new RegExp(`stasis\\.code\\.br: module 'node_modules/reg' \\(recorded vs ${of}\\) integrity mismatch`, 'u'), label)
    t.assert.deepStrictEqual([readFileSync(join(dir, code)), lockText(dir)], [bundle, lock], `${label}: nothing written`)
  }
  for (const [label, options] of [['locked alone', { hidden: false }], ['nothing tells', NOTHING_TELLS]]) {
    restore()
    npmProject(dir, options)
    t.assert.equal(stasisAdd(dir, 'own.js').status, 0, `${label}: kept as recorded`)
    t.assert.match(stasisAdd(dir, 'node_modules/reg/more.js').stderr, /bundle merge: module 'node_modules\/reg' integrity is recorded of one side's files, not of 'node_modules\/reg\/more\.js' the other adds/u, `${label}: no file of it added`)
  }
  restore()
  editLock(dir, (record) => { record.integrity = OTHER })
  t.assert.match(stasisAdd(dir, 'own.js').stderr, /stasis\.lock\.json: module 'node_modules\/reg' \(against the other artifacts\) integrity mismatch/u, 'the two, of one package')
  npmProject(dir)
  for (const file of [code, LOCK]) rmSync(join(dir, file))
  t.assert.equal(stasisAdd(dir, 'node_modules/reg/index.js').status, 0)
  t.assert.equal(recordOf(dir, code).integrity, SRI, 'a package it records none of: as its install record names it')
}))

test("stasis add holds a split bundle's other half too, and adds to one half as the other attests the package", withTmp((t, dir) => {
  npmProject(dir)
  writeJson(join(dir, 'stasis.config.json'), { bundleFile: 'code.br', resourcesBundleFile: 'res.br', resources: ['bin'] })
  writeFileSync(join(dir, 'node_modules', 'reg', 'data.bin'), 'data\n')
  const add = (file) => stasisAdd(dir, `node_modules/reg/${file}`)
  t.assert.equal(add('index.js').status, 0)
  t.assert.equal(recordOf(dir, 'code.br').integrity, SRI)
  npmProject(dir, { integrity: OTHER })
  t.assert.match(add('data.bin').stderr, /code\.br: module 'node_modules\/reg' \(recorded vs installed\) integrity mismatch/u, 'the half no file is added to')
  t.assert.ok(!existsSync(join(dir, 'res.br')), 'nothing written')
  npmProject(dir)
  for (const [label, integrity] of [['as the other half attests it', SRI], ['of none, as the other half', undefined]]) {
    editBundle(dir, 'code.br', (record) => { record.integrity = integrity })
    rmSync(join(dir, 'res.br'), { force: true })
    t.assert.equal(add('data.bin').status, 0, label)
    t.assert.deepStrictEqual([recordOf(dir, 'res.br').integrity, Object.keys(recordOf(dir, 'res.br').files)], [integrity, ['data.bin']], label)
  }
}))

test("a build held to a stasis.lock.json recording more of a package's files attests its own, and a run holds that to the install", withTmp(async (t, dir) => {
  npmProject(dir, NOTHING_TELLS)
  await build(dir, { lockfile: LOCK })
  editLock(dir, (record, lock) => {
    record.files['other.js'] = SRI
    lock.formats['node_modules/reg/other.js'] = 'commonjs'
  })
  const broader = lockText(dir)
  npmProject(dir)
  for (const lock of ['add', 'frozen']) {
    await build(dir, { output: 'stasis.code.br', ...mode(lock) })
    const { integrity, files } = recordOf(dir, 'stasis.code.br')
    t.assert.deepStrictEqual([integrity, Object.keys(files), lockText(dir)], [SRI, ['index.js'], broader], lock)
  }
  const run = () => stasisRun(dir, ['--lock=frozen', '--bundle=load'])
  t.assert.equal(run().status, 0, 'run: as installed')
  for (const [field, more] of [['integrity', { integrity: OTHER }], ['patch', { integrity: SRI, patch: PATCHED }]]) {
    editBundle(dir, 'stasis.code.br', (record) => Object.assign(record, more))
    const refused = run()
    t.assert.notEqual(refused.status, 0, field)
    t.assert.match(refused.stderr, new RegExp(`stasis\\.code\\.br: module 'node_modules/reg' \\(recorded vs installed\\) ${field} mismatch`, 'u'), field)
  }
}))

test("a disk build records the integrity a Solidity bundle's npm packages, and yarn 1's, are installed with", withTmp(async (t, dir) => {
  const sol = join(dir, 'sol')
  cpSync(join(here, 'fixtures', 'solidity-bundle', 'with-node-modules'), sol, { recursive: true })
  writeJson(join(sol, 'node_modules', '.package-lock.json'), { lockfileVersion: 3, packages: { 'node_modules/foo': { version: '1.2.3', integrity: SRI } } })
  await bundleCommand({ cwd: sol, entries: ['src/A.sol'], mappingFile: 'remappings.txt', output: 'out.br' })
  t.assert.equal(recordOf(sol, 'out.br', 'node_modules/foo').integrity, SRI, 'Solidity')
  const resolved = `https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#${'0'.repeat(40)}`
  npmProject(dir, NOTHING_TELLS)
  writeFileSync(join(dir, 'yarn.lock'), `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\nreg@1.0.0:\n  version "1.0.0"\n  resolved "${resolved}"\n  integrity ${SRI}\n`)
  writeJson(join(dir, 'node_modules', '.yarn-integrity'), { systemParams: 'linux-x64-137', modulesFolders: ['node_modules'], flags: [], linkedModules: [], topLevelPatterns: ['reg@1.0.0'], lockfileEntries: { 'reg@1.0.0': resolved }, files: [], artifacts: {} })
  await build(dir)
  t.assert.equal(recordOf(dir).integrity, SRI, 'yarn 1, as .yarn-integrity has it installed')
}))

test("stasis diff tells a dependency's integrity and patch changing", (t) => {
  const another = { integrity: patchIntegrity('b'.repeat(64)) }
  const of = (more) => new Bundle({ config: { scope: 'node_modules' }, modules: new Map([['node_modules/reg', { name: 'reg', version: '1.0.0', ecosystem: 'npm', ...more, files: { 'index.js': 'x\n' } }]]) })
  const [change] = diffArtifacts({ artifact: of({ integrity: SRI, patch: PATCHED }), kind: 'bundle' }, { artifact: of({ integrity: OTHER, patch: another }), kind: 'bundle' }, { hash: (x) => x }).modules.changed
  t.assert.deepStrictEqual([change.integrityChange, change.patchChange], [{ from: SRI, to: OTHER }, { from: PATCHED, to: another }])
})
