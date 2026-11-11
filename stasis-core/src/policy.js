import { posix, relative, resolve } from 'node:path'

import { dependencyEcosystem, hasNodeModulesSegment, moduleFileKeys, posixPathEscapes, sortedByPath, splitNodeModulesPath } from './artifact-util.js'
import { readPackageJson } from './bundle-util.js'
import { diskHost } from './host.js'
import { memoized, relativeEscapes, toPosix } from './util.js'

// Each rule is checked on its own, and an artifact meets every Policy that applies: none overrides another.
export const POLICY_KEYS = ['allowedPaths', 'disallowedPaths', 'allowedModules', 'disallowedModules']
const PATH_KEYS = new Set(['allowedPaths', 'disallowedPaths'])
const ALLOWING = new Set(['allowedPaths', 'allowedModules'])

const MAX_ALTERNATIVES = 256
const MAX_LISTED = 20

// The patterns every glob reads alike; anything else (a class, an escape, an extglob, a range, a lone or nested
// brace) is refused, as Node's glob (`extra`'s) may read it otherwise.
const SIMPLE = /^(?:[\p{L}\p{N}_.@+\-/*?]|\{[\p{L}\p{N}_.@+\-/*?]*,[\p{L}\p{N}_.@+\-/*?,]*\})*$/u
const isSimple = (pattern) => SIMPLE.test(pattern) && !/[^/]\*\*|\*\*[^/]/u.test(pattern)

// As a shell expands brace lists, but for an empty alternative, which Node's glob drops (`{src,}` is `src` alone).
function alternativesOf(label, pattern) {
  if (!isSimple(pattern)) {
    throw new Error(`${label}: ${JSON.stringify(pattern)} is not supported: a pattern is names of letters, digits ` +
      'and `_.@+-`, with `*`, `?`, `**` as a whole name and `{a,b}` lists (none nested); match any other character with `?`')
  }
  let out = ['']
  for (const [, text, list] of pattern.matchAll(/([^{]*)(?:\{([^}]*)\})?/gu)) {
    out = out.flatMap((head) => (list === undefined ? [head + text] : list.split(',').map((item) => head + text + item)))
    if (out.length > MAX_ALTERNATIVES) throw new Error(`${label}: ${JSON.stringify(pattern)} expands to more than ${MAX_ALTERNATIVES} patterns`)
  }
  out = out.filter((alternative) => alternative !== '')
  if (out.length === 0) throw new Error(`${label}: ${JSON.stringify(pattern)} expands to no pattern`)
  return out
}

const escapeRegExp = (text) => text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, '\\$&')

// `*` and `?` match a dotfile's characters too, so `.env` doesn't slip past `**`.
const segmentSource = (segment) => segment.replaceAll(/[*?]|[^*?]+/gu, (part) => (part === '*' ? '[^/]*' : part === '?' ? '[^/]' : escapeRegExp(part)))

// A `**` segment is any number of segments, none included (`a/**` matches `a`, `**/b` matches `b`).
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

// `s`: a name may hold a line break, which `.*` (`**`, a directory's paths) must match too.
const compile = (alternatives, suffix = '') => new RegExp(`^(?:${alternatives.map(patternSource).join('|')})${suffix}$`, 'su')

// `src` takes in src/**; the root's own `--fs` listing (`.`) is matched by `.` and `**` alone.
function pathPattern(label, pattern) {
  const alternatives = alternativesOf(label, pattern).map((alternative) => posix.normalize(alternative).replace(/(?<=.)\/+$/u, ''))
  if (alternatives.some(posixPathEscapes)) {
    throw new Error(`${label}: ${JSON.stringify(pattern)} must be a path or pattern within the directory of stasis.config.json`)
  }
  if (alternatives.includes('.')) return { pattern, test: () => true }
  const regex = compile(alternatives, '(?:/.*)?')
  const matchesRoot = alternatives.some((alternative) => alternative.split('/').every((segment) => segment === '**'))
  return { pattern, test: (path) => (path === '.' ? matchesRoot : regex.test(path)) }
}

// A path such as node_modules/left-pad would match no name, and so silently refuse nothing.
function modulePattern(label, pattern) {
  const alternatives = alternativesOf(label, pattern)
  const named = (alternative) => {
    const segments = alternative.split('/')
    return segments.length <= 2 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== 'node_modules')
  }
  if (!alternatives.every(named)) throw new Error(`${label}: ${JSON.stringify(pattern)} is no package name or pattern of names (such as "left-pad", "@babel/*")`)
  const regex = compile(alternatives)
  return { pattern, test: (name) => name === pattern || regex.test(name) }
}

const listed = (items) => {
  const shown = items.slice(0, MAX_LISTED).join(', ')
  return items.length > MAX_LISTED ? `${shown}, and ${items.length - MAX_LISTED} more` : shown
}

const installedName = (dir) => splitNodeModulesPath(`${dir}/package.json`)?.name

const packageText = ({ dir, name, version, via }) => {
  const installed = installedName(dir)
  return `${name}${version === undefined ? '' : `@${version}`} at ${dir}` +
    `${installed === undefined || installed === name ? '' : ` (installed as ${installed})`}${via === undefined ? '' : ` (linked from ${via})`}`
}

export const recordedIn = (path) => ` -- recorded in ${path} already`

// The lookup gives { real, pkg } for a path linking to another file in the root, `pkg` the dependency that one is in.
export function linksOn(root, host = diskHost) {
  let realRoot
  try {
    realRoot = host.realpath(root)
  } catch {
    return () => undefined
  }
  const manifestOf = memoized((dir) => {
    const manifest = readPackageJson(realRoot, `${dir}/package.json`, { host })
    const name = typeof manifest?.name === 'string' && manifest.name !== '' ? manifest.name : installedName(dir)
    return { dir, name, version: typeof manifest?.version === 'string' ? manifest.version : undefined }
  })
  return memoized((path) => {
    const absolute = resolve(root, path)
    let real
    try {
      real = host.realpath(absolute)
    } catch {
      return undefined // gone: a file a loaded artifact records
    }
    if (real === absolute) return undefined
    const rel = toPosix(relative(realRoot, real)) || '.'
    if (rel === path || relativeEscapes(rel)) return undefined
    const dir = splitNodeModulesPath(rel)?.dir
    const pkg = dir === undefined ? undefined : manifestOf(dir)
    return { real: rel, pkg: pkg && { ...pkg, via: path } }
  })
}

// A node_modules-scope artifact carries node_modules alone; a link into a dependency counts as that dependency.
function artifactContents({ modules, formats, config }, linkOf) {
  const scope = config?.scope ?? 'full'
  const inScope = (path) => scope === 'full' || hasNodeModulesSegment(path)
  const paths = moduleFileKeys(modules, { scope })
  for (const file of formats?.keys() ?? []) if (inScope(file)) paths.add(file)
  const isPackage = ([dir, info]) => Object.keys(info.files).length > 0 && inScope(dir) && dependencyEcosystem(dir, info.ecosystem) !== undefined
  const packages = [...modules].filter(isPackage).map(([dir, { name, version }]) => ({ dir, name, version: version ?? undefined }))
  const dirs = new Set(packages.map(({ dir }) => dir))
  const links = new Map()
  for (const path of paths) {
    const link = linkOf(path)
    if (link === undefined) continue
    links.set(path, link.real)
    if (link.pkg !== undefined && !dirs.has(link.pkg.dir)) {
      dirs.add(link.pkg.dir)
      packages.push(link.pkg)
    }
  }
  return { paths, packages, links }
}

class Policy {
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

  get key() {
    return JSON.stringify(this.#given)
  }

  withLabel(label) {
    return new Policy(label, this.#given)
  }

  // A path is checked as its link's target too; a dependency by its package.json name and its install name:
  // refused if a disallowing rule matches either, allowed only if an allowing rule matches both.
  #problems({ paths, packages, links = new Map() }) {
    const problems = []
    for (const [key, patterns] of this.#rules) {
      const allowing = ALLOWING.has(key)
      const isPath = PATH_KEYS.has(key)
      const offenders = []
      for (const item of isPath ? paths : packages) {
        const names = isPath ? [item, links.get(item)] : [item.name, installedName(item.dir)]
        const matches = names.filter((name) => name !== undefined).map((name) => patterns.find(({ test }) => test(name)))
        const match = matches.find((found) => found !== undefined)
        if (allowing ? matches.includes(undefined) : match !== undefined) offenders.push({ item, by: allowing ? '' : ` (${JSON.stringify(match.pattern)})` })
      }
      if (offenders.length === 0) continue
      const texts = isPath
        ? sortedByPath(offenders, ({ item }) => item).map(({ item, by }) => `${item}${links.has(item) ? ` (a link to ${links.get(item)})` : ''}${by}`)
        : offenders.map(({ item, by }) => `${packageText(item)}${by}`)
      const many = `${texts.length} ${isPath ? 'paths' : 'packages'}: ${listed(texts)}`
      if (allowing) problems.push(texts.length === 1 ? `${key} does not allow ${texts[0]}` : `${key} allows none of ${many}`)
      else problems.push(`${key} refuses ${texts.length === 1 ? texts[0] : many}`)
    }
    return problems
  }

  assert(contents, hint = '') {
    const problems = this.#problems(contents)
    if (problems.length > 0) throw new Error(`${this.label}: ${problems.join('; ')}${hint}`)
  }

  assertArtifact(artifact, { hint, links }) {
    this.assert(artifactContents(artifact, links), hint)
  }

  assertPath(path, pkg, link) {
    const packages = pkg === undefined ? [] : [pkg]
    if (link?.pkg !== undefined && link.pkg.dir !== pkg?.dir) packages.push(link.pkg)
    this.assert({ paths: [path], packages, links: link === undefined ? new Map() : new Map([[path, link.real]]) })
  }
}

export const parsePolicy = (label, config) =>
  (config === null || typeof config !== 'object' || !POLICY_KEYS.some((key) => Object.hasOwn(config, key)) ? null : new Policy(label, config))
