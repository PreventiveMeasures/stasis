// `stasis build --metro=PLATFORM`: a Metro asset (a resource a --metro bundle reaches through an import)
// built into the module Metro builds of it, and copied out as `react-native bundle --assets-dest` copies
// it, from the bytes the artifact carries -- never from disk.
//
// Metro builds `require('./img/logo.png')` into (metro-transform-worker's assetTransformer, Metro's
// getAssetData and generateAssetCodeFileAst):
//
//   module.exports = require('react-native/Libraries/Image/AssetRegistry').registerAsset({
//     __packager_asset: true, httpServerLocation: '/assets/img', width, height,
//     scales: [1, 2, 3], hash, name: 'logo', type: 'png' })
//
// from every file of the asset in its directory (each scale, `logo@2x.png`; those for the platform,
// `logo.ios.png`, where it has any): their scales, an md5 over their bytes, and the first one's image
// dimensions over its scale. That reading of an asset and the module built of it are @preventive/rn's
// (assetData, assetModule), as is where --assets-dest copies its files (assetsDestFiles). What stays
// here is the asset registry the module requires: React Native's Metro config's `assetRegistryPath`
// (@react-native/metro-config's), the one `stasis bundle --metro` carries for an asset. A project's
// own `assetRegistryPath`, `publicPath` (Metro's default `/assets` here) and `assetPlugins` are read off
// its Metro config, which is code, and aren't.
import { posix } from 'node:path'

import { METRO_SOURCE_EXTS } from './resolve-fields.js'

// The asset registry the module Metro builds of an asset requires: React Native's Metro config's
// `assetRegistryPath` (@react-native/metro-config's), where a project's own isn't read, being code.
// `stasis bundle --metro` carries the file it resolves to for each asset.
export const ASSET_REGISTRY = 'react-native/Libraries/Image/AssetRegistry'

// The resolver of `ASSET_REGISTRY` from an asset for `platform`, as Metro resolves it, among `carried`
// (the code files the artifact carries: a Map or Set keyed by their paths from the project root): the
// copy of react-native in the nearest node_modules up from the asset's directory, else the only copy
// (pnpm's, linked in from node_modules/.pnpm); in it, the file Metro probes first -- each of its
// sourceExts, the platform's file, then the .native one, then the plain one. The copies are found once.
// -> (rel) => its path, throwing where the artifact carries none, or several none of them nearest
const REGISTRY_ROOT = /^((?:.*\/)?node_modules\/react-native)\/Libraries\/Image\/AssetRegistry\./u
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
  const roots = new Set([...carried.keys()].map((file) => REGISTRY_ROOT.exec(file)?.[1]).filter((root) => root !== undefined && pick(root) !== undefined))
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
