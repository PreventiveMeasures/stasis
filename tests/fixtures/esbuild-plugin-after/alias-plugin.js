import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `@app/<name>` -> src/<name>.js, registered for the file namespace only (as many plugins are), with
// pluginData as resolver metadata that no loader reads.
const src = join(dirname(fileURLToPath(import.meta.url)), 'src')
export default {
  name: 'alias',
  setup(build) {
    build.onResolve({ filter: /^@app\//, namespace: 'file' }, (args) => ({ path: join(src, `${args.path.slice('@app/'.length)}.js`), pluginData: { alias: true } }))
  },
}
