// TEAL loader: `{ sources, resolutions }` of a set of Algorand TEAL (.teal) programs. A TEAL program
// is the one file: the assembler's only directives are `#pragma` and `#define` (a macro of the file
// itself), it reads no other file, and what a program reaches of another (an app it calls, a
// contract it deploys, a logic signature's address) it reaches at run time, by ID, compiled bytes or
// address, never by a path. So there is no graph to walk: a TEAL bundle carries its entries, each
// read as written, with no edges.

import { isUtf8 } from 'node:buffer'
import { join } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { assertRealPathWithinBase } from '@exodus/stasis-core/util'

// Each of `entries` (baseDir-relative POSIX paths) that is a regular file under `baseDir` (its real
// path too), its text, as Map<path, text>, read through `host`. One that isn't there, or is no regular
// file (a directory named `x.teal`; a FIFO would hang a read), is warned about and left out, for the
// caller to refuse as a missing entry; one that isn't UTF-8 is refused rather than carried with
// U+FFFD in it.
export function collectTealFilesFromDisk(baseDir, entries, { host = diskHost } = {}) {
  const realBase = host.realpath(baseDir)
  const sources = new Map()
  for (const rel of entries) {
    if (sources.has(rel)) continue
    const abs = join(baseDir, rel)
    const stats = host.stat(abs)
    if (stats === null) {
      console.warn(`[loader.teal] Missing file: ${rel}`)
      continue
    }
    assertRealPathWithinBase(realBase, baseDir, rel, host)
    if (!stats.isFile()) {
      console.warn(`[loader.teal] Not a regular file: ${rel}`)
      continue
    }
    const bytes = host.readFile(abs)
    if (!isUtf8(bytes)) throw new Error(`TEAL program is not valid UTF-8: ${rel}`)
    sources.set(rel, bytes.toString('utf8'))
  }
  return sources
}

// The resolutions of `sources`: each program's, with no edge (TEAL has no imports).
export const buildTealTree = (sources) => ({ sources, resolutions: new Map([...sources.keys()].map((path) => [path, new Map()])) })
