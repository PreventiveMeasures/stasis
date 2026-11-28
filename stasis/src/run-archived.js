import { ARCHIVED } from '@exodus/stasis-core/util'
import { archived } from '@exodus/stasis-plugins/archived'

// `stasis run` preloads this before the loader, and `stasis add` imports it: State and add read and write a .stasis.tgz
// bundle's bytes as any bundle's, and its tar through stasis-plugins' archived.js (as a plugin's State does where
// nothing registered it), which stasis-core (importing nothing) can't.
globalThis[ARCHIVED] = archived
