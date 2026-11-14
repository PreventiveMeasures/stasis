import { test } from 'node:test'
import { join } from 'node:path'

import { userCacheDir } from '../stasis/src/cmd/cache-dir.js'

const home = '/home/u'
const dir = (env, platform = 'linux') => userCacheDir({ env, platform, home })

test('userCacheDir takes STASIS_CACHE_DIR as it is, before any platform directory', (t) => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    t.assert.equal(dir({ STASIS_CACHE_DIR: '/srv/cache', XDG_CACHE_HOME: '/xdg', LOCALAPPDATA: '/local' }, platform), '/srv/cache', platform)
  }
  t.assert.equal(dir({ STASIS_CACHE_DIR: '/srv/cache/' }), '/srv/cache/', 'no stasis directory added under it')
})

test('userCacheDir refuses a relative STASIS_CACHE_DIR, and takes an empty one as unset', (t) => {
  for (const value of ['cache', './cache', '../cache', '~/cache']) {
    t.assert.throws(() => dir({ STASIS_CACHE_DIR: value }), { message: `STASIS_CACHE_DIR must be an absolute path, not ${JSON.stringify(value)}` }, value)
  }
  t.assert.equal(dir({ STASIS_CACHE_DIR: '' }), join(home, '.cache', 'stasis'))
})

test("userCacheDir without STASIS_CACHE_DIR is the platform's, an absolute XDG_CACHE_HOME first", (t) => {
  t.assert.equal(dir({}), join(home, '.cache', 'stasis'))
  t.assert.equal(dir({ XDG_CACHE_HOME: '/xdg' }), join('/xdg', 'stasis'))
  t.assert.equal(dir({ XDG_CACHE_HOME: 'xdg' }), join(home, '.cache', 'stasis'), 'a relative one ignored')
  t.assert.equal(dir({}, 'darwin'), join(home, 'Library', 'Caches', 'stasis'))
  t.assert.equal(dir({ LOCALAPPDATA: '/local' }, 'win32'), join('/local', 'stasis', 'Cache'))
  t.assert.equal(dir({}, 'win32'), join(home, 'AppData', 'Local', 'stasis', 'Cache'))
})
