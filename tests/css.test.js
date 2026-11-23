import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliDecompressSync } from 'node:zlib'

import { Bundle } from '@exodus/stasis-core/bundle'
import { classifyExtension, classifyFormat } from '@exodus/stasis-core/util'
import { buildBundle } from '../stasis/src/cmd/bundle.js'
import { cssRequests, cssSpecifiers } from '../stasis/src/css.js'
import { buildGitHubBundle } from '../stasis/src/vfs-bundle.js'
import { fakeClient, json, lockfile } from './vfs-bundle-github.helper.js'
import { withTmp } from './tmp.helper.js'

// A stylesheet is code, format `css`, and its imports are followed as webpack's css-loader follows them.

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'stasis', 'bin', 'stasis.js')

const writeTree = (dir, files) => {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
}

const runCli = async (args, cwd) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))
  const child = spawn(process.execPath, [cli, ...args], { cwd, env })
  child.stdin.end()
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  const [status] = await once(child, 'close')
  return { status, stderr }
}

const edgesOf = (bundle) => Object.fromEntries([...bundle.imports.get('*') ?? []].map(([parent, specs]) => [parent, Object.fromEntries(specs)]))

test('cssSpecifiers reads a stylesheet\'s imports off its tokens, as css-loader takes them', (t) => {
  const css = [
    '﻿@charset "utf-8";',
    "@import 'tailwindcss';",
    '@import url(./theme.css) layer(theme);',
    '@import /* a comment */ url("./a b.css") screen and (min-width: 1px);',
    "/* @import './commented.css'; url(./commented.png) */",
    '.a { background: url( ./img/bg.png ); content: "url(./not-a-url.png)"; }',
    '.b { background-image: -webkit-image-set("x.avif" type("image/avif") 1x, url(y.png) 2x); }',
    "@font-face { src: url('./f.woff2?v=1#iefix') format('woff2'), local('Font'); }",
    '.c { color: red; composes: a b from "./other.module.css"; }',
    '.d { composes: e from global; }',
    "@value primary, secondary from './colors.css';",
    '@value spacing: 4px;',
    String.raw`.e { background: url(\2e/escaped.png), URL(upper.png), url(bad url.png), url(ok.png); }`,
    '.f { --v: url(var.png); }',
    '.g { b: u\\72l(spelled.png); }',
  ].join('\n')
  t.assert.deepStrictEqual(cssSpecifiers(css), [
    { kind: 'css-import', spec: 'tailwindcss' },
    { kind: 'css-import', spec: './theme.css' },
    { kind: 'css-import', spec: './a b.css' },
    { kind: 'css-url', spec: './img/bg.png' },
    { kind: 'css-url', spec: 'x.avif' },
    { kind: 'css-url', spec: 'y.png' },
    { kind: 'css-url', spec: './f.woff2?v=1#iefix' },
    { kind: 'css-composes', spec: './other.module.css' },
    { kind: 'css-composes', spec: './colors.css' },
    { kind: 'css-url', spec: './escaped.png' },
    { kind: 'css-url', spec: 'upper.png' },
    { kind: 'css-url', spec: 'ok.png' },
    { kind: 'css-url', spec: 'var.png' },
    { kind: 'css-url', spec: 'spelled.png' },
  ])
  // No import where the grammar has none: a selector, a property named like one, a string out of url()/image-set().
  t.assert.deepStrictEqual(cssSpecifiers('.composes:hover { x: "a.css" } .url { y: 1 } @media print { .z { composes: k; } }'), [])
  // Nor an at-rule's prelude, where a url() tests a feature or names a namespace, loading nothing; its block's
  // declarations do, nested ones too, as an @import's specifier and an @value's `from` are imports.
  t.assert.deepStrictEqual(cssSpecifiers([
    '@supports (background: url(missing.png)) { .x { background: url(kept.png); b: image-set("set.png" 1x) } }',
    '@import url(a.css) supports(background: url(feature.png));',
    '@namespace svg url(http://www.w3.org/2000/svg);',
    '@value x from "./v.css";',
    '.a { @media (min-width: 1px) { background: url(nested.png) } }',
  ].join('\n')), [
    { kind: 'css-url', spec: 'kept.png' },
    { kind: 'css-url', spec: 'set.png' },
    { kind: 'css-import', spec: 'a.css' },
    { kind: 'css-composes', spec: './v.css' },
    { kind: 'css-url', spec: 'nested.png' },
  ])
})

test('cssRequests: what a URL requests, relative first, none for one naming no file', (t) => {
  const cases = {
    'x.css': ['./x.css', 'x.css'],
    tailwindcss: ['./tailwindcss', 'tailwindcss'],
    './a.css': ['./a.css'],
    '../a.css': ['../a.css'],
    '~bootstrap/dist/css/bootstrap.css': ['bootstrap/dist/css/bootstrap.css'],
    'font.woff2?v=1#iefix': ['./font.woff2', 'font.woff2'],
    'a%20b.png': ['./a b.png', 'a b.png'],
    // A reserved character decodes too; a request decoded to a path from the root is none.
    'hash%23mark.svg': ['./hash#mark.svg', 'hash#mark.svg'],
    '%2Fetc%2Fpasswd': [],
    'bad%E0%A4%A.png': ['./bad%E0%A4%A.png', 'bad%E0%A4%A.png'],
    '/public.png': [],
    '//cdn.example.com/x.png': [],
    'https://example.com/x.png': [],
    'data:image/png;base64,AAAA': [],
    '#gradient': [],
    '': [],
    '?query-only': [],
  }
  for (const [spec, requests] of Object.entries(cases)) t.assert.deepStrictEqual(cssRequests(spec), requests, spec)
})

test('a stylesheet is code: format css, whatever resources says', (t) => {
  t.assert.equal(classifyFormat('app/globals.css'), 'css')
  t.assert.equal(classifyFormat('APP.CSS'), 'css')
  t.assert.equal(classifyExtension('a.css', new Set()), 'code')
  t.assert.equal(classifyExtension('a.css', new Set(['css'])), 'code')
  // A preprocessor's stylesheet is none: a resource where resources names it.
  t.assert.equal(classifyExtension('a.scss', new Set(['scss'])), 'resource')
  t.assert.equal(classifyExtension('a.scss', new Set()), 'unknown')
})

// An app whose stylesheet imports another, a package's by its `style` export and one by `~`, an image and a font by
// url(), and a CSS module composing another; beside URLs that name no file.
const app = {
  'package.json': json({ name: 'app', version: '1.0.0', type: 'module' }),
  'src/entry.js': "import './styles.css'\nimport styles from './button.module.css'\nexport default styles\n",
  'src/styles.css': [
    '@import "theme";',
    '@import "~kit/reset.css";',
    '@import "./base.css" layer(base);',
    "@font-face { font-family: F; src: url('./fonts/f.woff2?v=2#iefix') format('woff2'); }",
    'body { background: url(data:image/png;base64,AAAA), url(/grid.svg), url(https://example.com/x.png), url(#g); }',
    '',
  ].join('\n'),
  'src/base.css': '.base { background: url(./img/bg.png) }\n',
  'src/button.module.css': '.button { composes: base from "./base.css"; }\n',
  'src/img/bg.png': 'PNG',
  'src/fonts/f.woff2': 'WOFF2',
  'node_modules/theme/package.json': json({ name: 'theme', version: '1.0.0', exports: { '.': { style: './theme.css', default: './index.js' } } }),
  'node_modules/theme/theme.css': ':root { --c: red }\n',
  'node_modules/theme/index.js': 'export default 1\n',
  'node_modules/kit/package.json': json({ name: 'kit', version: '1.0.0', main: 'index.js' }),
  'node_modules/kit/reset.css': '* { margin: 0 }\n',
}

test('stasis bundle follows a stylesheet\'s imports, each as css-loader resolves it', withTmp(async (t, tmp) => {
  writeTree(tmp, app)
  const bundle = await buildBundle({ cwd: tmp, entries: ['src/entry.js'], resources: ['png', 'woff2'] })
  t.assert.deepStrictEqual(Object.fromEntries([...bundle.formats].toSorted(([a], [b]) => a.localeCompare(b))), {
    'node_modules/kit/reset.css': 'css',
    'node_modules/theme/theme.css': 'css',
    'src/base.css': 'css',
    'src/button.module.css': 'css',
    'src/entry.js': 'module',
    'src/fonts/f.woff2': 'resource',
    'src/img/bg.png': 'resource',
    'src/styles.css': 'css',
  })
  const edges = edgesOf(bundle)
  t.assert.deepStrictEqual(edges['src/styles.css'], {
    theme: 'node_modules/theme/theme.css',
    '~kit/reset.css': 'node_modules/kit/reset.css',
    './base.css': 'src/base.css',
    './fonts/f.woff2?v=2#iefix': 'src/fonts/f.woff2',
  })
  t.assert.deepStrictEqual(edges['src/base.css'], { './img/bg.png': 'src/img/bg.png' })
  t.assert.deepStrictEqual(edges['src/button.module.css'], { './base.css': 'src/base.css' })
  // A stylesheet as an entry, and `css` among the resources, which changes nothing.
  const own = await buildBundle({ cwd: tmp, entries: ['src/styles.css'], resources: ['css', 'png', 'woff2'] })
  t.assert.deepStrictEqual([...own.entries], ['src/styles.css'])
  t.assert.equal(own.formats.get('src/styles.css'), 'css')
  t.assert.equal(own.formats.get('src/img/bg.png'), 'resource')
}))

test('a stylesheet\'s miss breaks the build where it is linked eagerly, as an import\'s does', withTmp(async (t, tmp) => {
  writeTree(tmp, { ...app, 'src/base.css': '@import "./gone.css";\n' })
  await t.assert.rejects(buildBundle({ cwd: tmp, entries: ['src/entry.js'], resources: ['png', 'woff2'] }), /unresolved css-import \.\/gone\.css from src\/base\.css \(MODULE_NOT_FOUND\)/u)
  // What it names that no resources entry carries.
  writeTree(tmp, app)
  await t.assert.rejects(buildBundle({ cwd: tmp, entries: ['src/entry.js'], resources: ['png'] }), /\.\/fonts\/f\.woff2\?v=2#iefix from src\/styles\.css resolves to src\/fonts\/f\.woff2, which a source bundle can't carry/u)
  // Past an import(), a warning.
  writeTree(tmp, { ...app, 'src/entry.js': "export const load = () => import('./base.css')\n", 'src/base.css': '@import "./gone.css";\n' })
  const lazy = await buildBundle({ cwd: tmp, entries: ['src/entry.js'] })
  t.assert.deepStrictEqual([...lazy.formats.keys()].toSorted(), ['src/base.css', 'src/entry.js'])
}))

test('a url() names the file its decoded path does, and one testing a feature names none', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': json({ name: 'app', version: '1.0.0' }),
    'entry.css': "@supports (background: url(missing.png)) { .x { background: url('./hash%23mark.svg') } }\n",
    'hash#mark.svg': '<svg/>',
  })
  const bundle = await buildBundle({ cwd: tmp, entries: ['entry.css'], resources: ['svg', 'png'] })
  t.assert.deepStrictEqual(edgesOf(bundle)['entry.css'], { './hash%23mark.svg': 'hash#mark.svg' })
}))

test('a stylesheet that is no UTF-8 text fails as one that doesn\'t parse', withTmp(async (t, tmp) => {
  writeTree(tmp, { 'package.json': json({ name: 'app', version: '1.0.0' }), 'entry.js': "require('./a.css')\n" })
  writeFileSync(join(tmp, 'a.css'), Buffer.from([0x2E, 0x61, 0x7B, 0xFF, 0xFE, 0x7D]))
  await t.assert.rejects(buildBundle({ cwd: tmp, entries: ['entry.js'] }), /parse error in a\.css: not UTF-8 text/u)
}))

test('stasis build builds a bundle\'s stylesheets with esbuild\'s css loader, from the bundle alone', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': json({ name: 'app', version: '1.0.0', type: 'module' }),
    'src/entry.js': "import './styles.css'\nconsole.log('hi')\n",
    'src/styles.css': '@import "./base.css";\n.x { background: url(./img.png) }\n.y { mask: url(\'./icons.svg#check\') }\n',
    'src/base.css': '.base { margin: 0 }\n',
    'src/img.png': 'PNG',
    'src/icons.svg': '<svg/>',
  })
  let r = await runCli(['bundle', '--resources=png,svg', 'src/entry.js'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  rmSync(join(tmp, 'src'), { recursive: true })
  r = await runCli(['build', '--output=out/entry.js', '--loader=.png:file', '--loader=.svg:file', 'stasis.code.br', 'src/entry.js'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  const css = readFileSync(join(tmp, 'out', 'entry.css'), 'utf8')
  t.assert.match(css, /\.base \{\n {2}margin: 0;\n\}/u)
  t.assert.match(css, /background: url\("\.\/img-[A-Z0-9]+\.png"\)/u)
  // A URL's fragment, which the scan resolves the file without, is the emitted URL's still.
  t.assert.match(css, /mask: url\("\.\/icons-[A-Z0-9]+\.svg#check"\)/u)
}))

test('github-bundle follows a stylesheet into a workspace package through its link', async (t) => {
  const files = {
    'package.json': json({ name: 'root', version: '1.0.0', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    'pnpm-lock.yaml': lockfile('.', 'packages/app', 'packages/ui').replace('  packages/app: {}\n', '  packages/app:\n    dependencies:\n      ui:\n        specifier: workspace:*\n        version: link:../ui\n'),
    'packages/ui/package.json': json({ name: 'ui', version: '1.0.0', style: './styles/index.css' }),
    'packages/ui/styles/index.css': '@import "./tokens.css";\n',
    'packages/ui/styles/tokens.css': ':root { --c: red }\n',
    'packages/app/package.json': json({ name: 'app', version: '1.0.0', dependencies: { ui: 'workspace:*' } }),
    'packages/app/src/entry.js': "require('./app.css')\n",
    'packages/app/src/app.css': '@import "ui";\n',
  }
  const { bundle } = await buildGitHubBundle({ github: 'ExodusOSS/example', sha: 'a'.repeat(40), packageManager: 'pnpm', client: fakeClient(files), entries: ['packages/app/src/entry.js'] })
  t.assert.deepStrictEqual(Object.fromEntries(bundle.formats), {
    'packages/app/src/entry.js': 'commonjs',
    'packages/app/src/app.css': 'css',
    'packages/ui/styles/index.css': 'css',
    'packages/ui/styles/tokens.css': 'css',
  })
  t.assert.equal(edgesOf(bundle)['packages/app/src/app.css'].ui, 'packages/ui/styles/index.css')
})

test('a stylesheet an fs capture or `extra` reads is code too, with no resources entry', withTmp(async (t, tmp) => {
  writeTree(tmp, {
    'package.json': json({ name: 'app', version: '1.0.0' }),
    'entry.js': 'module.exports = 1\n',
    'print.css': '@media print { body { margin: 0 } }\n',
    'stasis.config.json': json({ extra: ['print.css'] }),
  })
  const r = await runCli(['bundle', '--output=out.br', 'entry.js'], tmp)
  t.assert.equal(r.status, 0, r.stderr)
  const bundle = Bundle.parse(brotliDecompressSync(readFileSync(join(tmp, 'out.br'))).toString('utf8'))
  t.assert.equal(bundle.formats.get('print.css'), 'css')
}))
