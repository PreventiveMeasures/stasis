import { INSTALLED } from '@exodus/stasis-core/util'
import { installedRecords } from './installed.js'

// stasis-core's State's reader of how the packages were installed (INSTALLED), as a build reads it
// (installedRecords), what it read kept across a run's calls. `stasis run` preloads it before the loader.
const cache = { stores: new Map(), layouts: new Map() }
globalThis[INSTALLED] = (modules, root) => {
  const accounts = installedRecords(modules, root, undefined, cache)
  for (const [dir, { repo: _repo, ...account }] of accounts) accounts.set(dir, account)
  return accounts
}
