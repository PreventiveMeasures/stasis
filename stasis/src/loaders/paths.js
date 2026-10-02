// Path checks shared by the source-language loaders.

import { isAbsolute, relative, resolve } from 'node:path'

import { toPosix } from '@exodus/stasis-core/util'

// Reject absolute and `..`-escaping paths in a `.<lang>.txt` listing so a malicious or sloppy
// listing can't read files outside the listing's own directory.
export function assertWithinBase(baseDir, candidate, label) {
  if (isAbsolute(candidate)) throw new Error(`${label} must not be absolute: ${candidate}`)
  const rel = toPosix(relative(baseDir, resolve(baseDir, candidate)))
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes baseDir: ${candidate}`)
  }
}

// Apply `segments` on `fromFile`'s directory, resolving '.'/'..'. Returns a baseDir-relative POSIX
// path ('' for baseDir itself), or null when traversal escapes the root.
export function applyToDir(fromFile, segments) {
  const fromDir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const parts = [...(fromDir ? fromDir.split('/') : []), ...segments]
  const resolved = []
  for (const part of parts) {
    if (part === '.' || part === '') continue
    if (part === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
    } else {
      resolved.push(part)
    }
  }
  return resolved.join('/')
}
