import { test } from 'node:test'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { diffArtifacts } from '../stasis/src/diff.js'
import { withTmp } from './tmp.helper.js'

// Every place a dependency record's `integrity` and `patch` meet an anchor -- the package manager's
// lockfile, an existing stasis.lock.json, what is installed -- each holds them to it, or refuses.

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const SRI = `sha512-${'A'.repeat(86)}==`
const OTHER = `sha512-${'B'.repeat(85)}A==`
const COMMIT = 'a'.repeat(40)
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value))
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

// An npm project in `dir` requiring `reg` (and `extra` where given), installed as npm lays it out,
// its hidden lockfile and package-lock.json both of `lock` (each location's entry, by its name).
function npmProject(dir, { lock = {}, hidden = lock, installed = {}, packageLock = true } = {}) {
  writeJson(join(dir, 'package.json'), { name: 'app', version: '1.0.0' })
  const names = Object.keys({ reg: {}, ...installed })
  writeFileSync(join(dir, 'index.js'), names.map((name) => `require('${name}')\n`).join(''))
  for (const name of names) {
    mkdirSync(join(dir, 'node_modules', name), { recursive: true })
    writeJson(join(dir, 'node_modules', name, 'package.json'), { name, version: installed[name] ?? '1.0.0' })
    writeFileSync(join(dir, 'node_modules', name, 'index.js'), 'module.exports = 1\n')
  }
  const entry = (more) => ({ version: '1.0.0', resolved: 'https://registry.npmjs.org/reg/-/reg-1.0.0.tgz', integrity: SRI, ...more })
  const of = (entries) => ({ name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: Object.fromEntries(Object.entries({ reg: {}, ...entries }).map(([name, more]) => [`node_modules/${name}`, entry(more)])) })
  if (hidden !== null) writeJson(join(dir, 'node_modules', '.package-lock.json'), of(hidden))
  if (packageLock) writeJson(join(dir, 'package-lock.json'), of(lock))
}
const build = (dir, options = {}) => bundleCommand({ cwd: dir, entries: ['index.js'], output: 'out.br', ...options })
const recordOf = (dir, at = 'node_modules/reg', file = 'out.br') => JSON.parse(brotliDecompressSync(readFileSync(join(dir, file))).toString('utf8')).modules[at]

// 1. stasis bundle and an existing stasis.lock.json.

test('stasis bundle holds its records to the stasis.lock.json present, in lock = add: neither ignored nor overwritten', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const written = readFileSync(lockPath, 'utf8')
  writeFileSync(lockPath, written.replace(SRI, OTHER))
  await t.assert.rejects(build(dir), /stasis\.lock\.json: module 'node_modules\/reg' integrity mismatch/u, 'without --lockfile: read all the same')
  await t.assert.rejects(build(dir, { lockfile: 'stasis.lock.json' }), /stasis\.lock\.json: module 'node_modules\/reg' integrity mismatch/u, 'with it: not overwritten')
  t.assert.ok(readFileSync(lockPath, 'utf8').includes(OTHER), 'left as it was')
  // A file it attests otherwise, too.
  const lock = readJson(lockPath)
  lock.modules['node_modules/reg'].integrity = SRI
  lock.modules['node_modules/reg'].files['index.js'] = SRI
  writeJson(lockPath, lock)
  await t.assert.rejects(build(dir), /content mismatch for 'node_modules\/reg\/index\.js'/u)
}))

test('stasis bundle in lock = ignore leaves stasis.lock.json alone, in lock = replace rewrites it', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const edited = readFileSync(lockPath, 'utf8').replace(SRI, OTHER)
  writeFileSync(lockPath, edited)
  await build(dir, { env: { ...process.env, EXODUS_STASIS_LOCK: 'ignore' } })
  t.assert.equal(readFileSync(lockPath, 'utf8'), edited)
  await build(dir, { lockfile: 'stasis.lock.json', env: { ...process.env, EXODUS_STASIS_LOCK: 'replace' } })
  t.assert.equal(readJson(lockPath).modules['node_modules/reg'].integrity, SRI)
}))

test('stasis bundle in lock = frozen holds its records to stasis.lock.json too', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  const frozen = { env: { ...process.env, EXODUS_STASIS_LOCK: 'frozen' } }
  await build(dir, frozen)
  writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace(SRI, OTHER))
  await t.assert.rejects(build(dir, frozen), /stasis\.lock\.json: module 'node_modules\/reg' integrity mismatch/u)
}))

// 2. Solidity and Bash bundles of npm packages.

test('a Solidity bundle\'s npm packages are pinned and held to their lockfile, as a JS bundle\'s are', withTmp(async (t, dir) => {
  cpSync(join(here, 'fixtures', 'solidity-bundle', 'with-node-modules'), dir, { recursive: true })
  const lock = (integrity) => ({ name: 'my-app', version: '0.1.0', lockfileVersion: 3, requires: true, packages: {
    'node_modules/foo': { version: '1.2.3', resolved: 'https://registry.npmjs.org/foo/-/foo-1.2.3.tgz', integrity },
    'node_modules/@oz/contracts': { version: '5.0.0', resolved: 'https://registry.npmjs.org/@oz/contracts/-/contracts-5.0.0.tgz', integrity: SRI },
  } })
  writeJson(join(dir, 'node_modules', '.package-lock.json'), lock(SRI))
  writeJson(join(dir, 'package-lock.json'), lock(SRI))
  await bundleCommand({ cwd: dir, entries: ['src/A.sol'], mappingFile: 'remappings.txt', output: 'out.br' })
  t.assert.equal(recordOf(dir, 'node_modules/foo').integrity, SRI)
  writeJson(join(dir, 'package-lock.json'), lock(OTHER))
  await t.assert.rejects(bundleCommand({ cwd: dir, entries: ['src/A.sol'], mappingFile: 'remappings.txt', output: 'out.br' }), /package-lock\.json doesn't lock node_modules\/foo as installed/u)
}))

// 3. Every npm package held to the lockfile beside it, whatever the install recorded of it.

test('a package installed otherwise than the lockfile beside it locks it stops a disk build, whatever its install record says', withTmp(async (t, dir) => {
  const at = (name) => join(dir, name)
  // Its package.json of another version than both lockfiles.
  mkdirSync(at('a'))
  npmProject(at('a'), { installed: { reg: '1.0.1' } })
  await t.assert.rejects(build(at('a')), /package-lock\.json doesn't lock node_modules\/reg as installed \(1\.0\.1; it locks 1\.0\.0\)/u)
  // A package neither records.
  mkdirSync(at('b'))
  npmProject(at('b'), { installed: { stray: '1.0.0' }, lock: {}, hidden: {} })
  await t.assert.rejects(build(at('b')), /package-lock\.json doesn't lock node_modules\/stray as installed \(it locks none there\)/u)
  // No hidden lockfile: package-lock.json alone.
  mkdirSync(at('c'))
  npmProject(at('c'), { installed: { reg: '1.0.1' }, hidden: null })
  await t.assert.rejects(build(at('c')), /package-lock\.json doesn't lock node_modules\/reg as installed \(1\.0\.1; it locks 1\.0\.0\)/u)
  // yarn 1: yarn.lock.
  mkdirSync(at('d'))
  npmProject(at('d'), { installed: { reg: '1.0.1' }, hidden: null, packageLock: false })
  writeFileSync(at('d/yarn.lock'), `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\nreg@1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#${'0'.repeat(40)}"\n  integrity ${SRI}\n`)
  await t.assert.rejects(build(at('d')), /yarn\.lock doesn't lock node_modules\/reg as installed \(1\.0\.1; it locks none\)/u)
  // pnpm's hoisted layout: pnpm-lock.yaml.
  mkdirSync(at('e'))
  npmProject(at('e'), { installed: { reg: '1.0.1' }, hidden: null, packageLock: false })
  writeFileSync(at('e/node_modules/.modules.yaml'), 'nodeLinker: hoisted\npackageManager: pnpm@10.33.4\n')
  writeFileSync(at('e/pnpm-lock.yaml'), `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .:\n    dependencies:\n      reg:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  reg@1.0.0:\n    resolution: {integrity: ${SRI}}\n\nsnapshots:\n\n  reg@1.0.0: {}\n`)
  await t.assert.rejects(build(at('e')), /pnpm-lock\.yaml doesn't lock node_modules\/reg as installed \(1\.0\.1; it locks 1\.0\.0\)/u)
}))

// 10. A git dependency's commit, held to its lockfile on disk.

test('a git dependency installed at another commit than the lockfile beside it locks stops a disk build', withTmp(async (t, dir) => {
  const git = (commit) => ({ resolved: `git+ssh://git@github.com/o/reg.git#${commit}`, integrity: undefined })
  npmProject(dir, { lock: { reg: git('b'.repeat(40)) }, hidden: { reg: git(COMMIT) } })
  await t.assert.rejects(build(dir), /package-lock\.json doesn't lock node_modules\/reg as installed \(at o\/reg@a{40}; it locks o\/reg@b{40}\)/u)
}))

// 5. A run holds what stasis.lock.json and a bundle attest to what is installed.

test('stasis run holds stasis.lock.json\'s integrities to what is installed', withTmp(async (t, dir) => {
  npmProject(dir)
  await build(dir, { lockfile: 'stasis.lock.json' })
  const lockPath = join(dir, 'stasis.lock.json')
  writeFileSync(lockPath, readFileSync(lockPath, 'utf8').replace(SRI, OTHER))
  const run = (mode) => spawnSync(process.execPath, [cli, 'run', `--lock=${mode}`, 'index.js'], { cwd: dir, encoding: 'utf8', env: { ...process.env, EXODUS_STASIS_LOCK: '' } })
  for (const mode of ['frozen', 'add']) {
    const result = run(mode)
    t.assert.notEqual(result.status, 0, mode)
    t.assert.match(result.stderr, /stasis\.lock\.json: module 'node_modules\/reg' integrity mismatch \(.*installed/u, mode)
  }
  t.assert.equal(run('replace').status, 0, 'replaced: rewritten of what is installed')
  t.assert.equal(readJson(lockPath).modules['node_modules/reg'].integrity, SRI)
}))

// 12. yarn 1's integrity; stasis diff.

test('a disk build of a yarn 1 install records each package\'s integrity yarn.lock names, where .yarn-integrity has it installed', withTmp(async (t, dir) => {
  npmProject(dir, { hidden: null, packageLock: false })
  writeFileSync(join(dir, 'yarn.lock'), `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\nreg@1.0.0:\n  version "1.0.0"\n  resolved "https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#${'0'.repeat(40)}"\n  integrity ${SRI}\n`)
  writeJson(join(dir, 'node_modules', '.yarn-integrity'), { systemParams: 'linux-x64-137', modulesFolders: ['node_modules'], flags: [], linkedModules: [], topLevelPatterns: ['reg@1.0.0'], lockfileEntries: { 'reg@1.0.0': `https://registry.yarnpkg.com/reg/-/reg-1.0.0.tgz#${'0'.repeat(40)}` }, files: [], artifacts: {} })
  await build(dir)
  t.assert.equal(recordOf(dir).integrity, SRI)
}))

test('stasis diff tells a dependency\'s integrity and patch changing', (t) => {
  const patch = (text) => ({ integrity: `sha256-${createHash('sha256').update(text).digest('base64')}` })
  const of = (more) => new Bundle({ config: { scope: 'node_modules' }, modules: new Map([['node_modules/reg', { name: 'reg', version: '1.0.0', ecosystem: 'npm', ...more, files: { 'index.js': 'x\n' } }]]) })
  const [change] = diffArtifacts({ artifact: of({ integrity: SRI, patch: patch('a') }), kind: 'bundle' }, { artifact: of({ integrity: OTHER, patch: patch('b') }), kind: 'bundle' }, { hash: (x) => x }).modules.changed
  t.assert.deepStrictEqual([change.integrityChange, change.patchChange], [{ from: SRI, to: OTHER }, { from: patch('a'), to: patch('b') }])
})
