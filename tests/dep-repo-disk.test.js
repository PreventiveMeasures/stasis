import { test } from 'node:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bundle } from '@exodus/stasis-core/bundle'
import { buildPhpBundle, buildSolidityBundle } from '../stasis/src/cmd/bundle.js'

// `stasis bundle` from disk records a dependency's commit where something there names it, beside the
// GitHub repository it is from, at that repository's root: a Foundry lib/ submodule's checkout (its
// HEAD), a Soldeer git dependency's soldeer.lock `rev`, and a Composer package's git `source`
// reference, which composer.lock or installed.json records.

const here = dirname(fileURLToPath(import.meta.url))
const solidityFixture = join(here, 'fixtures', 'solidity-bundle', 'with-deps-ecosystems')
const phpFixture = join(here, 'fixtures', 'php-bundle', 'composer-lock')
const COMMIT = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

const withTmp = (fn) => async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'stasis-dep-repo-disk-'))
  try {
    return await fn(t, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// A bucket's `repo` as plain data, as a written bundle records it.
const repoOf = (bundle, dir) => {
  const repo = Bundle.parse(bundle.serialize()).modules.get(dir).repo
  return repo === undefined ? undefined : { ...repo }
}

const SUBMODULE = 'lib/openzeppelin-contracts'
const SOLDEER = 'dependencies/solmate-6.8.0'
const buildSolidity = (cwd) => buildSolidityBundle({ cwd, entries: ['src/A.sol'], mappingFile: 'remappings.txt' })

test("a lib/ submodule records the repository .gitmodules names, at its root, at its checkout's HEAD", withTmp(async (t, tmp) => {
  cpSync(solidityFixture, tmp, { recursive: true })
  t.assert.equal(repoOf(await buildSolidity(tmp), SUBMODULE), undefined, 'no checkout (forge install --no-git): none')
  // As `git submodule update` leaves one: a gitdir file, and HEAD detached at the superproject's commit.
  write(join(tmp, SUBMODULE, '.git'), `gitdir: ../../.git/modules/${SUBMODULE}\n`)
  const gitDir = join(tmp, '.git', 'modules', SUBMODULE)
  write(join(gitDir, 'HEAD'), `${COMMIT}\n`)
  const bundle = await buildSolidity(tmp)
  t.assert.deepStrictEqual(repoOf(bundle, SUBMODULE), { github: 'OpenZeppelin/openzeppelin-contracts', directory: '', commit: COMMIT })
  t.assert.equal(bundle.modules.get(SUBMODULE).ecosystem, 'github')
  // On a branch, at its packed ref.
  write(join(gitDir, 'HEAD'), 'ref: refs/heads/master\n')
  write(join(gitDir, 'packed-refs'), `# pack-refs with: peeled fully-peeled sorted\n${OTHER} refs/heads/master\n`)
  t.assert.equal(repoOf(await buildSolidity(tmp), SUBMODULE).commit, OTHER)
  // A HEAD that names no full commit records nothing: a commit is all the checkout adds.
  write(join(gitDir, 'HEAD'), 'abc1234\n')
  t.assert.equal(repoOf(await buildSolidity(tmp), SUBMODULE), undefined)
}))

test('a Soldeer git dependency records the GitHub repository soldeer.lock names, at its root, at its rev, where its checkout is there', withTmp(async (t, tmp) => {
  cpSync(solidityFixture, tmp, { recursive: true })
  const lock = (entry) => write(join(tmp, 'soldeer.lock'), `[[dependencies]]\nname = "solmate"\nversion = "6.8.0"\n${entry}`)
  // As Soldeer clones one: a git repository of its own, its HEAD at `head`.
  const checkout = (head) => write(join(tmp, SOLDEER, '.git', 'HEAD'), `${head}\n`)
  checkout(COMMIT)
  t.assert.equal(repoOf(await buildSolidity(tmp), SOLDEER), undefined, 'no soldeer.lock: none')
  lock(`git = "https://github.com/transmissions11/solmate.git"\nrev = "${COMMIT}"\n`)
  const bundle = await buildSolidity(tmp)
  t.assert.deepStrictEqual(repoOf(bundle, SOLDEER), { github: 'transmissions11/solmate', directory: '', commit: COMMIT })
  t.assert.equal(bundle.modules.get(SOLDEER).ecosystem, 'soldeer')
  // A checkout left at another commit, as `soldeer install` leaves one until it is reinstalled, or
  // none: the lockfile's rev is not what is there.
  checkout(OTHER)
  t.assert.equal(repoOf(await buildSolidity(tmp), SOLDEER), undefined, 'a checkout at another commit')
  rmSync(join(tmp, SOLDEER, '.git'), { recursive: true })
  t.assert.equal(repoOf(await buildSolidity(tmp), SOLDEER), undefined, 'no checkout')
  checkout(COMMIT)
  // Nothing recorded, and nothing refused, where the lockfile names no GitHub repository at a full
  // commit, or is none Soldeer writes.
  for (const [entry, why] of [
    [`git = "https://gitlab.com/o/solmate.git"\nrev = "${COMMIT}"\n`, 'not GitHub'],
    ['git = "https://github.com/transmissions11/solmate.git"\nrev = "abc1234"\n', 'an abbreviated rev'],
    [`git = "https://github.com/transmissions11/solmate.git"\nrev = ${JSON.stringify(COMMIT)}\nrev = "x"\n`, 'not one Soldeer writes'],
  ]) {
    lock(entry)
    // eslint-disable-next-line no-await-in-loop -- each build reads the soldeer.lock just written
    t.assert.equal(repoOf(await buildSolidity(tmp), SOLDEER), undefined, why)
  }
}))

test('a Composer package records the GitHub repository of its git source, at its root, at the reference it is installed at', withTmp(async (t, tmp) => {
  cpSync(phpFixture, tmp, { recursive: true })
  const LIB = 'vendor/acme/lib'
  const buildPhp = async () => repoOf(await buildPhpBundle({ cwd: tmp, entries: ['index.php'] }), LIB)
  // acme/lib as Packagist locks a package from GitHub, in composer.lock and installed.json alike:
  // its dist at `dist`, a reference, null for one with none, or false for no dist; installed from
  // `from`, as installed.json says.
  const relock = ({ url = 'https://github.com/acme/lib.git', reference = COMMIT, dist = reference, from = 'dist' } = {}) => {
    for (const file of ['composer.lock', 'vendor/composer/installed.json']) {
      const path = join(tmp, file)
      if (!existsSync(path)) continue
      const json = JSON.parse(readFileSync(path, 'utf8'))
      const at = json.packages.findIndex((p) => p.name === 'acme/lib')
      // In the order Composer writes a package's keys, as the lockfile is held to.
      const { name, version, source: _source, dist: _dist, 'transport-options': _transport, ...rest } = json.packages[at]
      json.packages[at] = {
        name,
        version,
        source: { type: 'git', url, reference },
        ...(dist === false ? {} : { dist: { type: 'zip', url: 'https://example.com/acme/lib.zip', ...(dist === null ? {} : { reference: dist }), shasum: '' } }),
        ...rest,
        ...(file === 'composer.lock' ? {} : { 'installation-source': from }),
      }
      writeFileSync(path, `${JSON.stringify(json, null, 4)}\n`)
    }
  }
  t.assert.equal(await buildPhp(), undefined, 'from a path repository: none')
  relock()
  t.assert.deepStrictEqual(await buildPhp(), { github: 'acme/lib', directory: '', commit: COMMIT })
  t.assert.equal(repoOf(await buildPhpBundle({ cwd: tmp, entries: ['index.php'] }), '.'), undefined, 'the root package records none')
  relock({ url: 'git@github.com:acme/lib.git' })
  t.assert.deepStrictEqual(await buildPhp(), { github: 'acme/lib', directory: '', commit: COMMIT }, "git's scp-like URL")
  relock({ dist: OTHER })
  t.assert.equal(await buildPhp(), undefined, 'a dist at another reference: which was installed is unknown')
  relock({ dist: null })
  t.assert.equal(await buildPhp(), undefined, 'a dist at no reference: an archive no commit is known of')
  relock({ dist: false })
  t.assert.deepStrictEqual(await buildPhp(), { github: 'acme/lib', directory: '', commit: COMMIT }, 'no dist: installed from its source')
  // Installed from its source, Composer checked out its reference, whatever its dist is.
  for (const dist of [OTHER, null]) {
    relock({ dist, from: 'source' })
    // eslint-disable-next-line no-await-in-loop -- each build reads the lockfile just written
    t.assert.deepStrictEqual(await buildPhp(), { github: 'acme/lib', directory: '', commit: COMMIT }, `installed from source, a dist at ${dist}`)
  }
  relock({ url: 'https://gitlab.com/acme/lib.git' })
  t.assert.equal(await buildPhp(), undefined, 'not GitHub')
  // installed.json alone, as Composer 1 leaves it: as it says.
  relock({ dist: OTHER, from: 'source' })
  rmSync(join(tmp, 'composer.lock'))
  t.assert.deepStrictEqual(await buildPhp(), { github: 'acme/lib', directory: '', commit: COMMIT }, 'installed from source')
  relock({ dist: OTHER })
  t.assert.equal(await buildPhp(), undefined, 'installed from a dist at another reference')
}))
