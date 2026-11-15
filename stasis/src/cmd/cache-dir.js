import { isAbsolute } from 'node:path'

import { cacheDirFor } from '@preventive/upstream/npm.js'

// The directory the commands cache in: STASIS_CACHE_DIR itself where it is set, else the platform's
// cache directory for stasis as @preventive/upstream names it, the one it reads as stasis's (an
// absolute XDG_CACHE_HOME's only on Linux and the BSDs). STASIS_CACHE_DIR is the user's own choice,
// so a relative one is refused rather than ignored: it would resolve against whatever directory a
// command runs in, a project's checkout as likely as not. Both read the process's environment.
export function userCacheDir() {
  const own = process.env.STASIS_CACHE_DIR
  if (own) {
    if (!isAbsolute(own)) throw new Error(`STASIS_CACHE_DIR must be an absolute path, not ${JSON.stringify(own)}`)
    return own
  }
  const dir = cacheDirFor('stasis')
  if (dir === undefined) throw new Error('there is no cache directory, as no absolute home directory is known: set STASIS_CACHE_DIR')
  return dir
}
