import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { tgzOfDir } from './stasis-tgz.helper.js'
import { withTmp } from './tmp.helper.js'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'stasis', 'bin', 'stasis.js')
const coreCli = join(here, '..', 'stasis-core', 'bin', 'stasis-core.js')
const fixture = join(here, 'fixtures', 'cli-run')
// No inherited stasis variable, which the CLI's env-conflict guard would trip on.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('EXODUS_STASIS_')))

const run = async (bin, args, cwd) => {
  const child = spawn(process.execPath, [bin, 'run', ...args], { cwd, env })
  const out = { stdout: [], stderr: [] }
  child.stdout.on('data', (chunk) => out.stdout.push(chunk))
  child.stderr.on('data', (chunk) => out.stderr.push(chunk))
  const [status] = await once(child, 'close')
  const text = (chunks) => stripVTControlCharacters(Buffer.concat(chunks).toString('utf8'))
  return { status, stdout: text(out.stdout), stderr: text(out.stderr) }
}
const PWNED = { 'src/hello.js': 'export const greet = () => "pwned"\n' }

test('stasis run --bundle=load serves a .stasis.tgz\'s files, held to its stasis.lock.json, named by --bundle-file or stasis.config.json; --bundle=frozen holds disk to them', withTmp(async (t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  const tgz = join(tmp, 'app.stasis.tgz')
  writeFileSync(tgz, tgzOfDir(fixture))
  // Its files alone: none on disk.
  rmSync(join(tmp, 'src'), { recursive: true })
  const verified = await run(cli, ['--lock=frozen', '--bundle=load', `--bundle-file=${tgz}`, 'src/entry.js'], tmp)
  t.assert.deepStrictEqual([verified.status, verified.stdout], [0, 'hello, world\n'], verified.stderr)
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full', bundleFile: 'app.stasis.tgz' }))
  const configured = await run(cli, ['--lock=ignore', '--bundle=load', 'src/entry.js'], tmp)
  t.assert.deepStrictEqual([configured.status, configured.stdout], [0, 'hello, world\n'], configured.stderr)
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))

  cpSync(join(fixture, 'src'), join(tmp, 'src'), { recursive: true })
  const frozen = await run(cli, ['--lock=frozen', '--bundle=frozen', `--bundle-file=${tgz}`, 'src/entry.js'], tmp)
  t.assert.deepStrictEqual([frozen.status, frozen.stdout], [0, 'hello, world\n'], frozen.stderr)
  writeFileSync(join(tmp, 'src', 'hello.js'), PWNED['src/hello.js'])
  const changed = await run(cli, ['--lock=ignore', '--bundle=frozen', `--bundle-file=${tgz}`, 'src/entry.js'], tmp)
  t.assert.notEqual(changed.status, 0, 'disk otherwise than the tgz fails a frozen bundle')
}))

test('stasis run refuses a .stasis.tgz other than its stasis.lock.json\'s files, one to write, a tgz of another name, and stasis-core one', withTmp(async (t, tmp) => {
  cpSync(fixture, tmp, { recursive: true })
  // Named by stasis.config.json's bundleFile, which the CLI doesn't read, it is refused as the run starts.
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full', bundleFile: 'app.stasis.tgz' }))
  const configured = await run(cli, ['--lock=ignore', '--bundle=add', 'src/entry.js'], tmp)
  t.assert.notEqual(configured.status, 0)
  t.assert.match(configured.stderr, /bundle=add writes app\.stasis\.tgz, but a \.stasis\.tgz is read \(load or frozen\), never written/u)
  writeFileSync(join(tmp, 'stasis.config.json'), JSON.stringify({ scope: 'full' }))
  rmSync(join(tmp, 'src'), { recursive: true })
  const load = (file) => ['--lock=frozen', '--bundle=load', `--bundle-file=${file}`, 'src/entry.js']

  const tampered = join(tmp, 'tampered.stasis.tgz')
  writeFileSync(tampered, tgzOfDir(fixture, PWNED))
  const refused = await run(cli, load(tampered), tmp)
  t.assert.notEqual(refused.status, 0)
  t.assert.match(refused.stderr, new RegExp(`${RegExp.escape(tampered)}: stasis: src/hello\\.js does not match the lockfile`, 'u'))
  t.assert.doesNotMatch(refused.stdout, /pwned/u, 'none of it runs')

  const tgz = join(tmp, 'app.stasis.tgz')
  writeFileSync(tgz, tgzOfDir(fixture))
  const written = await Promise.all(['add', 'replace'].map((mode) => run(cli, [`--bundle=${mode}`, `--bundle-file=${tgz}`, 'src/entry.js'], tmp)))
  const neverWritten = [1, "Error: a .stasis.tgz is read (--bundle=load or frozen), never written\nRun 'stasis --help' for usage.\n"]
  t.assert.deepStrictEqual(written.map(({ status, stderr }) => [status, stderr]), [neverWritten, neverWritten])

  const misnamed = join(tmp, 'app.tgz')
  writeFileSync(misnamed, readFileSync(tgz))
  const other = await run(cli, load(misnamed), tmp)
  t.assert.notEqual(other.status, 0)
  t.assert.match(other.stderr, new RegExp(`stasis: ${RegExp.escape(misnamed)} is a tgz, which is read as stasis\\.tgz or <name>\\.stasis\\.tgz alone`, 'u'))

  const core = await run(coreCli, load(tgz), tmp)
  t.assert.notEqual(core.status, 0)
  t.assert.match(core.stderr, /app\.stasis\.tgz is a \.stasis\.tgz, which only `stasis run` reads/u)
}))
