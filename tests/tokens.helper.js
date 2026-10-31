import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NPM_TOKEN_VARS } from '../stasis/src/cmd/tokens.js'

// The npm token variables of process.env, in NPM_TOKEN_VARS's order.
export const npmTokenVars = () => NPM_TOKEN_VARS.map((name) => process.env[name])

// process.env without any of NPM_TOKEN_VARS for the test `t`, and as it was after it.
export function withoutNpmTokenVars(t) {
  const saved = NPM_TOKEN_VARS.map((name) => [name, process.env[name]])
  for (const name of NPM_TOKEN_VARS) delete process.env[name]
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

// A home of its own, removed after the test `t`, whose ~/.npmrc is `npmrc` (a string, or bytes),
// and ~/.audit/config.json `audit` (a string, else as JSON), each where given. -> its path
export async function tokenHome(t, { npmrc, audit } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'stasis-tokens-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  if (npmrc !== undefined) await writeFile(join(home, '.npmrc'), npmrc)
  if (audit !== undefined) {
    await mkdir(join(home, '.audit'))
    await writeFile(join(home, '.audit', 'config.json'), typeof audit === 'string' ? audit : `${JSON.stringify(audit)}\n`)
  }
  return home
}

// An npm token as npm writes one, and another.
export const NPM_TOKEN = `npm_${'aB3'.repeat(12)}`
export const OTHER_NPM_TOKEN = `npm_${'Zy9'.repeat(12)}`

// An ~/.npmrc giving npm's registry NPM_TOKEN after a line that is not valid UTF-8.
export const NOT_UTF8_NPMRC = Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`)])
