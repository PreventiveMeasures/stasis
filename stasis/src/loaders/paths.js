import { isUtf8 } from 'node:buffer'
import { dirname, join } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { assertRealPathWithinBase } from '@exodus/stasis-core/util'
import { isFile } from '../resolve-typescript.js'

// `segments` applied on `fromFile`'s directory, as a baseDir-relative POSIX path ('' for baseDir
// itself); null when a `..` escapes the root.
export function applyToDir(fromFile, segments) {
  const resolved = []
  for (const part of [...fromFile.split('/').slice(0, -1), ...segments]) {
    if (part === '.' || part === '') continue
    if (part !== '..') resolved.push(part)
    else if (resolved.length === 0) return null
    else resolved.pop()
  }
  return resolved.join('/')
}

// A `.`-led name such as `..cache/a.php` is a bare specifier, not a relative one.
export const isDotRelative = (spec) => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')

export function* ancestors(dir) {
  for (; dir !== dirname(dir); dir = dirname(dir)) yield dir
  yield dir
}

// Whether `rel` is a file: one of `known` (a tree pass's sources) where given, else one on disk under `baseDir`;
// with neither, none is.
export const isFileIn = (rel, known, baseDir) => (known ? known.has(rel) : Boolean(baseDir) && isFile(join(baseDir, rel)))

// `bytes` of a `what` file as UTF-8: one that isn't is refused rather than carried with U+FFFD in it.
export const utf8Of = (what) => (bytes, relPath) => {
  if (!isUtf8(bytes)) throw new Error(`${what} is not valid UTF-8: ${relPath}`)
  return bytes.toString('utf8')
}

// A read of `relPath` that failed with a code `skipped` has is warned of as it says and left out (null), without
// aborting the walk; any other error is thrown.
export function skipRead(skipped, relPath, err) {
  if (!Object.hasOwn(skipped, err.code)) throw err
  console.warn(`${skipped[err.code]}: ${relPath}`)
  return null
}

// The files `entries` reach under `baseDir` through `host`, wave by wave, each `decode`d, `refsOf(relPath, content)`
// the paths each one reaches in turn; a failed read as skipRead takes it.
export function collectFromDisk(baseDir, entries, { decode, skipped, host = diskHost }, refsOf) {
  const sources = new Map()
  const realBase = host.realpath(baseDir)
  const read = (relPath) => {
    try {
      assertRealPathWithinBase(realBase, baseDir, relPath, host)
      return [relPath, decode(host.readFile(join(baseDir, relPath)), relPath)]
    } catch (err) {
      return skipRead(skipped, relPath, err)
    }
  }
  for (let wave = entries; wave.length > 0;) {
    const reads = [...new Set(wave)].filter((p) => !sources.has(p)).map(read)
    wave = []
    for (const [relPath, content] of reads.filter(Boolean)) {
      sources.set(relPath, content)
      for (const ref of refsOf(relPath, content)) wave.push(ref)
    }
  }
  return sources
}
