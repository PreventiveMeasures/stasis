// Imports no Node builtin, so `./bundle` and `./lockfile` load in any JS runtime; util.js re-exports it all.

export const NODE_FORMATS = new Set(['module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript'])
export const SOURCE_LANGUAGE_FORMATS = new Set(['solidity', 'php', 'shell', 'rust', 'teal'])
export const NATIVE_BUILD_FORMATS = new Set([
  'java', 'kotlin', 'gradle', 'objc', 'objcpp', 'swift', 'c', 'cpp', 'c-header', 'cpp-header',
  'ruby', 'python', 'cmake', 'podspec', 'podfile', 'podfile-lock', 'gemfile', 'gemfile-lock', 'template', 'xml', 'env', 'fastlane', 'pbxproj',
])
// JS and TS whose module type no Node load decides: the code Metro builds from source, which is Metro's to load.
export const GENERIC_FORMATS = new Set(['generic-javascript', 'generic-typescript'])
export const RESOURCE_FORMATS = new Set(['resource', 'resource:base64'])
export const STAT_FORMATS = new Set(['stat:file', 'stat:directory'])
export const KNOWN_FORMATS = new Set([
  ...NODE_FORMATS,
  ...SOURCE_LANGUAGE_FORMATS,
  ...NATIVE_BUILD_FORMATS,
  ...GENERIC_FORMATS,
  ...RESOURCE_FORMATS,
  'patch', // a `.patch` unified diff (pnpm patchedDependencies, patch-package): UTF-8 text applied by a patch step
  'directory',
  ...STAT_FORMATS,
])

export const isStatFormat = (format) => STAT_FORMATS.has(format)

// A disabled import's target (a `browser` field mapping it to `false`): never on disk, carried as empty CommonJS.
export const EMPTY_MODULE_PATH = '.stasis/empty-module.js'

export const erasedTypeScriptFormat = (format) =>
  format === 'module-typescript' ? 'module' : format === 'commonjs-typescript' ? 'commonjs' : undefined

const formatKind = (format) => (format === 'directory' || format === 'stat:directory' ? 'directory' : 'file')

// A file Metro builds and Node loads both: the format Node loads it in says what the generic one leaves open.
const NODE_JS_FORMATS = new Set(['module', 'commonjs', 'module-typescript', 'commonjs-typescript'])
const yieldsTo = (generic, format) => GENERIC_FORMATS.has(generic) && NODE_JS_FORMATS.has(format)

// Whether `attested` attests an observed `format`: a generic observation is the Node format's too.
export const attestsFormat = (attested, format) => attested === format || yieldsTo(format, attested)

export function reconcileFormat(format, currentFormat, name) {
  if (format === currentFormat) return format
  if (yieldsTo(format, currentFormat)) return currentFormat
  if (yieldsTo(currentFormat, format)) return format
  const stat = isStatFormat(format)
  if (stat !== isStatFormat(currentFormat) && formatKind(format) === formatKind(currentFormat)) return stat ? currentFormat : format
  throw new Error(`format conflict for '${name}' ('${currentFormat}' vs '${format}')`)
}

// `rel === ''` (a `directory` capture whose path IS a module root) keys the bare dir: `${dir}/` breaks the round-trip.
export const moduleFileKey = (dir, rel) => (rel === '' ? dir : dir === '.' ? rel : `${dir}/${rel}`)

export const fileInBucket = (dir, path) => (dir === '.' ? path : path.slice(dir.length + 1))

const GITHUB_REPO = /^(?=[A-Za-z0-9-]{1,39}\/)[A-Za-z0-9](?:-?[A-Za-z0-9])*\/(?!\.\.?$)[\w.-]{1,100}$/u
const REPO_DIRECTORY = /^(?!\.\.?(?:\/|$))[\w.~@+-]+(?:\/(?!\.\.?(?:\/|$))[\w.~@+-]+)*$/u
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
export const REPO_FIELDS = {
  github: (v) => typeof v === 'string' && GITHUB_REPO.test(v),
  directory: (v) => typeof v === 'string' && v.length <= 1024 && (v === '' || REPO_DIRECTORY.test(v)),
  commit: (v) => typeof v === 'string' && GIT_SHA.test(v),
}

export const sameGithub = (a, b) => a?.toLowerCase() === b?.toLowerCase()

// Messages are built on failure alone: a dependency's `repo` is checked on every parse and write.
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

export const normalizeRepo = (repo, what = 'bundle repo') => normalizeBlock(repo, REPO_FIELDS, what)

// An untagged node_modules bucket is npm's: an artifact from before the `ecosystem` tag records none.
export const dependencyEcosystem = (dir, ecosystem) => ecosystem ?? (hasNodeModulesSegment(dir) ? 'npm' : undefined)

// The normalizer of a record's `field` block: only a bucket `carries` takes (a `kind` one) holds it, `required` set.
const blockMetadata = (field, fields, required, carries, kind) => (dir, { ecosystem, [field]: block }, what) => {
  if (block === undefined) return undefined
  if (!carries(dir, ecosystem)) assert(false, `${what}: '${dir}' is no ${kind} bucket, and carries no ${field}`)
  const normalized = normalizeBlock(block, fields, `${what} module '${dir}' ${field}`)
  if (normalized?.[required] === undefined) assert(false, `${what} module '${dir}' ${field} has no ${required}`)
  return normalized
}

// `github` is required: a `directory` or `commit` places nothing without the repository it is in.
const normalizeModuleRepo = blockMetadata('repo', REPO_FIELDS, 'github',
  (dir, ecosystem) => dependencyEcosystem(dir, ecosystem) !== undefined, "dependency's")

const SRI = { sha1: /^sha1-[A-Za-z\d+/]{27}=$/u, sha256: /^sha256-[A-Za-z\d+/]{43}=$/u, sha512: /^sha512-[A-Za-z\d+/]{86}==$/u }
// From the bundle root, `..` leading it alone: pnpm names a patch from the lockfile's directory, which may be above it.
const isPatchFile = (v) => {
  if (typeof v !== 'string' || v.length > 4096 || v.includes('\\') || v.includes('\0')) return false
  const segments = v.split('/')
  const up = segments.findIndex((segment) => segment !== '..')
  return up !== -1 && segments.slice(up).every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}
const PATCH_FIELDS = { integrity: (v) => typeof v === 'string' && SRI.sha256.test(v), file: isPatchFile }

export function sha512Of(integrity) {
  const found = new Set((integrity ?? '').split(/\s+/u).filter((token) => token.startsWith('sha512-')).map((token) => token.split('?')[0]))
  return found.size === 1 ? [...found][0] : undefined
}
export const tarballIntegrityOf = (integrity) => {
  const one = sha512Of(integrity)
  return SRI.sha512.test(one ?? '') ? one : undefined
}

export const isNpmDependency = (dir, ecosystem) => hasNodeModulesSegment(dir) && dependencyEcosystem(dir, ecosystem) === 'npm'

export const ARCHIVE_ALGORITHM = { npm: 'sha512', cargo: 'sha256', composer: 'sha1', soldeer: 'sha256' }

const normalizeModuleIntegrity = (dir, { ecosystem, integrity }, what) => {
  if (integrity === undefined) return undefined
  const of = dependencyEcosystem(dir, ecosystem)
  if (!Object.hasOwn(ARCHIVE_ALGORITHM, of) || (of === 'npm' && !hasNodeModulesSegment(dir))) assert(false, `${what}: '${dir}' is no npm, cargo, composer or soldeer dependency's bucket, and carries no integrity`)
  if (typeof integrity !== 'string' || !SRI[ARCHIVE_ALGORITHM[of]].test(integrity)) assert(false, `invalid ${what} module '${dir}' integrity: ${JSON.stringify(integrity)}`)
  return integrity
}

const normalizeModulePatch = blockMetadata('patch', PATCH_FIELDS, 'integrity', isNpmDependency, "npm dependency's")

export const isPackageString = (v) => typeof v === 'string' && /^[\w.+@/~'!()*-]+$/u.test(v)
export const PACKAGE_BLOCK = { name: isPackageString, version: isPackageString }

// Through no `node_modules`: a package installed there is a bucket of its own.
const isBucketDir = (dir) => typeof dir === 'string' && dir !== '' && !dir.includes('\\') &&
  dir.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== 'node_modules')

export const isSubpackage = (manifestName, hostName, dir) =>
  typeof manifestName === 'string' && isBucketDir(dir) && manifestName === `${hostName}/${dir}`

const DIR_METADATA = {
  vendored: () => true,
  subpackages: (entry, name, sub) => isSubpackage(entry.name, name, sub),
}

export const entryDirOf = (entries, rel) => {
  for (let slash = rel.lastIndexOf('/'); slash > 0; slash = rel.lastIndexOf('/', slash - 1)) {
    if (Object.hasOwn(entries, rel.slice(0, slash))) return rel.slice(0, slash)
  }
  return undefined
}

function carriedEntries(entries, files) {
  if (entries === undefined) return undefined
  const carried = new Set(Object.keys(files).map((rel) => entryDirOf(entries, rel)).filter((dir) => dir !== undefined))
  return carried.size === 0 ? undefined : Object.freeze(fromEntries(sortedByPath(carried).map((dir) => [dir, entries[dir]])))
}

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
  const idle = Object.keys(normalized).find((sub) => !Object.hasOwn(carried ?? {}, sub))
  if (idle !== undefined) assert(false, `${what} module '${dir}' ${field} '${idle}' holds none of its files`)
  return carried
}

const RECORD_METADATA = { integrity: normalizeModuleIntegrity, patch: normalizeModulePatch, repo: normalizeModuleRepo }
const DIR_FIELDS = Object.keys(DIR_METADATA)
const MODULE_METADATA = [...Object.keys(RECORD_METADATA), ...DIR_FIELDS]
const OPTIONAL_KEYS = ['ecosystem', ...MODULE_METADATA]

// Canonical key order; `ecosystem` and the metadata are omitted (not undefined) when absent.
export const moduleInfo = (info) => {
  const record = { name: info.name, version: info.version }
  for (const key of OPTIONAL_KEYS) if (info[key] !== undefined) record[key] = info[key]
  record.files = info.files
  return record
}

// How a record's package was installed: two records of one bucket must agree on it.
export const ATTESTED_METADATA = ['integrity', 'patch']

export const attestsAny = (record) => ATTESTED_METADATA.some((field) => record[field] !== undefined)
export const withAttestedOf = (record, from) => moduleInfo({ ...record, ...Object.fromEntries(ATTESTED_METADATA.map((field) => [field, from[field]])) })

// A record of an integrity and no patch attests the patch null (installed unpatched); undefined: it tells nothing.
export const attestedOf = (record, field) => record[field] ?? (field === 'patch' && record.integrity !== undefined ? null : undefined)

// A patch's text is its integrity's; its `file`, where it was found, attests nothing.
export const sameAttested = (field, a, b) => (field === 'patch' ? a?.integrity === b?.integrity : a === b)

const agree = (field, record, other, what) => {
  if (sameAttested(field, record[field], other[field])) return
  const [ours, theirs] = [record[field], other[field]].map((value) => JSON.stringify(value) ?? 'none')
  assert(false, `${what} ${field} mismatch (${ours} vs ${theirs})`)
}

// What `record` attests must be `other`'s: `other` recording none of it is a mismatch too.
export function assertAttested(record, other, what) {
  for (const field of ATTESTED_METADATA) if (attestedOf(record, field) !== undefined) agree(field, record, other, what)
}

export function withMetadataOf(record, other, what = 'module') {
  let added
  for (const field of Object.keys(RECORD_METADATA)) {
    if (ATTESTED_METADATA.includes(field) && attestedOf(record, field) !== undefined && attestedOf(other, field) !== undefined) {
      agree(field, record, other, what)
      if (field === 'patch' && record.patch?.file === undefined && other.patch?.file !== undefined) (added ??= {}).patch = other.patch
    } else if (record[field] === undefined && other[field] !== undefined) (added ??= {})[field] = other[field]
  }
  for (const field of DIR_FIELDS) {
    if (other[field] === undefined || Object.keys(other[field]).every((sub) => Object.hasOwn(record[field] ?? {}, sub))) continue
    ;(added ??= {})[field] = Object.freeze(fromEntries([...Object.entries(other[field]), ...Object.entries(record[field] ?? {})]))
  }
  return added === undefined ? record : moduleInfo({ ...record, ...added })
}

export function heldToAccounts(modules, accounts, prefix = '') {
  for (const [dir, account] of accounts) {
    if (modules.has(dir)) assertAttested(modules.get(dir), account, `${prefix}module '${dir}' (recorded vs ${account.locked ? 'locked' : 'installed'})`)
  }
}

function metadataOf(dir, info, what, fields, entriesOf) {
  const metadata = {}
  for (const [field, normalize] of Object.entries(RECORD_METADATA)) metadata[field] = fields.includes(field) ? normalize(dir, info, what) : undefined
  for (const field of DIR_FIELDS) metadata[field] = fields.includes(field) ? normalizeDirMetadata(field, dir, { ...info, [field]: entriesOf(field) }, what) : undefined
  return metadata
}

// A literal null version folds into undefined, so identity comparisons and JSON round-trips can't split on it.
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

// `scope` MUST be the artifact's own: a non-full-scope artifact records only its node_modules buckets.
export function moduleFileKeys(modules, { scope = 'full' } = {}) {
  const keys = new Set()
  for (const [dir, { files }] of modules) {
    if (scope !== 'full' && !hasNodeModulesSegment(dir)) continue
    for (const rel of Object.keys(files)) keys.add(moduleFileKey(dir, rel))
  }
  return keys
}

function executableEntryProblem(file, { what, files, formats, scope }) {
  if (file.includes('\\')) return "holds a '\\'"
  if (posixPathEscapes(file)) return 'escapes the root'
  if (scope !== 'full' && !hasNodeModulesSegment(file)) return `is outside node_modules, which a '${scope}'-scope ${what} does not record`
  if (!files.has(file)) return `names no file the ${what} records`
  const format = formats.get(file)
  if (format === 'directory') return 'is a directory capture, not a file'
  if (isStatFormat(format)) return `is a payload-free '${format}' record, not a file`
  return null
}

export function narrowExecutable(executable, { modules, formats, scope }) {
  if (executable.size === 0) return new Set()
  const files = moduleFileKeys(modules, { scope })
  return new Set(executable.values().filter((file) => executableEntryProblem(file, { what: 'artifact', files, formats, scope }) === null))
}

function assertExecutable(executable, { what, files, formats, scope }) {
  for (const file of executable) {
    const problem = executableEntryProblem(file, { what, files, formats, scope })
    assert(problem === null, `${what}: executable entry '${file}' ${problem}`)
  }
}

function parsePathList(list, at, entry, check) {
  assert(Array.isArray(list), `${at} must be an array of file paths`)
  const out = new Set()
  for (const path of list) {
    check(path)
    // A dupe would silently collapse in the Set and round-trip to different bytes.
    assert(!out.has(path), `${entry} '${path}' is listed twice`)
    out.add(path)
  }
  return out
}

export function parseExecutable(list, { what, files, formats, scope = 'full' }) {
  if (list === undefined) return new Set()
  const entry = `${what}: executable entry`
  const out = parsePathList(list, `${what}: executable`, entry, (file) =>
    assert(typeof file === 'string' && file !== '', `${entry} must be a non-empty string`))
  assertExecutable(out, { what, files, formats, scope })
  return out
}

// Omitted when empty, so every pre-`executable` artifact rewrites byte-identical.
export function serializeExecutable(executable, { what, modules, formats, scope }) {
  if (executable.size === 0) return undefined
  assertExecutable(executable, { what, files: moduleFileKeys(modules, { scope }), formats, scope })
  return fileSetToObject(executable)
}

export function assert(condition, msg) {
  if (!condition) throw new Error(msg)
}

export const LOCK_FILE = 'stasis.lock.json'
export const CONFIG_FILE = 'stasis.config.json'
export const BUNDLE_FILE = 'stasis.code.br'

export const SCOPES = new Set(['node_modules', 'full'])
export const assertScope = (scope, what) => assert(SCOPES.has(scope), `${what} scope must be node_modules or full, got ${JSON.stringify(scope)}`)

// In any case: a case-insensitive disk resolves `STASIS.LOCK.JSON` to it too.
export const isLockfileName = (path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase() === LOCK_FILE

function compareSegments(al, bl) {
  let i = 0
  while (i < al.length && al[i] === bl[i]) i++
  const ar = al.length - i
  const br = bl.length - i
  if (ar === 0 && br === 0) return 0

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

export const sortPaths = (a, b) => compareSegments(a.split('/'), b.split('/'))

// Each key split once, not at each of the sort's comparisons.
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

export function upsert(map, key, make) {
  let value = map.get(key)
  if (value === undefined) map.set(key, (value = make()))
  return value
}

export const nestedMap = (map, key) => upsert(map, key, () => new Map())

export const objectToMaps = (obj) => new Map(
  Object.entries(obj).map(([k, v]) => [k, isPlainObject(v) ? objectToMaps(v) : v])
)

// A segment walk, not posix.normalize, so this module stays free of node:path; a mid-path `..` (`a/../../x`) counts.
export function posixPathEscapes(path) {
  if (path.startsWith('/')) return true
  if (!path.includes('..')) return false
  let depth = 0
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment !== '..') depth++
    else if (--depth < 0) return true
  }
  return false
}

// `\` is part of a name off Windows, refused rather than taken for another path; on Windows `..\x` would climb out.
export const isRefusedPath = (path) => path.includes('\\') || posixPathEscapes(path)

export const assertArtifactPath = (path, what) =>
  assert(!isRefusedPath(path), `${what}: path '${path}' escapes the root or holds a '\\'`)

export const isArtifactKey = (key) => typeof key === 'string' && key !== '' && !isRefusedPath(key)
const assertEntry = (entry, what) => assert(isArtifactKey(entry), `${what}: invalid entry ${JSON.stringify(entry)}`)

export const parseEntries = (list, what) => parsePathList(list, `${what}: entries`, `${what}: entry`, (entry) => assertEntry(entry, what))

export function serializeEntries(entries, what) {
  for (const entry of entries) assertEntry(entry, what)
  return fileSetToObject(entries)
}

function assertFormat(file, format) {
  assertArtifactPath(file, 'formats')
  assert(KNOWN_FORMATS.has(format), `unknown format '${format}' for ${file}`)
}

// '' and '.' alias to one key: older artifacts keyed the root listing ''.
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

// A `stat:*` record attests a path's kind alone: one reader would skip content carried for its path, another serve it.
export function assertPayloadFree(formats, files, what) {
  for (const [file, format] of formats) {
    if (isStatFormat(format) && files.has(file)) assert(false, `${what}: '${file}' is a payload-free '${format}' record, yet carries content`)
  }
}

export function serializeFormats(formats) {
  for (const [file, format] of formats) assertFormat(file, format)
  return fileMapToObject(formats)
}

// getImport resolves each path against the root at load. A target is a file, or (--metro) a { platform: file } map.
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

export function parseImports(json) {
  assert(isPlainObject(json))
  const imports = objectToMaps(json)
  assertImports(imports)
  return imports
}

export function serializeImports(imports) {
  assertImports(imports)
  return fileMapToObject(imports)
}

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

export function parseBuckets(json, what, fields) {
  const modules = new Map()
  for (const key of json.config.scope === 'full' ? ['modules', 'sources'] : ['modules']) {
    if (key === 'modules' && json.modules === undefined) continue
    assert(isPlainObject(json[key]), `${what}: ${key} must be an object`)
    const inNodeModules = key === 'modules'
    for (const [dir, info] of Object.entries(json[key])) {
      assert(hasNodeModulesSegment(dir) === inNodeModules)
      assertArtifactPath(dir, what)
      assert(info?.name && (info.version || !inNodeModules) && info.files)
      modules.set(dir, normalizeModule(info, dir, what, fields))
    }
  }
  return modules
}

// Each part is undefined where it is none, which JSON.stringify drops. An in-memory lockfile's formats may be null.
export function serializedParts({ config: { scope }, entries, modules, formats, imports, executable }, what, group) {
  const full = scope === 'full'
  const grouped = groupModules(modules, { ...group, what })
  return {
    entries: full ? serializeEntries(entries, what) : undefined,
    sources: full ? grouped.sources : undefined,
    modules: grouped.modules,
    formats: formats === null ? undefined : serializeFormats(formats),
    imports: imports === null ? undefined : serializeImports(imports),
    executable: serializeExecutable(executable, { what, modules, formats: formats ?? new Map(), scope }),
  }
}

export function importTargetsEqual(a, b) {
  if (!(a instanceof Map) || !(b instanceof Map)) return a === b
  return a.size === b.size && a.entries().every(([platform, file]) => b.get(platform) === file)
}

const fmtTarget = (t) => (t instanceof Map ? `{${[...t].map(([p, f]) => `${p}: ${f}`).join(', ')}}` : t)

export function mergeImportMaps(a, b, label) {
  const out = new Map()
  for (const imports of [a, b]) {
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
  return out
}

export function upsertFormat(map, file, format) {
  const currentFormat = map.get(file)
  map.set(file, currentFormat === undefined ? format : reconcileFormat(format, currentFormat, file))
}

export function mergeFormatMaps(a, b, label) {
  const out = new Map()
  try {
    for (const formats of [a, b]) for (const [file, format] of formats) upsertFormat(out, file, format)
  } catch (cause) {
    throw new Error(`${label}: ${cause.message}`, { cause })
  }
  return out
}

// `b`, the INCOMING newer artifact, is authoritative for its own files: a since-lost execute bit is cleared.
export const mergeExecutableSets = (a, b, bModules, scope) =>
  (a.size === 0 ? new Set(b) : new Set(b).union(a.difference(moduleFileKeys(bModules, { scope }))))

const NON_CANONICAL_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/u

// '.' is canonical only as the root listing (rel ''). Messages are built only on failure: this runs for every file.
export function canonicalFileKey(dir, rel, what) {
  const key = moduleFileKey(dir, rel)
  if ((key !== '.' || rel !== '') && NON_CANONICAL_SEGMENT.test(key)) assert(false, `${what}: non-canonical file key ${JSON.stringify(key)}`)
  if (key.includes('\\')) assert(false, `${what}: file key '${key}' holds a '\\', which no path may`)
  return key
}

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

export const duplicateKeyError = (what, regenerate) => (key) => assert(false,
  `duplicate file key '${key}' across ${what} buckets -- module bucketing changed between writes ` +
  `(a workspace package without a version now owns its own bucket); regenerate the ${regenerate}`)

// Result `files` objects are null-prototype, so a `__proto__` file name is a plain own key. With
// `held`, `b` is held to `a`, not merged into it: what `b` alone attests stays a claim of its own files.
export function mergeModuleMaps(a, b, label, { held = false } = {}) {
  const out = new Map()
  for (const modules of [a, b]) {
    for (const [dir, info] of modules) {
      const existing = out.get(dir)
      if (existing === undefined) {
        out.set(dir, moduleInfo({ ...info, files: Object.assign(Object.create(null), info.files) }))
        continue
      }
      assert(existing.name === info.name,
        `${label}: module '${dir}' name mismatch ('${existing.name}' vs '${info.name}')`)
      assert(existing.version === info.version,
        `${label}: module '${dir}' version mismatch ('${existing.version}' vs '${info.version}')` +
        ((existing.version == null) === (info.version == null) ? '' :
          ` -- an artifact from an older stasis may record a placeholder version for a workspace ` +
          `package without one; regenerate it (bundle=replace / lock=replace)`))
      assert(existing.ecosystem === info.ecosystem,
        `${label}: module '${dir}' ecosystem mismatch ('${existing.ecosystem ?? '(none)'}' vs '${info.ecosystem ?? '(none)'}')`)
      // An attested value one side alone records is of its files alone: the other may add none.
      out.set(dir, withMetadataOf(existing, info, `${label}: module '${dir}'`))
      for (const field of ATTESTED_METADATA) {
        if ((existing[field] === undefined) === (info[field] === undefined) || (held && existing[field] === undefined)) continue
        const [attests, adds] = existing[field] === undefined ? [info, existing] : [existing, info]
        const added = Object.keys(adds.files).find((rel) => !Object.hasOwn(attests.files, rel))
        if (added !== undefined) assert(false, `${label}: module '${dir}' ${field} is recorded of one side's files, not of '${moduleFileKey(dir, added)}' the other adds`)
      }
      for (const [rel, value] of Object.entries(info.files)) {
        if (!Object.hasOwn(existing.files, rel)) existing.files[rel] = value
        else assert(existing.files[rel] === value, `${label}: content mismatch for '${moduleFileKey(dir, rel)}'`)
      }
    }
  }
  // Bucketing can change between releases, which per-dir absorption can't see: never WRITE what the next parse rejects.
  flatFileKeys(out, label, (key, owner, dir) => assert(false,
    `${label}: file '${key}' is bucketed under both '${owner}' and '${dir}' -- module bucketing ` +
    `changed between the artifacts (a workspace package without a version now owns its own ` +
    `bucket); regenerate the artifact (bundle=replace / lock=replace)`))
  return out
}

// A full path SEGMENT, NOT a bare substring (`foo_node_modules/dep` is a source dir, not a bucket).
export const hasNodeModulesSegment = (path) =>
  path === 'node_modules' || path.startsWith('node_modules/') || path.endsWith('/node_modules') || path.includes('/node_modules/')

const NODE_MODULES_MARKER = 'node_modules/'

// Segment-aligned: `lastIndexOf` alone would also match a bare substring (`foo_node_modules/`).
function lastNodeModulesMarker(path) {
  let idx = path.length
  while ((idx = path.lastIndexOf(NODE_MODULES_MARKER, idx - 1)) !== -1) {
    if (idx === 0 || path[idx - 1] === '/') return idx
  }
  return -1
}

export function splitNodeModulesPath(path) {
  const idx = lastNodeModulesMarker(path)
  if (idx === -1) return null
  const after = idx + NODE_MODULES_MARKER.length
  const parts = path.slice(after).split('/')
  const pkgLen = parts[0].startsWith('@') ? 2 : 1
  const nameParts = parts.slice(0, pkgLen)
  if (parts.length <= pkgLen || nameParts.includes('')) return null
  const name = nameParts.join('/')
  return { dir: path.slice(0, after) + name, rel: parts.slice(pkgLen).join('/'), name }
}
