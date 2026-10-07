import assert from 'node:assert/strict'
import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { join, resolve, relative, basename, dirname, extname, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

import { Config } from './config.js'
import { Bundle, mergeRepo } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { parseShard, serializeShard } from './shard.js'
import { canonicalizePath, sha512integrity, readFileSyncMaybe, noupsert } from './state-util.js'
import { brotliOptions } from './brotli.js'
import { CODE_EXTENSIONS, canObserveExecuteBits, classifyFormat, erasedTypeScriptFormat, fileMapToObject, hasNodeModulesSegment, isBinaryPlist, isNativeArtifact, isPathWithin, isStatFormat, moduleFileKey, moduleInfo, narrowExecutable, nestedMap, objectToMaps, observeExecutable, pathExt, reconcileFormat, relativeEscapes, sortPaths, splitNodeModulesPath } from './util.js'
import { detectRepo, packageJSONStat, packageJSONText, packageRepo, readModuleManifest } from './bundle-util.js'
import { diskHost } from './host.js'
import corePackage from './package.cjs'

// Destructure off the namespace: captures the real fns at eval time, so writes survive --mock's
// syncBuiltinESMExports() remock of node:fs.
const { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } = fs

const FILE_CONFIG = 'stasis.config.json'
const FILE_LOCK = 'stasis.lock.json'
const FILE_CODE = 'stasis.code.br'

// Via src/package.cjs: a bundler-safe re-export of package.json.
const VERSION = corePackage.version

const CAN_OBSERVE_EXECUTE_BITS = canObserveExecuteBits()

const invalidPackageConfig = (pkgAbsolute, cause) => Object.assign(
  cause === undefined ? new Error(`Invalid package config ${pkgAbsolute}.`) : new Error(`Invalid package config ${pkgAbsolute}.`, { cause }),
  { code: 'ERR_INVALID_PACKAGE_CONFIG' })

// A package.json's fields; one that is no JSON object is refused as Node refuses it.
function readPackageJSON(host, pkgAbsolute) {
  const buf = host.readFile(pkgAbsolute)
  assert.ok(isUtf8(buf))
  let json
  try {
    json = JSON.parse(packageJSONText(buf))
  } catch (cause) {
    throw invalidPackageConfig(pkgAbsolute, cause)
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw invalidPackageConfig(pkgAbsolute)
  return json
}

// A weak 'stat:*' yields to a real format; two real formats or a stat kind flip are fatal.
function upsertFormat(map, file, format) {
  const currentFormat = map.get(file)
  map.set(file, currentFormat === undefined ? format : reconcileFormat(format, currentFormat, file))
}

// Loader formats the extension alone decides; `.js`/`.ts` follow the nearest package `type`.
const EXT_FORMATS = { __proto__: null, '.json': 'json', '.mjs': 'module', '.cjs': 'commonjs', '.mts': 'module-typescript', '.cts': 'commonjs-typescript' }
// With no `type`, Node decides .js/.ts by syntax detection: either variant is possible, the first is the default.
const UNTYPED_VARIANTS = { __proto__: null, '.js': ['commonjs', 'module'], '.ts': ['commonjs-typescript', 'module-typescript'] }

// Nested package.json files known to disagree with their package root's name/version because of
// upstream packaging, exempt from #locateModule's consistency check. Matched as a segment-aligned
// suffix of the project-relative path, so hoisted, nested and .pnpm-store copies all match.
// Maintained list: add only a confirmed upstream false positive, with its reason.
const INCONSISTENT_PACKAGE_JSON_EXCEPTIONS = [
  'node_modules/@redis/client/dist/package.json', // stale build-time copy
]
const isInconsistentPackageJsonException = (file) =>
  INCONSISTENT_PACKAGE_JSON_EXCEPTIONS.some((suffix) => file === suffix || file.endsWith(`/${suffix}`))

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
  // Project-relative files carrying a POSIX execute bit; disk is authoritative (a file that lost
  // the bit drops out). Emitted as the artifacts' `executable` list.
  executable = new Set()
  config
  root
  #parent
  #isPreload = false
  #host

  // Claimed write-target paths (canonicalized -> label), for cross-State collision detection; a
  // State built with `claim: false`, which never writes (a static build), claims none.
  #claim
  #claims = new Map()

  // WRITE-mode sidecars: lockfile CONTRIBUTORS (#mergedImports/#mergedFormats union theirs in).
  #sidecars = new Set()
  // LOAD-mode sidecars: read-only, NOT lockfile contributors (getFs*Family serves bytes from them).
  #readSidecars = new Set()

  // Lockfile-attested resolutions (conditions -> parent -> specifier -> file) and loader formats
  // (file -> format), or null; may be supersets of what a run observes, so kept apart from the live maps.
  #lockImports = null
  #lockFormats = null
  // Loaded a lockfile at construction: #mergeBundleMetadata cross-checks bundle metadata against
  // it instead of absorbing it as source of truth.
  #lockfileLoaded = false

  // Keys THIS process recorded this run (not the seeded baseline); shardSnapshot forwards only these.
  #observed = new Set()
  // file -> consumers that recorded it, for the bundle's informational `reason` field.
  #reasonFiles = new Map()
  #runImported = new Set()
  #fsReadPostPlugin = new Set()
  #pluginAttached = false

  // Attested by a frozen bundle (bundle=frozen), or null: closes the attested set, so anything the
  // bundle never recorded is rejected. Separate from the live maps.
  #bundleSources = null
  #bundleResources = null
  #bundleImports = null
  #bundleFormats = null

  // Lazily-built dirs IMPLIED by recorded files, so getFsStat answers isDirectory() at bundle=load.
  #impliedDirIndex = null

  // Native resolutions (parent URL -> specifier -> resolved URL) from the Module._resolveFilename
  // shim: require.resolve()/CJS require()s bypassing the resolve hook.
  #observedResolutions = new Map()

  // Files a require() actually EXECUTED (from the Module._load shim) -- unlike a resolve-only
  // edge, an executed file with no captured bytes is a hole in the attestation, so write()
  // backfills it from disk (a transplanted require.extensions handler, e.g. a transforming
  // preload's CJS TypeScript pipeline, loads files without ever hitting the load hook).
  #executedFiles = new Set()

  // Files whose BYTES this run captured via addFile. Distinct from this.hashes, which also
  // absorbs lockfile-seeded entries: #backfillExecutedFiles must key on "observed this run", or
  // a frozen/add run would skip verifying an executed file merely because a hash is on record.
  #filesCapturedThisRun = new Set()

  // Node's require-condition set, from the first require()-context addImport;
  // #backfillObservedResolutions keys native edges under it so the lockfile is Node-version-stable.
  #requireConditions = null

  // Root of a package Node loaded BEFORE our hooks (stasis-core's own); write()'s backfill
  // statically parses files under it to recover edges the resolve hook never observed.
  #preloadRoot = null

  // Per-artifact "last serialized" caches: write() skips brotli + writeFileSync on unchanged text.
  #lastLockData = null
  #lastUnifiedBundle = null
  #lastCodeBundle = null
  #lastResourcesBundle = null
  // Lazy `{ value: detectRepo(this.root, this.#host) }`.
  #detectedRepoCache
  // Half ('code' | 'resources') -> `repo` of the bundle absorbed there for adding to.
  #absorbedRepos = new Map()

  // Memoized #canonicalUncached (per URL, State-lifetime): a realpathSync per node_modules URL, and
  // hot callers repeat relentlessly. Sound only because the tree holds still mid-run; the cached
  // result is shared -- never mutate it.
  #canonicalCache = new Map()

  // Options: `preload` (the unique preload State), `parent` (run as a sidecar sharing the parent's
  // hashes/entries/modules, with its own sources/formats/imports/resources and bundle) and
  // `skipDiscovery` (a caller-populated in-memory State, NO filesystem discovery; read-only modes
  // only). All other keys forward to Config.
  constructor(root, options = {}) {
    const { preload: isPreload = false, parent: parentState, preloadRoot, skipDiscovery = false, host = diskHost, env = process.env, claim = true, ...configOptions } = options
    this.config = new Config({ ...configOptions, env, host })
    this.#host = host
    this.#claim = claim
    if (isPreload) assert.ok(!State.preload, 'Only one preload Stasis instance is supported')
    assert.ok(!(isPreload && parentState), 'preload and parent are mutually exclusive')
    this.#isPreload = isPreload

    if (parentState) {
      // A sidecar shares the parent's maps and inherits its attestation, so a version skew is
      // unsound (a different module copy is fine -- it reads only the parent's PUBLIC surface).
      assert.equal(parentState.version, VERSION,
        `child State version '${VERSION}' must exactly match parent version '${parentState.version}'`)
      this.#parent = parentState
      this.root = parentState.root
      this.hashes = parentState.hashes
      this.entries = parentState.entries
      this.modules = parentState.modules
      // Public sidecarInheritance() (works across copies): the lockfile attestation must reach the
      // sidecar, else a tampered bundle could redirect a resolution on hash-valid bytes.
      const inherited = parentState.sidecarInheritance()
      this.#preloadRoot = inherited.preloadRoot
      this.#lockImports = inherited.lockImports
      this.#lockFormats = inherited.lockFormats
      this.#lockfileLoaded = inherited.lockfileLoaded
      assert.ok(this.config.bundleFile, 'sidecar State requires bundleFile')
      // Only writing States claim, so two write-intent States can't silently target the same file.
      if (this.config.writeBundle) {
        this.#claimWritePath('bundleFile', 'sidecar ')
        this.#claimWritePath('resourcesBundleFile', 'sidecar ')
      }
      // frozenBundle MUST go through this branch too -- it has its own attestation snapshot to build.
      if (this.config.bundle) {
        const sourcesPath = this.config.bundleFile
        const sources = this.#readMaybe(sourcesPath)
        if (sources && !this.config.replaceBundle) {
          const bundle = Bundle.parse(brotliDecompressSync(sources).toString('utf-8'))
          // v0 bundle has no per-file formats or import map -- serving one via a sidecar widens trust.
          assert.equal(bundle.version, Bundle.VERSION,
            `stasis sidecar requires a v1 bundle; ${sourcesPath} is v${bundle.version}. ` +
            `Re-bundle with the current stasis or \`bundle=replace\` against a v0-free starting point.`)
          assert.equal(bundle.config.scope, this.config.scope)
          // Cross-checked against the parent's lockfile, or absorbed if none (shared hashes/entries/
          // modules mean those writes propagate to the parent).
          this.#absorbCodeBundle(bundle, this.#lockfileLoaded)
        }
        this.#absorbResourcesBundleFile(this.#lockfileLoaded)
      }
      if (this.config.frozenBundle) {
        assert.ok(this.#bundleSources !== null, 'No bundle, but attempting to run in frozen bundle mode')
      }
      // Register AFTER every fallible step so a throw leaves no dead reference. Frozen sidecars
      // join neither registry (--fs neither captures nor serves in frozen-bundle mode).
      if (this.config.writeBundle) parentState.registerSidecar(this)
      else if (this.config.loadBundle) parentState.registerReadSidecar(this)
      if (this.#claims.size > 0) liveStates().add(this)
      return
    }

    if (skipDiscovery) {
      assert.ok(!this.config.frozen && !this.config.frozenBundle && !this.config.writeBundle && !this.config.writeLockfile,
        'skipDiscovery is read-only: incompatible with frozen and write (add/replace) lock/bundle modes')
      this.root = resolve(root)
      this.#setPreloadRoot(preloadRoot)
      if (isPreload) liveStates().add(this)
      return
    }

    // Capture and load MUST agree on where the upward walk stops (PROJECT_CWD/.git/
    // pnpm-workspace.yaml), else they commit different roots and fail "outside the project root".
    const potentialRoots = []
    for (let cursor = root; cursor; cursor = dirname(cursor)) {
      // One there that can't be read is refused, not walked past to a root above (packageJSONStat).
      if (packageJSONStat(this.#host, join(cursor, 'package.json')) !== null) {
        potentialRoots.push(cursor)
      } else if ([FILE_CONFIG, FILE_LOCK, FILE_CODE].some((file) => this.#exists(join(cursor, file)))) {
        throw new Error('Unexpected stasis config without package.json')
      }
      if (cursor === env.PROJECT_CWD) break // e.g. yarn sets this
      if (this.#exists(join(cursor, '.git')) || this.#exists(join(cursor, 'pnpm-workspace.yaml'))) break
      if (dirname(cursor) === cursor) break
    }

    // default root is top-level package.json, to opt-in to per-dir create stasis.config.json
    this.root = potentialRoots.at(-1)
    assert.ok(this.root, `stasis: no package.json found at or above ${resolve(root)}; run stasis from within a project`)

    let loaded = false
    let lockfileLoaded = false
    // Explicit lockFile: suppress the per-rootDir probe so a stale project-root lockfile can't
    // shadow it; substituted below.
    const explicitLockPath = this.config.lockFile
    // A construction-time (flag/env) `bundleFile` is rootDir-INDEPENDENT, so it must NOT be a
    // root-detection signal: picking the innermost dir would diverge load's root from the capture
    // root. A config-only bundleFile is NOT suppressed (its dir already carries the config signal).
    const explicitBundlePath = this.config.bundleFile
    for (const rootDir of potentialRoots) {
      const config = readFileSyncMaybe(rootDir, FILE_CONFIG, 'utf-8', this.#host)
      const lockProbe = explicitLockPath ? null : readFileSyncMaybe(rootDir, FILE_LOCK, 'utf-8', this.#host)
      let sourcesPath = explicitBundlePath || join(rootDir, FILE_CODE)
      let sources = this.#readMaybe(sourcesPath)
      // Root-SELECTION signals: a config, a lockfile, or only the DEFAULT <rootDir>/stasis.code.br
      // (see explicitBundlePath; an explicit bundleFile is still loaded via `sources`).
      if (config === null && lockProbe === null && (explicitBundlePath || sources === null)) continue
      if (loaded) throw new Error('Stasis config already loaded')
      loaded = true
      this.root = rootDir

      if (config) {
        this.config.loadConfig(config)
        // stasis.config.json may set a `bundleFile` the probe couldn't see -- re-resolve and re-read.
        const configuredPath = this.config.bundleFile || join(rootDir, FILE_CODE)
        if (configuredPath !== sourcesPath) {
          sourcesPath = configuredPath
          sources = this.#readMaybe(sourcesPath)
        }
      }

      const lock = explicitLockPath ? this.#readMaybe(explicitLockPath, 'utf-8') : lockProbe
      lockfileLoaded = this.#absorbLockfile(lock, explicitLockPath || join(rootDir, FILE_LOCK))
      this.#loadBundleArtifacts(sources, sourcesPath, lockfileLoaded)

      // Innermost matching rootDir wins (per-dir opt-in); without this break an outer root
      // re-detects a rootDir-independent bundleFile and trips `loaded`.
      break
    }

    // Explicit lockfile but no discovery indicator: the loop never ran, so absorb here against
    // `this.root` (outermost) so the run still has attestation.
    if (!loaded && explicitLockPath) {
      lockfileLoaded = this.#absorbLockfile(this.#readMaybe(explicitLockPath, 'utf-8'), explicitLockPath)
    }

    // Explicit bundleFile suppressed as a root signal above: load against `this.root` (outermost).
    if (!loaded && (explicitBundlePath || this.config.resourcesBundleFile)) {
      this.#loadBundleArtifacts(explicitBundlePath ? this.#readMaybe(explicitBundlePath) : null, explicitBundlePath, lockfileLoaded)
    }

    // Post-loop: with no stasis files the loop never runs, and a frozen run must fail closed.
    if (this.config.frozen) assert.ok(lockfileLoaded, 'No lockfile, but attempting to run in frozen mode')
    if (this.config.frozenBundle) assert.ok(this.#bundleSources !== null, 'No bundle, but attempting to run in frozen bundle mode')

    // Claim write targets so no other live State (any copy) silently targets the same file.
    if (this.config.writeBundle) {
      this.#claimWritePath('bundleFile')
      this.#claimWritePath('resourcesBundleFile')
    }
    if (this.config.writeLockfile) this.#claimWritePath('lockFile')

    this.#setPreloadRoot(preloadRoot)

    // The registry answers for the preload and for write claims; any other State stays out of it.
    if (isPreload || this.#claims.size > 0) liveStates().add(this)
  }

  #exists(p) {
    return this.#host.stat(p) !== null
  }

  // The file at `path` through the host, or null when there is none.
  #readMaybe(path, encoding) {
    return readFileSyncMaybe(dirname(path), basename(path), encoding, this.#host)
  }

  #setPreloadRoot(preloadRoot) {
    if (preloadRoot === undefined) return
    assert.equal(typeof preloadRoot, 'string', 'preloadRoot must be a string')
    this.#preloadRoot = preloadRoot
  }

  // Absorb a lockfile's attestation; returns whether it was actually absorbed. Lockfile.parse
  // requires both imports and formats, so an absorbed lockfile always attests them.
  #absorbLockfile(lock, lockPath) {
    if (lock && !this.config.useLockfile && !this.config.ignoreLockfile) {
      throw new Error(`Unexpected ${lockPath} with config.lock = 'none'`)
    }
    if (!lock || !this.config.useLockfile || this.config.replaceLockfile) return false
    const lockfile = Lockfile.parse(lock)
    if (this.config.frozen) assert.equal(lockfile.config.scope, this.config.scope)

    const includeSources = lockfile.config.scope === 'full' && this.config.full
    for (const [dir, info] of lockfile.modules) {
      if (!hasNodeModulesSegment(dir) && !includeSources) continue
      this.modules.set(dir, info)
    }
    if (includeSources) this.entries = lockfile.entries

    for (const [dir, { files }] of this.modules) {
      for (const [name, hash] of Object.entries(files)) noupsert(this.hashes, join(dir, name), hash)
    }
    this.#lockImports = lockfile.imports
    this.#lockFormats = lockfile.formats
    // Seeded into the live set (not a separate baseline) so re-reading a file this run can CLEAR
    // a stale exec bit.
    this.#absorbExecutable(lockfile)
    this.#lockfileLoaded = true
    return true
  }

  // An on-disk bundle is read in under add/load/frozen; replace starts over.
  get #absorbsBundles() {
    return this.config.bundle && !this.config.replaceBundle
  }

  // Gate and load the bundle artifacts for a committed root; `sources` may be null (no bundle, or
  // resources-only).
  #loadBundleArtifacts(sources, sourcesPath, lockfileLoaded) {
    if (sources && this.config.bundleMode === 'none') {
      throw new Error(`Unexpected ${sourcesPath} with config.bundle = 'none'`)
    }
    // A frozen bundle is self-attesting, so it needs no sibling lockfile and is exempt here.
    if (sources && !lockfileLoaded && this.config.useLockfile && !this.config.replaceLockfile && !this.config.frozenBundle) {
      throw new Error('stasis.lock.json missing, can not use sources')
    }
    if (sources && this.#absorbsBundles) this.#loadCodeBundle(sources, sourcesPath, lockfileLoaded)
    this.#absorbResourcesBundleFile(lockfileLoaded)
  }

  // The resources half of a split layout, when configured and present on disk.
  #absorbResourcesBundleFile(lockfileLoaded) {
    const resourcesPath = this.config.resourcesBundleFile
    const resourcesData = resourcesPath ? this.#readMaybe(resourcesPath) : null
    if (resourcesData && this.#absorbsBundles) this.#absorbResourcesBundle(resourcesData, { lockfileLoaded, resourcesPath })
  }

  #loadCodeBundle(sources, sourcesPath, lockfileLoaded) {
    const bundle = Bundle.parse(brotliDecompressSync(sources).toString('utf-8'))
    // Bundle.parse accepts v0 for offline tooling; the runtime refuses it -- v0 has no per-file
    // formats or import map, so serving one widens the trust boundary.
    assert.equal(bundle.version, Bundle.VERSION,
      `stasis run requires a v1 bundle; ${sourcesPath} is v${bundle.version}. ` +
      `Re-bundle with the current stasis (\`stasis bundle\`) or \`stasis run --bundle=replace\` ` +
      `against a v0-free starting point to upgrade.`)
    assert.equal(bundle.config.scope, this.config.scope)
    // assertEntry short-circuits on an empty set, so a runnable full-scope code bundle must declare
    // an entry here -- else any bundled file could run as the root. Add-only bundles have none.
    assert.ok(!this.config.full || bundle.entries.size > 0 || !bundle.hasCode,
      `${sourcesPath}: a full-scope bundle carrying code must declare an entry to run ` +
      `(an add-only attestation has none; run a bundle built by \`stasis bundle\`/\`stasis run\`)`)
    this.#absorbCodeBundle(bundle, lockfileLoaded)
  }

  // Take a parsed code bundle (unified, or the code half) as the live maps, cross-checked against
  // the loaded lockfile, and snapshot it when it is the frozen attestation.
  #absorbCodeBundle(bundle, lockfileLoaded) {
    this.#mergeBundleMetadata(bundle, { lockfileLoaded })
    for (const [file, content] of bundle.sources) {
      if (Bundle.isResourceFormat(bundle.formats.get(file))) this.resources.set(file, content)
      else this.sources.set(file, content)
    }
    this.formats = bundle.formats
    this.imports = bundle.imports
    this.#absorbExecutable(bundle)
    this.#seedReasonFromBundle(bundle)
    this.#absorbRepo('code', bundle)
    if (this.config.frozenBundle) {
      // Snapshot before addFile/addImport mutate the live maps; imports is deep-cloned because
      // this.imports shares bundle.imports's nested Maps.
      this.#bundleSources = new Set(this.sources.keys())
      this.#bundleResources = new Set(this.resources.keys())
      this.#bundleImports = objectToMaps(fileMapToObject(bundle.imports))
      this.#bundleFormats = new Map(bundle.formats)
    }
  }

  // Cross-check bundle metadata (entries/modules) against the loaded lockfile, or absorb it as
  // source of truth when none. v0 buckets carry no version, so unverifiable entries are skipped.
  #mergeBundleMetadata(bundle, { lockfileLoaded }) {
    if (lockfileLoaded) {
      if (bundle.entries.size > 0) {
        assert.deepStrictEqual([...bundle.entries].toSorted(), [...this.entries].toSorted(), 'bundle/lockfile entries mismatch')
      }
      for (const [dir, info] of bundle.modules) {
        if (!info.name) continue // workspace bucket or fallback: no inferable name
        assert.ok(this.modules.has(dir), `bundle module ${dir} missing in lockfile`)
        const lockModule = this.modules.get(dir)
        assert.equal(info.name, lockModule.name)
        // Strict, absent included: every absorb site requires a v1 bundle, so a missing version is
        // a real workspace identity (or a stripped field), never v0 partial metadata -- a
        // version-less bundle bucket must not dodge the lockfile consistency check.
        assert.equal(info.version, lockModule.version, `bundle module ${dir} version mismatch with lockfile`)
        // `repo` is metadata, which a lockfile never records: the bundle's is taken, to be written again.
        if (lockModule.repo === undefined && info.repo !== undefined) this.modules.set(dir, moduleInfo({ ...lockModule, repo: info.repo }))
        for (const rel of Object.keys(info.files)) {
          assert.ok(Object.hasOwn(lockModule.files, rel), `bundle file ${dir}/${rel} missing in lockfile`)
        }
      }
      // Hashes alone don't stop a redirect to a different hash-valid file, so every edge the bundle
      // could serve must match the lockfile's attested target (a lockfile superset is fine).
      if (this.#lockImports !== null) {
        for (const [conditions, byParent] of bundle.imports) {
          for (const [parent, specifiers] of byParent) {
            for (const [specifier, file] of specifiers) {
              this.#assertAttestedResolution(this.#lockImports, conditions, parent, specifier, file, { what: 'bundle', source: 'lockfile' })
            }
          }
        }
      }
      // A format flip changes how hash-valid bytes parse (module<->commonjs) without touching a
      // hash, so every bundle format must match the lockfile's; unattested is fatal.
      if (this.#lockFormats !== null) {
        for (const [file, format] of bundle.formats) {
          this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'bundle', source: 'lockfile' })
        }
        // Inverse: a lockfile-tagged resource MUST be tagged in the bundle too, else omitting the
        // tag routes the base64 payload through this.sources (code) to the loader.
        for (const [dir, { files }] of bundle.modules) {
          for (const rel of Object.keys(files)) {
            const file = moduleFileKey(dir, rel)
            const lockFormat = this.#lockFormats.get(file)
            if (!Bundle.isResourceFormat(lockFormat)) continue
            assert.equal(bundle.formats.get(file), lockFormat,
              `bundle file ${file} must declare format='${lockFormat}' to match the lockfile`)
          }
        }
      }
    } else {
      // Mutate in place: this.entries may be shared by reference with a sidecar's parent.
      for (const e of bundle.entries) this.entries.add(e)
      for (const [dir, info] of bundle.modules) {
        // Skip v0 partial metadata (nameless workspace buckets, version-less node_modules
        // buckets); a v1 workspace bucket may omit version, so its identity is absorbed anyway.
        if (!info.name || (!info.version && hasNodeModulesSegment(dir))) continue
        const existing = this.modules.get(dir)
        if (existing === undefined) {
          this.modules.set(dir, moduleInfo({ ...info, files: Object.create(null) }))
        } else {
          // A dir may be added twice (code + resource entries), and both must agree.
          assert.equal(info.name, existing.name, `bundle ${dir} name mismatch`)
          assert.equal(info.version, existing.version, `bundle ${dir} version mismatch`)
          // `repo` is metadata, held to nothing: the first half's that records one.
          if (existing.repo === undefined && info.repo !== undefined) this.modules.set(dir, moduleInfo({ ...existing, repo: info.repo }))
        }
      }
    }
  }

  // Load the resources half of a split-bundle layout: ONLY resource-format files, unioned into the
  // bundleFile state.
  #absorbResourcesBundle(resourcesData, { lockfileLoaded, resourcesPath }) {
    const bundle = Bundle.parse(brotliDecompressSync(resourcesData).toString('utf-8'))
    assert.equal(bundle.version, Bundle.VERSION,
      `stasis run requires a v1 resources bundle; ${resourcesPath} is v${bundle.version}. ` +
      `Re-bundle with the current stasis or \`bundle=replace\` against a v0-free starting point to upgrade.`)
    assert.equal(bundle.config.scope, this.config.scope)
    // A populated imports/entries map means mixed halves or tampering -- widens trust on the code side.
    assert.equal(bundle.imports.size, 0, `resources bundle ${resourcesPath} must have empty imports`)
    assert.equal(bundle.entries.size, 0, `resources bundle ${resourcesPath} must have empty entries`)
    for (const [file, format] of bundle.formats) {
      assert.ok(Bundle.isResourceFormat(format),
        `resources bundle ${resourcesPath} declares non-resource format='${format}' for ${file}`)
    }
    this.#mergeBundleMetadata(bundle, { lockfileLoaded })
    for (const [file, content] of bundle.sources) this.resources.set(file, content)
    // Union formats: the two halves' file sets must be disjoint.
    for (const [file, format] of bundle.formats) {
      const existing = this.formats.get(file)
      assert.ok(existing === undefined || existing === format,
        `format conflict for ${file}: bundleFile declares '${existing}', resourcesBundleFile declares '${format}'`)
      this.formats.set(file, format)
    }
    this.#absorbExecutable(bundle)
    this.#seedReasonFromBundle(bundle)
    this.#absorbRepo('resources', bundle)
    if (this.config.frozenBundle) {
      // Extend the frozen snapshot, init lazily: resources-only deployments are legal, so
      // bundleFile may not have populated these.
      this.#bundleResources ??= new Set()
      this.#bundleFormats ??= new Map()
      this.#bundleImports ??= objectToMaps(fileMapToObject(this.imports))
      this.#bundleSources ??= new Set(this.sources.keys())
      for (const f of bundle.sources.keys()) this.#bundleResources.add(f)
      for (const [f, fmt] of bundle.formats) this.#bundleFormats.set(f, fmt)
    }
  }

  // Union (never replace) an absorbed artifact's `executable` list into the live set: a lockfile
  // seed, or the code half of a split layout, may already have contributed.
  #absorbExecutable(artifact) {
    for (const file of artifact.executable) this.executable.add(file)
  }

  // Verify one resolution edge against an attestation map: exact conditions key first, else accept
  // only if every condition set agrees on one target. Unknown edges fatal unless tolerateUnknown.
  #assertAttestedResolution(attestation, conditions, parent, specifier, file, { what, source = 'lockfile', tolerateUnknown = false }) {
    const edge = `'${specifier}' from ${parent} (${conditions})`
    let attested = attestation.get(conditions)?.get(parent)?.get(specifier)
    if (attested === undefined) {
      const targets = new Set()
      for (const [, parents] of attestation) {
        const target = parents.get(parent)?.get(specifier)
        if (target !== undefined) targets.add(target)
      }
      if (targets.size === 0 && tolerateUnknown) return
      assert.ok(targets.size > 0, `${what} resolution ${edge} is not attested by the ${source}`)
      assert.ok(targets.size === 1, `${what} resolution ${edge} is attested inconsistently across condition sets in the ${source}`)
      ;[attested] = targets
    }
    // A per-platform edge is a Map<platform, target>: compare structurally (assert.equal is
    // reference equality).
    const matches = file instanceof Map && attested instanceof Map
      ? file.size === attested.size && [...file].every(([platform, target]) => attested.get(platform) === target)
      : file === attested
    assert.ok(matches, `${what} resolution ${edge} mismatches the ${source}`)
  }

  // Verify one file's loader format. Callers only pass files that must be attested, so an
  // unattested file means a forged/extra entry -- fatal.
  #assertAttestedFormat(attestation, file, format, { what, source = 'lockfile' }) {
    const attested = attestation.get(file)
    assert.ok(attested !== undefined, `${what} format for ${file} is not attested by the ${source}`)
    assert.equal(format, attested, `${what} format for ${file} mismatches the ${source}`)
  }

  assertEntry(url) {
    // No entry attestation to check against (lock=none/ignore, fresh build) -- #loadCodeBundle
    // already refuses a runnable code bundle that declares none.
    if (this.entries.size === 0) return
    const file = this.#canonicalFile(url)
    assert.ok(this.entries.has(file), `Unknown entry point: ${file}`)
  }

  static get preload() {
    for (const state of liveStates()) if (state.isPreload) return state
    return undefined
  }

  // Public so State.preload works across copies.
  get isPreload() {
    return this.#isPreload
  }

  // Public for #claimWritePath's cross-copy collision scan.
  claimedWritePathLabel(canonical) {
    return this.#claims.get(canonical)
  }

  // Refuse a path another live State (ANY copy) already claims; canonicalized so `./x`/`x`/symlinks
  // compare equal. `key` names the config option; nothing is claimed when it is unset.
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

  // PUBLIC (not private-field reads) so a sidecar from a different copy can read it across the
  // class brand.
  sidecarInheritance() {
    return {
      preloadRoot: this.#preloadRoot,
      lockImports: this.#lockImports,
      lockFormats: this.#lockFormats,
      lockfileLoaded: this.#lockfileLoaded,
    }
  }

  // WRITE-mode sidecar: this parent's lockData unions its imports/formats. Public (cross-copy).
  registerSidecar(sidecar) {
    this.#sidecars.add(sidecar)
  }

  // LOAD-mode sidecar: served by getFs*Family, never a lockfile contributor. Public (cross-copy).
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

  #canonical(url) {
    let result = this.#canonicalCache.get(url)
    if (result === undefined) {
      result = this.#canonicalUncached(url)
      this.#canonicalCache.set(url, result)
    }
    return result
  }

  // A node_modules file whose REAL path is outside node_modules is a linked-in workspace source
  // (pnpm): canonicalize so it's recorded as a source, not a dependency. Everything else passes through.
  #canonicalUncached(url) {
    const absolute = this.absolute(url)
    const file = relative(this.root, absolute)
    if (relativeEscapes(file) || !splitNodeModulesPath(file)) return { url, absolute }
    let real
    try {
      real = this.#host.realpath(absolute)
    } catch {
      return { url, absolute }
    }
    if (real === absolute) return { url, absolute }
    const realFile = relative(this.root, real)
    if (relativeEscapes(realFile) || splitNodeModulesPath(realFile)) return { url, absolute }
    return { url: pathToFileURL(real).toString(), absolute: real }
  }

  #canonicalFile(url) {
    return this.relative(this.#canonical(url).absolute)
  }

  // #canonicalFile, or undefined for a URL outside the project root (the shims then pass through).
  #canonicalFileMaybe(url) {
    try {
      return this.#canonicalFile(url)
    } catch {
      return undefined
    }
  }

  // True when `url` resolves (through any workspace symlink) into node_modules -- not a raw
  // `/node_modules/` substring test, so a symlinked workspace source is read from disk.
  inNodeModules(url) {
    const file = this.#canonicalFileMaybe(url)
    return file !== undefined && splitNodeModulesPath(file) !== null
  }

  // Nearest package.json at or above a directory (findPackageJSON is unreliable for a directory
  // URL, see #locateModule), refusing one there that can't be read as findPackageJSON does
  // (packageJSONStat). Bounded by the project root.
  #nearestPackageJsonFor(dirAbsolute) {
    for (let dir = dirAbsolute; ; dir = dirname(dir)) {
      const candidate = join(dir, 'package.json')
      if (packageJSONStat(this.#host, candidate)?.isFile()) return candidate
      // The root's package.json was just checked; never escape root.
      if (dir === this.root || dirname(dir) === dir) break
    }
    // Unreachable: state.root is resolved to a dir that has package.json.
    assert.fail(`no package.json at or above directory ${this.relative(dirAbsolute)}`)
  }

  // Canonicalize `url` and resolve/register the owning package bucket. `directory: true` walks up
  // ourselves -- Node's findPackageJSON is unreliable for a directory URL (EISDIR, or the parent's).
  #locateModule(url, { directory = false } = {}) {
    // Canonicalize first: a linked-in workspace source is recorded under its real path (a source).
    const { absolute } = this.#canonical(url)
    assert.ok(this.#host.stat(absolute) !== null)
    const file = this.relative(absolute)

    const closestPkgAbsolute = directory ? this.#nearestPackageJsonFor(absolute) : this.#host.findPackageJSON(absolute)
    const closestPkg = readPackageJSON(this.#host, closestPkgAbsolute)

    const closestType = closestPkg.type
    assert.ok(closestType === undefined || closestType === 'module' || closestType === 'commonjs')

    // findPackageJSON may land on a `{"type":"module"}` sub-bucket marker lacking name/version.
    const nmRoot = splitNodeModulesPath(file)?.dir
    let pkgAbsolute, name, version, repo
    if (nmRoot) {
      pkgAbsolute = resolve(this.root, nmRoot, 'package.json')
      const rootPkg = pkgAbsolute === closestPkgAbsolute ? closestPkg : readPackageJSON(this.#host, pkgAbsolute)
      ;({ name, version } = rootPkg)
      repo = packageRepo(rootPkg)
      assert.ok(name, `Missing name in ${this.relative(pkgAbsolute)}`)
      assert.ok(version, `Missing version in ${this.relative(pkgAbsolute)}`)
      if (closestPkgAbsolute !== pkgAbsolute && !isInconsistentPackageJsonException(this.relative(closestPkgAbsolute))) {
        const message = `Inconsistent data between ${this.relative(closestPkgAbsolute)} and ${this.relative(pkgAbsolute)}`
        // Allow fake module-name subpaths: the real module owns the prefix (npm wouldn't publish this).
        if (closestPkg.name !== undefined && closestPkg.name !== name) assert.ok(closestPkg.name.startsWith(`${name}/`), message)
        if (closestPkg.version !== undefined) assert.equal(closestPkg.version, version, message)
      }
    } else {
      pkgAbsolute = closestPkgAbsolute
      let json = closestPkg
      // A workspace package outside node_modules may omit version (private/unpublished): the
      // name alone claims the bucket. node_modules buckets (above) still require both.
      while (json.name === undefined) {
        assert.ok(Object.keys(json).every((k) => k === 'type'))
        const dir = dirname(pkgAbsolute)
        assert.ok(dir !== this.root && isPathWithin(this.root, dir), `No package.json with a name found for ${file}`)
        pkgAbsolute = this.#nearestPackageJsonFor(dirname(dir))
        json = readPackageJSON(this.#host, pkgAbsolute)
      }
      name = json.name
      // A literal `"version": null` folds to undefined here too: the parsers normalize the same
      // way, and recording null verbatim would split identity on the next run's re-read.
      version = json.version ?? undefined
    }
    const pkg = this.relative(pkgAbsolute)
    assert.ok(pkg === 'package.json' || pkg.endsWith('/package.json'))
    assert.equal(basename(pkg), 'package.json')
    const dir = dirname(pkg)
    if (nmRoot) assert.equal(dir, nmRoot)
    if (!this.modules.has(dir)) {
      // Tag node_modules buckets `npm`; workspace/top-level buckets carry no ecosystem.
      this.modules.set(dir, moduleInfo({ name, version, ecosystem: nmRoot ? 'npm' : undefined, repo, files: Object.create(null) }))
    }
    const module = this.modules.get(dir)
    if (module.name !== name || module.version !== version) {
      // Message built only on failure: addFile is hot, and the mismatch is a migration/drift event.
      const hint = (module.version == null) === (version == null) ? '' :
        ' -- an artifact from an older stasis may record a placeholder version for a workspace ' +
        'package without one; regenerate it (lock=replace / bundle=replace)'
      assert.fail(`module identity mismatch for '${dir}': artifact records ` +
        `'${module.name}@${module.version ?? '(none)'}', package.json has '${name}@${version ?? '(none)'}'${hint}`)
    }
    // A dependency's repo is metadata, its package.json's, held to nothing: a record with none gets it.
    if (module.repo === undefined && repo !== undefined) this.modules.set(dir, moduleInfo({ ...module, repo }))

    return { absolute, file, dir, module, closestType }
  }

  // `resource: true` (legacy alias `isBinary: true`): format derived from bytes. `inferFormat: false`
  // records bytes without imposing a loader format (defers module-vs-commonjs to the loader).
  addFile(url, { source, format, isEntry, isBinary, resource, inferFormat = true, reason = 'run', fsRead = false } = {}) {
    const asResource = resource === true || isBinary === true
    if (!asResource && Bundle.isResourceFormat(format)) {
      throw new Error(`addFile: format '${format}' requires resource: true`)
    }
    if (isStatFormat(format)) {
      throw new Error(`addFile: format '${format}' is a payload-free stat record; use addFsStat`)
    }
    if (asResource && isEntry) {
      throw new Error(`addFile: a resource can't be an entry (resource:true + isEntry:true)`)
    }
    const { absolute, file, dir, module, closestType } = this.#locateModule(url)

    // Real content supersedes a payload-free stat record: drop it so the noupsert below records the
    // actual format instead of conflicting with 'stat:*'.
    if (isStatFormat(this.formats.get(file))) this.formats.delete(file)

    const ext = extname(file)
    if (asResource && CODE_EXTENSIONS.has(ext.slice(1).toLowerCase())) {
      throw new Error(`addFile: a code file can't be recorded as a resource: ${file}`)
    }

    if (!asResource && inferFormat) {
      const inferredFormat = EXT_FORMATS[ext] ??
        (closestType === undefined ? undefined : ext === '.js' ? closestType : ext === '.ts' ? `${closestType}-typescript` : undefined)
      if (inferredFormat !== undefined) {
        // A transforming preload (`stasis run --import tsx`) loads a TypeScript file as its
        // post-erasure family ('module-typescript' arrives as 'module'): attest the on-disk
        // format, not the transformer's runtime view. Anything else must still match exactly.
        if (format != null && format === erasedTypeScriptFormat(inferredFormat)) format = inferredFormat
        if (format != null) assert.equal(format, inferredFormat)
        else format = inferredFormat
      } else if (format == null) {
        // No `type`: reuse an extension-appropriate format already recorded this session (the
        // loader's call, or the parent's for a sidecar) rather than re-defaulting to commonjs and mis-attesting.
        const variants = UNTYPED_VARIANTS[ext]
        const known = this.formats.get(file) ?? this.#parent?.formats.get(file)
        format = variants?.includes(known) ? known : variants?.[0]
      } else if (ext === '.ts' && (format === 'commonjs' || format === 'module')) {
        // No `type`, but a transforming preload reported this .ts as its post-erasure family:
        // attest the on-disk '-typescript' variant, keeping same-stack replays self-consistent.
        // Stacks can still honestly disagree about a no-`type` .ts (tsx defaults to commonjs,
        // Node syntax-detects) -- that rightly surfaces as a format flip, not silently here.
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
    // Verify a CALLER-PROVIDED source against disk; tautological when we read it ourselves.
    if (!sourceFromDisk) assert.deepStrictEqual(this.#host.readFile(absolute), buf)

    if (asResource) {
      const derived = isUtf8(buf) ? 'resource' : 'resource:base64'
      if (format != null) assert.equal(format, derived, `resource format mismatch for ${file}`)
      format = derived
    }

    if (isEntry) this.entries.add(file)
    const integrity = sha512integrity(source)
    noupsert(this.hashes, file, integrity)
    this.#filesCapturedThisRun.add(file)
    if (this.config.childProcess) this.#observed.add(file) // only a child's shardSnapshot reads it; skip when the channel is off
    // Provenance for the bundle's `reason` field (null = the caller attributes it, see includePackageJson).
    if (this.config.bundle && reason !== null) {
      this.#recordReason(reason, file)
      // Track HOW 'run' saw this file so #bundleReason can drop files run merely fs-READ post-plugin.
      if (reason === 'run') {
        if (!fsRead) this.#runImported.add(file)
        else if (this.#pluginAttached) this.#fsReadPostPlugin.add(file)
      }
    }
    const rel = relative(dir, file)
    assert.ok(!relativeEscapes(rel))

    const inAttestedZone = hasNodeModulesSegment(dir) || this.config.full
    if (this.config.frozen && inAttestedZone) {
      assert.ok(Object.hasOwn(module.files, rel), `File not attested by the frozen lockfile: ${file}`)
    }

    // Close the attested set (bytes are checked by the noupsert below); node_modules scope
    // deliberately doesn't attest workspace files.
    if (this.config.frozenBundle && inAttestedZone) {
      const attested = asResource ? this.#bundleResources : this.#bundleSources
      assert.ok(attested?.has(file), `File not attested by the frozen bundle: ${file}`)
    }

    // `type` is usually not hash-attested, so a flip recategorizes a hash-valid file
    // (commonjs<->module) with no hash mismatch.
    if (this.config.frozen && this.#lockFormats !== null && format != null && inAttestedZone) {
      this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'observed', source: 'lockfile' })
    }
    if (this.config.frozenBundle && this.#bundleFormats !== null && format != null && inAttestedZone) {
      this.#assertAttestedFormat(this.#bundleFormats, file, format, { what: 'observed', source: 'frozen bundle' })
    }

    // Catch a format flip on already-attested bytes here; at write()'s #mergedFormats it would
    // surface only as a bare `Conflict`.
    if (this.config.writeLockfile && this.#lockFormats !== null && format != null && inAttestedZone) {
      const attested = this.#lockFormats.get(file)
      // A 'stat:*' baseline is not a flip: real content this run UPGRADES the record (#mergedFormats).
      assert.ok(attested === undefined || attested === format || isStatFormat(attested),
        `format flip for ${file}: lockfile attests '${attested}', observed '${format}' (bytes unchanged) -- re-run with --lock=replace to re-attest`)
    }

    if (!Object.hasOwn(module.files, rel)) module.files[rel] = integrity
    assert.equal(module.files[rel], integrity)

    if (this.config.bundle) {
      if (asResource) noupsert(this.resources, file, buf.toString(format === 'resource:base64' ? 'base64' : 'utf8'))
      else noupsert(this.sources, file, typeof source === 'string' ? source : source.toString())
    }

    if (format) noupsert(this.formats, file, format)

    this.#recordExecutable(file, absolute)
  }

  // Observe `file` on disk and record or refute its execute bit; disk wins over whatever a lockfile/
  // bundle seeded, but only a real observation refutes (`undefined` and Windows mean "unknowable").
  // A record touches only this State; a REFUTATION must reach the whole family, else
  // #mergedExecutable's union resurrects the bit from a sibling's seeded entry.
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

  // Public so #recordExecutable reaches them across the class brand (duplicate stasis-core copies).
  sidecars() {
    return this.#sidecars
  }

  // Record an `fs.readFileSync` capture (--fs). classifyFormat routes the bytes: a concrete format
  // is code, null defers to the loader, and undefined (or a binary plist, whose bytes can't be the
  // UTF-8 code its format implies) is a resource IFF allowlisted, else THROW -- an undeclared file
  // would widen the attested set.
  addFsFile(url, source) {
    assert.ok(Buffer.isBuffer(source), 'addFsFile requires a Buffer source')
    const path = fileURLToPath(url)
    const format = classifyFormat(path, { content: source })
    if (format !== undefined && !isBinaryPlist(path, source)) {
      this.addFile(url, { source, format: format ?? undefined, inferFormat: false, fsRead: true })
    } else if (this.config.resources.has(pathExt(path) || basename(path).toLowerCase())) {
      this.addFile(url, { source, resource: true, fsRead: true })
    } else {
      throw new Error(`addFsFile: ${path} is neither code nor a declared resource; add its extension or filename to the resources allowlist or stop reading it`)
    }
  }

  // Record an `fs.readdirSync` capture: the listing is SORTED for reproducibility and stored as a
  // 'directory'-format payload.
  addFsDir(url, names) {
    assert.ok(Array.isArray(names) && names.every((n) => typeof n === 'string'),
      'addFsDir requires an array of string names')
    const { file, dir, module } = this.#locateModule(url, { directory: true })
    // As in addFile: a real record supersedes a payload-free stat record.
    if (isStatFormat(this.formats.get(file))) this.formats.delete(file)
    const content = JSON.stringify(names.toSorted())
    const format = 'directory'
    const integrity = sha512integrity(content)
    noupsert(this.hashes, file, integrity)
    if (this.config.childProcess) this.#observed.add(file) // only a child's shardSnapshot reads it; skip when the channel is off
    if (this.config.bundle) this.#recordReason('run', file)
    const rel = relative(dir, file)
    assert.ok(!relativeEscapes(rel))

    const inAttestedZone = hasNodeModulesSegment(dir) || this.config.full
    if (this.config.frozen && inAttestedZone) {
      assert.ok(Object.hasOwn(module.files, rel), `Directory not attested by the frozen lockfile: ${file}`)
    }
    if (this.config.frozenBundle && inAttestedZone) {
      assert.ok(this.#bundleResources?.has(file), `Directory not attested by the frozen bundle: ${file}`)
    }
    if (this.config.frozen && this.#lockFormats !== null && inAttestedZone) {
      this.#assertAttestedFormat(this.#lockFormats, file, format, { what: 'observed', source: 'lockfile' })
    }
    if (this.config.frozenBundle && this.#bundleFormats !== null && inAttestedZone) {
      this.#assertAttestedFormat(this.#bundleFormats, file, format, { what: 'observed', source: 'frozen bundle' })
    }

    if (!Object.hasOwn(module.files, rel)) module.files[rel] = integrity
    assert.equal(module.files[rel], integrity)
    if (this.config.bundle) noupsert(this.resources, file, content)
    noupsert(this.formats, file, format)
    // A listing is never executable (both artifacts' parsers refuse one in `executable`), so drop
    // any bit a prior content record left on this path.
    this.executable.delete(file)
  }

  // Record a stat capture as a PAYLOAD-FREE record (`formats[file] = 'stat:file'|'stat:directory'`,
  // no bytes/hash/module-files entry), so getFsStat answers isFile()/isDirectory() at load. Skipped
  // when a content record already exists; upsertFormat lets a real format win, a kind flip is fatal.
  addFsStat(url, kind) {
    assert.ok(kind === 'file' || kind === 'directory', `addFsStat: unsupported kind '${kind}'`)
    const file = this.#canonicalFile(url)
    if (this.hashes.has(file) || this.sources.has(file) || this.resources.has(file)) return
    upsertFormat(this.formats, file, `stat:${kind}`)
    // Only forward when a stat record actually landed -- upsertFormat may have yielded to a real
    // format, and forwarding THAT would ship an entry mergeShard's stat replay ignores.
    if (this.config.childProcess && isStatFormat(this.formats.get(file))) this.#observed.add(file)
  }

  // Serve an `fs.readFileSync` from the bundle: raw bytes, or undefined when uncaptured (the hook
  // falls back to disk) or a captured directory. Served by presence, not format.
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

  // Every ancestor directory implied by recorded keys; built once.
  #impliedDirs() {
    if (this.#impliedDirIndex) return this.#impliedDirIndex
    const dirs = new Set(['.'])
    const add = (key) => {
      const parts = key.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
    for (const key of this.sources.keys()) add(key)
    for (const key of this.resources.keys()) add(key)
    // Stat records prove existence too, so they imply their ancestor dirs.
    for (const [key, format] of this.formats) if (isStatFormat(format)) add(key)
    this.#impliedDirIndex = dirs
    return dirs
  }

  // Classify a captured path for the stat shim: 'directory', 'file', or undefined (uncaptured -> the
  // shim falls back to disk). Order matters: 'directory' first, content before stat records, implied
  // dirs last. NB: 'file' means "recorded", NOT "bytes serveable" (use hasFsFileContent).
  getFsStat(url) {
    const file = this.#canonicalFileMaybe(url)
    if (file === undefined) return undefined
    const format = this.formats.get(file)
    if (format === 'directory') return 'directory'
    if (this.sources.has(file) || this.resources.has(file) || format === 'stat:file') return 'file'
    if (format === 'stat:directory' || this.#impliedDirs().has(file)) return 'directory'
    return undefined
  }

  // True when the bundle carries actual BYTE content for `url` (not a directory/stat-only record).
  hasFsFileContent(url) {
    const file = this.#canonicalFileMaybe(url)
    return file !== undefined && this.formats.get(file) !== 'directory' && (this.sources.has(file) || this.resources.has(file))
  }

  // --fs <-> bundler-plugin coordination: CAPTURE skips a read a write-mode sidecar already attests,
  // else --fs re-records the bundler's whole module graph into the main bundle and defeats the split.
  attestedBySidecar(url) {
    // hasFsFileContent, not getFsStat: over-skipping on an implied dir or stat-only record would
    // leave a real read unattested.
    for (const s of this.#sidecars) if (s.hasFsFileContent(url)) return true
    return false
  }

  // getFs* over this State first, then its load-mode sidecars. Only #readSidecars -- write-mode
  // sidecars only capture.
  #fromFamily(method, url) {
    const own = this[method](url)
    if (own !== undefined) return own
    for (const s of this.#readSidecars) {
      const v = s[method](url)
      if (v !== undefined) return v
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
    // Wrap #canonicalFile so a URL escaping state.root gives a contextual error, not a bare assert.
    let file
    try { file = this.#canonicalFile(url) }
    catch (cause) { throw new Error(`stasis: file is outside the project root: ${url}`, { cause }) }
    const format = this.formats.get(file) // might be undefined e.g. for some bundlers
    // A missing entry throws: this single getFile call is the fail-closed gate.
    let source
    if (Bundle.isResourceFormat(format)) {
      source = this.resources.get(file)
      if (source === undefined) throw new Error(`stasis: file not attested in bundle: ${url}`)
      if (format === 'resource:base64') source = Buffer.from(source, 'base64')
    } else {
      source = this.sources.get(file)
      if (source === undefined) {
        // Stat-record case: the bundle knows the path but not its bytes -- "not attested" would misdiagnose it.
        if (isStatFormat(format)) {
          throw new Error(
            `stasis: only a payload-free stat record ('${format}') is attested for ${url} -- ` +
            `the capture stat'd this path but never read or imported it, so the bundle has no bytes to serve`
          )
        }
        throw new Error(`stasis: file not attested in bundle: ${url}`)
      }
    }
    // Without a lockfile the bundle is self-attesting -- verifying its hash against its own bytes is a tautology.
    if (this.config.useLockfile) assert.equal(this.hashes.get(file), sha512integrity(source))
    return { source, format }
  }

  // The recorded LOADER format, or undefined. Masks 'stat:*' (existence, not how bytes parse) so a
  // stat'd require.resolve target isn't refused by the resolve hook's format gate; getFile does NOT mask.
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

  // An already-resolved ABSOLUTE require()/import() target as the specifier would be a
  // machine-specific lockfile key, so renormalize in-root ones against the IMPORTING FILE's dir.
  // Must be applied identically in addImport and getImport so keys written and queried agree.
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
    // Capture Node's require-condition set on the first require()-context edge (see #requireConditions).
    if (this.#requireConditions === null && Array.isArray(conditions) &&
        conditions.includes('require') && !conditions.includes('import')) {
      this.#requireConditions = conditions
    }
    assert.ok(parentURL, 'addImport requires a parent (entries go through addFile)')
    const parent = this.#canonicalFile(parentURL)
    const file = this.#canonicalFile(url)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)

    // Frozen runs verify disk resolutions against the lockfile: hashes can't see a redirect to
    // another attested file. Unknown edges are tolerated only for workspace parents in nm scope.
    const tolerateUnknown = !this.config.full && !hasNodeModulesSegment(parent)
    if (this.config.frozen && this.#lockImports !== null) {
      this.#assertAttestedResolution(this.#lockImports, key, parent, specifier, file, { what: 'observed', source: 'lockfile', tolerateUnknown })
    }
    if (this.config.frozenBundle && this.#bundleImports !== null) {
      this.#assertAttestedResolution(this.#bundleImports, key, parent, specifier, file, { what: 'observed', source: 'frozen bundle', tolerateUnknown })
    }

    noupsert(nestedMap(nestedMap(this.imports, key), parent), specifier, file)
    // upsertFormat, not noupsert: a real format must replace a weak 'stat:*' record from an --fs stat.
    if (format) upsertFormat(this.formats, file, format)
  }

  getImport(parentURL, specifier, { conditions = '*', importAttributes } = {}) {
    if (conditions !== '*') assert.ok(Array.isArray(conditions))
    assert.ok(parentURL, 'getImport requires a parent') // matches addImport; #canonicalSpecifier needs it
    const parent = this.#canonicalFile(parentURL)
    specifier = this.#canonicalSpecifier(parentURL, specifier)
    const key = this.#conditionsKey(conditions, importAttributes)
    // Static bundles store edges under '*' (Node's condition set is unpredictable); the runtime
    // loader records precise conditions, so the specific lookup wins.
    let file = this.imports.get(key)?.get(parent)?.get(specifier)
    if (file === undefined && key !== '*') file = this.imports.get('*')?.get(parent)?.get(specifier)
    if (file === undefined) {
      // The edge may be recorded under a DIFFERENT conditions bucket -- resolveBundled scans every bucket.
      if (this.config.loadBundle) {
        const abs = this.resolveBundled(parentURL, specifier)
        if (abs !== undefined) return { url: pathToFileURL(abs).toString(), format: this.#loaderFormat(relative(this.root, abs)) }
      }
      // Node's ERR_MODULE_NOT_FOUND shape, not a bare assert: dynamic-import callers guard on that
      // code, which ERR_ASSERTION escapes.
      throw Object.assign(new Error(`Cannot find module '${specifier}' imported from ${parent}`), { code: 'ERR_MODULE_NOT_FOUND' })
    }
    // A --metro per-platform edge is a { platform: file } Map; plain bundle=load has no platform
    // context to pick one, so fail closed rather than feed a Map where a path is expected.
    if (typeof file !== 'string') {
      throw Object.assign(
        new Error(`Resolution of '${specifier}' from ${parent} is platform-specific (a --metro multi-platform bundle); it can't be loaded by plain node, build a single-platform bundle to load`),
        { code: 'ERR_STASIS_PLATFORM_SPECIFIC' })
    }
    return { url: pathToFileURL(resolve(this.root, file)).toString(), format: this.#loaderFormat(file) }
  }

  // Resolve a CJS require() target to a bundled absolute path, or undefined to defer to Node (the
  // hooks.js CJS shim needs this: registerHooks can't intercept Module._resolveFilename). Matches
  // under ANY conditions bucket, since native require gives none; divergent buckets -> defer.
  resolveBundled(parentURL, specifier) {
    const parent = this.#canonicalFileMaybe(parentURL)
    if (parent === undefined) return undefined
    const spec = this.#canonicalSpecifier(parentURL, specifier)
    const matches = new Set()
    for (const [, byParent] of this.imports) {
      const file = byParent.get(parent)?.get(spec)
      if (file !== undefined) matches.add(file)
    }
    if (matches.size !== 1) return undefined
    const [only] = matches
    // Per-platform { platform: file } Map (--metro) has no single path: defer to native, not resolve()'s TypeError.
    return typeof only === 'string' ? resolve(this.root, only) : undefined
  }

  // Union of lockfile-attested and live resolutions, so a partial lock=add run extends without
  // dropping edges. Conflicting targets are fatal (add semantics).
  #mergedImports() {
    const merged = new Map()
    const mergeIn = (imports) => {
      for (const [conditions, byParent] of imports) {
        const mergedParents = nestedMap(merged, conditions)
        for (const [parent, specifiers] of byParent) {
          const mergedSpecifiers = nestedMap(mergedParents, parent)
          for (const [specifier, file] of specifiers) noupsert(mergedSpecifiers, specifier, file)
        }
      }
    }
    if (this.#lockImports) mergeIn(this.#lockImports)
    mergeIn(this.imports)
    // Write-mode sidecars too, so the lockfile attests their edges for frozen verify.
    for (const sidecar of this.#sidecars) mergeIn(sidecar.imports)
    return merged
  }

  // Union of lockfile-attested and observed formats (+ sidecars'), append-only like #mergedImports,
  // except that a weak 'stat:*' is UPGRADED by real content; two real formats stay fatal.
  #mergedFormats() {
    const merged = new Map(this.#lockFormats ?? [])
    for (const [file, format] of this.formats) upsertFormat(merged, file, format)
    for (const sidecar of this.#sidecars) {
      for (const [file, format] of sidecar.formats) upsertFormat(merged, file, format)
    }
    // A payload-free 'stat:*' must never survive on a file that now carries a content hash: a stat
    // entry re-seeded from #lockFormats is beyond addFile's delete, and an ambiguous .js/.ts yields
    // no real format to override it above.
    for (const [file, format] of merged) {
      if (isStatFormat(format) && this.hashes.has(file)) merged.delete(file)
    }
    return merged
  }

  // The executable list the LOCKFILE attests (this State's + write-mode sidecars'), narrowed by
  // scope to the keys it will SERIALIZE: a non-full-scope lockfile drops its workspace buckets, and
  // an entry for a dropped bucket writes a lockfile Lockfile.parse then refuses.
  #mergedExecutable(formats) {
    const all = new Set(this.executable)
    for (const sidecar of this.#sidecars) for (const file of sidecar.executable) all.add(file)
    return narrowExecutable(all, { modules: this.modules, formats, scope: this.config.scope })
  }

  // The executable list ONE bundle declares, narrowed to that half's own buckets and formats.
  #bundleExecutable(modules, formats) {
    return narrowExecutable(this.executable, { modules, formats, scope: this.config.scope })
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

  // Pair each module's recorded file list with content from perFile, dropping modules with none.
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

  // Files fs-READ after this point that a plugin also bundles are the plugin's, not run's (see
  // #bundleReason). Public, cross-copy.
  markPluginAttached() {
    this.#pluginAttached = true
  }

  #recordReason(reason, file) {
    let set = this.#reasonFiles.get(reason)
    if (set === undefined) this.#reasonFiles.set(reason, set = new Set())
    set.add(file)
  }

  // Seed `reason` from an absorbed on-disk bundle so a bundle=add re-run preserves other consumers'
  // attribution. Called from every absorb site, including the sidecar's.
  #seedReasonFromBundle(bundle) {
    if (!this.config.writeBundle || bundle.reason === undefined) return
    for (const [consumer, files] of Object.entries(bundle.reason)) {
      for (const file of files) this.#recordReason(consumer, file)
    }
  }

  // The bundle's informational `reason` map, restricted to `bundledFiles`; only when >1 consumer
  // contributed. Never attested.
  #bundleReason(bundledFiles) {
    const inBundle = bundledFiles instanceof Set ? bundledFiles : new Set(bundledFiles)
    // A file run merely fs-READ post-plugin that a plugin also bundles is the plugin's, not run's.
    const pluginFiles = new Set()
    for (const [who, recorded] of this.#reasonFiles) {
      if (who !== 'run') for (const file of recorded) pluginFiles.add(file)
    }
    const runOverclaims = (file) =>
      this.#fsReadPostPlugin.has(file) && !this.#runImported.has(file) && pluginFiles.has(file)

    const reason = {}
    let consumers = 0
    // Sort keys and file lists: the JSON must be byte-reproducible regardless of record order, else
    // #emitBundle's compare-and-skip sees spurious diffs.
    for (const who of [...this.#reasonFiles.keys()].toSorted()) {
      const files = [...this.#reasonFiles.get(who)].filter((file) => inBundle.has(file) && !(who === 'run' && runOverclaims(file)))
      if (files.length > 0) {
        reason[who] = files.toSorted(sortPaths)
        consumers += 1
      }
    }
    return consumers > 1 ? reason : undefined
  }

  // The formats a bundle declares: `this.formats`, minus a 'stat:*' the run's unified attestation
  // upgraded to a real format (else the bundle fails its lockfile cross-check at load).
  #formatsForBundle() {
    if (this.#sidecars.size === 0) return this.formats
    const merged = this.#mergedFormats()
    let out = null // copy-on-write: clone only when an entry must be dropped
    for (const [file, format] of this.formats) {
      if (isStatFormat(format) && merged.get(file) !== format) {
        out ??= new Map(this.formats)
        out.delete(file)
      }
    }
    return out ?? this.formats
  }

  #absorbRepo(half, bundle) {
    this.#absorbedRepos.set(half, this.#absorbedRepos.has(half) ? mergeRepo(this.#absorbedRepos.get(half), bundle.repo) : bundle.repo)
  }

  get #detectedRepo() {
    return (this.#detectedRepoCache ??= { value: detectRepo(this.root, this.#host) }).value
  }

  // `repo` to write for a half: detected, merged with that half's absorbed one when adding to it.
  #repoFor(half) {
    if (!this.#absorbedRepos.has(half)) return this.#detectedRepo
    const absorbed = this.#absorbedRepos.get(half)
    return absorbed && mergeRepo(absorbed, this.#detectedRepo)
  }

  // One bundle artifact over `contents` (file -> stored content) with the `formats` it declares;
  // the code side carries entries/imports, the resources half none.
  #bundle(half, contents, formats, { entries = this.entries, imports = this.imports } = {}) {
    const modules = this.#bundleModules(contents)
    return new Bundle({
      config: this.config.values,
      entries,
      modules,
      formats,
      imports,
      executable: this.#bundleExecutable(modules, formats),
      reason: this.#bundleReason(contents.keys()),
      repo: this.#repoFor(half),
    })
  }

  get sourceBundle() {
    // One bundle holds code + resources, with `formats` tagging which; the key sets must be
    // disjoint, asserted so an overlap fails locally rather than silently.
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

  // Split-bundle counterparts to sourceBundle/sourceData: the code half owns entries/imports + code
  // formats (stat records too: they aren't resource formats, so the resources half's shape check
  // would reject them), the resources half owns resource formats + bytes. Both declare per-dir
  // module identity so each file verifies alone.
  get codeBundle() {
    const codeFormats = new Map([...this.#formatsForBundle()].filter(([, format]) => !Bundle.isResourceFormat(format)))
    return this.#bundle('code', this.sources, codeFormats)
  }

  get resourcesBundle() {
    const resourceFormats = new Map([...this.formats].filter(([, format]) => Bundle.isResourceFormat(format)))
    // No entries/imports (Bundle.parse waives the entries requirement when no code).
    return this.#bundle('resources', this.resources, resourceFormats, { entries: new Set(), imports: new Map() })
  }

  // Record a native resolution verbatim (last-write-wins per parent+specifier);
  // #backfillObservedResolutions decides at write() which to add.
  observeResolution(parentURL, specifier, resolvedURL) {
    nestedMap(this.#observedResolutions, parentURL).set(specifier, resolvedURL)
  }

  // Record that a require() executed `url` (from the Module._load shim). Out-of-root targets are
  // skipped like #backfillObservedResolutions' -- the live hooks correctly ignore them too.
  observeExecution(url) {
    const file = this.#canonicalFileMaybe(url)
    if (file !== undefined) this.#executedFiles.add(file)
  }

  // Whether the bundle carries source bytes for `url` (the hooks' bundle-bypass reconciliation).
  isBundledSource(url) {
    const file = this.#canonicalFileMaybe(url)
    return file !== undefined && this.sources.has(file)
  }

  // Attest every executed-but-never-captured file from disk. A resolve-only edge stays byte-less
  // by design (see #backfillBeforeWrite), but an EXECUTED file the load hook never saw is a hole:
  // leaving it silent would ship an artifact that misses code the run provably evaluated, and a
  // frozen replay would never verify it. addFile re-checks bytes against the lockfile/bundle in
  // frozen modes, so tampering still fails the run -- at write time, but loudly.
  #backfillExecutedFiles() {
    for (const file of this.#executedFiles) {
      // "Captured this run", NOT this.hashes: a lockfile-seeded hash must still be VERIFIED
      // against disk here when the run executed the file without the load hook observing it.
      if (this.#filesCapturedThisRun.has(file)) continue
      // A require()d native addon never passes the load hook and is deliberately not captured
      // (non-deterministic across installs, like the rest of NATIVE_ARTIFACT_EXTS).
      if (isNativeArtifact(file)) continue
      const url = pathToFileURL(resolve(this.root, file)).toString()
      if (!this.config.full && !this.inNodeModules(url)) continue
      this.addFile(url, { reason: 'run' })
    }
  }

  // Backfill edges the live resolve hook never observed (require.resolve()/native CJS require()).
  // The resolution is attested but its bytes are NOT seeded -- that would widen trust to everything
  // that merely resolves. Skips out-of-scope targets and dedups across all condition buckets.
  #backfillObservedResolutions() {
    for (const [parentURL, specs] of this.#observedResolutions) {
      const parent = this.#canonicalFileMaybe(parentURL)
      if (parent === undefined) continue
      for (const [specifier, resolvedURL] of specs) {
        const file = this.#canonicalFileMaybe(resolvedURL)
        if (file === undefined) continue
        const bundled = this.sources.has(file) || this.resources.has(file)
        if (!bundled && !this.config.full && !this.inNodeModules(resolvedURL)) continue
        const spec = this.#canonicalSpecifier(parentURL, specifier)
        const recorded = this.imports.values().some((byParent) => byParent.get(parent)?.get(spec) !== undefined)
        if (!recorded) this.addImport(parentURL, specifier, resolvedURL, { conditions: this.#requireConditions ?? '*' })
      }
    }
  }

  // Add every bundled module's `<dir>/package.json` (config.packageJSON) even if the run never
  // reached it, so a load/prune can read each dependency's manifest. The skip keys on bundle
  // membership, NOT this.hashes (which also holds lockfile-absorbed entries and is shared by
  // reference across sidecars).
  includePackageJson() {
    // Gather first: addFile mutates this.modules, so don't addFile while iterating it.
    const realRoot = this.#host.realpath(this.root)
    const toAdd = []
    for (const [dir, module] of this.modules) {
      const rel = moduleFileKey(dir, 'package.json')
      if (this.sources.has(rel) || this.resources.has(rel)) continue // already in this bundle
      const buf = readModuleManifest({ baseDir: this.root, realBase: realRoot, rel, host: this.#host })
      if (!buf) continue
      // Only carry a manifest whose on-disk identity still matches the bundled bucket: under
      // bundle=add a dep may have drifted, and addFile -> #locateModule would crash on it.
      let pkg
      try { pkg = JSON.parse(buf.toString()) } catch { continue } // malformed manifest for an untouched bucket: skip
      if (pkg?.name !== module.name || pkg?.version !== module.version) continue
      // The manifest rides along BECAUSE some consumer bundled the bucket, so it inherits every
      // consumer that recorded a file of the bucket -- nothing observed the manifest itself, but an
      // unattributed file can't be sorted by provenance downstream. Derived BEFORE the adds below,
      // so one fold's manifest can't count as another bucket's consumer evidence.
      const files = Object.keys(module.files)
      const consumers = [...this.#reasonFiles].filter(([, recorded]) => files.some((f) => recorded.has(moduleFileKey(dir, f)))).map(([who]) => who)
      toAdd.push({ rel, buf, consumers })
    }
    for (const { rel, buf, consumers } of toAdd) {
      this.addFile(pathToFileURL(resolve(this.root, rel)).toString(), { source: buf, reason: null })
      for (const who of consumers) this.#recordReason(who, rel)
    }
  }

  write() {
    // BEFORE the stasis-core BFS: a resolve-only edge to a stasis-core submodule is added only here,
    // and the BFS must see it to seed the file's bytes, else the bundle ships a dangling edge.
    this.#backfillObservedResolutions()
    this.#backfillExecutedFiles()
    this.#backfillBeforeWrite()
    // AFTER the backfills, so buckets they create are covered too.
    if (this.config.writeBundle && this.config.packageJSON) this.includePackageJson()

    // Sidecars never write the lockfile (parent owns it); they only emit their bundle.
    if (this.config.writeLockfile && !this.#parent) {
      const lockText = this.lockData
      if (lockText !== this.#lastLockData) {
        const lockPath = this.config.lockFile || join(this.root, FILE_LOCK)
        mkdirSync(dirname(lockPath), { recursive: true })
        writeFileSync(lockPath, lockText)
        this.#lastLockData = lockText
      }
    }
    if (this.config.writeBundle) {
      const sourcesPath = this.config.bundleFile || join(this.root, FILE_CODE)
      if (this.config.resourcesBundleFile) {
        // hasContent gates each half so an empty one is dropped under bundle=replace.
        this.#lastCodeBundle = this.#emitBundle(sourcesPath, this.sources.size > 0, this.#lastCodeBundle, () => this.codeBundle.serialize())
        this.#lastResourcesBundle = this.#emitBundle(this.config.resourcesBundleFile, this.resources.size > 0, this.#lastResourcesBundle, () => this.resourcesBundle.serialize())
      } else {
        this.#lastUnifiedBundle = this.#emitBundle(sourcesPath, this.sources.size > 0 || this.resources.size > 0, this.#lastUnifiedBundle, () => this.sourceData)
      }
    }
  }

  // Snapshot of what THIS process observed, for a forked child to hand back to the root. Content is
  // omitted -- the root re-reads bytes from disk.
  shardSnapshot() {
    this.#backfillObservedResolutions()
    this.#backfillExecutedFiles()
    this.#backfillBeforeWrite()
    // Only what THIS process observed, never the seeded baseline (shard-size bloat). Entries are
    // dropped: a child's "entry" is its fork target, not a root's.
    const files = []
    const formats = new Map()
    for (const file of this.#observed) {
      const format = this.formats.get(file)
      if (format !== undefined) formats.set(file, format)
      if (this.hashes.has(file)) files.push(file)
    }
    // Only edges whose PARENT was observed, dropping the bundle-seeded ones the root already attests.
    const imports = new Map()
    for (const [conditions, byParent] of this.imports) {
      for (const parent of this.#observed) {
        const specs = byParent.get(parent)
        if (specs !== undefined) nestedMap(imports, conditions).set(parent, specs)
      }
    }
    return serializeShard({ scope: this.config.scope, files, formats, imports })
  }

  // Merge a child's shardSnapshot() as if this process read those files itself: replay each file
  // (re-reading bytes/listings from disk) and each edge. Best-effort -- a gone/out-of-scope record is
  // skipped rather than aborting the merge.
  mergeShard(shardText) {
    const shard = parseShard(shardText)
    // Defense-in-depth: cross-scope is signature-rejected upstream, but a mismatch here means a
    // malformed/foreign shard -- refuse.
    assert.equal(shard.scope, this.config.scope, `shard scope "${shard.scope}" != root scope "${this.config.scope}"`)
    // An in-root shard KEY may resolve (through a symlink) OUTSIDE the root on THIS disk, so every
    // replay re-checks real-path containment -- the same boundary fs.js enforces on live --fs reads.
    let realRoot
    const realContained = (absolute) => {
      if (realRoot === undefined) {
        try { realRoot = realpathSync(this.root) } catch { realRoot = this.root }
      }
      let real
      try { real = realpathSync(absolute) } catch { return false }
      return isPathWithin(realRoot, real)
    }
    // Files first, then edges. Merged files are NEVER marked entries -- a child's "entry" is its
    // fork-target main, not a root entry.
    for (const file of shard.files) {
      const absolute = resolve(this.root, file)
      // Skip a key whose on-disk path escapes the root through a symlink.
      if (!realContained(absolute)) continue
      // ABOVE the already-attested fast path below: a child that re-read a file and found no bit
      // refutes it by OMISSION, so every file the shard RECORDS needs an observation. Re-derived
      // from THIS process's disk, so the shard cannot inject a forged bit.
      this.#recordExecutable(file, absolute)
      // Skip a file the root already attests (the byte re-read dominates merge cost), EXCEPT to
      // carry a concrete format the root LACKS, else a later frozen run rejects the unattested format.
      const format = shard.formats.get(file)
      if (this.hashes.has(file) && (format === undefined || (this.formats.get(file) ?? this.#lockFormats?.get(file)) !== undefined)) continue
      const url = pathToFileURL(absolute).toString()
      try {
        if (format === 'directory') {
          // Range-check FIRST so a child-forged `..` key can't make us list it.
          if (!isPathWithin(this.root, absolute)) continue
          this.addFsDir(url, readdirSync(absolute))
        } else if (format === 'resource' || format === 'resource:base64') {
          // Let addFile re-derive the exact resource tag from the re-read bytes rather than trusting
          // the shard's and risking a mismatch.
          this.addFile(url, { resource: true })
        } else if (format === undefined) {
          // No format recorded (an fs-READ .js/.ts): inferFormat:false so we don't bake in the
          // commonjs default and collide with the `module` the loader records if it's later imported.
          this.addFile(url, { inferFormat: false })
        } else {
          // Carry the child's format, else a child-only ESM .js under a no-`type` package re-defaults
          // to commonjs and a frozen run rejects the mismatch.
          this.addFile(url, { format })
        }
      } catch {
        // Gone/unreadable, or addFile-rejected (out of scope): skip, like the edge replay below.
      }
    }
    // Stat records live ONLY in the shard's formats map, so replay each here, re-deriving the kind
    // from DISK (a shard can't inject a forged kind). Range-check BEFORE touching disk.
    for (const [file, format] of shard.formats) {
      if (!isStatFormat(format)) continue
      const absolute = resolve(this.root, file)
      if (!isPathWithin(this.root, absolute)) continue
      try {
        // statSync, NOT lstatSync: the child's capture followed symlinks, so this reproduces the kind
        // a legitimate shard carries where lstatSync would report the link and drop it.
        const stats = statSync(absolute)
        const kind = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : null
        // statSync follows links: a symlink pointing OUT must not attest an external kind under an
        // in-root key.
        if (kind === null || !realContained(absolute)) continue
        this.addFsStat(pathToFileURL(absolute).toString(), kind)
      } catch {
        // Gone/dangling, or a kind conflict with the root's capture: skip.
      }
    }
    for (const [conditions, byParent] of shard.imports) {
      // Reverse #conditionsKey: '*', else a ', '-joined list with an optional ' (with: {json})'
      // suffix -- parse it so attributed edges merge under the child's key.
      let condStr = conditions
      let importAttributes
      const withAt = conditions.indexOf(' (with: ')
      if (withAt !== -1) {
        condStr = conditions.slice(0, withAt)
        try { importAttributes = JSON.parse(conditions.slice(withAt + ' (with: '.length, -1)) } catch { /* leave undefined */ }
      }
      const cond = condStr === '*' ? '*' : condStr.split(', ')
      for (const [parent, specs] of byParent) {
        const parentURL = pathToFileURL(resolve(this.root, parent)).toString()
        for (const [specifier, file] of specs) {
          const url = pathToFileURL(resolve(this.root, file)).toString()
          // Same best-effort stance as addFile above.
          try { this.addImport(parentURL, specifier, url, { conditions: cond, importAttributes }) } catch { /* skipped */ }
        }
      }
    }
  }

  // Emit one bundle artifact, returning its new "last serialized" cache. Empty under bundle=replace
  // DELETES the file (a replace run is authoritative); unchanged text skips brotli + writeFileSync.
  #emitBundle(path, hasContent, lastText, serialize) {
    if (!hasContent && this.config.replaceBundle) {
      rmSync(path, { force: true })
      return null
    }
    const text = serialize()
    if (text !== lastText) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, brotliCompressSync(text, brotliOptions(this.config.brotliQuality)))
    }
    return text
  }

  get parent() {
    return this.#parent
  }

  // Capture stasis-core's own files + internal edges the live hooks missed: for a preload-cached
  // module the resolve hook records the edge but the load hook never fires. The BFS below is scoped
  // to the stasis-core src shape.
  #backfillBeforeWrite() {
    const missing = this.#collectMissingImportedFiles()
    if (missing.size === 0) return

    const isStasisCoreFile = (file) => STASIS_CORE_FILE_RE.test(`/${file}`)

    // Only stasis-core files are reconstructed; everything else stays a resolution attested without
    // bytes (the load-time getFile gate, not this pass, enforces the trust boundary).
    const stasisCoreMissing = [...missing].filter((file) => isStasisCoreFile(file))
    if (stasisCoreMissing.length === 0) return

    const preloadRel = this.#preloadRoot ? relative(this.root, this.#preloadRoot) : null
    assert.ok(preloadRel !== null && !relativeEscapes(preloadRel),
      `state.write() has imports referencing un-captured stasis-core files but no usable preloadRoot ` +
      `(preloadRoot=${this.#preloadRoot ?? 'unset'}). The live load hook missed an in-scope target -- ` +
      `investigate rather than silently patch: ${stasisCoreMissing.slice(0, 3).join(', ')}`)

    const PRELOAD_CONDITIONS = ['node', 'import', 'module-sync', 'node-addons']
    const stasisAddFile = (file) => {
      assert.ok(isStasisCoreFile(file),
        `state.write() backfill refused: '${file}' is not a stasis-core source file ` +
        `(expected '.../@exodus/stasis-core/src/<name>.js')`)
      // reason 'run': Node evaluated these before registerHooks could observe it (that blindness is
      // why this backfill exists), so they're run-loaded modules like any other. A consumer-less
      // record can't be sorted by provenance downstream (app code vs toolchain).
      this.addFile(pathToFileURL(resolve(this.root, file)).toString(), { reason: 'run' })
    }

    // Seeded from the missing files + every stasis-core file already in sources, to walk their
    // transitive imports too.
    const queue = [...stasisCoreMissing, ...[...this.sources.keys()].filter(isStasisCoreFile)]
    const processed = new Set()
    while (queue.length > 0) {
      const file = queue.shift()
      if (processed.has(file)) continue
      processed.add(file)
      if (!this.sources.has(file) && !this.resources.has(file)) stasisAddFile(file)
      const source = this.sources.get(file)
      if (typeof source !== 'string') continue
      const baseURL = pathToFileURL(resolve(this.root, file)).toString()
      const recordEdge = (specifier) => {
        const targetURL = new URL(specifier, baseURL).toString()
        const targetAbsolute = fileURLToPath(targetURL)
        let targetFile
        try { targetFile = this.relative(targetAbsolute) } catch { return }
        if (!isStasisCoreFile(targetFile) || !existsSync(targetAbsolute)) return
        queue.push(targetFile)
        this.addImport(baseURL, specifier, targetURL, { conditions: PRELOAD_CONDITIONS })
      }
      // stasis-core's ESM import shape, tight enough to ignore JSDoc/template-literal false positives.
      for (const m of source.matchAll(/ from '(\.\/[a-zA-Z-]+\.c?js)'\n/g)) recordEdge(m[1])
      // The src/package.cjs version shim, matched exactly.
      for (const m of source.matchAll(/require\('(\.\.\/package\.json)'\)/g)) recordEdge(m[1])
    }
  }

  // Files referenced by this.imports but not captured, restricted to the in-scope set (out-of-scope
  // files are excluded -- the live hooks correctly skip them).
  #collectMissingImportedFiles() {
    const missing = new Set()
    for (const [, byParent] of this.imports) {
      for (const [, specifiers] of byParent) {
        for (const [, file] of specifiers) {
          if (typeof file !== 'string' || missing.has(file)) continue
          if (this.hashes.has(file) || this.sources.has(file) || this.resources.has(file)) continue
          const url = pathToFileURL(resolve(this.root, file)).toString()
          if (!this.config.full && !this.inNodeModules(url)) continue
          missing.add(file)
        }
      }
    }
    return missing
  }
}

// Backfillable stasis-core paths. Anchored against `/${file}` so a project-root file merely ending
// in `@exodus/stasis-core/...` isn't matched.
const STASIS_CORE_FILE_RE = /\/@exodus\/stasis-core\/(?:src\/[a-zA-Z-]+\.c?js|package\.json)$/
