import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { isValidRepoField } from '@exodus/stasis-core/bundle'
import { checkoutCommit, parseGithubRepository } from '@exodus/stasis-core/bundle-util'
import { archiveIntegrity, fileInBucket, isPlainObject, memoized, moduleInfo, relativeEscapes, toPosix, upsert } from '@exodus/stasis-core/util'
import { LockfileError, parseComposerLock } from '@preventive/lockfile/composer.js'
import { isDir, isFile } from '../resolve-typescript.js'
import { collectFromDisk } from './bash.js'
import { ancestors, applyToDir, isDotRelative } from './paths.js'
import { readUtf8OrNull } from './solidity-ownership.js'
import { nameErrors } from './toml.js'

// A string literal, its quote and what it holds; an unterminated one runs to the end.
const LITERAL = String.raw`(['"])((?:\\[\s\S]?|(?!\1)[^\\])*)\1?`
const LITERAL_RE = new RegExp(LITERAL, 'uy')
// A string literal (group 1), a comment, or a heredoc/nowdoc to the end of its closing label's line, else of the code.
const NON_CODE_RE = new RegExp([
  LITERAL,
  // `#[` is a PHP 8 attribute, code.
  String.raw`//[^\n]*|#(?!\[)[^\n]*|/\*[\s\S]*?(?:\*/|$)`,
  String.raw`<<<[ \t]*["']?(\w+)[^\n]*(?:\n(?![ \t]*\3(?!\w))[^\n]*)*(?:\n[ \t]*\3[^\n]*)?`,
].join('|'), 'gu')

// Comments, heredocs/nowdocs and (unless `keepStrings`) string literals blanked, newlines kept so offsets stay
// the input's.
const maskNonCode = (content, keepStrings) =>
  content.replace(NON_CODE_RE, (token, quote) => (keepStrings && quote !== undefined ? token : token.replace(/[^\n]/gu, ' ')))

// The literal opening at `pos` of maskNonCode's code, null where none does. Only `\\` and the closing quote unescaped,
// as PHP's single quotes do: good enough for path values.
function literalAt(code, pos) {
  LITERAL_RE.lastIndex = pos
  const m = LITERAL_RE.exec(code)
  if (m === null) return null
  const [, quote, body] = m
  const value = body.replace(/\\([\s\S])/gu, (escape, c) => (c === '\\' || c === quote ? c : escape))
  return { end: LITERAL_RE.lastIndex, quote, value }
}

// `pattern` in maskNonCode's code outside its string literals: a literal matches first, as group 1, to be skipped.
const codeRegExp = (pattern, flags) => new RegExp(`${LITERAL}|${pattern}`, flags)
const codeMatches = (code, re) => code.matchAll(re).filter((m) => m[1] === undefined)

// The lookbehind rejects `$x->require` and `Foo::include`, the `\b` `requireConfig`.
const PHP_INCLUDE_KEYWORD_RE = codeRegExp(String.raw`(?<![\w$>:])(?:require_once|require|include_once|include)\b`, 'giu')
const PHP_DIR_ANCHOR_RE = /__DIR__\b|dirname\s*\(\s*(__FILE__|__DIR__)\s*(?:,\s*(\d+)\s*)?\)/y
const PHP_DIR_ANCHOR_FIND_RE = codeRegExp(String.raw`(?<![\w$>])(?:__DIR__\b|dirname\s*\(\s*(?:__FILE__|__DIR__))`, 'gu')

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
const PHP_PATH_HELPER_FIND_RE = codeRegExp(String.raw`(?<![\w$>:])(?<helper>${[...PHP_PATH_HELPERS.keys()].join('|')})\s*\(`, 'giu')

// A double-quoted string's interpolation; a single-quoted one's `$` is literal.
const PHP_INTERPOLATION_RE = /\$[A-Za-z_{]|\{\$/u

function skipWs(code, pos) {
  while (pos < code.length && /\s/u.test(code[pos])) pos++
  return pos
}

function normalizeIncludePath(raw, dirRelative) {
  if (!dirRelative) return raw
  const rel = raw.replace(/^\/+/u, '')
  return rel === '' ? '.' : isDotRelative(rel) ? rel : `./${rel}`
}

// Null with neither a directory anchor nor a literal; `dynamic` from the first variable, call or interpolation.
function parseArgPath(code, start) {
  PHP_DIR_ANCHOR_RE.lastIndex = start
  const anchor = PHP_DIR_ANCHOR_RE.exec(code)
  const dirRelative = anchor !== null
  const up = anchor?.[1] === '__DIR__' ? Number(anchor[2] ?? 1) : 0
  let i = start
  if (anchor) {
    i = skipWs(code, PHP_DIR_ANCHOR_RE.lastIndex)
    if (code[i] !== '.') return null
    i = skipWs(code, i + 1)
  } else if (!literalAt(code, i)) return null
  let prefix = '/..'.repeat(up)
  for (;;) {
    const lit = literalAt(code, i)
    if (!lit) return { dirRelative, up, prefix, dynamic: true }
    const interp = lit.quote === '"' ? lit.value.search(PHP_INTERPOLATION_RE) : -1
    if (interp >= 0) return { dirRelative, up, prefix: prefix + lit.value.slice(0, interp), dynamic: true }
    prefix += lit.value
    i = skipWs(code, lit.end)
    if (code[i] !== '.') return { dirRelative, up, prefix, dynamic: false }
    i = skipWs(code, i + 1)
  }
}

// Each include's file, and a dynamic one's static directory prefix (`dirs`): any `.php` file in it may be its target
// at runtime.
function scanIncludes(code) {
  const files = []
  const dirs = []
  for (const m of codeMatches(code, PHP_INCLUDE_KEYWORD_RE)) {
    let i = skipWs(code, m.index + m[0].length)
    if (code[i] === '(') i = skipWs(code, i + 1)
    const arg = parseArgPath(code, i)
    if (!arg) continue
    const { dirRelative, up, prefix, dynamic } = arg
    if (!dynamic) files.push(normalizeIncludePath(prefix, dirRelative))
    else if (dirRelative || prefix.includes('/')) {
      let dir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : ''
      if (dir === '' && up > 0) dir = '/..'.repeat(up)
      dirs.push(normalizeIncludePath(dir, dirRelative))
    }
  }
  return { files, dirs }
}

// `.php` path literals outside a `require`, which frameworks require() themselves, each once: a directory-anchored
// one's from the file, a path helper's from the project root.
function scanPathLiterals(code) {
  const refs = new Map()
  const add = (spec, anchor) => {
    if (spec.endsWith('.php')) refs.set(`${anchor}:${spec}`, { spec, anchor })
  }
  for (const m of codeMatches(code, PHP_DIR_ANCHOR_FIND_RE)) {
    const arg = parseArgPath(code, m.index)
    if (arg && !arg.dynamic && arg.dirRelative) add(normalizeIncludePath(arg.prefix, true), 'file')
  }
  for (const m of codeMatches(code, PHP_PATH_HELPER_FIND_RE)) {
    const lit = literalAt(code, skipWs(code, m.index + m[0].length))
    if (!lit || (lit.quote === '"' && PHP_INTERPOLATION_RE.test(lit.value))) continue
    const sub = PHP_PATH_HELPERS.get(m.groups.helper.toLowerCase())
    const arg = lit.value.replace(/^\/+/u, '')
    add(sub ? `${sub}/${arg}` : arg, 'root')
  }
  return [...refs.values()]
}

// String literals kept, as include paths live in them.
export const extractPhpImports = (content) => scanIncludes(maskNonCode(content, true)).files
export const extractPhpImportDirs = (content) => scanIncludes(maskNonCode(content, true)).dirs
export const extractPhpPathRefs = (content) => scanPathLiterals(maskNonCode(content, true))

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
      .map((e) => `${dir}/${e.name}`)
  } catch {
    return []
  }
}

export const resolvePhpImport = (specifier, fromFile, { baseDir } = {}) =>
  resolvePhpSpec(specifier, fromFile, baseDir, (rel) => isFileOnDisk(baseDir, rel))

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
  let parsed = 0
  for (const m of s.matchAll(/\$(\w+)|'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|\.|\s+/gy)) {
    parsed = m.index + m[0].length
    if (m[1] !== undefined) {
      if (vars[m[1]] === undefined) return null
      out += vars[m[1]]
    } else if (m[2] !== undefined) {
      out += m[2].replace(/\\(['\\])/gu, '$1')
    } else if (m[3] !== undefined) {
      out += m[3]
    }
  }
  if (parsed !== s.length) return null
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

// An integer past ±(2^53 − 1) a BigInt, as @preventive/lockfile reads one, so two values compare equal only
// where PHP's do.
const parseJsonExact = (text) => JSON.parse(text, (key, value, { source }) =>
  (typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/u.test(source) ? BigInt(source) : value))

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

// Of composer.lock, each where Composer installs it, or where installed.json, which must be its install, says.
export function loadComposerPackages(baseDir) {
  const { vendorDir } = readComposerJson(baseDir)
  const vendored = (...path) => projectRel(baseDir, resolve(baseDir, vendorDir, ...path))
  // Where `installed`, its installed.json entry, says: its install-path is from vendor/composer, null for a
  // metapackage; Composer 1's gives none. Without one, as LibraryInstaller::getInstallPath puts it; one an installer
  // plugin takes goes elsewhere, where its own composer.json's name finds it.
  const dirOf = (p, installed) => {
    if (installed === undefined) return p.type === 'metapackage' ? null : vendored(p.name, p.targetDir ?? '')
    const path = installed['install-path']
    if (path === undefined) return vendored(p.name)
    return typeof path === 'string' ? vendored('composer', path) : null
  }
  const packageAt = (p, installed) => {
    const dir = dirOf(p, installed)
    const at = dir === null ? null : join(baseDir, dir)
    // As installed.json's `installation-source` says, as it must with no dist, or as a git checkout at `at` shows.
    const fromSource = installed?.['installation-source'] === 'source' || p.dist == null || (at !== null && existsSync(join(at, '.git')))
    const integrity = fromSource ? undefined : archiveIntegrity('composer', p.dist.shasum)
    return { name: p.name, version: p.version, dir, extra: p.extra, repo: composerRepo(p, fromSource, at), integrity }
  }
  const lockText = readUtf8OrNull(join(baseDir, 'composer.lock'), 'composer.lock')
  if (lockText === null) {
    // Composer 2's `{ packages }`, or Composer 1's flat array.
    const json = readJsonIfExists(join(baseDir, vendorDir, 'composer', 'installed.json'))
    return (Array.isArray(json) ? json : (json?.packages ?? [])).filter((p) => p?.name && p.version).map((p) => packageAt(p, p))
  }

  const composerJson = readUtf8OrNull(join(baseDir, 'composer.json'), 'composer.json')
  const lock = nameErrors('composer.lock', () => parseComposerLock(lockText, composerJson === null ? {} : { composerJson }), [LockfileError])
  const installedFile = toPosix(join(vendorDir, 'composer', 'installed.json'))
  const installedText = readUtf8OrNull(join(baseDir, installedFile), installedFile)
  const installed = installedText === null ? null : assertInstalledAsLocked(lockText, installedText, { installedFile, vendorDir })
  const byName = installed && new Map(installed.packages.map((p) => [p.name, p]))
  return Object.values(lock.packages).filter((p) => byName === null || byName.has(p.name)).map((p) => packageAt(p, byName?.get(p.name)))
}

// Null where there is no Composer config.
export function loadComposerAutoload(baseDir) {
  const { composerJson, vendorDir } = readComposerJson(baseDir)

  const psr4 = new Map()
  const psr0 = new Map()
  const classmap = new Map()
  const files = new Set()
  let found = false

  const addDirs = (map, prefix, dirs) => map.set(prefix, [...new Set([...(map.get(prefix) ?? []), ...dirs.filter((dir) => dir !== null)])])
  const declared = (p) => normalizeProjectRel(baseDir, String(p))

  // PSR-4 keys keep their trailing '\'.
  for (const block of [composerJson?.autoload, composerJson?.['autoload-dev']]) {
    if (!block || typeof block !== 'object') continue
    found = true
    for (const [map, key] of [[psr4, 'psr-4'], [psr0, 'psr-0']]) {
      for (const [prefix, paths] of Object.entries(block[key] ?? {})) addDirs(map, prefix, [paths].flat().map(declared))
    }
    for (const f of block.files ?? []) {
      const rel = declared(f)
      if (rel) files.add(rel)
    }
  }

  const vars = { baseDir: resolve(baseDir), vendorDir: resolve(baseDir, vendorDir) }
  const toRel = (abs) => projectRel(baseDir, abs) || null
  const generated = (name, multi) => {
    const file = join(baseDir, vendorDir, 'composer', name)
    if (!existsSync(file)) return new Map()
    found = true
    return parseGeneratedMap(readFileSync(file, 'utf8'), vars, multi)
  }
  for (const [name, map] of [['autoload_psr4.php', psr4], ['autoload_namespaces.php', psr0]]) {
    for (const [prefix, dirs] of generated(name, true)) addDirs(map, prefix, dirs.map(toRel))
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
  const psr4 = (prefix) => `${name.slice(prefix.length).replace(/\\/gu, '/')}.php`
  const matching = (map) => [...map].filter(([prefix]) => name.startsWith(prefix)).toSorted((a, b) => b[0].length - a[0].length)
  const candidates = [
    ...[autoload.classmap.get(name)].filter(Boolean),
    ...matching(autoload.psr4).flatMap(([prefix, dirs]) => dirs.map((dir) => within(dir, psr4(prefix)))),
    ...matching(autoload.psr0).flatMap(([, dirs]) => dirs.map((dir) => within(dir, psr0))),
  ]
  return candidates.find((file) => isFileOnDisk(baseDir, file)) ?? null
}

// By the nearest composer.json's directory; workspace files and orphans in the root "." bucket, the placeholder's.
// A package's own composer.json usually omits its `version`, which `packages` (loadComposerPackages') tell.
export function bucketizePhpSources(baseDir, sources, fallbackName, fallbackVersion, packages = loadComposerPackages(baseDir)) {
  const byDir = new Map(packages.filter((p) => p.dir).map((p) => [p.dir, p]))
  const byName = new Map(packages.map((p) => [p.name, p]))
  const manifest = memoized((dir) => readJsonIfExists(join(baseDir, dir, 'composer.json')))
  const modules = new Map()
  const bucket = (dir, info) => upsert(modules, dir, () => moduleInfo({ ...info, files: Object.create(null) }))

  for (const [path, content] of sources) {
    const dir = ancestors(dirname(path)).find((at) => manifest(at)?.name)
    if (dir === undefined) {
      bucket('.', { name: fallbackName, version: fallbackVersion }).files[path] = content
      continue
    }
    const { name, version } = manifest(dir)
    const known = byDir.get(dir) ?? byName.get(name)
    // The root package is workspace code; one below it an installed dependency.
    const installed = dir === '.' ? {} : { ecosystem: 'composer', integrity: known?.integrity, repo: known?.repo }
    bucket(dir, { name, version: known?.version ?? version ?? fallbackVersion, ...installed }).files[fileInBucket(dir, path)] = content
  }
  return modules
}

// Laravel registers service providers nothing references statically: composer.json's and the `packages`'
// `extra.laravel.providers`, and bootstrap/providers.php, are roots of their own.
export function loadLaravelProviderFiles(baseDir, autoload, packages = loadComposerPackages(baseDir)) {
  const files = new Set()
  if (existsSync(join(baseDir, 'bootstrap', 'providers.php'))) files.add('bootstrap/providers.php')
  if (!autoload) return [...files]

  const fqcns = new Set(readComposerJson(baseDir).composerJson?.extra?.laravel?.providers ?? [])
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

function* parseUseBody(body) {
  const grouped = body.match(/^([\w\\]+\\)\{([\s\S]*)\}$/u)
  const entries = grouped
    ? grouped[2].split(',').map((p) => `${grouped[1]}${p.trim()}`)
    : body.split(',')
  for (const entry of entries) {
    const [name, alias] = entry.trim().split(/\s+as\s+/iu).map((s) => s.trim())
    if (!/^\\?[\w\\]+$/u.test(name)) continue
    yield { name, short: alias || name.replace(/^\\+/u, '').split('\\').pop() }
  }
}

// A `use` import only aliases and loads nothing, so is no dependency: only where a class is referenced is.
export function phpClassDependencies(content) {
  // Strings blanked too, so class-reference scans don't trip over text in them.
  const stripped = maskNonCode(content, false)
  const ns = stripped.match(/\bnamespace\s+([\w\\]+)/u)?.[1].replace(/^\\+|\\+$/gu, '') ?? ''
  const set = new Set()
  const aliasMap = new Map()
  // As PHP resolves a name: a leading `\` fully qualified, a first segment an alias expands, else relative to `ns`.
  const add = (raw) => {
    const n = raw.trim().replace(/^\?/u, '') // drop a nullable-type marker (`?Foo`)
    if (!/^\\?[A-Za-z_][\w\\]*$/u.test(n)) return
    if (n.startsWith('\\')) {
      set.add(n.slice(1))
      return
    }
    const [first, ...rest] = n.split('\\')
    if (rest.length === 0 && RESERVED.has(n.toLowerCase())) return
    if (aliasMap.has(first)) set.add([aliasMap.get(first), ...rest].join('\\'))
    else set.add(ns ? `${ns}\\${n}` : n)
  }
  const addAll = (re, separator) => {
    for (const m of stripped.matchAll(re)) for (const nm of separator ? m[1].split(separator) : [m[1]]) add(nm)
  }

  // The first class-like declaration ends the import region: a `use` before it is an alias import; after it, an
  // in-body trait use, which loads the trait.
  const declAt = stripped.match(/(?<![:\w$\\>])\b(?:class|interface|trait|enum)\b/iu)?.index ?? Infinity
  for (const m of stripped.matchAll(/\buse\s+(?!\()(function\s+|const\s+)?([\s\S]*?);/giu)) {
    if (m[1]) continue
    for (const { name, short } of parseUseBody(m[2].trim())) {
      if (m.index < declAt) aliasMap.set(short, name.replace(/^\\+/u, ''))
      else add(name)
    }
  }

  addAll(/(?<![\w$\\])new\s+(\\?[\w\\]+)/giu)
  addAll(/(?<![\w$\\])instanceof\s+(\\?[\w\\]+)/giu)
  addAll(/(?<![\w$\\])(\\?[\w\\]+)\s*::/giu)
  addAll(/#\[\s*(\\?[\w\\]+)/giu)
  for (const [header] of stripped.matchAll(/\b(?:class|interface|trait|enum)\b[^{;]*?\{/giu)) {
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

// Each class `content` references and the file Composer's `autoload` finds it in on disk.
function* autoloadEdges(content, autoload, baseDir) {
  if (!autoload) return
  for (const fqcn of phpClassDependencies(content)) {
    const file = resolveClassFile(fqcn, autoload, baseDir)
    if (file) yield [fqcn, file]
  }
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
    for (const [fqcn, file] of autoloadEdges(content, autoload, baseDir)) if (sources.has(file)) specMap.set(fqcn, file)
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

// No file, or a specifier resolved to a directory: buildPhpTree tells a real include's edge unresolved.
const PHP_FILES = {
  what: 'PHP source',
  skipped: { ENOENT: '[loader.php] Missing import', EISDIR: '[loader.php] Missing import' },
}

export async function collectPhpFilesFromDisk(baseDir, entries, { autoload = null } = {}) {
  function* refsOf(relPath, content) {
    const code = maskNonCode(content, true)
    const { files, dirs } = scanIncludes(code)
    for (const spec of files) {
      const resolved = resolvePhpImport(spec, relPath, { baseDir })
      if (resolved) yield resolved
      else console.warn(`[loader.php] Missing import: ${spec} from ${relPath}`)
    }
    for (const spec of dirs) {
      const dir = resolvePhpDir(spec, relPath, baseDir)
      if (dir) yield* listPhpFiles(baseDir, dir)
    }
    for (const { spec, anchor } of scanPathLiterals(code)) {
      const resolved = anchor === 'root' ? normalizeProjectRel(baseDir, spec) : resolvePhpImport(spec, relPath, { baseDir })
      if (resolved && isFileOnDisk(baseDir, resolved)) yield resolved
    }
    for (const [, file] of autoloadEdges(content, autoload, baseDir)) yield file
  }
  // Composer `files` autoload entries load unconditionally, so they're roots too.
  return collectFromDisk(baseDir, [...entries, ...(autoload?.files ?? [])], PHP_FILES, refsOf)
}
