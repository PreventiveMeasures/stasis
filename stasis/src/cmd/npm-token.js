import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The variables @preventive/upstream's npm client takes its token from, the first set and not
// empty, read from process.env on each request.
export const NPM_TOKEN_VARS = ['PREVENTIVE_MEASURES_NPM_TOKEN', 'STASIS_NPM_TOKEN', 'NPM_TOKEN']

// A line of an .npmrc giving npm's own registry an npm token, exactly as npm writes it: no other
// registry's, no variable for npm to expand, and nothing else on the line.
const NPMRC_LINE = /^\/\/registry\.npmjs\.org\/:_authToken=(npm_[\dA-Za-z]+)\r?$/u

// The npm token `<home>/.npmrc` (the user's home by default) gives npm's registry: that of the last
// line of it that is NPMRC_LINE, as npm takes the last of a setting given twice. Another registry's
// token, or one in any other form, is none. The file is npm's, read for compatibility: one that is
// missing or unreadable gives none, and nothing is said.
export function npmrcToken(home) {
  let text
  try {
    text = readFileSync(join(home ?? homedir(), '.npmrc'), 'utf8')
  } catch {
    return undefined
  }
  let token
  for (const line of text.split('\n')) token = NPMRC_LINE.exec(line)?.[1] ?? token
  return token
}

// Run `fn`, with a token for the npm client where process.env gives it none (none of
// NPM_TOKEN_VARS set and not empty): `audit` where given (~/.audit/config.json's `npmToken`), else
// npmrcToken(home)'s, which is only read then. That token is STASIS_NPM_TOKEN in process.env while
// `fn` runs, for the client to read, and process.env is as it was after, unless something else set
// STASIS_NPM_TOKEN meanwhile. -> what `fn` gives
export async function withNpmToken({ home, audit } = {}, fn) {
  const token = NPM_TOKEN_VARS.some((name) => process.env[name]) ? undefined : (audit ?? npmrcToken(home))
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
