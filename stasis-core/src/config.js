import assert from 'node:assert/strict'

import { diskHost } from './host.js'
import { canonicalizePath } from './state-util.js'
import { extSetsEqual, isBrotliQuality, parseBrotliQuality, parseResourcesOption } from './util.js'

export const DEFAULT_LOCK = 'add'
export const DEFAULT_BUNDLE = 'none'
export const DEFAULT_SCOPE = 'full'

// Strict, not truthy: a truthiness parse would read 'no'/'off' as *enabling* the toggle.
const envBool = (name, value) => {
  if (value === '' || value === '0' || value === 'false') return false
  if (value === '1' || value === 'true') return true
  throw new RangeError(`${name} must be ''/'0'/'false' or '1'/'true' (got '${value}')`)
}

// EXODUS_STASIS_RESOURCES is a comma-separated extension list; empty/unset means "no allowlist".
const envList = (value) => value.split(',').map((s) => s.trim()).filter(Boolean)

// Every option: its env var, how the env string parses (strings pass through) and, for a non-string
// option, how a `new Config()` option does. `lockFile` is flag/env-only (never from stasis.config.json).
const OPTIONS = {
  scope: { env: 'EXODUS_STASIS_SCOPE', valid: new Set(['node_modules', 'full']) },
  lock: { env: 'EXODUS_STASIS_LOCK', valid: new Set(['none', 'ignore', 'add', 'replace', 'frozen']) },
  lockFile: { env: 'EXODUS_STASIS_LOCK_FILE', type: 'string' },
  bundle: { env: 'EXODUS_STASIS_BUNDLE', valid: new Set(['none', 'ignore', 'add', 'replace', 'load', 'frozen']) },
  bundleFile: { env: 'EXODUS_STASIS_BUNDLE_FILE', type: 'string' },
  resourcesBundleFile: { env: 'EXODUS_STASIS_RESOURCES_BUNDLE_FILE', type: 'string' },
  debug: { env: 'EXODUS_STASIS_DEBUG', parse: envBool, type: 'boolean' },
  childProcess: { env: 'EXODUS_STASIS_CHILD_PROCESS', parse: envBool, type: 'boolean' },
  packageJSON: { env: 'EXODUS_STASIS_PACKAGE_JSON', parse: envBool, type: 'boolean' },
  fs: { env: 'EXODUS_STASIS_FS', valid: new Set(['sync', 'async']) },
  brotliQuality: { env: 'EXODUS_STASIS_BROTLI_QUALITY', parse: parseBrotliQuality },
  // Compared as parsed sets, not raw strings: ['png','svg'] and 'svg,png' are the same allowlist.
  resources: { env: 'EXODUS_STASIS_RESOURCES', parse: (name, value) => parseResourcesOption('env', envList(value)), option: (value) => parseResourcesOption('options', value) },
}
const OPTION_KEYS = Object.keys(OPTIONS)
const CONFIG_FILE_KEYS = OPTION_KEYS.filter((key) => key !== 'lockFile')
const PLUGIN_OPTION_KEYS = ['scope', 'lock', 'bundle', 'bundleFile', 'resourcesBundleFile', 'debug', 'childProcess', 'packageJSON', 'resources']

const assertKnownKeys = (keys, known, what) => {
  const unknown = keys.filter((key) => !known.includes(key))
  assert.equal(unknown.length, 0, `Unknown ${what} options: ${unknown.join(', ')}`)
}

// One option's membership/type rule; the cross-option rules live in #checkInvariants.
function assertOption(key, value) {
  const { valid, type } = OPTIONS[key]
  if (valid) assert.ok(valid.has(value), `Invalid ${key}: ${value}`)
  else if (type) assert.equal(typeof value, type, `${key} must be a ${type}`)
}

// Equal for the option's type: `resources` is a Set.
const assertSame = (key, actual, expected, message) => {
  if (key === 'resources') assert.ok(extSetsEqual(actual, expected), message)
  else assert.equal(actual, expected)
}

// Plugins validate the same options without constructing a Config (which has side effects).
export function validatePluginOptions(label, options) {
  assertKnownKeys(Object.keys(options), PLUGIN_OPTION_KEYS, label)
  for (const key of PLUGIN_OPTION_KEYS) {
    if (options[key] === undefined) continue
    if (key === 'resources') parseResourcesOption(label, options.resources)
    else assertOption(key, options[key])
  }
}

// The active Config is authoritative; options a plugin was given must agree with it.
export function assertOptionsMatchConfig(config, options) {
  try {
    // `resources` is deliberately NOT checked here: it's a Set, coordinated in resolvePluginState.
    for (const key of PLUGIN_OPTION_KEYS) {
      if (key !== 'resources' && options[key] !== undefined) assert.equal(config[key === 'bundle' ? 'bundleMode' : key], options[key])
    }
  } catch (cause) {
    throw new Error(`Plugin options conflict with active stasis state: ${cause.message}`, { cause })
  }
}

export class Config {
  #env
  #host
  #explicit
  #opts
  #shardSignalFlush

  // Env and options must agree when both are set; #explicit is kept so a later loadConfig can't override them.
  constructor(options = {}) {
    const { env = process.env, host = diskHost, ...rest } = options
    assertKnownKeys(Object.keys(rest), OPTION_KEYS, 'Config')
    // An empty-string path/mode option is unset, as its resolution below treats it; #explicit must
    // agree, or loadConfig would refuse a stasis.config.json for not matching a phantom override.
    const explicit = Object.fromEntries(Object.entries(rest).map(([key, value]) =>
      [key, value === '' && (OPTIONS[key].valid || OPTIONS[key].type === 'string') ? undefined : value]))
    this.#host = host
    this.#explicit = explicit
    // An env var set to '' counts as unset.
    this.#env = Object.fromEntries(OPTION_KEYS.map((key) => [key, env[OPTIONS[key].env] || undefined]))

    try {
      for (const key of OPTION_KEYS) {
        if (this.#env[key] !== undefined && explicit[key] !== undefined) {
          assertSame(key, this.#envValue(key), this.#explicitValue(key), 'resources option does not match EXODUS_STASIS_RESOURCES')
        }
      }
    } catch (cause) {
      throw new Error('Config options can not override stasis env', { cause })
    }

    // Strings: env, else the option, else the default ('' falls through); booleans keep a false.
    const str = (key, fallback) => this.#envValue(key) || explicit[key] || fallback
    const val = (key, fallback) => this.#envValue(key) ?? explicit[key] ?? fallback
    this.#opts = {
      scope: str('scope', DEFAULT_SCOPE),
      lock: str('lock', DEFAULT_LOCK),
      lockFile: str('lockFile', undefined),
      bundle: str('bundle', DEFAULT_BUNDLE),
      bundleFile: str('bundleFile', undefined),
      resourcesBundleFile: str('resourcesBundleFile', undefined),
      debug: val('debug', false),
      childProcess: val('childProcess', false),
      packageJSON: val('packageJSON', false),
      fs: str('fs', undefined),
      brotliQuality: this.#envValue('brotliQuality') ?? explicit.brotliQuality,
      resources: parseResourcesOption('resources', this.#env.resources !== undefined ? envList(this.#env.resources) : explicit.resources),
    }
    const flush = env.EXODUS_STASIS_SHARD_SIGNAL_FLUSH
    this.#shardSignalFlush = Boolean(flush) && envBool('EXODUS_STASIS_SHARD_SIGNAL_FLUSH', flush)

    this.#checkInvariants()
  }

  // An option's env value, parsed; undefined when unset.
  #envValue(key) {
    const raw = this.#env[key]
    const { env, parse } = OPTIONS[key]
    return raw === undefined || !parse ? raw : parse(env, raw)
  }

  #explicitValue(key) {
    const value = this.#explicit[key]
    return value !== undefined && OPTIONS[key].option ? OPTIONS[key].option(value) : value
  }

  #checkInvariants() {
    const { lock, lockFile, bundle, bundleFile, resourcesBundleFile, fs, brotliQuality } = this.#opts
    for (const key of ['scope', 'lock', 'bundle', 'debug', 'childProcess', 'packageJSON']) assertOption(key, this.#opts[key])
    if (brotliQuality !== undefined && !isBrotliQuality(brotliQuality)) {
      throw new RangeError(`brotliQuality must be an integer 0..11 (got ${JSON.stringify(brotliQuality)})`)
    }
    if (fs !== undefined) {
      assertOption('fs', fs)
      // --fs captures into the bundle (add/replace) or serves from it (load); other modes have nothing to do.
      if (!['add', 'replace', 'load'].includes(bundle)) {
        throw new RangeError(`fs requires bundle=(add|replace|load) (got bundle='${bundle}')`)
      }
    }
    if (bundleFile !== undefined) assertOption('bundleFile', bundleFile)
    if (lockFile !== undefined) {
      assertOption('lockFile', lockFile)
      if (lock === 'none' || lock === 'ignore') {
        throw new RangeError(`lockFile requires an active lock mode (got lock='${lock}')`)
      }
    }
    if (resourcesBundleFile !== undefined) {
      assertOption('resourcesBundleFile', resourcesBundleFile)
      if (bundle === 'none' || bundle === 'ignore') {
        throw new RangeError(`resourcesBundleFile requires an active bundle mode (got bundle='${bundle}')`)
      }
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
    if (lock === 'none' && bundle === 'none') {
      throw new RangeError('stasis needs a lockfile or a bundle: set lock or bundle')
    }
  }

  loadConfig(json) {
    const config = JSON.parse(json)
    const keys = Object.keys(config)
    assert.equal(keys.filter((key) => !CONFIG_FILE_KEYS.includes(key)).length, 0)
    for (const key of keys) {
      if (key === 'resources') this.#opts.resources = parseResourcesOption('stasis.config.json', config.resources)
      // '' -> undefined like the constructor: otherwise canonicalizePath('') claims cwd as a write target.
      else if (key === 'bundleFile' || key === 'resourcesBundleFile') this.#opts[key] = config[key] || undefined
      else this.#opts[key] = config[key]
    }
    this.#checkInvariants()

    try {
      for (const key of CONFIG_FILE_KEYS) {
        if (this.#env[key] !== undefined) {
          assertSame(key, this.#opts[key], this.#envValue(key), 'resources in stasis.config.json must match EXODUS_STASIS_RESOURCES')
        }
      }
      // Explicit constructor options are equally authoritative: an on-disk config can't override --scope=full.
      for (const key of CONFIG_FILE_KEYS) {
        if (this.#explicit[key] !== undefined) {
          assertSame(key, this.#opts[key], this.#explicitValue(key), 'resources in stasis.config.json must match the resources option')
        }
      }
    } catch (cause) {
      throw new Error('Flags/env can not override stasis.config.json', { cause })
    }
  }

  get bundleFile() {
    return this.#opts.bundleFile
  }

  // Exact lockfile path, bypassing `stasis.lock.json` discovery; bundler plugins can't set it.
  get lockFile() {
    return this.#opts.lockFile
  }

  // When set, resources go to this file and code-only to bundleFile; bundle=load reads both.
  get resourcesBundleFile() {
    return this.#opts.resourcesBundleFile
  }

  // Set of lowercase extensions/filenames treated as asset payloads.
  get resources() {
    return this.#opts.resources
  }

  get debug() {
    return this.#opts.debug
  }

  // Opt-in cross-process capture forwarding: a forked child writes a shard the root merges. Not attested.
  get childProcess() {
    return this.#opts.childProcess
  }

  // Opt-in: bundle every bundled module's package.json even if the run never reached it. Not attested.
  get packageJSON() {
    return this.#opts.packageJSON
  }

  // Env-only: a capturing child flushes its shard on SIGTERM (jest-worker force-kills Metro workers),
  // then re-delivers the signal. Not a user option, not attested.
  get shardSignalFlush() {
    return this.#shardSignalFlush
  }

  // --fs hook mode: 'sync' patches the sync readers, 'async' both; undefined leaves fs untouched. Not serialized.
  get fs() {
    return this.#opts.fs
  }

  // Brotli quality (0..11); undefined -> DEFAULT_BROTLI_QUALITY. Not serialized -- output decompresses identically.
  get brotliQuality() {
    return this.#opts.brotliQuality
  }

  get values() {
    return { scope: this.#opts.scope }
  }

  get bundle() {
    return this.#opts.bundle !== 'none' && this.#opts.bundle !== 'ignore'
  }

  get bundleMode() {
    return this.#opts.bundle
  }

  get ignoreBundle() {
    return this.#opts.bundle === 'ignore'
  }

  get writeBundle() {
    return this.#opts.bundle === 'add' || this.#opts.bundle === 'replace'
  }

  get replaceBundle() {
    return this.#opts.bundle === 'replace'
  }

  get loadBundle() {
    return this.#opts.bundle === 'load'
  }

  // bundle=frozen: loaded, never rewritten, and disk is checked against it (load serves bytes instead).
  get frozenBundle() {
    return this.#opts.bundle === 'frozen'
  }

  get full() {
    return this.#opts.scope === 'full'
  }

  get frozen() {
    return this.#opts.lock === 'frozen'
  }

  get useLockfile() {
    return this.#opts.lock !== 'none' && this.#opts.lock !== 'ignore'
  }

  get ignoreLockfile() {
    return this.#opts.lock === 'ignore'
  }

  get writeLockfile() {
    return this.#opts.lock === 'add' || this.#opts.lock === 'replace'
  }

  get replaceLockfile() {
    return this.#opts.lock === 'replace'
  }

  get scope() {
    return this.#opts.scope
  }

  get lock() {
    return this.#opts.lock
  }

  get json() {
    const { scope, lock, bundle, resources } = this.#opts
    const data = { scope, lock, bundle }
    // Only serialize `resources` when non-empty, so configs without an allowlist stay byte-identical.
    if (resources.size > 0) data.resources = [...resources].toSorted()
    return JSON.stringify(data, undefined, 2) + '\n'
  }
}
