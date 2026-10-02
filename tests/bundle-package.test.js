import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { addCommand } from '@exodus/stasis-core/add'
import { lockfileFromBundle } from '@exodus/stasis-core/extract'
import { State } from '@exodus/stasis-core/state'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'

const PKG = { npm: { name: 'pkg', version: '0.0.1' } }
const base = (pkg, repo) => new Bundle({ config: { scope: 'node_modules' }, package: pkg, repo })
const withPackageJSON = (pkg) => JSON.stringify({ ...JSON.parse(base().serialize()), package: pkg })
// `package` and its ecosystem blocks are null-prototype: copy both levels to compare with plain literals.
const plainPackage = (pkg) => Object.fromEntries(Object.entries(pkg).map(([ecosystem, block]) => [ecosystem, { ...block }]))

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-package-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const readBundle = (file) => Bundle.parse(brotliDecompressSync(readFileSync(file)).toString('utf8'))
const writeBundle = (file, bundle) => writeFileSync(file, brotliCompressSync(bundle.serialize()))

test('Bundle omits package when unset', (t) => {
  t.assert.equal(base().package, undefined)
  t.assert.equal(JSON.parse(base().serialize()).package, undefined)
})

test('Bundle round-trips package after config and repo, in canonical key order', (t) => {
  const json = JSON.parse(base({ npm: { version: '0.0.1', name: 'pkg' } }).serialize())
  t.assert.deepStrictEqual(Object.keys(json).slice(0, 3), ['version', 'config', 'package'])
  t.assert.deepStrictEqual(Object.keys(json.package.npm), ['name', 'version'])
  t.assert.deepStrictEqual(plainPackage(Bundle.parse(JSON.stringify(json)).package), PKG)
  const both = JSON.parse(base(PKG, { github: 'o/n' }).serialize())
  t.assert.deepStrictEqual(Object.keys(both).slice(0, 4), ['version', 'config', 'repo', 'package'])
  const all = base({ cargo: { name: 'c', version: '1.0.0' }, composer: { name: 'v/p', version: 'v1.0.0' }, npm: PKG.npm })
  t.assert.deepStrictEqual(Object.keys(JSON.parse(all.serialize()).package), ['npm', 'composer', 'cargo'])
})

const ECOSYSTEMS = ['npm', 'composer', 'cargo']
// Some ecosystem's names and versions, legacy npm names among them.
const GOOD = [
  'pkg', '@scope/pkg', 'JSONStream', "a~b!c'd(e)f*g", 'symfony/console', 'serde_json', 'tokio-util',
  '0.0.1', 'v6.4.8', '1.0.0-rc.1+build.01', 'dev-feature/x', '9007199254740992.0.0', 'x'.repeat(10_000),
]
// Space, `"#$%&,:;<=>?[\]^`{|}`, non-ASCII and control characters: in no ecosystem's names or versions.
const BAD = [...' "#$%&,:;<=>?[\\]^`{|}'].map((c) => `a${c}b`).concat(['', 'é', '1.0.0\n', '\t', '\x7F', '\x00', '\u2028'])

test('Bundle takes any name and version of characters some ecosystem uses', (t) => {
  for (const ecosystem of ECOSYSTEMS) {
    for (const value of GOOD) {
      const parsed = Bundle.parse(withPackageJSON({ [ecosystem]: { name: value, version: value } })).package[ecosystem]
      t.assert.deepStrictEqual({ ...parsed }, { name: value, version: value }, `${ecosystem}: ${value}`)
    }
  }
})

test('Bundle package fields are each optional, and an empty block is no block', (t) => {
  for (const pkg of [{ npm: { name: 'pkg' } }, { npm: { version: '1.0.0' } }]) {
    t.assert.deepStrictEqual(plainPackage(Bundle.parse(withPackageJSON(pkg)).package), pkg)
  }
  for (const pkg of [{}, { npm: {} }, { npm: undefined }, { npm: { name: undefined } }]) {
    t.assert.equal(base(pkg).package, undefined, JSON.stringify(pkg))
    t.assert.equal(JSON.parse(base(pkg).serialize()).package, undefined)
  }
  t.assert.equal(Bundle.parse(withPackageJSON({ npm: {} })).package, undefined)
})

test('Bundle rejects an invalid package block on parse and on construction', (t) => {
  const bad = [
    'pkg@0.0.1',
    null,
    [],
    { pypi: { name: 'pkg' } },
    { soldeer: { name: 'pkg' } },
    { github: { name: 'o/n' } },
    { Npm: { name: 'pkg' } },
    { npm: 'pkg@0.0.1' },
    { npm: null },
    { npm: [] },
    { npm: { name: 'pkg', version: '0.0.1', integrity: 'sha512-' } },
    { cargo: { name: 'c', version: '1.0.0', checksum: 'x' } },
    ...ECOSYSTEMS.flatMap((ecosystem) => [...BAD, 1, null, true, {}, ['pkg']].flatMap((value) =>
      [{ [ecosystem]: { name: value } }, { [ecosystem]: { version: value } }])),
  ]
  for (const pkg of bad) {
    t.assert.throws(() => Bundle.parse(withPackageJSON(pkg)), undefined, `parse: ${JSON.stringify(pkg)}`)
    t.assert.throws(() => base(pkg), undefined, `constructor: ${JSON.stringify(pkg)}`)
  }
})

test('Bundle carries package through withReason', (t) => {
  t.assert.deepStrictEqual(plainPackage(base(PKG).withReason('bundle').package), PKG)
})

test('Bundle merge keeps only agreeing package fields, and no npm block of another or no name', (t) => {
  const stamped = base(PKG)
  t.assert.deepStrictEqual(plainPackage(stamped.merge(base(PKG)).package), PKG, 'agreeing: kept as is')
  t.assert.deepStrictEqual(plainPackage(stamped.merge(base({ npm: { name: 'pkg', version: '0.0.2' } })).package), { npm: { name: 'pkg' } },
    'same name, another version: only the version is dropped')
  t.assert.equal(stamped.merge(base({ npm: { name: 'other', version: '0.0.1' } })).package, undefined,
    'another name: the npm block is cleared, though the version agrees, and the empty package with it')
  t.assert.deepStrictEqual(plainPackage(stamped.merge(base({ npm: { name: 'pkg' } })).package), { npm: { name: 'pkg' } }, 'a field one side lacks is dropped')
  t.assert.equal(stamped.merge(base({ npm: { version: '0.0.1' } })).package, undefined,
    'a name one side lacks: the npm block is cleared, though the version agrees')
  t.assert.equal(base({ npm: { version: '0.0.1' } }).merge(base({ npm: { version: '0.0.1' } })).package, undefined,
    'no name on either side: cleared')
  t.assert.equal(stamped.merge(base({})).package, undefined, 'added from a bundle without package: cleared')
  t.assert.equal(stamped.merge(base({ npm: undefined })).package, undefined, 'added from a bundle without npm: cleared')
  t.assert.equal(base().merge(stamped).package, undefined, 'added into a bundle without package: never set')
})

test('Bundle merge takes each package ecosystem on its own', (t) => {
  const composer = { name: 'v/p', version: 'v1.0.0' }
  const cargo = { name: 'c', version: '0.1.0+build.1' }
  const all = base({ ...PKG, composer, cargo })
  t.assert.deepStrictEqual(plainPackage(all.merge(base({ ...PKG, composer, cargo })).package), { ...PKG, composer, cargo }, 'agreeing: kept as is')
  t.assert.deepStrictEqual(plainPackage(all.merge(base({ ...PKG, composer: { ...composer, version: '1.0.0' }, cargo: { name: 'd', version: cargo.version } })).package),
    { ...PKG, composer: { name: 'v/p' } }, 'composer: a version spelled otherwise is dropped; cargo: another name clears the block')
  t.assert.deepStrictEqual(plainPackage(all.merge(base({ cargo })).package), { cargo }, 'only what both sides know')
  t.assert.deepStrictEqual(all.merge(base({ cargo: { name: 'C', version: cargo.version } })).package, undefined, 'names compare exactly')
})

test('package never reaches a lockfile', (t) => {
  t.assert.equal(JSON.parse(lockfileFromBundle(base(PKG)).serialize()).package, undefined)
})

test('Bundle validates a directly assigned package', (t) => {
  const bundle = base()
  t.assert.throws(() => { bundle.package = { npm: { name: 'a b' } } }, /invalid bundle package\.npm\.name/u)
  t.assert.throws(() => { bundle.package = { npm: { version: 1 } } }, /invalid bundle package\.npm\.version/u)
  t.assert.throws(() => { bundle.package = { npm: { tag: 'latest' } } }, /unknown bundle package\.npm key 'tag'/u)
  t.assert.throws(() => { bundle.package = { pypi: {} } }, /unknown bundle package key 'pypi'/u)
  t.assert.equal(bundle.package, undefined, 'a rejected value is not stored')
  bundle.package = { npm: { version: '0.0.1', name: 'pkg' } }
  t.assert.deepStrictEqual(Object.keys(bundle.package.npm), ['name', 'version'], 'normalized on assignment')
  t.assert.deepStrictEqual(JSON.parse(bundle.serialize()).package, PKG)
  bundle.package = { npm: {} }
  t.assert.equal(bundle.package, undefined)
})

test('Bundle package and repo are frozen, so serialize writes only what was validated', (t) => {
  const bundle = base({ npm: { name: 'pkg', version: '0.0.1' } }, { github: 'o/n' })
  t.assert.throws(() => { bundle.package.npm.name = 'a b' }, TypeError)
  t.assert.throws(() => { bundle.package.npm.tag = 'latest' }, TypeError)
  t.assert.throws(() => { bundle.package.pypi = {} }, TypeError)
  t.assert.throws(() => { bundle.repo.github = 'not valid' }, TypeError)
  t.assert.throws(() => { delete bundle.repo.github }, TypeError)
  const json = JSON.parse(bundle.serialize())
  t.assert.deepStrictEqual(json.package, PKG)
  t.assert.deepStrictEqual(json.repo, { github: 'o/n' })
  for (const merged of [bundle.merge(bundle), bundle.withReason('bundle'), Bundle.parse(bundle.serialize())]) {
    t.assert.ok(Object.isFrozen(merged.package) && Object.isFrozen(merged.package.npm) && Object.isFrozen(merged.repo))
  }
})

test('stasis add never sets package, and adding to a stamped bundle clears it', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'pkg', version: '0.0.1' }))
  writeFileSync(join(tmp, 'stasis.config.json'), '{}')
  writeFileSync(join(tmp, 'index.js'), 'export {}\n')
  const out = join(tmp, 'stasis.code.br')
  addCommand({ cwd: tmp, entries: ['index.js'] })
  t.assert.equal(readBundle(out).package, undefined, 'a fresh add: not set from package.json')
  const added = readBundle(out)
  added.package = PKG
  writeBundle(out, added)
  addCommand({ cwd: tmp, entries: ['index.js'] })
  t.assert.equal(readBundle(out).package, undefined, 'added to: cleared')
}))

test('stasis bundle never sets package, and --add to a stamped bundle clears it', withTmp(async (t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'pkg', version: '0.0.1' }))
  writeFileSync(join(tmp, 'main.sh'), '#!/bin/sh\necho hi\n')
  const out = join(tmp, 'out.br')
  await bundleCommand({ cwd: tmp, entries: ['main.sh'], output: 'out.br', lockfile: undefined })
  t.assert.equal(readBundle(out).package, undefined, 'a fresh bundle: not set from package.json')
  const built = readBundle(out)
  built.package = PKG
  writeBundle(out, built)
  await bundleCommand({ cwd: tmp, entries: ['main.sh'], output: 'out.br', lockfile: undefined, add: true })
  t.assert.equal(readBundle(out).package, undefined, '--add: cleared')
}))

test('State never sets package, and bundle=add clears a stamped one', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'pkg', version: '0.0.1' }))
  const written = (bundle) => JSON.parse(new State(tmp, { bundle, lock: 'replace', scope: 'full' }).sourceData).package
  t.assert.equal(written('replace'), undefined, 'a fresh bundle: not set from package.json')
  writeBundle(join(tmp, 'stasis.code.br'), new Bundle({ config: { scope: 'full' }, package: PKG }))
  t.assert.equal(written('add'), undefined, 'added to: cleared')
}))
