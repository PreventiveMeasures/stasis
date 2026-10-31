import { posix } from 'node:path'

import { loadMinimatch } from './glob.js'

// Yarn 1's .yarnclean, which `yarn autoclean` (and `yarn install`, where the lockfile's directory
// holds one) cleans node_modules by: each line a pattern of paths to remove, `!` one of paths to
// keep, `#` a comment. Here every .yarnclean in the directory installed or above it cleans the tree
// a package manager lays out, whichever it is, as Yarn 1.22.22's autoclean cleans its own
// (sortFilter and matchesFilter, src/util/filter.js), on minimatch with the options Yarn gives
// micromatch. A path is matched from the node_modules directory holding its package, as Yarn's
// hoisted layout has it (pnpm's .pnpm/x@1/node_modules/x/README.md as x/README.md), and none of the
// package manager's own (.bin, .pnpm, .modules.yaml) is.

export const YARNCLEAN = '.yarnclean'

// The lines ignoreLinesToRegex takes for patterns: no comment, blank line or bare `!`.
const patternLines = (lines) => lines.filter((line) => !(line === '' || line === '!' || line[0] === '#' || /^\s+$/u.test(line)))

// ignoreLinesToRegex's filter of a line, with the expressions matchesFilter matches by: `regex`, of
// its trimmed spelling as micromatch's makeRe makes one for Yarn, dotfiles and all, case aside, and
// `plain`, of the pattern as micromatch's isMatch takes it, by default; never matching where the
// pattern makes none.
const NONE = /(?!)/u
function filterOf(line, { makeRe }) {
  const negation = line[0] === '!'
  const pattern = (negation ? line.slice(1) : line).replace(/\/$/u, '')
  return { negation, regex: makeRe(pattern.trim(), { dot: true, nocase: true }) || NONE, plain: makeRe(pattern) || NONE }
}

// matchesFilter: a path from the node_modules directory holding its package, by its whole spelling,
// from `/`, or by its name.
const matches = ({ regex, plain }, loc) => regex.test(loc) || regex.test(`/${loc}`) || regex.test(posix.basename(loc)) || plain.test(loc)

// The path of `path` from the innermost node_modules directory below `dir` holding it, or `dir`;
// null for the package manager's own: a dot-named entry of one, or that directory itself.
function packagePath(dir, path) {
  const segments = path.slice(dir.length + 1).split('/')
  const tail = segments.slice(segments.lastIndexOf('node_modules') + 1)
  return tail.length === 0 || tail[0].startsWith('.') ? null : tail.join('/')
}

// Of every .yarnclean in `cwd` and the directories above it, read through `host`: a function
// cleaning the node_modules directory at a path of a Vfs as sortFilter cleans one, or null where
// none holds a pattern. minimatch is loaded here, where one does: before anything is installed.
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
  return (vfs, dir) => {
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
    // So is a link to a path kept, or to a directory holding one, as that is, wherever it is: pnpm
    // links each package (under its scope's directory) into its store, where Yarn's hoisted layout
    // holds the package itself.
    const leadsToKept = (path) => {
      let real
      try {
        real = vfs.realpath(path)
      } catch {
        return false // a link to nothing, or a loop
      }
      return kept.has(real) || holdingKept.has(real)
    }
    for (const { path, type } of kept.size === 0 ? [] : entries) if (type === 'symlink' && leadsToKept(path)) keep(path)
    // Any other a filter matches goes, or below a directory one matches, everything below it with
    // it, but a directory holding a kept path: it stays with that, and what else is below it goes.
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
  }
}
