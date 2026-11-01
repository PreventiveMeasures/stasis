import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { compressBundleText, parseBundleBytes } from './brotli.js'
import { detectRepo, normalizeEntries, packageLookup, packageType, readJson, statStrict } from './bundle-util.js'
import { diskHost } from './host.js'
import { canonicalizePath, deferredLockfile, sha512integrity } from './state-util.js'
import { assertRealPathWithinBase, classifyFormat, fileInBucket, hasNodeModulesSegment, isAutoExcludedDir, isAutoExcludedFile, isBinaryPlist, isBrotliQuality, isExecutableMode, moduleInfo, parseResourcesOption, pathExt, sortPaths, splitNodeModulesPath, toPosix, withMetadataOf } from './util.js'

// Snapshotted before `stasis run --fs` patches node:fs: State#includeExtra matches its outputs with
// these at write (outputMatcher), which must read the real disk, not be captured as the program's
// reads. It sweeps `extra` through its host, which the disk's snapshots too.
const { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } = fs

const CONFIG_FILE = 'stasis.config.json'
const LOCK_FILE = 'stasis.lock.json'

// A `.js`/`.ts` follows its package `type` (LIMITATION: none falls back to commonjs -- use `.mjs`/`.cjs`
// or set `type` when the module system matters). Any other name is classifyFormat's call: a format,
// null for a JS-family file (`.jsx`/`.tsx`: source attested with no loader format, as the runtime
// records one), undefined when unrecognized. Its package.json is read through `host`.
function sourceFormat(absFile, content, host) {
  const ext = extname(absFile).toLowerCase()
  if (ext === '.js' || ext === '.ts') return `${packageType(absFile, host) ?? 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`
  return classifyFormat(absFile, { content })
}

// File and non-empty package counts of a bundle or lockfile.
const tally = (artifact) => {
  let files = 0
  let packages = 0
  for (const m of artifact.modules.values()) {
    const n = Object.keys(m.files).length
    if (n > 0) {
      files += n
      packages += 1
    }
  }
  return { files, packages }
}

function readAddConfig(baseDir) {
  const cfg = readJson(join(baseDir, CONFIG_FILE))
  if (cfg === null) {
    throw new Error(`add requires a ${CONFIG_FILE} (its bundleFile, resourcesBundleFile, and resources are all optional)`)
  }
  const resources = parseResourcesOption(CONFIG_FILE, cfg.resources)
  if (cfg.brotliQuality !== undefined && !isBrotliQuality(cfg.brotliQuality)) {
    throw new Error(`${CONFIG_FILE}: brotliQuality must be an integer 0..11 (got ${JSON.stringify(cfg.brotliQuality)})`)
  }
  const bundleFile = cfg.bundleFile ?? 'stasis.code.br'
  const resourcesBundleFile = cfg.resourcesBundleFile
  // Split targets must be distinct files (else they clobber on write); canonicalized so symlink and relative aliases are caught too.
  if (resourcesBundleFile &&
    canonicalizePath(resolve(baseDir, bundleFile)) === canonicalizePath(resolve(baseDir, resourcesBundleFile))) {
    throw new Error(`${CONFIG_FILE}: bundleFile and resourcesBundleFile must name distinct paths (both resolve to ${resolve(baseDir, bundleFile)})`)
  }
  return { bundleFile, resourcesBundleFile, resources, brotliQuality: cfg.brotliQuality }
}

// Assemble a Bundle bucketed per package.json. `add` records NO entries -- its files are attested, not entry points -- so nothing in an add bundle is runnable via `--bundle=load`.
// `buckets` (dir -> module) are identities to take for a dir over the one found there: those of the
// bundle the files will merge into, which may name its buckets otherwise (`solidity-bundle`, say).
// Their package.json files are read through `host`.
function assembleBundle(baseDir, files, workspaceName, workspaceVersion, repo, { reason = 'add', buckets = new Map(), host = diskHost } = {}) {
  const modules = new Map()
  const formats = new Map()
  const executable = new Set()
  // `identity`'s name, version, ecosystem, repo and vendored (moduleInfo takes those alone); a later
  // file's adds the vendored package it is in.
  const bucketFiles = (dir, identity) => {
    const bucket = modules.get(dir)
    identity = buckets.get(dir) ?? identity
    modules.set(dir, bucket === undefined ? moduleInfo({ ...identity, files: Object.create(null) }) : withMetadataOf(bucket, identity))
    return modules.get(dir).files
  }
  const metaFor = packageLookup(baseDir, { host })

  for (const [rel, { content, format, executable: isExec }] of files) {
    const meta = metaFor(rel)
    // A node_modules file whose nearest package.json is the workspace root (or none at all) is a misconfigured dep -- refuse.
    if (splitNodeModulesPath(rel) !== null && !(meta && hasNodeModulesSegment(meta.pkgDir))) {
      throw new Error(`add: no package.json with name+version found for ${rel}`)
    }
    const [dir, identity] = meta ? [meta.pkgDir, meta] : ['.', { name: workspaceName, version: workspaceVersion }]
    bucketFiles(dir, identity)[fileInBucket(dir, rel)] = content
    if (format != null) formats.set(rel, format)
    if (isExec) executable.add(rel)
  }

  return new Bundle({ config: { scope: 'full' }, entries: new Set(), modules, formats, imports: new Map(), executable, repo }).withReason(reason)
}

// Merge add-if-missing into any existing bundle (divergent bytes for an attested path throw -- see
// mergeModuleMaps), returning the write as a thunk so every target's conflicts surface before the
// first byte lands and an aborted `add` leaves the project untouched. Serializing INSIDE the thunk
// keeps peak memory at one target's bytes rather than every target's at once.
function prepareBundleFile(baseDir, targetPath, bundle, brotliQuality) {
  const abs = resolve(baseDir, targetPath)
  let mergedFrom
  if (existsSync(abs)) {
    let existing
    try {
      existing = parseBundleBytes(readFileSync(abs))
    } catch (cause) {
      throw new Error(`add: failed to read the existing bundle at ${targetPath}`, { cause })
    }
    mergedFrom = tally(existing).files
    bundle = existing.merge(bundle)
  }
  const { files, packages } = tally(bundle)
  return {
    write: () => {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, compressBundleText(bundle.serialize(), brotliQuality))
    },
    counts: { path: targetPath, total: files, packages, added: mergedFrom === undefined ? files : files - mergedFrom },
  }
}

// Companion Lockfile: the bundle's shape with each file's content swapped for its on-disk integrity, so `--lock=frozen` matches.
const bundleToLockfile = (bundle, integrities) => Lockfile.fromBundle(bundle, (file) => integrities.get(file))

// Merge into the project's stasis.lock.json (strict: divergent bytes throw), deferring the write like
// prepareBundleFile so a conflict here doesn't leave the bundles updated.
function prepareLockfile(lockPath, lockAdd) {
  let existing
  try {
    existing = Lockfile.parse(readFileSync(lockPath, 'utf8'))
  } catch (cause) {
    throw new Error(`add: failed to read the existing ${LOCK_FILE}`, { cause })
  }
  const before = tally(existing).files
  const merged = existing.merge(lockAdd)
  const total = tally(merged).files
  return { write: () => writeFileSync(lockPath, merged.serialize()), counts: { total, added: total - before } }
}

// Whether a project-relative path, with its stats (undefined when missing), is one of `outputs`
// (project-relative): by name, or as the same file under another, a symlink or hard link to it -- its
// device and inode, which a write rewrites in place. Stats as numbers can round a large inode
// (Windows file ids), so a match on those is settled exactly (bigint), never taken on its own. The
// outputs are the disk's, where a run writes them: a sweep of another host's tree has none.
function outputMatcher(baseDir, outputs) {
  const exact = new Set()
  const rounded = new Set()
  for (const rel of outputs) {
    const stats = statSync(join(baseDir, rel), { throwIfNoEntry: false, bigint: true })
    if (stats === undefined) continue
    exact.add(`${stats.dev}:${stats.ino}`)
    rounded.add(`${Number(stats.dev)}:${Number(stats.ino)}`)
  }
  return (rel, stats) => {
    if (outputs.has(rel)) return true
    if (stats === undefined || !rounded.has(`${stats.dev}:${stats.ino}`)) return false
    const precise = statSync(join(baseDir, rel), { throwIfNoEntry: false, bigint: true })
    return precise !== undefined && exact.has(`${precise.dev}:${precise.ino}`)
  }
}

// `host`'s glob of `pattern` under `cwd` (Node's fs.globSync, the disk's or a Vfs's), its matches
// relative to it, walking into none `exclude` takes (given the path relative to `baseDir`,
// '/'-joined), which leaves one out where its `**` meets it alone. A visited name is checked as
// spelled: one holding `\` is for the caller to refuse where it is kept, not here.
function globPaths(host, pattern, cwd, baseDir, exclude) {
  const projectPath = (path) => {
    const rel = relative(baseDir, path)
    return sep === '\\' ? rel.replaceAll('\\', '/') : rel
  }
  return host.glob(pattern, { cwd, exclude: exclude && ((path) => exclude(projectPath(path))) })
}

// GLOB + FILTER: expand each directory entry into the files under it (recursive glob), dropping the
// auto-excluded set from what a sweep FINDS -- dir rules on the segments BELOW the named root (`add
// src/examples` sweeps the dir it was pointed at, `add src` skips one it merely found), file rules
// by name plus the caller's `outputs` (this run's own write targets, by name or alias: outputMatcher).
// A path the caller NAMED is always kept (naming is the override; a missing one keeps stats undefined
// so validation reports it) -- unless `keepNamedOutputs` is false, then one of `outputs` never is --
// and inclusion is monotone: a nearer root's sweep can only ever see FEWER excluded segments,
// so a path any entry keeps stays kept -- `add src src/examples` includes the subtree it names in
// either order. `stats` is the walk's own stat, reused by validation. Gotcha: `**/*` skips dotfiles
// (.env, .git/...) -- name them explicitly. A project-relative path `exclude` takes is dropped, named
// or swept, with everything under it: a named path below one too, and a directory it takes is never
// walked (globPaths). Paths are read through `host`, stat'ed as real stat answers (statStrict).
function expandDirectories(baseDir, rels, outputs, { keepNamedOutputs = true, exclude, host = diskHost } = {}) {
  const files = new Map() // rel -> stats
  const excluded = new Set()
  const isOutput = outputMatcher(baseDir, outputs)
  for (const rel of rels) {
    // A walk meets a directory before what's under it, so it checks each path alone; a named one, its directories too.
    if (exclude !== undefined && rel.split('/').some((_, i, segments) => exclude(segments.slice(0, i + 1).join('/')))) continue
    const dirAbs = join(baseDir, rel)
    const stats = statStrict(host, dirAbs, rel) ?? undefined
    if (stats === undefined || !stats.isDirectory()) {
      if (keepNamedOutputs || !isOutput(rel, stats)) files.set(rel, stats)
      continue
    }
    const found = []
    for (const match of globPaths(host, '**/*', dirAbs, baseDir, exclude)) {
      const fileAbs = join(dirAbs, match)
      const fileRel = relative(baseDir, fileAbs)
      // A dangling symlink stats as undefined -- skipped, not a hard ENOENT out of the walk.
      const fileStats = statStrict(host, fileAbs, fileRel) ?? undefined
      if (fileStats?.isFile()) found.push([toPosix(fileRel), match, fileStats])
    }
    // Sorted so the sweep is deterministic regardless of readdir order: artifact bytes are
    // canonicalized by serialize() either way, but multi-file diagnostics keep a stable order.
    for (const [file, match, fileStats] of found.toSorted(([a], [b]) => sortPaths(a, b))) {
      // Node's glob holds `exclude` to its `**` alone: a file below the directory swept still
      // matches the `*` after it (a directory it takes is never walked).
      if (exclude?.(file)) continue
      if (toPosix(match).split('/').slice(0, -1).some(isAutoExcludedDir)
        || isOutput(file, fileStats) || isAutoExcludedFile(file)) excluded.add(file)
      else files.set(file, fileStats)
    }
  }
  // A path any entry kept can't count as skipped -- another root's sweep may have re-flagged it.
  for (const file of files.keys()) excluded.delete(file)
  return { files, excluded }
}

const listPaths = (rels) => [...rels].toSorted(sortPaths).join(', ')

// One error for every file validation rejected, so a directory sweep names all of them at once
// instead of one per re-run. A lone offender keeps its exact standalone message. `label` prefixes it.
export function validationError({ missing, undeclared, nonUtf8 }, label) {
  const phrase = (items, one, many) => (items.length === 1 ? [one(items[0])] : items.length > 1 ? [many(items)] : [])
  const withFormat = (format) => (format == null ? '' : ` (format '${format}')`)
  const named = ({ rel, format }) => `${rel}${withFormat(format)}`
  const parts = [
    ...phrase(missing,
      (rel) => `file not found: ${rel}`,
      (rels) => `${rels.length} files not found: ${listPaths(rels)}`),
    ...phrase(undeclared,
      (rel) => `${rel} is neither a recognized source file nor a declared resource; add its extension to "resources" in ${CONFIG_FILE}`,
      (rels) => `${rels.length} files are neither recognized source files nor declared resources; add their extensions to "resources" in ${CONFIG_FILE}: ${listPaths(rels)}`),
    ...phrase(nonUtf8,
      ({ rel, format }) => `${rel} is not valid UTF-8${withFormat(format)}`,
      (bad) => `${bad.length} files are not valid UTF-8: ${bad.map(named).join(', ')}`),
  ]
  return new Error(`${label}: ${parts.join('; ')}`)
}

// stasis.config.json's `extra` patterns, expanded as a shell expands `stasis add`'s arguments: each
// by Node's glob (whose `*` skips dotfiles, as the shell's does), a pattern matching nothing standing
// for itself as it does without bash's nullglob (so a missing path is reported missing), then each
// path as `add` takes it (expandDirectories): a file named or matched is kept, a directory swept.
// One of `outputs`, the files this very run writes, is never kept, named, matched (`dist/*`) or
// under another name (outputMatcher). A `!` entry (`!ios/Pods`, `!**/xcuserdata`) is no path: it
// takes out every path its pattern matches, in any order of the entries, along with everything under
// one that is a directory, which is then never walked, whether by a pattern's expansion or a sweep:
// a pattern whose every match is excluded matches nothing. One matching nothing is no error.
// `baseDir` is read through `host`, globbed and matched as Node globs and matches the disk
// (fs.globSync, path.matchesGlob), whichever host's it is.
export function expandExtra(baseDir, patterns, outputs, host = diskHost) {
  // Normalized as the paths they're matched against are: no `./`, no trailing `/`.
  const exclusions = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => posix.normalize(pattern.slice(1)).replace(/\/+$/u, ''))
  // Each path once: a walk asks of it, a sweep again, and a named path of every directory above it,
  // where the disk's path.matchesGlob parses each pattern anew.
  const excluded = new Map()
  const exclude = exclusions.length === 0 ? undefined : (rel) => {
    if (!excluded.has(rel)) excluded.set(rel, exclusions.some((pattern) => host.matchesGlob(rel, pattern)))
    return excluded.get(rel)
  }
  const entries = patterns.filter((pattern) => !pattern.startsWith('!')).flatMap((pattern) => {
    const matches = globPaths(host, pattern, baseDir, baseDir, exclude)
    return matches.length === 0 ? [pattern] : matches.toSorted(sortPaths)
  })
  return expandDirectories(baseDir, normalizeEntries(entries, baseDir), outputs, { keepNamedOutputs: false, exclude, host })
}

// VALIDATE step: classify the WHOLE set -- each file recognized source or a declared resource --
// before a single target is touched, collecting every offender into one error. `files` is the glob
// step's rel -> stats map (stats undefined = not on disk). Containment is the one rule NOT collected:
// a symlink escaping the root is a security invariant, so it fails closed on the spot. Bytes are
// hashed only when there's a lockfile to receive the integrities (`withIntegrity`). `label` prefixes the error.
// Files are read through `host`.
function validateFiles({ baseDir, realBase, files, resources, withIntegrity, label = 'add', host = diskHost }) {
  const codeFiles = new Map()
  const resourceFiles = new Map()
  const integrities = new Map()
  const missing = []
  const undeclared = []
  const nonUtf8 = []
  for (const [rel, stats] of files) {
    if (stats === undefined) {
      missing.push(rel)
      continue
    }
    const executable = isExecutableMode(stats)
    assertRealPathWithinBase(realBase, baseDir, rel, host)
    const abs = join(baseDir, rel)
    const buf = host.readFile(abs)
    if (withIntegrity) integrities.set(rel, sha512integrity(buf))
    const format = sourceFormat(abs, buf, host)
    // A binary plist can't be stored as the UTF-8 string its 'xml' format implies, so it is NOT source: it falls through to the resource branch (opaque base64).
    if (format !== undefined && !isBinaryPlist(rel, buf)) {
      // Source is stored as a UTF-8 string, so non-UTF-8 bytes would lossily diverge from the file on disk.
      if (isUtf8(buf)) codeFiles.set(rel, { content: buf.toString('utf8'), format, executable })
      else nonUtf8.push({ rel, format })
    } else if (resources.has(pathExt(rel) || basename(rel).toLowerCase())) {
      const utf8 = isUtf8(buf)
      resourceFiles.set(rel, { content: utf8 ? buf.toString('utf8') : buf.toString('base64'), format: utf8 ? 'resource' : 'resource:base64', executable })
    } else {
      undeclared.push(rel)
    }
  }
  if (missing.length + undeclared.length + nonUtf8.length > 0) throw validationError({ missing, undeclared, nonUtf8 }, label)
  return { codeFiles, resourceFiles, integrities }
}

// The files stasis.config.json's `extra` names under `baseDir` (expandExtra), packed as `add` packs
// them, for `stasis bundle` to merge into `bundle`, one built there without a State (always full
// scope): those it doesn't carry already (its own record of a file stands), in its buckets where it
// has them. `outputs` are the project-relative paths the build writes, never swept in. The files
// are read through `host`, the disk by default.
// -> { bundle, lockfile } of the `extra` consumer (null when there is nothing to add), the lockfile
// built when first read, and `carried`: the files named that `bundle` carries already, the `extra`
// consumer's too
export function extraArtifacts({ baseDir, patterns, resources, bundle, outputs = new Set(), host = diskHost }) {
  const named = expandExtra(baseDir, patterns, outputs, host).files
  // Bundle#sources builds its Map afresh on each read: once.
  const bundled = bundle.sources
  const carried = [...named.keys()].filter((rel) => bundled.has(rel))
  const files = new Map([...named].filter(([rel]) => !bundled.has(rel)))
  if (files.size === 0) return { bundle: null, lockfile: null, carried }
  const { codeFiles, resourceFiles } = validateFiles({ baseDir, realBase: host.realpath(baseDir), files, resources, label: 'extra', host })
  const rootPkg = readJson(join(baseDir, 'package.json'), host) ?? {}
  const extra = assembleBundle(baseDir, new Map([...codeFiles, ...resourceFiles]), rootPkg.name ?? 'workspace', rootPkg.version ?? '0.0.0', undefined, { reason: 'extra', buckets: bundle.modules, host })
  // Hashed from the bundle, which holds the bytes read, once a lockfile is wanted.
  const lockfile = deferredLockfile(extra)
  return { bundle: extra, get lockfile() { return lockfile() }, carried }
}

// GLOB the listed paths, FILTERING the auto-excluded set out of what a sweep finds (see
// expandDirectories) -> VALIDATE the whole surviving set -> only then ADD it to the target
// bundle(s), add-if-missing. A stasis.lock.json is updated only when one already exists.
export function addCommand({ cwd = process.cwd(), entries, logLabel = 'stasis-core' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('add: at least one file is required')
  }
  const baseDir = resolve(cwd)
  const realBase = realpathSync(baseDir)
  const { bundleFile, resourcesBundleFile, resources, brotliQuality } = readAddConfig(baseDir)

  const rootPkg = readJson(join(baseDir, 'package.json')) ?? {}
  const workspaceName = rootPkg.name ?? 'workspace'
  const workspaceVersion = rootPkg.version ?? '0.0.0'

  // Lockfile updated only if one already exists (never created); hash packed bytes to match a frozen run.
  const lockPath = join(baseDir, LOCK_FILE)
  const hasLock = existsSync(lockPath)

  // The CONFIGURED bundle targets, project-relative: a sweep must never attest an artifact this very
  // run is writing, and a target can be named anything (`dist/code.br`), which isAutoExcludedFile's
  // by-name rule can't recognize (it does cover the lockfile). One configured outside the project
  // yields a '..' path, which no swept path can equal.
  const outputs = new Set([bundleFile, resourcesBundleFile]
    .filter((file) => file !== undefined)
    .map((file) => toPosix(relative(baseDir, resolve(baseDir, file)))))

  // `excluded` is counted in the summary below rather than dropped silently.
  const { files, excluded } = expandDirectories(baseDir, normalizeEntries(entries, cwd), outputs)
  if (files.size === 0) {
    throw new Error(`add: no files to add (directory entries matched ${excluded.size === 0
      ? 'nothing' : `only auto-excluded files: ${listPaths(excluded)}`})`)
  }

  const { codeFiles, resourceFiles, integrities } = validateFiles({ baseDir, realBase, files, resources, withIntegrity: hasLock })

  // ADD step: every target's merge is computed first, then the writes run -- see prepareBundleFile.
  const summary = []
  const writes = []
  const repo = detectRepo(baseDir)
  const planTarget = (target, entriesForTarget, kind) => {
    if (entriesForTarget.size === 0) return
    const { write, counts } = prepareBundleFile(baseDir, target, assembleBundle(baseDir, entriesForTarget, workspaceName, workspaceVersion, repo), brotliQuality)
    writes.push(write)
    summary.push(`+${counts.added} ${kind} (${counts.total} total) -> ${counts.path}`)
  }
  if (resourcesBundleFile) {
    planTarget(bundleFile, codeFiles, 'source')
    planTarget(resourcesBundleFile, resourceFiles, 'resource')
  } else {
    const kind = codeFiles.size > 0 && resourceFiles.size > 0 ? 'file' : resourceFiles.size > 0 ? 'resource' : 'source'
    planTarget(bundleFile, new Map([...codeFiles, ...resourceFiles]), kind)
  }

  // One lockfile attests both split targets, so merge in every packed file's integrity (code + resources together).
  if (hasLock) {
    const allFiles = new Map([...codeFiles, ...resourceFiles])
    const lockAdd = bundleToLockfile(assembleBundle(baseDir, allFiles, workspaceName, workspaceVersion), integrities)
    const { write, counts } = prepareLockfile(lockPath, lockAdd)
    writes.push(write)
    summary.push(`+${counts.added} (${counts.total} total) -> ${LOCK_FILE}`)
  }
  if (excluded.size > 0) summary.push(`skipped ${excluded.size} auto-excluded`)

  for (const write of writes) write()
  console.warn(`[${logLabel}] add: ${summary.join('; ')}`)
}
