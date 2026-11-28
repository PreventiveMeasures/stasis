import { isUtf8 } from 'node:buffer'
import * as fs from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { Bundle } from './bundle.js'
import { Lockfile } from './lockfile.js'
import { bundleFileBytes, parseBundleFile } from './bundle-file.js'
import { lockfileFromBundle } from './extract.js'
import { detectRepo, normalizeEntries, packageLookup, packageType, readJson, statStrict } from './bundle-util.js'
import { diskHost } from './host.js'
import { excludedText, linksOn, moduleExcluder, parsePolicy, recordedIn } from './policy.js'
import { bundledIntegrity, canonicalizePath } from './state-util.js'
import { assertFormatOf, assertRealPathWithinBase, attestsAny, BUNDLE_FORMATS, classifyFormat, CONFIG_FILE, defaultBundleName, extraPattern, fileInBucket, hasNodeModulesSegment, heldToAccounts, inResources, installedAccounts, isAutoExcludedDir, isAutoExcludedFile, isBinaryPlist, isBrotliQuality, isExecutableMode, LOCK_FILE, memoized, moduleInfo, parseResourcesOption, sortedByPath, splitNodeModulesPath, toPosix, upsert, withAttestedOf, withFilledOf, withMetadataOf } from './util.js'

// Snapshotted before `stasis run --fs` patches node:fs: outputMatcher must read the real disk, not be captured.
const { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } = fs

// LIMITATION: a `.js`/`.ts` in a package with no `type` is commonjs; use `.mjs`/`.cjs` or set it.
function sourceFormat(absFile, content, host, kept) {
  const ext = extname(absFile).toLowerCase()
  if (ext === '.js' || ext === '.ts') return `${packageType(absFile, host, kept) ?? 'commonjs'}${ext === '.ts' ? '-typescript' : ''}`
  return classifyFormat(absFile, { content })
}

const fileCount = (artifact) => artifact.modules.values().reduce((n, { files }) => n + Object.keys(files).length, 0)

function readAddConfig(baseDir) {
  const cfg = readJson(join(baseDir, CONFIG_FILE))
  if (cfg === null) throw new Error(`add requires a ${CONFIG_FILE} (its bundleFile, resourcesBundleFile, and resources are all optional)`)
  const resources = parseResourcesOption(CONFIG_FILE, cfg.resources)
  if (cfg.brotliQuality !== undefined && !isBrotliQuality(cfg.brotliQuality)) {
    throw new Error(`${CONFIG_FILE}: brotliQuality must be an integer 0..11 (got ${JSON.stringify(cfg.brotliQuality)})`)
  }
  if (cfg.format !== undefined && !BUNDLE_FORMATS.has(cfg.format)) throw new Error(`${CONFIG_FILE}: format must be br or tgz (got ${JSON.stringify(cfg.format)})`)
  assertFormatOf(cfg.bundleFile || undefined, cfg.format, `${CONFIG_FILE}: format ${cfg.format}`)
  // Named, else the format's, else the stasis.code.br or stasis.tgz there, as a run finds it.
  const bundleFile = cfg.bundleFile || defaultBundleName(cfg.format, (name) => existsSync(join(baseDir, name)))
  const resourcesBundleFile = cfg.resourcesBundleFile
  // Distinct, else they clobber on write; canonicalized so symlink and relative aliases are caught too.
  if (resourcesBundleFile &&
    canonicalizePath(resolve(baseDir, bundleFile)) === canonicalizePath(resolve(baseDir, resourcesBundleFile))) {
    throw new Error(`${CONFIG_FILE}: bundleFile and resourcesBundleFile must name distinct paths (both resolve to ${resolve(baseDir, bundleFile)})`)
  }
  return { bundleFile, resourcesBundleFile, resources, brotliQuality: cfg.brotliQuality, policy: parsePolicy(CONFIG_FILE, cfg) }
}

// With NO entries: `add` attests files, not entry points, so nothing in it runs via `--bundle=load`.
export function assembleBundle(baseDir, files, workspaceName, workspaceVersion, repo, { reason = 'add', buckets = new Map(), host = diskHost } = {}) {
  const modules = new Map()
  const formats = new Map()
  const executable = new Set()
  const metaFor = packageLookup(baseDir, { host })

  for (const [rel, { content, format, executable: isExec }] of files) {
    const meta = metaFor(rel)
    if (splitNodeModulesPath(rel) !== null && !(meta && hasNodeModulesSegment(meta.pkgDir))) {
      throw new Error(`add: no package.json with name+version found for ${rel}`)
    }
    const dir = meta?.pkgDir ?? '.'
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

// Each artifact's attested packages are held to the others' and to the install. The attest(existing, added, companion)
// returned has `added` attest as `existing`, else its split half `companion`, the others, the install.
function heldToInstall(baseDir, artifacts) {
  const known = new Map()
  for (const [path, artifact] of artifacts) {
    const attested = new Map([...artifact.modules].filter(([, info]) => attestsAny(info)))
    for (const [dir, info] of attested) known.set(dir, known.has(dir) ? withMetadataOf(known.get(dir), info, `${path}: module '${dir}' (against the other artifacts)`) : info)
    heldToAccounts(attested, installedAccounts(attested, baseDir), `${path}: `)
  }
  return (existing, added, companion) => {
    for (const [dir, account] of installedAccounts(added.modules, baseDir, { locate: true })) {
      if (!account.locked) added.modules.set(dir, withFilledOf(withAttestedOf(added.modules.get(dir), existing?.modules.get(dir) ?? companion?.modules.get(dir) ?? known.get(dir) ?? account), account, `module '${dir}' (recorded vs installed)`))
    }
    return added
  }
}

function existingOf(what, parse) {
  try {
    return parse()
  } catch (cause) {
    throw new Error(`add: failed to read the existing ${what}`, { cause })
  }
}

// By name, or dev+inode (a link to one, which a write rewrites in place), confirmed in bigint: a number rounds big inodes.
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

// Node leaves out a path `exclude` takes only where its `**` meets it, so it is asked of each '/'-joined project path.
const globPaths = (host, pattern, cwd, baseDir, exclude) =>
  host.glob(pattern, { cwd, exclude: exclude && ((path) => exclude(relative(baseDir, path).replaceAll(sep, '/'))) })

// A sweep drops what it FINDS auto-excluded: dir rules below the named root (`add src/examples` sweeps it, `add src`
// skips it), file rules by name and to `outputs`. A path `exclude` takes goes, named or swept, with all under it.
// `absentOf`: excludedFrom's, of policy.js's moduleExcluder, whose dependencies are absent: named, missing (keyed with
// why); swept, never found.
function expandDirectories(baseDir, rels, outputs, { keepNamedOutputs = true, exclude, absentOf, host = diskHost }) {
  const files = new Map() // rel -> stats, the walk's own, reused by validation
  const excluded = new Set()
  const isOutput = outputMatcher(baseDir, outputs)
  for (const rel of rels) {
    // A walk meets a directory before what's under it, so it checks each path alone; a named one, its directories too.
    if (exclude !== undefined && rel.split('/').some((_, i, segments) => exclude(segments.slice(0, i + 1).join('/')))) continue
    const dirAbs = join(baseDir, rel)
    const hit = absentOf(rel)
    if (hit !== undefined) {
      files.set(`${rel} (${excludedText(hit)})`, undefined)
      continue
    }
    const stats = statStrict(host, dirAbs, rel) ?? undefined
    // A NAMED path is kept (naming is the override; a missing one keeps undefined stats for validation to report).
    if (stats === undefined || !stats.isDirectory()) {
      if (keepNamedOutputs || !isOutput(rel, stats)) files.set(rel, stats)
      continue
    }
    // Gotcha: `**/*` skips dotfiles (.env, .git/...); they must be named explicitly. Sorted, whatever the readdir
    // order, so multi-file diagnostics keep a stable order.
    for (const match of sortedByPath(globPaths(host, '**/*', dirAbs, baseDir, exclude), (path) => path.replaceAll(sep, '/'))) {
      const fileAbs = join(dirAbs, match)
      const fileRel = relative(baseDir, fileAbs)
      // A dangling symlink stats as undefined -- skipped, not a hard ENOENT out of the walk.
      const fileStats = statStrict(host, fileAbs, fileRel) ?? undefined
      const file = fileStats?.isFile() ? toPosix(fileRel) : undefined
      // Node's glob holds `exclude` to its `**` alone: a file below the directory swept still matches the `*` after it.
      if (file === undefined || absentOf(file) !== undefined || exclude?.(file)) continue
      if (toPosix(match).split('/').slice(0, -1).some(isAutoExcludedDir)
        || isOutput(file, fileStats) || isAutoExcludedFile(file)) excluded.add(file)
      else files.set(file, fileStats)
    }
  }
  // Inclusion is monotone: a path any entry kept stays kept, so `add src src/examples` keeps the subtree in either order.
  for (const file of files.keys()) excluded.delete(file)
  return { files, excluded }
}

const excludedFrom = (baseDir, excluder) => (excluder === null ? () => undefined : memoized((rel) => excluder(join(baseDir, rel))))

const listPaths = (rels) => sortedByPath(rels).join(', ')

// One error for every file validation rejected, so a sweep names all of them at once; a lone offender keeps its own message.
function validationError({ missing, undeclared, nonUtf8 }, label) {
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

// As a shell expands `stasis add`'s arguments: Node's glob (its `*` skips dotfiles), a pattern matching nothing kept as
// itself (no nullglob: a missing path is reported), then each path as `add` takes it, but one of `outputs`.
export function expandExtra(baseDir, patterns, outputs, host = diskHost, excluder = null) {
  // A `!` entry takes out every match and all under it (never walked), in any entry order.
  const exclusions = patterns.filter((pattern) => pattern.startsWith('!')).map(extraPattern)
  // Memoized: a walk asks of each path, a sweep again, and a named path of every directory above it.
  const exclude = exclusions.length === 0 ? undefined : memoized((rel) => exclusions.some((pattern) => host.matchesGlob(rel, pattern)))
  // A glob never matches what an excluded dependency holds, as it matches no missing file.
  const absentOf = excludedFrom(baseDir, excluder)
  const entries = patterns.filter((pattern) => !pattern.startsWith('!')).flatMap((pattern) => {
    const matches = globPaths(host, pattern, baseDir, baseDir, exclude).filter((match) => absentOf(toPosix(match)) === undefined)
    return matches.length === 0 ? [pattern] : sortedByPath(matches)
  })
  return expandDirectories(baseDir, normalizeEntries(entries, baseDir), outputs, { keepNamedOutputs: false, exclude, absentOf, host })
}

// A file by its bytes: code of `format` (null: its loader decides), else a resource IFF `resources` declare it, else
// neither (undefined). A binary plist can't be stored as the UTF-8 string its 'xml' format implies: a resource (base64).
export function fileKind(path, buf, resources, format) {
  if (format !== undefined && !isBinaryPlist(path, buf)) return { format }
  return inResources(path, resources) ? { resource: true } : undefined
}

// Each of `files` (rel -> stats, undefined where missing) that `keeps` read, `kindOf` (fileKind's) classifying it: the
// WHOLE set before any target is touched, one error naming every offender; only a symlink escaping the root fails on
// the spot.
export function* classifiedFiles({ baseDir, realBase, files, label, host, kindOf, keeps = () => true }) {
  const rejected = { missing: [], undeclared: [], nonUtf8: [] }
  for (const [rel, stats] of files) {
    if (stats === undefined) {
      rejected.missing.push(rel)
      continue
    }
    assertRealPathWithinBase(realBase, baseDir, rel, host)
    if (!keeps(rel)) continue
    const abs = join(baseDir, rel)
    const buf = host.readFile(abs)
    const kind = kindOf(rel, abs, buf)
    // Source is stored as a UTF-8 string, so non-UTF-8 bytes would lossily diverge from the file on disk.
    if (kind === undefined) rejected.undeclared.push(rel)
    else if (!kind.resource && !isUtf8(buf)) rejected.nonUtf8.push({ rel, format: kind.format })
    else yield { rel, stats, buf, kind }
  }
  if (Object.values(rejected).some((rels) => rels.length > 0)) throw validationError(rejected, label)
}

export function validateFiles({ baseDir, realBase, files, resources, label = 'add', host = diskHost }) {
  const codeFiles = new Map()
  const resourceFiles = new Map()
  const types = new Map()
  const kept = (path, read) => upsert(types, path, read)
  const kindOf = (rel, abs, buf) => fileKind(rel, buf, resources, sourceFormat(abs, buf, host, kept))
  for (const { rel, stats, buf, kind: { format, resource } } of classifiedFiles({ baseDir, realBase, files, label, host, kindOf })) {
    const executable = isExecutableMode(stats)
    if (!resource) codeFiles.set(rel, { content: buf.toString('utf8'), format, executable })
    else if (isUtf8(buf)) resourceFiles.set(rel, { content: buf.toString('utf8'), format: 'resource', executable })
    else resourceFiles.set(rel, { content: buf.toString('base64'), format: 'resource:base64', executable })
  }
  return { codeFiles, resourceFiles }
}

// With `lockfileOnly`, the lockfile alone: the one there, as it is merged, else one of the bundles as the add leaves them.
export function addCommand({ cwd = process.cwd(), entries, lockfileOnly = false, logLabel = 'stasis-core' } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('add: at least one file is required')
  const baseDir = resolve(cwd)
  const realBase = realpathSync(baseDir)
  const { bundleFile, resourcesBundleFile, resources, brotliQuality, policy } = readAddConfig(baseDir)
  const links = linksOn(baseDir)
  const check = policy && ((artifact, hint) => policy.assertArtifact(artifact, { hint, links }))

  const rootPkg = readJson(join(baseDir, 'package.json')) ?? {}
  const assemble = (files, repo) => assembleBundle(baseDir, files, rootPkg.name ?? 'workspace', rootPkg.version ?? '0.0.0', repo)

  const lockPath = join(baseDir, LOCK_FILE)
  const hasLock = existsSync(lockPath)

  // A sweep must never attest what this run writes, and isAutoExcludedFile's by-name rule can't know a target named
  // `dist/code.br`. One outside the project yields a '..' path, which no swept path can equal.
  const outputs = new Set([bundleFile, resourcesBundleFile]
    .filter((file) => file !== undefined)
    .map((file) => toPosix(relative(baseDir, resolve(baseDir, file)))))

  const absentOf = excludedFrom(baseDir, moduleExcluder([policy], baseDir))
  const { files, excluded } = expandDirectories(baseDir, normalizeEntries(entries, cwd), outputs, { absentOf })
  if (files.size === 0) {
    throw new Error(`add: no files to add (directory entries matched ${excluded.size === 0
      ? 'nothing' : `only auto-excluded files: ${listPaths(excluded)}`})`)
  }

  const { codeFiles, resourceFiles } = validateFiles({ baseDir, realBase, files, resources })

  const repo = detectRepo(baseDir)
  // Each artifact is read before a file is added to any: what one attests of a package is held of the others too.
  const bundleAt = (file, abs = resolve(baseDir, file)) => (existsSync(abs) ? existingOf(`bundle at ${file}`, () => parseBundleFile(readFileSync(abs), file)) : undefined)
  const bundles = new Map([bundleFile, resourcesBundleFile].filter(Boolean).map((file) => [file, bundleAt(file)]))
  const lock = hasLock ? existingOf(LOCK_FILE, () => Lockfile.parse(readFileSync(lockPath, 'utf8'))) : undefined
  const attest = heldToInstall(baseDir, [...bundles, [LOCK_FILE, lock]].filter(([, artifact]) => artifact))

  // Every target's merge is computed first, so every conflict surfaces before a byte lands; serializing in its write
  // keeps peak memory at one target's.
  const summary = []
  const writes = []
  // Each bundle as the add leaves it.
  const after = new Map(bundles)
  const plan = (target, existing, added, kind, write) => {
    let merged = added
    let before = 0
    if (existing) {
      check?.(existing, recordedIn(target))
      before = fileCount(existing)
      merged = existing.merge(added)
    }
    const total = fileCount(merged)
    if (write !== undefined) {
      writes.push(() => write(merged))
      summary.push(`+${total - before} ${kind ? `${kind} ` : ''}(${total} total) -> ${target}`)
    }
    return merged
  }
  const planTarget = (target, entriesForTarget, kind) => {
    if (entriesForTarget.size === 0) return
    const existing = bundles.get(target)
    const companion = bundles.get(target === bundleFile ? resourcesBundleFile : bundleFile)
    const added = attest(existing, assemble(entriesForTarget, repo), companion)
    check?.(added)
    const abs = resolve(baseDir, target)
    const merged = plan(target, existing, added, kind, lockfileOnly ? undefined : (bundle) => {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, bundleFileBytes(bundle, abs, brotliQuality))
    })
    after.set(target, merged)
    // Serialized under lockfileOnly too: never write a lockfile of a bundle that couldn't be written.
    if (lockfileOnly) merged.serializedBytes()
  }
  const allFiles = new Map([...codeFiles, ...resourceFiles])
  if (resourcesBundleFile) {
    planTarget(bundleFile, codeFiles, 'source')
    planTarget(resourcesBundleFile, resourceFiles, 'resource')
  } else {
    const kind = codeFiles.size > 0 && resourceFiles.size > 0 ? 'file' : resourceFiles.size > 0 ? 'resource' : 'source'
    planTarget(bundleFile, allFiles, kind)
  }

  // One lockfile attests both split targets, so it takes every packed file's integrity (code + resources). `check`
  // sees only what it already records: the files added were checked as the bundles'.
  if (hasLock) {
    const added = Lockfile.fromBundle(assemble(allFiles), (file, content) => bundledIntegrity(content, allFiles.get(file).format))
    plan(LOCK_FILE, lock, attest(lock, added), '', (merged) => writeFileSync(lockPath, merged.serialize()))
  } else if (lockfileOnly) {
    const created = [...after.values()].filter(Boolean).map(lockfileFromBundle).reduce((a, b) => a.merge(b))
    // It attests what a bundle the add leaves alone carries too: held to the policy whole.
    check?.(created, recordedIn(LOCK_FILE))
    writes.push(() => writeFileSync(lockPath, created.serialize()))
    summary.push(`+${fileCount(created)} (${fileCount(created)} total) -> ${LOCK_FILE}`)
  }
  if (excluded.size > 0) summary.push(`skipped ${excluded.size} auto-excluded`)

  for (const write of writes) write()
  console.warn(`[${logLabel}] add: ${summary.join('; ')}`)
}
