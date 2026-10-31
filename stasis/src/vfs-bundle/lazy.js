import { AsyncLocalStorage } from 'node:async_hooks'
import { posix } from 'node:path'

// A lazy tree (@preventive/deptree's `lazy`): laid out from the lockfile alone, each package's
// directory left empty until it is unpacked. The host reads synchronously, so a build reading it
// cannot wait for a tarball: it runs in rounds. A round that reads under a package not yet unpacked
// is void, whatever it built, and those packages are unpacked for the next; the first round that
// reads none read nothing but what the full tree holds there, and is the build.

// The tree's Vfs as tree.js's vfsHost reads it (lstat, readlink, readFile and readdir). A read under
// the directory of a package of `roots` not in `unpacked`, or a listing of that directory itself,
// adds it to `asked`, and reads what the layout holds there. The directory itself, and those above
// a package's on the way to it, are as the full tree holds them, so reading them asks for nothing.
export function lazyView(vfs, { roots, unpacked, asked }) {
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
    asked.add(owner)
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

// `attempt(asked)`'s result, of the first round whose reads add nothing to `asked`, its warnings
// given then; after each round that does, `unpack(asked)`. Each round asks for one package at least
// that no round before did, so there are no more rounds than packages.
export async function inRounds(attempt, unpack) {
  for (;;) {
    const asked = new Set()
    const held = []
    let result
    let failure
    try {
      // eslint-disable-next-line no-await-in-loop -- each round reads what the one before unpacked
      result = await holding(held, () => attempt(asked))
    } catch (error) {
      failure = { error }
    }
    if (asked.size === 0) {
      for (const args of held) console.warn(...args)
      if (failure !== undefined) throw failure.error
      return result
    }
    // eslint-disable-next-line no-await-in-loop -- what the next round reads
    await unpack(asked)
  }
}
