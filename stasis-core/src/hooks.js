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

// The trust gate's refusal for a bundle-served file whose attested format Node can't execute, by kind.
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
// Where the sticky `re` matched at `i` ends, or -1 for no match.
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
// Whether a directive string's statement ends at `pos`, past its same-line trailing whitespace and comments.
function endsDirective(source, pos) {
  const c = source[pos]
  if (c === undefined || c === ';' || c === '}') return true
  if (c === '/' && source[pos + 1] === '/') return true
  // A `/*` here is a newline-spanning block comment: like a line break it can end the directive.
  if (c === '/' && source[pos + 1] === '*') return newStatementAfterBreak(source, pos)
  return (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029') && newStatementAfterBreak(source, pos)
}

// Insert CJS_REQUIRE_REPAIR AFTER the Directive Prologue with a leading ';', so a `'use strict'`
// stays strict and a leading string EXPRESSION isn't split mid-expression.
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
// True once artifacts are written; the load hook asserts on it so a late first load can't ship unattested.
let saved = false
// Serialized shard text a child last wrote, so a second flush skips an identical re-write.
let lastShardWritten
// Set when stasis's own capture/verification rejects something; when set, nothing is written.
let aborted = false
// >0 while Node's loader reads a module's source; the --fs hook skips reads taken then.
let loadingModule = 0
// True until the first non-builtin load hook fires (entry detection).
let entryUnseen = true
// True until the first parent-less resolution, the CLI entry. Preloads (`stasis run --import tsx`) resolve
// from a DIRECTORY parent (the cwd URL) before it: runner infrastructure, neither captured (it would misfile
// the entry and add toolchain files) nor gated (a preload must load from disk under --bundle=load).
let entryUnresolved = true
// The runner-infrastructure graph: every URL the preload phase resolved or loaded, plus its post-entry
// descendants. Members pass both hooks unobserved, but their raw loads (infraSources) and edges (infraEdges)
// are kept for when the app graph reaches one: see promoteInfraUrl and assertInfraMatchesBundle.
const infraUrls = new Set()
const infraSources = new Map()
const infraEdges = new Map()
// URLs the bundle=load load hook actually served, so the CJS shim can detect a require() that
// executed an attested file from DISK instead (a transplanted require.extensions handler, e.g.
// tsx's '.ts' pipeline, reads and compiles the file itself -- the load hook never fires).
const servedFromBundle = new Set()

// EXODUS_STASIS_PID = the root stasis's pid; on mismatch we're a child and must not write the
// bundle/lockfile (root owns the artifact; a 2nd writer races). A forked child also relaxes assertEntry.
const OWN_PID = String(process.pid)
process.env.EXODUS_STASIS_PID ||= OWN_PID
const isChildProcess = process.env.EXODUS_STASIS_PID !== OWN_PID
const forkedChild = isChildProcess && process.channel !== undefined

// stasis-core's own package root, so State's backfill captures edges loaded before our hooks registered.
const PRELOAD_ROOT = (() => {
  try {
    return dirname(findPackageJSON(import.meta.url))
  } catch {
    return undefined
  }
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

// nextLoad with `loadingModule` held, so the --fs hook skips the loader's own read of the source.
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

// Child-process capture forwarding (shards), opt-in via --child-process: a capturing child writes a
// signed per-pid shard the root verifies against its own public key before merging. Trust rests on
// that signature, not the dir being secret; shards carry NO bytes (the root re-reads from disk).

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
    // Sign the exact snapshot string, never a re-stringify, so verify is independent of JSON key
    // order; temp + rename so the merge never reads a half-written shard.
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
  } catch {
    // Best-effort: a child that can't snapshot/sign/write just doesn't contribute.
  }
}

// Cap shard count + size so a hostile/runaway set can't OOM the root.
const MAX_SHARDS = 4096
const MAX_SHARD_BYTES = 64 * 1024 * 1024

// Merge children's shards from `dir`: verify each envelope against our own PUBLIC key, not one from
// the filename. opendir streams the listing so memory stays bounded.
function mergeChildShards(dir) {
  let handle
  try { handle = opendirSync(dir) } catch { return }
  const prefix = `${createdShardPubId}-`
  let count = 0
  try {
    let dirent
    while ((dirent = handle.readSync()) !== null) {
      const name = dirent.name
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue
      if (++count > MAX_SHARDS) break
      const path = join(dir, name)
      try {
        if (statSync(path).size > MAX_SHARD_BYTES) continue
        const { shard, signature } = JSON.parse(readFileSync(path, 'utf-8'))
        if (typeof shard !== 'string' || typeof signature !== 'string') continue
        if (!verify(null, Buffer.from(shard), createdShardPub, Buffer.from(signature, 'base64url'))) continue
        state.mergeShard(shard)
      } catch {
        // A malformed/partial shard is skipped; the rest merge.
      }
    }
  } finally {
    try { handle.closeSync() } catch { /* best-effort */ }
  }
}

function initState(root) {
  state = new State(root, { preload: true, preloadRoot: PRELOAD_ROOT })

  // The --fs reader patches, installed AFTER stasis's own fs snapshots so they never redirect its own reads.
  if (state.config.fs) {
    installFsHooks({
      async: state.config.fs === 'async',
      getState: () => state,
      isLoadingModule: () => loadingModule > 0,
      // Warn on the first taint so the silent discard (reads succeed, exit 0, no artifact) has a clue.
      markAborted: (err) => {
        if (!aborted) console.warn(`[stasis] --fs: capture aborted, no bundle/lockfile will be written -- ${err?.message ?? err}`)
        aborted = true
      },
    })
  }

  // Root + opt-in only, before any child can fork: ALWAYS mint our own dir (OS tmpdir, mkdtemp 0700)
  // and keypair, overwriting any inherited/attacker-set env, so we merge only shards we can verify.
  if (!isChildProcess && shardForwardingEnabled()) {
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      createdShardDir = mkdtempSync(join(tmpdir(), 'stasis-shard-'))
      createdShardPub = publicKey
      createdShardPubId = publicKey.export({ format: 'jwk' }).x // base64url(raw public key)
      process.env.EXODUS_STASIS_SHARD_DIR = createdShardDir
      // Rides process.env so every transitive descendant inherits; do NOT scrub it downstream.
      process.env.EXODUS_STASIS_SHARD_KEY = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
    } catch {
      // Best-effort: clear any inherited (possibly attacker-set) dir/key so descendants don't fall
      // back to a channel we never minted.
      removeShardDir()
      createdShardDir = createdShardPub = createdShardPubId = undefined
      clearShardEnv()
    }
  } else if (!isChildProcess) {
    // Non-capturing root: shed any inherited (possibly attacker-set) shard env.
    clearShardEnv()
  }

  // Persist on exit unless `aborted` -- deliberately NOT gated on exit code, so a clean capture
  // exiting non-zero still persists. Must stay fully synchronous for `exit` to host it.
  const save = () => {
    // A child forwards a shard instead of writing the artifact (root owns it; a 2nd writer races).
    if (isChildProcess) {
      if (shardForwardingEnabled() && !aborted) writeChildShard()
      return
    }
    try {
      if (aborted) return
      if (createdShardDir) mergeChildShards(createdShardDir)
      // write() self-gates the artifact writes, but also VERIFIES in read-only frozen modes, so it
      // must run in every mode.
      state.write()
      // Latch only in write modes: a read-only run persists nothing, so a later first load (e.g. a
      // require() from another exit handler) is still attested and must not trip the load hook.
      if (state.config.writeLockfile || state.config.writeBundle) saved = true
    } finally {
      removeShardDir()
    }
  }

  // `exit` alone, NOT the beforeExit/exit pair: it runs after every beforeExit handler, so one flush
  // there sees strictly more. A process that never reaches `exit` writes nothing.
  process.on('exit', save)

  // config.shardSignalFlush (opt-in): flush a capturing CHILD's shard on SIGTERM (jest-worker's forceExit
  // bypasses `exit`), then re-deliver it unless user code owns SIGTERM (snapshotted at registration: a
  // `once` that already ran is invisible to listenerCount). Must fit forceExit's 500ms window.
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

// Init from the package root of `url` (the entry), exactly as its live load would.
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

  // Runner-infrastructure passthrough (see entryUnresolved): a preload's module graph loads
  // before the entry (or lazily after, from an infra parent). Stash the raw result so a later
  // app-graph edge can promote the module with the exact bytes that executed.
  if (entryUnresolved || infraUrls.has(url)) {
    infraUrls.add(url)
    const result = loadCounted(nextLoad, url, context)
    if (!infraSources.has(url)) infraSources.set(url, { source: result.source, format: result.format })
    return result
  }

  if (state?.config.loadBundle) {
    // node_modules scope serves only nm deps; gate on inNodeModules(), not a raw substring (symlinks).
    if (!inScope(state, url)) return nextLoad(url, context)
    const { source, format } = state.getFile(url)
    // Cross-check format only when the resolve chain set it (the formats map is attested at construction).
    // A transforming preload (`--import tsx`) asks for an attested '-typescript' file as its post-erasure
    // family: serve the chain's view then (the transformer above us turns the raw source into it).
    let serveFormat = format
    if (context.format != null) {
      if (context.format === erasedTypeScriptFormat(format)) serveFormat = context.format
      else assert.equal(format, context.format)
    }
    // Trust gate: only serve a file whose attested format Node can execute; everything else fails closed.
    if (!NODE_FORMATS.has(format)) refuseNonNodeFormat(format, url)
    servedFromBundle.add(url)
    // node:59666: a load-hook-supplied CJS source gets a re-invented require() missing .cache/.extensions.
    return { source: CJS_FORMATS.has(format) ? repairCjsRequire(source) : source, format: serveFormat, shortCircuit: true }
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

// Fold a runner-infrastructure module into the capture: the app graph reached a module the preload phase
// already executed, whose load hook can't re-fire (cached), so skipping it ships a dangling edge. addFile
// re-verifies the stashed bytes and its edges replay transitively; one never loaded is left to a live load.
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

// Under --bundle=load, an app edge landing on a module the preload phase already loaded means the
// CACHED disk-loaded instance shadows whatever the hooks would serve from the bundle: allowed
// only when the executed bytes and the attested bytes are identical, else fail closed.
function assertInfraMatchesBundle(url) {
  if (!infraUrls.has(url)) return
  const stashed = infraSources.get(url)
  if (stashed === undefined) { infraUrls.delete(url); return } // resolved but never loaded: the hooks will serve it
  const executed = toBuffer(sourceOrDisk(stashed.source, url))
  if (!executed.equals(toBuffer(state.getFile(url).source))) {
    throw new Error(
      `[stasis] cannot serve '${url}' from the bundle: a preload already executed it from disk ` +
      `before the entry, and those bytes differ from the attested ones -- refusing the divergent ` +
      `cached instance`
    )
  }
}

function resolve(specifier, context, nextResolve) {
  const { parentURL, conditions, importAttributes } = context
  // Runner-infrastructure passthrough (see entryUnresolved): a preload's graph resolves from a DIRECTORY
  // parent (never a loadable module, so it can't shadow an app parent) or an infra module; any other
  // pre-entry parent ([eval]'s import) fails closed below. Edges are remembered for promoteInfraUrl, not recorded.
  if (parentURL !== undefined && (infraUrls.has(parentURL) || (entryUnresolved && parentURL.endsWith('/')))) {
    const res = nextResolve(specifier)
    if (!res.url.startsWith('node:')) {
      infraUrls.add(res.url)
      if (infraUrls.has(parentURL)) {
        // Last-write-wins per specifier, like observeResolution: only the final target can be the
        // one a cached instance pins.
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
      && process.env.EXODUS_STASIS_SCOPE !== 'node_modules') {
    initState(process.cwd())
  }

  if (state?.config.loadBundle) {
    // nm scope defers non-nm parents to Node's resolver; gate on inNodeModules() to cover symlinks.
    if (!state.config.full && !(parentURL && state.inNodeModules(parentURL))) return nextResolve(specifier)
    // A bare specifier with a parent resolves from the recorded import map; otherwise skip
    // nextResolve so the entry needn't be on disk.
    let url
    let format
    if (parentURL && !specifier.startsWith('file:')) {
      ({ url, format } = state.getImport(parentURL, specifier, { conditions, importAttributes }))
    } else {
      url = specifier.startsWith('file:') ? specifier : pathToFileURL(resolvePath(process.cwd(), specifier)).toString()
      // A forked child's main module isn't a declared CLI entry, so skip assertEntry (getFile still
      // fails closed on anything unattested).
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
  // The app graph reached a module the preload phase already loaded: fold it (and transitively
  // its own graph) into the capture, since its load hook can never re-fire.
  if (infraUrls.has(url)) {
    if (infraSources.has(url)) {
      // The ENTRY itself was preloaded (a wrapper importing the app): init from its package root.
      if (!state) initStateFromPackage(url)
      const isEntry = !parentURL && entryUnseen
      if (isEntry) entryUnseen = false
      promoteInfraUrl(url, { isEntry })
    } else {
      // Resolved during the preload phase but never loaded: the app's own load will capture it.
      infraUrls.delete(url)
    }
  }
  // Parent-less = the entry: recorded via addFile/promotion above, never as an edge (addImport
  // requires a parent, and state can exist here after an entry promotion).
  if (state && parentURL) recording(() => state.addImport(parentURL, specifier, url, { conditions, format, importAttributes }))
  return res
}

let installed = false

// Exported so plugins.js can detect "under the stasis loader" before the lazy initState fires.
export function isLoaderInstalled() {
  return installed
}

// For plugins.js when a plugin constructor runs ahead of the load hook.
export function ensureStateForLoader() {
  if (!state) initState(process.cwd())
}

// Separate from the --import entry points so a host can compose setup before the hooks register.
export function install() {
  if (installed) return
  installed = true
  registerHooks({ load, resolve })
  patchCjsResolution()
  // The --fs reader patches are deferred to initState (their mode may come from stasis.config.json).
}

// registerHooks doesn't intercept the require() the ESM->CJS translator builds for a CJS module (it
// resolves through Module._resolveFilename against disk), so shim that to resolve from the import map.
function patchCjsResolution() {
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const loadMode = state?.config.loadBundle
    if (loadMode && typeof request === 'string' && !isBuiltin(request)) {
      if (typeof parent?.filename === 'string') {
        const parentURL = pathToFileURL(parent.filename).toString()
        if (inScope(state, parentURL)) {
          // Module._resolveFilename resolves for require(), whose target settles a divergent edge.
          const resolved = state.resolveBundled(parentURL, request, { conditions: ['require'] })
          if (resolved !== undefined) {
            assertInfraMatchesBundle(pathToFileURL(resolved).toString())
            return resolved
          }
        }
      } else if (isAbsolute(request)) {
        // NO parent, absolute request: Node's ESM<->CJS interop re-enters the CJS loader with hooks
        // SKIPPED, so only this shim intercepts. hasFsFileContent keeps a listing or stat record from
        // hijacking resolution. Node 24.14-24.17 hit this every commonjs-sync eval; >=24.18 still can.
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

  // Module._load's cache fast path can skip _resolveFilename, so force a repeat require() through our shim
  // to observe the edge. It is also the one spot seeing every ACTUAL CJS execution, hook-served or not, so it
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
      // A require() executes its target: remember it so write() can attest/verify anything the
      // load hook never saw, and fold in a module the preload phase already executed.
      state.observeExecution(resolvedUrl)
      promoteInfraUrl(resolvedUrl)
    }
    const result = originalLoad.call(this, request, parent, ...rest)
    // Under --bundle=load, an attested source the load hook never served just executed from DISK
    // (a transplanted require.extensions handler bypasses the hook chain): fail closed -- after
    // the fact, but before anything can trust the run.
    if (resolvedUrl !== undefined && state.config.loadBundle
        && !servedFromBundle.has(resolvedUrl) && state.isBundledSource(resolvedUrl)) {
      throw new Error(
        `[stasis] '${resolvedUrl}' executed from disk, bypassing the attested bundle -- a ` +
        `require() pipeline transplanted by a preload (e.g. tsx compiling CJS TypeScript) ` +
        `cannot serve bundle bytes and is refused under --bundle=load`
      )
    }
    return result
  }
}
