// Rust loader. Reachability follows rustc: a `mod` (`#[path]`, `#[cfg_attr(…, path)]` too) pulls a module file in, a
// reference to an in-tree crate (own lib, path dep, vendored) its root; a `use` resolves against the module tree only.

import { isUtf8 } from 'node:buffer'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, posix, relative } from 'node:path'

import { assertRealPathWithinBase, memoized, nestedMap, relativeEscapes, toPosix, upsert } from '@exodus/stasis-core/util'
import { isFile } from '../resolve-typescript.js'
import { TARGET_CFG_KEYS, TARGET_UNIT, VENDOR_DIR, cfgName, createCargoContext, evalCfg, evalCfgKey, isTestTargetPath, normName, normalizeCfg, normalizeRel } from './cargo.js'
import { matchClose, splitTopLevel } from './toml.js'

const PATH_KEYWORDS = new Set(['crate', 'self', 'super'])
const NON_CRATE_LEADS = new Set([...PATH_KEYWORDS, 'std', 'core', 'alloc'])
const OTHER_SYSROOT_CRATES = new Set(['proc_macro', 'test'])
const ROOT_NAMES = new Set(['main.rs', 'lib.rs'])
// With the `seen` set, bounds cycles and the O(depth²) growth of module-path strings on absurd input.
const MAX_MODULE_DEPTH = 1000

const isWordChar = (ch) => ch !== undefined && /\w/u.test(ch)

// Two views aligned offset for offset with `content`: `code` blanks comments, `masked` string and char literal
// contents too. Block comments nest and a `//` in a string is no comment, which a pair of regexes gets wrong.
export function lexRust(content) {
  const n = content.length
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
        const delta = content.startsWith('/*', i) ? 1 : (content.startsWith('*/', i) ? -1 : 0)
        depth += delta
        i += delta === 0 ? 1 : 2
      } while (i < n && depth > 0)
      blankBoth(start, i)
      continue
    }
    const lit = stringStart(content, i)
    if (lit) {
      const start = lit.open + 1
      if (lit.raw === null) {
        i = start
        while (i < n && content[i] !== '"') i += content[i] === '\\' ? 2 : 1
        blankMasked(start, Math.min(i, n))
        i++
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

// A `b`/`c`/`r#…#` prefix must not be the tail of an identifier (`bar"`).
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

// The quote closing a char literal at `i`, or -1 for a lifetime or label (`'a`).
function charLiteralEnd(content, i) {
  if (content[i + 1] === '\\') {
    let j = i + 2
    if (content[j] === 'u' && content[j + 1] === '{') {
      const close = content.indexOf('}', j)
      if (close === -1 || close - j > 10) return -1
      j = close + 1
    } else j += 1
    return content[j] === "'" ? j : -1
  }
  if (content[i + 1] === undefined || content[i + 1] === "'") return -1
  if (content[i + 2] === "'") return i + 2
  return content.codePointAt(i + 1) > 0xff_ff && content[i + 3] === "'" ? i + 3 : -1 // an astral char is two UTF-16 units
}

const WORD_RE = /[A-Za-z_]\w*/uy
const WS_RE = /\s/u
// Items run to their `;` or body whatever commas they hold; weak keywords a field may be named (`union`) are left out.
const ITEM_KEYWORDS = new Set(['fn', 'impl', 'struct', 'enum', 'trait', 'type', 'const', 'static', 'mod', 'use', 'extern', 'macro_rules', 'unsafe', 'async', 'let'])
const INCLUDE_MACROS = new Set(['include', 'include_str', 'include_bytes'])
// Macros whose body is code for some other crate (a proc macro's output): nothing in it is this crate's.
const TEMPLATE_MACROS = new Set(['quote', 'quote_spanned', 'parse_quote', 'parse_quote_spanned'])
const STRING_LITERAL_RE = /^\s*(?:"((?:[^"\\]|\\[\s\S])*)"|r(#*)"([\s\S]*?)"\2)\s*$/u
const MANIFEST_DIR_CONCAT_RE = /^\s*concat!\s*\(\s*env!\s*\(\s*"CARGO_MANIFEST_DIR"\s*\)\s*,\s*([\s\S]*?),?\s*\)\s*$/u
const INCLUDE_IN_ATTR_RE = /\b(include|include_str|include_bytes)!\s*(?=[([{])/gu
const DEFINING_KEYWORDS = new Set(['struct', 'enum', 'union', 'trait', 'type', 'fn', 'const', 'static'])
// Value-namespace items never lead a path: a `fn log` beside `use log::info` hides no crate.
const VALUE_KEYWORDS = new Set(['fn', 'const', 'static'])

// Null for an argument the loader can't follow (`concat!(env!("OUT_DIR"), …)` is build output).
function includeArg(text) {
  const manifest = MANIFEST_DIR_CONCAT_RE.exec(text)
  const lit = STRING_LITERAL_RE.exec(manifest ? manifest[1] : text)
  if (!lit) return null
  const path = lit[1] === undefined ? lit[3] : unescapeString(lit[1])
  return manifest ? { path: path.replace(/^\/+/u, ''), base: 'manifest' } : { path, base: 'file' }
}

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
// Run over the masked view, so string contents can't fake a path; `Type::assoc` is skipped.
const LEAD_PATH_RE = /\b([a-z_]\w*)(?:::\w+)+/gu
const ATTR_PATH_RE = /^\s*path\s*=\s*"([^"]*)"\s*$/u
const CFG_ATTR_RE = /^\s*cfg\s*\(([\s\S]*)\)\s*$/u

const joinCfgs = (preds) => (preds.length === 0 ? null : (preds.length === 1 ? preds[0] : `all(${preds.join(', ')})`))

// `cfg_attr(<pred>, cfg(<inner>))` gates the item on `any(not(pred), inner)`.
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
  const paths = parts.map((part) => ATTR_PATH_RE.exec(part)).filter(Boolean).map((m) => ({ path: m[1], cfg: pred }))
  const inner = parts.map((part) => CFG_ATTR_RE.exec(part)).filter(Boolean).map((m) => normalizeCfg(m[1]))
  const macroExport = parts.some((part) => MACRO_EXPORT_RE.test(part))
  return attr({ cfg: inner.length === 0 ? null : `any(not(${pred}), ${joinCfgs(inner)})`, paths, pred, macroExport })
}

const INERT_ATTR = { cfg: null, paths: [], pred: null, includes: [] }

// The loader never follows a path into another crate's tree, so `pub` and `pub(crate)` are one to it.
function parseVisibility(restriction) {
  const r = restriction.trim().replaceAll(/\s+/gu, ' ')
  if (r === 'crate' || r === 'self' || r === 'super') return r
  if (r.startsWith('in ')) return `in ${r.slice(3).replaceAll(' ', '')}`
  return 'crate'
}

export function parseUseTree(body) {
  const tokens = [...body.matchAll(/::|[{},*]|\bas\b|(?:r#)?\w+/gu)].map((m) => m[0])
  const out = []
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isIdent = (tok) => tok !== undefined && tok !== 'as' && /^(?:r#)?\w+$/u.test(tok)
  const emit = (segments, absolute, binding, glob) => {
    const spec = `${absolute ? '::' : ''}${segments.join('::')}`
    if (segments.length > 0) out.push({ segments, absolute, spec, binding: binding === '_' ? null : binding, glob })
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

// An item whose cfg can never hold is skipped whole: dead modules aren't bundled, nor what only dead code reaches.
export function scanRustItems(content, { features = null, maybeFeatures = null, test = false, target = null, units = null, templates = TEMPLATE_MACROS } = {}) {
  const env = units === null ? { features, maybeFeatures, test, target } : { units: units.map((u) => ({ ...u, test })) }
  const { code, masked } = lexRust(content)
  const n = masked.length
  const mods = []
  const imports = []
  const macros = []
  const invocations = new Set()
  const calls = new Map()
  const pathInvocations = new Set()
  const callSites = new Map()
  const includes = []
  const defined = []
  const skipped = new Set()
  let unfollowed = 0
  const blanked = [] // `use` bodies and dead items, hidden from the expression-path scan
  const externCrates = []
  const bindings = new Set()
  const spans = []
  const stack = []
  const refs = new Map()
  // `fromUse`: the reliable signal that a lead names a crate. `macroCall` (`$crate::span!(…)`) names a macro, not a module.
  const addRef = (spec, segments, absolute, ip, fromUse, macroCall) => {
    const key = `${ip.join('::')}\0${spec}\0${macroCall ? '!' : ''}`
    if (!refs.has(key)) refs.set(key, { spec, segments, absolute, inlinePath: ip, fromUse, macroCall })
  }
  // `impl`/`trait` bodies and `extern "C" { }` blocks nest or lie apart in source order: stacks popped once left.
  const assocBlocks = []
  const foreignBlocks = []
  const openBlocks = (blocks, at) => {
    while (blocks.length > 0 && blocks.at(-1).end < at) blocks.pop()
    return blocks
  }
  // A `quote!` the file defines itself is no template.
  const localMacros = new Set([...masked.matchAll(/\bmacro_rules!\s*([A-Za-z_]\w*)/gu)].map((m) => m[1]))
  let depth = 0
  let pending = []
  let attrStart = 0
  let visNext = null
  // Open blocks a live `#[cfg]` gates (a `cfg_if!` branch, a `#[cfg(x)] mod m { … }`), contents included.
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
  const verdict = memoized((pred) => evalCfg(pred, env))
  // A `#[cfg(…)] name! { … }` gates all its body declares (mio's `#[cfg(unix)] cfg_os_poll! { mod unix; }`).
  let macroBodyCfg = null
  // Block depth → the cfgs of a `cfg_if!` chain's branches so far: `else if #[cfg(b)]` is gated on `all(not(a), b)`.
  const chains = new Map()
  const wordBefore = (pos) => {
    let k = skipWsBack(pos - 1)
    const end = k + 1
    while (k >= 0 && isWordChar(masked[k])) k--
    return k + 1 < end ? { word: masked.slice(k + 1, end), start: k + 1 } : null
  }
  const branchCfg = (i, own) => {
    const lead = wordBefore(pending.length > 0 ? attrStart : i)
    if (lead === null || (lead.word !== 'if' && lead.word !== 'else')) return null
    const continuing = lead.word === 'else' || wordBefore(lead.start)?.word === 'else'
    const negations = continuing ? chains.get(depth + 1) ?? [] : []
    if (own === null && negations.length === 0) return null
    chains.set(depth + 1, own === null ? negations : [...negations, own])
    return joinCfgs([...negations.map((c) => `not(${c})`), ...(own === null ? [] : [own])])
  }
  const endBranch = (end, blockDepth) => {
    if (chains.has(blockDepth) && readWord(skipWs(end)) !== 'else') chains.delete(blockDepth)
  }
  // The outermost macro invocation body being scanned. A `mod x;` there is an item only if the macro emits it,
  // so it is tolerated when missing, like a `#[cfg]`-gated one.
  let macroUntil = -1
  let macroName = null
  // The top-level `macro_rules!` the scan is in: what its body declares appears where the macro is invoked.
  let templateName = null
  let templateMacro = null
  const defs = [] // the `macro_rules!` bodies the scan is in
  const innermostEntry = (at) => openBlocks(defs, at).at(-1)
  const innermostDef = (at) => innermostEntry(at)?.macro ?? templateMacro
  const inTemplate = (at) => at < macroUntil && macroName === 'macro_rules'
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
  // The module body, a `#[cfg]`-gated or `extern "C"` block there, or a macro body (libc's `s! { … }`); not a `fn` body.
  const atModuleLevel = (at) => {
    if (at < macroUntil) return true
    const base = stack.length > 0 ? stack.at(-1).depth : 0
    return depth === base || cfgScopes.some((s) => s.depth === depth) || openBlocks(foreignBlocks, at).some((b) => b.start < at && b.depth === depth)
  }
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
  // A dead `if` (`elseChain`) takes its `else`s along, a bare block doesn't; a `let` runs to its `;`.
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
        // A `cfg_attr` whose predicate never holds applies nothing: the paths in its text are dead code too.
        const inert = attr.pred !== null && verdict(attr.pred) === false
        if (inert) blanked.push([i, close + 1])
        if (pending.length === 0) attrStart = i
        pending.push(inert ? INERT_ATTR : attr)
      } else {
        // A `#![cfg]` that can't hold empties the enclosing module (outside a macro body): at the top, the file.
        if (attr.cfg !== null && verdict(attr.cfg) === false && i >= macroUntil) {
          if (depth === 0) return { mods: [], refs: [], externCrates: [], bindings: new Set(), imports: [], macros: [], invocations: new Set(), calls: new Map(), pathInvocations: new Set(), callSites: new Map(), includes: [], unfollowed: 0, defined: [], inlineModules: [], inlineModuleVis: new Map(), skipped }
          const top = stack.at(-1)
          if (top !== undefined && top.depth === depth) {
            const end = matchClose(masked, top.start - 1)
            blanked.push([i, end])
            pending = []
            i = end
            continue
          }
        }
        const conditional = conditionalAt(null, i)
        for (const inc of attr.includes) includes.push({ ...inc, conditional })
        pending = []
      }
      i = close + 1
      continue
    }
    // A `pub`'s attributes stay pending for the keyword after it.
    const word = readWord(i)
    const attrCfg = word === 'pub' ? null : joinCfgs(pending.map((a) => a.cfg).filter((c) => c !== null))
    const own = ch === '{' ? branchCfg(i, attrCfg) ?? attrCfg : attrCfg
    const cfg = own === null ? scopeCfg : joinCfgs([...cfgScopes.map((s) => s.cfg), own])
    if (cfg !== null && verdict(cfg) === false) {
      pending = []
      visNext = null
      const end = skipItem(word === null ? i : i + word.length, word !== null && ITEM_KEYWORDS.has(word), { elseChain: ch !== '{', toSemicolon: word === 'let' })
      blanked.push([attrStart, end])
      if (ch === '{') endBranch(end, depth + 1)
      i = end
      continue
    }
    if (word !== 'pub' && pending.length > 0) {
      const conditional = conditionalAt(cfg, i)
      for (const a of pending) {
        for (const inc of a.includes) includes.push({ ...inc, conditional })
        a.includes = []
      }
    }
    if (word === null) {
      if (ch === '{') {
        depth++
        const gate = own ?? macroBodyCfg
        macroBodyCfg = null
        if (gate !== null) openScope(depth, gate)
      } else if (ch === '}') {
        depth--
        closeTo(depth, i)
        closeScopes(depth)
        endBranch(i + 1, depth + 1)
      } else visNext = null
      pending = []
      i++
      continue
    }
    const vis = visNext
    visNext = null
    const bang = skipWs(i + word.length)
    if (masked[bang] === '!') {
      let open = skipWs(bang + 1)
      let definition = null
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
        // A `macro_rules!` with no name defines nothing (rustc refuses it); a template's body is another crate's code.
        const unnamed = word === 'macro_rules' && definition === null
        if (unnamed || (templates.has(word) && !localMacros.has(word))) {
          if (!unnamed) skipped.add(word)
          blanked.push([i, close + 1])
          pending = []
          i = close + 1
          continue
        }
        if (definition !== null) {
          openBlocks(defs, i)
          defs.push({ macro: definition, end: close, depth: stack.length })
        }
        if (i >= macroUntil) macroName = word
        // A cfg on a `macro_rules!` gates the definition, not what its template declares where invoked.
        if (word !== 'macro_rules') {
          if (own !== null && masked[open] === '{') macroBodyCfg = own
          // A call in a template is the definition's, made where that is invoked.
          const def = inTemplate(i) && templateMacro !== null ? innermostDef(i) : null
          const pathQualified = masked[i - 1] === ':' && masked[i - 2] === ':'
          if (def !== null) (pathQualified ? def.pathCalls : def.calls).add(word)
          else if (pathQualified) pathInvocations.add(word)
          else {
            invocations.add(word)
            upsert(calls, word, () => []).push(i)
          }
          if (def === null) upsert(callSites, word, () => []).push({ offset: i, inlinePath: inlinePath(), inlineDirs: inlineDirs() })
          if (INCLUDE_MACROS.has(word)) {
            const text = code.slice(open + 1, close)
            const arg = includeArg(text)
            // Build output (`OUT_DIR`) is nobody's to follow; any other unreadable argument is counted.
            if (arg === null) unfollowed += /\bOUT_DIR\b/u.test(text) ? 0 : 1
            else if (def !== null) def.includes.push({ kind: word, ...arg })
            else includes.push({ kind: word, ...arg, conditional: conditionalAt(cfg, i) })
          }
        }
        macroUntil = Math.max(macroUntil, close)
      }
    }
    if (word === 'impl' || word === 'trait') {
      const open = bodyOpen(i + word.length)
      if (open !== -1) assocBlocks.push({ start: open, end: matchClose(masked, open), depth: depth + 1 })
    } else if (word === 'extern' && readWord(bang) !== 'crate') {
      let k = bang
      if (masked[k] === '"') k = skipWs(masked.indexOf('"', k + 1) + 1)
      if (masked[k] === '{') foreignBlocks.push({ start: k, end: matchClose(masked, k), depth: depth + 1 })
    }
    // Not a `*const T` pointer type; `const fn`, `static mut` and `static ref` define no `fn`, `mut` or `ref`.
    if (DEFINING_KEYWORDS.has(word) && atModuleLevel(i) && !isAssociated(i, depth) && !inTemplate(i) && !(word === 'const' && masked[skipWsBack(i - 1)] === '*')) {
      let at = skipWs(i + word.length)
      if (masked.startsWith('mut ', at) || masked.startsWith('ref ', at)) at = skipWs(at + 3)
      if (masked.startsWith('r#', at)) at += 2
      const name = readWord(at)
      const next = name === null ? null : masked[skipWs(at + name.length)]
      if (name !== null && !ITEM_KEYWORDS.has(name) && (word !== 'union' || next === '{' || next === '<')) defined.push({ name, inlinePath: inlinePath(), vis, cfg, macro: i < macroUntil ? macroName : null, ns: VALUE_KEYWORDS.has(word) ? 'value' : 'type' })
    }
    if (word === 'pub') {
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
      const conditional = conditionalAt(cfg, i)
      if (masked[k] === ';') {
        // rustc applies the first `#[path]` whose predicate holds; then the default lookup is off.
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
        // `#[path = "dir"] mod m { mod a; }` finds `a` under `dir/`, not `m/`.
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
      // Not an import of this file: the word in macro input (`Token![use]`), or one interpolating a
      // metavariable (`use $m::X;`, quote's `#path`; `r#` is none), which the loader can't place.
      if (!/^\s*[A-Za-z_{:$]/u.test(body) || /(?<!\br)#|\$(?!crate\b)/u.test(body)) {
        pending = []
        i += 3
        continue
      }
      const ip = inlinePath()
      const macro = i < macroUntil ? macroName : null
      // `use $crate::…` in a template imports into whichever module invokes the macro.
      const template = macro === 'macro_rules' && /\$crate\b/u.test(body)
      for (const p of parseUseTree(body)) {
        addRef(p.spec, p.segments, p.absolute, ip, true, false)
        const im = { segments: p.segments, absolute: p.absolute, binding: p.binding, glob: p.glob, inlinePath: ip, vis, cfg, macro, template }
        imports.push(im)
        if (hidesCrate(im)) bindings.add(p.binding)
      }
      blanked.push([i, stop])
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
  // What a template declares stands where the macro is first invoked here (serde's `crate_root! { … mod de; … }`).
  for (const m of [...mods, ...macros]) if (m.template !== null) m.offset = calls.get(m.template)?.[0] ?? Infinity

  // Spans nest, so the longest path is the innermost.
  const inlineAt = (offset) => {
    let best = []
    for (const s of spans) if (s.start <= offset && offset < s.end && s.path.length > best.length) best = s.path
    return best
  }
  // Expression paths outside `use`s and dead code (a test's `quickcheck::quickcheck(…)` mustn't pull the dev-dependency in).
  let exprs = ''
  let at = 0
  for (const [start, end] of blanked.toSorted((a, b) => a[0] - b[0])) {
    const from = Math.max(start, at)
    if (end <= from) continue
    exprs += masked.slice(at, from) + ' '.repeat(end - from)
    at = end
  }
  exprs += masked.slice(at)
  const keywordPaths = []
  const leadPaths = []
  for (const m of exprs.matchAll(LEAD_PATH_RE)) {
    // A metavariable lead (`$trait::fmt(…)`) names nothing; `$crate::…` names this crate.
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

// Whether a `use` binds a name that is not the crate of that name: `use std::io;` does, `use serde_json;` doesn't.
const hidesCrate = (im) => im.binding !== null && (im.segments.length > 1 || im.binding !== im.segments[0])

// The directory of a file's submodules: its own for mod.rs, a crate root and (`root`) any file owning it; else `<stem>/`.
export function getModuleDir(filePath, { root = false } = {}) {
  const lastSlash = filePath.lastIndexOf('/')
  const dir = lastSlash === -1 ? '' : filePath.slice(0, lastSlash)
  const name = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1)
  if (root || ROOT_NAMES.has(name) || name === 'mod.rs') return dir
  const stem = name.replace(/\.rs$/u, '')
  return dir ? `${dir}/${stem}` : stem
}

const ownsDir = (file, { roots, pathLoaded }) => roots?.has(file) === true || pathLoaded?.has(file) === true

function firstFile(candidates, { knownSources, baseDir }) {
  if (knownSources) return candidates.find((c) => knownSources.has(c)) ?? null
  if (baseDir) return candidates.find((c) => isFile(join(baseDir, c))) ?? null
  return null
}

// A file owning its directory tries the `<stem>/` rule after, so a glob-listed module file still resolves.
export function resolveModPath(modName, fromFile, { knownSources, baseDir, roots, pathLoaded, inlinePath = [], boundary = null } = {}) {
  const owns = ownsDir(fromFile, { roots, pathLoaded })
  for (const dir of new Set([getModuleDir(fromFile, { root: owns }), getModuleDir(fromFile)])) {
    // An inline module's `#[path = "…"]` may climb (`..`): held to `boundary` like any explicit path.
    const base = normalizeRel(dir, [...inlinePath, modName].filter(Boolean).join('/'))
    if (base === null || (boundary !== null && !withinDir(base, boundary))) continue
    const found = firstFile([`${base}.rs`, `${base}/mod.rs`], { knownSources, baseDir })
    if (found) return found
  }
  return null
}

// Inside inline modules, relative to the file's module dir plus theirs; root-escaping paths resolve to nothing.
export function resolveExplicitModPath(explicitPath, fromFile, { knownSources, baseDir, roots, pathLoaded, inlinePath = [], boundary = null } = {}) {
  const dir = inlinePath.length === 0
    ? posix.dirname(fromFile)
    : [getModuleDir(fromFile, { root: ownsDir(fromFile, { roots, pathLoaded }) }), ...inlinePath].filter(Boolean).join('/')
  const rel = normalizeRel(dir, explicitPath)
  if (rel === null || (boundary !== null && !withinDir(rel, boundary))) return null
  return firstFile([rel], { knownSources, baseDir })
}

const withinDir = (rel, dir) => dir === '.' || rel === dir || rel.startsWith(`${dir}/`)

// A vendored crate's file linked out of its package (to the project's `.env`, say) is refused.
export function withinRealDir(baseDir, rel, within, { who = 'loader.rust', realDirs = new Map() } = {}) {
  if (within === '.') return true
  const back = toPosix(relative(upsert(realDirs, within, () => realpathSync(join(baseDir, within))), realpathSync(join(baseDir, rel))))
  if (!relativeEscapes(back)) return true
  console.warn(`[${who}] Refusing file outside its package: ${rel} (a link out of ${within})`)
  return false
}

// A published crate never names a file outside its package; the project's own code may reach the bundle root.
export function boundaryOf(file, ctx) {
  return ctx?.isVendored(file) === true ? ctx.packageInfo(file).dir : '.'
}

// Null when the include escapes the bundle root, or a vendored crate's package.
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

// An unconditional `#[path]`'s file; else each `#[cfg_attr(<pred>, path)]`'s under its predicate, then the default lookup's.
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
  // A variant that always applies leaves no build for the default lookup.
  const fallback = decl.noDefault === true ? null : resolveModPath(decl.name, fromFile, o)
  if (fallback && !out.some((x) => x.file === fallback)) out.push({ cfg: null, file: fallback, explicit: false })
  return out
}

// `use` names underscore but the vendor dir may hyphenate, so try both.
export function resolveVendoredCrate(crateName, { knownSources } = {}) {
  const norm = normName(crateName)
  return [norm, norm.replaceAll('_', '-')].map((dir) => `${VENDOR_DIR}/${dir}/src/lib.rs`).find((lib) => knownSources?.has(lib)) ?? null
}

// Roots by name or manifest come first, so their trees claim files before a glob-listed module file claims itself.
export function crateRoots(sources, explicit = [], cargo = null) {
  const knownRoot = (path) => ROOT_NAMES.has(path.slice(path.lastIndexOf('/') + 1)) || cargo?.isLibRoot(path) === true
  return new Set([...[...sources.keys()].filter(knownRoot), ...explicit.filter((r) => sources.has(r))])
}

// Files are claimed by the first root to reach them.
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
      upsert(files, path, () => ({ root, modulePath, leaves, parent, roots: new Set() })).roots.add(root)
      if (seen.has(path) || depth >= MAX_MODULE_DEPTH) continue
      seen.add(path)
      const mount = (spec, sub, target) => {
        const variants = target instanceof Map ? [...target] : [['*', target]]
        for (const [key, file] of variants) {
          if (!tree.has(sub)) tree.set(sub, file)
          const variant = variants.length > 1 ? [{ key: 'variant', site: sub, value: key.replace(/#\d+$/u, ''), neg: false }] : []
          queue.push([file, sub, depth + 1, [...leaves, ...mountLeaves(mountCfgs?.get(path)?.get(spec)?.get(file), path), ...variant], path])
        }
      }
      // Each prefix of `segments` (`a`, `a::b`, …): an inline module whose body lives in this file.
      const claimInline = (segments) => {
        for (let k = 1; k <= segments.length; k++) {
          const key = `${modulePath}::${segments.slice(0, k).join('::')}`
          if (!tree.has(key)) tree.set(key, path)
        }
      }
      // Module files first, so a `mod imp;` file beats a `mod imp { … }` of the same name in any order.
      const specs = [...(resolutions.get(path) ?? [])]
      for (const [spec, target] of specs) {
        if (spec.startsWith('mod ') && !spec.includes('::')) mount(spec, `${modulePath}::${spec.slice(4)}`, target)
      }
      for (const [spec, target] of specs) {
        // An `include!`d file's tokens are this module's.
        if (spec.startsWith('include ')) queue.push([target, modulePath, depth + 1, leaves, path])
        else if (spec.startsWith('mod ') && spec.includes('::')) {
          claimInline(spec.slice(4).split('::').slice(0, -1))
          mount(spec, `${modulePath}::${spec.slice(4)}`, target)
        }
      }
      for (const inline of inlineModules?.get(path) ?? []) claimInline(inline)
    }
  }
  return { trees, files }
}

// Unless the path is absolute, a name the file imported is no crate: `use std::io; io::stdin()`.
const crateLead = ({ segments, absolute }, bindings) => {
  const head = segments[0]
  return head === undefined || NON_CRATE_LEADS.has(head) || (!absolute && bindings.has(head)) ? null : head
}

// What a module's imports provide is computed once per (module, name) for every path: resolution is linear in paths.

// A `pub(in …)` naming no ancestor (rustc rejects it) reads as `crate`.
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
  for (; segments[i] === 'super' && cur.length > 1; i++) cur.pop()
  const scope = [...cur, ...segments.slice(i)].join('::')
  return modulePath === scope || modulePath.startsWith(`${scope}::`) ? scope : 'crate'
}

// cfg compatibility: each file carries the cfg leaves it was mounted under, each import and item its own on
// top; a candidate whose leaves can't hold with the asker's is skipped (libc's per-platform `pub use fuchsia::*`).

// The conjunctive leaves `{ key, value, neg }` of a predicate. An `any(…)` (or a negated `all(…)`) is one leaf
// `{ key: 'any', alts }`, unless an alternative decides nothing (`any(unix, libc_core_cvoid)`): then nothing.
function cfgLeaves(pred) {
  if (pred == null) return []
  const p = pred.trim()
  const m = /^(all|any|not)\s*\(([\s\S]*)\)$/u.exec(p)
  if (!m) {
    if (p === 'true') return [] // `false` is a leaf the build rules out (leafFalse)
    const kv = /^((?:r#)?[\w-]+)\s*(?:=\s*"([^"]*)")?$/u.exec(p)
    return kv ? [{ key: cfgName(kv[1]), value: kv[2] ?? null, neg: false }] : []
  }
  const parts = splitTopLevel(m[2]).filter((part) => part.trim() !== '').map(cfgLeaves)
  if (m[1] === 'all') return parts.flat()
  if (m[1] === 'any') return anyOf(parts)
  return parts.length === 1 ? negated(parts[0]) : []
}
// The leaves holding when any of `alts` does, once duplicates and implied ones go (`a ∨ (a ∧ b)` is `a`); past
// MAX_ALTERNATIVES or over an undecided one, the undecided leaf.
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
// An `any` the loader doesn't follow (`many`: its alternatives): no build decides it, no asker holds it, it is
// never custom nor exclusive, so a candidate under it is only maybe the answer, never certain.
const UNDECIDED_KEY = 'any(…)!'
const negated = (leaves) => {
  if (leaves.length === 0) return []
  if (leaves.length > 1) return anyOf(leaves.map((l) => negated([l])))
  const [l] = leaves
  return l.alts === undefined ? [{ ...l, neg: !l.neg }] : l.alts.flatMap(negated)
}

// A gate macro (tokio's `cfg_io_uring!`) wraps each item of its body in the cfg its definition writes.
const GATE_MACRO_RE = /^cfg_(?!if$)\w+$/u
// The conjunction of the transcribers' `#[cfg(…)]`s when every arm writes the same; else null.
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
// An unreadable definition gives a never-certain leaf of the macro's name: `cfg_not_x!` isn't `not(cfg_x!)`.
function gateLeaves(macro, gates = null) {
  if (macro == null || !GATE_MACRO_RE.test(macro)) return []
  const pred = gates?.get(macro)
  return typeof pred === 'string' ? cfgLeaves(pred) : [{ key: `${macro}!`, value: null, neg: false }]
}

const SINGLE_VALUED_CFG_KEYS = new Set(['target_os', 'target_arch', 'target_env', 'target_vendor', 'target_abi', 'target_pointer_width', 'target_endian', 'panic'])
const NON_UNIX_OS = new Set(['windows', 'none', 'uefi', 'wasi', 'solana', 'cuda', 'xous', 'zkvm', 'psp', 'unknown'])
const isWindowsLeaf = (l) => (l.key === 'windows' && l.value === null) || ((l.key === 'target_os' || l.key === 'target_family') && l.value === 'windows')
const isUnixLeaf = (l) => (l.key === 'unix' && l.value === null) || (l.key === 'target_family' && l.value === 'unix')

function cfgExclusive(a, b) {
  const [pa, pb] = [prepared(a), prepared(b)]
  for (const k of pa.negKeys) if (pb.keys.has(k)) return true
  for (const [k, v] of pa.values) if (pb.values.has(k) && pb.values.get(k) !== v) return true
  if ((pa.windows && (pb.unix || pb.otherOs)) || (pb.windows && (pa.unix || pa.otherOs)) || (pa.unix && pb.nonUnixOs) || (pb.unix && pa.nonUnixOs)) return true
  for (const x of pa.anys) if (x.alts.every((alt) => cfgExclusive(alt, b))) return true
  for (const y of pb.anys) if (y.alts.every((alt) => cfgExclusive(a, alt))) return true
  return false
}
// What cfgExclusive asks of a leaf list, kept on it; a key with several values (`MANY`) holds with nothing.
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
    if (l.key === 'target_os' && l.value !== null && l.value !== 'windows') prep.otherOs = true
    if (l.key === 'target_os' && NON_UNIX_OS.has(l.value)) prep.nonUnixOs = true
  }
  leaves.prep = prep
  return prep
}

// Kept per leaf: an `any` leaf's is asked for again and again as sets of them are interned and compared.
const leafKeys = new WeakMap()
const leafKey = (l) => upsert(leafKeys, l, () => (l.alts === undefined ? `${l.neg ? '!' : ''}${l.key}${l.site === undefined ? '' : `@${l.site}`}${l.value === null ? '' : `=${l.value}`}` : `any(${l.alts.map((alt) => alt.map(leafKey).toSorted().join('&')).toSorted().join(',')})`))

// Interned per tree: a chain of globs' union stays small, and the verdict for a pair of sets is looked up by key.
const NO_LEAVES = { leaves: [], key: '' }
function leafSet(leaves, sets) {
  if (leaves.length === 0) return NO_LEAVES
  const uniq = new Map(leaves.map((l) => [leafKey(l), l]))
  const key = [...uniq.keys()].toSorted().join('|')
  return upsert(sets, key, () => ({ leaves: [...uniq.values()], key }))
}
// Asked for again and again along a closure: kept on the first set, by the second's key.
const unionLeaves = (a, b, sets) => {
  if (a.key === '') return b
  if (b.key === '' || b.key === a.key) return a
  return upsert((a.unions ??= new Map()), b.key, () => leafSet([...a.leaves, ...b.leaves], sets))
}
const eitherLeaves = (a, b, sets) => {
  if (a.key === b.key) return a
  if (a.key === '' || b.key === '') return NO_LEAVES
  const altsOf = (s) => (s.leaves.length === 1 && s.leaves[0].alts !== undefined ? s.leaves[0].alts : [s.leaves])
  return leafSet(anyOf([...altsOf(a), ...altsOf(b)]), sets)
}

// No asker (an internal query) skips nothing; verdicts are kept per pair of sets, shared by one set's askers.
const compatible = (asker, set) => asker === undefined || set.key === '' || asker.contradictory || upsert(asker.compat, set.key, () => !cfgExclusive(asker.set.leaves, set.leaves))
// A candidate the asker's build can't compile is taken last, only when nothing the build compiles answers; an
// asker whose own leaves can't hold (`deadHere`) gets no verdict.
const leafFalse = (l, build) => {
  if (l.alts !== undefined) return l.alts.every((alt) => alt.some((m) => leafFalse(m, build)))
  if (l.key === 'false' && l.value === null) return !l.neg
  const verdict = evalCfgKey(l.key, l.value, build)
  return l.neg ? verdict === true : verdict === false
}
const deadUnder = (leaves, build) => build !== undefined && leaves.some((l) => leafFalse(l, build))
const deadFor = (asker, set) => asker !== undefined && !asker.deadHere && set.key !== '' && upsert(asker.dead, set.key, () => deadUnder(set.leaves, asker.build))
// Whether a candidate's leaves are all the asker's own: certainly compiled together (libc's aix/mod.rs asking
// `crate::fsid_t` takes the aix glob's). A custom cfg's negation (`not(loom)`) is presumed to hold.
const holds = (l, keys, custom) => l.many === undefined && (keys.has(leafKey(l)) || (l.alts === undefined ? l.neg && custom(l.key) : l.alts.some((alt) => alt.every((m) => holds(m, keys, custom)))))
const entailed = (asker, set) => asker === undefined || set.key === '' || (!asker.contradictory && upsert(asker.sure, set.key, () => set.leaves.every((l) => holds(l, asker.keys, asker.custom))))
// The cfgs rustc and cargo set; any other positive leaf is a custom `--cfg` (`loom`, `docsrs`), off by default,
// so a candidate under one is `doubtful`, unless the asker's package may set it (cargo.js cfgsSetFor).
const KNOWN_CFG_KEYS = new Set([...TARGET_CFG_KEYS, 'false', 'feature', 'test', 'doctest', 'doc', 'debug_assertions', 'overflow_checks', 'panic', 'proc_macro', 'miri', 'sanitize', 'target_feature', 'target_thread_local', 'ub_checks', 'relocation_model', 'fmt_debug', 'clippy', 'rustfmt', 'variant'])
const customKey = (key) => !KNOWN_CFG_KEYS.has(key) && !key.endsWith('!')
const customMemo = new WeakMap()
const NO_CUSTOM = () => false
const customFor = (settable) => {
  if (settable == null) return customKey
  if (settable.any) return NO_CUSTOM
  if (settable.names.size === 0) return customKey
  return upsert(customMemo, settable, () => (key) => customKey(key) && !settable.names.has(key))
}
const doubtfulLeaf = (l, askerLeaves, custom) => (l.alts === undefined ? !l.neg && custom(l.key) : l.alts.every((alt) => cfgExclusive(alt, askerLeaves) || alt.some((m) => doubtfulLeaf(m, askerLeaves, custom))))
// A set with no custom cfg at all is doubtful to no asker.
const hasCustom = (leaves, custom) => leaves.some((l) => (l.alts === undefined ? !l.neg && custom(l.key) : l.alts.some((alt) => hasCustom(alt, custom))))
const doubtful = (asker, set) => {
  if (asker === undefined || set.key === '') return false
  set.custom ??= hasCustom(set.leaves, customKey)
  return set.custom && upsert(asker.doubt, set.key, () => set.leaves.some((l) => !holds(l, asker.keys, asker.custom) && doubtfulLeaf(l, asker.set.leaves, asker.custom)))
}

// Recompute the glob closures computed short of an import cycle against each other until none grows, dropping
// first the lookups that may rest on the short ones. True when the paths resolved so far must be resolved again.
function stabilizeClosures(ctx) {
  const cyclic = [...ctx.closures.values()].flatMap((memo) => [...memo.values()].filter((entry) => entry.cyclic === true))
  if (cyclic.length === 0) return false
  const reset = () => {
    ctx.provided.clear()
    ctx.opaque.clear()
    ctx.opaqueGlobs.clear()
    for (const im of [...ctx.imports.values()].flatMap((byModule) => [...byModule.values()].flatMap(importsIn))) {
      delete im.source
      delete im.answers
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

const importsIn = (of) => [...of.globs, ...[...of.named.values()].flat()]

// The shallowest computation under way that was cycled back to, Infinity for none.
const minHit = (ctx) => Math.min(...ctx.hits)

function commonDepth(a, b) {
  const [x, y] = [a.split('::'), b.split('::')]
  let depth = 0
  while (depth < x.length && depth < y.length && x[depth] === y[depth]) depth++
  return depth
}

// Scopes are ancestors of `at`, so `from` sees as deep as it shares with `at`.
function provided(root, at, name, from, ctx, asker, ns = null) {
  return pick(providedAll(root, at, name, commonDepth(from, at), ctx), root, ctx, asker, ns)
}

// The first of `candidates` (in written order) the asker's cfgs entail, else the compatible ones under no doubt
// (withAlternatives), else the first doubtful, else the first dead; VALUE_ONLY for a value where a type is wanted.
function pick(candidates, root, ctx, asker, ns = null) {
  const maybes = []
  let doubted = null
  let lastResort = null
  let valueOnly = false
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
      // Met again while being followed (`use log;` asks its own module for `log`).
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
        // A macro is defined under the import's name for it (`use dep::mac as m;`).
        if (ns === 'macro' && r?.kind === 'item' && r.macroName === undefined && im.segments.length > 0) r = { ...r, macroName: im.segments.at(-1) }
        im.following = undefined
        ctx.walking--
        ctx.hits.delete(depth)
        if (minHit(ctx) > depth) (im.answers ??= new Map()).set(key, r)
      }
      // `pub use util::helper;` of a `fn helper` binds no macro.
      if (ns === 'macro' && r?.kind === 'item' && !definesMacro(ctx, r.file, r.macroName)) continue
      // An import leading out of the bundle binds the name all the same, as an item of its own file; one naming
      // a crate outright (`use serde;`) answers nothing: the lead is the crate's to report.
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

const leafText = (l) => {
  if (l.alts !== undefined) return `any(${l.alts.map((alt) => cfgTextOf(alt) ?? '*').join(', ')})`
  const plain = l.many !== undefined ? manyText(l) : (l.value === null ? l.key : `${l.key} = "${l.value}"`)
  return l.neg ? `not(${plain})` : plain
}
// Kept per leaf, and cut short when it runs long (undecided leaves within undecided leaves).
const manyTexts = new WeakMap()
const manyText = (l) => upsert(manyTexts, l, () => {
  const text = `any(${l.many.map((alt) => cfgTextOf(alt) ?? '*').join(', ')})`
  return text.length > 4096 ? `any(${l.many.length} alternatives)` : text
})
// A leaf list as cfg text, for a key; a `mod` variant's leaf only when nothing else tells candidates apart.
function cfgTextOf(leaves) {
  const own = leaves.filter((l) => l.key !== 'variant')
  // What a variant is rather than all it isn't: a `cfg_if!` branch's own cfg, not the earlier branches' negations.
  const positive = own.filter((l) => l.alts === undefined && !l.neg)
  const anyPositive = own.filter((l) => l.alts !== undefined && l.alts.every((alt) => alt.every((m) => m.alts === undefined && !m.neg)))
  const shown = positive.length + anyPositive.length > 0 ? [...positive, ...anyPositive] : (own.length > 0 ? own : leaves)
  return joinCfgs([...new Set(shown.map((l) => (l.key === 'variant' ? l.value : leafText(l))))].toSorted())
}

// Several candidates none of which the asker's cfgs entail (libc's per-platform `crate::sockaddr`): the first,
// with `alternatives` (cfg key → each distinct file), or for a module, `branches` (cfg key → each answer).
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
    const textOf = () => cfgTextOf(leaves.leaves.filter((l) => asker === undefined || !asker.keys.has(leafKey(l))))
    keyed.set(freshKey(keyed, cfgKey(asker === undefined ? textOf() : upsert(asker.texts, leaves.key, textOf))), answer)
  }
  if (first.answer.kind === 'module') return { ...first.answer, branches: keyed }
  return { ...first.answer, alternatives: new Map([...keyed].filter(([, answer]) => answer.file !== undefined).map(([key, answer]) => [key, answer.file])) }
}

// Built lazily: a closure holds hundreds of modules, the first few answer.
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
      // A `#[macro_export]` macro ranks by cfgs against a `pub use inner::m;` beside it (serde's docsrs-only copies).
      if (at === 'crate') for (const m of ctx.exportedMacros.get(root)?.get(name) ?? NONE) yield { answer: { kind: 'item', file: m.file }, leaves: m.leaves, ns: 'macro' }
      // Own items rank with named imports, ahead of what globs bring in, which never shadows them.
      const defs = ctx.defined.get(root)?.get(at)?.get(name)
      if (defs !== undefined) yield* defCandidates(root, at, defs, ctx)
      // Of the closure's modules (hundreds, in libc), only the ones with something of the name.
      const having = ctx.having.get(root)?.get(name)
      if (having === undefined) return
      const positions = [...having].flatMap((module) => closureIndex(closure).get(module) ?? NONE)
      for (const i of positions.toSorted((x, y) => x - y)) {
        const reached = closure[i]
        for (const c of hasAll(root, reached.module, name, reached.seeing, ctx)) yield { ...c, through: reached.through, leaves: unionLeaves(reached.leaves, c.leaves, ctx.leafSets) }
      }
    }(), ctx)
    if (minHit(ctx) >= depth) memo.set(key, list)
  }
  return list
}

// A closure's entry positions by module (one may be reached at several depths).
const closureIndex = (closure) => (closure.index ??= Map.groupBy(closure.keys(), (i) => closure[i].module))

// A list materialized from a generator as far as it is read. Read again while producing an element, it ends
// there for that reader and marks the computation under way hit, so nothing built on that short view is kept.
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

// What a glob into `at` brings in under `name`, for one seeing `seeing` levels into it, in written order.
function hasAll(root, at, name, seeing, ctx) {
  const child = ctx.children.get(root)?.get(at)?.has(name) === true
  const defs = ctx.defined.get(root)?.get(at)?.get(name)
  const macros = at === 'crate' ? ctx.exportedMacros.get(root)?.get(name) : undefined
  const imports = importsOf(root, at, name, seeing, ctx)
  // Asked for every module a closure reaches, most of which have nothing of the name.
  if (!child && defs === undefined && macros === undefined && imports.length === 0) return NONE
  const out = []
  if (child) {
    const sub = `${at}::${name}`
    if ((ctx.modScope.get(root)?.get(sub) ?? 1) <= seeing) out.push({ answer: { kind: 'module', modulePath: sub, file: ctx.trees.get(root).get(sub) }, leaves: NO_LEAVES })
  }
  if (defs !== undefined) out.push(...defCandidates(root, at, defs.filter((d) => d.scopeDepth <= seeing), ctx))
  for (const m of macros ?? NONE) out.push({ answer: { kind: 'item', file: m.file }, leaves: m.leaves })
  out.push(...imports)
  return out
}
const NONE = Object.freeze([])

function defCandidates(root, at, defs, ctx) {
  const own = ctx.trees.get(root).get(at)
  return [...defs.filter((d) => d.file === own), ...defs.filter((d) => d.file !== own)].map((d) => ({ answer: { kind: 'item', file: d.file }, leaves: d.leaves, ns: d.ns }))
}

// Ranked as pick ranks candidates, own tree file first; `{ file, alternatives }` when several may, none for certain.
function definedIn(root, at, name, ctx, asker, ns = null) {
  const defs = ctx.defined.get(root)?.get(at)?.get(name)
  if (defs === undefined) return null
  const own = ctx.trees.get(root).get(at)
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

// For a module spread over cfg variant files (`#[cfg_attr(unix, path = …)]`): the asking file's own `use`s first.
function providedFrom(root, at, name, ctx, file, asker, ns = null) {
  const of = ctx.imports.get(root)?.get(at)
  const files = of === undefined ? null : (of.files ??= new Set(importsIn(of).map((im) => im.file)))
  if (files === null || files.size === (files.has(file) ? 1 : 0)) return provided(root, at, name, at, ctx, asker, ns)
  const memo = nestedMap(ctx.provided, root)
  const seeing = at.split('::').length
  const key = `${at}\0${name}\0@${file}`
  let list = memo.get(key)
  if (list === undefined) {
    // Resolving this file's glob sources may ask this very question: meanwhile it reads as nothing, and isn't kept.
    const depth = ctx.walking++
    memo.set(key, { depth })
    const own = of.globs.filter((im) => im.file === file).map((im) => [im, globSource(im, root, ctx)]).filter(([, s]) => s?.kind === 'module')
    const cyclic = ctx.hits.delete(depth)
    ctx.walking--
    list = new Lazy(function* () {
      yield* importsOf(root, at, name, seeing, ctx, file)
      for (const [im, { modulePath: module }] of own) {
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

// `onlyFile`: for a module spread over cfg variant files, each binding the name its own way.
function importsOf(root, at, name, seeing, ctx, onlyFile) {
  const named = ctx.imports.get(root)?.get(at)?.named.get(name)
  if (named === undefined) return NONE
  return named.filter((im) => im.scopeDepth <= seeing && (onlyFile === undefined || im.file === onlyFile)).map((im) => ({ import: im, through: im.file, leaves: im.leaves }))
}

// Depth-first in written order; `through` is the file holding `at`'s glob. A settled closure stands in for walking on.
function globClosure(root, at, seeing, ctx) {
  const memo = nestedMap(ctx.closures, root)
  const key = `${at}\0${seeing}`
  const hit = memo.get(key)
  // Asked again while being computed (a cycle): empty for now, and the entry in progress is marked hit (by its
  // depth in `ctx.walking`); the same bookkeeping serves globSource, pick and Lazy.
  if (hit?.depth !== undefined) {
    ctx.hits.add(hit.depth)
    return []
  }
  if (hit !== undefined) return hit.value
  const compute = () => {
    const modules = []
    const seen = new Map([[key, null]])
    // A module reached again by another path (libc's `mod primitives`) is reachable under either: walked on from.
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
        for (const m of settled.value) add(`${m.module}\0${m.seeing}`, { module: m.module, seeing: m.seeing, through, leaves: unionLeaves(leaves, m.leaves, ctx.leafSets) })
        return
      }
      reachGlobs(module, sees, through, leaves)
    }
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
  // What was computed on a cyclic read may be short and is dropped; the hit entry is kept for stabilizeClosures.
  const depth = ctx.walking++
  memo.set(key, { depth })
  const value = compute()
  const cyclic = ctx.hits.delete(depth)
  ctx.walking--
  if (minHit(ctx) < depth) memo.delete(key)
  else memo.set(key, cyclic ? { value, cyclic, compute } : { value })
  return value
}

// Kept on the glob, unless the answer came out of an import cycle still being resolved.
function globSource(im, root, ctx) {
  if (im.source !== undefined) return im.source
  const depth = ctx.walking++
  const source = followImport(im, root, ctx)
  ctx.walking--
  if (minHit(ctx) >= depth) im.source = source
  return source
}

// Else the crate its lead names: a sysroot one is an item, living here as far as the bundle knows.
function followImport(im, root, ctx, asker, ns = null) {
  if (!im.absolute) {
    const r = walkPath(im.segments, root, im.module, ctx, { file: im.file, asker, ns })
    if (r !== null && ns === 'macro' && r.kind === 'crate' && r.rest?.length > 0) return macroOfCrate(r.file, r.rest, ctx) ?? r
    if (r !== null) return r
  }
  const head = im.segments[0]
  if (NON_CRATE_LEADS.has(head)) return { kind: 'item', file: im.file }
  const target = ctx.resolveCrate(head, im.file)
  if (!target) return null
  const macro = ns === 'macro' && im.segments.length > 1 ? macroOfCrate(target, im.segments.slice(1), ctx) : null
  return macro ?? { kind: 'crate', name: head, file: target }
}

// Looked up from the crate's root under its own build, by the name the macro is defined under.
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
const macroAlternatives = (ctx, alternatives, name) => {
  const defining = new Map([...(alternatives ?? [])].filter(([, f]) => definesMacro(ctx, f, name)))
  return defining.size > 1 ? defining : undefined
}

const itemAt = (def) => (typeof def === 'string' ? { kind: 'item', file: def } : { kind: 'item', file: def.file, alternatives: def.alternatives })

// A value where a type or module is wanted (`log::info!` beside a `fn log`): the lead may still name a crate.
const VALUE_ONLY = Object.freeze({ kind: 'value' })
const onlyValues = (root, at, name, ctx) => {
  const defs = ctx.defined.get(root)?.get(at)?.get(name)
  return defs !== undefined && defs.every((d) => d.ns === 'value')
}

// Null when the lead doesn't anchor the path in `root`'s crate; a segment nothing provides is an item of the module reached.
function walkPath(segments, root, from, ctx, options = {}) {
  const branches = []
  const r = walkOnce(segments, root, from, ctx, options, branches)
  return branches.length === 0 || r === null || r === VALUE_ONLY || r.file === undefined ? r : throughBranches(r, branches, root, from, ctx, options)
}
// The files the path leads to through each other module a segment may name become `alternatives` of `r`.
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
  // A segment with more after it names a module or type: a `fn log` doesn't lead `log::info!`.
  const nsOf = (last) => (last ? ns : 'type')
  const isModule = (path, last) => tree.has(path) && !(last && ns === 'macro') // a `mod m` is no `m!`
  const lookup = (at, name, want) => (at === from && file !== undefined ? providedFrom(root, at, name, ctx, file, asker, want) : provided(root, at, name, from, ctx, asker, want))
  let cur = head === 'crate' ? ['crate'] : from.split('::')
  let i = head === 'crate' || head === 'self' ? 1 : 0
  let via
  if (!PATH_KEYWORDS.has(head) && !isModule(`${from}::${head}`, segments.length === 1)) {
    const want = nsOf(segments.length === 1)
    const p = lookup(from, head, want)
    if (p === null || p === VALUE_ONLY) {
      // An item of the module itself (`enum Kind { … } use Kind::*;`).
      const own = definedIn(root, from, head, ctx, asker, want)
      if (own !== null) return itemAt(own)
      if (want === 'type' && (p === VALUE_ONLY || onlyValues(root, from, head, ctx))) return VALUE_ONLY
      return segments.length === 1 && file !== undefined && definesMacro(ctx, file, head) ? { kind: 'item', file } : null
    }
    via = { modulePath: from, consumed: 0, through: p.through }
    if (p.kind === 'crate') return { ...p, via, rest: segments.slice(1) }
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
    const macro = at === 'crate' && last && ns !== 'macro' ? ctx.macros.get(root)?.get(name) : undefined
    const child = `${at}::${name}`
    const want = nsOf(last)
    let p
    if (isModule(child, last)) {
      // A child module the asker's build doesn't (or presumably doesn't: serde's docsrs-only `mod de` beside
      // `pub use serde_core::de`) compile gives way to what else the module has of the name.
      const sets = (ctx.moduleFiles.get(root)?.get(child) ?? [tree.get(child)]).map((f) => ctx.files.get(f)?.leaves).filter((set) => set !== undefined)
      const away = sets.length > 0 && sets.every((set) => deadFor(asker, set) || doubtful(asker, set))
      p = away ? lookup(at, name, want) : null
      if (p === null || p === VALUE_ONLY) {
        // One file there only under cfgs the asker doesn't hold (`#[cfg(not(unix))] mod sys;` beside
        // `#[cfg(unix)] use fallback as sys;`): what else the module binds the name to is a branch too.
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

// The few of a closure's hundreds of modules globMayProvide has to look at.
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

// Whether a glob `at` sees may bring `lead` in unseen (`use syn::*;`) or does from another in-tree crate: then a
// lead nothing explains is no missing crate. Asked again while being answered, it reads as no.
function globMayProvide(root, at, lead, ctx) {
  const memo = nestedMap(ctx.opaque, root)
  const key = `${at}\0${lead}`
  if (memo.has(key)) return memo.get(key)
  memo.set(key, false)
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
  // Whether another crate's module (root `file`) may make `lead` visible: anything, for a crate not in-tree.
  const inCrate = (file, module) => !ctx.trees.has(file) || hasAll(file, module, lead, 1, ctx).length > 0 || providedAll(file, module, lead, 1, ctx).get(0) !== undefined || globMayProvide(file, module, lead, ctx)
  let answer = reach.unseen.size > (reach.unseen.has(lead) ? 1 : 0)
  for (const { im, source } of reach.crates) {
    if (answer || im.segments[0] === lead) break
    // `sync` of `use tokio::sync::*;`, when the lead itself named the crate (no `via`).
    const rest = source.via === undefined ? im.segments.slice(1) : []
    const there = rest.length === 0 || !ctx.trees.has(source.file) ? { kind: 'module', modulePath: 'crate' } : walkPath(['crate', ...rest], source.file, 'crate', ctx)
    if ((there?.kind === 'module' && inCrate(source.file, there.modulePath)) || (there?.kind === 'crate' && inCrate(there.file, 'crate'))) answer = true
  }
  memo.set(key, answer)
  return answer
}

// `{ kind: 'unresolved' }` for a lead that could name a crate but nothing in-tree did.
const NO_BINDINGS = new Set()
function resolvePathRef(ref, file, bindings, ctx) {
  const { segments, absolute, inlinePath } = ref
  if (segments.length === 0) return null
  const here = ctx.files.get(file)
  const from = here ? [here.modulePath, ...inlinePath].join('::') : null
  const opts = { ns: ref.macroCall ? 'macro' : null, file, asker: here?.asker }
  let valueOnly = false
  if (!absolute && here) {
    const r = walkPath(segments, here.root, from, ctx, opts)
    if (r === VALUE_ONLY) valueOnly = true // bound here, but as a value: `log::…` names the crate
    else if (r !== null && r.kind === 'crate' && ref.macroCall && r.rest?.length > 0) return { ...r, macro: macroOfCrate(r.file, r.rest, ctx) ?? undefined }
    else if (r !== null) return r
  }
  const lead = crateLead(ref, valueOnly ? NO_BINDINGS : bindings)
  if (lead === null) return null
  const name = ctx.externPrelude.get(here?.root)?.get(lead) ?? lead
  if (name === 'self') {
    const r = walkPath(['crate', ...segments.slice(1)], here.root, from, ctx, opts)
    return r === VALUE_ONLY ? null : r
  }
  const target = ctx.resolveCrate(name, file)
  if (target) return { kind: 'crate', name, file: target, alternatives: ctx.crateAlternatives(name, file), macro: ref.macroCall && segments.length > 1 ? macroOfCrate(target, segments.slice(1), ctx) ?? undefined : undefined }
  // At the crate root an exported macro is an item (anyhow's `pub use anyhow as format_err;`).
  const macro = segments.length === 1 && from === 'crate' ? ctx.macros.get(here.root)?.get(lead) : undefined
  if (macro !== undefined) return { kind: 'item', file: macro }
  // A glob into a crate that isn't in-tree (`use serde::*;`) may bring the lead in, unless the package declares a
  // dependency of that name: one missing from the bundle is reported whatever the globs beside it.
  return here && !ctx.declaresCrate(name, file) && globMayProvide(here.root, from, lead, ctx) ? null : { kind: 'unresolved', name }
}

const note = (map, root, name, module) => upsert(nestedMap(map, root), name, () => new Set()).add(module)

// Bundle import keys can't contain '/'; a cfg predicate practically never does, but fail safe.
const cfgKey = (cfg) => (cfg ?? '*').replaceAll('/', '|')
const freshKey = (map, base) => {
  let key = base
  for (let k = 2; map.has(key); k++) key = `${base}#${k}`
  return key
}

const isTestTarget = (rel, ctx) => (ctx ? ctx.isTestTarget(rel) : isTestTargetPath('.', rel))

// A call in a template is made where that macro is invoked: the outermost call site, as rustc resolves it.
function effectiveInvokers(name, invokers, templateCalls, seen = new Set()) {
  if (seen.has(name)) return new Set()
  seen.add(name)
  const out = new Set(invokers.get(name) ?? [])
  for (const [caller, called] of templateCalls) if (called.has(name)) for (const f of effectiveInvokers(caller, invokers, templateCalls, seen)) out.add(f)
  return out
}
// Calls by path are matched by name: a `$crate::m!` resolves where the macro is invoked as surely as `m!`.
function noteMacroCalls(invokers, templateCalls, path, items) {
  for (const name of [...items.invocations, ...items.pathInvocations]) upsert(invokers, name, () => new Set()).add(path)
  for (const m of items.macros) for (const name of [...m.calls, ...m.pathCalls]) upsert(templateCalls, m.name, () => new Set()).add(name)
}
// Of `from`'s package (a macro of the same name elsewhere is likely another), unless `#[macro_export]`ed.
const hostsOf = (name, from, invokers, templateCalls, packageOf) => [...effectiveInvokers(name, invokers, templateCalls)].filter((f) => packageOf === null || packageOf(f) === packageOf(from))
// The copies of template `mod` `decl` a file invoking its macro declares: one per inline module invoking the
// macro (or one whose template calls it), at the first such invocation (`offset`, for textual scope).
function hostedCopies(decl, items, templateCalls) {
  const names = new Set([decl.template])
  for (let grew = true; grew;) {
    grew = false
    for (const [caller, called] of templateCalls) if (!names.has(caller) && [...called].some((n) => names.has(n))) grew = names.add(caller)
  }
  const sites = [...names].flatMap((n) => items.callSites.get(n) ?? []).toSorted((a, b) => a.offset - b.offset)
  const byModule = new Map()
  for (const site of sites) if (!byModule.has(site.inlinePath.join('::'))) byModule.set(site.inlinePath.join('::'), site)
  if (byModule.size === 0) byModule.set('', { offset: Infinity, inlinePath: [], inlineDirs: [] })
  const own = (list) => list.slice(decl.templateDepth)
  return [...byModule.values()].map((site) => ({ ...decl, inlinePath: [...site.inlinePath, ...own(decl.inlinePath)], inlineDirs: [...site.inlineDirs, ...own(decl.inlineDirs)], offset: site.offset }))
}
const templatesLess = memoized((own) => new Set([...TEMPLATE_MACROS].filter((name) => !own.has(name))), (own) => [...own].toSorted().join())

const DEFAULT_UNITS = new Set([TARGET_UNIT])
const unitsOf = (units, rel) => units?.get(rel) ?? DEFAULT_UNITS
// Whether adding `more` to `map`'s set for `file` is news.
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
// Each entry `units` doesn't name is compiled as its package is: a proc-macro crate for the host, as cargo builds it.
function withEntryUnits(units, entries, ctx) {
  const out = units ?? new Map()
  for (const e of entries) if (!out.has(e)) out.set(e, new Set([ctx?.unitOfCrate(e, TARGET_UNIT) ?? TARGET_UNIT]))
  return out
}

// scanRustItems' options for `rel`, interned per (package, test, units) so a scan of the same build is reused.
const buildMemo = new WeakMap()
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

// The tree pass reuses the walk's scan under the same build and content (a caller may edit a map it reuses).
const scanCache = new WeakMap()
function cachedScan(sources, path, content, build, templates = undefined) {
  const cache = upsert(scanCache, sources, () => new Map())
  const key = templates === undefined ? path : `${path}\0${[...templates].join()}`
  const hit = cache.get(key)
  if (hit && hit.content === content && hit.build === build) return hit.items
  const items = scanRustItems(content, templates === undefined ? build : { ...build, templates })
  cache.set(key, { build, content, items })
  return items
}

// `mod` edges (each crate root's module tree), then paths against it. `resolutions`: file → spec (`mod a::b`, a
// path as written, `use <crate>`) → file, or a cfg key → file Map; `wantedRoots`: in-tree roots `sources` lacks.
export function buildRustTree(sources, { roots = [], baseDir = null, cargo = null, formats = null, units: given = null } = {}) {
  const ctx = cargo ?? (baseDir ? createCargoContext(baseDir, { entries: roots }) : null)
  const units = withEntryUnits(given, roots, ctx)
  const rootSet = crateRoots(sources, roots, ctx)
  const resolutions = new Map()
  const missing = []
  const scanned = new Map()
  for (const [path, content] of sources) {
    if (!formats?.has(path)) scanned.set(path, cachedScan(sources, path, content, buildOf(path, ctx, units)))
  }
  // A package defining its own `quote!` invokes that one everywhere in it: files that skipped one are rescanned.
  const packageOf = memoized((path) => (ctx ? ctx.packageInfo(path)?.dir ?? '.' : path.startsWith(`${VENDOR_DIR}/`) ? path.split('/', 2).join('/') : '.'))
  const ownTemplates = new Map()
  for (const [path, items] of scanned) {
    for (const m of items.macros) if (TEMPLATE_MACROS.has(m.name)) upsert(ownTemplates, packageOf(path), () => new Set()).add(m.name)
  }
  for (const [path, items] of scanned) {
    const own = items.skipped.size > 0 ? ownTemplates.get(packageOf(path)) : undefined
    if (own === undefined || own.isDisjointFrom(items.skipped)) continue
    scanned.set(path, cachedScan(sources, path, sources.get(path), buildOf(path, ctx, units), templatesLess(own)))
  }
  const invokers = new Map()
  const templateCalls = new Map()
  for (const [path, items] of scanned) noteMacroCalls(invokers, templateCalls, path, items)
  // A `mod` a template declares is declared in each module invoking the macro (serde_core's `crate_root! { … pub
  // mod de; … }`), of its own package unless `#[macro_export]`ed; it keeps its defining file and mounting cfgs.
  const hosted = new Map()
  const hostedAway = new Set()
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
  // A `mod` an `include!`d file declares resolves beside it, as rustc does: like a `#[path]`-loaded file's.
  const pathLoaded = new Set()
  for (const [path, items] of scanned) {
    for (const inc of items.includes) {
      if (inc.kind !== 'include') continue
      const file = includeTarget(inc, path, ctx)
      if (file !== null && file !== path && sources.has(file)) pathLoaded.add(file)
    }
  }
  // Files a `#[path]` names own their directory too, so find those before any default `mod` lookup; a path-loaded
  // file may itself hold inline modules with `#[path]`s, hence the loop to a fixed point.
  const modOpts = { knownSources: sources, roots: rootSet, pathLoaded }
  const declsOf = (path, decl) => resolveModDecl(decl, path, { ...modOpts, boundary: boundaryOf(path, ctx) })
  for (let size = -1; size !== pathLoaded.size;) {
    size = pathLoaded.size
    for (const path of scanned.keys()) {
      for (const decl of modsOf(path)) {
        if (decl.paths.length === 0) continue
        for (const t of declsOf(path, decl)) if (t.explicit) pathLoaded.add(t.file)
      }
    }
  }
  // Relative to each file in effect invoking the template; every definition of a name counts.
  const includeEdges = new Map()
  for (const items of scanned.values()) {
    for (const m of items.macros) {
      if (m.includes.length === 0) continue
      const incs = m.includes.map((inc) => ({ ...inc, conditional: true }))
      for (const f of effectiveInvokers(m.name, invokers, templateCalls)) upsert(includeEdges, f, () => []).push(...incs)
    }
  }
  // file → spec → target file → the declarations mounting it: each its cfg, the macro body it sits in and, for a
  // hosted template `mod`, the declarations here mounting its defining file (`via`).
  const mountCfgs = new Map()
  for (const [path, items] of scanned) {
    // spec → cfg key → file ('*' ungated, `<macro>!` for one a macro emits under a cfg the loader can't see), so
    // same-name `mod`s under different cfgs keep each file; another file under a taken key gets it numbered.
    const byCfg = new Map()
    const cfgsHere = nestedMap(mountCfgs, path)
    for (const decl of modsOf(path)) {
      const spec = `mod ${[...decl.inlinePath, decl.name].join('::')}`
      const targets = declsOf(path, decl)
      if (targets.length === 0) {
        // A cfg-gated module may be compiled out: tolerated.
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
    // A single file is a flat string, also when every cfg names the same file (libc's `mod primitives`).
    const specMap = new Map()
    for (const [spec, keyed] of byCfg) {
      const distinct = new Set(keyed.values())
      specMap.set(spec, distinct.size === 1 ? [...distinct][0] : keyed)
    }
    for (const inc of [...items.includes, ...(includeEdges.get(path) ?? [])]) {
      const file = includeTarget(inc, path, ctx)
      if (file !== null && file !== path && sources.has(file)) specMap.set(`${inc.kind} ${inc.path}`, file)
      else if (!inc.conditional) console.warn(`[loader.rust] Missing include: ${inc.path} from ${path}`)
    }
    if (items.unfollowed > 0) console.warn(`[loader.rust] ${items.unfollowed} include${items.unfollowed === 1 ? '' : 's'} in ${path} name${items.unfollowed === 1 ? 's' : ''} a path the loader can't follow (not a literal)`)
    resolutions.set(path, specMap)
  }

  // Each package's gate macros: null when unreadable, or when the package defines the name twice, differently.
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
  const leafSets = new Map()
  const askerSets = new Map()
  const ids = new WeakMap()
  let nextId = 0
  const idOf = (object) => upsert(ids, object, () => nextId++)
  // Known platform cfgs hold for a file; one compiled for both target and host knows them only when they are one.
  const leavesOfCfgs = memoized((cfgs) => leafSet([...cfgs].flatMap(cfgLeaves).filter((l) => TARGET_CFG_KEYS.has(l.key)), leafSets))
  const platformCfgsOf = (path) => {
    const each = new Set([...unitsOf(units, path)].map((u) => ctx?.platformOf(u)?.cfgs ?? null))
    return each.size === 1 ? [...each][0] : null
  }
  for (const [path, f] of files) {
    f.leaves = leafSet(f.leaves, leafSets)
    const cfgs = platformCfgsOf(path)
    const joined = cfgs === null ? f.leaves : unionLeaves(f.leaves, leavesOfCfgs(cfgs), leafSets)
    // A file the target rules out (tokio's atomic_u64_as_mutex.rs on a 64-bit target) asks under its own cfgs. One
    // whose own contradict each other is compiled nowhere: every candidate is compatible with it, none certain.
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
    const byParent = nestedMap(children, root)
    for (const modulePath of tree.keys()) {
      const cut = modulePath.lastIndexOf('::')
      if (cut !== -1) upsert(byParent, modulePath.slice(0, cut), () => new Set()).add(modulePath.slice(cut + 2))
    }
  }
  // A `mod` with cfg variants has several files, any of which a build may compile.
  const moduleFiles = new Map()
  for (const [path, f] of files) upsert(nestedMap(moduleFiles, f.root), f.modulePath, () => []).push(path)
  // What a path may continue along where a segment names no module; `scopeDepth`: how far visibility reaches.
  const imports = new Map()
  const defined = new Map()
  const modScope = new Map()
  const macros = new Map()
  const exportedMacros = new Map()
  const fileMacros = new Map()
  const externPrelude = new Map()
  const itemLeaves = (here, x, path) => unionLeaves(here.leaves, leafSet([...cfgLeaves(x.cfg), ...gateLeaves(x.macro, gatesOf(path))], leafSets), leafSets)
  const scopeDepthOf = (vis, modulePath) => visibilityScope(vis, modulePath).split('::').length
  // Bare `name!` calls resolve in textual scope, as in rustc: a `macro_rules!` is in scope to the end of its file,
  // in the files the `mod`s after it mount, and past a `#[macro_use] mod` in the mounting file.
  const mounts = new Map()
  const macroUseMods = new Map()
  const filesOf = (target) => (target instanceof Map ? [...target.values()] : [target])
  // In tree order, so among several files defining or importing a name for one module the tree's own comes first.
  for (const [path, here] of files) {
    const items = scanned.get(path)
    if (items === undefined) continue
    for (const im of items.imports) {
      // A `use $crate::…` in a template is the invoking module's. (One without `$crate` is kept: serde wraps its
      // whole root in a macro, whose `mod lib { pub use core::fmt; … }` every file's `use crate::lib::*` names.)
      if (im.template === true) continue
      const modulePath = [here.modulePath, ...im.inlinePath].join('::')
      const of = upsert(nestedMap(imports, here.root), modulePath, () => ({ named: new Map(), globs: [] }))
      const entry = { ...im, file: path, module: modulePath, scopeDepth: scopeDepthOf(im.vis, modulePath), leaves: itemLeaves(here, im, path) }
      if (im.glob) of.globs.push(entry)
      else if (im.binding !== null) upsert(of.named, im.binding, () => []).push(entry)
    }
    for (const d of items.defined) {
      const modulePath = [here.modulePath, ...d.inlinePath].join('::')
      const names = nestedMap(nestedMap(defined, here.root), modulePath)
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
      upsert(nestedMap(macros, here.root), m.name, () => path)
      upsert(nestedMap(exportedMacros, here.root), m.name, () => []).push({ file: path, leaves: itemLeaves(here, m, path) })
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
  // The macros a file mounted with `#[macro_use]` hands the file mounting it, its own `#[macro_use] mod`s' too.
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
  // A file's macro events in source order. `offset` is where an item stands, `at` where it is written: they
  // differ for what a template emits (serde's `tri`, standing at `crate_root!`).
  const fileEvents = memoized((file) => [
    ...(scanned.get(file)?.macros ?? []).map((m) => ({ offset: m.offset, at: m.at, macros: new Map([[m.name, file]]) })),
    ...(macroUseMods.get(file) ?? []).map((u) => ({ offset: u.offset, at: u.at, macros: new Map(u.files.flatMap((f) => [...macroExports(f)])) })),
  ].toSorted((a, b) => a.offset - b.offset || a.at - b.at))
  const before = (e, offset, at) => e.offset < offset || (e.offset === offset && e.at < at)
  // The later definition of a name shadows the earlier, whichever kind each is.
  const textualScope = (file, offset, at, scope) => {
    const out = new Map(scope)
    for (const e of fileEvents(file)) {
      if (!before(e, offset, at)) break
      for (const [name, where] of e.macros) out.set(name, where)
    }
    return out
  }
  const macroAt = (file, name, offset, at, scope) =>
    fileEvents(file).findLast((e) => before(e, offset, at) && e.macros.has(name))?.macros.get(name) ?? scope.get(name)
  // What a file sees from above: the parent's textual scope at the `mod` mounting it.
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
  // Per (name, file), asked once per reference: renames, a build script's tables and platforms differ by file.
  const crates = new Map()
  const crateOf = (name, from) => upsert(crates, `${name}\0${from}`, () => {
    const found = ctx ? ctx.crateCandidates(name, from, { roots: files.get(from)?.roots ?? null, units: unitsOf(units, from) }) : []
    const file = found[0]?.file ?? resolveVendoredCrate(name, { knownSources: sources })
    return { file, alternatives: found.length > 1 ? new Map(found.map((c) => [cfgKey(c.key), c.file])) : undefined }
  })
  const resolveCrate = (name, from) => crateOf(name, from).file
  const crateAlternatives = (name, from) => crateOf(name, from).alternatives
  // The crates whose exported macros a root's `#[macro_use] extern crate`s bring into every module's scope.
  const macroUseCrates = memoized((root) => (scanned.get(root)?.externCrates ?? []).filter((e) => e.macroUse && !NON_CRATE_LEADS.has(e.name)).map((e) => resolveCrate(e.name, root)).filter(Boolean))
  // Per crate root, name → the modules with anything of the name: what hasAll may answer for.
  const having = new Map()
  for (const [root, byParent] of children) for (const [parent, names] of byParent) for (const name of names) note(having, root, name, parent)
  for (const [root, byModule] of defined) for (const [module, names] of byModule) for (const name of names.keys()) note(having, root, name, module)
  for (const [root, byModule] of imports) for (const [module, of] of byModule) for (const name of of.named.keys()) note(having, root, name, module)
  for (const [root, byName] of macros) for (const name of byName.keys()) note(having, root, name, 'crate')
  const declaresCrate = (name, from) => ctx?.declaresCrate?.(name, from) === true
  const pathCtx = { trees, children, moduleFiles, files, resolveCrate, crateAlternatives, declaresCrate, imports, defined, modScope, macros, exportedMacros, fileMacros, externPrelude, leafSets, having, provided: new Map(), closures: new Map(), opaque: new Map(), opaqueGlobs: new Map(), walking: 0, hits: new Set() }
  // Resolved once more when the first pass left glob closures short of an import cycle.
  const resolveAll = () => {
    const out = new Map()
    const unresolved = new Set()
    const wanted = new Map()
    for (const [path, items] of scanned) {
      const specMap = new Map(resolutions.get(path))
      out.set(path, specMap)
      resolveFile(path, items, specMap, unresolved, wanted)
    }
    return { out, unresolved, wanted }
  }
  const resolveFile = (path, items, specMap, unresolved, wanted) => {
    // Only edges to bundled files, never to self, first spelling wins; alternatives as a cfg-keyed map.
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
    // A root the walk didn't load, or loaded as fewer units than this file names it as: the caller may load it again.
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
    // An uppercase lead is an `Enum::Variant` import, not a crate.
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
        // Only a `use`, or the package declaring a dependency of that name, reliably says a lead names a crate.
        if (ref.fromUse || declaresCrate(r.name, path)) noteUnresolved(r.name)
        continue
      } else add(ref.macroCall ? `${ref.spec}!` : ref.spec, r.file, r.alternatives) // `crate::helper!()` beside `crate::helper()`: two edges
      // Not the crate root, which every file of the crate hangs off anyway.
      const v = r.via
      if (v && v.consumed > 0 && v.through !== path && v.through !== here.root && v.through !== r.file && !via.has(v.through)) {
        via.set(v.through, ref.segments.slice(0, v.consumed).join('::'))
      }
    }
    for (const { name } of items.externCrates) {
      if (NON_CRATE_LEADS.has(name)) continue
      const { file: target, alternatives } = crateOf(name, path)
      if (target) addCrate(name, target, alternatives)
      else noteUnresolved(name)
    }
    // A bare `name!`: one in textual scope, else one the imports bring in (a sibling's `macro_rules! vec` isn't `vec!`).
    if (here !== undefined) {
      const above = inherited(path)
      const exported = here.modulePath === 'crate' ? macros.get(here.root) : undefined
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
        // Scope is decided per call; the bare calls in the invoked macro's template are made here too.
        const found = new Map()
        for (const offset of offsets) {
          const seen = new Set()
          const expand = (called) => {
            if (seen.has(called)) return
            seen.add(called)
            const macro = macroFileAt(called, offset)
            if (macro === undefined) return
            found.set(`${called}!\0${macro.file}`, [`${called}!`, macro.file, macro.alternatives])
            for (const m of scanned.get(macro.file)?.macros ?? []) if (m.name === macro.name) for (const inner of m.calls) expand(inner)
          }
          expand(name)
        }
        for (const [spec, file, alternatives] of found.values()) add(spec, file, alternatives)
      }
    }
    // A module whose import a path went through is a dependency of the file too (bitflags'
    // `$crate::__private::serde::Serialize` needs the root's `__private`), recorded when nothing else points at it.
    const targets = new Set()
    for (const t of specMap.values()) for (const f of t instanceof Map ? t.values() : [t]) targets.add(f)
    for (const [owner, spec] of via) if (!targets.has(owner)) add(spec, owner)
  }
  let { out, unresolved, wanted } = resolveAll()
  if (stabilizeClosures(pathCtx)) ({ out, unresolved, wanted } = resolveAll())
  return { sources, resolutions: out, missing, unresolvedCrates: unresolved, wantedRoots: [...wanted.keys()], wantedUnits: wanted }
}

// Reads each file once into `sources`, an earlier walk's too: a file now compiled as more units is gone through again.
export async function collectRustFilesFromDisk(baseDir, entries, { cargo = null, formats = null, sources = new Map(), units = new Map(), crateRoots: rootsOf = new Map(), unloaded = new Set() } = {}) {
  const realBase = realpathSync(baseDir)
  const roots = new Set(entries)
  const pathLoaded = new Set()
  const assets = new Map() // carried as they are, not scanned
  const rustFiles = new Set(entries) // never an asset
  const ctx = cargo ?? createCargoContext(baseDir, { entries })
  const modOpts = { baseDir, roots, pathLoaded }
  // file → the directory it must really lie in: a vendored crate's files stay in its package, symlinks included.
  const boundaries = new Map(entries.map((e) => [e, boundaryOf(e, ctx)]))
  const realDirs = new Map()
  // Template definitions and invocations arrive in any order, so each side is kept and paired.
  const templateIncludes = new Map()
  const templateMods = new Map()
  const templateCalls = new Map()
  const invokers = new Map()
  const scansOf = new Map()
  // A package defining its own `quote!` has its files scanned again without the name (see buildRustTree).
  const packageOf = (rel) => ctx.packageInfo(rel)?.dir ?? '.'
  const ownTemplates = new Map()
  const skippedIn = new Map()
  const scanFor = (relPath, content) => {
    const own = ownTemplates.get(packageOf(relPath))
    return cachedScan(sources, relPath, content, buildOf(relPath, ctx, units), own === undefined ? undefined : templatesLess(own))
  }
  withEntryUnits(units, entries, ctx)
  for (const e of entries) addTo(rootsOf, e, new Set([e]))
  // Files walked before and now compiled as more units, or in more crates: what they name may change.
  const revisit = new Set(entries.filter((e) => sources.has(e) && !formats?.has(e)))

  // Compiled as the naming file is (its units, its crates) unless `as`/`crate` say otherwise.
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
  // `from`: the file an include or `mod` is written in, or one invoking the macro whose body it is in.
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
  const modFrom = (decl, from) => {
    for (const { file, explicit } of resolveModDecl(decl, from, { ...modOpts, boundary: boundaryOf(from, ctx) })) {
      if (explicit) pathLoaded.add(file)
      queue(from, file, { rust: true })
    }
  }
  const hostsOfMod = (name, { from, exported }) => hostsOf(name, from, invokers, templateCalls, exported ? null : packageOf)
  const expandTemplates = () => {
    for (const [name, incs] of templateIncludes) {
      for (const f of effectiveInvokers(name, invokers, templateCalls)) for (const inc of incs) includeFrom(inc, f)
    }
    for (const [name, decls] of templateMods) {
      for (const t of decls.values()) for (const f of hostsOfMod(name, t)) for (const copy of hostedCopies(t.decl, scansOf.get(f), templateCalls)) modFrom(copy, f)
    }
  }

  // A template's `mod`s nothing in its package invokes stand beside its definition, walked once nothing else is left.
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
          // Rust source and an `include_str!` asset are UTF-8 or rustc rejects them: one that isn't is refused,
          // never carried with its bytes replaced. An `include_bytes!` asset is any bytes, base64 if need be.
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
    // Run again for a file whose package turned out to define a template macro: its `quote!` bodies are its own then.
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
      // A template's `mod`s and includes wait for the files invoking it (expandTemplates).
      for (const decl of mods) {
        if (decl.template === null) modFrom(decl, relPath)
        else nestedMap(templateMods, decl.template).set(`${relPath}\0${decl.at}`, { decl, from: relPath, exported: macros.some((m) => m.name === decl.template && m.exported) })
      }
      for (const inc of includes) includeFrom(inc, relPath)
      for (const m of macros) {
        if (m.includes.length === 0) continue
        const list = upsert(templateIncludes, m.name, () => [])
        for (const inc of m.includes) if (!list.some((x) => x.kind === inc.kind && x.path === inc.path && x.base === inc.base)) list.push(inc)
      }
      noteMacroCalls(invokers, templateCalls, relPath, items)
      scansOf.set(relPath, items)
      // A reference to an in-tree crate pulls its root in, a crate root by role whatever its name (`[lib] path`).
      const leads = new Set()
      for (const e of externCrates) if (!NON_CRATE_LEADS.has(e.name)) leads.add(e.name)
      for (const name of refs.map((r) => crateLead(r, bindings))) if (name !== null) leads.add(name)
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

// Walks again the roots the tree pass wants until none is new; one refused or gone isn't asked for again.
export async function collectRustBundle(baseDir, entries, { cargo, buildScripts = false }) {
  const formats = new Map()
  const sources = new Map()
  const units = new Map()
  const rootsOf = new Map()
  const unloaded = new Set()
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
