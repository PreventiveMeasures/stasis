import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, posix } from 'node:path'
import { compileFunction } from 'node:vm'

import { readJson } from '@exodus/stasis-core/bundle-util'
import { hasNodeModulesSegment } from '@exodus/stasis-core/util'
import { createVfs } from '@preventive/vfs'
import { isDir, isFile, loadTsconfigCompilerOptions } from '../resolve-typescript.js'
import { literalSpec, syntaxErrors } from '../scan.js'
import { holding, nearest } from './tree.js'

// buildVfsBundle's `generate: ['prisma']`: the Prisma Client each project's `prisma generate` would
// write, as the `prisma-client` generator of the Prisma it installs (7.4.0 to 7.10.0) writes it. The
// repo's own Prisma is never run, nor anything else of it: its schema, the `schema` path its Prisma
// config names, and the tsconfig.json and package.json the generator infers from are read from the
// tree as data, its installed `prisma` only for its version. What runs is the optional peer
// @prisma/client-generator-ts at 7.10.0 (GENERATOR_VERSION), on the host; another version's client
// is 7.10.0's rewritten as that version writes it (DOWN), each byte of every client tested against
// that version's own `prisma generate`. The client is built in memory, nothing written to disk. A
// client for an edge runtime carries the query compiler's .wasm and its .mjs bindings as the repo's
// `prisma` ships them, copied from the tree as `prisma generate` copies them from its own build.

const GENERATOR = '@prisma/client-generator-ts'
const GENERATOR_VERSION = '7.10.0'
const PROVIDER = 'prisma-client'

// The Query Engine version each Prisma stamps its client with.
const ENGINES = {
  '7.10.0': '0edf323efd1d98336f3f0a68684b56f689b900d3',
  '7.9.1': 'e922089b7d7502aff4249d5da3420f6fa55fc6ad',
  '7.9.0': 'e922089b7d7502aff4249d5da3420f6fa55fc6ad',
  '7.8.0': '3c6e192761c0362d496ed980de936e2f3cebcd3a',
  '7.7.0': '75cbdc1eb7150937890ad5465d861175c6624711',
  '7.6.0': '75cbdc1eb7150937890ad5465d861175c6624711',
  '7.5.0': '280c870be64f457428992c43c1f6d557fab6e29e',
  '7.4.2': '94a226be1cf2967af2541cca5529f0f7ba866919',
  '7.4.1': '55ae170b1ced7fc6ed07a15f110549408c501bb3',
  '7.4.0': 'ab56fe763f921d033a6c195e7ddeb3e255bdbb57',
}

// The Prisma versions generated for, newest first.
export const PRISMA_VERSIONS = Object.keys(ENGINES)

const newerThan = (version, than) => PRISMA_VERSIONS.indexOf(version) < PRISMA_VERSIONS.indexOf(than)

const require = createRequire(import.meta.url)

// --- the generator ---

let loaded

// Where buildClient reads the query compiler from for the client it builds now (generateClientFor
// sets it about that one call, which runs to its end before another starts).
let compilerSource = null

// The `node:fs` of the peer's bundle, through which buildClient reads nothing but the query compiler
// an edge runtime's client carries, from beside the bundle, as `prisma generate` reads it from its
// own build: here, from the tree's `prisma`'s build (compilerSource).
const peerFs = {
  existsSync: () => true,
  readFileSync(path) {
    const { host, build, target } = compilerSource
    const file = posix.join(build, basename(path))
    if (!isFile(file, host)) throw new Error(`prisma: ${file}, which a ${target} client carries, is not in the tree`)
    return Buffer.from(host.readFile(file))
  },
}

// The optional peer, loaded once: buildClient, which builds a client's files in memory (where its
// generateClient writes them to disk), and validateDmmfAgainstDenylists, which generateClient checks
// the schema with; and the @prisma/internals (with its @prisma/schema-files-loader) it was built
// with. Its bundle exports neither function, so it is run as Node runs it, with the two exported in
// place of its own exports, and peerFs as the `node:fs` it requires.
function loadGenerator() {
  if (loaded) return loaded
  let main
  try {
    main = require.resolve(GENERATOR)
  } catch (cause) {
    throw new Error(`--generate=prisma needs the optional '${GENERATOR}' ${GENERATOR_VERSION} dependency; install it (e.g. \`npm i ${GENERATOR}@${GENERATOR_VERSION}\`)`, { cause })
  }
  const own = createRequire(main)
  const { version } = own('../package.json')
  if (version !== GENERATOR_VERSION) throw new Error(`--generate=prisma needs ${GENERATOR} ${GENERATOR_VERSION}, not ${version}`)
  const peer = { exports: {} }
  const source = `${readFileSync(main, 'utf8')}\nmodule.exports = { buildClient, validateDmmfAgainstDenylists }\n`
  const run = compileFunction(source, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: main })
  run.call(peer.exports, peer.exports, (id) => (id === 'node:fs' ? peerFs : own(id)), peer, main, dirname(main))
  const schemaFiles = createRequire(own.resolve('@prisma/internals'))('@prisma/schema-files-loader')
  loaded = { ...peer.exports, internals: own('@prisma/internals'), schemaFiles }
  return loaded
}

// --- what `prisma generate` reads ---

// The file at `name` in `dir` or the nearest of its ancestors holding one, or null.
const nearestFile = (host, dir, name) => {
  const at = nearest(dir, holding(host, name))
  return at === null ? null : posix.join(at, name)
}

// The Prisma whose `prisma generate` the project at `dir` runs, as Node finds it from there, and its
// version; or null where none is installed: its `prisma`, or where that is no version generated for
// (Prisma 8, say), the `prisma` of its `@prisma/prisma7`, which runs that one as `prisma7` beside it.
function installedPrisma(host, dir) {
  const installed = (from) => {
    const file = nearestFile(host, from, 'node_modules/prisma/package.json')
    return file === null ? null : { file, version: readJson(file, host)?.version }
  }
  const prisma = installed(dir)
  if (PRISMA_VERSIONS.includes(prisma?.version)) return prisma
  const prisma7 = nearestFile(host, dir, 'node_modules/@prisma/prisma7/package.json')
  const beside = prisma7 === null ? null : installed(host.realpath(posix.dirname(prisma7)))
  return PRISMA_VERSIONS.includes(beside?.version) ? beside : prisma
}

// Where @prisma/config looks for a project's config, in order: 7.10.0 tries `prisma7.config.*`
// first, which no Prisma before it reads.
const CONFIG_EXTENSIONS = ['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts']
const withExtensions = (bases) => bases.flatMap((base) => CONFIG_EXTENSIONS.map((ext) => `${base}${ext}`))
const PRISMA7_CONFIGS = withExtensions(['prisma7.config', '.config/prisma7'])
const LEGACY_CONFIGS = withExtensions(['prisma.config', '.config/prisma', '.config/prisma.config'].flatMap((base) => [base, `${base}/index`]))
const configsOf = (version) => (newerThan(version, '7.9.1') ? [...PRISMA7_CONFIGS, ...LEGACY_CONFIGS] : LEGACY_CONFIGS)

// What a config's imports and requires may bind a name to, by module and by what is imported (`*`
// for the module itself): Node's path module or its join, or Prisma's defineConfig.
const BINDINGS = {
  path: { '*': 'path', join: 'join' },
  'node:path': { '*': 'path', join: 'join' },
  'prisma/config': { defineConfig: 'defineConfig' },
  '@prisma/config': { defineConfig: 'defineConfig' },
}
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'])

// The `schema` a Prisma config names, read without running it: the object its default export (or
// module.exports) is, through Prisma's defineConfig(), whose `schema` is a string it spells out: a
// literal, or Node's path.join of them; each through `as`, `satisfies`, parentheses and top-level
// consts; undefined where it names none. Only names the config binds by its top-level imports and
// requires are taken for path, join or defineConfig. Nothing of the config is run, nor any code
// built from it: its syntax tree is read, and a join is posix.join over the strings it spells.
// Anything else is code stasis won't run, refused.
function configSchema(file, text) {
  const lang = /\.[cm]?ts$/u.test(file) ? 'ts' : 'js'
  const parsed = require('oxc-parser').parseSync(file, text, { lang, sourceType: 'unambiguous' })
  const [error] = syntaxErrors(parsed)
  if (error) throw new Error(`${file}: ${error.message}`)
  const refuse = (what) => new Error(`${file}: ${what}, which stasis reads without running the config`)
  const consts = new Map()
  const bound = new Map()
  const bind = (from, name, local) => {
    const as = BINDINGS[from]?.[name]
    if (as) bound.set(local, as)
  }
  // The module a `require('...')` names, or null.
  const required = (node) => (node?.type === 'CallExpression' && node.callee.name === 'require' && node.arguments.length === 1 ? literalSpec(node.arguments[0]) : null)
  let config
  for (const node of parsed.program.body) {
    if (node.type === 'ExportDefaultDeclaration') config = node.declaration
    else if (node.type === 'ImportDeclaration') {
      for (const { type, imported, local } of node.specifiers) bind(node.source.value, type === 'ImportSpecifier' ? imported.name ?? imported.value : '*', local.name)
    } else if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      for (const { id, init } of node.declarations) {
        const from = required(init)
        if (from === null) {
          if (id.type === 'Identifier' && init) consts.set(id.name, init)
        } else if (id.type === 'Identifier') {
          bind(from, '*', id.name)
        } else if (id.type === 'ObjectPattern') {
          for (const { type, computed, key, value } of id.properties) if (type === 'Property' && !computed && value.type === 'Identifier') bind(from, key.name, value.name)
        }
      }
    } else if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression') {
      const { left, right } = node.expression
      if (left.type === 'MemberExpression' && left.object.name === 'module' && left.property.name === 'exports') config = right
    }
  }
  if (config === undefined) throw refuse('no default export')
  // `node` through what doesn't change its value, each const once.
  const peel = (node, seen = new Set()) => {
    if (WRAPPERS.has(node.type)) return peel(node.expression, seen)
    if (node.type === 'Identifier' && consts.has(node.name) && !seen.has(node.name)) return peel(consts.get(node.name), seen.add(node.name))
    return node
  }
  config = peel(config)
  if (config.type === 'CallExpression' && bound.get(config.callee.name) === 'defineConfig' && config.arguments.length === 1) config = peel(config.arguments[0])
  if (config.type !== 'ObjectExpression') throw refuse('its default export is no object literal')
  const spelled = (node) => {
    node = peel(node)
    const literal = literalSpec(node)
    if (literal !== null) return literal
    const { type, callee } = node
    const isJoin = type === 'CallExpression' && (bound.get(callee.name) === 'join' || (callee.type === 'MemberExpression' && !callee.computed && bound.get(callee.object.name) === 'path' && callee.property.name === 'join'))
    if (isJoin) return posix.join(...node.arguments.map(spelled))
    throw refuse('its `schema` is no string literal, nor path.join of them')
  }
  let schema
  for (const property of config.properties) {
    // A spread or a computed key may name a schema stasis can't see.
    if (property.type !== 'Property' || property.computed) throw refuse('its config spreads or computes a key')
    if ((property.key.type === 'Identifier' ? property.key.name : property.key.value) === 'schema') schema = spelled(property.value)
  }
  return schema
}

// The schema files `path` holds, as [path, text], as `prisma generate` reads them: the file itself,
// or the .prisma files @prisma/schema-files-loader (the peer's own) loads from the directory, read
// from the tree through `host`.
function schemaFilesAt(host, path) {
  if (isFile(path, host)) return [[path, host.readFile(path).toString('utf8')]]
  return loadGenerator().schemaFiles.loadSchemaFiles(path, {
    listDirContents: async (dir) => host.readdir(dir).map((entry) => entry.name),
    async getEntryType(at) {
      if (host.readlink(at) !== null) return { kind: 'symlink', realPath: host.realpath(at) }
      const stat = host.stat(at)
      if (stat?.isDirectory()) return { kind: 'directory', realPath: host.realpath(at) }
      return stat?.isFile() ? { kind: 'file' } : { kind: 'other' }
    },
    getFileContents: async (file) => host.readFile(file).toString('utf8'),
  })
}

// The schema `prisma generate` reads for the project at `dir` with Prisma `version`, as schema files
// and the path it was given, or null where there is none: the one its config names, relative to the
// config, else ./schema.prisma or ./prisma/schema.prisma.
async function projectSchema(host, dir, version) {
  const config = configsOf(version).map((name) => posix.join(dir, name)).find((file) => isFile(file, host))
  const named = config === undefined ? undefined : configSchema(config, host.readFile(config).toString('utf8'))
  let path
  if (named === undefined) {
    path = ['schema.prisma', 'prisma/schema.prisma'].map((name) => posix.join(dir, name)).find((file) => isFile(file, host))
    if (path === undefined) return null
  } else {
    path = posix.resolve(posix.dirname(config), named)
    if (!isFile(path, host) && !isDir(path, host)) throw new Error(`${config}: its schema ${named} is no file or directory`)
  }
  return { path, files: await schemaFilesAt(host, path) }
}

// get-tsconfig 4.10's normalizeCompilerOptions as far as the generator reads its result: each of
// target, module and moduleResolution lowercased (es2015 as es6, node as node10), and the module and
// moduleResolution a target or module implies where none is given, the target's first.
const CLASSIC_TARGETS = new Set(['es6', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020', 'es2021', 'es2022', 'es2023', 'es2024', 'esnext'])
const CLASSIC_MODULES = new Set(['es6', 'es2020', 'es2022', 'esnext', 'none', 'system', 'umd', 'amd'])
const IMPLIED_RESOLUTION = { node16: 'node16', nodenext: 'nodenext', preserve: 'bundler' }
const lower = (value, alias) => (value.toLowerCase() === alias[0] ? alias[1] : value.toLowerCase())
function normalizeCompilerOptions(options) {
  const o = { ...options }
  if (o.target) {
    o.target = lower(o.target, ['es2015', 'es6'])
    if (CLASSIC_TARGETS.has(o.target)) {
      o.module ??= 'es6'
      o.moduleResolution ??= 'classic'
    }
  }
  if (o.module) {
    o.module = lower(o.module, ['es2015', 'es6'])
    o.moduleResolution ??= CLASSIC_MODULES.has(o.module) ? 'classic' : IMPLIED_RESOLUTION[o.module]
  }
  if (o.moduleResolution) o.moduleResolution = lower(o.moduleResolution, ['node', 'node10'])
  return o
}

// The compilerOptions of the tsconfig.json nearest `dir` (get-tsconfig's getTsconfig), or undefined.
function tsconfigOptions(host, dir) {
  const file = nearestFile(host, dir, 'tsconfig.json')
  return file === null ? undefined : normalizeCompilerOptions(loadTsconfigCompilerOptions(file, host))
}

// The module format the `type` of the package.json nearest `dir` (package-up's) says: cjs without
// one, or where it can't be read.
function nearestPackageFormat(host, dir) {
  const file = nearestFile(host, dir, 'package.json')
  return file !== null && readJson(file, host)?.type === 'module' ? 'esm' : 'cjs'
}

// --- the generator's options, as its generate() takes them from the schema and infers the rest ---
// (the same in each version but for one change, in inferModuleFormat)

const RUNTIMES = { workerd: 'workerd', cloudflare: 'workerd', 'edge-light': 'vercel-edge', 'vercel-edge': 'vercel-edge', nodejs: 'nodejs', bun: 'nodejs', deno: 'deno' }
const GENERATED_EXTENSIONS = ['ts', 'mts', 'cts']
const IMPORT_EXTENSIONS = ['', 'ts', 'mts', 'cts', 'js', 'mjs', 'cjs']
const JS_EXTENSIONS = { ts: 'js', mts: 'mjs', cts: 'cjs' }

function parseRuntime(value) {
  if (typeof value !== 'string') throw new Error(`Invalid target runtime: ${JSON.stringify(value)}. Expected a string.`)
  const runtime = RUNTIMES[value.toLowerCase()]
  if (runtime === undefined) throw new Error(`Unknown target runtime: "${value}". The available options are: "nodejs", "deno", "bun", "workerd", "cloudflare", "vercel-edge", "edge-light"`)
  return runtime
}

function parseExtension(value, kind, expected) {
  if (typeof value !== 'string') throw new Error(`Invalid ${kind} file extension: ${JSON.stringify(value)}, expected a string`)
  if (!expected.includes(value)) console.warn(`[stasis] prisma: ${kind[0].toUpperCase()}${kind.slice(1)} file extension ${JSON.stringify(value)} is unexpected and may be a mistake. Expected one of: ${expected.map((ext) => JSON.stringify(ext)).join(', ')}`)
  return value
}

function parseModuleFormat(value) {
  const format = typeof value === 'string' ? { cjs: 'cjs', commonjs: 'cjs', esm: 'esm' }[value.toLowerCase()] : undefined
  if (format === undefined) throw new Error(`Invalid module format: ${typeof value === 'string' ? `"${value}"` : JSON.stringify(value)}, expected "esm" or "cjs"`)
  return format
}

function inferImportFileExtension(tsconfig, generatedFileExtension, target) {
  if (target === 'deno' || tsconfig === undefined) return generatedFileExtension
  if (tsconfig.allowImportingTsExtensions || tsconfig.rewriteRelativeImportExtensions) return generatedFileExtension
  if (tsconfig.module === 'commonjs' || tsconfig.moduleResolution === 'bundler') return ''
  return JS_EXTENSIONS[generatedFileExtension] ?? generatedFileExtension
}

// From 7.10.0 on, a node16 or nodenext module takes the nearest package.json's type; before, ESM.
function inferModuleFormat({ tsconfig, generatedFileExtension, importFileExtension, outputDir, version, host }) {
  if (tsconfig?.module) {
    if (tsconfig.module === 'commonjs') return 'cjs'
    if (newerThan(version, '7.9.1') && (tsconfig.module === 'node16' || tsconfig.module === 'nodenext')) return nearestPackageFormat(host, outputDir)
    return 'esm'
  }
  return generatedFileExtension === 'cts' || importFileExtension === 'cjs' ? 'cjs' : 'esm'
}

function generatorOptions(config, { outputDir, version, host }) {
  const tsconfig = tsconfigOptions(host, outputDir)
  const target = config.runtime === undefined ? 'nodejs' : parseRuntime(config.runtime)
  const generatedFileExtension = config.generatedFileExtension === undefined ? 'ts' : parseExtension(config.generatedFileExtension, 'generated', GENERATED_EXTENSIONS)
  const importFileExtension = config.importFileExtension === undefined ? inferImportFileExtension(tsconfig, generatedFileExtension, target) : parseExtension(config.importFileExtension, 'import', IMPORT_EXTENSIONS)
  const moduleFormat = config.moduleFormat === undefined ? inferModuleFormat({ tsconfig, generatedFileExtension, importFileExtension, outputDir, version, host }) : parseModuleFormat(config.moduleFormat)
  const compilerBuild = config.compilerBuild ?? (target === 'vercel-edge' ? 'small' : 'fast')
  if (compilerBuild !== 'small' && compilerBuild !== 'fast') throw new Error(`Invalid compiler build: ${JSON.stringify(compilerBuild)}, expected one of: "fast", "small"`)
  return { target, generatedFileExtension, importFileExtension, moduleFormat, compilerBuild }
}

// --- 7.10.0's client as each older version writes it ---

// `text` with `from` replaced by `to`, each time if `all`, where it is there at all; else `null`
// where `optional`, or a refusal: 7.10.0's client is not the one these steps were written against.
function swap(text, from, to, { path, all = false, optional = false }) {
  if (!text.includes(from)) {
    if (optional) return null
    throw new Error(`prisma: ${path} of the ${GENERATOR_VERSION} client holds no ${JSON.stringify(from.slice(0, 80))}`)
  }
  return all ? text.replaceAll(from, () => to) : text.replace(from, () => to)
}

const lines = (...rows) => rows.join('\n')

// Where a client's files are, by their names without the generated extension.
const CLIENT = 'client'
const CLASS = 'internal/class'
const NAMESPACE = 'internal/prismaNamespace'

// 7.10.0 adds the `schema` of each model to the runtime data model.
function dropModelSchemas(text, path) {
  const match = /^config\.runtimeDataModel = JSON\.parse\((".*")\)$/mu.exec(text)
  if (match === null) throw new Error(`prisma: ${path} of the ${GENERATOR_VERSION} client holds no runtimeDataModel`)
  const model = JSON.parse(JSON.parse(match[1]))
  // Written back as it was read, or this rewrite is not the generator's own serialization.
  if (JSON.stringify(JSON.stringify(model)) !== match[1]) throw new Error(`prisma: ${path}: the runtimeDataModel does not serialize back as written`)
  for (const each of Object.values(model.models)) delete each.schema
  return text.replace(match[0], () => `config.runtimeDataModel = JSON.parse(${JSON.stringify(JSON.stringify(model))})`)
}

// 7.9.0's constructor argument type, its PrismaClientOptions split into interfaces, and its XOR.
const CONSTRUCTOR_ARGS = lines(
  '/**',
  ' * Resolved type of the argument passed to the `PrismaClient` constructor.',
  ' *',
  ' * When called without a narrower options type (the common case), this resolves',
  ' * to `PrismaClientOptions` directly, which produces a clear TypeScript error',
  ' * message (`not assignable to parameter of type \'PrismaClientOptions\'`) when',
  ' * the argument is missing or incomplete. When the user supplies a narrower',
  ' * options type (e.g. via a literal), it falls back to `Subset` to keep',
  ' * filtering out unknown properties.',
  ' */',
  'export type PrismaClientConstructorArgs<Options extends PrismaClientOptions> =',
  '  [PrismaClientOptions] extends [Options] ? PrismaClientOptions : Subset<Options, PrismaClientOptions>;',
  '',
  '',
)
const BASE_OPTIONS = lines(
  '/**',
  ' * Options common to all variants of `PrismaClientOptions`, regardless of whether you connect to your database through a driver adapter or through Prisma Accelerate.',
  ' */',
  'export interface PrismaClientBaseOptions {',
)
const UNION_OPTIONS = lines(
  'export type PrismaClientOptions = ({',
  '  /**',
  '   * Instance of a Driver Adapter, e.g., like one provided by `@prisma/adapter-pg`.',
  '   */',
  '  adapter: runtime.SqlDriverAdapterFactory',
  '  accelerateUrl?: never',
  '} | {',
  '  /**',
  '   * Prisma Accelerate URL allowing the client to connect through Accelerate instead of a direct database.',
  '   */',
  '  accelerateUrl: string',
  '  adapter?: never',
  '}) & {',
)
const OPTION_VARIANTS = lines(
  '',
  '',
  '/**',
  ' * `PrismaClient` options for connecting to your database through Prisma Accelerate instead of a driver adapter.',
  ' * ',
  ' * Learn more: https://pris.ly/d/accelerate',
  ' */',
  'export interface PrismaClientOptionsWithAccelerateUrl extends PrismaClientBaseOptions {',
  '  /**',
  '   * The Prisma Accelerate connection URL. Use this option to connect to your database through Prisma Accelerate instead of using a driver adapter to connect directly.',
  '   * ',
  '   * Learn more: https://pris.ly/d/accelerate',
  '   */',
  '  accelerateUrl: string',
  '  adapter?: never',
  '}',
  '',
  '/**',
  ' * `PrismaClient` options for connecting to your database through a driver adapter. This is the common case in Prisma 7.',
  ' * ',
  ' * Learn more: https://pris.ly/d/driver-adapters',
  ' */',
  'export interface PrismaClientOptionsWithAdapter extends PrismaClientBaseOptions {',
  '  /**',
  '   * A driver adapter that PrismaClient uses to connect to your database, such as the ones provided by `@prisma/adapter-pg`, `@prisma/adapter-libsql`, `@prisma/adapter-planetscale`, etc.',
  '   * ',
  '   * A driver adapter is **required** unless you connect to your database through Prisma Accelerate (in which case use `accelerateUrl` instead).',
  '   * ',
  '   * Learn more: https://pris.ly/d/driver-adapters',
  '   * ',
  '   * @example',
  '   * ```ts',
  '   * import { PrismaPg } from \'@prisma/adapter-pg\'',
  '   * import { PrismaClient } from \'./generated/prisma/client\'',
  '   * ',
  '   * const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })',
  '   * const prisma = new PrismaClient({ adapter })',
  '   * ```',
  '   */',
  '  adapter: runtime.SqlDriverAdapterFactory',
  '  accelerateUrl?: never',
  '}',
  '',
  '/**',
  ' * Options passed to the `PrismaClient` constructor.',
  ' * ',
  ' * A driver adapter (or, alternatively, a Prisma Accelerate URL) is **required**. See {@link PrismaClientOptionsWithAdapter} and {@link PrismaClientOptionsWithAccelerateUrl} for the two variants. All other properties live in {@link PrismaClientBaseOptions} and are optional.',
  ' * ',
  ' * Learn more about driver adapters: https://pris.ly/d/driver-adapters',
  ' */',
  'export type PrismaClientOptions = PrismaClientOptionsWithAccelerateUrl | PrismaClientOptionsWithAdapter',
)

// 7.8.0's query plan cache option, which 7.7.0 doesn't have.
const QUERY_PLAN_CACHE = lines(
  '  /**',
  '   * Optional maximum size for the query plan cache. If not provided, a default size will be used.',
  '   * A value of `0` can be used to disable the cache entirely. A higher cache size can improve',
  '   * performance for applications that execute a large number of unique queries, while a smaller',
  '   * cache size can reduce memory usage.',
  '   * ',
  '   * @example',
  '   * ```',
  '   * const prisma = new PrismaClient({',
  '   *   adapter,',
  '   *   queryPlanCacheMaxSize: 100,',
  '   * })',
  '   * ```',
  '   */',
  '  queryPlanCacheMaxSize?: number',
  '',
)
const TRANSACTION = '  $transaction<P extends Prisma.PrismaPromise<any>[]>(arg: [...P]'

// 7.5.0's distinct doc on each model's FindManyArgs, which 7.4.2 has on FindFirst(OrThrow)Args alone.
function dropFindManyDistinctDocs(text) {
  const rows = text.split('\n')
  const out = []
  let inFindMany = false
  for (let i = 0; i < rows.length; i++) {
    if (/^export type \w+FindManyArgs<.* = \{$/u.test(rows[i])) inFindMany = true
    else if (rows[i] === '}') inFindMany = false
    const doc = inFindMany && rows[i] === '  /**' && rows[i + 1] === '   * {@link https://www.prisma.io/docs/concepts/components/prisma-client/distinct Distinct Docs}'
      && rows[i + 2] === '   * ' && rows[i + 3]?.startsWith('   * Filter by unique combinations of ') && rows[i + 4] === '   */' && rows[i + 5]?.startsWith('  distinct?: ')
    if (doc) i += 4
    else out.push(rows[i])
  }
  return out.join('\n')
}

// Each version's client from the next newer one's, for each version whose client differs from it
// but in the version stamps (asVersion's): by the name of each file it rewrites without the generated
// extension, or MODELS for each of models/, `(text, path) => text`.
const MODELS = 'models/*'
const example = (indent) => [`${indent}* const prisma = new PrismaClient({\n${indent}*   adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL })\n${indent}* })\n`, `${indent}* const prisma = new PrismaClient()\n`]
const DOWN = {
  '7.9.1': { [CLASS]: dropModelSchemas },
  '7.8.0': {
    [CLASS]: (text, path) => {
      text = swap(text, '>(options: Prisma.PrismaClientConstructorArgs<Options>): PrismaClient<', '>(options: Prisma.Subset<Options, Prisma.PrismaClientOptions> ): PrismaClient<', { path })
      return swap(text, "  in out OmitOpts extends Prisma.PrismaClientOptions['omit'] = Prisma.PrismaClientOptions['omit'],", "  in out OmitOpts extends Prisma.PrismaClientOptions['omit'] = undefined,", { path })
    },
    [NAMESPACE]: (text, path) => {
      text = swap(text, CONSTRUCTOR_ARGS, '', { path })
      text = swap(text, '    ((Without<T, U> & U) | (Without<U, T> & T)) & object\n', '    (Without<T, U> & U) | (Without<U, T> & T)\n', { path })
      text = swap(text, BASE_OPTIONS, UNION_OPTIONS, { path })
      return swap(text, OPTION_VARIANTS, '', { path })
    },
  },
  '7.7.0': {
    // MongoDB's transactions take no isolation level.
    [CLASS]: (text, path) => swap(text, `${TRANSACTION}, options?: { maxWait?: number, timeout?: number, isolationLevel?: Prisma.TransactionIsolationLevel })`, `${TRANSACTION}, options?: { isolationLevel?: Prisma.TransactionIsolationLevel })`, { path, optional: true })
      ?? swap(text, `${TRANSACTION}, options?: { maxWait?: number, timeout?: number })`, `${TRANSACTION})`, { path }),
    [NAMESPACE]: (text, path) => swap(text, QUERY_PLAN_CACHE, '', { path }),
  },
  '7.5.0': { [MODELS]: (text) => text.replace(/^export (type Get(\w+)GroupByPayload<T extends \2GroupByArgs> = )/mu, '$1') },
  '7.4.2': {
    [MODELS]: dropFindManyDistinctDocs,
    // From 7.5.0, MongoDB's interactive transactions take no nested $transaction.
    [CLASS]: (text, path) => swap(text, 'Omit<PrismaClient, runtime.ITXClientDenyList | "$transaction">', 'Omit<PrismaClient, runtime.ITXClientDenyList>', { path, optional: true }) ?? text,
    [NAMESPACE]: (text, path) => swap(text, "Omit<DefaultPrismaClient, runtime.ITXClientDenyList | '$transaction'>", 'Omit<DefaultPrismaClient, runtime.ITXClientDenyList>', { path, optional: true }) ?? text,
  },
  '7.4.1': {
    [CLIENT]: (text, path) => swap(text, ...example(' '), { path, all: true }),
    [CLASS]: (text, path) => swap(swap(text, ...example(' '), { path, all: true }), ...example('   '), { path, all: true }),
  },
  '7.4.0': { [CLASS]: (text, path) => swap(text, 'https://www.prisma.io/docs/orm/prisma-client/queries/transactions', 'https://www.prisma.io/docs/concepts/components/prisma-client/transactions', { path }) },
}

// The lines each client stamps its version and engine into, by the file they are in.
const STAMPS = [
  [CLASS, (version) => `"clientVersion": "${version}",\n  "engineVersion": "${ENGINES[version]}",`],
  [NAMESPACE, (version) => ` * Prisma Client JS version: ${version}\n * Query Engine version: ${ENGINES[version]}\n`],
  [NAMESPACE, (version) => `  client: "${version}",\n  engine: "${ENGINES[version]}"\n`],
]

// `files` (path -> text, or bytes left as they are) of the 7.10.0 client as `version`'s, whose files
// are named with `extension`: each older version's rewrites in turn, down to it, and its stamps.
function asVersion(files, version, extension) {
  if (version === GENERATOR_VERSION) return files
  const steps = PRISMA_VERSIONS.slice(1, PRISMA_VERSIONS.indexOf(version) + 1).map((each) => DOWN[each]).filter(Boolean)
  for (const [path, text] of files) {
    if (typeof text !== 'string') continue
    const stem = path.slice(0, -extension.length - 1)
    const key = stem.startsWith('models/') ? MODELS : stem
    let out = text
    for (const step of steps) out = step[key]?.(out, path) ?? out
    for (const [where, stamp] of STAMPS) if (stem === where) out = swap(out, stamp(GENERATOR_VERSION), stamp(version), { path })
    files.set(path, out)
  }
  return files
}

// --- generating ---

// The client `generator` (a `prisma-client` one of `schema`) writes for Prisma `version`, installed
// at `prismaDir`, as a Map of its paths, from its output directory, to their text (bytes for the
// query compiler's .wasm): built as the peer's generateClient builds it before writing it to disk,
// with the options generatorOptions infers as it does.
function generateClientFor({ schema, datamodel, generator, dmmf, datasources, outputDir, version, prismaDir, host }) {
  const { buildClient, validateDmmfAgainstDenylists } = loadGenerator()
  const options = generatorOptions(generator.config, { outputDir, version, host })
  compilerSource = { host, build: posix.join(prismaDir, 'build'), target: options.target }
  let built
  try {
    built = buildClient({
      datamodel,
      schemaPath: schema.path,
      runtimeBase: '@prisma/client/runtime',
      outputDir,
      generator,
      dmmf,
      datasources,
      binaryPaths: {},
      engineVersion: ENGINES[GENERATOR_VERSION],
      clientVersion: GENERATOR_VERSION,
      activeProvider: datasources[0]?.activeProvider,
      tsNoCheckPreamble: true,
      ...options,
    })
  } finally {
    compilerSource = null
  }
  const denied = validateDmmfAgainstDenylists(built.prismaClientDmmf)
  if (denied) throw new Error(`prisma: ${schema.path} contains reserved keywords, to rename: ${denied.map((error) => error.message).join(', ')}`)
  // Its file map, whose directories are maps of their own.
  const files = new Map()
  const add = (map, at) => {
    for (const [name, content] of Object.entries(map)) {
      if (typeof content === 'string' || Buffer.isBuffer(content)) files.set(at + name, content)
      else add(content, `${at}${name}/`)
    }
  }
  add(built.fileMap, '')
  return asVersion(files, version, options.generatedFileExtension)
}

// What() as Prisma reads the schema at `path`, its refusal naming it.
async function readingSchema(path, what) {
  try {
    return await what()
  } catch (cause) {
    throw new Error(`prisma: ${path}: ${cause.message}`, { cause })
  }
}

// The Prisma clients of the projects at `projects` (paths from `root`), read through `host`, each a
// `{ dir, files }` of its output directory and its files there (Map of path from it to text, or bytes
// for the query compiler's .wasm).
// Projects with no schema, or none with a `prisma-client` generator, are skipped quietly; one stasis
// can't generate for (no or another Prisma installed, a config it can't read, another generator, an
// output from the environment) is skipped with a warning, the scan then saying what it misses.
export async function generatePrismaClients({ host, root, projects }) {
  const outputs = []
  for (const project of [...projects].toSorted()) {
    const dir = posix.join(root, project)
    const prisma = installedPrisma(host, dir)
    const supported = PRISMA_VERSIONS.includes(prisma?.version)
    const version = supported ? prisma.version : GENERATOR_VERSION
    let schema
    try {
      // eslint-disable-next-line no-await-in-loop -- in order, one generator at a time
      schema = await projectSchema(host, dir, version)
    } catch (error) {
      console.warn(`[stasis] prisma: not generating for ${dir}: ${error.message}`)
      continue
    }
    if (schema === null) continue
    // Read by Prisma 7.10.0, which another Prisma's schema needn't satisfy.
    if (!supported) {
      const installed = prisma === null ? 'none is installed' : `${prisma.file} is ${prisma.version}`
      console.warn(`[stasis] prisma: not generating for ${schema.path}: stasis generates as Prisma ${PRISMA_VERSIONS.at(-1)} to ${PRISMA_VERSIONS[0]} do, and ${installed}`)
      continue
    }
    const { internals } = loadGenerator()
    // One project at a time, in the order its warnings read.
    // eslint-disable-next-line no-await-in-loop -- in order, one generator at a time
    const config = await readingSchema(schema.path, () => internals.getConfig({ datamodel: schema.files }))
    const generators = config.generators.filter((generator) => generator.provider.value === PROVIDER && generator.provider.fromEnvVar === null)
    for (const other of config.generators.filter((generator) => !generators.includes(generator))) {
      console.warn(`[stasis] prisma: not generating ${schema.path}'s generator ${other.name}: stasis generates the ${JSON.stringify(PROVIDER)} provider's alone`)
    }
    if (generators.length === 0) continue
    for (const warning of config.warnings) console.warn(`[stasis] prisma: ${warning}`)
    if (config.datasources.length === 0) throw new Error(`prisma: ${schema.path} defines no datasource`)
    // eslint-disable-next-line no-await-in-loop -- in order, one generator at a time
    const dmmf = await readingSchema(schema.path, () => internals.getDMMF({ datamodel: schema.files }))
    const datamodel = internals.mergeSchemas({ schemas: schema.files })
    for (const generator of generators) {
      if (generator.output === null) throw new Error(`prisma: ${schema.path}: generator ${generator.name} names no output`)
      if (generator.output.fromEnvVar !== null) {
        console.warn(`[stasis] prisma: not generating ${schema.path}'s generator ${generator.name}: its output is env("${generator.output.fromEnvVar}"), which stasis doesn't read`)
        continue
      }
      const outputDir = posix.resolve(posix.dirname(generator.sourceFilePath ?? schema.path), generator.output.value)
      if (hasNodeModulesSegment(outputDir)) throw new Error(`prisma: ${schema.path}: generator ${generator.name}'s output ${outputDir} is in node_modules, which is laid out from the lockfile alone`)
      if (outputs.some((output) => output.dir === outputDir)) throw new Error(`prisma: ${outputDir} is the output of more than one generator`)
      outputs.push({ dir: outputDir, files: generateClientFor({ schema, datamodel, generator, dmmf, datasources: config.datasources, outputDir, version, prismaDir: posix.dirname(prisma.file), host }) })
    }
  }
  return outputs
}

// What the generator removes from an output directory before it writes there, which must then hold
// a generated client already: its deleteOutputDir's globs, which match regular files alone, and no
// dot file or directory.
const STALE = /(?:\.(?:js|ts|mts|cts|wasm|prisma)$|^package\.json$|^[^/]*\.node$|^(?:query|schema)-engine-[^/]*$)/u
const isStale = (path) => STALE.test(path) && !path.split('/').some((name) => name.startsWith('.'))
const CLIENT_FILES = ['client.ts', 'client.mts', 'client.cts', 'client.d.ts']

// A copy of `vfs` with the clients of `outputs` (generatePrismaClients') written where `prisma
// generate` writes them, over what an earlier client left there.
export function withPrismaClients(vfs, outputs) {
  const out = createVfs()
  out.mount(vfs, '/')
  for (const { dir, files } of outputs) {
    if (out.isDirectory(dir)) {
      const names = out.readdir(dir)
      if (names.length > 0 && !CLIENT_FILES.some((name) => names.includes(name))) {
        throw new Error(`prisma: ${dir} exists and is not empty but doesn't look like a generated Prisma Client`)
      }
      const stale = [...out.walk(dir)].filter((entry) => entry.type === 'file' && isStale(posix.relative(dir, entry.path)))
      for (const { path } of stale) out.unlink(path)
    }
    out.mount(createVfs(Object.fromEntries([...files].map(([path, text]) => [posix.join(dir, path), text]))), '/', { clash: 'replace' })
  }
  return out
}
