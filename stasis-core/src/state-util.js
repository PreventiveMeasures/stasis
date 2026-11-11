import assert from 'node:assert/strict'
import { hash } from 'node:crypto'
import * as fs from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { diskHost } from './host.js'
import { isPathWithin } from './util.js'

// Genuine fs readers snapshotted off the namespace before any --fs patch. A plain `import { readFileSync }`
// won't do: --fs patches fs, then syncBuiltinESMExports() rebinds named imports to the patched fns.
export const realReadFileSync = fs.readFileSync
export const realReadFile = fs.promises.readFile
const realRealpathSync = fs.realpathSync
const realpathOr = (path, fallback) => { try { return realRealpathSync(path) } catch { return fallback } }

let realRootCache
// Capture-side containment: an in-tree symlink pointing OUT of `root`'s real path would pull external content in.
export function realContained(root, abs) {
  if (realRootCache?.root !== root) realRootCache = { root, real: realpathOr(root, root) }
  const real = realpathOr(abs, null)
  return real !== null && isPathWithin(realRootCache.real, real)
}

assert.equal(sep, '/', 'Not tested on Windows')

export const sha512integrity = (x) => `sha512-${hash('sha512', x, 'base64')}`

export const bundledIntegrity = (content, format) => sha512integrity(format === 'resource:base64' ? Buffer.from(content, 'base64') : content)

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
  if (!map.has(key)) map.set(key, value)
  else if (!Object.is(map.get(key), value)) assert.deepStrictEqual(map.get(key), value, `Conflict for ${JSON.stringify(key)}`)
}

// The host's realpath catches symlink aliases resolve() would miss; lexical fallback for not-yet-written targets.
export function canonicalizePath(p, host = diskHost) {
  const abs = resolve(p)
  try {
    return host.realpath(abs)
  } catch {
    return abs
  }
}

// Over State's public members alone, so a plugin may ask it of a State another stasis-core copy made (State.preload).
export const inScope = (state, url) => state.config.full || state.inNodeModules(url)

// Outside its root (system files, scratch) a file is read from disk. Over State's public members, as inScope.
export const servedByBundle = (state, absolute) => isPathWithin(state.root, absolute) && inScope(state, pathToFileURL(absolute).toString())
