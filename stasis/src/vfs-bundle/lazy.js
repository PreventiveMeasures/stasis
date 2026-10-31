import { AsyncLocalStorage } from 'node:async_hooks'
import { posix } from 'node:path'

// A lazy tree (@preventive/deptree's `lazy`): laid out from the lockfile alone, each package's
// directory left empty until it is unpacked. The host reads synchronously, so a build reading it
// cannot wait for a tarball: it runs in rounds. A round that reads under a package not yet unpacked
// is void, whatever it built, and those packages are unpacked for the next; the first round that
// reads none read nothing but what the full tree holds there, and is the build. What a round's scan
// reads of a file is kept for the rounds after it where reading it read no such package
// (roundMemo), so each file is scanned once, but those that read what was not unpacked yet.

// The tree's Vfs as tree.js's vfsHost reads it (lstat, readlink, readFile and readdir). A read under
// the directory of a package of `roots` not in `unpacked`, or a listing of that directory itself,
// adds it to `reads.asked`, counts in `reads.touches`, and reads what the layout holds there. The
// directory itself, and those above a package's on the way to it, are as the full tree holds them,
// so reading them asks for nothing.
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

// What one build keeps across the rounds: for each scan it makes, by a label naming its options, what
// it read of each file (Scan's `memo`), kept where reading it touched no package not unpacked yet,
// as the host counts in `reads.touches`, caching nothing such a read reads: what it read then is what
// the full tree holds. `round(reads)` is the round it reads in; `voided()` whether that round has
// asked for a package already, which makes the rest of the build moot.
export function roundMemo() {
  const scans = new Map()
  let reads
  return {
    round(given) {
      reads = given
    },
    scan(label) {
      if (!scans.has(label)) scans.set(label, new Map())
      return { files: scans.get(label), touches: () => reads.touches }
    },
    voided: () => reads.asked.size > 0,
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
// warnings given then; after each round that does, `unpack(reads.asked)`. Each round asks for one
// package at least that no round before did, so there are no more rounds than packages.
export async function inRounds(attempt, unpack) {
  for (;;) {
    const reads = { asked: new Set(), touches: 0 }
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
    await unpack(reads.asked)
  }
}
