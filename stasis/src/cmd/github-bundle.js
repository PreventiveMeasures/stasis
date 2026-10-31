import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { readJson } from '@exodus/stasis-core/bundle-util'
import { createClient } from '@preventive/upstream/github.js'
import { buildGitHubBundle } from '../vfs-bundle/github.js'
import { bundledSummary, writeBundle, writeFile } from './output.js'

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

// The variables @preventive/upstream's npm client takes its token from, the first set and not
// empty, read from process.env on each request.
const NPM_TOKEN_VARS = ['PREVENTIVE_MEASURES_NPM_TOKEN', 'STASIS_NPM_TOKEN', 'NPM_TOKEN']

// A token as @preventive/upstream takes one, printable ASCII and no space, around which whitespace
// is dropped; anything else is none, so that it never reaches an error message.
const asToken = (value) => (typeof value === 'string' && /^[!-~]+$/u.test(value.trim()) ? value.trim() : undefined)

// The GitHub `token` and `npmToken` of `<home>/.audit/config.json` (the user's home by default),
// each where the file has it as a token. The file is another tool's, read for compatibility: one
// that is missing, unreadable, not JSON or of another shape gives neither, and nothing is said.
export function auditTokens(home) {
  const config = readJson(join(home ?? homedir(), '.audit', 'config.json'))
  return config === null ? {} : { token: asToken(config.token), npmToken: asToken(config.npmToken) }
}

// Run `stasis github-bundle`: the bundle of a GitHub repo at a commit, or the one a tag names (the
// default branch's head without either), as buildGitHubBundle builds it from `options`, written
// brotli-compressed to `output` (githubBundleFile's name for it by default, `-` for stdout), and a
// JS bundle's lockfile to `lockfile` where given.
// The tree is fetched with GITHUB_TOKEN from `env` where it is set, else with auditTokens(home)'s
// `token`; nothing else of `env` is read. Where none of NPM_TOKEN_VARS is set in process.env,
// auditTokens(home)'s `npmToken` is STASIS_NPM_TOKEN there while the bundle is built, for the npm
// client to read, and process.env is as it was after.
export async function githubBundleCommand({ cwd = process.cwd(), env = process.env, home, output, lockfile, brotliQuality, client, ...options } = {}) {
  const audit = auditTokens(home)
  const npmToken = NPM_TOKEN_VARS.some((name) => process.env[name]) ? undefined : audit.npmToken
  const before = process.env.STASIS_NPM_TOKEN
  if (npmToken !== undefined) process.env.STASIS_NPM_TOKEN = npmToken
  let built
  try {
    built = await buildGitHubBundle({ ...options, lockfile, client: client ?? createClient({ token: env.GITHUB_TOKEN || audit.token || null }) })
  } finally {
    if (npmToken !== undefined && process.env.STASIS_NPM_TOKEN === npmToken) {
      if (before === undefined) delete process.env.STASIS_NPM_TOKEN
      else process.env.STASIS_NPM_TOKEN = before
    }
  }
  const dest = writeBundle(cwd, output ?? githubBundleFile({ github: options.github, directory: options.directory, commit: built.bundle.repo.commit }), built.bundle.serialize(), brotliQuality)
  if (lockfile !== undefined) writeFile(resolve(cwd, lockfile), built.lockfile.serialize())
  const from = `${options.github}@${built.bundle.repo.commit}${options.directory ? `/${options.directory}` : ''}`
  console.warn(bundledSummary(built.bundle.sources.size, built.bundle.modules, from, dest))
}
