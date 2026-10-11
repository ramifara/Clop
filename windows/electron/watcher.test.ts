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

async function setup(t: TestContext, overrides: Partial<ClopSettings> = {}, host: Partial<WatcherHost> = {}, times: Partial<typeof timing> = {}) {
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
  }, { ...timing, ...times });
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
  await until(() => state.handled.some(([name]) => name === 'single.png'), 'a single file after the burst was not optimised');
  assert.ok(!state.cancelled.includes('single.png'));
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
test('a folder that refuses a watch does not stop the others from being watched', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const { root, dir, state, watcher } = await setup(t);
  const locked = path.join(root, 'Locked');
  await mkdir(locked); await chmod(locked, 0o000);
  try {
    state.settings = { ...state.settings, imageDirs: [locked, dir] };
    await watcher.update();
    assert.equal(watcher.watching, true);
    await image(path.join(dir, 'good.png'));
    await until(() => state.handled.length === 1, 'the watchable folder was not watched');
    // Retrying the refusing folder leaves the other watched.
    await pause(500);
    await image(path.join(dir, 'later.png'));
    await until(() => state.handled.length === 2, 'retrying the refusing folder stopped the other');
  } finally { await chmod(locked, 0o755); }
});
test('overlapping updates still end up watching', async t => {
  // A settings change can call update while an earlier one is still subscribing; whichever way they interleave, the folder is watched.
  for (const ticks of [0, 1, 2, 3, 5, 8]) {
    const { dir, state, watcher } = await setup(t);
    const first = watcher.update();
    for (let i = 0; i < ticks; i++) await new Promise(resolve => setImmediate(resolve));
    await Promise.all([first, watcher.update()]);
    assert.equal(watcher.watching, true, `after ${ticks} ticks`);
    await image(path.join(dir, 'shot.png'));
    await until(() => state.handled.length === 1, `nothing was watched after overlapping updates ${ticks} ticks apart`);
  }
});
test('a copy that replaces a file and keeps the source\'s old modification time is new content', async t => {
  const { dir, state, watcher } = await setup(t);
  const old = path.join(dir, 'replaced.png'), hour = new Date(Date.now() - 3_600_000);
  await image(old); await utimes(old, hour, hour);
  await watcher.update();
  // Seen once, for a change that is not new content. On Windows chmod only toggles the read-only attribute, and clearing it from a
  // writable file changes nothing and reports nothing, so the file is made read-only first (and back, so it can be overwritten).
  await chmod(old, 0o400);
  await utimes(old, new Date(), hour);
  await pause(200);
  await chmod(old, 0o600);
  await pause(400);
  assert.deepEqual(state.handled, []);
  // Explorer writes the copy over the file, then gives it the source's modification time.
  await sharp({ create: { width: 90, height: 40, channels: 3, background: '#335577' } }).png().toFile(old); await utimes(old, hour, hour);
  await until(() => state.handled.length === 1, 'the replaced file was not optimised');
});

test('a file named in .clopignore does not count towards the batch limit', async t => {
  const { dir, state, watcher, names } = await setup(t, { maxImageFileCount: 1 });
  await watcher.update();
  await writeFile(path.join(dir, '.clopignore-image'), 'ignored-*\n');
  await image(path.join(dir, 'ignored-1.png')); await pause(150);
  await image(path.join(dir, 'real.png'));
  await until(() => state.handled.length === 1, 'the real image was not optimised');
  await pause(300);
  assert.deepEqual([names(), state.cancelled, state.notices], [['real.png'], [], []]);
});
test('a file named in .clopignore is not optimised with the files held at first launch', async t => {
  const { dir, state, watcher, names } = await setup(t, {}, { firstLaunch: true });
  await watcher.update();
  await writeFile(path.join(dir, '.clopignore-image'), 'ignored-*\n');
  await image(path.join(dir, 'ignored-1.png')); await image(path.join(dir, 'real.png'));
  await until(() => state.handled.length > 0, 'the held image was not optimised');
  await pause(300);
  assert.deepEqual(names(), ['real.png']);
});
test('pausing while a file settles stops it from being optimised', async t => {
  const { dir, state, watcher } = await setup(t, {}, {}, { settleMs: 400 });
  await watcher.update();
  await image(path.join(dir, 'late.png'));
  await pause(300);
  state.settings = { ...state.settings, pauseAutomaticOptimisations: true };
  await watcher.update();
  await pause(600);
  assert.deepEqual(state.handled, []);
});
test('a file saved again while it is being optimised is optimised again afterwards', async t => {
  let first = true;
  const { dir, state, watcher } = await setup(t, {}, { handle: async file => { state.handled.push([path.basename(file), dir]); if (first) { first = false; await pause(400); } return undefined; } });
  await watcher.update();
  const shot = path.join(dir, 'shot.png');
  await image(shot);
  await until(() => state.handled.length === 1, 'the image was not optimised');
  await pause(100); await image(shot);
  await until(() => state.handled.length === 2, 'the second save was dropped');
});

test('files that change while the Windows helper starts are looked at once it is ready', async t => {
  let helper: 'ready' | 'starting' | 'stopped' = 'starting';
  const { dir, state, watcher, names } = await setup(t, {}, { helper: () => helper });
  await watcher.update();
  await image(path.join(dir, 'early.png'));
  await pause(500);
  assert.deepEqual(state.handled, [], 'nothing is optimised before the helper can say whether the file is local');
  helper = 'ready'; watcher.resume();
  await until(() => state.handled.length === 1, 'the early file was dropped');
  assert.deepEqual(names(), ['early.png']);
  await image(path.join(dir, 'later.png'));
  await until(() => state.handled.length === 2, 'a file after the helper was ready was not optimised');
});
test('with the Windows helper stopped, watched files are left alone with one notice, and optimised again once it is back', async t => {
  let helper: 'ready' | 'starting' | 'stopped' = 'stopped';
  const { dir, state, watcher } = await setup(t, {}, { helper: () => helper });
  await watcher.update();
  await image(path.join(dir, 'a.png')); await pause(300); await image(path.join(dir, 'b.png'));
  await pause(500);
  assert.deepEqual([state.handled, state.notices.length], [[], 1]);
  assert.match(state.notices[0], /helper is not running/);
  assert.match(state.notices[0], /Restart Clop to have watched folders optimise new files again\./, 'a restart does not optimise files that are already there');
  helper = 'ready'; watcher.resume();
  await image(path.join(dir, 'c.png'));
  await until(() => state.handled.length === 1, 'a file after the helper came back was not optimised');
});

test('a file named in .clopignore does not keep the files of a burst cancelled', async t => {
  const { dir, state, watcher } = await setup(t, { maxImageFileCount: 2 }, {}, { windowMs: 1500 });
  await watcher.update();
  await writeFile(path.join(dir, '.clopignore-image'), 'ignored-*\n');
  // One after another, so only the last file starts the cleanup.
  for (const name of ['a', 'b', 'c']) { await image(path.join(dir, `${name}.png`)); await pause(250); }
  await until(() => state.notices.length > 0, 'no notice for too many files');
  await pause(200);
  await image(path.join(dir, 'ignored-1.png'));
  await pause(2500);
  const before = state.handled.length;
  await image(path.join(dir, 'a.png'));
  await until(() => state.handled.length === before + 1, 'a file of the burst was still left alone after the burst ended');
  assert.equal(state.handled.at(-1)![0], 'a.png');
});

test('files held while the helper started are told about when it stops instead', async t => {
  let helper: 'ready' | 'starting' | 'stopped' = 'starting';
  const { dir, state, watcher } = await setup(t, {}, { helper: () => helper });
  await watcher.update();
  await image(path.join(dir, 'early.png'));
  await pause(300);
  assert.deepEqual(state.notices, []);
  helper = 'stopped'; watcher.resume();
  await until(() => state.notices.length === 1, 'the held file was dropped without a word');
  assert.match(state.notices[0], /helper is not running/);
  assert.deepEqual(state.handled, []);
});

test('a late file that is not ignored still lets the burst\'s files go once the window has passed', async t => {
  const { dir, state, watcher } = await setup(t, { maxImageFileCount: 2 }, {}, { windowMs: 1500 });
  await watcher.update();
  for (const name of ['a', 'b', 'c']) { await image(path.join(dir, `${name}.png`)); await pause(250); }
  await until(() => state.notices.length > 0, 'no notice for too many files');
  // After the first two have left the window, one more file is no burst; it is optimised, and the burst is forgotten after its own window.
  await pause(1000);
  await image(path.join(dir, 'd.png'));
  await until(() => state.handled.some(([name]) => name === 'd.png'), 'the late file was not optimised');
  await pause(2600);
  const before = state.handled.length;
  await image(path.join(dir, 'a.png'));
  await until(() => state.handled.length === before + 1, 'a file of the burst was still left alone after the burst ended');
  assert.equal(state.handled.at(-1)![0], 'a.png');
});
