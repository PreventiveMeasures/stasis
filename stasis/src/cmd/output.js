import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { compressBundleText } from '@exodus/stasis-core/brotli'

export function writeFile(abs, data) {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, data)
}

// `target` from `cwd`, or `-` for stdout. -> where it went, for the summary
export function writeOutput(cwd, target, data) {
  if (target === '-') {
    process.stdout.write(data)
    return '<stdout>'
  }
  writeFile(resolve(cwd, target), data)
  return target
}

export const writeBundle = (cwd, target, serialized, brotliQuality) => writeOutput(cwd, target, compressBundleText(serialized, brotliQuality))

// `N package(s)`: the non-empty buckets of `modules`, the "." workspace bucket one of them.
export function packagesLabel(modules) {
  const packages = [...modules.values()].filter((m) => Object.keys(m.files).length > 0).length
  return `${packages} package${packages === 1 ? '' : 's'}`
}

// What buildVfsBundle unpacked, by its `stats`; tarballs only where deptree counts them.
export function unpackedSummary({ unpacked, installed, dependencies, files, bytes, tarballs }) {
  const fetched = typeof tarballs === 'number' ? `, ${tarballs} tarball${tarballs === 1 ? '' : 's'} fetched` : ''
  return `[stasis] Unpacked ${unpacked} of ${installed ?? dependencies} packages: ${files} files, ${(bytes / 2 ** 20).toFixed(1)} MiB${fetched}`
}

const summary = (verb) => (count, modules, from, dest) => `[stasis] ${verb} ${count} files in ${packagesLabel(modules)} from ${from} to ${dest}`
export const bundledSummary = summary('Bundled')
export const lockedSummary = summary('Locked')

// Why --lockfile-only can't be taken with these output options, or null where it can; `brotliQuality`
// counts as given, parsed or not.
export function lockfileOnlyError({ lockfile, output, add = false, brotliQuality }) {
  if (!lockfile) return '--lockfile-only requires --lockfile=path'
  if (output !== undefined) return "--lockfile-only can't be combined with --output (no bundle is written)"
  if (add) return "--lockfile-only can't be combined with --add (no bundle is merged into)"
  if (brotliQuality !== undefined) return "--lockfile-only can't be combined with --brotli-quality (no bundle is compressed)"
  return null
}
