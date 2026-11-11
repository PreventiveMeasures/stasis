import { compareVersions, valid } from '@preventive/upstream/semver.js'
import pkg from '../package.json' with { type: 'json' }

// An SPDX 2.3 or CycloneDX 1.5 SBOM of parsed artifacts, free of disk and brotli (the CLI's glue is src/cmd/sbom.js).

const DEFAULT_TOOL = { name: '@exodus/stasis', version: pkg.version, vendor: 'Exodus Movement, Inc.' }

const newUuid = () => globalThis.crypto.randomUUID()

// purl types we can mint: `soldeer` has no registered type, and `pkg:cargo` names crates.io's crate, which a
// crate vendored from git or from a source not known (`cargo-git`, `cargo-unknown`) may not be.
const PURL_TYPES = new Set(['npm', 'composer', 'cargo', 'github'])

// An artifact's ecosystem by its formats, PHP's Composer, any other npm: its untagged buckets', and every
// bucket's in an artifact predating the per-dependency `ecosystem` field.
const detectEcosystem = (artifact) => ([...(artifact.formats?.values?.() ?? [])].includes('php') ? 'composer' : 'npm')

// For a pre-`ecosystem` artifact: a dir is first-party outside a `node_modules` segment (`foo_node_modules/x` is),
// but in a Composer bundle, whose vendor packages live outside one.
function classifyScope(ecosystem, dir) {
  if (dir === '.') return 'workspace'
  if (ecosystem === 'composer') return 'dependency'
  return dir.split('/').includes('node_modules') ? 'dependency' : 'workspace'
}

// The purl/CycloneDX namespace (group): an npm scope, a Composer vendor or a GitHub owner.
function splitName(ecosystem, name) {
  const namespaced = ecosystem === 'composer' || ecosystem === 'github' || (ecosystem === 'npm' && name.startsWith('@'))
  const slash = name.indexOf('/')
  if (!namespaced || slash === -1) return { group: undefined, name }
  return { group: name.slice(0, slash), name: name.slice(slash + 1) }
}

// A Package URL (purl), or null for an ecosystem with no purl type: each segment percent-encoded (npm's `@`
// scope -> `%40`), Composer and GitHub names lowercased, per the purl spec; with no version, a bare-name purl.
export function buildPurl(ecosystem, rawName, version) {
  if (!PURL_TYPES.has(ecosystem)) return null
  let { group, name } = splitName(ecosystem, rawName)
  if (ecosystem === 'composer' || ecosystem === 'github') {
    group = group?.toLowerCase()
    name = name.toLowerCase()
  }
  const namespace = group ? `${encodeURIComponent(group)}/` : ''
  const at = version == null ? '' : `@${encodeURIComponent(version)}`
  return `pkg:${ecosystem}/${namespace}${encodeURIComponent(name)}${at}`
}

function compareComponents(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  // As '': comparing raw undefined would be order-unstable.
  const [av, bv] = [a.version ?? '', b.version ?? '']
  if (av !== bv) {
    if (valid(av) && valid(bv)) return compareVersions(av, bv)
    return av < bv ? -1 : 1
  }
  return a.ecosystem < b.ecosystem ? -1 : a.ecosystem > b.ecosystem ? 1 : 0
}

// The artifacts' named packages, deduped by ecosystem+name+version and sorted: a dependency only with a version,
// a first-party one ('workspace' where any artifact has it so) with or without. A dependency's `vendored` copies
// ride on it, by `dir`, a purl only beside a version (Next.js's React copy, `react-builtin`, names no release).
export function collectComponents(artifacts) {
  const seen = new Map()
  for (const artifact of artifacts) {
    const records = [...artifact.modules]
    // An artifact where no bucket carries `ecosystem` predates the field: classifyScope tells deps apart.
    const tagged = records.some(([, m]) => m.ecosystem !== undefined)
    const fileEcosystem = detectEcosystem(artifact)
    for (const [dir, { name, version, ecosystem, vendored }] of records) {
      if (!name) continue
      const eco = ecosystem ?? fileEcosystem
      const scope = ecosystem !== undefined ? 'dependency' : tagged ? 'workspace' : classifyScope(fileEcosystem, dir)
      if (!version && scope !== 'workspace') continue
      const key = `${eco} ${name} ${version ?? ''}`
      let component = seen.get(key)
      if (component) {
        if (scope === 'workspace') component.scope = 'workspace'
      } else {
        seen.set(key, component = { name, version: version ?? undefined, scope, ecosystem: eco, purl: buildPurl(eco, name, version) })
      }
      // Across artifacts, the union by directory; the first to list one names its package.
      for (const [sub, v] of Object.entries(vendored ?? {})) {
        component.vendored ??= new Map()
        if (component.vendored.has(sub)) continue
        component.vendored.set(sub, { dir: sub, name: v.name, version: v.version, ecosystem: eco, purl: v.version === undefined ? null : buildPurl(eco, v.name, v.version) })
      }
    }
  }
  for (const component of seen.values()) {
    if (component.vendored) component.vendored = [...component.vendored.values()].toSorted((a, b) => (a.dir < b.dir ? -1 : 1))
  }
  return [...seen.values()].toSorted(compareComponents)
}

// The component the SBOM is *about*: the lone workspace package, none with zero or several.
function selectPrimary(components) {
  const workspace = components.filter((c) => c.scope === 'workspace')
  const primary = workspace.length === 1 ? workspace[0] : null
  return { primary, rest: primary ? components.filter((c) => c !== primary) : components }
}

// RFC 3339 to whole seconds.
const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/u, 'Z')

// Unique by construction: the purl, else the dedup key.
const bomRef = (c) => c.purl ?? `${c.ecosystem}:${c.name}${c.version == null ? '' : `@${c.version}`}`

// An SPDX 2.3 document: it DESCRIBES its primary, which DEPENDS_ON each dependency (flat), else the workspace
// packages, else every package. A package vendored into a dependency comes after the rest, CONTAINED by that
// dependency, its directory there its `packageFileName`.
export function toSpdx(components, { tool = DEFAULT_TOOL, now = new Date(), uuid = newUuid() } = {}) {
  const { primary, rest } = selectPrimary(components)
  const ordered = primary ? [primary, ...rest] : components
  const ids = new Map(ordered.map((c, i) => [c, `SPDXRef-Package-${i}`]))

  const spdxPackage = (id, c, purpose, extra = {}) => ({
    SPDXID: id,
    name: c.name,
    ...(c.version == null ? {} : { versionInfo: c.version }),
    ...extra,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    ...(c.purl && {
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: c.purl }],
    }),
    primaryPackagePurpose: purpose,
  })
  const packages = ordered.map((c) => spdxPackage(ids.get(c), c, c.scope === 'workspace' ? 'APPLICATION' : 'LIBRARY'))
  const vendored = ordered.flatMap((c) => (c.vendored ?? []).map((v, i) => ({ host: c, v, id: `${ids.get(c)}-Vendored-${i}` })))
  for (const { v, id } of vendored) packages.push(spdxPackage(id, v, 'LIBRARY', { packageFileName: v.dir }))

  const relationships = []
  const relate = (spdxElementId, relatedSpdxElement, relationshipType) => relationships.push({ spdxElementId, relatedSpdxElement, relationshipType })
  if (primary) {
    relate('SPDXRef-DOCUMENT', ids.get(primary), 'DESCRIBES')
    for (const c of rest) if (c.scope === 'dependency') relate(ids.get(primary), ids.get(c), 'DEPENDS_ON')
  } else {
    const workspace = ordered.filter((c) => c.scope === 'workspace')
    for (const c of workspace.length > 0 ? workspace : ordered) relate('SPDXRef-DOCUMENT', ids.get(c), 'DESCRIBES')
  }
  for (const { host, id } of vendored) relate(ids.get(host), id, 'CONTAINS')

  const docName = primary
    ? (primary.version == null ? primary.name : `${primary.name}@${primary.version}`)
    : 'stasis-sbom'
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: docName,
    documentNamespace: `https://spdx.org/spdxdocs/${encodeURIComponent(docName)}-${uuid}`,
    creationInfo: {
      created: isoSeconds(now),
      creators: [`Tool: ${tool.name}-${tool.version}`, `Organization: ${tool.vendor}`],
    },
    packages,
    relationships,
  }
}

// A CycloneDX 1.5 document: the primary (workspace root) its metadata.component, the rest `components`, with a flat
// `dependencies` edge from it to each dependency. A package vendored into a dependency is nested in its `components`,
// its directory there the location of its one occurrence.
export function toCyclonedx(components, { tool = DEFAULT_TOOL, now = new Date(), uuid = newUuid() } = {}) {
  const { primary, rest } = selectPrimary(components)
  const component = (c, type, ref, tail) => {
    const { group, name } = splitName(c.ecosystem, c.name)
    return {
      type,
      'bom-ref': ref,
      ...(group && { group }),
      name,
      ...(c.version == null ? {} : { version: c.version }),
      ...(c.purl && { purl: c.purl }),
      ...tail,
    }
  }
  const toComponent = (c) => component(c, c.scope === 'workspace' ? 'application' : 'library', bomRef(c),
    c.vendored && { components: c.vendored.map((v) => toVendoredComponent(c, v)) })
  // Its bom-ref the host's with the directory as a purl subpath: two copies of one package (Next.js
  // has loader-utils2 and loader-utils3, both `loader-utils`) stay apart.
  const toVendoredComponent = (host, v) => component(v, 'library', `${bomRef(host)}#${v.dir}`, { evidence: { occurrences: [{ location: v.dir }] } })

  const doc = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: {
      timestamp: isoSeconds(now),
      // Not the flat tools array, deprecated in 1.5 and removed in 1.6.
      tools: { components: [{ type: 'application', publisher: tool.vendor, name: tool.name, version: tool.version }] },
      ...(primary && { component: toComponent(primary) }),
    },
    components: rest.map(toComponent),
  }
  if (primary) {
    const dependsOn = rest.filter((c) => c.scope === 'dependency').map(bomRef)
    doc.dependencies = [{ ref: bomRef(primary), dependsOn }]
  }
  return doc
}

// `options` { tool, now, uuid } for a custom identity or deterministic output.
export function generateSbom(format, components, options) {
  if (format === 'spdx') return toSpdx(components, options)
  if (format === 'cyclonedx') return toCyclonedx(components, options)
  throw new Error(`sbom: format must be spdx or cyclonedx, got ${format}`)
}

export function sbom(format, artifacts, options) {
  return generateSbom(format, collectComponents(artifacts), options)
}
