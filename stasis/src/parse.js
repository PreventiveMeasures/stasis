import { readFileSync } from 'node:fs'

import { brotliDecompressStrict } from '@exodus/stasis-core/brotli'
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { isGzip, isTgzName, misnamedTgz } from '@exodus/stasis-core/util'
import { readStasisTgz as readTgz } from '@exodus/stasis-plugins/archived'

// A .stasis.tgz's reader and writer: stasis-plugins' archived.js, which a bundler plugin's State reads one through too.
export { MAX_TAR_BYTES, writeStasisTgz } from '@exodus/stasis-plugins/archived'

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

// The bundle of a .stasis.tgz's bytes (`file`, for errors), as stasis-plugins' archived.js reads one.
export function readStasisTgz(bytes, file) {
  return { kind: 'bundle', artifact: readTgz(bytes, file) }
}
