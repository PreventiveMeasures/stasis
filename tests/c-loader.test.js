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
