import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSettings, settingsSchema, type ClopSettings } from '../settings/schema';
import { formatSettingValue, handleSettingsRequest, matchSettings, mcpRefusal, parseSettingValue, VISIBLE_KEYS, type SettingsAccess } from './settings';

function memoryStore(values: Partial<ClopSettings> = {}): SettingsAccess & { current: ClopSettings } {
  const store = {
    current: { ...defaultSettings(), ...values },
    get: () => store.current,
    async set(partial: unknown) { store.current = { ...store.current, ...(partial as object) }; return store.current; },
  };
  return store;
}

test('every value reads back as a string that writes back unchanged', () => {
  const settings = defaultSettings();
  for (const key of VISIBLE_KEYS) {
    const text = formatSettingValue(key, settings[key]), parsed = parseSettingValue(key, text, settings);
    assert.ok('value' in parsed, `${key}: ${'error' in parsed ? parsed.error : ''}`);
    assert.deepEqual(parsed.value, settings[key], key);
  }
});

test('values are parsed by type, with the words macOS accepts', () => {
  const s = defaultSettings();
  assert.deepEqual(parseSettingValue('stripMetadata', 'off', s), { value: false });
  assert.match((parseSettingValue('stripMetadata', 'maybe', s) as { error: string }).error, /takes true or false/);
  assert.deepEqual(parseSettingValue('imageCompression', 'aggressive', s), { error: "imageCompression takes one of: adaptive, lossless, fast, smaller, custom, optionally followed by :factor. Got 'aggressive'" });
  assert.deepEqual(parseSettingValue('imageCompression', 'lossless', s), { value: { tier: 'lossless', factor: 30 } });
  assert.deepEqual(parseSettingValue('imageCompression', '70', s), { value: { tier: 'custom', factor: 70 } });
  assert.deepEqual(parseSettingValue('videoCompression', 'smaller:80', s), { value: { tier: 'smaller', factor: 80 } });
  assert.match((parseSettingValue('videoCompression', 'smaller:180', s) as { error: string }).error, /0 to 100/);
  assert.deepEqual(parseSettingValue('optimisedImageBehaviour', 'SameFolder', s), { value: 'sameFolder' });
  assert.deepEqual(parseSettingValue('workdirCleanupInterval', '3600', s), { value: 3600 });
  assert.deepEqual(parseSettingValue('formatsToConvertToJPEG', 'webp, heic', s), { value: ['webp', 'heic'] });
  assert.deepEqual(parseSettingValue('keyComboModifiers', 'Control, Hyper', s), { error: 'keyComboModifiers does not know Hyper. It takes any of: Control, Shift, Alt, Super' });
  assert.deepEqual(parseSettingValue('maxPhotosLength', '', s), { value: null });
  assert.match((parseSettingValue('batchModeFileCountThreshold', '-3', s) as { error: string }).error, /whole number from 0/);
  assert.equal(settingsSchema.savedCropSizes.type, 'object');
  assert.match((parseSettingValue('savedCropSizes', '{', s) as { error: string }).error, /takes JSON/);
});

test('the schema narrows to the words asked for, best matches first', () => {
  assert.deepEqual(matchSettings('strip metadata').slice(0, 1), ['stripMetadata']);
  assert.ok(matchSettings('where optimised videos are saved').includes('optimisedVideoBehaviour'));
  assert.equal(matchSettings('').length, VISIBLE_KEYS.length);
  assert.ok(!VISIBLE_KEYS.includes('useClassicMenubarIcon'), 'settings Windows does not use are hidden');
});

test('get, set and schema answer like the macOS bridge', async () => {
  const store = memoryStore();
  const got = await handleSettingsRequest({ action: 'get', key: 'stripMetadata' }, store);
  assert.deepEqual(got.settings?.[0], { key: 'stripMetadata', type: 'bool', value: 'true', allowed: ['true', 'false'], title: 'stripMetadata', subtitle: settingsSchema.stripMetadata.description, keywords: [], pane: '', section: '', entryID: 'stripMetadata' });
  assert.deepEqual(await handleSettingsRequest({ action: 'get', key: 'nope' }, store), { ok: false, error: "no setting named 'nope'. Ask for the schema to see every key." });
  const set = await handleSettingsRequest({ action: 'set', key: 'videoCompression', value: 'smaller:70' }, store);
  assert.equal(set.ok, true);
  assert.deepEqual(store.current.videoCompression, { tier: 'smaller', factor: 70 });
  assert.equal(set.settings?.[0].value, 'smaller:70');
  assert.deepEqual(await handleSettingsRequest({ action: 'set', key: 'stripMetadata' }, store), { ok: false, error: 'set needs a key and a value' });
});

test('agents need the MCP switch to write, cannot flip the switches, and need permission for script steps', async () => {
  const store = memoryStore();
  assert.match((await handleSettingsRequest({ action: 'set', key: 'stripMetadata', value: 'false', origin: 'mcp' }, store)).error!, /not accepting changes from agents/);
  assert.equal((await handleSettingsRequest({ action: 'schema', query: 'strip', origin: 'mcp' }, store)).ok, true, 'reading needs no permission');
  store.current.mcpEnabled = true;
  assert.equal((await handleSettingsRequest({ action: 'set', key: 'stripMetadata', value: 'false', origin: 'mcp' }, store)).ok, true);
  assert.match((await handleSettingsRequest({ action: 'set', key: 'mcpAllowScriptSteps', value: 'true', origin: 'mcp' }, store)).error!, /only be changed by the user/);
  assert.match((await handleSettingsRequest({ action: 'update', values: { mcpEnabled: false }, origin: 'mcp' }, store)).error!, /only be changed by the user/);
  assert.match((await handleSettingsRequest({ action: 'gate', origin: 'mcp', pipeline: 'runScript(code: "rm x")' }, store)).error!, /script steps/);
  assert.equal(mcpRefusal(undefined, 'runScript(code: "x")', store.current), undefined, 'a person using the CLI needs no permission');
  store.current.mcpAllowScriptSteps = true;
  assert.equal((await handleSettingsRequest({ action: 'gate', origin: 'mcp', pipeline: 'runScript(code: "x")' }, store)).ok, true);
});

test('update writes stored values after checking every one', async () => {
  const store = memoryStore();
  assert.deepEqual(await handleSettingsRequest({ action: 'update', values: { stripMetadata: false, pdfDPI: 7 } }, store), { ok: false, error: 'pdfDPI does not accept that value.' });
  assert.equal(store.current.stripMetadata, true, 'nothing is written when one value is wrong');
  assert.deepEqual(await handleSettingsRequest({ action: 'update', values: { stripMetadata: false, pdfDPI: 150 } }, store), { ok: true });
  assert.equal(store.current.pdfDPI, 150);
  const read = await handleSettingsRequest({ action: 'read' }, store);
  assert.equal(read.values?.stripMetadata, false);
});
