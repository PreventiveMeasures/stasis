import type { Buffer } from 'node:buffer'

/** What a host's `stat` answers: fs.Stats, or a virtual host's own. */
export interface HostStat {
  isFile(): boolean
  isDirectory(): boolean
}

/**
 * The filesystem these read through: diskHost (`@exodus/stasis-core/host`) or a host shaped like
 * it. Each function takes only the members it calls.
 */
export interface Host<Stat extends HostStat = HostStat> {
  /** Following links; null for anything that can't be stat'ed. */
  stat(path: string): Stat | null
  /** Throws, with the error's `code`, where it can't be read. */
  readFile(path: string): Buffer
  realpath(path: string): string
  /** The nearest package.json at or above `path`. */
  findPackageJSON(path: string): string | undefined
}

/**
 * A `repo`, the bundle's own or a dependency's: GitHub `owner/name`, the directory in it (`''` its
 * root; absent where unknown) and the commit (absent where unknown).
 */
export interface Repo {
  github: string
  directory?: string
  commit?: string
}

/** The `repo` a package.json's `repository` names, which never names a commit. */
export type PackageRepo = Omit<Repo, 'commit'>

export interface PackageMetadata {
  /** Relative to `baseDir`, as `dirname` spells it (`.` at the root). */
  pkgDir: string
  /**
   * The package.json's own values, unchecked: `name` is truthy; `version` is truthy inside
   * node_modules, and elsewhere may be undefined (absent or null).
   */
  name: unknown
  version: unknown
  /** Inside node_modules only. */
  ecosystem?: 'npm'
  /** Inside node_modules only, where its `repository` names a GitHub one (packageRepo). */
  repo?: PackageRepo
}

export interface ReadPackageJsonOptions {
  /** Throw where a package.json is there but can't be read or parsed, rather than taking it for none. */
  strict?: boolean
  /** Sees a package.json's path (relative to `baseDir`) before it's read; throws to refuse it. */
  check?: (rel: string) => void
  host?: Pick<Host, 'stat' | 'readFile'>
}

export interface ReadModuleManifestOptions {
  baseDir: string
  /** `baseDir`'s real path, which `rel`'s must stay within. */
  realBase: string
  rel: string
  host?: Pick<Host, 'stat' | 'readFile' | 'realpath'>
}

/** The error codes that mean nothing is at a path. */
export const NO_ENTRY: ReadonlySet<string>

/** Text as Node reads a package.json: UTF-8, past a byte order mark. */
export function packageJSONText(bytes: ArrayBuffer | ArrayBufferView): string

/** The nearest package.json's `type`, where it's `module` or `commonjs`; else null. */
export function packageType(file: string, host?: Pick<Host, 'findPackageJSON' | 'readFile'>): 'module' | 'commonjs' | null

/**
 * Nearest package.json (walking up from `fileRelPath`, relative to `baseDir`) that identifies a
 * bucket, or null.
 */
export function findPackageMetadata(baseDir: string, fileRelPath: string, options?: ReadPackageJsonOptions): PackageMetadata | null

/**
 * host.stat, null only when nothing is there; anything else that can't be stat'ed throws, naming
 * it `label`.
 */
export function statStrict<Stat extends HostStat>(host: Pick<Host<Stat>, 'stat' | 'readFile'>, file: string, label: string): Stat | null

/**
 * host.stat for a package.json: null when nothing is there; one that can't be read throws
 * ERR_INVALID_PACKAGE_CONFIG.
 */
export function packageJSONStat<Stat extends HostStat>(host: Pick<Host<Stat>, 'stat' | 'readFile'>, file: string): Stat | null

/**
 * `file`'s bytes, or null when there's none (a directory counts as none); one that isn't a regular
 * file or can't be read throws, naming it `label`.
 */
export function readRegularFileOrNull(file: string, label: string, host?: Pick<Host, 'stat' | 'readFile'>): Buffer | null

/**
 * The package.json at `rel` (under `baseDir`), parsed but unchecked; null where there's none or,
 * unless `strict`, where it can't be read or parsed.
 */
export function readPackageJson(baseDir: string, rel: string, options?: ReadPackageJsonOptions): unknown

/** Entries as paths relative to `cwd`, POSIX-separated; one outside `cwd` throws. */
export function normalizeEntries(entries: readonly string[], cwd: string): string[]

/**
 * Bytes of a bundled module's package.json, or null when it's absent; one that can't be read, isn't
 * UTF-8 or whose real path leaves `realBase` throws.
 */
export function readModuleManifest(options: ReadModuleManifestOptions): Buffer | null

/** `file` parsed, unchecked. Never throws: a missing, unreadable or malformed file yields null. */
export function readJson(file: string, host?: Pick<Host, 'readFile'>): unknown

/** `owner/name` from a package.json `repository` (GitHub URL or shorthand), else null. */
export function parseGithubRepository(url: unknown): string | null

/** Best-effort `origin` url from a `.git/config`'s text, else null. */
export function gitOriginUrl(text: string | null | undefined): string | null

/** The text of `file`, or null. */
export function readText(host: Pick<Host, 'readFile'>, file: string): string | null

/** Dir of a `https://github.com/<github>/tree/<branch>/<dir>` homepage (one-segment branch). */
export function githubHomepageDirectory(homepage: unknown, github: string): string | undefined

/**
 * The `repo` a parsed package.json's `repository` names for `rel`, a directory below it (`''` for
 * its own); undefined where it names no GitHub repository.
 */
export function packageRepo(json: unknown, rel?: string): PackageRepo | undefined

/**
 * Bundle `repo` for `dir`: git origin/HEAD at the work tree root, else the nearest package.json
 * `repository` (packageRepo); undefined where neither names a GitHub repository.
 */
export function detectRepo(dir: string, host?: Pick<Host, 'stat' | 'readFile'>): Repo | undefined
