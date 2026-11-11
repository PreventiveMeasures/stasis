import Module, { registerHooks, findPackageJSON, isBuiltin } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

import { State } from './state.js'
import { installFsHooks } from './fs.js'
import { inScope } from './state-util.js'
import { NATIVE_BUILD_FORMATS, NODE_FORMATS, RESOURCE_FORMATS, SOURCE_LANGUAGE_FORMATS, STAT_FORMATS, erasedTypeScriptFormat, nestedMap } from './util.js'

// Snapshot off the namespace so `--fs` can't redirect stasis's own capture/shard reads.
const { mkdtempSync, opendirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = fs

const CJS_FORMATS = new Set(['commonjs', 'commonjs-typescript'])

function refuseNonNodeFormat(format, url) {
  if (SOURCE_LANGUAGE_FORMATS.has(format)) {
    throw new Error(`[stasis] cannot execute a '${format}' bundle: ${format} bundles are produced for external analysis, not for 'stasis run --bundle=load' (${url})`)
  }
  if (NATIVE_BUILD_FORMATS.has(format)) {
    throw new Error(`[stasis] cannot execute a '${format}' file: native build inputs (podspec/gradle/Java/Kotlin/ObjC++/...) are attested for the CocoaPods/Gradle toolchain, not executable by Node (${url})`)
  }
  if (RESOURCE_FORMATS.has(format)) {
    throw new Error(`[stasis] cannot import a resource file ('${format}'): asset content is not executable JavaScript. Read it with fs (or your bundler's asset loader) instead (${url})`)
  }
  if (format === 'patch') {
    throw new Error(`[stasis] cannot execute a 'patch' file: a unified diff is applied by a patch step (pnpm patchedDependencies, patch-package, a build script), not run by Node (${url})`)
  }
  if (format === 'directory') {
    throw new Error(`[stasis] cannot import a directory listing ('directory'): a captured fs.readdirSync result is not executable JavaScript. Read it with fs.readdirSync instead (${url})`)
  }
  if (format === undefined) {
    throw new Error(`[stasis] cannot execute '${url}': the bundle carries it with no format, as it carries the code Metro builds from source, which is for Metro, not Node`)
  }
  if (STAT_FORMATS.has(format)) {
    throw new Error(`[stasis] cannot import '${url}': the bundle carries only a payload-free stat record ('${format}', an fs.lstatSync/statSync capture attesting existence and kind) -- not the file's content. Capture a run that reads or imports it to bundle its bytes.`)
  }
  throw new Error(`[stasis] cannot execute '${url}': attested format '${format}' is not a Node loader format. The bundle may be tampered, produced by a newer stasis, or built for a non-Node consumer.`)
}

// node:59666: restores require.cache/require.extensions the ESM->CJS translator's require omits.
const CJS_REQUIRE_REPAIR =
  "try{if(typeof require==='function'&&!require.cache){" +
  "const __stasis_m=require('node:module');" +
  'if(__stasis_m&&__stasis_m.Module){' +
  'require.cache=__stasis_m.Module._cache;' +
  'if(!require.extensions)require.extensions=__stasis_m.Module._extensions;}}}catch{}'

const WS_COMMENTS = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/uy
const STRING_LITERAL = /(['"])(?:[^\\]|\\.)*?\1/uy
// Matches only single-line block comments: a newline-spanning one counts as a line boundary for ASI.
const TRAILING_SAME_LINE = /(?:[ \t]|\/\*(?:[^*\n\r\u2028\u2029]|\*(?!\/))*\*\/)*/uy
// A directive string followed by one of these heads a multi-line expression, not a directive (ASI gotcha).
const EXPR_CONTINUATION = new Set(['.', '[', '(', '`', '+', '-', '*', '/', '%', ',', '?', ':', '=', '<', '>', '&', '|', '^'])
const KEYWORD_CONTINUATION = /(?:instanceof|in)\b/uy
function matchEnd(re, source, i) {
  re.lastIndex = i
  return re.test(source) ? re.lastIndex : -1
}
function newStatementAfterBreak(source, pos) {
  const afterBreak = matchEnd(WS_COMMENTS, source, pos)
  if (afterBreak >= source.length) return true
  if (EXPR_CONTINUATION.has(source[afterBreak])) return false
  return matchEnd(KEYWORD_CONTINUATION, source, afterBreak) === -1
}
function endsDirective(source, pos) {
  const c = source[pos]
  if (c === undefined || c === ';' || c === '}') return true
  if (c === '/' && source[pos + 1] === '/') return true
  // A `/*` here spans a newline: like a line break it can end the directive.
  if (c === '/' && source[pos + 1] === '*') return newStatementAfterBreak(source, pos)
  return (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') && newStatementAfterBreak(source, pos)
}

// AFTER the Directive Prologue, with a leading ';': a `'use strict'` stays strict, a leading string EXPRESSION whole.
function repairCjsRequire(source) {
  if (typeof source !== 'string') return source
  let i = 0
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n')
    i = nl === -1 ? source.length : nl + 1
  }
  for (;;) {
    const afterStr = matchEnd(STRING_LITERAL, source, matchEnd(WS_COMMENTS, source, i))
    if (afterStr === -1 || !endsDirective(source, matchEnd(TRAILING_SAME_LINE, source, afterStr))) break
    i = afterStr
  }
  return `${source.slice(0, i)};${CJS_REQUIRE_REPAIR}${source.slice(i)}`
}

let state
// The root merges/removes ONLY a shard dir it minted and accepts ONLY shards signed under its own key.
let createdShardDir
let createdShardPub
let createdShardPubId
// Latched once artifacts are written, so a late first load can't ship unattested.
let saved = false
let lastShardWritten
// Set when stasis's own capture/verification rejects something: then nothing is written.
let aborted = false
// >0 while Node's loader reads a module's source; the --fs hook skips reads taken then.
let loadingModule = 0
let entryUnseen = true
// Until the CLI entry resolves, preloads (`--import tsx`) resolve from a DIRECTORY parent: runner infrastructure,
// neither captured (it would misfile the entry) nor gated (a preload loads from disk under --bundle=load).
let entryUnresolved = true
// The infrastructure graph passes both hooks unobserved; its loads and edges are kept for when the app reaches it.
const infraUrls = new Set()
const infraSources = new Map()
const infraEdges = new Map()
// So the CJS shim detects an attested file a transplanted require.extensions handler (tsx's) ran from DISK.
const servedFromBundle = new Set()

// A child (pid mismatch) must not write the artifacts: the root owns them, and a 2nd writer races.
const OWN_PID = String(process.pid)
process.env.EXODUS_STASIS_PID ||= OWN_PID
const isChildProcess = process.env.EXODUS_STASIS_PID !== OWN_PID
const forkedChild = isChildProcess && process.channel !== undefined

// stasis-core's own package root, so State's backfill captures edges loaded before our hooks registered.
const PRELOAD_ROOT = (() => {
  try { return dirname(findPackageJSON(import.meta.url)) } catch { return undefined }
})()

// A capture step whose rejection must never be written, even if user code swallows the throw.
function recording(fn) {
  try {
    return fn()
  } catch (err) {
    aborted = true
    throw err
  }
}

function loadCounted(nextLoad, url, context) {
  loadingModule++
  try {
    return nextLoad(url, context)
  } finally {
    loadingModule--
  }
}

const toBuffer = (source) => (Buffer.isBuffer(source) ? source : Buffer.from(source))
// Node's CJS loader may return source=null and read the file from disk itself.
const sourceOrDisk = (source, url) => source ?? readFileSync(fileURLToPath(url))

// --child-process: trust rests on a shard's signature under a key the root minted; shards carry NO bytes.
function shardForwardingEnabled() {
  return state.config.childProcess && (state.config.writeLockfile || state.config.writeBundle)
}

function clearShardEnv() {
  delete process.env.EXODUS_STASIS_SHARD_DIR
  delete process.env.EXODUS_STASIS_SHARD_KEY
}

function removeShardDir() {
  if (!createdShardDir) return
  try { rmSync(createdShardDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

function writeChildShard() {
  const dir = process.env.EXODUS_STASIS_SHARD_DIR
  const keyB64 = process.env.EXODUS_STASIS_SHARD_KEY
  if (!dir || !keyB64) return
  try {
    // Sign the exact string, never a re-stringify; temp + rename so the merge never reads half a shard.
    const shard = state.shardSnapshot()
    if (shard === lastShardWritten) return
    const privateKey = createPrivateKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8' })
    const pubId = createPublicKey(privateKey).export({ format: 'jwk' }).x
    const signature = sign(null, Buffer.from(shard), privateKey).toString('base64url')
    const unique = `${OWN_PID}-${randomBytes(6).toString('hex')}`
    const tmpPath = join(dir, `.${pubId}-${unique}.tmp`)
    writeFileSync(tmpPath, JSON.stringify({ shard, signature }))
    renameSync(tmpPath, join(dir, `${pubId}-${unique}.json`))
    lastShardWritten = shard
  } catch { /* best-effort: a child that can't snapshot/sign/write just doesn't contribute */ }
}

// So a hostile/runaway shard set can't OOM the root.
const MAX_SHARDS = 4096
const MAX_SHARD_BYTES = 64 * 1024 * 1024

// Verified against our own PUBLIC key, not one from the filename; opendir keeps memory bounded.
function mergeChildShards(dir) {
  let handle
  try { handle = opendirSync(dir) } catch { return }
  const prefix = `${createdShardPubId}-`
  let count = 0
  try {
    for (let dirent = handle.readSync(); dirent !== null; dirent = handle.readSync()) {
      const { name } = dirent
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      if (++count > MAX_SHARDS) break
      const path = join(dir, name)
      try {
        if (statSync(path).size > MAX_SHARD_BYTES) continue
        const { shard, signature } = JSON.parse(readFileSync(path, 'utf-8'))
        if (typeof shard !== 'string' || typeof signature !== 'string') continue
        if (!verify(null, Buffer.from(shard), createdShardPub, Buffer.from(signature, 'base64url'))) continue
        state.mergeShard(shard)
      } catch { /* a malformed/partial shard is skipped */ }
    }
  } finally {
    try { handle.closeSync() } catch { /* best-effort */ }
  }
}

function initState(root) {
  state = new State(root, { preload: true, preloadRoot: PRELOAD_ROOT })

  // AFTER stasis's own fs snapshots, so they never redirect its own reads.
  if (state.config.fs) {
    installFsHooks({
      async: state.config.fs === 'async',
      getState: () => state,
      isLoadingModule: () => loadingModule > 0,
      // Warned, else the discard is silent: reads succeed, exit 0, no artifact.
      markAborted: (err) => {
        if (!aborted) console.warn(`[stasis] --fs: capture aborted, no bundle/lockfile will be written -- ${err?.message ?? err}`)
        aborted = true
      },
    })
  }

  // ALWAYS mint our own dir and keypair, overwriting any inherited/attacker-set env: we merge only what we verify.
  if (!isChildProcess && shardForwardingEnabled()) {
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      createdShardDir = mkdtempSync(join(tmpdir(), 'stasis-shard-'))
      createdShardPub = publicKey
      createdShardPubId = publicKey.export({ format: 'jwk' }).x
      process.env.EXODUS_STASIS_SHARD_DIR = createdShardDir
      // Rides process.env so every transitive descendant inherits; do NOT scrub it downstream.
      process.env.EXODUS_STASIS_SHARD_KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    } catch {
      // Descendants must not fall back to an inherited channel we never minted.
      removeShardDir()
      createdShardDir = createdShardPub = createdShardPubId = undefined
      clearShardEnv()
    }
  } else if (!isChildProcess) {
    clearShardEnv()
  }

  // NOT gated on exit code: a clean capture exiting non-zero still persists. Fully synchronous for `exit`.
  const save = () => {
    if (isChildProcess) {
      if (shardForwardingEnabled() && !aborted) writeChildShard()
      return
    }
    try {
      if (aborted) return
      if (createdShardDir) mergeChildShards(createdShardDir)
      // In every mode: write() also VERIFIES in read-only frozen modes.
      state.write()
      // A read-only run persists nothing, so a later first load (another exit handler's) is still attested.
      if (state.config.writeLockfile || state.config.writeBundle) saved = true
    } finally {
      removeShardDir()
    }
  }

  // `exit` alone: it runs after every beforeExit handler, so one flush there sees strictly more.
  process.on('exit', save)

  // jest-worker's forceExit bypasses `exit` (500ms window). SIGTERM is re-delivered unless user code owns it,
  // snapshotted now: a `once` that already ran is invisible to listenerCount.
  if (isChildProcess && shardForwardingEnabled() && state.config.shardSignalFlush) {
    const userOwnedSigterm = process.listenerCount('SIGTERM') > 0
    process.once('SIGTERM', () => {
      try {
        save()
      } finally {
        if (!userOwnedSigterm && process.listenerCount('SIGTERM') === 0) process.kill(process.pid, 'SIGTERM')
      }
    })
  }
}

function initStateFromPackage(url) {
  const pkg = findPackageJSON(url)
  assert.equal(basename(pkg), 'package.json')
  initState(dirname(pkg))
}

function load(url, context, nextLoad) {
  assert.equal(typeof url, 'string')

  if (url.startsWith('node:')) {
    const result = nextLoad(url, context)
    assert.equal(result.format, 'builtin')
    return result
  }

  // Stashed so a later app edge can promote the module with the exact bytes that executed.
  if (entryUnresolved || infraUrls.has(url)) {
    infraUrls.add(url)
    const result = loadCounted(nextLoad, url, context)
    if (!infraSources.has(url)) infraSources.set(url, { source: result.source, format: result.format })
    return result
  }

  if (state?.config.loadBundle) {
    if (!inScope(state, url)) return nextLoad(url, context)
    const { source, format } = state.getFile(url)
    // A transforming preload (`--import tsx`) asks for a '-typescript' file as its post-erasure family.
    if (context.format != null && context.format !== erasedTypeScriptFormat(format)) assert.equal(format, context.format)
    if (!NODE_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    servedFromBundle.add(url)
    return { source: CJS_FORMATS.has(format) ? repairCjsRequire(source) : source, format: context.format ?? format, shortCircuit: true }
  }

  const result = loadCounted(nextLoad, url, context)
  const { format } = result
  assert.notEqual(format, 'builtin')
  const source = format === 'commonjs' ? sourceOrDisk(result.source, url) : result.source

  const isEntry = entryUnseen
  entryUnseen = false
  if (!state) initStateFromPackage(url)

  assert.equal(saved, false)
  recording(() => state.addFile(url, { source, format, isEntry }))

  return result
}

// The app reached a module a preload executed, whose load hook can't re-fire: else a dangling edge ships.
function promoteInfraUrl(url, { isEntry = false } = {}) {
  if (!infraUrls.delete(url)) return
  const stashed = infraSources.get(url)
  if (stashed === undefined) return
  infraSources.delete(url)
  const source = sourceOrDisk(stashed.source, url)
  recording(() => state.addFile(url, { source, format: stashed.format ?? undefined, isEntry }))
  const edges = infraEdges.get(url)
  infraEdges.delete(url)
  for (const [specifier, edge] of edges ?? []) {
    recording(() => state.addImport(url, specifier, edge.url, edge.context))
    promoteInfraUrl(edge.url)
  }
}

// A preload's CACHED disk-loaded instance shadows what the hooks would serve: allowed only for identical bytes.
function assertInfraMatchesBundle(url) {
  if (!infraUrls.has(url)) return
  const stashed = infraSources.get(url)
  if (stashed === undefined) { infraUrls.delete(url); return } // resolved but never loaded: the hooks will serve it
  const executed = toBuffer(sourceOrDisk(stashed.source, url))
  if (!executed.equals(toBuffer(state.getFile(url).source))) {
    throw new Error(`[stasis] cannot serve '${url}' from the bundle: a preload already executed it from disk ` +
      'before the entry, and those bytes differ from the attested ones -- refusing the divergent cached instance')
  }
}

function resolve(specifier, context, nextResolve) {
  const { parentURL, conditions, importAttributes } = context
  // A DIRECTORY parent can't shadow an app parent; any other pre-entry parent ([eval]'s import) fails closed below.
  if (parentURL !== undefined && (infraUrls.has(parentURL) || (entryUnresolved && parentURL.endsWith('/')))) {
    const res = nextResolve(specifier)
    if (!res.url.startsWith('node:')) {
      infraUrls.add(res.url)
      if (infraUrls.has(parentURL)) {
        // Last-write-wins: only the final target can be the one a cached instance pins.
        nestedMap(infraEdges, parentURL).set(specifier, { url: res.url, context: { conditions, format: res.format, importAttributes } })
      }
    }
    return res
  }
  if (entryUnresolved && !parentURL) entryUnresolved = false

  if (isBuiltin(specifier)) {
    const res = nextResolve(specifier)
    assert.equal(res.url, specifier.startsWith('node:') ? specifier : `node:${specifier}`)
    return res
  }

  if (importAttributes !== undefined) {
    const expectedAttrs = Object.create(null) // saving not supported yet; enforce expected attrs
    if (extname(specifier) === '.json' && importAttributes?.type) expectedAttrs.type = 'json'
    assert.deepStrictEqual(importAttributes, expectedAttrs)
  }

  // Full-scope load serves the entry from the bundle, so state must exist before nextResolve.
  if (!state && !parentURL && process.env.EXODUS_STASIS_BUNDLE === 'load'
      && process.env.EXODUS_STASIS_SCOPE !== 'node_modules') initState(process.cwd())

  if (state?.config.loadBundle) {
    // inNodeModules(), not a raw substring: a symlinked workspace source is read from disk.
    if (!state.config.full && !(parentURL && state.inNodeModules(parentURL))) return nextResolve(specifier)
    // The entry skips nextResolve, so it needn't be on disk.
    let url
    let format
    if (parentURL && !specifier.startsWith('file:')) {
      ({ url, format } = state.getImport(parentURL, specifier, { conditions, importAttributes }))
    } else {
      url = specifier.startsWith('file:') ? specifier : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
      // A forked child's main module isn't a declared CLI entry (getFile still fails closed).
      if (!parentURL && state.config.full && !forkedChild) state.assertEntry(url)
      format = state.getFormat(url)
    }
    // Friendlier error at resolve time; the load gate is the load-bearing one.
    if (format != null && !NODE_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    assertInfraMatchesBundle(url)
    return { url, format, importAttributes: undefined, shortCircuit: true }
  }

  const res = nextResolve(specifier)
  const { url, format } = res

  assert.equal(res.importAttributes, undefined) // unsupported yet
  if (parentURL) assert.ok(state)
  if (infraUrls.has(url)) {
    if (infraSources.has(url)) {
      // The ENTRY itself was preloaded (a wrapper importing the app): init from its package root.
      if (!state) initStateFromPackage(url)
      const isEntry = !parentURL && entryUnseen
      if (isEntry) entryUnseen = false
      promoteInfraUrl(url, { isEntry })
    } else {
      // Never loaded: the app's own load will capture it.
      infraUrls.delete(url)
    }
  }
  // The entry is recorded by addFile/promotion, never as an edge.
  if (state && parentURL) recording(() => state.addImport(parentURL, specifier, url, { conditions, format, importAttributes }))
  return res
}

let installed = false

// So plugins.js can detect the loader before the lazy initState fires.
export function isLoaderInstalled() {
  return installed
}

// For a plugin constructor run ahead of the load hook.
export function ensureStateForLoader() {
  if (!state) initState(process.cwd())
}

// Separate from the --import entry points so a host can compose setup before the hooks register.
export function install() {
  if (installed) return
  installed = true
  registerHooks({ load, resolve })
  patchCjsResolution()
  // The --fs patches wait for initState: their mode may come from stasis.config.json.
}

// registerHooks doesn't intercept the require() the ESM->CJS translator builds, which resolves against disk.
function patchCjsResolution() {
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const loadMode = state?.config.loadBundle
    if (loadMode && typeof request === 'string' && !isBuiltin(request)) {
      if (typeof parent?.filename === 'string') {
        const parentURL = pathToFileURL(parent.filename).toString()
        if (inScope(state, parentURL)) {
          // For require(), whose target settles a divergent edge.
          const resolved = state.resolveBundled(parentURL, request, { conditions: ['require'] })
          if (resolved !== undefined) {
            assertInfraMatchesBundle(pathToFileURL(resolved).toString())
            return resolved
          }
        }
      } else if (isAbsolute(request)) {
        // Node's ESM<->CJS interop re-enters the CJS loader with hooks SKIPPED (every commonjs-sync eval on
        // 24.14-24.17), so only this shim intercepts. hasFsFileContent: a listing or stat record never resolves.
        const url = pathToFileURL(request).toString()
        if (inScope(state, url) && state.hasFsFileContent(url)) {
          assertInfraMatchesBundle(url)
          return resolvePath(request)
        }
      }
    }
    const resolved = original.call(this, request, parent, ...rest)
    // Capture: require.resolve() and some CJS require()s never fire the resolve hook.
    if (state && !loadMode && typeof request === 'string' && !isBuiltin(request) && typeof parent?.filename === 'string') {
      state.observeResolution(pathToFileURL(parent.filename).toString(), request, pathToFileURL(resolved).toString())
    }
    return resolved
  }

  // Module._load's cache fast path can skip _resolveFilename. It also sees every ACTUAL CJS execution, so it
  // catches transplanted require.extensions handlers (`--import tsx` compiling .ts) the load hooks never see.
  const originalLoad = Module._load
  Module._load = function (request, parent, ...rest) {
    let resolvedUrl
    if (state && typeof request === 'string' && !isBuiltin(request) && typeof parent?.filename === 'string') {
      let resolved
      try { resolved = Module._resolveFilename(request, parent, ...rest) } catch { /* original _load raises the real error */ }
      if (typeof resolved === 'string' && isAbsolute(resolved)) resolvedUrl = pathToFileURL(resolved).toString()
    }
    if (resolvedUrl !== undefined && !state.config.loadBundle) {
      state.observeExecution(resolvedUrl)
      promoteInfraUrl(resolvedUrl)
    }
    const result = originalLoad.call(this, request, parent, ...rest)
    // An attested source the load hook never served ran from DISK: fail closed, before anything trusts the run.
    if (resolvedUrl !== undefined && state.config.loadBundle
        && !servedFromBundle.has(resolvedUrl) && state.isBundledSource(resolvedUrl)) {
      throw new Error(`[stasis] '${resolvedUrl}' executed from disk, bypassing the attested bundle -- a require() pipeline ` +
        'transplanted by a preload (e.g. tsx compiling CJS TypeScript) cannot serve bundle bytes and is refused under --bundle=load')
    }
    return result
  }
}
