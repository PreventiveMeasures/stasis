import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'

import { PRISMA_VERSIONS } from '../stasis/src/vfs-bundle/prisma.js'
import { cases, clientHash, readHashes, writeHashes } from './prisma-generate.helper.js'

// Writes fixtures/prisma-generate.json.br, the hashes of what each Prisma's own `prisma generate`
// writes for each case of prisma-generate.helper.js, which prisma-generate.test.js holds stasis's
// clients to: each version's `prisma` and `@prisma/client` installed from the registry (scripts
// ignored; the CLI fetches its engines itself), each case written out and generated in turn. Run by
// hand, with the network, after a change to the corpus or to the versions stasis generates as:
//   node tests/prisma-generate-truth.manual.js [version ...]

const hashes = readHashes()
const versions = process.argv.length > 2 ? process.argv.slice(2) : PRISMA_VERSIONS

const filesUnder = (dir, at = '') => readdirSync(join(dir, at), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(dir, posix.join(at, entry.name)) : [posix.join(at, entry.name)]))

for (const version of versions) {
  const root = mkdtempSync(join(tmpdir(), `stasis-prisma-${version}-`))
  try {
    writeFileSync(join(root, 'package.json'), '{"private":true}\n')
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--silent', `prisma@${version}`, `@prisma/client@${version}`], { cwd: root, stdio: 'inherit' })
    const cli = join(root, 'node_modules/prisma/build/index.js')
    hashes[version] = {}
    for (const [name, c] of Object.entries(cases)) {
      const dir = join(root, 'projects', name)
      for (const [rel, text] of Object.entries(c.files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true })
        writeFileSync(join(dir, rel), text)
      }
      const run = spawnSync(process.execPath, [cli, 'generate', ...c.args], { cwd: join(dir, c.cwd), encoding: 'utf8', env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NO_COLOR: '1' } })
      if (run.status !== 0) throw new Error(`prisma ${version} generate failed for ${name}:\n${run.stdout}\n${run.stderr}`)
      const output = join(dir, c.output ?? 'generated')
      hashes[version][name] = clientHash(new Map(filesUnder(output).map((path) => [path, readFileSync(join(output, path))])))
    }
    console.log(`prisma ${version}: ${Object.keys(cases).length} cases`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

writeHashes(Object.fromEntries(PRISMA_VERSIONS.filter((version) => hashes[version]).map((version) => [version, hashes[version]])))
