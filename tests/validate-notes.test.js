import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { printValidationReport } from '../stasis/src/validate.js'
import { LOCKFILE_ERRORS, OWN_REASONS, noteOf, noteText } from '../stasis/src/validate-notes.js'

const here = dirname(fileURLToPath(import.meta.url))

test('validate-notes: of no module, for a browser too', (t) => {
  const source = readFileSync(join(here, '..', 'stasis', 'src', 'validate-notes.js'), 'utf8')
  t.assert.ok(!/^\s*import\b|\bimport\(|\brequire\(|\bprocess\./mu.test(source), 'imports nothing, reads no process')
})

test('validate-notes: a package\'s note as parts, its paths apart, and as text', (t) => {
  const pkg = { ecosystem: 'npm', name: 'ms', version: '2.1.3', files: 1 }
  const notes = [
    [{ ...pkg, status: 'invalid', reason: 'misplaced', at: 'node_modules/ms' }, ['installed where its path or its lockfile names another package or version', ': ', { path: 'node_modules/ms' }]],
    [{ ...pkg, status: 'unverified', reason: 'something-new' }, ['something-new']],
    [{ ...pkg, status: 'invalid', patch: { hash: 'h', path: 'patches/ms@2.1.3.patch', error: 'patch-mismatch' } }, ['its patch', ' ', { path: 'patches/ms@2.1.3.patch' }, ' is not of the hash its lockfile locks']],
    [{ ...pkg, status: 'invalid', patch: { hash: 'h', error: 'patch-unsupported' } }, ['its patch', ' could not be applied (patch-unsupported)']],
    [{ ...pkg, status: 'valid', patch: { path: 'patches/ms@2.1.3.patch', from: 'bundle', verified: true, applied: false } }, ['locked patched, bundled as published', ' by ', { path: 'patches/ms@2.1.3.patch' }, ' (the bundle\'s, as the repository has it)']],
    [{ ...pkg, status: 'valid', patch: { hash: 'h', path: 'patches/ms.patch', from: 'repository', applied: true } }, ['patched', ' by ', { path: 'patches/ms.patch' }]],
    [{ ...pkg, status: 'valid', directory: 'packages/ms' }, ['held to ', { path: 'packages/ms' }, ' of the repository']],
    [{ ...pkg, status: 'valid' }, []],
  ]
  for (const [told, parts] of notes) t.assert.deepStrictEqual(noteOf(told), parts, JSON.stringify(told))
  t.assert.equal(noteText(notes[0][0]), 'installed where its path or its lockfile names another package or version: node_modules/ms')
  t.assert.equal(noteText(notes.at(-1)[0]), '')
})

test('printValidationReport: own code unverified, and the dependencies held to no lockfile, for the reasons a report tells', (t) => {
  const counts = { files: 2, own: 1, dependencies: 1, matched: 1, eol: 0, differs: 0, unexpected: 0, unverified: 1, skipped: 0, packages: 1, validPackages: 1, lockFailures: 0, misplaced: 0 }
  const report = { validatedAt: 0, status: 'incomplete', own: { checked: false, reason: 'commit-not-in-history' }, lockfiles: null, lockfileError: 'no-lockfile', counts, problems: [], moreProblems: 0, packages: [] }
  let err = ''
  printValidationReport(report, { out: { write: () => t.assert.fail('no table') }, err: { write: (chunk) => { err += chunk } }, colors: false })
  t.assert.deepStrictEqual(err.split('\n'), [
    'incomplete: 1 of 2 files as they should be, 0 differ, 0 unexpected, 1 unverified; 1 of 1 packages as published',
    `Own code not verified: ${OWN_REASONS['commit-not-in-history']}`,
    `Dependencies held to no lockfile (${LOCKFILE_ERRORS['no-lockfile']}): each to its registry's integrity alone`,
    '',
  ])
})
