import os from 'node:os';
import path from 'node:path';
import { appAnswers, appPipe, ForgedServer, postMessage, sendMessage } from '../core/ipc/client';
import type { OptimisationRequest, PipeEndpoint, ServerMessage, SettingsRequest, SettingsResponse, StopOptimisationRequest } from '../core/ipc/protocol';
import { ClopService } from '../core/ipc/service';
import { handleSettingsRequest } from '../core/ipc/settings';
import { OptimisedMarker } from '../core/marker';
import { defaultPaths } from '../core/settings/paths';
import { SettingsStore } from '../core/settings/store';
import { shellEffects } from '../core/shell-effects';
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

export interface BackendOptions {
  /** `%APPDATA%\Clop for Windows`: where the app keeps its settings and publishes its pipe. */
  userData: string;
  home: string;
}

export function backendOptions(env: NodeJS.ProcessEnv = process.env): BackendOptions {
  const paths = defaultPaths();
  return { userData: env.CLOP_USER_DATA || paths.userData, home: os.homedir() };
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
  constructor(private readonly options: BackendOptions) {}

  private loadStore() {
    const { userData, home } = this.options;
    return this.store ??= (async () => {
      const store = new SettingsStore(path.join(userData, 'settings.json'), { home, desktop: path.join(home, 'Desktop'), userData });
      await store.load();
      return store;
    })();
  }

  private loadService() {
    return this.service ??= (async () => {
      const store = await this.loadStore(), { home, userData } = this.options;
      // As the app does: a working directory that cannot be used falls back to the default one.
      const workdir = await new Workdir(store.get('workdir'), { home }).ensure().catch(() => new Workdir(path.join(userData, 'work'), { home }).ensure());
      const effects = shellEffects();
      return new ClopService({ store, workdir, effects, copyFiles: files => effects.copyFiles(files), marker: new OptimisedMarker(path.join(userData, 'optimised.json')), home });
    })();
  }

  async optimise(request: OptimisationRequest, onMessage: (message: ServerMessage) => void) { await (await this.loadService()).optimise(request, onMessage); }
  /** Without the app the work happens in this process, so headless `--async` starts a detached copy of the command instead. */
  async queue(): Promise<void> { throw new Error('Queueing needs the running app.'); }
  async stop(request: StopOptimisationRequest) { (await this.loadService()).stop(request); }
  /** Settings need no work directory, so a settings command never creates one. */
  async settings(request: SettingsRequest) { return handleSettingsRequest(request, await this.loadStore()); }
}

/**
 * The running app's backend when it answers and proves it is the app, otherwise this process's own. A published pipe
 * that answers without proof (a stale name someone else took) gets nothing; `warn` says so and the work runs here.
 */
export async function connectBackend(options: BackendOptions, warn: (text: string) => void = () => {}): Promise<Backend> {
  const endpoint = await appPipe(options.userData);
  if (endpoint) {
    try { if (await appAnswers(endpoint)) return new AppBackend(endpoint); } catch (error) {
      if (!(error instanceof ForgedServer)) throw error;
      warn(`${error.message} Running here instead.\n`);
    }
  }
  return new HeadlessBackend(options);
}
