import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'

import { Bundle, isValidRepoField } from '@exodus/stasis-core/bundle'
import { Config, assertOption } from '@exodus/stasis-core/config'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { assembleBundle, expandExtra, validateFiles } from '@exodus/stasis-core/add'
import { getParser, importsTypescriptByOutputName, isResolvableExt, literalSpec, scan, scanCounts } from '../scan.js'
import { METRO_RELEASE_DEFINE, parseDefine } from '../define.js'
import { METRO_ASSET_EXTS, METRO_ASSET_RESOLUTIONS, METRO_SOURCE_EXTS, createFieldResolver, resolveConditions } from '../resolve-fields.js'
import { discoverTsconfig, isDir, isFile, loadTsconfigPaths, packageTsconfigPaths, tsconfigOutputsOf } from '../resolve-typescript.js'
import { createMetroResolver } from '../metro-resolver.js'
import { ASSET_REGISTRY } from '../metro-assets.js'
import { createAliases, createBabelAliases, createBabelTypeImportsKept } from '../babel.js'
import { AUTO_INCLUDES, RN_CORE_INCLUDE_FILES, linkedNativePackages, linkedPackages, listing, looksNative, metroAssetFiles, nativeInputs } from '@exodus/stasis-plugins/metro-native'
import { installedRecords, pinInstalled } from '../installed.js'
import { State } from '@exodus/stasis-core/state'
import { bundledIntegrity, readFileSyncMaybe } from '@exodus/stasis-core/state-util'
import { checkoutCommit, detectRepo, normalizeEntries, packageLookup, packageJSONStat, packageType, parseGithubRepository, readJson, readModuleManifest, readPackageJson, readRegularFileOrNull, scopeManifestOf } from '@exodus/stasis-core/bundle-util'
import { attestsAny, BUNDLE_FILE, CONFIG_FILE, EMPTY_MODULE_PATH, assertRealPathWithinBase, classifyFormat, dependencyEcosystem, fileInBucket, archiveIntegrity, hasNodeModulesSegment, heldToAccounts, isDotEnvFile, isPathWithin, isPlainObject, JS_EXTENSIONS, LOCK_FILE, memoized, moduleFileKey, moduleFileKeys, moduleInfo, nestedMap, nodeExtFormat, observeExecutable, parseExtraOption, parseLockfilesOption, parseResourcesOption, posixPathEscapes, relativeEscapes, splitNodeModulesPath, toPosix, upsert, withAttestedOf, withMetadataOf } from '@exodus/stasis-core/util'
import { diskHost } from '@exodus/stasis-core/host'
import { linksOn, parsePolicy, recordedIn } from '@exodus/stasis-core/policy'
import { parseBundleBytes } from '@exodus/stasis-core/brotli'
import { parseSoldeerLockfile } from '@preventive/lockfile/soldeer.js'
import { isAssetFile } from '@preventive/rn/metro-assets.js'
import { added as addedTo } from '@preventive/rn/src/rn-config.js'
import { globRegExp, isPathGlob, packagesOf, restrictionsOf } from '@preventive/rn/src/restrictions.js'
import {
  SOLIDITY_PACKAGE_MANIFESTS,
  SOLIDITY_ROOT_MANIFESTS,
  buildSolidityTree,
  collectSolidityFilesFromDisk,
  discoverSolidityConfig,
  expandSolidityEntries,
} from '../loaders/solidity.js'
import { decodeUtf8, solidityOwnership } from '../loaders/solidity-ownership.js'
import { buildBashTree, collectBashFilesFromDisk } from '../loaders/bash.js'
import { boundaryOf, collectRustBundle, withinRealDir } from '../loaders/rust.js'
import { createCargoContext } from '../loaders/cargo.js'
import { ancestors } from '../loaders/paths.js'
import {
  bucketizePhpSources,
  buildPhpTree,
  collectPhpFilesFromDisk,
  loadComposerAutoload,
  loadComposerPackages,
  loadLaravelProviderFiles,
} from '../loaders/php.js'
import { bundledSummary, lockedSummary, lockfileOnlyError, packagesLabel, unpackedSummary, writeBundle, writeFile } from './output.js'
import { withNpmToken } from './tokens.js'

const BASH_EXTS = new Set(['.sh', '.bash'])
const RUST_EXTS = new Set(['.rs'])
const nonEmpty = (list) => Array.isArray(list) && list.length > 0

// The deepest dir holding every one of `paths`, relative to `cwd` (`..` where they escape it, by remapping).
export function outermostDir(paths, cwd) {
  if (paths.length === 0) return '.'
  const cwdAbs = posix.resolve(toPosix(cwd))
  const [first, ...rest] = paths.map((p) => posix.dirname(posix.resolve(cwdAbs, p)).split('/'))
  let depth = 0
  while (depth < first.length && rest.every((parts) => parts[depth] === first[depth])) depth++
  return posix.relative(cwdAbs, first.slice(0, depth).join('/') || '/') || '.'
}

// A Soldeer dependency's folder `<name>-<version>`; 0.0.0 where it ends in no semver, as every bucket attests one.
function parseSoldeerDir(seg) {
  const m = /^(.+)-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/u.exec(seg)
  return m ? { name: m[1], version: m[2] } : { name: seg, version: '0.0.0' }
}

// A url as git fetches from a host: scp's `[user@]host:path`, or a URL of a transport of git's own (lowercase).
// Not `ssh://git@github.com:owner/name` (host `github.com:owner` to git), `git+https://`, nor a bare path.
const GIT_URL = /^(?:[^/]*:(?!\/\/)|(?:https?|git|ssh|git\+ssh|ssh\+git):\/\/(?:[^/@]*@)?[^/:@]*(?::\d*)?\/)/u

// Not npm's `github:owner/name` (the host `github` to git), nor one with a `#`, which git keeps in the path.
const submoduleGithub = (url) => (GIT_URL.test(url) && !/^github:/iu.test(url) && !url.includes('#') ? parseGithubRepository(url.replace(/^ssh\+git:/u, 'ssh:')) : null)

function githubSubmodules(submodules) {
  const named = submodules.map(({ path, url, branch }) => [path, { name: url && submoduleGithub(url), branch }])
  return new Map(named.filter(([, { name }]) => name))
}

const repoRootAt = (github, commit) => (isValidRepoField('github', github) && isValidRepoField('commit', commit) ? { github, directory: '', commit } : undefined)

// soldeer.lock's lock of each dependency, by its folder: a GitHub git one's `repo` at its `rev`, a zip's
// `integrity`. None where `ownership` refuses it or it can't be read: metadata never stops a build.
function soldeerLocks(baseDir, ownership, host) {
  const { reason, real, outside } = ownership.of('soldeer.lock')
  let lock = null
  try {
    const buf = reason || real === null || outside ? null : readRegularFileOrNull(join(host.realpath(baseDir), real), 'soldeer.lock', host)
    lock = buf === null ? null : parseSoldeerLockfile(decodeUtf8(buf, 'soldeer.lock'))
  } catch { /* unreadable, or not one Soldeer writes: nothing is recorded of it */ }
  const locks = new Map()
  for (const dep of Object.values(lock?.dependencies ?? {})) {
    locks.set(`${dep.name}-${dep.version}`, dep.type === 'git' ? { repo: repoRootAt(parseGithubRepository(dep.git), dep.rev) } : { integrity: archiveIntegrity('soldeer', dep.checksum) })
  }
  return locks
}

// A bucket's `repo` is its checkout's HEAD; a Soldeer git dependency's only at its soldeer.lock `rev`.
function makeSolidityClassifier(baseDir, ownership, host) {
  const submodules = githubSubmodules(ownership.submodules)
  const versionOf = memoized((sub) => readPackageJson(baseDir, moduleFileKey(sub, 'package.json'), { strict: true, check: ownership.assert, host })?.version)
  const commitOf = memoized((dir) => checkoutCommit(join(baseDir, dir), host))
  let soldeer
  return (path) => {
    const seg = path.startsWith('dependencies/') ? path.slice('dependencies/'.length).split('/')[0] : ''
    if (seg) {
      const { name, version } = parseSoldeerDir(seg)
      const bucketDir = `dependencies/${seg}`
      soldeer ??= soldeerLocks(baseDir, ownership, host)
      const { repo: locked, integrity } = soldeer.get(seg) ?? {}
      const repo = locked !== undefined && commitOf(bucketDir) === locked.commit ? locked : undefined
      return { bucketDir, name, version, ecosystem: 'soldeer', integrity, ...(repo && { repo }) }
    }
    for (const [sub, { name, branch }] of submodules) {
      if (path === sub || path.startsWith(`${sub}/`)) {
        const version = versionOf(sub)
        const repo = repoRootAt(name, commitOf(sub))
        return { bucketDir: sub, name, version: version ?? branch ?? '0.0.0', ecosystem: 'github', ...(repo && { repo }) }
      }
    }
    return null
  }
}

// Only a registry's copy is `cargo`, which `stasis audit` asks OSV about: a git checkout's or one with no
// `.cargo-checksum.json` is never sent to a public advisory database.
const vendoredEcosystem = (from) => (from === 'registry' ? 'cargo' : from === 'git' ? 'cargo-git' : 'cargo-unknown')

function makeRustClassifier(cargo) {
  return (path) => {
    const pkg = cargo.packageInfo(path)
    if (!pkg) return null
    const ecosystem = cargo.isVendored(path) ? vendoredEcosystem(cargo.vendoredFrom(path)) : undefined
    return { bucketDir: pkg.dir, name: pkg.name, version: pkg.version, ecosystem, ...(ecosystem === 'cargo' && { integrity: cargo.vendoredIntegrity(path) }) }
  }
}

// Null where `rel` isn't a regular file (a FIFO would hang a read) or doesn't really lie in `within` (a
// vendored crate's manifest linked to a project file).
function readFileWithinBase(baseDir, realBase, rel, within) {
  try {
    assertRealPathWithinBase(realBase, baseDir, rel)
    if (!withinRealDir(baseDir, rel, within, { who: 'loader.cargo' })) return null
    if (!statSync(join(baseDir, rel)).isFile()) return null
    return readFileSync(join(baseDir, rel))
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null
    throw err
  }
}

function assertEntries(name, entries, what, isEntry, noun = what) {
  if (!nonEmpty(entries)) throw new Error(`${name}: at least one entry ${what} is required`)
  for (const e of entries) if (!isEntry(e)) throw new Error(`${name}: not a ${noun}: ${e}`)
}

function assertSelfContained(lang, noun, entries, sources, missing) {
  const issues = [...entries].filter((entry) => !sources.has(entry)).map((entry) => `Missing entry: ${entry}`)
  for (const { spec, from, reason } of missing) issues.push(`Unresolved ${noun}: ${spec} from ${from}${reason ? ` (refused: ${reason})` : ''}`)
  if (issues.length > 0) throw new Error(`${lang} bundle has unresolved ${noun}s:\n${issues.map((s) => `  ${s}`).join('\n')}`)
}

// Each source in `classifyDep(path)`'s bucket, else its package.json's, else in "." under the workspace identity,
// as Bundle.parse needs every bucket to attest one.
function assembleCodeBundle({
  baseDir, entries, sources, resolutions, keyedResolutions, workspaceName, workspaceVersion = '0.0.0', format, formats, conditionKey, classifyDep, host,
  packageOf = packageLookup(baseDir, { host }), consumer, consumerFiles,
}) {
  const modules = new Map()
  const ensureBucket = (dir, identity) => {
    const bucket = modules.get(dir)
    modules.set(dir, bucket === undefined ? moduleInfo({ ...identity, files: Object.create(null) }) : withMetadataOf(bucket, identity))
    return modules.get(dir)
  }

  for (const [path, content] of sources) {
    const dep = classifyDep?.(path)
    if (dep) {
      ensureBucket(dep.bucketDir, dep).files[fileInBucket(dep.bucketDir, path)] = content
      continue
    }
    const meta = packageOf(path)
    // One of node_modules whose nearest package.json is the workspace root's (or none) is a misconfigured dep.
    if (splitNodeModulesPath(path) !== null && !(meta && hasNodeModulesSegment(meta.pkgDir))) {
      throw new Error(`No package.json with name+version found for ${path}`)
    }
    const [dir, identity] = meta ? [meta.pkgDir, meta] : ['.', { name: workspaceName, version: workspaceVersion }]
    ensureBucket(dir, identity).files[fileInBucket(dir, path)] = content
  }

  return codeBundle({ baseDir, entries, sources, modules, resolutions, keyedResolutions, format, formats, conditionKey, host, consumer, consumerFiles })
}

function codeBundle({ baseDir, entries, sources, modules, resolutions, keyedResolutions = new Map(), format, formats, conditionKey, host, consumer = 'bundle', consumerFiles }) {
  const formatsMap = new Map()
  for (const path of sources.keys()) {
    const fileFormat = formats?.get(path) ?? format
    if (fileFormat !== undefined) formatsMap.set(path, fileFormat)
  }
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(entries),
    modules,
    formats: formatsMap,
    imports: new Map([[conditionKey, new Map(resolutions)], ...keyedResolutions]),
    // Off disk: a synthetic source with no file is not executable.
    executable: new Set([...sources.keys()].filter((path) => observeExecutable(join(baseDir, path), host) === true)),
  }).withReason(consumer, consumerFiles)
}

// Never carried, whatever reads them, however cased: `.env` files, and Hardhat's config, which is code.
const neverCarried = (rel) => isDotEnvFile(rel) || posix.basename(rel).toLowerCase().startsWith('hardhat.config.')

// --manifests: carried as written, secrets too.
function solidityManifests(baseDir, sources, configFiles, { classifyDep, packageOf, ownership, host }) {
  const realBase = host.realpath(baseDir)
  // `{ text }`, or `{ why }` it can't be carried (null: nothing is there).
  const carry = (rel) => {
    const { reason, real, outside } = ownership.of(rel)
    if (reason) return { why: reason }
    if (real === null) return { why: null }
    if (outside) throw new Error(`Refusing to follow symlink escaping bundle root: ${rel} -> ${resolve(realBase, real)}`)
    const buf = readRegularFileOrNull(join(realBase, real), rel, host)
    return buf === null ? { why: null } : { text: decodeUtf8(buf, rel) }
  }
  const unreproducible = (rel, why) => new Error(`--manifests can't carry ${rel}, which the Solidity resolution read: ${why}`)
  const out = new Map()
  for (const rel of configFiles) {
    // Absolute: the OS couldn't give its real path (see projectRelative).
    if (posix.isAbsolute(rel)) throw unreproducible(rel, "its real path can't be resolved")
    if (posixPathEscapes(rel)) throw unreproducible(rel, 'it lies outside the bundle root')
    if (neverCarried(rel)) throw unreproducible(rel, '.env files and hardhat.config.* are never carried')
    if (sources.has(rel)) continue
    const { text, why } = carry(rel)
    if (text === undefined) throw unreproducible(rel, why ?? 'it is gone')
    out.set(rel, text)
  }
  const optional = new Set(SOLIDITY_ROOT_MANIFESTS)
  for (const path of sources.keys()) {
    const dirs = [classifyDep(path)?.bucketDir, packageOf(path)?.pkgDir].filter((d) => d !== undefined)
    for (const dir of dirs) for (const name of SOLIDITY_PACKAGE_MANIFESTS) optional.add(moduleFileKey(dir, name))
  }
  for (const rel of optional) {
    if (sources.has(rel) || out.has(rel)) continue
    const { text, why } = carry(rel)
    if (why) console.warn(`[stasis] Not carrying ${rel}: ${why}`)
    if (text !== undefined) out.set(rel, text)
  }
  return new Map([...out.keys()].toSorted().map((rel) => [rel, out.get(rel)]))
}

// Or an extensionless path that doesn't exist: a project without `script/` still bundles with `src test script`.
const isDirEntry = (abs, host) => isDir(abs, host) || (extname(abs) === '' && host.stat(abs) === null)

export const isSolidityEntry = (entry, cwd = process.cwd(), host = diskHost) => entry.endsWith('.sol') || isDirEntry(resolve(cwd, entry), host)

// `fetched` false: `host` is an empty tree standing in for one not fetched yet, which can't say what is missing.
export function directoryEntryError(entries, cwd = process.cwd(), host = diskHost, { fetched = true } = {}) {
  const dirs = entries.filter((e) => isDirEntry(resolve(cwd, e), host))
  const absent = fetched ? dirs.filter((e) => host.stat(resolve(cwd, e)) === null) : []
  if (absent.length > 0 && absent.length === entries.length) return `no such file or directory: ${absent[0]}`
  if (dirs.length === 0 || entries.every((e) => e.endsWith('.sol') || dirs.includes(e))) return null
  return absent.length > 0
    ? `no such file or directory: ${absent[0]}`
    : `a directory entry is only supported for Solidity bundles (it stands for the .sol files under it): ${dirs[0]}`
}

// A missing directory entry is skipped; `env` supplies FOUNDRY_PROFILE / FOUNDRY_REMAPPINGS.
export async function buildSolidityBundle({ cwd = process.cwd(), entries, mappingFile, manifests = false, env = process.env, host = diskHost } = {}) {
  if (!nonEmpty(entries)) throw new Error('buildSolidityBundle: at least one entry .sol file or directory is required')
  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)
  for (const e of normalized) if (!isSolidityEntry(e, baseDir, host)) throw new Error(`buildSolidityBundle: not a .sol file or directory: ${e}`)
  const expanded = expandSolidityEntries(baseDir, normalized, host)
  const { remappings, libs, ownership, files: configFiles, envUsed } = discoverSolidityConfig(baseDir, { mappingFile, env, host })
  // The bundle doesn't record the environment, so say when it shaped the resolution.
  if (envUsed.length > 0) console.warn(`[stasis] Solidity imports resolved with ${envUsed.join(', ')} from the environment`)
  const sources = collectSolidityFilesFromDisk(baseDir, expanded, remappings, { libs, ownership, host })
  const { resolutions, missing } = buildSolidityTree(sources, { remappings, baseDir, libs, ownership, host })
  assertSelfContained('Solidity', 'import', expanded, sources, missing)
  const classifyDep = makeSolidityClassifier(baseDir, ownership, host)
  const packageOf = packageLookup(baseDir, { strict: true, check: ownership.assert, host })
  const bundled = new Map(sources)
  const formats = new Map()
  if (manifests) {
    for (const [path, text] of solidityManifests(baseDir, sources, configFiles, { classifyDep, packageOf, ownership, host })) {
      bundled.set(path, text)
      formats.set(path, posix.basename(path) === 'package.json' ? 'json' : 'resource')
    }
  }
  return assembleCodeBundle({
    baseDir, entries: expanded, sources: bundled, resolutions, workspaceName: 'solidity-bundle', format: 'solidity', formats,
    conditionKey: 'solidity', classifyDep, packageOf, host,
  })
}

// A local `source` resolving to no bundled script is fatal; an external one (PATH, `$VAR`, out of the root) dropped.
export async function buildBashBundle({ cwd = process.cwd(), entries } = {}) {
  assertEntries('buildBashBundle', entries, '.sh/.bash file', (e) => BASH_EXTS.has(extname(e)))
  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)
  const sources = await collectBashFilesFromDisk(baseDir, normalized)
  const { resolutions, missing } = buildBashTree(sources)
  assertSelfContained('Bash', 'script', normalized, sources, missing)
  return assembleCodeBundle({ baseDir, entries: normalized, sources, resolutions, workspaceName: 'bash-bundle', format: 'shell', conditionKey: 'shell' })
}

// The entries alone, as written: a TEAL program includes no other file.
export async function buildTealBundle({ cwd = process.cwd(), entries } = {}) {
  assertEntries('buildTealBundle', entries, '.teal file', (e) => e.endsWith('.teal'))
  const baseDir = resolve(cwd)
  const realBase = realpathSync(baseDir)
  const normalized = normalizeEntries(entries, cwd)
  const sources = new Map()
  for (const rel of new Set(normalized)) {
    const buf = readFileWithinBase(baseDir, realBase, rel, '.')
    if (buf !== null) sources.set(rel, decodeUtf8(buf, rel))
  }
  assertSelfContained('TEAL', 'program', normalized, sources, [])
  return assembleCodeBundle({ baseDir, entries: normalized, sources, workspaceName: 'teal-bundle', format: 'teal', conditionKey: 'teal' })
}

// Entry crate roots, their `mod`s and the in-tree crates they reach, features resolved as `cargo build` would.
export async function buildRustBundle({ cwd = process.cwd(), entries, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false, cargoTarget = null, cargoManifests = false } = {}) {
  assertEntries('buildRustBundle', entries, '.rs file', (e) => RUST_EXTS.has(extname(e)))
  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)
  // One Cargo context for the walk, the edges and the bucketing, so their crate and feature decisions agree.
  const cargoCtx = createCargoContext(baseDir, {
    entries: normalized, cargo, features: cargoFeatures, noDefaultFeatures: cargoNoDefaultFeatures, allFeatures: cargoAllFeatures, target: cargoTarget,
  })
  const { sources, formats, tree } = await collectRustBundle(baseDir, normalized, { cargo: cargoCtx, buildScripts: cargoManifests })
  if (cargoManifests) {
    // Carried as written, credentials too; a file that isn't UTF-8 is refused, not altered.
    const files = new Set()
    for (const path of sources.keys()) for (const f of cargoCtx.buildFilesFor(path)) files.add(f.path)
    const realBase = realpathSync(baseDir)
    for (const rel of files) {
      if (sources.has(rel)) continue
      const buf = readFileWithinBase(baseDir, realBase, rel, boundaryOf(rel, cargoCtx))
      if (buf === null) continue
      cargoCtx.checkVendoredFile(rel, buf)
      if (!isUtf8(buf)) throw new Error(`Rust manifest is not valid UTF-8: ${rel}`)
      sources.set(rel, buf.toString('utf8'))
      formats.set(rel, 'resource')
    }
  }
  const { resolutions, missing, unresolvedCrates } = tree
  assertSelfContained('Rust', 'module', normalized, sources, missing)
  const resolution = cargoCtx.resolution()
  if (resolution.mode === 'replay' && normalized.some((e) => cargoCtx.packageInfo(e) !== null)) {
    console.warn(`[stasis] Rust features from a replay of the manifests, not cargo's resolver: ${resolution.why}`)
  }
  if (debugging()) {
    const mode = { cargo: "cargo's resolver", metadata: 'cargo metadata', replay: 'manifest replay' }[resolution.mode]
    for (const context of ['target', 'host']) {
      const resolved = [...cargoCtx.resolvedFeatures(context)].toSorted(([a], [b]) => (a < b ? -1 : 1))
      console.warn(`[stasis] Rust features (${mode}, ${context}), ${resolved.length} package${resolved.length === 1 ? '' : 's'}:`)
      for (const [dir, set] of resolved) {
        const pkg = cargoCtx.packageInfo(moduleFileKey(dir, 'Cargo.toml'))
        console.warn(`[stasis]   ${pkg?.name ?? '?'}@${pkg?.version ?? '?'} (${dir}): ${[...set].toSorted().join(', ') || '(none)'}`)
      }
    }
  }
  const notLoaded = tree.wantedRoots.filter((r) => !sources.has(r)).map((r) => `${cargoCtx.packageInfo(r)?.name ?? r} (${r})`)
  const bundledPackages = new Set([...sources.keys()].map((p) => cargoCtx.packageInfo(p)?.dir).filter((d) => d !== undefined))
  const lacking = cargoCtx.lackingDependencies(bundledPackages, { buildScripts: cargoManifests })
    .filter((d) => !unresolvedCrates.has(d.key))
    .map((d) => `${d.name} (a dependency of ${d.from})`)
  if (unresolvedCrates.size > 0 || notLoaded.length > 0 || lacking.length > 0) {
    const names = [...new Set([...unresolvedCrates, ...notLoaded, ...lacking])].toSorted()
    const shown = names.slice(0, 10).join(', ') + (names.length > 10 ? `, ... and ${names.length - 10} more` : '')
    console.warn(`[stasis] ${names.length} crate${names.length === 1 ? '' : 's'} referenced but not in the bundle: ${shown}`)
    if (!existsSync(join(baseDir, cargoCtx.vendorDir))) console.warn('[stasis] Registry dependencies are bundled only when vendored in-tree: run `cargo vendor` first.')
  }
  return assembleCodeBundle({
    baseDir, entries: normalized, sources, resolutions, workspaceName: 'rust-bundle', format: 'rust', formats, conditionKey: 'rust',
    classifyDep: makeRustClassifier(cargoCtx),
  })
}

// Scanned statically, no PHP executed: the require/include graph strictly, Composer's autoload best-effort.
export async function buildPhpBundle({ cwd = process.cwd(), entries } = {}) {
  assertEntries('buildPhpBundle', entries, '.php file', (e) => e.endsWith('.php'))
  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)
  const autoload = loadComposerAutoload(baseDir)
  const packages = loadComposerPackages(baseDir)
  // Laravel auto-discovers service providers: seeded as roots so their config/route/view files come along.
  const providerRoots = loadLaravelProviderFiles(baseDir, autoload, packages)
  const sources = await collectPhpFilesFromDisk(baseDir, [...normalized, ...providerRoots], { autoload })
  const { resolutions, missing } = buildPhpTree(sources, { baseDir, autoload })
  assertSelfContained('PHP', 'import', normalized, sources, missing)
  const modules = bucketizePhpSources(baseDir, sources, 'php-bundle', '0.0.0', packages)
  return codeBundle({ baseDir, entries: normalized, sources, modules, resolutions, format: 'php', conditionKey: 'php' })
}

function displayPath(url, baseDir) {
  const abs = fileURLToPath(url)
  const rel = relative(baseDir, abs)
  return rel && !relativeEscapes(rel) ? rel : abs
}

function describeUnresolved(u, show) {
  const typescript = u.typescriptURL ? `; resolves to ${show(u.typescriptURL)} under --typescript` : ''
  return `${u.kind} ${u.spec ?? '<dynamic>'} from ${show(u.parentURL)} (${u.reason}${typescript})`
}

// Static ESM edges load before user code, so a failure there is uncatchable, unlike one past a require()/import().
const STATIC_KINDS = new Set(['import', 'export-from'])

function linkedThrough(scanner, roots, follows) {
  const linked = new Set(roots)
  const walk = [...linked]
  for (let i = 0; i < walk.length; i++) {
    for (const e of scanner.files.get(walk[i])?.edges ?? []) {
      if (e.child && !linked.has(e.child) && follows(e)) {
        linked.add(e.child)
        walk.push(e.child)
      }
    }
  }
  return linked
}

const eagerlyLinked = (scanner) => linkedThrough(scanner, scanner.entries, (e) => STATIC_KINDS.has(e.kind))

// A file outside the root (`within`) the entries link eagerly is `outside`, for the caller to refuse; one reached
// only past a require()/import() is left out with what only it reaches, its edges `leftOut`, misses load can catch.
function withinRoot(scanner, within) {
  const outside = [...eagerlyLinked(scanner)].filter((url) => scanner.files.has(url) && !within(url))
  if (outside.length > 0) return { scanner, outside, leftOut: [] }
  const kept = linkedThrough(scanner, [...scanner.entries].filter((url) => scanner.files.has(url)), (e) => scanner.files.has(e.child) && within(e.child))
  if (kept.size === scanner.files.size) return { scanner, outside, leftOut: [] }
  const leftOut = []
  const files = new Map()
  for (const url of kept) {
    const info = scanner.files.get(url)
    const edges = info.edges.map((e) => {
      if (!e.child || within(e.child)) return e
      const { child, ...rest } = e
      leftOut.push({ parentURL: url, kind: e.kind, spec: e.spec, outsideURL: child })
      return { ...rest, error: 'outside the project root' }
    })
    files.set(url, { ...info, edges })
  }
  const imports = new Map()
  for (const [key, byParent] of scanner.imports) {
    const parents = new Map()
    for (const [parentURL, specMap] of byParent) {
      if (!files.has(parentURL)) continue
      const specs = new Map([...specMap].filter(([, childURL]) => within(childURL)))
      if (specs.size > 0) parents.set(parentURL, specs)
    }
    if (parents.size > 0) imports.set(key, parents)
  }
  const unresolved = scanner.unresolved.filter((u) => files.has(u.parentURL))
  const parseErrors = scanner.parseErrors.filter((p) => files.has(p.url))
  return { scanner: { entries: scanner.entries, files, imports, unresolved, parseErrors }, outside, leftOut }
}

const listed = (items, line = (s) => s) => {
  const more = items.length > 10 ? `\n  ... and ${items.length - 10} more` : ''
  return items.slice(0, 10).map((x) => `  ${line(x)}`).join('\n') + more
}

// `fatal`: broken at load, a parse error, or a miss `generated(u)` says a generator would write; else
// `tolerated`, a catchable runtime miss. `typescript`: whether a fatal miss resolves under --typescript.
function analyzeScanner(scanner, { baseDir, generated }) {
  const show = (url) => displayPath(url, baseDir)
  const staticReachable = eagerlyLinked(scanner)
  const fatal = []
  const tolerated = []
  let typescript = false
  for (const u of scanner.unresolved) {
    const why = generated?.(u)
    if (why === undefined && !(STATIC_KINDS.has(u.kind) && staticReachable.has(u.parentURL))) tolerated.push(u)
    else {
      fatal.push(`unresolved ${describeUnresolved(u, show)}${why === undefined ? '' : `: ${why}`}`)
      typescript ||= u.typescriptURL !== undefined
    }
  }
  // A file the parser couldn't read cleanly has unknown or partial edges, never a graph to record.
  for (const p of scanner.parseErrors) fatal.push(`parse error in ${show(p.url)}: ${p.message}`)
  // An edge to a file a source bundle can't carry (.node/.wasm/extensionless), which load would die on.
  for (const byParent of scanner.imports.values()) {
    for (const [parentURL, specMap] of byParent) {
      for (const [spec, childURL] of specMap) {
        if (!scanner.files.has(childURL)) fatal.push(`${spec} from ${show(parentURL)} resolves to ${show(childURL)}, which a source bundle can't carry`)
      }
    }
  }
  return { fatal, tolerated, typescript }
}

function reportScanIssues({ fatal, tolerated, typescript, leftOut }, { label = '', baseDir, root }) {
  const where = label ? ` (${label})` : ''
  const show = (url) => displayPath(url, baseDir)
  if (fatal.length > 0) {
    throw Object.assign(new Error(`JS bundle would be broken at load time${where}:\n${listed(fatal)}`), { resolvesUnderTypescript: typescript })
  }
  if (tolerated.length > 0) {
    const summary = listed(tolerated, (u) => describeUnresolved(u, show))
    console.warn(`[stasis] Bundle has ${tolerated.length} unresolved import(s)${where}; they will fall through at load time:\n${summary}`)
  }
  if (leftOut.length > 0) {
    const summary = listed(leftOut, (u) => `${u.kind} ${u.spec} from ${show(u.parentURL)} (at ${relative(baseDir, fileURLToPath(u.outsideURL))})`)
    console.warn(`[stasis] Bundle leaves out ${leftOut.length} import(s) of files outside the project root${root}${where}; they will fall through at load time:\n${summary}`)
  }
}

// Trimmed, empties dropped, so a sloppy programmatic caller can't push a bogus token into the resolver.
const cleanConditions = (conditions) => conditions.map((c) => (typeof c === 'string' ? c.trim() : c)).filter(Boolean)

// Without --typescript the `paths` only hint a miss, so a tsconfig that doesn't load is none.
function typescriptPathsFor(typescript, baseDir, tsconfig, host, env) {
  if (typescript && tsconfig !== undefined) {
    const matcher = loadTsconfigPaths(discoverTsconfig(baseDir, tsconfig, host), host)
    return { matchPaths: (spec) => matcher?.matchPaths(spec) ?? [], outputs: tsconfigOutputsOf({ host }) }
  }
  return packageTsconfigPaths(baseDir, { host, lenient: !typescript, projectCwd: env.PROJECT_CWD })
}

// Through a State, the graph scanned statically: no user code runs. `memo` keeps scans across a lazy tree's rounds.
export async function buildJsBundle({ cwd = process.cwd(), env = process.env, entries, scope, conditions = [], jsx = false, flow = false, typescript = false, tsconfig, resources, define, packageJSON = false, host = diskHost, innermostRoot = false, extra = false, outputsAt = () => [], memo, generated } = {}) {
  assertEntries('buildJsBundle', entries, '.js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx file', (e) => JS_EXTENSIONS.has(extname(e)), 'JS/TS file')
  const baseDir = resolve(cwd)
  const absEntries = entries.map((e) => resolve(baseDir, e))
  const scanConditions = cleanConditions(conditions)
  const resourceSet = parseResourcesOption('buildJsBundle', resources)
  typescript ||= importsTypescriptByOutputName(absEntries, host)
  const typescriptPaths = typescriptPathsFor(typescript, baseDir, tsconfig, host, env)
  const scanned = scan(absEntries, { conditions: scanConditions, jsx, flow, typescript, typescriptPaths, resources: resourceSet, define, host, memo: memo ? nestedMap(memo, 'js') : null, missTargets: generated !== undefined })
  // A round of a lazy tree that asked for a package already is void: the rest is moot.
  if (memo && host.touches() > 0) throw new Error('buildJsBundle: this round reads a package not unpacked yet')
  // bundle:'replace' reads no stasis.code.br on disk; lock:'ignore' leaves the lockfile to heldToLockfile;
  // never written, the State claims nothing, and assertPolicies checks the bundle.
  const stateOptions = { bundle: 'replace', lock: 'ignore', ownLock: true, ...(scope && { scope }), host, claim: false, checkPolicy: false }
  let state = new State(baseDir, { ...stateOptions, env })
  // A root holding a stasis file is the project's own choice, whose config the build takes.
  if (innermostRoot && !STASIS_ROOT_FILES.some((file) => host.stat(join(state.root, file)) !== null)) {
    const root = innermostRootOf(baseDir, [...scanned.files.keys()].map((url) => host.realpath(fileURLToPath(url))), state.root, host)
    // The State's walk up from cwd stops at PROJECT_CWD, as it does where yarn sets it.
    if (root !== state.root) state = new State(baseDir, { ...stateOptions, env: { ...env, PROJECT_CWD: root } })
  }
  const { scanner, outside, leftOut } = withinRoot(scanned, (url) => isPathWithin(state.root, fileURLToPath(url)))
  const root = ` at ${relative(baseDir, state.root) || '.'}${rootedBy(state.root, host, ', which can be removed if stale')}`
  for (const url of outside) throw new Error(`buildJsBundle: ${relative(baseDir, fileURLToPath(url))} is outside the project root${root}`)
  reportScanIssues({ ...analyzeScanner(scanner, { baseDir, generated }), leftOut }, { baseDir, root })
  for (const [url, info] of scanner.files) {
    state.addFile(url, info.resource ? { resource: true, reason: 'bundle' } : { format: info.format, isEntry: scanner.entries.has(url), reason: 'bundle' })
  }
  // An edge every context resolves alike is keyed '*'; one they resolve apart, misses or leave out keeps each
  // target under its own conditions, so no context is served another's file.
  const missed = new Set([...scanner.unresolved, ...leftOut].filter((u) => u.spec !== undefined).map((u) => `${u.parentURL}\0${u.spec}`))
  const byParent = new Map()
  for (const [key, parents] of scanner.imports) {
    for (const [parentURL, specs] of parents) {
      for (const [spec, childURL] of specs) nestedMap(nestedMap(byParent, parentURL), spec).set(key, childURL)
    }
  }
  for (const [parentURL, bySpec] of byParent) {
    for (const [spec, byKey] of bySpec) {
      const targets = new Set(byKey.values())
      if (targets.size === 1 && !missed.has(`${parentURL}\0${spec}`)) {
        state.addImport(parentURL, spec, [...targets][0], { conditions: '*' })
      } else {
        for (const [key, childURL] of byKey) state.addImport(parentURL, spec, childURL, { conditions: key.split(', ') })
      }
    }
  }
  if (extra) state.includeExtra({ outputs: outputsAt(state.root), resources: resources === undefined ? undefined : resourceSet })
  if (packageJSON || state.config.packageJSON) state.includePackageJson()
  return state
}

// The files that root a State in the directory holding one (state.js's discovery).
const STASIS_ROOT_FILES = [CONFIG_FILE, LOCK_FILE, BUNDLE_FILE]

function rootedBy(dir, host = diskHost, hint = '') {
  const markers = STASIS_ROOT_FILES.filter((name) => host.stat(join(dir, name)) !== null)
  return markers.length === 0 ? '' : ` (rooted there by its ${markers.join(' and ')}${hint})`
}

// A package.json with no name (a `{"type":"module"}` marker) roots no State.
function innermostRootOf(baseDir, files, root, host) {
  for (let dir = baseDir; dir !== root && dirname(dir) !== dir; dir = dirname(dir)) {
    if (files.every((file) => isPathWithin(dir, file)) && readPackageJson(dir, 'package.json', { host })?.name !== undefined) return dir
  }
  return root
}

const METRO_MAIN_FIELDS = ['react-native', 'browser', 'main']

// What a React Native app's build loads from its root, though nothing the app imports reaches it.
const METRO_CONFIG_FILE = 'metro.config.js'
const METRO_CONFIG_FILES = [METRO_CONFIG_FILE, 'react-native.config.js']
const RN_CONFIG_FILE = 'rn.config.json'
const BABEL_CONFIG_FILE = 'babel.config.js'
// What else a React Native app's build runs in Node: each package `name` as the packages `via` find it in turn
// (else fewer of them, down to the project), and `file` in it, else its entry, as React Native's CLI runs Metro.
const METRO_VIA = ['react-native', '@react-native/community-cli-plugin', 'metro']
const METRO_TOOLCHAIN = [
  { name: 'react-native', file: 'cli.js', via: [] },
  { name: 'metro', via: METRO_VIA.slice(0, -1) },
  // Loaded by a path: Metro's worker, its transform worker, jest-worker's child process and the Haste worker.
  { name: 'metro', file: 'src/DeltaBundler/Worker.js', via: METRO_VIA.slice(0, -1) },
  { name: 'metro-transform-worker', via: METRO_VIA },
  { name: 'jest-worker', file: 'build/workers/processChild.js', via: METRO_VIA },
  { name: 'metro-file-map', file: 'src/plugins/haste/worker.js', via: METRO_VIA },
  // metro-config's default `minifierPath`, which the transform worker requires.
  { name: 'metro-minify-terser', via: [...METRO_VIA, 'metro-transform-worker'] },
]
// With --babel(-aliases), the `babelTransformerPath` React Native's Metro config names.
const BABEL_TOOLCHAIN = [{ name: '@react-native/metro-babel-transformer', via: ['@react-native/metro-config'] }]
// Beside stasis's Metro plugin (src/metro.js), run by Metro's workers under withStasis().
const STASIS_METRO_TRANSFORMERS = ['metro-transformer.js', 'metro-babel-transformer.js']
const NODE_REQUIRE_CONDITIONS = new Set(['require', 'node', 'node-addons', 'module-sync'])
const REQUIRE_KEY = [...NODE_REQUIRE_CONDITIONS].join(', ')
// What esbuild and webpack 5 both assert besides `import`/`require` and `default`, which Node and Metro never do.
const BUNDLER_CONDITIONS = ['module']

// The legacy-field build's resolver on `platform` (null for --mainFields), and the conditions it adds.
export function fieldResolverFor(platform, { mainFields, metro = false, assetExts, sourceExts = METRO_SOURCE_EXTS, assetResolutions, conditions = [], typescript = false, typescriptPaths = null, host = diskHost, kept }) {
  const extras = metro ? ['react-native', ...(platform === 'web' ? ['browser'] : [])] : [...new Set([...BUNDLER_CONDITIONS, ...conditions])]
  const fields = metro ? METRO_MAIN_FIELDS : mainFields
  const resolver = createFieldResolver({
    mainFields: fields, platform, preferNative: platform !== null && platform !== 'web', sourceExts, conditions: resolveConditions('commonjs', extras),
    metro, assetExts, assetResolutions, typescript, typescriptPaths, host, kept,
  })
  return { extras, mainFields: fields, resolver }
}

function parseJson(text, message) {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(message, { cause })
  }
}

export function readConfigFile(name, cwd, host = diskHost) {
  const text = readFileSyncMaybe(resolve(cwd), CONFIG_FILE, 'utf8', host)
  return text === null ? null : parseJson(text, `${name === undefined ? '' : `${name}: `}${CONFIG_FILE} is not valid JSON`)
}

// Each build held to its entries' Policy, `bundle` to the root's; links followed through `files`, the builds' host.
function assertPolicies(name, { builds = [], builts = [], bundle, root, host = diskHost, files = host, label = CONFIG_FILE }) {
  const links = linksOn(root, files)
  for (const [i, build] of builds.entries()) build.policy?.assertArtifact(builts[i].bundle, { links })
  parsePolicy(label, readConfigFile(name, root, host))?.assertArtifact(bundle, { links })
}

// The stasis.config.json `key` in `cwd`, true where it is left out.
function configFlag(key, name, cwd, host) {
  const value = readConfigFile(name, cwd, host)?.[key]
  if (value === undefined) return true
  if (typeof value !== 'boolean') throw new TypeError(`${CONFIG_FILE}: ${key} must be true or false, got ${JSON.stringify(value)}`)
  return value
}

export const installsDevDependencies = (name, cwd, host) => configFlag('installDevDependencies', name, cwd, host)

// stasis.config.json's `lockfiles`, a tree laid out of each in place of the one detected; undefined where none.
export const configuredLockfiles = (name, cwd, host) => parseLockfilesOption(`${name}: ${CONFIG_FILE}`, readConfigFile(name, cwd, host)?.lockfiles)

// --babel-aliases: babel-plugin-module-resolver's `alias` option as data, from a JSON file in the project.
function readAliasesFile(baseDir, file, host) {
  const rel = relative(baseDir, resolve(baseDir, file))
  if (relativeEscapes(rel)) throw new Error(`stasis bundle: --babel-aliases must name a file in the project: ${file}`)
  const text = readFileSyncMaybe(baseDir, toPosix(rel), 'utf8', host)
  if (text === null) throw new Error(`stasis bundle: --babel-aliases file not found: ${file}`)
  assertRealPathWithinBase(host.realpath(baseDir), baseDir, toPosix(rel), host)
  const alias = parseJson(text, `stasis bundle: --babel-aliases file ${file} is not valid JSON`)
  if (!isPlainObject(alias) || !Object.values(alias).every((value) => typeof value === 'string')) {
    throw new Error(`stasis bundle: --babel-aliases file ${file} must be an object mapping each alias to a string`)
  }
  for (const key of Object.keys(alias)) {
    if (!key.startsWith('^') && !key.endsWith('$')) continue
    try {
      RegExp(key) // compiled to check it, as createAliases compiles it
    } catch (cause) {
      throw new Error(`stasis bundle: --babel-aliases file ${file}: ${JSON.stringify(key)} is not a valid regular expression`, { cause })
    }
  }
  return alias
}

// A --mainFields/--metro build is full-scope alone, so a narrower scope is refused rather than silently ignored.
function fieldBuildOptions(name, { cwd, scope, resources, packageJSON = false, host }) {
  const resourcesGiven = resources !== undefined
  const config = scope === undefined || !resourcesGiven || !packageJSON ? readConfigFile(name, cwd, host) : null
  if (scope !== undefined && scope !== 'full') {
    throw new Error(`${name}: --scope=${scope} is not supported with --mainFields or --metro (they always build a full-scope bundle)`)
  }
  if (scope === undefined && config?.scope !== undefined && config.scope !== 'full') {
    throw new Error(`${name}: ${CONFIG_FILE} sets scope ${JSON.stringify(config.scope)}, which --mainFields and --metro don't support (they always build a full-scope bundle); pass --scope=full to override it`)
  }
  if (config?.packageJSON !== undefined && typeof config.packageJSON !== 'boolean') {
    throw new Error(`${name}: ${CONFIG_FILE} sets packageJSON ${JSON.stringify(config.packageJSON)}, which must be true or false`)
  }
  return {
    resources: resourcesGiven ? parseResourcesOption(name, resources) : parseResourcesOption(CONFIG_FILE, config?.resources),
    packageJSON: packageJSON || config?.packageJSON === true,
  }
}

// Metro's default resolver.emptyModulePath, which it resolves a disabled import to.
const METRO_EMPTY_MODULE = 'node_modules/metro-runtime/src/modules/empty-module.js'
const EMPTY_MODULE_SOURCE = /^(?:(["'])use strict\1;?)?$/u

function metroEmptyModule(baseDir, host) {
  const abs = join(baseDir, METRO_EMPTY_MODULE)
  if (!host.stat(abs)?.isFile()) return null
  const real = host.realpath(abs)
  if (!isPathWithin(host.realpath(baseDir), real)) return null
  const buf = host.readFile(real)
  return isUtf8(buf) && EMPTY_MODULE_SOURCE.test(buf.toString('utf8').trim()) ? real : null
}

// Through each of `via` first, for an install (pnpm) that links `name` only beside the one depending on it.
function packageDirFrom(dir, name, host, via = []) {
  let from = dir
  for (const step of [...via, name]) {
    let d = from
    while (!host.stat(join(d, 'node_modules', step, 'package.json'))?.isFile()) {
      if (dirname(d) === d) return undefined
      d = dirname(d)
    }
    from = host.realpath(join(d, 'node_modules', step))
  }
  return from
}

function requireFrom(dir, spec, host) {
  try {
    return host.resolve(join(dir, 'package.json'), spec, NODE_REQUIRE_CONDITIONS)
  } catch {
    return undefined
  }
}

const parseModule = (file, host, source = host.readFile(file).toString('utf8')) => getParser().parseSync(file, source, { sourceType: 'unambiguous' }).program

function walkAst(node, fn) {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, fn)
    return
  }
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
  fn(node)
  for (const key of Object.keys(node)) if (key !== 'type') walkAst(node[key], fn)
}

// The method `node` calls (`x.concat(...)` -> 'concat'), on the object named `object` where given.
function memberCall(node, object) {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) return undefined
  if (object !== undefined && (node.callee.object.type !== 'Identifier' || node.callee.object.name !== object)) return undefined
  return node.callee.property.name
}

// What `file` names by `require.resolve('x')`, read off its source, never run. -> [specifier, path][]
function requireResolutions(file, host) {
  const resolved = []
  const source = host.readFile(file).toString('utf8')
  // Parsed only where both words occur, however the call spaces them (`require\n  .resolve(`).
  if (!source.includes('require') || !source.includes('resolve')) return resolved
  walkAst(parseModule(file, host, source), (node) => {
    const spec = memberCall(node, 'require') === 'resolve' ? literalSpec(node.arguments[0]) : null
    const path = spec === null ? null : babelPathCall(node, file, host)
    if (path !== null) resolved.push([spec, path])
  })
  return resolved
}

// The name Babel requires a plugin or preset by, as @babel/core's standardizeName has it.
const BABEL_PREFIX = { plugin: /^(?!@|module:|[^/]+\/|babel-plugin-)/u, preset: /^(?!@|module:|[^/]+\/|babel-preset-)/u }
const BABEL_ORG = { plugin: /^(@babel\/)(?!plugin-|[^/]+\/)/u, preset: /^(@babel\/)(?!preset-|[^/]+\/)/u }
const OTHER_ORG = { plugin: /^(@(?!babel\/)[^/]+\/)(?![^/]*babel-plugin(?:-|\/|$)|[^/]+\/)/u, preset: /^(@(?!babel\/)[^/]+\/)(?![^/]*babel-preset(?:-|\/|$)|[^/]+\/)/u }
const OTHER_ORG_DEFAULT = /^(@(?!babel$)[^/]+)$/u
const standardizeBabelName = (type, name) => (isAbsolute(name) ? name : name
  .replace(BABEL_PREFIX[type], `babel-${type}-`)
  .replace(BABEL_ORG[type], `$1${type}-`)
  .replace(OTHER_ORG[type], `$1babel-${type}-`)
  .replace(OTHER_ORG_DEFAULT, `$1/babel-${type}`)
  .replace(/^module:/u, ''))

// A string naming a Babel plugin or preset by its form, a package or a path.
const BABEL_MODULE_STRING = /^module:|babel[-/](?:plugin|preset)/u
// `babel` and `config` in its file's name (create-babel-config.js), or its package's (@org/babel-config).
const BABEL_CONFIG_NAME = /babel.*config|config.*babel/iu
const isBabelConfigModule = (rel) => BABEL_CONFIG_NAME.test(posix.basename(rel)) || BABEL_CONFIG_NAME.test(splitNodeModulesPath(rel)?.name ?? '')

// The name of a key, variable or object holding a list -> what an entry of it is taken as.
const BABEL_LISTS = new Map([['plugins', 'plugin'], ['presets', 'preset']])
const METRO_ASSET_LISTS = new Map([['assetExts', 'asset']])
// The array methods making a list of the one they're called on (`concat` with its arguments').
const LIST_METHODS = new Set(['concat', 'filter', 'flat', 'slice'])
const MAX_LIST_DEPTH = 8
function flatDepth(arg) {
  if (arg === undefined) return 1
  if (arg.type === 'Identifier' && arg.name === 'Infinity') return MAX_LIST_DEPTH
  return arg.type === 'Literal' && typeof arg.value === 'number' ? arg.value : 1
}

// `__dirname`, a string, or a `path.resolve(...)` or `path.join(...)` of them. -> the path, or null
function staticPath(node, file) {
  if (node?.type === 'Identifier' && node.name === '__dirname') return dirname(file)
  const string = literalSpec(node)
  if (string !== null || node?.type !== 'CallExpression' || memberCall(node, 'require') !== undefined) return string
  const name = node.callee.type === 'Identifier' ? node.callee.name : memberCall(node)
  if (name !== 'resolve' && name !== 'join') return null
  const parts = node.arguments.map((arg) => staticPath(arg, file))
  if (parts.length === 0 || parts.includes(null)) return null
  return name === 'resolve' && parts.some((part) => isAbsolute(part)) ? resolve(...parts) : join(...parts)
}

// A staticPath, as Babel takes a plugin named by path, or what `require.resolve('x')` resolves to. -> it, or null
function babelPathCall(node, file, host) {
  if (memberCall(node, 'require') !== 'resolve') {
    const path = node?.type === 'CallExpression' ? staticPath(node, file) : null
    return path === null || isAbsolute(path) || path.startsWith('.') ? path : `./${path}`
  }
  const spec = literalSpec(node.arguments[0])
  const option = node.arguments[1]
  const paths = option?.type === 'ObjectExpression'
    ? option.properties.find((property) => property.type === 'Property' && !property.computed && (property.key.name ?? property.key.value) === 'paths')
    : undefined
  const dirs = paths === undefined ? [dirname(file)] : paths.value.type === 'ArrayExpression' ? paths.value.elements.map((element) => staticPath(element, file)) : [null]
  // One only the run knows, or one relative to its cwd: no telling where Node looks.
  if (spec === null || dirs.some((dir) => dir === null || !isAbsolute(dir))) return null
  for (const dir of dirs) {
    try {
      return host.resolve(join(dir, 'index.js'), spec, NODE_REQUIRE_CONDITIONS)
    } catch { /* not from here: the next */ }
  }
  return null
}

// `entry(type, node)` on each entry (or the first of a `[name, options]` pair) of the `lists` in `program`, read
// through spreads, variables, branches and LIST_METHODS, never run.
function readLists(program, lists, entry) {
  const declarators = []
  walkAst(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) declarators.push(node)
  })
  const inits = Map.groupBy(declarators, (node) => node.id.name)
  const seen = new Map()
  // `depth` levels of arrays in `node` list (2: one `.flat()` flattens), and an array below them is an entry's
  // `[name, options]` pair.
  const read = (node, type, depth) => {
    if (!node || depth > MAX_LIST_DEPTH) return
    const key = `${type}${depth}`
    const keys = upsert(seen, node, () => new Set())
    if (keys.has(key)) return
    keys.add(key)
    if (node.type === 'ArrayExpression') {
      if (depth === 0) return read(node.elements[0], type, 0)
      for (const element of node.elements) {
        if (element?.type === 'SpreadElement') read(element.argument, type, depth)
        else read(element, type, depth - 1)
      }
    } else if (node.type === 'Identifier') {
      for (const { init } of inits.get(node.name) ?? []) read(init, type, depth)
    } else if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
      for (const side of node.type === 'LogicalExpression' ? [node.left, node.right] : [node.consequent, node.alternate]) read(side, type, depth)
    } else if (depth > 0 && LIST_METHODS.has(memberCall(node))) {
      const method = memberCall(node)
      const levels = method === 'flat' ? flatDepth(node.arguments[0]) : 0
      read(node.callee.object, type, Math.min(depth + levels, MAX_LIST_DEPTH))
      if (method === 'concat') for (const arg of node.arguments) read(arg.argument ?? arg, type, arg.type === 'SpreadElement' ? depth + 1 : depth)
    } else {
      entry(type, node)
    }
  }
  const listName = (node) => (node.type === 'Identifier' ? node.name : node.type === 'MemberExpression' && !node.computed ? node.property.name : undefined)
  walkAst(program, (node) => {
    // A list under a key, held in a variable or assigned to a property, so named.
    const [name, value] = node.type === 'Property' && !node.computed ? [node.key.name ?? node.key.value, node.value]
      : node.type === 'VariableDeclarator' ? [listName(node.id), node.init]
      : node.type === 'AssignmentExpression' ? [listName(node.left), node.right]
      : []
    if (lists.has(name)) read(value, lists.get(name), 1)
    // Or added to one: `push` and `unshift` each argument an entry, `concat` as it concatenates.
    const method = memberCall(node)
    const type = method && lists.get(listName(node.callee.object))
    if (!type) return
    if (method === 'concat') read(node, type, 1)
    else if (method === 'push' || method === 'unshift') for (const arg of node.arguments) read(arg.argument ?? arg, type, arg.type === 'SpreadElement' ? 1 : 0)
  })
}

// The plugins and presets `file` lists, as Babel requires them; with `anyString`, any BABEL_MODULE_STRING too.
function babelNamedModules(file, host, { anyString = false } = {}) {
  const program = parseModule(file, host)
  const named = new Set()
  readLists(program, BABEL_LISTS, (type, node) => {
    const name = literalSpec(node)
    const path = name ? null : babelPathCall(node, file, host)
    if (name) named.add(standardizeBabelName(type, name))
    else if (path) named.add(path)
  })
  if (anyString) {
    walkAst(program, (node) => {
      const string = literalSpec(node)
      if (string && BABEL_MODULE_STRING.test(string)) named.add(string.replace(/^module:/u, ''))
    })
  }
  return named
}

// Metro's default assetExts and each the Metro config `file` lists, read off its source (one it filters out too).
function metroAssetExts(baseDir, host, file) {
  const exts = new Set(METRO_ASSET_EXTS)
  const config = resolve(baseDir, file)
  if (!host.stat(config)?.isFile()) return exts
  readLists(parseModule(config, host), METRO_ASSET_LISTS, (_, node) => {
    const ext = literalSpec(node)
    if (ext) exts.add(ext)
  })
  return exts
}

// rn.config.json's options stasis reads, each [valid, what], as @preventive/rn's rn-config.js checks them.
const listOf = (valid) => (value) => Array.isArray(value) && value.every(valid)
const EXTENSIONS = [listOf((value) => typeof value === 'string' && /^[^./\\][^/\\]*$/u.test(value)), 'a list of extensions, each without its dot ("riv")']
const isScale = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0) || (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value) && Number(value) > 0)
const RN_CONFIG_LISTS = {
  metroConfig: [(value) => typeof value === 'boolean' || (typeof value === 'string' && value !== ''), 'true, false or the path of a Metro config'],
  assetExts: EXTENSIONS,
  sourceExts: EXTENSIONS,
  assetResolutions: [listOf(isScale), 'a list of scales ("0.75", or 0.75)'],
}
const PATH_GLOBS = [listOf((value) => typeof value === 'string' && isPathGlob(value)), 'a list of globs of paths from the project root, each a directory\'s files too ("src", "src/**/*.js", "node_modules")']
const isPackageGlob = (value) => typeof value === 'string' && /^(?:@[^/]+\/[^/]+|[^@/.][^/]*)$/u.test(value) && !value.includes('\\') && globRegExp(value) !== null
const PACKAGE_GLOBS = [listOf(isPackageGlob), 'a list of globs of packages\' names ("react-native", "@react-native/*")']
const RN_CONFIG_RESTRICTIONS = { allowedPaths: PATH_GLOBS, disallowedPaths: PATH_GLOBS, allowedModules: PACKAGE_GLOBS, disallowedModules: PACKAGE_GLOBS }

// Throws where it isn't a JSON object, as rn-bundle refuses to build.
function readRnConfig(baseDir, host) {
  const text = readFileSyncMaybe(baseDir, RN_CONFIG_FILE, 'utf8', host)
  if (text === null) return null
  const config = parseJson(text, `${RN_CONFIG_FILE} is not valid JSON`)
  if (!isPlainObject(config)) throw new Error(`${RN_CONFIG_FILE} is not an object of options`)
  return config
}

function rnOptions(config, options, prefix = '') {
  const taken = {}
  for (const [key, [valid, what]] of Object.entries(options)) {
    if (config[key] === undefined) continue
    if (!valid(config[key])) throw new Error(`${RN_CONFIG_FILE}: ${prefix}${key} is ${what}, not ${JSON.stringify(config[key])}`)
    taken[key] = config[key]
  }
  return taken
}

function rnRestrictions(config) {
  const restrictions = rnOptions(config, RN_CONFIG_RESTRICTIONS)
  for (const mode of ['development', 'production']) {
    if (config[mode] === undefined) continue
    if (!isPlainObject(config[mode])) throw new Error(`${RN_CONFIG_FILE}: ${mode} is an object of options, not ${JSON.stringify(config[mode])}`)
    restrictions[mode] = rnOptions(config[mode], RN_CONFIG_RESTRICTIONS, `${mode}.`)
  }
  return restrictions
}

// --metro: Metro's resolver lists as rn-bundle takes them from rn.config.json and the Metro config it loads
// (unless rn.config.json has assetExts or metroConfig false), and the `configs` they came of, to carry.
function metroLists(baseDir, host, config) {
  const rn = config === null ? {} : rnOptions(config, RN_CONFIG_LISTS)
  const metroFile = rn.assetExts !== undefined || rn.metroConfig === false ? null : typeof rn.metroConfig === 'string' ? rn.metroConfig : METRO_CONFIG_FILE
  const assetExts = metroFile === null ? new Set(addedTo(METRO_ASSET_EXTS, rn.assetExts ?? [])) : metroAssetExts(baseDir, host, metroFile)
  const sourceExts = addedTo(METRO_SOURCE_EXTS, rn.sourceExts ?? [])
  // Metro takes a file of an extension in both for an asset, and rn.config.json removes none.
  const both = rn.sourceExts?.find((ext) => assetExts.has(ext)) ?? rn.assetExts?.find((ext) => sourceExts.includes(ext))
  if (both !== undefined) throw new Error(`${RN_CONFIG_FILE}: ${both} is in both assetExts and sourceExts, which Metro takes a file of as an asset`)
  return {
    assetExts,
    sourceExts: sourceExts.filter((ext) => isResolvableExt(`.${ext}`)),
    assetResolutions: addedTo(METRO_ASSET_RESOLUTIONS, (rn.assetResolutions ?? []).map(String)),
    configs: [join(baseDir, RN_CONFIG_FILE), ...(metroFile === null ? [] : [resolve(baseDir, metroFile)])],
  }
}

function refuseRestricted(files, restrict, host) {
  const packageOf = packagesOf({ isFile: (path) => host.stat(path)?.isFile() ?? false, readFile: (path) => host.readFile(path) })
  const errors = [...new Set([...files].map((file) => host.realpath(file)).flatMap((file) => restrict(file, packageOf(file))))].toSorted()
  if (errors.length > 0) throw new Error(`stasis bundle: the --metro build takes what ${RN_CONFIG_FILE} forbids:\n${listed(errors)}`)
}

const JSX_FILE_EXTS = new Set(['.jsx', '.tsx'])
// metro-config's default `asyncRequireModulePath`, which Metro adds to a build with an `import()`.
const ASYNC_REQUIRE = 'metro-runtime/src/modules/asyncRequire.js'

// A cache across a lazy tree's rounds: what `read()` gives, kept where it read no package not unpacked yet.
function keptAcross(label, host, memo) {
  const kept = memo ? nestedMap(memo, label) : null
  return (key, read) => {
    if (kept?.has(key)) return kept.get(key)
    const before = kept === null ? 0 : host.touches()
    const value = read()
    if (kept !== null && host.touches() === before) kept.set(key, value)
    return value
  }
}

// `fn()`, its reads probes of what files packages hold, which read none of their code, where `host` (a lazy
// tree's) tells them apart.
const probing = (host, fn) => (host.probing === undefined ? fn() : host.probing(fn))

// What Babel and Metro add to a React Native build beyond what its source imports. -> absolute paths
function metroInsertedFiles(files, { assets, baseDir, babelled, dynamicImports, jsx, resolver, platformResolver, conditions: conds, host, kept }) {
  const inserted = new Set()
  // A specifier resolves alike from every file of a directory.
  const onePerDir = (list) => [...new Map(list.map((file) => [dirname(file), file])).values()]
  const resolveFrom = (from, spec, by = resolver) => kept(`${by === resolver ? '' : 'platform\0'}${dirname(from)}\0${spec}`, () => {
    const url = by(from, spec, conds)?.url
    return url === undefined ? undefined : fileURLToPath(url)
  })
  if (babelled) {
    // Every helper of each @babel/runtime a file finds: which ones Babel adds hangs on the syntax.
    const helpersDirs = new Set()
    for (const from of onePerDir(files)) {
      const probe = resolveFrom(from, '@babel/runtime/helpers/interopRequireDefault')
      if (probe !== undefined) helpersDirs.add(dirname(probe))
    }
    for (const dir of helpersDirs) {
      for (const ent of host.readdir(dir)) if (ent.isFile() && ent.name.endsWith('.js')) inserted.add(join(dir, ent.name))
    }
    const metroRuntime = packageDirFrom(baseDir, 'metro-runtime', host) ?? packageDirFrom(baseDir, 'metro-runtime', host, ['metro'])
    const moduleSystem = metroRuntime === undefined ? undefined : join(metroRuntime, 'src/polyfills/require.js')
    if (moduleSystem !== undefined && host.stat(moduleSystem)?.isFile()) inserted.add(moduleSystem)
    const polyfills = packageDirFrom(baseDir, '@react-native/js-polyfills', host) ?? packageDirFrom(baseDir, '@react-native/js-polyfills', host, ['react-native'])
    if (polyfills !== undefined && host.stat(join(polyfills, 'index.js'))?.isFile()) {
      for (const [, file] of requireResolutions(join(polyfills, 'index.js'), host)) inserted.add(file)
    }
  }
  // From the project, else through Metro, beside which a pnpm install links metro-runtime.
  if (dynamicImports) {
    const metroDir = packageDirFrom(baseDir, 'metro', host)
    const file = requireFrom(baseDir, ASYNC_REQUIRE, host) ?? (metroDir === undefined ? undefined : requireFrom(metroDir, ASYNC_REQUIRE, host))
    if (file !== undefined) inserted.add(file)
  }
  for (const from of onePerDir(jsx ? files : files.filter((file) => JSX_FILE_EXTS.has(extname(file))))) {
    const runtime = resolveFrom(from, 'react/jsx-runtime')
    if (runtime !== undefined) inserted.add(runtime)
  }
  // Metro's module of an asset requires it past Babel, so with no alias of its.
  for (const from of onePerDir(assets)) {
    const registry = resolveFrom(from, ASSET_REGISTRY, platformResolver)
    if (registry !== undefined) inserted.add(registry)
  }
  return inserted
}

// A JS/TS Bundle via the legacy-field resolver (`--mainFields`/`--metro`), scanned once per platform: an edge
// is flat where the platforms agree, else a `{ platform: target }` map. -> { bundle, lockfile: () => Lockfile }
async function buildResolvedJsBundle({ cwd = process.cwd(), env = process.env, entries, mainFields, platforms, conditions = [], metro, metroResolver, babel, babelAliases: aliasesFile, jsx = false, flow = false, typescript = false, tsconfig, scope, resources, define, packageJSON = false, host = diskHost, memo, generated }) {
  const baseDir = resolve(cwd)
  const absEntries = entries.map((e) => resolve(baseDir, e))
  const normalized = normalizeEntries(entries, cwd)

  // A resolved file arrives by its real path, an entry as spelled: below either is within the root. (Realpathed
  // only when needed, so a missing cwd is still the scan's missing entry.)
  let realRoot
  const fromRoot = memo ? nestedMap(memo, 'paths from the root') : new Map()
  const relWithin = (abs) => upsert(fromRoot, abs, () => {
    let rel = toPosix(relative(baseDir, abs))
    if (relativeEscapes(rel)) {
      realRoot ??= host.realpath(baseDir)
      rel = toPosix(relative(realRoot, abs))
    }
    return relativeEscapes(rel) ? null : rel
  })
  const pathsOf = memo ? nestedMap(memo, 'file paths') : new Map()
  const pathOf = (url) => upsert(pathsOf, url, () => fileURLToPath(url))
  const toRel = (abs) => {
    const rel = relWithin(abs)
    if (rel === null) throw new Error(`Bundle would reach a file outside the project root: ${abs}`)
    return rel
  }

  const scanConditions = cleanConditions(conditions)
  // Not under --metro-resolver, which has no tsc mapping.
  if (!metroResolver) typescript ||= importsTypescriptByOutputName(absEntries, host)
  const typescriptPaths = typescriptPathsFor(typescript, baseDir, tsconfig, host, env)
  const { resources: resourceSet, packageJSON: withManifests } = fieldBuildOptions('buildResolvedJsBundle', { cwd, scope, resources, packageJSON, host })

  const formatsByRel = new Map()
  const resourceRels = new Set()
  // parentRel -> specifier -> Map<platformKey, targetRel>; collapsed after all platforms scanned.
  const edges = new Map()
  const reached = new Set()
  let usesEmpty = false
  // A disabled import resolves to Metro's own empty module where the project has it, else the reserved one.
  const metroEmpty = metro ? metroEmptyModule(baseDir, host) : null
  const emptyTarget = metroEmpty === null ? EMPTY_MODULE_PATH : toRel(metroEmpty)

  const fileAliases = aliasesFile === undefined ? null : createAliases(readAliasesFile(baseDir, aliasesFile, host), baseDir)
  // Metro runs the build through Babel, which adds its helpers to each file.
  const babelled = babel || fileAliases !== null
  const leftOutEdges = []
  const rnConfig = metro ? readRnConfig(baseDir, host) : null
  const { assetExts, sourceExts, assetResolutions, configs: listConfigs } = metro ? metroLists(baseDir, host, rnConfig) : { assetExts: METRO_ASSET_EXTS, sourceExts: METRO_SOURCE_EXTS, assetResolutions: METRO_ASSET_RESOLUTIONS, configs: [] }
  // A --metro bundle builds as a release build does, so production's restrictions apply, not development's.
  const restrict = rnConfig === null ? null : restrictionsOf(rnRestrictions(rnConfig), host.realpath(baseDir), false)
  const metroTaken = new Set()
  // A resource that is no asset of Metro's reaches the build only as a transform's input, inlined by a Babel
  // plugin (`require('./messages.po')`): no edge to one, nor asset registry.
  const isTransformInput = (abs, info) => metro && info?.resource === true && !isAssetFile(abs, assetExts)
  // A round of a lazy tree that asked for a package already is void: it reads on, for all else it asks for,
  // but reports and refuses nothing, and stops before it reads the files in.
  const voided = () => Boolean(memo) && host.touches() > 0
  const scanWithin = (roots, options, label) => {
    const { scanner, outside, leftOut } = withinRoot(scan(roots, { ...options, memo: memo ? nestedMap(memo, label) : null }), (url) => relWithin(pathOf(url)) !== null)
    for (const url of outside) toRel(pathOf(url))
    if (!voided()) reportScanIssues({ ...analyzeScanner(scanner, { baseDir, generated }), leftOut }, { baseDir, label, root: ' at .' })
    return { scanner, leftOut }
  }
  for (const platform of platforms) {
    const keptFor = (label) => (memo ? nestedMap(memo, `${label} ${platform ?? '*'}`) : undefined)
    const field = fieldResolverFor(platform, { mainFields, metro, assetExts, sourceExts, assetResolutions, conditions: scanConditions, typescript, typescriptPaths, host, kept: keptFor('resolutions') })
    const { extras } = field
    // The project's own metro-resolver derives every condition but the extra `react-native` itself.
    const resolver = metroResolver
      ? createMetroResolver({ projectDir: baseDir, platform, sourceExts, mainFields, conditionNames: ['react-native'], assetExts, assetResolutions, host })
      : field.resolver
    // Without --typescript, the file a miss would land on under it: a hint in the unresolved report, never an edge.
    const typescriptResolve = typescript || metroResolver ? null : fieldResolverFor(platform, { mainFields, metro, assetExts, sourceExts, assetResolutions, conditions: scanConditions, typescript: true, typescriptPaths, host, kept: keptFor('typescript resolutions') }).resolver
    // --babel: a specifier babel-plugin-module-resolver rewrites resolves as rewritten, as Metro resolves it
    // after Babel; its edge stays keyed by the specifier the source holds.
    const aliases = babel ? createBabelAliases({ projectDir: baseDir, platform }) : fileAliases
    const keepsTypeImports = babel ? createBabelTypeImportsKept({ projectDir: baseDir, platform }) : null
    const aliased = (resolveFn) => {
      if (!aliases || !resolveFn) return resolveFn
      const spelled = (file, spec) => aliases(file, spec) ?? spec
      return Object.assign((file, spec, conds) => resolveFn(file, spelled(file, spec), conds), resolveFn.missTargets && { missTargets: (file, spec, conds) => resolveFn.missTargets(file, spelled(file, spec), conds) })
    }
    // --metro: built through Babel, which erases an import listing types alone (Scan's `babel`).
    const scanOptions = { conditions: extras, resolve: aliased(resolver), typescriptResolve: aliased(typescriptResolve), jsx, flow, resources: resourceSet, define, babel: metro, keepsTypeImports, host, missTargets: generated !== undefined }
    // '*' is a private placeholder for the single mainFields pass; it never unflattens.
    const platformKey = platform ?? '*'
    const absorb = (roots) => {
      const { scanner, leftOut } = scanWithin(roots, scanOptions, platform ?? 'mainFields')
      leftOutEdges.push(...leftOut)
      for (const [url, info] of scanner.files) {
        const abs = pathOf(url)
        const rel = toRel(abs)
        reached.add(abs)
        if (restrict !== null && !isTransformInput(abs, info)) metroTaken.add(abs)
        if (info.resource) resourceRels.add(rel)
        // Under --metro a code file has only the format its name gives it, as the Metro plugin records it.
        formatsByRel.set(rel, metro && !info.resource ? nodeExtFormat(abs) : info.format)
        for (const e of info.edges) {
          if (e.builtin || e.dynamic) continue
          let target
          if (e.empty) { usesEmpty = true; target = emptyTarget }
          else if (e.child) target = toRel(pathOf(e.child))
          else continue // unresolved: reportScanIssues warned or threw
          // A transform's input is no dependency of Metro's: the import is gone before Metro sees it.
          if (e.child && isTransformInput(pathOf(e.child), scanner.files.get(e.child))) continue
          nestedMap(nestedMap(edges, rel), e.spec).set(platformKey, target)
        }
      }
      return scanner
    }
    const scanner = staged('scan', () => absorb(absEntries))
    // --metro: and what Babel and Metro add, scanned in turn; one above the root passed over, as the Metro plugin does.
    if (metro) {
      const metroAt = performance.now()
      const code = [...scanner.files].filter(([, info]) => !info.resource).map(([url]) => pathOf(url))
      const assets = [...scanner.files].filter(([url, info]) => info.resource && !isTransformInput(pathOf(url), info)).map(([url]) => pathOf(url))
      // As a require(): Babel's CommonJS transform makes one of each it adds, as Metro writes its own.
      const required = new Set(['require', 'default', ...extras])
      // Each asset's other scales (`logo@2x.png`), which Metro reads to build its module: no import names one.
      const scales = assets.flatMap((file) => metroAssetFiles(file, platform, host)).filter((file) => relWithin(host.realpath(file)) !== null)
      const dynamicImports = [...scanner.files.values()].some((info) => !info.resource && info.edges.some((e) => e.kind === 'dynamic-import'))
      const kept = keptAcross(`Metro's additions ${platformKey}`, host, memo)
      const added = [...new Set([...metroInsertedFiles(code, { assets, baseDir, babelled, dynamicImports, jsx, resolver: aliased(resolver), platformResolver: resolver, conditions: required, host, kept }), ...scales])]
        .filter((file) => !scanner.files.has(pathToFileURL(file).toString()) && relWithin(file) !== null)
      stageTimes.metro += performance.now() - metroAt
      if (added.length > 0) staged('scan', () => absorb(added))
    }
  }

  // Collapsed to one target, an edge one platform resolves within the root and another leaves out would serve the
  // one the other's file.
  const [split] = voided() ? [] : leftOutEdges.filter((e) => edges.get(toRel(pathOf(e.parentURL)))?.has(e.spec))
  if (split !== undefined) {
    throw new Error(
      `${split.spec} from ${displayPath(split.parentURL, baseDir)} resolves within the project root in one context and outside it, ` +
      `at ${relative(baseDir, fileURLToPath(split.outsideURL))}, in another: a bundle can't leave out the one without serving the other in its place`
    )
  }
  if (restrict !== null && !voided()) refuseRestricted(usesEmpty && metroEmpty !== null ? [...metroTaken, metroEmpty] : metroTaken, restrict, host)

  // --metro: and the configs and toolchain a React Native build loads in Node, traced as Node entries: their
  // edges keyed by Node's conditions, as the Metro plugin's run records them, apart from the app's '*' ones.
  const keyedResolutions = new Map()
  const keyedFrom = (key, parent) => nestedMap(nestedMap(keyedResolutions, key), parent)
  // `${parentRel}\0${specifier}` -> the configs' miss.
  const configMissed = new Map()
  // What the configs reach, and of it what the app's build doesn't: attributed to `bundle`, not `bundle:metro`.
  const configReached = new Set()
  const configOnly = new Set()
  const configsAt = performance.now()
  if (metro) {
    const rootConfigs = [...METRO_CONFIG_FILES, ...(babelled ? [BABEL_CONFIG_FILE] : [])].map((rel) => join(baseDir, rel))
    const configs = [...new Set([...rootConfigs, ...listConfigs.filter((abs) => relWithin(abs) !== null)])].filter((abs) => host.stat(abs)?.isFile())
    const toolchainFile = ({ name, file, via }) => {
      for (let i = 0; i <= via.length; i++) {
        const chain = via.slice(i)
        if (file !== undefined) {
          const dir = packageDirFrom(baseDir, name, host, chain)
          if (dir !== undefined && host.stat(join(dir, file))?.isFile()) return join(dir, file)
          continue
        }
        const from = chain.length === 0 ? baseDir : packageDirFrom(baseDir, chain.at(-1), host, chain.slice(0, -1))
        const found = from === undefined ? undefined : requireFrom(from, name, host)
        if (found !== undefined) return found
      }
      return undefined
    }
    for (const entry of [...METRO_TOOLCHAIN, ...(babelled ? BABEL_TOOLCHAIN : [])]) {
      const file = toolchainFile(entry)
      if (file !== undefined && relWithin(file) !== null) configs.push(file)
    }
    // And the React Native configs of the app's packages, which its CLI requires, by their real path.
    for (const dir of probing(host, () => linkedPackages(baseDir, host))) {
      const file = join(dir, 'react-native.config.js')
      if (!probing(host, () => host.stat(file)?.isFile())) continue
      const real = host.realpath(file)
      if (relWithin(real) !== null) configs.push(real)
    }
    const traceNode = (roots) => {
      const { scanner, leftOut } = scanWithin(roots, { resources: resourceSet, host }, 'configs and toolchain')
      for (const [url, info] of scanner.files) {
        const abs = pathOf(url)
        const rel = toRel(abs)
        configReached.add(rel)
        if (!reached.has(abs)) configOnly.add(rel)
        reached.add(abs)
        if (info.resource) resourceRels.add(rel)
        formatsByRel.set(rel, info.format)
      }
      for (const u of [...scanner.unresolved, ...leftOut]) if (u.spec !== undefined) configMissed.set(`${toRel(pathOf(u.parentURL))}\0${u.spec}`, u)
      for (const [key, byParent] of scanner.imports) {
        for (const [parentURL, specs] of byParent) {
          const keyed = keyedFrom(key, toRel(pathOf(parentURL)))
          for (const [spec, childURL] of specs) keyed.set(spec, toRel(pathOf(childURL)))
        }
      }
      return scanner
    }
    const traced = configs.length > 0 ? traceNode(configs) : null
    // And the transformers beside stasis's Metro plugin, where a config requires it.
    const transformers = [...(traced?.files.keys() ?? [])].map((url) => pathOf(url))
      .filter((file) => basename(file) === 'metro.js' && basename(dirname(file)) === 'src' &&
        readJson(join(dirname(dirname(file)), 'package.json'), host)?.name === '@exodus/stasis-plugins')
      .flatMap((file) => STASIS_METRO_TRANSFORMERS.map((name) => join(dirname(file), name)))
      .filter((file) => host.stat(file)?.isFile() && relWithin(file) !== null && !traced.files.has(pathToFileURL(file).toString()))
    if (transformers.length > 0) traceNode(transformers)
    // And the plugins and presets the Babel config's modules name, and what any module reached names by
    // `require.resolve('x')`, which Babel loads: each traced in turn.
    const babelConfig = pathToFileURL(join(baseDir, BABEL_CONFIG_FILE)).toString()
    const resolutionsOf = keptAcross('require.resolve', host, memo)
    const namedOf = keptAcross('babel names', host, memo)
    if (traced?.files.has(babelConfig)) {
      const files = new Map(traced.files)
      const visited = new Set()
      const resolveNamed = (name, from) => {
        const pathLike = name.startsWith('.') || isAbsolute(name) || name.startsWith('node_modules/')
        for (const dir of [baseDir, dirname(from)]) {
          const file = requireFrom(dir, pathLike ? resolve(dir, name) : name, host)
          if (file !== undefined) return file
        }
        return undefined
      }
      for (let frontier = [babelConfig]; frontier.length > 0;) {
        const named = new Set()
        for (let i = 0; i < frontier.length; i++) {
          const url = frontier[i]
          const info = files.get(url)
          if (visited.has(url) || info === undefined) continue
          visited.add(url)
          for (const e of info.edges) if (e.child) frontier.push(e.child)
          const file = pathOf(url)
          const rel = toRel(file)
          if (info.resource || !JS_EXTENSIONS.has(extname(file))) continue
          for (const [spec, target] of resolutionsOf(file, () => requireResolutions(file, host))) {
            if (!JS_EXTENSIONS.has(extname(target)) || relWithin(target) === null) continue
            named.add(target)
            // A specifier keeps the first edge recorded, as a run records a resolution only where no edge is.
            const keyed = keyedFrom(REQUIRE_KEY, rel)
            if (!keyed.has(spec)) keyed.set(spec, toRel(target))
          }
          const configModule = isBabelConfigModule(rel)
          if (!configModule && splitNodeModulesPath(rel)) continue
          for (const name of namedOf(`${configModule}\0${file}`, () => babelNamedModules(file, host, { anyString: configModule }))) {
            const found = resolveNamed(name, file)
            if (found !== undefined && JS_EXTENSIONS.has(extname(found)) && relWithin(found) !== null) named.add(found)
          }
        }
        const fresh = [...named].filter((file) => !files.has(pathToFileURL(file).toString()))
        if (fresh.length > 0) for (const [url, info] of traceNode(fresh).files) files.set(url, info)
        frontier = [...named].map((file) => pathToFileURL(file).toString())
      }
    }
    // And the toolchain files the Metro plugin carries for every build, tagged as it does them.
    for (const specifier of AUTO_INCLUDES) {
      const file = requireFrom(baseDir, specifier, host)
      if (file === undefined || reached.has(file) || relWithin(file) === null) continue
      const rel = toRel(file)
      const format = classifyFormat(file, { content: host.readFile(file) })
      reached.add(file)
      configReached.add(rel)
      configOnly.add(rel)
      if (format === undefined) resourceRels.add(rel)
      else formatsByRel.set(rel, format ?? undefined)
    }
  }

  stageTimes.configs += performance.now() - configsAt
  if (voided()) throw new Error('buildResolvedJsBundle: this round reads a package not unpacked yet')
  const carryingAt = performance.now()

  // Each reached file carried as the bytes read, encoded without loss, for the lockfile to hash once wanted.
  const sources = new Map()
  const put = (rel, content, format) => {
    sources.set(rel, content)
    formatsByRel.set(rel, format)
  }
  const putResource = (rel, buf) => (isUtf8(buf) ? put(rel, buf.toString('utf8'), 'resource') : put(rel, buf.toString('base64'), 'resource:base64'))
  // Code carries its source, UTF-8, which non-UTF-8 bytes would not survive: refused.
  const putCode = (rel, buf, format, what = 'JS bundle source') => {
    if (!isUtf8(buf)) throw new Error(`${what} is not valid UTF-8: ${rel}`)
    put(rel, buf.toString('utf8'), format)
  }
  const realBase = host.realpath(baseDir)
  // Metro's empty module is carried as the file it is, a code file of Metro's (no format).
  if (usesEmpty && metroEmpty !== null) reached.add(metroEmpty)
  for (const abs of reached) {
    const rel = toRel(abs)
    // Security: an entry is taken as spelled (and --metro-resolver keeps a path it can't realpath), so a
    // symlink escaping the root would slip past toRel's textual check: realpath and fail closed.
    assertRealPathWithinBase(realBase, baseDir, rel, host)
    const buf = host.readFile(abs)
    if (resourceRels.has(rel)) putResource(rel, buf)
    else putCode(rel, buf, formatsByRel.get(rel))
  }
  if (usesEmpty && metroEmpty === null) {
    if (formatsByRel.has(EMPTY_MODULE_PATH)) {
      throw new Error(`Bundle needs the reserved empty-module path ${EMPTY_MODULE_PATH}, but the project has a real file there`)
    }
    put(EMPTY_MODULE_PATH, '', metro ? undefined : 'commonjs')
  }

  const packageOf = packageLookup(baseDir, { host })

  // --metro also carries the native build inputs of each native package the app links, as the Metro plugin
  // does: those installed or linked into node_modules, and those React Native links unimported.
  if (metro) {
    const pkgDirs = new Map()
    // A package reached only for an asset, or only by the configs Node runs at build time, is no linked native one.
    const isCode = (rel) => !resourceRels.has(rel)
    for (const abs of reached) {
      const rel = toRel(abs)
      const nm = isCode(rel) && !configOnly.has(rel) && splitNodeModulesPath(rel)
      if (nm) pkgDirs.set(nm.dir, nm.name)
    }
    // A workspace package linked into node_modules is reached by its real path, but is a dependency all the same
    // where it is linked, under any name, into a node_modules its importer finds packages in.
    const linkedFrom = memoized((dir) => {
      const parent = dirname(dir)
      const links = new Set(parent === dir ? [] : linkedFrom(parent))
      const link = (abs) => {
        try {
          const rel = toRel(host.realpath(abs))
          if (!splitNodeModulesPath(rel)) links.add(rel)
        } catch { /* a dangling link, or one out of the root, whose files the scan pass refused already */ }
      }
      // As locatePackage: a directory named node_modules holds no node_modules of its own to look in.
      if (basename(dir) !== 'node_modules') {
        const nodeModules = join(dir, 'node_modules')
        for (const ent of listing(nodeModules, host)) {
          const abs = join(nodeModules, ent.name)
          if (ent.name.startsWith('@')) {
            // A whole scope may be linked, every package in it reached through the link.
            for (const scoped of listing(abs, host)) {
              if (ent.isSymbolicLink() || scoped.isSymbolicLink()) link(join(abs, scoped.name))
            }
          } else if (ent.isSymbolicLink()) {
            link(abs)
          }
        }
      }
      return links
    })
    for (const [parent, bySpec] of edges) {
      for (const byPlatform of bySpec.values()) {
        for (const target of byPlatform.values()) {
          if (!isCode(target) || splitNodeModulesPath(target)) continue
          const links = linkedFrom(dirname(join(baseDir, parent)))
          // The linked root holding the target, nearest first: its entry may lie below a manifest of its own
          // (a named dist/package.json).
          let root = posix.dirname(target)
          while (root !== '.' && !links.has(root)) root = posix.dirname(root)
          if (root === '.' || parent.startsWith(`${root}/`) || pkgDirs.has(root)) continue
          // Named by its own manifest, whatever name it's linked under.
          pkgDirs.set(root, readPackageJson(baseDir, `${root}/package.json`, { host })?.name)
        }
      }
    }
    // And those React Native links whether JS imports them or not, but one above the root, as the plugin does.
    for (const dir of probing(host, () => linkedNativePackages(baseDir, host))) {
      const rel = relWithin(host.realpath(dir))
      if (rel !== null && !pkgDirs.has(rel)) pkgDirs.set(rel, readPackageJson(baseDir, `${rel}/package.json`, { host })?.name)
    }
    // A file read only once its real path is held to the root.
    const nativeFs = {
      readdir: (abs) => host.readdir(abs),
      stat: (abs) => host.stat(abs),
      readFile(abs) {
        assertRealPathWithinBase(realBase, baseDir, toRel(abs), host)
        return host.readFile(abs)
      },
    }
    for (const [pkgDir, name] of [...pkgDirs].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const pkgAbs = join(baseDir, pkgDir)
      // react-native core isn't a Pod (config reports it via reactNativePath), but its native source is walked too.
      const isRnCore = name === 'react-native'
      if (!isRnCore && !probing(host, () => looksNative(pkgAbs, nativeFs))) continue
      for (const { file, source, action, format } of nativeInputs(pkgAbs, nativeFs, { resources: resourceSet, skip: (abs) => sources.has(toRel(abs)) })) {
        if (action === 'code') putCode(toRel(file), source, format, 'native source')
        else putResource(toRel(file), source)
      }
      // RN core's `.js` build scripts, never in the graph, which the podspec runs at pod-install.
      if (isRnCore) {
        for (const file of RN_CORE_INCLUDE_FILES) {
          const abs = join(pkgAbs, file)
          if (host.stat(abs) === null || sources.has(toRel(abs))) continue
          putCode(toRel(abs), nativeFs.readFile(abs), packageType(abs, host) === 'module' ? 'module' : 'commonjs', 'native source')
        }
      }
    }
  }

  // --package-json: each bundled module's package.json, and the nearer one a reached file of it has (a
  // `{"type":"module"}` marker), which Metro's resolver reads for the file, as the State path does.
  if (withManifests) {
    const exists = memoized((rel) => packageJSONStat(host, join(baseDir, rel))?.isFile() ?? false)
    const manifests = new Map()
    for (const abs of reached) {
      const rel = toRel(abs)
      const pkgDir = packageOf(rel)?.pkgDir ?? (splitNodeModulesPath(rel) ? undefined : '.')
      if (pkgDir === undefined) continue
      for (const manifest of [moduleFileKey(pkgDir, 'package.json'), scopeManifestOf(rel, pkgDir, exists)]) {
        if (manifest !== undefined) upsert(manifests, manifest, () => []).push(rel)
      }
    }
    for (const [rel, of] of manifests) {
      if (sources.has(rel)) continue
      const buf = readModuleManifest({ baseDir, realBase, rel, host })
      if (!buf) continue
      put(rel, buf.toString('utf8'), 'json')
      // Attributed as the files it serves are, as State#includePackageJson attributes one.
      if (of.some((file) => configReached.has(file))) configReached.add(rel)
      if (of.every((file) => configOnly.has(file))) configOnly.add(rel)
    }
  }

  // One target across the platforms is flat; else a Map<platform, target>, sorted.
  const collapsed = (byPlatform) => {
    const distinct = new Set(byPlatform.values())
    return distinct.size === 1 ? [...distinct][0] : new Map([...byPlatform].toSorted((a, b) => (a[0] < b[0] ? -1 : 1)))
  }
  const resolutions = new Map([...edges].map(([parent, bySpec]) => [parent, new Map([...bySpec].map(([spec, to]) => [spec, collapsed(to)]))]))
  // Where Node misses a config's import Metro resolves for the app, the app's edge under '*' would serve Node
  // Metro's file.
  for (const [key, { parentURL, spec }] of configMissed) {
    if (!resolutions.get(key.slice(0, key.indexOf('\0')))?.has(spec)) continue
    throw new Error(
      `${spec} from ${displayPath(parentURL, baseDir)} resolves under Metro, for the app, and not under Node, for the ` +
      "project's configs: a bundle can't keep Node's miss without serving Node Metro's file in its place"
    )
  }

  const rootPkg = readJson(join(baseDir, 'package.json'), host) ?? {}
  const assembled = assembleCodeBundle({
    baseDir, entries: normalized, sources, resolutions, keyedResolutions, formats: formatsByRel, workspaceName: rootPkg.name ?? 'workspace',
    workspaceVersion: rootPkg.version ?? '0.0.0', conditionKey: '*', host, packageOf, consumer: metro ? 'bundle:metro' : 'bundle',
    consumerFiles: [...sources.keys()].filter((rel) => !configOnly.has(rel)),
  })
  // What the configs reach is the bundler's, not the app's: `bundle`, as a Node build's files are.
  const bundle = configReached.size === 0 ? assembled : assembled.withReason('bundle', [...configReached])
  stageTimes.carrying += performance.now() - carryingAt
  return { bundle, lockfile: deferredLockfile(bundle) }
}

// The one language of `entries`, the options checked against it; `name` prefixes errors. `partial`: a
// stasis.config.json entry may yet complete the options, so what one needs of another is left to the build.
function classifyEntries(name, { cwd = process.cwd(), entries, mappingFile, manifests, scope, lockfile, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests, host = diskHost, fetched, partial = false }) {
  if (!nonEmpty(entries)) throw new Error(`${name}: at least one entry file is required`)
  const dirError = directoryEntryError(entries, cwd, host, { fetched })
  if (dirError !== null) throw new Error(`${name}: ${dirError}`)
  const kinds = {
    sol: (e) => isSolidityEntry(e, cwd, host), php: (e) => e.endsWith('.php'), js: (e) => JS_EXTENSIONS.has(extname(e)),
    bash: (e) => BASH_EXTS.has(extname(e)), rust: (e) => RUST_EXTS.has(extname(e)), teal: (e) => e.endsWith('.teal'),
  }
  const kind = Object.keys(kinds).find((key) => entries.every((e) => kinds[key](e)))
  if (kind === undefined) {
    throw new Error(`${name}: entries must all be .sol, all be .php, all be .js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx, all be .sh/.bash, all be .rs, or all be .teal (no mixing)`)
  }
  // Refuse each of the options `given` that is on, for the `only` (`what`) bundles alone, in order.
  const onlyFor = (only, what, given) => {
    if (kind === only) return
    for (const [flag, on] of Object.entries(given)) if (on) throw new Error(`${name}: --${flag} is only valid for ${what} bundles`)
  }
  onlyFor('sol', '.sol', { mapping: mappingFile, manifests })
  onlyFor('rust', 'Rust', { cargo, 'cargo-features': nonEmpty(cargoFeatures), 'cargo-no-default-features': cargoNoDefaultFeatures, 'cargo-all-features': cargoAllFeatures, 'cargo-target': cargoTarget, 'cargo-manifests': cargoManifests })
  onlyFor('js', 'JS', { scope: scope !== undefined, lockfile: lockfile !== undefined, conditions: nonEmpty(conditions), flow, typescript })
  if (tsconfig !== undefined && !typescript && !partial) throw new Error(`${name}: --tsconfig is only valid with --typescript`)
  // Checked here too, so a typo surfaces with the command name rather than deep in the scan.
  if (nonEmpty(resources)) {
    if (kind !== 'js') throw new Error(`${name}: --resources is only valid for JS bundles`)
    parseResourcesOption(name, resources)
  }
  // `define` is parsed (checked) whatever the kind.
  onlyFor('js', 'JS', { mainFields: mainFields !== undefined, jsx, define: parseDefine(name, define).size > 0, 'package-json': packageJSON, metro: metro || nonEmpty(platforms) })
  if (metro) {
    if (nonEmpty(conditions)) throw new Error(`${name}: --conditions can't be combined with --metro (it sets its own conditions)`)
    if (mainFields !== undefined) throw new Error(`${name}: --mainFields can't be combined with --metro (it sets its own mainFields)`)
    if (!nonEmpty(platforms) && !partial) throw new Error(`${name}: --metro requires --platforms (e.g. --platforms=ios,android)`)
    // A platform name becomes an edge key, which Bundle/Lockfile parse refuse with a '/', and '*' is reserved.
    for (const p of Array.isArray(platforms) ? platforms : []) {
      if (typeof p !== 'string' || p.length === 0 || p === '*' || p.includes('/')) {
        throw new Error(`${name}: invalid platform '${p}' (a platform name can't be empty, contain '/', or be '*')`)
      }
    }
  } else if (nonEmpty(platforms) && !partial) {
    throw new Error(`${name}: --platforms is only valid with --metro`)
  }
  if (metroResolver && !metro) throw new Error(`${name}: --metro-resolver is only valid with --metro`)
  if (babel && !metro) throw new Error(`${name}: --babel is only valid with --metro`)
  if (babelAliases !== undefined) {
    if (typeof babelAliases !== 'string' || babelAliases === '') throw new TypeError(`${name}: babelAliases must be a path to a JSON file`)
    if (!metro && !partial) throw new Error(`${name}: --babel-aliases is only valid with --metro`)
    if (babel) throw new Error(`${name}: --babel-aliases can't be combined with --babel (both set the import aliases)`)
  }
  if (typescript && metroResolver) {
    throw new Error(`${name}: --typescript is not supported with --metro-resolver (the project's metro-resolver doesn't substitute .js -> .ts)`)
  }
  // Refused before anything is built (or fetched).
  if (mainFields !== undefined || metro) fieldBuildOptions(name, { cwd, scope, resources, host })
  return kind
}

// By the legacy-field resolver with `mainFields` or `metro`, whose per-platform edges a State can't hold.
async function buildJs({ mainFields, platforms, metro, metroResolver, babel, babelAliases, innermostRoot, extra, outputsAt, ...options }) {
  if (metro) options = { ...options, jsx: true, flow: true, define: { ...METRO_RELEASE_DEFINE, ...options.define } }
  if (metro || mainFields !== undefined) {
    const built = await buildResolvedJsBundle({ ...options, mainFields: metro ? METRO_MAIN_FIELDS : mainFields, platforms: metro ? platforms : [null], metro: Boolean(metro), metroResolver: Boolean(metroResolver), babel: Boolean(babel), babelAliases })
    return { bundle: built.bundle, lockfile: built.lockfile, stateBuilt: false, root: resolve(options.cwd) }
  }
  const state = await buildJsBundle({ ...options, innermostRoot, extra, outputsAt })
  const bundle = state.sourceBundle
  // The `bundle` consumer, unless `extra` added files: then the State attributes each, to `bundle` or `extra`.
  return { bundle: bundle.reason === undefined ? bundle.withReason('bundle') : bundle, lockfile: () => state.lockfile, stateBuilt: true, root: state.root }
}

// `bundle`'s lockfile, built on the first call, so a file is hashed only once it is wanted. Its records are
// taken now: one the bundle replaces after (a commit pinned onto a module) is not the lockfile's.
function deferredLockfile(bundle) {
  const { config, entries, imports, formats, executable } = bundle
  const now = { config, entries, modules: new Map(bundle.modules), imports, formats, executable }
  let lockfile
  return () => (lockfile ??= Lockfile.fromBundle(now, (file, content) => bundledIntegrity(content, formats.get(file))))
}

// `built` (without a State) with the files stasis.config.json's `extra` names but `outputs`, packed as `stasis add`
// packs them; resources by the build's `resources` where given, else by the config's.
function withExtra(built, cwd, { outputs = [], resources, host = diskHost, name = 'bundle' }) {
  const config = readConfigFile(name, cwd, host)
  const patterns = parseExtraOption(CONFIG_FILE, config?.extra)
  if (patterns.length === 0) return built
  // The union of `builds` may be State-built in node_modules scope, which the full-scope files can't join.
  if (built.bundle.config.scope !== 'full') throw new Error(`${name}: ${CONFIG_FILE}'s extra can't be added to a ${built.bundle.config.scope}-scope bundle of its entries`)
  const baseDir = resolve(cwd)
  const written = new Set(outputs.map((file) => toPosix(relative(baseDir, file))))
  const allowlist = resources === undefined ? parseResourcesOption(CONFIG_FILE, config.resources) : parseResourcesOption('--resources', resources)
  const named = expandExtra(baseDir, patterns, written, host).files
  // Bundle#sources builds its Map afresh on each read.
  const bundled = built.bundle.sources
  // A file `extra` names that the build carries itself is attributed to both.
  const carried = [...named.keys()].filter((rel) => bundled.has(rel))
  const files = new Map([...named].filter(([rel]) => !bundled.has(rel)))
  if (files.size === 0 && carried.length === 0) return built
  let { bundle } = built
  let extraLock
  if (files.size > 0) {
    const { codeFiles, resourceFiles } = validateFiles({ baseDir, realBase: host.realpath(baseDir), files, resources: allowlist, label: 'extra', host })
    const rootPkg = readJson(join(baseDir, 'package.json'), host) ?? {}
    const extra = assembleBundle(baseDir, new Map([...codeFiles, ...resourceFiles]), rootPkg.name ?? 'workspace', rootPkg.version ?? '0.0.0', undefined, { reason: 'extra', buckets: bundle.modules, host })
    extraLock = deferredLockfile(extra)
    // The files are the build's own, so its `repo`, which a merge with a side lacking one would drop.
    extra.repo = bundle.repo
    bundle = bundle.merge(extra)
  }
  if (carried.length > 0) bundle = bundle.withReason('extra', carried)
  const { lockfile } = built
  return { ...built, bundle, ...(lockfile && extraLock && { lockfile: () => lockfile().merge(extraLock()) }) }
}

// From disk, with stasis.config.json's `extra` unless `extra` is false (one of several builds), not yet pinned.
async function buildOfKind(kind, { cwd, env, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests, outputsAt = () => [], extra = true }) {
  const outputs = outputsAt(resolve(cwd))
  const withExtraOf = (built, buildResources) => (extra ? withExtra(built, cwd, { outputs, resources: buildResources }) : built)
  if (kind === 'sol') return withExtraOf({ bundle: await buildSolidityBundle({ cwd, env, entries, mappingFile, manifests }) })
  if (kind === 'php') return withExtraOf({ bundle: await buildPhpBundle({ cwd, entries }) })
  if (kind === 'bash') return withExtraOf({ bundle: await buildBashBundle({ cwd, entries }) })
  if (kind === 'teal') return withExtraOf({ bundle: await buildTealBundle({ cwd, entries }) })
  if (kind === 'rust') return withExtraOf({ bundle: await buildRustBundle({ cwd, entries, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }) })
  const built = await buildJs({ cwd, env, entries, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, extra, outputsAt })
  return built.stateBuilt ? built : withExtraOf(built, resources)
}

// How each Soldeer, Composer and vendored Cargo dependency is installed, where what its integrity is read of tells.
function archiveAccounts(modules, root) {
  let soldeer, composer
  const told = {
    soldeer: (dir) => (soldeer ??= soldeerLocks(root, solidityOwnership(root), diskHost)).get(dir.slice('dependencies/'.length)),
    composer: (dir) => (composer ??= loadComposerPackages(root)).find((pkg) => pkg.dir === dir),
    cargo: (dir, sums = readJson(join(root, dir, '.cargo-checksum.json'))) => sums && { integrity: archiveIntegrity('cargo', sums.package) },
  }
  return new Map([...modules].map(([dir, { ecosystem }]) => [dir, Object.hasOwn(told, ecosystem) ? told[ecosystem](dir) : undefined]).filter(([, account]) => account))
}

// `built` with its npm dependencies as their install records name them, whatever its kind (a Solidity import
// out of node_modules is one): their `accounts`, `accountsOf(modules)` any other's, its lockfile attesting so.
function pinnedOf(built, root) {
  const accounts = pinInstalled(built.bundle, root)
  return { ...built, accounts, accountsOf: (modules) => new Map([...archiveAccounts(modules, root), ...installedRecords(modules, root)]), ...(built.lockfile && { lockfile: () => withAttested(built.lockfile(), built.bundle) }) }
}

// The strict union of `builts`, of `builds` rooted at `roots`, which must agree; a lockfile where each has one.
function unionOfBuilds(name, builds, builts, roots) {
  const other = roots.findIndex((root) => root !== roots[0])
  if (other !== -1) {
    throw new Error(`${name}: ${builds[0].entries[0]} and ${builds[other].entries[0]} can't be bundled together: their bundles' paths are relative to different roots (${roots[0]} and ${roots[other]})`)
  }
  return builts.reduce((a, b) => ({ bundle: a.bundle.merge(b.bundle), lockfile: a.lockfile && b.lockfile && (() => a.lockfile().merge(b.lockfile())) }))
}

// `bundle` with each of its paths put under `dir`, as a build from its root's parent would hold them.
function bundleUnder(bundle, dir) {
  const at = (path) => posix.join(dir, path)
  const target = (to) => (typeof to === 'string' ? at(to) : new Map([...to].map(([platform, file]) => [platform, at(file)])))
  const { version, config, entries, modules, formats, imports, executable, reason, repo, package: pkg } = bundle
  return new Bundle({
    version, config, repo, package: pkg,
    entries: new Set([...entries].map(at)),
    modules: new Map([...modules].map(([bucket, info]) => [at(bucket), info])),
    formats: new Map([...formats].map(([file, format]) => [at(file), format])),
    imports: new Map([...imports].map(([conditions, byParent]) => [conditions, new Map([...byParent].map(([parent, specifiers]) => [at(parent), new Map([...specifiers].map(([specifier, to]) => [specifier, target(to)]))]))])),
    executable: new Set([...executable].map(at)),
    reason: reason && Object.fromEntries(Object.entries(reason).map(([consumer, files]) => [consumer, files.map(at)])),
  })
}

// `build` (its paths from `cwd`) built from `from`, a directory under cwd, as from there, its paths put under `from`.
async function solidityFrom(build, from, { cwd, ...args }) {
  if (from === cwd) return buildSolidityBundle({ ...build, ...args, cwd })
  const fromThere = (path) => posix.relative(from, posix.resolve(cwd, path)) || '.'
  const { entries, mappingFile } = build
  const bundle = await buildSolidityBundle({ ...build, ...args, cwd: from, entries: entries.map(fromThere), mappingFile: mappingFile && fromThere(mappingFile) })
  return bundleUnder(bundle, posix.relative(cwd, from))
}

// Before anything is fetched (`host` an empty tree's, with `fetched: false`). -> the kind of bundle
export function checkVfsOptions(name, options) {
  const kind = classifyEntries(name, options)
  if (options.metroResolver) throw new Error(`${name}: metroResolver is not supported`)
  // The project's Babel config is code, run from the disk.
  if (options.babel) throw new Error(`${name}: babel is not supported`)
  const { generate } = options
  if (generate !== undefined && (!Array.isArray(generate) || generate.some((step) => step !== 'prisma'))) throw new TypeError(`${name}: generate must be an array of 'prisma'`)
  if (generate?.length > 0 && kind !== 'js') throw new Error(`${name}: --generate is only valid for JS bundles`)
  return kind
}

// Nothing read from disk but tarballs and zips, nor from the environment (doc/github-bundle.md).
export async function buildVfsBundle({ lock, ...options } = {}) {
  const { checkVfs, vfsHost } = await import('../vfs-bundle/tree.js')
  checkVfs('buildVfsBundle', options.vfs)
  if (lock !== undefined) assertOption('lock', lock)
  const host = vfsHost(options.vfs)
  const built = await buildFromLockfile('buildVfsBundle', host, options)
  const mode = lockModeOf(built.root, { EXODUS_STASIS_LOCK: lock }, host).lock
  const at = posix.join(built.root, LOCK_FILE)
  const label = posix.relative('/', at)
  if (heldToLockfile(() => built.lockfile, at, label, mode, { host, bundle: built.bundle, accounts: built.accounts }) !== undefined && mode === 'frozen') {
    loadsBeside(built.bundle.serialize(), { at: posix.join(built.root, BUNDLE_FILE), lockAbs: at, label, root: built.root, scope: built.bundle.config.scope, host })
  }
  return built
}

// One tree of each lockfile stasis.config.json's `lockfiles` names, else of `packageManager`, or the one detected.
async function treeSpecs(name, project, cwd, { packageManager, packageManagerVersion, os, why }) {
  const { checkVersion, lockfileSpecs, packageManagerFor } = await import('../vfs-bundle/tree.js')
  const lockfiles = configuredLockfiles(name, cwd, project)
  if (lockfiles === undefined) return [{ packageManager: packageManagerFor(name, project, cwd, { packageManager, packageManagerVersion, os, why }), cwd, packageManagerVersion }]
  if (packageManager !== undefined) throw new Error(`${name}: packageManager is given, and ${CONFIG_FILE}'s lockfiles names the lockfiles to lay out`)
  checkVersion(name, { packageManager, packageManagerVersion })
  return lockfileSpecs(name, project, cwd, lockfiles, os)
}

async function layLazily(name, project, cwd, specs, lazy) {
  const { lazyTaken } = await import('../vfs-bundle/tree.js')
  const lazyDependencies = configFlag('lazyDependencies', name, cwd, project)
  if (lazy && !lazyDependencies) throw new Error(`${name}: lazy is given, and ${CONFIG_FILE}'s lazyDependencies is false`)
  for (const spec of specs) spec.lazy = lazy ?? (lazyDependencies && lazyTaken(project, spec.packageManager, spec.cwd))
}

// For a lazy tree, in rounds of their own.
async function prismaOutputs(tree, project, options) {
  const [{ generatePrismaClients }, { treeHost }, { inRounds }] = await Promise.all([import('../vfs-bundle/prisma.js'), import('../vfs-bundle/tree.js'), import('../vfs-bundle/lazy.js')])
  const generating = (reads) => generatePrismaClients({ ...options, host: treeHost(tree, project, reads), root: tree.root })
  return tree.unpack === undefined ? generating() : inRounds(generating, tree.unpack)
}

// As buildVfsBundle generates them under `generate: ['prisma']`, but with devDependencies whatever the config says.
export async function prismaClientsOf({ vfs, cwd = '/', packageManager, client, cache } = {}) {
  const name = 'prismaClientsOf'
  const { layOutTrees, packageManagerOf, plannedTrees, vfsHost } = await import('../vfs-bundle/tree.js')
  const { loadGenerator, schemaProjects } = await import('../vfs-bundle/prisma.js')
  const project = vfsHost(vfs)
  cwd = project.realpath(posix.resolve('/', cwd))
  const specs = (await treeSpecs(name, project, cwd, { packageManager })).filter((spec) => packageManagerOf(name, spec.packageManager).kind === 'js')
  await layLazily(name, project, cwd, specs)
  if (!plannedTrees({ project, specs }).some(({ root, projects }) => schemaProjects(project, root, projects).size > 0)) return []
  loadGenerator()
  const tree = await layOutTrees({ project, specs, client, cache, installDevDependencies: true })
  return (await prismaOutputs(tree, project, { projects: schemaProjects(project, tree.root, tree.projects), strict: false, shared: true })).outputs
}

// `project` is a Vfs, which `vfs` is, or the disk, for `stasis bundle --deptree`, which gives the `plan` of builds.
async function buildFromLockfile(name, project, { vfs, packageManager, cwd = '/', packageManagerVersion, os, cpu, libc, repo, innermostRoot = false, generate, client, cache, lazy, ...options } = {}, { env = {}, plan, outputsAt = () => [], refuseInstalled = false, why } = {}) {
  const { checkCache, checkKind, checkLazy, checkTarget, layOutTrees, packageManagerOf, pinFromTree, treeHost, unpackedOf, vfsHost } = await import('../vfs-bundle/tree.js')
  const { configuredBuilds } = await import('./bundle-options.js')
  const { checkGlob } = await import('../vfs-bundle/glob.js')
  checkTarget(name, { os, cpu, libc })
  checkCache(name, cache)
  if (lazy !== undefined && typeof lazy !== 'boolean') throw new TypeError(`${name}: lazy must be a boolean`)
  // Checked as the Bundle checks it, before anything is fetched.
  if (repo !== undefined) repo = new Bundle({ repo }).repo
  // A real path, as every file the scan reaches is.
  cwd = project.realpath(posix.resolve('/', cwd))
  const specs = await treeSpecs(name, project, cwd, { packageManager, packageManagerVersion, os, why })
  const packageManagers = specs.map((spec) => spec.packageManager)
  const pms = packageManagers.map((one) => packageManagerOf(name, one))
  if (lazy) for (const one of packageManagers) checkLazy(name, one)
  // The builds stasis.config.json's `entries` makes, whose union takes `extra` once; else the options given.
  const configured = plan === undefined ? configuredBuilds(name, { cwd, host: project, entries: options.entries, options }) : null
  const { builds, bundleExtra } = plan ?? { builds: configured?.builds ?? [options], bundleExtra: configured !== null }
  if (builds.length === 0) throw new Error(`${name}: no entries given, and ${CONFIG_FILE}'s entries name none`)
  // That the Vfs can be globbed for `extra` is checked before anything is fetched.
  if (parseExtraOption(CONFIG_FILE, readConfigFile(name, cwd, project)?.extra).some((pattern) => !pattern.startsWith('!'))) checkGlob()
  const installDevDependencies = installsDevDependencies(name, cwd, project)
  await layLazily(name, project, cwd, specs, lazy)
  // Prisma Clients: asked for, every project's, strictly; else, of a JS build of a Vfs, those the entries reach,
  // where `generatePrisma` leaves it; or none, their outputs read all the same.
  const generatePrisma = configFlag('generatePrisma', name, cwd, project)
  if (generate?.length > 0 && !generatePrisma) throw new Error(`${name}: generate is given, and ${CONFIG_FILE}'s generatePrisma is false`)
  const vfsJs = vfs !== undefined && pms.some((pm) => pm.kind === 'js')
  const prismaGeneration = generate?.includes('prisma') ? 'asked' : !vfsJs ? null : generate === undefined && generatePrisma ? 'detected' : 'off'
  const kinds = builds.map((build) => {
    const kind = checkVfsOptions(name, { ...build, lockfile: options.lockfile, generate, cwd, host: project })
    checkKind(name, kind, packageManagers)
    return kind
  })
  // An entry out of what the trees install is in the project already: checked before anything is fetched. (A
  // Solidity entry that is no .sol file is a directory, skipped where it is missing.)
  const installs = new Set(pms.map((pm) => pm.installs))
  for (const [i, build] of builds.entries()) {
    for (const entry of build.entries) {
      const abs = posix.resolve(cwd, entry)
      if (kinds[i] === 'sol' && !abs.endsWith('.sol')) continue
      if (!posix.relative(cwd, abs).split('/').some((part) => installs.has(part)) && project.stat(abs) === null) throw new Error(`entry not found: ${abs}`)
    }
  }
  // A Solidity build is built from cwd, but where a Soldeer project the trees lay out is below it: then each .sol
  // file is built from the innermost project holding it, with its foundry.toml and remappings.
  const solRoots = specs.filter((spec, i) => pms[i].kind === 'sol' && spec.cwd !== cwd).map((spec) => spec.cwd)
  const projectOf = (file) => solRoots.filter((dir) => isPathWithin(dir, posix.resolve(cwd, file))).reduce((inner, dir) => (isPathWithin(inner, dir) ? dir : inner), cwd)
  const solidityBuilt = async (build, args) => {
    if (solRoots.length === 0) return [{ bundle: await buildSolidityBundle({ ...build, ...args }), root: cwd }]
    const out = []
    for (const [from, entries] of Map.groupBy(expandSolidityEntries(cwd, normalizeEntries(build.entries, cwd), args.host), projectOf)) {
      // eslint-disable-next-line no-await-in-loop -- one project at a time, in the order its warnings read
      out.push({ bundle: await solidityFrom({ ...build, entries }, from, args), root: cwd })
    }
    return out
  }
  const laidOut = specs.length > 1 ? 'Laid out the trees' : specs[0].lazy ? 'Laid out the tree' : 'Installed the tree'
  const tree = await debugTimed(laidOut, () => layOutTrees({ project, specs, os, cpu, libc, client, cache, installDevDependencies, refuseInstalled }))
  const { inRounds, warningsHeld } = await import('../vfs-bundle/lazy.js')
  // The project the builds read, the Prisma Clients generated once before any build, so that each of a lazy
  // tree's rounds reads the same project.
  let outside = project
  let expected = []
  const prisma = prismaGeneration === null ? null : await import('../vfs-bundle/prisma.js')
  if (prisma !== null) {
    // Before any `prisma` is read. Nothing done, nor said, where no project has a schema.
    const withSchema = prisma.schemaProjects(project, tree.root, tree.projects)
    const strict = prismaGeneration === 'asked'
    // By its real path, as the scan reaches it, where the project holds it.
    const entryPath = (entry) => {
      const path = posix.resolve(cwd, entry)
      try {
        return project.realpath(path)
      } catch {
        return path
      }
    }
    const reached = () => prisma.reachedProjects(project, tree.root, tree.projects, builds.flatMap((build) => build.entries.map(entryPath)))
    const projects = strict || withSchema.size === 0 ? withSchema : withSchema.intersection(reached())
    if (projects.size > 0) {
      const off = prismaGeneration === 'off' ? `generation is off: ${generate === undefined ? `${CONFIG_FILE}'s generatePrisma is false` : 'generate is [] (--no-generate)'}` : undefined
      const clients = off === undefined ? await debugTimed('Generated the Prisma Clients', () => prismaOutputs(tree, project, { projects, strict })) : { outputs: [] }
      // What their generators would write, read from the project alone: a lazy tree fetches nothing for it.
      expected = prisma.expectedOutputs({ host: project, root: tree.root, projects, ...clients, off })
      if (clients.outputs.length > 0) outside = vfsHost(prisma.withPrismaClients(vfs, clients.outputs))
    }
  }
  const generated = expected.length === 0 ? undefined : prisma.generatedMiss(expected)
  // For a lazy tree, in rounds, each build keeping what its scans read across them in a memo of its own.
  const memos = tree.unpack === undefined ? undefined : builds.map(() => new Map())
  const attempt = async (reads) => {
    const host = treeHost(tree, outside, reads)
    const args = { cwd, host, env }
    // A Vfs holds nothing built: a build broken at load by a miss --typescript resolves is built with it
    // instead, saying nothing of what the first warned.
    const jsBuilt = async (build, memo) => {
      const js = (typescript, kept = memo) => buildJs({ ...build, ...args, typescript, innermostRoot, extra: !bundleExtra, outputsAt, memo: kept, generated })
      if (vfs === undefined || build.typescript) return js(build.typescript)
      const first = await warningsHeld(() => js(false))
      if (first.error?.resolvesUnderTypescript) return js(true, memo && nestedMap(memo, 'typescript'))
      for (const warning of first.warnings) console.warn(...warning)
      if (first.error) throw first.error
      return first.value
    }
    const builts = []
    // A build of a round that asked for a package already is void, whatever it threw: the builds after it
    // are run all the same, for all else they ask for, and the round is set aside after.
    let voided
    const ofBuilds = []
    for (const [i, build] of builds.entries()) {
      let built
      try {
        // eslint-disable-next-line no-await-in-loop -- one build at a time, in the order its warnings read
        built = kinds[i] === 'sol' ? await solidityBuilt(build, args) : [await jsBuilt(build, memos?.[i])]
      } catch (error) {
        if (reads === undefined || reads.asked.size === 0) throw error
        voided ??= { error }
        continue
      }
      for (const one of built) {
        // Rooted at cwd, where `stasis bundle` detects its repo.
        if (repo === undefined && !one.stateBuilt) one.bundle.repo ??= detectRepo(cwd, host)
        builts.push(one)
        ofBuilds.push(build)
      }
    }
    if (voided !== undefined) throw voided.error
    const { root } = builts[0]
    const union = unionOfBuilds(name, ofBuilds, builts, builts.map((built) => built.root))
    // `extra` once: to the union; else to the one build given, unless its State took it.
    return { root, builts, host, ...bundleExtra || !builts[0].stateBuilt ? withExtra(union, root, { outputs: outputsAt(root), resources: bundleExtra ? undefined : builds[0].resources, host, name }) : union }
  }
  const since = counts()
  const built = tree.unpack === undefined
    ? await debugTimed('Built', () => attempt(), () => builtSince(since))
    : await inRounds(...debugging() ? reportedRounds(attempt, tree.unpack) : [attempt, tree.unpack])
  const { bundle, lockfile, root } = built
  // After the lazy rounds, so only the full tree's build is checked.
  assertPolicies(name, { builds, builts: built.builts, bundle, root, host: project, files: built.host, label: `${name}: ${CONFIG_FILE}` })
  // Said where the bundle carries what generators stasis didn't run would write, as the repo has it.
  if (prismaGeneration === 'detected') for (const warning of prisma.committedWarnings(expected, bundle, root)) console.warn(warning)
  if (repo !== undefined) bundle.repo = repo
  const accounts = pinFromTree(bundle, root, tree)
  const unpacked = unpackedOf(tree)
  // Built when first read: `stasis github-bundle` and `stasis bundle --deptree` read it for --lockfile alone.
  let lock
  return { bundle, get lockfile() { return (lock ??= lockfile && withAttested(lockfile(), bundle)) }, stats: { ...tree.stats, unpacked }, packageManager: packageManagers.length === 1 ? packageManagers[0] : undefined, packageManagers, root, accounts, accountsOf: (modules) => pinFromTree({ modules }, root, tree) }
}

// `to` (a Lockfile or a Bundle) with the ATTESTED_METADATA `from`'s records of the same buckets carry, in place
// of its own: a build's lockfile, taken before its bundle was pinned, with the bundle's.
function withAttested(to, from) {
  for (const [dir, info] of to.modules) if (from.modules.has(dir)) to.modules.set(dir, withAttestedOf(info, from.modules.get(dir)))
  return to
}

export const debugging = () => process.env.EXODUS_STASIS_DEBUG === '1' || process.env.EXODUS_STASIS_DEBUG === 'true'

// The time a --metro build's stages took, all told, in milliseconds, for EXODUS_STASIS_DEBUG.
const stageTimes = { scan: 0, metro: 0, configs: 0, carrying: 0 }
const staged = (stage, fn) => {
  const at = performance.now()
  try {
    return fn()
  } finally {
    stageTimes[stage] += performance.now() - at
  }
}
const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`

// `run()`, said on stderr once it settles under EXODUS_STASIS_DEBUG. Written, not warned: inRounds holds back
// what a round it sets aside warns.
export async function debugTimed(what, run, detail = () => '') {
  if (!debugging()) return run()
  const at = performance.now()
  try {
    return await run()
  } finally {
    process.stderr.write(`[stasis] ${what} in ${seconds(performance.now() - at)}${detail()}\n`)
  }
}

const counts = () => ({ files: { ...scanCounts }, stages: { ...stageTimes } })
const STAGES = { scan: 'scan', metro: "Metro's additions", configs: 'configs and toolchain', carrying: 'carrying' }

// What builds did since `since` (counts()'): the files their scans took, and the time of each stage.
function builtSince(since) {
  const files = Object.keys(scanCounts).map((key) => `${scanCounts[key] - since.files[key]} ${key}`).join(', ')
  const times = Object.keys(STAGES).filter((key) => stageTimes[key] > since.stages[key]).map((key) => `${STAGES[key]} ${seconds(stageTimes[key] - since.stages[key])}`)
  return ` (files ${files}${times.length > 0 ? `; ${times.join(', ')}` : ''})`
}

const packageName = (dir) => dir.slice(dir.lastIndexOf('/node_modules/') + '/node_modules/'.length)

// `attempt` and `unpack` as inRounds takes them, each round said on stderr as it ends (debugTimed).
function reportedRounds(attempt, unpack) {
  let round = 0
  return [
    (reads) => {
      round++
      const since = counts()
      const asked = () => (reads.asked.size === 0 ? ', the build' : `, asked for ${reads.asked.size} package${reads.asked.size === 1 ? '' : 's'}: ${[...reads.asked].slice(0, 5).map(packageName).join(', ')}${reads.asked.size > 5 ? ', …' : ''}`)
      return debugTimed(`Lazy round ${round}: built`, () => attempt(reads), () => `${builtSince(since)}${asked()}`)
    },
    (asked, read) => debugTimed(`Lazy round ${round}: unpacked`, () => unpack(asked, read)),
  ]
}

// `stasis bundle`'s Bundle, not written, a JS one held to the project's stasis.lock.json as `stasis bundle` holds it.
export async function buildBundle({ cwd = process.cwd(), env = process.env, entries, mappingFile, manifests = false, scope, conditions, mainFields, platforms, metro, metroResolver, babel = false, babelAliases, jsx = false, flow = false, typescript = false, tsconfig, resources, define, packageJSON = false, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false, cargoTarget = null, cargoManifests = false } = {}) {
  const options = { cwd, env, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }
  const built = await buildOfKind(classifyEntries('buildBundle', options), options)
  const root = built.root ?? resolve(cwd)
  assertPolicies('buildBundle', { bundle: built.bundle, root })
  heldOf(pinnedOf(built, root), root, { cwd, env })?.loads(built.bundle)
  return built.bundle
}

// Run `stasis bundle` (doc/bundle.md).
export async function bundleCommand({ cwd = process.cwd(), output, lockfile, lockfileOnly = false, brotliQuality, add = false, ...options } = {}) {
  if (add && output === '-') throw new Error('bundleCommand: --add cannot be combined with --output=- (nothing to merge into on stdout)')
  const lockfileOnlyRefused = lockfileOnly ? lockfileOnlyError({ lockfile, output, add, brotliQuality }) : null
  if (lockfileOnlyRefused !== null) throw new Error(`bundleCommand: ${lockfileOnlyRefused}`)
  const built = await buildOfCommand({ ...options, cwd, output, lockfile })
  const { root } = built
  // By default at the root, where `stasis run --bundle=load` discovers it: in cwd below the root it would root
  // the next run and `stasis bundle` there, out of the files above it.
  const target = output ?? relative(resolve(cwd), join(root, BUNDLE_FILE))

  let { bundle } = built
  // Only a JS bundle has a lockfile (classifyEntries refuses one for the others).
  const mode = built.held?.lock
  if (mode === 'replace' && lockfile === undefined) throw new Error(`bundleCommand: lock = replace rewrites ${built.held.label}: give --lockfile`)
  if (lockfile !== undefined && ['frozen', 'ignore', 'none'].includes(mode)) throw new Error(`bundleCommand: --lockfile: lock = ${mode} writes no lockfile`)
  let lockData = lockfile ? built.held.lockfile().serialize() : undefined

  const outAbs = target === '-' ? undefined : resolve(cwd, target)
  const lockAbs = lockData ? resolve(cwd, lockfile) : undefined
  // What the bundle on disk carried; undefined where nothing is merged.
  let mergedFrom
  if (add && existsSync(outAbs)) {
    let existing
    try {
      existing = parseBundleBytes(readFileSync(outAbs))
    } catch (cause) {
      throw new Error(`bundleCommand: --add failed to read the existing bundle at ${target}`, { cause })
    }
    refuseOtherRoot(existing, `the bundle at ${target}`, root, { cwd, at: outAbs })
    // What the bundle and lockfile on disk carry is written again, so held to the config's Policy too.
    const policy = parsePolicy(CONFIG_FILE, readConfigFile('bundleCommand', root))
    const links = linksOn(root)
    policy?.assertArtifact(existing, { hint: recordedIn(target), links })
    mergedFrom = existing.sources.size
    // What it carries already is held to the lockfile too, and to how its packages are installed, read anew
    // where the build has no account of them: as is what the lockfile there records, written again.
    const heldAsInstalled = (artifact, label) => {
      const unread = new Map([...artifact.modules].filter(([dir, info]) => !built.accounts.has(dir) && attestsAny(info)))
      heldToAccounts(artifact.modules, new Map([...built.accountsOf(unread), ...built.accounts]), `${label}: `)
    }
    built.held?.hold(deferredLockfile(existing))
    heldAsInstalled(existing, target)
    bundle = existing.merge(bundle)
    // The lockfile there merged too; in replace, which reads none, the bundle there recorded anew.
    if (lockData) {
      let existingLock
      if (mode === 'replace') {
        existingLock = deferredLockfile(existing)()
      } else {
        // With none on disk the bundle's files can't be attested (their hashes live only in the missing
        // lockfile): refused rather than written under-attesting.
        if (!existsSync(lockAbs)) {
          throw new Error(`bundleCommand: --add can't write a complete lockfile at ${lockfile}: the bundle at ${target} already carries files a fresh lockfile wouldn't attest, and there's no existing lockfile to merge into. Write --lockfile alongside the bundle from the first build, or drop --lockfile.`)
        }
        try {
          existingLock = Lockfile.parse(readFileSync(lockAbs, 'utf8'))
        } catch (cause) {
          throw new Error(`bundleCommand: --add failed to read the existing lockfile at ${lockfile}`, { cause })
        }
        refuseOtherRoot(existingLock, `the lockfile at ${lockfile}`, root, { cwd, at: lockAbs })
        // It may record more than the bundle beside it (a broader run's capture).
        policy?.assertArtifact(existingLock, { hint: recordedIn(lockfile), links })
        heldAsInstalled(existingLock, lockfile)
      }
      lockData = existingLock.merge(Lockfile.parse(lockData)).serialize()
    }
  } else if (add && lockData && mode !== 'replace' && existsSync(lockAbs)) {
    // No bundle to add to, but a lockfile: replaced, as one that can't be read is, unless rooted elsewhere.
    let existingLock
    try {
      existingLock = Lockfile.parse(readFileSync(lockAbs, 'utf8'))
    } catch { /* replaced */ }
    if (existingLock !== undefined) refuseOtherRoot(existingLock, `the lockfile at ${lockfile}`, root, { cwd, at: lockAbs })
  }

  // Serialized under --lockfile-only too: never write a lockfile of a bundle that couldn't be written.
  const serialized = bundle.serialize()
  built.held?.loads(bundle, { text: serialized, at: outAbs })
  const files = [...bundle.sources.keys()]
  const modules = bundle.modules

  const dest = lockfileOnly ? undefined : writeBundle(cwd, target, serialized, brotliQuality)
  if (lockData) writeFile(lockAbs, lockData)
  // The bundle's paths are relative to its root; shown relative to cwd, as `dest` is.
  const fromDir = posix.join(toPosix(relative(resolve(cwd), root)), outermostDir(files, root))
  if (lockfileOnly) {
    console.warn(lockedSummary(files.length, modules, fromDir, lockfile))
  } else if (mergedFrom !== undefined) {
    const added = files.length - mergedFrom
    console.warn(`[stasis] Added ${added} file${added === 1 ? '' : 's'} (${files.length} total in ${packagesLabel(modules)}) from ${fromDir} to ${dest}`)
  } else {
    console.warn(bundledSummary(files.length, modules, fromDir, dest))
  }
  // A stasis file written in a package below the root roots stasis run and stasis bundle there.
  const shown = (path) => relative(resolve(cwd), path) || '.'
  for (const file of [lockfileOnly ? undefined : outAbs, lockData ? lockAbs : undefined]) {
    const dir = file && dirname(file)
    if (!file || !STASIS_ROOT_FILES.includes(basename(file)) || dir === root || !isPathWithin(root, dir)) continue
    if (diskHost.stat(join(dir, 'package.json')) === null) continue
    console.warn(`[stasis] ${shown(file)} roots stasis run and stasis bundle in the package at ${shown(dir)}, but its paths are relative to ${shown(root)}: write it at ${shown(join(root, basename(file)))}`)
  }
}

// A build's lockfile held to the one `lockfile` names, else its project's, by its runs' lock mode.
function heldOf({ bundle, lockfile: built, accounts }, root, { cwd, env, lockfile }) {
  if (!built) return undefined
  const { lock, file } = lockModeOf(root, env)
  const at = lockfile ? resolve(cwd, lockfile) : file ?? join(root, LOCK_FILE)
  const label = relative(resolve(cwd), at)
  const hold = (other, options) => heldToLockfile(other, at, label, lock, options)
  const fresh = hold(built, { bundle, accounts })
  const loads = (written, { text, at: bundleAt = join(root, BUNDLE_FILE) } = {}) => {
    if (lock === 'frozen') loadsBeside(text ?? written.serialize(), { at: bundleAt, lockAbs: at, label, root, scope: written.config.scope })
  }
  return { lock, label, lockfile: () => fresh ?? built(), hold, loads }
}

// The lock mode and EXODUS_STASIS_LOCK_FILE of a run at `root` that writes a bundle, as a build does.
function lockModeOf(root, env = process.env, host = diskHost) {
  const config = new Config({ env: { EXODUS_STASIS_LOCK: env.EXODUS_STASIS_LOCK, EXODUS_STASIS_LOCK_FILE: env.EXODUS_STASIS_LOCK_FILE }, bundle: 'replace' })
  const text = readFileSyncMaybe(root, CONFIG_FILE, 'utf-8', host)
  if (text !== null) config.loadConfig(text)
  // A relative one of the working directory's, as a run reads it.
  return { lock: config.lock, file: config.lockFile && resolve(config.lockFile) }
}

// `built()` held to the lockfile at `lockAbs` by `mode`: in add, agreeing with it on all both record; in frozen,
// that too, and it must be there and attest every file built; in none, it must not be there.
function heldToLockfile(built, lockAbs, label, mode, { host = diskHost, bundle, accounts = [] } = {}) {
  if (mode !== 'add' && mode !== 'frozen' && mode !== 'none') return undefined
  const text = readFileSyncMaybe(dirname(lockAbs), basename(lockAbs), 'utf-8', host)
  if (text === null && mode !== 'frozen') return undefined
  // A build of none (a Solidity one) is held to nothing.
  const fresh = built()
  if (fresh === undefined) return undefined
  if (text === null) throw new Error(`${label} isn't there, and lock = frozen holds the build to it`)
  if (mode === 'none') throw new Error(`${label} is there, which lock = none refuses`)
  let lock
  try {
    lock = Lockfile.parse(text)
  } catch (cause) {
    throw new Error(`${label}: not a valid stasis lockfile`, { cause })
  }
  const merged = lock.mergeAgreeing(fresh, label, { held: true })
  heldToAccounts(lock.modules, accounts, `${label}: `)
  // What it alone records of a package no account tells the install of is the build's too: kept.
  for (const to of bundle ? [fresh, bundle] : [fresh]) withAttested(to, merged)
  if (mode === 'frozen') {
    const recorded = moduleFileKeys(lock.modules, { scope: lock.config.scope })
    for (const file of moduleFileKeys(fresh.modules, { scope: fresh.config.scope })) {
      if (!recorded.has(file)) throw new Error(`${label} (lock = frozen) doesn't attest ${file}`)
    }
  }
  return fresh
}

// That the bundle of `text`, to be written at `at`, loads beside the lockfile at `lockAbs` as `stasis run
// --lock=frozen --bundle=load` loads them; stasis.config.json is read without the bundle paths it names.
function loadsBeside(text, { at, lockAbs, label, root, scope, host = diskHost }) {
  // Not EXODUS_STASIS_BROTLI_QUALITY's, which says how a bundle is written.
  const bytes = brotliCompressSync(text, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 } })
  const readFile = (path) => {
    if (path === at) return bytes
    const data = host.readFile(path)
    if (basename(path) !== CONFIG_FILE) return data
    const { bundleFile: _bundleFile, resourcesBundleFile: _resourcesBundleFile, ...config } = JSON.parse(data.toString('utf8'))
    return Buffer.from(JSON.stringify(config))
  }
  const served = { ...host, readFile }
  try {
    // Rooted where the build is, as a run finding the lockfile there is: given explicitly, it roots nothing.
    new State(root, { lock: 'frozen', lockFile: lockAbs, bundle: 'load', bundleFile: at, scope, host: served, claim: false, env: { PROJECT_CWD: root } }) // eslint-disable-line no-new -- its constructor is the check
  } catch (cause) {
    throw new Error(`${label} (lock = frozen): ${cause.message}`, { cause })
  }
}

// --add to an artifact whose paths are relative to another root would key its records and the build's apart, never
// held to each other. Its root holds each workspace package it records and its entries, or with none, each npm
// dependency; one whose root can't be told is added to as ever.
function refuseOtherRoot(artifact, what, root, { cwd, at }) {
  const baseDir = resolve(cwd)
  const named = [...artifact.modules].filter(([, info]) => typeof info.name === 'string')
  const ecosystemOf = ([dir, { ecosystem }]) => dependencyEcosystem(dir, ecosystem)
  const workspace = named.filter((bucket) => ecosystemOf(bucket) === undefined)
  const [packages, entries] = workspace.length > 0 ? [workspace, [...artifact.entries]] : [named.filter((bucket) => ecosystemOf(bucket) === 'npm'), []]
  if (packages.length === 0) return
  const holds = (dir) => packages.every(([pkg, { name }]) => readPackageJson(dir, moduleFileKey(pkg, 'package.json'))?.name === name) &&
    entries.every((entry) => isFile(join(dir, entry)))
  const theirs = [...new Set([root, ...ancestors(baseDir), ...ancestors(dirname(at))])].find((dir) => holds(dir))
  if (theirs === undefined || theirs === root) return
  const shown = (dir) => relative(baseDir, dir) || '.'
  throw new Error(`bundleCommand: --add can't add to ${what}: its paths are relative to ${shown(theirs)} and this build's to ${shown(root)}${rootedBy(root)}; rebuild it without --add`)
}

// The bundle bundleCommand would write (but for `add`), parsed back as `stasis audit` would read it.
export async function buildCommandBundle(options = {}) {
  const { bundle } = await buildOfCommand(options)
  return Bundle.parse(bundle.serialize())
}

// bundleCommand's bundle and lockfile, not written, and the root their paths are relative to; `output` and
// `lockfile` are where it would write them, which `extra` never takes in.
async function buildOfCommand({ cwd = process.cwd(), env = process.env, home, entries, mappingFile, manifests = false, output, scope, lockfile, conditions, mainFields, platforms, metro, metroResolver, babel = false, babelAliases, jsx = false, flow = false, typescript = false, tsconfig, resources, define, packageJSON = false, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false, cargoTarget = null, cargoManifests = false, builds, deptree = false } = {}) {
  const options = { cwd, env, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }
  if (builds !== undefined) {
    if (!nonEmpty(builds)) throw new TypeError('bundleCommand: builds must be a non-empty array')
    const given = Object.entries(options).find(([key, value]) => !['cwd', 'env'].includes(key) && value !== undefined && value !== false && value !== null && !(Array.isArray(value) && value.length === 0))
    if (given) throw new TypeError(`bundleCommand: ${given[0]} can't be combined with builds (each build sets its own)`)
  }
  // Each build's options, the defaults above where it leaves one out.
  const plans = (builds ?? [{}]).map((build) => ({ ...options, ...build, cwd, env }))
  const kinds = plans.map((plan) => classifyEntries('bundleCommand', { ...plan, lockfile }))
  const outputsAt = (root) => [output ?? join(root, BUNDLE_FILE), lockfile].filter((file) => file !== undefined && file !== '-').map((file) => resolve(cwd, file))
  // With `builds`, `extra` is the bundle's, not any build's: added to their union.
  const bundleExtra = builds !== undefined
  let union, root
  if (deptree) {
    // The disk read through the tree, nothing cached (`cache: false`, and no setCacheDir here).
    const { createClient } = await import('@preventive/upstream/github.js')
    const built = await withNpmToken(home, () => buildFromLockfile('bundleCommand', diskHost, {
      cwd: resolve(cwd), lockfile, cache: false, lazy: false, client: createClient({ token: env.GITHUB_TOKEN || null }),
    }, { env, plan: { builds: plans, bundleExtra }, outputsAt, refuseInstalled: true, why: '--deptree lays out the dependencies from a lockfile' }))
    console.warn(unpackedSummary(built.stats))
    root = built.root
    // A lockfile of JS builds alone, as unionOfBuilds has one.
    union = { bundle: built.bundle, lockfile: kinds.every((kind) => kind === 'js') ? () => built.lockfile : undefined, accounts: built.accounts, accountsOf: built.accountsOf }
  } else {
    const builts = []
    for (const [i, plan] of plans.entries()) {
      // eslint-disable-next-line no-await-in-loop -- one build at a time, in the order its warnings read
      builts.push(await buildOfKind(kinds[i], { ...plan, outputsAt, extra: !bundleExtra }))
    }
    // A State-built JS bundle's paths are relative to the project's root at or above cwd.
    const roots = builts.map((built) => built.root ?? resolve(cwd))
    root = roots[0]
    // State-built bundles keep the State root's repo (no cwd fallback: their paths are relative to that root).
    for (const built of builts) if (!built.stateBuilt) built.bundle.repo ??= detectRepo(cwd)
    union = unionOfBuilds('bundleCommand', plans, builts, roots)
    // By the allowlist of the stasis.config.json at the root, not any entry's.
    if (bundleExtra) union = withExtra(union, root, { outputs: outputsAt(root) })
    union = pinnedOf(union, root)
    assertPolicies('bundleCommand', { builds: plans, builts, bundle: union.bundle, root })
  }
  return { ...union, root, held: heldOf(union, root, { cwd, env, lockfile }) }
}
