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
import { pinInstalled } from '../installed.js'
import { State } from '@exodus/stasis-core/state'
import { bundledIntegrity, readFileSyncMaybe } from '@exodus/stasis-core/state-util'
import { checkoutCommit, detectRepo, normalizeEntries, packageLookup, packageJSONStat, packageType, parseGithubRepository, readJson, readModuleManifest, readPackageJson, readRegularFileOrNull, scopeManifestOf } from '@exodus/stasis-core/bundle-util'
import { EMPTY_MODULE_PATH, assertRealPathWithinBase, classifyFormat, dependencyEcosystem, fileInBucket, hasNodeModulesSegment, isDotEnvFile, isPathWithin, isPlainObject, moduleFileKey, moduleFileKeys, moduleInfo, nestedMap, nodeExtFormat, observeExecutable, parseExtraOption, parseLockfilesOption, parseResourcesOption, posixPathEscapes, relativeEscapes, splitNodeModulesPath, toPosix, withMetadataOf } from '@exodus/stasis-core/util'
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
import { decodeUtf8 } from '../loaders/solidity-ownership.js'
import { buildBashTree, collectBashFilesFromDisk } from '../loaders/bash.js'
import { boundaryOf, collectRustBundle, withinRealDir } from '../loaders/rust.js'
import { ancestors, createCargoContext } from '../loaders/cargo.js'
import {
  bucketizePhpSources,
  buildPhpTree,
  collectPhpFilesFromDisk,
  loadComposerAutoload,
  loadComposerPackages,
  loadLaravelProviderFiles,
} from '../loaders/php.js'
import { DEFAULT_BUNDLE_FILE, bundledSummary, lockedSummary, lockfileOnlyError, packagesLabel, unpackedSummary, writeBundle, writeFile } from './output.js'
import { withNpmToken } from './tokens.js'

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

// The files `roots` link, themselves included, through the edges `follows(edge)` takes.
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

// The files the entries link eagerly, through static edges alone.
const eagerlyLinked = (scanner) => linkedThrough(scanner, scanner.entries, (e) => STATIC_KINDS.has(e.kind))

// The scan within the project root (`within(url)`), since a bundle can't carry a file outside it.
// One the entries link eagerly is returned in `outside`, for the caller to refuse. One reached
// only past a require()/import() boundary is left out, with whatever only it reaches, and its edges
// are returned in `leftOut`, misses that load can catch as it does an unresolved one: an optional
// peer dependency's lazy require() reaching a copy hoisted above a root that a stasis file pins, say.
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

// The first 10 of `items` as indented lines (`line` renders one), then how many more there are.
const listed = (items, line = (s) => s) => {
  const more = items.length > 10 ? `\n  ... and ${items.length - 10} more` : ''
  return items.slice(0, 10).map((x) => `  ${line(x)}`).join('\n') + more
}

// Classify scanner unresolved edges into fatal (broken/divergent at load) vs tolerated (a
// catchable runtime miss); every parse error is fatal. Shared so the plain and --mainFields JS
// paths gate identically. `baseDir` relativizes the paths in the emitted messages (see displayPath).
// `generated(u)` (vfs-bundle/prisma.js's generatedMiss) says why a miss of a file a generator would
// write is missing: such a miss is fatal however it is imported, at load or at run time.
// `typescript`: whether a fatal miss resolves under --typescript.
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
  // A file the parser couldn't read cleanly, however it is reached: its edges are unknown (a module
  // file's are discarded) or partial (those of a script's recovered AST), never a graph to record.
  for (const p of scanner.parseErrors) fatal.push(`parse error in ${show(p.url)}: ${p.message}`)
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
  return { fatal, tolerated, typescript }
}

// Throw on fatal scan issues; warn on tolerated ones. `label` tags the scan pass; `baseDir`
// relativizes the paths in the warnings (see displayPath), matching analyzeScanner's messages.
function reportScanIssues({ fatal, tolerated, typescript = false, leftOut = [] }, { label = '', baseDir, root = '' }) {
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
// (packageTsconfigPaths, the project read as the State reads it, to `env`'s PROJECT_CWD). Either way
// it carries the packages' layouts (`outputs`). Without --typescript they only hint a miss
// (Scan#typescriptCandidate), so a config that doesn't load is none.
function typescriptPathsFor(typescript, baseDir, tsconfig, host, env) {
  if (typescript && tsconfig !== undefined) {
    const matcher = loadTsconfigPaths(discoverTsconfig(baseDir, tsconfig, host), host)
    return { matchPaths: (spec) => matcher?.matchPaths(spec) ?? [], outputs: tsconfigOutputsOf({ host }) }
  }
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
export async function buildJsBundle({ cwd = process.cwd(), env = process.env, entries, scope, conditions = [], jsx = false, flow = false, typescript = false, tsconfig, resources, define, packageJSON = false, host = diskHost, innermostRoot = false, extra = false, outputsAt = () => [], memo, generated } = {}) {
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

  const scanned = scan(absEntries, { conditions: scanConditions, jsx, flow, typescript, typescriptPaths, resources: resourceSet, define, host, memo: memo ? nestedMap(memo, 'js') : null, missTargets: generated !== undefined })
  // A round of a lazy tree that asked for a package already is void: the rest is moot.
  if (memo && host.touches() > 0) throw new Error('buildJsBundle: this round reads a package not unpacked yet')

  // Materialise via a non-preload State: addFile bucketizes + records sources/formats,
  // addImport replays the edge map; serialize emits the runtime loader's v1 layout.
  // bundle:'replace' skips reading any on-disk stasis.code.br (bundle:'add' would leak stale
  // entries); lock:'ignore' tolerates a pre-existing lockfile without consuming it (heldToLockfile
  // holds the build to it); and it is never written, so it claims no write target, nor checks the
  // Policy (assertPolicies checks the whole bundle).
  const stateOptions = { bundle: 'replace', lock: 'ignore', ownLock: true, ...(scope ? { scope } : {}), host, claim: false, checkPolicy: false }
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
  const root = ` at ${relative(baseDir, state.root) || '.'}${rootedBy(state.root, host, ', which can be removed if stale')}`
  for (const url of outside) {
    throw new Error(`buildJsBundle: ${relative(baseDir, fileURLToPath(url))} is outside the project root${root}`)
  }
  // Fail closed where the bundle is guaranteed broken at load; warn on catchable misses (see analyzeScanner).
  reportScanIssues({ ...analyzeScanner(scanner, { baseDir, generated }), leftOut }, { baseDir, root })
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

// ` (rooted there by its <the STASIS_ROOT_FILES in `dir`><hint>)`, or '' where `dir` holds none.
function rootedBy(dir, host = diskHost, hint = '') {
  const markers = STASIS_ROOT_FILES.filter((name) => host.stat(join(dir, name)) !== null)
  return markers.length === 0 ? '' : ` (rooted there by its ${markers.join(' and ')}${hint})`
}

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
// Foo.jsx/Foo.tsx, as it does under Metro. A project's own sourceExts are taken from its
// rn.config.json alone (metroLists), never off its Metro config, which is code.
const SOURCE_EXTS = METRO_SOURCE_EXTS
// React Native preset mainFields for `--metro` (which also sets the RN conditions + platform suffixes).
const METRO_MAIN_FIELDS = ['react-native', 'browser', 'main']

// The config files a React Native app's build loads from its project root, though nothing the app
// imports reaches them: Metro's and the React Native CLI's, and with --babel(-aliases) Babel's.
const METRO_CONFIG_FILE = 'metro.config.js'
const METRO_CONFIG_FILES = [METRO_CONFIG_FILE, 'react-native.config.js']
// @preventive/rn's config of a React Native app's build (rn-bundle's and rn-serve's), in its root.
const RN_CONFIG_FILE = 'rn.config.json'
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
// Under --metro, `assetExts`, `sourceExts` and `assetResolutions` are Metro's resolver lists (its
// defaults where not given; metroLists).
export function fieldResolverFor(platform, { mainFields, metro = false, assetExts, sourceExts = SOURCE_EXTS, assetResolutions, conditions = [], typescript = false, typescriptPaths = null, host = diskHost, kept }) {
  const extras = metro ? ['react-native', ...(platform === 'web' ? ['browser'] : [])] : [...new Set([...BUNDLER_CONDITIONS, ...conditions])]
  const fields = metro ? METRO_MAIN_FIELDS : mainFields
  const resolver = createFieldResolver({
    mainFields: fields,
    platform,
    preferNative: platform !== null && platform !== 'web',
    sourceExts,
    conditions: resolveConditions('commonjs', extras),
    // Opt into Metro's package-entry browser-field quirks only on the --metro path.
    metro,
    assetExts,
    assetResolutions,
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
const LOCK_FILE = 'stasis.lock.json'

// The stasis.config.json in `cwd`, parsed; null where there is none. `name`, if any, prefixes errors.
export function readConfigFile(name, cwd, host = diskHost) {
  const text = readFileSyncMaybe(resolve(cwd), CONFIG_FILE, 'utf8', host)
  try {
    return text === null ? null : JSON.parse(text)
  } catch (cause) {
    throw new Error(`${name === undefined ? '' : `${name}: `}${CONFIG_FILE} is not valid JSON`, { cause })
  }
}

// Holds each of `builds` (as built, `builts[i]`) to its entries' Policy, and the whole `bundle` (`extra`
// included) to that of the stasis.config.json at `root`, read through `host`; links are followed through
// `files`, the host the builds read.
function assertPolicies(name, { builds = [], builts = [], bundle, root, host = diskHost, files = host, label = CONFIG_FILE }) {
  const links = linksOn(root, files)
  for (const [i, build] of builds.entries()) build.policy?.assertArtifact(builts[i].bundle, { links })
  parsePolicy(label, readConfigFile(name, root, host))?.assertArtifact(bundle, { links })
}

// The stasis.config.json `key` in `cwd` (read as readConfigFile reads it), true or false, true where
// it is left out.
function configFlag(key, name, cwd, host) {
  const value = readConfigFile(name, cwd, host)?.[key]
  if (value === undefined) return true
  if (typeof value !== 'boolean') throw new TypeError(`${CONFIG_FILE}: ${key} must be true or false, got ${JSON.stringify(value)}`)
  return value
}

// Whether the tree laid out from the lockfile for the project `host` holds at `cwd` installs
// devDependencies, as a plain install does (`installDevDependencies`, the default), or leaves out what
// devDependencies alone reach, as `pnpm install --prod`, `npm ci --omit=dev` and `yarn install
// --production` do.
export const installsDevDependencies = (name, cwd, host) => configFlag('installDevDependencies', name, cwd, host)

// Whether the tree laid out from the lockfile for the project `host` holds at `cwd` may be lazy
// (`lazyDependencies`) where the package manager lays one out from the lockfile alone (pnpm, npm),
// each package fetched once the build reads it, or has every package fetched before the build.
const lazesDependencies = (name, cwd, host) => configFlag('lazyDependencies', name, cwd, host)
// Whether a build given no `generate` writes the Prisma Client of each project the entries reach whose
// schema asks for one, as `prisma generate` would (`generatePrisma`).
const generatesPrisma = (name, cwd, host) => configFlag('generatePrisma', name, cwd, host)

// The lockfiles the stasis.config.json in `cwd` names (`lockfiles`, as parseLockfilesOption has them),
// a tree laid out of each in place of the one detected; undefined where it names none. `name` prefixes
// a refusal.
export const configuredLockfiles = (name, cwd, host) => parseLockfilesOption(`${name}: ${CONFIG_FILE}`, readConfigFile(name, cwd, host)?.lockfiles)

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

// Metro's default assetExts and each string the Metro config `file` lists among them, read off its
// source, never run (`[...defaultConfig.resolver.assetExts, 'riv']`); one it filters out still counts.
function metroAssetExts(baseDir, host, file = METRO_CONFIG_FILE) {
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

// The project's rn.config.json, or null where there's none; throws where it isn't a JSON object, as
// rn-bundle refuses to build.
function readRnConfig(baseDir, host) {
  const text = readFileSyncMaybe(baseDir, RN_CONFIG_FILE, 'utf8', host)
  if (text === null) return null
  let config
  try {
    config = JSON.parse(text)
  } catch (cause) {
    throw new Error(`${RN_CONFIG_FILE} is not valid JSON`, { cause })
  }
  if (!isPlainObject(config)) throw new Error(`${RN_CONFIG_FILE} is not an object of options`)
  return config
}

// Each of `options` that `config` (rn.config.json's, or its section `prefix`'s) has; throws on one of
// another kind.
function rnOptions(config, options, prefix = '') {
  const taken = {}
  for (const [key, [valid, what]] of Object.entries(options)) {
    if (config[key] === undefined) continue
    if (!valid(config[key])) throw new Error(`${RN_CONFIG_FILE}: ${prefix}${key} is ${what}, not ${JSON.stringify(config[key])}`)
    taken[key] = config[key]
  }
  return taken
}

// rn.config.json's restrictions, the top level's and each build section's, which restrictionsOf adds to
// them for its build.
function rnRestrictions(config) {
  const restrictions = rnOptions(config, RN_CONFIG_RESTRICTIONS)
  for (const mode of ['development', 'production']) {
    if (config[mode] === undefined) continue
    if (!isPlainObject(config[mode])) throw new Error(`${RN_CONFIG_FILE}: ${mode} is an object of options, not ${JSON.stringify(config[mode])}`)
    restrictions[mode] = rnOptions(config[mode], RN_CONFIG_RESTRICTIONS, `${mode}.`)
  }
  return restrictions
}

// --metro: Metro's resolver lists as rn-bundle takes them from rn.config.json (`config`) and the Metro
// config it loads, unless rn.config.json has assetExts or metroConfig false. `configs` are the files the
// lists came of, to carry.
function metroLists(baseDir, host, config) {
  const rn = config === null ? {} : rnOptions(config, RN_CONFIG_LISTS)
  const metroFile = rn.assetExts !== undefined || rn.metroConfig === false ? null : typeof rn.metroConfig === 'string' ? rn.metroConfig : METRO_CONFIG_FILE
  const assetExts = metroFile === null ? new Set(addedTo(METRO_ASSET_EXTS, rn.assetExts ?? [])) : metroAssetExts(baseDir, host, metroFile)
  const sourceExts = addedTo(SOURCE_EXTS, rn.sourceExts ?? [])
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

// Throws with each rn.config.json restriction (`restrict`) a file of the app's Metro graph breaks, by its
// real path and package, as rn-bundle refuses to build.
function refuseRestricted(files, restrict, host) {
  const packageOf = packagesOf({ isFile: (path) => host.stat(path)?.isFile() ?? false, readFile: (path) => host.readFile(path) })
  const errors = [...new Set([...files].map((file) => host.realpath(file)).flatMap((file) => restrict(file, packageOf(file))))].toSorted()
  if (errors.length > 0) throw new Error(`stasis bundle: the --metro build takes what ${RN_CONFIG_FILE} forbids:\n${listed(errors)}`)
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
// are fieldBuildOptions'. Returns { bundle, lockfile: () => Lockfile }, the lockfile built when called.
async function buildResolvedJsBundle({ cwd = process.cwd(), env = process.env, entries, mainFields, platforms, conditions = [], metro, metroResolver, babel, babelAliases: aliasesFile, jsx = false, flow = false, typescript = false, tsconfig, scope, resources, define, packageJSON = false, host = diskHost, memo, generated }) {
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
  // --metro: Metro's resolver lists, and rn.config.json's restrictions of the files of the app's Metro
  // graph (metroTaken), by their paths from the real project root, the files being real paths.
  const rnConfig = metro ? readRnConfig(baseDir, host) : null
  const { assetExts, sourceExts, assetResolutions, configs: listConfigs } = metro ? metroLists(baseDir, host, rnConfig) : { assetExts: METRO_ASSET_EXTS, sourceExts: SOURCE_EXTS, assetResolutions: METRO_ASSET_RESOLUTIONS, configs: [] }
  // A --metro bundle builds as a release build does, so production's restrictions apply, not development's.
  const restrict = rnConfig === null ? null : restrictionsOf(rnRestrictions(rnConfig), host.realpath(baseDir), false)
  const metroTaken = new Set()
  // The resources the app imports that are no asset of Metro's are no module of Metro's, which can't
  // resolve one: one reaches the build only as a transform's input, read and inlined by a Babel plugin
  // (`require('./messages.po')`, @exodus/i18n's plugin-inline-po), as the Metro plugin records it
  // (`metro`, no edge): no edge to one, and no asset registry for one.
  const isTransformInput = (abs, info) => metro && info?.resource === true && !isAssetFile(abs, assetExts)
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
    if (!voided()) reportScanIssues({ ...analyzeScanner(scanner, { baseDir, generated }), leftOut }, { baseDir, label, root: ' at .' })
    return { scanner, leftOut }
  }
  for (const platform of platforms) {
    // What each resolves, kept across a lazy tree's rounds where it read nothing not unpacked yet.
    const keptFor = (label) => (memo ? nestedMap(memo, `${label} ${platform ?? '*'}`) : undefined)
    const field = fieldResolverFor(platform, { mainFields, metro, assetExts, sourceExts, assetResolutions, conditions: scanConditions, typescript, typescriptPaths, host, kept: keptFor('resolutions') })
    const { extras } = field
    // --metro --metro-resolver delegates to the project's own metro-resolver for byte-for-byte Metro
    // fidelity; otherwise the built-in field/suffix resolver reproduces it. metro-resolver derives
    // default/require|import/platform conditions itself, so it takes only the extra `react-native`
    // condition (browser comes from its per-platform map, keyed on `web`).
    const resolver = metroResolver
      ? createMetroResolver({ projectDir: baseDir, platform, sourceExts, mainFields, conditionNames: ['react-native'], assetExts, assetResolutions, host })
      : field.resolver
    // Without --typescript, the field resolver --typescript would build names the file a miss would
    // land on: a hint in the unresolved report, never an edge (see Scan#typescriptCandidate).
    const typescriptResolve = typescript || metroResolver ? null : fieldResolverFor(platform, { mainFields, metro, assetExts, sourceExts, assetResolutions, conditions: scanConditions, typescript: true, typescriptPaths, host, kept: keptFor('typescript resolutions') }).resolver
    // --babel: a specifier the project's babel-plugin-module-resolver rewrites resolves as rewritten,
    // as Metro resolves it after Babel; its edge stays keyed by the specifier the source holds.
    const aliases = babel ? createBabelAliases({ projectDir: baseDir, platform }) : fileAliases
    // --babel: and whether it keeps a TypeScript import listing types alone (onlyRemoveTypeImports).
    const keepsTypeImports = babel ? createBabelTypeImportsKept({ projectDir: baseDir, platform }) : null
    const aliased = (resolveFn) => {
      if (!aliases || !resolveFn) return resolveFn
      const spelled = (file, spec) => aliases(file, spec) ?? spec
      return Object.assign((file, spec, conds) => resolveFn(file, spelled(file, spec), conds), resolveFn.missTargets && { missTargets: (file, spec, conds) => resolveFn.missTargets(file, spelled(file, spec), conds) })
    }
    // --metro: built through Babel, which erases an import listing types alone (Scan's `babel`).
    const scanOptions = { conditions: extras, resolve: aliased(resolver), typescriptResolve: aliased(typescriptResolve), jsx, flow, resources: resourceSet, define, babel: metro, keepsTypeImports, host, missTargets: generated !== undefined }
    const platformKey = platform ?? '*' // '*' is a private placeholder for the single mainFields pass; it never unflattens
    // Record what scanning from `roots` reaches: its files, their formats and edges. -> its scanner
    const absorb = (roots) => {
      const { scanner, leftOut } = scanWithin(roots, scanOptions, platform ?? 'mainFields')
      leftOutEdges.push(...leftOut)
      for (const [url, info] of scanner.files) {
        const abs = pathOf(url)
        const rel = toRel(abs)
        reached.add(abs)
        // A transform's input, which a Babel plugin reads, is no module of Metro's.
        if (restrict !== null && !isTransformInput(abs, info)) metroTaken.add(abs)
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
  if (restrict !== null && !voided()) refuseRestricted(usesEmpty && metroEmpty !== null ? [...metroTaken, metroEmpty] : metroTaken, restrict, host)

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
    // And the files Metro's resolver lists came of (metroLists), where in the project.
    const configs = [...new Set([...[...METRO_CONFIG_FILES, ...(babelled ? [BABEL_CONFIG_FILE] : [])].map((rel) => join(baseDir, rel)), ...listConfigs.filter((abs) => relWithin(abs) !== null)])].filter((abs) => host.stat(abs)?.isFile())
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

  // Read each reached file once, into the bundle as the bytes read, encoded without loss: the
  // lockfile hashes them from there, once it is wanted (deferredLockfile). Source is
  // stored as UTF-8 text, which non-UTF-8 bytes would not survive -- reject them.
  const sources = new Map()
  // Carry `rel`: `content` in the bundle as `format`.
  const put = (rel, content, format) => {
    sources.set(rel, content)
    formatsByRel.set(rel, format)
  }
  // A resource carries bytes, not source: UTF-8 verbatim or base64 when binary, tagged with the
  // byte-derived format (here and in the --metro native capture below).
  const putResource = (rel, buf) => (isUtf8(buf) ? put(rel, buf.toString('utf8'), 'resource') : put(rel, buf.toString('base64'), 'resource:base64'))
  // Code carries its source, UTF-8 (`what` it is, refused where it isn't).
  const putCode = (rel, buf, format, what = 'JS bundle source') => {
    if (!isUtf8(buf)) throw new Error(`${what} is not valid UTF-8: ${rel}`)
    put(rel, buf.toString('utf8'), format)
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
    put(EMPTY_MODULE_PATH, '', metro ? undefined : 'commonjs')
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
      put(rel, buf.toString('utf8'), 'json')
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

  // The companion lockfile mirrors the bundle, swapping file content for its integrity, once it is wanted.
  stageTimes.carrying += performance.now() - carryingAt
  return { bundle, lockfile: deferredLockfile(bundle) }
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
  // Refuse each of the options `given` that is on, for the `only` (`what`) bundles alone, in order.
  const onlyFor = (only, what, given) => {
    if (kind === only) return
    for (const [flag, on] of Object.entries(given)) if (on) throw new Error(`${name}: --${flag} is only valid for ${what} bundles`)
  }
  // --cargo runs `cargo metadata` for the Rust feature/dependency resolution and the --cargo-*
  // flags steer that resolution; nothing else reads Cargo.
  onlyFor('rust', 'Rust', { cargo, 'cargo-features': Array.isArray(cargoFeatures) && cargoFeatures.length > 0, 'cargo-no-default-features': cargoNoDefaultFeatures, 'cargo-all-features': cargoAllFeatures, 'cargo-target': cargoTarget, 'cargo-manifests': cargoManifests })
  // --conditions: the non-JS resolvers don't consult exports/imports conditions, so it would silently
  // do nothing. --flow strips Flow type syntax before the JS parser; the non-JS loaders never parse
  // with oxc. --typescript maps JS-output specifiers to their on-disk TS sources; only the JS resolvers do it.
  onlyFor('js', 'JS', { scope: scope !== undefined, lockfile: lockfile !== undefined, conditions: Array.isArray(conditions) && conditions.length > 0, flow, typescript })
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
  // --mainFields and --metro/--platforms are legacy-/platform-resolution knobs; --jsx toggles the
  // scanner's JSX parsing for the .js family (.jsx/.tsx need no flag), and only JS entries are scanned;
  // --define folds the globals it gives in the JS scan's branch tests; --package-json folds each bundled
  // module's npm package.json in (the sol/php/bash/rust bucketizers group by their own ecosystems'
  // manifests, not an npm package.json). `define` is parsed (checked) whatever the kind.
  onlyFor('js', 'JS', { mainFields: mainFields !== undefined, jsx, define: parseDefine(name, define).size > 0, 'package-json': packageJSON, metro: metro || (Array.isArray(platforms) && platforms.length > 0) })
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
// buildJsBundle's, for the State's alone (see withExtra). `metro` turns on `jsx` and `flow`, as
// Metro's Babel parses JSX and Flow in every file, and defines what Metro's release build does
// (METRO_RELEASE_DEFINE), each name `define` gives a value taking that one instead.
// -> { bundle, lockfile: () => Lockfile, stateBuilt, root }
async function buildJs({ mainFields, platforms, metro, metroResolver, babel, babelAliases, innermostRoot, extra, outputsAt, ...options }) {
  if (metro) options = { ...options, jsx: true, flow: true, define: { ...METRO_RELEASE_DEFINE, ...options.define } }
  if (metro || mainFields !== undefined) {
    const built = await buildResolvedJsBundle({ ...options, mainFields: metro ? METRO_MAIN_FIELDS : mainFields, platforms: metro ? platforms : [null], metro: Boolean(metro), metroResolver: Boolean(metroResolver), babel: Boolean(babel), babelAliases })
    return { bundle: built.bundle, lockfile: built.lockfile, stateBuilt: false, root: resolve(options.cwd) }
  }
  const state = await buildJsBundle({ ...options, innermostRoot, extra, outputsAt })
  const bundle = state.sourceBundle
  // Stamp the `bundle` consumer (the static build carries none), unless `extra` added files: then
  // the State attributes each file, to `bundle` or `extra`.
  return { bundle: bundle.reason === undefined ? bundle.withReason('bundle') : bundle, lockfile: () => state.lockfile, stateBuilt: true, root: state.root }
}

// The companion lockfile of `bundle` as it is now (Lockfile.fromBundle's), built on the first call,
// the same one after: each file's integrity that of the bytes its content stands for
// (bundledIntegrity), so a file is hashed only once the lockfile is wanted, for a bundle whose
// content is the bytes read, encoded without loss. Its records are taken now: one the bundle
// replaces after (a commit pinned onto a module) is not the lockfile's.
// -> () => Lockfile
function deferredLockfile(bundle) {
  const { config, entries, imports, formats, executable } = bundle
  const now = { config, entries, modules: new Map(bundle.modules), imports, formats, executable }
  let lockfile
  return () => (lockfile ??= Lockfile.fromBundle(now, (file, content) => bundledIntegrity(content, formats.get(file))))
}

// The files stasis.config.json's `extra` names under `baseDir` (expandExtra), packed as `stasis add`
// packs them, to merge into `bundle`, one built there without a State (always full scope): those it
// doesn't carry already (its own record of a file stands), in its buckets where it has them.
// `outputs` are the project-relative paths the build writes, never swept in. The files are read
// through `host`.
// -> { bundle, lockfile } of the `extra` consumer (null when there is nothing to add), the lockfile
// built when first read, and `carried`: the files named that `bundle` carries already, the `extra`
// consumer's too
function extraArtifacts({ baseDir, patterns, resources, bundle, outputs, host }) {
  const named = expandExtra(baseDir, patterns, outputs, host).files
  // Bundle#sources builds its Map afresh on each read: once.
  const bundled = bundle.sources
  const carried = [...named.keys()].filter((rel) => bundled.has(rel))
  const files = new Map([...named].filter(([rel]) => !bundled.has(rel)))
  if (files.size === 0) return { bundle: null, lockfile: null, carried }
  const { codeFiles, resourceFiles } = validateFiles({ baseDir, realBase: host.realpath(baseDir), files, resources, label: 'extra', host })
  const rootPkg = readJson(join(baseDir, 'package.json'), host) ?? {}
  const extra = assembleBundle(baseDir, new Map([...codeFiles, ...resourceFiles]), rootPkg.name ?? 'workspace', rootPkg.version ?? '0.0.0', undefined, { reason: 'extra', buckets: bundle.modules, host })
  // Hashed from the bundle, which holds the bytes read, once a lockfile is wanted.
  const lockfile = deferredLockfile(extra)
  return { bundle: extra, get lockfile() { return lockfile() }, carried }
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
  // The lockfile of what was added is built when read, as the build's is: not here.
  const { lockfile } = built
  return { ...built, bundle, ...(lockfile && added.bundle !== null && { lockfile: () => lockfile().merge(added.lockfile) }) }
}

// The bundle of `kind` (classifyEntries') built from buildBundle's options, from disk, with the files
// stasis.config.json's `extra` names: its git dependencies at the commits their package managers'
// records name, and each npm package held to the lockfile beside it (pinInstalled), whatever its
// kind (a Solidity import out of node_modules is one). `outputsAt(root)` are the absolute paths the
// build writes, given the root its paths are relative to.
// -> { bundle, lockfile: () => Lockfile, stateBuilt } (the last two of a JS bundle alone)
async function buildOfKind(kind, { cwd, env, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests, outputsAt = () => [], extra = true }) {
  const outputs = outputsAt(resolve(cwd))
  // Without `extra`, built as if the config named none (one of several builds of a bundle, see bundleCommand).
  const withExtraOf = (built, buildResources) => (extra ? withExtra(built, cwd, { outputs, resources: buildResources }) : built)
  const pinned = (built) => {
    pinInstalled(built.bundle, built.root ?? resolve(cwd))
    return built
  }
  if (kind === 'sol') return pinned(withExtraOf({ bundle: await buildSolidityBundle({ cwd, env, entries, mappingFile, manifests }) }))
  if (kind === 'php') return pinned(withExtraOf({ bundle: await buildPhpBundle({ cwd, entries }) }))
  if (kind === 'bash') return pinned(withExtraOf({ bundle: await buildBashBundle({ cwd, entries }) }))
  if (kind === 'rust') return pinned(withExtraOf({ bundle: await buildRustBundle({ cwd, entries, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }) }))
  const built = await buildJs({ cwd, env, entries, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, extra, outputsAt })
  return pinned(built.stateBuilt ? built : withExtraOf(built, resources))
}

// Several builds' bundles (and lockfiles) as one, the i-th of `builts` built of `builds[i]` and
// rooted at `roots[i]`: their strict union, rooted where every one of them is; a lockfile only where
// every one has one (only JS builds do).
function unionOfBuilds(name, builds, builts, roots) {
  const other = roots.findIndex((root) => root !== roots[0])
  if (other !== -1) {
    throw new Error(`${name}: ${builds[0].entries[0]} and ${builds[other].entries[0]} can't be bundled together: their bundles' paths are relative to different roots (${roots[0]} and ${roots[other]})`)
  }
  return builts.reduce((a, b) => ({ bundle: a.bundle.merge(b.bundle), lockfile: a.lockfile && b.lockfile && (() => a.lockfile().merge(b.lockfile())) }))
}

// `bundle` with each of its paths under `dir` (POSIX, from the root they are of), as a build from
// that root's parent would hold the same files: its buckets, entries, formats, executable files and
// reason's files, and its imports' parents and targets, their specifiers (as the sources spell them)
// as they are. Its records, `repo` and `package` are as they are.
function bundleUnder(bundle, dir) {
  const at = (path) => posix.join(dir, path)
  const target = (to) => (typeof to === 'string' ? at(to) : new Map([...to].map(([platform, file]) => [platform, at(file)])))
  const { version, config, entries, modules, formats, imports, executable, reason, repo, package: pkg } = bundle
  return new Bundle({
    version,
    config,
    entries: new Set([...entries].map(at)),
    modules: new Map([...modules].map(([bucket, info]) => [at(bucket), info])),
    formats: new Map([...formats].map(([file, format]) => [at(file), format])),
    imports: new Map([...imports].map(([conditions, byParent]) => [conditions, new Map([...byParent].map(([parent, specifiers]) => [at(parent), new Map([...specifiers].map(([specifier, to]) => [specifier, target(to)]))]))])),
    executable: new Set([...executable].map(at)),
    reason: reason && Object.fromEntries(Object.entries(reason).map(([consumer, files]) => [consumer, files.map(at)])),
    repo,
    package: pkg,
  })
}

// buildSolidityBundle's bundle of `build`, its entries and `mappingFile` paths from `cwd` (of `args`,
// with `host` and `env`), built from `from`, cwd or a directory under it, as from there: its paths
// put under `from`'s from cwd (bundleUnder).
async function solidityFrom(build, from, { cwd, ...args }) {
  if (from === cwd) return buildSolidityBundle({ ...build, ...args, cwd })
  const fromThere = (path) => posix.relative(from, posix.resolve(cwd, path)) || '.'
  const { entries, mappingFile } = build
  const bundle = await buildSolidityBundle({ ...build, ...args, cwd: from, entries: entries.map(fromThere), mappingFile: mappingFile && fromThere(mappingFile) })
  return bundleUnder(bundle, posix.relative(cwd, from))
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
  const { generate } = options
  if (generate !== undefined && (!Array.isArray(generate) || generate.some((step) => step !== 'prisma'))) throw new TypeError(`${name}: generate must be an array of 'prisma'`)
  if (generate?.length > 0 && kind !== 'js') throw new Error(`${name}: --generate is only valid for JS bundles`)
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
// installs cwd, where only one's does; but where the stasis.config.json in cwd names its
// `lockfiles`, none is detected, and a `packageManager` given is refused: a tree is laid out of each,
// all read as one (vfs-bundle/tree.js's layOutTrees), each build's entries built of the tree of
// their kind, and `packageManagers` are theirs. `innermostRoot` is buildJsBundle's, for a JS bundle built
// through a State. `generate: ['prisma']` writes each project's Prisma Client into the laid-out
// tree before the scan, leaving `vfs` as it is (vfs-bundle/prisma.js); without `generate`, those of
// the projects the entries reach, silently, unless the stasis.config.json in cwd sets
// `generatePrisma` false; `generate: []`, none. Whichever, an import of a file a generator would
// write that isn't there fails the bundle, saying why, however it is reached. A JS build that a miss
// --typescript resolves leaves broken at load is built with `typescript`. `client`, a
// @preventive/upstream/github.js client, is what a Soldeer git dependency is fetched through; without
// one, a soldeer.lock holding one is refused, naming deptree's `github`, before anything is fetched.
// `cache` is where npm packages' tarballs and version documents are kept (checkCache). Each
// dependency is recorded at the commit the tree installs it from, where deptree names one
// (pinCommits). `root` is the directory in the Vfs the bundle's paths are relative to: cwd, or for a
// JS bundle built through a State, the State's root, which is at or above it. A lazy tree, pnpm's
// or npm's, is laid out with nothing fetched, and each package is fetched and unpacked once the
// build reads under it, the build run again until it reads none it has not (vfs-bundle/lazy.js):
// the bundle the full tree gives, its warnings said once, with `stats` counting what is unpacked. A
// tarball the build never reaches is never fetched, nor held to the lockfile, nor refused. The tree
// is lazy where it can be (lazyTaken) and the stasis.config.json in cwd leaves `lazyDependencies`
// true; `lazy: false` installs every package, and `lazy: true` is refused where the tree cannot be
// lazy, or `lazyDependencies` is false. `stats` are deptree's, and `stats.unpacked` the packages
// unpacked: each one installed, or those a lazy tree unpacked, of every tree.
// -> { bundle: Bundle, lockfile: Lockfile (of a JS bundle, built when first read), stats, packageManager (undefined for several), packageManagers, root }
export async function buildVfsBundle({ lock, ...options } = {}) {
  const { checkVfs, vfsHost } = await import('../vfs-bundle/tree.js')
  checkVfs('buildVfsBundle', options.vfs)
  if (lock !== undefined) assertOption('lock', lock)
  const host = vfsHost(options.vfs)
  const built = await buildFromLockfile('buildVfsBundle', host, options)
  const mode = lockModeOf(built.root, { EXODUS_STASIS_LOCK: lock }, host).lock
  const at = posix.join(built.root, LOCK_FILE)
  const label = posix.relative('/', at)
  if (heldToLockfile(() => built.lockfile, at, label, mode, host) !== undefined && mode === 'frozen') {
    loadsBeside(built.bundle.serialize(), { at: posix.join(built.root, DEFAULT_BUNDLE_FILE), lockAbs: at, label, root: built.root, scope: built.bundle.config.scope, host })
  }
  return built
}

// The trees to lay out (layOutTrees) of `project` at `cwd`, a real path: one of each lockfile
// stasis.config.json names in its `lockfiles`, none detected; else the one of `packageManager`, or the
// one detected, saying `why`.
async function treeSpecs(name, project, cwd, { packageManager, packageManagerVersion, os, why }) {
  const { checkVersion, lockfileSpecs, packageManagerFor } = await import('../vfs-bundle/tree.js')
  const lockfiles = configuredLockfiles(name, cwd, project)
  if (lockfiles === undefined) return [{ packageManager: packageManagerFor(name, project, cwd, { packageManager, packageManagerVersion, os, why }), cwd, packageManagerVersion }]
  if (packageManager !== undefined) throw new Error(`${name}: packageManager is given, and ${CONFIG_FILE}'s lockfiles names the lockfiles to lay out`)
  checkVersion(name, { packageManager, packageManagerVersion })
  return lockfileSpecs(name, project, cwd, lockfiles, os)
}

// Each of `specs` (treeSpecs') lazy where its tree can be, unless stasis.config.json's `lazyDependencies`
// or `lazy` says not.
async function layLazily(name, project, cwd, specs, lazy) {
  const { lazyTaken } = await import('../vfs-bundle/tree.js')
  const lazyDependencies = lazesDependencies(name, cwd, project)
  if (lazy && !lazyDependencies) throw new Error(`${name}: lazy is given, and ${CONFIG_FILE}'s lazyDependencies is false`)
  for (const spec of specs) spec.lazy = lazy ?? (lazyDependencies && lazyTaken(project, spec.packageManager, spec.cwd))
}

// The Prisma Clients generatePrismaClients generates (`options` its but for `host` and `root`), read through
// `tree` (layOutTrees') over `project`: for a lazy tree, in rounds of their own, which fetch the `prisma`
// they read.
async function prismaOutputs(tree, project, options) {
  const [{ generatePrismaClients }, { treeHost }, { inRounds }] = await Promise.all([import('../vfs-bundle/prisma.js'), import('../vfs-bundle/tree.js'), import('../vfs-bundle/lazy.js')])
  const generating = (reads) => generatePrismaClients({ ...options, host: treeHost(tree, project, reads), root: tree.root })
  return tree.unpack === undefined ? generating() : inRounds(generating, tree.unpack)
}

// The Prisma Clients the schemas of the project held in `vfs` generate, as buildVfsBundle generates
// them for a build at `cwd` (`generate: ['prisma']`, every project's), its trees laid out as it lays
// them out, lazily where they can be, but with their devDependencies whatever stasis.config.json says
// (as a build in a directory below it, whose config may say otherwise, lays them out): none of a
// project it can't generate for, and each of an output two generators write; generatePrismaClients'
// outputs, `{ dir, files, schema, generator, prisma }` each. Nothing laid out where no project the trees
// install has a schema; refused where one has, and the optional generator stasis generates with is
// missing. `client` and `cache` are buildVfsBundle's.
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

// buildVfsBundle's build, `name`'s, of the project `project` (a host, @exodus/stasis-core/host)
// reads: of a Vfs, which `vfs` is (for `generate` alone), or of the disk, for `stasis bundle
// --deptree`. As buildVfsBundle builds it, with `options` as it takes them, but for what bundleCommand
// gives besides (none of which buildVfsBundle takes): `plan`, `{ builds, bundleExtra }`, the builds
// (each `{ entries, ...options }`) bundleCommand plans (bundle-options.js) in place of those
// configuredBuilds makes, and whether their union's `extra` is the bundle's, as bundleCommand adds
// it; `env`, what the builds read their settings from (none by default); `outputsAt(root)`, the
// absolute paths written, which `extra` never takes; `refuseInstalled`, layOutTree's; and `why` the
// package manager is detected, as a refusal to detect one says.
async function buildFromLockfile(name, project, { vfs, packageManager, cwd = '/', packageManagerVersion, os, cpu, libc, repo, innermostRoot = false, generate, client, cache, lazy, ...options } = {}, { env = {}, plan, outputsAt = () => [], refuseInstalled = false, why } = {}) {
  const { checkCache, checkKind, checkLazy, checkTarget, layOutTrees, packageManagerOf, pinCommits, treeHost, unpackedOf, vfsHost } = await import('../vfs-bundle/tree.js')
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
  // The entries stasis.config.json's `entries` names, every one where none are given, each built
  // with its options there, which the options given agree with (configuredBuilds); else built with
  // the options given. Each build is checked with the options it is built with. With the builds its
  // `entries` make, `extra` is the bundle's, added once to their union, as bundleCommand adds it;
  // else the build's own, as buildOfKind adds it.
  const configured = plan === undefined ? configuredBuilds(name, { cwd, host: project, entries: options.entries, options }) : null
  const { builds, bundleExtra } = plan ?? { builds: configured?.builds ?? [options], bundleExtra: configured !== null }
  if (builds.length === 0) throw new Error(`${name}: no entries given, and ${CONFIG_FILE}'s entries name none`)
  // That the Vfs can be globbed for `extra` is checked before anything is fetched (for a State
  // rooted above cwd, where it reads the config there).
  if (parseExtraOption(CONFIG_FILE, readConfigFile(name, cwd, project)?.extra).some((pattern) => !pattern.startsWith('!'))) checkGlob()
  const installDevDependencies = installsDevDependencies(name, cwd, project)
  await layLazily(name, project, cwd, specs, lazy)
  // Each project's Prisma Client: asked for (`generate: ['prisma']`), every project's, strictly; else, of a JS
  // build of a Vfs, detected where stasis.config.json's `generatePrisma` leaves it: the projects the entries
  // are in and their workspace dependencies, silently but for what reaches an output it lacks; or none
  // (`generate: []`, or `generatePrisma` false), what their schemas would write read all the same.
  const generatePrisma = generatesPrisma(name, cwd, project)
  if (generate?.length > 0 && !generatePrisma) throw new Error(`${name}: generate is given, and ${CONFIG_FILE}'s generatePrisma is false`)
  const vfsJs = vfs !== undefined && pms.some((pm) => pm.kind === 'js')
  const prismaGeneration = generate?.includes('prisma') ? 'asked' : !vfsJs ? null : generate === undefined && generatePrisma ? 'detected' : 'off'
  // Each build's kind, one a tree's package manager builds.
  const kinds = builds.map((build) => {
    const kind = checkVfsOptions(name, { ...build, lockfile: options.lockfile, generate, cwd, host: project })
    checkKind(name, kind, packageManagers)
    return kind
  })
  // Checked before anything is fetched: an entry out of what the trees install is in the project
  // already. (A Solidity entry that is no .sol file is a directory, skipped where it is missing.)
  const installs = new Set(pms.map((pm) => pm.installs))
  for (const [i, build] of builds.entries()) {
    for (const entry of build.entries) {
      const abs = posix.resolve(cwd, entry)
      if (kinds[i] === 'sol' && !abs.endsWith('.sol')) continue
      if (!posix.relative(cwd, abs).split('/').some((part) => installs.has(part)) && project.stat(abs) === null) throw new Error(`entry not found: ${abs}`)
    }
  }
  // A Solidity build's bundles: one, built from cwd, but where a Soldeer project the trees lay out is
  // below it. Then its .sol files (its directory entries expanded, through `args.host`, as the build
  // expands them) are each built from the root of the project holding it, the innermost, as `stasis
  // bundle` builds them from there, reading the foundry.toml and remappings there: apart by project,
  // each one's bundle put under its root (solidityFrom). Files of no such project, from cwd.
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
  // The project the builds read: with the Prisma Clients `generate` writes, generated once before
  // any build, for a lazy tree in rounds of their own (they read the tree's `prisma`), so that each
  // of the build's rounds reads the same project, as what its scans keep across them takes it to.
  let outside = project
  let expected = []
  const prisma = prismaGeneration === null ? null : await import('../vfs-bundle/prisma.js')
  if (prisma !== null) {
    // The projects with a schema (looked for before any `prisma` is read, which a lazy tree fetches once read):
    // all of them, asked for; else those the entries reach. Nothing done, nor said, where none has one.
    const withSchema = prisma.schemaProjects(project, tree.root, tree.projects)
    const strict = prismaGeneration === 'asked'
    // Reached by the entries alone (cwd's own project, the root's say, only where an entry is in it), each by its
    // real path, as the scan reaches it, where the project holds it: an installed one is the tree's, no project's.
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
  // What follows reads the tree through a host of `outside`: once, or for a lazy tree, in rounds,
  // each reading into its `reads`, each build keeping what its scans read across them in a memo of
  // its own.
  const memos = tree.unpack === undefined ? undefined : builds.map(() => new Map())
  const attempt = async (reads) => {
    const host = treeHost(tree, outside, reads)
    const args = { cwd, host, env }
    // A Vfs holds nothing built: a build broken at load by a miss --typescript resolves is built with
    // it instead, as tsc resolves it, saying nothing of what the first warned.
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
    // A build of a round that asked for a package already is void, whatever it threw: the builds
    // after it are run all the same, for all else they ask for, and the round is set aside after.
    let voided
    // The build each of `builts` is of.
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
    // Merged as bundleCommand merges its builds.
    const { root } = builts[0]
    const union = unionOfBuilds(name, ofBuilds, builts, builts.map((built) => built.root))
    // Once: to the union, by the allowlist of the stasis.config.json at the root, as bundleCommand adds
    // it; else to the one build given, by its `resources`, as buildOfKind adds it, unless its State
    // took it. Never one of the files written (none, into a Vfs).
    return { root, builts, host, ...bundleExtra || !builts[0].stateBuilt ? withExtra(union, root, { outputs: outputsAt(root), resources: bundleExtra ? undefined : builds[0].resources, host, name }) : union }
  }
  const since = counts()
  const built = tree.unpack === undefined
    ? await debugTimed('Built', () => attempt(), () => builtSince(since))
    : await inRounds(...debugging() ? reportedRounds(attempt, tree.unpack) : [attempt, tree.unpack])
  const { bundle, lockfile, root } = built
  // After the lazy rounds, so only the full tree's build is checked.
  assertPolicies(name, { builds, builts: built.builts, bundle, root, host: project, files: built.host, label: `${name}: ${CONFIG_FILE}` })
  // Detected, what generators stasis didn't run it took as the repo has them is said where it carries some.
  if (prismaGeneration === 'detected') for (const warning of prisma.committedWarnings(expected, bundle, root)) console.warn(warning)
  if (repo !== undefined) bundle.repo = repo
  pinCommits(bundle, root, tree)
  const unpacked = unpackedOf(tree)
  // The lockfile is built when first read, the same one after: `stasis github-bundle` and `stasis
  // bundle --deptree` read it for --lockfile alone.
  let lock
  return { bundle, get lockfile() { return (lock ??= lockfile?.()) }, stats: { ...tree.stats, unpacked }, packageManager: packageManagers.length === 1 ? packageManagers[0] : undefined, packageManagers, root }
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
// are left out (see define.js). A JS bundle is held to the project's stasis.lock.json as `stasis
// bundle` holds it.
export async function buildBundle({ cwd = process.cwd(), env = process.env, entries, mappingFile, manifests = false, scope, conditions, mainFields, platforms, metro, metroResolver, babel = false, babelAliases, jsx = false, flow = false, typescript = false, tsconfig, resources, define, packageJSON = false, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false, cargoTarget = null, cargoManifests = false } = {}) {
  const options = { cwd, env, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }
  const built = await buildOfKind(classifyEntries('buildBundle', options), options)
  const root = built.root ?? resolve(cwd)
  assertPolicies('buildBundle', { bundle: built.bundle, root })
  heldOf(built.lockfile, root, { cwd, env })?.loads(built.bundle)
  return built.bundle
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
// that installs cwd, as buildVfsBundle lays them out with `lazy: false` (for JS, pnpm, yarn 1 or
// npm's; for Solidity, Soldeer's), and the rest of the project read from disk through them:
// refused where no lockfile of those installs cwd, or more than one does, and where anything is
// installed already (layOutTree's `refuseInstalled`), before anything is fetched. The tarballs are fetched (or read
// from a cache that holds them, held to the lockfile all the same) and nothing is cached: nothing
// is written but the bundle and the lockfile. A Soldeer git dependency is fetched from GitHub with
// `env`'s GITHUB_TOKEN where it is set; npm is asked with withNpmToken's token (tokens.js).
// With `lockfileOnly`, only the `lockfile` is written, the one it writes beside the bundle: the
// bundle is built, and serialized as for writing, so the lockfile is refused where the bundle
// would be, and its default path is kept out of `extra` all the same; it is neither compressed nor
// written. It takes no `output`, `add` or `brotliQuality`.
export async function bundleCommand({ cwd = process.cwd(), output, lockfile, lockfileOnly = false, brotliQuality, add = false, ...options } = {}) {
  // --add has nothing to merge into on stdout (write-only).
  if (add && output === '-') {
    throw new Error('bundleCommand: --add cannot be combined with --output=- (nothing to merge into on stdout)')
  }
  const lockfileOnlyRefused = lockfileOnly ? lockfileOnlyError({ lockfile, output, add, brotliQuality }) : null
  if (lockfileOnlyRefused !== null) throw new Error(`bundleCommand: ${lockfileOnlyRefused}`)
  const built = await buildOfCommand({ ...options, cwd, output, lockfile })
  const { root } = built
  // By default the bundle goes there, where `stasis run --bundle=load` discovers it. In cwd below
  // the root it would load as rooted at cwd, and root the next `stasis bundle` there too, out of the
  // files above it.
  const target = output ?? relative(resolve(cwd), join(root, DEFAULT_BUNDLE_FILE))

  let { bundle } = built
  // Only a JS bundle has a lockfile (classifyEntries refuses one for the others).
  const mode = built.held?.lock
  if (mode === 'replace' && lockfile === undefined) throw new Error(`bundleCommand: lock = replace rewrites ${built.held.label}: give --lockfile`)
  if (lockfile !== undefined && ['frozen', 'ignore', 'none'].includes(mode)) throw new Error(`bundleCommand: --lockfile: lock = ${mode} writes no lockfile`)
  let lockData = lockfile ? built.held.lockfile().serialize() : undefined

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
    refuseOtherRoot(existing, `the bundle at ${target}`, root, { cwd, at: outAbs })
    // What the bundle and lockfile on disk carry is written again, so held to the config's Policy too.
    const policy = parsePolicy(CONFIG_FILE, readConfigFile('bundleCommand', root))
    const links = linksOn(root)
    policy?.assertArtifact(existing, { hint: recordedIn(target), links })
    mergedFrom = existing.sources.size
    // What it carries already is held to the lockfile too.
    built.held?.hold(deferredLockfile(existing))
    bundle = existing.merge(bundle)
    // Keep the companion lockfile consistent with the merged bundle: union an existing one, or in
    // replace, which reads none, the bundle there recorded anew.
    if (lockData) {
      let existingLock
      if (mode === 'replace') {
        existingLock = deferredLockfile(existing)()
      } else {
        // With none on disk we can't attest the pre-existing bundle's files (their hashes live
        // only in that missing lockfile), so refuse rather than write an under-attesting lockfile.
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
      }
      lockData = existingLock.merge(Lockfile.parse(lockData)).serialize()
    }
  } else if (add && lockData && mode !== 'replace' && existsSync(lockAbs)) {
    // No bundle to add to, but a lockfile at --lockfile: replaced, as one that can't be read is,
    // unless rooted elsewhere, its bundle that root's.
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
    // On a merge, report newly-added files alongside the totals; a fresh write keeps the plain line.
    const added = files.length - mergedFrom
    console.warn(`[stasis] Added ${added} file${added === 1 ? '' : 's'} (${files.length} total in ${packagesLabel(modules)}) from ${fromDir} to ${dest}`)
  } else {
    console.warn(bundledSummary(files.length, modules, fromDir, dest))
  }
  for (const file of [lockfileOnly ? undefined : outAbs, lockData ? lockAbs : undefined]) {
    const warning = file === undefined ? null : nestedRootWarning(file, root, cwd)
    if (warning !== null) console.warn(warning)
  }
}

// The warning that `file`, a stasis file (STASIS_ROOT_FILES) the build rooted at `root` wrote in a
// package below it, roots each stasis run and stasis bundle in that package there (see discovery),
// though its paths are relative to `root`: a --lockfile=stasis.lock.json given in a nested package,
// say. null where it roots nothing but `root`. Paths are shown from `cwd`.
function nestedRootWarning(file, root, cwd) {
  const dir = dirname(file)
  if (!STASIS_ROOT_FILES.includes(basename(file)) || dir === root || !isPathWithin(root, dir) || diskHost.stat(join(dir, 'package.json')) === null) return null
  const shown = (path) => relative(resolve(cwd), path) || '.'
  return `[stasis] ${shown(file)} roots stasis run and stasis bundle in the package at ${shown(dir)}, but its paths are relative to ${shown(root)}: write it at ${shown(join(root, basename(file)))}`
}

// The lockfile `built()` gives held to the one `lockfile` names, else its project's, by the lock mode
// of the project's runs (heldToLockfile): `{ lock, label, lockfile, hold, loads }`, `lockfile()` the
// one to write, `hold(other)` holding another to it, and `loads(bundle)` that, under frozen, the bundle
// loads beside it.
function heldOf(built, root, { cwd, env, lockfile }) {
  if (!built) return undefined
  const { lock, file } = lockModeOf(root, env)
  const at = lockfile ? resolve(cwd, lockfile) : file ?? join(root, LOCK_FILE)
  const label = relative(resolve(cwd), at)
  const hold = (other) => heldToLockfile(other, at, label, lock)
  const fresh = hold(built)
  const loads = (bundle, { text, at: bundleAt = join(root, DEFAULT_BUNDLE_FILE) } = {}) => {
    if (lock === 'frozen') loadsBeside(text ?? bundle.serialize(), { at: bundleAt, lockAbs: at, label, root, scope: bundle.config.scope })
  }
  return { lock, label, lockfile: () => fresh ?? built(), hold, loads }
}

// The lock mode the runs of the project at `root` take, and their EXODUS_STASIS_LOCK_FILE, of a run
// that writes a bundle, as a build does.
function lockModeOf(root, env = process.env, host = diskHost) {
  const config = new Config({ env: { EXODUS_STASIS_LOCK: env.EXODUS_STASIS_LOCK, EXODUS_STASIS_LOCK_FILE: env.EXODUS_STASIS_LOCK_FILE }, bundle: 'replace' })
  const text = readFileSyncMaybe(root, CONFIG_FILE, 'utf-8', host)
  if (text !== null) config.loadConfig(text)
  // A relative one of the working directory's, as a run reads it.
  return { lock: config.lock, file: config.lockFile && resolve(config.lockFile) }
}

// The lockfile `built()` gives held to the one at `lockAbs` by `mode`: in add, agreeing with it on all
// both record (Lockfile.mergeAgreeing); in frozen, that too, and it must be there and attest every file
// built; in none, it must not be there. -> what built() gave, where it was called.
function heldToLockfile(built, lockAbs, label, mode, host = diskHost) {
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
  lock.mergeAgreeing(fresh, label)
  if (mode === 'frozen') {
    const recorded = moduleFileKeys(lock.modules, { scope: lock.config.scope })
    for (const file of moduleFileKeys(fresh.modules, { scope: fresh.config.scope })) {
      if (!recorded.has(file)) throw new Error(`${label} (lock = frozen) doesn't attest ${file}`)
    }
  }
  return fresh
}

// That the bundle of `text`, to be written at `at`, loads beside the lockfile at `lockAbs` as `stasis
// run --lock=frozen --bundle=load` loads them, through `host`; stasis.config.json is read without the
// bundle paths a run would read instead.
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

// The directory the paths of `artifact` (a Bundle or Lockfile) are relative to: the first of
// `candidates` holding each workspace package it records (a package.json of that name, as a State
// rooted there finds it) and each of its entries, or with no workspace package, each npm dependency.
// undefined where it records none of these, or no candidate holds them all.
function artifactRootOf(artifact, candidates) {
  const named = [...artifact.modules].filter(([, info]) => typeof info.name === 'string')
  const ecosystemOf = ([dir, { ecosystem }]) => dependencyEcosystem(dir, ecosystem)
  const workspace = named.filter((bucket) => ecosystemOf(bucket) === undefined)
  const [packages, entries] = workspace.length > 0 ? [workspace, [...artifact.entries]] : [named.filter((bucket) => ecosystemOf(bucket) === 'npm'), []]
  if (packages.length === 0) return undefined
  return candidates.find((dir) => packages.every(([pkg, { name }]) => readPackageJson(dir, moduleFileKey(pkg, 'package.json'))?.name === name) &&
    entries.every((entry) => isFile(join(dir, entry))))
}

// Refuse, under --add, to add the build rooted at `root` to `artifact`, the bundle or lockfile at
// `at` (`what`), whose paths are relative to another directory (artifactRootOf, of the build's root
// and each directory up from cwd and from `at`): its records and the build's would be keyed apart,
// never held to each other. One whose root can't be told is added to as ever.
function refuseOtherRoot(artifact, what, root, { cwd, at }) {
  const baseDir = resolve(cwd)
  const theirs = artifactRootOf(artifact, [...new Set([root, ...ancestors(baseDir), ...ancestors(dirname(at))])])
  if (theirs === undefined || theirs === root) return
  const shown = (dir) => relative(baseDir, dir) || '.'
  throw new Error(`bundleCommand: --add can't add to ${what}: its paths are relative to ${shown(theirs)} and this build's to ${shown(root)}${rootedBy(root)}; rebuild it without --add`)
}

// The bundle bundleCommand writes of its options (but `brotliQuality` and `add`, which say how it is
// written), built as it builds it, warnings and all, and not written: as `stasis audit` would read it
// back from the file, a Bundle parsed from what bundleCommand would compress (no lockfile is
// written either). Its errors are bundleCommand's.
export async function buildCommandBundle(options = {}) {
  const { bundle } = await buildOfCommand(options)
  return Bundle.parse(bundle.serialize())
}

// bundleCommand's bundle, and its lockfile (`lockfile()`, a JS bundle's), built as it builds them from
// its options (but `brotliQuality` and `add`, which say how they are written) and not written, with
// the root their paths are relative to. `output` and `lockfile` are where it would write them, which
// `extra` never takes in. -> { bundle, lockfile: () => Lockfile, root, held (heldOf's) }
async function buildOfCommand({ cwd = process.cwd(), env = process.env, home, entries, mappingFile, manifests = false, output, scope, lockfile, conditions, mainFields, platforms, metro, metroResolver, babel = false, babelAliases, jsx = false, flow = false, typescript = false, tsconfig, resources, define, packageJSON = false, cargo = false, cargoFeatures = [], cargoNoDefaultFeatures = false, cargoAllFeatures = false, cargoTarget = null, cargoManifests = false, builds, deptree = false } = {}) {
  const options = { cwd, env, entries, mappingFile, manifests, scope, conditions, mainFields, platforms, metro, metroResolver, babel, babelAliases, jsx, flow, typescript, tsconfig, resources, define, packageJSON, cargo, cargoFeatures, cargoNoDefaultFeatures, cargoAllFeatures, cargoTarget, cargoManifests }
  if (builds !== undefined) {
    if (!Array.isArray(builds) || builds.length === 0) throw new TypeError('bundleCommand: builds must be a non-empty array')
    const given = Object.entries(options).find(([key, value]) => !['cwd', 'env'].includes(key) && value !== undefined && value !== false && value !== null && !(Array.isArray(value) && value.length === 0))
    if (given) throw new TypeError(`bundleCommand: ${given[0]} can't be combined with builds (each build sets its own)`)
  }
  // Each build's options, the defaults above where it leaves one out.
  const plans = (builds ?? [{}]).map((build) => ({ ...options, ...build, cwd, env }))
  const kinds = plans.map((plan) => classifyEntries('bundleCommand', { ...plan, lockfile }))

  // The files this build writes, never taken into `extra`, given the root its paths are relative to:
  // the bundle (by default at that root, see bundleCommand's `target`) and the lockfile.
  const outputsAt = (root) => [output ?? join(root, DEFAULT_BUNDLE_FILE), lockfile].filter((file) => file !== undefined && file !== '-').map((file) => resolve(cwd, file))
  // With `builds` (stasis.config.json's entries, however many builds they make), `extra` is the
  // bundle's, not any build's: added to their union below.
  const bundleExtra = builds !== undefined
  let union, root
  if (deptree) {
    // The disk read through the tree, nothing cached (`cache: false`, and no setCacheDir here).
    const { createClient } = await import('@preventive/upstream/github.js')
    const built = await withNpmToken(home, () => buildFromLockfile('bundleCommand', diskHost, {
      cwd: resolve(cwd),
      lockfile,
      cache: false,
      lazy: false,
      client: createClient({ token: env.GITHUB_TOKEN || null }),
    }, { env, plan: { builds: plans, bundleExtra }, outputsAt, refuseInstalled: true, why: '--deptree lays out the dependencies from a lockfile' }))
    console.warn(unpackedSummary(built.stats))
    root = built.root
    // A lockfile of JS builds alone, as unionOfBuilds has one.
    union = { bundle: built.bundle, lockfile: kinds.every((kind) => kind === 'js') ? () => built.lockfile : undefined }
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
    if (bundleExtra) {
      // Once, whatever the builds' order: to their union, whose own record of a file stands, by the
      // allowlist of the stasis.config.json at the root, not any one entry's `resources`.
      const withExtras = withExtra(union, root, { outputs: outputsAt(root) })
      if (withExtras !== union) pinInstalled(withExtras.bundle, root)
      union = withExtras
    }
    assertPolicies('bundleCommand', { builds: plans, builts, bundle: union.bundle, root })
  }
  return { ...union, root, held: heldOf(union.lockfile, root, { cwd, env, lockfile }) }
}
