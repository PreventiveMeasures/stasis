import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'

import { Bundle } from './bundle.js'
import { assert, isBrotliQuality, parseBrotliQuality } from './util.js'

// Default brotli quality; the top levels (10, 11) cost far more time for a marginal size gain.
export const DEFAULT_BROTLI_QUALITY = 6

export function brotliOptions(quality) {
  assert(quality === undefined || isBrotliQuality(quality), `brotli quality must be an integer 0..11, got ${quality}`)
  const raw = process.env.EXODUS_STASIS_BROTLI_QUALITY
  if (raw) {
    const n = parseBrotliQuality('EXODUS_STASIS_BROTLI_QUALITY', raw)
    assert(quality === undefined || quality === n,
      `brotli quality ${quality} conflicts with EXODUS_STASIS_BROTLI_QUALITY=${raw}`)
    quality = n
  }
  return { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality ?? DEFAULT_BROTLI_QUALITY } }
}

// zlib's brotli decoder ignores bytes after the stream, where DecompressionStream refuses them with this error.
export const trailingJunkError = () => Object.assign(
  new TypeError('Trailing junk found after the end of the compressed stream'),
  { code: 'ERR_TRAILING_JUNK_AFTER_STREAM_END' })

// The engine's bytesWritten counts the input it consumed, which stops where the stream does.
export function brotliDecompressStrict(bytes) {
  const { buffer, engine } = brotliDecompressSync(bytes, { info: true })
  if (engine.bytesWritten !== Buffer.byteLength(bytes)) throw trailingJunkError()
  return buffer
}

export const compressBundleText = (text, quality) => brotliCompressSync(text, brotliOptions(quality))
export const compressBundle = (bundle, quality) => brotliCompressSync(bundle.serializedBytes(), brotliOptions(quality))
export const parseBundleBytes = (bytes) => Bundle.parse(brotliDecompressStrict(bytes).toString('utf8'))
