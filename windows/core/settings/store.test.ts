import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, type ClopSettings, type SettingKey } from './schema';
import { SettingsStore } from './store';

const paths = { home: '/home/user', desktop: '/home/user/Desktop', userData: '/home/user/.config/Clop for Windows' };
async function folder(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));

test('a missing file loads the defaults without writing', async t => {
  const dir = await folder(t);
  assert.deepEqual(await new SettingsStore(path.join(dir, 'settings.json'), paths).load(), defaultSettings(paths));
  assert.deepEqual(await readdir(dir), []);
});

test('a corrupt file is moved aside before the defaults are used and saved', async t => {
  for (const content of ['{"enableClipboardOptimiser": fal', '[1, 2]', 'null']) {
    const dir = await folder(t), file = path.join(dir, 'settings.json');
    await writeFile(file, content);
    const store = new SettingsStore(file, paths);
    assert.deepEqual(await store.load(), defaultSettings(paths));
    const [aside, ...rest] = await readdir(dir);
    assert.match(aside, /^settings\.json\.corrupt-/);
    assert.deepEqual(rest, []);
    assert.equal(await readFile(path.join(dir, aside), 'utf8'), content);
    await store.set({ keepDropZoneVisible: true });
    assert.equal((await readJson(file)).keepDropZoneVisible, true);
  }
});

test('an unreadable file is never overwritten', async t => {
  const dir = await folder(t), file = path.join(dir, 'settings.json');
  // A folder in the file's place fails to read on every platform, like a file without read permission.
  await mkdir(file);
  const store = new SettingsStore(file, paths);
  await assert.rejects(store.load(), /could not read its settings file .*EISDIR/);
  assert.deepEqual(store.get(), defaultSettings(paths));
  await assert.rejects(store.set({ keepDropZoneVisible: true }), /will not save changes/);
  await assert.rejects(store.save(), /will not save changes/);
  assert.equal(store.get('keepDropZoneVisible'), false);
  assert.deepEqual(await readdir(dir), ['settings.json']);
  assert.ok((await stat(file)).isDirectory());
});

test('a legacy file is migrated and written back in the new shape', async t => {
  const file = path.join(await folder(t), 'settings.json');
  await writeFile(file, JSON.stringify({ clipboard: false, autoCopy: true, explorerDrag: true, pinned: true, alwaysOnTop: true, launchAtLogin: false, corner: 'bottom-left', defaultMode: 'balanced', defaultFormat: 'png' }, null, 2));
  const store = new SettingsStore(file, paths);
  const loaded = await store.load();
  assert.equal(loaded.enableClipboardOptimiser, false);
  assert.equal(loaded.keepDropZoneVisible, true);
  assert.equal(loaded.floatingResultsCorner, 'bottomLeft');
  assert.equal(loaded.defaultImageFormat, 'png');
  assert.deepEqual(await readJson(file), loaded);
  assert.deepEqual(await new SettingsStore(file, paths).load(), loaded);
});

test('set validates, saves and reports the changed keys', async t => {
  const file = path.join(await folder(t), 'nested', 'settings.json');
  const store = new SettingsStore(file, paths);
  await store.load();
  const events: [ClopSettings, SettingKey[]][] = [];
  store.on('change', (settings, changed) => events.push([settings, changed]));
  const next = await store.set({ floatingResultsCorner: 'topRight', enableDragAndDrop: true, pdfDPI: 'high', unknown: 1 });
  assert.equal(next.floatingResultsCorner, 'topRight');
  assert.equal(store.get('floatingResultsCorner'), 'topRight');
  assert.deepEqual(events.map(([, changed]) => changed), [['floatingResultsCorner']]);
  assert.equal(events[0][0], store.get());
  assert.deepEqual(await readJson(file), next);
  assert.equal(await store.set({ enableDragAndDrop: true }), next, 'an unchanged value neither writes nor emits');
  assert.equal(events.length, 1);
  assert.deepEqual(await new SettingsStore(file, paths).load(), next);
});

test('concurrent sets are written in order and leave no temporary files', async t => {
  const dir = await folder(t), file = path.join(dir, 'settings.json');
  const store = new SettingsStore(file, paths);
  await store.load();
  await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(n => store.set({ batchModeFileCountThreshold: n, maxImageFileCount: n })));
  assert.equal((await readJson(file)).batchModeFileCountThreshold, 8);
  assert.deepEqual(await readdir(dir), ['settings.json']);
});

test('a failed write keeps the previous settings and a retry writes again', async t => {
  const dir = await folder(t), file = path.join(dir, 'settings.json');
  const store = new SettingsStore(file, paths);
  await store.load();
  const events: SettingKey[][] = [];
  store.on('change', (_settings, changed) => events.push(changed));
  // A non-empty folder where the file goes makes the final rename fail on every platform.
  await mkdir(path.join(file, 'blocker'), { recursive: true });
  const before = store.get();
  const [first, second] = await Promise.allSettled([store.set({ keepDropZoneVisible: true }), store.set({ launchAtLogin: true })]);
  assert.equal(first.status, 'rejected');
  assert.equal(second.status, 'rejected');
  assert.equal(store.get(), before);
  assert.deepEqual(events, []);
  await assert.rejects(store.set({ keepDropZoneVisible: true }), 'the retry must try to write again');
  assert.equal(store.get('keepDropZoneVisible'), false);
  await rm(file, { recursive: true });
  const saved = await store.set({ keepDropZoneVisible: true });
  assert.equal(saved.keepDropZoneVisible, true);
  assert.equal(saved.launchAtLogin, false, 'a failed set leaves nothing behind for later sets to write');
  assert.deepEqual(await readJson(file), saved);
  assert.deepEqual(events, [['keepDropZoneVisible']]);
  assert.deepEqual((await readdir(dir)).sort(), ['settings.json']);
});
