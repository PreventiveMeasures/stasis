// stasis's `--mock` loader entry, its import order load-bearing: the core hooks lib first, snapshotting stasis's
// own fs bindings off the real builtins; then ./mock.js, mocking them for user code; only then install() the
// hooks, so mock.js never goes through them or becomes the bundle entry.
import { install } from '@exodus/stasis-core/hooks'
// `export *` (mock.js has no exports), not a bare import, for the no-unassigned-import lint rule.
export * from './mock.js'

install()
