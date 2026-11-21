import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { EXECUTE_BITS, LOCK_FILE } from '@exodus/stasis-core/util'
import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'

import { bundleFromLockfile } from './bundle-from-lockfile.js'

// As upstream's tree verification bounds a tarball.
const MAX_TAR_BYTES = 2 ** 30
// A BOM is no lockfile's.
const asText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The bytes of a .stasis.tgz (`file`, for errors): a stasis.lock.json at its top and exactly the files it attests, each
// a file of the bytes and execute bit it attests, nothing else in it but directories. The lockfile, and the bundle of
// those files, held to Bundle.parse's rules as a stasis.code.br of them is. archive refuses any byte past either stream
// but zeros, as gzip(1) and tar take them for padding.
export async function readStasisTgz(bytes, file) {
  try {
    const files = new Map()
    for (const entry of unpack(await decompress(bytes, 'gzip', { limit: MAX_TAR_BYTES }))) {
      if (entry.type === 'directory') continue
      if (entry.type !== 'file' && entry.type !== 'contiguous-file') throw new Error(`${entry.name} is a ${entry.type}, which no ${LOCK_FILE} attests`)
      files.set(entry.name, entry)
    }
    if (!files.has(LOCK_FILE)) throw new Error(`holds no ${LOCK_FILE} at its top`)
    let lockfile
    try {
      lockfile = Lockfile.parse(asText.decode(files.get(LOCK_FILE).data))
    } catch (cause) {
      throw new Error(`its ${LOCK_FILE} is no stasis lockfile${cause.message ? ` (${cause.message})` : ''}`, { cause })
    }
    const read = new Set()
    const bundle = bundleFromLockfile(lockfile, {
      read: (path) => {
        const data = files.get(path)?.data
        if (data === undefined) throw new Error(`${path}, which its ${LOCK_FILE} attests, is not in it`)
        read.add(path)
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      },
    })
    for (const [path, { mode }] of files) {
      if (path === LOCK_FILE) continue
      if (!read.has(path)) throw new Error(`${path} is in it, but not in its ${LOCK_FILE}`)
      if (((mode & EXECUTE_BITS) !== 0) !== lockfile.executable.has(path)) throw new Error(`${path}'s execute bit is not the one its ${LOCK_FILE} attests`)
    }
    return { bundle: Bundle.parse(bundle.serializedBytes().toString('utf8')), lockfile }
  } catch (cause) {
    throw new Error(`${file}: ${cause.message}`, { cause })
  }
}
