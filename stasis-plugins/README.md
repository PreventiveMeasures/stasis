# <img src="/stasis/logo.svg" alt="" width="39" height="39" valign="bottom" /> `@exodus/stasis-plugins`

Bundler plugins (webpack, esbuild, Rollup, Metro) for `@exodus/stasis-core`.

The esbuild plugin parses the files it serves with [`oxc-parser`](https://www.npmjs.com/package/oxc-parser), an optional peer dependency:
install it to build packages that set a `package.json` `type`. The other plugins don't need it.

See main package [GitHub](https://github.com/ExodusOSS/stasis/tree/main/stasis) or [npm](https://npmjs.com/package/@exodus/stasis) for full README.

## License

[MIT](./LICENSE)
