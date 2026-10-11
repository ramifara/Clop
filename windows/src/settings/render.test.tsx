import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { SETTING_ENTRIES } from '../../core/settings/entries';
import { settingsMeta } from '../../core/settings/meta';
import { defaultSettings, type ClopSettings } from '../../core/settings/schema';

// The renderer never ran under Node before this test: `api.ts` reads `window` when it is imported.
(globalThis as { window?: unknown }).window = {};
const { SettingsContext } = await import('./context');
const { EntryRow } = await import('./EntryRow');
const { Automation, PresetZones, SavedPipelines } = await import('./panes');

const metas = new Map(settingsMeta().map(meta => [meta.key, meta]));
const env = (settings: ClopSettings) => ({ settings, metas, native: true, platform: 'win32', run: async () => true, change: () => {}, prefs: async () => undefined, ask: async () => undefined });
const render = (node: React.ReactNode, settings = defaultSettings()) => renderToStaticMarkup(<SettingsContext.Provider value={env(settings)}>{node}</SettingsContext.Provider>);
const withPipelines = (extra: Partial<ClopSettings>) => ({ ...defaultSettings(), ...extra }) as ClopSettings;
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('every row of the index draws with the default settings', () => {
  for (const entry of SETTING_ENTRIES) {
    const html = render(<EntryRow entry={entry} flash={false}/>);
    if (entry.ui?.control === 'embedded') { assert.equal(html, '', entry.id); continue; }
    assert.ok(html.includes(`id="row-${entry.id}"`), entry.id);
    assert.ok(html.includes(`data-row="${entry.id}"`), entry.id);
  }
});

test('a row is dimmed and its controls disabled until its condition holds', () => {
  const entry = SETTING_ENTRIES.find(row => row.keys[0] === 'preserveColorMetadata')!;
  const on = render(<EntryRow entry={entry} flash={false}/>), off = render(<EntryRow entry={entry} flash={false}/>, { ...defaultSettings(), stripMetadata: false });
  assert.doesNotMatch(on, /inactive|disabled/);
  assert.match(off, /inactive/);
  assert.match(off, /<fieldset class="s-control" disabled/);
  assert.match(render(<EntryRow entry={entry} flash/>), /flash/);
});

test('a row that is its whole section leaves its name to the heading', () => {
  const entry = SETTING_ENTRIES.find(row => row.id === 'keys.actionkeys.enabledKeys')!;
  assert.doesNotMatch(render(<EntryRow entry={entry} flash={false}/>), /<strong>Action keys<\/strong>/);
  assert.match(render(<EntryRow entry={SETTING_ENTRIES.find(row => row.keys[0] === 'stripMetadata')!} flash={false}/>), /<strong>Strip EXIF Metadata<\/strong>/);
});

test('a setting drawn as a switch, a choice and a number shows its value', () => {
  const html = (key: string, settings = defaultSettings()) => render(<EntryRow entry={SETTING_ENTRIES.find(row => row.keys[0] === key)!} flash={false}/>, settings);
  assert.match(html('stripMetadata'), /role="switch"[^>]*checked/);
  assert.doesNotMatch(html('stripMetadata', { ...defaultSettings(), stripMetadata: false }), /checked/);
  assert.match(html('floatingResultsCorner', { ...defaultSettings(), floatingResultsCorner: 'topLeft' }), /<option value="topLeft" selected[^>]*>Top left/);
  assert.match(html('clipboardAccumulationTimeout', { ...defaultSettings(), clipboardAccumulationTimeout: 45 }), /type="number"[^>]*value="45"/);
  // A value outside the offered presets is still shown.
  assert.match(html('optimisedFileProtectionMs', { ...defaultSettings(), optimisedFileProtectionMs: 5000 }), /<option value="5000" selected/);
});

test('format chips mark the formats the setting holds, and keep one that is not offered', () => {
  const html = render(<EntryRow entry={SETTING_ENTRIES.find(row => row.keys[0] === 'videoFormatsToSkip')!} flash={false}/>, { ...defaultSettings(), videoFormatsToSkip: ['mkv', 'ogv'] });
  assert.match(html, /s-chip on[^>]*>mkv/);
  assert.match(html, /s-chip on[^>]*>ogv/);
  assert.match(html, /aria-pressed="false"[^>]*>mp4/);
});

test('watched folders list each folder with its floating-result setting', () => {
  const settings = { ...defaultSettings(), videoDirs: ['~/Videos', 'D:\\Capture'], dirsHideFloatingResult: ['d:/capture/'] };
  const html = render(<EntryRow entry={SETTING_ENTRIES.find(row => row.keys[0] === 'videoDirs')!} flash={false}/>, settings);
  assert.match(html, /~\/Videos/);
  assert.match(html, /Stop watching D:\\Capture/);
  // Quiet is matched whatever the case and slashes: Capture is off, Videos is on.
  assert.match(html, /Show floating results for ~\/Videos"[^>]*checked/);
  assert.doesNotMatch(html, /Show floating results for D:\\Capture"[^>]*checked/);
});

test('saved pipelines are listed by type, with unreadable ones counted', () => {
  const settings = withPipelines({ savedPipelines: [
    { id: 'a', name: 'Web ready', rawText: 'optimise\nconvert to webp', fileType: 'image' },
    { id: 'b', name: 'Any file', rawText: 'copy to ~/Out' },
    { raw: { x: 1 }, reason: 'unknown step' },
  ] as never });
  const html = render(<SavedPipelines/>, settings);
  assert.match(html, /Web ready/);
  assert.match(html, /Any file/);
  assert.match(text(html), /1 saved pipeline\(s\) could not be read/);
  assert.match(text(html), /Video No pipelines yet/);
  assert.match(html, /Open the pipeline editor/);
});

test('automation shows what runs on each source, naming a referenced saved pipeline by its own name', () => {
  const settings = withPipelines({
    savedPipelines: [{ id: 'lib', name: 'Web ready' }] as never,
    pipelinesToRunOnImage: { clipboard: [{ id: 'x', libraryID: 'lib' }, { id: 'y', name: 'Rename' }], '~/Downloads': [{ id: 'z', name: 'Tidy' }] } as never,
    pipelinesToRunOnVideo: { dropZone: [{ id: 'v', name: 'Shrink' }] } as never,
  });
  const image = text(render(<Automation kind="image"/>, settings));
  assert.match(image, /Clipboard Web ready → Rename/);
  assert.match(image, /~\/Downloads Tidy/);
  assert.doesNotMatch(image, /Shrink/);
  assert.match(text(render(<Automation source="clipboard"/>, settings)), /Image Web ready → Rename/);
  assert.match(text(render(<Automation source="dropZone"/>, settings)), /Video Shrink/);
  assert.match(text(render(<Automation source="dropZone"/>, defaultSettings())), /Nothing runs automatically/);
});

test('preset zones show their name, type and pipeline', () => {
  const settings = withPipelines({ presetZones: [{ id: 'z', icon: 'photo', name: 'Social', type: 'image', pipeline: { id: 'p', name: 'Resize' } }, { raw: {}, reason: 'bad' }] as never });
  const html = text(render(<PresetZones/>, settings));
  assert.match(html, /Social Image · Resize/);
  assert.match(html, /Unreadable zone/);
  assert.match(text(render(<PresetZones/>)), /No preset zones yet/);
});

test('a row nothing reads yet says so, and a working one does not', () => {
  const html = (key: string) => render(<EntryRow entry={SETTING_ENTRIES.find(row => row.keys[0] === key)!} flash={false}/>);
  assert.match(html('followCursorScreen'), /Not used by Clop for Windows yet/);
  assert.doesNotMatch(html('stripMetadata'), /Not used by Clop/);
  assert.doesNotMatch(render(<EntryRow entry={SETTING_ENTRIES.find(row => row.keys[0] === 'followCursorScreen')!} flash={false} note={false}/>), /Not used by Clop/);
});

test('every row nothing reads yet shows the note, whatever its control and label, and the wired shortcut and tray rows do not', () => {
  const pending = SETTING_ENTRIES.filter(entry => entry.ui?.pending);
  assert.ok(pending.length > 0);
  for (const entry of pending) assert.match(render(<EntryRow entry={entry} flash={false}/>), /Not used by Clop for Windows yet/, entry.id);
  for (const key of ['keyComboModifiers', 'enabledKeys', 'quickResizeKeys', 'showMenubarIcon', 'allowClopToAppearInScreenshots']) {
    assert.doesNotMatch(render(<EntryRow entry={SETTING_ENTRIES.find(row => row.keys[0] === key)!} flash={false}/>), /Not used by Clop/, key);
  }
});
