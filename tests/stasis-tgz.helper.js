import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { lockfileFromBundle } from '@exodus/stasis-core/extract'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { moduleFileKey } from '@exodus/stasis-core/util'
import { pack } from '@preventive/archive/tar.js'

const bytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : data)

// A .stasis.tgz's bytes, as `tar -czf` packs `files` (path -> text or bytes), or archive's entries (with a mode, a type).
export const tgzOf = (files) => gzipSync(pack(Array.isArray(files) ? files : Object.entries(files).map(([name, data]) => ({ name, data: bytes(data) }))))

// Of a bundle's code files and the lockfile of them, `files` (path -> text or bytes) in place of its own.
export const tgzOfBundle = (bundle, files = {}) => tgzOf({ 'stasis.lock.json': lockfileFromBundle(bundle).serialize(), ...Object.fromEntries(bundle.sources), ...files })

// Of a directory's stasis.lock.json and the files it attests, `files` in place of its own.
export function tgzOfDir(dir, files = {}) {
  const lockfile = readFileSync(join(dir, 'stasis.lock.json'))
  const attested = [...Lockfile.parse(lockfile.toString('utf8')).modules].flatMap(([module, info]) => Object.keys(info.files).map((rel) => moduleFileKey(module, rel)))
  return tgzOf({ 'stasis.lock.json': lockfile, ...Object.fromEntries(attested.map((path) => [path, readFileSync(join(dir, path))])), ...files })
}
