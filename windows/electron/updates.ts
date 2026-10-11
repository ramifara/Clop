// Update checks (spec step 40): electron-updater against this fork's GitHub Releases (`v<version>` tags; a beta channel is the
// releases marked as prereleases). This is the only time Clop contacts the internet by itself, so every path to the network goes through
// `updateGate`: never from a development or unpackaged run, never off Windows, never when the `checkForUpdates` setting is off.
// electron-updater is loaded only after the gate lets a check through. Nothing is downloaded until the user says so.

export interface UpdateEnv {
  /** `app.isPackaged`. */
  packaged: boolean;
  platform: NodeJS.Platform;
  /** The `checkForUpdates` setting. */
  enabled: boolean;
}
export type UpdateGate = { ok: true } | { ok: false; why: 'development' | 'platform' | 'disabled'; message: string };

export function updateGate({ packaged, platform, enabled }: UpdateEnv): UpdateGate {
  if (!packaged) return { ok: false, why: 'development', message: 'Development builds do not check for updates.' };
  if (platform !== 'win32') return { ok: false, why: 'platform', message: 'Updates are only checked on Windows.' };
  if (!enabled) return { ok: false, why: 'disabled', message: 'Checking for updates is turned off. Turn it on in Settings, Updates.' };
  return { ok: true };
}

/** The part of electron-updater's `AppUpdater` that Clop uses. */
export interface UpdateDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo: { version: string } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export type UpdateResult =
  | { kind: 'skipped'; why: Extract<UpdateGate, { ok: false }>['why']; message: string }
  | { kind: 'current'; version: string }
  | { kind: 'available'; version: string }
  | { kind: 'error'; message: string };

export interface UpdatesOptions {
  env(): UpdateEnv & { beta: boolean };
  /** Loads electron-updater's `autoUpdater`. Called only once a check is allowed. */
  load(): Promise<UpdateDriver>;
  /** The running version, to tell "up to date" from "available". */
  version: string;
  log(text: string): void;
  /** Resolves once nothing that must not be cut short is under way (a placement that moved an original aside), so the installer does not close Clop in the middle of it. */
  settle?(): Promise<void>;
}

const DAY = 24 * 60 * 60 * 1000, FIRST_CHECK = 30_000;

export class Updates {
  private driver?: Promise<UpdateDriver>;
  private checking?: Promise<UpdateResult>;
  private available?: string;
  constructor(private readonly options: UpdatesOptions) {}

  private async configured() {
    const driver = await (this.driver ??= this.options.load());
    // The user decides about downloading and installing; a check only looks.
    driver.autoDownload = false; driver.autoInstallOnAppQuit = false; driver.allowDowngrade = false;
    driver.allowPrerelease = this.options.env().beta;
    return driver;
  }

  /** Asks GitHub Releases whether a newer version exists. Gated like every check; a check already running is joined, not repeated. */
  check(): Promise<UpdateResult> {
    const gate = updateGate(this.options.env());
    if (!gate.ok) return Promise.resolve({ kind: 'skipped', why: gate.why, message: gate.message });
    return this.checking ??= (async (): Promise<UpdateResult> => {
      try {
        const result = await (await this.configured()).checkForUpdates();
        // electron-updater answers null when this build has no update configuration (it is not an installed or portable build made with `publish` set).
        if (!result) { this.options.log('Update check skipped: this build has no update configuration.'); return { kind: 'error', message: 'This build cannot check for updates.' }; }
        const version = result.updateInfo.version;
        if (!version || result.isUpdateAvailable === false || version === this.options.version) return { kind: 'current', version: this.options.version };
        this.available = version;
        return { kind: 'available', version };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.log(`Update check failed: ${message}`);
        return { kind: 'error', message: 'Could not check for updates. Check your connection and try again.' };
      } finally { this.checking = undefined; }
    })();
  }

  /** Downloads the version `check` found and restarts into it. */
  async install() {
    if (!this.available) throw new Error('Check for updates first.');
    const gate = updateGate(this.options.env());
    if (!gate.ok) throw new Error(gate.message);
    const driver = await this.configured();
    await driver.downloadUpdate();
    await this.options.settle?.();
    driver.quitAndInstall(false, true);
  }

  /** Checks shortly after start and once a day after. Calls `found` for a new version. Returns what stops it. */
  schedule(found: (version: string) => void, { first = FIRST_CHECK, every = DAY, timers = { setTimeout, clearTimeout } as Timers } = {}): () => void {
    let handle: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const next = (delay: number) => {
      handle = timers.setTimeout(async () => {
        const result = await this.check();
        if (stopped) return;
        if (result.kind === 'available') found(result.version);
        next(every);
      }, delay);
      handle?.unref?.();
    };
    next(first);
    return () => { stopped = true; if (handle) timers.clearTimeout(handle); };
  }
}
interface Timers { setTimeout(run: () => void, delay: number): ReturnType<typeof setTimeout>; clearTimeout(handle: ReturnType<typeof setTimeout>): void }

/**
 * electron-updater's `autoUpdater`, loaded when first needed so a run that never checks never loads it. The package is CommonJS and defines
 * `autoUpdater` as a getter Node cannot see from ESM, so it comes from the default export.
 */
export const loadAutoUpdater = async (): Promise<UpdateDriver> => {
  const module = await import('electron-updater');
  return (module.default ?? module).autoUpdater as unknown as UpdateDriver;
};
