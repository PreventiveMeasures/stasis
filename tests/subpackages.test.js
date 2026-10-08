import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { State } from '@exodus/stasis-core/state'
import { collectComponents } from '../stasis/src/sbom.js'
import { bundleCommand } from '../stasis/src/cmd/bundle.js'

// @hookform/resolvers's subpath entry points each have a package.json of their own (as microbundle lays
// them out), named in the package's namespace for their directory (`@hookform/resolvers/zod` at zod/)
// with a placeholder version (1.0.0). They are the package's: its files, under its identity, and a bundle
// lists those reached as `subpackages` on its record, metadata a lockfile never holds.

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-subpackages-'))
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

const ZOD = { name: '@hookform/resolvers/zod', version: '1.0.0' }

// An app requiring @hookform/resolvers/zod, of its two subpackages, installed at `pkgDir`.
function writeProject(dir, pkgDir = join(dir, 'node_modules', '@hookform', 'resolvers')) {
  write(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }))
  write(join(dir, 'index.js'), "require('@hookform/resolvers/zod')\n")
  write(join(pkgDir, 'package.json'), JSON.stringify({ name: '@hookform/resolvers', version: '5.9.1' }))
  for (const [sub, version] of [['zod', '1.0.0'], ['arktype', '2.0.0']]) {
    write(join(pkgDir, sub, 'package.json'), JSON.stringify({ name: `@hookform/resolvers/${sub}`, version, private: true, main: `dist/${sub}.js` }))
    write(join(pkgDir, sub, 'dist', `${sub}.js`), 'module.exports = {}\n')
  }
}

// Build through a State and through the field resolver: the record of @hookform/resolvers in each bundle,
// with the bucket dirs of each and of its lockfile.
async function build(tmp) {
  const labels = ['state', 'resolver']
  await Promise.all([{}, { mainFields: ['main'] }].map((options, i) =>
    bundleCommand({ cwd: tmp, entries: ['index.js'], output: `${labels[i]}.br`, lockfile: `${labels[i]}.lock.json`, ...options })))
  return labels.map((label) => {
    const { modules } = readBundle(join(tmp, `${label}.br`))
    const lock = JSON.parse(readFileSync(join(tmp, `${label}.lock.json`), 'utf8'))
    return { label, modules, lock }
  })
}

test('stasis bundle takes a subpackage as its package\'s and lists those it reaches, through a State and through the field resolver', withTmp(async (t, tmp) => {
  writeProject(tmp)
  for (const { label, modules, lock } of await build(tmp)) {
    t.assert.deepStrictEqual(Object.keys(modules), ['node_modules/@hookform/resolvers'], `${label}: no bucket of its own`)
    const record = modules['node_modules/@hookform/resolvers']
    t.assert.equal(record.version, '5.9.1', label)
    t.assert.ok(record.files['zod/dist/zod.js'], label)
    t.assert.deepStrictEqual(record.subpackages, { zod: ZOD }, `${label}: arktype unreached`)
    t.assert.equal(lock.modules['node_modules/@hookform/resolvers'].subpackages, undefined, `${label}: lockfile`)
  }
  // The package's own code: no component of its own in an SBOM.
  const bundle = Bundle.parse(brotliDecompressSync(readFileSync(join(tmp, 'state.br'))).toString('utf8'))
  t.assert.deepStrictEqual(collectComponents([bundle]).map((c) => c.name), ['@hookform/resolvers', 'app'])
}))

test('a subpackage\'s directory is taken by real path in a symlinked install', withTmp(async (t, tmp) => {
  // As pnpm lays one out: the package in its store, linked into node_modules.
  const store = join(tmp, 'node_modules', '.pnpm', '@hookform+resolvers@5.9.1', 'node_modules', '@hookform', 'resolvers')
  writeProject(tmp, store)
  mkdirSync(join(tmp, 'node_modules', '@hookform'), { recursive: true })
  symlinkSync(join('..', '.pnpm', '@hookform+resolvers@5.9.1', 'node_modules', '@hookform', 'resolvers'), join(tmp, 'node_modules', '@hookform', 'resolvers'))
  for (const { label, modules } of await build(tmp)) {
    t.assert.deepStrictEqual(Object.values(modules).map((record) => record.subpackages), [{ zod: ZOD }], label)
  }
  // Captured through the link, the package's package.json is under it while findPackageJSON resolves the
  // subpackage's to the store.
  const state = new State(tmp, { scope: 'full', bundle: 'replace', lock: 'replace' })
  state.addFile(pathToFileURL(join(tmp, 'node_modules', '@hookform', 'resolvers', 'zod', 'dist', 'zod.js')).toString(), { format: 'commonjs' })
  t.assert.deepStrictEqual({ ...state.modules.get('node_modules/@hookform/resolvers').subpackages }, { zod: ZOD })
}))
