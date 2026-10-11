import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { needTools } from '../core/testing';
import { clip } from '../core/media/video.fixtures';
import { tone } from '../core/media/audio.fixtures';
import { boxes, photoPDF, round } from '../core/media/pdf.fixtures';
import type { CropSize } from '../core/settings/schema';
import { ItemEngine } from './items';
import { MediaFiles } from './media-files';
import { applyCrop, cropSource, viewItems, parseCropRequest, parseCropView, parseSavedCropSizes } from './crop';
import { compareSources, parseCompareView } from './compare';

const balanced = { mode: 'balanced', format: 'auto', scale: 1 } as const;
const size = (width: number, height: number, cropRect?: CropSize['cropRect'], name = ''): CropSize => ({ width, height, name, longEdge: false, smartCrop: false, ...(cropRect ? { cropRect } : {}) });
async function fixture(t: TestContext, ...tools: Parameters<typeof needTools>[1][]) {
  if (!needTools(t, 'ffmpeg', 'ffprobe', 'pngquant', 'jpegoptim', 'exiftool', ...tools)) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-crop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'session');
  return { dir, engine: new ItemEngine(root), files: new MediaFiles([root]) };
}
const fetchFile = async (files: MediaFiles, url: string) => Buffer.from(await (await files.handle(new Request(url))).arrayBuffer());
const pngSize = async (bytes: Buffer) => { const meta = await sharp(bytes).metadata(); return [meta.width, meta.height]; };
/** A 400 × 200 image, red on the left half and blue on the right. */
const halves = () => sharp({ create: { width: 400, height: 200, channels: 3, background: '#ff0000' } })
  .composite([{ input: { create: { width: 200, height: 200, channels: 3, background: '#0000ff' } }, left: 200, top: 0 }]).png().toBuffer();

test('checks crop requests against the kind of result', () => {
  const rect = { x: .1, y: .2, width: .5, height: .5 };
  assert.deepEqual(parseCropRequest({ type: 'size', size: size(200, 100, rect, 'Banner') }, 'image'), { type: 'size', size: size(200, 100, rect, 'Banner') });
  assert.deepEqual(parseCropRequest({ type: 'size', size: { width: 0, height: 720, name: '', longEdge: true, smartCrop: false, extra: 'dropped' } }, 'video'), { type: 'size', size: { width: 0, height: 720, name: '', longEdge: true, smartCrop: false } });
  assert.deepEqual(parseCropRequest({ type: 'pdf-aspect', aspectRatio: .5, orientation: 'adaptive', extend: true }, 'pdf'), { type: 'pdf-aspect', aspectRatio: .5, orientation: 'adaptive', extend: true });
  assert.deepEqual(parseCropRequest({ type: 'pdf-rect', rect }, 'pdf'), { type: 'pdf-rect', rect });
  assert.deepEqual(parseCropRequest({ type: 'pdf-uncrop' }, 'pdf'), { type: 'pdf-uncrop' });
  // A region reaching past the edge is pulled back inside the frame.
  assert.deepEqual(parseCropRequest({ type: 'pdf-rect', rect: { x: .8, y: 0, width: .5, height: 1 } }, 'pdf'), { type: 'pdf-rect', rect: { x: .5, y: 0, width: .5, height: 1 } });
  for (const [value, kind, error] of [
    [{ type: 'size', size: size(10, 10) }, 'audio', /Audio files have nothing to crop/],
    [{ type: 'size', size: size(10, 10) }, 'pdf', /Choose how to crop the pages/],
    [{ type: 'pdf-rect', rect }, 'image', /Choose a crop size/],
    [{ type: 'size', size: size(0, 0) }, 'image', /width and a height/],
    [{ type: 'size', size: size(16384, 10) }, 'image', /width and a height/],
    [{ type: 'size', size: size(10.5, 10) }, 'image', /width and a height/],
    [{ type: 'size', size: { ...size(10, 10), name: 'x'.repeat(101) } }, 'image', /name under 100/],
    [{ type: 'size', size: { ...size(10, 10), smartCrop: 'yes' } }, 'image', /valid crop size/],
    [{ type: 'size', size: size(10, 10, { x: -.1, y: 0, width: .5, height: .5 }) }, 'image', /crop region/],
    [{ type: 'size', size: size(10, 10, { x: 0, y: 0, width: 0, height: .5 }) }, 'image', /crop region/],
    [{ type: 'size', size: size(10, 10, { x: 0, y: 0, width: Number.NaN, height: .5 }) }, 'video', /crop region/],
    [{ type: 'pdf-aspect', aspectRatio: 1.5, orientation: 'adaptive', extend: false }, 'pdf', /aspect ratio/],
    [{ type: 'pdf-aspect', aspectRatio: .5, orientation: 'sideways', extend: false }, 'pdf', /orientation/],
    [{ type: 'pdf-aspect', aspectRatio: .5, orientation: 'portrait' }, 'pdf', /orientation/],
    ['crop', 'image', /how to crop/],
  ] as const) assert.throws(() => parseCropRequest(value, kind), error, JSON.stringify(value));
});

test('accepts only named, valid crop sizes for savedCropSizes, and pages and frames for the views', () => {
  const saved = [size(1920, 1080, undefined, '1080p'), { ...size(16, 9, undefined, '16:9'), isAspectRatio: true }];
  assert.deepEqual(parseSavedCropSizes(saved), saved);
  assert.throws(() => parseSavedCropSizes([size(10, 10, undefined, '  ')]), /Name each/);
  assert.throws(() => parseSavedCropSizes(Array(201).fill(size(10, 10, undefined, 'x'))), /up to 200/);
  assert.throws(() => parseSavedCropSizes({ 0: saved[0] }), /up to 200/);
  assert.deepEqual(parseCropView(undefined), { page: 1, time: 0 });
  assert.deepEqual(parseCropView({ page: 3, time: .25 }), { page: 3, time: .25 });
  for (const view of [{ page: 0 }, { page: 1.5 }, { time: 2 }, { time: -1 }, 'page']) assert.throws(() => parseCropView(view), /page or a video frame/);
  assert.deepEqual(parseCompareView({ page: 2 }), { page: 2 });
  assert.throws(() => parseCompareView({ page: -1 }), /page to compare/);
});

test('crops an image from its original, keeps the crop through other changes and drops it on restore', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine, files } = f;
  const id = await engine.importBuffer(await halves(), 'halves.png', 'drop', balanced);
  // The crop window starts from the original, shown upright and at most 2600 pixels long.
  const source = await cropSource(engine.get(id), parseCropView(undefined), files);
  assert.deepEqual([source.width, source.height], [400, 200]);
  assert.deepEqual(await pngSize(await fetchFile(files, source.preview)), [400, 200]);
  const right = { x: .5, y: 0, width: .5, height: 1 };
  await engine.crop(id, { type: 'size', size: size(200, 200, right, 'Right half') });
  let { result } = engine.get(id);
  assert.equal(result.status, 'ready', result.error);
  assert.deepEqual([result.width, result.height, result.options.crop?.name], [200, 200, 'Right half']);
  const { data, info } = await sharp(engine.output(id)).raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) assert.ok(data[i] < 40 && data[i + 2] > 200, 'only the blue half is left');
  // Downscaling and converting keep the crop: they start from the original too.
  await engine.apply(id, { ...result.options, scale: .5 });
  result = engine.get(id).result;
  assert.deepEqual([result.width, result.height], [100, 100]);
  await engine.apply(id, { ...result.options, scale: 1, format: 'webp' });
  result = engine.get(id).result;
  assert.deepEqual([result.format, result.width, result.height], ['webp', 200, 200]);
  // A plain size crops around the centre to the size.
  await engine.crop(id, { type: 'size', size: size(100, 100) });
  assert.deepEqual([engine.get(id).result.width, engine.get(id).result.height], [100, 100]);
  await engine.restore(id);
  result = engine.get(id).result;
  assert.deepEqual([result.width, result.height, result.options.crop], [400, 200, undefined]);
  await engine.apply(id, { ...result.options, scale: .5 });
  assert.deepEqual([engine.get(id).result.width, engine.get(id).result.height], [200, 100]);
});

test('a crop that fails is reported to the crop window instead of closing it', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  const id = await engine.importBuffer(await halves(), 'halves.png', 'drop', balanced);
  await rm(engine.get(id).originalPath);
  await assert.rejects(applyCrop(engine, id, { type: 'size', size: size(200, 200) }), /\S/);
  assert.equal(engine.get(id).result.status, 'error');
});

test('crops a video from its original and previews the cropped frame', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine, files, dir } = f;
  const id = await engine.importPath(await clip(path.join(dir, 'clip.mp4'), { width: 320, height: 240, seconds: 1 }), 'drop', balanced);
  const source = await cropSource(engine.get(id), { page: 1, time: .5 }, files);
  assert.deepEqual([source.width, source.height], [320, 240]);
  assert.deepEqual(await pngSize(await fetchFile(files, source.preview)), [320, 240]);
  const before = engine.get(id).result.preview;
  await engine.crop(id, { type: 'size', size: size(160, 240, { x: 0, y: 0, width: .5, height: 1 }) });
  const { result } = engine.get(id);
  assert.equal(result.status, 'ready', result.error);
  assert.deepEqual([result.width, result.height], [160, 240]);
  assert.notEqual(result.preview, before);
  assert.throws(() => engine.crop(id, { type: 'pdf-uncrop' }), /crop size/);
});

test('crops, extends and uncrops a PDF\'s pages on the current result, showing each page whole', async t => {
  const f = await fixture(t, 'gs'); if (!f) return;
  const { engine, files } = f;
  const id = await engine.importBuffer(Buffer.from(await photoPDF({ pages: 2 })), 'scan.pdf', 'drop', balanced);
  const optimised = engine.get(id).result.outputBytes;
  await engine.crop(id, { type: 'pdf-aspect', aspectRatio: 1, orientation: 'adaptive', extend: false });
  let { result } = engine.get(id);
  assert.equal(result.status, 'ready', result.error);
  assert.equal(result.pages, 2);
  for (const page of await boxes(engine.output(id))) { assert.deepEqual(round(page.crop), { x: 36, y: 0, width: 216, height: 216 }); assert.deepEqual(round(page.media), { x: 0, y: 0, width: 288, height: 216 }); }
  // The crop only changed page boxes, so the optimised images stay.
  assert.ok(Math.abs(result.outputBytes - optimised) < 2000, `${result.outputBytes} vs ${optimised}`);
  const source = await cropSource(engine.get(id), { page: 2, time: 0 }, files);
  assert.deepEqual([source.width, source.height, source.page, source.pages], [288, 216, 2, 2]);
  assert.deepEqual(round(source.initialRect!), { x: .13, y: 0, width: .75, height: 1 });
  assert.deepEqual(source.uncropped, { width: 288, height: 216 });
  const [w, h] = await pngSize(await fetchFile(files, source.preview)) as number[];
  assert.ok(Math.abs(w / h - 288 / 216) < .02, `whole page ${w}×${h}`);
  // Each side of the compare window is the whole rendered page, not the crop box, so a split lines up.
  const compare = await compareSources(engine.get(id), { page: 1 }, files);
  assert.deepEqual([compare.page, compare.pages], [1, 2]);
  const [cw, ch] = await pngSize(await fetchFile(files, compare.result.url)) as number[], [ow, oh] = await pngSize(await fetchFile(files, compare.original.url)) as number[];
  assert.ok(Math.abs(cw / ch - 288 / 216) < .02 && Math.abs(ow / oh - 288 / 216) < .02 && cw === ow && ch === oh, `${cw}×${ch} and ${ow}×${oh}`);
  await engine.crop(id, { type: 'pdf-uncrop' });
  for (const page of await boxes(engine.output(id))) assert.deepEqual(round(page.crop), round(page.media));
  assert.equal((await cropSource(engine.get(id), { page: 1, time: 0 }, files)).uncropped, undefined);
  await engine.crop(id, { type: 'pdf-aspect', aspectRatio: 1, orientation: 'adaptive', extend: true });
  for (const page of await boxes(engine.output(id))) assert.deepEqual(round(page.media), { x: 0, y: -36, width: 288, height: 288 });
  await engine.crop(id, { type: 'pdf-rect', rect: { x: 0, y: 0, width: .5, height: .5 } });
  result = engine.get(id).result;
  assert.equal(result.status, 'ready', result.error);
  for (const page of await boxes(engine.output(id))) assert.deepEqual(round(page.crop), { x: 0, y: 108, width: 144, height: 144 });
  assert.throws(() => engine.crop(id, { type: 'size', size: size(10, 10) }), /paper size/);
});

test('crop and compare work on the file a pipeline left, which is outside the session, and a window can tell each revision', async t => {
  const f = await fixture(t, 'gs'); if (!f) return;
  const { engine, files, dir } = f;
  const id = await engine.importBuffer(Buffer.from(await photoPDF({ pages: 2 })), 'scan.pdf', 'drop', balanced);
  const first = engine.get(id).result.revision!;
  const piped = path.join(dir, 'piped.pdf');
  await writeFile(piped, await photoPDF({ pages: 3 }));
  await engine.runPipeline(id, async () => ({ file: piped, started: piped, anyRan: true, warnings: [] }));
  const afterPipeline = engine.get(id).result, piping = afterPipeline.revision!;
  assert.equal(afterPipeline.status, 'ready', afterPipeline.error);
  assert.ok(piping > first, 'a pipeline result is a new revision');
  assert.equal((await cropSource(engine.get(id), { page: 3, time: 0 }, files)).pages, 3, 'the crop window shows the pipeline\'s file');
  const compare = await compareSources(engine.get(id), { page: 3 }, files);
  assert.equal(compare.pages, 3);
  assert.ok((await fetchFile(files, compare.result.url)).length > 0);
  await engine.crop(id, { type: 'pdf-aspect', aspectRatio: 1, orientation: 'adaptive', extend: false });
  assert.equal(engine.get(id).result.status, 'ready', engine.get(id).result.error);
  assert.equal((await boxes(engine.output(id))).length, 3, 'the crop started from the pipeline\'s file, not the optimised one');
  assert.ok(engine.get(id).result.revision! > piping, 'so does a crop');
});

test('compares originals and results the window can load, and refuses to crop audio', async t => {
  const f = await fixture(t, 'gs'); if (!f) return;
  const { engine, files, dir } = f;
  const image = await engine.importBuffer(await halves(), 'halves.png', 'drop', balanced), entry = engine.get(image);
  const pair = await compareSources(entry, parseCompareView(undefined), files);
  assert.deepEqual(await fetchFile(files, pair.original.url), await readFile(entry.originalPath));
  assert.deepEqual(await fetchFile(files, pair.result.url), await readFile(engine.output(image)));
  assert.deepEqual([pair.original.width, pair.original.height, pair.original.bytes, pair.original.format], [400, 200, entry.result.originalBytes, 'png']);
  // BMP cannot show in an <img>, so it is compared as PNG.
  const bmp = await engine.importBuffer(await sharp(await halves()).raw().toBuffer({ resolveWithObject: true }).then(({ data, info }) => bmpFile(data, info.width, info.height)), 'old.bmp', 'drop', balanced);
  const bmpPair = await compareSources(engine.get(bmp), { page: 1 }, files);
  assert.equal(bmpPair.original.format, 'bmp');
  assert.deepEqual(await pngSize(await fetchFile(files, bmpPair.original.url)), [400, 200]);
  assert.equal((await sharp(await fetchFile(files, bmpPair.original.url)).metadata()).format, 'png');
  const song = await engine.importPath(await tone(path.join(dir, 'song.mp3'), { codec: ['-c:a', 'libmp3lame', '-b:a', '320k'] }), 'drop', balanced);
  const audio = await compareSources(engine.get(song), { page: 1 }, files);
  assert.ok(audio.original.bitrate! >= 300 && audio.result.bitrate! < audio.original.bitrate!, `${audio.original.bitrate} → ${audio.result.bitrate}`);
  assert.equal(audio.original.width, undefined);
  await assert.rejects(cropSource(engine.get(song), { page: 1, time: 0 }, files), /nothing to crop/);
  assert.throws(() => engine.crop(song, { type: 'pdf-uncrop' }), /nothing to crop/);
});

/** A 24-bit bottom-up BMP of RGB pixels. */
function bmpFile(rgb: Buffer, width: number, height: number) {
  const row = Math.ceil(width * 3 / 4) * 4, header = Buffer.alloc(54);
  header.write('BM'); header.writeUInt32LE(54 + row * height, 2); header.writeUInt32LE(54, 10); header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18); header.writeInt32LE(height, 22); header.writeUInt16LE(1, 26); header.writeUInt16LE(24, 28); header.writeUInt32LE(row * height, 34);
  const pixels = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (y * width + x) * 3, to = (height - 1 - y) * row + x * 3;
    pixels[to] = rgb[from + 2]; pixels[to + 1] = rgb[from + 1]; pixels[to + 2] = rgb[from];
  }
  return Buffer.concat([header, pixels]);
}

test('a crop or compare window is sent its own result and no other', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  const a = await engine.importBuffer(await halves(), 'a.png', 'drop', balanced), b = await engine.importBuffer(await halves(), 'b.png', 'drop', balanced);
  assert.deepEqual(viewItems(engine.list(), `crop:${a}`).map(item => item.id), [a]);
  assert.deepEqual(viewItems(engine.list(), `compare:${b}`).map(item => item.id), [b]);
  assert.deepEqual(viewItems(engine.list(), 'crop:gone'), []);
});
