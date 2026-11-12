// `generic-javascript` and `generic-typescript`: the code Metro builds from source, whose module type is Metro's to
// decide. A file Node loads too is recorded in the format Node loads it in, whichever is recorded first.

import { test } from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { State } from '@exodus/stasis-core/state'
import { metroFormat, mergeFormatMaps, reconcileFormat } from '@exodus/stasis-core/util'
import { serializeShard } from '../stasis-core/src/shard.js'
import { withTmp } from './tmp.helper.js'

test('metroFormat: the format a name gives, else generic JavaScript or TypeScript', (t) => {
  for (const [path, format] of [
    ['a.js', 'generic-javascript'], ['a.jsx', 'generic-javascript'], ['a.ts', 'generic-typescript'], ['a.tsx', 'generic-typescript'],
    ['a.mjs', 'module'], ['a.cjs', 'commonjs'], ['a.mts', 'module-typescript'], ['a.cts', 'commonjs-typescript'], ['a.json', 'json'],
  ]) t.assert.equal(metroFormat(`src/${path}`), format, path)
  // As Node spells an extension: neither an upper-case one nor a dotfile is one.
  for (const path of ['A.JS', '.js', 'a.d', 'a.png']) t.assert.equal(metroFormat(path), undefined, path)
})

test('reconcileFormat: a generic format yields to the format Node loads the file in, either way', (t) => {
  for (const [generic, node] of [
    ['generic-javascript', 'commonjs'], ['generic-javascript', 'module'],
    ['generic-typescript', 'module-typescript'], ['generic-typescript', 'commonjs-typescript'],
    // A .tsx Node builds records the JS family.
    ['generic-typescript', 'module'],
  ]) {
    t.assert.equal(reconcileFormat(generic, node, 'f'), node)
    t.assert.equal(reconcileFormat(node, generic, 'f'), node)
  }
  t.assert.deepStrictEqual(mergeFormatMaps(new Map([['a.js', 'generic-javascript']]), new Map([['a.js', 'commonjs']]), 'm'), new Map([['a.js', 'commonjs']]))
  t.assert.deepStrictEqual(mergeFormatMaps(new Map([['a.js', 'module']]), new Map([['a.js', 'generic-javascript']]), 'm'), new Map([['a.js', 'module']]))
  // A payload-free stat record yields to it, as to any file's format; but it yields to no other.
  t.assert.equal(reconcileFormat('generic-javascript', 'stat:file', 'f'), 'generic-javascript')
  for (const other of ['json', 'shell', 'resource', 'generic-typescript']) {
    t.assert.throws(() => reconcileFormat('generic-javascript', other, 'f'), /format conflict for 'f'/u, other)
  }
})

const seed = (dir, type) => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', ...(type && { type }) }))
  writeFileSync(join(dir, 'shared.js'), 'export const x = 1\n')
  return pathToFileURL(join(dir, 'shared.js')).toString()
}
const lockOf = (dir) => JSON.parse(readFileSync(join(dir, 'stasis.lock.json'), 'utf8'))

test('a file Metro builds and Node loads both is recorded in the format Node loads it in, in either order', withTmp((t, dir) => {
  const url = seed(dir, 'module')
  for (const order of [['generic-javascript', 'module'], ['module', 'generic-javascript']]) {
    const state = new State(dir, { scope: 'full', lock: 'replace', bundle: 'none' })
    for (const format of order) state.addFile(url, { format, inferFormat: format !== 'generic-javascript' })
    state.write()
    t.assert.equal(lockOf(dir).formats['shared.js'], 'module', order.join(' then '))
  }
}))

test('a frozen run takes Metro\'s capture of a file the lockfile records in the format Node loads it in, not the reverse', withTmp((t, dir) => {
  const url = seed(dir, 'module')
  const capture = new State(dir, { scope: 'full', lock: 'replace', bundle: 'none' })
  capture.addFile(url, { format: 'module' })
  capture.write()
  new State(dir, { scope: 'full', lock: 'frozen', bundle: 'none' }).addFile(url, { format: 'generic-javascript', inferFormat: false })

  // Recorded for Metro alone, a Node load of it is no file the lockfile attests in that format.
  const metro = new State(dir, { scope: 'full', lock: 'replace', bundle: 'none' })
  metro.addFile(url, { format: 'generic-javascript', inferFormat: false })
  metro.write()
  t.assert.equal(lockOf(dir).formats['shared.js'], 'generic-javascript')
  t.assert.throws(() => new State(dir, { scope: 'full', lock: 'frozen', bundle: 'none' }).addFile(url, { format: 'module' }), /mismatches the lockfile/u)
  // A run that adds to the lockfile takes it, keeping Node's.
  const add = new State(dir, { scope: 'full', lock: 'add', bundle: 'none' })
  add.addFile(url, { format: 'module' })
  add.write()
  t.assert.equal(lockOf(dir).formats['shared.js'], 'module')
}))

test('a frozen run takes Metro\'s capture of a file a lockfile written before the generic formats records with none', withTmp((t, dir) => {
  const url = seed(dir)
  const capture = new State(dir, { scope: 'full', lock: 'replace', bundle: 'none' })
  capture.addFile(url, { format: 'generic-javascript', inferFormat: false })
  capture.write()
  const lock = lockOf(dir)
  delete lock.formats['shared.js']
  writeFileSync(join(dir, 'stasis.lock.json'), `${JSON.stringify(lock, undefined, 2)}\n`)
  new State(dir, { scope: 'full', lock: 'frozen', bundle: 'none' }).addFile(url, { format: 'generic-javascript', inferFormat: false })
  // But a Node load of it is attested by no format there.
  t.assert.throws(() => new State(dir, { scope: 'full', lock: 'frozen', bundle: 'none' }).addFile(url, { format: 'commonjs' }), /is not attested by the lockfile/u)
}))

test('mergeShard keeps a child\'s generic format of a .js in a typed package, inferring none', withTmp((t, dir) => {
  seed(dir, 'module')
  const shard = serializeShard({ scope: 'full', files: ['shared.js'], formats: new Map([['shared.js', 'generic-javascript']]), imports: new Map() })
  const root = new State(dir, { scope: 'full', lock: 'replace', bundle: 'none' })
  root.mergeShard(shard)
  root.write()
  t.assert.equal(lockOf(dir).formats['shared.js'], 'generic-javascript')
}))
