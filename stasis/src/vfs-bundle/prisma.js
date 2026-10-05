import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { compileFunction } from 'node:vm'

import { readJson } from '@exodus/stasis-core/bundle-util'
import { hasNodeModulesSegment } from '@exodus/stasis-core/util'
import { createVfs } from '@preventive/vfs'
import { isDir, isFile, loadTsconfigCompilerOptions } from '../resolve-typescript.js'
import { literalSpec, syntaxErrors } from '../scan.js'
import { holding, nearest, projectView } from './tree.js'

// buildVfsBundle's `generate: ['prisma']`: the client each project's `prisma generate` would write
// with its installed Prisma (7.4.0 to 7.10.0), without running anything of the repo: schema, config,
// tsconfig.json and package.json are read from the tree as data. The optional peer
// @prisma/client-generator-ts@7.10.0 builds the client in memory; an older version's is 7.10.0's
// rewritten (DOWN), tested byte for byte against that version's own `prisma generate`.

const GENERATOR = '@prisma/client-generator-ts'
const GENERATOR_VERSION = '7.10.0'
const PROVIDER = 'prisma-client'

// The engine hash each Prisma stamps its client with.
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

// Newest first.
export const PRISMA_VERSIONS = Object.keys(ENGINES)

const newerThan = (version, than) => PRISMA_VERSIONS.indexOf(version) < PRISMA_VERSIONS.indexOf(than)

const require = createRequire(import.meta.url)

// --- the generator ---

let loaded

// The bundle's readSourceFile, for the client `at` describes: an edge runtime's client copies the
// query compiler from `prisma generate`'s own build, which here is the tree's `prisma`.
const readQueryCompiler = (at) => (name) => {
  const { host, prismaDir, target } = at
  const file = posix.join(prismaDir, 'build', name)
  if (!isFile(file, host)) throw new Error(`prisma: ${file}, which a ${target} client carries, is not in the tree`)
  return Buffer.from(host.readFile(file))
}

// The bundle's inferModuleFormatFromNearestPackageJson, which reads the disk, for a node16 or
// nodenext module; before 7.10.0, those gave ESM.
const packageFormat = ({ host, version }) => (dir) => {
  if (!newerThan(version, '7.9.1')) return 'esm'
  const file = nearestFile(host, dir, 'package.json')
  if (file === null) return 'cjs'
  try {
    return JSON.parse(host.readFile(file).toString('utf8')).type === 'module' ? 'esm' : 'cjs'
  } catch {
    return 'cjs'
  }
}

// The bundle's top-level statements `roots` reach by name, but those `given` it as parameters, and
// its directives. A name is any word of a statement's text, so more is kept than is used, never less.
function reached(source, roots, given) {
  const { body } = require('oxc-parser').parseSync(GENERATOR, source, { sourceType: 'script' }).program
  const declaring = new Map(body.flatMap((node) => (node.declarations ?? [node]).flatMap(({ id }) => (id?.name ? [[id.name, node]] : []))))
  const kept = new Set()
  const keep = (name) => {
    const node = declaring.get(name)
    if (node === undefined || given.includes(name) || kept.has(node)) return
    kept.add(node)
    for (const [word] of source.slice(node.start, node.end).matchAll(/[\w$]+/gu)) keep(word)
  }
  roots.forEach(keep)
  return body.filter((node) => node.directive || kept.has(node)).map((node) => source.slice(node.start, node.end)).join('\n')
}

// What the compiled bundle returns, and is given: readSourceFile and
// inferModuleFormatFromNearestPackageJson read the disk, `debug` would require @prisma/debug, and
// buildTypedSql is left undefined, as stasis passes no typedSql.
const EXPORTS = ['buildClient', 'validateDmmfAgainstDenylists', 'parseRuntimeTargetFromUnknown', 'parseGeneratedFileExtension', 'parseImportFileExtension', 'inferImportFileExtension', 'parseModuleFormatFromUnknown', 'inferModuleFormat', 'parseCompilerBuildFromUnknown']
const PARAMETERS = ['require', 'readSourceFile', 'inferModuleFormatFromNearestPackageJson', 'debug', 'buildTypedSql']

// All the stripped bundle may require; nothing that reaches the disk.
const REQUIRES = new Set(['@prisma/client-common', '@prisma/dmmf', '@prisma/internals', '@prisma/param-graph-builder', '@prisma/ts-builders', 'indent-string', 'klona', 'pluralize', 'ts-pattern'])

// The peer exports neither buildClient (generateClient's in-memory half), the reserved-names check
// generateClient runs, nor the option parsing and inference of its generate(), so its bundle is
// compiled as a function returning them, stripped of what they never reach. Stripping is cleanup,
// not a sandbox.
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
  const source = reached(readFileSync(main, 'utf8'), EXPORTS, PARAMETERS)
  // A `require` without a literal name is refused too.
  const denied = [...source.matchAll(/\brequire\b(?:\("([^"]*)"\))?/gu)].filter(([, id]) => !REQUIRES.has(id)).map(([call]) => call)
  if (denied.length > 0) throw new Error(`--generate=prisma: ${main}, stripped, holds ${[...new Set(denied)].join(', ')}, beyond what buildClient requires`)
  const run = compileFunction(`${source}\nreturn { ${EXPORTS.join(', ')} }`, PARAMETERS, { filename: main })
  const schemaFiles = createRequire(own.resolve('@prisma/internals'))('@prisma/schema-files-loader')
  // Evaluated for each client (a millisecond), its functions given what they read.
  loaded = { peer: (at) => run(own, readQueryCompiler(at), packageFormat(at), () => {}), internals: own('@prisma/internals'), schemaFiles }
  return loaded
}

// --- what `prisma generate` reads ---

const nearestFile = (host, dir, name) => {
  const at = nearest(dir, holding(host, name))
  return at === null ? null : posix.join(at, name)
}

// The `prisma` Node resolves from `dir`, or where that is unsupported (Prisma 8, say), the one
// `@prisma/prisma7` runs as `prisma7` beside it.
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

// @prisma/config's search order; only 7.10.0 reads the first two (prisma7.config.*).
const CONFIG_BASES = ['prisma7.config', '.config/prisma7', ...['prisma.config', '.config/prisma', '.config/prisma.config'].flatMap((base) => [base, `${base}/index`])]
const configsOf = (version) => CONFIG_BASES.slice(newerThan(version, '7.9.1') ? 0 : 2).flatMap((base) => ['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts'].map((ext) => `${base}${ext}`))

// What a config's top-level imports and requires may bind, by module (`*`: the module itself).
const BINDINGS = {
  path: { '*': 'path', join: 'join' },
  'node:path': { '*': 'path', join: 'join' },
  'prisma/config': { defineConfig: 'defineConfig' },
  '@prisma/config': { defineConfig: 'defineConfig' },
}
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'])

// The `schema` a Prisma config names, read from its syntax tree: the config is never run, nor
// anything built from it. A string literal or path.join of them is taken, through defineConfig,
// `as`, `satisfies`, parentheses and top-level consts; anything else is refused.
function configSchema(file, text) {
  const parsed = require('oxc-parser').parseSync(file, text, { sourceType: 'unambiguous' })
  const [error] = syntaxErrors(parsed)
  if (error) throw new Error(`${file}: ${error.message}`)
  const refuse = (what) => new Error(`${file}: ${what}, which stasis reads without running the config`)
  const consts = new Map()
  const bound = new Map()
  const bind = (from, name, local) => bound.set(local, BINDINGS[from]?.[name])
  const required = (node) => (node?.type === 'CallExpression' && node.callee.name === 'require' && node.arguments.length === 1 ? literalSpec(node.arguments[0]) : null)
  let config
  for (const node of parsed.program.body) {
    if (node.type === 'ExportDefaultDeclaration') config = node.declaration
    else if (node.type === 'ImportDeclaration') {
      for (const { type, imported, local } of node.specifiers) bind(node.source.value, type === 'ImportSpecifier' ? imported.name ?? imported.value : '*', local.name)
    } else if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      for (const { id, init } of node.declarations) {
        const from = required(init)
        if (id.type === 'Identifier' && init) consts.set(id.name, init)
        if (from !== null && id.type === 'Identifier') bind(from, '*', id.name)
        if (from !== null && id.type === 'ObjectPattern') for (const { type, computed, key, value } of id.properties) if (type === 'Property' && !computed && value.type === 'Identifier') bind(from, key.name, value.name)
      }
    } else if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression') {
      const { left, right } = node.expression
      if (left.type === 'MemberExpression' && left.object.name === 'module' && left.property.name === 'exports') config = right
    }
  }
  if (config === undefined) throw refuse('no default export')
  // Each const once, against cycles.
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
    if ((property.key.name ?? property.key.value) === 'schema') schema = spelled(property.value)
  }
  return schema
}

// A schema directory is read by Prisma's own loader, over the tree.
function schemaFilesAt(host, path) {
  if (isFile(path, host)) return [[path, host.readFile(path).toString('utf8')]]
  const view = projectView(host, '/')
  return loadGenerator().schemaFiles.loadSchemaFiles(path, {
    listDirContents: async (dir) => view.readdir(dir),
    getEntryType: async (at) => ({ kind: view.lstat(at).type, realPath: host.realpath(at) }),
    getFileContents: async (file) => host.readFile(file).toString('utf8'),
  })
}

// The schema path `prisma generate` takes at `dir`: the config's `schema` (relative to the config),
// else ./schema.prisma or ./prisma/schema.prisma; null if none.
function projectSchema(host, dir, version) {
  const first = (names) => names.map((name) => posix.join(dir, name)).find((file) => isFile(file, host))
  const config = first(configsOf(version))
  const named = config && configSchema(config, host.readFile(config).toString('utf8'))
  const path = named === undefined ? first(['schema.prisma', 'prisma/schema.prisma']) : posix.resolve(posix.dirname(config), named)
  if (path === undefined) return null
  if (!isFile(path, host) && !isDir(path, host)) throw new Error(`${config}: its schema ${named} is no file or directory`)
  return path
}

// The nearest tsconfig.json as get-tsconfig 4.10 gives it, with the defaults the generator's
// inference reads: an ES2015+ target's module, else preserve's bundler resolution.
const ES_TARGETS = new Set(['es6', 'es2015', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020', 'es2021', 'es2022', 'es2023', 'es2024', 'esnext'])
function tsconfigOptions(host, dir) {
  const file = nearestFile(host, dir, 'tsconfig.json')
  if (file === null) return undefined
  const o = loadTsconfigCompilerOptions(file, host)
  if (o.target && ES_TARGETS.has(o.target.toLowerCase())) o.module ??= 'es6'
  else if (o.module && o.module.toLowerCase() === 'preserve') o.moduleResolution ??= 'bundler'
  return { compilerOptions: o }
}

// --- the generator's options, as its generate() parses and infers them, with its own functions ---

function generatorOptions(peer, host, config, outputDir) {
  const tsconfig = tsconfigOptions(host, outputDir)
  const target = config.runtime === undefined ? 'nodejs' : peer.parseRuntimeTargetFromUnknown(config.runtime)
  const generatedFileExtension = config.generatedFileExtension === undefined ? 'ts' : peer.parseGeneratedFileExtension(config.generatedFileExtension)
  const importFileExtension = config.importFileExtension === undefined ? peer.inferImportFileExtension({ tsconfig, generatedFileExtension, target }) : peer.parseImportFileExtension(config.importFileExtension)
  const moduleFormat = config.moduleFormat === undefined ? peer.inferModuleFormat({ tsconfig, generatedFileExtension, importFileExtension, outputDir }) : peer.parseModuleFormatFromUnknown(config.moduleFormat)
  const compilerBuild = peer.parseCompilerBuildFromUnknown(config.compilerBuild, target)
  return { target, generatedFileExtension, importFileExtension, moduleFormat, compilerBuild }
}

// --- 7.10.0's client as each older version writes it ---

// A missing `from` means the client isn't the one these rewrites were written against: refused,
// unless `optional` (null).
function swap(text, from, to, { path, all = false, optional = false }) {
  if (typeof from === 'string' ? !text.includes(from) : !from.test(text)) {
    if (optional) return null
    throw new Error(`prisma: ${path} of the ${GENERATOR_VERSION} client holds no ${JSON.stringify(String(from).slice(0, 80))}`)
  }
  return all ? text.replaceAll(from, () => to) : text.replace(from, () => to)
}

// File stems, without the generated extension.
const CLIENT = 'client'
const CLASS = 'internal/class'
const NAMESPACE = 'internal/prismaNamespace'

// 7.10.0 adds the `schema` of each model to the runtime data model.
function dropModelSchemas(text, path) {
  const match = /^config\.runtimeDataModel = JSON\.parse\((".*")\)$/mu.exec(text)
  if (match === null) throw new Error(`prisma: ${path} of the ${GENERATOR_VERSION} client holds no runtimeDataModel`)
  const model = JSON.parse(JSON.parse(match[1]))
  // Must round-trip, or the rewrite wouldn't match the generator's own serialization.
  if (JSON.stringify(JSON.stringify(model)) !== match[1]) throw new Error(`prisma: ${path}: the runtimeDataModel does not serialize back as written`)
  for (const each of Object.values(model.models)) delete each.schema
  return text.replace(match[0], () => `config.runtimeDataModel = JSON.parse(${JSON.stringify(JSON.stringify(model))})`)
}

// 7.8.0's PrismaClientOptions, which 7.9.0 splits into interfaces.
const UNION_OPTIONS = `export type PrismaClientOptions = ({
  /**
   * Instance of a Driver Adapter, e.g., like one provided by \`@prisma/adapter-pg\`.
   */
  adapter: runtime.SqlDriverAdapterFactory
  accelerateUrl?: never
} | {
  /**
   * Prisma Accelerate URL allowing the client to connect through Accelerate instead of a direct database.
   */
  accelerateUrl: string
  adapter?: never
}) & {`

// Each version's rewrites of the next newer one's client, by file stem (MODELS: each of models/).
// Versions differing only in the stamps (STAMPS) have none.
const MODELS = 'models/*'
// The constructor example in the docs: with an adapter from 7.4.2, without before.
const example = (indent) => [`${indent}* const prisma = new PrismaClient({\n${indent}*   adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL })\n${indent}* })\n`, `${indent}* const prisma = new PrismaClient()\n`]
const DOWN = {
  '7.9.1': { [CLASS]: dropModelSchemas },
  '7.8.0': {
    [CLASS]: (text, path) => {
      text = swap(text, '>(options: Prisma.PrismaClientConstructorArgs<Options>): PrismaClient<', '>(options: Prisma.Subset<Options, Prisma.PrismaClientOptions> ): PrismaClient<', { path })
      return swap(text, "  in out OmitOpts extends Prisma.PrismaClientOptions['omit'] = Prisma.PrismaClientOptions['omit'],", "  in out OmitOpts extends Prisma.PrismaClientOptions['omit'] = undefined,", { path })
    },
    // 7.9.0's constructor argument type, its PrismaClientOptions split into interfaces, and its XOR.
    [NAMESPACE]: (text, path) => {
      text = swap(text, /\/\*\*\n \* Resolved type of the argument passed to the `PrismaClient` constructor\.\n[^]*?, PrismaClientOptions>;\n\n/u, '', { path })
      text = swap(text, '    ((Without<T, U> & U) | (Without<U, T> & T)) & object\n', '    (Without<T, U> & U) | (Without<U, T> & T)\n', { path })
      text = swap(text, /\/\*\*\n \* Options common to all variants of `PrismaClientOptions`[^]*?\nexport interface PrismaClientBaseOptions \{/u, UNION_OPTIONS, { path })
      return swap(text, /\n\n\/\*\*\n \* `PrismaClient` options for connecting [^]*?\nexport type PrismaClientOptions = PrismaClientOptionsWithAccelerateUrl \| PrismaClientOptionsWithAdapter/u, '', { path })
    },
  },
  '7.7.0': {
    // MongoDB's transactions take no isolation level.
    [CLASS]: (text, path) => swap(text, '[...P], options?: { maxWait?: number, timeout?: number, ', '[...P], options?: { ', { path, optional: true })
      ?? swap(text, '[...P], options?: { maxWait?: number, timeout?: number })', '[...P])', { path }),
    // 7.8.0's query plan cache option.
    [NAMESPACE]: (text, path) => swap(text, /  \/\*\*\n   \* Optional maximum size for the query plan cache\.[^]*?\n  queryPlanCacheMaxSize\?: number\n/u, '', { path }),
  },
  '7.5.0': { [MODELS]: (text) => text.replace(/^export (type Get(\w+)GroupByPayload<T extends \2GroupByArgs> = )/mu, '$1') },
  '7.4.2': {
    // 7.5.0's distinct doc on each model's FindManyArgs, which 7.4.2 has on FindFirst(OrThrow)Args alone.
    [MODELS]: (text) => text.replace(/^(export type \w+FindManyArgs<.* = \{\n(?:(?!\}\n).*\n)*?)  \/\*\*\n   \* \{@link https:\/\/www\.prisma\.io\/docs\/concepts\/components\/prisma-client\/distinct Distinct Docs\}\n   \* \n   \* Filter by unique combinations of .*\n   \*\/\n(?=  distinct\?: )/gmu, '$1'),
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

// Where each client stamps its version and engine.
const STAMPS = [
  [CLASS, (version) => `"clientVersion": "${version}",\n  "engineVersion": "${ENGINES[version]}",`],
  [NAMESPACE, (version) => ` * Prisma Client JS version: ${version}\n * Query Engine version: ${ENGINES[version]}\n`],
  [NAMESPACE, (version) => `  client: "${version}",\n  engine: "${ENGINES[version]}"\n`],
]

// A 7.10.0 client file as `version` writes it.
function asVersion(text, path, version, extension) {
  if (typeof text !== 'string') return text
  const stem = path.slice(0, -extension.length - 1)
  const key = stem.startsWith('models/') ? MODELS : stem
  for (const each of PRISMA_VERSIONS.slice(1, PRISMA_VERSIONS.indexOf(version) + 1)) text = DOWN[each]?.[key]?.(text, path) ?? text
  for (const [where, stamp] of STAMPS) if (stem === where) text = swap(text, stamp(GENERATOR_VERSION), stamp(version), { path })
  return text
}

// --- generating ---

// One generator's client: path in the output -> text (bytes for the query compiler's .wasm).
function generateClientFor({ schemaPath, datamodel, generator, dmmf, datasources, outputDir, version, prismaDir, host }) {
  const client = { host, version, prismaDir }
  const peer = loadGenerator().peer(client)
  const options = generatorOptions(peer, host, generator.config, outputDir)
  client.target = options.target
  const built = peer.buildClient({
    datamodel,
    schemaPath,
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
  const denied = peer.validateDmmfAgainstDenylists(built.prismaClientDmmf)
  if (denied) throw new Error(`prisma: ${schemaPath} contains reserved keywords, to rename: ${denied.map((error) => error.message).join(', ')}`)
  // fileMap nests directories as objects.
  const flat = (map, at) => Object.entries(map).flatMap(([name, content]) => (typeof content === 'string' || Buffer.isBuffer(content) ? [[at + name, content]] : flat(content, `${at}${name}/`)))
  return new Map(flat(built.fileMap, '').map(([path, content]) => [path, asVersion(content, path, version, options.generatedFileExtension)]))
}

const readingSchema = (path, what) => Promise.try(what).catch((cause) => {
  throw new Error(`prisma: ${path}: ${cause.message}`, { cause })
})

// Each `{ dir, files }` output. Projects without a schema or a `prisma-client` generator are skipped
// quietly; ones stasis can't generate for (unsupported Prisma, unreadable config, other generators,
// env outputs) with a warning, the scan then reporting what is missing.
/* eslint-disable no-await-in-loop -- one project at a time, in the order its warnings read */
export async function generatePrismaClients({ host, root, projects }) {
  const outputs = []
  for (const project of [...projects].toSorted()) {
    const dir = posix.join(root, project)
    const prisma = installedPrisma(host, dir)
    const supported = PRISMA_VERSIONS.includes(prisma?.version)
    const version = supported ? prisma.version : GENERATOR_VERSION
    const path = await Promise.try(projectSchema, host, dir, version).catch((error) => { console.warn(`[stasis] prisma: not generating for ${dir}: ${error.message}`) })
    if (!path) continue
    // Checked before parsing: another Prisma's schema needn't satisfy 7.10.0.
    if (!supported) {
      const installed = prisma === null ? 'none is installed' : `${prisma.file} is ${prisma.version}`
      console.warn(`[stasis] prisma: not generating for ${path}: stasis generates as Prisma ${PRISMA_VERSIONS.at(-1)} to ${PRISMA_VERSIONS[0]} do, and ${installed}`)
      continue
    }
    const files = await readingSchema(path, () => schemaFilesAt(host, path))
    const { internals } = loadGenerator()
    const config = await readingSchema(path, () => internals.getConfig({ datamodel: files }))
    const generators = config.generators.filter((generator) => generator.provider.value === PROVIDER && generator.provider.fromEnvVar === null)
    for (const other of config.generators.filter((generator) => !generators.includes(generator))) {
      console.warn(`[stasis] prisma: not generating ${path}'s generator ${other.name}: stasis generates the ${JSON.stringify(PROVIDER)} provider's alone`)
    }
    if (generators.length === 0) continue
    for (const warning of config.warnings) console.warn(`[stasis] prisma: ${warning}`)
    if (config.datasources.length === 0) throw new Error(`prisma: ${path} defines no datasource`)
    const dmmf = await readingSchema(path, () => internals.getDMMF({ datamodel: files }))
    const datamodel = internals.mergeSchemas({ schemas: files })
    for (const generator of generators) {
      if (generator.output === null) throw new Error(`prisma: ${path}: generator ${generator.name} names no output`)
      if (generator.output.fromEnvVar !== null) {
        console.warn(`[stasis] prisma: not generating ${path}'s generator ${generator.name}: its output is env("${generator.output.fromEnvVar}"), which stasis doesn't read`)
        continue
      }
      const outputDir = posix.resolve(posix.dirname(generator.sourceFilePath ?? path), generator.output.value)
      if (hasNodeModulesSegment(outputDir)) throw new Error(`prisma: ${path}: generator ${generator.name}'s output ${outputDir} is in node_modules, which is laid out from the lockfile alone`)
      if (outputs.some((output) => output.dir === outputDir)) throw new Error(`prisma: ${outputDir} is the output of more than one generator`)
      outputs.push({ dir: outputDir, files: generateClientFor({ schemaPath: path, datamodel, generator, dmmf, datasources: config.datasources, outputDir, version, prismaDir: posix.dirname(prisma.file), host }) })
    }
  }
  return outputs
}

// What deleteOutputDir clears before writing (its globs skip dot paths), in an output that must
// already look like a client.
const STALE = /(?:\.(?:js|ts|mts|cts|wasm|prisma)$|^package\.json$|^[^/]*\.node$|^(?:query|schema)-engine-[^/]*$)/u
const isStale = (path) => STALE.test(path) && !path.split('/').some((name) => name.startsWith('.'))
const CLIENT_FILES = ['client.ts', 'client.mts', 'client.cts', 'client.d.ts']

// A copy of `vfs` with the outputs written over any earlier client, as `prisma generate` does.
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
