import { isUtf8 } from 'node:buffer'
import { basename, dirname, join, posix, relative, sep } from 'node:path'

import { readJson } from '@exodus/stasis-core/bundle-util'
import { diskHost } from '@exodus/stasis-core/host'
import { CODE_EXTENSIONS, classifyFormat, isAutoExcludedDir, isBinaryPlist, isDotEnvFile, isExcludedNativeFile, isNativeArtifact, nameFormat, pathExt, toPosix } from '@exodus/stasis-core/util'

// The native build inputs of a React Native app's packages, shared by the Metro plugin's capture and
// `stasis bundle --metro` so the two carry the same files. Both read through `fs`:
//   readdir(dir) -> Dirent[] (throws where `dir` isn't one), readFile(file) -> Buffer,
//   stat(path) -> Stats, or null where nothing is there.

// Files a React Native build requires that neither Metro's module graph nor a run's loader carries,
// each as a require() of it from the project root resolves it (one that doesn't, or lies outside the
// root, is passed over), tagged by the shared classifier: setup_env.sh, which the React Native CLI runs
// (`execFileSync`) as every command of it starts, `react-native config` the Metro plugin runs included.
// The run's toolchain, none of it the app's: the Metro plugin records each under `run`, `stasis bundle
// --metro` as its own (`bundle`).
export const AUTO_INCLUDES = ['@react-native-community/cli/setup_env.sh']

// The entries of the directory `dir`, none where it's missing or no directory.
export function listing(dir, fs) {
  try {
    return fs.readdir(dir)
  } catch {
    return []
  }
}

// RN core build scripts the native walk would defer to Metro as `.js`, but Metro never sees them (RN's
// podspecs invoke them at pod-install). Project-relative, so react-native's `exports` can't hide them.
export const RN_CORE_INCLUDE_FILES = ['sdks/hermes-engine/utils/replace_hermes_version.js']

// Discovered by name: RN scatters podspecs in subdirs `react-native config` misses.
function isPodspec(name) {
  return name.endsWith('.podspec') || name.endsWith('.podspec.json')
}

// The off-platform top-level dir of a native package, which no build on this host compiles.
export function isExcludedNativeDir(name, { win32 = process.platform === 'win32' } = {}) {
  return !win32 && name === 'windows'
}

// Dirs the NATIVE walks (Metro plugin + the static --metro bundler) skip, on top of the shared set:
// nested packages (attested separately) and regenerated build output -- none is a build input.
const NATIVE_BUILD_OUTPUT_DIRS = new Set(['node_modules', 'build', '.gradle', '.cxx', 'Pods', 'DerivedData'])
function isSkippedNativeWalkDir(name) {
  return NATIVE_BUILD_OUTPUT_DIRS.has(name) || isAutoExcludedDir(name) || isNativeArtifact(name)
}

// An extensionless non-UTF-8 file is a compiled tool (Hermes' `hermesc`), never source -- skipped.
function isExtensionlessBinary(name, content) {
  return pathExt(name) === '' && Buffer.isBuffer(content) && !isUtf8(content)
}

// The Metro native capture's policy view. Returns { action, format }: 'code' (a native build input),
// 'skip' (excluded noise, or a JS-family file matched BY EXTENSION -- Metro owns those), else 'resource'.
export function classifyNativeCapture(name, { win32 = process.platform === 'win32', content } = {}) {
  // `.env` files carry secrets: an automated capture must never sweep them in.
  if (isExcludedNativeFile(name, { win32 }) || isDotEnvFile(name)) return { action: 'skip' }
  // Name-matched code is always a native build input, even when its tag is a Node format the JS
  // graph would otherwise own.
  const byName = nameFormat(name)
  if (byName !== undefined) return { action: 'code', format: byName }
  if (CODE_EXTENSIONS.has(pathExt(name))) return { action: 'skip' }
  const format = classifyFormat(name, { content })
  return format === undefined ? { action: 'resource' } : { action: 'code', format }
}

// The byte-level half of the native classification, refining what classifyNativeCapture derived from the
// NAME. Both rules only ever demote. A 'resource' carries no format: storage derives base64 from bytes.
export function refineNativeCapture(classified, name, content, resources = new Set()) {
  if (isExtensionlessBinary(name, content)) return { action: 'skip' }
  if (isBinaryPlist(name, content)) return { action: resources.has('plist') ? 'resource' : 'skip' }
  return classified
}

// A file name as Metro's AssetPaths reads it (parsePlatformFilePath, then parseBaseName): its asset,
// `${name}.${type}` less any scale (`a@2x.png` is `a.png`'s), its scale (`resolution`, 1 where it
// names none), and its platform where it names `platform` (`a.ios.png`; another's, `a.android.png`,
// is an asset of its own). -> { asset, name, type, resolution, platform }, or null for a name with no type
const METRO_PLATFORM_FILE = /^(.+?)(?:\.([^.]+))?\.([^.]+)$/u
const METRO_ASSET_SCALE = /^(.+?)(?:@([\d.]+)x)?$/u
export function parseMetroAssetName(name, platform) {
  const match = METRO_PLATFORM_FILE.exec(name)
  if (match === null) return null
  const [, base, suffix, type] = match
  const ofPlatform = suffix !== undefined && suffix === platform
  const [, root, scale] = METRO_ASSET_SCALE.exec(suffix === undefined || ofPlatform ? base : `${base}.${suffix}`)
  const resolution = Number.parseFloat(scale)
  return { asset: `${root}.${type}`, name: root, type, resolution: Number.isNaN(resolution) ? 1 : resolution, platform: ofPlatform ? platform : null }
}

// What a file's stat answers to metroAssetFiles, for a file a listing names but the disk lacks.
export const FILE_STAT = { isFile: () => true }

// The files `state` (a loaded State) carries, as a directory listing of them (metroAssetFiles' host):
// an asset's files as captured.
export function bundleDirHost(state) {
  const dirs = Map.groupBy([...state.sources.keys(), ...state.resources.keys()], (rel) => posix.dirname(rel))
  return {
    readdir: (dir) => (dirs.get(toPosix(state.relative(dir)) || '.') ?? []).map((rel) => ({ name: posix.basename(rel) })),
    stat: () => FILE_STAT,
  }
}

// Metro's record of the asset module `path` (its Assets' getAbsoluteAssetRecord): the files it reads
// to build the module (its `scales` and `hash`) and copies out with it. In `path`'s directory, each of
// the asset's name and type at any scale (`a.png`, `a@2x.png`, `a@3x.png`): those for `platform`
// (`a.ios.png`, `a@3x.ios.png`) where it has any, else those for none. -> absolute paths
export function metroAssetFiles(path, platform = null, host = diskHost) {
  const own = parseMetroAssetName(basename(path), platform)
  if (own === null) return []
  const dir = dirname(path)
  const byPlatform = new Map()
  for (const { name } of host.readdir(dir)) {
    const parsed = parseMetroAssetName(name, platform)
    if (parsed?.asset !== own.asset || host.stat(join(dir, name))?.isFile() !== true) continue
    if (!byPlatform.has(parsed.platform)) byPlatform.set(parsed.platform, [])
    byPlatform.get(parsed.platform).push(join(dir, name))
  }
  return (platform === null ? undefined : byPlatform.get(platform)) ?? byPlatform.get(null) ?? []
}

// True if the package at `root` ships native code: an ios/ or android/ dir, or a podspec under it.
export function looksNative(root, fs) {
  return fs.stat(join(root, 'ios')) !== null || fs.stat(join(root, 'android')) !== null || hasPodspec(root, fs)
}

// True if any *.podspec exists under `dir`, pruning the same subtrees the native walk skips.
function hasPodspec(dir, fs) {
  return listing(dir, fs).some((ent) => !ent.isSymbolicLink() &&
    (ent.isFile() ? isPodspec(ent.name) : ent.isDirectory() && !isSkippedNativeWalkDir(ent.name) && hasPodspec(join(dir, ent.name), fs)))
}

// The specs React Native's codegen parses in a package's codegen sources (codegenSources), as its own
// filter takes them (filterJSFile): a JS or TS module named `Native…` or `…NativeComponent` (a platform's
// `.ios`/`.android` one too), but a type declaration.
const isCodegenSpec = (name) => /^(?:Native.+|.+NativeComponent)/u.test(name) && /\.(?:jsx?|tsx?)$/u.test(name) && !name.endsWith('.d.ts')

// Each native build input in the package at `root`, walked whole, a native build reading sources
// from anywhere in it (a podspec compiling `cpp/` beside `ios/`): every file but build output and
// prebuilt binaries (isSkippedNativeWalkDir, isNativeArtifact), an off-platform top-level dir
// (isExcludedNativeDir), what the shared classifier skips (the JS and TS Metro's graph owns, docs,
// secrets) and symlinks (a cycle or escape hazard). And the specs of its codegen sources
// (codegenSources, isCodegenSpec), as code with no format, as Metro's code has none: none of the
// other JS there (a react-native.config.js, the package's build, where `jsSrcsDir` is its root), which
// codegen never reads. A file `skip(file)` holds is passed over unread. `resources` is the allowlist
// the byte-level rules consult.
// -> yields { file, source, action, format }, `action` 'code' (under the source-language `format`,
// none for JS and TS) or 'resource'
export function* nativeInputs(root, fs, { resources = new Set(), skip = () => false } = {}) {
  yield* walk(root, true)
  for (const dir of codegenSources(root, fs)) yield* sources(dir)
  function* sources(dir) {
    for (const ent of listing(dir, fs)) {
      // None in a dot, node_modules or tests directory, as codegen skips one.
      if (ent.isSymbolicLink() || ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name.startsWith('__tests')) continue
      const file = join(dir, ent.name)
      if (ent.isDirectory()) yield* sources(file)
      else if (ent.isFile() && isCodegenSpec(ent.name) && !skip(file)) yield { file, source: fs.readFile(file), action: 'code', format: undefined }
    }
  }
  function* walk(dir, atRoot) {
    for (const ent of listing(dir, fs)) {
      if (ent.isSymbolicLink()) continue
      const file = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!isSkippedNativeWalkDir(ent.name) && !(atRoot && isExcludedNativeDir(ent.name))) yield* walk(file, false)
        continue
      }
      if (!ent.isFile() || isNativeArtifact(ent.name) || skip(file)) continue
      const byName = classifyNativeCapture(ent.name)
      if (byName.action === 'skip') continue
      const source = fs.readFile(file)
      // Byte-level rules (prebuilt binaries, binary plists) -- see refineNativeCapture.
      const { action, format } = refineNativeCapture(byName, ent.name, source, resources)
      if (action !== 'skip') yield { file, source, action, format }
    }
  }
}

// The directories of the package at `root` its package.json's `codegenConfig` names as its JS sources
// (`jsSrcsDir`, or each of its `libraries`', as React Native's own names `src`), each reached within it
// through no symlink, as the walk follows none: React Native's codegen parses the specs there to
// generate the native code a build compiles (a missing one fails it), and `react-native config` reads
// them for the components they declare (`codegenNativeComponent`, in a `…NativeComponent` spec).
// -> the absolute dirs
function codegenSources(root, fs) {
  const config = readJson(join(root, 'package.json'), fs)?.codegenConfig
  const named = [config?.jsSrcsDir, ...(Array.isArray(config?.libraries) ? config.libraries.map((library) => library?.jsSrcsDir) : [])]
  return named.filter((dir) => typeof dir === 'string' && dir !== '').map((dir) => packageDir(root, dir, fs)).filter((dir) => dir !== null)
}

// The directory `rel` names in the package at `root`, each step of it one (a link's entry is none, and
// none is `..`). -> its absolute path, or null
function packageDir(root, rel, fs) {
  let dir = root
  for (const name of relative(root, join(root, rel)).split(sep)) {
    if (name === '') continue
    if (!listing(dir, fs).some((ent) => ent.name === name && ent.isDirectory())) return null
    dir = join(dir, name)
  }
  return dir
}

// A package name as npm takes one (`name` or `@scope/name`), which a path can't climb out with.
const PACKAGE_NAME = /^(?:@[^/\\@.][^/\\]*\/)?[^/\\@.][^/\\]*$/u

// The app's packages `react-native config` reads, read as data rather than by running the CLI: each
// name the app's package.json lists under dependencies, peerDependencies or devDependencies (the
// CLI's list), in the nearest node_modules up from `projectDir` that holds it (as the CLI looks). What
// a react-native.config.js changes, being code, isn't seen. -> the package dirs, as found
export function linkedPackages(projectDir, fs) {
  const manifest = readJson(join(projectDir, 'package.json'), fs)
  const listed = (field) => (manifest?.[field] && typeof manifest[field] === 'object' ? Object.keys(manifest[field]) : [])
  const names = new Set([...listed('dependencies'), ...listed('peerDependencies'), ...listed('devDependencies')])
  const dirs = []
  for (const name of names) {
    if (!PACKAGE_NAME.test(name)) continue
    for (let dir = projectDir; ; dir = dirname(dir)) {
      const found = join(dir, 'node_modules', name)
      if (fs.stat(found)?.isDirectory()) {
        dirs.push(found)
        break
      }
      if (dirname(dir) === dir) break
    }
  }
  return dirs
}

// Of those, the ones `react-native config` links, as a native build would: those that ship native
// code (looksNative). -> the package dirs, as found
export function linkedNativePackages(projectDir, fs) {
  return linkedPackages(projectDir, fs).filter((dir) => looksNative(dir, fs))
}
