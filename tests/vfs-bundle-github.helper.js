import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'

// A fake @preventive/upstream/github.js client over a repo held in memory, for the buildGitHubBundle
// tests (vfs-bundle-github.test.js, and the child it spawns to watch the disk): nothing is fetched.

// A pnpm-lock.yaml of `importers` by id, each locking nothing.
export const lockfile = (...importers) => ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '', 'importers:', '', ...importers.map((id) => `  ${id}: {}`), ''].join('\n')

export const json = (value) => `${JSON.stringify(value)}\n`

// The commit the fake client's default branch is at.
export const HEAD = 'b'.repeat(40)

const encoder = new TextEncoder()

// A gzipped tarball of `files` under `dir`, as GitHub's: one top directory named for the tree, and
// the modes git archive's tar.umask 0002 gives. A `{ symlink }` value is a link to that target.
export const tarballOf = (files, dir = '') => {
  const prefix = dir ? `${dir}/` : ''
  const entries = [{ name: 'tree-id/', type: 'directory', mode: 0o775 }]
  for (const [path, value] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue
    const name = `tree-id/${path.slice(prefix.length)}`
    entries.push(typeof value === 'string' ? { name, data: encoder.encode(value), mode: 0o664 } : { name, type: 'symlink', linkname: value.symlink })
  }
  return compress(pack(entries), 'gzip')
}

// `tags` maps each tag to the commit it names.
export const fakeClient = (files, { tags = {} } = {}) => {
  const calls = []
  return {
    calls,
    async getRepoHead({ repo, branch }) {
      calls.push(['getRepoHead', repo, branch])
      return { branch: branch ?? 'main', oid: HEAD }
    },
    async getRepoTag({ repo, tag }) {
      calls.push(['getRepoTag', repo, tag])
      if (!Object.hasOwn(tags, tag)) throw new Error(`getRepoTag: ${repo} has no tag ${tag}`)
      return { tag, oid: tags[tag] }
    },
    async listRepoDir({ repo, sha, directory }) {
      calls.push(['listRepoDir', repo, sha, directory])
      const prefix = directory === undefined ? '' : `${directory}/`
      const names = Object.keys(files).filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
      // As upstream refuses a path that is no directory in git (a symlink, or under one).
      if (names.length === 0) throw new Error(`listRepoDir: ${repo}@${sha} has no directory at ${directory}`)
      return names.map((name) => (name.includes('/') ? { path: name.split('/')[0], type: 'tree', sha: `tree:${prefix}${name.split('/')[0]}` } : { path: name, type: 'blob' }))
    },
    async getRepoTreeId({ repo, sha, directory }) {
      calls.push(['getRepoTreeId', repo, sha, directory])
      if (!Object.keys(files).some((f) => f.startsWith(`${directory}/`))) throw new Error(`getRepoTreeId: ${repo}@${sha} has no directory at ${directory}`)
      return `tree:${directory}`
    },
    async getRepoTreeTarball({ repo, tree }) {
      calls.push(['getRepoTreeTarball', repo, tree])
      return tarballOf(files, tree.slice('tree:'.length))
    },
    async getRepoTarball({ repo, sha }) {
      calls.push(['getRepoTarball', repo, sha])
      return tarballOf(files)
    },
  }
}
