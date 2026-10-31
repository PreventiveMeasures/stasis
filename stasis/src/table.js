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

// `rows` as a boxed table of `columns`, its header their names. `paint(text, column, row)`, where
// given, styles the text of each cell of a row (with colour, say), its padding after, unstyled.
export function formatTable(rows, columns, { multiline = [], paint } = {}) {
  if (rows.length === 0) return ''
  const ml = new Set(multiline)
  const linesOf = (obj) => columns.map((c) => cellLines(obj[c], ml.has(c)))
  const header = columns.map((c) => [c])
  const body = rows.map((r) => linesOf(r))
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...body.map((cells) => Math.max(0, ...cells[i].map((l) => l.length))))
  )
  const line = (l, m, r, fill) => l + widths.map((w) => fill.repeat(w + 2)).join(m) + r
  // A row spans as many physical lines as its tallest cell; shorter cells pad
  // out with blanks so the borders stay aligned.
  const render = (cells, row) => {
    const height = Math.max(...cells.map((c) => c.length))
    const out = []
    for (let i = 0; i < height; i++) {
      out.push('│ ' + cells.map((c, j) => {
        const text = c[i] ?? ''
        return (paint && row && text !== '' ? paint(text, columns[j], row) : text) + ' '.repeat(widths[j] - text.length)
      }).join(' │ ') + ' │')
    }
    return out.join('\n')
  }
  return [
    line('┌', '┬', '┐', '─'),
    render(header),
    line('├', '┼', '┤', '─'),
    ...body.map((cells, at) => render(cells, rows[at])),
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
