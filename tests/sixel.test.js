import { test } from 'node:test'
import { PassThrough } from 'node:stream'

import { GITHUB, NPM, OSV, capabilities, logos, supported } from '../stasis/src/sixel.js'

// What a sixel image draws, as a terminal reads it: each pixel's colour (`r;g;b`, in percent) by `x,y`,
// and its colours, by register; `highest`, the highest register drawn with, blank or not. Anything a sixel
// image can't hold throws.
function draw(t, image, size = 16) {
  const [width, height] = image.slice(0, image.indexOf('#')).split(';').slice(-2).map(Number)
  const intro = `\x1bP9;1q"1;1;${width};${height}`
  t.assert.ok(image.startsWith(intro), 'square pixels, its background left as it is')
  t.assert.equal(width, size, `${size} pixels wide`)
  t.assert.ok(image.endsWith('\x1b\\'), 'ends with ST')
  const colours = new Map()
  const pixels = new Map()
  let colour
  let highest = 0
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
      highest = Math.max(highest, Number(colour))
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
    t.assert.ok(px < width && py < height, `${at} inside the image`)
  }
  return { colours, pixels, height, highest }
}

test('sixel: three logos, 16 pixels square, in 8 colours at most, their background the terminal\'s', (t) => {
  const BLACK = '9;9;9'
  const WHITE = '100;100;100'
  const RED = '80;22;22'
  const GREY = '55;58;62'
  const OSV_RED = '88;13;16'
  const images = { GITHUB, NPM, OSV }
  // Each logo's pixels, by `x,y`, as they are known to be: undefined where it leaves the terminal's.
  const known = {
    // simple-icons' #181717, the Octocat white, the corners outside the mark.
    GITHUB: { '7,0': BLACK, '0,7': BLACK, '7,7': WHITE, '6,13': WHITE, '0,0': undefined, '15,15': undefined },
    // simple-icons' #CB3837 to its corners, the n white, red between its legs.
    NPM: { '0,0': RED, '15,15': RED, '5,6': WHITE, '11,10': WHITE, '8,10': RED },
    // The ring grey, apart from the red disc inside it.
    OSV: { '7,0': GREY, '0,7': GREY, '7,4': OSV_RED, '5,4': undefined, '0,0': undefined },
  }
  for (const [name, image] of Object.entries(images)) {
    const { colours, pixels } = draw(t, image)
    t.assert.ok(colours.size <= 8, `${name}: ${colours.size} colours`)
    t.assert.ok(pixels.size > 128, `${name}: draws most of its square`)
    for (const [at, colour] of Object.entries(known[name])) t.assert.equal(pixels.get(at), colour, `${name} at ${at}`)
  }
})

const SIZES = [12, 14, 16, 20, 24, 28, 32, 40, 48]

// The size of the logos logos() picks for `cell`, and how far they are lowered.
const placed = (cell) => {
  const [width, height] = logos(cell).npm.match(/"1;1;(\d+);(\d+)/u).slice(1).map(Number)
  return [width, height - width]
}

test('sixel: the logos at each size, square, in 8 colours at most, most of each drawn, npm\'s red to its edges', (t) => {
  for (const size of SIZES) {
    // Two cells as wide as the logo, and twice as tall: that size, lowered by half of it.
    const sized = logos({ height: 2 * size, width: size / 2 })
    const top = Math.floor(size / 2)
    for (const [name, image] of Object.entries(sized)) {
      const { colours, pixels, height } = draw(t, image, size)
      t.assert.equal(height, size + top, `${name} at ${size}: lowered by ${top}`)
      t.assert.ok(colours.size <= 8, `${name} at ${size}: ${colours.size} colours`)
      t.assert.ok(pixels.size > size * size * 0.4, `${name} at ${size}: draws most of its square`)
      t.assert.ok([...pixels.keys()].every((at) => Number(at.split(',')[1]) >= top), `${name} at ${size}: nothing above it`)
    }
    const { pixels } = draw(t, sized.npm, size)
    for (const at of [`0,${top + size / 2}`, `${size - 1},${top + size / 2}`]) {
      const [r, g] = pixels.get(at).split(';').map(Number)
      t.assert.ok(r > 70 && g < 35, `npm at ${size}: red at ${at}`)
    }
  }
  t.assert.deepStrictEqual(logos(), { npm: NPM, github: GITHUB, osv: OSV }, '16 pixels, those above, where the cells\' size isn\'t known')
})

test('sixel: logos, the largest fitting two cells with an eighth of a row to spare, lowered by half of what is left', (t) => {
  t.assert.deepStrictEqual(placed(null), [16, 0], 'not known: as they are')
  t.assert.deepStrictEqual(placed({ height: 16, width: 8 }), [14, 1], 'a 16-pixel row: 2 pixels to spare')
  t.assert.deepStrictEqual(placed({ height: 19, width: 10 }), [16, 1], 'xterm.js at 16 pixels a character, in CSS pixels')
  t.assert.deepStrictEqual(placed({ height: 30, width: 14.4 }), [24, 3], 'iTerm2, Monaco 12 on a Retina screen')
  t.assert.deepStrictEqual(placed({ height: 34, width: 15.66 }), [28, 3], 'iTerm2 on a Retina screen: 17 by 7.83 points, two pixels a point')
  t.assert.deepStrictEqual(placed({ height: 40, width: 22 }), [32, 4])
  t.assert.deepStrictEqual(placed({ height: 40, width: 15 }), [28, 6], 'two cells as wide as the icon')
  t.assert.deepStrictEqual(placed({ height: 120, width: 60 }), [48, 36], 'the largest')
  t.assert.deepStrictEqual(placed({ height: 12, width: 6 }), [12, 0], 'none fits: the smallest')
})

test('sixel: logos lowered keep their pixels, each the same many rows lower', (t) => {
  for (const name of ['npm', 'github', 'osv']) {
    const { pixels } = draw(t, logos()[name])
    const lowered = draw(t, logos({ height: 19, width: 10 })[name]).pixels
    t.assert.deepStrictEqual(lowered, new Map([...pixels].map(([at, colour]) => {
      const [x, y] = at.split(',').map(Number)
      return [`${x},${y + 1}`, colour]
    })), name)
  }
})

test('sixel: logos with the background, which iTerm2 draws what a logo leaves undrawn in, and no other terminal draws', (t) => {
  // As iTerm2 reads a sixel image (libsixel's index for none, 255, cut to the highest register drawn with):
  // what a logo leaves undrawn is that register's colour.
  const asITerm2 = (image) => {
    const { colours, pixels, highest } = draw(t, image)
    return (at) => pixels.get(at) ?? colours.get(String(highest))
  }
  t.assert.equal(asITerm2(GITHUB)('0,0'), '57;57;57', 'a corner outside GitHub\'s mark, its highest register\'s colour')
  const fitted = logos(null, '12;12;12')
  for (const name of ['npm', 'github', 'osv']) {
    t.assert.ok(fitted[name].endsWith('$#9;2;12;12;12?\x1b\\'), `${name}: the background a register above its own, drawn with a blank character, last`)
    t.assert.deepStrictEqual(draw(t, fitted[name]).pixels, draw(t, logos()[name]).pixels, `${name}: drawing nothing more`)
  }
  t.assert.equal(asITerm2(fitted.github)('0,0'), '12;12;12', 'the corner the background, in iTerm2')
  t.assert.equal(asITerm2(fitted.github)('7,7'), '100;100;100', 'the Octocat white still')
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

test('sixel: capabilities, in one round trip: sixel as DA1 tells it; a cell\'s size in the pixels sixel images are drawn in', async (t) => {
  const asked = '\x1b]1337;ReportCellSize\x1b\\\x1b[16t\x1b]11;?\x1b\\\x1b[c'
  const answers = [
    // iTerm2: its cell in points, and two pixels a point, which it draws a sixel image's pixels as; its
    // XTWINOPS 16 in points too; its background, as OSC 11 asks it.
    [['\x1b]1337;ReportCellSize=17;7.83;2\x1b\\', '\x1b[6;17;8t', '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\', '\x1b[?62;4c'], { sixel: true, cell: { height: 34, width: 15.66 }, background: '12;12;12' }, 'iTerm2 on a Retina screen'],
    [['\x1b]1337;ReportCellSize=17;8\x07\x1b]11;rgb:ff/FF/ff\x07\x1b[?62;4c'], { sixel: true, cell: { height: 17, width: 8 }, background: '100;100;100' }, 'ReportCellSize with no scale, ended with BEL; two hex digits a colour'],
    [['\x1b[6;19;10t\x1b[?62;4;9;22c'], { sixel: true, cell: { height: 19, width: 10 }, background: null }, 'xterm.js, in CSS pixels, as it draws sixel images'],
    [['\x1b[?62;4;22c'], { sixel: true, cell: null, background: null }, 'DA1 alone'],
    [['\x1b[6;19;10t\x1b[?62;22c'], { sixel: false, cell: { height: 19, width: 10 }, background: null }, 'no sixel'],
    [['\x1b[6;1', '9;10t\x1b[?6', '2;4c'], { sixel: true, cell: { height: 19, width: 10 }, background: null }, 'in pieces'],
    [['[6;19;10t]11;rgb:0/0/0\x1b[?62;4c'], { sixel: true, cell: null, background: null }, 'text like an answer, without its ESC, is not one'],
  ]
  await Promise.all(answers.map(async ([pieces, told, who]) => {
    const { input, output, written } = terminal(...pieces)
    t.assert.deepStrictEqual(await capabilities({ input, output, env }), told, who)
    t.assert.deepStrictEqual(written, [asked], `${who}: asked once, DA1 last`)
    t.assert.deepStrictEqual(input.modes, [true, false], `${who}: raw while asked, then as it was`)
  }))
  const silent = terminal()
  t.assert.deepStrictEqual(await capabilities({ ...silent, env, timeout: 20 }), { sixel: false, cell: null, background: null }, 'no answer in time')
  const pipe = terminal('\x1b[?62;4c')
  t.assert.deepStrictEqual(await capabilities({ input: pipe.input, output: new PassThrough(), env }), { sixel: false, cell: null, background: null }, 'output a pipe')
  t.assert.deepStrictEqual(pipe.written, [], 'none asked')
})

test('sixel: supported leaves an input already raw and read as it was', async (t) => {
  const { input, output } = terminal('\x1b[?62;4c')
  input.isRaw = true
  input.resume()
  t.assert.equal(await supported({ input, output, env }), true)
  t.assert.equal(input.isRaw, true, 'still raw')
  t.assert.equal(input.readableFlowing, true, 'still read')
})
