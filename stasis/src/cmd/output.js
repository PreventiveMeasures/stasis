import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { compressBundle, compressBundleText } from '@exodus/stasis-core/brotli'

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
export const writeBundleOf = (cwd, target, bundle, brotliQuality) => writeOutput(cwd, target, compressBundle(bundle, brotliQuality))

// `N package(s)`: the non-empty buckets of `modules`, the "." workspace bucket one of them.
export function packagesLabel(modules) {
  const packages = [...modules.values()].filter((m) => Object.keys(m.files).length > 0).length
  return `${packages} package${packages === 1 ? '' : 's'}`
}

export function unpackedSummary({ unpacked, installed, dependencies, files, bytes, tarballs }) {
  const fetched = typeof tarballs === 'number' ? `, ${tarballs} tarball${tarballs === 1 ? '' : 's'} fetched` : ''
  return `[stasis] Unpacked ${unpacked} of ${installed ?? dependencies} packages: ${files} files, ${(bytes / 2 ** 20).toFixed(1)} MiB${fetched}`
}

const summary = (verb) => (count, modules, from, dest) => `[stasis] ${verb} ${count} files in ${packagesLabel(modules)} from ${from} to ${dest}`
export const bundledSummary = summary('Bundled')
export const lockedSummary = summary('Locked')
export const heldSummary = summary('Held')

// Why --lockfile-only can't be taken with these output options, or null where it can; `brotliQuality`
// counts as given, parsed or not. `named`: a lockfile left out is named by the command, so only an empty one is refused.
export function lockfileOnlyError({ lockfile, output, add = false, brotliQuality, named = false }) {
  if (named && lockfile === '') return "--lockfile can't be empty: give a path, or leave it out for the default name"
  if (!lockfile && !named) return '--lockfile-only requires --lockfile=path'
  if (output !== undefined) return "--lockfile-only can't be combined with --output (no bundle is written)"
  if (add) return "--lockfile-only can't be combined with --add (no bundle is merged into)"
  if (brotliQuality !== undefined) return "--lockfile-only can't be combined with --brotli-quality (no bundle is compressed)"
  return null
}
