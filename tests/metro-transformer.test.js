// End-to-end coverage for the StasisMetro worker transformer (the LOAD half).
//
// Metro isn't a dependency, and the transformer never imports it -- it implements the
// `transform(config, projectRoot, filename, data, options)` contract Metro's worker
// calls. So these tests spawn the transformer (cwd = a fixture project root) with a mock
// base transformer that echoes the bytes it received, and assert that load mode fed it
// the BUNDLE's attested bytes, fails closed on a missing in-scope file, and is a
// transparent pass-through otherwise. A bundle is produced first via the capture helper
// (the StasisMetro serializer path), so capture<->load round-trips through real artifacts.

import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const captureHelper = join(here, 'metro-run.helper.js')
const transformHelper = join(here, 'metro-transformer-run.helper.js')
const mockBase = join(here, 'metro-mock-transformer.cjs')
const fullFixture = join(here, 'fixtures', 'metro-full')
const nmFixture = join(here, 'fixtures', 'metro-nm')

const FULL_GRAPH = {
  modules: [
    { path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js']] },
    { path: 'src/hello.js', deps: [] },
  ],
}
const NM_GRAPH = {
  modules: [
    { path: 'src/entry.js', deps: [['fake-esm-pkg', 'node_modules/fake-esm-pkg/index.js'], ['./helper.js', 'src/helper.js']] },
    { path: 'src/helper.js', deps: [] },
    { path: 'node_modules/fake-esm-pkg/index.js', deps: [] },
  ],
}

// Strip ALL inherited stasis env by prefix so a developer's exported EXODUS_STASIS_*
// (lockFile, resourcesBundleFile, etc. -- not just the common five) can't leak into the
// spawned children and skew results.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('EXODUS_STASIS_') && !k.startsWith('STASIS_TEST_'))
)

// Capture a bundle via the StasisMetro serializer path (writes lockfile + bundle). The serializer
// asserts child-process capture is enabled (Metro transforms in workers), so set it here; the
// transform/load side below is unaffected (load mode captures nothing, so the assert is skipped).
const capture = (entry, { cwd, graph, env }) => {
  const r = spawnSync(process.execPath, [captureHelper, entry], {
    encoding: 'utf-8',
    cwd,
    env: { ...cleanEnv, EXODUS_STASIS_CHILD_PROCESS: '1', STASIS_TEST_METRO_GRAPH: JSON.stringify(graph), ...env },
  })
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

// Drive the transformer over one or more project-relative files.
const transform = (files, { cwd, env = {}, diskBytes }) => {
  const r = spawnSync(process.execPath, [transformHelper, ...files], {
    encoding: 'utf-8',
    cwd,
    env: {
      ...cleanEnv,
      EXODUS_STASIS_METRO_BASE_TRANSFORMER: mockBase,
      ...(diskBytes !== undefined ? { STASIS_TEST_DISK_BYTES: diskBytes } : {}),
      ...env,
    },
  })
  r.stdout = stripVTControlCharacters(r.stdout)
  r.stderr = stripVTControlCharacters(r.stderr)
  return r
}

const withTmp = (fn) => (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-metro-xf-'))
  try {
    return fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('load mode serves the bundle-attested bytes into the transform, ignoring disk', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundle = join(tmp, 'snapshot.br')
  const original = readFileSync(join(tmp, 'src', 'hello.js'), 'utf-8')

  const cap = capture('src/entry.js', {
    cwd: tmp,
    graph: FULL_GRAPH,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundle,
    },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  // Tamper the on-disk source AFTER capture. Load mode must serve the bundle's bytes
  // (verified against the lockfile) and never read this tampered disk content.
  writeFileSync(join(tmp, 'src', 'hello.js'), 'export const greet = () => `pwned`\n')

  const r = transform(['src/hello.js'], {
    cwd: tmp,
    diskBytes: 'TAMPERED ON DISK',
    env: {
      EXODUS_STASIS_BUNDLE: 'load', EXODUS_STASIS_BUNDLE_FILE: bundle,
      EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full',
    },
  })
  t.assert.equal(r.status, 0, `transform stderr: ${r.stderr}`)
  const [out] = JSON.parse(r.stdout)
  t.assert.equal(out.received, original, 'transformer was fed the bundle bytes')
  t.assert.notEqual(out.received, 'TAMPERED ON DISK')
}))

test('out-of-scope files pass their disk bytes through untouched (node_modules scope)', withTmp((t, tmp) => {
  cpSync(nmFixture, tmp, { recursive: true })
  const bundle = join(tmp, 'snapshot.br')
  const pkgIndex = readFileSync(join(tmp, 'node_modules', 'fake-esm-pkg', 'index.js'), 'utf-8')

  const cap = capture('src/entry.js', {
    cwd: tmp,
    graph: NM_GRAPH,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'node_modules',
      EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundle,
    },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  // src/entry.js is OUT of node_modules scope -> disk bytes pass through.
  // node_modules/fake-esm-pkg/index.js IS in scope -> served from the bundle.
  const r = transform(['src/entry.js', 'node_modules/fake-esm-pkg/index.js'], {
    cwd: tmp,
    diskBytes: 'APP-SOURCE-DISK-BYTES',
    env: {
      EXODUS_STASIS_BUNDLE: 'load', EXODUS_STASIS_BUNDLE_FILE: bundle,
      EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'node_modules',
    },
  })
  t.assert.equal(r.status, 0, `transform stderr: ${r.stderr}`)
  const out = JSON.parse(r.stdout)
  t.assert.equal(out[0].received, 'APP-SOURCE-DISK-BYTES', 'out-of-scope app source passes disk bytes through')
  t.assert.equal(out[1].received, pkgIndex, 'in-scope node_modules file is served from the bundle')
}))

test('an in-scope file missing from the bundle fails closed (no silent disk fallback)', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundle = join(tmp, 'snapshot.br')

  const cap = capture('src/entry.js', {
    cwd: tmp,
    graph: FULL_GRAPH,
    env: {
      EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full',
      EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundle,
    },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  // Drop src/hello.js from the bundle. lock=none so the bundle self-attests (no lockfile
  // cross-check pre-empts the getFile gate we want to exercise).
  const decoded = JSON.parse(brotliDecompressSync(readFileSync(bundle)))
  delete decoded.sources['.'].files['src/hello.js']
  writeFileSync(bundle, brotliCompressSync(JSON.stringify(decoded)))
  rmSync(join(tmp, 'stasis.lock.json'))

  const r = transform(['src/hello.js'], {
    cwd: tmp,
    env: {
      EXODUS_STASIS_BUNDLE: 'load', EXODUS_STASIS_BUNDLE_FILE: bundle,
      EXODUS_STASIS_LOCK: 'none', EXODUS_STASIS_SCOPE: 'full',
    },
  })
  t.assert.notEqual(r.status, 0, 'a missing in-scope file must fail, not fall back to disk')
  t.assert.match(r.stderr, /not attested in bundle|hello\.js/)
}))

test('transformer is a transparent pass-through when not in load mode', withTmp((t, tmp) => {
  // Committed fixture has scope=full config + a lockfile but bundle=none -> not load mode,
  // so the transformer must hand the base transformer exactly the disk bytes it was given.
  cpSync(fullFixture, tmp, { recursive: true })

  const r = transform(['src/hello.js'], {
    cwd: tmp,
    diskBytes: 'PLAIN DISK BYTES',
    env: {}, // no EXODUS_STASIS_BUNDLE=load
  })
  t.assert.equal(r.status, 0, `transform stderr: ${r.stderr}`)
  const [out] = JSON.parse(r.stdout)
  t.assert.equal(out.received, 'PLAIN DISK BYTES', 'non-load mode passes disk bytes through unchanged')
}))

test('getCacheKey folds in the base transformer key and a load-mode discriminator', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  const bundle = join(tmp, 'snapshot.br')
  // Produce a bundle (+ idempotent lockfile) so a real load State can be constructed.
  const cap = capture('src/entry.js', {
    cwd: tmp,
    graph: FULL_GRAPH,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: bundle },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)

  // off: nothing load-related configured -> 'off' marker, base key still wrapped.
  const off = transform(['--cache-key'], { cwd: tmp, env: {} })
  t.assert.equal(off.status, 0, `stderr: ${off.stderr}`)
  t.assert.match(off.stdout, /mock-base-cache-key/, 'wraps the base transformer cache key')

  // on: a VALID load config (frozen uses the committed lockfile; load reads the bundle).
  const on = transform(['--cache-key'], {
    cwd: tmp,
    env: { EXODUS_STASIS_BUNDLE: 'load', EXODUS_STASIS_BUNDLE_FILE: bundle, EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_SCOPE: 'full' },
  })
  t.assert.equal(on.status, 0, `stderr: ${on.stderr}`)
  t.assert.notEqual(on.stdout, off.stdout, 'load-mode cache key differs from the non-load key')
  t.assert.match(on.stdout, /load:/, 'load-mode marker present so disk-built results are not reused')
}))

test('getCacheKey: a stasis.config.json can not activate load, only pin the lockfile frozen beside it', withTmp((t, tmp) => {
  cpSync(fullFixture, tmp, { recursive: true })
  // Capture to the DEFAULT bundle path, which a load State discovers with no bundleFile set.
  const cap = capture('src/entry.js', {
    cwd: tmp,
    graph: FULL_GRAPH,
    env: { EXODUS_STASIS_LOCK: 'add', EXODUS_STASIS_SCOPE: 'full', EXODUS_STASIS_BUNDLE: 'add', EXODUS_STASIS_BUNDLE_FILE: join(tmp, 'stasis.code.br') },
  })
  t.assert.equal(cap.status, 0, `capture stderr: ${cap.stderr}`)
  // The bundle mode is explicit: a config that sets one is refused, never taken for load mode.
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full', lock: 'frozen', bundle: 'load' }))
  const refused = transform(['--cache-key'], { cwd: tmp, env: {} })
  t.assert.notEqual(refused.status, 0)
  t.assert.match(refused.stderr, /stasis\.config\.json: bundle can not be set here/)

  // Load given explicitly, beside the config's frozen pin.
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full', lock: 'frozen' }))
  const r = transform(['--cache-key'], { cwd: tmp, env: { EXODUS_STASIS_LOCK: 'frozen', EXODUS_STASIS_BUNDLE: 'load' } })
  t.assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  t.assert.match(r.stdout, /load:default/, 'load is keyed as load mode')
}))

// --- As written: the specifiers a Babel plugin rewrote, kept for the serializer -------------
//
// Driven through a stand-in for metro-transform-worker (metro-mock-worker.cjs), which hands the
// source to `babelTransformerPath` and collects dependencies from the AST it gets back, over the
// workspace's real @babel/core + babel-plugin-module-resolver (v3).

const mockWorker = join(here, 'metro-mock-worker.cjs')

// A project aliasing `#local` to ./src through module-resolver, its babel.config.js laid out as a
// React Native one is: a plugin erasing each Flow import of types alone during the traversal, as
// flow-strip-types does, and a preset lowering every other import to a require once the traversal
// is done (Program exit), as @babel/plugin-transform-modules-commonjs does in the RN preset -- so
// the import declarations are gone by the time Babel returns. The type imports are aliased to the
// file index.js requires by path, which they must not count as written through the alias.
// `lowerAmongPlugins` lists the lowering first among the config's own plugins instead, so that it
// runs before the stasis plugin Metro passes.
const babelAliasProject = (tmp, { lowerAmongPlugins = false } = {}) => {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'babel-alias', version: '0.0.0' }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(tmp, 'babel.config.js'), `const typesOnly = (node) =>
  node.importKind === 'type' || (node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.importKind === 'type'))
const stripTypes = () => ({
  visitor: {
    ImportDeclaration(path) {
      if (typesOnly(path.node)) path.remove()
    },
  },
})
const lower = ({ types: t }) => ({
  visitor: {
    Program: {
      exit(path) {
        for (const statement of path.get('body')) {
          if (!statement.isImportDeclaration()) continue
          statement.replaceWith(t.expressionStatement(t.callExpression(t.identifier('require'), [t.cloneNode(statement.node.source)])))
        }
      },
    },
  },
})
module.exports = ${lowerAmongPlugins ? `{
  parserOpts: { plugins: ['flow'] },
  plugins: [lower, ['module-resolver', { alias: { '#local': './src' } }], stripTypes],
}` : `{
  parserOpts: { plugins: ['flow'] },
  plugins: [['module-resolver', { alias: { '#local': './src' } }], stripTypes],
  presets: [() => ({ plugins: [lower] })],
}`}
`)
  writeFileSync(join(tmp, 'index.js'), [
    "import abc from '#local/abc'",
    "import same from './src/abc'",
    "import type { Def } from '#local/def'",
    "import { type Def2 } from '#local/def'",
    "const def = require('./src/def')",
    "const ghi = require('#local/ghi')",
    'export default [abc, same, def, ghi]',
    '',
  ].join('\n'))
  mkdirSync(join(tmp, 'src'))
  writeFileSync(join(tmp, 'src', 'abc.js'), 'export default 1\n')
  writeFileSync(join(tmp, 'src', 'def.js'), 'module.exports = 2\n')
  writeFileSync(join(tmp, 'src', 'ghi.js'), 'module.exports = 3\n')
  symlinkSync(join(here, '..', 'node_modules'), join(tmp, 'node_modules'), 'dir')
}

// Metro's transformer config as withStasis() hands it over: the project's transformer, and its
// Babel transformer, named relative to that (metro-transform-worker requires a name from its own dir).
const handedOver = { stasisBaseTransformerPath: mockWorker, babelTransformerPath: './metro-mock-babel-transformer.cjs' }
const stasisBabelTransformer = join(here, '..', 'stasis-plugins', 'src', 'metro-babel-transformer.js')

for (const [variant, { babelAsync = false, lowerAmongPlugins = false }] of [
  ['sync Babel transformer', {}],
  ['async Babel transformer', { babelAsync: true }],
  ['imports lowered by a plugin listed before it', { lowerAmongPlugins: true }],
]) {
  test(`a dependency Babel rewrote carries the specifiers written in the source (${variant})`, withTmp((t, tmp) => {
    babelAliasProject(tmp, { lowerAmongPlugins })
    const r = transform(['index.js'], {
      cwd: tmp,
      env: { STASIS_TEST_TRANSFORMER_CONFIG: JSON.stringify(handedOver), ...(babelAsync && { STASIS_TEST_BABEL_ASYNC: '1' }) },
    })
    t.assert.equal(r.status, 0, `transform stderr: ${r.stderr}`)
    const [out] = JSON.parse(r.stdout)
    // The project's transformer runs on its own config, the stasis Babel transformer standing in.
    t.assert.deepStrictEqual(out.config, { babelTransformerPath: stasisBabelTransformer })
    // Metro names each by the rewrite; './src/abc' stands for both the alias and the literal path,
    // './src/def' only for the path (the type imports are erased).
    t.assert.deepStrictEqual(out.dependencies, [
      { name: './src/abc', data: { key: './src/abc' }, stasisAsWritten: ['#local/abc', './src/abc'] },
      { name: './src/def', data: { key: './src/def' } },
      { name: './src/ghi', data: { key: './src/ghi' }, stasisAsWritten: ['#local/ghi'] },
    ])
  }))
}

test('a project transformer that is this one itself, wired by hand as well, gives way to Metro\'s default', withTmp((t, tmp) => {
  // withStasis() hands over the project's transformerPath, which a project that wired
  // @exodus/stasis/metro-transformer by hand points at this transformer: running it as its own
  // base would wrap the Babel transformer in itself, endlessly.
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'self-base', version: '0.0.0' }))
  writeFileSync(join(tmp, 'pnpm-workspace.yaml'), '')
  writeFileSync(join(tmp, 'babel.config.js'), 'module.exports = {}\n')
  writeFileSync(join(tmp, 'index.js'), "require('./a')\n")
  // Metro's default, as the project's own node_modules has it.
  mkdirSync(join(tmp, 'node_modules', 'metro-transform-worker'), { recursive: true })
  writeFileSync(join(tmp, 'node_modules', 'metro-transform-worker', 'index.js'), `module.exports = require(${JSON.stringify(mockWorker)})\n`)
  const config = {
    stasisBaseTransformerPath: join(here, '..', 'stasis', 'src', 'metro-transformer.js'),
    babelTransformerPath: join(here, 'metro-mock-babel-transformer.cjs'),
  }
  const r = transform(['index.js'], { cwd: tmp, env: { STASIS_TEST_TRANSFORMER_CONFIG: JSON.stringify(config) } })
  t.assert.equal(r.status, 0, `transform stderr: ${r.stderr}`)
  const [out] = JSON.parse(r.stdout)
  t.assert.deepStrictEqual(out.config, { babelTransformerPath: stasisBabelTransformer })
  t.assert.deepStrictEqual(out.dependencies, [{ name: './a', data: { key: './a' } }])
}))
