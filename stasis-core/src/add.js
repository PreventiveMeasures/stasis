import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { compressBundleText, parseBundleBytes } from './brotli.js'
import { detectRepo, normalizeEntries, packageLookup, packageType, readJson, statStrict } from './bundle-util.js'
import { diskHost } from './host.js'
import { linksOn, parsePolicy, recordedIn } from './policy.js'
import { canonicalizePath, sha512integrity } from './state-util.js'
import { assertRealPathWithinBase, attestsAny, BUNDLE_FILE, classifyFormat, CONFIG_FILE, extraPattern, fileInBucket, hasNodeModulesSegment, heldToAccounts, inResources, installedAccounts, isAutoExcludedDir, isAutoExcludedFile, isBinaryPlist, isBrotliQuality, isExecutableMode, LOCK_FILE, memoized, moduleInfo, parseResourcesOption, sortedByPath, splitNodeModulesPath, toPosix, withAttestedOf, withMetadataOf } from './util.js'

// Snapshotted before `stasis run --fs` patches node:fs: State#includeExtra matches its outputs with
// these at write (outputMatcher), which must read the real disk, not be captured as the program's
// reads. It sweeps `extra` through its host, which the disk's snapshots too.
const { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } = fs

// A `.js`/`.ts` follows its package `type` (LIMITATION: none means commonjs; use `.mjs`/`.cjs` or set it).
// Any other name is classifyFormat's call: a format, null for a JS-family file (`.jsx`/`.tsx`: source with
// no loader format, as the runtime records one), undefined when unrecognized.
function sourceFormat(absFile, content, host, kept) {
  const ext = extname(absFile).toLowerCase()
  if (ext === '.js' || ext === '.ts') return `${packageType(absFile, host, kept) ?? 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`
  return classifyFormat(absFile, { content })
}

const fileCount = (artifact) => artifact.modules.values().reduce((n, { files }) => n + Object.keys(files).length, 0)

function readAddConfig(baseDir) {
  const cfg = readJson(join(baseDir, CONFIG_FILE))
  if (cfg === null) {
    throw new Error(`add requires a ${CONFIG_FILE} (its bundleFile, resourcesBundleFile, and resources are all optional)`)
  }
  const resources = parseResourcesOption(CONFIG_FILE, cfg.resources)
  if (cfg.brotliQuality !== undefined && !isBrotliQuality(cfg.brotliQuality)) {
    throw new Error(`${CONFIG_FILE}: brotliQuality must be an integer 0..11 (got ${JSON.stringify(cfg.brotliQuality)})`)
  }
  const bundleFile = cfg.bundleFile ?? BUNDLE_FILE
  const resourcesBundleFile = cfg.resourcesBundleFile
  // Split targets must be distinct files (else they clobber on write); canonicalized so symlink and
  // relative aliases are caught too.
  if (resourcesBundleFile &&
    canonicalizePath(resolve(baseDir, bundleFile)) === canonicalizePath(resolve(baseDir, resourcesBundleFile))) {
    throw new Error(`${CONFIG_FILE}: bundleFile and resourcesBundleFile must name distinct paths (both resolve to ${resolve(baseDir, bundleFile)})`)
  }
  return { bundleFile, resourcesBundleFile, resources, brotliQuality: cfg.brotliQuality, policy: parsePolicy(CONFIG_FILE, cfg) }
}

// A Bundle bucketed per package.json, with NO entries: `add` attests files, not entry points, so nothing
// in it runs via `--bundle=load`. `buckets` (dir -> module) override the identity found for a dir: the
// merge target's, which may name its buckets otherwise (`solidity-bundle`, say).
export function assembleBundle(baseDir, files, workspaceName, workspaceVersion, repo, { reason = 'add', buckets = new Map(), host = diskHost } = {}) {
  const modules = new Map()
  const formats = new Map()
  const executable = new Set()
  const metaFor = packageLookup(baseDir, { host })

  for (const [rel, { content, format, executable: isExec }] of files) {
    const meta = metaFor(rel)
    // A node_modules file whose nearest package.json is the workspace root (or none at all) is a
    // misconfigured dep -- refuse.
    if (splitNodeModulesPath(rel) !== null && !(meta && hasNodeModulesSegment(meta.pkgDir))) {
      throw new Error(`add: no package.json with name+version found for ${rel}`)
    }
    const dir = meta ? meta.pkgDir : '.'
    // `identity`'s name, version, ecosystem, repo and vendored (moduleInfo takes those alone); a later
    // file's adds the vendored package it is in.
    const identity = buckets.get(dir) ?? meta ?? { name: workspaceName, version: workspaceVersion }
    const bucket = modules.get(dir)
    const info = bucket === undefined ? moduleInfo({ ...identity, files: Object.create(null) }) : withMetadataOf(bucket, identity)
    modules.set(dir, info)
    info.files[fileInBucket(dir, rel)] = content
    if (format != null) formats.set(rel, format)
    if (isExec) executable.add(rel)
  }

  return new Bundle({ config: { scope: 'full' }, entries: new Set(), modules, formats, imports: new Map(), executable, repo }).withReason(reason)
}

// What `artifacts` (those `stasis add` adds to, by path) attest of their packages, held: each agrees with
// the others, and with how its packages are installed where the host tells. -> attest(existing, added,
// companion): `added` attesting as `existing`, else its split half `companion`, the others, the install.
function heldToInstall(baseDir, artifacts) {
  const known = new Map()
  for (const [path, artifact] of artifacts) {
    const attested = new Map([...artifact.modules].filter(([, info]) => attestsAny(info)))
    for (const [dir, info] of attested) known.set(dir, known.has(dir) ? withMetadataOf(known.get(dir), info, `${path}: module '${dir}' (against the other artifacts)`) : info)
    heldToAccounts(attested, installedAccounts(attested, baseDir), `${path}: `)
  }
  return (existing, added, companion) => {
    for (const [dir, account] of installedAccounts(added.modules, baseDir)) {
      if (!account.locked) added.modules.set(dir, withAttestedOf(added.modules.get(dir), existing?.modules.get(dir) ?? companion?.modules.get(dir) ?? known.get(dir) ?? account))
    }
    return added
  }
}

// `parse()`, of an artifact there already (`what`), a failure to read it told as that.
function existingOf(what, parse) {
  try {
    return parse()
  } catch (cause) {
    throw new Error(`add: failed to read the existing ${what}`, { cause })
  }
}

// Merge add-if-missing into any existing bundle (divergent bytes throw: mergeModuleMaps). The write is a
// thunk so every target's conflicts surface before a byte lands; serializing inside it keeps peak memory
// at one target's bytes. `check` (the Policy, or null) sees the files added, then the bundle's own.
function prepareBundleFile(baseDir, targetPath, bundle, brotliQuality, check, existing) {
  check?.(bundle)
  const abs = resolve(baseDir, targetPath)
  let before = 0
  if (existing) {
    check?.(existing, recordedIn(targetPath))
    before = fileCount(existing)
    bundle = existing.merge(bundle)
  }
  const total = fileCount(bundle)
  const write = () => {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, compressBundleText(bundle.serialize(), brotliQuality))
  }
  return { write, total, added: total - before }
}

// Merge into the project's stasis.lock.json (strict: divergent bytes throw), deferring the write like
// prepareBundleFile so a conflict here doesn't leave the bundles updated. `check` sees what it already
// records: the files added were checked as the bundles'.
function prepareLockfile(lockPath, existing, lockAdd, check) {
  check?.(existing, recordedIn(LOCK_FILE))
  const before = fileCount(existing)
  const merged = existing.merge(lockAdd)
  const total = fileCount(merged)
  return { write: () => writeFileSync(lockPath, merged.serialize()), total, added: total - before }
}

// Whether a path (stats undefined when missing) is one of `outputs`: by name, or by dev+inode (a symlink or
// hard link to one, which a write rewrites in place). Number stats can round a large inode (Windows file
// ids), so such a match is confirmed in bigint. Outputs are stat'ed on the disk, where a run writes them.
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

// `host`'s glob (fs.globSync, the disk's or a Vfs's) of `pattern` under `cwd`, never walking into a path
// `exclude` takes ('/'-joined, relative to `baseDir`); Node leaves one out only where its `**` meets it.
// A name holding `\` is checked as spelled: the caller refuses it where it is kept.
function globPaths(host, pattern, cwd, baseDir, exclude) {
  const projectPath = (path) => {
    const rel = relative(baseDir, path)
    return sep === '\\' ? rel.replaceAll('\\', '/') : rel
  }
  return host.glob(pattern, { cwd, exclude: exclude && ((path) => exclude(projectPath(path))) })
}

// GLOB + FILTER: expand each entry into its files, dropping auto-excluded ones a sweep FINDS: dir rules
// below the named root (`add src/examples` sweeps it, `add src` skips it), file rules by name and to
// `outputs` (outputMatcher). A path `exclude` takes goes, named or swept, with everything under it.
function expandDirectories(baseDir, rels, outputs, { keepNamedOutputs = true, exclude, host = diskHost } = {}) {
  const files = new Map() // rel -> stats, the walk's own, reused by validation
  const excluded = new Set()
  const isOutput = outputMatcher(baseDir, outputs)
  for (const rel of rels) {
    // A walk meets a directory before what's under it, so it checks each path alone; a named one, its directories too.
    if (exclude !== undefined && rel.split('/').some((_, i, segments) => exclude(segments.slice(0, i + 1).join('/')))) continue
    const dirAbs = join(baseDir, rel)
    const stats = statStrict(host, dirAbs, rel) ?? undefined
    // A NAMED path is kept (naming is the override; a missing one keeps undefined stats for validation
    // to report), except one of `outputs` when `keepNamedOutputs` is false.
    if (stats === undefined || !stats.isDirectory()) {
      if (keepNamedOutputs || !isOutput(rel, stats)) files.set(rel, stats)
      continue
    }
    const found = []
    // Gotcha: `**/*` skips dotfiles (.env, .git/...); they must be named explicitly.
    for (const match of globPaths(host, '**/*', dirAbs, baseDir, exclude)) {
      const fileAbs = join(dirAbs, match)
      const fileRel = relative(baseDir, fileAbs)
      // A dangling symlink stats as undefined -- skipped, not a hard ENOENT out of the walk.
      const fileStats = statStrict(host, fileAbs, fileRel) ?? undefined
      if (fileStats?.isFile()) found.push([toPosix(fileRel), match, fileStats])
    }
    // Sorted so the sweep is deterministic regardless of readdir order: artifact bytes are
    // canonicalized by serialize() either way, but multi-file diagnostics keep a stable order.
    for (const [file, match, fileStats] of sortedByPath(found, ([path]) => path)) {
      // Node's glob holds `exclude` to its `**` alone: a file below the directory swept still
      // matches the `*` after it (a directory it takes is never walked).
      if (exclude?.(file)) continue
      if (toPosix(match).split('/').slice(0, -1).some(isAutoExcludedDir)
        || isOutput(file, fileStats) || isAutoExcludedFile(file)) excluded.add(file)
      else files.set(file, fileStats)
    }
  }
  // Inclusion is monotone: a path any entry kept stays kept, never counted as skipped even where another
  // root's sweep flagged it, so `add src src/examples` keeps the subtree in either order.
  for (const file of files.keys()) excluded.delete(file)
  return { files, excluded }
}

const listPaths = (rels) => sortedByPath(rels).join(', ')

// One error for every file validation rejected, so a directory sweep names all of them at once
// instead of one per re-run. A lone offender keeps its exact standalone message.
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

// stasis.config.json's `extra`, expanded as a shell expands `stasis add`'s arguments: Node's glob (its `*`
// skips dotfiles), a pattern matching nothing kept as itself (no nullglob: a missing path is reported),
// then each path as `add` takes it, except one of `outputs` (this run's own writes) under any name.
export function expandExtra(baseDir, patterns, outputs, host = diskHost) {
  // A `!` entry (`!ios/Pods`) is no path: in any entry order it takes out every match and all under it
  // (never walked), so a pattern whose every match it excludes matches nothing. One matching nothing is no error.
  const exclusions = patterns.filter((pattern) => pattern.startsWith('!')).map(extraPattern)
  // Each path once: a walk asks of it, a sweep again, and a named path of every directory above it,
  // where the disk's path.matchesGlob parses each pattern anew.
  const exclude = exclusions.length === 0 ? undefined : memoized((rel) => exclusions.some((pattern) => host.matchesGlob(rel, pattern)))
  const entries = patterns.filter((pattern) => !pattern.startsWith('!')).flatMap((pattern) => {
    const matches = globPaths(host, pattern, baseDir, baseDir, exclude)
    return matches.length === 0 ? [pattern] : sortedByPath(matches)
  })
  return expandDirectories(baseDir, normalizeEntries(entries, baseDir), outputs, { keepNamedOutputs: false, exclude, host })
}

// VALIDATE: classify the WHOLE set (recognized source or declared resource) before any target is touched,
// collecting every offender into one error. Containment alone isn't collected: a symlink escaping the root
// fails closed on the spot. `files` maps rel -> stats (undefined = not on disk).
export function validateFiles({ baseDir, realBase, files, resources, withIntegrity, label = 'add', host = diskHost }) {
  const codeFiles = new Map()
  const resourceFiles = new Map()
  const integrities = new Map()
  const missing = []
  const undeclared = []
  const nonUtf8 = []
  // Each package.json's `type` read once, not once per file under it.
  const types = new Map()
  const kept = (path, read) => (types.has(path) ? types.get(path) : types.set(path, read()).get(path))
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
    const format = sourceFormat(abs, buf, host, kept)
    // A binary plist can't be stored as the UTF-8 string its 'xml' format implies, so it is NOT source:
    // it falls through to the resource branch (opaque base64).
    if (format !== undefined && !isBinaryPlist(rel, buf)) {
      // Source is stored as a UTF-8 string, so non-UTF-8 bytes would lossily diverge from the file on disk.
      if (isUtf8(buf)) codeFiles.set(rel, { content: buf.toString('utf8'), format, executable })
      else nonUtf8.push({ rel, format })
    } else if (inResources(rel, resources)) {
      const utf8 = isUtf8(buf)
      resourceFiles.set(rel, { content: utf8 ? buf.toString('utf8') : buf.toString('base64'), format: utf8 ? 'resource' : 'resource:base64', executable })
    } else {
      undeclared.push(rel)
    }
  }
  if (missing.length + undeclared.length + nonUtf8.length > 0) throw validationError({ missing, undeclared, nonUtf8 }, label)
  return { codeFiles, resourceFiles, integrities }
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
  const { bundleFile, resourcesBundleFile, resources, brotliQuality, policy } = readAddConfig(baseDir)
  const links = linksOn(baseDir)
  const check = policy && ((artifact, hint) => policy.assertArtifact(artifact, { hint, links }))

  const rootPkg = readJson(join(baseDir, 'package.json')) ?? {}
  const workspaceName = rootPkg.name ?? 'workspace'
  const workspaceVersion = rootPkg.version ?? '0.0.0'

  const lockPath = join(baseDir, LOCK_FILE)
  const hasLock = existsSync(lockPath)

  // The CONFIGURED bundle targets, project-relative: a sweep must never attest what this run writes, and
  // isAutoExcludedFile's by-name rule (which covers the lockfile) can't know a target named `dist/code.br`.
  // One outside the project yields a '..' path, which no swept path can equal.
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
  // Each bundle and the lockfile there, read before a file is added to any: what one attests of a
  // package is held of the others too, one no file is added to as well.
  const bundleAt = (file, abs = resolve(baseDir, file)) => (existsSync(abs) ? existingOf(`bundle at ${file}`, () => parseBundleBytes(readFileSync(abs))) : undefined)
  const bundles = new Map([bundleFile, resourcesBundleFile].filter(Boolean).map((file) => [file, bundleAt(file)]))
  const lock = hasLock ? existingOf(LOCK_FILE, () => Lockfile.parse(readFileSync(lockPath, 'utf8'))) : undefined
  const attest = heldToInstall(baseDir, [...bundles, [LOCK_FILE, lock]].filter(([, artifact]) => artifact))
  const planTarget = (target, entriesForTarget, kind) => {
    if (entriesForTarget.size === 0) return
    const existing = bundles.get(target)
    const companion = bundles.get(target === bundleFile ? resourcesBundleFile : bundleFile)
    const added = attest(existing, assembleBundle(baseDir, entriesForTarget, workspaceName, workspaceVersion, repo), companion)
    const { write, total, added: count } = prepareBundleFile(baseDir, target, added, brotliQuality, check, existing)
    writes.push(write)
    summary.push(`+${count} ${kind} (${total} total) -> ${target}`)
  }
  const allFiles = new Map([...codeFiles, ...resourceFiles])
  if (resourcesBundleFile) {
    planTarget(bundleFile, codeFiles, 'source')
    planTarget(resourcesBundleFile, resourceFiles, 'resource')
  } else {
    const kind = codeFiles.size > 0 && resourceFiles.size > 0 ? 'file' : resourceFiles.size > 0 ? 'resource' : 'source'
    planTarget(bundleFile, allFiles, kind)
  }

  // One lockfile attests both split targets, so it takes every packed file's integrity (code + resources):
  // the bundle's shape, each file's content swapped for its on-disk integrity, so `--lock=frozen` matches.
  if (hasLock) {
    const lockAdd = Lockfile.fromBundle(assembleBundle(baseDir, allFiles, workspaceName, workspaceVersion), (file) => integrities.get(file))
    const { write, total, added } = prepareLockfile(lockPath, lock, attest(lock, lockAdd), check)
    writes.push(write)
    summary.push(`+${added} (${total} total) -> ${LOCK_FILE}`)
  }
  if (excluded.size > 0) summary.push(`skipped ${excluded.size} auto-excluded`)

  for (const write of writes) write()
  console.warn(`[${logLabel}] add: ${summary.join('; ')}`)
}
