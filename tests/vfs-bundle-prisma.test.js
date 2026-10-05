import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { githubBundleCommand } from '../stasis/src/cmd/github-bundle.js'
import { Vfs, buildGitHubBundle, buildVfsBundle, createVfsHost } from '../stasis/src/vfs-bundle.js'
import { generatePrismaClients, withPrismaClients } from '../stasis/src/vfs-bundle/prisma.js'
import { fakeClient, json } from './vfs-bundle-github.helper.js'

/* eslint-disable no-await-in-loop -- each case waits on its own build, in order, its warnings read after it */

// buildVfsBundle's `generate: ['prisma']` (github-bundle's --generate=prisma) over a pnpm workspace
// held in a Vfs, whose `prisma` and `@prisma/client` are stand-ins linked from vendor/: nothing is
// fetched, and nothing of the project runs. That each client is the one its Prisma writes, byte for
// byte, is prisma-generate.test.js's to say.

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
// What console.warn says from here on, as a function of the warnings so far.
const warnings = (t) => {
  const warn = t.mock.method(console, 'warn', () => {})
  return () => warn.mock.calls.map((call) => call.arguments[0])
}

test('--generate=prisma bundles the client `prisma generate` writes, which the tree never holds', async (t) => {
  const vfs = project(workspace())
  await t.assert.rejects(build(vfs), /generated\/prisma\/client\.ts/u)
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

// generatePrismaClients over a project read through `host` alone, Prisma `version` installed.
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
  const said = warnings(t)
  t.assert.deepStrictEqual(await clients({ 'prisma/schema.prisma': schema().replace('"../src/generated/prisma"', 'env("OUT")') }), [])
  t.assert.match(said().at(-1), /its output is env\("OUT"\), which stasis doesn't read$/u)
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
  t.assert.deepStrictEqual({ ...bundle.repo }, { github: 'ExodusOSS/example', root: true, commit: 'a'.repeat(40) })
})
