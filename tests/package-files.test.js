import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Each workspace package publishes only what its package.json `files` names, so a source file left
// out of that list is missing from every install, and whatever imports it fails to load there.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('each package publishes every file under its src/', (t) => {
  for (const pkg of ['stasis', 'stasis-core', 'stasis-plugins']) {
    const dir = join(root, pkg)
    const { files } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const sources = readdirSync(join(dir, 'src'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    t.assert.ok(sources.length > 0, `${pkg}: has sources`)
    t.assert.deepStrictEqual(sources.filter((file) => !files.includes(file)), [], `${pkg}: unpublished sources`)
  }
})
