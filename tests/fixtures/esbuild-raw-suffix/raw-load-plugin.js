import { readFile } from 'node:fs/promises'

// Loads a `?raw` module as its source text.
export default {
  name: 'raw-load',
  setup(build) {
    build.onLoad({ filter: /$/, namespace: 'file' }, async (args) => (args.suffix === '?raw' ? { contents: await readFile(args.path), loader: 'text' } : undefined))
  },
}
