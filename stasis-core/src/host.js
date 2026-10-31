import * as fs from 'node:fs'
import { createRequire, findPackageJSON } from 'node:module'
import { join, matchesGlob, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

// Snapshotted before `stasis run --fs` patches node:fs, whose realpathSync doesn't throw ENOENT and
// whose statSync answers with synthetic modes.
const { globSync, lstatSync, opendirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } = fs

export const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

let lastParent
let lastRequire

export const diskHost = {
  stat(p) {
    try {
      return statSync(p, { throwIfNoEntry: false }) ?? null
    } catch {
      return null
    }
  },
  readFile: (p) => readFileSync(p),
  readdir: (p) => readdirSync(p, { withFileTypes: true }).toSorted(byName),
  // In the filesystem's own order (readdirSync sorts; opendir doesn't).
  readdirUnsorted(p) {
    const entries = []
    const handle = opendirSync(p)
    try {
      for (let e = handle.readSync(); e !== null; e = handle.readSync()) entries.push(e)
    } finally {
      handle.closeSync()
    }
    return entries
  },
  readlink: (p) => (lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null),
  realpath: (p) => realpathSync(p),
  // fs.globSync's matches of `pattern` from `cwd`, as it spells them, never walking into a path
  // `exclude` takes, given its absolute path (Node leaves one out where its `**` meets it alone).
  // With `exclude`, the walk is over Dirents, which know their parent (Node hands its callback a
  // bare name for a file otherwise), each match then spelled from `cwd`.
  glob(pattern, { cwd, exclude } = {}) {
    if (exclude === undefined) return globSync(pattern, { cwd })
    const pathOf = (dirent) => join(dirent.parentPath, dirent.name)
    return globSync(pattern, { cwd, withFileTypes: true, exclude: (dirent) => exclude(pathOf(dirent)) }).map((dirent) => relative(cwd, pathOf(dirent)))
  },
  matchesGlob,
  findPackageJSON: (p) => findPackageJSON(pathToFileURL(p).href),
  resolve(parentFile, specifier, conditions) {
    if (parentFile !== lastParent) {
      lastRequire = createRequire(parentFile)
      lastParent = parentFile
    }
    return lastRequire.resolve(specifier, { conditions })
  },
}
