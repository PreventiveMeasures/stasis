import { isUtf8 } from 'node:buffer'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { NODE_FORMATS } from './artifact-util.js'
import { diskHost } from './host.js'

// The Node-side half of the util split: byte/name classification for the capture walks, fs/execute-bit
// observation and CLI parsing. The pure artifact data model lives in artifact-util.js, re-exported
// here so `@exodus/stasis-core/util` keeps serving the full set.
export * from './artifact-util.js'

// JS_UNRESOLVED_EXTS (.js/.ts type/syntax-dependent, .jsx/.tsx transformed) classify as null, not a format.
const NODE_EXT_FORMATS = new Map([
  ['mjs', 'module'], ['cjs', 'commonjs'], ['json', 'json'],
  ['mts', 'module-typescript'], ['cts', 'commonjs-typescript'],
])
const JS_UNRESOLVED_EXTS = new Set(['js', 'ts', 'jsx', 'tsx'])
export const CODE_EXTENSIONS = new Set([...NODE_EXT_FORMATS.keys(), ...JS_UNRESOLVED_EXTS])

export function pathExt(filePath) {
  const m = /\.([^./\\]+)$/.exec(filePath)
  return m ? m[1].toLowerCase() : ''
}

// A native path as the '/'-joined form every artifact key uses. Off Windows `\` is no separator but
// part of a name, and a name holding one is refused rather than taken for another path.
export function toPosix(path) {
  if (sep === '\\') return path.replaceAll('\\', '/')
  if (path.includes('\\')) throw new Error(`stasis: a path holding '\\' is not supported: ${path}`)
  return path
}

// Whether a path.relative() result climbs out of its base: absolute, or beginning with a `..`
// SEGMENT -- a bare startsWith('..') would also reject a legitimate `..cache` name.
export const relativeEscapes = (rel) => rel === '..' || rel.startsWith('../') || rel.startsWith(`..${sep}`) || isAbsolute(rel)

// True when `path` is `base` or lies beneath it. Lexical: resolve real paths first where symlinks matter.
export const isPathWithin = (base, path) => !relativeEscapes(relative(base, path))

// Both rules are needed: pathExt('.env.local') is 'local', and the extension rule alone misses `.env.*`.
export function isDotEnvFile(name) {
  const base = basename(name).toLowerCase()
  return base === '.env' || base.startsWith('.env.') || pathExt(base) === 'env'
}

// Entries are a bare extension (`png`) or extensionless filename (`LICENSE`); a dotted entry
// (`data.bin`) is rejected because a file with an extension is keyed by it and would never match.
export function parseResourcesOption(label, resources) {
  if (resources === undefined) return new Set()
  if (!Array.isArray(resources)) {
    throw new TypeError(`${label}: resources must be an array of extension/filename strings`)
  }
  const out = new Set()
  for (const entry of resources) {
    if (typeof entry !== 'string') {
      throw new TypeError(`${label}: resources entry must be a string, got ${typeof entry}`)
    }
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

export const isBrotliQuality = (n) => Number.isInteger(n) && n >= 0 && n <= 11

// `${n}` must round-trip to the input, so non-canonical forms ('5.0', '05', ' 5 ') throw.
export function parseBrotliQuality(name, value) {
  const n = Number(value)
  if (`${n}` !== value || !isBrotliQuality(n)) {
    throw new RangeError(`${name} must be an integer 0..11 (got '${value}')`)
  }
  return n
}

// Shifts the leading option tokens off `argv`, stopping at the first positional so `run`'s forwarded
// child argv survives. `valueFlags` lists options whose separate-token value (`-o dir`) isn't the positional.
export function parseLeadingOptions(argv, options, { valueFlags = [], onError } = {}) {
  const takesValue = new Set(valueFlags)
  const flags = []
  while (argv.length > 0 && (argv[0].startsWith('-') || takesValue.has(flags.at(-1)))) {
    flags.push(argv.shift())
  }
  try {
    return parseArgs({ args: flags, options }).values
  } catch (cause) {
    onError(`Error: ${cause.message}`) // usage(), which exits
    return undefined
  }
}

// The JS-graph bundlers' policy view over classifyFormat: only JS-family code (null or a NODE_FORMAT)
// counts as 'code'; native/source formats don't. Otherwise 'resource' if allowlisted, else 'unknown'.
export function classifyExtension(filePath, resources) {
  const format = classifyFormat(filePath)
  if (format === null || NODE_FORMATS.has(format)) return 'code'
  if (resources.has(pathExt(filePath) || basename(filePath).toLowerCase())) return 'resource'
  return 'unknown'
}

// Compiled/prebuilt artifacts, non-deterministic across installs, so the native capture skips them
// entirely. Matched on a file OR directory name (an Apple `*.framework`/`*.xcodeproj` bundle dir).
const NATIVE_ARTIFACT_EXTS = new Set([
  'a', 'so', 'o', 'obj', 'dylib', 'lib', 'dll', 'exe', 'pdb',
  'aar', 'jar', 'class', 'dex',
  'node',
  'framework', 'xcframework', 'dsym',
  'xcodeproj', 'xcworkspace',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z',
])
export function isNativeArtifact(name) {
  return NATIVE_ARTIFACT_EXTS.has(pathExt(name))
}

// An extensionless non-UTF-8 file is a compiled tool (Hermes' `hermesc`), never source -- skipped.
function isExtensionlessBinary(name, content) {
  return pathExt(name) === '' && Buffer.isBuffer(content) && !isUtf8(content)
}

// A binary plist is a real build input, but its bytes can't ride the text-only 'xml' format
// classifyFormat gives a `.plist`. Callers treat it as NOT code, so it needs `.plist` in `resources`.
export function isBinaryPlist(name, content) {
  return pathExt(name) === 'plist' && Buffer.isBuffer(content) && !isUtf8(content)
}

// Discovered by name: RN scatters podspecs in subdirs `react-native config` misses.
export function isPodspec(name) {
  return name.endsWith('.podspec') || name.endsWith('.podspec.json')
}

// Non-JS code formats by extension. Every value must be in KNOWN_FORMATS.
const CODE_EXT_FORMATS = new Map([
  ['sol', 'solidity'],
  ['php', 'php'],
  ['sh', 'shell'], ['bash', 'shell'],
  ['rs', 'rust'],
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

// Code formats by exact (lowercased) basename, for names whose extension is too generic to key
// (Podfile.lock's `.lock`, CMakeLists.txt's `.txt`).
const CODE_NAME_FORMATS = new Map([
  ['podfile', 'podfile'],
  ['podfile.lock', 'podfile-lock'],
  ['cmakelists.txt', 'cmake'],
  ['gradlew', 'shell'],
  ['appfile', 'fastlane'],
  ['fastfile', 'fastlane'],
  ['apple-app-site-association', 'json'],
])

// An extensionless script's format from its `#!` line, else undefined. Python is keyed on the interpreter
// itself: its path is often a virtualenv's, whose `sh`-named segment the looser shell match would take.
const SHELL_SHEBANG = /^#![^\n]*\b(?:bash|sh)\b/u
const PYTHON_INTERPRETER = /^python(?:\d+(?:\.\d+)*)?$/u
function shebangFormat(content) {
  if (!Buffer.isBuffer(content)) return undefined
  const line = content.subarray(0, 256).toString('utf8').split('\n', 1)[0]
  // `#!` first: a file without one never pays for the whole-buffer UTF-8 scan.
  if (!line.startsWith('#!') || !isUtf8(content)) return undefined
  if (PYTHON_INTERPRETER.test(shebangInterpreter(line))) return 'python'
  return SHELL_SHEBANG.test(line) ? 'shell' : undefined
}

// env options whose value is the next word: a short cluster ending in GNU `-u NAME`/`-C DIR` or BSD
// `-P PATH` (not one holding its value, `-uNAME`), or GNU's `--unset NAME`/`--chdir DIR`.
const ENV_VALUE_OPTION = /^(?:-[^-uCP]*[uCP]|--unset|--chdir)$/u

// The escapes `env -S` takes outside '…' (where only `\\` and `\'` escape).
const ENV_ESCAPES = { '"': '"', "'": "'", '\\': '\\', '#': '#', $: '$', _: ' ', n: '\n', t: '\t', r: '\r', f: '\f', v: '\v' }

// The words an `env -S` string splits into, as GNU env splits it: whitespace (and `\_` outside "…")
// breaks words outside quotes, quotes and escapes join and unquote, and `\c` outside "…" or a word
// opening with `#` ends it. null for a string env refuses: an unterminated quote, or an unknown or
// trailing `\`.
function splitEnvString(text) {
  const words = []
  let word = null
  let quote = null
  const flush = () => {
    if (word !== null) words.push(word)
    word = null
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c === '\\' && (text[i + 1] === '\\' || text[i + 1] === "'") ? text[++i] : c
    } else if (c === '\\') {
      const escape = text[++i]
      if (quote === null && escape === 'c') break
      if (quote === null && escape === '_') flush()
      else if (Object.hasOwn(ENV_ESCAPES, escape)) word = (word ?? '') + ENV_ESCAPES[escape]
      else return null
    } else if (quote === '"') {
      if (c === '"') quote = null
      else word += c
    } else if (/\s/u.test(c)) {
      flush()
    } else if (c === '#' && word === null) {
      break
    } else if (c === "'" || c === '"') {
      quote = c
      word ??= ''
    } else {
      word = (word ?? '') + c
    }
  }
  if (quote !== null) return null
  flush()
  return words
}

// The program a `#!` line runs: its basename, or the command `env` runs past its options (with their
// values, up to `--` or the first other word, as getopt reads them) and then its assignments
// (`#!/usr/bin/env -S -u PYTHONPATH FOO="a b" python3 -u` -> `python3`). Only `-S` has env split the
// rest itself; without it, Linux hands env the rest as one word and macOS splits it at whitespace, so
// this splits as macOS does, the kernel where more than one word runs.
function shebangInterpreter(line) {
  const [, program, rest] = /^(\S*)\s*(.*)$/su.exec(line.slice(2).trim())
  const name = program.slice(program.lastIndexOf('/') + 1)
  if (name !== 'env') return name
  const split = /^(?:-S|--split-string=)(.*)$/su.exec(rest)
  const args = split === null ? rest.split(/\s+/u) : (splitEnvString(split[1]) ?? [])
  let i = 0
  for (; i < args.length && args[i].startsWith('-'); i++) {
    if (args[i] === '--') {
      i++
      break
    }
    if (ENV_VALUE_OPTION.test(args[i])) i++
  }
  while (i < args.length && args[i].includes('=')) i++
  return args[i] ?? ''
}

// Files a native package ships that are NOT build inputs (docs/legal, editor/lint/CI config, logs,
// sidecars), excluded from the Metro native capture. `flow` covers the `*.js.flow` sidecars.
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

export function isExcludedNativeDir(name, { win32 = process.platform === 'win32' } = {}) {
  return !win32 && name === 'windows'
}

// An Apple prebuilt-slice dir (`ios-arm64`, `tvos-arm64_x86_64-simulator`): compiled output, not source,
// at ANY depth. The PLATFORM segment is deliberately loose -- the required ARCH segment is the precision.
const APPLE_ARCH = String.raw`(?:arm64e|arm64_32|arm64|armv7k|armv7s|armv7|x86_64|i386)`
const APPLE_SLICE_DIR = new RegExp(
  String.raw`^[a-z0-9]+-${APPLE_ARCH}(?:_${APPLE_ARCH})*(?:-(?:simulator|maccatalyst))?$`,
  'u'
)
export function isAppleSliceDir(name) {
  return APPLE_SLICE_DIR.test(name)
}

// Types only, never a runtime module: the resolvers must refuse to land on one and fall through to the
// real `.js`. Keyed by compound suffix -- pathExt only sees the trailing `ts`.
const TYPE_DECLARATION_SUFFIXES = ['.d.ts', '.d.mts', '.d.cts']
export function isTypeDeclaration(name) {
  const base = basename(name).toLowerCase()
  return TYPE_DECLARATION_SUFFIXES.some((suffix) => base.endsWith(suffix))
}

export function stripTypeDeclaration(name) {
  const lower = name.toLowerCase()
  const suffix = TYPE_DECLARATION_SUFFIXES.find((s) => lower.endsWith(s))
  return suffix === undefined ? name : name.slice(0, -suffix.length)
}

// stasis's own outputs (`stasis.lock.json`, a `*stasis*.br`): absent on a first run but present on a
// later one, so a listing (`--fs` readdir) or a sweep (`add .`) that records one diverges between runs
// and the later capture conflicts.
export function isStasisArtifactName(name) {
  const base = basename(name).toLowerCase()
  return base === 'stasis.lock.json' || (base.includes('stasis') && base.endsWith('.br'))
}

// Dirs no walk descends into: VCS/CI/IDE metadata, sample apps, test scaffolding -- none of it is the
// code being shipped -- plus the Apple prebuilt slice dirs. `name` is a BARE dir name (a dirent name
// or path segment), matched at any depth, so every walk agrees on what "not source" means.
const AUTO_EXCLUDED_DIRS = new Set([
  '.git', '.github', '.settings', // VCS / CI / IDE metadata
  'example', 'examples', // sample apps -- they import the package, they aren't it
  '__tests__', '__mocks__', 'jest', // test scaffolding
])
export function isAutoExcludedDir(name) {
  const base = name.toLowerCase()
  return AUTO_EXCLUDED_DIRS.has(base) || isAppleSliceDir(base)
}

// Dirs the NATIVE walks (Metro plugin + the static --metro bundler) skip, on top of the shared set:
// nested packages (attested separately) and regenerated build output -- none is a build input.
const NATIVE_BUILD_OUTPUT_DIRS = new Set(['node_modules', 'build', '.gradle', '.cxx', 'Pods', 'DerivedData'])
export function isSkippedNativeWalkDir(name) {
  return NATIVE_BUILD_OUTPUT_DIRS.has(name) || isAutoExcludedDir(name) || isNativeArtifact(name)
}

// Files a sweep drops: type declarations (types only, erased at runtime), the `.env` family (secrets),
// stasis's own outputs (they'd attest themselves), and everything the native capture excludes as
// non-build-input noise (docs/legal, editor/lint/CI config, `*.map`/`*.js.flow` sidecars, logs).
// A path can only reach this via a glob -- an EXPLICITLY named one is added as asked (`add .env` still
// captures), which is also the only way to attest a file this set covers.
export function isAutoExcludedFile(name) {
  return isTypeDeclaration(name) || isDotEnvFile(name) || isStasisArtifactName(name) || isExcludedNativeFile(name)
}

// The single name->format classifier every capture path is a policy view of. Returns a concrete format
// when the name determines one; null for a JS-family file (.js/.ts/.jsx/.tsx); undefined if unrecognized.
export function classifyFormat(name, { content } = {}) {
  const base = basename(name).toLowerCase()
  // Before the extension rules, so a `*.podspec.json` isn't shadowed.
  if (base === 'package.json' || base.endsWith('.podspec.json')) return 'json'
  // Compound suffix: pathExt only sees the trailing `in`.
  if (base.endsWith('.cmake.in')) return 'cmake'
  const byName = CODE_NAME_FORMATS.get(base)
  if (byName !== undefined) return byName
  const ext = pathExt(name)
  if (JS_UNRESOLVED_EXTS.has(ext)) return null
  const byExt = NODE_EXT_FORMATS.get(ext) ?? CODE_EXT_FORMATS.get(ext)
  if (byExt !== undefined) return byExt
  if (ext === '') return shebangFormat(content)
  return undefined
}

// The Metro native capture's policy view. Returns { action, format }: 'code' (a native build input),
// 'skip' (excluded noise, or a JS-family file matched BY EXTENSION -- Metro owns those), else 'resource'.
export function classifyNativeCapture(name, { win32 = process.platform === 'win32', content } = {}) {
  // `.env` files carry secrets: an automated capture must never sweep them in.
  if (isExcludedNativeFile(name, { win32 }) || isDotEnvFile(name)) return { action: 'skip' }
  const base = basename(name).toLowerCase()
  // Name-matched code is always a native build input, even when its tag is a Node format the JS
  // graph would otherwise own.
  if (base === 'package.json' || base.endsWith('.podspec.json')) return { action: 'code', format: 'json' }
  const byName = CODE_NAME_FORMATS.get(base)
  if (byName !== undefined) return { action: 'code', format: byName }
  if (CODE_EXTENSIONS.has(pathExt(name))) return { action: 'skip' }
  const format = classifyFormat(name, { content })
  return format === undefined ? { action: 'resource' } : { action: 'code', format }
}

// The byte-level half of the native classification, refining what classifyNativeCapture derived from the
// NAME: the binary rules demote, and a resource whose bytes name a format (an extensionless script's
// shebang) is promoted to code, as classifyFormat tags it. A 'resource' carries no format: storage
// derives base64 from bytes.
export function refineNativeCapture(classified, name, content, resources = new Set()) {
  if (isExtensionlessBinary(name, content)) return { action: 'skip' }
  if (isBinaryPlist(name, content)) return { action: resources.has('plist') ? 'resource' : 'skip' }
  if (classified.action === 'resource') {
    const format = classifyFormat(name, { content })
    if (format != null) return { action: 'code', format }
  }
  return classified
}

// Files `pod install` reads while loading podspecs (Ruby helpers, package.json) -- NOT the native
// source those podspecs compile.
export function isNativeManifest(name) {
  return isPodspec(name) || pathExt(name) === 'rb' || name === 'package.json'
}

// RN core build scripts the native walk would defer to Metro as `.js`, but Metro never sees them (RN's
// podspecs invoke them at pod-install). Project-relative, so react-native's `exports` can't hide them.
export const RN_CORE_INCLUDE_FILES = ['sdks/hermes-engine/utils/replace_hermes_version.js']

export const extSetsEqual = (a, b) => a.size === b.size && [...a].every((ext) => b.has(ext))

export const EXECUTE_BITS = 0o111

export const isExecutableMode = (stats) => stats.isFile() && (stats.mode & EXECUTE_BITS) !== 0

// Tri-state: `undefined` means the mode could NOT be observed (gone mid-run, EACCES, ELOOP, a synthetic
// bundle entry). Callers must not read that as "not executable" -- failing to look is not evidence.
export function observeExecutable(abs, host = diskHost) {
  const stats = host.stat(abs)
  return stats === null ? undefined : isExecutableMode(stats)
}

// Boolean view for callers with nothing to refute (recording a fresh set from scratch).
export const isExecutableFile = (abs, host) => observeExecutable(abs, host) === true

// Windows reports no POSIX execute bits, so a capture there records none and must NOT read "no bit" as
// "the bit was removed" and strip what a POSIX capture attested.
export const canObserveExecuteBits = ({ win32 = process.platform === 'win32' } = {}) => !win32

// Throws on a symlink escaping the bundle root: a crafted `link.sh -> /etc/passwd` must not pull an
// external file into an attestable bundle. realpath surfaces ENOENT, which loaders treat as "missing".
export function assertRealPathWithinBase(realBase, baseDir, relPath, host = diskHost) {
  const real = host.realpath(join(baseDir, relPath))
  if (!isPathWithin(realBase, real)) {
    throw new Error(`Refusing to follow symlink escaping bundle root: ${relPath} -> ${real}`)
  }
}
