// Child->root capture forwarding (--child-process). Content, listings, stat kinds and exec bits are re-derived from
// the root's OWN disk, so a shard can't inject content or a forged bit; `files` and `formats` are independent.

import { assertScope, isArtifactKey, KNOWN_FORMATS, assert, fileMapToObject, isPlainObject, objectToMaps } from './artifact-util.js'

export const SHARD_VERSION = 1

export function serializeShard({ scope, files, formats, imports }) {
  assertShard(files, formats, imports)
  return JSON.stringify({
    version: SHARD_VERSION,
    scope,
    files,
    formats: fileMapToObject(formats, { sorted: false }),
    imports: fileMapToObject(imports, { sorted: false }),
  })
}

// The upstream signature is what makes a shard trustworthy; this only guards a malformed message.
export function parseShard(text) {
  const json = JSON.parse(text)
  assert(isPlainObject(json), 'shard must be an object')
  assert(json.version === SHARD_VERSION, `shard version ${json.version} != ${SHARD_VERSION}`)
  assertScope(json.scope, 'shard')
  assert(Array.isArray(json.files), 'shard files must be an array')
  assert(isPlainObject(json.formats) && isPlainObject(json.imports), 'shard formats/imports must be objects')

  const formats = objectToMaps(json.formats)
  const imports = objectToMaps(json.imports)
  assertShard(json.files, formats, imports)
  return { scope: json.scope, files: json.files, formats, imports }
}

function assertShard(files, formats, imports) {
  for (const file of files) assertKey(file, 'shard file')
  for (const [file, format] of formats) {
    assertKey(file, 'shard format')
    assert(KNOWN_FORMATS.has(format), `shard format for ${file}: ${format}`)
  }
  for (const [, byParent] of imports) {
    assert(byParent instanceof Map, 'shard imports: expected a parent map')
    for (const [parent, specs] of byParent) {
      assertKey(parent, 'shard import parent')
      assert(specs instanceof Map, `shard imports for ${parent}: expected a specifier map`)
      // A file, or (--metro) a platform -> file map; nothing deeper.
      for (const [, target] of specs) {
        for (const file of target instanceof Map ? target.values() : [target]) assertKey(file, `shard import target from ${parent}`)
      }
    }
  }
}

const assertKey = (key, what) => assert(isArtifactKey(key), `${what}: ${key}`)
