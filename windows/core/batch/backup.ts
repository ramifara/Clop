import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, moveTo } from '../fileops';
import { retryBusy } from '../run';
import type { Workdir } from '../workdir';

// Port of BatchBackup.swift: one folder per batch in the working directory's `batch-backups`, with a manifest keyed by the
// original path. macOS clones every source up front, which costs nothing on APFS; NTFS has no clones, so here a file is
// moved in only when a result is about to take its place. Nothing here is removed by the cleaner, only by `delete`.

/** A file Clop moved aside: an original a result replaced, or a file of the user's that sat where a result went. */
export interface BackupEntry { path: string; backup: string; size: number; mtimeMs: number }
/** Where a result went, as it was when placed; `originalRemoved` when a converted result replaced its original under a new name. */
export interface ResultEntry { original: string; path: string; size: number; mtimeMs: number; originalRemoved: boolean }
interface Manifest { id: string; entries: BackupEntry[]; results: ResultEntry[] }

const hash = (file: string) => new Promise<string>((resolve, reject) => {
  const sha = createHash('sha256');
  createReadStream(file).on('error', reject).on('data', chunk => sha.update(chunk)).on('end', () => resolve(sha.digest('hex')));
});

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

  async recordResult(result: ResultEntry) { this.results.set(this.key(result.original), result); await this.save(); }
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
