import os from 'node:os';
import path from 'node:path';
import { appAnswers, AppNotResponding, appPipe, ForgedServer, postMessage, sendMessage } from '../core/ipc/client';
import type { OptimisationRequest, PipeEndpoint, ServerMessage, SettingsRequest, SettingsResponse, StopOptimisationRequest } from '../core/ipc/protocol';
import { ClopService } from '../core/ipc/service';
import { handleSettingsRequest } from '../core/ipc/settings';
import { OptimisedMarker } from '../core/marker';
import { defaultPaths } from '../core/settings/paths';
import { SettingsStore } from '../core/settings/store';
import { watchedFolders } from '../core/pipeline/app-resolve';
import { run } from '../core/run';
import { shellEffects } from '../core/shell-effects';
import { regExe } from '../core/shell-verbs';
import { Workdir } from '../core/workdir';

// Where a command's work happens: in the running app over the pipe, so results show up there and settings changes
// apply at once, or in this process through the same service when the app is not running (spec: headless via core).

export interface Backend {
  /** True when the running app does the work. */
  readonly app: boolean;
  optimise(request: OptimisationRequest, onMessage: (message: ServerMessage) => void): Promise<void>;
  /** Hands a request to the running app without waiting for it (`--async`). */
  queue(request: OptimisationRequest): Promise<void>;
  stop(request: StopOptimisationRequest): Promise<void>;
  settings(request: SettingsRequest): Promise<SettingsResponse>;
}

const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
/** The Desktop a `reg query` of Explorer's `User Shell Folders` names, its `%VARIABLES%` expanded; undefined when it names none or one is unknown. */
export function registryDesktop(output: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = /^\s*Desktop\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/mi.exec(output)?.[1];
  if (!value) return undefined;
  const lookup = (name: string) => env[name] ?? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const expanded = value.replace(/%([^%]+)%/g, (whole, name: string) => lookup(name) ?? whole);
  return /%[^%]+%/.test(expanded) || !path.win32.isAbsolute(expanded) ? undefined : expanded;
}
/**
 * The Desktop the app's defaults use (`app.getPath('desktop')`), which Known Folder Move puts under OneDrive: read from Explorer's
 * `User Shell Folders` on Windows, so a settings file the command line creates watches the same folder the app would.
 */
export async function desktopFolder(home: string, platform: NodeJS.Platform = process.platform, query = () => run(regExe(), ['query', SHELL_FOLDERS, '/v', 'Desktop'], { timeoutMs: 5000 }).then(result => result.stdout.toString('utf8'))): Promise<string> {
  const fallback = path.join(home, 'Desktop');
  if (platform !== 'win32') return fallback;
  return registryDesktop(await query().catch(() => ''), process.env) ?? fallback;
}

export interface BackendOptions {
  /** `%APPDATA%\Clop for Windows`: where the app keeps its settings and publishes its pipe. */
  userData: string;
  home: string;
}

export function backendOptions(env: NodeJS.ProcessEnv = process.env): BackendOptions {
  const paths = defaultPaths();
  return { userData: env.CLOP_USER_DATA || paths.userData, home: os.homedir() };
}

/** As the app does: a working directory that cannot be used falls back to the default one. */
export async function openWorkdir(chosen: string, { userData, home }: BackendOptions): Promise<Workdir> {
  return new Workdir(chosen, { home }).ensure().catch(() => new Workdir(path.join(userData, 'work'), { home }).ensure());
}

class AppBackend implements Backend {
  readonly app = true;
  constructor(private readonly pipe: PipeEndpoint) {}
  optimise(request: OptimisationRequest, onMessage: (message: ServerMessage) => void) { return sendMessage(this.pipe, { kind: 'optimise', request }, onMessage); }
  queue(request: OptimisationRequest) { return postMessage(this.pipe, { kind: 'optimise', request }); }
  stop(request: StopOptimisationRequest) { return sendMessage(this.pipe, { kind: 'stop', request }); }
  async settings(request: SettingsRequest) {
    let response: SettingsResponse | undefined;
    await sendMessage(this.pipe, { kind: 'settings', request }, message => { if (message.kind === 'settings') response = message.response; });
    if (!response) throw new Error('Clop did not answer.');
    return response;
  }
}

class HeadlessBackend implements Backend {
  readonly app = false;
  private service?: Promise<ClopService>;
  private store?: Promise<SettingsStore>;
  /** `appBusy`: the app is running but did not answer, so a settings change written here would be lost to its next save. */
  constructor(private readonly options: BackendOptions, private readonly appBusy = false) {}

  private loadStore() {
    const { userData, home } = this.options;
    return this.store ??= (async () => {
      const store = new SettingsStore(path.join(userData, 'settings.json'), { home, desktop: await desktopFolder(home), userData }, true);
      await store.load();
      return store;
    })();
  }

  private loadService() {
    return this.service ??= (async () => {
      const store = await this.loadStore(), { home, userData } = this.options;
      const workdir = await openWorkdir(store.get('workdir'), this.options);
      // Programs by path are only for the user's own pipelines, and never from a watched folder, as in the app.
      // Without the app nobody is asked before a folder goes to the Recycle Bin: only a person's --delete-folders allows it.
      const effects = (options: { allowExe: boolean; origin?: string; deleteFolders: boolean }) => shellEffects({ ...options, watched: watchedFolders(store.get(), home) });
      return new ClopService({ store, workdir, effects, copyFiles: files => shellEffects().copyFiles(files), marker: new OptimisedMarker(path.join(userData, 'optimised.json')), home });
    })();
  }

  async optimise(request: OptimisationRequest, onMessage: (message: ServerMessage) => void) { await (await this.loadService()).optimise(request, onMessage); }
  /** Without the app the work happens in this process, so headless `--async` starts a detached copy of the command instead. */
  async queue(): Promise<void> { throw new Error('Queueing needs the running app.'); }
  async stop(request: StopOptimisationRequest) { (await this.loadService()).stop(request); }
  /** Settings need no work directory, so a settings command never creates one. */
  async settings(request: SettingsRequest): Promise<SettingsResponse> {
    if (this.appBusy && (request.action === 'set' || request.action === 'update')) return { ok: false, error: 'Clop is running but not answering, so the settings were not changed: the app would write over a change made here. Try again once it responds, or quit Clop and run the command again.' };
    return handleSettingsRequest(request, await this.loadStore());
  }
}

/**
 * The running app's backend when it answers and proves it is the app, otherwise this process's own. A published pipe
 * that answers without proof (a stale name someone else took) gets nothing; `warn` says so and the work runs here. A
 * pipe that is held but silent is most likely the app itself, busy or hung: the work runs here too, but settings are
 * not changed behind its back.
 */
export async function connectBackend(options: BackendOptions, warn: (text: string) => void = () => {}): Promise<Backend> {
  const endpoint = await appPipe(options.userData);
  if (endpoint) {
    try { if (await appAnswers(endpoint)) return new AppBackend(endpoint); } catch (error) {
      if (!(error instanceof ForgedServer || error instanceof AppNotResponding)) throw error;
      warn(`${error.message} Running here instead.\n`);
      if (error instanceof AppNotResponding) return new HeadlessBackend(options, true);
    }
  }
  return new HeadlessBackend(options);
}
