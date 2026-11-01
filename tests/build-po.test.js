// `stasis build --po`: each gettext .po file the build reaches built into the module @exodus/i18n builds
// of it, with the project's own @exodus/i18n-babel-webpack transform, from the bytes the artifact
// carries. That covers a .po an import reaches (what the webpack loader builds) and a .po the artifact
// records no import of (a --metro bundle's, a webpack capture's), read by its path from the file
// requiring it (what plugin-inline-po inlines).
import { describe, test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { brotliCompressSync } from 'node:zlib'

import { loadPoTransform, resolvePoTransform } from '../stasis/src/po.js'
import { withTmp } from './tmp.helper.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const webpackHelper = join(here, 'webpack5-run.helper.js')

// drop inherited stasis env so the spawned CLI gets a clean slate per test
const {
  EXODUS_STASIS_LOCK: _l,
  EXODUS_STASIS_SCOPE: _s,
  EXODUS_STASIS_BUNDLE: _b,
  EXODUS_STASIS_BUNDLE_FILE: _bf,
  EXODUS_STASIS_DEBUG: _d,
  EXODUS_STASIS_SHARD_SIGNAL_FLUSH: _ssf,
  ...cleanEnv
} = process.env

const runCli = async (args, { cwd } = {}) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, env: cleanEnv })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', (d) => stdoutChunks.push(d))
  child.stderr.on('data', (d) => stderrChunks.push(d))
  const [status] = await once(child, 'close')
  return {
    status,
    stdout: stripVTControlCharacters(Buffer.concat(stdoutChunks).toString('utf-8')),
    stderr: stripVTControlCharacters(Buffer.concat(stderrChunks).toString('utf-8')),
  }
}

const runNode = (t, file) => {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf-8' })
  t.assert.equal(r.status, 0, `running ${file} failed: ${r.stderr}`)
  return r.stdout
}

const write = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
}

// A stand-in for @exodus/i18n-babel-webpack's babel/transform.js, as its webpack loader calls it: the
// catalog module of a .po, each msgid's msgstr as one text token, tagged with `tag` so a test can tell
// which copy built it. One whose msgstr is "throw" fails, as pofile fails on a file it can't parse.
const transformSource = (tag, { esm = false } = {}) => [
  `${esm ? 'export default' : 'module.exports ='} (content) => {`,
  '  const catalog = {}',
  '  for (const [, id, value] of content.matchAll(/^msgid "(.*)"\\nmsgstr "(.*)"$/gmu)) {',
  "    if (value === 'throw') throw new TypeError('pofile: wrapped strings are not supported (\"msgstr\")')",
  `    if (id) catalog[id] = [{ type: 'text', value: value + ${JSON.stringify(tag)} }]`,
  '  }',
  "  return 'module.exports=' + JSON.stringify(catalog)",
  '}',
  '',
].join('\n')

const transformPackage = (prefix, { name = '@exodus/i18n-babel-webpack', version = '1.1.5', tag = '', esm = false } = {}) => ({
  [`${prefix}/package.json`]: JSON.stringify({ name, version, type: esm ? 'module' : 'commonjs' }),
  [`${prefix}/babel/transform.js`]: transformSource(tag, { esm }),
})

const po = (pairs) => Object.entries(pairs).map(([id, value]) => `msgid "${id}"\nmsgstr "${value}"\n`).join('\n')

// An app importing two catalogs, one each way @exodus/i18n's README and plugin-inline-po import one,
// with @exodus/i18n-babel-webpack installed.
function poProject(dir, { index, transform = true } = {}) {
  write(dir, {
    'package.json': JSON.stringify({ name: 'po-app', version: '0.0.0', private: true }),
    'index.js': index ?? [
      "import en from './locales/en.po'",
      "const de = require('./locales/de.po')",
      'console.log(JSON.stringify({ en, de }))',
      '',
    ].join('\n'),
    'locales/en.po': po({ Hello: 'Hello' }),
    'locales/de.po': po({ Hello: 'Hallo', Bye: 'Tschüss' }),
    ...(transform ? transformPackage('node_modules/@exodus/i18n-babel-webpack') : {}),
  })
}

const CATALOGS = {
  en: { Hello: [{ type: 'text', value: 'Hello' }] },
  de: { Hello: [{ type: 'text', value: 'Hallo' }], Bye: [{ type: 'text', value: 'Tschüss' }] },
}

// --platform=hermes resolves Babel from the project: link the workspace's own copies in.
const rootModules = join(here, '..', 'node_modules')
const linkBabel = (dir) => {
  mkdirSync(join(dir, 'node_modules', '@babel'), { recursive: true })
  for (const name of ['core', 'plugin-transform-block-scoping', 'plugin-transform-classes']) {
    symlinkSync(realpathSync(join(rootModules, '@babel', name)), join(dir, 'node_modules', '@babel', name), 'dir')
  }
}

// A full-scope bundle of `files`, `index.js` its entry, recording no imports: as a --metro bundle
// carries a .po, a resource no import names.
const writeEdgelessBundle = (dir, files) => {
  const formats = Object.fromEntries(Object.keys(files).map((file) => [file, file.endsWith('.po') ? 'resource' : 'module']))
  const bundle = {
    version: 1,
    config: { scope: 'full' },
    entries: ['index.js'],
    sources: { '.': { name: 'po-app', version: '0.0.0', files } },
    modules: {},
    formats,
    imports: { '*': {} },
  }
  writeFileSync(join(dir, 'app.code.br'), brotliCompressSync(JSON.stringify(bundle)))
}

const CONCURRENCY = 4 // matches CI runner cores

describe('stasis build --po (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('--po builds each .po an import reaches, as the webpack loader builds it, from the bytes the artifact carries', withTmp(async (t, tmp) => {
    poProject(tmp)
    const bundled = await runCli(['bundle', '--resources=po', '--output=app.code.br', 'index.js'], { cwd: tmp })
    t.assert.equal(bundled.status, 0, bundled.stderr)
    // The .po on disk changed since: the build reads the artifact's.
    write(tmp, { 'locales/de.po': po({ Hello: 'changed on disk' }) })

    const none = await runCli(['build', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(none.status, 0)
    t.assert.match(none.stderr, /No loader is configured for "\.po" files: locales\/(?:en|de)\.po/u)
    t.assert.match(none.stderr, /Build a "\.po" file with --po, as @exodus\/i18n builds it/u)
    t.assert.ok(!existsSync(join(tmp, 'out.cjs')))

    const r = await runCli(['build', '--format=cjs', '--po', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /Built 2 \.po files with @exodus\/i18n-babel-webpack@1\.1\.5/u)
    // `import en` binds module.exports, as webpack binds a CommonJS module's default; `require` returns it.
    t.assert.deepStrictEqual(JSON.parse(runNode(t, join(tmp, 'out.cjs'))), CATALOGS)
  }))

  test('--metro --po builds a .po the bundle records no import of, read by its path from the requiring file, as plugin-inline-po reads it', withTmp(async (t, tmp) => {
    poProject(tmp, { index: "const { en, de } = require('./src/i18n.js')\nconsole.log(JSON.stringify({ en, de }))\n" })
    // A template literal with no substitutions is a path too, as plugin-inline-po reads one.
    write(tmp, { 'src/i18n.js': "exports.de = require('../locales/de.po')\nexports.en = require(`../locales/en.po`)\n" })
    linkBabel(tmp)
    const bundled = await runCli(['bundle', '--metro', '--platforms=ios,android', '--resources=po', '--output=app.code.br', 'index.js'], { cwd: tmp })
    t.assert.equal(bundled.status, 0, bundled.stderr)

    const none = await runCli(['build', '--format=cjs', '--metro=ios', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(none.status, 0)
    t.assert.match(none.stderr, /'\.\.\/locales\/de\.po' in src\/i18n\.js is a \.po file the artifact records no import of; build it with --po, which reads it by that path/u)
    t.assert.match(none.stderr, /src\/i18n\.js:1:\d+:/u, 'reported where the import is written')
    t.assert.ok(!existsSync(join(tmp, 'out.cjs')))

    const ios = await runCli(['build', '--format=cjs', '--po', '--metro=ios', '--output=ios.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(ios.status, 0, ios.stderr)
    t.assert.match(ios.stderr, /Built 2 \.po files with @exodus\/i18n-babel-webpack@1\.1\.5/u)
    t.assert.deepStrictEqual(JSON.parse(runNode(t, join(tmp, 'ios.cjs'))), CATALOGS)

    // Hermes: the catalog module is plain data, with nothing to downlevel.
    const hermes = await runCli(['build', '--platform=hermes', '--po', '--metro=android', '--output=android.js', 'app.code.br'], { cwd: tmp })
    t.assert.equal(hermes.status, 0, hermes.stderr)
    t.assert.deepStrictEqual(JSON.parse(runNode(t, join(tmp, 'android.js'))), CATALOGS)
  }))

  test('--po builds a webpack capture\'s .po, to which it records no edge, as the webpack loader built it', withTmp(async (t, tmp) => {
    poProject(tmp)
    // As @exodus/i18n-babel-webpack's webpack5-loader: the file read, through babel/transform.js.
    write(tmp, {
      'po-loader.cjs': [
        "const { readFileSync } = require('node:fs')",
        "const transform = require('@exodus/i18n-babel-webpack/babel/transform.js')",
        'module.exports = function () { return transform(readFileSync(this.resourcePath).toString()) }',
        '',
      ].join('\n'),
    })
    const child = spawn(process.execPath, [webpackHelper, 'index.js'], {
      cwd: tmp,
      env: {
        ...cleanEnv,
        STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify({ scope: 'full', lock: 'ignore', bundle: 'replace', bundleFile: 'app.code.br', resources: ['po'] }),
        STASIS_TEST_WEBPACK_RULES: JSON.stringify([{ test: '\\.po$', use: join(tmp, 'po-loader.cjs') }]),
        STASIS_TEST_WEBPACK_OUTDIR: join(tmp, 'dist'),
      },
    })
    const stderr = []
    child.stderr.on('data', (d) => stderr.push(d))
    const [status] = await once(child, 'close')
    t.assert.equal(status, 0, Buffer.concat(stderr).toString())
    const webpacked = runNode(t, join(tmp, 'dist', 'bundle.js'))

    const r = await runCli(['build', '--format=cjs', '--po', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.equal(runNode(t, join(tmp, 'out.cjs')), webpacked)
    t.assert.deepStrictEqual(JSON.parse(webpacked), CATALOGS)
  }))

  test('--po fails closed on a .po the artifact doesn\'t carry, on disk or not', withTmp(async (t, tmp) => {
    poProject(tmp)
    writeEdgelessBundle(tmp, {
      'index.js': "const de = require('./locales/de.po')\nconst fr = require('./locales/fr.po')\nconsole.log(de, fr)\n",
      'locales/de.po': po({ Hello: 'Hallo' }),
    })
    write(tmp, { 'locales/fr.po': po({ Hello: 'Bonjour' }) })
    const r = await runCli(['build', '--po', '--output=out.js', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--po: '\.\/locales\/fr\.po' in index\.js names locales\/fr\.po, which the artifact doesn't carry \(bundle with --resources=po\)/u)
    t.assert.ok(!existsSync(join(tmp, 'out.js')))
  }))

  test('--po reports a .po the project\'s transform can\'t compile', withTmp(async (t, tmp) => {
    poProject(tmp)
    writeEdgelessBundle(tmp, { 'index.js': "console.log(require('./bad.po'))\n", 'bad.po': po({ Hello: 'throw' }) })
    const r = await runCli(['build', '--po', '--output=out.js', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--po could not compile bad\.po with .*transform\.js: pofile: wrapped strings are not supported/u)
  }))

  test('--po needs the project\'s transform, checked before esbuild runs', withTmp(async (t, tmp) => {
    poProject(tmp, { transform: false })
    writeEdgelessBundle(tmp, { 'index.js': "console.log('no .po')\n" })
    const r = await runCli(['build', '--po', '--output=out.js', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--po builds each \.po with the project's @exodus\/i18n-babel-webpack \(or its @exodus\/i18n's\), which could not be resolved from /u)
    t.assert.match(r.stderr, /npm i -D @exodus\/i18n-babel-webpack/u)
  }))

  test('--po and --loader=.po:NAME don\'t combine', withTmp(async (t, tmp) => {
    const r = await runCli(['build', '--po', '--loader=.po:text', '--output=out.js', 'missing.code.br'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /--po and --loader=\.po:text don't combine/u)
  }))
})

describe('resolvePoTransform: the project\'s own transform', () => {
  test('its own @exodus/i18n-babel-webpack, ahead of its @exodus/i18n\'s', withTmp(async (t, tmp) => {
    write(tmp, {
      ...transformPackage('node_modules/@exodus/i18n-babel-webpack', { tag: ' (own)' }),
      'node_modules/@exodus/i18n/package.json': JSON.stringify({ name: '@exodus/i18n', version: '5.3.3', type: 'module' }),
      ...transformPackage('node_modules/@exodus/i18n/node_modules/@exodus/i18n-babel-webpack', { version: '1.1.4', tag: ' (i18n\'s)' }),
    })
    t.assert.equal(resolvePoTransform(tmp), realpathSync(join(tmp, 'node_modules/@exodus/i18n-babel-webpack/babel/transform.js')))
    const { name, transform } = await loadPoTransform(tmp)
    t.assert.equal(name, '@exodus/i18n-babel-webpack@1.1.5')
    t.assert.equal(transform(po({ A: 'a' })), 'module.exports={"A":[{"type":"text","value":"a (own)"}]}')
  }))

  test('else the one @exodus/i18n 5.x depends on', withTmp(async (t, tmp) => {
    write(tmp, {
      'node_modules/@exodus/i18n/package.json': JSON.stringify({ name: '@exodus/i18n', version: '5.3.3', type: 'module' }),
      ...transformPackage('node_modules/@exodus/i18n/node_modules/@exodus/i18n-babel-webpack', { version: '1.1.4' }),
    })
    const { name } = await loadPoTransform(tmp)
    t.assert.equal(name, '@exodus/i18n-babel-webpack@1.1.4')
  }))

  test('else @exodus/i18n 4.x\'s own babel/transform.js, an ES module', withTmp(async (t, tmp) => {
    write(tmp, transformPackage('node_modules/@exodus/i18n', { name: '@exodus/i18n', version: '4.0.1', tag: ' (4.x)', esm: true }))
    const { name, transform } = await loadPoTransform(tmp)
    t.assert.equal(name, '@exodus/i18n@4.0.1')
    t.assert.equal(transform(po({ A: 'a' })), 'module.exports={"A":[{"type":"text","value":"a (4.x)"}]}')
  }))

  test('else none', withTmp(async (t, tmp) => {
    write(tmp, { 'node_modules/@exodus/i18n/package.json': JSON.stringify({ name: '@exodus/i18n', version: '5.3.3' }) })
    t.assert.equal(resolvePoTransform(tmp), null)
    await t.assert.rejects(loadPoTransform(tmp), /could not be resolved from /u)
  }))
})
