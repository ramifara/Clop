import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HIDDEN_KEYS } from '../core/settings/entries';
import { SETTING_KEYS, defaultSettings, migrateLegacy, settingsSchema, type ClopSettings, type SettingSpec } from '../core/settings/schema';
import { MCP_WRITABLE } from '../core/ipc/settings';
import { ACTION_ONLY_SETTINGS, RENDERER_SETTINGS, imageCompression, imageDefaults, imageMode, parseOptions, rendererSettings } from './settings';
test('new images use the compression and format settings', () => {
  assert.deepEqual(imageDefaults(defaultSettings()), { mode: 'balanced', format: 'auto', scale: 1 });
  for (const mode of ['balanced', 'aggressive', 'lossless'] as const) assert.equal(imageDefaults(migrateLegacy({ defaultMode: mode, defaultFormat: 'webp' })).mode, mode);
  assert.equal(imageDefaults(migrateLegacy({ defaultFormat: 'webp' })).format, 'webp');
  assert.equal(imageMode({ tier: 'adaptive', factor: 80 }), 'balanced');
  assert.equal(imageMode({ tier: 'custom', factor: 50 }), 'aggressive');
});
test('card modes map onto the compression setting the way the macOS aggressive button does', () => {
  const normal = { tier: 'custom', factor: 30 } as const, adaptive = { tier: 'adaptive', factor: 30 } as const, strong = { tier: 'custom', factor: 80 } as const;
  assert.deepEqual(imageCompression('balanced', normal), { compression: normal });
  assert.deepEqual(imageCompression('balanced', adaptive), { compression: adaptive });
  assert.deepEqual(imageCompression('aggressive', normal), { compression: normal, aggressive: true });
  assert.deepEqual(imageCompression('aggressive', strong), { compression: strong });
  assert.deepEqual(imageCompression('balanced', strong), { compression: strong, aggressive: false });
  assert.deepEqual(imageCompression('lossless', normal), { compression: { tier: 'lossless', factor: 30 } });
  assert.deepEqual(imageCompression('balanced', { tier: 'lossless', factor: 30 }), { compression: { tier: 'lossless', factor: 30 }, aggressive: false });
});
test('rejects invalid dimensions, formats and non-finite scales', () => {
  for (const bad of [0, -1, NaN, Infinity, 1.01]) assert.throws(() => parseOptions({ mode: 'balanced', format: 'auto', scale: bad }));
  assert.throws(() => parseOptions({ mode: 'balanced', format: 'mp4', scale: 1 }));
  assert.throws(() => parseOptions({ mode: 'balanced', format: 'png', scale: 1, maxEdge: 1.5 }));
  assert.throws(() => parseOptions({ mode: 'balanced', format: 'png', scale: 1, maxEdge: 20000 }));
});
test('the renderer may change the settings its window has rows for, and not those that change only through an action', () => {
  assert.deepEqual(rendererSettings({ floatingResultsCorner: 'topLeft', keepDropZoneVisible: true }), { floatingResultsCorner: 'topLeft', keepDropZoneVisible: true });
  const schema = settingsSchema as Record<string, SettingSpec>;
  for (const key of RENDERER_SETTINGS) assert.doesNotThrow(() => rendererSettings({ [key]: schema[key].default instanceof Function ? defaultSettings()[key] : schema[key].default }), key);
  for (const key of Object.keys(ACTION_ONLY_SETTINGS)) {
    assert.ok(!(RENDERER_SETTINGS as readonly string[]).includes(key), key);
    assert.throws(() => rendererSettings({ [key]: defaultSettings()[key as keyof ClopSettings] }), /cannot be changed from this window/, key);
  }
  for (const key of ['__proto__', 'unknown', 'finishedOnboarding', 'savedCropSizes', 'cliInstalled', 'lastAutoIncrementingNumber', 'syncSettingsCloud', 'enablePhotosIntegration', 'useAggressiveOptimisationMP4']) assert.throws(() => rendererSettings(JSON.parse(`{"${key}": 1}`)), /cannot be changed from this window/, key);
  assert.throws(() => rendererSettings({ keepDropZoneVisible: true, workdir: 'C:\\' }), /workdir cannot be changed/);
  for (const bad of [null, 'x', [], 1]) assert.throws(() => rendererSettings(bad));
});
test('the allowlist covers what the window edits: every row\'s settings, minus the action-only ones', () => {
  for (const key of ['stripMetadata', 'videoEncoder', 'keyComboModifiers', 'enabledKeys', 'quickResizeKeys', 'floatingResultActions', 'imageCompression', 'persistDebugLogs', 'launchAtLogin', 'sameFolderNameTemplateImage', 'minVideoSizeKB', 'maxVideoSizeMB']) assert.ok((RENDERER_SETTINGS as readonly string[]).includes(key), key);
  const covered = new Set<string>([...RENDERER_SETTINGS, ...Object.keys(ACTION_ONLY_SETTINGS), ...Object.keys(HIDDEN_KEYS)]);
  for (const key of SETTING_KEYS) assert.ok(covered.has(key) || settingsSchema[key].unsupportedOnWindows, `${key} is neither editable, action-only, hidden nor unsupported`);
});
test('a value the setting cannot hold is refused instead of silently ignored', () => {
  assert.throws(() => rendererSettings({ floatingResultsCorner: 'middle' }), /floatingResultsCorner is not a valid value/);
  assert.throws(() => rendererSettings({ batchModeFileCountThreshold: -1, stripMetadata: 'yes' }), /batchModeFileCountThreshold, stripMetadata are not valid values/);
  assert.throws(() => rendererSettings({ enabledKeys: ['Not a key'] }), /enabledKeys/);
  assert.throws(() => rendererSettings({ videoEncoder: 'rm -rf' }), /videoEncoder/);
  assert.deepEqual(rendererSettings({ keyComboModifiers: ['Control', 'Alt'], enabledKeys: ['C', 'Space'] }), { keyComboModifiers: ['Control', 'Alt'], enabledKeys: ['C', 'Space'] });
});
test('the window can write only what agents may write, plus these Windows-side keys, so a new row cannot widen the IPC surface unnoticed', () => {
  const beyondAgents = RENDERER_SETTINGS.filter(key => !MCP_WRITABLE.has(key)).sort();
  // None of these chooses a program, script or folder. Add a key here only after deciding that of it.
  assert.deepEqual(beyondAgents, ['adaptiveVideoSize', 'audioFormat', 'audioFormatsToSkip', 'defaultLinkExpiration', 'enabledKeys', 'formatsToConvertToOutputAudio', 'keyComboModifiers', 'quickResizeKeys', 'videoEncoder', 'workdirCleanupInterval']);
});
test('card options accept an extra compression and the HEIC and JPEG XL formats, and nothing else', () => {
  assert.deepEqual(parseOptions({ mode: 'balanced', format: 'heic', scale: 1, compression: { tier: 'custom', factor: 40, extra: 1 } }), { mode: 'balanced', format: 'heic', scale: 1, compression: { tier: 'custom', factor: 40 } });
  assert.equal(parseOptions({ mode: 'balanced', format: 'jxl', scale: 1 }).format, 'jxl');
  for (const bad of [null, 'adaptive', { tier: 'lossless', factor: 40 }, { tier: 'custom', factor: 4 }, { tier: 'custom', factor: 101 }, { tier: 'custom', factor: 40.5 }, { tier: 'custom' }]) assert.throws(() => parseOptions({ mode: 'balanced', format: 'auto', scale: 1, compression: bad }), /compression factor/, JSON.stringify(bad));
});
