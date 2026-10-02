import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'

import { Lockfile } from './lockfile.js'
import { sha512integrity } from './state-util.js' // also runs the posix-sep assertion
import { hasNodeModulesSegment, isPathWithin, isPlainObject, moduleFileKey, posixPathEscapes, splitNodeModulesPath } from './util.js'

const LOCKFILE = 'stasis.lock.json'

// Fields copied (sanitised) from a dep's on-disk package.json; everything else is dropped as
// attack surface (scripts especially).
const ROOT_FIELD_ORDER = ['license', 'type', 'main', 'module', 'jsnext:main', 'jsnext', 'source', 'browser', 'react-native', 'bin', 'sideEffects', 'exports', 'imports']

function assertGlobalVirtualStoreDisabled() {
  // Global virtual store fills node_modules with symlinks, which prune skips -- lockfile-vs-disk goes blind.
  const env = process.env.npm_config_enable_global_virtual_store
  if (env !== undefined && env !== 'false' && env !== '') {
    throw new Error(`stasis prune: enableGlobalVirtualStore must be false, got ${JSON.stringify(env)}`)
  }
}

function loadLockfile(root) {
  const path = join(root, LOCKFILE)
  assert.ok(existsSync(path), `stasis prune: ${LOCKFILE} not found at ${path}`)
  return Lockfile.parse(readFileSync(path, 'utf8'))
}

// The file -> hash the lockfile expects under node_modules (workspace sources aren't pnpm-managed),
// and the bucket dirs it knows.
function buildExpected(lockfile) {
  const expected = new Map()
  const knownDirs = new Set()
  for (const [dir, { files }] of lockfile.modules) {
    if (!hasNodeModulesSegment(dir)) continue
    knownDirs.add(dir)
    for (const [rel, hash] of Object.entries(files)) {
      // moduleFileKey, not `${dir}/${rel}`: a root capture's rel === '' would demand a file at `<pkg>/`.
      const file = moduleFileKey(dir, rel)
      // A `directory` entry is an attested listing, not a file on disk; demanding one would fail "missing on disk".
      if (lockfile.formats?.get(file) === 'directory') continue
      expected.set(file, hash)
    }
  }
  return { expected, knownDirs }
}

// A rewritten manifest must never point resolution at a path prune is about to delete.
const EXTENSIONS = ['.js', '.cjs', '.mjs', '.json', '.node']

function normalizeRef(ref) {
  if (typeof ref !== 'string' || ref === '' || posixPathEscapes(ref)) return null
  return posix.normalize(ref).replace(/^\.\//u, '')
}

function referencesPresentFile(ref, present, { exact = false } = {}) {
  const base = normalizeRef(ref)
  if (base === null) return false
  if (base.includes('*')) return true // subpath pattern: unverifiable, kept
  if (present.has(base)) return true
  if (exact) return false // exports/imports targets resolve verbatim -- no extension/index fallback
  return EXTENSIONS.some((ext) => present.has(base + ext) || present.has(`${base}/index${ext}`))
}

// Cap the recursion; real exports/imports trees nest a few deep and a deep one must not overflow.
const MAX_TARGET_DEPTH = 64

// Filter a target tree to attested files. An object/array filtering to empty is dropped:
// `exports: {}` would block every subpath instead of `main`.
function filterTargets(value, present, opts, depth = 0) {
  if (depth > MAX_TARGET_DEPTH) return { keep: false }
  const { allowBare, allowFalse, exact } = opts
  if (value === null) return { keep: true, value: null }
  if (value === false) return allowFalse ? { keep: true, value: false } : { keep: false }
  if (typeof value === 'string') {
    const keep = value.startsWith('.') ? referencesPresentFile(value, present, { exact }) : allowBare
    return keep ? { keep: true, value } : { keep: false }
  }
  if (Array.isArray(value)) {
    const out = []
    for (const item of value) {
      const r = filterTargets(item, present, opts, depth + 1)
      if (r.keep) out.push(r.value)
    }
    return out.length > 0 ? { keep: true, value: out } : { keep: false }
  }
  if (isPlainObject(value)) {
    const out = {}
    let any = false
    for (const [k, v] of Object.entries(value)) {
      const r = filterTargets(v, present, opts, depth + 1)
      if (r.keep) {
        out[k] = r.value
        any = true
      }
    }
    return any ? { keep: true, value: out } : { keep: false }
  }
  return { keep: false }
}

// Printable ASCII only, so a copied `license` can't smuggle control or escape characters.
const isAscii = (s) => /^[\x20-\x7e]*$/u.test(s)

// `browser`/`react-native`: a string, or a map to replacements/`false`. undefined means drop the field.
function browserField(value, present) {
  if (typeof value === 'string') return referencesPresentFile(value, present) ? value : undefined
  if (!isPlainObject(value)) return undefined
  const r = filterTargets(value, present, { allowBare: true, allowFalse: true, exact: false })
  return r.keep ? r.value : undefined
}

// Resolution fields (`type`, entry points, exports/imports), every file reference filtered to an attested file.
function resolutionFields(pkg, present) {
  const out = { __proto__: null }
  // Only the values Node honours; a garbage `type` is dropped rather than recategorising the package's .js files.
  if (pkg.type === 'module' || pkg.type === 'commonjs') out.type = pkg.type
  // Bundler `mainFields` entries too: dropping jsnext/jsnext:main downgrades an older dep ESM->CJS under Vite.
  for (const field of ['main', 'module', 'jsnext:main', 'jsnext', 'source']) {
    if (referencesPresentFile(pkg[field], present)) out[field] = pkg[field]
  }
  for (const field of ['browser', 'react-native']) {
    const v = browserField(pkg[field], present)
    if (v !== undefined) out[field] = v
  }
  const exp = filterTargets(pkg.exports, present, { allowBare: false, allowFalse: false, exact: true })
  if (exp.keep) out.exports = exp.value
  const imp = filterTargets(pkg.imports, present, { allowBare: true, allowFalse: false, exact: true })
  if (imp.keep) out.imports = imp.value
  return out
}

// On-disk `pkg` is untrusted: every copied field needs its own guard. name/version come from the lockfile.
function minimalRootFields(pkg, { name, version, present }) {
  const fields = resolutionFields(pkg, present)

  if (typeof pkg.license === 'string' && isAscii(pkg.license) && Buffer.byteLength(pkg.license) < 64) {
    fields.license = pkg.license
  }

  if (typeof pkg.bin === 'string') {
    if (referencesPresentFile(pkg.bin, present)) fields.bin = pkg.bin
  } else if (isPlainObject(pkg.bin)) {
    const bin = {}
    let any = false
    for (const [cmd, target] of Object.entries(pkg.bin)) {
      if (typeof target === 'string' && referencesPresentFile(target, present)) {
        bin[cmd] = target
        any = true
      }
    }
    if (any) fields.bin = bin
  }

  // A sideEffects list filtering to empty is dropped: `[]` would assert "no side effects" and over-tree-shake.
  if (typeof pkg.sideEffects === 'boolean') {
    fields.sideEffects = pkg.sideEffects
  } else if (Array.isArray(pkg.sideEffects)) {
    const se = pkg.sideEffects.filter((e) => referencesPresentFile(e, present))
    if (se.length > 0) fields.sideEffects = se
  }

  const out = { name, version }
  for (const key of ROOT_FIELD_ORDER) if (key in fields) out[key] = fields[key]
  return out
}

// The minimal manifest for a known module's package.json at `rel`, root or nested: a nested one's refs
// are relative to its own dir, so the recorded files are re-based first, and it survives because it
// flips its subtree's module system (dropping it would revert those .js files to the root's).
function minimalManifest(lockfile, owner, rel, raw) {
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  const pkg = isPlainObject(parsed) ? parsed : {}
  const { name, version, files } = lockfile.modules.get(owner.dir)
  // The package.json itself survives prune, so it's always a legal self-reference target.
  const present = new Set(['package.json'])
  if (dirname(rel) === owner.dir) {
    for (const f of Object.keys(files)) present.add(f)
    return minimalRootFields(pkg, { name, version, present })
  }
  const prefix = `${relative(owner.dir, dirname(rel))}/`
  for (const f of Object.keys(files)) if (f.startsWith(prefix)) present.add(f.slice(prefix.length))
  return resolutionFields(pkg, present)
}

// In a workspace the symlink-containment boundary widens from node_modules to the whole workspace,
// since a dep legitimately links to a sibling package's source dir.
const isPnpmWorkspaceRoot = (root) => existsSync(join(root, 'pnpm-workspace.yaml'))

function discoverNodeModulesDirs(root) {
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.name === 'node_modules') {
        // A symlinked node_modules is skipped; if the lockfile records files under it, prune fails closed.
        if (entry.isDirectory()) found.push(full)
        continue // don't descend; prune walks node_modules internals itself
      }
      if (entry.isDirectory()) stack.push(full)
    }
  }
  return found
}

// A symlink survives prune only if its real target stays inside `boundary`. A dangling link can't leak,
// so ENOENT returns instead of throwing -- deliberately NOT the loaders' assertRealPathWithinBase.
function assertSymlinkInternal({ root, realBoundary, label }, linkPath) {
  let real
  try {
    real = realpathSync(linkPath)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (!isPathWithin(realBoundary, real)) {
    throw new Error(`stasis prune: symlink escapes ${label}: ${relative(root, linkPath)} -> ${real}`)
  }
}

// Every regular file under the node_modules roots, tagged with its root so deletion and empty-dir
// pruning stay scoped to it. Symlinks are checked, never followed.
function* walkFiles(nmRoots, ctx) {
  for (const nmRoot of nmRoots) {
    if (!existsSync(nmRoot)) continue
    const stack = [nmRoot]
    while (stack.length > 0) {
      const dir = stack.pop()
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isSymbolicLink()) assertSymlinkInternal(ctx, full)
        else if (entry.isDirectory()) stack.push(full)
        else if (entry.isFile()) yield { full, nmRoot }
      }
    }
  }
}

function pruneEmptyDirs(dir, stopAt) {
  while (dir.startsWith(stopAt) && dir !== stopAt && existsSync(dir)) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    if (entries.length > 0) return
    try {
      rmdirSync(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

export function prune({ root = process.cwd() } = {}) {
  assertGlobalVirtualStoreDisabled()
  root = resolve(root)
  const workspace = isPnpmWorkspaceRoot(root)
  const nmRoots = workspace ? discoverNodeModulesDirs(root) : [join(root, 'node_modules')]
  const boundary = workspace ? root : join(root, 'node_modules')
  const ctx = {
    root,
    realBoundary: existsSync(boundary) ? realpathSync(boundary) : boundary,
    label: workspace ? 'the workspace' : 'node_modules',
  }
  const lockfile = loadLockfile(root)
  const { expected, knownDirs } = buildExpected(lockfile)

  // Plan first, mutate later: any failure throws before anything on disk is touched.
  const toRemove = []
  const toMinimize = []
  const validated = []
  const kept = []
  const seen = new Set()
  const mismatches = []

  for (const { full, nmRoot } of walkFiles(nmRoots, ctx)) {
    const rel = relative(root, full)
    const expectedHash = expected.get(rel)
    if (expectedHash !== undefined) {
      seen.add(rel)
      const actual = sha512integrity(readFileSync(full))
      if (actual === expectedHash) {
        validated.push(rel)
        kept.push(rel)
      } else {
        mismatches.push({ rel, expected: expectedHash, actual })
      }
      continue
    }

    // package.json isn't lockfile-enumerated but drives resolution, so rewrite (not delete) it for a known module.
    const owner = basename(rel) === 'package.json' ? splitNodeModulesPath(rel) : null
    if (owner && knownDirs.has(owner.dir)) {
      const raw = readFileSync(full, 'utf8')
      const text = `${JSON.stringify(minimalManifest(lockfile, owner, rel, raw), undefined, 2)}\n`
      kept.push(rel)
      if (text !== raw) toMinimize.push({ full, rel, text })
      continue
    }

    // Defense-in-depth: the walk should already guarantee this.
    assert.ok(full.startsWith(`${nmRoot}${sep}`), `refusing to remove path outside node_modules: ${full}`)
    toRemove.push({ full, nmRoot })
  }

  const missing = [...expected.keys()].filter((rel) => !seen.has(rel))
  if (mismatches.length > 0) {
    const lines = mismatches.map(({ rel, expected: exp, actual }) =>
      `  ${rel}: expected ${exp}, got ${actual}`).join('\n')
    throw new Error(`stasis prune: hash mismatch for ${mismatches.length} file(s):\n${lines}`)
  }
  if (missing.length > 0) {
    const sample = missing.slice(0, 5).join(', ')
    const suffix = missing.length > 5 ? `, ... (${missing.length} total)` : ''
    throw new Error(`stasis prune: files listed in lockfile are missing on disk: ${sample}${suffix}`)
  }

  const minimized = []
  for (const [i, { full, rel, text }] of toMinimize.entries()) {
    // Write+rename, never in place: a dep's package.json is often a hardlink into pnpm's store (shared inode).
    const tmp = `${full}.stasis-${process.pid}-${i}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, full)
    minimized.push(rel)
  }

  const removed = []
  const touchedDirs = new Map() // dir -> the node_modules root under it (prune stops there)
  for (const { full, nmRoot } of toRemove) {
    unlinkSync(full)
    removed.push(relative(root, full))
    touchedDirs.set(dirname(full), nmRoot)
  }
  for (const d of [...touchedDirs.keys()].toSorted((a, b) => b.length - a.length)) pruneEmptyDirs(d, touchedDirs.get(d))

  return { removed, validated, kept, minimized }
}
