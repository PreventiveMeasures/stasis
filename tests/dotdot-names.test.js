// A name beginning with two dots (`..cache`) is an ordinary in-root path, not a parent-directory
// escape: the `stasis` package's containment checks share stasis-core's segment-aware
// relativeEscapes (PreventiveMeasures/stasis#7 fixed the core sites). Each test below drives one
// of the package's own checks with such a name next to a genuine escape.
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildBundle } from '@exodus/stasis/cmd/bundle'
import { Vfs, suggestedEntries } from '@exodus/stasis/vfs-bundle'

import { assertWithinBase } from '../stasis/src/loaders/paths.js'
import { extractPhpImports, resolvePhpDir, resolvePhpImport } from '../stasis/src/loaders/php.js'
import { withinRealDir } from '../stasis/src/loaders/rust.js'
import { scan } from '../stasis/src/scan.js'

const withProject = (files, fn) => async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stasis-dotdot-')))
  try {
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true })
      writeFileSync(join(dir, p), content)
    }
    await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const PKG = JSON.stringify({ name: 'proj', version: '1.0.0' })

test('assertWithinBase (loaders/paths.js) keeps a `..`-prefixed name and rejects a `..` segment', withProject({ '..cache/x.sh': '' }, (t, dir) => {
  assertWithinBase(dir, '..cache/x.sh', 'Entry path')
  t.assert.throws(() => assertWithinBase(dir, '../x.sh', 'Entry path'), /Entry path escapes baseDir/)
  t.assert.throws(() => assertWithinBase(dir, '/x.sh', 'Entry path'), /Entry path must not be absolute/)
}))

test('withinRealDir (loaders/rust.js) accepts a `..`-prefixed subdirectory of the package', withProject({ 'vendor/..crate/lib.rs': '', 'other/x.rs': '' }, (t, dir) => {
  t.assert.equal(withinRealDir(dir, 'vendor/..crate/lib.rs', 'vendor'), true)
  const warn = console.warn
  console.warn = () => {}
  try {
    t.assert.equal(withinRealDir(dir, 'other/x.rs', 'vendor'), false, 'a sibling directory is still outside')
  } finally {
    console.warn = warn
  }
}))

test('resolvePhpDir / resolvePhpImport (loaders/php.js) resolve a project-relative `..`-prefixed path', withProject({ '..cache/a.php': '<?php', 'src/A.php': '<?php' }, (t, dir) => {
  // From a subdirectory, so the file-relative probe misses and the project-relative one answers.
  t.assert.equal(resolvePhpDir('..cache', 'src/A.php', dir), '..cache')
  t.assert.equal(resolvePhpImport('..cache/a.php', 'src/A.php', { baseDir: dir }), '..cache/a.php')
  t.assert.equal(resolvePhpImport('../a.php', 'A.php', { baseDir: dir }), null, 'a real escape still resolves to nothing')
  // A `__DIR__`-anchored include keeps its `./` prefix, so it stays dir-relative rather than becoming a bare specifier.
  t.assert.deepStrictEqual(extractPhpImports("require __DIR__ . '/..cache/a.php';"), ['./..cache/a.php'])
  t.assert.equal(resolvePhpImport('./..cache/a.php', 'index.php', { baseDir: dir }), '..cache/a.php')
}))

test('suggestedEntries (vfs-bundle/entries.js) keeps a main under a `..`-prefixed directory', async (t) => {
  const vfs = new Vfs()
  vfs.mkdir('/..dist', { recursive: true })
  vfs.writeFile('/package.json', JSON.stringify({ name: 'proj', version: '1.0.0', main: '..dist/index.js' }))
  vfs.writeFile('/..dist/index.js', 'module.exports = 1\n')
  t.assert.deepStrictEqual(await suggestedEntries({ vfs, packageManager: 'pnpm' }), ['..dist/index.js'])
})

test('scan(...).toRelative (scan.js) keys a file under a `..`-prefixed directory root-relative', withProject({ 'package.json': PKG, '..cache/entry.cjs': "require('./dep.cjs')\n", '..cache/dep.cjs': 'module.exports = 1\n' }, (t, dir) => {
  const result = scan([join(dir, '..cache/entry.cjs')]).toRelative(dir)
  t.assert.deepStrictEqual([...result.files.keys()].toSorted(), ['..cache/dep.cjs', '..cache/entry.cjs'])
  t.assert.throws(() => scan([join(dir, '..cache/entry.cjs')]).toRelative(join(dir, 'src')), /Path outside root/)
}))

test('buildBundle (cmd/bundle.js) bundles an entry under a `..`-prefixed directory', withProject({ '.git/HEAD': '', 'package.json': PKG, '..cache/index.cjs': "require('./dep.cjs')\n", '..cache/dep.cjs': 'module.exports = 1\n' }, async (t, dir) => {
  const bundle = await buildBundle({ cwd: dir, entries: ['..cache/index.cjs'] })
  t.assert.deepStrictEqual([...bundle.sources.keys()].toSorted(), ['..cache/dep.cjs', '..cache/index.cjs'])
  t.assert.deepStrictEqual([...bundle.entries], ['..cache/index.cjs'])
}))
