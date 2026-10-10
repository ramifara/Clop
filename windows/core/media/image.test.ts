import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { run } from '../run';
import { needTools } from '../testing';
import { gifFrameDropArgs, optimiseImage } from './image';
import { animation, graphic, lines, photo } from './image.fixtures';

const at = (factor: number) => ({ tier: 'custom', factor }) as const;
const adaptive = { tier: 'adaptive', factor: 30 } as const;
const lossless = { tier: 'lossless', factor: 30 } as const;
async function workspace(t: TestContext) {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'gifsicle', 'ffmpeg', 'exiftool')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  const file = async (name: string, data: Buffer | Sharp) => { const target = path.join(dir, name); await writeFile(target, Buffer.isBuffer(data) ? data : await data.toBuffer()); return target; };
  return { dir, out, file };
}
const frames = async (file: string) => sharp(file, { animated: true }).metadata();
const pixels = async (file: string) => sharp(file, { animated: true }).raw().toBuffer();
async function tags(file: string, ...names: string[]) {
  const { stdout } = await run('exiftool', ['-j', '-n', ...names.map(name => `-${name}`), file]);
  // exiftool writes SourceFile with forward slashes on Windows; only the tags matter.
  const { SourceFile: _, ...found } = JSON.parse(stdout.toString())[0] as Record<string, unknown>;
  return found;
}

// Recorded with the macOS argument sets on the Linux builds of the bundled tool versions. The Windows
// jpegoptim is built with mozjpeg and its pngquant with zlib instead of zlib-ng, so Windows only logs its sizes.
const RECORDED: [string, number, number][] = [
  ['photo.jpg', 30, 148225], ['photo.jpg', 64, 45604],
  ['graphic.png', 30, 3861], ['graphic.png', 64, 3875],
  ['animation.gif', 30, 6243], ['animation.gif', 64, 5293], ['animation.gif', 85, 3651],
  ['animation.webp', 30, 2148], ['animation.webp', 64, 1944],
];
test('outputs stay within 2% of the sizes recorded for the macOS arguments', async t => {
  const w = await workspace(t); if (!w) return;
  const inputs: Record<string, string> = {
    'photo.jpg': await w.file('photo.jpg', photo(800, 600).jpeg({ quality: 92 })),
    'graphic.png': await w.file('graphic.png', graphic(800, 600).png()),
    'animation.gif': await w.file('animation.gif', await animation('gif')),
    'animation.webp': await w.file('animation.webp', await animation('webp')),
  };
  for (const [name, factor, recorded] of RECORDED) {
    const output = await optimiseImage(inputs[name], w.out, { compression: at(factor), name: `${name}-${factor}` });
    t.diagnostic(`${name} at factor ${factor}: ${output.bytes} bytes (recorded ${recorded})`);
    assert.ok(!output.unchanged && output.bytes < (await stat(inputs[name])).size, `${name} at ${factor} did not shrink`);
    if (process.platform !== 'win32') assert.ok(Math.abs(output.bytes - recorded) / recorded <= 0.02, `${name} at factor ${factor}: ${output.bytes} bytes, recorded ${recorded}`);
  }
});

test('JPEG: aggressive compresses harder, and a result that cannot shrink keeps the input', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('photo.jpg', photo(640, 480).jpeg({ quality: 95 }));
  const progress: number[] = [];
  const normal = await optimiseImage(input, w.out, { compression: at(30), name: 'normal', onProgress: fraction => progress.push(fraction) });
  assert.deepEqual([progress, normal.warnings], [[0, 1], undefined]);
  const aggressive = await optimiseImage(input, w.out, { compression: at(30), aggressive: true, name: 'aggressive' });
  assert.deepEqual([normal.format, normal.path, normal.width, normal.height], ['jpeg', path.join(w.out, 'normal.jpeg'), 640, 480]);
  assert.ok(aggressive.bytes < normal.bytes && normal.bytes < (await stat(input)).size);
  // As in Swift, any smaller result is kept. mozjpeg-based jpegoptim (the Windows build) still shaves a few bytes off its own output.
  const again = await optimiseImage(normal.path, w.out, { compression: at(30), name: 'again' });
  if (again.unchanged) assert.deepEqual(again, { path: normal.path, bytes: normal.bytes, format: 'jpeg', width: 640, height: 480, unchanged: true });
  else assert.ok(again.bytes < normal.bytes && again.path === path.join(w.out, 'again.jpeg'));
  assert.deepEqual((await readdir(w.out)).filter(name => name.startsWith('.clop-')), [], 'temporary files are removed');
});

test('a result that is not smaller keeps the input', async t => {
  const w = await workspace(t); if (!w) return;
  // sharp encodes WebP the same on every platform, and re-encoding a quality-5 WebP at the factor's quality 60 grows it.
  const input = await w.file('rough.webp', photo(320, 240).webp({ quality: 5 }));
  const output = await optimiseImage(input, w.out, { compression: at(30), name: 'rough' });
  assert.deepEqual(output, { path: input, bytes: (await stat(input)).size, format: 'webp', width: 320, height: 240, unchanged: true });
  assert.deepEqual(await readdir(w.out), []);
});

test('strips identifying metadata but keeps orientation, resolution and colour profile', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('tagged.jpg', photo(320, 240).withMetadata({ orientation: 6, density: 300 }).withExif({ IFD0: { Artist: 'Someone', Copyright: 'Them' } }).withIccProfile('p3').jpeg({ quality: 95 }));
  const stripped = await optimiseImage(input, w.out, { compression: at(30), name: 'stripped' });
  const kept = await optimiseImage(input, w.out, { compression: at(30), stripMetadata: false, name: 'kept' });
  const names = ['Artist', 'Orientation', 'XResolution', 'ProfileDescription'];
  assert.deepEqual(await tags(stripped.path, ...names), { Orientation: 6, XResolution: 300, ProfileDescription: 'sP3C' });
  assert.equal((await tags(kept.path, ...names)).Artist, 'Someone');
  assert.deepEqual([stripped.width, stripped.height], [240, 320]);
  const scaled = await optimiseImage(input, w.out, { compression: at(30), width: 120, height: 160, name: 'scaled' });
  assert.deepEqual([scaled.width, scaled.height], [120, 160]);
  assert.equal((await tags(scaled.path, 'Artist')).Artist, undefined);
});

test('the adaptive tier keeps the other format when it saves over 100 KB', async t => {
  const w = await workspace(t); if (!w) return;
  const drawing = await w.file('lines.jpg', lines(1600, 1200).jpeg({ quality: 100 }));
  const picture = await w.file('photo.png', photo(1200, 900).png());
  const transparent = await w.file('transparent.png', photo(1200, 900).ensureAlpha(0.5).png());
  assert.equal((await optimiseImage(drawing, w.out, { compression: adaptive, name: 'drawing' })).format, 'png');
  assert.equal((await optimiseImage(picture, w.out, { compression: adaptive, name: 'picture' })).format, 'jpeg');
  assert.equal((await optimiseImage(transparent, w.out, { compression: adaptive, name: 'transparent' })).format, 'png');
  // Only the adaptive tier, and only when no format was asked for.
  assert.equal((await optimiseImage(drawing, w.out, { compression: at(30), name: 'fixed' })).format, 'jpeg');
  assert.equal((await optimiseImage(picture, w.out, { compression: adaptive, format: 'png', name: 'asked' })).format, 'png');
});

test('GIF frame dropping from factor 80 plays faster or keeps the duration', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('animation.gif', await animation('gif', { frames: 12, delays: Array(12).fill(80), loop: 3 }));
  const faster = await frames((await optimiseImage(input, w.out, { compression: at(85), name: 'faster' })).path);
  assert.equal(faster.pages, 10);
  assert.deepEqual(faster.delay, Array(10).fill(80));
  const steady = await frames((await optimiseImage(input, w.out, { compression: at(85), gifFrameDropBehaviour: 'keepDuration', name: 'steady' })).path);
  assert.equal(steady.pages, 10);
  assert.equal(steady.delay!.reduce((a, b) => a + b), 960);
  assert.equal(steady.loop, 3);
  assert.equal((await frames((await optimiseImage(input, w.out, { compression: at(64), name: 'all' })).path)).pages, 12);
  const scaled = await optimiseImage(input, w.out, { compression: at(30), width: 48, height: 32, name: 'scaled' });
  assert.deepEqual([scaled.width, scaled.height, (await frames(scaled.path)).pages], [48, 32, 12]);
});

test('gifsicle frame selections never drop the first frame or touch short GIFs', () => {
  assert.deepEqual(gifFrameDropArgs(Array(8).fill(100), 2), []);
  assert.deepEqual(gifFrameDropArgs(Array(9).fill(100), 4), ['--delete', '#4', '#8']);
  assert.deepEqual(gifFrameDropArgs([100, 20, 30, 40, 50, 60, 70, 80, 90], 3, 'keepDuration'), ['-d10', '#0', '-d2', '#1', '-d7', '#2', '-d5', '#4', '-d13', '#5', '-d8', '#7', '-d9', '#8']);
  assert.deepEqual(gifFrameDropArgs(Array(9).fill(100), undefined), []);
});

test('animated WebP keeps its frames, timing and loop count, and converts to and from GIF', async t => {
  const w = await workspace(t); if (!w) return;
  const delays = [100, 200, 300, 120, 80, 60, 140, 400];
  const webp = await w.file('animation.webp', await animation('webp', { frames: 8, delays, loop: 2 }));
  const gif = await w.file('animation.gif', await animation('gif', { frames: 8, delays, loop: 2 }));
  const optimised = await frames((await optimiseImage(webp, w.out, { compression: at(30), name: 'optimised' })).path);
  assert.deepEqual([optimised.pages, optimised.delay, optimised.loop], [8, delays, 2]);
  const fromGIF = await optimiseImage(gif, w.out, { compression: at(30), format: 'webp', width: 48, height: 32, name: 'from-gif' });
  const converted = await frames(fromGIF.path);
  assert.deepEqual([fromGIF.format, converted.format, converted.pages, converted.width, converted.pageHeight, converted.delay, converted.loop], ['webp', 'webp', 8, 48, 32, delays, 2]);
  const toGIF = await frames((await optimiseImage(webp, w.out, { compression: at(30), format: 'gif', name: 'to-gif' })).path);
  assert.deepEqual([toGIF.format, toGIF.pages, toGIF.delay, toGIF.loop], ['gif', 8, delays, 2]);
  await assert.rejects(optimiseImage(webp, w.out, { compression: at(30), format: 'png' }), /GIF or WebP/);
});

test('the lossless tier keeps every pixel', async t => {
  const w = await workspace(t); if (!w) return;
  const jpeg = await w.file('photo.jpg', photo(320, 240).jpeg({ quality: 90, optimiseCoding: false }));
  const gif = await w.file('animation.gif', await animation('gif'));
  const jpegOut = await optimiseImage(jpeg, w.out, { compression: lossless, name: 'jpeg' });
  assert.equal(jpegOut.format, 'jpeg');
  assert.ok(jpegOut.bytes < (await stat(jpeg)).size);
  assert.deepEqual(await pixels(jpegOut.path), await pixels(jpeg));
  const gifOut = await optimiseImage(gif, w.out, { compression: lossless, name: 'gif' });
  assert.deepEqual(await pixels(gifOut.path), await pixels(gif));
  // A scaled JPEG cannot stay lossless, so it becomes PNG.
  assert.equal((await optimiseImage(jpeg, w.out, { compression: lossless, width: 160, height: 120, name: 'scaled' })).format, 'png');
});

test('the lossless tier keeps 16-bit samples, colour under transparent pixels, and never squeezes into GIF', async t => {
  const w = await workspace(t); if (!w) return;
  const width = 64, height = 48, deep = new Uint16Array(width * height * 3);
  for (let i = 0; i < deep.length; i++) deep[i] = (i * 2731) % 65536;
  const png16 = await w.file('deep.png', sharp(deep, { raw: { width, height, channels: 3 } }).toColourspace('rgb16').png());
  const deepOut = await optimiseImage(png16, w.out, { compression: lossless, format: 'png', name: 'deep' });
  if (!deepOut.unchanged) assert.equal((await sharp(deepOut.path).metadata()).depth, 'ushort');
  assert.deepEqual(await sharp(deepOut.path).raw({ depth: 'ushort' }).toBuffer(), await sharp(png16).raw({ depth: 'ushort' }).toBuffer());

  // Fully transparent pixels whose colour differs from pixel to pixel.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([i % 251, i % 241, i % 239, i % 8 ? 0 : 255], i);
  const hidden = await w.file('hidden.png', sharp(rgba, { raw: { width, height, channels: 4 } }).png());
  const webp = await optimiseImage(hidden, w.out, { compression: lossless, format: 'webp', name: 'hidden' });
  assert.equal(webp.format, 'webp');
  assert.deepEqual(await sharp(webp.path).raw().toBuffer(), rgba);

  const colourful = await w.file('photo.png', photo(160, 120).png());
  const still = await optimiseImage(colourful, w.out, { compression: lossless, format: 'gif', name: 'still' });
  assert.equal(still.format, 'png');
  assert.deepEqual(await pixels(still.path), await pixels(colourful));
  const animatedWebP = await w.file('animation.webp', await animation('webp', { frames: 4 }));
  const moving = await optimiseImage(animatedWebP, w.out, { compression: lossless, format: 'gif', name: 'moving' });
  assert.deepEqual([moving.format, (await frames(moving.path)).pages], ['webp', 4]);
});

test('with stripping off, a converted image keeps its metadata', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('tagged.jpg', photo(320, 240).withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: 'Someone' } }).jpeg({ quality: 95 }));
  const kept = await optimiseImage(input, w.out, { compression: at(30), format: 'webp', stripMetadata: false, name: 'kept' });
  // sharp applied the rotation, so the copied tags must not rotate the result again.
  assert.deepEqual([await tags(kept.path, 'Artist', 'Orientation'), kept.width, kept.height], [{ Artist: 'Someone', Orientation: 1 }, 240, 320]);
  const stripped = await optimiseImage(input, w.out, { compression: at(30), format: 'webp', name: 'stripped' });
  assert.equal((await tags(stripped.path, 'Artist')).Artist, undefined);
});

test('a downscaled flat PNG is requantized toward its own colours, or the original is kept', async t => {
  const w = await workspace(t); if (!w) return;
  const palette = [[255, 255, 255], [20, 60, 200], [230, 120, 20]];
  const flat = (colour: (x: number, y: number) => number) => {
    const data = Buffer.alloc(800 * 800 * 3);
    for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) data.set(palette[colour(x, y)], (y * 800 + x) * 3);
    return sharp(data, { raw: { width: 800, height: 800, channels: 3 } }).png({ palette: true, colours: 3, dither: 0, compressionLevel: 9 });
  };
  // Scaling blends the stripes into many colours, which pngquant's default 256-colour palette stores in more bytes than the original.
  const stripes = await w.file('stripes.png', flat(x => Math.floor(x / 3) % 2));
  const requantized = await optimiseImage(stripes, w.out, { compression: at(30), width: 584, height: 584, name: 'stripes' });
  assert.deepEqual([requantized.unchanged, requantized.width], [undefined, 584]);
  assert.ok(requantized.bytes < (await stat(stripes)).size);
  const diagonal = await w.file('diagonal.png', flat((x, y) => Math.floor((x + 2 * y) / 5) % 3));
  const kept = await optimiseImage(diagonal, w.out, { compression: at(30), width: 437, height: 437, name: 'diagonal' });
  assert.deepEqual([kept.unchanged, kept.path, kept.width, kept.bytes], [true, diagonal, 800, (await stat(diagonal)).size]);
});

test('an already aborted job never starts', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('photo.jpg', photo(160, 120).jpeg());
  await assert.rejects(optimiseImage(input, w.out, { compression: at(30), signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(readdir(w.out), { code: 'ENOENT' });
});

test('aborting while a tool runs stops it and removes the temporary files', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('large.png', photo(3000, 2000).png({ compressionLevel: 1 }));
  const controller = new AbortController(), progress: number[] = [];
  // Progress 0 arrives once the first tool (pngquant here) has been started.
  const onProgress = (fraction: number) => { progress.push(fraction); controller.abort(); };
  await assert.rejects(optimiseImage(input, w.out, { compression: at(30), signal: controller.signal, onProgress }), { name: 'AbortError' });
  assert.deepEqual(progress, [0]);
  assert.deepEqual(await readdir(w.out), []);
  assert.ok((await readFile(input)).length > 0);
});

test('a failed adaptive comparison is a warning, not a failure', { skip: process.platform === 'win32' && 'replaces jpegoptim with a shell script' }, async t => {
  const w = await workspace(t); if (!w) return;
  const tools = path.join(w.dir, 'tools'), broken = path.join(tools, 'jpegoptim');
  await mkdir(tools);
  await writeFile(broken, '#!/bin/sh\necho "jpegoptim is broken" >&2\nexit 1\n', { mode: 0o755 });
  const previous = process.env.CLOP_TOOLS_DIR;
  process.env.CLOP_TOOLS_DIR = tools;
  t.after(() => { if (previous === undefined) delete process.env.CLOP_TOOLS_DIR; else process.env.CLOP_TOOLS_DIR = previous; });
  const output = await optimiseImage(await w.file('photo.png', photo(320, 240).png()), w.out, { compression: adaptive });
  assert.equal(output.format, 'png');
  assert.equal(output.warnings?.length, 1);
  assert.match(output.warnings![0], /could not try JPEG.*jpegoptim is broken/s);
});

test('works in folders whose names fall outside the ANSI code page', async t => {
  const w = await workspace(t); if (!w) return;
  const dir = path.join(w.dir, 'Zoë 写真');
  for (const [name, image] of [['photo.jpg', photo(160, 120).jpeg({ quality: 95 })], ['graphic.png', graphic(160, 120).png()], ['animation.gif', await animation('gif')]] as const) {
    const input = await w.file(name, image), moved = path.join(dir, name);
    await mkdir(dir, { recursive: true }); await rename(input, moved);
    const output = await optimiseImage(moved, path.join(dir, 'Ergebnisse ü'), { compression: at(64), name: 'résultat' });
    assert.ok(!output.unchanged && output.bytes < (await stat(moved)).size, name);
    assert.equal(path.basename(output.path), `résultat.${output.format}`);
  }
});

test('rejects images it cannot optimise', async t => {
  const w = await workspace(t); if (!w) return;
  const svg = await w.file('vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'));
  await assert.rejects(optimiseImage(svg, w.out, { compression: at(30) }), /SVG/);
});
