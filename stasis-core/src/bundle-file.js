import { compressBundle, parseBundleBytes } from './brotli.js'
import { ARCHIVED, assert, isGzip, isTgzName, misnamedTgz } from './util.js'

// What reads and writes a .stasis.tgz, which stasis (run-archived.js) and a bundler plugin register: stasis-core,
// importing nothing, has none.
function archived(path) {
  assert(globalThis[ARCHIVED], `stasis: ${path} is a .stasis.tgz, which stasis reads and writes and stasis-core can't (it writes a stasis.code.br)`)
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
