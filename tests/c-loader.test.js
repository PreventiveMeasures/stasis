import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { cFormatOf, collectCBundle, detectProjects, includeSpec, isCEntry, loadCompileCommands, scanIncludes, splitCommand } from '../stasis/src/loaders/c.js'

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-c-loader-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Write `files` ({ path: text }) under `dir`.
const tree = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

const captureWarnings = (fn) => {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = original
  }
}

const specs = (text) => scanIncludes(text).map((inc) => `${includeSpec(inc)} ${inc.state}`)

test('scanIncludes finds each include-like directive and form', (t) => {
  const src = '#include "a.h"\n#include <b.h>\n#import "c.h"\n#include_next <d.h>\n#embed "e.bin" limit(4)\n#include CONFIG_H\n'
  t.assert.deepStrictEqual(specs(src), [
    'include "a.h" live',
    'include <b.h> live',
    'import "c.h" live',
    'include_next <d.h> live',
    'embed "e.bin" live',
    'include CONFIG_H live',
  ])
  t.assert.equal(scanIncludes('#include CONFIG_H\n')[0].form, 'macro')
})

test('scanIncludes reads directives as translation phase 4 does: spacing, comments, %:, splices', (t) => {
  t.assert.deepStrictEqual(specs('  #  include   "a.h"\n'), ['include "a.h" live'])
  t.assert.deepStrictEqual(specs('# /* c */ include /* d */ <b.h> // e\n'), ['include <b.h> live'])
  t.assert.deepStrictEqual(specs('%:include "c.h"\n'), ['include "c.h" live'])
  t.assert.deepStrictEqual(specs('#inc\\\nlude "d.h"\n'), ['include "d.h" live'])
  t.assert.deepStrictEqual(specs('#include \\\r\n "e.h"\n'), ['include "e.h" live'])
  // A comment before the `#` is a space: still first on its line.
  t.assert.deepStrictEqual(specs('/* one\n two */ #include "f.h"\n'), ['include "f.h" live'])
  // Code before it is not.
  t.assert.deepStrictEqual(specs('int x; #include "g.h"\n'), [])
})

test('scanIncludes skips comments and literals', (t) => {
  const src = [
    '// #include "line.h"',
    '/* #include "block.h"',
    '#include "inside.h" */',
    'const char *s = "#include \\"str.h\\"";',
    "char c = '#';",
    'const char *r = R"x(',
    '#include "raw.h"',
    ')x";',
    '// a comment ending in a splice \\',
    '#include "spliced-into-comment.h"',
    '#include "real.h" /* a comment',
    '#include "in-comment.h" */',
    '#include "after.h"',
  ].join('\n')
  t.assert.deepStrictEqual(specs(src), ['include "real.h" live', 'include "after.h" live'])
})

test('scanIncludes: a digit separator or a stray apostrophe never swallows a later directive', (t) => {
  t.assert.deepStrictEqual(specs("int n = 1'000'000;\n#include \"a.h\"\n"), ['include "a.h" live'])
  t.assert.deepStrictEqual(specs("#if 0\nwe don't build this\n#endif\n#include \"b.h\"\n"), ['include "b.h" live'])
  t.assert.deepStrictEqual(specs("#error can't\n#include \"c.h\"\n"), ['include "c.h" live'])
})

test('scanIncludes tells live, maybe and dead code apart', (t) => {
  const src = [
    '#include "top.h"',
    '#if 0',
    '#include "dead.h"',
    '#elif 1',
    '#include "elif-live.h"',
    '#else',
    '#include "dead-else.h"',
    '#endif',
    '#ifdef _WIN32',
    '#include "win.h"',
    '#  if 0',
    '#include "dead-nested.h"',
    '#  endif',
    '#else',
    '#include "posix.h"',
    '#endif',
    '#if 1',
    '#include "one.h"',
    '#else',
    '#include "not-one.h"',
    '#endif',
    '#if FOO',
    '#elif 1',
    '#include "after-maybe.h"',
    '#endif',
  ].join('\n')
  t.assert.deepStrictEqual(specs(src), [
    'include "top.h" live',
    'include "elif-live.h" live',
    'include "win.h" maybe',
    'include "posix.h" maybe',
    'include "one.h" live',
    'include "after-maybe.h" maybe',
  ])
})

test('scanIncludes takes a file\'s include guard for no condition', (t) => {
  t.assert.deepStrictEqual(specs('#ifndef A_H\n#define A_H\n#include "x.h"\n#endif\n'), ['include "x.h" live'])
  t.assert.deepStrictEqual(specs('// header\n#pragma once\n#if !defined(A_H)\n#define A_H\n#include "x.h"\n#endif\n'), ['include "x.h" live'])
  t.assert.deepStrictEqual(specs('#if !defined A_H\n#define A_H 1\n#include "x.h"\n#endif\n'), ['include "x.h" live'])
  // Not the first directive, or no matching #define: a condition like any other.
  t.assert.deepStrictEqual(specs('#include "y.h"\n#ifndef A_H\n#define A_H\n#include "x.h"\n#endif\n'), ['include "y.h" live', 'include "x.h" maybe'])
  t.assert.deepStrictEqual(specs('#ifndef A_H\n#define B_H\n#include "x.h"\n#endif\n'), ['include "x.h" maybe'])
  // With an #else or #elif, or not enclosing the file, it is a condition: its branches undecided.
  t.assert.deepStrictEqual(specs('#ifndef MODE\n#define MODE\n#include "a.h"\n#else\n#include "b.h"\n#endif\n'), ['include "a.h" maybe', 'include "b.h" maybe'])
  t.assert.deepStrictEqual(specs('#if !defined(A_H)\n#define A_H\n#include "a.h"\n#elif 1\n#include "b.h"\n#endif\n'), ['include "a.h" maybe', 'include "b.h" maybe'])
  t.assert.deepStrictEqual(specs('#ifndef USE_X\n#define USE_X\n#include "x.h"\n#endif\n#include "y.h"\n'), ['include "x.h" maybe', 'include "y.h" live'])
  t.assert.deepStrictEqual(specs('#ifndef A_H\n#define A_H\n#include "x.h"\n#endif\nint after;\n'), ['include "x.h" maybe'])
  t.assert.deepStrictEqual(specs('int before;\n#ifndef A_H\n#define A_H\n#include "x.h"\n#endif\n'), ['include "x.h" maybe'])
  t.assert.deepStrictEqual(specs('#ifndef A_H\nint between;\n#define A_H\n#include "x.h"\n#endif\n'), ['include "x.h" maybe'])
  // Another pragma first: the conditional may be a feature's, set apart from the file by it.
  t.assert.deepStrictEqual(specs('#pragma GCC system_header\n#ifndef A_H\n#define A_H\n#include "x.h"\n#endif\n'), ['include "x.h" maybe'])
  t.assert.deepStrictEqual(specs('#pragma  once \n#ifndef A_H\n#define A_H\n#include "x.h"\n#endif\n'), ['include "x.h" live'])
  // Comments after the #endif leave it the file's guard.
  t.assert.deepStrictEqual(specs('#ifndef A_H\n#define A_H\n#ifdef W\n#include "w.h"\n#endif\n#include "x.h"\n#endif /* A_H */\n// end\n'), ['include "w.h" maybe', 'include "x.h" live'])
})

test('isCEntry and cFormatOf', (t) => {
  for (const f of ['a.c', 'a.cc', 'a.cpp', 'a.cxx', 'a.c++', 'a.h', 'a.hh', 'a.hpp', 'a.hxx', 'a.h++']) t.assert.ok(isCEntry(f), f)
  for (const f of ['a.js', 'a.m', 'a.inl', 'a']) t.assert.ok(!isCEntry(f), f)
  t.assert.equal(cFormatOf('a.c'), 'c')
  t.assert.equal(cFormatOf('a.cc'), 'cpp')
  t.assert.equal(cFormatOf('a.h'), 'c-header')
  t.assert.equal(cFormatOf('a.hpp'), 'cpp-header')
  // Anything else a file includes is a header of its includer's language.
  t.assert.equal(cFormatOf('a.inl', 'cpp'), 'cpp-header')
  t.assert.equal(cFormatOf('Eigen/Core', 'cpp-header'), 'cpp-header')
  t.assert.equal(cFormatOf('table.inc', 'c'), 'c-header')
})

test('splitCommand splits as a POSIX shell does', (t) => {
  t.assert.deepStrictEqual(splitCommand('cc -I"a b" -I\'c d\' -DX=\\"y\\" -c  x.c'), ['cc', '-Ia b', '-Ic d', '-DX="y"', '-c', 'x.c'])
  t.assert.deepStrictEqual(splitCommand('cc "-DS=\\"q\\"" e\\ f'), ['cc', '-DS="q"', 'e f'])
})

test('loadCompileCommands reads each unit\'s search flags, relative to its directory', withTmp((t, tmp) => {
  tree(tmp, { 'src/a.c': '', 'src/b.cc': '' })
  const db = [
    { directory: join(tmp, 'build'), file: '../src/a.c', arguments: ['cc', '-I../include', '-I', '../gen', '-iquote', '../q', '-isystem/usr/include', '-idirafter', '../after', '-include', 'config.h', '-o', '-Inot-a-dir', '-c', '../src/a.c'] },
    { directory: tmp, file: join(tmp, 'src/b.cc'), command: 'c++ --include-directory=lib -imacros macros.h -I=sysroot-rel -c src/b.cc' },
    { directory: tmp, file: 'src/a.c', arguments: ['cc', '-Isecond', '-c', 'src/a.c'] },
    { directory: tmp, file: '/elsewhere/c.c', arguments: ['cc', '-c', '/elsewhere/c.c'] },
  ]
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify(db))
  const commands = loadCompileCommands(tmp, '.') // a directory names the compile_commands.json in it
  t.assert.deepStrictEqual([...commands.keys()], ['src/a.c', 'src/b.cc'])
  t.assert.deepStrictEqual(commands.get('src/a.c'), {
    quote: [{ rel: 'q' }],
    I: [{ rel: 'include' }, { rel: 'gen' }],
    system: [{ abs: '/usr/include' }],
    after: [{ rel: 'after' }],
    embed: [],
    forced: [{ flag: '-include', path: 'config.h', dir: { rel: 'build' } }],
  })
  t.assert.deepStrictEqual(commands.get('src/b.cc').I, [{ rel: 'lib' }])
  t.assert.deepStrictEqual(commands.get('src/b.cc').forced, [{ flag: '-imacros', path: 'macros.h', dir: { rel: '' } }])
}))

test('loadCompileCommands refuses a database it can\'t read as one', withTmp((t, tmp) => {
  writeFileSync(join(tmp, 'cc.json'), '{"not": "an array"}')
  t.assert.throws(() => loadCompileCommands(tmp, 'cc.json'), { message: 'Compilation database is not an array of commands: cc.json' })
  writeFileSync(join(tmp, 'cc.json'), '[{"directory": "/x", "file": "a.c"}]')
  t.assert.throws(() => loadCompileCommands(tmp, 'cc.json'), /command 0 has neither an `arguments` array of strings nor a `command` string/)
  t.assert.throws(() => loadCompileCommands(tmp, 'nope.json'), /Can't read the compilation database nope\.json: ENOENT/)
}))

test('collectCBundle searches as GCC does: the includer\'s dir for "x", then -iquote, -I, -isystem', withTmp((t, tmp) => {
  tree(tmp, {
    'src/main.c': '#include "local.h"\n#include "shadow.h"\n#include <shadow.h>\n#include <lib.h>\n#include <stdio.h>\n',
    'src/local.h': '',
    'src/shadow.h': '',
    'include/shadow.h': '',
    'include/lib.h': '#include "sibling.h"\n',
    'include/sibling.h': '',
  })
  const { sources, resolutions, missing, unfound } = collectCBundle(tmp, ['src/main.c'], { includeDirs: ['include'] })
  t.assert.deepStrictEqual([...sources.keys()].toSorted(), ['include/lib.h', 'include/shadow.h', 'include/sibling.h', 'src/local.h', 'src/main.c', 'src/shadow.h'])
  t.assert.deepStrictEqual(Object.fromEntries(resolutions.get('src/main.c')), {
    'include "local.h"': 'src/local.h',
    'include "shadow.h"': 'src/shadow.h',
    'include <shadow.h>': 'include/shadow.h',
    'include <lib.h>': 'include/lib.h',
  })
  t.assert.deepStrictEqual(Object.fromEntries(resolutions.get('include/lib.h')), { 'include "sibling.h"': 'include/sibling.h' })
  t.assert.deepStrictEqual(missing, [])
  t.assert.deepStrictEqual(unfound, [])
}))

test('collectCBundle: #include_next carries on past the directory its includer was found in', withTmp((t, tmp) => {
  tree(tmp, {
    'main.c': '#include <stdio.h>\n',
    'wrap/stdio.h': '#include_next <stdio.h>\n',
    'real/stdio.h': '',
  })
  const { sources, resolutions } = collectCBundle(tmp, ['main.c'], { includeDirs: ['wrap', 'real'] })
  t.assert.deepStrictEqual([...sources.keys()].toSorted(), ['main.c', 'real/stdio.h', 'wrap/stdio.h'])
  t.assert.equal(resolutions.get('wrap/stdio.h').get('include_next <stdio.h>'), 'real/stdio.h')
  // Past the last directory, it is the system's: nothing to bundle, nothing missing.
  const alone = collectCBundle(tmp, ['main.c'], { includeDirs: ['wrap'] })
  t.assert.deepStrictEqual([...alone.sources.keys()].toSorted(), ['main.c', 'wrap/stdio.h'])
  t.assert.deepStrictEqual(alone.missing, [])
}))

test('collectCBundle follows a header to its implementation file, beside it or in the src/ mirroring its include/', withTmp((t, tmp) => {
  tree(tmp, {
    'app/main.cpp': '#include "../lib/util.h"\n#include <mylib/api.hpp>\n',
    'lib/util.h': '',
    'lib/util.c': '#include "util.h"\n#include "missing-in-guess.h"\n',
    'include/mylib/api.hpp': '',
    'src/api.cpp': '#include <mylib/api.hpp>\n',
    'src/other.cpp': '',
  })
  const { sources, formats, resolutions, missing } = collectCBundle(tmp, ['app/main.cpp'], { includeDirs: ['include'] })
  t.assert.deepStrictEqual([...sources.keys()].toSorted(), ['app/main.cpp', 'include/mylib/api.hpp', 'lib/util.c', 'lib/util.h', 'src/api.cpp'])
  t.assert.equal(resolutions.get('lib/util.h').get('impl util.c'), 'lib/util.c')
  t.assert.equal(resolutions.get('include/mylib/api.hpp').get('impl ../../src/api.cpp'), 'src/api.cpp')
  t.assert.equal(formats.get('lib/util.c'), 'c')
  t.assert.equal(formats.get('include/mylib/api.hpp'), 'cpp-header')
  // An implementation file is a guess: what it lacks doesn't make the bundle incomplete.
  t.assert.deepStrictEqual(missing, [])
}))

test('collectCBundle follows the known links of libraries whose sources aren\'t named after their headers', withTmp((t, tmp) => {
  tree(tmp, {
    'main.cc': '#include <v8.h>\n#include <uv.h>\n#include <openssl/evp.h>\n',
    'deps/v8/include/v8.h': '',
    'deps/v8/src/api/api.cc': '',
    'deps/v8/src/api/api-natives.cc': '',
    'deps/v8/src/other/unrelated.cc': '',
    'deps/uv/include/uv.h': '',
    'deps/uv/src/uv-common.c': '',
    'deps/uv/src/unix/fs.c': '',
    'deps/uv/src/win/fs.c': '',
    'deps/uv/src/.hidden/x.c': '',
    'deps/uv/test/test-fs.c': '',
    'deps/openssl/include/openssl/evp.h': '',
    'deps/openssl/crypto/evp/digest.c': '',
    'deps/openssl/crypto/bn/bn_add.c': '',
  })
  const includeDirs = ['deps/v8/include', 'deps/uv/include', 'deps/openssl/include']
  const { sources, resolutions } = collectCBundle(tmp, ['main.cc'], { includeDirs })
  t.assert.deepStrictEqual([...sources.keys()].toSorted(), [
    'deps/openssl/crypto/evp/digest.c',
    'deps/openssl/include/openssl/evp.h',
    'deps/uv/include/uv.h',
    'deps/uv/src/unix/fs.c',
    'deps/uv/src/uv-common.c',
    'deps/uv/src/win/fs.c',
    'deps/v8/include/v8.h',
    'deps/v8/src/api/api-natives.cc',
    'deps/v8/src/api/api.cc',
    'main.cc',
  ])
  // Keyed by the path from the header's directory: two fs.c are two edges.
  t.assert.deepStrictEqual(Object.fromEntries(resolutions.get('deps/uv/include/uv.h')), {
    'impl ../src/unix/fs.c': 'deps/uv/src/unix/fs.c',
    'impl ../src/uv-common.c': 'deps/uv/src/uv-common.c',
    'impl ../src/win/fs.c': 'deps/uv/src/win/fs.c',
  })
  t.assert.equal(resolutions.get('deps/v8/include/v8.h').get('impl ../src/api/api.cc'), 'deps/v8/src/api/api.cc')
  t.assert.equal(resolutions.get('deps/openssl/include/openssl/evp.h').get('impl ../../crypto/evp/digest.c'), 'deps/openssl/crypto/evp/digest.c')
  // No known links, none followed.
  const plain = collectCBundle(tmp, ['main.cc'], { includeDirs, knownLinks: [] })
  t.assert.deepStrictEqual([...plain.sources.keys()].toSorted(), ['deps/openssl/include/openssl/evp.h', 'deps/uv/include/uv.h', 'deps/v8/include/v8.h', 'main.cc'])
}))

test('collectCBundle follows Node.js\'s known links: its bindings, by the macro registering them, and headers implemented across files', withTmp((t, tmp) => {
  tree(tmp, {
    'src/node_main.cc': '#include "node.h"\n',
    'src/node.h': '#include "node_binding.h"\n#include "node_process.h"\n',
    'src/node_binding.h': '',
    'src/node_process.h': '',
    'src/node_process_object.cc': '',
    'src/node_env_var.cc': '',
    'src/api/environment.cc': '',
    'src/node_os.cc': 'namespace node {}\nNODE_BINDING_CONTEXT_AWARE_INTERNAL(os, node::os::Initialize)\n',
    'src/quic/quic.cc': '  NODE_BINDING_PER_ISOLATE_INIT(quic, node::quic::CreatePerIsolateProperties)\n',
    'src/commented.cc': '// NODE_BINDING_CONTEXT_AWARE_INTERNAL(no, ...)\n',
    'src/plain.cc': '',
  })
  const { sources, resolutions } = collectCBundle(tmp, ['src/node_main.cc'])
  t.assert.deepStrictEqual([...sources.keys()].toSorted(), [
    'src/api/environment.cc',
    'src/node.h',
    'src/node_binding.h',
    'src/node_env_var.cc',
    'src/node_main.cc',
    'src/node_os.cc',
    'src/node_process.h',
    'src/node_process_object.cc',
    'src/quic/quic.cc',
  ])
  t.assert.deepStrictEqual(Object.fromEntries(resolutions.get('src/node_binding.h')), { 'impl node_os.cc': 'src/node_os.cc', 'impl quic/quic.cc': 'src/quic/quic.cc' })
  t.assert.equal(resolutions.get('src/node.h').get('impl api/environment.cc'), 'src/api/environment.cc')
}))

// A Node.js-shaped tree: its own zlib in deps/, V8 with another copy in its third_party/, OpenSSL
// inside Node.js's wrapper of it.
const nodeLike = {
  'src/node.h': '',
  'src/node_main.cc': '#include "node.h"\n',
  'src/node_zlib.cc': '#include "zlib.h"\n#include <v8.h>\n#include <openssl/evp.h>\n',
  'deps/zlib/zlib.h': '#include "zconf.h"\n',
  'deps/zlib/zconf.h': '',
  'deps/zlib/deflate.c': '',
  'deps/v8/include/v8.h': '',
  'deps/v8/src/api/api.cc': '',
  'deps/v8/src/compress.cc': '#include "zlib.h"\n#include "src/base/macros.h"\n',
  'deps/v8/src/base/macros.h': '',
  'deps/v8/third_party/zlib/zlib.h': '',
  'deps/v8/third_party/zlib/deflate.c': '',
  'deps/openssl/config/bn_conf.h': '',
  'deps/openssl/openssl/crypto/cryptlib.c': '',
  'deps/openssl/openssl/crypto/evp/digest.c': '#include "crypto/bn_conf.h"\n',
  'deps/openssl/openssl/include/openssl/opensslv.h': '',
  'deps/openssl/openssl/include/openssl/evp.h': '',
  'deps/openssl/openssl/include/crypto/bn_conf.h': '#include "../../../config/bn_conf.h"\n',
}

test('detectProjects finds known projects and gives each its build\'s search path, nearest projects first', withTmp((t, tmp) => {
  tree(tmp, nodeLike)
  const { projects, of } = detectProjects(tmp)
  t.assert.deepStrictEqual(projects.map((p) => `${p.name} ${p.root || '.'}`), [
    'Node.js .',
    'OpenSSL (Node.js) deps/openssl', // OpenSSL's own tree inside it is the wrapper's
    'V8 deps/v8',
    'zlib deps/v8/third_party/zlib',
    'zlib deps/zlib',
  ])
  const path = (file) => of(file).searchPath.map((d) => d.rel)
  // Node.js's sources: its own, then its deps by depth -- its zlib before V8's.
  t.assert.deepStrictEqual(path('src/node_zlib.cc'), ['src', 'deps/openssl/openssl/include', 'deps/v8/include', 'deps/zlib', 'deps/v8/third_party/zlib'])
  // V8's: its own, then what it holds, then its siblings -- never Node.js's src.
  t.assert.deepStrictEqual(path('deps/v8/src/compress.cc'), ['deps/v8', 'deps/v8/include', 'deps/v8/third_party/zlib', 'deps/openssl/openssl/include', 'deps/zlib'])
  t.assert.equal(of('deps/openssl/openssl/crypto/evp/digest.c').name, 'OpenSSL (Node.js)')
  t.assert.equal(of('README.md').name, 'Node.js')
}))

test('collectCBundle searches each unit as its known project builds it, with no -I given', withTmp((t, tmp) => {
  tree(tmp, nodeLike)
  const { sources, resolutions, missing } = collectCBundle(tmp, ['src/node_zlib.cc', 'deps/v8/src/compress.cc', 'deps/openssl/openssl/crypto/evp/digest.c'])
  t.assert.deepStrictEqual(missing, [])
  t.assert.deepStrictEqual(Object.fromEntries(resolutions.get('src/node_zlib.cc')), {
    'include "zlib.h"': 'deps/zlib/zlib.h',
    'include <v8.h>': 'deps/v8/include/v8.h',
    'include <openssl/evp.h>': 'deps/openssl/openssl/include/openssl/evp.h',
  })
  t.assert.equal(resolutions.get('deps/v8/src/compress.cc').get('include "zlib.h"'), 'deps/v8/third_party/zlib/zlib.h')
  t.assert.equal(resolutions.get('deps/v8/src/compress.cc').get('include "src/base/macros.h"'), 'deps/v8/src/base/macros.h')
  t.assert.equal(resolutions.get('deps/openssl/openssl/crypto/evp/digest.c').get('include "crypto/bn_conf.h"'), 'deps/openssl/openssl/include/crypto/bn_conf.h')
  t.assert.ok(sources.has('deps/openssl/config/bn_conf.h'))
  // --include-dirs come first; with no known projects, only they apply.
  t.assert.equal(collectCBundle(tmp, ['src/node_zlib.cc'], { includeDirs: ['deps/v8/third_party/zlib'] }).resolutions.get('src/node_zlib.cc').get('include "zlib.h"'), 'deps/v8/third_party/zlib/zlib.h')
  const plain = collectCBundle(tmp, ['src/node_zlib.cc'], { knownProjects: [] })
  t.assert.deepStrictEqual(Object.fromEntries(plain.resolutions.get('src/node_zlib.cc') ?? []), {})
  t.assert.deepStrictEqual(plain.projects, [])
}))

test('collectCBundle: a quoted include the tree holds above its includer is missing; one found nowhere is unfound', withTmp((t, tmp) => {
  tree(tmp, {
    'src/net/socket.c': '#include "net/socket.h"\n#include "math.h"\n#include <zlib.h>\n#ifdef HAVE_CONFIG_H\n#include "config.h"\n#endif\n',
    'src/net/socket.h': '',
  })
  const { missing, unfound, hints } = collectCBundle(tmp, ['src/net/socket.c'])
  t.assert.deepStrictEqual(missing, [{ spec: 'include "net/socket.h"', from: 'src/net/socket.c' }])
  t.assert.deepStrictEqual([...hints], ['src'])
  t.assert.deepStrictEqual(unfound, [{ spec: 'include "math.h"', from: 'src/net/socket.c' }])
  // With the directory, nothing is missing.
  t.assert.deepStrictEqual(collectCBundle(tmp, ['src/net/socket.c'], { includeDirs: ['src'] }).missing, [])
}))

test('collectCBundle refuses a symlink out of the root and a .env, and never reads outside it', withTmp((t, tmp) => {
  const root = join(tmp, 'root')
  tree(tmp, {
    'outside/secret.h': 'SECRET',
    'outside/sys/ext.h': '',
    'root/main.c': '#include "leak.h"\n#include ".env"\n#include "../outside/secret.h"\n#include <ext.h>\n',
    'root/.env': 'TOKEN=x',
  })
  symlinkSync(join(tmp, 'outside/secret.h'), join(root, 'leak.h'))
  const { sources, missing, unfound } = collectCBundle(root, ['main.c'], { includeDirs: [join(tmp, 'outside/sys')] })
  t.assert.deepStrictEqual([...sources.keys()], ['main.c'])
  t.assert.deepStrictEqual(missing, [
    { spec: 'include "leak.h"', from: 'main.c', reason: 'leak.h is a symlink escaping the bundle root' },
    { spec: 'include ".env"', from: 'main.c', reason: '.env is a .env file, never carried' },
  ])
  // Out of the root, a header is found (not missing) but not bundled.
  t.assert.deepStrictEqual(unfound, [])
}))

test('collectCBundle carries an #embed as a resource, base64 where it isn\'t UTF-8', withTmp((t, tmp) => {
  tree(tmp, { 'main.c': 'const char a[] = {\n#embed "a.txt"\n};\nconst unsigned char b[] = {\n#embed <b.bin>\n};\n', 'a.txt': 'hi\n', 'data/b.bin': Buffer.from([0xff, 0x00]) })
  const { sources, formats } = collectCBundle(tmp, ['main.c'], { commands: new Map([['main.c', { embed: [{ rel: 'data' }] }]]) })
  t.assert.equal(formats.get('a.txt'), 'resource')
  t.assert.equal(sources.get('a.txt'), 'hi\n')
  t.assert.equal(formats.get('data/b.bin'), 'resource:base64')
  t.assert.equal(sources.get('data/b.bin'), Buffer.from([0xff, 0x00]).toString('base64'))
}))

test('collectCBundle: each unit takes its own compile command\'s search path, and its forced includes', withTmp((t, tmp) => {
  tree(tmp, {
    'a.c': '#include "common.h"\n',
    'b.c': '#include "common.h"\n',
    'common.h': '#include <config.h>\n',
    'config-a/config.h': '',
    'config-b/config.h': '',
    'build/pch.h': '',
  })
  const db = [
    { directory: tmp, file: 'a.c', arguments: ['cc', '-Iconfig-a', '-include', 'build/pch.h', '-c', 'a.c'] },
    { directory: tmp, file: 'b.c', arguments: ['cc', '-Iconfig-b', '-c', 'b.c'] },
  ]
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify(db))
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  const { result, warnings } = captureWarnings(() => collectCBundle(tmp, ['a.c', 'b.c'], { commands }))
  t.assert.deepStrictEqual(warnings, [])
  const { sources, resolutions, conflicts } = result
  t.assert.deepStrictEqual([...sources.keys()].toSorted(), ['a.c', 'b.c', 'build/pch.h', 'common.h', 'config-a/config.h', 'config-b/config.h'])
  t.assert.equal(resolutions.get('a.c').get('-include build/pch.h'), 'build/pch.h')
  // One edge per (file, include): the first unit's; the other unit's file is carried and reported.
  t.assert.equal(resolutions.get('common.h').get('include <config.h>'), 'config-a/config.h')
  t.assert.deepStrictEqual(conflicts, [{ spec: 'include <config.h>', from: 'common.h', targets: ['config-a/config.h', 'config-b/config.h'] }])
}))

test('collectCBundle refuses a source that isn\'t UTF-8', withTmp((t, tmp) => {
  tree(tmp, { 'main.c': '#include "latin1.h"\n', 'latin1.h': Buffer.from('/* caf\xe9 */\n', 'latin1') })
  t.assert.throws(() => collectCBundle(tmp, ['main.c']), { message: 'C/C++ source is not valid UTF-8: latin1.h' })
}))

test('scanIncludes decides an #if on an integer literal in any base', (t) => {
  const src = [
    '#if 0x0', '#include "hex-zero.h"', '#endif',
    '#if 0b1', '#include "bin-one.h"', '#endif',
    "#if 0X1'0uL", '#include "hex-separated.h"', '#endif',
    '#if 00', '#include "octal-zero.h"', '#else', '#include "octal-else.h"', '#endif',
    '#if 0x', '#include "not-a-number.h"', '#endif',
  ].join('\n')
  t.assert.deepStrictEqual(specs(src), ['include "bin-one.h" live', 'include "hex-separated.h" live', 'include "octal-else.h" live', 'include "not-a-number.h" maybe'])
})

test('collectCBundle looks a -include up in the command\'s directory instead of the unit\'s, then along the quote chain', withTmp((t, tmp) => {
  tree(tmp, { 'src/a.c': '', 'src/config.h': '', 'include/config.h': '', 'build/README': '' })
  const commands = new Map([['src/a.c', { I: [{ rel: 'include' }], forced: [{ flag: '-include', path: 'config.h', dir: { rel: 'build' } }] }]])
  // Not beside the unit: GCC searches the working directory in its place.
  t.assert.equal(collectCBundle(tmp, ['src/a.c'], { commands }).resolutions.get('src/a.c').get('-include config.h'), 'include/config.h')
  writeFileSync(join(tmp, 'build/config.h'), '')
  t.assert.equal(collectCBundle(tmp, ['src/a.c'], { commands }).resolutions.get('src/a.c').get('-include config.h'), 'build/config.h')
}))

test('collectCBundle reads a file both #embedded and #included as a source, whichever comes first', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '#embed "meta.h"\n#include "meta.h"\n', 'b.c': '#include "meta.h"\n#embed "meta.h"\n', 'meta.h': '#include "dep.h"\n', 'dep.h': '' })
  for (const unit of ['a.c', 'b.c']) {
    const { sources, formats } = collectCBundle(tmp, [unit])
    t.assert.equal(formats.get('meta.h'), 'c-header', unit)
    t.assert.equal(sources.get('meta.h'), '#include "dep.h"\n', unit)
    t.assert.ok(sources.has('dep.h'), unit)
  }
}))

test('collectCBundle: an #embed found nowhere is missing, where every configuration compiles it', withTmp((t, tmp) => {
  tree(tmp, { 'main.c': 'const char a[] = {\n#embed "gone.bin"\n};\n#if __has_embed(<maybe.bin>)\n#embed <maybe.bin>\n#endif\n' })
  const { missing, unfound } = collectCBundle(tmp, ['main.c'])
  t.assert.deepStrictEqual(missing, [{ spec: 'embed "gone.bin"', from: 'main.c' }])
  t.assert.deepStrictEqual(unfound, [])
}))

test('loadCompileCommands and collectCBundle honor GCC\'s -I-: quote-only directories before it, no lookup beside the includer', withTmp((t, tmp) => {
  tree(tmp, {
    'src/a.c': '#include "x.h"\n#include "q.h"\n#include <q.h>\n',
    'src/x.h': '',
    'quote/q.h': '',
    'post/x.h': '',
  })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    { directory: tmp, file: 'src/a.c', arguments: ['gcc', '-Iquote', '-I-', '-Ipost', '-c', 'src/a.c'] },
    { directory: tmp, file: 'src/b.c', arguments: ['gcc', '-iquote', 'q', '-Ipre', '-Ipre2', '-I-', '-iquote', 'q2', '-Ipost', '-c', 'src/b.c'] },
  ]))
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  t.assert.deepStrictEqual(commands.get('src/a.c').quote, [{ rel: 'quote' }])
  t.assert.deepStrictEqual(commands.get('src/a.c').I, [{ rel: 'post' }])
  // The -I directories before -I- come ahead of every -iquote one, as GCC 13's `gcc -v -E` lists them.
  t.assert.deepStrictEqual(commands.get('src/b.c').quote, [{ rel: 'pre' }, { rel: 'pre2' }, { rel: 'q' }, { rel: 'q2' }])
  t.assert.deepStrictEqual(commands.get('src/b.c').I, [{ rel: 'post' }])
  const { resolutions } = collectCBundle(tmp, ['src/a.c'], { commands })
  // Not src/x.h beside the unit, and <q.h> isn't searched for in the quote-only directory.
  t.assert.deepStrictEqual(Object.fromEntries(resolutions.get('src/a.c')), { 'include "x.h"': 'post/x.h', 'include "q.h"': 'quote/q.h' })
}))

test('collectCBundle searches a directory given twice once, where GCC keeps it', withTmp((t, tmp) => {
  tree(tmp, { 'src/a.c': '#include <x.h>\n#include "y.h"\n', 'a/x.h': '', 'b/x.h': '', 'a/y.h': '', 'b/y.h': '' })
  const resolve = (args) => {
    writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'src/a.c', arguments: ['gcc', ...args, '-c', 'src/a.c'] }]))
    return Object.fromEntries(collectCBundle(tmp, ['src/a.c'], { commands: loadCompileCommands(tmp, 'compile_commands.json') }).resolutions.get('src/a.c'))
  }
  // An -I (or -iquote) directory that is also a system one is searched at the system one's place:
  // GCC 13's `gcc -v -E -I a -isystem a -I b` lists b, then a.
  t.assert.deepStrictEqual(resolve(['-Ia', '-isystem', 'a', '-Ib']), { 'include <x.h>': 'b/x.h', 'include "y.h"': 'b/y.h' })
  t.assert.deepStrictEqual(resolve(['-iquote', 'a', '-isystem', 'a', '-Ib']), { 'include <x.h>': 'b/x.h', 'include "y.h"': 'b/y.h' })
  // Otherwise the first place holds.
  t.assert.deepStrictEqual(resolve(['-Ia', '-Ib', '-Ia']), { 'include <x.h>': 'a/x.h', 'include "y.h"': 'a/y.h' })
}))

test('collectCBundle: an #embed found outside the bundle root is missing', withTmp((t, tmp) => {
  tree(tmp, { 'outside/logo.bin': 'x', 'root/main.c': '#embed "../outside/logo.bin"\n' })
  const { missing } = collectCBundle(join(tmp, 'root'), ['main.c'])
  t.assert.deepStrictEqual(missing, [{ spec: 'embed "../outside/logo.bin"', from: 'main.c', reason: 'outside the bundle root' }])
}))

test('collectCBundle tells one directory spelled two ways by its real path', withTmp((t, tmp) => {
  tree(tmp, { 'src/a.c': '#include <x.h>\n', 'real/x.h': '', 'b/x.h': '' })
  symlinkSync('real', join(tmp, 'alias'))
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'src/a.c', arguments: ['gcc', '-Ialias', '-isystem', 'real', '-Ib', '-c', 'src/a.c'] }]))
  // GCC 13 searches b, then real: the -I alias is the -isystem directory, searched only there.
  const { resolutions } = collectCBundle(tmp, ['src/a.c'], { commands: loadCompileCommands(tmp, 'compile_commands.json') })
  t.assert.equal(resolutions.get('src/a.c').get('include <x.h>'), 'b/x.h')
}))

test('collectCBundle searches an include directory outside the root that is a symlink into it as the one inside', withTmp((t, tmp) => {
  tree(tmp, { 'root/src/a.c': '#include <x.h>\n', 'root/src/b.c': '#include <y.h>\n', 'root/include/x.h': '', 'root/include/y.h': '' })
  symlinkSync(join(tmp, 'root/include'), join(tmp, 'alias'))
  const root = join(tmp, 'root')
  writeFileSync(join(root, 'compile_commands.json'), JSON.stringify([{ directory: root, file: 'src/b.c', arguments: ['gcc', `-I${join(tmp, 'alias')}`, '-c', 'src/b.c'] }]))
  const { sources, resolutions } = collectCBundle(root, ['src/a.c', 'src/b.c'], { includeDirs: [join(tmp, 'alias')], commands: loadCompileCommands(root, 'compile_commands.json') })
  t.assert.equal(resolutions.get('src/a.c').get('include <x.h>'), 'include/x.h')
  t.assert.equal(resolutions.get('src/b.c').get('include <y.h>'), 'include/y.h')
  t.assert.ok(sources.has('include/x.h') && sources.has('include/y.h'))
}))

test('loadCompileCommands puts =dir and $SYSROOT/dir in the sysroot, -isysroot\'s over --sysroot\'s', withTmp((t, tmp) => {
  tree(tmp, { 'src/a.c': '#include <x.h>\n', 'sr/usr/include/x.h': '', 'hsr/inc/y.h': '' })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    { directory: tmp, file: 'src/a.c', arguments: ['gcc', '-I=/usr/include', '--sysroot', 'sr', '-c', 'src/a.c'] },
    { directory: tmp, file: 'src/b.c', arguments: ['gcc', '--sysroot=sr', '-isysroot', 'hsr', '-isystem', '$SYSROOT/inc', '-c', 'src/b.c'] },
    { directory: tmp, file: 'src/c.c', arguments: ['gcc', '-I=/usr/include', '-c', 'src/c.c'] },
  ]))
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  t.assert.deepStrictEqual(commands.get('src/a.c').I, [{ rel: 'sr/usr/include' }])
  t.assert.deepStrictEqual(commands.get('src/b.c').system, [{ rel: 'hsr/inc' }])
  t.assert.deepStrictEqual(commands.get('src/c.c').I, [])
  t.assert.equal(collectCBundle(tmp, ['src/a.c'], { commands }).resolutions.get('src/a.c').get('include <x.h>'), 'sr/usr/include/x.h')
}))

test('loadCompileCommands reads Clang\'s -iwithsysroot with the -isystem ones, an absolute one in the sysroot', withTmp((t, tmp) => {
  tree(tmp, { 'src/a.c': '#include <x.h>\n#include <y.h>\n', 'sdk/include/x.h': '', 's/x.h': '', 'rel/y.h': '' })
  const unit = (file, args) => ({ directory: tmp, file, arguments: ['clang', ...args, '-c', file] })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    unit('src/a.c', ['-isysroot', 'sdk', '-iwithsysroot', '/include', '-isystem', 's', '-iwithsysroot', 'rel']),
    unit('src/b.c', ['-isysroot', 'sdk', '-isystem', 's', '-iwithsysroot', '/include']),
    unit('src/c.c', ['--sysroot=sdk', '-iframeworkwithsysroot', '/include']),
  ]))
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  // clang 18's -v for these: sdk/include, s, rel; then s, sdk/include.
  t.assert.deepStrictEqual(commands.get('src/a.c').system, [{ rel: 'sdk/include' }, { rel: 's' }, { rel: 'rel' }])
  t.assert.deepStrictEqual(commands.get('src/b.c').system, [{ rel: 's' }, { rel: 'sdk/include' }])
  t.assert.deepStrictEqual(commands.get('src/c.c').system, [{ rel: 'sdk/include', framework: true }])
  t.assert.equal(collectCBundle(tmp, ['src/a.c'], { commands }).resolutions.get('src/a.c').get('include <x.h>'), 'sdk/include/x.h')
}))

test('loadCompileCommands reads GCC\'s long spellings and prefix options, the -I ones first, as its driver orders them', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '' })
  const args = ['gcc', '-iprefix', 'p/', '-iwithprefixbefore', 'wb', '-I', 'j', '--include-directory', 'i', '--include-barrier', '--include-directory=k', '--include-directory-after', 'af', '--include-with-prefix', 'w', '--include-prefix', 'q/', '--include-with-prefix-before=v', '--include', 'f.h', '-c', 'a.c']
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'a.c', arguments: args }]))
  const flags = loadCompileCommands(tmp, 'compile_commands.json').get('a.c')
  // GCC 13's `gcc -v -E` for these: quote j, i; then k, p/wb, q/v; system p/w; after af.
  const rels = (dirs) => dirs.map((d) => d.rel)
  t.assert.deepStrictEqual(rels(flags.quote), ['j', 'i'])
  t.assert.deepStrictEqual(rels(flags.I), ['k', 'p/wb', 'q/v'])
  t.assert.deepStrictEqual(rels(flags.system), ['p/w'])
  t.assert.deepStrictEqual(rels(flags.after), ['af'])
  t.assert.deepStrictEqual(flags.forced.map((f) => f.path), ['f.h'])
  t.assert.equal(flags.split, true)
}))

test('scanIncludes ends a line at a lone carriage return, as GCC does', (t) => {
  t.assert.deepStrictEqual(specs('#include "a.h"\r#include "b.h"\r#inc\\\rlude "c.h"\r'), ['include "a.h" live', 'include "b.h" live', 'include "c.h" live'])
})

test('scanIncludes reads a file holding trigraphs with them off and on, what one reading finds some build reads', (t) => {
  // `??=` is a `#` only with trigraphs on: GCC 13 opens a.h and b.h with -trigraphs, c.h without.
  t.assert.deepStrictEqual(specs('??=include "a.h"\n  ??=  include "b.h"\n??=if 0\n#include "c.h"\n??=endif\n'), ['include "c.h" maybe', 'include "a.h" maybe', 'include "b.h" maybe'])
  // `??/` is a backslash only with trigraphs on: GCC 13 opens next.h without -trigraphs, required.h
  // with them.
  t.assert.deepStrictEqual(specs('??=include "requi??/\nred.h"\n// comment??/\n#include "next.h"\n'), ['include "next.h" maybe', 'include "required.h" maybe'])
  t.assert.deepStrictEqual(specs('#include "a.h"\nconst char *s = "??/n";\n'), ['include "a.h" live'])
  // The other seven too, in a header name: with -trigraphs, GCC 13 opens foo~bar.h.
  t.assert.deepStrictEqual(specs('#include "foo??-bar.h"\n'), ['include "foo??-bar.h" maybe', 'include "foo~bar.h" maybe'])
})

test('scanIncludes evaluates a condition\'s literals and operators, a macro unknown but where the rest decides', (t) => {
  const src = [
    ['1 || FEATURE', 'a'], ['0 && defined(X)', 'b'], ['1 + 0', 'c'], ['!0', 'd'], ['X ? 1 : 1', 'e'],
    ['__has_include(<x.h>) || 2 > 1', 'f'], ['(0x10 >> 4) == 1 && -1 < 0', 'h'], ['defined X', 'i'], ['-1U < 0', 'j'], ['08', 'k'],
    ['0xffffffffffffffffULL + 1 == 0', 'l'], ['1 << 63', 'm'], ['-9223372036854775807 - 1 < 0', 'n'], ['1 << 4000000000', 'o'],
  ].map(([cond, name]) => `#if ${cond}\n#include "${name}.h"\n#endif\n`).join('')
  // GCC 13 opens a, c, d, e, f, h and n, never b; i hangs on X; j, l and m wrap at 64 bits (GCC's
  // -1U < 0 is false, its l and m true), 08 is no literal, and o shifts past the width.
  t.assert.deepStrictEqual(specs(src), [
    'include "a.h" live', 'include "c.h" live', 'include "d.h" live', 'include "e.h" live', 'include "f.h" live', 'include "h.h" live',
    'include "i.h" maybe', 'include "j.h" maybe', 'include "k.h" maybe', 'include "l.h" maybe', 'include "m.h" maybe', 'include "n.h" live',
    'include "o.h" maybe',
  ])
})

test('scanIncludes splices a line at a backslash spaces apart from its end, as GCC and Clang do', (t) => {
  // GCC 13 opens required.h, warning, and the comment takes in the #include after it.
  t.assert.deepStrictEqual(specs('#include "requi\\   \nred.h"\n// comment\\ \t\n#include "next.h"\n'), ['include "required.h" live'])
})

test('scanIncludes reads a first-line directive after a byte order mark, as GCC does', (t) => {
  t.assert.deepStrictEqual(specs('﻿#include "a.h"\n'), ['include "a.h" live'])
  t.assert.deepStrictEqual(specs('﻿#ifndef A_H\n#define A_H\n#include "b.h"\n#endif\n'), ['include "b.h" live'])
})

test('loadCompileCommands reads clang-cl\'s include options, /imsvc after the other system directories', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '' })
  const args = ['clang-cl', '/Iinc', '/imsvc', 'sys', '-imsvcsys2', '/external:Iext', '/FIpch.h', '-Foa.obj', '/c', 'a.c']
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'a.c', arguments: args }]))
  const flags = loadCompileCommands(tmp, 'compile_commands.json').get('a.c')
  // clang-cl -v lists inc, ext, its own headers, then sys, sys2.
  const rels = (dirs) => dirs.map((d) => d.rel)
  t.assert.deepStrictEqual(rels(flags.I), ['inc'])
  t.assert.deepStrictEqual(rels(flags.system), ['ext'])
  t.assert.deepStrictEqual(rels(flags.after), ['sys', 'sys2'])
  t.assert.deepStrictEqual(flags.forced.map((f) => f.path), ['pch.h'])
}))

test('collectCBundle carries a cl #import\'s type library as bytes, where GCC\'s #import is an #include', withTmp((t, tmp) => {
  const tlb = Buffer.from([0x4d, 0x53, 0x46, 0x54, 0xff, 0x00])
  tree(tmp, { 'a.cpp': '#import "lib/types.tlb"\n', 'b.c': '#import "lib/h.h"\n', 'lib/types.tlb': tlb, 'lib/h.h': '#include "dep.h"\n', 'lib/dep.h': '' })
  const bundle = (unit, argv) => {
    writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: unit, arguments: [...argv, unit] }]))
    return collectCBundle(tmp, [unit], { commands: loadCompileCommands(tmp, 'compile_commands.json') })
  }
  const cl = bundle('a.cpp', ['cl', '/c'])
  t.assert.equal(cl.formats.get('lib/types.tlb'), 'resource:base64')
  t.assert.equal(cl.sources.get('lib/types.tlb'), tlb.toString('base64'))
  const gcc = bundle('b.c', ['gcc', '-c'])
  t.assert.equal(gcc.formats.get('lib/h.h'), 'c-header')
  t.assert.ok(gcc.sources.has('lib/dep.h'))
}))

test('collectCBundle reads a backslash in a header name as a separator under clang-cl, as GCC doesn\'t', withTmp((t, tmp) => {
  tree(tmp, {
    'src/main.c': '#include "sub\\x.h"\n#include <deep\\y.h>\n#include <z.h>\n',
    'src/sub/x.h': '#include "w.h"\n',
    'src/sub/w.h': '',
    'inc/deep/y.h': '',
    'src/fi/p.h': '',
    '-/z.h': '',
    'later/z.h': '',
  })
  const bundle = (argv) => {
    writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'src/main.c', arguments: [...argv, 'src/main.c'] }]))
    return collectCBundle(tmp, ['src/main.c'], { commands: loadCompileCommands(tmp, 'compile_commands.json') })
  }
  // clang-cl 18 /E opens src/sub/x.h (and the w.h beside it), inc/deep/y.h, src/fi/p.h, and -/z.h:
  // its -I- is the directory `-`, ahead of later.
  const cl = bundle(['clang-cl', '/Iinc', '-I-', '/Ilater', '/FIsrc\\fi\\p.h', '/c'])
  t.assert.deepStrictEqual(Object.fromEntries(cl.resolutions.get('src/main.c')), {
    '/FI src/fi/p.h': 'src/fi/p.h',
    'include "sub\\x.h"': 'src/sub/x.h',
    'include <deep\\y.h>': 'inc/deep/y.h',
    'include <z.h>': '-/z.h',
  })
  t.assert.ok(cl.sources.has('src/sub/w.h'))
  // GCC looks for a file named sub\x.h, and finds none.
  t.assert.equal(bundle(['gcc', '-Iinc', '-c']).resolutions.get('src/main.c')?.get('include "sub\\x.h"'), undefined)
}))

test('collectCBundle takes no -I- for a barrier under clang-cl, which reads it as /I -', withTmp((t, tmp) => {
  tree(tmp, { 'src/main.c': '#include "x.h"\n', 'src/x.h': '', 'a/x.h': '' })
  const resolve = (argv) => {
    writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'src/main.c', arguments: [...argv, 'src/main.c'] }]))
    return collectCBundle(tmp, ['src/main.c'], { commands: loadCompileCommands(tmp, 'compile_commands.json') }).resolutions.get('src/main.c').get('include "x.h"')
  }
  // clang-cl 18 /E takes src/x.h, beside the unit; GCC 13, past its barrier, a/x.h.
  t.assert.equal(resolve(['clang-cl', '/Ia', '-I-', '/Ib', '/c']), 'src/x.h')
  t.assert.equal(resolve(['gcc', '-Ia', '-I-', '-Ib', '-c']), 'a/x.h')
}))

test('loadCompileCommands reads response files, nested ones too, split as each driver splits them', withTmp((t, tmp) => {
  tree(tmp, {
    'flags.rsp': '-I inc\n@b/nested.rsp\n',
    'b/nested.rsp': "-isystem 'sys dir'\n",
    'cl.rsp': '/I"inc dir" /FIsub\\pch.h\n',
    'u16.rsp': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('/Iu16\r\n', 'utf16le')]),
    'mode.rsp': '--driver-mode=cl /Imode\n',
    'esc.rsp': String.raw`-I"inc\ dir" -I'a\b' -Ic\"d -I"x\"y" -I'q\'r' -Ip\ q` + '\n',
  })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    { directory: tmp, file: 'a.c', arguments: ['gcc', '@flags.rsp', '-c', 'a.c'] },
    { directory: tmp, file: 'b.c', arguments: ['clang-cl', '@cl.rsp', '@u16.rsp', '/c', 'b.c'] },
    { directory: tmp, file: 'c.c', arguments: ['gcc', '@missing.rsp', '-Iinc', '-c', 'c.c'] },
    { directory: tmp, file: 'd.c', arguments: ['clang', '@mode.rsp', '/c', 'd.c'] },
    { directory: tmp, file: 'e.c', arguments: ['gcc', '@esc.rsp', '-c', 'e.c'] },
  ]))
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  // gcc 13 -v lists inc, then sys dir (the nested file's path from the working directory); clang-cl
  // 18 -v lists inc dir, u16, and keeps the backslash in sub\pch.h (no escape to it), a separator.
  t.assert.deepStrictEqual(commands.get('a.c').I, [{ rel: 'inc' }])
  t.assert.deepStrictEqual(commands.get('a.c').system, [{ rel: 'sys dir' }])
  t.assert.deepStrictEqual(commands.get('b.c').I, [{ rel: 'inc dir' }, { rel: 'u16' }])
  t.assert.deepStrictEqual(commands.get('b.c').forced.map((f) => f.path), ['sub/pch.h'])
  t.assert.deepStrictEqual(commands.get('c.c').I, [{ rel: 'inc' }])
  // A --driver-mode=cl in one makes the command clang-cl's, as clang 18 takes it.
  t.assert.deepStrictEqual(commands.get('d.c').I, [{ rel: 'mode' }])
  t.assert.equal(commands.get('d.c').msvc, true)
  // A backslash escapes any character in a GNU response file, in quotes too, as gcc 13 and clang 18
  // -v both list these.
  t.assert.deepStrictEqual(commands.get('e.c').I, ['inc dir', 'ab', 'c"d', 'x"y', "q'r", 'p q'].map((rel) => ({ rel })))
}))

test('loadCompileCommands reads the options -Xclang, -Xpreprocessor and -Wp pass on, after the driver\'s own', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '' })
  const args = ['clang', '-Xclang', '-I', '-Xclang', 'x', '-Iy', '-Wp,-I,w', '-Xclang', '-Iz', '-Xpreprocessor', '-isystem', '-Xpreprocessor', 's', '-Wp,-isystem,t', '-Xclang=-I', '-Xclang=v', '-c', 'a.c']
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'a.c', arguments: args }]))
  // clang 18's -v lists y, then w (-Wp), x, z, v (-Xclang, -Xclang=, last); s, t. gcc 13's puts
  // -Xpreprocessor's and -Wp's after its own the same way.
  const flags = loadCompileCommands(tmp, 'compile_commands.json').get('a.c')
  t.assert.deepStrictEqual(flags.I, [{ rel: 'y' }, { rel: 'w' }, { rel: 'x' }, { rel: 'z' }, { rel: 'v' }])
  t.assert.deepStrictEqual(flags.system, [{ rel: 's' }, { rel: 't' }])
}))

test('loadCompileCommands leaves out what -Xlinker, -Xassembler and the like hand other tools', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '#include <stdio.h>\n', 'vendor/stdio.h': '', 'sr/inc/.keep': '' })
  const other = ['-Xlinker', '-Ivendor', '-Xassembler', '-Iv2', '-Xanalyzer', '-Iv3', '-Xopenmp-target=x86_64-pc-linux-gnu', '-Iv4', '-Xoffload-linker-x86_64', '-Iv5', '-Xlinker', '--sysroot=sr']
  const args = ['clang', ...other, '-Xarch_host', '-Ih', '-I=/inc', '-c', 'a.c']
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'a.c', arguments: args }]))
  // clang 18 (and gcc 13, for -Xlinker and -Xassembler) adds none of them, nor the linker's
  // --sysroot, so =/inc is no directory; -Xarch_host hands -Ih to the host compile. <stdio.h> is the
  // system's, not vendor's.
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  t.assert.deepStrictEqual(commands.get('a.c').I, [{ rel: 'h' }])
  const { sources, resolutions } = collectCBundle(tmp, ['a.c'], { commands })
  t.assert.notEqual(resolutions.get('a.c')?.get('include <stdio.h>'), 'vendor/stdio.h')
  t.assert.ok(!sources.has('vendor/stdio.h'))
}))

test('loadCompileCommands splits a cl or clang-cl command string by Windows rules, others as a shell does', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '', 'b.c': '', 'c.c': '' })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    { directory: tmp, file: 'a.c', command: 'C:\\LLVM\\bin\\clang-cl.exe /Iinc /FIsub\\pch.h /c a.c' },
    { directory: tmp, file: 'b.c', command: 'gcc -DX=\\"1\\" -I"a b" -c b.c' },
    { directory: tmp, file: 'c.c', command: '"C:\\Program Files\\LLVM\\bin\\clang-cl.exe" /I"inc dir" /c c.c' },
  ]))
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  t.assert.deepStrictEqual(commands.get('a.c').I, [{ rel: 'inc' }])
  t.assert.equal(commands.get('a.c').msvc, true)
  t.assert.deepStrictEqual(commands.get('a.c').forced.map((f) => f.path), ['sub/pch.h'])
  t.assert.deepStrictEqual(commands.get('c.c').I, [{ rel: 'inc dir' }])
  t.assert.deepStrictEqual(commands.get('b.c').I, [{ rel: 'a b' }])
}))

test('loadCompileCommands takes clang-cl under a version or target name, or --driver-mode=cl, for clang-cl', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '', 'b.c': '', 'c.c': '', 'd.c': '', 'e.c': '' })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    { directory: tmp, file: 'a.c', arguments: ['/usr/bin/clang-cl-20', '/Iinc', '/c', 'a.c'] },
    { directory: tmp, file: 'b.c', arguments: ['x86_64-pc-windows-msvc-clang-cl.exe', '/Iinc', '/c', 'b.c'] },
    { directory: tmp, file: 'c.c', arguments: ['clang-20', '-Iinc', '-c', 'c.c'] },
    { directory: tmp, file: 'd.c', arguments: ['clang', '--driver-mode=cl', '/Iinc', '/c', 'd.c'] },
    { directory: tmp, file: 'e.c', command: 'C:\\LLVM\\bin\\clang.exe --driver-mode=cl /Iinc /c e.c' },
  ]))
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  // --driver-mode=cl makes clang clang-cl, as it says.
  for (const unit of ['a.c', 'b.c', 'd.c', 'e.c']) {
    t.assert.deepStrictEqual(commands.get(unit).I, [{ rel: 'inc' }], unit)
    t.assert.equal(commands.get(unit).msvc, true, unit)
  }
  t.assert.equal(commands.get('c.c').msvc, undefined)
}))

test('collectCBundle reads a unit\'s forced includes though an #include reached it first', withTmp((t, tmp) => {
  tree(tmp, {
    'src/main.c': '#include "../lib/util.c"\n#include "../lib/util.h"\n',
    'lib/util.h': '',
    'lib/util.c': '',
    'src/pch.h': '',
    'lib/pch.h': '',
  })
  const unit = (file) => ({ directory: tmp, file, arguments: ['clang-cl', '/FIpch.h', '/c', file] })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([unit('src/main.c'), unit('lib/util.c')]))
  // util.c, compiled on its own, takes lib/pch.h beside it, as clang-cl looks a /FI up.
  const { sources, resolutions } = collectCBundle(tmp, ['src/main.c'], { commands: loadCompileCommands(tmp, 'compile_commands.json') })
  t.assert.equal(resolutions.get('lib/util.c')?.get('/FI pch.h'), 'lib/pch.h')
  t.assert.ok(sources.has('lib/pch.h'))
}))

test('loadCompileCommands reads what clang-cl\'s /clang: passes the clang driver, after its own options', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '' })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'a.c', arguments: ['clang-cl', '/clang:-Ix', '/Iy', '/clang:-I', '/clang:z', '-clang:-isystem', '-clang:s', '/Iw', '/c', 'a.c'] }]))
  // clang-cl 18 -v lists y, w, then x, z; s.
  const flags = loadCompileCommands(tmp, 'compile_commands.json').get('a.c')
  t.assert.deepStrictEqual(flags.I, [{ rel: 'y' }, { rel: 'w' }, { rel: 'x' }, { rel: 'z' }])
  t.assert.deepStrictEqual(flags.system, [{ rel: 's' }])
}))

test('loadCompileCommands reads -cxx-isystem and -stdlib++-isystem for a C++ unit, after the other system directories', withTmp((t, tmp) => {
  tree(tmp, { 'a.cpp': '', 'b.c': '', 'c.c': '', 'd.cpp': '', 'e.c': '', 'f.c': '', 'g.cpp': '', 'h.c': '', 'i.c': '' })
  const unit = (file, args) => ({ directory: tmp, file, arguments: [...args, '-c', file] })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    unit('a.cpp', ['clang', '-stdlib++-isystem', 'lib', '-cxx-isystem', 'a', '-isystem', 's', '-iframework', 'f', '-Iy']),
    unit('b.c', ['clang', '-stdlib++-isystem', 'lib', '-cxx-isystem', 'a']),
    unit('c.c', ['clang++', '-stdlib++-isystemlib']),
    unit('d.cpp', ['clang', '-x', 'c', '-stdlib++-isystem', 'lib']),
    unit('e.c', ['clang-cl', '/TP', '/clang:-stdlib++-isystem', '/clang:lib']),
    unit('f.c', ['clang-cl', '/TP', '/TC', '/clang:-stdlib++-isystem', '/clang:lib']),
    unit('g.cpp', ['clang', '-x', 'c', '-x', 'none', '-cxx-isystem', 'a']),
    unit('h.c', ['clang', '--driver-mode=g++', '-cxx-isystem', 'a']),
    unit('i.c', ['clang++', '--driver-mode=gcc', '-cxx-isystem', 'a']),
  ]))
  // clang 18's -v for a.cpp lists y, then s, f (a framework directory), a, lib; for C, neither a nor
  // lib. clang-cl's /TP makes e.c C++, /TC after it f.c C again.
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  t.assert.deepStrictEqual(commands.get('a.cpp').system, [{ rel: 's' }, { rel: 'f', framework: true }, { rel: 'a' }, { rel: 'lib' }])
  t.assert.deepStrictEqual(commands.get('b.c').system, [])
  t.assert.deepStrictEqual(commands.get('c.c').system, [{ rel: 'lib' }])
  t.assert.deepStrictEqual(commands.get('d.cpp').system, [])
  t.assert.deepStrictEqual(commands.get('e.c').system, [{ rel: 'lib' }])
  t.assert.deepStrictEqual(commands.get('f.c').system, [])
  // -x none gives the extension back the say; --driver-mode= outdoes the driver's name.
  t.assert.deepStrictEqual(commands.get('g.cpp').system, [{ rel: 'a' }])
  t.assert.deepStrictEqual(commands.get('h.c').system, [{ rel: 'a' }])
  t.assert.deepStrictEqual(commands.get('i.c').system, [])
}))

test('loadCompileCommands reads the -internal-isystem directories -Wp, and -Xclang pass, where clang searches them', withTmp((t, tmp) => {
  tree(tmp, { 'a.cpp': '', 'b.c': '', 'c.c': '', 'd.cpp': '' })
  const unit = (file, args) => ({ directory: tmp, file, arguments: [...args, '-c', file] })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    unit('a.cpp', ['clang++', '-Xclang', '-internal-externc-isystem', '-Xclang', 'ext', '-Wp,-internal-isystem,inc', '-isystem', 'sys', '-idirafter', 'after', '-cxx-isystem', 'cxxs', '-stdlib++-isystem', 'stdl']),
    unit('b.c', ['clang', '-Xclang', '-internal-isystem', '-Xclang', 'x', '-Xpreprocessor', '-internal-isystem', '-Xpreprocessor', 'p', '-iframework', 'fw', '-isystem', 'sys']),
    unit('c.c', ['clang', '-Xclang', '-internal-iframework', '-Xclang', 'ifw', '-Xclang', '-internal-isystem', '-Xclang', 'x', '-Wp,-c-isystem,cs', '-Xclang', '-c-isystem', '-Xclang', 'cs2', '-isystem', 'sys', '-iframework', 'fw']),
    unit('d.cpp', ['clang++', '-Xclang', '-c-isystem', '-Xclang', 'cs', '-cxx-isystem', 'cx']),
  ]))
  // clang 18's -v for a.cpp lists sys, cxxs, inc, stdl, its own system directories, ext; after. For
  // b.c, sys, fw, p, its own, x.
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  t.assert.deepStrictEqual(commands.get('a.cpp').system, [{ rel: 'sys' }, { rel: 'cxxs' }, { rel: 'inc' }, { rel: 'stdl' }, { rel: 'ext' }])
  t.assert.deepStrictEqual(commands.get('a.cpp').after, [{ rel: 'after' }])
  t.assert.deepStrictEqual(commands.get('b.c').system, [{ rel: 'sys' }, { rel: 'fw', framework: true }, { rel: 'p' }, { rel: 'x' }])
  // -c-isystem is a C unit's, with -cxx-isystem's place (clang 18 lists sys, fw, cs, cs2, its own, x
  // for c.c, and no cs for d.cpp); -internal-iframework comes after every -internal-isystem, as
  // Clang's CompilerInvocation adds them.
  t.assert.deepStrictEqual(commands.get('c.c').system, [{ rel: 'sys' }, { rel: 'fw', framework: true }, { rel: 'cs' }, { rel: 'cs2' }, { rel: 'x' }, { rel: 'ifw', framework: true }])
  t.assert.deepStrictEqual(commands.get('d.cpp').system, [{ rel: 'cx' }])
}))

test('collectCBundle searches the framework directories clang-cl\'s /clang: passes, not cl\'s own -F', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '#include <Foo/X.h>\n', 'b.c': '#include <Foo/X.h>\n', 'fw/Foo.framework/Headers/X.h': '' })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    { directory: tmp, file: 'a.c', arguments: ['clang-cl', '/clang:-Ffw', '/c', 'a.c'] },
    { directory: tmp, file: 'b.c', arguments: ['clang-cl', '-Ffw', '/c', 'b.c'] },
  ]))
  // clang-cl 18 finds fw/Foo.framework/Headers/X.h for a.c; b.c's -Ffw is cl's (unused), not a framework
  // directory.
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  t.assert.deepStrictEqual(commands.get('a.c').I, [{ rel: 'fw', framework: true }])
  t.assert.deepStrictEqual(commands.get('b.c').I, [])
  const { resolutions } = collectCBundle(tmp, ['a.c', 'b.c'], { commands })
  t.assert.equal(resolutions.get('a.c').get('include <Foo/X.h>'), 'fw/Foo.framework/Headers/X.h')
  t.assert.notEqual(resolutions.get('b.c')?.get('include <Foo/X.h>'), 'fw/Foo.framework/Headers/X.h')
}))

test('collectCBundle takes a Clang command\'s relative paths from its -working-directory', withTmp((t, tmp) => {
  tree(tmp, { 'root/src/a.c': '#include <x.h>\n', 'root/include/x.h': '', 'include/x.h': '', 'root/build/f.h': '' })
  const args = ['clang', `-working-directory=${join(tmp, 'root/build')}`, '-I', '../include', '-include', 'f.h', '-c', 'src/a.c']
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: join(tmp, 'root'), file: 'src/a.c', arguments: args }]))
  // clang 18 -E opens root/build/f.h and root/include/x.h, both taken from root/build.
  const { resolutions } = collectCBundle(tmp, ['root/src/a.c'], { commands: loadCompileCommands(tmp, 'compile_commands.json') })
  t.assert.deepStrictEqual(Object.fromEntries(resolutions.get('root/src/a.c')), { '-include f.h': 'root/build/f.h', 'include <x.h>': 'root/include/x.h' })
}))

test('loadCompileCommands reads the compiler behind a launcher, clang-cl\'s options too', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '', 'b.c': '' })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    { directory: tmp, file: 'a.c', arguments: ['/usr/bin/sccache', 'clang-cl', '/Iinc', '/FIpch.h', '/c', 'a.c'] },
    { directory: tmp, file: 'b.c', command: 'ccache cc -Iinc -c b.c' },
  ]))
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  t.assert.deepStrictEqual(commands.get('a.c').I, [{ rel: 'inc' }])
  t.assert.deepStrictEqual(commands.get('a.c').forced.map((f) => f.path), ['pch.h'])
  t.assert.equal(commands.get('a.c').msvc, true)
  t.assert.deepStrictEqual(commands.get('b.c').I, [{ rel: 'inc' }])
  t.assert.equal(commands.get('b.c').msvc, undefined)
}))

test('loadCompileCommands reads the compiler behind env and a shell\'s NAME=VALUE, in env -C\'s directory', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '', 'b.c': '', 'c.c': '', 'd.c': '', 'e.cpp': '', 'f.c': '', 'g.c': '' })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    { directory: tmp, file: 'a.c', command: 'env SDK=x clang-cl /Iinc /c a.c' },
    { directory: tmp, file: 'b.c', command: 'SDK=x INCLUDE=y clang-cl /Iinc /c b.c' },
    { directory: tmp, file: 'c.c', arguments: ['/usr/bin/env', '-i', '-u', 'CL', '--unset=LIB', '--', '-', 'A=1', 'ccache', 'clang-cl', '/Iinc', '/c', 'c.c'] },
    { directory: tmp, file: 'd.c', arguments: ['env', '-C', 'build', 'clang-cl', '/Iinc', '/FIpch.h', '/c', '../d.c'] },
    { directory: tmp, file: 'e.cpp', arguments: ['env', 'CCACHE_DIR=/c', 'ccache', 'env', '--chdir=build', 'g++', '-cxx-isystem', 'cx', '-Iinc', '-c', '../e.cpp'] },
    { directory: tmp, file: 'f.c', arguments: ['env', '-S', 'clang-cl /Iinc', '/c', 'f.c'] },
    { directory: tmp, file: 'g.c', arguments: ['env', '-C', 'one', 'env', '-C', 'x', '-C', 'two', 'clang', '-Iinc', '-c', '../../g.c'] },
  ]))
  // Each runs the clang-cl (g++) after env's options and settings, as GNU env does: d.c's and e.cpp's
  // in build, g.c's in one/two (each env's last -C, in turn).
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  for (const unit of ['a.c', 'b.c', 'c.c']) {
    t.assert.deepStrictEqual(commands.get(unit).I, [{ rel: 'inc' }], unit)
    t.assert.equal(commands.get(unit).msvc, true, unit)
  }
  t.assert.deepStrictEqual(commands.get('d.c').I, [{ rel: 'build/inc' }])
  t.assert.equal(commands.get('d.c').msvc, true)
  t.assert.deepStrictEqual(commands.get('d.c').forced, [{ flag: '/FI', path: 'pch.h', dir: { rel: 'build' } }])
  t.assert.deepStrictEqual(commands.get('e.cpp').I, [{ rel: 'build/inc' }])
  t.assert.deepStrictEqual(commands.get('e.cpp').system, [{ rel: 'build/cx' }])
  t.assert.deepStrictEqual(commands.get('g.c').I, [{ rel: 'one/two/inc' }])
  // An env option this doesn't know leaves env the command, which is no cl.
  t.assert.equal(commands.get('f.c').msvc, undefined)
}))

test('loadCompileCommands takes the -x before a unit\'s own argument for it', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '', 'b.c': '', 'src/d.c': '', 'e.c': '' })
  const lib = ['-stdlib++-isystem', 'lib', '-c']
  const both = ['clang', '-x', 'c++', 'a.c', '-x', 'c', 'b.c', ...lib]
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    { directory: tmp, file: 'a.c', arguments: both },
    { directory: tmp, file: 'b.c', arguments: both },
    { directory: tmp, file: 'src/d.c', arguments: ['clang', '-xc++', 'src/../src/d.c', '-x', 'c', 'e.c', ...lib] },
    { directory: tmp, file: 'e.c', arguments: ['clang', 'e.c', '-x', 'c++', ...lib] },
  ]))
  // clang 18 and gcc 13 compile a.c and d.c as C++, b.c as C, and e.c as C (a -x after the last
  // input has no effect).
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  for (const [file, cxx] of [['a.c', true], ['b.c', false], ['src/d.c', true], ['e.c', false]]) {
    t.assert.deepStrictEqual(commands.get(file).system, cxx ? [{ rel: 'lib' }] : [], file)
  }
}))

test('loadCompileCommands takes clang-cl\'s /Tp and /Tc for the unit they name, /TP and /TC for every one', withTmp((t, tmp) => {
  tree(tmp, { 'a.c': '', 'b.c': '', 'd.c': '', 'e.c': '', 'src/f.c': '' })
  const lib = ['/clang:-stdlib++-isystem', '/clang:lib', '/c']
  const unit = (file, args) => ({ directory: tmp, file, arguments: ['clang-cl', ...args, ...lib] })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([
    unit('a.c', ['/Tpa.c', '/Tc', 'b.c']),
    unit('b.c', ['/Tpa.c', '/Tc', 'b.c']),
    unit('d.c', ['/Tpa.c', 'd.c']),
    unit('e.c', ['/TP', '/Tcd.c', 'e.c']),
    unit('src/f.c', ['/Tpsrc\\f.c', '/TC']),
  ]))
  // clang-cl 18 compiles a.c as C++, b.c and d.c as C; e.c as C++ (the last /TP or /TC, wherever it
  // is, for a file no /Tp or /Tc names), f.c as C++ (its /Tp, before or after a /TC).
  const commands = loadCompileCommands(tmp, 'compile_commands.json')
  for (const [file, cxx] of [['a.c', true], ['b.c', false], ['d.c', false], ['e.c', true], ['src/f.c', true]]) {
    t.assert.deepStrictEqual(commands.get(file).system, cxx ? [{ rel: 'lib' }] : [], file)
  }
}))

test('collectCBundle searches Clang\'s framework directories, -F with the -I ones, -iframework after the -isystem ones', withTmp((t, tmp) => {
  tree(tmp, {
    'src/main.cpp': '#include <Foo/Foo.h>\n#include <Foo/Priv.h>\n#include <Bar/Bar.h>\n#include <Baz/Baz.h>\n',
    'vendor/Foo.framework/Headers/Foo.h': '#include "Inner.h"\n',
    'vendor/Foo.framework/Headers/Inner.h': '',
    'vendor/Foo.framework/PrivateHeaders/Priv.h': '',
    'i/Foo/Foo.h': '',
    'i/Baz.framework/Headers/Baz.h': '',
    'sf/Bar.framework/Headers/Bar.h': '',
    's/Bar/Bar.h': '',
  })
  const args = ['clang++', '-F', 'vendor', '-Ii', '-Fi', '-iframework', 'sf', '-isystem', 's', '-c', 'src/main.cpp']
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'src/main.cpp', arguments: args }]))
  // clang 18's -E for these: i is searched both plainly and as a framework directory.
  const { resolutions } = collectCBundle(tmp, ['src/main.cpp'], { commands: loadCompileCommands(tmp, 'compile_commands.json') })
  t.assert.deepStrictEqual(Object.fromEntries(resolutions.get('src/main.cpp')), {
    'include <Foo/Foo.h>': 'vendor/Foo.framework/Headers/Foo.h',
    'include <Foo/Priv.h>': 'vendor/Foo.framework/PrivateHeaders/Priv.h',
    'include <Bar/Bar.h>': 's/Bar/Bar.h',
    'include <Baz/Baz.h>': 'i/Baz.framework/Headers/Baz.h',
  })
  t.assert.equal(resolutions.get('vendor/Foo.framework/Headers/Foo.h').get('include "Inner.h"'), 'vendor/Foo.framework/Headers/Inner.h')
}))

test('collectCBundle looks an MSVC quoted include up beside each file including its includer, and /FI beside the unit', withTmp((t, tmp) => {
  tree(tmp, {
    'src/deep/m.c': '#include "../../inc/b.h"\n',
    'inc/b.h': '#include "../other/c.h"\n',
    'other/c.h': '#include "config.h"\n',
    'src/deep/config.h': '',
    'sys/config.h': '',
    'src/deep/pch.h': '',
    'build/README': '',
  })
  const resolve = (argv) => {
    writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: join(tmp, 'build'), file: '../src/deep/m.c', arguments: [...argv, '../src/deep/m.c'] }]))
    return collectCBundle(tmp, ['src/deep/m.c'], { commands: loadCompileCommands(tmp, 'compile_commands.json') }).resolutions
  }
  // clang-cl resolves "config.h" from other/c.h beside m.c, three includers up (-Wmicrosoft-include),
  // ahead of /I; and /FIpch.h, not in the working directory, beside the unit.
  const cl = resolve(['clang-cl', '/I../sys', '/FIpch.h', '/c'])
  t.assert.equal(cl.get('other/c.h').get('include "config.h"'), 'src/deep/config.h')
  t.assert.equal(cl.get('src/deep/m.c').get('/FI pch.h'), 'src/deep/pch.h')
  // GCC looks beside the includer alone, and -include in the working directory, not beside the unit.
  const gcc = resolve(['gcc', '-I../sys', '-include', 'pch.h', '-c'])
  t.assert.equal(gcc.get('other/c.h').get('include "config.h"'), 'sys/config.h')
  t.assert.equal(gcc.get('src/deep/m.c').get('-include pch.h'), undefined)
}))

test('collectCBundle walks a header found in two places on the search path from each, its #include_next carrying on from there', withTmp((t, tmp) => {
  tree(tmp, { 'src/a.c': '#include "inc1/x.h"\n#include <x.h>\n', 'inc1/x.h': '#include_next <config.h>\n', 'inc1/config.h': '', 'inc2/config.h': '' })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'src/a.c', arguments: ['gcc', '-I.', '-Iinc1', '-Iinc2', '-c', 'src/a.c'] }]))
  // GCC 13 opens inc1/config.h after ./inc1/x.h (found in .), inc2/config.h after inc1/x.h (in inc1).
  const { sources } = collectCBundle(tmp, ['src/a.c'], { commands: loadCompileCommands(tmp, 'compile_commands.json') })
  t.assert.ok(sources.has('inc1/config.h'))
  t.assert.ok(sources.has('inc2/config.h'))
}))

test('collectCBundle walks a header MSVC reaches through two includers under each, its quoted includes finding other files beside them', withTmp((t, tmp) => {
  tree(tmp, {
    'src/u.c': '#include <a.h>\n#include <b.h>\n',
    'p1/a.h': '#include <common.h>\n',
    'p2/b.h': '#include <common.h>\n',
    'inc/common.h': '#include "config.h"\n',
    'p1/config.h': '',
    'p2/config.h': '',
  })
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify([{ directory: tmp, file: 'src/u.c', arguments: ['clang-cl', '/Ip1', '/Ip2', '/Iinc', '/c', 'src/u.c'] }]))
  // clang-cl -E opens p1/config.h through a.h, then p2/config.h through b.h.
  const { sources, conflicts } = collectCBundle(tmp, ['src/u.c'], { commands: loadCompileCommands(tmp, 'compile_commands.json') })
  t.assert.ok(sources.has('p1/config.h'))
  t.assert.ok(sources.has('p2/config.h'))
  t.assert.deepStrictEqual(conflicts, [{ spec: 'include "config.h"', from: 'inc/common.h', targets: ['p1/config.h', 'p2/config.h'] }])
}))

test('collectCBundle finds the stdafx.h beside each MSVC unit a shared header reaches it from', withTmp((t, tmp) => {
  tree(tmp, {
    'a/x.cpp': '#include <util.h>\n',
    'b/y.cpp': '#include <util.h>\n',
    'shared/util.h': '#include "detail/d.h"\n',
    'shared/detail/d.h': '#include "stdafx.h"\n',
    'a/stdafx.h': '#include "targetver.h"\n',
    'a/targetver.h': '',
    'b/stdafx.h': '',
  })
  const units = ['a/x.cpp', 'b/y.cpp']
  writeFileSync(join(tmp, 'compile_commands.json'), JSON.stringify(units.map((file) => ({ directory: tmp, file, arguments: ['clang-cl', '/Ishared', '/c', file] }))))
  // clang-cl -E opens a/stdafx.h (and its targetver.h) for x.cpp, b/stdafx.h for y.cpp.
  const { sources } = collectCBundle(tmp, units, { commands: loadCompileCommands(tmp, 'compile_commands.json') })
  t.assert.deepStrictEqual([...sources.keys()].filter((f) => f.endsWith('.h')).toSorted(), ['a/stdafx.h', 'a/targetver.h', 'b/stdafx.h', 'shared/detail/d.h', 'shared/util.h'])
}))
