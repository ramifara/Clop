import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, exists, samePath } from '../core/fileops';
import type { OptimisedMarker } from '../core/marker';
import { executePlacement, placedExtension, planPlacement, type PlacementEnv, type PlacementOverride } from '../core/placement';
import type { ClopSettings } from '../core/settings/schema';
import type { MediaKind, MediaOutput } from '../core/media/types';
import type { ImageOptions } from '../src/types';
import { message, type ItemAutomation, type ItemEngine, type ItemPlacement } from './items';
import { hidesResult } from './watch-rules';

export type FolderEnv = PlacementEnv & { marker: OptimisedMarker };

/**
 * Where a watched file's result goes, by its `optimised<Kind>Behaviour` (core/placement): by default over the file, whose
 * original moves into the working directory's backups first. Placed files are marked optimised, so the watcher leaves them
 * alone. `restore` puts the original back where the result went and marks it too, as macOS marks a restored original, and
 * gives back any file of the user's that a result replaced. It refuses when the result was moved, deleted or edited since,
 * so a revert never undoes the user's own changes. `saved` hears the `%i` counter after a name template advanced it. `overrides` are
 * a request's own placement (the command line's `--behaviour` and templates).
 */
export function folderPlacement(file: string, kind: MediaKind, env: () => FolderEnv, saved?: (counter: number) => void, overrides?: PlacementOverride): ItemPlacement {
  /** The first backup: the file as it was before Clop wrote over it. `stamp` is the size and modification time of the result as Clop left it. */
  let backup: string | undefined, placed: string | undefined, stamp: { size: number; mtimeMs: number } | undefined;
  /** Backups of the user's own files that results took the place of, by where they were. */
  const replaced = new Map<string, string>();
  const key = (target: string) => { const resolved = path.resolve(target); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const mark = (target: string) => env().marker.markOptimised(target).catch(() => {});
  /** Clears a place a result was put: the user's file that sat there comes back, or the result goes. */
  async function vacate(target: string) {
    const own = replaced.get(key(target));
    if (!own) { await rm(target, { force: true }); return; }
    await copyTo(own, target);
    replaced.delete(key(target));
    // Marked, so coming back does not get it optimised.
    await mark(target);
  }
  async function restore() {
    if (!placed) return undefined;
    const name = path.basename(placed);
    if (!await exists(placed)) throw new Error(`${name} was moved or deleted after Clop optimised it, so its original stays in the backups.`);
    // Judged by the result this placement left, not by the shared marker, which a later optimisation of an edited file refreshes.
    if (await edited(placed)) throw new Error(`${name} changed after Clop optimised it, so Clop left it as it is. Its original is in the backups.`);
    if (backup && !samePath(placed, file) && await exists(file)) throw new Error(`A new ${path.basename(file)} is where the original was, so Clop left both as they are. The original is in the backups.`);
    let target = file;
    // Over the file, the backup goes back. A copy beside the file (`sameFolder`, `specificFolder`) gives back the user's file it
    // replaced, or else gets the untouched original, as macOS restores a templated copy.
    if (backup) { await copyTo(backup, file); await mark(file); if (!samePath(placed, file)) await vacate(placed); }
    else if (replaced.has(key(placed))) await vacate(placed);
    else { target = placed; await copyTo(file, placed); await mark(placed); }
    placed = undefined; stamp = undefined;
    return target;
  }
  /** Whether the result this placement left was changed since (by size or modification time), as a later save or another optimisation would. */
  async function edited(file: string) {
    const now = await stat(file).catch(() => undefined);
    return !stamp || !now || now.size !== stamp.size || Math.abs(now.mtimeMs - stamp.mtimeMs) >= 2;
  }
  return {
    async place(output: MediaOutput, staged?: string, manual = false) {
      // A file saved again while its result was made would go to the backups and be replaced by this out-of-date result. The shelf's copy keeps the size and modification time the file had when it was read.
      if (!placed && staged && await changedSince(file, staged)) throw new Error(`${path.basename(file)} changed since Clop read it, so Clop left it as it is.`);
      // A result that is not smaller is the original itself.
      if (output.unchanged) { if (placed) return (await restore())!; await mark(file); return file; }
      // A card action places again over its earlier result; one the user changed since is theirs now, and stays. One moved away (a pipeline
      // that sorts files, or the user) is not followed: a new copy would appear where the user's file was moved from.
      if (placed && !await exists(placed)) throw new Error(`${path.basename(placed)} was moved or deleted after Clop optimised it, so Clop does not put a new copy where it was.`);
      if (placed && await edited(placed)) throw new Error(`${path.basename(placed)} changed after Clop optimised it, so Clop left it as it is.`);
      const e = env(), before = e.counter.value;
      // A result in another format is a conversion, placed by the settings for converted files: the card's format menu by the manual ones.
      const converted = placedExtension(output.path, file) !== path.extname(file);
      const plan = await planPlacement(e, { produced: output.path, original: file, type: kind, kind: converted ? manual ? 'manualConvert' : 'autoConvert' : 'optimised', overrides });
      // `temporary` keeps results in the shelf only.
      if (!plan.dest) return output.path;
      const result = await executePlacement(e, plan, output.path, file);
      if (e.counter.value !== before) saved?.(e.counter.value);
      backup ??= result.backup;
      // What sat at the destination was the user's, unless it was Clop's earlier result.
      if (result.replaced && !(placed && samePath(placed, result.path))) replaced.set(key(result.path), result.replaced);
      // A converted result from the card takes the place of the earlier one rather than sitting beside it.
      if (placed && !samePath(placed, result.path) && !samePath(placed, file)) await vacate(placed);
      // The setting moved results off the file since: it holds Clop's earlier result, so the original goes back and the copy sits beside it.
      else if (placed && samePath(placed, file) && !samePath(result.path, file) && backup) { await copyTo(backup, file); await mark(file); backup = undefined; }
      placed = result.path;
      stamp = await stat(result.path).then(({ size, mtimeMs }) => ({ size, mtimeMs }), () => undefined);
      return result.path;
    },
    restore,
    async follow(file: string) {
      if (!placed) return;
      placed = file;
      stamp = await stat(file).then(({ size, mtimeMs }) => ({ size, mtimeMs }), () => undefined);
    },
  };
}

/** Whether `file` no longer has the size and modification time (within the millisecond or two that setting a time rounds by) of `staged`, the copy made when it was read. A missing file counts as changed. */
async function changedSince(file: string, staged: string) {
  const [now, then] = await Promise.all([stat(file).catch(() => undefined), stat(staged)]);
  return !now || now.size !== then.size || Math.abs(now.mtimeMs - then.mtimeMs) >= 2;
}

/** Restores each result on its own, so one that cannot be restored does not stop the rest. Returns the ids restored and a message for each failure. */
export async function restoreAll(engine: ItemEngine, ids: readonly string[]) {
  const restored: string[] = [], failures: string[] = [];
  for (const id of ids) {
    const name = engine.has(id) ? engine.get(id).result.name : 'A result';
    try { await engine.restore(id); restored.push(id); } catch (error) { failures.push(`${name}: ${message(error)}`); }
  }
  return { restored, failures };
}

/** The results of the latest optimisations, for "Revert last optimisations": results started within `gapMs` of each other, such as files appearing in a watched folder together. */
export class LastBatch {
  private ids: string[] = [];
  private at = -Infinity;
  constructor(private gapMs = 2000, private now = Date.now) {}
  add(id: string) { const now = this.now(); if (now - this.at > this.gapMs) this.ids = []; this.ids.push(id); this.at = now; }
  get size() { return this.ids.length; }
  /** The batch's ids; the batch is then empty. */
  take() { const ids = this.ids; this.ids = []; this.at = -Infinity; return ids; }
}

export interface FolderHost {
  engine: ItemEngine;
  settings: () => ClopSettings;
  env: () => FolderEnv;
  saved?: (counter: number) => void;
  options: () => ImageOptions;
  /** Called before a result is added, to keep the shelf from growing without end. */
  makeRoom: () => Promise<void>;
  /** A result from a folder in `dirsHideFloatingResult`: kept from the floating results. */
  quiet: (id: string) => void;
  home?: string;
  /**
   * The pipelines attached to the watched folder `dir`, as the item's automation (`attachedAutomation`), or undefined when
   * there are none. `id` gives the result's id once it is in the shelf.
   */
  automation?: (file: string, kind: MediaKind, dir: string, id: () => string | undefined) => ItemAutomation | undefined;
}
/** Optimises files from watched folders as shelf results placed back in their folder. */
export class FolderResults {
  private ids = new Map<string, string>();
  /** Files whose optimisation has started, and those of them cancelled before their result was in the shelf. */
  private pending = new Set<string>();
  private cancelled = new Set<string>();
  constructor(private host: FolderHost) {}
  private key(file: string) { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
  /**
   * The watcher's `handle`: optimises `file` from the watched folder `dir`. Resolves with where its result went. `automation` replaces the
   * folder's attached pipelines, for a pipeline chosen for this file (Explorer's "Run pipeline...").
   */
  async optimise(file: string, kind: MediaKind, dir: string, automation = this.host.automation): Promise<string | undefined> {
    const { engine } = this.host, key = this.key(file);
    this.pending.add(key);
    try {
      const hide = hidesResult(dir, this.host.settings(), this.host.home);
      let staged: string | undefined;
      const attached = automation?.(file, kind, dir, () => staged);
      await this.host.makeRoom();
      if (this.cancelled.has(key)) return;
      // Watched files are optimised in their own format; converting is left to the card.
      const id = await engine.importPath(file, 'folder', { ...this.host.options(), format: 'auto' }, undefined, {
        placement: folderPlacement(file, kind, this.host.env, this.host.saved), automation: attached,
        staged: id => {
          staged = id;
          this.ids.set(key, id);
          if (this.cancelled.has(key)) void engine.dismiss(id).catch(() => {});
          else if (hide) this.host.quiet(id);
        },
      });
      return engine.has(id) && engine.get(id).result.status === 'ready' ? engine.output(id) : undefined;
    } finally { this.ids.delete(key); this.pending.delete(key); this.cancelled.delete(key); }
  }
  /**
   * The watcher's `cancel`: removes the results of files that turned out to be part of too large a batch, which stops their
   * jobs. A file still being copied into the shelf is removed as soon as it is there.
   */
  cancel(files: readonly string[]) {
    for (const file of files) {
      const key = this.key(file), id = this.ids.get(key);
      if (id) void this.host.engine.dismiss(id).catch(() => {});
      else if (this.pending.has(key)) this.cancelled.add(key);
    }
  }
}
