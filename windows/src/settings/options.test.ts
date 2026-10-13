import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../../core/media/detect';
import { KEY_MODIFIERS as SCHEMA_MODIFIERS, settingsSchema, type SettingKey, type SettingSpec } from '../../core/settings/schema';
import { KEY_MODIFIERS, triggerProblem, formatAccelerator, describeAccelerator, heldModifiers, isModifierKey, keyName, recorded, type KeyEventLike } from './accelerator';
import { ACTION_KEYS, ACTION_LABELS, FORMAT_OPTIONS, OFFERED_ACTIONS, RESIZE_KEYS, TEMPLATE_VARIABLES } from './options';

const schema = settingsSchema as Record<SettingKey, SettingSpec>;
const event = (code: string, over: Partial<KeyEventLike> = {}): KeyEventLike => ({ code, key: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...over });

test('every format offered is an extension the setting accepts and Clop reads', () => {
  const known = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);
  for (const [key, options] of Object.entries(FORMAT_OPTIONS)) {
    assert.ok(options!.length > 0, key);
    assert.deepEqual(schema[key as SettingKey].parse(options), options, key);
    for (const option of options!) assert.ok(known.has(option), `${key}: ${option}`);
  }
  for (const key of Object.keys(schema).filter(name => schema[name as SettingKey].type === 'list' && /^(formatsTo|.*FormatsToSkip)/.test(name))) assert.ok(key in FORMAT_OPTIONS, `${key} has no options`);
});

test('the default of a format setting is among its options', () => {
  for (const [key, options] of Object.entries(FORMAT_OPTIONS)) {
    const value = schema[key as SettingKey].default as string[];
    for (const item of value) assert.ok(options!.includes(item), `${key} defaults to ${item}`);
  }
});

test('action names, action keys and resize keys are values the settings accept', () => {
  for (const name of Object.keys(ACTION_LABELS)) assert.deepEqual(schema.floatingResultActions.parse([name]), [name], name);
  assert.ok(OFFERED_ACTIONS.every(name => name in ACTION_LABELS) && !OFFERED_ACTIONS.includes('addToShelf'));
  assert.deepEqual(schema.enabledKeys.parse(ACTION_KEYS.map(action => action.key)), ACTION_KEYS.map(action => action.key));
  assert.deepEqual(schema.quickResizeKeys.parse([...RESIZE_KEYS]), [...RESIZE_KEYS]);
  assert.equal(new Set(TEMPLATE_VARIABLES.map(([token]) => token)).size, TEMPLATE_VARIABLES.length);
});

test('the default action keys are all offered in the window', () => {
  const offered = ACTION_KEYS.map(action => action.key) as string[];
  assert.deepEqual((schema.enabledKeys.default as string[]).filter(key => !offered.includes(key)), []);
});

test('a key press becomes the accelerator Electron registers', () => {
  assert.equal(recorded(event('KeyC', { ctrlKey: true, shiftKey: true })).accelerator, 'Control+Shift+C');
  assert.equal(recorded(event('Digit1', { altKey: true, shiftKey: true })).accelerator, 'Shift+Alt+1');
  assert.equal(recorded(event('Space', { metaKey: true, ctrlKey: true })).accelerator, 'Control+Super+Space');
  assert.equal(recorded(event('Minus')).accelerator, '-');
  assert.equal(recorded(event('F12', { ctrlKey: true })).accelerator, 'Control+F12');
  assert.equal(recorded(event('Enter', { altKey: true })).accelerator, 'Alt+Return');
  assert.equal(recorded(event('ArrowLeft', { ctrlKey: true })).accelerator, 'Control+Left');
});

test('modifier presses record only the modifiers held, and keys with no accelerator name record nothing', () => {
  assert.deepEqual(recorded(event('ControlLeft', { ctrlKey: true })), { modifiers: ['Control'] });
  assert.deepEqual(recorded(event('ShiftRight', { ctrlKey: true, shiftKey: true })), { modifiers: ['Control', 'Shift'] });
  assert.deepEqual(recorded(event('MetaLeft', { metaKey: true })), { modifiers: ['Super'] });
  assert.deepEqual(recorded(event('AudioVolumeUp', { ctrlKey: true })), { modifiers: ['Control'] });
  assert.equal(isModifierKey(event('AltLeft')), true);
  assert.equal(isModifierKey(event('KeyA')), false);
  assert.equal(keyName(event('Numpad1')), undefined);
  assert.deepEqual(heldModifiers({ ctrlKey: false, shiftKey: true, altKey: true, metaKey: false }), ['Shift', 'Alt']);
});

test('recorded accelerators are accepted by the shortcut settings', () => {
  for (const code of ['KeyA', 'Digit0', 'F24', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Enter', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'PrintScreen', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backquote']) {
    const key = keyName(event(code))!;
    assert.deepEqual(schema.enabledKeys.parse([key]), [key], code);
  }
  assert.equal(formatAccelerator(['Alt', 'Control'], 'X'), 'Control+Alt+X');
  assert.equal(describeAccelerator('Control+Super+Space'), 'Ctrl+Win+Space');
});

test('the renderer\'s modifiers are the schema\'s', () => assert.deepEqual([...KEY_MODIFIERS], [...SCHEMA_MODIFIERS]));

test('trigger keys need more than Shift', () => {
  assert.equal(triggerProblem([]), 'Choose at least one trigger key.');
  assert.match(triggerProblem(['Shift'])!, /Shift alone/);
  assert.match(triggerProblem(['Control'])!, /Ctrl alone/);
  assert.match(triggerProblem(['Alt'])!, /Alt alone/);
  assert.match(triggerProblem(['Super'])!, /Windows key alone/);
  assert.match(triggerProblem(['Alt', 'Control'])!, /AltGr/);
  assert.equal(triggerProblem(['Super', 'Shift']), undefined);
  assert.equal(triggerProblem(['Control', 'Alt', 'Shift']), undefined);
  assert.equal(triggerProblem(['Control', 'Shift']), undefined);
  assert.equal(triggerProblem(['Shift', 'Alt']), undefined);
});
