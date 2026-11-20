import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { buildBundle } from '../stasis/src/cmd/bundle.js'
import { nextAppFiles, nextConfigIn, withNextEntries } from '../stasis/src/next-entries.js'
import { buildGitHubBundle, suggestedEntries } from '../stasis/src/vfs-bundle.js'
import { fakeClient, json, lockfile, vfsOf } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

// A next.config.* entry stands for the files `next build` takes as the app's entries.

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')

const writeTree = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
}

const filesOf = (dir, files, config = 'next.config.mjs') => {
  writeTree(dir, { 'package.json': { name: 'web', version: '1.0.0', private: true }, [config]: 'export default {}\n', ...files })
  return nextAppFiles('t', join(dir, config))
}

const readBundle = (path) => Bundle.parse(brotliDecompressSync(readFileSync(path)).toString('utf8'))

const runCli = async (args, cwd) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))
  const child = spawn(process.execPath, [cli, ...args], { cwd, env })
  child.stdin.end()
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const [status] = await once(child, 'close')
  return { status, stderr }
}

test('nextAppFiles takes the App Router files Next builds, as it finds them', withTmp((t, tmp) => {
  const taken = [
    'app/(marketing)/about/page.tsx',
    'app/@modal/(..)photo/[id]/page.tsx',
    'app/@modal/default.tsx',
    'app/api/hello/route.ts',
    'app/blog/[slug]/error.tsx',
    'app/blog/[slug]/forbidden.tsx',
    'app/blog/[slug]/loading.tsx',
    'app/blog/[slug]/not-found.tsx',
    'app/blog/[slug]/opengraph-image.tsx',
    'app/blog/[slug]/page.jsx',
    'app/blog/[slug]/unauthorized.tsx',
    'app/blog/icon2.tsx',
    'app/blog/sitemap.ts',
    'app/blog/template.js',
    'app/global-error.tsx',
    'app/global-not-found.tsx',
    'app/icon.tsx',
    'app/layout.tsx',
    'app/manifest.ts',
    'app/page.tsx',
    'app/robots.ts',
    'app/twitter-image1.tsx',
    'instrumentation-client.ts',
    'instrumentation.ts',
    'proxy.ts',
  ]
  const left = [
    // A private folder is no route, nor anything under it; nor is a file of no convention's name.
    'app/_components/page.tsx',
    'app/blog/_drafts/x/page.tsx',
    'app/components/button.tsx',
    'app/page.test.tsx',
    'app/layout.css',
    // Directly in the app directory only.
    'app/blog/robots.ts',
    'app/blog/manifest.ts',
    'app/blog/global-error.tsx',
    // A static metadata file is no code, and other extensions no page's.
    'app/favicon.ico',
    'app/icon.png',
    'app/sitemap.xml',
    'app/page.mjs',
    'app/blog/icon12.tsx',
    // Not beside the app directory.
    'src/proxy.ts',
    'app/instrumentation.ts',
    'lib/proxy.ts',
  ]
  t.assert.deepStrictEqual(filesOf(tmp, Object.fromEntries([...taken, ...left].map((file) => [file, '']))), taken)
}))

test('nextAppFiles takes every page of the Pages Router, beside the app directory\'s', withTmp((t, tmp) => {
  const files = filesOf(tmp, {
    'pages/_app.tsx': '',
    'pages/_document.tsx': '',
    'pages/index.tsx': '',
    'pages/404.js': '',
    'pages/api/hello.ts': '',
    'pages/blog/[slug].jsx': '',
    'pages/blog/_helper.ts': '',
    // A declaration file is no page, where `ts` is a page extension; nor a file of none.
    'pages/types.d.ts': '',
    'pages/readme.md': '',
    'app/page.tsx': '',
    'middleware.js': '',
  })
  t.assert.deepStrictEqual(files, ['app/page.tsx', 'middleware.js', 'pages/404.js', 'pages/_app.tsx', 'pages/_document.tsx', 'pages/api/hello.ts', 'pages/blog/[slug].jsx', 'pages/blog/_helper.ts', 'pages/index.tsx'])
}))

test('nextAppFiles takes src/app and src/pages where the app has none of its own', withTmp(async (t, tmp) => {
  // Its proxy and instrumentation beside them, in src/; the client's instrumentation in src/ before the root.
  t.assert.deepStrictEqual(filesOf(join(tmp, 'a'), {
    'src/app/page.tsx': '',
    'src/pages/index.tsx': '',
    'src/proxy.ts': '',
    'src/instrumentation.ts': '',
    'src/instrumentation-client.ts': '',
    'instrumentation-client.ts': '',
    'proxy.ts': '',
  }), ['src/app/page.tsx', 'src/instrumentation-client.ts', 'src/instrumentation.ts', 'src/pages/index.tsx', 'src/proxy.ts'])
  // An app directory of its own is the app's, its src/ one left alone; the client's instrumentation at the root.
  t.assert.deepStrictEqual(filesOf(join(tmp, 'b'), { 'app/page.tsx': '', 'src/app/page.tsx': '', 'instrumentation-client.js': '' }), ['app/page.tsx', 'instrumentation-client.js'])
  t.assert.throws(() => filesOf(join(tmp, 'c'), { 'app/page.tsx': '', 'src/pages/index.tsx': '' }), /^Error: t: .*next\.config\.mjs: its app's pages and app directories are not in the same directory \(.*src\/pages, .*app\), which Next refuses$/u)
  // None at all: no app, the config alone.
  t.assert.equal(filesOf(join(tmp, 'd'), { 'src/index.ts': '', 'pages.ts': '' }), null)
}))

test('nextAppFiles takes the pageExtensions the config lists, and refuses those it can\'t read', withTmp((t, tmp) => {
  const tree = { 'app/page.tsx': '', 'app/page.page.tsx': '', 'app/x/route.page.ts': '', 'pages/index.page.tsx': '', 'pages/util.tsx': '', 'pages/a.page.test.tsx': '' }
  // As a property, quoted or not, or assigned, in a config of any of Next's names.
  const configs = {
    'next.config.mjs': "export default { pageExtensions: ['page.tsx', 'page.ts'] }\n",
    'next.config.js': "module.exports = { 'pageExtensions': [\"page.tsx\", 'page.ts'] }\n",
    'next.config.ts': "import type { NextConfig } from 'next'\nconst config: NextConfig = {}\nconfig.pageExtensions = ['page.tsx', 'page.ts']\nexport default config satisfies NextConfig\n",
  }
  for (const [config, source] of Object.entries(configs)) {
    t.assert.deepStrictEqual(filesOf(join(tmp, config.split('.').at(-1)), { ...tree, [config]: source }, config), ['app/page.page.tsx', 'app/x/route.page.ts', 'pages/index.page.tsx'], config)
  }
  const refused = {
    variable: "const pageExtensions = ['tsx']\nexport default { pageExtensions }\n",
    spread: "const base = ['tsx']\nexport default { pageExtensions: [...base, 'ts'] }\n",
    template: 'export default { pageExtensions: [`${"t"}sx`] }\n',
    empty: 'export default { pageExtensions: [] }\n',
    path: "export default { pageExtensions: ['a/tsx'] }\n",
    call: "export default { pageExtensions: ['tsx', 'ts'].concat(['mdx']) }\n",
  }
  for (const [what, source] of Object.entries(refused)) {
    t.assert.throws(() => filesOf(join(tmp, what), { 'app/page.tsx': '', 'next.config.mjs': source }), /^Error: t: .*next\.config\.mjs sets pageExtensions other than as a list of extensions \(at offset \d+\), which can't be read without running it: name the app's entries instead$/u, what)
  }
  t.assert.throws(() => filesOf(join(tmp, 'twice'), { 'app/page.tsx': '', 'next.config.mjs': "const a = { pageExtensions: ['tsx'] }\nexport default { ...a, pageExtensions: ['ts'] }\n" }), /sets pageExtensions to different lists, which can't be told apart without running it/u)
  // An extension that is no JS/TS (MDX) is refused where a file has it, only.
  const mdx = "export default { pageExtensions: ['tsx', 'mdx'] }\n"
  t.assert.deepStrictEqual(filesOf(join(tmp, 'mdx'), { 'app/page.tsx': '', 'next.config.mjs': mdx }), ['app/page.tsx'])
  t.assert.throws(() => filesOf(join(tmp, 'mdx'), { 'app/blog/page.mdx': '', 'next.config.mjs': mdx }), /^Error: t: .*app\/blog\/page\.mdx is one of the app's entries by .*next\.config\.mjs's pageExtensions, and no JS\/TS file the scan can follow: name the app's entries instead$/u)
  // One that doesn't parse leaves the default, its error the scan's.
  t.assert.deepStrictEqual(filesOf(join(tmp, 'broken'), { 'app/page.tsx': '', 'app/page.page.tsx': '', 'next.config.mjs': 'export default { pageExtensions: [\n' }), ['app/page.tsx'])
}))

test('nextAppFiles follows links as Next lists the app directory', withTmp((t, tmp) => {
  writeTree(tmp, { 'shared/routes/page.tsx': '', 'shared/layout.tsx': '' })
  const app = join(tmp, 'web')
  writeTree(app, { 'package.json': { name: 'web', version: '1.0.0' }, 'next.config.mjs': 'export default {}\n', 'app/page.tsx': '' })
  symlinkSync(join(tmp, 'shared', 'routes'), join(app, 'app', 'linked'))
  symlinkSync(join(tmp, 'shared', 'layout.tsx'), join(app, 'app', 'layout.tsx'))
  symlinkSync(join(tmp, 'nowhere'), join(app, 'app', 'broken'))
  // A link back up is walked once, by the path it is first reached at.
  symlinkSync(join(app, 'app'), join(app, 'app', 'loop'))
  t.assert.deepStrictEqual(nextAppFiles('t', join(app, 'next.config.mjs')), ['app/layout.tsx', 'app/linked/page.tsx', 'app/page.tsx'])
}))

test('withNextEntries spells an app\'s files from its next.config.* entry, each once', withTmp((t, tmp) => {
  writeTree(join(tmp, 'apps/web'), { 'package.json': { name: 'web', version: '1.0.0' }, 'next.config.ts': 'export default {}\n', 'app/page.tsx': '', 'app/layout.tsx': '' })
  writeTree(tmp, { 'apps/cli.ts': '', 'apps/none/next.config.js': 'module.exports = {}\n' })
  t.assert.deepStrictEqual(withNextEntries('t', ['apps/cli.ts', './apps/web/app/page.tsx', 'apps/web/next.config.ts', 'apps/web/app/layout.tsx'], tmp), ['apps/cli.ts', './apps/web/app/page.tsx', 'apps/web/next.config.ts', 'apps/web/app/layout.tsx'])
  t.assert.deepStrictEqual(withNextEntries('t', ['apps/web/next.config.ts'], tmp), ['apps/web/next.config.ts', 'apps/web/app/layout.tsx', 'apps/web/app/page.tsx'])
  t.assert.deepStrictEqual(withNextEntries('t', ['next.config.ts'], join(tmp, 'apps/web')), ['next.config.ts', 'app/layout.tsx', 'app/page.tsx'])
  // A config with no app beside it, and one that isn't there (the build's to refuse), are themselves alone.
  t.assert.deepStrictEqual(withNextEntries('t', ['apps/none/next.config.js', 'apps/gone/next.config.js'], tmp), ['apps/none/next.config.js', 'apps/gone/next.config.js'])
  t.assert.deepStrictEqual(withNextEntries('t', ['apps/cli.ts'], tmp), ['apps/cli.ts'])
  t.assert.equal(nextConfigIn(join(tmp, 'apps/web')), 'next.config.ts')
  t.assert.equal(nextConfigIn(join(tmp, 'apps')), undefined)
}))

// An app whose pages import the code they share by its tsconfig alias, `@/`.
const nextApp = {
  'package.json': json({ name: 'web', version: '1.0.0', private: true }),
  'tsconfig.json': json({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
  'next.config.mjs': "import { headers } from './lib/headers.mjs'\nexport default { headers }\n",
  'lib/headers.mjs': 'export const headers = async () => []\n',
  'lib/title.ts': "export const title: string = 'web'\n",
  'components/nav.tsx': "import { title } from '@/lib/title'\nexport const Nav = () => <nav>{title}</nav>\n",
  'components/unused.tsx': 'export const Unused = () => null\n',
  'app/layout.tsx': "import { Nav } from '@/components/nav'\nexport default function Layout({ children }: { children: unknown }) { return <body><Nav />{children}</body> }\n",
  'app/page.tsx': "import { title } from '../lib/title'\nexport default function Page() { return <h1>{title}</h1> }\n",
  'app/api/hello/route.ts': "export const GET = () => Response.json({ hello: 'world' })\n",
  'proxy.ts': 'export function proxy() {}\n',
}
const NEXT_ENTRIES = ['next.config.mjs', 'app/api/hello/route.ts', 'app/layout.tsx', 'app/page.tsx', 'proxy.ts']
const NEXT_SOURCES = [...NEXT_ENTRIES, 'components/nav.tsx', 'lib/headers.mjs', 'lib/title.ts'].toSorted()

test('stasis bundle builds a next.config.* entry as the app\'s entries, with the entry\'s options', withTmp(async (t, tmp) => {
  writeTree(tmp, nextApp)
  const bundle = await buildBundle({ cwd: tmp, entries: ['next.config.mjs'], typescript: true })
  t.assert.deepStrictEqual([...bundle.entries].toSorted(), NEXT_ENTRIES.toSorted())
  t.assert.deepStrictEqual([...bundle.sources.keys()].toSorted(), NEXT_SOURCES)
  // Named in stasis.config.json's entries, its options are those of every file of the app.
  writeTree(tmp, { 'stasis.config.json': { entries: { 'next.config.mjs': { typescript: true } } } })
  const r = await runCli(['bundle', '--output=web.br'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  const configured = readBundle(join(tmp, 'web.br'))
  t.assert.deepStrictEqual([...configured.entries].toSorted(), NEXT_ENTRIES.toSorted())
  t.assert.deepStrictEqual([...configured.sources.keys()].toSorted(), NEXT_SOURCES)
}))

// A Turborepo-style pnpm workspace, the Next app in apps/web.
const workspace = {
  'package.json': json({ name: 'root', version: '1.0.0', private: true }),
  'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
  'pnpm-lock.yaml': lockfile('.', 'apps/web'),
  ...Object.fromEntries(Object.entries(nextApp).map(([file, content]) => [`apps/web/${file}`, content])),
}

test('buildGitHubBundle takes a Next app\'s next.config.* for its entries, and stands it for its files', async (t) => {
  // From the app's directory, its paths are the app's; from the root, the workspace's.
  const cases = { directory: [{ directory: 'apps/web' }, ''], path: [{ path: 'apps/web/next.config.mjs' }, ''], entry: [{ entries: ['apps/web/next.config.mjs'] }, 'apps/web/'] }
  await Promise.all(Object.entries(cases).map(async ([what, [options, at]]) => {
    const { bundle } = await buildGitHubBundle({ github: 'ExodusOSS/example', sha: 'a'.repeat(40), packageManager: 'pnpm', client: fakeClient(workspace), typescript: true, ...options })
    t.assert.deepStrictEqual([...bundle.entries].toSorted(), NEXT_ENTRIES.map((file) => `${at}${file}`).toSorted(), what)
    t.assert.deepStrictEqual([...bundle.sources.keys()].toSorted(), NEXT_SOURCES.map((file) => `${at}${file}`), what)
  }))
  // Without --typescript, which the `@/` alias takes, built with it all the same.
  const { bundle } = await buildGitHubBundle({ github: 'ExodusOSS/example', sha: 'a'.repeat(40), packageManager: 'pnpm', client: fakeClient(workspace), directory: 'apps/web' })
  t.assert.deepStrictEqual([...bundle.sources.keys()].toSorted(), NEXT_SOURCES)
  // A package.json naming an entry keeps it, its next.config.* left out.
  const named = { ...workspace, 'apps/web/package.json': json({ name: 'web', version: '1.0.0', main: 'lib/headers.mjs' }) }
  t.assert.deepStrictEqual(await suggestedEntries({ vfs: vfsOf(named), cwd: '/apps/web' }), ['lib/headers.mjs'])
  t.assert.deepStrictEqual(await suggestedEntries({ vfs: vfsOf(workspace), cwd: '/apps/web' }), ['next.config.mjs'])
})
