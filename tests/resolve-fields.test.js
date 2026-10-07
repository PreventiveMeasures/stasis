import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createFieldResolver, resolveConditions } from '../stasis/src/resolve-fields.js'
import { scan } from '../stasis/src/scan.js'
import { loadTsconfigPaths, resolveTypescriptFallback, typescriptSiblings } from '../stasis/src/resolve-typescript.js'

const here = dirname(fileURLToPath(import.meta.url))
const fx = join(here, 'fixtures', 'resolve-fields')
const entry = join(fx, 'src', 'entry.js')
const redirIndex = join(fx, 'node_modules', 'redir', 'index.js')

// Resolve and reduce to a base-relative path (or a marker) for assertions.
const relTo = (base, r) => {
  if (r == null) return null
  if (r.empty) return '<empty>'
  if (r.builtin) return '<builtin>'
  return relative(base, fileURLToPath(r.url)).split(/[\\/]/u).join('/')
}
const rel = (r) => relTo(fx, r)

// Throwaway TS-shaped project for the `typescript: true` tests (built per test, not a shared
// fixture: .ts files in tests/fixtures would be scanned by the workspace's own tooling).
const withTsTmp = (fn) => (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-resolve-fields-ts-'))
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'ts-fields', version: '0.0.0' }))
    writeFileSync(join(tmp, 'entry.ts'), 'export {}\n')
    writeFileSync(join(tmp, 'only-ts.ts'), 'export const x: number = 1\n')
    writeFileSync(join(tmp, 'both.js'), 'exports.x = 1\n')
    writeFileSync(join(tmp, 'both.ts'), 'export const x: number = 999\n')
    writeFileSync(join(tmp, 'weird.ts'), 'export const w: number = 1\n')
    writeFileSync(join(tmp, 'weird.js.ts'), 'export const w: number = 999\n')
    // TS-source packages as a monorepo links them: in packages/, symlinked into node_modules. The
    // same shapes installed in node_modules itself (`-installed`) get no --typescript mapping.
    const tsPackage = (dir, manifest, files) => {
      mkdirSync(join(dir, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.0', ...manifest }))
      for (const file of files) writeFileSync(join(dir, 'lib', file), 'export const x: number = 1\n')
    }
    for (const [name, manifest, files] of [
      ['tspkg', { main: './lib/main.js' }, ['main.ts']],
      ['exppkg', { exports: { '.': './lib/main.js', './sub': { default: './lib/sub.js' } } }, ['main.ts', 'sub.ts']],
    ]) {
      tsPackage(join(tmp, 'packages', name), { name, ...manifest }, files)
      mkdirSync(join(tmp, 'node_modules'), { recursive: true })
      symlinkSync(join('..', 'packages', name), join(tmp, 'node_modules', name))
      tsPackage(join(tmp, 'node_modules', `${name}-installed`), { name: `${name}-installed`, ...manifest }, files)
    }
    return fn(t, tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// Build a resolver, varying the bits a caller tweaks (the legacy fields it honours,
// the target `platform` and native-suffix preference, and any extra `exports`
// conditions). `platform: null` (the default, the `--mainFields` case) disables
// platform-suffix probing; for a real platform, web alone excludes `.native`.
const mk = ({ mainFields = ['react-native', 'browser', 'main'], extras = [], platform = null, preferNative = platform !== null && platform !== 'web', metro = false, keepEntryOnFalse } = {}) =>
  createFieldResolver({
    conditions: resolveConditions('module', extras),
    mainFields,
    platform,
    preferNative,
    metro,
    ...(keepEntryOnFalse === undefined ? {} : { metroKeepEntryOnBrowserFalse: keepEntryOnFalse }),
  })

test('a relative import resolves with extension probing', (t) => {
  t.assert.equal(rel(mk()(entry, './Button')), 'src/Button.js')
})

test('platform suffixes: name.<platform>.ext beats name.native.ext beats name.ext', (t) => {
  t.assert.equal(rel(mk({ platform: 'ios' })(entry, './Button')), 'src/Button.ios.js')
  t.assert.equal(rel(mk({ platform: 'android' })(entry, './Button')), 'src/Button.android.js')
})

test('web excludes the .native variant (preferNative is false for web)', (t) => {
  // Button.native.js exists, but web must not pick it -- it falls through to the base.
  t.assert.equal(rel(mk({ platform: 'web', extras: ['browser'] })(entry, './Button')), 'src/Button.js')
})

test('a native platform with no platform-specific file falls back to .native', (t) => {
  // No Button.windows.js exists; windows is a native platform, so .native wins over base.
  t.assert.equal(rel(mk({ platform: 'windows' })(entry, './Button')), 'src/Button.native.js')
})

test('a relative directory import honours package.json main even when exports is present', (t) => {
  // dirpkg has "main":"./real.js", "exports":"./exp.js", and a stray index.js. A
  // relative/absolute directory import ignores exports (Node consults it only for bare
  // package names), so main wins -- not index, and not the exports target.
  t.assert.equal(rel(mk()(entry, './dirpkg')), 'src/dirpkg/real.js')
})

test('a package whose main points at a directory resolves that directory index (LOAD_AS_DIRECTORY)', (t) => {
  // dirmain: { "main": "./inner/" }. Node resolves main as a file then as a directory
  // (its index), so this must land on inner/index.js, not fail.
  t.assert.equal(rel(mk()(entry, 'dirmain')), 'node_modules/dirmain/inner/index.js')
})

test('mainFields select the package entry in order (react-native > browser > main)', (t) => {
  t.assert.equal(rel(mk()(entry, 'entryfields')), 'node_modules/entryfields/rn.js')
  t.assert.equal(
    rel(mk({ mainFields: ['browser', 'main'], extras: ['browser'] })(entry, 'entryfields')),
    'node_modules/entryfields/browser.js',
  )
  t.assert.equal(rel(mk({ mainFields: ['main'] })(entry, 'entryfields')), 'node_modules/entryfields/main.js')
})

test('a browser map redirects the package entry, matching the extensionless variant', (t) => {
  // entryredir: main "./lib/index.js", browser { "./lib/index": "./browser.js" } -- the
  // entry is matched with its extension stripped and redirected to the browser entry.
  t.assert.equal(rel(mk()(entry, 'entryredir')), 'node_modules/entryredir/browser.js')
})

test('an entry browser-map redirect matches a key written without a leading ./', (t) => {
  // noslash: { "main": "server.js", "browser": { "server.js": "./client.js" } } -- main
  // and the key both omit `./`; the redirect must still fire (esbuild + browser-resolve
  // both redirect regardless of which side carries the `./`).
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'noslash')), 'node_modules/noslash/client.js')
})

test('a bare browser-map key does not hijack a same-basename package entry (--mainFields)', (t) => {
  // streampkg: main "./stream.js", browser { "stream": "./vendor/sb.js" }. The bare
  // "stream" key remaps the `stream` MODULE used inside the package, not the entry, so
  // the entry stays stream.js (esbuild + browser-resolve agree; verified end-to-end).
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'streampkg')), 'node_modules/streampkg/stream.js')
})

test('--metro: a bare browser-map key DOES redirect the resolved package entry', (t) => {
  // Real Metro's getPackageEntryPoint matches the bare "stream" key against the entry and
  // redirects it -- so under `metro`, streampkg resolves to vendor/sb.js (verified against
  // the real metro-resolver). This is the intended divergence from esbuild/--mainFields above.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })(entry, 'streampkg')), 'node_modules/streampkg/vendor/sb.js')
})

test('a browser-map false on the package entry disables it (empty module) (--mainFields)', (t) => {
  // entryfalse: main "./fe.js", browser { "./fe.js": false } -- a relative key matching
  // the entry disables it to an empty module, matching esbuild.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'entryfalse')), '<empty>')
})

test('--metro: a browser-map false on the package entry keeps main (Metro ignores it)', (t) => {
  // Metro's getPackageEntryPoint ignores a non-string (false) entry replacement and keeps
  // `main`, so under `metro` entryfalse resolves to fe.js -- NOT an empty module (verified
  // against the real metro-resolver). Gated by METRO_KEEP_ENTRY_ON_BROWSER_FALSE.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })(entry, 'entryfalse')), 'node_modules/entryfalse/fe.js')
})

test('--metro: a bare browser-map false also keeps main', (t) => {
  // barefalse (main "./buf.js", browser { "buf": false }): under metro the bare "buf" key DOES
  // match the entry (Metro's variant list), but `false` keeps main -- so buf.js. NOTE: this
  // outcome is identical whether or not the bare variant matched (no match would also leave
  // buf.js), so it does NOT discriminate the bare-key matching itself -- the streampkg test
  // above covers that. What it pins is Metro parity for the combined case (verified against
  // the real metro-resolver), and the toggle-off test below pins the branch actually taken.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })(entry, 'barefalse')), 'node_modules/barefalse/buf.js')
})

test('--metro: with the keep-on-false toggle off, a false entry match fails closed to empty', (t) => {
  // metroKeepEntryOnBrowserFalse: false (the METRO_KEEP_ENTRY_ON_BROWSER_FALSE=false state):
  // any `false` match on the entry -- under Metro's MATCHING rules, bare keys included --
  // yields an empty module. Deliberately stricter than both tools for bare keys (Metro keeps
  // main; esbuild wouldn't match the entry): it's a fail-closed escape hatch, not esbuild parity.
  const off = mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true, keepEntryOnFalse: false })
  t.assert.equal(rel(off(entry, 'entryfalse')), '<empty>')
  t.assert.equal(rel(off(entry, 'barefalse')), '<empty>')
  // A plain string redirect is unaffected by the toggle.
  t.assert.equal(rel(off(entry, 'streampkg')), 'node_modules/streampkg/vendor/sb.js')
})

// --- Metro entry-variant fidelity (each expectation verified against the real metro-resolver) ---

test('--metro: entry redirect follows Metro variant ORDER on competing keys', (t) => {
  const metro = mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })
  // dualkey: main "./stream.js", browser { "stream.js": "./a.js", "./stream": "./b.js" }.
  // Metro probes ./-prefixed variants of the main spelling before bare ones: ./stream wins -> b.js.
  t.assert.equal(rel(metro(entry, 'dualkey')), 'node_modules/dualkey/b.js')
  // strfalse: main "./x.js", browser { "x.js": "./A.js", "./x": false }. Metro hits ./x (false)
  // first and keeps main -- the later string key must NOT redirect.
  t.assert.equal(rel(metro(entry, 'strfalse')), 'node_modules/strfalse/x.js')
})

test('--metro: entry redirect matches Metro variant SET (no stripped .json probe, honors double-extension)', (t) => {
  const metro = mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })
  // jsonkey: browser { "stream.json": "./x.js" } for main "./stream.js" -- Metro never generates
  // a stripped+.json variant, so the entry must stay stream.js (no over-match).
  t.assert.equal(rel(metro(entry, 'jsonkey')), 'node_modules/jsonkey/stream.js')
  // dblext: browser { "./stream.js.js": "./x.js" } -- Metro generates main+'.js', so it redirects.
  t.assert.equal(rel(metro(entry, 'dblext')), 'node_modules/dblext/x.js')
})

test('--metro: the redirect map applies to platform-suffixed file candidates (Metro resolveSourceFileForExt)', (t) => {
  // sfxfalse: main "./index" with only index.ios.js on disk and browser { "./index.ios.js": false }.
  // Metro redirect-checks each suffixed candidate; the false short-circuits to an empty module.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'], platform: 'ios', metro: true })(entry, 'sfxfalse')), '<empty>')
})

test('--metro: an object-valued react-native field participates in entry redirection under the real preset', (t) => {
  // rnbare: main "./crypto.js", react-native { "crypto": "./crypto-rn.js" } -- exercised with the
  // shipped --metro mainFields preset (react-native,browser,main), not just browser,main.
  t.assert.equal(rel(mk({ platform: 'ios', metro: true })(entry, 'rnbare')), 'node_modules/rnbare/crypto-rn.js')
})

test('a bare browser-map false does not empty a same-basename package entry', (t) => {
  // barefalse: main "./buf.js", browser { "buf": false } -- the bare "buf" key disables
  // the `buf` module, not the entry; esbuild keeps buf.js.
  t.assert.equal(rel(mk({ mainFields: ['browser', 'main'] })(entry, 'barefalse')), 'node_modules/barefalse/buf.js')
})

test('on a conflicting redirect key, the earlier mainField wins (react-native over browser)', (t) => {
  // conflict maps "./main.js" in BOTH its react-native and browser objects; with
  // mainFields [react-native, browser, main] the react-native target must win.
  t.assert.equal(rel(mk()(entry, 'conflict')), 'node_modules/conflict/rn.js')
})

test('browser object map redirects a relative subpath to another file', (t) => {
  // redir/package.json: "browser": { "./node-only.js": "./browser-only.js" }
  t.assert.equal(rel(mk()(redirIndex, './node-only.js')), 'node_modules/redir/browser-only.js')
})

test('browser object map false redirect resolves to an empty module', (t) => {
  // "./gone.js": false (relative) and "leftpad": false (bare)
  t.assert.equal(rel(mk()(redirIndex, './gone.js')), '<empty>')
  t.assert.equal(rel(mk()(redirIndex, 'leftpad')), '<empty>')
})

test('a browser map redirect target resolves against the package root, not the importer dir', (t) => {
  // redir/lib/inner.js requires ../node-only.js; the map's ./browser-only.js target is
  // package-root-relative, so it must land at redir/browser-only.js (not redir/lib/...).
  const inner = join(fx, 'node_modules', 'redir', 'lib', 'inner.js')
  t.assert.equal(rel(mk()(inner, '../node-only.js')), 'node_modules/redir/browser-only.js')
})

test('a dotted bare specifier in the browser map is matched as bare, not as a relative path', (t) => {
  // "socket.io": "./shim.js" and "lodash.merge": false -- the dots are part of the bare
  // module name, never read as path segments.
  t.assert.equal(rel(mk()(redirIndex, 'socket.io')), 'node_modules/redir/shim.js')
  t.assert.equal(rel(mk()(redirIndex, 'lodash.merge')), '<empty>')
})

test('exports wins over a legacy browser main field, honoring conditions', (t) => {
  // exportswins has both "browser":"./should-be-ignored.js" and an exports map
  // gating react-native/default. exports must win; the browser main field is ignored.
  t.assert.equal(rel(mk({ extras: ['react-native'] })(entry, 'exportswins')), 'node_modules/exportswins/rn.js')
  t.assert.equal(rel(mk()(entry, 'exportswins')), 'node_modules/exportswins/def.js')
})

// nodefirst's `exports` lists `node` FIRST, then browser, react-native and default (uuid's shape),
// and its `#target` import the same; `./format` splits on import/require.
const nodeFirstInternal = join(fx, 'node_modules', 'nodefirst', 'internal.js')
const nodeFirstFiles = (scanner) => [...scanner.files.keys()].map((url) => relTo(fx, { url })).filter((f) => f.includes('nodefirst')).toSorted()

test('resolveConditions is a bundler base, import or require by format plus default, never node', (t) => {
  t.assert.deepStrictEqual(resolveConditions('module', ['browser']), ['import', 'default', 'browser'])
  t.assert.deepStrictEqual(resolveConditions('module-typescript'), ['import', 'default'])
  t.assert.deepStrictEqual(resolveConditions('commonjs', ['react-native']), ['require', 'default', 'react-native'])
  t.assert.deepStrictEqual(resolveConditions('commonjs', ['default', 'require']), ['require', 'default'])
})

test('a node-first exports map resolves to the extras, then default, never node', (t) => {
  // Each as the bundler asserting the same conditions picks it: esbuild/webpack for browser,
  // Metro with React Native's config for react-native.
  t.assert.equal(rel(mk()(entry, 'nodefirst')), 'node_modules/nodefirst/default.js')
  t.assert.equal(rel(mk({ extras: ['browser'] })(entry, 'nodefirst')), 'node_modules/nodefirst/browser.js')
  t.assert.equal(rel(mk({ extras: ['react-native'] })(entry, 'nodefirst')), 'node_modules/nodefirst/rn.js')
  // Both, as Metro on web asserts them: the map's key order decides.
  t.assert.equal(rel(mk({ extras: ['react-native', 'browser'] })(entry, 'nodefirst')), 'node_modules/nodefirst/browser.js')
  // The same for a `#name` import.
  t.assert.equal(rel(mk()(nodeFirstInternal, '#target')), 'node_modules/nodefirst/default.js')
  t.assert.equal(rel(mk({ extras: ['react-native'] })(nodeFirstInternal, '#target')), 'node_modules/nodefirst/rn.js')
  // The per-call set picks import or require.
  const resolve = mk()
  t.assert.equal(rel(resolve(entry, 'nodefirst/format', new Set(resolveConditions('module')))), 'node_modules/nodefirst/import.js')
  t.assert.equal(rel(resolve(entry, 'nodefirst/format', new Set(resolveConditions('commonjs')))), 'node_modules/nodefirst/require.js')
})

test("scan hands a custom resolver resolveConditions' set for each parent's format; Node's own scan keeps node", (t) => {
  const seen = new Map()
  const field = mk({ extras: ['browser'] })
  const resolve = (parent, spec, conditions) => {
    seen.set(relative(fx, parent).split(/[\\/]/u).join('/'), [...conditions])
    return field(parent, spec, conditions)
  }
  const entries = [join(fx, 'src', 'entry-node-first.js')]
  const custom = scan(entries, { conditions: ['browser'], resolve })
  t.assert.deepStrictEqual(seen.get('src/entry-node-first.js'), resolveConditions('module', ['browser']))
  t.assert.deepStrictEqual(seen.get('node_modules/nodefirst/internal.js'), resolveConditions('commonjs', ['browser']))
  t.assert.deepStrictEqual(nodeFirstFiles(custom), ['node_modules/nodefirst/browser.js', 'node_modules/nodefirst/default.js', 'node_modules/nodefirst/internal.js'])
  // Without a custom resolver, Node's conditions: `node` wins whatever is added.
  t.assert.deepStrictEqual(nodeFirstFiles(scan(entries, { conditions: ['browser'] })), ['node_modules/nodefirst/internal.js', 'node_modules/nodefirst/node.js'])
})

test('builtins are reported as builtins', (t) => {
  t.assert.equal(rel(mk()(entry, 'node:path')), '<builtin>')
  t.assert.equal(rel(mk()(entry, 'fs')), '<builtin>')
})

test('the browser map can disable or shim a Node builtin (it wins over the builtin check)', (t) => {
  // builtinshim browser map: { "crypto": false, "fs": "./fs-shim.js", "buffer": "shimpkg" }.
  // Replacing Node-only modules is the browser field's whole purpose, so the map must be
  // consulted before falling back to treating the specifier as a builtin.
  const from = join(fx, 'node_modules', 'builtinshim', 'index.js')
  t.assert.equal(rel(mk()(from, 'crypto')), '<empty>') // false -> empty module
  t.assert.equal(rel(mk()(from, 'fs')), 'node_modules/builtinshim/fs-shim.js') // string -> package-root file
  t.assert.equal(rel(mk()(from, 'buffer')), 'node_modules/shimpkg/index.js') // string -> another package
  t.assert.equal(rel(mk()(from, 'path')), '<builtin>') // not mapped -> still a builtin
})

test('a bare builtin name resolves to the installed package of that name (no Node builtins off Node)', (t) => {
  // buffer: { main: "index.js" }, installed. esbuild (platform browser), webpack 5 and Metro all
  // bundle node_modules/buffer for `import { Buffer } from 'buffer'`, so the edge lands there.
  t.assert.equal(rel(mk()(entry, 'buffer')), 'node_modules/buffer/index.js')
  t.assert.equal(rel(mk({ mainFields: ['browser', 'module', 'main'], extras: ['browser'] })(entry, 'buffer')), 'node_modules/buffer/index.js')
  t.assert.equal(rel(mk({ platform: 'ios', metro: true })(entry, 'buffer')), 'node_modules/buffer/index.js')
  t.assert.equal(rel(mk({ platform: 'web', extras: ['browser'], metro: true })(entry, 'buffer')), 'node_modules/buffer/index.js')
})

test('an installed builtin-named package with exports resolves through them, under the bundler conditions', (t) => {
  // util: exports { ".": { browser, default } }. Node's own resolver answers `util` with the
  // builtin, so this takes the builtins-off path; `util/types` (a builtin subpath) isn't exported,
  // so it falls back to the builtin rather than going unresolved.
  t.assert.equal(rel(mk({ extras: ['browser'] })(entry, 'util')), 'node_modules/util/util-browser.js')
  t.assert.equal(rel(mk()(entry, 'util')), 'node_modules/util/util.js')
  t.assert.equal(rel(mk()(entry, 'util/types')), '<builtin>')
})

test('an uninstalled builtin and a node: specifier stay builtins, even with the package installed', (t) => {
  t.assert.equal(rel(mk()(entry, 'fs')), '<builtin>') // no node_modules/fs
  t.assert.equal(rel(mk({ platform: 'ios', metro: true })(entry, 'fs')), '<builtin>')
  t.assert.equal(rel(mk()(entry, 'node:buffer')), '<builtin>') // node_modules/buffer is installed
  t.assert.equal(rel(mk({ platform: 'ios', metro: true })(entry, 'node:buffer')), '<builtin>')
})

test('a browser-map false on a builtin name wins over the installed package', (t) => {
  // nobuffer browser map: { "buffer": false }, with node_modules/buffer installed beside it.
  const from = join(fx, 'node_modules', 'nobuffer', 'index.js')
  t.assert.equal(rel(mk()(from, 'buffer')), '<empty>')
  t.assert.equal(rel(mk({ platform: 'ios', metro: true })(from, 'buffer')), '<empty>')
  t.assert.equal(rel(mk({ mainFields: ['main'] })(from, 'buffer')), 'node_modules/buffer/index.js') // map not honoured
})

test('scan records an edge to an installed builtin-named package, and a builtin edge where none is', (t) => {
  const resolve = mk({ extras: ['browser'] })
  const s = scan([join(fx, 'src', 'entry-polyfills.js')], { conditions: ['browser'], resolve }).toRelative(fx)
  const edges = Object.fromEntries(s.files.get('src/entry-polyfills.js').edges.map((e) => [e.spec, e.child ?? (e.builtin ? '<builtin>' : e.empty ? '<empty>' : null)]))
  t.assert.deepStrictEqual(edges, {
    buffer: 'node_modules/buffer/index.js',
    util: 'node_modules/util/util-browser.js',
    'util/types': '<builtin>',
    fs: '<builtin>',
    'node:buffer': '<builtin>',
    nobuffer: 'node_modules/nobuffer/index.js',
  })
  t.assert.deepStrictEqual(s.files.get('node_modules/nobuffer/index.js').edges.map((e) => [e.spec, Boolean(e.empty)]), [['buffer', true]])
  t.assert.deepStrictEqual(s.unresolved, [])
})

test('an unresolvable specifier returns null', (t) => {
  t.assert.equal(rel(mk()(entry, './does-not-exist')), null)
  t.assert.equal(rel(mk()(entry, 'no-such-package')), null)
})

test('locatePackage matches the node_modules segment exactly, not a *-node_modules suffix', (t) => {
  // An importer inside `my-node_modules/` must still find deps in its own
  // `my-node_modules/node_modules/` -- the walk skips a directory only when its last
  // segment IS `node_modules`, not when it merely ends with that string.
  const importer = join(fx, 'odd', 'my-node_modules', 'app.js')
  t.assert.equal(rel(mk()(importer, 'dep')), 'odd/my-node_modules/node_modules/dep/index.js')
})

// --- TypeScript extension substitution (`typescript: true` / --typescript). ---

test('typescriptSiblings maps JS output extensions to their TS sources', (t) => {
  t.assert.deepStrictEqual(typescriptSiblings('./x.js'), ['./x.ts', './x.tsx'])
  t.assert.deepStrictEqual(typescriptSiblings('./x.jsx'), ['./x.tsx'])
  t.assert.deepStrictEqual(typescriptSiblings('./x.mjs'), ['./x.mts'])
  t.assert.deepStrictEqual(typescriptSiblings('./x.cjs'), ['./x.cts'])
  // Not substitutable: extensionless, already-TS, .json, unknown extensions.
  t.assert.deepStrictEqual(typescriptSiblings('./x'), [])
  t.assert.deepStrictEqual(typescriptSiblings('./x.ts'), [])
  t.assert.deepStrictEqual(typescriptSiblings('./x.json'), [])
  t.assert.deepStrictEqual(typescriptSiblings('./x.service'), [])
  // A dotfile has no extension (extname sees none), so nothing to substitute.
  t.assert.deepStrictEqual(typescriptSiblings('./.js'), [])
  // A candidate spelling a type declaration IS returned -- every probe site refuses declarations
  // (the screen lives at probe time, once), pinned by the "never lands on a type declaration" tests.
  t.assert.deepStrictEqual(typescriptSiblings('./x.d.js'), ['./x.d.ts', './x.d.tsx'])
})

test('typescript: a missing x.js resolves to its x.ts sibling; an existing x.js wins', withTsTmp((t, tmp) => {
  const resolver = createFieldResolver({ mainFields: ['main'], typescript: true })
  const from = join(tmp, 'entry.ts')
  t.assert.equal(relTo(tmp, resolver(from, './only-ts.js')), 'only-ts.ts')
  t.assert.equal(relTo(tmp, resolver(from, './both.js')), 'both.js')
  // Off by default: without the option the missing .js stays unresolved.
  const plain = createFieldResolver({ mainFields: ['main'] })
  t.assert.equal(relTo(tmp, plain(from, './only-ts.js')), null)
}))

test('typescript: a package main naming a missing .js lands on its .ts source', withTsTmp((t, tmp) => {
  // TS-source packages (workspace deps) commonly point main at their compiled name; with only
  // the source on disk, the entry substitutes like any other path -- but never in node_modules.
  // The hit is its real path, in packages/ where the link leads.
  const resolver = createFieldResolver({ mainFields: ['main'], typescript: true })
  t.assert.equal(relTo(tmp, resolver(join(tmp, 'entry.ts'), 'tspkg')), 'packages/tspkg/lib/main.ts')
  t.assert.equal(relTo(tmp, resolver(join(tmp, 'entry.ts'), 'tspkg-installed')), null)
}))

test('typescript: an importer in node_modules gets no mapping, even where its import leaves it', withTsTmp((t, tmp) => {
  // An installed package's file reaching out of node_modules to ./only-ts.js (only-ts.ts on disk)
  // resolves as without --typescript; a linked workspace package's file, in node_modules by its
  // lexical path alone, still maps.
  const resolver = createFieldResolver({ mainFields: ['main'], typescript: true })
  t.assert.equal(relTo(tmp, resolver(join(tmp, 'node_modules', 'tspkg-installed', 'lib', 'main.ts'), '../../../only-ts.js')), null)
  t.assert.equal(relTo(tmp, resolver(join(tmp, 'node_modules', 'tspkg', 'lib', 'main.ts'), '../../../only-ts.js')), 'only-ts.ts')
}))

test('typescript: no mapping into a file directly in node_modules', withTsTmp((t, tmp) => {
  writeFileSync(join(tmp, 'node_modules', 'loose.ts'), 'export const l: number = 1\n')
  const resolver = createFieldResolver({ mainFields: ['main'], typescript: true })
  t.assert.equal(relTo(tmp, resolver(join(tmp, 'entry.ts'), './node_modules/loose.js')), null)
}))

test('typescript: no mapping to a sibling whose real path lies in node_modules, nor past it', withTsTmp((t, tmp) => {
  // linked.ts, beside the importer, is a link into an installed package: by its real path, no target.
  // tsc picks it before linked.tsx, so with it refused nothing maps -- in both resolvers alike.
  symlinkSync(join('node_modules', 'tspkg-installed', 'lib', 'main.ts'), join(tmp, 'linked.ts'))
  const resolver = createFieldResolver({ mainFields: ['main'], typescript: true })
  const from = join(tmp, 'entry.ts')
  t.assert.equal(relTo(tmp, resolver(from, './linked.js')), null)
  writeFileSync(join(tmp, 'linked.tsx'), 'export const l = (): unknown => null\n')
  t.assert.equal(relTo(tmp, resolver(from, './linked.js')), null)
  t.assert.equal(resolveTypescriptFallback(from, './linked.js'), null)
}))

test('typescript: substitution beats the appended-extension probe for a pathological x.js.ts', withTsTmp((t, tmp) => {
  // Both `weird.ts` (tsc's substitution) and `weird.js.ts` (the sourceExts append) exist; tsc's
  // candidate order puts substitution first, so the append must not shadow it.
  const resolver = createFieldResolver({ mainFields: ['main'], typescript: true })
  t.assert.equal(relTo(tmp, resolver(join(tmp, 'entry.ts'), './weird.js')), 'weird.ts')
}))

test('typescript: an exports target naming a missing .js lands on its .ts source (shared fallback)', withTsTmp((t, tmp) => {
  // The field resolver delegates exports-bearing packages to Node; on a miss the shared
  // --typescript fallback substitutes the exports target, so `exports` and `main` packages
  // behave alike under the flag (tsc's node16 rules substitute both).
  const resolver = createFieldResolver({ mainFields: ['main'], typescript: true })
  const from = join(tmp, 'entry.ts')
  t.assert.equal(relTo(tmp, resolver(from, 'exppkg')), 'packages/exppkg/lib/main.ts')
  t.assert.equal(relTo(tmp, resolver(from, 'exppkg/sub')), 'packages/exppkg/lib/sub.ts')
  // A subpath the exports map does not export stays unresolved -- the fallback never widens exports.
  t.assert.equal(relTo(tmp, resolver(from, 'exppkg/lib/main.js')), null)
  // Installed in node_modules, not linked from the workspace: no mapping.
  t.assert.equal(relTo(tmp, resolver(from, 'exppkg-installed')), null)
  t.assert.equal(relTo(tmp, resolver(from, 'exppkg-installed/sub')), null)
  // Off by default.
  const plain = createFieldResolver({ mainFields: ['main'] })
  t.assert.equal(relTo(tmp, plain(from, 'exppkg')), null)
}))

test("typescript: a '#' imports target naming a missing .js lands on its .ts source", withTsTmp((t, tmp) => {
  writeFileSync(join(tmp, 'package.json'),
    JSON.stringify({ name: 'ts-fields', version: '0.0.0', imports: { '#only': './only-ts.js' } }))
  const resolver = createFieldResolver({ mainFields: ['main'], typescript: true })
  t.assert.equal(relTo(tmp, resolver(join(tmp, 'entry.ts'), '#only')), 'only-ts.ts')
}))

test('typescript: tsconfig paths aliases resolve through typescriptPaths', withTsTmp((t, tmp) => {
  writeFileSync(join(tmp, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./*'] } } }))
  const typescriptPaths = loadTsconfigPaths(join(tmp, 'tsconfig.json'))
  const resolver = createFieldResolver({ mainFields: ['main'], typescript: true, typescriptPaths })
  const from = join(tmp, 'entry.ts')
  t.assert.equal(relTo(tmp, resolver(from, '@app/only-ts.js')), 'only-ts.ts')
  // An alias target completes to .js too: Node never probed it (shared dispatcher, as in scan).
  writeFileSync(join(tmp, 'only-js.js'), 'exports.x = 1\n')
  t.assert.equal(relTo(tmp, resolver(from, '@app/only-js')), 'only-js.js')
  // An alias never hijacks a resolution that succeeded (both.js exists; tspkg has a real main).
  t.assert.equal(relTo(tmp, resolver(from, './both.js')), 'both.js')
  // Without the matcher the alias stays unresolved.
  const bare = createFieldResolver({ mainFields: ['main'], typescript: true })
  t.assert.equal(relTo(tmp, bare(from, '@app/only-ts.js')), null)
}))
