// `node --import @exodus/stasis-core/loader`: evaluating it snapshots the lib's node:fs bindings before any patch.
import { install } from './hooks.js'

install()
