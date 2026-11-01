import { test } from 'node:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { compress } from '@preventive/archive/compression.js'
import { pack } from '@preventive/archive/tar.js'
import { githubBundleCommand } from '../stasis/src/cmd/github-bundle.js'
import { Vfs, buildGitHubBundle, buildVfsBundle, createVfsHost } from '../stasis/src/vfs-bundle.js'
import { generatePrismaClients, reachedProjects, withPrismaClients } from '../stasis/src/vfs-bundle/prisma.js'
import { fakeClient, json } from './vfs-bundle-github.helper.js'
import { captureWarningsAsync } from './warnings.helper.js'

/* eslint-disable no-await-in-loop -- each case waits on its own build, in order, its warnings read after it */

// As they are before anything here generates.
const { cwd } = process
const { close } = fs

// `generate: ['prisma']` over a pnpm workspace in a Vfs, with stand-in `prisma` and `@prisma/client`
// linked from vendor/: nothing is fetched or run. Byte-exactness is prisma-generate.test.js's.

const write = (vfs, files) => {
  for (const [rel, text] of Object.entries(files)) {
    vfs.mkdir(posix.dirname(`/${rel}`), { recursive: true })
    vfs.writeFile(`/${rel}`, text)
  }
  return vfs
}
const project = (files) => write(new Vfs(), files)

const LOCKFILE = [
  "lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '', 'importers:', '', '  .: {}', '',
  '  packages/a:', '    dependencies:', '      b:', '        specifier: workspace:*', '        version: link:../b', '',
  '  packages/b:', '    dependencies:', "      '@prisma/client':", '        specifier: link:../../vendor/client', '        version: link:../../vendor/client',
  '    devDependencies:', '      prisma:', '        specifier: link:../../vendor/prisma', '        version: link:../../vendor/prisma', '',
].join('\n')

const schema = ({ output = '../src/generated/prisma', provider = 'prisma-client', extra = '' } = {}) => `generator client {\n  provider = "${provider}"\n  output   = "${output}"${extra}\n}\n\ndatasource db {\n  provider = "postgresql"\n}\n\nmodel User {\n  id    Int    @id @default(autoincrement())\n  email String @unique\n}\n`

// A workspace whose `a` imports `b`, whose source imports the client its schema generates.
const workspace = ({ version = '7.9.0', files = {} } = {}) => ({
  'package.json': json({ name: 'mono', version: '1.0.0', private: true }),
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'pnpm-lock.yaml': LOCKFILE,
  'vendor/prisma/package.json': json({ name: 'prisma', version }),
  'vendor/client/package.json': json({ name: '@prisma/client', version, exports: { './runtime/client': './runtime/client.js', './runtime/*': './runtime/*' } }),
  'vendor/client/runtime/client.js': 'module.exports = {}\n',
  'vendor/client/runtime/query_compiler_fast_bg.postgresql.mjs': 'export default {}\n',
  'vendor/client/runtime/query_compiler_fast_bg.postgresql.wasm-base64.mjs': "export const wasm = ''\n",
  'packages/b/package.json': json({ name: 'b', version: '1.0.0', type: 'module', exports: './src/index.ts', dependencies: { '@prisma/client': 'link:../../vendor/client' }, devDependencies: { prisma: 'link:../../vendor/prisma' } }),
  'packages/b/prisma/schema.prisma': schema(),
  'packages/b/src/index.ts': "export { PrismaClient } from './generated/prisma/client.ts'\n",
  'packages/a/package.json': json({ name: 'a', version: '1.0.0', type: 'module', exports: './index.ts', dependencies: { b: 'workspace:*' } }),
  'packages/a/index.ts': "export { PrismaClient } from 'b'\n",
  ...files,
})

const build = (vfs, options) => buildVfsBundle({ vfs, packageManager: 'pnpm', cwd: '/packages/a', entries: ['index.ts'], ...options })
const CLIENT = 'packages/b/src/generated/prisma'
const text = (bundle, path) => {
  const bytes = bundle.sources.get(path)
  return typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
}
// Mocks console.warn; returns a function reading its messages so far.
const warnings = (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  return () => warn.mock.calls.map((call) => call.arguments[0])
}

test('--generate=prisma bundles the client `prisma generate` writes, which the tree never holds', async (t) => {
  const vfs = project(workspace())
  await t.assert.rejects(build(vfs, { generate: [] }), /generated\/prisma\/client\.ts/u)
  const { bundle } = await build(vfs, { generate: ['prisma'] })
  for (const path of ['packages/a/index.ts', 'packages/b/src/index.ts', `${CLIENT}/client.ts`, `${CLIENT}/internal/class.ts`, `${CLIENT}/internal/prismaNamespace.ts`, `${CLIENT}/enums.ts`, 'vendor/client/runtime/client.js']) {
    t.assert.ok(bundle.sources.has(path), path)
  }
  // As Prisma 7.9.0, the one the workspace installs, writes it: its version stamped, no model schema.
  t.assert.match(text(bundle, `${CLIENT}/internal/class.ts`), /"clientVersion": "7\.9\.0",\n {2}"engineVersion": "e922089b7d7502aff4249d5da3420f6fa55fc6ad",/u)
  t.assert.doesNotMatch(text(bundle, `${CLIENT}/internal/class.ts`), /\\"schema\\":/u)
  t.assert.equal(vfs.isDirectory(`/${CLIENT}`), false, "the project's Vfs is only read")
})

test('--generate=prisma writes the client of the Prisma installed, from 7.4.0 to 7.10.0', async (t) => {
  for (const [version, engine] of [['7.10.0', '0edf323efd1d98336f3f0a68684b56f689b900d3'], ['7.4.0', 'ab56fe763f921d033a6c195e7ddeb3e255bdbb57']]) {
    const { bundle } = await build(project(workspace({ version })), { generate: ['prisma'] })
    t.assert.match(text(bundle, `${CLIENT}/internal/prismaNamespace.ts`), new RegExp(` \\* Prisma Client JS version: ${version.replaceAll('.', '\\.')}\\n \\* Query Engine version: ${engine}\\n`, 'u'))
  }
})

test('--generate=prisma skips, with a warning, a project it cannot generate for', async (t) => {
  const said = warnings(t)
  const failing = (files) => t.assert.rejects(build(project(files), { generate: ['prisma'] }), /generated\/prisma\/client\.ts/u)
  await failing(workspace({ version: '6.19.0' }))
  t.assert.match(said().at(-1), /^\[stasis\] prisma: not generating for \/packages\/b\/prisma\/schema\.prisma: stasis generates as Prisma 7\.4\.0 to 7\.10\.0 do, and \/packages\/b\/node_modules\/prisma\/package\.json is 6\.19\.0$/u)
  await failing(workspace({ version: '7.3.0' }))
  t.assert.match(said().at(-1), /and \/packages\/b\/node_modules\/prisma\/package\.json is 7\.3\.0$/u)
  // No prisma installed at all: nothing says which Prisma's client it would be.
  const bare = workspace()
  bare['pnpm-lock.yaml'] = LOCKFILE.replace(/ {4}devDependencies:\n {6}prisma:\n.*\n.*\n/u, '')
  bare['packages/b/package.json'] = json({ ...JSON.parse(bare['packages/b/package.json']), devDependencies: undefined })
  await failing(bare)
  t.assert.match(said().at(-1), /: stasis generates as Prisma 7\.4\.0 to 7\.10\.0 do, and none is installed$/u)
  // Another generator is the repo's own code (or Prisma's older client), which stasis doesn't run.
  await failing(workspace({ files: { 'packages/b/prisma/schema.prisma': schema({ provider: 'prisma-client-js' }) } }))
  t.assert.match(said().at(-1), /^\[stasis\] prisma: not generating \/packages\/b\/prisma\/schema\.prisma's generator client: stasis generates the "prisma-client" provider's alone$/u)
  // A project with no schema is no Prisma project, and says nothing.
  const quiet = said().length
  const { 'packages/b/prisma/schema.prisma': _, ...none } = workspace({ files: { 'packages/b/src/index.ts': 'export {}\n' } })
  await build(project(none), { generate: ['prisma'] })
  t.assert.equal(said().length, quiet)
})

// --- what isn't generated ---

const SKIPPED = 'stasis generates the "prisma-client" provider\'s alone'
// The warning that b's schema's generator `name` isn't generated: skipped, and where `committed`, taken as committed.
const notGenerating = (name, committed) => `[stasis] prisma: not generating /packages/b/prisma/schema.prisma's generator ${name}: ${SKIPPED}${committed === undefined ? '' : `, and takes its output, ${committed}, as committed, not as \`prisma generate\` would write it`}`
// The workspace with Pothos's types beside b's client, as its docs lay them out for the `prisma-client` generator:
// its `output` (none where null) and `extra` lines, b's source `index` where given, and `files` besides.
const withPothos = ({ output = '../src/generated/pothos-types.ts', extra = '', index, files = {} } = {}) => workspace({ files: {
  'packages/b/prisma/schema.prisma': `${schema()}\ngenerator pothos {\n  provider = "prisma-pothos-types"${output === null ? '' : `\n  output   = "${output}"`}${extra}\n}\n`,
  ...(index === undefined ? {} : { 'packages/b/src/index.ts': index }),
  ...files,
} })
const CLIENT_EXPORT = "export { PrismaClient } from './generated/prisma/client.ts'\n"
const COMMITTED_POTHOS = { 'packages/b/src/generated/pothos-types.ts': 'export function getDatamodel() { return {} }\n' }

test('--generate=prisma says where it takes another generator\'s output as committed', async (t) => {
  const said = warnings(t)
  const about = (name) => said().findLast((warning) => warning.includes(`generator ${name}:`))
  // Not in the tree: nothing is taken.
  await build(project(withPothos()), { generate: ['prisma'] })
  t.assert.equal(about('pothos'), notGenerating('pothos'))
  // Committed: the bundle carries it as it is, which may be stale, and the warning names it.
  const { bundle } = await build(project(withPothos({ index: `${CLIENT_EXPORT}export { getDatamodel } from './generated/pothos-types.ts'\n`, files: COMMITTED_POTHOS })), { generate: ['prisma'] })
  t.assert.equal(text(bundle, 'packages/b/src/generated/pothos-types.ts'), COMMITTED_POTHOS['packages/b/src/generated/pothos-types.ts'])
  t.assert.equal(about('pothos'), notGenerating('pothos', '/packages/b/src/generated/pothos-types.ts'))
  // A directory output, Prisma's older client's, likewise.
  const legacy = '\ngenerator legacy {\n  provider = "prisma-client-js"\n  output   = "../src/generated/legacy"\n}\n'
  await build(project(workspace({ files: { 'packages/b/prisma/schema.prisma': schema() + legacy, 'packages/b/src/generated/legacy/index.js': 'module.exports = {}\n' } })), { generate: ['prisma'] })
  t.assert.equal(about('legacy'), notGenerating('legacy', '/packages/b/src/generated/legacy'))
  // One in node_modules is the lockfile's, not the repo's: nothing is said of it.
  await build(project(withPothos({ output: '../node_modules/prisma/package.json' })), { generate: ['prisma'] })
  t.assert.equal(about('pothos'), notGenerating('pothos'))
})

test('--generate=prisma says nothing of Pothos\'s generator with no output: types alone, in its own package', async (t) => {
  const said = warnings(t)
  const about = () => said().filter((warning) => warning.includes('generator pothos'))
  const { bundle } = await build(project(withPothos({ output: null })), { generate: ['prisma'] })
  t.assert.ok(bundle.sources.has(`${CLIENT}/client.ts`), 'the client is generated all the same')
  await build(project(withPothos({ output: null, extra: '\n  generateDatamodel = "false"' })), { generate: ['prisma'] })
  t.assert.deepStrictEqual(about(), [])
  // generateDatamodel writes getDatamodel() there too, code the bundle may run: still said.
  await build(project(withPothos({ output: null, extra: '\n  generateDatamodel = "true"' })), { generate: ['prisma'] })
  t.assert.deepStrictEqual(about(), [notGenerating('pothos')])
})

test('given no generate, a JS build of a Vfs writes the client of each project its entries reach, as asked', async (t) => {
  const said = warnings(t)
  const asked = await build(project(workspace()), { generate: ['prisma'] })
  t.assert.equal((await build(project(workspace()))).bundle.serialize(), asked.bundle.serialize())
  t.assert.deepStrictEqual(said(), [])
})

// The workspace with c, a package of its own with a schema, which a doesn't depend on; `lockfile` the importers
// beside c's (the root's `{}`, unless given).
const C_IMPORTER = ['  packages/c:', '    dependencies:', "      '@prisma/client':", '        specifier: link:../../vendor/client', '        version: link:../../vendor/client',
  '    devDependencies:', '      prisma:', '        specifier: link:../../vendor/prisma', '        version: link:../../vendor/prisma', ''].join('\n')
const withC = (cSchema, files = {}, lockfile = LOCKFILE) => workspace({ files: {
  'pnpm-lock.yaml': `${lockfile}${C_IMPORTER}`,
  'packages/c/package.json': json({ name: 'c', version: '1.0.0', type: 'module', dependencies: { '@prisma/client': 'link:../../vendor/client' }, devDependencies: { prisma: 'link:../../vendor/prisma' } }),
  'packages/c/prisma/schema.prisma': cSchema,
  ...files,
} })

test('given no generate, only the projects the entries reach are generated for, and one they don\'t is never said', async (t) => {
  const said = warnings(t)
  // Its client isn't generated: a reaching it by path, not by dependency, finds none; asked for, every project's is.
  const byPath = withC(schema(), { 'packages/a/index.ts': "export { PrismaClient } from 'b'\nexport { PrismaClient as C } from '../c/src/generated/prisma/client.ts'\n" })
  await t.assert.rejects(build(project(byPath)), /unresolved export-from \.\.\/c\/src\/generated\/prisma\/client\.ts from index\.ts \(MODULE_NOT_FOUND\)$/u)
  t.assert.ok((await build(project(byPath), { generate: ['prisma'] })).bundle.sources.has('packages/c/src/generated/prisma/client.ts'))
  // A schema of c's Prisma can't take: never read, nor said; asked for, refused.
  const broken = withC(schema().replace('"postgresql"', '"nope"'))
  t.assert.ok((await build(project(broken))).bundle.sources.has(`${CLIENT}/client.ts`), "b's, which a depends on")
  t.assert.deepStrictEqual(said(), [])
  await t.assert.rejects(build(project(broken), { generate: ['prisma'] }), /^Error: prisma: \/packages\/c\/prisma\/schema\.prisma: /u)
})

test('given no generate, the projects reached are the entries\', not those of the directory bundled from', async (t) => {
  // From the workspace root, which depends on c, a's entry alone: c's client, which would collide with b's, is no
  // concern of a's. Asked for, every project's is.
  const rooted = withC(schema({ output: '../../b/src/generated/prisma' }), { 'package.json': json({ name: 'mono', version: '1.0.0', private: true, devDependencies: { c: 'workspace:*' } }) },
    LOCKFILE.replace('  .: {}\n', '  .:\n    devDependencies:\n      c:\n        specifier: workspace:*\n        version: link:packages/c\n'))
  const fromRoot = { cwd: '/', entries: ['packages/a/index.ts'] }
  t.assert.ok((await build(project(rooted), fromRoot)).bundle.sources.has(`${CLIENT}/client.ts`))
  await t.assert.rejects(build(project(rooted), { ...fromRoot, generate: ['prisma'] }), /^Error: prisma: \/packages\/b\/src\/generated\/prisma is the output of more than one generator$/u)
})

test('given no generate, an entry reached through a link is the project of the file it links to', async (t) => {
  // /app links to packages/a, whose dependency b has the schema. Built with --mainFields: a build through a State
  // refuses an entry reached through a link from above it, Prisma or not.
  const vfs = project(workspace())
  vfs.symlink('packages/a', '/app')
  t.assert.ok((await build(vfs, { cwd: '/', entries: ['app/index.ts'], mainFields: ['module', 'main'] })).bundle.sources.has(`${CLIENT}/client.ts`))
})

test('two generators writing one output are refused, given generate or not', async (t) => {
  const twice = workspace({ files: { 'packages/b/prisma/schema.prisma': `${schema()}\ngenerator again {\n  provider = "prisma-client"\n  output   = "../src/generated/prisma"\n}\n` } })
  for (const generate of [undefined, ['prisma']]) await t.assert.rejects(build(project(twice), { generate }), /^Error: prisma: \/packages\/b\/src\/generated\/prisma is the output of more than one generator$/u)
})

test('what stasis cannot generate is silent given no generate; asked for, it is said', async (t) => {
  const said = warnings(t)
  // Another generator, and another Prisma: silent, a miss of what it would write the scan's to report.
  await build(project(withPothos({ index: CLIENT_EXPORT })))
  await t.assert.rejects(build(project(workspace({ version: '6.19.0' }))), /unresolved export-from \.\/generated\/prisma\/client\.ts from \/packages\/b\/src\/index\.ts \(MODULE_NOT_FOUND\)$/u)
  t.assert.deepStrictEqual(said(), [])
  await build(project(withPothos({ index: CLIENT_EXPORT })), { generate: ['prisma'] })
  t.assert.deepStrictEqual(said(), [notGenerating('pothos')])
})

test('reachedProjects: the projects the paths are in, and the workspace packages they depend on, theirs in turn', (t) => {
  const host = createVfsHost(project({
    'package.json': json({ name: 'root' }),
    'apps/web/package.json': json({ name: 'web', dependencies: { api: 'workspace:*', react: '1.0.0' } }),
    'apps/api/package.json': json({ name: 'api', devDependencies: { db: 'workspace:*' } }),
    'packages/db/package.json': json({ name: 'db', peerDependencies: { types: '*' } }),
    'packages/types/package.json': json({ name: 'types' }),
    'packages/other/package.json': json({ name: 'other', dependencies: { db: '*' } }),
  }))
  const projects = new Set(['.', 'apps/web', 'apps/api', 'packages/db', 'packages/types', 'packages/other'])
  t.assert.deepStrictEqual([...reachedProjects(host, '/', projects, ['/apps/web/src/index.ts'])].toSorted(), ['apps/api', 'apps/web', 'packages/db', 'packages/types'])
  t.assert.deepStrictEqual([...reachedProjects(host, '/', projects, ['/scripts/build.ts'])], ['.'])
})

test('beside Prisma 8, the Prisma generated as is the one @prisma/prisma7 runs as `prisma7`', async (t) => {
  const prisma = (version) => json({ name: 'prisma', version })
  const base = { 'prisma/schema.prisma': schema({ output: '../client' }), 'node_modules/prisma/package.json': prisma('8.0.0') }
  const namespace = async (vfs) => (await generatePrismaClients({ host: createVfsHost(vfs), root: '/', projects: new Set(['.']) }))[0]?.files.get('internal/prismaNamespace.ts')
  // npm nests the Prisma it runs under it; pnpm lays it out beside it, linked from the project.
  const nested = project({ ...base, 'node_modules/@prisma/prisma7/package.json': json({ name: '@prisma/prisma7', version: '7.9.1' }), 'node_modules/@prisma/prisma7/node_modules/prisma/package.json': prisma('7.9.1') })
  t.assert.match(await namespace(nested), / \* Prisma Client JS version: 7\.9\.1\n/u)
  const store = 'node_modules/.pnpm/@prisma+prisma7@7.10.0/node_modules'
  const linked = project({ ...base, [`${store}/@prisma/prisma7/package.json`]: json({ name: '@prisma/prisma7', version: '7.10.0' }), [`${store}/prisma/package.json`]: prisma('7.10.0') })
  linked.mkdir('/node_modules/@prisma', { recursive: true })
  linked.symlink('../.pnpm/@prisma+prisma7@7.10.0/node_modules/@prisma/prisma7', '/node_modules/@prisma/prisma7')
  t.assert.match(await namespace(linked), / \* Prisma Client JS version: 7\.10\.0\n/u)
  // Prisma 8 alone is none generated as.
  const said = warnings(t)
  t.assert.equal(await namespace(project(base)), undefined)
  t.assert.match(said().at(-1), /, and \/node_modules\/prisma\/package\.json is 8\.0\.0$/u)
})

// generatePrismaClients over one project, with Prisma `version` installed.
const clients = (files, version = '7.10.0') => generatePrismaClients({
  host: createVfsHost(project({ 'node_modules/prisma/package.json': json({ name: 'prisma', version }), ...files })),
  root: '/',
  projects: new Set(['.']),
})
const outputDirs = async (...args) => (await clients(...args)).map((output) => output.dir)

const DEFINE = "import { defineConfig } from 'prisma/config'\n"
const NOT_SPELLED = 'its `schema` is no string literal, nor path.join of them'

test("the schema is the Prisma config's, read without running it, else schema.prisma or prisma/schema.prisma", async (t) => {
  const said = warnings(t)
  const db = { 'db/schema.prisma': schema({ output: '../db-client' }), 'prisma/schema.prisma': schema({ output: '../default-client' }) }
  t.assert.deepStrictEqual(await outputDirs(db), ['/default-client'])
  t.assert.deepStrictEqual(await outputDirs({ 'schema.prisma': schema({ output: 'root-client' }), ...db }), ['/root-client'])
  for (const config of [
    `${DEFINE}export default defineConfig({ schema: 'db/schema.prisma' })\n`,
    "export default { schema: `db/schema.prisma`, migrations: { path: 'db/migrations' } } satisfies Config\n",
    `${DEFINE}const config = defineConfig({ 'schema': 'db/schema.prisma' } as const)\nexport default config\n`,
    "const SCHEMA = 'db/schema.prisma'\nexport default { schema: (SCHEMA as string) }\n",
    // Node's path.join of literals, however the config imports or requires it.
    `${DEFINE}import path from 'node:path'\nexport default defineConfig({ schema: path.join('db', 'schema.prisma') })\n`,
    "import * as nodePath from 'path'\nexport default { schema: nodePath.join('db', `prisma`, '..', 'schema.prisma') }\n",
    "import { join as j } from 'node:path'\nconst DIR = './db'\nexport default { schema: j(DIR, j('schema.prisma')) }\n",
    "const { join } = require('path')\nconst { defineConfig } = require('prisma/config')\nmodule.exports = defineConfig({ schema: join('db', 'schema.prisma') })\n",
  ]) {
    t.assert.deepStrictEqual(await outputDirs({ 'prisma.config.ts': config, ...db }), ['/db-client'], config)
  }
  t.assert.deepStrictEqual(await outputDirs({ '.config/prisma.cjs': "module.exports = { schema: '../db/schema.prisma' }\n", ...db }), ['/db-client'])
  // A config naming no schema leaves the default.
  t.assert.deepStrictEqual(await outputDirs({ 'prisma.config.ts': `${DEFINE}export default defineConfig({ migrations: {} })\n`, ...db }), ['/default-client'])
  // prisma7.config.* is 7.10.0's alone, and comes first.
  const both = { 'prisma7.config.ts': "export default { schema: 'db/schema.prisma' }\n", 'prisma.config.ts': 'export default {}\n', ...db }
  t.assert.deepStrictEqual(await outputDirs(both), ['/db-client'])
  t.assert.deepStrictEqual(await outputDirs(both, '7.9.1'), ['/default-client'])
  // A schema the config computes is one stasis would have to run it to know, and so is the config
  // a defineConfig other than Prisma's makes.
  for (const [config, why] of [
    [`${DEFINE}import path from 'node:path'\nexport default defineConfig({ schema: path.join(__dirname, 'db', 'schema.prisma') })\n`, NOT_SPELLED],
    ["import path from 'node:path'\nexport default { schema: path.resolve('db', 'schema.prisma') }\n", NOT_SPELLED],
    ["const path = { join: () => 'elsewhere.prisma' }\nexport default { schema: path.join('db', 'schema.prisma') }\n", NOT_SPELLED],
    ["export default { ...base, schema: 'db/schema.prisma' }\n", 'its config spreads or computes a key'],
    ["import { defineConfig } from './define'\nexport default defineConfig({ schema: 'db/schema.prisma' })\n", 'its default export is no object literal'],
    ['export default makeConfig()\n', 'its default export is no object literal'],
    ['export const config = {}\n', 'no default export'],
  ]) {
    t.assert.deepStrictEqual(await outputDirs({ 'prisma.config.ts': config, ...db }), [], config)
    t.assert.equal(said().at(-1), `[stasis] prisma: not generating for /: /prisma.config.ts: ${why}, which stasis reads without running the config`)
  }
  // A directory is every .prisma file under it, as Prisma's own loader reads them.
  const folder = { 'prisma.config.ts': "export default { schema: './models' }\n", 'models/main.prisma': schema({ output: '../client' }).replace(/model User[^]*/u, ''), 'models/user.prisma': 'model User {\n  id Int @id\n}\n', 'models/nested/post.prisma': 'model Post {\n  id Int @id\n}\n', 'models/notes.md': '' }
  const [{ files }] = await clients(folder)
  t.assert.ok(files.has('models/Post.ts') && files.has('models/User.ts'))
})

test('the generator is held to what `prisma generate` takes', async (t) => {
  const twice = { 'prisma/schema.prisma': `${schema()}\ngenerator other {\n  provider = "prisma-client"\n  output   = "../src/generated/prisma"\n}\n` }
  await t.assert.rejects(clients(twice), /^Error: prisma: \/src\/generated\/prisma is the output of more than one generator$/u)
  await t.assert.rejects(clients({ 'prisma/schema.prisma': schema({ output: '../node_modules/.prisma/client' }) }), /output \/node_modules\/\.prisma\/client is in node_modules, which is laid out from the lockfile alone$/u)
  await t.assert.rejects(clients({ 'prisma/schema.prisma': schema().replace('"postgresql"', '"nope"') }), /^Error: prisma: \/prisma\/schema\.prisma: /u)
  await t.assert.rejects(clients({ 'prisma/schema.prisma': schema({ extra: '\n  runtime = "browser"' }) }), /Unknown target runtime: "browser"/u)
  // Names the engine takes and the generator refuses.
  await t.assert.rejects(clients({ 'prisma/schema.prisma': `${schema()}\nmodel AND {\n  id Int @id\n}\n\nenum NOT {\n  A\n}\n` }), /^Error: prisma: \/prisma\/schema\.prisma contains reserved keywords, to rename: "enum NOT", "model AND"$/u)
  const said = warnings(t)
  t.assert.deepStrictEqual(await clients({ 'prisma/schema.prisma': schema().replace('"../src/generated/prisma"', 'env("OUT")') }), [])
  t.assert.match(said().at(-1), /its output is env\("OUT"\), which stasis doesn't read$/u)
})

test("generating never loads @prisma/internals, which reads the host's npm config and patches fs", async (t) => {
  t.assert.equal((await clients({ 'prisma/schema.prisma': schema() })).length, 1)
  t.assert.ok(!Object.keys(createRequire(import.meta.url).cache).some((file) => file.includes('/@prisma/internals/')))
  t.assert.equal(process.cwd, cwd)
  t.assert.equal(fs.close, close)
})

test("a property name is quoted where Prisma's bundled identifier tables, not Node's, say so", async (t) => {
  // U+A7CE continues an identifier in Node 24's Unicode, not in the older tables Prisma bundles.
  const [{ files }] = await clients({ 'prisma/schema.prisma': schema().replace('  email String @unique\n', '  email String @unique\n  a\uA7CEb Int\n') })
  t.assert.match(files.get('models/User.ts'), /\["a\uA7CEb"\]/u)
})

test("an edge runtime's client carries the query compiler of the tree's prisma", async (t) => {
  const files = workspace({ files: { 'packages/b/prisma/schema.prisma': schema({ extra: '\n  runtime  = "workerd"' }) } })
  await t.assert.rejects(build(project(files), { generate: ['prisma'] }), /^Error: prisma: \/packages\/b\/node_modules\/prisma\/build\/query_compiler_fast_bg\.postgresql\.wasm, which a workerd client carries, is not in the tree$/u)
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
  const [{ files: client }] = await clients({
    'prisma/schema.prisma': files['packages/b/prisma/schema.prisma'],
    'node_modules/prisma/build/query_compiler_fast_bg.postgresql.mjs': 'export const bindings = 1\n',
    'node_modules/prisma/build/query_compiler_fast_bg.postgresql.wasm': wasm,
  })
  t.assert.deepStrictEqual(new Uint8Array(client.get('internal/query_compiler_fast_bg.wasm')), wasm)
  t.assert.match(client.get('internal/query_compiler_fast_bg.js'), /\/\/ @ts-nocheck \nexport const bindings = 1\n$/u)
})

test('an output holding an earlier client is generated over, as `prisma generate` clears it; one holding anything else is refused', async (t) => {
  const earlier = { [`${CLIENT}/client.ts`]: 'old\n', [`${CLIENT}/models/Gone.ts`]: 'old\n', [`${CLIENT}/README.md`]: 'kept\n', [`${CLIENT}/.cache/x.ts`]: 'kept\n' }
  const vfs = project(workspace({ files: earlier }))
  const { bundle } = await build(vfs, { generate: ['prisma'] })
  t.assert.notEqual(text(bundle, `${CLIENT}/client.ts`), 'old\n')
  const out = withPrismaClients(vfs, [{ dir: `/${CLIENT}`, files: new Map([['client.ts', 'new\n']]) }])
  t.assert.deepStrictEqual([...out.walk(`/${CLIENT}`)].filter((entry) => entry.type === 'file').map((entry) => entry.path), [`/${CLIENT}/.cache/x.ts`, `/${CLIENT}/README.md`, `/${CLIENT}/client.ts`])
  t.assert.equal(vfs.readText(`/${CLIENT}/client.ts`), 'old\n', 'a copy is written, not the Vfs given')
  await t.assert.rejects(build(project(workspace({ files: { [`${CLIENT}/README.md`]: 'mine\n' } })), { generate: ['prisma'] }), /^Error: prisma: \/packages\/b\/src\/generated\/prisma exists and is not empty but doesn't look like a generated Prisma Client$/u)
})

test('generate is checked before anything is fetched', async (t) => {
  await t.assert.rejects(build(project(workspace()), { generate: ['nope'] }), /^TypeError: buildVfsBundle: generate must be an array of 'prisma'$/u)
  await t.assert.rejects(build(project(workspace()), { generate: 'prisma' }), /^TypeError: buildVfsBundle: generate must be an array of 'prisma'$/u)
  const client = fakeClient({ 'foundry.toml': '[profile.default]\n', 'soldeer.lock': 'dependencies = []\n', 'src/A.sol': '' })
  await t.assert.rejects(buildGitHubBundle({ github: 'ExodusOSS/example', sha: 'a'.repeat(40), client, packageManager: 'soldeer', entries: ['src/A.sol'], generate: ['prisma'] }), /^Error: buildGitHubBundle: --generate is only valid for JS bundles$/u)
  t.assert.deepStrictEqual(client.calls, [])
})

test('github-bundle --generate=prisma bundles the clients of the repo it fetches', async (t) => {
  const client = fakeClient(workspace())
  const tmp = await mkdtemp(join(tmpdir(), 'stasis-prisma-'))
  t.after(() => rm(tmp, { recursive: true, force: true }))
  t.mock.method(console, 'warn', () => {})
  await githubBundleCommand({ cwd: tmp, github: 'ExodusOSS/example', sha: 'a'.repeat(40), directory: 'packages/a', packageManager: 'pnpm', client, entries: ['index.ts'], generate: ['prisma'], output: 'out.br' })
  const bundle = Bundle.parse(brotliDecompressSync(await readFile(join(tmp, 'out.br'))).toString('utf8'))
  t.assert.ok(bundle.sources.has(`${CLIENT}/internal/class.ts`))
  t.assert.deepStrictEqual({ ...bundle.repo }, { github: 'ExodusOSS/example', directory: '', commit: 'a'.repeat(40) })
})

// `prisma` and `@prisma/client` as published, 7.9.0, in a cache store of the test's, which records
// the tarballs it is asked for; and a project depending on them, as `packageManager` locks it.
const PUBLISHED = await Promise.all([
  ['prisma', {}, {}],
  ['@prisma/client', Object.fromEntries(Object.entries(workspace()).filter(([path]) => path.startsWith('vendor/client/runtime/')).map(([path, body]) => [path.slice('vendor/client/'.length), body])), { exports: { './runtime/client': './runtime/client.js', './runtime/*': './runtime/*' } }],
].map(async ([name, files, manifest]) => {
  const all = { 'package.json': json({ name, version: '7.9.0', ...manifest }), ...files }
  const tarball = await compress(pack(Object.entries(all).map(([path, body]) => ({ name: `package/${path}`, data: new TextEncoder().encode(body), mode: 0o644 }))), 'gzip')
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  const resolved = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-7.9.0.tgz`
  return { name, tarball, integrity, resolved, document: { name, version: '7.9.0', dist: { tarball: resolved, integrity } } }
}))
const registry = () => {
  const asked = []
  const kept = new Map(PUBLISHED.flatMap(({ name, tarball, document }) => [[`npm/tarballs ${name}@7.9.0`, tarball], [`npm/versions ${name}@7.9.0`, document]]))
  return { asked, read: async (type, key) => { if (type === 'npm/tarballs') asked.push(key); return kept.get(`${type} ${key}`) }, write: async () => {} }
}
const PUBLISHED_LOCKS = {
  pnpm: ['pnpm-lock.yaml', [
    "lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '  excludeLinksFromLockfile: false', '',
    'importers:', '', '  .:', '    dependencies:', "      '@prisma/client':", '        specifier: 7.9.0', '        version: 7.9.0', '    devDependencies:', '      prisma:', '        specifier: 7.9.0', '        version: 7.9.0', '',
    'packages:', '', ...PUBLISHED.flatMap(({ name, integrity }) => [`  '${name}@7.9.0':`, `    resolution: {integrity: ${integrity}}`, '']),
    'snapshots:', '', ...PUBLISHED.flatMap(({ name }) => [`  '${name}@7.9.0': {}`, '']),
  ].join('\n')],
  npm: ['package-lock.json', `${JSON.stringify({
    name: 'p', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {
      '': { name: 'p', version: '1.0.0', dependencies: { '@prisma/client': '7.9.0' }, devDependencies: { prisma: '7.9.0' } },
      ...Object.fromEntries(PUBLISHED.map(({ name, integrity, resolved }) => [`node_modules/${name}`, { version: '7.9.0', resolved, integrity, ...name === 'prisma' ? { dev: true } : {} }])),
    },
  }, null, 2)}\n`],
}
const publishedFiles = (packageManager) => ({
  'package.json': json({ name: 'p', version: '1.0.0', type: 'module', dependencies: { '@prisma/client': '7.9.0' }, devDependencies: { prisma: '7.9.0' } }),
  [PUBLISHED_LOCKS[packageManager][0]]: PUBLISHED_LOCKS[packageManager][1],
  // A generator stasis doesn't generate for, which says so once.
  'prisma/schema.prisma': `${schema()}\ngenerator js {\n  provider = "prisma-client-js"\n}\n`,
  'src/index.ts': "export { PrismaClient } from './generated/prisma/client.ts'\n",
})
const publishedProject = (packageManager) => project(publishedFiles(packageManager))
// A pnpm build of the published project's files, src/index.ts its entry, through a registry() cache of its own:
// -> { built, asked }, the tarballs it fetched.
const buildPublished = async (files, options = {}) => {
  const cache = registry()
  return { built: await buildVfsBundle({ vfs: project(files), packageManager: 'pnpm', entries: ['src/index.ts'], cache, ...options }), asked: cache.asked }
}

test("given no generate, stasis.config.json's generatePrisma false writes none", async (t) => {
  const said = warnings(t)
  // In a project of its own: a stasis.config.json in a workspace package roots the bundle there.
  const published = (generatePrisma, options) => buildPublished({ ...publishedFiles('pnpm'), ...(generatePrisma === undefined ? {} : { 'stasis.config.json': json({ generatePrisma }) }) }, options)
  for (const generatePrisma of [undefined, true]) t.assert.ok((await published(generatePrisma)).built.bundle.sources.has('src/generated/prisma/client.ts'))
  await t.assert.rejects(published(false), /unresolved export-from \.\/generated\/prisma\/client\.ts from src\/index\.ts \(MODULE_NOT_FOUND\)$/u)
  // Asked for where the config says not, or a generatePrisma that is no boolean: refused.
  await t.assert.rejects(published(false, { generate: ['prisma'] }), /^Error: buildVfsBundle: generate is given, and stasis\.config\.json's generatePrisma is false$/u)
  await t.assert.rejects(published('no'), /^TypeError: stasis\.config\.json: generatePrisma must be true or false, got "no"$/u)
  t.assert.deepStrictEqual(said(), [])
})

for (const packageManager of ['pnpm', 'npm']) {
  test(`${packageManager}: --generate=prisma over a lazy tree bundles the client of the prisma it fetches, as the full tree does`, async (t) => {
    const of = async (lazy) => {
      const cache = registry()
      const { result, warnings: said } = await captureWarningsAsync(() => buildVfsBundle({ vfs: publishedProject(packageManager), packageManager, entries: ['src/index.ts'], generate: ['prisma'], cache, lazy }))
      return { ...result, said, asked: cache.asked.toSorted() }
    }
    const full = await of(false)
    const lazy = await of(true)
    t.assert.ok(lazy.bundle.sources.has('src/generated/prisma/internal/class.ts'))
    t.assert.match(text(lazy.bundle, 'src/generated/prisma/internal/class.ts'), /"clientVersion": "7\.9\.0",/u)
    t.assert.equal(lazy.bundle.serialize(), full.bundle.serialize())
    t.assert.equal(lazy.lockfile.serialize(), full.lockfile.serialize())
    // Not the round that read no prisma yet.
    t.assert.deepStrictEqual(lazy.said, ["[stasis] prisma: not generating /prisma/schema.prisma's generator js: stasis generates the \"prisma-client\" provider's alone"])
    t.assert.deepStrictEqual(lazy.said, full.said)
    t.assert.deepStrictEqual(lazy.asked, ['@prisma/client@7.9.0', 'prisma@7.9.0'])
  })
}

test('a lazy tree fetches the prisma of a project with a schema alone', async (t) => {
  const { 'prisma/schema.prisma': _, ...files } = { ...publishedFiles('pnpm'), 'src/index.ts': 'export {}\n' }
  for (const generate of [undefined, ['prisma']]) t.assert.deepStrictEqual((await buildPublished(files, { lazy: true, generate })).asked, [], `generate: ${JSON.stringify(generate)}`)
  t.assert.deepStrictEqual((await buildPublished({ ...files, 'prisma/schema.prisma': schema() }, { lazy: true })).asked, ['prisma@7.9.0'])
})
