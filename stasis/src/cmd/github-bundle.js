import { resolve } from 'node:path'

import { createClient } from '@preventive/upstream/github.js'
import { buildGitHubBundle } from '../vfs-bundle/github.js'
import { bundledSummary, writeBundle, writeFile } from './output.js'

// The default output of `stasis github-bundle`: `owner-name.<commit's first 7>.stasis.code.br` of
// the repo, or `owner-name.<directory, its / made ->.<commit's first 7>.stasis.code.br` of a
// directory in it, each character outside the portable filename set [A-Za-z0-9._-] made `_`.
export function githubBundleFile({ github, directory, commit }) {
  const name = [github.replace('/', '-'), ...(directory ? [directory.replaceAll('/', '-')] : []), commit.slice(0, 7)].join('.')
  return `${name.replaceAll(/[^\w.-]/gu, '_')}.stasis.code.br`
}

// Run `stasis github-bundle`: the bundle of a GitHub repo at a commit, or the one a tag names (the
// default branch's head without either), as buildGitHubBundle builds it from `options`, written
// brotli-compressed to `output` (githubBundleFile's name for it by default, `-` for stdout), and a
// JS bundle's lockfile to `lockfile` where given.
// The tree is fetched with GITHUB_TOKEN from `env` where it is set; nothing else of `env` is read.
export async function githubBundleCommand({ cwd = process.cwd(), env = process.env, output, lockfile, brotliQuality, client, ...options } = {}) {
  const built = await buildGitHubBundle({ ...options, lockfile, client: client ?? createClient({ token: env.GITHUB_TOKEN || null }) })
  const dest = writeBundle(cwd, output ?? githubBundleFile({ github: options.github, directory: options.directory, commit: built.bundle.repo.commit }), built.bundle.serialize(), brotliQuality)
  if (lockfile !== undefined) writeFile(resolve(cwd, lockfile), built.lockfile.serialize())
  const from = `${options.github}@${built.bundle.repo.commit}${options.directory ? `/${options.directory}` : ''}`
  console.warn(bundledSummary(built.bundle.sources.size, built.bundle.modules, from, dest))
}
