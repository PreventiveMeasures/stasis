import { packageRepo } from '@exodus/stasis-core/bundle-util'
import { dependencyEcosystem, moduleFileKey, sameGithub, upsert, withoutBom } from '@exodus/stasis-core/util'
import { advisories } from '@preventive/upstream/advisories.js'
import { compareVersions, valid } from '@preventive/upstream/semver.js'
import { isEvidenceFile } from './audit-corrections.js'
import { DIM, formatTable, painter, takesColors } from './table.js'
import { parseFile, parseFileWithKind } from './parse.js'
import { logos } from './sixel.js'
import { collectWhy, invertReason, packageRecords } from './why.js'

export { formatTable }

// Where advisories() asks for each ecosystem's advisories. OSV takes a vendored crate for crates.io's, and has
// a GitHub repo's (Foundry's lib/ submodules) as a GitHub Action's; Packagist's is what `composer audit` reads;
// a Soldeer package's and a GitHub repo's are also its own repository's.
const SOURCES = { npm: ['npm'], cargo: ['OSV'], composer: ['OSV', 'Packagist'], soldeer: ['Soldeer', 'GitHub'], github: ['OSV', 'GitHub'] }

// Why a vendored crate that may not be crates.io's is asked nowhere: by its name, crates.io's
// advisories would be another crate's, and a private git dependency's name must not reach a public
// database at all.
const UNREGISTERED_CRATES = {
  'cargo-git': 'a crate vendored from a git repository, not crates.io',
  'cargo-unknown': 'a vendored crate with no .cargo-checksum.json, which may be a git checkout, not crates.io\'s',
}

// A GitHub repo's `.gitmodules` branch `.` (git's for the superproject's own, which the bundle doesn't
// know) is audited as 0.0.0, the version stasis gives a repo with none; every advisory range covers both.
const versionOf = (ecosystem, version) => (ecosystem === 'github' && version === '.' ? '0.0.0' : version)

// A package's key across the audit: `name@version` for npm, as collectWhy keys its chains, and
// prefixed by the ecosystem for the others, whose names may be npm's too.
const keyOf = ({ ecosystem, name }, version) => `${ecosystem === 'npm' ? '' : `${ecosystem}:`}${name}@${version}`

// keyOf `pkg`, but a copy a dependency ships with no version, one package for each host, by its `host` too.
const packageKey = (pkg, host) => (pkg.version === undefined ? `${pkg.ecosystem}:${pkg.name} in ${host}` : keyOf(pkg, pkg.version))

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

// The dependencies `file` records whose real code it carries (a recorded file is evidence, audit-corrections.js),
// `{ ecosystem, name, version, github }`: `github` the repository the artifact records, else the one a bundled
// package.json names. A copy a dependency ships is `{ ecosystem, name, version, vendoredIn }`, its host's `name@version`.
export function collectPackagesFromFile(file) {
  const out = []
  const { kind, artifact } = parseFileWithKind(file)
  for (const { name, version, ecosystem, repo, files, host, isEvidence } of auditedRecords(artifact.modules)) {
    if (!Object.keys(files).some(isEvidence)) continue
    if (host !== undefined) {
      out.push({ ecosystem, name, version, vendoredIn: host })
      continue
    }
    let github = ecosystem === 'github' ? undefined : repo?.github
    if (github === undefined && ecosystem === 'npm' && kind === 'bundle') github = manifestRepo(files['package.json'])
    out.push({ ecosystem, name, version, ...(github === undefined ? {} : { github }) })
  }
  return out
}

// Each dependency of `modules` the audit may count (never first-party code, never sent to a public registry),
// with its `version` as audited, its `host`'s `name@version` where a dependency ships it, and `isEvidence(rel)`.
function* auditedRecords(modules) {
  for (const [dir, { name, version, ecosystem: tagged, repo, files, vendoredIn }] of packageRecords(modules)) {
    const ecosystem = dependencyEcosystem(dir, tagged)
    if (ecosystem === undefined || !name || (!version && vendoredIn === undefined)) continue
    const host = vendoredIn === undefined ? undefined : modules.get(vendoredIn)
    yield {
      dir, name, ecosystem, repo, files,
      version: version === undefined ? undefined : versionOf(ecosystem, version),
      host: host === undefined ? undefined : `${host.name}@${host.version}`,
      isEvidence: (rel) => isEvidenceFile(name, version ?? null, rel, ecosystem),
    }
  }
}

// The GitHub repository a bundled package.json's text names (packageRepo), or undefined where it
// names none or doesn't parse. Read as Node reads one, past a byte order mark (packageJSONText),
// which a bundle keeps in the text. A lockfile holds the file's digest alone, never asked here.
function manifestRepo(text) {
  if (typeof text !== 'string') return undefined
  try {
    return packageRepo(JSON.parse(withoutBom(text)))?.github
  } catch {
    return undefined
  }
}

// Versions in semver's order where both are semver's, else as numbers in text compare.
const byNumbers = new Intl.Collator('en', { numeric: true }).compare
const byVersion = (a, b) => (valid(a) && valid(b) ? compareVersions(a, b) : byNumbers(a, b))

// Each package once, with the GitHub repository its artifacts record for its name, which advisories() asks
// instead of looking one up (none where two are recorded). One a dependency ships a copy of carries
// `vendoredIn`, the hosts' sorted `name@version`s, and `vendoredOnly`, whether that copy is all there is of it.
export function collectPackages(files) {
  const byKey = new Map() // packageKey -> { pkg, hosts, only }
  const repos = new Map() // `ecosystem:name` -> the one repository recorded for it, or null
  for (const file of files) {
    for (const { github, vendoredIn, ...pkg } of collectPackagesFromFile(file)) {
      const entry = upsert(byKey, packageKey(pkg, vendoredIn), () => ({ pkg, hosts: new Set(), only: true }))
      if (vendoredIn === undefined) entry.only = false
      else entry.hosts.add(vendoredIn)
      if (github === undefined) continue
      const name = `${pkg.ecosystem}:${pkg.name}`
      const known = repos.get(name)
      // The first spelling stands.
      if (known === undefined) repos.set(name, github)
      else if (known !== null && !sameGithub(known, github)) repos.set(name, null)
    }
  }
  return [...byKey.values()]
    .map(({ pkg, hosts, only }) => {
      const github = repos.get(`${pkg.ecosystem}:${pkg.name}`)
      return { ...pkg, ...(github ? { github } : {}), ...(hosts.size === 0 ? {} : { vendoredIn: [...hosts].toSorted(), vendoredOnly: only }) }
    })
    .toSorted((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || byVersion(a.version, b.version))
}

// Each audited package (packageKey) -> the bundle consumers that recorded an evidence file of it: webpack
// shipping only ws's noop browser.js stub is no reason for ws (audit-corrections.js). A file of a copy a
// dependency ships attributes to the copy and its host. A lockfile carries no reason map.
export function collectReasons(files) {
  return reasonIndex(files).byPkg
}

// collectReasons' map (`byPkg`), and every consumer the files' reason maps record (`consumers`), one that
// recorded first-party code alone too: what --reason may name.
function reasonIndex(files) {
  const byPkg = new Map()
  const consumers = new Set()
  for (const file of files) {
    const artifact = parseFile(file)
    const fileReasons = invertReason(artifact.reason)
    if (!fileReasons) continue
    for (const [consumer, list] of Object.entries(artifact.reason)) if (Array.isArray(list)) consumers.add(consumer)
    const fileToPkgs = new Map()
    for (const record of auditedRecords(artifact.modules)) {
      const key = packageKey(record, record.host)
      for (const rel of Object.keys(record.files)) {
        if (record.isEvidence(rel)) upsert(fileToPkgs, moduleFileKey(record.dir, rel), () => []).push(key)
      }
    }
    for (const [f, recorded] of fileReasons) {
      for (const key of fileToPkgs.get(f) ?? []) {
        const set = upsert(byPkg, key, () => new Set())
        for (const consumer of recorded) set.add(consumer)
      }
    }
  }
  return { byPkg, consumers }
}

// The consumer `stasis bundle --metro` records a Metro build's files under, and the one Metro's own
// plugin records a build Metro ran under.
const BUNDLE_METRO = 'bundle:metro'
const METRO = 'metro'

// reasonIndex's `byPkg` and `consumers`, each consumer as audit names it (`name`): as it is, but
// `bundle:metro` as `metro` where none records `metro`, which it then can't be taken for.
function namedIndex({ byPkg, consumers }) {
  const name = consumers.has(BUNDLE_METRO) && !consumers.has(METRO)
    ? (consumer) => (consumer === BUNDLE_METRO ? METRO : consumer)
    : (consumer) => consumer
  return {
    byPkg: new Map([...byPkg].map(([key, set]) => [key, new Set([...set].map(name))])),
    consumers: new Set([...consumers].map(name)),
    name,
  }
}

// `malware` first: a package that is malware is worse than any vulnerability in one. An advisory
// advisories() flags as malware (`malware: true`) is rated so, whatever its source rates it.
const SEVERITY_ORDER = { malware: 0, critical: 1, high: 2, moderate: 3, low: 4, info: 5, none: 6 }

// Consumer display order: bundler plugins (metro, webpack, esbuild, ...) first,
// then `run`, then `add`, then `extra` (stasis.config.json's). Ties broken alphabetically.
const CONSUMER_RANK = { run: 1, add: 2, extra: 3 }
const consumerRank = (c) => CONSUMER_RANK[c] ?? 0
const byConsumerOrder = (a, b) => consumerRank(a) - consumerRank(b) || a.localeCompare(b)

// A row's `reason` cell, over the versions it covers: the `, `-joined consumers (only `reasonFilter`, where
// set), or under --why the `consumer: a -> b -> c` lines, grouped by consumer. collectWhy follows npm's import
// graph alone (and filters by `reasonFilter` itself), so another ecosystem's advisory keeps its consumers.
function reasonCell(adv, reasonsByPkg, whyByPkg, reasonFilter) {
  const chains = whyByPkg !== null && adv.ecosystem === 'npm'
  const source = chains ? whyByPkg : reasonsByPkg
  const parts = new Set(adv.versions.flatMap((v) => [...(source.get(keyOf(adv, v)) ?? [])]))
  if (chains) {
    // Grouping re-unites a consumer's lines split across versions; within a group collectWhy's order stands.
    const byConsumer = Map.groupBy(parts, (line) => {
      const i = line.indexOf(': ')
      return i === -1 ? '' : line.slice(0, i)
    })
    return [...byConsumer.keys()].toSorted(byConsumerOrder).flatMap((c) => byConsumer.get(c)).join('\n')
  }
  return [...parts].filter((c) => !reasonFilter || c === reasonFilter).toSorted(byConsumerOrder).join(', ')
}

// An installed version as the table shows it: with the dependencies that ship a copy of it, where one does
// (`vendoredByKey`, collectPackages' packages by keyOf).
function installedCell(adv, version, vendoredByKey) {
  const pkg = vendoredByKey.get(keyOf(adv, version))
  if (pkg?.vendoredIn === undefined) return version
  return `${version} (${pkg.vendoredOnly ? '' : 'also '}vendored in ${pkg.vendoredIn.join(', ')})`
}

const severityRank = (row) => SEVERITY_ORDER[row.severity] ?? 99
const byText = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

// `found` is what @preventive/upstream's advisories() answers: one row per advisory range, whose
// `versions` are the audited versions it covers (never empty -- a range covering none is dropped
// there, so the table and exit code reflect only real hits).
export function flattenAdvisories(found, reasonsByPkg = new Map(), whyByPkg = null, reasonFilter = null, vendoredByKey = new Map()) {
  const rows = []
  for (const adv of found) {
    const reason = reasonCell(adv, reasonsByPkg, whyByPkg, reasonFilter)
    // Under --reason, an empty cell is an advisory unrelated to that consumer.
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
  return rows.toSorted((a, b) => severityRank(a) - severityRank(b) || byText(a.package, b.package) || byText(a.ecosystem, b.ecosystem) || (a.title < b.title ? -1 : 1))
}

// The advisories of `files`' packages (lockfile/bundle paths, or a Bundle or Lockfile built in memory); `reason`
// (--reason) audits only what that consumer recorded, refusing one none records (AuditError). `npmMalware` is npm's
// malware advisories of every npm dependency whatever `reason`, those `lockfile` (lockedNpmPackages') locks alone too.
export async function audit(files, { why = false, whyDeep = false, whyFull = false, reason = null, repoAdvisories = false, github, osv = false, lockfile = null } = {}) {
  // --why-deep (keep every chain, see dropSuffixed) and --why-full (no `...` collapse) imply --why.
  why = why || whyDeep || whyFull
  let index
  const indexed = () => (index ??= namedIndex(reasonIndex(files)))
  if (reason) {
    const { consumers, name } = indexed()
    if (!consumers.has(name(reason))) {
      const known = [...consumers].toSorted(byConsumerOrder)
      throw new AuditError(`--reason=${reason}: ${known.length === 0
        ? 'the files record no consumers (only a bundle does)'
        : `no file records that consumer; they record ${known.join(', ')}`}`)
    }
    reason = name(reason)
  }
  const all = collectPackages(files)
  const packages = reason ? all.filter((pkg) => indexed().byPkg.get(packageKey(pkg, pkg.vendoredIn?.[0]))?.has(reason)) : all
  const skipped = packages.flatMap((pkg) => {
    const because = unaudited(pkg)
    return because === undefined ? [] : [{ ...pkg, because }]
  })
  const asked = packages.filter((pkg) => unaudited(pkg) === undefined)
  // Under --reason, the npm packages its consumer didn't record, and those `lockfile` locks alone, each
  // once, by keyOf: none asked about already.
  const keyOfPkg = (pkg) => keyOf(pkg, pkg.version)
  const own = new Set(packages)
  const byKey = new Map(all.filter((pkg) => !own.has(pkg) && pkg.ecosystem === 'npm' && unaudited(pkg) === undefined).map((pkg) => [keyOfPkg(pkg), pkg]))
  const askedKeys = new Set(asked.map(keyOfPkg))
  const lockedOnly = new Map() // keyOf -> the names of the lockfiles alone locking it
  for (const one of lockfile === null ? [] : [lockfile].flat()) {
    const named = one.name ?? one.path.split(/[/\\]/u).at(-1)
    for (const { name, version } of one.packages) {
      const pkg = { ecosystem: 'npm', name, version }
      const key = keyOfPkg(pkg)
      if (askedKeys.has(key) || (byKey.has(key) && !lockedOnly.has(key))) continue
      byKey.set(key, pkg)
      lockedOnly.set(key, (lockedOnly.get(key) ?? new Set()).add(named))
    }
  }
  const others = [...byKey.values()]
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
  const vendoredOf = (list) => new Map(list.filter((pkg) => pkg.vendoredIn !== undefined).map((pkg) => [keyOfPkg(pkg), pkg]))
  // npm's registry's malware advisories (`registry` rows, not OSV's records), of every npm dependency, by
  // their consumers, or the names of the lockfiles alone locking them.
  const malware = [...result, ...elsewhere].filter((adv) => adv.malware && adv.source === 'registry')
  const npmMalware = malware.length === 0 ? [] : flattenAdvisories(malware, new Map([...indexed().byPkg, ...lockedOnly]), null, null, vendoredOf([...asked, ...others]))
  // --why's chains REPLACE the consumers of npm's advisories, searched for only the packages that carry one.
  let whyByPkg = null
  if (why) {
    const targetKeys = new Set(result.filter((adv) => adv.ecosystem === 'npm').flatMap((adv) => adv.versions.map((v) => keyOf(adv, v))))
    whyByPkg = collectWhy(files, targetKeys, reason, { deep: whyDeep, full: whyFull, consumerName: indexed().name })
  }
  const rows = flattenAdvisories(result, indexed().byPkg, whyByPkg, reason, vendoredOf(asked))
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
// repository's advisories, or OSV. Packagist's, which stands for an advisory only where OSV has no
// record of it, has no icon.
const SOURCE_LOGOS = { registry: 'npm', repository: 'github', osv: 'osv' }
// The cells an icon covers: two, as sixel.js logos() picks icons no wider than two of the terminal's cells.
const ICON_CELLS = 2
// An icon, drawn with the cursor saved and put back, as a terminal may leave it below the image, then
// moved past the cells it covers, as text written over them would erase it.
const drawIcon = (icon) => `\x1b7${icon}\x1b8\x1b[${ICON_CELLS}C`
// Written before a line with an icon: two lines below it, then back up. A terminal moving the cursor
// below the image then never scrolls, which would put the cursor back a line off.
const ROOM_BELOW = '\n\n\x1b[2A'

// The advisories as a table on `out`, fitted to `width` (the terminal's) by wrapping its long columns, after
// `notes` on `err`; on `err`, the packages not audited, then the summary, last. In colour where each stream
// takes colours (`colors`, else takesColors). With `icons` (sixel.js logos()'s, true for its 16-pixel ones), each id has its source's.
export function printAuditReport({ packages, skipped = [], rows, npmMalware = [], why = false, reason = null }, { out = process.stdout, err = process.stderr, colors, width = out.isTTY ? out.columns : undefined, icons: given = false, notes = [] } = {}) {
  const icons = given === true ? logos() : given || null
  const paintOut = painter(out, colors)
  const paintErr = painter(err, colors)
  const coloredOut = colors ?? takesColors(out)
  const coloredErr = colors ?? takesColors(err)
  for (const note of notes) err.write(`${paintErr('yellow', note)}\n`)
  const scanned = `Scanned ${packages.length} package${packages.length === 1 ? '' : 's'}${reason ? ` recorded by ${reason}` : ''}`
  if (packages.length === 0) {
    err.write(`${scanned}\n${paintErr('yellow', reason ? `No dependencies recorded by ${reason}` : 'No dependencies found in the input files')}\n`)
    printMalware(npmMalware, err, paintErr, coloredErr)
    return
  }
  if (rows.length > 0) {
    // The ecosystem column only where one is not npm's, which the others were all once.
    const columns = ['severity', ...(rows.some((r) => r.ecosystem !== 'npm') ? ['ecosystem'] : []), 'package', 'installed', 'vulnerable', 'title', 'id']
    // The reason column where some advisory has one, but not under --reason without --why, where every
    // cell is that consumer.
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

// audit()'s `npmMalware`, after the summary, apart from the table: each advisory a line, its package and
// version, id and title, and the consumers that recorded it.
function printMalware(rows, err, paint, colored) {
  if (rows.length === 0) return
  const packages = new Set(rows.map((row) => `${row.package}@${row.installed}`)).size
  const names = rows.map((row) => `${row.package} ${row.installed}`)
  const pad = (list) => Math.max(...list.map((text) => text.length))
  const [nameWidth, idWidth, titleWidth] = [pad(names), pad(rows.map((row) => row.id)), pad(rows.map((row) => row.title))]
  const lines = rows.map((row, i) => `  ${names[i].padEnd(nameWidth)}  ${row.id.padEnd(idWidth)}  ${row.reason ? `${row.title.padEnd(titleWidth)}  ${paint(DIM, row.reason)}` : row.title}`)
  err.write(`\n${paint(SEVERITY_TONES.malware, badge('malware', 'malware', colored))} in ${packages} dependenc${packages === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}\n`)
}
