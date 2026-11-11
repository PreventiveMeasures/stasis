import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { join, resolve, relative, basename, dirname, extname, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Config } from './config.js'
import { Bundle, mergeRepo } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { parseShard, serializeShard } from './shard.js'
import { bundledIntegrity, canonicalizePath, inScope, sha512integrity, readFileSyncMaybe, noupsert, realContained } from './state-util.js'
import { compressBundleText, parseBundleBytes } from './brotli.js'
import { ATTESTED_METADATA, attestsAny, BUNDLE_FILE, CODE_EXTENSIONS, CONFIG_FILE, EMPTY_MODULE_PATH, assertRealPathWithinBase, canObserveExecuteBits, classifyFormat, erasedTypeScriptFormat, hasNodeModulesSegment, heldToAccounts, importTargetsEqual, installedAccounts, LOCK_FILE, memoized, mergeModuleMaps, inResources, isBinaryPlist, isNativeArtifact, isPackageString, isPathWithin, isPlainObject, isStatFormat, isSubpackage, moduleFileKey, moduleInfo, narrowExecutable, nestedMap, nodeExtFormat, observeExecutable, relativeEscapes, sortedByPath, splitNodeModulesPath, toPosix, upsert, upsertFormat, withMetadataOf } from './util.js'
import { detectRepo, invalidPackageConfig, namedManifestOf, packageJSONStat, packageJSONText, packageRepo, readModuleManifest, scopeManifestOf, vendorDirOf, vendoredPackageOf } from './bundle-util.js'
import { expandExtra, validationError } from './add.js'
import { linksOn } from './policy.js'
import { diskHost } from './host.js'
import corePackage from './package.cjs'

// Snapshotted, so writes survive --mock's syncBuiltinESMExports() remock of node:fs.
const { mkdirSync, rmSync, writeFileSync } = fs

const VERSION = corePackage.version
const CAN_OBSERVE_EXECUTE_BITS = canObserveExecuteBits()
const REBUNDLE = 'Re-bundle with the current stasis or `bundle=replace` against a v0-free starting point to upgrade.'

function readPackageJSON(host, pkgAbsolute) {
  const buf = host.readFile(pkgAbsolute)
  assert.ok(isUtf8(buf))
  let json
  try { json = JSON.parse(packageJSONText(buf)) } catch (cause) { throw invalidPackageConfig(pkgAbsolute, cause) }
  if (!isPlainObject(json)) throw invalidPackageConfig(pkgAbsolute)
  return json
}

const cloneMaps = (map) => new Map(Array.from(map, ([key, value]) => [key, value instanceof Map ? cloneMaps(value) : value]))

// With no `type`, Node decides .js/.ts by syntax detection: either variant is possible, the first is the default.
const UNTYPED_VARIANTS = { __proto__: null, '.js': ['commonjs', 'module'], '.ts': ['commonjs-typescript', 'module-typescript'] }

// Nested package.json files upstream leaves disagreeing with their root's. Add only a confirmed false positive.
const INCONSISTENT_PACKAGE_JSON_EXCEPTIONS = [
  'node_modules/@redis/client/dist/package.json', // stale build-time copy
  'node_modules/hashids/esm/package.json', // a `type` marker named `hashids-esm`, in every 2.x release
]
const isInconsistentPackageJsonException = (file) => INCONSISTENT_PACKAGE_JSON_EXCEPTIONS.some((suffix) => file === suffix || file.endsWith(`/${suffix}`))

// 'import' or 'require', as a condition list or #conditionsKey asserts; null for '*' or a set naming both or neither.
function resolutionContext(conditions) {
  const list = typeof conditions === 'string' ? conditions.split(' (with: ')[0].split(', ') : conditions
  const asImport = list.includes('import')
  if (asImport === list.includes('require')) return null
  return asImport ? 'import' : 'require'
}

// A bare specifier reads `exports` conditions (its own name's included), a `#` one `imports`'.
function readsConditions(specifier) {
  if (typeof specifier !== 'string') return false
  if (specifier.startsWith('#')) return true
  return !(specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../') ||
    specifier.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(specifier))
}

// On globalThis via `Symbol.for` so the registry is shared across duplicate stasis-core copies.
const STATES_KEY = Symbol.for('@exodus/stasis-core/states')
const liveStates = () => (globalThis[STATES_KEY] ??= new Set())

export class State {
  hashes = new Map()
  entries = new Set()
  sources = new Map()
  resources = new Map()
  formats = new Map()
  modules = new Map()
  imports = new Map()
  // Disk is authoritative: a file that lost its execute bit drops out.
  executable = new Set()
  config
  root
  #parent
  // Shared with sidecars: every record's `dirs`, the `files` of each absorbed with ATTESTED_METADATA, and the
  // `bundles`' own record of each package they attest something of, which the run's record may not take.
  #absorbed = { dirs: new Set(), files: new Map(), bundles: new Map() }
  #attestedByBundle = new Set()
  #isPreload = false
  #host
  #policy = null
  #linksOf = null
  #claim
  #claims = new Map()
  // Write-mode sidecars contribute to the lockfile; load-mode ones are only served from (getFs*Family).
  #sidecars = new Set()
  #readSidecars = new Set()
  // May be supersets of what a run observes, so kept apart from the live maps.
  #lockImports = null
  #lockFormats = null
  #lockfileLoaded = false
  // What THIS process recorded, not the seeded baseline: shardSnapshot forwards only these.
  #observed = new Set()
  #reasonFiles = new Map()
  // 'run' files it loaded itself, and ones it only fs-read after a plugin attached (#reasonClaims).
  #runOwn = new Set()
  #fsReadPostPlugin = new Set()
  #pluginAttached = false
  // A frozen bundle's attestation, apart from the live maps: anything it never recorded is rejected.
  #bundleSources = null
  #bundleResources = null
  #bundleImports = null
  #bundleFormats = null
  #impliedDirIndex = null
  #observedResolutions = new Map()
  #executedFiles = new Set()
  // Unlike this.hashes, never lockfile-seeded: a seeded hash must not exempt an executed file from verification.
  #filesCapturedThisRun = new Set()
  // Keys backfilled native edges, so the lockfile is Node-version-stable.
  #requireConditions = null
  #preloadRoot = null
  #lastLockData = null
  #lastBundleText = new Map()
  #detectedRepoCache
  #absorbedRepos = new Map()
  // Sound only because the tree holds still mid-run; the cached result is shared: never mutate it.
  #canonicalCache = new Map()

  // `preload`: the unique preload State. `parent`: a sidecar sharing the parent's hashes/entries/modules.
  // `skipDiscovery`: caller-populated, read-only, NO filesystem discovery. The rest go to Config.
  constructor(root, options = {}) {
    const { preload: isPreload = false, parent: parentState, preloadRoot, skipDiscovery = false, host = diskHost, env = process.env, claim = true, checkPolicy = true, ...configOptions } = options
    this.config = new Config({ ...configOptions, env, host })
    this.#host = host
    this.#claim = claim
    if (isPreload) assert.ok(!State.preload, 'Only one preload Stasis instance is supported')
    assert.ok(!(isPreload && parentState), 'preload and parent are mutually exclusive')
    this.#isPreload = isPreload

    if (parentState) {
      // A sidecar shares the parent's maps and attestation: a version skew is unsound (another copy is fine).
      assert.equal(parentState.version, VERSION, `child State version '${VERSION}' must exactly match parent version '${parentState.version}'`)
      this.#parent = parentState
      this.root = parentState.root
      this.hashes = parentState.hashes
      this.entries = parentState.entries
      this.modules = parentState.modules
      // The lockfile attestation must reach the sidecar, else a tampered bundle could redirect hash-valid bytes.
      const inherited = parentState.sidecarInheritance()
      this.#preloadRoot = inherited.preloadRoot
      this.#lockImports = inherited.lockImports
      this.#lockFormats = inherited.lockFormats
      this.#lockfileLoaded = inherited.lockfileLoaded
      this.#policy = inherited.policy
      this.#absorbed = inherited.absorbed
      assert.ok(this.config.bundleFile, 'sidecar State requires bundleFile')
      if (this.config.writeBundle) for (const key of ['bundleFile', 'resourcesBundleFile']) this.#claimWritePath(key, 'sidecar ')
      // frozenBundle too: it has its own attestation snapshot to build. What it absorbs reaches the parent.
      if (this.config.bundle) {
        const path = this.config.bundleFile
        const sources = this.#readMaybe(path)
        if (sources && !this.config.replaceBundle) this.#absorbCodeBundle(this.#parseServedBundle(sources, path, 'stasis sidecar'))
        this.#absorbResourcesBundleFile()
      }
      if (this.config.frozenBundle) this.#freezeBundle()
      if (this.#attestedByBundle.size > 0) this.#holdToInstalled(relative(this.root, this.#bundlePath))
      // AFTER every fallible step, so a throw leaves no dead reference. A frozen sidecar joins neither registry.
      if (this.config.writeBundle) parentState.registerSidecar(this)
      else if (this.config.loadBundle) parentState.registerReadSidecar(this)
      if (this.#claims.size > 0) liveStates().add(this)
      return
    }

    if (preloadRoot !== undefined) {
      assert.equal(typeof preloadRoot, 'string', 'preloadRoot must be a string')
      this.#preloadRoot = preloadRoot
    }
    if (skipDiscovery) {
      assert.ok(!this.config.frozen && !this.config.frozenBundle && !this.config.writeBundle && !this.config.writeLockfile,
        'skipDiscovery is read-only: incompatible with frozen and write (add/replace) lock/bundle modes')
      this.root = resolve(root)
      if (isPreload) liveStates().add(this)
      return
    }

    // Capture and load MUST agree on where the upward walk stops, else they commit different roots.
    const potentialRoots = []
    for (let cursor = root; cursor; cursor = dirname(cursor)) {
      // One there that can't be read is refused, not walked past (packageJSONStat).
      if (packageJSONStat(this.#host, join(cursor, 'package.json')) !== null) {
        potentialRoots.push(cursor)
      } else if ([CONFIG_FILE, LOCK_FILE, BUNDLE_FILE].some((file) => this.#exists(join(cursor, file)))) {
        throw new Error('Unexpected stasis config without package.json')
      }
      if (cursor === env.PROJECT_CWD) break // e.g. yarn sets this
      if (this.#exists(join(cursor, '.git')) || this.#exists(join(cursor, 'pnpm-workspace.yaml'))) break
      if (dirname(cursor) === cursor) break
    }

    // The top-level package.json by default; a stasis.config.json opts a dir in.
    this.root = potentialRoots.at(-1)
    assert.ok(this.root, `stasis: no package.json found at or above ${resolve(root)}; run stasis from within a project`)

    let loaded = false
    // An explicit lockFile suppresses the per-rootDir probe, so a stale project-root lockfile can't shadow it.
    const explicitLockPath = this.config.lockFile
    // A flag/env `bundleFile` is rootDir-INDEPENDENT, so NOT a root signal: else load's root could diverge.
    const explicitBundlePath = this.config.bundleFile
    for (const rootDir of potentialRoots) {
      const config = readFileSyncMaybe(rootDir, CONFIG_FILE, 'utf-8', this.#host)
      const lockProbe = explicitLockPath ? null : readFileSyncMaybe(rootDir, LOCK_FILE, 'utf-8', this.#host)
      let sourcesPath = explicitBundlePath || join(rootDir, BUNDLE_FILE)
      let sources = this.#readMaybe(sourcesPath)
      // Root signals: a config, a lockfile, or the DEFAULT bundle path (an explicit one still loads via `sources`).
      if (config === null && lockProbe === null && (explicitBundlePath || sources === null)) continue
      loaded = true
      this.root = rootDir

      if (config) {
        this.config.loadConfig(config)
        // false: a static build checks the whole bundle itself, every offender at once.
        if (checkPolicy) this.#policy = this.config.policy
        // stasis.config.json may set a `bundleFile` the probe couldn't see.
        if (this.#bundlePath !== sourcesPath) {
          sourcesPath = this.#bundlePath
          sources = this.#readMaybe(sourcesPath)
        }
      }

      const lock = explicitLockPath ? this.#readMaybe(explicitLockPath, 'utf-8') : lockProbe
      this.#absorbLockfile(lock, this.#lockPath)
      this.#loadBundleArtifacts(sources, sourcesPath)

      // The innermost wins: else an outer root re-detects a rootDir-independent bundleFile.
      break
    }

    // With no root signal, explicit artifacts load against the outermost root.
    if (!loaded && explicitLockPath) this.#absorbLockfile(this.#readMaybe(explicitLockPath, 'utf-8'), explicitLockPath)
    if (!loaded && (explicitBundlePath || this.config.resourcesBundleFile)) {
      this.#loadBundleArtifacts(explicitBundlePath ? this.#readMaybe(explicitBundlePath) : null, explicitBundlePath)
    }

    if (this.config.frozen) assert.ok(this.#lockfileLoaded, 'No lockfile, but attempting to run in frozen mode')
    if (this.config.frozenBundle) this.#freezeBundle()
    this.#holdToInstalled(relative(this.root, this.#lockfileLoaded ? this.#lockPath : this.#bundlePath))

    if (this.config.writeBundle) for (const key of ['bundleFile', 'resourcesBundleFile']) this.#claimWritePath(key)
    if (this.config.writeLockfile) this.#claimWritePath('lockFile')
    if (isPreload || this.#claims.size > 0) liveStates().add(this)
  }

  #exists(p) {
    return this.#host.stat(p) !== null
  }

  // The ATTESTED_METADATA absorbed of the artifact at `label`, and what each bundle attests, held to how each
  // package was installed; kept as recorded where no account tells (nothing installed, as where a bundle runs).
  #holdToInstalled(label) {
    const { files, bundles } = this.#absorbed
    // What only its bundles attest of a package is its record's too where they hold every file of it; else
    // it stays theirs, which a run writing its bundle again would drop: refused.
    for (const dir of this.#attestedByBundle) {
      const [module, own] = [this.modules.get(dir), bundles.get(dir)]
      const alone = Object.fromEntries(ATTESTED_METADATA.filter((field) => module[field] === undefined && own[field] !== undefined).map((field) => [field, own[field]]))
      const beyond = Object.keys(module.files).find((rel) => !Object.hasOwn(own.files, rel))
      if (beyond === undefined) this.modules.set(dir, moduleInfo({ ...module, ...alone }))
      else assert.ok(!this.config.writeBundle || Object.keys(alone).length === 0, `bundle module ${dir} ${Object.keys(alone)[0]} is recorded of its files, not of '${moduleFileKey(dir, beyond)}' its record holds: record it anew (lock = replace)`)
    }
    const attested = new Map([...this.modules].filter(([, module]) => attestsAny(module)))
    for (const [dir, module] of attested) if (!files.has(dir)) files.set(dir, new Set(Object.keys(module.files)))
    const accounts = installedAccounts(new Map([...bundles, ...attested]), this.root)
    heldToAccounts(attested, accounts, `${label}: `)
    heldToAccounts(bundles, accounts, `${relative(this.root, this.#bundlePath)}: `)
  }

  // A bundle's record of a package merged into the State's (`record`, if any). What it alone attests agrees
  // with every other bundle's of the files it covers (mergeModuleMaps), and is taken once all are absorbed.
  #absorbBundleRecord(dir, info, record, what) {
    const { dirs, files, bundles } = this.#absorbed
    dirs.add(dir)
    if (attestsAny(info)) {
      this.#attestedByBundle.add(dir)
      const known = bundles.get(dir)
      bundles.set(dir, known === undefined ? info : mergeModuleMaps(new Map([[dir, known]]), new Map([[dir, info]]), 'bundle').get(dir))
      // A later bundle's files (a sidecar's) of what it attests alike are absorbed, not this run's.
      const baseline = files.get(dir)
      if (baseline && ATTESTED_METADATA.every((field) => record?.[field] === undefined || JSON.stringify(record[field]) === JSON.stringify(info[field]))) for (const rel of Object.keys(info.files)) baseline.add(rel)
    }
    // One attesting none of what the record took already (a sidecar's, after its parent's) adds no
    // file to it where its files are the record's too: the value was recorded without them.
    const lacked = this.config.writeBundle && record ? ATTESTED_METADATA.find((field) => record[field] !== undefined && info[field] === undefined) : undefined
    const added = lacked === undefined ? undefined : Object.keys(info.files).find((rel) => !(files.get(dir)?.has(rel) ?? Object.hasOwn(record.files, rel)))
    if (added !== undefined) assert.fail(`bundle: module '${dir}' ${lacked} is recorded of one side's files, not of '${moduleFileKey(dir, added)}' the other adds`)
    // What a bundle alone attests is the record's once all are absorbed, where they cover its files (#holdToInstalled).
    const alone = Object.fromEntries(ATTESTED_METADATA.filter((field) => record?.[field] === undefined).map((field) => [field, undefined]))
    return moduleInfo(record === undefined ? { ...info, ...alone, files: Object.create(null) } : { ...withMetadataOf(record, info, what), ...alone })
  }

  // Not what a lockfile alone locks (what an install would lay out, not what one did), nor onto a record
  // absorbed, whose other files this run may not have read: of a file this run adds, an install record tells.
  #recordInstalled() {
    const accounts = installedAccounts(this.modules, this.root)
    heldToAccounts(this.modules, accounts)
    for (const [dir, account] of accounts) if (!account.locked && !this.#absorbed.dirs.has(dir)) this.modules.set(dir, withMetadataOf(this.modules.get(dir), account))
    for (const [dir, files] of this.#absorbed.files) {
      const [module, account] = [this.modules.get(dir), accounts.get(dir)]
      const added = account && !account.locked ? undefined : Object.keys(module.files).find((rel) => !files.has(rel))
      if (added === undefined) continue
      const fields = ATTESTED_METADATA.filter((field) => module[field] !== undefined).join(' and ')
      assert.fail(`module '${dir}': its ${fields} is recorded of the files it was read with, not of ${moduleFileKey(dir, added)}, which this run adds and no install record tells of: record it anew (lock = replace)`)
    }
  }

  #readMaybe(path, encoding) {
    return readFileSyncMaybe(dirname(path), basename(path), encoding, this.#host)
  }

  // Lockfile.parse requires both imports and formats, so an absorbed lockfile always attests them.
  #absorbLockfile(lock, lockPath) {
    if (lock && !this.config.useLockfile && !this.config.ignoreLockfile) throw new Error(`Unexpected ${lockPath} with config.lock = 'none'`)
    if (!lock || !this.config.useLockfile || this.config.replaceLockfile) return
    const lockfile = Lockfile.parse(lock)
    if (this.config.frozen) assert.equal(lockfile.config.scope, this.config.scope)
    this.#assertLoaded(lockfile, lockPath)

    const includeSources = lockfile.config.scope === 'full' && this.config.full
    for (const [dir, info] of lockfile.modules) {
      if (!hasNodeModulesSegment(dir) && !includeSources) continue
      this.modules.set(dir, info)
      this.#absorbed.dirs.add(dir)
      for (const [name, hash] of Object.entries(info.files)) noupsert(this.hashes, moduleFileKey(dir, name), hash)
    }
    if (includeSources) this.entries = lockfile.entries
    this.#lockImports = lockfile.imports
    this.#lockFormats = lockfile.formats
    // Into the live set, not a baseline, so re-reading a file this run can CLEAR a stale exec bit.
    for (const file of lockfile.executable) this.executable.add(file)
    this.#lockfileLoaded = true
  }

  get #absorbsBundles() {
    return this.config.bundle && !this.config.replaceBundle
  }

  #loadBundleArtifacts(sources, sourcesPath) {
    if (sources && this.config.bundleMode === 'none') throw new Error(`Unexpected ${sourcesPath} with config.bundle = 'none'`)
    // A frozen bundle is self-attesting, so it needs no sibling lockfile.
    if (sources && !this.#lockfileLoaded && this.config.useLockfile && !this.config.replaceLockfile && !this.config.frozenBundle) {
      throw new Error('stasis.lock.json missing, can not use sources')
    }
    if (sources && this.#absorbsBundles) {
      const bundle = this.#parseServedBundle(sources, sourcesPath, 'stasis run',
        'Re-bundle with the current stasis (`stasis bundle`) or `stasis run --bundle=replace` against a v0-free starting point to upgrade.')
      // assertEntry passes anything on an empty set: else any bundled file could run as the root.
      assert.ok(!this.config.full || bundle.entries.size > 0 || !bundle.hasCode,
        `${sourcesPath}: a full-scope bundle carrying code must declare an entry to run ` +
        `(an add-only attestation has none; run a bundle built by \`stasis bundle\`/\`stasis run\`)`)
      this.#absorbCodeBundle(bundle)
    }
    this.#absorbResourcesBundleFile()
  }

  // v0 has no per-file formats or import map: serving one widens the trust boundary.
  #parseServedBundle(bytes, path, runner = 'stasis run', remedy = REBUNDLE) {
    const bundle = parseBundleBytes(bytes)
    assert.equal(bundle.version, Bundle.VERSION, `${runner} requires a v1 bundle; ${path} is v${bundle.version}. ${remedy}`)
    assert.equal(bundle.config.scope, this.config.scope)
    this.#assertLoaded(bundle, path)
    return bundle
  }

  #absorbCodeBundle(bundle) {
    this.#mergeBundleMetadata(bundle)
    for (const [file, content] of bundle.sources) {
      if (Bundle.isResourceFormat(bundle.formats.get(file))) this.resources.set(file, content)
      else this.sources.set(file, content)
    }
    this.formats = bundle.formats
    this.imports = bundle.imports
    this.#absorbBundleExtras('code', bundle)
  }

  // Before addFile/addImport mutate the live maps; imports deep, as this.imports shares the bundle's Maps.
  #freezeBundle() {
    assert.ok(this.#absorbedRepos.size > 0, 'No bundle, but attempting to run in frozen bundle mode')
    this.#bundleSources = new Set(this.sources.keys())
    this.#bundleResources = new Set(this.resources.keys())
    this.#bundleImports = cloneMaps(this.imports)
    this.#bundleFormats = new Map(this.formats)
  }

  // Cross-checked against the loaded lockfile, else absorbed as the source of truth.
  #mergeBundleMetadata(bundle) {
    if (this.#lockfileLoaded) {
      if (bundle.entries.size > 0) {
        assert.deepStrictEqual([...bundle.entries].toSorted(), [...this.entries].toSorted(), 'bundle/lockfile entries mismatch')
      }
      for (const [dir, info] of bundle.modules) {
        if (!info.name) continue // workspace bucket or fallback: no inferable name
        assert.ok(this.modules.has(dir), `bundle module ${dir} missing in lockfile`)
        const lockModule = this.modules.get(dir)
        assert.equal(info.name, lockModule.name)
        // Strict, absent included: every absorb site requires v1, so a missing version is a real identity.
        assert.equal(info.version, lockModule.version, `bundle module ${dir} version mismatch with lockfile`)
        // The bundle's metadata is taken where the lockfile records none, to be written again.
        this.modules.set(dir, this.#absorbBundleRecord(dir, info, lockModule, `bundle module ${dir} (against the lockfile)`))
        for (const rel of Object.keys(info.files)) assert.ok(Object.hasOwn(lockModule.files, rel), `bundle file ${dir}/${rel} missing in lockfile`)
      }
      // Hashes alone don't stop a redirect to another hash-valid file: every edge must match the lockfile's.
      for (const [conditions, byParent] of bundle.imports) {
        for (const [parent, specifiers] of byParent) {
          for (const [specifier, file] of specifiers) {
            this.#assertAttestedResolution(this.#lockImports, conditions, parent, specifier, file, { what: 'bundle', source: 'lockfile' })
          }
        }
      }
      // A format flip changes how hash-valid bytes parse (module<->commonjs) without touching a hash.
      for (const [file, format] of bundle.formats) this.#assertAttestedFormat(this.#lockFormats, file, format, 'bundle', 'lockfile')
      // Inverse: omitting a resource tag would route the base64 payload through this.sources to the loader.
      for (const [dir, { files }] of bundle.modules) {
        for (const rel of Object.keys(files)) {
          const file = moduleFileKey(dir, rel)
          const lockFormat = this.#lockFormats.get(file)
          if (!Bundle.isResourceFormat(lockFormat)) continue
          assert.equal(bundle.formats.get(file), lockFormat, `bundle file ${file} must declare format='${lockFormat}' to match the lockfile`)
        }
      }
    } else {
      // In place: this.entries may be a sidecar's parent's.
      for (const e of bundle.entries) this.entries.add(e)
      for (const [dir, info] of bundle.modules) {
        // v0 partial metadata; a v1 workspace bucket may omit version.
        if (!info.name || (!info.version && hasNodeModulesSegment(dir))) continue
        const existing = this.modules.get(dir)
        if (existing !== undefined) {
          // A dir may be added twice (code + resource halves).
          assert.equal(info.name, existing.name, `bundle ${dir} name mismatch`)
          assert.equal(info.version, existing.version, `bundle ${dir} version mismatch`)
        }
        this.modules.set(dir, this.#absorbBundleRecord(dir, info, existing, `bundle ${dir}`))
        // A bundle=add run writes these back with only the files they list: else an unloaded bundled file drops out.
        if (!this.config.writeBundle) continue
        const { files } = this.modules.get(dir)
        for (const [rel, content] of Object.entries(info.files)) {
          const file = moduleFileKey(dir, rel)
          const integrity = bundledIntegrity(content, bundle.formats.get(file))
          noupsert(this.hashes, file, integrity)
          if (!Object.hasOwn(files, rel)) files[rel] = integrity
          assert.equal(files[rel], integrity, `bundle file ${file} conflicts with its recorded hash`)
        }
      }
    }
  }

  // The resources half of a split layout, when configured and on disk: ONLY resource-format files.
  #absorbResourcesBundleFile() {
    const resourcesPath = this.config.resourcesBundleFile
    const resourcesData = resourcesPath ? this.#readMaybe(resourcesPath) : null
    if (!resourcesData || !this.#absorbsBundles) return
    const bundle = this.#parseServedBundle(resourcesData, resourcesPath)
    // Populated imports/entries mean mixed halves or tampering, widening trust on the code side.
    assert.equal(bundle.imports.size, 0, `resources bundle ${resourcesPath} must have empty imports`)
    assert.equal(bundle.entries.size, 0, `resources bundle ${resourcesPath} must have empty entries`)
    for (const [file, format] of bundle.formats) {
      assert.ok(Bundle.isResourceFormat(format), `resources bundle ${resourcesPath} declares non-resource format='${format}' for ${file}`)
    }
    this.#mergeBundleMetadata(bundle)
    for (const [file, content] of bundle.sources) this.resources.set(file, content)
    for (const [file, format] of bundle.formats) {
      const existing = this.formats.get(file)
      assert.ok(existing === undefined || existing === format,
        `format conflict for ${file}: bundleFile declares '${existing}', resourcesBundleFile declares '${format}'`)
      this.formats.set(file, format)
    }
    this.#absorbBundleExtras('resources', bundle)
  }

  // A bundle half's `executable` (unioned: a lockfile or the other half may have contributed), `repo` and `reason`.
  #absorbBundleExtras(half, bundle) {
    for (const file of bundle.executable) this.executable.add(file)
    this.#absorbedRepos.set(half, this.#absorbedRepos.has(half) ? mergeRepo(this.#absorbedRepos.get(half), bundle.repo) : bundle.repo)
    // So a bundle=add re-run preserves other consumers' attribution.
    if (!this.config.writeBundle || bundle.reason === undefined) return
    for (const [consumer, files] of Object.entries(bundle.reason)) {
      for (const file of files) this.#recordReason(consumer, file)
    }
  }

  // Under the exact conditions key, else only where every condition set agrees on one target.
  #assertAttestedResolution(attestation, conditions, parent, specifier, file, { what, source, tolerateUnknown = false, targetPlatform }) {
    const edge = `'${specifier}' from ${parent} (${conditions})`
    let attested = attestation.get(conditions)?.get(parent)?.get(specifier)
    if (attested === undefined) {
      const targets = new Set()
      for (const parents of attestation.values()) {
        const target = parents.get(parent)?.get(specifier)
        if (target !== undefined) targets.add(target)
      }
      if (targets.size === 0 && tolerateUnknown) return
      assert.ok(targets.size > 0, `${what} resolution ${edge} is not attested by the ${source}`)
      assert.ok(targets.size === 1, `${what} resolution ${edge} is attested inconsistently across condition sets in the ${source}`)
      ;[attested] = targets
    }
    if (targetPlatform !== undefined && attested instanceof Map && !(file instanceof Map)) {
      attested = attested.get(targetPlatform)
      assert.ok(attested !== undefined, `${what} resolution ${edge} is not attested for platform '${targetPlatform}' by the ${source}`)
    }
    assert.ok(importTargetsEqual(file, attested), `${what} resolution ${edge} mismatches the ${source}`)
  }

  // Closes the attested set of a frozen lockfile and bundle; the caller's noupsert checks the bytes.
  #assertFrozenAttests(noun, file, module, rel, bundled, format) {
    if (this.config.frozen) assert.ok(Object.hasOwn(module.files, rel), `${noun} not attested by the frozen lockfile: ${file}`)
    if (this.config.frozenBundle) assert.ok(bundled?.has(file), `${noun} not attested by the frozen bundle: ${file}`)
    // `type` is usually not hash-attested, so a format flip would recategorize a hash-valid file.
    if (format == null) return
    if (this.config.frozen && this.#lockFormats !== null) this.#assertAttestedFormat(this.#lockFormats, file, format, 'observed', 'lockfile')
    if (this.config.frozenBundle) this.#assertAttestedFormat(this.#bundleFormats, file, format, 'observed', 'frozen bundle')
  }

  // Callers only pass files that must be attested: an unattested one is a forged/extra entry.
  #assertAttestedFormat(attestation, file, format, what, source) {
    const attested = attestation.get(file)
    assert.ok(attested !== undefined, `${what} format for ${file} is not attested by the ${source}`)
    assert.equal(format, attested, `${what} format for ${file} mismatches the ${source}`)
  }

  assertEntry(url) {
    // #loadCodeBundle already refuses a runnable code bundle that declares none.
    if (this.entries.size === 0) return
    const file = this.#canonicalFile(url)
    assert.ok(this.entries.has(file), `Unknown entry point: ${file}`)
  }

  static get preload() {
    return liveStates().values().find((state) => state.isPreload)
  }

  // Public so State.preload works across copies.
  get isPreload() {
    return this.#isPreload
  }

  // Public for #claimWritePath's cross-copy collision scan.
  claimedWritePathLabel(canonical) {
    return this.#claims.get(canonical)
  }

  // Refuse a path another live State (ANY copy) already claims; canonicalized so `./x`/`x`/symlinks compare equal.
  #claimWritePath(key, prefix = '') {
    const value = this.config[key]
    if (!value || !this.#claim) return
    const label = `${prefix}${key} '${value}'`
    const canonical = canonicalizePath(value, this.#host)
    for (const other of liveStates()) {
      const owner = other.claimedWritePathLabel(canonical)
      assert.ok(owner === undefined, `${label} is already claimed by ${owner} of another live State`)
    }
    this.#claims.set(canonical, label)
  }

  // Public so a sidecar can verify it matches its parent's across copies.
  get version() {
    return VERSION
  }

  // Public, so a sidecar from another copy can read it across the class brand.
  sidecarInheritance() {
    return {
      preloadRoot: this.#preloadRoot,
      lockImports: this.#lockImports,
      lockFormats: this.#lockFormats,
      lockfileLoaded: this.#lockfileLoaded,
      policy: this.#policy,
      absorbed: this.#absorbed,
    }
  }

  // linksOn() of the root: what the State records under a link is its target's.
  get #links() {
    return (this.#linksOf ??= linksOn(this.root, this.#host))
  }

  // The Policy's path rules on a path recorded without reading it, in the attested zone and recorded nowhere yet.
  #checkUnreadPath(file) {
    if (this.#policy !== null && (this.config.full || hasNodeModulesSegment(file)) && !this.hashes.has(file) && !this.formats.has(file)) {
      this.#policy.assertPath(file, undefined, this.#links(file))
    }
  }

  // Before a run verifies against, serves or (adding to it) rewrites an artifact the Policy refuses.
  #assertLoaded(artifact, path) {
    this.#policy?.assertArtifact(artifact, { hint: ` -- recorded in ${relative(this.root, resolve(path))}; rebuild it (lock=replace / bundle=replace)`, links: this.#links })
  }

  // Public, cross-copy.
  registerSidecar(sidecar) {
    this.#sidecars.add(sidecar)
  }

  registerReadSidecar(sidecar) {
    this.#readSidecars.add(sidecar)
  }

  absolute(url) {
    const absolute = fileURLToPath(url)
    assert.equal(pathToFileURL(absolute).toString(), url)
    assert.equal(absolute, resolve(absolute))
    return absolute
  }

  relative(absolute) {
    assert.ok(absolute)
    const file = relative(this.root, absolute)
    assert.ok(!relativeEscapes(file))
    // The project root is keyed '.', never '' -- mixing the two desyncs write from read.
    return file === '' ? '.' : file
  }

  #urlOf(file) {
    return pathToFileURL(resolve(this.root, file)).toString()
  }

  // As opposed to known by a stat record or a seeded hash alone.
  #bundled(file) {
    return this.sources.has(file) || this.resources.has(file)
  }

  // { url, absolute, file }: `file` the project-relative key (this.relative's), undefined outside the root.
  #canonical(url) {
    let result = this.#canonicalCache.get(url)
    if (result === undefined) {
      result = this.#canonicalUncached(url)
      const file = relative(this.root, result.absolute)
      result.file = relativeEscapes(file) ? undefined : file === '' ? '.' : file
      this.#canonicalCache.set(url, result)
    }
    return result
  }

  // A node_modules file whose REAL path is outside node_modules is a linked-in workspace source (pnpm).
  #canonicalUncached(url) {
    const absolute = this.absolute(url)
    const file = relative(this.root, absolute)
    if (relativeEscapes(file) || !splitNodeModulesPath(file)) return { url, absolute }
    let real
    try { real = this.#host.realpath(absolute) } catch { return { url, absolute } }
    if (real === absolute) return { url, absolute }
    const realFile = relative(this.root, real)
    if (relativeEscapes(realFile) || splitNodeModulesPath(realFile)) return { url, absolute }
    return { url: pathToFileURL(real).toString(), absolute: real }
  }

  // Throws, as this.relative, for a URL outside the project root.
  #canonicalFile(url) {
    const { absolute, file } = this.#canonical(url)
    return file ?? this.relative(absolute)
  }

  // Undefined outside the project root: the shims then pass through.
  #canonicalFileMaybe(url) {
    try { return this.#canonical(url).file } catch { return undefined }
  }

  // Through any workspace symlink, not a raw substring: a symlinked workspace source is read from disk.
  inNodeModules(url) {
    const file = this.#canonicalFileMaybe(url)
    return file !== undefined && splitNodeModulesPath(file) !== null
  }

  // findPackageJSON is unreliable for a directory (EISDIR, or the parent's); an unreadable one is refused as it does.
  #nearestPackageJsonFor(dirAbsolute) {
    for (let dir = dirAbsolute; ; dir = dirname(dir)) {
      const candidate = join(dir, 'package.json')
      if (packageJSONStat(this.#host, candidate)?.isFile()) return candidate
      if (dir === this.root || dirname(dir) === dir) break
    }
    // Unreachable: state.root is resolved to a dir that has package.json.
    assert.fail(`no package.json at or above directory ${this.relative(dirAbsolute)}`)
  }

  // The owning package bucket, registered. `synthetic` (EMPTY_MODULE_PATH) must NOT exist on disk.
  #locateModule(url, { directory = false, synthetic = false } = {}) {
    const { absolute } = this.#canonical(url)
    const file = this.#canonicalFile(url)
    if (synthetic) assert.ok(this.#host.stat(absolute) === null, `the reserved path ${file} is needed for a synthetic empty module, but the project has a real file there`)
    else assert.ok(this.#host.stat(absolute) !== null)

    const closestPkgAbsolute = directory ? this.#nearestPackageJsonFor(absolute)
      : synthetic ? this.#nearestPackageJsonFor(dirname(absolute)) : this.#host.findPackageJSON(absolute)
    const closestPkg = readPackageJSON(this.#host, closestPkgAbsolute)

    const closestType = closestPkg.type
    assert.ok(closestType === undefined || closestType === 'module' || closestType === 'commonjs')

    // findPackageJSON may land on a `{"type":"module"}` marker lacking name/version.
    const { dir: nmRoot, rel: nmRel } = splitNodeModulesPath(file) ?? {}
    // rootPkg: a dependency's package.json, whose repo is read only where a record lacks one.
    let pkgAbsolute, rootPkg, name, version, vendored, subpackage
    if (nmRoot) {
      pkgAbsolute = resolve(this.root, nmRoot, 'package.json')
      rootPkg = pkgAbsolute === closestPkgAbsolute ? closestPkg : readPackageJSON(this.#host, pkgAbsolute)
      ;({ name, version } = rootPkg)
      assert.ok(name, `Missing name in ${this.relative(pkgAbsolute)}`)
      assert.ok(version, `Missing version in ${this.relative(pkgAbsolute)}`)
      // A package.json of a package vendored into this one names that package: the file is listed in `vendored`.
      const vendorDir = vendorDirOf(name, nmRel)
      const vendor = vendorDir === undefined ? undefined : vendoredPackageOf(nmRel, vendorDir, this.#manifestsBelow(nmRoot))
      vendored = vendor?.vendored
      if (closestPkgAbsolute !== pkgAbsolute && !vendor?.below && !isInconsistentPackageJsonException(this.relative(closestPkgAbsolute))) {
        const message = `Inconsistent data between ${this.relative(closestPkgAbsolute)} and ${this.relative(pkgAbsolute)}`
        // Allow fake module-name subpaths: the real module owns the prefix (npm wouldn't publish this).
        if (closestPkg.name !== undefined && closestPkg.name !== name) assert.ok(closestPkg.name.startsWith(`${name}/`), message)
        // A subpackage whose own package.json is the closest has its own version.
        subpackage = this.#subpackageOf(nmRoot, nmRel, closestPkg, name)
        const ownVersion = subpackage !== undefined && closestPkg.name !== undefined
        if (closestPkg.version !== undefined && !ownVersion) assert.equal(closestPkg.version, version, message)
      }
    } else {
      pkgAbsolute = closestPkgAbsolute
      let json = closestPkg
      // A workspace package may omit version (private/unpublished): the name alone claims the bucket.
      while (json.name === undefined) {
        assert.ok(Object.keys(json).every((k) => k === 'type'))
        const dir = dirname(pkgAbsolute)
        assert.ok(dir !== this.root && isPathWithin(this.root, dir), `No package.json with a name found for ${file}`)
        pkgAbsolute = this.#nearestPackageJsonFor(dirname(dir))
        json = readPackageJSON(this.#host, pkgAbsolute)
      }
      name = json.name
      // `"version": null` folds to undefined as the parsers do, else identity splits on the next re-read.
      version = json.version ?? undefined
    }
    const pkg = this.relative(pkgAbsolute)
    assert.ok(pkg === 'package.json' || pkg.endsWith('/package.json'))
    const dir = dirname(pkg)
    if (nmRoot) assert.equal(dir, nmRoot)
    // Checked as the run reaches it, before it is recorded; a hashed file was checked when recorded or loaded.
    if (this.#policy !== null && (nmRoot || this.config.full) && !this.hashes.has(file)) this.#policy.assertPath(file, nmRoot ? { dir, name, version } : undefined, synthetic ? undefined : this.#links(file))
    if (!this.modules.has(dir)) this.modules.set(dir, moduleInfo({ name, version, ecosystem: nmRoot ? 'npm' : undefined, files: Object.create(null) }))
    const module = this.modules.get(dir)
    if (module.name !== name || module.version !== version) {
      // Message built only on failure: addFile is hot, and the mismatch is a migration/drift event.
      const hint = (module.version == null) === (version == null) ? '' : ' -- an artifact from an older stasis may record a ' +
        'placeholder version for a workspace package without one; regenerate it (lock=replace / bundle=replace)'
      assert.fail(`module identity mismatch for '${dir}': artifact records ` +
        `'${module.name}@${module.version ?? '(none)'}', package.json has '${name}@${version ?? '(none)'}'${hint}`)
    }
    // A dependency's repo is metadata, its package.json's, held to nothing: a record with none gets it.
    const repo = module.repo === undefined && rootPkg ? packageRepo(rootPkg) : undefined
    if (repo !== undefined) this.modules.set(dir, moduleInfo({ ...module, repo }))

    return { absolute, file, dir, module: this.modules.get(dir), closestType, vendored, subpackage }
  }

  #manifestsBelow(nmRoot) {
    return (sub) => {
      const candidate = resolve(this.root, nmRoot, sub, 'package.json')
      return packageJSONStat(this.#host, candidate)?.isFile() ? readPackageJSON(this.#host, candidate) : null
    }
  }

  // The nearest named package.json above `nmRel`, walked by the file's own path, not findPackageJSON's real one
  // through a symlinked install. Only where `closest` is a `{"type":"module"}` marker or names a subpath.
  #subpackageOf(nmRoot, nmRel, closest, name) {
    if (closest.name !== undefined && !(typeof closest.name === 'string' && closest.name.startsWith(`${name}/`))) return undefined
    const found = namedManifestOf(nmRel, this.#manifestsBelow(nmRoot))
    if (found === undefined || !isSubpackage(found.pkg.name, name, found.dir)) return undefined
    return { dir: found.dir, name: found.pkg.name, ...(isPackageString(found.pkg.version) ? { version: found.pkg.version } : {}) }
  }

  // `resource: true` (legacy `isBinary`): format derived from bytes. `inferFormat: false`: the loader decides.
  addFile(url, options = {}) {
    this.#addFile(url, options)
  }

  // The empty module a disabled import (`browser` field `false`) resolves to, never read from disk. -> its URL
  addEmptyModule({ reason = 'run' } = {}) {
    const url = this.#urlOf(EMPTY_MODULE_PATH)
    this.#addFile(url, { source: '', format: 'commonjs', inferFormat: false, reason }, { synthetic: true })
    return url
  }

  #addFile(url, { source, format, isEntry, isBinary, resource, inferFormat = true, reason = 'run', fsRead = false } = {}, { synthetic = false } = {}) {
    const asResource = resource === true || isBinary === true
    if (!asResource && Bundle.isResourceFormat(format)) throw new Error(`addFile: format '${format}' requires resource: true`)
    if (isStatFormat(format)) throw new Error(`addFile: format '${format}' is a payload-free stat record; use addFsStat`)
    if (asResource && isEntry) throw new Error(`addFile: a resource can't be an entry (resource:true + isEntry:true)`)
    const { absolute, file, dir, module, closestType, vendored, subpackage } = this.#locateModule(url, { synthetic })

    // Real content supersedes a payload-free stat record.
    if (isStatFormat(this.formats.get(file))) this.formats.delete(file)

    const ext = extname(file)
    if (asResource && CODE_EXTENSIONS.has(ext.slice(1).toLowerCase())) {
      throw new Error(`addFile: a code file can't be recorded as a resource: ${file}`)
    }

    if (!asResource && inferFormat) {
      const inferredFormat = nodeExtFormat(file) ??
        (closestType === undefined ? undefined : ext === '.js' ? closestType : ext === '.ts' ? `${closestType}-typescript` : undefined)
      if (inferredFormat !== undefined) {
        // A transforming preload (`--import tsx`) loads TypeScript as its post-erasure family: attest the on-disk one.
        if (format == null || format === erasedTypeScriptFormat(inferredFormat)) format = inferredFormat
        else assert.equal(format, inferredFormat)
      } else if (format == null) {
        // No `type`: one already recorded (the loader's, or a sidecar's parent's), not a commonjs re-default.
        const variants = UNTYPED_VARIANTS[ext]
        const known = this.formats.get(file) ?? this.#parent?.formats.get(file)
        format = variants?.includes(known) ? known : variants?.[0]
      } else if (ext === '.ts' && (format === 'commonjs' || format === 'module')) {
        // A transforming preload's post-erasure family again. Stacks can still disagree on a no-`type` .ts (tsx
        // defaults to commonjs, Node syntax-detects): that rightly surfaces as a format flip.
        format = `${format}-typescript`
      }
    }

    let sourceFromDisk = false
    if (typeof source === 'string') {
      assert.ok(source.isWellFormed())
    } else {
      if (source == null) {
        source = this.#host.readFile(absolute)
        sourceFromDisk = true
      }
      assert.ok(Buffer.isBuffer(source))
      if (!asResource) assert.ok(isUtf8(source), `File is not UTF-8: ${file}`)
    }

    const buf = typeof source === 'string' ? Buffer.from(source) : source
    if (!sourceFromDisk && !synthetic) assert.deepStrictEqual(this.#host.readFile(absolute), buf)

    if (asResource) {
      const derived = isUtf8(buf) ? 'resource' : 'resource:base64'
      if (format != null) assert.equal(format, derived, `resource format mismatch for ${file}`)
      format = derived
    }

    if (isEntry) this.entries.add(file)
    const integrity = sha512integrity(buf)
    noupsert(this.hashes, file, integrity)
    this.#filesCapturedThisRun.add(file)
    if (this.config.childProcess) this.#observed.add(file) // only a child's shardSnapshot reads it
    // A null reason: the caller attributes it (includePackageJson).
    if (this.config.bundle && reason !== null) {
      this.#recordReason(reason, file)
      if (reason === 'run') (fsRead && this.#pluginAttached ? this.#fsReadPostPlugin : this.#runOwn).add(file)
    }
    const rel = relative(dir, file)
    assert.ok(!relativeEscapes(rel))

    const inAttestedZone = this.config.full || hasNodeModulesSegment(dir)
    if (inAttestedZone) this.#assertFrozenAttests('File', file, module, rel, asResource ? this.#bundleResources : this.#bundleSources, format)

    // Caught here: at write()'s #mergedFormats a format flip would surface only as a bare `Conflict`.
    if (this.config.writeLockfile && this.#lockFormats !== null && format != null && inAttestedZone) {
      const attested = this.#lockFormats.get(file)
      // A 'stat:*' baseline is not a flip: real content this run UPGRADES the record (#mergedFormats).
      assert.ok(attested === undefined || attested === format || isStatFormat(attested),
        `format flip for ${file}: lockfile attests '${attested}', observed '${format}' (bytes unchanged) -- re-run with --lock=replace to re-attest`)
    }

    if (!Object.hasOwn(module.files, rel)) module.files[rel] = integrity
    assert.equal(module.files[rel], integrity)
    // The first identity recorded for a vendored package's or subpackage's dir stands.
    for (const [field, entry] of [['vendored', vendored], ['subpackages', subpackage]]) {
      if (entry === undefined || Object.hasOwn(this.modules.get(dir)[field] ?? {}, entry.dir)) continue
      const { dir: sub, ...identity } = entry
      this.modules.set(dir, withMetadataOf(this.modules.get(dir), { [field]: { [sub]: Object.freeze(identity) } }))
    }

    if (this.config.bundle) {
      if (asResource) noupsert(this.resources, file, buf.toString(format === 'resource:base64' ? 'base64' : 'utf8'))
      else noupsert(this.sources, file, typeof source === 'string' ? source : source.toString())
    }

    if (format) noupsert(this.formats, file, format)

    if (!synthetic) this.#recordExecutable(file, absolute)
  }

  // Disk wins over a seeded lockfile/bundle, but only a real observation refutes (Windows can't). A REFUTATION
  // must reach the whole family, else #mergedExecutable's union resurrects the bit from a sibling's seed.
  #recordExecutable(file, absolute) {
    const executable = observeExecutable(absolute, this.#host)
    if (executable === true) {
      this.executable.add(file)
      return
    }
    if (executable !== false || !CAN_OBSERVE_EXECUTE_BITS) return
    this.executable.delete(file)
    const root = this.#parent ?? this
    root.executable.delete(file)
    for (const sidecar of root.sidecars()) sidecar.executable.delete(file)
  }

  // Public, so #recordExecutable reaches them across the class brand.
  sidecars() {
    return this.#sidecars
  }

  // An undeclared file THROWS: it would widen the attested set.
  addFsFile(url, source) {
    assert.ok(Buffer.isBuffer(source), 'addFsFile requires a Buffer source')
    const path = fileURLToPath(url)
    const options = this.#readFileOptions(path, source)
    if (options === null) {
      throw new Error(`addFsFile: ${path} is neither code nor a declared resource; add its extension or filename to the resources allowlist or stop reading it`)
    }
    this.addFile(url, { source, ...options, fsRead: true })
  }

  // For a file read rather than loaded: a concrete format is code, null defers to the loader, and undefined (or a
  // binary plist, which can't be the UTF-8 code its format implies) is a resource IFF in `resources`, else null.
  #readFileOptions(path, source, resources = this.config.resources) {
    const format = classifyFormat(path, { content: source })
    if (format !== undefined && !isBinaryPlist(path, source)) return { format: format ?? undefined, inferFormat: false }
    if (inResources(path, resources)) return { resource: true }
    return null
  }

  // Each file `extra` names is carried as an fs read is, unless the run captured it itself. The whole set is
  // validated first, naming every offender at once; `outputs` never go in.
  includeExtra({ outputs = this.#writeTargets(), resources = this.config.resources } = {}) {
    if (this.config.extra.length === 0) return
    // Resolved as write() writes them: a relative one from the cwd.
    const written = new Set(outputs.map((file) => toPosix(relative(this.root, resolve(file)))))
    const { files } = expandExtra(this.root, this.config.extra, written, this.#host)
    const realRoot = this.#host.realpath(this.root)
    const missing = []
    const undeclared = []
    const nonUtf8 = []
    const toAdd = []
    const captured = []
    for (const [rel, stats] of files) {
      if (stats === undefined) {
        missing.push(rel)
        continue
      }
      assertRealPathWithinBase(realRoot, this.root, rel, this.#host)
      const absolute = resolve(this.root, rel)
      const url = pathToFileURL(absolute).toString()
      // A node_modules scope leaves the project's own files out, as it does the run's.
      if (!inScope(this, url)) continue
      // The run's record of a file it captured stands, and `extra` is one more consumer of it.
      const file = this.#canonicalFile(url)
      if (this.#filesCapturedThisRun.has(file)) {
        captured.push(file)
        continue
      }
      const source = this.#host.readFile(absolute)
      const options = this.#readFileOptions(absolute, source, resources)
      if (options === null) undeclared.push(rel)
      else if (!options.resource && !isUtf8(source)) nonUtf8.push({ rel, format: options.format })
      else toAdd.push({ url, source, options })
    }
    if (missing.length + undeclared.length + nonUtf8.length > 0) throw validationError({ missing, undeclared, nonUtf8 }, 'extra')
    for (const { url, source, options } of toAdd) this.addFile(url, { source, ...options, reason: 'extra' })
    if (this.config.bundle) for (const file of captured) this.#recordReason('extra', file)
  }

  get #lockPath() {
    return this.config.lockFile || join(this.root, LOCK_FILE)
  }

  get #bundlePath() {
    return this.config.bundleFile || join(this.root, BUNDLE_FILE)
  }

  // A sidecar never writes the lockfile.
  #writeTargets() {
    const lock = this.config.writeLockfile && !this.#parent ? [this.#lockPath] : []
    const bundles = this.config.writeBundle ? [this.#bundlePath, this.config.resourcesBundleFile] : []
    return [...lock, ...bundles].filter((file) => file !== undefined)
  }

  // The listing is SORTED, for reproducibility.
  addFsDir(url, names) {
    assert.ok(Array.isArray(names) && names.every((n) => typeof n === 'string'), 'addFsDir requires an array of string names')
    const { file, dir, module } = this.#locateModule(url, { directory: true })
    if (isStatFormat(this.formats.get(file))) this.formats.delete(file)
    const content = JSON.stringify(names.toSorted())
    const integrity = sha512integrity(content)
    noupsert(this.hashes, file, integrity)
    if (this.config.childProcess) this.#observed.add(file) // only a child's shardSnapshot reads it
    if (this.config.bundle) this.#recordReason('run', file)
    const rel = relative(dir, file)
    assert.ok(!relativeEscapes(rel))

    if (this.config.full || hasNodeModulesSegment(dir)) this.#assertFrozenAttests('Directory', file, module, rel, this.#bundleResources, 'directory')

    if (!Object.hasOwn(module.files, rel)) module.files[rel] = integrity
    assert.equal(module.files[rel], integrity)
    if (this.config.bundle) noupsert(this.resources, file, content)
    noupsert(this.formats, file, 'directory')
    // Both artifacts' parsers refuse a listing in `executable`.
    this.executable.delete(file)
  }

  // A PAYLOAD-FREE record (no bytes/hash/module-files entry), so getFsStat answers at load. A real format wins.
  addFsStat(url, kind) {
    assert.ok(kind === 'file' || kind === 'directory', `addFsStat: unsupported kind '${kind}'`)
    const file = this.#canonicalFile(url)
    if (this.hashes.has(file) || this.#bundled(file)) return
    this.#checkUnreadPath(file)
    upsertFormat(this.formats, file, `stat:${kind}`)
    // Only where a stat record landed: one yielded to a real format is an entry mergeShard's stat replay ignores.
    if (this.config.childProcess && isStatFormat(this.formats.get(file))) this.#observed.add(file)
  }

  // Undefined (the hook falls back to disk) when uncaptured or a directory. Served by presence, not format.
  getFsFile(url) {
    if (!this.hasFsFileContent(url)) return undefined
    const { source } = this.getFile(url)
    return Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8')
  }

  getFsDir(url) {
    const file = this.#canonicalFileMaybe(url)
    if (file === undefined || this.formats.get(file) !== 'directory') return undefined
    const names = JSON.parse(this.getFile(url).source)
    assert.ok(Array.isArray(names), `corrupt directory listing for ${file}`)
    return names
  }

  // Built once, at load: stat records prove existence too.
  #impliedDirs() {
    if (this.#impliedDirIndex) return this.#impliedDirIndex
    const dirs = (this.#impliedDirIndex = new Set(['.']))
    const stats = this.formats.entries().filter(([, format]) => isStatFormat(format)).map(([key]) => key)
    for (const key of [...this.sources.keys(), ...this.resources.keys(), ...stats]) {
      const parts = key.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
    return dirs
  }

  // Undefined: uncaptured, the shim falls back to disk. 'file' means "recorded", NOT "bytes serveable".
  getFsStat(url) {
    const file = this.#canonicalFileMaybe(url)
    if (file === undefined) return undefined
    const format = this.formats.get(file)
    if (format === 'directory') return 'directory'
    if (this.#bundled(file) || format === 'stat:file') return 'file'
    if (format === 'stat:directory' || this.#impliedDirs().has(file)) return 'directory'
    return undefined
  }

  hasFsFileContent(url) {
    const file = this.#canonicalFileMaybe(url)
    return file !== undefined && this.formats.get(file) !== 'directory' && this.#bundled(file)
  }

  // Else --fs re-records the bundler's whole module graph into the main bundle. Not getFsStat: skipping an
  // implied dir or stat-only record would leave a real read unattested.
  attestedBySidecar(url) {
    return this.#sidecars.values().some((s) => s.hasFsFileContent(url))
  }

  // Write-mode sidecars only capture.
  #fromFamily(method, url) {
    for (const state of [this, ...this.#readSidecars]) {
      const value = state[method](url)
      if (value !== undefined) return value
    }
    return undefined
  }

  getFsFileFamily(url) {
    return this.#fromFamily('getFsFile', url)
  }

  getFsStatFamily(url) {
    return this.#fromFamily('getFsStat', url)
  }

  getFsDirFamily(url) {
    return this.#fromFamily('getFsDir', url)
  }

  getFile(url) {
    let file
    try { file = this.#canonicalFile(url) }
    catch (cause) { throw new Error(`stasis: file is outside the project root: ${url}`, { cause }) }
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    // The fail-closed gate.
    let source = (Bundle.isResourceFormat(format) ? this.resources : this.sources).get(file)
    if (source === undefined) {
      if (isStatFormat(format)) {
        throw new Error(`stasis: only a payload-free stat record ('${format}') is attested for ${url} -- the capture ` +
          "stat'd this path but never read or imported it, so the bundle has no bytes to serve")
      }
      throw new Error(`stasis: file not attested in bundle: ${url}`)
    }
    if (format === 'resource:base64') source = Buffer.from(source, 'base64')
    // Without a lockfile the bundle is self-attesting.
    if (this.config.useLockfile) assert.equal(this.hashes.get(file), sha512integrity(source))
    return { source, format }
  }

  // Masks 'stat:*' (existence, not how bytes parse), so the resolve hook's format gate doesn't refuse a stat'd
  // require.resolve target; getFile does NOT mask.
  #loaderFormat(file) {
    const format = this.formats.get(file)
    return isStatFormat(format) ? undefined : format
  }

  getFormat(url) {
    return this.#loaderFormat(this.#canonicalFile(url))
  }

  // Different conditions / import attributes can yield different URLs/formats for the same parent+specifier
  #conditionsKey(conditions, importAttributes) {
    const cond = conditions === '*' ? '*' : conditions.join(', ')
    assert.ok(!cond.includes('(') && !cond.includes(')'), 'conditions must not contain "(" or ")"')
    const attrs = importAttributes ? Object.entries(importAttributes) : []
    if (attrs.length === 0) return cond
    const sorted = Object.fromEntries(attrs.toSorted(([a], [b]) => (a < b ? -1 : 1)))
    return `${cond} (with: ${JSON.stringify(sorted)})`
  }

  // An ABSOLUTE in-root specifier would be a machine-specific lockfile key: renormalized against the IMPORTING
  // FILE's dir, alike wherever a key is written or queried.
  #canonicalSpecifier(parentURL, specifier) {
    if (typeof specifier !== 'string') return specifier
    const path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
    if (!isAbsolute(path)) return specifier
    const fromRoot = relative(this.root, path)
    if (fromRoot === '' || relativeEscapes(fromRoot)) return specifier // outside the project root
    const rel = relative(dirname(fileURLToPath(parentURL)), path)
    return rel.startsWith('.') ? rel : `./${rel}`
  }

  addImport(parentURL, specifier, url, { conditions = '*', format, importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    if (this.#requireConditions === null && resolutionContext(conditions) === 'require') this.#requireConditions = conditions
    assert.ok(parentURL, 'addImport requires a parent (entries go through addFile)')
    const parent = this.#canonicalFile(parentURL)
    const file = this.#canonicalFile(url)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)

    // Hashes can't see a redirect to another attested file. Workspace parents in nm scope may be unknown.
    const tolerateUnknown = !this.config.full && !hasNodeModulesSegment(parent)
    if (this.config.frozen && this.#lockImports !== null) {
      this.#assertAttestedResolution(this.#lockImports, key, parent, specifier, file, { what: 'observed', source: 'lockfile', tolerateUnknown })
    }
    if (this.config.frozenBundle) {
      this.#assertAttestedResolution(this.#bundleImports, key, parent, specifier, file, { what: 'observed', source: 'frozen bundle', tolerateUnknown })
    }

    noupsert(nestedMap(nestedMap(this.imports, key), parent), specifier, file)
    // A real format replaces a weak 'stat:*' record.
    if (format) {
      this.#checkUnreadPath(file)
      upsertFormat(this.formats, file, format)
    }
  }

  // A resolution a bundler made itself (Metro's) must be the attested edge, `platform`'s where per-platform.
  assertImport(parentURL, specifier, url, { conditions = '*', importAttributes, platform: targetPlatform } = {}) {
    assert.ok(this.config.loadBundle, 'assertImport checks a resolution against a loaded bundle (bundle=load)')
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    assert.ok(parentURL, 'assertImport requires a parent')
    const parent = this.#canonicalFile(parentURL)
    const file = this.#canonicalFile(url)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)
    const tolerateUnknown = !this.config.full && !hasNodeModulesSegment(parent)
    this.#assertAttestedResolution(this.imports, key, parent, specifier, file, { what: 'observed', source: 'bundle', tolerateUnknown, targetPlatform })
  }

  getImport(parentURL, specifier, { conditions = '*', importAttributes, platform } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    assert.ok(parentURL, 'getImport requires a parent')
    const parent = this.#canonicalFile(parentURL)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)
    // Static bundles store edges under '*' (Node's condition set is unpredictable); the precise key wins.
    let file = this.imports.get(key)?.get(parent)?.get(specifier)
    if (file === undefined && key !== '*') file = this.imports.get('*')?.get(parent)?.get(specifier)
    if (file === undefined) {
      // The edge may be under another conditions bucket.
      if (this.config.loadBundle) {
        const abs = this.resolveBundled(parentURL, specifier, { conditions })
        if (abs !== undefined) return { url: pathToFileURL(abs).toString(), format: this.#loaderFormat(relative(this.root, abs)) }
      }
      // Not a bare assert: dynamic-import callers guard on ERR_MODULE_NOT_FOUND.
      throw Object.assign(new Error(`Cannot find module '${specifier}' imported from ${parent}`), { code: 'ERR_MODULE_NOT_FOUND' })
    }
    // A --metro per-platform edge is a { platform: file } Map; plain bundle=load has no platform to pick by.
    if (typeof file !== 'string') {
      if (!file.has(platform)) {
        const message = platform === undefined
          ? `Resolution of '${specifier}' from ${parent} is platform-specific (a --metro multi-platform bundle, which is Metro's to build); plain node has no platform to pick one by`
          : `Resolution of '${specifier}' from ${parent} is platform-specific and records no '${platform}' target (only ${[...file.keys()].join(', ')}): the bundle wasn't made for '${platform}'`
        throw Object.assign(new Error(message), { code: 'ERR_STASIS_PLATFORM_SPECIFIC' })
      }
      file = file.get(platform)
    }
    return { url: this.#urlOf(file), format: this.#loaderFormat(file) }
  }

  // A CJS require() target as a bundled path, or undefined to defer to Node. Every conditions bucket matches,
  // but where conditions decide (readsConditions), the other context's keys are another resolution.
  resolveBundled(parentURL, specifier, { conditions = '*' } = {}) {
    const parent = this.#canonicalFileMaybe(parentURL)
    if (parent === undefined) return undefined
    const spec = this.#canonicalSpecifier(parentURL, specifier)
    const context = resolutionContext(conditions)
    // Node's own context's set is stable, the rest varying by flag; a relative edge resolves alike under either,
    // as a capture's replay can ask it (tsx's CJS lane does).
    const contextual = context !== null && readsConditions(spec)
    const matches = new Set()
    const ownContext = new Set()
    for (const [key, byParent] of this.imports) {
      const file = byParent.get(parent)?.get(spec)
      if (file === undefined) continue
      const keyContext = resolutionContext(key)
      if (contextual && keyContext !== null && keyContext !== context) continue
      matches.add(file)
      if (context !== null && keyContext === context) ownContext.add(file)
    }
    // Divergent buckets are settled by the lookup's own context where those agree, else defer.
    const candidates = matches.size === 1 ? matches : ownContext
    if (candidates.size !== 1) return undefined
    const [only] = candidates
    // A per-platform Map (--metro) has no single path.
    return typeof only === 'string' ? resolve(this.root, only) : undefined
  }

  get #contributors() {
    return [this, ...this.#sidecars]
  }

  // So a partial lock=add run extends without dropping edges.
  #mergedImports() {
    const merged = new Map()
    for (const imports of [this.#lockImports ?? [], ...this.#contributors.map((state) => state.imports)]) {
      for (const [conditions, byParent] of imports) {
        const mergedParents = nestedMap(merged, conditions)
        for (const [parent, specifiers] of byParent) {
          const mergedSpecifiers = nestedMap(mergedParents, parent)
          for (const [specifier, file] of specifiers) noupsert(mergedSpecifiers, specifier, file)
        }
      }
    }
    return merged
  }

  // Append-only like #mergedImports, except that a weak 'stat:*' is UPGRADED by real content.
  #mergedFormats() {
    const merged = new Map(this.#lockFormats ?? [])
    for (const { formats } of this.#contributors) {
      for (const [file, format] of formats) upsertFormat(merged, file, format)
    }
    // Never on a file carrying a content hash: one re-seeded from #lockFormats is beyond addFile's delete,
    // and an ambiguous .js/.ts yields no real format to override it.
    for (const [file, format] of merged) if (isStatFormat(format) && this.hashes.has(file)) merged.delete(file)
    return merged
  }

  // Narrowed to the keys the lockfile SERIALIZES: an entry for a dropped bucket would be refused at parse.
  #mergedExecutable(formats) {
    const all = new Set(this.#contributors.flatMap((state) => [...state.executable]))
    return narrowExecutable(all, { modules: this.modules, formats, scope: this.config.scope })
  }

  get lockfile() {
    const formats = this.#mergedFormats()
    return new Lockfile({
      config: this.config.values,
      entries: this.entries,
      modules: this.modules,
      imports: this.#mergedImports(),
      formats,
      executable: this.#mergedExecutable(formats),
    })
  }

  get lockData() {
    return this.lockfile.serialize()
  }

  #bundleModules(perFile) {
    const modules = new Map()
    for (const [dir, info] of this.modules) {
      const files = {}
      for (const rel of Object.keys(info.files)) {
        const content = perFile.get(moduleFileKey(dir, rel))
        if (content !== undefined) files[rel] = content
      }
      if (Object.keys(files).length > 0) modules.set(dir, moduleInfo({ ...info, files }))
    }
    return modules
  }

  // Files fs-READ after this point for a plugin are the plugin's, not run's (#reasonClaims). Public, cross-copy.
  markPluginAttached() {
    this.#pluginAttached = true
  }

  #recordReason(reason, file) {
    upsert(this.#reasonFiles, reason, () => new Set()).add(file)
  }

  // Less what run only fs-READ after a plugin attached that a plugin also bundles. `extra` bundles nothing.
  #reasonClaims() {
    const isPlugin = (who) => who !== 'run' && who !== 'extra'
    const pluginFiles = new Set(this.#reasonFiles.entries().filter(([who]) => isPlugin(who)).flatMap(([, recorded]) => recorded))
    const fsReadOnly = (file) => this.#fsReadPostPlugin.has(file) && !this.#runOwn.has(file)
    const claims = new Map()
    for (const [who, recorded] of this.#reasonFiles) {
      claims.set(who, new Set(who === 'run' ? [...recorded].filter((file) => !(fsReadOnly(file) && pluginFiles.has(file))) : recorded))
    }
    const run = claims.get('run')
    if (run === undefined || pluginFiles.size === 0 || this.#fsReadPostPlugin.size === 0) return claims
    // A package.json fs-read post-plugin, of a package a plugin bundles, is one a bundler reads to resolve but
    // never bundles: that plugin's too, and run's only where run has its own claim on it or another file.
    for (const [dir, module] of this.modules) {
      const rels = Object.keys(module.files)
      const read = new Set(rels.filter((rel) => basename(rel) === 'package.json').map((rel) => moduleFileKey(dir, rel)).filter((file) => this.#fsReadPostPlugin.has(file) && !pluginFiles.has(file)))
      if (read.size === 0) continue
      const files = rels.map((rel) => moduleFileKey(dir, rel)).filter((file) => !read.has(file))
      const plugins = [...claims].filter(([who, claimed]) => isPlugin(who) && files.some((file) => claimed.has(file))).map(([, claimed]) => claimed)
      if (plugins.length === 0) continue // no plugin bundles the package: run's own read
      const runClaimsPackage = files.some((file) => run.has(file))
      for (const file of read) {
        for (const claimed of plugins) claimed.add(file)
        if (fsReadOnly(file) && !runClaimsPackage) run.delete(file)
      }
    }
    return claims
  }

  // Informational, never attested.
  #bundleReason(contents) {
    const claims = this.#reasonClaims()
    const reason = {}
    // Sorted: else #emitBundle's compare-and-skip sees spurious diffs.
    for (const who of [...claims.keys()].toSorted()) {
      const files = [...claims.get(who)].filter((file) => contents.has(file))
      if (files.length > 0) reason[who] = sortedByPath(files)
    }
    return Object.keys(reason).length > 1 ? reason : undefined
  }

  // Less a 'stat:*' the unified attestation upgraded, else the bundle fails its lockfile cross-check at load.
  #formatsForBundle() {
    const merged = this.#mergedFormats()
    const upgraded = ([file, format]) => isStatFormat(format) && merged.get(file) !== format
    if (!this.formats.entries().some(upgraded)) return this.formats
    return new Map(this.formats.entries().filter((entry) => !upgraded(entry)))
  }

  get #detectedRepo() {
    return (this.#detectedRepoCache ??= { value: detectRepo(this.root, this.#host) }).value
  }

  #repoFor(half) {
    if (!this.#absorbedRepos.has(half)) return this.#detectedRepo
    const absorbed = this.#absorbedRepos.get(half)
    return absorbed && mergeRepo(absorbed, this.#detectedRepo)
  }

  #bundle(half, contents, formats, { entries = this.entries, imports = this.imports } = {}) {
    const modules = this.#bundleModules(contents)
    return new Bundle({
      config: this.config.values,
      entries,
      modules,
      formats,
      imports,
      executable: narrowExecutable(this.executable, { modules, formats, scope: this.config.scope }),
      reason: this.#bundleReason(contents),
      repo: this.#repoFor(half),
    })
  }

  get sourceBundle() {
    const contents = new Map(this.sources)
    for (const [file, content] of this.resources) {
      assert.ok(!contents.has(file), `state invariant: file ${file} in both sources and resources`)
      contents.set(file, content)
    }
    return this.#bundle('code', contents, this.#formatsForBundle())
  }

  get sourceData() {
    return this.sourceBundle.serialize()
  }

  // Split-bundle halves. Stat records go in the code half: the resources half's shape check would reject them.
  get codeBundle() {
    const codeFormats = new Map([...this.#formatsForBundle()].filter(([, format]) => !Bundle.isResourceFormat(format)))
    return this.#bundle('code', this.sources, codeFormats)
  }

  get resourcesBundle() {
    const resourceFormats = new Map([...this.formats].filter(([, format]) => Bundle.isResourceFormat(format)))
    // Bundle.parse waives the entries requirement with no code.
    return this.#bundle('resources', this.resources, resourceFormats, { entries: new Set(), imports: new Map() })
  }

  // Verbatim, last-write-wins: #backfillObservedResolutions decides which to add.
  observeResolution(parentURL, specifier, resolvedURL) {
    nestedMap(this.#observedResolutions, parentURL).set(specifier, resolvedURL)
  }

  observeExecution(url) {
    const file = this.#canonicalFileMaybe(url)
    if (file !== undefined) this.#executedFiles.add(file)
  }

  isBundledSource(url) {
    const file = this.#canonicalFileMaybe(url)
    return file !== undefined && this.sources.has(file)
  }

  // A resolve-only edge stays byte-less by design, but an EXECUTED file the load hook never saw is a hole a
  // frozen replay would never verify. addFile re-checks bytes in frozen modes, so tampering fails loudly.
  #backfillExecutedFiles() {
    for (const file of this.#executedFiles) {
      if (this.#filesCapturedThisRun.has(file)) continue
      // A native addon is deliberately not captured: non-deterministic across installs.
      if (isNativeArtifact(file)) continue
      const url = this.#urlOf(file)
      if (inScope(this, url)) this.addFile(url, { reason: 'run' })
    }
  }

  // Attested, but the bytes are NOT seeded: that would widen trust to everything that merely resolves.
  #backfillObservedResolutions() {
    for (const [parentURL, specs] of this.#observedResolutions) {
      const parent = this.#canonicalFileMaybe(parentURL)
      if (parent === undefined) continue
      for (const [specifier, resolvedURL] of specs) {
        const file = this.#canonicalFileMaybe(resolvedURL)
        if (file === undefined || (!this.#bundled(file) && !inScope(this, resolvedURL))) continue
        const spec = this.#canonicalSpecifier(parentURL, specifier)
        const recorded = this.imports.values().some((byParent) => byParent.get(parent)?.get(spec) !== undefined)
        if (!recorded) this.addImport(parentURL, specifier, resolvedURL, { conditions: this.#requireConditions ?? '*' })
      }
    }
  }

  // Every bundled module's package.json, reached or not, for a load/prune to read, and a bundled file's nearer
  // one (an `esm/package.json` marker). Keyed on bundle membership, NOT this.hashes (lockfile-seeded, shared).
  includePackageJson() {
    // Gathered first: addFile mutates this.modules.
    const realRoot = this.#host.realpath(this.root)
    const claims = this.#reasonClaims()
    const exists = memoized((rel) => packageJSONStat(this.#host, resolve(this.root, rel))?.isFile() ?? false)
    const read = (rel) => {
      const buf = readModuleManifest({ baseDir: this.root, realBase: realRoot, rel, host: this.#host })
      if (!buf) return null
      try {
        const pkg = JSON.parse(packageJSONText(buf))
        return isPlainObject(pkg) ? { buf, pkg } : null
      } catch {
        return null
      }
    }
    const toAdd = []
    for (const [dir, module] of this.modules) {
      const own = moduleFileKey(dir, 'package.json')
      // Under bundle=add a dep may have drifted, and #locateModule would crash on it.
      const manifest = read(own)
      if (manifest === null || manifest.pkg.name !== module.name || manifest.pkg.version !== module.version) continue
      const files = Object.keys(module.files).map((f) => moduleFileKey(dir, f))
      const scopes = new Map([[own, files]])
      for (const file of files) {
        const nearest = this.#bundled(file) ? scopeManifestOf(file, dir, exists) : undefined
        if (nearest !== undefined) upsert(scopes, nearest, () => []).push(file)
      }
      for (const [rel, of] of scopes) {
        if (this.#bundled(rel)) continue // already in this bundle
        const buf = rel === own ? manifest.buf : read(rel)?.buf
        if (buf === undefined) continue
        // It rides along BECAUSE a consumer bundled its files, so it inherits each. Derived BEFORE the adds
        // below, so one fold's manifest can't count as another bucket's consumer evidence.
        const consumers = [...claims].filter(([, claimed]) => of.some((file) => claimed.has(file))).map(([who]) => who)
        toAdd.push({ rel, buf, consumers })
      }
    }
    for (const { rel, buf, consumers } of toAdd) {
      this.addFile(this.#urlOf(rel), { source: buf, reason: null })
      for (const who of consumers) this.#recordReason(who, rel)
    }
  }

  // Native resolutions BEFORE the stasis-core BFS, which must see an edge they add to seed its bytes.
  #backfill() {
    this.#backfillObservedResolutions()
    this.#backfillExecutedFiles()
    this.#backfillBeforeWrite()
  }

  write() {
    this.#backfill()
    const writing = this.config.writeLockfile || this.config.writeBundle
    // A frozen run verifies what it reached, not `extra`.
    if (writing) this.includeExtra()
    // AFTER the backfills and `extra`, so buckets they create are covered too.
    if (this.config.writeBundle && this.config.packageJSON) this.includePackageJson()
    if (writing) this.#recordInstalled()

    // All serialized before the first is written, so one that can't be leaves the others as they were.
    const lockText = this.config.writeLockfile && !this.#parent ? this.lockData : null
    const sourcesPath = this.#bundlePath
    const bundles = !this.config.writeBundle ? [] : this.config.resourcesBundleFile
      ? [[sourcesPath, this.#bundleText(this.sources.size > 0, () => this.codeBundle.serialize())],
          [this.config.resourcesBundleFile, this.#bundleText(this.resources.size > 0, () => this.resourcesBundle.serialize())]]
      : [[sourcesPath, this.#bundleText(this.sources.size > 0 || this.resources.size > 0, () => this.sourceData)]]

    if (lockText !== null && lockText !== this.#lastLockData) {
      mkdirSync(dirname(this.#lockPath), { recursive: true })
      writeFileSync(this.#lockPath, lockText)
      this.#lastLockData = lockText
    }
    for (const [path, text] of bundles) this.#emitBundle(path, text)
  }

  // For a forked child to hand back; the root re-reads bytes. Entries are dropped: a child's is its fork target.
  shardSnapshot() {
    this.#backfill()
    const files = []
    const formats = new Map()
    for (const file of this.#observed) {
      const format = this.formats.get(file)
      if (format !== undefined) formats.set(file, format)
      if (this.hashes.has(file)) files.push(file)
    }
    // Bundle-seeded edges, whose parent this process didn't observe, the root attests already.
    const imports = new Map()
    for (const [conditions, byParent] of this.imports) {
      for (const parent of this.#observed) {
        const specs = byParent.get(parent)
        if (specs !== undefined) nestedMap(imports, conditions).set(parent, specs)
      }
    }
    return serializeShard({ scope: this.config.scope, files, formats, imports })
  }

  // As if this process read those files itself, re-read from disk. Best-effort: a gone/out-of-scope record is skipped.
  mergeShard(shardText) {
    const shard = parseShard(shardText)
    assert.equal(shard.scope, this.config.scope, `shard scope "${shard.scope}" != root scope "${this.config.scope}"`)
    // An in-root KEY may resolve through a symlink OUTSIDE the root on THIS disk: real containment is re-checked.
    for (const file of shard.files) {
      const absolute = resolve(this.root, file)
      if (!realContained(this.root, absolute)) continue
      // ABOVE the fast path: a child refutes a bit by OMISSION. Re-derived from THIS disk, never forged.
      this.#recordExecutable(file, absolute)
      // The byte re-read dominates merge cost, but a concrete format the root LACKS a later frozen run needs.
      const format = shard.formats.get(file)
      if (this.hashes.has(file) && (format === undefined || (this.formats.get(file) ?? this.#lockFormats?.get(file)) !== undefined)) continue
      const url = pathToFileURL(absolute).toString()
      try {
        if (format === 'directory') {
          // Range-checked FIRST, so a child-forged `..` key can't make us list it.
          if (!isPathWithin(this.root, absolute)) continue
          this.addFsDir(url, this.#host.readdir(absolute).map((entry) => entry.name))
        } else if (Bundle.isResourceFormat(format)) {
          // The resource tag is re-derived from the re-read bytes.
          this.addFile(url, { resource: true })
        } else if (format === undefined) {
          // An fs-READ .js/.ts: a commonjs default would collide with the `module` a later import records.
          this.addFile(url, { inferFormat: false })
        } else {
          // Else a child-only ESM .js under a no-`type` package re-defaults to commonjs.
          this.addFile(url, { format })
        }
      } catch { /* gone/unreadable, or out of scope */ }
    }
    // Stat records live ONLY in the shard's formats; the kind is re-derived from DISK, range-checked first.
    for (const [file, format] of shard.formats) {
      if (!isStatFormat(format)) continue
      const absolute = resolve(this.root, file)
      if (!isPathWithin(this.root, absolute)) continue
      try {
        // A stat, NOT an lstat, as the child's capture; a symlink pointing OUT must not attest an external kind.
        const stats = this.#host.stat(absolute)
        const kind = stats?.isDirectory() ? 'directory' : stats?.isFile() ? 'file' : null
        if (kind === null || !realContained(this.root, absolute)) continue
        this.addFsStat(pathToFileURL(absolute).toString(), kind)
      } catch { /* gone/dangling, or a kind conflict with the root's capture */ }
    }
    for (const [conditions, byParent] of shard.imports) {
      // Reverse #conditionsKey, so attributed edges merge under the child's key.
      const withAt = conditions.indexOf(' (with: ')
      const condStr = withAt === -1 ? conditions : conditions.slice(0, withAt)
      let importAttributes
      if (withAt !== -1) {
        try { importAttributes = JSON.parse(conditions.slice(withAt + ' (with: '.length, -1)) } catch { /* leave undefined */ }
      }
      const cond = condStr === '*' ? '*' : condStr.split(', ')
      for (const [parent, specs] of byParent) {
        const parentURL = this.#urlOf(parent)
        for (const [specifier, file] of specs) {
          const url = this.#urlOf(file)
          try { this.addImport(parentURL, specifier, url, { conditions: cond, importAttributes }) } catch { /* skipped */ }
        }
      }
    }
  }

  #bundleText(hasContent, serialize) {
    return !hasContent && this.config.replaceBundle ? null : serialize()
  }

  // Null DELETES the file: a replace run is authoritative.
  #emitBundle(path, text) {
    if (text === null) {
      rmSync(path, { force: true })
    } else if (text !== this.#lastBundleText.get(path)) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, compressBundleText(text, this.config.brotliQuality))
    }
    this.#lastBundleText.set(path, text)
  }

  get parent() {
    return this.#parent
  }

  // For a preload-cached stasis-core module the resolve hook records the edge but the load hook never fires.
  #backfillBeforeWrite() {
    const isStasisCoreFile = (file) => STASIS_CORE_FILE_RE.test(`/${file}`)
    // Anything else stays a resolution attested without bytes: the load-time getFile gate enforces trust.
    const imported = new Set(this.imports.values().flatMap((byParent) => byParent.values()).flatMap((specifiers) => specifiers.values()))
    const stasisCoreMissing = [...imported].filter((file) => typeof file === 'string' && isStasisCoreFile(file) &&
      !this.hashes.has(file) && !this.#bundled(file) && inScope(this, this.#urlOf(file)))
    if (stasisCoreMissing.length === 0) return

    const preloadRel = this.#preloadRoot ? relative(this.root, this.#preloadRoot) : null
    assert.ok(preloadRel !== null && !relativeEscapes(preloadRel),
      `state.write() has imports referencing un-captured stasis-core files but no usable preloadRoot ` +
      `(preloadRoot=${this.#preloadRoot ?? 'unset'}). The live load hook missed an in-scope target -- ` +
      `investigate rather than silently patch: ${stasisCoreMissing.slice(0, 3).join(', ')}`)

    const PRELOAD_CONDITIONS = ['node', 'import', 'module-sync', 'node-addons']
    // Every stasis-core file already in sources too, to walk their transitive imports.
    const queue = new Set([...stasisCoreMissing, ...[...this.sources.keys()].filter(isStasisCoreFile)])
    for (const file of queue) {
      // 'run', as Node evaluated these before registerHooks could see: a consumer-less record can't be sorted.
      if (!this.#bundled(file)) this.addFile(this.#urlOf(file), { reason: 'run' })
      const source = this.sources.get(file)
      if (typeof source !== 'string') continue
      const baseURL = this.#urlOf(file)
      const recordEdge = (specifier) => {
        const targetURL = new URL(specifier, baseURL).toString()
        const targetAbsolute = fileURLToPath(targetURL)
        let targetFile
        try { targetFile = this.relative(targetAbsolute) } catch { return }
        if (!isStasisCoreFile(targetFile) || !this.#exists(targetAbsolute)) return
        queue.add(targetFile)
        this.addImport(baseURL, specifier, targetURL, { conditions: PRELOAD_CONDITIONS })
      }
      // stasis-core's ESM import shape, tight enough to ignore JSDoc/template-literal false positives.
      for (const m of source.matchAll(/ from '(\.\/[a-zA-Z-]+\.c?js)'\n/g)) recordEdge(m[1])
      // The src/package.cjs version shim, matched exactly.
      for (const m of source.matchAll(/require\('(\.\.\/package\.json)'\)/g)) recordEdge(m[1])
    }
  }
}

// Anchored against `/${file}`, so a project-root file merely ending in `@exodus/stasis-core/...` isn't matched.
const STASIS_CORE_FILE_RE = /\/@exodus\/stasis-core\/(?:src\/[a-zA-Z-]+\.c?js|package\.json)$/
