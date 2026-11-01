import { test } from 'node:test'
import { PassThrough } from 'node:stream'

import { GITHUB, NPM, OSV, supported } from '../stasis/src/sixel.js'

// What a sixel image draws, as a terminal reads it: each pixel's colour (`r;g;b`, in percent) by `x,y`,
// and its colours, by register. Anything a sixel image can't hold throws.
function draw(t, image) {
  const intro = '\x1bP9;1q"1;1;16;16'
  t.assert.ok(image.startsWith(intro), 'square pixels, its background left as it is, 16 pixels square')
  t.assert.ok(image.endsWith('\x1b\\'), 'ends with ST')
  const colours = new Map()
  const pixels = new Map()
  let colour
  let x = 0
  let y = 0
  const body = image.slice(intro.length, -2)
  for (const [, register, r, g, b, count = '1', sixel, control, other] of body.matchAll(/#(\d+)(?:;2;(\d+);(\d+);(\d+))?|(?:!(\d+))?([?-~])|([$-])|(.)/gsu)) {
    if (other !== undefined) throw new Error(`not sixel data: ${JSON.stringify(other)}`)
    if (register !== undefined) {
      if (r !== undefined) colours.set(register, `${r};${g};${b}`)
      t.assert.ok(colours.has(register), `register ${register} defined before it is drawn in`)
      colour = register
    } else if (control !== undefined) {
      x = 0
      if (control === '-') y += 6
    } else {
      const bits = sixel.charCodeAt(0) - 0x3f
      for (let n = 0; n < Number(count); n++, x++) {
        for (let bit = 0; bit < 6; bit++) {
          if (bits & (1 << bit)) pixels.set(`${x},${y + bit}`, colours.get(colour))
        }
      }
    }
  }
  for (const at of pixels.keys()) {
    const [px, py] = at.split(',').map(Number)
    t.assert.ok(px < 16 && py < 16, `${at} inside the image`)
  }
  return { colours, pixels }
}

test('sixel: three logos, 16 pixels square, in 8 colours at most, their background the terminal\'s', (t) => {
  const BLACK = '9;9;9'
  const WHITE = '100;100;100'
  const RED = '80;22;22'
  const GREY = '55;58;62'
  const OSV_RED = '88;13;16'
  const logos = { GITHUB, NPM, OSV }
  // Each logo's pixels, by `x,y`, as they are known to be: undefined where it leaves the terminal's.
  const known = {
    // simple-icons' #181717, the Octocat white, the corners outside the mark.
    GITHUB: { '7,0': BLACK, '0,7': BLACK, '7,7': WHITE, '6,13': WHITE, '0,0': undefined, '15,15': undefined },
    // simple-icons' #CB3837 to its corners, the n white, red between its legs.
    NPM: { '0,0': RED, '15,15': RED, '5,6': WHITE, '11,10': WHITE, '8,10': RED },
    // The ring grey, apart from the red disc inside it.
    OSV: { '7,0': GREY, '0,7': GREY, '7,4': OSV_RED, '5,4': undefined, '0,0': undefined },
  }
  for (const [name, image] of Object.entries(logos)) {
    const { colours, pixels } = draw(t, image)
    t.assert.ok(colours.size <= 8, `${name}: ${colours.size} colours`)
    t.assert.ok(pixels.size > 128, `${name}: draws most of its square`)
    for (const [at, colour] of Object.entries(known[name])) t.assert.equal(pixels.get(at), colour, `${name} at ${at}`)
  }
})

// A terminal: `input` a TTY stream that takes raw mode (each mode set kept), `output` one that answers
// what is written with `answer`, in the pieces given, each in a turn of its own.
function terminal(...answer) {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, modes: [] })
  input.setRawMode = (mode) => {
    input.isRaw = mode
    input.modes.push(mode)
    return input
  }
  const written = []
  const output = {
    isTTY: true,
    write: (text) => {
      written.push(text)
      for (const piece of answer) setImmediate(() => input.write(piece))
      return true
    },
  }
  return { input, output, written }
}

const env = { TERM: 'xterm-256color' }

test('sixel: supported, as the terminal answers DA1, with 4 among what it has', async (t) => {
  const answers = [
    ['\x1b[?62;4;22c', true, 'foot'],
    ['\x1b[?62;4;9;22c', true, 'xterm.js with its image addon (VS Code)'],
    ['\x1b[?65;4;6;18;22c', true, 'WezTerm'],
    ['\x1b[?1;2;4c', true, 'tmux built with sixel'],
    ['\x1b[?62;22c', false, 'no sixel'],
    ['\x1b[?1;2c', false, 'xterm as a VT100, or screen'],
    ['\x1b[?4;6c', false, 'a VT132: its class 4, not sixel'],
  ]
  await Promise.all(answers.map(async ([answer, sixel, who]) => {
    const { input, output, written } = terminal(answer)
    t.assert.equal(await supported({ input, output, env }), sixel, who)
    t.assert.deepStrictEqual(written, ['\x1b[c'], `${who}: asked DA1, once`)
    t.assert.deepStrictEqual(input.modes, [true, false], `${who}: raw while asked, then as it was`)
    t.assert.equal(input.readableFlowing, false, `${who}: no longer read`)
    t.assert.equal(input.listenerCount('data'), 0, `${who}: its listener gone`)
  }))
})

test('sixel: supported, the answer in pieces, after a key or text like it', async (t) => {
  const pieces = terminal('\x1b', '[?6', '2;4', ';22c')
  t.assert.equal(await supported({ ...pieces, env }), true, 'in pieces')
  const key = terminal('x', '\x1b[?62;4c')
  t.assert.equal(await supported({ ...key, env }), true, 'after a key')
  const pasted = terminal('[?62;4c', '\x1b[?62c')
  t.assert.equal(await supported({ ...pasted, env }), false, 'text like an answer, without its ESC, is not one')
})

test('sixel: not supported where nothing answers in time, or nothing can be asked', async (t) => {
  const silent = terminal()
  t.assert.equal(await supported({ ...silent, env, timeout: 20 }), false, 'no answer in time')
  t.assert.deepStrictEqual(silent.input.modes, [true, false], 'raw mode restored')
  t.assert.equal(silent.input.listenerCount('data'), 0, 'its listener gone')

  const pipe = terminal('\x1b[?62;4c')
  t.assert.equal(await supported({ input: pipe.input, output: new PassThrough(), env }), false, 'output a pipe')
  t.assert.equal(await supported({ input: new PassThrough(), output: pipe.output, env }), false, 'input a pipe')
  t.assert.equal(await supported({ ...pipe, env: { TERM: 'dumb' } }), false, 'a dumb terminal')
  t.assert.deepStrictEqual(pipe.written, [], 'none asked')
  t.assert.deepStrictEqual(pipe.input.modes, [], 'none raw')
})

test('sixel: supported leaves an input already raw and read as it was', async (t) => {
  const { input, output } = terminal('\x1b[?62;4c')
  input.isRaw = true
  input.resume()
  t.assert.equal(await supported({ input, output, env }), true)
  t.assert.equal(input.isRaw, true, 'still raw')
  t.assert.equal(input.readableFlowing, true, 'still read')
})
