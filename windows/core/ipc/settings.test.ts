import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultSettings, settingsSchema, type ClopSettings } from '../settings/schema';
import { parseSteps } from '../pipeline/parser';
import type { SettingsRequest } from './protocol';
import { SETTINGS_CHANGED } from './protocol';
import { formatSettingValue, handleSettingsRequest, matchSettings, MCP_WRITABLE, mcpRefusal, parseSettingValue, VISIBLE_KEYS, type SettingsAccess } from './settings';

function memoryStore(values: Partial<ClopSettings> = {}): SettingsAccess & { current: ClopSettings } {
  const store = {
    current: { ...defaultSettings(), ...values },
    get: () => store.current,
    async update<T>(change: (current: ClopSettings) => { patch?: unknown; result: T }) {
      const { patch, result } = change(store.current);
      if (patch !== undefined) store.current = { ...store.current, ...(patch as object) };
      return { settings: store.current, result };
    },
  };
  return store;
}

test('every value reads back as a string that writes back unchanged', () => {
  const settings = defaultSettings();
  for (const key of VISIBLE_KEYS) {
    const text = formatSettingValue(key, settings[key]), parsed = parseSettingValue(key, text, settings);
    assert.ok('value' in parsed, `${key}: ${'error' in parsed ? parsed.error : ''}`);
    assert.deepEqual(parsed.value, settings[key], key);
  }
});

test('values are parsed by type, with the words macOS accepts', () => {
  const s = defaultSettings();
  assert.deepEqual(parseSettingValue('stripMetadata', 'off', s), { value: false });
  assert.deepEqual(parseSettingValue('targetVideoFPS', '-2', s), { value: -2 }, 'half the source rate');
  assert.deepEqual(parseSettingValue('targetVideoFPS', '-4', s), { value: -4 });
  assert.match((parseSettingValue('targetVideoFPS', '-3', s) as { error: string }).error, /-2 or -4/);
  assert.match((parseSettingValue('stripMetadata', 'maybe', s) as { error: string }).error, /takes true or false/);
  assert.deepEqual(parseSettingValue('imageCompression', 'aggressive', s), { error: "imageCompression takes one of: adaptive, lossless, fast, smaller, custom, optionally followed by :factor. Got 'aggressive'" });
  assert.deepEqual(parseSettingValue('imageCompression', 'lossless', s), { value: { tier: 'lossless', factor: 30 } });
  assert.deepEqual(parseSettingValue('imageCompression', '70', s), { value: { tier: 'custom', factor: 70 } });
  assert.deepEqual(parseSettingValue('videoCompression', 'smaller:80', s), { value: { tier: 'smaller', factor: 80 } });
  assert.match((parseSettingValue('videoCompression', 'smaller:180', s) as { error: string }).error, /0 to 100/);
  assert.deepEqual(parseSettingValue('optimisedImageBehaviour', 'SameFolder', s), { value: 'sameFolder' });
  assert.deepEqual(parseSettingValue('workdirCleanupInterval', '3600', s), { value: 3600 });
  assert.deepEqual(parseSettingValue('formatsToConvertToJPEG', 'webp, heic', s), { value: ['webp', 'heic'] });
  assert.deepEqual(parseSettingValue('keyComboModifiers', 'Control, Hyper', s), { error: 'keyComboModifiers does not know Hyper. It takes any of: Control, Shift, Alt, Super' });
  assert.deepEqual(parseSettingValue('maxPhotosLength', '', s), { value: null });
  assert.match((parseSettingValue('batchModeFileCountThreshold', '-3', s) as { error: string }).error, /whole number from 0/);
  assert.equal(settingsSchema.savedCropSizes.type, 'object');
  assert.match((parseSettingValue('savedCropSizes', '{', s) as { error: string }).error, /takes JSON/);
});

test('a list with a comma in an item reads back as a JSON array that writes back unchanged', () => {
  const s = defaultSettings(), dirs = ['C:\\Photos, 2026', 'D:\\Shots'];
  const text = formatSettingValue('imageDirs', dirs);
  assert.equal(text, JSON.stringify(dirs));
  assert.deepEqual(parseSettingValue('imageDirs', text, s), { value: dirs });
  assert.equal(formatSettingValue('imageDirs', ['~/Desktop', '~/Downloads']), '~/Desktop, ~/Downloads', 'plain lists print as before');
  assert.deepEqual(parseSettingValue('imageDirs', '[not json, ~/a', s), { value: ['[not json', '~/a'] });
});

test('the schema narrows to the words asked for, best matches first', () => {
  assert.deepEqual(matchSettings('strip metadata').slice(0, 1), ['stripMetadata']);
  assert.ok(matchSettings('where optimised videos are saved').includes('optimisedVideoBehaviour'));
  assert.equal(matchSettings('').length, VISIBLE_KEYS.length);
  assert.ok(!VISIBLE_KEYS.includes('useClassicMenubarIcon'), 'settings Windows does not use are hidden');
});

test('get, set and schema answer like the macOS bridge', async () => {
  const store = memoryStore();
  const got = await handleSettingsRequest({ action: 'get', key: 'stripMetadata' }, store);
  assert.deepEqual(got.settings?.[0], { key: 'stripMetadata', type: 'bool', value: 'true', allowed: ['true', 'false'], title: 'stripMetadata', subtitle: settingsSchema.stripMetadata.description, keywords: [], pane: '', section: '', entryID: 'stripMetadata' });
  assert.deepEqual(await handleSettingsRequest({ action: 'get', key: 'nope' }, store), { ok: false, error: "no setting named 'nope'. Ask for the schema to see every key." });
  const set = await handleSettingsRequest({ action: 'set', key: 'videoCompression', value: 'smaller:70' }, store);
  assert.equal(set.ok, true);
  assert.deepEqual(store.current.videoCompression, { tier: 'smaller', factor: 70 });
  assert.equal(set.settings?.[0].value, 'smaller:70');
  assert.deepEqual(await handleSettingsRequest({ action: 'set', key: 'stripMetadata' }, store), { ok: false, error: 'set needs a key and a value' });
});

test('shortcut settings that cannot work are refused, so a command line or an agent cannot hijack typing or Task Manager', async () => {
  const store = memoryStore();
  assert.match((await handleSettingsRequest({ action: 'set', key: 'keyComboModifiers', value: 'Control' }, store)).error!, /Ctrl alone/);
  assert.match((await handleSettingsRequest({ action: 'set', key: 'keyComboModifiers', value: 'Shift' }, store)).error!, /Shift alone/);
  assert.match((await handleSettingsRequest({ action: 'set', key: 'enabledKeys', value: 'C,Escape' }, store)).error!, /Ctrl\+Shift\+Escape opens Task Manager/);
  assert.match((await handleSettingsRequest({ action: 'update', values: { quickResizeKeys: ['1', 'F5'] } }, store)).error!, /F5 cannot downscale/);
  assert.match((await handleSettingsRequest({ action: 'update', values: { enabledKeys: ['Escape'] } }, store)).error!, /Task Manager/);
  assert.deepEqual(store.current.keyComboModifiers, ['Control', 'Shift']);
  assert.equal((await handleSettingsRequest({ action: 'set', key: 'enabledKeys', value: 'C,Z,Backspace' }, store)).ok, true);
  assert.equal((await handleSettingsRequest({ action: 'set', key: 'keyComboModifiers', value: 'Control,Alt,Shift' }, store)).ok, true);
});

test('agents need the MCP switch to write, cannot flip the switches, and need permission for script steps', async () => {
  const store = memoryStore();
  assert.match((await handleSettingsRequest({ action: 'set', key: 'stripMetadata', value: 'false', origin: 'mcp' }, store)).error!, /not accepting changes from agents/);
  assert.equal((await handleSettingsRequest({ action: 'schema', query: 'strip', origin: 'mcp' }, store)).ok, true, 'reading needs no permission');
  store.current.mcpEnabled = true;
  assert.equal((await handleSettingsRequest({ action: 'set', key: 'stripMetadata', value: 'false', origin: 'mcp' }, store)).ok, true);
  assert.match((await handleSettingsRequest({ action: 'set', key: 'mcpAllowScriptSteps', value: 'true', origin: 'mcp' }, store)).error!, /only be changed by the user/);
  assert.match((await handleSettingsRequest({ action: 'update', values: { mcpEnabled: false }, origin: 'mcp' }, store)).error!, /only be changed by the user/);
  assert.match((await handleSettingsRequest({ action: 'gate', origin: 'mcp', pipeline: 'runScript(code: "rm x")' }, store)).error!, /script steps/);
  assert.equal(mcpRefusal(undefined, 'runScript(code: "x")', store.current), undefined, 'a person using the CLI needs no permission');
  store.current.mcpAllowScriptSteps = true;
  assert.equal((await handleSettingsRequest({ action: 'gate', origin: 'mcp', pipeline: 'runScript(code: "x")' }, store)).ok, true);
});

test('update writes stored values after checking every one', async () => {
  const store = memoryStore();
  assert.deepEqual(await handleSettingsRequest({ action: 'update', values: { stripMetadata: false, pdfDPI: 7 } }, store), { ok: false, error: 'pdfDPI does not accept that value.' });
  assert.equal(store.current.stripMetadata, true, 'nothing is written when one value is wrong');
  assert.deepEqual(await handleSettingsRequest({ action: 'update', values: { stripMetadata: false, pdfDPI: 150 } }, store), { ok: true });
  assert.equal(store.current.pdfDPI, 150);
  const read = await handleSettingsRequest({ action: 'read' }, store);
  assert.equal(read.values?.stripMetadata, false);
});

test('an update built on stale values is refused, so it cannot undo what was saved in between', async () => {
  const store = memoryStore();
  const read = (await handleSettingsRequest({ action: 'read' }, store)).values!;
  const base = { savedPipelines: read.savedPipelines };
  assert.deepEqual(await handleSettingsRequest({ action: 'update', values: { savedPipelines: [] }, base }, store), { ok: true }, 'values unchanged since the read are written');
  const stale = { savedPipelines: [{ id: 'elsewhere' }] };
  assert.deepEqual(await handleSettingsRequest({ action: 'update', values: { stripMetadata: false }, base: stale }, store), { ok: false, error: SETTINGS_CHANGED });
  assert.equal(store.current.stripMetadata, true, 'a refused update writes nothing');
});

test('agents write only the keys the macOS bridge lists, and never plant script steps through the library', async () => {
  const store = memoryStore({ mcpEnabled: true });
  const mcp = (req: Omit<SettingsRequest, 'origin'>) => handleSettingsRequest({ ...req, origin: 'mcp' }, store);
  assert.match((await mcp({ action: 'set', key: 'savedPipelines', value: '[]' })).error!, /cannot be changed by agents/);
  assert.match((await mcp({ action: 'set', key: 'lastAutoIncrementingNumber', value: '5' })).error!, /cannot be changed by agents/);
  assert.match((await mcp({ action: 'set', key: 'editorAppImage', value: 'C:\\evil.exe' })).error!, /names a program/);
  assert.equal((await mcp({ action: 'set', key: 'imageCompression', value: '70' })).ok, true);
  assert.equal(MCP_WRITABLE.has('mcpAllowScriptSteps'), false);

  const pipeline = (id: string, text: string) => ({ id, name: id, steps: parseSteps(text), skipOptimisation: true, hideResult: false });
  const userScript = pipeline('USER', 'runScript(code: "echo mine")');
  store.current.savedPipelines = [userScript];
  // The pipeline text the client sends along is not trusted; the payload is what counts.
  for (const text of ['runScript(code: "calc")', 'runShortcut(name: "evil")']) {
    const refused = await mcp({ action: 'update', values: { savedPipelines: [userScript, pipeline('NEW', text)] }, pipeline: 'optimise' });
    assert.match(refused.error!, /not accepting script steps from agents/, text);
  }
  assert.match((await mcp({ action: 'update', values: { pipelinesToRunOnImage: { clipboard: [{ id: 'REF', steps: [], skipOptimisation: false, hideResult: false, libraryID: 'USER' }] } } })).error!, /runScript step/, 'a reference to a script pipeline is a script');
  assert.match((await mcp({ action: 'update', values: { presetZones: [{ id: 'z-all', icon: 'x', name: 'z', pipeline: pipeline('Z', 'runShortcut(name: "x")') }] } })).error!, /runShortcut step/);
  assert.equal((await mcp({ action: 'update', values: { savedPipelines: [userScript, pipeline('SAFE', 'convert(to: webp)')] } })).ok, true, 'the user\'s own script pipeline does not block an agent\'s plain one');
  assert.match((await mcp({ action: 'update', values: { workdirCleanupInterval: 600 } })).error!, /cannot be changed by agents/);
  assert.match((await mcp({ action: 'gate', pipeline: 'runShortcut(name: "x")' })).error!, /runShortcut step/);
  store.current.mcpAllowScriptSteps = true;
  assert.equal((await mcp({ action: 'update', values: { savedPipelines: [userScript, pipeline('NEW', 'runScript(code: "calc")')] } })).ok, true);
  assert.equal((await mcp({ action: 'set', key: 'editorAppImage', value: 'C:\\editor.exe' })).ok, true);
});

test('agents may not point the working directory, a name template, a watched folder, an attachment or a pipeline step at a network share or a device', async () => {
  const store = memoryStore({ mcpEnabled: true, mcpAllowScriptSteps: true });
  const mcp = (req: Omit<SettingsRequest, 'origin'>) => handleSettingsRequest({ ...req, origin: 'mcp' }, store);
  const refused = /is on a network share or a device\. Agents may only use files and folders on this PC's own drives/;
  for (const [key, value] of [['workdir', '\\\\server\\share\\work'], ['specificFolderNameTemplateImage', '\\\\server\\share\\%f'], ['convertedSameFolderNameTemplateVideo', '//server/share/%f'], ['customNameTemplateForClipboardImages', '\\\\?\\UNC\\server\\share\\%f']]) {
    assert.match((await mcp({ action: 'set', key, value })).error!, refused, key);
    assert.match((await mcp({ action: 'update', values: { [key]: value } })).error!, refused, key);
  }
  const step = (text: string) => ({ id: 'P', name: 'P', steps: parseSteps(text), skipOptimisation: true, hideResult: false });
  for (const values of [
    { imageDirs: [...store.current.imageDirs, '\\\\server\\share'] },
    { pipelinesToRunOnImage: { '\\\\server\\share': [step('optimise()')] } },
    { pipelinesToRunOnImage: { clipboard: [step('copy(to: "\\\\\\\\server\\\\share\\\\")')] } },
    { savedPipelines: [step('watermark(image: "//server/share/logo.png")')] },
    { presetZones: [{ id: 'z-all', icon: 'x', name: 'z', pipeline: step('delete(path: "\\\\\\\\.\\\\C:\\\\x")') }] },
  ]) assert.match((await mcp({ action: 'update', values })).error!, refused, JSON.stringify(values));
  assert.equal((await mcp({ action: 'set', key: 'workdir', value: 'D:\\Clop work' })).ok, true, 'a drive path is fine');
  // A share the user set up stays: an agent's change to something else is not refused for it.
  store.current.imageDirs = ['\\\\nas\\photos'];
  store.current.savedPipelines = [step('copy(to: "\\\\\\\\nas\\\\backup\\\\")')];
  assert.equal((await mcp({ action: 'update', values: { imageDirs: ['\\\\nas\\photos', 'D:\\Pictures'], savedPipelines: [...store.current.savedPipelines, { ...step('convert(to: webp)'), id: 'Q', name: 'Q' }] } })).ok, true);
  // The user may use shares anywhere.
  assert.equal((await handleSettingsRequest({ action: 'set', key: 'workdir', value: '\\\\server\\share\\work' }, store)).ok, true);
});

/** An MCP-enabled store holding the user's own script pipeline, and an agent's `update`. */
function agentLibrary() {
  const store = memoryStore({ mcpEnabled: true });
  const userScript = { id: 'USER', name: 'Mine', steps: parseSteps('runScript(code: "echo mine")'), skipOptimisation: true, hideResult: false };
  store.current.savedPipelines = [userScript];
  const update = (values: Record<string, unknown>) => handleSettingsRequest({ action: 'update', values, origin: 'mcp' }, store);
  return { store, userScript, update };
}

test('the script gate judges a legacy preset zone by the runShortcut step it becomes', async () => {
  const { update } = agentLibrary();
  assert.match((await update({ presetZones: [{ id: 'old-all', icon: 'x', name: 'old', shortcut: { name: 'evil', identifier: 'evil' } }] })).error!, /runShortcut step/);
  assert.equal((await update({ presetZones: [{ id: 'old-all', icon: 'x', name: 'old' }] })).ok, true, 'a zone with neither stays a plain zone');
});

test('the script gate judges a pipeline sent as an escaped JSON string by its decoded steps', async () => {
  const { update } = agentLibrary();
  const escaped = '{"id":"ESC","steps":[{"run\\u0053cript":{"code":"calc"}}],"skipOptimisation":true,"hideResult":false}';
  assert.equal(JSON.parse(escaped).steps[0].runScript.code, 'calc');
  assert.match((await update({ savedPipelines: [escaped] })).error!, /runScript step/);
  assert.match((await update({ pipelinesToRunOnImage: { clipboard: [escaped] } })).error!, /runScript step/, 'clipboard pipelines run on the next copy');
  assert.match((await update({ presetZones: [{ id: 'z', icon: 'x', name: 'z', pipeline: escaped }] })).error!, /runScript step/);
});

test('the script gate counts a script pipeline or reference moved to another source as new', async () => {
  const { store, userScript, update } = agentLibrary();
  const copy = { ...userScript, id: 'COPY' }, reference = { id: 'REF', steps: [], skipOptimisation: false, hideResult: false, libraryID: 'USER' };
  store.current.pipelinesToRunOnImage = { '~/Mine': [copy, reference] };
  assert.match((await update({ pipelinesToRunOnImage: { '~/Mine': [copy, reference], clipboard: [copy] } })).error!, /runScript step/);
  assert.match((await update({ pipelinesToRunOnImage: { '~/Mine': [], clipboard: [reference] } })).error!, /runScript step/);
  assert.match((await update({ pipelinesToRunOnVideo: { '~/Mine': [copy] } })).error!, /runScript step/, 'another file type is another place');
  assert.equal((await update({ pipelinesToRunOnImage: { '~/Mine': [copy, reference], '~/Other': [] } })).ok, true, 'leaving them where the user put them is fine');
  assert.equal((await update({ pipelinesToRunOnImage: { '~/Mine': [copy] } })).ok, true, 'taking an attachment away is fine');
});

test('the script gate follows references to the pipeline the app will run', async () => {
  const { store, userScript, update } = agentLibrary();
  const plain = { id: 'USER', name: 'Plain', steps: parseSteps('convert(to: webp)'), skipOptimisation: false, hideResult: false };
  const reference = { id: 'REF', steps: [], skipOptimisation: false, hideResult: false, libraryID: 'USER' };
  // Two saved pipelines share an id: a reference runs the first one.
  store.current.savedPipelines = [plain, userScript];
  assert.match((await update({ pipelinesToRunOnImage: { clipboard: [reference] } })).error!, /runScript step/, 'any pipeline a new reference may reach');
  store.current.pipelinesToRunOnImage = { clipboard: [reference] };
  assert.match((await update({ savedPipelines: [userScript, plain] })).error!, /runScript step/, 'reordering the library to point a reference at a script');
  assert.equal((await update({ savedPipelines: [plain] })).ok, true);
});

test('agents may not add pipelines Clop cannot read, but keep the ones already stored', async () => {
  const { store, update } = agentLibrary();
  const future = { id: 'NEW', steps: [{ launchMissiles: {} }], skipOptimisation: true, hideResult: false };
  assert.match((await update({ savedPipelines: [future] })).error!, /cannot read/);
  store.current.savedPipelines = settingsSchema.savedPipelines.parse([future])!;
  assert.equal((await update({ savedPipelines: [future, { id: 'SAFE', steps: parseSteps('convert(to: webp)'), skipOptimisation: false, hideResult: false }] })).ok, true);
});

test('the script gate treats opening a program by path as a script step, and lets app names through', async () => {
  const { store, update } = agentLibrary();
  const pipeline = (id: string, text: string) => ({ id, name: id, steps: parseSteps(text), skipOptimisation: false, hideResult: false });
  for (const app of ['C:\\\\evil.exe', 'C:/evil.exe', '\\\\\\\\server\\\\share\\\\evil.exe', '..\\\\evil', 'tools\\\\evil.cmd', 'C:evil.exe', '\\"C:\\\\evil.exe\\"']) {
    const text = `openWith(app: "${app}")`;
    assert.match((await update({ savedPipelines: [pipeline('NEW', text)] })).error!, /openWith step that names a program by path/, text);
  }
  // Where the app will read the pipeline from does not matter: attached to the clipboard, a preset zone, or a stored reference.
  const open = pipeline('OPEN', 'openWith(app: "C:\\\\evil.exe")');
  assert.match((await update({ pipelinesToRunOnImage: { clipboard: [open] } })).error!, /openWith step/);
  assert.match((await update({ presetZones: [{ id: 'z', icon: 'x', name: 'z', pipeline: open }] })).error!, /openWith step/);
  const reference = { id: 'REF', steps: [], skipOptimisation: false, hideResult: false, libraryID: 'OPEN' };
  store.current.savedPipelines = [open];
  assert.match((await update({ pipelinesToRunOnImage: { clipboard: [reference] } })).error!, /openWith step/, 'a reference to a pipeline that opens a program by path');
  // shelveWith and uploadWith are checked by the app they name, but a path stored in one is the same program.
  for (const kind of ['shelveWith', 'uploadWith']) {
    const stored = JSON.stringify({ id: kind, steps: [{ [kind]: { app: 'C:\\evil.exe' } }], skipOptimisation: false, hideResult: false });
    assert.match((await update({ savedPipelines: [stored] })).error!, new RegExp(`${kind} step that names a program by path`), kind);
  }
  // An app by name is what Windows resolves from its Start menu, running apps and App Paths: no permission needed.
  store.current.savedPipelines = [];
  for (const text of ['openWith(app: "Paint")', 'openWith(app: Photoshop)', 'openWith(app: "notepad.exe")', 'openWith(app: "Microsoft.Paint_8wekyb3d8bbwe!App")', 'shelveWith(app: yoink)', 'uploadWith(app: dropshare)']) {
    assert.equal((await update({ savedPipelines: [pipeline('OK', text)] })).ok, true, text);
  }
  // The user's own pipelines already stored are not judged, and the permission opens it all.
  store.current.savedPipelines = [open];
  assert.equal((await update({ savedPipelines: [open, pipeline('PLAIN', 'convert(to: webp)')] })).ok, true);
  store.current.savedPipelines = [];
  store.current.mcpAllowScriptSteps = true;
  assert.equal((await update({ savedPipelines: [open] })).ok, true);
});

test('the MCP gate refuses pipeline text that opens a program by path, whether or not it parses', () => {
  const settings = { mcpEnabled: true, mcpAllowScriptSteps: false };
  for (const text of ['openWith(app: "C:\\\\evil.exe")', 'openWith(app: C:\\\\evil.exe) -> convert(to: webp)', 'optimise -> shelveWith(app: "C:\\\\x.exe")', 'uploadWith(app: "\\\\\\\\server\\\\x.exe")',
    'openWith(app: "C:\\\\evil.exe"', 'openWith(app "C:\\\\evil.exe")', 'convert(to: webp)\nopenWith(app: "..\\\\evil.exe")']) {
    assert.match(mcpRefusal('mcp', text, settings)!, /names a program by path/, text);
  }
  for (const text of ['openWith(app: "Paint")', 'openWith(app: Paint) -> convert(to: webp)', 'optimise', 'my saved pipeline', 'shelveWith(app: yoink)']) assert.equal(mcpRefusal('mcp', text, settings), undefined, text);
  assert.equal(mcpRefusal('mcp', 'openWith(app: "C:\\\\evil.exe")', { ...settings, mcpAllowScriptSteps: true }), undefined, 'allowed script steps allow it');
  assert.equal(mcpRefusal(undefined, 'openWith(app: "C:\\\\evil.exe")', settings), undefined, 'a person using the CLI needs no permission');
});

test('an agent edit built on a stale read is refused as stale, never as a planted script step', async () => {
  const { store, userScript } = agentLibrary();
  const stale = [userScript];
  // The user edits their own script pipeline between the agent's read and its write.
  const edited = { ...userScript, name: 'Mine, renamed' };
  store.current.savedPipelines = [edited];
  const added = { id: 'X', name: 'X', steps: parseSteps('convert(to: webp)'), skipOptimisation: false, hideResult: false };
  const reply = await handleSettingsRequest({ action: 'update', values: { savedPipelines: [...stale, added] }, base: { savedPipelines: stale }, origin: 'mcp' }, store);
  assert.deepEqual(reply, { ok: false, error: SETTINGS_CHANGED });
  // Built again on the current settings, the same edit goes through.
  assert.equal((await handleSettingsRequest({ action: 'update', values: { savedPipelines: [edited, added] }, base: { savedPipelines: [edited] }, origin: 'mcp' }, store)).ok, true);
});
