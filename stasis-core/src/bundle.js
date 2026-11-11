import {
  assert,
  assertArtifactPath,
  assertPayloadFree,
  assertScope,
  canonicalFileKey,
  duplicateKeyError,
  fileSetToObject,
  fromEntries,
  flatFileKeys,
  isLockfileName,
  isPlainObject,
  mergeFormatMaps,
  mergeImportMaps,
  mergeExecutableSets,
  mergeModuleMaps,
  moduleFileKey,
  normalizeBlock,
  normalizeRepo,
  PACKAGE_BLOCK,
  parseBuckets,
  parseEntries,
  parseExecutable,
  parseFormats,
  parseImports,
  posixPathEscapes,
  REPO_FIELDS,
  RESOURCE_FORMATS,
  sameGithub,
  serializedParts,
  splitNodeModulesPath,
  upsert,
} from './artifact-util.js'

const VERSION = 1
const LEGACY_VERSION = 0

const duplicateKey = duplicateKeyError('bundle', 'artifact (bundle=replace)')

// Unique across buckets, else the `sources` getter would serve either payload. No bundle carries a stasis lockfile:
// extracted, one would replace the attestation a frozen extract checks against, or root a project of its own.
const checkedFileKeys = (modules, formats) => {
  const flatKeys = flatFileKeys(modules, 'bundle', duplicateKey)
  for (const key of flatKeys.keys()) assert(!isLockfileName(key), `bundle: ${key} is a stasis lockfile, which no bundle may carry`)
  assertPayloadFree(formats, flatKeys, 'bundle')
  return flatKeys
}

// '' and '.' both spell the root listing (rel '').
const inferModuleDir = (path) =>
  splitNodeModulesPath(path) ?? { dir: '.', rel: path === '.' ? '' : path, name: null }

// A v0 bundle's flat `sources`, bucketed.
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

// Canonical even from one side, so a withReason() stamp or a parsed artifact can't leak discovery order. A
// non-array list (unvalidated: informational) is dropped.
const mergeReason = (a, b) => {
  if (a === undefined && b === undefined) return undefined
  // Accumulated in a Map: on a plain object a '__proto__' consumer key would hit the prototype.
  const merged = new Map()
  for (const src of [a, b]) {
    for (const [consumer, files] of Object.entries(src ?? {})) {
      if (Array.isArray(files)) merged.set(consumer, new Set([...(merged.get(consumer) ?? []), ...files]))
    }
  }
  return fromEntries([...merged.keys()].toSorted().map((c) => [c, fileSetToObject(merged.get(c))]))
}

export const isValidRepoField = (key, value) => Object.hasOwn(REPO_FIELDS, key) && REPO_FIELDS[key](value)

// Only agreeing fields survive, and none if `github` differs.
export const mergeRepo = (a, b) => {
  if (a?.github === undefined || !sameGithub(a.github, b?.github)) return undefined
  const kept = Object.keys(REPO_FIELDS).filter((key) => a[key] !== undefined && (key === 'github' || a[key] === b[key]))
  return fromEntries(kept.map((key) => [key, a[key]]))
}

// An older stasis's `root: true` is read as unknown: it recorded one from a package.json's claim too.
const parsedRepo = (repo) => {
  if (!isPlainObject(repo) || repo.root !== true || Object.hasOwn(repo, 'directory')) return repo
  const { root: _root, ...rest } = repo
  return rest
}

// One block per ecosystem, named as a module's `ecosystem` is.
const PACKAGE_FIELDS = { npm: PACKAGE_BLOCK, composer: PACKAGE_BLOCK, cargo: PACKAGE_BLOCK }

// Per ecosystem, only agreeing fields survive, and none unless `name` does.
const mergePackage = (a, b) => fromEntries(Object.keys(PACKAGE_FIELDS).map((ecosystem) => {
  const [x, y] = [a?.[ecosystem], b?.[ecosystem]]
  return [ecosystem, x?.name !== undefined && x.name === y?.name ? fromEntries(Object.entries(x).filter(([key, value]) => value === y[key])) : undefined]
}))

// JSON shape of stasis.code.br; callers own the brotli wrap. parse accepts legacy v0 and v1, serialize
// always writes v1.
export class Bundle {
  static VERSION = VERSION

  version = VERSION
  config
  entries
  modules
  formats
  imports
  // Files only, never a `directory`.
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
    this.executable = executable ?? new Set()
    this.reason = reason
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

  // A full-scope code bundle must declare an entry to be runnable (State#absorbCodeBundle).
  get hasCode() {
    return this.modules.entries().some(([dir, { files }]) =>
      Object.keys(files).some((rel) => !Bundle.isResourceFormat(this.formats.get(moduleFileKey(dir, rel)))))
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
    assertScope(json.config?.scope, 'bundle')
    // Validated into a typed Map early: a raw-object lookup like `__proto__` would hit the prototype.
    const formats = parseFormats(json.formats)
    const v1 = json.version === VERSION
    if (v1 && json.config.scope !== 'full') assert(json.entries === undefined && json.sources === undefined)
    const modules = v1 ? parseBuckets(json, 'bundle') : legacyModules(json.sources)
    const flatKeys = checkedFileKeys(modules, formats)
    const imports = parseImports(json.imports)
    if (!contents) for (const [dir, info] of modules) modules.set(dir, lockModule(dir, info))
    return new Bundle({
      version: json.version,
      config: json.config,
      // Empty entries are valid (`stasis add` attests files without making them entry points).
      entries: v1 && json.entries !== undefined ? parseEntries(json.entries, 'bundle') : new Set(),
      modules,
      formats,
      imports,
      // A v0 `executable` is ignored: with no per-file `formats` it could point `extract` at any path to chmod +x.
      executable: v1 ? parseExecutable(json.executable, { what: 'bundle', files: flatKeys, formats, scope: json.config.scope }) : new Set(),
      reason: isPlainObject(json.reason) ? json.reason : undefined,
      repo: parsedRepo(json.repo),
      package: json.package,
    })
  }

  serialize() {
    checkedFileKeys(this.modules, this.formats)
    const { entries, sources, modules, formats, imports, executable } = serializedParts(this, 'bundle', { skipEmpty: true })
    // File contents are written last, after every other key: sources, then modules.
    return JSON.stringify({
      version: VERSION, config: this.config, repo: this.repo, package: this.package, entries, formats, imports, executable,
      reason: mergeReason(this.reason, undefined), sources, modules,
    }, undefined, 2)
  }

  // Stamp `consumer` onto `files` in the informational `reason` map: by default every carried file.
  withReason(consumer, files = [...this.sources.keys()]) {
    const { version, config, entries, modules, formats, imports, executable, repo, package: pkg } = this
    const reason = mergeReason(this.reason, { [consumer]: files })
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
