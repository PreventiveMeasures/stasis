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
  t.assert.deepEqual(Object.keys(json).slice(0, 3), ['version', 'config', 'package'])
  t.assert.deepEqual(Object.keys(json.package.npm), ['name', 'version'])
  t.assert.deepEqual(Bundle.parse(JSON.stringify(json)).package, PKG)
  const both = JSON.parse(base(PKG, { github: 'o/n' }).serialize())
  t.assert.deepEqual(Object.keys(both).slice(0, 4), ['version', 'config', 'repo', 'package'])
  const all = base({ cargo: { name: 'c', version: '1.0.0' }, composer: { name: 'v/p', version: 'v1.0.0' }, npm: PKG.npm })
  t.assert.deepEqual(Object.keys(JSON.parse(all.serialize()).package), ['npm', 'composer', 'cargo'])
})

test('Bundle accepts npm names and versions the registry takes', (t) => {
  for (const name of ['pkg', '@scope/pkg', '@exodus/stasis-core', 'a.b_c-d', '-x', '0', '@a/b.c', 'x'.repeat(214)]) {
    t.assert.equal(Bundle.parse(withPackageJSON({ npm: { name, version: '1.0.0' } })).package.npm.name, name)
  }
  for (const version of ['0.0.1', '10.20.30', '1.0.0-beta.4', '1.0.0-0.3.7', '1.0.0-x.7.z.92', '1.0.0-alpha-a.b-c', '1.0.0-0a', '1.0.0--', `1.0.0-${'a'.repeat(250)}`]) {
    t.assert.equal(Bundle.parse(withPackageJSON({ npm: { name: 'pkg', version } })).package.npm.version, version)
  }
})

test('Bundle accepts Composer names and versions as published', (t) => {
  for (const name of ['symfony/console', 'laravel/framework', 'a/b', 'vendor.x_y-z/pkg', 'v/p.q_r-s--t', '0/0']) {
    t.assert.equal(Bundle.parse(withPackageJSON({ composer: { name, version: '1.0.0' } })).package.composer.name, name)
  }
  for (const version of [
    '1.0.0', 'v6.4.8', 'V1.0', '1', '1.2', '1.2.3.4', '2024.01.01', '1.0.0-beta1', '1.0.0-beta.2', 'v1.0.0-RC1',
    '2.0.0-alpha', '1.0.0alpha3', '1.0.0-p1', '1.0.0-patch1', '1.0.0-pl2', '1.0.0-stable', '1.0.0.beta-1.2', '1.0.0-b3',
  ]) {
    t.assert.equal(Bundle.parse(withPackageJSON({ composer: { name: 'v/p', version } })).package.composer.version, version)
  }
})

test('Bundle accepts crates.io names and Cargo versions', (t) => {
  for (const name of ['serde', 'serde_json', 'tokio-util', 'Inflector', 'a', 'a1', 'a'.repeat(64)]) {
    t.assert.equal(Bundle.parse(withPackageJSON({ cargo: { name, version: '1.0.0' } })).package.cargo.name, name)
  }
  for (const version of ['0.1.0', '1.0.0-alpha.1', '0.1.0+zstd.1.5.5', '1.0.0-rc.1+build.01', '1.0.0+20130313144700']) {
    t.assert.equal(Bundle.parse(withPackageJSON({ cargo: { name: 'c', version } })).package.cargo.version, version)
  }
})

test('Bundle package fields are each optional, and an empty block is no block', (t) => {
  for (const pkg of [{ npm: { name: 'pkg' } }, { npm: { version: '1.0.0' } }]) {
    t.assert.deepEqual(Bundle.parse(withPackageJSON(pkg)).package, pkg)
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
    { cargo: { name: 'c', version: '1.0.0', checksum: 'x' } },
    { npm: 'pkg@0.0.1' },
    { npm: null },
    { npm: [] },
    { npm: { name: 'pkg', version: '0.0.1', integrity: 'sha512-' } },
    ...[
      'Pkg', '.pkg', '_pkg', '@scope/.pkg', '@scope/_pkg', '@.scope/pkg', '@_scope/pkg', '@Scope/pkg',
      'a b', ' pkg', 'a/b', '@scope', '@scope/', '@/pkg', '@scope/a/b', 'a~b', 'a!b', "a'b", 'a(b)', 'a*b', 'a%2Fb', 'é',
      'node_modules', 'favicon.ico', 'x'.repeat(215), '', '.', '..', 42,
    ].map((name) => ({ npm: { name } })),
    ...[
      'v1.0.0', '=1.0.0', '1.0', '1', '01.0.0', '1.00.0', '1.0.0-01', '1.0.0+build', '1.0.0-beta+exp.sha.5114f85',
      '1.0.0-', '1.0.0-a..b', '1.0.0-a_b', ' 1.0.0', '', 1, `1.0.0-${'a'.repeat(251)}`,
    ].map((version) => ({ npm: { version } })),
    ...[
      'symfony', 'Symfony/console', 'symfony/Console', '/console', 'symfony/', 'a/b/c', 'a//b', '-a/b', 'a-/b', 'a/-b', 'a/b-',
      'a--b/c', 'a/b---c', 'a/b..c', 'a/b_.c', 'a b/c', 'é/b', '', 42,
    ].map((name) => ({ composer: { name } })),
    ...[
      'dev-main', 'dev-feature/x', '1.x-dev', '1.0.0-dev', '1.0.0+build', '1.0.0.0.0', '1.0.0-foo', '1.0.0-1', 'v', 'vv1.0',
      '^1.0', '~1.0', '1.0.*', '>=1.0', '1.0 ', '', 1,
    ].map((version) => ({ composer: { version } })),
    ...['1serde', '_serde', '-serde', 'serde.json', 'serde json', 'a'.repeat(65), 'é', '', 42].map((name) => ({ cargo: { name } })),
    ...['v1.0.0', '1.0', '01.0.0', '1.0.0-01', '1.0.0+', '1.0.0+a..b', '1.0.0+a_b', '', 1].map((version) => ({ cargo: { version } })),
  ]
  for (const pkg of bad) {
    t.assert.throws(() => Bundle.parse(withPackageJSON(pkg)), undefined, `parse: ${JSON.stringify(pkg)}`)
    t.assert.throws(() => base(pkg), undefined, `constructor: ${JSON.stringify(pkg)}`)
  }
})

test('Bundle package validation stays linear on long near-misses', (t) => {
  const long = '1'.repeat(50_000)
  const bad = [
    { npm: { name: `${'a'.repeat(50_000)}!` } },
    { npm: { version: `1.0.0-${long}.${long}!` } },
    { composer: { name: `${'a'.repeat(50_000)}!` } },
    { composer: { name: `a/${'b'.repeat(50_000)}!` } },
    { composer: { name: `${'a.'.repeat(25_000)}/b!` } },
    { composer: { name: `a/${'b--'.repeat(25_000)}!` } },
    { composer: { version: `1.0.0-beta${'1.'.repeat(25_000)}x` } },
    { composer: { version: `1.0.0-beta${long}x` } },
    { cargo: { version: `1.0.0+${'a.'.repeat(25_000)}!` } },
  ]
  for (const pkg of bad) t.assert.throws(() => base(pkg), /invalid bundle package\./u)
})

test('Bundle carries package through withReason', (t) => {
  t.assert.deepEqual(base(PKG).withReason('bundle').package, PKG)
})

test('Bundle merge keeps only agreeing package fields, and no npm block of another or no name', (t) => {
  const stamped = base(PKG)
  t.assert.deepEqual(stamped.merge(base(PKG)).package, PKG, 'agreeing: kept as is')
  t.assert.deepEqual(stamped.merge(base({ npm: { name: 'pkg', version: '0.0.2' } })).package, { npm: { name: 'pkg' } },
    'same name, another version: only the version is dropped')
  t.assert.equal(stamped.merge(base({ npm: { name: 'other', version: '0.0.1' } })).package, undefined,
    'another name: the npm block is cleared, though the version agrees, and the empty package with it')
  t.assert.deepEqual(stamped.merge(base({ npm: { name: 'pkg' } })).package, { npm: { name: 'pkg' } }, 'a field one side lacks is dropped')
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
  t.assert.deepEqual(all.merge(base({ ...PKG, composer, cargo })).package, { ...PKG, composer, cargo }, 'agreeing: kept as is')
  t.assert.deepEqual(all.merge(base({ ...PKG, composer: { ...composer, version: '1.0.0' }, cargo: { name: 'd', version: cargo.version } })).package,
    { ...PKG, composer: { name: 'v/p' } }, 'composer: a version spelled otherwise is dropped; cargo: another name clears the block')
  t.assert.deepEqual(all.merge(base({ cargo })).package, { cargo }, 'only what both sides know')
  t.assert.deepEqual(all.merge(base({ cargo: { name: 'C', version: cargo.version } })).package, undefined, 'names compare exactly')
})

test('package never reaches a lockfile', (t) => {
  t.assert.equal(JSON.parse(lockfileFromBundle(base(PKG)).serialize()).package, undefined)
})

test('Bundle validates a directly assigned package', (t) => {
  const bundle = base()
  t.assert.throws(() => { bundle.package = { npm: { name: 'Pkg' } } }, /invalid bundle package\.npm\.name/u)
  t.assert.throws(() => { bundle.package = { npm: { version: 'v1' } } }, /invalid bundle package\.npm\.version/u)
  t.assert.throws(() => { bundle.package = { npm: { tag: 'latest' } } }, /unknown bundle package\.npm key 'tag'/u)
  t.assert.throws(() => { bundle.package = { pypi: {} } }, /unknown bundle package key 'pypi'/u)
  t.assert.equal(bundle.package, undefined, 'a rejected value is not stored')
  bundle.package = { npm: { version: '0.0.1', name: 'pkg' } }
  t.assert.deepEqual(Object.keys(bundle.package.npm), ['name', 'version'], 'normalized on assignment')
  t.assert.deepEqual(JSON.parse(bundle.serialize()).package, PKG)
  bundle.package = { npm: {} }
  t.assert.equal(bundle.package, undefined)
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
