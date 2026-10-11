import { mock, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from '@cantoo/pdf-lib';
import { DEFAULT_CROP_ASPECT_RATIOS } from '../data/cropSizes';
import { exists } from '../fileops';
import { OptimisedMarker } from '../marker';
import { tone } from '../media/audio.fixtures';
import { photo } from '../media/image.fixtures';
import { photoPDF } from '../media/pdf.fixtures';
import { clip } from '../media/video.fixtures';
import { defaultSettings } from '../settings/schema';
import { needTools } from '../testing';
import { Workdir } from '../workdir';
import { batchCrop } from './crop';
import { BatchBackup } from './backup';
import { Batch, type BatchEnv } from './engine';
import { scanBatch } from './scan';
import { defaultBatchParams, type BatchParams } from './spec';

async function setup(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-batch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const workdir = await new Workdir(path.join(dir, 'work')).ensure(), marker = new OptimisedMarker(path.join(dir, 'optimised.json'));
  const settings = defaultSettings({ home: dir, desktop: dir, userData: dir });
  const env: BatchEnv = { workdir, settings: () => settings, marker, counter: { value: 0 }, home: dir };
  const files = path.join(dir, 'files');
  await mkdir(files, { recursive: true });
  return { dir, files, workdir, marker, env, params: (change: Partial<BatchParams> = {}) => ({ ...defaultBatchParams(settings), ...change }) };
}
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
async function write(file: string, data: Buffer | Uint8Array, mtime = new Date(2024, 0, 2, 3, 4, 5)) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data); await utimes(file, mtime, mtime);
  return file;
}
const jpeg = (width = 640, height = 480, seed = 1) => photo(width, height, seed).jpeg({ quality: 98 }).toBuffer();
const png = (width = 320, height = 240, seed = 1) => photo(width, height, seed).png({ compressionLevel: 0 }).toBuffer();
async function batchOf(env: BatchEnv, paths: string[], params: BatchParams) {
  const { files } = await scanBatch(paths);
  return new Batch(files, params, env);
}
const statuses = (batch: Batch) => batch.items.map(item => item.status);

test('a lossless image setting stays lossless in a batch', async t => {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const source = await write(path.join(files, 'a.png'), await png(96, 64));
  const before = await sharp(source).raw().toBuffer();
  const batch = await batchOf(env, [files], { ...params(), image: { ...params().image, lossless: true } });
  await batch.run();
  assert.deepEqual(statuses(batch), ['done']);
  assert.ok((await sharp(source).raw().toBuffer()).equals(before), 'every pixel is as it was');
});

test('optimises images in place, keeps the originals in the batch backup and reverts them byte for byte', async t => {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg()), b = await write(path.join(files, 'sub', 'b.png'), await png());
  const before = { a: await digest(a), b: await digest(b), aTime: (await stat(a)).mtimeMs };
  const batch = await batchOf(env, [files], params());
  let changes = 0; batch.on('change', () => changes++);
  await batch.run();
  assert.equal(batch.phase, 'finished');
  assert.deepEqual(statuses(batch), ['done', 'done']);
  for (const item of batch.items) {
    assert.equal(item.result, item.path);
    assert.ok(item.newBytes! < item.oldBytes, `${item.name} got smaller`);
    assert.equal((await stat(item.path)).size, item.newBytes);
    assert.ok(await env.marker.isOptimised(item.path), 'placed results are marked');
  }
  assert.deepEqual(batch.items[0].oldSize, { width: 640, height: 480 });
  assert.ok(changes > 2);
  // The backup folder holds both originals and a manifest, and no working files.
  const kept = await readdir(batch.backup.dir);
  assert.deepEqual(kept.filter(name => name !== 'manifest.json').length, 2);
  assert.ok(kept.includes('manifest.json') && !kept.includes('work'));
  assert.deepEqual(JSON.parse(await readFile(path.join(batch.backup.dir, 'manifest.json'), 'utf8')).entries.map((e: { path: string }) => e.path).sort(), [a, b].sort());

  assert.deepEqual(await batch.revert(), []);
  assert.equal(batch.phase, 'reverted');
  assert.deepEqual(statuses(batch), ['reverted', 'reverted']);
  assert.deepEqual([await digest(a), await digest(b), (await stat(a)).mtimeMs], [before.a, before.b, before.aTime]);
  assert.ok(await env.marker.isOptimised(a), 'a reverted original is marked so watchers leave it');
  // The backups stay until deleted, so reverting again changes nothing.
  assert.deepEqual(await batch.revert(), []);
  await batch.deleteBackups();
  assert.equal(await exists(batch.backup.dir), false);
  assert.equal(batch.snapshot().backupsDeleted, true);
});

test('a format conversion in place replaces the original and gives back a file it took the place of', async t => {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const shot = await write(path.join(files, 'shot.png'), await png(400, 300, 3));
  const other = await write(path.join(files, 'other.png'), await png(300, 200, 4)), mine = await write(path.join(files, 'other.jpeg'), Buffer.from('my own jpeg'));
  const before = await Promise.all([shot, other].map(digest));
  const p = params(); p.image = { ...p.image, convert: 'jpeg' };
  const batch = new Batch((await scanBatch([shot, other])).files, p, env);
  await batch.run();
  assert.deepEqual(batch.items.map(item => [item.status, item.result && path.basename(item.result), item.oldFormat, item.newFormat]), [['done', 'shot.jpeg', 'PNG', 'JPEG'], ['done', 'other.jpeg', 'PNG', 'JPEG']]);
  assert.equal(await exists(shot), false, 'the converted original is gone from its folder');
  assert.equal((await sharp(mine).metadata()).format, 'jpeg', 'the result took the place of the user\'s file');
  assert.deepEqual(await batch.revert(), []);
  assert.deepEqual(await Promise.all([shot, other].map(digest)), before);
  assert.equal(await exists(path.join(files, 'shot.jpeg')), false);
  assert.equal(await readFile(mine, 'utf8'), 'my own jpeg');
});

test('results saved to a folder under a name template never collide, and reverting removes only them', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { dir, files, env, params } = await setup(t);
  const one = await write(path.join(files, 'one', 'pic.jpg'), await jpeg(320, 240, 5)), two = await write(path.join(files, 'two', 'pic.jpg'), await jpeg(320, 240, 6));
  const out = path.join(dir, 'out');
  const batch = await batchOf(env, [files], params({ output: { location: 'folder', folder: out, template: '%f-%i' } }));
  let saved = 0; env.saved = value => { saved = value; };
  await batch.run();
  // Files run side by side, so either may take the first number.
  assert.deepEqual(batch.items.map(item => path.relative(dir, item.result!)).sort(), [path.join('out', 'pic-1.jpg'), path.join('out', 'pic-2.jpg')]);
  assert.equal(saved, 2, 'the %i counter is handed back for the setting');
  assert.ok(await exists(one) && await exists(two), 'originals stay where they are');
  assert.deepEqual(await readdir(batch.backup.dir), ['manifest.json'], 'nothing was moved aside');
  // Same template twice: the second file is numbered instead of overwriting the first.
  const again = await batchOf(env, [files], params({ output: { location: 'folder', folder: path.join(dir, 'same'), template: '%f' } }));
  await again.run();
  assert.deepEqual(again.items.map(item => path.basename(item.result!)).sort(), ['pic-2.jpg', 'pic.jpg']);
  assert.deepEqual(await batch.revert(), []);
  assert.deepEqual(await readdir(out), []);
});

test('the chosen folder is used as it is: only the name template is expanded', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { dir, files, env, params } = await setup(t);
  const pic = await write(path.join(files, 'pic.jpg'), await jpeg(320, 240, 5));
  for (const name of ["O'Brien", 'Pics & Stuff', '100%d', 'a#b', 'x%f']) {
    const out = path.join(dir, name, 'inner');
    const batch = await batchOf(env, [pic], params({ output: { location: 'folder', folder: out, template: 'sub/%f-new' } }));
    await batch.run();
    assert.deepEqual(statuses(batch), ['done'], name);
    assert.equal(batch.items[0].result, path.join(out, 'sub', 'pic-new.jpg'), name);
    assert.ok(await exists(path.join(out, 'sub', 'pic-new.jpg')), name);
    assert.deepEqual(await readdir(path.join(dir, name)), ['inner'], `${name}: nothing beside the chosen folder`);
  }
});

test('a template that expands to somewhere outside the chosen folder is refused', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { dir, files, env, params } = await setup(t);
  const pic = await write(path.join(files, 'pic.jpg'), await jpeg(320, 240, 5)), out = path.join(dir, 'out');
  // `~` is not caught when the template is checked, but it would expand to the home folder.
  const batch = await batchOf(env, [pic], params({ output: { location: 'folder', folder: out, template: '~/%f' } }));
  await batch.run();
  assert.deepEqual(statuses(batch), ['failed']);
  assert.match(batch.items[0].error!, /outside the chosen folder/);
  assert.deepEqual(await readdir(files), ['pic.jpg']);
});

test('reverting leaves alone a result edited or deleted since, and still restores the rest', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const paths = await Promise.all([1, 2, 3].map(async n => write(path.join(files, `${n}.jpg`), await jpeg(320, 240, n))));
  const originals = await Promise.all(paths.map(digest));
  const batch = await batchOf(env, paths, params());
  await batch.run();
  await writeFile(paths[0], 'edited by the user');
  await rm(paths[1]);
  const failures = await batch.revert();
  assert.equal(failures.length, 2);
  assert.match(failures[0], /^1\.jpg: 1\.jpg changed after Clop optimised it/);
  assert.match(failures[1], /^2\.jpg: 2\.jpg was moved or deleted/);
  assert.deepEqual(statuses(batch), ['done', 'done', 'reverted']);
  assert.equal(await readFile(paths[0], 'utf8'), 'edited by the user');
  assert.equal(await digest(paths[2]), originals[2]);
});

test('cancelling stops running files and skips queued ones; finished files keep their results', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const paths = await Promise.all(Array.from({ length: 8 }, async (_, n) => write(path.join(files, `${n}.jpg`), await jpeg(1600, 1200, n + 10))));
  const originals = await Promise.all(paths.map(digest));
  const batch = await batchOf(env, paths, params());
  const done = batch.run();
  await new Promise<void>(resolve => batch.on('change', () => { if (batch.items.some(item => item.status === 'done')) resolve(); }));
  batch.cancel();
  await done;
  assert.equal(batch.phase, 'cancelled');
  const finished = batch.items.filter(item => item.status === 'done'), skipped = batch.items.filter(item => item.status === 'skipped');
  assert.ok(finished.length >= 1 && skipped.length >= 1, statuses(batch).join());
  assert.equal(finished.length + skipped.length, paths.length, 'nothing fails because of the cancel');
  for (const item of skipped) assert.equal(await digest(item.path), originals[paths.indexOf(item.path)], `${item.name} was left as it was`);
  assert.deepEqual(await readdir(batch.backup.dir).then(names => names.includes('work')), false);
});

test('crops, downscales and caps the long edge of images by the batch parameters', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { dir, files, env, params } = await setup(t);
  const landscape = await write(path.join(files, 'land.jpg'), await jpeg(1200, 800, 7)), portrait = await write(path.join(files, 'port.jpg'), await jpeg(600, 900, 8));
  const run = async (image: Partial<BatchParams['image']>, folder: string) => {
    const p = params({ output: { location: 'folder', folder: path.join(dir, folder), template: '%f' } }); p.image = { ...p.image, ...image };
    const batch = new Batch((await scanBatch([landscape, portrait])).files, p, env);
    await batch.run();
    assert.deepEqual(statuses(batch), ['done', 'done'], batch.items.map(item => item.error).join());
    return Promise.all(batch.items.map(async item => { const m = await sharp(item.result!).metadata(); return [m.width, m.height]; }));
  };
  const square = DEFAULT_CROP_ASPECT_RATIOS.find(size => size.name === '16:9')!;
  assert.deepEqual(await run({ crop: batchCrop(square, 'adaptive') }, 'ratio'), [[1200, 676], [506, 900]]);
  assert.deepEqual(await run({ crop: { width: 300, height: 300 } }, 'exact'), [[300, 300], [300, 300]]);
  assert.deepEqual(await run({ downscale: 0.5 }, 'half'), [[600, 400], [300, 450]]);
  assert.deepEqual(await run({ maxLongEdge: 1000 }, 'edge'), [[1000, 667], [600, 900]]);
});

test('optimises videos, PDFs and audio side by side and reverts them', async t => {
  if (!needTools(t, 'ffmpeg', 'ffprobe', 'gs')) return;
  const { files, env, params } = await setup(t);
  const video = await clip(path.join(files, 'clip.mp4'), { seconds: 1 });
  const pdf = await write(path.join(files, 'doc.pdf'), await photoPDF({ pages: 2 }));
  const audio = await tone(path.join(files, 'tone.wav'), { seconds: 2 });
  const originals = await Promise.all([video, pdf, audio].map(digest));
  const p = params(); p.pdf = { dpi: 72, crop: batchCrop(DEFAULT_CROP_ASPECT_RATIOS.find(size => size.name === '1:1')!, 'adaptive') };
  p.audio = { ...p.audio, format: 'mp3', convertLossless: true };
  p.video = { ...p.video, encoder: 'smaller', compression: 70 };
  const batch = await batchOf(env, [files], p);
  await batch.run();
  const byKind = Object.fromEntries(batch.items.map(item => [item.kind, item]));
  assert.deepEqual(statuses(batch).sort(), ['done', 'done', 'done'], batch.items.map(item => item.error).join());
  assert.ok(byKind.video.newBytes! < byKind.video.oldBytes);
  assert.deepEqual(byKind.video.newSize, { width: 320, height: 240 });
  assert.equal(byKind.pdf.newDetail, 72);
  const page = (await PDFDocument.load(await readFile(byKind.pdf.result!))).getPage(0).getCropBox();
  assert.equal(Math.round(page.width), Math.round(page.height), 'every page is cut square');
  assert.deepEqual([path.basename(byKind.audio.result!), byKind.audio.newFormat, await exists(audio)], ['tone.mp3', 'MP3', false]);
  assert.ok(byKind.audio.newDetail! > 0);
  assert.deepEqual(await batch.revert(), []);
  assert.deepEqual(await Promise.all([video, pdf, audio].map(digest)), originals);
  assert.equal(await exists(path.join(files, 'tone.mp3')), false);
});

test('a video conversion uses the batch\'s encoder tier and compression', async t => {
  if (!needTools(t, 'ffmpeg', 'ffprobe')) return;
  const { dir, files, env, params } = await setup(t);
  const video = await clip(path.join(files, 'clip.mp4'), { width: 640, height: 360, seconds: 1 });
  const converted = async (encoder: 'smaller' | 'lossless') => {
    const p = params({ output: { location: 'folder', folder: path.join(dir, encoder), template: '%f' } });
    p.video = { ...p.video, convert: 'hevc', encoder, compression: 70, allowLarger: true };
    const batch = await batchOf(env, [video], p);
    await batch.run();
    assert.deepEqual(statuses(batch), ['done'], batch.items.map(item => item.error).join());
    return (await stat(batch.items[0].result!)).size;
  };
  assert.ok(await converted('lossless') > await converted('smaller'), 'visually lossless keeps more than the smaller-file tier');
});

test('a file that cannot be optimised fails with its reason while the rest finish', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const bad = await write(path.join(files, 'broken.png'), Buffer.from('not really a png')), good = await write(path.join(files, 'good.jpg'), await jpeg(320, 240, 9));
  const batch = await batchOf(env, [bad, good], params());
  await batch.run();
  assert.deepEqual(statuses(batch), ['failed', 'done']);
  const [failure] = batch.failures();
  assert.equal(failure.path, bad);
  assert.ok(failure.error && !failure.error.includes('\n'));
  assert.equal(await readFile(bad, 'utf8'), 'not really a png', 'a failed file is left as it was');
  assert.deepEqual(await batch.revert(), []);
  assert.deepEqual(statuses(batch), ['failed', 'reverted']);
});

/** A manifest that cannot be written: its path is a folder, so the atomic rename onto it fails. */
const breakManifest = (batch: Batch) => mkdir(path.join(batch.backup.dir, 'manifest.json'), { recursive: true });

test('a failing manifest write puts the original back and leaves nothing placed', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(320, 240, 1)), b = await write(path.join(files, 'b.jpg'), await jpeg(320, 240, 2));
  const before = await Promise.all([a, b].map(async file => [await digest(file), (await stat(file)).mtimeMs] as const));
  const batch = await batchOf(env, [a, b], params());
  await breakManifest(batch);
  await batch.run();
  assert.deepEqual(statuses(batch), ['failed', 'failed']);
  assert.deepEqual(await Promise.all([a, b].map(async file => [await digest(file), (await stat(file)).mtimeMs] as const)), before, 'both originals are exactly as they were');
  assert.deepEqual((await readdir(files)).sort(), ['a.jpg', 'b.jpg'], 'no stray files beside them');
  assert.deepEqual((await readdir(batch.backup.dir)).sort(), ['manifest.json'], 'no stray copies in the backup folder');
  assert.deepEqual(batch.items.map(item => item.result), [undefined, undefined]);
});

test('a failing manifest write gives back a file of the user\'s that sat where a result goes, and the converted original', async t => {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const shot = await write(path.join(files, 'shot.png'), await png(400, 300, 3)), mine = await write(path.join(files, 'shot.jpeg'), Buffer.from('my own jpeg'));
  const p = params(); p.image = { ...p.image, convert: 'jpeg' };
  const batch = new Batch((await scanBatch([shot])).files, p, env);
  // The first save (the user's file) works; the second (the converted original) fails.
  let saves = 0;
  const save = batch.backup['save' as keyof typeof batch.backup] as () => Promise<void>;
  mock.method(batch.backup as unknown as { save: () => Promise<void> }, 'save', function (this: unknown) { return ++saves === 2 ? Promise.reject(new Error('disk full')) : save.call(this); });
  await batch.run();
  assert.deepEqual(statuses(batch), ['failed']);
  assert.match(batch.items[0].error!, /disk full/);
  assert.equal(await readFile(mine, 'utf8'), 'my own jpeg', 'the user\'s file is back');
  assert.ok(await exists(shot), 'the original is back');
  assert.deepEqual((await readdir(files)).sort(), ['shot.jpeg', 'shot.png']);
});

test('a failure after the original was taken restores it, and leaves a new result file out', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { dir, files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(320, 240, 1)), out = path.join(dir, 'out');
  const original = await digest(a);
  for (const output of [{ location: 'inPlace' }, { location: 'folder', folder: out, template: '%f-new' }] as const) {
    const batch = await batchOf(env, [a], params({ output }));
    mock.method(batch.backup, 'recordResult', () => Promise.reject(new Error('manifest gone')));
    await batch.run();
    assert.deepEqual(statuses(batch), ['failed'], output.location);
    assert.equal(await digest(a), original, `${output.location}: the original is back`);
    assert.deepEqual(await readdir(out).catch(() => []), [], `${output.location}: no result is left behind`);
  }
});

test('a result whose manifest write failed does not reach the manifest through another file\'s save', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { dir, files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(320, 240, 1)), b = await write(path.join(files, 'b.jpg'), await jpeg(320, 240, 2));
  const batch = await batchOf(env, [a], params({ output: { location: 'folder', folder: path.join(dir, 'out'), template: '%f' } }));
  // The first write fails after a moment; a second file is recorded while it is in flight.
  const backup = batch.backup as unknown as { save(): Promise<void> }, save = backup.save.bind(backup);
  let calls = 0;
  backup.save = () => calls++ === 0 ? new Promise<void>((_, reject) => setTimeout(() => reject(new Error('disk full')), 50)) : save();
  const entry = (original: string) => ({ original, path: path.join(dir, 'out', path.basename(original)), size: 1, mtimeMs: 1, originalRemoved: false });
  const [failed] = await Promise.allSettled([batch.backup.recordResult(entry(a)), batch.backup.recordResult(entry(b))]);
  assert.equal(failed.status, 'rejected');
  assert.deepEqual(JSON.parse(await readFile(path.join(batch.backup.dir, 'manifest.json'), 'utf8')).results.map((r: { original: string }) => r.original), [b], 'the failed result is not carried along');
  assert.deepEqual(batch.backup.allResults().map(r => r.original), [b]);
});

test('forgetting a result takes its turn, so its save cannot carry a result whose own save failed', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { dir, files, env, params } = await setup(t);
  const [a, c, d] = await Promise.all(['a', 'c', 'd'].map((name, n) => jpeg(320, 240, n + 1).then(bytes => write(path.join(files, `${name}.jpg`), bytes))));
  const batch = await batchOf(env, [a], params({ output: { location: 'folder', folder: path.join(dir, 'out'), template: '%f' } }));
  const entry = (original: string) => ({ original, path: path.join(dir, 'out', path.basename(original)), size: 1, mtimeMs: 1, originalRemoved: false });
  await batch.backup.recordResult(entry(c)); await batch.backup.recordResult(entry(d));
  const backup = batch.backup as unknown as { save(): Promise<void> }, save = backup.save.bind(backup);
  let calls = 0;
  backup.save = () => calls++ === 0 ? new Promise<void>((_, reject) => setTimeout(() => reject(new Error('disk full')), 50)) : save();
  const [failed] = await Promise.allSettled([batch.backup.recordResult(entry(a)), batch.backup.forgetResult(c)]);
  assert.equal(failed.status, 'rejected');
  assert.deepEqual(JSON.parse(await readFile(path.join(batch.backup.dir, 'manifest.json'), 'utf8')).results.map((r: { original: string }) => r.original), [d]);
});

test('a result whose manifest write failed is not remembered, so it never reaches the manifest later', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { dir, files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(320, 240, 1)), b = await write(path.join(files, 'b.jpg'), await jpeg(320, 240, 2)), out = path.join(dir, 'out');
  const batch = await batchOf(env, [a], params({ output: { location: 'folder', folder: out, template: '%f' } }));
  // Into a folder nothing is taken aside, so the manifest is first written when the result is recorded.
  await breakManifest(batch);
  await batch.run();
  assert.deepEqual(statuses(batch), ['failed']);
  assert.deepEqual(await readdir(out), [], 'no result is left behind');
  assert.deepEqual(batch.backup.allResults(), [], 'and none is remembered');
  // With the manifest writable again, a later save does not carry the failed result along.
  await rm(path.join(batch.backup.dir, 'manifest.json'), { recursive: true });
  await batch.backup.recordResult({ original: b, path: path.join(out, 'b.jpg'), size: 1, mtimeMs: 1, originalRemoved: false });
  assert.deepEqual(JSON.parse(await readFile(path.join(batch.backup.dir, 'manifest.json'), 'utf8')).results.map((r: { original: string }) => r.original), [b]);
});

test('a placement that fails before it wrote anything does not rewrite the original it only copied', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(320, 240, 1));
  const before = await stat(a, { bigint: true }), bytes = await digest(a);
  const batch = await batchOf(env, [a], params());
  const keep = batch.backup.keep.bind(batch.backup);
  // The original is copied into the backup, then the result to be placed disappears, so nothing can be written over it.
  mock.method(batch.backup, 'keep', async (file: string, options?: Parameters<typeof keep>[1]) => { const entry = await keep(file, options); await rm((batch as unknown as { workDir: string }).workDir, { recursive: true, force: true }); return entry; });
  await batch.run();
  assert.deepEqual(statuses(batch), ['failed']);
  const after = await stat(a, { bigint: true });
  assert.equal(await digest(a), bytes);
  assert.equal(after.ino, before.ino, 'the original was not replaced by a copy of itself');
  assert.deepEqual(batch.backup.allResults(), []);
});

test('a file that changed while the batch ran is left as it is', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(320, 240, 1)), b = await write(path.join(files, 'b.jpg'), await jpeg(320, 240, 2));
  const batch = await batchOf(env, [a, b], params());
  const keep = batch.backup.keep.bind(batch.backup);
  // The user saves over a.jpg after the batch read it and before the batch takes its place.
  mock.method(batch.backup, 'keep', async (file: string, options?: Parameters<typeof keep>[1]) => { if (file === a) await write(a, Buffer.from('saved by the user'), new Date(2025, 5, 6)); return keep(file, options); });
  await batch.run();
  assert.deepEqual(statuses(batch), ['failed', 'done']);
  assert.match(batch.items[0].error!, /a\.jpg changed while the batch ran/);
  assert.equal(await readFile(a, 'utf8'), 'saved by the user');
  assert.deepEqual((await readdir(files)).sort(), ['a.jpg', 'b.jpg']);
});

test('cancelling while a result is being placed finishes the placement, so the file is never half way', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(640, 480, 1));
  const original = await digest(a);
  const batch = await batchOf(env, [a], params());
  const keep = batch.backup.keep.bind(batch.backup);
  mock.method(batch.backup, 'keep', async (file: string, options?: Parameters<typeof keep>[1]) => { batch.cancel(); return keep(file, options); });
  await batch.run();
  assert.equal(batch.phase, 'cancelled');
  assert.deepEqual(statuses(batch), ['done']);
  assert.notEqual(await digest(a), original, 'the result is in place');
  assert.deepEqual(await batch.revert(), []);
  assert.equal(await digest(a), original, 'and it reverts');
});

test('an in-place result replaces the original without ever leaving its path empty', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(640, 480, 1));
  const batch = await batchOf(env, [a], params());
  const seen: boolean[] = [];
  const keep = batch.backup.keep.bind(batch.backup);
  mock.method(batch.backup, 'keep', async (file: string, options?: Parameters<typeof keep>[1]) => { const entry = await keep(file, options); seen.push(await exists(file)); return entry; });
  await batch.run();
  assert.deepEqual(statuses(batch), ['done']);
  assert.deepEqual(seen, [true], 'the original is still there once its backup is taken');
  assert.equal(batch.backup.result(a)?.originalRemoved, false);
});

test('a batch refuses a name template that would put a result outside its folder, before anything is written', async t => {
  const { dir, files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), Buffer.from('x')), out = path.join(dir, 'out', 'inner');
  for (const template of ['../escape-%f', '..\\%f', '/abs/%f']) {
    assert.throws(() => new Batch([{ path: a, kind: 'image', bytes: 1, format: 'JPG' }], params({ output: { location: 'folder', folder: out, template } }), env), /stay inside the chosen folder/, template);
  }
  assert.throws(() => new Batch([{ path: a, kind: 'image', bytes: 1, format: 'JPG' }], params({ output: { location: 'sameFolder', template: '../%f' } }), env), /names a file/);
  assert.equal(await exists(path.join(dir, 'out')), false);
});

test('reverting twice at once runs once, and reverting after the backups were deleted says so', async t => {
  if (!needTools(t, 'jpegoptim', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(320, 240, 1)), original = await digest(a);
  const batch = await batchOf(env, [a], params());
  await batch.run();
  const restore = mock.method(batch.backup, 'restore');
  const [first, second] = await Promise.all([batch.revert(), batch.revert()]);
  assert.deepEqual([first, second], [[], []]);
  assert.equal(first, second, 'both callers got the one revert\'s answer');
  assert.equal(restore.mock.callCount(), 1, 'the original was restored once');
  assert.equal(await digest(a), original);
  await batch.deleteBackups();
  await assert.rejects(batch.revert(), /backups of this batch were deleted/);
  assert.equal(batch.phase, 'reverted');
});

test('a revert that restored the original but not the file it displaced finishes on the next try', async t => {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'exiftool')) return;
  const { files, env, params } = await setup(t);
  const shot = await write(path.join(files, 'shot.png'), await png(400, 300, 3)), mine = await write(path.join(files, 'shot.jpeg'), Buffer.from('my own jpeg'));
  const original = await digest(shot);
  const p = params(); p.image = { ...p.image, convert: 'jpeg' };
  const batch = new Batch((await scanBatch([shot])).files, p, env);
  await batch.run();
  assert.deepEqual(statuses(batch), ['done']);
  const restore = batch.backup.restore.bind(batch.backup);
  // The first restore (the original) works; the second (the user's file the result took the place of) fails.
  let calls = 0;
  const fake = mock.method(batch.backup, 'restore', (file: string) => ++calls === 2 ? Promise.reject(new Error('access denied')) : restore(file));
  const failures = await batch.revert();
  assert.equal(failures.length, 1);
  assert.match(failures[0], /access denied/);
  assert.equal(await digest(shot), original, 'the original is back');
  assert.deepEqual(statuses(batch), ['done'], 'the file still counts as not reverted');
  fake.mock.restore();
  assert.deepEqual(await batch.revert(), [], 'the retry is not stopped by the original that is already back');
  assert.deepEqual(statuses(batch), ['reverted']);
  assert.equal(await readFile(mine, 'utf8'), 'my own jpeg');
  assert.equal(await digest(shot), original);
});

test('an earlier batch can be opened again from its manifest and reverted', async t => {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'exiftool')) return;
  const { files, env, params, workdir } = await setup(t);
  const a = await write(path.join(files, 'a.jpg'), await jpeg(320, 240, 1)), b = await write(path.join(files, 'b.jpg'), await jpeg(320, 240, 2));
  const shot = await write(path.join(files, 'shot.png'), await png(400, 300, 3)), mine = await write(path.join(files, 'shot.jpeg'), Buffer.from('my own jpeg'));
  const originals = await Promise.all([a, b, shot].map(digest));
  const first = await batchOf(env, [a], params());
  await first.run();
  await new Promise(resolve => setTimeout(resolve, 30));
  const convert = params(); convert.image = { ...convert.image, convert: 'jpeg' };
  const second = new Batch((await scanBatch([b, shot])).files, convert, env);
  await second.run();
  assert.deepEqual(statuses(second), ['done', 'done']);
  assert.deepEqual(await BatchBackup.latest(workdir), { id: second.id, results: 2 }, 'the newest batch with something to revert');
  assert.deepEqual(await BatchBackup.latest(workdir, second.id), { id: first.id, results: 1 });
  assert.equal(await Batch.restore(randomUUID(), env), undefined, 'a batch with no manifest is not there');

  // As after a restart: nothing of the batch is in memory but its manifest.
  const reopened = (await Batch.restore(second.id, env))!;
  assert.deepEqual([reopened.id, reopened.phase, statuses(reopened)], [second.id, 'finished', ['done', 'done']]);
  assert.deepEqual(reopened.items.map(item => [item.name, item.kind, item.result && path.basename(item.result)]), [['b.jpg', 'image', 'b.jpg'], ['shot.png', 'image', 'shot.jpeg']]);
  assert.deepEqual(await reopened.revert(), []);
  assert.deepEqual(statuses(reopened), ['reverted', 'reverted']);
  assert.deepEqual(await Promise.all([b, shot].map(digest)), [originals[1], originals[2]]);
  assert.equal(await readFile(mine, 'utf8'), 'my own jpeg');
  assert.equal((await BatchBackup.latest(workdir))?.id, first.id, 'a reverted batch has nothing left to offer');

  const again = (await Batch.restore(first.id, env))!;
  assert.deepEqual(await again.revert(), []);
  assert.equal(await digest(a), originals[0]);
  assert.equal(await BatchBackup.latest(workdir), undefined);
  assert.equal(await Batch.restore(first.id, env).then(batch => batch?.items.length), 0, 'and nothing to open');
});
