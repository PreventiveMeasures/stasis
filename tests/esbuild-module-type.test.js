import { test } from 'node:test'

import { analyzeModule } from '../stasis-plugins/src/esbuild-module-type.js'

// The facts StasisEsbuild's package.json `type` checks rest on, read off the code esbuild parses.
const analyze = (source, { path = 'f.js', loader = 'js' } = {}) => analyzeModule(source, { path, loader })

test('analyzeModule: no facts for contents esbuild does not parse as JS/TS', (t) => {
  t.assert.equal(analyze('{"a":1}', { path: 'f.json', loader: 'json' }), null)
})

test('analyzeModule: ESM syntax -- exports (type-only included), import.meta and top-level await vs plain imports', (t) => {
  t.assert.equal(analyze('export const a = 1').esmExports, true)
  t.assert.equal(analyze('export type X = 1', { path: 'f.ts', loader: 'ts' }).esmExports, true)
  t.assert.equal(analyze('console.log(import.meta.url)').esmExports, true)
  t.assert.equal(analyze("await import('./x.js')").esmExports, true)
  t.assert.equal(analyze('async function f() { await g() }').esmExports, false)
  const importOnly = analyze("import './x.js'\nconsole.log(1)")
  t.assert.deepStrictEqual([importOnly.esmExports, importOnly.esmImports], [false, true])
  t.assert.equal(analyze("import type { X } from './x'", { path: 'f.ts', loader: 'ts' }).esmImports, false)
})

test('analyzeModule: how each import observes its target -- default/namespace (interop) vs named vs side effect', (t) => {
  const { imports } = analyze([
    "import d from './d.cjs'",
    "import * as ns from './ns.cjs'",
    "import { default as dd } from './dd.cjs'",
    "import { a } from './a.cjs'",
    "import './side.js'",
    "export { default } from './re.cjs'",
    "export * as star from './star.cjs'",
    "export * from './all.cjs'",
    "export { b } from './b.cjs'",
  ].join('\n'))
  const interop = { bindings: true, interop: true }
  const named = { bindings: true, interop: false }
  t.assert.deepStrictEqual(Object.fromEntries(imports), {
    './d.cjs': interop, './ns.cjs': interop, './dd.cjs': interop, './re.cjs': interop, './star.cjs': interop,
    './a.cjs': named, './all.cjs': named, './b.cjs': named,
    './side.js': { bindings: false, interop: false },
  })
})

test('analyzeModule: whether a require uses its result', (t) => {
  const { requires } = analyze("require('./side.js')\nconst x = require('./used.js')\nrequire('./both.js')\nf(require('./both.js'))")
  t.assert.deepStrictEqual(Object.fromEntries(requires), {
    './side.js': { consumed: false }, './used.js': { consumed: true }, './both.js': { consumed: true },
  })
})

test('analyzeModule: CommonJS use esbuild sees -- free module/exports, top-level this/return, direct eval', (t) => {
  t.assert.equal(analyze('module.exports = 1').cjsUsage, 'yes')
  t.assert.equal(analyze("if (typeof exports === 'object') exports.a = 1").cjsUsage, 'yes')
  t.assert.equal(analyze('console.log(this)').cjsDetail, 'top-level `this`')
  t.assert.equal(analyze('eval("1")').cjsUsage, 'yes')
  t.assert.equal(analyze('if (x) return\nconsole.log(1)').cjsUsage, 'yes')
  // Not CommonJS: `this` inside a function or class, `module` as a property name.
  t.assert.equal(analyze('function f() { return this }\nclass A { m() { return this } }\nconst o = { module: 1 }\no.exports = 2').cjsUsage, 'no')
  t.assert.equal(analyze('class A { x = this; static { this.y = 1 } }').cjsUsage, 'no')
  // A computed class key sees the outer `this`.
  t.assert.equal(analyze("class C { [this === undefined ? 'esm' : 'cjs']() {} }").cjsDetail, 'top-level `this`')
  // A module-scope import/let/const/function/class binds every reference to the name; esbuild merges a
  // module-scope `var` with the CommonJS binding instead.
  t.assert.equal(analyze("import module from 'pkg'\nmodule.run()").cjsUsage, 'no')
  t.assert.equal(analyze('const exports = {}\nexports.a = 1').cjsUsage, 'no')
  t.assert.equal(analyze('function module() {}\nmodule()').cjsUsage, 'no')
  t.assert.equal(analyze('var exports = {}\nexports.a = 1').cjsUsage, 'yes')
  t.assert.equal(analyze('declare const module: any\nmodule.exports = 1', { path: 'f.ts', loader: 'ts' }).cjsUsage, 'yes')
  // Each reference resolves against its own scopes, hoisting included.
  t.assert.equal(analyze('function use(module) { module.run() }').cjsUsage, 'no')
  t.assert.equal(analyze('function f() { module.x(); var module = {} }').cjsUsage, 'no')
  t.assert.equal(analyze('try { g() } catch (exports) { exports.a = 1 }').cjsUsage, 'no')
  t.assert.equal(analyze('{ let module = 1; module += 1 }').cjsUsage, 'no')
  t.assert.equal(analyze('function f(exports) { exports.a = 1 }\nexports.b = 2').cjsUsage, 'yes')
  t.assert.equal(analyze('{ let module = 1 }\nmodule.exports = 2').cjsUsage, 'yes')
  // A default parameter value sees the parameters, not the body's declarations.
  t.assert.equal(analyze('function f(x = module) { let module; return x }').cjsUsage, 'yes')
  t.assert.equal(analyze('function f(x = exports) { var exports; return x }').cjsUsage, 'yes')
  t.assert.equal(analyze('function f(module, x = module) { return x }').cjsUsage, 'no')
  t.assert.equal(analyze('const f = (module) => { const g = () => module; return g }').cjsUsage, 'no')
  // Destructuring assignment writes the existing name; destructuring declaration binds a new one.
  t.assert.equal(analyze('[module] = values').cjsUsage, 'yes')
  t.assert.equal(analyze('({ a: exports } = values)').cjsUsage, 'yes')
  t.assert.equal(analyze('const [module] = values\nmodule.run()').cjsUsage, 'no')
  t.assert.equal(analyze('function f({ module = 1 }) { return module }').cjsUsage, 'no')
})

test('analyzeModule: strict-mode-only differences -- a sloppy-only construct, a block-level function', (t) => {
  t.assert.match(analyze('with (o) { x }').strictOnly, /with/)
  t.assert.equal(analyze('{ function f() {} }').blockFunction, true)
  t.assert.equal(analyze('function f() { function g() {} }\nconst h = () => { function i() {} }').blockFunction, false)
  // Strict anyway, whatever the package type: a directive, a strict function, a class.
  t.assert.equal(analyze("'use strict'\nif (x) { function f() {} }").blockFunction, false)
  t.assert.equal(analyze("function g() { 'use strict'; { function f() {} } }").blockFunction, false)
  t.assert.equal(analyze('class A { m() { { function f() {} } } }').blockFunction, false)
})

test('analyzeModule: __esModule marks, as Babel/tsc/esbuild CommonJS output sets them; reads are not marks', (t) => {
  t.assert.equal(analyze('exports.__esModule = true').setsEsModule, true)
  t.assert.equal(analyze('Object.defineProperty(exports, "__esModule", { value: true })').setsEsModule, true)
  t.assert.equal(analyze('var d=Object.defineProperty;d(e,"__esModule",{value:!0})').setsEsModule, true)
  t.assert.equal(analyze('module.exports = { __esModule: true, default: 1 }').setsEsModule, true)
  t.assert.equal(analyze('const out = { __esModule: true, default: 1 }\nmodule.exports = out').setsEsModule, true)
  t.assert.equal(analyze('Object.defineProperties(exports, { __esModule: { value: true } })').setsEsModule, true)
  // A mark on a fresh local object counts only if that object becomes the exports; on anything else
  // (a parameter, a reassigned name) it may be the exports under another name.
  t.assert.equal(analyze('const metadata = {}\nmetadata.__esModule = true\nmodule.exports = { default: 1 }').setsEsModule, false)
  t.assert.equal(analyze("const o = {}\nObject.defineProperty(o, '__esModule', { value: true })\nmodule.exports = { default: 1 }").setsEsModule, false)
  t.assert.equal(analyze('const out = {}\nout.__esModule = true\nmodule.exports = out').setsEsModule, true)
  // A value assigned after the declaration becomes the exports too.
  t.assert.equal(analyze('let out\nout = { __esModule: true, default: 1 }\nmodule.exports = out').setsEsModule, true)
  t.assert.equal(analyze('function wrap(e) { e.__esModule = !0 }\nwrap(exports)').setsEsModule, true)
  t.assert.equal(analyze('let o = {}\no = exports\no.__esModule = true').setsEsModule, true)
  t.assert.equal(analyze('let o = {}\n;[o] = [exports]\no.__esModule = true').setsEsModule, true)
  t.assert.equal(analyze('let o = {}\nfor (o of [exports]) o.__esModule = true').setsEsModule, true)
  // What a call copies into a local that becomes the exports.
  t.assert.equal(analyze('const out = {}\nObject.assign(out, { __esModule: true, default: 1 })\nmodule.exports = out').setsEsModule, true)
  t.assert.equal(analyze('const out = {}\nObject.assign(out, { default: 1 })\nmodule.exports = out').setsEsModule, false)
  t.assert.equal(analyze('const o = {}\nObject.assign(o, { __esModule: true })\nmodule.exports = { default: 1 }').setsEsModule, false)
  // A statically falsy __esModule marks nothing.
  t.assert.equal(analyze('module.exports = { __esModule: false, default: 1 }').setsEsModule, false)
  t.assert.equal(analyze('exports.__esModule = void 0').setsEsModule, false)
  // `undefined` is a name a declaration can rebind.
  t.assert.equal(analyze('const undefined = true\nmodule.exports = { __esModule: undefined, default: 1 }').setsEsModule, true)
  t.assert.equal(analyze('Object.defineProperty(exports, "__esModule", { value: false })').setsEsModule, false)
  t.assert.equal(analyze('Object.defineProperty(exports, "__esModule", { get: () => flag })').setsEsModule, true)
  // A literal that never becomes the exports, or only ends up nested in them, doesn't mark them.
  t.assert.equal(analyze('const metadata = { __esModule: true }\nmodule.exports = { default: 1 }').setsEsModule, false)
  t.assert.equal(analyze("const metadata = { __esModule: true }\nmodule.exports = { default: 'd', metadata }").setsEsModule, false)
  t.assert.equal(analyze('const base = { __esModule: true }\nmodule.exports = { ...base, default: 1 }').setsEsModule, true)
  // A computed key that names `__esModule`: a constant or a constant concatenation.
  t.assert.equal(analyze("const marker = '__esModule'\nmodule.exports = { [marker]: true, default: 1 }").setsEsModule, true)
  t.assert.equal(analyze("module.exports = { ['__es' + 'Module']: true, default: 1 }").setsEsModule, true)
  t.assert.equal(analyze("const marker = '__es' + 'Module'\nexports[marker] = true").setsEsModule, true)
  t.assert.equal(analyze("const marker = '__esModule'\nObject.defineProperty(exports, marker, { value: true })").setsEsModule, true)
  t.assert.equal(analyze("const key = 'name'\nmodule.exports = { [key]: true, default: 1 }\nexports[key] = true").setsEsModule, false)
  t.assert.equal(analyze("const marker = '__esModule'\nmodule.exports = { [marker]: false, default: 1 }").setsEsModule, false)
  // A class's statics are its own properties, its superclass's inherited ones.
  t.assert.equal(analyze('module.exports = class { static __esModule = true; static default = 1 }').setsEsModule, true)
  t.assert.equal(analyze('class C { static get __esModule() { return true } }\nmodule.exports = C').setsEsModule, true)
  t.assert.equal(analyze("module.exports = class extends require('./base') {}").reexports.has('./base'), true)
  t.assert.equal(analyze('module.exports = class { __esModule = true; static __esModule = false; static x = 1 }').setsEsModule, false)
  t.assert.equal(analyze('module.exports = (m) => m && m.__esModule ? m.default : m').setsEsModule, false)
  t.assert.equal(analyze('Object.prototype.hasOwnProperty.call(m, "__esModule")').setsEsModule, false)
})

test('analyzeModule: requires whose result can become module.exports', (t) => {
  const reexports = (source) => [...analyze(source).reexports].toSorted()
  t.assert.deepStrictEqual(reexports("module.exports = require('./a')"), ['./a'])
  t.assert.deepStrictEqual(reexports("if (prod) { module.exports = require('./p') } else { module.exports = require('./d') }"), ['./d', './p'])
  t.assert.deepStrictEqual(reexports("module.exports = prod ? require('./p') : require('./d')"), ['./d', './p'])
  t.assert.deepStrictEqual(reexports("const lib = require('./lib')\nconst other = require('./other')\nmodule.exports = lib"), ['./lib'])
  t.assert.deepStrictEqual(reexports('__exportStar(require("./x"), exports)'), ['./x'])
  t.assert.deepStrictEqual(reexports("Object.assign(module.exports, require('./y'))"), ['./y'])
  t.assert.deepStrictEqual(reexports("module.exports = (function () { return require('./now') })()"), ['./now'])
  // A require that runs later, inside a function, doesn't produce the exported value.
  t.assert.deepStrictEqual(reexports("module.exports = function () { return require('./later') }"), [])
  t.assert.deepStrictEqual(reexports("module.exports.helper = require('./helper')"), [])
  // What a local function returns, when the exports are its result.
  t.assert.deepStrictEqual(reexports("function load() { return require('./babel.cjs') }\nmodule.exports = load()"), ['./babel.cjs'])
  t.assert.deepStrictEqual(reexports("const load = () => require('./x')\nmodule.exports = load()"), ['./x'])
  t.assert.deepStrictEqual(reexports("function a() { return b() }\nfunction b() { return require('./c') }\nmodule.exports = a()"), ['./c'])
  // Nested in the exports isn't the exports; spread into them is.
  t.assert.deepStrictEqual(reexports("module.exports = { a: require('./a'), ...require('./b') }"), ['./b'])
})
