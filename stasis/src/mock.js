// `stasis run --mock`'s side-effect denials (loader-mock.js), for what Node's `--permission` (bin/stasis.js) can't
// deny, the network above all: EVERY callable of a denied builtin throws, so clients bottoming out at it fail closed.
// Mocked on the mutable CJS exports (ESM namespaces are frozen): importers linked after this see the mocks.

import { mock } from 'node:test'
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)

// process.std{in,out,err} build a net.Socket/tty.WriteStream on first read, which syncBuiltinESMExports() below would
// otherwise trigger through our mock mid-setup: read once here, they cache the real ones.
for (const name of ['stdin', 'stdout', 'stderr']) void process[name]

const MARKER = '[stasis --mock]'

// Tagged (__stasisMock) so the unhandledRejection trap below can tell our denials from real bugs.
const blocked = (label) => {
  const err = new Error(`${MARKER} ${label} is blocked while capturing imports`)
  err.code = 'ERR_STASIS_MOCK_BLOCKED'
  err.__stasisMock = true
  return err
}

// Not an arrow, so `new mod.Constructor()` throws our error too rather than "is not a constructor".
const denyFn = (label) => function () { throw blocked(label) }

// Rejecting, so a fire-and-forget caller meets the unhandledRejection trap below rather than a sync crash.
const denyFnAsync = (label) => function () { return Promise.reject(blocked(label)) }

// Every own function on `mod` and `mod.promises` a thrower, a rejecting one on a promise surface but for a class
// (PascalCase), which `new` would make the Promise of.
const isClassName = (key) => /^[A-Z]/.test(key)
const denyModuleSurface = (prefix, mod, isAsync = prefix.endsWith('/promises')) => {
  for (const key of Object.getOwnPropertyNames(mod)) {
    const value = mod[key]
    if (typeof value === 'function') {
      const label = `${prefix}.${key}()`
      const impl = (isAsync && !isClassName(key)) ? denyFnAsync(label) : denyFn(label)
      try {
        mock.method(mod, key, impl)
      } catch {
        try { mod[key] = impl } catch { /* frozen: leave as-is */ }
      }
    } else if (key === 'promises' && value && typeof value === 'object') {
      denyModuleSurface(`${prefix}.promises`, value, true)
    }
  }
}

const DENY_ALL = [
  // Network surface (no --allow-net counterpart -- JS-mock is the only layer).
  'node:http', 'node:https', 'node:http2',
  'node:net', 'node:dgram', 'node:tls',
  'node:dns', 'node:dns/promises',
  // Already --permission-denied: for attributable errors, and in depth against an --allow-* slip or process.binding.
  'node:child_process',
  'node:worker_threads',
  'node:cluster',
  'node:inspector',
  'node:inspector/promises',
  // Other side-effect surfaces nothing else covers:
  'node:repl',         // repl.start() opens an interactive stdin loop
  'node:sqlite',       // DatabaseSync can open/create SQLite files (Node 22+)
  'node:trace_events', // createTracing() can write trace files
  'node:v8',           // writeHeapSnapshot bypasses node:fs; setFlagsFromString mutates global V8 state
  // node:wasi is deliberately omitted: require('node:wasi') emits an ExperimentalWarning, and
  // --permission already denies WASI construction at the kernel level.
]

for (const specifier of DENY_ALL) {
  let mod
  try {
    mod = require(specifier)
  } catch {
    continue // not present on this build
  }
  denyModuleSurface(specifier, mod)
}

// What mutates global process state, does real I/O, or talks to a parent over IPC (exit and abort are no side
// effect to hide); setUncaughtExceptionCaptureCallback would also disable the exitCode=13 cleanup below.
const PROCESS_DENY = [
  'chdir', 'kill', 'umask', 'dlopen', 'binding',
  'setUid', 'setGid', 'setEuid', 'setEgid', 'setgroups', 'initgroups',
  'send', 'disconnect',
  'setSourceMapsEnabled', 'loadEnvFile',
  'setUncaughtExceptionCaptureCallback',
]
for (const name of PROCESS_DENY) {
  if (typeof process[name] === 'function') mock.method(process, name, denyFn(`process.${name}()`))
}

// It writes a diagnostic JSON file.
if (typeof process.report?.writeReport === 'function') mock.method(process.report, 'writeReport', denyFn('process.report.writeReport()'))

// --permission blocks these too, but mocking gives cleaner errors and covers cwd, on --allow-fs-write for the bundle.
// Reads stay real so node_modules resolution keeps working.
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const FS_WRITERS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'mkdir', 'mkdirSync', 'rename', 'renameSync',
  'link', 'linkSync', 'symlink', 'symlinkSync',
  'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync',
  'utimes', 'utimesSync', 'lutimes', 'lutimesSync', 'futimes', 'futimesSync',
  'chmod', 'chmodSync', 'lchmod', 'lchmodSync', 'fchmod', 'fchmodSync',
  'chown', 'chownSync', 'lchown', 'lchownSync', 'fchown', 'fchownSync',
  'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'createWriteStream', 'mkdtemp', 'mkdtempSync',
]
for (const name of FS_WRITERS) {
  if (typeof fs[name] === 'function') mock.method(fs, name, denyFn(`node:fs.${name}()`))
  if (typeof fsPromises[name] === 'function') mock.method(fsPromises, name, denyFnAsync(`node:fs/promises.${name}()`))
}

// ESM imports after this see the mocks; bindings stasis linked before this ran keep their real snapshot.
syncBuiltinESMExports()

// The global fetch / WebSocket / EventSource are undici's, not node:http's. fetch never settles, so an awaiter
// hangs and the capture still drains to write the bundle on beforeExit; the others throw from their constructors.
if (typeof globalThis.fetch === 'function') globalThis.fetch = () => new Promise(() => {})
for (const name of ['WebSocket', 'EventSource']) {
  if (typeof globalThis[name] === 'function') {
    globalThis[name] = class {
      constructor() { throw blocked(name) }
    }
  }
}

// A fire-and-forget caller's denial would tear the process down before the loader writes the bundle.
process.on('unhandledRejection', (reason) => {
  if (reason?.__stasisMock) return
  throw reason
})

// Node 24+ sets exitCode=13 when a top-level await stays unsettled (e.g. an awaited denied
// promise). The bundle already wrote at beforeExit, so reset 13 -> 0; any other code is preserved.
process.on('exit', () => {
  if (process.exitCode === 13) process.exitCode = 0
})

// Timers are ignored: callback timers are no-ops, and promise timers never settle, which keeps no event loop
// alive, so the process still exits and the loader's beforeExit hook writes the bundle.
const noop = () => undefined
const pending = () => new Promise(() => {})
const TIMERS = ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate']
for (const name of TIMERS) globalThis[name] = noop

const timers = require('node:timers')
for (const name of TIMERS) mock.method(timers, name, noop)

const timersPromises = require('node:timers/promises')
for (const name of ['setTimeout', 'setImmediate']) mock.method(timersPromises, name, pending)
// An async iterable whose `for await` hangs at the first iteration.
mock.method(timersPromises, 'setInterval', () => ({
  [Symbol.asyncIterator]() {
    return { next: pending }
  },
}))
