import { ARCHIVED } from '@exodus/stasis-core/util'

import { readStasisTgz, writeStasisTgz } from './parse.js'

// `stasis run` preloads this before the loader, and `stasis add` imports it: State and add read and write a .stasis.tgz
// bundle's bytes as any bundle's, and its tar through these, which stasis-core (importing nothing) can't.
globalThis[ARCHIVED] = { read: (bytes, path) => readStasisTgz(bytes, path).artifact, write: writeStasisTgz }
