import { isUtf8 } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readJson } from '@exodus/stasis-core/bundle-util'

// What @preventive/upstream's npm client takes its token from: the first set, read on each request.
export const NPM_TOKEN_VARS = ['PREVENTIVE_MEASURES_NPM_TOKEN', 'STASIS_NPM_TOKEN', 'NPM_TOKEN']

// Printable ASCII and no space, as @preventive/upstream takes one; anything else is none, so that it
// never reaches an error message.
const asToken = (value) => (typeof value === 'string' && /^[!-~]+$/u.test(value.trim()) ? value.trim() : undefined)

// `<home>/.audit/config.json`'s tokens. Another tool's file, read for compatibility: one missing,
// unreadable or of another shape gives none, silently.
export function auditTokens(home) {
  const config = readJson(join(home ?? homedir(), '.audit', 'config.json'))
  return config === null ? {} : { token: asToken(config.token), npmToken: asToken(config.npmToken) }
}

export function githubToken({ env = process.env, home } = {}) {
  return env.GITHUB_TOKEN || auditTokens(home).token || null
}

// npm's registry's token exactly as npm writes it: no other registry's, no variable to expand.
const NPMRC_LINE = /^\/\/registry\.npmjs\.org\/:_authToken=(npm_[\dA-Za-z]+)\r?$/u

// `<home>/.npmrc`'s last NPMRC_LINE, as npm takes the last of a setting given twice. A missing or
// unreadable file gives none, silently; one that is not UTF-8 is refused.
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

// `fn()` with STASIS_NPM_TOKEN auditTokens' or npmrcToken's where no NPM_TOKEN_VARS is set (each file only
// read then), restored after unless something else set it meanwhile.
export async function withNpmToken(home, fn) {
  const token = NPM_TOKEN_VARS.some((name) => process.env[name]) ? undefined : (auditTokens(home).npmToken ?? npmrcToken(home))
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
