// A report's tables, as `stasis audit` and `stasis validate` print them, and their colours where the
// stream they go to takes colours.
import { styleText } from 'node:util'

// Strip line breaks (LF/CR/CRLF, U+2028/U+2029) from a cell (an advisory's title, say) so they can't
// break the box layout.
const cell = (v) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/gu, ' ')

// Split a value into the physical lines a cell occupies. Non-multiline columns
// collapse every line break to a space via `cell` (one line). A column named in
// `multiline` (the `--why` reason column) keeps intentional `\n` breaks -- one
// physical line per entry -- while still flattening stray CR/separators in each.
const cellLines = (v, multiline) =>
  multiline ? String(v ?? '').split('\n').map((s) => cell(s)) : [cell(v)]

// A column that wraps narrows no further than its header, and its longest word up to this, so that only
// a longer word is ever cut.
const MAX_WHOLE_WORD = 20

// What a `multiline` column's entry wrapped starts its further lines with.
const INDENT = '  '

// `text` cut into lines of at most `width`, at spaces where it has them, a word wider than a line cut where
// it must be; each line after the first starts with `indent`.
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

// `rows` as a boxed table of `columns`, its header their names. `paint(text, column, row)`, where
// given, styles the text of each cell of a row (with colour, say), its padding after, unstyled;
// `paintHeader(text, column)` each name in the header, and `paintFrame(text)` the box drawn around them.
// Where `width` is given and the table is wider, the `wrap` columns narrow, the widest first, to fit it
// where they can (see MAX_WHOLE_WORD), their text wrapped (see wrapLine); a `multiline` column's further
// lines of an entry indented, so they don't read as entries of their own.
export function formatTable(rows, columns, { multiline = [], paint, paintHeader, paintFrame, width, wrap = [] } = {}) {
  if (rows.length === 0) return ''
  const ml = new Set(multiline)
  const linesOf = (obj) => columns.map((c) => cellLines(obj[c], ml.has(c)))
  const header = columns.map((c) => [c])
  let body = rows.map((r) => linesOf(r))
  const measure = () => columns.map((c, i) =>
    Math.max(c.length, ...body.map((cells) => Math.max(0, ...cells[i].map((l) => l.length))))
  )
  let widths = measure()
  // Each column's text, a space either side, and a border after it; one more border before the first.
  const total = () => widths.reduce((sum, w) => sum + w + 3, 1)
  const wrapping = columns.flatMap((c, i) => (wrap.includes(c) ? [i] : []))
  if (width !== undefined && wrapping.length > 0 && total() > width) {
    const indent = (i) => (ml.has(columns[i]) ? INDENT : '')
    const words = (i) => body.flatMap((cells) => cells[i].flatMap((l) => l.split(' ')))
    const floors = new Map(wrapping.map((i) => [i, Math.max(columns[i].length, indent(i).length + Math.min(MAX_WHOLE_WORD, Math.max(...words(i).map((w) => w.length))))]))
    while (total() > width) {
      const widest = wrapping.filter((i) => widths[i] > floors.get(i)).toSorted((a, b) => widths[b] - widths[a])[0]
      if (widest === undefined) break
      widths[widest]--
    }
    const narrowed = widths
    body = body.map((cells) => cells.map((lines, i) =>
      wrapping.includes(i) ? lines.flatMap((l) => wrapLine(l, narrowed[i], indent(i))) : lines))
    widths = measure()
  }
  const frame = (text) => (paintFrame ? paintFrame(text) : text)
  const bar = frame('│')
  const line = (l, m, r, fill) => frame(l + widths.map((w) => fill.repeat(w + 2)).join(m) + r)
  // A row spans as many physical lines as its tallest cell; shorter cells pad
  // out with blanks so the borders stay aligned.
  const render = (cells, style) => {
    const height = Math.max(...cells.map((c) => c.length))
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

// Whether `stream` takes colours, as @exodus/test tells it: CI's logs do, though no terminal; a
// terminal that has them does (a TTY's hasColors); a pipe, or a file, doesn't.
export function takesColors(stream) {
  return Boolean(process.env.CI) || Boolean(stream?.hasColors?.())
}

// Dimmed text's format: CI's logs show gray, not faint.
export const DIM = process.env.CI ? 'gray' : 'dim'

// `paint(format, text)`: `text` in `format` (util.styleText's: a colour, `bold`, or a list of them)
// where `colors` (else as `stream` takes them, takesColors), else as it is.
export function painter(stream, colors = takesColors(stream)) {
  return (format, text) => (colors && format && text !== '' ? styleText(format, text, { validateStream: false }) : text)
}
