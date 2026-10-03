import { isUtf8 } from 'node:buffer'

// The format of an extensionless script, named by the program its `#!` line runs: the interpreter, or
// the command `/usr/bin/env` runs, by basename either way (so a virtualenv's python is python, whatever
// its path holds). The env a shebang reaches differs by kernel: Linux hands GNU env the rest of the line
// as one word, macOS splits it at whitespace for BSD env. A program either one runs counts.

const INTERPRETER_FORMATS = [
  [/^(?:ba)?sh$/u, 'shell'],
  [/^python(?:\d+(?:\.\d+)*)?$/u, 'python'],
]

// Each env's flags, its options taking a value (attached, or the next word), and its long options,
// which GNU's getopt takes cut to any unambiguous prefix. BSD env has none.
const GNU_ENV = {
  flags: '0iv',
  values: 'uCS',
  long: ['ignore-environment', 'null', 'debug', 'unset', 'chdir', 'split-string', 'block-signal', 'default-signal', 'ignore-signal', 'list-signal-handling'],
}
const BSD_ENV = { flags: '0iv', values: 'uCPSLU', long: [] }
const ENV_LONG_VALUES = { unset: 'u', chdir: 'C', 'split-string': 'S' }

// The escapes `env -S` takes outside '…' (where only `\\` and `\'` escape).
const ENV_ESCAPES = { '"': '"', "'": "'", '\\': '\\', '#': '#', $: '$', _: ' ', n: '\n', t: '\t', r: '\r', f: '\f', v: '\v' }

// The format `content`'s `#!` line names, else undefined. A script is UTF-8 throughout, but a file not
// opening with `#!` never pays for that whole-buffer check.
export function shebangFormat(content) {
  if (!Buffer.isBuffer(content)) return undefined
  const line = content.subarray(0, 256).toString('utf8').split('\n', 1)[0]
  if (!line.startsWith('#!') || !isUtf8(content)) return undefined
  const programs = shebangPrograms(line)
  return INTERPRETER_FORMATS.find(([name]) => programs.some((program) => name.test(program)))?.[1]
}

// The basenames of the programs a `#!` line runs: its interpreter, or the command its env runs on Linux
// and on macOS (`#!/usr/bin/env -S -u PYTHONPATH FOO="a b" python3 -u` -> python3 on both).
function shebangPrograms(line) {
  const [, interpreter, rest] = /^(\S*)\s*(.*)$/su.exec(line.slice(2).trim())
  const programs = lastSegment(interpreter) === 'env'
    ? [envCommand([rest], GNU_ENV), envCommand(rest.split(/\s+/u), BSD_ENV)]
    : [interpreter]
  return programs.map(lastSegment)
}

const lastSegment = (path) => path.slice(path.lastIndexOf('/') + 1)

// The command an env runs for these arguments, or '' where env refuses them: past its options, read as
// getopt reads them up to `--`, `-` or the first other word (an `-S` string split into words in its
// place), then past its assignments.
function envCommand(words, env) {
  const args = [...words]
  let i = 0
  for (; i < args.length && args[i].startsWith('-') && args[i] !== '-'; i++) {
    if (args[i] === '--') {
      i++
      break
    }
    const option = envOption(args[i], env)
    if (option === null) return ''
    if (option.letter === undefined) continue
    const value = option.value ?? args[++i]
    if (value === undefined) return ''
    if (option.letter !== 'S') continue
    const split = splitEnvString(value)
    if (split === null) return ''
    args.splice(i + 1, 0, ...split)
  }
  if (args[i] === '-') i++
  while (i < args.length && args[i].includes('=')) i++
  return args[i] ?? ''
}

// One option word: the option taking a value it ends with, and that value when attached; {} for flags
// alone; null for an option this env doesn't know.
function envOption(word, { flags, values, long }) {
  const longOption = /^--([^=]*)(?:=(.*))?$/su.exec(word)
  if (longOption !== null) {
    const names = long.filter((name) => name.startsWith(longOption[1]))
    if (names.length !== 1) return null
    return { letter: ENV_LONG_VALUES[names[0]], value: longOption[2] }
  }
  let at = 1
  while (at < word.length && flags.includes(word[at])) at++
  if (at === word.length) return {}
  if (!values.includes(word[at])) return null
  return { letter: word[at], value: word.slice(at + 1) || undefined }
}

// The words an `env -S` string splits into, as GNU env splits it: whitespace (and `\_` outside "…")
// breaks words outside quotes, quotes and escapes join and unquote, and `\c` outside "…" or a word
// opening with `#` ends it. null for a string env refuses: an unterminated quote, or an unknown or
// trailing `\`.
function splitEnvString(text) {
  const words = []
  let word = null
  let quote = null
  const flush = () => {
    if (word !== null) words.push(word)
    word = null
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c === '\\' && (text[i + 1] === '\\' || text[i + 1] === "'") ? text[++i] : c
    } else if (c === '\\') {
      const escape = text[++i]
      if (quote === null && escape === 'c') break
      if (quote === null && escape === '_') flush()
      else if (Object.hasOwn(ENV_ESCAPES, escape)) word = (word ?? '') + ENV_ESCAPES[escape]
      else return null
    } else if (quote === '"') {
      if (c === '"') quote = null
      else word += c
    } else if (/\s/u.test(c)) {
      flush()
    } else if (c === '#' && word === null) {
      break
    } else if (c === "'" || c === '"') {
      quote = c
      word ??= ''
    } else {
      word = (word ?? '') + c
    }
  }
  if (quote !== null) return null
  flush()
  return words
}
