// A validation report in words, as printValidationReport tells it. Of no module, for a browser too.
export const OWN_REASONS = {
  skipped: 'skipped (--only-deps): its dependencies alone validated',
  'no-repository': 'no repository to read it of',
  'no-commit': 'no commit to read it at',
  'commit-not-in-history': 'its commit is in the history of no branch or tag of its repository (a fork\'s, say)',
  'history-unread': 'its commit is at no tag or branch head, nor in its default branch\'s history, and not every other branch was compared',
}

// A package's reason: unverified, or, from `misplaced` on, failing its lockfile or what it records.
export const PACKAGE_REASONS = {
  local: 'installed from a directory of the repository, which isn\'t read',
  'patch-unverified': 'as patched by the bundle\'s patch, which isn\'t verified against the repository',
  git: 'locked from git, not a registry',
  'not-a-submodule': 'no submodule of its repository\'s tree at its path',
  'git-built': 'locked from git: of the files its repository hasn\'t at the commit, which its install may build, none verified',
  'not-registry': 'locked from elsewhere than its registry',
  'no-integrity': 'locked with no sha512 to hold its tarball to',
  unsupported: 'no upstream package for its ecosystem',
  unnamed: 'no name or version recorded',
  'not-published': 'not published',
  unreadable: 'its registry refused it',
  timeout: 'not reached in time',
  failed: 'could not be fetched',
  'alias-unverified': 'installed under another name, an alias no lockfile read tells of',
  misplaced: 'installed where its path or its lockfile names another package or version',
  'not-locked': 'not locked by the lockfile',
  'integrity-mismatch': 'its registry\'s tarball is not the one it is locked or recorded with',
  'integrity-conflict': 'locked or recorded with two integrities',
  'integrity-not-locked': 'records an integrity its lockfile doesn\'t lock it with',
  'commit-not-locked': 'records another commit than its repository\'s tree pins it at',
  'patch-not-locked': 'records a patch its lockfile doesn\'t patch it with',
  'patch-not-recorded': 'records an integrity and no patch, where its lockfile patches it',
  'patch-conflict': 'its copies record different patches, or one of them none, where pnpm patches every copy with one',
  'patch-file-mismatch': 'records its patch in another file than the one it is found in',
}

// Why a patch wasn't applied, told after `its patch` and its path.
export const PATCH_ERRORS = {
  'patch-not-in-repository': 'is the bundle\'s, not the repository\'s',
  'patch-not-found': 'is in no file of its hash (the bundle\'s, or the patches directory\'s)',
  'patch-mismatch': 'is not of the hash its lockfile locks',
}

export const FILE_REASONS = {
  symlink: 'a symlink in the repository',
  submodule: 'in a submodule',
  'tree-cut': 'the repository\'s tree was too large to list whole',
  generated: 'not as the repository\'s Prisma schema generates it',
  'not-generated': 'in a Prisma Client\'s output, which generates no such file',
  listed: 'the repository\'s tree was listed, not read, and a lockfile records its integrity alone',
}

export const generatedBy = (client) => `${client.schema}'s ${client.generator} (Prisma ${client.prisma})`

export const LOCKFILE_ERRORS = {
  'no-lockfile': 'no lockfile of its repository locks them',
  'lockfile-ambiguous': 'more than one package manager\'s lockfile installs it',
  'lockfile-unreadable': 'its lockfile couldn\'t be read',
  'lockfile-unsupported': 'its lockfile is of a kind validate doesn\'t read',
}

// The paths in it as `{ path }`, for a caller to set apart.
export function noteOf(pkg) {
  const { patch } = pkg
  if (pkg.reason) return [PACKAGE_REASONS[pkg.reason] ?? pkg.reason, ...(pkg.at ? [': ', { path: pkg.at }] : [])]
  if (patch?.error) return ['its patch', ...(patch.path ? [' ', { path: patch.path }] : []), ` ${PATCH_ERRORS[patch.error] ?? `could not be applied (${patch.error})`}`]
  if (!patch) return pkg.directory ? ['held to ', { path: pkg.directory }, ' of the repository'] : []
  const whose = patch.from !== 'bundle' ? [] : [patch.verified ? ' (the bundle\'s, as the repository has it)' : ' (the bundle\'s, not verified against the repository)']
  return [patch.applied === false ? 'bundled as published, not patched' : 'patched', ...(patch.path ? [' by ', { path: patch.path }, ...whose] : []), ...(patch.recorded ? [', as recorded'] : [])]
}

export const noteText = (pkg) => noteOf(pkg).map((part) => (typeof part === 'string' ? part : part.path)).join('')
