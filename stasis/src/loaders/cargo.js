// Cargo manifests for the Rust loader: dependency resolution among in-tree crates (path deps, `cargo
// vendor`ed ones) and feature resolution as `cargo build` does it: cargo's own resolver where it can run, else a replay.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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

export const VENDOR_DIR = 'vendor'

// A crate name as source spells it (`use proc_macro2`): Cargo allows `-`, rustc doesn't.
export const normName = (name) => name.replaceAll('-', '_')

const table = (v) => (isTomlTable(v) ? v : null)

export function normalizeRel(dir, sub) {
  if (isAbsolute(sub) || posix.isAbsolute(sub)) return null
  const rel = posix.join(dir, sub)
  return posixPathEscapes(rel) ? null : rel
}

// A `[features]` entry asking a feature of a dependency: `key/feat` or `key?/feat`.
const DEP_FEATURE_RE = /^([^/?]+)(\?)?\/(.+)$/u

export function parseFeatureList(values) {
  return [...new Set(values.flatMap((s) => s.split(/[\s,]+/u)).filter(Boolean))]
}

const targetDirOf = (pkgDir, fileRel) => (pkgDir !== '.' && pkgDir !== '' && fileRel.startsWith(`${pkgDir}/`) ? fileRel.slice(pkgDir.length + 1) : fileRel).split('/')[0]

export function isTestTargetPath(pkgDir, fileRel) {
  return ['tests', 'benches'].includes(targetDirOf(pkgDir, fileRel))
}

const readNamed = (file, read) => nameErrors(file, read, [TomlError, LockfileError])

const requestKey = (d) => (d.target === undefined ? d.kind : `${d.kind}@${d.target}`)

// `cargo` as @preventive/lockfile reads it, plus the lib target and build script. `deps` are keyed by
// `use` spelling, each table (`normal`, `dev@cfg(windows)`) a request of its own.
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
      // A git dependency's repository URL, another registry's name or index than crates.io's.
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

const satisfies = (version, req) => {
  const v = parseVersion(version)
  const comparators = parseVersionReq(req)
  return v !== undefined && comparators !== undefined && matches(comparators, v)
}

// Beside the nearest manifest at or above `baseDir` with a `[workspace]`, else beside its own. A lock
// further up is another project's: `--locked` for it would make cargo refuse to create the one it needs.
export function findCargoLock(baseDir, host = diskHost) {
  const root = ancestors(baseDir).find((dir) => {
    const file = join(dir, 'Cargo.toml')
    const text = readText(host, file)
    return text !== null && 'workspace' in readToml(text, file)
  }) ?? baseDir
  const candidate = join(root, 'Cargo.lock')
  return isFile(candidate, host) ? candidate : null
}

// Whitespace inside string literals is kept: `my = "a  b"` and `my = "a b"` are two values.
export const normalizeCfg = (pred) => pred.replaceAll(/"(?:[^"\\]|\\.)*"|\s+/gu, (m) => (m.startsWith('"') ? m : ' ')).trim()

// `r#true` and `r#false` keep their `r#`: names apart from the literals `true` and `false`.
export const cfgName = (written) => (/^r#(?:true|false)$/u.test(written) ? written : written.replace(/^r#/u, ''))

const CFG_LEAF_RE = /^(?:r#)?([A-Za-z_]\w*)\s*(?:=\s*"([^"]*)")?$/u

// The cfg keys rustc sets from the target alone. Not among them: what the build profile sets, a
// `target_feature` the build may change (`-C target-cpu=native`), and `target_thread_local` (never on stable).
export const TARGET_CFG_KEYS = new Set(['unix', 'windows', 'target_abi', 'target_arch', 'target_endian', 'target_env', 'target_family', 'target_has_atomic', 'target_os', 'target_pointer_width', 'target_vendor'])

// False when the predicate never holds in the build, true when it always does, null when unknown. An
// unknown leaf met more than once is tried both ways (up to six of them): `all(any(test, kani), not(kani))` never holds.
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
function evalCfgWith(pred, env, assume, free = null) {
  const p = pred.trim()
  const m = /^(all|any|not)\s*\(([\s\S]*)\)$/u.exec(p)
  if (!m) {
    if (p === 'true' || p === 'false') return p === 'true' // the literals (rustc 1.88)
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
const unanimous = (each) => (each.every((r) => r === false) ? false : (each.every((r) => r === true) ? true : null))

export function parseRustcCfg(text) {
  return new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))
}

// Never let rustup install a toolchain on the loader's behalf, whatever a `rust-toolchain` file says.
const TOOL_ENV = { ...process.env, RUSTUP_AUTO_INSTALL: '0' }
// A rustup proxy obeys the `rust-toolchain(.toml)` of its cwd and parents, which may name any binary:
// never run in the (untrusted) project nor a world-writable temp dir, but in the home directory --
// unless it is or lies inside the bundle root (by real path), then in the filesystem root.
function toolCwd(baseDir) {
  const home = homedir()
  const root = parse(process.cwd()).root
  if (!home) return root
  if (baseDir === null) return home
  const base = canonicalizePath(baseDir)
  const homeAbs = canonicalizePath(home)
  return homeAbs === base || homeAbs.startsWith(base.endsWith(sep) ? base : base + sep) ? root : home
}

// `$RUSTC` when set, as cargo honours it (a target only another toolchain knows, as Solana's).
function rustc(args, what, baseDir) {
  const bin = process.env.RUSTC || 'rustc'
  const r = spawnSync(bin, args, { cwd: toolCwd(baseDir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: TOOL_ENV })
  if (r.error) throw new Error(`${bin} could not run (${r.error.message}); ${what} needs rustc on PATH (or $RUSTC)`, { cause: r.error })
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')} failed (exit ${r.status}):\n${(r.stderr ?? '').trim()}`)
  return r.stdout
}

export function rustcTargetCfgs(target, baseDir = null) {
  const triple = target === 'host' ? /^host: (\S+)$/mu.exec(rustc(['-vV'], '--cargo-target=host', baseDir))?.[1] ?? null : target
  if (triple === null) throw new Error('rustc -vV printed no host triple')
  return { triple, cfgs: parseRustcCfg(rustc(['--print', 'cfg', '--target', triple], '--cargo-target', baseDir)) }
}

// Opt-in (`--cargo`): cargo reads the project's `.cargo/config.toml` and may touch the registry.
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

// A dependency on a package neither inside the bundle root nor vendored (`locate`) is `lacking`.
export function resolutionFromMetadata(metadata, baseDir, { locate = null } = {}) {
  const realBase = canonicalizePath(baseDir)
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

// `.cargo/config`, which cargo prefers, else `.cargo/config.toml`.
const cargoConfigAt = (abs) => ['.cargo/config', '.cargo/config.toml'].map((f) => join(abs, f)).find((file) => isFile(file)) ?? null

// Nearest first, up to the filesystem's root ($CARGO_HOME's aside); `dir` is null above the bundle root.
function cargoConfigs(baseDir, from) {
  const baseAbs = resolve(baseDir)
  const out = []
  for (const abs of ancestors(join(baseAbs, from))) {
    const found = cargoConfigAt(abs)
    const text = found === null ? null : readText(diskHost, found)
    if (text === null) continue
    const file = toPosix(relative(baseAbs, found))
    out.push({ dir: projectRel(baseAbs, abs), abs, file, text, doc: readToml(text, file) })
  }
  return out
}
const projectRel = (baseAbs, absDir, path = '.') => normalizeRel('.', toPosix(relative(baseAbs, resolve(absDir, path))))

// The `directory` of the source `[source.crates-io] replace-with` names (through any chain), else of
// the one source some `replace-with` names, else `vendor`. One outside the bundle root or missing is warned of.
function vendorDirOf(baseDir, configs, { quiet = false } = {}) {
  // Each key from the nearest config.
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

function rustflagsCfgsOf(configs) {
  const names = new Set()
  const add = (value) => {
    const flags = Array.isArray(value) ? value.filter((f) => typeof f === 'string') : (typeof value === 'string' ? value.split(/\s+/u).filter(Boolean) : [])
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i]
      const arg = flag === '--cfg' ? flags[++i] : (flag.startsWith('--cfg=') ? flag.slice('--cfg='.length) : null)
      const name = typeof arg === 'string' ? /^(?:r#)?[A-Za-z_]\w*/u.exec(arg)?.[0] : undefined
      if (name !== undefined) names.add(cfgName(name))
    }
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
// The cfgs build-script code may print as `cargo:rustc-cfg=<name>`, outside full-line comments; `any`
// when it may print one the loader can't read (a formatted name, as cfg_aliases does, build-rs, autocfg).
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

const canonicalUrl = (url) => url.trim().replace(/\/+$/u, '').replace(/\.git$/u, '').replace(/^([a-z][\w+.-]*:\/\/)([^/]*)/iu, (m) => m.toLowerCase())
const cfgPredicate = (spec) => /^cfg\((.*)\)$/su.exec(spec)?.[1]
const CRATES_IO_INDEXES = new Set(['https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io'].map(canonicalUrl))

const globSegment = (seg) => new RegExp(`^${seg.replaceAll(/[.+^${}()|\\]/gu, '\\$&').replaceAll('[!', '[^').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')}$`, 'u')

// The stand-in platforms cargo's resolver is run against (see resolveGraph): each carries a mark of
// its own, and the cfgs and a mark of the name of the platform it stands in for, where known.
const MARK_TARGET = '__stasis_target'
const MARK_HOST = '__stasis_host'
const MARK_NAME = '__stasis_target_name'
const standInPlatform = (mark, info) => ({ name: mark, cfg: [mark, ...(info === null ? [] : [...info.cfgs, `${MARK_NAME}="${info.triple}"`])] })
function retarget(graph, to) {
  const packages = Object.create(null)
  for (const [key, pkg] of Object.entries(graph.packages)) {
    packages[key] = { ...pkg, dependencies: pkg.dependencies.map((d) => (d.target === undefined ? d : { ...d, target: to(d.target) })) }
  }
  return { ...graph, packages }
}

const NO_CFGS_SET = { names: new Set(), any: false }

// A compile unit, `<features>|<platform>`: the feature context its code sees (`host` for what is built
// for the host, which resolver 2 keeps apart) and the platform it is compiled for.
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
  // Null for a root, a vendored crate (a published one inherits nothing) or none.
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
  const excludes = (doc, abs, pkgAbs) => {
    const under = (p) => typeof p === 'string' && (pkgAbs === join(abs, p) || pkgAbs.startsWith(`${join(abs, p)}${sep}`))
    const list = (v) => (Array.isArray(v) ? v : [])
    return list(doc.workspace.exclude).some(under) && !list(doc.workspace.members).some(under)
  }
  // Read for what members inherit, its resolver and `[patch]`, never bundled.
  const outerWorkspace = memoized((abs) => {
    const file = join(abs, 'Cargo.toml')
    const text = readText(diskHost, file)
    const label = toPosix(relative(baseAbs, file))
    const doc = text === null ? null : readToml(text, label)
    return isTomlTable(doc?.workspace) ? { dir: null, outside: abs, file: label, doc, ...manifestOf(text, doc, label, null) } : undefined
  })
  // A vendored package's is `unchecked` until readManifest checks it.
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
  // A vendored package's manifest is checked against its `.cargo-checksum.json` before what it says
  // decides anything. Only a listing of the vendor directory reads one unchecked: cargo checks only a copy it builds.
  const readManifest = (dir) => {
    const m = manifestAt(dir)
    if (m?.unchecked) {
      checkVendored(dir, m.file, tableOf(dir).buf)
      m.unchecked = false
    }
    return m
  }
  const manifestPath = (m, path) => (m.outside === undefined ? normalizeRel(m.dir, path) : projectRel(baseAbs, m.outside, path))
  const packageFor = memoized((fileRel) => {
    for (let dir = posix.dirname(fileRel); ; dir = posix.dirname(dir)) {
      const m = readManifest(dir)
      if (m?.package) return m
      if (dir === '.' || dir === '') return null
    }
  }, (fileRel) => posix.dirname(fileRel))
  const rootManifestOf = (m) => (m.isWorkspace ? m : (m.workspaceRoot ?? m))
  // A vendored package's targets may not leave its directory: a published crate's never do.
  const ownTarget = (m, rel) => rel !== null && (!isVendoredDir(m.dir) || rel.startsWith(`${m.dir}/`))
  const libPath = memoized((m) => {
    const rel = normalizeRel(m.dir, m.lib.path ?? 'src/lib.rs')
    const inside = ownTarget(m, rel)
    if (rel !== null && !inside) console.warn(`[loader.cargo] Refusing lib path outside its package: ${m.lib.path} in ${m.dir}`)
    return inside && isFile(join(baseDir, rel)) ? rel : null
  })
  const libName = (m) => normName(m.lib.name ?? m.package?.name ?? '')
  const buildScript = memoized((m) => {
    const rel = m.package.build === false ? null : normalizeRel(m.dir, m.package.build ?? 'build.rs')
    const inside = ownTarget(m, rel)
    if (rel !== null && !inside && isFile(join(baseDir, rel))) console.warn(`[loader.cargo] Refusing build script outside its package: ${m.package.build} in ${m.dir}`)
    return inside && isFile(join(baseDir, rel)) ? rel : null
  })
  const isTestTarget = (fileRel) => isTestTargetPath(packageFor(fileRel)?.dir ?? '.', fileRel)
  // An example, unlike a test or bench, isn't compiled with `cfg(test)`, but links the dev-dependencies too.
  const linksDevDeps = (fileRel) => ['tests', 'benches', 'examples'].includes(targetDirOf(packageFor(fileRel)?.dir ?? '.', fileRel))
  const devRootDirs = memoized(() => new Set(entries.filter(linksDevDeps).map((e) => packageFor(e)?.dir)))
  const version = (m) => m.package.version

  // Cargo is taken to run in the first entry's package, unless the entry is a vendored crate's (whose
  // config cargo never reads), else the bundle root. Its configs set the vendor dir, `[patch]` and rustflags.
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
  const isVendoredDir = (dir) => dir !== vendorDir && dir.startsWith(`${vendorDir}/`)
  // `git`: whether the copy is a git checkout's (no package checksum), null without `.cargo-checksum.json`.
  const vendored = memoized(() => {
    const index = { byName: new Map(), byLib: new Map() }
    let dirs = []
    try {
      dirs = readdirSync(join(baseDir, vendorDir))
    } catch { /* no vendor dir */ }
    for (const d of dirs) {
      if (d.startsWith('.')) continue // a directory source reads none of these
      const m = manifestAt(`${vendorDir}/${d}`)
      if (!m?.package) continue
      const entry = { version: version(m), dir: m.dir, git: checksumOf(m.dir)?.git ?? null }
      upsert(index.byName, normName(m.package.name), () => []).push(entry)
      upsert(index.byLib, libName(m), () => []).push(entry)
    }
    return index
  })
  // `package` the crate's sha256 in hex (none for a git checkout's copy: `git`), `files` each file's.
  const checksumOf = memoized((dir) => {
    const file = posix.join(dir, '.cargo-checksum.json')
    const text = readText(diskHost, join(baseDir, file))
    if (text === null) return null
    let value
    try {
      value = JSON.parse(text)
    } catch (err) {
      throw new Error(`${file}: not JSON: ${err.message}`, { cause: err })
    }
    return value === null ? null : { text, git: (value?.package ?? null) === null, package: typeof value?.package === 'string' ? value.package : null, files: isPlainObject(value?.files) ? value.files : {} }
  })
  const copySource = (dir) => {
    const git = checksumOf(dir)?.git
    return git === undefined ? null : (git ? 'git' : 'registry')
  }
  // cargo refuses to build a file changed since `cargo vendor`; an unlisted file, or a package without the list, passes.
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
  // A package checksum other than the one Cargo.lock locks is a copy of another crate, which cargo refuses to build.
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
  const buildPackage = memoized(() => entries.map(packageFor).find((m) => m && !isVendoredDir(m.dir)) ?? null)
  // Its Cargo.lock, resolver and `[patch]` are the build's.
  const buildWorkspaceRoot = () => {
    const pkg = buildPackage()
    return pkg === null ? readManifest('.') : rootManifestOf(pkg)
  }
  // Null when the workspace root lies above the bundle root: its lockfile is cargo's, never read.
  const buildLockPath = () => {
    const root = buildWorkspaceRoot()
    return root?.outside === undefined ? posix.join(root?.dir ?? '.', 'Cargo.lock') : null
  }
  const lockfile = memoized(() => {
    const file = buildLockPath()
    const text = file === null ? null : readText(diskHost, join(baseDir, file))
    if (text === null) return null
    const lock = readNamed(file, () => parseCargoLock(text))
    const byId = new Map()
    for (const [key, p] of Object.entries(lock.packages)) upsert(byId, `${normName(p.name)} ${p.version}`, () => []).push(key)
    return { file, lock, byId }
  })
  const metadata = cargo
    ? resolutionFromMetadata(runCargoMetadata(join(baseDir, runDir), { features, noDefaultFeatures, allFeatures, platform: targetInfo?.triple ?? null }), baseDir, {
        locate: (name, ver) => (typeof name === 'string' ? vendored().byName.get(normName(name))?.find((c) => c.version === ver)?.dir ?? null : null),
      })
    : null
  // In the order they apply: the cargo configs' (nearest first), then the workspace root manifest's.
  const patchSources = memoized(() => {
    const root = buildWorkspaceRoot()
    return [
      ...configs.map((c) => ({ patch: readNamed(c.file, () => parseCargoConfig([c.text])).patch, at: (path) => projectRel(baseAbs, c.abs, path), from: c.file })),
      ...(root ? [{ patch: root.cargo.patch, at: (path) => manifestPath(root, path), from: root.file }] : []),
    ]
  })
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
  const patchesSource = (source, r) => {
    if (r.source === 'git') return r.origin !== null && canonicalUrl(source) === canonicalUrl(r.origin)
    if (r.source !== 'registry') return false
    if (r.origin === null) return source === 'crates-io' || CRATES_IO_INDEXES.has(canonicalUrl(source))
    return source === r.origin || canonicalUrl(source) === canonicalUrl(r.origin)
  }
  const sourceKind = (source) => (source === undefined ? 'path' : (source.startsWith('git+') ? 'git' : 'registry'))
  // For a vendored copy, the locked package of its name and version from where the copy came from.
  const lockKeysOf = (lk, m) => {
    const keys = lk.byId.get(`${normName(m.package.name)} ${version(m)}`) ?? []
    if (!isVendoredDir(m.dir)) return keys.filter((k) => lk.lock.packages[k].source === undefined)
    const kind = copySource(m.dir)
    return keys.filter((k) => lk.lock.packages[k].source !== undefined && (kind === null || sourceKind(lk.lock.packages[k].source) === kind))
  }
  // A path, a `[patch]` path whose version fits, else the vendored copy Cargo.lock pins for `m` or the one
  // that fits. Null when it isn't in-tree, and warned when the copies don't settle it: none is guessed.
  const depTargets = new Map() // the fixed-point loop asks many times
  const resolveDep = (m, dep, request, { quiet = false } = {}) => {
    const found = upsert(nestedMap(depTargets, m.dir), request, () => {
      const warnings = []
      return { t: resolveDepUncached(m, dep, request, (w) => warnings.push(w)), warnings }
    })
    if (!quiet) warnDep(m, request)
    return found.t
  }
  // Said once: the replay warns only of the declarations the build links.
  const warnDep = (m, request) => {
    for (const w of depTargets.get(m.dir)?.get(request)?.warnings.splice(0) ?? []) console.warn(w)
  }
  const resolveDepUncached = (m, dep, request, warn) => {
    const asPackage = (dir) => {
      const t = dir === null ? null : readManifest(dir)
      return t?.package ? t : null
    }
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
    // A copy without `.cargo-checksum.json` could be either.
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
      // A pin the requirement no longer allows: cargo would resolve again, so the requirement decides.
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

  const resolverVersion = memoized(() => {
    const root = buildWorkspaceRoot()
    const edition = Number(root?.package?.edition ?? 0)
    return root?.resolver ?? (edition >= 2024 ? 3 : (edition >= 2021 ? 2 : 1))
  })
  // The host's only when the target is the host: the machine that builds need not be the one that bundles.
  const platformInfo = (platform) => (platform === 'target' ? targetInfo : hostInfo)
  // `maybe` when the platform's cfgs aren't known or don't decide it.
  const tableOn = (spec, platform) => {
    if (spec === null || spec === undefined) return 'yes'
    const info = platformInfo(platform)
    if (info === null) return 'maybe'
    const cfg = cfgPredicate(spec)
    const holds = cfg === undefined ? spec === info.triple : evalCfg(cfg, { target: info.cfgs })
    return holds === true ? 'yes' : (holds === false ? 'no' : 'maybe')
  }
  const nodeKey = (c, dir) => `${resolverVersion() === 1 ? 'target' : c}\0${dir}`

  // Both feature resolutions by cargo's resolver, by nodeKey, run against stand-in platforms: a table
  // the loader can't decide is off for `sure` and on for `all`; `result` is the resolver's own for `all`.
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

  // A declaration nothing in-tree answers, or under resolver 2 a root's dev-dependency no entry builds
  // (`unbuilt`), gets a stand-in with any feature it is asked.
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

  // What resolveDep warned of, it says now of the declarations whose package the build reaches.
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

  const subdirs = (dir) => {
    try {
      return readdirSync(join(baseDir, dir), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => (dir === '.' ? e.name : `${dir}/${e.name}`))
    } catch {
      return []
    }
  }
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
      for (const { dir: sub } of readManifest(dir).deps.values().flatMap((d) => d.kinds.values())) {
        if (sub !== null && inRoot(sub) && !isExcluded(sub) && readManifest(sub)?.package) out.add(sub)
      }
    }
    return [...out]
  }
  // The build as cargo resolves it, where the loader holds all it takes; else null, `exactWhy` saying what's missing.
  let exactWhy = null
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
    const keyOf = new Map()
    const dirOf = new Map()
    const queue = [...memberDirs]
    for (const { patch, at, from } of patchSources()) {
      for (const spec of Object.values(patch).flatMap((specs) => Object.values(specs))) {
        if (spec.source.type !== 'path') continue
        const dir = at(spec.source.path)
        if (dir === null) return notExact(`${from} patches with a path outside the bundle root`)
        queue.push(dir)
      }
    }
    for (const dir of queue) {
      if (keyOf.has(dir)) continue
      const m = readManifest(dir)
      if (!m?.package) return notExact(`${posix.join(dir, 'Cargo.toml')} isn't a package's`)
      const key = `${m.package.name} ${m.package.version}`
      keyOf.set(dir, key)
      dirOf.set(key, dir)
      for (const r of m.deps.values().flatMap((d) => d.kinds.values())) {
        if (r.path === null) continue
        if (r.dir === null) return notExact(`${m.package.name}'s path dependency ${r.path} lies outside the bundle root`)
        queue.push(r.dir)
      }
    }
    // A copy the lockfile doesn't list needs no checksums: cargo never reads it.
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

  let resolved = null
  let lacking = null
  const ensureResolved = () => {
    if (resolved !== null) return resolved
    // cargo metadata's is a per-package union over every build: each feature in it is only maybe on.
    if (metadata) {
      const byNode = new Map([...metadata.enabled].flatMap(([dir, set]) => [[nodeKey('target', dir), set], [nodeKey('host', dir), set]]))
      resolved = { sure: new Map(), all: byNode }
    } else {
      resolved = exact()?.resolved ?? null
      if (resolved === null) ({ resolved, lacking } = replay())
    }
    return resolved
  }
  const maybeOf = memoized((node) => {
    const { sure, all } = ensureResolved()
    const on = sure.get(node)
    const maybe = new Set([...(all.get(node) ?? [])].filter((f) => !on?.has(f)))
    return maybe.size === 0 ? null : maybe
  })
  // A package in the `all` resolution but not the `sure` one is built only maybe: nothing of its is on for certain.
  const NO_FEATURES = new Set()

  let rustflagCfgs = null
  const cfgsSetMemo = new Map()
  // A crate root's text and that of the modules it declares, a few levels down.
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

  // What a build script may print through the crates it calls, as cfg_aliases' `cfg_aliases!` does.
  const helpersPrinted = (m) => {
    const crates = new Map()
    if (linksLacking(m, 'build', crates)) return { names: new Set(), any: true }
    const names = new Set()
    for (const t of crates.values()) {
      const printed = libPrinted(t)
      if (printed.any) return printed
      for (const name of printed.names) names.add(name)
    }
    return { names, any: false }
  }
  const linksLacking = (p, kind, crates) => [...p.deps.values()].some((d) => [...d.kinds.values()].some((r) => {
    if (r.kind !== kind || tableOn(r.target, 'host') === 'no') return false
    const t = resolveDep(p, d, r)
    if (t === null) return true
    if (crates.has(t.dir)) return false
    crates.set(t.dir, t)
    return linksLacking(t, 'normal', crates)
  }))
  const libPrinted = memoized((t) => {
    const lib = libPath(t)
    return lib === null ? NO_CFGS_SET : cfgsPrinted(crateTexts(lib))
  }, (t) => t.dir)

  // The in-tree crate roots a name resolves to from package `m`, through each table the code's `roles`
  // link on its `platforms` (`key` naming which); for no package, the one vendored crate.
  const crateTargets = new Map() // every file of a package asks for the same few crates
  const depCrate = (m, norm, roles, platforms) => upsert(crateTargets, `${m?.dir ?? ''}\0${norm}\0${roles.join()}\0${platforms.join()}`, () => depCrateUncached(m, norm, roles, platforms))
  const ROLE_KINDS = { build: ['build'], test: ['normal', 'dev'], normal: ['normal'] }
  const roleOf = (m, root) => (root === buildScript(m) ? 'build' : (linksDevDeps(root) ? 'test' : 'normal'))
  // For each role, the first table of each platform that may apply that `find` finds a package for.
  // `any`: a role lacking any takes all.
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
  const asRoots = (found) => {
    const out = []
    for (const { t, key } of found) {
      const file = libPath(t)
      if (file !== null && !out.some((c) => c.file === file)) out.push({ file, key })
    }
    return out
  }
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
      // Only a dependency that may have lib name `norm` is resolved, so a name that is no crate
      // (`u8::MAX`) resolves -- and warns about -- nothing.
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

  const buildFiles = memoized((m) => {
    const out = [{ path: posix.join(m.dir, 'Cargo.toml'), kind: 'manifest' }]
    if (isVendoredDir(m.dir)) {
      const checksum = posix.join(m.dir, '.cargo-checksum.json')
      if (isFile(join(baseDir, checksum))) out.push({ path: checksum, kind: 'checksum' })
      return out
    }
    const ws = rootManifestOf(m)
    if (ws.isWorkspace && ws.outside === undefined && ws.dir !== m.dir) out.push({ path: posix.join(ws.dir, 'Cargo.toml'), kind: 'manifest' })
    // The build's lockfile and cargo configs, not the package's own: cargo reads only those.
    const lockPath = buildLockPath()
    if (lockPath !== null && isFile(join(baseDir, lockPath))) out.push({ path: lockPath, kind: 'lock' })
    for (const c of configs) if (c.dir !== null) out.push({ path: c.file, kind: 'config' })
    return out
  })
  const vendoredPackage = (fileRel) => {
    const m = packageFor(fileRel)
    return m !== null && isVendoredDir(m.dir) ? m : null
  }

  return {
    vendorDir,
    packageInfo(fileRel) {
      const m = packageFor(fileRel)
      return m ? { dir: m.dir, name: m.package.name, version: version(m) } : null
    },
    isLibRoot(fileRel) {
      const m = packageFor(fileRel)
      return m !== null && libPath(m) === fileRel
    },
    // `roots`: the crate roots `fromFile` is compiled in; `units`: the units they are compiled as.
    crateCandidates,
    resolveCrate: (name, fromFile, opts) => crateCandidates(name, fromFile, opts)[0]?.file ?? null,
    // `cargo` (cargo's resolver over the lockfile), `metadata`, or `replay` with `why` cargo's resolver couldn't run.
    resolution() {
      ensureResolved()
      return metadata ? { mode: 'metadata', why: null } : (exact() === null ? { mode: 'replay', why: exactWhy } : { mode: 'cargo', why: null })
    },
    isTestTarget,
    // Dev-dependencies only for a dev entry's package, build-dependencies only with `buildScripts` and a build script.
    lackingDependencies(dirs, { buildScripts = false } = {}) {
      ensureResolved()
      const counts = (kind, dir) => (kind === 'dev' ? devRootDirs().has(dir) : (kind !== 'build' || (buildScripts && buildScript(readManifest(dir)) !== null)))
      const out = new Map()
      for (const { dir, key, name, kinds } of [...(lacking?.values() ?? []), ...(metadata?.lacking ?? [])]) {
        const m = dirs.has(dir) ? readManifest(dir) : null
        const from = m?.package ? `${m.package.name} ${version(m)}` : null
        if (from === null || out.has(`${from}\0${key}`) || ![...kinds].some((k) => counts(k, dir))) continue
        out.set(`${from}\0${key}`, { key, name, from })
      }
      return [...out.values()]
    },
    // A declared name is that crate, in-tree or not: rustc refuses a `use` path whose lead a glob import
    // also provides, as ambiguous (E0659).
    declaresCrate(name, fromFile) {
      return packageFor(fromFile)?.deps.has(normName(name)) === true
    },
    targetTriple: targetInfo?.triple ?? null,
    targetCfgs: targetInfo?.cfgs ?? null,
    buildFilesFor(fileRel) {
      const m = packageFor(fileRel)
      return m ? buildFiles(m) : []
    },
    checkVendoredFile(fileRel, buf) {
      const m = vendoredPackage(fileRel)
      if (m === null) return
      checkVendored(m.dir, fileRel, buf)
      checkLocked(m)
    },
    isVendored(fileRel) {
      return vendoredPackage(fileRel) !== null
    },
    // Undefined for a git checkout's copy, one without `.cargo-checksum.json`, or a package not vendored.
    vendoredIntegrity(fileRel) {
      const m = vendoredPackage(fileRel)
      if (m === null) return undefined
      checkLocked(m)
      return archiveIntegrity('cargo', checksumOf(m.dir)?.package)
    },
    vendoredFrom(fileRel) {
      const m = vendoredPackage(fileRel)
      return m === null ? null : copySource(m.dir)
    },
    buildScriptOf(fileRel) {
      const m = packageFor(fileRel)
      return m ? buildScript(m) : null
    },
    // A `--cfg` a default build lacks is otherwise presumed off.
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
    // Null when unknown, as for a package the build doesn't pull in: its gated code is then kept.
    featuresFor(fileRel, unit = TARGET_UNIT) {
      const m = packageFor(fileRel)
      if (!m) return null
      const node = nodeKey(unitFeatureCtx(unit), m.dir)
      const { sure, all } = ensureResolved()
      return sure.get(node) ?? (all.has(node) ? NO_FEATURES : null)
    },
    // On only in some of the builds the loader can't tell apart (a target-specific table it can't decide).
    maybeFeaturesFor(fileRel, unit = TARGET_UNIT) {
      const m = packageFor(fileRel)
      return m ? maybeOf(nodeKey(unitFeatureCtx(unit), m.dir)) : null
    },
    // dir -> { on, maybe }: a package only an undecided table pulls in has every feature of its maybe.
    featureResolution(context = 'target') {
      const prefix = nodeKey(context, '')
      const { sure, all } = ensureResolved()
      const inContext = all.keys().filter((node) => node.startsWith(prefix))
      return new Map(inContext.map((node) => [node.slice(prefix.length), { on: sure.get(node) ?? NO_FEATURES, maybe: maybeOf(node) ?? NO_FEATURES }]))
    },
    resolvedFeatures(context = 'target') {
      const prefix = nodeKey(context, '')
      const inContext = ensureResolved().sure.entries().filter(([node]) => node.startsWith(prefix))
      return new Map(inContext.map(([node, set]) => [node.slice(prefix.length), set]))
    },
    unitOfCrate(libFile, fromUnit = TARGET_UNIT) {
      return packageFor(libFile)?.lib.procMacro === true || unitPlatform(fromUnit) === 'host' ? HOST_UNIT : fromUnit
    },
    buildScriptUnit(pkgUnit = TARGET_UNIT) {
      return unitKey(unitFeatureCtx(pkgUnit), 'host')
    },
    platformOf(unit = TARGET_UNIT) {
      return platformInfo(unitPlatform(unit))
    },
  }
}
