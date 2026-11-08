import { posix, relative, resolve } from 'node:path'

import { dependencyEcosystem, hasNodeModulesSegment, moduleFileKeys, posixPathEscapes, sortedByPath, splitNodeModulesPath } from './artifact-util.js'
import { readJson } from './bundle-util.js'
import { relativeEscapes, toPosix } from './util.js'

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
  return text.indexOf(']', i)
}

// The first outermost `{...}` of `pattern` holding a `,` of its own (not a nested brace's) -> [start,
// [alternative...], end], or null where none does (a brace without one is itself).
function firstAlternation(pattern) {
  let depth = 0
  let open
  let commas
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      i++
    } else if (c === '[') {
      const close = classEnd(pattern, i)
      if (close !== -1) i = close
    } else if (c === '{') {
      if (depth++ === 0) [open, commas] = [i, []]
    } else if (c === ',' && depth === 1) {
      commas.push(i)
    } else if (c === '}' && depth > 0 && --depth === 0 && commas.length > 0) {
      const bounds = [open, ...commas, i]
      return [open, bounds.slice(1).map((end, k) => pattern.slice(bounds[k] + 1, end)), i]
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
    const close = c === '[' ? classEnd(segment, i) : -1
    if (c === '\\' && i + 1 < segment.length) {
      out += escapeRegExp(segment[++i])
    } else if (c === '*') {
      out += '[^/]*'
      while (segment[i + 1] === '*') i++
    } else if (c === '?') {
      out += '[^/]'
    } else if (close !== -1) {
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

// `alternatives` (brace-free patterns) as one RegExp of what any of them matches, followed by `suffix` (a
// RegExp source), its errors `pattern`'s.
function compile(label, pattern, alternatives, suffix = '') {
  try {
    return new RegExp(`^(?:${alternatives.map(patternSource).join('|')})${suffix}$`, 'u')
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
  if (alternatives.some(posixPathEscapes)) {
    throw new Error(`${label}: ${JSON.stringify(pattern)} must be a path or pattern within the directory of stasis.config.json`)
  }
  if (alternatives.includes('.')) return { pattern, test: () => true }
  // The path, or a directory above it: the pattern matching what comes before a `/` of it.
  const regex = compile(label, pattern, alternatives, '(?:/.*)?')
  const matchesRoot = alternatives.some((alternative) => alternative.split('/').every((segment) => segment === '**'))
  return { pattern, test: (path) => (path === '.' ? matchesRoot : regex.test(path)) }
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

const listed = (items) => {
  const shown = items.slice(0, MAX_LISTED).join(', ')
  return items.length > MAX_LISTED ? `${shown}, and ${items.length - MAX_LISTED} more` : shown
}

// The name a dependency recorded at `dir` is installed under: its node_modules directory's (a scope's two
// segments), as the package manager installed it; undefined for one in none.
const installedName = (dir) => splitNodeModulesPath(`${dir}/package.json`)?.name

// A dependency as an error names it: by its package.json's name, and the one it is installed under
// where that is another (an alias, or a package naming itself otherwise), or the link it is reached by.
const packageText = ({ dir, name, version, via }) => {
  const installed = installedName(dir)
  return `${name}${version === undefined ? '' : `@${version}`} at ${dir}` +
    `${installed === undefined || installed === name ? '' : ` (installed as ${installed})`}${via === undefined ? '' : ` (linked from ${via})`}`
}

// A path as an error names it, with the file it links to where it is a link.
const pathText = (path, real) => (real === undefined ? path : `${path} (a link to ${real})`)

// What follows a refusal of what an artifact already on disk records, at `path`.
export const recordedIn = (path) => ` -- recorded in ${path} already`

// The file `path` (from `root`, read through `host`) is a link to: its path from `realRoot`, the root's real
// path, where it is a link to another file within the root; undefined where it is no link, links out of
// the root, or is gone (a file a loaded artifact records, not on disk).
export function linkOf(host, root, realRoot, path) {
  const absolute = resolve(root, path)
  let real
  try {
    real = host.realpath(absolute)
  } catch {
    return undefined
  }
  if (real === absolute) return undefined
  const rel = toPosix(relative(realRoot, real)) || '.'
  return rel === path || relativeEscapes(rel) ? undefined : rel
}

// The dependency the file `real` (a path from `realRoot`, the project root's real path) is of, where it is
// in node_modules, reached through the link `via`: `{ dir, name, version, via }`, its name and version its
// package.json's, read through `host`, its name else the one it is installed under. Undefined where it is in
// no node_modules.
export function linkedPackage(host, realRoot, real, via) {
  const dir = splitNodeModulesPath(real)?.dir
  if (dir === undefined) return undefined
  const manifest = readJson(resolve(realRoot, dir, 'package.json'), host)
  const name = typeof manifest?.name === 'string' && manifest.name !== '' ? manifest.name : installedName(dir)
  return { dir, name, version: typeof manifest?.version === 'string' ? manifest.version : undefined, via }
}

// The paths an artifact (a Bundle, Lockfile or State: its `modules`, dir -> record, `formats`, file ->
// format, null where it holds none, and `config`, whose `scope` says what it records) carries, the
// dependencies it does, each one holding a file, and the real path of each path that is a link, found
// through `host` from `root`, the project root its paths are relative to: `{ paths: Set<path>, packages:
// [{ dir, name, version, via? }], links: Map<path, real path> }`. A node_modules-scope one carries what is
// in node_modules alone, whatever else it holds in memory. A link into a dependency is of that one too.
function artifactContents({ modules, formats, config }, { root, host }) {
  const scope = config?.scope ?? 'full'
  const inScope = (path) => scope === 'full' || hasNodeModulesSegment(path)
  const paths = moduleFileKeys(modules, { scope })
  for (const file of formats?.keys() ?? []) if (inScope(file)) paths.add(file)
  const packages = []
  for (const [dir, info] of modules) {
    if (Object.keys(info.files).length > 0 && inScope(dir) && dependencyEcosystem(dir, info.ecosystem) !== undefined) {
      packages.push({ dir, name: info.name, version: info.version ?? undefined })
    }
  }
  const links = new Map()
  let realRoot
  try {
    realRoot = host.realpath(root)
  } catch {
    return { paths, packages, links }
  }
  for (const path of paths) {
    const real = linkOf(host, root, realRoot, path)
    if (real === undefined) continue
    links.set(path, real)
    // Its package.json read once, for the first link into a dependency the artifact records none of.
    const dir = splitNodeModulesPath(real)?.dir
    if (dir !== undefined && !packages.some((pkg) => pkg.dir === dir)) packages.push(linkedPackage(host, realRoot, real, path))
  }
  return { paths, packages, links }
}

export class Policy {
  // What the errors are of: the stasis.config.json, or one of its entries.
  label
  // key -> [{ pattern, test }], of each rule set.
  #rules = new Map()
  // The rules as given, each list deduped and sorted.
  #given = {}

  constructor(label, config) {
    this.label = label
    for (const key of POLICY_KEYS) {
      const patterns = config[key]
      if (patterns === undefined) continue
      if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== 'string' || pattern === '')) {
        throw new TypeError(`${label}: ${key} must be an array of non-empty strings`)
      }
      const compileOne = PATH_KEYS.has(key) ? pathPattern : modulePattern
      this.#rules.set(key, patterns.map((pattern) => compileOne(`${label}: ${key}`, pattern)))
      this.#given[key] = [...new Set(patterns)].toSorted()
    }
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
  // rule, a path rule's in path order. A path is checked as itself and, a link, as the file it links to; a
  // dependency by its package.json's name and the one it is installed under: refused where a disallowing
  // rule matches either, allowed where an allowing rule matches both.
  #problems({ paths, packages, links = new Map() }) {
    const problems = []
    for (const [key, patterns] of this.#rules) {
      const allowing = ALLOWING.has(key)
      const isPath = PATH_KEYS.has(key)
      // Each offender, and after it the pattern refusing it: none for an allowing rule.
      const offenders = []
      for (const item of isPath ? paths : packages) {
        const names = isPath ? [item, links.get(item)] : [item.name, installedName(item.dir)]
        const matches = names.filter((name) => name !== undefined).map((name) => patterns.find(({ test }) => test(name)))
        const match = matches.find((found) => found !== undefined)
        if (allowing ? matches.includes(undefined) : match !== undefined) offenders.push({ item, by: allowing ? '' : ` (${JSON.stringify(match.pattern)})` })
      }
      if (offenders.length === 0) continue
      const texts = isPath
        ? sortedByPath(offenders, ({ item }) => item).map(({ item, by }) => `${pathText(item, links.get(item))}${by}`)
        : offenders.map(({ item, by }) => `${packageText(item)}${by}`)
      const many = `${texts.length} ${isPath ? 'paths' : 'packages'}: ${listed(texts)}`
      if (allowing) problems.push(texts.length === 1 ? `${key} does not allow ${texts[0]}` : `${key} allows none of ${many}`)
      else problems.push(`${key} refuses ${texts.length === 1 ? texts[0] : many}`)
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
  // followed through `host` from `root`; `hint` follows.
  assertArtifact(artifact, { hint, root, host }) {
    this.assert(artifactContents(artifact, { root, host }), hint)
  }

  // Throws where a rule refuses the path `path`, of the dependency `pkg` (`{ dir, name, version }`;
  // undefined for the project's own), a link where `link` is given: `{ real, pkg }`, the file it links to
  // (a path from the same root) and the dependency that is of (linkedPackage()'s, undefined for none).
  assertPath(path, pkg, link) {
    const packages = pkg === undefined ? [] : [pkg]
    if (link?.pkg !== undefined && link.pkg.dir !== pkg?.dir) packages.push(link.pkg)
    this.assert({ paths: [path], packages, links: link === undefined ? new Map() : new Map([[path, link.real]]) })
  }
}

// The Policy of the rules `config` (a stasis.config.json, or an entry's options in it) sets, its
// errors `label`'s; null where it sets none.
export function parsePolicy(label, config) {
  if (config === null || typeof config !== 'object' || !POLICY_KEYS.some((key) => Object.hasOwn(config, key))) return null
  return new Policy(label, config)
}
