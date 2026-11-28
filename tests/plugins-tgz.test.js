// A bundler plugin's State reads a .stasis.tgz bundle as `stasis run` does, with no stasis preload to register a tar
// reader: each plugin registers stasis-plugins' archived.js where nothing has, Metro's transform workers included.
// Each build is spawned through the plugin's test helper, standalone (STASIS_TEST_PRELOAD=0) unless it says otherwise.

import { describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { tgzOfDir } from './stasis-tgz.helper.js'
import { withTmp } from './tmp.helper.js'

const here = dirname(fileURLToPath(import.meta.url))
// No inherited stasis variable, nor a test knob.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_') && !key.startsWith('STASIS_TEST_')))

const spawnNode = async (args, { cwd, env }) => {
  const child = spawn(process.execPath, args, { cwd, env: { ...cleanEnv, ...env } })
  const out = { stdout: [], stderr: [] }
  child.stdout.on('data', (chunk) => out.stdout.push(chunk))
  child.stderr.on('data', (chunk) => out.stderr.push(chunk))
  const [status] = await once(child, 'close')
  const text = (chunks) => stripVTControlCharacters(Buffer.concat(chunks).toString('utf8'))
  return { status, stdout: text(out.stdout), stderr: text(out.stderr) }
}

const PWNED = { 'src/hello.js': 'export const greet = () => "pwned"\n' }
const GRAPH = { modules: [{ path: 'src/entry.js', deps: [['./hello.js', 'src/hello.js']] }, { path: 'src/hello.js', deps: [] }] }

// Each bundler's build of its fixture's src/entry.js (its stasis.lock.json the tgz's), and the output it writes.
const BUILDS = {
  esbuild: { helper: 'esbuild-run.helper.js', fixture: 'esbuild-full', outdir: 'STASIS_TEST_ESBUILD_OUTDIR', output: 'entry.js' },
  webpack: { helper: 'webpack-run.helper.js', fixture: 'webpack-full', outdir: 'STASIS_TEST_WEBPACK_OUTDIR', output: 'bundle.js' },
  webpack5: { helper: 'webpack5-run.helper.js', fixture: 'webpack-full', outdir: 'STASIS_TEST_WEBPACK_OUTDIR', output: 'bundle.js' },
  rollup: { helper: 'rollup-run.helper.js', fixture: 'rollup-full', outdir: 'STASIS_TEST_ROLLUP_OUTDIR', output: 'entry.js' },
  // Metro's serializer half (the main process): it checks each edge Metro resolved against the bundle.
  metro: { helper: 'metro-run.helper.js', fixture: 'metro-full', env: { STASIS_TEST_METRO_GRAPH: JSON.stringify(GRAPH) } },
}

// The fixture copied to `tmp`, its tgz at `name` there in place of its stasis.lock.json, and its src/ removed
// (`withSources`, else kept).
function project(tmp, fixture, { name = 'app.stasis.tgz', files, withSources = false } = {}) {
  cpSync(join(here, 'fixtures', fixture), tmp, { recursive: true })
  writeFileSync(join(tmp, name), tgzOfDir(join(here, 'fixtures', fixture), files))
  rmSync(join(tmp, 'stasis.lock.json'))
  if (!withSources) rmSync(join(tmp, 'src'), { recursive: true })
  return join(tmp, name)
}

const build = (bundler, tmp, options, env = {}) => {
  const { helper, outdir, env: bundlerEnv } = BUILDS[bundler]
  return spawnNode([join(here, helper), 'src/entry.js'], {
    cwd: tmp,
    env: {
      STASIS_TEST_PRELOAD: '0',
      STASIS_TEST_PLUGIN_OPTIONS: JSON.stringify(options),
      ...(outdir && { [outdir]: join(tmp, 'out') }),
      ...bundlerEnv,
      ...env,
    },
  })
}

// What the build wrote of its fixture's hello.js: Metro's mock serializer writes none.
const output = (bundler, tmp) => (BUILDS[bundler].output ? readFileSync(join(tmp, 'out', BUILDS[bundler].output), 'utf8') : 'hello, ')

describe('a plugin build reads a .stasis.tgz bundle', { concurrency: 4 }, () => {
  for (const bundler of Object.keys(BUILDS)) {
    test(`${bundler}: bundle=load serves a .stasis.tgz's files, named by bundleFile or found as the root's stasis.tgz; bundle=frozen holds disk to them`, withTmp(async (t, tmp) => {
      const { fixture } = BUILDS[bundler]
      // Metro reads its modules from disk, held to the bundle (as it does under load), so they stay.
      const tgz = project(tmp, fixture, { withSources: bundler === 'metro' })
      const named = await build(bundler, tmp, { lock: 'none', bundle: 'load', bundleFile: tgz })
      t.assert.equal(named.status, 0, named.stderr)
      t.assert.match(output(bundler, tmp), /hello, /u)

      // The root's, where none is named.
      renameSync(tgz, join(tmp, 'stasis.tgz'))
      const found = await build(bundler, tmp, { lock: 'none', bundle: 'load' })
      t.assert.equal(found.status, 0, found.stderr)

      if (bundler !== 'metro') cpSync(join(here, 'fixtures', fixture, 'src'), join(tmp, 'src'), { recursive: true })
      const frozen = await build(bundler, tmp, { lock: 'none', bundle: 'frozen', bundleFile: join(tmp, 'stasis.tgz') })
      t.assert.equal(frozen.status, 0, frozen.stderr)
      writeFileSync(join(tmp, 'src', 'hello.js'), PWNED['src/hello.js'])
      const drifted = await build(bundler, tmp, { lock: 'none', bundle: 'frozen', bundleFile: join(tmp, 'stasis.tgz') })
      t.assert.notEqual(drifted.status, 0, 'disk otherwise than the tgz fails a frozen bundle')
    }))

    test(`${bundler}: a .stasis.tgz other than its stasis.lock.json's files is refused, naming it, as is a tgz of another name`, withTmp(async (t, tmp) => {
      const { fixture } = BUILDS[bundler]
      const tampered = project(tmp, fixture, { files: PWNED, withSources: bundler === 'metro' })
      const refused = await build(bundler, tmp, { lock: 'none', bundle: 'load', bundleFile: tampered })
      t.assert.notEqual(refused.status, 0)
      t.assert.match(refused.stderr, new RegExp(`${RegExp.escape(tampered)}: stasis: src/hello\\.js does not match the lockfile`, 'u'))
      t.assert.doesNotMatch(refused.stderr, /stasis-core can't/u)

      const misnamed = join(tmp, 'app.tgz')
      writeFileSync(misnamed, tgzOfDir(join(here, 'fixtures', fixture)))
      const other = await build(bundler, tmp, { lock: 'none', bundle: 'load', bundleFile: misnamed })
      t.assert.notEqual(other.status, 0)
      t.assert.match(other.stderr, new RegExp(`${RegExp.escape(misnamed)} is a tgz, which is read as stasis\\.tgz or <name>\\.stasis\\.tgz alone`, 'u'))
    }))
  }

  test('esbuild: a sidecar beside a preload reads its .stasis.tgz; the format names the root\'s stasis.tgz; one is never written', withTmp(async (t, tmp) => {
    const tgz = project(tmp, 'esbuild-full')
    // A preload of no bundle (`stasis-core run --lock=ignore`'s), which reads no tar.
    const sidecar = await build('esbuild', tmp, { bundle: 'load', bundleFile: tgz }, { STASIS_TEST_PRELOAD: '1', STASIS_TEST_PRELOAD_OPTIONS: JSON.stringify({ lock: 'ignore' }) })
    t.assert.equal(sidecar.status, 0, sidecar.stderr)
    t.assert.match(output('esbuild', tmp), /hello, /u)

    // Beside a stasis.code.br, where both would be refused: the format picks the tgz.
    renameSync(tgz, join(tmp, 'stasis.tgz'))
    writeFileSync(join(tmp, 'stasis.code.br'), 'not a bundle')
    const formatted = await build('esbuild', tmp, { lock: 'none', bundle: 'load' }, { EXODUS_STASIS_FORMAT: 'tgz' })
    t.assert.equal(formatted.status, 0, formatted.stderr)

    const written = await build('esbuild', tmp, { lock: 'none', bundle: 'add', bundleFile: join(tmp, 'stasis.tgz') })
    t.assert.notEqual(written.status, 0)
    t.assert.match(written.stderr, /bundle=add writes .*stasis\.tgz, but a \.stasis\.tgz is read \(load or frozen\), never written/u)
  }))

  // Metro's worker half: a worker process, whose load State comes of the env (and stasis.config.json) alone.
  test('metro-transformer: a worker under bundle=load feeds the transform a .stasis.tgz\'s bytes; one tampered with is refused', withTmp(async (t, tmp) => {
    const tgz = project(tmp, 'metro-full', { withSources: true })
    const transform = (bundleFile) => spawnNode([join(here, 'metro-transformer-run.helper.js'), 'src/hello.js'], {
      cwd: tmp,
      env: {
        EXODUS_STASIS_METRO_BASE_TRANSFORMER: join(here, 'metro-mock-transformer.cjs'),
        STASIS_TEST_DISK_BYTES: 'TAMPERED ON DISK',
        EXODUS_STASIS_LOCK: 'none', EXODUS_STASIS_SCOPE: 'full', EXODUS_STASIS_BUNDLE: 'load', EXODUS_STASIS_BUNDLE_FILE: bundleFile,
      },
    })
    const served = await transform(tgz)
    t.assert.equal(served.status, 0, served.stderr)
    t.assert.equal(JSON.parse(served.stdout)[0].received, readFileSync(join(here, 'fixtures', 'metro-full', 'src', 'hello.js'), 'utf8'))

    const tampered = join(tmp, 'tampered.stasis.tgz')
    writeFileSync(tampered, tgzOfDir(join(here, 'fixtures', 'metro-full'), PWNED))
    const refused = await transform(tampered)
    t.assert.notEqual(refused.status, 0)
    t.assert.match(refused.stderr, new RegExp(`${RegExp.escape(tampered)}: stasis: src/hello\\.js does not match the lockfile`, 'u'))
  }))

  // The reader `stasis run` preloads ahead of its loader is the plugins' archived.js: a build reaching that copy, which
  // ran before the loader could see it, would be captured without its graph. So a plugin loads it only where none is.
  test('under stasis run, a plugin installed beside the CLI reaches none of the reader it preloads: its capture attests each edge', withTmp(async (t, tmp) => {
    const install = (name, dir, entries) => {
      for (const entry of entries) {
        if (existsSync(join(dir, entry))) cpSync(join(dir, entry), join(tmp, 'node_modules', name, entry), { recursive: true })
      }
    }
    for (const pkg of ['stasis', 'stasis-core', 'stasis-plugins']) install(`@exodus/${pkg}`, join(here, '..', pkg), ['bin', 'src', 'package.json'])
    // What the run's preloads import, from the store pnpm links them from.
    const archive = realpathSync(join(here, '..', 'stasis-plugins', 'node_modules', '@preventive', 'archive'))
    const lockfile = realpathSync(join(here, '..', 'stasis', 'node_modules', '@preventive', 'lockfile'))
    install('@preventive/archive', archive, ['.'])
    install('@preventive/lockfile', lockfile, ['.'])
    install('@exodus/bytes', realpathSync(join(archive, '..', '..', '@exodus', 'bytes')), ['.'])
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'installed', version: '0.0.0', private: true, type: 'module' }))
    writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages: []\n')
    writeFileSync(join(tmp, 'build.mjs'), "import { StasisEsbuild } from '@exodus/stasis-plugins/esbuild'\nnew StasisEsbuild()\n")

    const cli = join(tmp, 'node_modules', '@exodus', 'stasis', 'bin', 'stasis.js')
    const r = await spawnNode([cli, 'run', '--lock=add', 'build.mjs'], { cwd: tmp })
    t.assert.equal(r.status, 0, r.stderr)
    const lock = JSON.parse(readFileSync(join(tmp, 'stasis.lock.json'), 'utf8'))
    const attested = new Set(Object.entries({ ...lock.sources, ...lock.modules }).flatMap(([dir, { files }]) => Object.keys(files).map((file) => (dir === '.' ? file : `${dir}/${file}`))))
    const targets = Object.values(lock.imports).flatMap((byParent) => Object.values(byParent).flatMap((specifiers) => Object.values(specifiers)))
    t.assert.ok(attested.has('node_modules/@exodus/stasis-plugins/src/plugins.js'), 'the plugin is in scope')
    // Else either an edge to it without its bytes, or its bytes without its own edges (a require() of the cached copy).
    t.assert.ok(!attested.has('node_modules/@exodus/stasis-plugins/src/archived.js'), 'the preloaded reader is not reached')
    t.assert.deepStrictEqual(targets.filter((target) => !attested.has(target)), [], 'no edge without its bytes')
  }))
})
