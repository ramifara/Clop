import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { appInfo, binariesReport, writeDump } from '../core/debug-dump';
import type { ClopSettings } from '../core/settings/schema';
import { hasTool, TOOL_NAMES, toolPath } from '../core/tools';
import { recentConsole } from './debug-log';
import { loadAutoUpdater, Updates } from './updates';
import { Watchdog, type WatchdogAction } from './watchdog';

// What keeps Clop supportable (spec step 40): update checks and their prompts, the debug dump, and the watchdog that notices a window
// that stopped responding. None of it sends anything anywhere; the only network use is the update check, which `updates.ts` gates.

export interface UpdatesHost {
  settings(): ClopSettings;
  /** The portable app cannot install an update itself: it sends the user to the releases page. */
  portable: boolean;
  releases(): Promise<void>;
  inform(text: string): void;
}

/** The update check and its dialogs. `check` is the tray's and the Settings window's button; `start` begins the daily check. */
export function setupUpdates(host: UpdatesHost) {
  const updates = new Updates({
    env: () => ({ packaged: app.isPackaged, platform: process.platform, enabled: host.settings().checkForUpdates, beta: host.settings().betaUpdates }),
    load: loadAutoUpdater, version: app.getVersion(), log: text => console.warn(text),
  });
  let offered: string | undefined, open: { version: string; done: Promise<void> } | undefined;
  /** The offer dialog for `version`. A second ask for the same version while it is open (the daily check and a button) shares it. */
  function offer(version: string) {
    if (open?.version === version) return open.done;
    offered = version;
    const done = showOffer(version).finally(() => { if (open?.done === done) open = undefined; });
    open = { version, done };
    return done;
  }
  async function showOffer(version: string) {
    const detail = `You have version ${app.getVersion()}.`;
    if (host.portable) {
      const { response } = await dialog.showMessageBox({ type: 'info', buttons: ['Open the releases page', 'Later'], defaultId: 0, cancelId: 1, title: 'Clop', message: `Clop ${version} is available`, detail: `${detail}\n\nThe portable app cannot update itself. Download the new portable build from the releases page. Builds are not code-signed yet, so Windows SmartScreen may warn about the download: choose More info, then Run anyway.` });
      if (response === 0) await host.releases();
      return;
    }
    const { response } = await dialog.showMessageBox({ type: 'info', buttons: ['Download and install', 'See what changed', 'Later'], defaultId: 0, cancelId: 2, title: 'Clop', message: `Clop ${version} is available`, detail: `${detail}\n\nClop downloads the update and restarts to install it.` });
    if (response === 1) { await host.releases(); return; }
    if (response !== 0) return;
    host.inform(`Downloading Clop ${version}…`);
    await updates.install();
  }
  const report = (error: unknown) => host.inform(error instanceof Error ? error.message : String(error));
  return {
    /** Checks now and says the outcome; a new version opens the offer. Returns the message for the other outcomes. */
    async check(): Promise<string | undefined> {
      const result = await updates.check();
      if (result.kind === 'available') { await offer(result.version); return undefined; }
      return result.kind === 'current' ? `Clop ${result.version} is up to date.` : result.message;
    },
    /** Checks soon after start and daily; a version is offered once per run. Returns what stops it. */
    start: () => updates.schedule(version => { if (offered !== version) void offer(version).catch(report); }),
  };
}

export interface DumpHost {
  settings(): ClopSettings;
  userData: string;
  workdir(): string;
  portable: boolean;
}
/** `Save debug dump`: writes the zip beside the app's data and shows it in Explorer. One at a time. */
export function setupDebugDump(host: DumpHost) {
  let running: Promise<string> | undefined;
  return function save(): Promise<string> {
    return running ??= (async () => {
      const file = await writeDump(path.join(host.userData, 'debug'), {
        info: appInfo({
          version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch,
          os: `${os.version()} ${os.release()}`, packaged: app.isPackaged, portable: host.portable, locale: app.getLocale(), workdir: host.workdir(), created: new Date(), settingsFile: path.join(host.userData, 'settings.json'),
        }),
        settings: host.settings(), binaries: binariesReport(TOOL_NAMES.map(name => ({ name, path: hasTool(name) ? toolPath(name) : undefined }))),
        recent: recentConsole(), logs: path.join(host.userData, 'logs'),
      });
      shell.showItemInFolder(file);
      return file;
    })().finally(() => { running = undefined; });
  };
}

/** Logs a window that stops responding or a blocked main process, and offers to reload the window. Call once, before the windows are made. */
export function setupWatchdog() {
  const dog = new Watchdog(), offers = new Map<string, AbortController>();
  const act = (window: BrowserWindow | undefined, actions: WatchdogAction[]) => {
    for (const action of actions) {
      if (action.kind === 'log') { (action.level === 'warn' ? console.warn : console.log)(action.text); continue; }
      if (action.kind === 'withdraw-offer') { offers.get(action.window)?.abort(); continue; }
      if (!window || window.isDestroyed()) continue;
      const id = action.window, abort = new AbortController();
      offers.set(id, abort);
      dialog.showMessageBox({ type: 'warning', buttons: ['Reload window', 'Keep waiting'], defaultId: 0, cancelId: 1, title: 'Clop', message: 'A Clop window is not responding', detail: 'Reload it to get going again. Other windows are not affected.', signal: abort.signal })
        .then(({ response }) => {
          // A withdrawn offer (the window recovered or closed) answers like "Keep waiting", but nobody chose it.
          if (abort.signal.aborted) return;
          if (response === 0 && !window.isDestroyed()) { dog.closed(id); window.webContents.forcefullyCrashRenderer(); window.webContents.reload(); } else dog.declined(id, Date.now());
        }, () => {}).finally(() => { if (offers.get(id) === abort) offers.delete(id); });
    }
  };
  app.on('browser-window-created', (_event, window) => {
    const id = String(window.id), label = () => `${window.getTitle() || 'Clop'} (${id})`;
    window.on('unresponsive', () => act(window, dog.unresponsive(id, Date.now(), label())));
    window.on('responsive', () => act(window, dog.responsive(id, Date.now())));
    window.on('closed', () => { offers.get(id)?.abort(); dog.closed(id); });
    window.webContents.on('render-process-gone', (_e, details) => console.warn(`The ${label()} window's renderer stopped: ${details.reason} (exit code ${details.exitCode}).`));
  });
  // A sleeping PC stops the timer, which is not a blocked app.
  powerMonitor.on('resume', () => dog.resume());
  setInterval(() => act(undefined, dog.sample(Date.now())), 500).unref();
}
