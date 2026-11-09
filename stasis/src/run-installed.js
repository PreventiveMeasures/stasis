import { accountOf, installedRecords } from './installed.js'

// stasis-core's State's reader of how the packages were installed (its INSTALLED hook), as a build
// reads it (installedRecords): each module's account (accountOf), `{ integrity, patch, installed }`,
// for every module one is found of. `stasis run` preloads it before stasis-core's loader.
globalThis[Symbol.for('@exodus/stasis-core/installed')] = (modules, root) => {
  const accounts = new Map()
  for (const [dir, found] of installedRecords(modules, root)) {
    const account = accountOf(dir, modules.get(dir).ecosystem, found)
    if (account !== undefined) accounts.set(dir, account)
  }
  return accounts
}
