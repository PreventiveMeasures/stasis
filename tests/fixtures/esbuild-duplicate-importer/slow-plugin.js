import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Holds up the first copy's resolution of ./b.js (the one StasisEsbuild makes before declining), so
// the second copy's import of it is resolved and loaded while that one is still in flight. A copy
// with pluginData `tagged` gets ./b-tagged.js instead.
const src = join(dirname(fileURLToPath(import.meta.url)), 'src')
let held = false
export default {
  name: 'slow-first',
  setup(build) {
    build.onResolve({ filter: /^\.\/b\.js$/ }, async (args) => {
      if (args.pluginData?.tagged) return { path: join(src, 'b-tagged.js') }
      if (held) return undefined
      held = true
      await new Promise((settle) => setTimeout(settle, 1000))
      return undefined
    })
  },
}
