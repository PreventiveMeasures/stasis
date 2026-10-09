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
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path'

import { assertRealPathWithinBase, classifyFormat, isDotEnvFile, relativeEscapes, toPosix } from '@exodus/stasis-core/util'
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

// Walk the include graph from `entries` (project-relative), reading each file once per search
// context it is reached in. `includeDirs` are `-I` directories (relative to `baseDir`) for every
// translation unit; `commands` (loadCompileCommands') gives a unit its own search path, the entries'
// and the implementation files' alike, and a header the one of the unit it is reached from. Returns:
//   sources      Map<path, text> -- C/C++ text, or an `#embed`ed resource (base64 if not UTF-8)
//   formats      Map<path, format> -- c, cpp, c-header, cpp-header, resource, resource:base64
//   resolutions  Map<path, Map<spec, path>> -- each include's file (includeSpec), and `impl x.cpp`
//                for a header's implementation file
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
export function collectCBundle(baseDir, entries, { includeDirs = [], commands = null } = {}) {
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
  const contextOf = (file, fallback) => (commands?.has(file) ? intern(makeContext(commands.get(file), extraDirs)) : fallback)

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

    for (const candidates of implementationCandidates(file)) {
      const found = candidates.filter((rel) => rel !== null && rel !== file && exists(rel))
      for (const rel of found) {
        const result = probe({ rel: '' }, rel)
        const edge = { spec: `impl ${posix.basename(rel)}`, live: false, result, target: undefined }
        if (result?.target !== undefined) edge.target = visit(rel, contextOf(rel, ctx), { primary: commands?.has(rel), format: cFormatOf(rel) })
        addEdge(node, edge)
      }
      if (found.length > 0) break
    }
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

  return { sources, formats, resolutions, missing, unfound, computed, conflicts, hints }
}
