import { packageRepo } from '@exodus/stasis-core/bundle-util'
import { dependencyEcosystem, moduleFileKey, packageRecords, sameGithub } from '@exodus/stasis-core/util'
import { advisories } from '@preventive/upstream/advisories.js'
import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { isEvidenceFile } from './audit-corrections.js'
import { DIM, formatTable, painter, takesColors } from './table.js'

export { formatTable }
import { parseFile, parseFileWithKind } from './parse.js'
import { logos } from './sixel.js'
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

// A package's key as collectPackages and collectReasons tell packages apart: keyOf it, but a copy a dependency
// ships with no version, which is one package for each host, by its host's `name@version` too.
const packageKey = (ecosystem, name, version, host) => (version === undefined ? `${ecosystem}:${name} in ${host}` : keyOf(ecosystem, name, version))

// A refused audit, as a usage error: one for the message alone, never a stack.
export class AuditError extends Error {
  name = 'AuditError'
}

// Composer's dev versions (`dev-main`, `1.x-dev`), as Composer tells them, a `#ref` dropped: no
// advisory database lists those, and advisories() takes releases alone.
const isComposerDev = (version) => /^dev-|-dev$/iu.test(version.replace(/#.*$/su, ''))

// Why `pkg` cannot be audited, or undefined where it can.
function unaudited({ ecosystem, version, vendoredIn }) {
  if (version === undefined) return `a copy vendored in ${vendoredIn.join(', ')} whose package.json gives no version, so no advisory can be matched to it`
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
// one does; else, for an npm package a bundle carries the package.json of (one built before builds
// recorded `repo`), the one that names, read by the rule builds record it by. A GitHub repo is its
// own, and has none.
//
// A copy of a package a dependency ships (its record's `vendored`, as packageRecords splits it out) is
// audited too, as the package it is, by the same evidence rule over the files it holds, with
// `vendoredIn` its host's `name@version`; its host, all of whose files the copy's are, as before. A copy
// whose package.json gives no version is listed with none, as not audited.
export function collectPackagesFromFile(file) {
  const out = []
  const { kind, artifact } = parseFileWithKind(file)
  for (const [dir, { name, version, ecosystem: tagged, repo, files, vendoredIn }] of packageRecords(artifact.modules)) {
    const ecosystem = dependencyEcosystem(dir, tagged)
    // First-party code is never sent to a public registry (leaks names, adds noise).
    if (ecosystem === undefined) continue
    if (!name || (!version && vendoredIn === undefined)) continue
    if (!Object.keys(files).some((rel) => isEvidenceFile(name, version ?? null, rel, ecosystem))) continue
    if (vendoredIn !== undefined) {
      const host = artifact.modules.get(vendoredIn)
      out.push({ ecosystem, name, version: version === undefined ? undefined : versionOf(ecosystem, version), vendoredIn: `${host.name}@${host.version}` })
      continue
    }
    let github = ecosystem === 'github' ? undefined : repo?.github
    if (github === undefined && ecosystem === 'npm' && kind === 'bundle') github = manifestRepo(files['package.json'])
    out.push({ ecosystem, name, version: versionOf(ecosystem, version), ...(github === undefined ? {} : { github }) })
  }
  return out
}

// The GitHub repository a bundled package.json's text names (packageRepo), or undefined where it
// names none or doesn't parse. Read as Node reads one, past a byte order mark (packageJSONText),
// which a bundle keeps in the text. A lockfile holds the file's digest alone, never asked here.
function manifestRepo(text) {
  if (typeof text !== 'string') return undefined
  try {
    return packageRepo(JSON.parse(text.replace(/^\uFEFF/u, '')))?.github
  } catch {
    return undefined
  }
}

// Versions in semver's order where both are semver's, else as numbers in text compare.
const byNumbers = new Intl.Collator('en', { numeric: true }).compare
const byVersion = (a, b) => (valid(a) && valid(b) ? compareVersions(a, b) : byNumbers(a, b))

// Each package once, with the GitHub repository its artifacts record for its name, which
// advisories() asks instead of looking one up. It takes one repository a name, so a name recorded
// with two, by two of its versions (a package that moved) or by two artifacts, has none, and is
// looked up as before. One some dependency ships a copy of carries `vendoredIn`, the hosts' sorted
// `name@version`s, and `vendoredOnly`, whether that copy is all there is of it; a copy without a version
// is one package per host.
export function collectPackages(files) {
  const byKey = new Map()
  const vendored = new Map() // key -> { hosts, only }
  const repos = new Map() // `ecosystem:name` -> the one repository recorded for it, or null
  for (const file of files) {
    for (const { github, vendoredIn, ...pkg } of collectPackagesFromFile(file)) {
      const key = packageKey(pkg.ecosystem, pkg.name, pkg.version, vendoredIn)
      if (!byKey.has(key)) byKey.set(key, pkg)
      if (!vendored.has(key)) vendored.set(key, { hosts: new Set(), only: true })
      if (vendoredIn === undefined) vendored.get(key).only = false
      else vendored.get(key).hosts.add(vendoredIn)
      if (github === undefined) continue
      const name = `${pkg.ecosystem}:${pkg.name}`
      const known = repos.get(name)
      // The first spelling stands.
      if (known === undefined) repos.set(name, github)
      else if (known !== null && !sameGithub(known, github)) repos.set(name, null)
    }
  }
  return [...byKey]
    .map(([key, pkg]) => {
      const github = repos.get(`${pkg.ecosystem}:${pkg.name}`)
      const { hosts, only } = vendored.get(key)
      return { ...pkg, ...(github ? { github } : {}), ...(hosts.size === 0 ? {} : { vendoredIn: [...hosts].toSorted(), vendoredOnly: only }) }
    })
    .toSorted((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || byVersion(a.version, b.version))
}

// Map each audited package (keyOf it) to the bundle consumers ("reasons") that recorded its files.
// Only bundles carry a reason map ({ consumer: [file, ...] }); lockfiles omit it. Each file is
// resolved back to its owning package via the module file listing. Only evidence files attribute
// (see audit-corrections.js): a consumer that recorded nothing of a package but a corrected file or
// its manifest carries none of its real code and is NOT a reason -- e.g. webpack shipping only ws's
// noop browser.js stub, while `run` bundles the real ws.
// A file of a copy a dependency ships (packageRecords) attributes to both: the copy and its host; a copy
// with no version by packageKey.
export function collectReasons(files) {
  return reasonIndex(files).byPkg
}

// collectReasons' map (`byPkg`), and every consumer the files' reason maps record (`consumers`), a consumer
// that recorded first-party code alone too: what --reason may name.
function reasonIndex(files) {
  const byPkg = new Map()
  const consumers = new Set()
  for (const file of files) {
    const artifact = parseFile(file)
    const fileReasons = invertReason(artifact.reason)
    if (!fileReasons) continue
    for (const [consumer, list] of Object.entries(artifact.reason)) if (Array.isArray(list)) consumers.add(consumer)
    const fileToPkgs = new Map()
    for (const [dir, { name, version, ecosystem: tagged, files: modFiles, vendoredIn }] of packageRecords(artifact.modules)) {
      const ecosystem = dependencyEcosystem(dir, tagged)
      if (ecosystem === undefined || !name || (!version && vendoredIn === undefined)) continue
      const host = vendoredIn === undefined ? undefined : artifact.modules.get(vendoredIn)
      const key = packageKey(ecosystem, name, version === undefined ? undefined : versionOf(ecosystem, version), host && `${host.name}@${host.version}`)
      for (const rel of Object.keys(modFiles)) {
        if (!isEvidenceFile(name, version ?? null, rel, ecosystem)) continue
        const f = moduleFileKey(dir, rel)
        if (!fileToPkgs.has(f)) fileToPkgs.set(f, [])
        fileToPkgs.get(f).push(key)
      }
    }
    for (const [f, recorded] of fileReasons) {
      for (const key of fileToPkgs.get(f) ?? []) {
        let set = byPkg.get(key)
        if (set === undefined) byPkg.set(key, (set = new Set()))
        for (const consumer of recorded) set.add(consumer)
      }
    }
  }
  return { byPkg, consumers }
}

// `malware` first: a package that is malware is worse than any vulnerability in one. An advisory
// advisories() flags as malware (`malware: true`) is rated so, whatever its source rates it.
const SEVERITY_ORDER = { malware: 0, critical: 1, high: 2, moderate: 3, low: 4, info: 5, none: 6 }

// Consumer display order: bundler plugins (metro, webpack, esbuild, ...) first,
// then `run`, then `add`, then `extra` (stasis.config.json's). Ties broken alphabetically.
const CONSUMER_RANK = { run: 1, add: 2, extra: 3 }
const consumerRank = (c) => CONSUMER_RANK[c] ?? 0
const byConsumerOrder = (a, b) => consumerRank(a) - consumerRank(b) || a.localeCompare(b)

// Build a row's `reason` cell by unioning over exactly the affected versions it
// covers. Without `--why` that's the `, `-joined set of bundle consumers; with
// `--why` it's the newline-joined `consumer: a -> b -> c` import-path lines
// (which REPLACE the consumer list). Consumers are ordered plugins -> run -> add -> extra.
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
  // plugins -> run -> add -> extra (this also re-unites a consumer's lines when they were
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

// An installed version as the table shows it: with the dependencies that ship a copy of it, where one does
// (`vendoredByKey`, collectPackages' packages by keyOf).
function installedCell({ ecosystem, name }, version, vendoredByKey) {
  const pkg = vendoredByKey.get(keyOf(ecosystem, name, version))
  if (pkg?.vendoredIn === undefined) return version
  return `${version} (${pkg.vendoredOnly ? '' : 'also '}vendored in ${pkg.vendoredIn.join(', ')})`
}

// `found` is what @preventive/upstream's advisories() answers: one row per advisory range, whose
// `versions` are the audited versions it covers (never empty -- a range covering none is dropped
// there, so the table and exit code reflect only real hits).
export function flattenAdvisories(found, reasonsByPkg = new Map(), whyByPkg = null, reasonFilter = null, vendoredByKey = new Map()) {
  const rows = []
  for (const adv of found) {
    const reason = reasonCell(adv, reasonsByPkg, whyByPkg, reasonFilter)
    // --reason keeps only advisories tied to that consumer: once the cell is
    // narrowed to it, an empty cell means this package isn't related to it.
    if (reasonFilter && reason === '') continue
    rows.push({
      ecosystem: adv.ecosystem,
      package: adv.name,
      installed: adv.versions.map((v) => installedCell(adv, v, vendoredByKey)).join(', '),
      vulnerable: adv.range ?? '',
      severity: adv.malware ? 'malware' : adv.severity ?? '',
      title: adv.title ?? '',
      id: adv.id,
      source: adv.source,
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

// `files` are the lockfiles' and bundles' paths, or a Bundle or Lockfile in place of one (one built in
// memory, as `stasis audit` with no file builds stasis.config.json's entries' bundle), taken as the
// file would read.
// `repoAdvisories` and `github` (a @preventive/upstream/github.js client) go to advisories() as they
// are; a Soldeer package or a GitHub repo needs the client, their repository being their only source.
// A package that cannot be audited is `skipped`, with why (`because`), and asked for nothing.
// `reason` (--reason) audits only the packages that consumer recorded (collectReasons): no other is
// counted, listed, or asked about as they are. One no file records is refused (AuditError) before anything
// is, naming those they do; a lockfile records none. `osv` asks OSV about npm packages too, those whose
// name npm's registry serves to anyone; advisories() never sends it a private one.
// `npmMalware` is what npm's registry tells of malware in any npm dependency, whatever `reason`: rows as
// `rows` are, each package's consumers its reason. Under --reason, the npm packages its consumer didn't
// record are asked of npm's registry alone for it (fast, where OSV and their repositories aren't).
export async function audit(files, { why = false, whyDeep = false, whyFull = false, reason = null, repoAdvisories = false, github, osv = false } = {}) {
  // --why-deep and --why-full imply --why. Deep keeps every chain instead of the
  // default pruning of chains whose full suffix is already a chain (see
  // collectWhy/dropSuffixed); full spells chains out with no `...` collapse.
  why = why || whyDeep || whyFull
  let reasons // collectReasons(files), once it is needed
  if (reason) {
    const index = reasonIndex(files)
    if (!index.consumers.has(reason)) {
      const known = [...index.consumers].toSorted(byConsumerOrder)
      throw new AuditError(`--reason=${reason}: ${known.length === 0
        ? 'the files record no consumers (only a bundle does)'
        : `no file records that consumer; they record ${known.join(', ')}`}`)
    }
    reasons = index.byPkg
  }
  const all = collectPackages(files)
  const packages = reason ? all.filter((pkg) => reasons.get(packageKey(pkg.ecosystem, pkg.name, pkg.version, pkg.vendoredIn?.[0]))?.has(reason)) : all
  const skipped = packages.flatMap((pkg) => {
    const because = unaudited(pkg)
    return because === undefined ? [] : [{ ...pkg, because }]
  })
  const asked = packages.filter((pkg) => unaudited(pkg) === undefined)
  // Under --reason, the npm packages its consumer didn't record, for npm's malware advisories.
  const own = new Set(packages)
  const others = reason ? all.filter((pkg) => !own.has(pkg) && pkg.ecosystem === 'npm' && unaudited(pkg) === undefined) : []
  if (asked.length === 0 && others.length === 0) {
    return { packages, skipped, advisories: [], rows: [], npmMalware: [], why, whyDeep, whyFull, reason }
  }
  const query = (list) => list.map(({ version, vendoredIn: _in, vendoredOnly: _only, ...pkg }) => ({ ...pkg, versions: [version] }))
  let result
  let elsewhere
  try {
    ;[result, elsewhere] = await Promise.all([
      asked.length > 0 ? advisories(query(asked), { repoAdvisories, github, osv }) : [],
      others.length > 0 ? advisories(query(others)) : [],
    ])
  } catch (cause) {
    // Refused input or a malformed answer is an assertion that says so itself; a transport or
    // HTTP failure gets the context of which request it was.
    if (cause?.code === 'ERR_ASSERTION') throw cause
    const sources = new Set([...asked.flatMap((pkg) => SOURCES[pkg.ecosystem]), ...(others.length > 0 ? ['npm'] : []), ...(osv && asked.some((pkg) => pkg.ecosystem === 'npm') ? ['OSV'] : []), ...(repoAdvisories ? ['GitHub'] : [])])
    throw new Error(`${[...sources].join('/')} advisories request failed: ${cause.message}`, { cause })
  }
  const vendoredOf = (list) => new Map(list.filter((pkg) => pkg.vendoredIn !== undefined).map((pkg) => [keyOf(pkg.ecosystem, pkg.name, pkg.version), pkg]))
  // npm's registry's malware advisories (`registry` rows, not OSV's records), of every npm dependency.
  const malware = [...result, ...elsewhere].filter((adv) => adv.malware && adv.source === 'registry')
  if (malware.length > 0) reasons ??= collectReasons(files)
  const npmMalware = flattenAdvisories(malware, reasons, null, null, vendoredOf([...asked, ...others]))
  // `--why` REPLACES the consumer list with per-consumer import paths, so only
  // one of the two is computed for npm's advisories, the only ones collectWhy has
  // paths for: another ecosystem's keep their consumers. Restrict the (potentially
  // expensive) path search to the packages that actually carry an advisory.
  // `reason` (--reason) narrows both the paths (in collectWhy) and the consumer
  // list (in flattenAdvisories) to a single consumer, dropping advisories
  // unrelated to it.
  const vendoredByKey = vendoredOf(asked)
  let rows
  if (why) {
    const npm = result.filter((adv) => adv.ecosystem === 'npm')
    const targetKeys = new Set(npm.flatMap((adv) => adv.versions.map((v) => keyOf(adv.ecosystem, adv.name, v))))
    if (npm.length < result.length) reasons ??= collectReasons(files)
    rows = flattenAdvisories(result, reasons, collectWhy(files, targetKeys, reason, { deep: whyDeep, full: whyFull }), reason, vendoredByKey)
  } else {
    rows = flattenAdvisories(result, reasons ?? collectReasons(files), null, reason, vendoredByKey)
  }
  return { packages, skipped, advisories: result, rows, npmMalware, why, whyDeep, whyFull, reason }
}

// Each severity's colour, the worst the loudest (malware white on red); an advisory without one (RustSec's)
// `unrated`, dimmed.
const SEVERITY_TONES = { malware: ['bold', 'white', 'bgRed'], critical: ['bold', 'magenta'], high: ['bold', 'red'], moderate: 'yellow', low: 'cyan', info: DIM, none: DIM, unrated: DIM }
const severityOf = (row) => row.severity || 'unrated'

// The columns whose text wraps where the table is wider than the terminal: the long ones, free text first.
const WRAPPED = ['title', 'reason', 'vulnerable', 'installed']

// `5 alerts (1 critical, 2 high, 1 low, 1 unrated)`: the rows, then each severity present, in the rows'
// own order (most severe first), so the parts add up; each in its colour, and none in green.
function alertStats(rows, paint, colored) {
  const count = `${rows.length} alert${rows.length === 1 ? '' : 's'}`
  if (rows.length === 0) return paint(['bold', 'green'], count)
  const bySeverity = Map.groupBy(rows, severityOf)
  return `${paint('bold', count)} (${[...bySeverity].map(([severity, list]) => paint(SEVERITY_TONES[severity], badge(severity, `${list.length} ${severity}`, colored))).join(', ')})`
}

// Malware as a badge: its colour a space wider on either side, where there is colour.
const badge = (severity, text, colored) => (severity === 'malware' && colored ? ` ${text} ` : text)

// Where an advisory comes from (upstream's `source`), as sixel.js draws it: npm's registry, a GitHub
// repository's advisories, or OSV.
const SOURCE_LOGOS = { registry: 'npm', repository: 'github', osv: 'osv' }
// The cells an icon covers: two, as sixel.js logos() picks icons no wider than two of the terminal's cells.
const ICON_CELLS = 2
// An icon, drawn with the cursor saved and put back, as a terminal may leave it below the image, then
// moved past the cells it covers, as text written over them would erase it.
const drawIcon = (icon) => `\x1b7${icon}\x1b8\x1b[${ICON_CELLS}C`
// Written before a line with an icon: two lines below it, then back up. A terminal moving the cursor
// below the image then never scrolls, which would put the cursor back a line off.
const ROOM_BELOW = '\n\n\x1b[2A'

// The advisories as a table on `out`, fitted to `width` (the terminal's, where `out` is one) by wrapping
// its long columns; on `err`, the packages not audited, then the summary, last, so it is what is read
// after the table. Severities in colour, the header bold and the box dimmed, where each stream takes
// colours (`colors`, else takesColors). With `icons` (the logos sixel.js logos() picks for a terminal
// that draws sixel images, true for its 16-pixel ones), each id has its source's icon before it.
export function printAuditReport({ packages, skipped = [], rows, npmMalware = [], why = false, reason = null }, { out = process.stdout, err = process.stderr, colors, width = out.isTTY ? out.columns : undefined, icons: given = false } = {}) {
  const icons = given === true ? logos() : given || null
  const paintOut = painter(out, colors)
  const paintErr = painter(err, colors)
  const coloredOut = colors ?? takesColors(out)
  const coloredErr = colors ?? takesColors(err)
  const scanned = `Scanned ${packages.length} package${packages.length === 1 ? '' : 's'}${reason ? ` recorded by ${reason}` : ''}`
  if (packages.length === 0) {
    err.write(`${scanned}\n${paintErr('yellow', reason ? `No dependencies recorded by ${reason}` : 'No dependencies found in the input files')}\n`)
    printMalware(npmMalware, err, paintErr, coloredErr)
    return
  }
  if (rows.length > 0) {
    // The ecosystem column only where one is not npm's, which the others were all once.
    const columns = ['severity', ...(rows.some((r) => r.ecosystem !== 'npm') ? ['ecosystem'] : []), 'package', 'installed', 'vulnerable', 'title', 'id']
    // Surface the reason column only when some advisory has provenance -- bundle
    // consumers, or (with --why) import paths. Under --reason WITHOUT --why every
    // cell is just the filter value repeated, so drop the column then; --why still
    // earns it (the import chains differ per row).
    if (rows.some((r) => r.reason) && !(reason && !why)) columns.splice(columns.indexOf('installed') + 1, 0, 'reason')
    // A chain's arrows and `...` dimmed, so the packages in it stand out. An id's blank cells its icon.
    const iconOf = (row) => icons?.[SOURCE_LOGOS[row.source]]
    const paint = (text, column, row) => {
      if (column === 'id' && iconOf(row)) return drawIcon(iconOf(row)) + text.slice(ICON_CELLS)
      if (column === 'severity') return paintOut(SEVERITY_TONES[row.severity.trim()], text)
      if (column === 'package') return paintOut('bold', text)
      if (column === 'reason' && why) return text.replaceAll(/(?<=^| )(?:->|\.\.\.)(?= |$)/gu, (arrow) => paintOut(DIM, arrow))
      return text
    }
    // Under --why the reason cell is a list of `consumer: path` lines; let it span
    // multiple physical rows instead of collapsing to one.
    const table = formatTable(rows.map((row) => ({ ...row, severity: badge(severityOf(row), severityOf(row), coloredOut), ...(icons && { id: `${' '.repeat(ICON_CELLS)} ${row.id}` }) })), columns, {
      multiline: why ? ['reason'] : [],
      wrap: WRAPPED,
      width,
      paint,
      paintHeader: (text) => paintOut('bold', text),
      paintFrame: (text) => paintOut(DIM, text),
    })
    out.write(`${icons ? table.split('\n').map((line) => (line.includes('\x1bP') ? ROOM_BELOW + line : line)).join('\n') : table}\n`)
  }
  if (skipped.length > 0) {
    const names = skipped.map((pkg) => `${pkg.ecosystem} ${pkg.name}${pkg.version === undefined ? '' : `@${pkg.version}`}`)
    const pad = Math.max(...names.map((name) => name.length))
    const lines = skipped.map((pkg, i) => `  ${names[i].padEnd(pad)}  ${paintErr(DIM, pkg.because)}`)
    err.write(`${rows.length > 0 ? '\n' : ''}${paintErr('yellow', 'Not audited:')}\n${lines.join('\n')}\n`)
  }
  err.write(`${rows.length > 0 || skipped.length > 0 ? '\n' : ''}${scanned}: ${alertStats(rows, paintErr, coloredErr)}\n`)
  printMalware(npmMalware, err, paintErr, coloredErr)
}

// What npm's registry tells of malware in any dependency, whatever --reason (audit()'s `npmMalware`), after
// the summary, apart from the table: each advisory a line, its package and version, id and title, and the
// consumers that recorded it.
function printMalware(rows, err, paint, colored) {
  if (rows.length === 0) return
  const packages = new Set(rows.map((row) => `${row.package}@${row.installed}`)).size
  const names = rows.map((row) => `${row.package} ${row.installed}`)
  const pad = (list) => Math.max(...list.map((text) => text.length))
  const [nameWidth, idWidth, titleWidth] = [pad(names), pad(rows.map((row) => row.id)), pad(rows.map((row) => row.title))]
  const lines = rows.map((row, i) => `  ${names[i].padEnd(nameWidth)}  ${row.id.padEnd(idWidth)}  ${row.reason ? `${row.title.padEnd(titleWidth)}  ${paint(DIM, row.reason)}` : row.title}`)
  err.write(`\n${paint(SEVERITY_TONES.malware, badge('malware', 'malware', colored))} in ${packages} dependenc${packages === 1 ? 'y' : 'ies'}, as npm's advisories tell:\n${lines.join('\n')}\n`)
}
