// classifyFormat's shebang rule (stasis-core/src/shebang.js): an extensionless script's format names the
// program its `#!` line runs, directly or through /usr/bin/env as each kernel's env reads the line --
// GNU env handed the rest as one word on Linux, BSD env handed it split at whitespace on macOS.

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
  assertFormat(t, 'shell', ['#!/bin/sh', '#!/bin/bash -e', '#!/system/bin/sh', '#!/bin/sh\r'])
  // Only the interpreter counts, not a word elsewhere on the line, nor a lookalike program.
  assertFormat(t, undefined, [
    '#!/usr/bin/python3-config', '#!/usr/bin/pythonista', '#!/bin/zsh', '#!/usr/bin/node',
    '#!/opt/sh-tools/bin/node', '#!/usr/bin/perl -w -- sh', '#!/usr/bin/ruby # see setup.sh',
  ])
  t.assert.equal(format('#!/bin/sh\nexec python3 "$0"\n'), 'shell')
  // A shebang is the first line of a UTF-8 file.
  t.assert.equal(format('\n#!/usr/bin/python3\n'), undefined)
  t.assert.equal(format(Buffer.concat([Buffer.from('#!/usr/bin/python3\n# caf'), Buffer.from([0xe9])])), undefined)
  t.assert.equal(classifyFormat('run-tool'), undefined, 'no content, no shebang rule')
})

test('shebang: through env, the command env runs past its options and assignments', (t) => {
  assertFormat(t, 'python', [
    '#!/usr/bin/env python3', '#!/usr/bin/env python3.12', '#!/usr/bin/env PYTHONUTF8=1 python3',
    '#!/usr/bin/env -S /usr/bin/python3 -u', '#!/usr/bin/env -S ./venv/bin/python3', // a path, by its basename
    // Options taking a value skip it, attached or the next word, alone or ending a cluster.
    '#!/usr/bin/env -S -u PYTHONPATH python3', '#!/usr/bin/env -iu PYTHONPATH python3', '#!/usr/bin/env -uPYTHONSTARTUP python3',
    '#!/usr/bin/env -C /opt/app python3', '#!/usr/bin/env -P /usr/local/bin python3',
    '#!/usr/bin/env -S --unset PYTHONPATH python3', '#!/usr/bin/env -S --unset=PYTHONHOME python3', '#!/usr/bin/env -S --chdir /opt/app python3',
    // Options, then assignments, then the command; `--` ends the options.
    '#!/usr/bin/env -u X FOO=x python3', '#!/usr/bin/env -- python3', '#!/usr/bin/env -u X -- FOO=x python3',
    // GNU's other options: `-a`/`--argv0` and `--env0-from` take a value, the signal ones an optional one.
    '#!/usr/bin/env -S -a worker python3', '#!/usr/bin/env -S --argv0=worker python3', '#!/usr/bin/env -S --env0-from /dev/null python3',
    '#!/usr/bin/env -S --block-signal=PIPE python3', '#!/usr/bin/env -S --default-signal python3',
  ])
  assertFormat(t, 'shell', ['#!/usr/bin/env bash', '#!/usr/bin/env sh', '#!/usr/bin/env -S bash -e', '#!/usr/bin/env bash -c python3'])
  assertFormat(t, undefined, [
    '#!/usr/bin/env node', '#!/usr/bin/env node --require ./sh/hook', '#!/usr/bin/env python3-config',
    // Past an assignment or `--`, an option-like word is the command: env runs `-u` and `--` here.
    '#!/usr/bin/env -S FOO=x -u X python3', '#!/usr/bin/env -- -u X python3', '#!/usr/bin/env FOO=x -- python3',
    // An option env doesn't know, an ambiguous long one, or a flag given a value.
    '#!/usr/bin/env -x python3', '#!/usr/bin/env -S --d python3', '#!/usr/bin/env -S --ignore-environment=x python3',
    // `-0` lists the environment, so env refuses it a command.
    '#!/usr/bin/env -0 python3', '#!/usr/bin/env -S -i0 python3', '#!/usr/bin/env -S --null python3',
  ])
})

test('shebang: an env -S string splits as GNU env splits it', (t) => {
  assertFormat(t, 'python', [
    '#!/usr/bin/env -S python3 -u', '#!/usr/bin/env -Spython3 -u', '#!/usr/bin/env --split-string=python3 -u', '#!/usr/bin/env --split=python3 -u',
    // Quotes join and come off, `\_` breaks words, `\c` and a `#` word end the string.
    '#!/usr/bin/env -S FOO="a b" python3', "#!/usr/bin/env -S FOO='a b' python3", '#!/usr/bin/env -S FOO="say \\"hi there\\"" python3 -u',
    '#!/usr/bin/env -S "python3" -u', '#!/usr/bin/env -S py"thon"3', '#!/usr/bin/env -S FOO=x\\_python3 -u',
    '#!/usr/bin/env -S python3\\c junk', '#!/usr/bin/env -S python3 # run unbuffered',
    // -S anywhere among the options: in a cluster, or inside another -S string.
    '#!/usr/bin/env -iS FOO="a b" python3', '#!/usr/bin/env -vS python3 -u', '#!/usr/bin/env -S -iS python3',
  ])
  // A string env refuses (an unterminated quote, a trailing or unknown `\`, `\c` inside "…") or comments
  // out runs nothing, nor does one whose command only the environment knows.
  assertFormat(t, undefined, [
    '#!/usr/bin/env -S FOO="a b python3', '#!/usr/bin/env -S python3\\', '#!/usr/bin/env -S FOO=a\\ b python3',
    '#!/usr/bin/env -S "python3\\c"', '#!/usr/bin/env -S #python3', '#!/usr/bin/env -S ${PYTHON} -u',
  ])
})

test('shebang: a program either kernel\'s env runs counts', (t) => {
  // Without -S, Linux hands env one word, but macOS splits at whitespace: these run python there.
  assertFormat(t, 'python', ['#!/usr/bin/env python3 -u', '#!/usr/bin/env -i -S python3'])
  // Neither runs these: BSD env has no long options and Linux's one word holds the rest, and only -S
  // takes quotes off (macOS runs `b"`, Linux sets FOO).
  assertFormat(t, undefined, ['#!/usr/bin/env --unset PYTHONPATH python3', '#!/usr/bin/env FOO="a b" python3'])
})
