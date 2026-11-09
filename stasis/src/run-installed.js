import { pinInstalled } from './installed.js'

// stasis-core's State's reader of what the install names of each npm package (its INSTALLED hook),
// as a build reads it (pinInstalled): the package manager's record of it, held to the lockfile beside
// it. `stasis run` preloads this before stasis-core's loader, out of what the run captures.
globalThis[Symbol.for('@exodus/stasis-core/installed')] = (modules, root) => {
  const probe = { modules: new Map() }
  for (const [dir, info] of modules) {
    if (info.ecosystem === 'npm') probe.modules.set(dir, { ...info, integrity: undefined, patch: undefined })
  }
  pinInstalled(probe, root)
  const installed = new Map()
  for (const [dir, { integrity, patch }] of probe.modules) {
    if (integrity !== undefined || patch !== undefined) installed.set(dir, { integrity, patch })
  }
  return installed
}
