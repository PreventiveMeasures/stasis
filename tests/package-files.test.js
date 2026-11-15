import { test } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Each workspace package publishes only what its package.json `files` names, so a source file left
// out of that list is missing from every install, and whatever imports it fails to load there.

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Names no package of the workspace may hold, at any depth: `.npm-extension.[cm]?[jt]s` is npm's
// project hook, which npm runs from a project's root before it resolves the dependency tree.
const FORBIDDEN_NAMES = [/^\.npm-extension\.[cm]?[jt]s$/iu]

// The workspace's files, from its root: the workspace packages and the tests' fixtures alike, not
// what an install lays out (`node_modules`) nor git's own (`.git`).
function workspaceFiles(dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : workspaceFiles(join(dir, entry.name))
    return [relative(root, join(dir, entry.name)).split(sep).join('/')]
  })
}

test('FORBIDDEN_NAMES takes .npm-extension in each of its spellings, and nothing else', (t) => {
  const forbidden = (name) => FORBIDDEN_NAMES.some((pattern) => pattern.test(name))
  for (const ext of ['js', 'ts', 'mjs', 'mts', 'cjs', 'cts']) t.assert.ok(forbidden(`.npm-extension.${ext}`), ext)
  t.assert.ok(forbidden('.NPM-Extension.MJS'), 'in any case')
  for (const name of ['npm-extension.mjs', '.npm-extension', '.npm-extension.json', '.npm-extension.jsx', '.npm-extension.xjs', '.npm-extension.mjs.map', 'a.npm-extension.mjs']) {
    t.assert.ok(!forbidden(name), name)
  }
})

test('no package holds a file of a forbidden name', (t) => {
  const files = workspaceFiles()
  t.assert.ok(files.includes('stasis/package.json'), 'walks the workspace packages')
  t.assert.deepStrictEqual(files.filter((file) => FORBIDDEN_NAMES.some((pattern) => pattern.test(file.slice(file.lastIndexOf('/') + 1)))), [])
})

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
