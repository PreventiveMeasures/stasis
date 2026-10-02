// The pure half of the util split: the artifact data model shared by bundle.js, lockfile.js and
// shard.js (the format universe, flat file keys, strict merges, the executable-set rules and the
// JSON<->Map converters). No Node builtin imports, so `./bundle` and `./lockfile` load in any JS
// runtime. util.js re-exports this module, so `@exodus/stasis-core/util` serves the full set.

// KNOWN_FORMATS is the closed universe of `format` strings; parsers reject anything outside it.
export const NODE_FORMATS = new Set(['module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript'])
export const SOURCE_LANGUAGE_FORMATS = new Set(['solidity', 'php', 'shell', 'rust'])
export const NATIVE_BUILD_FORMATS = new Set([
  'java', 'kotlin', 'gradle', 'objc', 'objcpp', 'swift', 'c', 'cpp', 'c-header', 'cpp-header',
  'ruby', 'cmake', 'podspec', 'podfile', 'podfile-lock', 'template', 'xml', 'env', 'fastlane', 'pbxproj',
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

// A module bucket record in canonical key order; `ecosystem` is omitted (not undefined) when absent.
export const moduleInfo = ({ name, version, ecosystem, files }) =>
  ({ name, version, ...(ecosystem === undefined ? {} : { ecosystem }), files })

// A parsed bucket: an absent version has one spelling (a literal null folds into undefined so
// identity comparisons and JSON round-trips can't split on it), and `files` is null-prototype.
export function normalizeModule({ name, version, ecosystem, files }) {
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  return moduleInfo({ name, version: version ?? undefined, ecosystem, files: fromEntries(Object.entries(files)) })
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

// An artifact's `entries` list as a Set: each a non-empty in-root path, listed once (a dupe would
// collapse in the Set and round-trip to different bytes).
export function parseEntries(list, what) {
  assert(Array.isArray(list), `${what}: entries must be an array of file paths`)
  const out = new Set()
  for (const entry of list) {
    assert(typeof entry === 'string' && entry !== '' && !posixPathEscapes(entry), `${what}: invalid entry ${JSON.stringify(entry)}`)
    assert(!out.has(entry), `${what}: entry '${entry}' is listed twice`)
    out.add(entry)
  }
  return out
}

// An artifact's `formats` object as a validated Map. '' and '.' alias to the same key (older
// artifacts keyed the root listing ''); normalized, failing closed on dupes, and an unknown format
// is rejected at the schema boundary so a tampered artifact fails closed.
export function parseFormats(json) {
  assert(isPlainObject(json))
  const formats = new Map()
  for (const [file, format] of Object.entries(json)) {
    assert(!posixPathEscapes(file))
    assert(KNOWN_FORMATS.has(format), `unknown format '${format}' for ${file}`)
    const key = file === '' ? '.' : file
    assert(!formats.has(key), `duplicate format key '${key}'`)
    formats.set(key, format)
  }
  return formats
}

// An artifact's `imports` object (conditions -> parent -> specifier -> target) as nested Maps. Paths
// escaping the root are rejected here (incl. mid-path `a/../../x`): getImport resolves against the
// root at load. A target is a file, or (--metro) a non-empty { platform: file } map.
export function parseImports(json) {
  assert(isPlainObject(json))
  const imports = objectToMaps(json)
  for (const [, byParent] of imports) {
    assert(byParent instanceof Map)
    for (const [parent, specifiers] of byParent) {
      assert(!posixPathEscapes(parent))
      assert(specifiers instanceof Map)
      for (const [, target] of specifiers) {
        if (typeof target === 'string') {
          assert(!posixPathEscapes(target))
          continue
        }
        assert(target instanceof Map && target.size > 0, 'import target must be a file or a non-empty {platform: file} map')
        for (const [platform, file] of target) {
          assert(typeof platform === 'string' && platform.length > 0 && !platform.includes('/'), `invalid platform key '${platform}'`)
          assert(typeof file === 'string')
          assert(!posixPathEscapes(file))
        }
      }
    }
  }
  return imports
}

// A module map as the serialized `modules` (node_modules buckets) and `sources` (the rest) objects,
// buckets and files path-sorted so the bytes are canonical.
export function groupModules(modules, { skipEmpty = false } = {}) {
  const grouped = { modules: [], sources: [] }
  for (const [dir, info] of modules) {
    if (skipEmpty && Object.keys(info.files).length === 0) continue
    const inNodeModules = hasNodeModulesSegment(dir)
    if (inNodeModules) assert(info.name && info.version && info.files)
    const files = fromEntries(Object.entries(info.files).toSorted(byPath))
    grouped[inNodeModules ? 'modules' : 'sources'].push([dir, moduleInfo({ ...info, files })])
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

// The flat key of `rel` in bucket `dir`; throws unless canonical ('.' only as the root listing, rel '').
export function canonicalFileKey(dir, rel, what) {
  const key = moduleFileKey(dir, rel)
  // Message built only on failure: this runs for every file.
  if ((key !== '.' || rel !== '') && NON_CANONICAL_SEGMENT.test(key)) assert(false, `${what}: non-canonical file key ${JSON.stringify(key)}`)
  return key
}

// Maps each file's flat key to its bucket; rejects non-canonical keys, reports duplicates to onDuplicate.
export function flatFileKeys(modules, what, onDuplicate) {
  const owners = new Map()
  for (const [dir, { files }] of modules) {
    if (typeof dir !== 'string') assert(false, `${what}: bucket dir ${String(dir)} is not a string`)
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
