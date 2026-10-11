import { DOWNSCALE_FACTORS, PDF_RESOLUTIONS, SPEED_UP } from './cards/actions';
import type { ClopSettings } from './settings/schema';
import { formatAccelerator, triggerProblem, type Modifier } from '../src/settings/accelerator';

// The global shortcuts (spec step 38): `keyComboModifiers` held with each key of `enabledKeys` and `quickResizeKeys`, as Electron
// accelerators. Pure, so the mapping, the validation and the re-registration diff are tested without Electron.

/** What a shortcut does. `resize` downscales the latest result to `factor`; the others are the macOS `handleHotkey` cases (ClopApp.swift). */
export type ShortcutKind = 'downscale' | 'resize' | 'speedUp' | 'dismiss' | 'clearAll' | 'bringBack' | 'preview' | 'restore' | 'pause' | 'optimiseClipboard' | 'aggressive' | 'crop';
export interface ShortcutAction { kind: ShortcutKind; factor?: number }
export interface Shortcut { accelerator: string; action: ShortcutAction }
type ShortcutSettings = Pick<ClopSettings, 'keyComboModifiers' | 'enabledKeys' | 'quickResizeKeys'>;

/**
 * The macOS default key set on Windows. Backspace stands for macOS's Delete key. Rename (R) has no Windows counterpart: Clop for
 * Windows cards have no inline file name field, so the key is accepted in settings and nothing is registered for it.
 */
export const KEY_ACTIONS: Readonly<Record<string, ShortcutAction>> = {
  '-': { kind: 'downscale' }, X: { kind: 'speedUp' }, Backspace: { kind: 'dismiss' }, Escape: { kind: 'clearAll' }, '=': { kind: 'bringBack' }, Space: { kind: 'preview' },
  Z: { kind: 'restore' }, P: { kind: 'pause' }, C: { kind: 'optimiseClipboard' }, A: { kind: 'aggressive' }, K: { kind: 'crop' },
};
const RESIZE = /^[1-9]$/;

/** Why `change` cannot be saved as shortcuts, or undefined. Only the keys it names are checked. */
export function shortcutProblem(change: Partial<ShortcutSettings>): string | undefined {
  if (change.keyComboModifiers) { const problem = triggerProblem(change.keyComboModifiers as Modifier[]); if (problem) return problem; }
  const bad = change.quickResizeKeys?.find(key => !RESIZE.test(key));
  if (bad) return `${bad} cannot downscale: resize keys are the number keys 1 to 9.`;
  return undefined;
}

/** The shortcuts the settings ask for, one per accelerator. None while the trigger keys are unusable (Shift alone would take every capital letter). */
export function shortcutsFor(settings: ShortcutSettings): Shortcut[] {
  const modifiers = settings.keyComboModifiers as Modifier[];
  if (triggerProblem(modifiers)) return [];
  const seen = new Set<string>(), shortcuts: Shortcut[] = [];
  const add = (key: string, action: ShortcutAction | undefined) => {
    const accelerator = formatAccelerator(modifiers, key);
    if (action && !seen.has(accelerator)) { seen.add(accelerator); shortcuts.push({ accelerator, action }); }
  };
  for (const key of settings.enabledKeys) add(key.length === 1 ? key.toUpperCase() : key, KEY_ACTIONS[key.length === 1 ? key.toUpperCase() : key]);
  for (const key of settings.quickResizeKeys) if (RESIZE.test(key)) add(key, { kind: 'resize', factor: Number(key) / 10 });
  return shortcuts;
}

/** The accelerator shown beside a menu item for the key, or undefined while that key is off. */
export const hintFor = (shortcuts: readonly Shortcut[], kind: ShortcutKind) => shortcuts.find(shortcut => shortcut.action.kind === kind)?.accelerator;

/** Accelerators to drop and to take when the wanted set changes from `previous` to `next`; those in both stay as they are. */
export function diffShortcuts(previous: Iterable<string>, next: Iterable<string>) {
  const before = new Set(previous), after = new Set(next);
  return { remove: [...before].filter(key => !after.has(key)), add: [...after].filter(key => !before.has(key)) };
}

export interface ShortcutApi { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void }
/**
 * Keeps `api` (Electron's `globalShortcut`) in step with the wanted shortcuts. Only the differences are registered or released, and
 * a conflict is reported once, when the accelerator is first asked for; it is tried again only after the settings drop it and ask again.
 */
export class ShortcutRegistry {
  private wanted = new Map<string, ShortcutAction>();
  private held = new Set<string>();
  constructor(private api: ShortcutApi, private run: (action: ShortcutAction) => void, private conflict: (accelerator: string) => void) {}
  sync(shortcuts: readonly Shortcut[]) {
    const next = new Map(shortcuts.map(shortcut => [shortcut.accelerator, shortcut.action]));
    const { remove, add } = diffShortcuts(this.wanted.keys(), next.keys());
    for (const accelerator of remove) if (this.held.delete(accelerator)) this.api.unregister(accelerator);
    this.wanted = next;
    for (const accelerator of add) {
      let ok = false;
      // Electron throws for an accelerator it cannot parse, and returns false when another program has the keys.
      try { ok = this.api.register(accelerator, () => this.press(accelerator)); } catch { ok = false; }
      if (ok) this.held.add(accelerator); else this.conflict(accelerator);
    }
  }
  private press(accelerator: string) { const action = this.wanted.get(accelerator); if (action) this.run(action); }
  dispose() { for (const accelerator of this.held) this.api.unregister(accelerator); this.held.clear(); this.wanted.clear(); }
}

/** The next smaller downscale factor: a quarter off above 50 %, a tenth below (ClopApp.swift), on the factors the card menu offers. */
export function nextDownscale(current: number): number | undefined {
  if (current <= 0.1 + 1e-9) return undefined;
  const target = current > 0.5 ? current - 0.25 : current - 0.1;
  return DOWNSCALE_FACTORS.find(factor => factor <= target + 1e-9) ?? DOWNSCALE_FACTORS.at(-1);
}
/** The next faster playback speed the card menu offers. */
export const nextSpeed = (current: number) => SPEED_UP.find(speed => speed > current + 1e-9);
/** The next lower PDF resolution; a PDF starts at 300 dpi. */
export const nextResolution = (current = 300) => PDF_RESOLUTIONS.find(dpi => dpi < current);
