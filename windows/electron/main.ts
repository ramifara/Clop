import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, Menu, nativeImage, protocol, screen, shell, Tray } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardOptimiser } from './card';
import { ItemEngine, message, type ImportExtra, type ItemAutomation } from './items';
import { clipboardPNG } from '../core/media/image-codecs';
import { imageDefaults, rendererSettings } from './settings';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { SettingsStore } from '../core/settings/store';
import { Workdir } from '../core/workdir';
import { expandTemplate, type Counter } from '../core/template';
import { WindowsBridge } from './native';
import { ignoredApp, withIgnored } from './apps';
import { ClipboardPickup, type ClipboardChange } from './pickup';
import { ClipboardIntake, importClipboardImages, importClipboardList, type ClipboardListSteps, replacedClipboardImages, serial, clipboardChange, clipboardIntake, copyReply, DEFAULT_NAME_TEMPLATE, mediaKind, sequenceReply, splitClipboardList, copyingApp, type ClipboardMemory, type CopyingApp } from './clipboard';
import { OptimisedMarker } from '../core/marker';
import { FolderWatcher } from './watcher';
import { enabledKey, localFile } from './watch-rules';
import { FolderResults, LastBatch, restoreAll } from './automation';
import { appsReply } from './apps';
import { conflictNotice, shortcutProblem, ShortcutRegistry, shortcutsFor, type ShortcutAction } from '../core/shortcuts';
import { describeAccelerator } from '../src/settings/accelerator';
import { ShortcutRunner } from './shortcut-actions';
import { protectFromCapture } from './capture';
import { guarded, recentClipboard, toTemplate, trayMenu, trayTooltip, trayVariant, type TrayActions, type TrayVariant } from './tray-menu';
import { allPipelineChoices, appPathReply, attachedAutomation, attachedPipelines, chosenPipeline, isAumid, outcomeNotes, pipelineChoices, resolveApp, runForApp, tempRoots, watchedFolders, type PipelineHost } from './pipelines';
import { seedBuiltinPipelines } from '../core/pipeline/builtins';
import { EDITOR_SETTING_KEYS } from '../core/pipeline/editor-state';
import { cellCount, draggedType, gridHeight, tilesFor, zonePipeline } from '../core/pipeline/zones';
import { EditorService } from './editor';
import { PresetReveal } from './preset-reveal';
import { pipelinesSkipOptimisation, type PipelinesOutcome } from '../core/pipeline/triggers';
import type { PipelineEffects } from '../core/pipeline/executor';
import type { MediaKind } from '../core/media/types';
import { spawn } from 'node:child_process';
import type { AppEntry, AppState, ImageOptions, ItemResult, PresetTiles, SettingsRequest } from '../src/types';
import { settingsTarget } from '../core/settings/entries';
import type { SettingsTab } from '../core/settings/tabs';
import { createPrefs, LINKS } from './prefs';
import { publishPipe, startPipeServer, type PipeServer } from './pipe-server';
import { syncLoginItem } from './login-item';
import { clopURLs, linkInbox, type ClopURL } from './clop-url';
import { installPortableCLI, isPortable, portableCLIDir, portableCLIInstalled, refreshPortableCLI, removePortableCLI } from './cli-install';
import { mcpSettings } from './mcp';
import { setupDebugDump, setupUpdates, setupWatchdog } from './support';
import { FileCollector } from './file-collector';
import { pipelineMenu } from './pipeline-menu';
import { installVerbs, portablePaths, removeVerbs, verbsStatus } from './explorer';
import { explorerVerb, type VerbId } from '../core/shell-verbs';
import { stripExifFile } from '../core/media/strip-copy';
import { explorerRequest, skippedNote, stripAll, stripSummary, usableFiles } from './verbs';
import { mirrorConsoleToFile } from './debug-log';
import { newPipePath, type OptimisationRequest } from '../core/ipc/protocol';
import { ClopService } from '../core/ipc/service';
import { shellEffects } from '../core/shell-effects';
import { MEDIA_SCHEME, MediaFiles } from './media-files';
import { applyCrop, cropSource, viewItems, parseCropRequest, parseCropView, parseSavedCropSizes } from './crop';
import { compareSources, parseCompareView } from './compare';
import { setupBatch } from './batch-window';
import { ACTION_KINDS, BATCH_ACTIONS, batchMenu, itemMenu, MENUS, parseInvocation, planFor, refuseUnavailable, submenu, type ActionId, type Facts } from '../core/cards/actions';
import { expandHome } from '../core/settings/paths';
import { menuTemplate } from './card-menu';
import { coverArtCard, editorProgram, isEditorPath, makesNewCard, mediaFacts, openWithDialog, pageCard, runPlan, savePages, startProgram, type CardCreation, type CardHost } from './cards';
import { CompactMode, cardsThatFit } from './compact';

const here = path.dirname(fileURLToPath(import.meta.url));
// The crop and compare windows load the session's originals and results through this scheme, with byte ranges for video.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);
let main: BrowserWindow, floating: BrowserWindow, editorWindow: BrowserWindow | undefined, editorLoading: { window: BrowserWindow; done: Promise<void> } | undefined, tray: Tray | undefined, engine: ItemEngine, media: MediaFiles;
/** Open crop, compare and preview windows, by `crop:<id>`, `compare:<id>` and `preview:<id>`. */
const views = new Map<string, BrowserWindow>();
let settings = defaultSettings(), settingsRequest: SettingsRequest | undefined, notice: string | undefined, quitting = false, bridgeReady = false, bridgeStopped = false;
let store: SettingsStore, workdir: Workdir, stopCleaner: (() => void) | undefined, workdirProblem: string | undefined;
let mcp: ReturnType<typeof mcpSettings>, prefs: ReturnType<typeof createPrefs>;
let dropActive = false, dragging = false, importsRunning = 0, hovered = false, selecting = false;
/** The files being dragged, and whether Ctrl or Alt is held, as the Windows helper reports them: Ctrl or Alt shows the preset zone tiles. */
let dragFiles: string[] = [], presetsLatched = false;
const presetReveal = new PresetReveal();
const hidden = new Set<string>();
const hideTimers = new Map<string, NodeJS.Timeout>();
const compactMode = new CompactMode({
  always: () => settings.alwaysShowCompactResults, seconds: () => settings.autoClearAllCompactResultsAfter, fit: () => cardFit, clear: ids => hideResults(ids),
  paused: () => hovered || dragging || selecting,
  switched: compact => { if (compact) { for (const timer of hideTimers.values()) clearTimeout(timer); hideTimers.clear(); } },
});
let clipboardTimer: NodeJS.Timeout | undefined;
const memory: ClipboardMemory = { fingerprint: '', own: '' };
let nameCounter: Counter | undefined;
/** Clipboard images take turns, each optimised and written back before the next one replaces its card. Images share one engine queue anyway. */
const clipboardImageTurn = serial();
let marker: OptimisedMarker, folders: FolderResults, watchers: FolderWatcher[] = [];
let home = '', sessionDir = '';
/** Folders of the work directory's temp folder that hold pipeline results cards show; kept from the cleaner for the session. */
const keptRoots = new Set<string>();
let batch: ReturnType<typeof setupBatch> | undefined, batchSettled = false;
/** Results from watched folders in `dirsHideFloatingResult`; they never show as floating results. */
const quiet = new Set<string>();
/** Results that hid or were dismissed, latest last, for "Bring back last result". */
const removedOrder: string[] = [];
/** Remembers a result that hid or was dismissed; only the latest few can be brought back. */
function removed(id: string) { removedOrder.push(id); removedOrder.splice(0, removedOrder.length - 80); }
const lastBatch = new LastBatch();
/** The app that put the latest thing on the clipboard, for the tray's "Ignore clipboard events from" (the helper reports it with every change, ignored apps included). */
let lastCopier: { owner?: string; aumid?: string } | undefined;
let shortcuts: ShortcutRegistry, trayShown: TrayVariant | undefined;
const trayIcons: Partial<Record<TrayVariant, Electron.NativeImage>> = {};
const paused = () => settings.pauseAutomaticOptimisations;
const intake = new ClipboardIntake(error => inform(message(error)));
// "Pause for the next clipboard event" (the pause shortcut's first step) lets one copy go by.
const pickup = new ClipboardPickup(change => { if (!shortcutRunner.consumePauseNext()) void optimiseClipboard(change); });
let clipboardWrites: Promise<void> = Promise.resolve();
const bridge = new WindowsBridge();
let pipe: PipeServer | undefined, withdrawPipe: (() => void) | undefined, cliInstalled = false, askingMCP = false;
let service: ClopService | undefined, updates: ReturnType<typeof setupUpdates>, saveDump: ReturnType<typeof setupDebugDump>, stopUpdates: (() => void) | undefined, explorerInstalled = false;
/** The files of Explorer's right-click verbs: one launch arrives per selected file, so each verb's files are gathered before the app acts. While the app is still starting they wait. */
const verbCollectors = new Map<VerbId, FileCollector>();
function collectVerb(verb: VerbId, files: string[]) {
  let collector = verbCollectors.get(verb);
  if (!collector) {
    collector = new FileCollector(all => { if (!service) collector!.add(all); else void runVerb(verb, all).catch(error => inform(message(error))); });
    verbCollectors.set(verb, collector);
  }
  collector.add(files);
}
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
const presetsRevealed = () => presetReveal.revealed(settings.onlyShowPresetZonesOnControlTapped);
/** The preset zone tiles for the files being dragged. */
function presets(): PresetTiles { return { revealed: presetsRevealed(), ...tilesFor(settings.presetZones, settings.savedPipelines, draggedType(dragFiles, mediaKind)) }; }
const visible = () => engine.list().filter(item => !hidden.has(item.id) && !quiet.has(item.id));
let choices: { saved: ClopSettings['savedPipelines']; list: ReturnType<typeof allPipelineChoices> } | undefined;
/** The saved pipelines, kept until the library changes: the state is sent on every progress step. */
const pipelineList = () => (choices?.saved === settings.savedPipelines ? choices : choices = { saved: settings.savedPipelines, list: allPipelineChoices(settings) }).list;
/** How many full cards fit the screen last time the shelf was laid out. */
let cardFit = 3;
const state = (): AppState => ({ items: visible(), settings, native: true, platform: process.platform, dropActive, notice, presets: presets(), settingsRequest, layout: { compact: compactMode.compact, cards: cardFit }, pipelines: pipelineList(), ...(settings.finishedOnboarding ? {} : { welcome: true as const }) });
function broadcast() {
  refreshTrayIcon();
  for (const window of [main, floating]) if (window && !window.isDestroyed()) window.webContents.send('clop:state', state());
  // The crop and compare windows follow their result even after its card hid, so they get it whether or not it shows; no other.
  if (views.size) { const all = engine.list(); for (const [key, window] of views) if (!window.isDestroyed()) window.webContents.send('clop:state', { ...state(), items: viewItems(all, key) }); }
}
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
/** Compact rows are 34 px tall, 58 with a thumbnail; the list adds a header. */
const compactHeight = (rows: number) => 38 + rows * (settings.showCompactImages ? 58 : 34);
function syncFloating() {
  if (!floating || floating.isDestroyed()) return;
  const target = dropActive || settings.keepDropZoneVisible;
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const items = visible();
  cardFit = cardsThatFit(area.height, target);
  const compact = compactMode.update(items.map(item => ({ id: item.id, running: item.status === 'processing' })));
  const count = Math.min(cardFit, items.length);
  // Room for the tiles stays once they were shown, until the drag ends: a tile under the pointer must not lose its window when Ctrl is let go.
  const tiles = presetsLatched || presetsRevealed() ? gridHeight(cellCount(presets())) + 8 : 0;
  const height = (compact ? compactHeight(items.length) : count * 166 + Math.max(0, count - 1) * 4 + (count > 1 ? 28 : 0)) + (target ? 160 : 0) + tiles + (notice ? 85 : 0) + (settings.finishedOnboarding ? 0 : 220) + 40;
  floating.setSize(compact ? 320 : 236, Math.min(height, area.height));
  positionFloating();
  if (items.length || target || notice || importsRunning || !settings.finishedOnboarding) showFloating(); else floating.hide();
}
function showLatest() {
  for (const item of engine.list().slice(0, 3)) hidden.delete(item.id);
  dropActive = !engine.list().length;
  syncFloating(); broadcast();
}
/** Hides results the way an expired card hides: they stay in the shelf and can be brought back. */
function hideResults(ids: string[]) {
  for (const id of ids) {
    if (!engine.has(id)) continue;
    const timer = hideTimers.get(id); if (timer) clearTimeout(timer);
    hideTimers.delete(id); hidden.add(id); removed(id);
  }
  syncFloating(); broadcast();
}
function scheduleHide(id: string) {
  const existing = hideTimers.get(id); if (existing) clearTimeout(existing);
  // The compact list clears every result together instead (CompactMode).
  if (compactMode.compact) return;
  const check = () => {
    if (hovered || dragging) { hideTimers.set(id, setTimeout(check, 1000)); return; }
    hideResults([id]);
  };
  hideTimers.set(id, setTimeout(check, engine.get(id).result.source === 'clipboard' ? 10000 : 30000));
}
async function dismiss(id: string) {
  const timer = hideTimers.get(id); if (timer) clearTimeout(timer);
  for (const view of ['crop', 'compare', 'preview']) views.get(`${view}:${id}`)?.close();
  if (engine.has(id)) media?.revoke(engine.get(id).directory);
  hideTimers.delete(id); hidden.delete(id); shortcutRunner.forget(id);
  await engine.dismiss(id);
  if (!quiet.delete(id)) removed(id);
}
/** Shows a result that hid or was dismissed again, with its hide timer, and takes it out of the removed order. */
function bringBack(id: string) {
  if (!((hidden.has(id) && engine.has(id)) || engine.bringBack(id))) return false;
  hidden.delete(id);
  const at = removedOrder.lastIndexOf(id);
  if (at >= 0) removedOrder.splice(at, 1);
  scheduleHide(id); syncFloating(); broadcast();
  return true;
}
/** "Bring back last result": the result that hid or was dismissed last shows again. */
function bringBackLast() {
  while (removedOrder.length) if (bringBack(removedOrder.at(-1)!)) return; else removedOrder.pop();
  inform('There is no result to bring back.');
}
/** "Revert last optimisations": the latest batch of results gets its originals back, over the files of watched folders too. */
async function revertLast() {
  // A result dismissed since, such as one cancelled while it was being placed, comes back to be restored.
  const ids = lastBatch.take().filter(id => engine.has(id) || bringBack(id));
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
    const id = await engine.importBuffer(Buffer.concat(chunks), name || 'Download', source, defaults(aggressive), source === 'drop' && !aggressive ? dropExtra() : undefined);
    if (isReady(id)) await (source === 'clipboard' ? copyClipboardResults([id], sequence) : settings.autoCopyToClipboard ? copy([id], sequence) : undefined);
  } finally { importsRunning--; syncFloating(); broadcast(); }
}
function configure(window: BrowserWindow) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
}
const webPreferences = () => ({ preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true });
async function load(window: BrowserWindow, query: Record<string, string>) {
  if (devUrl) await window.loadURL(`${devUrl}/?${new URLSearchParams(query)}`); else await window.loadFile(path.join(here, '../dist/index.html'), { query });
}
/** Opens a result's crop, compare or preview window, or brings the open one forward. Each closes for good, and with its result. */
async function openView(view: 'crop' | 'compare' | 'preview', id: unknown) {
  if (typeof id !== 'string' || !engine.has(id)) throw new Error('This result is no longer in the shelf.');
  const { result } = engine.get(id), key = `${view}:${id}`, open = views.get(key);
  if (result.status !== 'ready') throw new Error('Wait for this result to finish first.');
  if (view === 'crop' && result.kind === 'audio') throw new Error('Audio files have nothing to crop.');
  if (open && !open.isDestroyed()) { open.show(); open.focus(); return; }
  const size = view === 'crop' ? { width: 1020, height: 660, minWidth: 780, minHeight: 520 } : view === 'preview' ? { width: 900, height: 700, minWidth: 420, minHeight: 320 } : { width: 1100, height: 760, minWidth: 600, minHeight: 460 };
  const window = new BrowserWindow({ ...size, show: false, title: `${{ crop: 'Crop', compare: 'Compare', preview: 'Preview' }[view]}: ${result.name}`, backgroundColor: '#211d23', autoHideMenuBar: true, webPreferences: webPreferences() });
  views.set(key, window);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('page-title-updated', event => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (views.get(key) === window) views.delete(key); syncNative(); });
  syncNative();
  try { await load(window, { [view]: id }); }
  catch (error) {
    // A window that never loaded would stay blank and be brought forward again by the next open.
    if (views.get(key) === window) views.delete(key);
    if (!window.isDestroyed()) window.destroy();
    syncNative();
    throw error;
  }
}
/**
 * The pipeline editor: its own sandboxed window, made the first time it is asked for. `tab` opens it on the preset zones.
 * It counts as the editor window only once its page has loaded; a page that fails to load is closed, so the next try starts
 * over. Asks that arrive while it loads wait for it, so a tab change is never sent to a page that cannot receive it yet.
 */
async function openEditor(tab?: 'zones') {
  if (editorLoading) await editorLoading.done;
  let window = editorWindow && !editorWindow.isDestroyed() ? editorWindow : undefined;
  if (!window) {
    window = new BrowserWindow({ width: 1060, height: 720, minWidth: 780, minHeight: 500, show: false, backgroundColor: '#f3f1ef', title: 'Clop pipelines', autoHideMenuBar: true, webPreferences: webPreferences() });
    configure(window);
    window.on('closed', syncNative);
    const created = window, done = load(created, { editor: '1', ...(tab ? { tab } : {}) }).then(() => { editorWindow = created; syncNative(); }, (error: unknown) => { created.destroy(); throw error; });
    editorLoading = { window: created, done };
    try { await done; } finally { editorLoading = undefined; }
  } else if (tab) window.webContents.send('clop:editor-tab', tab);
  window.show(); window.focus();
}
async function createWindows() {
  const windowPreferences = webPreferences();
  main = new BrowserWindow({ width: 920, height: 660, minWidth: 720, minHeight: 480, show: false, backgroundColor: '#f3f1ef', title: 'Clop settings', autoHideMenuBar: true, webPreferences: windowPreferences });
  floating = new BrowserWindow({ width: 236, height: 206, frame: false, resizable: false, transparent: true, show: false, skipTaskbar: true, alwaysOnTop: settings.floatingResultsAlwaysOnTop, backgroundColor: '#00000000', webPreferences: windowPreferences });
  configure(main); configure(floating);
  protectFromCapture(floating, settings.allowClopToAppearInScreenshots);
  await load(main, { preferences: '1' }); await load(floating, { floating: '1' });
  positionFloating();
  floating.setIgnoreMouseEvents(true, { forward: true });
  if (settings.keepDropZoneVisible) { syncFloating(); floating.setIgnoreMouseEvents(false); }
}
/**
 * Puts results on the clipboard. One image goes on as image data, with its file unless `copyImageFilePath` is off. Other
 * results, and several at once, go on as a file list, with the last image's data when all are images. `text` also puts
 * the paths on as text, for results of a copied path.
 */
async function copy(ids: string[], expectedSequence?: number, { text = false, extra = [] }: { text?: boolean; extra?: string[] } = {}) {
  const outputs = ids.map(id => engine.output(id)), files = [...outputs, ...extra];
  const images = ids.every(id => engine.get(id).result.kind === 'image');
  const withFiles = !images || ids.length > 1 || settings.copyImageFilePath || extra.length > 0;
  if (process.platform !== 'win32' && !images) throw new Error('Copying files needs the Windows clipboard helper. Save the result instead.');
  await writeClipboard({ ...(withFiles ? { files } : {}), ...(images ? { image: outputs[outputs.length - 1] } : {}), ...(text ? { text: files.join('\r\n') } : {}) }, expectedSequence);
}
/**
 * Writes a file list, an image's pixels and text to the clipboard, marked as Clop's own, unless the clipboard changed since
 * `expectedSequence`. Resolves with the clipboard's new sequence number, or undefined when the write was skipped (or there is none).
 */
async function writeClipboard({ files, image, text }: { files?: string[]; image?: string; text?: string }, expectedSequence?: number): Promise<number | undefined> {
  if (process.platform === 'win32') {
    // Processing can finish before the previous Windows clipboard write has flushed.
    // Snapshot the immutable outputs, then serialize encoding and native writes in action order.
    const write = async () => {
      if (!bridgeReady) throw new Error('The Windows clipboard helper is unavailable. Save or drag the result instead.');
      const png = image ? path.join(workdir.temp, `clipboard-${randomUUID()}.png`) : undefined;
      try {
        if (png) await clipboardPNG(image!, png, { limitInputPixels: 60_000_000 });
        const reply = copyReply(await bridge.request({ type: 'copy', ...(files ? { files } : {}), ...(png ? { png } : {}), ...(text ? { text } : {}), ...(expectedSequence === undefined ? {} : { expectedSequence }) }));
        if (reply.skipped) return undefined;
        memory.sequence = reply.sequence; if (png) memory.own = fingerprint(await readFile(png));
        return reply.sequence;
      } finally { if (png) await rm(png, { force: true }); }
    };
    const job = clipboardWrites.then(write, write);
    clipboardWrites = job.then(() => {}, () => {});
    return job;
  }
  if (!image) { clipboard.writeText(text ?? ''); return undefined; }
  const picture = nativeImage.createFromPath(image);
  if (picture.isEmpty()) throw new Error('This format cannot be copied as an image here. Save the result instead.');
  const png = picture.toPNG();
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
  const items = await clipboard.read(), item = items.find(item => item.types.includes('image/png'));
  memory.own = fingerprint(item ? Buffer.from(await (await item.getType('image/png')).arrayBuffer()) : png);
  return undefined;
}

// Pipelines (spec step 21): the effects the executor asks the app for, and the attached and chosen pipelines.
let appsCache: { at: number; apps: AppEntry[] } | undefined;
/** Apps Windows knows, from the helper, for at most a minute: listing them walks every running process and the Start menu. A failed or empty list is not kept. */
async function knownApps() {
  if (appsCache && Date.now() - appsCache.at <= 60_000) return appsCache.apps;
  if (!bridgeReady) return [];
  const apps = appsReply(await bridge.request({ type: 'apps' }));
  if (apps.length) appsCache = { at: Date.now(), apps };
  return apps;
}
/** The program an App Paths entry names, from the Windows helper. */
async function registeredAppPath(exe: string) {
  return bridgeReady ? appPathReply(await bridge.request({ type: 'app-path', exe }).catch(() => undefined)) : undefined;
}
/** `openWith(app:)`: a packaged app through the helper, a program directly with the file as its argument. */
async function openWith(file: string, app: string, allowExe: boolean) {
  if (process.platform !== 'win32') throw new Error('Opening a file with an app works on Windows only.');
  const target = await resolveApp(app, { apps: knownApps, appPath: registeredAppPath, isFile, watched: watchedFolders(settings, home), allowExe });
  if (isAumid(target)) {
    if (!bridgeReady) throw new Error('The Windows helper is unavailable, so Clop cannot open this app.');
    await bridge.request({ type: 'open-with', aumid: target, file });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(target, [file], { cwd: path.dirname(target), detached: true, stdio: 'ignore' });
    child.once('spawn', () => { child.unref(); resolve(); }).once('error', reject);
  });
}
/** A pipeline's `delete` of a folder asks first, as macOS does. */
async function confirmFolderDeletion(folder: string) {
  const { response } = await dialog.showMessageBox({ type: 'warning', buttons: ['Move to Recycle Bin', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Move this folder to the Recycle Bin?', detail: `A pipeline wants to delete the folder:\n${folder}` });
  return response === 0;
}
/** The effects of one pipeline run. A clipboard write is skipped once the user copies something else during the run. */
async function pipelineEffects({ allowExe }: { allowExe: boolean }): Promise<PipelineEffects> {
  let expected = await currentSequence().catch(() => undefined);
  return {
    copyToClipboard: async item => {
      const written = await writeClipboard('text' in item ? { text: item.text } : { image: item.image, ...(settings.copyImageFilePath ? { files: [item.image] } : {}) }, expected);
      if (written !== undefined) expected = written;
    },
    openWith: (file, app) => openWith(file, app, allowExe),
    trash: async (target, kind) => {
      if (kind === 'folder' && !await confirmFolderDeletion(target)) return false;
      await shell.trashItem(target);
      return true;
    },
  };
}
const pipelineHost: PipelineHost = {
  env: () => ({ settings, workdir, marker, home, counter: nameCounter ??= { value: settings.lastAutoIncrementingNumber } }),
  effects: pipelineEffects,
  counterChanged: value => { store.set({ lastAutoIncrementingNumber: value }).then(next => { settings = next; }, error => inform(message(error))); },
  keep: files => { for (const root of tempRoots(workdir.temp, sessionDir, files)) if (!keptRoots.has(root)) { keptRoots.add(root); workdir.protect(root); } },
};
/** A result shown as it is, without optimising: a file a pipeline forked off. */
const AS_IS: ItemAutomation = { skipOptimisation: true, fallback: false, run: async ({ original }) => ({ file: original, anyRan: false, warnings: [] }) };
/** After pipelines ran on a result: `hideResult` keeps it from the floating results, and forked files get cards of their own. */
function afterPipelines(id: string | undefined, outcome: PipelinesOutcome, source: ItemResult['source'], { hide = true } = {}) {
  if (id && hide && outcome.hidden) quietResult(id);
  // Not awaited: the fork's job queues behind the one that is running.
  for (const fork of outcome.forks) void makeRoom().then(() => engine.importPath(fork, source, defaults(), undefined, { automation: AS_IS })).catch(error => inform(message(error)));
}
/**
 * The pipelines attached to `source` (`clipboard` or `dropZone`) for a file of `kind`, or `pipelines` given outright (a preset
 * zone's), as an import's automation. A copied image skips the usual optimisation when every pipeline does (Images.swift); a
 * copied video, PDF or audio file is optimised first (ClopApp.swift), then the pipelines run. A drop skips it for every kind
 * (OptimisationUtils.swift) and is optimised anyway when no pipeline did anything.
 */
function sourceAutomation(kind: MediaKind, source: 'clipboard' | 'dropZone', result: ItemResult['source'], app?: CopyingApp, pipelines = attachedPipelines(kind, source, settings, home)): ImportExtra | undefined {
  let id: string | undefined;
  const automation = attachedAutomation(pipelines, {
    host: pipelineHost, context: { kind, sourceApp: app }, fallback: true, alwaysOptimise: source === 'clipboard' && kind !== 'image', done: outcome => afterPipelines(id, outcome, result),
  });
  return automation && { automation, staged: staged => { id = staged; } };
}
const clipboardAutomation = (kind: MediaKind, app?: CopyingApp) => sourceAutomation(kind, 'clipboard', 'clipboard', app);
/** The pipelines attached to the watched folder `dir`. When they replace optimisation and none did anything, the card stays out of sight, as on macOS. */
function folderAutomation(file: string, kind: MediaKind, dir: string, id: () => string | undefined) {
  const pipelines = attachedPipelines(kind, dir, settings, home), replaces = pipelinesSkipOptimisation(pipelines);
  return attachedAutomation(pipelines, {
    host: pipelineHost, context: { kind }, fallback: false, source: file,
    done: outcome => { const staged = id(); if (staged && replaces && !outcome.anyRan) quietResult(staged); afterPipelines(staged, outcome, 'folder'); },
  });
}
/** Keeps a result out of the floating results. The shelf holds at most 40 results, so a quiet result older than the latest few is long gone. */
function quietResult(id: string) { quiet.add(id); for (const old of quiet) { if (quiet.size <= 80) break; quiet.delete(old); } }
const itemId = (value: unknown) => { if (typeof value !== 'string' || !value || value.length > 64) throw new Error('Choose a result.'); return value; };
/** Imports local files one by one, telling about each that fails. Returns the results that finished. */
async function importPaths(files: unknown, source: ItemResult['source'], { aggressive = false, name, extra }: { aggressive?: boolean; name?: (file: string) => Promise<string | undefined>; extra?: (file: string) => ImportExtra | undefined } = {}) {
  if (!Array.isArray(files) || files.length > 20 || files.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Choose up to 20 local files at a time.');
  dropActive = false; importsRunning++; broadcast();
  const completed: string[] = [];
  try {
    for (const file of files as string[]) {
      try {
        await makeRoom();
        const id = await engine.importPath(file, source, defaults(aggressive), await name?.(file), extra?.(file));
        if (isReady(id)) completed.push(id);
      } catch (error) { inform(`${path.basename(file)}: ${message(error)}`); }
    }
  } finally { importsRunning--; syncFloating(); broadcast(); }
  return completed;
}
/** The pipelines of the drop zone (or of the preset zone `zone`), chosen for the kind the file turns out to be rather than by its name. */
const dropExtra = (zone?: unknown): ImportExtra => ({
  late: kind => sourceAutomation(kind, 'dropZone', 'drop', undefined, zone === undefined ? undefined : [zonePipeline(settings.presetZones, settings.savedPipelines, zone, kind)]),
});
/**
 * Dropped and opened files; their results go on the clipboard with `autoCopyToClipboard`. Dropped files run the pipelines attached
 * to the drop zone, or the pipeline of the preset zone `zone` they were dropped on instead.
 */
async function importFiles(files: unknown, source: ItemResult['source'], aggressive = false, zone?: unknown) {
  const sequence = await currentSequence();
  // Pipelines attached to the drop zone (or a preset zone's pipeline) run on drops, but not on a ⌘-drop's explicit aggressive optimisation (`wantsPipelineLookup`).
  const extra = source !== 'drop' || aggressive ? undefined : () => dropExtra(zone);
  const ids = await importPaths(files, source, { aggressive, extra });
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
async function copyClipboardResults(ids: string[], sequence?: number, options?: { text?: boolean; extra?: string[] }) {
  ids = ids.filter(isReady);
  if (!ids.length) return;
  const images = ids.every(id => engine.get(id).result.kind === 'image');
  const accumulated = images && settings.appendClipboardResults && settings.copyConsecutiveClipboardImages
    ? engine.list().filter(item => item.source === 'clipboard' && item.kind === 'image' && item.status === 'ready').map(item => item.id).reverse() : [];
  await copy(accumulated.length > 1 ? accumulated : ids, sequence, options);
}
/** The steps of importing clipboard results (see `importClipboardList`), written back against the clipboard `sequence` they came from. */
function clipboardSteps(sequence: number | undefined, aggressive: boolean, options?: { text?: boolean; extra?: string[] }, app?: CopyingApp): ClipboardListSteps {
  return {
    turn: clipboardImageTurn, prepare: prepareClipboardImages, writeBack: ids => copyClipboardResults(ids, sequence, options),
    load: list => importPaths(list, 'clipboard', {
      aggressive, name: async file => mediaKind(file) === 'image' ? clipboardImageName(path.basename(file)) : undefined,
      extra: file => clipboardAutomation(mediaKind(file) ?? 'image', app),
    }),
  };
}
function importClipboardFiles(files: string[], rest: string[] | undefined, sequence: number | undefined, aggressive: boolean, options?: { text?: boolean }, app?: CopyingApp) {
  // Files past the limit and the entries Clop leaves alone stay in the list the results are written back to.
  const split = splitClipboardList(files, rest);
  return importClipboardList(split.take, clipboardSteps(sequence, aggressive, { ...options, extra: split.rest }, app));
}
function importClipboardImage(bytes: Buffer, name: string, sequence: number | undefined, aggressive: boolean, app?: CopyingApp) {
  return importClipboardImages(clipboardSteps(sequence, aggressive, undefined, app), async () => {
    await makeRoom();
    const id = await engine.importBuffer(bytes, await clipboardImageName(name), 'clipboard', defaults(aggressive), clipboardAutomation('image', app));
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
      case 'files': return () => importClipboardFiles(plan.files, plan.rest, plan.sequence, aggressive, { text: plan.text }, plan.app);
      case 'image': return () => importClipboardImage(plan.bytes, `Clipboard-${stamp()}.${plan.ext}`, plan.sequence, aggressive, plan.app);
      case 'url': return () => importUrl(plan.url, aggressive, 'clipboard', plan.sequence);
    }
  }, () => manual || (settings.enableClipboardOptimiser && !paused()));
}
function startClipboardFallback() {
  if (clipboardTimer) return;
  let polling = false;
  clipboardTimer = setInterval(() => { if (settings.enableClipboardOptimiser && !polling) { polling = true; void optimiseClipboard().finally(() => { polling = false; }); } }, 900);
  clipboardTimer.unref();
}
const optimiseWithCard = cardOptimiser({ engine: () => engine, makeRoom, defaults });
/** Requests from `clop` and the MCP server (spec step 24). Settings they change go through `updateSettings`, so they apply at once. */
async function serveCLI(userData: string) {
  const files = shellEffects();
  // The same effects as pipelines run from the app, per request: an agent without the permission for script steps cannot open a program by path.
  service = new ClopService({
    store: { get: () => store.get(), update: async change => { const wasEnabled = settings.mcpEnabled, reply = await store.update(change); await settingsChanged(reply.settings, wasEnabled); return reply; } },
    workdir, marker, effects: options => pipelineEffects(options), copyFiles: list => files.copyFiles(list), home: app.getPath('home'), withCard: optimiseWithCard,
  });
  pipe = await startPipeServer(newPipePath(), (request, emit) => { console.log(`CLI request: ${request.kind}`); return service!.handle(request, emit); });
  withdrawPipe = await publishPipe(userData, pipe);
}
/** `clop://settings/…` opens Settings on a tab and row and `clop://mcp/start|stop` flips the MCP switch; start asks first. */
async function openClopURL(link: ClopURL) {
  if (link.kind === 'settings') { showSettings(link.tab, link.row); return; }
  if (link.action === 'stop') return updateSettings({ mcpEnabled: false });
  // Repeated start links while the question is open ask nothing more.
  if (settings.mcpEnabled || askingMCP) return;
  askingMCP = true;
  let response: number;
  try { ({ response } = await dialog.showMessageBox({ type: 'question', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Clop', message: 'Let AI agents change files and settings through Clop?', detail: 'An agent asked to use Clop through its MCP server. You can turn this off again in Clop settings.' })); }
  finally { askingMCP = false; }
  if (response === 0) await updateSettings({ mcpEnabled: true });
}
/** clop.exe, which agents run as the MCP server: beside the installed app, or the copy the portable app's tray item installs. */
function mcpServerPath() {
  if (!app.isPackaged || process.platform !== 'win32') return undefined;
  return isPortable() ? path.join(portableCLIDir(), 'clop.exe') : path.join(path.dirname(process.execPath), 'cli', 'clop.exe');
}
const mcpServerMissing = () => !app.isPackaged ? 'The MCP server is the installed clop.exe, which development builds do not have.'
  : isPortable() ? 'Install the command-line tool from the tray menu first: the MCP server is the clop command.' : "Clop's command-line tool is missing from this install, so the MCP server cannot run.";
async function confirmScripts() {
  const { response } = await dialog.showMessageBox(main, { type: 'warning', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Clop', message: 'Allow agents to write scripts?', detail: 'A script step runs arbitrary code inside a pipeline.\n\nWithout human verification, it can result in irretrievable file losses as scripts are not sandboxed in any way.' });
  return response === 0;
}
function toggleCLI() {
  const appDir = path.dirname(process.execPath);
  (cliInstalled ? removePortableCLI(process.resourcesPath, appDir) : installPortableCLI(process.resourcesPath, appDir))
    .then(() => { cliInstalled = !cliInstalled; updateTray(); void mcp.writeCard().catch(() => {}); inform(cliInstalled ? 'Open a new terminal to use the clop command.' : 'The clop command is removed.'); })
    .catch(error => inform(message(error)));
}
/** The portable app's switch for Explorer's right-click entries (the installer adds its own). They run the exe the user started, so the app has to stay where it is. */
async function toggleExplorer() {
  if (explorerInstalled) { await removeVerbs(portablePaths()); explorerInstalled = false; updateTray(); inform('The Explorer menu entries are removed.'); return; }
  await installVerbs(portablePaths());
  explorerInstalled = true; updateTray();
  inform('Right-click a file in Explorer (under Show more options on Windows 11) to use Clop. Keep the portable app where it is.');
}
/** What each Explorer verb does once its launches are gathered. All of it happens in this one app: nothing else is started. */
async function runVerb(verb: VerbId, files: string[]) {
  if (verb === 'run-pipeline') return choosePipeline(files);
  const { use, skipped } = usableFiles(verb, files);
  if (!use.length) { inform(skippedNote(skipped)); return; }
  if (verb === 'strip-exif') { inform(stripSummary(await stripAll(use, stripExifFile), skipped)); return; }
  const failures: string[] = [];
  await service!.optimise(explorerRequest(verb, use, randomUUID()), reply => { if (reply.kind === 'error') failures.push(`${path.basename(reply.error.forURL)}: ${reply.error.error}`); });
  const notes = [...failures.slice(0, 3), ...(failures.length > 3 ? [`${failures.length - 3} more failed.`] : []), ...(skipped ? [skippedNote(skipped)] : [])];
  if (notes.length) inform(notes.join('\n'));
}
/** "Run pipeline..." from Explorer: asks which saved pipeline with a menu at the pointer, then runs it on the files that pipeline works on. */
async function choosePipeline(files: string[]) {
  const supported = files.filter(file => mediaKind(file));
  if (!supported.length) { inform('Clop cannot run a pipeline on those files.'); return; }
  const menu = pipelineMenu(allPipelineChoices(settings), supported.map(mediaKind), supported.length, id => {
    const pipeline = allPipelineChoices(settings).find(choice => choice.id === id);
    const usable = supported.filter(file => !pipeline?.fileType || mediaKind(file) === pipeline.fileType);
    if (usable.length < supported.length) inform(`${pipeline?.name ?? 'That pipeline'} works on ${pipeline?.fileType} files, so ${supported.length - usable.length} other file${supported.length - usable.length === 1 ? ' was' : 's were'} left out.`);
    void (async () => {
      // importPaths takes up to 20 files at a time; a larger selection goes in turns.
      for (let at = 0; at < usable.length; at += 20) {
        await importPaths(usable.slice(at, at + 20), 'drop', { extra: file => { const kind = mediaKind(file) ?? 'image'; return sourceAutomation(kind, 'dropZone', 'drop', undefined, [chosenPipeline(settings, kind, id)]); } });
      }
    })().catch(error => inform(message(error)));
  });
  if (!menu.length) { inform('No saved pipeline works on those files. Add one in the pipeline editor.'); return; }
  const built = Menu.buildFromTemplate(menu);
  // A launch from Explorer does not own the foreground, and a menu popped up without it never closes when clicked away from.
  app.focus({ steal: true });
  if (tray) tray.popUpContextMenu(built); else { main.show(); built.popup({ window: main }); }
}
/** Opens the Settings window, on a tab and row when asked. The request travels with the state, so a window that has not finished loading still gets it. */
function showSettings(tab?: SettingsTab, row?: string) {
  // Without a tab or row the window just comes back as it was, with its tab and search.
  if (tab || row) settingsRequest = { ...settingsTarget(tab, row), nonce: (settingsRequest?.nonce ?? 0) + 1 };
  if (main.isMinimized()) main.restore();
  main.show(); main.focus();
  if (tab || row) broadcast();
}
// The global shortcuts (spec step 38, `handleHotkey` in ClopApp.swift): `ShortcutRunner` decides what each does; this is what it runs on.
const shortcutRunner = new ShortcutRunner({
  items: () => state().items, latestClipboard: () => engine.list().find(item => item.source === 'clipboard' && item.status === 'ready'),
  run: (id, invocation) => runCard(main.webContents, [id], invocation),
  open: (view, id) => openView(view, id), dismiss, stop: ids => engine.stop(ids), bringBack: bringBackLast,
  paused, setPaused: pause => updateSettings({ pauseAutomaticOptimisations: pause }),
  optimiseClipboard: aggressive => optimiseClipboard(undefined, true, aggressive),
  freshClipboard: async () => {
    const before = new Set(engine.list().map(item => item.id));
    await optimiseClipboard(undefined, true);
    await intake.idle();
    return engine.list().find(item => !before.has(item.id) && item.source === 'clipboard' && item.status === 'ready');
  },
  bitrates: async id => (await mediaFacts(engine.output(id), 'audio')).bitrates ?? [],
  inform,
});
const runShortcut = (action: ShortcutAction) => shortcutRunner.run(action);
/** Every tray and shortcut handler reports a failure here: the notice shows it, and the menu is rebuilt so its checkboxes show what is really set. */
function reportFailure(error: unknown) { console.warn(message(error)); inform(message(error)); updateTray(); }
const toggleSetting = (value: unknown) => { updateSettings(value).catch(reportFailure); };
const openFolder = async (dir: string) => { const failure = await shell.openPath(dir); if (failure) throw new Error(failure); };
/** A recent clipboard item from the tray: its card shows again and its result goes back on the clipboard. */
async function showRecentResult(id: string) {
  if (!engine.has(id)) throw new Error('This result is no longer in the shelf.');
  hidden.delete(id); scheduleHide(id); syncFloating(); broadcast();
  if (isReady(id)) await copy([id]);
}
const trayActions: TrayActions = {
  showLatest, showRecent: showRecentResult, batch: () => batch?.show(), settings: () => showSettings(), pipelines: () => openEditor(),
  optimiseClipboard: aggressive => optimiseClipboard(undefined, true, aggressive), downscaleClipboard: () => shortcutRunner.downscaleClipboard(undefined, true),
  ignoreApp: (id, ignore) => {
    // The menu was built for the app that copied last; if another copied since, the click is for a menu that is gone.
    if (!lastCopier || copyingApp(lastCopier)?.id !== id) throw new Error('Another app copied since the menu opened. Open it again.');
    return updateSettings({ clipboardIgnoredAppBundleIds: withIgnored(settings.clipboardIgnoredAppBundleIds, lastCopier, ignore) });
  },
  openBackups: () => openFolder(workdir.backups), openWorkdir: () => openFolder(workdir.root),
  forceClean: async () => { const removed = await workdir.forceClean(); inform(removed ? `Working directory cleaned: ${removed} item${removed === 1 ? '' : 's'} removed.` : 'The working directory is already clean.'); },
  revert: revertLast, bringBack: bringBackLast, stopAll: () => engine.stop(), set: updateSettings, toggleCLI, toggleExplorer,
  checkForUpdates: async () => { const text = await updates.check(); if (text) inform(text); },
  saveDebugDump: async () => { inform(`Debug dump saved: ${path.basename(await saveDump())}`); },
  quit: () => app.quit(),
};
/** The menu for the app as it is now, read each time it opens. */
function trayItems() {
  const copier = lastCopier && copyingApp(lastCopier);
  return trayMenu({
    settings, shortcuts: shortcutsFor(settings), recent: recentClipboard(engine.list()), canRevert: lastBatch.size > 0, canBringBack: removedOrder.length > 0,
    copier: copier?.id && copier.name ? { id: copier.id, name: copier.name, ignored: ignoredApp(lastCopier!, settings.clipboardIgnoredAppBundleIds) } : undefined,
    cli: isPortable() ? { installed: cliInstalled } : undefined, explorer: isPortable() ? { installed: explorerInstalled } : undefined, version: app.getVersion(),
  }, trayActions);
}
const trayMenuNow = () => Menu.buildFromTemplate(toTemplate(trayItems(), reportFailure));
function trayIcon(variant: TrayVariant) {
  return trayIcons[variant] ??= [`tray-${variant}.png`, 'icon.png'].map(name => nativeImage.createFromPath(path.join(here, name))).find(image => !image.isEmpty()) ?? nativeImage.createEmpty();
}
/** The icon follows the engine: working, paused, or normal. */
function refreshTrayIcon(force = false) {
  if (!tray) return;
  const variant = trayVariant({ working: importsRunning > 0 || !!engine?.processing(), paused: paused() });
  if (!force && variant === trayShown) return;
  trayShown = variant; tray.setImage(trayIcon(variant)); tray.setToolTip(trayTooltip(variant));
}
/** Builds, refreshes or removes the tray icon to match `showMenubarIcon`. */
function updateTray() {
  if (!settings.showMenubarIcon) { tray?.destroy(); tray = undefined; trayShown = undefined; return; }
  if (!tray) {
    tray = new Tray(trayIcon('normal')); tray.on('double-click', showLatest);
    // Windows shows the menu built fresh on each right-click, so recent items and the copying app are current.
    if (process.platform === 'win32') tray.on('right-click', () => tray?.popUpContextMenu(trayMenuNow()));
  }
  if (process.platform !== 'win32') tray.setContextMenu(trayMenuNow());
  refreshTrayIcon(true);
}
async function updateSettings(value: unknown) {
  const wasEnabled = settings.mcpEnabled;
  await settingsChanged(await store.set(value), wasEnabled);
}
/** Brings the app in line with settings that were just saved. */
async function settingsChanged(saved: typeof settings, wasEnabled: boolean) {
  settings = saved;
  if (settings.mcpEnabled !== wasEnabled && app.isPackaged) void mcp.writeCard().catch(error => console.warn(`Could not write the MCP server card: ${message(error)}`));
  if (!settings.enableClipboardOptimiser || paused()) pickup.cancel();
  floating.setAlwaysOnTop(settings.floatingResultsAlwaysOnTop);
  syncFloating();
  if (process.platform === 'win32') syncLoginItem(app, settings.launchAtLogin, process.execPath);
  applyWindowSettings();
  if (bridgeReady) await bridge.request(nativeSettings());
  updateTray(); broadcast();
}
/** The shortcuts and the windows' screenshot protection follow the settings, whichever way they changed. */
function applyWindowSettings() {
  syncShortcuts();
  protectFromCapture(floating, settings.allowClopToAppearInScreenshots);
}
let lastShortcutProblem: string | undefined;
/** Registers what the settings ask for. A conflict is announced once, all together, and not again at later launches; unusable trigger keys (set from a file) are said once. */
function syncShortcuts() {
  if (!shortcuts) return;
  const wanted = shortcutsFor(settings), { announce, seen } = conflictNotice(settings.shortcutConflictsSeen, shortcuts.sync(wanted), wanted);
  if (announce.length) inform(`${announce.map(describeAccelerator).join(', ')} ${announce.length === 1 ? 'is' : 'are'} already in use by another program. Use the tray menu or floating shelf instead.`);
  if (JSON.stringify(seen) !== JSON.stringify(settings.shortcutConflictsSeen)) store.set({ shortcutConflictsSeen: seen }).catch(error => console.warn(`Could not remember the shortcut conflicts: ${message(error)}`));
  const problem = shortcutProblem(settings);
  if (problem !== lastShortcutProblem) { lastShortcutProblem = problem; if (problem) inform(`The global shortcuts are off: ${problem}`); }
}
/** Presses inside Clop's own windows, the crop and compare windows too, never start a drag. */
function nativeSettings() {
  return { type: 'settings', explorerDrag: settings.enableDragAndDrop, ownWindows: [main, floating, editorWindow, ...views.values(), batch?.window()].filter((window): window is BrowserWindow => !!window && !window.isDestroyed()).map(window => Number(window.getNativeWindowHandle().readBigUInt64LE())) };
}
function syncNative() { if (bridgeReady) bridge.request(nativeSettings()).catch(error => inform(message(error))); }
// Card actions (spec steps 30 and 31): the right-click menu, the corner buttons and the keys all arrive as one validated invocation
// from the action table in core/cards/actions.ts.
const EDITORS = { image: 'editorAppImage', video: 'editorAppVideo', pdf: 'editorAppPDF', audio: 'editorAppAudio' } as const;
/** The editor app set for a kind of file, with `~` and `$HOME` expanded; empty when none is set. */
const editorFor = (kind: MediaKind) => { const value = settings[EDITORS[kind]].trim(); return value ? expandHome(value, home) : ''; };
const cardHost = (): CardHost => ({ engine, settings: () => settings, pipeline: pipelineHost });
/** The results a card request names: a few distinct ids that are all still in the shelf. */
function cardIds(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 40) throw new Error('Choose a result.');
  return [...new Set(value.map(itemId))].map(id => { engine.get(id); return id; });
}
/** What a menu needs from the file and the settings: the editor app (only when it is the full path of an existing .exe), and for video and audio what ffprobe says. */
async function cardFacts(id: string): Promise<Facts> {
  const { result } = engine.get(id), editor = editorFor(result.kind);
  const facts: Facts = { native: true, pipelines: pipelineChoices(settings, result.kind) };
  if (isEditorPath(editor) && await isFile(editor)) facts.editor = path.win32.basename(editor).replace(/\.exe$/i, '');
  if (result.status === 'ready') Object.assign(facts, await mediaFacts(engine.output(id), result.kind));
  return facts;
}
const creation = (): CardCreation => ({ engine, settings: () => settings, defaults: () => defaults(), makeRoom, scratchRoot: workdir.temp });
/** For the batch menu: the first video's HDR flag and the first audio file's bitrates, as macOS looks at the first result. */
async function batchFacts(ids: string[]): Promise<Facts> {
  const facts: Facts = { native: true };
  for (const kind of ['video', 'audio'] as const) {
    const id = ids.find(candidate => engine.get(candidate).result.kind === kind && engine.get(candidate).result.status === 'ready');
    if (id) Object.assign(facts, await mediaFacts(engine.output(id), kind));
  }
  return facts;
}
/** Pops up a result's right-click menu, a submenu of it (from a corner button), or the batch menu for several results, at the pointer. */
async function cardMenu(sender: Electron.WebContents, ids: string[], name?: unknown) {
  if (name !== undefined && (typeof name !== 'string' || !(MENUS as readonly string[]).includes(name))) throw new Error('Choose a menu.');
  const items = ids.map(id => engine.get(id).result);
  if (items.length > 1 && name !== undefined) throw new Error('Choose one result for this menu.');
  const nodes = items.length > 1 ? batchMenu(items, await batchFacts(ids)) : name ? submenu(name as string, items[0], await cardFacts(ids[0])) : itemMenu(items[0], await cardFacts(ids[0]));
  if (!nodes.length) return;
  const window = BrowserWindow.fromWebContents(sender) ?? undefined;
  Menu.buildFromTemplate(menuTemplate(nodes, invocation => { void runCard(sender, ids, invocation).catch(error => inform(message(error))); })).popup({ window });
}
async function saveResult(window: BrowserWindow | undefined, id: string) {
  const entry = engine.get(id), file = engine.output(id);
  const name = `${path.parse(entry.result.name).name}-clop.${entry.result.format === 'jpeg' ? 'jpg' : entry.result.format}`;
  const result = window ? await dialog.showSaveDialog(window, { defaultPath: name }) : await dialog.showSaveDialog({ defaultPath: name });
  if (result.filePath && !result.canceled) await copyFile(file, result.filePath);
}
/** Saves several results into a folder the user picks, each as `<name>-clop.<ext>`, numbered when the name is taken. */
async function saveResults(window: BrowserWindow | undefined, ids: string[]) {
  const picked = window ? await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Save here' }) : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Save here' });
  const folder = picked.filePaths[0];
  if (picked.canceled || !folder) return;
  for (const id of ids) {
    const entry = engine.get(id), file = engine.output(id), { name: stem } = path.parse(entry.result.name), ext = path.extname(file);
    for (let n = 0; ; n++) {
      const target = path.join(folder, `${stem}-clop${n ? ` (${n})` : ''}${ext}`);
      try { await copyFile(file, target, 1); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || n > 999) throw error; }
    }
  }
}
/** Renders a PDF's pages as images: one page becomes a card of its own, several are saved, optimised, in a folder the user picks. */
async function pagesToImages(window: BrowserWindow | undefined, id: string, format: 'jpeg' | 'png') {
  const pages = engine.get(id).result.pages ?? 1;
  if (pages === 1) { await pageCard(creation(), id, format); return; }
  const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[], buttonLabel: 'Save pages', message: `Choose a folder to save ${pages} pages as optimised ${format === 'png' ? 'PNGs' : 'JPEGs'}` };
  const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  const folder = picked.filePaths[0];
  if (picked.canceled || !folder) return;
  const written = await savePages(creation(), id, format, folder);
  inform(`Saved ${written.length} pages in ${folder}.`);
  void shell.openPath(folder);
}
/** A saved pipeline run on a result from the card's "Pass file through pipeline" menu or a pipeline button. */
async function runSavedPipeline(id: string, pipelineId: unknown) {
  const { kind, source } = engine.get(id).result, pipeline = chosenPipeline(settings, kind, pipelineId);
  // Read before the run: copying the result back must not replace something the user, or the pipeline itself, put on the clipboard since.
  const sequence = await currentSequence();
  await engine.runPipeline(id, async input => {
    const outcome = await runForApp(pipelineHost, [pipeline], input.optimised ?? await input.fresh(), { kind }, input.signal);
    // Asked for from the card, so the result stays in view whatever the pipeline's hideResult says.
    afterPipelines(id, outcome, source, { hide: false });
    return { file: outcome.file, anyRan: outcome.anyRan, warnings: outcomeNotes(outcome) };
  });
  if (isReady(id) && copiesBack(id)) await copy([id], sequence);
}
/** The Windows share sheet needs a packaged app, which Clop is not: the file goes on the clipboard and Explorer selects it, where Share is on its ribbon and context menu. */
async function shareResult(id: string) {
  await copy([id]);
  shell.showItemInFolder(engine.output(id));
}
/** The actions whose menu entry the file's facts can disable or hide; a request for one is checked against them. */
const FACT_ACTIONS: readonly string[] = ['removeAudio', 'hdrToSdr', 'coverArt', 'coverDownscale', 'bitrate'];
/** Runs an action the renderer or a menu asked for on one result, or on a selection (save, copy, restore, downscale, speed, bitrate, aggressive, HDR, strip metadata, dismiss). */
async function runCard(sender: Electron.WebContents, ids: string[], raw: unknown, { copyBack = true } = {}) {
  const window = BrowserWindow.fromWebContents(sender) ?? undefined;
  if (ids.length > 1) {
    const action = (raw as { action?: unknown } | null)?.action;
    if (typeof action !== 'string' || !(BATCH_ACTIONS as readonly string[]).includes(action)) throw new Error('This action works on one result at a time.');
    if (action === 'saveAs') return saveResults(window, ids);
    if (action === 'copy') return copy(ids);
    if (action === 'restore') {
      const { restored, failures } = await restoreAll(engine, ids);
      const clipboardIds = restored.filter(id => engine.has(id) && engine.get(id).result.source === 'clipboard');
      if (clipboardIds.length) await copyClipboardResults(clipboardIds);
      if (failures.length) inform(failures.join('\n'));
      return;
    }
    // Each result on its own: those the action does not work on are skipped, a failure does not stop the rest, and the clipboard is written once at the end.
    const failures: string[] = [], applies = ids.filter(id => ACTION_KINDS[action as ActionId].includes(engine.get(id).result.kind));
    if (!applies.length) throw new Error('This action does not work on the selected results.');
    for (const id of applies) {
      try { if (action === 'dismiss') await dismiss(id); else await runCard(sender, [id], raw, { copyBack: false }); }
      catch (error) { failures.push(`${engine.has(id) ? engine.get(id).result.name : 'A result'}: ${message(error)}`); }
    }
    const back = applies.filter(id => engine.has(id) && isReady(id) && copiesBack(id));
    if (action !== 'dismiss' && back.length) await copy(back).catch(error => failures.push(message(error)));
    if (failures.length) inform(failures.join('\n'));
    return;
  }
  const id = ids[0], item = engine.get(id).result, invocation = parseInvocation(item.kind, raw), plan = planFor(item, invocation);
  if (FACT_ACTIONS.includes(invocation.action)) {
    const refusal = refuseUnavailable(item, invocation, { native: true, ...await mediaFacts(engine.output(id), item.kind) });
    if (refusal) throw new Error(refusal);
  }
  if (plan.type !== 'ui') {
    if (makesNewCard(plan)) { await coverArtCard(creation(), id); return; }
    await runPlan(cardHost(), id, plan);
    shortcutRunner.noted(id, invocation);
    if (copyBack && isReady(id) && copiesBack(id)) await copy([id]);
    return;
  }
  const file = () => engine.output(id);
  switch (plan.ui) {
    case 'stop': engine.stop([id]); return;
    case 'dismiss': await dismiss(id); return;
    case 'restore': await engine.restore(id); shortcutRunner.noted(id, invocation); if (copiesBack(id)) await copy([id]); return;
    case 'preview': await openView('preview', id); return;
    case 'compare': await openView('compare', id); return;
    case 'crop': await openView('crop', id); return;
    case 'saveAs': await saveResult(window, id); return;
    case 'copy': await copy([id]); return;
    case 'reveal': shell.showItemInFolder(file()); return;
    case 'openDefault': { const error = await shell.openPath(file()); if (error) throw new Error(error); return; }
    case 'openWith': await openWithDialog(file()); return;
    case 'editWith': await startProgram(await editorProgram(editorFor(item.kind), { watched: watchedFolders(settings, home), isFile }), file()); return;
    case 'share': await shareResult(id); return;
    case 'pipeline': await runSavedPipeline(id, plan.arg); return;
    case 'pagesToImages': await pagesToImages(window, id, plan.arg as 'jpeg' | 'png'); return;
    case 'menu': await cardMenu(sender, ids, plan.arg); return;
  }
}
/** Card actions put a clipboard result back on the clipboard, and others with `autoCopyToClipboard`. */
function copiesBack(id: string) { const { result } = engine.get(id); return result.status === 'ready' && (result.source === 'clipboard' || (settings.autoCopyToClipboard && result.source !== 'folder')); }
function trusted(sender: Electron.WebContents) { return [main, floating, ...views.values()].some(window => window && !window.isDestroyed() && window.webContents === sender); }
ipcMain.handle('clop:action', async (event, action: string, ...args: unknown[]) => {
  if (!trusted(event.sender)) throw new Error('Untrusted window.');
  const id = args[0] as string;
  switch (action) {
    case 'state': return state();
    case 'import': if (!await batch?.host.drop(args[0], args[1] === true)) await importFiles(args[0], 'drop', args[1] === true); break;
    case 'import-url': await importUrl(args[0], args[1] === true); break;
    case 'clipboard': await optimiseClipboard(undefined, true); break;
    case 'apply': await engine.apply(id, args[1] as ImageOptions); if (copiesBack(id)) await copy([id]); break;
    case 'restore': await engine.restore(id); if (copiesBack(id)) await copy([id]); break;
    case 'copy': await copy([id]); break;
    case 'save': await saveResult(BrowserWindow.fromWebContents(event.sender) ?? undefined, id); break;
    case 'reveal': shell.showItemInFolder(engine.output(id)); break;
    case 'dismiss': await dismiss(id); break;
    case 'settings': if (event.sender !== main.webContents) throw new Error('Only the settings window can do this.'); await updateSettings(rendererSettings(args[0], settings)); break;
    case 'apps': return bridgeReady ? appsReply(await bridge.request({ type: 'apps' })) : [];
    case 'run-preset': await importFiles(args[1], 'drop', false, args[0]); break;
    case 'pipelines': return pipelineChoices(settings, engine.get(itemId(args[0])).result.kind);
    case 'run-pipeline': await runSavedPipeline(itemId(args[0]), args[1]); break;
    case 'mcp': if (event.sender !== main.webContents) throw new Error('Only the settings window can do this.'); return mcp.handle(args[0]);
    case 'open-crop': await openView('crop', id); break;
    case 'open-compare': await openView('compare', id); break;
    case 'open-preview': await openView('preview', id); break;
    case 'card-menu': await cardMenu(event.sender, cardIds(args[0]), args[1]); break;
    case 'card-action': await runCard(event.sender, cardIds(args[0]), args[1]); break;
    case 'crop-source': return cropSource(engine.get(id), parseCropView(args[1]), media);
    case 'crop': await applyCrop(engine, id, parseCropRequest(args[1], engine.get(id).result.kind)); if (copiesBack(id)) await copy([id]); break;
    case 'crop-sizes': return settings.savedCropSizes;
    case 'save-crop-sizes': settings = await store.set({ savedCropSizes: parseSavedCropSizes(args[0]) }); broadcast(); return settings.savedCropSizes;
    case 'compare-sources': return compareSources(engine.get(id), parseCompareView(args[1]), media);
    // The picker-backed and list-editing settings actions come only from the Settings window.
    case 'prefs': if (event.sender !== main.webContents) throw new Error('Only the settings window can do this.'); return prefs(args[0]);
    case 'window':
      switch (args[0]) {
        case 'hide': BrowserWindow.fromWebContents(event.sender)?.hide(); break;
        case 'close': BrowserWindow.fromWebContents(event.sender)?.close(); break;
        case 'minimize': BrowserWindow.fromWebContents(event.sender)?.minimize(); break;
        case 'main': main.show(); break;
        case 'editor': await openEditor(); break;
        case 'presets': await openEditor('zones'); break;
        case 'float': showLatest(); break;
        case 'interactive': hovered = true; floating.setIgnoreMouseEvents(false); break;
        case 'select': selecting = true; break;
        case 'unselect': selecting = false; break;
        case 'passthrough': hovered = false; if (!dropActive) floating.setIgnoreMouseEvents(true, { forward: true }); break;
        case 'dismiss-notice': notice = undefined; syncFloating(); broadcast(); break;
        case 'finish-welcome': await updateSettings({ finishedOnboarding: true }); break;
        case 'quit': app.quit(); break;
        default: throw new Error('Unknown window action.');
      } break;
    default: throw new Error('Unknown Clop action.');
  }
});
// The editor window may only ask for the pipeline editor's state and send its commands, which `EditorService` checks.
const editor = new EditorService({ settings: () => store.get(), update: change => store.update(change), context: () => ({ home }) });
ipcMain.handle('clop:editor', (event, action: string, command?: unknown) => {
  const known = [editorWindow, editorLoading?.window].find(window => window && !window.isDestroyed() && window.webContents === event.sender);
  if (!known) throw new Error('Untrusted window.');
  if (action === 'state') return editor.state();
  if (action === 'command') return editor.command(command);
  throw new Error('Unknown editor action.');
});
ipcMain.on('clop:drag', (event, id: string) => {
  if (!trusted(event.sender)) return;
  try {
    const file = engine.output(id);
    // On Windows the drag runs inside this call, so it returns once the drop is over.
    event.sender.startDrag({ file, icon: nativeImage.createFromDataURL(engine.get(id).result.preview).resize({ width: 96 }) });
    const dismissOnDrop = compactMode.compact ? settings.dismissCompactResultOnDrop : settings.dismissFloatingResultOnDrop;
    // Electron does not say whether the drop landed; one that ends away from the results counts, as dropping on another app does on macOS.
    const over = () => { const point = screen.getCursorScreenPoint(), box = floating.getBounds(); return point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height; };
    if (dismissOnDrop && process.platform === 'win32') setTimeout(() => { if (engine.has(id) && !over()) void dismiss(id); }, 250);
  } catch (error) { inform(message(error)); }
});
// `clop://` links wait until the app is up: a second instance can pass one before the windows exist.
const linkQueue = linkInbox(link => { void openClopURL(link).catch(error => inform(message(error))); });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    // Explorer's right-click verbs: one launch per selected file, answered once the selection is complete.
    const picked = explorerVerb(argv);
    if (picked) { collectVerb(picked.verb, picked.files); return; }
    const links = clopURLs(argv);
    if (links.length) { linkQueue.receive(links); return; }
    // Without the tray icon there is no menu to open, so another launch opens Settings.
    if (engine) { if (tray) showLatest(); else showSettings(); }
    const files = argv.filter(arg => path.isAbsolute(arg) && mediaKind(arg));
    if (files.length) void importFiles(files, 'file').catch(error => inform(message(error)));
  });
  app.whenReady().then(async () => {
    setupWatchdog();
    Menu.setApplicationMenu(null);
    const userData = app.getPath('userData');
    store = new SettingsStore(path.join(userData, 'settings.json'), { home: app.getPath('home'), desktop: app.getPath('desktop'), userData });
    // Watching guards against apps that rewrite many files in its first seconds on the first launch.
    const firstLaunch = !await stat(store.file).then(() => true, () => false);
    // An unreadable settings file is left alone; the defaults are used and the reason is shown once the windows exist.
    let settingsError: unknown;
    settings = await store.load().catch(error => { settingsError = error; return store.get(); });
    // The built-in pipelines join the library once per version. Not over a settings file that could not be read: saving would replace it.
    if (!settingsError) settings = await store.update(current => ({ patch: seedBuiltinPipelines(current.savedPipelines, current.builtinPipelinesSeededVersion), result: undefined })).then(reply => reply.settings, error => { settingsError = error; return settings; });
    mirrorConsoleToFile(path.join(userData, 'logs', 'clop.log'), () => settings.persistDebugLogs);
    const paths = { home: app.getPath('home'), desktop: app.getPath('desktop'), userData };
    updates = setupUpdates({ settings: () => settings, portable: isPortable(), releases: () => shell.openExternal(LINKS.releases), inform });
    saveDump = setupDebugDump({ settings: () => settings, userData, workdir: () => workdir?.root ?? settings.workdir, portable: isPortable() });
    prefs = createPrefs({
      settings: () => settings, defaults: () => defaultSettings(paths), set: async partial => { await updateSettings(partial); }, home: paths.home,
      chooseFolder: async (title, defaultPath) => { const picked = await dialog.showOpenDialog(main, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] }); return picked.canceled ? undefined : picked.filePaths[0]; },
      chooseProgram: async title => { const picked = await dialog.showOpenDialog(main, { title, properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : [] }); return picked.canceled ? undefined : picked.filePaths[0]; },
      apps: async () => bridgeReady ? appsReply(await bridge.request({ type: 'apps' })) : [],
      openEditor: tab => openEditor(tab),
      openExternal: url => shell.openExternal(url), version: () => ({ name: app.getVersion(), platform: process.platform }),
      checkUpdates: () => updates.check(), saveDebugDump: () => saveDump(),
    });
    mcp = mcpSettings({
      userData, home: app.getPath('home'), cliPath: mcpServerPath(), missing: mcpServerMissing(), version: app.getVersion(), appPath: process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath,
      setSwitches: updateSettings, switches: () => settings, confirmScripts, reveal: file => shell.showItemInFolder(file), copy: text => clipboard.writeText(text),
    });
    // Earlier versions kept originals in `images`. It ages out with the cleanup interval instead of being migrated.
    const open = async (root: string) => new Workdir(root, { home: app.getPath('home'), legacy: [path.join(userData, 'images')] }).ensure();
    workdir = await open(settings.workdir).catch(async error => {
      workdirProblem = `Clop cannot use the working directory ${settings.workdir}: ${message(error)} Using the default folder instead.`;
      return open(path.join(userData, 'work'));
    });
    // The running session's files stay until the next start, however short the cleanup interval is.
    const session = sessionDir = path.join(workdir.temp, `session-${Date.now()}`);
    workdir.protect(session);
    stopCleaner = workdir.startCleaner(() => store.get('workdirCleanupInterval'));
    engine = new ItemEngine(session, () => settings);
    media = new MediaFiles([session]);
    protocol.handle(MEDIA_SCHEME, request => media.handle(request));
    engine.on('change', () => { syncFloating(); broadcast(); });
    engine.on('ready', (id: string) => { if (quiet.has(id)) return; hidden.delete(id); scheduleHide(id); syncFloating(); broadcast(); });
    engine.on('add', (id: string) => lastBatch.add(id));
    await createWindows();
    if (settingsError) inform(message(settingsError));
    if (workdirProblem) inform(workdirProblem);
    marker = new OptimisedMarker(path.join(userData, 'optimised.json'));
    home = app.getPath('home');
    folders = new FolderResults({
      engine, settings: () => settings, home, options: () => defaults(), makeRoom, quiet: quietResult, automation: folderAutomation,
      env: () => ({ settings, workdir, marker, home, counter: nameCounter ??= { value: settings.lastAutoIncrementingNumber } }),
      saved: value => { store.set({ lastAutoIncrementingNumber: value }).catch(error => inform(message(error))); },
    });
    // A cloud-only OneDrive placeholder would download when read, so watched folders and batches leave it alone.
    // Watched folders wait for the helper on Windows, as reading a placeholder downloads it; a batch is what the user asked for.
    const isLocal = (strict: boolean) => (file: string) => localFile(file, bridgeReady ? paths => bridge.request({ type: 'attributes', paths }) : undefined, !(strict && process.platform === 'win32'));
    watchers = (['image', 'video', 'pdf', 'audio'] as const).map(kind => new FolderWatcher(kind, {
      // The stream hint moves with a renamed file, which the cache keyed by path cannot follow; it counts while the size is unchanged.
      settings: () => settings, home, firstLaunch, owns: file => workdir.owns(file), isOptimised: async file => await marker.isOptimised(file) || await marker.hintMatches(file),
      isLocal: isLocal(true), helper: () => bridgeReady || process.platform !== 'win32' ? 'ready' : bridgeStopped ? 'stopped' : 'starting',
      handle: (file, dir) => folders.optimise(file, kind, dir), cancel: files => folders.cancel(files), notice: inform,
      disable: () => toggleSetting({ [enabledKey(kind)]: false }),
    }));
    const counter = () => nameCounter ??= { value: settings.lastAutoIncrementingNumber };
    const saveCounter = (value: number) => { store.set({ lastAutoIncrementingNumber: value }).catch(error => inform(message(error))); };
    batch = setupBatch({ here, devUrl, webPreferences, created: syncNative, quitting: () => quitting, settings: () => settings, owns: file => workdir.owns(file), isLocal: isLocal(false), env: () => ({ settings: () => settings, workdir, marker, home, counter: counter(), saved: saveCounter }) });
    store.on('change', (next, changed) => {
      settings = next; for (const watcher of watchers) void watcher.update();
      if (changed.some(key => ['keyComboModifiers', 'enabledKeys', 'quickResizeKeys', 'allowClopToAppearInScreenshots'].includes(key))) applyWindowSettings();
      // A change made outside the app (the settings file, the CLI) shows or hides the tray icon and updates its menu and icon too.
      if (changed.some(key => ['showMenubarIcon', 'pauseAutomaticOptimisations', 'enableClipboardOptimiser', 'keepDropZoneVisible'].includes(key))) updateTray();
      // Pipelines, attachments and preset zones show in the editor and, as tiles, on the drop target.
      if (changed.some(key => (EDITOR_SETTING_KEYS as readonly string[]).includes(key))) { syncFloating(); broadcast(); for (const window of [editorWindow, editorLoading?.window]) if (window && !window.isDestroyed()) window.webContents.send('clop:editor-changed'); }
    });
    for (const watcher of watchers) void watcher.update();
    // The `clop` command can change this while the app is closed.
    if (app.isPackaged && process.platform === 'win32') syncLoginItem(app, settings.launchAtLogin, process.execPath, true);
    updateTray();
    shortcuts = new ShortcutRegistry(globalShortcut, action => guarded(() => runShortcut(action), reportFailure));
    applyWindowSettings();
    if (process.platform === 'win32') {
      bridge.on('ready', () => { bridgeReady = true; bridgeStopped = false; for (const watcher of watchers) watcher.resume(); void bridge.request(nativeSettings()).then(() => { if (settings.enableClipboardOptimiser) void optimiseClipboard(); }).catch(error => inform(message(error))); });
      bridge.on('clipboard', event => {
        const change = clipboardChange(event);
        if (change && (change.owner || change.aumid)) lastCopier = { owner: change.owner, aumid: change.aumid };
        if (!settings.enableClipboardOptimiser || paused()) return;
        // A copy by an ignored app is left alone, so it neither waits in the pickup nor counts towards an editing session.
        if (change) { if (ignoredApp(change, settings.clipboardIgnoredAppBundleIds)) pickup.cancel(); else pickup.change(change); } else inform('The Windows helper sent an unreadable clipboard change.');
      });
      bridge.on('foreground', event => pickup.focus(Number(event.process)));
      bridge.on('drag-start', event => {
        if (!settings.enableDragAndDrop) return;
        dragging = true; dropActive = true; presetReveal.reset(); presetsLatched = false;
        dragFiles = Array.isArray(event.paths) ? (event.paths as unknown[]).filter((file): file is string => typeof file === 'string').slice(0, 64) : [];
        floating.setIgnoreMouseEvents(false); syncFloating(); broadcast();
      });
      // The helper reads Ctrl and Alt while a drag lasts; holding either shows the preset zone tiles, or tapping it with `onlyShowPresetZonesOnControlTapped`.
      bridge.on('drag-modifiers', event => {
        if (!dragging) return;
        presetReveal.update({ ctrl: event.ctrl === true, alt: event.alt === true }, settings.onlyShowPresetZonesOnControlTapped); presetsLatched ||= presetsRevealed(); syncFloating(); broadcast();
      });
      // The tiles stay for the moment a drop on one needs to land.
      bridge.on('drag-end', () => { dragging = false; setTimeout(() => { if (!dragging) { dropActive = false; dragFiles = []; presetReveal.reset(); presetsLatched = false; syncFloating(); broadcast(); } }, 180); });
      bridge.on('notice', inform);
      bridge.on('stopped', () => { bridgeReady = false; bridgeStopped = true; pickup.cancel(); startClipboardFallback(); for (const watcher of watchers) watcher.resume(); });
      bridge.start(path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'native', 'bridge.ps1'));
    } else startClipboardFallback();
    // Requests can change settings, which updates the tray and the windows, so the pipe opens once they exist.
    await serveCLI(userData).catch(error => inform(`The clop command cannot reach Clop: ${message(error)}`));
    // An installed copy owns clop:// links; a portable copy only takes them when nothing else has.
    const exe = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath;
    if (app.isPackaged && process.platform === 'win32' && (!isPortable() || !app.getApplicationNameForProtocol('clop://') || app.isDefaultProtocolClient('clop', exe))) app.setAsDefaultProtocolClient('clop', exe);
    if (app.isPackaged) {
      void mcp.writeCard().catch(error => console.warn(`Could not write the MCP server card: ${message(error)}`));
      void mcp.repair().then(names => { if (names.length) console.log(`Repointed Clop's MCP server in ${names.join(', ')}`); }, error => console.warn(`Could not check the MCP clients: ${message(error)}`));
    }
    if (isPortable() && (cliInstalled = await portableCLIInstalled())) { updateTray(); void refreshPortableCLI(process.resourcesPath, path.dirname(process.execPath)).catch(error => inform(message(error))); }
    linkQueue.receive(clopURLs(process.argv.slice(1)));
    linkQueue.ready();
    const picked = explorerVerb(process.argv.slice(1));
    if (picked) collectVerb(picked.verb, picked.files);
    else {
      const files = process.argv.slice(1).filter(arg => path.isAbsolute(arg) && mediaKind(arg));
      if (files.length) await importFiles(files, 'file');
    }
    // The portable app may have been moved since the entries were added: they are written again, but only then, and never over the installer's.
    if (isPortable()) {
      const status = await verbsStatus(portablePaths());
      explorerInstalled = status !== 'none';
      if (status === 'moved') void installVerbs(portablePaths()).catch(error => console.warn(`Could not refresh the Explorer menu entries: ${message(error)}`));
      if (explorerInstalled) updateTray();
    }
    if (app.isPackaged) stopUpdates = updates.start();
  }).catch(error => { dialog.showErrorBox('Clop could not start', message(error)); app.quit(); });
  app.on('before-quit', event => {
    // A running batch is stopped, and quitting waits (briefly) for its files to settle: one being placed has moved its original aside.
    const settling = batch?.host.stop();
    if (settling && !batchSettled) { event.preventDefault(); void Promise.race([settling, new Promise(resolve => setTimeout(resolve, 15_000))]).finally(() => { batchSettled = true; app.quit(); }); }
    if (quitting) return;
    quitting = true; stopUpdates?.(); for (const collector of verbCollectors.values()) collector.cancel(); withdrawPipe?.(); void pipe?.close(); engine?.abort(); for (const watcher of watchers) void watcher.close(); stopCleaner?.(); pickup.cancel(); if (clipboardTimer) clearInterval(clipboardTimer); for (const timer of hideTimers.values()) clearTimeout(timer); bridge.stop(); globalShortcut.unregisterAll(); });
  app.on('window-all-closed', () => { if (quitting) app.quit(); });
  app.on('activate', () => { if (engine) showLatest(); });
}
