import { test } from 'node:test'
import { globSync as nodeGlobSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, matchesGlob as nodeMatchesGlob, posix, relative } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { Vfs, createVfsHost } from '../stasis/src/vfs-bundle.js'
import { globSync, matchesGlob } from '../stasis/src/vfs-bundle/glob.js'

// vfs-bundle/glob.js: Node's own fs.globSync and path.matchesGlob over a host's tree, here a Vfs
// holding what a directory on disk holds, globbed as Node globs that.

const FILES = [
  '.env', 'a.js', 'src/a.js', 'src/b.ts', 'src/.hidden.js', 'src/deep/c.js', 'src/deep/deeper/d.js',
  'assets/logo.png', 'assets/x/y.png', 'ios/.xcode.env', 'ios/Podfile', 'ios/App/AppDelegate.swift',
  'ios/App.xcodeproj/project.pbxproj', 'ios/App.xcodeproj/project.xcworkspace/contents.xcworkspacedata',
  'ios/App.xcodeproj/xcuserdata/me.xcuserdatad/x.plist', 'ios/build/out.o', 'ios/Pods/Lib/a.m',
  'ios/fastlane/README.md', 'ios/fastlane/report.xml', 'ios/fastlane/Fastfile',
]
// A symlink to a directory, which Node walks where a pattern names it, never by `**`.
const LINK = ['src', 'linked']

// Patterns whose matches every Node stasis supports agrees on (24.14.0 and 26.0.0 walk one level
// into a symlinked directory a `**/*` passes, which 24.22.2 and 26.13.0 don't, as glob.js doesn't).
const PATTERNS = [
  'ios', 'ios/.xcode.env', 'ios/*', 'ios/**', 'ios/**/*', '**/*.js', 'src/**/*.js', 'src/*.{js,ts}', '*', '**', '.*', 'src/.*',
  'assets/**/*.png', 'nope/*', 'nope', './src/*.js', 'src/../a.js', '**/deep/*', 'src/**', '**/*.png', 'linked/*.js',
  'ios/*.xcodeproj/*', 'src/', '**/', 'src/deep/**/..', '**/*.{swift,m}', 'ios/fastlane/*.{md,xml}', 'src/@(a|b).*', 'src/[ab].js',
]
const EXCLUSIONS = ['ios/build', 'ios/Pods', 'ios/*.xcodeproj/project.xcworkspace', 'ios/fastlane/*.{md,xml}', '**/xcuserdata', 'src/deep']

// The tree on disk under a new directory, and in a Vfs at its `/`.
function trees(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'stasis-vfs-bundle-glob-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const vfs = new Vfs()
  for (const file of FILES) {
    mkdirSync(dirname(join(tmp, file)), { recursive: true })
    writeFileSync(join(tmp, file), file)
    vfs.mkdir(posix.dirname(`/${file}`), { recursive: true })
    vfs.writeFile(`/${file}`, file)
  }
  symlinkSync(LINK[0], join(tmp, LINK[1]))
  vfs.symlink(LINK[0], `/${LINK[1]}`)
  return { tmp, host: createVfsHost(vfs) }
}

test('glob.js globs a Vfs as Node globs the same tree on disk', (t) => {
  const { tmp, host } = trees(t)
  for (const pattern of PATTERNS) {
    t.assert.deepStrictEqual(globSync(host, pattern, { cwd: '/' }).toSorted(), nodeGlobSync(pattern, { cwd: tmp }).toSorted(), pattern)
    t.assert.deepStrictEqual(host.glob(pattern, { cwd: '/' }).toSorted(), diskHost.glob(pattern, { cwd: tmp }).toSorted(), `${pattern}, as hosts glob`)
  }
  for (const pattern of ['*', '**/*.js', '../a.js', '../*/*.png']) {
    t.assert.deepStrictEqual(globSync(host, pattern, { cwd: '/src' }).toSorted(), nodeGlobSync(pattern, { cwd: join(tmp, 'src') }).toSorted(), `${pattern} from src`)
  }
  // An absolute pattern is the tree's, from its root.
  t.assert.deepStrictEqual(globSync(host, '/src/*.ts', { cwd: '/ios' }), ['/src/b.ts'])
})

test('glob.js leaves out, and never walks into, what `exclude` takes, as Node does', (t) => {
  const { tmp, host } = trees(t)
  const excluded = (rel) => EXCLUSIONS.some((pattern) => nodeMatchesGlob(rel, pattern))
  const taken = []
  // Node lstats a path it would walk into as spelled from the root, from the process's cwd, before
  // it asks `exclude`: from the root, it asks as glob.js does.
  const cwd = process.cwd()
  process.chdir(tmp)
  t.after(() => process.chdir(cwd))
  for (const pattern of ['ios/**/*', 'ios/*/*', 'ios/**', '**/*.xml', '**/*.{js,png}', 'src/**/*.js']) {
    const vfs = host.glob(pattern, { cwd: '/', exclude: (path) => (taken.push(path), excluded(posix.relative('/', path))) })
    t.assert.deepStrictEqual(vfs.toSorted(), diskHost.glob(pattern, { cwd: tmp, exclude: (path) => excluded(relative(tmp, path)) }).toSorted(), pattern)
  }
  t.assert.ok(taken.length > 0 && taken.every((path) => path.startsWith('/')), 'given absolute paths')
  t.assert.ok(!taken.some((path) => path.startsWith('/ios/build/') || path.startsWith('/src/deep/')), 'never walked into')
})

test("glob.js walks a symlinked directory a pattern names, never by `**`, as Node 24.22.2's and 26.13.0's glob", (t) => {
  const { host } = trees(t)
  t.assert.deepStrictEqual(globSync(host, 'linked/*.js', { cwd: '/' }).toSorted(), ['linked/a.js'])
  const all = globSync(host, '**/*', { cwd: '/' })
  t.assert.ok(all.includes('linked'))
  t.assert.ok(!all.some((path) => path.startsWith('linked/')), all.join(', '))
})

test('glob.js matches a path as Node does, never folding case', (t) => {
  const cases = [
    ['ios/fastlane/report.xml', 'ios/fastlane/*.{md,xml}'], ['ios/fastlane/Fastfile', 'ios/fastlane/*.{md,xml}'],
    ['ios/App.xcodeproj/project.xcworkspace', 'ios/*.xcodeproj/project.xcworkspace'], ['a/b/xcuserdata', '**/xcuserdata'],
    ['a/.b', '**/*'], ['.b', '*'], ['a/b', 'a/**'], ['a', 'a/**'], ['src/a.js', 'src/@(a|b).*'], ['ios/Pods', 'ios/Pods/'],
  ]
  for (const [path, pattern] of cases) t.assert.equal(matchesGlob(path, pattern), nodeMatchesGlob(path, pattern), `${path} ${pattern}`)
  t.assert.equal(matchesGlob('src/A.JS', 'src/*.js'), false)
  t.assert.equal(matchesGlob('Podfile', 'podfile'), false)
})

test('glob.js globs case-sensitively, as git holds names', (t) => {
  const vfs = new Vfs()
  for (const file of ['/README.md', '/readme.md', '/Src/a.js']) {
    vfs.mkdir(posix.dirname(file), { recursive: true })
    vfs.writeFile(file, '')
  }
  const host = createVfsHost(vfs)
  t.assert.deepStrictEqual(host.glob('readme.*', { cwd: '/' }), ['readme.md'])
  t.assert.deepStrictEqual(host.glob('src/*.js', { cwd: '/' }), [])
  t.assert.deepStrictEqual(host.glob('Src/*.js', { cwd: '/' }), ['Src/a.js'])
})
