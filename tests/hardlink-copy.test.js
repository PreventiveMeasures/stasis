// hardlinkCopy (hardlink-copy.helper.js), the fixture clone several suites copy into tmpdir():
// hardlinks where it can, and copies where link() fails with EXDEV, as it does on a runner whose
// tmpdir() is on another filesystem than the checkout.
import { test } from 'node:test'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hardlinkCopy } from './hardlink-copy.helper.js'

const withTmp = (fn) => async (t) => {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'stasis-hardlink-copy-'))
  try {
    return await fn(t, join(dir, 'src'), join(dir, 'dst'))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}

// Two files, one of them nested, and a symlink to the nested one.
const makeTree = async (src) => {
  await fsp.mkdir(join(src, 'nested'), { recursive: true })
  await fsp.writeFile(join(src, 'a.txt'), 'a\n')
  await fsp.writeFile(join(src, 'nested', 'b.txt'), 'b\n')
  await fsp.symlink(join('nested', 'b.txt'), join(src, 'link'))
}

const failingLink = (code) => async (s, d) => {
  throw Object.assign(new Error(`${code}: link '${s}' -> '${d}'`), { code, syscall: 'link', path: s, dest: d })
}

const files = ['a.txt', join('nested', 'b.txt')]
const inodes = (dir) => Promise.all(files.map(async (file) => (await fsp.stat(join(dir, file))).ino))
const contents = (dir) => Promise.all(files.map((file) => fsp.readFile(join(dir, file), 'utf8')))

const assertSymlinkKept = async (t, dst) => {
  t.assert.equal((await fsp.lstat(join(dst, 'link'))).isSymbolicLink(), true)
  t.assert.equal(await fsp.readlink(join(dst, 'link')), join('nested', 'b.txt'))
}

test('hardlinks each file, and keeps a symlink a symlink', withTmp(async (t, src, dst) => {
  await makeTree(src)
  await hardlinkCopy(src, dst)
  t.assert.deepEqual(await inodes(dst), await inodes(src))
  await assertSymlinkKept(t, dst)
}))

test('copies a file link() refuses with EXDEV, and keeps a symlink a symlink', withTmp(async (t, src, dst) => {
  await makeTree(src)
  const link = t.mock.method(fsp, 'link', failingLink('EXDEV'))
  await hardlinkCopy(src, dst)
  t.assert.equal(link.mock.callCount(), files.length)
  const [copied, source] = await Promise.all([inodes(dst), inodes(src)])
  for (const [i, file] of files.entries()) t.assert.notEqual(copied[i], source[i], file)
  t.assert.deepEqual(await contents(dst), await contents(src))
  await assertSymlinkKept(t, dst)
  // A copy, not a link: writing to it leaves the source as it was.
  await fsp.writeFile(join(dst, 'a.txt'), 'changed\n')
  t.assert.equal(await fsp.readFile(join(src, 'a.txt'), 'utf8'), 'a\n')
}))

// One file, so nothing else is still in flight when the copy rejects and the directory is removed.
test('rethrows any other link() error', withTmp(async (t, src, dst) => {
  await fsp.mkdir(src)
  await fsp.writeFile(join(src, 'a.txt'), 'a\n')
  t.mock.method(fsp, 'link', failingLink('EPERM'))
  await t.assert.rejects(hardlinkCopy(src, dst), { code: 'EPERM' })
}))
