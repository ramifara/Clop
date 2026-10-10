import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { FolderWatcher, backoff, type WatcherHost } from './watcher';
import { watchedTrees } from './folder-events';

const timing = { stabilityMs: 100, checkMs: 25, pollMs: 150, settleMs: 20, windowMs: 400, safeMs: 1500, safeDelayMs: 300 };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, ms = 5000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await pause(25)) if (check()) return;
  assert.fail(what);
}
let shade = 0;
/** A small PNG, different each time so no two files are alike. */
const image = (file: string) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade++ % 255, g: 90, b: 140 } } }).png().toFile(file);

async function setup(t: TestContext, overrides: Partial<ClopSettings> = {}, host: Partial<WatcherHost> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clop-watch-')), dir = path.join(root, 'Shots');
  await mkdir(dir);
  const state = {
    settings: { ...defaultSettings(), imageDirs: [dir], minImageSizeKB: 0, maxImageFileCount: 3, optimisedFileProtectionMs: 400, ...overrides } as ClopSettings,
    handled: [] as [string, string][], cancelled: [] as string[], notices: [] as string[], disabled: 0, optimised: new Set<string>(),
  };
  const watcher = new FolderWatcher('image', {
    settings: () => state.settings, owns: file => file.includes(`${path.sep}work${path.sep}`), isOptimised: async file => state.optimised.has(file),
    handle: async (file, folder) => { state.handled.push([path.basename(file), folder]); return undefined; }, cancel: files => state.cancelled.push(...files.map(file => path.basename(file))),
    notice: text => state.notices.push(text), disable: () => { state.disabled++; }, ...host,
  }, timing);
  t.after(async () => { await watcher.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dir, state, watcher, names: () => state.handled.map(([name]) => name).sort() };
}

test('optimises images that appear, never those already there, hidden ones, other kinds or Clop\'s own files', async t => {
  const { dir, state, watcher, names } = await setup(t);
  await image(path.join(dir, 'before.png'));
  await watcher.update();
  assert.equal(watcher.watching, true);
  await mkdir(path.join(dir, 'work')); await mkdir(path.join(dir, 'sub'));
  await image(path.join(dir, '.hidden.png')); await image(path.join(dir, 'work', 'result.png')); await image(path.join(dir, '.clop-1234.tmp'));
  await writeFile(path.join(dir, 'notes.txt'), 'text'); await writeFile(path.join(dir, 'clip.mp4'), 'video');
  await image(path.join(dir, 'sub', 'nested.png'));
  await until(() => state.handled.length === 1, 'the nested image was not optimised');
  await image(path.join(dir, 'after.png'));
  await until(() => state.handled.length === 2, 'the new image was not optimised');
  await pause(300);
  assert.deepEqual(names(), ['after.png', 'nested.png']);
  // The watched folder comes back as it is stored, to look up its own settings.
  assert.deepEqual(state.handled.map(([, folder]) => folder), [dir, dir]);
});
test('a file Clop just optimised, or one the marker or .clopignore names, is left alone', async t => {
  const { dir, state, watcher, names } = await setup(t);
  await watcher.update();
  const shot = path.join(dir, 'shot.png');
  await image(shot);
  await until(() => state.handled.length === 1, 'the image was not optimised');
  // Written again within `optimisedFileProtectionMs`, as Clop's own in-place write is.
  await pause(50); await image(shot); await pause(350);
  assert.deepEqual(names(), ['shot.png']);
  state.optimised.add(path.join(dir, 'marked.png'));
  await writeFile(path.join(dir, '.clopignore-image'), 'ignored-*\n');
  await image(path.join(dir, 'marked.png')); await image(path.join(dir, 'ignored-1.png'));
  await pause(500);
  // Once the protection ends, a real change is optimised again.
  await image(shot);
  await until(() => state.handled.length === 2, 'the changed image was not optimised again');
  assert.deepEqual(names(), ['shot.png', 'shot.png']);
});
test('more files at once than the kind\'s limit are all left alone, with a notice', async t => {
  const { dir, state, watcher } = await setup(t, { maxImageFileCount: 2 });
  await watcher.update();
  await Promise.all(['a', 'b', 'c'].map(name => image(path.join(dir, `${name}.png`))));
  await until(() => state.notices.length > 0, 'no notice for too many files');
  await pause(300);
  // A file handed over before the last one appeared is stopped through `cancel`.
  assert.deepEqual(state.cancelled.sort(), ['a.png', 'b.png', 'c.png']);
  assert.ok(state.handled.every(([name]) => state.cancelled.includes(name)));
  assert.match(state.notices[0], /More than 2 images appeared in .*Shots/);
  // After the burst, single files are optimised again.
  await pause(500);
  await image(path.join(dir, 'single.png'));
  await until(() => state.handled.length === 1, 'a single file after the burst was not optimised');
});
test('nothing is watched while paused or disabled, and watching follows settings changes and missing folders', async t => {
  const { root, dir, state, watcher } = await setup(t, { pauseAutomaticOptimisations: true });
  await watcher.update();
  assert.equal(watcher.watching, false);
  await image(path.join(dir, 'paused.png')); await pause(300);
  state.settings = { ...state.settings, pauseAutomaticOptimisations: false, enableAutomaticImageOptimisations: false };
  await watcher.update();
  assert.equal(watcher.watching, false);
  state.settings = { ...state.settings, enableAutomaticImageOptimisations: true };
  await watcher.update();
  assert.equal(watcher.watching, true);
  await image(path.join(dir, 'running.png'));
  await until(() => state.handled.length === 1, 'the image was not optimised once watching resumed');
  // A folder that does not exist yet is watched as soon as it appears.
  const later = path.join(root, 'Later');
  state.settings = { ...state.settings, imageDirs: [later] };
  await watcher.update();
  assert.equal(watcher.watching, false);
  await mkdir(later); await pause(400);
  assert.equal(watcher.watching, true);
  await image(path.join(later, 'late.png'));
  await until(() => state.handled.some(([name]) => name === 'late.png'), 'the image in the folder that appeared was not optimised');
  assert.deepEqual(state.handled.map(([name]) => name), ['running.png', 'late.png']);
});
test('at first launch, files changing right away are held, and a burst turns the kind off', async t => {
  const calm = await setup(t, {}, { firstLaunch: true });
  await calm.watcher.update();
  await image(path.join(calm.dir, 'one.png')); await image(path.join(calm.dir, 'two.png'));
  await pause(200);
  assert.deepEqual(calm.state.handled, [], 'held during the first seconds');
  await until(() => calm.state.handled.length === 2, 'held files were not optimised');
  const busy = await setup(t, { maxImageFileCount: 20 }, { firstLaunch: true });
  await busy.watcher.update();
  for (let i = 0; i < 7; i++) await image(path.join(busy.dir, `rewritten-${i}.png`));
  await until(() => busy.state.disabled === 1, 'a burst at first launch did not turn image optimisation off');
  await pause(500);
  assert.deepEqual(busy.state.handled, []);
  assert.match(busy.state.notices[0], /Automatic image optimisation is now off/);
});
test('one watch covers a whole tree, shared by every kind watching it; hidden folders and cloud placeholders are left alone', async t => {
  const placeholders = new Set<string>();
  const images = await setup(t, {}, { isLocal: async file => !placeholders.has(path.basename(file)) });
  const handledVideos: string[] = [];
  const videos = new FolderWatcher('video', {
    settings: () => ({ ...images.state.settings, videoDirs: [images.dir], minVideoSizeKB: 0 }), owns: () => false, isOptimised: async () => false,
    handle: async file => { handledVideos.push(path.basename(file)); return undefined; }, cancel: () => {}, notice: () => {}, disable: () => {},
  }, timing);
  t.after(() => videos.close());
  const before = watchedTrees();
  await images.watcher.update(); await videos.update();
  assert.equal(watchedTrees(), before + 1, 'both kinds share one watch of the folder');
  const deep = path.join(images.dir, 'a', 'b', 'c', 'd'), hidden = path.join(images.dir, '.git', 'objects');
  await mkdir(deep, { recursive: true }); await mkdir(hidden, { recursive: true });
  await image(path.join(deep, 'deep.png')); await image(path.join(hidden, 'blob.png'));
  placeholders.add('cloud.png'); await image(path.join(images.dir, 'cloud.png'));
  await writeFile(path.join(deep, 'clip.mp4'), 'video');
  await until(() => images.state.handled.length === 1 && handledVideos.length === 1, 'files deep in the tree were not optimised');
  await pause(300);
  assert.deepEqual(images.names(), ['deep.png']);
  assert.deepEqual(handledVideos, ['clip.mp4']);
  // Closing one kind leaves the other watching.
  await videos.close();
  assert.equal(watchedTrees(), before + 1);
  await image(path.join(images.dir, 'after.png'));
  await until(() => images.state.handled.length === 2, 'the image watcher stopped with the video watcher');
  await images.watcher.close();
  assert.equal(watchedTrees(), before);
});
test('a file whose attributes or last access change is left alone; new content is optimised', async t => {
  const { dir, state, watcher } = await setup(t);
  const old = path.join(dir, 'old.png'), hour = new Date(Date.now() - 3_600_000);
  await image(old); await utimes(old, hour, hour);
  await watcher.update();
  await chmod(old, 0o600); await chmod(old, 0o644);
  await utimes(old, new Date(), hour);
  await pause(600);
  assert.deepEqual(state.handled, [], 'attribute and last-access changes are not new content');
  await appendFile(old, Buffer.alloc(16));
  await until(() => state.handled.length === 1, 'new content was not optimised');
});
test('a watched folder that is renamed away or replaced is watched again where it is', async t => {
  const { root, dir, state, watcher } = await setup(t);
  await watcher.update();
  await rename(dir, path.join(root, 'Old'));
  await until(() => !watcher.watching, 'the renamed folder was still watched');
  await mkdir(dir);
  await until(() => watcher.watching, 'the new folder of the same name was not watched');
  await image(path.join(dir, 'new.png'));
  await until(() => state.handled.length === 1, 'an image in the new folder was not optimised');
  await image(path.join(root, 'Old', 'moved.png')); await pause(400);
  assert.deepEqual(state.handled.map(([name]) => name), ['new.png'], 'the folder that moved away is no longer watched');
});
test('a folder that cannot be watched is retried less and less often, with one notice', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  assert.deepEqual([1, 2, 3, 10].map(count => backoff(count, 5000)), [5000, 10000, 20000, 300000]);
  const { dir, state, watcher } = await setup(t);
  await chmod(dir, 0o000);
  try {
    await watcher.update();
    assert.equal(watcher.watching, false);
    await until(() => state.notices.length === 1, 'no notice for a folder that keeps failing');
    assert.match(state.notices[0], /keeps failing to watch .*Shots/);
    await pause(1000);
    assert.equal(state.notices.length, 1, 'one notice while it keeps failing');
  } finally { await chmod(dir, 0o755); }
  await until(() => watcher.watching, 'the folder was not watched once it could be', 10000);
});
