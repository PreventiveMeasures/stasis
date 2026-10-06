import { dependencyEcosystem, moduleFileKey, sameGithub } from '@exodus/stasis-core/util'
import { advisories } from '@preventive/upstream/advisories.js'
import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { isEvidenceFile } from './audit-corrections.js'
import { parseFile } from './parse.js'
import { collectWhy, invertReason } from './why.js'

// Where advisories() asks for each ecosystem's advisories: npm's registry; OSV for crates (those
// vendored from a registry, which OSV takes for crates.io's) and Composer packages; for Soldeer
// packages and GitHub repos (Foundry's lib/ submodules), the advisories their GitHub repository
// publishes, a Soldeer package's as Soldeer names it.
const SOURCES = { npm: ['npm'], cargo: ['OSV'], composer: ['OSV'], soldeer: ['Soldeer', 'GitHub'], github: ['GitHub'] }

// Why a vendored crate that may not be crates.io's is asked nowhere: by its name, crates.io's
// advisories would be another crate's, and a private git dependency's name must not reach a public
// database at all.
const UNREGISTERED_CRATES = {
  'cargo-git': 'a crate vendored from a git repository, not crates.io',
  'cargo-unknown': 'a vendored crate with no .cargo-checksum.json, which may be a git checkout, not crates.io\'s',
}

// A dependency's version as it is audited: a GitHub repo's `.gitmodules` branch `.`, git's for the
// superproject's own branch, which the bundle does not know and advisories() takes for no branch, is
// the 0.0.0 stasis versions a repo with no version of its own by. Every advisory range covers both,
// as it does a branch name.
const versionOf = (ecosystem, version) => (ecosystem === 'github' && version === '.' ? '0.0.0' : version)

// A package's key across the audit: `name@version` for npm, as collectWhy keys its chains, and
// prefixed by the ecosystem for the others, whose names may be npm's too.
const keyOf = (ecosystem, name, version) => `${ecosystem === 'npm' ? '' : `${ecosystem}:`}${name}@${version}`

// Composer's dev versions (`dev-main`, `1.x-dev`), as Composer tells them, a `#ref` dropped: no
// advisory database lists those, and advisories() takes releases alone.
const isComposerDev = (version) => /^dev-|-dev$/iu.test(version.replace(/#.*$/su, ''))

// Why `pkg` cannot be audited, or undefined where it can.
function unaudited({ ecosystem, version }) {
  if (Object.hasOwn(UNREGISTERED_CRATES, ecosystem)) return UNREGISTERED_CRATES[ecosystem]
  if (!Object.hasOwn(SOURCES, ecosystem)) return `no advisories are looked up for ${ecosystem}`
  if (ecosystem === 'composer' && isComposerDev(version)) return 'a Composer dev version, which no advisory database lists'
  return undefined
}

// Only audit installed dependencies, `{ ecosystem, name, version }`: an npm package, a vendored
// crate, a Composer package, a Soldeer package or a GitHub repo, as the bundle tags it (a crate
// vendored from git, or from where no `.cargo-checksum.json` tells, is listed but never asked about).
//
// A package counts as present only when its REAL code is, and recorded = present:
// an artifact records exactly the files it ships or attested -- imported, entry,
// or `add`-ed (the last two have no in-edge in the resolution graph, so presence
// must NOT be derived from edges). The package is audited only if some recorded
// file is code evidence (see audit-corrections.js) -- not a corrected file (ws's
// noop browser.js stub), not a manifest (package.json, recorded for resolver /
// metadata reads; Cargo.toml). So a ws shipped only as browser.js (+ manifest) is
// skipped, while one whose real code was bundled stays. Which consumers and import
// EDGES reach that code is the reason column's concern -- collectReasons and
// why.js apply the same evidence rule per file/edge there.
//
// A package's `github` is the repository its artifact records for it (its package.json's), where
// one does; a GitHub repo is its own, and has none.
export function collectPackagesFromFile(file) {
  const out = []
  for (const [dir, { name, version, ecosystem: tagged, repo, files }] of parseFile(file).modules) {
    const ecosystem = dependencyEcosystem(dir, tagged)
    // First-party code is never sent to a public registry (leaks names, adds noise).
    if (ecosystem === undefined) continue
    if (!name || !version) continue
    if (!Object.keys(files).some((rel) => isEvidenceFile(name, version, rel, ecosystem))) continue
    const github = ecosystem === 'github' ? undefined : repo?.github
    out.push({ ecosystem, name, version: versionOf(ecosystem, version), ...(github === undefined ? {} : { github }) })
  }
  return out
}

// Versions in semver's order where both are semver's, else as numbers in text compare.
const byNumbers = new Intl.Collator('en', { numeric: true }).compare
const byVersion = (a, b) => (valid(a) && valid(b) ? compareVersions(a, b) : byNumbers(a, b))

// Each package once, with the GitHub repository its artifacts record for its name, which
// advisories() asks instead of looking one up. It takes one repository a name, so a name recorded
// with two, by two of its versions (a package that moved) or by two artifacts, has none, and is
// looked up as before.
export function collectPackages(files) {
  const byKey = new Map()
  const repos = new Map() // `ecosystem:name` -> the one repository recorded for it, or null
  for (const file of files) {
    for (const { github, ...pkg } of collectPackagesFromFile(file)) {
      const key = keyOf(pkg.ecosystem, pkg.name, pkg.version)
      if (!byKey.has(key)) byKey.set(key, pkg)
      if (github === undefined) continue
      const name = `${pkg.ecosystem}:${pkg.name}`
      const known = repos.get(name)
      // The first spelling stands.
      if (known === undefined) repos.set(name, github)
      else if (known !== null && !sameGithub(known, github)) repos.set(name, null)
    }
  }
  return [...byKey.values()]
    .map((pkg) => {
      const github = repos.get(`${pkg.ecosystem}:${pkg.name}`)
      return github ? { ...pkg, github } : pkg
    })
    .toSorted((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || byVersion(a.version, b.version))
}

// Map each audited package (keyOf it) to the bundle consumers ("reasons") that recorded its files.
// Only bundles carry a reason map ({ consumer: [file, ...] }); lockfiles omit it. Each file is
// resolved back to its owning package via the module file listing. Only evidence files attribute
// (see audit-corrections.js): a consumer that recorded nothing of a package but a corrected file or
// its manifest carries none of its real code and is NOT a reason -- e.g. webpack shipping only ws's
// noop browser.js stub, while `run` bundles the real ws.
export function collectReasons(files) {
  const byPkg = new Map()
  for (const file of files) {
    const artifact = parseFile(file)
    const fileReasons = invertReason(artifact.reason)
    if (!fileReasons) continue
    const fileToPkg = new Map()
    for (const [dir, { name, version, ecosystem: tagged, files: modFiles }] of artifact.modules) {
      const ecosystem = dependencyEcosystem(dir, tagged)
      if (ecosystem === undefined || !name || !version) continue
      for (const rel of Object.keys(modFiles)) {
        if (!isEvidenceFile(name, version, rel, ecosystem)) continue
        fileToPkg.set(moduleFileKey(dir, rel), keyOf(ecosystem, name, versionOf(ecosystem, version)))
      }
    }
    for (const [f, consumers] of fileReasons) {
      const key = fileToPkg.get(f)
      if (key === undefined) continue
      let set = byPkg.get(key)
      if (set === undefined) byPkg.set(key, (set = new Set()))
      for (const consumer of consumers) set.add(consumer)
    }
  }
  return byPkg
}

const SEVERITY_ORDER = { critical: 0, high: 1, moderate: 2, low: 3, info: 4, none: 5 }

// Consumer display order: bundler plugins (metro, webpack, esbuild, ...) first,
// then `run`, then `add`. Ties broken alphabetically.
const CONSUMER_RANK = { run: 1, add: 2 }
const consumerRank = (c) => CONSUMER_RANK[c] ?? 0
const byConsumerOrder = (a, b) => consumerRank(a) - consumerRank(b) || a.localeCompare(b)

// Build a row's `reason` cell by unioning over exactly the affected versions it
// covers. Without `--why` that's the `, `-joined set of bundle consumers; with
// `--why` it's the newline-joined `consumer: a -> b -> c` import-path lines
// (which REPLACE the consumer list). Consumers are ordered plugins -> run -> add.
// `reasonFilter`, when set, narrows the cell to a single consumer: the `--why`
// chains are already filtered upstream (see collectWhy), so only the consumer
// list needs pruning here. collectWhy follows npm's import graph alone, so an
// advisory of another ecosystem keeps its consumer list under `--why` too.
function reasonCell({ ecosystem, name, versions: affected }, reasonsByPkg, whyByPkg, reasonFilter) {
  const chains = whyByPkg !== null && ecosystem === 'npm'
  const parts = new Set()
  const source = chains ? whyByPkg : reasonsByPkg
  for (const v of affected) {
    for (const p of source.get(keyOf(ecosystem, name, v)) ?? []) parts.add(p)
  }
  // --why: group `consumer: path` lines by consumer and order the groups
  // plugins -> run -> add (this also re-unites a consumer's lines when they were
  // split across affected versions); within a group collectWhy's compressed order
  // is preserved. Otherwise: the `, `-joined consumer set in the same order.
  if (chains) {
    const byConsumer = Map.groupBy(parts, (line) => {
      const i = line.indexOf(': ')
      return i === -1 ? '' : line.slice(0, i)
    })
    return [...byConsumer.keys()].toSorted(byConsumerOrder).flatMap((c) => byConsumer.get(c)).join('\n')
  }
  const consumers = reasonFilter ? [...parts].filter((c) => c === reasonFilter) : [...parts]
  return consumers.toSorted(byConsumerOrder).join(', ')
}

// `found` is what @preventive/upstream's advisories() answers: one row per advisory range, whose
// `versions` are the audited versions it covers (never empty -- a range covering none is dropped
// there, so the table and exit code reflect only real hits).
export function flattenAdvisories(found, reasonsByPkg = new Map(), whyByPkg = null, reasonFilter = null) {
  const rows = []
  for (const adv of found) {
    const reason = reasonCell(adv, reasonsByPkg, whyByPkg, reasonFilter)
    // --reason keeps only advisories tied to that consumer: once the cell is
    // narrowed to it, an empty cell means this package isn't related to it.
    if (reasonFilter && reason === '') continue
    rows.push({
      ecosystem: adv.ecosystem,
      package: adv.name,
      installed: adv.versions.join(', '),
      vulnerable: adv.range ?? '',
      severity: adv.severity ?? '',
      title: adv.title ?? '',
      id: adv.id,
      reason,
    })
  }
  rows.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity] ?? 99
    const sb = SEVERITY_ORDER[b.severity] ?? 99
    if (sa !== sb) return sa - sb
    if (a.package !== b.package) return a.package < b.package ? -1 : 1
    if (a.ecosystem !== b.ecosystem) return a.ecosystem < b.ecosystem ? -1 : 1
    return a.title < b.title ? -1 : 1
  })
  return rows
}

// Strip line breaks (LF/CR/CRLF, U+2028/U+2029) from advisory titles so they can't break the box layout.
const cell = (v) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/gu, ' ')

// Split a value into the physical lines a cell occupies. Non-multiline columns
// collapse every line break to a space via `cell` (one line). A column named in
// `multiline` (the `--why` reason column) keeps intentional `\n` breaks -- one
// physical line per entry -- while still flattening stray CR/separators in each.
const cellLines = (v, multiline) =>
  multiline ? String(v ?? '').split('\n').map((s) => cell(s)) : [cell(v)]

export function formatTable(rows, columns, { multiline = [] } = {}) {
  if (rows.length === 0) return ''
  const ml = new Set(multiline)
  const linesOf = (obj) => columns.map((c) => cellLines(obj[c], ml.has(c)))
  const header = columns.map((c) => [c])
  const body = rows.map((r) => linesOf(r))
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...body.map((cells) => Math.max(0, ...cells[i].map((l) => l.length))))
  )
  const pad = (s, w) => s.padEnd(w)
  const line = (l, m, r, fill) => l + widths.map((w) => fill.repeat(w + 2)).join(m) + r
  // A row spans as many physical lines as its tallest cell; shorter cells pad
  // out with blanks so the borders stay aligned.
  const render = (cells) => {
    const height = Math.max(...cells.map((c) => c.length))
    const out = []
    for (let i = 0; i < height; i++) {
      out.push('│ ' + cells.map((c, j) => pad(c[i] ?? '', widths[j])).join(' │ ') + ' │')
    }
    return out.join('\n')
  }
  return [
    line('┌', '┬', '┐', '─'),
    render(header),
    line('├', '┼', '┤', '─'),
    ...body.map(render),
    line('└', '┴', '┘', '─'),
  ].join('\n')
}

// `repoAdvisories` and `github` (a @preventive/upstream/github.js client) go to advisories() as they
// are; a Soldeer package or a GitHub repo needs the client, their repository being their only source.
// A package that cannot be audited is `skipped`, with why (`because`), and asked for nothing.
export async function audit(files, { why = false, whyDeep = false, whyFull = false, reason = null, repoAdvisories = false, github } = {}) {
  // --why-deep and --why-full imply --why. Deep keeps every chain instead of the
  // default pruning of chains whose full suffix is already a chain (see
  // collectWhy/dropSuffixed); full spells chains out with no `...` collapse.
  why = why || whyDeep || whyFull
  const packages = collectPackages(files)
  const skipped = packages.flatMap((pkg) => {
    const because = unaudited(pkg)
    return because === undefined ? [] : [{ ...pkg, because }]
  })
  const asked = packages.filter((pkg) => unaudited(pkg) === undefined)
  if (asked.length === 0) {
    return { packages, skipped, advisories: [], rows: [], why }
  }
  let result
  try {
    result = await advisories(asked.map(({ version, ...pkg }) => ({ ...pkg, versions: [version] })), { repoAdvisories, github })
  } catch (cause) {
    // Refused input or a malformed answer is an assertion that says so itself; a transport or
    // HTTP failure gets the context of which request it was.
    if (cause?.code === 'ERR_ASSERTION') throw cause
    const sources = new Set([...asked.flatMap((pkg) => SOURCES[pkg.ecosystem]), ...(repoAdvisories ? ['GitHub'] : [])])
    throw new Error(`${[...sources].join('/')} advisories request failed: ${cause.message}`, { cause })
  }
  // `--why` REPLACES the consumer list with per-consumer import paths, so only
  // one of the two is computed for npm's advisories, the only ones collectWhy has
  // paths for: another ecosystem's keep their consumers. Restrict the (potentially
  // expensive) path search to the packages that actually carry an advisory.
  // `reason` (--reason) narrows both the paths (in collectWhy) and the consumer
  // list (in flattenAdvisories) to a single consumer, dropping advisories
  // unrelated to it.
  let rows
  if (why) {
    const npm = result.filter((adv) => adv.ecosystem === 'npm')
    const targetKeys = new Set(npm.flatMap((adv) => adv.versions.map((v) => keyOf(adv.ecosystem, adv.name, v))))
    const reasons = npm.length < result.length ? collectReasons(files) : undefined
    rows = flattenAdvisories(result, reasons, collectWhy(files, targetKeys, reason, { deep: whyDeep, full: whyFull }), reason)
  } else {
    rows = flattenAdvisories(result, collectReasons(files), null, reason)
  }
  return { packages, skipped, advisories: result, rows, why, whyDeep, whyFull, reason }
}

// `10 alerts, 1 critical, 5 high, 3 moderate, 1 low`: the rows, then each severity present, in the
// rows' own order (most severe first); a row without one is `unrated`, so the parts add up.
function alertStats(rows) {
  const bySeverity = Map.groupBy(rows, (r) => r.severity || 'unrated')
  return [`${rows.length} alert${rows.length === 1 ? '' : 's'}`, ...[...bySeverity].map(([severity, list]) => `${list.length} ${severity}`)].join(', ')
}

export function printAuditReport({ packages, skipped = [], rows, why = false, reason = null }, { out = process.stdout, err = process.stderr } = {}) {
  const scanned = `Scanned ${packages.length} package${packages.length === 1 ? '' : 's'}`
  if (packages.length === 0) {
    err.write(`${scanned}\nNo dependencies found in the input files\n`)
    return
  }
  err.write(`${scanned}: ${alertStats(rows)}\n`)
  for (const pkg of skipped) err.write(`Not audited: ${pkg.ecosystem} ${pkg.name}@${pkg.version}, ${pkg.because}\n`)
  if (rows.length === 0) return
  // The ecosystem column only where one is not npm's, which the others were all once.
  const columns = ['severity', ...(rows.some((r) => r.ecosystem !== 'npm') ? ['ecosystem'] : []), 'package', 'installed', 'vulnerable', 'title', 'id']
  // Surface the reason column only when some advisory has provenance -- bundle
  // consumers, or (with --why) import paths. Under --reason WITHOUT --why every
  // cell is just the filter value repeated, so drop the column then; --why still
  // earns it (the import chains differ per row).
  if (rows.some((r) => r.reason) && !(reason && !why)) columns.splice(columns.indexOf('installed') + 1, 0, 'reason')
  // Under --why the reason cell is a list of `consumer: path` lines; let it span
  // multiple physical rows instead of collapsing to one.
  out.write(formatTable(rows, columns, { multiline: why ? ['reason'] : [] }) + '\n')
}
