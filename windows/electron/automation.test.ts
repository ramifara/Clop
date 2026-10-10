import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OptimisedMarker } from '../core/marker';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { needTools } from '../core/testing';
import { Workdir } from '../core/workdir';
import { clip } from '../core/media/video.fixtures';
import { FolderResults, LastBatch, folderPlacement, pipelinesFor, type FolderEnv } from './automation';
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
test('a result that is not smaller leaves the file alone and marks it', async t => {
  const f = await setup(t); if (!f) return;
  const file = path.join(f.dir, 'small.png'); await writeFile(file, 'png bytes');
  const placement = folderPlacement(file, 'image', f.env);
  assert.equal(await placement.place({ path: file, bytes: 9, format: 'png', unchanged: true }), file);
  assert.equal(await readFile(file, 'utf8'), 'png bytes');
  assert.equal(await f.marker.isOptimised(file), true);
  assert.equal(await placement.restore(), undefined);
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
  assert.deepEqual(batch.take(), ['a', 'b', 'c']);
  assert.deepEqual(batch.take(), []);
  batch.add('d'); now = 6000; batch.add('e');
  assert.deepEqual(batch.take(), ['e']);
  assert.deepEqual(pipelinesFor('image', '~/Desktop'), []);
});
