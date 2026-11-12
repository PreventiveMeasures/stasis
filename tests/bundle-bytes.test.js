import { test } from 'node:test'

import { Bundle } from '@exodus/stasis-core/bundle'
import { compressBundle, compressBundleText } from '@exodus/stasis-core/brotli'

test('Bundle#serializedBytes is serialize() as UTF-8, and compressBundle compresses it as compressBundleText does', (t) => {
  const repo = { github: 'org/repo', directory: 'packages/app', commit: 'a'.repeat(40) }
  const packages = Array.from({ length: 5 }, (_, i) => [`node_modules/@s/p${i}`, { name: `@s/p${i}`, version: '1.0.0', ecosystem: 'npm', files: { 'index.js': `module.exports = ${i}${i % 2 ? ' // Ж😀' : ''}\n`, 'font.ttf': 'AAEAAAA=' } }])
  const bundles = [
    new Bundle(),
    new Bundle({ config: { scope: 'node_modules' } }),
    new Bundle({ config: { scope: 'node_modules' }, modules: new Map(packages), formats: new Map(packages.flatMap(([dir]) => [[`${dir}/index.js`, 'commonjs'], [`${dir}/font.ttf`, 'resource:base64']])) }),
    new Bundle({ config: { scope: 'node_modules' }, modules: new Map([['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': 'module.exports = "Ж"\n' } }]]) }),
    new Bundle({
      repo,
      package: { npm: { name: 'app', version: '1.0.0' } },
      entries: new Set(['src/index.js']),
      modules: new Map([
        ['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': "import 'dep'\n// 😀 café\n", 'bin/run.sh': '#!/bin/sh\n', 'logo.png': 'iVBORw0KGgo=' } }],
        ['node_modules/dep', { name: 'dep', version: '1.0.0', ecosystem: 'npm', files: { 'index.js': `export default ${JSON.stringify('x'.repeat(100_000))}\n` } }],
      ]),
      formats: new Map([['src/index.js', 'module'], ['bin/run.sh', 'shell'], ['logo.png', 'resource:base64'], ['node_modules/dep/index.js', 'module']]),
      imports: new Map([['node, import', new Map([['src/index.js', new Map([['dep', 'node_modules/dep/index.js']])]])]]),
      executable: new Set(['bin/run.sh']),
    }).withReason('bundle'),
  ]
  for (const bundle of bundles) {
    t.assert.deepStrictEqual(bundle.serializedBytes(), Buffer.from(bundle.serialize(), 'utf8'))
    for (const quality of [undefined, 0, 11]) t.assert.deepStrictEqual(compressBundle(bundle, quality), compressBundleText(bundle.serialize(), quality))
  }
  const invalid = new Bundle({ modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'stasis.lock.json': '{}\n' } }]]) })
  const refusal = (() => {
    try {
      invalid.serialize()
    } catch (error) {
      return error.message
    }
  })()
  t.assert.ok(refusal)
  t.assert.throws(() => invalid.serializedBytes(), { message: refusal })
})
