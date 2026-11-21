import assert from 'node:assert/strict'

import { diskHost } from './host.js'
import { POLICY_KEYS, parsePolicy } from './policy.js'
import { canonicalizePath } from './state-util.js'
import { BUNDLE_MODES, CONFIG_FILE, extSetsEqual, FS_MODES, isBrotliQuality, LOCK_MODES, parseBrotliQuality, parseExtraOption, parseLockfilesOption, parseResourcesOption, SCOPES } from './util.js'

export const DEFAULT_LOCK = 'add'

// Strict, not truthy: a truthiness parse would read 'no'/'off' as *enabling* the toggle.
const envBool = (name, value) => {
  if (value === '' || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  throw new RangeError(`${name} must be ''/'0'/'false' or '1'/'true' (got '${value}')`)
}

const envList = (value) => value.split(',').map((s) => s.trim()).filter(Boolean)

// `lockFile` and `bundle` are flag/env-only; `extra`, `entries`, `define`, TREE_FLAGS and `lockfiles` are file-only.
// Config has a getter of each, `bundle`'s named bundleMode.
const OPTIONS = {
  scope: { env: 'EXODUS_STASIS_SCOPE', valid: SCOPES },
  lock: { env: 'EXODUS_STASIS_LOCK', valid: LOCK_MODES },
  // Exact lockfile path, bypassing `stasis.lock.json` discovery; bundler plugins can't set it.
  lockFile: { env: 'EXODUS_STASIS_LOCK_FILE', type: 'string' },
  bundle: { env: 'EXODUS_STASIS_BUNDLE', valid: BUNDLE_MODES },
  bundleFile: { env: 'EXODUS_STASIS_BUNDLE_FILE', type: 'string' },
  // When set, resources go to this file and code-only to bundleFile; bundle=load reads both.
  resourcesBundleFile: { env: 'EXODUS_STASIS_RESOURCES_BUNDLE_FILE', type: 'string' },
  debug: { env: 'EXODUS_STASIS_DEBUG', parse: envBool, type: 'boolean' },
  // A forked child writes a shard the root merges. Not attested.
  childProcess: { env: 'EXODUS_STASIS_CHILD_PROCESS', parse: envBool, type: 'boolean' },
  // Opt-in: bundle every bundled module's package.json even if the run never reached it. Not attested.
  packageJSON: { env: 'EXODUS_STASIS_PACKAGE_JSON', parse: envBool, type: 'boolean' },
  // Undefined leaves fs untouched. Not serialized.
  fs: { env: 'EXODUS_STASIS_FS', valid: FS_MODES },
  // undefined -> DEFAULT_BROTLI_QUALITY. Not serialized: output decompresses identically.
  brotliQuality: { env: 'EXODUS_STASIS_BROTLI_QUALITY', parse: parseBrotliQuality },
  // Compared as parsed sets, not raw strings: ['png','svg'] and 'svg,png' are the same allowlist.
  resources: { env: 'EXODUS_STASIS_RESOURCES', parse: (name, value) => parseResourcesOption('env', envList(value)), option: (value) => parseResourcesOption('options', value) },
}
const OPTION_KEYS = Object.keys(OPTIONS)

// Config's getters of what the options give: tests of the modes, and `values`, the config a lockfile or bundle records.
const DERIVED = {
  bundle: ({ bundle }) => bundle !== 'none' && bundle !== 'ignore',
  ignoreBundle: ({ bundle }) => bundle === 'ignore',
  writeBundle: ({ bundle }) => bundle === 'add' || bundle === 'replace',
  replaceBundle: ({ bundle }) => bundle === 'replace',
  loadBundle: ({ bundle }) => bundle === 'load',
  // bundle=frozen: loaded, never rewritten, and disk is checked against it (load serves bytes instead).
  frozenBundle: ({ bundle }) => bundle === 'frozen',
  full: ({ scope }) => scope === 'full',
  frozen: ({ lock }) => lock === 'frozen',
  useLockfile: ({ lock }) => lock !== 'none' && lock !== 'ignore',
  ignoreLockfile: ({ lock }) => lock === 'ignore',
  writeLockfile: ({ lock }) => lock === 'add' || lock === 'replace',
  replaceLockfile: ({ lock }) => lock === 'replace',
  values: ({ scope }) => ({ scope }),
}
const TREE_FLAGS = ['installDevDependencies', 'lazyDependencies', 'generatePrisma']
const CONFIG_FILE_KEYS = [...OPTION_KEYS.filter((key) => key !== 'lockFile' && key !== 'bundle'), 'extra', 'entries', 'define', ...TREE_FLAGS, 'lockfiles', ...POLICY_KEYS]
// The one mode a stasis.config.json can pin: a run that writes, loads or ignores is given its modes explicitly.
const CONFIG_FILE_LOCK = 'frozen'

export const assertKnownKeys = (keys, known, what) => {
  const unknown = keys.filter((key) => !known.includes(key))
  assert.equal(unknown.length, 0, `Unknown ${what} options: ${unknown.join(', ')}`)
}

// Plugins validate their options with it too, without constructing a Config (which has side effects).
export function assertOption(key, value) {
  const { valid, type } = OPTIONS[key]
  if (valid) assert.ok(valid.has(value), `Invalid ${key}: ${value}`)
  else if (type) assert.equal(typeof value, type, `${key} must be a ${type}`)
}

const assertSame = (key, actual, expected, message) => {
  if (key === 'resources') assert.ok(extSetsEqual(actual, expected), message)
  else assert.equal(actual, expected)
}

export class Config {
  #env
  #host
  #explicit
  #ownLock
  #opts

  // `ownLock`: a build's, which takes no lock mode or lock file of EXODUS_STASIS_LOCK(_FILE) or stasis.config.json.
  constructor(options = {}) {
    const { env = process.env, host = diskHost, ownLock = false, ...rest } = options
    assertKnownKeys(Object.keys(rest), OPTION_KEYS, 'Config')
    // An empty-string path/mode option is unset; #explicit must agree, or loadConfig would refuse a phantom override.
    const explicit = Object.fromEntries(Object.entries(rest).map(([key, value]) =>
      [key, value === '' && (OPTIONS[key].valid || OPTIONS[key].type === 'string') ? undefined : value]))
    this.#host = host
    this.#explicit = explicit
    this.#env = Object.fromEntries(OPTION_KEYS.map((key) => [key, (ownLock && (key === 'lock' || key === 'lockFile')) ? undefined : env[OPTIONS[key].env] || undefined]))
    this.#ownLock = ownLock

    try {
      for (const key of OPTION_KEYS) {
        if (this.#env[key] !== undefined && explicit[key] !== undefined) {
          assertSame(key, this.#envValue(key), this.#explicitValue(key), 'resources option does not match EXODUS_STASIS_RESOURCES')
        }
      }
    } catch (cause) {
      throw new Error('Config options can not override stasis env', { cause })
    }

    // Strings: '' falls through; booleans keep a false.
    const str = (key, fallback) => this.#envValue(key) || explicit[key] || fallback
    const val = (key, fallback) => this.#envValue(key) ?? explicit[key] ?? fallback
    this.#opts = {
      scope: str('scope', 'full'),
      lock: str('lock', DEFAULT_LOCK),
      lockFile: str('lockFile'),
      bundle: str('bundle', 'none'),
      bundleFile: str('bundleFile'),
      resourcesBundleFile: str('resourcesBundleFile'),
      debug: val('debug', false),
      childProcess: val('childProcess', false),
      packageJSON: val('packageJSON', false),
      fs: str('fs'),
      brotliQuality: this.#envValue('brotliQuality') ?? explicit.brotliQuality,
      resources: parseResourcesOption('resources', this.#env.resources !== undefined ? envList(this.#env.resources) : explicit.resources),
      // Attested beside what a writing run reaches (State#includeExtra). Not serialized.
      extra: [],
      // File-only, not serialized.
      policy: null,
      // Env-only: a capturing child flushes its shard on SIGTERM (jest-worker force-kills Metro workers). Not attested.
      shardSignalFlush: envBool('EXODUS_STASIS_SHARD_SIGNAL_FLUSH', env.EXODUS_STASIS_SHARD_SIGNAL_FLUSH ?? ''),
    }
    this.#checkInvariants()
  }

  #envValue(key) {
    const raw = this.#env[key]
    const { env, parse } = OPTIONS[key]
    return raw === undefined || !parse ? raw : parse(env, raw)
  }

  // Of a key the options set.
  #explicitValue(key) {
    return OPTIONS[key].option?.(this.#explicit[key]) ?? this.#explicit[key]
  }

  #checkInvariants() {
    const { lock, lockFile, bundle, resourcesBundleFile, fs, brotliQuality } = this.#opts
    for (const key of OPTION_KEYS) if (this.#opts[key] !== undefined) assertOption(key, this.#opts[key])
    if (brotliQuality !== undefined && !isBrotliQuality(brotliQuality)) {
      throw new RangeError(`brotliQuality must be an integer 0..11 (got ${JSON.stringify(brotliQuality)})`)
    }
    // --fs captures into the bundle (add/replace) or serves from it (load); other modes have nothing to do.
    if (fs !== undefined && !['add', 'replace', 'load'].includes(bundle)) {
      throw new RangeError(`fs requires bundle=(add|replace|load) (got bundle='${bundle}')`)
    }
    if (lockFile !== undefined && (lock === 'none' || lock === 'ignore')) {
      throw new RangeError(`lockFile requires an active lock mode (got lock='${lock}')`)
    }
    if (resourcesBundleFile !== undefined && (bundle === 'none' || bundle === 'ignore')) {
      throw new RangeError(`resourcesBundleFile requires an active bundle mode (got bundle='${bundle}')`)
    }

    // Write targets must be distinct: canonicalize so './x.br' vs 'x.br' and symlinks to one inode compare equal.
    const claimed = new Map()
    for (const label of ['lockFile', 'bundleFile', 'resourcesBundleFile']) {
      const value = this.#opts[label]
      if (value === undefined) continue
      const canonical = canonicalizePath(value, this.#host)
      if (claimed.has(canonical)) {
        throw new RangeError(`${label} '${value}' targets the same file as ${claimed.get(canonical)}; each must be a distinct path`)
      }
      claimed.set(canonical, label)
    }

    // bundle=load needs a trust root: frozen pins each file's sha512, else the bundle itself is it (none/ignore).
    if (bundle === 'load' && !['frozen', 'none', 'ignore'].includes(lock)) {
      throw new RangeError('bundle=load is incompatible with lock=(add|replace)')
    }

    // bundle=frozen deliberately constrains no lock mode: it verifies disk against the bundle, its own trust root.
    if (lock === 'none' && bundle === 'none') throw new RangeError('stasis needs a lockfile or a bundle: set lock or bundle')
  }

  loadConfig(json) {
    const config = JSON.parse(json)
    const keys = Object.keys(config)
    if (keys.includes('bundle')) {
      throw new Error('stasis.config.json: bundle can not be set here; give the bundle mode explicitly (--bundle, EXODUS_STASIS_BUNDLE)')
    }
    if (keys.includes('lock') && config.lock !== CONFIG_FILE_LOCK) {
      throw new Error(`${CONFIG_FILE}: lock can only be '${CONFIG_FILE_LOCK}' (got ${JSON.stringify(config.lock)}); give any other lock mode explicitly (--lock, EXODUS_STASIS_LOCK)`)
    }
    assert.equal(keys.filter((key) => !CONFIG_FILE_KEYS.includes(key)).length, 0)
    for (const key of keys) {
      // `stasis bundle`'s, validated there; the policy's, below.
      if (key === 'entries' || key === 'define' || POLICY_KEYS.includes(key)) continue
      // A run takes node_modules as installed, but a value github-bundle would refuse is refused here too.
      if (TREE_FLAGS.includes(key)) {
        if (typeof config[key] !== 'boolean') throw new TypeError(`stasis.config.json: ${key} must be true or false, got ${JSON.stringify(config[key])}`)
      } else if (key === 'lockfiles') parseLockfilesOption(CONFIG_FILE, config.lockfiles)
      else if (key === 'resources') this.#opts.resources = parseResourcesOption(CONFIG_FILE, config.resources)
      else if (key === 'extra') this.#opts.extra = parseExtraOption(CONFIG_FILE, config.extra)
      // '' -> undefined like the constructor: otherwise canonicalizePath('') claims cwd as a write target.
      else if (key === 'bundleFile' || key === 'resourcesBundleFile') this.#opts[key] = config[key] || undefined
      else if (key !== 'lock' || !this.#ownLock) this.#opts[key] = config[key]
    }
    this.#opts.policy = parsePolicy(CONFIG_FILE, config)
    this.#checkInvariants()

    // Explicit constructor options are as authoritative as the env: an on-disk config can't override --scope=full.
    // The constructor held them to agree, so the env's, where set, stands for both.
    try {
      for (const key of CONFIG_FILE_KEYS) {
        if (this.#env[key] !== undefined) {
          assertSame(key, this.#opts[key], this.#envValue(key), 'resources in stasis.config.json must match EXODUS_STASIS_RESOURCES')
        } else if (this.#explicit[key] !== undefined) {
          assertSame(key, this.#opts[key], this.#explicitValue(key), 'resources in stasis.config.json must match the resources option')
        }
      }
    } catch (cause) {
      throw new Error('Flags/env can not override stasis.config.json', { cause })
    }
  }

  // Read-only: a getter of each value, and of each DERIVED of them.
  static {
    for (const key of [...OPTION_KEYS, 'extra', 'policy', 'shardSignalFlush']) {
      Object.defineProperty(this.prototype, key === 'bundle' ? 'bundleMode' : key, { get() { return this.#opts[key] } })
    }
    for (const [name, derive] of Object.entries(DERIVED)) {
      Object.defineProperty(this.prototype, name, { get() { return derive(this.#opts) } })
    }
  }

  // As a stasis.config.json holds it: `lock` only where it is the one a file can pin, `bundle` never.
  get json() {
    const { scope, lock, resources } = this.#opts
    const data = { scope }
    if (lock === CONFIG_FILE_LOCK) data.lock = lock
    // Only when non-empty, so configs without an allowlist stay byte-identical.
    if (resources.size > 0) data.resources = [...resources].toSorted()
    return JSON.stringify(data, undefined, 2) + '\n'
  }
}
