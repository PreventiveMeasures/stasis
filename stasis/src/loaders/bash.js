// Bash loader: `{ sources, resolutions, missing }` from a set of scripts. A .sh/.bash reference landing
// inside the bundle root must resolve to an in-set script, else it is `missing`; everything else (PATH
// commands, `$VAR` paths, absolute or escaping paths) is best-effort and dropped.

import { applyToDir, collectFromDisk, isFileIn, utf8Of } from './paths.js'

// The capture class excludes backtick, `(` and `)` so a ref inside a command substitution
// (`` `source x.sh` ``, `$(bash x.sh)`) doesn't swallow the closing delimiter.
const SOURCE_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*(?:source|\.)\s+["']?([^\s"';&|#`()]+)["']?/gu
const EXEC_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*(?:\/usr\/bin\/env\s+|\/bin\/|\/usr\/bin\/)?(?:ba)?sh\s+["']?([^\s"';&|#`()]+)["']?/gu
const DIRECT_RE = /(?:^|\n|;|&&|\|\||`|\$\()\s*["']?(\.\.?\/[^\s"';&|#`()]+\.(?:sh|bash))["']?/gu
const COMMENT_RE = /^# Depends on: ([^ ]+\.(?:sh|bash))( |$)/gmu
// Pins a dynamically sourced (`$VAR`) file; `source=/dev/null` is shellcheck's "don't follow".
const SHELLCHECK_SOURCE_RE = /#\s*shellcheck\s[^\n]*?\bsource=["']?([^\s"'#]+)["']?/gu

// `$VAR` expansions and `-flags` are never bundle-able.
export function extractBashCalls(content) {
  const calls = new Set()
  for (const re of [SOURCE_RE, EXEC_RE, DIRECT_RE, COMMENT_RE, SHELLCHECK_SOURCE_RE]) {
    for (const [, ref] of content.matchAll(re)) {
      if (!ref.includes('$') && !ref.startsWith('-') && ref !== '/dev/null') calls.add(ref)
    }
  }
  return [...calls]
}

// A bash reference as a baseDir-relative POSIX path. Existence is checked against `knownFiles`
// (tree mode) or the filesystem under `baseDir` (walk mode); with neither, nothing exists.
export function resolveBashCall(ref, fromFile, { knownFiles, baseDir } = {}) {
  const present = (p) => Boolean(p) && isFileIn(p, knownFiles, baseDir)
  // Null when it escapes baseDir or names baseDir itself.
  const resolveRel = (r) => applyToDir(fromFile, r.split('/')) || null

  // An absolute path is accepted only if it exists in the project (so `/etc/...` is dropped).
  if (ref.startsWith('/')) {
    const stripped = ref.replace(/^\/+/u, '')
    return present(stripped) ? stripped : null
  }
  // Existence deferred to the caller.
  if (ref.includes('/')) return resolveRel(ref)

  const sibling = resolveRel(ref)
  if (present(sibling)) return sibling
  if (sibling !== ref && present(ref)) return ref
  return knownFiles?.values().find((known) => known.slice(known.lastIndexOf('/') + 1) === ref) ?? null
}

// Null-resolving refs are external and tolerated; self-refs and an extensionless `source ./env`
// that isn't there are dropped silently.
export function buildBashTree(sources) {
  const knownFiles = new Set(sources.keys())
  const resolutions = new Map()
  const missing = []
  for (const [path, content] of sources) {
    const specMap = new Map()
    for (const ref of extractBashCalls(content)) {
      // A slash ref resolves unchecked, so a target not in knownFiles is a genuine dangling dep.
      const target = resolveBashCall(ref, path, { knownFiles })
      if (target && knownFiles.has(target)) {
        if (target !== path) specMap.set(ref, target)
      } else if (target && (ref.endsWith('.sh') || ref.endsWith('.bash'))) {
        console.warn(`[loader.bash] Missing file: ${ref} from ${path}`)
        missing.push({ spec: ref, from: path })
      }
    }
    resolutions.set(path, specMap)
  }
  return { sources, resolutions, missing }
}

// A slash ref can resolve to a directory (`source ./lib`).
const BASH_FILES = {
  decode: utf8Of('Shell script'),
  skipped: { ENOENT: '[loader.bash] Missing file', EISDIR: '[loader.bash] Skipping directory reference' },
}

export async function collectBashFilesFromDisk(baseDir, entries) {
  return collectFromDisk(baseDir, entries, BASH_FILES, (relPath, content) =>
    extractBashCalls(content).map((ref) => resolveBashCall(ref, relPath, { baseDir })).filter(Boolean))
}
