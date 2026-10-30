import { dirname, join, relative, sep } from 'node:path'

import { classifyNativeCapture, isExcludedNativeDir, isNativeArtifact, isPodspec, isSkippedNativeWalkDir, refineNativeCapture } from '@exodus/stasis-core/util'

// The native build inputs of a React Native app's packages, shared by the Metro plugin's capture and
// `stasis bundle --metro` so the two carry the same files. Both read through `fs`:
//   readdir(dir) -> Dirent[] (throws where `dir` isn't one), readFile(file) -> Buffer,
//   stat(path) -> Stats, or null where nothing is there.

// Files a React Native build requires that Metro's module graph never carries, each as a require() of
// `specifier` from the project root resolves it (one that doesn't, or lies outside the root, is passed
// over), tagged by the shared classifier, under the consumer that uses it: Metro bundles
// asyncRequire.js into the app (for an `import()`); the React Native CLI runs setup_env.sh
// (`execFileSync`) as every command of it starts, `react-native config` the Metro plugin runs
// included, which is the run's toolchain, none of it the app's.
// The Metro plugin records a `reason` as is; `stasis bundle --metro` carries a `metro` one as Metro's
// code (`bundle:metro`), any other as its own (`bundle`).
export const AUTO_INCLUDES = [
  { specifier: 'metro-runtime/src/modules/asyncRequire.js', reason: 'metro' },
  { specifier: '@react-native-community/cli/setup_env.sh', reason: 'run' },
]

// The entries of the directory `dir`, none where it's missing or no directory.
function listing(dir, fs) {
  try {
    return fs.readdir(dir)
  } catch {
    return []
  }
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
  let config
  try {
    config = JSON.parse(fs.readFile(join(root, 'package.json')).toString('utf8')).codegenConfig
  } catch {
    return []
  }
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
  let manifest
  try {
    manifest = JSON.parse(fs.readFile(join(projectDir, 'package.json')).toString('utf8'))
  } catch {
    return []
  }
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
