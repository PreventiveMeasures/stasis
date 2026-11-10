// Cargo manifests for the Rust loader: Cargo.toml, Cargo.lock and cargo configs read by
// @preventive/lockfile, dependency resolution among in-tree crates (path deps, `cargo vendor`ed ones)
// and feature resolution as `cargo build` does it -- cargo's own resolver where it can run, else a replay.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep } from 'node:path'

import { readText } from '@exodus/stasis-core/bundle-util'
import { diskHost } from '@exodus/stasis-core/host'
import { canonicalizePath } from '@exodus/stasis-core/state-util'
import { archiveIntegrity, fromEntries, isPlainObject, memoized, nestedMap, posixPathEscapes, relativeEscapes, toPosix, upsert } from '@exodus/stasis-core/util'

import { LockfileError, linkCargo, parseCargoConfig, parseCargoLock, parseCargoManifest as readCargoManifest, readCargoVendor, resolveCargoFeatures } from '@preventive/lockfile/cargo.js'
import { matches, parseVersion, parseVersionReq } from '@preventive/lockfile/rust-semver.js'

import { isFile } from '../resolve-typescript.js'
import { ancestors } from './paths.js'
import { TomlError, isTomlTable, nameErrors, readToml, splitTopLevel } from './toml.js'

// `cargo vendor` copies registry crates in-tree under this dir.
export const VENDOR_DIR = 'vendor'

// A crate name as source spells it (`use proc_macro2`): Cargo allows `-`, rustc doesn't.
export const normName = (name) => name.replaceAll('-', '_')


// A TOML value that is a table, else null.
const table = (v) => (isTomlTable(v) ? v : null)

// --- Paths ---------------------------------------------------------------------------

// Project-relative `sub` under `dir`, normalized; null when it escapes the bundle root.
export function normalizeRel(dir, sub) {
  if (isAbsolute(sub) || posix.isAbsolute(sub)) return null
  const rel = posix.normalize(posix.join(dir === '.' ? '' : dir, sub))
  return posixPathEscapes(rel) ? null : rel
}

// --- Cargo.toml -----------------------------------------------------------------------

// A `[features]` entry asking a feature of a dependency: `key/feat` or `key?/feat`.
const DEP_FEATURE_RE = /^([^/?]+)(\?)?\/(.+)$/u

// `--features a,b pkg/c` (cargo's syntax: repeatable, comma- or space-separated) → the list of names.
export function parseFeatureList(values) {
  return [...new Set(values.flatMap((s) => s.split(/[\s,]+/u)).filter(Boolean))]
}

// The first directory of a file's path inside the package at `pkgDir`.
const targetDirOf = (pkgDir, fileRel) => (pkgDir !== '.' && pkgDir !== '' && fileRel.startsWith(`${pkgDir}/`) ? fileRel.slice(pkgDir.length + 1) : fileRel).split('/')[0]

// Whether a source file belongs to a test or bench target of the package at `pkgDir` (`tests/*.rs`,
// `benches/*.rs` and what they declare): rustc compiles those with `cfg(test)`.
export function isTestTargetPath(pkgDir, fileRel) {
  return ['tests', 'benches'].includes(targetDirOf(pkgDir, fileRel))
}

// `read()`, with a TomlError or LockfileError it throws naming `file`.
const readNamed = (file, read) => nameErrors(file, read, [TomlError, LockfileError])

// A dependency table's key among its dependency's requests: `<kind>` or `<kind>@<platform>`.
const requestKey = (d) => (d.target === undefined ? d.kind : `${d.kind}@${d.target}`)

// A Cargo.toml as @preventive/lockfile reads it (`cargo`; what a member inherits from `workspace`,
// the root's, applied), plus the lib target and build script. `deps` are keyed by `use` spelling,
// each table (`normal`, `build`, `dev@cfg(windows)`) a request of its own. Throws naming `file`.
export const parseCargoManifest = (text, file = null, workspace = null) => manifestOf(text, readToml(text, file), file, workspace)
function manifestOf(text, doc, file, workspace) {
  const root = workspace?.cargo.workspace === undefined ? undefined : workspace.cargo
  const cargo = readNamed(file, () => readCargoManifest(text, isTomlTable(doc.workspace) ? undefined : root))
  const pkg = cargo.package
  const lib = table(doc.lib)
  const build = table(doc.package ?? doc.project)?.build
  const deps = new Map()
  for (const d of pkg?.dependencies ?? []) {
    const key = normName(d.name)
    upsert(deps, key, () => ({ key, name: d.name, kinds: new Map() })).kinds.set(requestKey(d), {
      kind: d.kind,
      target: d.target ?? null,
      version: d.version ?? null,
      path: d.source.type === 'path' ? d.source.path : null,
      source: d.source.type,
      // where from: a git dependency's repository URL, another registry's name or index than crates.io's
      origin: d.source.type === 'git' ? d.source.url : (d.source.type === 'registry' ? d.source.registry ?? d.source.index ?? null : null),
      package: d.package,
      renamed: d.package !== d.name,
      inherited: d.inherited,
      optional: d.optional,
      defaultFeatures: d.defaultFeatures,
      features: d.features,
    })
  }
  return {
    cargo,
    package: pkg === undefined ? null : { name: pkg.name, version: pkg.version, edition: pkg.edition, build: typeof build === 'string' || build === false ? build : null },
    resolver: cargo.workspace?.resolver ?? pkg?.resolver ?? null,
    isWorkspace: cargo.workspace !== undefined,
    lib: { name: typeof lib?.name === 'string' ? lib.name : null, path: typeof lib?.path === 'string' ? lib.path : null, procMacro: pkg?.procMacro === true },
    deps,
  }
}

// Whether `version` satisfies the Cargo requirement `req` by the semver crate's rules: a prerelease
// only where the requirement names one of its major, minor and patch.
const satisfies = (version, req) => {
  const v = parseVersion(version)
  const comparators = parseVersionReq(req)
  return v !== undefined && comparators !== undefined && matches(comparators, v)
}

// --- cargo metadata -------------------------------------------------------------------

// The Cargo.lock governing `baseDir`: beside the nearest manifest at or above it with a `[workspace]`,
// as cargo finds it, else beside `baseDir`'s own. A lock further up is another project's: `--locked`
// for it would make cargo refuse to create the one it needs.
export function findCargoLock(baseDir, host = diskHost) {
  const root = ancestors(baseDir).find((dir) => {
    const file = join(dir, 'Cargo.toml')
    const text = readText(host, file)
    return text !== null && 'workspace' in readToml(text, file)
  }) ?? baseDir
  const candidate = join(root, 'Cargo.lock')
  return isFile(candidate, host) ? candidate : null
}

// --- cfg predicates ---------------------------------------------------------------------

// A cfg predicate with its whitespace collapsed outside string literals: `my = "a  b"` and
// `my = "a b"` are two values.
export const normalizeCfg = (pred) => pred.replaceAll(/"(?:[^"\\]|\\.)*"|\s+/gu, (m) => (m.startsWith('"') ? m : ' ')).trim()

// A cfg name as written, a raw identifier's `r#` dropped -- but `r#true` and `r#false`, names apart
// from the literals `true` and `false`.
export const cfgName = (written) => (/^r#(?:true|false)$/u.test(written) ? written : written.replace(/^r#/u, ''))

// A leaf: `unix`, `target_os = "linux"`, a raw identifier's `r#` dropped.
const CFG_LEAF_RE = /^(?:r#)?([A-Za-z_]\w*)\s*(?:=\s*"([^"]*)")?$/u

// The cfg keys rustc sets from the target alone (`rustc --print cfg --target <triple>`). Not among
// them: what the build profile sets (`debug_assertions`, `panic`), `target_feature`, which the build
// may change (`-C target-cpu=native`), and `target_thread_local`, which a stable rustc never prints.
export const TARGET_CFG_KEYS = new Set(['unix', 'windows', 'target_abi', 'target_arch', 'target_endian', 'target_env', 'target_family', 'target_has_atomic', 'target_os', 'target_pointer_width', 'target_vendor'])

// Three-valued evaluation of a cfg predicate: false when it never holds in the build (what it gates is
// dead code), true when it always does, null when unknown. An unknown leaf met more than once is tried
// both ways (up to six of them): `all(any(test, kani), not(kani))` never holds.
const MAX_FREE_CFG_LEAVES = 6
export function evalCfg(pred, env = {}) {
  if (env.units) return unanimous(env.units.map((u) => evalCfg(pred, u)))
  const free = { counts: null } // unknown leaf → how often it occurs, once one is met
  const r = evalCfgWith(pred, env, null, free)
  if (r !== null || free.counts === null || free.counts.size > MAX_FREE_CFG_LEAVES || free.counts.values().every((n) => n === 1)) return r
  const leaves = [...free.counts.keys()]
  let out
  for (let bits = 0; bits < 1 << leaves.length; bits++) {
    const v = evalCfgWith(pred, env, new Map(leaves.map((l, k) => [l, ((bits >> k) & 1) === 1])))
    if (out === undefined) out = v
    else if (v !== out) return null
  }
  return out
}
// evalCfg's three-valued pass: an unknown leaf takes its value from `assume` (leaf → value) when
// that has it, else is counted in `free.counts`.
function evalCfgWith(pred, env, assume, free = null) {
  const p = pred.trim()
  const m = /^(all|any|not)\s*\(([\s\S]*)\)$/u.exec(p)
  if (!m) {
    if (p === 'true' || p === 'false') return p === 'true' // the literals (rustc 1.88); `r#true` is a name
    const kv = CFG_LEAF_RE.exec(p)
    const known = kv === null ? null : evalCfgKey(kv[1], kv[2] ?? null, env)
    if (known !== null) return known
    // The same leaf however it is spaced, its value as written.
    const leaf = kv === null ? p : (kv[2] === undefined ? kv[1] : `${kv[1]}="${kv[2]}"`)
    if (assume?.has(leaf)) return assume.get(leaf)
    if (free !== null) (free.counts ??= new Map()).set(leaf, (free.counts.get(leaf) ?? 0) + 1)
    return null
  }
  const args = splitTopLevel(m[2]).map((a) => a.trim()).filter(Boolean).map((a) => evalCfgWith(a, env, assume, free))
  if (m[1] === 'not') return args.length === 1 && args[0] !== null ? !args[0] : null
  if (m[1] === 'all') return args.includes(false) ? false : (args.every((a) => a === true) ? true : null)
  return args.includes(true) ? true : (args.every((a) => a === false) ? false : null)
}
// The verdict on one leaf other than a literal, by key and value (null for a bare `unix`): `test`
// per `env.test`, never `doc`/`doctest`, `feature` per `env.features` (certain) and `maybeFeatures`,
// a target key per `env.target` (rustc's cfg set); unknown otherwise, or without those sets.
export function evalCfgKey(key, value, env) {
  if (env.units) return unanimous(env.units.map((u) => evalCfgKey(key, value, u)))
  if (value === null && key === 'test') return env.test === true
  if (value === null && (key === 'doctest' || key === 'doc')) return false
  if (key === 'feature' && value !== null) {
    if (!env.features) return null
    if (env.features.has(value)) return true
    return env.maybeFeatures?.has(value) ? null : false
  }
  if (env.target && TARGET_CFG_KEYS.has(key)) return env.target.has(value === null ? key : `${key}="${value}"`)
  return null
}
// Code compiled several ways (`env.units`): false only when false in each, true only when true in each.
const unanimous = (each) => (each.every((r) => r === false) ? false : (each.every((r) => r === true) ? true : null))

// `rustc --print cfg` output → the set of cfg leaves as printed, one per line (`unix`,
// `target_os="linux"`).
export function parseRustcCfg(text) {
  return new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))
}

// How long a toolchain query may take before it counts as hung.
const TOOL_TIMEOUT_MS = 60_000
// Never let rustup install a toolchain on the loader's behalf, whatever a `rust-toolchain` file says.
const TOOL_ENV = { ...process.env, RUSTUP_AUTO_INSTALL: '0' }
// Where rustc runs from. A rustup proxy obeys the `rust-toolchain(.toml)` of its cwd and parents, which
// may name any binary: never the (untrusted) project nor a world-writable temp dir, but the home
// directory -- unless it is or lies inside the bundle root, then the filesystem root.
function toolCwd(baseDir) {
  const home = homedir()
  const root = parse(process.cwd()).root
  if (!home) return root
  if (baseDir === null) return home
  // Real paths: a home directory or bundle root reached through a link is where it really is.
  const base = canonicalizePath(baseDir)
  const homeAbs = canonicalizePath(home)
  return homeAbs === base || homeAbs.startsWith(base.endsWith(sep) ? base : base + sep) ? root : home
}

// Run rustc from toolCwd: `$RUSTC` when set, as cargo honours it (a target only another toolchain
// knows, as Solana's), else `rustc` from PATH; with RUSTUP_AUTO_INSTALL=0 a missing toolchain fails.
function rustc(args, what, baseDir) {
  const bin = process.env.RUSTC || 'rustc'
  const r = spawnSync(bin, args, { cwd: toolCwd(baseDir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TOOL_TIMEOUT_MS, env: TOOL_ENV })
  if (r.error) throw new Error(`${bin} could not run (${r.error.message}); ${what} needs rustc on PATH (or $RUSTC)`, { cause: r.error })
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (exit ${r.status}):\n${(r.stderr ?? '').trim()}`)
  return r.stdout
}

// The cfg set of a target as `{ triple, cfgs }`, from `rustc --print cfg --target <triple>` (no
// standard library needed); `host` is the running rustc's host triple. `baseDir`: see toolCwd.
export function rustcTargetCfgs(target, baseDir = null) {
  const triple = target === 'host' ? /^host: (\S+)$/mu.exec(rustc(['-vV'], '--cargo-target=host', baseDir))?.[1] ?? null : target
  if (triple === null) throw new Error('rustc -vV printed no host triple')
  return { triple, cfgs: parseRustcCfg(rustc(['--print', 'cfg', '--target', triple], '--cargo-target', baseDir)) }
}

// `cargo metadata`'s JSON for a build run in `dir`. Opt-in (`--cargo`): cargo reads the project's
// `.cargo/config.toml` and may touch the registry (doc/file-formats.md). `--locked` with a lockfile
// keeps the resolution the build's; `platform`, a triple, restricts the graph to that target.
function runCargoMetadata(dir, { features, noDefaultFeatures, allFeatures, platform }) {
  const args = ['metadata', '--format-version', '1']
  // The workspace's lock may sit above the bundle root: never let metadata rewrite it.
  if (findCargoLock(dir) !== null) args.push('--locked')
  if (allFeatures) args.push('--all-features')
  if (noDefaultFeatures) args.push('--no-default-features')
  for (const f of features) args.push('--features', f)
  if (platform !== null) args.push('--filter-platform', platform)
  const r = spawnSync('cargo', args, { cwd: dir, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) throw new Error(`cargo metadata could not run (${r.error.message}); is cargo on PATH?`, { cause: r.error })
  if (r.status !== 0) throw new Error(`cargo metadata failed (exit ${r.status}):\n${(r.stderr ?? '').trim()}`)
  return JSON.parse(r.stdout)
}

// `cargo metadata` JSON → `{ enabled: Map<dir, Set<feature>>, deps: Map<dir, Map<useName, dir>>,
// lacking: [{ dir, key, name, kinds }] }` over the packages inside the bundle root or found vendored by
// `locate(name, version)`; a dependency on any other can't be bundled: it is `lacking`.
export function resolutionFromMetadata(metadata, baseDir, { locate = null } = {}) {
  let realBase = baseDir
  try {
    realBase = realpathSync(baseDir)
  } catch { /* keep the lexical path */ }
  const relDir = (manifestPath) => {
    if (typeof manifestPath !== 'string') return null
    const dir = dirname(manifestPath)
    for (const base of new Set([baseDir, realBase])) {
      const rel = toPosix(relative(base, dir))
      if (rel === '') return '.'
      if (!relativeEscapes(rel)) return rel
    }
    return null
  }
  const dirOf = new Map()
  for (const p of metadata.packages ?? []) {
    const dir = relDir(p.manifest_path) ?? locate?.(p.name, p.version) ?? null
    if (dir !== null) dirOf.set(p.id, dir)
  }
  const nameOf = new Map((metadata.packages ?? []).map((p) => [p.id, p.name]))
  const enabled = new Map()
  const deps = new Map()
  const lacking = []
  for (const node of metadata.resolve?.nodes ?? []) {
    const dir = dirOf.get(node.id)
    if (dir === undefined) continue
    enabled.set(dir, new Set((node.features ?? []).filter((f) => typeof f === 'string')))
    const byName = new Map()
    for (const d of node.deps ?? []) {
      const target = dirOf.get(d.pkg)
      if (target !== undefined) {
        if (typeof d.name === 'string') byName.set(normName(d.name), target)
        continue
      }
      const name = nameOf.get(d.pkg) ?? d.name
      lacking.push({ dir, key: normName(name), name, kinds: new Set((Array.isArray(d.dep_kinds) ? d.dep_kinds : [{ kind: null }]).map((k) => k?.kind ?? 'normal')) })
    }
    deps.set(dir, byName)
  }
  return { enabled, deps, lacking }
}

// The cargo config file in absolute directory `abs`: `.cargo/config`, which cargo prefers, else
// `.cargo/config.toml`; null when there is neither.
const cargoConfigAt = (abs) => ['.cargo/config', '.cargo/config.toml'].map((f) => join(abs, f)).find((file) => isFile(file)) ?? null

// The cargo configs a build run in `from` (project-relative) reads, nearest first up to the
// filesystem's root ($CARGO_HOME's aside), as `{ dir, abs, file, text, doc }`: `dir` holds its
// `.cargo`, project-relative (null above the bundle root), `abs` absolute; `file` from the bundle root.
function cargoConfigs(baseDir, from) {
  const baseAbs = resolve(baseDir)
  const out = []
  for (const abs of ancestors(join(baseAbs, from))) {
    const found = cargoConfigAt(abs)
    const text = found === null ? null : readText(diskHost, found)
    if (text !== null) {
      const file = toPosix(relative(baseAbs, found))
      out.push({ dir: projectRel(baseAbs, abs), abs, file, text, doc: readToml(text, file) })
    }
  }
  return out
}
// A path a cargo config or manifest in absolute `absDir` writes (relative to that directory, as cargo
// takes it), project-relative from the bundle root `baseAbs`; null outside it.
const projectRel = (baseAbs, absDir, path = '.') => normalizeRel('.', toPosix(relative(baseAbs, resolve(absDir, path))))

// The directory `cargo vendor` filled, as cargo configs `configs` say: the `directory` of the source
// `[source.crates-io] replace-with` names (through any chain), else of the one source some
// `replace-with` names, else `vendor`. One outside the bundle root or missing is warned of unless `quiet`.
function vendorDirOf(baseDir, configs, { quiet = false } = {}) {
  // source name -> { replaceWith, directory: { path, config } }, each key from the nearest config
  const sources = new Map()
  for (const config of configs) {
    for (const [name, fields] of Object.entries(table(config.doc.source) ?? {})) {
      if (!isTomlTable(fields)) continue
      const s = upsert(sources, name, () => ({ replaceWith: null, directory: null }))
      if (s.replaceWith === null && typeof fields['replace-with'] === 'string') s.replaceWith = fields['replace-with']
      if (s.directory === null && typeof fields.directory === 'string') s.directory = { path: fields.directory, config }
    }
  }
  const follow = (name) => {
    const seen = new Set()
    for (let s = sources.get(name); s && !seen.has(s); s = sources.get(s.replaceWith)) {
      seen.add(s)
      if (s.directory !== null) return s.directory
      if (s.replaceWith === null) return null
    }
    return null
  }
  const replaced = new Set(sources.values().map((s) => (s.replaceWith === null ? null : follow(s.replaceWith))).filter((d) => d !== null))
  const found = follow('crates-io') ?? (replaced.size === 1 ? [...replaced][0] : null)
  if (found === null) return VENDOR_DIR
  const norm = projectRel(resolve(baseDir), found.config.abs, found.path)?.replace(/\/+$/u, '') || null
  if (norm === null) {
    if (!quiet) console.warn(`[loader.cargo] ${found.config.file} names a vendored source directory outside the bundle root: ${found.path}`)
    return VENDOR_DIR
  }
  if (!quiet && !existsSync(join(baseDir, norm))) console.warn(`[loader.cargo] ${found.config.file} names a vendored source directory that doesn't exist: ${norm}`)
  return norm
}

// The `--cfg` names in rustflags: `--cfg name`, `--cfg=name`, `--cfg 'name="value"'`.
function cfgFlags(flags) {
  const out = []
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    const arg = flag === '--cfg' ? flags[++i] : (flag.startsWith('--cfg=') ? flag.slice('--cfg='.length) : null)
    const name = typeof arg === 'string' ? /^(?:r#)?[A-Za-z_]\w*/u.exec(arg)?.[0] : undefined
    if (name !== undefined) out.push(cfgName(name))
  }
  return out
}
// The cfgs the rustflags of a build may set: those of `build.rustflags` and every
// `target.<…>.rustflags` of its cargo configs, and of CARGO_ENCODED_RUSTFLAGS, RUSTFLAGS and CARGO_BUILD_RUSTFLAGS.
function rustflagsCfgsOf(configs) {
  const names = new Set()
  const add = (value) => {
    const flags = Array.isArray(value) ? value.filter((f) => typeof f === 'string') : (typeof value === 'string' ? value.split(/\s+/u).filter(Boolean) : [])
    for (const name of cfgFlags(flags)) names.add(name)
  }
  for (const { doc } of configs) {
    add(table(doc.build)?.rustflags)
    for (const target of Object.values(table(doc.target) ?? {})) add(table(target)?.rustflags)
  }
  const { env } = process
  if (env.CARGO_ENCODED_RUSTFLAGS) add(env.CARGO_ENCODED_RUSTFLAGS.split('\u001F'))
  for (const v of [env.RUSTFLAGS, env.CARGO_BUILD_RUSTFLAGS]) if (v) add(v)
  return names
}
// The cfgs build-script code may print as `cargo:rustc-cfg=<name>` (or `cargo::`), outside full-line
// comments: `names`, and `any` when it may print one the loader can't read (a formatted name, as
// cfg_aliases does, the directive apart from the name, as build-rs's `rustc_cfg`, `autocfg`'s probes).
const RUSTC_CFG_RE = /cargo::?rustc-cfg=((?:r#)?[A-Za-z_]\w*)?(\{)?/gu
const CFG_MENTION_RE = /rustc[-_]cfg|\bautocfg\b/u
function cfgsPrinted(texts) {
  const names = new Set()
  let any = false
  for (const raw of texts) {
    if (!CFG_MENTION_RE.test(raw)) continue // most code says nothing of cfgs: no comments to strip
    const text = raw.replaceAll(/^[ \t]*\/\/.*$/gmu, '')
    for (const m of text.matchAll(RUSTC_CFG_RE)) {
      if (m[1] === undefined || m[2] !== undefined) any = true
      else names.add(cfgName(m[1]))
    }
    if (CFG_MENTION_RE.test(text.replaceAll(RUSTC_CFG_RE, ''))) any = true
  }
  return { names, any }
}

// A source URL as cargo compares them: no trailing `/` or `.git`, the scheme and host lowercased.
const canonicalUrl = (url) => url.trim().replace(/\/+$/u, '').replace(/\.git$/u, '').replace(/^([a-z][\w+.-]*:\/\/)([^/]*)/iu, (m) => m.toLowerCase())
// The predicate of a `cfg(…)` platform spec (a target table's key); undefined for a triple.
const cfgPredicate = (spec) => /^cfg\((.*)\)$/su.exec(spec)?.[1]
// crates.io's index, as a `[patch.<url>]` may name it.
const CRATES_IO_INDEXES = new Set(['https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io'].map(canonicalUrl))

// A `members` pattern's segment as a regex (glob's syntax, as cargo takes it: `*`, `?`, `[…]`).
const globSegment = (seg) => new RegExp(`^${seg.replaceAll(/[.+^${}()|\\]/gu, '\\$&').replaceAll('[!', '[^').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`, 'u')

// The stand-in platforms cargo's resolver is run against (see resolveGraph): each carries a mark
// of its own, and the cfgs and a mark of the name of the platform it stands in for, where known.
const MARK_TARGET = '__stasis_target'
const MARK_HOST = '__stasis_host'
const MARK_NAME = '__stasis_target_name'
const standInPlatform = (mark, info) => ({ name: mark, cfg: [mark, ...(info === null ? [] : [...info.cfgs, `${MARK_NAME}="${info.triple}"`])] })
// `graph` with the platform of every target-specific dependency `to(platform)`.
function retarget(graph, to) {
  const packages = Object.create(null)
  for (const [key, pkg] of Object.entries(graph.packages)) {
    packages[key] = { ...pkg, dependencies: pkg.dependencies.map((d) => (d.target === undefined ? d : { ...d, target: to(d.target) })) }
  }
  return { ...graph, packages }
}

// --- Context ----------------------------------------------------------------------------

// No custom cfg a build sets (see cfgsSetFor).
const NO_CFGS_SET = { names: new Set(), any: false }

// A compile unit, `<features>|<platform>`: the feature context its code sees (`target`, or `host` for
// what is built for the host, which resolver 2 keeps apart) and the platform it is compiled for. A
// package's code is `target|target`, its build script `target|host`, a proc-macro's `host|host`.
const unitKey = (featureCtx, platform) => `${featureCtx}|${platform}`
export const TARGET_UNIT = unitKey('target', 'target')
export const HOST_UNIT = unitKey('host', 'host')
const unitFeatureCtx = (unit) => unit.slice(0, unit.indexOf('|'))
const unitPlatform = (unit) => unit.slice(unit.indexOf('|') + 1)

// Per-bundle Cargo state for the packages owning `entries`, built like `cargo build -p …` with
// cargo's feature flags (`cargo: true` asks `cargo metadata` instead). `target`: a triple or `host`
// for rustc to describe, or `{ triple, cfgs }`; without one, target-specific code is kept.
export function createCargoContext(baseDir, { entries = [], features = [], noDefaultFeatures = false, allFeatures = false, cargo = false, target = null, host = null } = {}) {
  const targetInfo = target === null ? null : (typeof target === 'string' ? rustcTargetCfgs(target, baseDir) : target)
  const hostInfo = target === 'host' ? targetInfo : host
  const baseAbs = resolve(baseDir)
  // dir -> its manifest's `{ file, text, buf, doc }` (bytes and table tree), or null
  const tableOf = memoized((dir) => {
    const file = posix.join(dir, 'Cargo.toml')
    let buf
    try {
      buf = readFileSync(join(baseDir, file))
    } catch {
      return null
    }
    const text = buf.toString('utf8')
    return { file, text, buf, doc: readToml(text, file) }
  })
  // The workspace root of the package at `dir`, as cargo finds it: its `[package] workspace`, else the
  // nearest [workspace] above that doesn't exclude it, in the bundle root (a dir) or above it
  // (outerWorkspace). Null for a root, a vendored crate (a published one inherits nothing) or none.
  const rootOf = (dir, doc) => {
    if (isTomlTable(doc.workspace) || isVendoredDir(dir)) return null
    const named = table(doc.package)?.workspace
    if (typeof named === 'string') return normalizeRel(dir, named) ?? outerWorkspace(join(baseAbs, dir, named)) ?? null
    const pkgAbs = join(baseAbs, dir)
    for (let d = dir; d !== '.' && d !== '';) {
      d = posix.dirname(d)
      const ws = tableOf(d)?.doc
      if (isTomlTable(ws?.workspace) && !excludes(ws, join(baseAbs, d), pkgAbs)) return d
    }
    for (const abs of ancestors(dirname(baseAbs))) {
      const ws = outerWorkspace(abs)
      if (ws !== undefined && !excludes(ws.doc, abs, pkgAbs)) return ws
    }
    return null
  }
  // Whether the [workspace] of the manifest `doc` at absolute `abs` excludes the package at
  // absolute `pkgAbs`, as cargo has it: under an `exclude` path and under no `members` one.
  const excludes = (doc, abs, pkgAbs) => {
    const under = (p) => typeof p === 'string' && (pkgAbs === join(abs, p) || pkgAbs.startsWith(`${join(abs, p)}${sep}`))
    const list = (v) => (Array.isArray(v) ? v : [])
    return list(doc.workspace.exclude).some(under) && !list(doc.workspace.members).some(under)
  }
  // The workspace root at absolute `abs` above the bundle root, read for what members inherit, its
  // resolver and `[patch]` (never bundled), as `{ dir: null, outside: abs, file, doc, … }`; undefined
  // for no [workspace] there.
  const outerWorkspace = memoized((abs) => {
    const file = join(abs, 'Cargo.toml')
    const text = readText(diskHost, file)
    const label = toPosix(relative(baseAbs, file))
    const doc = text === null ? null : readToml(text, label)
    return isTomlTable(doc?.workspace) ? { dir: null, outside: abs, file: label, doc, ...manifestOf(text, doc, label, null) } : undefined
  })
  // The manifest at `dir` as parseCargoManifest reads it, with its `workspaceRoot` (rootOf's) and each
  // path dependency's project-relative `dir` (null outside the bundle root; an inherited one's path is
  // the root's). A vendored package's is `unchecked` until readManifest checks it.
  const manifestAt = memoized((dir) => {
    const raw = tableOf(dir)
    if (raw === null) return null
    const root = rootOf(dir, raw.doc)
    const ws = typeof root === 'string' ? readManifest(root) : root
    const m = { dir, file: raw.file, ...manifestOf(raw.text, raw.doc, raw.file, ws), workspaceRoot: ws, unchecked: isVendoredDir(dir) }
    for (const d of m.deps.values()) {
      for (const r of d.kinds.values()) r.dir = r.path === null ? null : manifestPath(r.inherited && ws !== null ? ws : m, r.path)
    }
    return m
  })
  // The manifest at `dir` as the build takes it in: a vendored package's checked against its
  // `.cargo-checksum.json` before what it says decides anything. Only a listing of the vendor
  // directory reads one unchecked: cargo checks the files of a copy it builds, not of every copy.
  const readManifest = (dir) => {
    const m = manifestAt(dir)
    if (m?.unchecked) {
      checkVendored(dir, m.file, tableOf(dir).buf)
      m.unchecked = false
    }
    return m
  }
  // The directory a path manifest `m` writes names, project-relative (null outside the bundle
  // root): relative to its directory, inside the bundle root or above it (`outside`).
  const manifestPath = (m, path) => (m.outside === undefined ? normalizeRel(m.dir, path) : projectRel(baseAbs, m.outside, path))
  // Manifests at or above `dir`, nearest first, up to the bundle root.
  const manifestsAbove = function* (dir) {
    for (;;) {
      const m = readManifest(dir)
      if (m) yield m
      if (dir === '.' || dir === '') return
      dir = posix.dirname(dir)
    }
  }
  // The package owning a file: the nearest manifest above it with a [package]; memoized per directory.
  const packageFor = memoized((fileRel) => manifestsAbove(posix.dirname(fileRel)).find((m) => m.package) ?? null, (fileRel) => posix.dirname(fileRel))
  // The workspace root manifest of package `m` (see rootOf): its own when it is a root, an outer
  // one above the bundle root (`outside`) too; `m` itself outside any workspace.
  const rootManifestOf = (m) => (m.isWorkspace ? m : (m.workspaceRoot ?? m))
  // The workspace root of the package at `dir` inside the bundle root, or null (outside any, or
  // one above the bundle root).
  const workspaceFor = (dir) => {
    const m = readManifest(dir)
    const root = m === null ? null : rootManifestOf(m)
    return root?.isWorkspace === true && root.outside === undefined ? root : null
  }
  // Whether `rel`, a target path of package `m`, is its own: a vendored package's may not leave its
  // directory (a published crate's never does; one that tries is reaching for the project's files).
  const ownTarget = (m, rel) => rel !== null && (!isVendoredDir(m.dir) || rel.startsWith(`${m.dir}/`))
  // The manifest's lib target root when it is on disk (`[lib] path`, default `src/lib.rs`).
  const libPath = memoized((m) => {
    const rel = normalizeRel(m.dir, m.lib.path ?? 'src/lib.rs')
    const inside = ownTarget(m, rel)
    if (rel !== null && !inside) console.warn(`[loader.cargo] Refusing lib path outside its package: ${m.lib.path} in ${m.dir}`)
    return inside && isFile(join(baseDir, rel)) ? rel : null
  })
  const libName = (m) => normName(m.lib.name ?? m.package?.name ?? '')
  // The package's build script when it is on disk (see buildScriptOf).
  const buildScript = memoized((m) => {
    const rel = m.package.build === false ? null : normalizeRel(m.dir, m.package.build ?? 'build.rs')
    const inside = ownTarget(m, rel)
    if (rel !== null && !inside && isFile(join(baseDir, rel))) console.warn(`[loader.cargo] Refusing build script outside its package: ${m.package.build} in ${m.dir}`)
    return inside && isFile(join(baseDir, rel)) ? rel : null
  })
  const isTestTarget = (fileRel) => isTestTargetPath(packageFor(fileRel)?.dir ?? '.', fileRel)
  // Whether `fileRel` belongs to a target built with the dev-dependencies: a test, bench or example
  // (which unlike the other two isn't compiled with `cfg(test)`).
  const linksDevDeps = (fileRel) => ['tests', 'benches', 'examples'].includes(targetDirOf(packageFor(fileRel)?.dir ?? '.', fileRel))
  // The packages an entry is a test, bench or example target of: their dev-dependencies are
  // linked (that build is `cargo test`'s).
  let devRoots = null
  const devRootDirs = () => (devRoots ??= new Set(entries.filter(linksDevDeps).map((e) => packageFor(e)?.dir)))
  const version = (m) => m.package.version

  // --- dependency resolution

  // The directory cargo is taken to run in (`runDir`): that of the first entry's package, unless the
  // entry is a vendored crate's (whose config cargo never reads), else the bundle root. The configs
  // cargo reads there (`configs`) set the vendor directory, `[patch]` and rustflags, and are bundled.
  const rootConfigs = cargoConfigs(baseDir, '.')
  const rootVendorDir = vendorDirOf(baseDir, rootConfigs, { quiet: true })
  const ownEntry = entries.find((e) => !e.startsWith(`${rootVendorDir}/`))
  const packageDirAbove = (dir) => {
    for (let d = dir; ; d = posix.dirname(d)) {
      const doc = tableOf(d)?.doc
      if (isTomlTable(doc?.package ?? doc?.project)) return d
      if (d === '.' || d === '') return '.'
    }
  }
  const runDir = ownEntry === undefined ? '.' : packageDirAbove(posix.dirname(ownEntry))
  const configs = runDir === '.' ? rootConfigs : cargoConfigs(baseDir, runDir)
  const vendorDir = vendorDirOf(baseDir, configs)
  // Whether a package directory is a vendored crate's (a registry crate `cargo vendor` copied in).
  const isVendoredDir = (dir) => dir !== vendorDir && dir.startsWith(`${vendorDir}/`)
  // The vendored crates `<vendorDir>/<dir>/` as `[{ version, dir, git }]`, indexed `byName` (normalized
  // package name) and `byLib` (lib name: `md-5` → `md5`). `git`: whether the copy is a git checkout's
  // (its `.cargo-checksum.json` has no package checksum), null without that file.
  let vendorIndex = null
  const vendored = () => {
    if (vendorIndex !== null) return vendorIndex
    vendorIndex = { byName: new Map(), byLib: new Map() }
    let dirs = []
    try {
      dirs = readdirSync(join(baseDir, vendorDir))
    } catch { /* no vendor dir */ }
    for (const d of dirs) {
      if (d.startsWith('.')) continue // a directory source reads none of these
      const m = manifestAt(`${vendorDir}/${d}`)
      if (!m?.package) continue
      const entry = { version: version(m), dir: m.dir, git: checksumOf(m.dir)?.git ?? null }
      upsert(vendorIndex.byName, normName(m.package.name), () => []).push(entry)
      upsert(vendorIndex.byLib, libName(m), () => []).push(entry)
    }
    return vendorIndex
  }
  // A vendored package's `.cargo-checksum.json`, or null when it has none: `package` the crate's
  // sha256 in hex (a git checkout's copy has none: `git`), `files` each file's by package-relative path.
  const checksums = new Map()
  const checksumOf = (dir) => upsert(checksums, dir, () => {
    const file = posix.join(dir, '.cargo-checksum.json')
    const text = readText(diskHost, join(baseDir, file))
    let value = null
    if (text !== null) {
      try {
        value = JSON.parse(text)
      } catch (err) {
        throw new Error(`${file}: not JSON: ${err.message}`, { cause: err })
      }
    }
    return value === null ? null : { text, git: (value?.package ?? null) === null, package: typeof value?.package === 'string' ? value.package : null, files: isPlainObject(value?.files) ? value.files : {} }
  })
  // Where `cargo vendor` copied the vendored package at `dir` from, as its `.cargo-checksum.json`
  // tells: `registry` or `git` (a git checkout); null without that file, when it could be either.
  const copySource = (dir) => {
    const git = checksumOf(dir)?.git
    return git === undefined ? null : (git ? 'git' : 'registry')
  }
  // Throws when `fileRel`, a file of the vendored package at `dir`, isn't (`buf`) the file its
  // `.cargo-checksum.json` lists: changed since `cargo vendor`, which cargo refuses to build. An
  // unlisted file, or a package without the list, passes. Once per file.
  const verified = new Set()
  const checkVendored = (dir, fileRel, buf) => {
    if (verified.has(fileRel)) return
    const listed = checksumOf(dir)?.files[fileRel.slice(dir.length + 1)]
    if (typeof listed === 'string') {
      const actual = createHash('sha256').update(buf).digest('hex')
      if (actual !== listed) throw new Error(`${fileRel} isn't the file ${dir}/.cargo-checksum.json lists (sha256 ${actual}, listed ${listed}): changed since \`cargo vendor\`, which cargo refuses to build`)
    }
    verified.add(fileRel)
  }
  // Throws when the package checksum of the vendored package `m` isn't one the build's Cargo.lock locks
  // its version with, where it locks one: the copy isn't of the crate locked, which cargo refuses to
  // build. Once per package.
  const lockChecked = new Set()
  const checkLocked = (m) => {
    if (lockChecked.has(m.dir)) return
    lockChecked.add(m.dir)
    const hex = checksumOf(m.dir)?.package
    const lk = hex ? lockfile() : null
    const locked = lk === null ? [] : lockKeysOf(lk, m).map((key) => lk.lock.packages[key].checksum).filter(Boolean)
    if (locked.length > 0 && !locked.includes(hex)) {
      throw new Error(`${m.dir}/.cargo-checksum.json: the package checksum of ${m.package.name} ${version(m)}, ${hex}, isn't the one ${lk.file} locks (${locked.join(', ')}): vendor it again`)
    }
  }
  // The package the build is of: the first entry's that isn't vendored (runDir's); null for none.
  const buildPackage = memoized(() => entries.map(packageFor).find((m) => m && !isVendoredDir(m.dir)) ?? null)
  // The workspace root of the build (rootManifestOf its package), inside the bundle root or above it,
  // or the bundle root's manifest when no entry has a package: its Cargo.lock, resolver and `[patch]`
  // are the build's.
  const buildWorkspaceRoot = () => {
    const pkg = buildPackage()
    return pkg === null ? readManifest('.') : rootManifestOf(pkg)
  }
  // The build's Cargo.lock, project-relative: beside its workspace root, as cargo finds it; null when
  // that root lies above the bundle root (its lockfile is cargo's, never read).
  const buildLockPath = () => {
    const root = buildWorkspaceRoot()
    return root?.outside === undefined ? posix.join(root?.dir ?? '.', 'Cargo.lock') : null
  }
  // The build's Cargo.lock as `{ file, lock, byId }` (`byId`: `name version` → its packages' keys),
  // read by @preventive/lockfile, which refuses an older format or a lock cargo wouldn't write; null
  // when there is none in the bundle root.
  let lock
  const lockfile = () => {
    if (lock === undefined) {
      const file = buildLockPath()
      const text = file === null ? null : readText(diskHost, join(baseDir, file))
      lock = null
      if (text !== null) {
        const parsed = readNamed(file, () => parseCargoLock(text))
        const byId = new Map()
        for (const [key, p] of Object.entries(parsed.packages)) upsert(byId, `${normName(p.name)} ${p.version}`, () => []).push(key)
        lock = { file, lock: parsed, byId }
      }
    }
    return lock
  }
  // `--cargo`: the graph and features as cargo resolved them, with registry packages it read from
  // the registry cache matched to their `vendor/` copy by name + version.
  const metadata = cargo
    ? resolutionFromMetadata(runCargoMetadata(join(baseDir, runDir), { features, noDefaultFeatures, allFeatures, platform: targetInfo?.triple ?? null }), baseDir, {
        locate: (name, ver) => (typeof name === 'string' ? vendored().byName.get(normName(name))?.find((c) => c.version === ver)?.dir ?? null : null),
      })
    : null
  // Where the build's `[patch]` tables come from, in the order they apply: the cargo configs' (nearest
  // first), then the workspace root manifest's, as `{ patch, at, from }`: `at(path)` the project-relative
  // directory a patch's path names (null outside the bundle root), `from` the file.
  const patchSources = memoized(() => {
    const root = buildWorkspaceRoot()
    return [
      ...configs.map((c) => ({ patch: readNamed(c.file, () => parseCargoConfig([c.text])).patch, at: (path) => projectRel(baseAbs, c.abs, path), from: c.file })),
      ...(root ? [{ patch: root.cargo.patch, at: (path) => manifestPath(root, path), from: root.file }] : []),
    ]
  })
  // The first `[patch]` of crate `crate` for where request `r` comes from, as `{ spec, dir, from }`
  // (`dir` a path patch's directory, null outside the bundle root); undefined when nothing patches it.
  const patchFor = (crate, r) => {
    for (const { patch, at, from } of patchSources()) {
      for (const [source, specs] of Object.entries(patch)) {
        if (!patchesSource(source, r)) continue
        for (const [name, spec] of Object.entries(specs)) {
          if (normName(name) === crate) return { spec, dir: spec.source.type === 'path' ? at(spec.source.path) : null, from }
        }
      }
    }
  }
  // Whether a `[patch.<source>]` table patches what request `r` comes from: crates.io's (`crates-io`,
  // or its index URL), another registry's name or index, a git dependency's repository -- URLs
  // compared as cargo canonicalizes them.
  const patchesSource = (source, r) => {
    if (r.source === 'git') return r.origin !== null && canonicalUrl(source) === canonicalUrl(r.origin)
    if (r.source !== 'registry') return false
    if (r.origin === null) return source === 'crates-io' || CRATES_IO_INDEXES.has(canonicalUrl(source))
    return source === r.origin || canonicalUrl(source) === canonicalUrl(r.origin)
  }
  // Where a lockfile's package comes from: `path`, `git` or `registry` (sparse or not).
  const sourceKind = (source) => (source === undefined ? 'path' : (source.startsWith('git+') ? 'git' : 'registry'))
  // The keys of the build's lockfile that are package `m`: its path package, or for a vendored copy
  // the locked package of its name and version from where the copy came from (a git checkout or a
  // registry, see vendored).
  const lockKeysOf = (lk, m) => {
    const keys = lk.byId.get(`${normName(m.package.name)} ${version(m)}`) ?? []
    if (!isVendoredDir(m.dir)) return keys.filter((k) => lk.lock.packages[k].source === undefined)
    const kind = copySource(m.dir)
    return keys.filter((k) => lk.lock.packages[k].source !== undefined && (kind === null || sourceKind(lk.lock.packages[k].source) === kind))
  }
  // The in-tree package a dependency of `m` resolves to through one of its tables (`request`): a path,
  // a `[patch]` path whose version fits, else the vendored copy Cargo.lock pins for `m` or the one that
  // fits. Null when it isn't in-tree, and warned when the copies don't settle it: none is guessed.
  const depTargets = new Map() // memoized per (package, request): the fixed-point loop asks many times
  const resolveDep = (m, dep, request, { quiet = false } = {}) => {
    const found = upsert(nestedMap(depTargets, m.dir), request, () => {
      const warnings = []
      return { t: resolveDepUncached(m, dep, request, (w) => warnings.push(w)), warnings }
    })
    if (!quiet) warnDep(m, request)
    return found.t
  }
  // What resolveDep warned of, said once: when first asked unless `quiet`, else when warnDep asks (the
  // replay warns only of the declarations the build links).
  const warnDep = (m, request) => {
    for (const w of depTargets.get(m.dir)?.get(request)?.warnings.splice(0) ?? []) console.warn(w)
  }
  const resolveDepUncached = (m, dep, request, warn) => {
    const asPackage = (dir) => {
      const t = dir === null ? null : readManifest(dir)
      return t?.package ? t : null
    }
    // cargo metadata knows exactly which package each dependency edge points at.
    const known = metadata?.deps.get(m.dir)?.get(dep.key)
    if (known !== undefined) return asPackage(known)
    const who = `${m.package.name} ${version(m)}`
    if (request.path) {
      const t = asPackage(request.dir)
      if (request.dir === null) warn(`[loader.cargo] ${who}'s dependency ${dep.name} is a path outside the bundle root: ${request.path}`)
      else if (t === null) warn(`[loader.cargo] ${who}'s dependency ${dep.name} names ${request.dir}, which holds no Cargo.toml with a [package]`)
      return t
    }
    const crate = normName(request.package)
    const req = request.version
    const fits = (ver) => req === null || satisfies(ver, req)
    let kind = request.source
    const patch = patchFor(crate, request)
    if (patch?.spec.source.type === 'path') {
      if (patch.dir === null) {
        warn(`[loader.cargo] ${patch.from} patches ${crate} with a path outside the bundle root`)
        return null
      }
      const t = asPackage(patch.dir)
      // cargo uses a patch only where its version satisfies the requirement ("patch … was not used").
      if (t !== null && fits(version(t))) return t
      warn(t === null
        ? `[loader.cargo] ${patch.from} patches ${crate} with ${patch.dir}, which holds no Cargo.toml with a [package]`
        : `[loader.cargo] ${patch.from}'s patch of ${crate} (${version(t)}) doesn't satisfy ${who}'s requirement ${req}: not used`)
    } else if (patch?.spec.source.type === 'git') {
      kind = 'git'
    }
    // A copy of where the dependency comes from (a copy without `.cargo-checksum.json` could be either).
    const candidates = (vendored().byName.get(crate) ?? []).filter((c) => c.git === null || c.git === (kind === 'git'))
    if (candidates.length === 0) return null
    const vendoredList = candidates.map((c) => c.version).toSorted((a, b) => b.localeCompare(a, 'en', { numeric: true })).join(', ')
    const lk = lockfile()
    if (lk) {
      // A package may depend on two versions of one crate: the requirement tells which pin is this one.
      const pins = lockKeysOf(lk, m)
        .flatMap((k) => lk.lock.packages[k].dependencies)
        .map((k) => lk.lock.packages[k])
        .filter((p) => normName(p.name) === crate && sourceKind(p.source) === kind)
        .map((p) => p.version)
      const want = pins.find(fits) ?? null
      // A lock whose pin the requirement no longer allows is out of date: cargo would resolve
      // again, so the requirement decides.
      if (want === null && pins.length > 0) warn(`[loader.cargo] ${lk.file} pins ${who} to ${crate} ${pins.join(', ')}, which ${req} doesn't allow: the lock is out of date`)
      if (want !== null) {
        const hit = candidates.find((c) => c.version === want)
        if (hit) return readManifest(hit.dir)
        warn(`[loader.cargo] ${who} is locked to ${crate} ${want}, which isn't vendored (vendored: ${vendoredList})`)
        return null
      }
    }
    const fitting = candidates.filter((c) => fits(c.version))
    if (fitting.length === 1) return readManifest(fitting[0].dir)
    if (fitting.length === 0) warn(`[loader.cargo] No vendored version of ${crate} satisfies ${who}'s requirement ${req} (vendored: ${vendoredList})`)
    else warn(`[loader.cargo] Several vendored versions of ${crate} satisfy ${who}'s requirement ${req ?? '*'} (${fitting.map((c) => c.version).join(', ')}) and no Cargo.lock says which`)
    return null
  }

  // --- feature resolution

  // Cargo's feature resolver, the build's workspace root's (never a vendored crate's): v2 (edition
  // 2021) keeps dev-dependencies out of a normal build, the host's features apart and other platforms'
  // tables out; v1 unifies them all; v3 (edition 2024) resolves features as v2 does.
  const resolverVersion = memoized(() => {
    const root = buildWorkspaceRoot()
    const edition = Number(root?.package?.edition ?? 0)
    return root?.resolver ?? (edition >= 2024 ? 3 : (edition >= 2021 ? 2 : 1))
  })
  // The feature context a unit's code sees (resolver 2 keeps the host's apart; resolver 1 has one).
  const featureCtx = (c) => (resolverVersion() === 1 ? 'target' : c)
  // The platform a context compiles for, as far as the loader knows it: the target's triple and
  // cfgs when `target` was given; the host's only when the target is the host (`host`), since the
  // machine that builds need not be the one that bundles.
  const platformInfo = (platform) => (platform === 'target' ? targetInfo : hostInfo)
  // Whether a table for platform `spec` (a `cfg(…)` or a triple; null or undefined for none) is
  // one for `platform`: `yes`, `no`, or `maybe` when its cfgs aren't known or don't decide it.
  const tableOn = (spec, platform) => {
    if (spec === null || spec === undefined) return 'yes'
    const info = platformInfo(platform)
    if (info === null) return 'maybe'
    const cfg = cfgPredicate(spec)
    const holds = cfg === undefined ? spec === info.triple : evalCfg(cfg, { target: info.cfgs })
    return holds === true ? 'yes' : (holds === false ? 'no' : 'maybe')
  }
  // A package in a context, as the resolutions key it: resolver 1's one context is `target`'s.
  const nodeKey = (c, dir) => `${featureCtx(c)}\0${dir}`

  // Both feature resolutions of `graph` by cargo's resolver for the build of `packages`, by nodeKey
  // (`dirOf(key)` a package key's dir), run against stand-in platforms: a table the loader can't decide
  // is off for `sure` and on for `all`; `result` is the resolver's own answer for `all`.
  const resolveGraph = (graph, packages, file, dirOf) => {
    const build = { packages, features, allFeatures, noDefaultFeatures, dev: entries.some((e) => linksDevDeps(e)), host: standInPlatform(MARK_HOST, hostInfo), targets: [standInPlatform(MARK_TARGET, targetInfo)] }
    let undecided = false
    const decided = (on) => retarget(graph, (spec) => {
      const at = (platform) => {
        if (tableOn(spec, platform) !== 'maybe') return cfgPredicate(spec) ?? `${MARK_NAME} = "${spec}"`
        undecided = true
        return String(on)
      }
      return `cfg(any(all(${MARK_TARGET}, ${at('target')}), all(${MARK_HOST}, ${at('host')})))`
    })
    const featuresOf = (g) => readNamed(file, () => resolveCargoFeatures(g, build))
    const sure = featuresOf(decided(false))
    const all = undecided ? featuresOf(decided(true)) : sure
    const byNode = (result) => {
      const out = new Map()
      for (const [key, { normal, host: onHost }] of Object.entries(result)) {
        const dir = dirOf(key)
        if (dir === undefined) continue
        if (onHost !== undefined) out.set(nodeKey('host', dir), new Set(onHost))
        if (normal !== undefined) out.set(nodeKey('target', dir), new Set(normal))
      }
      return out
    }
    return { sure: byNode(sure), all: byNode(all), result: all }
  }

  // --- the replay: cargo's feature resolver, by @preventive/lockfile, over the manifests

  // The graph cargo's resolver takes, laid out from the manifests: each in-tree package the `roots`
  // (its members) reach, by resolveDep. A declaration nothing in-tree answers, or under resolver 2 a
  // root's dev-dependency no entry builds (`unbuilt`), gets a stand-in with any feature it is asked.
  const replayGraph = (roots) => {
    const packages = Object.create(null)
    const edges = []
    const rootDirs = new Set(roots.map((m) => m.dir))
    const unbuiltDev = (m) => resolverVersion() !== 1 && !devRootDirs().has(m.dir)
    const queue = [...roots]
    for (const m of queue) {
      if (m.dir in packages) continue
      const pkg = m.cargo.package
      const dependencies = pkg.dependencies.map((d, index) => {
        if (d.kind === 'dev' && !rootDirs.has(m.dir)) return { ...d, resolved: undefined, active: false }
        const dep = m.deps.get(normName(d.name))
        const request = dep.kinds.get(requestKey(d))
        const unbuilt = d.kind === 'dev' && unbuiltDev(m)
        const t = unbuilt ? null : resolveDep(m, dep, request, { quiet: true })
        if (t !== null) queue.push(t)
        const key = t?.dir ?? `\0${m.dir}\0${index}`
        edges.push({ key, m, d, request, standIn: t === null, unbuilt })
        return { ...d, resolved: key, active: true }
      })
      packages[m.dir] = { name: pkg.name, version: pkg.version, source: undefined, checksum: undefined, manifest: pkg, dependencies }
    }
    for (const { key, m, d } of edges.filter((e) => e.standIn)) {
      const asked = new Set(['default', ...d.features])
      for (const value of [...Object.values(m.cargo.package.features).flat(), ...(rootDirs.has(m.dir) ? parseFeatureList(features) : [])]) {
        const named = DEP_FEATURE_RE.exec(value)
        if (named?.[1] === d.name) asked.add(named[3])
      }
      const manifest = { name: d.package, features: fromEntries([...asked].map((f) => [f, []])), dependencies: [], procMacro: false, procMacroTarget: false }
      packages[key] = { name: d.package, version: '0.0.0', source: undefined, checksum: undefined, manifest, dependencies: [] }
    }
    return { graph: { resolver: resolverVersion(), root: undefined, members: [...rootDirs], packages }, edges }
  }

  // The replay's resolution (resolveGraph's), and the dependencies the build links that nothing
  // in-tree answers -- a stand-in it reaches -- as `dir key` → `{ dir, key, name, kinds }`. What
  // resolveDep warned of, it says now of the declarations whose package the build reaches.
  const replay = () => {
    const roots = [...new Set(entries.map(packageFor).filter(Boolean))]
    if (roots.length === 0) return { resolved: { sure: new Map(), all: new Map() }, lacking: new Map() }
    const { graph, edges } = replayGraph(roots)
    const standIns = new Set(edges.filter((e) => e.standIn).map((e) => e.key))
    const resolved = resolveGraph(graph, graph.members, buildWorkspaceRoot()?.file ?? null, (key) => (standIns.has(key) ? undefined : key))
    const lacking = new Map()
    for (const { key, m, d, request, standIn, unbuilt } of edges) {
      if (unbuilt || !(key in resolved.result)) continue
      warnDep(m, request)
      if (!standIn) continue
      upsert(lacking, `${m.dir}\0${normName(d.name)}`, () => ({ dir: m.dir, key: normName(d.name), name: d.name, kinds: new Set() })).kinds.add(d.kind)
    }
    return { resolved, lacking }
  }

  // --- the exact resolution: cargo's resolver, by @preventive/lockfile

  const subdirs = (dir) => {
    try {
      return readdirSync(join(baseDir, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => (dir === '.' ? e.name : `${dir}/${e.name}`))
    } catch {
      return []
    }
  }
  // The directories a workspace `members` pattern names, project-relative (glob's syntax, as cargo
  // takes it: `*`, `?` and `[…]` within a segment, `**` for any depth); null when it leaves the
  // bundle root.
  const globDirs = (rootDir, pattern) => {
    let dirs = [rootDir]
    for (const seg of pattern.split('/').filter((x) => x !== '' && x !== '.')) {
      const next = []
      for (const dir of dirs) {
        if (seg === '**') {
          const all = [dir]
          for (let i = 0; i < all.length; i++) all.push(...subdirs(all[i]).filter((d) => !posix.basename(d).startsWith('.')))
          next.push(...all)
        } else if (/[*?[]/u.test(seg)) {
          const re = globSegment(seg)
          next.push(...subdirs(dir).filter((d) => re.test(posix.basename(d))))
        } else {
          const rel = normalizeRel(dir, seg)
          if (rel === null) return null
          next.push(rel)
        }
      }
      dirs = next
    }
    return dirs
  }
  // The workspace's members, project-relative, as cargo finds them: the root package, the
  // packages its `members` patterns name, and the path dependencies of members inside the root's
  // directory, less what `exclude` names; null when a pattern leaves the bundle root.
  const membersOf = (root) => {
    const ws = root.cargo.workspace
    if (ws === undefined) return [root.dir]
    const excluded = ws.exclude.map((e) => normalizeRel(root.dir, e)).filter((e) => e !== null)
    const isExcluded = (dir) => excluded.some((e) => dir === e || dir.startsWith(`${e}/`))
    const inRoot = (dir) => root.dir === '.' || dir === root.dir || dir.startsWith(`${root.dir}/`)
    const out = new Set(root.package ? [root.dir] : [])
    for (const pattern of ws.members) {
      const dirs = globDirs(root.dir, pattern)
      if (dirs === null) return null
      for (const dir of dirs) if (!isExcluded(dir) && readManifest(dir)?.package) out.add(dir)
    }
    // Set iteration is live: a path dependency added is walked in turn.
    for (const dir of out) {
      for (const d of readManifest(dir).deps.values()) {
        for (const r of d.kinds.values()) {
          const sub = r.dir
          if (sub !== null && inRoot(sub) && !isExcluded(sub) && readManifest(sub)?.package) out.add(sub)
        }
      }
    }
    return [...out]
  }
  // The build as cargo resolves it (linkCargo over the lockfile, resolveCargoFeatures as `cargo build
  // -p <the entries' packages>`), as `{ graph, dirOf, keyOf, resolved }`, where the loader holds all it
  // takes; else null, `exactWhy` saying what's missing. What cargo would refuse stops the build.
  let exactWhy = null // why there is none, for the replay to say
  const notExact = (why) => {
    exactWhy = why
    return null
  }
  const exact = memoized(() => {
    if (metadata) return null
    if (targetInfo === null) return notExact('no --cargo-target')
    const lockPath = buildLockPath()
    if (lockPath === null) return notExact('the workspace root lies above the bundle root')
    const lk = lockfile()
    if (lk === null) return notExact(`no ${lockPath}`)
    const root = buildWorkspaceRoot()
    if (root === null) return notExact('no package owns the entries')
    const memberDirs = membersOf(root)
    if (memberDirs === null) return notExact(`a members pattern of ${root.file} leaves the bundle root`)
    // The path packages: the members, the path dependencies of each, the path [patch]es.
    const keyOf = new Map() // dir -> package key
    const dirOf = new Map() // package key -> dir
    const queue = [...memberDirs]
    for (const { patch, at, from } of patchSources()) {
      for (const specs of Object.values(patch)) {
        for (const spec of Object.values(specs)) {
          if (spec.source.type !== 'path') continue
          const dir = at(spec.source.path)
          if (dir === null) return notExact(`${from} patches with a path outside the bundle root`)
          queue.push(dir)
        }
      }
    }
    for (const dir of queue) {
      if (keyOf.has(dir)) continue
      const m = readManifest(dir)
      if (!m?.package) return notExact(`${posix.join(dir, 'Cargo.toml')} isn't a package's`)
      const key = `${m.package.name} ${m.package.version}`
      keyOf.set(dir, key)
      dirOf.set(key, dir)
      for (const d of m.deps.values()) {
        for (const r of d.kinds.values()) {
          if (r.path === null) continue
          if (r.dir === null) return notExact(`${m.package.name}'s path dependency ${r.path} lies outside the bundle root`)
          queue.push(r.dir)
        }
      }
    }
    // The vendor directory as a directory source reads it, and every package of the lockfile there
    // (a copy the lockfile doesn't list needs no checksums: cargo never reads it).
    const vendor = Object.create(null)
    const held = new Map() // `name version` -> whether its copy has its checksums
    for (const sub of subdirs(vendorDir)) {
      const name = posix.basename(sub)
      const m = name.startsWith('.') ? null : manifestAt(sub)
      if (!m?.package) continue
      const sums = checksumOf(sub)
      const id = `${m.package.name} ${m.package.version}`
      held.set(id, held.get(id) === true || sums !== null)
      if (sums !== null) vendor[name] = { manifest: tableOf(sub).text, checksum: sums.text }
    }
    for (const [key, p] of Object.entries(lk.lock.packages)) {
      const id = `${p.name} ${p.version}`
      if (p.source === undefined && !dirOf.has(key)) return notExact(`${lk.file} locks the path package ${id}, which isn't in-tree`)
      if (p.source !== undefined && !held.has(id)) return notExact(`${id} is locked but not vendored`)
      if (p.source !== undefined && !held.get(id)) return notExact(`the vendored copy of ${id} has no .cargo-checksum.json`)
    }
    const copies = readNamed(lk.file, () => readCargoVendor(lk.lock, vendor))
    const manifestsByKey = Object.create(null)
    for (const [key, dir] of dirOf) manifestsByKey[key] = readManifest(dir).cargo
    for (const [key, { directory }] of Object.entries(copies)) {
      const dir = `${vendorDir}/${directory}`
      keyOf.set(dir, key)
      dirOf.set(key, dir)
      manifestsByKey[key] = readManifest(dir).cargo
    }
    const memberKeys = memberDirs.map((dir) => keyOf.get(dir))
    const entryKeys = [...new Set(entries.map(packageFor).filter(Boolean).map((m) => keyOf.get(m.dir)))]
    if (entryKeys.length === 0) return notExact('no package owns the entries')
    if (entryKeys.some((k) => !memberKeys.includes(k))) return notExact('an entry\'s package isn\'t a member of the workspace')
    const config = readNamed(configs[0]?.file ?? null, () => parseCargoConfig(configs.map((c) => c.text)))
    const graph = readNamed(lk.file, () => linkCargo(lk.lock, manifestsByKey, { workspace: root.cargo, members: memberKeys, config }))
    return { graph, dirOf, keyOf, resolved: resolveGraph(graph, entryKeys, root.file, (key) => dirOf.get(key)) }
  })

  // Both resolutions per (context, package dir) -- `sure` without the undecided tables, `all` with
  // them -- the exact one's where there is one, else the replay's (which sets `lacking`). `--cargo`:
  // cargo metadata's per-package union over every build, so each feature in it is only maybe on.
  let resolved = null
  let lacking = null
  const ensureResolved = () => {
    if (resolved !== null) return resolved
    if (metadata) {
      const byNode = new Map([...metadata.enabled].flatMap(([dir, set]) => [[nodeKey('target', dir), set], [nodeKey('host', dir), set]]))
      resolved = { sure: new Map(), all: byNode }
    } else {
      resolved = exact()?.resolved ?? null
      if (resolved === null) ({ resolved, lacking } = replay())
    }
    return resolved
  }
  // Per node, the features on only maybe: in `all`, not in `sure`; null for none.
  const maybeOf = memoized((node) => {
    const { sure, all } = ensureResolved()
    const on = sure.get(node)
    const maybe = new Set([...(all.get(node) ?? [])].filter((f) => !on?.has(f)))
    return maybe.size === 0 ? null : maybe
  })
  // A package in the `all` resolution but not the `sure` one is built only maybe: nothing of its
  // is on for certain.
  const NO_FEATURES = new Set()

  // --- cfgs a build may set
  let rustflagCfgs = null
  const cfgsSetMemo = new Map()
  // A crate root's text -- a build script's, a lib's -- and that of the modules it declares (`mod
  // probe;`, beside it), a few levels down: where its `cargo:rustc-cfg=` lines are.
  const crateTexts = (root) => {
    const texts = []
    const queue = [[root, 0]]
    const seen = new Set()
    for (let qi = 0; qi < queue.length; qi++) {
      const [rel, depth] = queue[qi]
      if (seen.has(rel)) continue
      seen.add(rel)
      const text = readText(diskHost, join(baseDir, rel))
      if (text === null) continue
      texts.push(text)
      if (depth >= 3) continue
      const dir = posix.dirname(rel)
      const sub = qi === 0 || posix.basename(rel) === 'mod.rs' ? dir : posix.join(dir, posix.basename(rel, '.rs'))
      for (const m of text.matchAll(/\bmod\s+([A-Za-z_]\w*)\s*;/gu)) {
        for (const f of [posix.join(sub, `${m[1]}.rs`), posix.join(sub, m[1], 'mod.rs')]) if (isFile(join(baseDir, f))) queue.push([f, depth + 1])
      }
    }
    return texts
  }

  // What the build script of package `m` may print through the crates it calls (cfg_aliases'
  // `cfg_aliases!` prints the names its input gives): those its host build-dependencies reach, any
  // when one is missing from the bundle root.
  const helpersPrinted = (m) => {
    const crates = new Map() // dir -> manifest
    if (linksLacking(m, 'build', crates)) return { names: new Set(), any: true }
    const names = new Set()
    for (const t of crates.values()) {
      const printed = libPrinted(t)
      if (printed.any) return printed
      for (const name of printed.names) names.add(name)
    }
    return { names, any: false }
  }
  // Whether package `p` links, through its `kind` dependencies for the host and what they depend
  // on in turn, a crate the bundle root lacks; those it links in-tree go into `crates` (dir →
  // manifest).
  const linksLacking = (p, kind, crates) => [...p.deps.values()].some((d) => [...d.kinds.values()].some((r) => {
    if (r.kind !== kind || tableOn(r.target, 'host') === 'no') return false
    const t = resolveDep(p, d, r)
    if (t === null) return true
    if (crates.has(t.dir)) return false
    crates.set(t.dir, t)
    return linksLacking(t, 'normal', crates)
  }))
  // What package `t`'s lib may print for a build script calling it (cfgsPrinted); per package.
  const libPrinted = memoized((t) => {
    const lib = libPath(t)
    return lib === null ? NO_CFGS_SET : cfgsPrinted(crateTexts(lib))
  }, (t) => t.dir)

  // The in-tree crate roots a name resolves to from package `m` (null: none owns the file), `m`'s own
  // lib aside, as `[{ file, key }]`: its dependency of that name or lib name through each table the
  // code's `roles` link on its `platforms` (`key` naming which); for no package, the one vendored crate.
  const crateTargets = new Map() // every file of a package asks for the same few crates
  const depCrate = (m, norm, roles, platforms) => upsert(crateTargets, `${m?.dir ?? ''}\0${norm}\0${roles.join()}\0${platforms.join()}`, () => depCrateUncached(m, norm, roles, platforms))
  const ROLE_KINDS = { build: ['build'], test: ['normal', 'dev'], normal: ['normal'] }
  // The role of the code of crate root `root` in package `m` (see depCrate).
  const roleOf = (m, root) => (root === buildScript(m) ? 'build' : (linksDevDeps(root) ? 'test' : 'normal'))
  // Of a dependency's tables (in order), for each role the first of each platform that may apply that
  // `find` finds a package for, as `{ t, key }` (`*` for an untargeted table, else its platform;
  // `build-script ` before a build script's beside another role's). `any`: a role lacking any takes all.
  const linkedTables = (all, roles, platforms, find, any) => {
    const out = []
    const seen = new Set()
    for (const role of roles) {
      const own = all.filter((r) => ROLE_KINDS[role].includes(r.kind))
      const plats = role === 'build' ? ['host'] : platforms
      for (const r of own.length === 0 && any ? all : own) {
        const on = r.target ?? null
        const key = `${role === 'build' && roles.length > 1 ? 'build-script ' : ''}${on === null ? '*' : (cfgPredicate(on) ?? on)}`
        if (seen.has(key) || !plats.some((p) => tableOn(on, r.kind === 'build' ? 'host' : p) !== 'no')) continue
        const t = find(r)
        if (t === null) continue
        seen.add(key)
        out.push({ t, key })
      }
    }
    return out
  }
  // The candidates as crate roots, one per file.
  const asRoots = (found) => {
    const out = []
    for (const { t, key } of found) {
      const file = libPath(t)
      if (file !== null && !out.some((c) => c.file === file)) out.push({ file, key })
    }
    return out
  }
  // depCrate from the exact resolution: the package's dependency of that key, else the unrenamed
  // one whose lib is named that, as the lockfile resolves it.
  const exactCrate = (x, key, norm, roles, platforms) => {
    const deps = x.graph.packages[key].dependencies
    const packageOf = (d) => (d.resolved === undefined ? null : readManifest(x.dirOf.get(d.resolved)))
    const declared = deps.filter((d) => normName(d.name) === norm)
    if (declared.length > 0) return asRoots(linkedTables(declared, roles, platforms, packageOf, true))
    return asRoots(linkedTables(deps.filter((d) => d.name === d.package && d.resolved !== undefined && libName(packageOf(d)) === norm), roles, platforms, packageOf, false))
  }
  // A declared name is the manifest's word: one that doesn't resolve in-tree never falls back to some
  // vendored copy of that name.
  const depCrateUncached = (m, norm, roles, platforms) => {
    const x = m ? exact() : null
    const key = x?.keyOf.get(m.dir)
    if (key !== undefined) return exactCrate(x, key, norm, roles, platforms)
    if (m) {
      const d = m.deps.get(norm)
      if (d) return asRoots(linkedTables([...d.kinds.values()], roles, platforms, (r) => resolveDep(m, d, r), true))
      // A dependency whose lib is named `norm`: only one that may be is resolved (a path
      // dependency's manifest says, a vendored crate's must have that lib name), so a name that is
      // no crate (`u8::MAX`) resolves -- and warns about -- nothing.
      const mayBe = (r) => {
        if (!r.path) return vendored().byLib.has(norm)
        const t = r.dir === null ? null : readManifest(r.dir)
        return Boolean(t?.package) && libName(t) === norm
      }
      for (const other of m.deps.values()) {
        const named = [...other.kinds.values()].filter((r) => !r.renamed && mayBe(r)) // a rename is used by its key, not its lib name
        const found = linkedTables(named, roles, platforms, (r) => {
          const t = resolveDep(m, other, r)
          return t && libName(t) === norm ? t : null
        }, false)
        if (found.length > 0) return asRoots(found)
      }
      return []
    }
    const { byLib, byName } = vendored()
    const found = new Set()
    for (const index of [byLib, byName]) for (const c of index.get(norm) ?? []) found.add(c.dir)
    if (found.size > 1) {
      console.warn(`[loader.cargo] Several vendored crates are named ${norm} (${[...found].join(', ')}) and no manifest says which`)
      return []
    }
    return asRoots([...found].map((dir) => ({ t: readManifest(dir), key: '*' })))
  }

  const crateCandidates = (name, fromFile, { roots = null, units = null } = {}) => {
    const norm = normName(name)
    const m = packageFor(fromFile)
    if (m && libName(m) === norm) {
      const lib = libPath(m)
      if (lib && lib !== fromFile) return [{ file: lib, key: '*' }]
    }
    const roles = m === null ? ['normal'] : [...new Set((roots === null || roots.size === 0 ? [fromFile] : [...roots]).map((r) => roleOf(m, r)))]
    const platforms = units === null || units.size === 0 ? ['target'] : [...new Set([...units].map(unitPlatform))]
    return depCrate(m, norm, roles, platforms)
  }

  // The files describing package `m`'s build, on disk (see buildFilesFor).
  const buildFiles = memoized((m) => {
    const out = [{ path: posix.join(m.dir, 'Cargo.toml'), kind: 'manifest' }]
    if (isVendoredDir(m.dir)) {
      const checksum = posix.join(m.dir, '.cargo-checksum.json')
      if (isFile(join(baseDir, checksum))) out.push({ path: checksum, kind: 'checksum' })
      return out
    }
    const ws = workspaceFor(m.dir)
    if (ws && ws.dir !== m.dir) out.push({ path: posix.join(ws.dir, 'Cargo.toml'), kind: 'manifest' })
    // The build's lockfile and cargo configs, not the package's own: cargo reads only those.
    const lockPath = buildLockPath()
    if (lockPath !== null && isFile(join(baseDir, lockPath))) out.push({ path: lockPath, kind: 'lock' })
    for (const c of configs) if (c.dir !== null) out.push({ path: c.file, kind: 'config' })
    return out
  })
  // The vendored package owning `fileRel`, or null.
  const vendoredPackage = (fileRel) => {
    const m = packageFor(fileRel)
    return m !== null && isVendoredDir(m.dir) ? m : null
  }

  return {
    // Where `cargo vendor` put the registry crates (project-relative): `vendor`, or what
    // .cargo/config.toml names. A package under it is a vendored dependency.
    vendorDir,
    // Identity of the package owning `fileRel` -- `{ dir, name, version }` from the nearest
    // Cargo.toml with a [package] -- or null when no manifest claims it.
    packageInfo(fileRel) {
      const m = packageFor(fileRel)
      return m ? { dir: m.dir, name: m.package.name, version: version(m) } : null
    },
    // Whether `fileRel` is the lib target root of the package owning it (a crate root by role,
    // whatever its name).
    isLibRoot(fileRel) {
      const m = packageFor(fileRel)
      return m !== null && libPath(m) === fileRel
    },
    // The in-tree crate roots a crate name used in `fromFile` (`use name::…`) names, as `[{ file, key
    // }]`: its package's own lib, else depCrate's for the code of each crate root it is compiled in
    // (`roots`) on its units' platforms (`units`); none for a crate not in-tree, std, a non-crate.
    crateCandidates,
    // The first of crateCandidates, or null.
    resolveCrate: (name, fromFile, opts) => crateCandidates(name, fromFile, opts)[0]?.file ?? null,
    // Where the features come from: `{ mode, why }` -- `cargo` (cargo's resolver over the
    // lockfile), `metadata` (`cargo metadata`), or `replay` (the manifests replayed) with `why`
    // cargo's resolver couldn't run.
    resolution() {
      ensureResolved()
      return metadata ? { mode: 'metadata', why: null } : (exact() === null ? { mode: 'replay', why: exactWhy } : { mode: 'cargo', why: null })
    },
    isTestTarget,
    // The dependencies the build of the packages at `dirs` links that nothing in-tree answers (a registry
    // crate not vendored, a path outside the bundle root), as `{ key, name, from }`: dev-dependencies
    // only for a dev entry's package, build-dependencies only with `buildScripts` and a build script.
    lackingDependencies(dirs, { buildScripts = false } = {}) {
      ensureResolved()
      const counts = (kind, dir) => (kind === 'dev' ? devRootDirs().has(dir) : (kind !== 'build' || (buildScripts && buildScript(readManifest(dir)) !== null)))
      const out = []
      const seen = new Set()
      for (const { dir, key, name, kinds } of [...(lacking?.values() ?? []), ...(metadata?.lacking ?? [])]) {
        const m = dirs.has(dir) ? readManifest(dir) : null
        const from = m?.package ? `${m.package.name} ${version(m)}` : null
        if (from === null || seen.has(`${from}\0${key}`) || ![...kinds].some((k) => counts(k, dir))) continue
        seen.add(`${from}\0${key}`)
        out.push({ key, name, from })
      }
      return out
    },
    // Whether `fromFile`'s package declares a dependency of that name (in any table, by the key
    // code uses): then the name is that crate -- rustc refuses a `use` path whose lead a glob
    // import also provides, as ambiguous (E0659) -- in-tree or not.
    declaresCrate(name, fromFile) {
      return packageFor(fromFile)?.deps.has(normName(name)) === true
    },
    // The build's target: its triple and cfg set (`unix`, `target_os="linux"`, … as rustc prints
    // them), or null for both when none was given.
    targetTriple: targetInfo?.triple ?? null,
    targetCfgs: targetInfo?.cfgs ?? null,
    // The files on disk that describe the build of `fileRel`'s package, as `{ path, kind }`: a vendored
    // package's Cargo.toml and `.cargo-checksum.json`; any other's Cargo.toml, its workspace's in the
    // bundle root, and the build's Cargo.lock and cargo configs (not a path dependency's own).
    buildFilesFor(fileRel) {
      const m = packageFor(fileRel)
      return m ? buildFiles(m) : []
    },
    // Throws when `fileRel` is a vendored package's file whose bytes (`buf`) aren't the ones its
    // `.cargo-checksum.json` lists, or of a package whose checksum isn't the one Cargo.lock locks
    // (checkLocked): cargo refuses to build it, and so the bundle does.
    checkVendoredFile(fileRel, buf) {
      const m = vendoredPackage(fileRel)
      if (m === null) return
      checkVendored(m.dir, fileRel, buf)
      checkLocked(m)
    },
    // Whether `fileRel` belongs to a vendored package (a registry's copy or a git checkout's).
    isVendored(fileRel) {
      return vendoredPackage(fileRel) !== null
    },
    // The integrity of the crate `cargo vendor` copied the vendored package owning `fileRel` from: its
    // `.cargo-checksum.json`'s package checksum, a sha256, held to the one the build's Cargo.lock locks
    // (checkLocked). Undefined for a git checkout's copy, one without that file, or a package not vendored.
    vendoredIntegrity(fileRel) {
      const m = vendoredPackage(fileRel)
      if (m === null) return undefined
      checkLocked(m)
      return archiveIntegrity('cargo', checksumOf(m.dir)?.package)
    },
    // Where `cargo vendor` copied the vendored package owning `fileRel` from (copySource); null when it
    // could be either, or isn't vendored.
    vendoredFrom(fileRel) {
      const m = vendoredPackage(fileRel)
      return m === null ? null : copySource(m.dir)
    },
    // The build script of `fileRel`'s package, project-relative, when there is one on disk:
    // `[package] build = "…"`, else `build.rs` beside the manifest; `build = false` means none. A
    // vendored package's may not name a file outside the package (a published crate never does).
    buildScriptOf(fileRel) {
      const m = packageFor(fileRel)
      return m ? buildScript(m) : null
    },
    // The custom cfgs the build of `fileRel`'s package may set, `{ names, any }` (a `--cfg` a default
    // build lacks is otherwise presumed off): what its build script prints, itself or through a crate
    // it calls, and what rustflags set. One object per package (and one for all that set none).
    cfgsSetFor(fileRel) {
      const m = packageFor(fileRel)
      return upsert(cfgsSetMemo, m?.dir ?? '\0', () => {
        rustflagCfgs ??= rustflagsCfgsOf(configs)
        const script = m ? buildScript(m) : null
        const printed = script === null ? NO_CFGS_SET : cfgsPrinted(crateTexts(script))
        const helpers = script === null || printed.any ? NO_CFGS_SET : helpersPrinted(m)
        const any = printed.any || helpers.any
        const names = new Set([...rustflagCfgs, ...printed.names, ...helpers.names])
        return names.size === 0 && !any ? NO_CFGS_SET : { names, any }
      })
    },
    // The features on for certain for the package owning `fileRel`, compiled as `unit` (see
    // unitOfCrate); null when unknown: no owning manifest, nothing to resolve from, or a package the
    // build doesn't pull in (its gated code is then kept).
    featuresFor(fileRel, unit = TARGET_UNIT) {
      const m = packageFor(fileRel)
      if (!m) return null
      const node = nodeKey(unitFeatureCtx(unit), m.dir)
      const { sure, all } = ensureResolved()
      return sure.get(node) ?? (all.has(node) ? NO_FEATURES : null)
    },
    // The features on only in some of the builds the loader can't tell apart (a target-specific
    // table it can't decide, or what only such a table requests), for the same package and unit;
    // null when there are none.
    maybeFeaturesFor(fileRel, unit = TARGET_UNIT) {
      const m = packageFor(fileRel)
      if (!m) return null
      return maybeOf(nodeKey(unitFeatureCtx(unit), m.dir))
    },
    // Every package of a context the build may pull in: dir -> { on, maybe }, the features on for
    // certain and those on only maybe (a package only an undecided table pulls in has every
    // feature of its maybe). For diagnostics and tests.
    featureResolution(context = 'target') {
      const out = new Map()
      const prefix = nodeKey(context, '')
      const { sure, all } = ensureResolved()
      for (const node of all.keys()) {
        if (node.startsWith(prefix)) out.set(node.slice(prefix.length), { on: sure.get(node) ?? NO_FEATURES, maybe: maybeOf(node) ?? NO_FEATURES })
      }
      return out
    },
    // Every resolved package of a context: dir -> Set<feature on for certain>. For diagnostics and tests.
    resolvedFeatures(context = 'target') {
      const out = new Map()
      const prefix = nodeKey(context, '')
      for (const [node, set] of ensureResolved().sure) if (node.startsWith(prefix)) out.set(node.slice(prefix.length), set)
      return out
    },
    // The compile unit of a crate root `libFile` named from code compiled as `fromUnit`: a proc-macro
    // crate, and anything code compiled for the host names, is built for the host in the host's
    // feature context; else the namer's unit.
    unitOfCrate(libFile, fromUnit = TARGET_UNIT) {
      return packageFor(libFile)?.lib.procMacro === true || unitPlatform(fromUnit) === 'host' ? HOST_UNIT : fromUnit
    },
    // The unit of a build script of a package compiled as `pkgUnit`: for the host, with the
    // package's features.
    buildScriptUnit(pkgUnit = TARGET_UNIT) {
      return unitKey(unitFeatureCtx(pkgUnit), 'host')
    },
    // The cfgs and triple of the platform `unit` compiles for, as far as known (see platformInfo).
    platformOf(unit = TARGET_UNIT) {
      return platformInfo(unitPlatform(unit))
    },
  }
}
