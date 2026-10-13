import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, moveTo } from '../fileops';
import { retryBusy } from '../run';
import type { Workdir } from '../workdir';

// Port of BatchBackup.swift: one folder per batch in the working directory's `batch-backups`, with a manifest keyed by the
// original path. macOS clones every source up front, which costs nothing on APFS; NTFS has no clones, so here a file is
// moved in only when a result is about to take its place. Nothing here is removed by the cleaner, only by `delete`.

/** A file Clop moved aside: an original a result replaced, or a file of the user's that sat where a result went. */
export interface BackupEntry { path: string; backup: string; size: number; mtimeMs: number }
/**
 * Where a result went, as it was when placed; `originalRemoved` when a converted result replaced its original under a new name,
 * and `originalRestored` once a revert has given that original back (so a revert that stopped half way can finish).
 */
export interface ResultEntry { original: string; path: string; size: number; mtimeMs: number; originalRemoved: boolean; originalRestored?: boolean }
interface Manifest { id: string; entries: BackupEntry[]; results: ResultEntry[] }

const hash = (file: string) => new Promise<string>((resolve, reject) => {
  const sha = createHash('sha256');
  createReadStream(file).on('error', reject).on('data', chunk => sha.update(chunk)).on('end', () => resolve(sha.digest('hex')));
});

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const BATCH_DIR = /^batch-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export class BatchBackup {
  readonly dir: string;
  private readonly manifest: string;
  private entries = new Map<string, BackupEntry>();
  private results = new Map<string, ResultEntry>();
  private saving: Promise<void> = Promise.resolve();
  constructor(workdir: Workdir, readonly id: string, private platform: NodeJS.Platform = process.platform) {
    this.dir = path.join(workdir.batchBackups, `batch-${id}`);
    this.manifest = path.join(this.dir, 'manifest.json');
  }
  /** Reads a batch's manifest back (`loadManifest`), or undefined when there is none or it is not one of Clop's. Backups outside the batch's folder are ignored. */
  static async load(workdir: Workdir, id: string, platform?: NodeJS.Platform): Promise<BatchBackup | undefined> {
    const backup = new BatchBackup(workdir, id, platform);
    const data: unknown = await readFile(backup.manifest, 'utf8').then(JSON.parse, () => undefined);
    if (!isRecord(data) || data.id !== id || !Array.isArray(data.entries) || !Array.isArray(data.results)) return undefined;
    const inside = (file: string) => path.dirname(path.resolve(file)) === path.resolve(backup.dir);
    for (const entry of data.entries) {
      if (isRecord(entry) && isString(entry.path) && isString(entry.backup) && isNumber(entry.size) && isNumber(entry.mtimeMs) && path.isAbsolute(entry.path) && inside(entry.backup))
        backup.entries.set(backup.key(entry.path), { path: entry.path, backup: path.resolve(entry.backup), size: entry.size, mtimeMs: entry.mtimeMs });
    }
    for (const result of data.results) {
      if (isRecord(result) && isString(result.original) && isString(result.path) && isNumber(result.size) && isNumber(result.mtimeMs) && path.isAbsolute(result.original) && path.isAbsolute(result.path))
        backup.results.set(backup.key(result.original), { original: result.original, path: result.path, size: result.size, mtimeMs: result.mtimeMs, originalRemoved: result.originalRemoved === true, ...(result.originalRestored === true ? { originalRestored: true } : {}) });
    }
    return backup;
  }

  /** The newest batch (other than `exclude`) whose manifest still holds results to revert, with how many, if any. */
  static async latest(workdir: Workdir, exclude?: string, platform?: NodeJS.Platform): Promise<{ id: string; results: number } | undefined> {
    const names = await readdir(workdir.batchBackups).catch(() => [] as string[]);
    const found = await Promise.all(names.map(async name => {
      const id = BATCH_DIR.exec(name)?.[1];
      if (!id || id === exclude) return undefined;
      const info = await stat(path.join(workdir.batchBackups, name, 'manifest.json')).catch(() => undefined);
      return info?.isFile() ? { id, time: info.mtimeMs } : undefined;
    }));
    for (const { id } of found.filter(item => !!item).sort((a, b) => b.time - a.time)) {
      const results = (await BatchBackup.load(workdir, id, platform))?.results.size;
      if (results) return { id, results };
    }
    return undefined;
  }

  /** Where each result of the batch went. */
  allResults(): ResultEntry[] { return [...this.results.values()]; }

  private key(file: string) { const resolved = path.resolve(file); return this.platform === 'win32' ? resolved.toLowerCase() : resolved; }

  /**
   * Takes `file` into the batch's folder before something takes its place, recording what it was. By default the file is moved
   * (it is about to go); with `copy` it stays where it is, so a result can replace it atomically with no moment when the path is
   * empty. `before` is the size and time the caller saw the file with: what was taken must match them, or the file changed while
   * it was taken and it stays as it was. When anything fails, including the manifest write, the file is back where it was.
   */
  async keep(file: string, { copy = false, before }: { copy?: boolean; before?: { size: number; mtimeMs: number } } = {}): Promise<BackupEntry> {
    const seen = before ?? await stat(file);
    await mkdir(this.dir, { recursive: true });
    const backup = path.join(this.dir, `${randomUUID()}${path.extname(file)}`), key = this.key(file), previous = this.entries.get(key);
    if (copy) await copyTo(file, backup); else await moveTo(file, backup, { force: false });
    const entry = { path: path.resolve(file), backup, size: seen.size, mtimeMs: seen.mtimeMs };
    try {
      // A copy across volumes is stamped with whole milliseconds, hence the tolerance.
      const now = await stat(copy ? file : backup);
      if (now.size !== seen.size || Math.abs(now.mtimeMs - seen.mtimeMs) >= 1) throw new Error(`${path.basename(file)} changed while the batch ran, so Clop left it as it is.`);
      this.entries.set(key, entry);
      await this.save();
    } catch (error) {
      if (previous) this.entries.set(key, previous); else this.entries.delete(key);
      if (copy) await rm(backup, { force: true }).catch(() => {});
      else await moveTo(backup, file).catch(() => { throw new Error(`${path.basename(file)} could not be put back after a failed backup. It is in ${this.dir}.`); });
      throw error;
    }
    return entry;
  }

  /** Forgets and deletes the copy of `file` made by `keep`, once what it was kept for was undone. */
  async discard(file: string) {
    const entry = this.entries.get(this.key(file));
    if (!entry) return;
    this.entries.delete(this.key(file));
    await rm(entry.backup, { force: true }).catch(() => {});
    await this.save().catch(() => {});
  }

  /** What was at `file` before Clop moved it aside, if its copy is still there. */
  async entry(file: string): Promise<BackupEntry | undefined> {
    const entry = this.entries.get(this.key(file));
    return entry && await stat(entry.backup).then(info => info.isFile(), () => false) ? entry : undefined;
  }

  /** Puts the file back where it was from its copy, byte for byte and with its modification time, then checks the bytes (`restoreVerified`). The copy stays, so restoring can be repeated. */
  async restore(file: string): Promise<string> {
    const entry = await this.entry(file);
    if (!entry) throw new Error(`The batch backup of ${path.basename(file)} is gone.`);
    await copyTo(entry.backup, entry.path);
    const [restored, kept] = await Promise.all([stat(entry.path), stat(entry.backup)]);
    if (restored.size !== kept.size || await hash(entry.path) !== await hash(entry.backup)) throw new Error(`${path.basename(file)} did not restore correctly. Its original is in ${this.dir}.`);
    return entry.path;
  }

  /** Remembers where a result went. When the manifest cannot be written it is not remembered, so a later save does not carry it into the manifest. */
  async recordResult(result: ResultEntry) {
    const key = this.key(result.original), previous = this.results.get(key);
    this.results.set(key, result);
    try { await this.save(); } catch (error) { if (previous) this.results.set(key, previous); else this.results.delete(key); throw error; }
  }
  result(original: string) { return this.results.get(this.key(original)); }
  async forgetResult(original: string) { this.results.delete(this.key(original)); await this.save(); }

  /** Removes the batch's folder and everything in it. */
  async delete() {
    await this.saving.catch(() => {});
    await rm(this.dir, { recursive: true, force: true, maxRetries: 3 });
    this.entries.clear(); this.results.clear();
  }

  /** Writes the manifest atomically; saves queue behind each other so the last state always lands. */
  private save() {
    const write = async () => {
      if (!this.entries.size && !this.results.size) return;
      await mkdir(this.dir, { recursive: true });
      const data: Manifest = { id: this.id, entries: [...this.entries.values()], results: [...this.results.values()] };
      const temporary = `${this.manifest}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(data, null, 1)); await retryBusy(() => rename(temporary, this.manifest)); } finally { await rm(temporary, { force: true }); }
    };
    return this.saving = this.saving.then(write, write);
  }
}
