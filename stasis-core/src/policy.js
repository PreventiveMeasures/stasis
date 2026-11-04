import { posix } from 'node:path'

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
// a name matching it as itself or as a path matches a path pattern (no `*` across a scope's `/`).
function modulePattern(label, pattern) {
  const regex = compile(label, pattern, expandBraces(label, pattern))
  return { pattern, test: (name) => name === pattern || regex.test(name) }
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const listed = (items) => {
  const shown = items.slice(0, MAX_LISTED).join(', ')
  return items.length > MAX_LISTED ? `${shown}, and ${items.length - MAX_LISTED} more` : shown
}

// A dependency record as an error names it.
const packageText = ({ dir, name, version }) => `${name}${version === undefined ? '' : `@${version}`} at ${dir}`

// The paths an artifact (a Bundle, Lockfile or State: its `modules`, dir -> record, `formats`, file ->
// format, null where it holds none, and `config`, whose `scope` says what it records) carries, and the
// dependencies it does, each one holding a file: `{ paths: Set<path>, packages: [{ dir, name,
// version }] }`. A node_modules-scope one carries what is in node_modules alone, whatever else it
// holds in memory.
export function artifactContents({ modules, formats, config }) {
  const full = (config?.scope ?? 'full') === 'full'
  const paths = new Set()
  const packages = []
  for (const [dir, info] of modules) {
    const files = Object.keys(info.files)
    if (files.length === 0 || (!full && !hasNodeModulesSegment(dir))) continue
    for (const rel of files) paths.add(moduleFileKey(dir, rel))
    if (dependencyEcosystem(dir, info.ecosystem) !== undefined) packages.push({ dir, name: info.name, version: info.version ?? undefined })
  }
  for (const file of formats?.keys() ?? []) if (full || hasNodeModulesSegment(file)) paths.add(file)
  return { paths, packages }
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

  // Each rule's offenders among `paths` and `packages` (artifactContents'), as one problem a rule.
  #problems({ paths, packages }) {
    const problems = []
    for (const [key, patterns] of this.#rules) {
      const allowing = ALLOWING.has(key)
      const isPath = PATH_KEYS.has(key)
      const items = isPath ? [...paths].toSorted(sortPaths) : packages
      const offenders = []
      for (const item of items) {
        const match = patterns.find(({ test }) => test(isPath ? item : item.name))
        if (allowing ? match === undefined : match !== undefined) {
          const text = isPath ? item : packageText(item)
          offenders.push(allowing ? text : `${text} (${JSON.stringify(match.pattern)})`)
        }
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

  // Throws where `artifact` (artifactContents' argument) carries anything a rule refuses.
  assertArtifact(artifact, hint) {
    this.assert(artifactContents(artifact), hint)
  }

  // Throws where a rule refuses the path `path`, of the dependency `pkg` (`{ dir, name, version }`;
  // undefined for the project's own).
  assertPath(path, pkg) {
    this.assert({ paths: [path], packages: pkg === undefined ? [] : [pkg] })
  }
}

// The Policy of the rules `config` (a stasis.config.json, or an entry's options in it) sets, its
// errors `label`'s; null where it sets none.
export function parsePolicy(label, config) {
  if (config === null || typeof config !== 'object' || !POLICY_KEYS.some((key) => Object.hasOwn(config, key))) return null
  return new Policy(label, config)
}
