# Audit corrections

`stasis audit` audits a package only when an artifact records some of its real
code. A package recorded only through its manifest and a file with none of it,
such as `ws`'s `browser.js` (a stub that only throws), is skipped.
`@exodus/stasis/audit-corrections` lists those files as plain data, for other
tools to apply the same rule.

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

- `isEvidenceFile(name, version, file, ecosystem = 'npm')`: the rule
  `stasis audit` applies to every recorded file and import edge. A file is
  evidence unless it is a manifest of its ecosystem (`package.json` for npm,
  `Cargo.toml` for a crate, …) or a corrected file at a version in its range.
  `file` is relative to the package's directory.
- `CORRECTIONS`: a frozen array of plain data, one entry per corrected file,
  the objects the audit reads:

  ```js
  {
    ecosystem: 'npm',
    name: 'ws',
    file: 'browser.js',
    range: '<=8.22.0',
    integrity: ['sha512-98uE…', 'sha512-F7vx…'],
  }
  ```

  - `range`: the semver range the correction was verified for. A version
    outside it, or unparsable, is never corrected.
  - `integrity`: the sha512 of every distinct copy of `file` the versions in
    `range` publish, in a stasis lockfile's `sha512-<base64>` form, for a tool
    holding the file's bytes to check:

    ```js
    import { createHash } from 'node:crypto'

    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const verified = correction.integrity.includes(integrity)
    ```

## Changing a correction

A range is widened only after checking the file in every release it adds, from
its registry tarball held to its registry integrity; new copies go into
`integrity`, and the boundary tests in `tests/audit.test.js` move to the new
edge.
