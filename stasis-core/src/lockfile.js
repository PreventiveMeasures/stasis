import { assert, assertScope, isPlainObject, mergedParts, moduleFileKey, moduleFileKeys, moduleInfo, normalizeRepo, parseParts, serializedParts } from './artifact-util.js'

const VERSION = 0

// A lockfile, to the parts it shares with a bundle: it records what the directory, or tarball and patch, a package was
// installed from are, and the copies it ships, so it can be audited alone.
const LOCKFILE = { what: 'lockfile', regenerate: 'lockfile (lock=replace)', metadata: ['directory', 'integrity', 'patch', 'vendored'] }

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
    return new Lockfile({ ...parseParts(json, LOCKFILE), repo: json.repo })
  }

  serialize() {
    const { entries, sources, modules, imports, formats, executable } = serializedParts(this, LOCKFILE)
    const store = { version: this.version, config: this.config, repo: this.repo, entries, sources, modules, imports, formats, executable }
    return JSON.stringify(store, undefined, 2) + '\n'
  }

  // A strict union: buckets must agree, and a file in both must carry the identical hash (fail closed).
  merge(other, label = 'lockfile merge', options) {
    return new Lockfile(mergedParts(this, other, label, options))
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
