import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createBrotliDecompress, createGunzip } from 'node:zlib'

import { trailingJunkError } from '@exodus/stasis-core/brotli'
import { Bundle } from '@exodus/stasis-core/bundle'
import { Lockfile } from '@exodus/stasis-core/lockfile'
import { sha512integrity } from '@exodus/stasis-core/state-util'
import { assert, assertFormatOf, BUNDLE_FORMATS, EXECUTE_BITS, formatOf, isGzip, LOCK_FILE, misnamedTgz, moduleFileKey } from '@exodus/stasis-core/util'

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

// Big chunks let zlib's thread pool decompress ahead of the parser; zlib's 16 KiB default runs about 2x slower.
const CHUNK = 1024 * 1024

// parseBundleBytes(source), or for a .stasis.tgz (`format`, else its path's name) the bundle stasis reads of it, without
// holding the compressed bytes whole. onFile gets each file in stream order, before the bundle is validated: what it
// receives is provisional until readBundle resolves.
export async function readBundle(source, { onFile, signal, format } = {}) {
  assert(onFile === undefined || typeof onFile === 'function', 'readBundle: onFile must be a function')
  assert(format === undefined || BUNDLE_FORMATS.has(format), `readBundle: format must be br or tgz (got ${JSON.stringify(format)})`)
  // A tgz is told by the name it is read under, as the built-in readers tell one, else by `format`; never by its bytes.
  const path = typeof source === 'string' ? source : source instanceof URL ? fileURLToPath(source) : undefined
  if (path !== undefined) assertFormatOf(path, format, `readBundle: format ${format}`)
  const tgz = (format ?? (path === undefined ? 'br' : formatOf(path))) === 'tgz'
  let input = source
  if (path !== undefined) input = createReadStream(source)
  else if (source instanceof ArrayBuffer) input = [new Uint8Array(source)]
  else if (ArrayBuffer.isView(source)) input = [new Uint8Array(source.buffer, source.byteOffset, source.byteLength)]
  if (tgz) return untilAborted(readTgz(input, { onFile, signal }), signal)
  return readBr(input, { onFile, signal }, path === undefined ? "the bundle is a tgz, which readBundle reads with format 'tgz' alone" : misnamedTgz(path))
}

async function readBr(input, { onFile, signal }, misnamed) {
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

  const decompress = createBrotliDecompress({ chunkSize: CHUNK, readableHighWaterMark: 4 * CHUNK })
  // Bytes given past the decoder's bytesWritten are trailing junk. Counting them takes `input` out of pipeline's
  // hands, so this destroys it on pipeline's signal as pipeline would: one waiting for a chunk holds it open.
  let given = 0
  async function* counted({ signal: stop }) {
    const destroy = () => input.destroy?.()
    stop.addEventListener('abort', destroy, { once: true })
    if (stop.aborted) destroy()
    // Held until its first two bytes are known: gzip's are refused, as the built-in readers refuse a tgz so named.
    let held = []
    let head = []
    try {
      for await (const chunk of input) {
        given += Buffer.byteLength(chunk)
        if (held === null) {
          yield chunk
          continue
        }
        held.push(chunk)
        head.push(...bytesOf(chunk).subarray(0, 2 - head.length))
        if (head.length < 2) continue
        assert(!isGzip(head), misnamed)
        yield* held
        held = null
      }
      if (held !== null) yield* held
    } finally {
      stop.removeEventListener('abort', destroy)
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
    const files = bundle.modules.values().reduce((sum, info) => sum + Object.keys(info.files).length, 0)
    assert(delivered.size === files, 'bundle carries file contents outside its file list')
    // A later `formats` key replaces the one onFile was told about.
    for (const [file, format] of delivered) {
      if (format !== undefined && bundle.formats.get(file) !== format) assert(false, `bundle file '${file}' changed format after onFile got it`)
    }
  }
  return bundle
}

function bytesOf(chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  assert(chunk instanceof ArrayBuffer, 'readBundle: a chunk is not bytes')
  return new Uint8Array(chunk)
}
const isZeros = (bytes) => bytes.every((byte) => byte === 0)
const isFileEntry = ({ type }) => type === 'file' || type === 'contiguous-file'
// As Bundle.fromTar decodes a lockfile and code: UTF-8 as it is, a byte order mark kept as text.
const utf8 = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// The tar of a .stasis.tgz's chunks, as parse.js's gunzipStrict reads it whole: each gzip member, as gzip(1) reads on
// into a second, then zeros alone, bounded at `maxBytes`. zlib stops at the first zero after a member, as gunzipSync
// does, and what follows is never fed to it (it would read on into a member past the zeros), only held to be zeros:
// each chunk is fed once zlib has taken the one before, so where it stopped is known.
async function* gunzipped(input, signal, maxBytes) {
  const gunzip = createGunzip({ chunkSize: CHUNK })
  gunzip.on('error', () => {}) // read from its output, or from what the feed returns once that has ended
  const stop = new AbortController()
  const cancel = (reason) => {
    stop.abort(reason)
    gunzip.destroy(reason)
    input.destroy?.()
  }
  const abort = () => cancel(signal.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const write = (bytes) => new Promise((resolve, reject) => {
    gunzip.write(bytes, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  const fed = (async () => {
    let given = 0
    try {
      for await (const chunk of input) {
        stop.signal.throwIfAborted()
        const bytes = bytesOf(chunk)
        const taken = gunzip.bytesWritten === given
        given += bytes.length
        // eslint-disable-next-line no-await-in-loop -- a chunk at a time, so where zlib stopped is known before the next
        if (taken) await untilAborted(write(bytes), stop.signal)
        const past = given - gunzip.bytesWritten
        if (past > 0 && !isZeros(bytes.subarray(Math.max(0, bytes.length - past)))) throw new Error('bytes past its gzip stream')
      }
      gunzip.end()
      return undefined
    } catch (error) {
      gunzip.destroy(error)
      return error
    }
  })()
  let done = false
  try {
    let length = 0
    for await (const chunk of gunzip) {
      length += chunk.length
      if (length > maxBytes) throw new RangeError(`its tar is longer than ${maxBytes} bytes`)
      yield chunk
    }
    // The output ends where the gzip stream does: the input is read on to its end, held to be zeros.
    const error = await fed
    if (error !== undefined) throw error
    done = true
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!done) cancel()
  }
}

// What Bundle.fromTar gives of a .stasis.tgz's tar, as parse.js's readStasisTgz reads it: whole, by @preventive/archive's
// unpack. With onFile, by its unpackStream, each file passed on as the bundle's contents of it, then dropped: the
// stasis.lock.json is read as it streams by (stasis writes it first; the files before it are held until it has), and a
// file is passed once it is one it attests, of the bytes and execute bit it attests. fromTar then takes the tar as it
// streamed, each file's bytes a stand-in hashed to theirs, which decodes where they do: it accepts and refuses alike,
// and resolves to the contents-free Bundle of what it gives.
async function readTgz(input, { onFile, signal }) {
  const [{ unpack, unpackStream }, { MAX_TAR_BYTES }] = await Promise.all([import('@preventive/archive/tar.js'), import('./parse.js')])
  const tar = gunzipped(input, signal, MAX_TAR_BYTES)
  if (!onFile) return Bundle.fromTar(unpack(Buffer.concat(await Array.fromAsync(tar))), { integrityOf: sha512integrity })

  const entries = [] // as streamed, in order
  const digests = new WeakMap() // a stand-in -> the digest of the bytes it stands in for
  let lockfile // once it has streamed by
  let attested // its files' integrities; null once fromTar will refuse the tar, and nothing more is passed
  let held = [] // the files before it, by index
  const pass = async (at) => {
    const { name, data, mode } = entries[at]
    const digest = sha512integrity(data)
    const format = lockfile?.formats.get(name)
    let contents
    try {
      contents = format === 'resource:base64' ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') : utf8().decode(data)
    } catch {}
    const stand = contents === undefined ? Uint8Array.of(0xff) : new Uint8Array(0)
    digests.set(stand, digest)
    entries[at] = { ...entries[at], data: stand }
    if (attested?.get(name) !== digest || ((mode & EXECUTE_BITS) !== 0) !== lockfile.executable.has(name) || contents === undefined) {
      attested = null
      return
    }
    signal?.throwIfAborted()
    await untilAborted(onFile(name, contents, { signal, format }), signal)
  }
  for await (const entry of unpackStream(tar)) {
    const at = entries.push(entry) - 1
    if (!isFileEntry(entry)) continue
    if (entry.name !== LOCK_FILE) {
      if (held === null) await pass(at) // eslint-disable-line no-await-in-loop -- in stream order, the tar held back meanwhile
      else held.push(at)
      continue
    }
    try {
      lockfile = Lockfile.parse(utf8().decode(entry.data))
      // A directory capture fromTar refuses before it reads a file.
      if (!lockfile.formats.values().some((format) => format === 'directory')) {
        attested = new Map([...lockfile.modules].flatMap(([dir, { files }]) => Object.entries(files).map(([rel, integrity]) => [moduleFileKey(dir, rel), integrity])))
      }
    } catch {}
    attested ??= null
    for (const one of held) await pass(one) // eslint-disable-line no-await-in-loop -- in stream order
    held = null
  }
  const bundle = Bundle.fromTar(entries, { integrityOf: (data) => digests.get(data) ?? sha512integrity(data) })
  // Each of its files was passed, else fromTar refused it, and is left a placeholder, as of a stasis.code.br.
  const json = JSON.parse(bundle.serialize())
  for (const { files } of [...Object.values(json.sources ?? {}), ...Object.values(json.modules)]) {
    for (const rel of Object.keys(files)) Object.defineProperty(files, rel, { value: STREAMED })
  }
  return Bundle.fromJSON(json, { contents: false })
}
