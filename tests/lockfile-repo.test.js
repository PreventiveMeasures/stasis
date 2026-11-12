import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'
import { withTmp } from './tmp.helper.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const REPO = { github: 'org/repo', directory: 'packages/app', commit: 'a'.repeat(40) }
const sri = (text) => `sha512-${createHash('sha512').update(text).digest('base64')}`
const lockOf = (repo) => new Lockfile({
  entries: new Set(['index.js']),
  modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'index.js': sri('export default 1\n') } }]]),
  imports: new Map(),
  formats: new Map([['index.js', 'module']]),
  repo,
})

test('Lockfile records a repo where given one, right after config, as a bundle does, validated and frozen; a merge, or a lockfile of a bundle, records none', (t) => {
  const lock = lockOf(REPO)
  const text = lock.serialize()
  t.assert.deepStrictEqual(Object.keys(JSON.parse(text)).slice(0, 4), ['version', 'config', 'repo', 'entries'])
  t.assert.deepStrictEqual({ ...Lockfile.parse(text).repo }, REPO)
  t.assert.ok(Object.isFrozen(lock.repo))
  t.assert.equal(lockOf().repo, undefined)
  t.assert.ok(!Object.hasOwn(JSON.parse(lockOf().serialize()), 'repo'), 'none written where it records none')
  t.assert.equal(lockOf({}).repo, undefined, 'an empty one is none')
  // Held to a bundle's repo's rules, given or parsed.
  t.assert.throws(() => lockOf({ github: 'not a repo' }), /invalid lockfile repo\.github: "not a repo"/u)
  t.assert.throws(() => lockOf({ ...REPO, branch: 'main' }), /unknown lockfile repo key 'branch'/u)
  t.assert.throws(() => Lockfile.parse(text.replace(REPO.commit, 'abc')), /invalid lockfile repo\.commit: "abc"/u)
  t.assert.throws(() => Lockfile.parse(text.replace(`"directory": "${REPO.directory}"`, '"directory": "../up"')), /invalid lockfile repo\.directory/u)
  // Of no one build: a merge records none, even of two that agree; nor does a lockfile of a bundle, whatever its repo.
  t.assert.equal(lock.merge(lockOf(REPO)).repo, undefined)
  t.assert.equal(lock.mergeAgreeing(lockOf(REPO)).repo, undefined)
  const bundle = new Bundle({ repo: REPO, entries: new Set(['index.js']), modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'index.js': 'export default 1\n' } }]]) })
  t.assert.equal(Lockfile.fromBundle(bundle, (_file, content) => sri(content)).repo, undefined)
})

test('stasis bundle and stasis run read no repo of a lockfile, whatever it is, and write none', withTmp(async (t, tmp) => {
  t.mock.method(console, 'warn', () => {})
  // A repo the bundle records of its package.json, which no lockfile does.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', repository: 'github:org/other' }))
  writeFileSync(join(tmp, 'index.js'), 'export default 1\n')
  const lockPath = join(tmp, 'stasis.lock.json')
  const lockRepo = () => Lockfile.parse(readFileSync(lockPath, 'utf8')).repo
  const stamp = () => {
    const lock = Lockfile.parse(readFileSync(lockPath, 'utf8'))
    lock.repo = { github: 'org/repo', directory: '', commit: 'b'.repeat(40) }
    writeFileSync(lockPath, lock.serialize())
  }
  const bundle = () => bundleCommand({ cwd: tmp, entries: ['index.js'], lockfile: 'stasis.lock.json', output: 'app.stasis.code.br', env: {} })
  await bundle()
  t.assert.equal(Bundle.parse(brotliDecompressSync(readFileSync(join(tmp, 'app.stasis.code.br'))).toString('utf8')).repo.github, 'org/other')
  t.assert.equal(lockRepo(), undefined, "the bundle's repo not written to the lockfile")
  // Held to it all the same (lock = add), its repo no matter: none written.
  stamp()
  await bundle()
  t.assert.equal(lockRepo(), undefined)
  // A run: frozen, held to it and nothing written; add, written anew, of none.
  stamp()
  const run = (lock) => spawnSync(process.execPath, [cli, 'run', `--lock=${lock}`, 'index.js'], { cwd: tmp, encoding: 'utf8', env: { ...process.env, EXODUS_STASIS_LOCK: '' } })
  const frozen = run('frozen')
  t.assert.equal(frozen.status, 0, frozen.stderr)
  t.assert.equal(lockRepo().commit, 'b'.repeat(40))
  const added = run('add')
  t.assert.equal(added.status, 0, added.stderr)
  t.assert.equal(lockRepo(), undefined)
}))
