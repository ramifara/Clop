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
