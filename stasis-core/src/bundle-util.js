import { isUtf8 } from 'node:buffer'
import { dirname, join, posix, relative, resolve } from 'node:path'

import { isValidRepoField } from './bundle.js'
import { isPackageString, isSubpackage, posixPathEscapes } from './artifact-util.js'
import { diskHost } from './host.js'
import { assertRealPathWithinBase, hasNodeModulesSegment, memoized, relativeEscapes, splitNodeModulesPath, toPosix } from './util.js'

// As Node reads a package.json: UTF-8, past a byte order mark.
const utf8 = new TextDecoder()
export const packageJSONText = (bytes) => utf8.decode(bytes)

// `kept(path, read)` caches by the package.json's path (a scan reads the same one for each file under it).
export function packageType(file, host = diskHost, kept = (path, read) => read()) {
  const pkg = host.findPackageJSON(file)
  if (!pkg) return null
  return kept(pkg, () => {
    const type = readJson(pkg, host)?.type
    return type === 'module' || type === 'commonjs' ? type : null
  })
}

// By host package name, so any layout or alias matches. Add only a confirmed upstream layout, with its reason.
const VENDOR_DIRS = {
  __proto__: null,
  next: ['dist/compiled'], // the dependencies Next.js compiles in, ~140, each with a trimmed package.json
}
const VENDOR_DIR_LIST = Object.values(VENDOR_DIRS).flat()

const inAnyVendorDir = (rel) => VENDOR_DIR_LIST.some((dir) => rel.startsWith(`${dir}/`))

export const vendorDirOf = (name, rel) => VENDOR_DIRS[name]?.find((dir) => rel.startsWith(`${dir}/`))

const manifestIdentity = (pkg) => ({ name: pkg.name, ...(isPackageString(pkg.version) ? { version: pkg.version } : {}) })

// `below`: whether any package.json under `vendorDir` covers the file at all.
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

export function namedManifestOf(rel, read) {
  for (let dir = posix.dirname(rel); dir !== '.'; dir = posix.dirname(dir)) {
    const pkg = read(dir)
    if (pkg?.name !== undefined) return { dir, pkg }
  }
  return undefined
}

// A nearer package.json than the package's own, which Node takes the file's `type` from and Metro its fields.
export function scopeManifestOf(rel, pkgDir, exists) {
  if (pkgDir !== '.' && !rel.startsWith(`${pkgDir}/`)) return undefined
  for (let dir = posix.dirname(rel); dir !== pkgDir && dir !== '.'; dir = posix.dirname(dir)) {
    if (exists(`${dir}/package.json`)) return `${dir}/package.json`
  }
  return undefined
}

// In node_modules a bucket's package.json needs name and version; outside, a name alone, as State#locateModule.
// A malformed one is walked past, or with `strict` throws (its files would otherwise land in the parent's).
export function findPackageMetadata(baseDir, fileRelPath, { strict = false, check, host = diskHost } = {}) {
  const options = { strict, check, host }
  const read = (rel) => readPackageJson(baseDir, rel, options)
  const nm = splitNodeModulesPath(toPosix(fileRelPath))
  // A file in a vendored package is its host's, as State#locateModule has it.
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
  // A file in a subpackage is its host's too: the nearest package.json with a name is walked past.
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

// Once per directory, the only thing findPackageMetadata's answer depends on.
export const packageLookup = (baseDir, options) => memoized((path) => findPackageMetadata(baseDir, path, options), (path) => posix.dirname(path))

function hostSubpackageDir(read, pkgDir, dir, manifestName) {
  if (!dir.startsWith(`${pkgDir}/`)) return undefined
  const sub = dir.slice(pkgDir.length + 1)
  if (typeof manifestName !== 'string' || !manifestName.endsWith(`/${sub}`)) return undefined
  return isSubpackage(manifestName, read(`${pkgDir}/package.json`)?.name, sub) ? sub : undefined
}

export const NO_ENTRY = new Set(['ENOENT', 'ENOTDIR'])

// A link is not followed, a broken one counted too (`host.readlink` throws when nothing is there).
export function lexists(p, host) {
  try {
    host.readlink(p)
    return true
  } catch (err) {
    if (NO_ENTRY.has(err.code)) return false
    throw err
  }
}

// host.stat answers null for any failure, as Node's module lookup does; this, only when nothing is there. Something
// there that can't be read (a link loop, an unsearchable directory, a too-long name) throws `fail(cause)`.
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

export const statStrict = (host, file, label) =>
  statOrFail(host, file, (cause) => new Error(`${label}: can't be read (${cause.code ?? cause.message})`, { cause }))

export const invalidPackageConfig = (path, cause) =>
  Object.assign(new Error(`Invalid package config ${path}.`, cause === undefined ? {} : { cause }), { code: 'ERR_INVALID_PACKAGE_CONFIG' })

export const packageJSONStat = (host, file) => statOrFail(host, file, (cause) =>
  Object.assign(new Error(`Cannot read package config ${file}: ${cause.code ?? cause.message}.`, { cause }), { code: 'ERR_INVALID_PACKAGE_CONFIG' }))

// A FIFO, a socket, a device or a link to one (`/dev/stdin`) throws rather than stalling or reading the process's input.
export function readRegularFileOrNull(file, label, host = diskHost) {
  const stat = statStrict(host, file, label)
  if (stat === null || stat.isDirectory()) return null
  if (!stat.isFile()) throw new Error(`${label}: not a regular file`)
  return host.readFile(file)
}

// Parsed past a BOM, as npm and Node; null when there's none or it can't be read, isn't a regular file or doesn't
// parse -- unless `strict`: then only nothing there is null. `check(rel)` sees the path before it is read.
export function readPackageJson(baseDir, rel, { strict = false, check, host = diskHost } = {}) {
  const file = join(baseDir, rel)
  const stat = strict ? statStrict(host, file, rel) : host.stat(file)
  if (stat === null || stat.isDirectory()) return null
  check?.(rel)
  try {
    if (!stat.isFile()) throw new Error(`${rel}: not a regular file`)
    const bytes = host.readFile(file)
    // Lenient lookups decode it as they always have (a stray byte as U+FFFD).
    if (strict && !isUtf8(bytes)) throw new Error(`${rel}: not valid UTF-8`)
    return parseJson(packageJSONText(bytes), rel)
  } catch (err) {
    if (strict) throw err
    return null
  }
}

// Never the parser's message, which quotes the text (a file that isn't JSON may be anything, a secret included).
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

// One that can't be read or isn't UTF-8 aborts, never silently skipped.
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

// Userinfo holds only what RFC 3986 allows: a `?` or `\` ending the authority early isn't GitHub's
// (`https://evil.example?@github.com/a/b`). scp-like `git@github.com:o/n` is taken behind `ssh://` too.
export function parseGithubRepository(url) {
  if (typeof url !== 'string') return null
  const match = /^(?:github:|(?:git\+)?(?:(?:https?|ssh|git):\/\/(?:[\w.~%!$&'()*+,;=:-]*@)?(?:www\.)?github\.com(?::\d+)?\/|ssh:\/\/(?:[\w.~%!$&'()*+,;=-]*@)?(?:www\.)?github\.com:|(?:[^@/:]+@)?(?:www\.)?github\.com:))?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/iu.exec(url.trim().replace(/#.*$/su, ''))
  const github = match && `${match[1]}/${match[2]}`
  return github && isValidRepoField('github', github) ? github : null
}

// A literal match of git's own `.git/config` layout, no parsing.
const GIT_ORIGIN_URL = '[remote "origin"]\n\turl = '
export function gitOriginUrl(text) {
  const at = text?.indexOf(GIT_ORIGIN_URL) ?? -1
  if (at === -1) return null
  return text.slice(at + GIT_ORIGIN_URL.length).split('\n', 1)[0].trim() || null
}

// Read through `host` (never the --fs-patched fs), it is never captured.
export const readText = (host, file) => {
  try {
    return host.readFile(file).toString('utf8')
  } catch {
    return null
  }
}

// The branch is taken as one segment: one holding a `/` reads as part of the dir.
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

const isRootPath = (path) => path.replaceAll('\\', '/').split('/').every((part) => part === '' || part === '.')

// `{}` where none is declared (unknown, not the root) or `base` has a `..` part (`a/..` is no claim on the root).
// Its `\` is a separator: Windows users write it so, and it is metadata, not a name on disk.
const declaredLocation = (base, rel) => {
  if (typeof base !== 'string') return {}
  const path = base.replaceAll('\\', '/')
  if (path.split('/').includes('..')) return {}
  const directory = posix.join(path, rel).replace(/^\/+|\/+$/gu, '')
  return repoLocation(directory === '.' ? '' : directory)
}

function gitDirs(dotGit, host) {
  const pointer = readText(host, dotGit) // null for a `.git` directory (EISDIR)
  const gitDir = pointer?.startsWith('gitdir: ') ? resolve(dirname(dotGit), pointer.slice('gitdir: '.length).trim()) : dotGit
  const common = readText(host, join(gitDir, 'commondir'))?.trim()
  return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir }
}

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

// Read through `host`, under `.git` alone; git never runs.
export function checkoutCommit(dir, host = diskHost) {
  const dotGit = join(dir, '.git')
  return host.stat(dotGit) === null ? undefined : gitHeadCommit(gitDirs(dotGit, host), host)
}

function repositoryUrl(json) {
  const repository = json?.repository
  const url = typeof repository === 'string' ? repository : repository?.url
  return typeof url === 'string' ? url : undefined
}

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

// lerna writes `gitHead` into package.json too (npm publish only into the registry's document), and npm keeps it.
export function packageRepo(json) {
  const repo = declaredRepo(json, '')
  return repo !== undefined && isValidRepoField('commit', json.gitHead) ? { ...repo, commit: json.gitHead } : repo
}

// Its commit is git's HEAD alone, never a package.json's `gitHead`: a project's own files likely changed since.
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
