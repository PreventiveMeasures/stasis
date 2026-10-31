import { AsyncLocalStorage } from 'node:async_hooks'
import { posix } from 'node:path'

// A lazy tree (@preventive/deptree's `lazy`): laid out from the lockfile alone, each package's
// directory left empty until it is unpacked. The host reads synchronously, so a build reading it
// cannot wait for a tarball: it runs in rounds. A round that reads under a package not yet unpacked
// is void, whatever it built, and those packages are unpacked for the next; the first round that
// reads none read nothing but what the full tree holds there, and is the build. What a round's scan
// reads of a file is kept for the rounds after it where reading it read no such package (Scan's
// `memo`), so each file is scanned once, but those that read what was not unpacked yet.

// The tree's Vfs as tree.js's vfsHost reads it (lstat, readlink, readFile and readdir). A read under
// the directory of a package of `roots` not in `unpacked`, or a listing of that directory itself,
// adds it to `reads.asked`, and to `reads.read` but while `reads.probing` (a check of what files the
// package holds, which reads none of its code), counts in `reads.touches`, and reads what the layout
// holds there. The directory itself, and those above a package's on the way to it, are as the full
// tree holds them, so reading them asks for nothing.
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
  return {
    lstat(path) {
      touch(path, false)
      return vfs.lstat(path)
    },
    readlink(path) {
      touch(path, false)
      return vfs.readlink(path)
    },
    readFile(path) {
      touch(path, false)
      return vfs.readFile(path)
    },
    readdir(path) {
      touch(path, true)
      return vfs.readdir(path)
    },
  }
}

// A get-or-read cache, `(key, read) => read()`'s value, as for a tree that holds still: but kept only
// where reading it read nothing a lazy tree does not hold yet (counted by `touches`, a lazy tree's
// host's), which is read again; and kept nowhere without `cache`. With `retouch`, for a cache that
// lives no longer than one round of a lazy tree, in which the tree holds still, what such a reading
// gave is kept too, and each time it is taken it touches again (`retouch()`), as reading it again
// would: what reads it knows it read what the tree does not hold yet, which a round's scan keeps none
// of (Scan's `memo`), and it is not read again only to fail again.
export function untouchedMemo(touches = () => 0, { cache = true, retouch } = {}) {
  const kept = new Map()
  return (key, read) => {
    const hit = kept.get(key)
    if (hit !== undefined) {
      if (hit.touched) retouch()
      return hit.value
    }
    const before = touches()
    const value = read()
    const touched = touches() !== before
    if (cache && (!touched || retouch !== undefined)) kept.set(key, { value, touched })
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

// `attempt(reads)`'s result, of the first round whose reads ask for no package (`reads.asked`), its
// warnings given then; after each round that does, `unpack(reads.asked, reads.read)`, `reads.read`
// those of them it read other than by a probe (lazyView). Each round asks for one package at least
// that no round before did, so there are no more rounds than packages.
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
