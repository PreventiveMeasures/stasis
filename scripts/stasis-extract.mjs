#!/usr/bin/env node

// `stasis extract --lock=none` with only Node builtins: v1 bundles, no lockfile support (see doc/extract.md).

import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { brotliDecompressSync } from 'node:zlib'

const exists = (path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined
const isDir = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true

function readBundle(bundleAbs) {
  const raw = readFileSync(bundleAbs)
  try {
    const { buffer, engine } = brotliDecompressSync(raw, { info: true })
    if (engine.bytesWritten !== raw.length) throw new Error('trailing bytes after the brotli stream')
    const { version, sources, modules, formats = {}, executable = [] } = JSON.parse(buffer.toString('utf8'))
    if (version !== 1) throw new Error(`unsupported bundle version ${version}`)
    if (!Array.isArray(executable)) throw new Error('executable is not an array')
    const executables = new Set(executable)
    const files = []
    for (const [dir, { files: bucket }] of [...Object.entries(sources ?? {}), ...Object.entries(modules ?? {})]) {
      for (const [rel, content] of Object.entries(bucket)) {
        // rel '' is the bucket dir's own listing: keyed by the dir, written at `dir/` (refused unless skipped).
        const path = dir === '.' ? rel : `${dir}/${rel}`
        const key = rel === '' ? dir : path
        files.push([path, content, Object.hasOwn(formats, key) ? formats[key] : undefined, executables.has(key)])
      }
    }
    return files
  } catch (cause) {
    throw new Error(`extract: not a valid stasis bundle: ${bundleAbs}`, { cause })
  }
}

function extract(bundleFile, output = '.') {
  const bundleAbs = resolve(bundleFile)
  const files = readBundle(bundleAbs)
  const outDir = resolve(output)
  if (exists(outDir) && !isDir(outDir)) throw new Error(`extract: output dir ${outDir} is not a directory`)
  const name = /^(.*)\.stasis\.code\.br$/su.exec(basename(bundleAbs))?.[1]
  const locks = name === undefined ? ['stasis.lock.json'] : ['stasis.lock.json', `${name}.stasis.lock.json`]
  for (const lock of locks) {
    if (exists(join(outDir, lock))) throw new Error(`extract: unexpected ${join(outDir, lock)}: no lockfile support here, use stasis extract`)
  }

  const writes = []
  const paths = new Set()
  for (const [path, content, format, exec] of files) {
    if (format === 'directory' || String(format).startsWith('stat:')) continue
    if (typeof content !== 'string') throw new Error(`extract: bundle file content is not a string: ${path}`)
    // Canonical relative paths only, so every write stays inside outDir.
    if (path.includes('\\') || path.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error(`extract: invalid bundle path: ${path}`)
    if (/(?:^|\/)stasis\.lock\.json$/iu.test(path) || locks.includes(path)) throw new Error(`extract: the bundle carries a lockfile: ${path}`)
    if (paths.has(path)) throw new Error(`extract: duplicate bundle path: ${path}`)
    paths.add(path)
    let bytes = content
    if (String(format).endsWith(':base64')) {
      // Buffer.from skips invalid characters: require a canonical encoding.
      bytes = Buffer.from(content, 'base64')
      if (bytes.toString('base64') !== content) throw new Error(`extract: non-canonical base64 for ${path}`)
    }
    writes.push([path, bytes, exec])
  }

  // Before any write: nothing but directories on the way, and no target but a file already holding its bytes.
  const inPlace = new Set()
  for (const [path, bytes] of writes) {
    for (let i = path.indexOf('/'); i !== -1; i = path.indexOf('/', i + 1)) {
      const dir = path.slice(0, i)
      if (paths.has(dir)) throw new Error(`extract: bundle path used as both file and directory: ${dir}`)
      if (!exists(join(outDir, dir))) break
      if (!isDir(join(outDir, dir))) throw new Error(`extract: ${dir} is in the way of ${path}: not a directory`)
    }
    const abs = join(outDir, path)
    if (!exists(abs)) continue
    if (!statSync(abs, { throwIfNoEntry: false })?.isFile() || !readFileSync(abs).equals(Buffer.from(bytes))) {
      throw new Error(`extract: ${path} is in the way: extract never overwrites`)
    }
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
  console.error('Usage: node scripts/stasis-extract.mjs [--output=path/to/dir] path/to/bundle.stasis.code.br')
  process.exit(1)
}
extract(positionals[0], values.output)
