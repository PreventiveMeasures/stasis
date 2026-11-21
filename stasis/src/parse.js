import { readFileSync } from 'node:fs'

import { brotliDecompressStrict } from '@exodus/stasis-core/brotli'
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'

// A file's bytes, a failure to read it told by its path.
export function readArtifactFile(file) {
  try {
    return readFileSync(file)
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new Error(`File not found: ${file}`, { cause })
    throw new Error(`Failed to read ${file}: ${cause.message}`, { cause })
  }
}

// A stasis artifact by its leading byte: a lockfile's JSON starts with `{`, a bundle is brotli. A Lockfile or Bundle
// in place of the path is taken as it is.
export function parseFileWithKind(file) {
  if (file instanceof Lockfile) return { kind: 'lockfile', artifact: file }
  if (file instanceof Bundle) return { kind: 'bundle', artifact: file }
  return parseArtifactBytes(readArtifactFile(file), file)
}

// The bytes of `file`, as parseFileWithKind parses them.
export function parseArtifactBytes(buf, file) {
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
