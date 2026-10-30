import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { sha512integrity } from './state-util.js'
import { EXECUTE_BITS, canObserveExecuteBits, moduleFileKey, moduleFileKeys, moduleInfo } from './util.js'

const FILE_LOCK = 'stasis.lock.json'
const LOCK_MODES = new Set(['frozen', 'add', 'replace', 'ignore', 'none'])

// Buffer.from silently drops invalid chars, so a tampered `resource:base64` could hash-spoof; require a fixed point.
function assertCanonicalBase64(content, file) {
  const buf = Buffer.from(content, 'base64')
  if (buf.toString('base64') !== content) {
    throw new Error(`extract: non-canonical base64 in resource:base64 content for ${file}`)
  }
  return buf
}

export function lockfileFromBundle(bundle) {
  const modules = new Map()
  for (const [dir, { files, ...info }] of bundle.modules) {
    const hashed = Object.create(null)
    for (const [rel, content] of Object.entries(files)) {
      // Hash the raw on-disk bytes, so decode 'resource:base64' back first.
      const file = moduleFileKey(dir, rel)
      hashed[rel] = sha512integrity(bundle.formats.get(file) === 'resource:base64' ? assertCanonicalBase64(content, file) : content)
    }
    modules.set(dir, moduleInfo({ ...info, files: hashed }))
  }
  // Carry imports+formats across, else the derived lockfile is bytes-only and a later frozen run skips those cross-checks.
  return new Lockfile({
    config: bundle.config,
    entries: bundle.entries,
    modules,
    imports: bundle.imports,
    formats: bundle.formats,
    // Same file set as the bundle, so its executable list transfers as-is.
    executable: bundle.executable,
  })
}

// Where two parsed JSON values first differ, as a path into them, or null when they are equal.
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

// lock=frozen: the lockfile derived from the bundle must be the one in the output dir, every field of it --
// entries, packages, hashes, imports, formats and execute bits. Compared re-serialized, so formatting is free.
function assertLockfileMatches(lockAbs, derived) {
  const diff = firstDifference(JSON.parse(derived.serialize()), JSON.parse(readLockfile(lockAbs).serialize()))
  if (diff !== null) throw new Error(`extract: --lock=frozen: the bundle does not match ${lockAbs}: ${diff}`)
}

// lock=add: the derived lockfile is merged into the one in the output dir, which must agree with it on all
// both record -- Lockfile.merge refuses any other conflict -- so what is new is recorded and nothing recorded changes.
function addToLockfile(lockAbs, derived) {
  const lock = readLockfile(lockAbs)
  let merged
  try {
    merged = lock.merge(derived)
  } catch (cause) {
    throw new Error(`extract: --lock=add: the bundle conflicts with ${lockAbs}: ${cause.message}`, { cause })
  }
  // merge lets the incoming side's execute bits win, which here would change a recorded one.
  const recorded = moduleFileKeys(lock.modules, { scope: lock.config.scope })
  for (const file of moduleFileKeys(derived.modules, { scope: derived.config.scope })) {
    if (recorded.has(file) && lock.executable.has(file) !== derived.executable.has(file)) {
      throw new Error(`extract: --lock=add: the bundle conflicts with ${lockAbs}: ${file}'s execute bit differs`)
    }
  }
  return merged
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
    bundle = Bundle.parse(brotliDecompressSync(readFileSync(bundleAbs)).toString('utf-8'))
  } catch (cause) {
    // Bundle.parse throws message-less asserts; wrap so the user learns which file failed.
    throw new Error(`extract: not a valid stasis bundle: ${bundleAbs}`, { cause })
  }

  // v0 bundles have null metadata, so no lockfile can be derived (serialize requires name+version).
  const withLockfile = bundle.version === Bundle.VERSION

  const outDir = resolve(cwd, output ?? '.')
  const outPrefix = outDir === sep ? outDir : `${outDir}${sep}`
  const lockAbs = join(outDir, FILE_LOCK)
  // lstat, not existsSync: a dangling symlink there is a lockfile too, so the default fails closed on it.
  const lockPresent = lstatSync(lockAbs, { throwIfNoEntry: false }) !== undefined
  // Unset: assert the lockfile already in the output dir, else write none.
  const lock = lockMode ?? (lockPresent ? 'frozen' : 'none')
  const frozen = lock === 'frozen'
  if (frozen && !lockPresent) throw new Error(`extract: --lock=frozen needs ${lockAbs}`)
  if (lock === 'none' && lockPresent) {
    throw new Error(`extract: unexpected ${lockAbs} with --lock=none (frozen checks the bundle against it, add merges the bundle into it, replace replaces it, ignore leaves it alone)`)
  }
  // ignore neither reads nor writes the lockfile; a v0 bundle derives none, so it has nothing to check against one, add or replace one with.
  if (lockPresent && !withLockfile && lock !== 'ignore') {
    throw new Error(`extract: a legacy v0 bundle can not ${{ frozen: 'be checked against', add: 'be added to', replace: 'replace' }[lock]} ${lockAbs}`)
  }
  const merging = lock === 'add' && lockPresent

  // Plan-first: every target is validated inside outDir before any write; walk modules, not the last-wins
  // `sources` getter. Containment is lexical -- symlinks are followed, so untrusted bundles need a fresh dir (doc/extract.md).
  const writes = []
  const targets = new Set()
  let executables = 0
  for (const [dir, { files }] of bundle.modules) {
    for (const [rel, content] of Object.entries(files)) {
      // A `directory` capture is a listing at the dir's own path, not a file to write (its children recreate the dir).
      const key = moduleFileKey(dir, rel)
      if (bundle.formats.get(key) === 'directory') continue
      // The WRITE path keeps the plain join, so a non-`directory` rel === '' fails the canonical-path
      // check instead of writing at the bucket root.
      const file = dir === '.' ? rel : `${dir}/${rel}`
      if (typeof content !== 'string') throw new Error(`extract: bundle file content is not a string: ${file}`)
      const abs = resolve(outDir, file)
      const relToOut = relative(outDir, abs)
      // The `..` test is `../`-aware, NOT a bare startsWith('..') -- that would reject a legit `..foo` filename.
      if (relToOut === '..' || relToOut.startsWith(`..${sep}`) || isAbsolute(relToOut) || !abs.startsWith(outPrefix)) {
        throw new Error(`extract: bundle path escapes output dir: ${file}`)
      }
      // A non-canonical path changes under the resolve+relative round-trip; writing it desyncs tree from lockfile.
      if (relToOut !== file) throw new Error(`extract: non-canonical bundle path: ${file}`)
      if (targets.has(abs)) throw new Error(`extract: duplicate bundle path: ${file}`)
      if (withLockfile && abs === lockAbs) {
        throw new Error(`extract: bundle contains ${FILE_LOCK}, which would collide with the lockfile`)
      }
      targets.add(abs)
      // Executability rides the plan tuple, so the chmod can only ever reach a file we actually wrote.
      const exec = bundle.executable.has(key)
      if (exec) executables += 1
      writes.push([abs, bundle.formats.get(key) === 'resource:base64' ? assertCanonicalBase64(content, file) : content, exec])
    }
  }
  // A planned file must not also be a parent directory of another, else the writes throw halfway through.
  for (const [abs] of writes) {
    for (let d = dirname(abs); d.length > outDir.length; d = dirname(d)) {
      if (targets.has(d)) {
        throw new Error(`extract: bundle path used as both file and directory: ${relative(outDir, d)}`)
      }
    }
  }
  // Only add and replace write a lockfile, and frozen checks one; each before the first write.
  const writesLock = lock === 'add' || lock === 'replace'
  const derived = withLockfile && (frozen || writesLock) ? lockfileFromBundle(bundle) : null
  if (frozen) assertLockfileMatches(lockAbs, derived)
  const lockText = derived === null || frozen ? null : (merging ? addToLockfile(lockAbs, derived) : derived).serialize()

  // Only the execute bit is attested, so only it is touched -- rw bits stay as written (never widen a 0600 target)
  // and setuid/setgid/sticky are cleared. Applied to every written file; skipped for v0, which attests no modes.
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

  for (const [abs, content, exec] of writes) {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    if (withModes) applyMode(abs, exec)
  }
  mkdirSync(outDir, { recursive: true }) // for an empty bundle, where no write created it
  if (lockText !== null) writeFileSync(lockAbs, lockText)

  const execNote = executables > 0 ? ` (${executables} executable)` : ''
  const andLock = lockText !== null && !merging ? ` and ${FILE_LOCK}` : ''
  const lockNote = frozen ? `, verified against ${FILE_LOCK}` : merging ? `, added to ${FILE_LOCK}` : ''
  console.warn(`[${logLabel}] Extracted ${writes.length} file(s)${execNote}${andLock} to ${outDir}${lockNote}`)
  if (chmodFailures > 0) {
    console.warn(`[${logLabel}] Warning: could not set file modes on ${chmodFailures} file(s) (the filesystem may not support them); contents were written`)
  }
  if (!withLockfile && writesLock) {
    console.warn(`[${logLabel}] Warning: legacy v0 bundle records no package name/version, so ${FILE_LOCK} can not be restored and was not written`)
  }
  return { dir: outDir, files: writes.length, executable: executables, lock }
}
