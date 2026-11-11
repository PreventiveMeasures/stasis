import { posix } from 'node:path'

import { Vfs } from '@preventive/vfs'
import { configuredLockfiles, installsDevDependencies } from './cmd/bundle.js'
import { checkAhead, defaultEntries } from './vfs-bundle/entries.js'
import { suggestedRepoEntries } from './vfs-bundle/github.js'
import { NODE_MODULES_MANAGERS, checkCache, checkTarget, checkVfs, detectPackageManager, loadTree, lockfilesManagers, packageManagerFor, vfsHost } from './vfs-bundle/tree.js'

// Static bundles of a project held in a Vfs, from its lockfile alone: nothing touches disk but the tarballs and zips,
// each held to the lockfile's integrity, and cached only where setCacheDir says.

export { buildVfsBundle } from './cmd/bundle.js'
export { buildGitHubBundle } from './vfs-bundle/github.js'
export { setCacheDir } from '@preventive/deptree/pnpm.js'
export { Vfs }

// Reading `vfs` as it is at each call.
export function createVfsHost(vfs) {
  checkVfs('createVfsHost', vfs)
  return vfsHost(vfs, { cache: false })
}

// node_modules as the package manager installs it for the machine `os`, `cpu` and `libc` name. The host caches what it
// reads, so neither Vfs is to change meanwhile.
export async function loadNodeModules({ vfs, packageManager, cwd = '/', packageManagerVersion, os, cpu, libc, cache } = {}) {
  const name = 'loadNodeModules'
  checkVfs(name, vfs)
  checkTarget(name, { os, cpu, libc })
  checkCache(name, cache)
  const project = vfsHost(vfs)
  cwd = project.realpath(posix.resolve('/', cwd))
  packageManager = packageManagerFor(name, project, cwd, { packageManager, packageManagerVersion, os }, NODE_MODULES_MANAGERS)
  const installDevDependencies = installsDevDependencies(name, cwd, project)
  return loadTree({ project, packageManager, cwd, packageManagerVersion, os, cpu, libc, cache, installDevDependencies })
}

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
