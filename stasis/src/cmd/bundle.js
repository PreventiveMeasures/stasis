import { isUtf8 } from 'node:buffer'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Bundle, isValidRepoField } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { extraArtifacts } from '@exodus/stasis-core/add'
import { getParser, importsTypescriptByOutputName, literalSpec, scan, scanCounts } from '../scan.js'
import { parseDefine } from '../define.js'
import { METRO_ASSET_EXTS, METRO_SOURCE_EXTS, createFieldResolver, isMetroAssetFile, resolveConditions } from '../resolve-fields.js'
import { discoverTsconfig, isDir, loadTsconfigPaths, packageTsconfigPaths } from '../resolve-typescript.js'
import { createMetroResolver } from '../metro-resolver.js'
import { ASSET_REGISTRY } from '../metro-assets.js'
import { createAliases, createBabelAliases, createBabelTypeImportsKept } from '../babel.js'
import { AUTO_INCLUDES, RN_CORE_INCLUDE_FILES, linkedNativePackages, linkedPackages, listing, looksNative, metroAssetFiles, nativeInputs } from '@exodus/stasis-plugins/metro-native'
import { pinInstalledCommits } from '../installed-commits.js'
import { State } from '@exodus/stasis-core/state'
import { readFileSyncMaybe, sha512integrity } from '@exodus/stasis-core/state-util'
import { checkoutCommit, detectRepo, normalizeEntries, packageLookup, packageJSONStat, packageType, parseGithubRepository, readJson, readModuleManifest, readPackageJson, readRegularFileOrNull, scopeManifestOf } from '@exodus/stasis-core/bundle-util'
import { EMPTY_MODULE_PATH, assertRealPathWithinBase, classifyFormat, fileInBucket, hasNodeModulesSegment, isDotEnvFile, isPathWithin, isPlainObject, moduleFileKey, moduleInfo, nestedMap, nodeExtFormat, observeExecutable, parseExtraOption, parseInstallDevDependencies, parseResourcesOption, posixPathEscapes, relativeEscapes, splitNodeModulesPath, toPosix, withMetadataOf } from '@exodus/stasis-core/util'
import { diskHost } from '@exodus/stasis-core/host'
import { parseBundleBytes } from '@exodus/stasis-core/brotli'
import { parseSoldeerLockfile } from '@preventive/lockfile/soldeer.js'
import {
  SOLIDITY_PACKAGE_MANIFESTS,
  SOLIDITY_ROOT_MANIFESTS,
  buildSolidityTree,
  collectSolidityFilesFromDisk,
  discoverSolidityConfig,
  expandSolidityEntries,
} from '../loaders/solidity.js'
import { decodeUtf8 } from '../loaders/solidity-ownership.js'
import { buildBashTree, collectBashFilesFromDisk } from '../loaders/bash.js'
import { boundaryOf, collectRustBundle, withinRealDir } from '../loaders/rust.js'
import { createCargoContext } from '../loaders/cargo.js'
import {
  bucketizePhpSources,
  buildPhpTree,
  collectPhpFilesFromDisk,
  loadComposerAutoload,
  loadComposerPackages,
  loadLaravelProviderFiles,
} from '../loaders/php.js'
import { DEFAULT_BUNDLE_FILE, bundledSummary, packagesLabel, unpackedSummary, writeBundle, writeFile } from './output.js'

const JS_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx'])
const BASH_EXTS = new Set(['.sh', '.bash'])
const RUST_EXTS = new Set(['.rs'])

// Fallback identity for the workspace bucket; Bundle.parse requires every bucket to attest name+version.
const SOLIDITY_WORKSPACE_NAME = 'solidity-bundle'
const SOLIDITY_WORKSPACE_VERSION = '0.0.0'
const SOLIDITY_FORMAT = 'solidity'
const BASH_WORKSPACE_NAME = 'bash-bundle'
const BASH_WORKSPACE_VERSION = '0.0.0'
const SHELL_FORMAT = 'shell'

const RUST_WORKSPACE_NAME = 'rust-bundle'
const RUST_WORKSPACE_VERSION = '0.0.0'
const RUST_FORMAT = 'rust'

const PHP_WORKSPACE_NAME = 'php-bundle'
const PHP_WORKSPACE_VERSION = '0.0.0'
const PHP_FORMAT = 'php'

// Deepest common parent dir of `paths`, relative to `cwd`; starts with `..` when entries
// escape cwd (e.g. via remapping), or "." when it is cwd itself.
export function outermostDir(paths, cwd) {
  if (paths.length === 0) return '.'
  const cwdAbs = posix.resolve(toPosix(cwd))
  const absDirs = paths.map((p) => posix.dirname(posix.resolve(cwdAbs, p)))
  const partsList = absDirs.map((d) => d.split('/'))
  const common = []
  for (let i = 0; i < partsList[0].length; i++) {
    const c = partsList[0][i]
    if (!partsList.every((parts) => parts[i] === c)) break
    common.push(c)
  }
  const absCommon = common.join('/') || '/'
  const rel = posix.relative(cwdAbs, absCommon)
  return rel === '' ? '.' : rel
}

// Split a Soldeer dep dir `<name>-<version>` (its authoritative identity); falls back to
// version 0.0.0 when it doesn't end in a semver (every bucket must attest a version).
function parseSoldeerDir(seg) {
  const m = /^(.+)-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/u.exec(seg)
  return m ? { name: m[1], version: m[2] } : { name: seg, version: '0.0.0' }
}

// A url as git fetches from a host: scp's `[user@]host:path`, with no scheme and a colon before its
// first slash, or a URL of a transport git has itself (`http`, `https`, `git`, `ssh` and its
// `git+ssh`/`ssh+git` aliases, lowercase, as git spells them), its authority, `[userinfo@]host[:port]`,
// ending at the first slash after it. Not, then, what a package.json spells GitHub's that git reads
// another way or not at all: `ssh://git@github.com:owner/name`, whose host is `github.com:owner` to
// git; `git+https://` or `HTTPS://`, transports git doesn't have; nor `owner/name`, a path, as is any
// url with no colon before its first slash.
const GIT_URL = /^(?:[^/]*:(?!\/\/)|(?:https?|git|ssh|git\+ssh|ssh\+git):\/\/(?:[^/@]*@)?[^/:@]*(?::\d*)?\/)/u

// The GitHub repository, `owner/name`, a .gitmodules `url` names (parseGithubRepository), else null:
// none for a host merely holding `github.com` (`https://notgithub.com/o/n`), nor for a url git
// doesn't fetch as one (GIT_URL), nor for npm's `github:owner/name`, the host `github`'s path to git,
// whatever an ssh alias or `insteadOf` makes of it, nor one with a `#`, which git keeps in the path
// it asks for (`owner/name.git#v1`) where npm takes a committish. git's `ssh+git://`, which a
// package.json doesn't spell, is its `ssh://`.
const submoduleGithub = (url) => (GIT_URL.test(url) && !/^github:/iu.test(url) && !url.includes('#') ? parseGithubRepository(url.replace(/^ssh\+git:/u, 'ssh:')) : null)

// The GitHub ones of `submodules` (readGitmodules), as Map<submodulePath, { name, branch }>.
function githubSubmodules(submodules) {
  const byPath = new Map()
  for (const { path, url, branch } of submodules) {
    const name = url && submoduleGithub(url)
    if (name) byPath.set(path, { name, branch })
  }
  return byPath
}

// The root of the GitHub repository `github` at `commit`, where both are valid; else undefined.
const repoRootAt = (github, commit) => (isValidRepoField('github', github) && isValidRepoField('commit', commit) ? { github, directory: '', commit } : undefined)

// The text of `rel`, a file of the project root, read as `ownership` vouches for it; null where it
// refuses it, nothing is there, or it isn't UTF-8.
function ownedText(baseDir, rel, ownership, host) {
  const { reason, real, outside } = ownership.of(rel)
  if (reason || real === null || outside) return null
  try {
    const buf = readRegularFileOrNull(join(host.realpath(baseDir), real), rel, host)
    return buf === null ? null : decodeUtf8(buf, rel)
  } catch {
    return null
  }
}

// Each git dependency the root's soldeer.lock installs from GitHub, by its folder under
// `dependencies/` (`<name>-<version>`, as Soldeer names it): the repository's root at the lockfile's
// `rev`, which Soldeer checks out there. None where the lockfile can't be read or parsed: it is
// metadata, which never stops a build.
function soldeerGitRepos(baseDir, ownership, host) {
  const text = ownedText(baseDir, 'soldeer.lock', ownership, host)
  let lock = null
  try {
    lock = text === null ? null : parseSoldeerLockfile(text)
  } catch {
    // Not one Soldeer writes: nothing is recorded from it.
  }
  const repos = new Map()
  for (const dep of Object.values(lock?.dependencies ?? {})) {
    const repo = dep.type === 'git' ? repoRootAt(parseGithubRepository(dep.git), dep.rev) : undefined
    if (repo !== undefined) repos.set(`${dep.name}-${dep.version}`, repo)
  }
  return repos
}

// Classify a Solidity file's dep bucket: Soldeer (`dependencies/<name>-<version>/`) or a
// github submodule (`lib/`, via the `.gitmodules` `ownership` read), else null to defer to the
// node_modules/workspace logic. `ownership.assert` vets a package.json path before it is read
// through `host`. A bucket's `repo` is the GitHub repository it is checked out from, at its root, at
// the commit its checkout's HEAD is at, as the bundle's own `repo` reads one: a submodule's, from
// the GitHub repository its .gitmodules url names; a Soldeer git dependency's, where it is its
// soldeer.lock `rev` (soldeerGitRepos), as Soldeer holds a checkout to the lockfile before taking it
// for installed: a folder left at another commit since the lockfile changed, or no checkout, records
// none.
function makeSolidityClassifier(baseDir, ownership, host) {
  const submodules = githubSubmodules(ownership.submodules)
  const check = ownership.assert
  const versions = new Map() // a submodule's package.json version, read once
  const commits = new Map() // a bucket's checkout's commit, read once
  const commitOf = (dir) => {
    if (!commits.has(dir)) commits.set(dir, checkoutCommit(join(baseDir, dir), host))
    return commits.get(dir)
  }
  let soldeer // soldeerGitRepos, read at the first Soldeer file
  return (path) => {
    if (path.startsWith('dependencies/')) {
      const seg = path.slice('dependencies/'.length).split('/')[0]
      if (seg) {
        const { name, version } = parseSoldeerDir(seg)
        const bucketDir = `dependencies/${seg}`
        soldeer ??= soldeerGitRepos(baseDir, ownership, host)
        const locked = soldeer.get(seg)
        const repo = locked !== undefined && commitOf(bucketDir) === locked.commit ? locked : undefined
        return { bucketDir, name, version, ecosystem: 'soldeer', ...(repo === undefined ? {} : { repo }) }
      }
    }
    for (const [sub, { name, branch }] of submodules) {
      if (path === sub || path.startsWith(`${sub}/`)) {
        if (!versions.has(sub)) versions.set(sub, readPackageJson(baseDir, moduleFileKey(sub, 'package.json'), { strict: true, check, host })?.version)
        const repo = repoRootAt(name, commitOf(sub))
        return { bucketDir: sub, name, version: versions.get(sub) ?? branch ?? '0.0.0', ecosystem: 'github', ...(repo === undefined ? {} : { repo }) }
      }
    }
    return null
  }
}

// A vendored crate's ecosystem, by where `cargo vendor` copied it from (vendoredFrom): a registry's
// copy is `cargo`, which `stasis audit` asks OSV about as a crates.io crate's; a git checkout's is
// `cargo-git`, and a copy with no `.cargo-checksum.json`, which could be either, `cargo-unknown`.
// Neither is ever sent to a public advisory database: a private git dependency's name has no place
// there, and a crates.io crate of the same name isn't it.
const vendoredEcosystem = (from) => {
  if (from === 'registry') return 'cargo'
  return from === 'git' ? 'cargo-git' : 'cargo-unknown'
}

// Classify a Rust file by the nearest Cargo.toml `[package]`: a `cargo vendor`ed crate under the
// vendor dir (`vendor/<dir>/`, or where .cargo/config.toml points) is a dependency (tagged
// `cargo`, `cargo-git` or `cargo-unknown`: see vendoredEcosystem); any other package (the crate
// itself, a workspace member reached through a `path` dependency) is first-party, so no
// ecosystem. Null (no manifest above the file) defers to the package.json/placeholder logic.
function makeRustClassifier(cargo) {
  return (path) => {
    const pkg = cargo.packageInfo(path)
    if (!pkg) return null
    return { bucketDir: pkg.dir, name: pkg.name, version: pkg.version, ecosystem: cargo.isVendored(path) ? vendoredEcosystem(cargo.vendoredFrom(path)) : undefined }
  }
}

// A file of the bundle root (`realBase` its real path), its bytes, by project-relative path, or
// null when it isn't a regular file there (a manifest the context saw may have gone since; a FIFO
// would hang a read) or, with `within` a directory, doesn't really lie in it (a vendored crate's
// manifest linked to a project file).
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

// Project-relative paths in `sources` whose on-disk file carries a POSIX execute bit -- the
// `executable` list both artifacts record. The State-driven path derives this in addFile; the
// static builders never touch a State, so they stat here.
function executableSources(baseDir, sources, host) {
  const executable = new Set()
  for (const path of sources.keys()) {
    // A fresh set: a file that can't be looked at is just not marked.
    if (observeExecutable(join(baseDir, path), host) === true) executable.add(path)
  }
  return executable
}

// Bundles must be self-contained: throw on a missing entry or an unresolved `noun` (import, script,
// module) of a `lang` bundle -- `missing`'s { spec, from }, with the `reason` it was refused if given.
function assertSelfContained(lang, noun, entries, sources, missing) {
  const issues = []
  for (const entry of entries) {
    if (!sources.has(entry)) issues.push(`Missing entry: ${entry}`)
  }
  for (const { spec, from, reason } of missing) {
    issues.push(`Unresolved ${noun}: ${spec} from ${from}${reason ? ` (refused: ${reason})` : ''}`)
  }
  if (issues.length > 0) {
    throw new Error(`${lang} bundle has unresolved ${noun}s:\n${issues.map((s) => `  ${s}`).join('\n')}`)
  }
}

// Assemble a full-scope code Bundle shared by the non-JS bundlers. Files are bucketed by
// nearest package.json (node_modules -> `npm`-tagged bucket, workspace -> its dir, none ->
// "." with the placeholder identity); a node_modules file whose nearest package.json is the
// workspace root is rejected, not mislabeled; `packageOf(path)` finds that package.json
// (packageLookup by default, which walks past a malformed one). `classifyDep(path)` optionally
// places a file directly (non-node_modules ecosystems like Soldeer/github); null defers. `format` tags
// every file; `formats` (Map<path,format>) overrides it per file. `resolutions` values are
// a flat target string or a Map<platform,target>; both round-trip untouched. `keyedResolutions`,
// `consumer` and `consumerFiles` are codeBundle's.
function assembleCodeBundle({
  baseDir, entries, sources, resolutions, keyedResolutions, workspaceName, workspaceVersion, format, formats, conditionKey, classifyDep, host,
  packageOf = packageLookup(baseDir, { host }), consumer, consumerFiles,
}) {
  const modules = new Map()
  // `identity`'s name, version, ecosystem, repo and vendored (moduleInfo takes those alone); a later
  // file's adds the vendored package it is in.
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
    // A node_modules file whose nearest package.json is the workspace root (or none at all) is a misconfigured dep -- refuse.
    if (splitNodeModulesPath(path) !== null && !(meta && hasNodeModulesSegment(meta.pkgDir))) {
      throw new Error(`No package.json with name+version found for ${path}`)
    }
    const [dir, identity] = meta ? [meta.pkgDir, meta] : ['.', { name: workspaceName, version: workspaceVersion }]
    ensureBucket(dir, identity).files[fileInBucket(dir, path)] = content
  }

  return codeBundle({ baseDir, entries, sources, modules, resolutions, keyedResolutions, format, formats, conditionKey, host, consumer, consumerFiles })
}

// A full-scope code Bundle of `sources`, bucketed as `modules`: `format` tags every file, `formats`
// (Map<path,format>) overrides it per file (a file neither tags has none), and the `resolutions` edges
// are keyed under `conditionKey`, beside the `keyedResolutions` (conditions key -> parent -> specifier
// -> target) under keys of their own. The `consumerFiles` (every file, by default) are attributed to
// `consumer` in the `reason` map: `bundle`, or `bundle:metro` for --metro.
function codeBundle({ baseDir, entries, sources, modules, resolutions, keyedResolutions = new Map(), format, formats, conditionKey, host, consumer = 'bundle', consumerFiles }) {
  const formatsMap = new Map()
  for (const path of sources.keys()) {
    const fileFormat = formats?.get(path) ?? format
    if (fileFormat !== undefined) formatsMap.set(path, fileFormat)
  }

  const imports = new Map([[conditionKey, new Map(resolutions)], ...keyedResolutions])

  // Executable bits, straight off disk (a synthetic source with no file there is simply not
  // executable). Shell bundles lean on this most: `stasis extract` puts the +x back on the scripts.
  const executable = executableSources(baseDir, sources, host)

  // Attribute files to the static build's consumer (static builders skip State's per-file tagging).
  return new Bundle({
    config: { scope: 'full' },
    entries: new Set(entries),
    modules,
    formats: formatsMap,
    imports,
    executable,
  }).withReason(consumer, consumerFiles)
}

// Files never carried, whatever reads them: `.env` files, and Hardhat's config, which is code
// (both however they're cased).
const neverCarried = (rel) => isDotEnvFile(rel) || posix.basename(rel).toLowerCase().startsWith('hardhat.config.')

// The build-description files of a Solidity bundle (--manifests), as Map<path, text>, sorted:
// `configFiles` (what discoverSolidityConfig read, whatever they're called), each of which must be
// carried -- one outside the root, neverCarried, refused or gone is an error, as the bundle
// couldn't reproduce the resolution without it -- plus the SOLIDITY_*_MANIFESTS that exist, for the
// root and for each package dir `classifyDep`/`packageOf` places a bundled source in, but none
// whose path `ownership` refuses (see solidityOwnership). Carried as written: whatever they hold
// (an RPC URL with its API key, an Etherscan key, a URL's credentials) is in the bundle too, as
// with --package-json. Read through `host`.
function solidityManifests(baseDir, sources, configFiles, { classifyDep, packageOf, ownership, host }) {
  const realBase = host.realpath(baseDir)
  // `{ text }`, or `{ why }` it can't be carried (null: nothing is there). Read by the real path
  // `ownership` resolved `rel` to, so what's carried is the file it vouched for.
  const carry = (rel) => {
    const { reason, real, outside } = ownership.of(rel)
    if (reason) return { why: reason }
    if (real === null) return { why: null }
    if (outside) throw new Error(`Refusing to follow symlink escaping bundle root: ${rel} -> ${resolve(realBase, real)}`)
    const buf = readRegularFileOrNull(join(realBase, real), rel, host)
    if (buf === null) return { why: null } // a directory
    return { text: decodeUtf8(buf, rel) }
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

// An entry `stasis bundle` takes for a directory: one that is, or an extensionless path that
// doesn't exist (a project without `script/` still bundles with `src test script`).
const isDirEntry = (abs, host = diskHost) => isDir(abs, host) || (extname(abs) === '' && host.stat(abs) === null)

// Whether `entry` (resolved against `cwd`) is a Solidity bundle's: a .sol file or a directory entry.
export const isSolidityEntry = (entry, cwd = process.cwd(), host = diskHost) => entry.endsWith('.sol') || isDirEntry(resolve(cwd, entry), host)

// What's wrong with `entries`' directory entries (resolved against `cwd`), or null: a directory
// entry stands for the .sol files under it, so it goes with Solidity entries only; and entries
// that are all missing extensionless paths are a mistyped file, not a project without those dirs.
// `fetched` false: `host` is an empty tree standing in for one not fetched yet, which can't say
// what is missing.
export function directoryEntryError(entries, cwd = process.cwd(), host = diskHost, { fetched = true } = {}) {
  const dirs = entries.filter((e) => isDirEntry(resolve(cwd, e), host))
  const absent = fetched ? dirs.filter((e) => host.stat(resolve(cwd, e)) === null) : []
  if (absent.length > 0 && absent.length === entries.length) return `no such file or directory: ${absent[0]}`
  if (dirs.length === 0 || entries.every((e) => e.endsWith('.sol') || dirs.includes(e))) return null
  return absent.length > 0
    ? `no such file or directory: ${absent[0]}`
    : `a directory entry is only supported for Solidity bundles (it stands for the .sol files under it): ${dirs[0]}`
}

// Build an in-memory Bundle from entry .sol files and directories (a directory stands for the .sol
// files under it, as forge's src/test/script dirs and Hardhat's contracts dir do; a missing or
// empty one is skipped). Imports resolve through the remappings the project's build uses
// (discoverSolidityConfig: forge's discovery for a Foundry project); `mappingFile`
// (foundry.toml/remappings.txt) pins them to exactly what it lists. An import is refused when it
// reaches a non-.sol file or leaves the root, or when a dependency's reaches the project's own
// files. Config files are read, and bundled only with `manifests` (see solidityManifests). `env`
// supplies FOUNDRY_PROFILE / FOUNDRY_REMAPPINGS, reported when they apply. The project is read
// through `host`.
export async function buildSolidityBundle({ cwd = process.cwd(), entries, mappingFile, manifests = false, env = process.env, host = diskHost } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildSolidityBundle: at least one entry .sol file or directory is required')
  }

  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)
  for (const e of normalized) {
    if (!isSolidityEntry(e, baseDir, host)) throw new Error(`buildSolidityBundle: not a .sol file or directory: ${e}`)
  }
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
    baseDir,
    entries: expanded,
    sources: bundled,
    resolutions,
    workspaceName: SOLIDITY_WORKSPACE_NAME,
    workspaceVersion: SOLIDITY_WORKSPACE_VERSION,
    format: SOLIDITY_FORMAT,
    formats,
    conditionKey: 'solidity',
    classifyDep,
    packageOf,
    host,
  })
}

// Build an in-memory Bundle from entry .sh/.bash files by walking the source/exec graph.
// A local `source` inside the bundle root that resolves to no bundled script is fatal;
// external refs (PATH commands, `$VAR`, absolute, `../`-escaping) are dropped.
export async function buildBashBundle({ cwd = process.cwd(), entries } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildBashBundle: at least one entry .sh/.bash file is required')
  }
  for (const e of entries) {
    if (!BASH_EXTS.has(extname(e))) throw new Error(`buildBashBundle: not a .sh/.bash file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)

  const sources = await collectBashFilesFromDisk(baseDir, normalized)
  const { resolutions, missing } = buildBashTree(sources)

  // Self-contained (external refs never reach `missing`).
  assertSelfContained('Bash', 'script', normalized, sources, missing)

  return assembleCodeBundle({
    baseDir,
    entries: normalized,
    sources,
    resolutions,
    workspaceName: BASH_WORKSPACE_NAME,
    workspaceVersion: BASH_WORKSPACE_VERSION,
    format: SHELL_FORMAT,
    conditionKey: SHELL_FORMAT,
  })
}

// Build an in-memory Bundle from entry .rs files (crate roots) by walking `mod` declarations and
// references to in-tree crates (the package's own lib, Cargo `path` deps, `cargo vendor`ed
// crates). An unresolvable unconditional `mod` is fatal; path edges (`crate::`/`self::`/`super::`/
// relative `use`s) are recorded best-effort and never widen the file set. Registry deps that
// aren't vendored can't be bundled: they're reported, with a `cargo vendor` hint when there is no
// `vendor/` dir at all. Each crate's features are resolved from the manifests (Cargo.toml +
// Cargo.lock) the way `cargo build` of the entries' packages would, so `#[cfg(feature = …)]` code
// that is off stays out; `cargo` takes them from `cargo metadata` instead (opt-in: it runs cargo).
// `cargoFeatures` / `cargoNoDefaultFeatures` / `cargoAllFeatures` are cargo's `--features` /
// `--no-default-features` / `--all-features` for the entries' packages, in either mode.
// `cargoTarget` (a triple, or `host`) names the build's target: its cfgs, asked of rustc, decide
// `#[cfg(unix)]`-style code and target-specific dependency tables, which are otherwise all kept.
// `cargoManifests` also carries what describes each bundled package's build: its Cargo.toml (and
// the workspace's), its build script -- walked like a crate root, so its modules and the in-tree
// build-dependencies it reaches come along -- plus the root's Cargo.lock and .cargo/config.toml.
export async function buildRustBundle({ cwd = process.cwd(), entries, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false, cargoTarget = null, cargoManifests = false } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildRustBundle: at least one entry .rs file is required')
  }
  for (const e of entries) {
    if (!RUST_EXTS.has(extname(e))) throw new Error(`buildRustBundle: not a .rs file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)

  // One Cargo context for the walk, the edge pass and the bucketing: manifests are read once, and
  // the walk's crate resolution and the tree's feature decisions agree.
  const cargoCtx = createCargoContext(baseDir, {
    entries: normalized,
    cargo,
    features: cargoFeatures,
    noDefaultFeatures: cargoNoDefaultFeatures,
    allFeatures: cargoAllFeatures,
    target: cargoTarget,
  })
  // `include_str!` / `include_bytes!` assets ride along as resources: the walk records their
  // format. With `cargoManifests`, each package's build script is walked too (collectRustBundle).
  const { sources, formats, tree } = await collectRustBundle(baseDir, normalized, { cargo: cargoCtx, buildScripts: cargoManifests })
  if (cargoManifests) {
    // Each bundled package's manifests, and its workspace's lockfile and cargo config, carried as
    // written: whatever they hold (a registry token, a `git` URL's credentials) is in the bundle
    // too, as with --package-json. A file that isn't UTF-8 text is refused, not altered.
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

  // Where the features the cfg decisions rest on come from: cargo's resolver, or -- something it
  // takes missing -- a replay of the manifests, said so (a project without Cargo has neither).
  const resolution = cargoCtx.resolution()
  if (resolution.mode === 'replay' && normalized.some((e) => cargoCtx.packageInfo(e) !== null)) {
    console.warn(`[stasis] Rust features from a replay of the manifests, not cargo's resolver: ${resolution.why}`)
  }
  // EXODUS_STASIS_DEBUG=1: show the feature resolution the cfg decisions came from, per package and
  // context, so the replay, cargo's resolver and `cargo metadata` (which unifies dev/build deps
  // like resolver 1) can be compared.
  if (process.env.EXODUS_STASIS_DEBUG === '1' || process.env.EXODUS_STASIS_DEBUG === 'true') {
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

  // A crate the code names that the bundle doesn't hold: a registry dependency that isn't vendored
  // (or not in a version its requirement allows), a path or patch outside the bundle root (the
  // loader warned of those), or a crate root the walk refused -- and any other dependency a bundled
  // package's build links that nothing in-tree answers, however the code names it, if at all.
  // Reported whatever the vendor dir holds; with none, the fix is one command.
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
    baseDir,
    entries: normalized,
    sources,
    resolutions,
    workspaceName: RUST_WORKSPACE_NAME,
    workspaceVersion: RUST_WORKSPACE_VERSION,
    format: RUST_FORMAT,
    formats,
    conditionKey: 'rust',
    classifyDep: makeRustClassifier(cargoCtx),
  })
}

// Build an in-memory Bundle from entry .php files by statically scanning the
// require/include graph (and Composer's class-autoload graph when present); no PHP is
// executed. Autoload resolution is best-effort; explicit require/include of a literal path
// is strict, and a missing entry or unresolved explicit include is fatal.
export async function buildPhpBundle({ cwd = process.cwd(), entries } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildPhpBundle: at least one entry .php file is required')
  }
  for (const e of entries) {
    if (!e.endsWith('.php')) throw new Error(`buildPhpBundle: not a .php file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const normalized = normalizeEntries(entries, cwd)
  const autoload = loadComposerAutoload(baseDir)
  // The Composer packages, of composer.lock (vendor/composer/installed.json held identical to it
  // where both are), or of installed.json alone: read once, before anything is scanned.
  const packages = loadComposerPackages(baseDir)

  // Laravel auto-discovers service providers rather than referencing them statically; seed
  // them as extra roots so their config/route/view files get bundled.
  const providerRoots = loadLaravelProviderFiles(baseDir, autoload, packages)

  const sources = await collectPhpFilesFromDisk(baseDir, [...normalized, ...providerRoots], { autoload })
  const { resolutions, missing } = buildPhpTree(sources, { baseDir, autoload })

  assertSelfContained('PHP', 'import', normalized, sources, missing)

  return codeBundle({
    baseDir,
    entries: normalized,
    sources,
    // Group per Composer package (vendor/<pkg>), not the node_modules bucketizer.
    modules: bucketizePhpSources(baseDir, sources, PHP_WORKSPACE_NAME, PHP_WORKSPACE_VERSION, packages),
    resolutions,
    format: PHP_FORMAT,
    // PHP includes don't vary by Node condition; key edges under "php", not the JS wildcard "*".
    conditionKey: 'php',
  })
}

// Render a scanned file URL for diagnostics: project-relative when inside `baseDir`, else absolute.
// The scan issue checks run on the LIVE scan, whose files/imports are keyed by absolute file: URLs
// (the resolver returns absolute paths); relativizing here matches the project-relative paths the
// bundle itself stores (toRel), rather than leaking the machine's absolute paths into the message.
function displayPath(url, baseDir) {
  const abs = fileURLToPath(url)
  const rel = relative(baseDir, abs)
  return rel && !relativeEscapes(rel) ? rel : abs
}

// One unresolved scan edge for diagnostics, naming the file --typescript would resolve it to when
// the scan found one (Scan#typescriptCandidate).
function describeUnresolved(u, show) {
  const typescript = u.typescriptURL ? `; resolves to ${show(u.typescriptURL)} under --typescript` : ''
  return `${u.kind} ${u.spec ?? '<dynamic>'} from ${show(u.parentURL)} (${u.reason}${typescript})`
}

// Static ESM import/export-from edges load eagerly before user code, so a failure there is
// uncatchable; one below a require()/dynamic-import() boundary is catchable.
const STATIC_KINDS = new Set(['import', 'export-from'])

// The files the entries link eagerly, through static edges alone.
function eagerlyLinked(scanner) {
  const linked = new Set(scanner.entries)
  const walk = [...scanner.entries]
  while (walk.length > 0) {
    for (const e of scanner.files.get(walk.shift())?.edges ?? []) {
      if (STATIC_KINDS.has(e.kind) && e.child && !linked.has(e.child)) {
        linked.add(e.child)
        walk.push(e.child)
      }
    }
  }
  return linked
}

// The scan within the project root (`within(url)`), since a bundle can't carry a file outside it.
// One the entries link eagerly is returned in `outside`, for the caller to refuse. One reached
// only past a require()/import() boundary is left out, with whatever only it reaches, and its edges
// are returned in `leftOut`, misses that load can catch as it does an unresolved one: an optional
// peer dependency's lazy require() reaching a copy hoisted above a root that a stasis file pins, say.
function withinRoot(scanner, within) {
  const outside = [...eagerlyLinked(scanner)].filter((url) => scanner.files.has(url) && !within(url))
  if (outside.length > 0) return { scanner, outside, leftOut: [] }
  const kept = new Set([...scanner.entries].filter((url) => scanner.files.has(url)))
  const walk = [...kept]
  while (walk.length > 0) {
    for (const e of scanner.files.get(walk.shift())?.edges ?? []) {
      if (e.child && scanner.files.has(e.child) && !kept.has(e.child) && within(e.child)) {
        kept.add(e.child)
        walk.push(e.child)
      }
    }
  }
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

// Refuse an edge one --metro platform resolves within the root and another leaves out (see
// withinRoot): collapsed to the one target, it would serve that platform the other's file.
function refuseSplit(split, baseDir) {
  for (const { parentURL, spec, outsideURL } of split) {
    throw new Error(
      `${spec} from ${displayPath(parentURL, baseDir)} resolves within the project root in one context and outside it, ` +
      `at ${relative(baseDir, fileURLToPath(outsideURL))}, in another: a bundle can't leave out the one without serving the other in its place`
    )
  }
}

// Classify scanner unresolved edges + parse errors into fatal (broken/divergent at load)
// vs tolerated (a catchable runtime miss). Shared so the plain and --mainFields JS paths
// gate identically. `baseDir` relativizes the paths in the emitted messages (see displayPath).
function analyzeScanner(scanner, { baseDir }) {
  const show = (url) => displayPath(url, baseDir)
  const staticReachable = eagerlyLinked(scanner)
  const fatalUnresolved = (u) => STATIC_KINDS.has(u.kind) && staticReachable.has(u.parentURL)
  const fatal = scanner.unresolved
    .filter((u) => fatalUnresolved(u))
    .map((u) => `unresolved ${describeUnresolved(u, show)}`)
  // Fatal parse: an eagerly-linked module-family file, or any file the parser couldn't process.
  const fatalParse = (p) => staticReachable.has(p.url) && (p.format?.startsWith('module') === true || !p.recovered)
  for (const p of scanner.parseErrors) {
    if (fatalParse(p)) fatal.push(`parse error in ${show(p.url)}: ${p.message}`)
  }
  // Edge resolving to a file a source bundle can't carry (.node/.wasm/extensionless): scan
  // records it but never queues the child, so load would die.
  for (const [, byParent] of scanner.imports) {
    for (const [parentURL, specMap] of byParent) {
      for (const [spec, childURL] of specMap) {
        if (!scanner.files.has(childURL)) {
          fatal.push(`${spec} from ${show(parentURL)} resolves to ${show(childURL)}, which a source bundle can't carry`)
        }
      }
    }
  }
  const tolerated = scanner.unresolved.filter((u) => !fatalUnresolved(u))
  const toleratedParse = scanner.parseErrors.filter((p) => !fatalParse(p))
  return { fatal, tolerated, toleratedParse }
}

// Throw on fatal scan issues; warn on tolerated ones. `label` tags the scan pass; `baseDir`
// relativizes the paths in the warnings (see displayPath), matching analyzeScanner's messages.
function reportScanIssues({ fatal, tolerated, toleratedParse, leftOut = [] }, { label = '', baseDir, root = '' }) {
  const where = label ? ` (${label})` : ''
  const show = (url) => displayPath(url, baseDir)
  // The first 10 of `items` as indented lines (`line` renders one), then how many more there are.
  const listed = (items, line = (s) => s) => {
    const more = items.length > 10 ? `\n  ... and ${items.length - 10} more` : ''
    return items.slice(0, 10).map((x) => `  ${line(x)}`).join('\n') + more
  }
  if (fatal.length > 0) {
    throw new Error(`JS bundle would be broken at load time${where}:\n${listed(fatal)}`)
  }
  if (tolerated.length > 0) {
    const summary = listed(tolerated, (u) => describeUnresolved(u, show))
    console.warn(`[stasis] Bundle has ${tolerated.length} unresolved import(s)${where}; they will fall through at load time:\n${summary}`)
  }
  if (toleratedParse.length > 0) {
    const summary = listed(toleratedParse, (p) => `${show(p.url)}: ${p.message}`)
    console.warn(`[stasis] Bundle has ${toleratedParse.length} file(s) with parse errors${where}; their recorded imports may be incomplete:\n${summary}`)
  }
  if (leftOut.length > 0) {
    // The file outside the root by its path from the cwd, as the refusal of one linked eagerly names it.
    const summary = listed(leftOut, (u) => `${u.kind} ${u.spec} from ${show(u.parentURL)} (at ${relative(baseDir, fileURLToPath(u.outsideURL))})`)
    console.warn(`[stasis] Bundle leaves out ${leftOut.length} import(s) of files outside the project root${root}${where}; they will fall through at load time:\n${summary}`)
  }
}

// Normalize conditions (trim, drop empties) so a sloppy programmatic caller can't push a bogus
// token into the resolver.
const cleanConditions = (conditions) => conditions.map((c) => (typeof c === 'string' ? c.trim() : c)).filter(Boolean)

// --typescript honours tsconfig `paths` aliases: an explicit --tsconfig's for every file (it must
// exist), else those of the tsconfig.json beside each importing file's package.json
// (packageTsconfigPaths, the project read as the State reads it, to `env`'s PROJECT_CWD; null
// matcher = no aliases). Without --typescript they only hint a miss (Scan#typescriptCandidate), so a
// config that doesn't load is none.
function typescriptPathsFor(typescript, baseDir, tsconfig, host, env) {
  if (typescript && tsconfig !== undefined) return loadTsconfigPaths(discoverTsconfig(baseDir, tsconfig, host), host)
  return packageTsconfigPaths(baseDir, { host, lenient: !typescript, projectCwd: env.PROJECT_CWD })
}

// Build a JS/TS Bundle (in-memory) by statically scanning the require/import graph; no
// user code is executed, and TS is stored verbatim (Node strips types at load). Scope comes
// from stasis.config.json / `EXODUS_STASIS_SCOPE` unless `scope` overrides. `conditions` are
// extra `exports`/`imports` conditions; on their own they don't honour legacy mainFields or
// platform suffixes (see `--mainFields` / buildResolvedJsBundle). `typescript` maps a failed
// resolution to its on-disk TS source (tsc's rules; see resolve-typescript.js), honouring the
// `paths` aliases of `tsconfig` (an explicit config path, default each package's tsconfig.json); it
// is taken as given where the entries import TS sources by output name (importsTypescriptByOutputName).
// `define` gives globals their values, a branch they keep from running reaching nothing (define.js).
// Files are read through `host` (@exodus/stasis-core/host), the disk by default; EXODUS_STASIS_*
// settings from `env`. With `innermostRoot`, the State is rooted at the innermost package at or
// above cwd that holds every file the scan reaches (innermostRootOf), rather than at the project's
// root above it, where that holds no stasis file of its own. With `extra`, the files its
// stasis.config.json's `extra` names are added as `stasis run` adds them (State#includeExtra), never
// one of `outputsAt(root)` (the absolute paths the build writes, given the root its paths are
// relative to), resources by `resources` where given, else by the config's; read through `host`, as
// Node's glob reads the disk. `memo` is what the build's scans keep across the rounds a lazy tree is
// read in, by each scan's label (vfs-bundle/lazy.js): the scan keeps what it reads there, and a round
// that read a package not unpacked yet (`host.touches()`) stops after it.
export async function buildJsBundle({ cwd = process.cwd(), env = process.env, entries, scope, conditions = [], jsx = false, flow = false, typescript = false, tsconfig, resources, define, packageJSON = false, host = diskHost, innermostRoot = false, extra = false, outputsAt = () => [], memo } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('buildJsBundle: at least one entry .js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx file is required')
  }
  for (const e of entries) {
    if (!JS_EXTS.has(extname(e))) throw new Error(`buildJsBundle: not a JS/TS file: ${e}`)
  }

  const baseDir = resolve(cwd)
  const absEntries = entries.map((e) => resolve(baseDir, e))

  const scanConditions = cleanConditions(conditions)
  // --resources: extensions/filenames carried as opaque assets instead of failing "can't carry".
  const resourceSet = parseResourcesOption('buildJsBundle', resources)

  typescript ||= importsTypescriptByOutputName(absEntries, host)
  const typescriptPaths = typescriptPathsFor(typescript, baseDir, tsconfig, host, env)

  const scanned = scan(absEntries, { conditions: scanConditions, jsx, flow, typescript, typescriptPaths, resources: resourceSet, define, host, memo: memo ? nestedMap(memo, 'js') : null })
  // A round of a lazy tree that asked for a package already is void: the rest is moot.
  if (memo && host.touches() > 0) throw new Error('buildJsBundle: this round reads a package not unpacked yet')

  // Materialise via a non-preload State: addFile bucketizes + records sources/formats,
  // addImport replays the edge map; serialize emits the runtime loader's v1 layout.
  // bundle:'replace' skips reading any on-disk stasis.code.br (bundle:'add' would leak stale
  // entries); lock:'ignore' tolerates a pre-existing lockfile without consuming it; and it is never
  // written, so it claims no write target.
  const stateOptions = { bundle: 'replace', lock: 'ignore', ...(scope ? { scope } : {}), host, claim: false }
  let state = new State(baseDir, { ...stateOptions, env })
  // A root holding a stasis file is the project's own choice, whose config the build takes.
  if (innermostRoot && !STASIS_ROOT_FILES.some((file) => host.stat(join(state.root, file)) !== null)) {
    const root = innermostRootOf(baseDir, [...scanned.files.keys()].map((url) => host.realpath(fileURLToPath(url))), state.root, host)
    // The State's walk up from cwd stops at PROJECT_CWD, as it does where yarn sets it.
    if (root !== state.root) state = new State(baseDir, { ...stateOptions, env: { ...env, PROJECT_CWD: root } })
  }
  // Only what lies within the root is carried (see withinRoot). One the entries link eagerly is
  // refused, named here rather than as the State's bare assertion: a stasis file in a directory below
  // the project's root (a stray stasis.code.br there, say) roots the State at it, out of the files above.
  const { scanner, outside, leftOut } = withinRoot(scanned, (url) => isPathWithin(state.root, fileURLToPath(url)))
  const markers = STASIS_ROOT_FILES.filter((name) => host.stat(join(state.root, name)) !== null)
  const rootedBy = markers.length === 0 ? '' : ` (rooted there by its ${markers.join(' and ')}, which can be removed if stale)`
  const root = ` at ${relative(baseDir, state.root) || '.'}${rootedBy}`
  for (const url of outside) {
    throw new Error(`buildJsBundle: ${relative(baseDir, fileURLToPath(url))} is outside the project root${root}`)
  }
  // Fail closed where the bundle is guaranteed broken at load; warn on catchable misses (see analyzeScanner).
  reportScanIssues({ ...analyzeScanner(scanner, { baseDir }), leftOut }, { baseDir, root })
  for (const [url, info] of scanner.files) {
    // A resource carries bytes only: addFile derives resource vs resource:base64 from the content
    // and stores it under `resources` (a resource can't be an entry, so no isEntry).
    // Recorded as the `bundle` consumer's, which `extra` files are not.
    if (info.resource) {
      state.addFile(url, { resource: true, reason: 'bundle' })
      continue
    }
    const isEntry = scanner.entries.has(url)
    state.addFile(url, { format: info.format, isEntry, reason: 'bundle' })
  }
  // Edges where every context agrees keep the wildcard '*' key (getImport's fallback when a
  // condition lookup misses). Where the require()- and import()-context resolutions of one
  // (parent, specifier) DIVERGE, each target keeps its real condition key -- one '*' entry
  // would serve one context the other's file; an unmatched set fails closed via resolveBundled.
  // So does one that a context resolves and another misses or leaves out (an `exports` map with
  // a `require` branch alone, say): getImport serves no context the other's key where conditions
  // decide the resolution, so the miss stays one, as under Node.
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
        for (const [key, childURL] of byKey) {
          state.addImport(parentURL, spec, childURL, { conditions: key.split(', ') })
        }
      }
    }
  }
  // Its own targets are none of the State's: it writes nothing.
  if (extra) state.includeExtra({ outputs: outputsAt(state.root), resources: resources === undefined ? undefined : resourceSet })
  // --package-json, or the `packageJSON` of the stasis.config.json the State took, as `stasis run` takes
  // it: fold each bundled module's package.json into the State's buckets (idempotent -- no-ops any
  // manifest the scan already reached). State's bundle=replace makes writeBundle true, so addFile accepts them.
  if (packageJSON || state.config.packageJSON) state.includePackageJson()
  return state
}

// The files that root a State in the directory holding one (state.js's discovery).
const STASIS_ROOT_FILES = ['stasis.config.json', 'stasis.lock.json', DEFAULT_BUNDLE_FILE]

// The innermost directory at or above `baseDir`, up to `root`, holding every one of `files` (real
// paths) and a package.json with a name, which a State can be rooted at; `root` where none below it
// does. One without a name, such as a `{"type":"module"}` marker, is no root: the State takes such a
// file's package to be the named one above it, which it then must hold.
function innermostRootOf(baseDir, files, root, host) {
  for (let dir = baseDir; dir !== root && dirname(dir) !== dir; dir = dirname(dir)) {
    if (files.every((file) => isPathWithin(dir, file)) && readPackageJson(dir, 'package.json', { host })?.name !== undefined) return dir
  }
  return root
}

// Extensions probed when a resolved target names none, in Metro's default sourceExts order.
// Limited to what a source bundle can carry (scan's RESOLVABLE_EXTS) so the resolver never
// resolves a file the bundle would reject; an extensionless `import './Foo'` can land on
// Foo.jsx/Foo.tsx, as it does under Metro. Like Metro's default, this doesn't track a project's
// own sourceExts.
const SOURCE_EXTS = METRO_SOURCE_EXTS
// React Native preset mainFields for `--metro` (which also sets the RN conditions + platform suffixes).
const METRO_MAIN_FIELDS = ['react-native', 'browser', 'main']

// The config files a React Native app's build loads from its project root, though nothing the app
// imports reaches them: Metro's and the React Native CLI's, and with --babel(-aliases) Babel's.
const METRO_CONFIG_FILE = 'metro.config.js'
const METRO_CONFIG_FILES = [METRO_CONFIG_FILE, 'react-native.config.js']
const BABEL_CONFIG_FILE = 'babel.config.js'
// What else a React Native app's build runs in Node, which neither the app nor the configs import:
// the CLI that runs Metro and Metro itself, and what they load by a name or path given as a string.
// Each { name, file, via }: the package `name` as the packages `via` find it, each the next in turn
// (as each requires it), else as fewer of them do, the last ones, down to the project alone; `file`
// in it, else its entry, as a require() of it from the last of `via` resolves.
// Metro, as React Native's CLI plugin runs it (`react-native bundle`, `start`).
const METRO_VIA = ['react-native', '@react-native/community-cli-plugin', 'metro']
const METRO_TOOLCHAIN = [
  // React Native's CLI, which an app runs Metro through.
  { name: 'react-native', file: 'cli.js', via: [] },
  { name: 'metro', via: METRO_VIA.slice(0, -1) },
  // Metro's worker, which its workers run (require.resolve'd, to fork), its transform worker
  // (metro-config's default `transformerPath`), the child process jest-worker forks them in, and
  // metro-file-map's Haste worker: each loaded by a path.
  { name: 'metro', file: 'src/DeltaBundler/Worker.js', via: METRO_VIA.slice(0, -1) },
  { name: 'metro-transform-worker', via: METRO_VIA },
  { name: 'jest-worker', file: 'build/workers/processChild.js', via: METRO_VIA },
  { name: 'metro-file-map', file: 'src/plugins/haste/worker.js', via: METRO_VIA },
  // And its minifier, metro-config's default `minifierPath` (DEFAULT_METRO_MINIFIER_PATH), which the
  // worker requires from its own directory, by that name, as it minifies: what a pnpm override puts there
  // in its stead too (`module.exports = {}`).
  { name: 'metro-minify-terser', via: [...METRO_VIA, 'metro-transform-worker'] },
]
// With --babel(-aliases), the Babel transformer React Native's Metro config names
// (`babelTransformerPath`, require.resolve'd from @react-native/metro-config), which runs @babel/core
// and React Native's Babel preset, with its plugins.
const BABEL_TOOLCHAIN = [{ name: '@react-native/metro-babel-transformer', via: ['@react-native/metro-config'] }]
// The transformers stasis's Metro plugin (src/metro.js) points Metro at by path, beside it, which
// Metro's workers run when a config wraps its own in withStasis().
const STASIS_METRO_TRANSFORMERS = ['metro-transformer.js', 'metro-babel-transformer.js']
// The conditions a require() resolves with in Node, and the key its edges take (the scan's).
const NODE_REQUIRE_CONDITIONS = new Set(['require', 'node', 'node-addons', 'module-sync'])
const REQUIRE_KEY = [...NODE_REQUIRE_CONDITIONS].join(', ')
// What esbuild and webpack 5 both assert on every platform besides `import`/`require` and
// `default`, and so `--mainFields` too: `module`, the bundler-only condition a package's ESM build
// sits under, from an import and a require alike. (esbuild drops it when given conditions of its
// own; webpack keeps it, as `--conditions` adds to it here.) Node and Metro never assert it.
const BUNDLER_CONDITIONS = ['module']

// The built-in field/suffix resolver (resolve-fields.js) the legacy-field build resolves with on
// `platform` (null for --mainFields), its `mainFields` (Metro's under --metro), and the conditions
// it adds to the bundler base (`import`/`require` + `default`, never Node's `node`; see
// resolveConditions): --metro asserts the RN conditions (+ browser on web), Metro's own set;
// --mainFields asserts esbuild's and webpack's `module` (BUNDLER_CONDITIONS) and the user's --conditions.
// Under --metro, `assetExts` are the extensions Metro takes as assets (its defaults where not given).
export function fieldResolverFor(platform, { mainFields, metro = false, assetExts, conditions = [], typescript = false, typescriptPaths = null, host = diskHost, kept }) {
  const extras = metro ? ['react-native', ...(platform === 'web' ? ['browser'] : [])] : [...new Set([...BUNDLER_CONDITIONS, ...conditions])]
  const fields = metro ? METRO_MAIN_FIELDS : mainFields
  const resolver = createFieldResolver({
    mainFields: fields,
    platform,
    preferNative: platform !== null && platform !== 'web',
    sourceExts: SOURCE_EXTS,
    conditions: resolveConditions('commonjs', extras),
    // Opt into Metro's package-entry browser-field quirks only on the --metro path.
    metro,
    assetExts,
    // --typescript: tsc's mapping, inside the field resolver (the scanner's own fallback
    // only backs the built-in resolver). Unreachable under --metro-resolver
    // (classifyEntries rejects the combination -- metro-resolver can't substitute).
    typescript,
    typescriptPaths,
    host,
    kept,
  })
  return { extras, mainFields: fields, resolver }
}

const CONFIG_FILE = 'stasis.config.json'

// The stasis.config.json in `cwd`, parsed; null where there is none. `name`, if any, prefixes errors.
export function readConfigFile(name, cwd, host = diskHost) {
  const text = readFileSyncMaybe(resolve(cwd), CONFIG_FILE, 'utf8', host)
  try {
    return text === null ? null : JSON.parse(text)
  } catch (cause) {
    throw new Error(`${name === undefined ? '' : `${name}: `}${CONFIG_FILE} is not valid JSON`, { cause })
  }
}

// Whether the tree laid out from the lockfile for the project `host` holds at `cwd` installs
// devDependencies: the `installDevDependencies` of the stasis.config.json there, true without one.
export const installsDevDependencies = (name, cwd, host) => parseInstallDevDependencies(CONFIG_FILE, readConfigFile(name, cwd, host)?.installDevDependencies)

// --babel-aliases: the alias map of the JSON file `file` (a path from `baseDir`, in the project, read through
// `host`), babel-plugin-module-resolver's `alias` option as data: each alias to the string it maps to.
function readAliasesFile(baseDir, file, host = diskHost) {
  const rel = relative(baseDir, resolve(baseDir, file))
  if (relativeEscapes(rel)) throw new Error(`stasis bundle: --babel-aliases must name a file in the project: ${file}`)
  const text = readFileSyncMaybe(baseDir, toPosix(rel), 'utf8', host)
  if (text === null) throw new Error(`stasis bundle: --babel-aliases file not found: ${file}`)
  // A link to a file out of the project is refused too.
  assertRealPathWithinBase(host.realpath(baseDir), baseDir, toPosix(rel), host)
  let alias
  try {
    alias = JSON.parse(text)
  } catch (cause) {
    throw new Error(`stasis bundle: --babel-aliases file ${file} is not valid JSON`, { cause })
  }
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

// The `scope`, `resources` and `packageJSON` of a --mainFields/--metro build: as given (an empty
// `resources` too, for no allowlist; `packageJSON` true), else as the stasis.config.json in `cwd`
// sets them (the directory these bundles' paths are relative to, and where one is written by
// default). The field resolver builds a full-scope bundle alone, so a narrower scope, from either,
// is refused rather than silently ignored.
// -> { resources: Set<string> (parseResourcesOption's), packageJSON: boolean }
function fieldBuildOptions(name, { cwd = process.cwd(), scope, resources, packageJSON = false, host = diskHost }) {
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

// Metro's own empty module, which it resolves a disabled import to (its default
// resolver.emptyModulePath), where the project installs metro-runtime at its root.
const METRO_EMPTY_MODULE = 'node_modules/metro-runtime/src/modules/empty-module.js'
// An empty module's source, trimmed: nothing, or a lone "use strict" directive.
const EMPTY_MODULE_SOURCE = /^(?:(["'])use strict\1;?)?$/u

// The real path of METRO_EMPTY_MODULE under `baseDir`, where it is a file in the project that is in
// fact empty (EMPTY_MODULE_SOURCE), else null.
function metroEmptyModule(baseDir, host) {
  const abs = join(baseDir, METRO_EMPTY_MODULE)
  if (!host.stat(abs)?.isFile()) return null
  const real = host.realpath(abs)
  if (!isPathWithin(host.realpath(baseDir), real)) return null
  const buf = host.readFile(real)
  return isUtf8(buf) && EMPTY_MODULE_SOURCE.test(buf.toString('utf8').trim()) ? real : null
}

// The directory of package `name`, by its real path, in the nearest node_modules up from `dir` that
// holds it, as Node looks for one; through each package of `via` first, one that depends on it, for
// an install (pnpm) that links it only beside that one. -> undefined where none does
function packageDirFrom(dir, name, host, via = []) {
  let from = dir
  for (const step of [...via, name]) {
    let found
    for (let d = from; found === undefined; d = dirname(d)) {
      const candidate = join(d, 'node_modules', step)
      if (host.stat(join(candidate, 'package.json'))?.isFile()) found = host.realpath(candidate)
      else if (dirname(d) === d) return undefined
    }
    from = found
  }
  return from
}

// What a require() of `spec` from the directory `dir` resolves to, as Node resolves it. -> absolute
// path, or undefined where none does
function requireFrom(dir, spec, host) {
  try {
    return host.resolve(join(dir, 'package.json'), spec, NODE_REQUIRE_CONDITIONS)
  } catch {
    return undefined
  }
}

// The AST of the module `file`, read through `host` (`source` where read already).
const parseModule = (file, host, source = host.readFile(file).toString('utf8')) => getParser().parseSync(file, source, { sourceType: 'unambiguous' }).program

// Calls `fn` on each node of the AST `node`, depth first.
function walkAst(node, fn) {
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, fn)
    return
  }
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
  fn(node)
  for (const key of Object.keys(node)) if (key !== 'type') walkAst(node[key], fn)
}

// The method `node` calls on an object (`x.concat(...)` -> 'concat'), on the one named `object` where
// given (`require.resolve(...)`), or undefined.
function memberCall(node, object) {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) return undefined
  if (object !== undefined && (node.callee.object.type !== 'Identifier' || node.callee.object.name !== object)) return undefined
  return node.callee.property.name
}

// What the module `file` names by `require.resolve('x')`, read off its source, never run, each where
// Node resolves it (babelPathCall: from the module, or the `paths` it gives): the polyfills
// @react-native/js-polyfills' index.js lists for React Native's Metro config to prepend
// (`getPolyfills`), the Babel plugins a plugin runs Babel with itself. A specifier resolved more than
// once (in other `paths` too) is each of its resolutions.
// -> [specifier, absolute path][] of those that resolve, in source order
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

// The name Babel requires a plugin or preset its config names by (@babel/core's standardizeName):
// a `module:` name as written, else a short one prefixed (`module-resolver` ->
// babel-plugin-module-resolver, `@babel/env` -> @babel/preset-env, `@scope/x` -> @scope/babel-plugin-x,
// `@scope` -> @scope/babel-plugin); a path as is.
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

// A string that names a Babel plugin or preset by its form, a package or a path: `module:x`,
// `@babel/plugin-x`, `babel-plugin-x`, `@react-native/babel-preset`,
// `node_modules/@org/x-babel/babel/plugin-inline.js`.
const BABEL_MODULE_STRING = /^module:|babel[-/](?:plugin|preset)/u
// A module of a Babel config by its name: `babel` and `config` in its file's name (babel.config.js,
// create-babel-config.js), or in its package's (a shared config, @org/babel-config).
const BABEL_CONFIG_NAME = /babel.*config|config.*babel/iu
const isBabelConfigModule = (rel) => BABEL_CONFIG_NAME.test(posix.basename(rel)) || BABEL_CONFIG_NAME.test(splitNodeModulesPath(rel)?.name ?? '')

// The lists a Babel config names its plugins and presets in, by the name of the key, variable or object
// holding one, and what Babel takes each of them as.
const BABEL_LISTS = new Map([['plugins', 'plugin'], ['presets', 'preset']])
// And the list of extensions a Metro config gives Metro to take as assets (`resolver.assetExts`).
const METRO_ASSET_LISTS = new Map([['assetExts', 'asset']])
// The array methods making a list of the one they're called on: `concat` (with its arguments'),
// `filter`, `flat`, `slice`.
const LIST_METHODS = new Set(['concat', 'filter', 'flat', 'slice'])
// A path the module `file` computes from its own directory and strings: `__dirname`, a string, or a
// `path.resolve(...)` or `path.join(...)` of them. -> the path (a relative one from Babel's cwd), or null
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

// The path a call computes, as Babel takes a plugin or preset named by path:
// `path.resolve(__dirname, 'node_modules/@org/x/plugin')`, `path.join(__dirname, 'x')` (staticPath), or
// what `require.resolve('x')` resolves to as Node resolves it: from the module, else from each of the
// `paths` it gives (`{ paths: [path.join(__dirname, 'shared')] }`) in turn. -> it, or null
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

// What the lists of `lists` (the name of the key, variable or object holding one -> what each entry is
// taken as) in the AST `program` hold, read off its source, never run: each list (an array under such a
// key at any depth, a variable or property so named or assigned, one pushed onto either), through
// spreads, variables, branches and the array methods making a list of another (LIST_METHODS); each
// entry (or the first of a `[name, options]` pair) passed to `entry(type, node)`.
function readLists(program, lists, entry) {
  // Each variable's declarators with an initializer, by its name.
  const declarators = []
  walkAst(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) declarators.push(node)
  })
  const inits = Map.groupBy(declarators, (node) => node.id.name)
  const seen = new Map()
  // Read `node` for the `type`s it lists: `depth` levels of arrays in it lists (1 a list, 2 one `.flat()`
  // flattens), and an array below them an entry's `[name, options]` pair. A spread joins its elements to
  // the array spreading it; a variable is its initializers; a branch (`a ? b : c`, `a && b`) either side.
  const read = (node, type, depth) => {
    if (!node || depth > MAX_LIST_DEPTH) return
    const key = `${type}${depth}`
    if (!seen.has(node)) seen.set(node, new Set())
    if (seen.get(node).has(key)) return
    seen.get(node).add(key)
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
      // `base.concat(more)` of both, `[a, b].filter(Boolean)` of its own, `[[a], b].flat()` of its own
      // flattened, as many levels as it says (`flat(2)`, `flat(Infinity)`).
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
    // A list: under a key, held in a variable or assigned to a property, so named.
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

// The plugins and presets the module `file` names in the lists of them (readLists): by a string,
// standardized as Babel requires it, or by a path the module computes (babelPathCall), as is. With
// `anyString`, also any string naming one by its form (BABEL_MODULE_STRING) wherever it is, as
// written. -> the names
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

// The extensions Metro takes as assets (`resolver.assetExts`), as the project's Metro config gives them:
// Metro's defaults, and each string its metro.config.js lists among them, read off its source, never
// run (readLists: `assetExts: [...defaultConfig.resolver.assetExts, 'riv']`,
// `config.resolver.assetExts.push('riv')`). One it filters out is still taken as one.
function metroAssetExts(baseDir, host) {
  const exts = new Set(METRO_ASSET_EXTS)
  const config = join(baseDir, METRO_CONFIG_FILE)
  if (!host.stat(config)?.isFile()) return exts
  readLists(parseModule(config, host), METRO_ASSET_LISTS, (_, node) => {
    const ext = literalSpec(node)
    if (ext) exts.add(ext)
  })
  return exts
}

// How deep a Babel config's lists nest, as read: arrays of arrays `.flat()` flattens.
const MAX_LIST_DEPTH = 8
// The levels `.flat(arg)` flattens: 1 by default, else the number written (Infinity as deep as read).
function flatDepth(arg) {
  if (arg === undefined) return 1
  if (arg.type === 'Identifier' && arg.name === 'Infinity') return MAX_LIST_DEPTH
  return arg.type === 'Literal' && typeof arg.value === 'number' ? arg.value : 1
}

const JSX_FILE_EXTS = new Set(['.jsx', '.tsx'])
// Metro's asyncRequire (metro-config's default `asyncRequireModulePath`), which Metro adds to a build
// with an `import()`, as the Metro plugin's graph then holds it.
const ASYNC_REQUIRE = 'metro-runtime/src/modules/asyncRequire.js'

// A get-or-read cache for the rounds a lazy tree's build runs in (vfs-bundle/lazy.js), in its `memo`
// under `label`: what `read()` gives for a key, kept where reading it through `host` read no package
// not unpacked yet (`host.touches()`), as a scan keeps what it reads of a file; without a `memo`,
// read each time.
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

// `fn()` on `host`, its reads probes of what files packages hold, which read none of their code,
// where the host tells them apart (a lazy tree's, vfs-bundle/tree.js's treeHost).
const probing = (host, fn) => (host.probing === undefined ? fn() : host.probing(fn))

// What Babel and Metro add to a React Native build beyond what its source imports (#99 records no
// edge to one, as Metro bundles them unasserted), each resolved as `resolver` resolves it (Babel's
// aliases applied), or `platformResolver` where Babel never runs, from a file of `files` (absolute
// paths of code files) or `assets` (of the assets reached) it is added to: under
// --babel or --babel-aliases, the Babel helpers (every @babel/runtime/helpers/*.js of each
// @babel/runtime a file finds, which ones Babel adds hanging on the syntax the file uses), Metro's
// module system (metro-runtime), and React Native's polyfills (the files @react-native/js-polyfills
// lists); with an `import()` (`dynamicImports`), Metro's asyncRequire (ASYNC_REQUIRE); with JSX (`jsx`, else a
// .jsx/.tsx file), the JSX runtime Babel imports for it; for an asset, the asset registry
// (ASSET_REGISTRY) the module Metro builds of it, `require(registry).registerAsset({...})`, requires,
// which Metro builds past Babel, so no alias of Babel's applies to it (platformResolver). -> absolute
// paths
function metroInsertedFiles(files, { assets, baseDir, babelled, dynamicImports, jsx, resolver, platformResolver, conditions: conds, host, kept = (key, read) => read() }) {
  const inserted = new Set()
  // One file of each directory of `list`'s: a specifier resolves alike from every file of one, and
  // is kept by it (`kept`, keptAcross's).
  const onePerDir = (list) => [...new Map(list.map((file) => [dirname(file), file])).values()]
  const resolveFrom = (from, spec, by = resolver) => kept(`${by === resolver ? '' : 'platform\0'}${dirname(from)}\0${spec}`, () => {
    const url = by(from, spec, conds)?.url
    return url === undefined ? undefined : fileURLToPath(url)
  })
  if (babelled) {
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
  // Metro adds asyncRequire as a dependency of a module with an `import()`: from the project, else
  // through Metro, which depends on metro-runtime (an install that nests it, or a pnpm one, links it
  // only beside Metro).
  if (dynamicImports) {
    const metroDir = packageDirFrom(baseDir, 'metro', host)
    const file = requireFrom(baseDir, ASYNC_REQUIRE, host) ?? (metroDir === undefined ? undefined : requireFrom(metroDir, ASYNC_REQUIRE, host))
    if (file !== undefined) inserted.add(file)
  }
  // Babel's JSX transform imports the runtime into a file with JSX: under --jsx any one, else a
  // .jsx/.tsx one.
  for (const from of onePerDir(jsx ? files : files.filter((file) => JSX_FILE_EXTS.has(extname(file))))) {
    const runtime = resolveFrom(from, 'react/jsx-runtime')
    if (runtime !== undefined) inserted.add(runtime)
  }
  for (const from of onePerDir(assets)) {
    const registry = resolveFrom(from, ASSET_REGISTRY, platformResolver)
    if (registry !== undefined) inserted.add(registry)
  }
  return inserted
}

// Build a JS/TS Bundle + companion Lockfile via the legacy-field resolver (`--mainFields`/
// `--metro`). Scanned once per platform; each edge is recorded flat when the platforms that
// have it agree, or as a `{ platform: target }` map where they diverge. `scope` and `resources`
// are fieldBuildOptions'. Returns { bundle, lockfile }.
async function buildResolvedJsBundle({ cwd = process.cwd(), env = process.env, entries, mainFields, platforms, conditions = [], metro, metroResolver, babel, babelAliases: aliasesFile, jsx = false, flow = false, typescript = false, tsconfig, scope, resources, define, packageJSON = false, host = diskHost, memo }) {
  const baseDir = resolve(cwd)
  const absEntries = entries.map((e) => resolve(baseDir, e))
  const normalized = normalizeEntries(entries, cwd)

  // A resolved file arrives by its real path, an entry as spelled: under a cwd named through a link,
  // the files the scan reaches lie below the root's real path, not below `baseDir` as spelled. Either
  // is the root; a file below neither is outside it. (Realpathed only when needed, so a missing cwd
  // is still the scan's missing entry.)
  let realRoot
  // Each file's path from the root, and the path of each file URL, which the scans and what follows
  // them take again for each file they reach, and each edge: worked out once a build, or for a lazy
  // tree once across its rounds, in its `memo` (each is the path's alone).
  const fromRoot = memo ? nestedMap(memo, 'paths from the root') : new Map()
  const relWithin = (abs) => {
    if (fromRoot.has(abs)) return fromRoot.get(abs)
    let rel = toPosix(relative(baseDir, abs))
    if (relativeEscapes(rel)) {
      realRoot ??= host.realpath(baseDir)
      rel = toPosix(relative(realRoot, abs))
    }
    fromRoot.set(abs, relativeEscapes(rel) ? null : rel)
    return fromRoot.get(abs)
  }
  const pathsOf = memo ? nestedMap(memo, 'file paths') : new Map()
  const pathOf = (url) => {
    let path = pathsOf.get(url)
    if (path === undefined) pathsOf.set(url, (path = fileURLToPath(url)))
    return path
  }
  const toRel = (abs) => {
    const rel = relWithin(abs)
    if (rel === null) throw new Error(`Bundle would reach a file outside the project root: ${abs}`)
    return rel
  }

  const scanConditions = cleanConditions(conditions)

  // Taken as given where the entries import TS sources by output name, but under --metro-resolver,
  // which has no tsc mapping (classifyEntries rejects --typescript there).
  if (!metroResolver) typescript ||= importsTypescriptByOutputName(absEntries, host)
  // --typescript's tsconfig `paths` matcher, shared by every per-platform resolver below.
  const typescriptPaths = typescriptPathsFor(typescript, baseDir, tsconfig, host, env)
  // --resources (else the config's): extensions/filenames carried as opaque assets instead of
  // failing "can't carry". --package-json, else the config's `packageJSON`: see withManifests below.
  const { resources: resourceSet, packageJSON: withManifests } = fieldBuildOptions('buildResolvedJsBundle', { cwd, scope, resources, packageJSON, host })

  const formatsByRel = new Map()
  // Reached files the scanner tagged as resources (rel keys); read as bytes below, not UTF-8 source.
  const resourceRels = new Set()
  // parentRel -> specifier -> Map<platformKey, targetRel>; collapsed after all platforms scanned.
  const edges = new Map()
  const reached = new Set() // absolute paths reached on any platform
  let usesEmpty = false
  // What a disabled import resolves to: under --metro Metro's own empty module where the project
  // has it (metroEmptyModule), as Metro resolves it; else the reserved synthetic one.
  const metroEmpty = metro ? metroEmptyModule(baseDir, host) : null
  const emptyTarget = metroEmpty === null ? EMPTY_MODULE_PATH : toRel(metroEmpty)

  // --babel-aliases: the same aliasing as --babel's, from a JSON file of the project, for every platform alike.
  const fileAliases = aliasesFile === undefined ? null : createAliases(readAliasesFile(baseDir, aliasesFile, host), baseDir)
  // --babel or --babel-aliases: a build Metro runs through Babel, which adds its helpers to each file.
  const babelled = babel || fileAliases !== null
  // The edges each platform's scan left out above the root (withinRoot's leftOut), across platforms.
  const leftOutEdges = []
  // --metro: the extensions Metro takes as assets, its defaults and those the project's Metro config
  // adds (metroAssetExts: `assetExts: [...defaultConfig.resolver.assetExts, 'riv']`), which it resolves
  // by its asset rule, scale variants and all.
  const assetExts = metro ? metroAssetExts(baseDir, host) : METRO_ASSET_EXTS
  // The resources the app imports that are no asset of Metro's are no module of Metro's, which can't
  // resolve one: one reaches the build only as a transform's input, read and inlined by a Babel plugin
  // (`require('./messages.po')`, @exodus/i18n's plugin-inline-po), as the Metro plugin records it
  // (`metro`, no edge): no edge to one, and no asset registry for one.
  const isTransformInput = (abs, info) => metro && info?.resource === true && !isMetroAssetFile(abs, assetExts)
  // A round of a lazy tree that asked for a package already is void (vfs-bundle/lazy.js): it reads
  // on, for all else it asks for, but reports and refuses nothing, which the round that asks for
  // none does, and stops before it reads the files in.
  const voided = () => Boolean(memo) && host.touches() > 0
  // Scan from `roots` with `options`, keeping what lies within the root (one the entries link eagerly
  // is refused, see withinRoot), its issues reported under `label`, by which a lazy tree's `memo`
  // keeps what each of its scans read. -> { scanner, leftOut }
  const scanWithin = (roots, options, label) => {
    const { scanner, outside, leftOut } = withinRoot(scan(roots, { ...options, memo: memo ? nestedMap(memo, label) : null }), (url) => relWithin(pathOf(url)) !== null)
    for (const url of outside) toRel(pathOf(url))
    if (!voided()) reportScanIssues({ ...analyzeScanner(scanner, { baseDir }), leftOut }, { baseDir, label, root: ' at .' })
    return { scanner, leftOut }
  }
  for (const platform of platforms) {
    // What each resolves, kept across a lazy tree's rounds where it read nothing not unpacked yet.
    const keptFor = (label) => (memo ? nestedMap(memo, `${label} ${platform ?? '*'}`) : undefined)
    const field = fieldResolverFor(platform, { mainFields, metro, assetExts, conditions: scanConditions, typescript, typescriptPaths, host, kept: keptFor('resolutions') })
    const { extras } = field
    // --metro --metro-resolver delegates to the project's own metro-resolver for byte-for-byte Metro
    // fidelity; otherwise the built-in field/suffix resolver reproduces it. metro-resolver derives
    // default/require|import/platform conditions itself, so it takes only the extra `react-native`
    // condition (browser comes from its per-platform map, keyed on `web`).
    const resolver = metroResolver
      ? createMetroResolver({ projectDir: baseDir, platform, sourceExts: SOURCE_EXTS, mainFields, conditionNames: ['react-native'], assetExts, host })
      : field.resolver
    // Without --typescript, the field resolver --typescript would build names the file a miss would
    // land on: a hint in the unresolved report, never an edge (see Scan#typescriptCandidate).
    const typescriptResolve = typescript || metroResolver ? null : fieldResolverFor(platform, { mainFields, metro, assetExts, conditions: scanConditions, typescript: true, typescriptPaths, host, kept: keptFor('typescript resolutions') }).resolver
    // --babel: a specifier the project's babel-plugin-module-resolver rewrites resolves as rewritten,
    // as Metro resolves it after Babel; its edge stays keyed by the specifier the source holds.
    const aliases = babel ? createBabelAliases({ projectDir: baseDir, platform }) : fileAliases
    // --babel: and whether it keeps a TypeScript import listing types alone (onlyRemoveTypeImports).
    const keepsTypeImports = babel ? createBabelTypeImportsKept({ projectDir: baseDir, platform }) : null
    const aliased = (resolveFn) => (aliases && resolveFn ? (file, spec, conds) => resolveFn(file, aliases(file, spec) ?? spec, conds) : resolveFn)
    // --metro: built through Babel, which erases an import listing types alone (Scan's `babel`).
    const scanOptions = { conditions: extras, resolve: aliased(resolver), typescriptResolve: aliased(typescriptResolve), jsx, flow, resources: resourceSet, define, babel: metro, keepsTypeImports, host }
    const platformKey = platform ?? '*' // '*' is a private placeholder for the single mainFields pass; it never unflattens
    // Record what scanning from `roots` reaches: its files, their formats and edges. -> its scanner
    const absorb = (roots) => {
      const { scanner, leftOut } = scanWithin(roots, scanOptions, platform ?? 'mainFields')
      leftOutEdges.push(...leftOut)
      for (const [url, info] of scanner.files) {
        const abs = pathOf(url)
        const rel = toRel(abs)
        reached.add(abs)
        if (info.resource) resourceRels.add(rel)
        // Under --metro a code file has no format, as the Metro plugin records it: Metro transforms
        // it from source, and Node's module/commonjs isn't what it runs. But the one its name alone
        // gives it (.json, .mjs, .cjs: nodeExtFormat), as Node loads it too.
        formatsByRel.set(rel, metro && !info.resource ? nodeExtFormat(abs) : info.format)
        for (const e of info.edges) {
          if (e.builtin || e.dynamic) continue
          let target
          if (e.empty) { usesEmpty = true; target = emptyTarget }
          else if (e.child) target = toRel(pathOf(e.child))
          else continue // unresolved (already warned/thrown by reportScanIssues)
          // A transform's input is no dependency of Metro's: the import is gone before Metro sees it.
          if (e.child && isTransformInput(pathOf(e.child), scanner.files.get(e.child))) continue
          nestedMap(nestedMap(edges, rel), e.spec).set(platformKey, target)
        }
      }
      return scanner
    }
    const scanner = staged('scan', () => absorb(absEntries))
    // --metro: and what Babel and Metro add, which the source doesn't import, carried as Metro's code
    // and scanned for what each imports in turn; one above the root, passed over, as the Metro plugin
    // passes one over.
    if (metro) {
      const metroAt = performance.now()
      const code = [...scanner.files].filter(([, info]) => !info.resource).map(([url]) => pathOf(url))
      const assets = [...scanner.files].filter(([url, info]) => info.resource && !isTransformInput(pathOf(url), info)).map(([url]) => pathOf(url))
      // As a require(): Babel's CommonJS transform makes one of each it adds, as Metro writes its own.
      const required = new Set(['require', 'default', ...extras])
      // And each asset's files Metro reads to build its module (`scales`, `hash`) and copies out with
      // it, its other scales (`logo@2x.png`, `logo@3x.png`), by the name Metro reads it by (one linked
      // in, its target's bytes; one linked from outside the root passed over, as the Metro plugin
      // passes it over): no import names one, so no edge, carried as the asset is.
      const scales = assets.flatMap((file) => metroAssetFiles(file, platform, host)).filter((file) => relWithin(host.realpath(file)) !== null)
      const dynamicImports = [...scanner.files.values()].some((info) => !info.resource && info.edges.some((e) => e.kind === 'dynamic-import'))
      const kept = keptAcross(`Metro's additions ${platformKey}`, host, memo)
      const added = [...new Set([...metroInsertedFiles(code, { assets, baseDir, babelled, dynamicImports, jsx, resolver: aliased(resolver), platformResolver: resolver, conditions: required, host, kept }), ...scales])]
        .filter((file) => !scanner.files.has(pathToFileURL(file).toString()) && relWithin(file) !== null)
      stageTimes.metro += performance.now() - metroAt
      if (added.length > 0) staged('scan', () => absorb(added))
    }
  }

  // One platform leaving out an edge another resolves within the root is a split too: collapsed
  // below, the edge would serve that platform the other's file in its place.
  if (!voided()) refuseSplit(leftOutEdges.filter((e) => edges.get(toRel(pathOf(e.parentURL)))?.has(e.spec)), baseDir)

  // --metro: and the project's configs a React Native build loads, though nothing the app imports
  // reaches them: Metro's and the React Native CLI's, and with --babel or --babel-aliases the Babel
  // config Metro's transformer runs; and the toolchain Metro loads by name (METRO_TOOLCHAIN, and
  // under either BABEL_TOOLCHAIN), as Node resolves a require() of it from the package naming it, else
  // from the project. Node loads each, not Metro, so each is traced as a Node entry is
  // (buildJsBundle): with all it imports, resolved as Node resolves it, each file in the format Node
  // loads it in, which one the app's build reaches too keeps (Metro needs none).
  // Their edges, each under the conditions Node resolves it with, as the Metro plugin's run records
  // them (Node's loader keys every edge so), apart from Metro's under '*' in a file both reach, though
  // they agree: under '*', they'd be none of the edges the run records.
  // conditions key -> parentRel -> specifier -> targetRel, beside the bundle's '*' edges.
  const keyedResolutions = new Map()
  // The edges from `parent` (rel) keyed `key`: specifier -> targetRel.
  const keyedFrom = (key, parent) => nestedMap(nestedMap(keyedResolutions, key), parent)
  // The configs' edges some context misses or leaves out: `${parentRel}\0${specifier}` -> the miss.
  const configMissed = new Map()
  // The files the configs reach (rel), and of them those the app's build doesn't: the bundler's,
  // attributed to `bundle`, not to `bundle:metro` with the app's source Metro bundles.
  const configReached = new Set()
  const configOnly = new Set()
  const configsAt = performance.now()
  if (metro) {
    const configs = [...METRO_CONFIG_FILES, ...(babelled ? [BABEL_CONFIG_FILE] : [])].map((rel) => join(baseDir, rel)).filter((abs) => host.stat(abs)?.isFile())
    // A METRO_TOOLCHAIN entry's file. -> absolute path, or undefined
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
    // And the React Native configs of the app's packages, which React Native's CLI requires as it
    // loads its own (`react-native config`'s packages, read as data).
    // Each by its real path, as Node loads it (a pnpm install's package linked into node_modules
    // requires what lies beside it in the store).
    for (const dir of probing(host, () => linkedPackages(baseDir, host))) {
      const file = join(dir, 'react-native.config.js')
      if (!probing(host, () => host.stat(file)?.isFile())) continue
      const real = host.realpath(file)
      if (relWithin(real) !== null) configs.push(real)
    }
    // Trace `roots` as Node entries, recording what they reach. -> the scan
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
      for (const u of [...scanner.unresolved, ...leftOut]) {
        if (u.spec !== undefined) configMissed.set(`${toRel(pathOf(u.parentURL))}\0${u.spec}`, u)
      }
      for (const [key, byParent] of scanner.imports) {
        for (const [parentURL, specs] of byParent) {
          const keyed = keyedFrom(key, toRel(pathOf(parentURL)))
          for (const [spec, childURL] of specs) keyed.set(spec, toRel(pathOf(childURL)))
        }
      }
      return scanner
    }
    const traced = configs.length > 0 ? traceNode(configs) : null
    // And the transformers of stasis's Metro plugin beside it, where a config requires it, in turn.
    const transformers = [...(traced?.files.keys() ?? [])].map((url) => pathOf(url))
      .filter((file) => basename(file) === 'metro.js' && basename(dirname(file)) === 'src' &&
        readJson(join(dirname(dirname(file)), 'package.json'), host)?.name === '@exodus/stasis-plugins')
      .flatMap((file) => STASIS_METRO_TRANSFORMERS.map((name) => join(dirname(file), name)))
      .filter((file) => host.stat(file)?.isFile() && relWithin(file) !== null && !traced.files.has(pathToFileURL(file).toString()))
    if (transformers.length > 0) traceNode(transformers)
    // And the plugins and presets the Babel config names, which @babel/core requires by name: as each
    // module the config reaches names them, in `plugins` and `presets` where it is the project's own or a
    // Babel config's by its name (isBabelConfigModule), and anywhere, by their form, where it is a Babel
    // config's. Each resolved as @babel/core resolves it, from the config's directory, else from the
    // module naming it, a path from either; and what each reaches, in turn. And what any module it
    // reaches (a plugin's own too) names by `require.resolve('x')`, which Babel loads: a plugin running
    // Babel with plugins of its own (react-native-reanimated's, `require.resolve('@babel/plugin-…')`),
    // with the edge Node's resolution makes, under the conditions it resolves with.
    const babelConfig = pathToFileURL(join(baseDir, BABEL_CONFIG_FILE)).toString()
    // What each file names, read once across a lazy tree's rounds (keptAcross).
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
          if (info.resource || !JS_EXTS.has(extname(file))) continue
          for (const [spec, target] of resolutionsOf(file, () => requireResolutions(file, host))) {
            if (!JS_EXTS.has(extname(target)) || relWithin(target) === null) continue
            named.add(target)
            // A specifier keeps one edge, the first recorded, as a run records a resolution only where no
            // edge is: one the module also require()s keeps that edge, Node's loader's (traced, so
            // recorded, before the module is read), and one resolved again in other `paths` its first.
            // Every copy they find (`require.resolve('x', { paths })` another than `require('x')`) is
            // still traced.
            const keyed = keyedFrom(REQUIRE_KEY, rel)
            if (!keyed.has(spec)) keyed.set(spec, toRel(target))
          }
          const configModule = isBabelConfigModule(rel)
          if (!configModule && splitNodeModulesPath(rel)) continue
          for (const name of namedOf(`${configModule}\0${file}`, () => babelNamedModules(file, host, { anyString: configModule }))) {
            const found = resolveNamed(name, file)
            if (found !== undefined && JS_EXTS.has(extname(found)) && relWithin(found) !== null) named.add(found)
          }
        }
        const fresh = [...named].filter((file) => !files.has(pathToFileURL(file).toString()))
        if (fresh.length > 0) for (const [url, info] of traceNode(fresh).files) files.set(url, info)
        frontier = [...named].map((file) => pathToFileURL(file).toString())
      }
    }
    // And the files of the toolchain the Metro plugin carries for every build, which nothing here
    // reaches (AUTO_INCLUDES): setup_env.sh, which React Native's CLI runs as each command of it starts.
    // As the plugin resolves and tags each: from the project, by the shared classifier, a resource
    // where it names no format.
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

  // Read each reached file once: bytes for the bundle, integrity for the lockfile. Source is
  // stored as UTF-8 text, so non-UTF-8 bytes would diverge from the hashed bytes -- reject them.
  const sources = new Map()
  const integrities = new Map()
  // Carry `rel`: `content` in the bundle as `format`, the integrity of its bytes `buf` in the lockfile.
  const put = (rel, content, format, buf) => {
    sources.set(rel, content)
    formatsByRel.set(rel, format)
    integrities.set(rel, sha512integrity(buf))
  }
  // A resource carries bytes, not source: UTF-8 verbatim or base64 when binary, tagged with the
  // byte-derived format (here and in the --metro native capture below).
  const putResource = (rel, buf) => (isUtf8(buf) ? put(rel, buf.toString('utf8'), 'resource', buf) : put(rel, buf.toString('base64'), 'resource:base64', buf))
  // Code carries its source, UTF-8 (`what` it is, refused where it isn't).
  const putCode = (rel, buf, format, what = 'JS bundle source') => {
    if (!isUtf8(buf)) throw new Error(`${what} is not valid UTF-8: ${rel}`)
    put(rel, buf.toString('utf8'), format, buf)
  }
  const realBase = host.realpath(baseDir)
  // Metro's empty module is carried as the file it is, a code file of Metro's (no format).
  if (usesEmpty && metroEmpty !== null) reached.add(metroEmpty)
  for (const abs of reached) {
    const rel = toRel(abs)
    // Security: a resolved file arrives by its real path, which toRel already holds to the root,
    // but an entry is taken as spelled (and --metro-resolver keeps a path it can't realpath), so an
    // in-tree-named symlink escaping the root would slip past toRel's textual check -- realpath and
    // fail closed.
    assertRealPathWithinBase(realBase, baseDir, rel, host)
    const buf = host.readFile(abs)
    // A code file's format is the scan's.
    if (resourceRels.has(rel)) putResource(rel, buf)
    else putCode(rel, buf, formatsByRel.get(rel))
  }
  if (usesEmpty && metroEmpty === null) {
    // Refuse to shadow a real reached file sitting at the reserved empty-module path.
    if (formatsByRel.has(EMPTY_MODULE_PATH)) {
      throw new Error(`Bundle needs the reserved empty-module path ${EMPTY_MODULE_PATH}, but the project has a real file there`)
    }
    put(EMPTY_MODULE_PATH, '', metro ? undefined : 'commonjs', Buffer.alloc(0))
  }

  // The package a bundled file is in (findPackageMetadata: its pkgDir and identity, null where no
  // manifest names one), memoized per directory so a package's many files don't each re-walk to it.
  const packageOf = packageLookup(baseDir, { host })

  // --metro also carries the native build inputs of each native package the app links, as the Metro
  // plugin does: the bundled packages installed or linked into node_modules, and those React Native
  // links unimported. Native source is stored as code under a language tag; other assets as
  // 'resource'/'resource:base64'.
  if (metro) {
    const pkgDirs = new Map() // package dir -> its package's name
    // Follow the CODE/module graph only: a package reached solely for an asset (--resources) is
    // not a linked native dependency, so it must not drag in its ios/android surface. Nor is one
    // only the configs reach, which Node runs at build time, as the Metro plugin's graph holds none.
    const isCode = (rel) => !resourceRels.has(rel)
    for (const abs of reached) {
      const rel = toRel(abs)
      const nm = isCode(rel) && !configOnly.has(rel) && splitNodeModulesPath(rel)
      if (nm) pkgDirs.set(nm.dir, nm.name)
    }
    // A package linked into node_modules from out of it (a workspace package) is reached by its real
    // path, out of node_modules, but is a dependency all the same, however an import reaches it (by
    // name or alias, through a browser/react-native map, by a relative path): one linked, under any
    // name, into a node_modules its importer finds packages in (the directories the resolver looks
    // in). One linked nowhere there is the project's own source.
    const linksIn = new Map() // directory -> Set of the real package dirs linked into a node_modules it finds packages in
    const linkedFrom = (dir) => {
      let links = linksIn.get(dir)
      if (links !== undefined) return links
      const parent = dirname(dir)
      links = new Set(parent === dir ? [] : linkedFrom(parent))
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
            // A scope holds packages, a directory or a link to one (a whole scope linked, where
            // every package in it is reached through the link).
            for (const scoped of listing(abs, host)) {
              if (ent.isSymbolicLink() || scoped.isSymbolicLink()) link(join(abs, scoped.name))
            }
          } else if (ent.isSymbolicLink()) {
            link(abs)
          }
        }
      }
      linksIn.set(dir, links)
      return links
    }
    for (const [parent, bySpec] of edges) {
      for (const byPlatform of bySpec.values()) {
        for (const target of byPlatform.values()) {
          if (!isCode(target) || splitNodeModulesPath(target)) continue
          const links = linkedFrom(dirname(join(baseDir, parent)))
          // The linked root holding the target, nearest first: its entry may lie below a manifest of
          // its own (a named dist/package.json), as a node_modules path names the package it's in.
          let root = posix.dirname(target)
          while (root !== '.' && !links.has(root)) root = posix.dirname(root)
          // The project's own source isn't a dependency, nor is an import within the package itself.
          if (root === '.' || parent.startsWith(`${root}/`) || pkgDirs.has(root)) continue
          // Named by its own manifest, whatever name it's linked under.
          pkgDirs.set(root, readPackageJson(baseDir, `${root}/package.json`, { host })?.name)
        }
      }
    }
    // And the app's packages React Native links whether JS imports them or not (`react-native config`'s
    // list, read as data), by their real path, but one above the root, which the plugin passes over too.
    for (const dir of probing(host, () => linkedNativePackages(baseDir, host))) {
      const rel = relWithin(host.realpath(dir))
      if (rel !== null && !pkgDirs.has(rel)) pkgDirs.set(rel, readPackageJson(baseDir, `${rel}/package.json`, { host })?.name)
    }
    // Each one's native build inputs, walked whole (nativeInputs, shared with the plugin), read only
    // once its real path is held to the root.
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
      // react-native core isn't a Pod (config reports it via reactNativePath, not `dependencies`),
      // but its native source (React/, ReactCommon/, ReactAndroid/, ...) is walked all the same.
      const isRnCore = name === 'react-native'
      if (!isRnCore && !probing(host, () => looksNative(pkgAbs, nativeFs))) continue
      for (const { file, source, action, format } of nativeInputs(pkgAbs, nativeFs, { resources: resourceSet, skip: (abs) => sources.has(toRel(abs)) })) {
        if (action === 'code') putCode(toRel(file), source, format, 'native source')
        else putResource(toRel(file), source)
      }
      // RN core's `.js` build scripts the classify loop skips (Metro-owned by extension, but never in
      // the graph): force-include as code so the podspec/Ruby that invokes them at pod-install resolves.
      if (isRnCore) {
        for (const file of RN_CORE_INCLUDE_FILES) {
          const abs = join(pkgAbs, file)
          if (host.stat(abs) === null || sources.has(toRel(abs))) continue
          putCode(toRel(abs), nativeFs.readFile(abs), packageType(abs, host) === 'module' ? 'module' : 'commonjs', 'native source')
        }
      }
    }
  }

  // --package-json (or the config's packageJSON): fold each bundled module's package.json into
  // `sources` (and its integrity into the companion lockfile) even when the scan never reached it,
  // and the nearer one a reached file of it has (scopeManifestOf: a `{"type":"module"}` marker such
  // as `esm/package.json`), which Metro's resolver reads for the file, as the State path does.
  // Buckets are the ones assembleCodeBundle derives, from the same `packageOf` (its pkgDir, else the
  // '.' workspace bucket). readModuleManifest applies the read/validate rules shared with the State
  // path (containment, UTF-8-aborts); no identity check here -- these buckets are all fresh from disk.
  if (withManifests) {
    const found = new Map()
    const exists = (rel) => found.get(rel) ?? found.set(rel, packageJSONStat(host, join(baseDir, rel))?.isFile() ?? false).get(rel)
    const manifests = new Map() // manifest -> the reached files it serves
    for (const abs of reached) {
      const rel = toRel(abs)
      const pkgDir = packageOf(rel)?.pkgDir ?? (splitNodeModulesPath(rel) ? undefined : '.')
      if (pkgDir === undefined) continue
      for (const manifest of [moduleFileKey(pkgDir, 'package.json'), scopeManifestOf(rel, pkgDir, exists)]) {
        if (manifest !== undefined) (manifests.get(manifest) ?? manifests.set(manifest, []).get(manifest)).push(rel)
      }
    }
    for (const [rel, of] of manifests) {
      if (sources.has(rel)) continue
      const buf = readModuleManifest({ baseDir, realBase, rel, host })
      if (!buf) continue
      put(rel, buf.toString('utf8'), 'json', buf)
      // Attributed as the files it serves are, as State#includePackageJson attributes one.
      if (of.some((file) => configReached.has(file))) configReached.add(rel)
      if (of.every((file) => configOnly.has(file))) configOnly.add(rel)
    }
  }

  // Collapse each edge: one distinct target across platforms -> flat string; else a sorted Map<platform, target>.
  const resolutions = new Map()
  for (const [parent, bySpec] of edges) {
    const specMap = new Map()
    for (const [spec, byPlatform] of bySpec) {
      const distinct = new Set(byPlatform.values())
      specMap.set(spec, distinct.size === 1 ? [...distinct][0] : new Map([...byPlatform].toSorted((a, b) => (a[0] < b[0] ? -1 : 1))))
    }
    resolutions.set(parent, specMap)
  }
  // A config's import Node misses or leaves out in a context, from a file the app's build reaches
  // too, where Metro resolves it: no miss is recorded, so the app's edge under '*' would serve that
  // context Metro's file in its place -- refused, as refuseSplit refuses a split.
  for (const [key, { parentURL, spec }] of configMissed) {
    if (!resolutions.get(key.slice(0, key.indexOf('\0')))?.has(spec)) continue
    throw new Error(
      `${spec} from ${displayPath(parentURL, baseDir)} resolves under Metro, for the app, and not under Node, for the ` +
      "project's configs: a bundle can't keep Node's miss without serving Node Metro's file in its place"
    )
  }

  const rootPkg = readJson(join(baseDir, 'package.json'), host) ?? {}
  const assembled = assembleCodeBundle({
    baseDir,
    entries: normalized,
    sources,
    resolutions,
    keyedResolutions,
    formats: formatsByRel,
    workspaceName: rootPkg.name ?? 'workspace',
    workspaceVersion: rootPkg.version ?? '0.0.0',
    conditionKey: '*',
    host,
    packageOf,
    consumer: metro ? 'bundle:metro' : 'bundle',
    consumerFiles: [...sources.keys()].filter((rel) => !configOnly.has(rel)),
  })
  // What the configs reach is the bundler's, not the app's: `bundle`, as a Node build's files are.
  const bundle = configReached.size === 0 ? assembled : assembled.withReason('bundle', [...configReached])

  // The companion lockfile mirrors the bundle, swapping file content for its integrity.
  stageTimes.carrying += performance.now() - carryingAt
  return { bundle, lockfile: Lockfile.fromBundle(bundle, (file) => integrities.get(file)) }
}

// Classify entries into their single shared language and check option applicability; `name` prefixes
// errors. A directory entry (resolved against `cwd`, on `host`) stands for the .sol files under it: Solidity only.
// `partial`: the options may yet be completed by a stasis.config.json entry's (configuredBuilds), so
// what one needs of another one there could set (`--platforms` of `--metro`) is left to the build.
function classifyEntries(name, { cwd = process.cwd(), entries, mappingFile, manifests, scope, lockfile, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests, host = diskHost, fetched, partial = false }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`${name}: at least one entry file is required`)
  }
  const dirError = directoryEntryError(entries, cwd, host, { fetched })
  if (dirError !== null) throw new Error(`${name}: ${dirError}`)
  let kind
  if (entries.every((e) => isSolidityEntry(e, cwd, host))) kind = 'sol'
  else if (entries.every((e) => e.endsWith('.php'))) kind = 'php'
  else if (entries.every((e) => JS_EXTS.has(extname(e)))) kind = 'js'
  else if (entries.every((e) => BASH_EXTS.has(extname(e)))) kind = 'bash'
  else if (entries.every((e) => RUST_EXTS.has(extname(e)))) kind = 'rust'
  else {
    throw new Error(`${name}: entries must all be .sol, all be .php, all be .js/.cjs/.mjs/.ts/.cts/.mts/.jsx/.tsx, all be .sh/.bash, or all be .rs (no mixing)`)
  }
  if (mappingFile && kind !== 'sol') {
    throw new Error(`${name}: --mapping is only valid for .sol bundles`)
  }
  // --manifests carries the Solidity build's description files (foundry.toml, remappings.txt, ...).
  if (manifests && kind !== 'sol') {
    throw new Error(`${name}: --manifests is only valid for .sol bundles`)
  }
  // --cargo runs `cargo metadata` for the Rust feature/dependency resolution and the --cargo-*
  // flags steer that resolution; nothing else reads Cargo.
  if (kind !== 'rust') {
    const given = { cargo, 'cargo-features': Array.isArray(cargoFeatures) && cargoFeatures.length > 0, 'cargo-no-default-features': cargoNoDefaultFeatures, 'cargo-all-features': cargoAllFeatures, 'cargo-target': cargoTarget, 'cargo-manifests': cargoManifests }
    for (const [flag, on] of Object.entries(given)) if (on) throw new Error(`${name}: --${flag} is only valid for Rust bundles`)
  }
  if (scope !== undefined && kind !== 'js') {
    throw new Error(`${name}: --scope is only valid for JS bundles`)
  }
  if (lockfile !== undefined && kind !== 'js') {
    throw new Error(`${name}: --lockfile is only valid for JS bundles`)
  }
  // Reject --conditions for non-JS: their resolvers don't consult exports/imports conditions, so it would silently do nothing.
  if (Array.isArray(conditions) && conditions.length > 0 && kind !== 'js') {
    throw new Error(`${name}: --conditions is only valid for JS bundles`)
  }
  // --flow strips Flow type syntax before the JS parser; the non-JS loaders never parse with oxc.
  if (flow && kind !== 'js') {
    throw new Error(`${name}: --flow is only valid for JS bundles`)
  }
  // --typescript maps JS-output specifiers to their on-disk TS sources; only the JS resolvers do it.
  if (typescript && kind !== 'js') {
    throw new Error(`${name}: --typescript is only valid for JS bundles`)
  }
  // --tsconfig names the config whose `paths` aliases --typescript honours; meaningless without it.
  if (tsconfig !== undefined && !typescript && !partial) {
    throw new Error(`${name}: --tsconfig is only valid with --typescript`)
  }
  // --resources carries allowlisted assets reached through the JS import graph; JS-only. The list
  // is validated (parseResourcesOption) in the builders, but reject a code extension here too so a
  // typo surfaces with the command name rather than deep in the scan.
  if (Array.isArray(resources) && resources.length > 0) {
    if (kind !== 'js') throw new Error(`${name}: --resources is only valid for JS bundles`)
    parseResourcesOption(name, resources)
  }
  // --mainFields and --metro/--platforms are legacy-/platform-resolution knobs; JS-only.
  if (mainFields !== undefined && kind !== 'js') {
    throw new Error(`${name}: --mainFields is only valid for JS bundles`)
  }
  // --jsx toggles the scanner's JSX parsing for the .js family (.jsx/.tsx need no flag); only JS
  // entries are scanned.
  if (jsx && kind !== 'js') {
    throw new Error(`${name}: --jsx is only valid for JS bundles`)
  }
  // --define folds the globals it gives in the JS scan's branch tests; no other language is scanned for them.
  if (parseDefine(name, define).size > 0 && kind !== 'js') {
    throw new Error(`${name}: --define is only valid for JS bundles`)
  }
  // --package-json folds each bundled module's npm package.json in; JS-only (the sol/php/bash/rust
  // bucketizers group by their own ecosystems' manifests, not an npm package.json).
  if (packageJSON && kind !== 'js') {
    throw new Error(`${name}: --package-json is only valid for JS bundles`)
  }
  if ((metro || (Array.isArray(platforms) && platforms.length > 0)) && kind !== 'js') {
    throw new Error(`${name}: --metro is only valid for JS bundles`)
  }
  // --metro presets conditions + mainFields + platform suffixes, so it can't combine with
  // explicit --conditions/--mainFields and requires --platforms; --platforms is meaningless without it.
  if (metro) {
    if (Array.isArray(conditions) && conditions.length > 0) {
      throw new Error(`${name}: --conditions can't be combined with --metro (it sets its own conditions)`)
    }
    if (mainFields !== undefined) {
      throw new Error(`${name}: --mainFields can't be combined with --metro (it sets its own mainFields)`)
    }
    if ((!Array.isArray(platforms) || platforms.length === 0) && !partial) {
      throw new Error(`${name}: --metro requires --platforms (e.g. --platforms=ios,android)`)
    }
    // A platform name becomes an edge key: reject '/' (Bundle/Lockfile parse refuse it) and
    // the reserved '*' placeholder, so the writer never emits a map the readers reject.
    for (const p of Array.isArray(platforms) ? platforms : []) {
      if (typeof p !== 'string' || p.length === 0 || p === '*' || p.includes('/')) {
        throw new Error(`${name}: invalid platform '${p}' (a platform name can't be empty, contain '/', or be '*')`)
      }
    }
  } else if (Array.isArray(platforms) && platforms.length > 0 && !partial) {
    throw new Error(`${name}: --platforms is only valid with --metro`)
  }
  // --metro-resolver swaps in the project's real metro-resolver; it only means something under --metro.
  if (metroResolver && !metro) {
    throw new Error(`${name}: --metro-resolver is only valid with --metro`)
  }
  // --babel takes the import aliases of the project's Babel config, which Metro runs; not otherwise.
  if (babel && !metro) {
    throw new Error(`${name}: --babel is only valid with --metro`)
  }
  // --babel-aliases takes the same aliases from a JSON file instead, so the two don't combine.
  if (babelAliases !== undefined) {
    if (typeof babelAliases !== 'string' || babelAliases === '') throw new TypeError(`${name}: babelAliases must be a path to a JSON file`)
    if (!metro && !partial) throw new Error(`${name}: --babel-aliases is only valid with --metro`)
    if (babel) throw new Error(`${name}: --babel-aliases can't be combined with --babel (both set the import aliases)`)
  }
  // metro-resolver has no TS extension substitution, so --typescript would silently not apply -- reject it.
  if (typescript && metroResolver) {
    throw new Error(`${name}: --typescript is not supported with --metro-resolver (the project's metro-resolver doesn't substitute .js -> .ts)`)
  }
  // The field resolver always emits full-scope: a narrower --scope, or one from stasis.config.json,
  // would be silently ignored -- reject it here, before anything is built (or fetched).
  if (mainFields !== undefined || metro) fieldBuildOptions(name, { cwd, scope, resources, host })
  return kind
}

// A JS bundle as `stasis bundle` builds it: by the legacy-field resolver with `mainFields` or
// `metro`, whose per-platform edges and synthetic empty module a State can't hold, else through a
// State, which detects the bundle's repo itself. `root` is the directory the bundle's paths are
// relative to: cwd for the resolver's, the State's root for the State's. `extra` and `outputsAt` are
// buildJsBundle's, for the State's alone (see withExtra).
// -> { bundle, lockfile: () => Lockfile, stateBuilt, root }
async function buildJs({ mainFields, platforms, metro, metroResolver, babel, babelAliases, innermostRoot, extra, outputsAt, ...options }) {
  if (metro || mainFields !== undefined) {
    const built = await buildResolvedJsBundle({ ...options, mainFields: metro ? METRO_MAIN_FIELDS : mainFields, platforms: metro ? platforms : [null], metro: Boolean(metro), metroResolver: Boolean(metroResolver), babel: Boolean(babel), babelAliases })
    return { bundle: built.bundle, lockfile: () => built.lockfile, stateBuilt: false, root: resolve(options.cwd) }
  }
  const state = await buildJsBundle({ ...options, innermostRoot, extra, outputsAt })
  const bundle = state.sourceBundle
  // Stamp the `bundle` consumer (the static build carries none), unless `extra` added files: then
  // the State attributes each file, to `bundle` or `extra`.
  return { bundle: bundle.reason === undefined ? bundle.withReason('bundle') : bundle, lockfile: () => state.lockfile, stateBuilt: true, root: state.root }
}

// `built` (buildOfKind's, built in `cwd` without a State, or the union of bundleCommand's `builds` rooted there) with the files the stasis.config.json
// there names in `extra`, as `stasis add` adds them (extraArtifacts), into its bundle and its
// lockfile; never one of `outputs` (the absolute paths the build writes), and resources by the
// build's `resources` where given, else by the config's. A State-built bundle takes them in its
// State instead, as `stasis run` does (State#includeExtra). The project is read through `host`,
// `name`'s.
function withExtra(built, cwd, { outputs = [], resources, host = diskHost, name = 'bundle' }) {
  const config = readConfigFile(name, cwd, host)
  const patterns = parseExtraOption(CONFIG_FILE, config?.extra)
  if (patterns.length === 0) return built
  // The union of `builds` (see bundleCommand) may be State-built in node_modules scope, which the
  // full-scope files `extra` adds can't join.
  if (built.bundle.config.scope !== 'full') throw new Error(`${name}: ${CONFIG_FILE}'s extra can't be added to a ${built.bundle.config.scope}-scope bundle of its entries`)
  const baseDir = resolve(cwd)
  const written = new Set(outputs.map((file) => toPosix(relative(baseDir, file))))
  const allowlist = resources === undefined ? parseResourcesOption(CONFIG_FILE, config.resources) : parseResourcesOption('--resources', resources)
  const added = extraArtifacts({ baseDir, patterns, resources: allowlist, bundle: built.bundle, outputs: written, host })
  if (added.bundle === null && added.carried.length === 0) return built
  // The files are the build's own, at its root, so they are where it was built: its `repo`, which a
  // merge with a side lacking one would drop.
  if (added.bundle !== null) added.bundle.repo = built.bundle.repo
  // Each file attributed: to the build's own consumer (`bundle`, or `bundle:metro`, as codeBundle
  // stamps it), `extra`, or both, for one `extra` names that the build carries itself.
  const merged = added.bundle === null ? built.bundle : built.bundle.merge(added.bundle)
  const bundle = added.carried.length === 0 ? merged : merged.withReason('extra', added.carried)
  const { lockfile } = built
  return { ...built, bundle, ...(lockfile && added.lockfile && { lockfile: () => lockfile().merge(added.lockfile) }) }
}

// The bundle of `kind` (classifyEntries') built from buildBundle's options, from disk, with the files
// stasis.config.json's `extra` names: a JS bundle's git dependencies at the commits their package
// managers' records name (pinInstalledCommits). `outputsAt(root)` are the absolute paths the build
// writes, given the root its paths are relative to.
// -> { bundle, lockfile: () => Lockfile, stateBuilt } (the last two of a JS bundle alone)
async function buildOfKind(kind, { cwd, env, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests, outputsAt = () => [], extra = true }) {
  const outputs = outputsAt(resolve(cwd))
  // Without `extra`, built as if the config named none (one of several builds of a bundle, see bundleCommand).
  const withExtraOf = (built, buildResources) => (extra ? withExtra(built, cwd, { outputs, resources: buildResources }) : built)
  if (kind === 'sol') return withExtraOf({ bundle: await buildSolidityBundle({ cwd, env, entries, mappingFile, manifests }) })
  if (kind === 'php') return withExtraOf({ bundle: await buildPhpBundle({ cwd, entries }) })
  if (kind === 'bash') return withExtraOf({ bundle: await buildBashBundle({ cwd, entries }) })
  if (kind === 'rust') return withExtraOf({ bundle: await buildRustBundle({ cwd, entries, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }) })
  let built = await buildJs({ cwd, env, entries, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, extra, outputsAt })
  if (!built.stateBuilt) built = withExtraOf(built, resources)
  pinInstalledCommits(built.bundle, built.root)
  return built
}

// Several builds' bundles (and lockfiles) as one, the i-th of `builts` built of `builds[i]` and
// rooted at `roots[i]`: their strict union, rooted where every one of them is.
function unionOfBuilds(name, builds, builts, roots) {
  const other = roots.findIndex((root) => root !== roots[0])
  if (other !== -1) {
    throw new Error(`${name}: ${builds[0].entries[0]} and ${builds[other].entries[0]} can't be bundled together: their bundles' paths are relative to different roots (${roots[0]} and ${roots[other]})`)
  }
  return builts.reduce((a, b) => ({ bundle: a.bundle.merge(b.bundle), lockfile: a.lockfile && (() => a.lockfile().merge(b.lockfile())) }))
}

// buildVfsBundle's checks of `options`, which hold before anything is fetched (`host` the
// project's, or an empty tree's with `fetched: false`): no metro-resolver, which reads the disk;
// `generate` only for JS.
// -> the kind of bundle its entries make
export function checkVfsOptions(name, options) {
  const kind = classifyEntries(name, options)
  if (options.metroResolver) throw new Error(`${name}: metroResolver is not supported`)
  // The project's Babel config is code, run from the disk.
  if (options.babel) throw new Error(`${name}: babel is not supported`)
  const { generate = [] } = options
  if (!Array.isArray(generate) || generate.some((step) => step !== 'prisma')) throw new TypeError(`${name}: generate must be an array of 'prisma'`)
  if (generate.length > 0 && kind !== 'js') throw new Error(`${name}: --generate is only valid for JS bundles`)
  return kind
}

// A bundle from the lockfile of the project held in `vfs` alone (@exodus/stasis/vfs-bundle), `cwd` a
// path there: buildBundle's JS options, resolved through the node_modules 'pnpm', 'yarn1' or 'npm'
// would install, or its Solidity options, through the dependencies folder 'soldeer' would install; with
// nothing read from disk but tarballs and zips, nor from the environment: a Solidity bundle is
// built with foundry.toml's default profile, whatever FOUNDRY_PROFILE or remappings one sets, and no
// EXODUS_STASIS_* setting is read. The entries the stasis.config.json in cwd names in its `entries`
// (every one, where none are given) are built with their options there, as `stasis bundle` builds
// them, but none that runs a program; an option given has to agree with theirs, one left out is
// theirs (configuredBuilds). The files its `extra` names are added as `stasis bundle` adds them,
// globbed in the Vfs as Node globs the disk (vfs-bundle/glob.js), which needs the optional minimatch.
// Where its `installDevDependencies` is false, what devDependencies alone reach is left out of the
// tree, as the package manager's production install leaves it out.
// `repo`, the informational `{ github, directory, commit }`,
// is the Bundle's, over what is detected in the Vfs as `stasis bundle` detects it on disk. `os`,
// `cpu` and `libc` are loadNodeModules'. Without a `packageManager`, it is the one whose lockfile
// installs cwd, where only one's does. `innermostRoot` is buildJsBundle's, for a JS bundle built
// through a State. `generate: ['prisma']` writes each project's Prisma Client into the laid-out
// tree before the scan, leaving `vfs` as it is (vfs-bundle/prisma.js). `client`, a
// @preventive/upstream/github.js client, is what a Soldeer git dependency is fetched through; without
// one, a soldeer.lock holding one is refused, naming deptree's `github`, before anything is fetched.
// `cache` is where npm packages' tarballs and version documents are kept (checkCache). Each
// dependency is recorded at the commit the tree installs it from, where deptree names one
// (pinCommits). `root` is the directory in the Vfs the bundle's paths are relative to: cwd, or for a
// JS bundle built through a State, the State's root, which is at or above it. With `lazy`, for pnpm
// and npm, the tree is laid out with nothing fetched, and each package is fetched and unpacked once
// the build reads under it, the build run again until it reads none it has not (vfs-bundle/lazy.js):
// the bundle the full tree gives, its warnings said once, with `stats` counting what is unpacked. A
// tarball the build never reaches is never fetched, nor held to the lockfile, nor refused. `stats`
// are deptree's, and `stats.unpacked` the packages unpacked: each one installed, or those a lazy
// tree unpacked.
// -> { bundle: Bundle, lockfile: Lockfile (of a JS bundle), stats, packageManager, root }
export async function buildVfsBundle({ vfs, ...options } = {}) {
  const { checkVfs, vfsHost } = await import('../vfs-bundle/tree.js')
  checkVfs('buildVfsBundle', vfs)
  return buildFromLockfile('buildVfsBundle', vfsHost(vfs), { ...options, vfs })
}

// buildVfsBundle's build, `name`'s, of the project `project` (a host, @exodus/stasis-core/host)
// reads: of a Vfs, which `vfs` is (for `generate` alone), or of the disk, for `stasis bundle
// --deptree`. As buildVfsBundle builds it, with `options` as it takes them, but for what bundleCommand
// gives besides (none of which buildVfsBundle takes): `builds`, where given, are the builds (each
// `{ entries, ...options }`) bundleCommand plans (bundle-options.js), in place of those
// configuredBuilds makes, `configured` where stasis.config.json's `entries` makes them, whose union's
// `extra` is then the bundle's, as bundleCommand adds it. `env` is what the builds read their
// settings from (none by default); `outputsAt(root)` the absolute paths written, which `extra` never
// takes; `why`, what a refusal to detect the package manager says it is detected for; with
// `refuseInstalled`, the project holding anything where the tree installs is refused, before
// anything is fetched (layOutTree).
async function buildFromLockfile(name, project, { vfs, packageManager, cwd = '/', packageManagerVersion, os, cpu, libc, repo, innermostRoot = false, generate = [], client, cache, lazy = false, ...options } = {}, { env = {}, builds: planned, configured: plannedFromConfig = false, outputsAt = () => [], why, refuseInstalled = false } = {}) {
  const { checkCache, checkKind, checkLazy, checkTarget, loadTree, packageManagerFor, packageManagerOf, pinCommits, treeHost, vfsHost } = await import('../vfs-bundle/tree.js')
  const { configuredBuilds } = await import('./bundle-options.js')
  const { checkGlob } = await import('../vfs-bundle/glob.js')
  checkTarget(name, { os, cpu, libc })
  checkCache(name, cache)
  if (typeof lazy !== 'boolean') throw new TypeError(`${name}: lazy must be a boolean`)
  // Checked as the Bundle checks it, before anything is fetched.
  if (repo !== undefined) repo = new Bundle({ repo }).repo
  // A real path, as every file the scan reaches is.
  cwd = project.realpath(posix.resolve('/', cwd))
  packageManager = packageManagerFor(name, project, cwd, { packageManager, packageManagerVersion, os, why })
  const pm = packageManagerOf(name, packageManager)
  if (lazy) checkLazy(name, packageManager)
  // The entries stasis.config.json's `entries` names, every one where none are given, each built
  // with its options there, which the options given agree with (configuredBuilds); else built with
  // the options given. Each build is checked with the options it is built with.
  const configured = planned === undefined ? configuredBuilds(name, { cwd, host: project, entries: options.entries, options }) : null
  const builds = planned ?? configured?.builds ?? [options]
  if (builds.length === 0) throw new Error(`${name}: no entries given, and ${CONFIG_FILE}'s entries name none`)
  // With the builds its `entries` make, `extra` is the bundle's, added once to their union, as
  // bundleCommand adds it; else the build's own, as buildOfKind adds it. That the Vfs can be globbed
  // for it is checked before anything is fetched (for a State rooted above cwd, where it reads the
  // config there).
  const bundleExtra = planned === undefined ? configured !== null : plannedFromConfig
  if (parseExtraOption(CONFIG_FILE, readConfigFile(name, cwd, project)?.extra).some((pattern) => !pattern.startsWith('!'))) checkGlob()
  const installDevDependencies = installsDevDependencies(name, cwd, project)
  for (const build of builds) checkKind(name, checkVfsOptions(name, { ...build, lockfile: options.lockfile, generate, cwd, host: project }), [packageManager])
  // Checked before anything is fetched: an entry out of what the tree installs is in the project
  // already. (A Solidity entry that is no .sol file is a directory, skipped where it is missing.)
  for (const entry of builds.flatMap((build) => build.entries)) {
    const abs = posix.resolve(cwd, entry)
    if (pm.kind === 'sol' && !abs.endsWith('.sol')) continue
    if (!posix.relative(cwd, abs).split('/').includes(pm.installs) && project.stat(abs) === null) throw new Error(`entry not found: ${abs}`)
  }
  const tree = await debugTimed(lazy ? 'Laid out the tree' : 'Installed the tree', () => loadTree({ project, packageManager, cwd, packageManagerVersion, os, cpu, libc, client, cache, lazy, installDevDependencies, refuseInstalled }))
  // What follows reads the tree through the hosts `hostOf` makes, of the project's host: once, or
  // for a lazy tree, in rounds, each reading into its `reads`, each build keeping what its scans read
  // across them in a memo of its own.
  const memos = tree.unpack === undefined ? undefined : builds.map(() => new Map())
  const attempt = async (reads) => {
    const hostOf = (outside) => treeHost(tree, outside, reads)
    let host = hostOf(project)
    if (generate.includes('prisma')) {
      const { generatePrismaClients, withPrismaClients } = await import('../vfs-bundle/prisma.js')
      const outputs = await generatePrismaClients({ host, root: tree.root, projects: tree.projects })
      if (outputs.length > 0) host = hostOf(vfsHost(withPrismaClients(vfs, outputs)))
    }
    const args = { cwd, host, env }
    const builts = []
    // A build of a round that asked for a package already is void, whatever it threw: the builds
    // after it are run all the same, for all else they ask for, and the round is set aside after.
    let voided
    for (const [i, build] of builds.entries()) {
      let built
      try {
        // eslint-disable-next-line no-await-in-loop -- one build at a time, in the order its warnings read
        built = pm.kind === 'sol' ? { bundle: await buildSolidityBundle({ ...build, ...args }), root: cwd } : await buildJs({ ...build, ...args, innermostRoot, extra: !bundleExtra, outputsAt, memo: memos?.[i] })
      } catch (error) {
        if (reads === undefined || reads.asked.size === 0) throw error
        voided ??= { error }
        continue
      }
      // Rooted at cwd, where `stasis bundle` detects its repo.
      if (repo === undefined && !built.stateBuilt) built.bundle.repo ??= detectRepo(cwd, host)
      builts.push(built)
    }
    if (voided !== undefined) throw voided.error
    // Merged as bundleCommand merges its builds.
    const { root } = builts[0]
    const union = unionOfBuilds(name, builds, builts, builts.map((built) => built.root))
    // Once: to the union, by the allowlist of the stasis.config.json at the root, as bundleCommand adds
    // it; else to the one build given, by its `resources`, as buildOfKind adds it, unless its State
    // took it. Never one of the files written (none, into a Vfs).
    return { root, ...bundleExtra || !builts[0].stateBuilt ? withExtra(union, root, { outputs: outputsAt(root), resources: bundleExtra ? undefined : builds[0].resources, host, name }) : union }
  }
  const since = counts()
  const built = tree.unpack === undefined
    ? await debugTimed('Built', () => attempt(), () => builtSince(since))
    : await import('../vfs-bundle/lazy.js').then(({ inRounds }) => inRounds(...debugging() ? reportedRounds(attempt, tree.unpack) : [attempt, tree.unpack]))
  const { bundle, lockfile, root } = built
  if (repo !== undefined) bundle.repo = repo
  pinCommits(bundle, root, tree)
  const unpacked = tree.lazy?.unpacked.size ?? tree.stats.installed ?? tree.stats.dependencies
  return { bundle, lockfile: lockfile?.(), stats: { ...tree.stats, unpacked }, packageManager, root }
}

// EXODUS_STASIS_DEBUG=1 or true.
export const debugging = () => process.env.EXODUS_STASIS_DEBUG === '1' || process.env.EXODUS_STASIS_DEBUG === 'true'

// The time a --metro build's stages took, all told, in milliseconds: its scans of what the app
// imports, what Metro and Babel add to it, the configs and toolchain, and carrying the files reached
// into the bundle. What EXODUS_STASIS_DEBUG says of each build.
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

// `run()`, said on stderr once what it gives settles where EXODUS_STASIS_DEBUG asks for it: `what`, in
// how long, and what `detail()` adds. Written, not warned: inRounds holds back what a round it sets
// aside warns. -> what `run()` gives
export async function debugTimed(what, run, detail = () => '') {
  if (!debugging()) return run()
  const at = performance.now()
  try {
    return await run()
  } finally {
    process.stderr.write(`[stasis] ${what} in ${seconds(performance.now() - at)}${detail()}\n`)
  }
}

// scanCounts and stageTimes as they are, for builtSince.
const counts = () => ({ files: { ...scanCounts }, stages: { ...stageTimes } })
const STAGES = { scan: 'scan', metro: "Metro's additions", configs: 'configs and toolchain', carrying: 'carrying' }

// What builds did since `since` (counts()'): the files their scans parsed, resolved again from a
// parse kept and took as kept, and the time of each stage they went through.
function builtSince(since) {
  const files = Object.keys(scanCounts).map((key) => `${scanCounts[key] - since.files[key]} ${key}`).join(', ')
  const times = Object.keys(STAGES).filter((key) => stageTimes[key] > since.stages[key]).map((key) => `${STAGES[key]} ${seconds(stageTimes[key] - since.stages[key])}`)
  return ` (files ${files}${times.length > 0 ? `; ${times.join(', ')}` : ''})`
}

// A package's name, as its directory in a tree says it: what follows its last node_modules.
const packageName = (dir) => dir.slice(dir.lastIndexOf('/node_modules/') + '/node_modules/'.length)

// `attempt` and `unpack` as inRounds takes them, each round said on stderr as it ends (debugTimed):
// what it built (builtSince), the packages it asked for, the first of them named, and how long
// unpacking them took.
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

// Programmatic equivalent of `stasis bundle`: build and return an in-memory Bundle without
// writing to disk. Files are attributed to the `bundle` consumer (`bundle:metro` with `metro`).
// Option applicability (--mapping|--manifests/.sol, --scope|--conditions|--mainFields|--metro|--jsx|
// --flow|--typescript|--define/JS) is enforced by classifyEntries. `define` gives globals their
// values (`{ __DEV__: false, 'process.env.NODE_ENV': 'production' }`), whose dead branches' imports
// are left out (see define.js).
export async function buildBundle({ cwd = process.cwd(), env = process.env, entries, mappingFile, manifests = false, scope, conditions, mainFields, platforms, metro, metroResolver, babel = false, babelAliases, jsx = false, flow = false, typescript = false, tsconfig, resources, define, packageJSON = false, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false, cargoTarget = null, cargoManifests = false } = {}) {
  const options = { cwd, env, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }
  return (await buildOfKind(classifyEntries('buildBundle', options), options)).bundle
}

// Run `stasis bundle`: build a brotli-compressed bundle and write it to `output`
// (stasis.code.br by default, `-` for stdout; the summary goes to stderr so it never
// interleaves with binary stdout). An optional JS `lockfile` attests every bundled file;
// with `--conditions` it attests the conditions-selected graph, so a plain
// `stasis run --lock=frozen` (which doesn't replay them) fails closed -- pair it with
// `--bundle=load` or replay the conditions. `add` unions the fresh build into the bundle
// already on disk (strict; a conflicting file throws) and can't target stdout. `builds`, in place
// of `entries` and the options building them, is several builds' (each `{ entries, ...options }`,
// as stasis.config.json's `bundle` gives an entry its own, see bundle-options.js), whose bundles
// (and lockfiles) are one's: their strict union, rooted where every one of them is.
// With `deptree`, the dependencies are not read from disk but laid out in memory from the lockfile
// that installs cwd, as buildVfsBundle lays them out (for JS, pnpm, yarn 1 or npm's; for Solidity,
// Soldeer's), and the rest of the project read from disk through them: refused where no lockfile
// of those installs cwd, or more than one does, and where the project holds anything where the tree
// installs (each project's node_modules, Soldeer's dependencies folder), before anything is fetched.
// The tarballs are fetched (or read from a cache that holds them, held to the lockfile all the same)
// and nothing is cached: nothing is written but the bundle and the lockfile. A Soldeer git
// dependency is fetched from GitHub with `env`'s GITHUB_TOKEN where it is set.
export async function bundleCommand({ cwd = process.cwd(), env = process.env, entries, mappingFile, manifests = false, output, scope, lockfile, conditions, mainFields, platforms, metro, metroResolver, babel = false, babelAliases, jsx = false, flow = false, typescript = false, tsconfig, resources, define, packageJSON = false, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false, cargoTarget = null, cargoManifests = false, brotliQuality, add = false, builds, deptree = false } = {}) {
  const options = { cwd, env, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }
  if (builds !== undefined) {
    if (!Array.isArray(builds) || builds.length === 0) throw new TypeError('bundleCommand: builds must be a non-empty array')
    const given = Object.entries(options).find(([key, value]) => !['cwd', 'env'].includes(key) && value !== undefined && value !== false && value !== null && !(Array.isArray(value) && value.length === 0))
    if (given) throw new TypeError(`bundleCommand: ${given[0]} can't be combined with builds (each build sets its own)`)
  }
  // Each build's options, the defaults above where it leaves one out.
  const plans = (builds ?? [{}]).map((build) => ({ ...options, ...build, cwd, env }))
  const kinds = plans.map((plan) => classifyEntries('bundleCommand', { ...plan, lockfile }))

  // --add has nothing to merge into on stdout (write-only).
  if (add && output === '-') {
    throw new Error('bundleCommand: --add cannot be combined with --output=- (nothing to merge into on stdout)')
  }

  // The files this build writes, never taken into `extra`, given the root its paths are relative to:
  // the bundle (by default at that root, see `target` below) and the lockfile.
  const outputsAt = (root) => [output ?? join(root, DEFAULT_BUNDLE_FILE), lockfile].filter((file) => file !== undefined && file !== '-').map((file) => resolve(cwd, file))
  // With `builds` (stasis.config.json's entries, however many builds they make), `extra` is the
  // bundle's, not any build's: added to their union below.
  const bundleExtra = builds !== undefined
  let union, root
  if (deptree) {
    if (typeof deptree !== 'boolean') throw new TypeError('bundleCommand: deptree must be a boolean')
    // The disk read through the tree, nothing cached (`cache: false`, and no setCacheDir here).
    const { createClient } = await import('@preventive/upstream/github.js')
    const built = await buildFromLockfile('bundleCommand', diskHost, {
      cwd: resolve(cwd),
      lockfile,
      cache: false,
      client: createClient({ token: env.GITHUB_TOKEN || null }),
    }, {
      env,
      builds: plans,
      configured: bundleExtra,
      outputsAt,
      why: '--deptree lays out the dependencies from a lockfile',
      refuseInstalled: true,
    })
    console.warn(unpackedSummary(built.stats))
    root = built.root
    union = { bundle: built.bundle, lockfile: () => built.lockfile }
  } else {
    const builts = []
    for (const [i, plan] of plans.entries()) {
      // eslint-disable-next-line no-await-in-loop -- one build at a time, in the order its warnings read
      builts.push(await buildOfKind(kinds[i], { ...plan, outputsAt, extra: !bundleExtra }))
    }
    // The directory the bundle's paths are relative to: a State-built JS bundle's root, which is the
    // project's at or above cwd (a workspace package's is the workspace root's), else cwd.
    const roots = builts.map((built) => built.root ?? resolve(cwd))
    root = roots[0]
    // State-built bundles keep the State root's repo (no cwd fallback: their paths are relative to that root).
    for (const built of builts) if (!built.stateBuilt) built.bundle.repo ??= detectRepo(cwd)
    union = unionOfBuilds('bundleCommand', plans, builts, roots)
  }
  // By default the bundle goes there, where `stasis run --bundle=load` discovers it. In cwd below
  // the root it would load as rooted at cwd, and root the next `stasis bundle` there too, out of the
  // files above it.
  const target = output ?? relative(resolve(cwd), join(root, DEFAULT_BUNDLE_FILE))

  // A tree laid out from the lockfile adds `extra` as it builds (buildFromLockfile).
  if (bundleExtra && !deptree) {
    // Once, whatever the builds' order: to their union, whose own record of a file stands, by the
    // allowlist of the stasis.config.json at the root, not any one entry's `resources`.
    const withExtras = withExtra(union, root, { outputs: outputsAt(root) })
    if (withExtras !== union) pinInstalledCommits(withExtras.bundle, root)
    union = withExtras
  }
  let { bundle } = union
  // Only a JS bundle has a lockfile (classifyEntries refuses one for the others).
  let lockData = lockfile ? union.lockfile().serialize() : undefined

  // --add: union the fresh build into the existing on-disk bundle; a conflicting file throws. Skipped when nothing is on disk.
  const outAbs = target === '-' ? undefined : resolve(cwd, target)
  const lockAbs = lockData ? resolve(cwd, lockfile) : undefined
  // Files the pre-existing bundle carried; undefined when no merge happened (the summary's merged sentinel).
  let mergedFrom
  if (add && existsSync(outAbs)) {
    let existing
    try {
      existing = parseBundleBytes(readFileSync(outAbs))
    } catch (cause) {
      throw new Error(`bundleCommand: --add failed to read the existing bundle at ${target}`, { cause })
    }
    mergedFrom = existing.sources.size
    bundle = existing.merge(bundle)
    // Keep the companion lockfile consistent with the merged bundle: union an existing one.
    // With none on disk we can't attest the pre-existing bundle's files (their hashes live
    // only in that missing lockfile), so refuse rather than write an under-attesting lockfile.
    if (lockData) {
      if (!existsSync(lockAbs)) {
        throw new Error(`bundleCommand: --add can't write a complete lockfile at ${lockfile}: the bundle at ${target} already carries files a fresh lockfile wouldn't attest, and there's no existing lockfile to merge into. Write --lockfile alongside the bundle from the first build, or drop --lockfile.`)
      }
      let existingLock
      try {
        existingLock = Lockfile.parse(readFileSync(lockAbs, 'utf8'))
      } catch (cause) {
        throw new Error(`bundleCommand: --add failed to read the existing lockfile at ${lockfile}`, { cause })
      }
      lockData = existingLock.merge(Lockfile.parse(lockData)).serialize()
    }
  }

  const serialized = bundle.serialize()
  const files = [...bundle.sources.keys()]
  const modules = bundle.modules

  const dest = writeBundle(cwd, target, serialized, brotliQuality)
  if (lockData) writeFile(lockAbs, lockData)
  // The bundle's paths are relative to its root; shown relative to cwd, as `dest` is.
  const fromDir = posix.join(toPosix(relative(resolve(cwd), root)), outermostDir(files, root))
  // On a merge, report newly-added files alongside the totals; a fresh write keeps the plain line.
  if (mergedFrom !== undefined) {
    const added = files.length - mergedFrom
    console.warn(`[stasis] Added ${added} file${added === 1 ? '' : 's'} (${files.length} total in ${packagesLabel(modules)}) from ${fromDir} to ${dest}`)
  } else {
    console.warn(bundledSummary(files.length, modules, fromDir, dest))
  }
}
