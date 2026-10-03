// classifyFormat's shebang rule (stasis-core/src/shebang.js): an extensionless script's format names the
// program its `#!` line runs, directly or through /usr/bin/env in a closed set of shapes,
// `env [-S] [--] [NAME=value...] program [args]`. Any other env line names nothing (fails closed).

import { test } from 'node:test'

import { classifyFormat } from '@exodus/stasis-core/util'

const format = (content) => classifyFormat('run-tool', { content: Buffer.from(content) })
const assertFormat = (t, expected, shebangs) => {
  for (const shebang of shebangs) t.assert.equal(format(`${shebang}\nprint(1)\n`), expected, shebang)
}

test('shebang: the interpreter names the format, by its basename', (t) => {
  assertFormat(t, 'python', [
    '#!/usr/bin/python', '#!/usr/bin/python3', '#!/usr/local/bin/python3.12 -u', '#! /usr/bin/python2.7',
    '#!/usr/bin/python3\r', // CRLF
    '#!/opt/sh-tools/venv/bin/python', // a virtualenv's path holding an `sh` segment
  ])
  assertFormat(t, 'shell', ['#!/bin/sh', '#!/bin/bash -e'])
  // Only the interpreter counts, not a word elsewhere on the line, nor a lookalike program.
  assertFormat(t, undefined, [
    '#!/usr/bin/python3-config', '#!/usr/bin/pythonista', '#!/bin/zsh', '#!/usr/bin/node',
    '#!/opt/sh-tools/bin/node', '#!/usr/bin/ruby # see setup.sh',
  ])
  t.assert.equal(format('#!/bin/sh\nexec python3 "$0"\n'), 'shell')
  // A shebang is the first line of a UTF-8 file.
  t.assert.equal(format('\n#!/usr/bin/python3\n'), undefined)
  t.assert.equal(format(Buffer.concat([Buffer.from('#!/usr/bin/python3\n# caf'), Buffer.from([0xe9])])), undefined)
  t.assert.equal(classifyFormat('run-tool'), undefined, 'no content, no shebang rule')
})

test('shebang: through env, `[-S] [--] [NAME=value...] program`', (t) => {
  assertFormat(t, 'python', [
    '#!/usr/bin/env python3', '#!/usr/bin/env PYTHONUTF8=1 python3', '#!/usr/bin/env -- python3',
    '#!/usr/bin/env -S python3 -u', '#!/usr/bin/env -S -- PYTHONUTF8=1 python3 -u',
    '#!/usr/bin/env -S /usr/bin/python3 -u', // a path, by its basename
    '#!/usr/bin/env python3 -u', // macOS splits it at whitespace (Linux hands env one word)
  ])
  assertFormat(t, 'shell', ['#!/usr/bin/env bash', '#!/usr/bin/env sh', '#!/usr/bin/env -S bash -e', '#!/usr/bin/env bash -c python3'])
})

test('shebang: any other env line names nothing', (t) => {
  assertFormat(t, undefined, [
    '#!/usr/bin/env node', '#!/usr/bin/env python3-config', '#!/usr/bin/env', '#!/usr/bin/env -S',
    // Arguments after the program are its own, not another program.
    '#!/usr/bin/env node ./lib/sh', '#!/usr/bin/env ruby -I/opt/python3', '#!/usr/bin/env node --require ./sh/hook',
    // Any option but a leading -S, in any spelling.
    '#!/usr/bin/env -i python3', '#!/usr/bin/env -u PYTHONPATH python3', '#!/usr/bin/env -S -u PYTHONPATH python3',
    '#!/usr/bin/env -iS python3', '#!/usr/bin/env -Spython3', '#!/usr/bin/env --split-string=python3',
    '#!/usr/bin/env -0 python3', '#!/usr/bin/env -L root python3',
    // An -S string leaning on env's quotes, escapes, `$` or `#`.
    '#!/usr/bin/env -S FOO="a b" python3', '#!/usr/bin/env -S FOO=x\\_python3 -u', '#!/usr/bin/env -S FOO=$X python3',
    '#!/usr/bin/env -S ${PYTHON} -u', '#!/usr/bin/env -S python3 # run unbuffered',
    // Past an assignment or `--`, the next word is the program, whatever it looks like: an option-like
    // word or one holding `=` (env's assignment, or its error) never names one.
    '#!/usr/bin/env FOO=x -- python3', '#!/usr/bin/env -- -u X python3', '#!/usr/bin/env FOO="a b" python3',
    '#!/usr/bin/env --/sh', '#!/usr/bin/env =x python3', '#!/usr/bin/env {=}/python3',
  ])
})
