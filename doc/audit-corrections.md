# Audit corrections

`stasis audit` audits a package only when an artifact records some of its real
code. Some packages ship a file that holds none of it, such as `ws`'s
`browser.js`, a stub that only throws. A package recorded only through such a
file, plus its manifest, is skipped: none of its code ships, so none of its
advisories apply.

Those files are listed as plain data in `@exodus/stasis/audit-corrections`.
Other tools can apply the same rule from that list instead of keeping their own
copy of it, for example one that reads bundles on a server, or one that walks a
tree `@preventive/deptree` laid out.

## What is corrected

| Package | File | What it is |
| --- | --- | --- |
| `ws` | `browser.js` | `module.exports = function () { throw new Error('ws does not work in the browser...') }` |
| `node-fetch` | `browser.js` | Re-exports the environment's own `fetch`, `Headers`, `Request` and `Response` |

The verified version ranges are in `CORRECTIONS`, in
[`stasis/src/audit-corrections.js`](../stasis/src/audit-corrections.js).

## Programmatic API (`@exodus/stasis/audit-corrections`)

```js
import { CORRECTIONS, isEvidenceFile } from '@exodus/stasis/audit-corrections'

isEvidenceFile('ws', '8.22.0', 'browser.js') // false: the stub
isEvidenceFile('ws', '8.22.0', 'lib/websocket.js') // true
isEvidenceFile('ws', '8.22.0', 'package.json') // false: a manifest
```

- `isEvidenceFile(name, version, file, ecosystem = 'npm')` is the rule
  `stasis audit` applies to every recorded file and import edge. A file is
  evidence unless it is a manifest of its ecosystem (`package.json` for npm,
  `Cargo.toml` for a crate, and so on) or a corrected file at a version in its
  range. `file` is relative to the package's directory.
- `CORRECTIONS` is a frozen array with one entry per corrected file, the very
  objects the audit reads. It holds plain data only, so `JSON.stringify` carries
  all of it:

  ```js
  {
    ecosystem: 'npm',
    name: 'ws',
    file: 'browser.js',
    range: '<=8.22.0',
    integrity: ['sha512-98uE…', 'sha512-F7vx…'],
  }
  ```

  - `range` is the semver range the correction was verified for. A version
    outside it, a pre-release the range leaves out, or a version that does not
    parse is never corrected, so the package stays audited.
  - `integrity` lists the sha512 of every distinct copy of `file` that the
    versions in `range` publish, in the `sha512-<base64>` form a stasis lockfile
    records a file in. A tool that holds the file's bytes can check that they
    are one of the copies verified. A version range alone cannot tell a real
    stub from other content put at the same path:

    ```js
    import { createHash } from 'node:crypto'

    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const verified = correction.integrity.includes(integrity)
    ```

## Changing a correction

A new release could change the file, so a range is widened only after checking
the file in every release the wider range adds, read from each release's
registry tarball and held to its registry integrity. Any new copy of the file
goes into `integrity`, and the boundary tests in `tests/audit.test.js` move to
the new edge of the range.
