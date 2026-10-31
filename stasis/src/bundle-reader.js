import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'

import { trailingJunkError } from '@exodus/stasis-core/brotli'
import { Bundle } from '@exodus/stasis-core/bundle'
import { assert } from '@exodus/stasis-core/util'

import { JsonStreamParser } from './json-stream.js'

// Rejects as soon as `signal` aborts, without waiting for `promise` (onFile gets the signal to stop itself).
const untilAborted = (promise, signal) => (signal === undefined ? promise : new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason)
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
}))

// Left in place of each streamed file; fromJSON's contents-free mode requires one per file.
const STREAMED = Symbol('streamed')

// parseBundleBytes(source), without holding the decompressed bytes or the JSON text whole.
// onFile gets each file in stream order, wherever the bundle puts its files, and before the bundle is
// validated: what it receives (format included) is provisional until readBundle resolves. See doc/file-formats.md.
export async function readBundle(source, { onFile, signal } = {}) {
  assert(onFile === undefined || typeof onFile === 'function', 'readBundle: onFile must be a function')
  let input = source
  if (typeof source === 'string' || source instanceof URL) input = createReadStream(source)
  else if (source instanceof ArrayBuffer) input = [new Uint8Array(source)]
  else if (ArrayBuffer.isView(source)) input = [new Uint8Array(source.buffer, source.byteOffset, source.byteLength)]

  const formats = new Map() // as far as they have streamed: newer bundles put them before any file
  const delivered = new Map() // file -> the format onFile was given
  const pending = []
  const parser = new JsonStreamParser(onFile && {
    onString(contents, path) {
      if (path.length === 2 && path[0] === 'formats') formats.set(path[1] === '' ? '.' : path[1], contents)
      const file = Bundle.fileKeyAt(path)
      if (file === undefined) return contents
      assert(!delivered.has(file), `bundle carries file '${file}' twice`)
      const format = formats.get(file)
      delivered.set(file, format)
      pending.push([file, contents, format])
      return STREAMED
    },
  })

  // Big chunks let zlib's thread pool decompress ahead of the parser; zlib's 16 KiB default runs about 2x slower.
  const decompress = createBrotliDecompress({ chunkSize: 1024 * 1024, readableHighWaterMark: 4 * 1024 * 1024 })
  // The decoder ends its output at the end of the brotli stream and consumes nothing after it, so
  // the bytes it was given and the bytes it consumed (its bytesWritten) differ by exactly those.
  let given = 0
  async function* counted() {
    for await (const chunk of input) {
      given += Buffer.byteLength(chunk)
      yield chunk
    }
  }
  let drained = false
  await pipeline(counted, decompress, async (chunks) => {
    for await (const chunk of chunks) {
      parser.write(chunk)
      for (const [file, contents, format] of pending.splice(0)) {
        signal?.throwIfAborted() // one chunk can queue many files
        // eslint-disable-next-line no-await-in-loop -- in stream order, with backpressure on the decompressor
        await untilAborted(onFile(file, contents, { signal, format }), signal)
      }
    }
    drained = true
  }, { signal }).catch((error) => {
    // Output that ends before the input does is a premature close to pipeline: refused just below.
    if (!drained || signal?.aborted || decompress.bytesWritten === given) throw error
  })
  if (decompress.bytesWritten !== given) throw trailingJunkError()

  const bundle = Bundle.fromJSON(parser.end(), { contents: !onFile })
  if (onFile) {
    // fromJSON required a placeholder per file, so onFile got each one; it must have got nothing else.
    let files = 0
    for (const [, info] of bundle.modules) files += Object.keys(info.files).length
    assert(delivered.size === files, 'bundle carries file contents outside its file list')
    // A later `formats` key replaces the one onFile was told about.
    for (const [file, format] of delivered) {
      if (format !== undefined && bundle.formats.get(file) !== format) assert(false, `bundle file '${file}' changed format after onFile got it`)
    }
  }
  return bundle
}
