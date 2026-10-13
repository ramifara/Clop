import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, exists, samePath } from '../core/fileops';
import type { Workdir } from '../core/workdir';

// Restoring a result whose pipelines ran on the user's own file (a watched, dropped or opened file, with pipelines that skip
// optimisation). macOS restores such a result from the starting file's backup (`restoreOriginal` in OptimisationUtils.swift: the
// `startingURL` branch puts `clopBackupPath` back); here what the pipelines made is undone as far as it safely can be:
// - a file they made beside the original (a conversion, a renamed copy) is removed, or the user's file it replaced comes back;
// - the original stays as it is when they left it alone, and comes back from the backup a step of theirs made when they changed it;
// - with the original changed and no backup of it, nothing is touched and Restore says why.

interface Stamp { size: number; mtimeMs: number }
const stampOf = (file: string) => stat(file).then(({ size, mtimeMs }): Stamp => ({ size, mtimeMs }), () => undefined);
const differs = (a: Stamp | undefined, b: Stamp | undefined) => !a || !b || a.size !== b.size || Math.abs(a.mtimeMs - b.mtimeMs) >= 2;

export interface UndoEnv { workdir: Workdir; mark?: (file: string) => Promise<void> }
/** What `beforeRun` noted about the original, for `undoRun`. */
export interface RunStart { file: string; stamp?: Stamp; backup?: string }

/** Notes the original as it is before the pipelines run on it: its size and time, and where a backup of this version of it goes. */
export async function beforeRun(env: UndoEnv, file: string): Promise<RunStart> {
  const stamp = await stampOf(file);
  return { file, stamp, backup: stamp ? await env.workdir.backupPath(file).catch(() => undefined) : undefined };
}

/**
 * The undo for a run that started from `start.file` and ended with `final`, given once the run is over. The returned function
 * puts things back and resolves with the original's path, or throws, before changing anything, when it cannot: the final file
 * was changed after the run, or the original was changed by the run with no backup of it.
 */
export async function undoRun(env: UndoEnv, start: RunStart, final: string): Promise<() => Promise<string>> {
  const finalStamp = await stampOf(final), beside = !samePath(final, start.file);
  // A file the run put where one of the user's was: its backup, made by the step that placed it (`placement.ts` keeps it as `replaced`).
  const replaced = beside ? await env.workdir.latestBackup(final) : undefined;
  return async () => {
    const name = path.basename(start.file);
    const now = await stampOf(start.file), changed = differs(now, start.stamp);
    const backup = changed && start.backup && await exists(start.backup) ? start.backup : undefined;
    if (changed && !backup) throw new Error(`A pipeline changed ${name} and kept no copy of it, so Clop leaves it as it is.`);
    if (beside && await exists(final) && differs(await stampOf(final), finalStamp)) throw new Error(`${path.basename(final)} changed after the pipeline made it, so Clop left it as it is.`);
    if (beside && await exists(final)) {
      if (replaced && await exists(replaced)) await copyTo(replaced, final); else await rm(final, { force: true });
    }
    if (backup) await copyTo(backup, start.file);
    // Marked, so a watched folder does not optimise the original again.
    if (backup || !changed) await env.mark?.(start.file).catch(() => {});
    return start.file;
  };
}
