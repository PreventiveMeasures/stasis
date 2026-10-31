import { describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { lockfile } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

// `stasis bundle --deptree`: the dependencies laid out in memory from the lockfile, as
// @exodus/stasis/vfs-bundle lays them out, the rest of the project read from disk through them.
// What it refuses is refused before anything is fetched, so nothing here reaches the network; the
// builds themselves are held to a real install's in vfs-bundle.test.js and vfs-bundle-soldeer.test.js.

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const fixtures = join(here, 'fixtures')

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))

const runCli = async (args, { cwd }) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: cleanEnv })
  const stderr = []
  child.stderr.on('data', (d) => stderr.push(d))
  child.stdout.resume()
  const [status] = await once(child, 'close')
  return { status, stderr: stripVTControlCharacters(Buffer.concat(stderr).toString('utf8')) }
}

// That `stasis ...args` in `cwd` exits 1, saying what `said` matches.
const refused = async (t, args, cwd, said) => {
  const r = await runCli(args, { cwd })
  t.assert.equal(r.status, 1, args.join(' '))
  t.assert.match(r.stderr, said, args.join(' '))
}

// Write `files` (a path from `dir` -> its text) under `dir`, with their directories.
const writeTree = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}

// The pnpm fixture's files, copied to `dir` without anything installed. -> its real path
const pnpmProject = (dir) => {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'src/entry.js']) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    cpSync(join(fixtures, 'pnpm-bundle', file), join(dir, file))
  }
  return realpathSync(dir)
}

describe('stasis bundle --deptree usage', { concurrency: 4 }, () => {
  test('is for JS and Solidity bundles alone', withTmp(async (t, tmp) => {
    writeTree(tmp, { 'a.sh': 'echo\n', 'a.php': '<?php\n', 'a.rs': 'fn main() {}\n' })
    await Promise.all(['a.sh', 'a.php', 'a.rs'].map((entry) => refused(t, ['bundle', '--deptree', entry], tmp, /^Error: --deptree is only valid for JS and \.sol bundles\n/u)))
  }))

  test('runs nothing of the project from disk: --babel and --metro-resolver are refused', withTmp(async (t, tmp) => {
    writeTree(tmp, { 'a.js': '' })
    const metro = ['bundle', '--deptree', '--metro', '--platforms=ios']
    await Promise.all([
      refused(t, [...metro, '--babel', 'a.js'], tmp, /^Error: --babel can't be combined with --deptree \(it runs the project's Babel config from disk, where --deptree installs nothing\)\n/u),
      refused(t, [...metro, '--metro-resolver', 'a.js'], tmp, /^Error: --metro-resolver can't be combined with --deptree \(it runs the project's metro-resolver from disk, where --deptree installs nothing\)\n/u),
    ])
  }))

  test("is the bundle's flag, which stasis.config.json's entries set none of, and which goes with the entries it names", withTmp(async (t, tmp) => {
    const config = (options) => ({ 'a.js': '', 'stasis.config.json': JSON.stringify({ entries: { 'a.js': options } }) })
    writeTree(join(tmp, 'set'), config({ deptree: true }))
    writeTree(join(tmp, 'given'), config({ jsx: true }))
    await Promise.all([
      refused(t, ['bundle', 'a.js'], join(tmp, 'set'), /^Error: stasis\.config\.json: entries "a\.js": deptree is the bundle's option, not an entry's: pass --deptree\n/u),
      // Given for the entries the config names, it is taken: here, up to finding no lockfile.
      refused(t, ['bundle', '--deptree'], join(tmp, 'given'), /--deptree lays out the dependencies from a lockfile, and none of/u),
    ])
  }))
})

describe('stasis bundle --deptree refusals, before anything is fetched', { concurrency: 4 }, () => {
  test('without a lockfile that installs cwd: none of the ones it lays out from', withTmp(async (t, tmp) => {
    writeTree(tmp, { 'package.json': '{"name":"p"}', 'a.js': '', 'b.sol': '', 'Cargo.lock': '' })
    const none = new RegExp(`^Error: bundleCommand: --deptree lays out the dependencies from a lockfile, and none of pnpm-lock\\.yaml, yarn\\.lock, package-lock\\.json, soldeer\\.lock installs ${realpathSync(tmp)}$`, 'mu')
    await Promise.all(['a.js', 'b.sol'].map((entry) => refused(t, ['bundle', '--deptree', entry], tmp, none)))
    t.assert.deepStrictEqual(readdirSync(tmp).toSorted(), ['Cargo.lock', 'a.js', 'b.sol', 'package.json'], 'nothing is written')
  }))

  test('with more than one lockfile that installs cwd', withTmp(async (t, tmp) => {
    const real = pnpmProject(tmp)
    cpSync(join(fixtures, 'yarn1-bundle', 'yarn.lock'), join(tmp, 'yarn.lock'))
    await refused(t, ['bundle', '--deptree', 'src/entry.js'], tmp, new RegExp(`^Error: bundleCommand: --deptree lays out the dependencies from a lockfile, and more than one lockfile installs ${real}: ${real}/pnpm-lock\\.yaml \\(pnpm\\), ${real}/yarn\\.lock \\(yarn1\\)$`, 'mu'))
  }))

  test('with a lockfile of the other kind of bundle', withTmp(async (t, tmp) => {
    const soldeer = join(tmp, 'soldeer')
    cpSync(join(fixtures, 'soldeer-bundle', 'project'), soldeer, { recursive: true })
    writeTree(soldeer, { 'a.js': '' })
    await t.assert.rejects(bundleCommand({ cwd: soldeer, entries: ['a.js'], deptree: true, env: {} }), /^Error: bundleCommand: only Solidity bundles are built with soldeer$/u)
    const pnpm = pnpmProject(join(tmp, 'pnpm'))
    writeTree(pnpm, { 'a.sol': '' })
    await t.assert.rejects(bundleCommand({ cwd: pnpm, entries: ['a.sol'], deptree: true, env: {} }), /^Error: bundleCommand: only JS bundles are built with pnpm$/u)
  }))

  test('with node_modules where the tree installs, a link to nowhere too: it is laid out over nothing installed', withTmp(async (t, tmp) => {
    const real = pnpmProject(tmp)
    mkdirSync(join(tmp, 'node_modules'))
    await refused(t, ['bundle', '--deptree', 'src/entry.js'], tmp, new RegExp(`^Error: ${real}/node_modules is there already, and the tree is laid out from ${real}/pnpm-lock\\.yaml alone, over nothing installed: remove it first$`, 'mu'))
    t.assert.equal(existsSync(join(tmp, 'stasis.code.br')), false, 'nothing is written')
    const link = pnpmProject(join(tmp, 'link'))
    symlinkSync('nowhere', join(link, 'node_modules'))
    await t.assert.rejects(bundleCommand({ cwd: link, entries: ['src/entry.js'], deptree: true, env: {} }), new RegExp(`^Error: ${link}/node_modules is there already`, 'u'))
  }))

  test("with node_modules in any of a workspace's projects, from cwd in another", withTmp(async (t, tmp) => {
    writeTree(tmp, {
      'package.json': '{"name":"root","private":true}',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'pnpm-lock.yaml': lockfile('.', 'packages/a', 'packages/b'),
      'packages/a/package.json': '{"name":"a"}',
      'packages/a/index.js': '',
      'packages/b/package.json': '{"name":"b"}',
      'packages/b/node_modules/.keep': '',
    })
    const real = realpathSync(tmp)
    await t.assert.rejects(bundleCommand({ cwd: join(tmp, 'packages', 'a'), entries: ['index.js'], deptree: true, env: {} }), new RegExp(`^Error: ${real}/packages/b/node_modules is there already, and the tree is laid out from ${real}/pnpm-lock\\.yaml alone`, 'u'))
  }))

  test("with Soldeer's dependencies folder where the tree installs", withTmp(async (t, tmp) => {
    cpSync(join(fixtures, 'soldeer-bundle', 'project'), tmp, { recursive: true })
    cpSync(join(fixtures, 'soldeer-bundle', 'dependencies'), join(tmp, 'dependencies'), { recursive: true })
    const real = realpathSync(tmp)
    await refused(t, ['bundle', '--deptree', 'src'], tmp, new RegExp(`^Error: ${real}/dependencies is there already, and the tree is laid out from ${real}/soldeer\\.lock alone, over nothing installed: remove it first$`, 'mu'))
  }))
})

test("stasis bundle --deptree gives npm the token ~/.npmrc gives npm's registry, where the environment gives none", withTmp(async (t, tmp) => {
  const NPM_TOKEN_VARS = ['PREVENTIVE_MEASURES_NPM_TOKEN', 'STASIS_NPM_TOKEN', 'NPM_TOKEN']
  const saved = NPM_TOKEN_VARS.map((name) => [name, process.env[name]])
  for (const name of NPM_TOKEN_VARS) delete process.env[name]
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  t.mock.method(console, 'warn', () => {})
  const token = `npm_${'a1B'.repeat(12)}`
  // A private package, which the npm client sends a token for (only a scoped one is private).
  const root = { name: 'p', version: '1.0.0', dependencies: { '@scope/q': '1.0.0' } }
  const q = { version: '1.0.0', resolved: 'https://registry.npmjs.org/@scope/q/-/q-1.0.0.tgz', integrity: `sha512-${'A'.repeat(86)}==` }
  const lock = { name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': root, 'node_modules/@scope/q': q } }
  const project = join(tmp, 'project')
  writeTree(project, { 'package.json': `${JSON.stringify(root, null, 2)}\n`, 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n`, 'index.js': "require('@scope/q')\n" })
  const home = join(tmp, 'home')
  writeTree(home, { '.npmrc': `//npm.pkg.github.com/:_authToken=npm_${'z9Y'.repeat(12)}\n//registry.npmjs.org/:_authToken=${token}\n` })
  const empty = join(tmp, 'empty')
  writeTree(empty, { '.npmrc': `//npm.pkg.github.com/:_authToken=${token}\n` })
  const sent = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push(`${new URL(url).host} ${new Headers(init?.headers).get('authorization')}`)
    return new Response('Not Found', { status: 404 })
  })
  // What the npm registry was sent for authorization, building with `home`'s ~/.npmrc.
  const authorized = async (at) => {
    sent.length = 0
    await t.assert.rejects(bundleCommand({ cwd: project, home: at, entries: ['index.js'], deptree: true, env: {}, output: 'out.br' }))
    t.assert.ok(sent.length > 0)
    return [...new Set(sent)]
  }
  t.assert.deepStrictEqual(await authorized(home), [`registry.npmjs.org Bearer ${token}`])
  t.assert.deepStrictEqual(NPM_TOKEN_VARS.map((name) => process.env[name]), [undefined, undefined, undefined], 'process.env as it was after')
  t.assert.deepStrictEqual(await authorized(empty), ['registry.npmjs.org null'], "none but npm's registry's")
  process.env.NPM_TOKEN = 'npm-env'
  t.assert.deepStrictEqual(await authorized(home), ['registry.npmjs.org Bearer npm-env'], "the environment's first")
  t.assert.equal(existsSync(join(project, 'out.br')), false, 'nothing is written')
}))
