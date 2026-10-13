import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsTab } from './tabs';

test('a tab is found by case name or title in any case, and by the old macOS name', () => {
  assert.equal(settingsTab('presetZones'), 'presetZones');
  assert.equal(settingsTab('Preset zones'), 'presetZones');
  assert.equal(settingsTab('keyboard-shortcuts'), 'keys');
  assert.equal(settingsTab('License & updates'), 'updates');
  assert.equal(settingsTab('licenseUpdates'), 'updates');
  assert.equal(settingsTab('nope'), undefined);
});
