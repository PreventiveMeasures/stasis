// `stasis run --fs`: capture a program's fs reads into the bundle, or serve them from it (bundle=load).
// SECURITY INVARIANT: a path whose REAL path leaves the project root falls through to the real fs, never attested.

import { createRequire, syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { realContained, realReadFileSync } from './state-util.js'
import { isDotEnvFile, isPathWithin, isStasisArtifactName } from './util.js'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

// The hooks call these real fns, so there's no recursion and capture sees real bytes. Callback fs.exists is
// NOT patched (wrapping would clobber its util.promisify.custom); it answers via the patched fs.access.
const {
  readdirSync: realReaddirSync, lstatSync: realLstatSync, statSync: realStatSync, realpathSync: realRealpathSync,
  existsSync: realExistsSync, accessSync: realAccessSync,
  readFile: realReadFile, readdir: realReaddir, lstat: realLstat, stat: realStat, access: realAccess, realpath: realRealpath,
} = fs
const { readFile: realReadFileP, readdir: realReaddirP, lstat: realLstatP, stat: realStatP, access: realAccessP, realpath: realRealpathP } = fs.promises
const realRealpathSyncNative = realRealpathSync.native
const realRealpathNative = realRealpath.native

// The bundle serves read-only: an allowlist, so a W_OK/X_OK or out-of-range mode defers to the real fs.
const READ_ACCESS = fs.constants.F_OK | fs.constants.R_OK
const isReadOnlyAccessMode = (mode) => ((mode | 0) & ~READ_ACCESS) === 0

function toAbsPath(path) {
  if (typeof path === 'string') return resolve(path)
  if (Buffer.isBuffer(path)) return resolve(path.toString())
  if (path instanceof URL) return path.protocol === 'file:' ? fileURLToPath(path) : null
  return null
}

const encodingOf = (options) => (typeof options === 'string' ? options : options?.encoding)

// Buffer.toString throws fs's ERR_UNKNOWN_ENCODING.
function decode(buf, options) {
  const encoding = encodingOf(options)
  return encoding == null ? buf : buf.toString(encoding)
}

// The synthetic realpath of a bundle-served path gone from disk.
const encodeRealpath = (abs, options) => (encodingOf(options) === 'buffer' ? Buffer.from(abs) : abs)

// Absent under --fs: `*.map` (a captured build replays byte-identically; `map` in resources opts out) and
// `.env*` (a capture never bakes in a secret). Either serves at load only as an explicit bundle member.
function isSkippedFsPath(state, abs) {
  const skipped = (abs.toLowerCase().endsWith('.map') && !state.config.resources?.has('map')) || isDotEnvFile(abs)
  return skipped && !(state.config.loadBundle && state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined)
}

// Indistinguishable from a real absent file's. String() spells a Buffer path as UTF-8 and a URL as its href.
function enoent(syscall, path) {
  const p = String(path)
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), { code: 'ENOENT', errno: -2, syscall, path: p })
}

// An absent path's stat answers as the real fn does for '' (never exists), re-spelled: which options it honours
// varies by Node version (async stat takes throwIfNoEntry from 24.15, async lstat doesn't).
const asAbsent = (syscall, path) => (err) => (err?.code === 'ENOENT' ? enoent(syscall, path) : err)

// For a bundle-served path gone from disk; never throws, so wrappers reading uid/gid etc. keep working.
function syntheticStat(isDir) {
  const epoch = new Date(0)
  return {
    // S_IFDIR / S_IFREG: code reading stats.mode, not is*(), still tells file from dir.
    dev: 0, ino: 0, mode: isDir ? 0o040000 : 0o100000, nlink: 1, uid: 0, gid: 0,
    rdev: 0, size: 0, blksize: 4096, blocks: 0,
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
    atime: epoch, mtime: epoch, ctime: epoch, birthtime: epoch,
    isSymbolicLink: () => false, isBlockDevice: () => false,
    isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
  }
}

// The rest from the real stat while on disk; `then` short-circuited: never an accidental thenable under `await`.
function bundleStats(realStatFn, statPath, isDir) {
  let data
  const overrides = { isFile: () => !isDir, isDirectory: () => isDir }
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop === 'isFile' || prop === 'isDirectory') return target[prop]
      if (prop === 'then') return undefined
      if (data === undefined) {
        try { data = realStatFn(statPath) } catch { data = syntheticStat(isDir) }
      }
      const value = data[prop]
      return typeof value === 'function' ? value.bind(data) : value
    },
  })
}

let installed = false

export function installFsHooks({ async: patchAsync, getState, markAborted, isLoadingModule }) {
  if (installed) return
  installed = true

  // Node's glob takes fs's readers when first loaded: load it on the real ones, so the `extra` sweep isn't captured.
  fs.globSync([])

  // null passes through to the real fs; 'serve' still falls through to disk for an uncaptured path.
  const classify = (path) => {
    const state = getState()
    if (!state) return null
    const abs = toAbsPath(path)
    if (abs === null || !isPathWithin(state.root, abs)) return null
    if (isSkippedFsPath(state, abs)) return { mode: 'absent' }
    const url = pathToFileURL(abs).toString()
    if (state.config.loadBundle) return { mode: 'serve', state, url, abs }
    if (state.config.writeBundle && !isLoadingModule()) return { mode: 'capture', state, url, abs }
    return null
  }
  const served = (t) => t?.mode === 'serve' && t.state.getFsStatFamily(t.url) !== undefined

  // A rejected capture taints the run rather than failing the read.
  const record = (fn) => { try { fn() } catch (err) { markAborted(err) } }
  // An in-tree symlink out of root is read but NOT recorded, nor is a read a bundler-plugin sidecar attests.
  const captureFile = ({ state, abs, url }, buf) => {
    if (realContained(state.root, abs) && !state.attestedBySidecar(url)) record(() => state.addFsFile(url, buf))
  }
  const captureDir = ({ state, abs, url }, names) => {
    if (!realContained(state.root, abs)) return
    // At the root, the RECORDED listing leaves out stasis's own artifacts, so an earlier run's don't matter.
    record(() => state.addFsDir(url, isPathWithin(abs, state.root) ? names.filter((name) => !isStasisArtifactName(name)) : names))
  }
  const captureStat = ({ state, abs, url }, stats) => {
    const isDir = stats.isDirectory()
    if (!isDir && !stats.isFile()) return
    if (realContained(state.root, abs) && !state.attestedBySidecar(url)) record(() => state.addFsStat(url, isDir ? 'directory' : 'file'))
  }

  fs.readFileSync = function readFileSync(path, options) {
    const t = classify(path)
    if (t?.mode === 'absent') throw enoent('open', path)
    if (t?.mode === 'serve') {
      const buf = t.state.getFsFileFamily(t.url)
      if (buf !== undefined) return decode(buf, options)
    } else if (t?.mode === 'capture') {
      const buf = realReadFileSync(path)
      captureFile(t, buf)
      return decode(buf, options)
    }
    return realReadFileSync(path, options)
  }

  fs.readdirSync = function readdirSync(path, options) {
    const t = classify(path)
    if (t?.mode === 'absent') throw enoent('scandir', path)
    if (options == null && t?.mode === 'serve') {
      const names = t.state.getFsDirFamily(t.url)
      if (names !== undefined) return names // sorted at capture time
    } else if (options == null && t?.mode === 'capture') {
      const names = realReaddirSync(path)
      captureDir(t, names)
      return names
    }
    return realReaddirSync(path, options)
  }

  // statSync follows symlinks: an in-root symlink records the TARGET's kind.
  const servedStatSync = (syscall, realFn) => ({
    [`${syscall}Sync`](path, options) {
      const t = classify(path)
      if (t?.mode === 'absent') {
        try { return realFn('', options) } catch (err) { throw asAbsent(syscall, path)(err) }
      }
      if (options == null && t?.mode === 'serve') {
        const kind = t.state.getFsStatFamily(t.url)
        if (kind !== undefined) return bundleStats(realFn, path, kind === 'directory')
      } else if (options == null && t?.mode === 'capture') {
        const stats = realFn(path)
        captureStat(t, stats)
        return stats
      }
      return realFn(path, options)
    },
  })[`${syscall}Sync`]
  fs.lstatSync = servedStatSync('lstat', realLstatSync)
  fs.statSync = servedStatSync('stat', realStatSync)

  // The probes are served (a tool may probe before reading bytes, as @babel/core does) but never captured.
  fs.existsSync = function existsSync(path) {
    const t = classify(path)
    if (t?.mode === 'absent') return false
    return served(t) || realExistsSync(path)
  }

  fs.accessSync = function accessSync(path, mode) {
    const t = classify(path)
    if (t?.mode === 'absent') throw enoent('access', path)
    if (isReadOnlyAccessMode(mode) && served(t)) return undefined
    return realAccessSync(path, mode)
  }

  // The real realpath while on disk, else the lexical abs (ancestor symlinks not re-resolved then).
  const servedRealpathSync = (realFn) => function realpathSync(path, options) {
    const t = classify(path)
    if (t?.mode === 'absent') throw enoent('realpath', path)
    if (!served(t)) return realFn(path, options)
    try { return realFn(path, options) } catch { return encodeRealpath(t.abs, options) }
  }
  fs.realpathSync = servedRealpathSync(realRealpathSync)
  fs.realpathSync.native = servedRealpathSync(realRealpathSyncNative)

  // A served callback is deferred, keeping fs's always-async contract.
  if (patchAsync) {
    const cbArgs = (options, callback) => (typeof options === 'function' ? [undefined, options] : [options, callback])
    const later = (cb, ...args) => queueMicrotask(() => cb(...args))
    // A decode error goes to the callback, as fs.readFile's does: a throw here would be uncaught.
    const decodeToCb = (cb, buf, options) => {
      let out
      try { out = decode(buf, options) } catch (err) { cb(err); return }
      cb(null, out)
    }

    fs.readFile = function readFile(path, options, callback) {
      const [opts, cb] = cbArgs(options, callback)
      const t = typeof cb === 'function' ? classify(path) : null
      if (t?.mode === 'absent') return later(cb, enoent('open', path))
      if (t?.mode === 'serve') {
        const buf = t.state.getFsFileFamily(t.url)
        if (buf !== undefined) return later(decodeToCb, cb, buf, opts)
      } else if (t?.mode === 'capture') {
        return realReadFile(path, (err, buf) => {
          if (err) return cb(err)
          captureFile(t, buf)
          decodeToCb(cb, buf, opts)
        })
      }
      return realReadFile(path, options, callback)
    }

    fs.promises.readFile = async function readFile(path, options) {
      const t = classify(path)
      if (t?.mode === 'absent') throw enoent('open', path)
      if (t?.mode === 'serve') {
        const buf = t.state.getFsFileFamily(t.url)
        if (buf !== undefined) return decode(buf, options)
      } else if (t?.mode === 'capture') {
        const buf = await realReadFileP(path)
        captureFile(t, buf)
        return decode(buf, options)
      }
      return realReadFileP(path, options)
    }

    fs.readdir = function readdir(path, options, callback) {
      const [opts, cb] = cbArgs(options, callback)
      const t = typeof cb === 'function' ? classify(path) : null
      if (t?.mode === 'absent') return later(cb, enoent('scandir', path))
      // A null options counts as none: graceful-fs normalises to that, else its reads never hit the bundle.
      if (opts == null && t?.mode === 'serve') {
        const names = t.state.getFsDirFamily(t.url)
        if (names !== undefined) return later(cb, null, names)
      } else if (opts == null && t?.mode === 'capture') {
        return realReaddir(path, (err, names) => {
          if (err) return cb(err)
          captureDir(t, names)
          cb(null, names)
        })
      }
      return realReaddir(path, options, callback)
    }

    fs.promises.readdir = async function readdir(path, options) {
      const t = classify(path)
      if (t?.mode === 'absent') throw enoent('scandir', path)
      if (options == null && t?.mode === 'serve') {
        const names = t.state.getFsDirFamily(t.url)
        if (names !== undefined) return names
      } else if (options == null && t?.mode === 'capture') {
        const names = await realReaddirP(path)
        captureDir(t, names)
        return names
      }
      return realReaddirP(path, options)
    }

    // bundleStats's field fallback stays sync.
    const servedStat = (syscall, realFn, realSyncFn) => ({
      [syscall](path, options, callback) {
        const [opts, cb] = cbArgs(options, callback)
        const t = typeof cb === 'function' ? classify(path) : null
        if (t?.mode === 'absent') return realFn('', opts, (err, stats) => cb(asAbsent(syscall, path)(err), stats))
        if (opts == null && t?.mode === 'serve') {
          const kind = t.state.getFsStatFamily(t.url)
          if (kind !== undefined) return later(cb, null, bundleStats(realSyncFn, path, kind === 'directory'))
        } else if (opts == null && t?.mode === 'capture') {
          return realFn(path, (err, stats) => {
            if (err) return cb(err)
            captureStat(t, stats)
            cb(null, stats)
          })
        }
        return realFn(path, options, callback)
      },
    })[syscall]
    fs.lstat = servedStat('lstat', realLstat, realLstatSync)
    fs.stat = servedStat('stat', realStat, realStatSync)

    const servedStatP = (syscall, realFn, realSyncFn) => ({
      async [syscall](path, options) {
        const t = classify(path)
        if (t?.mode === 'absent') return realFn('', options).catch((err) => { throw asAbsent(syscall, path)(err) })
        if (options == null && t?.mode === 'serve') {
          const kind = t.state.getFsStatFamily(t.url)
          if (kind !== undefined) return bundleStats(realSyncFn, path, kind === 'directory')
        } else if (options == null && t?.mode === 'capture') {
          const stats = await realFn(path)
          captureStat(t, stats)
          return stats
        }
        return realFn(path, options)
      },
    })[syscall]
    fs.promises.lstat = servedStatP('lstat', realLstatP, realLstatSync)
    fs.promises.stat = servedStatP('stat', realStatP, realStatSync)

    fs.access = function access(path, mode, callback) {
      const [accessMode, cb] = cbArgs(mode, callback)
      const t = typeof cb === 'function' ? classify(path) : null
      if (t?.mode === 'absent') return later(cb, enoent('access', path))
      if (isReadOnlyAccessMode(accessMode) && served(t)) return later(cb, null)
      return realAccess(path, mode, callback)
    }

    fs.promises.access = async function access(path, mode) {
      const t = classify(path)
      if (t?.mode === 'absent') throw enoent('access', path)
      if (isReadOnlyAccessMode(mode) && served(t)) return undefined
      return realAccessP(path, mode)
    }

    const servedRealpath = (realFn) => function realpath(path, options, callback) {
      const [opts, cb] = cbArgs(options, callback)
      const t = typeof cb === 'function' ? classify(path) : null
      if (t?.mode === 'absent') return later(cb, enoent('realpath', path))
      if (served(t)) return realFn(path, opts, (err, resolved) => cb(null, err ? encodeRealpath(t.abs, opts) : resolved))
      return realFn(path, options, callback)
    }
    fs.realpath = servedRealpath(realRealpath)
    fs.realpath.native = servedRealpath(realRealpathNative)

    fs.promises.realpath = async function realpath(path, options) {
      const t = classify(path)
      if (t?.mode === 'absent') throw enoent('realpath', path)
      if (!served(t)) return realRealpathP(path, options)
      try { return await realRealpathP(path, options) } catch { return encodeRealpath(t.abs, options) }
    }
  }

  // INVARIANT: a stasis module needing the real fs must snapshot it (`const { ... } = fs`), never live-import.
  syncBuiltinESMExports()
}
