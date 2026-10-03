import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { addCommand } from '@exodus/stasis-core/add'
import { packageRepo, parseGithubRepository } from '@exodus/stasis-core/bundle-util'
import { State } from '@exodus/stasis-core/state'
import { audit, collectPackages } from '../stasis/src/audit.js'
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

test('packageRepo reads a package.json as detectRepo reads one: repository, then its directory or a GitHub tree homepage', (t) => {
  t.assert.deepStrictEqual(packageRepo({ repository: { url: 'git+https://github.com/o/n.git', directory: 'packages/x' } }), { github: 'o/n', directory: 'packages/x' })
  t.assert.deepStrictEqual(packageRepo({ repository: 'github:o/n' }), { github: 'o/n', root: true }, 'no directory: the repo root')
  t.assert.deepStrictEqual(packageRepo({ repository: { url: 'o/n', directory: '.\\packages\\x\\' } }), { github: 'o/n', directory: 'packages/x' })
  t.assert.deepStrictEqual(packageRepo({ repository: 'https://github.com/o/n', homepage: 'https://github.com/o/n/tree/main/packages/x#readme' }),
    { github: 'o/n', directory: 'packages/x' })
  t.assert.deepStrictEqual(packageRepo({ repository: 'https://github.com/o/n', homepage: 'https://github.com/o/other/tree/main/x' }),
    { github: 'o/n', root: true }, "another repo's homepage names no directory")
  t.assert.deepStrictEqual(packageRepo({ repository: { url: 'https://github.com/o/n', directory: 'with space' } }), { github: 'o/n' },
    'a directory the format would reject is left out, root too')
  t.assert.deepStrictEqual(packageRepo({ repository: 'https://github.com/o/n' }, 'sub'), { github: 'o/n', directory: 'sub' })
  for (const pkg of [{}, { repository: 'https://gitlab.com/o/n' }, { bugs: 'https://github.com/o/n/issues' }, { homepage: 'https://github.com/o/n' }, null]) {
    t.assert.equal(packageRepo(pkg), undefined, JSON.stringify(pkg))
  }
})

test('parseGithubRepository drops a #committish, and refuses an authority ending before github.com', (t) => {
  for (const url of ['git+https://github.com/o/n.git#v1.2.3', 'github:o/n#main', 'o/n#semver:^1', 'git@github.com:o/n.git#abc']) {
    t.assert.equal(parseGithubRepository(url), 'o/n', url)
  }
  for (const url of ['https://evil.example#@github.com/a/b', 'https://evil.example?@github.com/a/b', 'https://evil.example\\@github.com/a/b']) {
    t.assert.equal(parseGithubRepository(url), null, url)
  }
  t.assert.equal(parseGithubRepository('https://user:p%40ss@github.com:443/o/n'), 'o/n', 'a userinfo of what RFC 3986 allows still passes')
})

test('a dependency record carries repo after ecosystem, in a bundle and in a lockfile alike', (t) => {
  const modules = { 'node_modules/dep': dep({ directory: 'packages/dep', github: 'o/dep' }) }
  for (const [artifact, parse] of [[bundleOf(modules), Bundle.parse], [lockOf(modules), Lockfile.parse]]) {
    const json = JSON.parse(artifact.serialize())
    t.assert.deepStrictEqual(Object.keys(json.modules['node_modules/dep']), ['name', 'version', 'ecosystem', 'repo', 'files'])
    t.assert.deepStrictEqual(Object.keys(json.modules['node_modules/dep'].repo), ['github', 'directory'], 'canonical key order')
    t.assert.deepStrictEqual({ ...parse(JSON.stringify(json)).modules.get('node_modules/dep').repo }, DEP_REPO)
  }
  t.assert.equal(JSON.parse(bundleOf({ 'node_modules/dep': dep() }).serialize()).modules['node_modules/dep'].repo, undefined, 'none: no key')
})

test('a dependency repo is validated as a bundle repo is, on parse and on serialize, and only a dependency carries one', (t) => {
  for (const [what, Artifact, of] of [['bundle', Bundle, bundleOf], ['lockfile', Lockfile, lockOf]]) {
    for (const repo of [{ github: 'not a repo' }, { github: 'o/n', tag: 'v1' }, { github: 'o/n', directory: 'x', root: true }, 'o/n']) {
      const json = JSON.parse(of({ 'node_modules/dep': dep() }).serialize())
      json.modules['node_modules/dep'].repo = repo
      t.assert.throws(() => Artifact.parse(JSON.stringify(json)), new RegExp(`${what} module 'node_modules/dep' repo`, 'u'), `${what} parse: ${JSON.stringify(repo)}`)
      t.assert.throws(() => of({ 'node_modules/dep': dep(repo) }).serialize(), new RegExp(`${what} module 'node_modules/dep' repo`, 'u'), `${what} serialize: ${JSON.stringify(repo)}`)
    }
  }
  const json = JSON.parse(new Bundle({ config: { scope: 'full' }, modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'a.js': '' } }]]) }).serialize())
  json.sources['.'].repo = DEP_REPO
  t.assert.throws(() => Bundle.parse(JSON.stringify(json)), /'\.' is no dependency's bucket/u, "first-party code's repo is the bundle's own")
})

test('merging takes a dependency repo one side lacks and refuses two that differ', (t) => {
  for (const [of, what] of [[bundleOf, 'bundle'], [lockOf, 'lockfile']]) {
    const merged = (a, b) => of({ 'node_modules/dep': dep(a) }).merge(of({ 'node_modules/dep': dep(b) })).modules.get('node_modules/dep').repo
    t.assert.deepStrictEqual({ ...merged(DEP_REPO, DEP_REPO) }, DEP_REPO, `${what}: agreeing`)
    t.assert.deepStrictEqual({ ...merged(DEP_REPO, { ...DEP_REPO, github: 'O/Dep' }) }, DEP_REPO, `${what}: GitHub names are case-insensitive`)
    t.assert.deepStrictEqual({ ...merged(undefined, DEP_REPO) }, DEP_REPO, `${what}: into an artifact from before the field`)
    t.assert.deepStrictEqual({ ...merged(DEP_REPO, undefined) }, DEP_REPO, `${what}: from one`)
    t.assert.throws(() => merged(DEP_REPO, { github: 'o/dep', root: true }), new RegExp(`${what} merge: module 'node_modules/dep' repo mismatch`, 'u'))
    t.assert.throws(() => merged(DEP_REPO, { ...DEP_REPO, github: 'o/other' }), /repo mismatch/u)
  }
})

test('State records a dependency repo, from its own package.json, in the lockfile and the bundle', withTmp((t, tmp) => {
  writeProject(tmp, { repository: { type: 'git', url: 'git+https://github.com/o/dep.git', directory: 'packages/dep' } })
  const state = capture(tmp, { bundle: 'replace', lock: 'replace' })
  t.assert.deepStrictEqual(JSON.parse(state.lockData).modules['node_modules/dep'].repo, DEP_REPO)
  t.assert.deepStrictEqual(JSON.parse(state.sourceData).modules['node_modules/dep'].repo, DEP_REPO)
  t.assert.equal(JSON.parse(state.lockData).sources['.'].repo, undefined, 'first-party code records none')
  t.assert.equal(JSON.parse(state.lockData).repo, undefined, "the build's own repo never reaches the lockfile")
}))

test('State holds a dependency repo to the one recorded, as it holds its name and version', withTmp((t, tmp) => {
  writeProject(tmp, { repository: 'github:o/dep' })
  capture(tmp, { bundle: 'none', lock: 'replace' }).write()
  t.assert.doesNotThrow(() => capture(tmp, { bundle: 'none', lock: 'frozen' }))

  writeJson(join(tmp, 'node_modules', 'dep', 'package.json'), { name: 'dep', version: '1.0.0', repository: 'github:o/elsewhere' })
  t.assert.throws(() => capture(tmp, { bundle: 'none', lock: 'frozen' }), /module repo mismatch for 'node_modules\/dep'.*"o\/dep".*"o\/elsewhere"/u)
  t.assert.throws(() => capture(tmp, { bundle: 'none', lock: 'add' }), /module repo mismatch/u)
  writeJson(join(tmp, 'node_modules', 'dep', 'package.json'), { name: 'dep', version: '1.0.0' })
  t.assert.throws(() => capture(tmp, { bundle: 'none', lock: 'frozen' }), /module repo mismatch.*names no GitHub repository/u)
}))

test('State fills in a dependency repo a lockfile from an older stasis lacks', withTmp((t, tmp) => {
  writeProject(tmp, { repository: 'github:o/dep' })
  capture(tmp, { bundle: 'none', lock: 'replace' }).write()
  const lockPath = join(tmp, 'stasis.lock.json')
  const old = JSON.parse(readFileSync(lockPath, 'utf8'))
  delete old.modules['node_modules/dep'].repo
  writeFileSync(lockPath, JSON.stringify(old))
  const state = capture(tmp, { bundle: 'none', lock: 'add' })
  t.assert.deepStrictEqual(JSON.parse(state.lockData).modules['node_modules/dep'].repo, { github: 'o/dep', root: true })
}))

test('State refuses a bundle whose dependency repo differs from the lockfile', withTmp((t, tmp) => {
  writeProject(tmp, { repository: 'github:o/dep' })
  capture(tmp, { bundle: 'replace', lock: 'replace' }).write()
  const bundlePath = join(tmp, 'stasis.code.br')
  const bundle = readBundle(bundlePath)
  bundle.modules['node_modules/dep'].repo = { github: 'o/other', root: true }
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(bundle)))
  t.assert.throws(() => new State(tmp, { scope: 'full', bundle: 'load', lock: 'frozen' }), /bundle module node_modules\/dep repo mismatch with lockfile/u)
  delete bundle.modules['node_modules/dep'].repo
  writeFileSync(bundlePath, brotliCompressSync(JSON.stringify(bundle)))
  t.assert.doesNotThrow(() => new State(tmp, { scope: 'full', bundle: 'load', lock: 'frozen' }), 'a bundle from before the field')
}))

test('stasis add records a dependency repo in the bundle and the lockfile', withTmp((t, tmp) => {
  writeProject(tmp, { repository: { url: 'https://github.com/o/dep', directory: 'packages/dep' } })
  writeJson(join(tmp, 'stasis.config.json'), {})
  writeJson(join(tmp, 'stasis.lock.json'), { version: 0, config: { scope: 'full' }, entries: [], sources: {}, modules: {}, imports: {}, formats: {} })
  addCommand({ cwd: tmp, entries: ['node_modules/dep/index.js'] })
  t.assert.deepStrictEqual(readBundle(join(tmp, 'stasis.code.br')).modules['node_modules/dep'].repo, DEP_REPO)
  t.assert.deepStrictEqual(JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8')).modules['node_modules/dep'].repo, DEP_REPO)
}))

test('stasis bundle records a dependency repo in the bundle and its lockfile, through a State and through the field resolver', withTmp(async (t, tmp) => {
  writeProject(tmp, { repository: { url: 'https://github.com/o/dep', directory: 'packages/dep' } })
  const written = await Promise.all([['state', {}], ['resolver', { mainFields: ['main'] }]].map(async ([label, options]) => {
    await bundleCommand({ cwd: tmp, entries: ['index.js'], output: `${label}.br`, lockfile: `${label}.lock.json`, ...options })
    return [label, readBundle(join(tmp, `${label}.br`)), JSON.parse(readFileSync(join(tmp, `${label}.lock.json`), 'utf8'))]
  }))
  for (const [label, bundle, lock] of written) {
    t.assert.deepStrictEqual(bundle.modules['node_modules/dep'].repo, DEP_REPO, `${label}: bundle`)
    t.assert.deepStrictEqual(lock.modules['node_modules/dep'].repo, DEP_REPO, `${label}: lockfile`)
  }
}))

const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })

test('audit asks a dependency repo the artifacts record instead of looking one up', withTmp(async (t, tmp) => {
  const original = globalThis.fetch
  const fetched = []
  const latest = { 'looked-up': 'github:o/looked-up', moved: 'github:new/moved' }
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    if (String(url) === 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk') return json({})
    const name = /^https:\/\/registry\.npmjs\.org\/([^/]+)\/latest$/u.exec(String(url))?.[1]
    if (Object.hasOwn(latest, name)) return json({ name, version: '1.0.0', repository: latest[name] })
    throw new Error(`unexpected request: ${url}`)
  }
  t.after(() => { globalThis.fetch = original })
  const pkg = (name, version, repo) => ({ name, version, ecosystem: 'npm', ...(repo && { repo }), files: { 'index.js': '' } })
  const file = join(tmp, 'snapshot.br')
  writeFileSync(file, brotliCompressSync(bundleOf({
    'node_modules/dep': pkg('dep', '1.0.0', { github: 'o/dep', root: true }),
    'node_modules/looked-up': pkg('looked-up', '1.0.0'),
    // A package that moved: its versions record two repos, and advisories() takes one a name.
    'node_modules/moved': pkg('moved', '1.0.0', { github: 'old/moved', root: true }),
    'node_modules/a/node_modules/moved': pkg('moved', '2.0.0', { github: 'new/moved', root: true }),
  }).serialize()))
  t.assert.deepStrictEqual(collectPackages([file]).map(({ name, version, github }) => [`${name}@${version}`, github]), [
    ['dep@1.0.0', 'o/dep'], ['looked-up@1.0.0', undefined], ['moved@1.0.0', undefined], ['moved@2.0.0', undefined],
  ])
  const asked = []
  await audit([file], { repoAdvisories: true, github: { listRepoAdvisories: async ({ repo }) => { asked.push(repo); return [] } } })
  t.assert.deepStrictEqual(asked.toSorted(), ['new/moved', 'o/dep', 'o/looked-up'])
  t.assert.deepStrictEqual(fetched.filter((url) => url.endsWith('/latest')).toSorted(), [
    'https://registry.npmjs.org/looked-up/latest', 'https://registry.npmjs.org/moved/latest',
  ], 'only what no artifact records, or records two of, is looked up')
}))

test('audit looks up a name two artifacts record different repos for, whatever their order', withTmp(async (t, tmp) => {
  const original = globalThis.fetch
  const fetched = []
  globalThis.fetch = async (url) => {
    fetched.push(String(url))
    if (String(url) === 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk') return json({})
    if (String(url) === 'https://registry.npmjs.org/split/latest') return json({ name: 'split', version: '1.0.0', repository: 'github:o/split' })
    throw new Error(`unexpected request: ${url}`)
  }
  t.after(() => { globalThis.fetch = original })
  const write = (name, github) => {
    const file = join(tmp, name)
    writeFileSync(file, brotliCompressSync(bundleOf({
      'node_modules/split': { name: 'split', version: '1.0.0', ecosystem: 'npm', repo: { github, root: true }, files: { 'index.js': '' } },
    }).serialize()))
    return file
  }
  const [a, b] = [write('a.br', 'o/split-a'), write('b.br', 'o/split-b')]
  const orders = [[a, b], [b, a]]
  for (const files of orders) {
    t.assert.deepStrictEqual(collectPackages(files), [{ ecosystem: 'npm', name: 'split', version: '1.0.0' }], 'no repo where they disagree')
  }
  const asked = await Promise.all(orders.map(async (files) => {
    const repos = []
    await audit(files, { repoAdvisories: true, github: { listRepoAdvisories: async ({ repo }) => { repos.push(repo); return [] } } })
    return repos
  }))
  t.assert.deepStrictEqual(asked, [['o/split'], ['o/split']], 'the repo looked up, not either one recorded')
  t.assert.deepStrictEqual(fetched.filter((url) => url.endsWith('/latest')), Array(2).fill('https://registry.npmjs.org/split/latest'))
}))
