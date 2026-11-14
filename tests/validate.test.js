import { test } from 'node:test'
import { AssertionError } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { stripVTControlCharacters, styleText } from 'node:util'
import { brotliCompressSync } from 'node:zlib'

import { toBase32 } from '@exodus/bytes/base32.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { githubBundleCommand } from '../stasis/src/cmd/github-bundle.js'
import { parseFileWithKind } from '../stasis/src/parse.js'
import { HttpError, ValidateError, configuredLockfiles, exitCodeOf, installedNpmPackages, lockedNpmPackages, fetchFailure, fetchPackage, followingMoves, gitBlobId, historyOf, lockedBy, parsePatch, patchedFiles, printValidationReport, repositoryLockfiles, tarballFiles, validate, validateBundle, validateRepository, validationPlan } from '../stasis/src/validate.js'
import { patchIntegrity } from '../stasis/src/installed.js'
import { DIM, takesColors } from '../stasis/src/table.js'
import { NPM_TOKEN_VARS } from '../stasis/src/cmd/tokens.js'
import { NOT_UTF8_NPMRC, NPM_TOKEN, tokenHome } from './tokens.helper.js'
import { fakeClient, json, lockfile as pnpmLockfile } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const commit = '7'.repeat(40)
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const blob = (text) => gitBlobId(Buffer.from(text))
const bytes = (text) => new TextEncoder().encode(text)
// A table's rows as printed, each its cells: its header's first, a cell's further lines rows of their own.
const rowsOf = (text) => text.split('\n').filter((line) => line.startsWith('│ ')).map((line) => line.slice(2, -2).split(' │ ').map((cell) => cell.trim()))
// A report as printed to streams, colourless but where asked: stdout, stderr, and stdout's rows.
const printed = (report, options) => {
  const text = { out: '', err: '' }
  const stream = (key) => ({ write: (chunk) => { text[key] += chunk } })
  printValidationReport(report, { out: stream('out'), err: stream('err'), colors: false, ...options })
  return { ...text, rows: rowsOf(text.out) }
}
const hasRow = (rows, row) => rows.some((cells) => JSON.stringify(cells) === JSON.stringify(row))

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
// A bundle written to `file`, as a `stasis.code.br` is.
const writeBundle = (file, bundle) => writeFileSync(file, brotliCompressSync((bundle instanceof Bundle ? bundle : new Bundle(bundle)).serialize()))
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
// A pnpm lockfile installing ms@2.1.3 from npm, `importer` its importer's id and `dependencies` its YAML.
const msLock = (importer, dependencies) => `lockfileVersion: '9.0'\n\nimporters:\n\n  ${importer}:\n    dependencies:\n${dependencies}\npackages:\n\n  ms@2.1.3:\n    resolution: {integrity: ${SRI}}\n\nsnapshots:\n\n  ms@2.1.3: {}\n`
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
    { path: 'src/changed.js', kind: 'differs', of: 'own' },
    { path: 'src/link.js', kind: 'differs', of: 'own', reason: 'symlink' },
    { path: 'node_modules/left/index.js', kind: 'differs', of: 'npm:left@1.0.0' },
    { path: 'src/extra.js', kind: 'unexpected', of: 'own' },
    { path: 'vendor/sub/x.js', kind: 'unexpected', of: 'own', reason: 'submodule' },
    { path: 'node_modules/left/injected.js', kind: 'unexpected', of: 'npm:left@1.0.0' },
  ])
  t.assert.deepStrictEqual(report.packages, [
    { ecosystem: 'npm', name: 'left', version: '1.0.0', files: 2, status: 'invalid' },
    { ecosystem: 'composer', name: 'org/php', version: '1.0.0', files: 1, status: 'unverified', reason: 'unsupported' },
    { ecosystem: 'npm', name: 'gone', version: '1.0.0', files: 1, status: 'unverified', reason: 'not-published' },
    { ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'valid', patch: { path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: true, applied: true } },
  ], 'ms as the patch the bundle holds named for it changes it, with no lockfile read, the patch as the repository has it')
  t.assert.deepStrictEqual(report.counts, { files: 14, own: 8, dependencies: 6, matched: 6, eol: 1, generated: 0, differs: 3, unexpected: 3, unverified: 2, skipped: 0, packages: 4, validPackages: 1, lockFailures: 0, misplaced: 0 })
  t.assert.equal(report.lockfiles, null, 'held to no lockfile')
  // Own code read as bytes, as a tree's tarball has them, alike.
  const asBytes = Object.fromEntries(Object.entries(LISTED).map(([path, entry]) => [path, entry.sha === blob('main\n') ? { data: bytes('main\n') } : entry]))
  t.assert.deepStrictEqual((await validateBundle(validationPlan(parsed()), own(asBytes), { fetch: upstream(), now: () => 1 })).problems, report.problems)
})

test('validateBundle: a version its lockfile patches is held to that patch, of the bundle\'s file of its hash, else read of the repository and held to its hash; one it does not, as published', async (t) => {
  const plan = validationPlan(parsed({ 'node_modules/left': undefined }))
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  const read = []
  const locked = (lock) => ({ of: (name, version) => (name === 'ms' && version === '2.1.3' ? lock : undefined), from: 'repository', read: async (path) => (read.push(path), MS_PATCH) })
  const packagesOf = async (lock) => (await validateBundle(plan, own(), { fetch: upstream(), locked: locked(lock) })).packages
  t.assert.deepStrictEqual(await packagesOf({ hash: sha256(MS_PATCH), path: 'patches/elsewhere.patch' }), [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'valid',
    patch: { hash: sha256(MS_PATCH), path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: true, applied: true } }], 'the bundle\'s file of its hash')
  t.assert.deepStrictEqual(read, [])
  // Read of the repository where the bundle holds no file of its hash, and held to that hash.
  const apart = { ...plan, patches: new Map() }
  const fromRepository = async (lock) => (await validateBundle(apart, own(), { fetch: upstream(), locked: locked(lock) })).packages[0]
  const hash = sha256(MS_PATCH)
  t.assert.deepStrictEqual((await fromRepository({ hash, path: 'web/patches/ms.patch' })).patch, { hash, path: 'web/patches/ms.patch', from: 'repository', applied: true })
  t.assert.deepStrictEqual(read, ['web/patches/ms.patch'])
  const other = '0'.repeat(64)
  t.assert.deepStrictEqual(await fromRepository({ hash: other, path: 'web/patches/ms.patch' }), { ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'invalid',
    patch: { hash: other, path: 'web/patches/ms.patch', from: 'repository', error: 'patch-mismatch' } }, 'one not of the hash it locks refused, its files held to those published')
  const md5 = toBase32(createHash('md5').update(MS_PATCH).digest(), { padding: false }).toLowerCase()
  t.assert.equal((await fromRepository({ hash: md5, path: 'web/patches/ms.patch' })).patch.error, 'patch-mismatch')
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
  plan.own = plan.own.filter((file) => plan.patches.has(file.path))
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  const report = await validateBundle(plan, own(), { fetch: upstream(PACKAGES, fetched) })
  t.assert.deepStrictEqual([report.status, report.problems, report.packages[0].patch], ['valid', [], { path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: true, applied: true }])
  t.assert.deepStrictEqual(fetched, ['npm:ms@2.1.3'])
})

test('validateBundle: where the lockfile locks a version with a patch, every copy is held to its files patched, one bundled as published differing', async (t) => {
  const plan = validationPlan(parsed({ 'node_modules/left': undefined, 'node_modules/tool/node_modules/ms': { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } } }))
  plan.own = plan.own.filter((file) => plan.patches.has(file.path))
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  const locked = { of: () => ({ hash: sha256(MS_PATCH), path: 'web/patches/ms@2.1.3.patch' }), from: 'repository', read: async () => MS_PATCH }
  const asPublished = [{ path: 'node_modules/tool/node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' }]
  const report = await validateBundle(plan, own(), { fetch: upstream(), locked })
  t.assert.deepStrictEqual([report.status, report.problems], ['invalid', asPublished])
  // Its patch not verified against the repository: the copy as published differs all the same.
  const unread = await validateBundle(plan, { reason: 'no-repository' }, { fetch: upstream(), locked })
  t.assert.deepStrictEqual([unread.status, unread.problems.filter((problem) => problem.of !== 'own')], ['invalid', asPublished])
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
  plan.own = plan.own.filter((file) => plan.patches.has(file.path))
  const told = async (locks, fetch = upstream()) => {
    const locked = { lockfiles: ['pnpm-lock.yaml'], lock: (ecosystem, name, version) => locks[`${ecosystem}:${name}@${version}`], of: () => undefined }
    const report = await validateBundle(plan, own(), { fetch, locked })
    return [report.status, report.counts.lockFailures, report.packages.map((pkg) => [pkg.name, pkg.status, pkg.reason ?? null])]
  }
  const integrities = []
  const fetched = []
  t.assert.deepStrictEqual(await told({ 'npm:ms@2.1.3': { from: 'registry', integrity: SRI }, 'npm:gone@1.0.0': null }, upstream(PACKAGES, fetched, integrities)),
    ['invalid', 1, [['gone', 'invalid', 'not-locked'], ['org/php', 'unverified', 'unsupported'], ['ms', 'valid', null]]], 'gone, which it locks none of, failing, told first')
  t.assert.deepStrictEqual([fetched, integrities], [['npm:ms@2.1.3'], [['npm:ms@2.1.3', SRI]]], 'ms fetched with the integrity it locks, gone never')
  // As upstream refuses a tarball that isn't the integrity given.
  const refusing = () => Promise.reject(new AssertionError({ message: `getTarball: integrity mismatch for ms@2.1.3 from https://registry.npmjs.org/ms/-/ms-2.1.3.tgz: expected ${SRI}, got another` }))
  t.assert.deepStrictEqual(await told({ 'npm:ms@2.1.3': { from: 'registry', integrity: SRI }, 'npm:gone@1.0.0': { from: 'registry', integrity: SRI } }, refusing),
    ['invalid', 2, [['gone', 'invalid', 'integrity-mismatch'], ['ms', 'invalid', 'integrity-mismatch'], ['org/php', 'unverified', 'unsupported']]])
  t.assert.deepStrictEqual(await told({ 'npm:ms@2.1.3': { from: 'elsewhere' }, 'npm:gone@1.0.0': { from: 'registry', integrity: undefined } }),
    ['incomplete', 0, [['org/php', 'unverified', 'unsupported'], ['gone', 'unverified', 'no-integrity'], ['ms', 'unverified', 'not-registry']]])
  t.assert.deepStrictEqual((await told({ 'npm:ms@2.1.3': { from: 'registry', conflict: true }, 'npm:gone@1.0.0': { from: 'git' } }))[2],
    [['ms', 'invalid', 'integrity-conflict'], ['org/php', 'unverified', 'unsupported'], ['gone', 'unverified', 'git']])
})

test('validateBundle: own code unchecked leaves a bundle incomplete, as does a version past the deadline, or a tree cut short', async (t) => {
  const plan = validationPlan(parsed())
  plan.own = plan.own.filter((file) => file.path === 'src/main.js' || plan.patches.has(file.path))
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  t.assert.equal((await validateBundle(plan, own(), { fetch: upstream() })).status, 'valid')
  // Unread, own code is unverified, and so are ms's files, which only the bundle's patch, unverified, makes as they should be.
  const unchecked = await validateBundle(plan, { reason: 'no-repository' }, { fetch: upstream() })
  t.assert.deepStrictEqual([unchecked.status, unchecked.own, unchecked.counts.unverified, unchecked.counts.skipped, unchecked.problems, unchecked.packages.map((pkg) => [pkg.status, pkg.reason, pkg.patch.verified])],
    ['incomplete', { checked: false, reason: 'no-repository' }, 4, 0, [], [['unverified', 'patch-unverified', false]]])
  // Skipped as asked, own code is no unverified file: the patch checked all the same, where the repository is read.
  const skipped = await validateBundle(plan, { reason: 'skipped', entries: own().entries, repository: 'org/repo', commit, directory: 'web' }, { fetch: upstream() })
  t.assert.deepStrictEqual([skipped.status, skipped.own, skipped.counts.skipped, skipped.counts.unverified, skipped.packages[0].patch.verified], ['valid', { checked: false, reason: 'skipped', patches: 1 }, 1, 0, true])
  const late = await validateBundle(plan, own(), { fetch: upstream(), deadline: 0, now: () => 1 })
  t.assert.deepStrictEqual([late.status, late.packages[0].reason], ['incomplete', 'timeout'])
  plan.own = validationPlan(parsed()).own.filter((file) => file.path === 'src/extra.js')
  const cut = await validateBundle(plan, own(LISTED, { cut: true }), { fetch: upstream() })
  t.assert.deepStrictEqual([cut.status, cut.own.cut, cut.problems], ['incomplete', true, [{ path: 'src/extra.js', kind: 'unverified', of: 'own', reason: 'tree-cut' }]])
})

test('validateBundle: own code with a checkout\'s CRLF line endings passes where every line\'s end is one, but for a binary, a shell script or an env file, whose meaning a CR changes', async (t) => {
  const told = async (path, bundled, repository, format) => {
    const content = format === 'resource:base64' ? Buffer.from(bundled, 'latin1').toString('base64') : bundled
    const plan = validationPlan(Bundle.parse(new Bundle({ config: { scope: 'full' }, entries: new Set(), modules: new Map([['.', { name: 'web', version: '1.0.0', files: { [path]: content } }]]),
      formats: new Map(format ? [[path, format]] : []) }).serialize()))
    const report = await validateBundle(plan, own({ [`web/${path}`]: { sha: blob(repository) } }), { fetch: upstream() })
    return [report.status, report.counts.eol, report.problems.map((problem) => problem.kind)]
  }
  t.assert.deepStrictEqual(await told('src/a.js', 'a\r\nb\r\n', 'a\nb\n', 'commonjs'), ['valid', 1, []])
  t.assert.deepStrictEqual(await told('README.md', 'a\r\n\r\nb\r\n', 'a\n\nb\n', 'resource'), ['valid', 1, []])
  t.assert.deepStrictEqual(await told('src/a.js', 'a\r\nb\n', 'a\nb\n', 'commonjs'), ['invalid', 0, ['differs']], 'a CR before some line ends alone: no checkout\'s')
  t.assert.deepStrictEqual(await told('src/a.js', 'a\rb\r\n', 'a\rb\n', 'commonjs'), ['valid', 1, []], 'a lone CR the repository has kept')
  const sensitive = [['run.sh', 'shell'], ['.env', 'env'], ['data.bin', 'resource:base64']]
  t.assert.deepStrictEqual(await Promise.all(sensitive.map(([path, format]) => told(path, 'x\r\ny\r\n', 'x\ny\n', format))), sensitive.map(() => ['invalid', 0, ['differs']]),
    'a binary, a shell script or an env file')
})

test('validateBundle: a package installed from a directory of the repository held to that directory\'s files there, where it is read; else unverified, never fetched', async (t) => {
  const fetched = []
  const plan = validationPlan(Bundle.parse(new Bundle({ modules: new Map([['node_modules/.pnpm/lib@file+lib/node_modules/lib', { name: 'lib', version: '2.0.0', files: { 'index.js': 'lib\n', 'package.json': '{}\n' } }]]) }).serialize()))
  const told = async (tree) => {
    const locked = { lockfiles: ['pnpm-lock.yaml'], lock: () => ({ from: 'local', directories: ['lib'] }), of: () => undefined, ...(tree && { tree: async (dir) => (dir === 'lib' ? new Map(Object.entries(tree).map(([path, text]) => [path, bytes(text)])) : new Map()) }) }
    const report = await validateBundle(plan, { reason: 'skipped' }, { fetch: upstream(PACKAGES, fetched), locked })
    return [report.status, report.problems, report.packages]
  }
  t.assert.deepStrictEqual(await told({ 'index.js': 'lib\n', 'package.json': '{}\n', 'other.js': 'not bundled\n' }), ['valid', [], []])
  t.assert.deepStrictEqual(await told({ 'index.js': 'edited\n' }), ['invalid', [
    { path: 'node_modules/.pnpm/lib@file+lib/node_modules/lib/index.js', kind: 'differs', of: 'npm:lib@2.0.0' },
    { path: 'node_modules/.pnpm/lib@file+lib/node_modules/lib/package.json', kind: 'unexpected', of: 'npm:lib@2.0.0' },
  ], [{ ecosystem: 'npm', name: 'lib', version: '2.0.0', files: 2, status: 'invalid', directory: 'lib' }]])
  t.assert.deepStrictEqual((await told(null)).slice(0, 1).concat([(await told(null))[2][0].reason]), ['incomplete', 'local'], 'the repository unread')
  t.assert.deepStrictEqual(fetched, [])
})

test('validateBundle: each npm copy held to where Node resolves it: the name its path installs it as, pnpm\'s store directory above it, an alias only as a lockfile tells it', async (t) => {
  const told = async (dir, { locked = null, name = 'ms', version = '2.1.3' } = {}) => {
    const plan = validationPlan(Bundle.parse(new Bundle({ modules: new Map([[dir, { name, version, files: { 'index.js': MS['index.js'] } }]]) }).serialize()))
    const report = await validateBundle(plan, { reason: 'skipped' }, { fetch: async () => new Map([['index.js', bytes(MS['index.js'])]]), locked })
    return [report.status, report.packages.map((pkg) => [pkg.status, pkg.reason ?? null, pkg.at ?? null])]
  }
  const valid = ['valid', []]
  t.assert.deepStrictEqual(await told('node_modules/ms'), valid)
  t.assert.deepStrictEqual(await told('node_modules/tool/node_modules/ms'), valid)
  t.assert.deepStrictEqual(await told('node_modules/@scope/pkg', { name: '@scope/pkg', version: '1.0.0' }), valid)
  // pnpm's store: its directory names the package and its version, its peers and patch after them.
  t.assert.deepStrictEqual(await told('node_modules/.pnpm/ms@2.1.3/node_modules/ms'), valid)
  t.assert.deepStrictEqual(await told('node_modules/.pnpm/ms@2.1.3_react@18.2.0/node_modules/ms'), valid)
  t.assert.deepStrictEqual(await told('node_modules/.pnpm/@scope+pkg@1.0.0/node_modules/@scope/pkg', { name: '@scope/pkg', version: '1.0.0' }), valid)
  t.assert.deepStrictEqual(await told('node_modules/.pnpm/ms@file+vendor+ms/node_modules/ms'), valid, 'a version no registry\'s: held to its lockfile alone')
  t.assert.deepStrictEqual(await told(`node_modules/.pnpm/ms@2.0.0_${'0123456789abcdef'.repeat(2)}/node_modules/ms`), valid, 'one pnpm hashed: its version not told')
  t.assert.deepStrictEqual(await told(`node_modules/.pnpm/ms@1.0.0-beta.123_${'0a'.repeat(16)}/node_modules/ms`, { version: '1.0.0-beta.1234567890' }), valid, 'one pnpm 10 cut short, its hash hex')
  const misplaced = (at) => ['invalid', [['invalid', 'misplaced', at]]]
  const others = ['node_modules/.pnpm/ms@2.0.0/node_modules/ms', 'node_modules/.pnpm/debug@2.1.3/node_modules/ms', 'node_modules/.pnpm/ms@2.1.3/node_modules/debug']
  t.assert.deepStrictEqual(await Promise.all(others.map((dir) => told(dir))), others.map(misplaced), 'another version or package, with no lockfile read')
  // Installed under another name: an alias, which only a lockfile tells; unverified where none is read.
  t.assert.deepStrictEqual(await told('node_modules/helmet'), ['incomplete', [['unverified', 'alias-unverified', 'node_modules/helmet']]])
  const pnpm = (dependencies) => lockedBy([{ path: 'pnpm-lock.yaml', text: msLock('.', dependencies) }])
  t.assert.deepStrictEqual(await told('node_modules/helmet', { locked: pnpm('      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n') }), misplaced('node_modules/helmet'), 'no alias the lockfile has')
  t.assert.deepStrictEqual(await told('node_modules/helmet', { locked: pnpm('      helmet:\n        specifier: npm:ms@2.1.3\n        version: ms@2.1.3\n') }), valid, 'pnpm\'s alias of it')

  // Each copy apart: one unverified as an alias leaves the others checked, in whatever order.
  const copies = async (modules) => {
    const plan = validationPlan(Bundle.parse(new Bundle({ modules: new Map(modules.map(([dir, text]) => [dir, { name: 'ms', version: '2.1.3', files: { 'index.js': text } }])) }).serialize()))
    const report = await validateBundle(plan, { reason: 'skipped' }, { fetch: async () => new Map([['index.js', bytes(MS['index.js'])]]) })
    return [report.status, report.counts.matched, report.problems.map((problem) => problem.path), report.packages.map((pkg) => [pkg.status, pkg.reason ?? null, pkg.at ?? null])]
  }
  t.assert.deepStrictEqual(await copies([['node_modules/helmet', MS['index.js']], ['node_modules/ms', 'changed\n']]),
    ['invalid', 0, ['node_modules/ms/index.js'], [['invalid', null, null]]], 'another copy differing')
  t.assert.deepStrictEqual(await copies([['node_modules/helmet', MS['index.js']], ['node_modules/.pnpm/ms@2.0.0/node_modules/ms', MS['index.js']]]),
    ['invalid', 0, [], [['invalid', 'misplaced', 'node_modules/.pnpm/ms@2.0.0/node_modules/ms']]], 'another copy misplaced, after it')
  t.assert.deepStrictEqual(await copies([['node_modules/helmet', MS['index.js']], ['node_modules/ms', MS['index.js']]]),
    ['incomplete', 1, [], [['unverified', 'alias-unverified', 'node_modules/helmet']]], 'another copy as it should be')
})

// npm's lockfile of an app installing ms@2.0.0, tool's ms@2.1.3 and an alias of it (helmet), at its
// root, or with `prefix` (`web/`), of the workspace web.
const OTHER_SRI = `sha512-${'B'.repeat(85)}A==`
const lockEntry = (name, version, integrity, more = {}) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity, ...more })
const npmLock = (prefix) => {
  const dependencies = { helmet: 'npm:ms@2.1.3', ms: '2.0.0', tool: '1.0.0' }
  return `${JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'app', version: '1.0.0', ...(prefix ? { workspaces: ['web'] } : { dependencies }) },
    ...(prefix && { web: { version: '1.0.0', dependencies }, 'node_modules/web': { resolved: 'web', link: true } }),
    [`${prefix}node_modules/helmet`]: { name: 'ms', ...lockEntry('ms', '2.1.3', SRI) },
    [`${prefix}node_modules/ms`]: lockEntry('ms', '2.0.0', OTHER_SRI),
    [`${prefix}node_modules/tool`]: lockEntry('tool', '1.0.0', OTHER_SRI, { dependencies: { ms: '2.1.3' } }),
    [`${prefix}node_modules/tool/node_modules/ms`]: lockEntry('ms', '2.1.3', SRI),
  } }, null, 2)}\n`
}

test('validateBundle: an npm copy held to the version npm\'s lockfile installs at its location, from the lockfile\'s directory (the bundle\'s root under it, or one of its importers on disk)', async (t) => {
  const told = async (dir, locked) => {
    const plan = validationPlan(Bundle.parse(new Bundle({ modules: new Map([[dir, { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } }]]) }).serialize()))
    const report = await validateBundle(plan, { reason: 'skipped' }, { fetch: async () => new Map([['index.js', bytes(MS['index.js'])]]), locked })
    return [report.status, report.packages.map((pkg) => [pkg.status, pkg.reason ?? null, pkg.at ?? null])]
  }
  const valid = ['valid', []]
  const misplaced = (at) => ['invalid', [['invalid', 'misplaced', at]]]
  const root = lockedBy([{ path: 'package-lock.json', text: npmLock('') }])
  t.assert.deepStrictEqual(await told('node_modules/tool/node_modules/ms', root), valid)
  t.assert.deepStrictEqual(await told('node_modules/helmet', root), valid, 'npm\'s alias of it there')
  t.assert.deepStrictEqual(await told('node_modules/ms', root), misplaced('node_modules/ms'), 'the version locked elsewhere, another here')
  t.assert.deepStrictEqual(await told('node_modules/other/node_modules/ms', root), misplaced('node_modules/other/node_modules/ms'), 'none installed there')
  // A bundle built in web, its lockfile the workspace's root's: its locations under web.
  const workspace = npmLock('web/')
  t.assert.deepStrictEqual(await told('node_modules/tool/node_modules/ms', lockedBy([{ path: 'package-lock.json', text: workspace, from: 'repository', root: 'web' }])), valid)
  t.assert.deepStrictEqual(await told('node_modules/ms', lockedBy([{ path: 'package-lock.json', text: workspace, from: 'repository', root: 'web' }])), misplaced('node_modules/ms'))
  t.assert.deepStrictEqual(await told('node_modules/tool/node_modules/ms', lockedBy([{ path: '/tmp/package-lock.json', text: workspace, from: 'local', root: 'web' }])), valid, 'on disk, its importer named for the bundle\'s directory')
  t.assert.deepStrictEqual(await told('node_modules/tool/node_modules/ms', lockedBy([{ path: '/tmp/package-lock.json', text: npmLock(''), from: 'local', root: 'web' }])), valid, 'on disk with no such importer: of its own directory')

  // A location npm links to a directory of the project: held to that directory's files, no version there.
  const linked = `${JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { lib: 'file:lib' } },
    lib: { version: '2.0.0' },
    'node_modules/lib': { resolved: 'lib', link: true },
  } }, null, 2)}\n`
  const tree = async (dir) => (dir === 'lib' ? new Map([['index.js', bytes('lib\n')]]) : new Map())
  const local = async (name) => {
    const plan = validationPlan(Bundle.parse(new Bundle({ modules: new Map([['node_modules/lib', { name, version: '2.0.0', files: { 'index.js': 'lib\n' } }]]) }).serialize()))
    const report = await validateBundle(plan, { reason: 'skipped' }, { fetch: upstream(), locked: lockedBy([{ path: 'package-lock.json', text: linked, from: 'repository', tree }]) })
    return [report.status, report.packages.map((pkg) => [pkg.status, pkg.reason ?? null, pkg.at ?? null])]
  }
  t.assert.deepStrictEqual(await local('lib'), valid, 'its directory\'s files')
  t.assert.deepStrictEqual(await local('other'), ['invalid', [['invalid', 'misplaced', 'node_modules/lib']]], 'another name there, which the lockfile has no alias of')

  // A `file:` override pnpm installs under the name it overrides (hoisted, `nodeLinker: hoisted`): the
  // directory's package there, whatever its own name, held to the directory's files.
  const overridden = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      ms:\n        specifier: file:local-ms\n        version: ms-fork@file:local-ms\n\npackages:\n\n  ms-fork@file:local-ms:\n    resolution: {directory: local-ms, type: directory}\n\nsnapshots:\n\n  ms-fork@file:local-ms: {}\n`
  const forkTree = async (dir) => (dir === 'local-ms' ? new Map([['index.js', bytes('fork\n')]]) : new Map())
  const fork = async (name, text = 'fork\n', lockfile = overridden) => {
    const plan = validationPlan(Bundle.parse(new Bundle({ modules: new Map([['node_modules/ms', { name, version: '2.0.0', files: { 'index.js': text } }]]) }).serialize()))
    const report = await validateBundle(plan, { reason: 'skipped' }, { fetch: upstream(), locked: lockedBy([{ path: 'pnpm-lock.yaml', text: lockfile, from: 'repository', tree: forkTree }]) })
    return [report.status, report.packages.map((pkg) => [pkg.status, pkg.reason ?? null, pkg.at ?? null])]
  }
  t.assert.deepStrictEqual(await fork('ms-fork'), valid, 'the overriding directory\'s package')
  t.assert.deepStrictEqual((await fork('ms-fork', 'tampered\n'))[0], 'invalid', 'its files the directory\'s all the same')
  t.assert.deepStrictEqual(await fork('other'), ['invalid', [['invalid', 'misplaced', 'node_modules/ms']]], 'another package than the directory\'s')
  // The same version locked from its registry too: which it is there, no lockfile tells, so neither is taken.
  const both = overridden.replace('    dependencies:\n', '    dependencies:\n      ms-fork:\n        specifier: 2.0.0\n        version: 2.0.0\n')
    .replace('packages:\n\n', `packages:\n\n  ms-fork@2.0.0:\n    resolution: {integrity: ${SRI}}\n\n`).replace('snapshots:\n\n', 'snapshots:\n\n  ms-fork@2.0.0: {}\n\n')
  t.assert.deepStrictEqual(await fork('ms-fork', 'fork\n', both), ['invalid', [['invalid', 'misplaced', 'node_modules/ms']]], 'its version also the registry\'s')
})

test('validateBundle: a patch the bundle holds is taken as the repository has it alone: refused where it differs, its files as patched unverified where that is not told', async (t) => {
  const plan = validationPlan(parsed({ 'node_modules/left': undefined }))
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  const report = await validateBundle(plan, own({ ...LISTED, 'web/patches/ms@2.1.3.patch': { sha: blob('another patch\n') } }), { fetch: upstream() })
  t.assert.deepStrictEqual([report.status, report.packages], ['invalid', [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, status: 'invalid',
    patch: { path: 'patches/ms@2.1.3.patch', from: 'bundle', error: 'patch-not-in-repository' } }]], 'its files held to those published')
  t.assert.deepStrictEqual(report.problems.filter((problem) => problem.path.includes('ms')), [
    { path: 'patches/ms@2.1.3.patch', kind: 'differs', of: 'own' },
    { path: 'node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' },
  ])
  const { rows } = printed(report)
  t.assert.ok(hasRow(rows, ['invalid', 'ms@2.1.3', 'its patch patches/ms@2.1.3.patch is the bundle\'s, not the repository\'s']), rows.join('\n'))
  const verified = printed(await validateBundle(plan, own(), { fetch: upstream() }), { showValid: true }).rows
  t.assert.ok(hasRow(verified, ['valid', 'ms@2.1.3', 'patched by patches/ms@2.1.3.patch (the bundle\'s, as the repository has it)']), verified.join('\n'))
  const unread = printed(await validateBundle(plan, { reason: 'no-repository' }, { fetch: upstream() })).rows
  t.assert.ok(hasRow(unread, ['unverified', 'ms@2.1.3', 'as patched by the bundle\'s patch, which isn\'t verified against the repository']), unread.join('\n'))
})

test('printValidationReport: files in a table, a row for each kind of each package\'s (own code first), the worst first; the packages with something to tell in another; statuses in colour where asked', (t) => {
  const report = {
    status: 'invalid', own: { checked: true, repository: 'org/repo', commit, directory: 'web' }, lockfiles: ['pnpm-lock.yaml'],
    counts: { files: 9, own: 4, dependencies: 5, matched: 2, eol: 0, differs: 3, unexpected: 2, unverified: 1, skipped: 0, packages: 5, validPackages: 1, lockFailures: 1 },
    problems: [
      { path: 'src/a.js', kind: 'differs', of: 'own' },
      { path: 'node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' },
      { path: 'node_modules/ms/readme.md', kind: 'differs', of: 'npm:ms@2.1.3' },
      { path: 'src/link.js', kind: 'unexpected', of: 'own', reason: 'symlink' },
      { path: 'vendor/serde/x.rs', kind: 'unexpected', of: 'crates:serde@1.0.0' },
      { path: 'src/far.js', kind: 'unverified', of: 'own', reason: 'tree-cut' },
    ],
    moreProblems: 2,
    packages: [
      { ecosystem: 'npm', name: 'gone', version: '1.0.0', status: 'invalid', reason: 'not-locked' },
      { ecosystem: 'npm', name: 'ms', version: '2.1.3', status: 'invalid' },
      { ecosystem: 'crates', name: 'serde', version: '1.0.0', status: 'invalid' },
      { ecosystem: 'composer', name: 'org/php', version: '1.0.0', status: 'unverified', reason: 'unsupported' },
      { ecosystem: 'npm', name: 'p', version: '1.0.0', status: 'valid', patch: { path: 'patches/p.patch', applied: true } },
    ],
  }
  const { out, rows } = printed(report)
  t.assert.deepStrictEqual(rows, [
    ['status', 'of', 'files'],
    ['differs', 'own code', 'src/a.js'],
    ['differs', 'ms@2.1.3', 'node_modules/ms/index.js'],
    ['', '', 'node_modules/ms/readme.md'],
    ['unexpected', 'own code', 'src/link.js (a symlink in the repository)'],
    ['unexpected', 'crates:serde@1.0.0', 'vendor/serde/x.rs'],
    ['unverified', 'own code', 'src/far.js (the repository\'s tree was too large to list whole)'],
    ['status', 'ecosystem', 'package', 'note'],
    ['invalid', 'npm', 'gone@1.0.0', 'not locked by the lockfile'],
    ['unverified', 'composer', 'org/php@1.0.0', 'no upstream package for its ecosystem'],
  ], 'those failing for their files alone, and the valid, but where asked, left out of the packages\'')
  t.assert.match(out, /┘\n\.\.\. and 2 more files\n\n┌/u)
  t.assert.deepStrictEqual(printed(report, { showValid: true }).rows.at(-1), ['valid', 'npm', 'p@1.0.0', 'patched by patches/p.patch'])

  const painted = printed(report, { colors: true })
  const styled = (format, text) => styleText(format, text, { validateStream: false })
  t.assert.ok(painted.out.includes(`│ ${styled('red', 'differs')}    │ ${styled(DIM, 'own code')}           │ src/a.js `), painted.out)
  t.assert.ok(painted.out.includes(`│ ${styled('yellow', 'unverified')} │ ${styled(DIM, 'own code')}`), 'unverified in yellow')
  t.assert.ok(painted.out.includes(`│            │                    │ node_modules/ms/readme.md`), 'a cell\'s further lines unstyled')
  t.assert.ok(painted.err.startsWith(`${styled(['bold', 'red'], 'invalid')}: 2 of 9 files`), painted.err)
  t.assert.deepStrictEqual(rowsOf(stripVTControlCharacters(painted.out)), rows, 'its widths those of its text unstyled')
})

test('takesColors: as @exodus/test tells it, CI\'s logs, or a terminal that has them; not a pipe', (t) => {
  const { CI } = process.env
  const told = (ci, stream) => {
    if (ci) process.env.CI = 'true'
    else delete process.env.CI
    return takesColors(stream)
  }
  try {
    t.assert.deepStrictEqual([told(false, {}), told(false, { hasColors: () => false }), told(false, { hasColors: () => true }), told(true, {})], [false, false, true, true])
  } finally {
    if (CI === undefined) delete process.env.CI
    else process.env.CI = CI
  }
})

test('exitCodeOf: 0 valid, 1 invalid, 2 incomplete, but 0 where unverified files are allowed', (t) => {
  t.assert.deepStrictEqual(['valid', 'invalid', 'incomplete'].map((status) => exitCodeOf({ status })), [0, 1, 2])
  t.assert.deepStrictEqual(['valid', 'invalid', 'incomplete'].map((status) => exitCodeOf({ status }, { allowUnverified: true })), [0, 1, 0])
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
  const listed = { 'src/lib.rs': sha256(lib) }
  const differs = [{ path: 'vendor/dep/.cargo-checksum.json', kind: 'differs', of: 'cargo:dep@1.0.0' }]
  t.assert.deepStrictEqual(await run(checksumOf(listed)), [])
  t.assert.deepStrictEqual(await run(checksumOf({ 'src/lib.rs': 'd'.repeat(64) })), differs, 'a file it lists not the crate\'s')
  t.assert.deepStrictEqual(await run(checksumOf(listed, 'e'.repeat(64))), differs, 'another crate\'s')
  t.assert.deepStrictEqual(await run('not json'), differs)
})

const COMPOSER_LOCK = readFileSync(fileURLToPath(new URL('fixtures/php-bundle/composer-lock/composer.lock', import.meta.url)), 'utf8')

test('validateBundle: a Composer or Soldeer package held to the composer.lock or soldeer.lock that locks its version, its files unverified', async (t) => {
  const of = (dir, info) => validationPlan(Bundle.parse(new Bundle({ modules: new Map([[dir, { version: '1.0.0', files: { 'a.txt': 'a\n' }, ...info }]]) }).serialize()))
  const run = async (plan, locked) => (await validateBundle(plan, { reason: 'skipped' }, { locked })).packages.map(({ status, reason }) => [status, reason])
  const composer = lockedBy([{ path: 'composer.lock', text: COMPOSER_LOCK }])
  const lib = (version) => of('vendor/acme/lib', { name: 'acme/lib', version, ecosystem: 'composer' })
  t.assert.deepStrictEqual(await run(lib('1.4.2'), composer), [['unverified', 'unsupported']])
  t.assert.deepStrictEqual(await run(lib('9.9.9'), composer), [['invalid', 'not-locked']])
  t.assert.deepStrictEqual(await run(lib('9.9.9'), null), [['unverified', 'unsupported']], 'with none read, as before')
  const soldeer = lockedBy([{ path: 'soldeer.lock', text: `[[dependencies]]\nname = "zipped"\nversion = "1.0.0"\nurl = "https://soldeer.example/zipped.zip"\nchecksum = "${'c'.repeat(64)}"\nintegrity = "${'0'.repeat(64)}"\n` }])
  t.assert.deepStrictEqual(await run(of('dependencies/zipped-1.0.0', { name: 'zipped', ecosystem: 'soldeer' }), soldeer), [['unverified', 'unsupported']])
  t.assert.deepStrictEqual(await run(of('dependencies/other-1.0.0', { name: 'other', ecosystem: 'soldeer' }), soldeer), [['invalid', 'not-locked']])
})

test("validate: a Composer package held to the composer.lock beside the bundle's directory", withTmp(async (t, tmp) => {
  const file = join(tmp, 'app.stasis.code.br')
  const bundle = (version) => writeBundle(file, { repo: { github: 'org/repo', directory: 'web', commit }, modules: new Map([
    ['vendor/acme/lib', { name: 'acme/lib', version, ecosystem: 'composer', files: { 'a.txt': 'a\n' } }],
  ]) })
  const run = async (files) => {
    const report = await validate(file, { client: repoClient(files), own: false, fetch: upstream() })
    return [report.status, report.lockfiles, report.packages.map(({ status, reason }) => [status, reason])]
  }
  bundle('9.9.9')
  t.assert.deepStrictEqual(await run({ 'web/composer.lock': COMPOSER_LOCK }), ['invalid', ['web/composer.lock'], [['invalid', 'not-locked']]])
  t.assert.deepStrictEqual(await run({ 'composer.lock': COMPOSER_LOCK, 'web/index.php': '<?php\n' }), ['incomplete', [], [['unverified', 'unsupported']]], 'one elsewhere than beside it: none read')
  bundle('1.4.2')
  t.assert.deepStrictEqual(await run({ 'web/composer.lock': COMPOSER_LOCK }), ['incomplete', ['web/composer.lock'], [['unverified', 'unsupported']]])
  // Read only of the repository, at a commit of its history: none to read it of, none read.
  const plan = validationPlan(parseFileWithKind(file).artifact)
  const alone = await validateRepository(plan, { repository: null }, { own: false })
  t.assert.deepStrictEqual([alone.status, alone.lockfiles, alone.packages.map(({ status, reason }) => [status, reason])], ['incomplete', [], [['unverified', 'unsupported']]])
  const given = await validateRepository(validationPlan(parseFileWithKind(file).artifact), { repository: null }, { own: false, lockfile: [{ path: 'composer.lock', text: COMPOSER_LOCK }] })
  t.assert.deepStrictEqual([given.lockfiles, given.packages.map(({ status, reason }) => [status, reason])], [['composer.lock'], [['unverified', 'unsupported']]], 'one given, read')
  const other = 'f'.repeat(40)
  await t.assert.rejects(validateRepository(plan, { repository: followingMoves(repoClient({ 'web/composer.lock': COMPOSER_LOCK }), 'org/repo'), commit: other, directory: 'web' }, { own: false }), (error) => error.code === 'commit-not-in-history')
}))

test('validateBundle: a crate\'s, Composer package\'s or Soldeer zip\'s recorded integrity held to its lockfile\'s', async (t) => {
  const sri = (algorithm, hex) => `${algorithm}-${Buffer.from(hex, 'hex').toString('base64')}`
  const of = (dir, info) => validationPlan(Bundle.parse(new Bundle({ modules: new Map([[dir, { version: '1.0.0', files: { 'a.txt': 'a\n' }, ...info }]]) }).serialize()))
  const asked = []
  const fetch = async (ecosystem, name, version, integrity) => (asked.push(integrity), Object.assign(new Map([['a.txt', bytes('a\n')]]), { checksum: 'c'.repeat(64) }))
  const cargo = (checksum) => lockedBy([{ path: 'Cargo.lock', text: `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["dep"]\n\n[[package]]\nname = "dep"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\n` }])
  const composer = (shasum) => lockedBy([{ path: 'composer.lock', text: `${JSON.stringify({ ...JSON.parse(COMPOSER_LOCK), packages: [{ name: 'acme/lib', version: '1.4.2', dist: { type: 'zip', url: 'https://example.com/acme/lib.zip', reference: 'a'.repeat(40), shasum }, type: 'library' }] }, null, 4)}\n` }])
  const soldeer = (checksum) => lockedBy([{ path: 'soldeer.lock', text: `[[dependencies]]\nname = "zipped"\nversion = "1.0.0"\nurl = "https://soldeer.example/zipped.zip"\nchecksum = "${checksum}"\nintegrity = "${'0'.repeat(64)}"\n` }])
  const crate = of('vendor/dep', { name: 'dep', ecosystem: 'cargo', integrity: sri('sha256', 'c'.repeat(64)) })
  const php = (hex) => of('vendor/acme/lib', { name: 'acme/lib', version: '1.4.2', ecosystem: 'composer', integrity: sri('sha1', hex) })
  const zip = of('dependencies/zipped-1.0.0', { name: 'zipped', ecosystem: 'soldeer', integrity: sri('sha256', 'c'.repeat(64)) })
  const notLocked = ['invalid', [['invalid', 'integrity-not-locked']]]
  const unsupported = ['incomplete', [['unverified', 'unsupported']]]
  const cases = [
    ['a crate none locks', crate, undefined, ['valid', []]],
    ['a crate Cargo.lock locks with it', crate, cargo('c'.repeat(64)), ['valid', []]],
    ['a crate Cargo.lock locks with another', crate, cargo('d'.repeat(64)), notLocked],
    ['Composer\'s', php('ab'.repeat(20)), composer('ab'.repeat(20)), unsupported],
    ['Composer\'s, locked with another', php('cd'.repeat(20)), composer('ab'.repeat(20)), notLocked],
    ['Composer\'s, locked with none, of an ecosystem none is fetched of', php('ab'.repeat(20)), composer(undefined), notLocked],
    ['Soldeer\'s', zip, soldeer('c'.repeat(64)), unsupported],
    ['Soldeer\'s, locked with another', zip, soldeer('d'.repeat(64)), notLocked],
  ]
  const told = await Promise.all(cases.map(([, plan, locked]) => validateBundle(plan, { reason: 'skipped' }, { fetch, locked }).then((report) => [report.status, report.packages.map(({ status, reason }) => [status, reason])])))
  for (const [i, [label, , , expected]] of cases.entries()) t.assert.deepStrictEqual(told[i], expected, label)
  t.assert.deepStrictEqual(asked, ['c'.repeat(64), 'c'.repeat(64)], 'its checksum, as Cargo.lock spells one')
})

test('validateBundle: a Soldeer git dependency held to its repository at the rev soldeer.lock locks', async (t) => {
  const rev = 'e'.repeat(40)
  const asked = []
  const git = async (at) => {
    asked.push(at)
    return new Map([['a.txt', bytes('a\n')]])
  }
  const locked = lockedBy([{ path: 'soldeer.lock', text: `[[dependencies]]\nname = "checked"\nversion = "1.0.0"\ngit = "https://github.com/o/checked.git"\nrev = "${rev}"\n`, git }])
  const checked = (text) => validateBundle(validationPlan(Bundle.parse(new Bundle({ modules: new Map([['dependencies/checked-1.0.0', { name: 'checked', version: '1.0.0', ecosystem: 'soldeer', files: { 'a.txt': text } }]]) }).serialize())), { reason: 'skipped' }, { locked })
  t.assert.equal((await checked('a\n')).status, 'valid')
  t.assert.deepStrictEqual(asked[0], { github: 'o/checked', commit: rev, path: '' })
  t.assert.deepStrictEqual((await checked('b\n')).problems, [{ path: 'dependencies/checked-1.0.0/a.txt', kind: 'differs', of: 'soldeer:checked@1.0.0' }])
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
// The fake GitHub client, its files read alone too, its listings with git's blob id of each file; its
// branches each with the commits in its history (`history`, main's the commit, its head another),
// and its tags each with its commit, as GitHub's compare and listings tell them.
const repoClient = (files, { history = { main: [commit] }, tags = {} } = {}) => {
  const client = fakeClient(files)
  const list = client.listRepoDir.bind(client)
  const headOf = (branch) => sha256(branch).slice(0, 40)
  return Object.assign(client, {
    getRepoHead: async () => ({ branch: 'main', oid: headOf('main') }),
    listRepoTags: async () => Object.entries(tags).map(([tag, oid]) => ({ tag, oid })),
    listRepoBranches: async () => Object.keys(history).map((branch) => ({ branch, oid: headOf(branch) })),
    async compareCommits({ base, head }) {
      if (!Object.values(history).flat().includes(base) && !Object.values(tags).includes(base)) throw new HttpError(404, `GET compare/${base}...${head} 404: {"message":"Not Found"}`)
      return { status: history[head]?.includes(base) ? 'ahead' : 'diverged' }
    },
    async getRepoFile({ path }) {
      if (typeof files[path] !== 'string') throw new Error(`getRepoFile: no file at ${path}`)
      return files[path]
    },
    async listRepoDir(options) {
      const at = (path) => (options.directory ? `${options.directory}/${path}` : path)
      return (await list(options)).map((entry) => (entry.type === 'blob' ? { ...entry, mode: '100644', sha: blob(files[at(entry.path)]) } : entry))
    },
    // The root's tree too.
    getRepoTreeId: ((treeId) => (options) => (options.directory === undefined ? 'tree:' : treeId(options)))(client.getRepoTreeId.bind(client)),
  })
}
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
    resolution: {integrity: ${SRI}}

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
  writeBundle(file, bundle)
  // The workspace's lockfile and patch at the repository's root, above the bundle's directory.
  const files = { 'web/src/main.js': 'main\n', 'web/package.json': '{}\n', 'pnpm-lock.yaml': PNPM_LOCK, 'patches/ms@2.1.3.patch': MS_PATCH }
  const client = repoClient(files)
  const integrities = []
  const report = await validate(file, { client, fetch: upstream(PACKAGES, [], integrities) })
  t.assert.deepStrictEqual([report.status, report.own, report.counts.matched, report.lockfiles], ['valid', { checked: true, repository: 'org/repo', commit, ref: { branch: 'main' }, directory: 'web' }, 2, ['pnpm-lock.yaml']])
  t.assert.deepStrictEqual(integrities, [['npm:ms@2.1.3', SRI]], 'ms fetched with the integrity the lockfile locks')
  t.assert.deepStrictEqual(report.packages, [{ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 1, status: 'valid',
    patch: { hash: sha256(MS_PATCH), path: 'patches/ms@2.1.3.patch', from: 'repository', applied: true } }], 'its patch the lockfile\'s, read of the repository')
  t.assert.ok(client.calls.some(([method, , tree]) => method === 'getRepoTreeTarball' && tree === 'tree:web'), 'the bundle\'s directory\'s tree read')

  // Its dependencies alone: the repository's lockfile read, and nothing more.
  const trees = () => client.calls.filter(([method]) => method === 'getRepoTreeTarball').length
  const before = trees()
  const depsAlone = await validate(file, { client, fetch: upstream(), own: false })
  t.assert.deepStrictEqual([depsAlone.status, depsAlone.own, depsAlone.packages[0].patch.from, trees()], ['valid', { checked: false, reason: 'skipped' }, 'repository', before])
  // A lockfile given, its patch read beside it; held to none, the patch it locks unread.
  writeFileSync(join(tmp, 'pnpm-lock.yaml'), PNPM_LOCK)
  mkdirSync(join(tmp, 'patches'))
  writeFileSync(join(tmp, 'patches', 'ms@2.1.3.patch'), MS_PATCH)
  const given = await validate(file, { fetch: upstream(), own: false, lockfile: [join(tmp, 'pnpm-lock.yaml')] })
  t.assert.deepStrictEqual([given.status, given.lockfiles, given.packages[0].patch], ['valid', [join(tmp, 'pnpm-lock.yaml')],
    { hash: sha256(MS_PATCH), path: join(tmp, 'patches', 'ms@2.1.3.patch'), from: 'local', applied: true }])
  const unlocked = await validate(file, { fetch: upstream(), own: false, lockfile: false })
  t.assert.deepStrictEqual([unlocked.status, unlocked.lockfiles, unlocked.problems], ['invalid', null,
    [{ path: 'node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' }]], 'no lockfile read, so its patch neither, which the bundle holds none of')

  // A bundle naming no repository: refused, but for its dependencies alone held to a lockfile given or none.
  const nowhere = join(tmp, 'nowhere.stasis.code.br')
  writeBundle(nowhere, { modules: bundle.modules })
  await t.assert.rejects(validate(nowhere, { fetch: upstream() }), { name: 'ValidateError', code: 'no-repository' })
  await t.assert.rejects(validate(nowhere, { fetch: upstream(), own: false }), (error) => error instanceof ValidateError && error.code === 'no-repository' && /to read its lockfile of/u.test(error.message))
  t.assert.equal((await validate(nowhere, { fetch: upstream(), own: false, lockfile: false })).own.reason, 'skipped')
  const noCommit = join(tmp, 'no-commit.stasis.code.br')
  writeBundle(noCommit, { repo: { github: 'org/repo' }, modules: bundle.modules })
  await t.assert.rejects(validate(noCommit, { fetch: upstream() }), { code: 'no-commit' })
  await t.assert.rejects(validate(file, { fetch: upstream(), own: false, lockfile: [join(tmp, 'Cargo.lock')] }), { code: 'lockfile-unreadable' })
  const lines = printed(report)
  t.assert.equal(lines.out, '', 'a package valid told on stdout but where asked')
  t.assert.deepStrictEqual(printed(report, { showValid: true }).rows, [['status', 'package', 'note'], ['valid', 'ms@2.1.3', 'patched by patches/ms@2.1.3.patch']])
  t.assert.match(lines.err, /^valid: 2 of 2 files as they should be, 0 differ, 0 unexpected, 0 unverified; 1 of 1 packages as published\nOwn code held to org\/repo at 7{40} of main under web\nDependencies held to pnpm-lock\.yaml\n$/u)
}))

test('repositoryLockfiles: as the build finds each package manager\'s root, pnpm\'s (its workspace\'s), npm\'s and yarn\'s (the root whose workspaces take the package), else the nearest; a crate\'s beside its Cargo workspace\'s root; refused where none is, or two package managers\' are', async (t) => {
  // The repository's files, `null` for one whose text doesn't matter.
  let files
  const list = async (dir) => Object.keys(files).filter((path) => (dir ? path.startsWith(`${dir}/`) : true) && !path.slice(dir ? dir.length + 1 : 0).includes('/')).map((path) => path.split('/').at(-1))
  const read = async (path) => files[path] ?? `text of ${path}`
  const find = async (...ecosystems) => (await repositoryLockfiles({ directory: 'web/app', ecosystems: new Set(ecosystems), list, read })).map((one) => one.path)
  const named = (name, more = {}) => JSON.stringify({ name, ...more })

  files = { 'web/app/package.json': named('app'), 'web/app/pnpm-lock.yaml': null, 'web/app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n', 'package.json': named('root'),
    'pnpm-workspace.yaml': null, 'pnpm-lock.yaml': null, 'Cargo.toml': '[workspace]\nmembers = ["web/app"]\n', 'Cargo.lock': null }
  t.assert.deepStrictEqual(await find('npm', 'cargo'), ['pnpm-lock.yaml', 'Cargo.lock'], 'pnpm\'s workspace root\'s, not web/app\'s; the Cargo workspace root\'s')
  t.assert.deepStrictEqual((await repositoryLockfiles({ directory: 'web/app', ecosystems: new Set(['npm']), list, read }))[0].text, 'text of pnpm-lock.yaml')
  files = { 'web/app/package.json': named('app'), 'web/app/pnpm-lock.yaml': null, 'package.json': named('root') }
  t.assert.deepStrictEqual(await find('npm'), ['web/app/pnpm-lock.yaml'], 'no workspace: the nearest')

  // npm's workspace root's, whatever package-lock.json is nearer; else the nearest beside a package.json.
  files = { 'web/app/package.json': named('app'), 'web/app/package-lock.json': null, 'package.json': named('root', { workspaces: ['web/*'] }), 'package-lock.json': null }
  t.assert.deepStrictEqual(await find('npm'), ['package-lock.json'], 'the workspace root\'s, not the member\'s')
  files['package.json'] = `\uFEFF${named('root', { workspaces: ['web/*'] })}`
  t.assert.deepStrictEqual(await find('npm'), ['package-lock.json'], 'a manifest starting with a byte order mark read, as npm reads it')
  files['package.json'] = named('root', { workspaces: ['lib/*'] })
  t.assert.deepStrictEqual(await find('npm'), ['web/app/package-lock.json'], 'a package no workspace takes: its own')
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
  // A Cargo.lock above a crate no workspace there takes is another project's.
  files = { 'web/app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\n', 'Cargo.lock': null }
  await t.assert.rejects(find('cargo'), { code: 'no-lockfile' })
  files['web/app/Cargo.lock'] = null
  t.assert.deepStrictEqual(await find('cargo'), ['web/app/Cargo.lock'])
})

test('installedNpmPackages: the registry\'s versions the lockfile installing a directory locks, found as the build finds it, read of the disk', withTmp(async (t, tmp) => {
  const write = (files) => {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(tmp, rel)), { recursive: true })
      // As npm writes its lockfile, which it is read as.
      writeFileSync(join(tmp, rel), typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`)
    }
  }
  // npm's, of a workspace: found at its root from the workspace's directory; a git version left out.
  write({
    'npm/package.json': { name: 'app', workspaces: ['web'] },
    'npm/web/package.json': { name: 'web', version: '1.0.0' },
    'npm/package-lock.json': { name: 'app', lockfileVersion: 3, requires: true, packages: {
      '': { name: 'app', workspaces: ['web'] },
      web: { version: '1.0.0', dependencies: { debug: '4.3.4', forked: 'github:acme/forked', ms: '2.1.3' } },
      'node_modules/web': { resolved: 'web', link: true },
      'node_modules/ms': lockEntry('ms', '2.1.3', SRI),
      'node_modules/debug': lockEntry('debug', '4.3.4', SRI, { dependencies: { ms: '2.0.0' } }),
      'node_modules/debug/node_modules/ms': lockEntry('ms', '2.0.0', SRI),
      'node_modules/forked': { version: '1.0.0', resolved: `git+ssh://git@github.com/acme/forked.git#${'a'.repeat(40)}` },
    } },
  })
  const npm = await installedNpmPackages(join(tmp, 'npm', 'web'))
  t.assert.equal(npm.path, join(tmp, 'npm', 'package-lock.json'))
  t.assert.deepStrictEqual(npm.packages.map(({ name, version }) => `${name}@${version}`).toSorted(), ['debug@4.3.4', 'ms@2.0.0', 'ms@2.1.3'], 'forked, from git, left out')
  // pnpm's.
  write({ 'pnpm/package.json': { name: 'app' }, 'pnpm/pnpm-lock.yaml': msLock('.', '      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n') })
  t.assert.deepStrictEqual((await installedNpmPackages(join(tmp, 'pnpm'))).packages, [{ name: 'ms', version: '2.1.3' }])
  // None at or above it.
  write({ 'none/package.json': { name: 'app' } })
  const outside = await installedNpmPackages(join(tmp, 'none'))
  t.assert.ok(outside === null || !outside.path.startsWith(tmp), 'none in the directory or above it, of the project')
  // Two package managers': refused, as audit tells it.
  write({ 'both/package.json': { name: 'app' }, 'both/pnpm-lock.yaml': msLock('.', '      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n'), 'both/package-lock.json': { name: 'app', lockfileVersion: 3, packages: { '': { name: 'app' } } } })
  await t.assert.rejects(installedNpmPackages(join(tmp, 'both')), (error) => error instanceof ValidateError && error.code === 'lockfile-ambiguous' && !error.message.includes('--lockfile'))
}))

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
    resolution: {integrity: ${SRI}}

  both@git+https://github.com/someone/both.git#${at}:
    resolution: {commit: ${at}, repo: https://github.com/someone/both.git, type: git}
    version: 1.0.0

  gone@1.0.0:
    resolution: {integrity: ${SRI}}

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
    [{ from: 'git', at: { github: 'someone/left', commit: at, path: '' } }, { from: 'git', at: { github: 'someone/ms', commit: at, path: '' } }, { from: 'registry', integrity: SRI }, { from: 'registry', integrity: SRI }, null], 'one also from the registry held to it; of git, the repository and commit')
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
    [{ from: 'registry', integrity: SRI }, { from: 'registry', integrity: SRI }, { from: 'elsewhere', integrity: SRI }, { from: 'git', at: { github: 'o/left', commit: 'a'.repeat(40), path: '' } }], 'its sha512 alone, of two; elsewhere, the one it locks it with, which a copy may record')
  t.assert.equal(ofNpm.of('ms', '2.1.3'), undefined, 'no patch npm locks')
  const yarn = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\nms@2.1.3:\n  version "2.1.3"\n  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#${'b'.repeat(40)}"\n  integrity ${SRI}\n\nold@1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/old/-/old-1.0.0.tgz#${'c'.repeat(40)}"\n\n"left@github:o/left":\n  version "1.0.0"\n  resolved "https://codeload.github.com/o/left/tar.gz/${'a'.repeat(40)}"\n`
  const ofYarn = lockedBy([{ path: 'yarn.lock', text: yarn }])
  t.assert.deepStrictEqual(['ms@2.1.3', 'old@1.0.0', 'left@1.0.0'].map((pkg) => ofYarn.lock('npm', ...pkg.split('@'))),
    [{ from: 'registry', integrity: SRI }, { from: 'registry', integrity: undefined }, { from: 'git', at: { github: 'o/left', commit: 'a'.repeat(40), path: '' } }], 'a sha1 alone no sha512; GitHub\'s tarball of a commit, git, as pnpm\'s')
  const cargo = `version = 4\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = [\n "serde",\n "forked",\n]\n\n[[package]]\nname = "forked"\nversion = "1.0.0"\nsource = "git+https://github.com/o/forked?rev=${'d'.repeat(40)}#${'d'.repeat(40)}"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${'c'.repeat(64)}"\n`
  const ofCargo = lockedBy([{ path: 'Cargo.lock', text: cargo }, { path: 'yarn.lock', text: yarn }])
  t.assert.deepStrictEqual(['serde@1.0.0', 'forked@1.0.0', 'app@0.1.0'].map((pkg) => ofCargo.lock('cargo', ...pkg.split('@'))),
    [{ from: 'registry', integrity: 'c'.repeat(64) }, { from: 'git' }, { from: 'elsewhere' }])
  t.assert.deepStrictEqual(ofCargo.lockfiles, ['Cargo.lock', 'yarn.lock'])
  t.assert.throws(() => lockedBy([{ path: 'package-lock.json', text: npm }, { path: 'yarn.lock', text: yarn }]), { name: 'ValidateError', code: 'lockfile-ambiguous' })
  t.assert.throws(() => lockedBy([{ path: 'bun.lock', text: '{}' }]), { code: 'lockfile-unsupported' })
  t.assert.throws(() => lockedBy([{ path: 'yarn.lock', text: 'not a lockfile' }]), { code: 'lockfile-unreadable' })
})

test('lockedBy: a package installed from a directory of the project, by pnpm, npm or yarn, locked by its name to that directory, from the repository\'s root; a tarball\'s left elsewhere', (t) => {
  const pnpm = `lockfileVersion: '9.0'\n\nimporters:\n\n  web:\n    dependencies:\n      lib:\n        specifier: file:../lib\n        version: file:lib\n\npackages:\n\n  lib@file:lib:\n    resolution: {directory: lib, type: directory}\n\nsnapshots:\n\n  lib@file:lib: {}\n`
  t.assert.deepStrictEqual(lockedBy([{ path: 'repo/pnpm-lock.yaml', text: pnpm }]).lock('npm', 'lib', '2.0.0'), { from: 'local', directories: ['repo/lib'] })
  const npm = `${JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { lib: 'file:../lib' } },
    '../lib': { version: '2.0.0' },
    'node_modules/lib': { resolved: '../lib', link: true },
  } }, null, 2)}\n`
  t.assert.deepStrictEqual(lockedBy([{ path: 'web/package-lock.json', text: npm }]).lock('npm', 'lib', '2.0.0'), { from: 'local', directories: ['lib'] })
  const yarn = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n"lib@file:./lib":\n  version "2.0.0"\n\n"linked@link:./linked":\n  version "0.0.0"\n`
  const ofYarn = lockedBy([{ path: 'yarn.lock', text: yarn }])
  t.assert.deepStrictEqual([ofYarn.lock('npm', 'lib', '2.0.0'), ofYarn.lock('npm', 'linked', '0.0.0'), ofYarn.lock('npm', 'other', '1.0.0')], [{ from: 'local', directories: ['lib'] }, { from: 'local', directories: ['linked'] }, null])
  const tarball = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      tgz:\n        specifier: file:vendor/tgz-1.0.0.tgz\n        version: file:vendor/tgz-1.0.0.tgz\n\npackages:\n\n  tgz@file:vendor/tgz-1.0.0.tgz:\n    resolution: {integrity: ${SRI}, tarball: file:vendor/tgz-1.0.0.tgz}\n    version: 1.0.0\n\nsnapshots:\n\n  tgz@file:vendor/tgz-1.0.0.tgz: {}\n`
  t.assert.deepStrictEqual(lockedBy([{ path: 'pnpm-lock.yaml', text: tarball }]).lock('npm', 'tgz', '1.0.0'), { from: 'elsewhere', integrity: SRI })
})

test('validate: a dependency from a directory of the repository held to its files there; a patch the bundle holds checked against the repository with its own code skipped', withTmp(async (t, tmp) => {
  const lock = `lockfileVersion: '9.0'\n\nimporters:\n\n  web:\n    dependencies:\n      lib:\n        specifier: file:../lib\n        version: file:lib\n\npackages:\n\n  lib@file:lib:\n    resolution: {directory: lib, type: directory}\n\nsnapshots:\n\n  lib@file:lib: {}\n`
  const files = { 'web/src/main.js': 'main\n', 'web/package.json': '{}\n', 'pnpm-lock.yaml': lock, 'lib/index.js': 'lib\n', 'lib/package.json': '{"name":"lib","version":"2.0.0"}\n' }
  const file = join(tmp, 'web.stasis.code.br')
  const write = (index) => writeBundle(file, { repo: { github: 'org/repo', directory: 'web', commit }, modules: new Map([
    ['.', { name: 'web', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
    ['node_modules/.pnpm/lib@file+lib/node_modules/lib', { name: 'lib', version: '2.0.0', files: { 'index.js': index } }],
  ]) })
  write('lib\n')
  const client = repoClient(files)
  t.assert.deepStrictEqual([(await validate(file, { client })).status, (await validate(file, { client, own: false })).status], ['valid', 'valid'])
  write('edited\n')
  const edited = await validate(file, { client, own: false })
  t.assert.deepStrictEqual([edited.status, edited.packages], ['invalid', [{ ecosystem: 'npm', name: 'lib', version: '2.0.0', files: 1, status: 'invalid', directory: 'lib' }]])

  // Its own code skipped, the patch the bundle holds checked all the same, by the blob id the repository lists.
  const patched = join(tmp, 'patched.stasis.code.br')
  const bundle = { repo: { github: 'org/repo', directory: 'web', commit }, modules: new Map([
    ['.', { name: 'web', version: '1.0.0', files: { 'src/main.js': 'main\n', 'patches/ms@2.1.3.patch': MS_PATCH } }],
    ['node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': 'one\nTWO\nthree\n' } }],
  ]) }
  writeBundle(patched, bundle)
  const held = await validate(patched, { client: repoClient({ ...files, 'web/patches/ms@2.1.3.patch': MS_PATCH }), own: false, lockfile: false, fetch: upstream() })
  t.assert.deepStrictEqual([held.status, held.own, held.counts.skipped, held.packages[0].patch], ['valid', { checked: false, reason: 'skipped', patches: 1 }, 1, { path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: true, applied: true }])
  const other = await validate(patched, { client: repoClient({ ...files, 'web/patches/ms@2.1.3.patch': 'another patch\n' }), own: false, lockfile: false, fetch: upstream() })
  t.assert.deepStrictEqual([other.status, other.packages[0].patch.error], ['invalid', 'patch-not-in-repository'])
  const none = await validate(patched, { client: repoClient(files), own: false, lockfile: false, fetch: upstream() })
  t.assert.deepStrictEqual([none.status, none.problems.find((problem) => problem.of === 'own')], ['invalid', { path: 'patches/ms@2.1.3.patch', kind: 'unexpected', of: 'own' }], 'one the repository has none of')
}))

test('validate: a patch pnpm 11 names by its hash alone is the file of that hash in the project\'s patches directory, else the root\'s', withTmp(async (t, tmp) => {
  const hash = sha256(MS_PATCH)
  // As pnpm 11 writes it: the patch's hash alone, its file in its settings.
  const lock = PNPM_LOCK.replace(`  ms@2.1.3:\n    hash: ${hash}\n    path: patches/ms@2.1.3.patch\n`, `  ms@2.1.3: ${hash}\n`)
  t.assert.deepStrictEqual(lockedBy([{ path: 'pnpm-lock.yaml', text: lock }]).of('ms', '2.1.3'), { hash, names: ['ms@2.1.3.patch'] })
  const file = join(tmp, 'web.stasis.code.br')
  writeBundle(file, { repo: { github: 'org/repo', directory: 'web', commit }, modules: new Map([
    ['.', { name: 'web', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
    ['node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': 'one\nTWO\nthree\n' } }],
  ]) })
  const files = { 'web/src/main.js': 'main\n', 'web/package.json': '{}\n', 'pnpm-lock.yaml': lock }
  const patchOf = async (more) => {
    const report = await validate(file, { client: repoClient({ ...files, ...more }), fetch: upstream() })
    return [report.status, report.packages[0].patch]
  }
  const found = (path) => ['valid', { hash, path, from: 'repository', applied: true }]
  t.assert.deepStrictEqual(await patchOf({ 'web/patches/ms@2.1.3.patch': MS_PATCH }), found('web/patches/ms@2.1.3.patch'), 'the project\'s')
  t.assert.deepStrictEqual(await patchOf({ 'patches/ms@2.1.3.patch': MS_PATCH }), found('patches/ms@2.1.3.patch'), 'the root\'s')
  t.assert.deepStrictEqual(await patchOf({ 'web/patches/ms@2.1.3.patch': 'another patch\n', 'patches/ms@2.1.3.patch': MS_PATCH }), found('patches/ms@2.1.3.patch'),
    'the project\'s not of its hash: the root\'s')
  t.assert.deepStrictEqual(await patchOf({ 'patches/ms@2.1.3.patch': 'another patch\n' }), ['invalid', { hash, error: 'patch-not-found' }], 'none of its hash')
}))

test('validate: a repository renamed or transferred followed, as GitHub redirects its API, to the name it has now, asked once by its id', withTmp(async (t, tmp) => {
  const files = { 'web/src/main.js': 'main\n', 'web/package.json': '{}\n', 'pnpm-lock.yaml': PNPM_LOCK, 'patches/ms@2.1.3.patch': MS_PATCH }
  const asked = []
  // GitHub's API for a repository moved: 301, to it by its id.
  const moved = (client) => Object.assign(Object.create(client), Object.fromEntries(['getRepoTreeId', 'getRepoTreeTarball', 'listRepoDir', 'getRepoFile', 'getRepoHead', 'listRepoTags', 'listRepoBranches', 'compareCommits'].map((method) => [method, async (options) => {
    asked.push([method, options.repo])
    if (options.repo === 'org/old') throw new HttpError(301, 'GET https://api.github.com/repos/org/old 301: {"message":"Moved Permanently"}', new Headers({ location: 'https://api.github.com/repositories/7' }))
    return client[method](options)
  }])), {
    async getRepo(options) {
      asked.push(['getRepo', options.repo, options.followRedirect])
      return { id: 7, full_name: 'org/repo' }
    },
  })
  const file = join(tmp, 'old.stasis.code.br')
  writeBundle(file, { repo: { github: 'org/old', directory: 'web', commit }, modules: new Map([
    ['.', { name: 'web', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
    ['node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': 'one\nTWO\nthree\n' } }],
  ]) })
  const report = await validate(file, { client: moved(repoClient(files)), fetch: upstream() })
  t.assert.deepStrictEqual([report.status, report.own], ['valid', { checked: true, repository: 'org/repo', movedFrom: 'org/old', commit, ref: { branch: 'main' }, directory: 'web' }])
  t.assert.deepStrictEqual(asked.filter(([method]) => method === 'getRepo'), [['getRepo', 'org/old', true]], 'its name asked once')
  t.assert.ok(asked.every(([method, repo]) => method === 'getRepo' || repo === 'org/repo' || repo === 'org/old'))
  const { err } = printed(report)
  t.assert.ok(err.split('\n').includes(`Own code held to org/repo (moved from org/old) at ${commit} of main under web`), err)

  // Another redirect, of no other name: refused as GitHub answered it.
  const same = Object.assign(Object.create(repoClient(files)), { async getRepoTreeId() { throw new HttpError(301, 'Moved Permanently') }, getRepo: async () => ({ id: 7, full_name: 'org/repo' }) })
  await t.assert.rejects(followingMoves(same, 'org/repo').getRepoTreeId({ sha: commit }), { name: 'HttpError', status: 301 })
}))

test('validate: a bundle carrying content for a payload-free stat record is refused as it is read, not validated without that content', withTmp(async (t, tmp) => {
  const file = join(tmp, 'stat.stasis.code.br')
  writeFileSync(file, brotliCompressSync(JSON.stringify({ version: 1, config: { scope: 'full' }, entries: ['src/main.js'], formats: { 'src/main.js': 'commonjs', 'src/evil.js': 'stat:file' }, imports: {},
    sources: { '.': { name: 'app', version: '1.0.0', files: { 'src/main.js': "require('./evil.js')\n", 'src/evil.js': "console.log('evil')\n" } } }, repo: { github: 'org/repo', commit } })))
  await t.assert.rejects(validate(file, { own: false, lockfile: false, fetch: upstream() }),
    (error) => error.cause?.message === 'bundle: \'src/evil.js\' is a payload-free \'stat:file\' record, yet carries content')
}))

test('followingMoves: each read it wraps one upstream\'s client has, as the CLI runs it', async (t) => {
  // As the CLI loads it, of the stasis package.
  const { createClient } = await import(pathToFileURL(createRequire(join(here, '..', 'stasis', 'package.json')).resolve('@preventive/upstream/github.js')).href)
  const client = createClient({ token: null })
  const wrapped = Object.keys(followingMoves(client, 'org/repo')).filter((method) => method !== 'name')
  t.assert.ok(wrapped.includes('compareCommits') && wrapped.includes('listRepoBranches'))
  t.assert.deepStrictEqual(wrapped.filter((method) => typeof client[method] !== 'function'), [], 'none the fake client alone has')
})

test('historyOf: the ref of the repository holding a commit in its history, its default branch first, then a tag or a branch at it, then another branch; none for a fork\'s', async (t) => {
  const fork = 'f'.repeat(40)
  const release = 'e'.repeat(40)
  const compared = []
  const repository = (options) => {
    const client = repoClient({}, options)
    const compare = client.compareCommits.bind(client)
    client.compareCommits = (asked) => (compared.push(asked.head), compare(asked))
    return followingMoves(client, 'org/repo')
  }
  t.assert.deepStrictEqual(await historyOf(repository(), commit), { branch: 'main' })
  t.assert.deepStrictEqual(await historyOf(repository({ history: { main: [], release: [release] } }), release), { branch: 'release' }, 'another branch\'s history')
  t.assert.deepStrictEqual(await historyOf(repository({ history: { main: [] }, tags: { 'v1.0.0': release } }), release), { tag: 'v1.0.0' })
  const head = sha256('release').slice(0, 40)
  t.assert.deepStrictEqual(await historyOf(repository({ history: { main: [], release: [] } }), head), { branch: 'release' }, 'a branch at it, GitHub knowing none in common with the default branch')
  compared.length = 0
  t.assert.equal(await historyOf(repository({ history: { main: [commit], release: [release], other: [] } }), fork), null, 'a fork\'s commit, in no history of the repository\'s')
  t.assert.deepStrictEqual(compared.toSorted(), ['main', 'other', 'release'], 'each branch compared')
  const limited = repoClient({})
  limited.compareCommits = async () => {
    throw new HttpError(403, 'GET compare 403: {"message":"API rate limit exceeded"}')
  }
  await t.assert.rejects(historyOf(followingMoves(limited, 'org/repo'), commit), { name: 'HttpError', status: 403 }, 'GitHub refusing, as it refuses')
})

test('historyOf: other branches compared `maxCompared` at most, none past `deadline`; where those left uncompared might hold the commit, it can\'t tell', async (t) => {
  const release = 'e'.repeat(40)
  const repository = () => followingMoves(repoClient({}, { history: { main: [], a: [], b: [release], c: [] } }), 'org/repo')
  t.assert.deepStrictEqual(await historyOf(repository(), release, { maxCompared: 2 }), { branch: 'b' }, 'held by one compared')
  t.assert.equal(await historyOf(repository(), 'f'.repeat(40), { maxCompared: 3 }), null, 'held by none, each compared')
  await t.assert.rejects(historyOf(repository(), release, { maxCompared: 1 }), { name: 'ValidateError', code: 'history-unread',
    message: `${release} is at no tag or branch head of org/repo nor in its default branch's history, and 2 of its 3 other branches were left uncompared (1 compared at most): give --sha= a commit of its default branch or at a tag` })
  await t.assert.rejects(historyOf(repository(), release, { deadline: 0, now: () => 1 }), { code: 'history-unread', message: /, and 3 of its 3 other branches were left uncompared past the deadline: /u })
})

test('validateRepository: own code held to a listing of the commit\'s tree, its lockfile found by it; `strict` false, a commit not of its history or no lockfile told, not thrown', async (t) => {
  const lock = msLock('web', '      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n')
  const files = { 'web/src/main.js': 'main\n', 'web/package.json': '{}\n', 'pnpm-lock.yaml': lock }
  const client = repoClient(files)
  client.listRepoDir = client.getRepoTreeTarball = async () => {
    throw new Error('read of the listing alone')
  }
  const repository = followingMoves(client, 'org/repo')
  const plan = validationPlan(new Bundle({ repo: { github: 'org/repo', directory: 'web', commit }, modules: new Map([
    ['.', { name: 'web', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
    ['node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } }],
  ]) }))
  const asked = []
  const listTree = async (paths) => {
    asked.push(paths)
    return { entries: [{ path: 'web', mode: '040000', type: 'tree', sha: blob('') }, ...Object.entries(files).map(([path, text]) => ({ path, mode: '100644', type: 'blob', sha: blob(text) }))], cut: false }
  }
  const where = { repository, commit, directory: 'web' }
  const report = await validateRepository(plan, where, { listTree, fetch: upstream() })
  t.assert.deepStrictEqual([report.status, report.own, report.lockfiles, 'lockfileError' in report], ['valid', { checked: true, repository: 'org/repo', commit, ref: { branch: 'main' }, directory: 'web' }, ['pnpm-lock.yaml'], false])
  t.assert.deepStrictEqual(asked, [['web/src/main.js', 'web/package.json']], 'its own files\' paths, and its directory\'s')

  // Its tree cut short: own code unverified; the directories it doesn't list asked for alone, its lockfile found by them.
  const none = async () => ({ entries: [], cut: true })
  const cut = await validateRepository(plan, { ...where, repository: followingMoves(repoClient(files), 'org/repo') }, { listTree: none, fetch: upstream() })
  t.assert.deepStrictEqual([cut.status, cut.own.cut, cut.lockfiles, cut.problems], ['incomplete', true, ['pnpm-lock.yaml'], [{ path: 'src/main.js', kind: 'unverified', of: 'own', reason: 'tree-cut' }]])
  // No lockfile: refused, or, `strict` false, the dependencies held to their registry alone, and why.
  const unlocked = { 'web/src/main.js': 'main\n', 'web/package.json': '{}\n' }
  const listUnlocked = async () => ({ entries: Object.entries(unlocked).map(([path, text]) => ({ path, mode: '100644', type: 'blob', sha: blob(text) })), cut: false })
  await t.assert.rejects(validateRepository(plan, where, { listTree: listUnlocked, fetch: upstream() }), { name: 'ValidateError', code: 'no-lockfile' })
  const held = await validateRepository(plan, where, { listTree: listUnlocked, strict: false, fetch: upstream() })
  t.assert.deepStrictEqual([held.status, held.lockfiles, held.lockfileError], ['valid', null, 'no-lockfile'])
  // Cut short of the bundle's directory: its files asked for alone, its own lockfile found there, not the root's.
  const nearer = { 'pnpm-lock.yaml': msLock('.', ''), 'web/pnpm-lock.yaml': msLock('.', '      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n'), 'web/package.json': '{}\n' }
  const rootOnly = async () => ({ entries: [{ path: 'pnpm-lock.yaml', mode: '100644', type: 'blob', sha: blob(nearer['pnpm-lock.yaml']) }, { path: 'web', mode: '040000', type: 'tree', sha: blob('') }], cut: true })
  const near = await validateRepository(plan, { ...where, repository: followingMoves(repoClient(nearer), 'org/repo') }, { listTree: rootOnly, fetch: upstream() })
  t.assert.deepStrictEqual([near.lockfiles, near.packages.map((pkg) => pkg.status)], [['web/pnpm-lock.yaml'], []])

  // A commit of a fork's: its tree not listed, nor its lockfile read.
  asked.length = 0
  const fork = { ...where, commit: 'f'.repeat(40) }
  const forked = await validateRepository(plan, fork, { listTree, strict: false, fetch: upstream() })
  t.assert.deepStrictEqual([forked.status, forked.own, forked.lockfiles, forked.lockfileError, asked], ['incomplete', { checked: false, reason: 'commit-not-in-history' }, null, 'commit-not-in-history', []])
  await t.assert.rejects(validateRepository(plan, fork, { listTree, fetch: upstream() }), { name: 'ValidateError', code: 'commit-not-in-history' })

  // An own file at a path no tree has, not asked for: unexpected, the tree cut short or not.
  const odd = { ...plan, own: [...plan.own, { path: '../x.js', dir: '.', rel: '../x.js', format: 'commonjs', bytes: () => bytes('x\n') }] }
  asked.length = 0
  const outside = await validateRepository(odd, where, { listTree, fetch: upstream() })
  t.assert.deepStrictEqual([outside.status, outside.problems.map((problem) => [problem.path, problem.kind]), asked], ['invalid', [['../x.js', 'unexpected']], [['web/src/main.js', 'web/package.json']]])
  const cutOutside = await validateRepository(odd, where, { listTree: async (paths) => ({ ...await listTree(paths), cut: true }), fetch: upstream() })
  t.assert.deepStrictEqual([cutOutside.status, cutOutside.problems.map((problem) => [problem.path, problem.kind, problem.reason ?? null])], ['invalid', [['../x.js', 'unexpected', null]]])

  // Own code or the repository's lockfile with no repository or commit to read it of: refused, or, `strict` false, told.
  asked.length = 0
  await Promise.all([[{ repository, directory: 'web' }, 'no-commit'], [{ commit, directory: 'web' }, 'no-repository']].map(async ([at, code]) => {
    await t.assert.rejects(validateRepository(plan, at, { listTree, fetch: upstream() }), { name: 'ValidateError', code })
    await t.assert.rejects(validateRepository(plan, at, { own: false, fetch: upstream() }), { name: 'ValidateError', code }, 'its lockfile read there')
    const told = await validateRepository(plan, at, { listTree, strict: false, fetch: upstream() })
    t.assert.deepStrictEqual([told.status, told.own, told.lockfiles, told.lockfileError], ['incomplete', { checked: false, reason: code }, null, code])
    const depsAlone = await validateRepository(plan, at, { own: false, strict: false, fetch: upstream() })
    t.assert.deepStrictEqual([depsAlone.status, depsAlone.own, depsAlone.lockfileError], ['valid', { checked: false, reason: 'skipped' }, code], 'its own code skipped as asked, its lockfile unread')
  }))
  t.assert.deepStrictEqual(asked, [], 'nothing listed')
  t.assert.equal((await validateRepository(plan, { directory: 'web' }, { own: false, lockfile: false, fetch: upstream() })).own.reason, 'skipped', 'neither read')
})

test('validate: own code, a lockfile or the patches the bundle holds read of a commit in the repository\'s own history alone, a fork\'s refused', withTmp(async (t, tmp) => {
  const fork = 'f'.repeat(40)
  const files = { 'web/src/main.js': 'main\n', 'web/package.json': '{}\n', 'pnpm-lock.yaml': PNPM_LOCK, 'web/patches/ms@2.1.3.patch': MS_PATCH }
  const file = join(tmp, 'fork.stasis.code.br')
  writeBundle(file, { repo: { github: 'org/repo', directory: 'web', commit: fork }, modules: new Map([
    ['.', { name: 'web', version: '1.0.0', files: { 'src/main.js': 'main\n', 'patches/ms@2.1.3.patch': MS_PATCH } }],
    ['node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': 'one\nTWO\nthree\n' } }],
  ]) })
  const refused = { name: 'ValidateError', code: 'commit-not-in-history', message: `${fork} is in the history of no branch or tag of org/repo (a fork's, say, which GitHub serves through its name too): give --sha= a commit of its own` }
  await t.assert.rejects(validate(file, { client: repoClient(files), fetch: upstream() }), refused)
  await t.assert.rejects(validate(file, { client: repoClient(files), sha: fork, fetch: upstream() }), refused, 'one given, too')
  await t.assert.rejects(validate(file, { client: repoClient(files), own: false, fetch: upstream() }), refused, 'its lockfile read there')
  await t.assert.rejects(validate(file, { client: repoClient(files), own: false, lockfile: false, fetch: upstream() }), refused, 'the patches the bundle holds checked there')
  const held = await validate(file, { client: repoClient(files, { history: { main: [], 'release/1.x': [fork] } }), fetch: upstream() })
  t.assert.deepStrictEqual([held.status, held.own.ref], ['valid', { branch: 'release/1.x' }], 'one of a branch of its own')
  t.assert.ok(printed(held).err.includes(`Own code held to org/repo at ${fork} of release/1.x under web`))
  const tagged = await validate(file, { client: repoClient(files, { history: { main: [] }, tags: { 'v1.0.0': fork } }), fetch: upstream() })
  t.assert.ok(printed(tagged).err.includes(`Own code held to org/repo at ${fork}, tag v1.0.0 under web`))
}))

test('validate: a dependency from the repository\'s root (`file:.`) held to the root\'s files, its directory read as the root', withTmp(async (t, tmp) => {
  const lock = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      self:\n        specifier: file:.\n        version: 'file:'\n\npackages:\n\n  'self@file:':\n    resolution: {directory: '', type: directory}\n\nsnapshots:\n\n  'self@file:': {}\n`
  t.assert.deepStrictEqual(lockedBy([{ path: 'pnpm-lock.yaml', text: lock }]).lock('npm', 'self', '1.0.0'), { from: 'local', directories: [''] })
  const files = { 'index.js': 'self\n', 'package.json': '{"name":"self","version":"1.0.0"}\n', 'src/main.js': 'main\n', 'pnpm-lock.yaml': lock }
  const file = join(tmp, 'root.stasis.code.br')
  writeBundle(file, { repo: { github: 'org/repo', commit }, modules: new Map([
    ['.', { name: 'self', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
    ['node_modules/.pnpm/self@file+/node_modules/self', { name: 'self', version: '1.0.0', files: { 'index.js': 'self\n' } }],
  ]) })
  const client = repoClient(files)
  const checked = await validate(file, { client })
  t.assert.deepStrictEqual([checked.status, checked.problems], ['valid', []], 'of the own code\'s tree')
  t.assert.deepStrictEqual([(await validate(file, { client, own: false })).status], ['valid'], 'of the root\'s own tree')
}))

test('validate: an npm copy held to where the repository\'s npm lockfile installs it, from the lockfile\'s directory to the bundle\'s', withTmp(async (t, tmp) => {
  const files = { 'package.json': '{"name":"app","version":"1.0.0","workspaces":["web"]}\n', 'package-lock.json': npmLock('web/'), 'web/package.json': '{"name":"web","version":"1.0.0"}\n', 'web/src/main.js': 'main\n' }
  const at = async (dir) => {
    const file = join(tmp, 'web.stasis.code.br')
    writeBundle(file, { repo: { github: 'org/repo', commit, directory: 'web' }, modules: new Map([
      ['.', { name: 'web', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
      [dir, { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } }],
    ]) })
    const report = await validate(file, { client: repoClient(files), fetch: upstream() })
    return [report.status, report.lockfiles, report.packages.map((pkg) => [pkg.reason ?? null, pkg.at ?? null])]
  }
  t.assert.deepStrictEqual(await at('node_modules/tool/node_modules/ms'), ['valid', ['package-lock.json'], []], 'at web/node_modules/tool/node_modules/ms')
  t.assert.deepStrictEqual(await at('node_modules/ms'), ['invalid', ['package-lock.json'], [['misplaced', 'node_modules/ms']]], 'web/node_modules/ms is ms@2.0.0')
}))

// A tools/ project's package-lock.json, as npm writes it: ms@2.1.3 at its node_modules/ms.
const toolsLock = `${JSON.stringify({ name: 'tools', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
  '': { name: 'tools', version: '1.0.0', dependencies: { ms: '2.1.3' } },
  'node_modules/ms': lockEntry('ms', '2.1.3', SRI),
} }, null, 2)}\n`

// The root's package-lock.json of a workspace apps/web, which it installs ms@2.1.3 in.
const appsLock = `${JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
  '': { name: 'app', version: '1.0.0', workspaces: ['apps/web'] },
  'apps/web': { version: '1.0.0', dependencies: { ms: '2.1.3' } },
  'node_modules/web': { resolved: 'apps/web', link: true },
  'apps/web/node_modules/ms': lockEntry('ms', '2.1.3', SRI),
} }, null, 2)}\n`

test('lockedBy: several lockfiles of one ecosystem, each where it is (`at`): a copy where the innermost holding it installs it, a version as any of them locks it; two at one place refused', async (t) => {
  const told = async (dir, locked) => {
    const plan = validationPlan(Bundle.parse(new Bundle({ modules: new Map([[dir, { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } }]]) }).serialize()))
    const report = await validateBundle(plan, { reason: 'skipped' }, { fetch: async () => new Map([['index.js', bytes(MS['index.js'])]]), locked })
    return [report.status, report.packages.map((pkg) => [pkg.status, pkg.reason ?? null, pkg.at ?? null])]
  }
  const both = lockedBy([
    { path: 'package-lock.json', text: npmLock(''), from: 'repository' },
    { path: 'tools/package-lock.json', text: toolsLock, from: 'repository', root: '..', at: 'tools' },
  ])
  t.assert.deepStrictEqual(both.lockfiles, ['package-lock.json', 'tools/package-lock.json'])
  t.assert.deepStrictEqual(await told('tools/node_modules/ms', both), ['valid', []], "tools/'s lockfile installs it at its node_modules/ms")
  t.assert.deepStrictEqual(await told('node_modules/tool/node_modules/ms', both), ['valid', []], "the root's, there")
  t.assert.deepStrictEqual(await told('node_modules/ms', both), ['invalid', [['invalid', 'misplaced', 'node_modules/ms']]], "the root's installs ms@2.0.0 there")
  // The root's alone: tools/node_modules/ms is none of its locations.
  const root = lockedBy([{ path: 'package-lock.json', text: npmLock(''), from: 'repository' }])
  t.assert.deepStrictEqual(await told('tools/node_modules/ms', root), ['invalid', [['invalid', 'misplaced', 'tools/node_modules/ms']]])
  // Locked as any of them locks it: ms@2.0.0 by the root's alone, still locked.
  t.assert.deepStrictEqual(both.lock('npm', 'ms', '2.0.0'), { from: 'registry', integrity: OTHER_SRI })
  t.assert.deepStrictEqual(both.lock('npm', 'ms', '9.9.9'), null)
  t.assert.throws(() => lockedBy([{ path: 'package-lock.json', text: npmLock('') }, { path: 'tools/package-lock.json', text: toolsLock }]), (error) => error instanceof ValidateError && error.code === 'lockfile-ambiguous')
  // tools/'s alone: node_modules/ms is installed by none of them, whatever version they lock.
  const tools = lockedBy([{ path: 'tools/package-lock.json', text: toolsLock, from: 'repository', root: '..', at: 'tools' }])
  t.assert.deepStrictEqual(await told('node_modules/ms', tools), ['invalid', [['invalid', 'misplaced', 'node_modules/ms']]])
  // Of a bundle in apps/web: apps/tools/'s, beside it, holds none of its copies, though listed first and as
  // far from it as the root's, which installs them.
  const beside = lockedBy([
    { path: 'apps/tools/package-lock.json', text: toolsLock, from: 'repository', root: '../web', at: '../tools' },
    { path: 'package-lock.json', text: appsLock, from: 'repository', root: 'apps/web', at: '../..' },
  ])
  t.assert.deepStrictEqual(await told('node_modules/ms', beside), ['valid', []])
})

test("validate: the dependencies held to the lockfiles the repository's stasis.config.json names, in place of the one found, a soldeer.lock among them", withTmp(async (t, tmp) => {
  const files = {
    'package.json': '{"name":"app","version":"1.0.0"}\n',
    'package-lock.json': npmLock(''),
    'src/main.js': 'main\n',
    'tools/package.json': '{"name":"tools","version":"1.0.0"}\n',
    'tools/package-lock.json': toolsLock,
    'contracts/soldeer.lock': 'dependencies = []\n',
  }
  const file = join(tmp, 'app.stasis.code.br')
  writeBundle(file, { repo: { github: 'org/repo', commit }, modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
    ['node_modules/tool/node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } }],
    ['tools/node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } }],
  ]) })
  const config = (lockfiles) => ({ 'stasis.config.json': `${JSON.stringify({ lockfiles })}\n` })
  const report = await validate(file, { client: repoClient({ ...files, ...config(['package-lock.json', 'tools/package-lock.json', 'contracts/soldeer.lock']) }), fetch: upstream() })
  t.assert.deepStrictEqual([report.status, report.lockfiles, report.packages.map((pkg) => [pkg.reason ?? null, pkg.at ?? null])], ['valid', ['package-lock.json', 'tools/package-lock.json', 'contracts/soldeer.lock'], []])
  // Found, the root's alone: tools/'s copy is none it installs.
  const found = await validate(file, { client: repoClient(files), fetch: upstream() })
  t.assert.deepStrictEqual([found.status, found.lockfiles, found.packages.map((pkg) => [pkg.reason ?? null, pkg.at ?? null])], ['invalid', ['package-lock.json'], [['misplaced', 'tools/node_modules/ms']]])
  // Naming none validate reads of its npm packages, or one outside the repository: refused.
  await t.assert.rejects(validate(file, { client: repoClient({ ...files, ...config(['contracts/soldeer.lock']) }), fetch: upstream() }), (error) => error.code === 'no-lockfile' && /none of the lockfiles stasis\.config\.json names locks its npm packages/u.test(error.message))
  await t.assert.rejects(validate(file, { client: repoClient({ ...files, ...config(['../package-lock.json']) }), fetch: upstream() }), (error) => error.code === 'lockfile-unreadable' && /outside the repository/u.test(error.message))
  // A lockfile given in place of them all the same.
  const given = join(tmp, 'package-lock.json')
  writeFileSync(given, npmLock(''))
  t.assert.deepStrictEqual((await validate(file, { client: repoClient({ ...files, ...config(['package-lock.json', 'tools/package-lock.json']) }), fetch: upstream(), lockfile: [given] })).lockfiles, [given])
}))

test("validate: of several lockfiles, each copy held to the one of its tree alone, a version another tree's locks not locked by its own", withTmp(async (t, tmp) => {
  const pnpm = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n\npackages:\n\n  ms@2.1.3:\n    resolution: {integrity: ${SRI}}\n\nsnapshots:\n\n  ms@2.1.3: {}\n`
  const files = {
    'package.json': '{"name":"app","version":"1.0.0"}\n',
    'pnpm-lock.yaml': pnpm,
    'src/main.js': 'main\n',
    'tools/package.json': '{"name":"tools","version":"1.0.0"}\n',
    'tools/pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n",
    'stasis.config.json': `${JSON.stringify({ lockfiles: ['pnpm-lock.yaml', 'tools/pnpm-lock.yaml'] })}\n`,
  }
  const file = join(tmp, 'app.stasis.code.br')
  const write = (dir) => writeBundle(file, { repo: { github: 'org/repo', commit }, modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
    [dir, { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } }],
  ]) })
  write('node_modules/.pnpm/ms@2.1.3/node_modules/ms')
  t.assert.equal((await validate(file, { client: repoClient(files), fetch: upstream() })).status, 'valid', 'in the tree whose lockfile locks it')
  write('tools/node_modules/.pnpm/ms@2.1.3/node_modules/ms')
  const report = await validate(file, { client: repoClient(files), fetch: upstream() })
  t.assert.deepStrictEqual([report.status, report.packages.map(({ status, reason }) => [status, reason])], ['invalid', [['invalid', 'not-locked']]])
}))

test("configuredLockfiles and lockedNpmPackages: stasis.config.json's lockfiles, of a repository's directory or the disk's, the npm ones' registry packages each named by its path", withTmp(async (t, tmp) => {
  const listed = { '': ['stasis.config.json'], web: ['stasis.config.json'], none: ['package.json'] }
  const read = async (path) => ({ 'stasis.config.json': '{"lockfiles":["pnpm-lock.yaml","tools/package-lock.json"]}', 'web/stasis.config.json': '{"lockfiles":["../pnpm-lock.yaml"]}' })[path]
  const list = async (dir) => listed[dir] ?? []
  t.assert.deepStrictEqual(await configuredLockfiles({ directory: '', list, read }), ['pnpm-lock.yaml', 'tools/package-lock.json'])
  t.assert.deepStrictEqual(await configuredLockfiles({ directory: 'web', list, read }), ['pnpm-lock.yaml'], 'from the repository\'s root')
  t.assert.equal(await configuredLockfiles({ directory: 'none', list, read }), undefined)
  // Of the disk: each npm, pnpm or yarn lockfile named; a soldeer.lock passed over.
  mkdirSync(join(tmp, 'tools'))
  writeFileSync(join(tmp, 'package.json'), '{"name":"app","version":"1.0.0"}\n')
  writeFileSync(join(tmp, 'package-lock.json'), npmLock(''))
  writeFileSync(join(tmp, 'tools', 'package-lock.json'), toolsLock)
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ lockfiles: ['package-lock.json', 'tools/package-lock.json', 'contracts/soldeer.lock'] }))
  const locked = await lockedNpmPackages(tmp)
  t.assert.deepStrictEqual(locked.map(({ path, name }) => [path, name]), [[join(tmp, 'package-lock.json'), 'package-lock.json'], [join(tmp, 'tools', 'package-lock.json'), 'tools/package-lock.json']])
  t.assert.deepStrictEqual(locked[1].packages, [{ name: 'ms', version: '2.1.3' }])
  // Without lockfiles named, the one installedNpmPackages finds, by its name.
  writeFileSync(join(tmp, 'stasis.config.json'), '{}')
  t.assert.deepStrictEqual((await lockedNpmPackages(tmp)).map(({ name }) => name), ['package-lock.json'])
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ lockfiles: ['missing/pnpm-lock.yaml'] }))
  await t.assert.rejects(lockedNpmPackages(tmp), (error) => error instanceof ValidateError && error.code === 'lockfile-unreadable')
}))

test('stasis validate: exits 0 valid, 1 invalid, 2 incomplete (0 with --allow-unverified), 3 refused or failed; own code skipped with --only-deps, its dependencies held to a lockfile given or, with --no-lockfile, none', withTmp((t, tmp) => {
  const file = join(tmp, 'own.stasis.code.br')
  writeBundle(file, { modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n' } }]]) })
  // Colourless, as a pipe takes it, out of CI (whether this runs in it or not); in colour in CI.
  const env = { ...process.env, STASIS_CACHE_DIR: '', XDG_CACHE_HOME: tmp }
  delete env.CI
  const run = (...args) => spawnSync(process.execPath, [cli, 'validate', ...args], { encoding: 'utf8', env })
  const skipped = run('--only-deps', file)
  t.assert.equal(skipped.status, 0, skipped.stderr)
  t.assert.equal(run('--only-deps', '--show-valid', file).status, 0, 'valid packages shown where asked')
  t.assert.match(skipped.stderr, /^valid: 0 of 1 files as they should be, 0 differ, 0 unexpected, 0 unverified, 1 skipped; 0 of 0 packages as published\nOwn code not verified: skipped \(--only-deps\): its dependencies alone validated\n$/u,
    'own code skipped as asked leaves it valid')
  const unnamed = run(file)
  t.assert.deepStrictEqual([unnamed.status, unnamed.stdout], [3, ''])
  t.assert.match(unnamed.stderr, /^Error: .*own\.stasis\.code\.br records no repository to read its own code of: give --github=owner\/name and --sha=commit, or --only-deps to validate its dependencies alone\nRun 'stasis --help' for usage\.\n$/u)

  // With a dependency, its lockfile needed too: one given, which locks none of it, fails it unfetched.
  const deps = join(tmp, 'deps.stasis.code.br')
  writeBundle(deps, { modules: new Map([['node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': 'one\n' } }]]) })
  t.assert.match(run(deps).stderr, /records no repository to read its own code of: give --github=owner\/name and --sha=commit, or, to validate its dependencies alone, --only-deps with --lockfile=path or --no-lockfile\n/u)
  const unlocked = run('--only-deps', deps)
  t.assert.deepStrictEqual([unlocked.status, unlocked.stdout], [3, ''])
  t.assert.match(unlocked.stderr, /records no repository to read its lockfile of: give --github=owner\/name and --sha=commit, or --lockfile=path, or --no-lockfile to hold its dependencies to their registry alone\n/u)
  const lockfile = join(tmp, 'pnpm-lock.yaml')
  writeFileSync(lockfile, "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n")
  const locked = run('--only-deps', `--lockfile=${lockfile}`, deps)
  t.assert.deepStrictEqual([locked.status, rowsOf(locked.stdout)], [1, [['status', 'package', 'note'], ['invalid', 'ms@2.1.3', 'not locked by the lockfile']]], locked.stderr)
  t.assert.ok(!`${locked.stdout}${locked.stderr}`.includes('\u001B['), 'no colours where the stream is a pipe')
  const painted = spawnSync(process.execPath, [cli, 'validate', '--only-deps', `--lockfile=${lockfile}`, deps], { encoding: 'utf8', env: { ...env, CI: 'true' } })
  t.assert.deepStrictEqual([painted.stdout.includes('\u001B[31minvalid\u001B[39m'), painted.stderr.startsWith('\u001B[1m\u001B[31minvalid\u001B[39m\u001B[22m: ')], [true, true], 'its statuses in colour in CI\'s log')
  t.assert.match(locked.stderr, /^invalid: 0 of 1 files as they should be, 0 differ, 0 unexpected, 1 unverified; 0 of 1 packages as published, 1 failing their lockfile\nOwn code not verified: skipped \(--only-deps\): its dependencies alone validated\nDependencies held to .*pnpm-lock\.yaml\n$/u)

  // One it locks from git alone, unverified, and so incomplete: 2, but 0 where that is allowed.
  const git = join(tmp, 'git', 'pnpm-lock.yaml')
  mkdirSync(join(tmp, 'git'))
  const at = 'a'.repeat(40)
  // Of a host other than GitHub, which validate reads no repository of.
  writeFileSync(git, `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      ms:\n        specifier: git+https://gitlab.com/vercel/ms.git#${at}\n        version: git+https://gitlab.com/vercel/ms.git#${at}\n\npackages:\n\n  ms@git+https://gitlab.com/vercel/ms.git#${at}:\n    resolution: {commit: ${at}, repo: https://gitlab.com/vercel/ms.git, type: git}\n    version: 2.1.3\n\nsnapshots:\n\n  ms@git+https://gitlab.com/vercel/ms.git#${at}: {}\n`)
  const incomplete = run('--only-deps', `--lockfile=${git}`, deps)
  t.assert.deepStrictEqual([incomplete.status, rowsOf(incomplete.stdout)], [2, [['status', 'package', 'note'], ['unverified', 'ms@2.1.3', 'locked from git, not a registry']]], incomplete.stderr)
  t.assert.equal(run('--only-deps', `--lockfile=${git}`, '--allow-unverified', deps).status, 0)

  writeFileSync(join(tmp, 'deps.txt'), '')
  const unsupported = run('--only-deps', `--lockfile=${join(tmp, 'deps.txt')}`, deps)
  t.assert.deepStrictEqual([unsupported.status, /^Error: .*deps\.txt: not a lockfile validate reads/u.test(unsupported.stderr)], [3, true])
  const both = run('--lockfile=x', '--no-lockfile', deps)
  t.assert.deepStrictEqual([both.status, both.stderr], [3, 'Error: --lockfile and --no-lockfile: give one\nRun \'stasis --help\' for usage.\n'])
  t.assert.equal(run('--bogus', deps).status, 3)

  const lock = join(tmp, 'stasis.lock.json')
  writeFileSync(lock, JSON.stringify({ version: 0, config: { scope: 'full' }, entries: [], sources: {}, modules: {}, imports: {}, formats: {} }))
  t.assert.match(run(lock).stderr, /^Error: .*stasis\.lock\.json records no repository to read its own code of: give --github=owner\/name and --sha=commit/u)
  // Any other failure told as an error alone, no stack: 3.
  const missing = run('--only-deps', '--no-lockfile', join(tmp, 'missing.stasis.code.br'))
  t.assert.deepStrictEqual([missing.status, missing.stderr], [3, `Error: File not found: ${join(tmp, 'missing.stasis.code.br')}\n`])
  t.assert.equal(run().status, 3)
}))

// How each token is chosen is githubToken's and withNpmToken's (tokens.test.js); here, that validate reads with them.
test("stasis validate reads GitHub with GITHUB_TOKEN, else ~/.audit/config.json's token, and npm with its npmToken, else ~/.npmrc's, as github-bundle does", withTmp(async (t, tmp) => {
  const spy = join(tmp, 'spy.mjs')
  writeFileSync(spy, `globalThis.fetch = async (input, init) => {
  process.stderr.write(\`sent \${new URL(input).host} \${new Headers(init?.headers).get('authorization')}\\n\`)
  return new Response('{"message":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } })
}\n`)
  const ownFile = join(tmp, 'own.stasis.code.br')
  writeBundle(ownFile, { modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n' } }]]) })
  // A private package, which the npm client sends a token for (only a scoped one is private).
  const deps = join(tmp, 'deps.stasis.code.br')
  writeBundle(deps, { modules: new Map([['node_modules/@scope/q', { name: '@scope/q', version: '1.0.0', files: { 'index.js': 'q\n' } }]]) })
  const npmrc = `//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`
  const [audited, npmrcOnly, notUtf8, empty] = await Promise.all([{ npmrc, audit: { token: 'gh-audit', npmToken: 'npm-audit' } }, { npmrc }, { npmrc: NOT_UTF8_NPMRC }, {}].map((files) => tokenHome(t, files)))
  const env = { ...process.env, STASIS_CACHE_DIR: '', XDG_CACHE_HOME: join(tmp, 'cache') }
  for (const name of ['CI', 'GITHUB_TOKEN', ...NPM_TOKEN_VARS]) delete env[name]
  // What `stasis validate ...args`, with `home` the user's and `more` in its environment, sent each host for authorization.
  const sent = (home, args, more = {}) => {
    const r = spawnSync(process.execPath, [`--import=${pathToFileURL(spy)}`, cli, 'validate', ...args], { encoding: 'utf8', env: { ...env, HOME: home, ...more } })
    return [r.status, [...new Set(r.stderr.split('\n').filter((line) => line.startsWith('sent ')))]]
  }
  const repo = ['--github=o/r', `--sha=${commit}`, ownFile]
  t.assert.deepStrictEqual(sent(audited, repo), [3, ['sent api.github.com Bearer gh-audit']])
  t.assert.deepStrictEqual(sent(audited, repo, { GITHUB_TOKEN: 'gh-env' }), [3, ['sent api.github.com Bearer gh-env']], "GITHUB_TOKEN's first")
  t.assert.deepStrictEqual(sent(empty, repo), [3, ['sent api.github.com null']], 'anonymous without either')
  const registry = ['--only-deps', '--no-lockfile', deps]
  t.assert.deepStrictEqual(sent(audited, registry), [2, ['sent registry.npmjs.org Bearer npm-audit']])
  t.assert.deepStrictEqual(sent(npmrcOnly, registry), [2, [`sent registry.npmjs.org Bearer ${NPM_TOKEN}`]], "~/.npmrc's without .audit's")
  t.assert.deepStrictEqual(sent(audited, registry, { NPM_TOKEN: 'npm-env' }), [2, ['sent registry.npmjs.org Bearer npm-env']], "the environment's first")
  t.assert.deepStrictEqual(sent(notUtf8, registry), [3, []], 'an ~/.npmrc that is not valid UTF-8 is refused before anything is fetched')
}))

// A Prisma Client a repository's schema generates, as `generated` gives it: its files from its output.
const DB_CLIENT = { dir: 'src/db', schema: 'prisma/schema.prisma', generator: 'client', prisma: '7.10.0',
  files: new Map([['client.ts', 'generated\n'], ['internal/class.ts', 'class\n'], ['query.wasm', new Uint8Array([0, 97, 115, 109])]]) }
// A bundle built in `web` holding `files` (`.wasm`s as resources), with the repository's main.js.
const generatedBundle = (files) => validationPlan(Bundle.parse(new Bundle({
  repo: { github: 'org/repo', directory: 'web', commit },
  modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n', ...files } }]]),
  formats: new Map(Object.keys(files).filter((path) => path.endsWith('.wasm')).map((path) => [path, 'resource:base64'])),
}).serialize()))

test('validateBundle: an own file the repository doesn\'t hold as bundled held to the Prisma Clients its schemas generate, asked for once, and only then', async (t) => {
  const plan = generatedBundle({
    'src/db/client.ts': 'generated\n', 'src/db/query.wasm': 'AGFzbQ==', 'src/db/internal/class.ts': 'tampered\n', 'src/db/extra.ts': 'x\n',
    // Its own, the repository's: no generated file, whatever its path.
    'src/db/committed.ts': 'as committed\n', 'src/other.ts': 'y\n',
  })
  const entries = { 'web/src/main.js': { sha: blob('main\n') }, 'web/src/db/committed.ts': { sha: blob('as committed\n') } }
  const generated = t.mock.fn(async () => [DB_CLIENT])
  const report = await validateBundle(plan, own(entries), { fetch: upstream(), generated })
  t.assert.equal(generated.mock.callCount(), 1)
  t.assert.equal(report.status, 'invalid')
  t.assert.deepStrictEqual(report.generated, [{ output: 'src/db', schema: 'prisma/schema.prisma', generator: 'client', prisma: '7.10.0', files: ['src/db/client.ts', 'src/db/query.wasm'] }])
  t.assert.deepStrictEqual(report.problems, [
    { path: 'src/db/internal/class.ts', kind: 'differs', of: 'own', reason: 'generated' },
    { path: 'src/db/extra.ts', kind: 'unexpected', of: 'own', reason: 'not-generated' },
    { path: 'src/other.ts', kind: 'unexpected', of: 'own' },
  ])
  t.assert.deepStrictEqual([report.counts.matched, report.counts.generated, report.counts.differs, report.counts.unexpected], [4, 2, 1, 2])
  t.assert.equal(report.generatedError, undefined)

  // All of it the repository's: none asked for.
  const whole = await validateBundle(generatedBundle({}), own(entries), { fetch: upstream(), generated: () => t.assert.fail('asked for') })
  t.assert.deepStrictEqual([whole.status, whole.generated, whole.counts.generated], ['valid', [], 0])
  // Asked for and failing: each told as it was found, and why.
  const failed = await validateBundle(plan, own(entries), { fetch: upstream(), generated: async () => { throw new Error('no prisma installed') } })
  t.assert.deepStrictEqual([failed.generatedError, failed.generated, failed.counts.generated], ['no prisma installed', [], 0])
  t.assert.deepStrictEqual(failed.problems.filter((problem) => problem.reason !== undefined), [])
  t.assert.equal(failed.counts.unexpected, 5)
  // A listing cut short: one generated as it should be checked all the same, another left unverified.
  const cut = await validateBundle(generatedBundle({ 'src/db/client.ts': 'generated\n', 'src/db/internal/class.ts': 'tampered\n' }), own(entries, { cut: true }), { fetch: upstream(), generated })
  t.assert.deepStrictEqual([cut.status, cut.generated[0].files, cut.problems], ['incomplete', ['src/db/client.ts'], [{ path: 'src/db/internal/class.ts', kind: 'unverified', of: 'own', reason: 'tree-cut' }]])
  // Skipped (--only-deps): none asked for.
  const skipped = await validateBundle(plan, { reason: 'skipped' }, { fetch: upstream(), generated: () => t.assert.fail('asked for') })
  t.assert.deepStrictEqual([skipped.generated, skipped.counts.skipped], [[], 7])
})

test('printValidationReport: the files generated by each Prisma Client in a table of their own, counted; why none was generated, where none could be', async (t) => {
  const plan = generatedBundle({ 'src/db/client.ts': 'generated\n', 'src/db/query.wasm': 'AGFzbQ==' })
  const report = await validateBundle(plan, own({ 'web/src/main.js': { sha: blob('main\n') } }), { fetch: upstream(), generated: async () => [DB_CLIENT] })
  const { rows, err } = printed(report)
  t.assert.deepStrictEqual(rows, [['status', 'of', 'files'], ['generated', 'prisma/schema.prisma\'s client (Prisma 7.10.0)', 'src/db/client.ts'], ['', '', 'src/db/query.wasm']])
  t.assert.match(err, /^valid: 3 of 3 files as they should be, 0 differ, 0 unexpected, 0 unverified; 0 of 0 packages as published; 2 generated by the repository's Prisma schemas\n/u)
  const failed = await validateBundle(plan, own({ 'web/src/main.js': { sha: blob('main\n') } }), { fetch: upstream(), generated: async () => { throw new Error('no prisma installed') } })
  t.assert.match(printed(failed).err, /\nNo Prisma Client generated to hold the files the repository doesn't hold to: no prisma installed\n/u)
})

test("validate: a github-bundle's stasis.lock.json held to the repository and commit it records, as a bundle is; one recording none, to those given", withTmp(async (t, tmp) => {
  t.mock.method(console, 'warn', () => {})
  const files = {
    'package.json': json({ name: 'root', version: '1.0.0', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'pnpm-lock.yaml': pnpmLockfile('.', 'packages/api'),
    'packages/api/package.json': json({ name: 'api', version: '1.0.0', main: 'src/a.js' }),
    'packages/api/src/a.js': "module.exports = require('./b.js')\n",
    'packages/api/src/b.js': 'module.exports = 1\n',
  }
  await githubBundleCommand({ cwd: tmp, github: 'org/repo', sha: commit, directory: 'packages/api', packageManager: 'pnpm', client: fakeClient(files), lockfileOnly: true, env: {} })
  const file = join(tmp, `org-repo.packages-api.${commit.slice(0, 7)}.stasis.lock.json`)
  t.assert.equal(parseFileWithKind(file).kind, 'lockfile')
  const heldTo = { checked: true, repository: 'org/repo', commit, ref: { branch: 'main' }, directory: 'packages/api' }
  const report = await validate(file, { client: repoClient(files) })
  t.assert.deepStrictEqual([report.status, report.own, report.problems, report.counts.matched], ['valid', heldTo, [], 2])
  // Of a repository with a file otherwise: it differs.
  const changed = await validate(file, { client: repoClient({ ...files, 'packages/api/src/b.js': 'module.exports = 2\n' }) })
  t.assert.deepStrictEqual([changed.status, changed.problems], ['invalid', [{ path: 'src/b.js', kind: 'differs', of: 'own' }]])
  // Recording none: refused without --github and --sha, and held to those given.
  const lock = Lockfile.parse(readFileSync(file, 'utf8'))
  lock.repo = undefined
  const unstamped = join(tmp, 'unstamped.stasis.lock.json')
  writeFileSync(unstamped, lock.serialize())
  await t.assert.rejects(validate(unstamped, { client: repoClient(files) }), { name: 'ValidateError', code: 'no-repository' })
  const given = await validate(unstamped, { client: repoClient(files), github: 'org/repo', sha: commit, directory: 'packages/api' })
  t.assert.deepStrictEqual([given.status, given.own], ['valid', heldTo])
  // What is given in place of what it records.
  const elsewhere = await validate(file, { client: repoClient({ 'packages/app/src/a.js': files['packages/api/src/a.js'], 'packages/app/src/b.js': files['packages/api/src/b.js'] }), directory: 'packages/app' })
  t.assert.deepStrictEqual([elsewhere.status, elsewhere.own.directory], ['valid', 'packages/app'])
}))

// A repository whose schema's client `src/generated/prisma`, which it doesn't commit, index.ts imports; its
// `prisma` and `@prisma/client` stand-ins linked from vendor/: nothing fetched.
const PRISMA_LOCK = pnpmLockfile('.').replace('  .: {}\n', ['  .:', '    dependencies:', "      '@prisma/client':", '        specifier: link:vendor/client', '        version: link:vendor/client',
  '    devDependencies:', '      prisma:', '        specifier: link:vendor/prisma', '        version: link:vendor/prisma', ''].join('\n'))
const PRISMA_REPO = {
  'package.json': json({ name: 'app', version: '1.0.0', type: 'module', dependencies: { '@prisma/client': 'link:vendor/client' }, devDependencies: { prisma: 'link:vendor/prisma' } }),
  'pnpm-lock.yaml': PRISMA_LOCK,
  'vendor/prisma/package.json': json({ name: 'prisma', version: '7.9.0' }),
  'vendor/client/package.json': json({ name: '@prisma/client', version: '7.9.0', exports: { './runtime/client': './runtime/client.js', './runtime/*': './runtime/*' } }),
  'vendor/client/runtime/client.js': 'module.exports = {}\n',
  'prisma/schema.prisma': 'generator client {\n  provider = "prisma-client"\n  output   = "../src/generated/prisma"\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n\nmodel User {\n  id Int @id\n}\n',
  'index.ts': "export { PrismaClient } from './src/generated/prisma/client.ts'\n",
}

test('validate: a github-bundle\'s Prisma Client, which its repository doesn\'t hold, generated as its schema generates it; one tampered with differs', withTmp(async (t, tmp) => {
  t.mock.method(console, 'warn', () => {})
  await githubBundleCommand({ cwd: tmp, github: 'org/repo', sha: commit, packageManager: 'pnpm', client: fakeClient(PRISMA_REPO), entries: ['index.ts'], output: 'app.stasis.code.br' })
  const file = join(tmp, 'app.stasis.code.br')
  const report = await validate(file, { client: repoClient(PRISMA_REPO) })
  t.assert.deepStrictEqual([report.status, report.problems, report.generatedError], ['valid', [], undefined])
  const [client] = report.generated
  t.assert.deepStrictEqual([report.generated.length, client.output, client.schema, client.generator, client.prisma], [1, 'src/generated/prisma', 'prisma/schema.prisma', 'client', '7.9.0'])
  t.assert.ok(client.files.includes('src/generated/prisma/client.ts') && client.files.includes('src/generated/prisma/internal/class.ts'))
  t.assert.equal(report.counts.generated, client.files.length)

  // Its client committed as generated: own code, none generated.
  const { artifact } = parseFileWithKind(file)
  const { files } = artifact.modules.get('.')
  const committed = await validate(file, { client: repoClient({ ...PRISMA_REPO, ...Object.fromEntries(client.files.map((path) => [path, files[path]])) }) })
  t.assert.deepStrictEqual([committed.status, committed.generated, committed.counts.generated], ['valid', [], 0])

  // A line added to its class: not as the schema generates it.
  files['src/generated/prisma/internal/class.ts'] += 'globalThis.injected = true\n'
  writeBundle(file, artifact)
  const tampered = await validate(file, { client: repoClient(PRISMA_REPO) })
  t.assert.equal(tampered.status, 'invalid')
  t.assert.deepStrictEqual(tampered.problems, [{ path: 'src/generated/prisma/internal/class.ts', kind: 'differs', of: 'own', reason: 'generated' }])

  // An edge runtime's client, which carries the query compiler of the prisma its lockfile installs (the bundle its
  // bindings, which the scan reaches): generated as copied from there.
  const compiler = 'vendor/prisma/build/query_compiler_fast_bg.postgresql'
  const edge = { ...PRISMA_REPO, 'prisma/schema.prisma': PRISMA_REPO['prisma/schema.prisma'].replace('  output', '  runtime  = "workerd"\n  output'), [`${compiler}.wasm`]: '\0asm stand-in', [`${compiler}.mjs`]: 'export default {}\n',
    'vendor/client/package.json': json({ name: '@prisma/client', version: '7.9.0', exports: { './runtime/client': './runtime/client.js', './runtime/wasm-compiler-edge': './runtime/client.js' } }) }
  await githubBundleCommand({ cwd: tmp, github: 'org/repo', sha: commit, packageManager: 'pnpm', client: fakeClient(edge), entries: ['index.ts'], output: 'edge.stasis.code.br' })
  const edgeReport = await validate(join(tmp, 'edge.stasis.code.br'), { client: repoClient(edge) })
  t.assert.deepStrictEqual([edgeReport.status, edgeReport.generated[0].files.filter((path) => path.includes('query_compiler'))],
    ['valid', ['src/generated/prisma/internal/query_compiler_fast_bg.js']])
  // Its prisma's bindings other than the bundle's: not as the schema generates the client.
  const other = await validate(join(tmp, 'edge.stasis.code.br'), { client: repoClient({ ...edge, [`${compiler}.mjs`]: 'export default 1\n' }) })
  t.assert.deepStrictEqual(other.problems, [{ path: 'src/generated/prisma/internal/query_compiler_fast_bg.js', kind: 'differs', of: 'own', reason: 'generated' }])
}))

// ms's record of the patch it was installed with (of `hash`, MS_PATCH's), its files patched.
const recordedMs = (hash = sha256(MS_PATCH), more = {}) => ({ name: 'ms', version: '2.1.3', patch: { integrity: patchIntegrity(hash) }, files: { 'index.js': 'one\nTWO\nthree\n', 'package.json': MS['package.json'] }, ...more })
const OTHER_PATCH = sha256('another patch\n')
const AS_PUBLISHED = { 'index.js': MS['index.js'], 'package.json': MS['package.json'] }
// ms alone validated, with the own code a patch the bundle holds is checked with.
const msPlan = (modules) => {
  const plan = validationPlan(parsed({ 'node_modules/left': undefined, ...modules }))
  plan.own = plan.own.filter((file) => plan.patches.has(file.path))
  plan.packages = plan.packages.filter((pkg) => pkg.name === 'ms')
  return plan
}
const msPackage = (more) => ({ ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 2, ...more })
// npm's package-lock.json of `packages` (ms@2.1.3), read on disk.
const npmLockText = (packages = { 'node_modules/ms': lockEntry('ms', '2.1.3', SRI) }) => `${JSON.stringify({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', version: '1.0.0', dependencies: Object.fromEntries(Object.entries(packages).map(([at, { version }]) => [at.slice('node_modules/'.length), version])) }, ...packages } }, null, 2)}\n`
const npmLocked = (packages) => lockedBy([{ path: 'package-lock.json', text: npmLockText(packages), from: 'local', read: async () => '' }])
// pnpm's lockfile installing ms patched, and tools' npm's as published, of another integrity; and
// copies of ms under each, tools' recording `tools`.
const TREES = lockedBy([
  { path: 'pnpm-lock.yaml', text: `lockfileVersion: '9.0'\n\npatchedDependencies:\n  ms@2.1.3:\n    hash: ${sha256(MS_PATCH)}\n    path: patches/ms@2.1.3.patch\n\nimporters:\n\n  .:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3(patch_hash=${sha256(MS_PATCH)})\n\npackages:\n\n  ms@2.1.3:\n    resolution: {integrity: ${SRI}}\n\nsnapshots:\n\n  ms@2.1.3(patch_hash=${sha256(MS_PATCH)}): {}\n`, from: 'local', read: async () => MS_PATCH },
  { path: 'tools/package-lock.json', text: npmLockText({ 'node_modules/ms': lockEntry('ms', '2.1.3', OTHER_SRI) }), from: 'local', read: async () => '', at: 'tools' },
])
const inTrees = (tools) => ({ 'node_modules/ms': recordedMs(undefined, { integrity: SRI }), 'tools/node_modules/ms': { name: 'ms', version: '2.1.3', files: AS_PUBLISHED, ...tools } })
// Each case `[label, modules, locked, expected, own]` of ms's validation, as much of its report as `expected` names: its status,
// counts, problems, packages' statuses, ms's (`ms`) and its status, reason and patch, its row as printed, the integrities fetched with.
async function heldAsTold(t, cases) {
  const told = await Promise.all(cases.map(async ([, modules, locked, expected, verdicts = own()]) => {
    const integrities = []
    const report = await validateBundle(msPlan(modules), verdicts, { fetch: upstream(PACKAGES, [], integrities), locked })
    const [ms] = report.packages
    const all = { status: report.status, ...report.counts, problems: report.problems, packages: report.packages.map(({ status, reason }) => [status, reason]), ms, msStatus: ms?.status, reason: ms?.reason, patch: ms?.patch,
      row: hasRow(printed(report, { showValid: true }).rows, expected.row) ? expected.row : 'not printed', integrities }
    return Object.fromEntries(Object.keys(expected).map((key) => [key, all[key]]))
  }))
  for (const [i, [label, , , expected]] of cases.entries()) t.assert.deepStrictEqual(told[i], expected, label)
}

test('validateBundle: a copy recording its patch is held to it, its lockfile\'s else the bundle\'s of its hash, its files patched with it alone', async (t) => {
  const hash = sha256(MS_PATCH)
  const tool = 'node_modules/tool/node_modules/ms'
  t.assert.deepStrictEqual([...msPlan({ 'node_modules/ms': recordedMs(), [tool]: { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } } }).packages[0].recorded], [['node_modules/ms', hash]], 'validationPlan: of each copy recording one')
  const lockedWith = (lock, read = async () => MS_PATCH) => ({ of: (name) => (name === 'ms' ? lock : undefined), from: 'repository', read })
  const asRecorded = { ms: msPackage({ status: 'valid', patch: { hash, path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: true, recorded: true, applied: true } }) }
  const notLocked = { status: 'invalid', lockFailures: 1, ms: msPackage({ status: 'invalid', reason: 'patch-not-locked', patch: { hash, recorded: true } }), row: ['invalid', 'ms@2.1.3', 'records a patch its lockfile doesn\'t patch it with'] }
  const differs = [{ path: 'node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' }]
  const notFound = { hash: OTHER_PATCH, error: 'patch-not-found', recorded: true }
  const inNoFile = 'its patch is in no file of its hash (the bundle\'s, or the patches directory\'s)'
  const ms = { 'node_modules/ms': recordedMs() }
  await heldAsTold(t, [
    ['locked with it', ms, lockedWith({ hash, path: 'web/patches/ms@2.1.3.patch' }), asRecorded],
    ['no lockfile', ms, null, asRecorded],
    ['locked with another', ms, lockedWith({ hash: OTHER_PATCH, path: 'web/patches/ms@2.1.3.patch' }), notLocked],
    ['locked with none', ms, lockedWith(null), notLocked],
    ['npm\'s lockfile, which patches nothing', ms, npmLocked(), { status: 'invalid', reason: 'patch-not-locked' }],
    ['npm\'s, recording none: the bundle\'s named for it, as with no lockfile', {}, npmLocked(), { ms: msPackage({ status: 'valid', patch: { path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: true, applied: true } }) }],
    ['of several lockfiles, npm\'s tree\'s copy recording the patch pnpm\'s alone locks', inTrees({ patch: { integrity: patchIntegrity(hash) } }), TREES, { packages: [['invalid', 'patch-not-locked'], ['valid', undefined]] }],
    ['its files as published', { 'node_modules/ms': recordedMs(hash, { files: AS_PUBLISHED }) }, null, { status: 'invalid', problems: differs }],
    ['no lockfile, of no file of its hash', { 'node_modules/ms': recordedMs(OTHER_PATCH) }, null, { status: 'invalid', problems: differs, unverified: 1, patch: notFound, row: ['invalid', 'ms@2.1.3', inNoFile] }],
    ['of no file of its hash, as published: unverified', { 'node_modules/ms': recordedMs(OTHER_PATCH, { files: AS_PUBLISHED }) }, null, { status: 'incomplete', unverified: 2, validPackages: 0, ms: msPackage({ status: 'unverified', patch: notFound }), row: ['unverified', 'ms@2.1.3', inNoFile] }],
    ['of no file of its hash, beside a copy recording none', { 'node_modules/ms': recordedMs(OTHER_PATCH, { files: AS_PUBLISHED }), [tool]: { name: 'ms', version: '2.1.3', files: AS_PUBLISHED } }, null, { status: 'incomplete', unverified: 2, ms: msPackage({ files: 4, status: 'unverified', patch: notFound }) }],
    ['locked, unreadable', { 'node_modules/ms': { name: 'ms', version: '2.1.3', files: AS_PUBLISHED } }, lockedWith({ hash: OTHER_PATCH, path: 'web/patches/gone.patch' }, async () => { throw new Error('no such file') }), { status: 'incomplete', ms: msPackage({ status: 'unverified', patch: { hash: OTHER_PATCH, path: 'web/patches/gone.patch', from: 'repository', error: 'patch-unreadable' } }) }],
    ['copies recording two', { ...ms, [tool]: recordedMs(OTHER_PATCH) }, null, { status: 'invalid', ms: msPackage({ files: 4, status: 'invalid', reason: 'patch-conflict' }), row: ['invalid', 'ms@2.1.3', 'its copies record different patches, or one of them none, where pnpm patches every copy with one'] }],
    // An integrity and no patch: installed unpatched.
    ['one copy recording it, one an integrity and none', { ...ms, [tool]: { name: 'ms', version: '2.1.3', integrity: SRI, files: AS_PUBLISHED } }, null, { status: 'invalid', reason: 'patch-conflict' }],
    ['an integrity and none, locked with it', { 'node_modules/ms': { name: 'ms', version: '2.1.3', integrity: SRI, files: AS_PUBLISHED } }, lockedWith({ hash, path: 'web/patches/ms@2.1.3.patch' }), { status: 'invalid', lockFailures: 1, reason: 'patch-not-recorded', row: ['invalid', 'ms@2.1.3', 'records an integrity and no patch, where its lockfile patches it'] }],
    ['an integrity and none, no lockfile: as published, not as the bundle\'s named for it patches it', { 'node_modules/ms': recordedMs(hash, { patch: undefined, integrity: SRI }) }, null, { status: 'invalid', problems: differs, patch: undefined }],
    ['an integrity and none, no lockfile, as published', { 'node_modules/ms': { name: 'ms', version: '2.1.3', integrity: SRI, files: AS_PUBLISHED } }, null, { status: 'valid', problems: [], patch: undefined }],
    ['one copy recording it, one none', { ...ms, [tool]: { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } } }, null, { status: 'valid', problems: [], row: ['valid', 'ms@2.1.3', 'patched by patches/ms@2.1.3.patch (the bundle\'s, as the repository has it), as recorded'] }],
    ['unverified against the repository', ms, null, { status: 'incomplete', reason: 'patch-unverified', problems: [] }, { reason: 'no-repository' }],
    ['unverified, of files it doesn\'t change', { 'node_modules/ms': recordedMs(hash, { files: { 'package.json': MS['package.json'] } }) }, null, { matched: 1, msStatus: 'valid' }, { reason: 'no-repository' }],
    ['unverified, as published', { 'node_modules/ms': recordedMs(hash, { files: { 'index.js': MS['index.js'] } }) }, null, { problems: differs }, { reason: 'no-repository' }],
  ])
})

test('validateBundle: the integrity a copy records is held to its lockfile\'s, else fetched with', async (t) => {
  const lockedAs = (lock) => ({ of: () => undefined, lock: () => lock, tree: async () => new Map(), git: async () => new Map(Object.entries(MS).map(([path, text]) => [path, bytes(text)])) })
  const recorded = (integrity) => ({ name: 'ms', version: '2.1.3', integrity, files: { 'index.js': MS['index.js'] } })
  const ms = { 'node_modules/ms': recorded(SRI) }
  const at = { github: 'o/ms', commit: 'a'.repeat(40), path: '' }
  const notLocked = { status: 'invalid', reason: 'integrity-not-locked', integrities: [] }
  await heldAsTold(t, [
    ['no lockfile', ms, null, { status: 'valid', integrities: [['npm:ms@2.1.3', SRI]] }],
    ['copies recording two', { ...ms, 'node_modules/tool/node_modules/ms': recorded(OTHER_SRI) }, null, { reason: 'integrity-conflict' }],
    ['its registry\'s, locked with none (a yarn sha1 alone)', ms, lockedAs({ from: 'registry', integrity: undefined }), { status: 'valid', reason: undefined, integrities: [['npm:ms@2.1.3', SRI]] }],
    ['its registry\'s, locked with another', ms, lockedAs({ from: 'registry', integrity: OTHER_SRI }), { ...notLocked, row: ['invalid', 'ms@2.1.3', 'records an integrity its lockfile doesn\'t lock it with'] }],
    ['from git, locked with it: held to its tree', ms, lockedAs({ from: 'git', at, integrity: SRI }), { status: 'valid', reason: undefined, integrities: [] }],
    ['from git, locked with another', ms, lockedAs({ from: 'git', at, integrity: OTHER_SRI }), notLocked],
    ['from git, locked with none', ms, lockedAs({ from: 'git', at }), notLocked],
    ['from elsewhere, locked with it: unfetched', ms, lockedAs({ from: 'elsewhere', integrity: SRI }), { status: 'incomplete', reason: 'not-registry', integrities: [] }],
    ['from elsewhere, locked with another', ms, lockedAs({ from: 'elsewhere', integrity: OTHER_SRI }), notLocked],
    ['from a directory', ms, lockedAs({ from: 'local', directories: ['ms'] }), notLocked],
    ['of several lockfiles, each tree\'s copy of its own', inTrees({ integrity: OTHER_SRI }), TREES, { status: 'valid', validPackages: 2 }],
    ['of several lockfiles, npm\'s tree\'s copy recording pnpm\'s', inTrees({ integrity: SRI }), TREES, { packages: [['invalid', 'integrity-not-locked'], ['valid', undefined]] }],
  ])
  t.assert.deepStrictEqual(npmLocked({ 'node_modules/ms': { version: '2.1.3', resolved: `https://codeload.github.com/o/ms/tar.gz/${'a'.repeat(40)}`, integrity: SRI } }).lock('npm', 'ms', '2.1.3'), { from: 'git', integrity: SRI, at }, 'npm\'s of GitHub\'s tarball of a commit')
})

test('validate: a bundle is held to the stasis.lock.json its repository commits beside it, and a stasis.lock.json validates as a bundle does', withTmp(async (t, tmp) => {
  const lock = `lockfileVersion: '9.0'\n\nimporters:\n\n  web:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n\npackages:\n\n  ms@2.1.3:\n    resolution: {integrity: ${SRI}}\n\nsnapshots:\n\n  ms@2.1.3: {}\n`
  // Stasis's empty stub for a disabled import among its own files, of neither the repository nor a package.
  const modules = (ms) => new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n', '.stasis/empty-module.js': '' } }],
    ['node_modules/ms', { name: 'ms', version: '2.1.3', ecosystem: 'npm', files: { 'index.js': MS['index.js'] }, ...ms }],
  ])
  const sha512 = (path, content) => `sha512-${createHash('sha512').update(content).digest('base64')}`
  const bundle = new Bundle({ repo: { github: 'org/repo', directory: 'web', commit }, entries: new Set(['src/main.js']), modules: modules({ integrity: SRI }) })
  const committed = JSON.parse(Lockfile.fromBundle(new Bundle({ entries: new Set(['src/main.js']), modules: modules() }), sha512).serialize())
  committed.modules['node_modules/ms'].files['index.js'] = OTHER_SRI
  const files = { 'web/src/main.js': 'main\n', 'web/package.json': '{}\n', 'pnpm-lock.yaml': lock, 'web/stasis.lock.json': JSON.stringify(committed) }
  const file = join(tmp, 'app.stasis.code.br')
  writeBundle(file, bundle)
  const report = await validate(file, { client: repoClient(files), fetch: upstream() })
  t.assert.deepStrictEqual([report.status, report.stasisLockfile], ['invalid', { path: 'web/stasis.lock.json', error: "web/stasis.lock.json: content mismatch for 'node_modules/ms/index.js'" }])
  // One recording an execute bit the bundle doesn't: as stasis bundle holds a build, refused too.
  files['web/stasis.lock.json'] = Lockfile.fromBundle(new Bundle({ entries: new Set(['src/main.js']), modules: modules(), executable: new Set(['src/main.js']) }), sha512).serialize()
  const exec = await validate(file, { client: repoClient(files), fetch: upstream() })
  t.assert.deepStrictEqual([exec.status, exec.stasisLockfile], ['invalid', { path: 'web/stasis.lock.json', error: "web/stasis.lock.json: src/main.js's execute bit differs" }])
  // So does one recording what the bundle records otherwise, or none of; not one recording less than it.
  const lockOf = (ms) => Lockfile.fromBundle(new Bundle({ entries: new Set(['src/main.js']), modules: modules(ms) }), sha512).serialize()
  const bare = join(tmp, 'bare.stasis.code.br')
  writeBundle(bare, new Bundle({ repo: { github: 'org/repo', directory: 'web', commit }, entries: new Set(['src/main.js']), modules: modules() }))
  const held = (lockfile, of = file) => validate(of, { client: repoClient(Object.assign(files, { 'web/stasis.lock.json': lockfile })), fetch: upstream() }).then(({ status, stasisLockfile }) => [status, stasisLockfile])
  const refused = (error) => ['invalid', { path: 'web/stasis.lock.json', error: `web/stasis.lock.json: module 'node_modules/ms' ${error}` }]
  const patch = { integrity: patchIntegrity(sha256(MS_PATCH)) }
  t.assert.deepStrictEqual(await held(lockOf({ integrity: OTHER_SRI })), refused(`integrity mismatch ("${OTHER_SRI}" vs "${SRI}")`))
  t.assert.deepStrictEqual(await held(lockOf({ integrity: SRI }), bare), refused(`integrity mismatch ("${SRI}" vs none)`))
  t.assert.deepStrictEqual(await held(lockOf({ patch }), bare), refused(`patch mismatch (${JSON.stringify(patch)} vs none)`))
  const valid = ['valid', { path: 'web/stasis.lock.json' }]
  t.assert.deepStrictEqual([await held(lockOf(), bare), await held(lockOf())], [valid, valid])
  t.assert.deepStrictEqual(await held(lockOf({ files: AS_PUBLISHED })), valid, 'one of more of its files, recording none: held to it, not merged into it')
  // Its directory unlisted (own code alone, of no lockfile to find): failed, not passed over.
  const ownOnly = join(tmp, 'own.stasis.code.br')
  writeBundle(ownOnly, new Bundle({ repo: { github: 'org/repo', directory: 'web', commit }, modules: new Map([modules().entries().next().value]) }))
  const unlisted = repoClient(files)
  const list = unlisted.listRepoDir.bind(unlisted)
  unlisted.listRepoDir = async (options) => (options.directory === 'web' ? Promise.reject(new HttpError(500, 'GET contents/web 500')) : list(options))
  await t.assert.rejects(validate(ownOnly, { client: unlisted, fetch: upstream() }), /GET contents\/web 500/u)

  // The lockfile alone: each file of it held to its package's by its integrity, and its own code to the
  // repository's, which commits it alone.
  delete files['web/stasis.lock.json']
  const stasisLock = Lockfile.fromBundle(bundle, sha512)
  const lockPath = join(tmp, 'stasis.lock.json')
  writeFileSync(lockPath, stasisLock.serialize())
  const alone = await validate(lockPath, { client: repoClient(files), github: 'org/repo', sha: commit, directory: 'web', fetch: upstream() })
  t.assert.deepStrictEqual([alone.status, alone.counts.matched, alone.counts.files], ['valid', 2, 2])
  const edited = JSON.parse(stasisLock.serialize())
  edited.modules['node_modules/ms'].files['index.js'] = OTHER_SRI
  writeFileSync(lockPath, JSON.stringify(edited))
  const differs = await validate(lockPath, { client: repoClient(files), github: 'org/repo', sha: commit, directory: 'web', fetch: upstream() })
  t.assert.deepStrictEqual([differs.status, differs.problems], ['invalid', [{ path: 'node_modules/ms/index.js', kind: 'differs', of: 'npm:ms@2.1.3' }]])
}))

test('validate: a bundle of the lockfiles stasis.config.json names holds each package to the one whose tree installs it', withTmp(async (t, tmp) => {
  const pnpm = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      ms:\n        specifier: 2.1.3\n        version: 2.1.3\n\npackages:\n\n  ms@2.1.3:\n    resolution: {integrity: ${SRI}}\n\nsnapshots:\n\n  ms@2.1.3: {}\n`
  const npm = `${JSON.stringify({ name: 'tools', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'tools', version: '1.0.0', dependencies: { left: '1.0.0' } }, 'node_modules/left': lockEntry('left', '1.0.0', OTHER_SRI) } }, null, 2)}\n`
  const files = { 'src/main.js': 'main\n', 'package.json': '{}\n', 'pnpm-lock.yaml': pnpm, 'tools/package.json': '{}\n', 'tools/package-lock.json': npm, 'stasis.config.json': JSON.stringify({ lockfiles: ['pnpm-lock.yaml', 'tools/package-lock.json'] }) }
  const file = join(tmp, 'app.stasis.code.br')
  writeBundle(file, new Bundle({ repo: { github: 'org/repo', directory: '', commit }, modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
    ['node_modules/.pnpm/ms@2.1.3/node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } }],
    ['tools/node_modules/left', { name: 'left', version: '1.0.0', files: { 'index.js': 'original\n' } }],
  ]) }))
  const integrities = []
  const report = await validate(file, { client: repoClient(files), fetch: upstream(PACKAGES, [], integrities) })
  t.assert.deepStrictEqual([report.status, report.lockfiles], ['valid', ['pnpm-lock.yaml', 'tools/package-lock.json']])
  t.assert.deepStrictEqual(integrities.toSorted(), [['npm:left@1.0.0', OTHER_SRI], ['npm:ms@2.1.3', SRI]])

  // Each copy held to its tree's lockfile alone: of a version another tree's locks, and its own not.
  const empty = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n"
  const trees = { ...files, 'tools/pnpm-lock.yaml': empty, 'stasis.config.json': JSON.stringify({ lockfiles: ['pnpm-lock.yaml', 'tools/pnpm-lock.yaml'] }) }
  delete trees['tools/package-lock.json']
  writeBundle(file, new Bundle({ repo: { github: 'org/repo', directory: '', commit }, modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': 'main\n' } }],
    ['tools/node_modules/.pnpm/ms@2.1.3/node_modules/ms', { name: 'ms', version: '2.1.3', files: { 'index.js': MS['index.js'] } }],
  ]) }))
  const other = await validate(file, { client: repoClient(trees), fetch: upstream() })
  t.assert.deepStrictEqual([other.status, other.packages.map(({ status, reason }) => [status, reason])], ['invalid', [['invalid', 'not-locked']]])
}))

test('validate: a git dependency is held to its repository\'s tree at the commit its lockfile locks', withTmp(async (t, tmp) => {
  const at = 'c'.repeat(40)
  const lock = `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      dep:\n        specifier: github:o/dep#${at}\n        version: git+https://github.com/o/dep.git#${at}\n\npackages:\n\n  dep@git+https://github.com/o/dep.git#${at}:\n    resolution: {commit: ${at}, repo: https://github.com/o/dep.git, type: git}\n    version: 1.0.0\n\nsnapshots:\n\n  dep@git+https://github.com/o/dep.git#${at}: {}\n`
  // The repository's tree and the dependency's, as the fake client serves any repository's.
  const files = { 'src/main.js': 'main\n', 'pnpm-lock.yaml': lock, 'index.js': 'dep\n', 'package.json': '{"name":"dep","version":"1.0.0"}\n' }
  const dir = `node_modules/.pnpm/dep@git+https+++github.com+o+dep.git+${at}/node_modules/dep`
  const write = (depFiles) => writeBundle(join(tmp, 'app.stasis.code.br'), new Bundle({ repo: { github: 'org/repo', directory: '', commit }, modules: new Map([[dir, { name: 'dep', version: '1.0.0', files: depFiles }]]) }))
  const run = () => validate(join(tmp, 'app.stasis.code.br'), { client: repoClient(files), own: false, fetch: upstream() })
  write({ 'index.js': 'dep\n' })
  const valid = await run()
  t.assert.deepStrictEqual([valid.status, valid.packages], ['valid', []])
  // One its repository hasn't, which its install may build: unverified.
  write({ 'index.js': 'dep\n', 'dist/built.js': 'built\n' })
  const built = await run()
  t.assert.deepStrictEqual([built.status, built.counts.matched, built.counts.unverified, built.packages.map(({ status, reason }) => [status, reason])], ['incomplete', 1, 1, [['unverified', 'git-built']]])
  write({ 'index.js': 'tampered\n' })
  const invalid = await run()
  t.assert.deepStrictEqual([invalid.status, invalid.problems.map(({ path, kind }) => [path, kind])], ['invalid', [[`${dir}/index.js`, 'differs']]])
}))

test('validate: a Foundry submodule is held to its repository at the commit the repository\'s tree pins it at', withTmp(async (t, tmp) => {
  const pin = 'd'.repeat(40)
  // The repository's tree, its lib/dep a submodule at `pin`; and the submodule's, as the fake client serves any repository's.
  const client = repoClient({ 'src/A.sol': 'contract A {}\n', 'src/D.sol': 'contract D {}\n' })
  const list = client.listRepoDir.bind(client)
  client.listRepoDir = async (options) => (options.directory === 'lib' ? [{ path: 'dep', type: 'commit', sha: pin }] : list(options))
  // The submodule's record, of the repository at `at`.
  const write = (at, text = 'contract D {}\n') => writeBundle(join(tmp, 'app.stasis.code.br'), new Bundle({ repo: { github: 'org/repo', directory: '', commit }, modules: new Map([
    ['lib/dep', { name: 'dep', version: '1.0.0', ecosystem: 'github', repo: { github: 'o/dep', directory: '', commit: at }, files: { 'src/D.sol': text } }],
  ]) }))
  const run = () => validate(join(tmp, 'app.stasis.code.br'), { client, github: 'org/repo', sha: commit, own: false, fetch: upstream() })
  write(pin)
  const valid = await run()
  t.assert.deepStrictEqual([valid.status, valid.counts.matched], ['valid', 1])
  write('e'.repeat(40))
  t.assert.deepStrictEqual((await run()).packages.map(({ status, reason }) => [status, reason]), [['invalid', 'commit-not-locked']])
  write(pin, 'contract Tampered {}\n')
  t.assert.deepStrictEqual((await run()).problems, [{ path: 'lib/dep/src/D.sol', kind: 'differs', of: 'github:dep@1.0.0' }])
}))
