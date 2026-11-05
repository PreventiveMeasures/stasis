import { isAbsolute, posix, relative, resolve } from 'node:path'

import { dependencyEcosystem, hasNodeModulesSegment, moduleFileKey, sortPaths } from './artifact-util.js'

// stasis.config.json's restrictions on what an artifact carries, each a list of patterns: every path
// it carries matching one of `allowedPaths` (where set) and none of `disallowedPaths`, every
// dependency it carries, by name, one of `allowedModules` (where set) and none of
// `disallowedModules`. Each is its own rule, checked on its own: a Policy holds the four of one
// config (the top level, or one of `entries`), and an artifact meets every Policy that applies to it,
// none of which overrides another.
export const POLICY_KEYS = ['allowedPaths', 'disallowedPaths', 'allowedModules', 'disallowedModules']
const PATH_KEYS = new Set(['allowedPaths', 'disallowedPaths'])
const ALLOWING = new Set(['allowedPaths', 'allowedModules'])

// The `{a,b}` alternatives of a pattern no more than this many.
const MAX_ALTERNATIVES = 256
// Offenders named in an error, the rest counted.
const MAX_LISTED = 20

// The index of the `]` closing the class `[` at `at` opens (`[!...]` / `[^...]`, a `]` first taken as
// a member), or -1 where none does in `text`.
function classEnd(text, at) {
  let i = at + 1
  if (text[i] === '!' || text[i] === '^') i++
  if (text[i] === ']') i++
  const close = text.indexOf(']', i)
  return close === -1 ? -1 : close
}

// The first `{...}` of `pattern` holding a `,` at its own depth -> [start, [alternative...], end], or
// null where none does (a brace without one is itself).
function firstAlternation(pattern) {
  const stack = []
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      i++
    } else if (c === '[') {
      const close = classEnd(pattern, i)
      if (close !== -1) i = close
    } else if (c === '{') {
      stack.push({ open: i, commas: [] })
    } else if (c === ',' && stack.length > 0) {
      stack.at(-1).commas.push(i)
    } else if (c === '}' && stack.length > 0) {
      const { open, commas } = stack.pop()
      if (stack.length === 0 && commas.length > 0) {
        const bounds = [open, ...commas, i]
        return [open, bounds.slice(1).map((end, k) => pattern.slice(bounds[k] + 1, end)), i]
      }
    }
  }
  return null
}

// `pattern` with each `{a,b}` expanded, as a shell expands it: the patterns it stands for.
function expandBraces(label, pattern) {
  const queue = [pattern]
  const out = []
  while (queue.length > 0) {
    const next = queue.shift()
    const found = firstAlternation(next)
    if (found === null) {
      out.push(next)
    } else {
      const [start, alternatives, end] = found
      for (const alternative of alternatives) queue.push(`${next.slice(0, start)}${alternative}${next.slice(end + 1)}`)
    }
    if (queue.length + out.length > MAX_ALTERNATIVES) throw new Error(`${label}: ${JSON.stringify(pattern)} expands to more than ${MAX_ALTERNATIVES} patterns`)
  }
  return out
}

const escapeRegExp = (text) => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&')

// One `/`-free segment of a pattern as a RegExp source: `*` any run of characters but `/`, `?` one,
// `[...]` one of a class, `\x` an `x`; every other character itself. A dot is a character like any:
// a wildcard matches a dotfile too.
function segmentSource(segment) {
  let out = ''
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (c === '\\' && i + 1 < segment.length) {
      out += escapeRegExp(segment[++i])
    } else if (c === '*') {
      out += '[^/]*'
      while (segment[i + 1] === '*') i++
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '[' && classEnd(segment, i) !== -1) {
      const close = classEnd(segment, i)
      let body = segment.slice(i + 1, close)
      const negated = body[0] === '!' || body[0] === '^'
      if (negated) body = body.slice(1)
      out += `[${negated ? '^/' : ''}${body.replaceAll(/[[\\\]^]/gu, '\\$&')}]`
      i = close
    } else {
      out += escapeRegExp(c)
    }
  }
  return out
}

// A brace-free pattern as a RegExp source: its segments, a `**` segment standing for any number of
// them, none included (`a/**` matches `a`, `**/b` matches `b`).
function patternSource(pattern) {
  const segments = pattern.split('/').filter((segment, i, all) => !(segment === '**' && all[i - 1] === '**'))
  let out = ''
  for (const [i, segment] of segments.entries()) {
    const first = i === 0
    const last = i === segments.length - 1
    if (segment === '**') {
      out += first && last ? '.*' : first ? '(?:.*/)?' : last ? '(?:/.*)?' : '/(?:.*/)?'
    } else {
      if (!first && segments[i - 1] !== '**') out += '/'
      out += segmentSource(segment)
    }
  }
  return out
}

// `alternatives` (brace-free patterns) as one RegExp of what any of them matches, its errors `pattern`'s.
function compile(label, pattern, alternatives) {
  try {
    return new RegExp(`^(?:${alternatives.map(patternSource).join('|')})$`, 'u')
  } catch (cause) {
    throw new Error(`${label}: ${JSON.stringify(pattern)} is not a valid pattern`, { cause })
  }
}

// A path pattern: relative to the directory of the stasis.config.json, within it, `./` and a
// trailing `/` ignored, `.` that directory itself. -> { pattern, test(path) }, where `path` is a path
// an artifact carries, relative to that directory: matched where the pattern matches it, or a
// directory above it (`src` takes in everything under src/). `.` takes in every path, and the root's
// own listing (a `--fs` capture of it, spelled `.`) is matched by `.` and `**` alone.
function pathPattern(label, pattern) {
  const alternatives = expandBraces(label, pattern).map((alternative) => posix.normalize(alternative).replace(/(?<=.)\/+$/u, ''))
  if (alternatives.some((alternative) => alternative.startsWith('/') || alternative.split('/').includes('..'))) {
    throw new Error(`${label}: ${JSON.stringify(pattern)} must be a path or pattern within the directory of stasis.config.json`)
  }
  if (alternatives.includes('.')) return { pattern, test: () => true }
  const regex = compile(label, pattern, alternatives)
  const matchesRoot = alternatives.some((alternative) => alternative.split('/').every((segment) => segment === '**'))
  return {
    pattern,
    test(path) {
      if (path === '.') return matchesRoot
      if (regex.test(path)) return true
      for (let slash = path.lastIndexOf('/'); slash > 0; slash = path.lastIndexOf('/', slash - 1)) {
        if (regex.test(path.slice(0, slash))) return true
      }
      return false
    },
  }
}

// A module pattern: a package's name (`left-pad`, `@babel/core`), or a pattern of names (`@babel/*`),
// a name matching it as itself or as a path matches a path pattern (no `*` across a scope's `/`). Each of
// its `{a,b}` alternatives is the shape of a name, of one segment or a scope's two, none `.`, `..` or
// `node_modules`: a path (`node_modules/left-pad`) would match no name, and refuse nothing.
function modulePattern(label, pattern) {
  const alternatives = expandBraces(label, pattern)
  const named = (alternative) => {
    const segments = alternative.split('/')
    return segments.length <= 2 && !/[\\\s]/u.test(alternative) && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== 'node_modules')
  }
  if (!alternatives.every(named)) throw new Error(`${label}: ${JSON.stringify(pattern)} is no package name or pattern of names (such as "left-pad", "@babel/*")`)
  const regex = compile(label, pattern, alternatives)
  return { pattern, test: (name) => name === pattern || regex.test(name) }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const listed = (items) => {
  const shown = items.slice(0, MAX_LISTED).join(', ')
  return items.length > MAX_LISTED ? `${shown}, and ${items.length - MAX_LISTED} more` : shown
}

// The package a path is in by its innermost node_modules directory, as the package manager installed it
// there: `{ dir, name }` (`name` the directory's, a scope's two segments), or undefined where it is in none.
export function installedAt(path) {
  const segments = path.split('/')
  const at = segments.lastIndexOf('node_modules')
  if (at === -1 || at === segments.length - 1) return undefined
  const length = segments[at + 1].startsWith('@') && at + 2 < segments.length ? 2 : 1
  return { dir: segments.slice(0, at + 1 + length).join('/'), name: segments.slice(at + 1, at + 1 + length).join('/') }
}

// A dependency as an error names it: by its package.json's name, and the one it is installed under
// where that is another (an alias, or a package naming itself otherwise), or the link it is reached by.
const packageText = ({ dir, name, version, installed, via }) => `${name}${version === undefined ? '' : `@${version}`} at ${dir}` +
  `${installed === undefined || installed === name ? '' : ` (installed as ${installed})`}${via === undefined ? '' : ` (linked from ${via})`}`

// A path as an error names it, with the file it links to where it is a link.
const pathText = (path, real) => (real === undefined ? path : `${path} (a link to ${real})`)

// `path`'s real path through `host`, from `realRoot` (the project root's), where that is another path
// within it; undefined where it is the same, out of it, or none (a file a loaded artifact records, gone
// from disk).
function linkedPath(host, root, realRoot, path) {
  let real
  try {
    real = host.realpath(resolve(root, path))
  } catch {
    return undefined
  }
  const rel = relative(realRoot, real).replaceAll('\\', '/') || '.'
  return rel === path || rel === '..' || rel.startsWith('../') || isAbsolute(rel) ? undefined : rel
}

// The real path of each of `paths` that is a link, as linkedPath() finds it, where a `root` (the
// project's, which `paths` are relative to) and its `host` are given. -> Map<path, real path>
function linksOf(paths, { root, host } = {}) {
  const links = new Map()
  if (root === undefined || host === undefined) return links
  let realRoot
  try {
    realRoot = host.realpath(root)
  } catch {
    return links
  }
  for (const path of paths) {
    const real = linkedPath(host, root, realRoot, path)
    if (real !== undefined) links.set(path, real)
  }
  return links
}

// The paths an artifact (a Bundle, Lockfile or State: its `modules`, dir -> record, `formats`, file ->
// format, null where it holds none, and `config`, whose `scope` says what it records) carries, the
// dependencies it does, each one holding a file, and the real path of each path that is a link, found on
// `disk` (`{ root, host }`: the project root its paths are relative to, and the host reading it), where
// given: `{ paths: Set<path>, packages: [{ dir, name, version, installed }], links: Map<path, real
// path> }`, `installed` the name a dependency in node_modules is installed under (installedAt()). A
// node_modules-scope one carries what is in node_modules alone, whatever else it holds in memory.
export function artifactContents({ modules, formats, config }, disk) {
  const full = (config?.scope ?? 'full') === 'full'
  const paths = new Set()
  const packages = []
  for (const [dir, info] of modules) {
    const files = Object.keys(info.files)
    if (files.length === 0 || (!full && !hasNodeModulesSegment(dir))) continue
    for (const rel of files) paths.add(moduleFileKey(dir, rel))
    if (dependencyEcosystem(dir, info.ecosystem) !== undefined) packages.push({ dir, name: info.name, version: info.version ?? undefined, installed: installedAt(dir)?.name })
  }
  for (const file of formats?.keys() ?? []) if (full || hasNodeModulesSegment(file)) paths.add(file)
  return { paths, packages, links: linksOf(paths, disk) }
}

export class Policy {
  // What the errors are of: the stasis.config.json, or one of its entries.
  label
  // key -> [{ pattern, test }], of each rule set.
  #rules = new Map()
  #given

  constructor(label, config) {
    this.label = label
    const given = {}
    for (const key of POLICY_KEYS) {
      const patterns = config[key]
      if (patterns === undefined) continue
      if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== 'string' || pattern === '')) {
        throw new TypeError(`${label}: ${key} must be an array of non-empty strings`)
      }
      const compileOne = PATH_KEYS.has(key) ? pathPattern : modulePattern
      this.#rules.set(key, patterns.map((pattern) => compileOne(`${label}: ${key}`, pattern)))
      given[key] = [...new Set(patterns)].toSorted()
    }
    this.#given = given
  }

  // The rules as given, in one canonical string: two Policies with the same are the same Policy.
  get key() {
    return JSON.stringify(this.#given)
  }

  // The same rules, their errors `label`'s.
  withLabel(label) {
    return new Policy(label, this.#given)
  }

  // Each rule's offenders among `paths`, `packages` and `links` (artifactContents'), as one problem a
  // rule. A path is checked as itself and, a link, as the file it links to; a dependency by its
  // package.json's name and the one it is installed under: refused where a disallowing rule matches
  // either, allowed where an allowing rule matches both. A link to a file in node_modules is of the
  // package installed there too.
  #problems({ paths, packages, links = new Map() }) {
    const linked = [...links].map(([path, real]) => ({ ...installedAt(real), via: path })).filter(({ dir }) => dir !== undefined)
    const dependencies = [...packages, ...linked.filter(({ dir }) => !packages.some((pkg) => pkg.dir === dir)).map((pkg) => ({ ...pkg, installed: pkg.name }))]
    const problems = []
    for (const [key, patterns] of this.#rules) {
      const allowing = ALLOWING.has(key)
      const isPath = PATH_KEYS.has(key)
      const items = isPath ? [...paths].toSorted(sortPaths) : dependencies
      const offenders = []
      for (const item of items) {
        const names = isPath ? [item, links.get(item)] : [item.name, item.installed]
        const matches = [...new Set(names.filter((name) => name !== undefined))].map((name) => patterns.find(({ test }) => test(name)))
        const text = isPath ? pathText(item, links.get(item)) : packageText(item)
        if (allowing && matches.includes(undefined)) offenders.push(text)
        const match = matches.find((found) => found !== undefined)
        if (!allowing && match !== undefined) offenders.push(`${text} (${JSON.stringify(match.pattern)})`)
      }
      if (offenders.length === 0) continue
      const what = isPath ? 'path' : 'package'
      if (allowing) problems.push(offenders.length === 1 ? `${key} does not allow ${offenders[0]}` : `${key} allows none of ${plural(offenders.length, what)}: ${listed(offenders)}`)
      else problems.push(`${key} refuses ${offenders.length === 1 ? offenders[0] : `${plural(offenders.length, what)}: ${listed(offenders)}`}`)
    }
    return problems
  }

  // Throws naming every offender of every rule among what `contents` (artifactContents') holds, where
  // there is one; `hint` follows.
  assert(contents, hint = '') {
    const problems = this.#problems(contents)
    if (problems.length > 0) throw new Error(`${this.label}: ${problems.join('; ')}${hint}`)
  }

  // Throws where `artifact` (artifactContents' argument) carries anything a rule refuses, its links
  // followed on `disk` where it is given; `hint` follows.
  assertArtifact(artifact, { hint, ...disk } = {}) {
    this.assert(artifactContents(artifact, disk), hint)
  }

  // Throws where a rule refuses the path `path`, of the dependency `pkg` (`{ dir, name, version }`;
  // undefined for the project's own), a link to `real` (a path from the same root) where that is given.
  assertPath(path, pkg, real) {
    const packages = pkg === undefined ? [] : [{ ...pkg, installed: installedAt(pkg.dir)?.name }]
    this.assert({ paths: [path], packages, links: real === undefined || real === path ? new Map() : new Map([[path, real]]) })
  }
}

// The Policy of the rules `config` (a stasis.config.json, or an entry's options in it) sets, its
// errors `label`'s; null where it sets none.
export function parsePolicy(label, config) {
  if (config === null || typeof config !== 'object' || !POLICY_KEYS.some((key) => Object.hasOwn(config, key))) return null
  return new Policy(label, config)
}
