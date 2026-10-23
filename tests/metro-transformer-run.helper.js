// Drives the StasisMetro worker transformer in isolation (Metro isn't installed):
// imports the transformer and calls it the way a Metro worker would, then prints what
// the wrapped base transformer received -- so the test can assert that load mode fed it
// the bundle-attested bytes rather than the on-disk bytes we hand in.
//
// Run with cwd = the project root, EXODUS_STASIS_* env describing the load State, and
// EXODUS_STASIS_METRO_BASE_TRANSFORMER pointing at tests/metro-mock-transformer.cjs.
//
// Usage:
//   node tests/metro-transformer-run.helper.js <project-relative-file> [...]
//       -> prints JSON [{ file, ...what the base transformer returned }, ...]
//   node tests/metro-transformer-run.helper.js --cache-key
//       -> prints the transformer's getCacheKey({})
// STASIS_TEST_DISK_BYTES -- the "on-disk" bytes handed to transform() (default: the file's own).
// STASIS_TEST_TRANSFORMER_CONFIG (JSON) -- Metro's transformer config handed to transform() (default {}).
// STASIS_TEST_PRELOAD=1 -- first construct the preload State a Metro worker has under
//   `stasis run --child-process`, from the same env.

import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: metro-transformer-run.helper.js <file> [...] | --cache-key')
  process.exit(2)
}

if (process.env.STASIS_TEST_PRELOAD === '1') {
  const { State } = await import('@exodus/stasis-core/state')
  new State(process.cwd(), { preload: true })
}

const t = await import('../stasis/src/metro-transformer.js')

if (args[0] === '--cache-key') {
  process.stdout.write(t.getCacheKey({}))
} else {
  const diskBytes = process.env.STASIS_TEST_DISK_BYTES
  const config = JSON.parse(process.env.STASIS_TEST_TRANSFORMER_CONFIG ?? '{}')
  // Mirror Metro's worker call: (config, projectRoot, filename, data, options),
  // filename project-relative, data = the bytes Metro read from disk. Promise.all
  // preserves argv order in the output.
  const out = await Promise.all(args.map(async (file) => {
    const data = diskBytes === undefined ? readFileSync(file) : Buffer.from(diskBytes)
    const result = await t.transform(config, process.cwd(), file, data, { dev: false, platform: 'ios' })
    return { file, ...result }
  }))
  process.stdout.write(JSON.stringify(out))
}
