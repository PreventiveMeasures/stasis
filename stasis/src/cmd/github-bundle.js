import { resolve } from 'node:path'

import { createClient } from '@preventive/upstream/github.js'
import { buildGitHubBundle } from '../vfs-bundle/github.js'
import { DEFAULT_BUNDLE_FILE, bundledSummary, writeBundle, writeFile } from './output.js'

// Run `stasis github-bundle`: the bundle of a GitHub repo at a commit (the default branch's head
// without one), as buildGitHubBundle builds it from `options`, written brotli-compressed to `output`
// (stasis.code.br by default, `-` for stdout), and a JS bundle's lockfile to `lockfile` where given.
// The tree is fetched with GITHUB_TOKEN from `env` where it is set; nothing else of `env` is read.
export async function githubBundleCommand({ cwd = process.cwd(), env = process.env, output = DEFAULT_BUNDLE_FILE, lockfile, brotliQuality, client, ...options } = {}) {
  const built = await buildGitHubBundle({ ...options, lockfile, client: client ?? createClient({ token: env.GITHUB_TOKEN || null }) })
  const dest = writeBundle(cwd, output, built.bundle.serialize(), brotliQuality)
  if (lockfile !== undefined) writeFile(resolve(cwd, lockfile), built.lockfile.serialize())
  const from = `${options.github}@${built.bundle.repo.commit}${options.directory ? `/${options.directory}` : ''}`
  console.warn(bundledSummary(built.bundle.sources.size, built.bundle.modules, from, dest))
}
