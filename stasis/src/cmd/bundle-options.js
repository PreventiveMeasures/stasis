import { isAbsolute, relative, resolve } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { isPlainObject, parseBrotliQuality, parseResourcesOption, relativeEscapes, toPosix } from '@exodus/stasis-core/util'
import { parseFeatureList } from '../loaders/cargo.js'
import { parseDefineFlags } from '../define.js'
import { directoryEntryError, isSolidityEntry, readConfigFile } from './bundle.js'

const CONFIG_FILE = 'stasis.config.json'

// `stasis bundle`'s flags, as parseArgs takes them.
export const BUNDLE_FLAGS = {
  mapping: { type: 'string' },
  manifests: { type: 'boolean' },
  output: { type: 'string', short: 'o' },
  scope: { type: 'string' },
  lockfile: { type: 'string' },
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

// The flags of the bundle as a whole: where and how it is written, and where its dependencies are
// read from. Every other one says how its entries are built, which stasis.config.json's `entries`
// sets per entry instead.
const OUTPUT_FLAGS = new Set(['output', 'lockfile', 'brotli-quality', 'add', 'deptree'])
// The entry flags taking a list (comma-separated, or repeated), which an entry's options may give as an array.
const LIST_FLAGS = new Set(['conditions', 'mainFields', 'platforms', 'resources', 'cargo-features'])
// The entry flags given once per value, which a comma doesn't separate (a define's JSON value may
// hold one): an entry's options give them as an array, or one as a string.
const REPEATED_FLAGS = new Set(['define'])
// The entry flags that run a program -> what they run. Set in stasis.config.json, they take effect
// only with the same flag given too (a value one, with the same value), as consent: the config can't
// make a bare `stasis bundle` run anything.
const CONSENT_FLAGS = new Map([
  ['babel', "the project's Babel config"],
  ['metro-resolver', "the project's metro-resolver"],
  ['cargo', "cargo, and what the project's .cargo/config.toml names"],
  ['cargo-target', 'rustc'],
])
// A flag as given: `--name`, or `--name=value` for one taking a value.
const flagText = (name, value) => (value === true ? `--${name}` : `--${name}=${value}`)

// `entry` as a path relative to `cwd` ('.' for cwd itself), or null where it lies out of it.
function entryKey(cwd, entry) {
  const rel = relative(resolve(cwd), resolve(cwd, entry))
  return relativeEscapes(rel) ? null : toPosix(rel) || '.'
}

// The language `entries` share, one bundle being built from one: which of them they all are in, as
// the project in `cwd`, read through `host`, holds them.
function entriesLanguage(entries, cwd, host = diskHost) {
  const dirError = directoryEntryError(entries, cwd, host)
  if (dirError !== null) throw new Error(dirError)
  const lang = {
    allSol: entries.every((f) => isSolidityEntry(f, cwd, host)),
    allPhp: entries.every((f) => f.endsWith('.php')),
    allJs: entries.every((f) => /\.(?:js|cjs|mjs|ts|cts|mts|jsx|tsx)$/u.test(f)),
    allBash: entries.every((f) => /\.(?:sh|bash)$/u.test(f)),
    allRust: entries.every((f) => f.endsWith('.rs')),
  }
  if (!Object.values(lang).some(Boolean)) {
    throw new Error('bundle entries must all be .sol, all be .php, all be .js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx, all be .sh/.bash, or all be .rs')
  }
  return lang
}

// bundleCommand's options for building `entries` (in `lang`, entriesLanguage's) from the parsed
// entry flags in `values`. A usage error throws.
function buildOptions(values, { allSol, allJs, allRust }) {
  if (values.mapping && !allSol) throw new Error('--mapping is only valid for .sol bundles')
  // --manifests: carry the Solidity build's description files (foundry.toml, remappings.txt, ...).
  const manifests = Boolean(values.manifests)
  if (manifests && !allSol) throw new Error('--manifests is only valid for .sol bundles')
  // --cargo: take the Rust feature/dependency resolution from `cargo metadata` (runs cargo; opt-in).
  const cargo = Boolean(values.cargo)
  if (cargo && !allRust) throw new Error('--cargo is only valid for Rust bundles')
  // --cargo-features / --cargo-no-default-features / --cargo-all-features: cargo's own feature flags
  // for the entries' packages (`pkg/feat` targets one, or a dependency). --cargo-features is
  // repeatable and/or comma-separated; parseFeatureList is the one splitter (the resolver reuses it).
  const cargoFeatures = parseFeatureList(values['cargo-features'] ?? [])
  if (values['cargo-features'] !== undefined && cargoFeatures.length === 0) {
    throw new Error('--cargo-features must list at least one feature (e.g. --cargo-features=serde,app/tls)')
  }
  const cargoNoDefaultFeatures = Boolean(values['cargo-no-default-features'])
  const cargoAllFeatures = Boolean(values['cargo-all-features'])
  // --cargo-target=<triple|host>: the build's target, whose cfgs (from `rustc --print cfg`) decide
  // `#[cfg(unix)]`-style code. A triple is letters, digits, `-`, `_` and `.` (`x86_64-unknown-linux-gnu`).
  const cargoTarget = values['cargo-target'] ?? null
  if (cargoTarget !== null && !/^[\w.-]+$/u.test(cargoTarget)) {
    throw new Error('--cargo-target must be a target triple or "host" (e.g. --cargo-target=aarch64-apple-darwin)')
  }
  // --cargo-manifests: carry each bundled package's Cargo.toml and build script, the workspace
  // Cargo.toml, Cargo.lock and .cargo/config.toml too (the Rust counterpart of --package-json).
  const cargoManifests = Boolean(values['cargo-manifests'])
  if (!allRust) {
    const given = { 'cargo-features': cargoFeatures.length > 0, 'cargo-no-default-features': cargoNoDefaultFeatures, 'cargo-all-features': cargoAllFeatures, 'cargo-target': cargoTarget !== null, 'cargo-manifests': cargoManifests }
    for (const [flag, on] of Object.entries(given)) if (on) throw new Error(`--${flag} is only valid for Rust bundles`)
  }
  if (values.scope && !allJs) throw new Error('--scope is only valid for JS bundles')
  if (values.scope && !['node_modules', 'full'].includes(values.scope)) {
    throw new Error('--scope must be node_modules or full')
  }
  // --mainFields/--metro always emit a full-scope bundle, so they'd silently ignore a narrower --scope.
  if (values.scope !== undefined && values.scope !== 'full' && (values.mainFields !== undefined || values.metro)) {
    throw new Error(`--scope=${values.scope} is not supported with --mainFields or --metro (they always build a full-scope bundle)`)
  }
  // --conditions: extra exports/imports resolution conditions merged onto Node's defaults;
  // they don't honour legacy `mainFields` or platform suffixes (see --mainFields).
  if (values.conditions !== undefined && !allJs) throw new Error('--conditions is only valid for JS bundles')
  const conditions = values.conditions === undefined
    ? []
    : values.conditions.split(',').map((s) => s.trim()).filter(Boolean)
  if (values.conditions !== undefined && conditions.length === 0) {
    throw new Error('--conditions must list at least one condition name (e.g. --conditions=react-native,browser)')
  }
  // --metro: resolve like Metro/RN (its own conditions + mainFields, platform suffixes per
  // --platforms target). --platforms is repeatable and/or comma-separated; the values union.
  // It turns on --jsx and --flow, as Metro's Babel parses JSX and Flow in every file (and defines what
  // Metro's release build does, see buildJs).
  const metro = Boolean(values.metro)
  // --flow: strip Flow type syntax (via stasis's own flow-remove-types) from a file marked `@flow`
  // before parsing; JS-only.
  if (values.flow && !allJs) throw new Error('--flow is only valid for JS bundles')
  const flow = Boolean(values.flow) || metro
  // --typescript: resolve like tsc -- a specifier naming a missing JS output (./x.js, .mjs, .cjs,
  // extensionless) lands on its on-disk TS source (./x.ts, .mts, .cts); an existing .js always wins.
  if (values.typescript && !allJs) throw new Error('--typescript is only valid for JS bundles')
  const typescript = Boolean(values.typescript)
  // --tsconfig: the config whose compilerOptions.paths aliases --typescript honours (default: the
  // tsconfig.json beside each importing file's package.json). Meaningless without --typescript.
  if (values.tsconfig !== undefined && !typescript) throw new Error('--tsconfig is only valid with --typescript')
  // --mainFields: legacy package entry fields (e.g. react-native,browser,main) for the non-exports resolver.
  if (values.mainFields !== undefined && !allJs) throw new Error('--mainFields is only valid for JS bundles')
  const mainFields = values.mainFields === undefined
    ? undefined
    : values.mainFields.split(',').map((s) => s.trim()).filter(Boolean)
  if (values.mainFields !== undefined && mainFields.length === 0) {
    throw new Error('--mainFields must list at least one field (e.g. --mainFields=react-native,browser,main)')
  }
  // --metro-resolver: resolve through the project's own metro-resolver instead of the built-in
  // approximation. Only meaningful alongside --metro (enforced below and in classifyEntries).
  const metroResolver = Boolean(values['metro-resolver'])
  const platforms = [...new Set((values.platforms ?? []).flatMap((p) => p.split(',')).map((s) => s.trim()).filter(Boolean))]
  // A platform name becomes an edge key: reject '/' (parsers reject it) and '*' (reserved placeholder).
  for (const p of platforms) {
    if (p === '*' || p.includes('/')) throw new Error(`invalid --platforms value '${p}' (a platform name can't contain '/' or be '*')`)
  }
  if ((metro || platforms.length > 0) && !allJs) throw new Error('--metro is only valid for JS bundles')
  // --jsx: parse React Native's JSX-in-.js source in the static scanner (off by default; oxc,
  // like tsc, auto-enables JSX for .jsx/.tsx only). Orthogonal to the resolver, so it pairs with
  // plain/--mainFields/--metro alike -- JS-only, since no other entry language is scanned. On under --metro.
  const jsx = Boolean(values.jsx) || metro
  if (jsx && !allJs) throw new Error('--jsx is only valid for JS bundles')
  // --package-json: fold each bundled module's package.json into the bundle. JS-only (only JS
  // modules carry an npm package.json; the sol/php/bash/rust bucketizers have no such manifest).
  const packageJSON = Boolean(values['package-json'])
  if (packageJSON && !allJs) throw new Error('--package-json is only valid for JS bundles')
  // --resources: comma-separated extension/filename allowlist for assets reached through the graph
  // (e.g. --resources=png,svg). They're carried as resources instead of failing "can't carry" --
  // for graphs that aren't fully loadable in JS (Metro consumes such assets). JS-only.
  if (values.resources !== undefined && !allJs) throw new Error('--resources is only valid for JS bundles')
  const resources = values.resources === undefined
    ? undefined
    : values.resources.split(',').map((s) => s.trim()).filter(Boolean)
  if (values.resources !== undefined && resources.length === 0) {
    throw new Error('--resources must list at least one extension or filename (e.g. --resources=png,svg)')
  }
  parseResourcesOption('--resources', resources) // validate early for a clean usage error (code exts / bad chars rejected)
  if (metro) {
    if (conditions.length > 0) throw new Error("--conditions can't be combined with --metro (it sets its own conditions)")
    if (mainFields !== undefined) throw new Error("--mainFields can't be combined with --metro (it sets its own mainFields)")
    if (platforms.length === 0) throw new Error('--metro requires --platforms (e.g. --platforms=ios,android)')
  } else if (platforms.length > 0) {
    throw new Error('--platforms is only valid with --metro')
  }
  if (metroResolver && !metro) throw new Error('--metro-resolver is only valid with --metro')
  // --babel: resolve through the import aliases (babel-plugin-module-resolver) of the project's
  // babel.config.*, which Metro runs before it resolves. Runs that config, so opt-in; --metro only.
  const babel = Boolean(values.babel)
  if (babel && !metro) throw new Error('--babel is only valid with --metro')
  // --babel-aliases: the same aliases from a JSON file of the project (module-resolver's `alias` option as
  // data), which runs nothing, so stasis.config.json's entries may set it alone. --metro only.
  if (values['babel-aliases'] !== undefined && !metro) throw new Error('--babel-aliases is only valid with --metro')
  if (values['babel-aliases'] !== undefined && babel) throw new Error("--babel-aliases can't be combined with --babel (both set the import aliases)")
  // metro-resolver can't substitute .js -> .ts, so --typescript would silently not apply -- reject it.
  if (typescript && metroResolver) throw new Error("--typescript is not supported with --metro-resolver (the project's metro-resolver doesn't substitute .js -> .ts)")
  // --define=KEY=VALUE: a global's value (JSON), repeatable; the scan leaves out the imports of the
  // branches the values keep from running (`if (__DEV__)` under __DEV__=false). JS-only.
  if (values.define !== undefined && !allJs) throw new Error('--define is only valid for JS bundles')
  const define = values.define === undefined ? undefined : parseDefineFlags(null, values.define)
  return { mappingFile: values.mapping, manifests, scope: values.scope, conditions, mainFields, metro, metroResolver, babel, babelAliases: values['babel-aliases'], platforms, jsx, flow, typescript, tsconfig: values.tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }
}

// The CONSENT_FLAGS that run a program of the project's from disk, which needs what it installs on
// disk: none that --deptree lays out in memory.
const DISK_RUN_FLAGS = ['babel', 'metro-resolver']

// bundleCommand's options for writing the bundle of entries in `lang` from the parsed output flags in `values`.
function outputOptions(values, { allJs, allSol }) {
  if (values.lockfile && !allJs) throw new Error('--lockfile is only valid for JS bundles')
  // --deptree: the dependencies laid out in memory from the lockfile (pnpm, yarn 1, npm or Soldeer's),
  // never read from disk, which holds none.
  const deptree = Boolean(values.deptree)
  if (deptree && !allJs && !allSol) throw new Error('--deptree is only valid for JS and .sol bundles')
  for (const flag of deptree ? DISK_RUN_FLAGS : []) {
    if (values[flag]) throw new Error(`--${flag} can't be combined with --deptree (it runs ${CONSENT_FLAGS.get(flag)} from disk, where --deptree installs nothing)`)
  }
  // --brotli-quality: valid for every entry language (no allJs gate).
  const brotliQuality = values['brotli-quality'] === undefined ? undefined : parseBrotliQuality('--brotli-quality', values['brotli-quality'])
  // --add merges into the existing bundle at --output, so it can't target write-only stdout.
  const add = Boolean(values.add)
  if (add && values.output === '-') throw new Error('--add cannot be combined with --output=-')
  return { output: values.output, lockfile: values.lockfile, brotliQuality, add, deptree }
}

// An entry's options in stasis.config.json's `entries` (`what` names it) as the flags they alias, in
// parseArgs' shape: `true` for a boolean flag set (`false`, its default, is no flag), a string for one
// taking a value, which a list flag takes as an array too, and an array of it for a repeatable one
// (each of a REPEATED_FLAGS one's values, as given).
function entryFlags(what, options) {
  if (!isPlainObject(options)) throw new Error(`${what} must be an object of stasis bundle options`)
  const values = {}
  for (const [flag, value] of Object.entries(options)) {
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

// The `entries` of the stasis.config.json in `cwd`: each entry it names, as a path relative to cwd
// -> { entry: the name as written, values: its options as flags (entryFlags') }. null where there is
// none.
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
    named.set(key, { entry, values: entryFlags(what, options) })
  }
  return named
}

// bundleCommand's options for bundling `entries` with the parsed flags `values` in `cwd`, whose
// stasis.config.json's `entries` is `config` (readConfigEntries'). Where it names every entry, each is
// built with its options there, the ones with the same options together (a build each), and none
// may be given as a flag but the bundle's own (OUTPUT_FLAGS) and the consent to a CONSENT_FLAGS
// option, which an entry setting it needs and some entry must set. Where it names none, they are all
// built with the flags; it may not name only some. A usage error throws.
export function bundlePlan({ cwd = process.cwd(), entries, values, config = null }) {
  const lang = entriesLanguage(entries, cwd)
  const output = outputOptions(values, lang)
  const keys = entries.map((entry) => entryKey(cwd, entry))
  const configured = config === null ? [] : entries.filter((_, i) => config.has(keys[i]))
  if (configured.length === 0) return { ...output, entries, ...buildOptions(values, lang) }
  const unnamed = entries.find((_, i) => !config.has(keys[i]))
  if (unnamed !== undefined) {
    throw new Error(`${CONFIG_FILE}'s entries name ${configured[0]} but not ${unnamed}: bundle either the entries it names or others, not both`)
  }
  const flag = Object.keys(values).find((name) => !OUTPUT_FLAGS.has(name) && !CONSENT_FLAGS.has(name))
  if (flag !== undefined) throw new Error(`--${flag} can't be given for ${configured[0]}, whose options ${CONFIG_FILE}'s entries set: set it there`)
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
    let options
    try {
      options = buildOptions(flags, entriesLanguage([entry], cwd))
    } catch (cause) {
      throw new Error(`${CONFIG_FILE}: entries ${JSON.stringify(name)}: ${cause.message}`, { cause })
    }
    const id = JSON.stringify(options)
    if (builds.has(id)) builds.get(id).entries.push(entry)
    else builds.set(id, { entries: [entry], ...options })
  }
  return { ...output, builds: [...builds.values()] }
}

// buildOptions' options, each by the flag it is given as; and those whose values are a set, in
// whatever order given (each value of `resources` as parseResourcesOption takes it).
const OPTION_FLAGS = {
  mappingFile: 'mapping', manifests: 'manifests', scope: 'scope', conditions: 'conditions', mainFields: 'mainFields', metro: 'metro', metroResolver: 'metro-resolver', babel: 'babel', babelAliases: 'babel-aliases', platforms: 'platforms', jsx: 'jsx', flow: 'flow', typescript: 'typescript', tsconfig: 'tsconfig', resources: 'resources', define: 'define', packageJSON: 'package-json', cargo: 'cargo', cargoFeatures: 'cargo-features', cargoNoDefaultFeatures: 'cargo-no-default-features', cargoAllFeatures: 'cargo-all-features', cargoTarget: 'cargo-target', cargoManifests: 'cargo-manifests',
}
const SET_OPTIONS = new Set(['conditions', 'platforms', 'resources', 'cargoFeatures'])
// buildOptions' options where no flag is given.
const DEFAULT_OPTIONS = buildOptions({}, {})
// An option's value as compared: a set's sorted, defines by name, none (null) for no value or no define.
const comparable = (key, value) => {
  if (value === undefined || value === null || (key === 'define' && isPlainObject(value) && Object.keys(value).length === 0)) return 'null'
  if (key === 'resources' && Array.isArray(value)) value = value.map((v) => (typeof v === 'string' ? v.toLowerCase().replace(/^\./u, '') : v))
  if (SET_OPTIONS.has(key) && Array.isArray(value)) return JSON.stringify([...new Set(value)].toSorted())
  if (key === 'define' && isPlainObject(value)) return JSON.stringify(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1)))
  return JSON.stringify(value)
}
// An option as its flags give it: `--jsx`, `--platforms=ios,android`, `--define=__DEV__=false`.
const optionText = (key, value) => (key === 'define'
  ? Object.entries(value).map(([name, v]) => `--define=${name}=${JSON.stringify(v)}`).join(' ')
  : flagText(OPTION_FLAGS[key], Array.isArray(value) ? value.join(',') : value))

// The builds of `entries` that the stasis.config.json in `cwd` (read through `host`) names in its
// `entries`, for `name`'s bundle, built from a project it runs nothing of
// (@exodus/stasis/vfs-bundle's): every entry it names where none are given (none, of an empty
// `entries`: nothing else stands in for them), as paths from `cwd`.
// -> { entries, builds }, each build `{ entries, ...options }` with the options there (buildOptions'),
// the entries with the same ones together; null where it names none of those given, or has no
// `entries`: they are built with `options` alone. It may not name only some. Each of `options`
// (buildOptions' shape) given other than at its default has to be the one each entry's options
// set, else it is refused, neither taken over them nor left aside; one left out is theirs. One that
// runs a program (CONSENT_FLAGS'), set by an entry or given, is refused: nothing of the project
// runs, so no option allows it. A usage error throws.
export function configuredBuilds(name, { cwd, host = diskHost, entries, options = {} }) {
  const prefixed = (fn, what = `${name}: `) => {
    try {
      return fn()
    } catch (cause) {
      throw new Error(`${what}${cause.message}`, { cause })
    }
  }
  const config = prefixed(() => readConfigEntries(cwd, host))
  if (config === null || (entries !== undefined && !Array.isArray(entries))) return null
  if (entries === undefined) {
    entries = [...config.keys()]
    if (entries.length === 0) return { entries, builds: [] }
  }
  const keys = entries.map((entry) => entryKey(cwd, entry))
  const configured = entries.filter((_, i) => config.has(keys[i]))
  if (configured.length === 0) return null
  const unnamed = entries.find((_, i) => !config.has(keys[i]))
  if (unnamed !== undefined) {
    throw new Error(`${name}: ${CONFIG_FILE}'s entries name ${configured[0]} but not ${unnamed}: bundle either the entries it names or others, not both`)
  }
  const given = Object.keys(OPTION_FLAGS).filter((key) => options[key] !== undefined && comparable(key, options[key]) !== comparable(key, DEFAULT_OPTIONS[key]))
  const builds = new Map()
  for (const [i, entry] of entries.entries()) {
    const { entry: written, values } = config.get(keys[i])
    const what = `${name}: ${CONFIG_FILE}: entries ${JSON.stringify(written)}`
    const running = [...CONSENT_FLAGS.keys()].find((flag) => values[flag] !== undefined)
    if (running !== undefined) throw new Error(`${what} sets ${running}, which runs ${CONSENT_FLAGS.get(running)}, and nothing of the project runs here`)
    const built = prefixed(() => buildOptions(values, entriesLanguage([entry], cwd, host)), `${what}: `)
    for (const key of given) {
      if (CONSENT_FLAGS.has(OPTION_FLAGS[key])) continue
      if (comparable(key, options[key]) === comparable(key, built[key])) continue
      const set = comparable(key, built[key]) === comparable(key, DEFAULT_OPTIONS[key]) ? `without --${OPTION_FLAGS[key]}` : `with ${optionText(key, built[key])}`
      throw new Error(`${name}: ${optionText(key, options[key])} is given, but ${CONFIG_FILE}'s entries build ${JSON.stringify(written)} ${set}: an entry it names is built with its options there`)
    }
    const id = JSON.stringify(built)
    if (builds.has(id)) builds.get(id).entries.push(entry)
    else builds.set(id, { entries: [entry], ...built })
  }
  const running = given.find((key) => CONSENT_FLAGS.has(OPTION_FLAGS[key]))
  if (running !== undefined) throw new Error(`${name}: ${optionText(running, options[running])} is given, which runs ${CONSENT_FLAGS.get(OPTION_FLAGS[running])}, and nothing of the project runs here`)
  return { entries, builds: [...builds.values()] }
}
