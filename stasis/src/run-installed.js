import { installedMetadata, installedRecords } from './installed.js'

// stasis-core's State's reader of the install records (its INSTALLED hook), as a build reads them
// (installedRecords). `stasis run` preloads it before stasis-core's loader.
globalThis[Symbol.for('@exodus/stasis-core/installed')] = (modules, root) => {
  const installed = new Map()
  for (const [dir, record] of installedRecords(modules, root)) {
    const { integrity, patch } = installedMetadata(dir, modules.get(dir).ecosystem, record)
    if (integrity !== undefined || patch !== undefined) installed.set(dir, { integrity, patch })
  }
  return installed
}
