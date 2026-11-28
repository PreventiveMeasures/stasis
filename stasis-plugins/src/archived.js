import { gunzipSync, gzipSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { pack, unpack } from '@preventive/archive/tar.js'

// What reads and writes a .stasis.tgz, which stasis-core, importing neither a gzip nor a tar reader, can't: stasis's CLI
// reads one through these, and a State through `archived` at `globalThis[ARCHIVED]` (stasis-core's bundle-file.js),
// registered by stasis's run-archived.js, else by each plugin, in a bundler's worker processes too.

// As upstream's tree verification bounds a tarball.
export const MAX_TAR_BYTES = 2 ** 30

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
    return Bundle.fromTar(unpack(gunzipStrict(bytes)), { integrityOf: sha512integrity })
  } catch (cause) {
    throw new Error(`${file}: ${cause.message}`, { cause })
  }
}

// A .stasis.tgz of `bundle`: Bundle#toTar's tar, packed with @preventive/archive and gzipped.
export const writeStasisTgz = (bundle) => gzipSync(pack(bundle.toTar({ integrityOf: sha512integrity })))

// The `{ read(bytes, path), write(bundle) }` State takes at `globalThis[ARCHIVED]`.
export const archived = { read: readStasisTgz, write: writeStasisTgz }
