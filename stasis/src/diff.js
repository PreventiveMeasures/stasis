import { ATTESTED_METADATA, REPO_FIELDS, moduleFileKey, sameGithub, sortPaths } from '@exodus/stasis-core/util'

// `@exodus/stasis/diff` — compare two parsed stasis artifacts (Bundle/Lockfile) at the module and file
// level, never reading disk. Every file is reduced to an SRI digest: a lockfile holds them, and a bundle's
// bytes are re-hashed by the injected `hash`, so one is required whenever a bundle is an operand.

const KINDS = new Set(['lockfile', 'bundle'])

// One file's recorded value as an SRI digest: a bundle's re-hashed, a `resource:base64` file decoded first.
function digestOf(kind, format, value, hash) {
  if (kind === 'lockfile') return value
  if (typeof hash !== 'function') {
    throw new Error('diff: a `hash` function is required to compare a bundle (its bytes are re-hashed into a lockfile-style digest)')
  }
  return hash(format === 'resource:base64' ? Buffer.from(value, 'base64') : value)
}

// Whether two records of one dependency agree on its `repo`: an artifact from before the field records
// none; else every field alike, `github` in any case.
const reposAgree = (a, b) => a === undefined || b === undefined ||
  Object.keys(REPO_FIELDS).every((key) => (key === 'github' ? sameGithub(a.github, b.github) : a[key] === b[key]))

// Project an artifact onto a uniform shape: scope + Map<dir, { name, version, ecosystem, repo,
// files: Map<rel, digest> }>. `input` is { artifact, kind }; `hash` re-hashes bundle bytes only.
export function normalizeArtifact(input, { hash } = {}) {
  const { artifact, kind } = input ?? {}
  if (!artifact || !KINDS.has(kind)) {
    throw new Error("diff: each input must be { artifact, kind } with kind 'lockfile' | 'bundle'")
  }
  const formats = artifact.formats ?? new Map()
  const modules = new Map()
  for (const [dir, { name, version, ecosystem, repo, integrity, patch, files }] of artifact.modules) {
    const digests = new Map(Object.entries(files).map(([rel, value]) => [rel, digestOf(kind, formats.get(moduleFileKey(dir, rel)), value, hash)]))
    // v0 bundles record no name/version; normalize undefined -> null for a single "unknown" sentinel.
    modules.set(dir, { name: name ?? null, version: version ?? null, ecosystem: ecosystem ?? null, repo, integrity, patch, files: digests })
  }
  // `executable` decides which files `stasis extract` chmods +x, so a change to it changes the tree
  // an artifact produces even when every digest matches -- it has to be part of "did these differ?".
  return { scope: artifact.config?.scope ?? 'full', modules, executable: artifact.executable ?? new Set() }
}

// Diff two `{ artifact, kind }` operands, `left` the baseline. Files are compared only within modules on BOTH
// sides (a one-sided module is reported once); a name/version/repo change only where both sides record one, an
// integrity/patch change wherever they differ. `imports: true` also diffs the resolution graphs (verbose).
export function diffArtifacts(left, right, { imports = false, hash } = {}) {
  const L = normalizeArtifact(left, { hash })
  const R = normalizeArtifact(right, { hash })

  const modulesAdded = []
  const modulesRemoved = []
  const modulesChanged = []
  const filesAdded = []
  const filesRemoved = []
  const filesDiffering = []

  const summary = (dir, m) => ({ dir, name: m.name, version: m.version, ecosystem: m.ecosystem, files: m.files.size })
  for (const dir of new Set([...L.modules.keys(), ...R.modules.keys()])) {
    const l = L.modules.get(dir)
    const r = R.modules.get(dir)
    if (l && !r) {
      modulesRemoved.push(summary(dir, l))
      continue
    }
    if (!l && r) {
      modulesAdded.push(summary(dir, r))
      continue
    }

    const changes = {}
    if (l.version !== null && r.version !== null && l.version !== r.version) {
      changes.versionChange = { from: l.version, to: r.version }
    }
    if (l.name !== null && r.name !== null && l.name !== r.name) {
      changes.nameChange = { from: l.name, to: r.name }
    }
    // A dependency's repo picks the GitHub advisories audit asks, so a change to it is one to review.
    if (!reposAgree(l.repo, r.repo)) {
      changes.repoChange = { from: l.repo, to: r.repo }
    }
    for (const field of ATTESTED_METADATA) {
      if (JSON.stringify(l[field]) !== JSON.stringify(r[field])) changes[`${field}Change`] = { from: l[field], to: r[field] }
    }
    if (Object.keys(changes).length > 0) modulesChanged.push({ dir, name: r.name ?? l.name, ...changes })

    for (const rel of new Set([...l.files.keys(), ...r.files.keys()])) {
      const lh = l.files.get(rel)
      const rh = r.files.get(rel)
      const path = moduleFileKey(dir, rel)
      if (lh !== undefined && rh === undefined) filesRemoved.push(path)
      else if (lh === undefined && rh !== undefined) filesAdded.push(path)
      else if (lh !== rh) filesDiffering.push(path)
    }
  }

  const byDir = (a, b) => sortPaths(a.dir, b.dir)
  // Execute-bit changes, of every path either side marks (not just files in shared modules): gaining or
  // losing +x changes the extracted tree, whatever bucket it sits in.
  const onlyIn = (a, b) => [...a.difference(b)].toSorted(sortPaths)
  const result = {
    scope: { left: L.scope, right: R.scope },
    modules: { added: modulesAdded.toSorted(byDir), removed: modulesRemoved.toSorted(byDir), changed: modulesChanged.toSorted(byDir) },
    files: { added: filesAdded.toSorted(sortPaths), removed: filesRemoved.toSorted(sortPaths), differing: filesDiffering.toSorted(sortPaths) },
    executable: { added: onlyIn(R.executable, L.executable), removed: onlyIn(L.executable, R.executable) },
  }
  if (imports) result.imports = diffImports(left, right)
  return result
}

// An imports map (conditions -> parent -> specifier -> target) as (parent, specifier) -> Set<target>, unioned over
// conditions: a static bundle keys every edge under "*", a runtime lockfile by precise sets, and the two must agree.
function resolutionsOf(imports) {
  const byPair = new Map()
  for (const [, byParent] of imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [specifier, target] of specifiers) {
        const key = JSON.stringify([parent, specifier])
        let entry = byPair.get(key)
        if (!entry) byPair.set(key, (entry = { parent, specifier, targets: new Set() }))
        // A `--metro` edge target may be a { platform: file } map; fold each platform's file into the set.
        if (target instanceof Map) for (const f of target.values()) entry.targets.add(f)
        else entry.targets.add(target)
      }
    }
  }
  return byPair
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const cmpPair = (a, b) => sortPaths(a.parent, b.parent) || cmpStr(a.specifier, b.specifier)
const sortedTargets = (set) => [...set].toSorted(sortPaths)
const sameTargets = (a, b) => a.size === b.size && a.isSubsetOf(b)

// Diff resolution graphs by (parent, specifier) (see resolutionsOf): added, removed, and changed -- a
// redirect a byte diff can't see. A side attesting no imports (a lockfile predating attestation) skips the
// diff, `attested` saying which, rather than reporting the other whole graph as added/removed.
export function diffImports({ artifact: left }, { artifact: right }) {
  const li = left.imports ?? null
  const ri = right.imports ?? null
  const attested = { left: li !== null, right: ri !== null }
  if (li === null || ri === null) return { attested, added: [], removed: [], changed: [] }

  const L = resolutionsOf(li)
  const R = resolutionsOf(ri)
  const added = []
  const removed = []
  const changed = []
  for (const key of new Set([...L.keys(), ...R.keys()])) {
    const l = L.get(key)
    const r = R.get(key)
    if (l && !r) removed.push({ parent: l.parent, specifier: l.specifier, from: sortedTargets(l.targets) })
    else if (!l && r) added.push({ parent: r.parent, specifier: r.specifier, to: sortedTargets(r.targets) })
    else if (!sameTargets(l.targets, r.targets)) {
      changed.push({ parent: l.parent, specifier: l.specifier, from: sortedTargets(l.targets), to: sortedTargets(r.targets) })
    }
  }
  added.sort(cmpPair)
  removed.sort(cmpPair)
  changed.sort(cmpPair)
  return { attested, added, removed, changed }
}

// True when the diff records any module-, file-, executable- or import-level change; scope alone doesn't
// count. Only the opt-in `imports` is guarded: a guard on the others would make a renamed facet read as
// "no differences" and quietly pass a review gate.
export function hasDifferences(diff) {
  const { modules, files, executable, imports } = diff
  let n =
    modules.added.length + modules.removed.length + modules.changed.length +
    files.added.length + files.removed.length + files.differing.length +
    executable.added.length + executable.removed.length
  if (imports) n += imports.added.length + imports.removed.length + imports.changed.length
  return n > 0
}

const plural = (n) => (n === 1 ? '' : 's')
const ident = ({ name, version }) => (name ? (version ? `${name}@${version}` : name) : '')

// Diff markers: `*` (changed) — `~` reads too close to `-` in a terminal.
const REMOVED = '-'
const ADDED = '+'
const CHANGED = '*'

// `owner/name`, its commit and directory where recorded: `owner/name@0123abc (packages/x)`.
const repoLabel = ({ github, commit, directory }) => `${github ?? '?'}${commit ? `@${commit.slice(0, 7)}` : ''}${directory ? ` (${directory})` : ''}`

function describeModuleChange({ name, versionChange, nameChange, repoChange, integrityChange, patchChange }) {
  const segs = []
  if (versionChange) segs.push(`${versionChange.from} -> ${versionChange.to}`)
  if (nameChange) segs.push(`name ${nameChange.from} -> ${nameChange.to}`)
  if (repoChange) segs.push(`repo ${repoLabel(repoChange.from)} -> ${repoLabel(repoChange.to)}`)
  if (integrityChange) segs.push(`integrity ${integrityChange.from ?? 'none'} -> ${integrityChange.to ?? 'none'}`)
  if (patchChange) segs.push(`patch ${patchChange.from?.integrity ?? 'none'} -> ${patchChange.to?.integrity ?? 'none'}`)
  return `${name ? `${name} ` : ''}${segs.join(', ')}`
}

const moduleLine = (mark, x) => {
  const id = ident(x)
  return `  ${mark} ${x.dir}${id ? `  ${id}` : ''} (${x.files} file${plural(x.files)})`
}

// `parent  'specifier'` — an edge is identified by importer + specifier (conditions folded away).
const edgeLabel = (e) => `${e.parent}  '${e.specifier}'`

// Render the `--stat` summary (module + file change lists with counts, plus import-edge changes
// when present); reports what changed, not the text. Returns a string ending in a newline.
export function formatDiffStat(diff, { left = '(left)', right = '(right)', leftKind, rightKind } = {}) {
  const { modules: m, files: f, executable: ex, imports: im, scope } = diff
  const label = (kind) => (kind ? `${kind}, ` : '')
  const lines = [
    'stasis diff --stat',
    `  ${REMOVED} ${left} (${label(leftKind)}scope=${scope.left})`,
    `  ${ADDED} ${right} (${label(rightKind)}scope=${scope.right})`,
  ]
  const paths = (mark, list) => {
    for (const p of list) lines.push(`  ${mark} ${p}`)
  }
  if (scope.left !== scope.right) {
    lines.push(`  note: scopes differ (${scope.left} vs ${scope.right}); files only the full-scope artifact records show as removed/added`)
  }

  lines.push('', `Modules: ${m.added.length} added, ${m.removed.length} removed, ${m.changed.length} changed`)
  for (const x of m.removed) lines.push(moduleLine(REMOVED, x))
  for (const x of m.added) lines.push(moduleLine(ADDED, x))
  for (const x of m.changed) lines.push(`  ${CHANGED} ${x.dir}  ${describeModuleChange(x)}`)

  // A wholly added/removed module's files are summarized by its module entry above.
  lines.push('', `Files (within shared modules): ${f.added.length} added, ${f.removed.length} removed, ${f.differing.length} differing`)
  paths(REMOVED, f.removed)
  paths(ADDED, f.added)
  paths(CHANGED, f.differing)

  // Only when something changed: a permanent "0 added, 0 removed" line would be noise in every diff.
  if (ex.added.length > 0 || ex.removed.length > 0) {
    lines.push('', `Executable: ${ex.added.length} added, ${ex.removed.length} removed`)
    paths(REMOVED, ex.removed)
    paths(ADDED, ex.added)
  }

  if (im) {
    lines.push('')
    if (!im.attested.left || !im.attested.right) {
      const which = !im.attested.left && !im.attested.right
        ? 'neither artifact attests'
        : `${im.attested.left ? right : left} does not attest`
      lines.push(`Imports: ${which} resolutions; skipping import diff`)
    } else {
      lines.push(`Imports: ${im.added.length} added, ${im.removed.length} removed, ${im.changed.length} changed`)
      for (const e of im.removed) lines.push(`  ${REMOVED} ${edgeLabel(e)} -> ${e.from.join(', ')}`)
      for (const e of im.added) lines.push(`  ${ADDED} ${edgeLabel(e)} -> ${e.to.join(', ')}`)
      for (const e of im.changed) lines.push(`  ${CHANGED} ${edgeLabel(e)}  ${e.from.join(', ')} -> ${e.to.join(', ')}`)
    }
  }

  lines.push('', hasDifferences(diff) ? 'Artifacts differ' : 'No differences')
  return lines.join('\n') + '\n'
}
