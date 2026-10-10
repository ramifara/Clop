import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { copyTo, exists, moveTo } from './fileops';
import { expandHome } from './settings/paths';

/** Removes files in `dir` that have not changed for longer than `maxAgeMs`, then the folders that are left empty (never `dir` itself). Anything inside a `keep` folder stays. Returns the number of files removed. */
export async function sweep(dir: string, maxAgeMs: number, now: number, keep: ReadonlySet<string> = new Set()): Promise<number> {
  let removed = 0;
  const inside = async (folder: string): Promise<boolean> => {
    let empty = true;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(folder, entry.name);
      if (keep.has(file)) { empty = false; continue; }
      if (entry.isDirectory()) {
        if (await inside(file) && await rmdir(file).then(() => true, () => false)) continue;
        empty = false; continue;
      }
      // Copies keep the original's modification time, so the change and creation times say when the file arrived.
      const info = await lstat(file).catch(() => undefined);
      if (info && now - Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs) > maxAgeMs && await rm(file).then(() => true, () => false)) removed++;
      else empty = false;
    }
    return empty;
  };
  await inside(dir);
  return removed;
}

/**
 * The working directory (`%APPDATA%\Clop for Windows\work` by default):
 * - `backups`: the original of every in-place write, removed by the cleaner.
 * - `batch-backups`: batch-mode backups. The only pristine copy after an in-place rewrite, so nothing here is ever cleaned automatically.
 * - `temp`: results and scratch files, removed by the cleaner.
 */
export class Workdir {
  readonly root: string;
  readonly backups: string;
  readonly batchBackups: string;
  readonly temp: string;
  private readonly protectedDirs = new Set<string>();
  private readonly latest = new Map<string, string>();
  /** `legacy` lists folders from earlier versions. They are aged out like `temp` and removed once empty. */
  constructor(root: string, private readonly options: { home?: string; legacy?: string[] } = {}) {
    const expanded = expandHome(root.trim(), options.home ?? os.homedir());
    // A relative folder would land wherever the process happens to run.
    if (!path.isAbsolute(expanded)) throw new Error(root.trim() ? `The working directory must be an absolute path, not "${root}".` : 'The working directory is empty. Choose a folder.');
    this.root = path.resolve(expanded);
    this.backups = path.join(this.root, 'backups');
    this.batchBackups = path.join(this.root, 'batch-backups');
    this.temp = path.join(this.root, 'temp');
  }

  async ensure(): Promise<this> {
    await Promise.all([this.backups, this.batchBackups, this.temp].map(dir => mkdir(dir, { recursive: true })));
    return this;
  }

  /** Keeps a folder (a running session's files) out of `cleanup` and `forceClean`. Returns a function that lifts the protection. */
  protect(dir: string): () => void {
    const resolved = path.resolve(dir);
    this.protectedDirs.add(resolved);
    return () => { this.protectedDirs.delete(resolved); };
  }

  /** Where the backup of `original` as it is now lives: `backups/<name>-<hash of path, size and modification time>.<ext>`. Rewriting the file changes the hash, so keep the path `backup` returns. */
  async backupPath(original: string): Promise<string> {
    const resolved = path.resolve(original), info = await stat(resolved), { name, ext } = path.parse(resolved);
    const hash = createHash('sha1').update(`${resolved}\0${info.size}\0${info.mtimeMs}`).digest('hex').slice(0, 12);
    return path.join(this.backups, `${name.slice(0, 80)}-${hash}${ext}`);
  }

  /** The backup `backup` made most recently for `original`, if it is still there. Survives the original being rewritten in place. */
  async latestBackup(original: string): Promise<string | undefined> {
    const backup = this.latest.get(path.resolve(original));
    return backup && await exists(backup) ? backup : undefined;
  }

  /** Copies (or with `move`, moves) `original` into `backups`. Without `force` an existing backup of the same file version is kept. Returns the backup path, or undefined when `original` does not exist. */
  async backup(original: string, { move = false, force = false } = {}): Promise<string | undefined> {
    if (!await exists(original)) return undefined;
    await mkdir(this.backups, { recursive: true });
    const target = await this.backupPath(original);
    await (move ? moveTo : copyTo)(original, target, { force });
    this.latest.set(path.resolve(original), target);
    return target;
  }

  /** Puts `backup` back at `original`, byte for byte, then deletes it. */
  async restore(backup: string, original: string): Promise<string> {
    await copyTo(backup, original);
    await rm(backup, { force: true });
    return original;
  }

  /** Deletes files older than `intervalSeconds` from `backups`, `temp` and the legacy folders. 0 never deletes. Returns the number of files removed. */
  async cleanup(intervalSeconds: number, now = Date.now()): Promise<number> {
    return intervalSeconds > 0 ? this.sweepAll(intervalSeconds * 1000, now) : 0;
  }

  /** Deletes everything in `backups`, `temp` and the legacy folders except protected folders. Batch backups stay. */
  async forceClean(): Promise<number> {
    const removed = await this.sweepAll(-1, Date.now());
    await this.ensure();
    return removed;
  }

  private async sweepAll(maxAgeMs: number, now: number) {
    let removed = 0;
    for (const dir of [this.backups, this.temp]) removed += await sweep(dir, maxAgeMs, now, this.protectedDirs);
    for (const dir of this.options.legacy ?? []) {
      removed += await sweep(dir, maxAgeMs, now, this.protectedDirs);
      await rmdir(dir).catch(() => {});
    }
    return removed;
  }

  /** Runs `cleanup` now and then every `everyMs` (the macOS default is ten minutes), reading the interval each time so a settings change applies. Returns a function that stops it. */
  startCleaner(interval: () => number, everyMs = 600_000, clock = Date.now): () => void {
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      void this.cleanup(interval(), clock()).catch(() => {}).finally(() => { running = false; });
    };
    const timer = setInterval(tick, everyMs);
    timer.unref();
    tick();
    return () => clearInterval(timer);
  }
}
