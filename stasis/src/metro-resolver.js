import { createRequire, isBuiltin } from 'node:module'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createMetroResolver as createRnMetroResolver, defaults } from '@preventive/rn/metro-resolver.js'
import { diskHost } from '@exodus/stasis-core/host'
import { isTypeDeclaration, stripTypeDeclaration } from '@exodus/stasis-core/util'

// Metro's module resolution is @preventive/rn's (metro-resolver's own steps, over a host), for both
// `stasis bundle --metro` (resolve-fields.js) and `--metro --metro-resolver` (createMetroResolver
// below). What stays stasis's: no `.d.ts` is a module to it (metroHost), a Node builtin Metro misses
// is a builtin, and its answers take the shape scan.js expects of a custom resolver (scanResolution).

// A manifest as stasis has Metro read it: an entry field (one of `mainFields`) naming a `.d.ts` names
// its declaration-free stem instead, so the package's entry lands on the real module beside it
// (`dist/index.d.ts` -> `dist/index`, then `dist/index.js`). Any other manifest, or one that is no
// JSON object (which the resolver refuses), is read as it is.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const DECLARATION = /\.d\.[cm]?ts\b/iu
function manifestStems(bytes, mainFields) {
  let manifest
  try {
    const text = utf8.decode(bytes)
    if (!DECLARATION.test(text)) return bytes
    manifest = JSON.parse(text)
  } catch {
    return bytes
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return bytes
  const typed = mainFields.filter((field) => typeof manifest[field] === 'string' && isTypeDeclaration(manifest[field]))
  if (typed.length === 0) return bytes
  for (const field of typed) manifest[field] = stripTypeDeclaration(manifest[field])
  return Buffer.from(JSON.stringify(manifest))
}

// `host` (@exodus/stasis-core/host) as @preventive/rn reads one, for Metro's `mainFields`. A `.d.ts`
// is types-only, erased at runtime, so the resolver never lands on one: no `.d.ts` is a file, and a
// manifest's entry naming one names its stem (manifestStems).
export function metroHost(host, mainFields = defaults.mainFields) {
  return {
    isFile: (path) => !isTypeDeclaration(path) && (host.stat(path)?.isFile() ?? false),
    isDirectory: (path) => host.stat(path)?.isDirectory() ?? false,
    realpath: (path) => host.realpath(path),
    readFile: (path) => (basename(path) === 'package.json' ? manifestStems(host.readFile(path), mainFields) : host.readFile(path)),
  }
}

// The file Metro builds an asset of several into the module of (getArrayLowestItem): the lowest path.
const lowestPath = (paths) => paths.reduce((lowest, path) => (path < lowest ? path : lowest))

// @preventive/rn's Resolution of `specifier` (null where Metro fails it) as scan.js takes a custom
// resolver's answer:
//   { url }      resolved to a file, by its real path (file: URL string)
//   { empty }    a browser/react-native field mapped it to `false` (empty module)
//   { builtin }  a Node builtin Metro failed to resolve, where `builtin` says it is one
//   null         unresolved
export function scanResolution(resolution, builtin) {
  if (resolution === null) return builtin ? { builtin: true } : null
  if (resolution.type === 'empty') return { empty: true }
  const file = resolution.type === 'sourceFile' ? resolution.filePath : lowestPath(resolution.filePaths)
  return { url: pathToFileURL(file).toString() }
}

// `stasis bundle --metro --metro-resolver`: resolve through the PROJECT's own `metro-resolver`, so
// modules resolve exactly the way that project's installed Metro does. `metro-resolver` is a leaf of
// the Metro toolchain (it takes a context of filesystem callbacks and does no I/O of its own), so
// whichever copy the project ships is loaded and given the context Metro's DependencyGraph builds,
// over the disk (@preventive/rn's `metroResolver`). The options are Metro's resolver config, React
// Native's defaults where left out; Metro only prefers native suffixes off web. Metro carries no Node
// builtins, so a builtin it fails to resolve (one no browser map remaps) is reported as one.
export function createMetroResolver({ projectDir, platform, sourceExts, mainFields, conditionNames, conditionsByPlatform, assetExts, host = diskHost } = {}) {
  // It loads the project's metro-resolver, which reads the disk: never off it.
  if (host !== diskHost) throw new Error('createMetroResolver: metro-resolver reads the disk, so it is not supported off disk')
  let metroResolver
  try {
    metroResolver = createRequire(join(projectDir, 'noop.js'))('metro-resolver')
  } catch (cause) {
    throw new Error(
      `StasisMetroResolver: couldn't load 'metro-resolver' from ${projectDir}. --metro-resolver ` +
      'resolves through the project\'s own Metro; install it (it ships with react-native/metro) ' +
      'or drop --metro-resolver to use the built-in resolver.',
      { cause }
    )
  }
  const resolve = createRnMetroResolver({
    host: metroHost(host, mainFields),
    sourceExts,
    assetExts,
    mainFields,
    conditionNames,
    conditionsByPlatform,
    preferNativePlatform: platform !== 'web',
    metroResolver,
  })
  // Metro splits `exports` on whether the edge was an ESM import or a CJS require: scan.js hands over
  // the parent's format-derived condition set, so `import` in it is that signal.
  return (parentFile, specifier, callConditions) => {
    const isESMImport = callConditions instanceof Set && callConditions.has('import')
    return scanResolution(resolve(parentFile, specifier, { platform, isESMImport }), isBuiltin(specifier))
  }
}
