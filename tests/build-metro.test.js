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

import {
  ASSET_REGISTRY, assetRegistryResolver, filterPlatformAssetScales, imageDimensions, metroAssetCopies, metroAssetDescriptor, metroAssetModule,
} from '../stasis/src/metro-assets.js'
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

// --- image dimensions -------------------------------------------------------------------------

test('imageDimensions reads each image type Metro reads, as Metro does', (t) => {
  t.assert.deepStrictEqual(imageDimensions('png', png(20, 10), 'f'), { width: 20, height: 10 })
  // Apple's CgBI PNG: IHDR after the CgBI chunk.
  const cgbi = Buffer.concat([png(0, 0).subarray(0, 8), Buffer.from([0, 0, 0, 4]), Buffer.from('CgBI'), Buffer.alloc(8), png(7, 9).subarray(8)])
  t.assert.deepStrictEqual(imageDimensions('png', cgbi, 'f'), { width: 7, height: 9 })
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0, 0xff, 0xd9])
  t.assert.deepStrictEqual(imageDimensions('jpg', jpeg, 'f'), { width: 640, height: 480 })
  const gif = Buffer.alloc(13)
  gif.write('GIF89a')
  gif.writeUInt16LE(11, 6)
  gif.writeUInt16LE(12, 8)
  t.assert.deepStrictEqual(imageDimensions('gif', gif, 'f'), { width: 11, height: 12 })
  const bmp = Buffer.alloc(54)
  bmp.write('BM')
  bmp.writeUInt32LE(40, 14)
  bmp.writeInt32LE(13, 18)
  bmp.writeInt32LE(-14, 22) // top-down: a negative height
  t.assert.deepStrictEqual(imageDimensions('bmp', bmp, 'f'), { width: 13, height: 14 })
  const vp8x = Buffer.alloc(30)
  vp8x.write('RIFF')
  vp8x.write('WEBP', 8)
  vp8x.write('VP8X', 12)
  vp8x.writeUInt32LE(10, 16)
  vp8x.writeUIntLE(299, 24, 3)
  vp8x.writeUIntLE(199, 27, 3)
  t.assert.deepStrictEqual(imageDimensions('webp', vp8x, 'f'), { width: 300, height: 200 })
  const vp8l = Buffer.alloc(26)
  vp8l.write('RIFF')
  vp8l.write('WEBP', 8)
  vp8l.write('VP8L', 12)
  vp8l.writeUInt32LE(5, 16)
  // width-1 = 99 (14 bits), height-1 = 49 (14 bits), packed little-endian after the 0x2f signature
  const packed = 99 | (49 << 14)
  Buffer.from([0x2f, packed & 0xff, (packed >> 8) & 0xff, (packed >> 16) & 0xff, (packed >> 24) & 0xff]).copy(vp8l, 20)
  t.assert.deepStrictEqual(imageDimensions('webp', vp8l, 'f'), { width: 100, height: 50 })
  const psd = Buffer.alloc(26)
  psd.write('8BPS')
  psd.writeUInt16BE(1, 4)
  psd.writeUInt32BE(30, 14)
  psd.writeUInt32BE(40, 18)
  t.assert.deepStrictEqual(imageDimensions('psd', psd, 'f'), { width: 40, height: 30 })
  const tiff = Buffer.alloc(8 + 2 + 24)
  tiff.write('MM')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(2, 8)
  for (const [i, [tag, value]] of [[256, 5], [257, 6]].entries()) {
    tiff.writeUInt16BE(tag, 10 + i * 12)
    tiff.writeUInt16BE(3, 12 + i * 12)
    tiff.writeUInt32BE(1, 14 + i * 12)
    tiff.writeUInt16BE(value, 18 + i * 12)
  }
  t.assert.deepStrictEqual(imageDimensions('tiff', tiff, 'f'), { width: 5, height: 6 })
  const ktx2 = Buffer.alloc(80)
  Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ktx2)
  ktx2.writeUInt32LE(64, 20)
  ktx2.writeUInt32LE(32, 24)
  t.assert.deepStrictEqual(imageDimensions('ktx', ktx2, 'f'), { width: 64, height: 32 })
  // SVG: width/height in CSS units, else scaled by the viewBox, else the viewBox.
  t.assert.deepStrictEqual(imageDimensions('svg', Buffer.from('<?xml version="1.0"?><svg width="2in" height="3cm"/>'), 'f'), { width: 192, height: 113 })
  t.assert.deepStrictEqual(imageDimensions('svg', Buffer.from("<svg viewBox='0 0 120 60' width='50'>"), 'f'), { width: 50, height: 25 })
  t.assert.deepStrictEqual(imageDimensions('svg', Buffer.from('<svg viewBox="0,0,30,10">'), 'f'), { width: 30, height: 10 })
  // A type's own parser failing falls back to the others: a PNG named .jpg is read as a PNG.
  t.assert.deepStrictEqual(imageDimensions('jpg', png(3, 4), 'f'), { width: 3, height: 4 })
  t.assert.throws(() => imageDimensions('png', Buffer.from('not an image'), 'img/x.png'), /^Error: Invalid png image asset: img\/x\.png$/u)
  t.assert.throws(() => imageDimensions('png', png(0, 10), 'img/x.png'), /Invalid png image asset/u)
})

// --- the asset module -------------------------------------------------------------------------

test('metroAssetDescriptor builds Metro\'s descriptor: scales in order, md5 of the files, size at the first scale', (t) => {
  const bytes = {
    'img/logo.png': png(20, 10),
    'img/logo@2x.png': png(40, 20),
    'img/logo@3x.png': png(60, 30),
    'img/logo@1.5x.png': png(30, 15),
  }
  const read = (file) => bytes[file]
  const { descriptor, files } = metroAssetDescriptor('img/logo.png', { platform: 'ios', files: Object.keys(bytes).toReversed(), read })
  t.assert.deepStrictEqual(files, ['img/logo.png', 'img/logo@1.5x.png', 'img/logo@2x.png', 'img/logo@3x.png'])
  t.assert.deepStrictEqual(descriptor, {
    __packager_asset: true,
    httpServerLocation: '/assets/img',
    width: 20,
    height: 10,
    scales: [1, 1.5, 2, 3],
    hash: md5(...files.map(read)),
    name: 'logo',
    type: 'png',
  })
  // Keys in Metro's order: generateAssetCodeFileAst stringifies getAssetData's object.
  t.assert.deepStrictEqual(Object.keys(descriptor), ['__packager_asset', 'httpServerLocation', 'width', 'height', 'scales', 'hash', 'name', 'type'])
  t.assert.equal(
    metroAssetModule(descriptor),
    `module.exports = require("react-native/Libraries/Image/AssetRegistry").registerAsset(${JSON.stringify(descriptor)});\n`
  )

  // An asset of one file, on iOS.
  const one = (rel, content = png(1, 1)) => metroAssetDescriptor(rel, { platform: 'ios', files: [rel], read: () => content }).descriptor
  // Only a scale variant: the size over its scale. A platform file names the asset without its suffix.
  const only = one('img/only@3x.ios.png', png(30, 60))
  t.assert.deepStrictEqual([only.name, only.scales, only.width, only.height], ['only', [3], 10, 20])
  // Another platform's suffix is part of the name.
  t.assert.equal(one('a.android.png').name, 'a.android')
  // Equal scales keep readdir's bytewise name order (`tie.png` before `tie@1x.png`).
  t.assert.deepStrictEqual(
    metroAssetDescriptor('img/tie.png', { platform: 'ios', files: ['img/tie@1x.png', 'img/tie.png', 'img/tie@2x.png'], read: () => png(2, 2) }).files,
    ['img/tie.png', 'img/tie@1x.png', 'img/tie@2x.png']
  )
  // At the root, in node_modules, or outside the project root (Metro joins no `..` path).
  t.assert.equal(one('logo.png').httpServerLocation, '/assets')
  t.assert.equal(one('node_modules/pkg/a.png').httpServerLocation, '/assets/node_modules/pkg')
  t.assert.equal(one('../shared/a.png').httpServerLocation, '/assets/../shared')
  // No image: no size.
  const font = one('fonts/Inter.ttf', Buffer.from('font'))
  t.assert.deepStrictEqual([font.width, font.height, JSON.stringify(font).includes('width')], [undefined, undefined, false])
  t.assert.throws(() => one('e.png', Buffer.alloc(0)), /Image asset `e\.png` cannot be an empty file/u)
})

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

// --- --assets-dest ----------------------------------------------------------------------------

test('metroAssetCopies lays the files out as react-native bundle --assets-dest does', (t) => {
  // What metroAssetCopies reads of an asset: its descriptor's location, name, type and scales, and its files.
  const logo = {
    descriptor: { httpServerLocation: '/assets/img', name: 'Logo-Big', type: 'png', scales: [1, 2, 3, 4] },
    files: ['img/Logo-Big.png', 'img/Logo-Big@2x.png', 'img/Logo-Big@3x.png', 'img/Logo-Big@4x.png'],
  }
  const font = { descriptor: { httpServerLocation: '/assets/fonts', name: 'Inter', type: 'ttf', scales: [1] }, files: ['fonts/Inter.ttf'] }
  const odd = { descriptor: { httpServerLocation: '/assets/img', name: 'odd', type: 'png', scales: [2.5] }, files: ['img/odd@2.5x.png'] }
  // iOS: by the asset's path under assets/, scales 1x-3x.
  t.assert.deepStrictEqual(metroAssetCopies('ios', [logo, font]), [
    { file: 'img/Logo-Big.png', dest: 'assets/img/Logo-Big.png' },
    { file: 'img/Logo-Big@2x.png', dest: 'assets/img/Logo-Big@2x.png' },
    { file: 'img/Logo-Big@3x.png', dest: 'assets/img/Logo-Big@3x.png' },
    { file: 'fonts/Inter.ttf', dest: 'assets/fonts/Inter.ttf' },
  ])
  // Android: drawable-<density>/ by the folded resource name, raw/ for a type no drawable, and keep.xml.
  t.assert.deepStrictEqual(metroAssetCopies('android', [logo, font]), [
    { file: 'img/Logo-Big.png', dest: 'drawable-mdpi/img_logobig.png' },
    { file: 'img/Logo-Big@2x.png', dest: 'drawable-xhdpi/img_logobig.png' },
    { file: 'img/Logo-Big@3x.png', dest: 'drawable-xxhdpi/img_logobig.png' },
    { file: 'img/Logo-Big@4x.png', dest: 'drawable-xxxhdpi/img_logobig.png' },
    { file: 'fonts/Inter.ttf', dest: 'raw/fonts_inter.ttf' },
    { dest: 'raw/keep.xml', contents: '<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="@drawable/img_logobig,@raw/fonts_inter" />\n' },
  ])
  t.assert.throws(() => metroAssetCopies('android', [odd]), /Don't know which android drawable suffix/u)
  // iOS keeps 1x-3x, else the next scale above, else the largest; other platforms keep all.
  t.assert.deepStrictEqual(filterPlatformAssetScales('ios', [0.75, 1, 4]), [1])
  t.assert.deepStrictEqual(filterPlatformAssetScales('ios', [0.5, 4, 5]), [4])
  t.assert.deepStrictEqual(filterPlatformAssetScales('ios', [0.5, 0.75]), [0.75])
  t.assert.deepStrictEqual(filterPlatformAssetScales('android', [0.75, 4]), [0.75, 4])
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

  test('--assets-dest needs --metro, and --metro one platform, checked before the artifact is read', async (t) => {
    const noMetro = await runCli(['build', '--assets-dest=dist', '--output=out.js', 'missing.code.br'], { cwd: tmpdir() })
    t.assert.notEqual(noMetro.status, 0)
    t.assert.match(noMetro.stderr, /--assets-dest needs --metro=PLATFORM/u)
    const two = await runCli(['build', '--metro=ios,android', '--output=out.js', 'missing.code.br'], { cwd: tmpdir() })
    t.assert.notEqual(two.status, 0)
    t.assert.match(two.stderr, /--metro takes one platform to build for/u)
  })
})
