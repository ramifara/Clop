import { SETTINGS_TABS, settingsTab, type SettingsTab } from '../core/settings/tabs';
// `clop://` links (spec step 27), as Clop/SettingsURL.swift and MCPInstaller.handle read them:
// `clop://settings/<tab>[/<row>]`, `clop://settings/<row>`, `?highlight=<row>`, and `clop://mcp/start|stop`.

export { SETTINGS_TABS, settingsTab, type SettingsTab };
export type ClopURL = { kind: 'settings'; tab?: SettingsTab; row?: string } | { kind: 'mcp'; action: 'start' | 'stop' };

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

/** Links that arrive while the app is still starting wait here, in order, until `ready()`; later ones open at once. */
export function linkInbox(open: (link: ClopURL) => void) {
  let ready = false;
  const held: ClopURL[] = [];
  return {
    receive(links: readonly ClopURL[]) { if (ready) links.forEach(open); else held.push(...links); },
    ready() { ready = true; held.splice(0).forEach(open); },
  };
}
