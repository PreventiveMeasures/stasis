import { assert, assertScope, duplicateKeyError, flatFileKeys, isPlainObject, mergeExecutableSets, mergeFormatMaps, mergeImportMaps, mergeModuleMaps, moduleFileKey, moduleFileKeys, moduleInfo, normalizeRepo, parseBuckets, parseEntries, parseExecutable, parseFormats, parseImports, serializedParts } from './artifact-util.js'

const VERSION = 0

const duplicateKey = duplicateKeyError('lockfile', 'lockfile (lock=replace)')

// What the tarball and patch a package was installed from are, and the copies it ships, so a lockfile can be audited alone.
const LOCK_METADATA = ['integrity', 'patch', 'vendored']

export class Lockfile {
  static VERSION = VERSION

  version = VERSION

  // Where a GitHub build's (`stasis github-bundle`'s) was built, as a bundle's `repo`; validated on every
  // assignment, and frozen. Only github-bundle writes one, and holds a build to it; `stasis validate` reads own code
  // of it. Neither `stasis bundle` nor `stasis run` reads one: a merge, or a lockfile of a bundle, carries none.
  #repo
  get repo() {
    return this.#repo
  }
  set repo(repo) {
    this.#repo = normalizeRepo(repo, 'lockfile repo')
  }

  constructor({ config = { scope: 'full' }, entries, modules, imports, formats, executable, repo } = {}) {
    assertScope(config.scope, 'lockfile')
    this.config = config
    this.repo = repo
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
    // conditions -> parent -> specifier -> resolved file, and file -> format: null only on an in-memory construct.
    this.imports = imports ?? null
    this.formats = formats ?? null
    this.executable = executable ?? new Set() // files only, never a `directory`
  }

  // Imports and formats carry across, else a frozen run would skip those cross-checks.
  static fromBundle(bundle, integrityOf) {
    const modules = new Map()
    for (const [dir, m] of bundle.modules) {
      const files = Object.create(null)
      for (const [rel, content] of Object.entries(m.files)) files[rel] = integrityOf(moduleFileKey(dir, rel), content)
      modules.set(dir, moduleInfo({ ...m, files }))
    }
    return new Lockfile({ config: bundle.config, entries: bundle.entries, modules, imports: bundle.imports, formats: bundle.formats, executable: bundle.executable })
  }

  static parse(text) {
    const json = JSON.parse(text)
    assert(json.version === VERSION)
    assertScope(json.config?.scope, 'lockfile')
    assert(json.imports !== undefined && json.formats !== undefined, 'lockfile must attest imports and formats')
    const full = json.config.scope === 'full'
    assert(!!json.entries === full)
    assert(!!json.sources === full)
    assert(isPlainObject(json.modules), 'lockfile: modules must be an object')
    const entries = full ? parseEntries(json.entries, 'lockfile') : new Set()
    const modules = parseBuckets(json, 'lockfile', LOCK_METADATA)
    // Unique across buckets, as in Bundle.parse: hashes and attestation lookups key on the flat path.
    const flatKeys = flatFileKeys(modules, 'lockfile', duplicateKey)
    const imports = parseImports(json.imports)
    const formats = parseFormats(json.formats)
    const executable = parseExecutable(json.executable, { what: 'lockfile', files: flatKeys, formats, scope: json.config.scope })
    return new Lockfile({ config: json.config, entries, modules, imports, formats, executable, repo: json.repo })
  }

  serialize() {
    flatFileKeys(this.modules, 'lockfile', duplicateKey)
    const { entries, sources, modules, imports, formats, executable } = serializedParts(this, 'lockfile', { metadata: LOCK_METADATA })
    const store = { version: this.version, config: this.config, repo: this.repo, entries, sources, modules, imports, formats, executable }
    return JSON.stringify(store, undefined, 2) + '\n'
  }

  // A strict union: buckets must agree, and a file in both must carry the identical hash (fail closed).
  merge(other, label = 'lockfile merge', options) {
    assert(this.config.scope === other.config.scope,
      `${label}: scope mismatch ('${this.config.scope}' vs '${other.config.scope}')`)
    return new Lockfile({
      config: { scope: this.config.scope },
      entries: new Set([...this.entries, ...other.entries]),
      modules: mergeModuleMaps(this.modules, other.modules, label, options),
      imports: mergeNullable(this.imports, other.imports, mergeImportMaps, 'imports', label),
      formats: mergeNullable(this.formats, other.formats, mergeFormatMaps, 'formats', label),
      // `other` (the incoming, newer lockfile) wins for the files it records -- see mergeExecutableSets.
      executable: mergeExecutableSets(this.executable, other.executable, other.modules, this.config.scope),
    })
  }

  // merge, refusing a file both record whose execute bit `other` gives otherwise (merge lets `other`'s win).
  mergeAgreeing(other, label = 'lockfile merge', options) {
    const merged = this.merge(other, label, options)
    const recorded = moduleFileKeys(this.modules, { scope: this.config.scope })
    for (const file of moduleFileKeys(other.modules, { scope: other.config.scope })) {
      if (recorded.has(file) && this.executable.has(file) !== other.executable.has(file)) throw new Error(`${label}: ${file}'s execute bit differs`)
    }
    return merged
  }
}

const mergeNullable = (a, b, merge, what, label) => {
  if (a === null && b === null) return null
  assert(a !== null && b !== null,
    `${label}: cannot merge ${what} (one lockfile attests ${what}, the other does not)`)
  return merge(a, b, label)
}
