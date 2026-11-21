import { basename, isAbsolute, relative, resolve } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { POLICY_KEYS, parsePolicy } from '@exodus/stasis-core/policy'
import { CONFIG_FILE, entryGlob, hasNodeModulesSegment, isGlobPattern, isPlainObject, JS_EXTENSIONS, parseBrotliQuality, parseResourcesOption, relativeEscapes, SCOPES, sortedByPath, stylesheetFormat, toPosix } from '@exodus/stasis-core/util'
import { parseFeatureList } from '../loaders/cargo.js'
import { parseDefineFlags } from '../define.js'
import { directoryEntryError, isSolidityEntry, readConfigFile } from './bundle.js'
import { bundleFormat, checkLockfileOnly } from './output.js'

export const BUNDLE_FLAGS = {
  mapping: { type: 'string' },
  manifests: { type: 'boolean' },
  output: { type: 'string', short: 'o' },
  format: { type: 'string' },
  scope: { type: 'string' },
  lockfile: { type: 'string' },
  'lockfile-only': { type: 'boolean' },
  conditions: { type: 'string' },
  mainFields: { type: 'string' },
  metro: { type: 'boolean' },
  'metro-resolver': { type: 'boolean' },
  babel: { type: 'boolean' },
  'babel-aliases': { type: 'string' },
  platforms: { type: 'string', multiple: true },
  jsx: { type: 'boolean' },
  flow: { type: 'boolean' },
  typescript: { type: 'boolean' },
  tsconfig: { type: 'string' },
  resources: { type: 'string' },
  'package-json': { type: 'boolean' },
  define: { type: 'string', multiple: true },
  cargo: { type: 'boolean' },
  'cargo-features': { type: 'string', multiple: true },
  'cargo-no-default-features': { type: 'boolean' },
  'cargo-all-features': { type: 'boolean' },
  'cargo-target': { type: 'string' },
  'cargo-manifests': { type: 'boolean' },
  'brotli-quality': { type: 'string' },
  add: { type: 'boolean' },
  deptree: { type: 'boolean' },
}

// The flags of the bundle as a whole; every other one is an entry's, which stasis.config.json's `entries` sets.
const OUTPUT_FLAGS = new Set(['output', 'format', 'lockfile', 'lockfile-only', 'brotli-quality', 'add', 'deptree'])
const LIST_FLAGS = new Set(['conditions', 'mainFields', 'platforms', 'resources', 'cargo-features'])
// Given once per value, which a comma doesn't separate (a define's JSON value may hold one).
const REPEATED_FLAGS = new Set(['define'])
// The entry flags that run a program -> what they run. Set in stasis.config.json, they take effect only with
// the same flag (and value) given too, as consent: the config can't make a bare `stasis bundle` run anything.
const CONSENT_FLAGS = new Map([
  ['babel', "the project's Babel config"],
  ['metro-resolver', "the project's metro-resolver"],
  ['cargo', "cargo, and what the project's .cargo/config.toml names"],
  ['cargo-target', 'rustc'],
])
// Each entry flag's option, as buildBundle takes it.
export const OPTION_FLAGS = {
  mappingFile: 'mapping', manifests: 'manifests', scope: 'scope', conditions: 'conditions', mainFields: 'mainFields', metro: 'metro', metroResolver: 'metro-resolver', babel: 'babel', babelAliases: 'babel-aliases', platforms: 'platforms', jsx: 'jsx', flow: 'flow', typescript: 'typescript', tsconfig: 'tsconfig', resources: 'resources', define: 'define', packageJSON: 'package-json', cargo: 'cargo', cargoFeatures: 'cargo-features', cargoNoDefaultFeatures: 'cargo-no-default-features', cargoAllFeatures: 'cargo-all-features', cargoTarget: 'cargo-target', cargoManifests: 'cargo-manifests',
}
// The entry flags (and --lockfile) one language's bundles alone take, by its entriesLanguage key, bundle.js's KINDS'.
export const LANGUAGE_FLAGS = [
  ['sol', '.sol', ['mapping', 'manifests']],
  ['rust', 'Rust', ['cargo', 'cargo-features', 'cargo-no-default-features', 'cargo-all-features', 'cargo-target', 'cargo-manifests']],
  ['js', 'JS', ['scope', 'lockfile', 'conditions', 'flow', 'typescript', 'mainFields', 'metro', 'jsx', 'package-json', 'resources', 'define']],
]
const flagText = (name, value) => (value === true ? `--${name}` : `--${name}=${value}`)
const isStrings = (value) => typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
export const nonEmpty = (list) => Array.isArray(list) && list.length > 0

// Refuses what of buildBundle's `options` the others rule out, `prefix` its message's; `partial`: a stasis.config.json
// entry may yet complete them, so what one needs of another is left to the build.
export function checkCombinations(prefix, { metro, conditions, mainFields, platforms, metroResolver, babel, babelAliases, typescript, tsconfig }, partial = false) {
  const refusal = [
    [tsconfig !== undefined && !typescript && !partial, '--tsconfig is only valid with --typescript'],
    [metro && nonEmpty(conditions), "--conditions can't be combined with --metro (it sets its own conditions)"],
    [metro && mainFields !== undefined, "--mainFields can't be combined with --metro (it sets its own mainFields)"],
    [metro && !nonEmpty(platforms) && !partial, '--metro requires --platforms (e.g. --platforms=ios,android)'],
    [!metro && nonEmpty(platforms) && !partial, '--platforms is only valid with --metro'],
    [metroResolver && !metro, '--metro-resolver is only valid with --metro'],
    [babel && !metro, '--babel is only valid with --metro'],
    [babelAliases !== undefined && !metro && !partial, '--babel-aliases is only valid with --metro'],
    [babelAliases !== undefined && babel, "--babel-aliases can't be combined with --babel (both set the import aliases)"],
    [typescript && metroResolver, "--typescript is not supported with --metro-resolver (the project's metro-resolver doesn't substitute .js -> .ts)"],
  ].find(([refused]) => refused)
  if (refusal) throw new Error(`${prefix}${refusal[1]}`)
}

function listFlag(value, error) {
  if (value === undefined) return undefined
  const list = value.split(',').map((s) => s.trim()).filter(Boolean)
  if (list.length === 0) throw new Error(error)
  return list
}

function entryKey(cwd, entry) {
  const rel = relative(resolve(cwd), resolve(cwd, entry))
  return relativeEscapes(rel) ? null : toPosix(rel) || '.'
}

// The readConfigEntries records of `entries`, and the first `config` names: it may name all of them or none, not some.
function namedIn(cwd, entries, config, prefix = '') {
  const named = entries.map((entry) => config?.get(entryKey(cwd, entry)))
  const first = entries.find((_, i) => named[i] !== undefined)
  const unnamed = first === undefined ? undefined : entries.find((_, i) => named[i] === undefined)
  if (unnamed !== undefined) {
    throw new Error(`${prefix}${CONFIG_FILE}'s entries name ${first} but not ${unnamed}: bundle either the entries it names or others, not both`)
  }
  return { named, first }
}

function prefixed(prefix, fn) {
  try {
    return fn()
  } catch (cause) {
    throw new Error(`${prefix}${cause.message}`, { cause })
  }
}

// A stylesheet is an entry of a JS bundle, whose graph reaches stylesheets.
const isJsEntry = (entry) => JS_EXTENSIONS.values().some((ext) => entry.endsWith(ext)) || stylesheetFormat(entry) !== undefined

// Which language `entries` all are in, by KINDS key, or `jsAndSol` for JS and Solidity entries together, each built apart.
function entriesLanguage(entries, cwd, host = diskHost) {
  // Beside JS entries, a directory one is of the Solidity ones.
  const dirError = directoryEntryError(entries.filter((f) => !isJsEntry(f)), cwd, host)
  if (dirError !== null) throw new Error(dirError)
  const lang = {
    sol: entries.every((f) => isSolidityEntry(f, cwd, host)),
    php: entries.every((f) => f.endsWith('.php')),
    js: entries.every(isJsEntry),
    bash: entries.every((f) => /\.(?:sh|bash)$/u.test(f)),
    rust: entries.every((f) => f.endsWith('.rs')),
    teal: entries.every((f) => f.endsWith('.teal')),
  }
  if (Object.values(lang).some(Boolean)) return lang
  if (entries.every((f) => isJsEntry(f) || isSolidityEntry(f, cwd, host))) return { ...lang, jsAndSol: true }
  throw new Error('bundle entries must all be .sol, all be .php, all be .js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx/.css, all be .sh/.bash, all be .rs, or all be .teal, or be .js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx/.css and .sol together')
}

// The entry flags of `values` as buildBundle's options, each checked: first that `lang`'s bundles take it.
function buildOptions(values, lang) {
  const options = Object.fromEntries(Object.entries(OPTION_FLAGS).map(([key, flag]) => [key, BUNDLE_FLAGS[flag].type === 'boolean' ? Boolean(values[flag]) : values[flag]]))
  const { metro, scope } = options
  options.platforms = [...new Set((values.platforms ?? []).flatMap((p) => p.split(',')).map((s) => s.trim()).filter(Boolean))]
  for (const [only, what, flags] of LANGUAGE_FLAGS) {
    // --platforms counts as --metro.
    const flag = lang[only] ? undefined : flags.find((name) => (name === 'metro' ? metro || options.platforms.length > 0 : values[name]))
    if (flag !== undefined) throw new Error(`--${flag} is only valid for ${what} bundles`)
  }
  options.cargoFeatures = parseFeatureList(values['cargo-features'] ?? [])
  if (values['cargo-features'] !== undefined && options.cargoFeatures.length === 0) {
    throw new Error('--cargo-features must list at least one feature (e.g. --cargo-features=serde,app/tls)')
  }
  options.cargoTarget ??= null
  if (options.cargoTarget !== null && !/^[\w.-]+$/u.test(options.cargoTarget)) {
    throw new Error('--cargo-target must be a target triple or "host" (e.g. --cargo-target=aarch64-apple-darwin)')
  }
  if (scope && !SCOPES.has(scope)) throw new Error('--scope must be node_modules or full')
  if (scope !== undefined && scope !== 'full' && (values.mainFields !== undefined || metro)) {
    throw new Error(`--scope=${scope} is not supported with --mainFields or --metro (they always build a full-scope bundle)`)
  }
  options.conditions = listFlag(values.conditions, '--conditions must list at least one condition name (e.g. --conditions=react-native,browser)') ?? []
  // --metro parses JSX and Flow, as Metro's Babel does in every file.
  options.jsx ||= metro
  options.flow ||= metro
  options.mainFields = listFlag(values.mainFields, '--mainFields must list at least one field (e.g. --mainFields=react-native,browser,main)')
  // A platform name becomes an edge key, so no '/' (parsers reject it) or '*' (a reserved placeholder).
  for (const p of options.platforms) {
    if (p === '*' || p.includes('/')) throw new Error(`invalid --platforms value '${p}' (a platform name can't contain '/' or be '*')`)
  }
  options.resources = listFlag(values.resources, '--resources must list at least one extension or filename (e.g. --resources=png,svg)')
  parseResourcesOption('--resources', options.resources) // checked here, for a clean usage error
  checkCombinations('', options)
  if (values.define !== undefined) options.define = parseDefineFlags(null, values.define)
  return options
}

function outputOptions(values, { js, sol, jsAndSol }) {
  if (values.lockfile && !js) throw new Error('--lockfile is only valid for JS bundles')
  const deptree = Boolean(values.deptree)
  if (deptree && !js && !sol && !jsAndSol) throw new Error('--deptree is only valid for JS and .sol bundles')
  // The CONSENT_FLAGS that run a program of the project's from disk, where --deptree installs nothing.
  for (const flag of deptree ? ['babel', 'metro-resolver'] : []) {
    if (values[flag]) throw new Error(`--${flag} can't be combined with --deptree (it runs ${CONSENT_FLAGS.get(flag)} from disk, where --deptree installs nothing)`)
  }
  const brotliQuality = values['brotli-quality'] === undefined ? undefined : parseBrotliQuality('--brotli-quality', values['brotli-quality'])
  const add = Boolean(values.add)
  if (add && values.output === '-') throw new Error('--add cannot be combined with --output=-')
  const lockfileOnly = Boolean(values['lockfile-only'])
  checkLockfileOnly('', { lockfileOnly, lockfile: values.lockfile, output: values.output, add, brotliQuality: values['brotli-quality'], format: values.format })
  bundleFormat('', { format: values.format, output: values.output, brotliQuality: values['brotli-quality'] })
  return { output: values.output, format: values.format, lockfile: values.lockfile, lockfileOnly, brotliQuality, add, deptree }
}

// An entry's options in stasis.config.json's `entries` as parseArgs would give the flags they alias: `true`
// for a boolean set (`false` is no flag), a list flag's array as one string, a REPEATED_FLAGS one's as given.
function entryFlags(what, options) {
  if (!isPlainObject(options)) throw new Error(`${what} must be an object of stasis bundle options`)
  const values = {}
  for (const [flag, value] of Object.entries(options)) {
    if (POLICY_KEYS.includes(flag)) continue
    if (OUTPUT_FLAGS.has(flag)) throw new Error(`${what}: ${flag} is the bundle's option, not an entry's: pass --${flag}`)
    if (!Object.hasOwn(BUNDLE_FLAGS, flag)) throw new Error(`${what}: unknown option ${JSON.stringify(flag)}`)
    const { type, multiple } = BUNDLE_FLAGS[flag]
    if (type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${what}: ${flag} must be true or false`)
      if (value) values[flag] = true
      continue
    }
    const takesArray = LIST_FLAGS.has(flag) || REPEATED_FLAGS.has(flag)
    if (typeof value !== 'string' && !(takesArray && isStrings(value))) throw new Error(`${what}: ${flag} must be a string${takesArray ? ' or an array of strings' : ''}`)
    const list = [value].flat()
    if (REPEATED_FLAGS.has(flag)) values[flag] = list
    else values[flag] = multiple ? [list.join(',')] : list.join(',')
  }
  return values
}

// A config's own `define`, every JS entry's: the --define flags it gives them, or undefined where it sets none. An
// entry setting its own beside it is refused, which of the two it builds with being no guess to make.
function configDefine(config) {
  const define = config?.define
  if (define === undefined) return undefined
  const what = `${CONFIG_FILE}: define`
  if (!isStrings(define)) throw new Error(`${what} must be a string or an array of strings`)
  const flags = [define].flat()
  parseDefineFlags(what, flags)
  const entries = isPlainObject(config.entries) ? config.entries : {}
  const own = Object.keys(entries).find((entry) => isPlainObject(entries[entry]) && Object.hasOwn(entries[entry], 'define'))
  if (own !== undefined) {
    throw new Error(`${what} can't be combined with entries ${JSON.stringify(own)}'s define: give every entry's in define, or each entry's in its own options`)
  }
  return flags
}

// The `define` of the stasis.config.json in `cwd`, as the --define flags it gives every JS entry, or undefined.
export const readConfigDefine = (cwd = process.cwd(), host = diskHost) => configDefine(readConfigFile(undefined, cwd, host))

// The entryKeys a key of `entries` names: its own, or those it matches as a glob pattern, as `extra`'s glob (Node's,
// whose `*` skips dotfiles) finds them, none in a node_modules: a build laying its tree out from the lockfile globs
// before any is there. Matching nothing, it stands for itself, as a shell's. Null where it, or a match, is out of
// `cwd`, which a brace list may yet build a `..` to climb out of (`..{,a}/b.js`).
function keysNamed(what, cwd, entry, host) {
  const key = isAbsolute(entry) ? null : entryKey(cwd, entry)
  if (key === null) return null
  if (!isGlobPattern(entry)) return [key]
  const found = host.glob(entryGlob(what, entry), { cwd, exclude: (path) => basename(path) === 'node_modules' }).map((path) => entryKey(cwd, path))
  if (found.includes(null)) return null
  // Node holds `exclude` to its `**` alone.
  const matches = sortedByPath(new Set(found.filter((path) => !hasNodeModulesSegment(path))))
  return matches.length > 0 ? matches : [key]
}

// The `entries` of the stasis.config.json in `cwd`, by entryKey; an entry's own Policy is held beside the config's.
// A glob pattern's matches are each an entry of its options. A JS entry takes the config's own `define` as its own.
export function readConfigEntries(cwd = process.cwd(), host = diskHost) {
  const config = readConfigFile(undefined, cwd, host)
  const define = configDefine(config)
  const entries = config?.entries
  if (entries === undefined) return null
  if (!isPlainObject(entries)) throw new Error(`${CONFIG_FILE}: entries must be an object of each entry's stasis bundle options`)
  const named = new Map()
  for (const [entry, options] of Object.entries(entries)) {
    const what = `${CONFIG_FILE}: entries ${JSON.stringify(entry)}`
    const keys = keysNamed(what, cwd, entry, host)
    if (keys === null) throw new Error(`${what}: an entry must be a path relative to the directory of ${CONFIG_FILE}, within it`)
    const values = entryFlags(what, options)
    const policy = parsePolicy(what, options)
    for (const key of keys) {
      const same = named.get(key)
      if (same !== undefined) throw new Error(`${what} names the same entry as ${JSON.stringify(same.entry)}: ${key}`)
      named.set(key, { entry, values: define !== undefined && isJsEntry(key) ? { ...values, define } : values, ...(policy !== null && { policy }) })
    }
  }
  return named
}

// The entries `config` names, to bundle with none given: each as written, a pattern's as the paths it stands for.
export const configEntries = (config) => [...(config ?? [])].map(([key, { entry }]) => (isGlobPattern(entry) ? key : entry))

// Where `config` names every entry, each is built with its options there, the flags given only the bundle's own
// and the consent its CONSENT_FLAGS need; where it names none, all are built with the flags. Either way, JS entries
// take the `define` of the stasis.config.json in `cwd`, which no --define may be given beside.
export function bundlePlan({ cwd = process.cwd(), entries, values, config = null }) {
  const lang = entriesLanguage(entries, cwd)
  const output = outputOptions(values, lang)
  const define = readConfigDefine(cwd)
  if (define !== undefined && values.define !== undefined) throw new Error(`--define can't be given, as ${CONFIG_FILE}'s define gives every entry's: set it there`)
  // As readConfigEntries gives it to the entries it names.
  const defined = (part) => (define !== undefined && part.every(isJsEntry) ? { ...values, define } : values)
  const { named, first } = namedIn(cwd, entries, config)
  if (first === undefined && !lang.jsAndSol) return { ...output, entries, ...buildOptions(defined(entries), lang) }
  if (first === undefined) {
    return { ...output, builds: [...Map.groupBy(entries, isJsEntry).values()].map((part) => {
      try {
        return { entries: part, ...buildOptions(defined(part), entriesLanguage(part, cwd)) }
      } catch (cause) {
        throw new Error(`${cause.message}, and ${part[0]} is not of one: give the JS and .sol entries' options apart, in ${CONFIG_FILE}'s entries`, { cause })
      }
    }) }
  }
  const flag = Object.keys(values).find((name) => !OUTPUT_FLAGS.has(name) && !CONSENT_FLAGS.has(name))
  if (flag !== undefined) throw new Error(`--${flag} can't be given for ${first}, whose options ${CONFIG_FILE}'s entries set: set it there`)
  for (const consent of CONSENT_FLAGS.keys()) {
    const given = values[consent]
    if (given !== undefined && !named.some(({ values: flags }) => flags[consent] === given)) {
      throw new Error(`${flagText(consent, given)} is given, but ${CONFIG_FILE}'s entries set ${flagText(consent, given).slice(2)} for none of ${entries.join(', ')}`)
    }
  }
  return { ...output, builds: grouped('', entries.map((entry, i) => {
    const { entry: name, values: flags } = named[i]
    const unconsented = [...CONSENT_FLAGS.keys()].find((consent) => flags[consent] !== undefined && values[consent] !== flags[consent])
    if (unconsented !== undefined) {
      const consent = flagText(unconsented, flags[unconsented])
      throw new Error(`${CONFIG_FILE}: entries ${JSON.stringify(name)} sets ${consent.slice(2)}, which runs ${CONSENT_FLAGS.get(unconsented)}: pass ${consent} to allow it`)
    }
    return entryBuild(`${CONFIG_FILE}: entries ${JSON.stringify(name)}: `, entry, named[i], cwd)
  })) }
}

// `entry`'s language, and the options of `named`, its readConfigEntries record; `what` prefixes errors.
function entryBuild(what, entry, named, cwd, host = diskHost) {
  const language = prefixed(what, () => entriesLanguage([entry], cwd, host))
  return { entry, named, language, options: prefixed(what, () => buildOptions(named.values, language)) }
}

// The entryBuilds of the same language, options and Policy as one build, of the first one's Policy labelled with the
// keys naming them, a pattern's once.
function grouped(prefix, built) {
  const groups = Map.groupBy(built, ({ language, options, named }) => JSON.stringify([language, options, named.policy?.key]))
  return [...groups.values()].map((group) => {
    const [{ options, named: { policy } }] = group
    const build = { entries: group.map(({ entry }) => entry), ...options }
    if (policy === undefined) return build
    const keys = new Set(group.map(({ named }) => JSON.stringify(named.entry)))
    return { ...build, policy: policy.withLabel(`${prefix}${CONFIG_FILE}: entries ${[...keys].join(', ')}`) }
  })
}

// Those whose values are a set, in whatever order given.
const SET_OPTIONS = new Set(['conditions', 'platforms', 'resources', 'cargoFeatures'])
const DEFAULT_OPTIONS = buildOptions({}, {})
// An option's value as compared: a set's sorted (each of `resources` as parseResourcesOption takes it), defines
// by name, 'null' for no value or no define.
const comparable = (key, value) => {
  if (value === undefined || value === null || (key === 'define' && isPlainObject(value) && Object.keys(value).length === 0)) return 'null'
  if (key === 'resources' && Array.isArray(value)) value = value.map((v) => (typeof v === 'string' ? v.toLowerCase().replace(/^\./u, '') : v))
  if (SET_OPTIONS.has(key) && Array.isArray(value)) return JSON.stringify([...new Set(value)].toSorted())
  if (key === 'define' && isPlainObject(value)) return JSON.stringify(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1)))
  return JSON.stringify(value)
}
const optionText = (key, value) => (key === 'define'
  ? Object.entries(value).map(([name, v]) => `--define=${name}=${JSON.stringify(v)}`).join(' ')
  : flagText(OPTION_FLAGS[key], Array.isArray(value) ? value.join(',') : value))

// The `define` of the stasis.config.json in `cwd`, parsed, for a bundle of a project it runs nothing of: a define
// given (off its default) must be the same.
function configuredDefine(name, { cwd, host, options }) {
  const flags = prefixed(`${name}: `, () => readConfigDefine(cwd, host))
  if (flags === undefined) return undefined
  const define = parseDefineFlags(null, flags)
  const given = comparable('define', options.define)
  if (given !== 'null' && given !== comparable('define', define)) {
    throw new Error(`${name}: ${optionText('define', options.define)} is given, but ${CONFIG_FILE}'s define builds every entry with ${optionText('define', define)}`)
  }
  return define
}

// `options`, of a build of entries the config's `entries` doesn't name, for a bundle of a project it runs nothing of
// (vfs-bundle's): with the config's `define` where they are JS, as configuredBuilds gives the entries it names.
export function withConfigDefine(name, options, { cwd, host = diskHost }) {
  const define = configuredDefine(name, { cwd, host, options })
  return define === undefined || !Array.isArray(options.entries) || !options.entries.every(isJsEntry) ? options : { ...options, define }
}

// The builds of `entries` (by default, all it names) the config names, for a bundle of a project it runs nothing
// of (vfs-bundle's), or null where it names none. Each option given off its default must be what each entry sets,
// and none may run a program, checked after each entry's own.
export function configuredBuilds(name, { cwd, host = diskHost, entries, options = {} }) {
  const config = prefixed(`${name}: `, () => readConfigEntries(cwd, host))
  if (config === null || (entries !== undefined && !Array.isArray(entries))) return null
  // Before each entry's, which takes it as its own.
  configuredDefine(name, { cwd, host, options })
  if (entries === undefined) {
    entries = [...config.keys()]
    if (entries.length === 0) return { entries, builds: [] }
  }
  const { named, first } = namedIn(cwd, entries, config, `${name}: `)
  if (first === undefined) return null
  const given = Object.keys(OPTION_FLAGS).filter((key) => options[key] !== undefined && comparable(key, options[key]) !== comparable(key, DEFAULT_OPTIONS[key]))
  const compared = given.filter((key) => !CONSENT_FLAGS.has(OPTION_FLAGS[key]))
  const built = entries.map((entry, i) => {
    const { entry: written, values } = named[i]
    const what = `${name}: ${CONFIG_FILE}: entries ${JSON.stringify(written)}`
    const running = [...CONSENT_FLAGS.keys()].find((flag) => values[flag] !== undefined)
    if (running !== undefined) throw new Error(`${what} sets ${running}, which runs ${CONSENT_FLAGS.get(running)}, and nothing of the project runs here`)
    const build = entryBuild(`${what}: `, entry, named[i], cwd, host)
    const differing = compared.find((key) => comparable(key, options[key]) !== comparable(key, build.options[key]))
    if (differing !== undefined) {
      const set = build.options[differing]
      const as = comparable(differing, set) === comparable(differing, DEFAULT_OPTIONS[differing]) ? `without --${OPTION_FLAGS[differing]}` : `with ${optionText(differing, set)}`
      throw new Error(`${name}: ${optionText(differing, options[differing])} is given, but ${CONFIG_FILE}'s entries build ${JSON.stringify(written)} ${as}: an entry it names is built with its options there`)
    }
    return build
  })
  const running = given.find((key) => CONSENT_FLAGS.has(OPTION_FLAGS[key]))
  if (running !== undefined) throw new Error(`${name}: ${optionText(running, options[running])} is given, which runs ${CONSENT_FLAGS.get(OPTION_FLAGS[running])}, and nothing of the project runs here`)
  return { entries, builds: grouped(`${name}: `, built) }
}
