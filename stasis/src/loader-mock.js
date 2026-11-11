// `--mock`'s loader, in load-bearing order: the hooks lib, snapshotting stasis's own fs bindings off the real builtins;
// ./mock.js, mocking them for user code; then install(), so mock.js neither goes through the hooks nor is the entry.
import { install } from '@exodus/stasis-core/hooks'
// `export *` (mock.js has no exports), not a bare import, for the no-unassigned-import lint rule.
export * from './mock.js'

install()
