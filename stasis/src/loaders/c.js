// C/C++ loader: the preprocessor's include graph of a set of translation units (or headers), as
// `{ sources, formats, resolutions, missing, computed, conflicts }`. Nothing is compiled or
// preprocessed: `#include`/`#import`/`#include_next`/`#embed` lines are found by a scan that skips
// comments and literals, and resolved the way GCC and Clang search for them -- the includer's
// directory for a quoted name, then the `-iquote`, `-I`, `-isystem` and `-idirafter` directories of
// the translation unit's compile command (compile_commands.json) or `--include-dirs`. Headers hold
// code too (inline functions, templates, macros), so an include lands on the header itself, and a
// header pulls in its implementation file -- the source of the same name beside it, or in the `src/`
// mirroring an `include/` -- so what a program links is bundled along with what it includes.

import { isUtf8 } from 'node:buffer'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'

import { assertRealPathWithinBase, classifyFormat, isAutoExcludedDir, isDotEnvFile, relativeEscapes, toPosix } from '@exodus/stasis-core/util'
import { isDir, isFile } from '../resolve-typescript.js'

export const C_SOURCE_EXTS = new Set(['.c', '.cc', '.cpp', '.cxx', '.c++'])
export const C_HEADER_EXTS = new Set(['.h', '.hh', '.hpp', '.hxx', '.h++'])

// A C/C++ bundle's entry: a translation unit, or a header (a header-only library's).
export const isCEntry = (path) => C_SOURCE_EXTS.has(extname(path)) || C_HEADER_EXTS.has(extname(path))

const C_FAMILY_FORMATS = new Set(['c', 'cpp', 'c-header', 'cpp-header'])
const CPP_FORMATS = new Set(['cpp', 'cpp-header'])

// A file's format: by its extension when that names a C/C++ one, else (`.inl`, `.inc`, Eigen's
// extensionless `Core`) a header of its includer's language.
export function cFormatOf(path, includerFormat) {
  const format = classifyFormat(path)
  if (C_FAMILY_FORMATS.has(format)) return format
  return CPP_FORMATS.has(includerFormat) ? 'cpp-header' : 'c-header'
}

// --- Scanning ---------------------------------------------------------------------------------

const INCLUDE_DIRECTIVES = new Set(['include', 'import', 'include_next', 'embed'])
const RAW_STRING_PREFIXES = new Set(['R', 'LR', 'uR', 'UR', 'u8R'])
const IDENTIFIER = /[A-Za-z_$][\w$]*/uy
// A pp-number, digit separators (`1'000`) and exponent signs included.
const PP_NUMBER = /\.?\d(?:[eEpP][+-]|['\w.])*/uy
const HSPACE = new Set([' ', '\t', '\r', '\f', '\v'])

// Region states, from surest to deadest: code always compiled, code some configuration compiles,
// code none does (`#if 0`).
const RANK = { dead: 0, maybe: 1, live: 2 }
const meet = (a, b) => (RANK[a] <= RANK[b] ? a : b)

// The state of a conditional branch whose condition is `cond` (true, false or undefined: not
// decidable), `taken` telling whether an earlier branch of its group was ('yes', 'no', 'maybe').
function branchState(parent, taken, cond) {
  if (taken === 'yes' || cond === false) return 'dead'
  if (cond === true && taken === 'no') return parent
  return meet(parent, 'maybe')
}

function nextTaken(taken, cond) {
  if (cond === true) return 'yes'
  if (cond === undefined && taken === 'no') return 'maybe'
  return taken
}

// An `#if`/`#elif` condition's value where it is an integer literal (`#if 0`, `#if 1`), else
// undefined: macros aren't evaluated, so whatever names one could go either way.
function evalCondition(expr) {
  const m = /^\(*\s*(\d+)[uUlL]*\s*\)*$/u.exec(expr.trim())
  return m ? Number(m[1]) !== 0 : undefined
}

// `#ifndef X` / `#if !defined(X)`: the macro name, the candidate include guard.
function guardName(name, expr) {
  if (name === 'ifndef') return /^\s*(\w+)\s*$/u.exec(expr)?.[1]
  if (name === 'if') return /^\s*!\s*defined\s*(?:\(\s*(\w+)\s*\)|(\w+))\s*$/u.exec(expr)?.slice(1).find(Boolean)
  return undefined
}

// The include-like directives of C/C++ source `text`, each `{ directive, form, path, state }`:
// `directive` one of include/import/include_next/embed, `form` 'quote' ("x"), 'angle' (<x>) or
// 'macro' (a computed include, `path` the macro's name), `state` 'live' where every configuration
// compiles it, 'maybe' inside a conditional the scan can't decide (`#ifdef _WIN32`). Ones in code
// no configuration compiles (`#if 0`, its `#else` of an `#if 1`) are left out. A file's include
// guard (`#ifndef X` then `#define X` as its first directives) isn't a condition. Comments, string
// and character literals (C++ raw strings, digit separators) are skipped, lines spliced with a
// backslash joined, and a directive is `#` (or `%:`) first on its line, as in translation phase 4.
export function scanIncludes(source) {
  const s = source.replaceAll(/\\\r?\n/gu, '')
  const n = s.length
  const out = []
  const stack = []
  let state = 'live'
  let directives = 0
  let guard = null // { frame, name } of the first directive, an #ifndef, until the next one

  const skipBlockComment = (i) => {
    const end = s.indexOf('*/', i + 2)
    return end === -1 ? n : end + 2
  }
  const lineEnd = (i) => {
    const end = s.indexOf('\n', i)
    return end === -1 ? n : end
  }
  // Past a quoted literal starting at `i`; an unterminated one (an apostrophe in prose under
  // `#if 0`) ends at its line.
  const skipQuoted = (i) => {
    const q = s[i]
    for (let j = i + 1; j < n; j++) {
      const c = s[j]
      if (c === '\\') j++
      else if (c === q) return j + 1
      else if (c === '\n') return j
    }
    return n
  }
  // Horizontal space and comments inside a directive (a block comment may run over lines).
  const skipSpace = (i) => {
    for (;;) {
      if (HSPACE.has(s[i])) i++
      else if (s.startsWith('/*', i)) i = skipBlockComment(i)
      else return i
    }
  }
  // The rest of a directive's line from `i`, comments replaced by a space; ends at its newline,
  // which a block comment may push past.
  const restOfLine = (i) => {
    let text = ''
    while (i < n && s[i] !== '\n') {
      if (s.startsWith('/*', i)) {
        i = skipBlockComment(i)
        text += ' '
      } else if (s.startsWith('//', i)) {
        i = lineEnd(i)
      } else if (s[i] === '"' || s[i] === "'") {
        const end = skipQuoted(i)
        text += s.slice(i, end)
        i = end
      } else {
        text += s[i++]
      }
    }
    return { text, end: i }
  }

  const directive = (i) => {
    i = skipSpace(i)
    IDENTIFIER.lastIndex = i
    const name = IDENTIFIER.exec(s)?.[0]
    if (name === undefined) return lineEnd(i) // a null directive, or `# 12 "file"` line markers
    i += name.length
    // `#pragma once` before a guard leaves it the file's first directive.
    if (name !== 'pragma') directives++
    const guarding = guard
    guard = null
    if (INCLUDE_DIRECTIVES.has(name)) {
      i = skipSpace(i)
      const open = s[i]
      const close = open === '"' ? '"' : open === '<' ? '>' : null
      if (close !== null) {
        const end = s.indexOf(close, i + 1)
        if (end !== -1 && end < lineEnd(i) && end > i + 1) {
          if (state !== 'dead') out.push({ directive: name, form: open === '"' ? 'quote' : 'angle', path: s.slice(i + 1, end), state })
          return restOfLine(end + 1).end
        }
      } else {
        IDENTIFIER.lastIndex = i
        const macro = IDENTIFIER.exec(s)?.[0]
        if (macro !== undefined && state !== 'dead') out.push({ directive: name, form: 'macro', path: macro, state })
      }
      return restOfLine(i).end
    }
    const { text, end } = restOfLine(i)
    switch (name) {
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        const cond = name === 'if' ? evalCondition(text) : undefined
        const frame = { parent: state, taken: nextTaken('no', cond) }
        stack.push(frame)
        state = branchState(frame.parent, 'no', cond)
        const macro = directives === 1 ? guardName(name, text) : undefined
        if (macro !== undefined) guard = { frame, name: macro }
        break
      }
      case 'elif':
      case 'elifdef':
      case 'elifndef':
      case 'else': {
        const frame = stack.at(-1)
        if (frame === undefined) break
        const cond = name === 'else' ? true : name === 'elif' ? evalCondition(text) : undefined
        state = branchState(frame.parent, frame.taken, cond)
        frame.taken = nextTaken(frame.taken, cond)
        break
      }
      case 'endif':
        if (stack.length > 0) state = stack.pop().parent
        break
      case 'define':
        // `#define X` right after a first `#ifndef X`: the include guard, whose body is the file.
        if (guarding !== null && stack.at(-1) === guarding.frame && /^\s*(\w+)/u.exec(text)?.[1] === guarding.name) {
          guarding.frame.taken = 'yes'
          state = guarding.frame.parent
        }
        break
      default:
    }
    return end
  }

  let atLineStart = true
  let i = 0
  while (i < n) {
    const c = s[i]
    if (c === '\n') {
      atLineStart = true
      i++
    } else if (HSPACE.has(c)) {
      i++
    } else if (s.startsWith('/*', i)) {
      i = skipBlockComment(i)
    } else if (s.startsWith('//', i)) {
      i = lineEnd(i)
    } else if (atLineStart && (c === '#' || s.startsWith('%:', i))) {
      i = directive(i + (c === '#' ? 1 : 2))
    } else {
      atLineStart = false
      if (c === '"' || c === "'") {
        i = skipQuoted(i)
        continue
      }
      PP_NUMBER.lastIndex = i
      const number = PP_NUMBER.exec(s)
      if (number !== null) {
        i += number[0].length
        continue
      }
      IDENTIFIER.lastIndex = i
      const word = IDENTIFIER.exec(s)?.[0]
      if (word === undefined) {
        i++
      } else if (s[i + word.length] === '"' && RAW_STRING_PREFIXES.has(word)) {
        // R"delim( ... )delim": nothing in it is a comment, a quote or a directive.
        const open = i + word.length + 1
        const paren = s.indexOf('(', open)
        const delim = paren === -1 ? null : s.slice(open, paren)
        const end = delim === null || delim.length > 16 || /[\s()\\]/u.test(delim) ? -1 : s.indexOf(`)${delim}"`, paren + 1)
        i = end === -1 ? open : end + delim.length + 2
      } else {
        i += word.length
      }
    }
  }
  return out
}

// An include's key in the bundle's import map: the directive as written, `include "x.h"`,
// `include <x.h>`, `include_next <x.h>`, `embed "x.bin"`; a computed one by its macro.
export const includeSpec = ({ directive, form, path }) => `${directive} ${form === 'quote' ? `"${path}"` : form === 'angle' ? `<${path}>` : path}`

// --- Search paths -----------------------------------------------------------------------------

// A search directory: `{ rel }` inside the bundle root (POSIX, '' for the root itself), or `{ abs }`
// outside it, where headers are only ever looked up -- a hit there is a system or out-of-tree header,
// never read or bundled.
function makeDir(baseDir, realBase, abs) {
  for (const root of [baseDir, realBase]) {
    const rel = toPosix(relative(root, abs))
    if (!relativeEscapes(rel)) return { rel: rel === '.' ? '' : rel }
  }
  return { abs }
}

// A translation unit's search context: `quote` the -iquote dirs, `angle` the -I, -isystem and
// -idirafter ones in that order (what both forms search after the quote ones), `embed` the
// --embed-dir ones, `forced` the -include/-imacros files, as `{ flag, path, dir }`. `id` tells
// contexts apart: a header is walked once per context it is reached in.
function makeContext({ quote = [], I = [], system = [], after = [], embed = [], forced = [] } = {}, includeDirs = []) {
  const ctx = { quote, angle: [...I, ...includeDirs, ...system, ...after], embed, forced }
  ctx.id = JSON.stringify(ctx)
  return ctx
}

// `args` (a compile command's argv) read for its include search flags, GCC's and Clang's (clang-cl's
// and cl's too where `cl` says the driver is one), each dir resolved against `directory`.
function includeFlags(args, directory, toDir, cl) {
  const flags = { quote: [], I: [], system: [], after: [], embed: [], forced: [] }
  const dir = (value, list) => {
    // `-I=dir` is relative to the sysroot: a system directory.
    if (value !== undefined && value !== '' && value !== '-' && !value.startsWith('=')) list.push(toDir(resolve(directory, value)))
  }
  const file = (flag, value) => {
    if (value !== undefined && value !== '') flags.forced.push({ flag, path: value, dir: toDir(directory) })
  }
  // Options whose value is the next argument, which is never a flag of its own.
  const SEPARATE = new Set(['-o', '-x', '-MF', '-MT', '-MQ', '-Xclang', '-Xpreprocessor', '-include-pch', '-iprefix', '-iwithprefix', '-iwithprefixbefore', '-isysroot', '--sysroot', '-target', '-arch', '-D', '-U', '-imultilib'])
  for (let k = 1; k < args.length; k++) {
    const a = args[k]
    if (SEPARATE.has(a)) {
      k++
      continue
    }
    // Longest flag first: `-isystem-after` before `-isystem`, `-include-pch` before `-include`.
    const take = (flag) => {
      if (a === flag) return args[++k]
      return a.startsWith(flag) ? a.slice(flag.length) : undefined
    }
    let v
    if (a.startsWith('-include-pch')) continue
    if ((v = take('--include-directory-after=')) !== undefined || (v = take('-idirafter')) !== undefined || (v = take('-isystem-after')) !== undefined) dir(v, flags.after)
    else if ((v = take('--include-directory=')) !== undefined || (v = take('--include-directory')) !== undefined) dir(v, flags.I)
    else if ((v = take('-iquote')) !== undefined) dir(v, flags.quote)
    else if ((v = take('-cxx-isystem')) !== undefined || (v = take('-isystem')) !== undefined) dir(v, flags.system)
    else if ((v = take('--embed-dir=')) !== undefined || (v = take('--embed-dir')) !== undefined) dir(v, flags.embed)
    else if ((v = take('-imacros')) !== undefined) file('-imacros', v)
    else if ((v = take('--include=')) !== undefined || (v = take('--include')) !== undefined || (v = take('-include')) !== undefined) file('-include', v)
    else if ((v = take('-I')) !== undefined) dir(v, flags.I)
    else if (cl && ((v = take('/external:I')) !== undefined || (v = take('-external:I')) !== undefined)) dir(v, flags.system)
    else if (cl && (v = take('/I')) !== undefined) dir(v, flags.I)
    else if (cl && ((v = take('/FI')) !== undefined || (v = take('-FI')) !== undefined)) file('/FI', v)
  }
  return flags
}

// A compile command string split into its arguments as a POSIX shell splits words: quotes, and a
// backslash escaping the next character (inside double quotes, only `"`, `\`, `$` and a backquote).
export function splitCommand(command) {
  const args = []
  let word = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      word = (word ?? '') + command.slice(i + 1, end === -1 ? command.length : end)
      i = end === -1 ? command.length : end
    } else if (c === '"') {
      word ??= ''
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === '\\' && '"\\$`'.includes(command[i + 1] ?? '')) i++
        word += command[i]
      }
    } else if (c === '\\') {
      word = (word ?? '') + (command[++i] ?? '')
    } else if (/\s/u.test(c)) {
      if (word !== null) args.push(word)
      word = null
    } else {
      word = (word ?? '') + c
    }
  }
  if (word !== null) args.push(word)
  return args
}

// The compilation database at `file` (a compile_commands.json, or the directory holding one),
// relative to `baseDir`: each translation unit inside the bundle root, by project-relative path, to
// its include search flags (includeFlags). The first command of a file counts, as clangd takes it.
// The database is configuration, read wherever it is, never bundled.
export function loadCompileCommands(baseDir, file) {
  let path = resolve(baseDir, file)
  if (isDir(path)) path = join(path, 'compile_commands.json')
  let text
  try {
    text = readFileSync(path)
  } catch (cause) {
    throw new Error(`Can't read the compilation database ${file}: ${cause.code ?? cause.message}`, { cause })
  }
  if (!isUtf8(text)) throw new Error(`Compilation database is not valid UTF-8: ${file}`)
  let json
  try {
    json = JSON.parse(text.toString('utf8'))
  } catch {
    throw new Error(`Compilation database is not valid JSON: ${file}`)
  }
  if (!Array.isArray(json)) throw new Error(`Compilation database is not an array of commands: ${file}`)
  const realBase = realpathSync(baseDir)
  const toDir = (abs) => makeDir(baseDir, realBase, abs)
  const commands = new Map()
  for (const [index, entry] of json.entries()) {
    const bad = (why) => new Error(`Compilation database ${file}: command ${index} ${why}`)
    if (entry === null || typeof entry !== 'object') throw bad('is not an object')
    if (typeof entry.directory !== 'string' || typeof entry.file !== 'string') throw bad('has no `directory` and `file` strings')
    const args = Array.isArray(entry.arguments) ? entry.arguments : typeof entry.command === 'string' ? splitCommand(entry.command) : null
    if (args === null || !args.every((a) => typeof a === 'string')) throw bad('has neither an `arguments` array of strings nor a `command` string')
    const directory = resolve(dirname(path), entry.directory)
    const unit = toDir(resolve(directory, entry.file))
    if (unit.rel === undefined || commands.has(unit.rel)) continue
    const cl = /^(?:clang-)?cl(?:\.exe)?$/iu.test(basename(args[0] ?? '').replaceAll('\\', '/').split('/').at(-1))
    commands.set(unit.rel, includeFlags(args, directory, toDir, cl))
  }
  return commands
}

// --- Known projects ---------------------------------------------------------------------------

// Known projects' include directories, so a tree vendoring them (Node.js and its deps/, V8 and its
// third_party/) is searched as its build searches it, with no -I given. A directory holding every
// `marker` file is such a project's root; `include` are the -I directories its own sources are
// built with, `exports` those it gives the projects using it, all from its root (one that isn't
// there is skipped). `wraps` names a directory holding another known project that this one builds
// with its own include directories (Node.js's deps/openssl around OpenSSL's tree), which is then
// this one's. Where a project carries configurations for several platforms, Linux's is taken.
export const KNOWN_PROJECTS = [
  { name: 'Node.js', marker: ['src/node.h', 'src/node_main.cc'], include: ['src'], exports: ['src'] },
  { name: 'V8', marker: ['include/v8.h', 'src/api/api.cc'], include: ['.', 'include'], exports: ['include'] },
  { name: 'Abseil', marker: ['absl/base/config.h'], include: ['.'], exports: ['.'] },
  { name: 'Highway', marker: ['hwy/highway.h'], include: ['.'], exports: ['.'] },
  { name: 'simdutf', marker: ['simdutf.h', 'simdutf.cpp'], include: ['.'], exports: ['.'] },
  { name: 'FP16', marker: ['src/include/fp16.h'], include: ['src/include'], exports: ['src/include'] },
  { name: 'Dragonbox', marker: ['src/include/dragonbox/dragonbox.h'], include: ['src/include'], exports: ['src/include'] },
  { name: 'fast_float', marker: ['src/include/fast_float/fast_float.h'], include: ['src/include'], exports: ['src/include'] },
  { name: 'LLVM libc', marker: ['src/__support/common.h', 'shared/math.h'], include: ['.'], exports: ['.'] },
  {
    name: 'OpenSSL (Node.js)',
    marker: ['openssl/crypto/cryptlib.c', 'config/bn_conf.h'],
    include: [
      'openssl', 'openssl/include', 'openssl/crypto', 'openssl/crypto/include', 'openssl/crypto/modes', 'openssl/crypto/ec/curve448', 'openssl/crypto/ec/curve448/arch_32',
      'openssl/providers/common/include', 'openssl/providers/fips/include', 'openssl/providers/implementations/include', 'config',
      'config/archs/linux-x86_64/no-asm/include', 'config/archs/linux-x86_64/no-asm/crypto', 'config/archs/linux-x86_64/no-asm/providers/common/include',
    ],
    exports: ['openssl/include'],
    wraps: ['openssl'],
  },
  {
    name: 'OpenSSL',
    marker: ['include/openssl/opensslv.h', 'crypto/cryptlib.c'],
    include: ['.', 'include', 'crypto/modes', 'crypto/ec/curve448', 'crypto/ec/curve448/arch_32', 'providers/common/include', 'providers/fips/include', 'providers/implementations/include'],
    exports: ['include'],
  },
  { name: 'libuv', marker: ['include/uv.h', 'src/uv-common.c'], include: ['include', 'src'], exports: ['include'] },
  { name: 'uvwasi', marker: ['include/uvwasi.h'], include: ['include'], exports: ['include'] },
  { name: 'zlib', marker: ['zlib.h', 'deflate.c'], include: ['.'], exports: ['.'] },
  { name: 'ICU', marker: ['source/common/unicode/utypes.h'], include: ['source/common', 'source/i18n'], exports: ['source/common', 'source/i18n'] },
  { name: 'c-ares', marker: ['include/ares.h', 'src/lib/ares_init.c'], include: ['include', 'src/lib', 'src/lib/include', 'config/linux'], exports: ['include'] },
  { name: 'nghttp2', marker: ['lib/includes/nghttp2/nghttp2.h'], include: ['lib/includes', 'lib'], exports: ['lib/includes'] },
  { name: 'nghttp3', marker: ['lib/includes/nghttp3/nghttp3.h'], include: ['lib/includes', 'lib'], exports: ['lib/includes'] },
  { name: 'ngtcp2', marker: ['lib/includes/ngtcp2/ngtcp2.h'], include: ['lib/includes', 'lib', 'crypto/includes', 'crypto'], exports: ['lib/includes', 'crypto/includes'] },
  { name: 'Brotli', marker: ['c/include/brotli/decode.h'], include: ['c/include'], exports: ['c/include'] },
  { name: 'Zstandard', marker: ['lib/zstd.h'], include: ['lib'], exports: ['lib'] },
  { name: 'llhttp', marker: ['include/llhttp.h'], include: ['.', 'include'], exports: ['include'] },
  { name: 'Ada', marker: ['ada.h', 'ada.cpp'], include: ['.'], exports: ['.'] },
  { name: 'simdjson', marker: ['simdjson.h', 'simdjson.cpp'], include: ['.'], exports: ['.'] },
  { name: 'SQLite', marker: ['sqlite3.h', 'sqlite3.c'], include: ['.'], exports: ['.'] },
  { name: 'HdrHistogram', marker: ['include/hdr/hdr_histogram.h'], include: ['src', 'include'], exports: ['src', 'include'] },
  { name: 'nbytes', marker: ['include/nbytes.h'], include: ['include'], exports: ['include'] },
  { name: 'ncrypto', marker: ['ncrypto.h', 'ncrypto.cc'], include: ['.'], exports: ['.'] },
  { name: 'merve', marker: ['merve.h', 'merve.cpp'], include: ['.'], exports: ['.'] },
  { name: 'GoogleTest', marker: ['include/gtest/gtest.h'], include: ['.', 'include'], exports: ['include'] },
  { name: 'inspector_protocol', marker: ['crdtp/json.h'], include: ['.'], exports: ['.'] },
  { name: 'Perfetto', marker: ['sdk/perfetto.h'], include: ['sdk'], exports: ['sdk'] },
  { name: 'libffi', marker: ['include/ffi_common.h', 'src/prep_cif.c'], include: ['include', 'src'], exports: ['include'] },
  { name: 'postject', marker: ['postject-api.h'], include: ['.'], exports: ['.'] },
  {
    name: 'LIEF',
    marker: ['include/LIEF/LIEF.hpp'],
    include: ['.', 'include', 'src', 'third-party/mbedtls/include', 'third-party/mbedtls/library', 'third-party/spdlog/include', 'third-party/frozen/include'],
    exports: ['include'],
  },
]

// The KNOWN_PROJECTS (`known`) in the tree at `baseDir`, found by a walk of its directories (dot-,
// node_modules, example and test-scaffolding ones aside), as `{ projects, of }`: each project its
// table entry with its `root` (project-relative, '' for the bundle root) and `searchPath`, the
// directories its sources are searched in -- its own `include`, then the `exports` of every other
// project but those it lies in, nearest first: those it holds, by depth, then those of the project
// around it, and so on out (Node.js's deps/zlib before V8's third_party/zlib for Node.js's sources,
// V8's own copy first for V8's). `of(file)` is the innermost project a file lies in, or null.
export function detectProjects(baseDir, known = KNOWN_PROJECTS) {
  const found = []
  const walk = (rel) => {
    let dirents
    try {
      dirents = readdirSync(join(baseDir, rel), { withFileTypes: true })
    } catch {
      return
    }
    const names = new Set(dirents.map((d) => d.name))
    for (const project of known) {
      if (found.some((p) => p.root === rel)) break // one known project to a root: the first listed
      if (project.marker.every((m) => names.has(m.split('/')[0]) && isFile(join(baseDir, rel, m)))) found.push({ ...project, root: rel })
    }
    for (const d of dirents.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && !isAutoExcludedDir(d.name)) walk(rel === '' ? d.name : `${rel}/${d.name}`)
    }
  }
  walk('')
  const wrapped = new Set(found.flatMap((p) => (p.wraps ?? []).map((w) => joinRel(p.root, w))))
  const projects = found.filter((p) => !wrapped.has(p.root))
  const within = (root, path) => root === '' || path === root || path.startsWith(`${root}/`)
  // Each project's enclosing ones, innermost first.
  const around = new Map()
  for (const p of projects) around.set(p, projects.filter((q) => q !== p && within(q.root, p.root)).toSorted((a, b) => b.root.length - a.root.length))
  const dirs = (p, list) => list.map((d) => joinRel(p.root, d)).filter((rel) => rel !== null && isDir(join(baseDir, rel || '.')))
  for (const p of projects) {
    const chain = [p, ...around.get(p)]
    // Distance from p to q: steps out to the nearest project holding both (chain.length past the
    // outermost: the bundle root), then steps in to q.
    const distance = (q) => {
      const common = chain.findIndex((a) => around.get(q).includes(a))
      const outward = common === -1 ? chain.length : common
      const inward = around.get(q).filter((a) => !chain.slice(outward).includes(a)).length + 1
      return [outward, inward]
    }
    const others = projects.filter((q) => !chain.includes(q)).map((q) => ({ q, d: distance(q) }))
    others.sort((a, b) => a.d[0] - b.d[0] || a.d[1] - b.d[1] || (a.q.root < b.q.root ? -1 : 1))
    p.searchPath = [...new Set([...dirs(p, p.include), ...others.flatMap(({ q }) => dirs(q, q.exports))])].map((rel) => ({ rel }))
  }
  const byDir = new Map()
  const of = (file) => {
    const dir = dirOf(file)
    if (!byDir.has(dir)) byDir.set(dir, projects.filter((p) => within(p.root, file)).toSorted((a, b) => b.root.length - a.root.length)[0] ?? null)
    return byDir.get(dir)
  }
  return { projects, of }
}

// --- Walk -------------------------------------------------------------------------------------

// `rel` (a project-relative dir, '' for the root) joined with an include's path, `.`/`..` resolved;
// null when that climbs above the root.
function joinRel(rel, path) {
  const parts = []
  for (const part of [...rel.split('/'), ...path.split('/')]) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.join('/')
}

const dirOf = (file) => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '')

// A header's implementation files: the C/C++ sources of its name beside it, else in the `src/` that
// mirrors the `include/` it lies in (`include/lib/x.h` -> `src/lib/x.cpp`, `src/x.cpp`), the first
// place holding any. Probing is by name, so it is a guess, and walked as one (a `maybe` edge).
function implementationCandidates(header) {
  const ext = extname(header)
  if (!C_HEADER_EXTS.has(ext)) return []
  const stem = posix.basename(header, ext)
  const places = [dirOf(header)]
  const parts = dirOf(header).split('/')
  const at = parts.lastIndexOf('include')
  if (at !== -1) {
    const under = parts.slice(at + 1)
    for (let k = 0; k <= under.length; k++) places.push([...parts.slice(0, at), 'src', ...under.slice(k)].join('/'))
  }
  return places.map((dir) => [...C_SOURCE_EXTS].map((e) => joinRel(dir, `${stem}${e}`)))
}

// Known implementation links, for libraries whose sources aren't named after their headers, which
// implementationCandidates can't find. A bundled header whose project-relative path matches `header`
// pulls in what `impl` names, the pattern's first group being the library's root ('' or a path
// ending in `/`): each a path from that root, `$n` the pattern's group n, ending in `/*` for every
// C/C++ source in that directory, or `/**` for those below it too (`/x_*` for those whose name
// starts with `x_`). `registers` takes instead every
// C/C++ source below its `dir` (from the root) whose text matches its `pattern`: what registers
// itself through a macro, linked by the registry and named by nothing. Walked as implementation
// files are: what isn't there is nothing missing.
export const KNOWN_IMPLEMENTATIONS = [
  // Node.js: the embedder API node.h declares, the bindings that register themselves, the headers
  // implemented across files of other names, and the FFI trampolines, one per architecture.
  { header: /^(.*\/)?src\/node\.h$/u, impl: ['src/api/*'] },
  { header: /^(.*\/)?src\/node_binding\.h$/u, registers: { dir: 'src', pattern: /^\s*NODE_BINDING_(?:CONTEXT_AWARE_INTERNAL|PER_ISOLATE_INIT)\s*\(/mu } },
  { header: /^(.*\/)?src\/node_process\.h$/u, impl: ['src/node_process_*', 'src/node_env_var.cc'] },
  { header: /^(.*\/)?src\/node_report\.h$/u, impl: ['src/node_report_*'] },
  { header: /^(.*\/)?src\/ffi\/fast\.h$/u, impl: ['src/ffi/platforms/*'] },
  // V8's public API, implemented in src/api.
  { header: /^(.*\/)?include\/v8[\w-]*\.h$/u, impl: ['src/api/*'] },
  // OpenSSL: a header's subsystem, the library's core, TLS, the built-in providers.
  { header: /^(.*\/)?include\/openssl\/(\w+)\.h$/u, impl: ['crypto/$2/*'] },
  { header: /^(.*\/)?include\/openssl\/crypto\.h$/u, impl: ['crypto/*'] },
  { header: /^(.*\/)?include\/openssl\/(?:ssl|ssl3|tls1|dtls1)\.h$/u, impl: ['ssl/**'] },
  { header: /^(.*\/)?include\/openssl\/provider\.h$/u, impl: ['providers/**'] },
  { header: /^(.*\/)?include\/uv\.h$/u, impl: ['src/**'] }, // libuv
  { header: /^(.*\/)?include\/uvwasi\.h$/u, impl: ['src/*'] },
  { header: /^(.*\/)?include\/ares\.h$/u, impl: ['src/lib/**'] }, // c-ares
  { header: /^(.*\/)?include\/llhttp\.h$/u, impl: ['src/*'] },
  { header: /^(.*\/)?lib\/includes\/(nghttp2|nghttp3|ngtcp2)\/\2\.h$/u, impl: ['lib/*'] },
  { header: /^(.*\/)?c\/include\/brotli\/(dec|enc)ode\.h$/u, impl: ['c/common/*', 'c/$2/*'] },
  { header: /^(.*\/)?lib\/zstd\.h$/u, impl: ['lib/common/*', 'lib/compress/*', 'lib/decompress/*'] },
  { header: /^(.*\/)?zlib\.h$/u, impl: ['*'] },
  { header: /^(.*\/)?(common|i18n)\/unicode\/(\w+)\.h$/u, impl: ['$2/$3.cpp'] }, // ICU
]

// Walk the include graph from `entries` (project-relative), reading each file once per search
// context it is reached in. `includeDirs` are `-I` directories (relative to `baseDir`) for every
// translation unit; `commands` (loadCompileCommands') gives a unit its own search path, the entries'
// and the implementation files' alike, and a header the one of the unit it is reached from; a unit
// it doesn't list, inside a known project (`knownProjects`, KNOWN_PROJECTS), that project's search
// path after `includeDirs` (detectProjects). `knownLinks`
// are the known implementation links (KNOWN_IMPLEMENTATIONS). Returns:
//   sources      Map<path, text> -- C/C++ text, or an `#embed`ed resource (base64 if not UTF-8)
//   formats      Map<path, format> -- c, cpp, c-header, cpp-header, resource, resource:base64
//   resolutions  Map<path, Map<spec, path>> -- each include's file (includeSpec), and for a header's
//                implementation file `impl <its path from the header's directory>`
//   missing      [{ spec, from, reason? }] -- what makes the bundle incomplete, where every
//                configuration compiles it (in a file every configuration reaches, not through a
//                conditional include or an implementation file's guess): an include of a file the
//                bundle refuses (a symlink out of the root, a `.env`), or a quoted (or forced) one
//                found nowhere that a directory above its includer's holds -- the search path lacks
//                the -I the file is built with (`hints`)
//   unfound      [{ spec, from }] -- such a quoted include found nowhere else: a system header
//                written in quotes (`"math.h"`), or one the build generates. `<x>` found nowhere is
//                a system header, never reported.
//   computed     [{ spec, from }] -- `#include MACRO`: not followed
//   conflicts    [{ spec, from, targets }] -- an include resolving to other files in other units;
//                the edge keeps the first, every file is carried
//   hints        Set<dir> -- directories that, as `-I`, would resolve the `missing` quoted includes
//   projects     the known projects found (detectProjects), whose search paths units outside the
//                compilation database take
export function collectCBundle(baseDir, entries, { includeDirs = [], commands = null, knownLinks = KNOWN_IMPLEMENTATIONS, knownProjects = KNOWN_PROJECTS } = {}) {
  const realBase = realpathSync(baseDir)
  const extraDirs = includeDirs.map((d) => makeDir(baseDir, realBase, resolve(baseDir, d)))
  for (const [k, d] of extraDirs.entries()) {
    if (!isDir(d.abs ?? join(baseDir, d.rel))) console.warn(`[loader.c] --include-dirs: no such directory: ${includeDirs[k]}`)
  }
  const contexts = new Map()
  const intern = (ctx) => {
    if (!contexts.has(ctx.id)) contexts.set(ctx.id, ctx)
    return contexts.get(ctx.id)
  }
  const defaultCtx = intern(makeContext({}, extraDirs))
  // A unit's search path: its compile command's, else its known project's (after --include-dirs),
  // else `fallback`'s.
  const projects = detectProjects(baseDir, knownProjects)
  const contextOf = (file, fallback) => {
    if (commands?.has(file)) return intern(makeContext(commands.get(file), extraDirs))
    const project = projects.of(file)
    return project === null ? fallback : intern(makeContext({ I: [...extraDirs, ...project.searchPath] }))
  }

  const sources = new Map()
  const formats = new Map()
  const scans = new Map() // file -> scanIncludes
  const nodes = new Map() // `${ctx.id}\0${file}` -> { file, ctx, at, primary, edges }
  const resolutions = new Map()
  const computed = []
  const conflicts = []
  const queue = []
  const keyOf = (file, ctx) => `${ctx.id}\0${file}`

  // `at` is where in the context's [...quote, ...angle] list the file was found, -1 where it wasn't
  // found through the search path (an entry, a quoted include beside its includer): where an
  // `#include_next` in it carries on from. `primary` marks a unit its own compile command names.
  const visit = (file, ctx, { at = -1, primary = false, format }) => {
    const key = keyOf(file, ctx)
    if (!nodes.has(key)) {
      nodes.set(key, { file, ctx, at, primary, edges: [] })
      queue.push(key)
    }
    if (!formats.has(file)) formats.set(file, format)
    return key
  }

  const exists = (rel) => isFile(join(baseDir, rel))

  // The C/C++ sources in `dir` (project-relative), path-sorted; below it too where `deep`, skipping
  // dot-directories, what no walk descends into (isAutoExcludedDir) and symlinked directories.
  const listings = new Map()
  const sourcesIn = (dir, deep) => {
    const key = `${deep ? '**' : '*'}\0${dir}`
    if (listings.has(key)) return listings.get(key)
    const found = []
    const walk = (rel) => {
      let dirents
      try {
        dirents = readdirSync(join(baseDir, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const d of dirents.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = rel === '' ? d.name : `${rel}/${d.name}`
        if (d.isDirectory()) {
          if (deep && !d.name.startsWith('.') && !isAutoExcludedDir(d.name)) walk(path)
        } else if (C_SOURCE_EXTS.has(extname(d.name))) {
          found.push(path)
        }
      }
    }
    walk(dir)
    listings.set(key, found)
    return found
  }
  // Whether the C/C++ source `rel` holds `pattern`; a file the bundle refuses, or that isn't UTF-8,
  // doesn't.
  const holds = (rel, pattern) => {
    if (sources.has(rel)) return pattern.test(sources.get(rel))
    if (probe({ rel: '' }, rel)?.target === undefined) return false
    const buf = readFileSync(join(baseDir, rel))
    return isUtf8(buf) && pattern.test(buf.toString('utf8'))
  }
  // The files KNOWN_IMPLEMENTATIONS links `header` to, project-relative.
  const knownImplementations = (header) => {
    const out = []
    for (const link of knownLinks) {
      const m = link.header.exec(header)
      if (m === null) continue
      const root = m[1] ?? ''
      if (link.registers !== undefined) {
        for (const rel of sourcesIn(joinRel(root, link.registers.dir) ?? '', true)) if (holds(rel, link.registers.pattern)) out.push(rel)
        continue
      }
      for (const impl of link.impl) {
        const path = impl.replaceAll(/\$(\d)/gu, (_, n) => m[Number(n)] ?? '')
        const glob = /(?:^|\/)([^/*]*)(\*\*?)$/u.exec(path)
        if (glob === null) {
          const rel = joinRel(root, path)
          if (rel !== null && exists(rel)) out.push(rel)
        } else {
          const [, prefix, stars] = glob
          const dir = joinRel(root, path.slice(0, -(prefix.length + stars.length)))
          if (dir !== null) out.push(...sourcesIn(dir, stars === '**').filter((rel) => posix.basename(rel).startsWith(prefix)))
        }
      }
    }
    return out
  }
  // The nearest directory above `file`'s own holding `path` ('.' for the root), else null.
  const ancestorHolding = (file, path) => {
    for (let dir = dirOf(file); dir !== '';) {
      dir = dirOf(dir)
      const rel = joinRel(dir, path)
      if (rel !== null && rel !== '' && exists(rel)) return dir === '' ? '.' : dir
    }
    return null
  }
  // The file `path` names in `dir`: { target } inside the root, { external } outside it (or past it),
  // { refused } for one the bundle won't carry, null where nothing is.
  const probe = (dir, path) => {
    if (dir.abs !== undefined) return isFile(resolve(dir.abs, path)) ? { external: true } : null
    const rel = joinRel(dir.rel, path)
    if (rel === null) return isFile(resolve(baseDir, dir.rel, path)) ? { external: true } : null
    if (rel === '' || !exists(rel)) return null
    try {
      assertRealPathWithinBase(realBase, baseDir, rel)
    } catch {
      return { refused: `${rel} is a symlink escaping the bundle root` }
    }
    if (isDotEnvFile(rel)) return { refused: `${rel} is a .env file, never carried` }
    return { target: rel }
  }

  // An include of `inc` from `node`, resolved as GCC searches: { target, at } | { external } |
  // { refused } | null.
  const resolveInclude = (node, inc) => {
    const { file, ctx } = node
    if (isAbsolute(inc.path)) {
      const hit = probe(makeDir(baseDir, realBase, inc.path), '.')
      return hit ?? null
    }
    if (inc.directive === 'embed') {
      const dirs = inc.form === 'quote' ? [{ rel: dirOf(file) }, ...ctx.embed] : ctx.embed
      for (const dir of dirs) {
        const hit = probe(dir, inc.path)
        if (hit !== null) return hit
      }
      return null
    }
    const chain = [...ctx.quote, ...ctx.angle]
    const first = inc.form === 'angle' ? ctx.quote.length : 0
    if (inc.directive === 'include_next') {
      // On from after the directory the includer was found in; from the start of its form's chain
      // where it wasn't found through one, never landing on the includer itself.
      for (let k = Math.max(first, node.at + 1); k < chain.length; k++) {
        const hit = probe(chain[k], inc.path)
        if (hit !== null && hit.target !== file) return { ...hit, at: k }
      }
      return null
    }
    if (inc.form === 'quote') {
      const hit = probe({ rel: dirOf(file) }, inc.path)
      if (hit !== null) return { ...hit, at: -1 }
    }
    for (let k = first; k < chain.length; k++) {
      const hit = probe(chain[k], inc.path)
      if (hit !== null) return { ...hit, at: k }
    }
    return null
  }

  // A reached file's text (an entry's too, which may be missing: null then).
  const read = (file, resource) => {
    let buf
    try {
      assertRealPathWithinBase(realBase, baseDir, file)
      if (!isFile(join(baseDir, file))) return null
      buf = readFileSync(join(baseDir, file))
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') return null
      throw err
    }
    const utf8 = isUtf8(buf)
    if (resource) {
      formats.set(file, utf8 ? 'resource' : 'resource:base64')
      return utf8 ? buf.toString('utf8') : buf.toString('base64')
    }
    if (!utf8) throw new Error(`C/C++ source is not valid UTF-8: ${file}`)
    return buf.toString('utf8')
  }

  const addEdge = (node, edge) => {
    node.edges.push(edge)
    if (edge.result?.target === undefined) return
    if (!resolutions.has(node.file)) resolutions.set(node.file, new Map())
    const specs = resolutions.get(node.file)
    const had = specs.get(edge.spec)
    if (had === undefined) specs.set(edge.spec, edge.result.target)
    else if (had !== edge.result.target) {
      const known = conflicts.find((c) => c.from === node.file && c.spec === edge.spec)
      if (known === undefined) conflicts.push({ spec: edge.spec, from: node.file, targets: [had, edge.result.target] })
      else if (!known.targets.includes(edge.result.target)) known.targets.push(edge.result.target)
    }
  }

  for (const entry of entries) visit(entry, contextOf(entry, defaultCtx), { primary: commands?.has(entry), format: cFormatOf(entry) })

  while (queue.length > 0) {
    const node = nodes.get(queue.shift())
    const { file, ctx } = node
    const resource = formats.get(file)?.startsWith('resource') ?? false
    if (!sources.has(file)) {
      const text = read(file, resource)
      if (text === null) continue
      sources.set(file, text)
    }
    if (resource) continue
    if (!scans.has(file)) scans.set(file, scanIncludes(sources.get(file)))
    const format = formats.get(file)

    // A unit's -include/-imacros files, read as if included first, from the command's directory.
    if (node.primary) {
      for (const { flag, path, dir } of ctx.forced) {
        const spec = `${flag} ${path}`
        let result = isAbsolute(path) ? probe(makeDir(baseDir, realBase, path), '.') : probe(dir, path)
        if (result === null && !isAbsolute(path)) result = resolveInclude(node, { directive: 'include', form: 'quote', path })
        const edge = { spec, live: true, forced: true, result, target: undefined }
        if (result?.target !== undefined) edge.target = visit(result.target, ctx, { at: result.at ?? -1, format: cFormatOf(result.target, format) })
        addEdge(node, edge)
      }
    }

    for (const inc of scans.get(file)) {
      const spec = includeSpec(inc)
      if (inc.form === 'macro') {
        if (!computed.some((c) => c.spec === spec && c.from === file)) computed.push({ spec, from: file })
        continue
      }
      const result = resolveInclude(node, inc)
      const edge = { spec, inc, live: inc.state === 'live', result, target: undefined }
      if (result?.target !== undefined) {
        const embed = inc.directive === 'embed'
        edge.target = visit(result.target, ctx, { at: result.at, format: embed ? 'resource' : cFormatOf(result.target, format) })
      }
      addEdge(node, edge)
    }

    // A header's implementation files: by name, then the known links. Each is a translation unit of
    // its own, keyed by its path from the header's directory.
    const linked = new Set([file])
    const link = (rel) => {
      if (linked.has(rel)) return
      linked.add(rel)
      const result = probe({ rel: '' }, rel)
      const edge = { spec: `impl ${posix.relative(dirOf(file) || '.', rel)}`, live: false, result, target: undefined }
      if (result?.target !== undefined) edge.target = visit(rel, contextOf(rel, ctx), { primary: commands?.has(rel), format: cFormatOf(rel) })
      addEdge(node, edge)
    }
    for (const candidates of implementationCandidates(file)) {
      const found = candidates.filter((rel) => rel !== null && rel !== file && exists(rel))
      for (const rel of found) link(rel)
      if (found.length > 0) break
    }
    if (C_HEADER_EXTS.has(extname(file))) for (const rel of knownImplementations(file)) link(rel)
  }

  // What every configuration builds: the entries, and what they reach through includes every
  // configuration compiles. An include missing from those is what the bundle lacks.
  const definite = new Set()
  const pending = entries.map((entry) => keyOf(entry, contextOf(entry, defaultCtx)))
  while (pending.length > 0) {
    const key = pending.pop()
    if (definite.has(key) || !nodes.has(key)) continue
    definite.add(key)
    for (const edge of nodes.get(key).edges) if (edge.live && edge.target !== undefined) pending.push(edge.target)
  }
  const missing = []
  const unfound = []
  const hints = new Set()
  const seen = new Set()
  for (const key of definite) {
    const node = nodes.get(key)
    for (const edge of node.edges) {
      const id = `${node.file}\0${edge.spec}`
      if (!edge.live || seen.has(id)) continue
      if (edge.result?.refused !== undefined) {
        missing.push({ spec: edge.spec, from: node.file, reason: edge.result.refused })
        seen.add(id)
      } else if (edge.result === null && (edge.forced || (edge.inc.form === 'quote' && edge.inc.directive !== 'include_next'))) {
        seen.add(id)
        // Below a directory above the includer's, the tree holds the path: the search path lacks
        // the -I it is built with. Found nowhere, it is a system header, or one the build generates.
        const hint = ancestorHolding(node.file, edge.inc?.path ?? edge.spec.slice(edge.spec.indexOf(' ') + 1))
        if (hint === null) {
          unfound.push({ spec: edge.spec, from: node.file })
        } else {
          missing.push({ spec: edge.spec, from: node.file })
          hints.add(hint)
        }
      }
    }
  }

  return { sources, formats, resolutions, missing, unfound, computed, conflicts, hints, projects: projects.projects }
}
