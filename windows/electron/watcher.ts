import { watch, type FSWatcher } from 'chokidar';
import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ClopSettings } from '../core/settings/schema';
import type { MediaKind } from '../core/media/types';
import { expandHome } from '../core/settings/paths';
import { mediaKind } from './clipboard';
import { clopIgnored, matchingWatchedDir, qualifies, watchSettings } from './watch-rules';

export interface WatcherHost {
  settings: () => ClopSettings;
  home?: string;
  /** Whether a file is one of Clop's own (the working directory). */
  owns: (file: string) => boolean;
  isOptimised: (file: string) => Promise<boolean>;
  /** Optimises a file from the watched folder `dir` (as stored in settings). Resolves when done, with where the result went. */
  handle: (file: string, dir: string) => Promise<string | undefined>;
  /** Stops optimising files that turned out to be part of too large a batch. */
  cancel: (files: string[]) => void;
  notice: (text: string) => void;
  /** Turns this kind's automatic optimisation off, after a burst of changes as soon as watching started. */
  disable: () => void;
  /** The app's first launch: the first seconds of watching then guard against apps that keep rewriting files. */
  firstLaunch?: boolean;
}
/** `stabilityMs`: how long a file's size must hold before it counts as written. `windowMs`: how long an appearing file counts towards the batch limit. */
export const TIMING = { stabilityMs: 1000, pollMs: 5000, settleMs: 300, windowMs: 1000, safeMs: 30_000, safeDelayMs: 3000 };
const NOUN = { image: 'image', video: 'video', pdf: 'PDF', audio: 'audio file' } as const;
const SPURIOUS = 5;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Port of FileOptimisationWatcher.swift for one kind of file: watches that kind's folders (recursively, as FSEvents does)
 * and hands each new or changed file that qualifies to `handle`. Nothing runs while `pauseAutomaticOptimisations` is on or
 * the kind is disabled. Files already there when watching starts are left alone, and so are hidden files, Clop's own
 * files and temporaries, files it optimised (marker and `optimisedFileProtectionMs`) and files a `.clopignore-<kind>` names.
 * When more than `max<Kind>FileCount` files appear at once, none of them is optimised. Missing folders are polled for.
 */
export class FolderWatcher {
  private watcher?: FSWatcher;
  private key = '';
  private generation = 0;
  private poll?: NodeJS.Timeout;
  private startedAt = 0;
  /** `justAddedFiles`: files that appeared within `windowMs`, or all of them during the first-launch guard. */
  private recent = new Map<string, { file: string; dir: string; timer?: NodeJS.Timeout }>();
  private cancelled = new Set<string>();
  private running = new Set<string>();
  private protectedFiles = new Map<string, NodeJS.Timeout>();
  private cleaner?: NodeJS.Timeout;
  private held?: NodeJS.Timeout;
  private roots = new Set<string>();
  private unready?: () => void;
  constructor(readonly kind: MediaKind, private host: WatcherHost, private timing = TIMING) {}

  private id(file: string) { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
  get watching() { return !!this.watcher; }

  /** Starts, restarts or stops watching to match the settings. Call it after every settings change; resolves once watching is ready. */
  async update(): Promise<void> {
    const generation = ++this.generation, s = this.host.settings(), w = watchSettings(this.kind, s);
    const dirs = w.enabled && !s.pauseAutomaticOptimisations ? [...new Set(w.dirs.map(dir => path.resolve(expandHome(dir, this.host.home))))] : [];
    const existing = (await Promise.all(dirs.map(async dir => (await stat(dir).catch(() => undefined))?.isDirectory() ? dir : undefined))).filter(dir => dir !== undefined);
    if (generation !== this.generation) return;
    // A folder on a drive that is not connected yet is watched once it appears.
    clearTimeout(this.poll); this.poll = undefined;
    if (existing.length < dirs.length) { this.poll = setTimeout(() => void this.update(), this.timing.pollMs); this.poll.unref(); }
    const key = JSON.stringify(existing);
    if (key === this.key) return;
    await this.stop();
    if (generation !== this.generation || !existing.length) return;
    this.key = key; this.roots = new Set(existing.map(dir => this.id(dir))); this.startedAt = Date.now();
    const watcher = this.watcher = watch(existing, {
      ignoreInitial: true, ignorePermissionErrors: true, awaitWriteFinish: { stabilityThreshold: this.timing.stabilityMs, pollInterval: 100 },
      ignored: (file: string, stats?: Stats) => this.ignored(file, stats),
    });
    const event = (file: string) => { this.event(file).catch(() => {}); };
    // A watched folder that is deleted or disconnected is polled for until it is back.
    watcher.on('add', event).on('change', event).on('unlinkDir', dir => { if (this.roots.has(this.id(dir))) void this.update(); }).on('error', () => {});
    await new Promise<void>(resolve => { this.unready = resolve; watcher.once('ready', () => resolve()); });
  }

  /** Hidden files and folders (Clop's `.clop-*.tmp` copies among them), Clop's working directory and other kinds of file are never looked at. */
  private ignored(file: string, stats?: Stats) {
    if (this.roots.has(this.id(file))) return false;
    return path.basename(file).startsWith('.') || this.host.owns(file) || (!!stats?.isFile() && mediaKind(file) !== this.kind);
  }

  private async stop() {
    const watcher = this.watcher;
    this.watcher = undefined; this.key = ''; this.unready?.();
    for (const { timer } of this.recent.values()) clearTimeout(timer);
    this.recent.clear(); this.cancelled.clear(); clearTimeout(this.held); clearTimeout(this.cleaner);
    await watcher?.close();
  }

  /** Stops watching for good. */
  async close() { this.generation++; clearTimeout(this.poll); for (const timer of this.protectedFiles.values()) clearTimeout(timer); this.protectedFiles.clear(); await this.stop(); }

  /** Leaves `file` alone for `optimisedFileProtectionMs`, so Clop's own write is not optimised again. */
  protect(file: string) {
    const id = this.id(file);
    clearTimeout(this.protectedFiles.get(id));
    const timer = setTimeout(() => this.protectedFiles.delete(id), this.host.settings().optimisedFileProtectionMs);
    timer.unref();
    this.protectedFiles.set(id, timer);
  }

  private async event(file: string) {
    const s = this.host.settings(), w = watchSettings(this.kind, s), id = this.id(file);
    if (!w.enabled || s.pauseAutomaticOptimisations || this.protectedFiles.has(id) || this.running.has(id)) return;
    const dir = matchingWatchedDir(file, w.dirs, this.host.home);
    if (!dir || !await qualifies(this.kind, file, s, this.host)) return;
    // One save can change a file several times; the first change handles it.
    if (this.recent.has(id) || this.running.has(id) || !this.watcher) return;
    const safe = this.host.firstLaunch && Date.now() - this.startedAt < this.timing.safeMs;
    const entry: { file: string; dir: string; timer?: NodeJS.Timeout } = { file, dir };
    if (!safe) { entry.timer = setTimeout(() => this.recent.delete(id), this.timing.windowMs); entry.timer.unref(); }
    this.recent.set(id, entry);
    clearTimeout(this.cleaner);
    if (await clopIgnored(this.kind, path.resolve(expandHome(dir, this.host.home)), file)) return;
    if (safe) return this.hold();
    if (this.recent.size > w.maxFiles) {
      this.host.notice(`More than ${w.maxFiles} ${NOUN[this.kind]}${w.maxFiles === 1 ? '' : 's'} appeared in ${path.dirname(file)}, so Clop is leaving them alone.`);
      const files = [...this.recent].filter(([key]) => !this.cancelled.has(key));
      for (const [key] of files) this.cancelled.add(key);
      this.host.cancel(files.map(([, { file }]) => file));
      this.cleaner = setTimeout(() => { this.cancelled.clear(); this.recent.clear(); }, this.timing.windowMs);
      return;
    }
    await sleep(this.timing.settleMs);
    if (this.cancelled.has(id) || !(await stat(file).then(info => info.isFile(), () => false))) return;
    this.dispatch(file, dir);
  }

  /**
   * Port of `hasSpuriousEvent`: in the first seconds of watching at first launch, files are held and optimised together a few
   * seconds after the last one. More than five means an app keeps rewriting files there, and this kind is turned off.
   */
  private hold() {
    clearTimeout(this.held);
    if (this.recent.size > SPURIOUS) {
      void this.stop();
      this.host.disable();
      this.host.notice(`Many ${NOUN[this.kind]}s changed as soon as Clop started watching, likely another app rewriting them. Automatic ${NOUN[this.kind]} optimisation is now off; turn it back on in the settings.`);
      return;
    }
    this.held = setTimeout(() => {
      const held = [...this.recent].filter(([key]) => !this.cancelled.has(key));
      this.recent.clear();
      for (const [, { file, dir }] of held) this.dispatch(file, dir);
    }, this.timing.safeDelayMs);
  }

  private dispatch(file: string, dir: string) {
    const id = this.id(file);
    this.running.add(id);
    void Promise.resolve().then(() => this.host.handle(file, dir)).catch(() => undefined).then(placed => {
      this.running.delete(id); this.protect(file);
      if (placed) this.protect(placed);
    });
  }
}
