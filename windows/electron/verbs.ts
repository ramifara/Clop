import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURL, urlPath, type OptimisationRequest } from '../core/ipc/protocol';
import type { MediaKind } from '../core/media/types';
import type { VerbId } from '../core/shell-verbs';
import { mediaKind } from './clipboard';

// What the app does for Explorer's right-click verbs (spec step 39), once the launches of a selection are gathered. The work goes
// through the same service as `clop optimise --gui`, so it shares the app's queues and shows cards; nothing starts a second process.

/** The types each verb works on, as the verbs' registry filters say. */
const TYPES: Record<Exclude<VerbId, 'run-pipeline'>, readonly MediaKind[]> = {
  optimise: ['image', 'video', 'audio', 'pdf'], aggressive: ['image', 'video', 'audio', 'pdf'], downscale: ['image', 'video', 'audio'], 'strip-exif': ['image', 'video'],
};
/** `Downscale` takes half the size, as `clop downscale` does without `--factor`. */
export const EXPLORER_DOWNSCALE = 0.5;

/** The files a verb can work on, in order, and how many were left out for being of another type (a stray file in a mixed selection). */
export function usableFiles(verb: Exclude<VerbId, 'run-pipeline'>, files: readonly string[]): { use: string[]; skipped: number } {
  const use = files.filter(file => { const kind = mediaKind(file); return kind && TYPES[verb].includes(kind); });
  return { use, skipped: files.length - use.length };
}

/**
 * A folder in the selection (Send To takes folders) stands for its media files, one level down, as `clop optimise` expands a folder; anything
 * else stays as it is. A folder that cannot be read is left in, and then counts among the files left out.
 */
export async function expandFolders(files: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const file of files) {
    if (!(await stat(file).catch(() => undefined))?.isDirectory()) { out.push(file); continue; }
    const names = await readdir(file, { withFileTypes: true }).catch(() => undefined);
    if (!names) { out.push(file); continue; }
    for (const name of names.map(entry => entry.isFile() ? entry.name : '').filter(name => name && mediaKind(name)).sort()) out.push(path.join(file, name));
  }
  return out;
}

/** The name a notice shows for the file a reply is about: its file name, not the percent-encoded end of its `file:` URL. */
export function failureName(forURL: string) {
  const file = urlPath(forURL);
  if (file !== undefined) return path.basename(file);
  try { return decodeURIComponent(path.posix.basename(new URL(forURL).pathname)) || forURL; } catch { return forURL; }
}

/** What the user is told after an optimise, aggressive or downscale verb: the first failures, a downscale of video or audio (no card shows for those), and files left out. */
export function verbNotes({ verb, done, failures, skipped }: { verb: 'optimise' | 'aggressive' | 'downscale'; done: readonly string[]; failures: readonly string[]; skipped: number }) {
  const quiet = verb === 'downscale' ? done.filter(file => { const kind = mediaKind(file); return kind === 'video' || kind === 'audio'; }).length : 0;
  return [
    ...(quiet ? [`Downscaled ${quiet} video or audio file${quiet === 1 ? '' : 's'}.`] : []),
    ...failures.slice(0, 3), ...(failures.length > 3 ? [`${failures.length - 3} more failed.`] : []), ...(skipped ? [skippedNote(skipped)] : []),
  ];
}

/** The request for optimise, aggressive and downscale: in place, with a card, like `clop <verb> --gui`. */
export function explorerRequest(verb: 'optimise' | 'aggressive' | 'downscale', files: readonly string[], id: string): OptimisationRequest {
  return {
    id, urls: files.map(fileURL), hideFloatingResult: false, copyToClipboard: false, aggressiveOptimisation: verb === 'aggressive', source: 'explorer',
    ...(verb === 'downscale' ? { downscaleFactor: EXPLORER_DOWNSCALE } : {}),
  };
}

/** Strips each file in turn and says how it went: files done, and the failures by file name. */
export async function stripAll(files: readonly string[], strip: (file: string) => Promise<void>): Promise<{ done: number; failed: { file: string; reason: string }[] }> {
  let done = 0;
  const failed: { file: string; reason: string }[] = [];
  for (const file of files) {
    try { await strip(file); done++; } catch (error) { failed.push({ file, reason: error instanceof Error ? error.message : String(error) }); }
  }
  return { done, failed };
}

/** The notice after a strip: what was done, the first failures, and any files left out for being of another type. */
export function stripSummary(result: Awaited<ReturnType<typeof stripAll>>, skipped: number) {
  const parts = [result.done ? `Removed metadata from ${result.done} file${result.done === 1 ? '' : 's'}.` : '', ...result.failed.slice(0, 3).map(({ file, reason }) => `${file.split(/[\\/]/).pop()}: ${reason}`)];
  if (result.failed.length > 3) parts.push(`${result.failed.length - 3} more failed.`);
  if (skipped) parts.push(skippedNote(skipped));
  return parts.filter(Boolean).join('\n');
}
/** The note for files a verb left out because it does not work on their type. */
export const skippedNote = (skipped: number) => `${skipped} file${skipped === 1 ? ' was' : 's were'} left out: this does not work on their type.`;
