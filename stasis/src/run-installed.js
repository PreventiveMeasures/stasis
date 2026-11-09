import { installedRecords } from './installed.js'

// stasis-core's State's reader of how the packages were installed (its INSTALLED hook), as a build
// reads it (installedRecords). `stasis run` preloads it before stasis-core's loader.
globalThis[Symbol.for('@exodus/stasis-core/installed')] = (modules, root) => installedRecords(modules, root).accounts
