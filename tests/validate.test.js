import { test } from 'node:test'
import { AssertionError } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { HttpError, ValidateError, fetchFailure, fetchPackage, gitBlobId, lockedBy, parsePatch, patchedFiles, printValidationReport, repositoryLockfiles, tarballFiles, validate, validateBundle, validationPlan } from '../stasis/src/validate.js'
import { fakeClient } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const commit = '7'.repeat(40)
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const blob = (text) => gitBlobId(Buffer.from(text))
const bytes = (text) => new TextEncoder().encode(text)

// ms@2.1.3 as published, and its patch, as pnpm writes one.
const MS = { 'index.js': 'one\ntwo\nthree\n', 'package.json': '{"name":"ms","version":"2.1.3"}\n', 'readme.md': 'left out of the bundle\n' }
const MS_PATCH = `diff --git a/index.js b/index.js
index 1111111..2222222 100644
--- a/index.js
+++ b/index.js
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`
// A bundle built in `web`: its own code; ms patched; left with a file changed and one its package
// hasn't; gone, published nowhere; a Composer package; and Stasis's empty stub.
function bundleOf(modules = {}) {
  return new Bundle({
    repo: { github: 'org/repo', directory: 'web', commit },
    modules: new Map(Object.entries({
      '.': { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n', 'src/changed.js': 'edited here\n', 'src/extra.js': 'not in the repo\n',
        'src/link.js': 'linked\n', 'src/crlf.js': 'a\r\nb\r\n', 'vendor/sub/x.js': 'in a submodule\n', 'patches/ms@2.1.3.patch': MS_PATCH,
        '.stasis/empty-module.js': '', 'icon.png': 'AP8=' } },
      'node_modules/ms': { name: 'ms', version: '2.1.3', files: { 'index.js': 'one\nTWO\nthree\n', 'package.json': MS['package.json'] } },
      'node_modules/left': { name: 'left', version: '1.0.0', files: { 'index.js': 'tampered\n', 'injected.js': 'x\n' } },
      'node_modules/gone': { name: 'gone', version: '1.0.0', files: { 'index.js': '\n' } },
      'vendor/org/php': { ecosystem: 'composer', name: 'org/php', version: '1.0.0', files: { 'a.php': '<?php\n' } },
      ...modules,
    }).filter(([, info]) => info !== undefined)),
    formats: new Map([['patches/ms@2.1.3.patch', 'patch'], ['icon.png', 'resource:base64']]),
  })
}
const parsed = (modules) => Bundle.parse(bundleOf(modules).serialize())
// The repository at the commit, under `web`, as a listing of git's blob ids gives it.
const LISTED = {
  'web/src/main.js': { sha: blob('main\n') },
  'web/src/changed.js': { sha: blob('as committed\n') },
  'web/src/link.js': { symlink: '../linked.js' },
  'web/src/crlf.js': { sha: blob('a\nb\n') },
  'web/vendor/sub': { submodule: true },
  'web/patches/ms@2.1.3.patch': { sha: blob(MS_PATCH) },
  'web/icon.png': { sha: gitBlobId(Buffer.from('AP8=', 'base64')) },
}
const own = (entries = LISTED, more = {}) => ({ entries: new Map(Object.entries(entries)), cut: false, repository: 'org/repo', commit, directory: 'web', ...more })
const PACKAGES = { 'npm:ms@2.1.3': MS, 'npm:left@1.0.0': { 'index.js': 'original\n', 'other.js': 'never bundled\n' } }
// A sha512 integrity, as a lockfile locks a version with.
const SRI = `sha512-${'A'.repeat(86)}==`
// Upstream's packages, as `fetch` takes them, each version fetched told (`fetched`), with the
// integrity it is to be held to where it is given one (`integrities`).
const upstream = (packages = PACKAGES, fetched = [], integrities = []) => async (ecosystem, name, version, integrity) => {
  fetched.push(`${ecosystem}:${name}@${version}`)
  if (integrity !== undefined) integrities.push([`${ecosystem}:${name}@${version}`, integrity])
  const files = packages[`${ecosystem}:${name}@${version}`]
  if (!files) throw Object.assign(new HttpError('Not found'), { status: 404 })
  return new Map(Object.entries(files).map(([path, text]) => [path, bytes(text)]))
}

test('validationPlan: own code, each package version\'s files, the patches it holds; no directory, nor the empty stub', (t) => {
  const plan = validationPlan(parsed())
  t.assert.deepStrictEqual(plan.own.map((file) => file.path), ['icon.png', 'patches/ms@2.1.3.patch', 'src/changed.js', 'src/crlf.js', 'src/extra.js', 'src/link.js', 'src/main.js', 'vendor/sub/x.js'])
  t.assert.deepStrictEqual(plan.packages.map((pkg) => [pkg.ecosystem, pkg.name, pkg.version, pkg.files.map((file) => file.rel)]), [
    ['npm', 'gone', '1.0.0', ['index.js']], ['npm', 'left', '1.0.0', ['index.js', 'injected.js']], ['npm', 'ms', '2.1.3', ['index.js', 'package.json']],
    ['composer', 'org/php', '1.0.0', ['a.php']],
  ])
  t.assert.deepStrictEqual([...plan.patches.keys()], ['patches/ms@2.1.3.patch'])
  t.assert.equal(plan.files, 14, 'the empty stub left out')
  t.assert.deepStrictEqual([...plan.own.find((file) => file.path === 'icon.png').bytes()], [0, 255], 'a resource as its base64 spells it')
  const filled = validationPlan(parsed({ '.': { name: 'app', version: '1.0.0', files: { '.stasis/empty-module.js': 'not empty\n' } } }))
  t.assert.deepStrictEqual(filled.own.map((file) => file.path), ['.stasis/empty-module.js'], 'one there that is not empty is own code')
})

test('validationPlan: the root module, and an npm-tagged one outside node_modules (a workspace package), are own code whatever ecosystem they record', (t) => {
  const plan = validationPlan(Bundle.parse(new Bundle({ modules: new Map([
    ['.', { ecosystem: 'composer', name: 'org/app', version: '1.0.0', files: { 'index.php': '<?php\n' } }],
    ['packages/lib', { ecosystem: 'npm', name: 'lib', version: '1.0.0', files: { 'index.js': 'lib\n' } }],
    ['vendor/org/php', { ecosystem: 'composer', name: 'org/php', version: '1.0.0', files: { 'a.php': '<?php\n' } }],
  ]) }).serialize()))
  t.assert.deepStrictEqual(plan.own.map((file) => file.path), ['index.php', 'packages/lib/index.js'])
  t.assert.deepStrictEqual(plan.packages.map((pkg) => `${pkg.ecosystem}:${pkg.name}`), ['composer:org/php'], 'a vendored Composer package a dependency still')
})

test('validateBundle: own code held to the repository, each dependency to its package, a patched one as patched, the files it leaves out expected', async (t) => {
  const report = await validateBundle(validationPlan(parsed()), own(), { fetch: upstream(), now: () => 1 })
  t.assert.equal(report.status, 'invalid')
  t.assert.deepStrictEqual(report.own, { checked: true, repository: 'org/repo', commit, directory: 'web' })
  t.assert.deepStrictEqual(report.problems, [
    { path: 'node_modules/left/index.js', kind: 'differs', of: 'npm:left@1.0.0' },
    { path: 'node_modules/left/injected.js', kind: 'unexpected', of: 'npm:left@1.0.0' },
    { path: 'src/changed.js', kind: 'differs', of: 'own' },
    { path: 'src/extra.js', kind: 'unexpected', of: 'own' },
    { path: 'src/link.js', kind: 'differs', of: 'own', reason: 'symlink' },
    { path: 'vendor/sub/x.js', kind: 'unexpected', of: 'own', reason: 'submodule' },
  ])
  t.assert.deepStrictEqual(report.packages, [
    { ecosystem: 'composer', name: 'org/php', version: '1.0.0', files: 1, status: 'unverified', reason: 'unsupported' },
    { ecosystem: 'npm', name: 'gone', version: '1.0.0', files: 1, status: 'unverified', reason: 'not-published' },
    { ecosystem: 'npm', name: 'left', version: '1.0.0', files: 2, status: 'invalid' },
    { ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'valid', patch: { path: 'patches/ms@2.1.3.patch', from: 'bundle', applied: true } },
  ], 'ms as the patch the bundle holds named for it changes it, with no lockfile read')
  t.assert.deepStrictEqual(report.counts, { files: 14, own: 8, dependencies: 6, matched: 6, eol: 1, differs: 3, unexpected: 3, unverified: 2, packages: 4, validPackages: 1, lockFailures: 0 })
  t.assert.equal(report.lockfiles, null, 'held to no lockfile')
  // Own code read as bytes, as a tree's tarball has them, alike.
  const asBytes = Object.fromEntries(Object.entries(LISTED).map(([path, entry]) => [path, entry.sha === blob('main\n') ? { data: bytes('main\n') } : entry]))
  t.assert.deepStrictEqual((await validateBundle(validationPlan(parsed()), own(asBytes), { fetch: upstream(), now: () => 1 })).problems, report.problems)
})

test('validateBundle: a version its lockfile patches is held to that patch, of the bundle\'s file of its hash, else read of the repository and held to its hash; one it does not, as published', async (t) => {
  const plan = validationPlan(parsed({ 'node_modules/left': undefined }))
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  const read = []
  const locked = (lock) => ({ of: (name, version) => (name === 'ms' && version === '2.1.3' ? lock : undefined), read: async (hash, path) => (read.push([hash, path]), MS_PATCH) })
  const packagesOf = async (lock) => (await validateBundle(plan, own(), { fetch: upstream(), locked: locked(lock) })).packages
  t.assert.deepStrictEqual(await packagesOf({ hash: sha256(MS_PATCH), path: 'patches/elsewhere.patch' }), [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'valid',
    patch: { hash: sha256(MS_PATCH), path: 'patches/ms@2.1.3.patch', from: 'bundle', applied: true } }], 'the bundle\'s file of its hash')
  t.assert.deepStrictEqual(read, [])
  // Read of the repository where the bundle holds no file of its hash, and held to that hash.
  const apart = { ...plan, patches: new Map() }
  const fromRepository = async (lock) => (await validateBundle(apart, own(), { fetch: upstream(), locked: locked(lock) })).packages[0]
  const hash = sha256(MS_PATCH)
  t.assert.deepStrictEqual((await fromRepository({ hash, path: 'web/patches/ms.patch' })).patch, { hash, path: 'web/patches/ms.patch', from: 'repository', applied: true })
  t.assert.deepStrictEqual(read, [[hash, 'web/patches/ms.patch']])
  const other = '0'.repeat(64)
  t.assert.deepStrictEqual(await fromRepository({ hash: other, path: 'web/patches/ms.patch' }), { ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'invalid',
    patch: { hash: other, path: 'web/patches/ms.patch', from: 'repository', error: 'patch-mismatch' } }, 'one not of the hash it locks refused, its files held to those published')
  const missing = sha256('another patch')
  t.assert.deepStrictEqual((await packagesOf({ hash: missing }))[0], { ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'invalid', patch: { hash: missing, error: 'patch-not-found' } },
    'pnpm 11\'s, named by its hash alone, of no file the bundle holds')
  const unpatched = await validateBundle(plan, own(), { fetch: upstream(), locked: locked(null) })
  t.assert.deepStrictEqual(unpatched.problems.filter((problem) => problem.of !== 'own'), [{ path: 'node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' }],
    'locked unpatched: the bundle\'s patch named for it not taken')
})

test('validateBundle: each installed copy of a version held to its files patched or as published apart, the version fetched once', async (t) => {
  const fetched = []
  const plan = validationPlan(parsed({ 'node_modules/tool/node_modules/ms': { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } } }))
  plan.own = []
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  const report = await validateBundle(plan, own(), { fetch: upstream(PACKAGES, fetched) })
  t.assert.deepStrictEqual([report.status, report.problems, report.packages[0].patch], ['valid', [], { path: 'patches/ms@2.1.3.patch', from: 'bundle', applied: true }])
  t.assert.deepStrictEqual(fetched, ['npm:ms@2.1.3'])
})

test('validateBundle: an npm version its lockfile locks from git alone is left unverified; one recording a commit (a registry package\'s gitHead) held to the registry\'s', async (t) => {
  const fetched = []
  const gitHead = { github: 'vercel/ms', commit: 'a'.repeat(40) }
  const plan = validationPlan(parsed({ 'node_modules/ms': { name: 'ms', version: '2.1.3', repo: gitHead, files: { 'index.js': MS['index.js'] } }, 'node_modules/left': undefined }))
  plan.own = []
  plan.packages = plan.packages.filter((pkg) => pkg.name !== 'org/php')
  const registry = await validateBundle(plan, own(), { fetch: upstream(PACKAGES, fetched) })
  t.assert.deepStrictEqual(registry.packages.map((pkg) => [pkg.name, pkg.status, pkg.reason ?? null]), [['gone', 'unverified', 'not-published'], ['ms', 'valid', null]],
    'ms valid (told for the bundle\'s patch it is not patched with), its gitHead no sign of git')
  t.assert.deepStrictEqual(fetched.toSorted(), ['npm:gone@1.0.0', 'npm:ms@2.1.3'])

  fetched.length = 0
  const locked = { of: () => undefined, lock: (ecosystem, name, version) => (name === 'ms' && version === '2.1.3' ? { from: 'git' } : undefined), read: async () => '' }
  const report = await validateBundle(plan, own(), { fetch: upstream(PACKAGES, fetched), locked })
  t.assert.deepStrictEqual([report.status, report.problems, report.packages.map((pkg) => [pkg.name, pkg.status, pkg.reason ?? null])],
    ['incomplete', [], [['gone', 'unverified', 'not-published'], ['ms', 'unverified', 'git']]], 'locked from git: never held to the registry\'s')
  t.assert.deepStrictEqual(fetched, ['npm:gone@1.0.0'])
})

test('validateBundle: each version held to its lockfile: fetched with the integrity it locks, failing where upstream refuses the tarball or it locks none; one from elsewhere, or with no sha512, unverified', async (t) => {
  const plan = validationPlan(parsed({ 'node_modules/left': undefined }))
  plan.own = []
  const told = async (locks, fetch = upstream()) => {
    const locked = { lockfiles: ['pnpm-lock.yaml'], lock: (ecosystem, name, version) => locks[`${ecosystem}:${name}@${version}`], of: () => undefined }
    const report = await validateBundle(plan, own(), { fetch, locked })
    return [report.status, report.counts.lockFailures, report.packages.map((pkg) => [pkg.name, pkg.status, pkg.reason ?? null])]
  }
  const integrities = []
  const fetched = []
  t.assert.deepStrictEqual(await told({ 'npm:ms@2.1.3': { from: 'registry', integrity: SRI }, 'npm:gone@1.0.0': null }, upstream(PACKAGES, fetched, integrities)),
    ['invalid', 1, [['org/php', 'unverified', 'unsupported'], ['gone', 'invalid', 'not-locked'], ['ms', 'valid', null]]], 'gone, which it locks none of, failing')
  t.assert.deepStrictEqual([fetched, integrities], [['npm:ms@2.1.3'], [['npm:ms@2.1.3', SRI]]], 'ms fetched with the integrity it locks, gone never')
  // As upstream refuses a tarball that isn't the integrity given.
  const refusing = () => Promise.reject(new AssertionError({ message: `getTarball: integrity mismatch for ms@2.1.3 from https://registry.npmjs.org/ms/-/ms-2.1.3.tgz: expected ${SRI}, got another` }))
  t.assert.deepStrictEqual(await told({ 'npm:ms@2.1.3': { from: 'registry', integrity: SRI }, 'npm:gone@1.0.0': { from: 'registry', integrity: SRI } }, refusing),
    ['invalid', 2, [['org/php', 'unverified', 'unsupported'], ['gone', 'invalid', 'integrity-mismatch'], ['ms', 'invalid', 'integrity-mismatch']]])
  t.assert.deepStrictEqual(await told({ 'npm:ms@2.1.3': { from: 'elsewhere' }, 'npm:gone@1.0.0': { from: 'registry', integrity: undefined } }),
    ['incomplete', 0, [['org/php', 'unverified', 'unsupported'], ['gone', 'unverified', 'no-integrity'], ['ms', 'unverified', 'not-registry']]])
  t.assert.deepStrictEqual((await told({ 'npm:ms@2.1.3': { from: 'registry', conflict: true }, 'npm:gone@1.0.0': { from: 'git' } }))[2].slice(1),
    [['gone', 'unverified', 'git'], ['ms', 'invalid', 'integrity-conflict']])
})

test('validateBundle: own code unchecked leaves a bundle incomplete, as does a version past the deadline, or a tree cut short', async (t) => {
  const plan = validationPlan(parsed())
  plan.own = plan.own.filter((file) => file.path === 'src/main.js')
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  t.assert.equal((await validateBundle(plan, own(), { fetch: upstream() })).status, 'valid')
  const unchecked = await validateBundle(plan, { reason: 'no-repository' }, { fetch: upstream() })
  t.assert.deepStrictEqual([unchecked.status, unchecked.own, unchecked.counts.unverified, unchecked.problems], ['incomplete', { checked: false, reason: 'no-repository' }, 1, []])
  const late = await validateBundle(plan, own(), { fetch: upstream(), deadline: 0, now: () => 1 })
  t.assert.deepStrictEqual([late.status, late.packages[0].reason], ['incomplete', 'timeout'])
  plan.own = validationPlan(parsed()).own.filter((file) => file.path === 'src/extra.js')
  const cut = await validateBundle(plan, own(LISTED, { cut: true }), { fetch: upstream() })
  t.assert.deepStrictEqual([cut.status, cut.own.cut, cut.problems], ['incomplete', true, [{ path: 'src/extra.js', kind: 'unverified', of: 'own', reason: 'tree-cut' }]])
})

test('parsePatch and patchedFiles apply a patch as patch-package does: a hunk found near where it says, created, deleted and renamed files', (t) => {
  const files = new Map([['a.js', bytes('zero\none\ntwo\nthree\n')], ['gone.js', bytes('bye\n')], ['old.js', bytes('moved\n')]])
  const patch = parsePatch(`diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
diff --git a/gone.js b/gone.js
deleted file mode 100644
--- a/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/added.js b/added.js
new file mode 100644
--- /dev/null
+++ b/added.js
@@ -0,0 +1 @@
+hello
diff --git a/old.js b/new.js
similarity index 100%
rename from old.js
rename to new.js
`)
  const out = patchedFiles(files, patch)
  const text = (path) => new TextDecoder().decode(out.get(path))
  t.assert.deepStrictEqual([...out.keys()].toSorted(), ['a.js', 'added.js', 'new.js'])
  t.assert.deepStrictEqual([text('a.js'), text('added.js'), text('new.js')], ['zero\none\nTWO\nthree\n', 'hello\n', 'moved\n'], 'its hunk a line from where its header says')
  t.assert.throws(() => patchedFiles(new Map([['a.js', bytes('else\n')]]), patch.slice(0, 1)), { code: 'patch-does-not-apply' })
  t.assert.throws(() => parsePatch('diff --git a/x b/x\nGIT binary patch\n'), { code: 'patch-unsupported' })
})

test('patchedFiles keeps a byte order mark a file starts with, changing no byte but those its hunks change', (t) => {
  const files = new Map([['a.js', bytes('\uFEFFone\ntwo\nthree\n')]])
  const patch = parsePatch('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -2,2 +2,2 @@\n-two\n+TWO\n three\n')
  t.assert.deepStrictEqual([...patchedFiles(files, patch).get('a.js')], [...bytes('\uFEFFone\nTWO\nthree\n')])
})

test('validateBundle: a vendored crate\'s .cargo-checksum.json, which no crate holds, held to the crate: its package checksum and each file it lists', async (t) => {
  const lib = 'pub fn x() {}\n'
  const crate = Object.assign(new Map([['src/lib.rs', bytes(lib)], ['Cargo.toml', bytes('[package]\n')]]), { checksum: 'c'.repeat(64) })
  const checksumOf = (files, pkg = 'c'.repeat(64)) => JSON.stringify({ files, package: pkg })
  const of = (text) => validationPlan(Bundle.parse(new Bundle({ modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/main.rs': 'fn main() {}\n' } }],
    ['vendor/dep', { ecosystem: 'cargo', name: 'dep', version: '1.0.0', files: { 'src/lib.rs': lib, '.cargo-checksum.json': text } }],
  ]) }).serialize()))
  const run = async (text) => (await validateBundle(of(text), { reason: 'skipped' }, { fetch: async () => crate })).problems
  const listed = { 'src/lib.rs': createHash('sha256').update(lib).digest('hex') }
  t.assert.deepStrictEqual(await run(checksumOf(listed)), [])
  t.assert.deepStrictEqual(await run(checksumOf({ 'src/lib.rs': 'd'.repeat(64) })), [{ path: 'vendor/dep/.cargo-checksum.json', kind: 'differs', of: 'cargo:dep@1.0.0' }],
    'a file it lists not the crate\'s')
  t.assert.deepStrictEqual(await run(checksumOf(listed, 'e'.repeat(64))), [{ path: 'vendor/dep/.cargo-checksum.json', kind: 'differs', of: 'cargo:dep@1.0.0' }],
    'another crate\'s')
  t.assert.deepStrictEqual(await run('not json'), [{ path: 'vendor/dep/.cargo-checksum.json', kind: 'differs', of: 'cargo:dep@1.0.0' }])
})

test('tarballFiles and fetchPackage: a package\'s files as upstream fetches its tarball, held to its integrity, its top directory left out', async (t) => {
  const tgz = await compress(pack([{ name: 'package/index.js', data: bytes('x') }, { name: 'package/lib/', type: 'directory' }, { name: 'package/lib/a.js', data: bytes('a') }]), 'gzip')
  t.assert.deepStrictEqual([...(await tarballFiles(tgz)).keys()], ['index.js', 'lib/a.js'])
  const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`
  const tarball = 'https://registry.npmjs.org/stasis-validate-fixture/-/stasis-validate-fixture-1.0.0.tgz'
  t.mock.method(globalThis, 'fetch', async (input) => {
    const url = String(input)
    if (url === 'https://registry.npmjs.org/stasis-validate-fixture/1.0.0') return Response.json({ name: 'stasis-validate-fixture', version: '1.0.0', dist: { tarball, integrity } })
    if (url === tarball) return new Response(tgz)
    return Response.json({ error: 'Not found' }, { status: 404 })
  })
  const files = await fetchPackage('npm', 'stasis-validate-fixture', '1.0.0')
  t.assert.deepStrictEqual([...files.keys()], ['index.js', 'lib/a.js'])
  await t.assert.rejects(fetchPackage('npm', 'stasis-validate-fixture', '9.9.9'), HttpError)
  // Held to the integrity a lockfile locks it with, in place of its registry's: refused where another.
  t.assert.deepStrictEqual([...(await fetchPackage('npm', 'stasis-validate-fixture', '1.0.0', integrity)).keys()], ['index.js', 'lib/a.js'])
  await t.assert.rejects(fetchPackage('npm', 'stasis-validate-fixture', '1.0.0', SRI), (error) => fetchFailure(error) === 'integrity-mismatch')
})

// The repository as fakeClient serves it, with what `stasis validate` reads beside its trees: a file at
// the commit, as upstream's getRepoFile reads one.
const repoClient = (files) => Object.assign(fakeClient(files), {
  async getRepoFile({ path }) {
    if (typeof files[path] !== 'string') throw new Error(`getRepoFile: no file at ${path}`)
    return files[path]
  },
})
const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

patchedDependencies:
  ms@2.1.3:
    hash: ${sha256(MS_PATCH)}
    path: patches/ms@2.1.3.patch

importers:

  web:
    dependencies:
      ms:
        specifier: 2.1.3
        version: 2.1.3(patch_hash=${sha256(MS_PATCH)})

packages:

  ms@2.1.3:
    resolution: {integrity: sha512-${'A'.repeat(86)}==}

snapshots:

  ms@2.1.3(patch_hash=${sha256(MS_PATCH)}): {}
`

test('validate: the repository its bundle names, at its commit and directory, read with upstream; its dependencies held to the pnpm-lock.yaml there, or one given, or, asked, none', withTmp(async (t, tmp) => {
  const bundle = new Bundle({
    repo: { github: 'org/repo', directory: 'web', commit },
    modules: new Map([
      ['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
      ['node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': 'one\nTWO\nthree\n' } }],
    ]),
  })
  const file = join(tmp, 'app.stasis.code.br')
  writeFileSync(file, brotliCompressSync(bundle.serialize()))
  // The workspace's lockfile and patch at the repository's root, above the bundle's directory.
  const files = { 'web/src/main.js': 'main\n', 'web/package.json': '{}\n', 'pnpm-lock.yaml': PNPM_LOCK, 'patches/ms@2.1.3.patch': MS_PATCH }
  const client = repoClient(files)
  const integrities = []
  const report = await validate(file, { client, fetch: upstream(PACKAGES, [], integrities) })
  t.assert.deepStrictEqual([report.status, report.own, report.counts.matched, report.lockfiles], ['valid', { checked: true, repository: 'org/repo', commit, directory: 'web' }, 2, ['pnpm-lock.yaml']])
  t.assert.deepStrictEqual(integrities, [['npm:ms@2.1.3', SRI]], 'ms fetched with the integrity the lockfile locks')
  t.assert.deepStrictEqual(report.packages, [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 1, status: 'valid',
    patch: { hash: sha256(MS_PATCH), path: 'patches/ms@2.1.3.patch', from: 'repository', applied: true } }], 'its patch the lockfile\'s, read of the repository')
  t.assert.ok(client.calls.some(([method, , tree]) => method === 'getRepoTreeTarball' && tree === 'tree:web'), 'the bundle\'s directory\'s tree read')

  // Its dependencies alone: the repository's lockfile read, and nothing more.
  const trees = () => client.calls.filter(([method]) => method === 'getRepoTreeTarball').length
  const before = trees()
  const depsAlone = await validate(file, { client, fetch: upstream(), own: false })
  t.assert.deepStrictEqual([depsAlone.status, depsAlone.own, depsAlone.packages[0].patch.from, trees()], ['incomplete', { checked: false, reason: 'skipped' }, 'repository', before])
  // A lockfile given, its patch read beside it; held to none, the patch it locks unread.
  writeFileSync(join(tmp, 'pnpm-lock.yaml'), PNPM_LOCK)
  mkdirSync(join(tmp, 'patches'))
  writeFileSync(join(tmp, 'patches', 'ms@2.1.3.patch'), MS_PATCH)
  const given = await validate(file, { fetch: upstream(), own: false, lockfile: [join(tmp, 'pnpm-lock.yaml')] })
  t.assert.deepStrictEqual([given.status, given.lockfiles, given.packages[0].patch], ['incomplete', [join(tmp, 'pnpm-lock.yaml')],
    { hash: sha256(MS_PATCH), path: join(tmp, 'patches', 'ms@2.1.3.patch'), from: 'local', applied: true }])
  const unlocked = await validate(file, { fetch: upstream(), own: false, lockfile: false })
  t.assert.deepStrictEqual([unlocked.status, unlocked.lockfiles, unlocked.problems], ['invalid', null,
    [{ path: 'node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' }]], 'no lockfile read, so its patch neither, which the bundle holds none of')

  // A bundle naming no repository: refused, but for its dependencies alone held to a lockfile given or none.
  const nowhere = join(tmp, 'nowhere.stasis.code.br')
  writeFileSync(nowhere, brotliCompressSync(new Bundle({ modules: bundle.modules }).serialize()))
  await t.assert.rejects(validate(nowhere, { fetch: upstream() }), { name: 'ValidateError', code: 'no-repository' })
  await t.assert.rejects(validate(nowhere, { fetch: upstream(), own: false }), (error) => error instanceof ValidateError && error.code === 'no-repository' && /to read its lockfile of/u.test(error.message))
  t.assert.equal((await validate(nowhere, { fetch: upstream(), own: false, lockfile: false })).own.reason, 'skipped')
  const noCommit = join(tmp, 'no-commit.stasis.code.br')
  writeFileSync(noCommit, brotliCompressSync(new Bundle({ repo: { github: 'org/repo' }, modules: bundle.modules }).serialize()))
  await t.assert.rejects(validate(noCommit, { fetch: upstream() }), { code: 'no-commit' })
  await t.assert.rejects(validate(file, { fetch: upstream(), own: false, lockfile: [join(tmp, 'Cargo.lock')] }), { code: 'lockfile-unreadable' })
  const lines = { out: [], err: [] }
  printValidationReport(report, { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) })
  t.assert.deepStrictEqual(lines.out, ['valid\tnpm:ms@2.1.3\tpatched by patches/ms@2.1.3.patch'])
  t.assert.match(lines.err.join('\n'), /^valid: 2 of 2 files as they should be, 0 differ, 0 unexpected, 0 unverified; 1 of 1 packages as published\nOwn code held to org\/repo at 7{40} under web\nDependencies held to pnpm-lock\.yaml$/u)
}))

test('repositoryLockfiles: as each package manager finds its root, pnpm\'s (its workspace\'s), npm\'s and yarn\'s (the root whose workspaces take the package), else the nearest; a crate\'s the nearest Cargo.lock; refused where none is, or two package managers\' are', async (t) => {
  // The repository's files, `null` for one whose text doesn't matter.
  let files
  const list = async (dir) => Object.keys(files).filter((path) => (dir ? path.startsWith(`${dir}/`) : true) && !path.slice(dir ? dir.length + 1 : 0).includes('/')).map((path) => path.split('/').at(-1))
  const read = async (path) => files[path] ?? `text of ${path}`
  const find = async (...ecosystems) => (await repositoryLockfiles({ directory: 'web/app', ecosystems: new Set(ecosystems), list, read })).map((one) => one.path)
  const named = (name, more = {}) => JSON.stringify({ name, ...more })

  files = { 'web/app/package.json': named('app'), 'web/app/pnpm-lock.yaml': null, 'package.json': named('root'), 'pnpm-workspace.yaml': null, 'pnpm-lock.yaml': null, 'Cargo.lock': null }
  t.assert.deepStrictEqual(await find('npm', 'cargo'), ['pnpm-lock.yaml', 'Cargo.lock'], 'pnpm\'s workspace root\'s, not web/app\'s')
  t.assert.deepStrictEqual((await repositoryLockfiles({ directory: 'web/app', ecosystems: new Set(['npm']), list, read }))[0].text, 'text of pnpm-lock.yaml')
  files = { 'web/app/package.json': named('app'), 'web/app/pnpm-lock.yaml': null, 'package.json': named('root') }
  t.assert.deepStrictEqual(await find('npm'), ['web/app/pnpm-lock.yaml'], 'no workspace: the nearest')

  // npm's workspace root's, whatever package-lock.json is nearer; else the nearest beside a package.json.
  files = { 'web/app/package.json': named('app'), 'web/app/package-lock.json': null, 'package.json': named('root', { workspaces: ['web/*'] }), 'package-lock.json': null }
  t.assert.deepStrictEqual(await find('npm'), ['package-lock.json'], 'the workspace root\'s, not the member\'s')
  files['package.json'] = `\uFEFF${named('root', { workspaces: ['web/*'] })}`
  t.assert.deepStrictEqual(await find('npm'), ['package-lock.json'], 'a manifest starting with a byte order mark read, as npm reads it')
  files['package.json'] = named('root', { workspaces: ['web/*', '!web/app'] })
  t.assert.deepStrictEqual(await find('npm'), ['web/app/package-lock.json'], 'a workspace negated, its own')
  // npm-shrinkwrap.json before package-lock.json, at the root the package's is: not another project's above.
  files = { 'web/app/package.json': named('app'), 'web/app/package-lock.json': null, 'package.json': named('root'), 'npm-shrinkwrap.json': null }
  t.assert.deepStrictEqual(await find('npm'), ['web/app/package-lock.json'], 'an unrelated root\'s shrinkwrap passed over')
  files['web/app/npm-shrinkwrap.json'] = null
  t.assert.deepStrictEqual(await find('npm'), ['web/app/npm-shrinkwrap.json'])

  // yarn's workspace root's, whatever yarn.lock is nearer.
  files = { 'web/app/package.json': named('app'), 'web/app/yarn.lock': null, 'package.json': named('root', { workspaces: { packages: ['web/*'] } }), 'yarn.lock': null }
  t.assert.deepStrictEqual(await find('npm'), ['yarn.lock'])
  files['package.json'] = named('root', { workspaces: { packages: ['lib/*'] } })
  t.assert.deepStrictEqual(await find('npm'), ['web/app/yarn.lock'], 'a package none of its workspaces take: the nearest')

  files = { 'web/app/package.json': named('app'), 'web/app/package-lock.json': null, 'web/app/yarn.lock': null }
  await t.assert.rejects(find('npm'), { name: 'ValidateError', code: 'lockfile-ambiguous', message: /more than one lockfile installs web\/app: web\/app\/package-lock\.json, web\/app\/yarn\.lock/u })
  files = { 'web/app/package.json': named('app'), 'bun.lock': null }
  await t.assert.rejects(find('npm'), { code: 'lockfile-unsupported' })
  files = { 'web/app/package.json': named('app'), 'web/app/pnpm-lock.yaml': null, 'pnpm-workspace.yaml': null }
  await t.assert.rejects(find('npm'), { code: 'no-lockfile' }, 'a workspace root with no lockfile')
  await t.assert.rejects(find('cargo'), { code: 'no-lockfile' })
})

test('lockedBy: pnpm\'s versions from the registry with their integrity, from git (a git resolution, or a git host\'s tarball) alone, or none', (t) => {
  const at = 'a'.repeat(40)
  const lock = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      left:
        specifier: git+https://github.com/someone/left.git#${at}
        version: git+https://github.com/someone/left.git#${at}
      ms:
        specifier: github:someone/ms#${at}
        version: https://codeload.github.com/someone/ms/tar.gz/${at}
      gone:
        specifier: 1.0.0
        version: 1.0.0
      both:
        specifier: 1.0.0
        version: 1.0.0

  web:
    dependencies:
      both:
        specifier: git+https://github.com/someone/both.git#${at}
        version: git+https://github.com/someone/both.git#${at}

packages:

  both@1.0.0:
    resolution: {integrity: sha512-${'A'.repeat(86)}==}

  both@git+https://github.com/someone/both.git#${at}:
    resolution: {commit: ${at}, repo: https://github.com/someone/both.git, type: git}
    version: 1.0.0

  gone@1.0.0:
    resolution: {integrity: sha512-${'A'.repeat(86)}==}

  left@git+https://github.com/someone/left.git#${at}:
    resolution: {commit: ${at}, repo: https://github.com/someone/left.git, type: git}
    version: 1.0.0

  ms@https://codeload.github.com/someone/ms/tar.gz/${at}:
    resolution: {tarball: https://codeload.github.com/someone/ms/tar.gz/${at}, gitHosted: true}
    version: 2.1.3

snapshots:

  both@1.0.0: {}

  both@git+https://github.com/someone/both.git#${at}: {}

  gone@1.0.0: {}

  left@git+https://github.com/someone/left.git#${at}: {}

  ms@https://codeload.github.com/someone/ms/tar.gz/${at}: {}
`
  const locked = lockedBy([{ path: 'pnpm-lock.yaml', text: lock }])
  t.assert.deepStrictEqual(['left@1.0.0', 'ms@2.1.3', 'gone@1.0.0', 'both@1.0.0', 'absent@1.0.0'].map((pkg) => locked.lock('npm', ...pkg.split('@'))),
    [{ from: 'git' }, { from: 'git' }, { from: 'registry', integrity: SRI }, { from: 'registry', integrity: SRI }, null], 'one also from the registry held to it')
  t.assert.deepStrictEqual([locked.lockfiles, locked.locks('npm'), locked.locks('cargo'), locked.lock('cargo', 'serde', '1.0.0')], [['pnpm-lock.yaml'], true, false, undefined])
})

test('lockedBy: npm\'s, yarn\'s and Cargo\'s lockfiles, a registry\'s or a mirror\'s tarball with its sha512, git, elsewhere; one it can\'t read, or two of an ecosystem, refused', (t) => {
  const npm = `${JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { ms: '2.1.3', mirrored: '1.0.0', elsewhere: 'https://example.com/e.tgz', left: 'github:o/left' } },
    'node_modules/elsewhere': { version: '1.0.0', resolved: 'https://example.com/e.tgz', integrity: SRI },
    'node_modules/left': { version: '1.0.0', resolved: `git+ssh://git@github.com/o/left.git#${'a'.repeat(40)}` },
    'node_modules/mirrored': { version: '1.0.0', resolved: 'https://npm.example.com/repository/npm/mirrored/-/mirrored-1.0.0.tgz', integrity: SRI },
    'node_modules/ms': { version: '2.1.3', resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz', integrity: `${SRI} sha1-${'A'.repeat(27)}=` },
  } }, null, 2)}\n`
  const ofNpm = lockedBy([{ path: 'web/package-lock.json', text: npm }])
  t.assert.deepStrictEqual(lockedBy([{ path: 'package-lock.json', text: `\uFEFF${npm}` }]).lock('npm', 'ms', '2.1.3'), { from: 'registry', integrity: SRI }, 'one starting with a byte order mark read')
  t.assert.deepStrictEqual(['ms@2.1.3', 'mirrored@1.0.0', 'elsewhere@1.0.0', 'left@1.0.0'].map((pkg) => ofNpm.lock('npm', ...pkg.split('@'))),
    [{ from: 'registry', integrity: SRI }, { from: 'registry', integrity: SRI }, { from: 'elsewhere' }, { from: 'git' }], 'its sha512 alone, of two')
  t.assert.equal(ofNpm.of('ms', '2.1.3'), undefined, 'no patch npm locks')
  const yarn = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\nms@2.1.3:\n  version "2.1.3"\n  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#${'b'.repeat(40)}"\n  integrity ${SRI}\n\nold@1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/old/-/old-1.0.0.tgz#${'c'.repeat(40)}"\n`
  const ofYarn = lockedBy([{ path: 'yarn.lock', text: yarn }])
  t.assert.deepStrictEqual([ofYarn.lock('npm', 'ms', '2.1.3'), ofYarn.lock('npm', 'old', '1.0.0')], [{ from: 'registry', integrity: SRI }, { from: 'registry', integrity: undefined }], 'a sha1 alone no sha512')
  const cargo = `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "serde",\n "forked",\n]\n\n[[package]]\nname = "forked"\nversion = "1.0.0"\nsource = "git+https://github.com/o/forked?rev=${'d'.repeat(40)}#${'d'.repeat(40)}"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${'c'.repeat(64)}"\n`
  const ofCargo = lockedBy([{ path: 'Cargo.lock', text: cargo }, { path: 'yarn.lock', text: yarn }])
  t.assert.deepStrictEqual(['serde@1.0.0', 'forked@1.0.0', 'app@0.1.0'].map((pkg) => ofCargo.lock('cargo', ...pkg.split('@'))),
    [{ from: 'registry', integrity: 'c'.repeat(64) }, { from: 'git' }, { from: 'elsewhere' }])
  t.assert.deepStrictEqual(ofCargo.lockfiles, ['Cargo.lock', 'yarn.lock'])
  t.assert.throws(() => lockedBy([{ path: 'package-lock.json', text: npm }, { path: 'yarn.lock', text: yarn }]), { name: 'ValidateError', code: 'lockfile-ambiguous' })
  t.assert.throws(() => lockedBy([{ path: 'bun.lock', text: '{}' }]), { code: 'lockfile-unsupported' })
  t.assert.throws(() => lockedBy([{ path: 'yarn.lock', text: 'not a lockfile' }]), { code: 'lockfile-unreadable' })
})

test('stasis validate: own code skipped with --only-deps; a bundle with no repository refused unless asked for its dependencies alone, held to a lockfile given or, with --no-lockfile, none; a lockfile refused', withTmp((t, tmp) => {
  const file = join(tmp, 'own.stasis.code.br')
  writeFileSync(file, brotliCompressSync(new Bundle({ modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n' } }]]) }).serialize()))
  const run = (...args) => spawnSync(process.execPath, [cli, 'validate', ...args], { encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: tmp } })
  const skipped = run('--only-deps', file)
  t.assert.equal(skipped.status, 0, skipped.stderr)
  t.assert.match(skipped.stderr, /^incomplete: 0 of 1 files as they should be, 0 differ, 0 unexpected, 1 unverified; 0 of 0 packages as published\nOwn code not verified: skipped \(--only-deps\): its dependencies alone validated\n$/u)
  const unnamed = run(file)
  t.assert.deepStrictEqual([unnamed.status, unnamed.stdout], [1, ''])
  t.assert.match(unnamed.stderr, /^Error: .*own\.stasis\.code\.br records no repository to read its own code of: give --github=owner\/name and --sha=commit, or --only-deps to validate its dependencies alone\nRun 'stasis --help' for usage\.\n$/u)

  // With a dependency, its lockfile needed too: one given, which locks none of it, fails it unfetched.
  const deps = join(tmp, 'deps.stasis.code.br')
  writeFileSync(deps, brotliCompressSync(new Bundle({ modules: new Map([['node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': 'one\n' } }]]) }).serialize()))
  t.assert.match(run(deps).stderr, /records no repository to read its own code of: give --github=owner\/name and --sha=commit, or, to validate its dependencies alone, --only-deps with --lockfile=path or --no-lockfile\n/u)
  const unlocked = run('--only-deps', deps)
  t.assert.deepStrictEqual([unlocked.status, unlocked.stdout], [1, ''])
  t.assert.match(unlocked.stderr, /records no repository to read its lockfile of: give --github=owner\/name and --sha=commit, or --lockfile=path, or --no-lockfile to hold its dependencies to their registry alone\n/u)
  const lockfile = join(tmp, 'pnpm-lock.yaml')
  writeFileSync(lockfile, "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n")
  const locked = run('--only-deps', `--lockfile=${lockfile}`, deps)
  t.assert.deepStrictEqual([locked.status, locked.stdout], [1, 'invalid\tnpm:ms@2.1.3\tnot locked by the lockfile\n'], locked.stderr)
  t.assert.match(locked.stderr, /^invalid: 0 of 1 files as they should be, 0 differ, 0 unexpected, 1 unverified; 0 of 1 packages as published, 1 failing their lockfile\nOwn code not verified: skipped \(--only-deps\): its dependencies alone validated\nDependencies held to .*pnpm-lock\.yaml\n$/u)
  writeFileSync(join(tmp, 'deps.txt'), '')
  t.assert.match(run('--only-deps', `--lockfile=${join(tmp, 'deps.txt')}`, deps).stderr, /^Error: .*deps\.txt: not a lockfile validate reads/u)
  t.assert.match(run('--lockfile=x', '--no-lockfile', deps).stderr, /^Error: --lockfile and --no-lockfile: give one\n/u)

  const lock = join(tmp, 'stasis.lock.json')
  writeFileSync(lock, JSON.stringify({ version: 0, config: { scope: 'full' }, entries: [], sources: {}, modules: {}, imports: {}, formats: {} }))
  t.assert.match(run(lock).stderr, /^Error: .*stasis\.lock\.json is a lockfile, which holds no file to check; give a bundle\n/u)
  t.assert.equal(run().status, 1)
}))
