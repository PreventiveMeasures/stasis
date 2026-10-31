// What a validation's report (validate.js's) tells, in words: why own code, a package or a file
// wasn't checked or is as it is, why no lockfile was held to, and a package's note beside its status.
// Of no module, for a browser too (`@exodus/stasis/validate-notes`), as printValidationReport tells it.

// Why own code wasn't checked, by `own.reason`.
export const OWN_REASONS = {
  skipped: 'skipped (--only-deps): its dependencies alone validated',
  'no-repository': 'no repository to read it of',
  'no-commit': 'no commit to read it at',
  'commit-not-in-history': 'its commit is in the history of no branch or tag of its repository (a fork\'s, say)',
  'history-unread': 'its commit is at no tag or branch head, nor in its default branch\'s history, and not every other branch was compared',
}

// A package's reason, unverified (the first) or failing its lockfile (the last four).
export const PACKAGE_REASONS = {
  local: 'installed from a directory of the repository, which isn\'t read',
  'patch-unverified': 'as patched by the bundle\'s patch, which isn\'t verified against the repository',
  git: 'locked from git, not a registry',
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
  'integrity-mismatch': 'its registry\'s tarball is not the one the lockfile locks',
  'integrity-conflict': 'locked with two integrities',
}

// Why a patch wasn't applied, told after `its patch` and its path.
export const PATCH_ERRORS = {
  'patch-not-in-repository': 'is the bundle\'s, not the repository\'s',
  'patch-not-found': 'is in no file of its hash (the bundle\'s, or the patches directory\'s)',
  'patch-mismatch': 'is not of the hash its lockfile locks',
}

// Why a file is as it is, by a problem's `reason`.
export const FILE_REASONS = { symlink: 'a symlink in the repository', submodule: 'in a submodule', 'tree-cut': 'the repository\'s tree was too large to list whole' }

// Why the dependencies were held to no lockfile, by a report's `lockfileError` (a ValidateError's code).
export const LOCKFILE_ERRORS = {
  'no-lockfile': 'no lockfile of its repository locks them',
  'lockfile-ambiguous': 'more than one package manager\'s lockfile installs it',
  'lockfile-unreadable': 'its lockfile couldn\'t be read',
  'lockfile-unsupported': 'its lockfile is of a kind validate doesn\'t read',
}

// What a report tells of a package beside its status, as parts: text, and the paths in it as `{ path }`,
// for a caller to set apart: why it is unverified or fails its lockfile, its patch, or the directory
// it is held to; none where nothing more.
export function noteOf(pkg) {
  const { patch } = pkg
  if (pkg.reason) return [PACKAGE_REASONS[pkg.reason] ?? pkg.reason, ...(pkg.at ? [': ', { path: pkg.at }] : [])]
  if (patch?.error) return ['its patch', ...(patch.path ? [' ', { path: patch.path }] : []), ` ${PATCH_ERRORS[patch.error] ?? `could not be applied (${patch.error})`}`]
  // A patch the bundle holds, as checked against the repository.
  const whose = patch?.from !== 'bundle' ? [] : [patch.verified ? ' (the bundle\'s, as the repository has it)' : ' (the bundle\'s, not verified against the repository)']
  if (patch) return [patch.applied === false ? 'locked patched, bundled as published' : 'patched', ...(patch.path ? [' by ', { path: patch.path }, ...whose] : [])]
  return pkg.directory ? ['held to ', { path: pkg.directory }, ' of the repository'] : []
}

// A package's note as text: '' where nothing more.
export const noteText = (pkg) => noteOf(pkg).map((part) => (typeof part === 'string' ? part : part.path)).join('')
