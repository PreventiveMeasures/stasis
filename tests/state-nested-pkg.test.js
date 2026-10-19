import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Bundle } from '@exodus/stasis-core/bundle'
import { State } from '@exodus/stasis-core/state'

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'state-nested-pkg')

test('addFile on a file under a nested sub-bucket package.json uses the package root', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'lib', 'util.js')).toString()
  state.addFile(url, { format: 'module' })

  const module = state.modules.get('node_modules/widget')
  t.assert.ok(module, 'package root entry must be present')
  t.assert.equal(module.name, 'widget')
  t.assert.equal(module.version, '1.2.3')
  // A node_modules bucket is an installed dependency: tagged with the npm ecosystem.
  t.assert.equal(module.ecosystem, 'npm')
  t.assert.ok(!state.modules.has('node_modules/widget/lib'), 'must not bucket under the nested marker dir')
  t.assert.ok(module.files['lib/util.js'])
})

test('addFile rejects a nested package.json that disagrees on name/version', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'conflict', 'lib', 'inner.js')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'module' }))
})

test('addFile rejects a nested package.json that disagrees on version alone', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'stale', 'dist', 'index.js')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'commonjs' }), /Inconsistent data between node_modules\/stale\/dist\/package\.json/)
})

test('addFile tolerates the listed upstream mismatch: @redis/client dist/package.json', (t) => {
  // Many @redis/client releases publish a stale build-time copy of package.json in dist/ (1.6.0
  // ships dist/ at 1.5.17, 5.8.0 at 5.7.0): the exemption pins no version, and the bucket keeps
  // the package root's identity.
  const cases = [
    { dir: ['node_modules'], version: '1.6.0' },
    { dir: ['node_modules', 'host', 'node_modules'], version: '5.8.0' },
  ]
  for (const { dir, version } of cases) {
    const state = new State(root)
    const url = pathToFileURL(join(root, ...dir, '@redis', 'client', 'dist', 'index.js')).toString()
    state.addFile(url, { format: 'commonjs' })
    const module = state.modules.get([...dir, '@redis', 'client'].join('/'))
    t.assert.ok(module)
    t.assert.equal(module.name, '@redis/client')
    t.assert.equal(module.version, version)
    t.assert.ok(module.files['dist/index.js'])
  }
})

// Next.js compiles ~140 dependencies into dist/compiled/<dir>, each beside a trimmed package.json naming
// it (most with no version, some under a dir that isn't their name: loader-utils2 is `loader-utils`).
const NEXT = join(root, 'node_modules', 'next')
const nextFile = (rel) => pathToFileURL(join(NEXT, ...rel.split('/'))).toString()

test('addFile takes a package vendored in a listed vendor dir as its host\'s, and lists it as vendored', (t) => {
  const state = new State(root)
  state.addFile(nextFile('dist/compiled/ua-parser-js/ua-parser.js'))
  state.addFile(nextFile('dist/compiled/react-is/index.js'))
  // Below a nameless `{"type":"module"}` marker: the vendored package is the nearest one named.
  state.addFile(nextFile('dist/compiled/@babel/runtime/helpers/esm/extends.js'))
  state.addFile(nextFile('dist/compiled/loader-utils2/index.js'))
  // In the vendor dir, but in no vendored package: the host's own.
  state.addFile(nextFile('dist/compiled/raw.js'))

  const module = state.modules.get('node_modules/next')
  t.assert.equal(module.name, 'next')
  t.assert.equal(module.version, '16.4.0')
  t.assert.ok(module.files['dist/compiled/ua-parser-js/ua-parser.js'])
  t.assert.ok(!state.modules.has('node_modules/next/dist/compiled/ua-parser-js'), 'never a bucket of its own')
  // The marker's `type` still decides the format.
  t.assert.equal(state.formats.get('node_modules/next/dist/compiled/@babel/runtime/helpers/esm/extends.js'), 'module')
  // Only what was reached: dist/compiled/unreached is never listed.
  t.assert.deepStrictEqual({ ...module.vendored }, {
    'dist/compiled/ua-parser-js': { name: 'ua-parser-js' },
    'dist/compiled/react-is': { name: 'react-is', version: '19.3.0-canary-278794d7-20261002' },
    'dist/compiled/@babel/runtime': { name: '@babel/runtime', version: '7.27.0' },
    'dist/compiled/loader-utils2': { name: 'loader-utils' },
  })
})

test('a nested package.json outside the vendor dir is still held to its host\'s identity', (t) => {
  const state = new State(root)
  t.assert.throws(() => state.addFile(nextFile('dist/server/next.js')),
    /Inconsistent data between node_modules\/next\/dist\/server\/package\.json and node_modules\/next\/package\.json/)
})

test('a bundle lists the vendored packages it carries a file of; a lockfile none', (t) => {
  const state = new State(root, { lock: 'add', bundle: 'add' })
  state.addFile(nextFile('dist/compiled/ua-parser-js/ua-parser.js'))
  state.addFile(nextFile('dist/compiled/react-is/LICENSE'), { resource: true })

  const record = (artifact) => JSON.parse(artifact.serialize()).modules['node_modules/next']
  t.assert.deepStrictEqual(record(state.sourceBundle).vendored, {
    'dist/compiled/react-is': { name: 'react-is', version: '19.3.0-canary-278794d7-20261002' },
    'dist/compiled/ua-parser-js': { name: 'ua-parser-js' },
  })
  // Each half of a split bundle lists the vendored packages of the files it carries.
  t.assert.deepStrictEqual(record(state.codeBundle).vendored, { 'dist/compiled/ua-parser-js': { name: 'ua-parser-js' } })
  t.assert.deepStrictEqual(record(state.resourcesBundle).vendored, {
    'dist/compiled/react-is': { name: 'react-is', version: '19.3.0-canary-278794d7-20261002' },
  })
  t.assert.equal(record(state.lockfile).vendored, undefined, 'metadata, which a lockfile never records')

  const parsed = Bundle.parse(state.sourceBundle.serialize())
  t.assert.deepStrictEqual(Object.keys(parsed.modules.get('node_modules/next').vendored), ['dist/compiled/react-is', 'dist/compiled/ua-parser-js'])
})

test('a bundle refuses a vendored entry that holds none of its files, or on first-party code', (t) => {
  const bundle = (modules, sources = { '.': { name: 'app', files: { 'index.js': '' } } }) => JSON.stringify({
    version: 1, config: { scope: 'full' }, entries: ['index.js'], formats: {}, imports: {}, sources, modules,
  })
  const next = (vendored) => ({ 'node_modules/next': { name: 'next', version: '16.4.0', ecosystem: 'npm', vendored, files: { 'dist/compiled/a/index.js': '' } } })
  t.assert.doesNotThrow(() => Bundle.parse(bundle(next({ 'dist/compiled/a': { name: 'a' } }))))
  t.assert.throws(() => Bundle.parse(bundle(next({ 'dist/compiled/b': { name: 'b' } }))), /vendored 'dist\/compiled\/b' holds none of its files/)
  t.assert.throws(() => Bundle.parse(bundle(next({ 'dist/compiled/a': { version: '1.0.0' } }))), /has no name/)
  t.assert.throws(() => Bundle.parse(bundle(next({ 'dist/compiled/a': { name: 'a', path: 'x' } }))), /unknown .* key 'path'/)
  t.assert.throws(() => Bundle.parse(bundle(next({ 'dist/../a': { name: 'a' } }))), /invalid directory/)
  t.assert.throws(() => Bundle.parse(bundle({}, { '.': { name: 'app', vendored: { lib: { name: 'x' } }, files: { 'lib/index.js': '' } } })),
    /no dependency's bucket, and carries no vendored/)
})

// @hookform/resolvers lays its subpath entry points out as microbundle does: zod/package.json, named
// `@hookform/resolvers/zod`, with a placeholder version of its own (1.0.0; arktype's is 2.0.0).
const HOOKFORM = join(root, 'node_modules', '@hookform', 'resolvers')
const hookformFile = (rel) => pathToFileURL(join(HOOKFORM, ...rel.split('/'))).toString()

test('addFile takes a subpackage as its package\'s, its own version held to nothing, and lists it', (t) => {
  const state = new State(root)
  state.addFile(hookformFile('zod/dist/zod.js'))
  state.addFile(hookformFile('ajv/dist/ajv.js')) // a subpackage with no version
  // Below a `{"type":"module"}` marker: the subpackage is the nearest package.json with a name.
  state.addFile(hookformFile('yup/dist/esm/yup.js'))
  state.addFile(hookformFile('dist/resolvers.js')) // the package's own

  const module = state.modules.get('node_modules/@hookform/resolvers')
  t.assert.equal(module.name, '@hookform/resolvers')
  t.assert.equal(module.version, '5.9.1')
  t.assert.ok(module.files['zod/dist/zod.js'])
  t.assert.ok(!state.modules.has('node_modules/@hookform/resolvers/zod'), 'never a bucket of its own')
  // Only what was reached: arktype is never listed.
  t.assert.deepStrictEqual({ ...module.subpackages }, {
    zod: { name: '@hookform/resolvers/zod', version: '1.0.0' },
    ajv: { name: '@hookform/resolvers/ajv' },
    yup: { name: '@hookform/resolvers/yup', version: '1.0.0' },
  })
  t.assert.equal(state.formats.get('node_modules/@hookform/resolvers/yup/dist/esm/yup.js'), 'module', 'the marker still decides the format')
  t.assert.equal(module.vendored, undefined, 'its own code, no copy of another package')
})

test('a package.json below a subpackage\'s, not its own, is still held to the package\'s version', (t) => {
  // yup/dist/cjs/package.json gives a version and no name: no subpackage's, whatever is above it.
  const state = new State(root)
  t.assert.throws(() => state.addFile(hookformFile('yup/dist/cjs/yup.js')),
    /Inconsistent data between node_modules\/@hookform\/resolvers\/yup\/dist\/cjs\/package\.json and node_modules\/@hookform\/resolvers\/package\.json/)
})

test('a package.json named in the package\'s namespace for another directory is still held to its version', (t) => {
  const state = new State(root)
  t.assert.throws(() => state.addFile(hookformFile('misplaced/index.js')),
    /Inconsistent data between node_modules\/@hookform\/resolvers\/misplaced\/package\.json and node_modules\/@hookform\/resolvers\/package\.json/)
})

test('a bundle lists the subpackages it carries a file of; a lockfile none', (t) => {
  const state = new State(root, { lock: 'add', bundle: 'add' })
  state.addFile(hookformFile('zod/dist/zod.js'))
  const record = (artifact) => JSON.parse(artifact.serialize()).modules['node_modules/@hookform/resolvers']
  t.assert.deepStrictEqual(record(state.sourceBundle).subpackages, { zod: { name: '@hookform/resolvers/zod', version: '1.0.0' } })
  t.assert.equal(record(state.lockfile).subpackages, undefined, 'metadata, which a lockfile never records')
  t.assert.deepStrictEqual({ ...Bundle.parse(state.sourceBundle.serialize()).modules.get('node_modules/@hookform/resolvers').subpackages.zod },
    { name: '@hookform/resolvers/zod', version: '1.0.0' })
})

test('a bundle refuses a subpackage named other than its package\'s name for its directory', (t) => {
  const bundle = (subpackages) => JSON.stringify({
    version: 1, config: { scope: 'node_modules' }, formats: {}, imports: {},
    modules: { 'node_modules/@hookform/resolvers': { name: '@hookform/resolvers', version: '5.9.1', ecosystem: 'npm', subpackages, files: { 'zod/dist/zod.js': '' } } },
  })
  t.assert.doesNotThrow(() => Bundle.parse(bundle({ zod: { name: '@hookform/resolvers/zod', version: '1.0.0' } })))
  t.assert.throws(() => Bundle.parse(bundle({ zod: { name: '@hookform/resolvers/yup', version: '1.0.0' } })),
    /subpackages 'zod' is named '@hookform\/resolvers\/yup', not '@hookform\/resolvers\/zod'/)
  t.assert.throws(() => Bundle.parse(bundle({ zod: { name: 'zod' } })), /is named 'zod'/)
  t.assert.throws(() => Bundle.parse(bundle({ yup: { name: '@hookform/resolvers/yup' } })), /subpackages 'yup' holds none of its files/)
})

test('addFile walks past a workspace type-only marker to find the project package.json', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'foo.cjs')).toString()
  state.addFile(url, { format: 'commonjs' })

  const module = state.modules.get('.')
  t.assert.ok(module, 'project root entry must be present')
  t.assert.equal(module.name, 'stasis-state-nested-pkg-fixture')
  t.assert.equal(module.version, '0.0.0')
  // The workspace/top-level bucket is not a dependency: no `ecosystem`.
  t.assert.equal(module.ecosystem, undefined)
  t.assert.ok(!state.modules.has('sub'), 'must not bucket under the marker dir')
  t.assert.ok(module.files['sub/foo.cjs'])
})

test('addFile walks past an empty workspace package.json to find the project package.json', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'empty', 'foo.cjs')).toString()
  state.addFile(url, { format: 'commonjs' })

  const module = state.modules.get('.')
  t.assert.ok(module)
  t.assert.equal(module.name, 'stasis-state-nested-pkg-fixture')
  t.assert.equal(module.version, '0.0.0')
  t.assert.ok(module.files['empty/foo.cjs'])
})

test('addFile accepts a workspace package.json with a name but no version', (t) => {
  // A local workspace package outside node_modules may omit version (private/unpublished).
  const state = new State(root)
  const url = pathToFileURL(join(root, 'partial', 'file.js')).toString()
  state.addFile(url, { format: 'module' })

  const module = state.modules.get('partial')
  t.assert.ok(module, 'version-less workspace bucket must be present')
  t.assert.equal(module.name, 'partial')
  t.assert.equal(module.version, undefined)
  t.assert.equal(module.ecosystem, undefined)
  t.assert.ok(module.files['file.js'])
  t.assert.ok(!state.modules.has('.'), 'must not fall through to the project root bucket')
})

test('addFile rejects a workspace package.json with non-type keys but no name', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'unnamed', 'file.js')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'module' }))
})

test('addFile still requires a version for a node_modules package', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'noversion', 'index.js')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'commonjs' }), /Missing version/)
})

test('addFile infers .js format from the closest package.json type when format is omitted', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'lib', 'util.js')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('node_modules/widget/lib/util.js'), 'module')
})

test('addFile infers module for a .js file directly under the project root (type=module)', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'root-file.js')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('root-file.js'), 'module')
})

test('addFile infers json for a .json file under a type=module package.json', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'root-data.json')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('root-data.json'), 'json')
})

test('addFile infers commonjs for a .cjs file under a type=module package.json', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'lib', 'legacy.cjs')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('node_modules/widget/lib/legacy.cjs'), 'commonjs')
})

test('addFile rejects an explicit format=commonjs for a .mjs file', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'script.mjs')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'commonjs' }))
})

test('addFile tags a UTF-8 resource as plain "resource" (no base64)', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'asset.bin')).toString() // ASCII text
  state.addFile(url, { resource: true })
  t.assert.equal(state.formats.get('sub/asset.bin'), 'resource')
})

test('addFile tags a binary resource as "resource:base64"', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'blob.bin')).toString() // non-UTF-8 bytes
  state.addFile(url, { resource: true })
  t.assert.equal(state.formats.get('sub/blob.bin'), 'resource:base64')
})

test('legacy isBinary:true is still accepted as a resource alias', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'blob.bin')).toString()
  state.addFile(url, { isBinary: true })
  t.assert.equal(state.formats.get('sub/blob.bin'), 'resource:base64')
})

test('addFile rejects a caller-provided format that conflicts with the content-derived resource format', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'asset.bin')).toString()
  // Resource formats are content-derived ('resource' / 'resource:base64'); a custom
  // loader format like 'wasm' can't override that.
  t.assert.throws(() => state.addFile(url, { resource: true, format: 'wasm' }), /resource format mismatch/)
})

test('addFile defaults .js format to commonjs when the closest package.json omits type', (t) => {
  const state = new State(root)
  // node_modules/widget/package.json has no `type` field, so its .js files
  // default to commonjs even though the project root is type=module.
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'index.js')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('node_modules/widget/index.js'), 'commonjs')
})

test('addFile keeps a module format already recorded this session for a later no-format .js capture', (t) => {
  const state = new State(root)
  // widget/package.json omits `type`, so a bare no-format .js capture defaults
  // to commonjs (the test above). But the runtime loader records Node's
  // authoritative module-syntax choice first; a later no-format bundler-plugin
  // capture (StasisWebpack/StasisEsbuild/StasisMetro afterResolve pass no
  // format) of the SAME file must KEEP that `module`, not downgrade it to the
  // legacy commonjs default (which would also collide at the formats noupsert).
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'index.js')).toString()
  state.addFile(url, { format: 'module' }) // loader observed ESM
  t.assert.doesNotThrow(() => state.addFile(url)) // no-format bundler capture
  t.assert.equal(state.formats.get('node_modules/widget/index.js'), 'module')
})

test('addFile refuses to record a code file as a resource (resources never admits a code extension)', (t) => {
  const state = new State(root)
  // A code extension is never an asset payload: parseResourcesOption refuses to let
  // one into a `resources` allowlist, so resource:true for a `.js` can only be a
  // capture path that bypassed that gate -- exactly how an fs-read once tagged a
  // code file 'resource' and desynced the lockfile (resource) from the bundle
  // (code). Caught at the recording site, not as an opaque format mismatch at load.
  const url = pathToFileURL(join(root, 'node_modules', 'widget', 'index.js')).toString()
  t.assert.throws(() => state.addFile(url, { resource: true }), /code file can't be recorded as a resource/)
})

test('addFile rejects an explicit format that disagrees with the inferred one', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'foo.cjs')).toString()
  t.assert.throws(() => state.addFile(url, { format: 'module' }))
})

test('addFile infers json for .json files regardless of closest type', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'data.json')).toString()
  state.addFile(url, { isBinary: false })
  t.assert.equal(state.formats.get('sub/data.json'), 'json')
})

test('addFile infers module for .mjs regardless of closest type', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'sub', 'script.mjs')).toString()
  state.addFile(url)
  t.assert.equal(state.formats.get('sub/script.mjs'), 'module')
})

test('addFile rejects a package.json type other than module/commonjs', (t) => {
  const state = new State(root)
  const url = pathToFileURL(join(root, 'invalid-type', 'file.js')).toString()
  t.assert.throws(() => state.addFile(url))
})

test('getFile round-trips a resource: text stays raw, binary stays base64, both decode back', (t) => {
  // State stores 'resource' as raw UTF-8 (asset.bin is ASCII) and 'resource:base64'
  // as base64 (blob.bin is non-UTF-8). getFile must return the original bytes in
  // both cases -- the very contract `stasis run --bundle=load` (via state.getFile)
  // relies on when serving a file from the bundle to Node, and the contract
  // `extract` (also via the lockfile-byte hash) needs to keep its derived
  // lockfile consistent with what `stasis run` would have recorded.
  //
  // The shared fixture's stasis.config.json sets bundle=none, but `getFile` only
  // makes sense when the bundle is materialized -- enable it via the constructor.
  // bundle=add + lock=add satisfies Config's invariants without writing anything
  // (no .write() is called).
  const state = new State(root, { lock: 'add', bundle: 'add' })
  const textUrl = pathToFileURL(join(root, 'sub', 'asset.bin')).toString()
  const binUrl = pathToFileURL(join(root, 'sub', 'blob.bin')).toString()
  state.addFile(textUrl, { resource: true })
  state.addFile(binUrl, { resource: true })

  // State's per-format split is the same one bundle=load would do on a parsed bundle.
  const text = state.getFile(textUrl)
  t.assert.equal(text.format, 'resource')
  t.assert.equal(typeof text.source, 'string', 'resource (UTF-8) decodes back to a raw string')

  const bin = state.getFile(binUrl)
  t.assert.equal(bin.format, 'resource:base64')
  t.assert.ok(Buffer.isBuffer(bin.source), 'resource:base64 decodes back to a Buffer')
  // Re-hash must match the lockfile-side digest (sha512 of the raw bytes), which is
  // what state.hashes recorded at addFile. That's the round-trip the extract command
  // and the loader's load-mode hash check both rely on.
  t.assert.ok(state.hashes.get('sub/blob.bin').startsWith('sha512-'))
})
