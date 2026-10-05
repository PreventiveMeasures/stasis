import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { compileFunction } from 'node:vm'

import { readJson } from '@exodus/stasis-core/bundle-util'
import { hasNodeModulesSegment } from '@exodus/stasis-core/util'
import { createVfs } from '@preventive/vfs'
import { isDir, isFile, loadTsconfigCompilerOptions } from '../resolve-typescript.js'
import { getParser, literalSpec, syntaxErrors } from '../scan.js'
import { holding, nearest, projectView } from './tree.js'

// buildVfsBundle's `generate: ['prisma']`: the client each project's `prisma generate` would write
// with its installed Prisma, without running anything of the repo: schema, config, tsconfig.json
// and package.json are read from the tree as data. The optional peer GENERATOR builds the client in
// memory; an older version's is 7.10.0's rewritten (DOWN), tested byte for byte against its own.

const GENERATOR = '@prisma/client-generator-ts'
const GENERATOR_VERSION = '7.10.0'
const PROVIDER = 'prisma-client'
const require = createRequire(import.meta.url)

// The engine hash each Prisma stamps its client with, newest first.
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
export const PRISMA_VERSIONS = Object.keys(ENGINES)
const newerThan = (version, than) => PRISMA_VERSIONS.indexOf(version) < PRISMA_VERSIONS.indexOf(than)

// --- the generator ---

// The bundle's readSourceFile, for the client `at` describes: an edge runtime's client copies the
// query compiler from `prisma generate`'s own build, which here is the tree's `prisma`.
const readQueryCompiler = (at) => (name) => {
  const file = posix.join(at.prismaDir, 'build', name)
  if (!isFile(file, at.host)) throw new Error(`prisma: ${file}, which a ${at.target} client carries, is not in the tree`)
  return Buffer.from(at.host.readFile(file))
}

// The bundle's inferModuleFormatFromNearestPackageJson, for node16 and nodenext; ESM before 7.10.0.
const packageFormat = ({ host, version }) => (dir) => {
  if (!newerThan(version, '7.9.1')) return 'esm'
  const file = nearestFile(host, dir, 'package.json')
  try { return file !== null && JSON.parse(host.readFile(file).toString('utf8')).type === 'module' ? 'esm' : 'cjs' } catch { return 'cjs' }
}

// The esbuild bundle at `main` as a function of `parameters` returning `roots`, kept to the top-level
// statements they reach by name (any word of a statement: more is kept than used, never less), and
// refused where it then requires anything `given` doesn't hold, or by no literal name.
function compiled(main, roots, parameters, given) {
  const source = readFileSync(main, 'utf8')
  const { body } = getParser().parseSync(main, source, { sourceType: 'script' }).program
  const declaring = new Map(body.flatMap((node) => (node.declarations ?? [node]).flatMap(({ id }) => (id?.name ? [[id.name, node]] : []))))
  const kept = new Set()
  const keep = (name) => {
    const node = declaring.get(name)
    if (node === undefined || parameters.includes(name) || kept.has(node)) return
    kept.add(node)
    for (const [word] of source.slice(node.start, node.end).matchAll(/[\w$]+/gu)) keep(word)
  }
  roots.forEach(keep)
  const reached = body.filter((node) => node.directive || kept.has(node)).map((node) => source.slice(node.start, node.end)).join('\n')
  const denied = [...reached.matchAll(/\brequire\b(?:\("([^"]*)"\))?/gu)].filter(([, id]) => !Object.hasOwn(given, id)).map(([call]) => call)
  if (denied.length > 0) throw new Error(`--generate=prisma: ${main}, stripped, holds ${[...new Set(denied)].join(', ')}, beyond what stasis lets it require`)
  return compileFunction(`${reached}\nreturn { ${roots.join(', ')} }`, ['require', ...parameters], { filename: main }).bind(null, (id) => given[id])
}

// CommonJS files from `main` on, compiled requiring nothing outside their package but what `given`
// holds (none reads __filename or __dirname).
function commonjs(main, given) {
  const modules = new Map()
  const load = (file) => {
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }
    modules.set(file, module)
    const requiring = (id) => {
      if (id.startsWith('.')) return load(createRequire(file).resolve(id))
      if (!Object.hasOwn(given, id)) throw new Error(`--generate=prisma: ${file} requires ${id}, which stasis doesn't let it`)
      return given[id]
    }
    compileFunction(readFileSync(file, 'utf8'), ['exports', 'require', 'module'], { filename: file })(module.exports, requiring, module)
    return module.exports
  }
  return load(main)
}

// The schema engine's refusals are JSON with a `message`; its panics aren't.
const engineMessage = (message) => { try { return JSON.parse(message).message ?? message } catch { return message } }

// What the compiled generator returns, is given, and requires as Node loads it (none of it the
// disk's); given, as readSourceFile and inferModuleFormatFromNearestPackageJson read the disk,
// `debug` would require @prisma/debug, and buildTypedSql is undefined: stasis passes no typedSql.
const EXPORTS = ['buildClient', 'validateDmmfAgainstDenylists', 'parseRuntimeTargetFromUnknown', 'parseGeneratedFileExtension', 'parseImportFileExtension', 'inferImportFileExtension', 'parseModuleFormatFromUnknown', 'inferModuleFormat', 'parseCompilerBuildFromUnknown']
const PARAMETERS = ['readSourceFile', 'inferModuleFormatFromNearestPackageJson', 'debug', 'buildTypedSql']
const REQUIRES = ['@prisma/client-common', '@prisma/dmmf', '@prisma/param-graph-builder', 'indent-string', 'klona', 'pluralize', 'ts-pattern']
let loaded

// The peer exports neither buildClient (generateClient's in-memory half), the reserved-names check
// generateClient runs, nor its generate()'s option parsing and inference, so its bundle is compiled
// to return them, stripped (cleanup, not a sandbox) of what they never reach. @prisma/internals is
// never loaded: loading it reads the host's npm and yarn config and platform, and patches fs and
// process.cwd. Its users get a stand-in: its parsing the schema engine's and @prisma/get-dmmf's,
// which it wraps, and its isValidJsIdentifier its own file's, whose Unicode tables aren't Node's.
function loadGenerator() {
  if (loaded) return loaded
  let main
  try { main = require.resolve(GENERATOR) } catch (cause) { throw new Error(`--generate=prisma needs the optional '${GENERATOR}' ${GENERATOR_VERSION} dependency; install it (e.g. \`npm i ${GENERATOR}@${GENERATOR_VERSION}\`)`, { cause }) }
  const own = createRequire(main)
  const { version } = own('../package.json')
  if (version !== GENERATOR_VERSION) throw new Error(`--generate=prisma needs ${GENERATOR} ${GENERATOR_VERSION}, not ${version}`)
  // Prisma's packages beside the @prisma/internals the peer was built with.
  const near = createRequire(own.resolve('@prisma/internals'))
  const engine = near('@prisma/prisma-schema-wasm')
  const getDmmf = near('@prisma/get-dmmf')
  const internals = {
    externalToInternalDmmf: getDmmf.externalToInternalDmmf,
    hasOwnProperty: Object.hasOwn,
    assertNever: (value, message) => { throw new Error(message) },
    isValidJsIdentifier: commonjs(own.resolve('@prisma/internals/dist/utils/isValidJsIdentifier.js'), {}).isValidJsIdentifier,
    // But for resolving binaryTargets, which the generator never reads.
    getConfig: ({ datamodel }) => {
      const { config, errors } = JSON.parse(engine.get_config(JSON.stringify({ prismaSchema: datamodel })))
      if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('\n'))
      return config
    },
    getDMMF: (options) => {
      const result = getDmmf.getDMMF(options)
      if ('error' in result) throw new Error(engineMessage(result.error.message), { cause: result.error })
      return result
    },
    mergeSchemas: ({ schemas }) => engine.merge_schemas(JSON.stringify({ schema: schemas })),
  }
  const given = { ...Object.fromEntries(REQUIRES.map((id) => [id, own(id)])), '@prisma/internals': internals, '@prisma/ts-builders': commonjs(own.resolve('@prisma/ts-builders'), { '@prisma/internals': internals }) }
  const run = compiled(main, EXPORTS, PARAMETERS, given)
  const { loadSchemaFiles } = compiled(near.resolve('@prisma/schema-files-loader'), ['loadSchemaFiles'], ['realFsResolver'], { 'node:path': posix })()
  // `peer` is evaluated for each client (a millisecond), its functions given what they read.
  loaded = { peer: (at) => run(readQueryCompiler(at), packageFormat(at), () => {}), internals, loadSchemaFiles }
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
  const prisma7 = PRISMA_VERSIONS.includes(prisma?.version) ? null : nearestFile(host, dir, 'node_modules/@prisma/prisma7/package.json')
  const beside = prisma7 && installed(host.realpath(posix.dirname(prisma7)))
  return PRISMA_VERSIONS.includes(beside?.version) ? beside : prisma
}

// @prisma/config's search order; only 7.10.0 reads the first two (prisma7.config.*).
const CONFIG_BASES = ['prisma7.config', '.config/prisma7', ...['prisma.config', '.config/prisma', '.config/prisma.config'].flatMap((base) => [base, `${base}/index`])]

// The modules a config's top-level imports and requires may bind, as `name.export` (`name.*`: the module).
const MODULES = { path: 'path', 'node:path': 'path', 'prisma/config': 'config', '@prisma/config': 'config' }

// The `schema` a Prisma config names, read from its syntax tree: the config is never run, nor
// anything built from it. A string literal or path.join of them is taken, through defineConfig,
// `as`, `satisfies`, parentheses and top-level consts; anything else is refused.
function configSchema(file, text) {
  const parsed = getParser().parseSync(file, text, { sourceType: 'unambiguous' })
  const [error] = syntaxErrors(parsed)
  if (error) throw new Error(`${file}: ${error.message}`)
  const refuse = (what) => { throw new Error(`${file}: ${what}, which stasis reads without running the config`) }
  const consts = new Map()
  const bound = new Map()
  const bind = (from, name, local) => bound.set(local, `${MODULES[from]}.${name}`)
  let config
  for (const node of parsed.program.body) {
    if (node.type === 'ExportDefaultDeclaration') config = node.declaration
    else if (node.type === 'ImportDeclaration') {
      for (const { type, imported, local } of node.specifiers) bind(node.source.value, type === 'ImportSpecifier' ? imported.name ?? imported.value : '*', local.name)
    } else if (node.type === 'VariableDeclaration' && node.kind === 'const') {
      for (const { id, init } of node.declarations) {
        const from = init?.type === 'CallExpression' && init.callee.name === 'require' && init.arguments.length === 1 ? literalSpec(init.arguments[0]) : null
        if (id.type === 'Identifier' && init) consts.set(id.name, init)
        if (from !== null && id.type === 'Identifier') bind(from, '*', id.name)
        if (from !== null && id.type === 'ObjectPattern') for (const { type, computed, key, value } of id.properties) if (type === 'Property' && !computed && value.type === 'Identifier') bind(from, key.name, value.name)
      }
    } else if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression') {
      const { left, right } = node.expression
      if (left.type === 'MemberExpression' && left.object.name === 'module' && left.property.name === 'exports') config = right
    }
  }
  if (config === undefined) refuse('no default export')
  // Each const once, against cycles.
  const peel = (node, seen = new Set()) => {
    if (['TSAsExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(node.type)) return peel(node.expression, seen)
    return node.type === 'Identifier' && consts.has(node.name) && !seen.has(node.name) ? peel(consts.get(node.name), seen.add(node.name)) : node
  }
  const called = ({ type, callee }) => type === 'CallExpression' && (callee.type === 'MemberExpression' && !callee.computed && bound.get(callee.object.name) === 'path.*' ? `path.${callee.property.name}` : bound.get(callee.name))
  config = peel(config)
  if (called(config) === 'config.defineConfig' && config.arguments.length === 1) config = peel(config.arguments[0])
  if (config.type !== 'ObjectExpression') refuse('its default export is no object literal')
  const spelled = (node) => {
    node = peel(node)
    return literalSpec(node) ?? (called(node) === 'path.join' ? posix.join(...node.arguments.map(spelled)) : refuse('its `schema` is no string literal, nor path.join of them'))
  }
  let schema
  for (const property of config.properties) {
    // A spread or a computed key may name a schema stasis can't see.
    if (property.type !== 'Property' || property.computed) refuse('its config spreads or computes a key')
    if ((property.key.name ?? property.key.value) === 'schema') schema = spelled(property.value)
  }
  return schema
}

// A schema directory is read by Prisma's own loader, over the tree.
function schemaFilesAt(host, path) {
  if (isFile(path, host)) return [[path, host.readFile(path).toString('utf8')]]
  const view = projectView(host, '/')
  return loadGenerator().loadSchemaFiles(path, {
    listDirContents: async (dir) => view.readdir(dir),
    getEntryType: async (at) => ({ kind: view.lstat(at).type, realPath: host.realpath(at) }),
    getFileContents: async (file) => host.readFile(file).toString('utf8'),
  })
}

// The schema path `prisma generate` takes at `dir`: the config's `schema` (relative to the config),
// else ./schema.prisma or ./prisma/schema.prisma; null if none.
function projectSchema(host, dir, version) {
  const first = (names) => names.map((name) => posix.join(dir, name)).find((file) => isFile(file, host))
  const config = first(CONFIG_BASES.slice(newerThan(version, '7.9.1') ? 0 : 2).flatMap((base) => ['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts'].map((ext) => `${base}${ext}`)))
  const named = config && configSchema(config, host.readFile(config).toString('utf8'))
  const path = named === undefined ? first(['schema.prisma', 'prisma/schema.prisma']) : posix.resolve(posix.dirname(config), named)
  if (path === undefined) return null
  if (!isFile(path, host) && !isDir(path, host)) throw new Error(`${config}: its schema ${named} is no file or directory`)
  return path
}

// --- the generator's options, as its generate() parses and infers them, with its own functions ---

// The inference reads the nearest tsconfig.json as get-tsconfig 4.10 gives it, defaults included: an
// ES2015+ target's module, else preserve's bundler resolution.
const ES_TARGETS = new Set(['es6', 'es2015', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020', 'es2021', 'es2022', 'es2023', 'es2024', 'esnext'])
function generatorOptions(peer, host, config, outputDir) {
  const file = nearestFile(host, outputDir, 'tsconfig.json')
  const o = file === null ? undefined : loadTsconfigCompilerOptions(file, host)
  if (o?.target && ES_TARGETS.has(o.target.toLowerCase())) o.module ??= 'es6'
  else if (o?.module && o.module.toLowerCase() === 'preserve') o.moduleResolution ??= 'bundler'
  const tsconfig = o && { compilerOptions: o }
  const target = config.runtime === undefined ? 'nodejs' : peer.parseRuntimeTargetFromUnknown(config.runtime)
  const generatedFileExtension = config.generatedFileExtension === undefined ? 'ts' : peer.parseGeneratedFileExtension(config.generatedFileExtension)
  const importFileExtension = config.importFileExtension === undefined ? peer.inferImportFileExtension({ tsconfig, generatedFileExtension, target }) : peer.parseImportFileExtension(config.importFileExtension)
  const moduleFormat = config.moduleFormat === undefined ? peer.inferModuleFormat({ tsconfig, generatedFileExtension, importFileExtension, outputDir }) : peer.parseModuleFormatFromUnknown(config.moduleFormat)
  const compilerBuild = peer.parseCompilerBuildFromUnknown(config.compilerBuild, target)
  return { target, generatedFileExtension, importFileExtension, moduleFormat, compilerBuild }
}

// --- 7.10.0's client as each older version writes it ---

// A missing `from` means the client isn't the one these rewrites were written against: refused unless `optional` (null).
function swap(text, from, to, { path, all, optional }) {
  if (typeof from === 'string' ? text.includes(from) : from.test(text)) return all ? text.replaceAll(from, () => to) : text.replace(from, () => to)
  if (optional) return null
  throw new Error(`prisma: ${path} of the ${GENERATOR_VERSION} client holds no ${JSON.stringify(String(from).slice(0, 80))}`)
}

// File stems, without the generated extension (MODELS: each of models/).
const CLASS = 'internal/class'
const NAMESPACE = 'internal/prismaNamespace'
const MODELS = 'models/*'

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

// The constructor example in the docs: with an adapter from 7.4.2, without before.
const example = (indent) => [`${indent}* const prisma = new PrismaClient({\n${indent}*   adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL })\n${indent}* })\n`, `${indent}* const prisma = new PrismaClient()\n`]
// Each version's rewrites of the next newer one's client, by file stem; none where only the stamps (STAMPS) differ.
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
    [CLASS]: (text) => text.replace('ITXClientDenyList | "$transaction">', 'ITXClientDenyList>'), [NAMESPACE]: (text) => text.replace("ITXClientDenyList | '$transaction'>", 'ITXClientDenyList>'),
  },
  '7.4.1': { client: (text, path) => swap(text, ...example(' '), { path, all: true }), [CLASS]: (text, path) => swap(swap(text, ...example(' '), { path, all: true }), ...example('   '), { path, all: true }) },
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
  const key = path.startsWith('models/') ? MODELS : path.slice(0, -extension.length - 1)
  for (const each of PRISMA_VERSIONS.slice(1, PRISMA_VERSIONS.indexOf(version) + 1)) text = DOWN[each]?.[key]?.(text, path) ?? text
  for (const [where, stamp] of STAMPS) if (key === where) text = swap(text, stamp(GENERATOR_VERSION), stamp(version), { path })
  return text
}

// --- generating ---

// One generator's client: path in the output -> text (bytes for the query compiler's .wasm).
function generateClientFor({ schemaPath, datamodel, generator, dmmf, datasources, outputDir, prisma, host }) {
  const client = { host, version: prisma.version, prismaDir: posix.dirname(prisma.file) }
  const peer = loadGenerator().peer(client)
  const options = generatorOptions(peer, host, generator.config, outputDir)
  client.target = options.target
  const built = peer.buildClient({
    datamodel, schemaPath, runtimeBase: '@prisma/client/runtime', outputDir, generator, dmmf, datasources, binaryPaths: {},
    engineVersion: ENGINES[GENERATOR_VERSION], clientVersion: GENERATOR_VERSION, activeProvider: datasources[0]?.activeProvider, tsNoCheckPreamble: true, ...options,
  })
  const denied = peer.validateDmmfAgainstDenylists(built.prismaClientDmmf)
  if (denied) throw new Error(`prisma: ${schemaPath} contains reserved keywords, to rename: ${denied.map((error) => error.message).join(', ')}`)
  // fileMap nests directories as objects.
  const flat = (map, at) => Object.entries(map).flatMap(([name, content]) => (typeof content === 'string' || Buffer.isBuffer(content) ? [[at + name, content]] : flat(content, `${at}${name}/`)))
  return new Map(flat(built.fileMap, '').map(([path, content]) => [path, asVersion(content, path, prisma.version, options.generatedFileExtension)]))
}

const readingSchema = (path, what) => Promise.try(what).catch((cause) => { throw new Error(`prisma: ${path}: ${cause.message}`, { cause }) })

// Each `{ dir, files }` output. Projects without a schema or a `prisma-client` generator are skipped
// quietly; ones stasis can't generate for with a warning, the scan then reporting what is missing.
/* eslint-disable no-await-in-loop -- one project at a time, in the order its warnings read */
export async function generatePrismaClients({ host, root, projects }) {
  const outputs = []
  const skip = (what, why) => { console.warn(`[stasis] prisma: not generating ${what}: ${why}`) }
  for (const project of [...projects].toSorted()) {
    const dir = posix.join(root, project)
    const prisma = installedPrisma(host, dir)
    const supported = PRISMA_VERSIONS.includes(prisma?.version)
    const path = await Promise.try(projectSchema, host, dir, supported ? prisma.version : GENERATOR_VERSION).catch((error) => skip(`for ${dir}`, error.message))
    // Checked before parsing: another Prisma's schema needn't satisfy 7.10.0.
    if (path && !supported) skip(`for ${path}`, `stasis generates as Prisma ${PRISMA_VERSIONS.at(-1)} to ${PRISMA_VERSIONS[0]} do, and ${prisma === null ? 'none is installed' : `${prisma.file} is ${prisma.version}`}`)
    if (!path || !supported) continue
    const files = await readingSchema(path, () => schemaFilesAt(host, path))
    const { internals } = loadGenerator()
    const config = await readingSchema(path, () => internals.getConfig({ datamodel: files }))
    const generators = config.generators.filter((generator) => generator.provider.value === PROVIDER && generator.provider.fromEnvVar === null)
    for (const other of config.generators.filter((generator) => !generators.includes(generator))) skip(`${path}'s generator ${other.name}`, `stasis generates the ${JSON.stringify(PROVIDER)} provider's alone`)
    if (generators.length === 0) continue
    for (const warning of config.warnings) console.warn(`[stasis] prisma: ${warning}`)
    if (config.datasources.length === 0) throw new Error(`prisma: ${path} defines no datasource`)
    const dmmf = await readingSchema(path, () => internals.getDMMF({ datamodel: files }))
    const datamodel = internals.mergeSchemas({ schemas: files })
    for (const generator of generators) {
      if (generator.output === null) throw new Error(`prisma: ${path}: generator ${generator.name} names no output`)
      if (generator.output.fromEnvVar !== null) {
        skip(`${path}'s generator ${generator.name}`, `its output is env("${generator.output.fromEnvVar}"), which stasis doesn't read`)
        continue
      }
      const outputDir = posix.resolve(posix.dirname(generator.sourceFilePath ?? path), generator.output.value)
      if (hasNodeModulesSegment(outputDir)) throw new Error(`prisma: ${path}: generator ${generator.name}'s output ${outputDir} is in node_modules, which is laid out from the lockfile alone`)
      if (outputs.some((output) => output.dir === outputDir)) throw new Error(`prisma: ${outputDir} is the output of more than one generator`)
      outputs.push({ dir: outputDir, files: generateClientFor({ schemaPath: path, datamodel, generator, dmmf, datasources: config.datasources, outputDir, prisma, host }) })
    }
  }
  return outputs
}

// What deleteOutputDir clears before writing (its globs skip dot paths), in an output that must
// already look like a client.
const isStale = (path) => /(?:\.(?:js|ts|mts|cts|wasm|prisma)$|^package\.json$|^[^/]*\.node$|^(?:query|schema)-engine-[^/]*$)/u.test(path) && !path.split('/').some((name) => name.startsWith('.'))
const CLIENT_FILES = ['client.ts', 'client.mts', 'client.cts', 'client.d.ts']

// A copy of `vfs` with the outputs written over any earlier client, as `prisma generate` does.
export function withPrismaClients(vfs, outputs) {
  const out = createVfs()
  out.mount(vfs, '/')
  for (const { dir, files } of outputs) {
    if (out.isDirectory(dir)) {
      const names = out.readdir(dir)
      if (names.length > 0 && !CLIENT_FILES.some((name) => names.includes(name))) throw new Error(`prisma: ${dir} exists and is not empty but doesn't look like a generated Prisma Client`)
      for (const { type, path } of out.walk(dir).toArray()) if (type === 'file' && isStale(posix.relative(dir, path))) out.unlink(path)
    }
    out.mount(createVfs(Object.fromEntries([...files].map(([path, text]) => [posix.join(dir, path), text]))), '/', { clash: 'replace' })
  }
  return out
}
