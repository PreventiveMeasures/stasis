import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { BUNDLE_FILE, LOCK_FILE } from '@exodus/stasis-core/util'
import { createClient } from '@preventive/upstream/github.js'
import { buildGitHubBundle } from '../vfs-bundle/github.js'
import { debugTimed } from './bundle.js'
import { githubToken, withNpmToken } from './tokens.js'
import { bundledSummary, lockedSummary, lockfileOnlyError, unpackedSummary, writeBundle, writeFile } from './output.js'

// The longest file name ext4, APFS and NTFS take: 255 bytes, or characters, ours being ASCII.
const NAME_MAX = 255
const portable = (s) => s.replaceAll(/[^\w.-]/gu, '_')

// `owner-name[.<directory, its / made ->].<commit's first 7>.stasis.code.br`, or `.stasis.lock.json` for
// `suffix` LOCK_FILE. A directory too long for NAME_MAX keeps what fits of its start, then `_` and its sha256's
// first 8 (a valid `github` leaves it 91 at least, 89 of a lockfile).
export function githubBundleFile({ github, directory, commit }, suffix = BUNDLE_FILE) {
  const repo = portable(github.replace('/', '-'))
  const tail = `.${portable(commit.slice(0, 7))}.${suffix}`
  if (!directory) return `${repo}${tail}`
  const room = NAME_MAX - `${repo}.${tail}`.length
  let dir = portable(directory.replaceAll('/', '-'))
  if (dir.length > room) dir = `${dir.slice(0, room - 9)}_${createHash('sha256').update(directory).digest('hex').slice(0, 8)}`
  return `${repo}.${dir}${tail}`
}

// Run `stasis github-bundle`. Of `env`, only GITHUB_TOKEN and EXODUS_STASIS_LOCK are read.
// Under --lockfile-only, without `lockfile`, the lockfile is named as the bundle would be, `.stasis.lock.json` for
// `.stasis.code.br`.
export async function githubBundleCommand({ cwd = process.cwd(), env = process.env, home, output, lockfile, lockfileOnly = false, brotliQuality, client, ...options } = {}) {
  const lockfileOnlyRefused = lockfileOnly ? lockfileOnlyError({ lockfile, output, brotliQuality, named: true }) : null
  if (lockfileOnlyRefused !== null) throw new Error(`githubBundleCommand: ${lockfileOnlyRefused}`)
  const locks = lockfile !== undefined || lockfileOnly
  // buildGitHubBundle reads only whether a lockfile is asked for, refusing one but of a JS bundle; it writes none.
  const built = await withNpmToken(home, () => buildGitHubBundle({ ...options, lockfile: locks ? lockfile ?? LOCK_FILE : undefined, lock: env.EXODUS_STASIS_LOCK || undefined, client: client ?? createClient({ token: githubToken({ env, home }) }) }))
  const { directory, bundle } = built
  const named = (suffix) => githubBundleFile({ github: options.github, directory, commit: bundle.repo.commit }, suffix)
  // Built before anything is written, as `stasis bundle` builds it.
  const lockData = locks ? built.lockfile.serialize() : undefined
  const lockTarget = lockfile ?? named(LOCK_FILE)
  let dest
  // Serialized under --lockfile-only too: never write a lockfile of a bundle that couldn't be written.
  if (lockfileOnly) bundle.serialize()
  else dest = await debugTimed('Wrote the bundle', () => writeBundle(cwd, output ?? named(BUNDLE_FILE), bundle.serialize(), brotliQuality))
  if (lockData !== undefined) writeFile(resolve(cwd, lockTarget), lockData)
  const from = `${options.github}@${bundle.repo.commit}${directory ? `/${directory}` : ''}`
  console.warn(unpackedSummary(built.stats))
  console.warn((lockfileOnly ? lockedSummary : bundledSummary)(bundle.sources.size, bundle.modules, from, lockfileOnly ? lockTarget : dest))
}
