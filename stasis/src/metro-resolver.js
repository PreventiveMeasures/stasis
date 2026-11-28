import { createRequire, isBuiltin } from 'node:module'
import { basename, join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createMetroResolver as createRnMetroResolver, defaults } from '@preventive/rn/metro-resolver.js'
import { diskHost } from '@exodus/stasis-core/host'
import { isPlainObject, isTypeDeclaration } from '@exodus/stasis-core/util'
import { isDir, isSourceFile } from './resolve-typescript.js'

// Metro's module resolution is @preventive/rn's. What stays stasis's: no `.d.ts` is a module (metroHost), a builtin
// Metro misses is a builtin, answers take the shape scan.js expects (scanResolution), and `stasis build --metro`
// resolves the registry an asset's module requires among the artifact's files, never disk (assetRegistryResolver).

export const stripTypeDeclaration = (name) => name.replace(/\.d\.[mc]?ts$/iu, '')

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const DECLARATION = /\.d\.[cm]?ts\b/iu

// An entry field naming a `.d.ts` names its stem, so the entry lands on the real module beside it.
function manifestStems(bytes, mainFields) {
  let manifest
  try {
    const text = utf8.decode(bytes)
    if (!DECLARATION.test(text)) return bytes
    manifest = JSON.parse(text)
  } catch {
    return bytes
  }
  if (!isPlainObject(manifest)) return bytes
  const typed = mainFields.filter((field) => typeof manifest[field] === 'string' && isTypeDeclaration(manifest[field]))
  if (typed.length === 0) return bytes
  for (const field of typed) manifest[field] = stripTypeDeclaration(manifest[field])
  return Buffer.from(JSON.stringify(manifest))
}

// A `.d.ts` is types-only, erased at runtime, so the resolver never lands on one.
export function metroHost(host, mainFields = defaults.mainFields) {
  return {
    isFile: (path) => isSourceFile(path, host),
    isDirectory: (path) => isDir(path, host),
    realpath: (path) => host.realpath(path),
    readFile: (path) => (basename(path) === 'package.json' ? manifestStems(host.readFile(path), mainFields) : host.readFile(path)),
  }
}

// `builtin`: whether a specifier Metro failed (null) is a Node builtin. Metro builds an asset of several files into the
// module of the lowest path (getArrayLowestItem).
export function scanResolution(resolution, builtin) {
  if (resolution === null) return builtin ? { builtin: true } : null
  if (resolution.type === 'empty') return { empty: true }
  const file = resolution.type === 'sourceFile' ? resolution.filePath : resolution.filePaths.toSorted()[0]
  return { url: pathToFileURL(file).toString() }
}

// `--metro-resolver`: through the project's own `metro-resolver`, given the context Metro's DependencyGraph builds.
export function createMetroResolver({ projectDir, platform, sourceExts, mainFields, conditionNames, assetExts, assetResolutions, host = diskHost } = {}) {
  if (host !== diskHost) throw new Error('createMetroResolver: metro-resolver reads the disk, so it is not supported off disk')
  let metroResolver
  try {
    metroResolver = createRequire(join(projectDir, 'noop.js'))('metro-resolver')
  } catch (cause) {
    throw new Error(`StasisMetroResolver: couldn't load 'metro-resolver' from ${projectDir}; install it or drop --metro-resolver`, { cause })
  }
  const resolve = createRnMetroResolver({
    host: metroHost(host, mainFields), sourceExts, assetExts, assetResolutions, mainFields, conditionNames,
    preferNativePlatform: platform !== 'web', metroResolver,
  })
  // Metro splits `exports` on whether the edge is an ESM import: `import` in scan.js's format-derived conditions.
  return (parentFile, specifier, callConditions) => {
    const isESMImport = callConditions instanceof Set && callConditions.has('import')
    return scanResolution(resolve(parentFile, specifier, { platform, isESMImport }), isBuiltin(specifier))
  }
}

// React Native's Metro config's `assetRegistryPath`: a project's own would be read off its Metro config, which is code.
export const ASSET_REGISTRY = 'react-native/Libraries/Image/AssetRegistry'

const REGISTRY_ROOT = /^((?:.*\/)?node_modules\/react-native)\/Libraries\/Image\/AssetRegistry\./u

// Resolved as Metro resolves it among the code files `carried` (by project path): in the react-native nearest up
// from the asset, else the only one (pnpm's). Throws where the artifact carries none, or several none of them nearest.
export function assetRegistryResolver(platform, carried) {
  const pick = (root) => defaults.sourceExts
    .flatMap((ext) => [`.${platform}`, '.native', ''].map((suffix) => `${root}/Libraries/Image/AssetRegistry${suffix}.${ext}`))
    .find((file) => carried.has(file))
  const roots = new Set(carried.keys().map((file) => REGISTRY_ROOT.exec(file)?.[1]).filter((root) => root !== undefined && pick(root) !== undefined))
  const nearest = (rel) => {
    for (let dir = posix.dirname(rel); ; dir = posix.dirname(dir)) {
      const root = posix.join(dir, 'node_modules', 'react-native')
      if (posix.basename(dir) !== 'node_modules' && roots.has(root)) return root
      if (dir === '.' || dir === '/' || dir.startsWith('..')) return undefined
    }
  }
  return (rel) => {
    const root = roots.size === 1 ? [...roots][0] : nearest(rel)
    if (root !== undefined) return pick(root)
    if (roots.size === 0) {
      throw new Error(`stasis build: --metro builds '${rel}' into a module requiring ${ASSET_REGISTRY}, which the artifact doesn't carry`)
    }
    throw new Error(`stasis build: --metro found several ${ASSET_REGISTRY} for '${rel}', none of them nearest: ${[...roots].join(', ')}`)
  }
}
