import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// `@text/<name>` -> src/<name>.js, tagged with pluginData for a later plugin to load as text.
const src = join(dirname(fileURLToPath(import.meta.url)), 'src')
export default {
  name: 'text-resolve',
  setup(build) {
    build.onResolve({ filter: /^@text\// }, (args) => ({ path: join(src, `${args.path.slice('@text/'.length)}.js`), pluginData: { text: true } }))
  },
}
