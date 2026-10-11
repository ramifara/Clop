import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { lstat, mkdir, readdir, readFile, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { copyTo, exists, moveTo, samePath } from './fileops';
import { expandHome } from './settings/paths';

/** Dropped into the working directory so a later start knows the folder was made for Clop. */
const MARKER = '.clop-workdir';
/** Notes of originals that are away from their path while a result takes their place (`journal`). */
const PLACING = 'placing';
const LAYOUT = new Set(['backups', 'batch-backups', 'temp', PLACING, MARKER]);

/** The first symlink or junction among `dir` and its ancestors. */
async function linkAmong(dir: string): Promise<string | undefined> {
  for (let current = dir; ;) {
    if ((await lstat(current).catch(() => undefined))?.isSymbolicLink()) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Whether `child` is `parent` or inside it. */
const within = (parent: string, child: string, platform: NodeJS.Platform = process.platform) => {
  const relative = path.relative(parent, child);
  return samePath(parent, child, platform) || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Makes sure the cleaner sees `file` as just arrived. A move keeps a file's modification and creation times; NTFS still updates its
 * change time, which the cleaner reads, but FAT and exFAT do not, so there a just-moved backup of an old file would look old enough to
 * delete. Then the file is copied afresh under its own name (keeping its modification time), which gives it a new creation time.
 */
export async function stampArrival(file: string, now = Date.now(), info: (file: string) => Promise<{ mtimeMs: number; ctimeMs: number; birthtimeMs: number }> = stat) {
  const times = await info(file);
  if (now - Math.max(times.mtimeMs, times.ctimeMs, times.birthtimeMs) < 60_000) return;
  const fresh = path.join(path.dirname(file), `.clop-${randomUUID()}.tmp`);
  try { await copyTo(file, fresh); await moveTo(fresh, file); } finally { await rm(fresh, { force: true }); }
}

/** Removes files in `dir` that have not changed for longer than `maxAgeMs` (a negative value removes every file, whatever its timestamps), then the folders that are left empty (never `dir` itself). Anything inside a `keep` folder stays. Links (symlinks, junctions) are removed as links when they age out and never followed, and a `dir` that is itself a link is left alone. Returns the number of files removed. */
export async function sweep(dir: string, maxAgeMs: number, now: number, keep: ReadonlySet<string> = new Set()): Promise<number> {
  let removed = 0;
  if ((await lstat(dir).catch(() => undefined))?.isSymbolicLink()) return 0;
  const inside = async (folder: string): Promise<boolean> => {
    let empty = true;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(folder, entry.name);
      if (keep.has(file)) { empty = false; continue; }
      const info = await lstat(file).catch(() => undefined);
      if (info?.isDirectory()) {
        if (await inside(file) && await rmdir(file).then(() => true, () => false)) continue;
        empty = false; continue;
      }
      // Copies keep the original's modification time, so the change and creation times say when the file arrived.
      const gone = () => info!.isSymbolicLink() ? unlink(file).catch(() => rmdir(file)).then(() => true, () => false) : rm(file).then(() => true, () => false);
      if (info && (maxAgeMs < 0 || now - Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs) > maxAgeMs) && await gone()) removed++;
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
  private readonly legacy: string[];
  /** `legacy` lists folders from earlier versions. They are aged out like `temp` and removed once empty. One that contains the working directory, or overlaps `batch-backups`, is ignored, so the cleaner can never reach a file it promises to keep. */
  constructor(root: string, options: { home?: string; legacy?: string[] } = {}) {
    const expanded = expandHome(root.trim(), options.home ?? os.homedir());
    // A relative folder would land wherever the process happens to run.
    if (!path.isAbsolute(expanded)) throw new Error(root.trim() ? `The working directory must be an absolute path, not "${root}".` : 'The working directory is empty. Choose a folder.');
    this.root = path.resolve(expanded);
    this.backups = path.join(this.root, 'backups');
    this.batchBackups = path.join(this.root, 'batch-backups');
    this.temp = path.join(this.root, 'temp');
    this.legacy = (options.legacy ?? []).map(dir => path.resolve(dir)).filter(dir => !within(dir, this.root) && !within(dir, this.batchBackups) && !within(this.batchBackups, dir));
  }

  /** Whether `file` is inside one of the folders Clop writes its own files to, as opposed to the rest of a root the user may have pointed at an ordinary folder. */
  owns(file: string): boolean {
    return [this.backups, this.batchBackups, this.temp].some(dir => within(dir, path.resolve(file)));
  }

  /**
   * Creates the layout. Refuses a folder that holds other files (unless Clop made it), because the cleaner
   * deletes inside `backups` and `temp`, and refuses links anywhere on the path, because a link could point
   * the cleaner at someone else's files.
   */
  async ensure(): Promise<this> {
    for (const dir of [this.backups, this.temp]) {
      const link = await linkAmong(dir);
      if (link) throw new Error(`${link} is a link. Remove it so Clop can use its own folder.`);
    }
    const entries = await readdir(this.root).catch(() => undefined);
    if (entries && !entries.includes(MARKER) && !entries.every(name => LAYOUT.has(name))) throw new Error(`${this.root} already holds files that are not Clop's. Choose an empty folder for the working directory.`);
    await Promise.all([this.backups, this.batchBackups, this.temp].map(dir => mkdir(dir, { recursive: true })));
    await writeFile(path.join(this.root, MARKER), 'Clop working directory. Files in backups and temp are deleted after the cleanup interval.\n', { flag: 'a' });
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
    if (move) await stampArrival(target).catch(() => {});
    this.latest.set(path.resolve(original), target);
    return target;
  }

  /**
   * Notes that `original` is about to be away from its path, kept at `backup`, until the returned function removes the note.
   * A start after a crash or a forced shutdown finds the note and puts the original back (`repair`).
   */
  async journal(original: string, backup: string): Promise<() => Promise<void>> {
    const dir = path.join(this.root, PLACING), note = path.join(dir, `${randomUUID()}.json`);
    await mkdir(dir, { recursive: true });
    await writeFile(note, JSON.stringify({ original: path.resolve(original), backup: path.resolve(backup) }));
    return () => rm(note, { force: true });
  }

  /**
   * Finishes what a placement that never ended left: an original that is not at its path is copied back from its backup (which
   * stays in the backups), and the note is removed. A note stays when the copy back failed (a drive that is not there yet, a file
   * in use), so the backup stays protected and the next start tries again. Returns the files put back.
   */
  async repair(): Promise<string[]> {
    const dir = path.join(this.root, PLACING), restored: string[] = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      const note = path.join(dir, name);
      let original: unknown, backup: unknown;
      // A note that cannot be read or acted on is dropped; its backup stays in the backups.
      try { ({ original, backup } = JSON.parse(await readFile(note, 'utf8')) as { original?: unknown; backup?: unknown }); } catch { await rm(note, { force: true }); continue; }
      if (typeof original === 'string' && typeof backup === 'string' && within(this.backups, backup) && !await exists(original) && await exists(backup)) {
        try { await copyTo(backup, original); restored.push(original); } catch { continue; }
      }
      await rm(note, { force: true });
    }
    return restored;
  }

  /** The backups the notes in the working directory name: the originals that are away from their path right now. */
  private async journalled(): Promise<string[]> {
    const dir = path.join(this.root, PLACING), backups: string[] = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      try { const { backup } = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as { backup?: unknown }; if (typeof backup === 'string') backups.push(path.resolve(backup)); } catch { /* A note that cannot be read names nothing. */ }
    }
    return backups;
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
    // A backup a note names is the only copy of an original that is away from its path, so it stays however old it is.
    const keep = new Set([...this.protectedDirs, ...await this.journalled()]);
    if (!await linkAmong(this.root)) for (const dir of [this.backups, this.temp]) removed += await sweep(dir, maxAgeMs, now, keep);
    for (const dir of this.legacy) {
      removed += await sweep(dir, maxAgeMs, now, keep);
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
