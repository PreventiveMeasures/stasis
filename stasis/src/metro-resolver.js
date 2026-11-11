import { createRequire, isBuiltin } from 'node:module'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createMetroResolver as createRnMetroResolver, defaults } from '@preventive/rn/metro-resolver.js'
import { diskHost } from '@exodus/stasis-core/host'
import { isPlainObject, isTypeDeclaration } from '@exodus/stasis-core/util'
import { isDir, isSourceFile } from './resolve-typescript.js'

// Metro's module resolution is @preventive/rn's. What stays stasis's: no `.d.ts` is a module (metroHost), a builtin
// Metro misses is a builtin, and answers take the shape scan.js expects (scanResolution).

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

// Metro builds an asset of several files into the module of the lowest path (getArrayLowestItem).
const lowestPath = (paths) => paths.reduce((lowest, path) => (path < lowest ? path : lowest))

// `builtin`: whether a specifier Metro failed (null) is a Node builtin.
export function scanResolution(resolution, builtin) {
  if (resolution === null) return builtin ? { builtin: true } : null
  if (resolution.type === 'empty') return { empty: true }
  const file = resolution.type === 'sourceFile' ? resolution.filePath : lowestPath(resolution.filePaths)
  return { url: pathToFileURL(file).toString() }
}

// `--metro-resolver`: through the project's own `metro-resolver`, given the context Metro's DependencyGraph builds.
export function createMetroResolver({ projectDir, platform, sourceExts, mainFields, conditionNames, conditionsByPlatform, assetExts, assetResolutions, host = diskHost } = {}) {
  if (host !== diskHost) throw new Error('createMetroResolver: metro-resolver reads the disk, so it is not supported off disk')
  let metroResolver
  try {
    metroResolver = createRequire(join(projectDir, 'noop.js'))('metro-resolver')
  } catch (cause) {
    throw new Error(`StasisMetroResolver: couldn't load 'metro-resolver' from ${projectDir}. --metro-resolver resolves through the `
      + 'project\'s own Metro; install it (it ships with react-native/metro) or drop --metro-resolver to use the built-in resolver.', { cause })
  }
  const resolve = createRnMetroResolver({
    host: metroHost(host, mainFields), sourceExts, assetExts, assetResolutions, mainFields, conditionNames, conditionsByPlatform,
    preferNativePlatform: platform !== 'web', metroResolver,
  })
  // Metro splits `exports` on whether the edge is an ESM import: `import` in scan.js's format-derived conditions.
  return (parentFile, specifier, callConditions) => {
    const isESMImport = callConditions instanceof Set && callConditions.has('import')
    return scanResolution(resolve(parentFile, specifier, { platform, isESMImport }), isBuiltin(specifier))
  }
}
