import { dirname } from 'node:path'

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
