import fsp from 'node:fs/promises'
import { join } from 'node:path'

// A clone of the tree at `src` under `dst`, for a test to work on a copy of a fixture: each file
// hardlinked to the fixture's (~40ms vs ~780ms for a real cp of popular-npm-modules' 13MB
// node_modules), each symlink made again with the same target.
//
// A hardlink shares its inode with the fixture's file, so a writeFile to a cloned path would also
// rewrite the fixture: a test that changes a cloned file must unlink it first.
//
// Where `dst` is on another filesystem than `src` (a runner whose tmpdir() is not the checkout's
// disk), link() fails with EXDEV, and the file is copied instead.
//
// fs calls go through the module object rather than named imports, so hardlink-copy.test.js can
// stub link().
export const hardlinkCopy = async (src, dst) => {
  await fsp.mkdir(dst, { recursive: true })
  const entries = await fsp.readdir(src, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) await hardlinkCopy(s, d)
    else if (entry.isSymbolicLink()) await fsp.symlink(await fsp.readlink(s), d)
    else await linkOrCopy(s, d)
  }))
}

const linkOrCopy = async (s, d) => {
  try {
    await fsp.link(s, d)
  } catch (err) {
    if (err.code !== 'EXDEV') throw err
    await fsp.copyFile(s, d)
  }
}
