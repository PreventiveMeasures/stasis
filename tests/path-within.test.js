// The containment predicate every root check shares (stasis-core/src/util.js): a `..` SEGMENT climbs
// out, a `..`-prefixed NAME (`..cache`) does not.
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeEntries } from '@exodus/stasis-core/bundle-util'
import { assertRealPathWithinBase, isPathWithin, relativeEscapes } from '@exodus/stasis-core/util'

test('isPathWithin: a `..`-prefixed name is inside, a `..` segment is not', (t) => {
  t.assert.equal(isPathWithin('/p', '/p'), true)
  t.assert.equal(isPathWithin('/p', '/p/a'), true)
  t.assert.equal(isPathWithin('/p', '/p/..cache/x'), true)
  t.assert.equal(isPathWithin('/p', '/p/a/..b'), true)
  t.assert.equal(isPathWithin('/p', '/p/..'), false)
  t.assert.equal(isPathWithin('/p', '/p/../q'), false)
  t.assert.equal(isPathWithin('/p', '/q'), false)
  t.assert.equal(isPathWithin('/p', '/pq'), false)
  t.assert.equal(relativeEscapes(''), false)
  t.assert.equal(relativeEscapes('..x'), false)
  t.assert.equal(relativeEscapes('..'), true)
  t.assert.equal(relativeEscapes('../x'), true)
  t.assert.equal(relativeEscapes('/x'), true)
})

test('a `..`-prefixed name passes the symlink-containment and entry checks; a `..` segment fails them', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stasis-path-within-')))
  const outside = join(dir, '..', 'stasis-path-within-outside.js')
  try {
    mkdirSync(join(dir, '..cache'))
    writeFileSync(join(dir, '..cache', 'x.js'), '')
    symlinkSync(join('..cache', 'x.js'), join(dir, 'link.js'))
    assertRealPathWithinBase(dir, dir, '..cache/x.js')
    assertRealPathWithinBase(dir, dir, 'link.js')
    writeFileSync(outside, '')
    symlinkSync(outside, join(dir, 'escape.js'))
    t.assert.throws(() => assertRealPathWithinBase(dir, dir, 'escape.js'), /escaping bundle root/)
    t.assert.deepStrictEqual(normalizeEntries(['..cache/x.js'], dir), ['..cache/x.js'])
    t.assert.throws(() => normalizeEntries(['../x.js'], dir), /escapes baseDir/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(outside, { force: true })
  }
})
