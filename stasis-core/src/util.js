import { isUtf8 } from 'node:buffer'
import { basename, dirname, extname, isAbsolute, join, normalize, posix, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { ARCHIVE_ALGORITHM, CONFIG_FILE, NODE_FORMATS, isLockfileName } from './artifact-util.js'
import { diskHost } from './host.js'

export * from './artifact-util.js'

export const hexIntegrity = (algorithm, hex) => (typeof hex === 'string' && /^(?:[\da-f]{2})+$/u.test(hex) ? `${algorithm}-${Buffer.from(hex, 'hex').toString('base64')}` : undefined)
export const integrityHex = (integrity) => Buffer.from(integrity.slice(integrity.indexOf('-') + 1), 'base64').toString('hex')
export const archiveIntegrity = (ecosystem, hex) => hexIntegrity(ARCHIVE_ALGORITHM[ecosystem], hex)

// Where another package (stasis's run-installed.js) registers the reader of how packages were installed.
export const INSTALLED = Symbol.for('@exodus/stasis-core/installed')
// With `locate`, where they are recorded: a patch's carries its file, found and held to its hash, else refused.
export const installedAccounts = (modules, root, options) => (modules.size > 0 && globalThis[INSTALLED]?.(modules, root, options)) || new Map()

// JS_UNRESOLVED_EXTS (.js/.ts type/syntax-dependent, .jsx/.tsx transformed) classify as null, not a format.
const NODE_EXT_FORMATS = new Map([
  ['mjs', 'module'], ['cjs', 'commonjs'], ['json', 'json'],
  ['mts', 'module-typescript'], ['cts', 'commonjs-typescript'],
])
const JS_UNRESOLVED_EXTS = new Set(['js', 'ts', 'jsx', 'tsx'])
export const JS_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.jsx', '.tsx'])
export const CODE_EXTENSIONS = new Set([...NODE_EXT_FORMATS.keys(), ...JS_UNRESOLVED_EXTS])
// As Node spells them, by extname: `Foo.MJS` and a `.mjs` dotfile are none (require loads them as commonjs).
export const nodeExtFormat = (path) => NODE_EXT_FORMATS.get(extname(path).slice(1))

// The code Metro builds from source: the format its name gives it, else for JS or TS a generic one, its module type
// being Metro's to decide. As Node spells the extension, as nodeExtFormat does.
const GENERIC_EXT_FORMATS = new Map([['js', 'generic-javascript'], ['jsx', 'generic-javascript'], ['ts', 'generic-typescript'], ['tsx', 'generic-typescript']])
export const metroFormat = (path) => nodeExtFormat(path) ?? GENERIC_EXT_FORMATS.get(extname(path).slice(1))

export const pathExt = (filePath) => /\.([^./\\]+)$/.exec(filePath)?.[1].toLowerCase() ?? ''

// Off Windows `\` is no separator but part of a name, and a name holding one is refused rather than taken for another path.
export function toPosix(path) {
  if (sep === '\\') return path.replaceAll('\\', '/')
  if (path.includes('\\')) throw new Error(`stasis: a path holding '\\' is not supported: ${path}`)
  return path
}

// A `..` SEGMENT: a bare startsWith('..') would also reject a legitimate `..cache` name.
export const relativeEscapes = (rel) => rel === '..' || rel.startsWith('../') || rel.startsWith(`..${sep}`) || isAbsolute(rel)

// Lexical: resolve real paths first where symlinks matter.
export const isPathWithin = (base, path) => !relativeEscapes(relative(base, path))

// Both rules are needed: pathExt('.env.local') is 'local', and the extension rule alone misses `.env.*`.
export function isDotEnvFile(name) {
  const base = basename(name).toLowerCase()
  return base === '.env' || base.startsWith('.env.') || pathExt(base) === 'env'
}

// A dotted entry (`data.bin`) is rejected: a file with an extension is keyed by it and would never match.
export function parseResourcesOption(label, resources) {
  if (resources === undefined) return new Set()
  if (!Array.isArray(resources)) throw new TypeError(`${label}: resources must be an array of extension/filename strings`)
  const out = new Set()
  for (const entry of resources) {
    if (typeof entry !== 'string') throw new TypeError(`${label}: resources entry must be a string, got ${typeof entry}`)
    const clean = entry.toLowerCase().replace(/^\./, '')
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(clean)) {
      throw new Error(`${label}: resources entry '${entry}' is not a valid extension or filename (use e.g. 'png' or 'LICENSE')`)
    }
    if (CODE_EXTENSIONS.has(clean)) {
      throw new Error(`${label}: resources entry '${entry}' is a code extension; remove it (code extensions are always tracked)`)
    }
    out.add(clean)
  }
  return out
}

// `lock`'s in the order extract's error lists them.
export const LOCK_MODES = new Set(['frozen', 'add', 'replace', 'ignore', 'none'])
export const BUNDLE_MODES = new Set(['none', 'ignore', 'add', 'replace', 'load', 'frozen'])

export function memoized(fn, keyOf = (arg) => arg) {
  const cache = new Map()
  return (arg) => {
    const key = keyOf(arg)
    if (!cache.has(key)) cache.set(key, fn(arg))
    return cache.get(key)
  }
}

export const withoutBom = (text) => (text.charCodeAt(0) === 0xFE_FF ? text.slice(1) : text)

const unnegated = (entry) => (entry.startsWith('!') ? entry.slice(1) : entry)

// The config adds itself, so its files travel with it, unless an entry names it (`!stasis.config.json` too).
export function parseExtraOption(label, extra) {
  if (extra === undefined) return []
  if (!Array.isArray(extra)) throw new TypeError(`${label}: extra must be an array of paths or glob patterns`)
  for (const entry of extra) {
    if (typeof entry !== 'string' || entry === '') {
      throw new TypeError(`${label}: extra entry must be a non-empty string, got ${JSON.stringify(entry)}`)
    }
    if (entry === '!') throw new Error(`${label}: extra entry '!' needs a pattern to exclude (e.g. '!ios/Pods')`)
    if (relativeEscapes(normalize(unnegated(entry)))) {
      throw new Error(`${label}: extra entry '${entry}' must be a path or pattern within the project root`)
    }
  }
  return extra.some((entry) => extraPattern(entry) === CONFIG_FILE) ? [...extra] : [...extra, CONFIG_FILE]
}

export const extraPattern = (entry) => posix.normalize(unnegated(entry)).replace(/\/+$/u, '')

// Paths from the config's dir, which `../` may climb out of to a workspace root's.
export function parseLockfilesOption(label, lockfiles) {
  if (lockfiles === undefined) return undefined
  if (!Array.isArray(lockfiles) || lockfiles.length === 0) throw new TypeError(`${label}: lockfiles must be a non-empty array of paths`)
  const out = []
  for (const entry of lockfiles) {
    if (typeof entry !== 'string' || entry === '') {
      throw new TypeError(`${label}: lockfiles entry must be a non-empty string, got ${JSON.stringify(entry)}`)
    }
    // As every artifact path: `/`-separated, a `\` being no separator but part of a name.
    if (entry.includes('\\') || posix.isAbsolute(entry)) {
      throw new Error(`${label}: lockfiles entry '${entry}' must be a POSIX path relative to the directory holding ${CONFIG_FILE}`)
    }
    const path = posix.normalize(entry)
    if (path.endsWith('/') || path === '.' || path === '..' || path.endsWith('/..')) {
      throw new Error(`${label}: lockfiles entry '${entry}' must name a file`)
    }
    if (out.includes(path)) throw new Error(`${label}: lockfiles names ${path} twice`)
    out.push(path)
  }
  return out
}

export const isBrotliQuality = (n) => Number.isInteger(n) && n >= 0 && n <= 11

// `${n}` must round-trip to the input, so non-canonical forms ('5.0', '05', ' 5 ') throw.
export function parseBrotliQuality(name, value) {
  const n = Number(value)
  if (`${n}` !== value || !isBrotliQuality(n)) throw new RangeError(`${name} must be an integer 0..11 (got '${value}')`)
  return n
}

export const valueFlagsOf = (options) => Object.entries(options).filter(([, { type }]) => type === 'string')
  .flatMap(([name, { short }]) => (short === undefined ? [`--${name}`] : [`--${name}`, `-${short}`]))

// Stops at the first positional, so `run`'s forwarded child argv survives.
export function parseLeadingOptions(argv, options, { valueFlags = [], onError } = {}) {
  const takesValue = new Set(valueFlags)
  const flags = []
  while (argv.length > 0 && (argv[0].startsWith('-') || takesValue.has(flags.at(-1)))) flags.push(argv.shift())
  try {
    return parseArgs({ args: flags, options }).values
  } catch (cause) {
    onError(`Error: ${cause.message}`) // usage(), which exits
  }
}

export function classifyExtension(filePath, resources) {
  const format = classifyFormat(filePath)
  if (format === null || NODE_FORMATS.has(format)) return 'code'
  return inResources(filePath, resources) ? 'resource' : 'unknown'
}

// Resources with no `resources` entry: the toolchain versions a build reads and Bundler's settings, `.bundle/config`
// keyed by its dir too, as a bare `config` is too common a name.
const IMPLICIT_RESOURCE_NAMES = new Set(['.nvmrc', '.ruby-version'])
function isImplicitResource(path) {
  const base = basename(path).toLowerCase()
  return IMPLICIT_RESOURCE_NAMES.has(base) || (base === 'config' && basename(dirname(path)).toLowerCase() === '.bundle')
}

export const inResources = (path, resources) => resources.has(pathExt(path) || basename(path).toLowerCase()) || isImplicitResource(path)

// Non-deterministic across installs, so the native capture skips them; also matched on a dir (`*.framework`).
const NATIVE_ARTIFACT_EXTS = new Set([
  'a', 'so', 'o', 'obj', 'dylib', 'lib', 'dll', 'exe', 'pdb',
  'aar', 'jar', 'class', 'dex',
  'node',
  'framework', 'xcframework', 'dsym',
  'xcodeproj', 'xcworkspace',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z',
])
export const isNativeArtifact = (name) => NATIVE_ARTIFACT_EXTS.has(pathExt(name))

// Its bytes can't ride the text-only 'xml' format a `.plist` gets, so it needs `.plist` in `resources`.
export const isBinaryPlist = (name, content) => pathExt(name) === 'plist' && Buffer.isBuffer(content) && !isUtf8(content)

// Every value must be in KNOWN_FORMATS.
const CODE_EXT_FORMATS = new Map([
  ['sol', 'solidity'],
  ['php', 'php'],
  ['sh', 'shell'], ['bash', 'shell'],
  ['rs', 'rust'],
  ['teal', 'teal'],
  ['patch', 'patch'],
  ['java', 'java'],
  ['kt', 'kotlin'], ['kts', 'kotlin'],
  ['gradle', 'gradle'],
  ['m', 'objc'],
  ['mm', 'objcpp'],
  ['swift', 'swift'],
  ['c', 'c'],
  ['cc', 'cpp'], ['cxx', 'cpp'], ['cpp', 'cpp'], ['c++', 'cpp'],
  ['h', 'c-header'],
  ['hh', 'cpp-header'], ['hxx', 'cpp-header'], ['hpp', 'cpp-header'], ['h++', 'cpp-header'],
  ['rb', 'ruby'],
  ['py', 'python'], ['pyi', 'python'], ['pyw', 'python'],
  ['cmake', 'cmake'],
  ['podspec', 'podspec'],
  ['template', 'template'],
  ['xml', 'xml'], ['plist', 'xml'], ['xcprivacy', 'xml'], ['xcscheme', 'xml'],
  ['storyboard', 'xml'], ['entitlements', 'xml'], ['xcworkspacedata', 'xml'],
  ['env', 'env'],
  ['pbxproj', 'pbxproj'],
])

// By exact (lowercased) basename, where the extension is too generic to key (Podfile.lock, CMakeLists.txt).
const CODE_NAME_FORMATS = new Map([
  ['podfile', 'podfile'],
  ['podfile.lock', 'podfile-lock'],
  ['gemfile', 'gemfile'],
  ['gemfile.lock', 'gemfile-lock'],
  ['cmakelists.txt', 'cmake'],
  ['gradlew', 'shell'],
  ['appfile', 'fastlane'],
  ['fastfile', 'fastlane'],
  ['apple-app-site-association', 'json'],
])

const SHELL_SHEBANG = /^#![^\n]*\b(?:bash|sh)\b/u
const isShellShebang = (content) => Buffer.isBuffer(content) && isUtf8(content) && SHELL_SHEBANG.test(content.subarray(0, 256).toString('utf8'))

// Not build inputs, so the Metro native capture skips them. `flow` covers the `*.js.flow` sidecars.
const NATIVE_EXCLUDE_EXTS = new Set(['md', 'log', 'map', 'flow', 'swiftdoc'])
const NATIVE_EXCLUDE_NAMES = new Set([
  'license', 'licence', 'third-party-licenses',
  '.prettierrc', '.prettierignore', '.prettierrc.js', '.gitattributes', '.flowconfig', '.eslintignore',
  '.releaserc', '.clang-format', '.buckconfig', '.watchmanconfig', '.editorconfig', 'circle.yml', '.swiftlint.yml',
  'documentation.yml', // documentation.js config
  'yarn.lock',
  '.project', // Eclipse IDE metadata
  'gradle-wrapper.properties', // the APP's wrapper drives the build, not a module's own
])
export function isExcludedNativeFile(name, { win32 = process.platform === 'win32' } = {}) {
  if (NATIVE_EXCLUDE_NAMES.has(basename(name).toLowerCase())) return true
  const ext = pathExt(name)
  return NATIVE_EXCLUDE_EXTS.has(ext) || (!win32 && ext === 'bat')
}

// Compiled output (`ios-arm64`) at ANY depth. The PLATFORM segment is deliberately loose: the ARCH is the precision.
const APPLE_ARCH = String.raw`(?:arm64e|arm64_32|arm64|armv7k|armv7s|armv7|x86_64|i386)`
const APPLE_SLICE_DIR = new RegExp(String.raw`^[a-z0-9]+-${APPLE_ARCH}(?:_${APPLE_ARCH})*(?:-(?:simulator|maccatalyst))?$`, 'u')
export const isAppleSliceDir = (name) => APPLE_SLICE_DIR.test(name)

// Never a runtime module: the resolvers must refuse to land on one and fall through to the real `.js`.
export const isTypeDeclaration = (name) => /\.d\.[cm]?ts$/u.test(basename(name).toLowerCase())

// Absent on a first run but present on a later one, so a capture recording one conflicts on the next run.
export function isStasisArtifactName(name) {
  const base = basename(name).toLowerCase()
  return isLockfileName(base) || (base.includes('stasis') && base.endsWith('.br'))
}

// `name` is a BARE dir name, matched at any depth, so every walk agrees on what "not source" means.
const AUTO_EXCLUDED_DIRS = new Set([
  '.git', '.github', '.settings', // VCS / CI / IDE metadata
  'example', 'examples', // sample apps -- they import the package, they aren't it
  '__tests__', '__mocks__', 'jest', // test scaffolding
])
export function isAutoExcludedDir(name) {
  const base = name.toLowerCase()
  return AUTO_EXCLUDED_DIRS.has(base) || isAppleSliceDir(base)
}

// Type declarations are erased at runtime, the `.env` family holds secrets, stasis's outputs would attest
// themselves. Only a glob reaches this: a path NAMED is added as asked, the only way to attest one of these.
export const isAutoExcludedFile = (name) =>
  isTypeDeclaration(name) || isDotEnvFile(name) || isStasisArtifactName(name) || isExcludedNativeFile(name)

export function nameFormat(name) {
  const base = basename(name).toLowerCase()
  if (base === 'package.json' || base.endsWith('.podspec.json')) return 'json'
  if (base.endsWith('.cmake.in')) return 'cmake'
  return CODE_NAME_FORMATS.get(base)
}

// A format, null for a JS-family file, undefined if unrecognized.
export function classifyFormat(name, { content } = {}) {
  const byName = nameFormat(name)
  if (byName !== undefined) return byName
  const ext = pathExt(name)
  // A Node extension gives its format only as Node spells it (nodeExtFormat), else the loader decides.
  if (CODE_EXTENSIONS.has(ext)) return nodeExtFormat(name) ?? null
  return CODE_EXT_FORMATS.get(ext) ?? (ext === '' && isShellShebang(content) ? 'shell' : undefined)
}

export const extSetsEqual = (a, b) => a.size === b.size && a.isSubsetOf(b)

export const EXECUTE_BITS = 0o111

export const isExecutableMode = (stats) => stats.isFile() && (stats.mode & EXECUTE_BITS) !== 0

// `undefined`: the mode could NOT be observed (gone, EACCES, ELOOP, synthetic), no evidence of "not executable".
export function observeExecutable(abs, host = diskHost) {
  const stats = host.stat(abs)
  return stats === null ? undefined : isExecutableMode(stats)
}

// Windows reports no POSIX execute bits: "no bit" there is no evidence a POSIX capture's bit was removed.
export const canObserveExecuteBits = ({ win32 = process.platform === 'win32' } = {}) => !win32

// A crafted `link.sh -> /etc/passwd` must not pull an external file into an attestable bundle.
export function assertRealPathWithinBase(realBase, baseDir, relPath, host = diskHost) {
  const real = host.realpath(join(baseDir, relPath))
  if (!isPathWithin(realBase, real)) throw new Error(`Refusing to follow symlink escaping bundle root: ${relPath} -> ${real}`)
}
