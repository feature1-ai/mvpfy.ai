// Build the walkthrough GIF the README shows, from whatever you captured.
//
// Two ways in, because the two ways people record a desktop app are a handful
// of screenshots and one screen recording:
//
//   docs/media/frames/*.png   → one frame each, held for --hold seconds
//   docs/media/source.mov     → a recording, sampled at --fps
//
// Frames win if both are there. Everything is scaled to --width and palletised
// (ffmpeg's palettegen/paletteuse), which is the difference between a 3 MB GIF
// and a 30 MB one nobody will wait for on a README.
//
// Usage: npm run media:gif -- [--width 1200] [--hold 2.2] [--fps 12]

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MEDIA = path.join(process.cwd(), 'docs', 'media');
const FRAMES = path.join(MEDIA, 'frames');
const OUT = path.join(MEDIA, 'mvpfy.gif');

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const width = flag('width', 1200);
const hold = flag('hold', 2.2);
const fps = flag('fps', 12);

const ffmpeg = (args) => execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });

// Scale to an even width (GIF palettes are happier, and some filters insist),
// then two passes: generate a palette for the whole clip, then apply it.
const filters = `fps=${fps},scale=${width}:-2:flags=lanczos`;

function frameInputs() {
  if (!fs.existsSync(FRAMES)) return null;
  const shots = fs
    .readdirSync(FRAMES)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort();
  if (shots.length === 0) return null;
  // A concat list holds each still for `hold` seconds. The last one is repeated
  // because ffmpeg's concat demuxer ignores the final duration.
  const list = path.join(MEDIA, '.frames.txt');
  const lines = shots.flatMap((f) => [`file '${path.join(FRAMES, f)}'`, `duration ${hold}`]);
  lines.push(`file '${path.join(FRAMES, shots[shots.length - 1])}'`);
  fs.writeFileSync(list, lines.join('\n'));
  return { args: ['-f', 'concat', '-safe', '0', '-i', list], cleanup: () => fs.rmSync(list, { force: true }), what: `${shots.length} frames` };
}

function recordingInputs() {
  const source = ['source.mov', 'source.mp4', 'source.m4v']
    .map((f) => path.join(MEDIA, f))
    .find((f) => fs.existsSync(f));
  return source ? { args: ['-i', source], cleanup: () => {}, what: path.basename(source) } : null;
}

const input = frameInputs() ?? recordingInputs();
if (!input) {
  console.error(
    [
      'Nothing to build from. Put either:',
      `  • screenshots in ${path.relative(process.cwd(), FRAMES)}/ — named so they sort in order (01-plan.png, 02-board.png, …)`,
      `  • or a screen recording at ${path.relative(process.cwd(), MEDIA)}/source.mov`,
      '',
      'On macOS, ⇧⌘5 records a window; screenshots of a window are ⇧⌘4 then Space.',
    ].join('\n')
  );
  process.exit(1);
}

fs.mkdirSync(MEDIA, { recursive: true });
const palette = path.join(MEDIA, '.palette.png');
try {
  ffmpeg([...input.args, '-vf', `${filters},palettegen=stats_mode=diff`, palette]);
  ffmpeg([
    ...input.args,
    '-i',
    palette,
    '-lavfi',
    `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    '-loop',
    '0',
    OUT,
  ]);
} finally {
  fs.rmSync(palette, { force: true });
  input.cleanup();
}

const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
console.log(`${path.relative(process.cwd(), OUT)} — ${mb} MB, from ${input.what} at ${width}px`);
if (Number(mb) > 10) {
  console.log('Over 10 MB: GitHub will serve it, but slowly. Try --width 960 or fewer frames.');
}
