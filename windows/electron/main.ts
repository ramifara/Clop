import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ItemEngine, message } from './items';
import { clipboardPNG } from '../core/media/image-codecs';
import { imageDefaults, rendererSettings } from './settings';
import { defaultSettings } from '../core/settings/schema';
import { SettingsStore } from '../core/settings/store';
import { Workdir } from '../core/workdir';
import { expandTemplate, type Counter } from '../core/template';
import { WindowsBridge } from './native';
import { ClipboardPickup, type ClipboardChange } from './pickup';
import { ClipboardIntake, importClipboardImages, importClipboardList, type ClipboardListSteps, replacedClipboardImages, serial, clipboardChange, clipboardIntake, copyReply, DEFAULT_NAME_TEMPLATE, mediaKind, sequenceReply, type ClipboardMemory } from './clipboard';
import { OptimisedMarker } from '../core/marker';
import { FolderWatcher } from './watcher';
import { enabledKey, placeholderReply } from './watch-rules';
import { FolderResults, LastBatch, restoreAll } from './automation';
import { appsReply } from './apps';
import type { AppState, ImageOptions, ItemResult } from '../src/types';

const here = path.dirname(fileURLToPath(import.meta.url));
let main: BrowserWindow, floating: BrowserWindow, tray: Tray, engine: ItemEngine;
let settings = defaultSettings(), notice: string | undefined, quitting = false, bridgeReady = false;
let store: SettingsStore, workdir: Workdir, stopCleaner: (() => void) | undefined, workdirProblem: string | undefined;
let dropActive = false, dragging = false, importsRunning = 0, hovered = false;
const hidden = new Set<string>();
const hideTimers = new Map<string, NodeJS.Timeout>();
let clipboardTimer: NodeJS.Timeout | undefined;
const memory: ClipboardMemory = { fingerprint: '', own: '' };
let nameCounter: Counter | undefined;
/** Clipboard images take turns, each optimised and written back before the next one replaces its card. Images share one engine queue anyway. */
const clipboardImageTurn = serial();
let marker: OptimisedMarker, folders: FolderResults, watchers: FolderWatcher[] = [];
/** Results from watched folders in `dirsHideFloatingResult`; they never show as floating results. */
const quiet = new Set<string>();
/** Results that hid or were dismissed, latest last, for "Bring back last result". */
const removedOrder: string[] = [];
/** Remembers a result that hid or was dismissed; only the latest few can be brought back. */
function removed(id: string) { removedOrder.push(id); removedOrder.splice(0, removedOrder.length - 80); }
const lastBatch = new LastBatch();
const paused = () => settings.pauseAutomaticOptimisations;
const intake = new ClipboardIntake(error => inform(message(error)));
const pickup = new ClipboardPickup(change => { void optimiseClipboard(change); });
let clipboardWrites: Promise<void> = Promise.resolve();
const bridge = new WindowsBridge();
const devUrl = process.env.CLOP_DEV_URL;
const fingerprint = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Files are recognised by path, size and modification time: hashing a large video's bytes on every copy would take too long. */
const filesFingerprint = async (files: string[]) => fingerprint(Buffer.from(JSON.stringify(await Promise.all(files.map(async file => {
  const info = await stat(file).catch(error => { throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`${path.basename(file)} no longer exists.`) : error; });
  return [file, info.size, info.mtimeMs];
})))));
const defaults = (aggressive = false): ImageOptions => ({ ...imageDefaults(settings), ...(aggressive ? { mode: 'aggressive' } : {}) });
const isFile = (file: string) => stat(file).then(info => info.isFile(), () => false);
const currentSequence = async () => bridgeReady ? sequenceReply(await bridge.request({ type: 'sequence' })) : undefined;
/** Whether a result is still in the shelf and finished; a card can be dismissed while its import runs. */
const isReady = (id: string) => { try { return engine.get(id).result.status === 'ready'; } catch { return false; } };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const state = (): AppState => ({ items: engine.list().filter(item => !hidden.has(item.id) && !quiet.has(item.id)), settings, native: true, platform: process.platform, dropActive, notice });
function broadcast() { for (const window of [main, floating]) if (window && !window.isDestroyed()) window.webContents.send('clop:state', state()); }
function inform(text: string) { notice = text; syncFloating(); broadcast(); }
function positionFloating() {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const [w, h] = floating.getSize();
  floating.setPosition(settings.floatingResultsCorner.endsWith('Right') ? area.x + area.width - w : area.x,
    settings.floatingResultsCorner.startsWith('bottom') ? area.y + area.height - h : area.y);
}
function showFloating(focus = false, reposition = false) {
  if (reposition && !floating.isVisible()) positionFloating();
  if (focus) floating.show(); else floating.showInactive();
}
function syncFloating() {
  if (!floating || floating.isDestroyed()) return;
  const target = dropActive || settings.keepDropZoneVisible;
  const count = Math.min(target ? 2 : 3, state().items.length);
  const height = count * 166 + Math.max(0, count - 1) * 4 + (target ? 160 : 0) + (count > 1 ? 28 : 0) + (notice ? 85 : 0) + 40;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  floating.setSize(236, Math.min(height, area.height));
  positionFloating();
  if (count || target || notice || importsRunning) showFloating(); else floating.hide();
}
function showLatest() {
  for (const item of engine.list().slice(0, 3)) hidden.delete(item.id);
  dropActive = !engine.list().length;
  syncFloating(); broadcast();
}
function scheduleHide(id: string) {
  const existing = hideTimers.get(id); if (existing) clearTimeout(existing);
  const check = () => {
    if (hovered || dragging) { hideTimers.set(id, setTimeout(check, 1000)); return; }
    hidden.add(id); hideTimers.delete(id); removed(id); syncFloating(); broadcast();
  };
  hideTimers.set(id, setTimeout(check, engine.get(id).result.source === 'clipboard' ? 10000 : 30000));
}
async function dismiss(id: string) {
  const timer = hideTimers.get(id); if (timer) clearTimeout(timer);
  hideTimers.delete(id); hidden.delete(id); await engine.dismiss(id);
  if (!quiet.delete(id)) removed(id);
}
/** "Bring back last result": the result that hid or was dismissed last shows again. */
function bringBackLast() {
  while (removedOrder.length) {
    const id = removedOrder.pop()!;
    if ((hidden.has(id) && engine.has(id)) || engine.bringBack(id)) { hidden.delete(id); scheduleHide(id); syncFloating(); broadcast(); return; }
  }
  inform('There is no result to bring back.');
}
/** "Revert last optimisations": the latest batch of results gets its originals back, over the files of watched folders too. */
async function revertLast() {
  const ids = lastBatch.take().filter(id => engine.has(id));
  if (!ids.length) { inform('There are no recent optimisations to revert.'); return; }
  // Each result on its own: one the user edited, moved or deleted since stays as it is, and the rest are still restored.
  const { restored, failures } = await restoreAll(engine, ids);
  const clipboardIds = restored.filter(id => engine.has(id) && engine.get(id).result.source === 'clipboard');
  if (clipboardIds.length) await copyClipboardResults(clipboardIds);
  if (failures.length) inform(failures.join('\n'));
}
async function makeRoom() {
  const oldest = engine.list().at(-1);
  if (engine.list().length >= 40 && oldest) await dismiss(oldest.id);
}
/** Downloads and optimises a link. A copied link passes the clipboard sequence it was read at, so its result never overwrites a later copy. */
async function importUrl(value: unknown, aggressive = false, source: ItemResult['source'] = 'drop', expectedSequence?: number) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Drop an HTTP or HTTPS link.');
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Drop an HTTP or HTTPS link.');
  importsRunning++; dropActive = false;
  try {
    const sequence = expectedSequence ?? await currentSequence();
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Could not download this link. Copy the file instead.');
    if (Number(response.headers.get('content-length')) > 128 * 1024 * 1024) throw new Error('Use a file smaller than 128 MB.');
    const chunks: Buffer[] = []; let length = 0;
    if (!response.body) throw new Error('This link returned nothing to optimise.');
    const reader = response.body.getReader();
    try {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > 128 * 1024 * 1024) throw new Error('Use a file smaller than 128 MB.'); chunks.push(Buffer.from(chunk.value)); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    await makeRoom();
    let name = path.basename(url.pathname);
    try { name = decodeURIComponent(name); } catch {}
    const id = await engine.importBuffer(Buffer.concat(chunks), name || 'Download', source, defaults(aggressive));
    if (isReady(id)) await (source === 'clipboard' ? copyClipboardResults([id], sequence) : settings.autoCopyToClipboard ? copy([id], sequence) : undefined);
  } finally { importsRunning--; syncFloating(); broadcast(); }
}
function configure(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
}
async function createWindows() {
  const webPreferences = { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true };
  main = new BrowserWindow({ width: 390, height: 500, resizable: false, show: false, backgroundColor: '#f3f1ef', title: 'Clop settings', autoHideMenuBar: true, webPreferences });
  floating = new BrowserWindow({ width: 236, height: 206, frame: false, resizable: false, transparent: true, show: false, skipTaskbar: true, alwaysOnTop: settings.floatingResultsAlwaysOnTop, backgroundColor: '#00000000', webPreferences });
  configure(main); configure(floating);
  if (devUrl) { await main.loadURL(`${devUrl}/?preferences=1`); await floating.loadURL(`${devUrl}/?floating=1`); }
  else { await main.loadFile(path.join(here, '../dist/index.html'), { query: { preferences: '1' } }); await floating.loadFile(path.join(here, '../dist/index.html'), { query: { floating: '1' } }); }
  positionFloating();
  floating.setIgnoreMouseEvents(true, { forward: true });
  if (settings.keepDropZoneVisible) { syncFloating(); floating.setIgnoreMouseEvents(false); }
}
/**
 * Puts results on the clipboard. One image goes on as image data, with its file unless `copyImageFilePath` is off. Other
 * results, and several at once, go on as a file list, with the last image's data when all are images. `text` also puts
 * the paths on as text, for results of a copied path.
 */
async function copy(ids: string[], expectedSequence?: number, { text = false } = {}) {
  const files = ids.map(id => engine.output(id)), last = engine.get(ids[ids.length - 1]);
  const images = ids.every(id => engine.get(id).result.kind === 'image');
  const withFiles = !images || ids.length > 1 || settings.copyImageFilePath;
  if (process.platform === 'win32') {
    // Processing can finish before the previous Windows clipboard write has flushed.
    // Snapshot the immutable outputs, then serialize encoding and native writes in action order.
    const write = async () => {
      if (!bridgeReady) throw new Error('The Windows clipboard helper is unavailable. Save or drag the result instead.');
      const png = images ? path.join(last.directory, `clipboard-${randomUUID()}.png`) : undefined;
      try {
        if (png) await clipboardPNG(files[files.length - 1], png, { limitInputPixels: 60_000_000 });
        const reply = copyReply(await bridge.request({ type: 'copy', ...(withFiles ? { files } : {}), ...(png ? { png } : {}), ...(text ? { text: files.join('\r\n') } : {}), ...(expectedSequence === undefined ? {} : { expectedSequence }) }));
        if (!reply.skipped) { memory.sequence = reply.sequence; if (png) memory.own = fingerprint(await readFile(png)); }
      } finally { if (png) await rm(png, { force: true }); }
    };
    const job = clipboardWrites.then(write, write);
    clipboardWrites = job.catch(() => {});
    await job;
  } else {
    if (!images) throw new Error('Copying files needs the Windows clipboard helper. Save the result instead.');
    const image = nativeImage.createFromPath(files[files.length - 1]);
    if (image.isEmpty()) throw new Error('This format cannot be copied as an image here. Save the result instead.');
    const png = image.toPNG();
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
    const items = await clipboard.read(), item = items.find(item => item.types.includes('image/png'));
    memory.own = fingerprint(item ? Buffer.from(await (await item.getType('image/png')).arrayBuffer()) : png);
  }
}
/** Imports local files one by one, telling about each that fails. Returns the results that finished. */
async function importPaths(files: unknown, source: ItemResult['source'], { aggressive = false, name }: { aggressive?: boolean; name?: (file: string) => Promise<string | undefined> } = {}) {
  if (!Array.isArray(files) || files.length > 20 || files.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Choose up to 20 local files at a time.');
  dropActive = false; importsRunning++; broadcast();
  const completed: string[] = [];
  try {
    for (const file of files as string[]) {
      try {
        await makeRoom();
        const id = await engine.importPath(file, source, defaults(aggressive), await name?.(file));
        if (isReady(id)) completed.push(id);
      } catch (error) { inform(`${path.basename(file)}: ${message(error)}`); }
    }
  } finally { importsRunning--; syncFloating(); broadcast(); }
  return completed;
}
/** Dropped and opened files; their results go on the clipboard with `autoCopyToClipboard`. */
async function importFiles(files: unknown, source: ItemResult['source'], aggressive = false) {
  const sequence = await currentSequence();
  const ids = await importPaths(files, source, { aggressive });
  if (settings.autoCopyToClipboard && ids.length) await copy(ids, sequence);
}
/**
 * The name for a clipboard image: `customNameTemplateForClipboardImages` (or the macOS default template) when
 * `useCustomNameTemplateForClipboardImages` and `copyImageFilePath` are on, as ImagePipeline.swift names it. `%i` advances `lastAutoIncrementingNumber`.
 */
async function clipboardImageName(original: string) {
  if (!settings.copyImageFilePath || !settings.useCustomNameTemplateForClipboardImages) return original;
  // One counter for the session: clipboard imports run concurrently, and each must take the next number. It is read from
  // `lastAutoIncrementingNumber` once; later edits to that setting while Clop runs are overwritten by the next name.
  const counter = nameCounter ??= { value: settings.lastAutoIncrementingNumber }, before = counter.value;
  const name = expandTemplate(settings.customNameTemplateForClipboardImages || DEFAULT_NAME_TEMPLATE, { counter }) + path.extname(original);
  if (counter.value !== before) settings = await store.set({ lastAutoIncrementingNumber: counter.value });
  return name;
}
/** Earlier clipboard images make way for a new one (see `replacedClipboardImages`). */
async function prepareClipboardImages() {
  for (const id of replacedClipboardImages(engine.list(), settings)) await dismiss(id);
}
/** Clipboard results always go back on the clipboard; consecutive clipboard images together with `copyConsecutiveClipboardImages`. */
async function copyClipboardResults(ids: string[], sequence?: number, options?: { text?: boolean }) {
  ids = ids.filter(isReady);
  if (!ids.length) return;
  const images = ids.every(id => engine.get(id).result.kind === 'image');
  const accumulated = images && settings.appendClipboardResults && settings.copyConsecutiveClipboardImages
    ? engine.list().filter(item => item.source === 'clipboard' && item.kind === 'image' && item.status === 'ready').map(item => item.id).reverse() : [];
  await copy(accumulated.length > 1 ? accumulated : ids, sequence, options);
}
/** The steps of importing clipboard results (see `importClipboardList`), written back against the clipboard `sequence` they came from. */
function clipboardSteps(sequence: number | undefined, aggressive: boolean, options?: { text?: boolean }): ClipboardListSteps {
  return {
    turn: clipboardImageTurn, prepare: prepareClipboardImages, writeBack: ids => copyClipboardResults(ids, sequence, options),
    load: list => importPaths(list, 'clipboard', { aggressive, name: async file => mediaKind(file) === 'image' ? clipboardImageName(path.basename(file)) : undefined }),
  };
}
function importClipboardFiles(files: string[], sequence: number | undefined, aggressive: boolean, options?: { text?: boolean }) {
  return importClipboardList(files.slice(0, 20), clipboardSteps(sequence, aggressive, options));
}
function importClipboardImage(bytes: Buffer, name: string, sequence: number | undefined, aggressive: boolean) {
  return importClipboardImages(clipboardSteps(sequence, aggressive), async () => {
    await makeRoom();
    const id = await engine.importBuffer(bytes, await clipboardImageName(name), 'clipboard', defaults(aggressive));
    return isReady(id) ? [id] : [];
  });
}
async function readClipboardImage() {
  // Prefer an encoded PNG clipboard payload, avoiding an unnecessary bitmap round trip.
  for (const item of await clipboard.read()) {
    const type = item.types.find(type => type === 'image/png' || type === 'electron application/osclipboard;format="PNG"') ?? item.types.find(type => type.startsWith('image/'));
    if (type) { const blob = await item.getType(type); if ('arrayBuffer' in blob) return Buffer.from(await blob.arrayBuffer()); }
  }
  return Buffer.alloc(0);
}
/**
 * Optimises what is on the clipboard (see `clipboardIntake`). Reads run one at a time; the import each starts runs on its
 * own, so a long encode never holds up the next copy, and no copy or manual request is dropped.
 */
function optimiseClipboard(change?: ClipboardChange, manual = false, aggressive = false): Promise<void> {
  if (!manual && (!settings.enableClipboardOptimiser || paused())) return Promise.resolve();
  return intake.submit(async () => {
    const plan = await clipboardIntake(change, manual, memory, {
      settings, owns: file => workdir.owns(file), image: readClipboardImage, text: () => clipboard.readText(), isFile, fingerprint: filesFingerprint, hash: fingerprint,
      read: async () => {
        if (!bridgeReady) return;
        const snapshot = clipboardChange(await bridge.request({ type: 'read' }));
        if (!snapshot) throw new Error('The Windows helper sent an unreadable clipboard snapshot.');
        return snapshot;
      },
    });
    switch (plan.type) {
      case 'retry': void optimiseClipboard(plan.change, false, aggressive); return;
      case 'none': if (plan.notice) inform(plan.notice); return;
      case 'files': return () => importClipboardFiles(plan.files, plan.sequence, aggressive, { text: plan.text });
      case 'image': return () => importClipboardImage(plan.bytes, `Clipboard-${stamp()}.${plan.ext}`, plan.sequence, aggressive);
      case 'url': return () => importUrl(plan.url, aggressive, 'clipboard', plan.sequence);
    }
  });
}
function startClipboardFallback() {
  if (clipboardTimer) return;
  let polling = false;
  clipboardTimer = setInterval(() => { if (settings.enableClipboardOptimiser && !polling) { polling = true; void optimiseClipboard().finally(() => { polling = false; }); } }, 900);
  clipboardTimer.unref();
}
function updateTray() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show latest results', click: showLatest },
    { label: 'Optimise clipboard', accelerator: 'Control+Shift+C', click: () => { void optimiseClipboard(undefined, true); } },
    { type: 'separator' },
    { label: 'Watch clipboard', type: 'checkbox', checked: settings.enableClipboardOptimiser, click: item => toggleSetting({ enableClipboardOptimiser: item.checked }) },
    { label: 'Keep drop zone visible', type: 'checkbox', checked: settings.keepDropZoneVisible, click: item => toggleSetting({ keepDropZoneVisible: item.checked }) },
    { label: 'Pause automatic optimisations', type: 'checkbox', checked: settings.pauseAutomaticOptimisations, click: item => toggleSetting({ pauseAutomaticOptimisations: item.checked }) },
    { type: 'separator' },
    { label: 'Revert last optimisations', click: () => { revertLast().catch(error => inform(message(error))); } },
    { label: 'Bring back last result', click: bringBackLast },
    { label: 'Stop all', click: () => engine.stop() },
    { type: 'separator' },
    { label: 'Settings…', click: () => main.show() },
    { label: 'Open originals and results', click: () => { void shell.openPath(workdir.temp); } },
    { type: 'separator' }, { label: 'Quit Clop', click: () => app.quit() },
  ]));
}
// A failed tray toggle rebuilds the menu so its checkbox shows the setting that is actually in effect.
function toggleSetting(value: unknown) { updateSettings(value).catch(error => { updateTray(); inform(message(error)); }); }
async function updateSettings(value: unknown) {
  settings = await store.set(value);
  if (!settings.enableClipboardOptimiser || paused()) pickup.cancel();
  floating.setAlwaysOnTop(settings.floatingResultsAlwaysOnTop);
  syncFloating();
  if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath, args: ['--hidden'] });
  if (bridgeReady) await bridge.request(nativeSettings());
  updateTray(); broadcast();
}
function nativeSettings() {
  return { type: 'settings', explorerDrag: settings.enableDragAndDrop, ownWindows: [main, floating].map(window => Number(window.getNativeWindowHandle().readBigUInt64LE())) };
}
/** Card actions put a clipboard result back on the clipboard, and others with `autoCopyToClipboard`. */
function copiesBack(id: string) { const { result } = engine.get(id); return result.status === 'ready' && (result.source === 'clipboard' || (settings.autoCopyToClipboard && result.source !== 'folder')); }
function trusted(sender: Electron.WebContents) { return [main, floating].some(window => window && !window.isDestroyed() && window.webContents === sender); }
ipcMain.handle('clop:action', async (event, action: string, ...args: unknown[]) => {
  if (!trusted(event.sender)) throw new Error('Untrusted window.');
  const id = args[0] as string;
  switch (action) {
    case 'state': return state();
    case 'import': await importFiles(args[0], 'drop', args[1] === true); break;
    case 'import-url': await importUrl(args[0], args[1] === true); break;
    case 'clipboard': await optimiseClipboard(undefined, true); break;
    case 'apply': await engine.apply(id, args[1] as ImageOptions); if (copiesBack(id)) await copy([id]); break;
    case 'restore': await engine.restore(id); if (copiesBack(id)) await copy([id]); break;
    case 'copy': await copy([id]); break;
    case 'save': {
      const entry = engine.get(id), file = engine.output(id);
      const name = `${path.parse(entry.result.name).name}-clop.${entry.result.format === 'jpeg' ? 'jpg' : entry.result.format}`;
      const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender)!, { defaultPath: name });
      if (result.filePath && !result.canceled) await copyFile(file, result.filePath); break;
    }
    case 'reveal': shell.showItemInFolder(engine.output(id)); break;
    case 'dismiss': await dismiss(id); break;
    case 'settings': await updateSettings(rendererSettings(args[0])); break;
    case 'apps': return bridgeReady ? appsReply(await bridge.request({ type: 'apps' })) : [];
    case 'window':
      switch (args[0]) {
        case 'hide': BrowserWindow.fromWebContents(event.sender)?.hide(); break;
        case 'minimize': BrowserWindow.fromWebContents(event.sender)?.minimize(); break;
        case 'main': main.show(); break;
        case 'float': showLatest(); break;
        case 'interactive': hovered = true; floating.setIgnoreMouseEvents(false); break;
        case 'passthrough': hovered = false; if (!dropActive) floating.setIgnoreMouseEvents(true, { forward: true }); break;
        case 'dismiss-notice': notice = undefined; syncFloating(); broadcast(); break;
        case 'quit': app.quit(); break;
        default: throw new Error('Unknown window action.');
      } break;
    default: throw new Error('Unknown Clop action.');
  }
});
ipcMain.on('clop:drag', (event, id: string) => {
  if (!trusted(event.sender)) return;
  try { const file = engine.output(id); event.sender.startDrag({ file, icon: nativeImage.createFromDataURL(engine.get(id).result.preview).resize({ width: 96 }) }); }
  catch (error) { inform(message(error)); }
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => { if (engine) showLatest(); const files = argv.filter(arg => path.isAbsolute(arg) && mediaKind(arg)); if (files.length) void importFiles(files, 'file').catch(error => inform(message(error))); });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const userData = app.getPath('userData');
    store = new SettingsStore(path.join(userData, 'settings.json'), { home: app.getPath('home'), desktop: app.getPath('desktop'), userData });
    // Watching guards against apps that rewrite many files in its first seconds on the first launch.
    const firstLaunch = !await stat(store.file).then(() => true, () => false);
    // An unreadable settings file is left alone; the defaults are used and the reason is shown once the windows exist.
    let settingsError: unknown;
    settings = await store.load().catch(error => { settingsError = error; return store.get(); });
    // Earlier versions kept originals in `images`. It ages out with the cleanup interval instead of being migrated.
    const open = async (root: string) => new Workdir(root, { home: app.getPath('home'), legacy: [path.join(userData, 'images')] }).ensure();
    workdir = await open(settings.workdir).catch(async error => {
      workdirProblem = `Clop cannot use the working directory ${settings.workdir}: ${message(error)} Using the default folder instead.`;
      return open(path.join(userData, 'work'));
    });
    // The running session's files stay until the next start, however short the cleanup interval is.
    const session = path.join(workdir.temp, `session-${Date.now()}`);
    workdir.protect(session);
    stopCleaner = workdir.startCleaner(() => store.get('workdirCleanupInterval'));
    engine = new ItemEngine(session, () => settings);
    engine.on('change', () => { syncFloating(); broadcast(); });
    engine.on('ready', (id: string) => { if (quiet.has(id)) return; hidden.delete(id); scheduleHide(id); syncFloating(); broadcast(); });
    engine.on('add', (id: string) => lastBatch.add(id));
    await createWindows();
    if (settingsError) inform(message(settingsError));
    if (workdirProblem) inform(workdirProblem);
    marker = new OptimisedMarker(path.join(userData, 'optimised.json'));
    const home = app.getPath('home');
    folders = new FolderResults({
      engine, settings: () => settings, home, options: () => defaults(), makeRoom,
      // The shelf holds at most 40 results, so a quiet result older than the latest few is long gone.
      quiet: id => { quiet.add(id); for (const old of quiet) { if (quiet.size <= 80) break; quiet.delete(old); } },
      env: () => ({ settings, workdir, marker, home, counter: nameCounter ??= { value: settings.lastAutoIncrementingNumber } }),
      saved: value => { store.set({ lastAutoIncrementingNumber: value }).catch(error => inform(message(error))); },
    });
    watchers = (['image', 'video', 'pdf', 'audio'] as const).map(kind => new FolderWatcher(kind, {
      // The stream hint moves with a renamed file, which the cache keyed by path cannot follow; it counts while the size is unchanged.
      settings: () => settings, home, firstLaunch, owns: file => workdir.owns(file), isOptimised: async file => await marker.isOptimised(file) || await marker.hintMatches(file),
      isLocal: async file => !bridgeReady || !placeholderReply(await bridge.request({ type: 'attributes', paths: [file] }), 1)[0],
      handle: (file, dir) => folders.optimise(file, kind, dir), cancel: files => folders.cancel(files), notice: inform,
      disable: () => toggleSetting({ [enabledKey(kind)]: false }),
    }));
    store.on('change', next => { settings = next; for (const watcher of watchers) void watcher.update(); });
    for (const watcher of watchers) void watcher.update();
    const icon = nativeImage.createFromPath(path.join(here, 'icon.png'));
    tray = new Tray(icon); tray.setToolTip('Clop'); tray.on('double-click', showLatest); updateTray();
    for (const [key, callback] of [
      ['Control+Shift+C', () => { void optimiseClipboard(undefined, true); }],
      ['Control+Shift+A', () => { void optimiseClipboard(undefined, true, true); }],
      ['Control+Shift+Space', showLatest],
    ] as const) if (!globalShortcut.register(key, callback)) inform(`${key} is already in use. Use the tray menu or floating shelf instead.`);
    if (process.platform === 'win32') {
      bridge.on('ready', () => { bridgeReady = true; void bridge.request(nativeSettings()).then(() => { if (settings.enableClipboardOptimiser) void optimiseClipboard(); }).catch(error => inform(message(error))); });
      bridge.on('clipboard', event => {
        if (!settings.enableClipboardOptimiser || paused()) return;
        const change = clipboardChange(event);
        if (change) pickup.change(change); else inform('The Windows helper sent an unreadable clipboard change.');
      });
      bridge.on('foreground', event => pickup.focus(Number(event.process)));
      bridge.on('drag-start', () => { if (settings.enableDragAndDrop) { dragging = true; dropActive = true; floating.setIgnoreMouseEvents(false); syncFloating(); broadcast(); } });
      bridge.on('drag-end', () => { dragging = false; setTimeout(() => { if (!dragging) { dropActive = false; syncFloating(); broadcast(); } }, 180); });
      bridge.on('notice', inform);
      bridge.on('stopped', () => { bridgeReady = false; pickup.cancel(); startClipboardFallback(); });
      bridge.start(path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'native', 'bridge.ps1'));
    } else startClipboardFallback();
    const files = process.argv.slice(1).filter(arg => path.isAbsolute(arg) && mediaKind(arg));
    if (files.length) await importFiles(files, 'file');
  }).catch(error => { dialog.showErrorBox('Clop could not start', message(error)); app.quit(); });
  app.on('before-quit', () => { quitting = true; engine?.abort(); for (const watcher of watchers) void watcher.close(); stopCleaner?.(); pickup.cancel(); if (clipboardTimer) clearInterval(clipboardTimer); for (const timer of hideTimers.values()) clearTimeout(timer); bridge.stop(); globalShortcut.unregisterAll(); });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
  app.on('activate', () => { if (engine) showLatest(); });
}
