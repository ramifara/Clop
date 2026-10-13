import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { looksLikeSVG, sharpInput, SVG_LIMIT, SVGTooLargeError } from './sharp-input';
import { probeImage, readableImage, toPNG } from './image-codecs';
import { watermarkOverlay } from './watermark';

const svg = (body = '<circle cx="30" cy="20" r="15" fill="#36c"/>') => `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40">${body}</svg>`;

test('an SVG is told by its content, as libvips tells it, whatever its name', () => {
  assert.equal(looksLikeSVG(Buffer.from(svg())), true);
  assert.equal(looksLikeSVG(Buffer.from(`﻿<?xml version="1.0"?>\n<!-- drawn by hand -->\n<!DOCTYPE svg>\n<SVG width="1" height="1"/>`)), true, 'a prolog, a comment, a doctype and any case');
  assert.equal(looksLikeSVG(gzipSync(svg())), true, 'SVGZ');
  const large = gzipSync(svg(Array.from({ length: 3000 }, (_, i) => `<rect x="${i}" y="${i % 40}" width="3" height="3"/>`).join('')));
  assert.equal(looksLikeSVG(large.subarray(0, 1000)), true, 'the first 1000 bytes of a large SVGZ are enough');
  assert.equal(looksLikeSVG(Buffer.from(`<?xml version="1.0"?>${' '.repeat(1000)}<svg/>`)), false, 'only the first 1000 bytes count');
  assert.equal(looksLikeSVG(Buffer.from('<html><body>not a drawing</body></html>')), false);
  assert.equal(looksLikeSVG(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), false);
  assert.equal(looksLikeSVG(Buffer.alloc(0)), false);
});

test('sharp gets an SVG\'s bytes and any other image\'s path; an SVG over the limit is refused by name', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-sharp-input-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Named as something else: the content decides.
  const drawing = path.join(dir, 'drawing.png'), photo = path.join(dir, 'photo.png'), huge = path.join(dir, 'huge.svg');
  await writeFile(drawing, svg());
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#a06040' } }).png().toFile(photo);
  const bytes = await sharpInput(drawing);
  assert.ok(Buffer.isBuffer(bytes) && bytes.equals(Buffer.from(svg())));
  assert.equal(await sharpInput(photo), photo);
  assert.deepEqual([(await sharp(bytes).metadata()).format, (await probeImage(drawing)).width], ['svg', 60]);
  await writeFile(huge, svg());
  await truncate(huge, SVG_LIMIT + 1);
  await assert.rejects(sharpInput(huge), (error: Error) => error instanceof SVGTooLargeError && /^huge\.svg is an SVG larger than 10 MB, which Clop does not open\.$/.test(error.message));
  await assert.rejects(probeImage(huge), SVGTooLargeError, 'probing says why rather than that it is no image');
  await truncate(huge, SVG_LIMIT);
  assert.ok(Buffer.isBuffer(await sharpInput(huge)), 'the limit itself is allowed');
  // What reads SVGs through it still reads them: a watermark drawn as an SVG, and an SVG made PNG.
  const overlay = await watermarkOverlay({ file: drawing }, 600, 400);
  assert.equal((await sharp(overlay.input as Buffer).metadata()).format, 'png');
  const decoded = path.join(dir, 'decoded');
  await mkdir(decoded); await writeFile(path.join(decoded, 'logo.svg'), svg());
  const { file } = await readableImage(path.join(decoded, 'logo.svg'), 'svg');
  assert.deepEqual([path.basename(file), (await sharp(file).metadata()).width], ['decoded.png', 60]);
});

// On Windows a file librsvg opened itself stays open in any tool started while it read, and cannot be renamed until that tool exits.
test('reading, decoding and previewing an SVG leaves nothing open in a tool started meanwhile', { skip: process.platform !== 'win32' && 'Windows only: elsewhere handles are not inherited and an open file can be renamed' }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-svg-handles-'));
  const tools: ChildProcess[] = [];
  t.after(async () => { for (const tool of tools) tool.kill(); await rm(dir, { recursive: true, force: true, maxRetries: 10 }); });
  // Large enough that librsvg takes a while over it, so tools start while it reads.
  const drawing = svg(Array.from({ length: 20000 }, (_, i) => `<rect x="${(i * 37) % 60}" y="${(i * 53) % 40}" width="3" height="3" fill="#${(i * 2654435761 % 0xffffff).toString(16).padStart(6, '0')}"/>`).join(''));
  const reads: [string, (file: string) => Promise<unknown>][] = [
    ['probeImage', file => probeImage(file)],
    ['readableImage', file => readableImage(file, 'svg')],
    ['toPNG', file => toPNG(file, path.join(path.dirname(file), 'preview.png'))],
  ];
  for (const [name, read] of reads) {
    const folder = path.join(dir, name), file = path.join(folder, 'logo.svg');
    await mkdir(folder); await writeFile(file, drawing);
    let reading = true;
    // Each tool lives about two seconds, far longer than the rename below takes.
    const starter = (async () => { while (reading) { tools.push(spawn('ping', ['-n', '3', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })); await new Promise(resolve => setTimeout(resolve, 5)); } })();
    try { await read(file); } finally { reading = false; await starter; }
    await rename(file, `${file}.moved`);
    await rename(`${file}.moved`, file);
  }
});
