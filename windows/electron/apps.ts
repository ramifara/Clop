import type { AppEntry } from '../src/types';

const MAX_APPS = 2000, MAX_TEXT = 32_767;

const normalise = (value: string) => value.trim().replace(/\//g, '\\').toLowerCase();
const fileName = (value: string) => value.slice(value.lastIndexOf('\\') + 1);

/**
 * Whether the app that put a clipboard change there is in `clipboardIgnoredAppBundleIds`, ignoring case: an entry is its exe
 * path or its AUMID, and an entry that is only an exe name (`SnippingTool.exe`) matches that exe anywhere.
 */
export function ignoredApp(source: { owner?: string; aumid?: string }, ignored: readonly string[]): boolean {
  if (!ignored.length || (!source.owner && !source.aumid)) return false;
  const owner = source.owner ? normalise(source.owner) : undefined, aumid = source.aumid ? normalise(source.aumid) : undefined;
  return ignored.some(entry => {
    const value = normalise(entry);
    if (!value) return false;
    return value === owner || value === aumid || (!value.includes('\\') && value.endsWith('.exe') && !!owner && fileName(owner) === value);
  });
}

/** What the ignored-apps list stores for the app: its AUMID when packaged, else its exe path. */
export const ignoredEntry = (source: { owner?: string; aumid?: string }) => source.aumid || source.owner;

/**
 * The ignored-apps list with the app that copied last added or taken off (the tray's "Ignore clipboard events from"). Taking it off
 * drops every entry that matches it, an exe-name entry included, so the app really is no longer ignored.
 */
export function withIgnored(list: readonly string[], source: { owner?: string; aumid?: string }, ignore: boolean): string[] {
  const entry = ignoredEntry(source);
  if (!entry) return [...list];
  if (!ignore) return list.filter(item => !ignoredApp(source, [item]));
  return ignoredApp(source, list) ? [...list] : [...list, entry];
}

/** The `apps` reply from the Windows helper, checked entry by entry; malformed entries are dropped. Sorted by name, running apps first. */
export function appsReply(reply: unknown): AppEntry[] {
  const apps = (reply as Record<string, unknown> | null)?.apps;
  if (!Array.isArray(apps)) throw new Error('The Windows helper sent an unreadable list of apps.');
  const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT;
  return apps.slice(0, MAX_APPS).flatMap(app => {
    const a = app as Record<string, unknown> | null;
    return a && text(a.name) && text(a.path) ? [{ name: a.name.trim(), path: a.path, running: a.running === true }] : [];
  }).sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}
