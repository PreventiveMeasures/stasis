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
// the tree, as a server may read it). A text file whose only difference is a checkout's CRLFs, every
// line's, passes, counted apart (`eol`): not a binary, a shell script or an env file (checkedOutAsLf).
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

import { toBase32 } from '@exodus/bytes/base32.js'
import { EMPTY_MODULE_PATH, dependencyEcosystem, hasNodeModulesSegment, isStatFormat, moduleFileKey } from '@exodus/stasis-core/util'
import { decompress } from '@preventive/archive/compression.js'
import { unpack } from '@preventive/archive/tar.js'
import { getCrate } from '@preventive/upstream/cargo.js'
import { HttpError, getTarball } from '@preventive/upstream/npm.js'
import { parseCargoChecksum, parseCargoLock } from '@preventive/lockfile/cargo.js'
import { parseNpmLockfile } from '@preventive/lockfile/npm.js'
import { parsePnpmLockfile } from '@preventive/lockfile/pnpm.js'
import { parseYarn1Lockfile } from '@preventive/lockfile/yarn1.js'
import { createVfs } from '@preventive/vfs'

import { STORE_HASH, resolutionCommit } from './installed-commits.js'
import { findCargoLock } from './loaders/cargo.js'
import { parseFileWithKind } from './parse.js'
import { DIM, formatTable, painter } from './table.js'
import { FILE_REASONS, LOCKFILE_ERRORS, OWN_REASONS, noteText } from './validate-notes.js'
import { lockfileOf, lockfileRoot, vfsHost } from './vfs-bundle/tree.js'

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
// lockfile or none (`lockfile`, --lockfile, --no-lockfile) were asked for; its commit is in none of
// the repository's own history (`commit-not-in-history`), or that can't be told (`history-unread`,
// historyOf); or no lockfile it can read locks its dependencies (`no-lockfile`, `lockfile-ambiguous`,
// `lockfile-unsupported`, `lockfile-unreadable`).
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
      const file = { path, dir, rel, format, bytes: () => (format === 'resource:base64' ? Buffer.from(content, 'base64') : utf8.encode(content)) }
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
// A registry's tarball of a version, by its path: npm's, as upstream takes a dist of one, or a mirror's.
const tarballPath = (name, version) => `/${name}/-/${name.split('/').at(-1)}-${version}.tgz`
export async function fetchPackage(ecosystem, name, version, integrity) {
  const tarball = ecosystem === 'npm'
    ? await getTarball(name, version, integrity === undefined ? undefined : { tarball: `https://registry.npmjs.org${tarballPath(name, version)}`, integrity })
    : await getCrate(name, version, integrity)
  const files = new Map([...await tarballFiles(tarball)].filter(([, data]) => data instanceof Uint8Array))
  // The checksum upstream held it to, where one was given.
  if (ecosystem === 'cargo') files.checksum = integrity ?? sha256(tarball)
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
const patchHashes = (text) => new Set([...new Set([text.replaceAll('\r\n', '\n'), text])]
  .flatMap((read) => [sha256(read), toBase32(createHash('md5').update(read).digest(), { padding: false }).toLowerCase()]))
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
// Formats a CR before each line's end changes the meaning of: a binary's bytes, which no checkout
// converts, a shell script's commands and an env file's values, each its last word's own.
const CR_CHANGES = new Set(['resource:base64', 'shell', 'env'])
// `bytes`, of a file of `format`, as a checkout with CRLF line endings writes it, as LF text: every
// line's end a CRLF, as git converts a text file whole. Else undefined.
function checkedOutAsLf(bytes, format) {
  if (CR_CHANGES.has(format)) return undefined
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  return text.includes('\r\n') && !/(?<!\r)\n/u.test(text) ? Buffer.from(text.replaceAll('\r\n', '\n'), 'latin1') : undefined
}
const packageKey = ({ ecosystem, name, version }) => `${ecosystem}:${name}@${version}`
// A registry's version, as pnpm names one in its store's directories (no `file+lib`, say).
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u
// The name an npm package's copy is installed as, by its path (after its last `node_modules/`, as
// Node resolves it), and the name and version of pnpm's store directory it is in, where it is
// (`node_modules/.pnpm/<name>@<version>/node_modules/<name>`, the name's `/` a `+`, its peers or patch
// after an `_`), as far as it names them: none where pnpm hashed a long one or one with uppercase.
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
// Whether an npm package's copy at `dir` is installed where the bundle has it: the name its path
// installs it as its own, but an alias its lockfile has (npm's at that location, yarn's or pnpm's of
// any); pnpm's store directory above it naming it; and, where its lockfile locks each location (npm's),
// that version there. `true`, else `false` where its path or lockfile names another, else `undefined`
// where it is installed as another name no lockfile read tells of (none read, say).
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
// Files told by kind, the worst first, then by what they are of, own code first, then by their paths;
// packages by status, the worst first, then by their keys: as many as MAX_TOLD keep the worst.
const KINDS = ['differs', 'unexpected', 'unverified']
const STATUSES = ['invalid', 'unverified', 'valid']
const byProblem = (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || (a.of === 'own' ? 0 : 1) - (b.of === 'own' ? 0 : 1)
  || byText((problem) => problem.of)(a, b) || byText((problem) => problem.path)(a, b)
const byPackage = (a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || byText(packageKey)(a, b)
// The name pnpm gives a version's patch file, `@scope__name@1.0.0.patch`.
const pnpmPatchName = (name, version) => `${name.replace('/', '__')}@${version}.patch`

// The patches a plan holds (`{ path, text }`), by each hash pnpm may name one by and by their file names.
function patchesOf(plan) {
  const byHash = new Map()
  const byName = new Map()
  for (const [path, text] of plan.patches) {
    const held = { path, text }
    for (const hash of patchHashes(text)) if (!byHash.has(hash)) byHash.set(hash, held)
    if (!byName.has(posix.basename(path))) byName.set(posix.basename(path), held)
  }
  return { byHash, byName }
}

// The patch an npm version is held to, and its files patched with it: the one `locked` locks it with,
// of the bundle's file of its hash (`held`, patchesOf), else read by `locked.read`; with no lockfile
// read (`locked.of` answering undefined), the bundle's named for it. None where it is patched by none;
// told with its `error` where it couldn't be read or applied. A patch the bundle holds is own code,
// taken as the repository has it alone (`verdicts`, a promise of what checking own code found of each
// file): refused where it isn't (`patch-not-in-repository`), and where that couldn't be told, its
// files patched `unverified`.
async function patchOf(held, pkg, files, locked, verdicts) {
  const lock = locked?.of(pkg.name, pkg.version)
  let patch
  let text
  try {
    if (lock) {
      const bundled = held.byHash.get(lock.hash)
      if (bundled) {
        patch = { hash: lock.hash, path: bundled.path, from: 'bundle' }
        text = bundled.text
      } else if (lock.path) {
        patch = { hash: lock.hash, path: lock.path, from: locked.from }
        text = await locked.read(lock.path)
        // Held to the hash the lockfile names it by, as the bundle's are found by it.
        if (!isPatchOf(text, lock.hash)) throw new PatchError('patch-mismatch')
      } else {
        // Named by its hash alone (pnpm 11): the file of that hash in a patches directory.
        const found = await locked.locate?.(lock)
        if (!found) return { patch: { hash: lock.hash, error: 'patch-not-found' }, patched: null }
        patch = { hash: lock.hash, path: found.path, from: locked.from }
        ;({ text } = found)
      }
    } else if (lock === undefined) {
      const named = held.byName.get(pnpmPatchName(pkg.name, pkg.version))
      if (!named) return { patched: null }
      patch = { path: named.path, from: 'bundle' }
      text = named.text
    } else return { patched: null }
    let unverified = false
    if (patch.from === 'bundle') {
      const verdict = (await verdicts).get(patch.path)
      if (verdict === 'differs' || verdict === 'unexpected') throw new PatchError('patch-not-in-repository')
      unverified = verdict !== 'matched'
      patch.verified = !unverified
    }
    return { patch, patched: patchedFiles(files, parsePatch(text)), unverified }
  } catch (error) {
    return { patch: { ...patch, error: error instanceof PatchError ? error.code : 'patch-unreadable' }, patched: null }
  }
}

// A path git can have in a tree, which upstream lists: no part empty, `.`, `..` or `.git`, as upstream's
// isRepoPath (src/args.js) has it, which it doesn't export.
const inTree = (path) => path.length <= 4096 && path.isWellFormed() && !/\p{Cc}/u.test(path) && path.split('/').every((part) => !['', '.', '..', '.git'].includes(part.toLowerCase()))

// `name` in the directory `dir` of the repository, '' its root.
const pathIn = (dir, name) => (dir ? `${dir}/${name}` : name)

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
// `repository`, `commit` and `directory`, the one it was built in; or `{ reason }` it wasn't checked,
// with `entries` where the patches the bundle holds are checked all the same (`skipped`, --only-deps);
// or a promise of any, the packages fetched meanwhile.
// Each package fetched with `fetch` (fetchPackage), PACKAGES_AT_ONCE at a time, those left past
// `deadline` unverified; each as its lockfile locks it (`locked`, lockedBy): `lock(ecosystem, name,
// version)`, how (undefined where no lockfile of its ecosystem was read, null where it locks none):
// one of its registry fetched with its `integrity`, failing where upstream refuses the tarball, or
// where none is locked; one from a directory of the repository held to that directory's files there
// (`tree(directory)`, where the repository is read; else unverified); one from git or elsewhere left
// unverified. An npm version held to its files patched where pnpm patches it (`of(name, version)`,
// the patch it locks it with, null for none, undefined where no lockfile tells; `read(path)`, the
// patch's text, read of `from`), a patch the bundle holds taken as the repository has it alone.
//
// What it tells: its `status`, `valid` where every file it was to check was checked and is as it
// should be, `invalid` where one differs (`differs`) or is neither the repository's nor its package's
// (`unexpected`), a version fails its lockfile (`lockFailures`), or a copy is installed where its path
// or its lockfile names another (`misplaced`), else `incomplete`; the lockfiles
// held to (`lockfiles`, null for none); whether its own code was checked (`own`); how many files of
// each kind and outcome (`counts`, own files not checked as asked `skipped`); each file failing, and
// each own one left unverified, with what it is of (`own`, or `ecosystem:name@version`), as many as
// MAX_TOLD (`problems`, how many more `moreProblems`); and each version not wholly valid or patched
// (`packages`), a patched one's patch with, where it is valid, whether a copy of it holds its files
// patched (`applied`), and one installed from a directory of the repository its `directory`.
export async function validateBundle(plan, own, { fetch = fetchPackage, locked = null, deadline = Number.POSITIVE_INFINITY, now = Date.now } = {}) {
  const problems = []
  const counts = { files: plan.files, own: plan.own.length, dependencies: plan.files - plan.own.length, matched: 0, eol: 0, differs: 0, unexpected: 0, unverified: 0,
    skipped: 0, packages: plan.packages.length, validPackages: 0, lockFailures: 0, misplaced: 0 }
  const tell = (problem) => {
    counts[problem.kind]++
    problems.push(problem)
  }
  // What checking own code found of each own file, by its path, once it is checked: none for one not.
  let checked
  const verdicts = new Promise((resolve) => {
    checked = resolve
  })

  // The packages fetched while own code is read and checked.
  const told = []
  const bundled = patchesOf(plan)
  const fetching = eachOf(plan.packages, PACKAGES_AT_ONCE, async (pkg) => {
    const of = packageKey(pkg)
    const tellPackage = (status, more) => told.push({ ecosystem: pkg.ecosystem, name: pkg.name, version: pkg.version, files: pkg.files.length, status, ...more })
    // Left unchecked, its files with it: unverified, or failing its lockfile (not what was installed,
    // or not known to be).
    const unverified = (reason, status = 'unverified', more = {}) => {
      counts.unverified += pkg.files.length
      tellPackage(status, { reason, ...more })
    }
    const fails = (reason) => {
      counts.lockFailures++
      unverified(reason, 'invalid')
    }
    if (!pkg.name || !pkg.version) return unverified('unnamed')
    if (!FETCHED.has(pkg.ecosystem)) return unverified('unsupported')
    // Each copy where Node resolves it by its path (a crate by its Cargo.toml alone, wherever it is):
    // the version failing where any is installed where another is; those installed under another
    // name no lockfile read tells of left unverified, the others checked all the same.
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
    if (lock?.from === 'git') return unverified('git')
    if (lock?.from === 'elsewhere') return unverified('not-registry')
    if (lock?.from === 'local' && !locked.tree) return unverified('local')
    if (lock?.conflict) return fails('integrity-conflict')
    if (lock?.from === 'registry' && lock.integrity === undefined) return unverified('no-integrity')
    if (now() > deadline) return unverified('timeout')
    // What each copy is held to, the first it matches: the repository's directories one from a
    // directory is installed from; else its files patched, where the patch is verified, then as
    // published.
    let candidates
    let patch
    let patched
    let unverifiedPatch = false
    try {
      if (lock?.from === 'local') candidates = await Promise.all(lock.directories.map((dir) => locked.tree(dir)))
      else {
        const files = await fetch(pkg.ecosystem, pkg.name, pkg.version, lock?.integrity)
        ;({ patch, patched, unverified: unverifiedPatch = false } = pkg.ecosystem === 'npm' ? await patchOf(bundled, pkg, files, locked, verdicts) : {})
        candidates = patched && !unverifiedPatch ? [patched, files] : [files]
      }
    } catch (error) {
      const reason = fetchFailure(error)
      return reason === 'integrity-mismatch' ? fails(reason) : unverified(reason)
    }
    // A crate's `.cargo-checksum.json` held to the crate, as no crate holds one.
    const checksum = (file) => pkg.ecosystem === 'cargo' && file.rel === CARGO_CHECKSUM
    const matches = (file, bytes, candidate) => (checksum(file) ? checksumOf(bytes, candidate) : candidate.has(file.rel) && equal(bytes, candidate.get(file.rel)))
    // Each installed copy apart, as one may be patched and another not.
    let missed = 0
    let asPatched = 0
    let notVerified = 0
    for (const copy of Map.groupBy(pkg.files, (file) => file.dir).values()) {
      if (aliased.includes(copy[0].dir)) {
        notVerified += copy.length
        continue
      }
      const bytes = new Map(copy.map((file) => [file, file.bytes()]))
      const missing = (candidate) => copy.filter((file) => !matches(file, bytes.get(file), candidate))
      let [held] = candidates
      let misses = missing(held)
      for (const other of candidates.slice(1)) {
        if (misses.length > 0 && missing(other).length === 0) [held, misses] = [other, []]
      }
      // As a patch not verified against the repository patches them: neither as they should be nor not.
      if (misses.length > 0 && unverifiedPatch && missing(patched).length === 0) {
        notVerified += copy.length
        continue
      }
      for (const file of misses) tell({ path: file.path, kind: checksum(file) || held.has(file.rel) ? 'differs' : 'unexpected', of })
      missed += misses.length
      if (misses.length === 0 && held === patched) asPatched++
    }
    counts.matched += pkg.files.length - missed - notVerified
    counts.unverified += notVerified
    const status = missed > 0 ? 'invalid' : notVerified > 0 ? 'unverified' : 'valid'
    if (status === 'valid') counts.validPackages++
    if (status !== 'valid' || patch) {
      tellPackage(status, {
        ...(status === 'unverified' && (aliased.length > 0 ? { reason: 'alias-unverified', at: aliased[0] } : { reason: 'patch-unverified' })),
        ...(patch && { patch: { ...patch, ...(patched && status === 'valid' && { applied: asPatched > 0 }) } }),
        ...(lock?.from === 'local' && { directory: lock.directories[0] }),
      })
    }
    return undefined
  })

  let read
  const found = new Map()
  try {
    read = await own
    const skipped = 'reason' in read
    // The submodules' paths, worked out where a file is not in the tree.
    let submodules
    const inSubmodule = (path) => (submodules ??= [...read.entries].filter(([, entry]) => entry.submodule).map(([at]) => `${at}/`)).some((prefix) => path.startsWith(prefix))
    for (const file of plan.own) {
      // Own code unchecked, but for the patches the bundle holds where the repository is read: skipped
      // as asked (--only-deps), else unverified.
      if (skipped && !(read.entries && plan.patches.has(file.path))) {
        counts[read.reason === 'skipped' ? 'skipped' : 'unverified']++
        continue
      }
      const path = read.directory ? `${read.directory}/${file.path}` : file.path
      const entry = read.entries.get(path)
      const verdict = (kind, reason) => {
        if (kind === 'matched') counts.matched++
        else tell({ path: file.path, kind, of: 'own', ...(reason && { reason }) })
        found.set(file.path, kind)
      }
      if (entry === undefined || entry.submodule) {
        // One at a path no tree can have is no file left unlisted.
        const reason = entry?.submodule || inSubmodule(path) ? 'submodule' : read.cut && inTree(path) ? 'tree-cut' : undefined
        verdict(reason === 'tree-cut' ? 'unverified' : 'unexpected', reason)
      } else if (entry.symlink !== undefined) verdict('differs', 'symlink')
      else {
        const bytes = file.bytes()
        const same = (candidate) => (entry.data === undefined ? gitBlobId(candidate) === entry.sha : equal(candidate, entry.data))
        if (same(bytes)) verdict('matched')
        else {
          // As a checkout with CRLF line endings writes it, of the file the repository has with LFs.
          const lf = checkedOutAsLf(bytes, file.format)
          const crlf = lf !== undefined && same(lf)
          if (crlf) counts.eol++
          verdict(crlf ? 'matched' : 'differs')
        }
      }
    }
  } finally {
    checked(found)
  }
  await fetching

  const skipped = 'reason' in read
  const patchesChecked = skipped && read.entries ? [...plan.own].filter((file) => plan.patches.has(file.path)).length : 0
  return {
    validatedAt: now(),
    status: counts.differs + counts.unexpected + counts.lockFailures + counts.misplaced > 0 ? 'invalid' : counts.unverified > 0 ? 'incomplete' : 'valid',
    own: skipped ? { checked: false, reason: read.reason, ...(patchesChecked > 0 && { patches: patchesChecked }) }
      : { checked: true, repository: read.repository, ...(read.movedFrom && { movedFrom: read.movedFrom }), commit: read.commit, ...(read.ref && { ref: read.ref }), directory: read.directory, ...(read.cut && { cut: true }) },
    lockfiles: locked?.lockfiles ?? null,
    counts,
    problems: problems.toSorted(byProblem).slice(0, MAX_TOLD),
    moreProblems: Math.max(0, problems.length - MAX_TOLD),
    packages: told.toSorted(byPackage).slice(0, MAX_TOLD),
  }
}

// The exit code a report's validation stands for: 0 valid, own code skipped as asked aside; 1
// invalid; 2 incomplete, where a file it was to check went unverified, unless `allowUnverified`.
export const exitCodeOf = (report, { allowUnverified = false } = {}) => (report.status === 'invalid' ? 1 : report.status === 'incomplete' && !allowUnverified ? 2 : 0)

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
  return url !== null && /^https?:$/u.test(url.protocol) && url.pathname.endsWith(tarballPath(name, version))
}

// The one sha512 an SRI holds, as upstream takes one; undefined where it holds none, or two.
function sha512Of(integrity) {
  const found = new Set((integrity ?? '').split(/\s+/u).filter((token) => token.startsWith('sha512-')).map((token) => token.split('?')[0]))
  return found.size === 1 ? [...found][0] : undefined
}

// A text without the byte order mark it starts with, as npm, pnpm and yarn read their lockfiles.
const withoutBom = (text) => (text.charCodeAt(0) === 0xFE_FF ? text.slice(1) : text)

// Where a lockfile's entry of a version comes from: git (a git repository, or a git host's tarball,
// installed-commits.js's resolutionCommit), its `registry`, with its `integrity`, or elsewhere.
const lockedFrom = (git, registry, integrity) => (git ? { from: 'git' } : registry ? { from: 'registry', integrity } : { from: 'elsewhere' })
const fromGit = (resolution) => resolution?.type === 'git' || resolution?.gitHosted === true || resolutionCommit(resolution) !== undefined

// A dependency's spec naming a directory of the project, `file:` or `link:` and its path, a tarball's
// aside; else undefined.
function localDirectory(spec) {
  const path = /^(?:file|link):(.+)$/u.exec(spec)?.[1]
  return path === undefined || /\.(?:tgz|tar\.gz|tar)$/u.test(path) ? undefined : path
}

// What the lockfile `name` (its file name) of `text` locks: each version by name and version, an
// entry for each time it locks it, lockedFrom's (an npm version's sha512, a crate's sha256); each
// package installed from a directory of the project (a `file:` or `link:` one, an npm link), by its
// name, the directories from the lockfile's (`locals`), which lock no version; and, of pnpm's, the
// patch it locks each version with, null for none (`hashes`), and each patch's file (`paths`). Its
// BOM passed over but Cargo.lock's, as cargo reads that as it is.
function readLockfile(name, read) {
  const text = name === 'Cargo.lock' ? read : withoutBom(read)
  const entries = new Map()
  const locals = new Map()
  const add = (pkg, version, entry) => {
    const key = `${pkg}@${version}`
    entries.set(key, [...(entries.get(key) ?? []), entry])
  }
  const local = (pkg, dir) => locals.set(pkg, new Set([...(locals.get(pkg) ?? []), posix.normalize(dir)]))
  // Each name a version is installed as in place of its own (an alias, `foo: npm:ms@2.1.3`), as
  // `<name it is installed as>\0<its name>@<its version>`; and each a directory's package is, any version
  // of it, as `<name it is installed as>\0<its name>`.
  const aliases = new Set()
  const directoryAliases = new Set()
  if (name === 'pnpm-lock.yaml') {
    const { lockfile } = parsePnpmLockfile(text)
    // pnpm locks an alias's dependency by its name and version (`foo: ms@2.1.3`), a version alone
    // otherwise; one of a directory by its name and the directory (`foo: lib@file:lib`, as a `file:`
    // override installs it), the version the one it has there.
    for (const node of [...Object.values(lockfile?.importers ?? {}), ...Object.values(lockfile?.packages ?? {})]) {
      for (const [as, ref] of Object.entries({ ...node.dependencies, ...node.devDependencies, ...node.optionalDependencies })) {
        const split = typeof ref === 'string' ? ref.indexOf('@', 1) : -1
        const of = split > 0 ? ref.slice(split + 1) : ''
        if (VERSION.test(of.split('(')[0])) aliases.add(`${as}\0${ref.slice(0, split)}@${of.split('(')[0]}`)
        else if (of.startsWith('file:') && as !== ref.slice(0, split)) directoryAliases.add(`${as}\0${ref.slice(0, split)}`)
      }
    }
    const hashes = new Map()
    for (const [key, pkg] of Object.entries(lockfile?.packages ?? {})) {
      // A directory has no version in the lockfile: pnpm reads the one it has as it installs it.
      if (pkg.resolution.type === 'directory') local(pkg.name, pkg.resolution.directory)
      if (pkg.version === undefined) continue
      // A registry version's key is its name and version, its peers and patch after them.
      const ref = key.slice(pkg.name.length + 1)
      add(pkg.name, pkg.version, lockedFrom(fromGit(pkg.resolution), ref === pkg.version || ref.startsWith(`${pkg.version}(`), sha512Of(pkg.resolution.integrity)))
      hashes.set(`${pkg.name}@${pkg.version}`, pkg.patchHash ?? null)
    }
    // Each patch by its hash: its file, where the lockfile names one, and the selectors naming it.
    const paths = new Map()
    for (const [selector, { hash, path }] of Object.entries(lockfile?.patchedDependencies ?? {})) {
      paths.set(hash, { path: paths.get(hash)?.path ?? path, selectors: [...(paths.get(hash)?.selectors ?? []), selector] })
    }
    return { entries, locals, aliases, directoryAliases, patches: { hashes, paths } }
  }
  if (name === 'Cargo.lock') {
    for (const pkg of Object.values(parseCargoLock(text).packages)) add(pkg.name, pkg.version, lockedFrom(pkg.source?.startsWith('git+'), CRATES_IO.has(pkg.source), pkg.checksum))
    return { entries }
  }
  let packages
  // npm's, by each location it installs a version at, from its directory: `<name>@<version>`; and
  // the locations it links to a directory, held to that directory (`locals`) in place of a version.
  let locations
  let links
  let importers
  if (name === 'yarn.lock') packages = new Set(Object.values(parseYarn1Lockfile(text, { checkVersions: false }).packages))
  else {
    const lockfile = parseNpmLockfile(text, { checkVersions: false })
    locations = new Map(Object.entries(lockfile.packages).filter(([, pkg]) => pkg.version !== undefined).map(([location, pkg]) => [location, `${pkg.name}@${pkg.version}`]))
    importers = new Set(Object.keys(lockfile.importers))
    links = new Set(Object.keys(lockfile.links))
    // npm links a directory it installs, by its location, to the directory: the package there.
    for (const [location, target] of Object.entries(lockfile.links)) {
      if (Object.hasOwn(lockfile.importers, target)) local(location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length), target)
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
    else if (version !== undefined) add(pkg, version, lockedFrom(fromGit(resolution), resolution?.type === 'tarball' && registryTarball(resolution.tarball, pkg, version), sha512Of(resolution?.integrity)))
  }
  return { entries, locals, aliases, ...(locations && { locations, links, importers }) }
}

// What `lockfiles` lock, as validateBundle takes it (`locked`), one of each ecosystem: each `{ path,
// text, from, read, tree, patches }`, its path (as it is told), what it is read of (`repository`, or
// `local`), `read(path)` reading a file by a path as it is (a pnpm patch's, by the lockfile's
// directory and the path it names), each read once, `tree(dir)` the files of a directory of the
// repository by their paths in it, where the repository is read, and `patches` the directories a
// patch it names by its hash alone (pnpm 11's) is looked for in, in turn, beside the lockfile's
// directory where none is given: `locate(lock)` finds it, the file there of pnpm's name for it and of
// that hash. Their paths (`lockfiles`), and whether one locks an ecosystem's packages
// (`locks(ecosystem)`), told too.
export function lockedBy(lockfiles) {
  const by = new Map()
  for (const { path, text, from, read, tree, patches, root = '' } of lockfiles) {
    const ecosystem = LOCKFILES.get(posix.basename(path))
    if (ecosystem === undefined) throw new ValidateError('lockfile-unsupported', `${path}: not a lockfile validate reads (${[...LOCKFILES.keys()].join(', ')})`)
    if (by.has(ecosystem)) throw new ValidateError('lockfile-ambiguous', `${by.get(ecosystem).path} and ${path} both lock ${ecosystem} packages: give one`)
    let locks
    try {
      locks = readLockfile(posix.basename(path), text)
    } catch (error) {
      throw new ValidateError('lockfile-unreadable', `${path}: ${error.message}`)
    }
    // The bundle's root by its path from the lockfile's directory, where npm's locks each location
    // from there: on disk, the one of its importers it names, else the lockfile's own directory.
    const within = locks.importers === undefined || from !== 'local' || locks.importers.has(root) ? root : ''
    by.set(ecosystem, { ...locks, path, from, read, tree, root: within, patchDirs: patches ?? [posix.join(posix.dirname(path), 'patches')] })
  }
  const npm = by.get('npm')
  const reads = new Map()
  return {
    lockfiles: [...by.values()].map(({ path }) => path),
    locks: (ecosystem) => by.has(ecosystem),
    lock(ecosystem, name, version) {
      const entries = by.get(ecosystem)?.entries
      if (entries === undefined) return undefined
      const locks = entries.get(`${name}@${version}`)
      if (locks === undefined) {
        // One of the project's directories, by its path from the repository's root, '' the root.
        const { locals, path } = by.get(ecosystem)
        const dirs = locals?.get(name)
        const fromRoot = (dir) => (dir === '.' ? '' : dir)
        return dirs ? { from: 'local', directories: [...dirs].map((dir) => fromRoot(posix.join(posix.dirname(path), dir))) } : null
      }
      const integrities = new Set(locks.filter((entry) => entry.from === 'registry').map((entry) => entry.integrity))
      if (integrities.size === 0) return { from: locks.every((entry) => entry.from === 'git') ? 'git' : 'elsewhere' }
      return integrities.size === 1 ? { from: 'registry', integrity: [...integrities][0] } : { from: 'registry', conflict: true }
    },
    of(name, version) {
      if (npm?.patches === undefined) return undefined
      const hash = npm.patches.hashes.get(`${name}@${version}`)
      if (hash == null) return hash
      const { path, selectors = [] } = npm.patches.paths.get(hash) ?? {}
      if (path) return { hash, path: posix.join(posix.dirname(npm.path), path) }
      // The names pnpm gives its file, by each selector naming it and by the version it patches.
      return { hash, names: [...new Set([...selectors.map((selector) => `${selector.replace('/', '__')}.patch`), pnpmPatchName(name, version)])] }
    },
    async locate({ hash, names = [] }) {
      for (const path of npm.patchDirs.flatMap((dir) => names.map((name) => (dir ? `${dir}/${name}` : name)))) {
        let text
        try {
          // eslint-disable-next-line no-await-in-loop -- the first of them that is there
          text = await this.read(path)
        } catch {
          continue // none there
        }
        if (isPatchOf(text, hash)) return { path, text }
      }
      return null
    },
    // The version an npm lockfile installs at the bundle's `dir` (`<name>@<version>`), null for none,
    // undefined where its lockfile locks no location (pnpm's, yarn's) or links it to a directory.
    installed(dir) {
      if (npm?.locations === undefined) return undefined
      const location = npm.root ? `${npm.root}/${dir}` : dir
      return npm.links.has(location) ? undefined : npm.locations.get(location) ?? null
    },
    // Whether the npm lockfile installs `named` (`<name>@<version>`) under the name `as`: that version,
    // or a directory's package of that name, where it locks no other of that version, so that its
    // files are held to the directory's (locals); undefined for none read.
    aliased: (as, named) => npm && (npm.aliases.has(`${as}\0${named}`)
      || (!npm.entries.has(named) && Boolean(npm.directoryAliases?.has(`${as}\0${named.slice(0, named.lastIndexOf('@'))}`)))),
    from: npm?.from,
    tree: npm?.tree,
    read(path) {
      if (!reads.has(path)) reads.set(path, Promise.resolve().then(() => npm.read(path)))
      return reads.get(path)
    },
  }
}

// The lockfiles that install `directory` of a repository, for the packages of `ecosystems`, as
// lockedBy takes them (but `from` and `read`), as the build finds them: an npm package's of the one
// package manager whose root (vfs-bundle's tree's lockfileRoot) holds its lockfile, pnpm's
// (pnpm-lock.yaml), npm's (package-lock.json, or npm-shrinkwrap.json, which npm takes before it) or
// yarn 1's (yarn.lock); a crate's the Cargo.lock beside its workspace's root (findCargoLock). Those
// read of a sparse tree of the directories at and above it, their files' names listed and the
// manifests the roots are found by read. Refused (ValidateError) where none is, or more than one
// package manager's is. `read(path)` reads a file of the repository, `list(dir)` the names of the
// files a directory has.
export async function repositoryLockfiles({ directory = '', ecosystems, list, read }) {
  const dirs = []
  for (let dir = directory; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
    dirs.push(dir)
    if (dir === '') break
  }
  const listed = await Promise.all(dirs.map(list))
  const where = directory || 'the repository\'s root'
  // The manifests a root is found by, read where a lockfile they could pick is listed: package.json
  // for npm's and yarn's workspaces, Cargo.toml for cargo's.
  const lists = (...names) => listed.some((names_) => names.some((name) => names_.includes(name)))
  const manifests = new Set([
    ...ecosystems.has('npm') && lists('package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock') ? ['package.json'] : [],
    ...ecosystems.has('cargo') ? ['Cargo.toml'] : [],
  ])
  // Each directory there, whatever it holds of those.
  const files = Object.fromEntries(dirs.filter(Boolean).map((dir) => [dir, { type: 'directory' }]))
  await Promise.all(dirs.flatMap((dir, index) => listed[index].map(async (name) => {
    if (manifests.has(name)) files[pathIn(dir, name)] = await read(pathIn(dir, name))
    // npm reads npm-shrinkwrap.json in place of package-lock.json, at the root it finds by either.
    else if (LOCKFILES.has(name) || name === 'pnpm-workspace.yaml') files[pathIn(dir, name === 'npm-shrinkwrap.json' ? 'package-lock.json' : name)] ??= ''
  })))
  const host = vfsHost(createVfs(files))
  const cwd = posix.resolve('/', directory || '.')
  const fromRoot = (path) => path.slice(1)

  const chosen = []
  if (ecosystems.has('npm')) {
    const found = []
    for (const pm of ['pnpm', 'npm', 'yarn1']) {
      let root
      try {
        root = lockfileRoot(host, pm, cwd)
      } catch (error) {
        throw new ValidateError('lockfile-unreadable', `${where}'s ${pm} root: ${error.message}`)
      }
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
    let lock
    try {
      lock = findCargoLock(cwd, host)
    } catch (error) {
      throw new ValidateError('lockfile-unreadable', `${where}'s Cargo workspace: ${error.message}`)
    }
    if (lock === null) throw new ValidateError('no-lockfile', `no Cargo.lock beside ${where}'s workspace root locks its crates: give --lockfile=path, or --no-lockfile to hold them to crates.io alone`)
    chosen.push(fromRoot(lock))
  }
  return Promise.all(chosen.map(async (path) => ({ path, text: await read(path) })))
}

// GitHub's redirects for a repository renamed or transferred.
const MOVED = new Set([301, 302, 307, 308])

// `client`'s reads of the repository `github`, followed where GitHub answers it has moved (renamed
// or transferred), as its API refuses to follow a redirect itself: the name it has now asked once,
// by the id GitHub redirects to (getRepo's followRedirect), and the read made again of it. What is
// read is held to the commit's and tree's ids all the same. `name()` the name read of.
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

// The branches compared at once, where a commit is in neither the default branch's history nor at a
// tag or a branch's head; and at most, beside the default branch.
const BRANCHES_AT_ONCE = 6
const MAX_COMPARED = 100

// The ref of `repository` (followingMoves's) that has `commit` in its history, the first of: its
// default branch, a tag at it, a branch at it, another branch; `{ branch }` or `{ tag }`, null for
// none. GitHub answers for a commit of any fork of a repository through the repository's own name
// too, its trees and files read there all the same: that one is the repository's own is that a ref
// of it holds it (as its compare tells, `ahead` of it or `identical`). Other branches are compared
// `maxCompared` at most, none past `deadline`: where those left uncompared might hold it, it can't
// tell (ValidateError, history-unread).
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

// The ecosystems of the versions fetched, which a lockfile is to lock.
const fetchedEcosystems = (plan) => new Set(plan.packages.filter((pkg) => FETCHED.has(pkg.ecosystem) && pkg.name && pkg.version).map((pkg) => pkg.ecosystem))

// git's entries of a listing (upstream's listRepoDir's or listRepoTree's) as validateBundle takes
// them, by their paths under `dir`: a file by its blob's id.
function listedEntries(listed, dir = '') {
  const entries = new Map()
  for (const entry of listed) {
    const value = entry.type === 'commit' ? { submodule: true } : entry.mode === '120000' ? { symlink: '' } : entry.type === 'blob' ? { sha: entry.sha } : undefined
    if (value) entries.set(pathIn(dir, entry.path), value)
  }
  return entries
}

// The bundle `plan` (validationPlan) validated (validateBundle) against `repository` (followingMoves's;
// null for none, its dependencies alone validated) at `commit`, under `directory`, the one it was built
// in, the commit one of the repository's own history (historyOf). Its own code, unless `own` is false,
// held to the repository's files there (repositoryFiles); or, given `listTree(paths)`, to git's blob ids
// of the commit's tree as upstream's listRepoTree lists it (`{ entries, cut }`), asked for the paths of
// the bundle's own files and of `directory`'s files, its lockfile's directories' files named by it too.
// Its dependencies held to the lockfile that installs it there (repositoryLockfiles, `lockfile` true),
// or to those `lockfile` gives (lockedBy's), or, `lockfile` false, to their registry alone. Refused
// (ValidateError): no repository or commit (`no-repository`, `no-commit`) where own code or the
// repository's lockfile is to be read, a commit of none of its own history (`commit-not-in-history`,
// `history-unread`), and no lockfile to hold the dependencies to. With `strict` false, told instead:
// own code unverified for the error's code (`own.reason`), and the dependencies held to their registry
// alone, the code told (`lockfileError`) where their lockfile went unread for it.
export async function validateRepository(plan, { repository = null, commit, directory = '' }, { own = true, lockfile = true, listTree, strict = true, fetch, deadline } = {}) {
  const ecosystems = fetchedEcosystems(plan)
  const fromRepository = lockfile === true && ecosystems.size > 0
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
    // Read at a commit of its own history alone: GitHub serves a commit of any fork of it through its name too.
    ref = repository && commit !== undefined && (own || fromRepository || plan.patches.size > 0) ? await historyOf(repository, commit, { deadline }) : undefined
    if (ref === null) {
      throw new ValidateError('commit-not-in-history', `${commit} is in the history of no branch or tag of ${repository.name()} (a fork's, say, which GitHub serves through its name too): give --sha= a commit of its own`)
    }
  } catch (error) {
    const code = told(error)
    const report = await validateBundle(plan, { reason: own ? code : 'skipped' }, { fetch, deadline })
    return fromRepository ? { ...report, lockfileError: code } : report
  }
  // Own code's files, read whole (the tree's tarball), or by git's blob ids of a listing, with each
  // directory's files' names; awaited later, its failure then.
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
  // A directory's files' names: of the listing, where it lists the directory (or is whole); else its own.
  const list = async (dir) => {
    const listed = await listing
    if (listed && (!listed.cut || listed.dirs.has(dir || '.'))) return (listed.names.get(dir || '.') ?? []).map((path) => posix.basename(path))
    return (await listDir(dir)).filter((entry) => entry.type === 'blob').map((entry) => entry.path)
  }
  // A directory that isn't there, as upstream tells it: one with no files.
  const absent = (error) => /has no directory at/u.test(error?.message ?? '')
  const under = (path) => reading && (directory === '' || path === directory || path.startsWith(`${directory}/`))
  // A directory's files of the repository by their paths in it: of the tree read for own code, where
  // it is under the bundle's; else its own tree, read once.
  const trees = new Map()
  const tree = (dir) => {
    if (!trees.has(dir)) {
      const prefix = dir ? `${dir}/` : ''
      trees.set(dir, (under(dir) ? reading : repositoryFiles(repository, { commit, directory: dir }))
        .catch((error) => {
          if (absent(error)) return new Map()
          throw error
        })
        .then((entries) => new Map([...entries].filter(([path, entry]) => path.startsWith(prefix) && entry.data).map(([path, entry]) => [path.slice(prefix.length), entry.data]))))
    }
    return trees.get(dir)
  }
  // The repository's entries at the patches the bundle holds, by git's blob ids its listings give.
  const patchEntries = async () => {
    const entries = new Map()
    const dirs = new Set([...plan.patches.keys()].map((path) => posix.dirname(pathIn(directory, path))))
    await Promise.all([...dirs].map(async (dir) => {
      const of = dir === '.' ? '' : dir
      try {
        for (const [path, entry] of listedEntries(await listDir(of), of)) entries.set(path, entry)
      } catch (error) {
        if (!absent(error)) throw error
      }
    }))
    return entries
  }
  // A file under the directory read of its tree, where that is being fetched whole; another alone.
  const readRepository = async (path) => {
    const held = under(path) ? (await reading).get(path)?.data : undefined
    return held ? asText.decode(held) : repository.getRepoFile({ path, ref: commit })
  }
  let locked = null
  let lockfileError
  try {
    const files = lockfile === false ? null : ecosystems.size === 0 ? [] : lockfile !== true ? lockfile
      : (await repositoryLockfiles({ directory, ecosystems, list, read: readRepository })).map((one) => ({
        ...one, from: 'repository', read: readRepository, tree, root: posix.relative(posix.dirname(one.path), directory),
        // A patch the lockfile names by its hash alone, looked for in the project's patches directory, then the root's.
        patches: [...new Set([pathIn(directory, 'patches'), 'patches'])],
      }))
    const held = files && lockedBy(files)
    for (const ecosystem of held ? ecosystems : []) {
      if (!held.locks(ecosystem)) throw new ValidateError('no-lockfile', `no lockfile given locks its ${ecosystem} packages: give it with --lockfile=path, or --no-lockfile to hold them to their registry alone`)
    }
    locked = held
  } catch (error) {
    lockfileError = told(error)
  }
  // The packages fetched as the repository's tree is read, where it is; own code skipped, the patches
  // the bundle holds checked all the same, where a repository and commit are given or recorded.
  const read = reading?.then((entries) => ({ entries })) ?? listing?.then(({ entries, cut }) => ({ entries, cut }))
    ?? (repository && commit !== undefined && plan.patches.size > 0 ? patchEntries().then((entries) => ({ reason: 'skipped', entries })) : null)
  // Where it was read, the name it has now where it has moved.
  const checked = read ? read.then((found) => ({ ...found, repository: repository.name(), ...(repository.name() !== github && { movedFrom: github }), commit, ref, directory })) : { reason: 'skipped' }
  const report = await validateBundle(plan, checked, { fetch, locked, deadline })
  return lockfileError ? { ...report, lockfileError } : report
}

// A bundle file validated (validateRepository): its own code against the repository its `repo` names
// (or `github`), at its commit (or `sha`), under its directory (or `directory`), read with `client`
// (@preventive/upstream/github.js) where it has moved too (followingMoves); its dependencies fetched
// with upstream, held to the lockfile that installs it there, or to the lockfiles at the paths
// `lockfile` gives, or, with `lockfile` false, to their registry alone. Its dependencies alone only
// where `own` is false. A bundle with no repository or commit to read its own code or its lockfile of
// is refused (ValidateError), as is one no lockfile it can read locks the dependencies of.
export async function validate(file, { client, github, sha, directory, own = true, lockfile = true, fetch, deadline } = {}) {
  const { kind, artifact } = parseFileWithKind(file)
  if (kind !== 'bundle') throw new ValidateError('not-a-bundle', `${file} is a lockfile, which holds no file to check; give a bundle`)
  const plan = validationPlan(artifact)
  const repo = artifact.repo ?? {}
  const where = { github: github ?? repo.github, commit: sha ?? repo.commit, directory: directory ?? repo.directory ?? '' }
  const readLocal = (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      throw new ValidateError('lockfile-unreadable', `${path}: ${error.message}`)
    }
  }
  // Each read as it is held to, once the commit is: none where no package needs one.
  const lockfiles = Array.isArray(lockfile) ? lockfile.map((path) => ({ path, get text() { return readLocal(path) }, from: 'local', read: readLocal, root: where.directory })) : lockfile
  try {
    return await validateRepository(plan, { repository: where.github === undefined ? null : followingMoves(client, where.github), commit: where.commit, directory: where.directory },
      { own, lockfile: lockfiles, fetch, deadline })
  } catch (error) {
    if (!(error instanceof ValidateError) || !['no-repository', 'no-commit'].includes(error.code)) throw error
    // What the file records none of, and what to give in its place.
    const fromRepository = lockfile === true && fetchedEcosystems(plan).size > 0
    const or = !own ? 'or --lockfile=path, or --no-lockfile to hold its dependencies to their registry alone'
      : fromRepository ? 'or, to validate its dependencies alone, --only-deps with --lockfile=path or --no-lockfile' : 'or --only-deps to validate its dependencies alone'
    const what = own ? 'its own code' : 'its lockfile'
    throw error.code === 'no-repository'
      ? new ValidateError('no-repository', `${file} records no repository to read ${what} of: give --github=owner/name and --sha=commit, ${or}`)
      : new ValidateError('no-commit', `${file} records no commit to read ${what} at: give --sha=commit, ${or}`)
  }
}

// Each status's colour: failing red, unverified yellow, valid green.
const TONES = { differs: 'red', unexpected: 'red', invalid: 'red', unverified: 'yellow', incomplete: 'yellow', valid: 'green' }

// What a package told is of, as a table names it: an npm one by its name and version alone.
const packageName = (of) => of.replace(/^npm:/u, '')

// The report as tables on `out`: the files failing, and own ones unverified, one row for each kind of
// what they are of (own code, or a package), the worst first; then the packages with something to
// tell (why they are unverified or fail, a patch, a directory), those valid only with `showValid`.
// The summary on `err`: its status and counts, where own code was read or why not, and the lockfiles
// held to. Their statuses in colour, where each stream takes colours (`colors`, else takesColors).
export function printValidationReport(report, { out = process.stdout, err = process.stderr, showValid = false, colors } = {}) {
  const paintOut = painter(out, colors)
  const paintErr = painter(err, colors)
  // A row's status in its colour, and own code dimmed beside a package.
  const status = (paint) => (text, column, row) => paint(column === 'status' ? TONES[row.status] : column === 'of' && row.of === 'own code' ? DIM : null, text)
  const tables = []
  const files = [...Map.groupBy(report.problems, (problem) => `${problem.kind}\0${problem.of}`).values()].map((group) => ({
    status: group[0].kind,
    of: group[0].of === 'own' ? 'own code' : packageName(group[0].of),
    files: group.map((problem) => `${problem.path}${problem.reason ? ` (${FILE_REASONS[problem.reason] ?? problem.reason})` : ''}`).join('\n'),
  }))
  if (files.length > 0) tables.push(formatTable(files, ['status', 'of', 'files'], { multiline: ['files'], paint: status(paintOut) }) + (report.moreProblems > 0 ? `\n... and ${report.moreProblems} more files` : ''))
  const told = report.packages.filter((pkg) => (showValid || pkg.status !== 'valid') && noteText(pkg) !== '')
  // The ecosystem a column of its own only where one is not npm's.
  const ecosystems = told.some((pkg) => pkg.ecosystem !== 'npm')
  const packages = told.map((pkg) => ({ status: pkg.status, ...(ecosystems && { ecosystem: pkg.ecosystem }), package: `${pkg.name}@${pkg.version}`, note: noteText(pkg) }))
  if (packages.length > 0) tables.push(formatTable(packages, ['status', ...(ecosystems ? ['ecosystem'] : []), 'package', 'note'], { paint: status(paintOut) }))
  if (tables.length > 0) out.write(`${tables.join('\n\n')}\n`)

  const { counts, own } = report
  const lines = [
    `${paintErr(['bold', TONES[report.status]], report.status)}: ${counts.matched} of ${counts.files} files as they should be, ${counts.differs} differ, ${counts.unexpected} unexpected, ${counts.unverified} unverified${counts.skipped ? `, ${counts.skipped} skipped` : ''}; ${counts.validPackages} of ${counts.packages} packages as published${counts.lockFailures ? `, ${counts.lockFailures} failing their lockfile` : ''}${counts.misplaced ? `, ${counts.misplaced} installed where another is` : ''}${counts.eol ? `; ${counts.eol} with a checkout's CRLF line endings` : ''}`,
    own.checked ? `Own code held to ${own.repository}${own.movedFrom ? ` (moved from ${own.movedFrom})` : ''} at ${own.commit}${own.ref ? (own.ref.tag ? `, tag ${own.ref.tag}` : ` of ${own.ref.branch}`) : ''}${own.directory ? ` under ${own.directory}` : ''}`
      : paintErr('yellow', `Own code not verified: ${OWN_REASONS[own.reason] ?? own.reason}${own.patches ? `; the ${own.patches === 1 ? 'patch' : `${own.patches} patches`} the bundle holds checked all the same` : ''}`),
    ...(report.lockfiles?.length > 0 ? [`Dependencies held to ${report.lockfiles.join(', ')}`]
      : report.lockfiles === null && counts.packages > 0
        ? [paintErr('yellow', `Dependencies held to no lockfile (${report.lockfileError ? LOCKFILE_ERRORS[report.lockfileError] ?? report.lockfileError : '--no-lockfile'}): each to its registry's integrity alone`)] : []),
  ]
  err.write(`${lines.join('\n')}\n`)
}
