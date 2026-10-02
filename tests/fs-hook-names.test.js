// Name rules of the --fs hooks (stasis-core/src/fs.js), driven through the GENUINE global fs patch:
//   - a skipped name (`.env`, `*.map`) is NON-EXISTENT to every reader, readdir included, in the
//     sync and the async forms alike -- a stat that says ENOENT next to a listing that answers
//     would contradict each other, and a listing of a `.env` directory is still a sweep of secrets;
//   - a `..`-prefixed in-root name (`..cache`) is an ordinary path: captured and served, never
//     mistaken for a parent-directory escape by a bare startsWith('..').
// installFsHooks is imported by relative path and runs once per process, as fs-sidecar.test.js explains.
import { test } from 'node:test'
import * as nodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { State } from '@exodus/stasis-core/state'

import { installFsHooks } from '../stasis-core/src/fs.js'

let active = null // the State the hooks see; null => passthrough (so setup/teardown fs is untouched)
let lastAbort = null
installFsHooks({ async: true, getState: () => active, markAborted: (err) => { lastAbort = err }, isLoadingModule: () => false })

const withProject = (fn) => async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stasis-fs-names-')))
  lastAbort = null
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fs-names-fixture', version: '1.0.0', type: 'module' }))
    mkdirSync(join(dir, '.env'))
    writeFileSync(join(dir, '.env', 'secret.txt'), 'hunter2\n')
    mkdirSync(join(dir, '..cache'))
    writeFileSync(join(dir, '..cache', 'data.txt'), 'cached\n')
    await fn(t, dir)
  } finally {
    active = null
    rmSync(dir, { recursive: true, force: true })
  }
}

const ENOENT = { code: 'ENOENT' }
const fromCallback = (fn, ...args) => promisify(fn)(...args)

test('capture: a listing of a skipped name is ENOENT in every readdir form, and nothing is recorded', withProject(async (t, dir) => {
  const state = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile: join(dir, 'b.br') })
  active = state
  const envDir = join(dir, '.env')
  t.assert.throws(() => nodeFs.readdirSync(envDir), ENOENT)
  t.assert.throws(() => nodeFs.readdirSync(envDir, { withFileTypes: true }), ENOENT)
  await t.assert.rejects(fromCallback(nodeFs.readdir, envDir), ENOENT)
  await t.assert.rejects(fromCallback(nodeFs.readdir, envDir, { withFileTypes: true }), ENOENT)
  await t.assert.rejects(nodeFs.promises.readdir(envDir), ENOENT)
  // ...as the other readers already answered.
  t.assert.throws(() => nodeFs.statSync(envDir), ENOENT)
  t.assert.equal(nodeFs.existsSync(envDir), false)
  active = null
  t.assert.equal(state.getFsStat(pathToFileURL(envDir).toString()), undefined, 'a skipped listing must not be recorded')
  t.assert.equal(lastAbort, null)
}))

test('capture + load: a `..`-prefixed in-root name is captured and then served, not read as an escape', withProject(async (t, dir) => {
  const bundleFile = join(dir, 'b.br')
  const cacheDir = join(dir, '..cache')
  const dataFile = join(cacheDir, 'data.txt')
  // A declared resource, so the bundle carries no code and needs no entry to be loadable.
  const capture = new State(dir, { scope: 'full', lock: 'add', bundle: 'add', bundleFile, resources: ['txt'] })
  active = capture
  t.assert.deepStrictEqual(nodeFs.readdirSync(cacheDir), ['data.txt'])
  t.assert.equal(nodeFs.readFileSync(dataFile, 'utf8'), 'cached\n')
  t.assert.equal(nodeFs.statSync(dataFile).isFile(), true)
  active = null
  t.assert.equal(capture.getFsStat(pathToFileURL(cacheDir).toString()), 'directory', 'the listing is captured')
  t.assert.equal(capture.getFsStat(pathToFileURL(dataFile).toString()), 'file', 'the read is captured')
  t.assert.equal(lastAbort, null)
  capture.write()

  // Gone from disk, the same reads are served from the bundle.
  rmSync(cacheDir, { recursive: true })
  const load = new State(dir, { scope: 'full', lock: 'frozen', bundle: 'load', bundleFile, resources: ['txt'] })
  active = load
  t.assert.deepStrictEqual(nodeFs.readdirSync(cacheDir), ['data.txt'])
  t.assert.equal(nodeFs.readFileSync(dataFile, 'utf8'), 'cached\n')
  t.assert.equal(nodeFs.existsSync(dataFile), true)
  t.assert.equal(nodeFs.statSync(dataFile).isFile(), true)
  t.assert.deepStrictEqual(await nodeFs.promises.readdir(cacheDir), ['data.txt'])
}))
