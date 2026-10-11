// The tabs of the Settings window (`SettingsView.Tabs` in Clop/SettingsView.swift) and how the sidebar groups them.
// Pure data: the window, `clop://settings/<tab>` links and the search index all read it.

export const SETTINGS_TABS = {
  general: 'General', clipboard: 'Clipboard', files: 'File handling', video: 'Video', audio: 'Audio', images: 'Images', pdf: 'PDF', dropzone: 'Drop Zone',
  presetZones: 'Preset Zones', floating: 'Floating Results', keys: 'Keyboard Shortcuts', pipelines: 'Pipelines', automation: 'Automation', mcp: 'MCP', updates: 'Updates', about: 'About',
} as const;
export type SettingsTab = keyof typeof SETTINGS_TABS;
export const TAB_ORDER = Object.keys(SETTINGS_TABS) as SettingsTab[];

/** The sidebar sections: the first has no heading, as in the macOS sidebar. */
export const TAB_GROUPS: readonly { title: string; tabs: readonly SettingsTab[] }[] = [
  { title: '', tabs: ['general', 'clipboard', 'files'] },
  { title: 'File types', tabs: ['video', 'audio', 'images', 'pdf'] },
  { title: 'Drops & Results', tabs: ['dropzone', 'presetZones', 'floating'] },
  { title: 'Shortcuts & Automation', tabs: ['keys', 'pipelines', 'automation', 'mcp'] },
  { title: 'Support', tabs: ['updates', 'about'] },
];

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Old macOS name of the Updates tab, kept so a copied link still opens it. */
const ALIASES: Record<string, SettingsTab> = { licenseupdates: 'updates', licenseandupdates: 'updates' };

/** A tab by its case name (`presetZones`) or title (`Preset zones`), in any case, ignoring spaces and dashes. */
export function settingsTab(name: string): SettingsTab | undefined {
  const wanted = normalized(name);
  return ALIASES[wanted] ?? TAB_ORDER.find(tab => normalized(tab) === wanted || normalized(SETTINGS_TABS[tab]) === wanted);
}
