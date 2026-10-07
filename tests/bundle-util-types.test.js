// stasis-core/src/bundle-util.d.ts declares what bundle-util.js exports: no more, no less.
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as bundleUtil from '@exodus/stasis-core/bundle-util'

const declarations = readFileSync(fileURLToPath(import.meta.resolve('@exodus/stasis-core/bundle-util').replace(/\.js$/u, '.d.ts')), 'utf8')

test('bundle-util.d.ts declares every runtime export of bundle-util.js, and nothing else', (t) => {
  const declared = new Set(Array.from(declarations.matchAll(/^export (?:function|const) (\w+)/gmu), (m) => m[1]))
  t.assert.deepStrictEqual([...declared].toSorted(), Object.keys(bundleUtil).toSorted())
})
