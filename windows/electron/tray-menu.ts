import type { MenuItemConstructorOptions } from 'electron';
import { hintFor, type Shortcut } from '../core/shortcuts';
import type { ClopSettings } from '../core/settings/schema';

// The tray menu (spec step 36, `ContentView.swift`) as a pure function of the app's state, so it is tested without Electron. `main.ts` feeds it
// the state and the actions, and turns the result into a native menu with `toTemplate`, which catches every handler's error.

export interface TrayItem {
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox';
  checked?: boolean;
  enabled?: boolean;
  /** Shown beside the label; the global shortcut that does the same. */
  accelerator?: string;
  submenu?: TrayItem[];
  /** `checked` is the new state of a checkbox. */
  click?: (checked: boolean) => void | Promise<unknown>;
}
const separator: TrayItem = { type: 'separator' };

export type TraySettings = Pick<ClopSettings, 'enableClipboardOptimiser' | 'keepDropZoneVisible' | 'pauseAutomaticOptimisations' | 'allowClopToAppearInScreenshots'>;
export interface TrayState {
  settings: TraySettings;
  /** The shortcuts that are on, for the hints beside items. */
  shortcuts: readonly Shortcut[];
  /** The clipboard results, newest first (see `recentClipboard`). */
  recent: { id: string; label: string }[];
  /** The app that put the latest thing on the clipboard, when known, and whether its copies are ignored. */
  copier?: { id: string; name: string; ignored: boolean };
  canRevert: boolean;
  canBringBack: boolean;
  /** The command-line tool item: only the portable app offers to install it (an installed one has it beside the app). */
  cli?: { installed: boolean };
  /** The Explorer right-click entries: only the portable app offers to add them (the installer adds its own). */
  explorer?: { installed: boolean };
  version: string;
}
export interface TrayActions {
  showLatest(): void;
  showRecent(id: string): void | Promise<unknown>;
  batch(): void;
  settings(): void;
  pipelines(): void | Promise<unknown>;
  optimiseClipboard(aggressive: boolean): void | Promise<unknown>;
  downscaleClipboard(): void | Promise<unknown>;
  ignoreApp(id: string, ignore: boolean): void | Promise<unknown>;
  openBackups(): void | Promise<unknown>;
  openWorkdir(): void | Promise<unknown>;
  forceClean(): void | Promise<unknown>;
  revert(): void | Promise<unknown>;
  bringBack(): void;
  stopAll(): void;
  set(change: Partial<TraySettings>): void | Promise<unknown>;
  toggleCLI(): void;
  toggleExplorer(): void | Promise<unknown>;
  checkForUpdates(): void | Promise<unknown>;
  saveDebugDump(): void | Promise<unknown>;
  quit(): void;
}

const RECENT = 8, NAME_MAX = 36;
const size = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
/** The finished clipboard results for the "Recent clipboard items" submenu, newest first. */
export function recentClipboard(items: readonly { id: string; name: string; source: string; status: string; outputBytes: number; createdAt: number }[]): TrayState['recent'] {
  return items.filter(item => item.source === 'clipboard' && item.status === 'ready').sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT)
    .map(item => ({ id: item.id, label: `${item.name.length > NAME_MAX ? `${item.name.slice(0, NAME_MAX - 1)}…` : item.name} (${size(item.outputBytes)})` }));
}

/** The icon the tray shows. Work in progress wins over paused, which stays once the work is done. */
export type TrayVariant = 'normal' | 'paused' | 'working';
export const trayVariant = (state: { working: boolean; paused: boolean }): TrayVariant => state.working ? 'working' : state.paused ? 'paused' : 'normal';
export const trayTooltip = (variant: TrayVariant) => variant === 'working' ? 'Clop: working' : variant === 'paused' ? 'Clop: automatic optimisations are paused' : 'Clop';

export function trayMenu(state: TrayState, actions: TrayActions): TrayItem[] {
  const { settings } = state, hint = (kind: Parameters<typeof hintFor>[1]) => hintFor(state.shortcuts, kind);
  return [
    { label: 'Show latest results', click: actions.showLatest },
    { label: 'Recent clipboard items', enabled: state.recent.length > 0, submenu: state.recent.map(item => ({ label: item.label, click: () => actions.showRecent(item.id) })) },
    { label: 'Batch optimiser…', click: actions.batch },
    { label: 'Pipelines…', click: actions.pipelines },
    { label: 'Settings…', click: actions.settings },
    separator,
    { label: 'Optimise clipboard', accelerator: hint('optimiseClipboard'), click: () => actions.optimiseClipboard(false) },
    { label: 'Optimise clipboard (aggressive)', accelerator: hint('aggressive'), click: () => actions.optimiseClipboard(true) },
    { label: 'Downscale and preview the clipboard', accelerator: hint('downscale'), click: actions.downscaleClipboard },
    ...(state.copier ? [{ label: `Ignore clipboard events from ${state.copier.name}`, type: 'checkbox' as const, checked: state.copier.ignored, click: (ignore: boolean) => actions.ignoreApp(state.copier!.id, ignore) }] : []),
    separator,
    { label: 'Open backups folder', click: actions.openBackups },
    { label: 'Open working directory', click: actions.openWorkdir },
    { label: 'Force clean working directory', click: actions.forceClean },
    { label: 'Revert last optimisations', enabled: state.canRevert, accelerator: hint('restore'), click: actions.revert },
    { label: 'Bring back last result', enabled: state.canBringBack, accelerator: hint('bringBack'), click: actions.bringBack },
    { label: 'Stop all', click: actions.stopAll },
    separator,
    { label: 'Watch clipboard', type: 'checkbox', checked: settings.enableClipboardOptimiser, click: checked => actions.set({ enableClipboardOptimiser: checked }) },
    { label: 'Keep drop zone visible', type: 'checkbox', checked: settings.keepDropZoneVisible, click: checked => actions.set({ keepDropZoneVisible: checked }) },
    { label: 'Pause automatic optimisations', type: 'checkbox', checked: settings.pauseAutomaticOptimisations, accelerator: hint('pause'), click: checked => actions.set({ pauseAutomaticOptimisations: checked }) },
    ...(state.cli ? [{ label: state.cli.installed ? 'Remove command-line tool' : 'Install command-line tool', click: actions.toggleCLI }] : []),
    ...(state.explorer ? [{ label: state.explorer.installed ? 'Remove Explorer menu entries' : 'Add Explorer menu entries', click: actions.toggleExplorer }] : []),
    separator,
    { label: 'Check for updates…', click: actions.checkForUpdates },
    { label: 'Show Clop UI in screenshots', type: 'checkbox', checked: settings.allowClopToAppearInScreenshots, click: checked => actions.set({ allowClopToAppearInScreenshots: checked }) },
    { label: 'About', submenu: [{ label: `Version ${state.version}`, enabled: false }, separator, { label: 'Save debug dump', click: actions.saveDebugDump }] },
    separator,
    { label: 'Quit Clop', click: actions.quit },
  ];
}

/**
 * The native menu for `items`. Every handler is called inside a catch, whether it throws or returns a promise that rejects, so a failed
 * click (an unreadable settings file, a folder that is gone) reaches `report` and never becomes an unhandled rejection.
 */
export function toTemplate(items: readonly TrayItem[], report: (error: unknown) => void): MenuItemConstructorOptions[] {
  return items.map(({ click, submenu, ...item }) => ({
    ...item,
    // The accelerator is a hint of the global shortcut; as a menu accelerator too it would run the action a second time.
    ...(item.accelerator ? { registerAccelerator: false } : {}),
    ...(submenu ? { submenu: toTemplate(submenu, report) } : {}),
    ...(click ? { click: (menuItem: { checked: boolean }) => guarded(() => click(menuItem.checked), report) } : {}),
  }));
}
export function guarded(run: () => unknown, report: (error: unknown) => void) {
  try { Promise.resolve(run()).catch(report); } catch (error) { report(error); }
}
