import { diskHost } from '@exodus/stasis-core/host'
import { createFieldResolver } from './resolve-fields.js'

// A stylesheet's imports, as webpack's css-loader (Next.js's) takes them: its `@import`s, each `url()` and string of
// an `image-set()`, and a CSS module's `composes: … from` and `@value … from`, read off CSS's own tokens (CSS
// Syntax Level 3), so a comment, a string or an escape hides or spells one as it does for the loader.

// By char code, as a tokenizer reads a whole node_modules stylesheet: a letter, `_` or any non-ASCII; a digit or `-`.
const code = (c) => c?.charCodeAt(0) ?? -1
const isLetter = (n) => (n >= 0x41 && n <= 0x5A) || (n >= 0x61 && n <= 0x7A)
const isDigit = (n) => n >= 0x30 && n <= 0x39
const isNameStart = (c) => {
  const n = code(c)
  return isLetter(n) || n === 0x5F || n > 0x7F
}
const isName = (c) => isNameStart(c) || isDigit(code(c)) || c === '-'
const isHex = (c) => {
  const n = code(c)
  return isDigit(n) || (n >= 0x41 && n <= 0x46) || (n >= 0x61 && n <= 0x66)
}
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
const isNewline = (c) => c === '\n' || c === '\r' || c === '\f'
// A backslash starting an escape: not one before a newline (a string's line continuation, else a bare `\`).
const startsEscape = (src, i) => src[i] === '\\' && i + 1 < src.length && !isNewline(src[i + 1])
const startsName = (src, i) => isNameStart(src[i]) || startsEscape(src, i) ||
  (src[i] === '-' && (isNameStart(src[i + 1]) || src[i + 1] === '-' || startsEscape(src, i + 1)))

const KINDS = { import: 'css-import', url: 'css-url', from: 'css-composes' }
export const CSS_KINDS = new Set(Object.values(KINDS))

// The text an escape at `src[i]` (its backslash) spells, and the index past it.
function escapeAt(src, i) {
  let j = i + 1
  if (!isHex(src[j])) return [src[j] ?? '�', j + 1]
  let hex = ''
  while (hex.length < 6 && isHex(src[j])) hex += src[j++]
  if (src[j] === '\r' && src[j + 1] === '\n') j += 2
  else if (isSpace(src[j])) j += 1
  const point = Number.parseInt(hex, 16)
  return [point === 0 || point > 0x10FFFF || (point >= 0xD800 && point <= 0xDFFF) ? '�' : String.fromCodePoint(point), j]
}

// Past the whitespace and comments at `i`.
function skipSpace(src, i) {
  while (i < src.length) {
    if (isSpace(src[i])) i++
    else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
    } else break
  }
  return i
}

function readName(src, i) {
  let name = ''
  while (i < src.length) {
    if (isName(src[i])) name += src[i++]
    else if (startsEscape(src, i)) {
      const [text, next] = escapeAt(src, i)
      name += text
      i = next
    } else break
  }
  return [name, i]
}

// A string's text and the index past it; a newline ends a bad one, as the tokenizer ends it.
function readString(src, i) {
  const quote = src[i++]
  let text = ''
  while (i < src.length && src[i] !== quote) {
    if (isNewline(src[i])) return [text, i]
    if (src[i] !== '\\') {
      text += src[i++]
      continue
    }
    // A backslash before a newline continues the string; one at the end of the file spells nothing.
    if (i + 1 >= src.length) i += 1
    else if (src[i + 1] === '\r') i += src[i + 2] === '\n' ? 3 : 2
    else if (isNewline(src[i + 1])) i += 2
    else {
      const [escaped, next] = escapeAt(src, i)
      text += escaped
      i = next
    }
  }
  return [text, i + 1]
}

// Past the `)` closing what is at `i`.
const pastClose = (src, i) => {
  const close = src.indexOf(')', i)
  return close === -1 ? src.length : close + 1
}

// An unquoted `url(`'s URL, up to its `)`: past whitespace anything but the `)`, and a quote or `(` in it, make it a
// bad url, which spells none (null).
function readUrl(src, i) {
  let url = ''
  i = skipSpace(src, i)
  while (i < src.length && src[i] !== ')') {
    if (isSpace(src[i])) {
      const end = skipSpace(src, i)
      return src[end] === ')' ? [url, end + 1] : [null, pastClose(src, end)]
    }
    if (src[i] === '"' || src[i] === "'" || src[i] === '(' || (src[i] === '\\' && !startsEscape(src, i))) return [null, pastClose(src, i)]
    if (src[i] === '\\') {
      const [text, next] = escapeAt(src, i)
      url += text
      i = next
      continue
    }
    url += src[i++]
  }
  return [url, i + 1]
}

// The specifiers `source` imports, in its order: [{ kind, spec }], `kind` one of CSS_KINDS.
export function cssSpecifiers(source) {
  const src = source.startsWith('﻿') ? source.slice(1) : source
  const specs = []
  // The open functions' names (`image-set`, whose strings are URLs too), innermost last.
  const functions = []
  // An `@import`'s first token is its specifier; a `composes:` declaration's or an `@value` rule's `from` names one.
  let importing = false
  let fromRule = false
  // The last token, a name's text or a delimiter: a declaration's name follows a `{` or a `;`.
  let last = null
  let lastName = null
  const url = (spec) => {
    if (spec !== null) specs.push({ kind: importing ? KINDS.import : KINDS.url, spec })
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (isSpace(c) || src.startsWith('/*', i)) {
      i = skipSpace(src, i)
      continue
    }
    if (c === '"' || c === "'") {
      const [text, next] = readString(src, i)
      i = next
      const fn = functions.at(-1)
      if (importing && functions.length === 0) specs.push({ kind: KINDS.import, spec: text })
      else if (fromRule && lastName === 'from') specs.push({ kind: KINDS.from, spec: text })
      else if (fn === 'image-set' || fn === '-webkit-image-set') specs.push({ kind: KINDS.url, spec: text })
      importing = false
      last = 'string'
      lastName = null
      continue
    }
    if (c === '@' && startsName(src, i + 1)) {
      const [name, next] = readName(src, i + 1)
      i = next
      const at = name.toLowerCase()
      importing = at === 'import'
      fromRule = at === 'value'
      last = 'at'
      lastName = null
      continue
    }
    if (startsName(src, i)) {
      const [name, next] = readName(src, i)
      i = next
      const lower = name.toLowerCase()
      if (src[i] === '(' && lower === 'url') {
        // `url("…")` is a function of a string, the string its URL; else the token is the URL itself.
        const at = skipSpace(src, i + 1)
        if (src[at] === '"' || src[at] === "'") {
          const [text, after] = readString(src, at)
          url(text)
          i = pastClose(src, after)
        } else {
          const [spec, after] = readUrl(src, i + 1)
          url(spec)
          i = after
        }
        importing = false
        last = 'url'
        lastName = null
      } else if (src[i] === '(') {
        functions.push(lower)
        i++
        importing = false
        last = 'function'
        lastName = null
      } else {
        if (lower === 'composes' && (last === '{' || last === ';') && src[skipSpace(src, i)] === ':') fromRule = true
        importing = false
        last = 'name'
        lastName = lower
      }
      continue
    }
    if (c === '(') functions.push('')
    else if (c === ')') functions.pop()
    if (c === ';' || c === '{' || c === '}') {
      fromRule = false
      importing = false
      functions.length = 0
    } else if (c !== ':' && c !== ',') {
      importing = false
    }
    // `composes: a, b from …` keeps the name before its `:` and `,`.
    if (c !== ':' && c !== ',') lastName = null
    last = c
    i++
  }
  return specs
}

// Not a file the stylesheet's loader resolves (Next's cssFileResolve, css-loader's isURLRequestable): none, a
// fragment (`#id`), a URL with a scheme (`data:`, `https:`) or none of its own (`//cdn`), and a path from the site's
// root (`/images/x.png`), which Next serves from `public`.
const isRequestable = (spec) => spec !== '' && !spec.startsWith('#') && !spec.startsWith('/') && !/^[A-Za-z][\d+.A-Za-z-]*:/u.test(spec)

// As css-loader takes a URL: its query and fragment off (`font.woff2?v=1#iefix`), decoded.
function requestOf(spec) {
  const bare = spec.replace(/[?#].*$/su, '')
  try {
    return decodeURI(bare)
  } catch {
    return bare
  }
}

// The requests a specifier stands for, in the order css-loader tries them: a `~` one a package's, a path as it is,
// any other relative to the stylesheet first, then a package's (`@import 'tailwindcss'`). None for one it doesn't
// resolve.
export function cssRequests(spec) {
  if (!isRequestable(spec)) return []
  const request = requestOf(spec)
  if (request === '') return []
  if (request.startsWith('~')) return [request.slice(1)]
  if (/^\.\.?(?:\/|$)/u.test(request)) return [request]
  return [`./${request}`, request]
}

// What css-loader's two resolvers resolve: an import (`@import`, `composes`, `@value`) by the `style` condition, the
// `css`, `style` and `main` fields and a `.css` extension; a url() by the `asset` condition and field, as written.
// -> (parentFile, kind, spec) -> { url } of the first of cssRequests' that resolves, or null
export function createCssResolver({ host = diskHost, kept } = {}) {
  const imports = createFieldResolver({ conditions: ['style'], mainFields: ['css', 'style', 'main'], sourceExts: ['css'], host, kept })
  const urls = createFieldResolver({ conditions: ['asset'], mainFields: ['asset'], sourceExts: [], host, kept })
  return (parentFile, kind, spec) => {
    const resolver = kind === KINDS.url ? urls : imports
    for (const request of cssRequests(spec)) {
      const hit = resolver(parentFile, request)
      if (hit?.url !== undefined) return hit
    }
    return null
  }
}
