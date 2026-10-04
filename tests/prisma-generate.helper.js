import { createHash } from 'node:crypto'
import { posix } from 'node:path'

import { Vfs } from '../stasis/src/vfs-bundle.js'

// The corpus prisma-generate.test.js holds the Prisma clients stasis generates (vfs-bundle/prisma.js)
// to, byte for byte: projects whose `prisma generate` output, as each Prisma from 7.4.0 to 7.10.0
// writes it with its own CLI, fixtures/prisma-generate.json holds the hashes of
// (prisma-generate-truth.manual.js writes it). Each case: { files, cwd, args, output } -- the
// project's files, the directory `prisma generate` runs in, its arguments, and the directory its
// client lands in, `generated` unless named.

const gen = (extra = '', output = '../generated') => `generator client {\n  provider = "prisma-client"\n  output   = "${output}"${extra ? `\n${extra}` : ''}\n}\n`
const ds = (provider, extra = '') => `\ndatasource db {\n  provider = "${provider}"${extra ? `\n${extra}` : ''}\n}\n`

const PG_RICH = `
enum Role {
  USER
  ADMIN
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  role      Role     @default(USER)
  posts     Post[]
  profile   Profile?
  createdAt DateTime @default(now())
  meta      Json?
  balance   Decimal  @default(0)
  big       BigInt?
  data      Bytes?

  @@map("users")
}

model Post {
  id       String @id @default(uuid())
  title    String
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
  tags     Tag[]

  @@index([authorId])
}

model Profile {
  userId Int    @id
  user   User   @relation(fields: [userId], references: [id])
  bio    String
}

model Tag {
  name  String @id
  posts Post[]
}

model Membership {
  userId Int
  teamId Int

  @@id([userId, teamId])
}
`

const PG_FEATURES = `
/// A user of the system
model Account {
  id        String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  /// The email
  email     String    @unique @db.VarChar(320)
  tags      String[]
  scores    Int[]
  settings  Json      @default("{}")
  status    Status    @default(ACTIVE)
  parentId  String?   @db.Uuid
  parent    Account?  @relation("Tree", fields: [parentId], references: [id], onDelete: Cascade)
  children  Account[] @relation("Tree")
  updatedAt DateTime  @updatedAt @db.Timestamptz(3)
  search    Unsupported("tsvector")?
  secret    String    @ignore
  sessions  Session[]

  @@unique([email, parentId])
  @@map("accounts")
  @@schema("auth")
}

model Session {
  id        BigInt  @id @default(autoincrement())
  accountId String  @db.Uuid
  account   Account @relation(fields: [accountId], references: [id])
  token     String  @unique

  @@schema("auth")
}

enum Status {
  ACTIVE   @map("active")
  DISABLED @map("disabled")

  @@map("status")
  @@schema("public")
}

view AccountStats {
  accountId String @unique @db.Uuid
  sessions  Int

  @@schema("public")
}

model Legacy {
  id Int @id

  @@ignore
  @@schema("public")
}
`

const MYSQL = `
model Article {
  id        Int      @id @default(autoincrement())
  title     String   @db.VarChar(255)
  body      String   @db.Text
  price     Decimal  @db.Decimal(10, 2)
  kind      Kind
  published Boolean  @default(false)
  createdAt DateTime @default(now()) @db.DateTime(0)
  author    Author   @relation(fields: [authorId], references: [id])
  authorId  Int

  @@fulltext([title, body])
  @@index([kind])
}

model Author {
  id       Int       @id @default(autoincrement())
  name     String    @unique
  articles Article[]
}

enum Kind {
  NEWS
  BLOG
}
`

const SQLITE = `
model Item {
  id      Int      @id @default(autoincrement())
  name    String
  data    Json?
  price   Decimal?
  kind    Kind     @default(A)
  created DateTime @default(now())
  owner   Owner?   @relation(fields: [ownerId], references: [id])
  ownerId Int?
}

model Owner {
  id    Int    @id @default(autoincrement())
  items Item[]
}

enum Kind {
  A
  B
}
`

const SQLSERVER = `
model Order {
  id       Int         @id @default(autoincrement())
  number   String      @unique @db.NVarChar(64)
  total    Float       @db.Money
  placedAt DateTime    @default(now())
  lines    OrderLine[]
}

model OrderLine {
  orderId Int
  sku     String
  qty     Int
  order   Order  @relation(fields: [orderId], references: [id], onUpdate: NoAction)

  @@id([orderId, sku])
}
`

const COCKROACH = `
model Event {
  id      BigInt   @id @default(sequence())
  kind    Level
  labels  String[]
  payload Json
  at      DateTime @default(now()) @db.Timestamptz(6)
}

enum Level {
  LOW
  HIGH
}
`

const MONGO = `
type Address {
  street String
  city   String
}

model Customer {
  id      String   @id @default(auto()) @map("_id") @db.ObjectId
  name    String
  address Address?
  tags    String[]
}
`

const NAMES = `
model Category {
  id       Int        @id
  parentId Int?
  parent   Category?  @relation("Sub", fields: [parentId], references: [id])
  children Category[] @relation("Sub")
}

model Person {
  id      Int       @id
  address Address[]
}

model Address {
  id       Int    @id
  personId Int
  person   Person @relation(fields: [personId], references: [id])
  zip_code String @map("zip")
}

model Data {
  id    Int    @id
  value String
}

model Status {
  id Int @id
}
`

const MANY = Array.from({ length: 24 }, (_, i) => `
model M${i} {
  id    Int    @id @default(autoincrement())
  name  String
  value Float?${i > 0 ? `\n  m${i - 1}Id Int?\n  m${i - 1}   M${i - 1}? @relation(fields: [m${i - 1}Id], references: [id])` : ''}${i < 23 ? `\n  next  M${i + 1}[]` : ''}
}
`).join('')

const SMALL = `
model Thing {
  id   Int    @id @default(autoincrement())
  name String
}
`

const json = (v) => `${JSON.stringify(v, null, 2)}\n`
const pkg = (extra = {}) => json({ name: 'case', private: true, ...extra })

const cases = {}
const schemaCase = (name, schema, { pkgExtra, tsconfig, more = {} } = {}) => {
  cases[name] = { files: { 'package.json': pkg(pkgExtra), 'prisma/schema.prisma': schema, ...(tsconfig ? { 'tsconfig.json': json(tsconfig) } : {}), ...more }, cwd: '.', args: [] }
}

// Schemas, defaults.
schemaCase('pg-rich', gen() + ds('postgresql') + PG_RICH)
schemaCase('pg-features', gen('  previewFeatures = ["views", "nativeDistinct", "strictUndefinedChecks", "relationJoins", "fullTextSearchPostgres"]') + ds('postgresql', '  schemas  = ["public", "auth"]') + PG_FEATURES)
schemaCase('mysql', gen() + ds('mysql') + MYSQL)
schemaCase('sqlite', gen() + ds('sqlite') + SQLITE)
schemaCase('sqlserver', gen() + ds('sqlserver') + SQLSERVER)
schemaCase('cockroach', gen() + ds('cockroachdb') + COCKROACH)
schemaCase('mongo', gen() + ds('mongodb') + MONGO)
schemaCase('names', gen() + ds('postgresql') + NAMES)
schemaCase('many', gen() + ds('postgresql') + MANY)
schemaCase('empty', gen() + ds('postgresql'))
cases['multi-file'] = {
  files: {
    'package.json': pkg(),
    'prisma/schema/main.prisma': gen('', '../../generated') + ds('postgresql'),
    'prisma/schema/user.prisma': 'model User {\n  id    Int    @id\n  posts Post[]\n}\n',
    'prisma/schema/post.prisma': 'model Post {\n  id     Int  @id\n  userId Int\n  user   User @relation(fields: [userId], references: [id])\n  tag    Tag?\n}\n',
    'prisma/schema/sub/tag.prisma': 'model Tag {\n  id     Int  @id\n  postId Int  @unique\n  post   Post @relation(fields: [postId], references: [id])\n}\n\nenum Color {\n  RED\n  BLUE\n}\n',
  },
  cwd: '.',
  args: ['--schema', 'prisma/schema'],
}

// Generator options, explicit.
for (const [name, extra] of Object.entries({
  'opt-cjs': '  moduleFormat = "cjs"',
  'opt-workerd': '  runtime = "workerd"',
  'opt-cloudflare': '  runtime = "cloudflare"',
  'opt-vercel-edge': '  runtime = "vercel-edge"',
  'opt-edge-light': '  runtime = "edge-light"',
  'opt-deno': '  runtime = "deno"',
  'opt-bun': '  runtime = "bun"',
  'opt-mts': '  generatedFileExtension = "mts"\n  importFileExtension    = "mjs"',
  'opt-cts': '  generatedFileExtension = "cts"',
  'opt-small': '  compilerBuild = "small"',
  'opt-imp-none': '  importFileExtension = ""',
  'opt-esm-js': '  moduleFormat        = "esm"\n  importFileExtension = "js"',
})) {
  schemaCase(name, gen(extra) + ds('postgresql') + PG_RICH)
}
schemaCase('opt-sqlite-workerd', gen('  runtime = "workerd"') + ds('sqlite') + SQLITE)

// What the generator infers from tsconfig.json and package.json.
const infer = (name, { tsconfig, pkgExtra, more } = {}) => schemaCase(name, gen() + ds('postgresql') + SMALL, { tsconfig, pkgExtra, more })
infer('inf-none-type-module', { pkgExtra: { type: 'module' } })
infer('inf-commonjs', { tsconfig: { compilerOptions: { module: 'commonjs' } } })
infer('inf-nodenext-module', { tsconfig: { compilerOptions: { module: 'nodenext' } }, pkgExtra: { type: 'module' } })
infer('inf-nodenext-notype', { tsconfig: { compilerOptions: { module: 'nodenext' } } })
infer('inf-node16-commonjs', { tsconfig: { compilerOptions: { module: 'Node16' } }, pkgExtra: { type: 'commonjs' } })
infer('inf-preserve', { tsconfig: { compilerOptions: { module: 'preserve' } } })
infer('inf-target-preserve', { tsconfig: { compilerOptions: { target: 'ES2022', module: 'preserve' } } })
infer('inf-bundler', { tsconfig: { compilerOptions: { module: 'esnext', moduleResolution: 'Bundler' } } })
infer('inf-ts-ext', { tsconfig: { compilerOptions: { module: 'esnext', moduleResolution: 'bundler', allowImportingTsExtensions: true, noEmit: true } } })
infer('inf-rewrite', { tsconfig: { compilerOptions: { module: 'nodenext', rewriteRelativeImportExtensions: true } }, pkgExtra: { type: 'module' } })
infer('inf-target-only', { tsconfig: { compilerOptions: { target: 'esnext' } } })
infer('inf-target-es5', { tsconfig: { compilerOptions: { target: 'es5' } } })
infer('inf-extends', { tsconfig: { extends: './tsconfig.base.json', compilerOptions: { strict: true } }, more: { 'tsconfig.base.json': json({ compilerOptions: { module: 'commonjs' } }) } })
infer('inf-extends-pkg', { tsconfig: { extends: '@tsconfig/fake/tsconfig.json' }, pkgExtra: { type: 'module' }, more: { 'node_modules/@tsconfig/fake/package.json': json({ name: '@tsconfig/fake', version: '1.0.0' }), 'node_modules/@tsconfig/fake/tsconfig.json': json({ compilerOptions: { module: 'nodenext' } }) } })
infer('inf-extends-override', { tsconfig: { extends: './base.json', compilerOptions: { module: 'esnext' } }, more: { 'base.json': json({ compilerOptions: { module: 'commonjs', moduleResolution: 'bundler' } }) } })
infer('inf-jsonc', { more: { 'tsconfig.json': '{\n  // comment\n  "compilerOptions": {\n    /* block */ "module": "CommonJS",\n  },\n}\n' } })
infer('inf-empty-tsconfig', { tsconfig: {} })
cases['inf-parent-tsconfig'] = {
  files: {
    'tsconfig.json': json({ compilerOptions: { module: 'nodenext' } }),
    'package.json': pkg({ type: 'module' }),
    'pkg/package.json': pkg(),
    'pkg/prisma/schema.prisma': gen() + ds('postgresql') + SMALL,
  },
  cwd: 'pkg',
  args: [],
  output: 'pkg/generated',
}
cases['inf-output-in-src'] = {
  files: {
    'package.json': pkg({ type: 'module' }),
    'prisma/schema.prisma': gen('', '../src/generated/prisma') + ds('postgresql') + SMALL,
    'src/tsconfig.json': json({ compilerOptions: { module: 'commonjs' } }),
    'src/package.json': json({ type: 'commonjs' }),
  },
  cwd: '.',
  args: [],
  output: 'src/generated/prisma',
}

export { cases }

// A query compiler's files as each case's `prisma` ships them in its build, which a client for an
// edge runtime carries: stand-ins here, their bytes left out of the hash and checked on their own.
export const isQueryCompiler = (path) => /^internal\/query_compiler_\w+_bg\.(?:js|wasm)$/u.test(path)
const PROVIDERS = ['postgresql', 'mysql', 'sqlite', 'sqlserver', 'cockroachdb']
export const queryCompilerFiles = () => Object.fromEntries(['fast', 'small'].flatMap((build) => PROVIDERS.flatMap((provider) => ['wasm', 'mjs'].map((ext) => {
  const name = `query_compiler_${build}_bg.${provider}.${ext}`
  return [`node_modules/prisma/build/${name}`, `stand-in ${name}\n`]
}))))

// The project of case `c` as `prisma generate` of Prisma `version` reads it, in a Vfs: with the
// `prisma` it installs, and the schema the CLI was given with --schema named by a Prisma config.
export function caseVfs(c, version) {
  const files = { ...c.files, ...queryCompilerFiles(), 'node_modules/prisma/package.json': JSON.stringify({ name: 'prisma', version }) }
  const schema = c.args.indexOf('--schema')
  if (schema !== -1) files[posix.join(c.cwd, 'prisma.config.ts')] = `import { defineConfig } from 'prisma/config'\nexport default defineConfig({ schema: '${c.args[schema + 1]}' })\n`
  const vfs = new Vfs()
  for (const [rel, text] of Object.entries(files)) {
    vfs.mkdir(posix.dirname(`/${rel}`), { recursive: true })
    vfs.writeFile(`/${rel}`, text)
  }
  return vfs
}

// A hash of a client's files (path -> text or bytes) but the query compiler's: of each path, in
// order, and the sha256 of its bytes.
export function clientHash(files) {
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const rows = [...files].filter(([path]) => !isQueryCompiler(path)).toSorted(([a], [b]) => (a < b ? -1 : 1)).map(([path, bytes]) => `${path}\0${sha(bytes)}\n`)
  return sha(rows.join(''))
}
