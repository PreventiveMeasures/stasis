import { test } from 'node:test'

import { Bundle } from '@exodus/stasis-core/bundle'
import { lockfileFromBundle } from '@exodus/stasis-core/extract'
import { sha512integrity } from '@exodus/stasis-core/state-util'

const bytes = (text) => new TextEncoder().encode(text)
// Code with a byte order mark, a base64 resource of every byte value, longer than one call's arguments hold, and an
// executable shell script; of a repository.
const logo = Uint8Array.from({ length: 0x8000 + 3 }, (_, i) => i % 256)
const FILES = { 'src/main.js': bytes('﻿main\n'), 'assets/logo.png': logo, 'bin/run.sh': bytes('#!/bin/sh\necho\n') }
const bundle = new Bundle({
  repo: { github: 'org/repo', commit: '7'.repeat(40) },
  entries: new Set(['src/main.js']),
  executable: new Set(['bin/run.sh']),
  formats: new Map([['src/main.js', 'commonjs'], ['assets/logo.png', 'resource:base64'], ['bin/run.sh', 'shell']]),
  modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/main.js': '﻿main\n', 'assets/logo.png': Buffer.from(logo).toString('base64'), 'bin/run.sh': '#!/bin/sh\necho\n' } }]]),
})
const lockfile = Object.assign(lockfileFromBundle(bundle), { repo: bundle.repo })
const entry = (name, data, mode = 0o644) => ({ name, type: 'file', mode, data })
// As @preventive/archive's unpack gives a tar of them: the lockfile at its top, a directory, each file it attests.
const entriesOf = (lock = lockfile, files = FILES) => [
  entry('stasis.lock.json', bytes(lock.serialize())),
  { name: 'src', type: 'directory', mode: 0o755, data: new Uint8Array() },
  ...Object.entries(files).map(([name, data]) => entry(name, data, bundle.executable.has(name) ? 0o755 : 0o644)),
]
const integrityOf = sha512integrity

test('Bundle.fromTar: the bundle of a tar\'s files, held to the stasis.lock.json at its top by the caller\'s integrityOf, of the repository it records', (t) => {
  t.assert.equal(Bundle.fromTar(entriesOf(), { integrityOf }).serialize(), bundle.serialize())
  const hashed = []
  Bundle.fromTar(entriesOf(), { integrityOf: (data) => (hashed.push(data.length), integrityOf(data)) })
  t.assert.deepStrictEqual(hashed.toSorted((a, b) => a - b), Object.values(FILES).map((data) => data.length).toSorted((a, b) => a - b), 'each file hashed once, by the caller')
})

test('Bundle.fromTar: refuses a tar other than exactly its stasis.lock.json\'s files, each its bytes and execute bit, held to Bundle.parse\'s file rules', (t) => {
  const refused = (entries, message) => t.assert.throws(() => Bundle.fromTar(entries, { integrityOf }), { message })
  const [lock, dir, ...files] = entriesOf()
  const [main, logoEntry, run] = files
  refused([...entriesOf(), entry('src/extra.js', bytes('extra\n'))], 'src/extra.js is in it, but not in its stasis.lock.json')
  refused([lock, main, run], 'assets/logo.png, which its stasis.lock.json attests, is not in it')
  refused([lock, entry('src/main.js', bytes('MAIN\n')), logoEntry, run], /^stasis: src\/main\.js does not match the lockfile \(expected sha512-\S+, got sha512-\S+\)$/u)
  refused([lock, main, logoEntry, { ...run, mode: 0o644 }], "bin/run.sh's execute bit is not the one its stasis.lock.json attests")
  refused([lock, { ...main, mode: 0o744 }, logoEntry, run], "src/main.js's execute bit is not the one its stasis.lock.json attests")
  for (const type of ['symlink', 'hardlink', 'character-device', 'fifo']) refused([...entriesOf(), { name: 'src/odd', type, mode: 0o644, data: new Uint8Array() }], `src/odd is a ${type}, which no stasis.lock.json attests`)
  refused([dir, ...files], 'holds no stasis.lock.json at its top')
  refused(entriesOf().map((one) => ({ ...one, name: `package/${one.name}` })), 'holds no stasis.lock.json at its top')
  refused([entry('stasis.lock.json', bytes('{"version":0,"config":{"scope":"full"},"entries":[],"sources":{},"modules":{}}')), ...files], 'its stasis.lock.json is no stasis lockfile (lockfile must attest imports and formats)')
  refused([entry('stasis.lock.json', bytes(`﻿${lockfile.serialize()}`)), ...files], /^its stasis\.lock\.json is no stasis lockfile/u)
  // Code that is no UTF-8, whatever bytes its lockfile attests.
  const latin1 = Uint8Array.of(0x6d, 0xe9, 0x0a)
  const odd = (path, data, format) => {
    const lock2 = Object.assign(lockfileFromBundle(bundle), { repo: bundle.repo })
    lock2.modules.get('.').files[path] = integrityOf(data)
    // Its own, not the bundle's, whose Map Lockfile.fromBundle shares.
    if (format) lock2.formats = new Map([...lock2.formats, [path, format]])
    return [entry('stasis.lock.json', bytes(lock2.serialize())), ...files, entry(path, data)]
  }
  refused(odd('src/latin1.js', latin1), "stasis: src/latin1.js is recorded as 'code' but is not valid UTF-8")
  // Content for a payload-free stat record, a file no bundle carries: as Bundle.parse refuses a stasis.code.br of them.
  refused(odd('src/evil.js', bytes('evil\n'), 'stat:file'), "bundle: 'src/evil.js' is a payload-free 'stat:file' record, yet carries content")
  refused(odd('.npmrc', bytes('x\n')), 'bundle: .npmrc is a file no bundle may carry')
  // A directory capture its lockfile records: a listing no tar holds, whether or not one is in it.
  refused(odd('src', bytes('["main.js"]'), 'directory'), "its stasis.lock.json records 'src' as a directory capture, which a .stasis.tgz can't carry")
  refused(odd('src', bytes('["main.js"]'), 'directory').filter(({ name }) => name !== 'src'), "its stasis.lock.json records 'src' as a directory capture, which a .stasis.tgz can't carry")
})

test('bundle.toTar: what Bundle.fromTar takes back, the lockfile of its files at its top, each file by its path, an executable one 0o755, a stat record its lockfile\'s; a directory capture, a listing a tar can\'t carry, refused', (t) => {
  const entries = bundle.toTar({ integrityOf })
  t.assert.deepStrictEqual(entries.map(({ name, mode }) => [name, mode]), [['stasis.lock.json', 0o644], ['assets/logo.png', 0o644], ['bin/run.sh', 0o755], ['src/main.js', 0o644]])
  const back = (one) => Bundle.fromTar(one.toTar({ integrityOf }).map((packed) => ({ ...packed, type: 'file' })), { integrityOf })
  t.assert.equal(back(bundle).serialize(), bundle.serialize())
  // As a `--fs` run records them: a path's kind alone, and a listing.
  const recording = (formats, files = {}) => new Bundle({ ...bundle, repo: bundle.repo, formats: new Map([...bundle.formats, ...formats]), modules: new Map([['.', { ...bundle.modules.get('.'), files: { ...bundle.modules.get('.').files, ...files } }]]) })
  const stats = recording([['src/gone.js', 'stat:file'], ['lib', 'stat:directory']])
  t.assert.equal(back(stats).serialize(), stats.serialize(), 'stat records, payload-free, carried')
  t.assert.throws(() => recording([['src', 'directory']], { src: '["main.js"]' }).toTar({ integrityOf }), { message: "bundle: 'src' is a directory capture, which a .stasis.tgz can't carry" })
})
