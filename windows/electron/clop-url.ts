import { SETTINGS_TABS, type SettingsTab } from '../core/settings/tabs';
// `clop://` links (spec step 27), as Clop/SettingsURL.swift and MCPInstaller.handle read them:
// `clop://settings/<tab>[/<row>]`, `clop://settings/<row>`, `?highlight=<row>`, and `clop://mcp/start|stop`.

export { SETTINGS_TABS, type SettingsTab };
export type ClopURL = { kind: 'settings'; tab?: SettingsTab; row?: string } | { kind: 'mcp'; action: 'start' | 'stop' };

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Old macOS name of the Updates tab, kept so a copied link still opens it. */
const ALIASES: Record<string, SettingsTab> = { licenseupdates: 'updates', licenseandupdates: 'updates' };

/** A tab by its case name (`presetZones`) or title (`Preset zones`), in any case, ignoring spaces and dashes. */
export function settingsTab(name: string): SettingsTab | undefined {
  const wanted = normalized(name);
  return ALIASES[wanted] ?? (Object.keys(SETTINGS_TABS) as SettingsTab[]).find(tab => normalized(tab) === wanted || normalized(SETTINGS_TABS[tab]) === wanted);
}

/** What a `clop://` link asks for, or undefined when it is not one of ours. */
export function parseClopURL(text: string): ClopURL | undefined {
  let url: URL;
  try { url = new URL(text); } catch { return undefined; }
  if (url.protocol !== 'clop:') return undefined;
  const parts = url.pathname.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } });
  if (url.hostname === 'mcp') {
    const action = parts.at(-1);
    return action === 'start' || action === 'stop' ? { kind: 'mcp', action } : undefined;
  }
  if (url.hostname !== 'settings') return undefined;
  const tab = parts[0] === undefined ? undefined : settingsTab(parts[0]);
  const row = (parts.length > 1 ? parts[1] : tab ? undefined : parts[0]) ?? url.searchParams.get('highlight') ?? undefined;
  return { kind: 'settings', ...(tab ? { tab } : {}), ...(row ? { row } : {}) };
}

/** The `clop://` links among a process's arguments, as Windows passes them to a new or the running instance. */
export const clopURLs = (argv: readonly string[]) => argv.filter(arg => /^clop:/i.test(arg)).flatMap(arg => parseClopURL(arg) ?? []);
