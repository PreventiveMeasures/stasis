import { readFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'

import { brotliDecompressStrict } from '@exodus/stasis-core/brotli'
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { isGzip, isTgzName, misnamedTgz } from '@exodus/stasis-core/util'
import { pack, unpack } from '@preventive/archive/tar.js'

// As upstream's tree verification bounds a tarball.
export const MAX_TAR_BYTES = 2 ** 30

// A stasis artifact by its leading byte: a lockfile's JSON starts with `{`, a bundle is brotli; a .stasis.tgz by its
// name (readStasisTgz's). A Lockfile or Bundle in place of the path is taken as it is.
export function parseFileWithKind(file) {
  if (file instanceof Lockfile) return { kind: 'lockfile', artifact: file }
  if (file instanceof Bundle) return { kind: 'bundle', artifact: file }
  let buf
  try {
    buf = readFileSync(file)
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new Error(`File not found: ${file}`, { cause })
    throw new Error(`Failed to read ${file}: ${cause.message}`, { cause })
  }
  if (isTgzName(file)) return readStasisTgz(buf, file)
  if (isGzip(buf)) throw new Error(misnamedTgz(file))
  if (buf[0] === 0x7b /* '{' */) {
    try {
      return { kind: 'lockfile', artifact: Lockfile.parse(buf.toString('utf8')) }
    } catch (cause) {
      throw new Error(`Failed to parse stasis lockfile: ${file}`, { cause })
    }
  }
  let text
  try {
    text = brotliDecompressStrict(buf).toString('utf8')
  } catch (cause) {
    const why = cause.code === 'ERR_TRAILING_JUNK_AFTER_STREAM_END' ? 'bytes after its brotli stream' : 'not brotli'
    throw new Error(`Failed to read ${file} as a stasis bundle (${why})`, { cause })
  }
  try {
    return { kind: 'bundle', artifact: Bundle.parse(text) }
  } catch (cause) {
    throw new Error(`Failed to parse stasis bundle: ${file}`, { cause })
  }
}

export function parseFile(file) {
  return parseFileWithKind(file).artifact
}

// Its every member, nothing past the last but zeros, which gzip(1) and tar take for padding: zlib takes a zero after a
// member for the end of the input, whatever follows it.
function gunzipStrict(bytes) {
  const { buffer, engine } = gunzipSync(bytes, { info: true, maxOutputLength: MAX_TAR_BYTES })
  if (!bytes.subarray(engine.bytesWritten).every((byte) => byte === 0)) throw new Error('bytes past its gzip stream')
  return buffer
}

// The bundle of a .stasis.tgz's bytes (`file`, for errors): Bundle.fromTar's, of its tar gunzipped (gunzipStrict)
// and unpacked with @preventive/archive, which refuses any byte past its end but zeros.
export function readStasisTgz(bytes, file) {
  try {
    return { kind: 'bundle', artifact: Bundle.fromTar(unpack(gunzipStrict(bytes)), { integrityOf: sha512integrity }) }
  } catch (cause) {
    throw new Error(`${file}: ${cause.message}`, { cause })
  }
}

// A .stasis.tgz of `bundle`: Bundle#toTar's tar, packed with @preventive/archive and gzipped.
export const writeStasisTgz = (bundle) => gzipSync(pack(bundle.toTar({ integrityOf: sha512integrity })))
