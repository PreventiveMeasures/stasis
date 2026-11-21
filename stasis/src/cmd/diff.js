import { resolve } from 'node:path'

import { sha512integrity } from '@exodus/stasis-core/state-util'
import { parseArtifactFile } from '../parse.js'
import { diffArtifacts, formatDiffStat, hasDifferences } from '../diff.js'

// Run `stasis diff`. -> { diff, differences } for the caller's exit code
export async function diffCommand({ cwd = process.cwd(), left, right, stat, imports = false, out = process.stdout } = {}) {
  if (!left || !right) throw new Error('diff: two files (lockfile, bundle or .stasis.tgz) are required')
  if (!stat) throw new Error('diff: only --stat is implemented; pass stat: true')
  const a = await parseArtifactFile(resolve(cwd, left))
  const b = await parseArtifactFile(resolve(cwd, right))
  const diff = diffArtifacts(a, b, { imports, hash: sha512integrity })
  out.write(formatDiffStat(diff, { left, right, leftKind: a.kind, rightKind: b.kind }))
  return { diff, differences: hasDifferences(diff) }
}
