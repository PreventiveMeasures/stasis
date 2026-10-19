import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { State } from '@exodus/stasis-core/state'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'

// Next.js compiles ~140 dependencies into dist/compiled/<dir>, each beside a trimmed package.json of its
// own, which names it rather than next. They are next's files, and a bundle lists the vendored packages
// among them it carries a file of: `vendored`, on next's record, metadata a lockfile never holds.

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-vendored-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const readBundle = (file) => JSON.parse(brotliDecompressSync(readFileSync(file)).toString('utf8'))

const UA = { name: 'ua-parser-js' }
const REACT_IS = { name: 'react-is', version: '19.3.0-canary-278794d7-20261002' }

// An app requiring two packages next vendors, of the three there.
function writeProject(dir) {
  write(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  write(join(dir, 'index.js'), "require('next/dist/compiled/ua-parser-js')\nrequire('next/dist/compiled/react-is')\n")
  const next = join(dir, 'node_modules', 'next')
  write(join(next, 'package.json'), JSON.stringify({ name: 'next', version: '16.4.0' }))
  const vendor = (sub, pkg) => {
    write(join(next, 'dist', 'compiled', sub, 'package.json'), JSON.stringify({ ...pkg, main: 'index.js', license: 'MIT' }))
    write(join(next, 'dist', 'compiled', sub, 'index.js'), 'module.exports = {}\n')
  }
  vendor('ua-parser-js', UA)
  vendor('react-is', REACT_IS)
  vendor('unreached', { name: 'unreached', version: '1.0.0' })
}

test('stasis bundle bundles the packages next vendors that it reaches, listing those, and only those, as vendored, through a State and through the field resolver', withTmp(async (t, tmp) => {
  writeProject(tmp)
  const labels = ['state', 'resolver']
  await Promise.all([{}, { mainFields: ['main'] }].map((options, i) =>
    bundleCommand({ cwd: tmp, entries: ['index.js'], output: `${labels[i]}.br`, lockfile: `${labels[i]}.lock.json`, ...options })))
  for (const label of labels) {
    const { modules } = readBundle(join(tmp, `${label}.br`))
    // react-is's package.json has a version too: still next's, never a bucket of its own.
    t.assert.deepStrictEqual(Object.keys(modules), ['node_modules/next'], label)
    const next = modules['node_modules/next']
    t.assert.ok(next.files['dist/compiled/ua-parser-js/index.js'], label)
    t.assert.deepStrictEqual(next.vendored, { 'dist/compiled/react-is': REACT_IS, 'dist/compiled/ua-parser-js': UA }, `${label}: bundle`)
    const lock = JSON.parse(readFileSync(join(tmp, `${label}.lock.json`), 'utf8'))
    t.assert.equal(lock.modules['node_modules/next'].vendored, undefined, `${label}: lockfile`)
  }
}))

test('State keeps the vendored packages a bundle it adds to lists, and adds those it reaches', withTmp((t, tmp) => {
  writeProject(tmp)
  const capture = (mode, sub) => {
    const state = new State(tmp, { scope: 'full', bundle: mode, lock: mode })
    state.addFile(pathToFileURL(join(tmp, 'index.js')).toString(), { format: 'commonjs', isEntry: true })
    state.addFile(pathToFileURL(join(tmp, 'node_modules', 'next', 'dist', 'compiled', sub, 'index.js')).toString(), { format: 'commonjs' })
    state.write()
    return readBundle(join(tmp, 'stasis.code.br')).modules['node_modules/next'].vendored
  }
  t.assert.deepStrictEqual(capture('replace', 'ua-parser-js'), { 'dist/compiled/ua-parser-js': UA })
  t.assert.deepStrictEqual(capture('add', 'react-is'), { 'dist/compiled/react-is': REACT_IS, 'dist/compiled/ua-parser-js': UA })
}))

test('merging bundles takes the union of their vendored packages, the existing side naming a directory both list', (t) => {
  const bundleOf = (vendored) => new Bundle({
    config: { scope: 'node_modules' },
    modules: new Map([['node_modules/next', {
      name: 'next', version: '16.4.0', ecosystem: 'npm', vendored,
      files: Object.fromEntries(Object.keys(vendored).map((sub) => [`${sub}/index.js`, 'module.exports = {}\n'])),
    }]]),
  })
  const merged = (a, b) => JSON.parse(bundleOf(a).merge(bundleOf(b)).serialize()).modules['node_modules/next'].vendored
  t.assert.deepStrictEqual(merged({ 'dist/compiled/ua-parser-js': UA }, { 'dist/compiled/react-is': REACT_IS }),
    { 'dist/compiled/react-is': REACT_IS, 'dist/compiled/ua-parser-js': UA })
  t.assert.deepStrictEqual(merged({ 'dist/compiled/ua-parser-js': UA }, { 'dist/compiled/ua-parser-js': { name: 'other' } }),
    { 'dist/compiled/ua-parser-js': UA }, "metadata: the existing side's, no mismatch")
})
