import { ARCHIVED } from '@exodus/stasis-core/util'

import { readStasisTgz } from './parse.js'

// `stasis run` preloads this before the loader: State reads a .stasis.tgz bundle's bytes as any bundle's, and reads its
// tar through it, which stasis-core (importing nothing) can't.
globalThis[ARCHIVED] = (bytes, path) => readStasisTgz(bytes, path).artifact
