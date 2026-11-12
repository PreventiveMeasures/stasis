import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { BUNDLE_FILE, LOCK_FILE } from '@exodus/stasis-core/util'
import { createClient } from '@preventive/upstream/github.js'
import { buildGitHubBundle } from '../vfs-bundle/github.js'
import { debugTimed, heldToLockfile } from './bundle.js'
import { githubToken, withNpmToken } from './tokens.js'
import { bundledSummary, heldSummary, lockedSummary, lockfileOnlyError, unpackedSummary, writeBundleOf, writeFile } from './output.js'

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
// The local lockfile is `lockfile`, else the one named as the bundle would be, `.stasis.lock.json` for
// `.stasis.code.br`. One there holds the build, by EXODUS_STASIS_LOCK's mode, frozen without it: it must attest the
// build, and the repo it records the build's, and is left as it is. One not there is written, where `lockfile` or
// `lockfileOnly` asks for it, recording the repo as the bundle does.
export async function githubBundleCommand({ cwd = process.cwd(), env = process.env, home, output, lockfile, lockfileOnly = false, brotliQuality, client, ...options } = {}) {
  const lockfileOnlyRefused = lockfileOnly ? lockfileOnlyError({ lockfile, output, brotliQuality, named: true }) : null
  if (lockfileOnlyRefused !== null) throw new Error(`githubBundleCommand: ${lockfileOnlyRefused}`)
  const locks = lockfile !== undefined || lockfileOnly
  // The local lockfile's mode is the environment's alone: a repo's `lock: frozen` pins its own stasis.lock.json.
  const mode = env.EXODUS_STASIS_LOCK || 'frozen'
  if (locks && (mode === 'ignore' || mode === 'none')) throw new Error(`githubBundleCommand: ${lockfile === undefined ? '--lockfile-only' : '--lockfile'}: lock = ${mode} writes no lockfile`)
  // buildGitHubBundle reads only whether a lockfile is asked for, refusing one but of a JS bundle; it writes none.
  const built = await withNpmToken(home, () => buildGitHubBundle({ ...options, lockfile: locks ? lockfile ?? LOCK_FILE : undefined, lock: env.EXODUS_STASIS_LOCK || undefined, client: client ?? createClient({ token: githubToken({ env, home }) }) }))
  const { directory, bundle } = built
  const named = (suffix) => githubBundleFile({ github: options.github, directory, commit: bundle.repo.commit }, suffix)
  const lockTarget = lockfile ?? named(LOCK_FILE)
  const lockAbs = resolve(cwd, lockTarget)
  const label = relative(resolve(cwd), lockAbs)
  // Before anything is written: the build, and the lockfile it writes, take what the one there alone attests. Of
  // a build of none (a Solidity one), it holds nothing.
  const present = existsSync(lockAbs)
  const held = present && heldToLockfile(() => built.lockfile, lockAbs, label, mode, { bundle, accounts: built.accounts, repo: bundle.repo }) !== undefined
  const writes = locks && !(present && mode === 'frozen')
  // Built before anything is written, as `stasis bundle` builds it.
  const lockData = writes ? built.lockfile.serialize() : undefined
  let dest
  // Serialized under --lockfile-only too: never write a lockfile of a bundle that couldn't be written.
  if (lockfileOnly) bundle.serializedBytes()
  else dest = await debugTimed('Wrote the bundle', () => writeBundleOf(cwd, output ?? named(BUNDLE_FILE), bundle, brotliQuality))
  if (lockData !== undefined) writeFile(lockAbs, lockData)
  const from = `${options.github}@${bundle.repo.commit}${directory ? `/${directory}` : ''}`
  const summarized = (summary, to) => summary(bundle.sources.size, bundle.modules, from, to)
  console.warn(unpackedSummary(built.stats))
  if (held) console.warn(summarized(heldSummary, label))
  if (!lockfileOnly) console.warn(summarized(bundledSummary, dest))
  else if (writes) console.warn(summarized(lockedSummary, lockTarget))
}
