// Logos for where an advisory comes from, as `stasis audit` may draw them beside it: sixel images, for a
// terminal that draws them, as supported() asks it.

// Each a sixel image 16 pixels square, prepared once (nothing here converts one): its pixels square (P1 9,
// and raster attributes 1:1), its background left as the terminal has it (P2 1), in 8 colours at most.
// Its edges inside are blended; its outline isn't, as nothing tells a sixel image what it's drawn over, so
// a pixel is drawn where at least half of it is covered.

// npm's registry (upstream's `registry` source): simple-icons' npm (16.36.0, CC0-1.0), #CB3837, its
// knocked-out n filled white.
export const NPM = '\x1bP9;1q"1;1;16;16#1;2;80;22;22#2;2;100;100;100#3;2;91;66;66#4;2;94;78;77#5;2;89;56;56#6;2;92;71;71#7;2;97;88;88#8;2;85;42;42' +
  '#1~~~!10F~~~$#2!4?!4oOOoo$#3???o$#5!4?!8G$#6!12?o$#7!8?__$#8???G!8?G-' +
  '#1~~~!5?~~???~~~$#2!4?!4~???~$#3???~$#4!10?~$#6!12?~-' +
  '#1NNN!5MNNMMMNNN$#3!10?@?@$#4!4?!4@$#5???@$#7!11?@' +
  '\x1b\\'

// A GitHub repository's advisories (`repository`): simple-icons' GitHub (16.36.0, CC0-1.0), #181717, its
// knocked-out Octocat filled white, so that the mark shows on a dark terminal too.
export const GITHUB = '\x1bP9;1q"1;1;16;16#1;2;9;9;9#2;2;100;100;100#3;2;15;15;15#4;2;90;90;90#5;2;45;45;45#6;2;26;26;26#7;2;80;80;80#8;2;57;57;57' +
  '#1_o{CEE!4NEEC{o_$#2!4?o!6_o$#3!5?G!4?G$#4!5?O?OO?O$#5???oG!6?Go$#6???G!8?G$#7!6?O??O-' +
  '#1^~X!9?_x~^$#2???E^^^~~^^^E$#3??E!10?E$#4???H??_??_$#5??_$#6???o_!6?_O$#7!12?H$#8!5?_!4?_-' +
  '#1?@AC!6?FFFB@$#2!4?AAMNNG$#3??@?CL!4?G$#4!6?@??F$#5???A$#6!4?@$#7???@' +
  '\x1b\\'

// OSV (`osv`): OSV's logo as @preventive/triage draws an advisory's source (viewBox 0 75 405 400), its
// ring, `currentColor` there, triage's muted grey (#8b949e).
export const OSV = '\x1bP9;1q"1;1;16;16#1;2;55;58;62#2;2;88;13;16#3;2;98;86;86#4;2;92;43;45#5;2;94;62;63#6;2;88;17;20#7;2;96;74;75#8;2;99;95;95' +
  '#1?o{{MM!4FEM[{o$#2!5?__OO__$#6!7?__-' +
  '#1N~~O!8?o~~N$#2!5?^PooP^E$#3!7?IK$#4!6?I??I$#5!6?C@@C$#7!8?A$#8!7?C-' +
  '#1???CEF!4MFFB@' +
  '\x1b\\'

// Primary Device Attributes (DA1), which a terminal answers `CSI ? 62 ; 4 ; 22 c`, say: its class, then
// what it has, 4 being sixel graphics (tmux's `CSI ? 1 ; 2 ; 4 c` too).
const DA1 = '\x1b[c'
const SIXEL = '4'

// Whether the terminal `output` writes to draws sixel images: whether it answers DA1, asked on `output`
// and read on `input`, with sixel graphics among what it has. Where either is no terminal (a pipe, a
// file) or it is a dumb one (Emacs' shell), nothing is asked; one that hasn't answered in `timeout` ms
// doesn't. Meanwhile `input` is raw, as a terminal answers there, and read, as it is left; a key pressed
// in that time is read with the answer and dropped.
export function supported({ input = process.stdin, output = process.stdout, env = process.env, timeout = 1000 } = {}) {
  if (!input?.isTTY || !output?.isTTY || env.TERM === 'dumb') return Promise.resolve(false)
  const { promise, resolve } = Promise.withResolvers()
  const raw = input.isRaw
  const flowing = input.readableFlowing === true
  let read = ''
  const finish = (answer) => {
    clearTimeout(timer)
    input.off('data', onData)
    input.setRawMode(raw)
    if (!flowing) input.pause()
    resolve(answer)
  }
  // The answer, `CSI ? Ps ; ... c`, may come in pieces, and after a key or another report.
  const onData = (chunk) => {
    read += chunk.toString('latin1')
    for (const { index, 1: params } of read.matchAll(/\[\?([\d;]*)c/gu)) {
      if (read[index - 1] === '\x1b') return finish(params.split(';').slice(1).includes(SIXEL))
    }
  }
  const timer = setTimeout(finish, timeout, false)
  input.setRawMode(true)
  input.on('data', onData)
  input.resume()
  output.write(DA1)
  return promise
}
