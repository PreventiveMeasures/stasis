// `stasis validate`: whether a bundle holds what it says it does. Every file of its own code must be
// the repository's at the commit its `repo` names, under the directory it was built in; every file of
// a dependency must be its published package's, fetched with upstream (npm's registry, crates.io),
// which holds each tarball to the integrity the lockfile installing the bundle locks it with; and
// those two must cover every file it holds. A dependency's files a bundle leaves out are expected: it
// holds those its code reaches alone.
//
// Own code is the files of modules naming no ecosystem (dependencyEcosystem): the project's and its
// workspace's packages. The CLI reads the repository's tree with upstream, its tarball held to the
// tree's id; validateBundle takes any reading of it, as file bytes or as git's blob ids (a listing of
// the tree, as a server may read it). A file whose only difference is a checkout's CRLFs passes,
// counted apart (`eol`).
//
// A dependency's version is fetched once, and each installed copy of it (its module) held to its
// files as published, or patched where pnpm patches it (its lockfile's patchedDependencies), as pnpm
// patches them as it installs them: patch-package's applyPatch, which pnpm bundles, each hunk found
// where its header says, else up to FUZZ lines either side, its lines the same but for the space
// they end in. The patch is the lockfile's (`locked`), read of the bundle where it holds a file of its
// hash, else of the repository; with no lockfile read, the one the bundle holds named for the version,
// pnpm's way (`patches/name@version.patch`). Ecosystems upstream fetches no package of by name and
// version alone (Composer's, Soldeer's, a crate from git), versions the lockfile locks from git
// (which npm may build as it installs them) or from elsewhere than their registry, and versions it
// fails to fetch, are left unverified. A version the lockfile doesn't lock, or whose registry's
// tarball isn't the one it locks, fails.
//
// Stasis's empty stub for an import a package disables (EMPTY_MODULE_PATH) is no file of either, and
// is allowed. A vendored crate's `.cargo-checksum.json`, which `cargo vendor` writes and no crate
// holds, is held to the crate instead: its package checksum, and each file's it lists.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'

import { EMPTY_MODULE_PATH, dependencyEcosystem, hasNodeModulesSegment, isStatFormat, moduleFileKey } from '@exodus/stasis-core/util'
import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { getCrate } from '@preventive/upstream/cargo.js'
import { HttpError, getTarball } from '@preventive/upstream/npm.js'
import { parseCargoChecksum, parseCargoLock } from '@preventive/lockfile/cargo.js'
import { parseNpmLockfile } from '@preventive/lockfile/npm.js'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'

import { parseFileWithKind } from './parse.js'
import { matchesGlob } from './vfs-bundle/glob.js'

// The files told failing, and the packages told, past which they are counted.
export const MAX_TOLD = 500
// Versions fetched at once.
const PACKAGES_AT_ONCE = 6
// How many lines either side of where its header says a hunk is looked for, as patch-package does.
const FUZZ = 20
// What a tarball may unpack to, as upstream's tree verification bounds one.
const MAX_TAR_BYTES = 2 ** 30

const utf8 = new TextEncoder()
// A byte order mark kept, as Node's readFileSync keeps it, and patch-package with it: a patch applied
// changes no byte but those its hunks change.
const asText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// A failure to read or apply a patch, by its `code` (patch-unreadable, patch-unsupported,
// patch-does-not-apply, and patch-mismatch for one read not of the hash its lockfile names it by).
export class PatchError extends Error {
  constructor(code) {
    super(code)
    this.name = 'PatchError'
    this.code = code
  }
}

// Why `validate` won't check a file, by its `code`: it is a lockfile (`not-a-bundle`); the bundle's
// own code, or its lockfile, has no repository (`no-repository`) or commit (`no-commit`) to be read
// of, given or recorded, and neither its dependencies alone (`own: false`, --only-deps) nor another
// lockfile or none (`lockfile`, --lockfile, --no-lockfile) were asked for; or no lockfile it can read
// locks its dependencies (`no-lockfile`, `lockfile-ambiguous`, `lockfile-unsupported`,
// `lockfile-unreadable`).
export class ValidateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ValidateError'
    this.code = code
  }
}

// The ecosystem a module's files are a dependency's of, or undefined for own code: the root's and an
// npm-tagged module's outside node_modules (a workspace package's) are own code whatever they record,
// as a bundle built before only dependencies were tagged may record one.
const moduleEcosystem = (dir, ecosystem) => (dir === '.' || (ecosystem === 'npm' && !hasNodeModulesSegment(dir)) ? undefined : dependencyEcosystem(dir, ecosystem))

// What a bundle's files are, as validation checks them: its own code, `{ path, dir, rel, bytes() }`
// each, and each package version's, `{ ecosystem, name, version, files }`, one with no name or
// version among them; the patches it holds (`patches`, their text by path); and how many files.
// Directories and stat records, which are no files, and Stasis's empty stub are left out.
export function validationPlan(bundle) {
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
      const file = { path, dir, rel, bytes: () => (format === 'resource:base64' ? Buffer.from(content, 'base64') : utf8.encode(content)) }
      if (ecosystem !== undefined) {
        if (!packages.has(key)) packages.set(key, { ecosystem, name: info.name ?? '', version: info.version ?? '', files: [] })
        packages.get(key).files.push(file)
      } else if (path !== EMPTY_MODULE_PATH || content !== '') {
        if (format === 'patch' || path.endsWith('.patch')) patches.set(path, content)
        own.push(file)
      }
    }
  }
  const listed = [...packages.values()]
  return { files: listed.reduce((sum, pkg) => sum + pkg.files.length, own.length), own, packages: listed, patches }
}

// Git's id of a blob of `bytes`.
export const gitBlobId = (bytes) => createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')

// A gzipped tarball's files by their paths, its one top directory left out, as npm unpacks a package
// (and crates.io's crates, and GitHub's trees, have one too); its directories left out, and a symlink
// `{ symlink }`.
export async function tarballFiles(tarball) {
  const files = new Map()
  for (const entry of unpack(await decompress(tarball, 'gzip', { limit: MAX_TAR_BYTES }), { symlinksAbove: Number.MAX_SAFE_INTEGER })) {
    const name = entry.name.slice(entry.name.indexOf('/') + 1)
    if (!entry.name.includes('/') || name === '' || entry.type === 'directory') continue
    files.set(name, entry.type === 'symlink' ? { symlink: entry.linkname } : entry.data)
  }
  return files
}

// Ecosystems upstream fetches a version of by its name and version alone, and that version's files,
// by their paths, as `fetchPackage` gives them; a crate's with its sha256 in hex (`checksum`), which
// a vendored copy's `.cargo-checksum.json` names. With `integrity`, the one a lockfile locks it with
// (an npm version's sha512, a crate's sha256 in hex), upstream holds the tarball to that in place of
// its registry's, and refuses one that differs (fetchFailure's `integrity-mismatch`).
export const FETCHED = new Set(['npm', 'cargo'])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
// npm's registry's tarball of a version, as upstream takes a dist of one.
const npmTarball = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
export async function fetchPackage(ecosystem, name, version, integrity) {
  const tarball = ecosystem === 'npm'
    ? await getTarball(name, version, integrity === undefined ? undefined : { tarball: npmTarball(name, version), integrity })
    : await getCrate(name, version, integrity)
  const files = new Map([...await tarballFiles(tarball)].filter(([, data]) => data instanceof Uint8Array))
  if (ecosystem === 'cargo') files.checksum = sha256(tarball)
  return files
}

// Whether a vendored crate's `.cargo-checksum.json` (its `bytes`) is of `crate`, its files as fetched:
// each file it lists the crate's, by its sha256, and its package checksum the crate's where the
// fetch tells it.
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
const CARGO_CHECKSUM = '.cargo-checksum.json'

// Why a version wasn't checked: none published of it (`not-published`), its registry refusing it
// (`unreadable`), its tarball not the one its lockfile locks (`integrity-mismatch`, as upstream
// refuses it), or another failure (`failed`). A `fetch` of a caller's throws upstream's HttpError,
// re-exported, for the first two.
export { HttpError }
export function fetchFailure(error) {
  if (error instanceof HttpError) return error.status === 404 ? 'not-published' : [401, 403].includes(error.status) ? 'unreadable' : 'failed'
  if (error?.code === 'ERR_ASSERTION' && /integrity mismatch/u.test(error.message)) return 'integrity-mismatch'
  return 'failed'
}

// Whether `text` is the patch `hash` names, as pnpm hashes one: of its text with its CRLFs as LFs, a
// sha256 in hex from pnpm 10, an md5 in base32 before; or as it is.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
function base32(bytes) {
  let bits = 0
  let spelled = ''
  let value = 0
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff
    bits += 8
    for (; bits >= 5; bits -= 5) spelled += BASE32[(value >>> (bits - 5)) & 31]
  }
  return bits > 0 ? spelled + BASE32[(value << (5 - bits)) & 31] : spelled
}
const patchHashes = (text) => new Set([...new Set([text.replaceAll('\r\n', '\n'), text])]
  .flatMap((read) => [createHash('sha256').update(read).digest('hex'), base32(createHash('md5').update(read).digest())]))
export const isPatchOf = (text, hash) => patchHashes(text).has(hash)

// A path as git writes it, unquoted where quoted (as C writes a string, bytes past ASCII in octal);
// null where it is quoted otherwise.
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
// A path in a package: relative, of names none empty, `.` or `..`.
const inPackage = (path) => path.length > 0 && path.split('/').every((name) => name !== '' && name !== '.' && name !== '..')

// A side's path, as a `---` or `+++` line names it after its prefix, git's tab after one with a space
// in it left out; null for none (`/dev/null`).
function sidePath(named, prefix) {
  const path = unquoted(named.endsWith('\t') ? named.slice(0, -1) : named)
  if (path === '/dev/null') return null
  if (path === null || !path.startsWith(prefix)) throw unreadable()
  return path.slice(prefix.length)
}

// The path a `diff --git` line names on both sides, as git writes it of a file neither renamed nor
// copied.
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

// The hunk whose `@@` line is at `at` of `lines`, those before `end` read, and the line after it, as
// patch-package reads one.
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

// A patch's files as git's diff writes them, as pnpm writes a patch: each one's path, the one it was
// renamed `from`, whether it is `deleted` or `created`, and its hunks. One whose lines end in CRLFs is
// read as patch-package reads it: its headers but their CRs, its hunks' lines with them. Throws a
// PatchError for one it can't read, or of a file's bytes.
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

// The changes `hunk` makes where its lines are at `start` of `lines`, as patch-package works them out:
// those it finds the same but for the space they end in; else null.
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

// `text` with `hunks` applied as patch-package applies them: each found in the text as it was, where
// its header says, else as near as FUZZ lines either side, the nearer first; then its changes made in
// turn, past the lines those before added or removed.
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

// A version's `files` (bytes by path) with `patch` applied; a file it changes the text of must be
// UTF-8 text. One it creates holds its first hunk's first lines, as patch-package writes it.
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

const equal = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b)
const packageKey = ({ ecosystem, name, version }) => `${ecosystem}:${name}@${version}`
const byText = (key) => (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
// The name pnpm gives a version's patch file, `@scope__name@1.0.0.patch`.
const pnpmPatchName = (name, version) => `${name.replace('/', '__')}@${version}.patch`

// The patches a plan holds, by each hash pnpm may name one by and by their file names, worked out once.
const heldPatches = new WeakMap()
function patchesOf(plan) {
  if (!heldPatches.has(plan)) {
    const byHash = new Map()
    const byName = new Map()
    for (const held of plan.patches) {
      for (const hash of patchHashes(held[1])) if (!byHash.has(hash)) byHash.set(hash, held)
      const name = held[0].split('/').at(-1)
      if (!byName.has(name)) byName.set(name, held)
    }
    heldPatches.set(plan, { byHash, byName })
  }
  return heldPatches.get(plan)
}

// The patch an npm version is held to, and its files patched with it: the one `locked` locks it with,
// of the bundle's file of its hash, else read by `locked.read`; with no lockfile read (`locked.of`
// answering undefined), the bundle's named for it. None where it is patched by none; told with its
// `error` where it couldn't be read or applied.
async function patchOf(plan, pkg, files, locked) {
  const lock = locked?.of(pkg.name, pkg.version)
  const held = patchesOf(plan)
  let patch
  let text
  try {
    if (lock) {
      const bundled = held.byHash.get(lock.hash)
      if (bundled) {
        patch = { hash: lock.hash, path: bundled[0], from: 'bundle' }
        text = bundled[1]
      } else if (lock.path) {
        patch = { hash: lock.hash, path: lock.path, from: locked.from ?? 'repository' }
        text = await locked.read(lock.hash, lock.path)
        // Held to the hash the lockfile names it by, as the bundle's are found by it.
        if (!isPatchOf(text, lock.hash)) throw new PatchError('patch-mismatch')
      } else return { patch: { hash: lock.hash, error: 'patch-not-found' }, patched: null }
    } else if (lock === undefined) {
      const named = held.byName.get(pnpmPatchName(pkg.name, pkg.version))
      if (!named) return { patched: null }
      patch = { path: named[0], from: 'bundle' }
      text = named[1]
    } else return { patched: null }
    return { patch, patched: patchedFiles(files, parsePatch(text)) }
  } catch (error) {
    return { patch: { ...patch, error: error instanceof PatchError ? error.code : 'patch-unreadable' }, patched: null }
  }
}

// `items` each run through `run`, `parallel` at a time.
async function eachOf(items, parallel, run) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => {
    // eslint-disable-next-line no-await-in-loop -- a worker takes the next item once its own is done
    while (next < items.length) await run(items[next++])
  }))
}

// The bundle `plan` validated (validationPlan): its own code against `own`, the repository's files at
// its commit (`entries`, by their paths from the repository's root, each `{ data }` (bytes), `{ sha }`
// (git's blob id), `{ symlink }` or `{ submodule: true }`; `cut` where some were left unread), at
// `repository`, `commit` and `directory`, the one it was built in; or `{ reason }` it wasn't checked.
// Each package fetched with `fetch` (fetchPackage), PACKAGES_AT_ONCE at a time, those left past
// `deadline` unverified; each as its lockfile locks it (`locked`, lockedBy): `lock(ecosystem, name,
// version)`, how (undefined where no lockfile of its ecosystem was read, null where it locks none):
// one of its registry fetched with its `integrity`, failing where upstream refuses the tarball, or
// where none is locked; one from git or elsewhere left unverified. An npm version held to its files
// patched where pnpm patches it (`of(name, version)`, the patch it locks it with, null for none,
// undefined where no lockfile tells; `read(hash, path)`, the patch's text).
//
// What it tells: its `status`, `valid` where every file was checked and is as it should be, `invalid`
// where one differs (`differs`) or is neither the repository's nor its package's (`unexpected`), or a
// version fails its lockfile (`lockFailures`), else `incomplete`; the lockfiles held to
// (`lockfiles`, null for none); whether its own code was checked (`own`); how many files of each kind and outcome
// (`counts`); each file failing, and each own one left unverified, with what it is of (`own`, or
// `ecosystem:name@version`), as many as MAX_TOLD (`problems`, how many more `moreProblems`); and each
// version not wholly valid or patched (`packages`), a patched one's patch with, where it is valid,
// whether a copy of it holds its files patched (`applied`).
export async function validateBundle(plan, own, { fetch = fetchPackage, locked = null, deadline = Number.POSITIVE_INFINITY, now = Date.now } = {}) {
  const problems = []
  const counts = { files: plan.files, own: plan.own.length, dependencies: plan.files - plan.own.length, matched: 0, eol: 0, differs: 0, unexpected: 0, unverified: 0,
    packages: plan.packages.length, validPackages: 0, lockFailures: 0 }
  const tell = (problem) => {
    counts[problem.kind]++
    problems.push(problem)
  }

  // The packages fetched while own code is checked.
  const told = []
  const fetching = eachOf(plan.packages, PACKAGES_AT_ONCE, async (pkg) => {
    const of = packageKey(pkg)
    const tellPackage = (status, more) => told.push({ ecosystem: pkg.ecosystem, name: pkg.name, version: pkg.version, files: pkg.files.length, status, ...more })
    const unverified = (reason) => {
      counts.unverified += pkg.files.length
      tellPackage('unverified', { reason })
    }
    // Failing its lockfile, its files left unchecked: not what was installed, or not known to be.
    const fails = (reason) => {
      counts.unverified += pkg.files.length
      counts.lockFailures++
      tellPackage('invalid', { reason })
    }
    if (!pkg.name || !pkg.version) return unverified('unnamed')
    if (!FETCHED.has(pkg.ecosystem)) return unverified('unsupported')
    const lock = locked?.lock?.(pkg.ecosystem, pkg.name, pkg.version)
    if (lock === null) return fails('not-locked')
    if (lock?.from === 'git') return unverified('git')
    if (lock?.from === 'elsewhere') return unverified('not-registry')
    if (lock?.conflict) return fails('integrity-conflict')
    if (lock && lock.integrity === undefined) return unverified('no-integrity')
    if (now() > deadline) return unverified('timeout')
    let files
    try {
      files = await fetch(pkg.ecosystem, pkg.name, pkg.version, lock?.integrity)
    } catch (error) {
      const reason = fetchFailure(error)
      return reason === 'integrity-mismatch' ? fails(reason) : unverified(reason)
    }
    const { patch, patched } = pkg.ecosystem === 'npm' ? await patchOf(plan, pkg, files, locked) : {}
    // A crate's `.cargo-checksum.json` held to the crate, as no crate holds one.
    const checksum = (file) => pkg.ecosystem === 'cargo' && file.rel === CARGO_CHECKSUM
    const matches = (file, bytes, candidate) => (checksum(file) ? checksumOf(bytes, candidate) : candidate.has(file.rel) && equal(bytes, candidate.get(file.rel)))
    // Each installed copy apart, as one may be patched and another not: held to its files patched,
    // else, where they all are as published, to those.
    let missed = 0
    let asPatched = 0
    for (const copy of Map.groupBy(pkg.files, (file) => file.dir).values()) {
      const bytes = new Map(copy.map((file) => [file, file.bytes()]))
      const missing = (candidate) => copy.filter((file) => !matches(file, bytes.get(file), candidate))
      let held = patched ?? files
      let misses = missing(held)
      if (patched && misses.length > 0 && missing(files).length === 0) [held, misses] = [files, []]
      for (const file of misses) tell({ path: file.path, kind: checksum(file) || held.has(file.rel) ? 'differs' : 'unexpected', of })
      missed += misses.length
      if (misses.length === 0 && held === patched) asPatched++
    }
    counts.matched += pkg.files.length - missed
    const valid = missed === 0
    if (valid) counts.validPackages++
    if (!valid || patch) tellPackage(valid ? 'valid' : 'invalid', patch && { patch: { ...patch, ...(patched && valid && { applied: asPatched > 0 }) } })
    return undefined
  })

  if ('reason' in own) counts.unverified += plan.own.length
  else {
    const at = (path) => (own.directory ? `${own.directory}/${path}` : path)
    const submodules = [...own.entries].filter(([, entry]) => entry.submodule).map(([path]) => `${path}/`)
    for (const file of plan.own) {
      const path = at(file.path)
      const entry = own.entries.get(path)
      if (entry === undefined || entry.submodule) {
        const inSubmodule = entry?.submodule || submodules.some((prefix) => path.startsWith(prefix))
        tell({ path: file.path, kind: own.cut && !inSubmodule ? 'unverified' : 'unexpected', of: 'own', ...(inSubmodule ? { reason: 'submodule' } : own.cut ? { reason: 'tree-cut' } : {}) })
        continue
      }
      if (entry.symlink !== undefined) {
        tell({ path: file.path, kind: 'differs', of: 'own', reason: 'symlink' })
        continue
      }
      const bytes = file.bytes()
      const same = (candidate) => (entry.data === undefined ? gitBlobId(candidate) === entry.sha : equal(candidate, entry.data))
      if (same(bytes)) {
        counts.matched++
        continue
      }
      // As a checkout with CRLF line endings writes it, of the file the repository has with LFs.
      const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      if (view.includes('\r\n') && same(Buffer.from(view.toString('latin1').replaceAll('\r\n', '\n'), 'latin1'))) {
        counts.matched++
        counts.eol++
        continue
      }
      tell({ path: file.path, kind: 'differs', of: 'own' })
    }
  }
  await fetching

  return {
    validatedAt: now(),
    status: counts.differs + counts.unexpected + counts.lockFailures > 0 ? 'invalid' : counts.unverified > 0 ? 'incomplete' : 'valid',
    own: 'reason' in own ? { checked: false, reason: own.reason } : { checked: true, repository: own.repository, commit: own.commit, directory: own.directory, ...(own.cut && { cut: true }) },
    lockfiles: locked?.lockfiles ?? null,
    counts,
    problems: problems.toSorted(byText((problem) => problem.path)).slice(0, MAX_TOLD),
    moreProblems: Math.max(0, problems.length - MAX_TOLD),
    packages: told.toSorted(byText(packageKey)).slice(0, MAX_TOLD),
  }
}

// The repository's files under `directory` at `commit`, as `validateBundle` takes them (by their paths
// from the repository's root): its tree's tarball, which upstream holds to the tree's id, its symlinks
// climbing as far as the repository's root.
export async function repositoryFiles(client, { github, commit, directory = '' }) {
  const tree = await client.getRepoTreeId({ repo: github, sha: commit, ...(directory && { directory }) })
  const tarball = await client.getRepoTreeTarball({ repo: github, tree, symlinksAbove: directory ? directory.split('/').length - 1 : 0 })
  const entries = new Map()
  for (const [path, value] of await tarballFiles(tarball)) entries.set(directory ? `${directory}/${path}` : path, value instanceof Uint8Array ? { data: value } : value)
  return entries
}

// The lockfiles validation reads, by their names, and the ecosystem each locks the packages of.
const LOCKFILES = new Map([['pnpm-lock.yaml', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['package-lock.json', 'npm'], ['yarn.lock', 'npm'], ['Cargo.lock', 'cargo']])
// crates.io's index, by the sources a Cargo.lock names it by.
const CRATES_IO = new Set(['registry+https://github.com/rust-lang/crates.io-index', 'sparse+https://index.crates.io/'])

// Whether `tarball` is a registry's of `name` and `version`, npm's or a mirror's of it, by its path:
// none, as npm writes one of its registry's where set to, is.
function registryTarball(tarball, name, version) {
  if (tarball === undefined) return true
  const url = URL.parse(tarball)
  return url !== null && /^https?:$/u.test(url.protocol) && url.pathname.endsWith(`/${name}/-/${name.split('/').at(-1)}-${version}.tgz`)
}

// The one sha512 an SRI holds, as upstream takes one; undefined where it holds none, or two.
function sha512Of(integrity) {
  const found = new Set((integrity ?? '').split(/\s+/u).filter((token) => token.startsWith('sha512-')).map((token) => token.split('?')[0]))
  return found.size === 1 ? [...found][0] : undefined
}

// A text without the byte order mark it starts with, as npm, pnpm and yarn read their manifests and
// lockfiles, and Stasis its manifests (packageJSONText).
const withoutBom = (text) => (text.charCodeAt(0) === 0xFE_FF ? text.slice(1) : text)

// What the lockfile `name` (its file name) of `text` locks: its ecosystem; each version by name and
// version, an entry for each time it locks it, `{ from: 'registry', integrity }` (an npm version's
// sha512, a crate's sha256), `{ from: 'git' }` (a git repository, or a git host's tarball) or
// `{ from: 'elsewhere' }` (another tarball, a directory, a package another bundles); and, of pnpm's,
// the patch it locks each version with, null for none (`hashes`), and each patch's file (`paths`).
function readLockfile(name, read) {
  // cargo reads Cargo.lock as it is.
  const text = name === 'Cargo.lock' ? read : withoutBom(read)
  const entries = new Map()
  const add = (pkg, version, entry) => entries.set(`${pkg}@${version}`, [...(entries.get(`${pkg}@${version}`) ?? []), entry])
  if (name === 'pnpm-lock.yaml') {
    const { lockfile } = parsePnpmLockfile(text)
    const hashes = new Map()
    for (const [key, pkg] of Object.entries(lockfile?.packages ?? {})) {
      if (pkg.version === undefined) continue
      // A registry version's key is its name and version, its peers and patch after them.
      const ref = key.slice(pkg.name.length + 1)
      const { resolution } = pkg
      add(pkg.name, pkg.version, resolution.type === 'git' || resolution.gitHosted === true ? { from: 'git' }
        : ref === pkg.version || ref.startsWith(`${pkg.version}(`) ? { from: 'registry', integrity: sha512Of(resolution.integrity) } : { from: 'elsewhere' })
      hashes.set(`${pkg.name}@${pkg.version}`, pkg.patchHash ?? null)
    }
    const paths = new Map(Object.values(lockfile?.patchedDependencies ?? {}).map(({ hash, path }) => [hash, path]))
    return { ecosystem: 'npm', entries, patches: { hashes, paths } }
  }
  if (name === 'Cargo.lock') {
    for (const pkg of Object.values(parseCargoLock(text).packages)) {
      add(pkg.name, pkg.version, CRATES_IO.has(pkg.source) ? { from: 'registry', integrity: pkg.checksum } : pkg.source?.startsWith('git+') ? { from: 'git' } : { from: 'elsewhere' })
    }
    return { ecosystem: 'cargo', entries }
  }
  const packages = name === 'yarn.lock' ? new Set(Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages))
    : Object.values(parseNpmLockfile(text, { checkVersions: false }).packages)
  for (const { name: pkg, version, resolution } of packages) {
    if (version === undefined) continue
    add(pkg, version, resolution?.type === 'git' ? { from: 'git' }
      : resolution?.type === 'tarball' && registryTarball(resolution.tarball, pkg, version) ? { from: 'registry', integrity: sha512Of(resolution.integrity) } : { from: 'elsewhere' })
  }
  return { ecosystem: 'npm', entries }
}

// What `lockfiles` lock, as validateBundle takes it (`locked`), one of each ecosystem: each `{ path,
// text, from, read }`, its path (as it is told), what it is read of (`repository`, or `local`) and
// `read(path)` reading a file by a path as it is (a pnpm patch's, by the lockfile's directory and
// the path it names). Their paths (`lockfiles`), and whether one locks an ecosystem's packages
// (`locks(ecosystem)`), told too.
export function lockedBy(lockfiles) {
  const by = new Map()
  for (const file of lockfiles) {
    const name = posix.basename(file.path)
    if (!LOCKFILES.has(name)) throw new ValidateError('lockfile-unsupported', `${file.path}: not a lockfile validate reads (${[...LOCKFILES.keys()].join(', ')})`)
    if (by.has(LOCKFILES.get(name))) throw new ValidateError('lockfile-ambiguous', `${by.get(LOCKFILES.get(name)).path} and ${file.path} both lock ${LOCKFILES.get(name)} packages: give one`)
    let read
    try {
      read = readLockfile(name, file.text)
    } catch (error) {
      throw new ValidateError('lockfile-unreadable', `${file.path}: ${error.message}`)
    }
    by.set(read.ecosystem, { ...read, file })
  }
  const pnpm = by.get('npm')?.patches
  return {
    lockfiles: [...by.values()].map(({ file }) => file.path),
    locks: (ecosystem) => by.has(ecosystem),
    lock(ecosystem, name, version) {
      const entries = by.get(ecosystem)?.entries
      if (entries === undefined) return undefined
      const locks = entries.get(`${name}@${version}`)
      if (locks === undefined) return null
      const integrities = new Set(locks.filter((entry) => entry.from === 'registry').map((entry) => entry.integrity))
      if (integrities.size === 0) return { from: locks.every((entry) => entry.from === 'git') ? 'git' : 'elsewhere' }
      return integrities.size === 1 ? { from: 'registry', integrity: [...integrities][0] } : { from: 'registry', conflict: true }
    },
    of(name, version) {
      if (pnpm === undefined) return undefined
      const hash = pnpm.hashes.get(`${name}@${version}`)
      if (hash == null) return hash
      const path = pnpm.paths.get(hash)
      return { hash, ...(path && { path: posix.join(posix.dirname(by.get('npm').file.path), path) }) }
    },
    from: by.get('npm')?.file.from,
    read: (_hash, path) => by.get('npm').file.read(path),
  }
}

// The globs a package.json declares its workspaces by, as npm and yarn 1 read them: a sequence, or
// yarn's `{ packages }` of one; none where it declares none.
function workspaceGlobs(json) {
  const declared = json?.workspaces
  const globs = Array.isArray(declared?.packages) ? declared.packages : declared
  return Array.isArray(globs) ? globs.filter((glob) => typeof glob === 'string') : []
}

// Whether `globs` take the directory `rel` (from theirs) for a workspace: one does, and no negated one.
function takes(globs, rel) {
  const clean = (glob) => glob.replace(/^(?:\.\/)+/u, '').replace(/\/+$/u, '')
  const negated = globs.filter((glob) => glob.startsWith('!')).map((glob) => clean(glob.slice(1)))
  return globs.some((glob) => !glob.startsWith('!') && matchesGlob(rel, clean(glob))) && !negated.some((glob) => matchesGlob(rel, glob))
}

// The lockfiles that install `directory` of a repository, for the packages of `ecosystems`, as
// lockedBy takes them (but `from` and `read`), as vfs-bundle's tree finds each package manager's
// root: an npm package's of the one package manager that installs it, of pnpm (the workspace
// root's, the nearest directory at or above it holding pnpm-workspace.yaml, whatever pnpm-lock.yaml
// is nearer, else the nearest), npm (the root whose package.json's workspaces take the package it is
// in, whatever lockfile is nearer, else the nearest package-lock.json beside a package.json; its
// npm-shrinkwrap.json before it) and yarn 1 (the workspace root, else the nearest yarn.lock); a
// crate's the nearest Cargo.lock. Refused (ValidateError) where none is, or more than one package
// manager's is. `read(path)` reads a file of the repository, `list(dir)` the names of the files a
// directory has.
export async function repositoryLockfiles({ directory = '', ecosystems, list, read }) {
  const dirs = []
  for (let dir = directory; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
    dirs.push(dir)
    if (dir === '') break
  }
  const listed = await Promise.all(dirs.map(list))
  const nearest = (name) => listed.findIndex((names) => names.includes(name))
  const at = (index, name) => (dirs[index] ? `${dirs[index]}/${name}` : name)
  // Each directory's package.json, undefined for none, null for one unreadable: read where npm's
  // packages are to be locked, a few small files, as both npm and yarn look above for a workspace root.
  const jsons = ecosystems.has('npm')
    ? await Promise.all(dirs.map((_, index) => (listed[index].includes('package.json') ? Promise.resolve(read(at(index, 'package.json'))).then((text) => JSON.parse(withoutBom(text))).catch(() => null) : undefined)))
    : []
  // The directory at `below`, from the one at `above`.
  const from = (above, below) => (dirs[above] ? dirs[below].slice(dirs[above].length + 1) : dirs[below])
  // A package.json naming a package, or unreadable: one with no name is a `type` marker.
  const holdsPackage = (json) => json === null || json?.name !== undefined

  // npm's root, as npmRoot finds it: the first directory above the package's whose workspaces take it.
  const npmRoot = () => {
    for (let index = 0; index < dirs.length; index++) {
      if (jsons[index] === undefined) continue
      const root = jsons.findIndex((json, above) => above > index && takes(workspaceGlobs(json), from(above, index)))
      if (root !== -1) return root
      if (holdsPackage(jsons[index])) break
    }
    return listed.findIndex((names) => names.includes('package.json') && (names.includes('package-lock.json') || names.includes('npm-shrinkwrap.json')))
  }
  // yarn 1's, as yarn1Root finds it: the nearest root declaring workspaces, where the package (the
  // nearest directory below it with a package.json that is a workspace of it or names a package) is
  // it or one of them; else the nearest yarn.lock.
  const yarnRoot = () => {
    const root = jsons.findIndex((json) => Boolean(Array.isArray(json?.workspaces) ? json.workspaces : json?.workspaces?.packages))
    if (root !== -1) {
      const globs = workspaceGlobs(jsons[root])
      const first = jsons.slice(0, root).findIndex((json, index) => json !== undefined && (takes(globs, from(root, index)) || holdsPackage(json)))
      if (first === -1 || takes(globs, from(root, first))) return root
    }
    return nearest('yarn.lock')
  }

  const where = directory || 'the repository\'s root'
  const chosen = []
  if (ecosystems.has('npm')) {
    const workspace = nearest('pnpm-workspace.yaml')
    const pnpm = workspace === -1 ? nearest('pnpm-lock.yaml') : workspace
    const npm = npmRoot()
    const yarn = yarnRoot()
    // Each package manager's lockfile at its root, where it holds one.
    const found = [[pnpm, 'pnpm-lock.yaml'], [npm, 'npm-shrinkwrap.json'], [npm, 'package-lock.json'], [yarn, 'yarn.lock']]
      .filter(([index, name]) => index !== -1 && listed[index].includes(name))
      .filter(([index, name], _, all) => name !== 'package-lock.json' || !all.some((other) => other[0] === index && other[1] === 'npm-shrinkwrap.json'))
    if (found.length === 0) {
      const bun = ['bun.lock', 'bun.lockb'].find((name) => nearest(name) !== -1)
      throw bun === undefined
        ? new ValidateError('no-lockfile', `no lockfile at or above ${where} locks its npm packages (pnpm-lock.yaml, package-lock.json, npm-shrinkwrap.json, yarn.lock): give --lockfile=path, or --no-lockfile to hold them to their registry alone`)
        : new ValidateError('lockfile-unsupported', `${bun}, which validate doesn't read, locks its npm packages: give --lockfile=path, or --no-lockfile to hold them to their registry alone`)
    }
    if (found.length > 1) throw new ValidateError('lockfile-ambiguous', `more than one lockfile installs ${where}: ${found.map(([index, name]) => at(index, name)).join(', ')}; give --lockfile=path`)
    chosen.push(at(...found[0]))
  }
  if (ecosystems.has('cargo')) {
    const index = nearest('Cargo.lock')
    if (index === -1) throw new ValidateError('no-lockfile', `no Cargo.lock at or above ${where} locks its crates: give --lockfile=path, or --no-lockfile to hold them to crates.io alone`)
    chosen.push(at(index, 'Cargo.lock'))
  }
  return Promise.all(chosen.map(async (path) => ({ path, text: await read(path) })))
}

// A bundle file validated (validateBundle): its own code against the repository its `repo` names (or
// `github`), at its commit (or `sha`), under its directory (or `directory`), read with `client`
// (@preventive/upstream/github.js); its dependencies fetched with upstream, held to the lockfile that
// installs it there (repositoryLockfiles), or to the lockfiles at the paths `lockfile` gives, or, with
// `lockfile` false, to their registry alone. Its dependencies alone only where `own` is false. A
// bundle with no repository or commit to read its own code or its lockfile of is refused
// (ValidateError), as is one no lockfile it can read locks the dependencies of.
export async function validate(file, { client, github, sha, directory, own = true, lockfile = true, fetch, deadline } = {}) {
  const { kind, artifact } = parseFileWithKind(file)
  if (kind !== 'bundle') throw new ValidateError('not-a-bundle', `${file} is a lockfile, which holds no file to check; give a bundle`)
  const plan = validationPlan(artifact)
  // The ecosystems of the versions fetched, which a lockfile is to lock.
  const ecosystems = new Set(plan.packages.filter((pkg) => FETCHED.has(pkg.ecosystem) && pkg.name && pkg.version).map((pkg) => pkg.ecosystem))
  const fromRepository = lockfile === true && ecosystems.size > 0
  const repo = artifact.repo ?? {}
  const where = { github: github ?? repo.github, commit: sha ?? repo.commit, directory: directory ?? repo.directory ?? '' }
  if (own || fromRepository) {
    const or = !own ? 'or --lockfile=path, or --no-lockfile to hold its dependencies to their registry alone'
      : fromRepository ? 'or, to validate its dependencies alone, --only-deps with --lockfile=path or --no-lockfile' : 'or --only-deps to validate its dependencies alone'
    const what = own ? 'its own code' : 'its lockfile'
    if (where.github === undefined) throw new ValidateError('no-repository', `${file} records no repository to read ${what} of: give --github=owner/name and --sha=commit, ${or}`)
    if (where.commit === undefined) throw new ValidateError('no-commit', `${file} records no commit to read ${what} at: give --sha=commit, ${or}`)
  }
  const reading = own ? repositoryFiles(client, where) : null
  const listings = new Map()
  const list = (dir) => {
    if (!listings.has(dir)) {
      listings.set(dir, client.listRepoDir({ repo: where.github, sha: where.commit, ...(dir && { directory: dir }) })
        .then((listed) => listed.filter((entry) => entry.type === 'blob').map((entry) => entry.path)))
    }
    return listings.get(dir)
  }
  // A file under the directory read of its tree, where that is being fetched whole; another alone.
  const readRepository = async (path) => {
    const under = where.directory === '' || path.startsWith(`${where.directory}/`)
    const held = reading && under ? (await reading).get(path)?.data : undefined
    return held ? asText.decode(held) : client.getRepoFile({ repo: where.github, path, ref: where.commit })
  }
  const readLocal = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      throw new ValidateError('lockfile-unreadable', `${path}: ${error.message}`)
    }
  }
  const lockfiles = lockfile === false ? null : ecosystems.size === 0 ? []
    : Array.isArray(lockfile) ? lockfile.map((path) => ({ path, text: readLocal(path), from: 'local', read: readLocal }))
    : repositoryLockfiles({ directory: where.directory, ecosystems, list, read: readRepository }).then((files) => files.map((one) => ({ ...one, from: 'repository', read: readRepository })))
  const [entries, files] = await Promise.all([reading, lockfiles])
  const locked = files && lockedBy(files)
  for (const ecosystem of locked ? ecosystems : []) {
    if (!locked.locks(ecosystem)) throw new ValidateError('no-lockfile', `no lockfile given locks its ${ecosystem} packages: give it with --lockfile=path, or --no-lockfile to hold them to their registry alone`)
  }
  const checked = own ? { entries, cut: false, repository: where.github, commit: where.commit, directory: where.directory } : { reason: 'skipped' }
  return validateBundle(plan, checked, { fetch, locked, deadline })
}

// Why own code or a package wasn't checked, or a file is as it is, as a report tells it.
const OWN_UNCHECKED = { skipped: 'skipped (--only-deps): its dependencies alone validated' }
const UNVERIFIED = { git: 'locked from git, not a registry', 'not-registry': 'locked from elsewhere than its registry', 'no-integrity': 'locked with no sha512 to hold its tarball to', unsupported: 'no upstream package for its ecosystem', unnamed: 'no name or version recorded', 'not-published': 'not published', unreadable: 'its registry refused it', timeout: 'not reached in time', failed: 'could not be fetched' }
const LOCK_FAILURES = { 'not-locked': 'not locked by the lockfile', 'integrity-mismatch': 'its registry\'s tarball is not the one the lockfile locks', 'integrity-conflict': 'locked with two integrities' }
const FILE_REASONS = { symlink: 'a symlink in the repository', submodule: 'in a submodule', 'tree-cut': 'the repository\'s tree was too large to list whole' }

// The report: the files failing and the packages told on stdout, a line each; the summary, and why
// own code wasn't checked, on stderr.
export function printValidationReport(report, { out = console.log, err = console.error } = {}) {
  for (const problem of report.problems) {
    out(`${problem.kind}\t${problem.path}\t${problem.of}${problem.reason ? ` (${FILE_REASONS[problem.reason] ?? problem.reason})` : ''}`)
  }
  if (report.moreProblems > 0) out(`... and ${report.moreProblems} more files`)
  for (const pkg of report.packages) {
    const patch = pkg.patch
    const how = patch && (patch.error ? `its patch could not be applied (${patch.error})` : patch.applied === false ? 'locked patched, bundled as published' : 'patched')
    const note = pkg.status === 'unverified' ? UNVERIFIED[pkg.reason] ?? pkg.reason
      : pkg.reason ? LOCK_FAILURES[pkg.reason] ?? pkg.reason
        : patch ? `${how}${patch.path ? ` by ${patch.path}${patch.from === 'bundle' ? ' (the bundle\'s)' : ''}` : ''}` : ''
    out(`${pkg.status}\t${pkg.ecosystem}:${pkg.name}@${pkg.version}${note ? `\t${note}` : ''}`)
  }
  const { counts, own } = report
  err(`${report.status}: ${counts.matched} of ${counts.files} files as they should be, ${counts.differs} differ, ${counts.unexpected} unexpected, ${counts.unverified} unverified; ${counts.validPackages} of ${counts.packages} packages as published${counts.lockFailures ? `, ${counts.lockFailures} failing their lockfile` : ''}${counts.eol ? `; ${counts.eol} with a checkout's CRLF line endings` : ''}`)
  if (own.checked) err(`Own code held to ${own.repository} at ${own.commit}${own.directory ? ` under ${own.directory}` : ''}`)
  else err(`Own code not verified: ${OWN_UNCHECKED[own.reason] ?? own.reason}`)
  if (report.lockfiles?.length > 0) err(`Dependencies held to ${report.lockfiles.join(', ')}`)
  else if (report.lockfiles === null && counts.packages > 0) err('Dependencies held to no lockfile (--no-lockfile): each to its registry\'s integrity alone')
}
