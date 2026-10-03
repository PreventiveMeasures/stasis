import { assert, assertArtifactPath, duplicateKeyError, serializeExecutable, flatFileKeys, groupModules, hasNodeModulesSegment, mergeExecutableSets, mergeFormatMaps, mergeImportMaps, mergeModuleMaps, normalizeModule, parseEntries, parseExecutable, parseFormats, parseImports, serializeEntries, serializeFormats, serializeImports } from './artifact-util.js'

const VERSION = 0

const duplicateKey = duplicateKeyError('lockfile', 'lockfile (lock=replace)')

export class Lockfile {
  static VERSION = VERSION

  version = VERSION
  config
  entries
  modules
  // conditions -> parent -> specifier -> resolved file. A Map from parse; null only on in-memory constructs that don't attest it.
  imports
  // file -> format string. Same Map/null rule as imports.
  formats
  // Project-relative paths of attested files carrying a POSIX execute bit, for `stasis extract`. Files only, never a `directory`.
  executable

  constructor({ config = { scope: 'full' }, entries, modules, imports, formats, executable } = {}) {
    assert(['node_modules', 'full'].includes(config.scope))
    this.config = config
    this.entries = entries ?? new Set()
    this.modules = modules ?? new Map()
    this.imports = imports ?? null
    this.formats = formats ?? null
    this.executable = executable ?? new Set()
  }

  static parse(text) {
    const json = JSON.parse(text)
    assert(json.version === VERSION)
    assert(['node_modules', 'full'].includes(json.config?.scope))
    assert(json.imports !== undefined && json.formats !== undefined, 'lockfile must attest imports and formats')

    const full = json.config.scope === 'full'
    assert(!!json.entries === full)
    assert(!!json.sources === full)
    assert(json.modules)

    const modules = new Map()
    for (const [dir, info] of Object.entries(json.modules)) {
      assert(hasNodeModulesSegment(dir))
      assert(info?.name && info.version && info.files)
      modules.set(dir, normalizeModule(info, dir, 'lockfile'))
    }

    let entries = new Set()
    if (full) {
      entries = parseEntries(json.entries, 'lockfile')
      for (const [dir, info] of Object.entries(json.sources)) {
        assert(!hasNodeModulesSegment(dir))
        // A workspace bucket may omit version (a private/unpublished package.json can lack one).
        assert(info?.name && info.files)
        modules.set(dir, normalizeModule(info, dir, 'lockfile'))
      }
    }

    // Flat keys must be unique across buckets (mirrors Bundle.parse): two bucket splits can flatten
    // to one path, and hashes/attestation lookups key on the flat path.
    for (const [dir, { files }] of modules) {
      assertArtifactPath(dir, 'lockfile')
      assert(files)
    }
    const flatKeys = flatFileKeys(modules, 'lockfile', duplicateKey)

    const imports = parseImports(json.imports)
    const formats = parseFormats(json.formats)
    // Every executable must be a file this lockfile attests.
    const executable = json.executable === undefined
      ? new Set()
      : parseExecutable(json.executable, { what: 'lockfile', files: flatKeys, formats, scope: json.config.scope })

    return new Lockfile({ config: json.config, entries, modules, imports, formats, executable })
  }

  serialize() {
    // Never write an artifact that parse would reject.
    flatFileKeys(this.modules, 'lockfile', duplicateKey)
    const { modules, sources } = groupModules(this.modules, { what: 'lockfile' })
    const store = { version: this.version, config: this.config }
    if (this.config.scope === 'full') Object.assign(store, { entries: serializeEntries(this.entries, 'lockfile'), sources })
    store.modules = modules
    if (this.imports !== null) store.imports = serializeImports(this.imports)
    if (this.formats !== null) store.formats = serializeFormats(this.formats)
    const executable = serializeExecutable(this.executable, {
      what: 'lockfile',
      modules: this.modules,
      // Null on an in-memory construct; an unrecorded format is simply not a directory/stat.
      formats: this.formats ?? new Map(),
      scope: this.config.scope,
    })
    if (executable !== undefined) store.executable = executable
    return JSON.stringify(store, undefined, 2) + '\n'
  }

  // Strict union of two Lockfiles (returns a NEW one): buckets must agree, and a file in both must carry the identical hash (fail closed).
  merge(other) {
    assert(this.config.scope === other.config.scope,
      `lockfile merge: scope mismatch ('${this.config.scope}' vs '${other.config.scope}')`)
    return new Lockfile({
      config: { scope: this.config.scope },
      entries: new Set([...this.entries, ...other.entries]),
      modules: mergeModuleMaps(this.modules, other.modules, 'lockfile merge'),
      imports: mergeNullable(this.imports, other.imports, (a, b) => mergeImportMaps(a, b, 'lockfile merge'), 'imports'),
      formats: mergeNullable(this.formats, other.formats, (a, b) => mergeFormatMaps(a, b, 'lockfile merge'), 'formats'),
      // `other` (the incoming, newer lockfile) wins for the files it records -- see mergeExecutableSets.
      executable: mergeExecutableSets(this.executable, other.executable, other.modules, this.config.scope),
    })
  }
}

const mergeNullable = (a, b, merge, what) => {
  if (a === null && b === null) return null
  assert(a !== null && b !== null,
    `lockfile merge: cannot merge ${what} (one lockfile attests ${what}, the other does not)`)
  return merge(a, b)
}
