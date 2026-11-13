import { INSTALLED } from '@exodus/stasis-core/util'
import { installedRecords } from './installed.js'

// `stasis run` preloads this before the loader; what it reads is kept across a run's calls.
const cache = { stores: new Map(), layouts: new Map() }
globalThis[INSTALLED] = (modules, root, { locate } = {}) => {
  const accounts = installedRecords(modules, root, undefined, { ...cache, locate })
  for (const [dir, { repo: _repo, ...account }] of accounts) accounts.set(dir, account)
  return accounts
}
