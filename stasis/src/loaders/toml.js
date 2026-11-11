// TOML for Cargo.toml, Cargo.lock and foundry.toml, by @preventive/lockfile's strict TOML 1.0 parser:
// what isn't TOML is a TomlError naming the file and line, never a guessed value.

import { TomlError, parseToml } from '@preventive/lockfile/toml.js'

export { TomlError }

// The index of the bracket closing the one at `open`; the last index when unbalanced.
export function matchClose(text, open) {
  const close = { '[': ']', '(': ')', '{': '}' }[text[open]]
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++
    else if (text[i] === close && --depth === 0) return i
  }
  return text.length - 1
}

// Split on commas outside brackets, braces, parentheses and strings.
export function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let start = 0
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

// Tables are null-prototype objects; an integer past 2^53 is a BigInt.
export const readToml = (text, file = null) => nameErrors(file, () => parseToml(text))

// `read()`, with an error of one of `classes` re-thrown with `file: ` leading its message, its fields kept.
export function nameErrors(file, read, classes = [TomlError]) {
  try {
    return read()
  } catch (err) {
    if (file === null || !classes.some((c) => err instanceof c)) throw err
    throw Object.assign(new err.constructor(`${file}: ${err.message}`), err)
  }
}

// The prototype check: a TomlFloat or TomlDateTime is an object too.
export const isTomlTable = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === null
