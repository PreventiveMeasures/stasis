// Path arithmetic shared by the source-language loaders.

// Apply `segments` on `fromFile`'s directory, resolving '.'/'..'. Returns a baseDir-relative POSIX
// path ('' for baseDir itself), or null when traversal escapes the root.
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

// A `./`/`../` specifier, first segment `.` or `..` (a `.`-led NAME like `..cache/a.php` is a bare one).
export const isDotRelative = (spec) => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')
