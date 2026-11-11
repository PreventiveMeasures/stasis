// Rust loader: `{ sources, resolutions, missing }` from a crate's files. Reachability follows rustc: a
// `mod` (`#[path]` and `#[cfg_attr(…, path)]` included) pulls a module file in, a reference to an in-tree
// crate (own lib, path dep, vendored) its root; a `use` resolves against the module tree, adding no file.

import { isUtf8 } from 'node:buffer'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'

import { assertRealPathWithinBase, memoized, nestedMap, relativeEscapes, toPosix, upsert } from '@exodus/stasis-core/util'
import { isFile } from '../resolve-typescript.js'
import { TARGET_CFG_KEYS, TARGET_UNIT, VENDOR_DIR, cfgName, createCargoContext, evalCfg, evalCfgKey, isTestTargetPath, normName, normalizeCfg, normalizeRel } from './cargo.js'
import { matchClose, splitTopLevel } from './toml.js'

// Leads of the expression-position paths anchored on the module tree rather than on a name.
const PATH_KEYWORDS = new Set(['crate', 'self', 'super'])

// Path keywords, and the sysroot crates every build links: a path whose lead is one of these
// never names an in-tree crate.
const NON_CRATE_LEADS = new Set([...PATH_KEYWORDS, 'std', 'core', 'alloc'])

// The other sysroot crates a program may name (`extern crate proc_macro;`, `test::Bencher`):
// never in-tree, so never worth reporting as unresolved.
const OTHER_SYSROOT_CRATES = new Set(['proc_macro', 'test'])

// Files rustc treats as crate roots by name; every entry is one by role (see crateRoots).
const ROOT_NAMES = new Set(['main.rs', 'lib.rs'])

// Cap on `mod`-chain depth when building a module tree: with the `seen` set it bounds cycles
// and the O(depth²) growth of joined module-path strings on absurd input.
const MAX_MODULE_DEPTH = 1000

const isWordChar = (ch) => ch !== undefined && /\w/u.test(ch)

// --- Lexing -----------------------------------------------------------------------------

// One pass over Rust source producing two views aligned with it offset for offset: `code` blanks
// comments, `masked` string and char literal contents too. Block comments nest; a `//` in a string is
// no comment and a `/*` in a `//` comment opens nothing -- which a pair of regexes gets wrong.
export function lexRust(content) {
  const n = content.length
  // Each view is built from chunks: the source up to a blanked range, then that range with each
  // line replaced by one space per UTF-16 unit, so indexes stay those of `content`.
  const code = []
  const masked = []
  let codeAt = 0
  let maskedAt = 0
  const blanks = (start, end) => content.slice(start, end).split('\n').map((line) => ' '.repeat(line.length)).join('\n')
  const blankMasked = (start, end) => {
    masked.push(content.slice(maskedAt, start), blanks(start, end))
    maskedAt = end
  }
  const blankBoth = (start, end) => {
    code.push(content.slice(codeAt, start), blanks(start, end))
    codeAt = end
    blankMasked(start, end)
  }

  let i = 0
  while (i < n) {
    const ch = content[i]
    if (ch === '/' && content[i + 1] === '/') {
      const eol = content.indexOf('\n', i)
      const end = eol === -1 ? n : eol
      blankBoth(i, end)
      i = end
      continue
    }
    if (ch === '/' && content[i + 1] === '*') {
      const start = i
      let depth = 0
      do {
        if (content[i] === '/' && content[i + 1] === '*') {
          depth++
          i += 2
        } else if (content[i] === '*' && content[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      } while (i < n && depth > 0)
      blankBoth(start, i)
      continue
    }
    const lit = stringStart(content, i)
    if (lit) {
      const start = lit.open + 1 // past the `b`/`c`/`r#` prefix and the opening quote
      if (lit.raw === null) {
        i = start
        while (i < n && content[i] !== '"') i += content[i] === '\\' ? 2 : 1 // an escape takes two
        blankMasked(start, Math.min(i, n))
        i++ // closing quote
      } else {
        const close = `"${'#'.repeat(lit.raw)}`
        let end = content.indexOf(close, start)
        if (end === -1) end = n
        blankMasked(start, end)
        i = end + close.length
      }
      continue
    }
    if (ch === "'") {
      const end = charLiteralEnd(content, i)
      if (end !== -1) {
        blankMasked(i + 1, end)
        i = end + 1
        continue
      }
    }
    i++
  }
  code.push(content.slice(codeAt))
  masked.push(content.slice(maskedAt))
  return { code: code.join(''), masked: masked.join('') }
}

// `{ open, raw }` when a string literal (with any `b`/`c` prefix and raw `r#…#` marker) starts at `i`:
// its opening quote's index and a raw string's `#` count (null for a plain one); else null. A prefix
// must not be the tail of an identifier (`bar"`).
function stringStart(content, i) {
  if (content[i] === '"') return { open: i, raw: null }
  let j = i
  if ((content[j] === 'b' || content[j] === 'c') && (content[j + 1] === '"' || content[j + 1] === 'r')) j++
  if (content[j] !== 'r' && content[j] !== '"') return null
  if (isWordChar(content[i - 1])) return null
  if (content[j] === '"') return { open: j, raw: null }
  let k = j + 1
  while (content[k] === '#') k++
  return content[k] === '"' ? { open: k, raw: k - j - 1 } : null
}

// Index of the quote closing a char literal opening at `i` (`'x'`, `'\n'`, `'\u{1F600}'`), or -1
// when the quote starts a lifetime/label (`'a`), which has no closing quote.
function charLiteralEnd(content, i) {
  if (content[i + 1] === '\\') {
    let j = i + 2
    if (content[j] === 'u' && content[j + 1] === '{') {
      const close = content.indexOf('}', j)
      if (close === -1 || close - j > 10) return -1
      j = close + 1
    } else {
      j += 1
    }
    return content[j] === "'" ? j : -1
  }
  if (content[i + 1] === undefined || content[i + 1] === "'") return -1
  if (content[i + 2] === "'") return i + 2
  // An astral char is two UTF-16 units.
  const cp = content.codePointAt(i + 1)
  return cp > 0xff_ff && content[i + 3] === "'" ? i + 3 : -1
}

// --- Item scanning ----------------------------------------------------------------------

const WORD_RE = /[A-Za-z_]\w*/uy
const WS_RE = /\s/u
// First words of an item or statement that runs to its `;` or `{ … }` body whatever commas it holds;
// anything else (a field, a variant, a match arm) ends at a top-level comma. Weak keywords a field
// may be named after (`default`, `union`) are left out on purpose.
const ITEM_KEYWORDS = new Set(['fn', 'impl', 'struct', 'enum', 'trait', 'type', 'const', 'static', 'mod', 'use', 'extern', 'macro_rules', 'unsafe', 'async', 'let'])
// Macros whose literal string argument names a file relative to the invoking one: Rust source
// spliced in (`include!`), or an asset embedded as text or bytes.
const INCLUDE_MACROS = new Set(['include', 'include_str', 'include_bytes'])
// Macros whose body is a template of code for some other crate (a proc macro's output): nothing
// in it is an item, import or path of the crate holding it.
const TEMPLATE_MACROS = new Set(['quote', 'quote_spanned', 'parse_quote', 'parse_quote_spanned'])
// An include macro's argument: a string literal (plain, with escapes, or raw with any number of
// `#`s), or `concat!(env!("CARGO_MANIFEST_DIR"), "<literal>")`, a path from the package root.
const STRING_LITERAL_RE = /^\s*(?:"((?:[^"\\]|\\[\s\S])*)"|r(#*)"([\s\S]*?)"\2)\s*$/u
const MANIFEST_DIR_CONCAT_RE = /^\s*concat!\s*\(\s*env!\s*\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*,\s*([\s\S]*?),?\s*\)\s*$/u
// An include macro opening inside an attribute's text: `#![doc = include_str!("../README.md")]`.
const INCLUDE_IN_ATTR_RE = /\b(include|include_str|include_bytes)!\s*(?=[([{])/gu
// Items a module defines by name, for `pub struct X` behind a glob; `mod`, `use`, `extern crate`
// and `macro_rules!` have their own records.
const DEFINING_KEYWORDS = new Set(['struct', 'enum', 'union', 'trait', 'type', 'fn', 'const', 'static'])
// Of those, the items in the value namespace: never a path's lead or prefix (a `fn log` beside
// `use log::info` hides no crate).
const VALUE_KEYWORDS = new Set(['fn', 'const', 'static'])

// The path an include macro's argument names: `{ path, base }` (`base`: `file` for a path relative
// to the invoking file, `manifest` for one from the package root), or null when it isn't one the
// loader can follow (`concat!(env!("OUT_DIR"), …)` is build output).
function includeArg(text) {
  const manifest = MANIFEST_DIR_CONCAT_RE.exec(text)
  const lit = STRING_LITERAL_RE.exec(manifest ? manifest[1] : text)
  if (!lit) return null
  const path = lit[1] === undefined ? lit[3] : unescapeString(lit[1])
  return manifest ? { path: path.replace(/^\/+/u, ''), base: 'manifest' } : { path, base: 'file' }
}

// The value of a plain string literal's body: `\\`, `\"`, `\'`, `\n`, `\r`, `\t`, `\0`,
// `\x41`, `\u{1F600}` and a backslash-newline continuation.
function unescapeString(body) {
  return body.replaceAll(/\\(?:u\{([0-9a-fA-F]{1,6})\}|x([0-9a-fA-F]{2})|\n\s*|(.))/gsu, (m, u, x, c) => {
    if (u !== undefined) return String.fromCodePoint(Number.parseInt(u, 16))
    if (x !== undefined) return String.fromCharCode(Number.parseInt(x, 16))
    if (c === undefined) return ''
    return { n: '\n', r: '\r', t: '\t', 0: '\0' }[c] ?? c
  })
}
const EXTERN_CRATE_RE = /extern\s+crate\s+(?:r#)?(\w+)(?:\s+as\s+(?:r#)?(\w+))?\s*;/uy
const MACRO_EXPORT_RE = /^\s*macro_export\s*(?:\([\s\S]*\))?\s*$/u
// Expression-position paths: any `lead::…` path whose lead is lowercase (skipping `Type::assoc`
// associated-item paths) -- a `crate`/`self`/`super` keyword path, or one led by a module or
// crate name. Runs over the masked view, so string contents can't fake one.
const LEAD_PATH_RE = /\b([a-z_]\w*)(?:::\w+)+/gu
const ATTR_PATH_RE = /^\s*path\s*=\s*"([^"]*)"\s*$/u

// Combine an item's cfg predicates (several `#[cfg]` attributes all apply) into one; null when ungated.
const joinCfgs = (preds) => (preds.length === 0 ? null : (preds.length === 1 ? preds[0] : `all(${preds.join(', ')})`))

const CFG_ATTR_RE = /^\s*cfg\s*\(([\s\S]*)\)\s*$/u

// One outer attribute's text (inside `#[…]`; `masked`: string contents blanked) → `cfg`, the predicate
// gating the item (`cfg_attr(<pred>, cfg(<inner>))` gates on `any(not(pred), inner)`); `paths`, the
// module files it names; `pred`, a `cfg_attr`'s own; the files its include macros name; macro flags.
function parseAttr(text, masked) {
  const includes = []
  for (const m of masked.matchAll(INCLUDE_IN_ATTR_RE)) {
    const open = m.index + m[0].length
    const arg = includeArg(text.slice(open + 1, matchClose(masked, open)))
    if (arg !== null) includes.push({ kind: m[1], ...arg })
  }
  const attr = (fields) => ({ cfg: null, paths: [], pred: null, includes, ...fields })
  if (MACRO_EXPORT_RE.test(text)) return attr({ macroExport: true })
  if (/^\s*macro_use\s*$/u.test(text)) return attr({ macroUse: true })
  const path = ATTR_PATH_RE.exec(text)
  if (path) return attr({ paths: [{ path: path[1], cfg: null }] })
  if (/^\s*test\s*$/u.test(text)) return attr({ cfg: 'test' })
  const cfg = CFG_ATTR_RE.exec(text)
  if (cfg) return attr({ cfg: normalizeCfg(cfg[1]) })
  const cfgAttr = /^\s*cfg_attr\s*\(([\s\S]*)\)\s*$/u.exec(text)
  if (!cfgAttr) return attr({})
  const parts = splitTopLevel(cfgAttr[1])
  const pred = normalizeCfg(parts.shift() ?? '')
  const paths = []
  const inner = []
  let macroExport = false
  for (const part of parts) {
    const m = ATTR_PATH_RE.exec(part)
    const c = CFG_ATTR_RE.exec(part)
    if (m) paths.push({ path: m[1], cfg: pred })
    else if (c) inner.push(normalizeCfg(c[1]))
    else if (MACRO_EXPORT_RE.test(part)) macroExport = true
  }
  return attr({ cfg: inner.length === 0 ? null : `any(not(${pred}), ${joinCfgs(inner)})`, paths, pred, macroExport })
}

// An attribute that applies nothing in this build (a `cfg_attr` whose predicate can't hold).
const INERT_ATTR = { cfg: null, paths: [], pred: null, includes: [] }

// The visibility a `pub(…)` restriction spells, from the text between its parentheses: `crate`,
// `self`, `super`, or `in <path>` (normalized to `in a::b`); a bare `pub` is `crate` -- the loader
// never follows a path into another crate's tree, so `pub` and `pub(crate)` are one to it.
function parseVisibility(restriction) {
  const r = restriction.trim().replaceAll(/\s+/gu, ' ')
  if (r === 'crate' || r === 'self' || r === 'super') return r
  if (r.startsWith('in ')) return `in ${r.slice(3).replaceAll(' ', '')}`
  return 'crate'
}

// Flatten a `use` tree body (between `use` and `;`) into `{ segments, absolute, spec, binding, glob }`
// per path: `a::{b::C, d::*}` → `a::b::C`, `a::d` (a glob); `self` in a group names the group's module,
// a leading `::` an external crate; `binding` is the name brought into scope (null for a glob or `_`).
export function parseUseTree(body) {
  const tokens = [...body.matchAll(/::|[{},*]|\bas\b|(?:r#)?\w+/gu)].map((m) => m[0])
  const out = []
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isIdent = (tok) => tok !== undefined && tok !== 'as' && /^(?:r#)?\w+$/u.test(tok)
  const emit = (segments, absolute, binding, glob) => {
    if (segments.length > 0) {
      out.push({ segments, absolute, spec: `${absolute ? '::' : ''}${segments.join('::')}`, binding: binding === '_' ? null : binding, glob })
    }
  }
  const parse = (prefix, absolute) => {
    let tok = peek()
    if (tok === '::' && prefix.length === 0) {
      next()
      absolute = true
      tok = peek()
    }
    if (tok === '{') {
      next()
      while (pos < tokens.length && peek() !== '}') {
        const before = pos
        parse(prefix, absolute)
        if (peek() === ',') next()
        if (pos === before) next() // malformed: make progress
      }
      next()
      return
    }
    if (tok === '*') {
      next()
      emit(prefix, absolute, null, true)
      return
    }
    if (!isIdent(tok)) return
    const segments = [...prefix]
    for (;;) {
      tok = next()
      if (!isIdent(tok)) return
      segments.push(tok.replace(/^r#/u, ''))
      if (peek() !== '::') break
      next()
      if (peek() === '{' || peek() === '*') {
        parse(segments, absolute)
        return
      }
    }
    let alias = null
    if (peek() === 'as') {
      next()
      alias = isIdent(peek()) ? next().replace(/^r#/u, '') : null
    }
    if (prefix.length > 0 && segments.length === prefix.length + 1 && segments.at(-1) === 'self') segments.pop()
    emit(segments, absolute, alias ?? segments.at(-1), false)
  }
  parse([], false)
  return out
}

// Statically scan one file's items, skipping whole each item whose cfg can never hold in the build
// (see evalCfg; `units`: one build per way the file is compiled): dead modules aren't bundled, nor what
// only dead code reaches. `templates`: macros whose bodies are another crate's code (quote!), skipped.
export function scanRustItems(content, { features = null, maybeFeatures = null, test = false, target = null, units = null, templates = TEMPLATE_MACROS } = {}) {
  const env = units === null ? { features, maybeFeatures, test, target } : { units: units.map((u) => ({ ...u, test })) }
  const { code, masked } = lexRust(content)
  const n = masked.length
  const mods = [] // `mod x;` declarations
  const uses = []
  const imports = [] // `use` items, and `extern crate`s as the imports they amount to; `vis` null: private
  const macros = [] // `macro_rules!` definitions
  const invocations = new Set() // the macros invoked by bare name outside templates
  const calls = new Map() // macro name → the offsets of its bare invocations, in order
  const pathInvocations = new Set() // the macros invoked by path (`crate::m!()`), by their last segment
  const callSites = new Map() // macro name → each invocation, bare or by path: `{ offset, inlinePath, inlineDirs }`
  const includes = []
  const defined = [] // items defined by name at module level: what a glob into the module brings in
  const skipped = new Set() // the template macros whose bodies were skipped
  let unfollowed = 0 // include macros whose argument names no file the loader can follow
  const useSpans = [] // [start, end) of each `use` item's body, parsed as a tree below
  const deadSpans = [] // [start, end) of each skipped test/doc-only item
  const externCrates = []
  const bindings = new Set() // names `use`s and `extern crate … as` bind: a path lead among them is no crate
  const spans = [] // closed inline module blocks: { start, end, path, vis }
  const stack = [] // open inline modules: { name, dir, depth, conditional, start, vis }
  // `impl`/`trait` bodies, `{ start, end, depth }`: a `fn`, `const` or `type` at their depth is an
  // associated item; what an `extern "C" { }` block declares is the module's. Both nest or lie apart
  // in source order, so each list is a stack the scan pops the blocks it has left off.
  const assocBlocks = []
  const foreignBlocks = []
  const openBlocks = (blocks, at) => {
    while (blocks.length > 0 && blocks.at(-1).end < at) blocks.pop()
    return blocks
  }
  // The `macro_rules!` names this file defines: a `quote!` of its own is no template.
  const localMacros = new Set([...masked.matchAll(/\bmacro_rules!\s*([A-Za-z_]\w*)/gu)].map((m) => m[1]))
  let depth = 0
  let pending = [] // parsed outer attributes (parseAttr) waiting for their item
  let attrStart = 0 // where the first pending attribute begins: a dead item is dead from there
  let visNext = null // the previous token was a `pub` visibility (parseVisibility): the coming item has it
  // Open blocks a live `#[cfg]` gates (`if #[cfg(unix)] { mod imp; }` in a `cfg_if!` body, a
  // `#[cfg(x)] mod m { … }`), whose contents it gates too; `scopeCfg` is their conjunction.
  const cfgScopes = []
  let scopeCfg = null
  const openScope = (d, cfg) => {
    cfgScopes.push({ depth: d, cfg })
    scopeCfg = joinCfgs(cfgScopes.map((s) => s.cfg))
  }
  const closeScopes = (d) => {
    if (cfgScopes.length === 0 || cfgScopes.at(-1).depth <= d) return
    while (cfgScopes.length > 0 && cfgScopes.at(-1).depth > d) cfgScopes.pop()
    scopeCfg = joinCfgs(cfgScopes.map((s) => s.cfg))
  }
  // Memoized: the open scopes' conjunction is asked at every token inside them.
  const verdict = memoized((pred) => evalCfg(pred, env))
  // The cfg of a `#[cfg(…)] name! { … }`: it gates the invocation, so everything the body
  // declares (mio's `#[cfg(unix)] cfg_os_poll! { mod unix; }`); taken up by the body's `{`.
  let macroBodyCfg = null
  // Open chains of cfg-gated branches (a `cfg_if!` body's `if #[cfg(a)] { … } else if #[cfg(b)] …`) by
  // the depth of their blocks → the cfgs of the branches so far: a branch is gated on `all(not(a), b)`.
  const chains = new Map()
  const wordBefore = (pos) => {
    let k = skipWsBack(pos - 1)
    const end = k + 1
    while (k >= 0 && isWordChar(masked[k])) k--
    return k + 1 < end ? { word: masked.slice(k + 1, end), start: k + 1 } : null
  }
  // The cfg a `{` at `i` opens a cfg chain's branch under (its own, `own`, and the negation of every
  // earlier branch's), recorded on the chain; null for any other block.
  const branchCfg = (i, own) => {
    const lead = wordBefore(pending.length > 0 ? attrStart : i)
    if (lead === null || (lead.word !== 'if' && lead.word !== 'else')) return null
    const continuing = lead.word === 'else' || wordBefore(lead.start)?.word === 'else'
    const negations = continuing ? chains.get(depth + 1) ?? [] : []
    if (own === null && negations.length === 0) return null
    chains.set(depth + 1, own === null ? negations : [...negations, own])
    return joinCfgs([...negations.map((c) => `not(${c})`), ...(own === null ? [] : [own])])
  }
  // After a branch block at `blockDepth` closed at `end`: its chain goes on only if an `else` follows.
  const endBranch = (end, blockDepth) => {
    if (chains.has(blockDepth) && readWord(skipWs(end)) !== 'else') chains.delete(blockDepth)
  }
  // End of the outermost macro invocation body being scanned, and its macro's name. A `mod x;` there
  // is an item only if the macro emits it, so it is followed when its file exists and tolerated when
  // not, like a `#[cfg]`-gated one; the name stands for the cfg it is emitted under (`cfg_x! { … }`).
  let macroUntil = -1
  let macroName = null
  // The top-level `macro_rules!` whose body the scan is in (its name, and its definition). What its
  // body declares (serde's `crate_root! { … mod de; … }`) appears where the macro is invoked.
  let templateName = null
  let templateMacro = null
  // The `macro_rules!` bodies the scan is in, `{ macro, end, depth }`: what a nested one's body calls,
  // includes and declares is that one's; `depth`, the inline modules around its definition.
  const defs = []
  const innermostEntry = (at) => openBlocks(defs, at).at(-1)
  const innermostDef = (at) => innermostEntry(at)?.macro ?? templateMacro

  // Whether the token at `at` sits in a `macro_rules!` body: a template, expanded where invoked.
  const inTemplate = (at) => at < macroUntil && macroName === 'macro_rules'
  // Whether what is declared at `at` under `cfg` may not exist as an item: a cfg not known to
  // hold, an inline module so gated around it, or a macro invocation's body.
  const conditionalAt = (cfg, at) => (cfg !== null && verdict(cfg) !== true) || stack.some((s) => s.conditional) || at < macroUntil
  const inlinePath = () => stack.map((s) => s.name)
  const inlineDirs = () => stack.map((s) => s.dir)
  const closeTo = (targetDepth, at) => {
    while (stack.length > 0 && stack.at(-1).depth > targetDepth) {
      const top = stack.pop()
      spans.push({ start: top.start, end: at, path: [...inlinePath(), top.name], vis: top.vis })
    }
  }
  const isAssociated = (at, d) => openBlocks(assocBlocks, at).some((b) => b.start < at && b.depth === d)
  // Whether an item at `at` is at its module's own level: the module body (a file's, an inline
  // module's), a `#[cfg]`-gated block or an `extern "C" { }` block there, or a macro invocation's
  // body (libc's `s! { … }`); not a `fn` body.
  const atModuleLevel = (at) => {
    if (at < macroUntil) return true
    const base = stack.length > 0 ? stack.at(-1).depth : 0
    return depth === base || cfgScopes.some((s) => s.depth === depth) || openBlocks(foreignBlocks, at).some((b) => b.start < at && b.depth === depth)
  }
  // The `{` opening the body of the item starting at `from` (an `impl`/`trait` header may hold
  // generics, bounds and a `where` clause), or -1 when a `;` ends it first.
  const bodyOpen = (from) => {
    let nest = 0
    for (let k = from; k < n; k++) {
      const ch = masked[k]
      if (ch === '(' || ch === '[' || ch === '<') nest++
      else if (ch === ')' || ch === ']' || (ch === '>' && masked[k - 1] !== '-' && masked[k - 1] !== '=')) nest = Math.max(0, nest - 1)
      else if (nest === 0 && ch === '{') return k
      else if (nest === 0 && ch === ';') return -1
    }
    return -1
  }
  const readWord = (at) => {
    WORD_RE.lastIndex = at
    const m = WORD_RE.exec(masked)
    return m ? m[0] : null
  }
  const skipWs = (at) => {
    while (at < n && WS_RE.test(masked[at])) at++
    return at
  }
  const skipWsBack = (at) => {
    while (at >= 0 && WS_RE.test(masked[at])) at--
    return at
  }
  // The end of the item at `from` within its block: through a top-level `;` or `{ … }` body, or a
  // top-level `,` unless `itemLike`; `(`, `[` and generics (a `<` after a name or `::`) nest. A dead `if`
  // (`elseChain`) takes its `else`s along, a dead bare block doesn't; a `let` runs to its `;`.
  const skipItem = (from, itemLike, { elseChain, toSemicolon }) => {
    let nest = 0
    let angle = 0
    for (let k = from; k < n; k++) {
      const ch = masked[k]
      if (ch === '(' || ch === '[') nest++
      else if (ch === ')' || ch === ']') {
        if (--nest < 0) return k
      } else if (nest === 0) {
        if (ch === ';') return k + 1
        if (ch === '}') return k
        if (ch === '{') {
          const close = matchClose(masked, k)
          if (toSemicolon) {
            k = close
            continue
          }
          const after = skipWs(close + 1)
          if (!elseChain || readWord(after) !== 'else') return close + 1
          k = after + 3
          continue
        }
        if (ch === '<' && (angle > 0 || isWordChar(masked[k - 1]) || masked[k - 1] === ':')) angle++
        else if (ch === '>' && angle > 0 && masked[k - 1] !== '-' && masked[k - 1] !== '=') angle--
        else if (ch === ',' && angle === 0 && !itemLike) return k + 1
      }
    }
    return n
  }

  let i = 0
  while (i < n) {
    const ch = masked[i]
    if (WS_RE.test(ch)) {
      i++
      continue
    }
    if (i >= macroUntil) macroName = null
    if (ch === '#' && (masked[i + 1] === '[' || (masked[i + 1] === '!' && masked[i + 2] === '['))) {
      const outer = masked[i + 1] === '['
      const open = outer ? i + 1 : i + 2
      const close = matchClose(masked, open)
      const attr = parseAttr(code.slice(open + 1, close), masked.slice(open + 1, close))
      if (outer) {
        // `#[cfg_attr(<pred>, derive(serde::Serialize))]` with pred never holding applies nothing:
        // the paths in its text are dead code too, and so is whatever else it would apply.
        const inert = attr.pred !== null && verdict(attr.pred) === false
        if (inert) deadSpans.push([i, close + 1])
        if (pending.length === 0) attrStart = i
        pending.push(inert ? INERT_ATTR : attr)
      } else {
        // An inner `#![…]` applies to the enclosing module: a `#![cfg]` that can't hold empties it, the
        // whole file at the top, else the inline module it opens (in a macro body, the macro's affair).
        if (attr.cfg !== null && verdict(attr.cfg) === false && i >= macroUntil) {
          if (depth === 0) return { mods: [], refs: [], externCrates: [], bindings: new Set(), imports: [], macros: [], invocations: new Set(), calls: new Map(), pathInvocations: new Set(), callSites: new Map(), includes: [], unfollowed: 0, defined: [], inlineModules: [], inlineModuleVis: new Map(), skipped }
          const top = stack.at(-1)
          if (top !== undefined && top.depth === depth) {
            const end = matchClose(masked, top.start - 1)
            deadSpans.push([i, end])
            pending = []
            i = end
            continue
          }
        }
        // `#![doc = include_str!("../README.md")]`: the module's own include, applied here.
        const conditional = conditionalAt(null, i)
        for (const inc of attr.includes) includes.push({ ...inc, conditional })
        pending = []
      }
      i = close + 1
      continue
    }
    // The cfg gating the item the pending attributes belong to, every enclosing block's included; a
    // `pub`'s attributes stay pending for the keyword after it.
    const word = readWord(i)
    const attrCfg = word === 'pub' ? null : joinCfgs(pending.map((a) => a.cfg).filter((c) => c !== null))
    // A `{` opening a branch of a cfg chain is gated on the earlier branches' cfgs not holding too.
    const own = ch === '{' ? branchCfg(i, attrCfg) ?? attrCfg : attrCfg
    const cfg = own === null ? scopeCfg : joinCfgs([...cfgScopes.map((s) => s.cfg), own])
    // An item gated on a cfg that never holds is dead code: skipped whole, from its first attribute
    // through its `;`, its `,` (a field, variant or arm) or its block's `}`, whatever token starts it.
    if (cfg !== null && verdict(cfg) === false) {
      pending = []
      visNext = null
      const end = skipItem(word === null ? i : i + word.length, word !== null && ITEM_KEYWORDS.has(word), { elseChain: ch !== '{', toSemicolon: word === 'let' })
      deadSpans.push([attrStart, end])
      if (ch === '{') endBranch(end, depth + 1)
      i = end
      continue
    }
    // The item is live, so the includes its attributes name (`#[doc = include_str!("docs/x.md")]`)
    // are too; a `pub` keeps them pending for the keyword after it.
    if (word !== 'pub' && pending.length > 0) {
      const conditional = conditionalAt(cfg, i)
      for (const a of pending) {
        for (const inc of a.includes) includes.push({ ...inc, conditional })
        a.includes = []
      }
    }
    if (ch === '{') {
      depth++
      const gate = own ?? macroBodyCfg
      macroBodyCfg = null
      if (gate !== null) openScope(depth, gate)
      pending = []
      i++
      continue
    }
    if (ch === '}') {
      depth--
      closeTo(depth, i)
      closeScopes(depth)
      endBranch(i + 1, depth + 1)
      pending = []
      i++
      continue
    }
    const vis = visNext
    visNext = null
    if (word === null) {
      pending = []
      i++
      continue
    }
    // `name!` followed by a bracket opens a macro invocation body (`macro_rules! name` too).
    const bang = skipWs(i + word.length)
    if (masked[bang] === '!') {
      let open = skipWs(bang + 1)
      let definition = null // the `macro_rules!` this word defines
      if (word === 'macro_rules') {
        const name = readWord(open)
        if (name !== null) {
          open = skipWs(open + name.length)
          const gate = GATE_MACRO_RE.test(name) && masked[open] === '{' ? gatePredicate(code, masked, open, matchClose(masked, open)) : undefined
          definition = { name, exported: pending.some((a) => a.macroExport === true), includes: [], calls: new Set(), pathCalls: new Set(), offset: i, at: i, template: inTemplate(i) ? templateName : null, gate, cfg, macro: i < macroUntil ? macroName : null }
          macros.push(definition)
          if (i >= macroUntil) {
            templateName = name
            templateMacro = definition
          }
        }
      }
      if (masked[open] === '{' || masked[open] === '(' || masked[open] === '[') {
        const close = matchClose(masked, open)
        // A `macro_rules!` with no name defines no macro (rustc refuses it), so nothing in it is declared.
        if (word === 'macro_rules' && definition === null) {
          deadSpans.push([i, close + 1])
          pending = []
          i = close + 1
          continue
        }
        if (definition !== null) {
          openBlocks(defs, i)
          defs.push({ macro: definition, end: close, depth: stack.length })
        }
        if (templates.has(word) && !localMacros.has(word)) {
          // serde_derive's `quote! { use #path as _serde; … _serde::__private::Ok(…) }`, bare or as
          // `quote::quote! { … }`: skipped whole. (A crate's own `macro_rules! quote` is no template.)
          deadSpans.push([i, close + 1])
          skipped.add(word)
          pending = []
          i = close + 1
          continue
        }
        if (i >= macroUntil) macroName = word
        // (A cfg on a `macro_rules!` definition gates the definition, not what its template
        // declares wherever it is invoked -- an approximation kept from before.)
        if (own !== null && masked[open] === '{' && word !== 'macro_rules') macroBodyCfg = own
        if (word !== 'macro_rules') {
          // A call by path (`crate::m!()`) resolves no name in scope, but its template is expanded
          // there all the same. A call in a template is the definition's, made where that is
          // invoked; any other is kept with its inline modules (`callSites`).
          const def = inTemplate(i) && templateMacro !== null ? innermostDef(i) : null
          const pathQualified = masked[i - 1] === ':' && masked[i - 2] === ':'
          if (def !== null) (pathQualified ? def.pathCalls : def.calls).add(word)
          else {
            if (pathQualified) pathInvocations.add(word)
            else {
              invocations.add(word)
              upsert(calls, word, () => []).push(i)
            }
            upsert(callSites, word, () => []).push({ offset: i, inlinePath: inlinePath(), inlineDirs: inlineDirs() })
          }
          if (INCLUDE_MACROS.has(word)) {
            const text = code.slice(open + 1, close)
            const arg = includeArg(text)
            // In a `macro_rules!` body the path is relative to each file invoking the macro. Build
            // output (`OUT_DIR`) is nobody's to follow; any other unreadable argument is counted.
            if (arg === null) unfollowed += /\bOUT_DIR\b/u.test(text) ? 0 : 1
            else if (def !== null) def.includes.push({ kind: word, ...arg })
            else includes.push({ kind: word, ...arg, conditional: conditionalAt(cfg, i) })
          }
        }
        macroUntil = Math.max(macroUntil, close)
      }
    }
    // An `impl`/`trait` body holds associated items, an `extern "C" { }` block the module's own
    // (an `extern "C" fn f() { }` is a fn, with a body of its own).
    if (word === 'impl' || word === 'trait') {
      const open = bodyOpen(i + word.length)
      if (open !== -1) assocBlocks.push({ start: open, end: matchClose(masked, open), depth: depth + 1 })
    } else if (word === 'extern' && readWord(bang) !== 'crate') {
      let k = bang
      if (masked[k] === '"') k = skipWs(masked.indexOf('"', k + 1) + 1)
      if (masked[k] === '{') foreignBlocks.push({ start: k, end: matchClose(masked, k), depth: depth + 1 })
    }
    // An item the module defines by name (in a macro body or `extern "C" { }` block too) at module
    // level: no `fn`'s local, associated or template item, nor a `*const T` pointer type; `const fn`,
    // `static mut` and `static ref` define no `fn`, `mut` or `ref`.
    if (DEFINING_KEYWORDS.has(word) && atModuleLevel(i) && !isAssociated(i, depth) && !inTemplate(i) && !(word === 'const' && masked[skipWsBack(i - 1)] === '*')) {
      let at = skipWs(i + word.length)
      if (masked.startsWith('mut ', at) || masked.startsWith('ref ', at)) at = skipWs(at + 3)
      if (masked.startsWith('r#', at)) at += 2
      const name = readWord(at)
      const next = name === null ? null : masked[skipWs(at + name.length)]
      // `ns`: a `fn`, `const` or `static` is a value, which leads no path (`fn log` hides no crate).
      if (name !== null && !ITEM_KEYWORDS.has(name) && (word !== 'union' || next === '{' || next === '<')) defined.push({ name, inlinePath: inlinePath(), vis, cfg, macro: i < macroUntil ? macroName : null, ns: VALUE_KEYWORDS.has(word) ? 'value' : 'type' })
    }
    if (word === 'pub') {
      // Visibility sits between an item's attributes and its keyword; `pub(crate)` etc. included.
      i = skipWs(i + 3)
      visNext = 'crate'
      if (masked[i] === '(') {
        const close = matchClose(masked, i)
        visNext = parseVisibility(masked.slice(i + 1, close))
        i = close + 1
      }
      continue
    }
    if (word === 'mod') {
      let j = skipWs(i + 3)
      if (masked.startsWith('r#', j)) j += 2
      const name = readWord(j)
      if (name === null) {
        pending = []
        i = j
        continue
      }
      const k = skipWs(j + name.length)
      const attrs = pending
      pending = []
      // Dead cfgs were skipped above; a decidable-true one (`not(test)`) is as firm as no cfg at all.
      const conditional = conditionalAt(cfg, i)
      if (masked[k] === ';') {
        // rustc applies the first `#[path]` / `#[cfg_attr(<pred>, path)]` whose predicate holds: one
        // that can't hold names nothing; one that holds ends the list, and the default lookup is off.
        const live = attrs.flatMap((a) => a.paths).filter((p) => p.cfg === null || verdict(p.cfg) !== false)
        const applies = live.findIndex((p) => p.cfg === null || verdict(p.cfg) === true)
        const paths = applies === -1 ? live : (applies === 0 ? [{ path: live[0].path, cfg: null }] : live.slice(0, applies + 1))
        mods.push({
          name, inlinePath: inlinePath(), inlineDirs: inlineDirs(), cfg, conditional, paths, noDefault: applies !== -1, vis,
          macroUse: attrs.some((a) => a.macroUse === true), macro: i < macroUntil ? macroName : null, offset: i, at: i,
          template: inTemplate(i) ? innermostDef(i).name : null, templateDepth: inTemplate(i) ? innermostEntry(i)?.depth ?? 0 : 0,
        })
        i = k + 1
        continue
      }
      if (masked[k] === '{') {
        // `#[path = "dir"] mod m { mod a; }` finds `a` under `dir/`, not `m/`; solana-program's
        // `#[path = ""] mod non_bpf_modules { mod account_keys; }` right beside the file.
        const dir = attrs.flatMap((a) => a.paths).find((p) => p.cfg === null)?.path ?? name
        depth++
        if (own !== null) openScope(depth, own)
        stack.push({ name, dir, depth, conditional, start: k + 1, vis })
        i = k + 1
        continue
      }
      i = k
      continue
    }
    if (word === 'use') {
      const end = masked.indexOf(';', i + 3)
      const stop = end === -1 ? n : end
      const body = code.slice(i + 3, stop)
      // A tree starts with a name, `::`, `{` or (in a template) `$crate`: anything else is the word in
      // macro input (`Token![use]`), and one interpolating a metavariable (`use $m::X;`, quote's `#path`;
      // `r#` is none) is code the loader can't place. Neither is an import of this file.
      if (!/^\s*[A-Za-z_{:$]/u.test(body) || /(?<!\br)#|\$(?!crate\b)/u.test(body)) {
        pending = []
        i += 3
        continue
      }
      const ip = inlinePath()
      const macro = i < macroUntil ? macroName : null
      // `use $crate::…` in a `macro_rules!` template imports into whichever module invokes the macro.
      const template = macro === 'macro_rules' && /\$crate\b/u.test(body)
      for (const p of parseUseTree(body)) {
        uses.push({ ...p, inlinePath: ip })
        const im = { segments: p.segments, absolute: p.absolute, binding: p.binding, glob: p.glob, inlinePath: ip, vis, cfg, macro, template }
        imports.push(im)
        if (hidesCrate(im)) bindings.add(p.binding)
      }
      useSpans.push([i, stop])
      pending = []
      i = stop + 1
      continue
    }
    if (word === 'extern') {
      EXTERN_CRATE_RE.lastIndex = i
      const m = EXTERN_CRATE_RE.exec(masked)
      if (m) {
        const ip = inlinePath()
        externCrates.push({ name: m[1], alias: m[2] ?? null, inlinePath: ip, macroUse: pending.some((a) => a.macroUse === true) })
        pending = []
        if (m[2] !== undefined) bindings.add(m[2])
        // `extern crate self as x;` names this crate's root; any other, a crate by its own name.
        const selfCrate = m[1] === 'self'
        imports.push({ segments: [selfCrate ? 'crate' : m[1]], absolute: !selfCrate, binding: m[2] ?? m[1], glob: false, inlinePath: ip, vis, cfg, macro: i < macroUntil ? macroName : null })
        i = EXTERN_CRATE_RE.lastIndex
        continue
      }
    }
    pending = []
    i += word.length
  }
  closeTo(0, n)
  // A `mod` or `macro_rules!` a `macro_rules!` template declares stands where the macro is first
  // invoked here (serde's `crate_root! { … macro_rules! tri { … } … mod de; … }`).
  for (const m of [...mods, ...macros]) if (m.template !== null) m.offset = calls.get(m.template)?.[0] ?? Infinity

  // Innermost inline module enclosing an offset (spans nest, so the longest path wins).
  const inlineAt = (offset) => {
    let best = null
    for (const s of spans) {
      if (s.start <= offset && offset < s.end && (best === null || s.path.length > best.path.length)) best = s
    }
    return best ? best.path : []
  }
  const refs = new Map()
  // `fromUse` marks a path written in a `use` item -- the reliable signal that its lead names a
  // crate (an expression path's lead is as likely a module or an imported item). `macroCall`
  // marks an invoked path (`$crate::span!(…)`): it names a macro, not the module of that name.
  const addRef = (spec, segments, absolute, ip, fromUse, macroCall) => {
    const key = `${ip.join('::')}\0${spec}\0${macroCall ? '!' : ''}`
    if (!refs.has(key)) refs.set(key, { spec, segments, absolute, inlinePath: ip, fromUse, macroCall })
  }
  for (const u of uses) addRef(u.spec, u.segments, u.absolute, u.inlinePath, true, false)
  // Expression-position paths, outside `use` items (the tree parser's) and skipped items (a test's
  // `quickcheck::quickcheck(…)` must not pull the dev-dependency in): those spans blanked, offsets kept.
  let exprs = ''
  let at = 0
  for (const [start, end] of [...useSpans, ...deadSpans].toSorted((a, b) => a[0] - b[0])) {
    const from = Math.max(start, at)
    if (end <= from) continue
    exprs += masked.slice(at, from) + ' '.repeat(end - from)
    at = end
  }
  exprs += masked.slice(at)
  // Keyword paths (`crate::`/`self::`/`super::`) first, then paths led by a module or crate name.
  const keywordPaths = []
  const leadPaths = []
  for (const m of exprs.matchAll(LEAD_PATH_RE)) {
    // `$trait::fmt(…)` in a `macro_rules!` template: the lead is a metavariable, not a name;
    // `$crate::…` is the one interpolation that names something (this crate).
    if (exprs[m.index - 1] === '$' && m[1] !== 'crate') continue
    if (PATH_KEYWORDS.has(m[1])) keywordPaths.push(m)
    else if (!NON_CRATE_LEADS.has(m[1])) leadPaths.push(m)
  }
  for (const m of [...keywordPaths, ...leadPaths]) {
    let after = m.index + m[0].length
    while (after < n && WS_RE.test(exprs[after])) after++
    const macroCall = exprs[after] === '!' && exprs[after + 1] !== '='
    addRef(m[0], m[0].split('::'), false, inlineAt(m.index), false, macroCall)
  }
  const inlineModuleVis = new Map()
  for (const s of spans) if (!inlineModuleVis.has(s.path.join('::'))) inlineModuleVis.set(s.path.join('::'), s.vis)
  const inlineModules = [...inlineModuleVis.keys()].map((p) => p.split('::'))
  return { mods, refs: [...refs.values()], externCrates, bindings, imports, macros, invocations, calls, pathInvocations, callSites, includes, unfollowed, defined, inlineModules, inlineModuleVis, skipped }
}

// Whether a `use` import binds a name that is not the crate of that name: `use std::io;` binds
// `io`, but `use serde_json;` / `use rand::{self, Rng};` bind the crate itself under its own name.
const hidesCrate = (im) => im.binding !== null && (im.segments.length > 1 || im.binding !== im.segments[0])

// --- Module files -----------------------------------------------------------------------

// Directory holding this file's submodules, per Rust's path rules: siblings for crate roots, mod.rs
// and files a `#[path]` loads (rustc treats those like mod.rs), else a `<stem>/` subdir. `root` marks a
// crate root by role (an entry such as `src/bin/tool.rs` or `tests/it.rs`) rather than by name.
export function getModuleDir(filePath, { root = false } = {}) {
  const lastSlash = filePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : filePath.slice(0, lastSlash)
  const name = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)
  if (root || ROOT_NAMES.has(name) || name === 'mod.rs') return dir
  const stem = name.replace(/\.rs$/u, '')
  return dir ? `${dir}/${stem}` : stem
}

// Whether `file` owns its directory for submodule lookup: a crate root by role, or a file a
// `#[path]` attribute loaded (`pathLoaded`).
const ownsDir = (file, { roots, pathLoaded }) => roots?.has(file) === true || pathLoaded?.has(file) === true

function firstFile(candidates, { knownSources, baseDir }) {
  if (knownSources) return candidates.find((c) => knownSources.has(c)) ?? null
  if (baseDir) return candidates.find((c) => isFile(join(baseDir, c))) ?? null
  return null
}

// Resolve `mod <name>;` declared in `fromFile` (inside inline modules `inlinePath`): `<dir>/<name>.rs`,
// then `<dir>/<name>/mod.rs`. A file owning its directory (ownsDir) tries the `<stem>/` rule after, so a
// glob-listed module file, or one a plain `mod` mounts besides a `#[path]`, still resolves.
export function resolveModPath(modName, fromFile, { knownSources, baseDir, roots, pathLoaded, inlinePath = [], boundary = null } = {}) {
  const owns = ownsDir(fromFile, { roots, pathLoaded })
  const dirs = [getModuleDir(fromFile, { root: owns })]
  if (owns) dirs.push(getModuleDir(fromFile)) // the same dir for main.rs/lib.rs/mod.rs
  for (const dir of new Set(dirs)) {
    // An inline module's `#[path = "…"]` may climb (`..`): normalized, and held to `boundary`
    // like any explicit path (resolveExplicitModPath).
    const base = normalizeRel(dir, [...inlinePath, modName].filter(Boolean).join('/'))
    if (base === null || (boundary !== null && !withinDir(base, boundary))) continue
    const found = firstFile([`${base}.rs`, `${base}/mod.rs`], { knownSources, baseDir })
    if (found) return found
  }
  return null
}

// Resolve a `#[path = "…"]` target the way rustc does: relative to the declaring file's directory,
// or -- inside inline modules -- to the file's module dir plus the inline module names. Absolute
// or root-escaping paths resolve to nothing (a read would refuse them anyway).
export function resolveExplicitModPath(explicitPath, fromFile, { knownSources, baseDir, roots, pathLoaded, inlinePath = [], boundary = null } = {}) {
  const dir = inlinePath.length === 0
    ? posix.dirname(fromFile)
    : [getModuleDir(fromFile, { root: ownsDir(fromFile, { roots, pathLoaded }) }), ...inlinePath].filter(Boolean).join('/')
  const rel = normalizeRel(dir, explicitPath)
  if (rel === null || (boundary !== null && !withinDir(rel, boundary))) return null
  return firstFile([rel], { knownSources, baseDir })
}

// Whether project-relative `rel` lies in directory `dir` (`.`: anywhere in the bundle root).
const withinDir = (rel, dir) => dir === '.' || rel === dir || rel.startsWith(`${dir}/`)

// Whether the file at project-relative `rel` really lies in directory `within` (`.`: anywhere in the
// bundle root): a vendored crate's file linked out of its package (to the project's `.env`, say) is
// refused, warned as `who`'s. `realDirs` keeps the directories' real paths.
export function withinRealDir(baseDir, rel, within, { who = 'loader.rust', realDirs = new Map() } = {}) {
  if (within === '.') return true
  if (!realDirs.has(within)) realDirs.set(within, realpathSync(join(baseDir, within)))
  const back = toPosix(relative(realDirs.get(within), realpathSync(join(baseDir, rel))))
  if (!relativeEscapes(back)) return true
  console.warn(`[${who}] Refusing file outside its package: ${rel} (a link out of ${within})`)
  return false
}

// The directory a file's `#[path]`, include and build-script paths may reach into: a vendored crate's
// package (`vendor/<crate>`), as a published crate never names a file outside it; anywhere in the
// bundle root (`.`) for the project's own code (root package, workspace members, path dependencies).
export function boundaryOf(file, ctx) {
  return ctx?.isVendored(file) === true ? ctx.packageInfo(file).dir : '.'
}

// Resolve an include macro's argument (`{ kind, path, base }`) named in `file`: relative to the file, or
// to its package's root for a `CARGO_MANIFEST_DIR` path; null when it escapes the bundle root, or a
// vendored crate's package (boundaryOf).
function includeTarget(inc, file, ctx) {
  const dir = inc.base === 'manifest' ? ctx?.packageInfo(file)?.dir ?? null : posix.dirname(file)
  if (dir === null) return null
  const rel = normalizeRel(dir, inc.path)
  if (rel === null || !withinDir(rel, boundaryOf(file, ctx))) {
    console.warn(`[loader.rust] Refusing include outside its package: ${inc.path} from ${file}`)
    return null
  }
  return rel
}

// Every file a `mod` declaration can denote, `{ cfg, file, explicit }`: an unconditional `#[path]`'s;
// else each `#[cfg_attr(<pred>, path)]`'s under its predicate, then the default lookup's (`cfg` null).
// `explicit`: a `#[path]` named it. Inline modules contribute their directories (`inlineDirs`).
export function resolveModDecl(decl, fromFile, opts = {}) {
  const o = { ...opts, inlinePath: decl.inlineDirs ?? decl.inlinePath }
  const unconditional = decl.paths.find((p) => p.cfg === null)
  if (unconditional) {
    const file = resolveExplicitModPath(unconditional.path, fromFile, o)
    return file ? [{ cfg: null, file, explicit: true }] : []
  }
  const out = []
  for (const { path, cfg } of decl.paths) {
    const file = resolveExplicitModPath(path, fromFile, o)
    if (file && !out.some((x) => x.file === file)) out.push({ cfg, file, explicit: true })
  }
  // A variant that always applies (`decl.noDefault`) leaves no build for the default lookup.
  const fallback = decl.noDefault === true ? null : resolveModPath(decl.name, fromFile, o)
  if (fallback && !out.some((x) => x.file === fallback)) out.push({ cfg: null, file: fallback, explicit: false })
  return out
}

// Resolve a crate name to its vendored root (`vendor/<dir>/src/lib.rs`) among already-loaded
// sources, or null. `use` names underscore but the vendor dir may hyphenate, so try both.
export function resolveVendoredCrate(crateName, { knownSources } = {}) {
  const norm = normName(crateName)
  for (const dir of new Set([norm, norm.replaceAll('_', '-')])) {
    const lib = `${VENDOR_DIR}/${dir}/src/lib.rs`
    if (knownSources?.has(lib)) return lib
  }
  return null
}

// --- Module trees -----------------------------------------------------------------------

// The files walked as crate roots: every main.rs/lib.rs and manifest lib target, then every loaded
// entry. Roots by name or manifest come first, so their trees claim the files they reach
// (buildModuleTrees) before a glob-listed module file, an entry only by role, claims itself.
export function crateRoots(sources, explicit = [], cargo = null) {
  const roots = new Set()
  for (const path of sources.keys()) {
    if (ROOT_NAMES.has(path.slice(path.lastIndexOf('/') + 1)) || cargo?.isLibRoot(path) === true) roots.add(path)
  }
  for (const r of explicit) if (sources.has(r)) roots.add(r)
  return roots
}

// One module tree per crate root (`trees`: root → Map<modulePath, file>), following `mod` edges
// breadth-first, and `files`: file → `{ root, modulePath, leaves, parent, roots }`, the first root to
// reach it claiming it; `leaves`: the cfg leaves of the `mod`s down to it (mountCfgs, gates, variants).
export function buildModuleTrees(sources, resolutions, roots, inlineModules = null, mountCfgs = null, gatesOf = null) {
  const trees = new Map()
  const files = new Map()
  const mountLeaves = (decls, path) => (decls === undefined ? [] : anyOf(decls.map(({ cfg, macro, via }) => [...cfgLeaves(cfg), ...gateLeaves(macro, gatesOf?.(path)), ...mountLeaves(via, path)])))
  for (const root of roots) {
    if (!sources.has(root)) continue
    const tree = new Map([['crate', root]])
    trees.set(root, tree)
    const seen = new Set()
    const queue = [[root, 'crate', 0, [], null]]
    for (let qi = 0; qi < queue.length; qi++) {
      const [path, modulePath, depth, leaves, parent] = queue[qi]
      if (!files.has(path)) files.set(path, { root, modulePath, leaves, parent, roots: new Set() })
      files.get(path).roots.add(root)
      if (seen.has(path) || depth >= MAX_MODULE_DEPTH) continue
      seen.add(path)
      // `spec`'s module `sub` on each file of `target` (its variants); the tree keeps the first.
      const mount = (spec, sub, target) => {
        const variants = target instanceof Map ? [...target] : [['*', target]]
        for (const [key, file] of variants) {
          if (!tree.has(sub)) tree.set(sub, file)
          const variant = variants.length > 1 ? [{ key: 'variant', site: sub, value: key.replace(/#\d+$/u, ''), neg: false }] : []
          queue.push([file, sub, depth + 1, [...leaves, ...mountLeaves(mountCfgs?.get(path)?.get(spec)?.get(file), path), ...variant], path])
        }
      }
      // Each prefix of `segments` (`a`, `a::b`, …) below this module: an inline module whose body
      // lives in this file.
      const claimInline = (segments) => {
        for (let k = 1; k <= segments.length; k++) {
          const key = `${modulePath}::${segments.slice(0, k).join('::')}`
          if (!tree.has(key)) tree.set(key, path)
        }
      }
      // Module files first, then the inline modules that hold nested declarations, then the other
      // inline modules: a `mod imp;` file beats a `mod imp { … }` of the same name however the
      // declarations are ordered.
      const specs = [...(resolutions.get(path) ?? [])]
      for (const [spec, target] of specs) {
        if (spec.startsWith('mod ') && !spec.includes('::')) mount(spec, `${modulePath}::${spec.slice(4)}`, target)
      }
      for (const [spec, target] of specs) {
        // An `include!`d file's tokens are this module's: it is walked under the same module path.
        if (spec.startsWith('include ')) queue.push([target, modulePath, depth + 1, leaves, path])
        else if (spec.startsWith('mod ') && spec.includes('::')) {
          // `mod a::b::name`: `a` and `a::b` are inline modules whose bodies live in this file, so
          // paths into them (`a::b::x`, `super::` from `name`) resolve to it.
          claimInline(spec.slice(4).split('::').slice(0, -1))
          mount(spec, `${modulePath}::${spec.slice(4)}`, target)
        }
      }
      for (const inline of inlineModules?.get(path) ?? []) claimInline(inline)
    }
  }
  return { trees, files }
}

// The crate a path's lead may name: null for a path keyword or a sysroot crate, and -- unless the
// path is absolute (`::name::…`) -- for a name the file imported (`bindings`: `use std::io;
// io::stdin()` names no crate `io`).
const crateLead = ({ segments, absolute }, bindings) => {
  const head = segments[0]
  return head === undefined || NON_CRATE_LEADS.has(head) || (!absolute && bindings.has(head)) ? null : head
}

// --- Path resolution ------------------------------------------------------------------------

// A path resolves module by module through its crate's tree, a segment naming no module provided by
// the module's imports (a `use`, or a glob into a module providing it in turn), computed once per
// (module, name) and shared by every path (`ctx.provided`): linear in paths whatever the re-exports.

// The module a visibility (scanRustItems' `vis`) written in module `modulePath` reaches: the crate root
// for `pub`/`pub(crate)`, the module for private or `pub(self)`, the parent for `pub(super)`, the
// ancestor a `pub(in …)` names when it is one (rustc rejects any other, so that reads as `crate`).
function visibilityScope(vis, modulePath) {
  if (vis === null || vis === 'self') return modulePath
  if (vis === 'crate') return 'crate'
  const parent = modulePath.includes('::') ? modulePath.slice(0, modulePath.lastIndexOf('::')) : 'crate'
  if (vis === 'super') return parent
  const segments = vis.slice(3).split('::')
  let cur
  if (segments[0] === 'crate') cur = ['crate']
  else if (segments[0] === 'self') cur = modulePath.split('::')
  else if (segments[0] === 'super') cur = parent.split('::')
  else return 'crate'
  let i = 1
  while (segments[i] === 'super' && cur.length > 1) {
    cur.pop()
    i++
  }
  const scope = [...cur, ...segments.slice(i)].join('::')
  return modulePath === scope || modulePath.startsWith(`${scope}::`) ? scope : 'crate'
}

// --- cfg compatibility -----------------------------------------------------------------------

// Which of a module's files, imports or glob sources a path written under some cfgs can mean: each
// file carries the cfg leaves it was mounted under, each import and item its own on top; a candidate
// whose leaves can't hold with the asker's is skipped (libc's per-platform `pub use fuchsia::*`).

// The conjunctive leaves of a cfg predicate, `{ key, value, neg }`: `all(unix, not(feature = "std"))`
// → `unix`, `!feature="std"`. An `any(…)` (or a negated `all(…)`) is one leaf `{ key: 'any', alts }`,
// unless an alternative decides nothing (`any(unix, libc_core_cvoid)`): then it decides nothing.
function cfgLeaves(pred) {
  if (pred === null || pred === undefined) return []
  const p = pred.trim()
  const m = /^(all|any|not)\s*\(([\s\S]*)\)$/u.exec(p)
  if (!m) {
    if (p === 'true') return [] // holds: decides nothing (`false` is a leaf the build rules out, see leafFalse)
    const kv = /^((?:r#)?[\w-]+)\s*(?:=\s*"([^"]*)")?$/u.exec(p)
    return kv ? [{ key: cfgName(kv[1]), value: kv[2] ?? null, neg: false }] : []
  }
  const parts = splitTopLevel(m[2]).filter((part) => part.trim() !== '').map(cfgLeaves)
  if (m[1] === 'all') return parts.flat()
  if (m[1] === 'any') return anyOf(parts)
  return parts.length === 1 ? negated(parts[0]) : []
}
// The leaves holding when any of `alts` (conjunctions) does: the one alternative left once duplicates
// and implied ones go (`a ∨ (a ∧ b)` is `a`), else an `any` leaf -- or, past MAX_ALTERNATIVES or over
// an undecided one, the undecided leaf (UNDECIDED_KEY); nothing when an alternative decides nothing.
const MAX_ALTERNATIVES = 16
const anyOf = (alts) => {
  const uniq = new Map()
  for (const alt of alts) {
    if (alt.length === 0) return []
    uniq.set(alt.map(leafKey).toSorted().join('&'), alt)
  }
  let list = [...uniq.values()]
  if (list.length > 1) {
    const keys = list.map((alt) => new Set(alt.map(leafKey)))
    list = list.filter((_, i) => !keys.some((other, j) => j !== i && other.size < keys[i].size && other.isSubsetOf(keys[i])))
  }
  if (list.length > 1 && (list.length > MAX_ALTERNATIVES || list.some((alt) => alt.some((l) => l.many !== undefined)))) return [{ key: UNDECIDED_KEY, value: null, neg: false, many: list }]
  if (list.length <= 1) return list[0] ?? []
  return [{ key: 'any', value: null, neg: false, alts: list }]
}
// The key of the leaf an `any` the loader doesn't follow is kept as (`many`: its alternatives, for its
// text): no build decides it, no asker holds it, it is never custom nor exclusive -- so a candidate
// under it is only maybe the answer, never certain; and an `any` over one is undecided too.
const UNDECIDED_KEY = 'any(…)!'
// The leaves of a conjunction's negation: one leaf flips, an `any` leaf's negation is every
// alternative's, several leaves negate to any of their negations.
const negated = (leaves) => {
  if (leaves.length === 0) return []
  if (leaves.length > 1) return anyOf(leaves.map((l) => negated([l])))
  const [l] = leaves
  return l.alts === undefined ? [{ ...l, neg: !l.neg }] : l.alts.flatMap(negated)
}

// A cfg gate macro, `cfg_<x>!` (tokio's `cfg_io_uring! { … }`), wraps each item of its body in the cfg
// its definition writes: `($($item:item)*) => { $( #[cfg(feature = "rt")] $item )* }` (gatePredicate).
// `cfg_if!` is read branch by branch; any other macro's body is no gate.
const GATE_MACRO_RE = /^cfg_(?!if$)\w+$/u
// The cfg a gate macro's definition puts on what it wraps: the conjunction of its transcribers'
// `#[cfg(…)]`s when every arm writes the same; null when an arm writes none or the arms differ.
// `code`/`masked`: the lexed views; `open`/`close`: the braces of the `macro_rules!` body.
function gatePredicate(code, masked, open, close) {
  let seen = null
  for (let i = masked.indexOf('=>', open); i !== -1 && i < close; i = masked.indexOf('=>', i + 2)) {
    let start = i + 2
    while (WS_RE.test(masked[start] ?? '')) start++
    if (!'{(['.includes(masked[start] ?? ' ')) continue
    const end = matchClose(masked, start)
    const preds = []
    for (const m of masked.slice(start, end).matchAll(/#\s*\[\s*cfg\s*\(/gu)) {
      const paren = start + m.index + m[0].length - 1
      preds.push(normalizeCfg(code.slice(paren + 1, matchClose(masked, paren))))
    }
    if (preds.length === 0) return null
    const pred = joinCfgs([...new Set(preds)].toSorted())
    if (seen !== null && seen !== pred) return null
    seen = pred
    i = end
  }
  return seen
}
// The leaves of what a gate macro's body declares: its definition's cfg (`gates`: name → predicate,
// null when unreadable), else a leaf of its own name, which holds along with anything and is never
// certain: `cfg_x!` and `cfg_not_x!` aren't taken for each other's negation by name alone.
function gateLeaves(macro, gates = null) {
  if (macro === null || macro === undefined || !GATE_MACRO_RE.test(macro)) return []
  const pred = gates?.get(macro)
  return typeof pred === 'string' ? cfgLeaves(pred) : [{ key: `${macro}!`, value: null, neg: false }]
}

// Keys a target has one value of: `target_os = "linux"` and `target_os = "macos"` never both hold
// (`feature`, `target_family` and `target_has_atomic` may take several).
const SINGLE_VALUED_CFG_KEYS = new Set(['target_os', 'target_arch', 'target_env', 'target_vendor', 'target_abi', 'target_pointer_width', 'target_endian', 'panic'])
// Operating systems whose targets are not `unix`.
const NON_UNIX_OS = new Set(['windows', 'none', 'uefi', 'wasi', 'solana', 'cuda', 'xous', 'zkvm', 'psp', 'unknown'])
const isWindowsLeaf = (l) => (l.key === 'windows' && l.value === null) || ((l.key === 'target_os' || l.key === 'target_family') && l.value === 'windows')
const isUnixLeaf = (l) => (l.key === 'unix' && l.value === null) || (l.key === 'target_family' && l.value === 'unix')

// Whether two leaf lists (conjunctions) can't hold at once: a leaf and its negation, two values of a
// single-valued key or two variants of one `mod`, Windows against unix, or an `any` leaf none of whose
// alternatives can hold with the other.
function cfgExclusive(a, b) {
  const pa = prepared(a)
  const pb = prepared(b)
  for (const k of pa.negKeys) if (pb.keys.has(k)) return true
  for (const [k, v] of pa.values) {
    const w = pb.values.get(k)
    if (w !== undefined && w !== v) return true
  }
  if ((pa.windows && (pb.unix || pb.otherOs)) || (pb.windows && (pa.unix || pa.otherOs)) || (pa.unix && pb.nonUnixOs) || (pb.unix && pa.nonUnixOs)) return true
  for (const x of pa.anys) if (x.alts.every((alt) => cfgExclusive(alt, b))) return true
  for (const y of pb.anys) if (y.alts.every((alt) => cfgExclusive(a, alt))) return true
  return false
}
// What cfgExclusive asks of a leaf list, gathered once and kept on it: its leaves' keys and their
// negations', the value each positive single-valued key (or `mod` variant site) takes (`MANY` for
// several: nothing holds with it), its Windows/unix standing and its `any` leaves.
const MANY = Symbol('many')
function prepared(leaves) {
  if (leaves.prep !== undefined) return leaves.prep
  const prep = { keys: new Set(), negKeys: [], values: new Map(), anys: [], windows: false, unix: false, otherOs: false, nonUnixOs: false }
  for (const l of leaves) {
    if (l.alts !== undefined) {
      prep.anys.push(l)
      continue
    }
    if (l.many !== undefined) continue // undecided: exclusive with nothing
    const k = leafKey(l)
    prep.keys.add(k)
    prep.negKeys.push(l.neg ? k.slice(1) : `!${k}`)
    if (l.neg) continue
    if (l.value !== null && (SINGLE_VALUED_CFG_KEYS.has(l.key) || l.key === 'variant')) {
      const site = l.key === 'variant' ? `variant@${l.site}` : l.key
      prep.values.set(site, prep.values.has(site) && prep.values.get(site) !== l.value ? MANY : l.value)
    }
    if (isWindowsLeaf(l)) prep.windows = true
    if (isUnixLeaf(l)) prep.unix = true
    if (l.key === 'target_os' && l.value !== null) {
      if (l.value !== 'windows') prep.otherOs = true
      if (NON_UNIX_OS.has(l.value)) prep.nonUnixOs = true
    }
  }
  leaves.prep = prep
  return prep
}

// A stable text for one leaf; an `any` leaf's names its alternatives. Kept per leaf: an `any`
// leaf's is asked for again and again as sets of them are interned and compared.
const leafKeys = new WeakMap()
const leafKey = (l) => upsert(leafKeys, l, () => (l.alts === undefined ? `${l.neg ? '!' : ''}${l.key}${l.site === undefined ? '' : `@${l.site}`}${l.value === null ? '' : `=${l.value}`}` : `any(${l.alts.map((alt) => alt.map(leafKey).toSorted().join('&')).toSorted().join(',')})`))

// Leaf sets are interned per tree (`sets`: key → `{ leaves, key }`), one object per distinct set:
// the union of the cfgs along a chain of globs stays small however long the chain, and the
// compatibility verdict for a pair of sets is looked up by key, not computed again.
const NO_LEAVES = { leaves: [], key: '' }
function leafSet(leaves, sets) {
  if (leaves.length === 0) return NO_LEAVES
  const uniq = new Map()
  for (const l of leaves) uniq.set(leafKey(l), l)
  const key = [...uniq.keys()].toSorted().join('|')
  return upsert(sets, key, () => ({ leaves: [...uniq.values()], key }))
}
// A union is asked for again and again along a closure (a glob's leaves with each candidate's): kept
// on the first set, by the second's key.
const unionLeaves = (a, b, sets) => {
  if (a.key === '') return b
  if (b.key === '' || b.key === a.key) return a
  const unions = (a.unions ??= new Map())
  return upsert(unions, b.key, () => leafSet([...a.leaves, ...b.leaves], sets))
}
// The leaves holding when either of two sets does (a module two glob paths reach): an `any` of
// the two -- of their alternatives, when one is an `any` leaf already.
const eitherLeaves = (a, b, sets) => {
  if (a.key === b.key) return a
  if (a.key === '' || b.key === '') return NO_LEAVES
  const altsOf = (s) => (s.leaves.length === 1 && s.leaves[0].alts !== undefined ? s.leaves[0].alts : [s.leaves])
  return leafSet(anyOf([...altsOf(a), ...altsOf(b)]), sets)
}

// Whether a candidate's leaf set can hold with the asker's (`{ file, set, … }`: the file a path was
// written in, under the leaves it was mounted under plus its target's cfgs, when known); no asker (an
// internal query) skips nothing. Kept per pair of sets in `compat`, shared by one set's askers.
const compatible = (asker, set) => asker === undefined || set.key === '' || asker.contradictory || upsert(asker.compat, set.key, () => !cfgExclusive(asker.set.leaves, set.leaves))
// Whether a leaf list can't hold in the asker's build (buildOf): a leaf the build decides is false, or an
// `any` each of whose alternatives is. Such a candidate (`dead`) is taken last, only when nothing the
// build compiles answers; an asker whose own leaves can't hold (`deadHere`) gets no verdict.
const leafFalse = (l, build) => {
  if (l.alts !== undefined) return l.alts.every((alt) => alt.some((m) => leafFalse(m, build)))
  if (l.key === 'false' && l.value === null) return !l.neg // the literal (cfgLeaves)
  const verdict = evalCfgKey(l.key, l.value, build)
  return l.neg ? verdict === true : verdict === false
}
const deadUnder = (leaves, build) => build !== undefined && leaves.some((l) => leafFalse(l, build))
const deadFor = (asker, set) => asker !== undefined && !asker.deadHere && set.key !== '' && upsert(asker.dead, set.key, () => deadUnder(set.leaves, asker.build))
// Whether a candidate's leaves are all the asker's own (`keys`): certainly compiled together, not merely
// possibly (libc's aix/mod.rs asking `crate::fsid_t` takes the aix glob's). An `any` holds when an
// alternative does, a custom cfg's negation (`not(loom)`) is presumed to; kept per pair in `sure`.
const holds = (l, keys, custom) => l.many === undefined && (keys.has(leafKey(l)) || (l.alts === undefined ? l.neg && custom(l.key) : l.alts.some((alt) => alt.every((m) => holds(m, keys, custom)))))
const entailed = (asker, set) => asker === undefined || set.key === '' || (!asker.contradictory && upsert(asker.sure, set.key, () => set.leaves.every((l) => holds(l, asker.keys, asker.custom))))
// The cfgs rustc and cargo set; any other positive leaf is a custom `--cfg` (`loom`, `docsrs`), off by
// default, so a candidate under one is `doubtful`: taken after a compatible one under none. One the
// asker's package may set (cargo.js cfgsSetFor, see customFor) is no custom cfg for it.
const KNOWN_CFG_KEYS = new Set([...TARGET_CFG_KEYS, 'false', 'feature', 'test', 'doctest', 'doc', 'debug_assertions', 'overflow_checks', 'panic', 'proc_macro', 'miri', 'sanitize', 'target_feature', 'target_thread_local', 'ub_checks', 'relocation_model', 'fmt_debug', 'clippy', 'rustfmt', 'variant'])
const customKey = (key) => !KNOWN_CFG_KEYS.has(key) && !key.endsWith('!')
// The custom-cfg test of an asker whose build may set `settable` (`{ names, any }`), one per object.
const customMemo = new WeakMap()
const NO_CUSTOM = () => false
const customFor = (settable) => {
  if (settable === undefined || settable === null) return customKey
  if (settable.any) return NO_CUSTOM
  if (settable.names.size === 0) return customKey
  return upsert(customMemo, settable, () => (key) => customKey(key) && !settable.names.has(key))
}
const doubtfulLeaf = (l, askerLeaves, custom) => (l.alts === undefined ? !l.neg && custom(l.key) : l.alts.every((alt) => cfgExclusive(alt, askerLeaves) || alt.some((m) => doubtfulLeaf(m, askerLeaves, custom))))
// Whether a leaf list has any custom cfg at all -- else no asker finds it doubtful (kept on the
// set for the plain test, which most askers share).
const hasCustom = (leaves, custom) => leaves.some((l) => (l.alts === undefined ? !l.neg && custom(l.key) : l.alts.some((alt) => hasCustom(alt, custom))))
const doubtful = (asker, set) => {
  if (asker === undefined || set.key === '') return false
  set.custom ??= hasCustom(set.leaves, customKey)
  return set.custom && upsert(asker.doubt, set.key, () => set.leaves.some((l) => !holds(l, asker.keys, asker.custom) && doubtfulLeaf(l, asker.set.leaves, asker.custom)))
}

// --- cycles in the import graph ---------------------------------------------------------------

// Recompute the glob closures computed short of a cycle (globClosure) against each other until none
// grows, dropping first the lookups that may rest on the short ones (glob sources, imports' answers,
// candidate lists). True when anything changed: the paths resolved so far must be resolved again.
function stabilizeClosures(ctx) {
  const cyclic = []
  for (const memo of ctx.closures.values()) for (const entry of memo.values()) if (entry.cyclic === true) cyclic.push(entry)
  if (cyclic.length === 0) return false
  const reset = () => {
    ctx.provided.clear()
    ctx.opaque.clear()
    ctx.opaqueGlobs.clear()
    for (const byModule of ctx.imports.values()) {
      for (const im of [...byModule.values()].flatMap(importsIn)) {
        delete im.source
        delete im.answers
      }
    }
  }
  let changed = false
  for (let round = 0; round < MAX_STABILIZE_ROUNDS; round++) {
    reset()
    let grew = false
    for (const entry of cyclic) {
      const again = entry.compute()
      if (again.length !== entry.value.length) {
        entry.value = again
        grew = true
      }
    }
    if (!grew) break
    changed = true
  }
  reset()
  return changed
}
const MAX_STABILIZE_ROUNDS = 8

// Every import a module's `{ named, globs }` record holds (see buildRustTree).
const importsIn = (of) => [...of.globs, ...[...of.named.values()].flat()]

// The shallowest computation under way that was cycled back to, Infinity for none.
function minHit(ctx) {
  let min = Infinity
  for (const d of ctx.hits) if (d < min) min = d
  return min
}

// Number of leading module-path segments `a` and `b` share (`crate::a::b` / `crate::a::c` → 2).
function commonDepth(a, b) {
  const n = Math.min(a.length, b.length)
  let i = 0
  let depth = 0
  while (i < n && a[i] === b[i]) {
    if (a[i] === ':' && a[i + 1] === ':') {
      depth++
      i += 2
    } else {
      i++
    }
  }
  // The segment the match stopped in counts when it is whole in both: each ends there or goes on
  // with a `::`.
  const wholeA = i === a.length || a.startsWith('::', i)
  const wholeB = i === b.length || b.startsWith('::', i)
  return wholeA && wholeB ? depth + 1 : depth
}

// What the imports written in module `at` make of `name` for a path written in module `from` (which
// decides the imports it may see): a `use` binding it, else what the modules `at`'s globs reach have
// of it (a glob out of the crate provides nothing). `asker`'s cfgs pick among the candidates (pick).
function provided(root, at, name, from, ctx, asker, ns = null) {
  return pick(providedAll(root, at, name, commonDepth(from, at), ctx), root, ctx, asker, ns) // scopes are ancestors of `at`: `from` is inside those this deep or shallower
}

// The first of `candidates` (in written order) the asker's cfgs entail, else the compatible ones under no
// doubt (withAlternatives), else the first doubtful, else the first dead -- in namespace `ns`. An import
// answers what it leads to (followImport, kept per asker); a value where a type is wanted, VALUE_ONLY.
function pick(candidates, root, ctx, asker, ns = null) {
  const maybes = [] // the compatible answers under no doubt, for when none is entailed (see withAlternatives)
  let doubted = null // the first compatible answer under a doubtful cfg, for when there is nothing else
  let lastResort = null // the first under a cfg the asker's build can't compile (see deadUnder)
  let valueOnly = false // a candidate passed over for being a value where a type is wanted
  for (const c of candidates) {
    if (!compatible(asker, c.leaves)) continue
    if (ns === 'type' && c.ns === 'value') {
      valueOnly = true
      continue
    }
    if (ns === 'macro' ? (c.ns !== undefined && c.ns !== 'macro') || c.answer?.kind === 'module' : c.ns === 'macro') continue
    const dead = deadFor(asker, c.leaves)
    const doubt = !dead && doubtful(asker, c.leaves)
    const sure = !dead && !doubt && entailed(asker, c.leaves)
    if ((doubt || dead) && (maybes.length > 0 || doubted !== null)) continue
    if (dead && lastResort !== null) continue
    let r
    if (c.import === undefined) {
      r = c.answer
    } else {
      const im = c.import
      // Met again while being followed (`use log;` asks its own module for `log`): nothing here.
      if (im.following !== undefined) {
        ctx.hits.add(im.following)
        continue
      }
      const key = `${asker?.set.key ?? ''}\0${ns}`
      r = im.answers?.get(key)
      if (r === undefined) {
        const depth = ctx.walking++
        im.following = depth
        r = followImport(im, root, ctx, asker, ns)
        // The name a macro an import leads to is defined by: the import's (`use dep::mac as m;`).
        if (ns === 'macro' && r?.kind === 'item' && r.macroName === undefined && im.segments.length > 0) r = { ...r, macroName: im.segments.at(-1) }
        im.following = undefined
        ctx.walking--
        ctx.hits.delete(depth)
        if (minHit(ctx) > depth) (im.answers ??= new Map()).set(key, r)
      }
      // Followed as a macro to a file defining no macro of the name (`pub use util::helper;` of a
      // `fn helper`), it binds no macro.
      if (ns === 'macro' && r?.kind === 'item' && !definesMacro(ctx, r.file, r.macroName)) continue
      // An import leading out of the bundle (`use std::sync::atomic::AtomicU64;`) binds the name all
      // the same, as an item of its own file; one naming a crate outright (`use serde;`) answers
      // nothing: the lead is the crate's to report.
      if (r === null) {
        if (im.segments.length === 1) continue
        r = { kind: 'item', file: im.file }
      }
      if (r === VALUE_ONLY) {
        valueOnly = true
        continue
      }
      if (ns === 'macro' && (r.kind === 'module' || r.kind === 'crate')) continue
    }
    const answer = { ...r, through: c.through }
    if (sure) return answer
    if (dead) lastResort = answer
    else if (doubt) doubted = answer
    else maybes.push({ answer, leaves: c.leaves })
  }
  if (maybes.length > 0) return withAlternatives(maybes, asker)
  if (doubted !== null) return doubted
  if (lastResort !== null) return lastResort
  return valueOnly ? VALUE_ONLY : null
}

// A leaf list as cfg text, for a key: `all(unix, feature = "std")`, `not(loom)`, `any(…)`, a gate
// macro by name (`cfg_x!`); a `mod` variant's leaf by the key of the variant (its cfg, or its
// macro), and only when nothing else tells the candidates apart. Null for no leaves.
const leafText = (l) => {
  if (l.alts !== undefined) return `any(${l.alts.map((alt) => cfgTextOf(alt) ?? '*').join(', ')})`
  const plain = l.many !== undefined ? manyText(l) : (l.value === null ? l.key : `${l.key} = "${l.value}"`)
  return l.neg ? `not(${plain})` : plain
}
// An undecided leaf's text (see UNDECIDED_KEY): the `any(…)` of its alternatives, kept per leaf, or
// its count when that runs long (undecided leaves within undecided leaves).
const manyTexts = new WeakMap()
const manyText = (l) => upsert(manyTexts, l, () => {
  const text = `any(${l.many.map((alt) => cfgTextOf(alt) ?? '*').join(', ')})`
  return text.length > 4096 ? `any(${l.many.length} alternatives)` : text
})
function cfgTextOf(leaves) {
  const own = leaves.filter((l) => l.key !== 'variant')
  // What a variant is, rather than all it isn't: its positive leaves (a `cfg_if!` branch's own
  // cfg, not the negations of the branches before it), else its `any(…)` of positive ones.
  const positive = own.filter((l) => l.alts === undefined && !l.neg)
  const anyPositive = own.filter((l) => l.alts !== undefined && l.alts.every((alt) => alt.every((m) => m.alts === undefined && !m.neg)))
  const shown = positive.length + anyPositive.length > 0 ? [...positive, ...anyPositive] : (own.length > 0 ? own : leaves)
  return joinCfgs([...new Set(shown.map((l) => (l.key === 'variant' ? l.value : leafText(l))))].toSorted())
}

// The answer of several candidates none of which the asker's cfgs entail (libc's per-platform
// `crate::sockaddr` from a file under no platform cfg): the first, with `alternatives` (cfg key → each
// distinct file) -- or, for a module a path may go on through, `branches` (cfg key → each answer).
function withAlternatives(found, asker) {
  const [first] = found
  const idOf = (answer) => (answer.kind === 'module' ? `mod ${answer.modulePath}` : answer.file)
  if (found.length === 1 || new Set(found.map((f) => idOf(f.answer)).filter((id) => id !== undefined)).size < 2) return first.answer
  const keyed = new Map()
  const seen = new Set()
  for (const { answer, leaves } of found) {
    const id = idOf(answer)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    // Kept per asker set (the text leaves out what the asker holds itself).
    const textOf = () => cfgTextOf(leaves.leaves.filter((l) => asker === undefined || !asker.keys.has(leafKey(l))))
    keyed.set(freshKey(keyed, cfgKey(asker === undefined ? textOf() : upsert(asker.texts, leaves.key, textOf))), answer)
  }
  if (first.answer.kind === 'module') return { ...first.answer, branches: keyed }
  return { ...first.answer, alternatives: new Map([...keyed].filter(([, answer]) => answer.file !== undefined).map(([key, answer]) => [key, answer.file])) }
}

// Every candidate module `at` offers for `name` as seen `seeing` levels into it, in written order: its
// `use` bindings and items, then what the modules its globs reach have (hasAll). Built once per (at,
// name, seeing) for every asker, lazily: a closure holds hundreds of modules, the first few answer.
function providedAll(root, at, name, seeing, ctx) {
  const memo = nestedMap(ctx.provided, root)
  const key = `${at}\0${name}\0${seeing}`
  let list = memo.get(key)
  if (list === undefined) {
    const depth = ctx.walking++
    const closure = globClosure(root, at, seeing, ctx)
    ctx.walking--
    list = new Lazy(function* () {
      yield* importsOf(root, at, name, seeing, ctx)
      // At the crate root a `#[macro_export]` macro binds the name too, in the macro namespace, ranked
      // by cfgs against a `pub use inner::m;` beside it (serde's docsrs-only copies).
      if (at === 'crate') for (const m of ctx.exportedMacros?.get(root)?.get(name) ?? NONE) yield { answer: { kind: 'item', file: m.file }, leaves: m.leaves, ns: 'macro' }
      // The module's own items rank with its named imports (two bindings of one name must differ in
      // cfgs, as tokio's `imp` variants do), ahead of what globs bring in, which never shadows them.
      const defs = ctx.defined.get(root)?.get(at)?.get(name)
      if (defs !== undefined) yield* defCandidates(root, at, defs, ctx)
      // Of the closure's modules (hundreds, in libc), only the ones with something of the name
      // (`having`), in closure order.
      const having = ctx.having.get(root)?.get(name)
      if (having === undefined) return
      const positions = []
      for (const module of having) for (const i of closureIndex(closure).get(module) ?? NONE) positions.push(i)
      for (const i of positions.toSorted((x, y) => x - y)) {
        const reached = closure[i]
        for (const c of hasAll(root, reached.module, name, reached.seeing, ctx)) yield { ...c, through: reached.through, leaves: unionLeaves(reached.leaves, c.leaves, ctx.leafSets) }
      }
    }(), ctx)
    if (minHit(ctx) >= depth) memo.set(key, list)
  }
  return list
}

// A closure's entries by module (one may be reached at several depths), kept on the closure.
function closureIndex(closure) {
  if (closure.index === undefined) {
    closure.index = new Map()
    closure.forEach((e, i) => upsert(closure.index, e.module, () => []).push(i))
  }
  return closure.index
}

// A list materialized from a generator as far as it is read (`get(i)`, undefined past the end). Read
// again while producing an element (its lookups led back here), it ends there for that reader and
// marks the computation under way hit (see globClosure), so nothing built on that short view is kept.
class Lazy {
  constructor(gen, ctx) {
    this.gen = gen
    this.ctx = ctx
    this.out = []
    this.running = -1
  }

  get(i) {
    if (this.running !== -1) {
      this.ctx.hits.add(this.running)
      return undefined
    }
    while (i >= this.out.length) {
      this.running = this.ctx.walking
      let next
      try {
        next = this.gen.next()
      } finally {
        this.running = -1
      }
      if (next.done) return undefined
      this.out.push(next.value)
    }
    return this.out[i]
  }

  * [Symbol.iterator]() {
    for (let i = 0; ; i++) {
      const c = this.get(i)
      if (c === undefined) return
      yield c
    }
  }
}

// Everything module `at` has under `name` for one seeing `seeing` levels into it (what a glob into it
// brings in), as candidates in written order: a child module visible that far, its items, at the crate
// root its `#[macro_export]` macros (zerocopy's `use super::*;` brings `into_inner!` in), its `use`s.
function hasAll(root, at, name, seeing, ctx) {
  // Asked for every module a closure reaches, most of which have nothing of the name.
  const child = ctx.children.get(root)?.get(at)?.has(name) === true
  const defs = ctx.defined.get(root)?.get(at)?.get(name)
  const macros = at === 'crate' ? ctx.exportedMacros?.get(root)?.get(name) : undefined
  const imports = importsOf(root, at, name, seeing, ctx)
  if (!child && defs === undefined && macros === undefined && imports.length === 0) return NONE
  const out = []
  if (child) {
    const sub = `${at}::${name}`
    if ((ctx.modScope.get(root)?.get(sub) ?? 1) <= seeing) out.push({ answer: { kind: 'module', modulePath: sub, file: ctx.trees.get(root).get(sub) }, leaves: NO_LEAVES })
  }
  if (defs !== undefined) for (const c of defCandidates(root, at, defs.filter((d) => d.scopeDepth <= seeing), ctx)) out.push(c)
  for (const m of macros ?? NONE) out.push({ answer: { kind: 'item', file: m.file }, leaves: m.leaves })
  out.push(...imports)
  return out
}
const NONE = Object.freeze([])

// Module `at`'s definitions `defs` of a name as candidates, in written order but those in the
// module's own tree file first.
function defCandidates(root, at, defs, ctx) {
  const own = ctx.trees.get(root).get(at)
  return [...defs.filter((d) => d.file === own), ...defs.filter((d) => d.file !== own)].map((d) => ({ answer: { kind: 'item', file: d.file }, leaves: d.leaves, ns: d.ns }))
}

// The file in which module `at` defines item `name` under cfgs the asker's allow (in the type namespace
// for `ns` `type`), or null -- or `{ file, alternatives }` when several may, none for certain (itemAt
// makes an answer of either).
function definedIn(root, at, name, ctx, asker, ns = null) {
  const defs = ctx.defined.get(root)?.get(at)?.get(name)
  if (defs === undefined) return null
  const own = ctx.trees.get(root).get(at)
  // Ranked as pick ranks candidates (sure, compatible, doubtful, dead), the module's own tree file first
  // within a rank; several compatible, none sure: each applies under its own cfgs (withAlternatives).
  let best = null
  let bestRank = Infinity
  const maybes = []
  for (const d of defs) {
    if (!compatible(asker, d.leaves) || (ns === 'type' && d.ns === 'value')) continue
    const tier = deadFor(asker, d.leaves) ? 3 : (doubtful(asker, d.leaves) ? 2 : (entailed(asker, d.leaves) ? 0 : 1))
    if (tier === 1) maybes.push({ answer: { kind: 'item', file: d.file }, leaves: d.leaves })
    const rank = tier * 2 + (d.file === own ? 0 : 1)
    if (rank < bestRank) {
      best = d.file
      bestRank = rank
      if (rank === 0) break
    }
  }
  if (bestRank >= 2 && bestRank < 4 && maybes.length > 1) {
    const r = withAlternatives([...maybes.filter((m) => m.answer.file === best), ...maybes.filter((m) => m.answer.file !== best)], asker)
    if (r.alternatives !== undefined) return { file: best, alternatives: r.alternatives }
  }
  return best
}

// What module `at`, spread over cfg variant files (`#[cfg_attr(unix, path = …)]`), makes of `name` for a
// path written in `file`: that file's own `use`s and globs first, then the module's imports at large
// (providedAll). A module held in one file takes the shortcut.
function providedFrom(root, at, name, ctx, file, asker, ns = null) {
  const of = ctx.imports.get(root)?.get(at)
  // The files holding the module's imports, gathered once (they are all in place by now).
  const files = of === undefined ? null : (of.files ??= new Set(importsIn(of).map((im) => im.file)))
  if (files === null || files.size === (files.has(file) ? 1 : 0)) return provided(root, at, name, at, ctx, asker, ns)
  const memo = nestedMap(ctx.provided, root)
  const seeing = at.split('::').length
  const key = `${at}\0${name}\0@${file}`
  let list = memo.get(key)
  if (list === undefined) {
    // Resolving this file's glob sources may ask this very question (`pub use sibling::*;` beside
    // `use super::*;`): while the list is in the making it reads as nothing, and is not kept then.
    const depth = ctx.walking++
    memo.set(key, { depth })
    const own = [] // this file's globs, with their sources
    for (const im of of.globs) {
      if (im.file !== file) continue
      const source = globSource(im, root, ctx)
      if (source?.kind === 'module') own.push([im, source.modulePath])
    }
    const cyclic = ctx.hits.delete(depth)
    ctx.walking--
    list = new Lazy(function* () {
      yield* importsOf(root, at, name, seeing, ctx, file)
      for (const [im, module] of own) {
        const sees = commonDepth(at, module)
        for (const c of hasAll(root, module, name, sees, ctx)) yield { ...c, through: im.file, leaves: unionLeaves(im.leaves, c.leaves, ctx.leafSets) }
        for (const c of providedAll(root, module, name, sees, ctx)) yield { ...c, through: im.file, leaves: unionLeaves(im.leaves, c.leaves, ctx.leafSets) }
      }
      yield* providedAll(root, at, name, seeing, ctx)
    }(), ctx)
    if (!cyclic && minHit(ctx) >= depth) memo.set(key, list)
    else memo.delete(key)
  } else if (list.depth !== undefined) {
    ctx.hits.add(list.depth)
    return null
  }
  return pick(list, root, ctx, asker, ns)
}

// The `use` items of module `at` binding `name` visible to one seeing `seeing` levels into it, as
// candidates to follow (pick), in written order. `onlyFile`: those written in that file, for a module
// spread over cfg variant files, each binding the name its own way.
function importsOf(root, at, name, seeing, ctx, onlyFile) {
  const named = ctx.imports.get(root)?.get(at)?.named.get(name)
  if (named === undefined) return NONE
  return named.filter((im) => im.scopeDepth <= seeing && (onlyFile === undefined || im.file === onlyFile)).map((im) => ({ import: im, through: im.file, leaves: im.leaves }))
}

// The modules of this crate the globs of module `at` (seen `seeing` levels into) reach, transitively,
// depth-first in written order, as `{ module, seeing, through, leaves }`, `through` the file holding
// `at`'s glob. Computed once per (at, seeing); a settled closure stands in for walking on from it.
function globClosure(root, at, seeing, ctx) {
  const memo = nestedMap(ctx.closures, root)
  const key = `${at}\0${seeing}`
  const hit = memo.get(key)
  // Asked again while being computed (a cycle): empty for now, and the entry in progress is marked hit
  // (`ctx.hits`, by its depth in `ctx.walking`); the same bookkeeping serves globSource, pick and Lazy.
  if (hit?.depth !== undefined) {
    ctx.hits.add(hit.depth)
    return []
  }
  if (hit !== undefined) return hit.value
  const compute = () => {
    const modules = []
    const seen = new Map([[key, null]]) // (module, seeing) → its entry
    // `leaves`: the cfgs of the globs walked through, all of which must hold. A module reached again by
    // another path (libc's `mod primitives`, re-exported under a dozen cfgs) is reachable under either,
    // as is all it reaches: an entry so widened is walked on from; one that adds nothing ends there.
    const add = (k, entry) => {
      const known = seen.get(k)
      if (known === undefined) {
        seen.set(k, entry)
        modules.push(entry)
        return 'new'
      }
      if (known === null) return 'same'
      const either = eitherLeaves(known.leaves, entry.leaves, ctx.leafSets)
      if (either === known.leaves) return 'same'
      known.leaves = either
      return 'widened'
    }
    const reach = (module, sees, through, leaves) => {
      const k = `${module}\0${sees}`
      if (add(k, { module, seeing: sees, through, leaves }) === 'same') return
      const settled = memo.get(k)
      if (settled !== undefined && settled.depth === undefined) {
        // Already transitive: no walking on from any of them.
        for (const m of settled.value) add(`${m.module}\0${m.seeing}`, { module: m.module, seeing: m.seeing, through, leaves: unionLeaves(leaves, m.leaves, ctx.leafSets) })
        return
      }
      reachGlobs(module, sees, through, leaves)
    }
    // The modules the globs of `module` visible to one seeing `sees` levels into it name, reached
    // through `through` (else each glob's file) under `leaves` and the glob's own.
    const reachGlobs = (module, sees, through, leaves) => {
      for (const im of ctx.imports.get(root)?.get(module)?.globs ?? []) {
        if (im.scopeDepth > sees) continue
        const source = globSource(im, root, ctx)
        if (source?.kind === 'module') reach(source.modulePath, commonDepth(module, source.modulePath), through ?? im.file, unionLeaves(leaves, im.leaves, ctx.leafSets))
      }
    }
    reachGlobs(at, seeing, null, NO_LEAVES)
    return modules
  }
  // What was computed on top of a cyclic read may be short and is dropped; the entry that was hit is
  // kept, marked `cyclic` with its `compute`, for stabilizeClosures to run again.
  const depth = ctx.walking++
  memo.set(key, { depth })
  const value = compute()
  const cyclic = ctx.hits.delete(depth)
  ctx.walking--
  if (minHit(ctx) < depth) memo.delete(key)
  else memo.set(key, cyclic ? { value, cyclic, compute } : { value })
  return value
}

// What a glob imports from (followImport), asked once per glob rather than once per closure it
// is part of -- unless the answer came out of an import cycle still being resolved.
function globSource(im, root, ctx) {
  if (im.source !== undefined) return im.source
  const depth = ctx.walking++
  const source = followImport(im, root, ctx)
  ctx.walking--
  if (minHit(ctx) >= depth) im.source = source
  return source
}

// What an import leads to: its path resolved as written in its module, else the crate its lead
// names -- the sysroot's (`use core::fmt`: an item, living here as far as the bundle knows), an
// in-tree one, or null for one that isn't (nor anything the tree can model).
function followImport(im, root, ctx, asker, ns = null) {
  if (!im.absolute) {
    const r = walkPath(im.segments, root, im.module, ctx, { file: im.file, asker, ns })
    // A path into another crate by a name the module binds to it (`use dep::{dep, mac}` too),
    // followed as a macro: the macro there.
    if (r !== null && ns === 'macro' && r.kind === 'crate' && r.rest?.length > 0) return macroOfCrate(r.file, r.rest, ctx) ?? r
    if (r !== null) return r
  }
  const head = im.segments[0]
  if (NON_CRATE_LEADS.has(head)) return { kind: 'item', file: im.file }
  const target = ctx.resolveCrate(head, im.file)
  if (!target) return null
  // A macro of another crate (`use dep::mac;`), followed as one: the file defining it (macroOfCrate).
  const macro = ns === 'macro' && im.segments.length > 1 ? macroOfCrate(target, im.segments.slice(1), ctx) : null
  return macro ?? { kind: 'crate', name: head, file: target }
}

// The macro `rest` names in the in-tree crate rooted at `target` (`use dep::mac;`, `dep::mac!(…)`, a
// `#[macro_use] extern crate`'s), looked up from that root in the macro namespace under its own build:
// `{ kind: 'item', file, macroName, alternatives? }`, by the name it is defined under; null for none.
function macroOfCrate(target, rest, ctx) {
  if (!ctx.trees.has(target)) {
    const file = rest.length === 1 ? ctx.macros.get(target)?.get(rest[0]) : undefined
    return file === undefined ? null : { kind: 'item', file, macroName: rest[0] }
  }
  const r = walkPath(['crate', ...rest], target, 'crate', ctx, { ns: 'macro', file: target, asker: ctx.files.get(target)?.asker })
  if (r === null || r === VALUE_ONLY || r.kind !== 'item') return null
  const macroName = r.macroName ?? rest.at(-1)
  if (!definesMacro(ctx, r.file, macroName)) return null
  const alternatives = macroAlternatives(ctx, r.alternatives, macroName)
  return { kind: 'item', file: r.file, macroName, ...(alternatives === undefined ? {} : { alternatives }) }
}

const definesMacro = (ctx, file, name) => ctx.fileMacros.get(file)?.has(name) === true
// Of `alternatives` (cfg key → file), the files defining macro `name`, when more than one does.
const macroAlternatives = (ctx, alternatives, name) => {
  const defining = new Map([...(alternatives ?? [])].filter(([, f]) => definesMacro(ctx, f, name)))
  return defining.size > 1 ? defining : undefined
}

// An item answer for what definedIn found.
const itemAt = (def) => (typeof def === 'string' ? { kind: 'item', file: def } : { kind: 'item', file: def.file, alternatives: def.alternatives })

// walkPath's answer for a path naming a value (a `fn`, `const` or `static`) where a type or module is
// wanted (`log::info!` beside a `fn log`, or `use crate::util::log;` followed as a prefix): nothing
// here, and no item of the module either -- the lead may still name a crate.
const VALUE_ONLY = Object.freeze({ kind: 'value' })
const onlyValues = (root, at, name, ctx) => {
  const defs = ctx.defined.get(root)?.get(at)?.get(name)
  return defs !== undefined && defs.every((d) => d.ns === 'value')
}

// Resolve `segments`, a path written in module `from` of `root`'s crate, when its lead anchors it there
// (`crate::`, `self::`, `super::`, a child module, a name the imports provide, a file's macro); null
// when it doesn't. A segment nothing provides is an item of the module reached (in its defining file).
function walkPath(segments, root, from, ctx, options = {}) {
  const branches = []
  const r = walkOnce(segments, root, from, ctx, options, branches)
  return branches.length === 0 || r === null || r === VALUE_ONLY || r.file === undefined ? r : throughBranches(r, branches, root, from, ctx, options)
}
// The rest of a path through each module a segment may name (`branches`: `{ keyed, rest }`, see
// withAlternatives): `r`, the answer through the first, with the files the others lead to as its
// `alternatives`, under the key of the module each goes through.
function throughBranches(r, branches, root, from, ctx, options) {
  const alternatives = new Map()
  const note = (key, answer) => {
    for (const [k, f] of answer.alternatives ?? [[null, answer.file]]) {
      if (f !== undefined && ![...alternatives.values()].includes(f)) alternatives.set(freshKey(alternatives, k === null ? key : `${key}, ${k}`), f)
    }
  }
  const [{ keyed: firstKeyed }] = branches
  note([...firstKeyed.keys()][0], r)
  for (const { keyed, rest } of branches) {
    for (const [key, answer] of [...keyed].slice(1)) {
      if (answer.kind !== 'module') note(key, answer)
      else {
        const there = walkPath(['crate', ...answer.modulePath.split('::').slice(1), ...rest], root, from, ctx, options)
        if (there !== null && there !== VALUE_ONLY) note(key, there)
      }
    }
  }
  return alternatives.size > 1 ? { ...r, alternatives } : r
}
function walkOnce(segments, root, from, ctx, { ns = null, file, asker } = {}, branches) {
  const tree = ctx.trees.get(root)
  const head = segments[0]
  // A segment with more after it names a module or type (a `fn log` doesn't lead `log::info!`); the
  // last is in the namespace the caller wants.
  const nsOf = (last) => (last ? ns : 'type')
  const isModule = (path, last) => tree.has(path) && !(last && ns === 'macro') // a `mod m` is no `m!`
  const lookup = (at, name, want) => (at === from && file !== undefined ? providedFrom(root, at, name, ctx, file, asker, want) : provided(root, at, name, from, ctx, asker, want))
  let cur = from.split('::')
  let i = 0
  let via
  if (head === 'crate') {
    cur = ['crate']
    i = 1
  } else if (head === 'self') {
    i = 1
  } else if (head !== 'super' && !isModule(`${from}::${head}`, segments.length === 1)) {
    const want = nsOf(segments.length === 1)
    const p = lookup(from, head, want)
    if (p === null || p === VALUE_ONLY) {
      // An item of the module itself (`enum Kind { … } use Kind::*;`), or a macro of the file.
      const own = definedIn(root, from, head, ctx, asker, want)
      if (own !== null) return itemAt(own)
      if (want === 'type' && (p === VALUE_ONLY || onlyValues(root, from, head, ctx))) return VALUE_ONLY
      return segments.length === 1 && file !== undefined && definesMacro(ctx, file, head) ? { kind: 'item', file } : null
    }
    via = { modulePath: from, consumed: 0, through: p.through }
    if (p.kind === 'crate') return { ...p, via, rest: segments.slice(1) } // what the path names in that crate (followImport)
    if (p.kind !== 'module') return { ...p, via }
    if (p.branches !== undefined) branches.push({ keyed: p.branches, rest: segments.slice(1) })
    cur = p.modulePath.split('::')
    i = 1
  }
  while (segments[i] === 'super') {
    cur.pop()
    i++
    if (cur.length === 0) return null
  }
  while (i < segments.length) {
    const at = cur.join('::')
    const name = segments[i]
    const last = i === segments.length - 1
    // (A macro is looked up as any name is: the crate root's `#[macro_export]` definitions are
    // among its bindings, each under its cfgs -- see providedAll.)
    const macro = at === 'crate' && last && ns !== 'macro' ? ctx.macros.get(root)?.get(name) : undefined
    const child = `${at}::${name}`
    const want = nsOf(last)
    let p
    if (isModule(child, last)) {
      // A child module whose files the asker's build doesn't compile, or presumably doesn't (a custom
      // cfg: serde's docsrs-only `mod de` beside `pub use serde_core::de`), gives way to what else the
      // module has of the name; one with a variant the build compiles is there, and shadows a glob.
      const sets = (ctx.moduleFiles?.get(root)?.get(child) ?? [tree.get(child)]).map((f) => ctx.files.get(f)?.leaves).filter((set) => set !== undefined)
      const away = sets.length > 0 && sets.every((set) => deadFor(asker, set) || doubtful(asker, set))
      p = away ? lookup(at, name, want) : null
      if (p === null || p === VALUE_ONLY) {
        // One file there only under cfgs the asker doesn't hold (`#[cfg(not(unix))] mod sys;` beside
        // `#[cfg(unix)] use fallback as sys;`): what else the module binds the name to is a branch of
        // the path too (throughBranches), under no key of its own.
        if (!away && sets.length === 1 && !entailed(asker, sets[0]) && !hasCustom(sets[0].leaves, customKey)) {
          const other = lookup(at, name, want)
          if (other !== null && other !== VALUE_ONLY && !(other.kind === 'module' && other.modulePath === child)) branches.push({ keyed: new Map([[cfgKey(cfgTextOf(sets[0].leaves)), { kind: 'module', modulePath: child, file: tree.get(child) }], ['*', other]]), rest: segments.slice(i + 1) })
        }
        cur.push(name)
        i++
        continue
      }
    } else p = lookup(at, name, want)
    if (p === null || p === VALUE_ONLY) {
      if (macro !== undefined) return { kind: 'item', file: macro, via }
      const def = definedIn(root, at, name, ctx, asker, want)
      if (def !== null) return { ...itemAt(def), via }
      if (want === 'type' && (p === VALUE_ONLY || onlyValues(root, at, name, ctx))) return VALUE_ONLY
      return { kind: 'item', file: tree.get(at), via }
    }
    via ??= { modulePath: at, consumed: i, through: p.through }
    if (p.kind === 'crate') return { ...p, via, rest: segments.slice(i + 1) }
    if (p.kind !== 'module') return { ...p, via }
    if (p.branches !== undefined) branches.push({ keyed: p.branches, rest: segments.slice(i + 1) })
    cur = p.modulePath.split('::')
    i++
  }
  const modulePath = cur.join('::')
  return { kind: 'module', modulePath, file: tree.get(modulePath), via }
}

// The globs of `root`'s crate leading out of it (into a crate not in-tree, source null, or another
// in-tree one) by module, with their sources, found once per crate: the few of a closure's hundreds of
// modules globMayProvide has to look at.
function opaqueGlobsOf(root, ctx) {
  return upsert(ctx.opaqueGlobs, root, () => {
    const index = new Map()
    for (const [module, of] of ctx.imports.get(root) ?? []) {
      for (const im of of.globs) {
        if (NON_CRATE_LEADS.has(im.segments[0])) continue
        const source = globSource(im, root, ctx)
        if (source === null || source.kind === 'crate') upsert(index, module, () => []).push({ im, source })
      }
    }
    return index
  })
}

// Whether a glob `at` sees (its own or its closure's) may bring `lead` in unseen (a glob into a crate
// not in-tree, `use syn::*;`) or does from another in-tree crate: then a lead nothing explains is no
// missing crate. Memoized per (at, lead); asked again while being answered, it reads as no.
function globMayProvide(root, at, lead, ctx) {
  const memo = nestedMap(ctx.opaque, root)
  const key = `${at}\0${lead}`
  if (memo.has(key)) return memo.get(key)
  memo.set(key, false)
  // The globs leading out of the crate that `at` sees, at the depth each module is seen, once per
  // `at`: those into crates not in-tree by crate name, those into in-tree crates with their sources.
  const reachKey = `${at}\0`
  let reach = memo.get(reachKey)
  if (reach === undefined) {
    const seeing = at.split('::').length
    const closure = globClosure(root, at, seeing, ctx)
    const positions = closureIndex(closure)
    reach = { unseen: new Set(), crates: [] }
    for (const [module, globs] of opaqueGlobsOf(root, ctx)) {
      let sees = module === at ? seeing : -1
      for (const i of positions.get(module) ?? NONE) sees = Math.max(sees, closure[i].seeing)
      if (sees === -1) continue
      for (const { im, source } of globs) {
        if (im.scopeDepth > sees) continue
        if (source === null) reach.unseen.add(im.segments[0])
        else reach.crates.push({ im, source })
      }
    }
    memo.set(reachKey, reach)
  }
  // What another crate's module `module` (root `file`) makes visible under `lead`, as far as the
  // bundle sees: anything, for a crate not in-tree; else what the module has, what its `pub`
  // globs bring in from its own crate (providedAll), or may from a third.
  const inCrate = (file, module) => !ctx.trees.has(file) || hasAll(file, module, lead, 1, ctx).length > 0 || providedAll(file, module, lead, 1, ctx).get(0) !== undefined || globMayProvide(file, module, lead, ctx)
  let answer = reach.unseen.size > (reach.unseen.has(lead) ? 1 : 0)
  for (const { im, source } of reach.crates) {
    if (answer || im.segments[0] === lead) break
    // The glob's path on from the crate it names (`sync` of `use tokio::sync::*;`), when the
    // lead itself named the crate (no `via`: the path wasn't anchored in this crate first).
    const rest = source.via === undefined ? im.segments.slice(1) : []
    const there = rest.length === 0 || !ctx.trees.has(source.file) ? { kind: 'module', modulePath: 'crate' } : walkPath(['crate', ...rest], source.file, 'crate', ctx)
    if ((there?.kind === 'module' && inCrate(source.file, there.modulePath)) || (there?.kind === 'crate' && inCrate(there.file, 'crate'))) answer = true
  }
  memo.set(key, answer)
  return answer
}

// Resolve one path reference made in `file` (see walkPath): a module or item of its crate, an in-tree
// crate the lead names (by name or as the root's `extern crate x as y;`), or `{ kind: 'unresolved' }`
// for a lead that could name a crate but nothing in-tree did; null for anything else.
const NO_BINDINGS = new Set()
function resolvePathRef(ref, file, bindings, ctx) {
  const { segments, absolute, inlinePath } = ref
  if (segments.length === 0) return null
  const here = ctx.files.get(file)
  const from = here ? [here.modulePath, ...inlinePath].join('::') : null
  let valueOnly = false
  if (!absolute && here) {
    const r = walkPath(segments, here.root, from, ctx, { ns: ref.macroCall ? 'macro' : null, file, asker: here.asker })
    if (r === VALUE_ONLY) valueOnly = true // the lead is bound here, but as a value: `log::…` names the crate
    else if (r !== null && r.kind === 'crate' && ref.macroCall && r.rest?.length > 0) return { ...r, macro: macroOfCrate(r.file, r.rest, ctx) ?? undefined } // `d::mac!(…)` with `use dep as d;`
    else if (r !== null) return r
  }
  const lead = crateLead(ref, valueOnly ? NO_BINDINGS : bindings)
  if (lead === null) return null
  const name = ctx.externPrelude.get(here?.root)?.get(lead) ?? lead
  if (name === 'self') {
    const r = walkPath(['crate', ...segments.slice(1)], here.root, from, ctx, { ns: ref.macroCall ? 'macro' : null, file, asker: here.asker })
    return r === VALUE_ONLY ? null : r
  }
  const target = ctx.resolveCrate(name, file)
  // `dep::mac!(…)`: the crate, and the macro it names there (macroOfCrate).
  if (target) return { kind: 'crate', name, file: target, alternatives: ctx.crateAlternatives?.(name, file), macro: ref.macroCall && segments.length > 1 ? macroOfCrate(target, segments.slice(1), ctx) ?? undefined : undefined }
  // At the crate root an exported macro is an item (anyhow's `pub use anyhow as format_err;`).
  const macro = segments.length === 1 && from === 'crate' ? ctx.macros.get(here.root)?.get(lead) : undefined
  if (macro !== undefined) return { kind: 'item', file: macro }
  // A glob into a crate that isn't in-tree (`use serde::*;`) may bring the lead in -- unless the
  // package declares a dependency of that name, which the lead then is (see declaresCrate): one
  // missing from the bundle is reported whatever the globs beside it.
  return here && !ctx.declaresCrate(name, file) && globMayProvide(here.root, from, lead, ctx) ? null : { kind: 'unresolved', name }
}

// `map`: root → name → Set<module>, noting `module` under (root, name).
const note = (map, root, name, module) => {
  const byName = nestedMap(map, root)
  upsert(byName, name, () => new Set()).add(module)
}

// Bundle import keys can't contain '/'; a cfg predicate practically never does, but fail safe.
const cfgKey = (cfg) => (cfg ?? '*').replaceAll('/', '|')
// `base`, numbered (`base#2`, `base#3`, …) when `map` has it already.
const freshKey = (map, base) => {
  let key = base
  for (let k = 2; map.has(key); k++) key = `${base}#${k}`
  return key
}

// Whether `rel` is compiled with `cfg(test)`: a file of a test/bench target (`tests/*.rs`,
// `benches/*.rs` and their modules), judged against its package dir when a Cargo context knows it.
const isTestTarget = (rel, ctx) => (ctx ? ctx.isTestTarget(rel) : isTestTargetPath('.', rel))

// The files a macro is in effect invoked from: those invoking it by name (`invokers`), and, since a
// call in a `macro_rules!` template is made where that macro is invoked (`templateCalls`), those
// invoking a macro whose template calls it, on up: the outermost call site, as rustc resolves it.
function effectiveInvokers(name, invokers, templateCalls, seen = new Set()) {
  if (seen.has(name)) return new Set()
  seen.add(name)
  const out = new Set(invokers.get(name) ?? [])
  for (const [caller, called] of templateCalls) if (called.has(name)) for (const f of effectiveInvokers(caller, invokers, templateCalls, seen)) out.add(f)
  return out
}
// Note what file `path`'s scan (`items`) invokes, by bare name or by path (`crate::m!()`, matched by
// name: a `$crate::m!` resolves where the macro is invoked as surely as `m!`), and what its
// `macro_rules!` templates call, for effectiveInvokers.
function noteMacroCalls(invokers, templateCalls, path, items) {
  for (const name of [...items.invocations, ...items.pathInvocations ?? []]) upsert(invokers, name, () => new Set()).add(path)
  for (const m of items.macros) for (const name of [...m.calls, ...m.pathCalls ?? []]) upsert(templateCalls, m.name, () => new Set()).add(name)
}
// The files in effect invoking macro `name` where a `mod` its template declares is declared: of
// `from`'s package (`packageOf`: file → package) -- a macro of the same name elsewhere is likely
// another -- or, for a `#[macro_export]` one (`packageOf` null), of any (see buildRustTree).
const hostsOf = (name, from, invokers, templateCalls, packageOf) => [...effectiveInvokers(name, invokers, templateCalls)].filter((f) => packageOf === null || packageOf(f) === packageOf(from))
// The copies of template `mod` `decl` that a file invoking its macro declares (`items`: its scan): one
// per inline module invoking the macro, or a macro whose template calls it -- in that module, inside
// the inline modules the body opens -- at the first such invocation (`offset`, for textual scope).
function hostedCopies(decl, items, templateCalls) {
  const names = new Set([decl.template])
  for (let grew = true; grew;) {
    grew = false
    for (const [caller, called] of templateCalls) if (!names.has(caller) && [...called].some((n) => names.has(n))) grew = names.add(caller)
  }
  const sites = [...names].flatMap((n) => items.callSites?.get(n) ?? []).toSorted((a, b) => a.offset - b.offset)
  const byModule = new Map()
  for (const site of sites) if (!byModule.has(site.inlinePath.join('::'))) byModule.set(site.inlinePath.join('::'), site)
  if (byModule.size === 0) byModule.set('', { offset: Infinity, inlinePath: [], inlineDirs: [] })
  const own = (list) => list.slice(decl.templateDepth ?? 0)
  return [...byModule.values()].map((site) => ({ ...decl, inlinePath: [...site.inlinePath, ...own(decl.inlinePath)], inlineDirs: [...site.inlineDirs, ...own(decl.inlineDirs)], offset: site.offset }))
}
// TEMPLATE_MACROS less the ones a package defines itself (`own`), one object per set of them.
const templatesLess = memoized((own) => new Set([...TEMPLATE_MACROS].filter((name) => !own.has(name))), (own) => [...own].toSorted().join())

// The compile units a file is compiled as (see cargo.js unitKey): what `units` recorded, else
// the target's alone.
const DEFAULT_UNITS = new Set([TARGET_UNIT])
const unitsOf = (units, rel) => units?.get(rel) ?? DEFAULT_UNITS
// Add each of `more` to `map`'s set for `file` (the units it is compiled as, the crates it is
// compiled in); whether that is news.
function addTo(map, file, more) {
  const have = map.get(file)
  if (have === undefined) {
    map.set(file, new Set(more))
    return true
  }
  if (more.isSubsetOf(have)) return false
  for (const u of more) have.add(u)
  return true
}
// `units` (a new map for none) with each entry it doesn't name compiled as its package is
// (unitOfCrate): a proc-macro crate's for the host, as cargo builds it, any other's for the target.
function withEntryUnits(units, entries, ctx) {
  const out = units ?? new Map()
  for (const e of entries) if (!out.has(e)) out.set(e, new Set([ctx?.unitOfCrate(e, TARGET_UNIT) ?? TARGET_UNIT]))
  return out
}

// The build `rel` is scanned under (scanRustItems' options): per unit it is compiled as, its features
// (on for certain, on maybe) and its platform's cfgs as far as `ctx` knows them, and whether it is test
// code. Interned per (package, test, units), so a scan of the same build is reused (cachedScan).
const buildMemo = new WeakMap() // ctx -> key -> build
const NO_CTX = {}
function buildOf(rel, ctx, units = null) {
  const test = isTestTarget(rel, ctx)
  const set = unitsOf(units, rel)
  const key = `${ctx?.packageInfo(rel)?.dir ?? ''}\0${test}\0${[...set].toSorted().join()}`
  const memo = nestedMap(buildMemo, ctx ?? NO_CTX)
  return upsert(memo, key, () => {
    const one = (unit) => ({ features: ctx?.featuresFor(rel, unit) ?? null, maybeFeatures: ctx?.maybeFeaturesFor(rel, unit) ?? null, target: ctx?.platformOf(unit)?.cfgs ?? null })
    const each = [...set].map(one)
    return each.length === 1 ? { ...each[0], test } : { units: each, test }
  })
}

// Scan results per `sources` map, so the tree pass reuses the walk's scan of each file when it
// ran under the same build (one interned object, see buildOf) on the same content (a caller may
// edit a file in a map it reuses).
const scanCache = new WeakMap()
function cachedScan(sources, path, content, build, templates = undefined) {
  const cache = upsert(scanCache, sources, () => new Map())
  const key = templates === undefined ? path : `${path}\0${[...templates].join()}` // a rescan with fewer templates, kept beside the plain scan
  const hit = cache.get(key)
  if (hit && hit.content === content && hit.build === build) return hit.items
  const items = scanRustItems(content, templates === undefined ? build : { ...build, templates })
  cache.set(key, { build, content, items })
  return items
}

// The triple from loaded sources: `mod` edges (each crate root's module tree), then paths against it.
// `resolutions`: file → spec (`mod a::b`, a path as written, `use <crate>`) → file, or a cfg key → file
// Map; `missing`: unconditional `mod`s with no file; `wantedRoots`: in-tree roots `sources` lacks.
export function buildRustTree(sources, { roots = [], baseDir = null, cargo = null, formats = null, units: given = null } = {}) {
  const ctx = cargo ?? (baseDir ? createCargoContext(baseDir, { entries: roots }) : null)
  const units = withEntryUnits(given, roots, ctx)
  const rootSet = crateRoots(sources, roots, ctx)
  const resolutions = new Map()
  const missing = []
  const scanned = new Map()
  for (const [path, content] of sources) {
    if (formats?.has(path)) continue // an `include_str!` / `include_bytes!` asset: carried, not Rust
    scanned.set(path, cachedScan(sources, path, content, buildOf(path, ctx, units)))
  }
  // A package defining a `macro_rules!` of a template macro's name (its own `quote!`) invokes that one
  // everywhere in it, so its files that skipped such a body are scanned again without the name. The
  // package: the Cargo context's; without one, a vendored crate's `vendor/<dir>`, else the bundle's.
  const packageOf = memoized((path) => (ctx ? ctx.packageInfo(path)?.dir ?? '.' : path.startsWith(`${VENDOR_DIR}/`) ? path.split('/', 2).join('/') : '.'))
  const ownTemplates = new Map() // package → the template names it defines
  for (const [path, items] of scanned) {
    for (const m of items.macros) if (TEMPLATE_MACROS.has(m.name)) upsert(ownTemplates, packageOf(path), () => new Set()).add(m.name)
  }
  for (const [path, items] of scanned) {
    const own = items.skipped.size > 0 ? ownTemplates.get(packageOf(path)) : undefined
    if (own === undefined || own.isDisjointFrom(items.skipped)) continue
    scanned.set(path, cachedScan(sources, path, sources.get(path), buildOf(path, ctx, units), templatesLess(own)))
  }
  // Bare macro invocations per file, for what a `macro_rules!` body holds: rustc expands it where
  // the macro is invoked -- through the templates that call it, the outermost (effectiveInvokers).
  const invokers = new Map()
  const templateCalls = new Map()
  for (const [path, items] of scanned) noteMacroCalls(invokers, templateCalls, path, items)
  // A `mod` a `macro_rules!` template declares is declared in each module invoking the macro (serde_core's
  // `crate_root! { … pub mod de; … }`, invoked in lib.rs), of its own package unless `#[macro_export]`ed;
  // it stands at the invocation and keeps its defining file (`definedIn`), whose mounting cfgs it takes.
  const hosted = new Map() // file → the template `mod`s it declares by invoking their macros
  const hostedAway = new Set() // the template `mod`s that moved to their invokers
  for (const [path, items] of scanned) {
    for (const decl of items.mods) {
      if (decl.template === null) continue
      const exported = items.macros.some((m) => m.name === decl.template && m.exported)
      const hosts = hostsOf(decl.template, path, invokers, templateCalls, exported ? null : packageOf)
      if (hosts.length === 0) continue
      hostedAway.add(decl)
      for (const f of hosts) for (const copy of hostedCopies(decl, scanned.get(f), templateCalls)) upsert(hosted, f, () => []).push({ ...copy, definedIn: path })
    }
  }
  const modsOf = (path) => [...scanned.get(path).mods.filter((d) => !hostedAway.has(d)), ...(hosted.get(path) ?? [])]
  // An `include!`d file's items join the includer's module (buildModuleTrees), but a `mod` it
  // declares resolves beside the included file itself, as rustc does: like a `#[path]`-loaded
  // file, it owns its directory (pathLoaded).
  const pathLoaded = new Set()
  for (const [path, items] of scanned) {
    for (const inc of items.includes) {
      if (inc.kind !== 'include') continue
      const file = includeTarget(inc, path, ctx)
      if (file !== null && file !== path && sources.has(file)) pathLoaded.add(file)
    }
  }
  // Files a `#[path]` names own their directory too (see getModuleDir), so find those before
  // resolving any default `mod` lookup; a path-loaded file may itself hold inline modules with
  // `#[path]`s, hence the loop to a fixed point.
  const modOpts = { knownSources: sources, roots: rootSet, pathLoaded }
  const declsOf = (path, decl) => resolveModDecl(decl, path, { ...modOpts, boundary: boundaryOf(path, ctx) })
  for (let grew = true; grew;) {
    grew = false
    for (const path of scanned.keys()) {
      for (const decl of modsOf(path)) {
        if (decl.paths.length === 0) continue
        for (const t of declsOf(path, decl)) {
          if (t.explicit && !pathLoaded.has(t.file)) {
            pathLoaded.add(t.file)
            grew = true
          }
        }
      }
    }
  }
  // The include macros a `macro_rules!` body holds name files relative to each file in effect
  // invoking the macro, recorded there, as `include_str <path>`. Every definition of a name counts
  // (two `macro_rules! m` in two files: both bodies' assets).
  const includeEdges = new Map() // file → [{ kind, path, base, conditional }] from macro templates it invokes
  for (const [, items] of scanned) {
    for (const m of items.macros) {
      if (m.includes.length === 0) continue
      for (const f of effectiveInvokers(m.name, invokers, templateCalls)) {
        const list = upsert(includeEdges, f, () => [])
        for (const inc of m.includes) list.push({ ...inc, conditional: true })
      }
    }
  }
  // file → spec → target file → the declarations mounting it, each its cfg (null for an ungated
  // one), the macro body it sits in and -- for a hosted template `mod` -- the declarations here
  // mounting the file defining it (`via`), for the cfg leaves each file carries (buildModuleTrees).
  const mountCfgs = new Map()
  for (const [path, items] of scanned) {
    // spec → cfg key → file: each declaration's files under its cfg ('*' ungated, `<macro>!` for one a
    // macro emits under a cfg the loader can't see), so same-name `mod`s under different cfgs keep each
    // file. The first declaration of a key wins; another file under it gets the key numbered (`*#2`).
    const byCfg = new Map()
    const cfgsHere = nestedMap(mountCfgs, path)
    for (const decl of modsOf(path)) {
      const spec = `mod ${[...decl.inlinePath, decl.name].join('::')}`
      const targets = declsOf(path, decl)
      if (targets.length === 0) {
        // conditional && unresolved: cfg-gated module, may be compiled out -- tolerated.
        if (!decl.conditional) {
          console.warn(`[loader.rust] Missing module: ${decl.name} from ${path}`)
          missing.push({ spec, from: path })
        }
        continue
      }
      const keyed = nestedMap(byCfg, spec)
      const byFile = nestedMap(cfgsHere, spec)
      for (const t of targets) {
        const cfg = t.cfg ?? decl.cfg ?? null
        const base = cfgKey(cfg ?? (decl.macro === null ? null : `${decl.macro}!`))
        let key = base
        for (let k = 2; keyed.has(key) && keyed.get(key) !== t.file; k++) key = `${base}#${k}`
        if (!keyed.has(key)) keyed.set(key, t.file)
        const via = decl.definedIn === undefined ? undefined : [...cfgsHere.values()].flatMap((m) => m.get(decl.definedIn) ?? [])
        upsert(byFile, t.file, () => []).push({ cfg, macro: decl.macro, via })
      }
    }
    // A single file is a flat string -- also when every cfg names the same file (libc's `mod
    // primitives` under a dozen); cfg variants stay a Map.
    const specMap = new Map()
    for (const [spec, keyed] of byCfg) {
      const distinct = new Set(keyed.values())
      specMap.set(spec, distinct.size === 1 ? [...distinct][0] : keyed)
    }
    // `include!("generated/consts.rs")` and the asset macros name a file relative to this one (or
    // to the package root), the ones in a macro body it invokes relative to this one too.
    for (const inc of [...items.includes, ...(includeEdges.get(path) ?? [])]) {
      const file = includeTarget(inc, path, ctx)
      if (file !== null && file !== path && sources.has(file)) specMap.set(`${inc.kind} ${inc.path}`, file)
      else if (!inc.conditional) console.warn(`[loader.rust] Missing include: ${inc.path} from ${path}`)
    }
    if (items.unfollowed > 0) console.warn(`[loader.rust] ${items.unfollowed} include${items.unfollowed === 1 ? '' : 's'} in ${path} name${items.unfollowed === 1 ? 's' : ''} a path the loader can't follow (not a literal)`)
    resolutions.set(path, specMap)
  }

  // Each package's gate macros (`cfg_x!`), by name: the cfg its definition wraps items in, or null
  // when that can't be read -- or when the package defines the name twice, differently.
  const gatesByPackage = new Map()
  for (const [path, items] of scanned) {
    for (const m of items.macros) {
      if (m.gate === undefined) continue
      const gates = upsert(gatesByPackage, packageOf(path), () => new Map())
      gates.set(m.name, gates.has(m.name) && gates.get(m.name) !== m.gate ? null : m.gate)
    }
  }
  const gatesOf = (path) => gatesByPackage.get(packageOf(path)) ?? null
  const { trees, files } = buildModuleTrees(sources, resolutions, rootSet, new Map([...scanned].map(([p, items]) => [p, items.inlineModules])), mountCfgs, gatesOf)
  // What each file asks as: itself, with the cfg leaves it was mounted under (see cfg
  // compatibility), as an interned leaf set (leafSets: every set of this tree, by key).
  const leafSets = new Map()
  const askerSets = new Map() // per leaf set, build and settable cfgs: what every asker of those shares
  const ids = new WeakMap()
  let nextId = 0
  const idOf = (object) => upsert(ids, object, () => nextId++)
  // A file's platform cfgs, when known, hold for it: a `unix` asker never takes a `windows` candidate.
  // The platform is the target's, or the host's for a build script; a file compiled for both asks under
  // the cfgs they share, known only when they are one.
  const leavesOfCfgs = memoized((cfgs) => leafSet([...cfgs].flatMap(cfgLeaves).filter((l) => TARGET_CFG_KEYS.has(l.key)), leafSets))
  const platformCfgsOf = (path) => {
    const each = new Set([...unitsOf(units, path)].map((u) => ctx?.platformOf(u)?.cfgs ?? null))
    return each.size === 1 ? [...each][0] : null
  }
  for (const [path, f] of files) {
    f.leaves = leafSet(f.leaves, leafSets)
    const cfgs = platformCfgsOf(path)
    const joined = cfgs === null ? f.leaves : unionLeaves(f.leaves, leavesOfCfgs(cfgs), leafSets)
    // A file the target rules out (tokio's atomic_u64_as_mutex.rs on a 64-bit target) asks under its own
    // cfgs, as where it is compiled. One whose own contradict each other is compiled nowhere: every
    // candidate is compatible with it, none certain (`contradictory`).
    const set = joined !== f.leaves && cfgExclusive(joined.leaves, joined.leaves) && !cfgExclusive(f.leaves.leaves, f.leaves.leaves) ? f.leaves : joined
    const build = buildOf(path, ctx, units)
    const settable = ctx?.cfgsSetFor(path) ?? null
    const sharedKey = `${set.key}\0${idOf(build)}\0${settable === null ? '' : idOf(settable)}`
    const shared = upsert(askerSets, sharedKey, () => ({ keys: new Set(set.leaves.map(leafKey)), compat: new Map(), sure: new Map(), doubt: new Map(), dead: new Map(), texts: new Map(), build, deadHere: deadUnder(set.leaves, build), contradictory: cfgExclusive(set.leaves, set.leaves), custom: customFor(settable) }))
    f.asker = { file: path, set, ...shared }
  }
  // Per crate root, each module's child modules by name (every module's parent is in its tree).
  const children = new Map()
  for (const [root, tree] of trees) {
    const byParent = new Map()
    for (const modulePath of tree.keys()) {
      const cut = modulePath.lastIndexOf('::')
      if (cut === -1) continue
      const parent = modulePath.slice(0, cut)
      upsert(byParent, parent, () => new Set()).add(modulePath.slice(cut + 2))
    }
    children.set(root, byParent)
  }
  // Per crate root, each module's files: a `mod` with cfg variants has several, any of which a
  // build may compile (walkPath asks whether one of them may be there at all).
  const moduleFiles = new Map()
  for (const [path, f] of files) {
    const byModule = nestedMap(moduleFiles, f.root)
    upsert(byModule, f.modulePath, () => []).push(path)
  }
  // Per crate root, what a path may continue along where a segment names no module: each module's
  // imports (`named` by binding, `globs`) and items (`defined`), with `scopeDepth` (how far their
  // visibility reaches) and cfg `leaves`; `modScope`; `#[macro_export]` macros; `externPrelude`.
  const imports = new Map()
  const defined = new Map()
  const modScope = new Map()
  const macros = new Map()
  const exportedMacros = new Map() // root -> name -> every `#[macro_export]` definition, `{ file, leaves }`
  const fileMacros = new Map()
  const externPrelude = new Map()
  // An import's or item's leaves: those its file (`here`) was mounted under, its own cfg's, and
  // its gate macro's.
  const itemLeaves = (here, x, path) => unionLeaves(here.leaves, leafSet([...cfgLeaves(x.cfg), ...gateLeaves(x.macro, gatesOf(path))], leafSets), leafSets)
  const scopeDepthOf = (vis, modulePath) => visibilityScope(vis, modulePath).split('::').length
  // Bare `name!` calls resolve in textual scope, as in rustc: a `macro_rules!` is in scope to the end of
  // its file, in the files the `mod`s after it mount, and past a `#[macro_use] mod` in the mounting file.
  // `mounts`: file → the `mod` (or `include!`) first mounting it; `macroUseMods`: file → its such `mod`s.
  const mounts = new Map()
  const macroUseMods = new Map()
  const filesOf = (target) => (target instanceof Map ? [...target.values()] : [target])
  // In tree order (each crate's from its root down, a `mod`'s variants as declared), whatever order the
  // sources came in: among several files defining or importing a name for one module the tree's own
  // comes first, the same for any order the caller lists the files in.
  for (const [path, here] of files) {
    const items = scanned.get(path)
    if (items === undefined) continue
    for (const im of items.imports) {
      // A `use $crate::…` in a `macro_rules!` template is the invoking module's, wherever that is.
      // (A `use` without `$crate` in one is kept: serde wraps its whole root in a macro, whose
      // `mod lib { pub use core::fmt; … }` is what every file's `use crate::lib::*` names.)
      if (im.template === true) continue
      const modulePath = [here.modulePath, ...im.inlinePath].join('::')
      const byModule = nestedMap(imports, here.root)
      const of = upsert(byModule, modulePath, () => ({ named: new Map(), globs: [] }))
      const entry = { ...im, file: path, module: modulePath, scopeDepth: scopeDepthOf(im.vis, modulePath), leaves: itemLeaves(here, im, path) }
      if (im.glob) of.globs.push(entry)
      else if (im.binding !== null) upsert(of.named, im.binding, () => []).push(entry)
    }
    for (const d of items.defined) {
      const modulePath = [here.modulePath, ...d.inlinePath].join('::')
      const byModule = nestedMap(defined, here.root)
      const names = nestedMap(byModule, modulePath)
      upsert(names, d.name, () => []).push({ file: path, scopeDepth: scopeDepthOf(d.vis, modulePath), ns: d.ns, leaves: itemLeaves(here, d, path) })
    }
    const scopes = nestedMap(modScope, here.root)
    const specMap = resolutions.get(path)
    for (const decl of modsOf(path)) {
      const parent = [here.modulePath, ...decl.inlinePath].join('::')
      const modulePath = `${parent}::${decl.name}`
      if (!scopes.has(modulePath)) scopes.set(modulePath, scopeDepthOf(decl.vis, parent))
      const target = specMap.get(`mod ${[...decl.inlinePath, decl.name].join('::')}`)
      if (target === undefined) continue
      const mountedFiles = filesOf(target).filter((f) => f !== path)
      const mount = { parent: path, offset: decl.offset, at: decl.at }
      for (const f of mountedFiles) if (!mounts.has(f)) mounts.set(f, mount)
      if (decl.macroUse && mountedFiles.length > 0) upsert(macroUseMods, mount.parent, () => []).push({ offset: mount.offset, at: mount.at, files: mountedFiles })
    }
    for (const [spec, target] of specMap) {
      if (spec.startsWith('include ') && !mounts.has(target) && target !== path) mounts.set(target, { parent: path, offset: Infinity, at: Infinity })
    }
    for (const [inline, vis] of items.inlineModuleVis) {
      const modulePath = `${here.modulePath}::${inline}`
      if (!scopes.has(modulePath)) scopes.set(modulePath, scopeDepthOf(vis, modulePath.slice(0, modulePath.lastIndexOf('::'))))
    }
    fileMacros.set(path, new Set(items.macros.map((m) => m.name)))
    for (const m of items.macros) {
      if (!m.exported) continue
      const byName = nestedMap(macros, here.root)
      if (!byName.has(m.name)) byName.set(m.name, path)
      const defs = nestedMap(exportedMacros, here.root)
      upsert(defs, m.name, () => []).push({ file: path, leaves: itemLeaves(here, m, path) })
    }
    if (here.modulePath === 'crate') {
      const prelude = nestedMap(externPrelude, here.root)
      for (const e of items.externCrates) {
        // `extern crate self as x;` puts this crate's root in the prelude as `x` (kept as `self`).
        const named = e.name === 'self' ? e.alias !== null : !NON_CRATE_LEADS.has(e.name)
        if (e.inlinePath.length === 0 && named && !prelude.has(e.alias ?? e.name)) prelude.set(e.alias ?? e.name, e.name)
      }
    }
  }
  // The macros a file mounted with `#[macro_use]` hands the file mounting it: its own and, in
  // turn, its own `#[macro_use] mod`s' (name → defining file).
  const exportsMemo = new Map()
  const macroExports = (file, guard = new Set()) => {
    if (exportsMemo.has(file)) return exportsMemo.get(file)
    if (guard.has(file)) return new Map()
    guard.add(file)
    const out = new Map()
    for (const { files: mountedFiles } of macroUseMods.get(file) ?? []) for (const f of mountedFiles) for (const [name, where] of macroExports(f, guard)) out.set(name, where)
    for (const name of fileMacros.get(file) ?? []) out.set(name, file)
    exportsMemo.set(file, out)
    return out
  }
  // A file's macro events in source order, `{ offset, at, macros }` (name → defining file): its own
  // `macro_rules!` and what its `#[macro_use] mod`s hand it. `offset` is where an item stands, `at` where
  // it is written: they differ for what a template emits (serde's `tri`, standing at `crate_root!`).
  const fileEvents = memoized((file) => [
    ...(scanned.get(file)?.macros ?? []).map((m) => ({ offset: m.offset, at: m.at, macros: new Map([[m.name, file]]) })),
    ...(macroUseMods.get(file) ?? []).map((u) => ({ offset: u.offset, at: u.at, macros: new Map(u.files.flatMap((f) => [...macroExports(f)])) })),
  ].toSorted((a, b) => a.offset - b.offset || a.at - b.at))
  const before = (e, offset, at) => e.offset < offset || (e.offset === offset && e.at < at)
  // The macros in textual scope in `file` before position (`offset`, `at`) -- (Infinity,
  // Infinity): its end -- on top of `scope`, what it sees from above: the later definition of a
  // name shadows the earlier, whichever kind each is.
  const textualScope = (file, offset, at, scope) => {
    const out = new Map(scope)
    for (const e of fileEvents(file)) {
      if (!before(e, offset, at)) break
      for (const [name, where] of e.macros) out.set(name, where)
    }
    return out
  }
  // The file defining the macro `name` in scope at (`offset`, `at`) in `file`: the last event
  // before that point defining it, else what the file sees from above (`scope`); a definition
  // later in the file doesn't reach an earlier call.
  const macroAt = (file, name, offset, at, scope) =>
    fileEvents(file).findLast((e) => before(e, offset, at) && e.macros.has(name))?.macros.get(name) ?? scope.get(name)
  // What a file sees from above: what its parent sees from above, and the parent's textual scope
  // at the `mod` mounting it.
  const inheritedMemo = new Map()
  const inherited = (file, guard = new Set()) => {
    if (inheritedMemo.has(file)) return inheritedMemo.get(file)
    const mount = mounts.get(file)
    if (mount === undefined || guard.has(file)) return new Map()
    guard.add(file)
    const out = textualScope(mount.parent, mount.offset, mount.at, inherited(mount.parent, guard))
    inheritedMemo.set(file, out)
    return out
  }
  // Crate names resolve per file (a package's renames, a build script's tables, its platforms), and the
  // same (name, file) comes up once per reference: `{ file, alternatives }`, the crate root and, when
  // tables that may each apply name different packages (cargo.js crateCandidates), each by platform.
  const crates = new Map()
  const crateOf = (name, from) => upsert(crates, `${name}\0${from}`, () => {
    const found = ctx ? ctx.crateCandidates(name, from, { roots: files.get(from)?.roots ?? null, units: unitsOf(units, from) }) : []
    const file = found[0]?.file ?? resolveVendoredCrate(name, { knownSources: sources })
    return { file, alternatives: found.length > 1 ? new Map(found.map((c) => [cfgKey(c.key), c.file])) : undefined }
  })
  const resolveCrate = (name, from) => crateOf(name, from).file
  const crateAlternatives = (name, from) => crateOf(name, from).alternatives
  // The crates a crate root's `#[macro_use] extern crate`s bring the exported macros of into every
  // module's scope, as their roots.
  const macroUseCrates = memoized((root) => (scanned.get(root)?.externCrates ?? []).filter((e) => e.macroUse && !NON_CRATE_LEADS.has(e.name)).map((e) => resolveCrate(e.name, root)).filter(Boolean))
  // One context for every path of every file: `provided` memoizes across them (see walkPath).
  // Per crate root, name → the modules with anything of the name (a child module, an item, an
  // import binding it; the root for an exported macro): what hasAll may answer for.
  const having = new Map()
  for (const [root, byParent] of children) for (const [parent, names] of byParent) for (const name of names) note(having, root, name, parent)
  for (const [root, byModule] of defined) for (const [module, names] of byModule) for (const name of names.keys()) note(having, root, name, module)
  for (const [root, byModule] of imports) for (const [module, of] of byModule) for (const name of of.named.keys()) note(having, root, name, module)
  for (const [root, byName] of macros) for (const name of byName.keys()) note(having, root, name, 'crate')
  const declaresCrate = (name, from) => ctx?.declaresCrate?.(name, from) === true
  const pathCtx = { trees, children, moduleFiles, files, resolveCrate, crateAlternatives, declaresCrate, imports, defined, modScope, macros, exportedMacros, fileMacros, externPrelude, leafSets, having, provided: new Map(), closures: new Map(), opaque: new Map(), opaqueGlobs: new Map(), walking: 0, hits: new Set() }
  // Every path of every file, on top of the `mod` / include edges (`resolutions`): once, and once
  // more when the first pass left glob closures short of an import cycle (stabilizeClosures).
  const resolveAll = () => {
    const out = new Map()
    const unresolved = new Set()
    const wanted = new Map() // root -> the units it is wanted as
    for (const [path, items] of scanned) {
      const specMap = new Map(resolutions.get(path))
      out.set(path, specMap)
      resolveFile(path, items, specMap, unresolved, wanted)
    }
    return { out, unresolved, wanted }
  }
  const resolveFile = (path, items, specMap, unresolved, wanted) => {
    // Only edges to bundled files, never to self, first spelling wins. A target with
    // `alternatives` (withAlternatives) is recorded as the cfg-keyed map of them -- as a `mod`
    // with cfg variants is -- less the asking file and files not bundled; one file left is a plain edge.
    const add = (spec, target, alternatives) => {
      if (specMap.has(spec)) return
      if (alternatives !== undefined) {
        const keyed = new Map([...alternatives].filter(([, f]) => f !== path && sources.has(f)))
        const distinct = new Set(keyed.values())
        if (distinct.size > 1) {
          specMap.set(spec, keyed)
          return
        }
        if (distinct.size === 1) [target] = distinct
      }
      if (target && target !== path && sources.has(target)) specMap.set(spec, target)
    }
    // A crate resolved to a root the walk didn't load (its name was bound in the walking file as
    // a value, see resolvePathRef), or loaded as fewer units than this file names it as: the
    // caller may load it and build again.
    const addCrate = (name, target, alternatives) => {
      for (const file of alternatives === undefined ? [target] : alternatives.values()) {
        if (file && ctx) {
          const want = new Set([...unitsOf(units, path)].map((u) => ctx.unitOfCrate(file, u)))
          const have = sources.has(file) ? unitsOf(units, file) : new Set()
          if (!want.isSubsetOf(have)) for (const u of want) upsert(wanted, file, () => new Set()).add(u)
        } else if (file && !sources.has(file)) wanted.set(file, DEFAULT_UNITS)
      }
      add(`use ${name}`, target, alternatives)
    }
    // A crate name nothing in-tree satisfied -- sysroot crates aside, and an uppercase lead is an
    // `Enum::Variant` import, not a crate.
    const noteUnresolved = (name) => {
      if (!OTHER_SYSROOT_CRATES.has(name) && /^[a-z_]/u.test(name)) unresolved.add(name)
    }
    const here = files.get(path)
    const via = new Map() // file → the prefix of a path that went through an import of a module there
    for (const ref of items.refs) {
      const r = resolvePathRef(ref, path, items.bindings, pathCtx)
      if (r === null) continue
      if (r.kind === 'crate') {
        addCrate(r.name, r.file, r.alternatives)
        if (r.macro !== undefined) add(`${ref.spec}!`, r.macro.file, r.macro.alternatives)
      }
      else if (r.kind === 'unresolved') {
        // Only a `use` reliably says its lead names a crate (see scanRustItems' `fromUse`) -- or
        // the package declaring a dependency of that name (`serde_json::to_string(…)`), which it
        // then is.
        if (ref.fromUse || declaresCrate(r.name, path)) noteUnresolved(r.name)
        continue
      } else add(ref.macroCall ? `${ref.spec}!` : ref.spec, r.file, r.alternatives) // `crate::helper!()` beside `crate::helper()`: two edges
      // The module an import was followed from, when the path's own segments name it (`super`,
      // `crate::util`) and its file is neither this one nor the crate root, which every file of
      // the crate hangs off anyway.
      const v = r.via
      if (v && v.consumed > 0 && v.through !== path && v.through !== here.root && v.through !== r.file && !via.has(v.through)) {
        via.set(v.through, ref.segments.slice(0, v.consumed).join('::'))
      }
    }
    for (const { name } of items.externCrates) {
      if (NON_CRATE_LEADS.has(name)) continue // `extern crate self as x;` / `extern crate alloc;`
      const { file: target, alternatives } = crateOf(name, path)
      if (target) addCrate(name, target, alternatives)
      else noteUnresolved(name)
    }
    // A macro invoked by bare name: a `macro_rules!` in textual scope (this file's, handed down from the
    // files above or by a `#[macro_use] mod`, and at the crate root the exported ones), else one the
    // module's imports bring in. (A `macro_rules! vec` in some sibling file is not what `vec!` names.)
    if (here !== undefined) {
      const above = inherited(path)
      const exported = here.modulePath === 'crate' ? macros.get(here.root) : undefined
      // The macro a bare call of `name` at `offset` names, `{ file, name }` by the name it is defined
      // under: in textual scope, else one an import or a root's `#[macro_use] extern crate` brings in.
      const macroFileAt = (name, offset) => {
        const inScope = macroAt(path, name, offset, offset, above) ?? exported?.get(name)
        if (inScope !== undefined) return { file: inScope, name }
        const byPath = walkPath([name], here.root, here.modulePath, pathCtx, { ns: 'macro', file: path, asker: here.asker })
        const as = byPath?.macroName ?? name
        if (byPath?.file !== undefined && definesMacro(pathCtx, byPath.file, as)) return { file: byPath.file, name: as, alternatives: macroAlternatives(pathCtx, byPath.alternatives, as) }
        for (const crate of macroUseCrates(here.root)) {
          const macro = macroOfCrate(crate, [name], pathCtx)
          if (macro !== null) return { file: macro.file, name: macro.macroName, alternatives: macro.alternatives }
        }
        return undefined
      }
      for (const [name, offsets] of items.calls) {
        // Scope is decided at each call (a later `macro_rules!` doesn't shadow what an earlier
        // `#[macro_use] mod` handed an earlier call); the bare calls in the invoked macro's template, on
        // down, are made here too, as rustc expands them.
        const found = new Map() // `name!\0file` -> the cfg-keyed files, when several may define it
        for (const offset of offsets) {
          const seen = new Set()
          const expand = (called) => {
            if (seen.has(called)) return
            seen.add(called)
            const macro = macroFileAt(called, offset)
            if (macro === undefined) return
            found.set(`${called}!\0${macro.file}`, macro.alternatives)
            for (const m of scanned.get(macro.file)?.macros ?? []) if (m.name === macro.name) for (const inner of m.calls) expand(inner)
          }
          expand(name)
        }
        for (const [edge, alternatives] of found) {
          const cut = edge.indexOf('\0')
          add(edge.slice(0, cut), edge.slice(cut + 1), alternatives)
        }
      }
    }
    // A module whose import a path went through is a dependency of the file too (bitflags'
    // `$crate::__private::serde::Serialize` needs the root's `__private`): when nothing else points at
    // its file, the path's prefix naming it records it (`crate::__private` → lib.rs).
    const targets = new Set()
    for (const t of specMap.values()) for (const f of t instanceof Map ? t.values() : [t]) targets.add(f)
    for (const [owner, spec] of via) if (!targets.has(owner)) add(spec, owner)
  }
  let { out, unresolved, wanted } = resolveAll()
  if (stabilizeClosures(pathCtx)) ({ out, unresolved, wanted } = resolveAll())
  return { sources, resolutions: out, missing, unresolvedCrates: unresolved, wantedRoots: [...wanted.keys()], wantedUnits: wanted }
}

// --- Disk walk --------------------------------------------------------------------------

// Walk from `entries` (crate roots), following `mod`s and references to in-tree crates, reading each
// file once into `sources` (an earlier walk's too: a file now compiled as more units is gone through
// again); `units`/`crateRoots`: file → its compile units / crates; `unloaded`: files refused or gone.
export async function collectRustFilesFromDisk(baseDir, entries, { cargo = null, formats = null, sources = new Map(), units = new Map(), crateRoots: rootsOf = new Map(), unloaded = new Set() } = {}) {
  const realBase = realpathSync(baseDir)
  const roots = new Set(entries)
  const pathLoaded = new Set() // files a `#[path]` named: their submodules sit beside them
  const assets = new Map() // files an `include_str!` / `include_bytes!` names: carried as they are, not scanned
  const rustFiles = new Set(entries) // files named as Rust source (a `mod`, an `include!`): scanned, never an asset
  const ctx = cargo ?? createCargoContext(baseDir, { entries })
  const modOpts = { baseDir, roots, pathLoaded }
  // file → the directory it must really lie in (boundaryOf, from the file that named it): a
  // vendored crate's files stay in its package, symlinks included.
  const boundaries = new Map(entries.map((e) => [e, boundaryOf(e, ctx)]))
  const realDirs = new Map() // those directories' real paths
  // Template macros' includes and `mod`s name files relative to each file in effect invoking them;
  // definitions and invocations arrive in any order, so each side is kept and paired.
  const templateIncludes = new Map() // macro name → its bodies' includes
  const templateMods = new Map() // macro name → its bodies' `mod`s, each `{ decl, from }` (see buildRustTree)
  const templateCalls = new Map() // macro name → the names its bodies call by bare name
  const invokers = new Map() // macro name → the files invoking it, by bare name or by path
  const scansOf = new Map() // file → its scan, for where it invokes what (hostedCopies)
  // A package defining a `macro_rules!` of a template macro's name (its own `quote!`) invokes that
  // one everywhere in the package (see buildRustTree): its files are scanned without the name in
  // the template set -- again, for the ones scanned before the definition was met.
  const packageOf = (rel) => ctx.packageInfo(rel)?.dir ?? '.'
  const ownTemplates = new Map() // package → the template names it defines
  const skippedIn = new Map() // package → its files that skipped a template body
  const scanFor = (relPath, content) => {
    const own = ownTemplates.get(packageOf(relPath))
    return cachedScan(sources, relPath, content, buildOf(relPath, ctx, units), own === undefined ? undefined : templatesLess(own))
  }
  withEntryUnits(units, entries, ctx)
  for (const e of entries) addTo(rootsOf, e, new Set([e]))
  // Files already walked that are now compiled as more units, or in more crates: gone through
  // again (their build changed, and so may what they name, and as what).
  const revisit = new Set(entries.filter((e) => sources.has(e) && !formats?.has(e)))

  // What a Rust file names, queued for the next wave: compiled as the naming file is -- as its
  // units, a crate as unitOfCrate says (`as`); in its crates, or the crate it is the root of
  // (`crate`) -- and, for a vendored crate's, within its package (`within`).
  let next = []
  const queue = (from, file, { rust, within = boundaryOf(from, ctx), as = unitsOf(units, from), crate = null }) => {
    if (rust) {
      rustFiles.add(file)
      // Named as Rust source after being carried as an asset: read again, as source.
      if (assets.delete(file) && sources.has(file)) {
        sources.delete(file)
        formats?.delete(file)
      }
    }
    if (!boundaries.has(file)) boundaries.set(file, within)
    const inCrates = addTo(rootsOf, file, crate === null ? rootsOf.get(from) ?? new Set([from]) : new Set([crate]))
    const grew = addTo(units, file, as) || inCrates
    if (!sources.has(file)) next.push(file)
    else if (grew && rust && !formats?.has(file)) revisit.add(file)
  }
  // An include macro's file, relative to `from` (the file it is written in, or one invoking the
  // macro whose body it is in).
  const includeFrom = (inc, from) => {
    const file = includeTarget(inc, from, ctx)
    if (file === null || file === from) return
    // A FIFO or device named would hang the read; a missing file is the tree pass's to report.
    if (!sources.has(file) && !isFile(join(baseDir, file))) return
    if (inc.kind === 'include') {
      pathLoaded.add(file) // its own `mod`s resolve beside it, as rustc has it
      queue(from, file, { rust: true })
    } else if (!rustFiles.has(file) && !sources.has(file)) {
      assets.set(file, inc.kind)
      queue(from, file, { rust: false })
    }
  }
  // A `mod` declaration's files, relative to `from` (the file it is written in, or one invoking
  // the macro whose body it is in).
  const modFrom = (decl, from) => {
    for (const { file, explicit } of resolveModDecl(decl, from, { ...modOpts, boundary: boundaryOf(from, ctx) })) {
      if (explicit) pathLoaded.add(file)
      queue(from, file, { rust: true })
    }
  }
  // The include macros of every template, relative to every file in effect invoking it; its
  // `mod`s relative to those of its own package.
  const hostsOfMod = (name, { from, exported }) => hostsOf(name, from, invokers, templateCalls, exported ? null : packageOf)
  const expandTemplates = () => {
    for (const [name, incs] of templateIncludes) {
      for (const f of effectiveInvokers(name, invokers, templateCalls)) for (const inc of incs) includeFrom(inc, f)
    }
    for (const [name, decls] of templateMods) {
      for (const t of decls.values()) for (const f of hostsOfMod(name, t)) for (const copy of hostedCopies(t.decl, scansOf.get(f), templateCalls)) modFrom(copy, f)
    }
  }

  // A template's `mod`s that nothing in its package invokes by bare name stand beside its
  // definition (see buildRustTree): walked once nothing else is left to, and what they name after.
  const placed = new Set()
  const placeUninvoked = () => {
    for (const [name, decls] of templateMods) {
      for (const t of decls.values()) {
        if (placed.has(t.decl) || hostsOfMod(name, t).length > 0) continue
        placed.add(t.decl)
        modFrom(t.decl, t.from)
      }
    }
  }

  const processWave = async (wave) => {
    const toLoad = [...new Set(wave)].filter((p) => !sources.has(p))
    if (toLoad.length === 0 && revisit.size === 0) return
    const reads = await Promise.all(
      toLoad.map(async (relPath) => {
        try {
          assertRealPathWithinBase(realBase, baseDir, relPath)
          if (!withinRealDir(baseDir, relPath, boundaries.get(relPath) ?? '.', { realDirs })) {
            unloaded.add(relPath)
            return null
          }
          // Rust source (a module, a build script, an `include!`d file) and an `include_str!` asset
          // are UTF-8 text, or rustc rejects them: one that isn't is refused, never carried with
          // its bytes replaced. An `include_bytes!` asset is any bytes, carried as base64 if need be.
          const kind = assets.get(relPath)
          const buf = await readFile(join(baseDir, relPath))
          ctx.checkVendoredFile?.(relPath, buf)
          const utf8 = isUtf8(buf)
          if (!utf8 && kind !== 'include_bytes') throw new Error(`${kind === undefined ? 'Rust source' : 'include_str! file'} is not valid UTF-8: ${relPath}`)
          if (kind === undefined) return [relPath, buf.toString('utf8'), false]
          formats?.set(relPath, utf8 ? 'resource' : 'resource:base64')
          return [relPath, utf8 ? buf.toString('utf8') : buf.toString('base64'), true]
        } catch (err) {
          if (err.code === 'ENOENT') {
            console.warn(`[loader.rust] Missing file: ${relPath}`)
            unloaded.add(relPath)
            return null
          }
          // resolveModPath gates on isFile so a dir is normally never queued; guard EISDIR anyway.
          if (err.code === 'EISDIR') {
            console.warn(`[loader.rust] Skipping directory reference: ${relPath}`)
            return null
          }
          throw err
        }
      })
    )
    next = []
    // What a Rust file names, queued (see queue). Run again for a file whose package turned out
    // to define a template macro (below): the file's `quote!` bodies are its own then.
    const handle = (relPath, content) => {
      const here = unitsOf(units, relPath)
      const items = scanFor(relPath, content)
      const { mods, refs, externCrates, bindings, includes, macros } = items
      const pkg = packageOf(relPath)
      if (items.skipped.size > 0) upsert(skippedIn, pkg, () => new Set()).add(relPath)
      for (const m of macros) {
        if (!TEMPLATE_MACROS.has(m.name)) continue
        const own = upsert(ownTemplates, pkg, () => new Set())
        if (own.has(m.name)) continue
        own.add(m.name)
        for (const f of skippedIn.get(pkg) ?? []) if (f !== relPath) handle(f, sources.get(f))
      }
      // An `include!`d file's `mod`s resolve beside it (it is in `pathLoaded`), within its package; a
      // template's `mod`s wait for the files invoking it (expandTemplates).
      for (const decl of mods) {
        if (decl.template === null) modFrom(decl, relPath)
        else nestedMap(templateMods, decl.template).set(`${relPath}\0${decl.at}`, { decl, from: relPath, exported: macros.some((m) => m.name === decl.template && m.exported) })
      }
      // `include!("x.rs")` splices Rust source (scanned next wave, under this module); the asset macros
      // name a file to carry as it is. A template's include macros wait for its invokers (expandTemplates).
      for (const inc of includes) includeFrom(inc, relPath)
      for (const m of macros) {
        if (m.includes.length === 0) continue
        const list = upsert(templateIncludes, m.name, () => [])
        for (const inc of m.includes) if (!list.some((x) => x.kind === inc.kind && x.path === inc.path && x.base === inc.base)) list.push(inc)
      }
      noteMacroCalls(invokers, templateCalls, relPath, items)
      scansOf.set(relPath, items)
      // A reference to an in-tree crate pulls its root in (a crate root by role, whatever its
      // name -- `[lib] path` may point anywhere); the root's own `mod` edges follow next wave.
      const leads = new Set()
      for (const e of externCrates) if (!NON_CRATE_LEADS.has(e.name)) leads.add(e.name)
      for (const r of refs) {
        const name = crateLead(r, bindings)
        if (name !== null) leads.add(name)
      }
      for (const name of leads) {
        for (const { file: lib } of ctx.crateCandidates(name, relPath, { roots: rootsOf.get(relPath) ?? null, units: here })) {
          roots.add(lib)
          queue(relPath, lib, { rust: true, within: boundaryOf(lib, ctx), as: new Set([...here].map((u) => ctx.unitOfCrate(lib, u))), crate: lib })
        }
      }
    }
    for (const entry of reads) {
      if (!entry) continue
      const [relPath, content, asset] = entry
      sources.set(relPath, content)
      if (!asset) handle(relPath, content)
    }
    for (;;) {
      expandTemplates()
      if (revisit.size === 0) break
      const again = [...revisit]
      revisit.clear()
      for (const relPath of again) handle(relPath, sources.get(relPath))
    }
    if (next.length === 0) placeUninvoked()
    await processWave(next)
  }

  await processWave(entries)
  return sources
}

// The files of a Rust bundle of `entries` from disk and its tree, `{ sources, formats, tree }`: the walk,
// with every reached package's build script as a crate root (`buildScripts`), then the tree pass, walking
// again the roots it wants (`wantedRoots`) until none is new; one refused or gone isn't asked for again.
export async function collectRustBundle(baseDir, entries, { cargo, buildScripts = false }) {
  const formats = new Map()
  const sources = new Map()
  const units = new Map()
  const rootsOf = new Map()
  const unloaded = new Set() // what the walk refused or found gone: said once
  const roots = [...entries]
  const walk = async (wave) => {
    await collectRustFilesFromDisk(baseDir, wave, { cargo, formats, sources, units, crateRoots: rootsOf, unloaded })
    if (!buildScripts) return
    const scripts = new Set()
    for (const path of sources.keys()) {
      const script = formats.has(path) ? null : cargo.buildScriptOf(path)
      if (script === null) continue
      const as = new Set([...unitsOf(units, path)].map((u) => cargo.buildScriptUnit(u)))
      if (addTo(units, script, as)) scripts.add(script)
    }
    if (scripts.size === 0) return
    for (const s of scripts) if (!roots.includes(s)) roots.push(s)
    await walk([...scripts])
  }
  await walk(entries)
  const tried = new Set()
  const complete = async () => {
    const tree = buildRustTree(sources, { roots, baseDir, cargo, formats, units })
    const wanted = tree.wantedRoots.filter((r) => !unloaded.has(r) && (addTo(units, r, tree.wantedUnits.get(r)) || (!sources.has(r) && !tried.has(r))))
    if (wanted.length === 0) return tree
    for (const r of wanted) {
      tried.add(r)
      if (!roots.includes(r)) roots.push(r)
    }
    await walk(wanted)
    return complete()
  }
  return { sources, formats, tree: await complete() }
}
