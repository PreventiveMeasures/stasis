import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { brotliCompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { HttpError, fetchPackage, gitBlobId, lockedPatches, parsePatch, patchedFiles, printValidationReport, tarballFiles, validate, validateBundle, validationPlan } from '../stasis/src/validate.js'
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
const upstream = (packages = PACKAGES, fetched = []) => async (ecosystem, name, version) => {
  fetched.push(`${ecosystem}:${name}@${version}`)
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
  t.assert.deepStrictEqual(report.counts, { files: 14, own: 8, dependencies: 6, matched: 6, eol: 1, differs: 3, unexpected: 3, unverified: 2, packages: 4, validPackages: 1 })
  // Own code read as bytes, as a tree's tarball has them, alike.
  const asBytes = Object.fromEntries(Object.entries(LISTED).map(([path, entry]) => [path, entry.sha === blob('main\n') ? { data: bytes('main\n') } : entry]))
  t.assert.deepStrictEqual((await validateBundle(validationPlan(parsed()), own(asBytes), { fetch: upstream(), now: () => 1 })).problems, report.problems)
})

test('validateBundle: a version its lockfile patches is held to that patch, of the bundle\'s file of its hash, else read of the repository; one it does not, as published', async (t) => {
  const plan = validationPlan(parsed({ 'node_modules/left': undefined }))
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  const read = []
  const locked = (lock) => ({ of: (name, version) => (name === 'ms' && version === '2.1.3' ? lock : undefined), read: async (hash, path) => (read.push([hash, path]), MS_PATCH) })
  const packagesOf = async (lock) => (await validateBundle(plan, own(), { fetch: upstream(), locked: locked(lock) })).packages
  t.assert.deepStrictEqual(await packagesOf({ hash: sha256(MS_PATCH), path: 'patches/elsewhere.patch' }), [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'valid',
    patch: { hash: sha256(MS_PATCH), path: 'patches/ms@2.1.3.patch', from: 'bundle', applied: true } }], 'the bundle\'s file of its hash')
  t.assert.deepStrictEqual(read, [])
  const hash = sha256('another patch')
  t.assert.deepStrictEqual((await packagesOf({ hash, path: 'web/patches/other.patch' }))[0].patch, { hash, path: 'web/patches/other.patch', from: 'repository', applied: true })
  t.assert.deepStrictEqual(read, [[hash, 'web/patches/other.patch']])
  t.assert.deepStrictEqual((await packagesOf({ hash }))[0], { ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'invalid', patch: { hash, error: 'patch-not-found' } },
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

test('validateBundle: an npm package installed from git, its commit recorded, is held apart from the registry\'s of its name and version, unverified', async (t) => {
  const fetched = []
  const fork = { github: 'someone/ms', commit: 'a'.repeat(40) }
  const plan = validationPlan(parsed({ 'node_modules/tool/node_modules/ms': { name: 'ms', version: '2.1.3', repo: fork, files: { 'index.js': 'forked\n' } } }))
  plan.own = []
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  t.assert.deepStrictEqual(plan.packages.map((pkg) => [pkg.files.map((file) => file.path), pkg.git]), [[['node_modules/ms/index.js', 'node_modules/ms/package.json'], undefined],
    [['node_modules/tool/node_modules/ms/index.js'], fork]])
  const report = await validateBundle(plan, own(), { fetch: upstream(PACKAGES, fetched) })
  t.assert.deepStrictEqual([report.status, report.problems, report.packages.map((pkg) => [pkg.status, pkg.reason ?? null, pkg.git ?? null])],
    ['incomplete', [], [['valid', null, null], ['unverified', 'git', fork]]], 'the registry\'s copy valid, the fork never held to it')
  t.assert.deepStrictEqual(fetched, ['npm:ms@2.1.3'])
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

test('validate: the repository its bundle names, at its commit and directory, read with upstream; pnpm\'s patches as the nearest pnpm-lock.yaml there locks them', withTmp(async (t, tmp) => {
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
  const report = await validate(file, { client, fetch: upstream() })
  t.assert.deepStrictEqual([report.status, report.own, report.counts.matched], ['valid', { checked: true, repository: 'org/repo', commit, directory: 'web' }, 2])
  t.assert.deepStrictEqual(report.packages, [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 1, status: 'valid',
    patch: { hash: sha256(MS_PATCH), path: 'patches/ms@2.1.3.patch', from: 'repository', applied: true } }], 'its patch the lockfile\'s, read of the repository')
  t.assert.ok(client.calls.some(([method, , tree]) => method === 'getRepoTreeTarball' && tree === 'tree:web'), 'the bundle\'s directory\'s tree read')

  const elsewhere = await validate(file, { client, fetch: upstream(), own: false })
  t.assert.deepStrictEqual([elsewhere.status, elsewhere.own, elsewhere.problems], ['invalid', { checked: false, reason: 'skipped' },
    [{ path: 'node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' }]], 'its repository unread, so its lockfile\'s patch too, which the bundle holds none of')
  t.assert.equal(await lockedPatches({ directory: 'web', list: async () => [], read: async () => '' }), null, 'no lockfile there')
  const lines = { out: [], err: [] }
  printValidationReport(report, { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) })
  t.assert.deepStrictEqual(lines.out, ['valid\tnpm:ms@2.1.3\tpatched by patches/ms@2.1.3.patch'])
  t.assert.match(lines.err.join('\n'), /^valid: 2 of 2 files as they should be, 0 differ, 0 unexpected, 0 unverified; 1 of 1 packages as published\nOwn code held to org\/repo at 7{40} under web$/u)
}))

test('lockedPatches: the workspace root\'s pnpm-lock.yaml, where pnpm-workspace.yaml is, whatever lockfile is nearer; else the nearest', async (t) => {
  const listings = { 'web/app': ['pnpm-lock.yaml', 'package.json'], web: ['package.json'], '': ['pnpm-workspace.yaml', 'pnpm-lock.yaml'] }
  const read = []
  const reading = async (path) => (read.push(path), PNPM_LOCK)
  const locked = await lockedPatches({ directory: 'web/app', list: async (dir) => listings[dir], read: reading })
  t.assert.deepStrictEqual([read, locked.of('ms', '2.1.3')], [['pnpm-lock.yaml'], { hash: sha256(MS_PATCH), path: 'patches/ms@2.1.3.patch' }], 'the root\'s, not web/app\'s')
  read.length = 0
  listings[''] = ['package.json'] // no workspace: the nearest
  await lockedPatches({ directory: 'web/app', list: async (dir) => listings[dir], read: reading })
  t.assert.deepStrictEqual(read, ['web/app/pnpm-lock.yaml'])
  t.assert.equal(await lockedPatches({ directory: 'web', list: async (dir) => (dir === '' ? ['pnpm-workspace.yaml'] : []), read: reading }), null, 'a workspace root with no lockfile')
})

test('stasis validate: own code skipped with --no-own, told unverified, exit 0; a lockfile refused', withTmp((t, tmp) => {
  const file = join(tmp, 'own.stasis.code.br')
  writeFileSync(file, brotliCompressSync(new Bundle({ modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n' } }]]) }).serialize()))
  const run = (...args) => spawnSync(process.execPath, [cli, 'validate', ...args], { encoding: 'utf8', env: { ...process.env, XDG_CACHE_HOME: tmp } })
  const skipped = run('--no-own', file)
  t.assert.equal(skipped.status, 0, skipped.stderr)
  t.assert.match(skipped.stderr, /^incomplete: 0 of 1 files as they should be, 0 differ, 0 unexpected, 1 unverified; 0 of 0 packages as published\nOwn code not verified: skipped \(--no-own\)\n$/u)
  const unnamed = run(file)
  t.assert.match(unnamed.stderr, /Own code not verified: the bundle records no repository; give --github/u)
  const lock = join(tmp, 'stasis.lock.json')
  writeFileSync(lock, JSON.stringify({ version: 0, config: { scope: 'full' }, entries: [], sources: {}, modules: {}, imports: {}, formats: {} }))
  t.assert.notEqual(run(lock).status, 0)
  t.assert.equal(run().status, 1)
}))
