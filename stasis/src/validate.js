// `stasis validate`: whether a bundle holds what it says it does. Every file of its own code must be
// the repository's at the commit its `repo` names, under the directory it was built in; every file of
// a dependency must be its published package's, fetched with upstream (npm's registry, crates.io),
// which holds each tarball to its integrity; and those two must cover every file it holds. A
// dependency's files a bundle leaves out are expected: it holds those its code reaches alone.
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
// version alone (Composer's, Soldeer's, a crate from git), npm packages installed from git (whose
// module records the commit, installed-commits.js, as no registry package's does, and which npm may
// build as it installs them), and versions it fails to fetch, are left unverified.
//
// Stasis's empty stub for an import a package disables (EMPTY_MODULE_PATH) is no file of either, and
// is allowed. A vendored crate's `.cargo-checksum.json`, which `cargo vendor` writes and no crate
// holds, is held to the crate instead: its package checksum, and each file's it lists.
import { createHash } from 'node:crypto'

import { EMPTY_MODULE_PATH, dependencyEcosystem, hasNodeModulesSegment, isStatFormat, moduleFileKey } from '@exodus/stasis-core/util'
import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { getCrate } from '@preventive/upstream/cargo.js'
import { HttpError, getTarball } from '@preventive/upstream/npm.js'
import { parseCargoChecksum } from '@preventive/lockfile/cargo.js'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'

import { parseFileWithKind } from './parse.js'

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
// patch-does-not-apply).
export class PatchError extends Error {
  constructor(code) {
    super(code)
    this.name = 'PatchError'
    this.code = code
  }
}

// The ecosystem a module's files are a dependency's of, or undefined for own code: the root's and an
// npm-tagged module's outside node_modules (a workspace package's) are own code whatever they record,
// as a bundle built before only dependencies were tagged may record one.
const moduleEcosystem = (dir, ecosystem) => (dir === '.' || (ecosystem === 'npm' && !hasNodeModulesSegment(dir)) ? undefined : dependencyEcosystem(dir, ecosystem))

// What a bundle's files are, as validation checks them: its own code, `{ path, dir, rel, bytes() }`
// each, and each package version's, `{ ecosystem, name, version, files }`, one with no name or
// version among them, an npm package installed from git apart from the registry's, with its `git`
// (`{ github, commit }`); the patches it holds (`patches`, their text by path); and how many files.
// Directories and stat records, which are no files, and Stasis's empty stub are left out.
export function validationPlan(bundle) {
  const formats = bundle.formats ?? new Map()
  const own = []
  const patches = new Map()
  const packages = new Map()
  let files = 0
  for (const [dir, info] of bundle.modules) {
    const ecosystem = moduleEcosystem(dir, info.ecosystem)
    for (const [rel, content] of Object.entries(info.files)) {
      const path = moduleFileKey(dir, rel)
      const format = formats.get(path)
      if (typeof content !== 'string' || format === 'directory' || isStatFormat(format)) continue
      if (ecosystem === undefined && path === EMPTY_MODULE_PATH && content === '') continue
      files++
      const file = { path, dir, rel, bytes: () => (format === 'resource:base64' ? Buffer.from(content, 'base64') : utf8.encode(content)) }
      if (ecosystem === undefined) {
        if (format === 'patch' || path.endsWith('.patch')) patches.set(path, content)
        own.push(file)
        continue
      }
      const [name, version] = [info.name ?? '', info.version ?? '']
      const git = ecosystem === 'npm' && info.repo?.commit !== undefined ? { github: info.repo.github, commit: info.repo.commit } : undefined
      const key = `${ecosystem}\0${name}\0${version}\0${git ? `${git.github}@${git.commit}` : ''}`
      if (!packages.has(key)) packages.set(key, { ecosystem, name, version, ...(git && { git }), files: [] })
      packages.get(key).files.push(file)
    }
  }
  return { files, own, packages: [...packages.values()], patches }
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
// a vendored copy's `.cargo-checksum.json` names.
export const FETCHED = new Set(['npm', 'cargo'])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export async function fetchPackage(ecosystem, name, version) {
  const tarball = ecosystem === 'npm' ? await getTarball(name, version) : await getCrate(name, version)
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
// (`unreadable`), or another failure (`failed`). A `fetch` of a caller's throws upstream's HttpError,
// re-exported, for the first two.
export { HttpError }
export function fetchFailure(error) {
  if (error instanceof HttpError) return error.status === 404 ? 'not-published' : [401, 403].includes(error.status) ? 'unreadable' : 'failed'
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
export function isPatchOf(text, hash) {
  return [...new Set([text.replaceAll('\r\n', '\n'), text])].some((read) => (hash.length === 64
    ? createHash('sha256').update(read).digest('hex') === hash
    : base32(createHash('md5').update(read).digest()) === hash))
}

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
// A package told's place in the report: by its key, the registry's before one from git.
const toldKey = (pkg) => `${packageKey(pkg)}\0${pkg.git ? `${pkg.git.github}@${pkg.git.commit}` : ''}`
// The name pnpm gives a version's patch file, `@scope__name@1.0.0.patch`.
const pnpmPatchName = (name, version) => `${name.replace('/', '__')}@${version}.patch`

// The patch an npm version is held to, and its files patched with it: the one `locked` locks it with,
// of the bundle's file of its hash, else read by `locked.read`; with no lockfile read (`locked.of`
// answering undefined), the bundle's named for it. None where it is patched by none; told with its
// `error` where it couldn't be read or applied.
async function patchOf(plan, pkg, files, locked) {
  const lock = locked?.of(pkg.name, pkg.version)
  let patch
  let read = null
  try {
    if (lock) {
      const bundled = [...plan.patches].find(([, text]) => isPatchOf(text, lock.hash))
      patch = { hash: lock.hash, ...(bundled ? { path: bundled[0], from: 'bundle' } : lock.path ? { path: lock.path, from: 'repository' } : {}) }
      if (bundled) read = parsePatch(bundled[1])
      else if (lock.path) read = parsePatch(await locked.read(lock.hash, lock.path))
      if (!read) patch.error = 'patch-not-found'
    } else if (lock === undefined) {
      const named = [...plan.patches].find(([path]) => path.split('/').at(-1) === pnpmPatchName(pkg.name, pkg.version))
      if (named) {
        patch = { path: named[0], from: 'bundle' }
        read = parsePatch(named[1])
      }
    }
    return { patch, patched: read ? patchedFiles(files, read) : null }
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
// Each package fetched with `fetch` (fetchPackage), those of an npm version pnpm patches held to its
// files patched (`locked`, `{ of(name, version), read(hash, path) }`: the patch the lockfile locks it
// with, null for none, undefined where no lockfile tells), PACKAGES_AT_ONCE at a time, those left past
// `deadline` unverified.
//
// What it tells: its `status`, `valid` where every file was checked and is as it should be, `invalid`
// where one differs (`differs`) or is neither the repository's nor its package's (`unexpected`), else
// `incomplete`; whether its own code was checked (`own`); how many files of each kind and outcome
// (`counts`); each file failing, and each own one left unverified, with what it is of (`own`, or
// `ecosystem:name@version`), as many as MAX_TOLD (`problems`, how many more `moreProblems`); and each
// version not wholly valid or patched (`packages`), a patched one's patch with, where it is valid,
// whether a copy of it holds its files patched (`applied`).
export async function validateBundle(plan, own, { fetch = fetchPackage, locked = null, deadline = Number.POSITIVE_INFINITY, now = Date.now } = {}) {
  const problems = []
  const counts = { files: plan.files, own: plan.own.length, dependencies: 0, matched: 0, eol: 0, differs: 0, unexpected: 0, unverified: 0, packages: plan.packages.length, validPackages: 0 }
  const tell = (problem) => {
    counts[problem.kind]++
    problems.push(problem)
  }

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
      const text = Buffer.from(bytes).toString('latin1')
      if (text.includes('\r\n') && same(Buffer.from(text.replaceAll('\r\n', '\n'), 'latin1'))) {
        counts.matched++
        counts.eol++
        continue
      }
      tell({ path: file.path, kind: 'differs', of: 'own' })
    }
  }

  const told = []
  await eachOf(plan.packages, PACKAGES_AT_ONCE, async (pkg) => {
    counts.dependencies += pkg.files.length
    const of = packageKey(pkg)
    const unverified = (reason) => {
      counts.unverified += pkg.files.length
      told.push({ ecosystem: pkg.ecosystem, name: pkg.name, version: pkg.version, ...(pkg.git && { git: pkg.git }), files: pkg.files.length, status: 'unverified', reason })
    }
    if (!pkg.name || !pkg.version) return unverified('unnamed')
    if (pkg.git) return unverified('git')
    if (!FETCHED.has(pkg.ecosystem)) return unverified('unsupported')
    if (now() > deadline) return unverified('timeout')
    let files
    try {
      files = await fetch(pkg.ecosystem, pkg.name, pkg.version)
    } catch (error) {
      return unverified(fetchFailure(error))
    }
    const { patch, patched } = pkg.ecosystem === 'npm' ? await patchOf(plan, pkg, files, locked) : {}
    // Each installed copy apart, as one may be patched and another not.
    const candidates = [...(patched ? [patched] : []), files]
    let missed = 0
    let asPatched = 0
    // A crate's `.cargo-checksum.json` held to the crate, as no crate holds one.
    const checksum = (file) => pkg.ecosystem === 'cargo' && file.rel === CARGO_CHECKSUM
    const matches = (file, candidate) => (checksum(file) ? checksumOf(file.bytes(), candidate) : candidate.has(file.rel) && equal(file.bytes(), candidate.get(file.rel)))
    for (const copy of Map.groupBy(pkg.files, (file) => file.dir).values()) {
      const misses = candidates.map((candidate) => copy.filter((file) => !matches(file, candidate)))
      const best = Math.max(0, misses.findIndex((missing) => missing.length === 0))
      for (const file of misses[best]) tell({ path: file.path, kind: checksum(file) || candidates[best].has(file.rel) ? 'differs' : 'unexpected', of })
      missed += misses[best].length
      if (misses[best].length === 0 && candidates[best] === patched) asPatched++
    }
    counts.matched += pkg.files.length - missed
    const valid = missed === 0
    if (valid) counts.validPackages++
    if (!valid || patch) {
      told.push({ ecosystem: pkg.ecosystem, name: pkg.name, version: pkg.version, files: pkg.files.length, status: valid ? 'valid' : 'invalid',
        ...(patch && { patch: { ...patch, ...(patched && valid && { applied: asPatched > 0 }) } }) })
    }
    return undefined
  })

  const status = counts.differs + counts.unexpected > 0 ? 'invalid' : counts.unverified > 0 ? 'incomplete' : 'valid'
  const listed = problems.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return {
    validatedAt: now(),
    status,
    own: 'reason' in own ? { checked: false, reason: own.reason } : { checked: true, repository: own.repository, commit: own.commit, directory: own.directory, ...(own.cut && { cut: true }) },
    counts,
    problems: listed.slice(0, MAX_TOLD),
    moreProblems: Math.max(0, listed.length - MAX_TOLD),
    packages: told.toSorted((a, b) => (toldKey(a) < toldKey(b) ? -1 : toldKey(a) > toldKey(b) ? 1 : 0)).slice(0, MAX_TOLD),
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

// The patches the pnpm-lock.yaml pnpm installs `directory` from locks each version with, as
// `validateBundle` takes them (`locked`), its patch files read of the repository too: the workspace
// root's, the nearest directory at or above it holding pnpm-workspace.yaml, whatever pnpm-lock.yaml is
// nearer, else the nearest's, as vfs-bundle's tree finds the root; null where there is none.
// `read(path)` reads a file of the repository at the commit, `list(dir)` the names a directory has.
export async function lockedPatches({ directory = '', list, read }) {
  const dirs = []
  for (let dir = directory; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
    dirs.push(dir)
    if (dir === '') break
  }
  const listed = await Promise.all(dirs.map(list))
  const holding = (name) => dirs.find((_, at) => listed[at].includes(name))
  const root = holding('pnpm-workspace.yaml')
  const dir = root === undefined ? holding('pnpm-lock.yaml') : root
  if (dir !== undefined && listed[dirs.indexOf(dir)].includes('pnpm-lock.yaml')) {
    const at = (path) => (dir ? `${dir}/${path}` : path)
    const { lockfile } = parsePnpmLockfile(await read(at('pnpm-lock.yaml')))
    const paths = new Map(Object.values(lockfile?.patchedDependencies ?? {}).map(({ hash, path }) => [hash, path]))
    const by = new Map()
    for (const pkg of Object.values(lockfile?.packages ?? {})) if (pkg.version !== undefined) by.set(`${pkg.name}@${pkg.version}`, pkg.patchHash ?? null)
    return {
      of(name, version) {
        const hash = by.get(`${name}@${version}`)
        if (hash === undefined || hash === null) return hash
        const path = paths.get(hash)
        return { hash, ...(path && { path: at(path) }) }
      },
      read: (_hash, path) => read(path),
    }
  }
  return null
}

// A bundle file validated (validateBundle): its own code against the repository its `repo` names (or
// `github`), at its commit (or `sha`), under its directory (or `directory`), read with `client`
// (@preventive/upstream/github.js), unless `own` is false; its dependencies fetched with upstream,
// pnpm's patches as the nearest pnpm-lock.yaml there locks them.
export async function validate(file, { client, github, sha, directory, own = true, fetch, deadline } = {}) {
  const { kind, artifact } = parseFileWithKind(file)
  if (kind !== 'bundle') throw new Error(`stasis validate: ${file} is a lockfile, which holds no file to check; give a bundle`)
  const plan = validationPlan(artifact)
  const repo = artifact.repo ?? {}
  const where = { github: github ?? repo.github, commit: sha ?? repo.commit, directory: directory ?? repo.directory ?? '' }
  const reason = !own ? 'skipped' : where.github === undefined ? 'no-repository' : where.commit === undefined ? 'no-commit' : undefined
  if (reason !== undefined) return validateBundle(plan, { reason }, { fetch, deadline })
  const entries = await repositoryFiles(client, where)
  const listings = new Map()
  const list = (dir) => {
    if (!listings.has(dir)) listings.set(dir, client.listRepoDir({ repo: where.github, sha: where.commit, ...(dir && { directory: dir }) }).then((listed) => listed.map((entry) => entry.path)))
    return listings.get(dir)
  }
  const readFile = (path) => {
    const held = entries.get(path)?.data
    return held ? asText.decode(held) : client.getRepoFile({ repo: where.github, path, ref: where.commit })
  }
  const locked = await lockedPatches({ directory: where.directory, list, read: readFile })
  return validateBundle(plan, { entries, cut: false, repository: where.github, commit: where.commit, directory: where.directory }, { fetch, locked, deadline })
}

// Why own code or a package wasn't checked, or a file is as it is, as a report tells it.
const OWN_UNCHECKED = { skipped: 'skipped (--no-own)', 'no-repository': 'the bundle records no repository; give --github', 'no-commit': 'the bundle records no commit; give --sha' }
const UNVERIFIED = { git: 'installed from git, not a registry', unsupported: 'no upstream package for its ecosystem', unnamed: 'no name or version recorded', 'not-published': 'not published', unreadable: 'its registry refused it', timeout: 'not reached in time', failed: 'could not be fetched' }
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
    const note = pkg.status === 'unverified' ? UNVERIFIED[pkg.reason] ?? pkg.reason
      : patch ? `${patch.error ? `its patch could not be applied (${patch.error})` : patch.applied === false ? 'locked patched, bundled as published' : 'patched'}${patch.path ? ` by ${patch.path}${patch.from === 'bundle' ? ' (the bundle\'s)' : ''}` : ''}` : ''
    out(`${pkg.status}\t${pkg.ecosystem}:${pkg.name}@${pkg.version}${pkg.git ? ` (${pkg.git.github}@${pkg.git.commit})` : ''}${note ? `\t${note}` : ''}`)
  }
  const { counts, own } = report
  err(`${report.status}: ${counts.matched} of ${counts.files} files as they should be, ${counts.differs} differ, ${counts.unexpected} unexpected, ${counts.unverified} unverified; ${counts.validPackages} of ${counts.packages} packages as published${counts.eol ? `; ${counts.eol} with a checkout's CRLF line endings` : ''}`)
  if (own.checked) err(`Own code held to ${own.repository} at ${own.commit}${own.directory ? ` under ${own.directory}` : ''}`)
  else err(`Own code not verified: ${OWN_UNCHECKED[own.reason] ?? own.reason}`)
}
