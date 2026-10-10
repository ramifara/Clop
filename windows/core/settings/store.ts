import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { retryBusy } from '../run';
import type { DefaultPaths } from './paths';
import { SETTING_KEYS, defaultSettings, isLegacySettings, migrateLegacy, parseSettings, type ClopSettings, type SettingKey } from './schema';

/** Settings persisted as JSON. Every value is replaced, never mutated, so `get()` snapshots stay stable. */
export class SettingsStore extends EventEmitter<{ change: [settings: ClopSettings, changed: SettingKey[]] }> {
  private current: ClopSettings;
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly file: string, private readonly paths: Partial<DefaultPaths> = {}) {
    super();
    this.current = defaultSettings(paths);
  }

  /** A missing or unreadable file gives the defaults. A legacy file is migrated and written back in the new shape. */
  async load(): Promise<ClopSettings> {
    let value: unknown;
    try { value = JSON.parse(await readFile(this.file, 'utf8')); } catch {}
    if (isLegacySettings(value)) { this.current = migrateLegacy(value, this.paths); await this.save(); }
    else this.current = parseSettings(value, defaultSettings(this.paths));
    return this.current;
  }

  get(): ClopSettings;
  get<K extends SettingKey>(key: K): ClopSettings[K];
  get(key?: SettingKey) { return key === undefined ? this.current : this.current[key]; }

  /** Validates `partial` with `parseSettings`, saves when anything changed, then emits `change` with the changed keys. */
  async set(partial: unknown): Promise<ClopSettings> {
    const previous = this.current, next = parseSettings(partial, previous);
    const changed = SETTING_KEYS.filter(key => !isDeepStrictEqual(next[key], previous[key]));
    if (!changed.length) return previous;
    this.current = next;
    await this.save();
    this.emit('change', next, changed);
    return next;
  }

  /** Writes are queued in call order and replace the file atomically, so a crash never leaves half a file. */
  save(): Promise<void> {
    const json = JSON.stringify(this.current, null, 2);
    const write = async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, json); await retryBusy(() => rename(temporary, this.file)); }
      finally { await rm(temporary, { force: true }); }
    };
    const job = this.writes.then(write);
    this.writes = job.catch(() => {});
    return job;
  }
}
