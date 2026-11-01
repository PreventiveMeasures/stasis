import { test } from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fieldResolverFor } from '../stasis/src/cmd/bundle.js'
import { createMetroResolver } from '../stasis/src/metro-resolver.js'

// The built-in --metro resolver against the real metro-resolver, over one generated project: every
// case resolved under both, on every platform, from a require and from an import, must land alike.
// metro-resolver is a workspace devDependency for these tests; each project links the installed
// copy (its real path, so its own dependencies resolve) into its node_modules.
const metroResolverDir = (() => {
  try {
    return realpathSync(dirname(createRequire(import.meta.url).resolve('metro-resolver/package.json')))
  } catch {
    return null
  }
})()
const ifMetro = { skip: metroResolverDir ? false : 'metro-resolver not installed' }

const nm = (pkg, files) => Object.fromEntries(Object.entries(files).map(([rel, content]) => [`node_modules/${pkg}/${rel}`, content]))

const PROJECT = {
  'package.json': { name: 'app', version: '1.0.0', imports: { '#exact': './src/a.js', '#pat/*': './src/*', '#cond': { 'react-native': './src/b.js', default: './src/a.js' }, '#dir/*': './src/*/index.js' } },
  'index.js': '',
  'src/x/y.js': '',
  // Relative imports: exact, extensionless, platform and native suffixes, directories, assets.
  'src/a.js': '', 'src/b.ios.js': '', 'src/b.js': '', 'src/b.web.js': '', 'src/c.native.js': '', 'src/d/index.js': '',
  'src/e/package.json': { main: 'lib/main.js' }, 'src/e/lib/main.js': '',
  'src/f/index.ios.js': '', 'src/f/index.js': '', 'src/g.json': '{}', 'src/k.js': '', 'src/k/index.js': '',
  'src/n.ts': '', 'src/p.jsx': '', 'src/q.ios.js': '', 'src/r/package.json': { main: 'lib/main' }, 'src/r/lib/main.js': '',
  'src/s/package.json': { 'react-native': 'rn.js', main: 'main.js' }, 'src/s/rn.js': '', 'src/s/main.js': '',
  'src/t.d.ts': '', 'src/v/index.native.js': '', 'src/w.js.ios.js': '', 'src/w.js': '', 'src/img.png': 'x', 'src/img2@2x.png': 'x',
  // Packages: main fields, browser maps, directories, suffixes.
  ...nm('pkg', { 'package.json': { name: 'pkg', main: 'lib/index.js' }, 'lib/index.js': '', 'lib/index.ios.js': '', 'lib/sub.js': '', 'lib/sub2.ios.js': '', 'lib/dir/index.js': '' }),
  ...nm('rnpkg', { 'package.json': { name: 'rnpkg', 'react-native': 'rn.js', browser: 'browser.js', main: 'main.js' }, 'rn.js': '', 'browser.js': '', 'main.js': '' }),
  ...nm('brpkg', { 'package.json': { name: 'brpkg', main: 'lib/a.js', browser: { './lib/a.js': './lib/a-browser.js', other: false, './lib/gone.js': false } }, 'lib/a.js': '', 'lib/a-browser.js': '', 'lib/gone.js': '' }),
  ...nm('extless', { 'package.json': { name: 'extless', main: 'lib/index' }, 'lib/index.js': '', 'lib/index.ios.js': '' }),
  ...nm('maindir', { 'package.json': { name: 'maindir', main: 'lib' }, 'lib/index.js': '' }),
  ...nm('@scope/pkg', { 'package.json': { name: '@scope/pkg' }, 'index.js': '' }),
  ...nm('suffix', { 'package.json': { name: 'suffix', main: 'index.js' }, 'index.js': '', 'index.ios.js': '' }),
  ...nm('nomain', { 'package.json': { name: 'nomain' }, 'index.js': '', 'index.ios.js': '' }),
  // `exports`: conditions, patterns and their order, null targets, and what Metro refuses.
  ...nm('expkg', { 'package.json': { name: 'expkg', exports: { '.': { 'react-native': './rn.js', default: './main.js' }, './feature': './feature.js', './dir/*': './d/*.js' } }, 'rn.js': '', 'main.js': '', 'feature.js': '', 'internal.js': '', 'd/z.js': '' }),
  ...nm('expcond', { 'package.json': { name: 'expcond', main: 'main.js', exports: { import: './esm.js', require: './cjs.js' } }, 'main.js': '', 'esm.js': '', 'cjs.js': '' }),
  ...nm('expnested', { 'package.json': { name: 'expnested', main: 'main.js', exports: { '.': { 'react-native': { import: './rn-esm.js', require: './rn-cjs.js' }, default: './d.js' } } }, 'main.js': '', 'rn-esm.js': '', 'rn-cjs.js': '', 'd.js': '' }),
  ...nm('exppat', {
    'package.json': { name: 'exppat', exports: { './*': './all/*.js', './feat/*': './feat/*.js', './feat/x/*': './fx/*.js', './t/*': './t/*', './t/*.js': './tj/*.js', './m/*/*': './m/*.js' } },
    'all/z.js': '', 'feat/a.js': '', 'fx/b.js': '', 't/q.js': '', 'tj/q.js': '', 'm/x/y.js': '', 'm/x.js': '',
  }),
  ...nm('expnull', { 'package.json': { name: 'expnull', main: 'main.js', exports: { '.': './main.js', './hidden': null, './*': './lib/*.js', './gone/*': null } }, 'main.js': '', 'hidden.js': '', 'lib/hidden.js': '', 'gone/x.js': '', 'lib/gone/x.js': '' }),
  ...nm('expbad', { 'package.json': { name: 'expbad', main: 'main.js', exports: { '.': './exp.js', './x': 'pkg' } }, 'main.js': '', 'exp.js': '', 'x.js': '' }),
  ...nm('expstrbad', { 'package.json': { name: 'expstrbad', main: 'main.js', exports: 'exp.js' }, 'main.js': '', 'exp.js': '' }),
  ...nm('expmixed', { 'package.json': { name: 'expmixed', main: 'main.js', exports: { '.': './exp.js', default: './other.js' } }, 'main.js': '', 'exp.js': '', 'other.js': '' }),
  ...nm('exparr', { 'package.json': { name: 'exparr', main: 'main.js', exports: { '.': ['./exp.js', './main.js'] } }, 'main.js': '', 'exp.js': '' }),
  ...nm('exprootarr', { 'package.json': { name: 'exprootarr', main: 'main.js', exports: ['exp.js', './exp.js'] }, 'main.js': '', 'exp.js': '' }),
  ...nm('exprootbad', { 'package.json': { name: 'exprootbad', main: 'main.js', exports: ['exp.js'] }, 'main.js': '', 'exp.js': '' }),
  ...nm('exprootobj', { 'package.json': { name: 'exprootobj', main: 'main.js', exports: [{ default: './exp.js' }, './main.js'] }, 'main.js': '', 'exp.js': '' }),
  ...nm('explegacy', { 'package.json': { name: 'explegacy', main: 'main.js', exports: { '.': [['./exp.js']] } }, 'main.js': '', 'exp.js': '' }),
  ...nm('expempty', { 'package.json': { name: 'expempty', main: 'main.js', exports: { '.': [] } }, 'main.js': '' }),
  ...nm('expseg', { 'package.json': { name: 'expseg', exports: { './dot': './lib/./dot.js', './nm': './node_modules/dep/index.js', './dbl': './lib//dbl.js', './ok': './lib/ok.js' } }, 'dot.js': '', 'lib/dot.js': '', 'nm.js': '', 'node_modules/dep/index.js': '', 'dbl.js': '', 'lib/dbl.js': '', 'lib/ok.js': '' }),
  ...nm('expprim', { 'package.json': { name: 'expprim', main: 'main.js', exports: { '.': 5, './x': './x.js' } }, 'main.js': '', 'x.js': '', 'y.js': '' }),
  ...nm('exptypes', { 'package.json': { name: 'exptypes', exports: { './t': './t.d.ts', './gone': './gone.js' } }, 't.d.ts': '', 't.js': '', 'gone/index.js': '' }),
  // `imports`: what Metro maps, what it refuses, and its file-based fallback.
  ...nm('depimp', { 'package.json': { name: 'depimp', main: 'index.js', imports: { '#x': './x.js', '#pat/*': './lib/*', '#e': './e', '#d': './dir', '#m': './missing.js' } }, 'index.js': '', 'x.js': '', 'lib/q.js': '', 'e.js': '', 'dir/index.js': '' }),
  ...nm('condimp', { 'package.json': { name: 'condimp', main: 'index.js', imports: { '#c': { node: 'pkg', 'react-native': './rn.js', default: './d.js' }, '#n': { node: 'pkg', default: './d.js' }, '#ir': { import: './i.js', require: './r.js' }, '#own': './own.js' } }, 'index.js': '', 'rn.js': '', 'd.js': '', 'i.js': '', 'r.js': '', 'own.js': '' }),
  ...nm('patimp', { 'package.json': { name: 'patimp', main: 'index.js', imports: { '#p/*': './p/*.js', '#p/deep/*': './deep/*.js', '#p/n/*': null, '#q/*': './q/*.js', '#q/hit': null } }, 'index.js': '', 'p/a.js': '', 'deep/b.js': '', 'p/n/c.js': '', 'q/hit.js': '' }),
  ...nm('bareimp', { 'package.json': { name: 'bareimp', main: 'index.js', imports: { '#dep': 'pkg', '#own': './own.js' } }, 'index.js': '', 'own.js': '' }),
  ...nm('upimp', { 'package.json': { name: 'upimp', main: 'index.js', imports: { '#up': '../pkg/lib/sub.js', '#own': './own.js' } }, 'index.js': '', 'own.js': '' }),
  ...nm('arrimp', { 'package.json': { name: 'arrimp', main: 'index.js', imports: { '#arr': ['./a.js', './b.js'], '#own': './own.js' } }, 'index.js': '', 'a.js': '', 'b.js': '', 'own.js': '' }),
  ...nm('nullimp', { 'package.json': { name: 'nullimp', main: 'index.js', imports: { '#gone': null, '#own': './own.js' } }, 'index.js': '', 'own.js': '' }),
  ...nm('emptyimp', { 'package.json': { name: 'emptyimp', main: 'index.js', imports: {} }, 'index.js': '' }),
  ...nm('keyimp', { 'package.json': { name: 'keyimp', main: 'index.js', imports: { '#a': './a.js', b: './b.js' } }, 'index.js': '', 'a.js': '', 'b.js': '' }),
  ...nm('primimp', { 'package.json': { name: 'primimp', main: 'index.js', imports: { '#a': true, '#b': './b.js' } }, 'index.js': '', 'b.js': '' }),
  ...nm('brimp', { 'package.json': { name: 'brimp', main: 'index.js', imports: { '#x': './x.js' }, browser: { '#y': './y.js', '#gone': false } }, 'index.js': '', 'x.js': '', 'y.js': '' }),
  ...nm('noimp', { 'package.json': { name: 'noimp', main: 'index.js', browser: { '#dep': './shim.js' } }, 'index.js': '', 'shim.js': '' }),
  ...nm('#z', { 'package.json': { name: '#z', main: 'index.js' }, 'index.js': '' }),
  ...nm('scopeimp', { 'package.json': { name: 'scopeimp', main: 'index.js', imports: { '#s': './s.js' } }, 'index.js': '', 's.js': '', 'sub/package.json': {}, 'sub/index.js': '' }),
}

// [importer, specifiers]
const CASES = [
  ['index.js', [
    './src/a', './src/a.js', './src/b', './src/b.js', './src/c', './src/d', './src/d/', './src/e', './src/f', './src/g', './src/g.json', './src/k',
    './src/n', './src/p', './src/q', './src/r', './src/s', './src/t', './src/v', './src/w.js', './src/img.png', './src/img2.png', './src/missing',
    'pkg', 'pkg/lib/sub', 'pkg/lib/sub.js', 'pkg/lib/sub2', 'pkg/lib/dir', 'pkg/lib/index', 'rnpkg', 'brpkg', 'brpkg/lib/a', 'brpkg/lib/a.js',
    'extless', 'maindir', '@scope/pkg', 'suffix', 'nomain', 'nopkg',
    'expkg', 'expkg/feature', 'expkg/internal.js', 'expkg/internal', 'expkg/dir/z', 'expcond', 'expnested',
    'exppat/z', 'exppat/feat/a', 'exppat/feat/x/b', 'exppat/t/q.js', 'exppat/m/x/y', 'expnull', 'expnull/hidden', 'expnull/gone/x',
    'expbad', 'expbad/x', 'expstrbad', 'expmixed', 'exparr', 'exprootarr', 'exprootbad', 'exprootobj', 'explegacy', 'expempty',
    'expseg/dot', 'expseg/nm', 'expseg/dbl', 'expseg/ok', 'expprim', 'expprim/x', 'expprim/y', 'exptypes/t', 'exptypes/gone',
    '#exact', '#pat/a.js', '#pat/a', '#pat/b', '#pat/d', '#cond', '#dir/d', '#missing',
  ]],
  ['src/x/y.js', ['../a', '../../src/b', '..', '../d', '#exact', '#pat/k.js']],
  ['node_modules/brpkg/lib/a.js', ['other', './gone', './gone.js', './a-browser', '../package.json']],
  ['node_modules/depimp/index.js', ['#x', '#pat/q.js', '#pat/q', '#e', '#d', '#m', '#exact']],
  ['node_modules/condimp/index.js', ['#c', '#n', '#ir', '#own']],
  ['node_modules/patimp/index.js', ['#p/a', '#p/deep/b', '#p/n/c', '#q/hit']],
  ['node_modules/bareimp/index.js', ['#dep', '#own']],
  ['node_modules/upimp/index.js', ['#up', '#own']],
  ['node_modules/arrimp/index.js', ['#arr', '#own']],
  ['node_modules/nullimp/index.js', ['#gone', '#own']],
  ['node_modules/emptyimp/index.js', ['#x']],
  ['node_modules/keyimp/index.js', ['#a']],
  ['node_modules/primimp/index.js', ['#a', '#b', '#c']],
  ['node_modules/brimp/index.js', ['#x', '#y', '#gone', '#z']],
  ['node_modules/noimp/index.js', ['#dep', '#z']],
  ['node_modules/scopeimp/sub/index.js', ['#s']],
]

const writeProject = (root) => {
  for (const [rel, content] of Object.entries(PROJECT)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), typeof content === 'string' ? content : JSON.stringify(content))
  }
  if (metroResolverDir) symlinkSync(metroResolverDir, join(root, 'node_modules', 'metro-resolver'), 'dir')
}

const withProject = (fn) => (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stasis-metro-parity-')))
  try {
    writeProject(root)
    return fn(t, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// A resolution as a project-relative path, or a marker.
const shown = (root, resolved) => {
  if (resolved == null) return null
  if (resolved.empty) return '<empty>'
  if (resolved.builtin) return '<builtin>'
  return relative(root, fileURLToPath(resolved.url)).split(/[\\/]/u).join('/')
}

// The built-in resolver as `stasis bundle --metro` builds it, and the adapter as --metro-resolver
// does, for `platform`, each taking a `kind` ('require' or 'import') importer's conditions.
const resolversFor = (root, platform) => {
  const field = fieldResolverFor(platform, { metro: true })
  const metro = metroResolverDir && createMetroResolver({ projectDir: root, platform, mainFields: field.mainFields, conditionNames: ['react-native'] })
  const call = (resolve) => (from, specifier, kind) => shown(root, resolve(join(root, from), specifier, new Set([kind, 'default', ...field.extras])))
  return { builtin: call(field.resolver), metro: metro && call(metro) }
}

test('built-in --metro resolves every case as metro-resolver does, on every platform, from require and import', ifMetro, withProject((t, root) => {
  const differ = []
  for (const platform of ['ios', 'android', 'web']) {
    const { builtin, metro } = resolversFor(root, platform)
    for (const kind of ['require', 'import']) {
      for (const [from, specifiers] of CASES) {
        for (const specifier of specifiers) {
          const [ours, theirs] = [builtin(from, specifier, kind), metro(from, specifier, kind)]
          if (ours !== theirs) differ.push(`${platform} ${kind} ${specifier} from ${from}: built-in ${ours}, metro-resolver ${theirs}`)
        }
      }
    }
  }
  t.assert.deepStrictEqual(differ, [])
}))

// Metro's reading of `exports` and `imports`, pinned: [label, importer, specifier, kind, expected].
const MAP_CASES = [
  ['an exports map with a bare target is refused whole, for main', 'index.js', 'expbad', 'require', 'node_modules/expbad/main.js'],
  ['a refused exports map falls back to the subpath\'s file', 'index.js', 'expbad/x', 'require', 'node_modules/expbad/x.js'],
  ['an exports string not starting ./ is refused', 'index.js', 'expstrbad', 'require', 'node_modules/expstrbad/main.js'],
  ['an exports map mixing subpaths and conditions is refused', 'index.js', 'expmixed', 'require', 'node_modules/expmixed/main.js'],
  ['a subpath\'s fallback array takes its first item', 'index.js', 'exparr', 'require', 'node_modules/exparr/exp.js'],
  ['a root array of strings takes its first ./ string', 'index.js', 'exprootarr', 'require', 'node_modules/exprootarr/exp.js'],
  ['a root array with no ./ string is refused', 'index.js', 'exprootbad', 'require', 'node_modules/exprootbad/main.js'],
  ['a root array of objects takes its first', 'index.js', 'exprootobj', 'require', 'node_modules/exprootobj/exp.js'],
  ['a nested fallback array is refused', 'index.js', 'explegacy', 'require', 'node_modules/explegacy/main.js'],
  ['an empty fallback array is refused', 'index.js', 'expempty', 'require', 'node_modules/expempty/main.js'],
  ['an exact null subpath shadows the patterns, falling back to the file', 'index.js', 'expnull/hidden', 'require', 'node_modules/expnull/hidden.js'],
  ['a null pattern target falls back to the file', 'index.js', 'expnull/gone/x', 'require', 'node_modules/expnull/gone/x.js'],
  ['the pattern with the longest base wins', 'index.js', 'exppat/feat/x/b', 'require', 'node_modules/exppat/fx/b.js'],
  ['between equal bases, the longer pattern wins', 'index.js', 'exppat/t/q.js', 'require', 'node_modules/exppat/tj/q.js'],
  ['a two-* pattern serves no subpath', 'index.js', 'exppat/m/x/y', 'require', 'node_modules/exppat/m/x/y.js'],
  ['an exports target with a . segment is refused', 'index.js', 'expseg/dot', 'require', 'node_modules/expseg/dot.js'],
  ['an exports target with a node_modules segment is refused', 'index.js', 'expseg/nm', 'require', 'node_modules/expseg/nm.js'],
  ['an exports target with an empty segment is refused', 'index.js', 'expseg/dbl', 'require', 'node_modules/expseg/dbl.js'],
  ['a number in exports refuses the map, falling back to the file', 'index.js', 'expprim/x', 'require', 'node_modules/expprim/x.js'],
  ['a subpath exports doesn\'t list still falls back', 'index.js', 'expprim/y', 'require', 'node_modules/expprim/y.js'],
  ['an exports target naming a type declaration falls back to the file', 'index.js', 'exptypes/t', 'require', 'node_modules/exptypes/t.js'],
  ['an exports target naming no file falls back to the subpath', 'index.js', 'exptypes/gone', 'require', 'node_modules/exptypes/gone/index.js'],
  ['root conditions take the import branch from an import', 'index.js', 'expcond', 'import', 'node_modules/expcond/esm.js'],
  ['nested conditions reduce in turn', 'index.js', 'expnested', 'require', 'node_modules/expnested/rn-cjs.js'],
  ['an imports map with a bare target is refused whole', 'node_modules/bareimp/index.js', '#own', 'require', null],
  ['an imports map with a ../ target is refused whole', 'node_modules/upimp/index.js', '#own', 'require', null],
  ['an imports array reduces to null, and the map is kept', 'node_modules/arrimp/index.js', '#own', 'require', 'node_modules/arrimp/own.js'],
  ['an imports array resolves nowhere', 'node_modules/arrimp/index.js', '#arr', 'require', null],
  ['an unchosen node branch does not refuse the map', 'node_modules/condimp/index.js', '#c', 'require', 'node_modules/condimp/rn.js'],
  ['an imports target is exact: no extension probing', 'node_modules/depimp/index.js', '#e', 'require', null],
  ['an imports target is exact: no directory index', 'node_modules/depimp/index.js', '#d', 'require', null],
  ['an exact null imports key shadows the patterns', 'node_modules/patimp/index.js', '#q/hit', 'require', null],
  ['a null imports pattern resolves nowhere', 'node_modules/patimp/index.js', '#p/n/c', 'require', null],
  ['an empty imports map is refused', 'node_modules/emptyimp/index.js', '#x', 'require', null],
  ['an imports map with a key not starting # is refused', 'node_modules/keyimp/index.js', '#a', 'require', null],
  ['a boolean in imports refuses the map', 'node_modules/primimp/index.js', '#b', 'require', null],
  ['an imports miss falls back to the browser map', 'node_modules/brimp/index.js', '#y', 'require', 'node_modules/brimp/y.js'],
  ['an imports miss mapped false is an empty module', 'node_modules/brimp/index.js', '#gone', 'require', '<empty>'],
  ['an imports miss falls back to node_modules', 'node_modules/brimp/index.js', '#z', 'require', 'node_modules/#z/index.js'],
  ['a package with no imports fails a # specifier, browser map aside', 'node_modules/noimp/index.js', '#dep', 'require', null],
  ['a package with no imports fails a # specifier, node_modules aside', 'node_modules/noimp/index.js', '#z', 'require', null],
  ['imports come from the package closest to the importer', 'node_modules/scopeimp/sub/index.js', '#s', 'require', null],
]

test('built-in --metro reads exports and imports as Metro does', withProject((t, root) => {
  const { builtin, metro } = resolversFor(root, 'ios')
  for (const [label, from, specifier, kind, expected] of MAP_CASES) {
    t.assert.equal(builtin(from, specifier, kind), expected, `built-in: ${label}`)
    if (metro) t.assert.equal(metro(from, specifier, kind), expected, `metro-resolver: ${label}`)
  }
}))
