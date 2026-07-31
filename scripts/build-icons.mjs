#!/usr/bin/env node
// Rebuilds every raster icon from the SVG masters in scripts/icons/.
//
// Rasterising needs a browser engine; this uses headless Chrome because it is
// already present on the machines we build on and needs no extra dependency.
// Override the binary with CHROME=/path/to/chrome when it lives elsewhere.
//
//   node scripts/build-icons.mjs
//
// Masters (edit these, then re-run):
//   tau-logo.svg           rounded tile, full lockup  -> 192px and up
//   tau-logo-small.svg     simplified, no prompt rule -> 16/32/48px
//   tau-logo-square.svg    full bleed, normal scale   -> apple-touch-icon
//   tau-logo-maskable.svg  full bleed, 80% safe zone  -> PWA maskable
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// SVG masters live next to this script so they are build inputs, not shipped
// assets; the rasters go into Vite's publicDir and the Tauri bundle folder.
const sources = join(root, 'scripts', 'icons');
const icons = join(root, 'src', 'public', 'icons');
const tauriIcons = join(root, 'src-tauri', 'icons');

const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const chrome = CHROME_CANDIDATES.find((path) => existsSync(path));
if (!chrome) {
  console.error('No Chrome/Chromium found. Set CHROME=/path/to/binary.');
  process.exit(1);
}

// Which master feeds which size. Small sizes use the simplified mark.
const SMALL_CUTOFF = 48;

/** Render an SVG at exactly `size` device pixels via an HTML wrapper. */
async function render(svgPath, size, outPath, scratch) {
  const svg = await readFile(svgPath, 'utf8');
  const page = join(scratch, `page-${size}-${Math.random().toString(36).slice(2)}.html`);
  // Inline the SVG so Chrome lays it out at the exact target box — screenshotting
  // a bare .svg would capture it at intrinsic size and crop instead of scale.
  await writeFile(
    page,
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:transparent}
     svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await run(chrome, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=00000000',
    `--window-size=${size},${size}`,
    `--screenshot=${outPath}`,
    `file://${page}`,
  ]);
}

/** Pack PNG blobs into a multi-resolution .ico (PNG-compressed entries). */
async function buildIco(pngPaths, outPath) {
  const blobs = await Promise.all(pngPaths.map(([, file]) => readFile(file)));
  const count = blobs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const directory = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  blobs.forEach((blob, index) => {
    const size = pngPaths[index][0];
    const entry = 16 * index;
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 0); // 0 encodes 256
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(blob.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += blob.length;
  });

  await writeFile(outPath, Buffer.concat([header, directory, ...blobs]));
}

const scratch = await mkdtemp(join(tmpdir(), 'picode-icons-'));
try {
  const master = join(sources, 'tau-logo.svg');
  const small = join(sources, 'tau-logo-small.svg');
  const square = join(sources, 'tau-logo-square.svg');
  const maskable = join(sources, 'tau-logo-maskable.svg');
  const pick = (size) => (size <= SMALL_CUTOFF ? small : master);

  /** @type {Array<[string, number, string]>} source, size, destination */
  const targets = [
    [pick(16), 16, join(icons, 'favicon-16.png')],
    [pick(32), 32, join(icons, 'favicon-32.png')],
    [square, 180, join(icons, 'apple-touch-icon.png')],
    [pick(192), 192, join(icons, 'tau-192.png')],
    [pick(512), 512, join(icons, 'tau-512.png')],
    [maskable, 512, join(icons, 'tau-maskable-512.png')],
    [pick(32), 32, join(tauriIcons, 'tau-32.png')],
    [pick(192), 192, join(tauriIcons, 'tau-192.png')],
  ];

  for (const [source, size, out] of targets) {
    await render(source, size, out, scratch);
    console.log(`  ${size.toString().padStart(3)}px  ${out.replace(`${root}/`, '')}`);
  }

  // Windows .ico carries its own ladder so Explorer picks the right rung.
  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoParts = [];
  for (const size of icoSizes) {
    const file = join(scratch, `ico-${size}.png`);
    await render(pick(size), size, file, scratch);
    icoParts.push([size, file]);
  }
  await buildIco(icoParts, join(tauriIcons, 'icon.ico'));
  console.log(`  ico    src-tauri/icons/icon.ico (${icoSizes.join(', ')})`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
