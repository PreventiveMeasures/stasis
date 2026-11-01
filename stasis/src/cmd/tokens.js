import { isUtf8 } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readJson } from '@exodus/stasis-core/bundle-util'

// Tokens for fetching, from the environment, and where it has none, as a fallback, from other tools'
// files in the user's home, read for compatibility.

// The variables @preventive/upstream's npm client takes its token from, the first set and not
// empty, read from process.env on each request.
export const NPM_TOKEN_VARS = ['PREVENTIVE_MEASURES_NPM_TOKEN', 'STASIS_NPM_TOKEN', 'NPM_TOKEN']

// A token as @preventive/upstream takes one, printable ASCII and no space, around which whitespace
// is dropped; anything else is none, so that it never reaches an error message.
const asToken = (value) => (typeof value === 'string' && /^[!-~]+$/u.test(value.trim()) ? value.trim() : undefined)

// The GitHub `token` and `npmToken` of `<home>/.audit/config.json` (the user's home by default),
// each where the file has it as a token. The file is another tool's, read for compatibility: one
// that is missing, unreadable, not JSON or of another shape gives neither, and nothing is said.
export function auditTokens(home) {
  const config = readJson(join(home ?? homedir(), '.audit', 'config.json'))
  return config === null ? {} : { token: asToken(config.token), npmToken: asToken(config.npmToken) }
}

// The GitHub token: `env`'s GITHUB_TOKEN where it is set, else, as a fallback, auditTokens(home)'s,
// only read then. -> it, or null where there is none
export function githubToken({ env = process.env, home } = {}) {
  return env.GITHUB_TOKEN || auditTokens(home).token || null
}

// A line of an .npmrc giving npm's own registry an npm token, exactly as npm writes it: no other
// registry's, no variable for npm to expand, and nothing else on the line.
const NPMRC_LINE = /^\/\/registry\.npmjs\.org\/:_authToken=(npm_[\dA-Za-z]+)\r?$/u

// The npm token `<home>/.npmrc` (the user's home by default) gives npm's registry: that of the last
// line of it that is NPMRC_LINE, as npm takes the last of a setting given twice. Another registry's
// token, or one in any other form, is none. The file is npm's, read for compatibility: one that is
// missing or unreadable gives none, and nothing is said; one that is not valid UTF-8 is refused.
export function npmrcToken(home) {
  const file = join(home ?? homedir(), '.npmrc')
  let bytes
  try {
    bytes = readFileSync(file)
  } catch {
    return undefined
  }
  if (!isUtf8(bytes)) throw new Error(`${file} is not valid UTF-8`)
  let token
  for (const line of bytes.toString('utf8').split('\n')) token = NPMRC_LINE.exec(line)?.[1] ?? token
  return token
}

// Run `fn`, with a token for the npm client where process.env gives it none (none of
// NPM_TOKEN_VARS set and not empty), as a fallback: auditTokens(home)'s `npmToken` (`audit`, where
// it is read already), else npmrcToken(home)'s, each file only read then. That token is
// STASIS_NPM_TOKEN in process.env while `fn` runs, for the client to read, and process.env is as it
// was after, unless something else set STASIS_NPM_TOKEN meanwhile. -> what `fn` gives
export async function withNpmToken({ home, audit } = {}, fn) {
  const token = NPM_TOKEN_VARS.some((name) => process.env[name]) ? undefined : ((audit ?? auditTokens(home)).npmToken ?? npmrcToken(home))
  if (token === undefined) return fn()
  const before = process.env.STASIS_NPM_TOKEN
  process.env.STASIS_NPM_TOKEN = token
  try {
    return await fn()
  } finally {
    if (process.env.STASIS_NPM_TOKEN === token) {
      if (before === undefined) delete process.env.STASIS_NPM_TOKEN
      else process.env.STASIS_NPM_TOKEN = before
    }
  }
}
