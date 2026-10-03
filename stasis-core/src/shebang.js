import { isUtf8 } from 'node:buffer'

// The format of an extensionless script, named by the program its `#!` line runs, by basename (so a
// virtualenv's python is python, whatever its path holds). Through `/usr/bin/env` only a closed set of
// shapes is read, `env [-S] [--] [NAME=value...] program [args]`, with plain words after `-S`; any other
// option, or an `-S` string leaning on env's quotes, escapes, `$` or `#`, names nothing, and the file
// stays a resource. Within that set, splitting at whitespace names the program macOS runs (its kernel
// splits the line so), and the one Linux runs wherever it runs one (its kernel hands env one word).

const INTERPRETER_FORMATS = [
  [/^(?:ba)?sh$/u, 'shell'],
  [/^python(?:\d+(?:\.\d+)*)?$/u, 'python'],
]

// A word every env's `-S` splits at whitespace alone, and the assignment a word holding `=` must be (env
// takes every such word for one, so none is the program).
const PLAIN_WORD = /^[\w./+:@%,=-]+$/u
const ASSIGNMENT = /^[A-Za-z_]\w*=/u

// The format `content`'s `#!` line names, else undefined. A script is UTF-8 throughout, but a file not
// opening with `#!` never pays for that whole-buffer check.
export function shebangFormat(content) {
  if (!Buffer.isBuffer(content)) return undefined
  const line = content.subarray(0, 256).toString('utf8').split('\n', 1)[0]
  if (!line.startsWith('#!') || !isUtf8(content)) return undefined
  const program = lastSegment(shebangProgram(line))
  return INTERPRETER_FORMATS.find(([name]) => name.test(program))?.[1]
}

// The program a `#!` line runs, or '' for an env line outside the shapes read.
function shebangProgram(line) {
  const [interpreter, ...words] = line.slice(2).trim().split(/\s+/u)
  if (lastSegment(interpreter) !== 'env') return interpreter
  if (words[0] === '-S') {
    words.shift()
    if (!words.every((word) => PLAIN_WORD.test(word))) return ''
  }
  if (words[0] === '--') words.shift()
  while (words[0]?.includes('=')) {
    if (!ASSIGNMENT.test(words.shift())) return ''
  }
  const program = words[0] ?? ''
  return program.startsWith('-') ? '' : program
}

const lastSegment = (path) => path.slice(path.lastIndexOf('/') + 1)
