// `stasis run --fs`: capture a program's fs reads into the bundle, or serve them from it (bundle=load).
// SECURITY INVARIANT: a path whose REAL path leaves the project root falls through to the real fs, never attested.

import { createRequire, syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { realContained } from './state-util.js'
import { isDotEnvFile, isPathWithin } from './util.js'

const require = createRequire(import.meta.url)
const fs = require('node:fs')

// The real sync, callback and promise fns of each patched op. The hooks call these, so there's no recursion and
// capture sees real bytes. Callback fs.exists is NOT patched (wrapping would clobber its util.promisify.custom);
// it answers via the patched fs.access.
const OPS = ['readFile', 'readdir', 'lstat', 'stat', 'access', 'realpath']
const real = Object.fromEntries(OPS.map((op) => [op, { sync: fs[`${op}Sync`], callback: fs[op], promise: fs.promises[op] }]))
const realExistsSync = fs.existsSync
const realRealpathSyncNative = fs.realpathSync.native
const realRealpathNative = fs.realpath.native

// The bundle serves read-only: an allowlist, so a W_OK/X_OK or out-of-range mode defers to the real fs.
const READ_ACCESS = fs.constants.F_OK | fs.constants.R_OK
const isReadOnlyAccessMode = (mode) => ((mode | 0) & ~READ_ACCESS) === 0

function toAbsPath(path) {
  if (typeof path === 'string' || Buffer.isBuffer(path)) return resolve(String(path))
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

// Indistinguishable from a real absent file's. String() spells a Buffer path as UTF-8 and a URL as its href.
function enoent(syscall, path) {
  const p = String(path)
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), { code: 'ENOENT', errno: -2, syscall, path: p })
}

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
    const url = pathToFileURL(abs).toString()
    // Absent: `*.map` (a captured build replays byte-identically; `map` in resources opts out) and `.env*` (a
    // capture never bakes in a secret), either served at load only as an explicit bundle member.
    const skipped = (abs.toLowerCase().endsWith('.map') && !state.config.resources?.has('map')) || isDotEnvFile(abs)
    if (skipped && !(state.config.loadBundle && state.getFsStatFamily(url) !== undefined)) return { mode: 'absent' }
    // And what excludeModules excludes, as though not installed. Resolvable still: Node's require() realpaths it,
    // and the resolution then misses as MODULE_NOT_FOUND.
    if (state.excludedModule(url) !== undefined) return { mode: 'absent', resolvable: true }
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
    if (realContained(state.root, abs)) record(() => state.addFsDir(url, names))
  }
  const captureStat = ({ state, abs, url }, stats) => {
    const isDir = stats.isDirectory()
    if (!isDir && !stats.isFile()) return
    if (realContained(state.root, abs) && !state.attestedBySidecar(url)) record(() => state.addFsStat(url, isDir ? 'directory' : 'file'))
  }

  // The probes, this and access, are served (a tool may probe before reading bytes, as @babel/core does) but
  // never captured.
  fs.existsSync = function existsSync(path) {
    const t = classify(path)
    if (t?.mode === 'absent') return false
    return served(t) || realExistsSync(path)
  }

  // Each op once: a plan from classify's answer, which its sync, callback and promise forms all run. No plan: the
  // real fn on the caller's own arguments. Else `done` maps the real fn's outcome on `args` to the answer, or with
  // no `args`, answers without a call.
  const fail = (err) => ({ done() { throw err } })
  // The real read of the path alone, so the capture sees the bytes, whatever the options.
  const capture = (t, path, add, answer = (res) => res) => ({
    args: [path],
    done(err, res) {
      if (err) throw err
      add(t, res)
      return answer(res)
    },
  })
  // stat follows symlinks: an in-root symlink records the TARGET's kind. bundleStats's field fallback stays sync.
  const statPlan = (syscall) => (t, path, options) => {
    // An absent path's stat answers as the real fn does for '' (never exists), re-spelled: which options it
    // honours varies by Node version (async stat takes throwIfNoEntry from 24.15, async lstat doesn't).
    if (t?.mode === 'absent') {
      return {
        args: ['', options],
        done(err, stats) {
          if (err?.code === 'ENOENT') throw enoent(syscall, path)
          if (err) throw err
          return stats
        },
      }
    }
    if (options != null) return
    if (t?.mode === 'serve') {
      const kind = t.state.getFsStatFamily(t.url)
      if (kind !== undefined) return { done: () => bundleStats(real[syscall].sync, path, kind === 'directory') }
    } else if (t?.mode === 'capture') {
      return capture(t, path, captureStat)
    }
  }
  const plans = {
    readFile(t, path, options) {
      if (t?.mode === 'absent') return fail(enoent('open', path))
      if (t?.mode === 'serve') {
        const buf = t.state.getFsFileFamily(t.url)
        if (buf !== undefined) return { done: () => decode(buf, options) }
      } else if (t?.mode === 'capture') {
        return capture(t, path, captureFile, (buf) => decode(buf, options))
      }
    },
    // A null options counts as none: graceful-fs normalises to that, else its reads never hit the bundle.
    readdir(t, path, options) {
      if (t?.mode === 'absent') return fail(enoent('scandir', path))
      if (options != null) return
      if (t?.mode === 'serve') {
        const names = t.state.getFsDirFamily(t.url)
        if (names !== undefined) return { done: () => names } // sorted at capture time
      } else if (t?.mode === 'capture') {
        return capture(t, path, captureDir)
      }
    },
    lstat: statPlan('lstat'),
    stat: statPlan('stat'),
    access(t, path, mode) {
      if (t?.mode === 'absent') return fail(enoent('access', path))
      if (isReadOnlyAccessMode(mode) && served(t)) return { done: () => undefined }
    },
    // The real realpath while on disk, else the lexical abs (ancestor symlinks not re-resolved then).
    realpath(t, path, options) {
      if (t?.mode === 'absent' && !t.resolvable) return fail(enoent('realpath', path))
      if (served(t)) return { args: [path, options], done: (err, resolved) => (err ? encodeRealpath(t.abs, options) : resolved) }
    },
  }

  const syncForm = (name, realFn, plan) => ({
    [name]: function (path, options) {
      const p = plan(classify(path), path, options)
      if (p === undefined) return realFn(path, options)
      if (p.args === undefined) return p.done()
      let res
      try {
        res = realFn(...p.args)
      } catch (err) {
        return p.done(err)
      }
      return p.done(null, res)
    },
  })[name]

  // A served answer is deferred, keeping fs's always-async contract. A decode error goes to the callback, as
  // fs.readFile's does: a throw here would be uncaught.
  const callbackForm = (name, realFn, plan) => ({
    [name]: function (path, options, callback) {
      const [opts, cb] = typeof options === 'function' ? [undefined, options] : [options, callback]
      const p = typeof cb === 'function' ? plan(classify(path), path, opts) : undefined
      if (p === undefined) return realFn(path, options, callback)
      const finish = (err, res) => {
        let answer
        try {
          answer = p.done(err, res)
        } catch (error) {
          return cb(error)
        }
        // As fs's own: no answer (access's) is no argument.
        if (answer === undefined) return cb(null)
        return cb(null, answer)
      }
      if (p.args === undefined) return queueMicrotask(finish)
      return realFn(...p.args, finish)
    },
  })[name]

  const promiseForm = (name, realFn, plan) => ({
    [name]: async function (path, options) {
      const p = plan(classify(path), path, options)
      if (p === undefined) return realFn(path, options)
      if (p.args === undefined) return p.done()
      return realFn(...p.args).then((res) => p.done(null, res), p.done)
    },
  })[name]

  for (const op of OPS) {
    fs[`${op}Sync`] = syncForm(`${op}Sync`, real[op].sync, plans[op])
    if (patchAsync) {
      fs[op] = callbackForm(op, real[op].callback, plans[op])
      fs.promises[op] = promiseForm(op, real[op].promise, plans[op])
    }
  }
  fs.realpathSync.native = syncForm('realpathSync', realRealpathSyncNative, plans.realpath)
  if (patchAsync) fs.realpath.native = callbackForm('realpath', realRealpathNative, plans.realpath)

  // INVARIANT: a stasis module needing the real fs must snapshot it (`const { ... } = fs`), never live-import.
  syncBuiltinESMExports()
}
