// The pure half of the util split: the artifact data model of bundle.js, lockfile.js and shard.js. It
// imports no Node builtin, so `./bundle` and `./lockfile` load in any JS runtime; util.js re-exports it,
// so `@exodus/stasis-core/util` serves the full set.

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

// A file's key inside its bucket `dir`, of its flat project-relative `path` below it: the inverse of moduleFileKey.
export const fileInBucket = (dir, path) => (dir === '.' ? path : path.slice(dir.length + 1))

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

const SRI = { sha1: /^sha1-[A-Za-z\d+/]{27}=$/u, sha256: /^sha256-[A-Za-z\d+/]{43}=$/u, sha512: /^sha512-[A-Za-z\d+/]{86}==$/u }
// A patch's, as pnpm hashes it.
const PATCH_FIELDS = { integrity: (v) => typeof v === 'string' && SRI.sha256.test(v) }

// The one sha512 an SRI holds, as upstream takes one; undefined where it holds none, or two.
export function sha512Of(integrity) {
  const found = new Set((integrity ?? '').split(/\s+/u).filter((token) => token.startsWith('sha512-')).map((token) => token.split('?')[0]))
  return found.size === 1 ? [...found][0] : undefined
}
// That, where it is of a sha512's form: a tarball's integrity as a record holds it.
export const tarballIntegrityOf = (integrity) => {
  const one = sha512Of(integrity)
  return SRI.sha512.test(one ?? '') ? one : undefined
}

// An npm dependency's bucket alone, not a workspace package's, whatever ecosystem it records.
export const isNpmDependency = (dir, ecosystem) => hasNodeModulesSegment(dir) && dependencyEcosystem(dir, ecosystem) === 'npm'

// The algorithm of a dependency's archive `integrity`, as its lockfile locks it: an npm tarball's,
// a crate's (Cargo.lock's `checksum`), a Composer dist's (`shasum`), a Soldeer zip's (`checksum`).
const ARCHIVE_ALGORITHM = { npm: 'sha512', cargo: 'sha256', composer: 'sha1', soldeer: 'sha256' }

// A dependency's `integrity` (ARCHIVE_ALGORITHM's); an npm one's of a node_modules bucket alone.
const normalizeModuleIntegrity = (dir, { ecosystem, integrity }, what) => {
  if (integrity === undefined) return undefined
  const of = dependencyEcosystem(dir, ecosystem)
  if (!Object.hasOwn(ARCHIVE_ALGORITHM, of) || (of === 'npm' && !hasNodeModulesSegment(dir))) assert(false, `${what}: '${dir}' is no npm, cargo, composer or soldeer dependency's bucket, and carries no integrity`)
  if (typeof integrity !== 'string' || !SRI[ARCHIVE_ALGORITHM[of]].test(integrity)) assert(false, `invalid ${what} module '${dir}' integrity: ${JSON.stringify(integrity)}`)
  return integrity
}

// An npm dependency's `patch`: the one pnpm installed it with (patchedDependencies), by its integrity.
const normalizeModulePatch = (dir, { ecosystem, patch }, what) => {
  if (patch === undefined) return undefined
  if (!isNpmDependency(dir, ecosystem)) assert(false, `${what}: '${dir}' is no npm dependency's bucket, and carries no patch`)
  const normalized = normalizeBlock(patch, PATCH_FIELDS, `${what} module '${dir}' patch`)
  if (normalized?.integrity === undefined) assert(false, `${what} module '${dir}' patch has no integrity`)
  return normalized
}

// A package name or version: characters some ecosystem uses there (npm's legacy `~'!()*` too), so not
// space or `"#$%&,:;<=>?[\]^`{|}`.
export const isPackageString = (v) => typeof v === 'string' && /^[\w.+@/~'!()*-]+$/u.test(v)
export const PACKAGE_BLOCK = { name: isPackageString, version: isPackageString }

// A directory key of a record's `vendored` or `subpackages`: an in-bucket path in canonical form, through
// no `node_modules` (a package installed there is a bucket of its own).
const isBucketDir = (dir) => typeof dir === 'string' && dir !== '' && !dir.includes('\\') &&
  dir.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== 'node_modules')

// Whether a package.json naming `manifestName` at `dir` (package-relative, POSIX) in package `hostName` is
// a subpackage: a subpath entry point named for its directory (`@hookform/resolvers/zod` at zod/), as
// microbundle lays them out. It is the package's own code; its `version`, a placeholder (1.0.0), is held to nothing.
export const isSubpackage = (manifestName, hostName, dir) =>
  typeof manifestName === 'string' && isBucketDir(dir) && manifestName === `${hostName}/${dir}`

// A record's per-directory metadata, each entry the `name` (required) and `version` of the package.json in
// that directory: `vendored`, the packages copied into a dependency (any name), and `subpackages`, its own
// subpath entry points (isSubpackage).
const DIR_METADATA = {
  vendored: () => true,
  subpackages: (entry, name, sub) => isSubpackage(entry.name, name, sub),
}

// The directory of `entries` a bucket file `rel` is in: the deepest one listed that holds it.
export const entryDirOf = (entries, rel) => {
  for (let slash = rel.lastIndexOf('/'); slash > 0; slash = rel.lastIndexOf('/', slash - 1)) {
    if (Object.hasOwn(entries, rel.slice(0, slash))) return rel.slice(0, slash)
  }
  return undefined
}

// The entries of a `vendored` or `subpackages` that hold one of `files`, each file counted for the deepest
// entry holding it; path-sorted and frozen, undefined if none. An artifact lists those it carries a file of.
function carriedEntries(entries, files) {
  if (entries === undefined) return undefined
  const carried = new Set()
  for (const rel of Object.keys(files)) {
    const dir = entryDirOf(entries, rel)
    if (dir !== undefined) carried.add(dir)
  }
  return carried.size === 0 ? undefined : Object.freeze(fromEntries(sortedByPath(carried).map((dir) => [dir, entries[dir]])))
}

// A dependency's `field` of DIR_METADATA, validated: each entry holds one of the record's `files`. First-party
// code carries none.
const normalizeDirMetadata = (field, dir, { name, ecosystem, files, [field]: entries }, what) => {
  if (entries === undefined) return undefined
  if (dependencyEcosystem(dir, ecosystem) === undefined) assert(false, `${what}: '${dir}' is no dependency's bucket, and carries no ${field}`)
  if (!isPlainObject(entries)) assert(false, `${what} module '${dir}' ${field} must be an object`)
  const normalized = fromEntries(Object.entries(entries).map(([sub, block]) => {
    if (!isBucketDir(sub)) assert(false, `${what} module '${dir}' ${field}: invalid directory ${JSON.stringify(sub)}`)
    const entry = normalizeBlock(block, PACKAGE_BLOCK, `${what} module '${dir}' ${field} '${sub}'`)
    if (entry?.name === undefined) assert(false, `${what} module '${dir}' ${field} '${sub}' has no name`)
    if (!DIR_METADATA[field](entry, name, sub)) assert(false, `${what} module '${dir}' ${field} '${sub}' is named '${entry.name}', not '${name}/${sub}'`)
    return [sub, entry]
  }))
  const carried = carriedEntries(normalized, files)
  for (const sub of Object.keys(normalized)) {
    if (!Object.hasOwn(carried ?? {}, sub)) assert(false, `${what} module '${dir}' ${field} '${sub}' holds none of its files`)
  }
  return carried
}

// The metadata a record holds whole (DIR_METADATA's is by directory), each field's normalizer.
const RECORD_METADATA = { integrity: normalizeModuleIntegrity, repo: normalizeModuleRepo, patch: normalizeModulePatch }
const RECORD_ENTRIES = Object.entries(RECORD_METADATA)
const DIR_FIELDS = Object.keys(DIR_METADATA)
// Every metadata field, in canonical order.
const MODULE_METADATA = [...Object.keys(RECORD_METADATA), ...DIR_FIELDS]
const OPTIONAL_KEYS = ['ecosystem', ...MODULE_METADATA]

// A module bucket record in canonical key order; `ecosystem` and the metadata are omitted (not undefined) when absent.
export const moduleInfo = (info) => {
  const record = { name: info.name, version: info.version }
  for (const key of OPTIONAL_KEYS) if (info[key] !== undefined) record[key] = info[key]
  record.files = info.files
  return record
}

// What a record attests of how its package was installed, which two records of one bucket must agree
// on: its tarball's integrity, and the patch pnpm applied.
export const ATTESTED_METADATA = ['integrity', 'patch']

// `record` with the metadata `other` (of its bucket) has and it lacks, `record` itself where none.
// ATTESTED_METADATA both record must agree; with `attesting`, all `record` has must be `other`'s,
// one `other` has none of refused too.
export function withMetadataOf(record, other, what = 'module', { attesting = false } = {}) {
  let added
  for (const field of Object.keys(RECORD_METADATA)) {
    if (ATTESTED_METADATA.includes(field) && record[field] !== undefined && (attesting || other[field] !== undefined)) {
      if (JSON.stringify(record[field]) !== JSON.stringify(other[field])) assert(false, `${what} ${field} mismatch (${JSON.stringify(record[field])} vs ${JSON.stringify(other[field]) ?? 'none'})`)
    } else if (record[field] === undefined && other[field] !== undefined) (added ??= {})[field] = other[field]
  }
  for (const field of DIR_FIELDS) {
    if (other[field] === undefined || Object.keys(other[field]).every((sub) => Object.hasOwn(record[field] ?? {}, sub))) continue
    ;(added ??= {})[field] = Object.freeze(fromEntries([...Object.entries(other[field]), ...Object.entries(record[field] ?? {})]))
  }
  return added === undefined ? record : moduleInfo({ ...record, ...added })
}

// `record` held to `account`, of how its package was installed (an install record's, or with
// `installed` false, a lockfile's alone). -> `record` with what the account names.
export const heldToAccount = (record, account, what) =>
  withMetadataOf(record, account, `${what} (recorded vs ${account.installed === false ? 'locked' : 'installed'})`, { attesting: true })

// A record's metadata as `what` holds it, validated, the fields not in `fields` left out: RECORD_METADATA's,
// and DIR_METADATA's of the entries `entriesOf(field)`.
function metadataOf(dir, info, what, fields, entriesOf) {
  const metadata = {}
  for (const [field, normalize] of RECORD_ENTRIES) metadata[field] = fields.includes(field) ? normalize(dir, info, what) : undefined
  for (const field of DIR_FIELDS) metadata[field] = fields.includes(field) ? normalizeDirMetadata(field, dir, { ...info, [field]: entriesOf(field) }, what) : undefined
  return metadata
}

// A parsed bucket `dir` of a `what` artifact: an absent version has one spelling (a literal null folds
// into undefined so identity comparisons and JSON round-trips can't split on it), the metadata of
// `fields` is validated and the rest left out, and `files` is null-prototype.
export function normalizeModule(info, dir, what, fields = MODULE_METADATA) {
  const { name, version, ecosystem } = info
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  // An array or a string would read as files named by index ('0', '1'...).
  if (!isPlainObject(info.files)) assert(false, `${what}: module '${dir}' files must be an object`)
  const files = fromEntries(Object.entries(info.files))
  return moduleInfo({
    name, version: version ?? undefined, ecosystem,
    ...metadataOf(dir, { ...info, files }, what, fields, (field) => info[field]),
    files,
  })
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

// stasis's lockfile, by name at any depth and in any case: a case-insensitive disk resolves
// `STASIS.LOCK.JSON` to it too.
export const isLockfileName = (path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase() === 'stasis.lock.json'

// sortPaths' order, of two paths as split at '/' (read, not changed).
function compareSegments(al, bl) {
  // The segments from `i` on are where the two differ.
  let i = 0
  while (i < al.length && al[i] === bl[i]) i++
  const ar = al.length - i
  const br = bl.length - i
  if (ar === 0 && br === 0) return 0

  // First process each file in dir, then subdirs
  if (ar < 2) return br < 2 && (al[i] ?? '') > (bl[i] ?? '') ? 1 : -1
  if (br < 2) return 1

  if (al[i] === '*') return -1
  if (bl[i] === '*') return 1

  if (al[i] === 'node_modules') return 1
  if (bl[i] === 'node_modules') return -1

  // Prefer example/ over example-something/
  const an = al.slice(i).join('\0')
  const bn = bl.slice(i).join('\0')
  if (an < bn) return -1
  if (an > bn) return 1
  throw new Error('Unreachable')
}

export function sortPaths(a, b) {
  return compareSegments(a.split('/'), b.split('/'))
}

// `items` in sortPaths' order of `keyOf(item)`, each key split once, not at each of the sort's comparisons.
export const sortedByPath = (items, keyOf = (item) => item) => Array.from(items, (item) => ({ item, segments: keyOf(item).split('/') }))
  .toSorted((a, b) => compareSegments(a.segments, b.segments))
  .map(({ item }) => item)

const entryKey = ([key]) => key

export function isPlainObject(x) {
  if (!x) return false
  const proto = Object.getPrototypeOf(x)
  return proto === null || proto === Object.prototype
}

export const fromEntries = (entries) => Object.setPrototypeOf(Object.fromEntries(entries), null)

export const fileSetToObject = (set) => sortedByPath(set)

// `sorted: false` only for a machine-only payload whose reader does not care about ordering (shard.js).
export const fileMapToObject = (map, { sorted = true } = {}) => {
  const entries = sorted ? sortedByPath(map, entryKey) : [...map]
  return fromEntries(entries.map(([k, v]) => [k, v instanceof Map ? fileMapToObject(v, { sorted }) : v]))
}

export const nestedMap = (map, key) => map.get(key) ?? map.set(key, new Map()).get(key)

export const objectToMaps = (obj) => new Map(
  Object.entries(obj).map(([k, v]) => [k, isPlainObject(v) ? objectToMaps(v) : v])
)

// True for an absolute path or any `..` hop above the root, INCLUDING a mid-path one (`a/../../x`) that
// `startsWith('..')` would miss. A segment walk, not posix.normalize, so this module stays free of
// node:path; its verdict matches normalize's (posix-path-escapes.test.js).
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

// A payload-free `stat:*` record attests a path's kind alone: an artifact that also carries content
// for its path is malformed, rejected on read and never written, as nothing would hold those bytes
// (a reader taking the record as content-free skips them, another would serve or write them).
export function assertPayloadFree(formats, files, what) {
  for (const [file, format] of formats) {
    if (isStatFormat(format) && files.has(file)) assert(false, `${what}: '${file}' is a payload-free '${format}' record, yet carries content`)
  }
}

// The `formats` an artifact writes: the same rule as on read, so an in-memory construct can't serialize
// what parse would reject; path-sorted.
export function serializeFormats(formats) {
  for (const [file, format] of formats) assertFormat(file, format)
  return fileMapToObject(formats)
}

// THE rules an artifact's `imports` (conditions -> parent -> specifier -> target) must satisfy, on read
// and on write. Paths escaping the root (incl. mid-path `a/../../x`) or holding a `\` are rejected: getImport
// resolves against the root at load. A target is a file, or (--metro) a non-empty { platform: file } map.
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

// A module map as a `what` artifact's `modules` (node_modules buckets) and `sources` (the rest), path-sorted
// so the bytes are canonical. `metadata` names the metadata fields written, `true` for all, `false` for none
// (a lockfile writes `vendored` alone, so it can be audited on its own).
export function groupModules(modules, { skipEmpty = false, metadata: written = true, what } = {}) {
  const metadata = written === true ? MODULE_METADATA : written === false ? [] : written
  const grouped = { modules: [], sources: [] }
  for (const [dir, info] of modules) {
    if (skipEmpty && Object.keys(info.files).length === 0) continue
    const inNodeModules = hasNodeModulesSegment(dir)
    if (inNodeModules) assert(info.name && info.version && info.files)
    const files = fromEntries(sortedByPath(Object.entries(info.files), entryKey))
    grouped[inNodeModules ? 'modules' : 'sources'].push([dir, moduleInfo({
      ...info,
      ...metadataOf(dir, { ...info, files }, what, metadata, (field) => carriedEntries(info[field], files)),
      files,
    })])
  }
  return { modules: fromEntries(sortedByPath(grouped.modules, entryKey)), sources: fromEntries(sortedByPath(grouped.sources, entryKey)) }
}

// Whether two import targets are one: a resolved file, or (--metro) a { platform: file } Map, compared structurally.
export function importTargetsEqual(a, b) {
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

// A weak 'stat:*' yields to a real format; two real formats or a stat kind flip are fatal.
export function upsertFormat(map, file, format) {
  const currentFormat = map.get(file)
  map.set(file, currentFormat === undefined ? format : reconcileFormat(format, currentFormat, file))
}

export function mergeFormatMaps(a, b, label) {
  const out = new Map()
  for (const formats of [a, b]) {
    for (const [file, format] of formats) {
      try {
        upsertFormat(out, file, format)
      } catch (cause) {
        throw new Error(`${label}: ${cause.message}`, { cause })
      }
    }
  }
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

// Result `files` objects are null-prototype, so a `__proto__` file name is a plain own key. With
// `held`, `b` is held to `a`, not merged into it: what `b` alone attests stays a claim of its own files.
export function mergeModuleMaps(a, b, label, { held = false } = {}) {
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
      // Metadata: either side's, where only one records it, else `a`'s (withMetadataOf). An attested
      // value one side alone records is of its files alone: the other may add none.
      out.set(dir, withMetadataOf(existing, info, `${label}: module '${dir}'`))
      for (const field of ATTESTED_METADATA) {
        if ((existing[field] === undefined) === (info[field] === undefined) || (held && existing[field] === undefined)) continue
        const [attests, adds] = existing[field] === undefined ? [info, existing] : [existing, info]
        const added = Object.keys(adds.files).find((rel) => !Object.hasOwn(attests.files, rel))
        if (added !== undefined) assert(false, `${label}: module '${dir}' ${field} is recorded of one side's files, not of '${moduleFileKey(dir, added)}' the other adds`)
      }
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
  // One project-relative path must live in exactly one bucket. Bucketing can change between releases
  // (a versionless workspace package now owns its own), which per-dir absorption can't see: unchecked,
  // the merge would WRITE an artifact that fails its own next parse on the duplicate-file-key guard.
  flatFileKeys(out, label, (key, owner, dir) => assert(false,
    `${label}: file '${key}' is bucketed under both '${owner}' and '${dir}' -- module bucketing ` +
    `changed between the artifacts (a workspace package without a version now owns its own ` +
    `bucket); regenerate the artifact (bundle=replace / lock=replace)`))
  return out
}

// A full path SEGMENT, NOT a bare substring (`foo_node_modules/dep` is a source dir, not a bucket).
export function hasNodeModulesSegment(path) {
  return path === 'node_modules' || path.startsWith('node_modules/') || path.endsWith('/node_modules') || path.includes('/node_modules/')
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
