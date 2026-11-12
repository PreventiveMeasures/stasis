import { isUtf8 } from 'node:buffer'
import { basename, dirname, join, posix, relative, sep } from 'node:path'

import { readJson } from '@exodus/stasis-core/bundle-util'
import { diskHost } from '@exodus/stasis-core/host'
import { CODE_EXTENSIONS, classifyFormat, isAutoExcludedDir, isBinaryPlist, isDotEnvFile, isExcludedNativeFile, isNativeArtifact, metroFormat, nameFormat, pathExt, toPosix, upsert } from '@exodus/stasis-core/util'

// The native build inputs of a React Native app's packages, shared by the Metro plugin's capture and `stasis bundle
// --metro` so the two carry the same files. `fs` is a host: readdir(dir) -> Dirent[] (throws where `dir` isn't one),
// readFile(file) -> Buffer, stat(path) -> Stats, or null where nothing is there.

// Files a React Native build requires that neither Metro's graph nor a run's loader carries, resolved from the project
// root: setup_env.sh, which the React Native CLI runs as every command starts (`react-native config` included).
export const AUTO_INCLUDES = ['@react-native-community/cli/setup_env.sh']

export function listing(dir, fs) {
  try {
    return fs.readdir(dir)
  } catch {
    return []
  }
}

// RN core build scripts the native walk would defer to Metro as `.js`, but Metro never sees them (RN's podspecs
// invoke them at pod-install). Project-relative, so react-native's `exports` can't hide them.
export const RN_CORE_INCLUDE_FILES = ['sdks/hermes-engine/utils/replace_hermes_version.js']

// By name: RN scatters podspecs in subdirs `react-native config` misses.
const isPodspec = (name) => name.endsWith('.podspec') || name.endsWith('.podspec.json')

// The off-platform top-level dir of a native package, which no build on this host compiles.
export function isExcludedNativeDir(name, { win32 = process.platform === 'win32' } = {}) {
  return !win32 && name === 'windows'
}

// Nested packages (attested separately) and regenerated build output, on top of the shared set.
const NATIVE_BUILD_OUTPUT_DIRS = new Set(['node_modules', 'build', '.gradle', '.cxx', 'Pods', 'DerivedData'])
const isSkippedNativeWalkDir = (name) => NATIVE_BUILD_OUTPUT_DIRS.has(name) || isAutoExcludedDir(name) || isNativeArtifact(name)

// A compiled tool (Hermes' `hermesc`), never source.
const isExtensionlessBinary = (name, content) => pathExt(name) === '' && Buffer.isBuffer(content) && !isUtf8(content)

// A native capture's view of a file by name: { action: 'code', format } for a native build input, 'skip' for noise
// or a JS-family file by extension (Metro owns those), else 'resource'.
export function classifyNativeCapture(name, { win32 = process.platform === 'win32', content } = {}) {
  // `.env` files carry secrets: an automated capture must never sweep them in.
  if (isExcludedNativeFile(name, { win32 }) || isDotEnvFile(name)) return { action: 'skip' }
  // Name-matched code is a native build input even where its tag is a Node format the JS graph would own.
  const byName = nameFormat(name)
  if (byName !== undefined) return { action: 'code', format: byName }
  if (CODE_EXTENSIONS.has(pathExt(name))) return { action: 'skip' }
  const format = classifyFormat(name, { content })
  return format === undefined ? { action: 'resource' } : { action: 'code', format }
}

// classifyNativeCapture refined by the bytes, which only ever demote; a 'resource' gets its format from its bytes.
export function refineNativeCapture(classified, name, content, resources = new Set()) {
  if (isExtensionlessBinary(name, content)) return { action: 'skip' }
  if (isBinaryPlist(name, content)) return { action: resources.has('plist') ? 'resource' : 'skip' }
  return classified
}

// A file name as Metro's AssetPaths reads it (parsePlatformFilePath, then parseBaseName): its asset, `${name}.${type}`
// less any scale (`a@2x.png` is `a.png`'s), its scale (`resolution`, 1 where it names none), and its platform where it
// names `platform` (`a.ios.png`; `a.android.png` is an asset of its own). -> null for a name with no type
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

// A file's stat for metroAssetFiles, where a listing names one the disk lacks.
export const FILE_STAT = { isFile: () => true }

// The files `state` (a loaded State) carries, as a directory listing of them (metroAssetFiles' host).
export function bundleDirHost(state) {
  const dirs = Map.groupBy([...state.sources.keys(), ...state.resources.keys()], (rel) => posix.dirname(rel))
  return {
    readdir: (dir) => (dirs.get(toPosix(state.relative(dir)) || '.') ?? []).map((rel) => ({ name: posix.basename(rel) })),
    stat: () => FILE_STAT,
  }
}

// Metro's record of the asset module `path` (getAbsoluteAssetRecord): the files it reads to build it and copies out
// with it, each of the asset's name and type at any scale in its directory, those for `platform` where it has any,
// else those for none. -> absolute paths
export function metroAssetFiles(path, platform = null, host = diskHost) {
  const own = parseMetroAssetName(basename(path), platform)
  if (own === null) return []
  const dir = dirname(path)
  const byPlatform = new Map()
  for (const { name } of host.readdir(dir)) {
    const parsed = parseMetroAssetName(name, platform)
    if (parsed?.asset !== own.asset || host.stat(join(dir, name))?.isFile() !== true) continue
    upsert(byPlatform, parsed.platform, () => []).push(join(dir, name))
  }
  return (platform === null ? undefined : byPlatform.get(platform)) ?? byPlatform.get(null) ?? []
}

// Whether the package at `root` ships native code: an ios/ or android/ dir, or a podspec under it.
export function looksNative(root, fs) {
  return fs.stat(join(root, 'ios')) !== null || fs.stat(join(root, 'android')) !== null || hasPodspec(root, fs)
}

function hasPodspec(dir, fs) {
  return listing(dir, fs).some((ent) => !ent.isSymbolicLink() &&
    (ent.isFile() ? isPodspec(ent.name) : ent.isDirectory() && !isSkippedNativeWalkDir(ent.name) && hasPodspec(join(dir, ent.name), fs)))
}

// A spec React Native's codegen parses (its filterJSFile): a JS or TS module named `Native…` or `…NativeComponent`,
// but a type declaration.
const isCodegenSpec = (name) => /^(?:Native.+|.+NativeComponent)/u.test(name) && /\.(?:jsx?|tsx?)$/u.test(name) && !name.endsWith('.d.ts')

// Each native build input of the package at `root`, walked whole (a podspec may compile `cpp/` beside `ios/`) but
// build output, prebuilt binaries, an off-platform top-level dir, symlinks and what the shared classifier skips; and
// its codegen specs, as code Metro's format names. -> yields { file, source, action: 'code' | 'resource', format }
export function* nativeInputs(root, fs, { resources = new Set(), skip = () => false } = {}) {
  yield* walk(root, true)
  for (const dir of codegenSources(root, fs)) yield* sources(dir)
  function* sources(dir) {
    for (const ent of listing(dir, fs)) {
      // As codegen skips a dot, node_modules or tests directory.
      if (ent.isSymbolicLink() || ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name.startsWith('__tests')) continue
      const file = join(dir, ent.name)
      if (ent.isDirectory()) yield* sources(file)
      else if (ent.isFile() && isCodegenSpec(ent.name) && !skip(file)) yield { file, source: fs.readFile(file), action: 'code', format: metroFormat(file) }
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
      const { action, format } = refineNativeCapture(byName, ent.name, source, resources)
      if (action !== 'skip') yield { file, source, action, format }
    }
  }
}

// The dirs the package's `codegenConfig` names as its JS sources (`jsSrcsDir`, or each of its `libraries`'), each
// reached through no symlink, as the walk follows none: codegen parses the specs there for the native code a build
// compiles, and `react-native config` reads them for the components they declare. -> the absolute dirs
function codegenSources(root, fs) {
  const config = readJson(join(root, 'package.json'), fs)?.codegenConfig
  const named = [config?.jsSrcsDir, ...(Array.isArray(config?.libraries) ? config.libraries.map((library) => library?.jsSrcsDir) : [])]
  return named.filter((dir) => typeof dir === 'string' && dir !== '').map((dir) => packageDir(root, dir, fs)).filter((dir) => dir !== null)
}

// The directory `rel` names in the package at `root`, each step a directory entry (not a link, not `..`), else null.
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

// The app's packages `react-native config` reads, as data rather than by running the CLI: each name its package.json
// lists under dependencies, peerDependencies or devDependencies, in the nearest node_modules up from `projectDir` that
// holds it. What a react-native.config.js changes, being code, isn't seen. -> the package dirs
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

// Those of linkedPackages a native build links: those that ship native code.
export function linkedNativePackages(projectDir, fs) {
  return linkedPackages(projectDir, fs).filter((dir) => looksNative(dir, fs))
}
