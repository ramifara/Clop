import { rm } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, samePath } from '../core/fileops';
import type { OptimisedMarker } from '../core/marker';
import { executePlacement, planPlacement, type PlacementEnv } from '../core/placement';
import type { ClopSettings } from '../core/settings/schema';
import type { MediaKind, MediaOutput } from '../core/media/types';
import type { ImageOptions } from '../src/types';
import type { ItemEngine, ItemPlacement } from './items';
import { hidesResult } from './watch-rules';

/**
 * The pipelines to run on a file of `kind` from `source` (a watched folder as stored, or `clipboard`). There are none until
 * pipelines exist, so every file is just optimised.
 */
export function pipelinesFor(_kind: MediaKind, _source: string): readonly { skipsPreOptimisation: boolean }[] { return []; }

export type FolderEnv = PlacementEnv & { marker: OptimisedMarker };

/**
 * Where a watched file's result goes, by its `optimised<Kind>Behaviour` (core/placement): by default over the file, whose
 * original moves into the working directory's backups first. Placed files are marked optimised, so the watcher leaves them
 * alone. `restore` puts the original back where the result went and marks it too, as macOS marks a restored original.
 * `saved` hears the `%i` counter after a name template advanced it.
 */
export function folderPlacement(file: string, kind: MediaKind, env: () => FolderEnv, saved?: (counter: number) => void): ItemPlacement {
  /** The first backup: the file as it was before Clop wrote over it. */
  let backup: string | undefined, placed: string | undefined;
  const mark = (target: string) => env().marker.markOptimised(target).catch(() => {});
  async function restore() {
    if (!placed) return undefined;
    // Over the file, the backup goes back; a copy beside it (`sameFolder`, `specificFolder`) gets the untouched original.
    const target = backup ? file : placed;
    await copyTo(backup ?? file, target);
    if (backup && !samePath(placed, file)) await rm(placed, { force: true });
    placed = undefined;
    await mark(target);
    return target;
  }
  return {
    async place(output: MediaOutput) {
      // A result that is not smaller is the original itself.
      if (output.unchanged) { if (placed) return (await restore())!; await mark(file); return file; }
      const e = env(), before = e.counter.value;
      const plan = await planPlacement(e, { produced: output.path, original: file, type: kind });
      // `temporary` keeps results in the shelf only.
      if (!plan.dest) return output.path;
      const result = await executePlacement(e, plan, output.path, file);
      if (e.counter.value !== before) saved?.(e.counter.value);
      backup ??= result.backup;
      // A converted result from the card replaces the earlier one rather than sitting beside it.
      if (placed && !samePath(placed, result.path) && !samePath(placed, file)) await rm(placed, { force: true });
      placed = result.path;
      return result.path;
    },
    restore,
  };
}

/** The results of the latest optimisations, for "Revert last optimisations": results started within `gapMs` of each other, such as files appearing in a watched folder together. */
export class LastBatch {
  private ids: string[] = [];
  private at = -Infinity;
  constructor(private gapMs = 2000, private now = Date.now) {}
  add(id: string) { const now = this.now(); if (now - this.at > this.gapMs) this.ids = []; this.ids.push(id); this.at = now; }
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
}
/** Optimises files from watched folders as shelf results placed back in their folder. */
export class FolderResults {
  private ids = new Map<string, string>();
  constructor(private host: FolderHost) {}
  private key(file: string) { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
  /** The watcher's `handle`: optimises `file` from the watched folder `dir`. Resolves with where its result went. */
  async optimise(file: string, kind: MediaKind, dir: string): Promise<string | undefined> {
    const { engine } = this.host, pipelines = pipelinesFor(kind, dir);
    if (pipelines.length && pipelines.every(pipeline => pipeline.skipsPreOptimisation)) return;
    const hide = hidesResult(dir, this.host.settings(), this.host.home), key = this.key(file);
    await this.host.makeRoom();
    try {
      // Watched files are optimised in their own format; converting is left to the card.
      const id = await engine.importPath(file, 'folder', { ...this.host.options(), format: 'auto' }, undefined, {
        placement: folderPlacement(file, kind, this.host.env, this.host.saved),
        staged: id => { this.ids.set(key, id); if (hide) this.host.quiet(id); },
      });
      return engine.has(id) && engine.get(id).result.status === 'ready' ? engine.output(id) : undefined;
    } finally { this.ids.delete(key); }
  }
  /** The watcher's `cancel`: stops and removes the results of files that turned out to be part of too large a batch. */
  cancel(files: readonly string[]) {
    const ids = files.flatMap(file => this.ids.get(this.key(file)) ?? []);
    this.host.engine.stop(ids);
    for (const id of ids) void this.host.engine.dismiss(id).catch(() => {});
  }
}
