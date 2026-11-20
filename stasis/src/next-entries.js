import { basename, dirname, extname, join, relative, resolve } from 'node:path'

import { diskHost } from '@exodus/stasis-core/host'
import { JS_EXTENSIONS, toPosix } from '@exodus/stasis-core/util'
import { isDir, isFile } from './resolve-typescript.js'
import { getParser, literalSpec, syntaxErrors, walkAst } from './scan.js'

// A Next.js app has no entry of its own: `next build` takes its files by name, from its `app` and `pages`
// directories and beside them. A `next.config.*` entry stands for them, found as Next 16 finds them
// (find-pages-dir.js, route-discovery.js, next-app-loader, is-metadata-route.js, create-compiler-aliases.js), with
// nothing of the app run: its config is read for a literal `pageExtensions` alone.

// Next's CONFIG_FILES.
const CONFIG_FILES = new Set(['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.mts'])
const DEFAULT_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js']

const isNextConfig = (entry) => typeof entry === 'string' && CONFIG_FILES.has(basename(entry))

// The next.config.* in `dir` Next takes, by the order of its CONFIG_FILES, or undefined.
export const nextConfigIn = (dir, host = diskHost) => [...CONFIG_FILES].find((file) => isFile(join(dir, file), host))

// What the app loader takes in each segment of a page's path, and the routes and metadata routes collected (a
// metadata image route's variants numbered, `icon1`); `robots`, `manifest`, `global-error` and `global-not-found`
// only directly in the app directory.
const SEGMENT_FILES = ['page', 'route', 'layout', 'template', 'default', 'loading', 'error', 'not-found', 'forbidden', 'unauthorized', 'sitemap', String.raw`icon\d?`, String.raw`apple-icon\d?`, String.raw`opengraph-image\d?`, String.raw`twitter-image\d?`]
const ROOT_FILES = ['robots', 'manifest', 'global-error', 'global-not-found']
// Beside the app and pages directories: the proxy (middleware before Next 16) and the server's instrumentation.
const BESIDE_FILES = ['proxy', 'middleware', 'instrumentation']

// A property's name, as written (`pageExtensions`, `'pageExtensions'`, `['pageExtensions']`); null for a computed
// one of anything else.
const keyName = (key, computed) => (key.type === 'Identifier' && !computed ? key.name : literalSpec(key))

// The config's `pageExtensions`, where it sets them as a list of strings, the default where it sets none; any other
// setting (a variable, a spread, a call's result) can't be read without running it, and is refused. `label` names
// the config in an error.
function pageExtensionsOf(configFile, label, host) {
  const parsed = getParser().parseSync(configFile, host.readFile(configFile).toString('utf8'), { sourceType: 'unambiguous' })
  // Its parse error is the scan's to report, of the config as an entry.
  if (syntaxErrors(parsed).length > 0) return DEFAULT_PAGE_EXTENSIONS
  const lists = []
  const take = (value) => {
    const list = value.type === 'ArrayExpression' ? value.elements.map(literalSpec) : []
    if (list.length === 0 || !list.every((ext) => ext && !/[/\\]/u.test(ext))) {
      throw new Error(`${label} sets pageExtensions other than as a list of extensions (at offset ${value.start}), which can't be read without running it: name the app's entries instead`)
    }
    lists.push(list)
  }
  walkAst(parsed.program, (node) => {
    if (node.type === 'ObjectExpression') {
      for (const property of node.properties) if (property.type === 'Property' && keyName(property.key, property.computed) === 'pageExtensions') take(property.value)
    }
    if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && keyName(node.left.property, node.left.computed) === 'pageExtensions') take(node.right)
  })
  const [first, ...rest] = lists
  if (rest.some((list) => list.join('\0') !== first.join('\0'))) throw new Error(`${label} sets pageExtensions to different lists, which can't be told apart without running it: name the app's entries instead`)
  return first ?? DEFAULT_PAGE_EXTENSIONS
}

// `app` (or `pages`) in the app's directory, else in its src/, as findDir looks for it.
const findDir = (host, dir, name) => [join(dir, name), join(dir, 'src', name)].find((path) => isDir(path, host))

// A dirent's file or directory, through a link (null where it leads nowhere).
const statOf = (host, dir, dirent) => (dirent.isSymbolicLink() ? host.stat(join(dir, dirent.name)) : dirent)

// The files under `root`, by their paths relative to it, as recursiveReadDir lists them: a link followed, one leading
// nowhere left out, and any name `skips` takes left out with what is under it. A directory a link leads back to is
// walked once.
function filesUnder(host, root, skips = () => false) {
  const files = []
  const walked = new Set()
  const walk = (dir, real, rel) => {
    if (walked.has(real)) return
    walked.add(real)
    for (const dirent of host.readdir(dir)) {
      if (skips(dirent.name)) continue
      const path = join(dir, dirent.name)
      const sub = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      const stat = statOf(host, dir, dirent)
      // Below a real directory, one that is no link is real too.
      if (stat?.isDirectory()) walk(path, dirent.isSymbolicLink() ? host.realpath(path) : join(real, dirent.name), sub)
      else if (stat?.isFile()) files.push(sub)
    }
  }
  walk(root, host.realpath(root), '')
  return files
}

// The files directly in `dir` (none where it is no directory) whose names `pattern` takes.
const filesIn = (host, dir, pattern) => (isDir(dir, host) ? host.readdir(dir).filter((dirent) => pattern.test(dirent.name) && statOf(host, dir, dirent)?.isFile()).map((dirent) => dirent.name) : [])

// The files Next builds as the entries of the app whose config is `configFile`, by their paths relative to the
// config's directory, sorted; none where that directory has neither an `app` nor a `pages` directory, which no Next
// build takes for an app. `shown` spells a path in an error.
export function nextAppFiles(name, configFile, { host = diskHost, shown = (path) => path } = {}) {
  const dir = dirname(configFile)
  const appDir = findDir(host, dir, 'app')
  const pagesDir = findDir(host, dir, 'pages')
  if (appDir === undefined && pagesDir === undefined) return []
  if (appDir !== undefined && pagesDir !== undefined && dirname(appDir) !== dirname(pagesDir)) {
    throw new Error(`${name}: ${shown(configFile)}: its app's pages and app directories are not in the same directory (${shown(pagesDir)}, ${shown(appDir)}), which Next refuses`)
  }
  const extensions = pageExtensionsOf(configFile, `${name}: ${shown(configFile)}`, host)
  const ext = `\\.(?:${extensions.map((e) => RegExp.escape(e)).join('|')})$`
  const named = (names) => new RegExp(`^(?:${names.join('|')})${ext}`, 'u')
  const files = []
  const add = (at, rel) => files.push(toPosix(relative(dir, join(at, rel))))
  if (appDir !== undefined) {
    const anywhere = named(SEGMENT_FILES)
    const atRoot = named(ROOT_FILES)
    // A private folder (`_components`) is none of the app's routes, nor anything under it.
    for (const rel of filesUnder(host, appDir, (part) => part.startsWith('_'))) {
      const file = basename(rel)
      if (anywhere.test(file) || (file === rel && atRoot.test(file))) add(appDir, rel)
    }
  }
  if (pagesDir !== undefined) {
    const page = new RegExp(ext, 'u')
    for (const rel of filesUnder(host, pagesDir)) {
      if (page.test(rel) && !(rel.endsWith('.d.ts') && extensions.includes('ts'))) add(pagesDir, rel)
    }
  }
  const beside = dirname(appDir ?? pagesDir)
  for (const file of filesIn(host, beside, named(BESIDE_FILES))) add(beside, file)
  // The client's instrumentation: in src/, else beside the config, whichever has one.
  const client = named(['instrumentation-client'])
  for (const at of [join(dir, 'src'), dir]) {
    const found = filesIn(host, at, client)
    for (const file of found) add(at, file)
    if (found.length > 0) break
  }
  files.sort()
  // A page by an extension of pageExtensions that is no JS/TS (`mdx`) is one the scan can't follow.
  const other = files.find((file) => !JS_EXTENSIONS.has(extname(file)))
  if (other !== undefined) throw new Error(`${name}: ${shown(join(dir, other))} is one of the app's entries by ${shown(configFile)}'s pageExtensions, and no JS/TS file the scan can follow: name the app's entries instead`)
  return files
}

// `entries`, each next.config.* among them followed by the files of its app (nextAppFiles), spelled from where the
// entry is; a file given twice, however spelled, is kept where it first is.
export function withNextEntries(name, entries, cwd, host = diskHost) {
  if (!Array.isArray(entries) || !entries.some(isNextConfig)) return entries
  const shown = (path) => toPosix(relative(cwd, path)) || '.'
  const expanded = entries.flatMap((entry) => {
    const abs = resolve(cwd, entry)
    const files = isNextConfig(entry) && isFile(abs, host) ? nextAppFiles(name, abs, { host, shown }) : []
    return [entry, ...files.map((file) => toPosix(join(dirname(entry), file)))]
  })
  return [...Map.groupBy(expanded, (entry) => resolve(cwd, entry)).values()].map(([first]) => first)
}
