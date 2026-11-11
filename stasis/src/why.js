import { entryDirOf, hasNodeModulesSegment, moduleFileKey, upsert } from '@exodus/stasis-core/util'
import { isEvidenceFile } from './audit-corrections.js'
import { parseFile } from './parse.js'

// The packages a module map records: every record as it is, and after a dependency's, each `vendored` copy in it
// as a record at its directory in the project, with its host's `ecosystem`, `vendoredIn` its host's dir, and the
// `files` it holds (each counted for the deepest entry), relative to it. A host keeps all its files.
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

// Cap on paths enumerated per target to bound pathological graphs (many diamond
// dependencies compound into a combinatorial number of simple paths). Hitting it
// is surfaced as a marker line rather than silently dropped.
const PATH_CAP = 2000

// Packages a chain never walks PAST: everything imports these build/runtime hubs, so a chain reaching one
// stops there, the hub its head (`@babel/core -> a -> b -> c`).
const TERMINAL_PACKAGES = new Set(['@babel/core', 'react-native', 'metro'])


const EMPTY_GRAPH = { adjRev: new Map(), srcImporters: new Map() }

// One artifact's index: each file's module dir (`fileToDir`), each dir's identity (`dirInfo`), and each dir's
// evidence files (`dirFiles`, audit-corrections.js), as collectReasons counts them. A copy a dependency ships
// (packageRecords) is a module of its own, so a chain can end at it, its files its host's evidence too.
function moduleIndex(artifact) {
  const fileToDir = new Map()
  const dirInfo = new Map()
  const dirFiles = new Map()
  for (const [dir, { name, version, files }] of packageRecords(artifact.modules)) {
    dirInfo.set(dir, { name: name ?? null, version: version ?? null, dep: hasNodeModulesSegment(dir) })
    const list = []
    for (const rel of Object.keys(files)) {
      const f = moduleFileKey(dir, rel)
      fileToDir.set(f, dir)
      if (isEvidenceFile(name ?? null, version ?? null, rel)) list.push(f)
    }
    dirFiles.set(dir, list)
  }
  return { fileToDir, dirInfo, dirFiles }
}

// Flatten the imports graph (conditions -> parent -> specifier -> target) into
// deduped file-level edges [parentFile, targetFile]. A `--metro` target may be a
// { platform: file } map; each platform's file becomes its own edge.
function fileEdges(imports) {
  const edges = new Map()
  for (const [, byParent] of imports) {
    for (const [parent, specifiers] of byParent) {
      for (const [, target] of specifiers) {
        for (const t of target instanceof Map ? target.values() : [target]) edges.set(`${parent}\0${t}`, [parent, t])
      }
    }
  }
  return edges.values()
}

// Per-consumer subgraphs ('' the whole graph where there is no reason map): a consumer has an edge only where
// it recorded the importing file. `adjRev`: dep dir -> the dep dirs importing it; `srcImporters`: dep dir ->
// the src files importing it. Intra-module edges and edges into src are dropped.
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

// Invert the reason map to file -> Set(consumer), each consumer by `name(consumer)` (as it is, by
// default). null when the artifact carries no reason map (single-consumer bundle / lockfile) ->
// chains render bare.
export function invertReason(reason, name = (consumer) => consumer) {
  if (!reason) return null
  const byFile = new Map()
  for (const [consumer, list] of Object.entries(reason)) {
    if (!Array.isArray(list)) continue
    for (const f of list) upsert(byFile, f, () => new Set()).add(name(consumer))
  }
  return byFile
}

// dir -> the consumers that recorded any of its evidence files (moduleIndex's `dirFiles`), or null where
// there is no reason map: whether a target belongs to a reason that never imports it.
function dirReasonsIndex(dirFiles, fileReasons) {
  if (fileReasons === null) return null
  const byDir = new Map()
  for (const [dir, files] of dirFiles) {
    let set
    for (const f of files) for (const c of fileReasons.get(f) ?? []) (set ??= new Set()).add(c)
    if (set !== undefined) byDir.set(dir, set)
  }
  return byDir
}

// Every simple path of `adjRev` ending at `targetDir`, head first, emitted where its head is a HEAD (`isHead`)
// or a terminal package, which the walk never climbs past (a terminal target is emitted bare). `truncated`
// where PATH_CAP cut it short.
function pathsTo(adjRev, isHead, isTerminal, targetDir) {
  const results = []
  let truncated = false
  const walk = (node, suffix, inPath) => {
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
      walk(pred, [pred, ...suffix], inPath)
      inPath.delete(pred)
    }
  }
  walk(targetDir, [targetDir], new Set([targetDir]))
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

  // A chain's full suffix's head group renders before the chain's.
  const keys = new Set(chains.map((c) => chainKey(c)))
  const succ = new Map([...byHead.keys()].map((h) => [h, new Set()]))
  const indeg = new Map([...byHead.keys()].map((h) => [h, 0]))
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) {
      if (!keys.has(chainKey(c, i))) continue
      const suffixHead = c[i]
      if (suffixHead === c[0] || succ.get(suffixHead).has(c[0])) continue
      succ.get(suffixHead).add(c[0])
      indeg.set(c[0], indeg.get(c[0]) + 1)
    }
  }

  const maxLen = new Map([...byHead].map(([h, g]) => [h, Math.max(...g.map((c) => c.length))]))
  const prefer = (a, b) => maxLen.get(a) - maxLen.get(b) || a.localeCompare(b)
  const remaining = new Set(byHead.keys())
  const out = []
  while (remaining.size > 0) {
    const free = [...remaining].filter((h) => indeg.get(h) === 0)
    // No free head means a constraint cycle -- break it by preference.
    const head = (free.length > 0 ? free : [...remaining]).toSorted(prefer)[0]
    remaining.delete(head)
    for (const s of succ.get(head)) indeg.set(s, indeg.get(s) - 1)
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
    let at = -1
    for (let i = 1; c.length - i >= 3; i++) {
      if (revealed.has(chainKey(c, i))) {
        at = i
        break
      }
    }
    out.add(at === -1 ? renderChain(c) : `${renderChain(c.slice(0, at + 1))} -> ... -> ${target}`)
    // Every sub-path headed by a node this line shows is now recoverable.
    const visible = at === -1 ? c.length - 1 : at
    for (let i = 0; i <= visible; i++) revealed.add(chainKey(c, i))
  }
  return [...out]
}

// Without --why-deep, drop a chain when another in its bucket is a full proper suffix of it: the suffix's
// line already explains the pull-in. Chains that merely share a tail both stay, for compressChains.
function dropSuffixed(chains) {
  const keys = new Set(chains.map((c) => chainKey(c)))
  return chains.filter((c) => !c.keys().drop(1).some((i) => keys.has(chainKey(c, i))))
}

// Each targeted package (`name@version`: `targetKeys`', else every dependency) -> its --why lines, `consumer:
// chain`, a bare chain where there is no reason map; only `reasonFilter`'s, where given. Chains are pruned
// (dropSuffixed) unless `deep`, and compressed (compressChains) unless `full`. Consumers by `consumerName`.
export function collectWhy(files, targetKeys, reasonFilter = null, { deep = false, full = false, consumerName } = {}) {
  // key -> reason bucket ('' = unattributed) -> Map(chainKey -> node-name array)
  const acc = new Map()
  const truncatedKeys = new Set()
  const addChain = (key, bucket, nodes) => upsert(upsert(acc, key, () => new Map()), bucket, () => new Map()).set(chainKey(nodes), nodes)

  for (const file of files) {
    const artifact = parseFile(file)
    if (!artifact.imports || artifact.imports.size === 0) continue

    const { fileToDir, dirInfo, dirFiles } = moduleIndex(artifact)
    const fileReasons = invertReason(artifact.reason, consumerName)
    const graphs = bucketGraphs(fileEdges(artifact.imports), fileToDir, dirInfo, fileReasons)
    const dirReasons = dirReasonsIndex(dirFiles, fileReasons)
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
        // The consumers that recorded the package itself (collectReasons'), each with its own subgraph's
        // maximal chains, a bare line where it never imports it. One that imports it unrecorded is no reason.
        const own = fileReasons === null ? [''] : (dirReasons.get(targetDir) ?? [])
        for (const bucket of own) {
          if (reasonFilter !== null && bucket !== reasonFilter) continue
          const { adjRev, srcImporters } = graphs.get(bucket) ?? EMPTY_GRAPH
          // A head tops a chain: a src file imports it directly, or nothing else
          // in this bucket's graph imports it.
          const isHead = (node) => srcImporters.has(node) || !adjRev.has(node)
          const { results, truncated } = pathsTo(adjRev, isHead, isTerminal, targetDir)
          if (truncated) truncatedKeys.add(key)
          for (const p of results) addChain(key, reasonFilter !== null ? '' : bucket, p.map((d) => dirInfo.get(d)?.name ?? d))
        }
      }
    }
  }

  // Each bucket pruned, then compressed or spelled out whole; buckets sorted, so bare '' first.
  const byPkg = new Map()
  for (const [key, buckets] of acc) {
    const lines = []
    for (const bucket of [...buckets.keys()].toSorted((a, b) => a.localeCompare(b))) {
      let chains = [...buckets.get(bucket).values()]
      if (!deep) chains = dropSuffixed(chains)
      for (const rendered of (full ? orderChains(chains).map(renderChain) : compressChains(chains))) {
        lines.push(bucket ? `${bucket}: ${rendered}` : rendered)
      }
    }
    if (truncatedKeys.has(key)) lines.push(`… (${PATH_CAP}+ paths, truncated)`)
    byPkg.set(key, lines)
  }
  return byPkg
}
