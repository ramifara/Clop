import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../core/settings/schema';
import { shortcutsFor } from '../core/shortcuts';
import { recentClipboard, toTemplate, trayMenu, trayTooltip, trayVariant, type TrayActions, type TrayItem, type TrayState } from './tray-menu';

const settings = defaultSettings();
const state = (override: Partial<TrayState> = {}): TrayState => ({
  settings, shortcuts: shortcutsFor(settings), recent: [], canRevert: true, canBringBack: true, version: '1.2.3', ...override,
});
function recorder() {
  const calls: string[] = [];
  const actions = new Proxy({}, { get: (_target, name: string) => (...args: unknown[]) => { calls.push([name, ...args.map(arg => JSON.stringify(arg))].join(' ')); } }) as TrayActions;
  return { calls, actions };
}
const labels = (items: TrayItem[]) => items.map(item => item.type === 'separator' ? '-' : item.label);
const find = (items: TrayItem[], label: string) => items.find(item => item.label === label)!;

test('the menu has the macOS order of sections, with the Windows items where they belong', () => {
  const { actions } = recorder();
  assert.deepEqual(labels(trayMenu(state({ copier: { id: 'c:\\app.exe', name: 'app', ignored: false }, cli: { installed: false } }), actions)), [
    'Show latest results', 'Recent clipboard items', 'Batch optimiser…', 'Pipelines…', 'Settings…', '-',
    'Optimise clipboard', 'Optimise clipboard (aggressive)', 'Downscale and preview the clipboard', 'Ignore clipboard events from app', '-',
    'Open backups folder', 'Open working directory', 'Force clean working directory', 'Revert last optimisations', 'Bring back last result', 'Stop all', '-',
    'Watch clipboard', 'Keep drop zone visible', 'Pause automatic optimisations', 'Install command-line tool', '-',
    'Show Clop UI in screenshots', 'About', '-', 'Quit Clop',
  ]);
});

test('items with no subject are left out: no copying app, no portable install', () => {
  const found = labels(trayMenu(state(), recorder().actions));
  assert.ok(!found.some(label => label?.startsWith('Ignore clipboard events')));
  assert.ok(!found.some(label => label?.includes('command-line')));
  assert.ok(!found.includes('Sending files'));
});

test('the ignore item is a checkbox that follows the list and sends the app and the new state', () => {
  const { actions, calls } = recorder();
  const off = find(trayMenu(state({ copier: { id: 'C:\\Tools\\Snip.exe', name: 'Snip', ignored: false } }), actions), 'Ignore clipboard events from Snip');
  const on = find(trayMenu(state({ copier: { id: 'C:\\Tools\\Snip.exe', name: 'Snip', ignored: true } }), actions), 'Ignore clipboard events from Snip');
  assert.equal(off.type, 'checkbox'); assert.equal(off.checked, false); assert.equal(on.checked, true);
  off.click!(true); on.click!(false);
  assert.deepEqual(calls, ['ignoreApp "C:\\\\Tools\\\\Snip.exe" true', 'ignoreApp "C:\\\\Tools\\\\Snip.exe" false']);
});

test('the checkboxes show the settings and write the new value', () => {
  const { actions, calls } = recorder();
  const items = trayMenu(state({ settings: { ...settings, pauseAutomaticOptimisations: true, allowClopToAppearInScreenshots: true, keepDropZoneVisible: true, enableClipboardOptimiser: false } }), actions);
  assert.deepEqual(['Watch clipboard', 'Keep drop zone visible', 'Pause automatic optimisations', 'Show Clop UI in screenshots'].map(label => find(items, label).checked), [false, true, true, true]);
  find(items, 'Pause automatic optimisations').click!(false);
  find(items, 'Show Clop UI in screenshots').click!(false);
  assert.deepEqual(calls, ['set {"pauseAutomaticOptimisations":false}', 'set {"allowClopToAppearInScreenshots":false}']);
});

test('revert and bring back are disabled while they have nothing to do', () => {
  const items = trayMenu(state({ canRevert: false, canBringBack: false }), recorder().actions);
  assert.equal(find(items, 'Revert last optimisations').enabled, false);
  assert.equal(find(items, 'Bring back last result').enabled, false);
  assert.equal(find(trayMenu(state(), recorder().actions), 'Revert last optimisations').enabled, true);
});

test('recent clipboard items list the newest results and open the one chosen', () => {
  const { actions, calls } = recorder();
  const recent = [{ id: 'a', label: 'a.png (3 KB)' }, { id: 'b', label: 'b.png (1.5 MB)' }];
  const menu = find(trayMenu(state({ recent }), actions), 'Recent clipboard items');
  assert.equal(menu.enabled, true);
  assert.deepEqual(labels(menu.submenu!), ['a.png (3 KB)', 'b.png (1.5 MB)']);
  menu.submenu![1].click!(false);
  assert.deepEqual(calls, ['showRecent "b"']);
  assert.equal(find(trayMenu(state(), actions), 'Recent clipboard items').enabled, false);
});

test('recent items are the finished clipboard results, newest first, at most eight, with long names cut', () => {
  const item = (id: string, createdAt: number, extra = {}) => ({ id, name: `${id}.png`, source: 'clipboard', status: 'ready', outputBytes: 2048, createdAt, ...extra });
  const items = [item('old', 1), item('drop', 2, { source: 'drop' }), item('busy', 3, { status: 'processing' }), ...Array.from({ length: 9 }, (_, n) => item(`n${n}`, 10 + n)), item('long', 100, { name: `${'x'.repeat(60)}.png`, outputBytes: 5_000_000 })];
  const recent = recentClipboard(items);
  assert.equal(recent.length, 8);
  assert.equal(recent[0].id, 'long');
  assert.match(recent[0].label, /^x{35}… \(4\.8 MB\)$/);
  assert.equal(recent[1].label, 'n8.png (2 KB)');
  assert.ok(!recent.some(entry => ['old', 'drop', 'busy'].includes(entry.id)));
});

test('hints show the shortcuts that are on and drop with them', () => {
  const on = trayMenu(state(), recorder().actions);
  assert.equal(find(on, 'Optimise clipboard').accelerator, 'Control+Shift+C');
  assert.equal(find(on, 'Pause automatic optimisations').accelerator, 'Control+Shift+P');
  const off = trayMenu(state({ shortcuts: shortcutsFor({ ...settings, enabledKeys: ['Z'], keyComboModifiers: ['Alt', 'Control'] }) }), recorder().actions);
  assert.equal(find(off, 'Optimise clipboard').accelerator, undefined);
  assert.equal(find(off, 'Revert last optimisations').accelerator, 'Control+Alt+Z');
});

test('later changes add to About and above the screenshots switch without touching the rest', () => {
  const noop = () => {};
  const items = trayMenu(state(), recorder().actions, { about: [{ label: 'Create debug dump', click: noop }], updates: [{ label: 'Check for updates', click: noop }] });
  assert.deepEqual(labels(find(items, 'About').submenu!), ['Version 1.2.3', 'Create debug dump']);
  const names = labels(items);
  assert.equal(names[names.indexOf('Check for updates') + 1], 'Show Clop UI in screenshots');
});

test('the icon follows the engine: working while it works, paused when paused, else normal', () => {
  assert.equal(trayVariant({ working: false, paused: false }), 'normal');
  assert.equal(trayVariant({ working: false, paused: true }), 'paused');
  assert.equal(trayVariant({ working: true, paused: true }), 'working');
  assert.notEqual(trayTooltip('paused'), trayTooltip('normal'));
});

test('a handler that throws or rejects reaches the report and never escapes', async () => {
  const errors: string[] = [];
  const report = (error: unknown) => errors.push((error as Error).message);
  const template = toTemplate([
    { label: 'sync', click: () => { throw new Error('unreadable settings'); } },
    { label: 'async', click: async () => { throw new Error('rejected'); } },
    { label: 'ok', click: () => undefined },
    { label: 'nested', submenu: [{ label: 'inner', click: () => Promise.reject(new Error('inner failed')) }] },
  ], report);
  const click = (option: (typeof template)[number]) => (option.click as unknown as (item: { checked: boolean }) => void)({ checked: true });
  assert.doesNotThrow(() => { for (const option of template.slice(0, 3)) click(option); click((template[3].submenu as typeof template)[0]); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['unreadable settings', 'rejected', 'inner failed']);
});

test('a checkbox click passes the new state to the handler', () => {
  let seen: boolean | undefined;
  const [option] = toTemplate([{ label: 'box', type: 'checkbox', checked: false, click: checked => { seen = checked; } }], () => assert.fail('no error'));
  (option.click as unknown as (item: { checked: boolean }) => void)({ checked: true });
  assert.equal(seen, true);
});
