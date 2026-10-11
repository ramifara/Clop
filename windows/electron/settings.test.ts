import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, migrateLegacy, parseSettings } from '../core/settings/schema';
import { RENDERER_SETTINGS, imageCompression, imageDefaults, imageMode, parseOptions, rendererSettings } from './settings';
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
test('the renderer may only change the settings its window writes', () => {
  assert.deepEqual(rendererSettings({ floatingResultsCorner: 'topLeft', keepDropZoneVisible: true }), { floatingResultsCorner: 'topLeft', keepDropZoneVisible: true });
  for (const key of RENDERER_SETTINGS) assert.doesNotThrow(() => rendererSettings({ [key]: true }));
  for (const key of ['editorAppImage', 'workdir', 'mcpEnabled', 'mcpAllowScriptSteps', 'pipelinesToRunOnImage', 'imageDirs', '__proto__', 'unknown']) assert.throws(() => rendererSettings(JSON.parse(`{"${key}": 1}`)), /cannot be changed from this window/, key);
  assert.throws(() => rendererSettings({ keepDropZoneVisible: true, workdir: 'C:\\' }), /workdir cannot be changed/);
  for (const bad of [null, 'x', [], 1]) assert.throws(() => rendererSettings(bad));
});
test('the ignored-apps list from the settings window is kept only as a list of strings', () => {
  const current = { ...defaultSettings(), clipboardIgnoredAppBundleIds: ['C:\\Apps\\keep.exe'] };
  assert.deepEqual(parseSettings(rendererSettings({ clipboardIgnoredAppBundleIds: ['a.exe', 'A.exe', 'Contoso.Notes_abc!App'] }), current).clipboardIgnoredAppBundleIds, ['a.exe', 'A.exe', 'Contoso.Notes_abc!App']);
  for (const bad of ['a.exe', [1], [{}], [null]]) assert.deepEqual(parseSettings(rendererSettings({ clipboardIgnoredAppBundleIds: bad }), current).clipboardIgnoredAppBundleIds, ['C:\\Apps\\keep.exe'], JSON.stringify(bad));
});
