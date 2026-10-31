import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'

import { Bundle } from './bundle.js'
import { assert, isBrotliQuality, parseBrotliQuality } from './util.js'

// Default brotli quality; the top levels (10, 11) cost far more time for a marginal size gain.
export const DEFAULT_BROTLI_QUALITY = 6

export function brotliOptions(quality) {
  if (quality !== undefined) {
    assert(isBrotliQuality(quality), `brotli quality must be an integer 0..11, got ${quality}`)
  }
  const raw = process.env.EXODUS_STASIS_BROTLI_QUALITY
  if (raw) {
    const n = parseBrotliQuality('EXODUS_STASIS_BROTLI_QUALITY', raw)
    assert(quality === undefined || quality === n,
      `brotli quality ${quality} conflicts with EXODUS_STASIS_BROTLI_QUALITY=${raw}`)
    quality = n
  }
  return { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: quality ?? DEFAULT_BROTLI_QUALITY } }
}

// zlib's brotli decoder stops at the end of the stream and ignores whatever follows it, where
// DecompressionStream refuses bytes after a gzip or deflate stream; this is Node's error for those.
export const trailingJunkError = () => Object.assign(
  new TypeError('Trailing junk found after the end of the compressed stream'),
  { code: 'ERR_TRAILING_JUNK_AFTER_STREAM_END' })

// brotliDecompressSync(bytes), refusing bytes after the end of the brotli stream: the engine's
// bytesWritten counts the input it consumed, which stops where the stream does.
export function brotliDecompressStrict(bytes) {
  const { buffer, engine } = brotliDecompressSync(bytes, { info: true })
  if (engine.bytesWritten !== Buffer.byteLength(bytes)) throw trailingJunkError()
  return buffer
}

// A bundle file's bytes, of a serialized bundle's text (brotliOptions' `quality`), and the Bundle of
// those bytes, which are one brotli stream and nothing after it.
export const compressBundleText = (text, quality) => brotliCompressSync(text, brotliOptions(quality))
export const parseBundleBytes = (bytes) => Bundle.parse(brotliDecompressStrict(bytes).toString('utf8'))
