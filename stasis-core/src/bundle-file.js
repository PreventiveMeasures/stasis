import { compressBundle, parseBundleBytes } from './brotli.js'
import { ARCHIVED, assert, isGzip, isTgzName, misnamedTgz } from './util.js'

// What reads and writes a .stasis.tgz, which stasis registers (run-archived.js): stasis-core, importing nothing, has none.
function archived(path) {
  assert(globalThis[ARCHIVED], `stasis: ${path}: a .stasis.tgz needs stasis, not stasis-core`)
  return globalThis[ARCHIVED]
}

// A bundle file's bundle, by its name: a .stasis.tgz's as stasis reads one, else brotli'd JSON's; a tgz of another name,
// none.
export function parseBundleFile(bytes, path) {
  if (isTgzName(path)) return archived(path).read(bytes, path)
  assert(!isGzip(bytes), `stasis: ${misnamedTgz(path)}`)
  return parseBundleBytes(bytes)
}

// A bundle file's bytes, by its name: a .stasis.tgz as stasis writes one, else brotli'd JSON at `brotliQuality`.
export const bundleFileBytes = (bundle, path, brotliQuality) => (isTgzName(path) ? archived(path).write(bundle) : compressBundle(bundle, brotliQuality))
