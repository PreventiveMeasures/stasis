import { test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Bundle } from '@exodus/stasis-core/bundle'
import { State } from '@exodus/stasis-core/state'
import { withTmp } from './tmp.helper.js'

// The fixture lockfile contains literal `"__proto__"` JSON keys under both
// modules['node_modules/widget'].files AND sources['.'].files. JSON.parse turns
// each into an OWN data property; the danger is the later `module.files[rel] = X`
// write inside addFile -- on a plain `{}` with no own __proto__ yet, that assignment
// would route through Object.prototype's inherited __proto__ setter. The fix is to
// normalise both branches to null-prototype on load so the write stays an own data
// property regardless of the key.

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'state-load-proto')
const state = new State(root)

test('modules branch: loaded module.files is a null-prototype object', (t) => {
  const widget = state.modules.get('node_modules/widget')
  t.assert.ok(widget, 'widget module entry must be present')
  t.assert.equal(Object.getPrototypeOf(widget.files), null)
  t.assert.ok(Object.hasOwn(widget.files, 'index.js'))
  t.assert.ok(Object.hasOwn(widget.files, '__proto__'))
  // own data property, not the prototype
  t.assert.equal(widget.files.__proto__, 'sha512-evil-mod')
})

test('sources branch (full scope): loaded source.files is a null-prototype object', (t) => {
  // The constructor has a SEPARATE normalisation site for json.sources entries; this
  // pins that branch independently so a future change can't regress it.
  const project = state.modules.get('.')
  t.assert.ok(project, '. (project) source entry must be present')
  t.assert.equal(Object.getPrototypeOf(project.files), null)
  t.assert.ok(Object.hasOwn(project.files, 'src/entry.js'))
  t.assert.ok(Object.hasOwn(project.files, '__proto__'))
  t.assert.equal(project.files.__proto__, 'sha512-evil-src')
})

test('bracket-assigning "__proto__" on a loaded module.files writes an own data property', (t) => {
  // This is the actual write path the fix defends against. addFile does
  // `module.files[rel] = integrity`; on a JSON-loaded plain `{}` with no own __proto__,
  // that would invoke the inherited __proto__ setter (silently rejecting string values
  // or rebinding the object's prototype to an object value). On a null-prototype object
  // the same write creates an own data property.
  const widget = state.modules.get('node_modules/widget')
  delete widget.files.__proto__ // remove the forged entry so we test a fresh assign
  t.assert.equal(widget.files.__proto__, undefined, 'pre-condition: nothing visible at __proto__')

  widget.files['__proto__'] = 'sha512-fresh-assign'

  t.assert.equal(widget.files.__proto__, 'sha512-fresh-assign', 'reads back as own data property')
  t.assert.equal(Object.getPrototypeOf(widget.files), null, 'prototype chain still null')
  // Sanity: nothing leaked to the surrounding realm.
  t.assert.equal(Object.prototype.polluted, undefined)
})

test('state.hashes indexes both forged __proto__ entries under their joined paths', (t) => {
  t.assert.equal(state.hashes.get('node_modules/widget/__proto__'), 'sha512-evil-mod')
  t.assert.equal(state.hashes.get('__proto__'), 'sha512-evil-src')
})

test('a recorded `__proto__` file is written into the bundle', withTmp((t, dir) => {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
  writeFileSync(join(dir, '__proto__'), 'module.exports = 42\n')
  const st = new State(dir, { lock: 'add', bundle: 'add' })
  st.addFile(pathToFileURL(join(dir, '__proto__')).toString(), { format: 'commonjs' })
  t.assert.equal(Bundle.parse(st.sourceBundle.serialize()).modules.get('.').files.__proto__, 'module.exports = 42\n')
}))
