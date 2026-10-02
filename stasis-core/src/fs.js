// `stasis run --fs=sync|async`: monkey-patch the fs readers (readFileSync/readdirSync/lstat/stat
// + existence/realpath probes; under =async their callback + fs.promises counterparts) to capture a
// program's explicit reads into the bundle (bundle=add|replace) or serve them from it (bundle=load).
// SECURITY INVARIANT: only paths whose REAL path (symlinks resolved) stays inside the project root are
// captured/served; anything else falls through to the real fs and is never attested.

import { createRequire, syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { realReadFileSync } from './state-util.js'
import { isDotEnvFile, isPathWithin, isStasisArtifactName } from './util.js'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

// Snapshot the real fns while still genuine builtins; the hooks call THESE, never patched `fs.*`, so
// there's no recursion and capture/containment always see real bytes/paths. fs.promises IS
// node:fs/promises (same object). The legacy callback fs.exists is deliberately NOT reassigned
// (wrapping would clobber its util.promisify.custom); it still answers via the patched fs.access.
const {
  readdirSync: realReaddirSync, lstatSync: realLstatSync, statSync: realStatSync, realpathSync: realRealpathSync,
  existsSync: realExistsSync, accessSync: realAccessSync,
  readFile: realReadFile, readdir: realReaddir, lstat: realLstat, stat: realStat, access: realAccess, realpath: realRealpath,
} = fs
const { readFile: realReadFileP, readdir: realReaddirP, lstat: realLstatP, stat: realStatP, access: realAccessP, realpath: realRealpathP } = fs.promises
const realRealpathSyncNative = realRealpathSync.native
const realRealpathNative = realRealpath.native

// The bundle serves read-only, so only an F_OK/R_OK-only mode may be answered from it; allowlist form
// so a W_OK/X_OK or out-of-range mode defers to the real fs.
const READ_ACCESS = fs.constants.F_OK | fs.constants.R_OK
const isReadOnlyAccessMode = (mode) => ((mode | 0) & ~READ_ACCESS) === 0

// Resolve a path argument to an absolute path, or null for what we don't capture (fd, non-file URL).
function toAbsPath(path) {
  if (typeof path === 'string') return resolve(path)
  if (Buffer.isBuffer(path)) return resolve(path.toString())
  if (path instanceof URL) return path.protocol === 'file:' ? fileURLToPath(path) : null
  return null
}

let realRootCache
function realRootOf(root) {
  if (realRootCache?.root !== root) {
    let real
    try { real = realRealpathSync(root) } catch { real = root }
    realRootCache = { root, real }
  }
  return realRootCache.real
}

// Capture-side containment: the path's REAL location must stay inside root's real path, else an
// in-tree symlink pointing OUT would pull external content into the signed bundle.
function realContained(root, abs) {
  let real
  try { real = realRealpathSync(abs) } catch { return false }
  return isPathWithin(realRootOf(root), real)
}

// At the project root, drop stasis's own artifacts from the RECORDED listing so it doesn't depend on
// whether an earlier run left them behind; the program still receives the true on-disk `names`.
function dirCaptureNames(root, abs, names) {
  if (!isPathWithin(abs, root)) return names
  return names.filter((name) => !isStasisArtifactName(name))
}

// Apply readFileSync's encoding arg to raw bytes; Buffer.toString matches fs's ERR_UNKNOWN_ENCODING.
function decode(buf, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding
  return encoding == null ? buf : buf.toString(encoding)
}

// Honour realpath's `encoding` arg for the synthetic answer when a bundle-served path is gone from disk.
function encodeRealpath(abs, options) {
  const encoding = typeof options === 'string' ? options : options?.encoding
  return encoding === 'buffer' ? Buffer.from(abs) : abs
}

// NON-EXISTENT under --fs (faithful ENOENT in both modes): source-map sidecars (`*.map`, so a captured
// build replays byte-identically; opt out via `map` in resources) and `.env`/`.env.*` (an automated
// capture can never bake a secret in; no opt-in). The ONE way either serves at load is bundle
// membership (an explicit `stasis add .env`).
function isSkippedFsPath(state, abs) {
  const skipped = (abs.toLowerCase().endsWith('.map') && !state.config.resources?.has('map')) || isDotEnvFile(abs)
  return skipped && !(state.config.loadBundle && state.getFsStatFamily(pathToFileURL(abs).toString()) !== undefined)
}

// A faithful Node-shaped ENOENT, indistinguishable from a real absent file.
function enoent(syscall, path) {
  const p = typeof path === 'string' ? path : Buffer.isBuffer(path) ? path.toString() : String(path)
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), { code: 'ENOENT', errno: -2, syscall, path: p })
}

// File-type bits, so code reading stats.mode (not the is*() methods) still sees file-vs-dir.
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

// Neutral fs.Stats-shaped record for a bundle-served path gone from disk; never throws, so wrappers
// reading uid/gid etc. keep working.
function syntheticStat(isDir) {
  const epoch = new Date(0)
  return {
    dev: 0, ino: 0, mode: isDir ? S_IFDIR : S_IFREG, nlink: 1, uid: 0, gid: 0,
    rdev: 0, size: 0, blksize: 4096, blocks: 0,
    atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
    atime: epoch, mtime: epoch, ctime: epoch, birthtime: epoch,
    isSymbolicLink: () => false, isBlockDevice: () => false,
    isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
  }
}

// A Stats-like Proxy for a bundle-served path: isFile()/isDirectory() answer from the bundle, other
// members from the REAL stat while on disk, else syntheticStat. `then` is short-circuited so a
// bundle-served Stats is never an accidental (rejecting) thenable under `await`.
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

  // Classify a path for every hook: null passes through to the real fs; else { mode, abs, url, state }
  // with mode 'absent' (a skipped path: ENOENT), 'serve' (bundle=load; an uncaptured path still falls
  // through to disk) or 'capture' (bundle=add|replace, outside a loader read). `skipped: false`
  // leaves a skipped name to serve/capture (readdirSync, where only the async form treats it as absent).
  const classify = (path, { skipped = true } = {}) => {
    const state = getState()
    if (!state) return null
    const abs = toAbsPath(path)
    if (abs === null || !isPathWithin(state.root, abs)) return null
    if (skipped && isSkippedFsPath(state, abs)) return { mode: 'absent', abs }
    const url = pathToFileURL(abs).toString()
    if (state.config.loadBundle) return { mode: 'serve', state, url, abs }
    if (state.config.writeBundle && !isLoadingModule()) return { mode: 'capture', state, url, abs }
    return null
  }
  // A path the bundle knows (content, listing, stat record or implied dir), for the serve-only probes.
  const served = (t) => t?.mode === 'serve' && t.state.getFsStatFamily(t.url) !== undefined

  // Capture-side records; a rejected capture taints the run (markAborted) rather than failing the read.
  const record = (fn) => { try { fn() } catch (err) { markAborted(err) } }
  // A path whose real location escapes root (in-tree symlink) is read but NOT recorded, and neither is
  // a read a bundler-plugin sidecar already attests.
  const captureFile = ({ state, abs, url }, buf) => {
    if (realContained(state.root, abs) && !state.attestedBySidecar(url)) record(() => state.addFsFile(url, buf))
  }
  const captureDir = ({ state, abs, url }, names) => {
    if (realContained(state.root, abs)) record(() => state.addFsDir(url, dirCaptureNames(state.root, abs, names)))
  }
  // A stat records the path's KIND as a payload-free record so a stat-ONLY path's type getters answer
  // at load. Only file and dir are modelled.
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
    // Single-argument form only; any options pass straight through.
    const t = options == null ? classify(path, { skipped: false }) : null
    if (t?.mode === 'serve') {
      const names = t.state.getFsDirFamily(t.url)
      if (names !== undefined) return names // sorted at capture time
    } else if (t?.mode === 'capture') {
      const names = realReaddirSync(path)
      captureDir(t, names)
      return names
    }
    return realReaddirSync(path, options)
  }

  // Single-arg form only; capture still hands the caller the REAL Stats/errors. statSync follows
  // symlinks, so it must use the real statSync: an in-root symlink records the TARGET's kind there.
  const servedStatSync = (syscall, realFn) => ({
    [`${syscall}Sync`](path, options) {
      const t = options == null ? classify(path) : null
      if (t?.mode === 'absent') throw enoent(syscall, path)
      if (t?.mode === 'serve') {
        const kind = t.state.getFsStatFamily(t.url)
        if (kind !== undefined) return bundleStats(realFn, path, kind === 'directory')
      } else if (t?.mode === 'capture') {
        const stats = realFn(path)
        captureStat(t, stats)
        return stats
      }
      return realFn(path, options)
    },
  })[`${syscall}Sync`]
  fs.lstatSync = servedStatSync('lstat', realLstatSync)
  fs.statSync = servedStatSync('stat', realStatSync)

  // existsSync/accessSync/realpathSync: existence + canonical-path PROBES, serve-only (bundle=load) --
  // a tool may probe before reading bytes (@babel/core does); capture mode and unrecorded paths defer.
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

  // Try the real realpath first (true symlink resolution while on disk), fall back to the lexical abs
  // once gone (ancestor symlinks not re-resolved then).
  const servedRealpathSync = (realFn) => function realpathSync(path, options) {
    const t = classify(path)
    if (t?.mode === 'absent') throw enoent('realpath', path)
    if (served(t)) {
      try { return realFn(path, options) } catch { return encodeRealpath(t.abs, options) }
    }
    return realFn(path, options)
  }
  fs.realpathSync = servedRealpathSync(realRealpathSync)
  fs.realpathSync.native = servedRealpathSync(realRealpathSyncNative)

  // --fs=async counterparts; a served callback is deferred (queueMicrotask) to preserve fs's
  // always-async contract.
  if (patchAsync) {
    // Split a trailing callback from its optional options argument.
    const cbArgs = (options, callback) => (typeof options === 'function' ? [undefined, options] : [options, callback])
    const later = (cb, ...args) => queueMicrotask(() => cb(...args))
    // Route a decode error to the callback (as fs.readFile does); a throw from a deferred callback
    // would escape as an uncaught exception and crash the process.
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
      // Single-arg form only, and a null options must count as "no options" (graceful-fs normalises to
      // that), else its reads never hit the bundle.
      const t = opts == null && typeof cb === 'function' ? classify(path) : null
      if (t?.mode === 'serve') {
        const names = t.state.getFsDirFamily(t.url)
        if (names !== undefined) return later(cb, null, names)
      } else if (t?.mode === 'capture') {
        return realReaddir(path, (err, names) => {
          if (err) return cb(err)
          captureDir(t, names)
          cb(null, names)
        })
      }
      return realReaddir(path, options, callback)
    }

    fs.promises.readdir = async function readdir(path, options) {
      const t = options == null ? classify(path) : null
      if (t?.mode === 'serve') {
        const names = t.state.getFsDirFamily(t.url)
        if (names !== undefined) return names
      } else if (t?.mode === 'capture') {
        const names = await realReaddirP(path)
        captureDir(t, names)
        return names
      }
      return realReaddirP(path, options)
    }

    // lstat/stat mirror their sync siblings; bundleStats's field fallback stays sync.
    const servedStat = (syscall, realFn, realSyncFn) => ({
      [syscall](path, options, callback) {
        const [opts, cb] = cbArgs(options, callback)
        const t = opts == null && typeof cb === 'function' ? classify(path) : null
        if (t?.mode === 'absent') return later(cb, enoent(syscall, path))
        if (t?.mode === 'serve') {
          const kind = t.state.getFsStatFamily(t.url)
          if (kind !== undefined) return later(cb, null, bundleStats(realSyncFn, path, kind === 'directory'))
        } else if (t?.mode === 'capture') {
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
        const t = options == null ? classify(path) : null
        if (t?.mode === 'absent') throw enoent(syscall, path)
        if (t?.mode === 'serve') {
          const kind = t.state.getFsStatFamily(t.url)
          if (kind !== undefined) return bundleStats(realSyncFn, path, kind === 'directory')
        } else if (t?.mode === 'capture') {
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
      if (served(t)) {
        try { return await realRealpathP(path, options) } catch { return encodeRealpath(t.abs, options) }
      }
      return realRealpathP(path, options)
    }
  }

  // Refresh the node:fs (+ node:fs/promises) ESM wrappers so user-code live imports see the patched fns.
  // INVARIANT: a stasis module needing the real fs must snapshot it (`const { ... } = fs`), never live-import.
  syncBuiltinESMExports()
}
