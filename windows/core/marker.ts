import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { retryBusy } from './run';
import { defaultPaths } from './settings/paths';

// The optimised-file marker. macOS keeps it in an extended attribute; NTFS alternate data streams are
// lost on FAT, zip, OneDrive sync and any app that saves through a temporary file, so the sidecar cache
// (path, size and modification time) is the source of truth. The stream is only written as a hint.

const DAY = 86400000;
const STREAM = 'clop.optimisation.status';
interface Entry { size: number; mtimeMs: number; at: number }
export interface MarkerOptions {
  /** Entries older than this are dropped when the cache loads. */
  maxAgeMs?: number;
  /** The oldest entries are dropped beyond this count. */
  maxEntries?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export class OptimisedMarker {
  private entries?: Map<string, Entry>;
  private loading?: Promise<Map<string, Entry>>;
  private writing?: Promise<void>;
  private dirty = false;
  private readonly maxAgeMs: number;
  private readonly maxEntries: number;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  constructor(readonly file: string, options: MarkerOptions = {}) {
    this.maxAgeMs = options.maxAgeMs ?? 30 * 86400000;
    this.maxEntries = options.maxEntries ?? 50_000;
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  /** NTFS ignores case, so case differences must not make two keys. */
  private key(file: string) {
    const resolved = path.resolve(file);
    return this.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  /** Reads the cache once, dropping entries that expired and entries whose file is gone. A missing or damaged file is an empty cache. */
  private load(): Promise<Map<string, Entry>> {
    return this.entries ? Promise.resolve(this.entries) : this.loading ??= (async () => {
      let stored: unknown;
      try { stored = JSON.parse(await readFile(this.file, 'utf8')); } catch {}
      const entries = new Map<string, Entry>(), cutoff = this.now() - this.maxAgeMs;
      const records = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? Object.entries(stored) : [];
      for (const [stored, value] of records) {
        const { size, mtimeMs, at } = (value ?? {}) as Partial<Entry>;
        if (typeof size !== 'number' || typeof mtimeMs !== 'number' || typeof at !== 'number' || at < cutoff) continue;
        // Keys are normalised again, so a file written with another casing (or by hand) still matches.
        if (await stat(stored).then(info => info.isFile(), () => false)) entries.set(this.key(stored), { size, mtimeMs, at });
      }
      this.entries = entries;
      if (entries.size !== records.length) void this.persist().catch(() => {});
      return entries;
    })();
  }

  /** Whether `file` was optimised and has not changed since: same path, size and modification time. */
  async isOptimised(file: string): Promise<boolean> {
    const entries = await this.load(), key = this.key(file), entry = entries.get(key);
    if (!entry) return false;
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || info.size !== entry.size || info.mtimeMs !== entry.mtimeMs) return false;
    // Keeps a mark that is still being checked from expiring. Saved at most once a day, so checking stays cheap.
    const now = this.now();
    if (now - entry.at > DAY) { entry.at = now; await this.persist().catch(() => {}); }
    return true;
  }

  /** Records the file as it is now. Call it after the last write to the file. */
  async markOptimised(file: string): Promise<void> {
    const entries = await this.load();
    // Checked first: writing a stream to a missing path would create an empty file there.
    if (!(await stat(file)).isFile()) throw new Error(`${file} is not a file.`);
    // Writing the stream before the final stat, because stream writes can touch the file's times.
    await this.writeHint(file);
    const info = await stat(file);
    const key = this.key(file);
    entries.delete(key);
    entries.set(key, { size: info.size, mtimeMs: info.mtimeMs, at: this.now() });
    for (const oldest of entries.keys()) { if (entries.size <= this.maxEntries) break; entries.delete(oldest); }
    await this.persist();
  }

  async unmark(file: string): Promise<void> {
    if ((await this.load()).delete(this.key(file))) await this.persist();
  }

  /** The alternate data stream hint, or undefined where there is none (any platform but Windows, FAT, or no stream). */
  async hint(file: string): Promise<boolean | undefined> {
    if (this.platform !== 'win32') return undefined;
    try { return (await readFile(`${file}:${STREAM}`, 'utf8')) === 'true'; } catch { return undefined; }
  }

  private async writeHint(file: string) {
    if (this.platform !== 'win32') return;
    try { await writeFile(`${file}:${STREAM}`, 'true'); } catch {}
  }

  /** Writes are coalesced: callers that arrive during a write share the next one. */
  private persist(): Promise<void> {
    this.dirty = true;
    return this.writing ??= (async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          const json = JSON.stringify(Object.fromEntries(this.entries!));
          await mkdir(path.dirname(this.file), { recursive: true });
          const temporary = `${this.file}.${randomUUID()}.tmp`;
          try { await writeFile(temporary, json); await retryBusy(() => rename(temporary, this.file)); } finally { await rm(temporary, { force: true }); }
        }
      } finally { this.writing = undefined; }
    })();
  }
}

let shared: OptimisedMarker | undefined;
/** The app-wide cache at `%APPDATA%\Clop for Windows\optimised.json`. */
export const defaultMarker = () => shared ??= new OptimisedMarker(path.join(defaultPaths().userData, 'optimised.json'));
export const isOptimised = (file: string) => defaultMarker().isOptimised(file);
export const markOptimised = (file: string) => defaultMarker().markOptimised(file);
