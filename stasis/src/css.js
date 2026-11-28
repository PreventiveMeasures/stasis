import { withoutBom } from '@exodus/stasis-core/util'
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
    if (startsEscape(src, i)) {
      const [escaped, next] = escapeAt(src, i)
      text += escaped
      i = next
    } else if (src[i] === '\\') {
      // A backslash before a newline continues the string; one at the end of the file spells nothing.
      i += src.startsWith('\r\n', i + 1) ? 3 : 2
    } else {
      text += src[i++]
    }
  }
  return [text, i + 1]
}

// Past the `)` closing what is at `i`.
const pastClose = (src, i) => {
  const close = src.indexOf(')', i)
  return close === -1 ? src.length : close + 1
}

// A `url(`'s URL, up to its `)`: a string's, what follows it skipped; else the unquoted token, which past whitespace
// anything but the `)`, and a quote or `(` in it, make a bad url, which spells none (null).
function readUrl(src, i) {
  let url = ''
  i = skipSpace(src, i)
  if (src[i] === '"' || src[i] === "'") {
    const [text, end] = readString(src, i)
    return [text, pastClose(src, end)]
  }
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

// The token at `i`, [type, value, end]: a `string`, an `at`-keyword, an `ident`, a `function` or a `url` (a name's
// value lowercased), else a `delim`, one character.
function tokenAt(src, i) {
  const c = src[i]
  if (c === '"' || c === "'") {
    const [text, end] = readString(src, i)
    return ['string', text, end]
  }
  const at = c === '@' && startsName(src, i + 1)
  if (!at && !startsName(src, i)) return ['delim', c, i + 1]
  const [name, end] = readName(src, at ? i + 1 : i)
  const lower = name.toLowerCase()
  if (at) return ['at', lower, end]
  if (src[end] !== '(') return ['ident', lower, end]
  // `url("…")` is a function of a string, the string its URL; else the token is the URL itself.
  if (lower === 'url') {
    const [url, past] = readUrl(src, end + 1)
    return ['url', url, past]
  }
  return ['function', lower, end + 1]
}

const IMAGE_SETS = new Set(['image-set', '-webkit-image-set'])

// The specifiers `source` imports, in its order: [{ kind, spec }], `kind` one of CSS_KINDS.
export function cssSpecifiers(source) {
  const src = withoutBom(source)
  const specs = []
  // The open functions' names (`image-set`, whose strings are URLs too), innermost last.
  const functions = []
  // An `@import`'s first token is its specifier; a `composes:` declaration's or an `@value` rule's `from` names one.
  let importing = false
  let fromRule = false
  // In an at-rule's prelude, up to its block or `;`: a url() there (`@supports (background: url(x.png))`) loads
  // nothing, as css-loader takes an asset's URL from a declaration alone.
  let prelude = false
  // Whether the last token is a `{` or a `;`, which a declaration's name follows; the last name read.
  let declares = false
  let lastName = null
  let i = skipSpace(src, 0)
  while (i < src.length) {
    const [type, value, end] = tokenAt(src, i)
    i = skipSpace(src, end)
    if (type === 'string') {
      if (importing && functions.length === 0) specs.push({ kind: KINDS.import, spec: value })
      else if (fromRule && lastName === 'from') specs.push({ kind: KINDS.from, spec: value })
      else if (!prelude && IMAGE_SETS.has(functions.at(-1))) specs.push({ kind: KINDS.url, spec: value })
    } else if (type === 'url') {
      if (value !== null && (importing || !prelude)) specs.push({ kind: importing ? KINDS.import : KINDS.url, spec: value })
    } else if (type === 'at') {
      fromRule = value === 'value'
      prelude = true
    } else if (type === 'function') {
      functions.push(value)
    } else if (type === 'ident') {
      if (value === 'composes' && declares && src[i] === ':') fromRule = true
    } else if (value === '(') {
      functions.push('')
    } else if (value === ')') {
      functions.pop()
    } else if (value === ';' || value === '{' || value === '}') {
      fromRule = false
      prelude = false
      functions.length = 0
    }
    // `composes: a, b from …` keeps the name before its `:` and `,`, as `@import` keeps its specifier to come.
    const keeps = type === 'delim' && (value === ':' || value === ',')
    if (!keeps) lastName = type === 'ident' ? value : null
    importing = type === 'at' ? value === 'import' : importing && keeps
    declares = type === 'delim' && (value === '{' || value === ';')
  }
  return specs
}

// Not a file the stylesheet's loader resolves (Next's cssFileResolve, css-loader's isURLRequestable): none, a
// fragment (`#id`), a URL with a scheme (`data:`, `https:`) or none of its own (`//cdn`), and a path from the site's
// root (`/images/x.png`), which Next serves from `public`.
const isRequestable = (spec) => spec !== '' && !spec.startsWith('#') && !spec.startsWith('/') && !/^[A-Za-z][\d+.A-Za-z-]*:/u.test(spec)

// A URL's file: its query and fragment off (`font.woff2?v=1#iefix`), then its path decoded, a reserved character
// too (`hash%23mark.svg` names `hash#mark.svg`); as it is where it doesn't decode.
function requestOf(spec) {
  const bare = spec.replace(/[?#].*$/su, '')
  try {
    return decodeURIComponent(bare)
  } catch {
    return bare
  }
}

// The requests a specifier stands for, in the order css-loader tries them: a `~` one a package's, a path as it is,
// any other relative to the stylesheet first, then a package's (`@import 'tailwindcss'`). None for one it doesn't
// resolve.
export function cssRequests(spec) {
  // Decoded, it is held to the same rule: `%2Fetc%2Fpasswd` is a path from the root too.
  const request = isRequestable(spec) ? requestOf(spec) : ''
  if (!isRequestable(request)) return []
  if (request.startsWith('~')) return [request.slice(1)]
  if (/^\.\.?(?:\/|$)/u.test(request)) return [request]
  return [`./${request}`, request]
}

// What css-loader's two resolvers resolve: an import (`@import`, `composes`, `@value`) by the `style` condition, the
// `css`, `style` and `main` fields and a `.css` extension; a url() by the `asset` condition and field, as written.
// -> (parentFile, kind, spec) -> { url } of the first of cssRequests' that resolves, or null
export function createCssResolver({ host }) {
  const imports = createFieldResolver({ conditions: ['style'], mainFields: ['css', 'style', 'main'], sourceExts: ['css'], host })
  const urls = createFieldResolver({ conditions: ['asset'], mainFields: ['asset'], sourceExts: [], host })
  return (parentFile, kind, spec) => {
    const resolver = kind === KINDS.url ? urls : imports
    for (const request of cssRequests(spec)) {
      const hit = resolver(parentFile, request)
      if (hit?.url !== undefined) return hit
    }
    return null
  }
}
