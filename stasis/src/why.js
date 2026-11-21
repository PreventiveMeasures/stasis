import { entryDirOf, hasNodeModulesSegment, moduleFileKey, nestedMap, upsert } from '@exodus/stasis-core/util'
import { isEvidenceFile } from './audit-corrections.js'
import { parseFile } from './parse.js'

// Every record of a module map, and after a dependency's, each `vendored` copy in it as a record at its directory,
// with its host's `ecosystem`, `vendoredIn` its host's dir, and the `files` it holds. A host keeps all its files.
export function* packageRecords(modules) {
  for (const [dir, record] of modules) {
    yield [dir, record]
    if (record.vendored === undefined) continue
    const held = new Map()
    for (const rel of Object.keys(record.files)) {
      const sub = entryDirOf(record.vendored, rel)
      if (sub === undefined) continue
      // A descriptor, so a contents-free bundle's locked values stay unread.
      Object.defineProperty(upsert(held, sub, () => Object.create(null)), rel.slice(sub.length + 1), Object.getOwnPropertyDescriptor(record.files, rel))
    }
    for (const [sub, files] of held) {
      const { name, version } = record.vendored[sub]
      yield [moduleFileKey(dir, sub), { name, version, ecosystem: record.ecosystem, vendoredIn: dir, files }]
    }
  }
}

// `stasis audit --why`: the import chains (`a -> b -> c`) by which each consumer that recorded a flagged package
// reaches it, on its own file-level subgraph, climbing to a HEAD: a package src imports, or one nothing in
// node_modules does. An edge into a file that is no evidence of real code (audit-corrections.js) is none.

// Diamond dependencies compound into a combinatorial number of simple paths; a cut is marked, not silently dropped.
const PATH_CAP = 2000

// Build/runtime hubs everything imports: a chain reaching one stops there, the hub its head.
const TERMINAL_PACKAGES = new Set(['@babel/core', 'react-native', 'metro'])

const EMPTY_GRAPH = { adjRev: new Map(), srcImporters: new Map() }

// Each dir's evidence files (`evidence`) as collectReasons counts them. A copy a dependency ships is a module of its
// own, so a chain can end at it, its files its host's evidence too.
function moduleIndex(artifact) {
  const fileToDir = new Map()
  const dirInfo = new Map()
  for (const [dir, { name, version, files }] of packageRecords(artifact.modules)) {
    const evidence = new Set()
    for (const rel of Object.keys(files)) {
      const f = moduleFileKey(dir, rel)
      fileToDir.set(f, dir)
      if (isEvidenceFile(name ?? null, version ?? null, rel)) evidence.add(f)
    }
    dirInfo.set(dir, { name: name ?? null, version: version ?? null, dep: hasNodeModulesSegment(dir), evidence })
  }
  return { fileToDir, dirInfo }
}

// [parentFile, targetFile] edges, repeats and all (bucketGraphs' sets keep one); a `--metro` target may be a { platform: file } map.
function* fileEdges(imports) {
  for (const [, byParent] of imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [, target] of specifiers) {
        for (const t of target instanceof Map ? target.values() : [target]) yield [parent, t]
      }
    }
  }
}

// Per-consumer subgraphs ('' the whole graph where there is no reason map), an edge a consumer's where it recorded
// the importing file: `adjRev` dep dir -> the dep dirs importing it, `srcImporters` dep dir -> the src files.
function bucketGraphs(edges, fileToDir, dirInfo, fileReasons) {
  const graphs = new Map()
  for (const [pf, tf] of edges) {
    const pd = fileToDir.get(pf)
    const td = fileToDir.get(tf)
    if (pd === undefined || td === undefined || pd === td) continue
    const tdi = dirInfo.get(td)
    if (!tdi.dep) continue
    // A manifest read (react-native scans its siblings' for Haste) or a corrected file (ws's noop
    // browser.js) is no dependency on the module: no chain may end at or pass through one.
    if (!isEvidenceFile(tdi.name, tdi.version, tf.slice(td.length + 1))) continue
    const buckets = fileReasons === null ? [''] : (fileReasons.get(pf) ?? [])
    const dep = dirInfo.get(pd).dep
    for (const bucket of buckets) {
      const graph = upsert(graphs, bucket, () => ({ adjRev: new Map(), srcImporters: new Map() }))
      upsert(dep ? graph.adjRev : graph.srcImporters, td, () => new Set()).add(dep ? pd : pf)
    }
  }
  return graphs
}

// file -> Set(consumer), or null without a reason map (a single-consumer bundle, a lockfile): chains render bare.
export function invertReason(reason, name = (consumer) => consumer) {
  if (!reason) return null
  const byFile = new Map()
  for (const [consumer, list] of Object.entries(reason)) {
    if (!Array.isArray(list)) continue
    for (const f of list) upsert(byFile, f, () => new Set()).add(name(consumer))
  }
  return byFile
}

// Every simple path of `adjRev` ending at `targetDir`, head first, where its head is a HEAD or a terminal package,
// which the walk never climbs past.
function pathsTo(adjRev, isHead, isTerminal, targetDir) {
  const results = []
  let truncated = false
  const inPath = new Set([targetDir])
  const walk = (node, suffix) => {
    if (results.length >= PATH_CAP) {
      truncated = true
      return
    }
    const terminal = isTerminal(node)
    if (isHead(node) || terminal) results.push(suffix)
    if (terminal) return
    for (const pred of adjRev.get(node) ?? []) {
      if (inPath.has(pred)) continue // no repeated module -> break cycles
      inPath.add(pred)
      walk(pred, [pred, ...suffix])
      inPath.delete(pred)
    }
  }
  walk(targetDir, [targetDir])
  return { results, truncated }
}

// A chain (node names, head first) from index `i` on, as a lookup key; and as a display line.
const chainKey = (c, i = 0) => c.slice(i).join('\0')
const renderChain = (c) => c.join(' -> ')

// One bucket's chains in display order: a full suffix of another first (`B -> C` before `A -> B -> C`), chains
// sharing a prefix contiguous, sibling groups by their longest chain, shortest first, then name. A suffix only orders
// head groups (all chains end at one target): a topological pass, a cycle's constraints broken by that preference.
function orderChains(chains) {
  if (chains.length <= 1) return chains

  // `list` shares its first `depth` nodes: group it by the node at `depth`, recursively.
  const arrange = (list, depth) => {
    if (list.length <= 1) return list
    return [...Map.groupBy(list, (c) => c[depth])]
      .map(([node, g]) => ({ node, g, max: Math.max(...g.map((c) => c.length)) }))
      .toSorted((a, b) => a.max - b.max || a.node.localeCompare(b.node))
      .flatMap(({ g }) => arrange(g, depth + 1))
  }

  const byHead = Map.groupBy(chains, (c) => c[0])

  // A chain's full suffix's head group renders before the chain's: the heads each head waits on.
  const keys = new Set(chains.map((c) => chainKey(c)))
  const after = new Map([...byHead.keys()].map((h) => [h, new Set()]))
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) if (c[i] !== c[0] && keys.has(chainKey(c, i))) after.get(c[0]).add(c[i])
  }

  const maxLen = new Map([...byHead].map(([h, g]) => [h, Math.max(...g.map((c) => c.length))]))
  const prefer = (a, b) => maxLen.get(a) - maxLen.get(b) || a.localeCompare(b)
  const remaining = new Set(byHead.keys())
  const out = []
  while (remaining.size > 0) {
    const free = [...remaining].filter((h) => after.get(h).isDisjointFrom(remaining))
    // No free head means a constraint cycle -- break it by preference.
    const head = (free.length > 0 ? free : [...remaining]).toSorted(prefer)[0]
    remaining.delete(head)
    out.push(...arrange(byHead.get(head), 1))
  }
  return out
}

// One bucket's chains, in orderChains' order, each collapsed at its earliest node whose sub-path to the
// target an earlier line shows (a line shows its nodes down to its collapse point), so `D -> C -> B -> A`
// then gives `P -> E -> D -> ... -> A`, then `Q -> E -> ... -> A`. Lines collapsing alike are emitted once.
function compressChains(chains) {
  const uniq = [...new Map(chains.map((c) => [renderChain(c), c])).values()]
  if (uniq.length <= 1) return uniq.map(renderChain)
  const sorted = orderChains(uniq)
  const target = sorted[0].at(-1)

  const revealed = new Set() // sub-paths recoverable from lines already emitted
  const out = new Set()
  for (const c of sorted) {
    // Collapse at the longest proper tail (>= 3 nodes, so one is hidden) an earlier line made recoverable.
    const at = c.keys().drop(1).find((i) => c.length - i >= 3 && revealed.has(chainKey(c, i)))
    out.add(at === undefined ? renderChain(c) : `${renderChain(c.slice(0, at + 1))} -> ... -> ${target}`)
    // Every sub-path headed by a node this line shows is now recoverable.
    for (let i = 0; i <= (at ?? c.length - 1); i++) revealed.add(chainKey(c, i))
  }
  return [...out]
}

// Without --why-deep, drop a chain when another in its bucket is a full proper suffix of it: the suffix's
// line already explains the pull-in. Chains that merely share a tail both stay, for compressChains.
function dropSuffixed(chains) {
  const keys = new Set(chains.map((c) => chainKey(c)))
  return chains.filter((c) => !c.keys().drop(1).some((i) => keys.has(chainKey(c, i))))
}

// Each package of `targetKeys` (`name@version`, else every dependency) -> its --why lines, `consumer: chain`, or a
// bare chain without a reason map. Pruned (dropSuffixed) unless `deep`, compressed (compressChains) unless `full`.
export function collectWhy(files, targetKeys, reasonFilter = null, { deep = false, full = false, consumerName } = {}) {
  // key -> reason bucket ('' unattributed) -> Map(chainKey -> node names)
  const acc = new Map()
  const truncatedKeys = new Set()
  const addChain = (key, bucket, nodes) => nestedMap(nestedMap(acc, key), bucket).set(chainKey(nodes), nodes)

  for (const file of files) {
    const artifact = parseFile(file)
    if (!artifact.imports || artifact.imports.size === 0) continue

    const { fileToDir, dirInfo } = moduleIndex(artifact)
    const fileReasons = invertReason(artifact.reason, consumerName)
    const graphs = bucketGraphs(fileEdges(artifact.imports), fileToDir, dirInfo, fileReasons)
    const isTerminal = (node) => TERMINAL_PACKAGES.has(dirInfo.get(node)?.name)

    // A package can be at several dirs (nested node_modules): their paths are unioned.
    const dirsByKey = new Map()
    for (const [dir, info] of dirInfo) {
      if (!info.dep || !info.name || !info.version) continue
      const key = `${info.name}@${info.version}`
      if (targetKeys && !targetKeys.has(key)) continue
      upsert(dirsByKey, key, () => []).push(dir)
    }

    for (const [key, dirs] of dirsByKey) {
      for (const targetDir of dirs) {
        // The consumers that recorded any of the package's own evidence files, as collectReasons': one importing it
        // unrecorded is none.
        const own = fileReasons === null ? [''] : new Set(dirInfo.get(targetDir).evidence.values().flatMap((f) => fileReasons.get(f) ?? []))
        for (const bucket of own) {
          if (reasonFilter !== null && bucket !== reasonFilter) continue
          const { adjRev, srcImporters } = graphs.get(bucket) ?? EMPTY_GRAPH
          const isHead = (node) => srcImporters.has(node) || !adjRev.has(node)
          const { results, truncated } = pathsTo(adjRev, isHead, isTerminal, targetDir)
          if (truncated) truncatedKeys.add(key)
          for (const p of results) addChain(key, reasonFilter !== null ? '' : bucket, p.map((d) => dirInfo.get(d)?.name ?? d))
        }
      }
    }
  }

  // Buckets sorted, so bare '' first.
  const byPkg = new Map()
  for (const [key, buckets] of acc) {
    const lines = [...buckets].toSorted(([a], [b]) => a.localeCompare(b)).flatMap(([bucket, found]) => {
      const chains = deep ? [...found.values()] : dropSuffixed([...found.values()])
      const rendered = full ? orderChains(chains).map(renderChain) : compressChains(chains)
      return bucket ? rendered.map((line) => `${bucket}: ${line}`) : rendered
    })
    byPkg.set(key, truncatedKeys.has(key) ? [...lines, `… (${PATH_CAP}+ paths, truncated)`] : lines)
  }
  return byPkg
}
