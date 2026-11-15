import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { userCacheDir } from '../stasis/src/cmd/cache-dir.js'

// Upstream as stasis resolves it: the workspace root doesn't depend on it.
const here = dirname(fileURLToPath(import.meta.url))
const { cacheDirFor } = await import(pathToFileURL(createRequire(join(here, '..', 'stasis', 'package.json')).resolve('@preventive/upstream/npm.js')).href)

// `fn()` with `vars` set in the process's environment (undefined: unset), restored after.
function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  const set = (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  set(vars)
  try {
    return fn()
  } finally {
    set(saved)
  }
}

const dir = (vars) => withEnv(vars, userCacheDir)

test('userCacheDir takes STASIS_CACHE_DIR as it is, before the platform directory', (t) => {
  t.assert.equal(dir({ STASIS_CACHE_DIR: '/srv/cache', XDG_CACHE_HOME: '/xdg' }), '/srv/cache')
  t.assert.equal(dir({ STASIS_CACHE_DIR: '/srv/cache/' }), '/srv/cache/', 'no stasis directory added under it')
  t.assert.equal(dir({ STASIS_CACHE_DIR: '/srv/cache', HOME: 'relative' }), '/srv/cache', 'no home needed')
})

test('userCacheDir refuses a relative STASIS_CACHE_DIR, and takes an empty one as unset', (t) => {
  for (const value of ['cache', './cache', '../cache', '~/cache']) {
    t.assert.throws(() => dir({ STASIS_CACHE_DIR: value }), { message: `STASIS_CACHE_DIR must be an absolute path, not ${JSON.stringify(value)}` }, value)
  }
  t.assert.equal(dir({ STASIS_CACHE_DIR: '', HOME: '/home/u', XDG_CACHE_HOME: undefined }), withEnv({ HOME: '/home/u', XDG_CACHE_HOME: undefined }, () => cacheDirFor('stasis')))
})

test("userCacheDir without STASIS_CACHE_DIR is upstream's directory for stasis, refused where there is none", (t) => {
  for (const vars of [{ HOME: '/home/u', XDG_CACHE_HOME: undefined }, { HOME: '/home/u', XDG_CACHE_HOME: '/xdg' }, { HOME: '/home/u', XDG_CACHE_HOME: 'xdg' }]) {
    const all = { STASIS_CACHE_DIR: undefined, ...vars }
    t.assert.equal(dir(all), withEnv(all, () => cacheDirFor('stasis')), JSON.stringify(vars))
  }
  if (process.platform === 'linux') {
    t.assert.equal(dir({ STASIS_CACHE_DIR: undefined, HOME: '/home/u', XDG_CACHE_HOME: undefined }), '/home/u/.cache/stasis')
    t.assert.equal(dir({ STASIS_CACHE_DIR: undefined, HOME: '/home/u', XDG_CACHE_HOME: '/xdg' }), '/xdg/stasis')
    t.assert.equal(dir({ STASIS_CACHE_DIR: undefined, HOME: '/home/u', XDG_CACHE_HOME: 'xdg' }), '/home/u/.cache/stasis', 'a relative XDG_CACHE_HOME ignored')
  }
  if (process.platform !== 'win32') {
    for (const home of ['relative', '']) {
      t.assert.throws(() => dir({ STASIS_CACHE_DIR: undefined, HOME: home, XDG_CACHE_HOME: undefined }), { message: 'there is no cache directory, as no absolute home directory is known: set STASIS_CACHE_DIR' }, JSON.stringify(home))
    }
  }
})
