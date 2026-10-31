import { createRequire } from 'node:module'
import { posix } from 'node:path'

// Node's own fs.globSync and path.matchesGlob over a `host` (@exodus/stasis-core/host) in place of
// the disk, for a Vfs's: Node 24.22.2's and 26.13.0's internal/fs/glob.js, its globSync as it runs
// without `followSymlinks`, `maxDepth` or an array `exclude`, over the minimatch 10 they vendor, an
// optional dependency loaded where a pattern is first matched. Unlike Node's, matching never folds
// case, whatever the OS: the tree is git's, whose names differ by case alone.

const { basename, join, resolve } = posix
const require = createRequire(import.meta.url)

const MINIMATCH = 'minimatch'
const MINIMATCH_MAJOR = '10'
// Node's createMatcher's, as on Linux.
const OPTIONS = { nocase: false, windowsPathsNoEscape: true, nonegate: true, nocomment: true, optimizationLevel: 2, platform: 'linux', nocaseMagicOnly: true }

let minimatch
function lazyMinimatch() {
  if (minimatch) return minimatch
  const needs = `A glob over a Vfs (stasis.config.json's extra) needs the optional '${MINIMATCH}' ${MINIMATCH_MAJOR} dependency`
  let version
  try {
    version = require(`${MINIMATCH}/package.json`).version
  } catch (cause) {
    throw new Error(`${needs}; install it (e.g. \`npm i ${MINIMATCH}@${MINIMATCH_MAJOR}\`)`, { cause })
  }
  // Another package's, found where the optional one isn't installed.
  if (version.split('.')[0] !== MINIMATCH_MAJOR) throw new Error(`${needs}, not ${version}`)
  minimatch = require(MINIMATCH)
  return minimatch
}

// Throws where globbing a Vfs can't load minimatch, before anything else is done.
export const checkGlob = () => void lazyMinimatch()

const createMatcher = (pattern) => new (lazyMinimatch().Minimatch)(pattern, OPTIONS)

const dirent = (name, type) => ({
  name,
  isFile: () => type === 'file',
  isDirectory: () => type === 'directory',
  isSymbolicLink: () => type === 'symlink',
})

// What `host` holds at `path`, its last link not followed, as lstat's Dirent; null where nothing is.
function lstatOf(host, path) {
  let link
  try {
    link = host.readlink(path)
  } catch {
    return null
  }
  if (link !== null) return dirent(basename(path), 'symlink')
  const stats = host.stat(path)
  if (stats === null) return null
  return dirent(basename(path), stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other')
}

class Cache {
  #host
  #cache = new Map()
  #statsCache = new Map()
  #readdirCache = new Map()

  constructor(host) {
    this.#host = host
  }
  statSync(path) {
    const cached = this.#statsCache.get(path)
    if (cached) {
      return cached
    }
    const val = lstatOf(this.#host, path)
    this.#statsCache.set(path, val)
    return val
  }
  addToStatCache(path, val) {
    this.#statsCache.set(path, val)
  }
  readdirSync(path) {
    const cached = this.#readdirCache.get(path)
    if (cached) {
      return cached
    }
    let val
    try {
      val = this.#host.readdir(path)
    } catch {
      val = []
    }
    this.#readdirCache.set(path, val)
    return val
  }
  add(path, pattern) {
    let cache = this.#cache.get(path)
    if (!cache) {
      cache = new Set()
      this.#cache.set(path, cache)
    }
    const originalSize = cache.size
    pattern.indexes.forEach((index) => cache.add(pattern.cacheKey(index)))
    return cache.size !== originalSize + pattern.indexes.size
  }
  seen(path, pattern, index) {
    return this.#cache.get(path)?.has(pattern.cacheKey(index))
  }
}

class Pattern {
  #pattern
  #globStrings
  indexes
  symlinks
  last

  constructor(pattern, globStrings, indexes, symlinks) {
    this.#pattern = pattern
    this.#globStrings = globStrings
    this.indexes = indexes
    this.symlinks = symlinks
    this.last = pattern.length - 1
  }

  isLast(isDirectory) {
    return this.indexes.has(this.last) ||
      (this.at(-1) === '' && isDirectory &&
      this.indexes.has(this.last - 1) && this.at(-2) === lazyMinimatch().GLOBSTAR)
  }
  isFirst() {
    return this.indexes.has(0)
  }
  get hasSeenSymlinks() {
    return [...this.indexes].some((i) => !this.symlinks.has(i))
  }
  at(index) {
    return this.#pattern.at(index)
  }
  child(indexes, symlinks = new Set()) {
    return new Pattern(this.#pattern, this.#globStrings, indexes, symlinks)
  }
  test(index, path) {
    if (index > this.#pattern.length) {
      return false
    }
    const pattern = this.#pattern[index]
    if (pattern === lazyMinimatch().GLOBSTAR) {
      return true
    }
    if (typeof pattern === 'string') {
      return pattern === path
    }
    if (typeof pattern?.test === 'function') {
      return pattern.test(path)
    }
    return false
  }

  cacheKey(index) {
    let key = ''
    for (let i = index; i < this.#globStrings.length; i++) {
      key += this.#globStrings[i]
      if (i !== this.#globStrings.length - 1) {
        key += '/'
      }
    }
    return key
  }
}

// Node's, but for `exclude`: given each path's absolute path (where Node gives its Dirent with
// `withFileTypes`), and in #addSubpattern, the path from the root (where Node's lstat takes it, as
// spelled from the root, from the process's cwd).
class Glob {
  #root
  #exclude
  #cache
  #results = new Set()
  #queue = []
  #subpatterns = new Map()
  #patterns

  constructor(host, pattern, { cwd, exclude }) {
    this.#root = cwd
    this.#exclude = exclude
    this.#cache = new Cache(host)
    const matcher = createMatcher(pattern)
    this.#patterns = matcher.set.map((set, i) => new Pattern(set, matcher.globParts[i], new Set().add(0), new Set()))
  }

  globSync() {
    this.#queue.push({ path: '.', patterns: this.#patterns })
    while (this.#queue.length > 0) {
      const item = this.#queue.pop()
      for (let i = 0; i < item.patterns.length; i++) {
        this.#addSubpatterns(item.path, item.patterns[i])
      }
      this.#subpatterns.forEach((patterns, path) => this.#queue.push({ path, patterns }))
      this.#subpatterns.clear()
    }
    return [...this.#results]
  }
  #isDirectorySync(stat, pattern) {
    if (stat?.isDirectory()) {
      return true
    }
    if (!stat?.isSymbolicLink()) {
      return false
    }
    return pattern.hasSeenSymlinks
  }
  #addSubpattern(path, pattern) {
    if (this.#exclude) {
      const fullpath = resolve(this.#root, path)
      if (this.#cache.statSync(fullpath) !== null && this.#exclude(fullpath)) {
        return
      }
    }
    if (!this.#subpatterns.has(path)) {
      this.#subpatterns.set(path, [pattern])
    } else {
      this.#subpatterns.get(path).push(pattern)
    }
  }
  #addSubpatterns(path, pattern) {
    const seen = this.#cache.add(path, pattern)
    if (seen) {
      return
    }
    const fullpath = resolve(this.#root, path)
    const stat = this.#cache.statSync(fullpath)
    const last = pattern.last
    const isDirectory = this.#isDirectorySync(stat, pattern)
    const isLast = pattern.isLast(isDirectory)
    const isFirst = pattern.isFirst()

    if (isFirst && pattern.at(0) === '') {
      // Absolute path, go to root
      this.#addSubpattern('/', pattern.child(new Set().add(1)))
      return
    }
    if (isFirst && pattern.at(0) === '..') {
      // Start with .., go to parent
      this.#addSubpattern('../', pattern.child(new Set().add(1)))
      return
    }
    if (isFirst && pattern.at(0) === '.') {
      // Start with ., proceed
      this.#addSubpattern('.', pattern.child(new Set().add(1)))
      return
    }

    if (isLast && typeof pattern.at(-1) === 'string') {
      // Add result if it exists
      const p = pattern.at(-1)
      const found = this.#cache.statSync(join(fullpath, p))
      if (found && (p || isDirectory)) {
        this.#results.add(join(path, p))
      }
      if (pattern.indexes.size === 1 && pattern.indexes.has(last)) {
        return
      }
    } else if (isLast && pattern.at(-1) === lazyMinimatch().GLOBSTAR &&
     (path !== '.' || pattern.at(0) === '.' || (last === 0 && stat))) {
      // If pattern ends with **, add to results
      // if path is ".", add it only if pattern starts with "." or pattern is exactly "**"
      this.#results.add(path)
    }

    if (!isDirectory) {
      return
    }

    let children
    const firstPattern = pattern.indexes.size === 1 && pattern.at(pattern.indexes.values().next().value)
    if (typeof firstPattern === 'string') {
      const child = this.#cache.statSync(join(fullpath, firstPattern))
      if (child) {
        child.name = firstPattern
        children = [child]
      } else {
        return
      }
    } else {
      children = this.#cache.readdirSync(fullpath)
    }

    for (let i = 0; i < children.length; i++) {
      const entry = children[i]
      const entryPath = join(path, entry.name)
      const entryFullpath = join(fullpath, entry.name)
      this.#cache.addToStatCache(entryFullpath, entry)
      const entryIsDirectory = entry.isDirectory()

      const subPatterns = new Set()
      const nSymlinks = new Set()
      for (const index of pattern.indexes) {
        // For each child, check potential patterns
        const current = pattern.at(index)
        const nextIndex = index + 1
        const next = pattern.at(nextIndex)
        const fromSymlink = pattern.symlinks.has(index)

        if (current === lazyMinimatch().GLOBSTAR) {
          const isDot = entry.name[0] === '.'
          const nextMatches = pattern.test(nextIndex, entry.name)

          let nextNonGlobIndex = nextIndex
          while (pattern.at(nextNonGlobIndex) === lazyMinimatch().GLOBSTAR) {
            nextNonGlobIndex++
          }

          const matchesDot = isDot && pattern.test(nextNonGlobIndex, entry.name)

          if ((isDot && !matchesDot) ||
              (this.#exclude && this.#exclude(entryFullpath))) {
            continue
          }
          if (!fromSymlink && entryIsDirectory) {
            // If directory, add ** to its potential patterns
            subPatterns.add(index)
          } else if (!fromSymlink && index === last) {
            // If ** is last, add to results
            this.#results.add(entryPath)
          }

          // Any pattern after ** is also a potential pattern
          // so we can already test it here
          if (nextMatches && nextIndex === last && !isLast) {
            // If next pattern is the last one, add to results
            this.#results.add(entryPath)
          } else if (nextMatches && entryIsDirectory) {
            // Pattern matched, meaning two patterns forward
            // are also potential patterns
            // e.g **/b/c when entry is a/b - add c to potential patterns
            subPatterns.add(index + 2)
          }
          if ((nextMatches || pattern.at(0) === '.') &&
           entryIsDirectory && !fromSymlink) {
            // If pattern after ** matches, or pattern starts with "."
            // and entry is a directory, add to potential patterns
            subPatterns.add(nextIndex)
          }

          if (entry.isSymbolicLink()) {
            nSymlinks.add(index)
          }

          if (next === '..' && entryIsDirectory) {
            // In case pattern is "**/..",
            // both parent and current directory should be added to the queue
            // if this is the last pattern, add to results instead
            const parent = join(path, '..')
            if (nextIndex < last) {
              if (!this.#subpatterns.has(path) && !this.#cache.seen(path, pattern, nextIndex + 1)) {
                this.#subpatterns.set(path, [pattern.child(new Set().add(nextIndex + 1))])
              }
              if (!this.#subpatterns.has(parent) && !this.#cache.seen(parent, pattern, nextIndex + 1)) {
                this.#subpatterns.set(parent, [pattern.child(new Set().add(nextIndex + 1))])
              }
            } else {
              if (!this.#cache.seen(path, pattern, nextIndex)) {
                this.#cache.add(path, pattern.child(new Set().add(nextIndex)))
                this.#results.add(path)
              }
              if (!this.#cache.seen(path, pattern, nextIndex) || !this.#cache.seen(parent, pattern, nextIndex)) {
                this.#cache.add(parent, pattern.child(new Set().add(nextIndex)))
                this.#results.add(parent)
              }
            }
          }
        }
        if (typeof current === 'string') {
          if (pattern.test(index, entry.name) && index !== last) {
            // If current pattern matches entry name
            // the next pattern is a potential pattern
            subPatterns.add(nextIndex)
          } else if (current === '.' && pattern.test(nextIndex, entry.name)) {
            // If current pattern is ".", proceed to test next pattern
            if (nextIndex === last) {
              this.#results.add(entryPath)
            } else {
              subPatterns.add(nextIndex + 1)
            }
          }
        }
        if (typeof current === 'object' && pattern.test(index, entry.name)) {
          // If current pattern is a regex that matches entry name (e.g *.js)
          // add next pattern to potential patterns, or to results if it's the last pattern
          if (index === last) {
            this.#results.add(entryPath)
          } else if (entryIsDirectory) {
            subPatterns.add(nextIndex)
          }
        }
      }
      if (subPatterns.size > 0) {
        // If there are potential patterns, add to queue
        this.#addSubpattern(entryPath, pattern.child(subPatterns, nSymlinks))
      }
    }
  }
}

// fs.globSync(pattern, { cwd, exclude }) over `host`, `cwd` an absolute path there: the matches as
// Node spells them, from `cwd` (or from `/`, of an absolute pattern), leaving out and never walking
// into a path `exclude` takes, given its absolute path.
export const globSync = (host, pattern, { cwd, exclude } = {}) => new Glob(host, pattern, { cwd, exclude }).globSync()

// As Node's matchGlobPattern keeps them: the most recent 250 patterns' matchers.
const MATCHERS_KEPT = 250
const matchers = new Map()

// path.matchesGlob(path, pattern), never folding case.
export function matchesGlob(path, pattern) {
  let matcher = matchers.get(pattern)
  if (matcher === undefined) {
    matcher = createMatcher(pattern)
    matchers.set(pattern, matcher)
    if (matchers.size >= MATCHERS_KEPT) matchers.delete(matchers.keys().next().value)
  }
  return matcher.match(path)
}
