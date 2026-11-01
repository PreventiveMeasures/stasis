import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { createClient } from '@preventive/upstream/github.js'
import { buildGitHubBundle } from '../vfs-bundle/github.js'
import { debugTimed } from './bundle.js'
import { githubToken, withNpmToken } from './tokens.js'
import { bundledSummary, unpackedSummary, writeBundle, writeFile } from './output.js'

// The longest file name ext4, APFS and NTFS take: 255 bytes, or characters, ours being ASCII.
const NAME_MAX = 255
// Each character outside the portable filename set [A-Za-z0-9._-] made `_`.
const portable = (s) => s.replaceAll(/[^\w.-]/gu, '_')

// The default output of `stasis github-bundle`: `owner-name.<commit's first 7>.stasis.code.br` of
// the repo, or `owner-name.<directory, its / made ->.<commit's first 7>.stasis.code.br` of a
// directory in it, portable. A directory too deep for that to fit in NAME_MAX keeps what fits of
// its start, and `_` and the first 8 of its sha256 after it; a valid `github` (at most 140
// characters) leaves at least 91 for it.
export function githubBundleFile({ github, directory, commit }) {
  const repo = portable(github.replace('/', '-'))
  const tail = `.${portable(commit.slice(0, 7))}.stasis.code.br`
  if (!directory) return `${repo}${tail}`
  const room = NAME_MAX - `${repo}.${tail}`.length
  let dir = portable(directory.replaceAll('/', '-'))
  if (dir.length > room) dir = `${dir.slice(0, room - 9)}_${createHash('sha256').update(directory).digest('hex').slice(0, 8)}`
  return `${repo}.${dir}${tail}`
}

// Run `stasis github-bundle`: the bundle of a GitHub repo at a commit, or the one a tag names (the
// default branch's head without either), as buildGitHubBundle builds it from `options`, written
// brotli-compressed to `output` (githubBundleFile's name for it by default, of the directory
// bundled, the one a `path` gives too; `-` for stdout), and a JS bundle's lockfile to `lockfile`
// where given; then it says how many packages it unpacked, and what it bundled.
// GitHub is asked with githubToken's token, `env`'s GITHUB_TOKEN where it is set, nothing else of
// `env` being read; npm, with withNpmToken's (tokens.js).
export async function githubBundleCommand({ cwd = process.cwd(), env = process.env, home, output, lockfile, brotliQuality, client, ...options } = {}) {
  const built = await withNpmToken(home, () => buildGitHubBundle({ ...options, lockfile, client: client ?? createClient({ token: githubToken({ env, home }) }) }))
  const { directory } = built
  const dest = await debugTimed('Wrote the bundle', () => writeBundle(cwd, output ?? githubBundleFile({ github: options.github, directory, commit: built.bundle.repo.commit }), built.bundle.serialize(), brotliQuality))
  if (lockfile !== undefined) writeFile(resolve(cwd, lockfile), built.lockfile.serialize())
  const from = `${options.github}@${built.bundle.repo.commit}${directory ? `/${directory}` : ''}`
  console.warn(unpackedSummary(built.stats))
  console.warn(bundledSummary(built.bundle.sources.size, built.bundle.modules, from, dest))
}
