import { posix } from 'node:path'

import { loadMinimatch } from './glob.js'

// Yarn 1.22.22's .yarnclean (autoclean's sortFilter and matchesFilter), on minimatch, for any package manager's tree:
// each path matched from the node_modules holding its package, as Yarn hoists it (.pnpm/x@1/node_modules/x/a as x/a).

export const YARNCLEAN = '.yarnclean'

const patternLines = (lines) => lines.filter((line) => !(line === '!' || line[0] === '#' || /^\s*$/u.test(line)))

// `regex` as micromatch's makeRe makes it for Yarn (trimmed, dot, nocase), `plain` as its isMatch does by default.
const NONE = /(?!)/u
function filterOf(line, { makeRe }) {
  const negation = line[0] === '!'
  const pattern = (negation ? line.slice(1) : line).replace(/\/$/u, '')
  return { negation, regex: makeRe(pattern.trim(), { dot: true, nocase: true }) || NONE, plain: makeRe(pattern) || NONE }
}

const matches = ({ regex, plain }, loc) => regex.test(loc) || regex.test(`/${loc}`) || regex.test(posix.basename(loc)) || plain.test(loc)

// Null for a node_modules itself or a dot-named entry of one: the package manager's own.
function packagePath(dir, path) {
  const segments = path.slice(dir.length + 1).split('/')
  const tail = segments.slice(segments.lastIndexOf('node_modules') + 1)
  return tail.length === 0 || tail[0].startsWith('.') ? null : tail.join('/')
}

// Its `keeps`: whether a `!` pattern keeps paths, so that what is cleaned of one package turns on what the others hold.
export function yarnclean(host, cwd) {
  const lines = []
  for (let dir = cwd; ; dir = posix.dirname(dir)) {
    const file = posix.join(dir, YARNCLEAN)
    if (host.stat(file)?.isFile()) lines.push(...patternLines(host.readFile(file).toString('utf8').split('\n')))
    if (dir === '/') break
  }
  if (lines.length === 0) return null
  const minimatch = loadMinimatch(`A ${YARNCLEAN}, which cleans the node_modules a lockfile lays out,`)
  const filters = lines.map((line) => filterOf(line, minimatch))
  const negations = filters.filter((filter) => filter.negation)
  const positives = filters.filter((filter) => !filter.negation)
  return Object.assign((vfs, dir) => {
    if (!vfs.isDirectory(dir)) return
    const entries = [...vfs.walk(dir)].slice(1).map(({ path, type }) => ({ path, type, loc: packagePath(dir, path) })).filter(({ loc }) => loc !== null)
    // A path a `!` filter matches is kept, and so is every directory holding one.
    const kept = new Set()
    const holdingKept = new Set()
    const keep = (path) => {
      kept.add(path)
      for (let up = posix.dirname(path); up !== dir; up = posix.dirname(up)) holdingKept.add(up)
    }
    for (const { path, loc } of negations.length === 0 ? [] : entries) if (negations.some((filter) => matches(filter, loc))) keep(path)
    // So is a link to either: pnpm links each package into its store, where Yarn's hoisted layout holds the package.
    const leadsToKept = (path) => {
      try {
        const real = vfs.realpath(path)
        return kept.has(real) || holdingKept.has(real)
      } catch {
        return false // a link to nothing, or a loop
      }
    }
    for (const { path, type } of kept.size === 0 ? [] : entries) if (type === 'symlink' && leadsToKept(path)) keep(path)
    // Any other a filter matches goes, with everything below it, but a directory holding a kept path stays with that.
    const matched = new Set()
    const matchedAbove = (path) => {
      for (let up = posix.dirname(path); up !== dir; up = posix.dirname(up)) if (matched.has(up)) return true
      return false
    }
    let gone = null
    for (const { path, loc } of entries) {
      if ((gone !== null && path.startsWith(gone)) || kept.has(path)) continue
      if (positives.some((filter) => matches(filter, loc))) matched.add(path)
      else if (!matchedAbove(path)) continue
      if (holdingKept.has(path)) continue
      vfs.rm(path, { recursive: true })
      gone = `${path}/`
    }
  }, { keeps: negations.length > 0 })
}
