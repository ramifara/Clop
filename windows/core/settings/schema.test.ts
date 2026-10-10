import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandHome, portablePath } from './paths';
import { LEGACY_KEYS, SETTING_KEYS, defaultSettings, isLegacySettings, migrateLegacy, parseSettings, settingsSchema, type SettingSpec } from './schema';

const windowsRoot = fileURLToPath(new URL('../..', import.meta.url));
const macNames = (file?: string) => execFileSync(process.execPath, [path.join(windowsRoot, 'scripts', 'extract-mac-settings.mjs'), ...(file ? [path.join(windowsRoot, '..', file)] : [])], { encoding: 'utf8' }).trim().split('\n');
const paths = { home: '/home/user', desktop: '/home/user/Desktop', userData: '/home/user/.config/Clop for Windows' };
const specs = settingsSchema as Record<string, SettingSpec>;

test('the schema holds every macOS key from Settings.swift and marks the rest Windows-only', t => {
  const mac = macNames();
  assert.equal(mac.length, 153);
  assert.deepEqual(mac.filter(name => !Object.hasOwn(settingsSchema, name)), []);
  for (const name of mac) assert.ok(!specs[name].windowsOnly, `${name} is a macOS key`);
  // The pipeline keys live in Automation.swift; every other extra is Windows-only.
  const automation = new Set(macNames('Clop/Automation.swift'));
  const extras = SETTING_KEYS.filter(key => !mac.includes(key));
  const windowsOnly = extras.filter(key => !automation.has(key));
  for (const key of windowsOnly) assert.equal(specs[key].windowsOnly, true, `${key} must be marked windowsOnly`);
  t.diagnostic(`windowsOnly: ${windowsOnly.join(', ')}`);
  t.diagnostic(`from Automation.swift: ${extras.filter(key => automation.has(key)).join(', ')}`);
});

test('every default is a valid value of its own setting', () => {
  const defaults = defaultSettings(paths) as Record<string, unknown>;
  for (const key of SETTING_KEYS) {
    assert.ok(specs[key].description.length > 0, `${key} needs a description`);
    assert.deepEqual(specs[key].parse(defaults[key]), defaults[key], key);
  }
});

test('defaults follow Settings.swift and the Windows encodings', () => {
  const defaults = defaultSettings(paths);
  assert.equal(defaults.workdir, '~/.config/Clop for Windows/work');
  assert.equal(expandHome(defaults.workdir, paths.home), path.join(paths.userData, 'work'));
  assert.equal(defaults.workdirCleanupInterval, 259200);
  assert.deepEqual([defaults.imageDirs, defaults.videoDirs, defaults.pdfDirs, defaults.audioDirs], [['~/Desktop'], ['~/Desktop'], [], []]);
  assert.deepEqual(defaultSettings({ ...paths, desktop: '/home/user/OneDrive/Desktop' }).imageDirs, ['~/OneDrive/Desktop']);
  assert.deepEqual(defaultSettings({ ...paths, desktop: '/srv/desk', userData: '/srv/clop' }).imageDirs.concat(defaultSettings({ ...paths, userData: '/srv/clop' }).workdir), ['/srv/desk', path.join('/srv/clop', 'work')]);
  assert.equal(defaults.videoEncoder, 'auto');
  // Windows keeps optimising image files copied in Explorer, as it did before the macOS key existed here.
  assert.equal(defaults.optimiseImagePathClipboard, true);
  assert.match(settingsSchema.optimiseImagePathClipboard.encoding!, /Windows default differs from macOS/);
  assert.deepEqual(defaults.keyComboModifiers, ['Control', 'Shift']);
  assert.deepEqual(defaults.enabledKeys, ['-', '=', 'Backspace', 'Space', 'Z', 'P', 'C', 'A', 'X', 'R', 'K', 'Escape']);
  assert.deepEqual(defaults.imageCompression, { tier: 'custom', factor: 30 });
  assert.deepEqual(defaults.videoCompression, { tier: 'fast', factor: 50 });
  assert.equal(defaults.sameFolderNameTemplateImage, '%f-optimised');
  assert.equal(defaults.specificFolderNameTemplatePDF, '%P/optimised/%f');
  assert.equal(defaults.savedCropSizes.length, 8);
  assert.equal(defaults.maxPhotosLength, null);
  for (const key of ['enablePhotosIntegration', 'syncSettingsCloud', 'neverShowProError', 'useClassicMenubarIcon', 'useCPUIntensiveEncoder'] as const) assert.equal(specs[key].unsupportedOnWindows, true, key);
});

test('defaults are fresh copies', () => {
  const first = defaultSettings(paths);
  first.enabledKeys.push('F1'); first.savedCropSizes[0].width = 1;
  const second = defaultSettings(paths);
  assert.equal(second.enabledKeys.includes('F1'), false);
  assert.equal(second.savedCropSizes[0].width, 1920);
});

test('parseSettings keeps valid keys and ignores unknown keys and malformed values', () => {
  const current = defaultSettings(paths);
  const next = parseSettings({ enableClipboardOptimiser: 'yes', floatingResultsCorner: 'outside', launchAtLogin: true, imageCompression: 'high', injected: 'no', maxImageSizeMB: 1.5, pdfDPI: 301, enabledKeys: ['C', 'Control+C'], imageDirs: ['~/Pictures'] }, current);
  assert.deepEqual(next, { ...current, launchAtLogin: true, imageDirs: ['~/Pictures'] });
  assert.equal(Object.hasOwn(next, 'injected'), false);
  assert.deepEqual(parseSettings(JSON.parse('{"__proto__": {"enableClipboardOptimiser": false}, "constructor": 1}'), current), current);
  assert.deepEqual(parseSettings(null, current), current);
  assert.deepEqual(parseSettings([1, 2], current), current);
});

test('parseSettings normalises values the way macOS decodes them', () => {
  const next = parseSettings({ videoEncoder: 'hevc_videotoolbox', imageCompression: { factor: 140 }, audioCompression: { tier: 'bogus', factor: 2.5 }, imageFormatsToSkip: ['tiff', 'tiff', 'png'], maxPhotosLength: null }, defaultSettings(paths));
  assert.equal(next.videoEncoder, 'auto');
  assert.equal(parseSettings({ videoEncoder: 'slowHighQuality' }).videoEncoder, 'auto');
  assert.equal(parseSettings({ videoEncoder: 'hevc_nvenc' }).videoEncoder, 'hevc_nvenc');
  assert.deepEqual(next.imageCompression, { tier: 'custom', factor: 100 });
  assert.deepEqual(next.audioCompression, { tier: 'custom', factor: 50 });
  assert.deepEqual(next.imageFormatsToSkip, ['tiff', 'png']);
  assert.equal(next.maxPhotosLength, null);
});

test('migrateLegacy maps every field of the old Windows settings', () => {
  const legacy = { clipboard: false, autoCopy: false, explorerDrag: false, pinned: true, alwaysOnTop: false, launchAtLogin: true, corner: 'top-left', defaultMode: 'aggressive', defaultFormat: 'webp' };
  assert.equal(isLegacySettings(legacy), true);
  assert.deepEqual(Object.keys(LEGACY_KEYS).sort(), Object.keys(legacy).sort());
  const migrated = migrateLegacy(legacy, paths);
  assert.deepEqual(migrated, {
    ...defaultSettings(paths), enableClipboardOptimiser: false, autoCopyToClipboard: false, enableDragAndDrop: false, keepDropZoneVisible: true,
    floatingResultsAlwaysOnTop: false, launchAtLogin: true, floatingResultsCorner: 'topLeft', imageCompression: { tier: 'custom', factor: 64 }, defaultImageFormat: 'webp',
  });
  assert.deepEqual(migrateLegacy({ ...legacy, defaultMode: 'lossless' }, paths).imageCompression, { tier: 'lossless', factor: 30 });
  assert.deepEqual(migrateLegacy({ ...legacy, defaultMode: 'balanced' }, paths).imageCompression, { tier: 'custom', factor: 30 });
  assert.deepEqual(migrateLegacy({ corner: 'constructor', defaultMode: 'toString' }, paths), defaultSettings(paths));
  assert.equal(isLegacySettings(migrated), false);
  assert.equal(isLegacySettings({ launchAtLogin: true }), false);
});

test('expandHome resolves ~, $HOME and ${HOME} prefixes only', () => {
  const home = os.homedir();
  assert.equal(expandHome('~'), home);
  assert.equal(expandHome('~/Desktop'), path.join(home, 'Desktop'));
  assert.equal(expandHome('$HOME/a/b', '/users/x'), path.join('/users/x', 'a/b'));
  assert.equal(expandHome('${HOME}', '/users/x'), path.join('/users/x'));
  for (const unchanged of ['/tmp/~', '~user/x', '$HOMEDIR/x', 'C:\\Users\\x', '']) assert.equal(expandHome(unchanged, '/users/x'), unchanged);
});

test('pdfDPI accepts adaptive (0) and the 48–300 range only', () => {
  for (const dpi of [0, 48, 150, 300]) assert.equal(parseSettings({ pdfDPI: dpi }).pdfDPI, dpi);
  for (const dpi of [1, 47, 301, -1, 72.5]) assert.equal(parseSettings({ pdfDPI: dpi }).pdfDPI, 0, String(dpi));
});

test('portablePath turns paths inside the profile into ~ paths', () => {
  assert.equal(portablePath(path.join('/users/x', 'Desktop'), '/users/x'), '~/Desktop');
  assert.equal(portablePath(path.join('/users/x', 'a', 'b'), '/users/x'), '~/a/b');
  assert.equal(portablePath('/users/x', '/users/x'), '~');
  for (const outside of ['/users/xy/Desktop', '/srv/data']) assert.equal(portablePath(outside, '/users/x'), outside);
  assert.equal(expandHome(portablePath(path.join(os.homedir(), 'Pictures'))), path.join(os.homedir(), 'Pictures'));
});
