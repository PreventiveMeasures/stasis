import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import * as fs from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { diskHost } from './host.js'
import { isPathWithin } from './util.js'

// Genuine fs readers snapshotted off the namespace before any --fs patch. A plain `import { readFileSync }`
// won't do: --fs monkey-patches fs then syncBuiltinESMExports() rebinds named imports, so snapshotting dodges that.
export const realReadFileSync = fs.readFileSync
export const realReadFile = fs.promises.readFile
export const realReaddirSync = fs.readdirSync
export const realExistsSync = fs.existsSync
const realRealpathSync = fs.realpathSync

let realRootCache
// Capture-side containment: the REAL location of `abs` must stay inside `root`'s real path (`root`
// itself where that has none), else an in-tree symlink pointing OUT would pull external content in.
export function realContained(root, abs) {
  if (realRootCache?.root !== root) {
    let real
    try { real = realRealpathSync(root) } catch { real = root }
    realRootCache = { root, real }
  }
  let real
  try { real = realRealpathSync(abs) } catch { return false }
  return isPathWithin(realRootCache.real, real)
}

assert.equal(sep, '/', 'Not tested on Windows')

export const sha512integrity = (x) => `sha512-${hash('sha512', x, 'base64')}`

export function readFileSyncMaybe(dir, file, encoding, host = diskHost) {
  let buf
  try {
    buf = host.readFile(join(dir, file))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  return encoding === undefined ? buf : buf.toString(encoding)
}

export function noupsert(map, key, value) {
  if (map.has(key)) {
    assert.deepStrictEqual(map.get(key), value, `Conflict for ${JSON.stringify(key)}`)
  } else {
    map.set(key, value)
  }
}

// Canonicalize for write-target collision detection: the host's realpath catches symlink aliases resolve() would miss; lexical fallback for not-yet-written targets.
export function canonicalizePath(p, host = diskHost) {
  const abs = resolve(p)
  try {
    return host.realpath(abs)
  } catch {
    return abs
  }
}

// Whether `url` is in `state`'s scope, as it attests one: anywhere under scope=full, else in
// node_modules. Over State's public members alone, so a plugin may ask it of a State another
// stasis-core copy made (State.preload).
export const inScope = (state, url) => state.config.full || state.inNodeModules(url)

// Whether the file at `absolute` is one `state`'s bundle serves under load: within its root (outside
// it: system files, scratch, read from disk) and in its scope. Over State's public members, as inScope.
export const servedByBundle = (state, absolute) => isPathWithin(state.root, absolute) && inScope(state, pathToFileURL(absolute).toString())
