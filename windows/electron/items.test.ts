import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { run } from '../core/run';
import { needTools } from '../core/testing';
import { defaultSettings } from '../core/settings/schema';
import { clip } from '../core/media/video.fixtures';
import { coverImage, tone } from '../core/media/audio.fixtures';
import { photoPDF } from '../core/media/pdf.fixtures';
import { ItemEngine, sampleImage } from './items';
import { placeholder } from './thumbnails';
import { importClipboardImages, replacedClipboardImages, serial } from './clipboard';
const balanced = { mode: 'balanced', format: 'auto', scale: 1 } as const;
async function fixture(t: TestContext) {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'gifsicle', 'ffmpeg', 'exiftool')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-engine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { engine: new ItemEngine(dir), dir };
}
test('optimises an image, resizes from the original and restores exact source bytes', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f, original = await sampleImage();
  const id = await engine.importBuffer(original, 'study.png', 'drop', balanced);
  assert.equal(engine.get(id).result.status, 'ready');
  assert.ok(engine.get(id).result.outputBytes < original.length);
  await engine.apply(id, { ...balanced, scale: .25 });
  assert.deepEqual([engine.get(id).result.width, engine.get(id).result.height], [600, 400]);
  await engine.apply(id, { ...balanced, scale: .75 });
  assert.deepEqual([engine.get(id).result.width, engine.get(id).result.height], [1800, 1200]);
  await engine.restore(id);
  assert.deepEqual(await readFile(engine.output(id)), original);
  assert.equal(engine.get(id).result.restored, true);
});
test('respects maximum edge, aspect ratio and never enlarges', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  const id = await engine.importBuffer(await sampleImage(), 'image.png', 'drop', balanced);
  await engine.apply(id, { ...balanced, maxEdge: 900 });
  assert.deepEqual([engine.get(id).result.width, engine.get(id).result.height], [900, 600]);
  await engine.apply(id, { ...balanced, maxEdge: 8000 });
  assert.deepEqual([engine.get(id).result.width, engine.get(id).result.height], [2400, 1600]);
});
test('source file stays untouched and no-op optimisation never increases its size', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine, dir } = f;
  const original = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#66449980' } }).png().toBuffer();
  const file = path.join(dir, 'source.png'); await writeFile(file, original);
  const id = await engine.importPath(file, 'file', { ...balanced, mode: 'lossless' });
  assert.ok(engine.get(id).result.outputBytes <= original.length);
  assert.deepEqual(await readFile(file), original);
  await engine.apply(id, { ...balanced, scale: .5, format: 'webp' });
  assert.deepEqual(await readFile(file), original);
});
test('lossless PNG preserves pixels and transparency', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  const original = await sharp({ create: { width: 81, height: 55, channels: 4, background: '#74609b80' } }).png({ compressionLevel: 0 }).toBuffer();
  const id = await engine.importBuffer(original, 'alpha.png', 'drop', { ...balanced, mode: 'lossless' });
  assert.deepEqual(await sharp(engine.output(id)).raw().toBuffer(), await sharp(original).raw().toBuffer());
  assert.equal((await sharp(engine.output(id)).metadata()).hasAlpha, true);
});
test('lossless JPEG keeps exact pixels and never grows; resized lossless JPEG becomes PNG', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  const original = await sharp(await sampleImage()).jpeg().toBuffer();
  const id = await engine.importBuffer(original, 'image.jpg', 'drop', { ...balanced, mode: 'lossless' });
  assert.ok(engine.get(id).result.outputBytes <= original.length);
  assert.deepEqual(await sharp(engine.output(id)).raw().toBuffer(), await sharp(original).raw().toBuffer());
  await engine.apply(id, { ...balanced, mode: 'lossless', scale: .5 });
  assert.equal(engine.get(id).result.format, 'png');
  assert.equal((await sharp(engine.output(id)).metadata()).format, 'png');
});
test('EXIF orientation defines displayed and resized dimensions', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  const original = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#376677' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const id = await engine.importBuffer(original, 'rotated.jpg', 'drop', balanced);
  assert.deepEqual([engine.get(id).result.originalWidth, engine.get(id).result.originalHeight], [80, 120]);
  await engine.apply(id, { ...balanced, scale: .5 });
  assert.deepEqual([engine.get(id).result.width, engine.get(id).result.height], [40, 60]);
  const meta = await sharp(engine.output(id)).metadata(); assert.deepEqual([meta.width, meta.height], [40, 60]);
});
test('keeps animation frames and rejects conversion that would flatten them', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  const a = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#335566' } }).png().toBuffer();
  const b = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#aa6688' } }).png().toBuffer();
  const original = await sharp([a, b], { join: { animated: true } }).gif({ delay: [100, 200], loop: 0 }).toBuffer();
  const id = await engine.importBuffer(original, 'animation.gif', 'drop', balanced);
  assert.equal(engine.get(id).result.animated, true);
  await engine.apply(id, { ...balanced, scale: .5, format: 'webp' });
  assert.equal(engine.get(id).result.status, 'ready', engine.get(id).result.error);
  const meta = await sharp(engine.output(id), { animated: true }).metadata();
  assert.equal(meta.pages, 2); assert.equal(meta.width, 24); assert.equal(meta.pageHeight, 16);
  assert.deepEqual(meta.delay, [100, 200]);
  await engine.apply(id, { ...balanced, format: 'jpeg' });
  assert.equal(engine.get(id).result.status, 'error');
  assert.match(engine.get(id).result.error!, /animation/);
  await engine.restore(id); assert.deepEqual(await readFile(engine.output(id)), original);
});
test('rejects unsupported files and invalid scale without losing existing results', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  await assert.rejects(engine.importBuffer(Buffer.from('not an image'), 'file.txt', 'drop', balanced));
  await assert.rejects(engine.importBuffer(Buffer.from('not an image'), 'file.png', 'drop', balanced), /Use PNG/);
  const id = await engine.importBuffer(await sampleImage(), 'image.png', 'drop', balanced);
  assert.throws(() => engine.apply(id, { ...balanced, scale: 2 }), /10%/);
  assert.equal(engine.get(id).result.status, 'ready');
});
test('imports HEIC, JPEG XL, BMP and SVG with previews, and keeps the original to restore', async t => {
  const f = await fixture(t); if (!f || !needTools(t, 'ffprobe', 'heif-enc', 'heif-dec', 'cjxl', 'djxl')) return;
  const { engine, dir } = f;
  const png = path.join(dir, 'source.png');
  await sharp(await sampleImage()).resize(600, 400).png().toFile(png);
  const encode = async (name: string, tool: string, args: string[]) => { const file = path.join(dir, name); await run(tool, [...args.map(arg => arg.replace('$in', png).replace('$out', file))]); return readFile(file); };
  const inputs: [string, Buffer, string][] = [
    ['photo.heic', await encode('photo.heic', 'heif-enc', ['-q', '80', '-o', '$out', '$in']), 'jpeg'],
    ['photo.jxl', await encode('photo.jxl', 'cjxl', ['$in', '$out', '-q', '95', '--quiet']), 'jxl'],
    ['photo.bmp', await encode('photo.bmp', 'ffmpeg', ['-v', 'error', '-i', '$in', '$out']), 'jpeg'],
    ['shape.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><circle cx="300" cy="200" r="150" fill="#36c"/></svg>'), 'png'],
  ];
  for (const [name, bytes, output] of inputs) {
    const id = await engine.importBuffer(bytes, name, 'drop', balanced), { result } = engine.get(id);
    assert.equal(result.status, 'ready', `${name}: ${result.error}`);
    assert.deepEqual([result.format, result.originalWidth, result.originalHeight, result.width], [output, 600, 400, 600], name);
    assert.match(result.originalPreview, /^data:image\/png;base64,/);
    assert.equal((await sharp(Buffer.from(result.preview.split(',')[1], 'base64')).metadata()).width, 600, name);
    await engine.restore(id);
    assert.deepEqual(await readFile(engine.output(id)), bytes, name);
  }
});
test('serialises resize operations and serves the last requested result', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  const id = await engine.importBuffer(await sampleImage(), 'image.png', 'drop', balanced);
  await Promise.all([engine.apply(id, { ...balanced, scale: .2 }), engine.apply(id, { ...balanced, scale: .8 })]);
  assert.equal(engine.get(id).result.width, 1920);
  const snapshot = engine.list(); snapshot[0].width = 1;
  assert.equal(engine.get(id).result.width, 1920);
});
test('reads the compression and metadata settings for every job', async t => {
  const f = await fixture(t); if (!f) return;
  let settings = { ...defaultSettings(), stripMetadata: false };
  const engine = new ItemEngine(f.dir, () => settings);
  const original = await sharp(await sampleImage()).withExif({ IFD0: { Artist: 'Someone' } }).jpeg({ quality: 95 }).toBuffer();
  const id = await engine.importBuffer(original, 'photo.jpg', 'drop', balanced);
  assert.equal((await sharp(engine.output(id)).metadata()).exif?.includes('Someone'), true);
  await engine.apply(id, { ...balanced, mode: 'aggressive' });
  const aggressive = engine.get(id).result.outputBytes;
  // With the setting itself aggressive, the aggressive mode uses it rather than the macOS button's factor 64.
  settings = { ...settings, imageCompression: { tier: 'custom', factor: 90 } };
  await engine.apply(id, { ...balanced, mode: 'aggressive' });
  assert.ok(engine.get(id).result.outputBytes < aggressive);
});
const previewSize = async (dataURL: string) => { const meta = await sharp(Buffer.from(dataURL.split(',')[1], 'base64')).metadata(); return [meta.width, meta.height]; };
async function media(t: TestContext, ...tools: Parameters<typeof needTools>[1][]) {
  if (!needTools(t, 'ffmpeg', 'ffprobe', ...tools)) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-items-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { engine: new ItemEngine(path.join(dir, 'session')), dir };
}
test('optimises a video with a frame preview and its duration, names the result like its source and restores it', async t => {
  const f = await media(t); if (!f) return;
  const { engine, dir } = f;
  const source = await clip(path.join(dir, 'clip.mp4'), { width: 320, height: 240, seconds: 1 }), original = await readFile(source);
  const id = await engine.importPath(source, 'clipboard', balanced);
  const { result } = engine.get(id);
  assert.equal(result.status, 'ready', result.error);
  assert.deepEqual([result.kind, result.format, result.width, result.height], ['video', 'mp4', 320, 240]);
  assert.ok(Math.abs(result.durationMs! - 1000) < 100, `${result.durationMs}`);
  assert.ok(result.outputBytes < result.originalBytes);
  assert.equal(path.basename(engine.output(id)), 'clip.mp4');
  assert.notEqual(engine.output(id), source);
  assert.deepEqual(await previewSize(result.preview), [320, 240]);
  assert.throws(() => engine.apply(id, { ...balanced, scale: .5 }), /Only images/);
  await engine.restore(id);
  assert.deepEqual(await readFile(engine.output(id)), original);
  assert.deepEqual(await readFile(source), original);
});
test('optimises a PDF with its first page as the preview and reports its pages', async t => {
  const f = await media(t, 'gs'); if (!f) return;
  const { engine } = f, original = Buffer.from(await photoPDF());
  const id = await engine.importBuffer(original, 'scan.pdf', 'drop', balanced), { result } = engine.get(id);
  assert.equal(result.status, 'ready', result.error);
  assert.deepEqual([result.kind, result.format, result.pages], ['pdf', 'pdf', 4]);
  assert.ok(result.outputBytes < original.length);
  assert.deepEqual(await previewSize(result.preview), [288, 216]);
  await engine.restore(id);
  assert.deepEqual(await readFile(engine.output(id)), original);
});
test('optimises audio, previewing its cover art or a drawn placeholder', async t => {
  const f = await media(t, 'jpegoptim'); if (!f) return;
  const { engine, dir } = f;
  const cover = await coverImage(path.join(dir, 'cover.jpg'), 300, 200);
  const song = await tone(path.join(dir, 'song.mp3'), { codec: ['-c:a', 'libmp3lame', '-b:a', '320k'], cover });
  const id = await engine.importPath(song, 'drop', balanced), { result } = engine.get(id);
  assert.equal(result.status, 'ready', result.error);
  assert.deepEqual([result.kind, result.format, result.width], ['audio', 'mp3', 0]);
  assert.ok(Math.abs(result.durationMs! - 2000) < 100, `${result.durationMs}`);
  assert.ok(result.outputBytes < result.originalBytes);
  assert.deepEqual(await previewSize(result.preview), [300, 200]);
  // WAV becomes MP3 by the default formatsToConvertToMP3.
  const wav = await engine.importPath(await tone(path.join(dir, 'take.wav')), 'drop', balanced), take = engine.get(wav).result;
  assert.equal(take.status, 'ready', take.error);
  assert.deepEqual([take.format, path.extname(engine.output(wav))], ['mp3', '.mp3']);
  assert.equal(take.preview, await placeholder('audio'));
  await engine.restore(wav);
  assert.equal(engine.get(wav).result.format, 'wav');
});
test('a long video does not hold up an image, and aborting stops the video', async t => {
  const f = await media(t, 'jpegoptim', 'pngquant', 'gifsicle', 'exiftool'); if (!f) return;
  const { dir } = f;
  const engine = new ItemEngine(path.join(dir, 'session'), () => ({ ...defaultSettings(), videoCompression: { tier: 'smaller', factor: 90 } }));
  const source = await clip(path.join(dir, 'long.mp4'), { width: 1280, height: 720, seconds: 6 });
  const started = new Promise<void>(resolve => engine.on('change', () => { if (engine.list().some(item => item.kind === 'video' && item.status === 'processing')) resolve(); }));
  const video = engine.importPath(source, 'drop', { ...balanced, mode: 'aggressive' });
  await started;
  const image = await engine.importBuffer(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#336699' } }).png().toBuffer(), 'small.png', 'clipboard', balanced);
  assert.equal(engine.get(image).result.status, 'ready');
  assert.equal(engine.list().find(item => item.kind === 'video')!.status, 'processing', 'the video should still be encoding');
  const before = Date.now();
  engine.abort();
  const id = await video;
  assert.ok(Date.now() - before < 5000);
  assert.equal(engine.get(id).result.status, 'error');
  await assert.rejects(engine.importBuffer(Buffer.from('x'), 'late.png', 'drop', balanced), { name: 'AbortError' });
});
test('names an imported file as asked and reports files it cannot read', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine, dir } = f;
  const file = path.join(dir, 'source.png'); await writeFile(file, await sharp({ create: { width: 40, height: 30, channels: 3, background: '#a06040' } }).png().toBuffer());
  const id = await engine.importPath(file, 'clipboard', balanced, 'clop_2026-10-10_7.png');
  assert.equal(engine.get(id).result.name, 'clop_2026-10-10_7.png');
  assert.match(path.basename(engine.output(id)), /^clop_2026-10-10_7\.png$/);
  await assert.rejects(engine.importPath(path.join(dir, 'missing.mp4'), 'drop', balanced), /missing\.mp4 no longer exists/);
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await chmod(file, 0o000);
    await assert.rejects(engine.importPath(file, 'drop', balanced), /Could not read source\.png/);
  }
});
test('names downloads without a matching extension by their content', async t => {
  const f = await media(t, 'gs'); if (!f) return;
  const { engine, dir } = f;
  const song = await readFile(await tone(path.join(dir, 'song.mp3'), { codec: ['-c:a', 'libmp3lame', '-b:a', '320k'] }));
  const audio = await engine.importBuffer(song, 'download', 'drop', balanced);
  assert.equal(engine.get(audio).result.status, 'ready', engine.get(audio).result.error);
  assert.deepEqual([engine.get(audio).result.format, path.basename(engine.output(audio))], ['mp3', 'download.mp3']);
  const pdf = await engine.importBuffer(Buffer.from(await photoPDF()), 'view.php', 'drop', balanced);
  assert.deepEqual([engine.get(pdf).result.kind, engine.get(pdf).result.format, path.basename(engine.output(pdf))], ['pdf', 'pdf', 'view.pdf']);
  await engine.restore(pdf);
  assert.equal(path.extname(engine.output(pdf)), '.pdf');
  // A name too long for the card loses the end of its stem, not its extension.
  const long = await engine.importBuffer(song, `${'interview '.repeat(30)}final.mp3`, 'drop', balanced), { result } = engine.get(long);
  assert.ok(result.name.length <= 160 && result.name.endsWith('.mp3'), result.name);
  assert.deepEqual([result.format, path.extname(engine.output(long))], ['mp3', '.mp3']);
});
test('optimised PDFs and audio keep their source file dates', async t => {
  const f = await media(t, 'gs'); if (!f) return;
  const { engine, dir } = f, past = new Date('2020-05-04T03:02:01Z');
  const pdf = path.join(dir, 'scan.pdf'); await writeFile(pdf, await photoPDF());
  const song = await tone(path.join(dir, 'song.mp3'), { codec: ['-c:a', 'libmp3lame', '-b:a', '320k'] });
  for (const file of [pdf, song]) {
    await utimes(file, past, past);
    const id = await engine.importPath(file, 'drop', balanced), { result } = engine.get(id);
    assert.ok(result.status === 'ready' && !result.unchanged, `${file}: ${result.error}`);
    assert.equal((await stat(engine.output(id))).mtime.getTime(), past.getTime(), file);
  }
});
test('overlapping clipboard images each finish and go back on the clipboard before the next replaces its card', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f, turn = serial(), settings = { ...defaultSettings(), appendClipboardResults: false }, written: string[][] = [];
  const image = (colour: string) => sharp({ create: { width: 96, height: 64, channels: 3, background: colour } }).png().toBuffer();
  // The steps main.ts gives `importClipboardImages`; making way dismisses each earlier card twice, as overlapping imports could.
  const steps = {
    turn, load: async () => [], writeBack: async (ids: string[]) => { written.push(ids.map(id => engine.get(id).result.name)); },
    prepare: async () => { await Promise.all(replacedClipboardImages(engine.list(), settings).flatMap(id => [engine.dismiss(id), engine.dismiss(id)])); },
  };
  const copy = async (colour: string, name: string) => importClipboardImages(steps, async () => [await engine.importBuffer(await image(colour), name, 'clipboard', balanced)]);
  await Promise.all([copy('#aa3344', 'a.png'), copy('#33aa44', 'b.png'), copy('#3344aa', 'c.png')]);
  assert.deepEqual(written, [['a.png'], ['b.png'], ['c.png']]);
  assert.deepEqual(engine.list().map(item => item.name), ['c.png']);
});
test('dismissing is immediate, safe to repeat and stops a running job', async t => {
  const f = await media(t, 'jpegoptim', 'pngquant', 'gifsicle', 'exiftool'); if (!f) return;
  const { dir } = f;
  const engine = new ItemEngine(path.join(dir, 'session'), () => ({ ...defaultSettings(), videoCompression: { tier: 'smaller', factor: 90 } }));
  const short = await engine.importPath(await clip(path.join(dir, 'short.mp4'), { seconds: 0.5 }), 'drop', balanced);
  const folder = (id: string) => path.join(dir, 'session', id);
  const started = new Promise<void>(resolve => engine.on('change', () => { if (engine.list().some(item => item.name === 'long.mp4' && item.status === 'processing')) resolve(); }));
  const long = engine.importPath(await clip(path.join(dir, 'long.mp4'), { width: 1280, height: 720, seconds: 6 }), 'drop', { ...balanced, mode: 'aggressive' });
  await started;
  // A finished video leaves at once, although the video queue is busy, and dismissing it twice is harmless.
  const before = Date.now();
  await Promise.all([engine.dismiss(short), engine.dismiss(short)]);
  assert.ok(Date.now() - before < 1000);
  assert.ok(engine.list().every(item => item.id !== short));
  // A result that was ready may still be pasting somewhere, so its folder stays.
  assert.ok((await stat(folder(short))).isDirectory());
  // The running encode stops when its card is dismissed, and its import ends without an error.
  const running = engine.list().find(item => item.name === 'long.mp4')!.id;
  await engine.dismiss(running);
  assert.equal(await long, running);
  assert.ok(Date.now() - before < 5000);
  assert.deepEqual(engine.list(), []);
  // One that never was ready cannot be, so its folder goes.
  await assert.rejects(stat(folder(running)), { code: 'ENOENT' });
  await engine.dismiss(running);
});
test('stopping ends running and queued jobs, which can then run again', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine, dir } = f;
  const first = await clip(path.join(dir, 'first.mp4'), { width: 640, height: 360, seconds: 4 }), second = await clip(path.join(dir, 'second.mp4'), { width: 640, height: 360, seconds: 1 });
  const jobs = [engine.importPath(first, 'drop', balanced), engine.importPath(second, 'drop', balanced)];
  while (engine.list().length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  engine.stop();
  const ids = await Promise.all(jobs);
  for (const id of ids) assert.deepEqual([engine.get(id).result.status, engine.get(id).result.error], ['error', 'Stopped.']);
  // Stopping is not quitting: the stopped result can be restored, and new imports run.
  await engine.restore(ids[0]);
  assert.equal(engine.get(ids[0]).result.status, 'ready');
  const id = await engine.importBuffer(await sampleImage(), 'after.png', 'drop', balanced);
  assert.equal(engine.get(id).result.status, 'ready');
  engine.stop([id]);
  assert.equal(engine.get(id).result.status, 'ready', 'stopping a finished result changes nothing');
});
test('a dismissed result can be brought back as the newest', async t => {
  const f = await fixture(t); if (!f) return;
  const { engine } = f;
  const a = await engine.importBuffer(await sampleImage(), 'a.png', 'drop', balanced), b = await engine.importBuffer(await sampleImage(), 'b.png', 'drop', balanced);
  await engine.dismiss(a); await engine.dismiss(b);
  assert.deepEqual(engine.list(), []);
  assert.equal(engine.bringBack(a), a);
  assert.equal(engine.bringBack(), b);
  assert.deepEqual(engine.list().map(item => item.name), ['b.png', 'a.png']);
  assert.equal(engine.bringBack(), undefined);
  assert.equal(engine.bringBack('unknown'), undefined);
});
