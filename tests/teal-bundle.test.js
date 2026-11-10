import { test } from 'node:test'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { buildBundle, buildTealBundle, bundleCommand } from '../stasis/src/cmd/bundle.js'
import { bundlePlan } from '../stasis/src/cmd/bundle-options.js'
import { withTmp } from './tmp.helper.js'

// Write `files` (a path from `dir` -> its content) under `dir`, with their directories.
const writeTree = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
}

// An app's two programs, as AlgoKit lays out what Puya compiles, beside another app's.
const APPROVAL = '#pragma version 10\ntxn ApplicationID\nreturn\n'
const CLEAR = '#pragma version 10\nint 1\nreturn\n'
const app = (dir) => writeTree(dir, {
  'artifacts/Counter/Counter.approval.teal': APPROVAL,
  'artifacts/Counter/Counter.clear.teal': CLEAR,
  'artifacts/Child/Child.approval.teal': CLEAR,
})
const ENTRIES = ['artifacts/Counter/Counter.approval.teal', 'artifacts/Counter/Counter.clear.teal']

test('buildTealBundle carries its entries alone, each a teal file with no imports', withTmp(async (t, tmp) => {
  app(tmp)
  const bundle = await buildTealBundle({ cwd: tmp, entries: [...ENTRIES, ENTRIES[0]] })
  t.assert.deepStrictEqual([...bundle.entries], ENTRIES)
  t.assert.deepStrictEqual(Object.fromEntries(bundle.sources), { [ENTRIES[0]]: APPROVAL, [ENTRIES[1]]: CLEAR })
  t.assert.deepStrictEqual(Object.fromEntries(bundle.formats), { [ENTRIES[0]]: 'teal', [ENTRIES[1]]: 'teal' })
  t.assert.deepStrictEqual([...bundle.imports].map(([key, edges]) => [key, edges.size]), [['teal', 0]])
  // No package.json: the workspace bucket's placeholder identity.
  t.assert.equal(bundle.modules.get('.').name, 'teal-bundle')
}))

test('buildTealBundle refuses a missing entry, one not UTF-8, and a link out of the root', withTmp(async (t, tmp) => {
  writeTree(tmp, { 'outside.teal': CLEAR, 'root/bad.teal': Buffer.from([0x69, 0x6e, 0x74, 0x0a, 0xff, 0x0a]) })
  const cwd = join(tmp, 'root')
  await t.assert.rejects(() => buildTealBundle({ cwd, entries: ['gone.teal'] }), /^Error: TEAL bundle has unresolved programs:\n {2}Missing entry: gone\.teal$/u)
  await t.assert.rejects(() => buildTealBundle({ cwd, entries: ['bad.teal'] }), /bad\.teal: not valid UTF-8/u)
  if (process.platform === 'win32') return
  symlinkSync(join(tmp, 'outside.teal'), join(cwd, 'escape.teal'))
  await t.assert.rejects(() => buildTealBundle({ cwd, entries: ['escape.teal'] }), /Refusing to follow symlink escaping bundle root: escape\.teal/u)
}))

test('stasis bundle writes a TEAL bundle for .teal entries', withTmp(async (t, tmp) => {
  app(tmp)
  const output = join(tmp, 'out.stasis.code.br')
  await bundleCommand({ cwd: tmp, ...bundlePlan({ cwd: tmp, entries: ENTRIES, values: { output } }) })
  const parsed = Bundle.parse(brotliDecompressSync(readFileSync(output)).toString('utf8'))
  t.assert.deepStrictEqual([...parsed.entries], ENTRIES)
  t.assert.deepStrictEqual([...parsed.formats.values()], ['teal', 'teal'])
}))

test('a JS bundle carries the .teal files stasis.config.json\'s extra names as teal', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': '{ "name": "app", "version": "1.0.0", "type": "module" }\n',
    'deploy.js': 'export const deploy = () => {}\n',
    'stasis.config.json': '{ "extra": ["artifacts/**/*.teal"] }\n',
  })
  app(tmp)
  const bundle = await buildBundle({ cwd: tmp, entries: ['deploy.js'] })
  for (const rel of [...ENTRIES, 'artifacts/Child/Child.approval.teal']) t.assert.equal(bundle.formats.get(rel), 'teal', rel)
}))
