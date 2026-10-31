import { describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { bundleCommand } from '../stasis/src/cmd/bundle.js'
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

// Write `files` (a path from `dir` -> its text) under `dir`, with their directories.
const writeTree = (dir, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
}

// The pnpm fixture's files, copied to `dir` without anything installed.
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
    const entries = ['a.sh', 'a.php', 'a.rs']
    const runs = await Promise.all(entries.map((entry) => runCli(['bundle', '--deptree', entry], { cwd: tmp })))
    for (const [i, r] of runs.entries()) {
      t.assert.equal(r.status, 1, entries[i])
      t.assert.match(r.stderr, /^Error: --deptree is only valid for JS and \.sol bundles\n/u, entries[i])
    }
  }))

  test('runs nothing of the project from disk: --babel and --metro-resolver are refused', withTmp(async (t, tmp) => {
    writeTree(tmp, { 'a.js': '' })
    const babel = await runCli(['bundle', '--deptree', '--metro', '--platforms=ios', '--babel', 'a.js'], { cwd: tmp })
    t.assert.equal(babel.status, 1)
    t.assert.match(babel.stderr, /^Error: --babel can't be combined with --deptree \(it runs the project's Babel config from disk, where --deptree installs nothing\)\n/u)
    const resolver = await runCli(['bundle', '--deptree', '--metro', '--platforms=ios', '--metro-resolver', 'a.js'], { cwd: tmp })
    t.assert.equal(resolver.status, 1)
    t.assert.match(resolver.stderr, /^Error: --metro-resolver can't be combined with --deptree \(it runs the project's metro-resolver from disk, where --deptree installs nothing\)\n/u)
  }))

  test("is the bundle's flag, which stasis.config.json's entries set none of, and which goes with the entries it names", withTmp(async (t, tmp) => {
    writeTree(tmp, { 'a.js': '', 'stasis.config.json': JSON.stringify({ entries: { 'a.js': { deptree: true } } }) })
    const r = await runCli(['bundle', 'a.js'], { cwd: tmp })
    t.assert.equal(r.status, 1)
    t.assert.match(r.stderr, /^Error: stasis\.config\.json: entries "a\.js": deptree is the bundle's option, not an entry's: pass --deptree\n/u)
    // Given for the entries the config names, it is taken: here, up to finding no lockfile.
    writeTree(tmp, { 'stasis.config.json': JSON.stringify({ entries: { 'a.js': { jsx: true } } }) })
    const given = await runCli(['bundle', '--deptree'], { cwd: tmp })
    t.assert.equal(given.status, 1)
    t.assert.match(given.stderr, /--deptree lays out the dependencies from a lockfile, and none of/u)
  }))
})

describe('stasis bundle --deptree refusals, before anything is fetched', { concurrency: 4 }, () => {
  test('without a lockfile that installs cwd: none of the ones it lays out from', withTmp(async (t, tmp) => {
    writeTree(tmp, { 'package.json': '{"name":"p"}', 'a.js': '', 'b.sol': '', 'Cargo.lock': '' })
    const real = realpathSync(tmp)
    const entries = ['a.js', 'b.sol']
    const runs = await Promise.all(entries.map((entry) => runCli(['bundle', '--deptree', entry], { cwd: tmp })))
    for (const [i, r] of runs.entries()) {
      t.assert.equal(r.status, 1, entries[i])
      t.assert.match(r.stderr, new RegExp(`^Error: bundleCommand: --deptree lays out the dependencies from a lockfile, and none of pnpm-lock\\.yaml, yarn\\.lock, package-lock\\.json, soldeer\\.lock installs ${real}$`, 'mu'), entries[i])
    }
    t.assert.deepStrictEqual(readdirSync(tmp).toSorted(), ['Cargo.lock', 'a.js', 'b.sol', 'package.json'], 'nothing is written')
  }))

  test('with more than one lockfile that installs cwd', withTmp(async (t, tmp) => {
    const real = pnpmProject(tmp)
    cpSync(join(fixtures, 'yarn1-bundle', 'yarn.lock'), join(tmp, 'yarn.lock'))
    const r = await runCli(['bundle', '--deptree', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 1)
    t.assert.match(r.stderr, new RegExp(`^Error: bundleCommand: --deptree lays out the dependencies from a lockfile, and more than one lockfile installs ${real}: ${real}/pnpm-lock\\.yaml \\(pnpm\\), ${real}/yarn\\.lock \\(yarn1\\)$`, 'mu'))
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
    const r = await runCli(['bundle', '--deptree', 'src/entry.js'], { cwd: tmp })
    t.assert.equal(r.status, 1)
    t.assert.match(r.stderr, new RegExp(`^Error: ${real}/node_modules is there already, and the tree is laid out from ${real}/pnpm-lock\\.yaml alone, over nothing installed: remove it first$`, 'mu'))
    t.assert.equal(existsSync(join(tmp, 'stasis.code.br')), false, 'nothing is written')
    const link = pnpmProject(join(tmp, 'link'))
    symlinkSync('nowhere', join(link, 'node_modules'))
    await t.assert.rejects(bundleCommand({ cwd: link, entries: ['src/entry.js'], deptree: true, env: {} }), new RegExp(`^Error: ${link}/node_modules is there already`, 'u'))
  }))

  test("with node_modules in any of a workspace's projects, from cwd in another", withTmp(async (t, tmp) => {
    writeTree(tmp, {
      'package.json': '{"name":"root","private":true}',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n\n  packages/a: {}\n\n  packages/b: {}\n",
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
    const r = await runCli(['bundle', '--deptree', 'src'], { cwd: tmp })
    t.assert.equal(r.status, 1)
    t.assert.match(r.stderr, new RegExp(`^Error: ${real}/dependencies is there already, and the tree is laid out from ${real}/soldeer\\.lock alone, over nothing installed: remove it first$`, 'mu'))
  }))
})
