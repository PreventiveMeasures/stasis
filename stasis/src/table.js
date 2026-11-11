import { styleText } from 'node:util'

// Line breaks (LF/CR/CRLF, U+2028/U+2029) in a cell (an advisory's title, say) would break the box layout.
const cell = (v) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/gu, ' ')

// The physical lines a cell occupies: one, but a `multiline` column's (`--why`'s reason) one per `\n`-separated entry.
const cellLines = (v, multiline) => (multiline ? String(v ?? '').split('\n').map((s) => cell(s)) : [cell(v)])

// A fold, not Math.max(...): a column (a --why cell of 2000 chains, say) may hold more items than a call takes arguments.
const longest = (items, lengthOf = (item) => item.length) => items.reduce((max, item) => Math.max(max, lengthOf(item)), 0)

// A wrapping column narrows no further than its header, and its longest word up to this: only a longer word is cut.
const MAX_WHOLE_WORD = 20

const INDENT = '  '

// `text` cut into lines of at most `width`, at spaces where it has them; each after the first starts with `indent`.
function wrapLine(text, width, indent = '') {
  const lines = []
  let rest = text
  let prefix = ''
  while (prefix.length + rest.length > width) {
    const room = width - prefix.length
    const space = rest.lastIndexOf(' ', room)
    const at = space > 0 ? space : room
    lines.push(prefix + rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
    prefix = indent
  }
  if (rest !== '' || lines.length === 0) lines.push(prefix + rest)
  return lines
}

// `rows` as a boxed table of `columns`, `paint(text, column, row)` styling a cell's text (not its padding). Wider than
// `width`, its `wrap` columns narrow, the widest first, as far as MAX_WHOLE_WORD lets them.
export function formatTable(rows, columns, { multiline = [], paint, paintHeader, paintFrame, width, wrap = [] } = {}) {
  if (rows.length === 0) return ''
  const ml = new Set(multiline)
  const linesOf = (obj) => columns.map((c) => cellLines(obj[c], ml.has(c)))
  const header = columns.map((c) => [c])
  let body = rows.map(linesOf)
  const measure = () => columns.map((c, i) => Math.max(c.length, longest(body, (cells) => longest(cells[i]))))
  let widths = measure()
  // Each column's text, a space either side, and a border after it; one more border before the first.
  const total = () => widths.reduce((sum, w) => sum + w + 3, 1)
  const wrapping = columns.flatMap((c, i) => (wrap.includes(c) ? [i] : []))
  if (width !== undefined && wrapping.length > 0 && total() > width) {
    const indent = (i) => (ml.has(columns[i]) ? INDENT : '')
    const longestWord = (i) => longest(body, (cells) => longest(cells[i], (line) => longest(line.split(' '))))
    const floors = new Map(wrapping.map((i) => [i, Math.max(columns[i].length, indent(i).length + Math.min(MAX_WHOLE_WORD, longestWord(i)))]))
    while (total() > width) {
      const widest = wrapping.filter((i) => widths[i] > floors.get(i)).toSorted((a, b) => widths[b] - widths[a])[0]
      if (widest === undefined) break
      widths[widest]--
    }
    body = body.map((cells) => cells.map((lines, i) =>
      wrapping.includes(i) ? lines.flatMap((l) => wrapLine(l, widths[i], indent(i))) : lines))
    widths = measure()
  }
  const frame = (text) => (paintFrame ? paintFrame(text) : text)
  const bar = frame('│')
  const line = (l, m, r, fill) => frame(l + widths.map((w) => fill.repeat(w + 2)).join(m) + r)
  // A row spans as many physical lines as its tallest cell.
  const render = (cells, style) => {
    const height = longest(cells)
    const out = []
    for (let i = 0; i < height; i++) {
      out.push(`${bar} ${cells.map((c, j) => {
        const text = c[i] ?? ''
        return (style && text !== '' ? style(text, columns[j]) : text) + ' '.repeat(widths[j] - text.length)
      }).join(` ${bar} `)} ${bar}`)
    }
    return out.join('\n')
  }
  return [
    line('┌', '┬', '┐', '─'),
    render(header, paintHeader),
    line('├', '┼', '┤', '─'),
    ...body.map((cells, at) => render(cells, paint && ((text, column) => paint(text, column, rows[at])))),
    line('└', '┴', '┘', '─'),
  ].join('\n')
}

// As @exodus/test tells it: CI's logs take colours, though no terminal, as does a TTY that has them.
export function takesColors(stream) {
  return Boolean(process.env.CI) || Boolean(stream?.hasColors?.())
}

// Dimmed text's format: CI's logs show gray, not faint.
export const DIM = process.env.CI ? 'gray' : 'dim'

// `paint(format, text)`: `text` in util.styleText's `format` where `colors`, else as it is.
export function painter(stream, colors = takesColors(stream)) {
  return (format, text) => (colors && format && text !== '' ? styleText(format, text, { validateStream: false }) : text)
}
