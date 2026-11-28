import { compressBundle, parseBundleBytes } from './brotli.js'
import { ARCHIVED, assert, isGzip, isTgzName, misnamedTgz } from './util.js'

// What reads and writes a .stasis.tgz, which stasis registers (run-archived.js): stasis-core, importing nothing, has none.
function archived(path) {
  assert(globalThis[ARCHIVED], `stasis: ${path} is a .stasis.tgz, which stasis reads and writes and stasis-core can't (it writes a stasis.code.br)`)
  return globalThis[ARCHIVED]
}

// What reads a bundle file, `(bytes, path) => bundle`, by its name: a .stasis.tgz's as stasis reads one, else brotli'd
// JSON's; a tgz of another name, none. Refuses before any byte is parsed, where a caller tells the two apart.
export function bundleFileReader(bytes, path) {
  if (isTgzName(path)) {
    const tgz = archived(path)
    return (tgzBytes, tgzPath) => tgz.read(tgzBytes, tgzPath)
  }
  assert(!isGzip(bytes), `stasis: ${misnamedTgz(path)}`)
  return parseBundleBytes
}

// A bundle file's bundle, by its name (bundleFileReader's).
export const parseBundleFile = (bytes, path) => bundleFileReader(bytes, path)(bytes, path)

// A bundle file's bytes, by its name: a .stasis.tgz as stasis writes one, else brotli'd JSON at `brotliQuality`.
export const bundleFileBytes = (bundle, path, brotliQuality) => (isTgzName(path) ? archived(path).write(bundle) : compressBundle(bundle, brotliQuality))
