import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { retryBusy } from '../run';
import type { DefaultPaths } from './paths';
import { SETTING_KEYS, defaultSettings, isLegacySettings, migrateLegacy, parseSettings, type ClopSettings, type SettingKey } from './schema';

const reason = (error: unknown) => (error as NodeJS.ErrnoException).code ?? (error as Error).message;

/** Settings persisted as JSON. Every value is replaced, never mutated, so `get()` snapshots stay stable. */
export class SettingsStore extends EventEmitter<{ change: [settings: ClopSettings, changed: SettingKey[]] }> {
  private current: ClopSettings;
  private queue: Promise<unknown> = Promise.resolve();
  /** Set when the file exists but could not be read or moved aside; saving would destroy it. */
  private unreadable?: Error;
  constructor(readonly file: string, private readonly paths: Partial<DefaultPaths> = {}) {
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
    return this.enqueue(async () => {
      if (this.unreadable) throw this.unreadable;
      const previous = this.current, next = parseSettings(partial, previous);
      const changed = SETTING_KEYS.filter(key => !isDeepStrictEqual(next[key], previous[key]));
      if (!changed.length) return previous;
      await this.write(next);
      this.current = next;
      this.emit('change', next, changed);
      return next;
    });
  }

  /** Writes the current settings after any queued sets. */
  save(): Promise<void> {
    if (this.unreadable) return Promise.reject(this.unreadable);
    return this.enqueue(() => this.write(this.current));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const job = this.queue.then(task);
    this.queue = job.catch(() => {});
    return job;
  }

  /** Replaces the file atomically, so a crash never leaves half a file. */
  private async write(settings: ClopSettings) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(settings, null, 2)); await retryBusy(() => rename(temporary, this.file)); }
    finally { await rm(temporary, { force: true }); }
  }
}
