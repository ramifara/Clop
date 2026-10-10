import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { run } from '../run';
import { needTools } from '../testing';
import { optimiseImage } from './image';
import { convertImage, cropImage, fitUnderSize, stripImageMetadata, watermarkImage } from './image-ops';
import { watermarkFilters } from './watermark';
import { animation, graphic, photo } from './image.fixtures';

const at = (factor: number) => ({ tier: 'custom', factor }) as const;
const lossless = { tier: 'lossless', factor: 30 } as const;
async function workspace(t: TestContext) {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'gifsicle', 'ffmpeg', 'ffprobe', 'exiftool')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-ops-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  const file = async (name: string, data: Buffer | Sharp) => { const target = path.join(dir, name); await writeFile(target, Buffer.isBuffer(data) ? data : await data.toBuffer()); return target; };
  return { dir, out, file };
}
const raw = (image: Sharp) => image.removeAlpha().raw().toBuffer();
const pixel = async (file: string, x: number, y: number) => { const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)]; };
async function tags(file: string, ...names: string[]) {
  const { stdout } = await run('exiftool', ['-j', '-n', ...names.map(name => `-${name}`), file]);
  const { SourceFile: _, ...rest } = JSON.parse(stdout.toString())[0];
  return rest as Record<string, unknown>;
}

test('crops a rectangle of the upright image, then scales it down to the size', async t => {
  const w = await workspace(t); if (!w) return;
  // Stored 320 × 240 and turned a quarter: displayed 240 × 320.
  const input = await w.file('turned.jpg', photo(320, 240).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }));
  const rect = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };
  const cut = await cropImage(input, w.out, { compression: lossless, format: 'png', cropSize: { width: 0, height: 0, cropRect: rect }, name: 'cut' });
  assert.deepEqual([cut.width, cut.height], [120, 80]);
  assert.deepEqual(await raw(sharp(cut.path)), await raw(sharp(input).autoOrient().extract({ left: 60, top: 160, width: 120, height: 80 })));
  const smaller = await cropImage(input, w.out, { compression: at(30), cropSize: { width: 60, height: 40, cropRect: rect }, name: 'smaller' });
  assert.deepEqual([smaller.format, smaller.width, smaller.height], ['jpeg', 60, 40]);
});

test('smart crop keeps the interesting region where a centre crop would cut it off', async t => {
  const w = await workspace(t); if (!w) return;
  // A flat grey frame with a busy red patch at its right edge.
  const patch = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#e01010' } }).composite([{ input: await graphic(60, 60).png().toBuffer(), left: 10, top: 10 }]).png().toBuffer();
  const input = await w.file('subject.png', sharp({ create: { width: 400, height: 200, channels: 3, background: '#808080' } }).composite([{ input: patch, left: 310, top: 60 }]).png());
  const reds = async (file: string) => { const data = await raw(sharp(file)); let count = 0; for (let i = 0; i < data.length; i += 3) if (data[i] > 200 && data[i + 1] < 40) count++; return count; };
  const smart = await cropImage(input, w.out, { compression: lossless, cropSize: { width: 200, height: 200, smartCrop: true }, name: 'smart' });
  const centre = await cropImage(input, w.out, { compression: lossless, cropSize: { width: 200, height: 200 }, name: 'centre' });
  assert.deepEqual([smart.width, smart.height, centre.width, centre.height], [200, 200, 200, 200]);
  assert.ok(await reds(smart.path) > 1000, 'the attention crop holds the red patch');
  assert.equal(await reds(centre.path), 0);
});

test('long edge and aspect ratio crops, and centred crops of animations', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('photo.jpg', photo(800, 600).jpeg({ quality: 90 }));
  const edge = await cropImage(input, w.out, { compression: at(30), cropSize: { width: 400, height: 0, longEdge: true }, name: 'edge' });
  assert.deepEqual([edge.width, edge.height], [400, 300]);
  const wide = await cropImage(input, w.out, { compression: at(30), cropSize: { width: 16, height: 9, isAspectRatio: true }, name: 'wide' });
  assert.deepEqual([wide.width, wide.height], [800, 450]);
  const gif = await w.file('animation.gif', await animation('gif', { frames: 10, width: 96, height: 64 }));
  const webp = await w.file('animation.webp', await animation('webp', { frames: 10, width: 96, height: 64 }));
  for (const file of [gif, webp]) {
    const square = await cropImage(file, w.out, { compression: at(30), cropSize: { width: 32, height: 32, smartCrop: true }, name: `square-${path.extname(file).slice(1)}` });
    const meta = await sharp(square.path, { animated: true }).metadata();
    assert.deepEqual([square.width, square.height, meta.pages], [32, 32, 10], file);
  }
});

test('watermarks a corner at the requested scale and opacity, and every frame of an animation', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('white.png', sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } }).png());
  const mark = await w.file('mark.png', sharp({ create: { width: 40, height: 20, channels: 4, background: '#0000ffff' } }).png());
  const marked = await watermarkImage(input, w.out, { compression: lossless, watermark: { file: mark, scale: 0.25 }, name: 'marked' });
  // 100 × 50 pixels, 20 pixels in from the bottom right corner.
  assert.deepEqual([await pixel(marked.path, 379, 249), await pixel(marked.path, 280, 230), await pixel(marked.path, 279, 249), await pixel(marked.path, 379, 229)], [[0, 0, 255], [0, 0, 255], [255, 255, 255], [255, 255, 255]]);
  const faint = await watermarkImage(input, w.out, { compression: lossless, watermark: { file: mark, position: 'topLeft', opacity: 0.5, scale: 0.25 }, name: 'faint' });
  const [r, g, b] = await pixel(faint.path, 20, 20);
  assert.ok(Math.abs(r - 128) < 3 && Math.abs(g - 128) < 3 && b === 255, `half-transparent blue over white gave ${r},${g},${b}`);
  assert.deepEqual(await pixel(faint.path, 379, 249), [255, 255, 255]);
  const gif = await w.file('animation.gif', await animation('gif', { frames: 9, width: 120, height: 80 }));
  // Clear of the moving square, so gifsicle has no identical frames to merge.
  const animated = await watermarkImage(gif, w.out, { compression: at(30), watermark: { file: mark, position: 'topLeft', scale: 0.2 }, name: 'animated' });
  const frames = await sharp(animated.path, { animated: true }).metadata();
  assert.deepEqual([animated.format, frames.pages, animated.width, animated.height], ['gif', 9, 120, 80]);
  for (let page = 0; page < 9; page += 4) {
    const { data } = await sharp(animated.path, { page }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const [cr, cg, cb] = data.subarray((25 * 120 + 30) * 3, (25 * 120 + 30) * 3 + 3);
    assert.ok(cr < 40 && cg < 40 && cb > 200, `frame ${page} has ${cr},${cg},${cb} under the watermark`);
  }
  await assert.rejects(watermarkImage(input, w.out, { compression: at(30), watermark: { file: path.join(w.dir, 'missing.png') } }), /not found/);
  // ffmpeg's watermark width is truncated, as watermarkWithFFmpeg computes it.
  assert.equal(watermarkFilters(333, { file: mark }).scale.split(':')[0], 'scale=49');
});

test('stripping keeps DPI, orientation and colour; keeping copies every tag but an obsolete rotation', async t => {
  const w = await workspace(t); if (!w) return;
  const png = await w.file('dense.png', graphic(320, 240).withMetadata({ density: 144 }).withExif({ IFD0: { Artist: 'Someone' } }).png());
  const optimised = await optimiseImage(png, w.out, { compression: at(30), name: 'dense' });
  assert.deepEqual(await tags(optimised.path, 'PixelsPerUnitX', 'Artist'), { PixelsPerUnitX: 5669 });
  const scaled = await optimiseImage(png, w.out, { compression: at(30), width: 160, height: 120, format: 'webp', name: 'scaled' });
  assert.deepEqual(await tags(scaled.path, 'XResolution', 'Artist'), { XResolution: 144 });
  const jpeg = await w.file('turned.jpg', photo(320, 240).withMetadata({ orientation: 6, density: 300 }).withExif({ IFD0: { Artist: 'Someone' } }).withIccProfile('p3').jpeg({ quality: 95 }));
  const converted = await optimiseImage(jpeg, w.out, { compression: at(30), format: 'webp', stripMetadata: false, name: 'kept' });
  assert.deepEqual(await tags(converted.path, 'Artist', 'XResolution', 'Orientation', 'ProfileDescription'), { Artist: 'Someone', XResolution: 300, ProfileDescription: 'sP3C' });
  assert.deepEqual([converted.width, converted.height], [240, 320]);
  const stripped = await stripImageMetadata(jpeg, w.out, { name: 'stripped' });
  assert.deepEqual(await tags(stripped.path, 'Artist', 'XResolution', 'Orientation', 'ProfileDescription'), { XResolution: 300, Orientation: 6, ProfileDescription: 'sP3C' });
  assert.deepEqual([stripped.format, stripped.width, stripped.height], ['jpeg', 240, 320]);
  assert.ok(stripped.bytes < (await stat(jpeg)).size);
});

test('fits under a size with the gentlest compression that fits, scaling down only when compression is not enough', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('photo.jpg', photo(1200, 900).jpeg({ quality: 95 }));
  const aggressive = await optimiseImage(input, w.out, { compression: at(64), name: 'aggressive' });
  const strongest = await optimiseImage(input, w.out, { compression: at(100), name: 'strongest' });
  // Already small enough at the aggressive factor.
  const easy = await fitUnderSize(input, w.out, { bytes: aggressive.bytes + 1, name: 'easy' });
  assert.deepEqual([easy.bytes, easy.width], [aggressive.bytes, 1200]);
  const between = Math.round((aggressive.bytes + strongest.bytes) / 2);
  const searched = await fitUnderSize(input, w.out, { bytes: between, name: 'searched' });
  assert.ok(searched.bytes <= between && searched.bytes > strongest.bytes, `${searched.bytes} bytes for a ${between}-byte limit (factor 100 gives ${strongest.bytes})`);
  assert.deepEqual([searched.width, searched.path], [1200, path.join(w.out, 'searched.jpeg')]);
  const tiny = await fitUnderSize(input, w.out, { bytes: Math.round(strongest.bytes / 4), name: 'tiny' });
  assert.ok(tiny.bytes <= strongest.bytes / 4 && tiny.width! < 1200 && Math.abs(tiny.width! / tiny.height! - 4 / 3) < 0.01, `${tiny.bytes} bytes at ${tiny.width}×${tiny.height}`);
  assert.deepEqual((await readdir(w.out)).filter(name => name.startsWith('.')), [], 'attempts are removed');
});

test('converting refuses the image\'s own format', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('photo.jpg', photo(160, 120).jpeg({ quality: 90 }));
  await assert.rejects(convertImage(input, w.out, { compression: at(30), format: 'jpeg' }), /already JPEG/);
  const webp = await convertImage(input, w.out, { compression: at(30), format: 'webp' });
  assert.deepEqual([webp.format, webp.width], ['webp', 160]);
});
