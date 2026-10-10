// Java import edges among a set of Java sources: the file each one's type references land on, as
// javac resolves a name against the compilation units it has. Pure (no Node builtins): the sources
// are handed in and nothing is read, so a capture that already holds the bytes records the edges
// from exactly those. The Metro native captures (`stasis bundle --metro`, StasisMetro) carry a React
// Native app's Java -- each native dependency's android/ sources and react-native's own -- and key
// these edges under JAVA_CONDITION.

// The `imports` conditions key Java edges are recorded under: the language tag, as the
// source-language bundles key theirs.
export const JAVA_CONDITION = 'java'

// Reserved words (JLS 3.9) and the literals true/false/null: never a type, a package or a variable,
// so a name chain stops at one (`Foo.class`, `Outer.this`). Contextual keywords (`var`, `record`,
// `module`, `sealed`, ...) are identifiers elsewhere and stay names.
const KEYWORDS = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp',
  'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void',
  'volatile', 'while', 'true', 'false', 'null', '_',
])

// Character.isJavaIdentifierStart / isJavaIdentifierPart, by Unicode category: letters, letter
// numbers, currency symbols and connecting punctuation start one; digits, combining marks and
// format characters may follow.
const IDENTIFIER = /[\p{L}\p{Nl}\p{Sc}\p{Pc}][\p{L}\p{Nl}\p{Sc}\p{Pc}\p{Nd}\p{Mn}\p{Mc}\p{Cf}]*/uy

const HEX4 = /^[0-9A-Fa-f]{4}$/u

// The text javac lexes (JLS 3.3): each `\uXXXX` (any number of `u`s) translated to its UTF-16 code
// unit, where its backslash is preceded by an even number of contiguous backslashes. Done before
// anything else, as javac does it, so `// \u000a import a.B;` imports a.B and `"` opens a
// string. An escape with no four hex digits is left as written (javac refuses the file).
export function translateUnicodeEscapes(text) {
  if (!text.includes('\\u')) return text
  let out = ''
  let last = 0
  let i = text.indexOf('\\')
  while (i !== -1) {
    let run = i
    while (text[run] === '\\') run++
    // `run - 1` is the run's last backslash, preceded by `run - 1 - i` others.
    let end = run
    if ((run - 1 - i) % 2 === 0 && text[run] === 'u') {
      while (text[end] === 'u') end++
      const hex = text.slice(end, end + 4)
      if (HEX4.test(hex)) {
        out += text.slice(last, run - 1) + String.fromCharCode(Number.parseInt(hex, 16))
        end += 4
        last = end
      }
    }
    i = text.indexOf('\\', end)
  }
  return out + text.slice(last)
}

const isLineEnd = (c) => c === '\n' || c === '\r'

// The index past the quoted literal opening at `i` (`"..."` or `'...'`), its escapes skipped; an
// unterminated one ends at the line.
function skipQuoted(code, i, quote) {
  let j = i + 1
  while (j < code.length && code[j] !== quote && !isLineEnd(code[j])) j += code[j] === '\\' ? 2 : 1
  return j + 1
}

// The index past the text block opening at `i` (`"""`), its escapes skipped; to the end when unclosed.
function skipTextBlock(code, i) {
  let j = i + 3
  while (j < code.length) {
    if (code[j] === '\\') j += 2
    else if (code.startsWith('"""', j)) return j + 3
    else j++
  }
  return j
}

// The index past the numeric literal at `i`: digits, letters (hex digits, suffixes, exponent markers),
// `_` and `.`, and the sign right after an exponent marker (`p` in a hex literal, else `e`).
function skipNumber(code, i) {
  const exponent = /^0[xX]/u.test(code.slice(i, i + 2)) ? /[pP]/u : /[eE]/u
  let j = i
  while (j < code.length) {
    const c = code[j]
    if (/[\w.]/u.test(c)) j++
    else if ((c === '+' || c === '-') && exponent.test(code[j - 1])) j++
    else break
  }
  return j
}

// One `{ p: char }` token per punctuation character, shared by every occurrence.
const PUNCTUATION = new Map()
const punctuation = (p) => {
  let token = PUNCTUATION.get(p)
  if (token === undefined) PUNCTUATION.set(p, (token = Object.freeze({ p })))
  return token
}

// The tokens of Java source `code` (escapes already translated) that name things: identifiers and
// keywords as strings, and each other non-space character as `{ p: char }`. Comments, string, text
// block and character literals and numbers produce none.
function tokenize(code) {
  const tokens = []
  let i = 0
  while (i < code.length) {
    const c = code[i]
    if (c === ' ' || c === '\t' || c === '\f' || isLineEnd(c)) {
      i++
    } else if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && !isLineEnd(code[i])) i++
    } else if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2)
      i = close === -1 ? code.length : close + 2
    } else if (c === '"') {
      i = code.startsWith('"""', i) ? skipTextBlock(code, i) : skipQuoted(code, i, '"')
    } else if (c === "'") {
      i = skipQuoted(code, i, "'")
    } else if ((c >= '0' && c <= '9') || (c === '.' && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      i = skipNumber(code, i)
    } else {
      IDENTIFIER.lastIndex = i
      const m = IDENTIFIER.exec(code)
      if (m) {
        tokens.push(m[0])
        i += m[0].length
      } else {
        const cp = code.codePointAt(i)
        tokens.push(punctuation(String.fromCodePoint(cp)))
        i += cp > 0xffff ? 2 : 1
      }
    }
  }
  return tokens
}

const isName = (token) => typeof token === 'string' && !KEYWORDS.has(token)
const isPunct = (token, p) => typeof token === 'object' && token?.p === p

// The qualified name at `tokens[i]` (`a.b.C`), and with `star` a trailing `.*`:
// -> { segments, onDemand, end } (end: the index past it), or null where no name starts there.
function readName(tokens, i, { star = false } = {}) {
  if (!isName(tokens[i])) return null
  const segments = [tokens[i]]
  let j = i + 1
  let onDemand = false
  while (isPunct(tokens[j], '.')) {
    if (isName(tokens[j + 1])) {
      segments.push(tokens[j + 1])
      j += 2
    } else if (star && isPunct(tokens[j + 1], '*')) {
      onDemand = true
      j += 2
      break
    } else {
      break
    }
  }
  return { segments, onDemand, end: j }
}

// The index past the `;` ending the declaration at `i` (the end of the tokens without one).
function pastSemicolon(tokens, i) {
  while (i < tokens.length && !isPunct(tokens[i], ';')) i++
  return i + 1
}

// What a Java compilation unit declares and refers to:
// -> { pkg, imports, types, declared, refs }
//   pkg: its package (`a.b`), '' for the unnamed package
//   imports: [{ segments, isStatic, onDemand }], in source order; a module import (`import module
//     m;`) is none
//   types: the simple names of its top-level classes, interfaces, enums, records and annotation
//     interfaces; declared: of every type it declares, at any depth (nested, local, top-level)
//   refs: each distinct name chain written outside the package and import declarations, as
//     segments (`Outer.Inner.CONST` -> ['Outer', 'Inner', 'CONST']); a chain after a `.` is a member
//     of an expression (`x().Foo`), not a name, and is left out
export function scanJavaSource(text) {
  const tokens = tokenize(translateUnicodeEscapes(text))
  let pkg = ''
  let sawPackage = false
  const imports = []
  const types = new Set()
  const declared = new Set()
  const refs = new Map()
  let depth = 0
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (depth === 0 && token === 'package' && !sawPackage) {
      const name = readName(tokens, i + 1)
      sawPackage = true
      if (name) pkg = name.segments.join('.')
      i = pastSemicolon(tokens, i + 1)
      continue
    }
    if (depth === 0 && token === 'import') {
      let j = i + 1
      const isStatic = tokens[j] === 'static'
      if (isStatic) j++
      // `import module java.base;` (JEP 511) imports a module's packages, no type of these files.
      const isModule = !isStatic && tokens[j] === 'module' && isName(tokens[j + 1])
      const name = isModule ? null : readName(tokens, j, { star: true })
      if (name) imports.push({ segments: name.segments, isStatic, onDemand: name.onDemand })
      i = pastSemicolon(tokens, j)
      continue
    }
    if (isPunct(token, '{')) depth++
    else if (isPunct(token, '}')) depth = Math.max(0, depth - 1)
    // A type declaration: `class`/`interface`/`enum` (`@interface` too) not after a `.` (`Foo.class`
    // is a class literal), or a `record` followed by its name and its header.
    const declares = ((token === 'class' || token === 'interface' || token === 'enum') && !isPunct(tokens[i - 1], '.')) ||
      (token === 'record' && isName(tokens[i + 1]) && (isPunct(tokens[i + 2], '(') || isPunct(tokens[i + 2], '<')))
    if (declares && isName(tokens[i + 1])) {
      declared.add(tokens[i + 1])
      if (depth === 0) types.add(tokens[i + 1])
      i += 2
      continue
    }
    if (isName(token) && !isPunct(tokens[i - 1], '.')) {
      const name = readName(tokens, i)
      refs.set(name.segments.join('.'), name.segments)
      i = name.end
      continue
    }
    i++
  }
  return { pkg, imports, types, declared, refs: [...refs.values()] }
}

// Where a Java file sits in its build: `root`, the directory its package's directories hang off
// (`android/src/main/java` for `android/src/main/java/com/a/B.java` in package com.a; the file's own
// directory where its path doesn't end in its package's); and for a Gradle/Maven source set
// (`<module>/src/<set>/java`), the set's name and its module's directory.
function locate(path, pkg) {
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '' : path.slice(0, slash)
  const pkgDir = pkg.replaceAll('.', '/')
  let root = dir
  if (dir === pkgDir) root = ''
  else if (pkgDir !== '' && dir.endsWith(`/${pkgDir}`)) root = dir.slice(0, -pkgDir.length - 1)
  const set = /^(?:(.*)\/)?src\/([^/]+)\/java$/u.exec(root)
  return set ? { root, module: set[1] ?? '', set: set[2] } : { root, module: root, set: null }
}

// The file(s) a reference from the file at `from` to a type declared by each of `candidates` means:
// one alone; else, as Gradle compiles a module's source sets, the copy in `from`'s own source root,
// else its module's `main` one, else its module's copies (exclusive variants: `newarch`/`oldarch`,
// flavors, build types), else every copy. Several -> a Map of each by its source set's name (`*`
// outside one), a second under one name numbered (`main#2`), as a --metro edge maps its platforms.
function pick(from, candidates, where) {
  if (candidates.length === 1) return candidates[0]
  const at = where.get(from)
  const groups = [
    (c) => where.get(c).root === at.root,
    (c) => where.get(c).module === at.module && where.get(c).set === 'main',
    (c) => where.get(c).module === at.module,
  ]
  let chosen = candidates
  for (const inGroup of groups) {
    const found = candidates.filter(inGroup)
    if (found.length > 0) {
      chosen = found
      break
    }
  }
  if (chosen.length === 1) return chosen[0]
  const byKey = new Map()
  for (const file of chosen) {
    const name = where.get(file).set ?? '*'
    let key = name
    for (let n = 2; byKey.has(key); n++) key = `${name}#${n}`
    byKey.set(key, file)
  }
  return byKey
}

// The edges among Java `sources` (Map<path, text>, '/'-separated paths): Map<parent path,
// Map<type name, target>>, a parent with none left out. A type is named by its canonical name
// (`com.a.Outer` -- of the top-level type whose file it is, for a nested one too) and lands on the
// file that declares it, by its package and type declarations, wherever that file sits; a target is
// that file's path, or where several declare it, what `pick` makes of them. Names resolve as javac
// scopes them: types this file declares, then single-type imports, then its own package's types,
// then type-import-on-demand packages, else a fully qualified name. Each single-type and static
// import of a type here is an edge, used or not; a name naming nothing here (java.lang.String, a
// dependency's class, generated R or BuildConfig) none.
export function javaImportEdges(sources) {
  const scanned = new Map()
  const where = new Map()
  const declaring = new Map() // canonical type name -> the paths declaring it
  for (const [path, text] of [...sources].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const unit = scanJavaSource(text)
    scanned.set(path, unit)
    where.set(path, locate(path, unit.pkg))
    for (const type of unit.types) {
      const name = unit.pkg ? `${unit.pkg}.${type}` : type
      if (!declaring.has(name)) declaring.set(name, [])
      declaring.get(name).push(path)
    }
  }
  // The type here a qualified name names: its shortest prefix of two or more segments that is a
  // top-level type (`com.a.Outer` of `com.a.Outer.Inner.CONST`); undefined for none.
  const typeOf = (segments) => {
    let name = segments[0]
    for (let k = 1; k < segments.length; k++) {
      name += `.${segments[k]}`
      if (declaring.has(name)) return name
    }
    return undefined
  }

  const edges = new Map()
  for (const [path, { pkg, imports, declared, refs }] of scanned) {
    const specs = new Map()
    const edge = (name) => {
      if (name === undefined || specs.has(name)) return
      const files = declaring.get(name)
      if (files.includes(path)) return // its own type, under its full name
      specs.set(name, pick(path, files, where))
    }
    // Simple names the imports bind: a single-type import's (to its type here, or to undefined for
    // one elsewhere, which shadows this package's type of the name all the same), a single static
    // import's (a member of a type: the import is its edge); and the on-demand packages.
    const bound = new Set()
    const onDemand = []
    for (const { segments, isStatic, onDemand: star } of imports) {
      if (isStatic) {
        edge(typeOf(star ? segments : segments.slice(0, -1)))
        if (!star) bound.add(segments.at(-1))
      } else if (star) {
        // `a.b.*` imports a package's types, `a.b.Outer.*` a type's member types (Outer's file).
        const type = typeOf(segments)
        if (type === undefined) onDemand.push(segments.join('.'))
        else edge(type)
      } else {
        edge(typeOf(segments))
        bound.add(segments.at(-1))
      }
    }
    for (const segments of refs) {
      const [first] = segments
      if (declared.has(first) || bound.has(first)) continue
      const own = pkg ? `${pkg}.${first}` : first
      if (declaring.has(own)) {
        edge(own)
        continue
      }
      const imported = onDemand.map((p) => `${p}.${first}`).find((name) => declaring.has(name))
      edge(imported ?? typeOf(segments))
    }
    if (specs.size > 0) edges.set(path, specs)
  }
  return edges
}
