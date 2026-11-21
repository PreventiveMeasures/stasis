import { readFileSync } from 'node:fs'

import { ARCHIVED } from '@exodus/stasis-core/util'

import { readStasisTgz } from './stasis-tgz.js'

// `stasis run` preloads this before the loader where --bundle-file names a .stasis.tgz, whose tar the loader's State
// can't read (it reads synchronously, importing nothing): it serves the bundle of the very bytes read here alone. One
// not there is left to State, as a stasis.code.br not there is.
const file = process.env.EXODUS_STASIS_BUNDLE_FILE
let bytes
try {
  bytes = readFileSync(file)
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
if (bytes !== undefined) {
  const { bundle } = await readStasisTgz(bytes, file)
  globalThis[ARCHIVED] = (read) => (Buffer.compare(read, bytes) === 0 ? bundle : undefined)
}
