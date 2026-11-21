import { ATTESTED_METADATA, extSetsEqual, moduleFileKey, REPO_FIELDS, sameAttested, sameGithub, sortPaths, upsert } from '@exodus/stasis-core/util'

// Two parsed artifacts compared by module and file, never reading disk: each file as an SRI digest, a bundle's bytes
// re-hashed by the injected `hash`.

const KINDS = new Set(['lockfile', 'bundle'])

// One file's recorded value as an SRI digest: a bundle's re-hashed, a `resource:base64` file decoded first.
function digestOf(kind, format, value, hash) {
  if (kind === 'lockfile') return value
  if (typeof hash !== 'function') {
    throw new Error('diff: a `hash` function is required to compare a bundle (its bytes are re-hashed into a lockfile-style digest)')
  }
  return hash(format === 'resource:base64' ? Buffer.from(value, 'base64') : value)
}

// An artifact from before the `repo` field records none; `github` compares in any case.
const reposAgree = (a, b) => a === undefined || b === undefined ||
  Object.keys(REPO_FIELDS).every((key) => (key === 'github' ? sameGithub(a.github, b.github) : a[key] === b[key]))

// `{ artifact, kind }` as scope + Map<dir, { name, version, ecosystem, repo, integrity, patch, files: Map<rel, digest> }>.
export function normalizeArtifact(input, { hash } = {}) {
  const { artifact, kind } = input ?? {}
  if (!artifact || !KINDS.has(kind)) throw new Error("diff: each input must be { artifact, kind } with kind 'lockfile' | 'bundle'")
  const formats = artifact.formats ?? new Map()
  const modules = new Map()
  for (const [dir, { name, version, ecosystem, repo, directory, integrity, patch, files }] of artifact.modules) {
    const digests = new Map(Object.entries(files).map(([rel, value]) => [rel, digestOf(kind, formats.get(moduleFileKey(dir, rel)), value, hash)]))
    // v0 bundles record no name/version: null is the one "unknown".
    modules.set(dir, { name: name ?? null, version: version ?? null, ecosystem: ecosystem ?? null, repo, directory, integrity, patch, files: digests })
  }
  // `executable` decides what `stasis extract` chmods +x: the tree differs even where every digest matches.
  return { scope: artifact.config?.scope ?? 'full', modules, executable: artifact.executable ?? new Set() }
}

// The keys only `b` has, only `a` has, and both have.
function compareKeys(a, b) {
  const keys = new Set(a.keys())
  return { added: [...new Set(b.keys()).difference(a)], removed: [...keys.difference(b)], shared: [...keys.intersection(b)] }
}

// `left` the baseline. Files compare only within modules on BOTH sides (a one-sided module is reported once); a
// name/version/repo change only where both sides record one. `imports: true` also diffs the resolution graphs.
export function diffArtifacts(left, right, { imports = false, hash } = {}) {
  const L = normalizeArtifact(left, { hash })
  const R = normalizeArtifact(right, { hash })

  const modules = compareKeys(L.modules, R.modules)
  const changed = []
  const files = { added: [], removed: [], differing: [] }
  for (const dir of modules.shared) {
    const l = L.modules.get(dir)
    const r = R.modules.get(dir)
    const changes = {}
    for (const field of ['version', 'name']) {
      if (l[field] !== null && r[field] !== null && l[field] !== r[field]) changes[`${field}Change`] = { from: l[field], to: r[field] }
    }
    // A dependency's repo picks the GitHub advisories audit asks, so a change to it is one to review.
    if (!reposAgree(l.repo, r.repo)) changes.repoChange = { from: l.repo, to: r.repo }
    for (const field of ATTESTED_METADATA) {
      if (!sameAttested(field, l[field], r[field])) changes[`${field}Change`] = { from: l[field], to: r[field] }
    }
    if (Object.keys(changes).length > 0) changed.push({ dir, name: r.name ?? l.name, ...changes })
    const rels = compareKeys(l.files, r.files)
    for (const rel of rels.added) files.added.push(moduleFileKey(dir, rel))
    for (const rel of rels.removed) files.removed.push(moduleFileKey(dir, rel))
    for (const rel of rels.shared) {
      if (l.files.get(rel) !== r.files.get(rel)) files.differing.push(moduleFileKey(dir, rel))
    }
  }

  const sorted = (paths) => [...paths].toSorted(sortPaths)
  const summaries = (dirs, { modules: side }) => sorted(dirs).map((dir) => {
    const { name, version, ecosystem, files: { size } } = side.get(dir)
    return { dir, name, version, ecosystem, files: size }
  })
  const result = {
    scope: { left: L.scope, right: R.scope },
    modules: { added: summaries(modules.added, R), removed: summaries(modules.removed, L), changed: changed.toSorted((a, b) => sortPaths(a.dir, b.dir)) },
    files: { added: sorted(files.added), removed: sorted(files.removed), differing: sorted(files.differing) },
    // Of every path either side marks, not just files in shared modules.
    executable: { added: sorted(R.executable.difference(L.executable)), removed: sorted(L.executable.difference(R.executable)) },
  }
  if (imports) result.imports = diffImports(left, right)
  return result
}

// JSON [parent, specifier] -> Set<target>, unioned over conditions: a static bundle keys every edge under "*", a
// runtime lockfile by precise sets, and the two must agree. A `--metro` target may be a { platform: file } map.
function resolutionsOf(imports) {
  const byPair = new Map()
  for (const [, byParent] of imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [specifier, target] of specifiers) {
        const targets = upsert(byPair, JSON.stringify([parent, specifier]), () => new Set())
        for (const f of target instanceof Map ? target.values() : [target]) targets.add(f)
      }
    }
  }
  return byPair
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const cmpPair = (a, b) => sortPaths(a.parent, b.parent) || cmpStr(a.specifier, b.specifier)

// Changed catches a redirect a byte diff can't see. A side attesting no imports (a lockfile predating attestation)
// skips the diff, `attested` saying which, rather than reporting the other whole graph as added/removed.
export function diffImports({ artifact: left }, { artifact: right }) {
  const attested = { left: left.imports != null, right: right.imports != null }
  if (!attested.left || !attested.right) return { attested, added: [], removed: [], changed: [] }

  const L = resolutionsOf(left.imports)
  const R = resolutionsOf(right.imports)
  const { added, removed, shared } = compareKeys(L, R)
  const sorted = (side, key) => [...side.get(key)].toSorted(sortPaths)
  const edges = (keys, sidesOf) => keys.map((key) => {
    const [parent, specifier] = JSON.parse(key)
    return { parent, specifier, ...sidesOf(key) }
  }).toSorted(cmpPair)
  return {
    attested,
    added: edges(added, (key) => ({ to: sorted(R, key) })),
    removed: edges(removed, (key) => ({ from: sorted(L, key) })),
    changed: edges(shared.filter((key) => !extSetsEqual(L.get(key), R.get(key))), (key) => ({ from: sorted(L, key), to: sorted(R, key) })),
  }
}

// Scope alone doesn't count. Only the opt-in `imports` is guarded: a guard on the others would make a renamed facet
// read as "no differences" and quietly pass a review gate.
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

const patchLabel = (patch) => (patch ? `${patch.integrity}${patch.file ? ` (${patch.file})` : ''}` : 'none')

function describeModuleChange({ name, versionChange, nameChange, repoChange, directoryChange, integrityChange, patchChange }) {
  const segs = []
  if (versionChange) segs.push(`${versionChange.from} -> ${versionChange.to}`)
  if (nameChange) segs.push(`name ${nameChange.from} -> ${nameChange.to}`)
  if (repoChange) segs.push(`repo ${repoLabel(repoChange.from)} -> ${repoLabel(repoChange.to)}`)
  if (directoryChange) segs.push(`directory ${directoryChange.from ?? 'none'} -> ${directoryChange.to ?? 'none'}`)
  if (integrityChange) segs.push(`integrity ${integrityChange.from ?? 'none'} -> ${integrityChange.to ?? 'none'}`)
  if (patchChange) segs.push(`patch ${patchLabel(patchChange.from)} -> ${patchLabel(patchChange.to)}`)
  return `${name ? `${name} ` : ''}${segs.join(', ')}`
}

const moduleText = (x) => {
  const id = ident(x)
  return `${x.dir}${id ? `  ${id}` : ''} (${x.files} file${plural(x.files)})`
}

function edgeText(e, mark) {
  const edge = `${e.parent}  '${e.specifier}'`
  return mark === CHANGED ? `${edge}  ${e.from.join(', ')} -> ${e.to.join(', ')}` : `${edge} -> ${(e.from ?? e.to).join(', ')}`
}

// The `--stat` summary: what changed, not the text.
export function formatDiffStat(diff, { left = '(left)', right = '(right)', leftKind, rightKind } = {}) {
  const { modules: m, files: f, executable: ex, imports: im, scope } = diff
  const label = (kind) => (kind ? `${kind}, ` : '')
  const lines = [
    'stasis diff --stat',
    `  ${REMOVED} ${left} (${label(leftKind)}scope=${scope.left})`,
    `  ${ADDED} ${right} (${label(rightKind)}scope=${scope.right})`,
  ]
  if (scope.left !== scope.right) {
    lines.push(`  note: scopes differ (${scope.left} vs ${scope.right}); files only the full-scope artifact records show as removed/added`)
  }
  // A facet's counts of its `[added, removed, changed]` lists, then their items, the removed first, each its mark and
  // `text(item, mark)`.
  const facet = (title, lists, text, kinds = ['added', 'removed', 'changed']) => {
    lines.push('', `${title}: ${kinds.map((kind) => `${lists[kind].length} ${kind}`).join(', ')}`)
    for (const [mark, kind] of [[REMOVED, kinds[1]], [ADDED, kinds[0]], [CHANGED, kinds[2]]]) {
      for (const item of lists[kind] ?? []) lines.push(`  ${mark} ${text(item, mark)}`)
    }
  }

  facet('Modules', m, (x, mark) => (mark === CHANGED ? `${x.dir}  ${describeModuleChange(x)}` : moduleText(x)))
  facet('Files (within shared modules)', f, String, ['added', 'removed', 'differing'])
  // A permanent "0 added, 0 removed" line would be noise in every diff.
  if (ex.added.length > 0 || ex.removed.length > 0) facet('Executable', ex, String, ['added', 'removed'])
  if (im && (!im.attested.left || !im.attested.right)) {
    const which = !im.attested.left && !im.attested.right
      ? 'neither artifact attests'
      : `${im.attested.left ? right : left} does not attest`
    lines.push('', `Imports: ${which} resolutions; skipping import diff`)
  } else if (im) {
    facet('Imports', im, edgeText)
  }

  lines.push('', hasDifferences(diff) ? 'Artifacts differ' : 'No differences')
  return lines.join('\n') + '\n'
}
