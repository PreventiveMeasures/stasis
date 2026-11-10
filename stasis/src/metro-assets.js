// `stasis build --metro=PLATFORM`: a Metro asset (a resource a --metro bundle imports) built into the module Metro
// builds of it and copied out as `--assets-dest` copies it, from the artifact's bytes, never disk: @preventive/rn's
// assetData, assetModule and assetsDestFiles, but for the registry that module requires.
import { posix } from 'node:path'

import { METRO_SOURCE_EXTS } from './resolve-fields.js'

// The registry the module requires: React Native's Metro config's `assetRegistryPath`, which `stasis bundle
// --metro` carries for an asset. A project's own, its `publicPath` (Metro's default `/assets` here) and
// `assetPlugins` are read off its Metro config, which is code, and aren't.
export const ASSET_REGISTRY = 'react-native/Libraries/Image/AssetRegistry'

const REGISTRY_ROOT = /^((?:.*\/)?node_modules\/react-native)\/Libraries\/Image\/AssetRegistry\./u

// ASSET_REGISTRY's resolver from an asset for `platform`, as Metro resolves it, among the code files `carried` (a
// Map or Set by project path): in the react-native nearest up from the asset, else the only one (pnpm's), the file
// Metro probes first. -> (rel) => its path, throwing where the artifact carries none, or several none of them nearest
export function assetRegistryResolver(platform, carried) {
  const pick = (root) => {
    for (const ext of METRO_SOURCE_EXTS) {
      for (const suffix of [`.${platform}`, '.native', '']) {
        const file = `${root}/Libraries/Image/AssetRegistry${suffix}.${ext}`
        if (carried.has(file)) return file
      }
    }
    return undefined
  }
  const roots = new Set(carried.keys().map((file) => REGISTRY_ROOT.exec(file)?.[1]).filter((root) => root !== undefined && pick(root) !== undefined))
  const nearest = (rel) => {
    for (let dir = posix.dirname(rel); ; dir = posix.dirname(dir)) {
      const root = posix.join(dir, 'node_modules', 'react-native')
      if (posix.basename(dir) !== 'node_modules' && roots.has(root)) return root
      if (dir === '.' || dir === '/' || dir.startsWith('..')) return undefined
    }
  }
  return (rel) => {
    const root = roots.size === 1 ? [...roots][0] : nearest(rel)
    if (root !== undefined) return pick(root)
    if (roots.size === 0) {
      throw new Error(
        `stasis build: --metro builds '${rel}' into a module requiring ${ASSET_REGISTRY}, which the artifact doesn't carry; ` +
        'bundle it with `stasis bundle --metro --resources=...` from a project with react-native installed'
      )
    }
    throw new Error(`stasis build: --metro found several ${ASSET_REGISTRY} for '${rel}', none of them nearest: ${[...roots].join(', ')}`)
  }
}
