import { isUtf8 } from 'node:buffer'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { checkoutCommit, parseGithubRepository } from '@exodus/stasis-core/bundle-util'
import { archiveIntegrity, assertRealPathWithinBase, fileInBucket, isPlainObject, moduleInfo, relativeEscapes, toPosix, upsert } from '@exodus/stasis-core/util'
import { LockfileError, parseComposerLock } from '@preventive/lockfile/composer.js'
import { isDir, isFile } from '../resolve-typescript.js'
import { applyToDir, isDotRelative } from './paths.js'
import { readUtf8OrNull } from './solidity-ownership.js'
import { nameErrors } from './toml.js'

// Reads at once: a wave can be huge (a dynamic include's directory), and opening every file at once EMFILE.
const READ_CONCURRENCY = 64

// The end of the heredoc/nowdoc opening at `start`, or `start` where none does; an unterminated one runs to the end.
function heredocEnd(code, start) {
  const n = code.length
  let j = start + 3
  while (j < n && (code[j] === ' ' || code[j] === '\t')) j++
  const quote = code[j] === '"' || code[j] === "'" ? code[j++] : ''
  let label = ''
  while (j < n && /\w/u.test(code[j])) label += code[j++]
  if (label === '') return start
  if (quote && code[j] === quote) j++
  for (let nl = code.indexOf('\n', j); nl !== -1; nl = code.indexOf('\n', nl + 1)) {
    let q = nl + 1
    while (q < n && (code[q] === ' ' || code[q] === '\t')) q++
    if (code.startsWith(label, q) && !/\w/u.test(code[q + label.length] ?? '')) {
      const end = code.indexOf('\n', q)
      return end === -1 ? n : end
    }
  }
  return n
}

// Comments, heredocs/nowdocs and (unless `keepStrings`) string literals blanked, newlines kept so offsets stay
// the input's. `#[` (a PHP 8 attribute) is code.
function maskNonCode(code, keepStrings) {
  const n = code.length
  const blank = (s) => s.replace(/[^\n]/gu, ' ')
  let out = ''
  let i = 0
  while (i < n) {
    const c = code[i]
    if ((c === '/' && code[i + 1] === '/') || (c === '#' && code[i + 1] !== '[')) {
      let end = code.indexOf('\n', i)
      if (end === -1) end = n
      out += blank(code.slice(i, end))
      i = end
    } else if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      out += blank(code.slice(i, end))
      i = end
    } else if (c === '<' && code[i + 1] === '<' && code[i + 2] === '<') {
      const end = heredocEnd(code, i)
      if (end === i) { out += c; i++ } else { out += blank(code.slice(i, end)); i = end }
    } else if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === c) { j++; break }
        j++
      }
      out += keepStrings ? code.slice(i, j) : blank(code.slice(i, j))
      i = j
    } else {
      out += c
      i++
    }
  }
  return out
}

// String literals kept, as include paths live in them.
function maskedPhp(content) {
  const code = maskNonCode(content, true)
  return { code, strings: stringLiterals(code) }
}

// Only `\\` and the closing quote unescaped, as PHP's single quotes do: good enough for path values.
function stringLiterals(code) {
  const out = []
  let i = 0
  while (i < code.length) {
    const q = code[i]
    if (q === "'" || q === '"') {
      let j = i + 1
      let value = ''
      while (j < code.length) {
        const c = code[j]
        if (c === '\\') {
          const next = code[j + 1]
          value += next === '\\' || next === q ? next : c + (next ?? '')
          j += next === undefined ? 1 : 2
          continue
        }
        if (c === q) { j++; break }
        value += c
        j++
      }
      out.push({ start: i, end: j, value, quote: q })
      i = j
    } else {
      i++
    }
  }
  return out
}

const inString = (strings, pos) => strings.some(({ start, end }) => pos > start && pos < end)
const stringAt = (strings, pos) => strings.find(({ start }) => start === pos)

// The lookbehind rejects `$x->require` and `Foo::include`, the `\b` `requireConfig`.
const PHP_INCLUDE_KEYWORD_RE = /(?<![\w$>:])(?:require_once|require|include_once|include)\b/gidu
// `__DIR__`, `dirname(__FILE__)`, or `dirname(__DIR__[, N])`, N levels up.
const PHP_DIR_ANCHOR_RE = /__DIR__\b|dirname\s*\(\s*(__FILE__|__DIR__)\s*(?:,\s*(\d+)\s*)?\)/y
const PHP_DIR_ANCHOR_FIND_RE = /(?<![\w$>])(?:__DIR__\b|dirname\s*\(\s*(?:__FILE__|__DIR__))/gu

// Laravel's helpers taking a path from the project root (or a directory of it): they name PHP files it require()s.
const PHP_PATH_HELPERS = new Map([
  ['base_path', ''],
  ['app_path', 'app'],
  ['config_path', 'config'],
  ['database_path', 'database'],
  ['lang_path', 'lang'],
  ['public_path', 'public'],
  ['resource_path', 'resources'],
  ['storage_path', 'storage'],
])
const PHP_PATH_HELPER_FIND_RE = new RegExp(String.raw`(?<![\w$>:])(${[...PHP_PATH_HELPERS.keys()].join('|')})\s*\(`, 'giu')

// A double-quoted string's interpolation; a single-quoted one's `$` is literal.
const PHP_INTERPOLATION_RE = /\$[A-Za-z_{]|\{\$/u

function skipWs(code, pos) {
  while (pos < code.length && /\s/u.test(code[pos])) pos++
  return pos
}

function matchDirAnchor(code, pos) {
  PHP_DIR_ANCHOR_RE.lastIndex = pos
  const m = PHP_DIR_ANCHOR_RE.exec(code)
  if (!m) return null
  const up = m[1] === '__DIR__' ? (m[2] ? Number(m[2]) : 1) : 0
  return { end: PHP_DIR_ANCHOR_RE.lastIndex, up }
}

function normalizeIncludePath(raw, dirRelative) {
  if (!dirRelative) return raw
  const rel = raw.replace(/^\/+/u, '')
  if (rel === '') return '.'
  return isDotRelative(rel) ? rel : `./${rel}`
}

// An optional directory anchor, then string literals concatenated up to the first variable, call, constant or
// interpolation, where it goes `dynamic`. Null with neither anchor nor literal.
function parseArgPath(code, start, strings) {
  let i = start
  let dirRelative = false
  let up = 0
  const anchor = matchDirAnchor(code, i)
  if (anchor) {
    i = skipWs(code, anchor.end)
    dirRelative = true
    up = anchor.up
    if (code[i] !== '.') return null
    i = skipWs(code, i + 1)
  }
  if (!dirRelative && !stringAt(strings, i)) return null
  let prefix = '/..'.repeat(up)
  for (;;) {
    const lit = stringAt(strings, i)
    if (!lit) return { dirRelative, up, prefix, dynamic: true }
    const interp = lit.quote === '"' ? lit.value.search(PHP_INTERPOLATION_RE) : -1
    if (interp >= 0) return { dirRelative, up, prefix: prefix + lit.value.slice(0, interp), dynamic: true }
    prefix += lit.value
    i = skipWs(code, lit.end)
    if (code[i] !== '.') return { dirRelative, up, prefix, dynamic: false }
    i = skipWs(code, i + 1)
  }
}

// A dynamic include with a static directory prefix is that directory (`dir`): any `.php` file in it may be its
// target at runtime.
function scanIncludes({ code, strings }) {
  const out = []
  for (const m of code.matchAll(PHP_INCLUDE_KEYWORD_RE)) {
    if (inString(strings, m.index)) continue
    let i = skipWs(code, m.index + m[0].length)
    if (code[i] === '(') i = skipWs(code, i + 1)
    const arg = parseArgPath(code, i, strings)
    if (!arg) continue
    const { dirRelative, up, prefix, dynamic } = arg
    if (!dynamic) out.push({ kind: 'file', spec: normalizeIncludePath(prefix, dirRelative) })
    else if (dirRelative || prefix.includes('/')) {
      let dir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : ''
      if (dir === '' && up > 0) dir = '/..'.repeat(up)
      out.push({ kind: 'dir', spec: normalizeIncludePath(dir, dirRelative) })
    }
  }
  return out
}

// `.php` path literals outside a `require`, which frameworks require() themselves: dir-anchored ones, against
// the file, and a Laravel path helper's, against the project root.
function scanPathLiterals({ code, strings }) {
  const out = []
  for (const m of code.matchAll(PHP_DIR_ANCHOR_FIND_RE)) {
    if (inString(strings, m.index)) continue
    const arg = parseArgPath(code, m.index, strings)
    if (!arg || arg.dynamic || !arg.dirRelative) continue
    const spec = normalizeIncludePath(arg.prefix, true)
    if (spec.endsWith('.php')) out.push({ spec, anchor: 'file' })
  }
  for (const m of code.matchAll(PHP_PATH_HELPER_FIND_RE)) {
    if (inString(strings, m.index)) continue
    const lit = stringAt(strings, skipWs(code, m.index + m[0].length))
    if (!lit || (lit.quote === '"' && PHP_INTERPOLATION_RE.test(lit.value))) continue
    const sub = PHP_PATH_HELPERS.get(m[1].toLowerCase())
    const arg = lit.value.replace(/^\/+/u, '')
    const spec = sub ? `${sub}/${arg}` : arg
    if (spec.endsWith('.php')) out.push({ spec, anchor: 'root' })
  }
  return out
}

const includeSpecs = (includes, kind) => includes.filter((e) => e.kind === kind).map((e) => e.spec)

export function extractPhpImports(content) {
  return includeSpecs(scanIncludes(maskedPhp(content)), 'file')
}

export function extractPhpImportDirs(content) {
  return includeSpecs(scanIncludes(maskedPhp(content)), 'dir')
}

const pathRefs = (masked) => [...new Map(scanPathLiterals(masked).map((ref) => [`${ref.anchor}:${ref.spec}`, ref])).values()]
export function extractPhpPathRefs(content) {
  return pathRefs(maskedPhp(content))
}

const isFileOnDisk = (baseDir, rel) => isFile(join(baseDir, rel))

// A `\` is no separator to PHP off Windows but part of a name: stasis refuses such a name rather than resolve
// it, or take it for another path.
function refuseBackslash(path, from) {
  if (path.includes('\\')) throw new Error(`[loader.php] path holds a '\\', which stasis refuses: ${path}${from ? ` (from ${from})` : ''}`)
}

function projectRel(baseDir, abs) {
  const rel = toPosix(relative(baseDir, abs))
  return relativeEscapes(rel) ? null : rel
}

// `./`/`../` resolve against the including file (null escaping the root; existence unchecked); a bare one next
// to the includer, then from the project root, the first that is `present`. Absolute ones are refused.
function resolvePhpSpec(spec, fromFile, baseDir, present) {
  refuseBackslash(spec, fromFile)
  if (isDotRelative(spec)) return applyToDir(fromFile, spec.split('/'))
  if (!baseDir || isAbsolute(spec)) return null
  const fileRel = applyToDir(fromFile, spec.split('/'))
  if (fileRel && present(fileRel)) return fileRel
  const projRel = projectRel(baseDir, resolve(baseDir, spec))
  return projRel && present(projRel) ? projRel : null
}

// A bare specifier resolvePhpSpec found present already.
export function resolvePhpDir(spec, fromFile, baseDir) {
  const present = (rel) => isDir(join(baseDir, rel))
  const rel = resolvePhpSpec(spec, fromFile, baseDir, present)
  return rel !== null && (!isDotRelative(spec) || present(rel)) ? rel : null
}

// Not recursive, which could pull in an unbounded subtree.
function listPhpFiles(baseDir, dir) {
  try {
    return readdirSync(join(baseDir, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.php'))
      .map((e) => (dir === '.' ? e.name : `${dir}/${e.name}`))
  } catch {
    return []
  }
}

export function resolvePhpImport(specifier, fromFile, { baseDir } = {}) {
  return resolvePhpSpec(specifier, fromFile, baseDir, (rel) => isFileOnDisk(baseDir, rel))
}

// Re-derived via resolve() so an interior `..` escaping the root (`src/foo/../../../secret.php`) is caught,
// which a leading-`..`/absolute check alone would let in.
function normalizeProjectRel(baseDir, p) {
  refuseBackslash(p)
  return projectRel(baseDir, resolve(baseDir, p))
}

// A generated autoload path (`$baseDir . '/src'`, a quoted string); null for anything else rather than a guess.
function evalPathExpr(expr, vars) {
  const s = expr.trim().replace(/,+$/u, '').trim()
  let out = ''
  let consumed = 0
  const re = /\$(\w+)|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|\.|\s+/gy
  let m
  while ((m = re.exec(s)) !== null) {
    // A sticky regex resets lastIndex to 0 when exec() returns null: how far it parsed is kept here.
    consumed = re.lastIndex
    if (m[1] !== undefined) {
      if (vars[m[1]] === undefined) return null
      out += vars[m[1]]
    } else if (m[2] !== undefined) {
      out += m[2].replace(/\\(['\\])/gu, '$1')
    } else if (m[3] !== undefined) {
      out += m[3]
    }
  }
  if (consumed !== s.length) return null
  return out
}

// A Composer `autoload_*.php` map, one entry a line: `multi`, psr-4/psr-0's (key -> dirs); else a file each.
function parseGeneratedMap(content, vars, multi) {
  const out = new Map()
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*'((?:\\.|[^'\\])*)'\s*=>\s*(.+?),?\s*$/u)
    if (!m) continue
    const key = m[1].replace(/\\(['\\])/gu, '$1')
    if (multi) {
      const am = m[2].match(/^array\s*\(([\s\S]*)\)$/u)
      if (am) out.set(key, am[1].split(',').map((piece) => evalPathExpr(piece, vars)).filter(Boolean))
    } else {
      const abs = evalPathExpr(m[2], vars)
      if (abs) out.set(key, abs)
    }
  }
  return out
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function readComposerJson(baseDir) {
  const composerJson = readJsonIfExists(join(baseDir, 'composer.json'))
  const vendorDir = normalizeProjectRel(baseDir, composerJson?.config?.['vendor-dir'] ?? 'vendor') ?? 'vendor'
  return { composerJson, vendorDir }
}

// Composer 2's `{ packages }`, or Composer 1's flat array.
function readInstalledPackages(baseDir, vendorDir) {
  const json = readJsonIfExists(join(baseDir, vendorDir, 'composer', 'installed.json'))
  return Array.isArray(json) ? json : (json?.packages ?? [])
}

// An integer past ±(2^53 − 1) a BigInt, as @preventive/lockfile reads one, so two values compare equal only
// where PHP's do.
const parseJsonExact = (text) => JSON.parse(text, (key, value, { source }) =>
  (typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/u.test(source) ? BigInt(source) : value))

// installed.json's install-path is from vendor/composer (none for a metapackage); Composer 1's gives none, at
// <vendor-dir>/<name>.
function installedDir(baseDir, vendorDir, p) {
  const path = p['install-path']
  if (path === undefined) return projectRel(baseDir, resolve(baseDir, vendorDir, p.name))
  return typeof path === 'string' ? projectRel(baseDir, resolve(baseDir, vendorDir, 'composer', path)) : null
}

// As LibraryInstaller::getInstallPath puts a package; one an installer plugin takes goes elsewhere, where its
// own composer.json's name finds it.
function lockedDir(baseDir, vendorDir, p) {
  return p.type === 'metapackage' ? null : projectRel(baseDir, resolve(baseDir, vendorDir, p.name, p.targetDir ?? ''))
}

// What Composer adds to a locked package in installed.json as it installs it.
const INSTALL_FIELDS = new Set(['version_normalized', 'installation-source', 'install-path'])

// Throws unless installed.json is, as Composer 2 writes it, the install of composer.lock: each locked package
// (packages-dev too, installed with dev) there once, as locked but for INSTALL_FIELDS, and nothing else.
function assertInstalledAsLocked(lockText, installedText, { installedFile, vendorDir }) {
  const differ = (detail) => new Error(`${installedFile} is not the install of composer.lock: ${detail}${vendorDir ? `; remove ${vendorDir} and run \`composer install\`` : ''}`)
  let installed
  try {
    installed = parseJsonExact(installedText)
  } catch {
    throw new Error(`${installedFile}: not JSON`) // without the parser's message, which quotes the text
  }
  const shape = ['packages', 'dev', 'dev-package-names']
  if (!isPlainObject(installed) || Object.keys(installed).length !== shape.length || !shape.every((key) => Object.hasOwn(installed, key)) ||
    !Array.isArray(installed.packages) || typeof installed.dev !== 'boolean' || !Array.isArray(installed['dev-package-names'])) {
    throw differ(`it is not as Composer 2 writes one, { ${shape.join(', ')} }`)
  }

  const lock = parseJsonExact(lockText)
  const locked = new Map()
  for (const [key, dev] of [['packages', false], ['packages-dev', true]]) {
    for (const spec of lock[key]) locked.set(spec.name, { spec, dev })
  }
  const seen = new Set()
  for (const [index, entry] of installed.packages.entries()) {
    if (!isPlainObject(entry) || typeof entry.name !== 'string') throw differ(`packages[${index}] is not a package`)
    const { name } = entry
    const want = locked.get(name)
    if (want === undefined) throw differ(`${JSON.stringify(name)} is installed, and not locked`)
    if (seen.has(name)) throw differ(`${name} is installed twice`)
    seen.add(name)
    if (want.dev && !installed.dev) throw differ(`${name} is installed, and locked in packages-dev, which an install without dev leaves out`)
    const spec = Object.fromEntries(Object.entries(entry).filter(([key]) => !INSTALL_FIELDS.has(key)))
    const key = [...new Set([...Object.keys(spec), ...Object.keys(want.spec)])].find((k) => !isDeepStrictEqual(spec[k], want.spec[k]))
    if (key === 'version' && typeof spec.version === 'string') throw differ(`${name} is installed at ${JSON.stringify(spec.version)}, and locked at ${want.spec.version}`)
    // `composer install` takes a package at the version and reference locked as it is, whatever else changed.
    if (key !== undefined) throw differ(`${name}'s ${JSON.stringify(key)} is not as locked`)
  }
  for (const [name, { dev }] of locked) {
    if (!seen.has(name) && (installed.dev || !dev)) throw differ(`${name} is locked, and not installed`)
  }
  const devNames = [...locked].filter(([, { dev }]) => dev && installed.dev).map(([name]) => name.toLowerCase()).toSorted()
  if (!isDeepStrictEqual(installed['dev-package-names'], devNames)) throw differ("its dev-package-names are not the names of the lockfile's packages-dev installed")
  return installed
}

// Its git `source`'s `reference`, where a clone's checkout HEAD (installed from source) or its dist's reference
// is that commit; `directory` '', as Packagist takes a package from its repository's root.
function composerRepo({ source, dist }, fromSource, at) {
  if (source?.type !== 'git') return undefined
  if (fromSource ? at === null || checkoutCommit(at) !== source.reference : dist.reference !== source.reference) return undefined
  const github = parseGithubRepository(source.url)
  return github !== null && isValidRepoField('commit', source.reference) ? { github, directory: '', commit: source.reference } : undefined
}

// As installed.json's `installation-source` says, as it must with no dist, or as a git checkout at `at` shows.
const installedFromSource = ({ dist }, from, at) => from === 'source' || dist == null || (at !== null && existsSync(join(at, '.git')))

function composerInstall(p, from, at) {
  const fromSource = installedFromSource(p, from, at)
  return { repo: composerRepo(p, fromSource, at), integrity: fromSource ? undefined : archiveIntegrity('composer', p.dist.shasum) }
}

// Of composer.lock where there is one, each where Composer installs it, or where installed.json, which must be
// its install, says; else of installed.json alone.
export function loadComposerPackages(baseDir) {
  const { vendorDir } = readComposerJson(baseDir)
  const packageAt = (p, dir, from) => ({ name: p.name, version: p.version, dir, extra: p.extra, ...composerInstall(p, from, dir == null ? null : join(baseDir, dir)) })
  const lockText = readUtf8OrNull(join(baseDir, 'composer.lock'), 'composer.lock')
  if (lockText === null) {
    return readInstalledPackages(baseDir, vendorDir)
      .filter((p) => p?.name && p.version)
      .map((p) => packageAt(p, installedDir(baseDir, vendorDir, p), p['installation-source']))
  }

  const composerJson = readUtf8OrNull(join(baseDir, 'composer.json'), 'composer.json')
  const lock = nameErrors('composer.lock', () => parseComposerLock(lockText, composerJson === null ? {} : { composerJson }), [LockfileError])
  const installedFile = toPosix(join(vendorDir, 'composer', 'installed.json'))
  const installedText = readUtf8OrNull(join(baseDir, installedFile), installedFile)
  const installed = installedText === null ? null : assertInstalledAsLocked(lockText, installedText, { installedFile, vendorDir })
  const dirs = installed === null ? null : new Map(installed.packages.map((p) => [p.name, installedDir(baseDir, vendorDir, p)]))
  const from = new Map(installed?.packages.map((p) => [p.name, p['installation-source']]))
  return Object.values(lock.packages)
    .filter((p) => dirs === null || dirs.has(p.name))
    .map((p) => packageAt(p, dirs === null ? lockedDir(baseDir, vendorDir, p) : dirs.get(p.name), from.get(p.name)))
}

// The root composer.json's `autoload`(+dev) merged with the generated `vendor/composer/autoload_*` maps; null
// where there is no Composer config.
export function loadComposerAutoload(baseDir) {
  const { composerJson, vendorDir } = readComposerJson(baseDir)

  const psr4 = new Map()
  const psr0 = new Map()
  const classmap = new Map()
  const files = new Set()
  let found = false

  const mergeDirs = (map, prefix, dirs) => map.set(prefix, [...new Set([...(map.get(prefix) ?? []), ...dirs])])
  const addPrefixDirs = (map, prefix, paths) => {
    const list = Array.isArray(paths) ? paths : [paths]
    mergeDirs(map, prefix, list.map((p) => normalizeProjectRel(baseDir, String(p))).filter((rel) => rel !== null))
  }

  // PSR-4 keys keep their trailing '\'.
  for (const block of [composerJson?.autoload, composerJson?.['autoload-dev']]) {
    if (!block || typeof block !== 'object') continue
    found = true
    for (const [prefix, paths] of Object.entries(block['psr-4'] ?? {})) addPrefixDirs(psr4, prefix, paths)
    for (const [prefix, paths] of Object.entries(block['psr-0'] ?? {})) addPrefixDirs(psr0, prefix, paths)
    for (const f of block.files ?? []) {
      const rel = normalizeProjectRel(baseDir, String(f))
      if (rel) files.add(rel)
    }
  }

  const composerGenDir = join(baseDir, vendorDir, 'composer')
  const vars = { baseDir: resolve(baseDir), vendorDir: resolve(baseDir, vendorDir) }
  const toRel = (abs) => projectRel(baseDir, abs) || null
  const generated = (name, multi) => {
    const file = join(composerGenDir, name)
    if (!existsSync(file)) return new Map()
    found = true
    return parseGeneratedMap(readFileSync(file, 'utf8'), vars, multi)
  }
  for (const [name, target] of [['autoload_psr4.php', psr4], ['autoload_namespaces.php', psr0]]) {
    for (const [prefix, dirs] of generated(name, true)) {
      mergeDirs(target, prefix, dirs.map(toRel).filter((d) => d !== null).map((d) => d.replace(/\/+$/u, '')))
    }
  }
  for (const [fqcn, abs] of generated('autoload_classmap.php', false)) {
    const rel = toRel(abs)
    if (rel) classmap.set(fqcn.replace(/^\\+/u, ''), rel)
  }
  for (const [, abs] of generated('autoload_files.php', false)) {
    const rel = toRel(abs)
    if (rel) files.add(rel)
  }

  if (!found) return null
  return { psr4, psr0, classmap, files: [...files] }
}

// As Composer looks a class up: its classmap, then each matching PSR-4 prefix longest first (falling back from
// one whose file is absent, to the `""` prefix), then PSR-0's. Only a file on disk, as an absent one is no hole.
export function resolveClassFile(fqcn, autoload, baseDir) {
  if (!autoload || !fqcn) return null
  const name = fqcn.replace(/^\\+/u, '')
  if (!name) return null
  const within = (dir, sub) => (dir ? `${dir}/${sub}` : sub)
  // PSR-0 maps the class name's underscores to directories too, its namespace kept under the prefix's.
  const ns = name.lastIndexOf('\\') + 1
  const psr0 = `${name.slice(0, ns).replace(/\\/gu, '/')}${name.slice(ns).replace(/_/gu, '/')}.php`
  const candidates = [
    ...[autoload.classmap.get(name)].filter(Boolean),
    ...matchingPrefixes(autoload.psr4, name).flatMap(([prefix, dirs]) => dirs.map((dir) => within(dir, `${name.slice(prefix.length).replace(/\\/gu, '/')}.php`))),
    ...matchingPrefixes(autoload.psr0, name).flatMap(([, dirs]) => dirs.map((dir) => within(dir, psr0))),
  ]
  return candidates.find((file) => isFileOnDisk(baseDir, file)) ?? null
}

function matchingPrefixes(map, name) {
  return [...map].filter(([prefix]) => name.startsWith(prefix)).toSorted((a, b) => b[0].length - a[0].length)
}

// From loadComposerPackages, as a package's own composer.json usually omits its `version`.
function packageVersions(packages) {
  const byDir = new Map()
  const byName = new Map()
  for (const { name, version, dir, repo, integrity } of packages) {
    const known = { version, repo, integrity }
    byName.set(name, known)
    if (dir) byDir.set(dir, known)
  }
  return { byDir, byName }
}

function findComposerPackage(baseDir, fileRelPath, installed, fallbackVersion) {
  let dir = dirname(fileRelPath)
  for (;;) {
    const cj = readJsonIfExists(join(baseDir, dir, 'composer.json'))
    if (cj?.name) {
      const known = installed.byDir.get(dir) ?? installed.byName.get(cj.name)
      return { pkgDir: dir, name: cj.name, version: known?.version ?? cj.version ?? fallbackVersion, repo: known?.repo, integrity: known?.integrity }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// By the nearest composer.json's directory; workspace files and orphans in the root "." bucket, the placeholder's.
export function bucketizePhpSources(baseDir, sources, fallbackName, fallbackVersion, packages = loadComposerPackages(baseDir)) {
  const installed = packageVersions(packages)
  const modules = new Map()
  const ensureBucket = (dir, name, version, ecosystem, { repo, integrity } = {}) =>
    upsert(modules, dir, () => moduleInfo({ name, version, ecosystem, ...(ecosystem !== undefined && { integrity, repo }), files: Object.create(null) }))

  for (const [path, content] of sources) {
    const pkg = findComposerPackage(baseDir, path, installed, fallbackVersion)
    if (pkg) {
      const rel = fileInBucket(pkg.pkgDir, path)
      // The root package is workspace code; one below it an installed dependency.
      const ecosystem = pkg.pkgDir === '.' ? undefined : 'composer'
      ensureBucket(pkg.pkgDir, pkg.name, pkg.version, ecosystem, pkg).files[rel] = content
    } else {
      ensureBucket('.', fallbackName, fallbackVersion).files[path] = content
    }
  }
  return modules
}

// Laravel registers service providers nothing references statically: composer.json's and the `packages`'
// `extra.laravel.providers`, and bootstrap/providers.php, are roots of their own.
export function loadLaravelProviderFiles(baseDir, autoload, packages = loadComposerPackages(baseDir)) {
  const files = new Set()
  if (existsSync(join(baseDir, 'bootstrap', 'providers.php'))) files.add('bootstrap/providers.php')
  if (!autoload) return [...files]

  const { composerJson } = readComposerJson(baseDir)
  const fqcns = new Set(composerJson?.extra?.laravel?.providers ?? [])
  for (const pkg of packages) {
    for (const fqcn of pkg.extra?.laravel?.providers ?? []) fqcns.add(fqcn)
  }
  for (const fqcn of fqcns) {
    const file = resolveClassFile(fqcn, autoload, baseDir)
    if (file) files.add(file)
  }
  return [...files]
}

// Names that can sit where a class reference does (`return $x`, `new class`, …) and are none.
const RESERVED = new Set([
  'self', 'static', 'parent', 'this',
  'int', 'integer', 'float', 'double', 'string', 'bool', 'boolean', 'void',
  'array', 'callable', 'iterable', 'object', 'mixed', 'null', 'false', 'true',
  'never', 'numeric',
  'return', 'echo', 'print', 'clone', 'yield', 'throw', 'global', 'and', 'or', 'xor',
  'as', 'else', 'elseif', 'do', 'class', 'fn', 'match', 'enddeclare', 'endforeach',
  'endif', 'endswitch', 'endwhile', 'endfor',
])

// As PHP resolves a name: a leading `\` fully qualified, a first segment an alias expands, else relative to `ns`.
function addRef(set, raw, ns, aliasMap) {
  const n = raw.trim().replace(/^\?/u, '') // drop a nullable-type marker (`?Foo`)
  if (!n || !/^\\?[A-Za-z_][\w\\]*$/u.test(n)) return
  if (n.startsWith('\\')) {
    set.add(n.replace(/^\\+/u, ''))
    return
  }
  const [first, ...rest] = n.split('\\')
  if (rest.length === 0 && RESERVED.has(n.toLowerCase())) return
  if (aliasMap.has(first)) set.add([aliasMap.get(first), ...rest].join('\\'))
  else set.add(ns ? `${ns}\\${n}` : n)
}

// A `use` body's names, comma lists and groups (`Pre\{A, B as C}`) too, each `short` its alias or last segment.
function parseUseBody(body) {
  const grouped = body.match(/^([\w\\]+\\)\{([\s\S]*)\}$/u)
  const entries = grouped
    ? grouped[2].split(',').map((p) => `${grouped[1]}${p.trim()}`)
    : body.split(',')
  const out = []
  for (const entry of entries) {
    const [name, alias] = entry.trim().split(/\s+as\s+/iu).map((s) => s.trim())
    if (!name || !/^\\?[\w\\]+$/u.test(name)) continue
    const fqcn = name.replace(/^\\+/u, '')
    out.push({ name, short: alias || fqcn.split('\\').pop() })
  }
  return out
}

// The first class-like declaration ends the import region: a `use` before it is an alias import; after it, an
// in-body trait use, which loads the trait.
function firstDeclPos(stripped) {
  const m = stripped.match(/(?<![:\w$\\>])\b(?:class|interface|trait|enum)\b/iu)
  return m ? m.index : Infinity
}

// A `use` import only aliases and loads nothing, so is no dependency: only where a class is referenced is.
export function phpClassDependencies(content) {
  // Strings blanked too, so class-reference scans don't trip over text in them.
  const stripped = maskNonCode(content, false)
  const nsMatch = stripped.match(/\bnamespace\s+([\w\\]+)/u)
  const ns = nsMatch ? nsMatch[1].replace(/^\\+|\\+$/gu, '') : ''
  const set = new Set()
  const aliasMap = new Map()
  const add = (raw) => addRef(set, raw, ns, aliasMap)
  const addAll = (re, separator) => {
    for (const m of stripped.matchAll(re)) for (const nm of separator ? m[1].split(separator) : [m[1]]) add(nm)
  }

  const declAt = firstDeclPos(stripped)
  for (const m of stripped.matchAll(/\buse\s+(?!\()(function\s+|const\s+)?([\s\S]*?);/giu)) {
    if (m[1]) continue
    const entries = parseUseBody(m[2].trim())
    if (m.index < declAt) {
      for (const e of entries) aliasMap.set(e.short, e.name.replace(/^\\+/u, ''))
    } else {
      for (const e of entries) add(e.name)
    }
  }

  addAll(/(?<![\w$\\])new\s+(\\?[\w\\]+)/giu)
  addAll(/(?<![\w$\\])instanceof\s+(\\?[\w\\]+)/giu)
  addAll(/(?<![\w$\\])(\\?[\w\\]+)\s*::/giu)
  addAll(/#\[\s*(\\?[\w\\]+)/giu)
  for (const m of stripped.matchAll(/\b(?:class|interface|trait|enum)\b[^{;]*?\{/giu)) {
    const header = m[0]
    const ext = header.match(/\bextends\s+([\w\\\s,?]+?)(?:\bimplements\b|\{)/iu)
    if (ext) for (const nm of ext[1].split(',')) add(nm)
    const impl = header.match(/\bimplements\s+([\w\\\s,?]+?)\{/iu)
    if (impl) for (const nm of impl[1].split(',')) add(nm)
  }
  // `catch (A | B $e)`, or PHP 8's with no variable: one quantifier with nothing after it keeps matching linear
  // on adversarial input.
  addAll(/\bcatch\s*\(([^)$]*)/giu, '|')
  // Type hints, `?Type`, variadic, by-ref and `A|B`/`A&B` too, then return types: only one whitespace quantifier
  // is unbounded (the inner `\s*` behind `[&.]`), against catastrophic backtracking.
  addAll(/(?<![\w$\\])([?\w\\|&]+)\s+(?:[&.]+\s*)?\$\w+/giu, /[|&]/u)
  addAll(/\)\s*:\s*([?\w\\|&]+)/giu, /[|&]/u)
  return set
}

function autoloadEdges(content, autoload, baseDir, sources) {
  const edges = new Map()
  if (!autoload) return edges
  for (const fqcn of phpClassDependencies(content)) {
    const file = resolveClassFile(fqcn, autoload, baseDir)
    if (file && (sources === null || sources.has(file))) edges.set(fqcn, file)
  }
  return edges
}

// Explicit includes are strict (unresolvable -> `missing`); Composer-autoloaded class refs (with `autoload`)
// best-effort, never `missing`.
export function buildPhpTree(sources, { baseDir, autoload = null } = {}) {
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const spec of extractPhpImports(content)) {
      // A specifier naming a stored key verbatim is taken where it resolves to none.
      const resolved = [resolvePhpImport(spec, path, { baseDir }), spec].find((p) => p && sources.has(p))
      if (resolved) specMap.set(spec, resolved)
      else {
        console.warn(`[loader.php] Missing import: ${spec} from ${path}`)
        missing.push({ spec, from: path })
      }
    }
    for (const [fqcn, file] of autoloadEdges(content, autoload, baseDir, sources)) specMap.set(fqcn, file)
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

export async function collectPhpFilesFromDisk(baseDir, entries, { autoload = null } = {}) {
  const sources = new Map()
  const realBase = realpathSync(baseDir)

  const readOne = async (relPath) => {
    try {
      assertRealPathWithinBase(realBase, baseDir, relPath)
      const bytes = await readFile(join(baseDir, relPath))
      // One that isn't UTF-8 is refused rather than carried with U+FFFD in it.
      if (!isUtf8(bytes)) throw new Error(`PHP source is not valid UTF-8: ${relPath}`)
      return [relPath, bytes.toString('utf8')]
    } catch (err) {
      // No file, or a specifier resolved to a directory: buildPhpTree tells a real include's edge unresolved.
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        console.warn(`[loader.php] Missing import: ${relPath}`)
        return null
      }
      throw err
    }
  }

  // Composer `files` autoload entries load unconditionally, so they're roots too.
  for (let wave = [...entries, ...(autoload?.files ?? [])]; wave.length > 0;) {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    const reads = []
    for (let k = 0; k < toLoad.length; k += READ_CONCURRENCY) {
      // eslint-disable-next-line no-await-in-loop -- batches are intentionally sequential to cap open files
      reads.push(...(await Promise.all(toLoad.slice(k, k + READ_CONCURRENCY).map(readOne))))
    }
    const next = []
    for (const [relPath, content] of reads.filter(Boolean)) {
      sources.set(relPath, content)
      const masked = maskedPhp(content)
      const includes = scanIncludes(masked)
      for (const spec of includeSpecs(includes, 'file')) {
        const resolved = resolvePhpImport(spec, relPath, { baseDir })
        if (resolved) next.push(resolved)
        else console.warn(`[loader.php] Missing import: ${spec} from ${relPath}`)
      }
      for (const dirSpec of includeSpecs(includes, 'dir')) {
        const dir = resolvePhpDir(dirSpec, relPath, baseDir)
        if (dir) for (const file of listPhpFiles(baseDir, dir)) next.push(file)
      }
      // Best-effort: only those that resolve to a file.
      for (const { spec, anchor } of pathRefs(masked)) {
        const resolved = anchor === 'root' ? normalizeProjectRel(baseDir, spec) : resolvePhpImport(spec, relPath, { baseDir })
        if (resolved && isFileOnDisk(baseDir, resolved)) next.push(resolved)
      }
      for (const file of autoloadEdges(content, autoload, baseDir, null).values()) next.push(file)
    }
    wave = next
  }
  return sources
}
