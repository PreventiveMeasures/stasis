import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { State } from '@exodus/stasis-core/state'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

import { patchIntegrity } from '../stasis/src/installed.js'
import { lockedBy, validateBundle, validationPlan } from '../stasis/src/validate.js'
import { buildVfsBundle } from '../stasis/src/vfs-bundle.js'
import { json, vfsOf } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

// An npm dependency record's `integrity`, its tarball's, and `patch`, the patch pnpm installed it with:
// a bundle and its lockfile carry them, a merge or a run holds two records of them to each other, and
// a build from a lockfile alone records deptree's, which `stasis validate` holds them to.

const encoder = new TextEncoder()
const PATCH = 'diff --git a/index.js b/index.js\nindex 1111111..2222222 100644\n--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-module.exports = 1\n+module.exports = 2\n'
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const HASH = sha256(PATCH)
const OTHER = sha256('another patch\n')
const TARBALL = `sha512-${'A'.repeat(86)}==`
const dep = (more = {}) => ({ name: 'dep', version: '1.0.0', ecosystem: 'npm', ...more, files: { 'index.js': 'module.exports = 1\n' } })
const bundleOf = (modules) => new Bundle({ config: { scope: 'node_modules' }, modules: new Map(Object.entries(modules)) })
const lockOf = (modules) => new Lockfile({ config: { scope: 'node_modules' }, modules: new Map(Object.entries(modules)), imports: new Map(), formats: new Map() })

test('a dependency record carries integrity after ecosystem and patch after repo in a bundle and its lockfile', (t) => {
  const record = dep({ integrity: TARBALL, repo: { github: 'o/dep' }, patch: { integrity: patchIntegrity(HASH) } })
  const written = JSON.parse(bundleOf({ 'node_modules/dep': record }).serialize())
  t.assert.deepStrictEqual(Object.keys(written.modules['node_modules/dep']), ['name', 'version', 'ecosystem', 'integrity', 'repo', 'patch', 'files'])
  const parsed = Bundle.parse(JSON.stringify(written)).modules.get('node_modules/dep')
  t.assert.deepStrictEqual([parsed.integrity, { ...parsed.patch }], [TARBALL, { integrity: patchIntegrity(HASH) }])
  const lock = JSON.parse(lockOf({ 'node_modules/dep': record }).serialize())
  t.assert.deepStrictEqual(Object.keys(lock.modules['node_modules/dep']), ['name', 'version', 'ecosystem', 'integrity', 'patch', 'files'], 'no repo')
  t.assert.deepStrictEqual(Lockfile.parse(JSON.stringify(lock)).modules.get('node_modules/dep').integrity, TARBALL)
  lock.modules['node_modules/dep'].integrity = 'not one'
  t.assert.throws(() => Lockfile.parse(JSON.stringify(lock)), /invalid lockfile module 'node_modules\/dep' integrity/u)
  const fromBundle = Lockfile.fromBundle(bundleOf({ 'node_modules/dep': record }), () => TARBALL)
  t.assert.deepStrictEqual(JSON.parse(fromBundle.serialize()).modules['node_modules/dep'].patch, { integrity: patchIntegrity(HASH) })
})

test('a dependency integrity and patch are validated on parse and on serialize, and only an npm dependency carries them', (t) => {
  const refused = (field, value, pattern) => {
    const edited = JSON.parse(bundleOf({ 'node_modules/dep': dep() }).serialize())
    edited.modules['node_modules/dep'][field] = value
    t.assert.throws(() => Bundle.parse(JSON.stringify(edited)), pattern, `parse: ${JSON.stringify(value)}`)
    t.assert.throws(() => bundleOf({ 'node_modules/dep': dep({ [field]: value }) }).serialize(), pattern, `serialize: ${JSON.stringify(value)}`)
  }
  for (const integrity of ['sha1-abc', `sha512-${'A'.repeat(85)}==`, patchIntegrity(HASH), 1]) refused('integrity', integrity, /invalid bundle module 'node_modules\/dep' integrity/u)
  for (const patch of [{}, { integrity: 'sha256-abc' }, { integrity: TARBALL }, { hash: HASH }, { integrity: patchIntegrity(HASH), path: 'patches/dep.patch' }, patchIntegrity(HASH), null]) {
    refused('patch', patch, /bundle module 'node_modules\/dep' patch/u)
  }
  const patch = { integrity: patchIntegrity(HASH) }
  const crate = { name: 'serde', version: '1.0.0', ecosystem: 'cargo', patch, files: { 'src/lib.rs': '' } }
  t.assert.throws(() => new Bundle({ config: { scope: 'full' }, entries: new Set(), modules: new Map([['vendor/serde', crate]]) }).serialize(), /'vendor\/serde' is no npm dependency's bucket, and carries no patch/u, 'a crate\'s: a cargo [patch] is another thing')
  const full = JSON.parse(new Bundle({ config: { scope: 'full' }, entries: new Set(['a.js']), modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'a.js': '' } }], ['packages/lib', { name: 'lib', version: '1.0.0', ecosystem: 'npm', files: { 'b.js': '' } }]]) }).serialize())
  for (const dir of ['.', 'packages/lib']) {
    const edited = structuredClone(full)
    edited.sources[dir].patch = patch
    t.assert.throws(() => Bundle.parse(JSON.stringify(edited)), new RegExp(`'${dir.replace('.', '\\.')}' is no npm dependency's bucket`, 'u'), `first-party code's: ${dir}`)
  }
})

test('merging bundles or lockfiles keeps a dependency integrity or patch both sides record, drops one only one does, and refuses two that differ', (t) => {
  const recorded = (hash, integrity) => ({ 'node_modules/dep': dep({ ...(hash && { patch: { integrity: patchIntegrity(hash) } }), ...(integrity && { integrity }) }) })
  for (const [label, of] of [['bundle', bundleOf], ['lockfile', lockOf]]) {
    const merged = (a, b) => of(a).merge(of(b)).modules.get('node_modules/dep')
    t.assert.equal(merged(recorded(), recorded(HASH)).patch, undefined, `${label}: it attests the other's files alone`)
    t.assert.equal(merged(recorded(undefined, TARBALL), recorded()).integrity, undefined, label)
    t.assert.deepStrictEqual([merged(recorded(HASH, TARBALL), recorded(HASH, TARBALL)).integrity, { ...merged(recorded(HASH, TARBALL), recorded(HASH, TARBALL)).patch }], [TARBALL, { integrity: patchIntegrity(HASH) }], label)
    t.assert.throws(() => merged(recorded(HASH), recorded(OTHER)), /module 'node_modules\/dep' patch mismatch/u, label)
    t.assert.throws(() => merged(recorded(undefined, TARBALL), recorded(undefined, `sha512-${'B'.repeat(85)}A==`)), /module 'node_modules\/dep' integrity mismatch/u, label)
  }
})

test('a run holds a bundle\'s dependency integrity to its lockfile\'s, and writes the lockfile\'s back', withTmp((t, dir) => {
  writeFileSync(join(dir, 'package.json'), json({ name: 'app', version: '1.0.0' }))
  writeFileSync(join(dir, 'index.js'), "require('dep')\n")
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'dep', 'package.json'), json({ name: 'dep', version: '1.0.0' }))
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  const run = (options) => {
    const state = new State(dir, { scope: 'full', ...options })
    state.addFile(pathToFileURL(join(dir, 'index.js')).toString(), { format: 'commonjs', isEntry: true })
    state.addFile(pathToFileURL(join(dir, 'node_modules', 'dep', 'index.js')).toString(), { format: 'commonjs' })
    return state
  }
  run({ bundle: 'replace', lock: 'replace' }).write()
  const lockPath = join(dir, 'stasis.lock.json')
  const bundlePath = join(dir, 'stasis.code.br')
  const edit = (path, read, write, integrity) => {
    const artifact = read(path)
    artifact.modules['node_modules/dep'].integrity = integrity
    writeFileSync(path, write(artifact))
  }
  const editLock = (integrity) => edit(lockPath, (path) => JSON.parse(readFileSync(path, 'utf8')), (value) => JSON.stringify(value), integrity)
  const editBundle = (integrity) => edit(bundlePath, (path) => JSON.parse(brotliDecompressSync(readFileSync(path))), (value) => brotliCompressSync(JSON.stringify(value)), integrity)
  editLock(TARBALL)
  editBundle(`sha512-${'B'.repeat(85)}A==`)
  t.assert.throws(() => new State(dir, { scope: 'full', bundle: 'load', lock: 'frozen' }), /bundle module node_modules\/dep \(against the lockfile\) integrity mismatch/u)
  editBundle(TARBALL)
  t.assert.doesNotThrow(() => new State(dir, { scope: 'full', bundle: 'load', lock: 'frozen' }))
  run({ bundle: 'ignore', lock: 'add' }).write()
  t.assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).modules['node_modules/dep'].integrity, TARBALL, 'kept: the run adds nothing to what it attests')
  // A file the run adds to the record: what the lockfile attests is its files without it.
  writeFileSync(join(dir, 'node_modules', 'dep', 'more.js'), 'module.exports = 2\n')
  const more = run({ bundle: 'ignore', lock: 'add' })
  more.addFile(pathToFileURL(join(dir, 'node_modules', 'dep', 'more.js')).toString(), { format: 'commonjs' })
  more.write()
  t.assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).modules['node_modules/dep'].integrity, undefined, 'dropped')
}))

// dep 1.0.0 as published, which the lockfile patches, and other 1.0.0, which it doesn't: each as a
// cache store holds its tarball and the registry's document of it, so nothing is fetched.
async function published(name) {
  const files = { 'package.json': json({ name, version: '1.0.0', main: 'index.js' }), 'index.js': 'module.exports = 1\n' }
  const tarball = await compress(pack(Object.entries(files).map(([path, text]) => ({ name: `package/${path}`, data: encoder.encode(text), mode: 0o644 }))), 'gzip')
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  return { name, files, tarball, integrity, document: { name, version: '1.0.0', dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity } } }
}
const PACKAGES = Object.fromEntries(await Promise.all(['dep', 'other'].map(async (name) => [name, await published(name)])))
const cache = () => {
  const kept = new Map(Object.values(PACKAGES).flatMap(({ name, tarball, document }) => [[`npm/tarballs ${name}@1.0.0`, tarball], [`npm/versions ${name}@1.0.0`, document]]))
  return { read: async (type, key) => kept.get(`${type} ${key}`), write: async () => {} }
}
const PNPM_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

patchedDependencies:
  dep@1.0.0:
    hash: ${HASH}
    path: patches/dep@1.0.0.patch

importers:

  .:
    dependencies:
      dep:
        specifier: 1.0.0
        version: 1.0.0(patch_hash=${HASH})
      other:
        specifier: 1.0.0
        version: 1.0.0

packages:

  dep@1.0.0:
    resolution: {integrity: ${PACKAGES.dep.integrity}}

  other@1.0.0:
    resolution: {integrity: ${PACKAGES.other.integrity}}

snapshots:

  dep@1.0.0(patch_hash=${HASH}): {}

  other@1.0.0: {}
`
const PROJECT = {
  'package.json': json({ name: 'p', version: '1.0.0', dependencies: { dep: '1.0.0', other: '1.0.0' } }),
  'pnpm-workspace.yaml': 'patchedDependencies:\n  dep@1.0.0: patches/dep@1.0.0.patch\n',
  'pnpm-lock.yaml': PNPM_LOCK,
  'patches/dep@1.0.0.patch': PATCH,
  'src/a.js': "require('dep')\nrequire('other')\n",
}
// What upstream serves of each, as validation fetches it.
const fetch = async (ecosystem, name) => new Map(Object.entries(PACKAGES[name].files).map(([path, text]) => [path, encoder.encode(text)]))
const locked = () => lockedBy([{ path: 'pnpm-lock.yaml', text: PNPM_LOCK, from: 'local', read: async (path) => PROJECT[path] }])

for (const lazy of [false, true]) {
  test(`pnpm${lazy ? ', lazily' : ''}: a build from a lockfile alone records each package's integrity and patch, which validation holds them to`, async (t) => {
    const { bundle, lockfile } = await buildVfsBundle({ vfs: vfsOf(PROJECT), packageManager: 'pnpm', entries: ['src/a.js'], scope: 'full', cache: cache(), lazy })
    const byName = new Map([...bundle.modules].filter(([, info]) => info.ecosystem === 'npm').map(([dir, info]) => [info.name, { dir, ...info }]))
    t.assert.deepStrictEqual({ ...byName.get('dep').patch }, { integrity: patchIntegrity(HASH) })
    t.assert.equal(byName.get('dep').files['index.js'], 'module.exports = 2\n', 'its files patched')
    t.assert.equal(byName.get('other').patch, undefined)
    t.assert.deepStrictEqual([byName.get('dep').integrity, byName.get('other').integrity], [PACKAGES.dep.integrity, PACKAGES.other.integrity])
    t.assert.deepStrictEqual(Object.keys(JSON.parse(lockfile.serialize()).modules[byName.get('dep').dir]), ['name', 'version', 'ecosystem', 'integrity', 'patch', 'files'])

    // Its dependencies validated, as the bundle has them, else with `more` in its record of dep.
    const parsed = Bundle.parse(bundle.serialize())
    const { dir } = byName.get('dep')
    const validated = (more = {}) => validateBundle(validationPlan({ formats: parsed.formats, modules: new Map(parsed.modules).set(dir, { ...parsed.modules.get(dir), ...more }) }),
      { reason: 'skipped' }, { fetch, locked: locked() })
    const report = await validated()
    t.assert.equal(report.status, 'valid')
    t.assert.deepStrictEqual(report.packages.find((pkg) => pkg.name === 'dep').patch, { hash: HASH, path: 'patches/dep@1.0.0.patch', from: 'local', recorded: true, applied: true })

    // Recording another patch or tarball than the lockfile's, or its patch with its files as published:
    // none passes, as the same files recording none would.
    t.assert.deepStrictEqual((await validated({ patch: { integrity: patchIntegrity(OTHER) } })).packages.find((pkg) => pkg.name === 'dep'),
      { ecosystem: 'npm', name: 'dep', version: '1.0.0', files: 1, status: 'invalid', reason: 'patch-not-locked', patch: { hash: OTHER, recorded: true } })
    t.assert.equal((await validated({ integrity: PACKAGES.other.integrity })).packages.find((pkg) => pkg.name === 'dep').reason, 'integrity-not-locked')
    const unpatched = { ...parsed.modules.get(dir).files, 'index.js': 'module.exports = 1\n' }
    t.assert.equal((await validated({ files: unpatched })).status, 'invalid', 'as published, though it records its patch')
    t.assert.equal((await validated({ files: unpatched, patch: undefined })).status, 'invalid', 'as published, recording none: the lockfile locks it patched')
  })
}
