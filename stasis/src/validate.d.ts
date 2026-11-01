// Types of `@exodus/stasis/validate` (validate.js), whose comments tell what each does.
import type { Client, RepoDirEntry } from '@preventive/upstream/github.js'

export { HttpError } from '@preventive/upstream/npm.js'

export const MAX_TOLD: number
export const FETCHED: ReadonlySet<string>

export class PatchError extends Error {
  constructor(code: string)
  code: string
}

export type ValidateErrorCode = 'not-a-bundle' | 'no-repository' | 'no-commit' | 'commit-not-in-history' | 'history-unread'
  | 'no-lockfile' | 'lockfile-ambiguous' | 'lockfile-unsupported' | 'lockfile-unreadable'
export class ValidateError extends Error {
  constructor(code: ValidateErrorCode, message: string)
  code: ValidateErrorCode
}

// What validation checks of a bundle (validationPlan).
export interface PlanFile { path: string; dir: string; rel: string; format?: string; bytes(): Uint8Array }
export interface PlanPackage { ecosystem: string; name: string; version: string; files: PlanFile[] }
export interface ValidationPlan { files: number; own: PlanFile[]; packages: PlanPackage[]; patches: Map<string, string> }
// A parsed bundle (Bundle.parse's, or parseFileWithKind's artifact).
export interface PlannedBundle {
  modules: Map<string, { name?: string; version?: string; ecosystem?: string; files: Record<string, unknown> }>
  formats?: Map<string, string>
}
export function validationPlan(bundle: PlannedBundle): ValidationPlan

export function gitBlobId(bytes: Uint8Array): string
export function tarballFiles(tarball: Uint8Array): Promise<Map<string, Uint8Array | { symlink: string }>>

// A version's files by their paths; a crate's with its sha256 in hex.
export type PackageFiles = Map<string, Uint8Array> & { checksum?: string }
export type Fetch = (ecosystem: string, name: string, version: string, integrity?: string) => Promise<PackageFiles>
export const fetchPackage: Fetch
export function fetchFailure(error: unknown): 'not-published' | 'unreadable' | 'integrity-mismatch' | 'failed'

export interface PatchFile { path: string; from?: string; deleted?: true; created?: true; hunks: unknown[] }
export function isPatchOf(text: string, hash: string): boolean
export function parsePatch(patch: string): PatchFile[]
export function patchedFiles(files: Map<string, Uint8Array>, patch: PatchFile[]): Map<string, Uint8Array>

// A file of the repository: its bytes, git's blob id, a symlink, or in a submodule.
export type RepositoryEntry = { data: Uint8Array } | { sha: string } | { symlink: string } | { submodule: true }
export type Ref = { branch: string } | { tag: string }
interface Where { repository: string; movedFrom?: string; commit: string; ref?: Ref; directory: string }
// Own code as validateBundle takes it: read, or not and why.
export type OwnCode = (Where & { entries: Map<string, RepositoryEntry>; cut?: boolean })
  | (Partial<Where> & { reason: string; entries?: Map<string, RepositoryEntry> })

export interface Lock { from: 'registry' | 'git' | 'elsewhere' | 'local'; integrity?: string; conflict?: true; directories?: string[] }
export interface Lockfile {
  path: string
  text: string
  from?: 'repository' | 'local'
  read?: (path: string) => string | Promise<string>
  tree?: (dir: string) => Promise<Map<string, Uint8Array>>
  patches?: string[]
  root?: string
}
// A patch pnpm's lockfile names for a version: by its path, or by its hash alone, in a file of one of
// `names` in a patches directory (locate).
export type LockedPatch = { hash: string; path: string } | { hash: string; names: string[] }
export interface Locked {
  lockfiles: string[]
  locks(ecosystem: string): boolean
  lock(ecosystem: string, name: string, version: string): Lock | null | undefined
  of(name: string, version: string): LockedPatch | null | undefined
  locate(patch: { hash: string; names?: string[] }): Promise<{ path: string; text: string } | null>
  installed(dir: string): string | null | undefined
  aliased(as: string, named: string): boolean | undefined
  from?: 'repository' | 'local'
  tree?: (dir: string) => Promise<Map<string, Uint8Array>>
  read(path: string): Promise<string>
}
export function lockedBy(lockfiles: Lockfile[]): Locked

export interface Problem { path: string; kind: 'differs' | 'unexpected' | 'unverified'; of: string; reason?: string }
export interface PackageReport {
  ecosystem: string
  name: string
  version: string
  files: number
  status: 'valid' | 'invalid' | 'unverified'
  reason?: string
  at?: string
  directory?: string
  patch?: { hash?: string; path?: string; from?: 'repository' | 'local' | 'bundle'; error?: string; applied?: boolean }
}
export interface BundleValidation {
  validatedAt: number
  status: 'valid' | 'invalid' | 'incomplete'
  own: (Where & { checked: true; cut?: true }) | { checked: false; reason: string; patches?: number }
  lockfiles: string[] | null
  counts: Record<'files' | 'own' | 'dependencies' | 'matched' | 'eol' | 'differs' | 'unexpected' | 'unverified' | 'skipped' | 'packages' | 'validPackages' | 'lockFailures' | 'misplaced', number>
  problems: Problem[]
  moreProblems: number
  packages: PackageReport[]
  // validateRepository's, `strict` false: why no lockfile was held to.
  lockfileError?: ValidateErrorCode
}

export function validateBundle(plan: ValidationPlan, own: OwnCode | Promise<OwnCode>,
  options?: { fetch?: Fetch; locked?: Locked | null; deadline?: number; now?: () => number }): Promise<BundleValidation>
export function exitCodeOf(report: BundleValidation, options?: { allowUnverified?: boolean }): 0 | 1 | 2

type Read = 'getRepoTreeId' | 'getRepoTreeTarball' | 'listRepoDir' | 'getRepoFile' | 'getRepoHead' | 'listRepoTags' | 'listRepoBranches' | 'compareCommits'
// The reads of upstream's client followingMoves wraps, and getRepo, which it follows a move by.
type Reads = Pick<Client, Read | 'getRepo'>
// A repository's reads (followingMoves's), where it has moved too.
export type Repository = { name(): string } & { [M in Read]: (options: Omit<Parameters<Client[M]>[0], 'repo'>) => ReturnType<Client[M]> }
export function followingMoves(client: Reads, github: string): Repository
export function historyOf(repository: Repository, commit: string, options?: { maxCompared?: number; deadline?: number; now?: () => number }): Promise<Ref | null>

export function repositoryFiles(repository: Repository, where: { github?: string; commit: string; directory?: string }): Promise<Map<string, RepositoryEntry>>
export function repositoryLockfiles(options: { directory?: string; ecosystems: Set<string>; list: (dir: string) => Promise<string[]>; read: (path: string) => Promise<string> })
  : Promise<{ path: string; text: string }[]>

interface Options { own?: boolean; fetch?: Fetch; deadline?: number }
export function validateRepository(plan: ValidationPlan, where: { repository?: Repository | null; commit?: string; directory?: string }, options?: Options & {
  lockfile?: boolean | Lockfile[]
  // A listing of the commit's tree, as upstream's listRepoTree gives it, for these paths.
  listTree?: (paths: string[]) => Promise<{ entries: RepoDirEntry[]; cut?: boolean }>
  strict?: boolean
}): Promise<BundleValidation>
export function validate(file: string, options?: Options & { client?: Reads; github?: string; sha?: string; directory?: string; lockfile?: boolean | string[] }): Promise<BundleValidation>

type Stream = { write(chunk: string): unknown }
export function printValidationReport(report: BundleValidation, options?: { out?: Stream; err?: Stream; showValid?: boolean; colors?: boolean }): void
