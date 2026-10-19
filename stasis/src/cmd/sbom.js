import { resolve } from 'node:path'

import { parseFile } from '../parse.js'
import { collectComponents, generateSbom } from '../sbom.js'
import { writeOutput } from './output.js'

// The one-line summary goes to stderr so it never corrupts an SBOM streamed to stdout.
export function sbomCommand({ cwd = process.cwd(), files, format, output, now, uuid } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('sbom: at least one lockfile or bundle is required')
  }
  const artifacts = files.map((f) => parseFile(resolve(cwd, f)))
  const components = collectComponents(artifacts)
  const doc = generateSbom(format, components, { now, uuid })
  const text = JSON.stringify(doc, undefined, 2) + '\n'

  const dest = writeOutput(cwd, output ?? '-', text)
  const n = components.length
  const vendored = components.reduce((sum, c) => sum + (c.vendored?.length ?? 0), 0)
  const inThem = vendored === 0 ? '' : ` (and ${vendored} vendored in them)`
  console.warn(`[stasis] Wrote ${format} SBOM with ${n} component${n === 1 ? '' : 's'}${inThem} to ${dest}`)
  return { components, doc }
}
