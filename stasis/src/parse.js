import { readFileSync } from 'node:fs'

import { brotliDecompressStrict } from '@exodus/stasis-core/brotli'
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { EXECUTE_BITS, LOCK_FILE, TGZ_FILE, isGzip, isTgzName } from '@exodus/stasis-core/util'
import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'

import { bundleFromLockfile } from './bundle-from-lockfile.js'

// As upstream's tree verification bounds a tarball.
const MAX_TAR_BYTES = 2 ** 30
// A BOM is no lockfile's.
const asText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// A file's bytes, a failure to read it told by its path.
function readArtifactFile(file) {
  try {
    return readFileSync(file)
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new Error(`File not found: ${file}`, { cause })
    throw new Error(`Failed to read ${file}: ${cause.message}`, { cause })
  }
}

// A stasis artifact by its leading byte: a lockfile's JSON starts with `{`, a bundle is brotli. A Lockfile or Bundle
// in place of the path is taken as it is. A .stasis.tgz is parseArtifactFile's to read.
export function parseFileWithKind(file) {
  if (file instanceof Lockfile) return { kind: 'lockfile', artifact: file }
  if (file instanceof Bundle) return { kind: 'bundle', artifact: file }
  if (isTgzName(file)) throw new Error(`${file} is a .stasis.tgz, which parseArtifactFile reads`)
  const buf = readArtifactFile(file)
  if (isGzip(buf)) throw new Error(`${file} is a tgz, which is read as ${TGZ_FILE} or <name>.${TGZ_FILE} alone`)
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

// As parseFileWithKind, or a .stasis.tgz (`stasis.tgz` or `<name>.stasis.tgz`), readStasisTgz's.
export async function parseArtifactFile(file) {
  return typeof file === 'string' && isTgzName(file) ? readStasisTgz(readArtifactFile(file), file) : parseFileWithKind(file)
}

// The bytes of a .stasis.tgz (`file`, for errors): a stasis.lock.json at its top and exactly the files it attests, each
// a file of the bytes and execute bit it attests, nothing else in it but directories. Its bundle (bundleFromLockfile's,
// held to Bundle.parse's file rules), the lockfile beside it. archive refuses any byte past either stream but zeros, as
// gzip(1) and tar take them for padding.
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
    const artifact = bundleFromLockfile(lockfile, {
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
    return { kind: 'bundle', artifact, lockfile }
  } catch (cause) {
    throw new Error(`${file}: ${cause.message}`, { cause })
  }
}
