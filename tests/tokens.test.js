import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { auditTokens, npmrcToken, withNpmToken } from '../stasis/src/cmd/tokens.js'
import { NOT_UTF8_NPMRC, NPM_TOKEN, OTHER_NPM_TOKEN, npmTokenVars, tokenHome, withoutNpmTokenVars } from './tokens.helper.js'

test("auditTokens reads ~/.audit/config.json's token and npmToken, and nothing of a file it cannot", async (t) => {
  const read = async (audit) => auditTokens(await tokenHome(t, { audit }))
  t.assert.deepStrictEqual(await read({ token: 'ghp_abc', npmToken: 'npm_def', other: 1 }), { token: 'ghp_abc', npmToken: 'npm_def' })
  t.assert.deepStrictEqual(await read({ token: ' ghp_abc\n' }), { token: 'ghp_abc', npmToken: undefined })
  t.assert.deepStrictEqual(await read(undefined), {}, 'no ~/.audit')
  const home = await tokenHome(t)
  await mkdir(join(home, '.audit', 'config.json'), { recursive: true })
  t.assert.deepStrictEqual(auditTokens(home), {}, 'a directory')
  // Not JSON, not an object, or no token where one is named: none, and nothing to say of it.
  const unread = ['{', '', 'null', '"ghp_abc"', '[]', { token: 'two words', npmToken: 1 }, { token: '', npmToken: null }]
  const found = await Promise.all(unread.map(async (audit) => Object.values(await read(audit)).filter(Boolean)))
  t.assert.deepStrictEqual(found, unread.map(() => []))
})

test("npmrcToken reads the npm token ~/.npmrc gives npm's own registry, on a line of that alone", async (t) => {
  const read = async (npmrc) => npmrcToken(await tokenHome(t, { npmrc }))
  t.assert.equal(await read(`//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`), NPM_TOKEN)
  t.assert.equal(await read(`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`), NPM_TOKEN, 'without a newline after it')
  t.assert.equal(await read(`registry=https://registry.npmjs.org/\r\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\r\nsave-exact=true\r\n`), NPM_TOKEN, 'among other settings, CRLF')
  t.assert.equal(await read(`//registry.npmjs.org/:_authToken=${OTHER_NPM_TOKEN}\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`), NPM_TOKEN, 'the last, as npm takes it')
  t.assert.equal(await read(`//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n//npm.pkg.github.com/:_authToken=${OTHER_NPM_TOKEN}\n`), NPM_TOKEN, "beside another registry's")
  t.assert.equal(await read(`# café ✓\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`), NPM_TOKEN, 'UTF-8 beyond ASCII')
  // Another registry's, a token in another form, or a line that is not exactly that: none.
  const none = [
    `//npm.pkg.github.com/:_authToken=${NPM_TOKEN}\n`,
    `//registry.yarnpkg.com/:_authToken=${NPM_TOKEN}\n`,
    `//registry.npmjs.org/foo/:_authToken=${NPM_TOKEN}\n`,
    `//registry.npmjs.org.evil.example/:_authToken=${NPM_TOKEN}\n`,
    `//registry.npmjs.org:443/:_authToken=${NPM_TOKEN}\n`,
    `https://registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`,
    `_authToken=${NPM_TOKEN}\n`,
    '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n',
    '//registry.npmjs.org/:_authToken=00000000-0000-0000-0000-000000000000\n',
    '//registry.npmjs.org/:_authToken=npm_\n',
    `//registry.npmjs.org/:_authToken="${NPM_TOKEN}"\n`,
    `//registry.npmjs.org/:_authToken = ${NPM_TOKEN}\n`,
    ` //registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`,
    `//registry.npmjs.org/:_authToken=${NPM_TOKEN} \n`,
    `//registry.npmjs.org/:_authToken=${NPM_TOKEN}x-y\n`,
    `# //registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`,
    `; //registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`,
    `//registry.npmjs.org/:_password=${NPM_TOKEN}\n`,
    '',
  ]
  t.assert.deepStrictEqual(await Promise.all(none.map(read)), none.map(() => undefined))
})

test('npmrcToken gives none, and says nothing, of an .npmrc that is missing or unreadable; one not valid UTF-8 it refuses', async (t) => {
  t.mock.method(console, 'warn', () => t.assert.fail('said something'))
  const home = await tokenHome(t)
  t.assert.equal(npmrcToken(home), undefined, 'missing')
  t.assert.equal(npmrcToken(join(home, 'nowhere')), undefined, 'no home')
  await mkdir(join(home, '.npmrc'))
  t.assert.equal(npmrcToken(home), undefined, 'a directory')
  const notUtf8 = await tokenHome(t, { npmrc: NOT_UTF8_NPMRC })
  t.assert.throws(() => npmrcToken(notUtf8), { message: `${join(notUtf8, '.npmrc')} is not valid UTF-8` })
})

test("withNpmToken gives the npm client, as a fallback where process.env gives it none, .audit's token, else ~/.npmrc's", async (t) => {
  withoutNpmTokenVars(t)
  const npmrc = `//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`
  const [home, audited, empty, notUtf8, notUtf8Audited] = await Promise.all([
    { npmrc },
    { npmrc, audit: { npmToken: 'npm-audit' } },
    {},
    { npmrc: NOT_UTF8_NPMRC },
    { npmrc: NOT_UTF8_NPMRC, audit: { npmToken: 'npm-audit' } },
  ].map((files) => tokenHome(t, files)))
  // The npm token variables as `fn` sees them in `at`, what it gives, and the variables after.
  const seen = async (at) => {
    let during
    const given = await withNpmToken(at, async () => {
      during = npmTokenVars()
      return 'given'
    })
    return { given, during, after: npmTokenVars() }
  }
  t.assert.deepStrictEqual(await seen(home), { given: 'given', during: [undefined, NPM_TOKEN, undefined], after: [undefined, undefined, undefined] })
  t.assert.deepStrictEqual(await seen(audited), { given: 'given', during: [undefined, 'npm-audit', undefined], after: [undefined, undefined, undefined] }, ".audit's first")
  t.assert.deepStrictEqual(await seen(empty), { given: 'given', during: [undefined, undefined, undefined], after: [undefined, undefined, undefined] }, 'none without either')
  t.assert.equal((await seen(notUtf8Audited)).during[1], 'npm-audit', '~/.npmrc not read where .audit gives one')
  let ran = false
  await t.assert.rejects(withNpmToken(notUtf8, () => (ran = true)), { message: `${join(notUtf8, '.npmrc')} is not valid UTF-8` })
  t.assert.equal(ran, false, 'nothing runs where ~/.npmrc is refused')
  const failing = withNpmToken(home, async () => {
    t.assert.equal(process.env.STASIS_NPM_TOKEN, NPM_TOKEN)
    throw new Error('fails')
  })
  await t.assert.rejects(failing, /^Error: fails$/u)
  t.assert.equal(process.env.STASIS_NPM_TOKEN, undefined, 'after one that fails')

  process.env.STASIS_NPM_TOKEN = ''
  t.assert.deepStrictEqual(await seen(home), { given: 'given', during: [undefined, NPM_TOKEN, undefined], after: [undefined, '', undefined] }, 'set but empty')
  process.env.NPM_TOKEN = 'npm-env'
  t.assert.deepStrictEqual(await seen(audited), { given: 'given', during: [undefined, '', 'npm-env'], after: [undefined, '', 'npm-env'] }, "the environment's first")
  t.assert.deepStrictEqual((await seen(notUtf8)).during, [undefined, '', 'npm-env'], '~/.npmrc not read where the environment gives one')
})
