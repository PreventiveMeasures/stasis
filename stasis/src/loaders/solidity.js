// Based on DeepView's Solidity loader (https://github.com/PreventiveMeasures/deepview/blob/main/src/loaders/solidity.js).
// Imports resolve as solc does under the project's build tool (remappings: foundry.js). Dependencies are
// untrusted: an import never leaves the project nor crosses a link one plants (solidityOwnership).

import { isAbsolute, join, posix, relative, resolve } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { assertRealPathWithinBase, relativeEscapes, toPosix } from '@exodus/stasis-core/util'
import { isDir, isFile } from '../resolve-typescript.js'
import {
  FOUNDRY_TOML,
  REMAPPINGS_TXT,
  foundryLibs,
  foundryProfile,
  foundryProject,
  parseRemappingLines,
  readFoundryTomlRemappings,
  shownFrom,
  toSolcRemapping,
} from './foundry.js'
import { applyToDir, isDotRelative } from './paths.js'
import { decodeUtf8, projectOwnership, projectRelative, readUtf8OrNull, realpathOrNull, solidityOwnership } from './solidity-ownership.js'

// --- Import scan ------------------------------------------------------------------------------

// The scan's ASCII classes, by char code: identifier start [A-Za-z_$], identifier part [\w$], digit,
// and a number literal's [\w.].
const isIdentStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36
const isDigit = (c) => c >= 48 && c <= 57
const isIdentPart = (c) => isIdentStart(c) || isDigit(c)
const isNumberPart = (c) => (isIdentPart(c) && c !== 36) || c === 46
const STRING_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }

const utf8 = (s) => [...Buffer.from(s, 'utf8')]

// A string literal starting at `text[i]` (a quote): `{ value, end }`, `value` null when it's
// unterminated on its line (solc rejects those). A literal is bytes, as in solc: `\xNN` is one
// byte, `\uNNNN` and plain text their UTF-8, and the path is those bytes read as UTF-8.
function readStringLiteral(text, i) {
  const quote = text.charCodeAt(i)
  let bytes = null // set at the first escape; until then the literal is a plain slice
  let start = i + 1
  let j = start
  while (j < text.length) {
    const c = text.charCodeAt(j)
    if (c === quote) {
      if (bytes === null) return { value: text.slice(start, j), end: j + 1 }
      bytes.push(...utf8(text.slice(start, j)))
      return { value: Buffer.from(bytes).toString('utf8'), end: j + 1 }
    }
    if (c === 10 || c === 13) return { value: null, end: j }
    if (c !== 92) {
      j++
      continue
    }
    bytes ??= []
    bytes.push(...utf8(text.slice(start, j)))
    const next = text[j + 1]
    if (next === 'x' && /^[\da-f]{2}$/iu.test(text.slice(j + 2, j + 4))) {
      bytes.push(Number.parseInt(text.slice(j + 2, j + 4), 16))
      j += 4
    } else if (next === 'u' && /^[\da-f]{4}$/iu.test(text.slice(j + 2, j + 6))) {
      bytes.push(...utf8(String.fromCodePoint(Number.parseInt(text.slice(j + 2, j + 6), 16))))
      j += 6
    } else if (next === '\r' && text[j + 2] === '\n') {
      j += 3 // line continuation
    } else if (next === '\n' || next === '\r') {
      j += 2
    } else if (next === undefined) {
      return { value: null, end: j + 1 }
    } else {
      bytes.push(...utf8(STRING_ESCAPES[next] ?? next))
      j += 2
    }
    start = j
  }
  return { value: null, end: j }
}

// The path of every import directive, in source order: the first string literal after the `import`
// keyword, before its `;`, over any number of lines. Tokenized far enough to skip comments and string
// literals, so a commented-out import or a string holding the word `import` is never taken for one.
export function extractSolImports(content) {
  const specs = []
  const n = content.length
  let inImport = false
  let i = 0
  while (i < n) {
    const c = content.charCodeAt(i)
    const next = content.charCodeAt(i + 1)
    if (c === 47 && next === 47) { // `//`, to the end of the line (`\n` or `\r`, as solc ends it)
      let eol = i + 2
      while (eol < n && content.charCodeAt(eol) !== 10 && content.charCodeAt(eol) !== 13) eol++
      i = eol
    } else if (c === 47 && next === 42) { // `/*`
      const close = content.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
    } else if (c === 34 || c === 39) { // `"` or `'`
      const { value, end } = readStringLiteral(content, i)
      // An unterminated literal ends the import too (solc rejects the file).
      if (inImport && value !== null) specs.push(value)
      inImport = false
      i = end
    } else if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdentPart(content.charCodeAt(j))) j++
      if (j - i === 6 && content.startsWith('import', i)) inImport = true
      i = j
    } else if (isDigit(c)) {
      // A number literal (`0x1f`, `1e18`, `1_000`): its letters aren't identifiers.
      let j = i + 1
      while (j < n && isNumberPart(content.charCodeAt(j))) j++
      i = j
    } else {
      if (c === 59) inImport = false // `;`
      i++
    }
  }
  return specs
}

// --- Remappings ---------------------------------------------------------------------------------

// Loader-side shape: `{ context, prefix, target }` (context null = global).
const toLoaderRemapping = ({ context, name, path }) => ({ context, prefix: name, target: path })

// A mapping file's remappings as listed (no discovery around it), and the files read. A foundry.toml's
// (its selected profile) and, with `forge`, a remappings.txt's are slash-terminated as forge reads them;
// else (solc, Hardhat) a remappings.txt applies as written. Messages name files `show(file)`.
function readMapping(mappingFile, { env, forge, host, show }) {
  if (mappingFile.endsWith('.toml')) {
    const { remappings, files, profiled } = readFoundryTomlRemappings(mappingFile, foundryProfile(env), { show, host })
    return { remappings: remappings.map(toSolcRemapping), files, profiled }
  }
  const name = show(mappingFile)
  const text = readUtf8OrNull(mappingFile, name, host)
  if (text === null) throw new Error(`${name}: no such file`)
  const listed = parseRemappingLines(text, { label: name, emptyPath: !forge })
  return { remappings: listed.map(forge ? toSolcRemapping : toLoaderRemapping), files: [mappingFile] }
}

// --- Resolution ---------------------------------------------------------------------------------

// What resolves the imports of the project at `baseDir`, `{ remappings, libs, ownership, files, envUsed }`:
// the remappings `mappingFile` lists, else what `forge build` uses with a foundry.toml at the root
// (foundry.js), else a root remappings.txt as written; forge's `libs`, and the config `files` read.
export function discoverSolidityConfig(baseDir, { mappingFile, env = process.env, host = diskHost } = {}) {
  const forge = isFile(join(baseDir, FOUNDRY_TOML), host)
  if (forge && !mappingFile) return foundryProject(baseDir, { env, host })
  const { libs, profiled, files: libsFiles } = forge ? foundryLibs(baseDir, { env, host }) : { libs: [], profiled: false, files: [] }
  const ownership = projectOwnership(baseDir, libs, { soldeer: forge, host })
  const show = shownFrom(toPosix(resolve(baseDir)), host)
  if (mappingFile) {
    const abs = resolve(baseDir, mappingFile)
    const { remappings, files, profiled: mappingProfiled } = readMapping(abs, { env, forge, host, show })
    // The profile picks the mapping file's remappings (a .toml) or the root foundry.toml's libs: the
    // files read are both's.
    const envUsed = profiled || mappingProfiled ? [`FOUNDRY_PROFILE=${env.FOUNDRY_PROFILE}`] : []
    return { remappings, libs, ownership, files: [...new Set([...files, ...libsFiles].map((f) => projectRelative(baseDir, f, host)))], envUsed }
  }
  const txt = join(baseDir, REMAPPINGS_TXT)
  if (!isFile(txt, host)) return { remappings: [], libs, ownership, files: [], envUsed: [] }
  return { remappings: readMapping(txt, { env, forge, host, show }).remappings, libs, ownership, files: [REMAPPINGS_TXT], envUsed: [] }
}

// Solc's remapping of the source unit `name` imported from `fromFile`: of those whose context and prefix
// match, the longest context wins, then the longest prefix, then the one listed last; its target replaces
// the prefix verbatim (`//` collapsed). Null when none applies.
export function applyRemappings(name, fromFile, remappings) {
  let best = null
  for (const r of remappings) {
    const context = r.context ?? ''
    if (!fromFile.startsWith(context) || !name.startsWith(r.prefix)) continue
    if (best && (context.length < best.context.length || (context.length === best.context.length && r.prefix.length < best.prefix.length))) continue
    best = { context, prefix: r.prefix, target: r.target }
  }
  if (!best) return null
  return posix.normalize(best.target + name.slice(best.prefix.length)).replace(/^\.\//u, '')
}

// `<baseDir>/<spec>` when a real file sits there, as a clean project-relative path.
function projectFile(baseDir, spec, host) {
  if (isAbsolute(spec)) return null
  const rel = toPosix(relative(baseDir, resolve(baseDir, spec)))
  if (rel === '' || relativeEscapes(rel)) return null
  return isFile(join(baseDir, rel), host) ? rel : null
}

// No `.`/`..`/empty segment: a bare spec can't wander out of the directory it's looked up in.
const isPlainSpec = (spec) => spec.split('/').every((p) => p !== '' && p !== '.' && p !== '..')

// Forge's absolute import inside a library (`lib/dep/src/A.sol` importing `src/B.sol`): tried against
// each directory from the parent of the importer's up to (not including) its lib dir, as
// foundry-compilers' `resolve_absolute_library` does, forge passing the match to solc as an include path.
function libraryFile(baseDir, spec, fromFile, libs, host) {
  const lib = libs.map((l) => posix.normalize(toPosix(l)).replace(/\/$/u, '')).find((l) => fromFile.startsWith(`${l}/`))
  if (!lib) return null
  for (let dir = posix.dirname(posix.dirname(fromFile)); dir !== lib && dir.startsWith(`${lib}/`); dir = posix.dirname(dir)) {
    const hit = projectFile(baseDir, `${dir}/${spec}`, host)
    if (hit) return hit
  }
  return null
}

// A package import (`pkg/path.sol`, `@scope/pkg/path.sol`) by file path through node_modules, from
// the importing file's directory up to the root (Hardhat and Node; a package's `exports` map
// doesn't apply to Solidity sources).
function nodeModulesFile(baseDir, spec, fromFile, host) {
  const parts = spec.split('/')
  if (parts.length < (spec.startsWith('@') ? 3 : 2)) return null
  for (let dir = posix.dirname(fromFile); ; dir = posix.dirname(dir)) {
    if (posix.basename(dir) !== 'node_modules') {
      const hit = projectFile(baseDir, dir === '.' ? `node_modules/${spec}` : `${dir}/node_modules/${spec}`, host)
      if (hit) return hit
    }
    if (dir === '.' || dir === '/' || dir === '') return null
  }
}

// Where an import resolves, as `{ path }`, or `{ reason }` when it may not be read (`reason: null`:
// it names no file). See resolveSolImport.
function resolveImport(specifier, fromFile, { remappings = [], baseDir, libs = [], ownership, host = diskHost } = {}) {
  const relativeImport = isDotRelative(specifier)
  // A relative import (first segment `.` or `..`) resolves as solc does: against the importing
  // file's directory. Null when it climbs above the root: solc clamps there (`../../B.sol` from
  // `src/A.sol` is `B.sol`), but an import reaching out of the project is refused, not redirected.
  const name = relativeImport ? applyToDir(fromFile, specifier.split('/')) : specifier
  if (name === null) return { reason: 'it climbs above the project root' }
  let path = applyRemappings(name, fromFile, remappings)
  if (path === null && relativeImport) path = name
  if (path === null && baseDir) {
    const plain = isPlainSpec(name)
    path = (plain ? libraryFile(baseDir, name, fromFile, libs, host) : null) ?? projectFile(baseDir, name, host) ?? (plain ? nodeModulesFile(baseDir, name, fromFile, host) : null)
  }
  if (path === null) return { reason: null }
  if (isAbsolute(path) || posix.isAbsolute(path) || path === '..' || path.startsWith('../')) return { reason: `it resolves to ${path}, outside the project root` }
  if (!path.endsWith('.sol')) return { reason: `it resolves to ${path}, which is not a .sol file` }
  if (!baseDir) return { path }
  const own = ownership ?? solidityOwnership(baseDir, { host })
  const target = own.of(path)
  if (target.reason) return { reason: target.reason }
  // (A link out of the root is refused when the file is read.)
  if (target.real !== null && !target.outside && !target.dependency && own.of(fromFile).dependency) return { reason: `a dependency may not import the project's own ${path}` }
  return { path }
}

// Resolve a Solidity import to a baseDir-relative POSIX path the way solc does (relative, remapped, then
// in the importer's library, the project, node_modules); null when nothing resolves or the result is
// refused: not a `.sol` file in the root, or one `ownership` (solidityOwnership's) refuses it.
export function resolveSolImport(specifier, fromFile, options = {}) {
  return resolveImport(specifier, fromFile, options).path ?? null
}

// The files that describe a Solidity build (bundled by `--manifests`) besides the config files
// discovery read: the root's dependency pins, and each package's manifests. (`hardhat.config.*` is
// code that may hold keys, so it is never carried.)
export const SOLIDITY_ROOT_MANIFESTS = [FOUNDRY_TOML, REMAPPINGS_TXT, 'foundry.lock', 'soldeer.lock', '.gitmodules', 'package.json']
export const SOLIDITY_PACKAGE_MANIFESTS = ['package.json', FOUNDRY_TOML, REMAPPINGS_TXT]

// --- The walk -----------------------------------------------------------------------------------

const warnUnresolved = (spec, from, reason) =>
  console.warn(`[loader.solidity] ${reason ? 'Refused' : 'Missing'} import: ${spec} from ${from}${reason ? ` (${reason})` : ''}`)

// Build `{ sources, resolutions, missing }` from already-loaded Solidity sources, imports resolved as
// resolveSolImport does, else a specifier naming no file but matching a stored key verbatim. `missing`
// lists each `{ spec, from }` unresolved or outside `sources`, with the `reason` it was refused.
export function buildSolidityTree(sources, { remappings = [], baseDir, libs = [], host = diskHost, ownership = baseDir && solidityOwnership(baseDir, { host }) } = {}) {
  const resolutions = new Map()
  const missing = []
  const options = { remappings, baseDir, libs, ownership, host }
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const spec of extractSolImports(content)) {
      const r = resolveImport(spec, path, options)
      let resolved = r.path && sources.has(r.path) ? r.path : null
      if (!resolved && !r.reason && sources.has(spec)) resolved = spec
      if (resolved) {
        specMap.set(spec, resolved)
      } else {
        warnUnresolved(spec, path, r.reason)
        missing.push(r.reason ? { spec, from: path, reason: r.reason } : { spec, from: path })
      }
    }
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

// Walk the project from `entries`, a wave at a time, following resolved imports and reading each file once.
// Entries are also accepted as verbatim import targets naming no file (Foundry-style `import "src/A.sol"`);
// one crossing a dependency's link out of itself is refused.
export function collectSolidityFilesFromDisk(baseDir, entries, remappings, { libs = [], host = diskHost, ownership = solidityOwnership(baseDir, { host }) } = {}) {
  const sources = new Map()
  const knownEntries = new Set(entries)
  const realBase = host.realpath(baseDir)
  const options = { remappings, baseDir, libs, ownership, host }
  for (const entry of entries) ownership.assert(entry, 'entry ')
  for (let wave = entries; wave.length > 0;) {
    const reads = [...new Set(wave)].filter((p) => !sources.has(p)).map((relPath) => {
      try {
        assertRealPathWithinBase(realBase, baseDir, relPath, host)
        return [relPath, decodeUtf8(host.readFile(join(baseDir, relPath)), relPath)]
      } catch (err) {
        if (err.code === 'ENOENT') {
          console.warn(`[loader.solidity] Missing import: ${relPath}`)
          return null
        }
        throw err
      }
    })
    const next = []
    for (const entry of reads) {
      if (!entry) continue
      const [relPath, content] = entry
      sources.set(relPath, content)
      for (const spec of extractSolImports(content)) {
        const r = resolveImport(spec, relPath, options)
        const resolved = r.path ?? (!r.reason && knownEntries.has(spec) ? spec : null)
        if (resolved) {
          if (!sources.has(resolved)) next.push(resolved)
        } else {
          warnUnresolved(spec, relPath, r.reason)
        }
      }
    }
    wave = next
  }
  return sources
}

// Every `.sol` file under the project-relative directory `dir`, sorted, symlinks followed as forge
// (walkdir, `follow_links`) collects a source dir: a symlinked directory whose real path is on the
// current walk (its root included) is a loop and skipped; two links to one directory are two directories.
function solidityFilesUnder(baseDir, dir, host) {
  const out = []
  // The real paths of the directories on the current walk; one may repeat (a real directory
  // reached again through a link is walked, as walkdir does, and checked only at links).
  const stack = []
  const walk = (rel, real) => {
    stack.push(real)
    for (const e of host.readdir(join(baseDir, rel))) {
      const child = rel === '.' ? e.name : `${rel}/${e.name}`
      let kind = e
      let childReal = join(real, e.name)
      if (e.isSymbolicLink()) {
        childReal = realpathOrNull(join(baseDir, child), host)
        kind = host.stat(join(baseDir, child))
        if (kind === null) continue
        if (kind.isDirectory() && (childReal === null || stack.includes(childReal))) continue
      }
      if (kind.isDirectory()) walk(child, childReal)
      else if (kind.isFile() && e.name.endsWith('.sol')) out.push(child)
    }
    stack.pop()
  }
  const root = realpathOrNull(join(baseDir, dir), host)
  if (root !== null) walk(dir, root)
  return out.toSorted()
}

// Project-relative entries, each directory replaced by the `.sol` files under it (deduped, in order); a
// `.sol` entry kept as is. A directory missing or holding none is skipped with a warning, as forge skips
// an absent `script/`: an error only when no entry yields a file.
export function expandSolidityEntries(baseDir, entries, host = diskHost) {
  const out = new Set()
  const shown = (entry) => (entry === '.' ? './' : `${entry}/`)
  const named = entries.map((e) => (e === '' ? '.' : e))
  for (const entry of named) {
    const dir = isDir(join(baseDir, entry), host)
    if (!dir && entry.endsWith('.sol')) {
      out.add(entry)
      continue
    }
    const files = dir ? solidityFilesUnder(baseDir, entry, host) : []
    if (files.length === 0) console.warn(`[stasis] Skipping ${shown(entry)}: ${dir ? 'no .sol files under it' : 'no such directory'}`)
    for (const f of files) out.add(f)
  }
  if (out.size === 0) {
    if (entries.every((e) => host.stat(join(baseDir, e)) === null)) throw new Error(`No such file or directory: ${entries[0]}`)
    throw new Error(`No .sol files under ${named.map(shown).join(', ')} (a directory entry stands for the Solidity sources under it)`)
  }
  return [...out]
}
