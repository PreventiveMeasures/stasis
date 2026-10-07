import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { addCommand } from '@exodus/stasis-core/add'
import { findPackageMetadata, packageRepo } from '@exodus/stasis-core/bundle-util'
import { State } from '@exodus/stasis-core/state'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-dep-repo-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))
const readBundle = (file) => JSON.parse(brotliDecompressSync(readFileSync(file)).toString('utf8'))

const DEP_REPO = { github: 'o/dep', directory: 'packages/dep' }
const COMMIT = 'a'.repeat(40)
const dep = (repo) => ({ name: 'dep', version: '1.0.0', ecosystem: 'npm', ...(repo && { repo }), files: { 'index.js': 'module.exports = 1\n' } })
const bundleOf = (modules) => new Bundle({ config: { scope: 'node_modules' }, modules: new Map(Object.entries(modules)) })
const lockOf = (modules) => new Lockfile({ config: { scope: 'node_modules' }, modules: new Map(Object.entries(modules)), imports: new Map(), formats: new Map() })

// A project whose one dependency's package.json is `pkg` beside `name` and `version`, imported by index.js.
function writeProject(dir, pkg) {
  writeJson(join(dir, 'package.json'), { name: 'app', version: '1.0.0' })
  writeFileSync(join(dir, 'index.js'), "require('dep')\n")
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeJson(join(dir, 'node_modules', 'dep', 'package.json'), { name: 'dep', version: '1.0.0', ...pkg })
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
}

// A State over `dir` with the dependency's index.js added, as `stasis run` records it.
function capture(dir, options) {
  const state = new State(dir, { scope: 'full', ...options })
  state.addFile(pathToFileURL(join(dir, 'index.js')).toString(), { format: 'commonjs', isEntry: true })
  state.addFile(pathToFileURL(join(dir, 'node_modules', 'dep', 'index.js')).toString(), { format: 'commonjs' })
  return state
}

test("a dependency repo is read as a build reads its own: a declared directory at the root is `''`, none declared is unknown", withTmp((t, dir) => {
  t.assert.deepStrictEqual(packageRepo({ repository: 'github:o/n' }), { github: 'o/n' }, 'no directory: unknown, not the root')
  for (const directory of ['./', '.', '', '/', '/.', './.', '.\\']) {
    t.assert.deepStrictEqual(packageRepo({ repository: { url: 'github:o/n', directory } }), { github: 'o/n', directory: '' }, `${JSON.stringify(directory)}: the root`)
  }
  for (const path of ['.', './', '%2E']) {
    t.assert.deepStrictEqual(packageRepo({ repository: 'github:o/n', homepage: `https://github.com/o/n/tree/main/${path}` }), { github: 'o/n' }, `homepage ${path}: no claim on the root`)
  }
  for (const directory of ['../x', 'a/..', 'a/../', 'a/../b']) {
    t.assert.deepStrictEqual(packageRepo({ repository: { url: 'github:o/n', directory } }), { github: 'o/n' }, `${JSON.stringify(directory)}: a \`..\` part, unknown`)
  }
  t.assert.deepStrictEqual(packageRepo({ repository: { url: 'github:o/n', directory: 'packages/x' } }), { github: 'o/n', directory: 'packages/x' })
  for (const pkg of [{}, { repository: 'https://gitlab.com/o/n' }, { bugs: 'https://github.com/o/n/issues' }, { homepage: 'https://github.com/o/n' }, null]) {
    t.assert.equal(packageRepo(pkg), undefined, `${JSON.stringify(pkg)}: repository alone names it`)
  }
  writeProject(dir, { repository: 'github:o/dep' })
  t.assert.deepStrictEqual(findPackageMetadata(dir, 'node_modules/dep/index.js'),
    { pkgDir: 'node_modules/dep', name: 'dep', version: '1.0.0', ecosystem: 'npm', repo: { github: 'o/dep' } })
  writeProject(dir, { repository: { url: 'github:o/dep', directory: './' } })
  t.assert.deepStrictEqual(findPackageMetadata(dir, 'node_modules/dep/index.js').repo, { github: 'o/dep', directory: '' })
}))

test('a dependency record carries repo after ecosystem in a bundle; a lockfile neither writes nor reads one', (t) => {
  const modules = { 'node_modules/dep': dep({ directory: 'packages/dep', github: 'o/dep' }) }
  const json = JSON.parse(bundleOf(modules).serialize())
  t.assert.deepStrictEqual(Object.keys(json.modules['node_modules/dep']), ['name', 'version', 'ecosystem', 'repo', 'files'])
  t.assert.deepStrictEqual(Object.keys(json.modules['node_modules/dep'].repo), ['github', 'directory'], 'canonical key order')
  t.assert.deepStrictEqual({ ...Bundle.parse(JSON.stringify(json)).modules.get('node_modules/dep').repo }, DEP_REPO)
  t.assert.equal(JSON.parse(bundleOf({ 'node_modules/dep': dep() }).serialize()).modules['node_modules/dep'].repo, undefined, 'none: no key')

  const lock = JSON.parse(lockOf(modules).serialize())
  t.assert.deepStrictEqual(Object.keys(lock.modules['node_modules/dep']), ['name', 'version', 'ecosystem', 'files'], 'metadata: never in a lockfile')
  lock.modules['node_modules/dep'].repo = DEP_REPO
  t.assert.equal(Lockfile.parse(JSON.stringify(lock)).modules.get('node_modules/dep').repo, undefined, 'nor read from one')
})

test('a dependency repo may name a commit: `{ github, directory?, commit? }`, in that order, in a bundle alone', (t) => {
  for (const repo of [{ commit: COMMIT, directory: 'packages/dep', github: 'o/dep' }, { commit: COMMIT, github: 'o/dep' }]) {
    const json = JSON.parse(bundleOf({ 'node_modules/dep': dep(repo) }).serialize())
    t.assert.deepStrictEqual(Object.keys(json.modules['node_modules/dep'].repo), Object.hasOwn(repo, 'directory') ? ['github', 'directory', 'commit'] : ['github', 'commit'], 'canonical key order')
    t.assert.deepStrictEqual({ ...Bundle.parse(JSON.stringify(json)).modules.get('node_modules/dep').repo }, { ...json.modules['node_modules/dep'].repo })
    t.assert.equal(JSON.parse(lockOf({ 'node_modules/dep': dep(repo) }).serialize()).modules['node_modules/dep'].repo, undefined, 'metadata: never in a lockfile')
  }
})

test('a dependency repo is validated as a bundle repo is, its github required, on parse and on serialize, and only a dependency carries one', (t) => {
  const invalid = [{ github: 'not a repo' }, { github: 'o/n', tag: 'v1' }, { github: 'o/n', root: true }, { github: 'o/n', commit: 'abc1234' }, 'o/n']
  const githubless = [{ directory: 'packages/dep' }, { directory: '' }, { commit: COMMIT }, { directory: 'packages/dep', commit: COMMIT }, {}]
  for (const repo of [...invalid, ...githubless]) {
    const json = JSON.parse(bundleOf({ 'node_modules/dep': dep() }).serialize())
    json.modules['node_modules/dep'].repo = repo
    t.assert.throws(() => Bundle.parse(JSON.stringify(json)), /bundle module 'node_modules\/dep' repo/u, `parse: ${JSON.stringify(repo)}`)
    t.assert.throws(() => bundleOf({ 'node_modules/dep': dep(repo) }).serialize(), /bundle module 'node_modules\/dep' repo/u, `serialize: ${JSON.stringify(repo)}`)
  }
  const root = { github: 'o/n', directory: '' }
  t.assert.deepStrictEqual({ ...Bundle.parse(bundleOf({ 'node_modules/dep': dep(root) }).serialize()).modules.get('node_modules/dep').repo }, root, "the root, `''`, as the bundle's own")
  const json = JSON.parse(new Bundle({ config: { scope: 'full' }, modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'a.js': '' } }]]) }).serialize())
  json.sources['.'].repo = DEP_REPO
  t.assert.throws(() => Bundle.parse(JSON.stringify(json)), /'\.' is no dependency's bucket/u, "first-party code's repo is the bundle's own")
})

test("a dependency of any ecosystem may carry a repo in a bundle, beside first-party code's buckets", (t) => {
  const crate = { name: 'serde', version: '1.0.100', ecosystem: 'cargo', repo: { github: 'serde-rs/serde', directory: 'serde' }, files: { 'src/lib.rs': '' } }
  const modules = new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/main.rs': '' } }], ['vendor/serde', crate]])
  const bundle = new Bundle({ config: { scope: 'full' }, entries: new Set(['src/main.rs']), modules })
  const lock = new Lockfile({ config: { scope: 'full' }, entries: new Set(['src/main.rs']), modules, imports: new Map(), formats: new Map() })
  t.assert.deepStrictEqual({ ...Bundle.parse(bundle.serialize()).modules.get('vendor/serde').repo }, crate.repo)
  t.assert.equal(Lockfile.parse(lock.serialize()).modules.get('vendor/serde').repo, undefined)
})

test('merging takes a dependency repo one side lacks, and holds two that differ to nothing', (t) => {
  const merged = (a, b) => bundleOf({ 'node_modules/dep': dep(a) }).merge(bundleOf({ 'node_modules/dep': dep(b) })).modules.get('node_modules/dep').repo
  t.assert.deepStrictEqual({ ...merged(DEP_REPO, DEP_REPO) }, DEP_REPO, 'agreeing')
  t.assert.deepStrictEqual({ ...merged(undefined, DEP_REPO) }, DEP_REPO, 'into an artifact from before the field')
  t.assert.deepStrictEqual({ ...merged(DEP_REPO, undefined) }, DEP_REPO, 'from one')
  t.assert.deepStrictEqual({ ...merged(DEP_REPO, { github: 'o/other' }) }, DEP_REPO, "metadata: the existing side's, no mismatch")
  t.assert.deepStrictEqual({ ...merged(DEP_REPO, { ...DEP_REPO, commit: COMMIT }) }, DEP_REPO, "the existing side's whole: no commit taken into it")
  t.assert.deepStrictEqual({ ...merged({ ...DEP_REPO, commit: COMMIT }, DEP_REPO) }, { ...DEP_REPO, commit: COMMIT }, 'nor dropped from it')
})

test('State records a dependency repo, from its own package.json, in the bundle alone', withTmp((t, tmp) => {
  writeProject(tmp, { repository: { type: 'git', url: 'git+https://github.com/o/dep.git', directory: 'packages/dep' } })
  const state = capture(tmp, { bundle: 'replace', lock: 'replace' })
  t.assert.deepStrictEqual(JSON.parse(state.sourceData).modules['node_modules/dep'].repo, DEP_REPO)
  t.assert.equal(JSON.parse(state.lockData).modules['node_modules/dep'].repo, undefined, 'metadata: never in the lockfile')
  t.assert.equal(JSON.parse(state.lockData).sources['.'].repo, undefined, 'first-party code records none')
  t.assert.equal(JSON.parse(state.lockData).repo, undefined, "the build's own repo never reaches the lockfile")
}))

test('State holds a dependency repo to nothing: a package.json naming another, or none, is no mismatch', withTmp((t, tmp) => {
  writeProject(tmp, { repository: 'github:o/dep' })
  capture(tmp, { bundle: 'none', lock: 'replace' }).write()
  for (const pkg of [{ repository: 'github:o/elsewhere' }, {}]) {
    writeJson(join(tmp, 'node_modules', 'dep', 'package.json'), { name: 'dep', version: '1.0.0', ...pkg })
    t.assert.doesNotThrow(() => capture(tmp, { bundle: 'none', lock: 'frozen' }), JSON.stringify(pkg))
  }
}))

test('State fills in a dependency repo a bundle from an older stasis lacks', withTmp((t, tmp) => {
  writeProject(tmp, { repository: 'github:o/dep' })
  capture(tmp, { bundle: 'replace', lock: 'none' }).write()
  const bundlePath = join(tmp, 'stasis.code.br')
  const old = readBundle(bundlePath)
  delete old.modules['node_modules/dep'].repo
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(old)))
  const state = capture(tmp, { bundle: 'add', lock: 'none' })
  t.assert.deepStrictEqual(JSON.parse(state.sourceData).modules['node_modules/dep'].repo, { github: 'o/dep' })
}))

test('State loads a bundle beside its lockfile whatever dependency repo the bundle records', withTmp((t, tmp) => {
  writeProject(tmp, { repository: 'github:o/dep' })
  capture(tmp, { bundle: 'replace', lock: 'replace' }).write()
  const bundlePath = join(tmp, 'stasis.code.br')
  const bundle = readBundle(bundlePath)
  bundle.modules['node_modules/dep'].repo = { github: 'o/other' }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(bundle)))
  t.assert.doesNotThrow(() => new State(tmp, { scope: 'full', bundle: 'load', lock: 'frozen' }))
}))

test('stasis add records a dependency repo in the bundle, never the lockfile', withTmp((t, tmp) => {
  writeProject(tmp, { repository: { url: 'https://github.com/o/dep', directory: 'packages/dep' } })
  writeJson(join(tmp, 'stasis.config.json'), {})
  writeJson(join(tmp, 'stasis.lock.json'), { version: 0, config: { scope: 'full' }, entries: [], sources: {}, modules: {}, imports: {}, formats: {} })
  addCommand({ cwd: tmp, entries: ['node_modules/dep/index.js'] })
  t.assert.deepStrictEqual(readBundle(join(tmp, 'stasis.code.br')).modules['node_modules/dep'].repo, DEP_REPO)
  t.assert.equal(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8')).modules['node_modules/dep'].repo, undefined)
}))

test('stasis bundle records a dependency repo in the bundle, never its lockfile, through a State and through the field resolver', withTmp(async (t, tmp) => {
  writeProject(tmp, { repository: { url: 'https://github.com/o/dep', directory: 'packages/dep' } })
  const written = await Promise.all([['state', {}], ['resolver', { mainFields: ['main'] }]].map(async ([label, options]) => {
    await bundleCommand({ cwd: tmp, entries: ['index.js'], output: `${label}.br`, lockfile: `${label}.lock.json`, ...options })
    return [label, readBundle(join(tmp, `${label}.br`)), JSON.parse(readFileSync(join(tmp, `${label}.lock.json`), 'utf8'))]
  }))
  for (const [label, bundle, lock] of written) {
    t.assert.deepStrictEqual(bundle.modules['node_modules/dep'].repo, DEP_REPO, `${label}: bundle`)
    t.assert.equal(lock.modules['node_modules/dep'].repo, undefined, `${label}: lockfile`)
  }
}))
