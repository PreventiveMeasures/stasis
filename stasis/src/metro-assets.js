// `stasis build --metro=PLATFORM`: a Metro asset (a resource a --metro bundle reaches through an import)
// built into the module Metro builds of it, and copied out as `react-native bundle --assets-dest` copies
// it, from the bytes the artifact carries -- never from disk.
//
// Metro builds `require('./img/logo.png')` into (metro-transform-worker's assetTransformer, Metro's
// getAssetData and generateAssetCodeFileAst):
//
//   module.exports = require('react-native/Libraries/Image/AssetRegistry').registerAsset({
//     __packager_asset: true, httpServerLocation: '/assets/img', width, height,
//     scales: [1, 2, 3], hash, name: 'logo', type: 'png' })
//
// from every file of the asset in its directory (each scale, `logo@2x.png`; those for the platform,
// `logo.ios.png`, where it has any): their scales, an md5 over their bytes, and the first one's image
// dimensions over its scale. The asset registry is React Native's Metro config's `assetRegistryPath`
// (@react-native/metro-config's), the one `stasis bundle --metro` carries for an asset. A project's
// own `assetRegistryPath`, `publicPath` (Metro's default `/assets` here) and `assetPlugins` are read off
// its Metro config, which is code, and aren't.
//
// Mirrors Metro 0.83 (src/Assets.js, src/lib/imageSize.js, src/node-haste/lib/AssetPaths.js) and
// @react-native/community-cli-plugin 0.81 (commands/bundle/saveAssets.js and its helpers), both MIT
// licensed, Copyright (c) Meta Platforms, Inc. and affiliates.
import { createHash } from 'node:crypto'
import { join, posix } from 'node:path'

import { parseMetroAssetName } from '@exodus/stasis-plugins/metro-native'
import { METRO_SOURCE_EXTS } from './resolve-fields.js'

// The asset registry the module Metro builds of an asset requires: React Native's Metro config's
// `assetRegistryPath` (@react-native/metro-config's), where a project's own isn't read, being code.
// `stasis bundle --metro` carries the file it resolves to for each asset.
export const ASSET_REGISTRY = 'react-native/Libraries/Image/AssetRegistry'
const PUBLIC_PATH = '/assets'

// --- image dimensions: Metro's getImageDimensions (src/lib/imageSize.js) ------------------------
//
// The parser for the asset's type, else the first of the others that reads the bytes; an image none
// reads, or whose dimensions aren't positive and finite, is an invalid asset.

const MAX_SVG_HEADER_LENGTH = 64 * 1024
const KTX1_IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x31, 0x31, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
const KTX2_IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_IDENTIFIER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const hasBytes = (content, offset, length) =>
  Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 &&
  offset <= content.length && length <= content.length - offset
const startsWith = (content, prefix) => hasBytes(content, 0, prefix.length) && content.subarray(0, prefix.length).equals(prefix)
const readAscii = (content, start, end) => content.toString('ascii', start, end)
const readUInt24LE = (content, offset) => content[offset] + content[offset + 1] * 256 + content[offset + 2] * 65536

function parseBmp(content) {
  if (!hasBytes(content, 0, 26) || readAscii(content, 0, 2) !== 'BM') return null
  const dibHeaderSize = content.readUInt32LE(14)
  if (dibHeaderSize === 12) return { width: content.readUInt16LE(18), height: content.readUInt16LE(20) }
  if (dibHeaderSize < 40) return null
  return { width: Math.abs(content.readInt32LE(18)), height: Math.abs(content.readInt32LE(22)) }
}

function parseGif(content) {
  if (!hasBytes(content, 0, 10) || !/^GIF8[79]a$/u.test(readAscii(content, 0, 6))) return null
  return { width: content.readUInt16LE(6), height: content.readUInt16LE(8) }
}

const isStandaloneJpegMarker = (marker) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)
const isJpegStartOfFrame = (marker) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

function parseJpeg(content) {
  if (!hasBytes(content, 0, 4) || content[0] !== 0xff || content[1] !== 0xd8) return null
  let offset = 2
  while (offset < content.length) {
    while (offset < content.length && content[offset] === 0xff) offset++
    if (offset >= content.length) return null
    const marker = content[offset++]
    if (marker === 0x00) return null
    if (isStandaloneJpegMarker(marker)) {
      if (marker === 0xd9) return null
      continue
    }
    if (!hasBytes(content, offset, 2)) return null
    const segmentLength = content.readUInt16BE(offset)
    if (segmentLength < 2) return null
    const segmentEnd = offset + segmentLength
    if (segmentEnd <= offset || segmentEnd > content.length) return null
    if (isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return null
      return { height: content.readUInt16BE(offset + 3), width: content.readUInt16BE(offset + 5) }
    }
    if (marker === 0xda) return null
    offset = segmentEnd
  }
  return null
}

function parseKtx(content) {
  if (hasBytes(content, 0, 64) && startsWith(content, KTX1_IDENTIFIER)) {
    const endianness = content.subarray(12, 16)
    if (endianness.equals(Buffer.from([0x01, 0x02, 0x03, 0x04]))) return { width: content.readUInt32LE(36), height: content.readUInt32LE(40) }
    if (endianness.equals(Buffer.from([0x04, 0x03, 0x02, 0x01]))) return { width: content.readUInt32BE(36), height: content.readUInt32BE(40) }
    return null
  }
  if (hasBytes(content, 0, 80) && startsWith(content, KTX2_IDENTIFIER)) return { width: content.readUInt32LE(20), height: content.readUInt32LE(24) }
  return null
}

function parsePng(content) {
  if (!hasBytes(content, 0, 24) || !startsWith(content, PNG_IDENTIFIER)) return null
  const firstChunkLength = content.readUInt32BE(8)
  const firstChunkType = readAscii(content, 12, 16)
  if (firstChunkType === 'IHDR') {
    if (firstChunkLength !== 13) return null
    return { width: content.readUInt32BE(16), height: content.readUInt32BE(20) }
  }
  // Apple's CgBI PNG: its IHDR follows the CgBI chunk.
  if (firstChunkType !== 'CgBI') return null
  const ihdrOffset = 8 + 12 + firstChunkLength
  if (!hasBytes(content, ihdrOffset, 24) || content.readUInt32BE(ihdrOffset) !== 13 || readAscii(content, ihdrOffset + 4, ihdrOffset + 8) !== 'IHDR') return null
  return { width: content.readUInt32BE(ihdrOffset + 8), height: content.readUInt32BE(ihdrOffset + 12) }
}

function parsePsd(content) {
  if (!hasBytes(content, 0, 22) || readAscii(content, 0, 4) !== '8BPS' || (content.readUInt16BE(4) !== 1 && content.readUInt16BE(4) !== 2)) return null
  return { height: content.readUInt32BE(14), width: content.readUInt32BE(18) }
}

const SVG_UNIT_FACTORS = { in: 96, cm: 96 / 2.54, em: 16, ex: 8, mm: 96 / 2.54 / 10, pc: (96 / 72) * 12, pt: 96 / 72, px: 1 }

// The index of the `>` closing the tag starting at `start`, past quoted attribute values.
function findTagEnd(input, start) {
  let quote = null
  for (let index = start; index < input.length; index++) {
    const character = input[index]
    if (quote !== null) {
      if (character === quote) quote = null
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return null
}

function parseSvgLength(value) {
  if (value === undefined || value.endsWith('%')) return null
  const match = /^([+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)([a-z]*)$/iu.exec(value.trim())
  if (match === null) return null
  const unit = match[2].toLowerCase()
  const factor = unit === '' ? 1 : SVG_UNIT_FACTORS[unit]
  if (factor === undefined) return null
  return Math.round(Number(match[1]) * factor)
}

function parseSvgViewBox(value) {
  if (value === undefined) return null
  const values = value.trim().split(/[\s,]+/u).map(Number)
  if (values.length !== 4 || !values.every((v) => Number.isFinite(v)) || values[2] <= 0 || values[3] <= 0) return null
  return { width: values[2], height: values[3] }
}

function parseSvg(content) {
  const header = content.subarray(0, Math.min(content.length, MAX_SVG_HEADER_LENGTH)).toString('utf8')
  const rootStartMatch = /<svg(?:\s|>)/u.exec(header)
  if (rootStartMatch === null) return null
  const rootStart = rootStartMatch.index
  const rootEnd = findTagEnd(header, rootStart)
  if (rootEnd === null) return null
  const root = header.slice(rootStart, rootEnd + 1)
  const attributes = {}
  for (const match of root.matchAll(/\b(width|height|viewBox)\s*=\s*(?:"([^"]*)"|'([^']*)')/giu)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3]
  }
  const width = parseSvgLength(attributes.width)
  const height = parseSvgLength(attributes.height)
  if (width !== null && height !== null) return { width, height }
  const viewBox = parseSvgViewBox(attributes.viewbox)
  if (viewBox === null) return null
  if (width !== null) return { width, height: Math.floor(width / (viewBox.width / viewBox.height)) }
  if (height !== null) return { width: Math.floor(height * (viewBox.width / viewBox.height)), height }
  return viewBox
}

const readTiffUInt16 = (content, offset, isBigEndian) => (isBigEndian ? content.readUInt16BE(offset) : content.readUInt16LE(offset))
const readTiffUInt32 = (content, offset, isBigEndian) => (isBigEndian ? content.readUInt32BE(offset) : content.readUInt32LE(offset))

function readTiffDimension(content, entryOffset, isBigEndian) {
  const type = readTiffUInt16(content, entryOffset + 2, isBigEndian)
  const count = readTiffUInt32(content, entryOffset + 4, isBigEndian)
  if (count !== 1) return null
  if (type === 3) return readTiffUInt16(content, entryOffset + 8, isBigEndian)
  if (type === 4) return readTiffUInt32(content, entryOffset + 8, isBigEndian)
  return null
}

function parseTiff(content) {
  if (!hasBytes(content, 0, 8)) return null
  const byteOrder = readAscii(content, 0, 2)
  const isBigEndian = byteOrder === 'MM'
  if ((!isBigEndian && byteOrder !== 'II') || readTiffUInt16(content, 2, isBigEndian) !== 42) return null
  const ifdOffset = readTiffUInt32(content, 4, isBigEndian)
  if (!hasBytes(content, ifdOffset, 2)) return null
  const entryCount = readTiffUInt16(content, ifdOffset, isBigEndian)
  const entriesOffset = ifdOffset + 2
  if (entryCount > Math.floor((content.length - entriesOffset) / 12)) return null
  let width
  let height
  for (let index = 0; index < entryCount; index++) {
    const entryOffset = entriesOffset + index * 12
    const tag = readTiffUInt16(content, entryOffset, isBigEndian)
    if (tag !== 256 && tag !== 257) continue
    const value = readTiffDimension(content, entryOffset, isBigEndian)
    if (value === null) return null
    if (tag === 256) width = value
    else height = value
  }
  return width !== undefined && height !== undefined ? { width, height } : null
}

function parseWebp(content) {
  if (!hasBytes(content, 0, 20) || readAscii(content, 0, 4) !== 'RIFF' || readAscii(content, 8, 12) !== 'WEBP') return null
  let offset = 12
  while (hasBytes(content, offset, 8)) {
    const chunkType = readAscii(content, offset, offset + 4)
    const chunkLength = content.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    if (!hasBytes(content, dataOffset, chunkLength)) return null
    if (chunkType === 'VP8X' && chunkLength >= 10) {
      return { width: 1 + readUInt24LE(content, dataOffset + 4), height: 1 + readUInt24LE(content, dataOffset + 7) }
    }
    if (chunkType === 'VP8L' && chunkLength >= 5 && content[dataOffset] === 0x2f) {
      return {
        width: 1 + (((content[dataOffset + 2] & 0x3f) << 8) | content[dataOffset + 1]),
        height: 1 + (((content[dataOffset + 4] & 0x0f) << 10) | (content[dataOffset + 3] << 2) | ((content[dataOffset + 2] & 0xc0) >> 6)),
      }
    }
    if (chunkType === 'VP8 ' && chunkLength >= 10 && content[dataOffset + 3] === 0x9d && content[dataOffset + 4] === 0x01 && content[dataOffset + 5] === 0x2a) {
      return { width: content.readUInt16LE(dataOffset + 6) & 0x3fff, height: content.readUInt16LE(dataOffset + 8) & 0x3fff }
    }
    const nextOffset = dataOffset + chunkLength + (chunkLength % 2)
    if (nextOffset <= offset) return null
    offset = nextOffset
  }
  return null
}

// Its keys are Metro's image types (isAssetTypeAnImage); its parsers, in order, its fallbacks.
const IMAGE_PARSERS = { bmp: parseBmp, gif: parseGif, jpeg: parseJpeg, jpg: parseJpeg, ktx: parseKtx, png: parsePng, psd: parsePsd, svg: parseSvg, tiff: parseTiff, webp: parseWebp }
const FALLBACK_PARSERS = [...new Set(Object.values(IMAGE_PARSERS))]

const tryParse = (parser, content) => {
  try {
    return parser?.(content) ?? null
  } catch {
    return null
  }
}

// The image `content` of an asset of `type` (`file` naming it in errors) is: its width and height.
export function imageDimensions(type, content, file) {
  const parser = IMAGE_PARSERS[type]
  let dimensions = null
  for (const candidate of [parser, ...FALLBACK_PARSERS.filter((fallback) => fallback !== parser)]) {
    dimensions = tryParse(candidate, content)
    if (dimensions !== null) break
  }
  if (dimensions === null || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error(`Invalid ${type} image asset: ${file}`)
  }
  return dimensions
}

// --- the asset module ---------------------------------------------------------------------------

// Metro's descriptor of the asset module `rel` (its path from the project root, posix) for `platform`,
// of `files` (its files, metroAssetFiles' set: their paths from the project root), whose bytes
// `read(rel)` gives (a Buffer): getAssetData, less the keys generateAssetCodeFileAst drops (`files`,
// `fileSystemLocation`). The files in scale order are `files` in the order Metro reads them, as
// fs.promises.readdir lists them (libuv sorts the names bytewise), each inserted after those of a
// scale it doesn't exceed. -> { descriptor, files }, `files` in scale order
export function metroAssetDescriptor(rel, { platform, files, read }) {
  const own = parseMetroAssetName(posix.basename(rel), platform)
  if (own === null || files.length === 0) throw new Error(`Asset not found: ${rel} for platform: ${platform}`)
  const byScale = files
    .map((file) => ({ file, name: Buffer.from(posix.basename(file)), resolution: parseMetroAssetName(posix.basename(file), platform).resolution }))
    .toSorted((a, b) => a.resolution - b.resolution || Buffer.compare(a.name, b.name))
  const contents = byScale.map(({ file }) => read(file))
  const hasher = createHash('md5')
  for (const content of contents) hasher.update(content)
  const scales = byScale.map(({ resolution }) => resolution)
  let dimensions = null
  if (Object.hasOwn(IMAGE_PARSERS, own.type)) {
    if (contents[0].length === 0) throw new Error(`Image asset \`${byScale[0].file}\` cannot be an empty file.`)
    dimensions = imageDimensions(own.type, contents[0], byScale[0].file)
  }
  // An asset outside the project root takes its `..` path verbatim, as Metro joins none.
  const dir = posix.dirname(rel)
  const httpServerLocation = rel.startsWith('..') ? `${PUBLIC_PATH.replace(/\/$/u, '')}/${dir}` : posix.join(PUBLIC_PATH, dir)
  const descriptor = {
    __packager_asset: true,
    httpServerLocation,
    width: dimensions ? dimensions.width / scales[0] : undefined,
    height: dimensions ? dimensions.height / scales[0] : undefined,
    scales,
    hash: hasher.digest('hex'),
    name: own.name,
    type: own.type,
  }
  return { descriptor, files: byScale.map(({ file }) => file) }
}

// The module Metro builds of an asset of `descriptor`. Plain ES5: Metro builds it past Babel, and it
// needs no downleveling for Hermes.
export const metroAssetModule = (descriptor) =>
  `module.exports = require(${JSON.stringify(ASSET_REGISTRY)}).registerAsset(${JSON.stringify(descriptor)});\n`

// The resolver of `ASSET_REGISTRY` from an asset for `platform`, as Metro resolves it, among `carried`
// (the code files the artifact carries: a Map or Set keyed by their paths from the project root): the
// copy of react-native in the nearest node_modules up from the asset's directory, else the only copy
// (pnpm's, linked in from node_modules/.pnpm); in it, the file Metro probes first -- each of its
// sourceExts, the platform's file, then the .native one, then the plain one. The copies are found once.
// -> (rel) => its path, throwing where the artifact carries none, or several none of them nearest
const REGISTRY_ROOT = /^((?:.*\/)?node_modules\/react-native)\/Libraries\/Image\/AssetRegistry\./u
export function assetRegistryResolver(platform, carried) {
  const pick = (root) => {
    for (const ext of METRO_SOURCE_EXTS) {
      for (const suffix of [`.${platform}`, '.native', '']) {
        const file = `${root}/Libraries/Image/AssetRegistry${suffix}.${ext}`
        if (carried.has(file)) return file
      }
    }
    return undefined
  }
  const roots = new Set([...carried.keys()].map((file) => REGISTRY_ROOT.exec(file)?.[1]).filter((root) => root !== undefined && pick(root) !== undefined))
  const nearest = (rel) => {
    for (let dir = posix.dirname(rel); ; dir = posix.dirname(dir)) {
      const root = posix.join(dir, 'node_modules', 'react-native')
      if (posix.basename(dir) !== 'node_modules' && roots.has(root)) return root
      if (dir === '.' || dir === '/' || dir.startsWith('..')) return undefined
    }
  }
  return (rel) => {
    const root = roots.size === 1 ? [...roots][0] : nearest(rel)
    if (root !== undefined) return pick(root)
    if (roots.size === 0) {
      throw new Error(
        `stasis build: --metro builds '${rel}' into a module requiring ${ASSET_REGISTRY}, which the artifact doesn't carry; ` +
        'bundle it with `stasis bundle --metro --resources=...` from a project with react-native installed'
      )
    }
    throw new Error(`stasis build: --metro found several ${ASSET_REGISTRY} for '${rel}', none of them nearest: ${[...roots].join(', ')}`)
  }
}

// --- --assets-dest: @react-native/community-cli-plugin's saveAssets -----------------------------

// The scales of an asset's files copied out for `platform` (filterPlatformAssetScales): iOS takes
// 1x-3x, else the next one above, else the largest.
const ALLOWED_SCALES = { ios: [1, 2, 3] }
export function filterPlatformAssetScales(platform, scales) {
  const allowed = ALLOWED_SCALES[platform]
  if (!allowed) return scales
  const result = scales.filter((scale) => allowed.includes(scale))
  if (result.length === 0 && scales.length > 0) {
    const maxScale = allowed[allowed.length - 1]
    const above = scales.find((scale) => scale > maxScale)
    result.push(above ?? scales[scales.length - 1])
  }
  return result
}

const DRAWABLE_TYPES = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp', 'xml'])
const ANDROID_SUFFIXES = new Map([[0.75, 'ldpi'], [1, 'mdpi'], [1.5, 'hdpi'], [2, 'xhdpi'], [3, 'xxhdpi'], [4, 'xxxhdpi']])

// An asset's Android resource name: its path, folded into one lowercase identifier.
const androidResourceIdentifier = (descriptor) =>
  `${descriptor.httpServerLocation.replace(/^\//u, '')}/${descriptor.name}`
    .toLowerCase()
    .replace(/\//gu, '_')
    .replace(/([^a-z0-9_])/gu, '')
    .replace(/^(?:assets|assetsunstable_path)_/u, '')

// Where the file of `descriptor` at `scale` is copied to under --assets-dest for `platform`: Android's
// res/ layout (drawable-<density>/, raw/ for a type no drawable), else iOS' (the generic one).
function assetDestPath(platform, descriptor, scale) {
  if (platform === 'android') {
    let folder = 'raw'
    if (DRAWABLE_TYPES.has(descriptor.type)) {
      const suffix = ANDROID_SUFFIXES.get(scale)
      if (suffix === undefined) throw new Error(`Don't know which android drawable suffix to use for asset: ${JSON.stringify(descriptor)}`)
      folder = `drawable-${suffix}`
    }
    return join(folder, `${androidResourceIdentifier(descriptor)}.${descriptor.type}`)
  }
  const suffix = scale === 1 ? '' : `@${scale}x`
  return join(descriptor.httpServerLocation.slice(1).replace(/\.\.\//gu, '_'), `${descriptor.name}${suffix}.${descriptor.type}`)
}

// What --assets-dest writes for `platform` of `assets` ({ descriptor, files }, files in scale order):
// each file of a scale filterPlatformAssetScales keeps at its assetDestPath, and on Android raw/keep.xml,
// keeping every asset's resource from shrinking. -> [{ dest, file } | { dest, contents }], `dest` from
// the assets directory, `file` an asset's file (its path from the project root)
export function metroAssetCopies(platform, assets) {
  const copies = new Map()
  for (const { descriptor, files } of assets) {
    const kept = new Set(filterPlatformAssetScales(platform, descriptor.scales))
    descriptor.scales.forEach((scale, i) => {
      if (kept.has(scale)) copies.set(files[i], assetDestPath(platform, descriptor, scale))
    })
  }
  const out = [...copies].map(([file, dest]) => ({ dest, file }))
  if (platform === 'android' && assets.length > 0) {
    const keep = assets.map(({ descriptor }) => `@${DRAWABLE_TYPES.has(descriptor.type) ? 'drawable' : 'raw'}/${androidResourceIdentifier(descriptor)}`)
    out.push({ dest: join('raw', 'keep.xml'), contents: `<resources xmlns:tools="http://schemas.android.com/tools" tools:keep="${keep.join(',')}" />\n` })
  }
  return out
}
