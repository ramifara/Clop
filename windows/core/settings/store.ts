import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { retryBusy } from '../run';
import type { DefaultPaths } from './paths';
import { SETTING_KEYS, defaultSettings, isLegacySettings, migrateLegacy, parseSettings, type ClopSettings, type SettingKey } from './schema';

const LOCK_STALE_MS = 30_000, LOCK_WAIT_MS = 15_000;
const reason = (error: unknown) => (error as NodeJS.ErrnoException).code ?? (error as Error).message;

/** Settings persisted as JSON. Every value is replaced, never mutated, so `get()` snapshots stay stable. */
export class SettingsStore extends EventEmitter<{ change: [settings: ClopSettings, changed: SettingKey[]] }> {
  private current: ClopSettings;
  private queue: Promise<unknown> = Promise.resolve();
  /** Set when the file exists but could not be read or moved aside; saving would destroy it. */
  private unreadable?: Error;
  /**
   * `shared`: other processes write this file too (the headless CLI and MCP server, next to a terminal command or another server).
   * Each change then starts from the file as it is when its turn comes, not from what was read at startup, so it keeps what they saved.
   */
  constructor(readonly file: string, private readonly paths: Partial<DefaultPaths> = {}, private readonly shared = false) {
    super();
    this.current = defaultSettings(paths);
  }

  /**
   * A missing file gives the defaults. A file that is not a JSON object is moved aside to `settings.json.corrupt-<time>` and
   * the defaults are used. A file that cannot be read (permissions, a folder in its place) is never overwritten: the defaults
   * are used, `load` rejects with a readable error, and every later `set` or `save` rejects too. A legacy file is migrated
   * and written back in the new shape.
   */
  async load(): Promise<ClopSettings> {
    this.current = defaultSettings(this.paths); this.unreadable = undefined;
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.current;
      throw this.unreadable = new Error(`Clop could not read its settings file ${this.file} (${reason(error)}). It is using the default settings and will not save changes until the file can be read.`);
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { await retryBusy(() => rename(this.file, aside)); } catch (error) {
        throw this.unreadable = new Error(`Clop could not move its unreadable settings file ${this.file} aside (${reason(error)}). It is using the default settings and will not save changes.`);
      }
      return this.current;
    }
    if (isLegacySettings(value)) { this.current = migrateLegacy(value, this.paths); await this.save(); }
    else this.current = parseSettings(value, this.current);
    return this.current;
  }

  get(): ClopSettings;
  get<K extends SettingKey>(key: K): ClopSettings[K];
  get(key?: SettingKey) { return key === undefined ? this.current : this.current[key]; }

  /**
   * Validates `partial` with `parseSettings` and saves it. Sets run one at a time, each on top of the last saved one; the
   * new settings become current and `change` fires with the changed keys only after the file is written. A failed write
   * leaves the previous settings in place, so retrying the same change writes again.
   */
  set(partial: unknown): Promise<ClopSettings> {
    return this.enqueue(() => this.apply(partial));
  }

  /**
   * A read-modify-write that no other write can slip into: `change` gets the settings as they are when its turn comes, after
   * every set and update queued before it, and returns the values to replace plus a result to hand back. Use it whenever the
   * new value depends on the old one (editing one entry of a list); a `get()` followed by a `set()` can overwrite what was
   * saved in between. Nothing is written when `change` throws or returns no values.
   */
  update<T>(change: (current: ClopSettings) => { patch?: unknown; result: T }): Promise<{ settings: ClopSettings; result: T }> {
    return this.enqueue(async () => {
      if (this.unreadable) throw this.unreadable;
      await this.reread();
      const { patch, result } = change(this.current);
      return { settings: patch === undefined ? this.current : await this.apply(patch), result };
    });
  }

  /**
   * A shared file is read again before a change is built on it. A file that is gone starts over from the defaults; one that cannot be
   * read, or is not a JSON object, refuses the change, so what was read at startup is never written over a file someone is repairing.
   */
  private async reread() {
    if (!this.shared) return;
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.current = defaultSettings(this.paths); return; }
      throw new Error(`Clop could not read its settings file ${this.file} (${reason(error)}), so it did not save this change.`);
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Clop could not read its settings file ${this.file} (it is not a JSON object), so it did not save this change.`);
    if (!isLegacySettings(value)) this.current = parseSettings(value, defaultSettings(this.paths));
  }

  private async apply(partial: unknown): Promise<ClopSettings> {
    if (this.unreadable) throw this.unreadable;
    await this.reread();
    const previous = this.current, next = parseSettings(partial, previous);
    const changed = SETTING_KEYS.filter(key => !isDeepStrictEqual(next[key], previous[key]));
    if (!changed.length) return previous;
    await this.write(next);
    this.current = next;
    this.emit('change', next, changed);
    return next;
  }

  /** Writes the current settings after any queued sets. */
  save(): Promise<void> {
    if (this.unreadable) return Promise.reject(this.unreadable);
    return this.enqueue(() => this.write(this.current));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const job = this.queue.then(() => this.shared ? this.locked(task) : task());
    this.queue = job.catch(() => {});
    return job;
  }

  /**
   * Runs `task` while holding `settings.json.lock`, so a change in this process and one in another (two headless commands, an MCP
   * server) take turns: each rereads the file only after the other has written it. A lock left by a process that died is taken over after 30 seconds.
   */
  private async locked<T>(task: () => Promise<T>): Promise<T> {
    const lock = `${this.file}.lock`, started = Date.now();
    await mkdir(path.dirname(this.file), { recursive: true });
    for (;;) {
      try { await writeFile(lock, String(process.pid), { flag: 'wx' }); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) { await rm(lock, { force: true }); continue; }
        if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`Clop could not save this change: another Clop command has been saving settings for more than ${LOCK_WAIT_MS / 1000} seconds (${lock}).`);
        await delay(20);
      }
    }
    try { return await task(); } finally { await rm(lock, { force: true }); }
  }

  /** Replaces the file atomically, so a crash never leaves half a file. */
  private async write(settings: ClopSettings) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(settings, null, 2)); await retryBusy(() => rename(temporary, this.file)); }
    finally { await rm(temporary, { force: true }); }
  }
}
