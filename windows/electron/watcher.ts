import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ClopSettings } from '../core/settings/schema';
import type { MediaKind } from '../core/media/types';
import { expandHome } from '../core/settings/paths';
import { mediaKind } from './clipboard';
import { watchTree } from './folder-events';
import { clopIgnored, matchingWatchedDir, qualifies, watchSettings } from './watch-rules';

export interface WatcherHost {
  settings: () => ClopSettings;
  home?: string;
  /** Whether a file is one of Clop's own (the working directory). */
  owns: (file: string) => boolean;
  isOptimised: (file: string) => Promise<boolean>;
  /** Whether a file's content is on this computer, rather than a cloud placeholder that reading would download. */
  isLocal?: (file: string) => Promise<boolean>;
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
/**
 * `stabilityMs`: how long a file's size and modification time must hold before it counts as written (checked every
 * `checkMs`). `windowMs`: how long an appearing file counts towards the batch limit.
 */
export const TIMING = { stabilityMs: 1000, checkMs: 100, pollMs: 5000, settleMs: 300, windowMs: 1000, safeMs: 30_000, safeDelayMs: 3000 };
const NOUN = { image: 'image', video: 'video', pdf: 'PDF', audio: 'audio file' } as const;
const SPURIOUS = 5;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Port of FileOptimisationWatcher.swift for one kind of file: watches that kind's folders and every folder inside them, as
 * FSEvents does, and hands each new or changed file that qualifies to `handle` once it has finished writing. Nothing runs
 * while `pauseAutomaticOptimisations` is on or the kind is disabled. Files already there when watching starts are left
 * alone, and so are hidden files and folders, Clop's own files and temporaries, files it optimised (marker and
 * `optimisedFileProtectionMs`), cloud placeholders and files a `.clopignore-<kind>` names. When more than
 * `max<Kind>FileCount` files appear at once, none of them is optimised. Missing folders are polled for.
 */
export class FolderWatcher {
  private subscriptions: (() => void)[] = [];
  private key = '';
  private generation = 0;
  private poll?: NodeJS.Timeout;
  /** Swift's `startedWatchingAt`: when this watcher was made, not when it last restarted. */
  private readonly startedAt = Date.now();
  /** `justAddedFiles`: files that appeared within `windowMs`, or all of them during the first-launch guard. */
  private recent = new Map<string, { file: string; dir: string; timer?: NodeJS.Timeout }>();
  private cancelled = new Set<string>();
  private running = new Set<string>();
  /** Files waiting for their writes to finish. */
  private settling = new Map<string, NodeJS.Timeout>();
  private protectedFiles = new Map<string, NodeJS.Timeout>();
  private cleaner?: NodeJS.Timeout;
  private held?: NodeJS.Timeout;
  constructor(readonly kind: MediaKind, private host: WatcherHost, private timing = TIMING) {}

  private id(file: string) { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
  get watching() { return this.subscriptions.length > 0; }

  /** Starts, restarts or stops watching to match the settings. Call it after every settings change. */
  async update(): Promise<void> {
    const generation = ++this.generation, s = this.host.settings(), w = watchSettings(this.kind, s);
    const dirs = w.enabled && !s.pauseAutomaticOptimisations ? [...new Set(w.dirs.map(dir => path.resolve(expandHome(dir, this.host.home))))] : [];
    const existing = (await Promise.all(dirs.map(async dir => (await stat(dir).catch(() => undefined))?.isDirectory() ? dir : undefined))).filter(dir => dir !== undefined);
    if (generation !== this.generation) return;
    // A folder on a drive that is not connected yet is watched once it appears.
    clearTimeout(this.poll); this.poll = undefined;
    const retry = () => { this.poll = setTimeout(() => void this.update(), this.timing.pollMs); this.poll.unref(); };
    if (existing.length < dirs.length) retry();
    const key = JSON.stringify(existing);
    if (key === this.key) return;
    this.stop();
    this.key = key;
    for (const root of existing) {
      try { this.subscriptions.push(watchTree(root, file => this.changed(root, file), () => { this.key = ''; void this.update(); })); }
      catch { this.key = ''; if (!this.poll) retry(); }
    }
  }

  /** Hidden files and folders (Clop's `.clop-*.tmp` copies among them), Clop's working directory and other kinds of file are never looked at. */
  private ignored(root: string, file: string) {
    return mediaKind(file) !== this.kind || path.relative(root, file).split(path.sep).some(part => part.startsWith('.')) || this.host.owns(file);
  }

  /** Waits until a changed file's size and modification time hold for `stabilityMs` (`waitForModificationDateToSettle` in Swift), then looks at it. */
  private changed(root: string, file: string) {
    const id = this.id(file);
    if (this.ignored(root, file) || this.settling.has(id)) return;
    let last = '', since = Date.now();
    const check = async () => {
      const info = await stat(file).catch(() => undefined);
      if (!info?.isFile() || !this.watching) { this.settling.delete(id); return; }
      const now = `${info.size}:${info.mtimeMs}`;
      if (now !== last) { last = now; since = Date.now(); }
      if (Date.now() - since < this.timing.stabilityMs) { this.settling.set(id, setTimeout(check, this.timing.checkMs)); return; }
      this.settling.delete(id);
      this.event(file).catch(() => {});
    };
    this.settling.set(id, setTimeout(check, this.timing.checkMs));
  }

  private stop() {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = []; this.key = '';
    for (const timer of this.settling.values()) clearTimeout(timer);
    for (const { timer } of this.recent.values()) clearTimeout(timer);
    this.settling.clear(); this.recent.clear(); this.cancelled.clear(); clearTimeout(this.held); clearTimeout(this.cleaner);
  }

  /** Stops watching for good. */
  async close() { this.generation++; clearTimeout(this.poll); for (const timer of this.protectedFiles.values()) clearTimeout(timer); this.protectedFiles.clear(); this.stop(); }

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
    if (this.recent.has(id) || this.running.has(id) || !this.watching) return;
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
      this.stop();
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
