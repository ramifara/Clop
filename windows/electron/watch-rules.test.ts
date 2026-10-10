import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { defaultSettings } from '../core/settings/schema';
import { needTools } from '../core/testing';
import { clip } from '../core/media/video.fixtures';
import { clopIgnored, hidesResult, ignoredBy, matchingWatchedDir, placeholderReply, qualifies, recentFiles, watchSettings, writable } from './watch-rules';

async function folder(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-rules-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const noise = (width: number, height: number) => sharp(Buffer.from(Array.from({ length: width * height * 3 }, (_, i) => (i * 7919) % 251)), { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 });
const host = { owns: (file: string) => file.includes(`${path.sep}work${path.sep}`), isOptimised: async () => false };

test('each kind reads its own watched-folder settings, with macOS defaults', () => {
  const s = defaultSettings({ home: '/home/me', desktop: '/home/me/Desktop', userData: '/data' });
  assert.deepEqual(watchSettings('image', s), { dirs: ['~/Desktop'], enabled: true, maxFiles: 4, maxMB: 50, minKB: 50, minResolution: 20, maxResolution: 0, skip: ['tiff'] });
  assert.deepEqual(watchSettings('video', s), { dirs: ['~/Desktop'], enabled: true, maxFiles: 1, maxMB: 500, minKB: 200, minResolution: 50, maxResolution: 0, skip: ['mkv', 'm4v'] });
  assert.deepEqual(watchSettings('pdf', s), { dirs: [], enabled: true, maxFiles: 2, maxMB: 100, minKB: 0, minResolution: 0, maxResolution: 0, skip: [] });
  assert.deepEqual(watchSettings('audio', s), { dirs: [], enabled: false, maxFiles: 2, maxMB: 100, minKB: 0, minResolution: 0, maxResolution: 0, skip: [] });
});
test('a file belongs to the deepest watched folder holding it, which keys the hidden-results list', () => {
  const dirs = ['~/Desktop', '~/Desktop/Shots', '/srv/media'];
  assert.equal(matchingWatchedDir('/home/me/Desktop/Shots/a/b.png', dirs, '/home/me', 'linux'), '~/Desktop/Shots');
  assert.equal(matchingWatchedDir('/home/me/Desktop/b.png', dirs, '/home/me', 'linux'), '~/Desktop');
  assert.equal(matchingWatchedDir('/home/me/Desktop2/b.png', dirs, '/home/me', 'linux'), undefined);
  assert.equal(matchingWatchedDir('/srv/media', dirs, '/home/me', 'linux'), undefined);
  assert.equal(hidesResult('~/Desktop/Shots', { dirsHideFloatingResult: ['/home/me/Desktop/Shots'] }, '/home/me', 'linux'), true);
  assert.equal(hidesResult('~/Desktop', { dirsHideFloatingResult: ['~/Desktop/Shots'] }, '/home/me', 'linux'), false);
});
test('.clopignore rules match like gitignore: wildcards, anchors, folders and re-included files', async t => {
  const rules = '# screenshots stay as they are\n*.gif\n/drafts/\nraw/**/keep-*.png\nbuild/\n!build/ship.png\nexact.png\n';
  for (const [file, ignored] of [
    ['anim.gif', true], ['deep/er/anim.gif', true], ['drafts/a.png', true], ['sub/drafts/a.png', false], ['raw/keep-1.png', true], ['raw/x/y/keep-2.png', true],
    ['raw/other.png', false], ['build/out.png', true], ['build/ship.png', false], ['exact.png', true], ['sub/exact.png', true], ['exact.png.bak', false], ['drafts', false],
  ] as const) assert.equal(ignoredBy(rules, file, 'linux'), ignored, file);
  assert.equal(ignoredBy('*.PNG', 'a.png', 'win32'), true);
  assert.equal(ignoredBy('*.PNG', 'a.png', 'linux'), false);
  const dir = await folder(t);
  await writeFile(path.join(dir, '.clopignore-image'), 'skip-*\n');
  assert.equal(await clopIgnored('image', dir, path.join(dir, 'skip-me.png')), true);
  assert.equal(await clopIgnored('image', dir, path.join(dir, 'take-me.png')), false);
  // Each kind has its own file.
  assert.equal(await clopIgnored('video', dir, path.join(dir, 'skip-me.mp4')), false);
});
test('a watched image qualifies by type, format, size, resolution, ownership and marker', async t => {
  const dir = await folder(t), s = defaultSettings();
  const image = path.join(dir, 'shot.png'); await noise(400, 300).toFile(image);
  assert.equal(await qualifies('image', image, s, host), true);
  assert.equal(await qualifies('video', image, s, host), false);
  assert.equal(await qualifies('image', image, { ...s, imageFormatsToSkip: ['png'] }, host), false);
  assert.equal(await qualifies('image', image, s, { ...host, isOptimised: async () => true }), false);
  assert.equal(await qualifies('image', image, { ...s, minImageSizeKB: 10_000 }, host), false);
  assert.equal(await qualifies('image', image, { ...s, maxImageSizeMB: 0, minImageSizeKB: 0 }, host), true);
  assert.equal(await qualifies('image', image, { ...s, minImageResolution: 301 }, host), false);
  assert.equal(await qualifies('image', image, { ...s, maxImageResolution: 399 }, host), false);
  assert.equal(await qualifies('image', image, { ...s, minImageResolution: 300, maxImageResolution: 400 }, host), true);
  const hidden = path.join(dir, '.hidden.png'), tiny = path.join(dir, 'tiny.png'), owned = path.join(dir, 'work', 'shot.png'), empty = path.join(dir, 'empty.png');
  await noise(400, 300).toFile(hidden); await noise(8, 8).toFile(tiny); await mkdir(path.dirname(owned)); await noise(400, 300).toFile(owned); await writeFile(empty, '');
  for (const file of [hidden, owned, empty, path.join(dir, 'gone.png')]) assert.equal(await qualifies('image', file, { ...s, minImageSizeKB: 0 }, host), false, file);
  assert.equal(await qualifies('image', tiny, { ...s, minImageSizeKB: 0 }, host), false, 'below the minimum resolution');
  const broken = path.join(dir, 'broken.png'); await writeFile(broken, Buffer.alloc(80_000, 1));
  assert.equal(await qualifies('image', broken, s, host), false, 'an image whose size cannot be read');
});
test('a watched video qualifies by its resolution when a limit is set, and anyway when it cannot be read', async t => {
  if (!needTools(t, 'ffmpeg', 'ffprobe')) return;
  const dir = await folder(t), s = { ...defaultSettings(), minVideoSizeKB: 0 };
  const video = await clip(path.join(dir, 'clip.mp4'), { width: 160, height: 120 });
  assert.equal(await qualifies('video', video, s, host), true);
  assert.equal(await qualifies('video', video, { ...s, minVideoResolution: 121 }, host), false);
  assert.equal(await qualifies('video', video, { ...s, maxVideoResolution: 150 }, host), false);
  assert.equal(await qualifies('video', path.join(dir, 'clip.mkv'), s, host), false, 'skipped format, and missing');
  const unreadable = path.join(dir, 'odd.mp4'); await writeFile(unreadable, 'not a video');
  assert.equal(await qualifies('video', unreadable, s, host), true);
});
test('a cloud placeholder is skipped before anything reads it, and the helper\'s attribute reply is checked', async t => {
  const dir = await folder(t), s = defaultSettings(), image = path.join(dir, 'cloud.png');
  await noise(400, 300).toFile(image);
  let checkedMarker = false;
  assert.equal(await qualifies('image', image, s, { ...host, isLocal: async () => false, isOptimised: async () => { checkedMarker = true; return false; } }), false);
  assert.equal(checkedMarker, false);
  assert.equal(await qualifies('image', image, s, { ...host, isLocal: async () => true }), true);
  assert.deepEqual(placeholderReply({ cloud: [true, false] }, 2), [true, false]);
  for (const bad of [null, {}, { cloud: [true] }, { cloud: ['yes', false] }]) assert.throws(() => placeholderReply(bad, 2), /unreadable/);
});
test('a file that cannot be opened for writing is waited for, then left alone', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async t => {
  const dir = await folder(t), file = path.join(dir, 'held.png');
  await writeFile(file, 'png');
  assert.equal(await writable(file), true);
  await chmod(file, 0o444);
  const started = Date.now();
  assert.equal(await writable(file, { tries: 3, delayMs: 50 }), false);
  assert.ok(Date.now() - started >= 100, 'it tried again before giving up');
  assert.equal(await writable(path.join(dir, 'gone.png'), { tries: 3, delayMs: 1000 }), false, 'a missing file is not waited for');
});
test('the rescan after lost changes finds recently changed files, skipping hidden and excluded folders', async t => {
  const dir = await folder(t), old = new Date(Date.now() - 3_600_000);
  for (const sub of ['a/b', '.git', 'work']) await mkdir(path.join(dir, sub), { recursive: true });
  for (const file of ['new.png', 'a/b/deep.png', '.git/hidden.png', 'work/own.png', 'old.png']) await writeFile(path.join(dir, file), 'x');
  await utimes(path.join(dir, 'old.png'), old, old);
  const found = await recentFiles(dir, Date.now() - 60_000, { skip: folder => folder.endsWith(`${path.sep}work`) });
  // A file's creation time can be older than its modification time but never newer, so the old file only counts where creation times are kept.
  assert.deepEqual(found.map(file => path.relative(dir, file).split(path.sep).join('/')).filter(file => file !== 'old.png').sort(), ['a/b/deep.png', 'new.png']);
  assert.equal((await recentFiles(dir, Date.now() - 60_000, { limit: 2 })).length <= 2, true);
});
