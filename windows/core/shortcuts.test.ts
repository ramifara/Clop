import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, parseSettings } from './settings/schema';
import { conflictNotice, diffShortcuts, hintFor, KEY_ACTIONS, nextDownscale, nextResolution, nextSpeed, reservedBy, shortcutProblem, ShortcutRegistry, shortcutsFor, type ShortcutApi } from './shortcuts';

const base = () => defaultSettings();
const keys = (override: Partial<ReturnType<typeof base>> = {}) => shortcutsFor({ ...base(), ...override }).map(shortcut => shortcut.accelerator);

test('the Windows default is Control+Shift with only the keys that rarely collide', () => {
  assert.deepEqual(keys().sort(), ['Control+Shift+-', 'Control+Shift+=', 'Control+Shift+Space', 'Control+Shift+C', 'Control+Shift+A'].sort());
  assert.deepEqual(base().keyComboModifiers, ['Control', 'Shift']);
});

test('every key the macOS list has is still accepted, for a user who turns it on', () => {
  const all = ['-', '=', 'Backspace', 'Space', 'Z', 'P', 'C', 'A', 'X', 'K', 'Escape'];
  assert.equal(keys({ enabledKeys: all }).length, all.length - 1, 'all but Control+Shift+Escape, which is Task Manager');
  assert.equal(shortcutProblem({ enabledKeys: all.filter(key => key !== 'Escape') }, base()), undefined);
});

test('modifiers follow the accelerator order whatever order they are saved in, and resize keys add the number keys', () => {
  const found = shortcutsFor({ ...base(), keyComboModifiers: ['Alt', 'Shift'], enabledKeys: ['C'], quickResizeKeys: ['5', '9'] });
  assert.deepEqual(found, [
    { accelerator: 'Shift+Alt+C', action: { kind: 'optimiseClipboard' } },
    { accelerator: 'Shift+Alt+5', action: { kind: 'resize', factor: 0.5 } },
    { accelerator: 'Shift+Alt+9', action: { kind: 'resize', factor: 0.9 } },
  ]);
});

test('every plan survives the settings parser with its modifiers', () => {
  for (const modifiers of [['Control', 'Shift'], ['Alt', 'Shift'], ['Super', 'Shift'], ['Control', 'Alt', 'Super']]) {
    const settings = parseSettings({ keyComboModifiers: modifiers, quickResizeKeys: ['1', '9'] });
    assert.deepEqual(settings.keyComboModifiers, modifiers);
    for (const { accelerator } of shortcutsFor(settings)) assert.deepEqual(accelerator.split('+').slice(0, -1).sort(), [...modifiers].sort(), accelerator);
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
  assert.deepEqual(keys({ keyComboModifiers: ['Super'] }), [], 'Win+C, Win+A, Win+Space and Win+- belong to the shell');
  assert.deepEqual(keys({ keyComboModifiers: ['Control', 'Alt'] }), [], 'Ctrl+Alt is AltGr on many keyboards');
  assert.equal(keys({ keyComboModifiers: ['Control', 'Alt', 'Shift'] }).length, 5);
});

test('validation says why a change cannot be saved', () => {
  assert.match(shortcutProblem({ keyComboModifiers: [] })!, /at least one/i);
  assert.match(shortcutProblem({ keyComboModifiers: ['Shift'] })!, /Shift alone/);
  assert.match(shortcutProblem({ keyComboModifiers: ['Control'] })!, /Ctrl alone/);
  assert.match(shortcutProblem({ keyComboModifiers: ['Alt'] })!, /Alt alone/);
  assert.match(shortcutProblem({ keyComboModifiers: ['Super'] })!, /Windows key alone/);
  assert.match(shortcutProblem({ keyComboModifiers: ['Alt', 'Control'] })!, /AltGr/);
  assert.match(shortcutProblem({ quickResizeKeys: ['1', 'F5'] })!, /F5 cannot downscale/);
  assert.equal(shortcutProblem({ keyComboModifiers: ['Control', 'Alt', 'Shift'], quickResizeKeys: ['1'], enabledKeys: ['C'] }), undefined);
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
  const registry = new ShortcutRegistry(api, action => pressed.push(action.kind));
  assert.deepEqual(registry.sync([shortcut('A+1'), shortcut('A+2', 'restore')]), { registered: ['A+1', 'A+2'], failed: [] });
  assert.deepEqual([...registered.keys()], ['A+1', 'A+2']);
  log.length = 0;
  assert.deepEqual(registry.sync([shortcut('A+2', 'restore'), shortcut('A+3')]), { registered: ['A+3'], failed: [] });
  assert.deepEqual(log, ['-A+1', '+A+3']);
  registered.get('A+3')!(); registered.get('A+2')!();
  assert.deepEqual(pressed, ['preview', 'restore']);
  log.length = 0;
  registry.sync([shortcut('A+2', 'restore'), shortcut('A+3')]);
  assert.deepEqual(log, []);
});

test('a key that changes its action keeps its registration and runs the new action', () => {
  const { api, registered, log } = fakeApi(), pressed: string[] = [];
  const registry = new ShortcutRegistry(api, action => pressed.push(action.kind));
  registry.sync([shortcut('A+1')]); log.length = 0;
  registry.sync([shortcut('A+1', 'restore')]);
  registered.get('A+1')!();
  assert.deepEqual(log, []); assert.deepEqual(pressed, ['restore']);
});

test('conflicts come back together, once; nothing is released for them; the others still register', () => {
  const { api, registered, log } = fakeApi(['A+1']);
  const registry = new ShortcutRegistry(api, () => {});
  assert.deepEqual(registry.sync([shortcut('A+1'), shortcut('A+2'), shortcut('bad')]), { registered: ['A+2'], failed: ['A+1', 'bad'] });
  assert.deepEqual([...registered.keys()], ['A+2']);
  assert.deepEqual(registry.sync([shortcut('A+1'), shortcut('A+2'), shortcut('bad')]), { registered: [], failed: [] }, 'not asked again');
  log.length = 0;
  registry.sync([shortcut('A+2')]);
  assert.deepEqual(log, [], 'a shortcut that never registered is not unregistered');
  assert.deepEqual(registry.sync([shortcut('A+1'), shortcut('A+2')]).failed, ['A+1'], 'asking for it again after it was dropped tries again');
});

test('dispose releases what is held', () => {
  const { api, registered } = fakeApi();
  const registry = new ShortcutRegistry(api, () => {});
  registry.sync([shortcut('A+1')]); registry.dispose();
  assert.equal(registered.size, 0);
});

test('a conflict is announced the first time and not at every launch, and is news again after it has cleared', () => {
  const wanted = [shortcut('A+1'), shortcut('A+2')];
  const first = conflictNotice([], { registered: ['A+2'], failed: ['A+1'] }, wanted);
  assert.deepEqual(first, { announce: ['A+1'], seen: ['A+1'] });
  const launch = conflictNotice(first.seen, { registered: ['A+2'], failed: ['A+1'] }, wanted);
  assert.deepEqual(launch, { announce: [], seen: ['A+1'] });
  const cleared = conflictNotice(launch.seen, { registered: ['A+1', 'A+2'], failed: [] }, wanted);
  assert.deepEqual(cleared, { announce: [], seen: [] });
  assert.deepEqual(conflictNotice(cleared.seen, { registered: [], failed: ['A+1'] }, wanted).announce, ['A+1']);
  assert.deepEqual(conflictNotice(['A+9'], { registered: [], failed: [] }, wanted).seen, [], 'a key that is no longer wanted is forgotten');
});

test('what Windows keeps for itself is never registered, whatever order the modifiers come in', () => {
  assert.match(reservedBy('Control+Shift+Escape')!, /Task Manager/);
  assert.ok(reservedBy('Shift+Control+Esc'), 'order and spelling do not matter');
  assert.ok(reservedBy('Control+Alt+Delete')); assert.ok(reservedBy('Control+Escape')); assert.ok(reservedBy('Super+L')); assert.ok(reservedBy('Alt+Tab')); assert.ok(reservedBy('Alt+F4')); assert.ok(reservedBy('Shift+Super+S'));
  assert.equal(reservedBy('Control+Shift+C'), undefined);
  assert.deepEqual(keys({ enabledKeys: ['Escape', 'C'] }), ['Control+Shift+C']);
  assert.deepEqual(keys({ keyComboModifiers: ['Alt'], enabledKeys: ['Tab'] }), []);
  assert.deepEqual(keys({ keyComboModifiers: ['Super', 'Control'], enabledKeys: ['C'] }), ['Control+Super+C']);
});

test('a change that would turn on a reserved accelerator is refused whichever setting it touches', () => {
  const current = { ...base(), enabledKeys: ['C'] };
  assert.match(shortcutProblem({ enabledKeys: ['C', 'Escape'] }, current)!, /Ctrl\+Shift\+Escape opens Task Manager/);
  assert.match(shortcutProblem({ keyComboModifiers: ['Control', 'Shift'] }, { ...current, enabledKeys: ['Escape'], keyComboModifiers: ['Alt', 'Shift'] })!, /Task Manager/);
  assert.equal(shortcutProblem({ enabledKeys: ['C', 'Z'] }, current), undefined);
  assert.equal(shortcutProblem({ enabledKeys: ['Escape'] }), undefined, 'without the settings it lands on there is nothing to combine with');
  assert.equal(shortcutProblem({ stripMetadata: true } as never, { ...current, enabledKeys: ['Escape'] }), undefined, 'an unrelated change is not held up by a stored key');
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
