import { isUtf8 } from 'node:buffer'
import { dirname, join, posix, relative, resolve } from 'node:path'

import { isValidRepoField } from './bundle.js'
import { isPackageString, posixPathEscapes } from './artifact-util.js'
import { diskHost } from './host.js'
import { assertRealPathWithinBase, hasNodeModulesSegment, relativeEscapes, splitNodeModulesPath, toPosix } from './util.js'

// Text as Node reads a package.json: UTF-8, past a byte order mark.
const utf8 = new TextDecoder()
export const packageJSONText = (bytes) => utf8.decode(bytes)

export function packageType(file, host = diskHost) {
  const pkg = host.findPackageJSON(file)
  if (!pkg) return null
  try {
    const type = JSON.parse(packageJSONText(host.readFile(pkg))).type
    return type === 'module' || type === 'commonjs' ? type : null
  } catch {
    return null
  }
}

// Directories where a package keeps copies of OTHER packages, each under a package.json of its own,
// by the host package's name (so any install layout or alias matches), package-relative. A package.json
// below one is a vendored package's: it names that package, not its host, so a file it covers is its
// host's (State#locateModule holds it to nothing), listed under that package in the host record's
// `vendored`. Maintained list: add only a confirmed upstream vendoring layout, with its reason.
const VENDOR_DIRS = {
  __proto__: null,
  next: ['dist/compiled'], // the dependencies Next.js compiles in, ~140, each with a trimmed package.json
}
const VENDOR_DIR_LIST = Object.values(VENDOR_DIRS).flat()

// Whether a package-relative path is below any package's vendor dir: no need to read whose it is otherwise.
const inAnyVendorDir = (rel) => VENDOR_DIR_LIST.some((dir) => rel.startsWith(`${dir}/`))

// The vendor dir of the package named `name` that its file `rel` (package-relative, POSIX) is below, or undefined.
export const vendorDirOf = (name, rel) => VENDOR_DIRS[name]?.find((dir) => rel.startsWith(`${dir}/`))

// The package vendored under `vendorDir` (package-relative) that a file `rel` of its host is in: walking
// up from the file, while below the vendor dir, the first package.json with a `name`, which `read(dir)`
// gives (null where there is none) -> `vendored` { dir, name, version? }, undefined where none has a name
// or its name is no package string (a version that is none is left out). `below`: whether any package.json
// there covers the file at all.
export function vendoredPackageOf(rel, vendorDir, read) {
  let below = false
  for (let dir = posix.dirname(rel); dir.startsWith(`${vendorDir}/`); dir = posix.dirname(dir)) {
    const pkg = read(dir)
    if (pkg === null) continue
    below = true
    if (pkg?.name === undefined) continue // a `{"type":"module"}` marker inside the vendored package
    if (!isPackageString(pkg.name)) return { below }
    return { below, vendored: { dir, name: pkg.name, ...(isPackageString(pkg.version) ? { version: pkg.version } : {}) } }
  }
  return { below }
}

// Nearest package.json (walking up) that identifies a bucket; pkgDir is relative to baseDir ("."
// at the root). Inside node_modules both name and version are required; a workspace package
// outside node_modules may omit version (the name alone claims the bucket, matching
// State#locateModule), and a node_modules one's `ecosystem` (npm) and `repo`, where its `repository`
// names a GitHub one (packageRepo). Null if none. A malformed one is walked past, or with `strict` throws
// (its files would otherwise land in the parent package); `check`, `host`: see readPackageJson.
// A file in a vendored package (vendorDirOf) is its host's, as State#locateModule has it, with the
// package as the record's `vendored` would list it, `{ [dir]: { name, version? } }` (vendoredPackageOf).
export function findPackageMetadata(baseDir, fileRelPath, { strict = false, check, host = diskHost } = {}) {
  const nm = splitNodeModulesPath(toPosix(fileRelPath))
  if (nm !== null && inAnyVendorDir(nm.rel)) {
    const read = (rel) => readPackageJson(baseDir, rel, { strict, check, host })
    const pkg = read(`${nm.dir}/package.json`)
    const vendorDir = pkg?.name && pkg.version ? vendorDirOf(pkg.name, nm.rel) : undefined
    const { below, vendored } = vendorDir === undefined ? {} : vendoredPackageOf(nm.rel, vendorDir, (sub) => read(`${nm.dir}/${sub}/package.json`))
    if (below) {
      const repo = packageRepo(pkg)
      const { dir: sub, ...identity } = vendored ?? {}
      return { pkgDir: nm.dir, name: pkg.name, version: pkg.version, ecosystem: 'npm', ...(repo === undefined ? {} : { repo }), ...(vendored === undefined ? {} : { vendored: { [sub]: identity } }) }
    }
  }
  for (let dir = dirname(fileRelPath); ; dir = dirname(dir)) {
    const pkg = readPackageJson(baseDir, toPosix(join(dir, 'package.json')), { strict, check, host })
    const inNodeModules = hasNodeModulesSegment(toPosix(dir))
    if (pkg?.name && (pkg.version || !inNodeModules)) {
      const repo = inNodeModules ? packageRepo(pkg) : undefined
      // `?? undefined` folds a literal `"version": null` into the one absent-version spelling.
      return { pkgDir: dir, name: pkg.name, version: pkg.version ?? undefined, ...(inNodeModules ? { ecosystem: 'npm' } : {}), ...(repo === undefined ? {} : { repo }) }
    }
    if (dir === '.' || dir === '/' || dir === '' || dirname(dir) === dir) return null
  }
}

// The error codes that mean nothing is at a path.
export const NO_ENTRY = new Set(['ENOENT', 'ENOTDIR'])

// Why `file` can't be read, where `host.stat` gave null, or null when nothing is there (a missing
// path, one through a file, a link to nothing). host.stat answers null for any failure, as Node's
// module lookup does; real stat tells them apart: a link loop, a directory that may not be searched
// or a name too long is something there that can't be read, and a read meets the same error.
function readFailure(host, file) {
  try {
    host.readFile(file)
  } catch (err) {
    return NO_ENTRY.has(err.code) ? null : err
  }
  return new Error(`${file} could be read but not stat'ed`)
}

// host.stat as real stat answers: null only when nothing is there (readFailure); anything else that
// can't be stat'ed throws, naming the file `label`.
export function statStrict(host, file, label) {
  const stat = host.stat(file)
  if (stat !== null) return stat
  const failure = readFailure(host, file)
  if (failure === null) return null
  throw new Error(`${label}: can't be read (${failure.code ?? failure.message})`, { cause: failure })
}

// host.stat for a package.json, as Node's lookups read one: null when nothing is there, and one that
// can't be read (a link loop, a directory that may not be searched) throws ERR_INVALID_PACKAGE_CONFIG,
// as Node refuses it.
export function packageJSONStat(host, file) {
  const stat = host.stat(file)
  if (stat !== null) return stat
  const cause = readFailure(host, file)
  if (cause === null) return null
  throw Object.assign(new Error(`Cannot read package config ${file}: ${cause.code ?? cause.message}.`, { cause }), { code: 'ERR_INVALID_PACKAGE_CONFIG' })
}

// `file`'s bytes, read through `host`, or null when there's no file (a directory counts as none).
// It's read only when it's a regular file: a FIFO, a socket, a device or a link to one
// (`/dev/stdin`) throws, naming it `label`, rather than stalling or reading the process's input, and
// so does one there that can't be read (statStrict).
export function readRegularFileOrNull(file, label, host = diskHost) {
  const stat = statStrict(host, file, label)
  if (stat === null || stat.isDirectory()) return null
  if (!stat.isFile()) throw new Error(`${label}: not a regular file`)
  return host.readFile(file)
}

// The package.json at `rel` (under `baseDir`), parsed (a leading byte-order mark skipped, as npm
// and Node skip it), read through `host`; null when there's none (a directory counts as none), or
// when it doesn't parse, isn't a regular file or can't be read -- unless `strict`, then that throws
// (only nothing there is no package.json, as Node reads one: statStrict), saying where
// with the parser's line and column but never its message, which quotes the text (a file that isn't
// JSON may be anything, a secret included). `check(rel)`, when given, sees the path before it is
// read, and may throw to refuse it.
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
// message, which quotes the text.
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

// `owner/name` from a package.json `repository` (GitHub URL or shorthand), else null. A `#committish`
// npm lets it name is no part of the repo; a URL's userinfo holds only what RFC 3986 allows there, so
// a `?` or `\` ending the authority early (`https://evil.example?@github.com/a/b`) isn't GitHub's. An
// scp-like `git@github.com:owner/name` is taken behind an `ssh://` too (`git+ssh://git@github.com:o/n`),
// as package.json files spell it. The host is GitHub's with a `www.` too, which is stripped.
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
  const start = at + GIT_ORIGIN_URL.length
  const end = text.indexOf('\n', start)
  return text.slice(start, end === -1 ? undefined : end).trim() || null
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

// `{ directory }` where it is a valid one, else `{}`.
const repoLocation = (directory) => (isValidRepoField('directory', directory) ? { directory } : {})

// Whether a declared path is the repository's root: nothing but empty and `.` parts (`./`, `/.`).
const isRootPath = (path) => path.replaceAll('\\', '/').split('/').every((part) => part === '' || part === '.')

// A package.json's declared `base` (its `repository.directory`) joined with `rel` as a `repoLocation`;
// `{}` where none is declared (unknown, not the root), or where `base` has a `..` part, whatever it
// would come to (`a/..` is no claim on the root). Its empty and `.` parts are dropped, and one that
// comes to the root (`''`, `.`, `./`, `/`, `/.`) is the root, `''`. Windows users write `base` with
// `\`: metadata, not a name on disk, so its `\` is taken for a separator.
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
export function packageRepo(json, rel = '') {
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

// Bundle `repo` for `dir`: git origin/HEAD at the work tree root, with `dir`'s place in it (`''` at
// the root), else nearest package.json `repository` (packageRepo).
export function detectRepo(dir, host = diskHost) {
  const start = resolve(dir)
  let pkg = null // null: no package.json `repository` seen yet; undefined: one seen, not GitHub
  for (let cursor = start; ; cursor = dirname(cursor)) {
    const rel = toPosix(relative(cursor, start))
    if (pkg === null) {
      const json = readJson(join(cursor, 'package.json'), host)
      if (repositoryUrl(json) !== undefined) pkg = packageRepo(json, rel)
    }
    const dotGit = join(cursor, '.git')
    if (host.stat(dotGit) !== null) {
      const dirs = gitDirs(dotGit, host)
      const github = parseGithubRepository(gitOriginUrl(readText(host, join(dirs.commonDir, 'config'))))
      if (github) return stripUndefined({ github, ...repoLocation(rel), commit: gitHeadCommit(dirs, host) })
      return pkg ?? undefined
    }
    if (dirname(cursor) === cursor) return pkg ?? undefined
  }
}

const stripUndefined = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
