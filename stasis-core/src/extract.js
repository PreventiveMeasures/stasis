import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { parseBundleBytes } from './brotli.js'
import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { sha512integrity } from './state-util.js'
import { EXECUTE_BITS, canObserveExecuteBits, LOCK_FILE, LOCK_MODES, moduleFileKey, relativeEscapes } from './util.js'

// Buffer.from silently drops invalid chars, so a tampered `resource:base64` could hash-spoof; require a fixed point.
function assertCanonicalBase64(content, file) {
  const buf = Buffer.from(content, 'base64')
  if (buf.toString('base64') !== content) throw new Error(`extract: non-canonical base64 in resource:base64 content for ${file}`)
  return buf
}

export const lockfileFromBundle = (bundle) => Lockfile.fromBundle(bundle, (file, content) =>
  sha512integrity(bundle.formats.get(file) === 'resource:base64' ? assertCanonicalBase64(content, file) : content))

function firstDifference(bundle, lock, path = '') {
  if (bundle === lock) return null
  const nested = (x) => typeof x === 'object' && x !== null
  if (!nested(bundle) || !nested(lock) || Array.isArray(bundle) !== Array.isArray(lock)) {
    return `${path} ${bundle === undefined ? 'is only in the lockfile' : lock === undefined ? 'is only in the bundle' : 'differs'}`
  }
  // Own keys only: JSON.parse makes a `__proto__` file name an own property, never the prototype.
  const own = (x, key) => (Object.hasOwn(x, key) ? x[key] : undefined)
  for (const key of new Set([...Object.keys(bundle), ...Object.keys(lock)])) {
    const diff = firstDifference(own(bundle, key), own(lock, key), `${path}[${Array.isArray(bundle) ? key : JSON.stringify(key)}]`)
    if (diff) return diff
  }
  return null
}

function readLockfile(lockAbs) {
  try {
    return Lockfile.parse(readFileSync(lockAbs, 'utf-8'))
  } catch (cause) {
    throw new Error(`extract: not a valid stasis lockfile: ${lockAbs}`, { cause })
  }
}

// Nothing recorded changes, execute bits too, but a payload-free stat:* record, which content of its kind upgrades.
function addToLockfile(lockAbs, derived) {
  const lock = readLockfile(lockAbs)
  try {
    return lock.mergeAgreeing(derived)
  } catch (cause) {
    throw new Error(`extract: --lock=add: the bundle conflicts with ${lockAbs}: ${cause.message}`, { cause })
  }
}

// As bigints: a number can round a large Windows file id.
function fileId(path) {
  const stats = statSync(path, { throwIfNoEntry: false, bigint: true })
  return stats && `${stats.dev}:${stats.ino}`
}

function dirsBelow(outDir, abs) {
  const dirs = []
  for (let d = dirname(abs); d.length > outDir.length; d = dirname(d)) dirs.push(d)
  return dirs
}

// Extract never overwrites a file with other bytes, nor the bundle it reads, under any name (symlink, hard link).
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

export function extractCommand({ cwd = process.cwd(), bundleFile, output, lock: lockMode, logLabel = 'stasis-core' } = {}) {
  if (!bundleFile) throw new Error('extract: a bundle file is required')
  if (lockMode !== undefined && !LOCK_MODES.has(lockMode)) {
    throw new Error(`extract: lock must be one of ${[...LOCK_MODES].join(', ')} (got ${JSON.stringify(lockMode)})`)
  }
  const bundleAbs = resolve(cwd, bundleFile)
  if (!existsSync(bundleAbs)) throw new Error(`extract: bundle file not found: ${bundleAbs}`)

  let bundle
  try {
    bundle = parseBundleBytes(readFileSync(bundleAbs))
  } catch (cause) {
    // Bundle.parse throws message-less asserts; wrap so the user learns which file failed.
    throw new Error(`extract: not a valid stasis bundle: ${bundleAbs}`, { cause })
  }

  // v0 bundles have null metadata, so no lockfile can be derived (serialize requires name+version).
  const withLockfile = bundle.version === Bundle.VERSION

  const outDir = resolve(cwd, output ?? '.')
  const outPrefix = outDir === sep ? outDir : `${outDir}${sep}`
  const lockAbs = join(outDir, LOCK_FILE)
  // A file (or a dangling symlink) there holds neither a lockfile nor room for the bundle's paths.
  const outStats = statSync(outDir, { throwIfNoEntry: false })
  if (outStats === undefined ? lstatSync(outDir, { throwIfNoEntry: false }) !== undefined : !outStats.isDirectory()) {
    throw new Error(`extract: output dir ${outDir} is not a directory`)
  }
  // lstat, not existsSync: a dangling symlink there is a lockfile too, so the default fails closed on it.
  const lockPresent = lstatSync(lockAbs, { throwIfNoEntry: false }) !== undefined
  const lock = lockMode ?? (lockPresent ? 'frozen' : 'none')
  const frozen = lock === 'frozen'
  if (frozen && !lockPresent) throw new Error(`extract: --lock=frozen needs ${lockAbs}`)
  if (lock === 'none' && lockPresent) {
    throw new Error(`extract: unexpected ${lockAbs} with --lock=none (frozen checks the bundle against it, add merges the bundle into it, replace replaces it, ignore leaves it alone)`)
  }
  if (lockPresent && !withLockfile && lock !== 'ignore') {
    throw new Error(`extract: a legacy v0 bundle can not ${{ frozen: 'be checked against', add: 'be added to', replace: 'replace' }[lock]} ${lockAbs}`)
  }
  const merging = lock === 'add' && lockPresent

  // Plan-first; walk modules, not the last-wins `sources` getter. Containment is lexical -- symlinks are
  // followed, so untrusted bundles need a fresh dir (doc/extract.md).
  const writes = []
  const targets = new Set()
  for (const [dir, { files }] of bundle.modules) {
    for (const [rel, content] of Object.entries(files)) {
      // A listing at the dir's own path, not a file to write (its children recreate the dir).
      const key = moduleFileKey(dir, rel)
      if (bundle.formats.get(key) === 'directory') continue
      // The plain join, so a non-`directory` rel === '' fails the canonical-path check, not writes at the bucket root.
      const file = dir === '.' ? rel : `${dir}/${rel}`
      if (typeof content !== 'string') throw new Error(`extract: bundle file content is not a string: ${file}`)
      const abs = resolve(outDir, file)
      const relToOut = relative(outDir, abs)
      if (relativeEscapes(relToOut) || !abs.startsWith(outPrefix)) throw new Error(`extract: bundle path escapes output dir: ${file}`)
      // A non-canonical path changes under the resolve+relative round-trip; writing it desyncs tree from lockfile.
      if (relToOut !== file) throw new Error(`extract: non-canonical bundle path: ${file}`)
      // No bundle Bundle.parse takes carries a stasis.lock.json, so no write lands on the lockfile.
      if (targets.has(abs)) throw new Error(`extract: duplicate bundle path: ${file}`)
      targets.add(abs)
      // Executability rides the plan, so the chmod can only ever reach a file we actually wrote.
      const exec = bundle.executable.has(key)
      writes.push({ abs, content: bundle.formats.get(key) === 'resource:base64' ? assertCanonicalBase64(content, file) : content, exec, file })
    }
  }
  // A file planned as another's parent directory would make the writes throw halfway through.
  for (const { abs } of writes) {
    const clash = dirsBelow(outDir, abs).find((d) => targets.has(d))
    if (clash !== undefined) throw new Error(`extract: bundle path used as both file and directory: ${relative(outDir, clash)}`)
  }
  const writesLock = lock === 'add' || lock === 'replace'
  const derived = withLockfile && (frozen || writesLock) ? lockfileFromBundle(bundle) : null
  // Every field of the lockfile must match, compared re-serialized, so formatting is free.
  const diff = frozen ? firstDifference(JSON.parse(derived.serialize()), JSON.parse(readLockfile(lockAbs).serialize())) : null
  if (diff !== null) throw new Error(`extract: --lock=frozen: the bundle does not match ${lockAbs}: ${diff}`)
  const lockText = derived === null || frozen ? null : (merging ? addToLockfile(lockAbs, derived) : derived).serialize()

  // What is already on disk is checked whole before the first write too; nor may the lockfile's land on the bundle.
  const bundleId = fileId(bundleAbs)
  if (lockText !== null && fileId(lockAbs) === bundleId) throw new Error(`extract: ${LOCK_FILE} is the bundle being extracted`)
  const checkedDirs = new Set()
  const inPlace = new Set()
  for (const { abs, content, file } of writes) {
    // Top-down, so a stat never runs into a file higher up (ENOTDIR).
    for (const d of dirsBelow(outDir, abs).toReversed()) {
      if (checkedDirs.has(d)) continue
      const stats = statSync(d, { throwIfNoEntry: false })
      if (stats === undefined && lstatSync(d, { throwIfNoEntry: false }) === undefined) break
      if (!stats?.isDirectory()) throw new Error(`extract: ${relative(outDir, d) || '.'} is in the way of ${file}: not a directory`)
      checkedDirs.add(d)
    }
    if (alreadyInPlace(abs, file, content, bundleId)) inPlace.add(abs)
  }

  // Only the execute bit is attested, so only it is touched -- rw bits stay as written (never widen a 0600
  // target) and setuid/setgid/sticky are cleared. v0 attests no modes.
  const withModes = withLockfile && canObserveExecuteBits()
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

  for (const { abs, content, exec } of writes) {
    if (!inPlace.has(abs)) {
      mkdirSync(dirname(abs), { recursive: true })
      // Exclusive: a file that appeared since the check, or one a case-insensitive disk folds onto another, fails.
      writeFileSync(abs, content, { flag: 'wx' })
    }
    if (withModes) applyMode(abs, exec)
  }
  mkdirSync(outDir, { recursive: true }) // for an empty bundle, where no write created it
  if (lockText !== null) writeFileSync(lockAbs, lockText)

  const executables = writes.filter(({ exec }) => exec).length
  const notes = [executables > 0 && `${executables} executable`, inPlace.size > 0 && `${inPlace.size} already in place`].filter(Boolean)
  const execNote = notes.length > 0 ? ` (${notes.join(', ')})` : ''
  const andLock = lockText !== null && !merging ? ` and ${LOCK_FILE}` : ''
  const lockNote = frozen ? `, verified against ${LOCK_FILE}` : merging ? `, added to ${LOCK_FILE}` : ''
  console.warn(`[${logLabel}] Extracted ${writes.length} file(s)${execNote}${andLock} to ${outDir}${lockNote}`)
  if (chmodFailures > 0) {
    console.warn(`[${logLabel}] Warning: could not set file modes on ${chmodFailures} file(s) (the filesystem may not support them); contents were written`)
  }
  if (!withLockfile && writesLock) {
    console.warn(`[${logLabel}] Warning: legacy v0 bundle records no package name/version, so ${LOCK_FILE} can not be restored and was not written`)
  }
  return { dir: outDir, files: writes.length, executable: executables, inPlace: inPlace.size, lock }
}
