import { readFile } from 'node:fs/promises'

// Loads a `?raw` module, or one resolved with pluginData `text`, as its source text.
export default {
  name: 'raw-load',
  setup(build) {
    build.onLoad({ filter: /$/, namespace: 'file' }, async (args) => (args.suffix === '?raw' || args.pluginData?.text
      ? { contents: await readFile(args.path), loader: 'text' }
      : undefined))
  },
}
