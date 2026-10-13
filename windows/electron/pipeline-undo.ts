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
// Only backups this run made are used: the run's working directory records each one (`recordingWorkdir`), and Restore uses exactly
// that record, never "the latest backup of this path", which another run or placement may have made since.

interface Stamp { size: number; mtimeMs: number }
const stampOf = (file: string) => stat(file).then(({ size, mtimeMs }): Stamp => ({ size, mtimeMs }), () => undefined);
const differs = (a: Stamp | undefined, b: Stamp | undefined) => !a || !b || a.size !== b.size || Math.abs(a.mtimeMs - b.mtimeMs) >= 2;

export interface UndoEnv { workdir: Workdir; mark?: (file: string) => Promise<void> }
/** What `beforeRun` noted about the original, for `undoRun`, and the backups the run makes, by the path they keep. */
export interface RunStart { file: string; stamp?: Stamp; backups: ReadonlyMap<string, string> }
const keyOf = (file: string) => { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };

/**
 * A working directory for one run that notes every backup made through it, the first one for each path: the version that path had
 * before the run. Everything else is the shared working directory's.
 */
export function recordingWorkdir(workdir: Workdir): { workdir: Workdir; backups: Map<string, string> } {
  const backups = new Map<string, string>(), recording = Object.create(workdir) as Workdir;
  recording.backup = async (original, options) => {
    const made = await workdir.backup(original, options);
    if (made && !backups.has(keyOf(original))) backups.set(keyOf(original), made);
    return made;
  };
  return { workdir: recording, backups };
}

/** Notes the original as it is before the pipelines run on it, with `backups`, the record of the backups the run makes (`recordingWorkdir`). */
export async function beforeRun(file: string, backups: ReadonlyMap<string, string>): Promise<RunStart> {
  return { file, stamp: await stampOf(file), backups };
}

/**
 * The undo for a run that started from `start.file` and ended with `final`, given once the run is over. The returned function
 * puts things back and resolves with the original's path, or throws, before changing anything, when it cannot: the final file
 * was changed after the run, or the original was changed by the run with no backup of it.
 */
export async function undoRun(env: UndoEnv, start: RunStart, final: string): Promise<() => Promise<string>> {
  const finalStamp = await stampOf(final), beside = !samePath(final, start.file);
  // A file the run put where one of the user's was: the backup of it the run made (`placement.ts` keeps it as `replaced`).
  const replaced = beside ? start.backups.get(keyOf(final)) : undefined, original = start.backups.get(keyOf(start.file));
  return async () => {
    const name = path.basename(start.file);
    const now = await stampOf(start.file), changed = differs(now, start.stamp);
    if (changed && !original) throw new Error(`A pipeline changed ${name} and kept no copy of it, so Clop leaves it as it is.`);
    if (changed && !await exists(original!)) throw new Error(`The copy of ${name} that the pipeline kept is no longer in the backups, so Clop leaves ${name} as it is.`);
    if (beside && await exists(final) && differs(await stampOf(final), finalStamp)) throw new Error(`${path.basename(final)} changed after the pipeline made it, so Clop left it as it is.`);
    if (beside && replaced && await exists(final) && !await exists(replaced)) throw new Error(`The copy of the ${path.basename(final)} that the pipeline replaced is no longer in the backups, so Clop leaves ${path.basename(final)} as it is.`);
    const backup = changed ? original : undefined;
    if (beside && await exists(final)) {
      if (replaced) await copyTo(replaced, final); else await rm(final, { force: true });
    }
    if (backup) await copyTo(backup, start.file);
    // Marked, so a watched folder does not optimise the original again.
    if (backup || !changed) await env.mark?.(start.file).catch(() => {});
    return start.file;
  };
}
