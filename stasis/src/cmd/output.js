import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { isTgzName } from '@exodus/stasis-core/util'

export function writeFile(abs, data) {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, data)
}

// `target` from `cwd`, or `-` for stdout; never a .stasis.tgz, which is read alone. -> where it went, for the summary
export function writeOutput(cwd, target, data) {
  if (isTgzName(target)) throw new Error(`${target} is a .stasis.tgz, which stasis reads and never writes`)
  if (target === '-') {
    process.stdout.write(data)
    return '<stdout>'
  }
  writeFile(resolve(cwd, target), data)
  return target
}

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

// Refuses --lockfile-only, where `lockfileOnly`, with these output options, its message `prefix`ed; `brotliQuality`
// counts as given, parsed or not. `named`: a lockfile left out is named by the command, so only an empty one is refused.
export function checkLockfileOnly(prefix, { lockfileOnly, lockfile, output, add = false, brotliQuality, named = false }) {
  const refusal = lockfileOnly && [
    [named && lockfile === '', "--lockfile can't be empty: give a path, or leave it out for the default name"],
    [!lockfile && !named, '--lockfile-only requires --lockfile=path'],
    [output !== undefined, "--lockfile-only can't be combined with --output (no bundle is written)"],
    [add, "--lockfile-only can't be combined with --add (no bundle is merged into)"],
    [brotliQuality !== undefined, "--lockfile-only can't be combined with --brotli-quality (no bundle is compressed)"],
  ].find(([refused]) => refused)
  if (refusal) throw new Error(`${prefix}${refusal[1]}`)
}
