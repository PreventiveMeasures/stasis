import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// `<path>?dup` / `<path>?tagged` -> the file at <path>, suffix kept: esbuild loads the file a second
// time, as its own module. This plugin loads that copy itself, a little later (so its imports come
// second), as is for `?dup` and with pluginData for `?tagged`.
export default {
  name: 'copy-suffix',
  setup(build) {
    build.onResolve({ filter: /\?(?:dup|tagged)$/ }, (args) => {
      const at = args.path.lastIndexOf('?')
      return { path: resolve(args.resolveDir, args.path.slice(0, at)), suffix: args.path.slice(at) }
    })
    build.onLoad({ filter: /$/, namespace: 'file' }, async (args) => {
      if (args.suffix !== '?dup' && args.suffix !== '?tagged') return undefined
      await new Promise((settle) => setTimeout(settle, 200))
      const contents = await readFile(args.path)
      return args.suffix === '?tagged' ? { contents, loader: 'js', pluginData: { tagged: true } } : { contents, loader: 'js' }
    })
  },
}
