import {
  assert,
  assertArtifactPath,
  assertScope,
  canonicalFileKey,
  checkedFileKeys,
  EXECUTE_BITS,
  fromEntries,
  isForbiddenFile,
  isPlainObject,
  isStatFormat,
  LOCK_FILE,
  mergedParts,
  moduleFileKey,
  moduleInfo,
  narrowExecutable,
  normalizeBlock,
  normalizeRepo,
  PACKAGE_BLOCK,
  parseParts,
  posixPathEscapes,
  REPO_FIELDS,
  RESOURCE_FORMATS,
  sameGithub,
  serializedParts,
  sortedByPath,
  splitNodeModulesPath,
  upsert,
} from './artifact-util.js'
import { Lockfile } from './lockfile.js'

const VERSION = 1
const LEGACY_VERSION = 0

// A bundle, to the parts it shares with a lockfile: it writes no empty bucket, and holds its contents to what it may carry.
const BUNDLE = {
  what: 'bundle',
  regenerate: 'artifact (bundle=replace)',
  skipEmpty: true,
  checkFiles: (flatKeys, formats) => {
    for (const key of flatKeys.keys()) assert(!isForbiddenFile(key), `bundle: ${key} is a file no bundle may carry`)
    // A `stat:*` record attests a path's kind alone: one reader would skip content carried for its path, another serve it.
    for (const [file, format] of formats) {
      if (isStatFormat(format) && flatKeys.has(file)) assert(false, `bundle: '${file}' is a payload-free '${format}' record, yet carries content`)
    }
  },
}

// '' and '.' both spell the root listing (rel '').
const inferModuleDir = (path) =>
  splitNodeModulesPath(path) ?? { dir: '.', rel: path === '.' ? '' : path, name: null }

function legacyModules(sources) {
  assert(isPlainObject(sources), 'bundle: sources must be an object')
  const modules = new Map()
  for (const [path, content] of Object.entries(sources)) {
    assertArtifactPath(path, 'bundle')
    const { dir, rel, name } = inferModuleDir(path)
    assert(!posixPathEscapes(dir) && !posixPathEscapes(rel))
    const { files } = upsert(modules, dir, () => ({ name, version: null, files: Object.create(null) }))
    assert(!Object.hasOwn(files, rel), `bundle: duplicate file key '.' (v0 '' and '.')`)
    files[rel] = content
  }
  return modules
}

function contentsLocked() {
  throw new Error('bundle: file contents are not retained by this contents-free Bundle')
}

// Each file stays an own enumerable key, but reading its contents throws; each value must be a placeholder.
const lockModule = (dir, { files, ...info }) => {
  const locked = Object.create(null)
  for (const [rel, value] of Object.entries(files)) {
    if (typeof value !== 'symbol') assert(false, `bundle: file '${moduleFileKey(dir, rel)}' is not a placeholder`)
    Object.defineProperty(locked, rel, { get: contentsLocked, enumerable: true })
  }
  return { ...info, files: Object.freeze(locked) }
}

// Canonical even from one side, so no stamp or parsed artifact leaks discovery order; a non-array list is dropped.
const mergeReason = (a, b) => {
  if (a === undefined && b === undefined) return undefined
  // Accumulated in a Map: on a plain object a '__proto__' consumer key would hit the prototype.
  const merged = new Map()
  for (const src of [a, b]) {
    for (const [consumer, files] of Object.entries(src ?? {})) {
      if (Array.isArray(files)) merged.set(consumer, new Set([...(merged.get(consumer) ?? []), ...files]))
    }
  }
  return fromEntries([...merged.keys()].toSorted().map((c) => [c, sortedByPath(merged.get(c))]))
}

export const isValidRepoField = (key, value) => Object.hasOwn(REPO_FIELDS, key) && REPO_FIELDS[key](value)

// What normalized blocks `a` and `b` of one thing, by their `key` (`same` of the two), agree on; `a`'s key is kept.
const agreed = (a, b, key, same) => {
  if (a?.[key] === undefined || !same(a[key], b?.[key])) return undefined
  return fromEntries(Object.entries(a).filter(([field, value]) => field === key || value === b[field]))
}

export const mergeRepo = (a, b) => agreed(a, b, 'github', sameGithub)

// An older stasis's `root: true` is read as unknown: it recorded one from a package.json's claim too.
const parsedRepo = (repo) => {
  if (!isPlainObject(repo) || repo.root !== true || Object.hasOwn(repo, 'directory')) return repo
  const { root: _root, ...rest } = repo
  return rest
}

const PACKAGE_FIELDS = { npm: PACKAGE_BLOCK, composer: PACKAGE_BLOCK, cargo: PACKAGE_BLOCK }

// fromLockfile's, fromTar's and toTar's alone, with the web's globals, so the rest loads in a runtime without them: UTF-8
// as it is, a byte order mark kept as text; and base64, in chunks a call's arguments hold.
const utf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function base64(bytes) {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}
const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

const mergePackage = (a, b) =>
  fromEntries(Object.keys(PACKAGE_FIELDS).map((ecosystem) => [ecosystem, agreed(a?.[ecosystem], b?.[ecosystem], 'name', Object.is)]))

// JSON shape of stasis.code.br; callers own the brotli wrap. parse accepts legacy v0 and v1, serialize writes v1.
export class Bundle {
  static VERSION = VERSION

  // Informational, not attested; validated on every assignment, and frozen. In a lockfile of a GitHub build's alone
  // (Lockfile#repo), never one of a bundle's.
  #repo
  get repo() {
    return this.#repo
  }
  set repo(repo) {
    this.#repo = normalizeRepo(repo)
  }
  // `{ npm | composer | cargo: { name, version } }`: as `repo`, but never set by a build.
  #package
  get package() {
    return this.#package
  }
  set package(pkg) {
    this.#package = normalizeBlock(pkg, PACKAGE_FIELDS, 'bundle package')
  }

  constructor({ config = { scope: 'full' }, entries, modules, formats, imports, executable, reason, repo, package: pkg, version = VERSION } = {}) {
    assert([LEGACY_VERSION, VERSION].includes(version))
    assertScope(config.scope, 'bundle')
    this.version = version
    this.config = config
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
    this.formats = formats ?? new Map()
    this.imports = imports ?? new Map()
    this.executable = executable ?? new Set() // files only, never a `directory`
    this.reason = reason // informational only, NOT attested -- never consulted for verification
    this.repo = repo
    this.package = pkg
  }

  // The raw stored contents by flat key: resources stay base64.
  get sources() {
    const m = new Map()
    for (const [dir, { files }] of this.modules) {
      for (const [rel, content] of Object.entries(files)) m.set(moduleFileKey(dir, rel), content)
    }
    return m
  }

  static isResourceFormat(format) {
    return RESOURCE_FORMATS.has(format) || format === 'directory'
  }

  // A full-scope code bundle must declare an entry to be runnable (State checks it on load).
  get hasCode() {
    return this.modules.entries().some(([dir, { files }]) =>
      Object.keys(files).some((rel) => !Bundle.isResourceFormat(this.formats.get(moduleFileKey(dir, rel)))))
  }

  // What parse holds a bundle's files to, for one built in memory (as `stasis build` builds one of a lockfile): no file
  // key twice, no file no bundle may carry, and no content for a payload-free stat record. Throws; returns `bundle`.
  static checkFiles(bundle) {
    checkedFileKeys(bundle.modules, bundle.formats, BUNDLE)
    return bundle
  }

  static parse(text) {
    return Bundle.fromJSON(JSON.parse(text))
  }

  // The bundle of a lockfile's files, each `read(file)`'s bytes (a Uint8Array; it throws where there is none) held to the
  // digest it records, `integrityOf(bytes)` (an SRI sha512, as state-util's sha512integrity), as a `stasis run
  // --lock=frozen` replay holds them; of the repository it records. A directory capture (format 'directory') is no file
  // to load. Held to checkFiles, which Lockfile.parse does not hold a lockfile to.
  static fromLockfile(lockfile, { read, integrityOf }) {
    assert(lockfile.imports, 'stasis: lockfile has no recorded import graph')
    const formats = lockfile.formats ?? new Map()
    const text = utf8()
    const modules = new Map()
    for (const [dir, { files, ...info }] of lockfile.modules) {
      const out = Object.create(null)
      for (const [rel, integrity] of Object.entries(files)) {
        const file = moduleFileKey(dir, rel)
        const format = formats.get(file)
        if (format === 'directory') continue
        const bytes = read(file)
        const actual = integrityOf(bytes)
        if (actual !== integrity) throw new Error(`stasis: ${file} does not match the lockfile (expected ${integrity}, got ${actual})`)
        if (format === 'resource:base64') {
          out[rel] = base64(bytes)
          continue
        }
        // Else UTF-8: a lossy transcode (U+FFFD) would serve other bytes than those verified.
        try {
          out[rel] = text.decode(bytes)
        } catch (cause) {
          throw new Error(`stasis: ${file} is recorded as '${format ?? 'code'}' but is not valid UTF-8`, { cause })
        }
      }
      modules.set(dir, moduleInfo({ ...info, files: out }))
    }
    return Bundle.checkFiles(new Bundle({
      config: lockfile.config,
      entries: lockfile.entries,
      modules,
      imports: lockfile.imports,
      formats,
      // To the files carried (a skipped `directory` drops out), keeping parse's rules true for a hand-built lockfile.
      executable: narrowExecutable(lockfile.executable, { modules, formats, scope: lockfile.config.scope }),
      repo: lockfile.repo,
    }))
  }

  // The bundle of a .stasis.tgz's tar, unpacked (its entries `{ name, type, mode, data }`, as @preventive/archive's unpack
  // gives them; the caller gunzips and unpacks it, as it unbrotlis a stasis.code.br): fromLockfile's of the
  // stasis.lock.json at its top, which must attest exactly its files, each of the bytes and execute bit it attests,
  // nothing else in it but directories, and record no directory capture (a listing, which a tar holds none of; a stat
  // record, payload-free, it may). Throws naming what isn't.
  static fromTar(entries, { integrityOf }) {
    const files = new Map()
    for (const entry of entries) {
      if (entry.type === 'directory') continue
      assert(entry.type === 'file' || entry.type === 'contiguous-file', `${entry.name} is a ${entry.type}, which no ${LOCK_FILE} attests`)
      files.set(entry.name, entry)
    }
    assert(files.has(LOCK_FILE), `holds no ${LOCK_FILE} at its top`)
    let lockfile
    try {
      lockfile = Lockfile.parse(utf8().decode(files.get(LOCK_FILE).data))
    } catch (cause) {
      throw new Error(`its ${LOCK_FILE} is no stasis lockfile${cause.message ? ` (${cause.message})` : ''}`, { cause })
    }
    for (const [file, format] of lockfile.formats) assert(format !== 'directory', `its ${LOCK_FILE} records '${file}' as a directory capture, which a .stasis.tgz can't carry`)
    const read = new Set()
    const bundle = Bundle.fromLockfile(lockfile, {
      integrityOf,
      read: (path) => {
        const data = files.get(path)?.data
        assert(data !== undefined, `${path}, which its ${LOCK_FILE} attests, is not in it`)
        read.add(path)
        return data
      },
    })
    for (const [path, { mode }] of files) {
      if (path === LOCK_FILE) continue
      assert(read.has(path), `${path} is in it, but not in its ${LOCK_FILE}`)
      assert(((mode & EXECUTE_BITS) !== 0) === lockfile.executable.has(path), `${path}'s execute bit is not the one its ${LOCK_FILE} attests`)
    }
    return bundle
  }

  // What fromTar takes back: the bundle's tar, to pack (its entries `{ name, mode, data }`, as @preventive/archive's pack
  // takes them; the caller packs and gzips it, as it brotlis a stasis.code.br). The stasis.lock.json of its files at its
  // top, each file's digest `integrityOf(bytes)`'s, of the repository the bundle records; then each file by its path,
  // an executable one 0o755. A directory capture is the lockfile's alone, as a tar holds no listing; `reason` and
  // `package`, which a lockfile records none of, are left out.
  toTar({ integrityOf }) {
    const text = new TextEncoder()
    const data = new Map([...this.sources].map(([file, content]) => [file, this.formats.get(file) === 'resource:base64' ? fromBase64(content) : text.encode(content)]))
    const lockfile = Lockfile.fromBundle(this, (file) => integrityOf(data.get(file)))
    lockfile.repo = this.repo
    const files = sortedByPath(data.keys()).filter((file) => this.formats.get(file) !== 'directory')
    return [
      { name: LOCK_FILE, mode: 0o644, data: text.encode(lockfile.serialize()) },
      ...files.map((name) => ({ name, mode: this.executable.has(name) ? 0o755 : 0o644, data: data.get(name) })),
    ]
  }

  // The `sources` key of the file whose contents sit at JSON key path `path`, else undefined; throws if non-canonical.
  static fileKeyAt(path) {
    const [top, dir, files, rel] = path
    if (typeof dir !== 'string') return undefined
    if (path.length === 2 && top === 'sources') {
      const split = inferModuleDir(dir)
      return canonicalFileKey(split.dir, split.rel, 'bundle')
    }
    if (path.length === 4 && (top === 'sources' || top === 'modules') && files === 'files' && typeof rel === 'string') {
      return canonicalFileKey(dir, rel, 'bundle')
    }
    return undefined
  }

  // parse() on an already-parsed value; `contents: false` takes a symbol placeholder per file and locks contents out.
  static fromJSON(json, { contents = true } = {}) {
    assert(json.version === VERSION || json.version === LEGACY_VERSION)
    assertScope(json.config?.scope, 'bundle')
    const v1 = json.version === VERSION
    if (v1 && json.config.scope !== 'full') assert(json.entries === undefined && json.sources === undefined)
    // A v0 `entries` and `executable` are ignored: with no per-file `formats` the latter could point `extract` at any
    // path to chmod +x.
    const parts = v1 ? parseParts(json, BUNDLE)
      : parseParts({ ...json, entries: undefined, executable: undefined }, BUNDLE, legacyModules(json.sources))
    if (!contents) for (const [dir, info] of parts.modules) parts.modules.set(dir, lockModule(dir, info))
    return new Bundle({
      ...parts,
      version: json.version,
      reason: isPlainObject(json.reason) ? json.reason : undefined,
      repo: parsedRepo(json.repo),
      package: json.package,
    })
  }

  serialize() {
    return JSON.stringify(this.#serialized(), undefined, 2)
  }

  serializedBytes() {
    const value = this.#serialized()
    const dirs = Object.keys(value.modules)
    if (dirs.length === 0) return Buffer.from(JSON.stringify(value, undefined, 2))
    const { modules, ...rest } = value
    const head = JSON.stringify(rest, undefined, 2)
    assert(head.endsWith('\n}'))
    const pieces = []
    const add = (text) => pieces.push(Buffer.from(text))
    add(head.slice(0, -2))
    add(',\n  "modules": {\n')
    for (const [i, dir] of dirs.entries()) {
      if (i > 0) add(',\n')
      // `{\n  "indent": {\n<member>\n  }\n}`, the member nested as it is
      add(JSON.stringify({ indent: { [dir]: modules[dir] } }, undefined, 2).slice(16, -6))
    }
    add('\n  }\n}')
    return Buffer.concat(pieces)
  }

  #serialized() {
    const { entries, sources, modules, formats, imports, executable } = serializedParts(this, BUNDLE)
    // File contents are written last, after every other key: sources, then modules.
    return {
      version: VERSION, config: this.config, repo: this.repo, package: this.package, entries, formats, imports, executable,
      reason: mergeReason(this.reason, undefined), sources, modules,
    }
  }

  // `repo` and `package` are accessors, which a spread leaves out.
  withReason(consumer, files = [...this.sources.keys()]) {
    const reason = mergeReason(this.reason, { [consumer]: files })
    return new Bundle({ ...this, reason, repo: this.repo, package: this.package })
  }

  // Strict union of two Bundles (returns a NEW one): any genuine conflict throws -- a bundle is an attestation.
  merge(other) {
    return new Bundle({
      ...mergedParts(this, other, 'bundle merge'),
      reason: mergeReason(this.reason, other.reason),
      repo: mergeRepo(this.repo, other.repo),
      package: mergePackage(this.package, other.package),
    })
  }
}
