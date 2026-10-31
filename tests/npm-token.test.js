import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NPM_TOKEN_VARS, npmrcToken, withNpmToken } from '../stasis/src/cmd/npm-token.js'

const TOKEN = `npm_${'aB3'.repeat(12)}`
const OTHER = `npm_${'Zy9'.repeat(12)}`

// A home of its own, removed after the test, whose ~/.npmrc is `npmrc` where given.
async function npmrcHome(t, npmrc) {
  const home = await mkdtemp(join(tmpdir(), 'stasis-npm-token-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  if (npmrc !== undefined) await writeFile(join(home, '.npmrc'), npmrc)
  return home
}

// process.env without any of NPM_TOKEN_VARS for the test, as it was after it.
function withoutNpmTokenVars(t) {
  const saved = NPM_TOKEN_VARS.map((name) => [name, process.env[name]])
  for (const name of NPM_TOKEN_VARS) delete process.env[name]
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

test("npmrcToken reads the npm token ~/.npmrc gives npm's own registry, on a line of that alone", async (t) => {
  const read = async (npmrc) => npmrcToken(await npmrcHome(t, npmrc))
  t.assert.equal(await read(`//registry.npmjs.org/:_authToken=${TOKEN}\n`), TOKEN)
  t.assert.equal(await read(`//registry.npmjs.org/:_authToken=${TOKEN}`), TOKEN, 'without a newline after it')
  t.assert.equal(await read(`registry=https://registry.npmjs.org/\r\n//registry.npmjs.org/:_authToken=${TOKEN}\r\nsave-exact=true\r\n`), TOKEN, 'among other settings, CRLF')
  t.assert.equal(await read(`//registry.npmjs.org/:_authToken=${OTHER}\n//registry.npmjs.org/:_authToken=${TOKEN}\n`), TOKEN, 'the last, as npm takes it')
  t.assert.equal(await read(`//registry.npmjs.org/:_authToken=${TOKEN}\n//npm.pkg.github.com/:_authToken=${OTHER}\n`), TOKEN, "beside another registry's")
  // Another registry's, a token in another form, or a line that is not exactly that: none.
  const none = [
    `//npm.pkg.github.com/:_authToken=${TOKEN}\n`,
    `//registry.yarnpkg.com/:_authToken=${TOKEN}\n`,
    `//registry.npmjs.org/foo/:_authToken=${TOKEN}\n`,
    `//registry.npmjs.org.evil.example/:_authToken=${TOKEN}\n`,
    `//registry.npmjs.org:443/:_authToken=${TOKEN}\n`,
    `https://registry.npmjs.org/:_authToken=${TOKEN}\n`,
    `_authToken=${TOKEN}\n`,
    '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n',
    '//registry.npmjs.org/:_authToken=00000000-0000-0000-0000-000000000000\n',
    '//registry.npmjs.org/:_authToken=npm_\n',
    `//registry.npmjs.org/:_authToken="${TOKEN}"\n`,
    `//registry.npmjs.org/:_authToken = ${TOKEN}\n`,
    ` //registry.npmjs.org/:_authToken=${TOKEN}\n`,
    `//registry.npmjs.org/:_authToken=${TOKEN} \n`,
    `//registry.npmjs.org/:_authToken=${TOKEN}x-y\n`,
    `# //registry.npmjs.org/:_authToken=${TOKEN}\n`,
    `; //registry.npmjs.org/:_authToken=${TOKEN}\n`,
    `//registry.npmjs.org/:_password=${TOKEN}\n`,
    '',
  ]
  t.assert.deepStrictEqual(await Promise.all(none.map(read)), none.map(() => undefined))
})

test('npmrcToken gives none, and says nothing, of an .npmrc that is missing or unreadable', async (t) => {
  t.mock.method(console, 'warn', () => t.assert.fail('said something'))
  const home = await npmrcHome(t)
  t.assert.equal(npmrcToken(home), undefined, 'missing')
  await mkdir(join(home, '.npmrc'))
  t.assert.equal(npmrcToken(home), undefined, 'a directory')
  t.assert.equal(npmrcToken(join(home, 'nowhere')), undefined, 'no home')
})

test('withNpmToken gives the npm client the token process.env gives it none of: .audit\'s, else ~/.npmrc\'s', async (t) => {
  withoutNpmTokenVars(t)
  const home = await npmrcHome(t, `//registry.npmjs.org/:_authToken=${TOKEN}\n`)
  const empty = await npmrcHome(t)
  // The npm token variables as `fn` sees them, what it gives, and the variables after.
  const seen = async (options) => {
    let during
    const given = await withNpmToken(options, async () => {
      during = NPM_TOKEN_VARS.map((name) => process.env[name])
      return 'given'
    })
    return { given, during, after: NPM_TOKEN_VARS.map((name) => process.env[name]) }
  }
  t.assert.deepStrictEqual(await seen({ home }), { given: 'given', during: [undefined, TOKEN, undefined], after: [undefined, undefined, undefined] })
  t.assert.deepStrictEqual(await seen({ home, audit: 'npm-audit' }), { given: 'given', during: [undefined, 'npm-audit', undefined], after: [undefined, undefined, undefined] }, ".audit's first")
  t.assert.deepStrictEqual(await seen({ home: empty }), { given: 'given', during: [undefined, undefined, undefined], after: [undefined, undefined, undefined] }, 'none without either')
  const failing = withNpmToken({ home }, async () => {
    t.assert.equal(process.env.STASIS_NPM_TOKEN, TOKEN)
    throw new Error('fails')
  })
  await t.assert.rejects(failing, /^Error: fails$/u)
  t.assert.equal(process.env.STASIS_NPM_TOKEN, undefined, 'after one that fails')

  process.env.STASIS_NPM_TOKEN = ''
  t.assert.deepStrictEqual(await seen({ home }), { given: 'given', during: [undefined, TOKEN, undefined], after: [undefined, '', undefined] }, 'set but empty')
  process.env.NPM_TOKEN = 'npm-env'
  t.assert.deepStrictEqual(await seen({ home, audit: 'npm-audit' }), { given: 'given', during: [undefined, '', 'npm-env'], after: [undefined, '', 'npm-env'] }, "the environment's first")
})
