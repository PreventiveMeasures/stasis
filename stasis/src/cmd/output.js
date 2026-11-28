import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { BUNDLE_FORMATS, CONFIG_FILE, defaultBundleName, formatOf, isGzip, isTgzName } from '@exodus/stasis-core/util'

export function writeFile(abs, data) {
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, data)
}

// `target` from `cwd`, or `-` for stdout: a .stasis.tgz's name gzip's bytes alone, and gzip's that name alone. -> where
// it went, for the summary
export function writeOutput(cwd, target, data) {
  if (target !== '-' && isTgzName(target) !== isGzip(data)) throw new Error(isTgzName(target) ? `${target} names a .stasis.tgz, which this writes none of` : `${target}: a .stasis.tgz is named stasis.tgz or <name>.stasis.tgz`)
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
export function checkLockfileOnly(prefix, { lockfileOnly, lockfile, output, add = false, brotliQuality, format, named = false }) {
  const refusal = lockfileOnly && [
    [named && lockfile === '', "--lockfile can't be empty: give a path, or leave it out for the default name"],
    [!lockfile && !named, '--lockfile-only requires --lockfile=path'],
    [output !== undefined, "--lockfile-only can't be combined with --output (no bundle is written)"],
    [add, "--lockfile-only can't be combined with --add (no bundle is merged into)"],
    [brotliQuality !== undefined, "--lockfile-only can't be combined with --brotli-quality (no bundle is compressed)"],
    [format !== undefined, "--lockfile-only can't be combined with --format (no bundle is written)"],
  ].find(([refused]) => refused)
  if (refusal) throw new Error(`${prefix}${refusal[1]}`)
}

// The format a bundle is written in: `format` (--format, br or tgz), else `configured` (stasis.config.json's format), else
// its `output`'s name's (a .stasis.tgz's tgz), else that of the bundle `exists(name)` finds at the root, where given
// (defaultBundleName's), else br. Refused, its message `prefix`ed, where any two disagree, or a tgz is to be brotli'd.
export function bundleFormat(prefix, { format, configured, output, brotliQuality, exists }) {
  for (const [value, what] of [[format, '--format'], [configured, `${CONFIG_FILE}'s format`]]) {
    if (value !== undefined && !BUNDLE_FORMATS.has(value)) throw new Error(`${prefix}${what} must be br or tgz (got '${value}')`)
  }
  if (format !== undefined && configured !== undefined && format !== configured) throw new Error(`${prefix}--format=${format} disagrees with ${CONFIG_FILE}'s format, ${configured}`)
  const asked = format ?? configured
  const what = format !== undefined ? `--format=${format}` : `${CONFIG_FILE}'s format ${configured}`
  const named = output === undefined || output === '-' ? undefined : formatOf(output)
  if (asked === 'tgz' && named === 'br') throw new Error(`${prefix}${what} writes a .stasis.tgz: name --output stasis.tgz or <name>.stasis.tgz (got '${output}')`)
  if (asked === 'br' && named === 'tgz') throw new Error(`${prefix}${what} writes a stasis.code.br, not --output=${output}, a .stasis.tgz's name`)
  const found = output === undefined && asked === undefined && exists !== undefined ? formatOf(defaultBundleName(undefined, exists)) : undefined
  const resolved = asked ?? named ?? found ?? 'br'
  if (resolved === 'tgz' && brotliQuality !== undefined) throw new Error(`${prefix}--brotli-quality compresses a stasis.code.br, not a .stasis.tgz`)
  return resolved
}

// A .stasis.tgz of `bundle`, parse.js's (and @preventive/archive's) imported for a tgz alone.
export const stasisTgzOf = async (bundle) => (await import('../parse.js')).writeStasisTgz(bundle)
