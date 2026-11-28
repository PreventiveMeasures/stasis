import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path'

import { Lockfile } from './lockfile.js'
import { sha512integrity } from './state-util.js' // also runs the posix-sep assertion
import { hasNodeModulesSegment, isPathWithin, isPlainObject, LOCK_FILE, moduleFileKey, posixPathEscapes, splitNodeModulesPath } from './util.js'

// Under node_modules alone: workspace sources aren't pnpm-managed.
function buildExpected(lockfile) {
  const expected = new Map()
  for (const [dir, { files }] of lockfile.modules) {
    if (!hasNodeModulesSegment(dir)) continue
    for (const [rel, hash] of Object.entries(files)) {
      // A root capture's rel === '' would demand a file at `<pkg>/`.
      const file = moduleFileKey(dir, rel)
      // An attested listing, not a file on disk.
      if (lockfile.formats?.get(file) !== 'directory') expected.set(file, hash)
    }
  }
  return expected
}

// A rewritten manifest must never point resolution at a path prune is about to delete.
const EXTENSIONS = ['.js', '.cjs', '.mjs', '.json', '.node']

function referencesPresentFile(ref, present, exact = false) {
  if (typeof ref !== 'string' || ref === '' || posixPathEscapes(ref)) return false
  const base = posix.normalize(ref).replace(/^\.\//u, '')
  if (base.includes('*')) return true // subpath pattern: unverifiable, kept
  if (present.has(base)) return true
  if (exact) return false // exports/imports targets resolve verbatim -- no extension/index fallback
  return EXTENSIONS.some((ext) => present.has(base + ext) || present.has(`${base}/index${ext}`))
}

const fileRef = (value, present) => (referencesPresentFile(value, present) ? value : undefined)

function filterEntries(obj, map) {
  const out = {}
  let any = false
  for (const [key, value] of Object.entries(obj)) {
    const kept = map(value)
    if (kept !== undefined) {
      out[key] = kept
      any = true
    }
  }
  return any ? out : undefined
}

// Real exports/imports trees nest a few deep, and a deep one must not overflow.
const MAX_TARGET_DEPTH = 64

// An object/array filtering to empty is dropped: `exports: {}` would block every subpath instead of `main`.
function filterTargets(value, present, opts, depth = 0) {
  if (depth > MAX_TARGET_DEPTH) return undefined
  const { allowBare, allowFalse, exact } = opts
  if (value === null) return null
  if (value === false) return allowFalse ? false : undefined
  if (typeof value === 'string') {
    const keep = value.startsWith('.') ? referencesPresentFile(value, present, exact) : allowBare
    return keep ? value : undefined
  }
  if (Array.isArray(value)) {
    const out = value.map((item) => filterTargets(item, present, opts, depth + 1)).filter((item) => item !== undefined)
    return out.length > 0 ? out : undefined
  }
  if (isPlainObject(value)) return filterEntries(value, (target) => filterTargets(target, present, opts, depth + 1))
  return undefined
}

// A file, or an object of them as `keepObject` keeps it (bin's commands, browser's replacements).
const fileOrObject = (keepObject) => (value, present) => {
  if (typeof value === 'string') return fileRef(value, present)
  return isPlainObject(value) ? keepObject(value, present) : undefined
}
const browserField = fileOrObject((value, present) => filterTargets(value, present, { allowBare: true, allowFalse: true, exact: false }))

// Fields copied (sanitised) from a dep's on-disk package.json, in this order; everything else is dropped as attack
// surface. On-disk `pkg` is untrusted: every copied field has its own guard, answering what it keeps or undefined.
const FIELDS = {
  // Printable ASCII only, so a copied `license` can't smuggle control or escape characters.
  license: (value) => (typeof value === 'string' && /^[\x20-\x7e]*$/u.test(value) && Buffer.byteLength(value) < 64 ? value : undefined),
  // Only the values Node honours; a garbage `type` is dropped rather than recategorising the package's .js files.
  type: (value) => (value === 'module' || value === 'commonjs' ? value : undefined),
  // Bundler `mainFields` entries too: dropping jsnext/jsnext:main downgrades an older dep ESM->CJS under Vite.
  main: fileRef,
  module: fileRef,
  'jsnext:main': fileRef,
  jsnext: fileRef,
  source: fileRef,
  browser: browserField,
  'react-native': browserField,
  bin: fileOrObject((value, present) => filterEntries(value, (target) => fileRef(target, present))),
  // A list filtering to empty is dropped: `[]` would assert "no side effects" and over-tree-shake.
  sideEffects: (value, present) => {
    if (typeof value === 'boolean') return value
    const kept = Array.isArray(value) ? value.filter((entry) => referencesPresentFile(entry, present)) : []
    return kept.length > 0 ? kept : undefined
  },
  exports: (value, present) => filterTargets(value, present, { allowBare: false, allowFalse: false, exact: true }),
  imports: (value, present) => filterTargets(value, present, { allowBare: true, allowFalse: false, exact: true }),
}
// A nested package.json keeps only what resolution reads.
const ROOT_ONLY = new Set(['license', 'bin', 'sideEffects'])

// A nested one's refs are relative to its own dir, so the recorded files are re-based first; it survives because
// it flips its subtree's module system (dropping it would revert those .js files to the root's).
function minimalManifest(lockfile, owner, rel, raw) {
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = null }
  const pkg = isPlainObject(parsed) ? parsed : {}
  const { name, version, files } = lockfile.modules.get(owner.dir)
  const root = dirname(rel) === owner.dir
  const prefix = root ? '' : `${relative(owner.dir, dirname(rel))}/`
  const present = new Set(Object.keys(files).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length)))
  // The package.json itself survives prune, so it's always a legal self-reference target.
  present.add('package.json')
  // name/version come from the lockfile.
  const out = root ? { name, version } : {}
  for (const [field, keep] of Object.entries(FIELDS)) {
    if (!root && ROOT_ONLY.has(field)) continue
    const value = keep(pkg[field], present)
    if (value !== undefined) out[field] = value
  }
  return out
}

// Depth-first in readdir order, each entry but a directory `descend` takes, walked instead (`lenient`: or passed
// over if it can't be read).
function* walk(root, descend, lenient = false) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (!lenient) throw err
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && descend(entry)) stack.push(full)
      else yield { entry, full }
    }
  }
}

// A symlinked node_modules is skipped (prune fails closed on files the lockfile records there); none is descended.
const nodeModulesDirs = (root) => walk(root, ({ name }) => !name.startsWith('.') && name !== 'node_modules', true)
  .filter(({ entry }) => entry.name === 'node_modules' && entry.isDirectory()).map(({ full }) => full).toArray()

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
  if (!isPathWithin(realBoundary, real)) throw new Error(`stasis prune: symlink escapes ${label}: ${relative(root, linkPath)} -> ${real}`)
}

// Tagged with its root so deletion and empty-dir pruning stay scoped to it. Symlinks are checked, never followed.
function* walkFiles(nmRoots, ctx) {
  for (const nmRoot of nmRoots) {
    if (!existsSync(nmRoot)) continue
    for (const { entry, full } of walk(nmRoot, () => true)) {
      if (entry.isSymbolicLink()) assertSymlinkInternal(ctx, full)
      else if (entry.isFile()) yield { full, nmRoot }
    }
  }
}

function pruneEmptyDirs(dir, stopAt) {
  while (dir.startsWith(stopAt) && dir !== stopAt) {
    try {
      if (readdirSync(dir).length > 0) return
      rmdirSync(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

export function prune({ root = process.cwd() } = {}) {
  // Global virtual store fills node_modules with symlinks, which prune skips -- lockfile-vs-disk goes blind.
  const store = process.env.npm_config_enable_global_virtual_store
  if (store !== undefined && store !== 'false' && store !== '') {
    throw new Error(`stasis prune: enableGlobalVirtualStore must be false, got ${JSON.stringify(store)}`)
  }
  root = resolve(root)
  // In a workspace a dep legitimately links to a sibling package's source dir, so the boundary widens to it.
  const workspace = existsSync(join(root, 'pnpm-workspace.yaml'))
  const nmRoots = workspace ? nodeModulesDirs(root) : [join(root, 'node_modules')]
  const boundary = workspace ? root : join(root, 'node_modules')
  const ctx = {
    root,
    realBoundary: existsSync(boundary) ? realpathSync(boundary) : boundary,
    label: workspace ? 'the workspace' : 'node_modules',
  }
  const lockPath = join(root, LOCK_FILE)
  assert.ok(existsSync(lockPath), `stasis prune: ${LOCK_FILE} not found at ${lockPath}`)
  const lockfile = Lockfile.parse(readFileSync(lockPath, 'utf8'))
  const expected = buildExpected(lockfile)

  // Plan first, mutate later: any failure throws before anything on disk is touched.
  const toRemove = []
  const toMinimize = []
  const validated = []
  const kept = []
  const mismatches = []

  for (const { full, nmRoot } of walkFiles(nmRoots, ctx)) {
    const rel = relative(root, full)
    const expectedHash = expected.get(rel)
    if (expectedHash !== undefined) {
      expected.delete(rel) // what is left was never found
      const actual = sha512integrity(readFileSync(full))
      if (actual === expectedHash) {
        validated.push(rel)
        kept.push(rel)
      } else {
        mismatches.push(`  ${rel}: expected ${expectedHash}, got ${actual}`)
      }
      continue
    }

    // package.json isn't lockfile-enumerated but drives resolution, so rewrite (not delete) it for a known module.
    const owner = basename(rel) === 'package.json' ? splitNodeModulesPath(rel) : null
    if (owner && lockfile.modules.has(owner.dir)) {
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

  if (mismatches.length > 0) throw new Error(`stasis prune: hash mismatch for ${mismatches.length} file(s):\n${mismatches.join('\n')}`)
  const missing = [...expected.keys()]
  if (missing.length > 0) {
    const sample = missing.slice(0, 5).join(', ')
    const suffix = missing.length > 5 ? `, ... (${missing.length} total)` : ''
    throw new Error(`stasis prune: files listed in lockfile are missing on disk: ${sample}${suffix}`)
  }

  for (const [i, { full, text }] of toMinimize.entries()) {
    // Write+rename, never in place: a dep's package.json is often a hardlink into pnpm's store (shared inode).
    const tmp = `${full}.stasis-${process.pid}-${i}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, full)
  }

  const touchedDirs = new Map() // dir -> the node_modules root under it (prune stops there)
  for (const { full, nmRoot } of toRemove) {
    unlinkSync(full)
    touchedDirs.set(dirname(full), nmRoot)
  }
  for (const [dir, nmRoot] of [...touchedDirs].toSorted(([a], [b]) => b.length - a.length)) pruneEmptyDirs(dir, nmRoot)

  return { removed: toRemove.map(({ full }) => relative(root, full)), validated, kept, minimized: toMinimize.map(({ rel }) => rel) }
}
