import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// `<path>?dup` -> the file at <path>, suffix kept: esbuild loads the file a second time, as its own
// module. This plugin loads that copy itself, a little later and tagged, so its imports come second.
export default {
  name: 'dup-suffix',
  setup(build) {
    build.onResolve({ filter: /\?dup$/ }, (args) => ({ path: resolve(args.resolveDir, args.path.slice(0, -'?dup'.length)), suffix: '?dup' }))
    build.onLoad({ filter: /$/, namespace: 'file' }, async (args) => {
      if (args.suffix !== '?dup') return undefined
      await new Promise((settle) => setTimeout(settle, 200))
      return { contents: await readFile(args.path), loader: 'js', pluginData: { dup: true } }
    })
  },
}
