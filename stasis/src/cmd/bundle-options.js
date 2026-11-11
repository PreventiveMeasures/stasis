import { isAbsolute, relative, resolve } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { POLICY_KEYS, parsePolicy } from '@exodus/stasis-core/policy'
import { CONFIG_FILE, isPlainObject, JS_EXTENSIONS, parseBrotliQuality, parseResourcesOption, relativeEscapes, SCOPES, toPosix, upsert } from '@exodus/stasis-core/util'
import { parseFeatureList } from '../loaders/cargo.js'
import { parseDefineFlags } from '../define.js'
import { directoryEntryError, isSolidityEntry, readConfigFile } from './bundle.js'
import { lockfileOnlyError } from './output.js'

export const BUNDLE_FLAGS = {
  mapping: { type: 'string' },
  manifests: { type: 'boolean' },
  output: { type: 'string', short: 'o' },
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
const OUTPUT_FLAGS = new Set(['output', 'lockfile', 'lockfile-only', 'brotli-quality', 'add', 'deptree'])
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
const flagText = (name, value) => (value === true ? `--${name}` : `--${name}=${value}`)

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

// The entryKeys of `entries`, and the first of them `config` names: it may name all of them or none, not some.
function configuredKeys(cwd, entries, config, prefix = '') {
  const keys = entries.map((entry) => entryKey(cwd, entry))
  const first = config === null ? undefined : entries.find((_, i) => config.has(keys[i]))
  const unnamed = first === undefined ? undefined : entries.find((_, i) => !config.has(keys[i]))
  if (unnamed !== undefined) {
    throw new Error(`${prefix}${CONFIG_FILE}'s entries name ${first} but not ${unnamed}: bundle either the entries it names or others, not both`)
  }
  return { keys, first }
}

function prefixed(prefix, fn) {
  try {
    return fn()
  } catch (cause) {
    throw new Error(`${prefix}${cause.message}`, { cause })
  }
}

const isJsEntry = (entry) => JS_EXTENSIONS.values().some((ext) => entry.endsWith(ext))

// Which language `entries` all are in, or `jsAndSol` for JS and Solidity entries together, each built apart.
function entriesLanguage(entries, cwd, host = diskHost) {
  // Beside JS entries, a directory one is of the Solidity ones.
  const dirError = directoryEntryError(entries.filter((f) => !isJsEntry(f)), cwd, host)
  if (dirError !== null) throw new Error(dirError)
  const lang = {
    allSol: entries.every((f) => isSolidityEntry(f, cwd, host)),
    allPhp: entries.every((f) => f.endsWith('.php')),
    allJs: entries.every(isJsEntry),
    allBash: entries.every((f) => /\.(?:sh|bash)$/u.test(f)),
    allRust: entries.every((f) => f.endsWith('.rs')),
    allTeal: entries.every((f) => f.endsWith('.teal')),
  }
  if (Object.values(lang).some(Boolean)) return lang
  if (entries.every((f) => isJsEntry(f) || isSolidityEntry(f, cwd, host))) return { ...lang, jsAndSol: true }
  throw new Error('bundle entries must all be .sol, all be .php, all be .js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx, all be .sh/.bash, all be .rs, or all be .teal, or be .js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx and .sol together')
}

function buildOptions(values, { allSol, allJs, allRust }) {
  if (values.mapping && !allSol) throw new Error('--mapping is only valid for .sol bundles')
  const manifests = Boolean(values.manifests)
  if (manifests && !allSol) throw new Error('--manifests is only valid for .sol bundles')
  const cargo = Boolean(values.cargo)
  if (cargo && !allRust) throw new Error('--cargo is only valid for Rust bundles')
  const cargoFeatures = parseFeatureList(values['cargo-features'] ?? [])
  if (values['cargo-features'] !== undefined && cargoFeatures.length === 0) {
    throw new Error('--cargo-features must list at least one feature (e.g. --cargo-features=serde,app/tls)')
  }
  const cargoNoDefaultFeatures = Boolean(values['cargo-no-default-features'])
  const cargoAllFeatures = Boolean(values['cargo-all-features'])
  const cargoTarget = values['cargo-target'] ?? null
  if (cargoTarget !== null && !/^[\w.-]+$/u.test(cargoTarget)) {
    throw new Error('--cargo-target must be a target triple or "host" (e.g. --cargo-target=aarch64-apple-darwin)')
  }
  const cargoManifests = Boolean(values['cargo-manifests'])
  if (!allRust) {
    const given = { 'cargo-features': cargoFeatures.length > 0, 'cargo-no-default-features': cargoNoDefaultFeatures, 'cargo-all-features': cargoAllFeatures, 'cargo-target': cargoTarget !== null, 'cargo-manifests': cargoManifests }
    for (const [flag, on] of Object.entries(given)) if (on) throw new Error(`--${flag} is only valid for Rust bundles`)
  }
  if (values.scope && !allJs) throw new Error('--scope is only valid for JS bundles')
  if (values.scope && !SCOPES.has(values.scope)) throw new Error('--scope must be node_modules or full')
  if (values.scope !== undefined && values.scope !== 'full' && (values.mainFields !== undefined || values.metro)) {
    throw new Error(`--scope=${values.scope} is not supported with --mainFields or --metro (they always build a full-scope bundle)`)
  }
  if (values.conditions !== undefined && !allJs) throw new Error('--conditions is only valid for JS bundles')
  const conditions = listFlag(values.conditions, '--conditions must list at least one condition name (e.g. --conditions=react-native,browser)') ?? []
  // --metro parses JSX and Flow, as Metro's Babel does in every file.
  const metro = Boolean(values.metro)
  if (values.flow && !allJs) throw new Error('--flow is only valid for JS bundles')
  const flow = Boolean(values.flow) || metro
  if (values.typescript && !allJs) throw new Error('--typescript is only valid for JS bundles')
  const typescript = Boolean(values.typescript)
  if (values.tsconfig !== undefined && !typescript) throw new Error('--tsconfig is only valid with --typescript')
  if (values.mainFields !== undefined && !allJs) throw new Error('--mainFields is only valid for JS bundles')
  const mainFields = listFlag(values.mainFields, '--mainFields must list at least one field (e.g. --mainFields=react-native,browser,main)')
  const metroResolver = Boolean(values['metro-resolver'])
  const platforms = [...new Set((values.platforms ?? []).flatMap((p) => p.split(',')).map((s) => s.trim()).filter(Boolean))]
  // A platform name becomes an edge key, so no '/' (parsers reject it) or '*' (a reserved placeholder).
  for (const p of platforms) {
    if (p === '*' || p.includes('/')) throw new Error(`invalid --platforms value '${p}' (a platform name can't contain '/' or be '*')`)
  }
  if ((metro || platforms.length > 0) && !allJs) throw new Error('--metro is only valid for JS bundles')
  const jsx = Boolean(values.jsx) || metro
  if (jsx && !allJs) throw new Error('--jsx is only valid for JS bundles')
  const packageJSON = Boolean(values['package-json'])
  if (packageJSON && !allJs) throw new Error('--package-json is only valid for JS bundles')
  if (values.resources !== undefined && !allJs) throw new Error('--resources is only valid for JS bundles')
  const resources = listFlag(values.resources, '--resources must list at least one extension or filename (e.g. --resources=png,svg)')
  parseResourcesOption('--resources', resources)
  if (metro) {
    if (conditions.length > 0) throw new Error("--conditions can't be combined with --metro (it sets its own conditions)")
    if (mainFields !== undefined) throw new Error("--mainFields can't be combined with --metro (it sets its own mainFields)")
    if (platforms.length === 0) throw new Error('--metro requires --platforms (e.g. --platforms=ios,android)')
  } else if (platforms.length > 0) {
    throw new Error('--platforms is only valid with --metro')
  }
  if (metroResolver && !metro) throw new Error('--metro-resolver is only valid with --metro')
  const babel = Boolean(values.babel)
  if (babel && !metro) throw new Error('--babel is only valid with --metro')
  if (values['babel-aliases'] !== undefined && !metro) throw new Error('--babel-aliases is only valid with --metro')
  if (values['babel-aliases'] !== undefined && babel) throw new Error("--babel-aliases can't be combined with --babel (both set the import aliases)")
  if (typescript && metroResolver) throw new Error("--typescript is not supported with --metro-resolver (the project's metro-resolver doesn't substitute .js -> .ts)")
  if (values.define !== undefined && !allJs) throw new Error('--define is only valid for JS bundles')
  const define = values.define === undefined ? undefined : parseDefineFlags(null, values.define)
  return { mappingFile: values.mapping, manifests, scope: values.scope, conditions, mainFields, metro, metroResolver, babel, babelAliases: values['babel-aliases'], platforms, jsx, flow, typescript, tsconfig: values.tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }
}

// The CONSENT_FLAGS that run a program of the project's from disk, where --deptree installs nothing.
const DISK_RUN_FLAGS = ['babel', 'metro-resolver']

function outputOptions(values, { allJs, allSol, jsAndSol }) {
  if (values.lockfile && !allJs) throw new Error('--lockfile is only valid for JS bundles')
  const deptree = Boolean(values.deptree)
  if (deptree && !allJs && !allSol && !jsAndSol) throw new Error('--deptree is only valid for JS and .sol bundles')
  for (const flag of deptree ? DISK_RUN_FLAGS : []) {
    if (values[flag]) throw new Error(`--${flag} can't be combined with --deptree (it runs ${CONSENT_FLAGS.get(flag)} from disk, where --deptree installs nothing)`)
  }
  const brotliQuality = values['brotli-quality'] === undefined ? undefined : parseBrotliQuality('--brotli-quality', values['brotli-quality'])
  const add = Boolean(values.add)
  if (add && values.output === '-') throw new Error('--add cannot be combined with --output=-')
  const lockfileOnly = Boolean(values['lockfile-only'])
  const lockfileOnlyRefused = lockfileOnly ? lockfileOnlyError({ lockfile: values.lockfile, output: values.output, add, brotliQuality: values['brotli-quality'] }) : null
  if (lockfileOnlyRefused !== null) throw new Error(lockfileOnlyRefused)
  return { output: values.output, lockfile: values.lockfile, lockfileOnly, brotliQuality, add, deptree }
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
    const list = takesArray && Array.isArray(value) && value.every((v) => typeof v === 'string')
    if (typeof value !== 'string' && !list) throw new Error(`${what}: ${flag} must be a string${takesArray ? ' or an array of strings' : ''}`)
    if (REPEATED_FLAGS.has(flag)) {
      values[flag] = [value].flat()
      continue
    }
    const text = list ? value.join(',') : value
    values[flag] = multiple ? [text] : text
  }
  return values
}

// The `entries` of the stasis.config.json in `cwd`, by entryKey; an entry's own Policy is held beside the config's.
export function readConfigEntries(cwd = process.cwd(), host = diskHost) {
  const entries = readConfigFile(undefined, cwd, host)?.entries
  if (entries === undefined) return null
  if (!isPlainObject(entries)) throw new Error(`${CONFIG_FILE}: entries must be an object of each entry's stasis bundle options`)
  const named = new Map()
  for (const [entry, options] of Object.entries(entries)) {
    const what = `${CONFIG_FILE}: entries ${JSON.stringify(entry)}`
    const key = isAbsolute(entry) ? null : entryKey(cwd, entry)
    if (key === null) throw new Error(`${what}: an entry must be a path relative to the directory of ${CONFIG_FILE}, within it`)
    if (named.has(key)) throw new Error(`${what} names the same entry as ${JSON.stringify(named.get(key).entry)}`)
    const values = entryFlags(what, options)
    const policy = parsePolicy(what, options)
    named.set(key, { entry, values, ...(policy !== null && { policy }) })
  }
  return named
}

// Where `config` names every entry, each is built with its options there, the flags given only the bundle's own
// and the consent its CONSENT_FLAGS need; where it names none, all are built with the flags.
export function bundlePlan({ cwd = process.cwd(), entries, values, config = null }) {
  const lang = entriesLanguage(entries, cwd)
  const output = outputOptions(values, lang)
  const { keys, first } = configuredKeys(cwd, entries, config)
  if (first === undefined && !lang.jsAndSol) return { ...output, entries, ...buildOptions(values, lang) }
  if (first === undefined) {
    return { ...output, builds: [...Map.groupBy(entries, isJsEntry).values()].map((part) => {
      try {
        return { entries: part, ...buildOptions(values, entriesLanguage(part, cwd)) }
      } catch (cause) {
        throw new Error(`${cause.message}, and ${part[0]} is not of one: give the JS and .sol entries' options apart, in ${CONFIG_FILE}'s entries`, { cause })
      }
    }) }
  }
  const flag = Object.keys(values).find((name) => !OUTPUT_FLAGS.has(name) && !CONSENT_FLAGS.has(name))
  if (flag !== undefined) throw new Error(`--${flag} can't be given for ${first}, whose options ${CONFIG_FILE}'s entries set: set it there`)
  const named = keys.map((key) => config.get(key))
  for (const consent of CONSENT_FLAGS.keys()) {
    const given = values[consent]
    if (given !== undefined && !named.some(({ values: flags }) => flags[consent] === given)) {
      throw new Error(`${flagText(consent, given)} is given, but ${CONFIG_FILE}'s entries set ${flagText(consent, given).slice(2)} for none of ${entries.join(', ')}`)
    }
  }
  const builds = new Map()
  for (const [i, entry] of entries.entries()) {
    const { entry: name, values: flags } = named[i]
    const unconsented = [...CONSENT_FLAGS.keys()].find((consent) => flags[consent] !== undefined && values[consent] !== flags[consent])
    if (unconsented !== undefined) {
      const consent = flagText(unconsented, flags[unconsented])
      throw new Error(`${CONFIG_FILE}: entries ${JSON.stringify(name)} sets ${consent.slice(2)}, which runs ${CONSENT_FLAGS.get(unconsented)}: pass ${consent} to allow it`)
    }
    const what = `${CONFIG_FILE}: entries ${JSON.stringify(name)}: `
    const language = prefixed(what, () => entriesLanguage([entry], cwd))
    addToBuild(builds, entry, named[i], prefixed(what, () => buildOptions(flags, language)), language)
  }
  return { ...output, builds: withPolicies(builds) }
}

// To the build of the same language, options and Policy (the first entry's, relabelled by withPolicies).
function addToBuild(builds, entry, named, options, language) {
  const id = JSON.stringify([language, options, named.policy?.key])
  const build = upsert(builds, id, () => ({ entries: [], ...options, written: [], policy: named.policy }))
  build.entries.push(entry)
  build.written.push(named.entry)
}

function withPolicies(builds, prefix = '') {
  return [...builds.values()].map(({ written, policy, ...build }) => (policy === undefined ? build
    : { ...build, policy: policy.withLabel(`${prefix}${CONFIG_FILE}: entries ${written.map((entry) => JSON.stringify(entry)).join(', ')}`) }))
}

const OPTION_FLAGS = {
  mappingFile: 'mapping', manifests: 'manifests', scope: 'scope', conditions: 'conditions', mainFields: 'mainFields', metro: 'metro', metroResolver: 'metro-resolver', babel: 'babel', babelAliases: 'babel-aliases', platforms: 'platforms', jsx: 'jsx', flow: 'flow', typescript: 'typescript', tsconfig: 'tsconfig', resources: 'resources', define: 'define', packageJSON: 'package-json', cargo: 'cargo', cargoFeatures: 'cargo-features', cargoNoDefaultFeatures: 'cargo-no-default-features', cargoAllFeatures: 'cargo-all-features', cargoTarget: 'cargo-target', cargoManifests: 'cargo-manifests',
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

// The builds of `entries` (by default, all it names) the config names, for a bundle of a project it runs nothing
// of (vfs-bundle's), or null where it names none. Each option given off its default must be what each entry sets.
export function configuredBuilds(name, { cwd, host = diskHost, entries, options = {} }) {
  const config = prefixed(`${name}: `, () => readConfigEntries(cwd, host))
  if (config === null || (entries !== undefined && !Array.isArray(entries))) return null
  if (entries === undefined) {
    entries = [...config.keys()]
    if (entries.length === 0) return { entries, builds: [] }
  }
  const { keys, first } = configuredKeys(cwd, entries, config, `${name}: `)
  if (first === undefined) return null
  const given = Object.keys(OPTION_FLAGS).filter((key) => options[key] !== undefined && comparable(key, options[key]) !== comparable(key, DEFAULT_OPTIONS[key]))
  const builds = new Map()
  for (const [i, entry] of entries.entries()) {
    const named = config.get(keys[i])
    const { entry: written, values } = named
    const what = `${name}: ${CONFIG_FILE}: entries ${JSON.stringify(written)}`
    const running = [...CONSENT_FLAGS.keys()].find((flag) => values[flag] !== undefined)
    if (running !== undefined) throw new Error(`${what} sets ${running}, which runs ${CONSENT_FLAGS.get(running)}, and nothing of the project runs here`)
    const language = prefixed(`${what}: `, () => entriesLanguage([entry], cwd, host))
    const built = prefixed(`${what}: `, () => buildOptions(values, language))
    for (const key of given) {
      if (CONSENT_FLAGS.has(OPTION_FLAGS[key])) continue
      if (comparable(key, options[key]) === comparable(key, built[key])) continue
      const set = comparable(key, built[key]) === comparable(key, DEFAULT_OPTIONS[key]) ? `without --${OPTION_FLAGS[key]}` : `with ${optionText(key, built[key])}`
      throw new Error(`${name}: ${optionText(key, options[key])} is given, but ${CONFIG_FILE}'s entries build ${JSON.stringify(written)} ${set}: an entry it names is built with its options there`)
    }
    addToBuild(builds, entry, named, built, language)
  }
  const running = given.find((key) => CONSENT_FLAGS.has(OPTION_FLAGS[key]))
  if (running !== undefined) throw new Error(`${name}: ${optionText(running, options[running])} is given, which runs ${CONSENT_FLAGS.get(OPTION_FLAGS[running])}, and nothing of the project runs here`)
  return { entries, builds: withPolicies(builds, `${name}: `) }
}
