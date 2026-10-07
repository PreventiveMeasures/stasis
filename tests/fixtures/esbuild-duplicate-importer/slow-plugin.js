// Holds up the first copy's resolution of ./b.js (the one StasisEsbuild makes before declining), so
// the second copy's identical import is resolved and loaded while that one is still in flight.
let held = false
export default {
  name: 'slow-first',
  setup(build) {
    build.onResolve({ filter: /^\.\/b\.js$/ }, async (args) => {
      if (args.pluginData?.dup || held) return undefined
      held = true
      await new Promise((settle) => setTimeout(settle, 1000))
      return undefined
    })
  },
}
