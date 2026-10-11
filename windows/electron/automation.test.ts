import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OptimisedMarker } from '../core/marker';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { needTools } from '../core/testing';
import { exists } from '../core/fileops';
import { Workdir } from '../core/workdir';
import { clip } from '../core/media/video.fixtures';
import { graphic } from '../core/media/image.fixtures';
import { tone } from '../core/media/audio.fixtures';
import { parseInvocation, planFor } from '../core/cards/actions';
import { FakeEffects } from '../core/pipeline/executor.fixtures';
import { runPlan, type CardHost } from './cards';
import { FolderResults, LastBatch, folderPlacement, restoreAll, type FolderEnv } from './automation';
import { FolderWatcher } from './watcher';
import { run } from '../core/run';
import { ItemEngine, sampleImage } from './items';

const balanced = { mode: 'balanced', format: 'auto', scale: 1 } as const;
async function setup(t: TestContext, overrides: Partial<ClopSettings> = {}) {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'gifsicle', 'ffmpeg', 'ffprobe', 'exiftool')) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-folders-')), dir = path.join(root, 'Desktop');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(dir);
  const workdir = await new Workdir(path.join(root, 'work')).ensure(), marker = new OptimisedMarker(path.join(root, 'optimised.json'));
  const state = { settings: { ...defaultSettings(), imageDirs: [dir], videoDirs: [dir], ...overrides } as ClopSettings, quiet: [] as string[], saved: [] as number[] };
  const engine = new ItemEngine(path.join(workdir.temp, 'session'), () => state.settings), counter = { value: 0 };
  const env = (): FolderEnv => ({ settings: state.settings, workdir, marker, counter });
  const folders = new FolderResults({ engine, settings: () => state.settings, env, options: () => balanced, makeRoom: async () => {}, quiet: id => state.quiet.push(id), saved: value => state.saved.push(value) });
  return { root, dir, workdir, marker, engine, folders, state, env };
}
const backups = async (workdir: Workdir) => Promise.all((await readdir(workdir.backups)).map(name => readFile(path.join(workdir.backups, name))));

test('a watched image is optimised in place, its original kept in the backups, and restoring puts it back', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.dir, 'shot.png'), original = await sampleImage();
  await writeFile(file, original);
  assert.equal(await f.folders.optimise(file, 'image', f.dir), file);
  const [item] = f.engine.list();
  assert.deepEqual([item.source, item.status, f.engine.output(item.id)], ['folder', 'ready', file]);
  assert.ok((await stat(file)).size < original.length);
  assert.equal(item.outputBytes, (await stat(file)).size);
  assert.deepEqual(await backups(f.workdir), [original]);
  assert.equal(await f.marker.isOptimised(file), true, 'the optimised file is marked, so the watcher leaves it alone');
  assert.deepEqual(f.state.quiet, []);
  await f.engine.restore(item.id);
  assert.deepEqual(await readFile(file), original);
  assert.equal(f.engine.output(item.id), file);
  assert.equal(await f.marker.isOptimised(file), true, 'the restored original is not optimised again');
  // Optimising again from the card places over the file again; restoring still gives back the first original.
  await f.engine.apply(item.id, { ...balanced, scale: 0.5 });
  assert.ok((await stat(file)).size < original.length);
  await f.engine.restore(item.id);
  assert.deepEqual(await readFile(file), original);
});
test('a watched video is optimised in place with a backup', async t => {
  const f = await setup(t); if (!f) return;
  const file = await clip(path.join(f.dir, 'clip.mp4'), { width: 640, height: 360, seconds: 1 }), original = await readFile(file);
  assert.equal(await f.folders.optimise(file, 'video', f.dir), file);
  const [item] = f.engine.list();
  assert.equal(item.status, 'ready', item.error);
  assert.ok((await stat(file)).size < original.length);
  assert.deepEqual(await backups(f.workdir), [original]);
});
test('results follow the optimised-file setting: a copy beside the file, or the shelf only', async t => {
  const f = await setup(t, { optimisedImageBehaviour: 'sameFolder', sameFolderNameTemplateImage: '%f-%i' }); if (!f) return;
  const file = path.join(f.dir, 'shot.png'), original = await sampleImage();
  await writeFile(file, original);
  const copy = path.join(f.dir, 'shot-1.png');
  assert.equal(await f.folders.optimise(file, 'image', f.dir), copy);
  assert.deepEqual(await readFile(file), original, 'the original stays as it was');
  assert.ok((await stat(copy)).size < original.length);
  assert.deepEqual(f.state.saved, [1], 'the advanced %i counter is saved');
  assert.equal(await f.marker.isOptimised(copy), true);
  await f.engine.restore(f.engine.list()[0].id);
  assert.deepEqual(await readFile(copy), original, 'the copy gets the original, as macOS restores a templated copy');
  f.state.settings = { ...f.state.settings, optimisedImageBehaviour: 'temporary' };
  const other = path.join(f.dir, 'other.png');
  await writeFile(other, original);
  const result = await f.folders.optimise(other, 'image', f.dir);
  assert.ok(result && f.workdir.owns(result), 'the result stays in the working directory');
  assert.deepEqual(await readFile(other), original);
});
test('moving results to a copy after an in-place one gives the file its original back', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.dir, 'shot.png'), original = await sampleImage();
  await writeFile(file, original);
  await f.folders.optimise(file, 'image', f.dir);
  const [item] = f.engine.list();
  assert.ok((await stat(file)).size < original.length);
  f.state.settings = { ...f.state.settings, optimisedImageBehaviour: 'sameFolder', sameFolderNameTemplateImage: '%f-copy' };
  await f.engine.apply(item.id, { ...balanced, scale: 0.5 });
  const copy = path.join(f.dir, 'shot-copy.png');
  assert.equal(f.engine.output(item.id), copy);
  assert.deepEqual(await readFile(file), original, 'the earlier in-place result gives way to the original');
  assert.ok((await stat(copy)).size < original.length);
  await f.engine.restore(item.id);
  assert.deepEqual(await readFile(copy), original);
  assert.deepEqual(await readFile(file), original);
});
test('a watched file whose name already matches the same-folder template is backed up and can be restored', async t => {
  const f = await setup(t, { optimisedImageBehaviour: 'sameFolder', sameFolderNameTemplateImage: '%f-optimised' }); if (!f) return;
  const file = path.join(f.dir, 'holiday-optimised.png'), original = await sampleImage();
  await writeFile(file, original);
  assert.equal(await f.folders.optimise(file, 'image', f.dir), file);
  assert.ok((await stat(file)).size < original.length);
  // Compared with `equals`: a failing deepEqual would print these multi-megabyte buffers.
  const kept = await backups(f.workdir);
  assert.deepEqual([kept.length, kept[0]?.equals(original)], [1, true]);
  await f.engine.restore(f.engine.list()[0].id);
  assert.equal((await readFile(file)).equals(original), true);
});
test('a result that is not smaller leaves the file alone and marks it', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.dir, 'small.png'); await writeFile(file, 'png bytes');
  const placement = folderPlacement(file, 'image', f.env);
  assert.equal(await placement.place({ path: file, bytes: 9, format: 'png', unchanged: true }), file);
  assert.equal(await readFile(file, 'utf8'), 'png bytes');
  assert.equal(await f.marker.isOptimised(file), true);
  assert.equal(await placement.restore(), undefined);
});
test('a file saved again while its result was made is left as it is, and one that did not change gets its result', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.dir, 'saved.png'), staged = path.join(f.root, 'staged.png'), result = path.join(f.root, 'result.png');
  await writeFile(file, 'first save'); await writeFile(result, 'small');
  const info = await stat(file);
  // The shelf's copy keeps the size and modification time of the file when it was read.
  await copyFile(file, staged); await utimes(staged, info.atime, info.mtime);
  const output = { path: result, bytes: 5, format: 'png' };
  assert.equal(await folderPlacement(file, 'image', f.env).place(output, staged), file);
  assert.equal(await readFile(file, 'utf8'), 'small');
  await writeFile(file, 'second save, longer'); await writeFile(result, 'small');
  await assert.rejects(folderPlacement(file, 'image', f.env).place(output, staged), /saved\.png changed since Clop read it/);
  assert.equal(await readFile(file, 'utf8'), 'second save, longer');
  await rm(file);
  await assert.rejects(folderPlacement(file, 'image', f.env).place(output, staged), /changed since Clop read it/);
  assert.equal(await exists(file), false, 'a deleted file is not brought back');
});
test('folders in the hidden-results list keep their results quiet, and cancelled files are stopped and removed', async t => {
  const f = await setup(t); if (!f) return;
  f.state.settings = { ...f.state.settings, dirsHideFloatingResult: [f.dir] };
  const file = path.join(f.dir, 'quiet.png'), original = await sampleImage();
  await writeFile(file, original);
  await f.folders.optimise(file, 'image', f.dir);
  assert.deepEqual(f.state.quiet, [f.engine.list()[0].id]);
  const video = await clip(path.join(f.dir, 'long.mp4'), { width: 640, height: 360, seconds: 4 }), bytes = await readFile(video);
  const running = f.folders.optimise(video, 'video', f.dir);
  while (f.engine.list().length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  f.folders.cancel([video]);
  assert.equal(await running, undefined);
  await f.engine.idle();
  assert.deepEqual(f.engine.list().map(item => item.name), ['quiet.png']);
  assert.deepEqual(await readFile(video), bytes, 'a stopped video is left as it was');
});
test('the last batch is the results started close together, taken once', () => {
  let now = 0;
  const batch = new LastBatch(2000, () => now);
  batch.add('a'); now = 1500; batch.add('b'); now = 3000; batch.add('c');
  assert.equal(batch.size, 3);
  assert.deepEqual(batch.take(), ['a', 'b', 'c']);
  assert.equal(batch.size, 0);
  assert.deepEqual(batch.take(), []);
  batch.add('d'); now = 6000; batch.add('e');
  assert.deepEqual(batch.take(), ['e']);
});
test('a file cancelled while it is still being copied into the shelf is never optimised', async t => {
  const f = await setup(t); if (!f) return;
  const video = await clip(path.join(f.dir, 'burst.mp4'), { width: 640, height: 360, seconds: 2 }), bytes = await readFile(video);
  // Cancelled before its copy starts, and while it is being copied in: the engine announces an item before `staged` hears it.
  const early = f.folders.optimise(video, 'video', f.dir);
  f.folders.cancel([video]);
  assert.equal(await early, undefined);
  let staged = 0;
  f.engine.once('add', () => { staged++; f.folders.cancel([video]); });
  assert.equal(await f.folders.optimise(video, 'video', f.dir), undefined);
  assert.equal(staged, 1);
  await f.engine.idle();
  assert.deepEqual(f.engine.list(), []);
  assert.deepEqual(await readFile(video), bytes);
  assert.deepEqual(await readdir(f.workdir.backups), []);
});
test('restoring gives back a file of the user\'s that a result replaced', async t => {
  const f = await setup(t); if (!f) return;
  // The card converts shot.png to WebP over an unrelated shot.webp the user already had.
  const file = path.join(f.dir, 'shot.png'), mine = path.join(f.dir, 'shot.webp'), original = await sampleImage();
  await writeFile(file, original); await writeFile(mine, 'my own webp');
  await f.folders.optimise(file, 'image', f.dir);
  const [item] = f.engine.list();
  await f.engine.apply(item.id, { ...balanced, format: 'webp' });
  assert.notEqual(await readFile(mine, 'utf8'), 'my own webp');
  await f.engine.restore(item.id);
  assert.deepEqual(await readFile(file), original);
  assert.equal(await readFile(mine, 'utf8'), 'my own webp');
  // A copy beside the file that took the place of the user's file gives that file back too.
  f.state.settings = { ...f.state.settings, optimisedImageBehaviour: 'sameFolder' };
  const other = path.join(f.dir, 'other.png'), theirs = path.join(f.dir, 'other-optimised.png');
  await writeFile(other, original); await writeFile(theirs, 'their file');
  await f.folders.optimise(other, 'image', f.dir);
  assert.notEqual(await readFile(theirs, 'utf8'), 'their file');
  await f.engine.restore(f.engine.list()[0].id);
  assert.equal(await readFile(theirs, 'utf8'), 'their file');
  assert.deepEqual(await readFile(other), original);
});
test('reverting leaves alone results the user edited, moved or deleted, and still restores the rest', async t => {
  const f = await setup(t); if (!f) return;
  const original = await sampleImage(), names = ['edited.png', 'moved.png', 'kept.png'];
  for (const name of names) { await writeFile(path.join(f.dir, name), original); await f.folders.optimise(path.join(f.dir, name), 'image', f.dir); }
  const ids = f.engine.list().map(item => item.id).reverse();
  await appendFile(path.join(f.dir, 'edited.png'), 'an edit');
  const edited = await readFile(path.join(f.dir, 'edited.png'));
  await rename(path.join(f.dir, 'moved.png'), path.join(f.dir, 'elsewhere.png'));
  const { restored, failures } = await restoreAll(f.engine, ids);
  assert.deepEqual(restored, [ids[2]]);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /^edited\.png: edited\.png changed after Clop optimised it/);
  assert.match(failures[1], /^moved\.png: moved\.png was moved or deleted/);
  assert.deepEqual(await readFile(path.join(f.dir, 'edited.png')), edited, 'the edit stays');
  assert.equal(await stat(path.join(f.dir, 'moved.png')).then(() => true, () => false), false, 'a moved file is not recreated');
  assert.deepEqual(await readFile(path.join(f.dir, 'kept.png')), original);
});
test('an older card leaves alone a file the user edited and Clop optimised again since, both for Restore and for a card action', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.dir, 'shot.png'), original = await sampleImage();
  await writeFile(file, original);
  await f.folders.optimise(file, 'image', f.dir);
  const [older] = f.engine.list();
  // The user saves an edit, and the watcher's next optimisation marks the file again.
  const edit = await graphic(300, 200).png().toBuffer();
  await writeFile(file, edit);
  await f.marker.markOptimised(file);
  await assert.rejects(f.engine.restore(older.id), /shot\.png changed after Clop optimised it, so Clop left it as it is/);
  assert.ok(edit.equals(await readFile(file)), 'the edit stays');
  await f.engine.apply(older.id, { ...balanced, scale: 0.5 });
  assert.match(f.engine.get(older.id).result.error ?? '', /shot\.png changed after Clop optimised it/);
  assert.ok(edit.equals(await readFile(file)), 'a card action does not write over the edit either');
});
test('a card action on a watched result that was moved away does not put a new copy where it was', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.dir, 'shot.png');
  await writeFile(file, await sampleImage());
  await f.folders.optimise(file, 'image', f.dir);
  const [item] = f.engine.list();
  // As a "Sort screenshots" pipeline, or the user, moves it.
  await mkdir(path.join(f.root, 'Sorted'));
  await rename(file, path.join(f.root, 'Sorted', 'shot.png'));
  await f.engine.apply(item.id, { ...balanced, scale: 0.5 });
  assert.match(f.engine.get(item.id).result.error ?? '', /shot\.png was moved or deleted after Clop optimised it, so Clop does not put a new copy where it was/);
  assert.deepEqual(await readdir(f.dir), []);
});
test('watching and optimising together optimise each file exactly once, in place, beside it or converted', async t => {
  const f = await setup(t, { minImageSizeKB: 0, maxImageFileCount: 10, optimisedFileProtectionMs: 300 }); if (!f) return;
  const handled: string[] = [];
  const watcher = new FolderWatcher('image', {
    settings: () => f.state.settings, owns: file => f.workdir.owns(file), isOptimised: file => f.marker.isOptimised(file),
    handle: (file, dir) => { handled.push(path.basename(file)); return f.folders.optimise(file, 'image', dir); }, cancel: files => f.folders.cancel(files), notice: () => {}, disable: () => {},
  }, { stabilityMs: 200, checkMs: 50, pollMs: 1000, settleMs: 50, windowMs: 400, safeMs: 0, safeDelayMs: 0 });
  t.after(() => watcher.close());
  await watcher.update();
  const settled = async (count: number) => {
    for (const deadline = Date.now() + 20000; Date.now() < deadline && (handled.length < count || f.engine.list().length < count || f.engine.list().some(item => item.status === 'processing')); ) await new Promise(resolve => setTimeout(resolve, 50));
    // Long enough for the watcher to see every write Clop made and for the protection to end.
    await new Promise(resolve => setTimeout(resolve, 1200));
  };
  await writeFile(path.join(f.dir, 'inplace.png'), await sampleImage());
  await settled(1);
  assert.deepEqual(handled, ['inplace.png']);
  f.state.settings = { ...f.state.settings, optimisedImageBehaviour: 'sameFolder' };
  await writeFile(path.join(f.dir, 'beside.png'), await sampleImage());
  await settled(2);
  assert.deepEqual(handled, ['inplace.png', 'beside.png']);
  assert.ok(await stat(path.join(f.dir, 'beside-optimised.png')).then(() => true, () => false));
  // A BMP becomes a JPEG in its place (the converted-file setting says so; its default leaves the BMP and puts the JPEG beside it), and its original goes to the backups.
  f.state.settings = { ...f.state.settings, optimisedImageBehaviour: 'inPlace', convertedImageBehaviour: 'inPlace' };
  await run('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240', '-frames:v', '1', path.join(f.root, 'converted.bmp')]);
  await rename(path.join(f.root, 'converted.bmp'), path.join(f.dir, 'converted.bmp'));
  await settled(3);
  assert.deepEqual(handled, ['inplace.png', 'beside.png', 'converted.bmp']);
  assert.deepEqual((await readdir(f.dir)).sort(), ['beside-optimised.png', 'beside.png', 'converted.jpeg', 'inplace.png']);
  assert.deepEqual(f.engine.list().map(item => item.status), ['ready', 'ready', 'ready']);
});
test('with the default settings a watched SVG, HEIC or BMP keeps its original, and its converted result goes beside it', async t => {
  const f = await setup(t, { minImageSizeKB: 0, maxImageFileCount: 10, optimisedFileProtectionMs: 300 }); if (!f) return;
  if (!needTools(t, 'heif-enc', 'heif-dec')) return;
  const handled: string[] = [];
  const watcher = new FolderWatcher('image', {
    settings: () => f.state.settings, owns: file => f.workdir.owns(file), isOptimised: file => f.marker.isOptimised(file),
    handle: (file, dir) => { handled.push(path.basename(file)); return f.folders.optimise(file, 'image', dir); }, cancel: files => f.folders.cancel(files), notice: () => {}, disable: () => {},
  }, { stabilityMs: 200, checkMs: 50, pollMs: 1000, settleMs: 50, windowMs: 400, safeMs: 0, safeDelayMs: 0 });
  t.after(() => watcher.close());
  await watcher.update();
  // Made outside the folder and moved in whole, as a download or a save lands.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">${Array.from({ length: 4000 }, (_, i) => `<rect x="${(i * 37) % 320}" y="${(i * 53) % 240}" width="3" height="3" fill="#${(i * 2654435761 % 0xffffff).toString(16).padStart(6, '0')}"/>`).join('')}</svg>`;
  await writeFile(path.join(f.root, 'logo.svg'), svg);
  await run('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480', '-frames:v', '1', path.join(f.root, 'scan.bmp')]);
  await run('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480', '-frames:v', '1', path.join(f.root, 'photo.png')]);
  await run('heif-enc', ['-q', '100', '-o', path.join(f.root, 'photo.heic'), path.join(f.root, 'photo.png')]);
  const names = ['logo.svg', 'photo.heic', 'scan.bmp'], originals = new Map<string, Buffer>();
  for (const name of names) originals.set(name, await readFile(path.join(f.root, name)));
  for (const name of names) await rename(path.join(f.root, name), path.join(f.dir, name));
  for (const deadline = Date.now() + 60000; Date.now() < deadline && (handled.length < 3 || f.engine.list().length < 3 || f.engine.list().some(item => item.status === 'processing')); ) await new Promise(resolve => setTimeout(resolve, 50));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.deepEqual([...handled].sort(), names);
  for (const name of names) assert.ok(originals.get(name)!.equals(await readFile(path.join(f.dir, name))), `${name} is where it was, unchanged`);
  // Converted results sit beside their originals under the original's name (the converted-file template is %f); none replaced a file.
  const results = f.engine.list().map(item => ({ status: item.status, output: f.engine.output(item.id) }));
  assert.ok(results.every(result => result.status === 'ready'), JSON.stringify(results));
  for (const { output } of results) assert.ok(names.includes(path.basename(output)) || (path.dirname(output) === f.dir && names.some(name => path.parse(name).name === path.parse(output).name)), output);
  assert.deepEqual((await readdir(f.dir)).sort(), ['logo.png', 'logo.svg', 'photo.heic', 'photo.jpeg', 'scan.bmp', 'scan.jpeg']);
  assert.deepEqual(await readdir(f.workdir.backups), [], 'no original was moved into the backups, where the cleaner would delete it');
});
test('a watched file that comes out in another format is placed by the converted-file settings, the card\'s format menu by the manual ones', async t => {
  const f = await setup(t, { convertedImageBehaviour: 'sameFolder', convertedSameFolderNameTemplateImage: '%f-auto', manualConvertedImageBehaviour: 'inPlace' } as Partial<ClopSettings>); if (!f) return;
  const file = path.join(f.dir, 'shot.png'), result = path.join(f.root, 'result.jpeg');
  await writeFile(file, 'png bytes'); await writeFile(result, 'jpeg');
  const output = { path: result, bytes: 4, format: 'jpeg' };
  assert.equal(await folderPlacement(file, 'image', f.env).place(output), path.join(f.dir, 'shot-auto.jpeg'));
  assert.equal(await folderPlacement(file, 'image', f.env).place(output, undefined, true), path.join(f.dir, 'shot.jpeg'));
  // The same format is an optimisation, by the optimised-file setting (over the file, by default).
  const same = path.join(f.root, 'result.png');
  await writeFile(same, 'png');
  assert.equal(await folderPlacement(file, 'image', f.env).place({ path: same, bytes: 3, format: 'png' }), file);
});
test('a conversion run on a watched file from its card moves the placement with it, so restoring gives the original back', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.dir, 'song.m4a');
  await tone(file, { seconds: 1, codec: ['-c:a', 'aac', '-b:a', '256k'] });
  const original = await readFile(file);
  assert.equal(await f.folders.optimise(file, 'audio', f.dir), file);
  const [item] = f.engine.list();
  assert.equal(item.status, 'ready', item.error);
  const host: CardHost = { engine: f.engine, settings: () => f.state.settings, pipeline: { env: f.env, effects: () => new FakeEffects(), counterChanged: () => {}, keep: () => {} } };
  await runPlan(host, item.id, planFor(item, parseInvocation('audio', { action: 'convert', arg: 'mp3' })) as never);
  assert.equal(f.engine.get(item.id).result.status, 'ready', f.engine.get(item.id).result.error);
  const converted = f.engine.output(item.id);
  assert.equal(path.extname(converted), '.mp3');
  await f.engine.restore(item.id);
  assert.equal((await readFile(file)).equals(original), true, 'the original is back where it was');
  assert.equal(await exists(converted), false, 'and the converted file is gone');
});
test('a pipeline chosen for a file runs on that file where it is, not on a copy in the shelf', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.dir, 'shot.png'), original = await sampleImage();
  await writeFile(file, original);
  const ran: string[] = [];
  // A pipeline that skips optimisation works on the file it is given, as `attachedAutomation` does with the `source` it is given.
  const automation = (source: string) => ({ skipOptimisation: true, fallback: false, run: async (input: { optimised?: string }) => { const target = input.optimised ?? source; ran.push(target); await appendFile(target, 'edited'); return { file: target, anyRan: true, warnings: [], started: target }; } });
  assert.equal(await f.folders.optimise(file, 'image', f.dir, automation), file);
  assert.deepEqual(ran, [file]);
  assert.equal((await readFile(file)).subarray(original.length).toString(), 'edited', 'the selected file itself was changed');
});
