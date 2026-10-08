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
    'console.log(d, ns, dd, a)',
  ].join('\n'))
  const interop = { bindings: true, interop: true }
  const named = { bindings: true, interop: false }
  const side = { bindings: false, interop: false }
  t.assert.deepStrictEqual(Object.fromEntries(imports), {
    './d.cjs': interop, './ns.cjs': interop, './dd.cjs': interop, './re.cjs': interop, './star.cjs': interop,
    './a.cjs': named, './all.cjs': named, './b.cjs': named, './side.js': side,
  })
  // A binding the code never reads is dropped by tree shaking: only the import's evaluation stays. JSX, an
  // `export { local }` and a direct eval read it.
  const used = (code, loader = 'js') => Object.fromEntries(analyze(code, { path: `f.${loader}`, loader }).imports)
  t.assert.deepStrictEqual(used("import unused from './u.cjs'\nconst unrelated = 1"), { './u.cjs': side })
  t.assert.deepStrictEqual(used("import Comp from './c.cjs'\nexport const el = <Comp />", 'jsx'), { './c.cjs': interop })
  t.assert.deepStrictEqual(used("import ui from './ui.cjs'\nexport const el = <ui.Button />", 'jsx'), { './ui.cjs': interop })
  // A lowercase tag is an intrinsic element's string, not a read of the name.
  t.assert.deepStrictEqual(used("import div from './d.cjs'\nexport const el = <div title='x' />", 'jsx'), { './d.cjs': side })
  t.assert.deepStrictEqual(used("import x from './x.cjs'\nexport { x }"), { './x.cjs': interop })
  t.assert.deepStrictEqual(used("import x from './x.cjs'\neval('x')"), { './x.cjs': interop })
  // A read is resolved by scope: a parameter of the name isn't the import, a closure over it is.
  t.assert.deepStrictEqual(used("import x from './x.cjs'\nfunction f(x) { return x }"), { './x.cjs': side })
  t.assert.deepStrictEqual(used("import x from './x.cjs'\nfunction f(y) { return () => x }"), { './x.cjs': interop })
})

test('analyzeModule: whether a require or import() uses its result', (t) => {
  const { requires } = analyze("require('./side.js')\nconst x = require('./used.js')\nrequire('./both.js')\nf(require('./both.js'))")
  t.assert.deepStrictEqual(Object.fromEntries(requires), {
    './side.js': { consumed: false }, './used.js': { consumed: true }, './both.js': { consumed: true },
  })
  const { dynamicImports } = analyze("import('./side.js')\nawait import('./awaited.js')\nimport('./then.js').then(f)\nconst m = await import('./used.js')")
  t.assert.deepStrictEqual(Object.fromEntries(dynamicImports), {
    './side.js': { consumed: false }, './awaited.js': { consumed: false }, './then.js': { consumed: true }, './used.js': { consumed: true },
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

test('analyzeModule: top-level `arguments` -- a module wrapper\'s, outside any function of its own', (t) => {
  t.assert.equal(analyze('console.log(arguments.length)').topArguments, true)
  t.assert.equal(analyze('const f = () => arguments[0]').topArguments, true)
  t.assert.equal(analyze('function f() { return arguments }\nconst o = { m() { return () => arguments } }\nx.arguments = 1').topArguments, false)
  // A local binding of the name is read instead.
  t.assert.equal(analyze('const arguments = [1]\nconsole.log(arguments[0])').topArguments, false)
  t.assert.equal(analyze('const f = (arguments) => arguments[0]').topArguments, false)
  // A `var` of the name in the wrapper's body is the arguments object itself.
  t.assert.equal(analyze('console.log(arguments[0])\nvar arguments').topArguments, true)
})

test('analyzeModule: a constant __esModule key marks wherever it may be defined, as Babel/tsc/esbuild CommonJS output defines it', (t) => {
  const marks = (source, opts) => analyze(source, opts).setsEsModule
  t.assert.equal(marks('exports.__esModule = true'), true)
  t.assert.equal(marks('Object.defineProperty(exports, "__esModule", { value: true })'), true)
  t.assert.equal(marks('var d=Object.defineProperty;d(e,"__esModule",{value:!0})'), true)
  t.assert.equal(marks('var __defProp = Object.defineProperty\nvar __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod)\nmodule.exports = __toCommonJS(src_exports)'), true)
  t.assert.equal(marks('module.exports = { __esModule: true, default: 1 }'), true)
  t.assert.equal(marks('Object.defineProperties(exports, { __esModule: { value: true } })'), true)
  t.assert.equal(marks('Object.defineProperties(exports, { __esModule: { get: () => flag } })'), true)
  t.assert.equal(marks('Object.defineProperty(exports, "__esModule", { get: () => flag })'), true)
  t.assert.equal(marks('module.exports = { get __esModule() { return true }, default: 1 }'), true)
  t.assert.equal(marks('module.exports = class { static __esModule = true; static default = 1 }'), true)
  t.assert.equal(marks('class Box { get __esModule() { return true } }\nmodule.exports = new Box()'), true)
  // A fail-safe: where the value goes isn't followed, so a key defined on anything counts -- a local that may
  // become the exports however it gets there (a factory called through `.call`, a property read, a destructuring).
  t.assert.equal(marks('const metadata = {}\nmetadata.__esModule = true\nmodule.exports = { default: 1 }'), true)
  t.assert.equal(marks("report({}, '__esModule', { value: true })\nmodule.exports = { default: 1 }"), true)
  t.assert.equal(marks('function make() { return { __esModule: true, default: 1 } }\nmodule.exports = make.call(null)'), true)
  t.assert.equal(marks('const o = { make() { return { __esModule: true, default: 1 } } }\nmodule.exports = o.make()'), true)
  t.assert.equal(marks('const o = {}\no.lib = { __esModule: true, default: 1 }\nmodule.exports = o.lib'), true)
  t.assert.equal(marks('class Box { constructor() { this.lib = { __esModule: true } } }\nmodule.exports = new Box().lib'), true)
  t.assert.equal(marks('for (const m of [{ __esModule: true }]) module.exports = m'), true)
  t.assert.equal(marks('const [out] = [{ default: 1 }, { __esModule: true }]\nmodule.exports = out'), true)
  t.assert.equal(marks("module.exports = Reflect.defineProperty({}, '__esModule', { value: true })"), true)
  // Every property write, destructuring and compound assignments included.
  t.assert.equal(marks('exports.__esModule = 0\nexports.__esModule++'), true)
  t.assert.equal(marks('exports.__esModule ||= true'), true)
  t.assert.equal(marks(';[exports.__esModule] = [true]'), true)
  t.assert.equal(marks('({ a: exports.__esModule } = { a: true })'), true)
  t.assert.equal(marks('for (exports.__esModule of [true]);'), true)
  t.assert.equal(marks("exports['__es' + 'Module'] = true"), true)
  // A string can flow into any key, so one held anywhere counts (`exports[marker] = true`).
  t.assert.equal(marks("const marker = '__esModule'\nmodule.exports = { [marker]: false, default: 1 }"), true)
  t.assert.equal(marks("const keys = ['default', '__esModule']"), true)
  t.assert.equal(marks('Object.create(null, { __esModule: { value: true } })'), true)
  t.assert.equal(marks('class Box { __esModule = true }'), true)
  t.assert.equal(marks('<div __esModule />', { path: 'f.jsx', loader: 'jsx' }), true)
  t.assert.equal(marks('enum E { __esModule = 1 }', { path: 'f.ts', loader: 'ts' }), true)
  t.assert.equal(marks('class Box { constructor(public __esModule = true) {} }', { path: 'f.ts', loader: 'ts' }), true)
  // A statically falsy value and a setter alone define nothing truthy; `undefined` is a name a declaration can
  // rebind.
  t.assert.equal(marks('module.exports = { __esModule: false, default: 1 }'), false)
  t.assert.equal(marks('exports.__esModule = void 0'), false)
  t.assert.equal(marks('module.exports = { set __esModule(v) {}, default: 1 }'), false)
  t.assert.equal(marks('module.exports = class { static set __esModule(v) {} }'), false)
  t.assert.equal(marks('class Box { __esModule }'), false)
  t.assert.equal(marks('const undefined = true\nmodule.exports = { __esModule: undefined, default: 1 }'), true)
  // Reads, comparisons, a `case`, a destructuring pattern's key, a removal and a variable's name aren't
  // definitions -- nor is a part of another string.
  t.assert.equal(marks('module.exports = (m) => m && m.__esModule ? m.default : m'), false)
  t.assert.equal(marks("module.exports = (m) => m['__esModule'] || typeof m.__esModule === 'boolean' || m.__esModule()"), false)
  t.assert.equal(marks("for (const k in m) if (k === '__esModule' || '__esModule' in m) continue"), false)
  t.assert.equal(marks("switch (k) { case '__esModule': break }"), false)
  t.assert.equal(marks('const { __esModule, ...rest } = m\nmodule.exports = rest'), false)
  t.assert.equal(marks('delete exports.__esModule'), false)
  t.assert.equal(marks('var __esModule = 1\nmodule.exports = { [__esModule]: 1 }'), false)
  t.assert.equal(marks("exports['__esModule' + suffix] = true"), false)
  // Any call may define the key it's handed, whatever its callee is meant to do: a function named like a read
  // builtin, a read builtin (whose Proxy trap turns it into a write), one handed a falsy descriptor.
  t.assert.equal(marks("function get(o, k) { o[k] = true }\nget(exports, '__esModule')\nexports.default = 1"), true)
  t.assert.equal(marks("function set(o, key, descriptor) { o[key] = true }\nset(exports, '__esModule', { value: false })"), true)
  t.assert.equal(marks('Object.defineProperty(exports, "__esModule", { value: false })'), true)
  t.assert.equal(marks('Object.defineProperties(exports, { __esModule: { value: false }, default: { value: 1 } })'), true)
  t.assert.equal(marks("Reflect.get(new globalThis.Proxy({}, { get(_, key) { exports[key] = true } }), '__esModule')"), true)
  t.assert.equal(marks('Object.prototype.hasOwnProperty.call(m, "__esModule")'), true)
})

test('analyzeModule: a key only the runtime knows marks where it reaches the exports -- a computed key, a Proxy, a runtime require', (t) => {
  const marks = (source) => analyze(source).setsEsModule
  t.assert.equal(marks('const marker = process.env.MARKER\nmodule.exports = { [marker]: true, default: 1 }'), true)
  t.assert.equal(marks('module.exports = { [process.env.MARKER]: true, default: 1 }'), true)
  t.assert.equal(marks('module.exports = class { static [key()] = 1 }'), true)
  t.assert.equal(marks("const key = 'name'\nmodule.exports = { [key]: true, default: 1 }\nexports[key] = true"), false)
  t.assert.equal(marks("function make() { const k = 'name'; return { [k]: 1 } }\nmodule.exports = make()"), false)
  // Followed through what reaches the exports: a local's values, a function's returns (called through
  // `.call`/`.apply`, bound, or behind a sequence), an instance's class.
  t.assert.equal(marks('function make(k) { return { [k]: true } }\nmodule.exports = make.call(null, key)'), true)
  t.assert.equal(marks('function make(k) { return { [k]: true } }\nmodule.exports = (0, make)(key)'), true)
  t.assert.equal(marks('function make(k) { return { [k]: true } }\nmodule.exports = make.bind(null)(key)'), true)
  t.assert.equal(marks('function make(k) { return { [k]: true } }\nmodule.exports = Reflect.apply(make, null, [key])'), true)
  t.assert.equal(marks('class Box { [key()] = 1 }\nmodule.exports = new Box()'), true)
  t.assert.equal(marks('class Box { static [key()] = 1 }\nmodule.exports = new Box()'), false)
  // Resolved at the key: a parameter of the name is unknown, whatever an outer declaration of it holds.
  t.assert.equal(marks("const marker = 'safe'\nfunction set(marker) { module.exports = { [marker]: true, default: 1 } }\nset(x)"), true)
  // A symbol or a number isn't `__esModule` -- unless the file binds `Symbol` itself.
  t.assert.equal(marks("const s = Symbol('s')\nmodule.exports = { [Symbol.iterator]: f, [s]: 1, [0]: 1, default: 1 }"), false)
  t.assert.equal(marks("const Symbol = (x) => x\nmodule.exports = { [Symbol(key)]: true, default: 1 }"), true)
  t.assert.equal(marks('function f(Symbol) {}\nmodule.exports = { [Symbol.iterator]: f, default: 1 }'), false)
  // A write through a key whose value isn't known doesn't count: fs-extra's loop isn't a mark.
  t.assert.equal(marks('api.forEach((method) => { exports[method] = u(fs[method]) })'), false)
  // A Proxy can answer `__esModule` from its trap; a local named Proxy is just a class, but a parameter elsewhere
  // named Proxy doesn't shadow the global here.
  t.assert.equal(marks("module.exports = new Proxy({ default: 1 }, { get: (t, k) => k === '__esModule' || t[k] })"), true)
  t.assert.equal(marks('class Proxy { default = 1 }\nmodule.exports = new Proxy()'), false)
  t.assert.equal(marks('function ignore(Proxy) {}\nmodule.exports = new Proxy(target, handler)'), true)
  // ...however the constructor is reached: read off an object (by name or a key only the runtime knows), an alias,
  // `Reflect.construct`.
  t.assert.equal(marks('module.exports = new globalThis.Proxy({ default: 1 }, handler)'), true)
  t.assert.equal(marks("module.exports = new globalThis['Pro' + 'xy'](target, handler)"), true)
  t.assert.equal(marks('const P = globalThis.Proxy\nmodule.exports = new P(target, handler)'), true)
  t.assert.equal(marks('const P = Proxy\nmodule.exports = new (0, P)(target, handler)'), true)
  t.assert.equal(marks('module.exports = Reflect.construct(Proxy, [target, handler])'), true)
  t.assert.equal(marks('const { Proxy: P } = globalThis\nmodule.exports = new P({ default: 1 }, handler)'), true)
  t.assert.equal(marks('const [P] = [Proxy]\nmodule.exports = new P(target, handler)'), true)
  t.assert.equal(marks("const name = 'Proxy'\nconst { [name]: P } = globalThis\nmodule.exports = new P({ default: 1 }, handler)"), true)
  t.assert.equal(marks('module.exports = Proxy.revocable({ default: 1 }, handler).proxy'), true)
  t.assert.equal(marks('const { proxy } = globalThis.Proxy.revocable(target, handler)\nmodule.exports = proxy'), true)
  t.assert.equal(marks('const pair = Proxy.revocable(target, handler)\nmodule.exports = pair.proxy'), true)
  t.assert.equal(marks('module.exports = Proxy.revocable(target, handler).revoke'), false)
  t.assert.equal(marks("const { Store } = require('./lib')\nmodule.exports = new Store()"), false)
  t.assert.equal(marks('var Proxy\nmodule.exports = new Proxy(target, handler)'), false)
  t.assert.equal(marks("const EventEmitter = require('events')\nmodule.exports = new EventEmitter()"), false)
  t.assert.equal(marks('module.exports = new lib.Store()'), false)
  // A require only the runtime resolves may hand over anything; esbuild splits a conditional one. A bundle's own
  // `require` parameter, and a local named `exports`, aren't CommonJS's.
  t.assert.equal(marks('module.exports = require(process.env.DEP)'), true)
  t.assert.deepStrictEqual(analyze("module.exports = require(dev ? './a' : './b')").reexports, new Set(['./a', './b']))
  t.assert.equal(marks('(function (require) { module.exports = require(11) })(r)'), false)
  // esbuild renames a module-scope `var require` (`require2`) and bundles no call of it, initialized or not.
  t.assert.deepStrictEqual(analyze("var require\nmodule.exports = require('./inner.cjs')").reexports, new Set())
  t.assert.equal(marks('const load = (mod) => { let exports; exports = require(mod); return exports }\nmodule.exports = { load }'), false)
  t.assert.equal(marks("module.exports = require('./x').default"), false)
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
  // Called through `.call`/`.apply`, bound, behind a sequence, by `Reflect.apply`, or through an alias.
  t.assert.deepStrictEqual(reexports("function load() { return require('./x') }\nmodule.exports = load.call(null)"), ['./x'])
  t.assert.deepStrictEqual(reexports("function load() { return require('./x') }\nmodule.exports = load.apply(null, [])"), ['./x'])
  t.assert.deepStrictEqual(reexports("function load() { return require('./x') }\nmodule.exports = load.bind(null)()"), ['./x'])
  t.assert.deepStrictEqual(reexports("function load() { return require('./x') }\nmodule.exports = (0, load)()"), ['./x'])
  t.assert.deepStrictEqual(reexports("function load() { return require('./x') }\nmodule.exports = Reflect.apply(load, null, [])"), ['./x'])
  t.assert.deepStrictEqual(reexports("function load() { return require('./x') }\nconst run = load\nmodule.exports = run()"), ['./x'])
  // A local object's method, getter or class static, a function set on a local, and a property set on one.
  t.assert.deepStrictEqual(reexports("const h = { load() { return require('./a') }, other: () => require('./b') }\nmodule.exports = h.load()"), ['./a'])
  t.assert.deepStrictEqual(reexports("class H { static load() { return require('./a') } }\nmodule.exports = H.load()"), ['./a'])
  t.assert.deepStrictEqual(reexports("const h = {}\nh.load = function () { return require('./a') }\nmodule.exports = h.load.call(h)"), ['./a'])
  t.assert.deepStrictEqual(reexports("const h = { load() { return require('./a') } }\nconst g = h\nmodule.exports = g.load()"), ['./a'])
  t.assert.deepStrictEqual(reexports("const h = {}\nh.lib = require('./a')\nmodule.exports = h.lib"), ['./a'])
  t.assert.deepStrictEqual(reexports("const h = { load() { return require('./a') } }\nmodule.exports = { run: h.load }"), [])
  t.assert.deepStrictEqual(reexports("module.exports = ({ inner: { load: () => require('./a'), other: () => require('./b') } }).inner.load()"), ['./a'])
  // Nested in the exports isn't the exports; spread into them is.
  t.assert.deepStrictEqual(reexports("module.exports = { a: require('./a'), ...require('./b') }"), ['./b'])
  // An array pattern or an index read takes the element at its position, or past one a spread before it shifts.
  t.assert.deepStrictEqual(reexports("const [a] = [require('./a'), require('./b')]\nmodule.exports = a"), ['./a'])
  t.assert.deepStrictEqual(reexports("const [, b] = [require('./a'), require('./b')]\nmodule.exports = b"), ['./b'])
  t.assert.deepStrictEqual(reexports("module.exports = [require('./a'), require('./b')][1]"), ['./b'])
  t.assert.deepStrictEqual(reexports("const [, ...rest] = [require('./a'), require('./b')]\nmodule.exports = rest[0]"), ['./b'])
  t.assert.deepStrictEqual(reexports("const [, b] = [...more, require('./a'), require('./b')]\nmodule.exports = b"), ['./a', './b'])
  t.assert.deepStrictEqual(reexports("const list = [require('./a'), require('./b')]\nmodule.exports = list[i]"), ['./a', './b'])
  t.assert.deepStrictEqual(reexports("const list = [require('./a')]\nmodule.exports = list.length"), [])
})
