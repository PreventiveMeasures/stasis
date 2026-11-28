#!/usr/bin/env node

// `stasis extract --lock=none` with only Node builtins: v1 bundles and .stasis.tgz, no lockfile support (see
// doc/extract.md).

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

const exists = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined
const isDir = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true
// Not an array or a string, which would read as files named by index.
const isObject = (x) => typeof x === 'object' && x !== null && !Array.isArray(x)
const isZeros = (bytes) => bytes.every((byte) => byte === 0)
// As stasis-core's isForbiddenFile; the trailing `/` is a bucket's own listing.
const FORBIDDEN = /(?:^|\/)(?:\.git(?:\/|$)|(?:(?:[^/]*\.)?stasis\.lock\.json|\.npm-extension\.[cm]?[jt]s|\.?pnpmfile\.[cm]?[jt]s|\.npmrc|\.yarnrc(?:\.yml)?|\.?bunfig\.toml|\.pnp\.(?:c?js|loader\.mjs|data\.json))\/?$)/iu
const FORBIDDEN_IN_PACKAGE = /(?:^|\/)node_modules\/(?:[^/]*\/)*(?:pnpm-workspace\.yaml|\.env\.[^/]*|[^/]*\.env)\/?$/iu
const LOCK_FILE = 'stasis.lock.json'
// As stasis decodes a lockfile and code: UTF-8 as it is, a byte order mark kept as text.
const utf8 = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)

function notABundle(bundleAbs, read) {
  try {
    return read()
  } catch (cause) {
    throw new Error(`extract: not a valid stasis bundle: ${bundleAbs}`, { cause })
  }
}

// [path, content, format, executable] of each file, its content as a stasis.code.br stores it. A tgz is told by its
// name, as stasis tells one, and gzip's leading bytes under another name are refused.
function readBundle(bundleAbs) {
  const raw = notABundle(bundleAbs, () => readFileSync(bundleAbs))
  if (/(?:^|\.)stasis\.tgz$/su.test(basename(bundleAbs))) return notABundle(bundleAbs, () => readTgz(raw))
  assert(raw[0] !== 0x1f || raw[1] !== 0x8b, `extract: ${bundleAbs} is a tgz, which is read as stasis.tgz or <name>.stasis.tgz alone`)
  return notABundle(bundleAbs, () => {
    const { buffer, engine } = brotliDecompressSync(raw, { info: true })
    assert(engine.bytesWritten === raw.length, 'trailing bytes after the brotli stream')
    const json = JSON.parse(buffer.toString('utf8'))
    assert(json.version === 1, `unsupported bundle version ${json.version}`)
    return bucketFiles(json).map(({ path, value, format, exec }) => [path, value, format, exec])
  })
}

// Each file of a bundle's, or a lockfile's, buckets ({ path, key, value, format, exec }, its value its content or
// integrity), held to the shape that decides what is written.
function bucketFiles({ config, sources, modules = {}, formats = {}, executable = [] }) {
  // A node_modules-scope bundle carries dependencies alone.
  assert(config?.scope === 'full' ? isObject(sources) : config?.scope === 'node_modules' && sources === undefined, 'scope must be full, with sources, or node_modules, without')
  assert(isObject(modules) && Object.keys(modules).every((dir) => dir.split('/').includes('node_modules')), 'modules must be node_modules buckets')
  assert(isObject(formats) && Object.values(formats).every((format) => typeof format === 'string'), 'formats must map paths to strings')
  assert(Array.isArray(executable), 'executable is not an array')
  const executables = new Set(executable)
  const files = []
  for (const [dir, { files: bucket }] of [...Object.entries(sources ?? {}), ...Object.entries(modules)]) {
    assert(isObject(bucket), `bucket ${dir} files must be an object`)
    for (const [rel, value] of Object.entries(bucket)) {
      // rel '' is the bucket dir's own listing: keyed by the dir, written at `dir/` (refused unless skipped).
      const path = dir === '.' ? rel : `${dir}/${rel}`
      const key = rel === '' ? dir : path
      files.push({ path, key, value, format: Object.hasOwn(formats, key) ? formats[key] : undefined, exec: executables.has(key) })
    }
  }
  return files
}

// A .stasis.tgz's files: its tar's, held to the stasis.lock.json at its top as stasis holds them (Bundle.fromTar):
// exactly the files it attests, each of the bytes its sha512 integrity is of and the execute bit it attests, code as
// UTF-8; no directory capture, nor content for a payload-free stat record.
function readTgz(raw) {
  const files = new Map(untar(gunzip(raw)).filter(({ dir }) => !dir).map((entry) => [entry.name, entry]))
  assert(files.has(LOCK_FILE), `it holds no ${LOCK_FILE} at its top`)
  const lockfile = JSON.parse(utf8(files.get(LOCK_FILE).data))
  assert(lockfile.version === 0, `unsupported ${LOCK_FILE} version ${lockfile.version}`)
  for (const [key, format] of Object.entries(lockfile.formats ?? {})) assert(format !== 'directory', `its ${LOCK_FILE} records '${key}' as a directory capture, which a .stasis.tgz can't carry`)
  const read = new Set([LOCK_FILE])
  const out = bucketFiles(lockfile).map(({ path, key, value, format, exec }) => {
    const entry = files.get(key)
    assert(entry !== undefined, `${key}, which its ${LOCK_FILE} attests, is not in it`)
    read.add(key)
    assert(`sha512-${createHash('sha512').update(entry.data).digest('base64')}` === value, `${key} does not match its ${LOCK_FILE}`)
    assert(((entry.mode & 0o111) !== 0) === exec, `${key}'s execute bit is not the one its ${LOCK_FILE} attests`)
    assert(!format?.startsWith('stat:'), `${key} is a payload-free '${format}' record, yet carries content`)
    return [path, format?.endsWith(':base64') ? entry.data.toString('base64') : utf8(entry.data), format, exec]
  })
  for (const name of files.keys()) assert(read.has(name), `${name} is in it, but not in its ${LOCK_FILE}`)
  return out
}

// Each gzip member, as gzip(1) reads on into a second, then zeros alone; a tar of at most 1 GiB, as stasis reads one.
function gunzip(raw) {
  const { buffer, engine } = gunzipSync(raw, { info: true, maxOutputLength: 2 ** 30 })
  assert(isZeros(raw.subarray(engine.bytesWritten)), 'bytes past its gzip stream')
  return buffer
}

const BLOCK = 512
const blocks = (size) => Math.ceil(size / BLOCK) * BLOCK
const untilNul = (bytes) => bytes.subarray(0, bytes.includes(0) ? bytes.indexOf(0) : bytes.length)
// Controls, line and paragraph separators and bidi controls, as @preventive/archive refuses in a name.
const UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\\]/u
// pax records passed over: times and owners. Any other but `path` is refused.
const PAX_IGNORED = new Set(['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'])

// A header's number: octal digits, spaces around them, a NUL ending them.
function octal(block, offset, size, what) {
  const digits = /^ *([0-7]+) *$/u.exec(untilNul(block.subarray(offset, offset + size)).toString('latin1'))
  assert(digits, `its ${what} is not an octal number`)
  return Number.parseInt(digits[1], 8)
}

// The name a header stores, with ustar's prefix (under the gnu magic, there is none). Read only where no long name or
// pax path stands in for it: GNU tar cuts a long one at 100 bytes, inside a character as like as not.
function storedName(block, gnu) {
  const name = utf8(untilNul(block.subarray(0, 100)))
  const prefix = gnu ? '' : utf8(untilNul(block.subarray(345, 500)))
  return prefix === '' ? name : `${prefix}/${name}`
}

// The records of a pax header, `<length> <key>=<value>\n` each: its path, if it sets one.
function paxPath(data, at) {
  const keys = new Map()
  for (let pos = 0; pos < data.length;) {
    const space = data.indexOf(0x20, pos)
    const length = space === -1 ? '' : data.subarray(pos, space).toString('latin1')
    assert(/^[1-9][0-9]*$/u.test(length), `a pax record at byte ${at} does not begin with its length`)
    const end = pos + Number(length)
    assert(end <= data.length && data[end - 1] === 0x0a, `a pax record at byte ${at} is not as long as it says`)
    const record = utf8(data.subarray(space + 1, end - 1))
    const equals = record.indexOf('=')
    const key = record.slice(0, equals)
    assert(equals > 0 && !keys.has(key), `a pax record at byte ${at} has no key=value, or repeats one`)
    assert(key === 'path' || PAX_IGNORED.has(key), `the pax record ${JSON.stringify(key)} at byte ${at} is not one this script reads`)
    keys.set(key, record.slice(equals + 1))
    pos = end
  }
  return keys.get('path')
}

// A name as @preventive/archive cleans one: `.` segments and a directory's trailing slash dropped, the root `.`; else
// a plain relative path, or refused.
function cleanName(name, dir, at) {
  const segments = name.split('/')
  if (dir && segments.length > 1 && segments.at(-1) === '') segments.pop()
  const kept = segments.filter((segment) => segment !== '.')
  assert(name !== '' && !UNSAFE.test(name) && !/^[a-zA-Z]:/u.test(kept[0] ?? '') && kept.every((segment) => segment !== '' && segment !== '..') && (dir || kept.length > 0),
    `the entry at byte ${at}, ${JSON.stringify(name)}, is not a relative path${dir ? '' : ' of a file'}`)
  return kept.length === 0 ? '.' : kept.join('/')
}

// A tar's regular files and directories ({ name, dir, mode, data }), read as strictly as @preventive/archive reads
// one: each header's checksum, ustar's or GNU's magic, a body padded with zeros, GNU tar's long name ('L') or a pax
// header's path ('x') naming the entry after it, no name twice nor inside a file, then the end marker's two zero
// blocks and zeros alone. Anything else -- a link, a device, a global or sparse header -- is refused.
function untar(tar) {
  const entries = []
  const kinds = new Map() // name -> 'file', 'directory', or 'implied' by a name below it
  let longname
  let pax
  for (let at = 0; ;) {
    const block = tar.subarray(at, at + BLOCK)
    assert(block.length === BLOCK, at === 0 ? 'its tar is empty' : `its tar ends at byte ${at}, short of its end marker`)
    if (isZeros(block)) {
      assert(longname === undefined && pax === undefined, `an extended header ahead of byte ${at} is followed by no entry`)
      assert(tar.length >= at + 2 * BLOCK && isZeros(tar.subarray(at + BLOCK, at + 2 * BLOCK)), `a lone zero block at byte ${at}`)
      assert(isZeros(tar.subarray(at + 2 * BLOCK)), `data past the end of its tar at byte ${at + 2 * BLOCK}`)
      return entries
    }
    let sum = 8 * 0x20 // the checksum field counts as spaces
    for (const [i, byte] of block.entries()) if (i < 148 || i >= 156) sum += byte
    assert(octal(block, 148, 8, `checksum at byte ${at}`) === sum, `the header at byte ${at} does not match its checksum`)
    const magic = block.subarray(257, 265).toString('latin1')
    const gnu = magic === 'ustar  \0'
    assert(gnu || magic === 'ustar\u000000', `the header at byte ${at} is not in the ustar, pax or gnu format`)
    assert(!gnu || isZeros(block.subarray(386, 495)), `the header at byte ${at} carries an old GNU sparse map`)
    const size = octal(block, 124, 12, `size at byte ${at}`)
    const body = tar.subarray(at + BLOCK, at + BLOCK + blocks(size))
    assert(body.length === blocks(size), `its tar ends inside the entry at byte ${at}`)
    assert(isZeros(body.subarray(size)), `the padding after the entry at byte ${at} is not zero`)
    const data = body.subarray(0, size)
    const type = String.fromCharCode(block[156])
    if (type === 'L') {
      assert(longname === undefined, `two long names ahead of one entry at byte ${at}`)
      longname = utf8(untilNul(data))
    } else if (type === 'x') {
      assert(pax === undefined, `two pax headers ahead of one entry at byte ${at}`)
      pax = { path: paxPath(data, at) }
    } else {
      const dir = type === '5'
      assert(dir || type === '0' || type === '\0' || type === '7', `the entry at byte ${at} is of type ${JSON.stringify(type)}, which no ${LOCK_FILE} attests: a file or a directory alone`)
      assert(longname === undefined || pax?.path === undefined, `both a long name and a pax path name the entry at byte ${at}`)
      assert(block[157] === 0 && (!dir || size === 0), `the ${dir ? 'directory' : 'file'} at byte ${at} has a link target or a size`)
      const name = cleanName(longname ?? pax?.path ?? storedName(block, gnu), dir, at)
      const segments = name === '.' ? [] : name.split('/')
      for (let i = 1; i < segments.length; i++) {
        const parent = segments.slice(0, i).join('/')
        assert(kinds.get(parent) !== 'file', `${name}, at byte ${at}, is inside the file ${parent}`)
        if (!kinds.has(parent)) kinds.set(parent, 'implied')
      }
      assert(!kinds.has(name) || (dir && kinds.get(name) === 'implied'), `its tar holds ${name} twice, or as a file and a directory, at byte ${at}`)
      kinds.set(name, dir ? 'directory' : 'file')
      entries.push({ name, dir, mode: octal(block, 100, 8, `mode at byte ${at}`) & 0o7777, data })
      longname = undefined
      pax = undefined
    }
    at += BLOCK + blocks(size)
  }
}

function extract(bundleFile, output = '.') {
  const bundleAbs = resolve(bundleFile)
  const files = readBundle(bundleAbs)
  const outDir = resolve(output)
  assert(!exists(outDir) || isDir(outDir), `extract: output dir ${outDir} is not a directory`)
  const name = /^(.*)\.stasis\.(?:code\.br|tgz)$/su.exec(basename(bundleAbs))?.[1]
  const locks = name === undefined ? ['stasis.lock.json'] : ['stasis.lock.json', `${name}.stasis.lock.json`]
  for (const lock of locks) assert(!exists(join(outDir, lock)), `extract: unexpected ${join(outDir, lock)}: no lockfile support here, use stasis extract`)

  const writes = []
  const paths = new Set()
  for (const [path, content, format, exec] of files) {
    assert(!FORBIDDEN.test(path) && !FORBIDDEN_IN_PACKAGE.test(path), `extract: the bundle carries a forbidden file: ${path}`)
    if (format === 'directory' || format?.startsWith('stat:')) continue
    assert(typeof content === 'string', `extract: bundle file content is not a string: ${path}`)
    // Canonical relative paths only, so every write stays inside outDir.
    assert(!path.includes('\\') && path.split('/').every((s) => s !== '' && s !== '.' && s !== '..'), `extract: invalid bundle path: ${path}`)
    assert(!paths.has(path), `extract: duplicate bundle path: ${path}`)
    paths.add(path)
    let bytes = content
    if (format?.endsWith(':base64')) {
      // Buffer.from skips invalid characters: require a canonical encoding.
      bytes = Buffer.from(content, 'base64')
      assert(bytes.toString('base64') === content, `extract: non-canonical base64 for ${path}`)
    }
    writes.push([path, bytes, exec])
  }

  // Before any write: nothing but directories on the way, and no target but a file already holding its bytes.
  const inPlace = new Set()
  for (const [path, bytes] of writes) {
    let onDisk = true
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
      const dir = path.slice(0, i)
      assert(!paths.has(dir), `extract: bundle path used as both file and directory: ${dir}`)
      if ((onDisk &&= exists(join(outDir, dir)))) assert(isDir(join(outDir, dir)), `extract: ${dir} is in the way of ${path}: not a directory`)
    }
    const abs = join(outDir, path)
    if (!exists(abs)) continue
    assert(statSync(abs, { throwIfNoEntry: false })?.isFile() && readFileSync(abs).equals(Buffer.from(bytes)), `extract: ${path} is in the way: extract never overwrites`)
    inPlace.add(path)
  }

  let chmodFailures = 0
  for (const [path, bytes, exec] of writes) {
    const abs = join(outDir, path)
    if (!inPlace.has(path)) {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, bytes, { flag: 'wx' }) // fails if created since the check
    }
    // Only the execute bit is attested: set where readable (owner's at least) or dropped, clearing
    // setuid/setgid/sticky. Never through a symlink.
    const stats = lstatSync(abs)
    if (process.platform === 'win32' || stats.isSymbolicLink()) continue
    const rwx = stats.mode & 0o777
    const want = exec ? rwx | ((rwx & 0o444) >> 2) | 0o100 : rwx & ~0o111
    if (want === (stats.mode & 0o7777)) continue
    try {
      chmodSync(abs, want)
    } catch {
      chmodFailures++ // filesystems without modes
    }
  }
  mkdirSync(outDir, { recursive: true })
  console.warn(`[stasis-extract] Extracted ${writes.length} file(s) to ${outDir}`)
  if (chmodFailures > 0) console.warn(`[stasis-extract] Warning: could not set the mode of ${chmodFailures} file(s)`)
}

const { values, positionals } = parseArgs({ options: { output: { type: 'string', short: 'o' } }, allowPositionals: true })
if (positionals.length !== 1) {
  console.error('Usage: node scripts/stasis-extract.mjs [--output=path/to/dir] path/to/(bundle.stasis.code.br|name.stasis.tgz)')
  process.exit(1)
}
extract(positionals[0], values.output)
