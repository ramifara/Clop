import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

test('a missing or corrupt file loads the defaults without writing', async t => {
  const dir = await folder(t);
  const missing = new SettingsStore(path.join(dir, 'settings.json'), paths);
  assert.deepEqual(await missing.load(), defaultSettings(paths));
  assert.deepEqual(await readdir(dir), []);
  await writeFile(path.join(dir, 'settings.json'), '{"enableClipboardOptimiser": fal');
  assert.deepEqual(await new SettingsStore(path.join(dir, 'settings.json'), paths).load(), defaultSettings(paths));
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
