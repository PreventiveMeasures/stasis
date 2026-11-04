#!/usr/bin/env node

// A self-contained `stasis extract`: unpacks a `stasis.code.br` bundle onto disk with nothing but
// Node's builtins, so it can be read whole and run without installing @exodus/stasis.
//
//   node scripts/stasis-extract.mjs [--output=path/to/dir] path/to/bundle.stasis.code.br
//
// It mirrors `stasis extract --lock=none` (stasis-core/src/extract.js, and Bundle.parse from
// stasis-core/src/bundle.js and artifact-util.js for the bundle it reads): the same checks of the
// bundle as untrusted input and of what is already on disk, all before the first write, the same
// files written, and the same execute bits. It has no lockfile support: there is no `--lock`, and a
// `stasis.lock.json` in the output dir is an error, as is a `<name>.stasis.lock.json` when the bundle
// is `<name>.stasis.code.br` (which the bundle may not write either). To verify a bundle against a
// lockfile, merge it into one, or write one, use `stasis extract` (doc/extract.md).
//
// Not part of any package: keep it in step with the sources above by hand.

import { Buffer } from 'node:buffer'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

const LABEL = 'stasis-extract'
const FILE_LOCK = 'stasis.lock.json'
const VERSION = 1
const LEGACY_VERSION = 0
const EXECUTE_BITS = 0o111

// --- Bundle.parse, as far as extract needs it: every check it makes, nothing it keeps but what extract reads. ---

const KNOWN_FORMATS = new Set([
  'module', 'commonjs', 'json', 'module-typescript', 'commonjs-typescript',
  'solidity', 'php', 'shell', 'rust',
  'java', 'kotlin', 'gradle', 'objc', 'objcpp', 'swift', 'c', 'cpp', 'c-header', 'cpp-header',
  'ruby', 'python', 'cmake', 'podspec', 'podfile', 'podfile-lock', 'template', 'xml', 'env', 'fastlane', 'pbxproj',
  'resource', 'resource:base64',
  'patch',
  'directory',
  'stat:file', 'stat:directory',
])
const isStatFormat = (format) => format === 'stat:file' || format === 'stat:directory'

function assert(condition, msg) {
  if (!condition) throw new Error(msg)
}

const isPlainObject = (x) => x && [null, Object.prototype].includes(Object.getPrototypeOf(x))
const fromEntries = (entries) => Object.setPrototypeOf(Object.fromEntries(entries), null)

// Flat project-relative key; `rel === ''` (a `directory` capture at a bucket's own path) keys the bare dir.
const moduleFileKey = (dir, rel) => (rel === '' ? dir : dir === '.' ? rel : `${dir}/${rel}`)

// stasis's lockfile, by name at any depth and in any case.
const isLockfileName = (path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase() === FILE_LOCK

const hasNodeModulesSegment = (path) => path.split('/').includes('node_modules')

// Absolute, or a `..` hop that pops above the root, a mid-path one (`a/../../x`) included.
function posixPathEscapes(path) {
  if (path.startsWith('/')) return true
  if (!path.includes('..')) return false
  let depth = 0
  for (const segment of path.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment !== '..') depth++
    else if (--depth < 0) return true
  }
  return false
}

// Every path a bundle records stays in the root and holds no `\`.
const isRefusedPath = (path) => path.includes('\\') || posixPathEscapes(path)
const assertArtifactPath = (path, what) => assert(!isRefusedPath(path), `${what}: path '${path}' escapes the root or holds a '\\'`)

// An empty, '.' or '..' path segment.
const NON_CANONICAL_SEGMENT = /(?:^|\/)\.{0,2}(?:\/|$)/u

function canonicalFileKey(dir, rel) {
  const key = moduleFileKey(dir, rel)
  if ((key !== '.' || rel !== '') && NON_CANONICAL_SEGMENT.test(key)) assert(false, `bundle: non-canonical file key ${JSON.stringify(key)}`)
  if (key.includes('\\')) assert(false, `bundle: file key '${key}' holds a '\\', which no path may`)
  return key
}

// The deepest segment-aligned `node_modules/<pkg>` of a v0 path: its bucket, else null.
function splitNodeModulesPath(path) {
  const marker = 'node_modules/'
  let idx = path.length
  while ((idx = path.lastIndexOf(marker, idx - 1)) !== -1) {
    if (idx === 0 || path[idx - 1] === '/') break
  }
  if (idx === -1) return null
  const after = idx + marker.length
  const parts = path.slice(after).split('/')
  const pkgLen = parts[0].startsWith('@') ? 2 : 1
  if (parts.length <= pkgLen || parts.slice(0, pkgLen).some((p) => !p)) return null
  const name = parts.slice(0, pkgLen).join('/')
  return { dir: path.slice(0, after) + name, rel: parts.slice(pkgLen).join('/'), name }
}

// A v0 path's bucket split; '' and '.' both spell the root listing (rel '').
const inferModuleDir = (path) => splitNodeModulesPath(path) ?? { dir: '.', rel: path === '.' ? '' : path, name: null }

function parseFormats(json) {
  assert(isPlainObject(json))
  const formats = new Map()
  for (const [file, format] of Object.entries(json)) {
    assertArtifactPath(file, 'formats')
    assert(KNOWN_FORMATS.has(format), `unknown format '${format}' for ${file}`)
    const key = file === '' ? '.' : file
    assert(!formats.has(key), `duplicate format key '${key}'`)
    formats.set(key, format)
  }
  return formats
}

function parseEntries(list) {
  assert(Array.isArray(list), 'bundle: entries must be an array of file paths')
  const seen = new Set()
  for (const entry of list) {
    assert(typeof entry === 'string' && entry !== '' && !isRefusedPath(entry), `bundle: invalid entry ${JSON.stringify(entry)}`)
    assert(!seen.has(entry), `bundle: entry '${entry}' is listed twice`)
    seen.add(entry)
  }
}

// conditions -> parent -> specifier -> target: a file, or a non-empty { platform: file } map.
function checkImports(json) {
  assert(isPlainObject(json))
  for (const byParent of Object.values(json)) {
    assert(isPlainObject(byParent))
    for (const [parent, specifiers] of Object.entries(byParent)) {
      assertArtifactPath(parent, 'imports')
      assert(isPlainObject(specifiers))
      for (const target of Object.values(specifiers)) {
        if (typeof target === 'string') {
          assertArtifactPath(target, 'imports')
          continue
        }
        assert(isPlainObject(target) && Object.keys(target).length > 0, 'import target must be a file or a non-empty {platform: file} map')
        for (const [platform, file] of Object.entries(target)) {
          assert(platform.length > 0 && !platform.includes('/'), `invalid platform key '${platform}'`)
          assert(typeof file === 'string')
          assertArtifactPath(file, 'imports')
        }
      }
    }
  }
}

// The metadata blocks carry nothing extract uses, but a bundle Bundle.parse refuses for them is refused here too.
const GITHUB_REPO = /^(?=[A-Za-z0-9-]{1,39}\/)[A-Za-z0-9](?:-?[A-Za-z0-9])*\/(?!\.\.?$)[\w.-]{1,100}$/u
const REPO_DIRECTORY = /^(?!\.\.?(?:\/|$))[\w.~@+-]+(?:\/(?!\.\.?(?:\/|$))[\w.~@+-]+)*$/u
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
const REPO_FIELDS = {
  github: (v) => typeof v === 'string' && GITHUB_REPO.test(v),
  directory: (v) => typeof v === 'string' && v.length <= 1024 && (v === '' || REPO_DIRECTORY.test(v)),
  commit: (v) => typeof v === 'string' && GIT_SHA.test(v),
}
const isPackageString = (v) => typeof v === 'string' && /^[\w.+@/~'!()*-]+$/u.test(v)
const PACKAGE_BLOCK = { name: isPackageString, version: isPackageString }
const PACKAGE_FIELDS = { npm: PACKAGE_BLOCK, composer: PACKAGE_BLOCK, cargo: PACKAGE_BLOCK }

// A block checked against its `fields` (each optional: a check, or a nested block's fields). -> it, or undefined if empty
function checkBlock(block, fields, what) {
  if (block === undefined) return undefined
  if (!isPlainObject(block)) assert(false, `${what} must be an object`)
  for (const key of Object.keys(block)) if (!Object.hasOwn(fields, key)) assert(false, `unknown ${what} key '${key}'`)
  const kept = Object.entries(fields).map(([key, check]) => {
    if (typeof check === 'object') return [key, checkBlock(block[key], check, `${what}.${key}`)]
    if (block[key] !== undefined && !check(block[key])) assert(false, `invalid ${what}.${key}: ${JSON.stringify(block[key])}`)
    return [key, block[key]]
  }).filter(([, value]) => value !== undefined)
  return kept.length === 0 ? undefined : fromEntries(kept)
}

// An older stasis's header `repo: { root: true }` is read as unknown.
function checkBundleRepo(repo) {
  if (isPlainObject(repo) && repo.root === true && !Object.hasOwn(repo, 'directory')) {
    const { root: _root, ...rest } = repo
    repo = rest
  }
  checkBlock(repo, REPO_FIELDS, 'bundle repo')
}

const dependencyEcosystem = (dir, ecosystem) => ecosystem ?? (hasNodeModulesSegment(dir) ? 'npm' : undefined)

// A directory key of `vendored` or `subpackages`: in-bucket, canonical, through no `node_modules`.
const isBucketDir = (dir) => typeof dir === 'string' && dir !== '' && !dir.includes('\\') &&
  dir.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== 'node_modules')

// The directory of `entries` a bucket file `rel` is in: the deepest one listed that holds it.
function entryDirOf(entries, rel) {
  for (let slash = rel.lastIndexOf('/'); slash > 0; slash = rel.lastIndexOf('/', slash - 1)) {
    if (Object.hasOwn(entries, rel.slice(0, slash))) return rel.slice(0, slash)
  }
  return undefined
}

function checkDirMetadata(field, dir, { name, ecosystem, files, entries }) {
  if (entries === undefined) return
  if (dependencyEcosystem(dir, ecosystem) === undefined) assert(false, `bundle: '${dir}' is no dependency's bucket, and carries no ${field}`)
  if (!isPlainObject(entries)) assert(false, `bundle module '${dir}' ${field} must be an object`)
  const checked = fromEntries(Object.entries(entries).map(([sub, block]) => {
    if (!isBucketDir(sub)) assert(false, `bundle module '${dir}' ${field}: invalid directory ${JSON.stringify(sub)}`)
    const entry = checkBlock(block, PACKAGE_BLOCK, `bundle module '${dir}' ${field} '${sub}'`)
    if (entry?.name === undefined) assert(false, `bundle module '${dir}' ${field} '${sub}' has no name`)
    if (field === 'subpackages' && entry.name !== `${name}/${sub}`) {
      assert(false, `bundle module '${dir}' ${field} '${sub}' is named '${entry.name}', not '${name}/${sub}'`)
    }
    return [sub, entry]
  }))
  const carried = new Set(Object.keys(files).map((rel) => entryDirOf(checked, rel)))
  for (const sub of Object.keys(checked)) {
    if (!carried.has(sub)) assert(false, `bundle module '${dir}' ${field} '${sub}' holds none of its files`)
  }
}

// One bucket record. -> its files, null-prototype
function parseModule({ name, ecosystem, repo, vendored, subpackages, files }, dir) {
  assert(ecosystem === undefined || typeof ecosystem === 'string')
  files = fromEntries(Object.entries(files))
  if (repo !== undefined) {
    if (dependencyEcosystem(dir, ecosystem) === undefined) assert(false, `bundle: '${dir}' is no dependency's bucket, and carries no repo`)
    if (checkBlock(repo, REPO_FIELDS, `bundle module '${dir}' repo`)?.github === undefined) assert(false, `bundle module '${dir}' repo has no github`)
  }
  checkDirMetadata('vendored', dir, { name, ecosystem, files, entries: vendored })
  checkDirMetadata('subpackages', dir, { name, ecosystem, files, entries: subpackages })
  return files
}

// Every `executable` entry is a file the bundle carries: not a directory capture, nor a payload-free record.
function parseExecutable(list, { files, formats, scope }) {
  const out = new Set()
  if (list === undefined) return out
  assert(Array.isArray(list), 'bundle: executable must be an array of file paths')
  for (const file of list) {
    assert(typeof file === 'string' && file !== '', 'bundle: executable entry must be a non-empty string')
    assert(!out.has(file), `bundle: executable entry '${file}' is listed twice`)
    out.add(file)
  }
  for (const file of out) {
    const format = formats.get(file)
    const problem = file.includes('\\') ? "holds a '\\'"
      : posixPathEscapes(file) ? 'escapes the root'
      : scope !== 'full' && !hasNodeModulesSegment(file) ? `is outside node_modules, which a '${scope}'-scope bundle does not record`
      : !files.has(file) ? 'names no file the bundle records'
      : format === 'directory' ? 'is a directory capture, not a file'
      : isStatFormat(format) ? `is a payload-free '${format}' record, not a file`
      : null
    assert(problem === null, `bundle: executable entry '${file}' ${problem}`)
  }
  return out
}

// A bundle's JSON text. -> { version, modules: Map<dir, files>, formats: Map<file, format>, executable: Set<file> }
function parseBundle(text) {
  const json = JSON.parse(text)
  assert(json.version === VERSION || json.version === LEGACY_VERSION)
  const scope = json.config?.scope
  assert(['node_modules', 'full'].includes(scope))
  const formats = parseFormats(json.formats)

  const modules = new Map()
  if (json.version === VERSION) {
    if (json.modules !== undefined) {
      assert(typeof json.modules === 'object' && json.modules !== null)
      for (const [dir, info] of Object.entries(json.modules)) {
        assert(hasNodeModulesSegment(dir))
        assertArtifactPath(dir, 'bundle')
        assert(info?.name && info.version && info.files)
        modules.set(dir, parseModule(info, dir))
      }
    }
    if (scope === 'full') {
      assert(json.sources && typeof json.sources === 'object')
      for (const [dir, info] of Object.entries(json.sources)) {
        assert(!hasNodeModulesSegment(dir))
        assertArtifactPath(dir, 'bundle')
        // A workspace bucket may omit version.
        assert(info?.name && info.files)
        modules.set(dir, parseModule(info, dir))
      }
      if (json.entries !== undefined) parseEntries(json.entries)
    } else {
      assert(json.entries === undefined)
      assert(json.sources === undefined)
    }
  } else {
    assert(json.sources)
    for (const [path, content] of Object.entries(json.sources)) {
      assertArtifactPath(path, 'bundle')
      const { dir, rel } = inferModuleDir(path)
      assert(!posixPathEscapes(dir) && !posixPathEscapes(rel))
      if (!modules.has(dir)) modules.set(dir, Object.create(null))
      const files = modules.get(dir)
      assert(!Object.hasOwn(files, rel), `bundle: duplicate file key '.' (v0 '' and '.')`)
      files[rel] = content
    }
  }

  // Flat keys are canonical and unique across buckets, and none is a lockfile or a payload-free record's.
  const flatKeys = new Set()
  for (const [dir, files] of modules) {
    assertArtifactPath(dir, 'bundle')
    for (const rel of Object.keys(files)) {
      const key = canonicalFileKey(dir, rel)
      if (flatKeys.has(key)) {
        assert(false, `duplicate file key '${key}' across bundle buckets -- module bucketing changed between writes ` +
          '(a workspace package without a version now owns its own bucket); regenerate the artifact (bundle=replace)')
      }
      flatKeys.add(key)
    }
  }
  for (const key of flatKeys) assert(!isLockfileName(key), `bundle: ${key} is a stasis lockfile, which no bundle may carry`)
  for (const [file, format] of formats) {
    if (isStatFormat(format) && flatKeys.has(file)) assert(false, `bundle: '${file}' is a payload-free '${format}' record, yet carries content`)
  }
  checkImports(json.imports)
  // A v0 `executable` is ignored: with no per-file `formats` it could point extract at any path to chmod +x.
  const executable = json.version === VERSION ? parseExecutable(json.executable, { files: flatKeys, formats, scope }) : new Set()
  checkBundleRepo(json.repo)
  checkBlock(json.package, PACKAGE_FIELDS, 'bundle package')
  return { version: json.version, modules, formats, executable }
}

// One brotli stream and nothing after it: the engine's bytesWritten counts the input it consumed.
function decompressBundle(bytes) {
  const { buffer, engine } = brotliDecompressSync(bytes, { info: true })
  if (engine.bytesWritten !== bytes.byteLength) {
    throw Object.assign(new TypeError('Trailing junk found after the end of the compressed stream'), { code: 'ERR_TRAILING_JUNK_AFTER_STREAM_END' })
  }
  return buffer.toString('utf8')
}

// --- extract ---

// Whether a path.relative() result climbs out of its base: absolute, or a leading `..` SEGMENT (not a `..foo` name).
const relativeEscapes = (rel) => rel === '..' || rel.startsWith('../') || rel.startsWith(`..${sep}`) || isAbsolute(rel)

// Buffer.from silently drops invalid chars, so a tampered `resource:base64` could spoof its bytes; require a fixed point.
function assertCanonicalBase64(content, file) {
  const buf = Buffer.from(content, 'base64')
  if (buf.toString('base64') !== content) throw new Error(`extract: non-canonical base64 in resource:base64 content for ${file}`)
  return buf
}

// A file's device and inode (as bigints), undefined when there's none.
function fileId(path) {
  const stats = statSync(path, { throwIfNoEntry: false, bigint: true })
  return stats && `${stats.dev}:${stats.ino}`
}

// Whether the bytes for `file` are already at `abs`, so it is left as it is; throws for anything else there. Extract
// never overwrites a file with other bytes, nor the bundle it reads, under its own name or another (a symlink, a hard link).
function alreadyInPlace(abs, file, content, bundleId) {
  const stats = statSync(abs, { throwIfNoEntry: false, bigint: true })
  if (stats === undefined) {
    // A dangling symlink: the write would create its target, wherever that is.
    if (lstatSync(abs, { throwIfNoEntry: false }) !== undefined) throw new Error(`extract: ${file} is a dangling symlink`)
    return false
  }
  if (`${stats.dev}:${stats.ino}` === bundleId) throw new Error(`extract: ${file} is the bundle being extracted`)
  if (!stats.isFile()) throw new Error(`extract: ${file} exists and is not a file`)
  if (!readFileSync(abs).equals(Buffer.from(content))) throw new Error(`extract: ${file} exists with other content, which extract never overwrites`)
  return true
}

function extract({ cwd = process.cwd(), bundleFile, output } = {}) {
  if (!bundleFile) throw new Error('extract: a bundle file is required')
  const bundleAbs = resolve(cwd, bundleFile)
  if (!existsSync(bundleAbs)) throw new Error(`extract: bundle file not found: ${bundleAbs}`)

  let bundle
  try {
    bundle = parseBundle(decompressBundle(readFileSync(bundleAbs)))
  } catch (cause) {
    throw new Error(`extract: not a valid stasis bundle: ${bundleAbs}`, { cause })
  }

  const outDir = resolve(cwd, output ?? '.')
  const outPrefix = outDir === sep ? outDir : `${outDir}${sep}`
  // A bundle named `<name>.stasis.code.br` has its lockfile, `<name>.stasis.lock.json`, beside the plain one.
  const paired = /^(.*)\.stasis\.code\.br$/su.exec(basename(bundleAbs))
  const pairedLockAbs = paired && join(outDir, `${paired[1]}.stasis.lock.json`)
  // A file (or a dangling symlink) there holds no room for the bundle's paths.
  const outStats = statSync(outDir, { throwIfNoEntry: false })
  if (outStats === undefined ? lstatSync(outDir, { throwIfNoEntry: false }) !== undefined : !outStats.isDirectory()) {
    throw new Error(`extract: output dir ${outDir} is not a directory`)
  }
  // lstat, not existsSync: a dangling symlink there is a lockfile too.
  for (const lockAbs of [join(outDir, FILE_LOCK), pairedLockAbs].filter(Boolean)) {
    if (lstatSync(lockAbs, { throwIfNoEntry: false }) !== undefined) {
      throw new Error(`extract: unexpected ${lockAbs}: ${LABEL} has no lockfile support (stasis extract checks the bundle against it, adds the bundle to it, replaces or ignores it)`)
    }
  }

  // Plan-first: every target is validated inside outDir before any write. Containment is lexical -- symlinks are
  // followed, so untrusted bundles need a fresh dir (doc/extract.md).
  const writes = []
  const targets = new Set()
  let executables = 0
  for (const [dir, files] of bundle.modules) {
    for (const [rel, content] of Object.entries(files)) {
      // A `directory` capture is a listing at the dir's own path, not a file to write.
      const key = moduleFileKey(dir, rel)
      if (bundle.formats.get(key) === 'directory') continue
      // The plain join, so a non-`directory` rel === '' fails the canonical-path check instead of writing at the bucket root.
      const file = dir === '.' ? rel : `${dir}/${rel}`
      if (typeof content !== 'string') throw new Error(`extract: bundle file content is not a string: ${file}`)
      const abs = resolve(outDir, file)
      const relToOut = relative(outDir, abs)
      if (relativeEscapes(relToOut) || !abs.startsWith(outPrefix)) throw new Error(`extract: bundle path escapes output dir: ${file}`)
      // A non-canonical path changes under the resolve+relative round-trip.
      if (relToOut !== file) throw new Error(`extract: non-canonical bundle path: ${file}`)
      // Parse refuses a stasis.lock.json; nor may the bundle write the lockfile its own name pairs it with.
      if (abs === pairedLockAbs) throw new Error(`extract: ${file} is the lockfile of ${basename(bundleAbs)}, which ${LABEL} never writes`)
      if (targets.has(abs)) throw new Error(`extract: duplicate bundle path: ${file}`)
      targets.add(abs)
      const exec = bundle.executable.has(key)
      if (exec) executables += 1
      writes.push([abs, bundle.formats.get(key) === 'resource:base64' ? assertCanonicalBase64(content, file) : content, exec, file])
    }
  }
  // A planned file must not also be a parent directory of another, else the writes throw halfway through.
  for (const [abs] of writes) {
    for (let d = dirname(abs); d.length > outDir.length; d = dirname(d)) {
      if (targets.has(d)) throw new Error(`extract: bundle path used as both file and directory: ${relative(outDir, d)}`)
    }
  }

  // What is already on disk, checked whole before the first write too: each directory a write needs must be one (or
  // missing), and each target missing or already holding its bytes.
  const bundleId = fileId(bundleAbs)
  const checkedDirs = new Set()
  const inPlace = new Set()
  for (const [abs, content, , file] of writes) {
    // Top-down, so a stat never runs into a file higher up (ENOTDIR); the first missing one ends the walk.
    const dirs = []
    for (let d = dirname(abs); d.length > outDir.length; d = dirname(d)) dirs.push(d)
    for (const d of dirs.toReversed()) {
      if (checkedDirs.has(d)) continue
      const stats = statSync(d, { throwIfNoEntry: false })
      if (stats === undefined && lstatSync(d, { throwIfNoEntry: false }) === undefined) break
      if (!stats?.isDirectory()) throw new Error(`extract: ${relative(outDir, d) || '.'} is in the way of ${file}: not a directory`)
      checkedDirs.add(d)
    }
    if (alreadyInPlace(abs, file, content, bundleId)) inPlace.add(abs)
  }

  // Only the execute bit is attested, so only it is touched -- rw bits stay as written (never widen a 0600 target)
  // and setuid/setgid/sticky are cleared. Applied to every extracted file, one already in place too; skipped for
  // a legacy v0 bundle, which attests no modes, and on Windows, which reports no POSIX execute bits.
  const withModes = bundle.version === VERSION && process.platform !== 'win32'
  let chmodFailures = 0
  const applyMode = (abs, exec) => {
    let stats
    try {
      stats = lstatSync(abs)
    } catch {
      chmodFailures += 1
      return
    }
    // Never chmod through a symlink: +x on a link's target could make an arbitrary file outside outDir runnable.
    if (stats.isSymbolicLink()) return
    const perms = stats.mode & 0o7777
    const rwx = perms & 0o777
    // Execute wherever readable, with owner-execute as a floor so an aggressive umask can't defeat it.
    const want = exec ? rwx | ((rwx & 0o444) >> 2) | 0o100 : rwx & ~EXECUTE_BITS
    if (want === perms) return
    // Tolerated per file: a mode-less filesystem (vfat/exFAT/CIFS) accepts the write and rejects the chmod.
    try {
      chmodSync(abs, want)
    } catch {
      chmodFailures += 1
    }
  }

  for (const [abs, content, exec] of writes) {
    if (!inPlace.has(abs)) {
      mkdirSync(dirname(abs), { recursive: true })
      // Exclusive: a file that appeared since the check, or a second path a case-insensitive disk folds onto an
      // earlier one, fails the write rather than being overwritten.
      writeFileSync(abs, content, { flag: 'wx' })
    }
    if (withModes) applyMode(abs, exec)
  }
  mkdirSync(outDir, { recursive: true }) // for an empty bundle, where no write created it

  const notes = [executables > 0 && `${executables} executable`, inPlace.size > 0 && `${inPlace.size} already in place`].filter(Boolean)
  console.warn(`[${LABEL}] Extracted ${writes.length} file(s)${notes.length > 0 ? ` (${notes.join(', ')})` : ''} to ${outDir}`)
  if (chmodFailures > 0) {
    console.warn(`[${LABEL}] Warning: could not set file modes on ${chmodFailures} file(s) (the filesystem may not support them); contents were written`)
  }
  return { dir: outDir, files: writes.length, executable: executables, inPlace: inPlace.size }
}

// --- CLI ---

const HELP = `Usage:
 ${LABEL} [--output=path/to/dir] path/to/bundle.stasis.code.br

As \`stasis extract --lock=none\`, with no lockfile support: a stasis.lock.json in the output dir is an error,
and so is <name>.stasis.lock.json when the bundle is <name>.stasis.code.br.
https://github.com/PreventiveMeasures/stasis/blob/main/doc/extract.md`

// A usage error: the message and where the help is, never the help itself.
function fail(message) {
  console.error(`${message}\nRun '${LABEL} --help' for usage.`)
  process.exit(1)
}

function main(argv) {
  const options = {
    output: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  }
  // The leading option tokens, and the value a `--output`/`-o` takes as the next token; the rest are positionals.
  const flags = []
  while (argv.length > 0 && (argv[0].startsWith('-') || ['--output', '-o'].includes(flags.at(-1)))) flags.push(argv.shift())
  let values
  try {
    values = parseArgs({ args: flags, options }).values
  } catch (cause) {
    fail(`Error: ${cause.message}`)
  }
  if (values.help) {
    console.error(HELP)
    process.exit(0)
  }
  if (argv.length === 0) fail('Nothing to extract: no bundle file given')
  if (argv.length > 1) fail('Error: extract takes exactly one bundle file')
  extract({ cwd: process.cwd(), bundleFile: argv[0], output: values.output })
}

main(process.argv.slice(2))
