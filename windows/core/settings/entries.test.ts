import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlFor, type SettingMeta } from './controls';
import { HIDDEN_KEYS, SETTING_ENTRIES, entryById, entryForRow, hostRow, settingsTarget } from './entries';
import { settingsMeta } from './meta';
import { SETTING_KEYS, settingsSchema } from './schema';
import { searchSettings } from './search';
import { SETTINGS_TABS, TAB_GROUPS, TAB_ORDER } from './tabs';

const metas = new Map<string, SettingMeta>(settingsMeta().map(meta => [meta.key, meta]));
const visible = SETTING_KEYS.filter(key => !settingsSchema[key].unsupportedOnWindows && !(key in HIDDEN_KEYS));

test('row ids are unique and tabs are real', () => {
  const ids = SETTING_ENTRIES.map(entry => entry.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
  for (const entry of SETTING_ENTRIES) assert.ok(entry.tab in SETTINGS_TABS, `${entry.id}: tab ${entry.tab}`);
  assert.deepEqual(TAB_GROUPS.flatMap(group => group.tabs), TAB_ORDER);
});

test('every key a row names exists in the schema and is one the window can show', () => {
  for (const entry of SETTING_ENTRIES) for (const key of entry.keys) {
    assert.ok(Object.hasOwn(settingsSchema, key), `${entry.id} names ${key}, which is not in the schema`);
    assert.ok(!settingsSchema[key].unsupportedOnWindows, `${entry.id} names ${key}, which Windows does not support`);
    assert.ok(!(key in HIDDEN_KEYS), `${entry.id} names ${key}, which is hidden`);
  }
  for (const key of Object.keys(HIDDEN_KEYS)) assert.ok(Object.hasOwn(settingsSchema, key), `${key} is hidden but not in the schema`);
});

test('every visible setting has a row, and a row of its own control unless another row draws it', () => {
  const rowKeys = new Set(SETTING_ENTRIES.flatMap(entry => entry.keys));
  assert.deepEqual(visible.filter(key => !rowKeys.has(key)), []);
  for (const entry of SETTING_ENTRIES) {
    assert.ok(controlFor(entry, metas), `${entry.id} has no control: its setting is a ${metas.get(entry.keys[0])?.type ?? 'missing'} and the row has no ui.control`);
    if (entry.ui?.within) assert.ok(entryById(entry.ui.within), `${entry.id} is drawn within ${entry.ui.within}, which does not exist`);
  }
});

test('a row\'s conditions name real settings and values they can have', () => {
  for (const entry of SETTING_ENTRIES) for (const [key, value] of entry.ui?.when ?? []) {
    const meta = metas.get(key)!;
    assert.ok(meta, `${entry.id}: ${key}`);
    if (typeof value === 'boolean') assert.equal(meta.type, 'boolean', `${entry.id}: ${key}`);
    else assert.ok(meta.values!.includes(value), `${entry.id}: ${key} is never ${value}`);
  }
});

test('row controls fit their settings', () => {
  for (const entry of SETTING_ENTRIES) {
    const control = controlFor(entry, metas)!, types = entry.keys.map(key => metas.get(key)!.type);
    if (control === 'toggle' || control === 'mcpToggle') assert.deepEqual([...new Set(types)], ['boolean'], entry.id);
    if (control === 'number') assert.ok(types.every(type => type === 'integer' || type === 'number'), entry.id);
    if (control === 'formats') assert.deepEqual([...new Set(types)], ['list'], entry.id);
    if (control === 'select') {
      assert.equal(types.length, 1, entry.id);
      const meta = metas.get(entry.keys[0])!, labels = (entry.ui?.labels ?? []).map(([value]) => value);
      // An enum offers its values; a number offers the presets the row labels.
      if (meta.type === 'enum') for (const label of labels) assert.ok(meta.values!.map(String).includes(label), `${entry.id}: label for ${label}, which is not a value`);
      else { assert.ok(['integer', 'number'].includes(meta.type) && labels.length, entry.id); assert.ok(labels.every(label => meta.type === 'integer' ? Number.isInteger(Number(label)) : Number.isFinite(Number(label))), entry.id); }
    }
    if (['nameTemplate', 'pathTemplate'].includes(control)) assert.deepEqual(types, ['string'], entry.id);
  }
});

test('format lists are drawn as format pickers', () => {
  const lists = SETTING_KEYS.filter(key => /^(formatsTo|.*FormatsToSkip)/.test(key));
  assert.equal(lists.length, 9);
  for (const key of lists) assert.equal(controlFor(SETTING_ENTRIES.find(entry => entry.keys.includes(key))!, metas), 'formats', key);
});

test('a choice offers every value its setting has, the numbers it labels are ones it accepts, and Never comes last', () => {
  for (const entry of SETTING_ENTRIES.filter(row => controlFor(row, metas) === 'select' && row.ui?.labels)) {
    const meta = metas.get(entry.keys[0])!, offered = entry.ui!.labels!.map(([value]) => value);
    if (meta.type === 'enum') assert.deepEqual([...offered].sort(), meta.values!.map(String).sort(), entry.id);
    else for (const value of offered) assert.equal((settingsSchema[meta.key] as { parse(value: unknown): unknown }).parse(Number(value)), Number(value), `${entry.id}: ${value}`);
  }
  for (const key of ['defaultLinkExpiration', 'workdirCleanupInterval']) {
    const labels = SETTING_ENTRIES.find(row => row.keys[0] === key)!.ui!.labels!;
    assert.deepEqual(labels.at(-1), ['0', labels.at(-1)![1]], key);
    assert.match(labels.at(-1)![1], /^Never/);
  }
});

test('rows are found by link, by id or by the setting they write', () => {
  assert.equal(entryForRow('general.optimisation.stripMetadata')?.keys[0], 'stripMetadata');
  assert.equal(entryForRow('STRIPMETADATA')?.id, 'general.optimisation.stripMetadata');
  assert.equal(entryForRow('nothing'), undefined);
  assert.equal(hostRow(entryById('images.watchpaths.dirsHideFloatingResult')!).id, 'images.watchpaths.imageDirs');
});

test('searching a row by its title and tab finds it, so every visible setting is reachable', () => {
  for (const entry of SETTING_ENTRIES) {
    const found = searchSettings(`${entry.title} ${SETTINGS_TABS[entry.tab]}`).map(result => result.id);
    assert.ok(found.includes(entry.id), `${entry.id} is not found by "${entry.title} ${SETTINGS_TABS[entry.tab]}": ${found.slice(0, 5).join(', ')}`);
  }
});

test('Windows rows do not talk about the Mac', () => {
  const mac = /\b(finder|macs?|icloud|menubar|menu bar|quicklook|photos\.app|dropshare|⌘|⌥|option key|cmd)\b/i;
  const offenders = SETTING_ENTRIES.filter(entry => mac.test([entry.title, entry.subtitle].join(' ')) || entry.keywords.some(word => /^(finder|icloud|menubar|quicklook|dropshare)$/i.test(word)));
  assert.deepEqual(offenders.map(entry => `${entry.id}: ${entry.title}`), []);
});

test('a link opens the tab of its row, whatever tab it names', () => {
  assert.deepEqual(settingsTarget('video', 'general.optimisation.stripMetadata'), { tab: 'general', row: 'general.optimisation.stripMetadata' });
  assert.deepEqual(settingsTarget(undefined, 'enabledKeys'), { tab: 'keys', row: 'keys.actionkeys.enabledKeys' });
  assert.deepEqual(settingsTarget('images'), { tab: 'images' });
  assert.deepEqual(settingsTarget('images', 'no such row'), { tab: 'images' });
  assert.deepEqual(settingsTarget(), { tab: 'general' });
});

test('name templates apply under Same folder and path templates under Specific folder, for the placements of their own kind', () => {
  const templates = SETTING_ENTRIES.filter(entry => ['nameTemplate', 'pathTemplate'].includes(entry.ui?.control ?? '') && entry.ui?.when && /FolderNameTemplate/.test(entry.keys[0]));
  assert.equal(templates.length, 14);
  for (const entry of templates) {
    const wanted = entry.ui!.control === 'pathTemplate' ? 'specificFolder' : 'sameFolder', kind = entry.keys[0].replace(/^(converted)?[Ss](ame|pecific)FolderNameTemplate/, '');
    const converted = entry.keys[0].startsWith('converted');
    const expected = converted ? [`converted${kind}Behaviour`, `manualConverted${kind}Behaviour`].filter(key => metas.has(key)) : [`optimised${kind}Behaviour`];
    assert.deepEqual(entry.ui!.when, expected.map(key => [key, wanted]), entry.id);
  }
});

/**
 * Settings the window edits that nothing in Clop for Windows reads yet. The rows say so. This list is pinned on purpose: when a
 * change wires a setting, remove it here and from the row's `ui.pending`; a new row that does nothing must be added here knowingly.
 */
const PENDING_KEYS = [
  'allowClopToAppearInScreenshots', 'autoHideClipboardResultAfter', 'autoHideFloatingResults', 'autoHideFloatingResultsAfter',
  'convertHDRToSDR', 'defaultLinkExpiration', 'dismissCompactResultOnUpload', 'dismissFloatingResultOnUpload',
  'enableFloatingResults', 'enabledKeys', 'followCursorScreen', 'formatsToConvertToJPEG', 'formatsToConvertToMP4',
  'formatsToConvertToOutputAudio', 'formatsToConvertToPNG', 'keyComboModifiers', 'onlyShowDropZoneOnOption', 'onlyShowPresetZonesOnControlTapped', 'optimiseHEICAVIFClipboard',
  'optimiseTIFF', 'quickResizeKeys', 'showMenubarIcon',
];

test('the rows that do nothing yet are exactly the pinned list, each with a reason', () => {
  const pending = SETTING_ENTRIES.filter(entry => entry.ui?.pending);
  for (const entry of pending) assert.match(entry.ui!.pending!, /\w{4}/, entry.id);
  assert.deepEqual([...new Set(pending.flatMap(entry => entry.keys))].sort(), [...PENDING_KEYS].sort());
});
