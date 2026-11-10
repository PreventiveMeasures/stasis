import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { State } from '@exodus/stasis-core/state'

import { patchIntegrity } from '../stasis/src/installed.js'
import { lockedBy, validateBundle, validationPlan } from '../stasis/src/validate.js'
import { buildVfsBundle } from '../stasis/src/vfs-bundle.js'
import { json, tarballOf, vfsOf } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

const PATCH = 'diff --git a/index.js b/index.js\nindex 1111111..2222222 100644\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1\n+module.exports = 2\n'
const HASH = createHash('sha256').update(PATCH).digest('hex')
const PATCHED = { integrity: patchIntegrity(HASH) }
const TARBALL = `sha512-${'A'.repeat(86)}==`
const OTHER_TARBALL = `sha512-${'B'.repeat(85)}A==`
const dep = (more = {}) => ({ name: 'dep', version: '1.0.0', ecosystem: 'npm', files: { 'index.js': 'module.exports = 1\n' }, ...more })
const bundleOf = (modules) => new Bundle({ config: { scope: 'node_modules' }, modules: new Map(Object.entries(modules)) })
const lockOf = (modules) => new Lockfile({ config: { scope: 'node_modules' }, modules: new Map(Object.entries(modules)), imports: new Map(), formats: new Map() })

test('a dependency record\'s integrity and patch: written, read back, and refused where invalid or of no npm dependency', (t) => {
  const record = dep({ integrity: TARBALL, repo: { github: 'o/dep' }, patch: PATCHED })
  const written = JSON.parse(bundleOf({ 'node_modules/dep': record }).serialize())
  t.assert.deepStrictEqual(Object.keys(written.modules['node_modules/dep']), ['name', 'version', 'ecosystem', 'integrity', 'repo', 'patch', 'files'])
  const parsed = Bundle.parse(JSON.stringify(written)).modules.get('node_modules/dep')
  t.assert.deepStrictEqual([parsed.integrity, { ...parsed.patch }], [TARBALL, PATCHED])
  const lock = JSON.parse(Lockfile.fromBundle(bundleOf({ 'node_modules/dep': record }), () => TARBALL).serialize())
  t.assert.deepStrictEqual(Object.keys(lock.modules['node_modules/dep']), ['name', 'version', 'ecosystem', 'integrity', 'patch', 'files'], 'no repo')
  t.assert.equal(Lockfile.parse(JSON.stringify(lock)).modules.get('node_modules/dep').integrity, TARBALL)
  lock.modules['node_modules/dep'].integrity = 'not one'
  t.assert.throws(() => Lockfile.parse(JSON.stringify(lock)), /invalid lockfile module 'node_modules\/dep' integrity/u)
  const buckets = { '.': { name: 'app', version: '1.0.0', files: { 'a.js': '' } }, 'node_modules/dep': dep(), 'packages/lib': { name: 'lib', version: '1.0.0', ecosystem: 'npm', files: { 'b.js': '' } }, 'vendor/serde': { name: 'serde', version: '1.0.0', ecosystem: 'cargo', files: { 'src/lib.rs': '' } } }
  const full = (modules) => new Bundle({ config: { scope: 'full' }, entries: new Set(['a.js']), modules: new Map(Object.entries(modules)) })
  const refused = (dir, field, value, pattern) => {
    const edited = JSON.parse(full(buckets).serialize())
    ;(edited.modules[dir] ?? edited.sources[dir])[field] = value
    t.assert.throws(() => Bundle.parse(JSON.stringify(edited)), pattern, `parse: ${dir} ${JSON.stringify(value)}`)
    t.assert.throws(() => full({ ...buckets, [dir]: { ...buckets[dir], [field]: value } }).serialize(), pattern, `serialize: ${dir} ${JSON.stringify(value)}`)
  }
  for (const integrity of ['sha1-abc', `sha512-${'A'.repeat(85)}==`, patchIntegrity(HASH), 1]) refused('node_modules/dep', 'integrity', integrity, /invalid bundle module 'node_modules\/dep' integrity/u)
  for (const patch of [{}, { integrity: 'sha256-abc' }, { integrity: TARBALL }, { hash: HASH }, { ...PATCHED, path: 'patches/dep.patch' }, patchIntegrity(HASH), null]) refused('node_modules/dep', 'patch', patch, /bundle module 'node_modules\/dep' patch/u)
  for (const dir of ['.', 'packages/lib', 'vendor/serde']) refused(dir, 'patch', PATCHED, new RegExp(`'${RegExp.escape(dir)}' is no npm dependency's bucket, and carries no patch`, 'u'))
})

test('a merge keeps one side\'s integrity or patch, and refuses two that differ or one of fewer files', (t) => {
  const more = { files: { 'index.js': 'module.exports = 1\n', 'more.js': 'module.exports = 2\n' } }
  const cases = [
    ['the first\'s patch', { patch: PATCHED }, {}, { patch: PATCHED }],
    ['the second\'s patch', {}, { patch: PATCHED }, { patch: PATCHED }],
    ['the first\'s integrity', { integrity: TARBALL }, {}, { integrity: TARBALL }],
    ['the second\'s integrity', {}, { integrity: TARBALL }, { integrity: TARBALL }],
    ['both\'s', { integrity: TARBALL, patch: PATCHED }, { integrity: TARBALL, patch: PATCHED }, { integrity: TARBALL, patch: PATCHED }],
    ['two patches', { patch: PATCHED }, { patch: { integrity: patchIntegrity('0'.repeat(64)) } }, /module 'node_modules\/dep' patch mismatch/u],
    ['two integrities', { integrity: TARBALL }, { integrity: OTHER_TARBALL }, /module 'node_modules\/dep' integrity mismatch/u],
    ['an integrity of fewer files', { integrity: TARBALL }, more, /module 'node_modules\/dep' integrity is recorded of one side's files, not of 'node_modules\/dep\/more\.js' the other adds/u],
    ['a patch of fewer files', more, { patch: PATCHED }, /module 'node_modules\/dep' patch is recorded of one side's files, not of 'node_modules\/dep\/more\.js' the other adds/u],
  ]
  for (const [kind, of] of [['bundle', bundleOf], ['lockfile', lockOf]]) {
    for (const [label, a, b, expected] of cases) {
      const merged = () => of({ 'node_modules/dep': dep(a) }).merge(of({ 'node_modules/dep': dep(b) })).modules.get('node_modules/dep')
      if (expected instanceof RegExp) t.assert.throws(merged, expected, `${kind}: ${label}`)
      else t.assert.deepStrictEqual(JSON.parse(JSON.stringify(merged(), ['integrity', 'patch'])), expected, `${kind}: ${label}`)
    }
  }
})

// An app requiring dep, installed; a run capturing dep's `files` (and its entry, with no parent); dep's record edited.
const installed = (dir) => {
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  for (const [path, text] of Object.entries({ 'package.json': json({ name: 'app', version: '1.0.0' }), 'index.js': "require('dep')\n", 'node_modules/dep/package.json': json({ name: 'dep', version: '1.0.0' }) })) writeFileSync(join(dir, path), text)
  for (const file of ['index.js', 'more.js', 'data.bin']) writeFileSync(join(dir, 'node_modules', 'dep', file), 'module.exports = 1\n')
}
const captured = (dir, options, files = ['index.js']) => {
  const state = new State(dir, { scope: 'full', ...options })
  const add = (rel, how) => state.addFile(pathToFileURL(join(dir, rel)).toString(), how)
  if (!options.parent) add('index.js', { format: 'commonjs', isEntry: true })
  for (const file of files) add(`node_modules/dep/${file}`, file.endsWith('.bin') ? { resource: true } : { format: 'commonjs' })
  return state
}
const attest = (path, integrity, more) => {
  const br = path.endsWith('.br')
  const artifact = JSON.parse(br ? brotliDecompressSync(readFileSync(path)) : readFileSync(path, 'utf8'))
  Object.assign(artifact.modules['node_modules/dep'], { integrity, ...more })
  writeFileSync(path, br ? brotliCompressSync(JSON.stringify(artifact)) : JSON.stringify(artifact))
}

test('a run holds a bundle\'s dependency integrity to its lockfile\'s, and writes back the bundle\'s alone', withTmp((t, dir) => {
  installed(dir)
  const [lockPath, bundlePath] = ['stasis.lock.json', 'stasis.code.br'].map((file) => join(dir, file))
  const locked = () => JSON.parse(readFileSync(lockPath, 'utf8')).modules['node_modules/dep']
  const frozen = () => new State(dir, { scope: 'full', bundle: 'load', lock: 'frozen' })
  captured(dir, { bundle: 'replace', lock: 'replace' }).write()
  attest(lockPath, TARBALL)
  attest(bundlePath, OTHER_TARBALL)
  t.assert.throws(frozen, /bundle module node_modules\/dep \(against the lockfile\) integrity mismatch/u)
  attest(bundlePath, TARBALL)
  t.assert.doesNotThrow(frozen)
  captured(dir, { bundle: 'ignore', lock: 'add' }).write()
  t.assert.equal(locked().integrity, TARBALL, 'kept: the run adds nothing to what it attests')
  const more = captured(dir, { bundle: 'ignore', lock: 'add' }, ['index.js', 'more.js'])
  t.assert.throws(() => more.write(), /module 'node_modules\/dep': its integrity is recorded of the files it was read with, not of node_modules\/dep\/more\.js, which this run adds/u)
  t.assert.ok(!Object.hasOwn(locked().files, 'more.js'), 'the lockfile left as it was')
  captured(dir, { bundle: 'replace', lock: 'replace' }).write()
  attest(bundlePath, TARBALL)
  captured(dir, { bundle: 'add', lock: 'add' }).write()
  t.assert.equal(locked().integrity, TARBALL, 'the bundle\'s alone, of a lockfile recording none, taken')
  captured(dir, { bundle: 'replace', lock: 'replace' }).write()
  captured(dir, { bundle: 'ignore', lock: 'add' }, ['index.js', 'more.js']).write()
  attest(bundlePath, TARBALL)
  t.assert.equal(frozen().modules.get('node_modules/dep').integrity, undefined, 'not of a file the lockfile records and the bundle doesn\'t hold')
  t.assert.throws(() => new State(dir, { scope: 'full', bundle: 'add', lock: 'add' }), /bundle module node_modules\/dep integrity is recorded of its files, not of 'node_modules\/dep\/more\.js' its record holds/u, 'nor rewritten without it')
}))

test('a split bundle\'s halves and a sidecar agree on what they alone attest of a package, each held to the install', withTmp((t, dir) => {
  installed(dir)
  const at = (file) => join(dir, file)
  const split = { bundleFile: at('code.br'), resourcesBundleFile: at('res.br') }
  const root = captured(dir, { ...split, bundle: 'replace', lock: 'replace' }, ['index.js', 'data.bin'])
  captured(dir, { parent: root, bundle: 'replace', lock: 'replace', bundleFile: at('side.br') }, ['more.js']).write()
  root.write()
  const loaded = () => new State(dir, { scope: 'full', ...split, bundle: 'load', lock: 'frozen' })
  const sidecar = () => new State(dir, { scope: 'full', parent: loaded(), bundle: 'load', lock: 'frozen', bundleFile: at('side.br') })
  attest(at('code.br'), TARBALL)
  attest(at('res.br'), OTHER_TARBALL)
  t.assert.throws(loaded, /bundle: module 'node_modules\/dep' integrity mismatch/u, 'its halves')
  attest(at('res.br'), undefined, { patch: PATCHED })
  t.assert.throws(loaded, /bundle: module 'node_modules\/dep' (integrity|patch) is recorded of one side's files/u, 'its halves, each of its own')
  attest(at('res.br'), TARBALL, { patch: undefined })
  t.assert.equal(loaded().modules.get('node_modules/dep').integrity, undefined, 'of fewer files than the lockfile records: not the run\'s')
  attest(at('side.br'), OTHER_TARBALL)
  t.assert.throws(sidecar, /bundle: module 'node_modules\/dep' integrity mismatch/u, 'a sidecar\'s')
  attest(at('side.br'), TARBALL)
  t.assert.equal(sidecar().modules.get('node_modules/dep').integrity, TARBALL, 'of every file the lockfile records, between the bundles')
  const rewritten = new State(dir, { scope: 'full', ...split, bundle: 'add', lock: 'ignore', claim: false })
  new State(dir, { scope: 'full', parent: rewritten, bundle: 'add', lock: 'ignore', bundleFile: at('side.br'), claim: false }).write()
  t.assert.doesNotThrow(() => rewritten.write(), 'the sidecar\'s files absorbed ones, not the run\'s')
  const parent = new State(dir, { scope: 'full', ...split, bundle: 'load', lock: 'ignore' })
  const writing = captured(dir, { parent, bundle: 'add', lock: 'ignore', bundleFile: at('side2.br'), claim: false }, ['more.js'])
  t.assert.throws(() => writing.write(), /its integrity is recorded of the files it was read with, not of node_modules\/dep\/more\.js/u, 'a writing sidecar\'s own capture')
  const hook = Symbol.for('@exodus/stasis-core/installed')
  const install = (integrity) => Object.assign(globalThis, { [hook]: (modules) => new Map(modules.has('node_modules/dep') ? [['node_modules/dep', { integrity, installed: true }]] : []) })
  t.after(() => delete globalThis[hook])
  install(OTHER_TARBALL)
  t.assert.throws(loaded, /code\.br: module 'node_modules\/dep' \(recorded vs installed\) integrity mismatch/u)
  install(TARBALL)
  t.assert.doesNotThrow(sidecar)
  for (const file of ['code.br', 'res.br']) attest(at(file), undefined)
  attest(at('side.br'), OTHER_TARBALL)
  t.assert.throws(sidecar, /side\.br: module 'node_modules\/dep' \(recorded vs installed\) integrity mismatch/u)
}))

// dep 1.0.0, which the lockfile patches, and other 1.0.0: as published, and as a cache store holds them.
const PACKAGES = Object.fromEntries(await Promise.all(['dep', 'other'].map(async (name) => {
  const files = { 'package.json': json({ name, version: '1.0.0', main: 'index.js' }), 'index.js': 'module.exports = 1\n' }
  const tarball = await tarballOf(files)
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  return [name, { files, tarball, integrity, document: { name, version: '1.0.0', dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity } } }]
})))
const kept = new Map(Object.entries(PACKAGES).flatMap(([name, { tarball, document }]) => [[`npm/tarballs ${name}@1.0.0`, tarball], [`npm/versions ${name}@1.0.0`, document]]))
const cache = { read: async (type, key) => kept.get(`${type} ${key}`), write: async () => {} }
const PNPM_LOCK = `lockfileVersion: '9.0'\n\npatchedDependencies:\n  dep@1.0.0:\n    hash: ${HASH}\n    path: patches/dep@1.0.0.patch\n\nimporters:\n\n  .:\n    dependencies:\n      dep:\n        specifier: 1.0.0\n        version: 1.0.0(patch_hash=${HASH})\n      other:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  dep@1.0.0:\n    resolution: {integrity: ${PACKAGES.dep.integrity}}\n\n  other@1.0.0:\n    resolution: {integrity: ${PACKAGES.other.integrity}}\n\nsnapshots:\n\n  dep@1.0.0(patch_hash=${HASH}): {}\n\n  other@1.0.0: {}\n`
const PROJECT = { 'package.json': json({ name: 'p', version: '1.0.0', dependencies: { dep: '1.0.0', other: '1.0.0' } }), 'pnpm-workspace.yaml': 'patchedDependencies:\n  dep@1.0.0: patches/dep@1.0.0.patch\n', 'pnpm-lock.yaml': PNPM_LOCK, 'patches/dep@1.0.0.patch': PATCH, 'src/a.js': "require('dep')\nrequire('other')\n" }

for (const lazy of [false, true]) {
  test(`pnpm${lazy ? ', lazily' : ''}: a build from a lockfile alone records each package's integrity and patch, which validation holds them to`, async (t) => {
    const { bundle, lockfile } = await buildVfsBundle({ vfs: vfsOf(PROJECT), packageManager: 'pnpm', entries: ['src/a.js'], scope: 'full', cache, lazy })
    const { dep: built, other } = Object.fromEntries([...bundle.modules].filter(([, info]) => info.ecosystem === 'npm').map(([dir, info]) => [info.name, { dir, ...info }]))
    t.assert.deepStrictEqual([built.integrity, { ...built.patch }, built.files['index.js'], other.integrity, other.patch], [PACKAGES.dep.integrity, PATCHED, 'module.exports = 2\n', PACKAGES.other.integrity, undefined])
    t.assert.deepStrictEqual(Object.keys(JSON.parse(lockfile.serialize()).modules[built.dir]), ['name', 'version', 'ecosystem', 'integrity', 'patch', 'files'])
    const fetch = async (ecosystem, name) => new Map(Object.entries(PACKAGES[name].files).map(([path, text]) => [path, new TextEncoder().encode(text)]))
    const report = await validateBundle(validationPlan(Bundle.parse(bundle.serialize())), { reason: 'skipped' }, { fetch, locked: lockedBy([{ path: 'pnpm-lock.yaml', text: PNPM_LOCK, from: 'local', read: async (path) => PROJECT[path] }]) })
    t.assert.deepStrictEqual([report.status, report.packages.find((pkg) => pkg.name === 'dep').patch], ['valid', { hash: HASH, path: 'patches/dep@1.0.0.patch', from: 'local', recorded: true, applied: true }])
  })
}
