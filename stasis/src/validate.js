import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join, parse as parsePath, posix, relative, sep } from 'node:path'

import { CONFIG_FILE, EMPTY_MODULE_PATH, archiveIntegrity, assertAttested, attestedOf, dependencyEcosystem, hasNodeModulesSegment, integrityHex, isStatFormat, LOCK_FILE, memoized, moduleFileKey, parseLockfilesOption, sha512Of, upsert, withoutBom } from '@exodus/stasis-core/util'
import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { getCrate } from '@preventive/upstream/cargo.js'
import { HttpError, getTarball } from '@preventive/upstream/npm.js'
import { parseCargoChecksum, parseCargoLock } from '@preventive/lockfile/cargo.js'
import { parseComposerLock } from '@preventive/lockfile/composer.js'
import { parseNpmLockfile } from '@preventive/lockfile/npm.js'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseSoldeerLockfile } from '@preventive/lockfile/soldeer.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'
import { createVfs } from '@preventive/vfs'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { bundledIntegrity, sha512integrity } from '@exodus/stasis-core/state-util'

import { isPatchOf, nameAt, patchHashes, STORE_HASH, resolutionCommit } from './installed.js'
import { findCargoLock } from './loaders/cargo.js'
import { parseFileWithKind } from './parse.js'
import { DIM, formatTable, painter } from './table.js'
import { FILE_REASONS, LOCKFILE_ERRORS, OWN_REASONS, generatedBy, noteText } from './validate-notes.js'
import { lockfileOf, lockfileRoot, vfsHost } from './vfs-bundle/tree.js'

export const MAX_TOLD = 500
const PACKAGES_AT_ONCE = 6
// As patch-package looks for a hunk, this many lines either side of where its header says.
const FUZZ = 20
// As upstream's tree verification bounds a tarball.
const MAX_TAR_BYTES = 2 ** 30
// What `cargo vendor` writes beside a vendored crate, which no crate holds: held to the crate (checksumOf).
const CARGO_CHECKSUM = '.cargo-checksum.json'
const EMPTY_INTEGRITY = sha512integrity(new Uint8Array())

const utf8 = new TextEncoder()
// A BOM kept, as patch-package keeps it: a patch applied changes no byte but those its hunks change.
const asText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export class PatchError extends Error {
  constructor(code) {
    super(code)
    this.name = 'PatchError'
    this.code = code
  }
}

export class ValidateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ValidateError'
    this.code = code
  }
}

const unreadableLockfile = (path, error) => new ValidateError('lockfile-unreadable', `${path}: ${error.message}`)
const readLockfileText = (read, path) => Promise.try(read, path).catch((error) => {
  throw unreadableLockfile(path, error)
})

// A workspace package outside node_modules is own code, though a bundle built before only dependencies were tagged tags it npm.
const moduleEcosystem = (dir, ecosystem) => (dir === '.' || (ecosystem === 'npm' && !hasNodeModulesSegment(dir)) ? undefined : dependencyEcosystem(dir, ecosystem))

export function validationPlan(bundle, { lockfile = false } = {}) {
  const formats = bundle.formats ?? new Map()
  const own = []
  const patches = new Map()
  const packages = new Map()
  for (const [dir, info] of bundle.modules) {
    const ecosystem = moduleEcosystem(dir, info.ecosystem)
    const key = `${ecosystem}\0${info.name ?? ''}\0${info.version ?? ''}`
    for (const [rel, content] of Object.entries(info.files)) {
      const path = moduleFileKey(dir, rel)
      const format = formats.get(path)
      if (typeof content !== 'string' || format === 'directory' || isStatFormat(format)) continue
      if (lockfile && rel === CARGO_CHECKSUM && ecosystem === 'cargo') continue
      const file = lockfile ? { path, dir, rel, format, integrity: content } : { path, dir, rel, format, bytes: () => (format === 'resource:base64' ? Buffer.from(content, 'base64') : utf8.encode(content)) }
      if (ecosystem !== undefined) {
        if (!packages.has(key)) packages.set(key, { ecosystem, name: info.name ?? '', version: info.version ?? '', files: [], recorded: new Map(), patchFiles: new Map(), integrities: new Map(), repos: new Map() })
        packages.get(key).files.push(file)
      } else if (path !== EMPTY_MODULE_PATH || content !== (lockfile ? EMPTY_INTEGRITY : '')) {
        if (!lockfile && (format === 'patch' || path.endsWith('.patch'))) patches.set(path, content)
        own.push(file)
      }
    }
    const pkg = packages.get(key)
    if (pkg === undefined) continue
    // In hex, as pnpm's and Cargo's lockfiles spell them.
    if (info.patch) pkg.recorded.set(dir, integrityHex(info.patch.integrity))
    if (info.patch?.file) pkg.patchFiles.set(dir, info.patch.file)
    if (info.integrity) pkg.integrities.set(dir, ecosystem === 'cargo' ? integrityHex(info.integrity) : info.integrity)
    if (info.repo) pkg.repos.set(dir, info.repo)
  }
  const listed = [...packages.values()]
  return { files: listed.reduce((sum, pkg) => sum + pkg.files.length, own.length), own, packages: listed, patches }
}

export const gitBlobId = (bytes) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')

// Its one top directory left out, as npm unpacks a package (crates.io's crates and GitHub's trees have one too).
export async function tarballFiles(tarball) {
  const files = new Map()
  for (const entry of unpack(await decompress(tarball, 'gzip', { limit: MAX_TAR_BYTES }), { symlinksAbove: Number.MAX_SAFE_INTEGER })) {
    const name = entry.name.slice(entry.name.indexOf('/') + 1)
    if (!entry.name.includes('/') || name === '' || entry.type === 'directory') continue
    files.set(name, entry.type === 'symlink' ? { symlink: entry.linkname } : entry.data)
  }
  return files
}

export const FETCHED = new Set(['npm', 'cargo'])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const tarballPath = (name, version) => `/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
// With `integrity`, upstream refuses a tarball other than the one it locks.
export async function fetchPackage(ecosystem, name, version, integrity) {
  const tarball = ecosystem === 'npm'
    ? await getTarball(name, version, integrity === undefined ? undefined : { tarball: `https://registry.npmjs.org${tarballPath(name, version)}`, integrity })
    : await getCrate(name, version, integrity)
  const files = new Map([...await tarballFiles(tarball)].filter(([, data]) => data instanceof Uint8Array))
  if (ecosystem === 'cargo') files.checksum = integrity ?? sha256(tarball)
  return files
}

function checksumOf(bytes, crate) {
  let parsed
  try {
    parsed = parseCargoChecksum(asText.decode(bytes))
  } catch {
    return false
  }
  return (crate.checksum === undefined || parsed.checksum === crate.checksum)
    && Object.entries(parsed.files).every(([path, listed]) => crate.has(path) && sha256(crate.get(path)) === listed)
}

// Re-exported for a caller's `fetch` to throw, as fetchFailure reads it.
export { HttpError }
export function fetchFailure(error) {
  if (error instanceof HttpError) return error.status === 404 ? 'not-published' : [401, 403].includes(error.status) ? 'unreadable' : 'failed'
  if (error?.code === 'ERR_ASSERTION' && /integrity mismatch/u.test(error.message)) return 'integrity-mismatch'
  return 'failed'
}

export { isPatchOf }

// git quotes a path as C writes a string, bytes past ASCII in octal; null where it is quoted otherwise.
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
function unquoted(path) {
  if (!path.startsWith('"')) return path
  const bytes = []
  for (let at = 1; at < path.length; at++) {
    const char = path[at]
    if (char === '"') return at === path.length - 1 ? asText.decode(Uint8Array.from(bytes)) : null
    if (char !== '\\') {
      bytes.push(...utf8.encode(char))
      continue
    }
    const next = path[++at] ?? ''
    const octal = /^[0-3][0-7]{2}/u.exec(path.slice(at))?.[0]
    if (octal) {
      bytes.push(Number.parseInt(octal, 8))
      at += 2
    } else if (Object.hasOwn(ESCAPES, next)) bytes.push(ESCAPES[next])
    else return null
  }
  return null
}

const unreadable = () => new PatchError('patch-unreadable')
const inPackage = (path) => path.length > 0 && path.split('/').every((name) => name !== '' && name !== '.' && name !== '..')

// git writes a tab after a path with a space in it.
function sidePath(named, prefix) {
  const path = unquoted(named.endsWith('\t') ? named.slice(0, -1) : named)
  if (path === '/dev/null') return null
  if (path === null || !path.startsWith(prefix)) throw unreadable()
  return path.slice(prefix.length)
}

function gitPath(named) {
  if (named.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/u.exec(named)
    const [a, b] = quoted ? [unquoted(quoted[1]), unquoted(quoted[2])] : []
    return a?.startsWith('a/') && b?.startsWith('b/') && a.slice(2) === b.slice(2) ? a.slice(2) : null
  }
  const length = (named.length - 5) / 2
  const path = named.slice(2, 2 + length)
  return Number.isInteger(length) && named.startsWith('a/') && named.slice(2 + length) === ` b/${path}` ? path : null
}

function readHunk(lines, start, end) {
  let at = start
  const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[at++])
  if (!range) throw unreadable()
  let news = Number(range[4] ?? 1)
  let olds = Number(range[2] ?? 1)
  const hunk = { at: Math.max(Number(range[1]), 1) - 1, length: olds, parts: [] }
  while (olds > 0 || news > 0) {
    if (at >= end) throw unreadable()
    const line = lines[at++]
    const kind = line === '' || line === '\r' || line[0] === ' ' ? 'context' : line[0] === '-' ? 'deletion' : line[0] === '+' ? 'insertion' : null
    if (!kind) throw unreadable()
    let part = hunk.parts.at(-1)
    if (part?.kind !== kind) hunk.parts.push(part = { kind, lines: [] })
    part.lines.push(line.slice(1))
    if (kind !== 'insertion') olds--
    if (kind !== 'deletion') news--
    if (olds < 0 || news < 0) throw unreadable()
    if (lines[at]?.startsWith('\\')) {
      if (!lines[at++].startsWith('\\ No newline at end of file')) throw unreadable()
      part.unended = true
    }
  }
  return { hunk, next: at }
}

// As pnpm writes a patch; a CRLF one's headers read without their CRs, as patch-package reads them.
export function parsePatch(patch) {
  const lines = patch.split('\n')
  const end = lines.length - (patch.endsWith('\n') ? 1 : 0)
  const headerAt = (at) => lines[at]?.replace(/\r$/u, '') ?? ''
  const files = []
  for (let at = 0; at < lines.length;) {
    const head = headerAt(at++)
    if (!head.startsWith('diff --git ')) continue
    let created = false
    let deleted = false
    let from = null
    let to = null
    let sides = null
    for (; at < lines.length && !/^(?:diff --git |@@ |--- )/u.test(lines[at]); at++) {
      const header = headerAt(at)
      if (header === 'GIT binary patch' || header.startsWith('Binary files ') || header.startsWith('copy from ') || header.startsWith('copy to ')) {
        throw new PatchError('patch-unsupported')
      }
      if (header.startsWith('deleted file mode ')) deleted = true
      else if (header.startsWith('new file mode ')) created = true
      else if (header.startsWith('rename from ')) from = unquoted(header.slice('rename from '.length))
      else if (header.startsWith('rename to ')) to = unquoted(header.slice('rename to '.length))
    }
    if (lines[at]?.startsWith('--- ')) {
      if (!lines[at + 1]?.startsWith('+++ ')) throw unreadable()
      sides = [sidePath(headerAt(at).slice(4), 'a/'), sidePath(headerAt(at + 1).slice(4), 'b/')]
      at += 2
    }
    const named = gitPath(head.slice('diff --git '.length))
    const after = to ?? (sides ? sides[1] : named)
    const before = from ?? (sides ? sides[0] : named)
    if ((from === null) !== (to === null) || (deleted && created)) throw unreadable()
    const path = deleted ? before : after
    if (path == null || (!created && before == null) || (!deleted && after == null) || ![before, after].every((side) => side == null || inPackage(side))
      || (from === null && !deleted && !created && before !== after)) throw unreadable()
    const hunks = []
    while (lines[at]?.startsWith('@@ ')) {
      const { hunk, next } = readHunk(lines, at, end)
      hunks.push(hunk)
      at = next
    }
    files.push({ path, ...(from !== null && { from: before }), ...(deleted && { deleted: true }), ...(created && { created: true }), hunks: deleted ? [] : hunks })
  }
  return files
}

const doesNotApply = () => new PatchError('patch-does-not-apply')

// Lines the same but for the space they end in match, as patch-package finds a hunk.
function changesAt(hunk, lines, start) {
  let at = start
  if (at < 0 || lines.length - at < hunk.length) return null
  const changes = []
  for (const part of hunk.parts) {
    if (part.kind === 'insertion') {
      changes.push({ splice: at, remove: 0, insert: part.lines })
      if (part.unended) changes.push('pop')
      continue
    }
    for (const line of part.lines) if (lines[at++].trimEnd() !== line.trimEnd()) return null
    if (part.kind === 'deletion') {
      changes.push({ splice: at - part.lines.length, remove: part.lines.length, insert: [] })
      if (part.unended) changes.push('push')
    }
  }
  return changes
}

function applied(text, hunks) {
  const lines = text.split('\n')
  const changes = hunks.flatMap((hunk) => {
    for (let offset = 0; Math.abs(offset) <= FUZZ; offset = offset < 0 ? -offset : -offset - 1) {
      const found = changesAt(hunk, lines, hunk.at + offset)
      if (found) return found
    }
    throw doesNotApply()
  })
  let shift = 0
  for (const change of changes) {
    if (change === 'push') lines.push('')
    else if (change === 'pop') lines.pop()
    else {
      lines.splice(change.splice + shift, change.remove, ...change.insert)
      shift += change.insert.length - change.remove
    }
  }
  return lines.join('\n')
}

// A file it creates holds its first hunk's first lines, as patch-package writes it.
export function patchedFiles(files, patch) {
  const next = new Map(files)
  for (const file of patch) {
    if (file.created) {
      const first = file.hunks[0]?.parts[0]
      next.set(file.path, utf8.encode(first ? `${first.lines.join('\n')}${first.unended ? '' : '\n'}` : ''))
      continue
    }
    const source = file.from ?? file.path
    const bytes = next.get(source)
    if (!bytes) throw doesNotApply()
    if (file.deleted) {
      next.delete(source)
      continue
    }
    let changed = bytes
    if (file.hunks.length > 0) {
      let text
      try {
        text = asText.decode(bytes)
      } catch {
        throw doesNotApply()
      }
      changed = utf8.encode(applied(text, file.hunks))
    }
    if (file.from !== undefined) {
      if (next.has(file.path)) throw doesNotApply()
      next.delete(source)
    }
    next.set(file.path, changed)
  }
  return next
}

const asBuffer = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const equal = (a, b) => asBuffer(a).equals(b)
const isFile = (file, bytes) => (file.integrity === undefined ? equal(file.bytes(), bytes) : sha512integrity(bytes) === file.integrity)
// Formats a CR before each line's end changes the meaning of: a binary's bytes, which no checkout
// converts, a shell script's commands and an env file's values, each its last word's own.
const CR_CHANGES = new Set(['resource:base64', 'shell', 'env'])
// `bytes` as the other side of a checkout with CRLF line endings has them, as git converts a text file whole.
function checkedOut(bytes, format, toLf) {
  if (CR_CHANGES.has(format)) return undefined
  const text = asBuffer(bytes).toString('latin1')
  if (toLf) return text.includes('\r\n') && !/(?<!\r)\n/u.test(text) ? Buffer.from(text.replaceAll('\r\n', '\n'), 'latin1') : undefined
  return text.includes('\n') && !text.includes('\r\n') ? Buffer.from(text.replaceAll('\n', '\r\n'), 'latin1') : undefined
}
const packageKey = ({ ecosystem, name, version }) => `${ecosystem}:${name}@${version}`
// A registry's version, as pnpm names one in its store's directories (no `file+lib`, say).
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u
// pnpm's store directory names a version `<name, its / a +>@<version>`, but where it hashed a long one or one with uppercase.
function installedAt(dir) {
  const segments = dir.split('/')
  const at = segments.lastIndexOf('node_modules')
  const as = segments.slice(at + 1).join('/')
  const store = at >= 3 && segments[at - 2] === '.pnpm' && segments[at - 3] === 'node_modules' ? segments[at - 1] : undefined
  if (store === undefined || STORE_HASH.test(store)) return { as }
  const split = store.indexOf('@', 1)
  if (split < 0) return { as }
  const name = store.slice(0, split)
  const version = store.slice(split + 1).split('_')[0]
  return { as, store: { name: name.startsWith('@') ? name.replace('+', '/') : name, ...(VERSION.test(version) && { version }) } }
}
// Undefined for a copy installed under an alias no lockfile read tells of.
function placed(pkg, dir, locked) {
  const { as, store } = installedAt(dir)
  const named = `${pkg.name}@${pkg.version}`
  if (store && (store.name !== pkg.name || (store.version !== undefined && store.version !== pkg.version) || as !== pkg.name)) return false
  const there = locked?.installed?.(dir)
  if (there !== undefined) return there === named
  if (as === pkg.name) return true
  return locked?.aliased?.(as, named)
}
const byText = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
// The worst first, own code's files before a package's, so that as many as MAX_TOLD keep the worst.
const KINDS = ['differs', 'unexpected', 'unverified']
const STATUSES = ['invalid', 'unverified', 'valid']
const byProblem = (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || (a.of === 'own' ? 0 : 1) - (b.of === 'own' ? 0 : 1)
  || byText((problem) => problem.of)(a, b) || byText((problem) => problem.path)(a, b)
const byPackage = (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || byText(packageKey)(a, b)
const pnpmPatchName = (name, version) => `${name.replace('/', '__')}@${version}.patch`

function patchesOf(plan) {
  const byHash = new Map()
  const byName = new Map()
  for (const [path, text] of plan.patches) {
    const held = { path, text }
    const name = posix.basename(path)
    for (const hash of patchHashes(text)) if (!byHash.has(hash)) byHash.set(hash, held)
    if (!byName.has(name)) byName.set(name, held)
  }
  return { byHash, byName, byPath: plan.patches }
}

// A bundle's patch is own code: refused where the repository holds it otherwise (`verdicts`).
async function patchOf(held, pkg, files, locked, verdicts, recorded, recordedFile) {
  const lock = locked?.of(pkg.name, pkg.version)
  const hash = lock === undefined ? recorded : lock?.hash
  let patch
  let text
  // Where it is found, from the bundle root, as a record's `file` names it.
  let file
  try {
    // Of the bundle's of its hash, the one its copies record, where it holds that.
    const own = hash !== undefined && held.byPath.get(recordedFile)
    const bundled = own && isPatchOf(own, hash) ? { path: recordedFile, text: own }
      : hash !== undefined ? held.byHash.get(hash) : lock === undefined && held.byName.get(pnpmPatchName(pkg.name, pkg.version))
    if (bundled) {
      patch = { ...(hash !== undefined && { hash }), path: bundled.path, from: 'bundle' }
      ;({ text, path: file } = bundled)
    } else if (lock?.path) {
      patch = { hash, path: lock.path, from: locked.from }
      file = lock.file
      text = await locked.read(lock.path)
      // Held to the hash the lockfile names it by, as the bundle's are found by it.
      if (!isPatchOf(text, hash)) throw new PatchError('patch-mismatch')
    } else {
      // Named by its hash alone (pnpm 11): the file of that hash in a patches directory.
      const found = lock ? await locked.locate?.(lock) : undefined
      if (!found) return hash === undefined ? { patched: null } : { patch: { hash, error: 'patch-not-found' }, patched: null }
      patch = { hash, path: found.path, from: locked.from }
      ;({ text, file } = found)
    }
    let unverified = false
    if (patch.from === 'bundle') {
      const verdict = (await verdicts).get(patch.path)
      if (verdict === 'differs' || verdict === 'unexpected') throw new PatchError('patch-not-in-repository')
      unverified = verdict !== 'matched'
      patch.verified = !unverified
    }
    return { patch, patched: patchedFiles(files, parsePatch(text)), unverified, file }
  } catch (error) {
    return { patch: { ...patch, error: error instanceof PatchError ? error.code : 'patch-unreadable' }, patched: null }
  }
}

// A path git can have in a tree, as upstream's isRepoPath (src/args.js), which it doesn't export, has it.
const inTree = (path) => path.length <= 4096 && path.isWellFormed() && !/\p{Cc}/u.test(path) && path.split('/').every((part) => !['', '.', '..', '.git'].includes(part.toLowerCase()))

const pathIn = (dir, name) => (dir ? `${dir}/${name}` : name)
const repoDir = (dir) => (dir === '.' ? '' : dir)

async function eachOf(items, parallel, run) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => {
    // eslint-disable-next-line no-await-in-loop -- a worker takes the next item once its own is done
    while (next < items.length) await run(items[next++])
  }))
}

export async function validateBundle(plan, own, { fetch = fetchPackage, locked: lockfiles = null, generated, submodules, deadline = Number.POSITIVE_INFINITY, now = Date.now } = {}) {
  const units = plan.packages.flatMap((pkg) => lockfiles?.split?.(pkg) ?? [{ pkg, locked: lockfiles }])
  const problems = []
  const counts = { files: plan.files, own: plan.own.length, dependencies: plan.files - plan.own.length, matched: 0, eol: 0, generated: 0, differs: 0, unexpected: 0, unverified: 0,
    skipped: 0, packages: units.length, validPackages: 0, lockFailures: 0, misplaced: 0 }
  const tell = (problem) => {
    counts[problem.kind]++
    problems.push(problem)
  }
  // Each own file's verdict, once own code is checked, as patchOf awaits a bundle's patch's.
  const { promise: verdicts, resolve: checked } = Promise.withResolvers()

  const told = []
  const bundled = patchesOf(plan)
  const fetching = eachOf(units, PACKAGES_AT_ONCE, async ({ pkg, locked }) => {
    const of = packageKey(pkg)
    const tellPackage = (status, more) => told.push({ ecosystem: pkg.ecosystem, name: pkg.name, version: pkg.version, files: pkg.files.length, status, ...more })
    const unverified = (reason, status = 'unverified', more = {}) => {
      counts.unverified += pkg.files.length
      tellPackage(status, { reason, ...more })
    }
    const fails = (reason, more) => {
      counts.lockFailures++
      unverified(reason, 'invalid', more)
    }
    if (!pkg.name || !pkg.version) return unverified('unnamed')
    const dirs = [...new Set(pkg.files.map((file) => file.dir))]
    const places = new Map(pkg.ecosystem === 'npm' ? dirs.map((dir) => [dir, placed(pkg, dir, locked)]) : [])
    const misplaced = dirs.find((dir) => places.get(dir) === false)
    if (misplaced !== undefined) {
      counts.misplaced++
      return unverified('misplaced', 'invalid', { at: misplaced })
    }
    const aliased = dirs.filter((dir) => places.has(dir) && places.get(dir) === undefined)
    if (aliased.length === dirs.length) return unverified('alias-unverified', 'unverified', { at: aliased[0] })
    const lock = locked?.lock?.(pkg.ecosystem, pkg.name, pkg.version)
    if (lock === null) return fails('not-locked')
    if (lock?.conflict) return fails('integrity-conflict')
    // A registry's version locked with no integrity is held to the tarball fetched with the one recorded.
    const recordedBy = (by) => new Set(dirs.map(by).filter((value) => value !== undefined))
    const [recordedIntegrity, otherIntegrity] = recordedBy((dir) => pkg.integrities.get(dir))
    if (otherIntegrity !== undefined) return fails('integrity-conflict')
    const fetchedWith = lock?.from === 'registry' && lock.integrity === undefined && FETCHED.has(pkg.ecosystem)
    if (recordedIntegrity !== undefined && lock !== undefined && !fetchedWith && lock.integrity !== recordedIntegrity) return fails('integrity-not-locked')
    // Each copy's patch as it attests it: null, unpatched, of one recording an integrity and none.
    const [recordedPatch, conflicting] = recordedBy((dir) => attestedOf({ integrity: pkg.integrities.get(dir), patch: pkg.recorded.get(dir) }, 'patch'))
    if (conflicting !== undefined) return fails('patch-conflict')
    const lockedPatch = pkg.ecosystem === 'npm' ? locked?.of(pkg.name, pkg.version) : undefined
    // npm's and yarn's lockfiles lock no patch, as they patch nothing.
    const installedPatch = lockedPatch === undefined && locked?.unpatched ? null : lockedPatch
    const otherwise = recordedPatch !== undefined && installedPatch !== undefined && (installedPatch?.hash ?? null) !== recordedPatch
    if (otherwise) return recordedPatch === null ? fails('patch-not-recorded') : fails('patch-not-locked', { patch: { hash: recordedPatch, recorded: true } })
    if (lock?.from === 'git' && !(lock.at && locked.git)) return unverified('git')
    let pinned
    if (pkg.ecosystem === 'github' && submodules) {
      const at = new Map(await Promise.all(dirs.map(async (dir) => [dir, await submodules.at(dir)])))
      if (dirs.some((dir) => at.get(dir) === null)) return unverified('not-a-submodule')
      if (dirs.some((dir) => pkg.repos.get(dir)?.commit !== undefined && pkg.repos.get(dir).commit !== at.get(dir))) return fails('commit-not-locked')
      if (dirs.every((dir) => pkg.repos.get(dir)?.github !== undefined)) {
        try {
          pinned = new Map(await Promise.all(dirs.map(async (dir) => [dir, await submodules.read({ github: pkg.repos.get(dir).github, commit: at.get(dir), path: '' })])))
        } catch (error) {
          return unverified(fetchFailure(error))
        }
      }
    }
    if (!FETCHED.has(pkg.ecosystem) && lock?.from !== 'git' && !pinned) return unverified('unsupported')
    if (lock?.from === 'elsewhere') return unverified('not-registry')
    if (lock?.from === 'local' && !locked.tree) return unverified('local')
    if (lock?.from === 'registry' && lock.integrity === undefined && recordedIntegrity === undefined) return unverified('no-integrity')
    if (now() > deadline) return unverified('timeout')
    // Patched alone where the lockfile locks the patch, as pnpm patches every copy, or the copy records it.
    let candidates
    let published
    let patch
    let patched
    let patchFile
    let unverifiedPatch = false
    try {
      if (pinned) candidates = []
      else if (lock?.from === 'local') candidates = await Promise.all(lock.directories.map((dir) => locked.tree(dir)))
      else {
        published = lock?.from === 'git' ? await locked.git(lock.at) : await fetch(pkg.ecosystem, pkg.name, pkg.version, lock?.integrity ?? recordedIntegrity)
        ;({ patch, patched, unverified: unverifiedPatch = false, file: patchFile } = pkg.ecosystem === 'npm' && recordedPatch !== null ? await patchOf(bundled, pkg, published, locked, verdicts, recordedPatch, dirs.map((dir) => pkg.patchFiles.get(dir)).find(Boolean)) : {})
        candidates = patched && !unverifiedPatch ? [patched, published] : [published]
      }
    } catch (error) {
      const reason = fetchFailure(error)
      return reason === 'integrity-mismatch' ? fails(reason) : unverified(reason)
    }
    // A copy recording where its patch is records where validation finds it.
    const elsewhere = patchFile === undefined ? undefined : dirs.map((dir) => pkg.patchFiles.get(dir)).find((file) => file !== undefined && file !== patchFile)
    if (elsewhere !== undefined) return fails('patch-file-mismatch', { at: elsewhere, patch: { ...patch, recorded: true } })
    const checksum = (file) => pkg.ecosystem === 'cargo' && file.rel === CARGO_CHECKSUM
    const matches = (file, bytes, candidate) => (checksum(file) ? checksumOf(bytes, candidate) : candidate.has(file.rel) && isFile(file, candidate.get(file.rel)))
    // Each installed copy apart, as one may be patched and another not.
    let missed = 0
    let asPatched = 0
    let notVerified = 0
    for (const copy of Map.groupBy(pkg.files, (file) => file.dir).values()) {
      if (aliased.includes(copy[0].dir)) {
        notVerified += copy.length
        continue
      }
      const bytes = new Map(copy.map((file) => [file, file.integrity === undefined ? file.bytes() : undefined]))
      const missing = (candidate) => copy.filter((file) => !matches(file, bytes.get(file), candidate))
      const patching = published !== undefined && Boolean(lockedPatch || pkg.recorded.has(copy[0].dir))
      const heldTo = pinned ? [pinned.get(copy[0].dir)] : patched && patching ? [patched] : candidates
      let [held] = heldTo
      let misses = missing(held)
      for (const other of heldTo.slice(1)) {
        if (misses.length > 0 && missing(other).length === 0) [held, misses] = [other, []]
      }
      // As a patch not verified against the repository patches them: neither as they should be nor not.
      if (unverifiedPatch && missing(patched).length === 0 && missing(published).length > 0) {
        notVerified += copy.length
        continue
      }
      // Of a git dependency, a file its repository hasn't there is one an install may build: unverified.
      const built = lock?.from === 'git' ? misses.filter((file) => !held.has(file.rel)) : []
      notVerified += built.length
      misses = misses.filter((file) => !built.includes(file))
      for (const file of misses) tell({ path: file.path, kind: checksum(file) || held.has(file.rel) ? 'differs' : 'unexpected', of })
      missed += misses.length
      if (misses.length === 0 && held === patched) asPatched++
      // Its patch unread or unapplied, nothing tells what its files should be: those as published are unverified.
      if (patching && !patched) notVerified += copy.length - misses.length - built.length
    }
    counts.matched += pkg.files.length - missed - notVerified
    counts.unverified += notVerified
    const status = missed > 0 ? 'invalid' : notVerified > 0 ? 'unverified' : 'valid'
    if (status === 'valid') counts.validPackages++
    if (status !== 'valid' || patch) {
      let why
      if (status === 'unverified') why = aliased.length > 0 ? { reason: 'alias-unverified', at: aliased[0] } : patch?.error ? {} : { reason: lock?.from === 'git' ? 'git-built' : 'patch-unverified' }
      tellPackage(status, {
        ...why,
        ...(patch && { patch: { ...patch, ...(recordedPatch !== undefined && { recorded: true }), ...(patched && status === 'valid' && { applied: asPatched > 0 }) } }),
        ...(lock?.from === 'local' && { directory: lock.directories[0] }),
      })
    }
    return undefined
  })

  let read
  let skipped
  const found = new Map()
  const verdict = (file, kind, reason) => {
    if (kind === 'matched') counts.matched++
    else tell({ path: file.path, kind, of: 'own', ...(reason && { reason }) })
    found.set(file.path, kind)
  }
  const unmatched = []
  let generatedClients = []
  let generatedError
  try {
    read = await own
    skipped = 'reason' in read
    // A patch, which no client generates, told at once.
    const mismatch = (file, kind, reason) => (generated && !skipped && !plan.patches.has(file.path) ? unmatched.push({ file, kind, reason }) : verdict(file, kind, reason))
    let submodulePaths
    const inSubmodule = (path) => (submodulePaths ??= [...read.entries].filter(([, entry]) => entry.submodule).map(([at]) => `${at}/`)).some((prefix) => path.startsWith(prefix))
    for (const file of plan.own) {
      // Own code skipped, the bundle's patches are checked all the same where the repository is read.
      if (skipped && !(read.entries && plan.patches.has(file.path))) {
        counts[read.reason === 'skipped' ? 'skipped' : 'unverified']++
        continue
      }
      const path = pathIn(read.directory, file.path)
      const entry = read.entries.get(path)
      // One at a path no tree can have is no file left unlisted.
      if (entry?.submodule || (entry === undefined && inSubmodule(path))) verdict(file, 'unexpected', 'submodule')
      else if (entry === undefined && read.cut && inTree(path)) mismatch(file, 'unverified', 'tree-cut')
      else if (entry === undefined) mismatch(file, 'unexpected')
      else if (entry.symlink !== undefined) verdict(file, 'differs', 'symlink')
      else if (file.integrity !== undefined && entry.data === undefined) verdict(file, 'unverified', 'listed')
      else {
        // Either side may be as a checkout with CRLF line endings writes the other's LF text.
        const byIntegrity = file.integrity !== undefined
        const bytes = byIntegrity ? entry.data : file.bytes()
        const same = (candidate) => (byIntegrity ? isFile(file, candidate)
          : entry.data === undefined ? gitBlobId(candidate) === entry.sha : equal(candidate, entry.data))
        if (same(bytes)) verdict(file, 'matched')
        else {
          const converted = checkedOut(bytes, file.format, !byIntegrity)
          if (converted !== undefined && same(converted)) {
            counts.eol++
            verdict(file, 'matched')
          } else mismatch(file, 'differs')
        }
      }
    }
    // Told before the clients are generated: checking a package's patch the bundle holds awaits it.
    checked(found)
    if (unmatched.length > 0) {
      const clients = await Promise.try(generated).catch((error) => {
        generatedError = error.message
        return []
      })
      generatedClients = heldToClients(unmatched, clients, verdict)
      counts.generated = generatedClients.reduce((sum, client) => sum + client.files.length, 0)
    }
  } finally {
    checked(found)
  }
  await fetching

  const patchesChecked = skipped && read.entries ? plan.own.filter((file) => plan.patches.has(file.path)).length : 0
  return {
    validatedAt: now(),
    status: counts.differs + counts.unexpected + counts.lockFailures + counts.misplaced > 0 ? 'invalid' : counts.unverified > 0 ? 'incomplete' : 'valid',
    own: skipped ? { checked: false, reason: read.reason, ...(patchesChecked > 0 && { patches: patchesChecked }) }
      : { checked: true, repository: read.repository, ...(read.movedFrom && { movedFrom: read.movedFrom }), commit: read.commit, ...(read.ref && { ref: read.ref }), directory: read.directory, ...(read.cut && { cut: true }) },
    lockfiles: lockfiles?.lockfiles ?? null,
    counts,
    problems: problems.toSorted(byProblem).slice(0, MAX_TOLD),
    moreProblems: Math.max(0, problems.length - MAX_TOLD),
    packages: told.toSorted(byPackage).slice(0, MAX_TOLD),
    generated: generatedClients,
    ...(generatedError !== undefined && { generatedError }),
  }
}

const bytesOf = (content) => (typeof content === 'string' ? utf8.encode(content) : content)
const relIn = (dir, path) => (dir === '' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : undefined)

function heldToClients(unmatched, clients, verdict) {
  const listed = new Map()
  for (const { file, kind, reason } of unmatched) {
    const outputs = clients.map((client) => ({ client, rel: relIn(client.dir, file.path) })).filter(({ rel }) => rel !== undefined)
    const generating = outputs.filter(({ client, rel }) => client.files.has(rel))
    const by = generating.find(({ client, rel }) => isFile(file, bytesOf(client.files.get(rel))))?.client
    if (by) {
      verdict(file, 'matched')
      upsert(listed, by, () => ({ output: by.dir, schema: by.schema, generator: by.generator, prisma: by.prisma, files: [] })).files.push(file.path)
    } else if (generating.length > 0 && kind !== 'unverified') verdict(file, 'differs', 'generated')
    else verdict(file, kind, reason ?? (outputs.length > 0 && kind === 'unexpected' ? 'not-generated' : undefined))
  }
  return [...listed.values()].map((client) => ({ ...client, files: client.files.toSorted() })).toSorted(byText((client) => client.output))
}

export const exitCodeOf = (report, { allowUnverified = false } = {}) => (report.status === 'invalid' ? 1 : report.status === 'incomplete' && !allowUnverified ? 2 : 0)

// Its tree's tarball, which upstream holds to the tree's id, its symlinks climbing as far as the repository's root.
export async function repositoryFiles(client, { github, commit, directory = '' }) {
  const tree = await client.getRepoTreeId({ repo: github, sha: commit, ...(directory && { directory }) })
  const tarball = await client.getRepoTreeTarball({ repo: github, tree, symlinksAbove: directory ? directory.split('/').length - 1 : 0 })
  const entries = new Map()
  for (const [path, value] of await tarballFiles(tarball)) entries.set(pathIn(directory, path), value instanceof Uint8Array ? { data: value } : value)
  return entries
}

function filesUnder(entries, dir) {
  const prefix = dir ? `${dir}/` : ''
  return new Map([...entries].filter(([path, entry]) => path.startsWith(prefix) && entry.data).map(([path, entry]) => [path.slice(prefix.length), entry.data]))
}

const LOCKFILES = new Map([['pnpm-lock.yaml', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['package-lock.json', 'npm'], ['yarn.lock', 'npm'], ['Cargo.lock', 'cargo'], ['composer.lock', 'composer'], ['soldeer.lock', 'soldeer']])
// Those of ecosystems upstream fetches no package of, read where the bundle's directory holds one.
const BESIDE = new Map([['composer', 'composer.lock'], ['soldeer', 'soldeer.lock']])
const CRATES_IO = new Set(['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/'])

// None is, as npm writes one of its registry's where set to.
function registryTarball(tarball, name, version) {
  if (tarball === undefined) return true
  const url = URL.parse(tarball)
  return url !== null && /^https?:$/u.test(url.protocol) && url.pathname.endsWith(tarballPath(name, version))
}

function lockedFrom(git, registry, integrity, resolution) {
  if (!git) return { from: registry ? 'registry' : 'elsewhere', integrity }
  const at = resolutionCommit(resolution)
  return { from: 'git', integrity, ...(at && { at: { ...at, path: (resolution.path ?? '').replace(/^\/+|\/+$/gu, '') } }) }
}
const fromGit = (resolution) => resolution?.type === 'git' || resolution?.gitHosted === true || resolutionCommit(resolution) !== undefined

function localDirectory(spec) {
  const path = /^(?:file|link):(.+)$/u.exec(spec)?.[1]
  return path === undefined || /\.(?:tgz|tar\.gz|tar)$/u.test(path) ? undefined : path
}

// Its BOM passed over but Cargo.lock's, as cargo reads it.
function readLockfile(name, read) {
  const text = name === 'Cargo.lock' ? read : withoutBom(read)
  const entries = new Map()
  const locals = new Map()
  const add = (pkg, version, entry) => upsert(entries, `${pkg}@${version}`, () => []).push(entry)
  const local = (pkg, dir) => locals.set(pkg, new Set([...(locals.get(pkg) ?? []), posix.normalize(dir)]))
  // `<as>\0<name>@<version>`, and a directory's package's `<as>\0<name>`, any version of it.
  const aliases = new Set()
  const directoryAliases = new Set()
  if (name === 'pnpm-lock.yaml') {
    const { lockfile } = parsePnpmLockfile(text)
    // pnpm locks an alias `foo: ms@2.1.3`, and a directory's `foo: lib@file:lib`, as a `file:` override installs it.
    for (const node of [...Object.values(lockfile?.importers ?? {}), ...Object.values(lockfile?.packages ?? {})]) {
      for (const [as, ref] of Object.entries({ ...node.dependencies, ...node.devDependencies, ...node.optionalDependencies })) {
        const split = typeof ref === 'string' ? ref.indexOf('@', 1) : -1
        if (split < 0) continue
        const target = ref.slice(0, split)
        const of = ref.slice(split + 1)
        const version = of.split('(')[0]
        if (VERSION.test(version)) aliases.add(`${as}\0${target}@${version}`)
        else if (of.startsWith('file:') && as !== target) directoryAliases.add(`${as}\0${target}`)
      }
    }
    const hashes = new Map()
    for (const [key, pkg] of Object.entries(lockfile?.packages ?? {})) {
      // A directory has no version in the lockfile: pnpm reads the one it has as it installs it.
      if (pkg.resolution.type === 'directory') local(pkg.name, pkg.resolution.directory)
      if (pkg.version === undefined) continue
      // A registry version's key is its name and version, its peers and patch after them.
      const ref = key.slice(pkg.name.length + 1)
      add(pkg.name, pkg.version, lockedFrom(fromGit(pkg.resolution), ref === pkg.version || ref.startsWith(`${pkg.version}(`), sha512Of(pkg.resolution.integrity), pkg.resolution))
      hashes.set(`${pkg.name}@${pkg.version}`, pkg.patchHash ?? null)
    }
    const paths = new Map()
    for (const [selector, { hash, path }] of Object.entries(lockfile?.patchedDependencies ?? {})) {
      const known = paths.get(hash)
      paths.set(hash, { path: known?.path ?? path, selectors: [...(known?.selectors ?? []), selector] })
    }
    return { entries, locals, aliases, directoryAliases, patches: { hashes, paths }, importers: new Set(Object.keys(lockfile?.importers ?? {})) }
  }
  if (name === 'Cargo.lock') {
    for (const pkg of Object.values(parseCargoLock(text).packages)) add(pkg.name, pkg.version, lockedFrom(pkg.source?.startsWith('git+'), CRATES_IO.has(pkg.source), pkg.checksum))
    return { entries }
  }
  // Composer's: a dist archive, else its git source; a path repository's is a directory's, elsewhere.
  if (name === 'composer.lock') {
    for (const pkg of Object.values(parseComposerLock(text, {}).packages)) {
      const git = pkg.dist == null && pkg.source?.type === 'git'
      add(pkg.name, pkg.version, lockedFrom(git, pkg.dist != null && pkg.dist.type !== 'path', archiveIntegrity('composer', pkg.dist?.shasum), git ? { type: 'git', repo: pkg.source.url, commit: pkg.source.reference } : undefined))
    }
    return { entries }
  }
  if (name === 'soldeer.lock') {
    for (const dep of Object.values(parseSoldeerLockfile(text).dependencies)) add(dep.name, dep.version, lockedFrom(dep.type === 'git', true, archiveIntegrity('soldeer', dep.checksum), dep.type === 'git' ? { type: 'git', repo: dep.git, commit: dep.rev } : undefined))
    return { entries }
  }
  let packages
  let locations
  let links
  let importers
  if (name === 'yarn.lock') packages = new Set(Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages))
  else {
    const lockfile = parseNpmLockfile(text, { checkVersions: false })
    locations = new Map(Object.entries(lockfile.packages).filter(([, pkg]) => pkg.version !== undefined).map(([location, pkg]) => [location, `${pkg.name}@${pkg.version}`]))
    importers = new Set(Object.keys(lockfile.importers))
    links = new Set(Object.keys(lockfile.links))
    for (const [location, target] of Object.entries(lockfile.links)) {
      if (Object.hasOwn(lockfile.importers, target)) local(nameAt(location), target)
    }
    packages = Object.values(lockfile.packages)
  }
  for (const { name: pkg, version, resolution, patterns } of packages) {
    // yarn locks an alias by its pattern, `foo@npm:ms@^2.1.0`.
    for (const pattern of patterns ?? []) {
      const split = pattern.indexOf('@', 1)
      if (pattern.startsWith('npm:', split + 1)) aliases.add(`${pattern.slice(0, split)}\0${pkg}@${version}`)
    }
    // yarn locks a directory by its spec alone, as it last read the version there.
    const dir = resolution === undefined ? patterns?.map((pattern) => localDirectory(pattern.slice(pattern.indexOf('@', 1) + 1))).find(Boolean) : undefined
    if (dir !== undefined) local(pkg, dir)
    else if (version !== undefined) add(pkg, version, lockedFrom(fromGit(resolution), resolution?.type === 'tarball' && registryTarball(resolution.tarball, pkg, version), sha512Of(resolution?.integrity), resolution))
  }
  return { entries, locals, aliases, ...(locations && { locations, links, importers }) }
}

function lockOf(path, text) {
  try {
    return readLockfile(posix.basename(path), text)
  } catch (error) {
    throw unreadableLockfile(path, error)
  }
}

export function lockedBy(lockfiles) {
  const by = new Map()
  const all = []
  const given = new Map()
  for (const lockfile of lockfiles) {
    const { path, text, from, read, tree, git, patches, root = '', at = '' } = lockfile
    const ecosystem = LOCKFILES.get(posix.basename(path))
    if (ecosystem === undefined) throw new ValidateError('lockfile-unsupported', `${path}: not a lockfile validate reads (${[...LOCKFILES.keys()].join(', ')})`)
    const same = by.get(ecosystem) ?? []
    const other = same.find((one) => one.at === at)
    if (other !== undefined) throw new ValidateError('lockfile-ambiguous', `${other.path} and ${path} both lock ${ecosystem} packages: give one`)
    const locks = lockOf(path, text)
    // Given on disk, a lockfile's place in the repository isn't known: the bundle's root from its directory is the
    // longest tail of `root` that is one of its importers, else its own.
    const tails = root.split('/').map((_, start, parts) => parts.slice(start).join('/'))
    const within = locks.importers === undefined || from !== 'local' ? root : tails.find((tail) => locks.importers.has(tail)) ?? ''
    // The bundle's root, in its paths' terms, as a recorded patch's `file` is from there.
    const bundleDir = posix.join(posix.dirname(path), within)
    const one = { ...locks, path, from, read, tree, git, root: within, at, bundleDir, patchDirs: patches ?? [posix.join(posix.dirname(path), 'patches')] }
    by.set(ecosystem, [...same, one])
    all.push(one)
    given.set(one, lockfile)
  }
  const npms = by.get('npm') ?? []
  // Of an npm lockfile at the bundle's root or above it, every copy; of one below, those under it; of one
  // beside it (`../tools`), none, as no path of the bundle climbs out of its root.
  const above = (at) => at === '' || at.split('/').every((part) => part === '..')
  const depth = (at) => (at === '' ? 0 : above(at) ? -at.split('/').length : at.split('/').length)
  const innermost = (of, dir) => of.filter(({ at }) => above(at) || dir.startsWith(`${at}/`)).reduce((inner, one) => (inner === undefined || depth(one.at) > depth(inner.at) ? one : inner), undefined)
  const aloneOf = memoized((one) => lockedBy([given.get(one)]))
  const locationIn = (one, dir) => (above(one.at) ? pathIn(one.root, dir) : dir.slice(one.at.length + 1))
  return {
    lockfiles: all.map(({ path }) => path),
    locks: (ecosystem) => by.has(ecosystem),
    // Each copy held to the innermost lockfile holding it alone; those none holds, to them all.
    split(pkg) {
      const same = by.get(pkg.ecosystem) ?? []
      if (same.length < 2) return undefined
      return [...Map.groupBy(pkg.files, (file) => innermost(same, file.dir))].map(([one, files]) => ({ pkg: { ...pkg, files }, locked: one === undefined ? this : aloneOf(one) }))
    },
    lock(ecosystem, name, version) {
      const same = by.get(ecosystem)
      if (same === undefined) return undefined
      const locks = same.flatMap(({ entries }) => entries.get(`${name}@${version}`) ?? [])
      if (locks.length === 0) {
        const dirs = same.flatMap(({ locals, path }) => [...(locals?.get(name) ?? [])].map((dir) => repoDir(posix.join(posix.dirname(path), dir))))
        return dirs.length > 0 ? { from: 'local', directories: [...new Set(dirs)] } : null
      }
      const integrities = new Set(locks.filter((entry) => entry.from === 'registry').map((entry) => entry.integrity))
      if (integrities.size === 0) {
        const locking = new Set(locks.map((entry) => entry.integrity))
        const archive = locking.size === 1 && !locking.has(undefined) && { integrity: locks[0].integrity }
        if (!locks.every((entry) => entry.from === 'git')) return { from: 'elsewhere', ...archive }
        const [at, other] = new Set(locks.map((entry) => JSON.stringify(entry.at ?? null)))
        return { from: 'git', ...archive, ...(other === undefined && at !== 'null' && { at: JSON.parse(at) }) }
      }
      return integrities.size === 1 ? { from: 'registry', integrity: [...integrities][0] } : { from: 'registry', conflict: true }
    },
    // Null where the pnpm lockfiles lock the version with no patch, undefined where none of them locks it.
    of(name, version) {
      let found
      for (const npm of npms) {
        const hash = npm.patches?.hashes.get(`${name}@${version}`)
        if (hash === null) found = null
        if (hash == null) continue
        const { path, selectors = [] } = npm.patches.paths.get(hash) ?? {}
        const at = path && posix.join(posix.dirname(npm.path), path)
        if (at) return { hash, path: at, file: posix.relative(npm.bundleDir, at) }
        return { hash, names: [...new Set([...selectors.map((selector) => `${selector.replace('/', '__')}.patch`), pnpmPatchName(name, version)])] }
      }
      return found
    },
    async locate({ hash, names = [] }) {
      const tried = new Set()
      for (const npm of npms) {
        for (const path of npm.patchDirs.flatMap((dir) => names.map((name) => pathIn(dir, name)))) {
          if (tried.has(path)) continue
          tried.add(path)
          // eslint-disable-next-line no-await-in-loop -- the first of them that is there
          const text = await Promise.try(() => this.read(path)).catch(() => null)
          if (text !== null && isPatchOf(text, hash)) return { path, text, file: posix.relative(npm.bundleDir, path) }
        }
      }
      return null
    },
    // Null where it installs none at `dir`; undefined where it locks no location, links it to a directory, or none is read.
    installed(dir) {
      const npm = innermost(npms, dir)
      if (npm === undefined) return npms.length > 0 ? null : undefined
      if (npm.locations === undefined) return undefined
      const location = locationIn(npm, dir)
      return npm.links.has(location) ? undefined : npm.locations.get(location) ?? null
    },
    // A directory's package of that name, where no other of that version is locked, too; undefined for none read.
    aliased: (as, named) => (npms.length === 0 ? undefined : npms.some((npm) => npm.aliases.has(`${as}\0${named}`)
      || (!npm.entries.has(named) && Boolean(npm.directoryAliases?.has(`${as}\0${named.slice(0, named.lastIndexOf('@'))}`))))),
    from: npms[0]?.from,
    tree: npms[0]?.tree,
    git: all.find((one) => one.git)?.git,
    // npm's and yarn's lockfiles alone, which patch nothing as they install.
    unpatched: npms.length > 0 && npms.every((npm) => npm.patches === undefined),
    read: memoized((path) => Promise.resolve().then(() => npms[0].read(path))),
  }
}

function lockfilesNamed(path, text) {
  let config
  try {
    config = JSON.parse(text)
    return parseLockfilesOption(path, config?.lockfiles)
  } catch (error) {
    // parseLockfilesOption's message names the file.
    throw config === undefined ? unreadableLockfile(path, error) : new ValidateError('lockfile-unreadable', error.message)
  }
}

export async function configuredLockfiles({ directory = '', list, read }) {
  if (!(await list(directory)).includes(CONFIG_FILE)) return undefined
  const path = pathIn(directory, CONFIG_FILE)
  return lockfilesNamed(path, await readLockfileText(read, path))?.map((one) => {
    const at = posix.normalize(pathIn(directory, one))
    if (at === '..' || at.startsWith('../')) throw new ValidateError('lockfile-unreadable', `${path}: lockfiles names ${one}, which is outside the repository`)
    return at
  })
}

async function besideLockfiles({ directory, names, list, read }) {
  const listed = await list(directory)
  return Promise.all(names.filter((name) => listed.includes(name)).map(async (name) => ({ path: pathIn(directory, name), text: await read(pathIn(directory, name)) })))
}

// As the build finds them, read of a sparse tree of the directories at and above `directory`.
export async function repositoryLockfiles({ directory = '', ecosystems, list, read }) {
  const dirs = []
  for (let dir = directory; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
    dirs.push(dir)
    if (dir === '') break
  }
  const listed = await Promise.all(dirs.map(list))
  const where = directory || 'the repository\'s root'
  const lists = (...names) => listed.some((inDir) => names.some((name) => inDir.includes(name)))
  const manifests = new Set([
    ...ecosystems.has('npm') && lists('package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock') ? ['package.json'] : [],
    ...ecosystems.has('cargo') ? ['Cargo.toml'] : [],
  ])
  const files = Object.fromEntries(dirs.filter(Boolean).map((dir) => [dir, { type: 'directory' }]))
  await Promise.all(dirs.flatMap((dir, index) => listed[index].map(async (name) => {
    if (manifests.has(name)) files[pathIn(dir, name)] = await read(pathIn(dir, name))
    // npm reads npm-shrinkwrap.json in place of package-lock.json, at the root it finds by either.
    else if (LOCKFILES.has(name) || name === 'pnpm-workspace.yaml') files[pathIn(dir, name === 'npm-shrinkwrap.json' ? 'package-lock.json' : name)] ??= ''
  })))
  const host = vfsHost(createVfs(files))
  const cwd = posix.resolve('/', directory || '.')
  const fromRoot = (path) => path.slice(1)
  const rootOf = (what, find) => {
    try {
      return find()
    } catch (error) {
      throw new ValidateError('lockfile-unreadable', `${where}'s ${what}: ${error.message}`)
    }
  }

  const chosen = []
  if (ecosystems.has('npm')) {
    const found = []
    for (const pm of ['pnpm', 'npm', 'yarn1']) {
      const root = rootOf(`${pm} root`, () => lockfileRoot(host, pm, cwd))
      if (root === null) continue
      const names = listed[dirs.indexOf(fromRoot(root))]
      found.push(pathIn(fromRoot(root), pm === 'npm' && names.includes('npm-shrinkwrap.json') ? 'npm-shrinkwrap.json' : lockfileOf(pm)))
    }
    if (found.length === 0) {
      const bun = ['bun.lock', 'bun.lockb'].find((name) => lists(name))
      throw bun === undefined
        ? new ValidateError('no-lockfile', `no lockfile at or above ${where} locks its npm packages (pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json, yarn.lock): give --lockfile=path, or --no-lockfile to hold them to their registry alone`)
        : new ValidateError('lockfile-unsupported', `${bun}, which validate doesn't read, locks its npm packages: give --lockfile=path, or --no-lockfile to hold them to their registry alone`)
    }
    if (found.length > 1) throw new ValidateError('lockfile-ambiguous', `more than one lockfile installs ${where}: ${found.join(', ')}; give --lockfile=path`)
    chosen.push(found[0])
  }
  if (ecosystems.has('cargo')) {
    const lock = rootOf('Cargo workspace', () => findCargoLock(cwd, host))
    if (lock === null) throw new ValidateError('no-lockfile', `no Cargo.lock beside ${where}'s workspace root locks its crates: give --lockfile=path, or --no-lockfile to hold them to crates.io alone`)
    chosen.push(fromRoot(lock))
  }
  return Promise.all(chosen.map(async (path) => ({ path, text: await read(path) })))
}

export async function installedNpmPackages(dir) {
  const { root } = parsePath(dir)
  const at = (path) => join(root, ...path.split('/'))
  const found = await repositoryLockfiles({
    directory: relative(root, dir).split(sep).join('/'),
    ecosystems: new Set(['npm']),
    list: (path) => readdir(at(path)).catch(() => []),
    read: (path) => readFile(at(path), 'utf8'),
  }).catch((error) => {
    if (!(error instanceof ValidateError)) throw error
    if (error.code === 'no-lockfile') return null
    // As repositoryLockfiles tells it, but the flags validate takes in its place.
    throw new ValidateError(error.code, error.message.replace(/[:;] give --lockfile=path.*$/su, '').replace("which validate doesn't read", "which isn't read"))
  })
  if (found === null) return null
  const [{ path, text }] = found
  return { path: at(path), packages: registryPackages(text, at(path)) }
}

function registryPackages(text, path) {
  return [...lockOf(path, text).entries].filter(([, entries]) => entries.some((entry) => entry.from === 'registry')).map(([key]) => {
    const split = key.lastIndexOf('@')
    return { name: key.slice(0, split), version: key.slice(split + 1) }
  })
}

export async function lockedNpmPackages(dir) {
  const configPath = join(dir, CONFIG_FILE)
  const text = await readFile(configPath, 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw unreadableLockfile(configPath, error)
  })
  const named = text === undefined ? undefined : lockfilesNamed(configPath, text)
  if (named === undefined) {
    const one = await installedNpmPackages(dir)
    return one === null ? [] : [{ ...one, name: posix.basename(one.path.split(sep).join('/')) }]
  }
  return Promise.all(named.filter((rel) => LOCKFILES.get(posix.basename(rel)) === 'npm').map(async (rel) => {
    const path = join(dir, ...rel.split('/'))
    const lock = await readLockfileText((at) => readFile(at, 'utf8'), path)
    return { path, name: rel, packages: registryPackages(lock, path) }
  }))
}

const MOVED = new Set([301, 302, 307, 308])

// GitHub's API won't follow a redirect itself; what is read is held to the commit's and tree's ids all the same.
export function followingMoves(client, github) {
  let name = github
  let moved
  const read = (method) => async (options) => {
    try {
      return await client[method]({ ...options, repo: name })
    } catch (error) {
      if (!(error instanceof HttpError && MOVED.has(error.status))) throw error
      moved ??= client.getRepo({ repo: github, followRedirect: true }).then((info) => {
        name = info.full_name
        return name
      })
      await moved
      if (name === github) throw error
      return client[method]({ ...options, repo: name })
    }
  }
  const methods = ['getRepoTreeId', 'getRepoTreeTarball', 'listRepoDir', 'getRepoFile', 'getRepoHead', 'listRepoTags', 'listRepoBranches', 'compareCommits']
  return { name: () => name, ...Object.fromEntries(methods.map((method) => [method, read(method)])) }
}

const BRANCHES_AT_ONCE = 6
const MAX_COMPARED = 100

// Null for none, as of a fork's, which GitHub serves through its name too.
export async function historyOf(repository, commit, { maxCompared = MAX_COMPARED, deadline = Number.POSITIVE_INFINITY, now = Date.now } = {}) {
  const holds = async (ref) => {
    try {
      return ['ahead', 'identical'].includes((await repository.compareCommits({ base: commit, head: ref })).status)
    } catch (error) {
      // A commit GitHub has none of, or none in common with the ref.
      if (error instanceof HttpError && error.status === 404) return false
      throw error
    }
  }
  const head = await repository.getRepoHead({})
  if (head.oid === commit || (await holds(head.branch))) return { branch: head.branch }
  const tag = (await repository.listRepoTags({})).find((entry) => entry.oid === commit)
  if (tag) return { tag: tag.tag }
  const branches = (await repository.listRepoBranches({})).filter((entry) => entry.branch !== head.branch)
  const at = branches.find((entry) => entry.oid === commit)
  if (at) return { branch: at.branch }
  let found = null
  let compared = 0
  await eachOf(branches.slice(0, maxCompared), BRANCHES_AT_ONCE, async ({ branch }) => {
    if (found !== null || now() > deadline) return
    compared++
    if (await holds(branch)) found ??= { branch }
  })
  const left = branches.length - compared
  if (found === null && left > 0) {
    throw new ValidateError('history-unread', `${commit} is at no tag or branch head of ${repository.name()} nor in its default branch's history, and ${left} of its ${branches.length} other branches were left uncompared${now() > deadline ? ' past the deadline' : ` (${maxCompared} compared at most)`}: give --sha= a commit of its default branch or at a tag`)
  }
  return found
}

const fetchedEcosystems = (plan) => new Set(plan.packages.filter((pkg) => FETCHED.has(pkg.ecosystem) && pkg.name && pkg.version).map((pkg) => pkg.ecosystem))

function listedEntries(listed, dir = '') {
  const entries = new Map()
  for (const entry of listed) {
    const value = entry.type === 'commit' ? { submodule: true } : entry.mode === '120000' ? { symlink: '' } : entry.type === 'blob' ? { sha: entry.sha } : undefined
    if (value) entries.set(pathIn(dir, entry.path), value)
  }
  return entries
}

export async function validateRepository(plan, { repository = null, commit, directory = '' }, { own = true, lockfile = true, listTree, strict = true, fetch, deadline, generated, attested, client } = {}) {
  const ecosystems = fetchedEcosystems(plan)
  const fromRepository = lockfile === true && ecosystems.size > 0
  const beside = [...new Set(plan.packages.map((pkg) => BESIDE.get(pkg.ecosystem)).filter(Boolean))]
  const readsBeside = lockfile === true && beside.length > 0 && repository !== null && commit !== undefined
  const github = repository?.name()
  const told = (error) => {
    if (strict || !(error instanceof ValidateError)) throw error
    return error.code
  }
  let ref
  try {
    if ((own || fromRepository) && (repository === null || commit === undefined)) {
      const [code, what] = repository === null ? ['no-repository', 'repository to read it of'] : ['no-commit', 'commit to read it at']
      throw new ValidateError(code, `no ${what}: ${own ? 'its own code' : 'its lockfile'} is read of the repository`)
    }
    // At a commit of its own history alone, as GitHub serves a commit of any fork of it through its name too.
    const pinsSubmodules = plan.packages.some((pkg) => pkg.ecosystem === 'github')
    ref = repository && commit !== undefined && (own || fromRepository || readsBeside || pinsSubmodules || plan.patches.size > 0) ? await historyOf(repository, commit, { deadline }) : undefined
    if (ref === null) {
      throw new ValidateError('commit-not-in-history', `${commit} is in the history of no branch or tag of ${repository.name()} (a fork's, say, which GitHub serves through its name too): give --sha= a commit of its own`)
    }
  } catch (error) {
    const code = told(error)
    const report = await validateBundle(plan, { reason: own ? code : 'skipped' }, { fetch, deadline })
    return fromRepository ? { ...report, lockfileError: code } : report
  }
  // Own code's files, read whole or listed; awaited later, its failure then.
  const reading = own && !listTree ? repositoryFiles(repository, { commit, directory }) : null
  const listing = own && listTree
    ? listTree([...new Set([...plan.own.map((file) => pathIn(directory, file.path)), pathIn(directory, 'package.json')])].filter(inTree)).then(({ entries, cut }) => {
      const listed = listedEntries(entries)
      // The directories it lists, any entry in each: where it was cut short, those alone.
      const dirs = new Set(entries.map((entry) => posix.dirname(entry.path)))
      return { entries: listed, cut, dirs, names: Map.groupBy([...listed.keys()].filter((path) => !listed.get(path).submodule), (path) => posix.dirname(path)) }
    })
    : null
  reading?.catch(() => {})
  listing?.catch(() => {})
  const listDir = (dir) => repository.listRepoDir({ sha: commit, ...(dir && { directory: dir }) })
  const list = memoized(async (dir) => {
    const listed = await listing
    if (listed && (!listed.cut || listed.dirs.has(dir || '.'))) return (listed.names.get(dir || '.') ?? []).map((path) => posix.basename(path))
    return (await listDir(dir)).filter((entry) => entry.type === 'blob').map((entry) => entry.path)
  })
  // A directory that isn't there, as upstream tells it, holds `none`.
  const absent = (none) => (error) => {
    if (/has no directory at/u.test(error?.message ?? '')) return none
    throw error
  }
  const under = (path) => reading && (directory === '' || path === directory || path.startsWith(`${directory}/`))
  const tree = memoized((dir) => (under(dir) ? reading : repositoryFiles(repository, { commit, directory: dir }))
    .catch(absent(new Map()))
    .then((entries) => filesUnder(entries, dir)))
  const patchEntries = async () => {
    const entries = new Map()
    const dirs = new Set([...plan.patches.keys()].map((path) => repoDir(posix.dirname(pathIn(directory, path)))))
    await Promise.all([...dirs].map(async (dir) => {
      for (const [path, entry] of listedEntries(await listDir(dir).catch(absent([])), dir)) entries.set(path, entry)
    }))
    return entries
  }
  const readRepository = async (path) => {
    const held = under(path) ? (await reading).get(path)?.data : undefined
    return held ? asText.decode(held) : repository.getRepoFile({ path, ref: commit })
  }
  const git = gitReader(client)
  let locked = null
  let lockfileError
  // A patch a lockfile names by its hash alone is looked for in the project's patches directory, then the root's.
  const ofRepository = (path, besides = []) => ({
    from: 'repository', read: readRepository, tree, root: posix.relative(posix.dirname(path), directory), at: posix.relative(directory, posix.dirname(path)),
    patches: [...new Set([...besides, pathIn(directory, 'patches'), 'patches'])],
  })
  try {
    const needed = lockfile === true ? fromRepository || readsBeside : ecosystems.size > 0 || beside.length > 0
    const configured = lockfile === true && needed ? await configuredLockfiles({ directory, list, read: readRepository }) : undefined
    const readOf = (path) => readLockfileText(readRepository, path)
    const files = lockfile === false ? null : !needed ? [] : lockfile !== true ? lockfile.map((one) => ({ git, ...one }))
      : configured !== undefined
        ? await Promise.all(configured.filter((path) => LOCKFILES.has(posix.basename(path))).map(async (path) => ({ path, text: await readOf(path), git, ...ofRepository(path, [pathIn(repoDir(posix.dirname(path)), 'patches')]) })))
        : [
          ...ecosystems.size > 0 ? await repositoryLockfiles({ directory, ecosystems, list, read: readRepository }) : [],
          ...readsBeside ? await besideLockfiles({ directory, names: beside, list, read: readRepository }) : [],
        ].map((one) => ({ ...one, git, ...ofRepository(one.path) }))
    const held = files && lockedBy(files)
    for (const ecosystem of held ? ecosystems : []) {
      if (held.locks(ecosystem)) continue
      throw new ValidateError('no-lockfile', configured === undefined
        ? `no lockfile given locks its ${ecosystem} packages: give it with --lockfile=path, or --no-lockfile to hold them to their registry alone`
        : `none of the lockfiles ${pathIn(directory, CONFIG_FILE)} names locks its ${ecosystem} packages: give one with --lockfile=path, or --no-lockfile to hold them to their registry alone`)
    }
    locked = held
  } catch (error) {
    lockfileError = told(error)
  }
  const read = reading?.then((entries) => ({ entries })) ?? listing?.then(({ entries, cut }) => ({ entries, cut }))
    ?? (repository && commit !== undefined && plan.patches.size > 0 ? patchEntries().then((entries) => ({ reason: 'skipped', entries })) : null)
  const checked = read ? read.then((found) => ({ ...found, repository: repository.name(), ...(repository.name() !== github && { movedFrom: github }), commit, ref, directory })) : { reason: 'skipped' }
  const submoduleAt = async (dir) => {
    const path = pathIn(directory, dir)
    const entry = (await listDir(repoDir(posix.dirname(path))).catch(() => [])).find((one) => one.path === posix.basename(path) && one.type === 'commit')
    return entry?.sha ?? null
  }
  const submodules = ref && client ? { at: submoduleAt, read: git } : undefined
  const [report, stasisLockfile] = await Promise.all([validateBundle(plan, checked, { fetch, locked, submodules, deadline, generated }), ref && attested ? heldToCommitted(attested, directory, list, readRepository) : undefined])
  return { ...report, ...(stasisLockfile && { stasisLockfile, ...(stasisLockfile.error && { status: 'invalid' }) }), ...(lockfileError && { lockfileError }) }
}

const gitReader = (client) => client && (async ({ github, commit, path }) => filesUnder(await repositoryFiles(followingMoves(client, github), { commit, directory: path }), path))

// Held as `stasis bundle` holds a build to the stasis.lock.json the repository commits.
async function heldToCommitted(attested, directory, list, read) {
  const listed = await list(directory).catch((error) => {
    if (error instanceof HttpError && error.status === 404) return []
    throw error
  })
  if (!listed.includes(LOCK_FILE)) return undefined
  const path = pathIn(directory, LOCK_FILE)
  try {
    const committed = Lockfile.parse(await read(path))
    const artifact = attested()
    committed.mergeAgreeing(artifact, path, { held: true })
    // A build held to it records what it does of a module: one the artifact has none of contradicts it.
    for (const [dir, info] of artifact.modules) {
      if (committed.modules.has(dir)) assertAttested(committed.modules.get(dir), info, `${path}: module '${dir}'`)
    }
    return { path }
  } catch (error) {
    return { path, error: error.message }
  }
}

export async function validate(file, { client, github, sha, directory, own = true, lockfile = true, fetch, deadline } = {}) {
  const { kind, artifact } = parseFileWithKind(file)
  const plan = validationPlan(artifact, { lockfile: kind === 'lockfile' })
  const attested = () => (kind === 'lockfile' ? artifact : Lockfile.fromBundle(artifact, (path, content) => bundledIntegrity(content, artifact.formats?.get(path))))
  const repo = artifact.repo ?? {}
  const where = { github: github ?? repo.github, commit: sha ?? repo.commit, directory: directory ?? repo.directory ?? '' }
  const readLocal = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      throw unreadableLockfile(path, error)
    }
  }
  // Each read as it is held to, once the commit is: none where no package needs one.
  const lockfiles = Array.isArray(lockfile) ? lockfile.map((path) => ({ path, get text() { return readLocal(path) }, from: 'local', read: readLocal, root: where.directory })) : lockfile
  const repository = where.github === undefined ? null : followingMoves(client, where.github)
  const generated = own && client && repository && where.commit !== undefined
    ? async () => (await import('./vfs-bundle/github.js')).repoPrismaClients({ github: repository.name(), sha: where.commit, directory: where.directory, client })
    : undefined
  try {
    return await validateRepository(plan, { repository, commit: where.commit, directory: where.directory }, { own, lockfile: lockfiles, fetch, deadline, generated, attested, client })
  } catch (error) {
    if (!(error instanceof ValidateError) || !['no-repository', 'no-commit'].includes(error.code)) throw error
    const fromRepository = lockfile === true && fetchedEcosystems(plan).size > 0
    const or = !own ? 'or --lockfile=path, or --no-lockfile to hold its dependencies to their registry alone'
      : fromRepository ? 'or, to validate its dependencies alone, --only-deps with --lockfile=path or --no-lockfile' : 'or --only-deps to validate its dependencies alone'
    const what = own ? 'its own code' : 'its lockfile'
    throw error.code === 'no-repository'
      ? new ValidateError('no-repository', `${file} records no repository to read ${what} of: give --github=owner/name and --sha=commit, ${or}`)
      : new ValidateError('no-commit', `${file} records no commit to read ${what} at: give --sha=commit, ${or}`)
  }
}

const TONES = { differs: 'red', unexpected: 'red', invalid: 'red', unverified: 'yellow', incomplete: 'yellow', valid: 'green', generated: 'green' }

export function printValidationReport(report, { out = process.stdout, err = process.stderr, showValid = false, colors } = {}) {
  const paintOut = painter(out, colors)
  const paintErr = painter(err, colors)
  const status = (paint) => (text, column, row) => paint(column === 'status' ? TONES[row.status] : column === 'of' && row.of === 'own code' ? DIM : null, text)
  const tables = []
  const files = [...Map.groupBy(report.problems, (problem) => `${problem.kind}\0${problem.of}`).values()].map((group) => ({
    status: group[0].kind,
    of: group[0].of === 'own' ? 'own code' : group[0].of.replace(/^npm:/u, ''),
    files: group.map((problem) => `${problem.path}${problem.reason ? ` (${FILE_REASONS[problem.reason] ?? problem.reason})` : ''}`).join('\n'),
  }))
  if (files.length > 0) tables.push(formatTable(files, ['status', 'of', 'files'], { multiline: ['files'], paint: status(paintOut) }) + (report.moreProblems > 0 ? `\n... and ${report.moreProblems} more files` : ''))
  const told = report.packages.filter((pkg) => (showValid || pkg.status !== 'valid') && noteText(pkg) !== '')
  const ecosystems = told.some((pkg) => pkg.ecosystem !== 'npm')
  const packages = told.map((pkg) => ({ status: pkg.status, ...(ecosystems && { ecosystem: pkg.ecosystem }), package: `${pkg.name}@${pkg.version}`, note: noteText(pkg) }))
  if (packages.length > 0) tables.push(formatTable(packages, ['status', ...(ecosystems ? ['ecosystem'] : []), 'package', 'note'], { paint: status(paintOut) }))
  const generated = (report.generated ?? []).map((client) => ({ status: 'generated', of: generatedBy(client), files: client.files.join('\n') }))
  if (generated.length > 0) tables.push(formatTable(generated, ['status', 'of', 'files'], { multiline: ['files'], paint: status(paintOut) }))
  if (tables.length > 0) out.write(`${tables.join('\n\n')}\n`)

  const { counts, own } = report
  const lines = [
    `${paintErr(['bold', TONES[report.status]], report.status)}: ${counts.matched} of ${counts.files} files as they should be, ${counts.differs} differ, ${counts.unexpected} unexpected, ${counts.unverified} unverified${counts.skipped ? `, ${counts.skipped} skipped` : ''}; ${counts.validPackages} of ${counts.packages} packages as published${counts.lockFailures ? `, ${counts.lockFailures} failing their lockfile` : ''}${counts.misplaced ? `, ${counts.misplaced} installed where another is` : ''}${counts.eol ? `; ${counts.eol} with a checkout's CRLF line endings` : ''}${counts.generated ? `; ${counts.generated} generated by the repository's Prisma schemas` : ''}`,
    own.checked ? `Own code held to ${own.repository}${own.movedFrom ? ` (moved from ${own.movedFrom})` : ''} at ${own.commit}${own.ref ? (own.ref.tag ? `, tag ${own.ref.tag}` : ` of ${own.ref.branch}`) : ''}${own.directory ? ` under ${own.directory}` : ''}`
      : paintErr('yellow', `Own code not verified: ${OWN_REASONS[own.reason] ?? own.reason}${own.patches ? `; the ${own.patches === 1 ? 'patch' : `${own.patches} patches`} the bundle holds checked all the same` : ''}`),
    ...(report.generatedError === undefined ? [] : [paintErr('yellow', `No Prisma Client generated to hold the files the repository doesn't hold to: ${report.generatedError}`)]),
    ...(report.stasisLockfile ? [report.stasisLockfile.error ? paintErr('red', `Contradicts ${report.stasisLockfile.path}: ${report.stasisLockfile.error}`) : `Held to ${report.stasisLockfile.path}`] : []),
    ...(report.lockfiles?.length > 0 ? [`Dependencies held to ${report.lockfiles.join(', ')}`]
      : report.lockfiles === null && counts.packages > 0
        ? [paintErr('yellow', `Dependencies held to no lockfile (${report.lockfileError ? LOCKFILE_ERRORS[report.lockfileError] ?? report.lockfileError : '--no-lockfile'}): each to its registry's integrity alone`)] : []),
  ]
  err.write(`${lines.join('\n')}\n`)
}
