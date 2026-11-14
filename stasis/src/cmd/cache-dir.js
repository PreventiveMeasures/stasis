import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// The directory the commands cache in: STASIS_CACHE_DIR itself where it is set, else the per-user
// cache directory as each platform names it (XDG ignores a relative path). STASIS_CACHE_DIR is the
// user's own choice, so a relative one is refused rather than ignored: it would resolve against
// whatever directory a command runs in, a project's checkout as likely as not.
export function userCacheDir({ env = process.env, platform = process.platform, home } = {}) {
  const own = env.STASIS_CACHE_DIR
  if (own) {
    if (!isAbsolute(own)) throw new Error(`STASIS_CACHE_DIR must be an absolute path, not ${JSON.stringify(own)}`)
    return own
  }
  if (isAbsolute(env.XDG_CACHE_HOME ?? '')) return join(env.XDG_CACHE_HOME, 'stasis')
  if (platform === 'darwin') return join(home ?? homedir(), 'Library', 'Caches', 'stasis')
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home ?? homedir(), 'AppData', 'Local'), 'stasis', 'Cache')
  return join(home ?? homedir(), '.cache', 'stasis')
}
