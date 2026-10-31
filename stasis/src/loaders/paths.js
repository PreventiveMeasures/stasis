// Path arithmetic shared by the source-language loaders.

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

// A `./`/`../` specifier, first segment `.` or `..` (a `.`-led NAME like `..cache/a.php` is a bare one).
export const isDotRelative = (spec) => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')
