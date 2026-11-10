import { AsyncLocalStorage } from 'node:async_hooks'
import { posix } from 'node:path'

// A lazy tree (@preventive/deptree's `lazy`) leaves each package's directory empty until it is unpacked. The host
// reads synchronously, so a build runs in rounds: one that reads under a package not yet unpacked is void, and
// those packages are unpacked for the next; the first round that reads none is the build.

// The tree's Vfs, as vfsHost reads it. A read under a package of `roots` not yet `unpacked` (or a listing of its
// directory) adds it to `reads.asked`, and to `reads.read` unless `reads.probing`, and counts in `reads.touches`;
// a package's own directory and those above it read as the full tree holds them, asking for nothing.
export function lazyView(vfs, { roots, unpacked, reads }) {
  const above = new Set()
  for (const root of roots) {
    for (let dir = posix.dirname(root); dir !== '/' && !above.has(dir); dir = posix.dirname(dir)) above.add(dir)
  }
  const ownerOf = (path) => {
    for (let dir = path; dir !== '/'; dir = posix.dirname(dir)) if (roots.has(dir)) return dir
    return null
  }
  const touch = (path, listing) => {
    const owner = ownerOf(path)
    if (owner === null || unpacked.has(owner)) return
    if (!listing && (path === owner || above.has(path))) return
    reads.asked.add(owner)
    if (reads.probing === 0) reads.read.add(owner)
    reads.touches++
  }
  const read = (method, listing = false) => (path) => {
    touch(path, listing)
    return vfs[method](path)
  }
  return { lstat: read('lstat'), readlink: read('readlink'), readFile: read('readFile'), readdir: read('readdir', true) }
}

// A get-or-read cache, `(key, read) => value`, keeping only what was read without `touches` of what a lazy tree has
// yet to unpack, and nothing without `cache`. With `retouch` (a cache of one round), a touched value is kept too
// and retouches on each hit; with `across` (a Map kept across rounds), an untouched one is kept there.
// untouchedMemo over `host`'s touches (a lazy tree's), retouching as it does.
export const hostMemo = (host, options) => untouchedMemo(host.touches, { retouch: host.retouch, ...options })

export function untouchedMemo(touches = () => 0, { cache = true, retouch, across } = {}) {
  const kept = new Map()
  return (key, read) => {
    if (across?.has(key)) return across.get(key)
    const hit = kept.get(key)
    if (hit !== undefined) {
      if (hit.touched) retouch()
      return hit.value
    }
    const before = touches()
    const value = read()
    const touched = touches() !== before
    if (!cache) return value
    if (!touched && across !== undefined) across.set(key, value)
    else if (!touched || retouch !== undefined) kept.set(key, { value, touched })
    return value
  }
}

// What console.warn gives within a round, held for the round: one that is void says nothing.
const rounds = new AsyncLocalStorage()
let holders = 0
let passed
function warnHeld(...args) {
  const held = rounds.getStore()
  if (held === undefined) passed.apply(console, args)
  else held.push(args)
}
async function holding(held, fn) {
  if (holders++ === 0) {
    passed = console.warn
    console.warn = warnHeld
  }
  try {
    return await rounds.run(held, fn)
  } finally {
    if (--holders === 0 && console.warn === warnHeld) console.warn = passed
  }
}

// `fn()`'s `{ value }` or `{ error }`, with the `warnings` it gave (console.warn's arguments) held
// back, for the caller to say or drop.
export async function warningsHeld(fn) {
  const warnings = []
  try {
    return { value: await holding(warnings, fn), warnings }
  } catch (error) {
    return { error, warnings }
  }
}

// `attempt(reads)`'s result, of the first round whose reads ask for no package, its warnings given then; after each
// round that does, `unpack(reads.asked, reads.read)`. Each round asks for a package no round before did.
export async function inRounds(attempt, unpack) {
  for (;;) {
    const reads = { asked: new Set(), read: new Set(), probing: 0, touches: 0 }
    const held = []
    let result
    let failure
    try {
      // eslint-disable-next-line no-await-in-loop -- each round reads what the one before unpacked
      result = await holding(held, () => attempt(reads))
    } catch (error) {
      failure = { error }
    }
    if (reads.asked.size === 0) {
      for (const args of held) console.warn(...args)
      if (failure !== undefined) throw failure.error
      return result
    }
    // eslint-disable-next-line no-await-in-loop -- what the next round reads
    await unpack(reads.asked, reads.read)
  }
}
