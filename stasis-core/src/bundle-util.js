import { isUtf8 } from 'node:buffer'
import { dirname, join, posix, relative, resolve } from 'node:path'

import { isValidRepoField } from './bundle.js'
import { isPackageString, isSubpackage, posixPathEscapes } from './artifact-util.js'
import { diskHost } from './host.js'
import { assertRealPathWithinBase, hasNodeModulesSegment, memoized, relativeEscapes, splitNodeModulesPath, toPosix } from './util.js'

// Text as Node reads a package.json: UTF-8, past a byte order mark.
const utf8 = new TextDecoder()
export const packageJSONText = (bytes) => utf8.decode(bytes)

// The `type` of the package.json nearest `file`, read through `kept(path, read)`, a cache by that
// package.json's path where one is given (a scan's, which reads the same one for each file under it).
export function packageType(file, host = diskHost, kept = (path, read) => read()) {
  const pkg = host.findPackageJSON(file)
  if (!pkg) return null
  return kept(pkg, () => {
    const type = readJson(pkg, host)?.type
    return type === 'module' || type === 'commonjs' ? type : null
  })
}

// Package-relative dirs, by host package name (so any layout or alias matches), holding copies of OTHER
// packages: a file there is its host's (State#locateModule holds the copy's package.json to nothing), listed
// in the record's `vendored`. Maintained list: add only a confirmed upstream layout, with its reason.
const VENDOR_DIRS = {
  __proto__: null,
  next: ['dist/compiled'], // the dependencies Next.js compiles in, ~140, each with a trimmed package.json
}
const VENDOR_DIR_LIST = Object.values(VENDOR_DIRS).flat()

// Whether a package-relative path is below any package's vendor dir: no need to read whose it is otherwise.
const inAnyVendorDir = (rel) => VENDOR_DIR_LIST.some((dir) => rel.startsWith(`${dir}/`))

// The vendor dir of the package named `name` that its file `rel` (package-relative, POSIX) is below, or undefined.
export const vendorDirOf = (name, rel) => VENDOR_DIRS[name]?.find((dir) => rel.startsWith(`${dir}/`))

// A package.json's `name`, and its `version` where that is a package string, as `vendored` and `subpackages` list one.
const manifestIdentity = (pkg) => ({ name: pkg.name, ...(isPackageString(pkg.version) ? { version: pkg.version } : {}) })

// The package vendored under `vendorDir` that host file `rel` is in: walking up while below it, the first
// package.json with a `name` (`read(dir)`, null where none) -> `vendored` { dir, name, version? }, undefined
// if none or its name is no package string. `below`: whether any package.json there covers the file at all.
export function vendoredPackageOf(rel, vendorDir, read) {
  let below = false
  for (let dir = posix.dirname(rel); dir.startsWith(`${vendorDir}/`); dir = posix.dirname(dir)) {
    const pkg = read(dir)
    if (pkg === null) continue
    below = true
    if (pkg?.name === undefined) continue // a `{"type":"module"}` marker inside the vendored package
    return isPackageString(pkg.name) ? { below, vendored: { dir, ...manifestIdentity(pkg) } } : { below }
  }
  return { below }
}

// The nearest package.json with a `name` above a file `rel` of a package (package-relative, POSIX), below the
// package's own, walking past `{"type":"module"}` markers, each read by `read(dir)` (null where there is
// none) -> { dir, pkg }, or undefined where there is none.
export function namedManifestOf(rel, read) {
  for (let dir = posix.dirname(rel); dir !== '.'; dir = posix.dirname(dir)) {
    const pkg = read(dir)
    if (pkg?.name !== undefined) return { dir, pkg }
  }
  return undefined
}

// The package.json nearest above `rel`, short of its package's own at `pkgDir` (both project-relative):
// a `{"type":"module"}` marker (`esm/package.json`), a subpackage's or a vendored one's, which Node takes the
// file's `type` from and Metro's getPackageForModule its fields. undefined where the package's own is nearest.
export function scopeManifestOf(rel, pkgDir, exists) {
  if (pkgDir !== '.' && !rel.startsWith(`${pkgDir}/`)) return undefined
  for (let dir = posix.dirname(rel); dir !== pkgDir && dir !== '.'; dir = posix.dirname(dir)) {
    if (exists(`${dir}/package.json`)) return `${dir}/package.json`
  }
  return undefined
}

// The nearest package.json up from a file that identifies a bucket (pkgDir relative to baseDir, "." at the
// root), else null: in node_modules it needs name and version; outside, a name alone, as State#locateModule.
// A malformed one is walked past, or with `strict` throws (its files would otherwise land in the parent's).
export function findPackageMetadata(baseDir, fileRelPath, { strict = false, check, host = diskHost } = {}) {
  const options = { strict, check, host }
  const read = (rel) => readPackageJson(baseDir, rel, options)
  const nm = splitNodeModulesPath(toPosix(fileRelPath))
  // A file in a vendored package (vendorDirOf) is its host's, as State#locateModule has it, with the
  // package as the record's `vendored` lists it (vendoredPackageOf).
  if (nm !== null && inAnyVendorDir(nm.rel)) {
    const pkg = read(`${nm.dir}/package.json`)
    const vendorDir = pkg?.name && pkg.version ? vendorDirOf(pkg.name, nm.rel) : undefined
    const { below, vendored } = vendorDir === undefined ? {} : vendoredPackageOf(nm.rel, vendorDir, (sub) => read(`${nm.dir}/${sub}/package.json`))
    if (below) {
      const repo = packageRepo(pkg)
      const { dir: sub, ...identity } = vendored ?? {}
      return { pkgDir: nm.dir, name: pkg.name, version: pkg.version, ecosystem: 'npm', ...(repo === undefined ? {} : { repo }), ...(vendored === undefined ? {} : { vendored: { [sub]: identity } }) }
    }
  }
  // A file in a subpackage is its host's too, that package.json walked past: the nearest one with a name
  // (past `{"type":"module"}` markers, as namedManifestOf walks), listed as `subpackages` would list it.
  let subpackages
  let nearest = true
  for (let dir = dirname(fileRelPath); ; dir = dirname(dir)) {
    const pkg = read(toPosix(join(dir, 'package.json')))
    const posixDir = toPosix(dir)
    const inNodeModules = hasNodeModulesSegment(posixDir)
    const sub = pkg?.name && nm !== null ? hostSubpackageDir(read, nm.dir, posixDir, pkg.name) : undefined
    if (sub !== undefined) {
      if (nearest) subpackages = { [sub]: manifestIdentity(pkg) }
    } else if (pkg?.name && (pkg.version || !inNodeModules)) {
      const repo = inNodeModules ? packageRepo(pkg) : undefined
      const own = posixDir === nm?.dir ? subpackages : undefined // the subpackage's package, not one above it
      // `?? undefined` folds a literal `"version": null` into the one absent-version spelling.
      return { pkgDir: dir, name: pkg.name, version: pkg.version ?? undefined, ...(inNodeModules ? { ecosystem: 'npm' } : {}), ...(repo === undefined ? {} : { repo }), ...(own === undefined ? {} : { subpackages: own }) }
    }
    if (pkg?.name) nearest = false
    if (dirname(dir) === dir) return null // '.' and a filesystem root are their own dirname
  }
}

// findPackageMetadata (with `options`) of each project-relative path, once per directory, the only
// thing its answer depends on.
export function packageLookup(baseDir, options) {
  return memoized((path) => findPackageMetadata(baseDir, path, options), (path) => posix.dirname(path))
}

// The directory, package-relative, of the package.json naming `manifestName` at `dir` (project-relative,
// POSIX) where it is a subpackage (isSubpackage) of the package at `pkgDir`; else undefined. The package's
// own package.json is read (`read(rel)`) only where the name ends in that directory.
function hostSubpackageDir(read, pkgDir, dir, manifestName) {
  if (!dir.startsWith(`${pkgDir}/`)) return undefined
  const sub = dir.slice(pkgDir.length + 1)
  if (typeof manifestName !== 'string' || !manifestName.endsWith(`/${sub}`)) return undefined
  return isSubpackage(manifestName, read(`${pkgDir}/package.json`)?.name, sub) ? sub : undefined
}

// The error codes that mean nothing is at a path.
export const NO_ENTRY = new Set(['ENOENT', 'ENOTDIR'])

// Whether anything is at `p` itself, a link not followed, a broken one too (`host.readlink` throws
// when nothing is).
export function lexists(p, host) {
  try {
    host.readlink(p)
    return true
  } catch (err) {
    if (NO_ENTRY.has(err.code)) return false
    throw err
  }
}

// host.stat as real stat answers: null only when nothing is there (missing, through a file, a dangling link),
// where host.stat answers null for any failure, as Node's module lookup does. Something there that can't be
// read (a link loop, an unsearchable directory, a too-long name) throws `fail(cause)`.
function statOrFail(host, file, fail) {
  const stat = host.stat(file)
  if (stat !== null) return stat
  try {
    host.readFile(file)
  } catch (err) {
    if (NO_ENTRY.has(err.code)) return null
    throw fail(err)
  }
  throw fail(new Error(`${file} could be read but not stat'ed`))
}

// host.stat as real stat answers (statOrFail), naming the file `label` where it can't be stat'ed.
export function statStrict(host, file, label) {
  return statOrFail(host, file, (cause) => new Error(`${label}: can't be read (${cause.code ?? cause.message})`, { cause }))
}

// The error Node gives for a package.json at `path` that is no JSON object (`cause`: why it doesn't parse).
export const invalidPackageConfig = (path, cause) =>
  Object.assign(new Error(`Invalid package config ${path}.`, cause === undefined ? {} : { cause }), { code: 'ERR_INVALID_PACKAGE_CONFIG' })

// host.stat for a package.json, as Node's lookups read one (statOrFail): one that can't be read throws
// ERR_INVALID_PACKAGE_CONFIG, as Node refuses it.
export function packageJSONStat(host, file) {
  return statOrFail(host, file, (cause) =>
    Object.assign(new Error(`Cannot read package config ${file}: ${cause.code ?? cause.message}.`, { cause }), { code: 'ERR_INVALID_PACKAGE_CONFIG' }))
}

// `file`'s bytes, or null when there's no file (a directory counts as none). A FIFO, a socket, a device or a
// link to one (`/dev/stdin`) throws, naming it `label`, rather than stalling or reading the process's input;
// so does one there that can't be read (statStrict).
export function readRegularFileOrNull(file, label, host = diskHost) {
  const stat = statStrict(host, file, label)
  if (stat === null || stat.isDirectory()) return null
  if (!stat.isFile()) throw new Error(`${label}: not a regular file`)
  return host.readFile(file)
}

// The package.json at `rel`, parsed (past a BOM, as npm and Node), or null when there's none or it can't be
// read, isn't a regular file or doesn't parse -- unless `strict`: then only nothing there is null (statStrict,
// as Node reads one) and the rest throws. `check(rel)` sees the path before it is read, and may refuse it.
export function readPackageJson(baseDir, rel, { strict = false, check, host = diskHost } = {}) {
  const file = join(baseDir, rel)
  const stat = strict ? statStrict(host, file, rel) : host.stat(file)
  if (stat === null || stat.isDirectory()) return null
  check?.(rel)
  try {
    // A FIFO, a socket or a device (or a link to one) is never read: it could stall the bundle.
    if (!stat.isFile()) throw new Error(`${rel}: not a regular file`)
    const bytes = host.readFile(file)
    // Strict, it's read as the file's own text or not at all; lenient lookups decode it as they always
    // have (a stray byte as U+FFFD).
    if (strict && !isUtf8(bytes)) throw new Error(`${rel}: not valid UTF-8`)
    return parseJson(packageJSONText(bytes), rel)
  } catch (err) {
    if (strict) throw err
    return null
  }
}

// JSON.parse, throwing where the text breaks (the parser's line and column) but never the parser's
// message, which quotes the text (a file that isn't JSON may be anything, a secret included).
function parseJson(text, rel) {
  try {
    return JSON.parse(text)
  } catch (err) {
    const at = /\(line \d+ column \d+\)/u.exec(err.message)?.[0]
    // eslint-disable-next-line preserve-caught-error -- the parser's error quotes the file
    throw new Error(`${rel} is not valid JSON${at ? ` ${at}` : ''}`)
  }
}

export function normalizeEntries(entries, cwd) {
  const baseDir = resolve(cwd)
  return entries.map((e) => {
    const rel = toPosix(relative(baseDir, resolve(cwd, e)))
    if (relativeEscapes(rel)) throw new Error(`Entry escapes baseDir: ${e}`)
    return rel.replace(/^\.\//u, '')
  })
}

// Bytes of a bundled module's `package.json`, or null to skip when it's absent; one that can't be
// read (statStrict) or isn't UTF-8 aborts (never silently skipped).
export function readModuleManifest({ baseDir, realBase, rel, host = diskHost } = {}) {
  const absolute = join(baseDir, rel)
  if (statStrict(host, absolute, rel) === null) return null
  assertRealPathWithinBase(realBase, baseDir, rel, host)
  const buf = host.readFile(absolute)
  if (!isUtf8(buf)) throw new Error(`package.json is not valid UTF-8: ${rel}`)
  return buf
}

// Never throws: a missing/unreadable/malformed file yields null.
export function readJson(file, host = diskHost) {
  try {
    return JSON.parse(packageJSONText(host.readFile(file)))
  } catch {
    return null
  }
}

// `owner/name` from a package.json `repository` URL or shorthand (`www.`, `#committish` ignored), else null.
// Userinfo holds only what RFC 3986 allows: a `?` or `\` ending the authority early isn't GitHub's
// (`https://evil.example?@github.com/a/b`). scp-like `git@github.com:o/n` is taken behind `ssh://` too.
export function parseGithubRepository(url) {
  if (typeof url !== 'string') return null
  const match = /^(?:github:|(?:git\+)?(?:(?:https?|ssh|git):\/\/(?:[\w.~%!$&'()*+,;=:-]*@)?(?:www\.)?github\.com(?::\d+)?\/|ssh:\/\/(?:[\w.~%!$&'()*+,;=-]*@)?(?:www\.)?github\.com:|(?:[^@/:]+@)?(?:www\.)?github\.com:))?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(url.trim().replace(/#.*$/su, ''))
  // Must also pass the bundle format's `github` check.
  const github = match && `${match[1]}/${match[2]}`
  return github && isValidRepoField('github', github) ? github : null
}

// Best-effort `origin` url: literal match of git's own `.git/config` layout, no parsing.
const GIT_ORIGIN_URL = '[remote "origin"]\n\turl = '
export function gitOriginUrl(text) {
  const at = text?.indexOf(GIT_ORIGIN_URL) ?? -1
  if (at === -1) return null
  return text.slice(at + GIT_ORIGIN_URL.length).split('\n', 1)[0].trim() || null
}

// The text of `file`, or null. Read through `host` (never the --fs-patched fs), it is never captured.
export const readText = (host, file) => {
  try {
    return host.readFile(file).toString('utf8')
  } catch {
    return null
  }
}

// Dir of a `https://github.com/<github>/tree/<branch>/<dir>` homepage (one-segment branch).
export function githubHomepageDirectory(homepage, github) {
  if (typeof homepage !== 'string') return undefined
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/]+)\/tree\/[^/#?]+\/([^#?]+)/iu.exec(homepage.trim())
  if (!match || match[1].toLowerCase() !== github.toLowerCase()) return undefined
  try {
    return decodeURIComponent(match[2])
  } catch {
    return undefined
  }
}

const repoLocation = (directory) => (isValidRepoField('directory', directory) ? { directory } : {})

// Whether a declared path is the repository's root: nothing but empty and `.` parts (`./`, `/.`).
const isRootPath = (path) => path.replaceAll('\\', '/').split('/').every((part) => part === '' || part === '.')

// A package.json's `repository.directory` (`base`) joined with `rel` as a repoLocation; `{}` where none is
// declared (unknown, not the root) or `base` has a `..` part (`a/..` is no claim on the root). Its `\` is a
// separator: Windows users write it so, and it is metadata, not a name on disk.
const declaredLocation = (base, rel) => {
  if (typeof base !== 'string') return {}
  const path = base.replaceAll('\\', '/')
  if (path.split('/').includes('..')) return {}
  const directory = posix.join(path, rel).replace(/^\/+|\/+$/gu, '')
  return repoLocation(directory === '.' ? '' : directory)
}

// Git and common dirs, following a worktree/submodule `.git` file.
function gitDirs(dotGit, host) {
  const pointer = readText(host, dotGit) // null for a `.git` directory (EISDIR)
  const gitDir = pointer?.startsWith('gitdir: ') ? resolve(dirname(dotGit), pointer.slice('gitdir: '.length).trim()) : dotGit
  const common = readText(host, join(gitDir, 'commondir'))?.trim()
  return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir }
}

// HEAD's commit: detached sha, loose ref, or packed-refs; undefined unless a valid sha.
function gitHeadCommit({ gitDir, commonDir }, host) {
  const head = readText(host, join(gitDir, 'HEAD'))?.trim()
  if (!head) return undefined
  let commit = head
  if (head.startsWith('ref: ')) {
    const ref = head.slice('ref: '.length)
    if (!ref.startsWith('refs/') || posixPathEscapes(ref)) return undefined
    commit = readText(host, join(commonDir, ref))?.trim() ??
      readText(host, join(commonDir, 'packed-refs'))?.split('\n').find((line) => line.endsWith(` ${ref}`))?.split(' ')[0]
  }
  return isValidRepoField('commit', commit) ? commit : undefined
}

// HEAD's commit of the git checkout at `dir` (gitHeadCommit), its `.git` a directory or the `gitdir:`
// file of a submodule or worktree; undefined where it holds none. Read through `host`, under `.git`
// alone; git never runs.
export function checkoutCommit(dir, host = diskHost) {
  const dotGit = join(dir, '.git')
  return host.stat(dotGit) === null ? undefined : gitHeadCommit(gitDirs(dotGit, host), host)
}

// A parsed package.json's `repository` url (the string shorthand, or its `url`), or undefined.
function repositoryUrl(json) {
  const repository = json?.repository
  const url = typeof repository === 'string' ? repository : repository?.url
  return typeof url === 'string' ? url : undefined
}

// The `repo` a parsed package.json's `repository` names for `rel`, a directory below it ('' for its
// own): `github` from its GitHub URL or shorthand, and `directory` from `repository.directory` joined
// with `rel` (declaredLocation); undefined where it names no GitHub repository.
function declaredRepo(json, rel) {
  const github = parseGithubRepository(repositoryUrl(json))
  if (!github) return undefined
  let base = json.repository.directory
  // Often unset; fall back to a GitHub tree `homepage`, which places a package below the root, never
  // at it: only `repository.directory` declares the root (`/tree/main/.` declares nothing).
  if (typeof base !== 'string') {
    base = githubHomepageDirectory(json.homepage, github)
    if (base !== undefined && isRootPath(base)) base = undefined
  }
  return { github, ...declaredLocation(base, rel) }
}

// A dependency's `repo` from its package.json (declaredRepo), at the full commit its `gitHead` names. npm
// publish writes `gitHead` only to the registry's version document, but lerna writes it into package.json
// too and npm keeps it, so the two agree.
export function packageRepo(json) {
  const repo = declaredRepo(json, '')
  return repo !== undefined && isValidRepoField('commit', json.gitHead) ? { ...repo, commit: json.gitHead } : repo
}

// Bundle `repo` for `dir`: git origin/HEAD at the work tree root, with `dir`'s place in it (`''` at
// the root), else nearest package.json `repository` (declaredRepo). Its commit is git's HEAD alone,
// never a package.json's `gitHead`: a project's own files are likely changed since the one it names.
export function detectRepo(dir, host = diskHost) {
  const start = resolve(dir)
  let pkg = null // null: no package.json `repository` seen yet; undefined: one seen, not GitHub
  for (let cursor = start; ; cursor = dirname(cursor)) {
    const rel = toPosix(relative(cursor, start))
    if (pkg === null) {
      const json = readJson(join(cursor, 'package.json'), host)
      if (repositoryUrl(json) !== undefined) pkg = declaredRepo(json, rel)
    }
    const dotGit = join(cursor, '.git')
    if (host.stat(dotGit) !== null) {
      const dirs = gitDirs(dotGit, host)
      const github = parseGithubRepository(gitOriginUrl(readText(host, join(dirs.commonDir, 'config'))))
      if (!github) return pkg ?? undefined
      const commit = gitHeadCommit(dirs, host)
      return { github, ...repoLocation(rel), ...(commit === undefined ? {} : { commit }) }
    }
    if (dirname(cursor) === cursor) return pkg ?? undefined
  }
}
