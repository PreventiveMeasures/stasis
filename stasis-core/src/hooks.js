import Module, { registerHooks, findPackageJSON, isBuiltin } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import * as fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

import { State } from './state.js'
import { excludedText } from './policy.js'
import { installFsHooks } from './fs.js'
import { inScope, sha512integrity } from './state-util.js'
import { GENERIC_FORMATS, NATIVE_BUILD_FORMATS, NODE_FORMATS, RESOURCE_FORMATS, SOURCE_LANGUAGE_FORMATS, STAT_FORMATS, erasedTypeScriptFormat, nestedMap, upsert } from './util.js'

// Snapshot off the namespace so `--fs` can't redirect stasis's own capture/shard reads.
const { mkdtempSync, opendirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = fs

const CJS_FORMATS = new Set(['commonjs', 'commonjs-typescript'])

function assertNodeFormat(format, url) {
  if (NODE_FORMATS.has(format)) return
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
  // With no format, as an older bundle carries the code Metro builds.
  if (format === undefined || GENERIC_FORMATS.has(format)) {
    const carried = format === undefined ? 'with no format' : `as '${format}'`
    throw new Error(`[stasis] cannot execute '${url}': the bundle carries it ${carried}, as it carries the code Metro builds from source, which is for Metro, not Node`)
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

const SHEBANG = /(?:#![^\n]*\n?)?/uy
const WS_COMMENTS = /(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/uy
const STRING_LITERAL = /(['"])(?:[^\\]|\\.)*?\1/uy
// Matches only single-line block comments: a newline-spanning one counts as a line boundary for ASI.
const TRAILING_SAME_LINE = /(?:[ \t]|\/\*(?:[^*\n\r\u2028\u2029]|\*(?!\/))*\*\/)*/uy
// These end a directive outright.
const SAME_LINE_END = /$|[;}]|\/\//uy
// A `/*` here spans a newline: like a line break it can end the directive.
const LINE_BREAK = /[\n\r\u2028\u2029]|\/\*/uy
// A directive string followed by one of these heads a multi-line expression, not a directive (ASI gotcha).
const CONTINUATION = /[.[(`+\-*/%,?:=<>&|^]|(?:instanceof|in)\b/uy
function matchEnd(re, source, i) {
  re.lastIndex = i
  return re.test(source) ? re.lastIndex : -1
}
function endsDirective(source, pos) {
  if (matchEnd(SAME_LINE_END, source, pos) !== -1) return true
  if (matchEnd(LINE_BREAK, source, pos) === -1) return false
  return matchEnd(CONTINUATION, source, matchEnd(WS_COMMENTS, source, pos)) === -1
}

// AFTER the Directive Prologue, with a leading ';': a `'use strict'` stays strict, a leading string EXPRESSION whole.
function repairCjsRequire(source) {
  if (typeof source !== 'string') return source
  let i = matchEnd(SHEBANG, source, 0)
  for (;;) {
    const afterStr = matchEnd(STRING_LITERAL, source, matchEnd(WS_COMMENTS, source, i))
    if (afterStr === -1 || !endsDirective(source, matchEnd(TRAILING_SAME_LINE, source, afterStr))) break
    i = afterStr
  }
  return `${source.slice(0, i)};${CJS_REQUIRE_REPAIR}${source.slice(i)}`
}

let state
// { dir, publicKey, pubId }: the root merges/removes ONLY a shard dir it minted and accepts ONLY shards signed under
// its own key.
let shardChannel
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
// The infrastructure graph passes both hooks unobserved; each URL it reaches (with what its load returned, once
// `loaded`) and its edges are kept for when the app reaches it.
const infra = new Map()
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

// Node's CJS loader may return source=null and read the file from disk itself.
const sourceOrDisk = (source, url) => source ?? readFileSync(fileURLToPath(url))

// --child-process: trust rests on a shard's signature under a key the root minted; shards carry NO bytes.
function shardForwardingEnabled() {
  return state.config.childProcess && (state.config.writeLockfile || state.config.writeBundle)
}

// A child's save: what it captured, as a shard the root merges.
function writeChildShard() {
  if (!shardForwardingEnabled() || aborted) return
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
function mergeChildShards({ dir, publicKey, pubId }) {
  let handle
  try { handle = opendirSync(dir) } catch { return }
  const prefix = `${pubId}-`
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
        if (!verify(null, Buffer.from(shard), publicKey, Buffer.from(signature, 'base64url'))) continue
        state.mergeShard(shard)
      } catch { /* a malformed/partial shard is skipped */ }
    }
  } finally {
    try { handle.closeSync() } catch { /* best-effort */ }
  }
}

// The root's save: the artifacts, with what its children forwarded.
function writeArtifacts() {
  try {
    if (aborted) return
    if (shardChannel) mergeChildShards(shardChannel)
    // In every mode: write() also VERIFIES in read-only frozen modes.
    state.write()
    // A read-only run persists nothing, so a later first load (another exit handler's) is still attested.
    if (state.config.writeLockfile || state.config.writeBundle) saved = true
  } finally {
    if (shardChannel) {
      try { rmSync(shardChannel.dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
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
  // Descendants must not fall back to an inherited channel we never minted, so it goes first.
  if (!isChildProcess) {
    delete process.env.EXODUS_STASIS_SHARD_DIR
    delete process.env.EXODUS_STASIS_SHARD_KEY
  }
  if (!isChildProcess && shardForwardingEnabled()) {
    try {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const pubId = publicKey.export({ format: 'jwk' }).x
      const key = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
      // Last, so no later throw leaves the dir behind.
      const dir = mkdtempSync(join(tmpdir(), 'stasis-shard-'))
      shardChannel = { dir, publicKey, pubId }
      process.env.EXODUS_STASIS_SHARD_DIR = dir
      // Rides process.env so every transitive descendant inherits; do NOT scrub it downstream.
      process.env.EXODUS_STASIS_SHARD_KEY = key
    } catch { /* no channel: a child forwards nothing */ }
  }

  // `exit` alone: it runs after every beforeExit handler, so one flush there sees strictly more. NOT gated on exit
  // code: a clean capture exiting non-zero still persists. Fully synchronous for `exit`.
  process.on('exit', isChildProcess ? writeChildShard : writeArtifacts)

  // jest-worker's forceExit bypasses `exit` (500ms window). SIGTERM is re-delivered unless user code owns it,
  // snapshotted now: a `once` that already ran is invisible to listenerCount.
  if (isChildProcess && shardForwardingEnabled() && state.config.shardSignalFlush) {
    const userOwnedSigterm = process.listenerCount('SIGTERM') > 0
    process.once('SIGTERM', () => {
      try {
        writeChildShard()
      } finally {
        if (!userOwnedSigterm && process.listenerCount('SIGTERM') === 0) process.kill(process.pid, 'SIGTERM')
      }
    })
  }

  // The addons a preload loaded before now are in the process whatever the app requires: each is held as the
  // preload loaded it, though its modules, runner infrastructure, are held only where the app reaches them.
  for (const [url, loaded] of unheldAddons) holdNativeAddon(url, loaded)
  unheldAddons.clear()
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
  if (entryUnresolved || infra.has(url)) {
    const reached = upsert(infra, url, () => ({}))
    const result = loadCounted(nextLoad, url, context)
    reached.loaded ??= { source: result.source, format: result.format }
    return result
  }

  if (state?.config.loadBundle) {
    if (!inScope(state, url)) return nextLoad(url, context)
    const { source, format } = state.getFile(url)
    // A transforming preload (`--import tsx`) asks for a '-typescript' file as its post-erasure family.
    if (context.format != null && context.format !== erasedTypeScriptFormat(format)) assert.equal(format, context.format)
    assertNodeFormat(format, url)
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

// The app reached a module a preload executed, whose load hook can't re-fire: else a dangling edge ships. One a
// preload only resolved leaves the graph: the app's own load captures it.
function promoteInfraUrl(url, resolvedAsEntry = false) {
  const loaded = infra.get(url)?.loaded
  infra.delete(url)
  if (loaded === undefined) return
  // The ENTRY itself was preloaded (a wrapper importing the app): init from its package root.
  if (!state) initStateFromPackage(url)
  const isEntry = resolvedAsEntry && entryUnseen
  if (isEntry) entryUnseen = false
  const source = sourceOrDisk(loaded.source, url)
  recording(() => state.addFile(url, { source, format: loaded.format ?? undefined, isEntry }))
  const edges = infraEdges.get(url)
  infraEdges.delete(url)
  for (const [specifier, edge] of edges ?? []) {
    recording(() => state.addImport(url, specifier, edge.url, edge.context))
    promoteInfraUrl(edge.url)
  }
}

// A preload's CACHED disk-loaded instance shadows what the hooks would serve: allowed only for identical bytes.
function assertInfraMatchesBundle(url) {
  const loaded = infra.get(url)?.loaded
  if (loaded === undefined) { infra.delete(url); return } // resolved but never loaded: the hooks will serve it
  const executed = Buffer.from(sourceOrDisk(loaded.source, url))
  if (!executed.equals(Buffer.from(state.getFile(url).source))) {
    throw new Error(`[stasis] cannot serve '${url}' from the bundle: a preload already executed it from disk ` +
      'before the entry, and those bytes differ from the attested ones -- refusing the divergent cached instance')
  }
}

// Saving attributes isn't supported yet: only `type: 'json'`, of a JSON module.
function assertImportAttributes(importAttributes, url) {
  if (importAttributes === undefined) return
  const expectedAttrs = Object.create(null)
  if (importAttributes.type && extname(new URL(url).pathname) === '.json') expectedAttrs.type = 'json'
  assert.deepStrictEqual(importAttributes, expectedAttrs)
}

const EXCLUDED = Symbol('excludeModules')

// Not `recording`: the program may catch the miss.
function missIfExcluded(specifier, parentURL, url, conditions) {
  const hit = state.excludedModule(url)
  if (hit === undefined) return
  const parent = parentURL.startsWith('file:') ? fileURLToPath(parentURL) : parentURL
  throw Object.assign(new Error(`Cannot find module '${specifier}' imported from ${parent} (${excludedText(hit)})`), { code: conditions.includes('require') ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND', [EXCLUDED]: true })
}

function resolve(specifier, context, nextResolve) {
  const { parentURL, conditions, importAttributes } = context
  // A DIRECTORY parent can't shadow an app parent; any other pre-entry parent ([eval]'s import) fails closed below.
  if (infra.has(parentURL) || (entryUnresolved && parentURL?.endsWith('/'))) {
    const res = nextResolve(specifier)
    if (!res.url.startsWith('node:')) {
      upsert(infra, res.url, () => ({}))
      if (infra.has(parentURL)) {
        // Last-write-wins: only the final target can be the one a cached instance pins.
        nestedMap(infraEdges, parentURL).set(specifier, { url: res.url, context: { conditions, format: res.format, importAttributes } })
      }
    }
    return res
  }
  if (!parentURL) entryUnresolved = false

  if (isBuiltin(specifier)) {
    const res = nextResolve(specifier)
    assert.equal(res.url, specifier.startsWith('node:') ? specifier : `node:${specifier}`)
    return res
  }

  // Full-scope load serves the entry from the bundle, so state must exist before nextResolve.
  if (!state && !parentURL && process.env.EXODUS_STASIS_BUNDLE === 'load'
      && process.env.EXODUS_STASIS_SCOPE !== 'node_modules') initState(process.cwd())

  const loadMode = state?.config.loadBundle
  // inScope's inNodeModules(), not a raw substring: a symlinked workspace source is read from disk.
  if (loadMode && (parentURL ? inScope(state, parentURL) : state.config.full)) {
    // The entry skips nextResolve, so it needn't be on disk.
    let url
    let format
    if (parentURL && !specifier.startsWith('file:')) {
      ({ url, format } = state.getImport(parentURL, specifier, { conditions, importAttributes }))
    } else {
      url = specifier.startsWith('file:') ? specifier : pathToFileURL(resolvePath(specifier)).toString()
      // Only full scope serves an entry. A forked child's main module isn't a declared CLI entry (getFile still fails closed).
      if (!parentURL && !forkedChild) state.assertEntry(url)
      format = state.getFormat(url)
    }
    assertImportAttributes(importAttributes, url)
    // Friendlier error at resolve time; the load gate is the load-bearing one. Metro's code resolves as a file of
    // no format did, its load refused. As does a native addon the bundle carries, which Node loads from disk by
    // its path, past the load hook: none is served.
    const unserved = GENERIC_FORMATS.has(format) || (RESOURCE_FORMATS.has(format) && extname(url) === '.node')
    if (format != null && !unserved) assertNodeFormat(format, url)
    assertInfraMatchesBundle(url)
    return { url, format: unserved ? undefined : format, importAttributes: undefined, shortCircuit: true }
  }

  const res = nextResolve(specifier)
  const { url, format } = res

  assertImportAttributes(importAttributes, url)
  if (!loadMode) assert.equal(res.importAttributes, undefined) // unsupported yet
  if (parentURL) assert.ok(state)
  if (parentURL) missIfExcluded(specifier, parentURL, url, conditions)
  // A load captures nothing.
  if (loadMode) return res
  promoteInfraUrl(url, !parentURL)
  // The entry is recorded by addFile/promotion, never as an edge.
  if (parentURL) recording(() => state.addImport(parentURL, specifier, url, { conditions, format, importAttributes }))
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
  patchDlopen()
  // The --fs patches wait for initState: their mode may come from stasis.config.json.
}

// The native addons loaded before the run had a State to hold them to, a preload's: each by the hash of its bytes
// then, which the process keeps loaded, whoever takes it next.
const unheldAddons = new Map()

// One the lockfile or the bundle attests is held to it (State's assertNativeAddon); `loaded` as it takes it.
function holdNativeAddon(url, loaded) {
  if (inScope(state, url)) recording(() => state.assertNativeAddon(url, loaded))
}

// Node loads a native addon from disk by its path, past both hooks: require()'s `.node` handler comes down to
// process.dlopen, as a call of it does. One the lockfile or the bundle attests is held to it before it runs, or
// where the run has no State yet (initState), as soon as it has.
function patchDlopen() {
  const original = process.dlopen
  process.dlopen = function dlopen(module, filename, ...rest) {
    // A bare name is one the system searches for, and no file of the project's.
    if (typeof filename === 'string' && basename(filename) !== filename) {
      const path = resolvePath(filename)
      const url = pathToFileURL(path).toString()
      if (state) {
        holdNativeAddon(url)
      } else if (!unheldAddons.has(url)) {
        try {
          unheldAddons.set(url, sha512integrity(readFileSync(path)))
        } catch { /* the load itself fails on it */ }
      }
    }
    return original.call(this, module, filename, ...rest)
  }
}

// registerHooks doesn't intercept the require() the ESM->CJS translator builds, which resolves against disk.
function patchCjsResolution() {
  const original = Module._resolveFilename
  Module._resolveFilename = function (request, parent, ...rest) {
    const loadMode = state?.config.loadBundle
    const watched = typeof request === 'string' && !isBuiltin(request)
    const parentURL = watched && typeof parent?.filename === 'string' ? pathToFileURL(parent.filename).toString() : undefined
    if (loadMode && watched) {
      if (parentURL !== undefined) {
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
    if (state && parentURL !== undefined && (!loadMode || state.config.policy?.excludesModules)) {
      const url = pathToFileURL(resolved).toString()
      // Not a preload's own require()s.
      if (isAbsolute(resolved) && !entryUnresolved && !infra.has(parentURL)) missIfExcluded(request, parentURL, url, ['require'])
      // Capture: require.resolve() and some CJS require()s never fire the resolve hook.
      if (!loadMode) state.observeResolution(parentURL, request, url)
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
      try {
        resolved = Module._resolveFilename(request, parent, ...rest)
      } catch (error) {
        // Else the cache fast path below can serve what a preload loaded. Any other: original _load raises it.
        if (error?.[EXCLUDED]) throw error
      }
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
