import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, migrateLegacy } from '../core/settings/schema';
import { imageDefaults, imageMode, parseOptions } from './settings';
test('new images use the compression and format settings', () => {
  assert.deepEqual(imageDefaults(defaultSettings()), { mode: 'balanced', format: 'auto', scale: 1 });
  for (const mode of ['balanced', 'aggressive', 'lossless'] as const) assert.equal(imageDefaults(migrateLegacy({ defaultMode: mode, defaultFormat: 'webp' })).mode, mode);
  assert.equal(imageDefaults(migrateLegacy({ defaultFormat: 'webp' })).format, 'webp');
  assert.equal(imageMode({ tier: 'adaptive', factor: 80 }), 'balanced');
  assert.equal(imageMode({ tier: 'custom', factor: 50 }), 'aggressive');
});
test('rejects invalid dimensions, formats and non-finite scales', () => {
  for (const bad of [0, -1, NaN, Infinity, 1.01]) assert.throws(() => parseOptions({ mode: 'balanced', format: 'auto', scale: bad }));
  assert.throws(() => parseOptions({ mode: 'balanced', format: 'mp4', scale: 1 }));
  assert.throws(() => parseOptions({ mode: 'balanced', format: 'png', scale: 1, maxEdge: 1.5 }));
  assert.throws(() => parseOptions({ mode: 'balanced', format: 'png', scale: 1, maxEdge: 20000 }));
});
