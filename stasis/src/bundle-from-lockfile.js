import { isUtf8 } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { Bundle } from '@exodus/stasis-core/bundle'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { moduleFileKey, moduleInfo, narrowExecutable } from '@exodus/stasis-core/util'

// An in-memory Bundle of a lockfile, each attested file read from disk under `root` and held to its SRI digest,
// as a `stasis run --lock=frozen` replay holds it. Directory captures (format 'directory') are no files to load.
export function bundleFromLockfile(lockfile, { root }) {
  if (!lockfile.imports) throw new Error('stasis: lockfile has no recorded import graph')
  const formats = lockfile.formats ?? new Map()
  const modules = new Map()
  for (const [dir, { files, ...info }] of lockfile.modules) {
    const out = Object.create(null)
    for (const [rel, integrity] of Object.entries(files)) {
      const file = moduleFileKey(dir, rel)
      const format = formats.get(file)
      if (format === 'directory') continue
      let bytes
      try {
        bytes = readFileSync(resolve(root, file))
      } catch (cause) {
        throw new Error(`stasis: file attested by the lockfile is missing on disk: ${file}`, { cause })
      }
      const actual = sha512integrity(bytes)
      if (actual !== integrity) {
        throw new Error(`stasis: ${file} does not match the lockfile (expected ${integrity}, got ${actual})`)
      }
      // As a Bundle holds it: 'resource:base64' as base64, else UTF-8, refused where it isn't, as a lossy
      // transcode (U+FFFD) would serve other bytes than those verified.
      const base64 = format === 'resource:base64'
      if (!base64 && !isUtf8(bytes)) throw new Error(`stasis: ${file} is recorded as '${format ?? 'code'}' but is not valid UTF-8`)
      out[rel] = bytes.toString(base64 ? 'base64' : 'utf8')
    }
    modules.set(dir, moduleInfo({ ...info, files: out }))
  }
  return new Bundle({
    config: lockfile.config,
    entries: lockfile.entries,
    modules,
    imports: lockfile.imports,
    formats,
    // Narrowed to the files this bundle ended up carrying (a skipped `directory` capture drops out),
    // keeping Bundle.parse's rules true for a hand-built lockfile too.
    executable: narrowExecutable(lockfile.executable, { modules, formats, scope: lockfile.config.scope }),
  })
}
