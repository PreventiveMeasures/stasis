import { resolve } from 'node:path'

// `<path>?raw` -> the file at <path> with the suffix kept, for a later plugin to load.
export default {
  name: 'raw-resolve',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)), suffix: '?raw' }))
  },
}
