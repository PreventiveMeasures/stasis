import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

import { brotliOptions } from '@exodus/stasis-core/brotli'

// Default bundle output: stasis.code.br, the same name `stasis run --bundle=load` discovers, so the two round-trip with no flags.
export const DEFAULT_BUNDLE_FILE = 'stasis.code.br'

// Write `data` to the absolute path `abs`, creating its directory.
export function writeFile(abs, data) {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, data)
}

// Write `data` to `target` (resolved against `cwd`), or to stdout for `-`. -> where it went, for the summary
export function writeOutput(cwd, target, data) {
  if (target === '-') {
    process.stdout.write(data)
    return '<stdout>'
  }
  writeFile(resolve(cwd, target), data)
  return target
}

// Write a bundle's `serialized` text brotli-compressed (at `brotliQuality`) as writeOutput does. -> where it went
export const writeBundle = (cwd, target, serialized, brotliQuality) => writeOutput(cwd, target, brotliCompressSync(serialized, brotliOptions(brotliQuality)))

// `N package(s)`: every non-empty bucket of a bundle's `modules` (the "." workspace bucket counts as one).
export function packagesLabel(modules) {
  const packages = [...modules.values()].filter((m) => Object.keys(m.files).length > 0).length
  return `${packages} package${packages === 1 ? '' : 's'}`
}

// The summary of a bundle of `count` files in `modules` written from `from` to `dest`.
export const bundledSummary = (count, modules, from, dest) => `[stasis] Bundled ${count} files in ${packagesLabel(modules)} from ${from} to ${dest}`
