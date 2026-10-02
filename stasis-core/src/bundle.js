import {
  assert,
  assertArtifactPath,
  canonicalFileKey,
  duplicateKeyError,
  fileMapToObject,
  fileSetToObject,
  fromEntries,
  flatFileKeys,
  groupModules,
  hasNodeModulesSegment,
  isPlainObject,
  mergeFormatMaps,
  mergeImportMaps,
  mergeExecutableSets,
  mergeModuleMaps,
  moduleFileKey,
  normalizeModule,
  parseEntries,
  parseExecutable,
  parseFormats,
  parseImports,
  serializeEntries,
  serializeExecutable,
  posixPathEscapes,
  splitNodeModulesPath,
} from './artifact-util.js'

const VERSION = 1
const LEGACY_VERSION = 0

const duplicateKey = duplicateKeyError('bundle', 'artifact (bundle=replace)')

// A v0 path's bucket split; '' and '.' both spell the root listing (rel '').
const inferModuleDir = (path) =>
  splitNodeModulesPath(path) ?? { dir: '.', rel: path === '.' ? '' : path, name: null }

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

// Union of the informational `reason` maps in canonical form: consumers sorted, each file list
// deduped and path-sorted. Canonical even when only one side is given, so a fresh withReason()
// stamp or a parsed artifact can't leak discovery/record order into the map (state's
// #bundleReason sorts the same way). A non-array list (unvalidated -- informational) is dropped.
const mergeReason = (a, b) => {
  if (a === undefined && b === undefined) return undefined
  // Accumulated in a Map: on a plain object a '__proto__' consumer key would hit the prototype.
  const merged = new Map()
  for (const src of [a, b]) {
    for (const [consumer, files] of Object.entries(src ?? {})) {
      if (!Array.isArray(files)) continue
      let set = merged.get(consumer)
      if (set === undefined) merged.set(consumer, (set = new Set()))
      for (const file of files) set.add(file)
    }
  }
  return fromEntries([...merged.keys()].toSorted().map((c) => [c, fileSetToObject(merged.get(c))]))
}

// GitHub `owner/name` (owner 1-39, name 1-100 chars).
const GITHUB_REPO = /^(?=[A-Za-z0-9-]{1,39}\/)[A-Za-z0-9](?:-?[A-Za-z0-9])*\/(?!\.\.?$)[\w.-]{1,100}$/u
// Non-empty normalized repo-relative path of URL-safe segments (the repo root is `root: true`).
const REPO_DIRECTORY = /^(?!\.\.?(?:\/|$))[\w.~@+-]+(?:\/(?!\.\.?(?:\/|$))[\w.~@+-]+)*$/u
// Full lowercase SHA-1 or SHA-256.
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const REPO_FIELDS = {
  github: (v) => typeof v === 'string' && GITHUB_REPO.test(v),
  directory: (v) => typeof v === 'string' && v.length <= 1024 && REPO_DIRECTORY.test(v),
  root: (v) => v === true,
  commit: (v) => typeof v === 'string' && GIT_SHA.test(v),
}

// Validate one `repo` field without throwing.
export const isValidRepoField = (key, value) => Object.hasOwn(REPO_FIELDS, key) && REPO_FIELDS[key](value)

// `repo` of a bundle plus one added to it: only agreeing fields survive, and none if `github` differs.
export const mergeRepo = (a, b) => {
  if (a?.github === undefined || a.github.toLowerCase() !== b?.github?.toLowerCase()) return undefined // GitHub names are case-insensitive
  const kept = Object.keys(REPO_FIELDS).filter((key) => a[key] !== undefined && (key === 'github' || a[key] === b[key]))
  return fromEntries(kept.map((key) => [key, a[key]]))
}

// Validate a block against its `fields` (each optional: a check, or a nested block's fields); canonical, frozen, undefined if empty.
const normalizeBlock = (block, fields, what) => {
  if (block === undefined) return undefined
  assert(isPlainObject(block), `bundle ${what} must be an object`)
  for (const key of Object.keys(block)) assert(Object.hasOwn(fields, key), `unknown bundle ${what} key '${key}'`)
  const entries = Object.entries(fields).map(([key, check]) => {
    if (typeof check === 'object') return [key, normalizeBlock(block[key], check, `${what}.${key}`)]
    assert(block[key] === undefined || check(block[key]), `invalid bundle ${what}.${key}: ${JSON.stringify(block[key])}`)
    return [key, block[key]]
  }).filter(([, value]) => value !== undefined)
  return entries.length === 0 ? undefined : Object.freeze(fromEntries(entries))
}

// Validate `repo` (all fields optional); canonical key order, undefined if empty.
const normalizeRepo = (repo) => {
  const normalized = normalizeBlock(repo, REPO_FIELDS, 'repo')
  assert(normalized?.directory === undefined || normalized.root === undefined, 'bundle repo has both directory and root')
  return normalized
}

// A package name or version: characters some ecosystem uses there (npm's legacy `~'!()*` too), so not space or `"#$%&,:;<=>?[\]^`{|}`.
const isPackageString = (v) => typeof v === 'string' && /^[\w.+@/~'!()*-]+$/u.test(v)
const PACKAGE_BLOCK = { name: isPackageString, version: isPackageString }
// One block per ecosystem, named as a module's `ecosystem` is.
const PACKAGE_FIELDS = { npm: PACKAGE_BLOCK, composer: PACKAGE_BLOCK, cargo: PACKAGE_BLOCK }

// `package` of a bundle plus one added to it: per ecosystem, only agreeing fields survive, and none unless `name` does.
const mergePackage = (a, b) => fromEntries(Object.keys(PACKAGE_FIELDS).map((ecosystem) => {
  const [x, y] = [a?.[ecosystem], b?.[ecosystem]]
  return [ecosystem, x?.name !== undefined && x.name === y?.name ? fromEntries(Object.entries(x).filter(([key, value]) => value === y[key])) : undefined]
}))

// JSON shape of stasis.code.br; callers own the brotli wrap. parse accepts legacy v0 and v1, serialize always writes v1.
export class Bundle {
  static VERSION = VERSION

  version = VERSION
  config
  entries
  modules
  formats
  imports
  // Project-relative paths of bundled files carrying a POSIX execute bit, for `stasis extract`. Files only, never a `directory`.
  executable
  // Informational only, NOT attested -- never consulted for verification.
  reason
  // Informational, not attested, never in a lockfile; validated on every assignment, and frozen.
  #repo
  get repo() {
    return this.#repo
  }
  set repo(repo) {
    this.#repo = normalizeRepo(repo)
  }
  // `{ npm | composer | cargo: { name, version } }`: the package this bundle is; as `repo`, but never set by a build.
  #package
  get package() {
    return this.#package
  }
  set package(pkg) {
    this.#package = normalizeBlock(pkg, PACKAGE_FIELDS, 'package')
  }

  constructor({ config = { scope: 'full' }, entries, modules, formats, imports, executable, reason, repo, package: pkg, version = VERSION } = {}) {
    assert([LEGACY_VERSION, VERSION].includes(version))
    assert(['node_modules', 'full'].includes(config.scope))
    this.version = version
    this.config = config
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
    this.formats = formats ?? new Map()
    this.imports = imports ?? new Map()
    this.executable = executable ?? new Set()
    this.reason = reason
    this.repo = normalizeRepo(repo)
    this.package = pkg
  }

  // Flat project-relative view of the raw stored file contents (resources stay base64).
  get sources() {
    const m = new Map()
    for (const [dir, { files }] of this.modules) {
      for (const [rel, content] of Object.entries(files)) m.set(moduleFileKey(dir, rel), content)
    }
    return m
  }

  static isResourceFormat(format) {
    return format === 'resource' || format === 'resource:base64' || format === 'directory'
  }

  // True if any bundled file is non-resource; a full-scope code bundle must declare an entry to be runnable (State#absorbCodeBundle).
  get hasCode() {
    for (const [dir, { files }] of this.modules) {
      for (const rel of Object.keys(files)) {
        if (!Bundle.isResourceFormat(this.formats.get(moduleFileKey(dir, rel)))) return true
      }
    }
    return false
  }

  static parse(text) {
    return Bundle.fromJSON(JSON.parse(text))
  }

  // The `sources` key of the file whose contents sit at JSON key path `path`, else undefined; throws if non-canonical.
  static fileKeyAt(path) {
    const [top, dir, files, rel] = path
    if (typeof dir !== 'string') return undefined
    // v0 `sources.<path>`
    if (path.length === 2 && top === 'sources') {
      const split = inferModuleDir(dir)
      return canonicalFileKey(split.dir, split.rel, 'bundle')
    }
    // v1 `sources|modules.<dir>.files.<rel>`
    if (path.length === 4 && (top === 'sources' || top === 'modules') && files === 'files' && typeof rel === 'string') {
      return canonicalFileKey(dir, rel, 'bundle')
    }
    return undefined
  }

  // parse() on an already-parsed value; `contents: false` takes a symbol placeholder per file and locks contents out.
  static fromJSON(json, { contents = true } = {}) {
    assert(json.version === VERSION || json.version === LEGACY_VERSION)
    assert(['node_modules', 'full'].includes(json.config?.scope))
    // Validated into a typed Map early: a raw-object lookup like `__proto__` would hit the prototype.
    const formats = parseFormats(json.formats)

    const modules = new Map()
    let entries = new Set()

    if (json.version === VERSION) {
      const full = json.config.scope === 'full'
      if (json.modules !== undefined) {
        assert(typeof json.modules === 'object' && json.modules !== null)
        for (const [dir, info] of Object.entries(json.modules)) {
          assert(hasNodeModulesSegment(dir))
          assertArtifactPath(dir, 'bundle')
          assert(info?.name && info.version && info.files)
          modules.set(dir, normalizeModule(info))
        }
      }
      if (full) {
        assert(json.sources && typeof json.sources === 'object')
        for (const [dir, info] of Object.entries(json.sources)) {
          assert(!hasNodeModulesSegment(dir))
          assertArtifactPath(dir, 'bundle')
          // A workspace bucket may omit version (a private/unpublished package.json can lack one).
          assert(info?.name && info.files)
          modules.set(dir, normalizeModule(info))
        }
        // Empty entries are valid (`stasis add` attests files without making them entry points); state.assertEntry fails closed on an empty set.
        if (json.entries !== undefined) entries = parseEntries(json.entries, 'bundle')
      } else {
        assert(json.entries === undefined)
        assert(json.sources === undefined)
      }
    } else {
      assert(json.sources)
      for (const [path, content] of Object.entries(json.sources)) {
        assertArtifactPath(path, 'bundle')
        const { dir, rel, name } = inferModuleDir(path)
        assert(!posixPathEscapes(dir) && !posixPathEscapes(rel))
        if (!modules.has(dir)) modules.set(dir, { name, version: null, files: Object.create(null) })
        const { files } = modules.get(dir)
        assert(!Object.hasOwn(files, rel), `bundle: duplicate file key '.' (v0 '' and '.')`)
        files[rel] = content
      }
    }

    // Flat keys must be unique across buckets: two different bucket splits can flatten to one path, and the `sources` getter would serve either payload.
    const flatKeys = flatFileKeys(modules, 'bundle', duplicateKey)
    const imports = parseImports(json.imports)

    if (!contents) for (const [dir, info] of modules) modules.set(dir, lockModule(dir, info))

    return new Bundle({
      version: json.version,
      config: json.config,
      entries,
      modules,
      formats,
      imports,
      // Every executable must be a file this bundle carries. A v0 `executable` is ignored: with no per-file `formats` it could point `extract` at any path to chmod +x.
      executable: json.version === VERSION
        ? parseExecutable(json.executable, { what: 'bundle', files: flatKeys, formats, scope: json.config.scope })
        : new Set(),
      reason: isPlainObject(json.reason) ? json.reason : undefined,
      repo: json.repo,
      package: json.package,
    })
  }

  serialize() {
    // Never write an artifact that parse would reject.
    flatFileKeys(this.modules, 'bundle', duplicateKey)
    const { modules, sources } = groupModules(this.modules, { skipEmpty: true })
    const full = this.config.scope === 'full'
    const data = { version: VERSION, config: this.config }
    if (this.repo !== undefined) data.repo = this.repo
    if (this.package !== undefined) data.package = this.package
    if (full) data.entries = serializeEntries(this.entries, 'bundle')
    data.formats = fileMapToObject(this.formats)
    data.imports = fileMapToObject(this.imports)
    const executable = serializeExecutable(this.executable, {
      what: 'bundle', modules: this.modules, formats: this.formats, scope: this.config.scope,
    })
    if (executable !== undefined) data.executable = executable
    // Canonicalized like every other sorted field, so a parsed artifact's order can't leak into the bytes.
    if (this.reason !== undefined) data.reason = mergeReason(this.reason, undefined)
    // File contents are written last, after every other key: sources, then modules.
    if (full) data.sources = sources
    data.modules = modules
    return JSON.stringify(data, undefined, 2)
  }

  // Stamp `consumer` onto every carried file in the informational `reason` map.
  withReason(consumer) {
    const { version, config, entries, modules, formats, imports, executable, repo, package: pkg } = this
    const reason = mergeReason(this.reason, { [consumer]: [...this.sources.keys()] })
    return new Bundle({ version, config, entries, modules, formats, imports, executable, reason, repo, package: pkg })
  }

  // Strict union of two Bundles (returns a NEW one): any genuine conflict throws -- a bundle is an attestation.
  merge(other) {
    assert(this.config.scope === other.config.scope,
      `bundle merge: scope mismatch ('${this.config.scope}' vs '${other.config.scope}')`)
    return new Bundle({
      config: { scope: this.config.scope },
      entries: new Set([...this.entries, ...other.entries]),
      modules: mergeModuleMaps(this.modules, other.modules, 'bundle merge'),
      formats: mergeFormatMaps(this.formats, other.formats, 'bundle merge'),
      imports: mergeImportMaps(this.imports, other.imports, 'bundle merge'),
      // `other` (the incoming, newer build) wins for the files it carries -- see mergeExecutableSets.
      executable: mergeExecutableSets(this.executable, other.executable, other.modules, this.config.scope),
      reason: mergeReason(this.reason, other.reason),
      repo: mergeRepo(this.repo, other.repo),
      package: mergePackage(this.package, other.package),
    })
  }
}
