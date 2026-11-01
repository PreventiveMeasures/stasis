// `stasis build --metro=PLATFORM`: a --metro bundle built for one platform as Metro builds it -- each
// per-platform edge's target for PLATFORM, and each asset as the module Metro builds of it
// (`module.exports = require('react-native/Libraries/Image/AssetRegistry').registerAsset({...})`),
// its files copied out with --assets-dest as `react-native bundle --assets-dest` copies them.
import { after, before, describe, test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { ASSET_REGISTRY, assetRegistryResolver } from '../stasis/src/metro-assets.js'
import { withTmp } from './tmp.helper.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')

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

// A PNG's signature and IHDR, all Metro reads of one.
const png = (width, height) => {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4)
  ihdr.writeUInt32BE(width, 8)
  ihdr.writeUInt32BE(height, 12)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr])
}
const md5 = (...contents) => {
  const hasher = createHash('md5')
  for (const content of contents) hasher.update(content)
  return hasher.digest('hex')
}

// --- the asset registry ----------------------------------------------------------------------
//
// How Metro reads an asset (its files, sizes and hash), the module it builds of one and where
// --assets-dest copies its files are @preventive/rn's, tested there; the CLI tests below build them.

test('assetRegistryResolver resolves the registry from the asset, among the files the artifact carries', (t) => {
  const resolveFrom = (rel, platform, ...carried) => assetRegistryResolver(platform, new Set(carried))(rel)
  const hoisted = 'node_modules/react-native/Libraries/Image/AssetRegistry.js'
  t.assert.equal(resolveFrom('img/logo.png', 'ios', hoisted), hoisted)
  // The nearest node_modules up from the asset wins.
  const nested = 'packages/app/node_modules/react-native/Libraries/Image/AssetRegistry.js'
  t.assert.equal(resolveFrom('packages/app/img/logo.png', 'ios', hoisted, nested), nested)
  t.assert.equal(resolveFrom('img/logo.png', 'ios', hoisted, nested), hoisted)
  // The platform's file, then .native, then the plain one.
  const ios = 'node_modules/react-native/Libraries/Image/AssetRegistry.ios.js'
  t.assert.equal(resolveFrom('img/logo.png', 'ios', hoisted, ios), ios)
  t.assert.equal(resolveFrom('img/logo.png', 'android', hoisted, ios), hoisted)
  // pnpm: the only copy, linked in from node_modules/.pnpm.
  const pnpm = 'node_modules/.pnpm/react-native@0.81.0/node_modules/react-native/Libraries/Image/AssetRegistry.js'
  t.assert.equal(resolveFrom('img/logo.png', 'ios', pnpm), pnpm)
  t.assert.throws(() => resolveFrom('img/logo.png', 'ios', 'index.js'), new RegExp(`requiring ${ASSET_REGISTRY}, which the artifact doesn't carry`, 'u'))
  const other = 'node_modules/.pnpm/react-native@0.80.0/node_modules/react-native/Libraries/Image/AssetRegistry.js'
  t.assert.throws(() => resolveFrom('img/logo.png', 'ios', pnpm, other), /several .* none of them nearest/u)
})

// --- stasis build --metro on a `stasis bundle --metro` bundle ---------------------------------

// A React Native app: JSX in .js, a logo at three scales, an icon with an Android variant, a font, a
// module with .ios/.android files, and React Native's asset registry (0.81's shape) installed.
function rnProject(dir, { registry = true, index } = {}) {
  const files = {
    'package.json': JSON.stringify({ name: 'rn-app', version: '0.0.0', private: true }),
    'index.js': index ?? [
      "import { getAssetByID } from 'react-native/Libraries/Image/AssetRegistry'",
      "import { where } from './lib/where'",
      "import font from './fonts/Inter.ttf'",
      '/** @jsx h */',
      'const h = (type, props) => props.source',
      "const Image = 'Image'",
      "const logo = <Image source={require('./img/logo.png')} />",
      "const icon = require('./img/icon.png')",
      'console.log(JSON.stringify({ where, logo, icon, font, assets: [logo, icon, font].map(getAssetByID) }))',
      '',
    ].join('\n'),
    'lib/where.ios.js': "export const where = 'ios'\n",
    'lib/where.android.js': "export const where = 'android'\n",
    'img/logo.png': png(20, 10),
    'img/logo@2x.png': png(40, 20),
    'img/logo@3x.png': png(60, 30),
    'img/icon.png': png(8, 8),
    'img/icon.android.png': png(9, 9),
    'fonts/Inter.ttf': 'font bytes',
  }
  if (registry) {
    Object.assign(files, {
      'node_modules/react-native/package.json': JSON.stringify({ name: 'react-native', version: '0.81.0' }),
      'node_modules/react-native/Libraries/Image/AssetRegistry.js': "export { registerAsset, getAssetByID } from '@react-native/assets-registry/registry'\n",
      'node_modules/@react-native/assets-registry/package.json': JSON.stringify({ name: '@react-native/assets-registry', version: '0.81.0' }),
      'node_modules/@react-native/assets-registry/registry.js': [
        "'use strict'",
        'const assets = []',
        'function registerAsset(asset) { return assets.push(asset) }',
        'function getAssetByID(assetId) { return assets[assetId - 1] }',
        'module.exports = { registerAsset, getAssetByID }',
        '',
      ].join('\n'),
    })
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return files
}

const bundleRn = (tmp) => runCli(['bundle', '--metro', '--platforms=ios,android', '--jsx', '--resources=png,ttf', '--output=app.code.br', 'index.js'], { cwd: tmp })
const listFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((ent) => ent.isFile())
  .map((ent) => relative(dir, join(ent.parentPath, ent.name)).split('\\').join('/'))
  .toSorted()

// --platform=hermes resolves Babel from the project: link the workspace's own copies in.
const rootModules = join(here, '..', 'node_modules')
const linkBabel = (dir) => {
  mkdirSync(join(dir, 'node_modules', '@babel'), { recursive: true })
  for (const name of ['core', 'plugin-transform-block-scoping', 'plugin-transform-classes']) {
    symlinkSync(realpathSync(join(rootModules, '@babel', name)), join(dir, 'node_modules', '@babel', name), 'dir')
  }
}

const CONCURRENCY = 4 // matches CI runner cores

describe('stasis build --metro (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  // One app, bundled once, for the tests that build it unchanged: each writes outputs of its own.
  let app
  let files
  before(async () => {
    app = mkdtempSync(join(tmpdir(), 'stasis-test-'))
    files = rnProject(app)
    linkBabel(app)
    const bundled = await bundleRn(app)
    if (bundled.status !== 0) throw new Error(bundled.stderr)
  })
  after(() => rmSync(app, { recursive: true, force: true }))

  test('--metro=ios builds each asset as Metro\'s module and copies its files as iOS lays them out', async (t) => {
    const r = await runCli(['build', '--format=cjs', '--loader=.js:jsx', '--metro=ios', '--assets-dest=dist', '--output=ios.cjs', 'app.code.br'], { cwd: app })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /Copied 3 assets \(5 files\) for ios to dist/u)
    const out = JSON.parse(runNode(t, join(app, 'ios.cjs')))
    // Each require() is the asset's registry id; the registry holds Metro's descriptor of it.
    t.assert.equal(out.where, 'ios')
    t.assert.deepStrictEqual([out.logo, out.icon, out.font].toSorted(), [1, 2, 3])
    const byName = Object.fromEntries(out.assets.map((asset) => [asset.name, asset]))
    t.assert.deepStrictEqual(byName.logo, {
      __packager_asset: true,
      httpServerLocation: '/assets/img',
      width: 20,
      height: 10,
      scales: [1, 2, 3],
      hash: md5(files['img/logo.png'], files['img/logo@2x.png'], files['img/logo@3x.png']),
      name: 'logo',
      type: 'png',
    })
    // iOS has no icon of its own: the generic one.
    t.assert.deepStrictEqual([byName.icon.width, byName.icon.hash], [8, md5(files['img/icon.png'])])
    t.assert.deepStrictEqual(byName.Inter, { __packager_asset: true, httpServerLocation: '/assets/fonts', scales: [1], hash: md5(files['fonts/Inter.ttf']), name: 'Inter', type: 'ttf' })

    t.assert.deepStrictEqual(listFiles(join(app, 'dist')), [
      'assets/fonts/Inter.ttf', 'assets/img/icon.png', 'assets/img/logo.png', 'assets/img/logo@2x.png', 'assets/img/logo@3x.png',
    ])
    t.assert.deepStrictEqual(readFileSync(join(app, 'dist', 'assets', 'img', 'logo@3x.png')), files['img/logo@3x.png'])
  })

  test('--metro=android takes Android\'s edges and asset files and copies them into res/ folders', async (t) => {
    const r = await runCli(['build', '--format=cjs', '--loader=.js:jsx', '--metro=android', '--assets-dest=res', '--output=android.cjs', 'app.code.br'], { cwd: app })
    t.assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(runNode(t, join(app, 'android.cjs')))
    t.assert.equal(out.where, 'android')
    const icon = out.assets.find((asset) => asset.name === 'icon')
    t.assert.deepStrictEqual([icon.width, icon.hash], [9, md5(files['img/icon.android.png'])], 'the icon\'s Android file')
    t.assert.deepStrictEqual(listFiles(join(app, 'res')), [
      'drawable-mdpi/img_icon.png', 'drawable-mdpi/img_logo.png', 'drawable-xhdpi/img_logo.png', 'drawable-xxhdpi/img_logo.png', 'raw/fonts_inter.ttf', 'raw/keep.xml',
    ])
    t.assert.deepStrictEqual(readFileSync(join(app, 'res', 'drawable-mdpi', 'img_icon.png')), files['img/icon.android.png'])
    t.assert.equal(
      readFileSync(join(app, 'res', 'raw', 'keep.xml'), 'utf8'),
      '<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="@raw/fonts_inter,@drawable/img_icon,@drawable/img_logo" />\n'
    )
  })

  test('--platform=hermes --metro builds a Hermes bundle whose asset modules need no downleveling', async (t) => {
    const r = await runCli(['build', '--platform=hermes', '--loader=.js:jsx', '--metro=ios', '--output=hermes.js', 'app.code.br'], { cwd: app })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /Built 3 assets for ios; pass --assets-dest to copy their files out/u)
    const code = readFileSync(join(app, 'hermes.js'), 'utf8')
    t.assert.match(code, /registerAsset\(\{ "__packager_asset": true, "httpServerLocation": "\/assets\/img"/u)
    t.assert.doesNotMatch(code, /\b(?:let|const|class)\s/u)
    t.assert.equal(JSON.parse(runNode(t, join(app, 'hermes.js'))).where, 'ios')
  })

  test('a --metro bundle without --metro: a platform-specific edge and an asset fail with what builds them', async (t) => {
    const split = await runCli(['build', '--loader=.js:jsx', '--output=split.js', 'app.code.br'], { cwd: app })
    t.assert.notEqual(split.status, 0)
    t.assert.match(split.stderr, /Resolution of '\.\/lib\/where' from index\.js is platform-specific/u)
    t.assert.match(split.stderr, /pass --metro=PLATFORM \(e\.g\. --metro=ios\)/u)

    // A platform the bundle wasn't made for.
    const web = await runCli(['build', '--loader=.js:jsx', '--metro=web', '--output=web.js', 'app.code.br'], { cwd: app })
    t.assert.notEqual(web.status, 0)
    t.assert.match(web.stderr, /records no 'web' target \(only android, ios\)/u)
    t.assert.ok(!existsSync(join(app, 'split.js')) && !existsSync(join(app, 'web.js')))
  })

  test('an asset builds with --loader, as esbuild loads it, and without one fails in esbuild\'s words', withTmp(async (t, tmp) => {
    rnProject(tmp, { index: "import logo from './img/logo.png'\nconsole.log(logo)\n" })
    const bundled = await bundleRn(tmp)
    t.assert.equal(bundled.status, 0, bundled.stderr)

    const none = await runCli(['build', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(none.status, 0)
    t.assert.match(none.stderr, /No loader is configured for "\.png" files: img\/logo\.png/u)
    t.assert.match(none.stderr, /--loader=\.png:NAME .*or with --metro=PLATFORM/u)

    const dataurl = await runCli(['build', '--format=cjs', '--loader=.png:dataurl', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(dataurl.status, 0, dataurl.stderr)
    t.assert.equal(runNode(t, join(tmp, 'out.cjs')).trim(), `data:image/png;base64,${png(20, 10).toString('base64')}`)
    // --loader names the extension: it wins over --metro's asset module.
    const both = await runCli(['build', '--format=cjs', '--loader=.png:dataurl', '--metro=ios', '--output=both.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(both.status, 0, both.stderr)
    t.assert.match(runNode(t, join(tmp, 'both.cjs')), /^data:image\/png;base64,/u)
  }))

  test('--metro builds as Metro\'s release build: JSX in .js, Flow stripped from a file marked @flow, __DEV__ and NODE_ENV defined', withTmp(async (t, tmp) => {
    rnProject(tmp, {
      index: [
        '// @flow',
        "import { where } from './lib/where'",
        '/** @jsx h */',
        'const h = (type: string): string => type',
        "const View = 'View'",
        'console.log(JSON.stringify({ where, dev: __DEV__, env: process.env.NODE_ENV, el: <View /> }))',
        '',
      ].join('\n'),
    })
    // Neither --jsx nor --flow: --metro turns both on.
    const bundled = await runCli(['bundle', '--metro', '--platforms=ios,android', '--output=app.code.br', 'index.js'], { cwd: tmp })
    t.assert.equal(bundled.status, 0, bundled.stderr)

    // Nor --loader=.js:jsx, --flow or a --define.
    const r = await runCli(['build', '--format=cjs', '--metro=ios', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.deepStrictEqual(JSON.parse(runNode(t, join(tmp, 'out.cjs'))), { where: 'ios', dev: false, env: 'production', el: 'View' })

    // A --define takes the place of the default for its name alone.
    const dev = await runCli(['build', '--format=cjs', '--metro=android', '--define=__DEV__=true', '--output=dev.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(dev.status, 0, dev.stderr)
    t.assert.deepStrictEqual(JSON.parse(runNode(t, join(tmp, 'dev.cjs'))), { where: 'android', dev: true, env: 'production', el: 'View' })

    // Without --metro, none of it: esbuild can't parse the Flow, before it gets to the per-platform edge.
    const plain = await runCli(['build', '--format=cjs', '--output=plain.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(plain.status, 0)
    t.assert.match(plain.stderr, /Expected "\)" but found ":"\n\n {4}index\.js:4:/u)
  }))

  test('--metro fails closed where the bundle carries no asset registry', withTmp(async (t, tmp) => {
    rnProject(tmp, { registry: false, index: "console.log(require('./img/logo.png'))\n" })
    const bundled = await bundleRn(tmp)
    t.assert.equal(bundled.status, 0, bundled.stderr)
    const r = await runCli(['build', '--format=cjs', '--metro=ios', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /requiring react-native\/Libraries\/Image\/AssetRegistry, which the artifact doesn't carry/u)
  }))

  test('--assets-dest refuses to overwrite a file the artifact carries, before writing anything', withTmp(async (t, tmp) => {
    // The app imports a file at the very place --assets-dest=res would copy the logo to.
    rnProject(tmp, { index: "require('./img/logo.png')\nrequire('./res/drawable-mdpi/img_logo.png')\n" })
    mkdirSync(join(tmp, 'res', 'drawable-mdpi'), { recursive: true })
    writeFileSync(join(tmp, 'res', 'drawable-mdpi', 'img_logo.png'), png(1, 1))
    const bundled = await bundleRn(tmp)
    t.assert.equal(bundled.status, 0, bundled.stderr)
    const r = await runCli(['build', '--format=cjs', '--metro=android', '--assets-dest=res', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(r.status, 0)
    t.assert.match(r.stderr, /refusing to write 'res\/drawable-mdpi\/img_logo\.png' -- it is a source the artifact records/u)
    t.assert.ok(!existsSync(join(tmp, 'out.cjs')), 'nothing written')
    t.assert.deepStrictEqual(readFileSync(join(tmp, 'res', 'drawable-mdpi', 'img_logo.png')), png(1, 1))
  }))

  test('--assets-dest needs --metro, given or the artifact\'s stasis.config.json\'s; --metro takes one platform', async (t) => {
    // The shared app's bundle carries no stasis.config.json, so nothing sets --metro.
    const noMetro = await runCli(['build', '--loader=.js:jsx', '--assets-dest=dist', '--output=nometro.js', 'app.code.br'], { cwd: app })
    t.assert.notEqual(noMetro.status, 0)
    t.assert.match(noMetro.stderr, /--assets-dest copies the assets --metro builds; pass --metro=PLATFORM with it/u)
    const two = await runCli(['build', '--metro=ios,android', '--output=out.js', 'missing.code.br'], { cwd: tmpdir() })
    t.assert.notEqual(two.status, 0)
    t.assert.match(two.stderr, /--metro takes one platform to build for/u)
  })
})

// --- the entry's options in the stasis.config.json the artifact carries ------------------------

// An app whose stasis.config.json bundles index.js with `options` and names itself in `extra`, so
// the bundle carries it; bundled with no flags, by its entries.
async function configuredApp(t, dir, options, index) {
  rnProject(dir, {
    index: index ?? [
      "import { where } from './lib/where'",
      '/** @jsx h */',
      'const h = (type) => type',
      "const View = 'View'",
      "console.log(JSON.stringify({ where, dev: typeof __DEV__ === 'undefined' ? 'unset' : __DEV__, el: <View /> }))",
      '',
    ].join('\n'),
  })
  writeFileSync(join(dir, 'stasis.config.json'), JSON.stringify({ extra: [], entries: { 'index.js': options } }))
  const bundled = await runCli(['bundle', '--output=app.code.br'], { cwd: dir })
  t.assert.equal(bundled.status, 0, bundled.stderr)
}

describe('stasis build takes the entry\'s options from the artifact\'s stasis.config.json (spawned, concurrent)', { concurrency: CONCURRENCY }, () => {
  test('jsx, define and metro with one platform become --loader=.js:jsx, --define and --metro, under the flags given', withTmp(async (t, tmp) => {
    await configuredApp(t, tmp, { metro: true, platforms: ['ios'], jsx: true, define: ['__DEV__=false'] })

    const r = await runCli(['build', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /index\.js: --loader=\.js:jsx --define=__DEV__=false --metro=ios, as stasis\.config\.json's entries "index\.js" sets/u)
    t.assert.deepStrictEqual(JSON.parse(runNode(t, join(tmp, 'out.cjs'))), { where: 'ios', dev: false, el: 'View' })

    // --define takes precedence over the config's.
    const own = await runCli(['build', '--format=cjs', '--define=__DEV__=true', '--output=own.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(own.status, 0, own.stderr)
    t.assert.match(own.stderr, /index\.js: --loader=\.js:jsx --metro=ios, as/u)
    t.assert.equal(JSON.parse(runNode(t, join(tmp, 'own.cjs'))).dev, true)
  }))

  test('metro alone builds as --metro does: JSX in .js and Metro\'s release defines, with no jsx or define set', withTmp(async (t, tmp) => {
    await configuredApp(t, tmp, { metro: true, platforms: ['ios'] })
    const r = await runCli(['build', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /index\.js: --metro=ios, as stasis\.config\.json's entries "index\.js" sets/u)
    t.assert.deepStrictEqual(JSON.parse(runNode(t, join(tmp, 'out.cjs'))), { where: 'ios', dev: false, el: 'View' })
  }))

  test('metro with several platforms needs --metro, one of them', withTmp(async (t, tmp) => {
    await configuredApp(t, tmp, { metro: true, platforms: ['ios', 'android'], jsx: true })

    const none = await runCli(['build', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(none.status, 0)
    t.assert.match(none.stderr, /stasis\.config\.json bundles index\.js for ios, android: pass --metro=ios or --metro=android/u)

    const android = await runCli(['build', '--format=cjs', '--metro=android', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(android.status, 0, android.stderr)
    t.assert.equal(JSON.parse(runNode(t, join(tmp, 'out.cjs'))).where, 'android')

    const web = await runCli(['build', '--format=cjs', '--metro=web', '--output=web.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.notEqual(web.status, 0)
    t.assert.match(web.stderr, /--metro=web, but stasis\.config\.json bundles index\.js for ios, android alone: pass --metro=ios or --metro=android/u)
  }))

  test('flow becomes --flow', withTmp(async (t, tmp) => {
    await configuredApp(t, tmp, { flow: true }, '// @flow\nconst n: number = 1\nconsole.log(String(n))\n')
    const r = await runCli(['build', '--format=cjs', '--output=out.cjs', 'app.code.br'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    t.assert.match(r.stderr, /index\.js: --flow, as stasis\.config\.json's entries "index\.js" sets/u)
    t.assert.equal(runNode(t, join(tmp, 'out.cjs')).trim(), '1')
  }))
})
