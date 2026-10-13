// Recording a shortcut: a keyboard event becomes an Electron accelerator (https://www.electronjs.org/docs/latest/api/accelerator),
// which is what `keyComboModifiers`, `enabledKeys` and `quickResizeKeys` store.

/** `KEY_MODIFIERS` of the schema, which the renderer cannot import (it needs Node); a test holds the two together. */
export const KEY_MODIFIERS = ['Control', 'Shift', 'Alt', 'Super'] as const;
export type Modifier = (typeof KEY_MODIFIERS)[number];
export interface KeyEventLike { code: string; key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }

const NAMED: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Enter: 'Return', NumpadEnter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape', PrintScreen: 'PrintScreen',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
};
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

export const isModifierKey = (event: Pick<KeyEventLike, 'code'>) => MODIFIER_CODES.test(event.code);

/** The accelerator key code for a physical key, or undefined for a key an accelerator cannot end with. Physical, so Shift+1 is `1` and not `!`. */
export function keyName(event: Pick<KeyEventLike, 'code'>): string | undefined {
  const { code } = event;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return NAMED[code];
}

/** The modifiers held in `event`, in the order accelerators write them. */
export function heldModifiers(event: Pick<KeyEventLike, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): Modifier[] {
  return KEY_MODIFIERS.filter(modifier => ({ Control: event.ctrlKey, Shift: event.shiftKey, Alt: event.altKey, Super: event.metaKey })[modifier]);
}

export const formatAccelerator = (modifiers: readonly Modifier[], key: string) => [...KEY_MODIFIERS.filter(modifier => modifiers.includes(modifier)), key].join('+');

/** What a key press records: the whole shortcut once a non-modifier key is down, else just the modifiers held so far. */
export function recorded(event: KeyEventLike): { modifiers: Modifier[]; key?: string; accelerator?: string } {
  const modifiers = heldModifiers(event);
  if (isModifierKey(event)) return { modifiers };
  const key = keyName(event);
  return key ? { modifiers, key, accelerator: formatAccelerator(modifiers, key) } : { modifiers };
}

const NAMES: Record<Modifier, string> = { Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Super: 'Win' };
/** How a modifier reads on a key cap. */
export const modifierLabel = (modifier: Modifier) => NAMES[modifier];
/** How an accelerator reads: `Control+Shift+C` as `Ctrl+Shift+C`. */
export const describeAccelerator = (accelerator: string) => accelerator.split('+').map(part => (NAMES as Record<string, string>)[part] ?? part).join('+');

/** The trigger keys must include something besides Shift, which alone would type capital letters (`allowShiftAlone: false` in the macOS pane). Returns why not, or undefined when they are fine. */
export function triggerProblem(modifiers: readonly Modifier[]): string | undefined {
  if (!modifiers.length) return 'Choose at least one trigger key.';
  if (modifiers.length === 1 && modifiers[0] === 'Shift') return 'Shift alone types capital letters. Add Ctrl, Alt or Win.';
  return undefined;
}
