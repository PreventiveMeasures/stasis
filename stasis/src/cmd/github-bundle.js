import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { BUNDLE_FILE } from '@exodus/stasis-core/util'
import { createClient } from '@preventive/upstream/github.js'
import { buildGitHubBundle } from '../vfs-bundle/github.js'
import { debugTimed } from './bundle.js'
import { githubToken, withNpmToken } from './tokens.js'
import { bundledSummary, lockedSummary, lockfileOnlyError, unpackedSummary, writeBundle, writeFile } from './output.js'

// The longest file name ext4, APFS and NTFS take: 255 bytes, or characters, ours being ASCII.
const NAME_MAX = 255
// Each character outside the portable filename set [A-Za-z0-9._-] made `_`.
const portable = (s) => s.replaceAll(/[^\w.-]/gu, '_')

// `stasis github-bundle`'s default output, portable: `owner-name[.<directory, its / made ->].<commit's first 7>.stasis.code.br`.
// A directory too long for NAME_MAX keeps what fits of its start, then `_` and its sha256's first 8 (a valid
// `github`, at most 140 characters, leaves it 91 at least).
export function githubBundleFile({ github, directory, commit }) {
  const repo = portable(github.replace('/', '-'))
  const tail = `.${portable(commit.slice(0, 7))}.${BUNDLE_FILE}`
  if (!directory) return `${repo}${tail}`
  const room = NAME_MAX - `${repo}.${tail}`.length
  let dir = portable(directory.replaceAll('/', '-'))
  if (dir.length > room) dir = `${dir.slice(0, room - 9)}_${createHash('sha256').update(directory).digest('hex').slice(0, 8)}`
  return `${repo}.${dir}${tail}`
}

// Run `stasis github-bundle`: buildGitHubBundle's bundle of `options`, written to `output` (githubBundleFile's
// name by default, `-` for stdout), its lockfile to `lockfile` where given, or under `lockfileOnly` that alone,
// refused before anything is fetched. Of `env`, only GITHUB_TOKEN (githubToken's) and EXODUS_STASIS_LOCK are read.
export async function githubBundleCommand({ cwd = process.cwd(), env = process.env, home, output, lockfile, lockfileOnly = false, brotliQuality, client, ...options } = {}) {
  const lockfileOnlyRefused = lockfileOnly ? lockfileOnlyError({ lockfile, output, brotliQuality }) : null
  if (lockfileOnlyRefused !== null) throw new Error(`githubBundleCommand: ${lockfileOnlyRefused}`)
  const built = await withNpmToken(home, () => buildGitHubBundle({ ...options, lockfile, lock: env.EXODUS_STASIS_LOCK || undefined, client: client ?? createClient({ token: githubToken({ env, home }) }) }))
  const { directory, bundle } = built
  // Built for --lockfile alone, before anything is written, as `stasis bundle` builds it.
  const lockData = lockfile === undefined ? undefined : built.lockfile.serialize()
  let dest
  // Serialized under --lockfile-only too: never write a lockfile of a bundle that couldn't be written.
  if (lockfileOnly) bundle.serialize()
  else dest = await debugTimed('Wrote the bundle', () => writeBundle(cwd, output ?? githubBundleFile({ github: options.github, directory, commit: bundle.repo.commit }), bundle.serialize(), brotliQuality))
  if (lockData !== undefined) writeFile(resolve(cwd, lockfile), lockData)
  const from = `${options.github}@${bundle.repo.commit}${directory ? `/${directory}` : ''}`
  console.warn(unpackedSummary(built.stats))
  console.warn((lockfileOnly ? lockedSummary : bundledSummary)(bundle.sources.size, bundle.modules, from, lockfileOnly ? lockfile : dest))
}
