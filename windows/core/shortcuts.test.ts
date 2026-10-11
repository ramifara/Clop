import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, parseSettings } from './settings/schema';
import { diffShortcuts, hintFor, KEY_ACTIONS, nextDownscale, nextResolution, nextSpeed, shortcutProblem, ShortcutRegistry, shortcutsFor, type ShortcutApi } from './shortcuts';

const base = () => defaultSettings();
const keys = (override: Partial<ReturnType<typeof base>> = {}) => shortcutsFor({ ...base(), ...override }).map(shortcut => shortcut.accelerator);

test('the default settings give the macOS key set under Control+Shift, without a rename key', () => {
  assert.deepEqual(keys().sort(), ['Control+Shift+-', 'Control+Shift+=', 'Control+Shift+Backspace', 'Control+Shift+Space', 'Control+Shift+Z', 'Control+Shift+P', 'Control+Shift+C', 'Control+Shift+A', 'Control+Shift+X', 'Control+Shift+K', 'Control+Shift+Escape'].sort());
});

test('modifiers follow the accelerator order whatever order they are saved in, and resize keys add the number keys', () => {
  const found = shortcutsFor({ ...base(), keyComboModifiers: ['Alt', 'Control'], enabledKeys: ['C'], quickResizeKeys: ['5', '9'] });
  assert.deepEqual(found, [
    { accelerator: 'Control+Alt+C', action: { kind: 'optimiseClipboard' } },
    { accelerator: 'Control+Alt+5', action: { kind: 'resize', factor: 0.5 } },
    { accelerator: 'Control+Alt+9', action: { kind: 'resize', factor: 0.9 } },
  ]);
});

test('every plan survives the settings parser with its modifiers', () => {
  for (const modifiers of [['Control', 'Shift'], ['Alt', 'Shift'], ['Super'], ['Control', 'Alt', 'Super']]) {
    const settings = parseSettings({ keyComboModifiers: modifiers, quickResizeKeys: ['1', '9'] });
    assert.deepEqual(settings.keyComboModifiers, modifiers);
    for (const { accelerator } of shortcutsFor(settings)) assert.ok(accelerator.startsWith(`${modifiers.join('+')}+`), accelerator);
  }
});

test('lowercase keys, repeated keys and keys with no Windows action collapse or drop out', () => {
  assert.deepEqual(keys({ enabledKeys: ['c', 'C', 'R', 'Q'] }), ['Control+Shift+C']);
  assert.deepEqual(keys({ enabledKeys: [], quickResizeKeys: ['0', 'a', '3'] }), ['Control+Shift+3']);
});

test('trigger keys that would take ordinary typing register nothing', () => {
  assert.deepEqual(keys({ keyComboModifiers: [] }), []);
  assert.deepEqual(keys({ keyComboModifiers: ['Shift'] }), []);
  assert.deepEqual(keys({ keyComboModifiers: ['Control'] }), [], 'Ctrl+C, Ctrl+Z and the rest belong to every app');
  assert.deepEqual(keys({ keyComboModifiers: ['Alt'] }), []);
  assert.equal(keys({ keyComboModifiers: ['Super'] }).length, 11);
});

test('validation says why a change cannot be saved', () => {
  assert.match(shortcutProblem({ keyComboModifiers: [] })!, /at least one/i);
  assert.match(shortcutProblem({ keyComboModifiers: ['Shift'] })!, /Shift alone/);
  assert.match(shortcutProblem({ keyComboModifiers: ['Control'] })!, /Ctrl alone/);
  assert.match(shortcutProblem({ keyComboModifiers: ['Alt'] })!, /Alt alone/);
  assert.match(shortcutProblem({ quickResizeKeys: ['1', 'F5'] })!, /F5 cannot downscale/);
  assert.equal(shortcutProblem({ keyComboModifiers: ['Control', 'Alt'], quickResizeKeys: ['1'], enabledKeys: ['C'] }), undefined);
  assert.equal(shortcutProblem({}), undefined);
});

test('hints show the accelerator of an enabled key only', () => {
  const shortcuts = shortcutsFor({ ...base(), enabledKeys: ['Z', 'C'] });
  assert.equal(hintFor(shortcuts, 'restore'), 'Control+Shift+Z');
  assert.equal(hintFor(shortcuts, 'aggressive'), undefined);
});

test('the key table covers every action key of the settings window but rename', () => {
  assert.deepEqual(Object.keys(KEY_ACTIONS).sort(), ['-', '=', 'A', 'Backspace', 'C', 'Escape', 'K', 'P', 'Space', 'X', 'Z']);
});

test('the diff keeps what stays, drops what goes and adds what is new', () => {
  assert.deepEqual(diffShortcuts(['a', 'b', 'c'], ['b', 'c', 'd']), { remove: ['a'], add: ['d'] });
  assert.deepEqual(diffShortcuts([], ['a']), { remove: [], add: ['a'] });
  assert.deepEqual(diffShortcuts(['a'], ['a']), { remove: [], add: [] });
});

function fakeApi(taken: string[] = []) {
  const registered = new Map<string, () => void>(), log: string[] = [];
  const api: ShortcutApi = {
    register(accelerator, callback) { log.push(`+${accelerator}`); if (taken.includes(accelerator)) return false; if (accelerator === 'bad') throw new TypeError('Invalid accelerator'); registered.set(accelerator, callback); return true; },
    unregister(accelerator) { log.push(`-${accelerator}`); registered.delete(accelerator); },
  };
  return { api, registered, log };
}
const shortcut = (accelerator: string, kind: 'preview' | 'restore' = 'preview') => ({ accelerator, action: { kind } });

test('a settings change registers and releases only the differences', () => {
  const { api, registered, log } = fakeApi(), pressed: string[] = [];
  const registry = new ShortcutRegistry(api, action => pressed.push(action.kind), () => assert.fail('no conflict expected'));
  registry.sync([shortcut('A+1'), shortcut('A+2', 'restore')]);
  assert.deepEqual([...registered.keys()], ['A+1', 'A+2']);
  log.length = 0;
  registry.sync([shortcut('A+2', 'restore'), shortcut('A+3')]);
  assert.deepEqual(log, ['-A+1', '+A+3']);
  registered.get('A+3')!(); registered.get('A+2')!();
  assert.deepEqual(pressed, ['preview', 'restore']);
  log.length = 0;
  registry.sync([shortcut('A+2', 'restore'), shortcut('A+3')]);
  assert.deepEqual(log, []);
});

test('a key that changes its action keeps its registration and runs the new action', () => {
  const { api, registered, log } = fakeApi(), pressed: string[] = [];
  const registry = new ShortcutRegistry(api, action => pressed.push(action.kind), () => {});
  registry.sync([shortcut('A+1')]); log.length = 0;
  registry.sync([shortcut('A+1', 'restore')]);
  registered.get('A+1')!();
  assert.deepEqual(log, []); assert.deepEqual(pressed, ['restore']);
});

test('a conflict is reported once, nothing is released for it, and it does not stop the others', () => {
  const { api, registered, log } = fakeApi(['A+1']), conflicts: string[] = [];
  const registry = new ShortcutRegistry(api, () => {}, accelerator => conflicts.push(accelerator));
  registry.sync([shortcut('A+1'), shortcut('A+2'), shortcut('bad')]);
  assert.deepEqual(conflicts, ['A+1', 'bad']);
  assert.deepEqual([...registered.keys()], ['A+2']);
  registry.sync([shortcut('A+1'), shortcut('A+2'), shortcut('bad')]);
  assert.deepEqual(conflicts, ['A+1', 'bad']);
  log.length = 0;
  registry.sync([shortcut('A+2')]);
  assert.deepEqual(log, [], 'a shortcut that never registered is not unregistered');
  registry.sync([shortcut('A+1'), shortcut('A+2')]);
  assert.deepEqual(conflicts, ['A+1', 'bad', 'A+1'], 'asking for it again after it was dropped tries again');
});

test('dispose releases what is held', () => {
  const { api, registered } = fakeApi();
  const registry = new ShortcutRegistry(api, () => {}, () => {});
  registry.sync([shortcut('A+1')]); registry.dispose();
  assert.equal(registered.size, 0);
});

test('stepping down follows macOS: a quarter above half, a tenth below, on the factors the card menu offers', () => {
  const steps = [1]; for (let next = nextDownscale(1); next !== undefined; next = nextDownscale(next)) steps.push(next);
  assert.deepEqual(steps, [1, 0.7, 0.4, 0.3, 0.2, 0.1]);
  assert.equal(nextDownscale(0.1), undefined);
});

test('speed and resolution steps run out at the ends of their tables', () => {
  assert.equal(nextSpeed(1), 1.25); assert.equal(nextSpeed(10), undefined);
  assert.equal(nextResolution(), 250); assert.equal(nextResolution(72), 48); assert.equal(nextResolution(48), undefined);
});
