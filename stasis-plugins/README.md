# <img src="/stasis/logo.svg" alt="" width="39" height="39" valign="bottom" /> `@exodus/stasis-plugins`

Bundler plugins (webpack, esbuild, Rollup, Metro) for `@exodus/stasis-core`.

See main package [GitHub](https://github.com/ExodusOSS/stasis/tree/main/stasis) or [npm](https://npmjs.com/package/@exodus/stasis) for full README.

## A `.stasis.tgz` bundle

A plugin's `bundleFile` may name a [`.stasis.tgz`](https://github.com/PreventiveMeasures/stasis/blob/main/doc/file-formats.md#stasistgz),
as may `stasis.config.json`'s, and a `stasis.tgz` at the root is found as a
`stasis.code.br` is. With `bundle: 'load'` the build is served its files, held
to its `stasis.lock.json`, and with `'frozen'` disk is held to them, as
`stasis run` does; it is never written (`'add'` and `'replace'` are refused).

The plugins read its tar with `@preventive/archive`, as stasis does
(`@exodus/stasis-plugins/archived`), in each process a plugin or Metro's
transformer loads in, the transform workers too: nothing is to be imported or
preloaded for it. Under `stasis run`, they read it through the reader the run
preloads.

## License

[MIT](./LICENSE)
