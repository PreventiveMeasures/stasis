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

// A bundle file's bytes, of a serialized bundle's text (brotliOptions' `quality`), and the Bundle of those bytes.
export const compressBundleText = (text, quality) => brotliCompressSync(text, brotliOptions(quality))
export const parseBundleBytes = (bytes) => Bundle.parse(brotliDecompressSync(bytes).toString('utf8'))
