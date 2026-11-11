import { AsyncLocalStorage } from 'node:async_hooks'
import { posix } from 'node:path'

// A lazy tree leaves each package's directory empty until it is unpacked. The host reads synchronously, so a build runs
// in rounds: one that reads under a package not yet unpacked is void, and those packages are unpacked for the next.

// A read under a package of `roots` not yet `unpacked` (or a listing of its directory) asks for it, and reads it but
// while probing; its own directory and those above it read as the full tree holds them, asking for nothing.
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

// Keeps only what was read without `touches` of what a lazy tree has yet to unpack. With `retouch` (a cache of one
// round), a touched value is kept too and retouches on each hit; with `across` (kept across rounds), an untouched one.
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

export const hostMemo = (host, options) => untouchedMemo(host.touches, { retouch: host.retouch, ...options })

// Held for the round: one that is void says nothing.
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

export async function warningsHeld(fn) {
  const warnings = []
  try {
    return { value: await holding(warnings, fn), warnings }
  } catch (error) {
    return { error, warnings }
  }
}

export async function inRounds(attempt, unpack) {
  for (;;) {
    const reads = { asked: new Set(), read: new Set(), probing: 0, touches: 0 }
    // eslint-disable-next-line no-await-in-loop -- each round reads what the one before unpacked
    const round = await warningsHeld(() => attempt(reads))
    if (reads.asked.size === 0) {
      for (const args of round.warnings) console.warn(...args)
      if ('error' in round) throw round.error
      return round.value
    }
    // eslint-disable-next-line no-await-in-loop -- what the next round reads
    await unpack(reads.asked, reads.read)
  }
}
