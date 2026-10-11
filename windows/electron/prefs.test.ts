import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { defaultSettings, parseSettings, type ClopSettings } from '../core/settings/schema';
import { TEMPLATE_KEYS, createPrefs, LINKS, type PrefsHost } from './prefs';

let root: string, home: string, folderA: string, folderB: string, file: string, exe: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'clop-prefs-'));
  home = path.join(root, 'home'); folderA = path.join(home, 'Pictures'); folderB = path.join(root, 'Elsewhere');
  file = path.join(root, 'notes.txt'); exe = path.join(root, 'Editor.exe');
  await mkdir(folderA, { recursive: true }); await mkdir(folderB);
  await writeFile(file, 'x'); await writeFile(exe, 'MZ');
});
after(() => rm(root, { recursive: true, force: true }));

/** A host that keeps settings in memory, answers pickers from `picks` and records what the main process was asked to do. */
function harness(platform: NodeJS.Platform = process.platform, apps = [{ name: 'Figma', path: 'C:\\Apps\\Figma.exe', running: true }]) {
  let settings = defaultSettings({ home, desktop: path.join(home, 'Desktop'), userData: path.join(home, 'AppData') });
  const picks: string[] = [], opened: unknown[] = [], links: string[] = [];
  const host: PrefsHost = {
    settings: () => settings, defaults: () => defaultSettings({ home, desktop: path.join(home, 'Desktop'), userData: path.join(home, 'AppData') }),
    set: async partial => { settings = parseSettings(partial, settings); }, chooseFolder: async () => picks.shift(), chooseProgram: async () => picks.shift(),
    apps: async () => apps, openEditor: tab => { opened.push(tab); }, openExternal: async url => { links.push(url); }, version: () => ({ name: '1.2.3', platform: 'win32' }), home, platform,
  };
  return { host, prefs: createPrefs(host), picks, opened, links, get: () => settings as ClopSettings };
}

test('the working directory comes from the folder picker, is stored with ~, and can be reset', async () => {
  const h = harness();
  h.picks.push(folderB);
  assert.match((await h.prefs({ action: 'workdir', op: 'choose' })).message!, /after it restarts/);
  assert.equal(h.get().workdir, folderB);
  h.picks.push(folderA);
  await h.prefs({ action: 'workdir', op: 'choose' });
  assert.equal(h.get().workdir, '~/Pictures');
  await h.prefs({ action: 'workdir', op: 'reset' });
  assert.equal(h.get().workdir, defaultSettings({ home, desktop: '', userData: path.join(home, 'AppData') }).workdir);
  // A cancelled picker changes nothing.
  assert.deepEqual(await h.prefs({ action: 'workdir', op: 'choose' }), {});
});

test('the working directory must be an existing folder with a full path', async () => {
  const h = harness();
  for (const bad of [file, path.join(root, 'missing'), 'relative/path']) {
    h.picks.push(bad);
    await assert.rejects(h.prefs({ action: 'workdir', op: 'choose' }), /folder/, bad);
  }
  await assert.rejects(h.prefs({ action: 'workdir', op: 'delete' }), /Choose what to do/);
});

test('watched folders are added from the picker, once, and removed with their quiet setting', async () => {
  const h = harness();
  const before = h.get().imageDirs;
  h.picks.push(folderB);
  await h.prefs({ action: 'folder', kind: 'image', op: 'add' });
  assert.deepEqual(h.get().imageDirs, [...before, folderB]);
  h.picks.push(folderB);
  await assert.rejects(h.prefs({ action: 'folder', kind: 'image', op: 'add' }), /already watched/);
  // Another file type may watch the same folder.
  h.picks.push(folderB);
  await h.prefs({ action: 'folder', kind: 'pdf', op: 'add' });
  await h.prefs({ action: 'quiet', folder: folderB, quiet: true });
  assert.deepEqual(h.get().dirsHideFloatingResult, [folderB]);
  // Still watched for PDFs, so the quiet setting stays.
  await h.prefs({ action: 'folder', kind: 'image', op: 'remove', folder: folderB });
  assert.deepEqual(h.get().imageDirs, before);
  assert.deepEqual(h.get().dirsHideFloatingResult, [folderB]);
  await h.prefs({ action: 'folder', kind: 'pdf', op: 'remove', folder: folderB });
  assert.deepEqual(h.get().pdfDirs, []);
  assert.deepEqual(h.get().dirsHideFloatingResult, []);
});

test('only folders in the list can be removed or silenced, and kinds and flags are checked', async () => {
  const h = harness();
  await assert.rejects(h.prefs({ action: 'folder', kind: 'image', op: 'remove', folder: folderB }), /not in the list/);
  await assert.rejects(h.prefs({ action: 'quiet', folder: folderB, quiet: true }), /not watched/);
  await assert.rejects(h.prefs({ action: 'quiet', folder: '~/Desktop', quiet: 'yes' }), /whether results/);
  await assert.rejects(h.prefs({ action: 'folder', kind: 'text', op: 'add' }), /file type/);
  await assert.rejects(h.prefs({ action: 'folder', kind: 'image', op: 'remove', folder: '' }), /Choose a folder/);
  // `~/Desktop` is watched by default, however it is written.
  await h.prefs({ action: 'quiet', folder: path.join(home, 'Desktop'), quiet: true });
  assert.deepEqual(h.get().dirsHideFloatingResult, ['~/Desktop']);
  await h.prefs({ action: 'quiet', folder: '$HOME/Desktop/', quiet: false });
  assert.deepEqual(h.get().dirsHideFloatingResult, []);
});

test('an editor is a program from the picker; on Windows only an .exe', async () => {
  const h = harness('win32');
  h.picks.push(file);
  await assert.rejects(h.prefs({ action: 'editor', kind: 'image', op: 'choose' }), /\.exe/);
  h.picks.push('Editor.exe');
  await assert.rejects(h.prefs({ action: 'editor', kind: 'image', op: 'choose' }), /full path/);
  h.picks.push('C:\\Missing\\Editor.exe');
  await assert.rejects(h.prefs({ action: 'editor', kind: 'image', op: 'choose' }), /not a file|full path/);
  assert.equal(h.get().editorAppImage, '');
  const other = harness();
  other.picks.push(exe);
  await other.prefs({ action: 'editor', kind: 'pdf', op: 'choose' });
  assert.equal(other.get().editorAppPDF, exe);
  await other.prefs({ action: 'editor', kind: 'pdf', op: 'clear' });
  assert.equal(other.get().editorAppPDF, '');
  other.picks.push(folderA);
  await assert.rejects(other.prefs({ action: 'editor', kind: 'video', op: 'choose' }), /not a file|\.exe/);
  await assert.rejects(other.prefs({ action: 'editor', kind: 'gif', op: 'choose' }), /file type/);
});

test('ignored apps come from the helper\'s list or a picked program, once, and are removed by what is stored', async () => {
  const h = harness();
  await assert.rejects(h.prefs({ action: 'ignore', op: 'add', entry: 'C:\\Evil\\anything.exe' }), /does not know that app/);
  await assert.rejects(h.prefs({ action: 'ignore', op: 'add' }), /Choose an app/);
  await h.prefs({ action: 'ignore', op: 'add', entry: 'c:\\apps\\FIGMA.exe' });
  assert.deepEqual(h.get().clipboardIgnoredAppBundleIds, ['C:\\Apps\\Figma.exe']);
  await h.prefs({ action: 'ignore', op: 'add', entry: 'C:\\Apps\\Figma.exe' });
  assert.equal(h.get().clipboardIgnoredAppBundleIds.length, 1);
  h.picks.push(exe);
  await h.prefs({ action: 'ignore', op: 'choose' });
  assert.deepEqual(h.get().clipboardIgnoredAppBundleIds, ['C:\\Apps\\Figma.exe', exe]);
  await assert.rejects(h.prefs({ action: 'ignore', op: 'remove', entry: 'C:\\Other.exe' }), /not in the list/);
  await h.prefs({ action: 'ignore', op: 'remove', entry: 'c:\\apps\\figma.exe' });
  assert.deepEqual(h.get().clipboardIgnoredAppBundleIds, [exe]);
});

test('template previews run the real template on an example file without moving the counter', async () => {
  const h = harness('win32');
  const win = path.win32;
  assert.deepEqual((await h.prefs({ action: 'template', key: 'sameFolderNameTemplateImage', template: '%f-small' })).preview, { input: 'Screenshot.png', output: 'Screenshot-small.png' });
  assert.equal((await h.prefs({ action: 'template', key: 'sameFolderNameTemplateImage', template: '' })).preview!.output, 'Screenshot-optimised.png');
  assert.equal((await h.prefs({ action: 'template', key: 'convertedSameFolderNameTemplateVideo', template: '%f' })).preview!.output, 'Recording.mp4');
  assert.equal((await h.prefs({ action: 'template', key: 'sameFolderNameTemplateAudio', template: '%i-%f' })).preview!.output, '1-Voice memo.wav');
  assert.equal((await h.prefs({ action: 'template', key: 'sameFolderNameTemplateAudio', template: '%i-%f' })).preview!.output, '1-Voice memo.wav');
  assert.equal(win.normalize((await h.prefs({ action: 'template', key: 'specificFolderNameTemplatePDF', template: '%P/small/%f' })).preview!.output), 'C:\\Users\\You\\Pictures\\small\\Invoice.pdf');
  assert.equal((await h.prefs({ action: 'template', key: 'customNameTemplateForClipboardImages', template: 'Clip %y' })).preview!.output, `Clip ${new Date().getFullYear()}.png`);
  assert.equal(h.get().lastAutoIncrementingNumber, 0);
});

test('template previews are only for template settings and reasonable lengths', async () => {
  const h = harness();
  assert.equal(TEMPLATE_KEYS.length, 17);
  for (const key of ['workdir', 'editorAppImage', '__proto__', 7]) await assert.rejects(h.prefs({ action: 'template', key, template: '%f' }), /name template setting/, String(key));
  await assert.rejects(h.prefs({ action: 'template', key: 'sameFolderNameTemplateImage', template: 'x'.repeat(2000) }), /template up to/);
  await assert.rejects(h.prefs({ action: 'template', key: 'sameFolderNameTemplateImage', template: 5 }), /template up to/);
});

test('the pipeline editor and external links are validated, and links are fixed', async () => {
  const h = harness();
  await h.prefs({ action: 'pipeline-editor' });
  await h.prefs({ action: 'pipeline-editor', tab: 'zones' });
  assert.deepEqual(h.opened, [undefined, 'zones']);
  for (const tab of ['library', 3, null]) await assert.rejects(h.prefs({ action: 'pipeline-editor', tab }), /pipeline editor tab/, String(tab));
  await h.prefs({ action: 'open', target: 'releases' });
  assert.deepEqual(h.links, [LINKS.releases]);
  for (const target of ['https://evil.example', 'file:///C:/Windows', undefined]) await assert.rejects(h.prefs({ action: 'open', target }), /Choose a link/);
  assert.deepEqual((await h.prefs({ action: 'version' })).version, { name: '1.2.3', platform: 'win32' });
  assert.ok((await h.prefs({ action: 'meta' })).meta!.some(meta => meta.key === 'stripMetadata'));
});

test('anything that is not a known action is refused', async () => {
  const h = harness();
  for (const bad of [null, 'folder', [], { action: 'rm' }, {}]) await assert.rejects(h.prefs(bad), /settings action|Unknown/);
});
