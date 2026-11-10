import { posix } from 'node:path'

import { Vfs } from '@preventive/vfs'
import { configuredLockfiles, installsDevDependencies } from './cmd/bundle.js'
import { checkAhead, defaultEntries } from './vfs-bundle/entries.js'
import { suggestedRepoEntries } from './vfs-bundle/github.js'
import { NODE_MODULES_MANAGERS, checkCache, checkTarget, checkVfs, detectPackageManager, loadTree, lockfilesManagers, packageManagerFor, vfsHost } from './vfs-bundle/tree.js'

// @exodus/stasis/vfs-bundle: static bundles of a project held in a Vfs, which is only read, from its lockfile alone,
// through the tree its package manager would install (@preventive/deptree). Nothing touches disk but the tarballs and
// zips, each held to the lockfile's integrity, and cached only where setCacheDir says.

export { buildVfsBundle } from './cmd/bundle.js'
export { buildGitHubBundle } from './vfs-bundle/github.js'
export { setCacheDir } from '@preventive/deptree/pnpm.js'
export { Vfs }

// A `host` (@exodus/stasis-core/host) over `vfs` alone, its `/` the filesystem's, reading it as it is
// at each call.
export function createVfsHost(vfs) {
  checkVfs('createVfsHost', vfs)
  return vfsHost(vfs, { cache: false })
}

// -> { root, vfs, projects, host, stats, installed, packageManager, packageManagerVersion }: node_modules as 'pnpm',
// 'yarn1' or 'npm' installs it (the one whose lockfile installs cwd, where none is given) for the machine `os`, `cpu`
// and `libc` name, cleaned by each .yarnclean. The host caches what it reads, so neither Vfs is to change meanwhile.
export async function loadNodeModules({ vfs, packageManager, cwd = '/', packageManagerVersion, os, cpu, libc, cache } = {}) {
  const name = 'loadNodeModules'
  checkVfs(name, vfs)
  checkTarget(name, { os, cpu, libc })
  checkCache(name, cache)
  const project = vfsHost(vfs)
  // A real path, as detection and the layout take it.
  cwd = project.realpath(posix.resolve('/', cwd))
  packageManager = packageManagerFor(name, project, cwd, { packageManager, packageManagerVersion, os }, NODE_MODULES_MANAGERS)
  const installDevDependencies = installsDevDependencies(name, cwd, project)
  return loadTree({ project, packageManager, cwd, packageManagerVersion, os, cpu, libc, cache, installDevDependencies })
}

// -> the entries buildGitHubBundle takes where none are given (defaultEntries), as paths from the project's directory,
// the options checked as the build checks them: of the project held in `vfs`, from `cwd`; or of a GitHub repo
// (`{ github, sha, tag, directory | path, client }`), downloaded as buildGitHubBundle downloads it.
export async function suggestedEntries({ vfs, cwd = '/', packageManager, conditions, mainFields, metro, platforms, jsx, typescript, os, ...repo } = {}) {
  const name = 'suggestedEntries'
  checkTarget(name, { os })
  const resolution = { conditions, mainFields, metro, platforms, jsx, typescript }
  if (vfs === undefined && repo.github === undefined) throw new Error(`${name}: a vfs or a github repo is required`)
  if (vfs !== undefined && repo.github !== undefined) throw new Error(`${name}: takes a vfs or a github repo, not both`)
  if (vfs === undefined) return suggestedRepoEntries({ ...repo, packageManager }, { ...resolution, os })
  checkVfs(name, vfs)
  const host = vfsHost(vfs)
  const at = posix.resolve('/', cwd)
  // As the build lays them out: a tree of each lockfile stasis.config.json names, none detected.
  const lockfiles = packageManager === undefined ? configuredLockfiles(name, at, host) : undefined
  const one = lockfiles === undefined ? packageManager ?? detectPackageManager(name, host, at, { os }) : undefined
  checkAhead(name, one, resolution)
  return defaultEntries(name, host, at, lockfiles === undefined ? [one] : lockfilesManagers(name, lockfiles), resolution).entries
}
