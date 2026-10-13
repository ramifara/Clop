import { DOWNSCALE_FACTORS, PDF_RESOLUTIONS, SPEED_UP } from './cards/actions';
import type { ClopSettings } from './settings/schema';
import { describeAccelerator, formatAccelerator, KEY_MODIFIERS, triggerProblem, type Modifier } from '../src/settings/accelerator';

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

/** What `accelerator` is once its modifiers are in accelerator order and its key is spelled one way, for comparing. */
function canonical(accelerator: string) {
  const parts = accelerator.split('+'), key = parts.pop()!.toLowerCase().replace(/^esc$/, 'escape');
  return [...KEY_MODIFIERS.filter(modifier => parts.includes(modifier)), key].join('+');
}
/** What Windows keeps for itself: a global shortcut on these would fail, or would take them from the system. */
const RESERVED = new Map([
  ['Control+Shift+Escape', 'opens Task Manager'], ['Control+Alt+Delete', 'is the secure attention sequence'], ['Control+Escape', 'opens the Start menu'],
  ['Super+L', 'locks the PC'], ['Alt+Tab', 'switches windows'], ['Alt+F4', 'closes the window in front'], ['Shift+Super+S', 'starts a screenshot'],
].map(([accelerator, why]) => [canonical(accelerator), why]));
/** Why Windows keeps this accelerator for itself, or undefined. */
export const reservedBy = (accelerator: string) => RESERVED.get(canonical(accelerator));

/**
 * Why `change` cannot be saved as shortcuts, or undefined. The trigger keys and resize keys it names are checked on their own; with
 * `current` (the settings the change lands on) the combinations it makes are checked too, so no change can turn on an accelerator
 * Windows reserves, whichever of the three settings it touches.
 */
export function shortcutProblem(change: Partial<ShortcutSettings>, current?: ShortcutSettings): string | undefined {
  if (change.keyComboModifiers) { const problem = triggerProblem(change.keyComboModifiers as Modifier[]); if (problem) return problem; }
  const bad = change.quickResizeKeys?.find(key => !RESIZE.test(key));
  if (bad) return `${bad} cannot downscale: resize keys are the number keys 1 to 9.`;
  if (current && (change.keyComboModifiers || change.enabledKeys || change.quickResizeKeys)) {
    const merged = { ...current, ...change };
    if (!triggerProblem(merged.keyComboModifiers as Modifier[])) for (const { accelerator } of plan(merged)) {
      const why = reservedBy(accelerator);
      if (why) return `${describeAccelerator(accelerator)} ${why} in Windows, so Clop cannot use it. Turn that key off or change the trigger keys.`;
    }
  }
  return undefined;
}

/** Every accelerator the settings ask for, reserved ones included. */
function plan(settings: ShortcutSettings): Shortcut[] {
  const modifiers = settings.keyComboModifiers as Modifier[], seen = new Set<string>(), shortcuts: Shortcut[] = [];
  const add = (key: string, action: ShortcutAction | undefined) => {
    const accelerator = formatAccelerator(modifiers, key);
    if (action && !seen.has(accelerator)) { seen.add(accelerator); shortcuts.push({ accelerator, action }); }
  };
  for (const key of settings.enabledKeys) { const name = key.length === 1 ? key.toUpperCase() : key; add(name, KEY_ACTIONS[name]); }
  for (const key of settings.quickResizeKeys) if (RESIZE.test(key)) add(key, { kind: 'resize', factor: Number(key) / 10 });
  return shortcuts;
}
/** The shortcuts the settings ask for, one per accelerator. None while the trigger keys are unusable, and never one Windows reserves. */
export function shortcutsFor(settings: ShortcutSettings): Shortcut[] {
  if (triggerProblem(settings.keyComboModifiers as Modifier[])) return [];
  return plan(settings).filter(shortcut => !reservedBy(shortcut.accelerator));
}

/** The accelerator shown beside a menu item for the key, or undefined while that key is off. */
export const hintFor = (shortcuts: readonly Shortcut[], kind: ShortcutKind) => shortcuts.find(shortcut => shortcut.action.kind === kind)?.accelerator;

/** Accelerators to drop and to take when the wanted set changes from `previous` to `next`; those in both stay as they are. */
export function diffShortcuts(previous: Iterable<string>, next: Iterable<string>) {
  const before = new Set(previous), after = new Set(next);
  return { remove: [...before].filter(key => !after.has(key)), add: [...after].filter(key => !before.has(key)) };
}

export interface ShortcutApi { register(accelerator: string, callback: () => void): boolean; unregister(accelerator: string): void }
/** What a `sync` did with the accelerators it newly asked for. */
export interface SyncResult { registered: string[]; failed: string[] }
/**
 * Keeps `api` (Electron's `globalShortcut`) in step with the wanted shortcuts. Only the differences are registered or released, and
 * `sync` says which new accelerators registered and which another program already has; one that failed is tried again only after
 * the settings drop it and ask again.
 */
export class ShortcutRegistry {
  private wanted = new Map<string, ShortcutAction>();
  private held = new Set<string>();
  constructor(private api: ShortcutApi, private run: (action: ShortcutAction) => void) {}
  sync(shortcuts: readonly Shortcut[]): SyncResult {
    const next = new Map(shortcuts.map(shortcut => [shortcut.accelerator, shortcut.action]));
    const { remove, add } = diffShortcuts(this.wanted.keys(), next.keys());
    for (const accelerator of remove) if (this.held.delete(accelerator)) this.api.unregister(accelerator);
    this.wanted = next;
    const result: SyncResult = { registered: [], failed: [] };
    for (const accelerator of add) {
      let ok = false;
      // Electron throws for an accelerator it cannot parse, and returns false when another program has the keys.
      try { ok = this.api.register(accelerator, () => this.press(accelerator)); } catch { ok = false; }
      if (ok) { this.held.add(accelerator); result.registered.push(accelerator); } else result.failed.push(accelerator);
    }
    return result;
  }
  private press(accelerator: string) { const action = this.wanted.get(accelerator); if (action) this.run(action); }
  dispose() { for (const accelerator of this.held) this.api.unregister(accelerator); this.held.clear(); this.wanted.clear(); }
}

/**
 * The conflicts to tell the user about after a sync, and the list to keep so the same one is not announced at every launch:
 * an accelerator is announced the first time it fails, and forgotten once it registers or is no longer wanted, so a later
 * conflict is news again.
 */
export function conflictNotice(seen: readonly string[], { registered, failed }: SyncResult, wanted: readonly Shortcut[]): { announce: string[]; seen: string[] } {
  const still = new Set(wanted.map(shortcut => shortcut.accelerator));
  const keep = seen.filter(accelerator => still.has(accelerator) && !registered.includes(accelerator));
  return { announce: failed.filter(accelerator => !seen.includes(accelerator)), seen: [...new Set([...keep, ...failed])] };
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

/**
 * The pause key's three steps (ClopApp.swift): running, then paused for the next clipboard event only, then stopped (paused until it is
 * pressed again), then running. The notice says where it landed.
 */
export function nextPause({ paused, pauseNext }: { paused: boolean; pauseNext: boolean }): { paused: boolean; pauseNext: boolean; notice: string } {
  if (paused) return { paused: false, pauseNext: false, notice: 'Running. Clop is listening for clipboard and file events.' };
  if (pauseNext) return { paused: true, pauseNext, notice: 'Stopped. All automatic optimisations are stopped.' };
  return { paused: false, pauseNext: true, notice: 'Paused. The next clipboard event will be ignored.' };
}
