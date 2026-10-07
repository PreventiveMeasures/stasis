// The pure half of the util split: the artifact data model shared by bundle.js, lockfile.js and
// shard.js (the format universe, flat file keys, strict merges, the executable-set rules and the
// JSON<->Map converters). No Node builtin imports, so `./bundle` and `./lockfile` load in any JS
// runtime. util.js re-exports this module, so `@exodus/stasis-core/util` serves the full set.

// KNOWN_FORMATS is the closed universe of `format` strings; parsers reject anything outside it.
export const NODE_FORMATS = new Set(['module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript'])
export const SOURCE_LANGUAGE_FORMATS = new Set(['solidity', 'php', 'shell', 'rust'])
export const NATIVE_BUILD_FORMATS = new Set([
  'java', 'kotlin', 'gradle', 'objc', 'objcpp', 'swift', 'c', 'cpp', 'c-header', 'cpp-header',
  'ruby', 'python', 'cmake', 'podspec', 'podfile', 'podfile-lock', 'template', 'xml', 'env', 'fastlane', 'pbxproj',
])
export const RESOURCE_FORMATS = new Set(['resource', 'resource:base64'])
export const STAT_FORMATS = new Set(['stat:file', 'stat:directory'])
export const KNOWN_FORMATS = new Set([
  ...NODE_FORMATS,
  ...SOURCE_LANGUAGE_FORMATS,
  ...NATIVE_BUILD_FORMATS,
  ...RESOURCE_FORMATS,
  'patch', // a `.patch` unified diff (pnpm patchedDependencies, patch-package): UTF-8 text applied by a patch step
  'directory',
  ...STAT_FORMATS,
])

// Payload-free stat records: attest a path's KIND, no content, and yield to a real format.
export const isStatFormat = (format) => STAT_FORMATS.has(format)

// Reserved synthetic file a disabled import (a `browser`/`react-native` field mapping it to `false`)
// points at: never on disk, carried as empty CommonJS so the edge resolves to attested bytes.
export const EMPTY_MODULE_PATH = '.stasis/empty-module.js'

// The post-erasure family of a '-typescript' loader format ('module-typescript' -> 'module'): a
// transforming preload (`stasis run --import tsx`) resolves/serves a TypeScript file as the JS
// family it transpiles to, while the attestation keeps the on-disk format. undefined otherwise.
export const erasedTypeScriptFormat = (format) =>
  format === 'module-typescript' ? 'module' : format === 'commonjs-typescript' ? 'commonjs' : undefined

const formatKind = (format) => (format === 'directory' || format === 'stat:directory' ? 'directory' : 'file')

// A weak 'stat:*' yields to a real format of the SAME kind and never displaces one; anything else throws.
export function reconcileFormat(format, currentFormat, name) {
  if (format === currentFormat) return format
  const stat = isStatFormat(format)
  if (stat !== isStatFormat(currentFormat) && formatKind(format) === formatKind(currentFormat)) {
    return stat ? currentFormat : format
  }
  throw new Error(`format conflict for '${name}' ('${currentFormat}' vs '${format}')`)
}

// Flat project-relative key. `rel === ''` (a `directory` capture whose path IS a module root) keys the
// bare dir, never `${dir}/` -- a trailing slash breaks the round-trip.
export function moduleFileKey(dir, rel) {
  if (rel === '') return dir
  return dir === '.' ? rel : `${dir}/${rel}`
}

// GitHub `owner/name` (owner 1-39, name 1-100 chars).
const GITHUB_REPO = /^(?=[A-Za-z0-9-]{1,39}\/)[A-Za-z0-9](?:-?[A-Za-z0-9])*\/(?!\.\.?$)[\w.-]{1,100}$/u
// Non-empty normalized repo-relative path of URL-safe segments.
const REPO_DIRECTORY = /^(?!\.\.?(?:\/|$))[\w.~@+-]+(?:\/(?!\.\.?(?:\/|$))[\w.~@+-]+)*$/u
// Full lowercase SHA-1 or SHA-256.
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
// The fields of a `repo`, the bundle's own or a dependency's, and their checks.
export const REPO_FIELDS = {
  github: (v) => typeof v === 'string' && GITHUB_REPO.test(v),
  // `''` is the repository's root.
  directory: (v) => typeof v === 'string' && v.length <= 1024 && (v === '' || REPO_DIRECTORY.test(v)),
  commit: (v) => typeof v === 'string' && GIT_SHA.test(v),
}

// Whether two GitHub `owner/name`s are one: GitHub's names are case-insensitive.
export const sameGithub = (a, b) => a?.toLowerCase() === b?.toLowerCase()

// Whether two `repo`s name the same place: every field alike, `github` in any case.
export const sameRepo = (a, b) => Object.keys(REPO_FIELDS).every((key) => (key === 'github' ? sameGithub(a.github, b.github) : a[key] === b[key]))

// Whether two records of one dependency agree on its `repo`: an artifact from before the field records none.
export const reposAgree = (a, b) => a === undefined || b === undefined || sameRepo(a, b)

// Validate a block against its `fields` (each optional: a check, or a nested block's fields), `what`
// naming it in errors; canonical, frozen, undefined if empty. Messages are built on failure alone: a
// dependency's `repo` is checked on every parse and write.
export const normalizeBlock = (block, fields, what) => {
  if (block === undefined) return undefined
  if (!isPlainObject(block)) assert(false, `${what} must be an object`)
  for (const key of Object.keys(block)) if (!Object.hasOwn(fields, key)) assert(false, `unknown ${what} key '${key}'`)
  const entries = Object.entries(fields).map(([key, check]) => {
    if (typeof check === 'object') return [key, normalizeBlock(block[key], check, `${what}.${key}`)]
    if (block[key] !== undefined && !check(block[key])) assert(false, `invalid ${what}.${key}: ${JSON.stringify(block[key])}`)
    return [key, block[key]]
  }).filter(([, value]) => value !== undefined)
  return entries.length === 0 ? undefined : Object.freeze(fromEntries(entries))
}

// Validate a `repo` (all fields optional); canonical key order, undefined if empty.
export const normalizeRepo = (repo, what = 'bundle repo') => normalizeBlock(repo, REPO_FIELDS, what)

// A bucket's ecosystem as a dependency's: its `ecosystem` tag, or npm for an untagged one under
// node_modules (an artifact from before the tag); undefined for first-party code.
export const dependencyEcosystem = (dir, ecosystem) => ecosystem ?? (hasNodeModulesSegment(dir) ? 'npm' : undefined)

// A dependency's `repo`, the one its own manifest names, with the bundle's own fields, `github`
// required: a `directory` or `commit` places nothing without the repository it is in. First-party
// code carries none.
const normalizeModuleRepo = (dir, { ecosystem, repo }, what) => {
  if (repo === undefined) return undefined
  if (dependencyEcosystem(dir, ecosystem) === undefined) assert(false, `${what}: '${dir}' is no dependency's bucket, and carries no repo`)
  const normalized = normalizeRepo(repo, `${what} module '${dir}' repo`)
  if (normalized?.github === undefined) assert(false, `${what} module '${dir}' repo has no github`)
  return normalized
}

// A module bucket record in canonical key order; `ecosystem` and `repo` are omitted (not undefined) when absent.
export const moduleInfo = ({ name, version, ecosystem, repo, files }) =>
  ({ name, version, ...(ecosystem === undefined ? {} : { ecosystem }), ...(repo === undefined ? {} : { repo }), files })

// A parsed bucket `dir` of a `what` artifact: an absent version has one spelling (a literal null folds
// into undefined so identity comparisons and JSON round-trips can't split on it), `repo` is validated,
// and `files` is null-prototype.
export function normalizeModule({ name, version, ecosystem, repo, files }, dir, what) {
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  return moduleInfo({ name, version: version ?? undefined, ecosystem, repo: normalizeModuleRepo(dir, { ecosystem, repo }, what), files: fromEntries(Object.entries(files)) })
}

// The keys a module map records -- the set an artifact's `executable` must be a subset of. `scope` MUST
// be the artifact's own: a non-full-scope artifact records only its node_modules buckets.
export function moduleFileKeys(modules, { scope = 'full' } = {}) {
  const keys = new Set()
  for (const [dir, { files }] of modules) {
    if (scope !== 'full' && !hasNodeModulesSegment(dir)) continue
    for (const rel of Object.keys(files)) keys.add(moduleFileKey(dir, rel))
  }
  return keys
}

// THE rule an artifact's `executable` entry must satisfy; returns the problem, or null when legal.
// parseExecutable (read), assertExecutable (write) and narrowExecutable share it so they cannot drift.
function executableEntryProblem(file, { what, files, formats, scope }) {
  if (file.includes('\\')) return "holds a '\\'"
  if (posixPathEscapes(file)) return 'escapes the root'
  if (scope !== 'full' && !hasNodeModulesSegment(file)) {
    return `is outside node_modules, which a '${scope}'-scope ${what} does not record`
  }
  if (!files.has(file)) return `names no file the ${what} records`
  const format = formats.get(file)
  if (format === 'directory') return 'is a directory capture, not a file'
  if (isStatFormat(format)) return `is a payload-free '${format}' record, not a file`
  return null
}

// Applied at every write site, so the in-memory artifact is honest before it is ever serialized.
export function narrowExecutable(executable, { modules, formats, scope }) {
  const out = new Set()
  if (executable.size === 0) return out
  const files = moduleFileKeys(modules, { scope })
  for (const file of executable) {
    if (executableEntryProblem(file, { what: 'artifact', files, formats, scope }) === null) out.add(file)
  }
  return out
}

function assertExecutable(executable, { what, files, formats, scope }) {
  for (const file of executable) {
    const problem = executableEntryProblem(file, { what, files, formats, scope })
    assert(problem === null, `${what}: executable entry '${file}' ${problem}`)
  }
}

export function parseExecutable(list, { what, files, formats, scope = 'full' }) {
  if (list === undefined) return new Set()
  const at = `${what}: executable`
  assert(Array.isArray(list), `${at} must be an array of file paths`)
  const out = new Set()
  for (const file of list) {
    assert(typeof file === 'string' && file !== '', `${at} entry must be a non-empty string`)
    // A dupe would silently collapse in out.add() and round-trip to different bytes.
    assert(!out.has(file), `${at} entry '${file}' is listed twice`)
    out.add(file)
  }
  assertExecutable(out, { what, files, formats, scope })
  return out
}

// The one choke point every producer goes through, so a write site that forgot to narrow fails HERE, not
// on the next read. Omitted when empty: keeps every pre-`executable` artifact byte-identical when rewritten.
export function serializeExecutable(executable, { what, modules, formats, scope }) {
  if (executable.size === 0) return undefined
  assertExecutable(executable, { what, files: moduleFileKeys(modules, { scope }), formats, scope })
  return fileSetToObject(executable)
}

export function assert(condition, msg) {
  if (!condition) throw new Error(msg)
}

export function sortPaths(a, b) {
  const [al, bl] = [a.split('/'), b.split('/')]
  while (al.length > 0 && al[0] === bl[0]) {
    al.shift()
    bl.shift()
  }
  if (al.length === 0 && bl.length === 0) return 0

  // First process each file in dir, then subdirs
  if (al.length < 2) return bl.length < 2 && al > bl ? 1 : -1
  if (bl.length < 2) return 1

  if (al[0] === '*') return -1
  if (bl[0] === '*') return 1

  if (al[0] === 'node_modules') return 1
  if (bl[0] === 'node_modules') return -1

  // Prefer example/ over example-something/
  const [an, bn] = [al, bl].map((list) => list.join(String.fromCodePoint(0)))
  if (an < bn) return -1
  if (an > bn) return 1
  throw new Error('Unreachable')
}

const byPath = (a, b) => sortPaths(a[0], b[0])

export const isPlainObject = (x) => x && [null, Object.prototype].includes(Object.getPrototypeOf(x))

export const fromEntries = (entries) => Object.setPrototypeOf(Object.fromEntries(entries), null)

export const fileSetToObject = (set) => [...set].toSorted(sortPaths)

// `sorted: false` only for a machine-only payload whose reader does not care about ordering (shard.js).
export const fileMapToObject = (map, { sorted = true } = {}) => {
  const entries = sorted ? [...map].toSorted(byPath) : [...map]
  return fromEntries(entries.map(([k, v]) => [k, v instanceof Map ? fileMapToObject(v, { sorted }) : v]))
}

// The Map at `map.get(key)`, created on first use.
export const nestedMap = (map, key) => map.get(key) ?? map.set(key, new Map()).get(key)

export const objectToMaps = (obj) => new Map(
  Object.entries(obj).map(([k, v]) => [k, isPlainObject(v) ? objectToMaps(v) : v])
)

// True for an absolute path or any `..` hop that pops above the root, INCLUDING a mid-path one
// (`a/../../x`) that plain `startsWith('..')` would miss. A segment walk (not posix.normalize, whose
// verdict it matches -- see posix-path-escapes.test.js) so this module stays free of node:path:
// `.` and empty segments are skipped exactly as normalize collapses them, a real segment pushes, and
// a `..` with nothing left to pop is an escape -- normalize would keep it as a leading `..` forever.
export function posixPathEscapes(path) {
  if (path.startsWith('/')) return true
  // The walk can only return true via a literal '..' segment, so the ordinary keys skip the split.
  if (!path.includes('..')) return false
  let depth = 0
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment !== '..') depth++
    else if (--depth < 0) return true
  }
  return false
}

// THE rule every path an artifact records must satisfy (a file key's too, see canonicalFileKey): in
// the root, and free of `\` -- part of a name off Windows, which stasis refuses everywhere rather than
// take for another path, and on Windows a separator a `..\x` would climb out by.
export const isRefusedPath = (path) => path.includes('\\') || posixPathEscapes(path)

// Throws unless `path`, one of `what`'s, is a path an artifact may record (see isRefusedPath).
export const assertArtifactPath = (path, what) =>
  assert(!isRefusedPath(path), `${what}: path '${path}' escapes the root or holds a '\\'`)

// THE rule an artifact's entry must satisfy, on read (parseEntries) and on write (serializeEntries).
const assertEntry = (entry, what) =>
  assert(typeof entry === 'string' && entry !== '' && !isRefusedPath(entry), `${what}: invalid entry ${JSON.stringify(entry)}`)

// An artifact's `entries` list as a Set: each a non-empty in-root path, listed once (a dupe would
// collapse in the Set and round-trip to different bytes).
export function parseEntries(list, what) {
  assert(Array.isArray(list), `${what}: entries must be an array of file paths`)
  const out = new Set()
  for (const entry of list) {
    assertEntry(entry, what)
    assert(!out.has(entry), `${what}: entry '${entry}' is listed twice`)
    out.add(entry)
  }
  return out
}

// The `entries` list an artifact writes: the same rule as on read, so an in-memory construct can't
// serialize what parse would reject; path-sorted.
export function serializeEntries(entries, what) {
  for (const entry of entries) assertEntry(entry, what)
  return fileSetToObject(entries)
}

// THE rule an artifact's `formats` entry must satisfy, on read (parseFormats) and on write
// (serializeFormats): a path an artifact may record, and a known format.
function assertFormat(file, format) {
  assertArtifactPath(file, 'formats')
  assert(KNOWN_FORMATS.has(format), `unknown format '${format}' for ${file}`)
}

// An artifact's `formats` object as a validated Map. '' and '.' alias to the same key (older
// artifacts keyed the root listing ''); normalized, failing closed on dupes, and an unknown format
// is rejected at the schema boundary so a tampered artifact fails closed.
export function parseFormats(json) {
  assert(isPlainObject(json))
  const formats = new Map()
  for (const [file, format] of Object.entries(json)) {
    assertFormat(file, format)
    const key = file === '' ? '.' : file
    assert(!formats.has(key), `duplicate format key '${key}'`)
    formats.set(key, format)
  }
  return formats
}

// The `formats` an artifact writes: the same rule as on read, so an in-memory construct can't serialize
// what parse would reject; path-sorted.
export function serializeFormats(formats) {
  for (const [file, format] of formats) assertFormat(file, format)
  return fileMapToObject(formats)
}

// THE rules an artifact's `imports` (conditions -> parent -> specifier -> target, as nested Maps)
// must satisfy, on read (parseImports) and on write (serializeImports). Paths escaping the root (incl.
// mid-path `a/../../x`) or holding a `\` are rejected: getImport resolves against the root at load. A
// target is a file, or (--metro) a non-empty { platform: file } map.
function assertImports(imports) {
  for (const [, byParent] of imports) {
    assert(byParent instanceof Map)
    for (const [parent, specifiers] of byParent) {
      assertArtifactPath(parent, 'imports')
      assert(specifiers instanceof Map)
      for (const [, target] of specifiers) {
        if (typeof target === 'string') {
          assertArtifactPath(target, 'imports')
          continue
        }
        assert(target instanceof Map && target.size > 0, 'import target must be a file or a non-empty {platform: file} map')
        for (const [platform, file] of target) {
          assert(typeof platform === 'string' && platform.length > 0 && !platform.includes('/'), `invalid platform key '${platform}'`)
          assert(typeof file === 'string')
          assertArtifactPath(file, 'imports')
        }
      }
    }
  }
}

// An artifact's `imports` object as nested Maps (see assertImports).
export function parseImports(json) {
  assert(isPlainObject(json))
  const imports = objectToMaps(json)
  assertImports(imports)
  return imports
}

// The `imports` an artifact writes: the same rules as on read (see assertImports); path-sorted.
export function serializeImports(imports) {
  assertImports(imports)
  return fileMapToObject(imports)
}

// A module map as the serialized `modules` (node_modules buckets) and `sources` (the rest) objects
// of a `what` artifact, buckets and files path-sorted so the bytes are canonical. `repo: false`
// leaves each record's `repo` out: metadata, which a lockfile never carries.
export function groupModules(modules, { skipEmpty = false, repo = true, what } = {}) {
  const grouped = { modules: [], sources: [] }
  for (const [dir, info] of modules) {
    if (skipEmpty && Object.keys(info.files).length === 0) continue
    const inNodeModules = hasNodeModulesSegment(dir)
    if (inNodeModules) assert(info.name && info.version && info.files)
    const files = fromEntries(Object.entries(info.files).toSorted(byPath))
    grouped[inNodeModules ? 'modules' : 'sources'].push([dir, moduleInfo({ ...info, repo: repo ? normalizeModuleRepo(dir, info, what) : undefined, files })])
  }
  return { modules: fromEntries(grouped.modules.toSorted(byPath)), sources: fromEntries(grouped.sources.toSorted(byPath)) }
}

// A target is a resolved-file string, or a { platform: file } Map under --metro.
function importTargetsEqual(a, b) {
  const aMap = a instanceof Map
  if (aMap !== (b instanceof Map)) return false
  if (!aMap) return a === b
  if (a.size !== b.size) return false
  for (const [platform, file] of a) if (b.get(platform) !== file) return false
  return true
}

const fmtTarget = (t) => (t instanceof Map ? `{${[...t].map(([p, f]) => `${p}: ${f}`).join(', ')}}` : t)

// Merge two import maps (conditions -> parent -> specifier -> target); a redirect conflict throws.
export function mergeImportMaps(a, b, label) {
  const out = new Map()
  const absorb = (imports) => {
    for (const [conditions, byParent] of imports) {
      const outByParent = nestedMap(out, conditions)
      for (const [parent, specs] of byParent) {
        const outSpecs = nestedMap(outByParent, parent)
        for (const [spec, target] of specs) {
          if (outSpecs.has(spec)) {
            assert(importTargetsEqual(outSpecs.get(spec), target),
              `${label}: import '${spec}' from '${parent}' resolves differently ('${fmtTarget(outSpecs.get(spec))}' vs '${fmtTarget(target)}')`)
          } else {
            outSpecs.set(spec, target instanceof Map ? new Map(target) : target)
          }
        }
      }
    }
  }
  absorb(a)
  absorb(b)
  return out
}

export function mergeFormatMaps(a, b, label) {
  const out = new Map()
  const absorb = (formats) => {
    for (const [file, format] of formats) {
      const currentFormat = out.get(file)
      if (currentFormat === undefined) {
        out.set(file, format)
        continue
      }
      try {
        out.set(file, reconcileFormat(format, currentFormat, file))
      } catch (cause) {
        throw new Error(`${label}: ${cause.message}`, { cause })
      }
    }
  }
  absorb(a)
  absorb(b)
  return out
}

// A union, EXCEPT that `b` (the INCOMING, newer artifact -- every call site passes it on the right) is
// authoritative for its own files: a since-lost execute bit is cleared, not resurrected by the union.
export function mergeExecutableSets(a, b, bModules, scope) {
  if (a.size === 0) return new Set(b)
  const bFiles = moduleFileKeys(bModules, { scope })
  const out = new Set(b)
  for (const file of a) if (!bFiles.has(file)) out.add(file)
  return out
}

// An empty, '.' or '..' path segment.
const NON_CANONICAL_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/u

// The flat key of `rel` in bucket `dir`; throws unless canonical ('.' only as the root listing, rel '')
// and free of `\`, which no artifact path holds: off Windows it is part of a name, refused everywhere.
export function canonicalFileKey(dir, rel, what) {
  const key = moduleFileKey(dir, rel)
  // Message built only on failure: this runs for every file.
  if ((key !== '.' || rel !== '') && NON_CANONICAL_SEGMENT.test(key)) assert(false, `${what}: non-canonical file key ${JSON.stringify(key)}`)
  if (key.includes('\\')) assert(false, `${what}: file key '${key}' holds a '\\', which no path may`)
  return key
}

// Maps each file's flat key to its bucket; rejects non-canonical keys and refused bucket dirs (an empty
// bucket's too, which no file key would reach), reports duplicates to onDuplicate.
export function flatFileKeys(modules, what, onDuplicate) {
  const owners = new Map()
  for (const [dir, { files }] of modules) {
    if (typeof dir !== 'string') assert(false, `${what}: bucket dir ${String(dir)} is not a string`)
    assertArtifactPath(dir, what)
    for (const rel of Object.keys(files)) {
      const key = canonicalFileKey(dir, rel, what)
      const owner = owners.get(key)
      if (owner !== undefined) onDuplicate(key, owner, dir)
      owners.set(key, dir)
    }
  }
  return owners
}

// The flatFileKeys duplicate handler for an artifact's parse/serialize: two bucket splits flattening
// to one path means module bucketing changed between writes.
export const duplicateKeyError = (what, regenerate) => (key) => assert(false,
  `duplicate file key '${key}' across ${what} buckets -- module bucketing changed between writes ` +
  `(a workspace package without a version now owns its own bucket); regenerate the ${regenerate}`)

// Result `files` objects are null-prototype, so a `__proto__` file name is a plain own key.
export function mergeModuleMaps(a, b, label) {
  const out = new Map()
  const absorb = (modules) => {
    for (const [dir, info] of modules) {
      const existing = out.get(dir)
      if (existing === undefined) {
        out.set(dir, moduleInfo({ ...info, files: Object.assign(Object.create(null), info.files) }))
        continue
      }
      assert(existing.name === info.name,
        `${label}: module '${dir}' name mismatch ('${existing.name}' vs '${info.name}')`)
      // A one-sided absent version is usually a migration skew: older stasis fabricated '0.0.0'
      // for a workspace package whose package.json has no version, newer stasis records none.
      assert(existing.version === info.version,
        `${label}: module '${dir}' version mismatch ('${existing.version}' vs '${info.version}')` +
        ((existing.version == null) === (info.version == null) ? '' :
          ` -- an artifact from an older stasis may record a placeholder version for a workspace ` +
          `package without one; regenerate it (bundle=replace / lock=replace)`))
      assert(existing.ecosystem === info.ecosystem,
        `${label}: module '${dir}' ecosystem mismatch ('${existing.ecosystem ?? '(none)'}' vs '${info.ecosystem ?? '(none)'}')`)
      // `repo` is metadata, held to nothing: either side's, where only one records it, else `a`'s.
      if (existing.repo === undefined && info.repo !== undefined) out.set(dir, moduleInfo({ ...existing, repo: info.repo }))
      for (const [rel, value] of Object.entries(info.files)) {
        if (Object.hasOwn(existing.files, rel)) {
          assert(existing.files[rel] === value, `${label}: content mismatch for '${moduleFileKey(dir, rel)}'`)
        } else {
          existing.files[rel] = value
        }
      }
    }
  }
  absorb(a)
  absorb(b)
  // One project-relative path must live in exactly one bucket. Bucketing can change between
  // releases (a versionless workspace package used to fall through to a parent bucket and now owns
  // its own), and per-dir absorption cannot see that: without this check the merge would WRITE an
  // artifact that then fails its own next parse on the duplicate-file-key guard.
  flatFileKeys(out, label, (key, owner, dir) => assert(false,
    `${label}: file '${key}' is bucketed under both '${owner}' and '${dir}' -- module bucketing ` +
    `changed between the artifacts (a workspace package without a version now owns its own ` +
    `bucket); regenerate the artifact (bundle=replace / lock=replace)`))
  return out
}

// A full path SEGMENT, NOT a bare substring (`foo_node_modules/dep` is a source dir, not a bucket).
export function hasNodeModulesSegment(path) {
  return path.split('/').includes('node_modules')
}

// Deepest segment-aligned `node_modules/` marker, or -1: `lastIndexOf` alone would also match a bare
// substring (`foo_node_modules/`), so a candidate only counts at the start or after a `/`.
function lastNodeModulesMarker(path) {
  const marker = 'node_modules/'
  let idx = path.length
  while ((idx = path.lastIndexOf(marker, idx - 1)) !== -1) {
    if (idx === 0 || path[idx - 1] === '/') return idx
  }
  return -1
}

export function splitNodeModulesPath(path) {
  const marker = 'node_modules/'
  const idx = lastNodeModulesMarker(path)
  if (idx === -1) return null
  const after = idx + marker.length
  const parts = path.slice(after).split('/')
  const pkgLen = parts[0].startsWith('@') ? 2 : 1
  if (parts.length <= pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const name = parts.slice(0, pkgLen).join('/')
  return { dir: path.slice(0, after) + name, rel: parts.slice(pkgLen).join('/'), name }
}
