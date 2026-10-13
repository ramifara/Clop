import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ClopSettings } from '../core/settings/schema';
import type { MediaKind } from '../core/media/types';
import { expandHome } from '../core/settings/paths';
import { probeImage } from '../core/media/image-codecs';
import { probe } from '../core/media/detect';
import { mediaKind, skipsFormat } from './clipboard';
export { clopIgnored, ignoredBy } from '../core/clopignore';

// The rules for which files appearing in a watched folder are optimised: FileOptimisationWatcher.swift and the
// `shouldHandleImage`/`Video`/`PDF`/`Audio` checks beside it.

const SUFFIX = { image: 'Image', video: 'Video', pdf: 'PDF', audio: 'Audio' } as const;
export const enabledKey = (kind: MediaKind) => `enableAutomatic${SUFFIX[kind]}Optimisations` as const;

/** One kind's watched-folder settings. Folders are as stored (`~/Desktop`); sizes are in MB and KB, 0 meaning no limit. */
export function watchSettings(kind: MediaKind, s: ClopSettings) {
  const x = SUFFIX[kind];
  return {
    dirs: s[`${kind}Dirs` as const], enabled: s[enabledKey(kind)], maxFiles: s[`max${x}FileCount` as const],
    maxMB: s[`max${x}SizeMB` as const], minKB: s[`min${x}SizeKB` as const],
    minResolution: kind === 'image' ? s.minImageResolution : kind === 'video' ? s.minVideoResolution : 0,
    maxResolution: kind === 'image' ? s.maxImageResolution : kind === 'video' ? s.maxVideoResolution : 0,
    skip: kind === 'image' ? s.imageFormatsToSkip : kind === 'video' ? s.videoFormatsToSkip : kind === 'audio' ? s.audioFormatsToSkip : [],
  };
}

const resolve = (dir: string, home?: string) => path.resolve(expandHome(dir, home));
const comparable = (file: string, platform: NodeJS.Platform) => platform === 'win32' ? file.toLowerCase() : file;
/** Whether `file` is inside `dir` (not `dir` itself). */
function inside(dir: string, file: string, platform: NodeJS.Platform) {
  const relative = path.relative(comparable(dir, platform), comparable(file, platform));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Port of `matchingWatchedDir` (Shared.swift): the deepest of `dirs` holding `file`, as it is stored, so it can key `dirsHideFloatingResult`. */
export function matchingWatchedDir(file: string, dirs: readonly string[], home?: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return dirs.filter(dir => inside(resolve(dir, home), path.resolve(file), platform)).sort((a, b) => resolve(b, home).length - resolve(a, home).length)[0];
}

/** Whether results from the watched folder `dir` skip the floating card (`dirsHideFloatingResult`). */
export function hidesResult(dir: string, s: Pick<ClopSettings, 'dirsHideFloatingResult'>, home?: string, platform: NodeJS.Platform = process.platform) {
  const target = comparable(resolve(dir, home), platform);
  return s.dirsHideFloatingResult.some(hidden => comparable(resolve(hidden, home), platform) === target);
}

/** The pixel size of an image or video, or undefined when it cannot be read. */
async function resolution(kind: MediaKind, file: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const info = kind === 'image' ? await probeImage(file) : await probe(file);
    return 'width' in info && info.width && info.height ? { width: info.width, height: info.height } : undefined;
  } catch { return undefined; }
}

/**
 * Whether a file that appeared in a watched folder is optimised: a visible file of `kind` in a format not skipped, not one of
 * Clop's own files, within the size limits, on this computer rather than a cloud placeholder (`isLocalFile` in
 * FileOptimisationWatcher.swift; checked before anything reads the file, since reading downloads it), not already
 * optimised, and within the resolution limits. An image whose size cannot be read is skipped; a video is optimised
 * anyway, as macOS does.
 */
export async function qualifies(kind: MediaKind, file: string, s: ClopSettings, { owns, isOptimised, isLocal }: { owns: (file: string) => boolean; isOptimised: (file: string) => Promise<boolean>; isLocal?: (file: string) => Promise<boolean> }): Promise<boolean> {
  const w = watchSettings(kind, s);
  if (path.basename(file).startsWith('.') || mediaKind(file) !== kind || skipsFormat(w.skip, file) || owns(file)) return false;
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || !info.size || (w.maxMB && info.size >= w.maxMB * 1_000_000) || (w.minKB && info.size < w.minKB * 1000)) return false;
  if ((isLocal && !await isLocal(file)) || await isOptimised(file)) return false;
  if (!w.minResolution && !w.maxResolution) return true;
  const size = await resolution(kind, file);
  if (!size) return kind !== 'image';
  const { width, height } = size, min = w.minResolution, max = w.maxResolution;
  return (!min || (width >= min && height >= min)) && (!max || (width <= max && height <= max));
}

/**
 * The `attributes` reply from the Windows helper: for each path asked about, whether it is a cloud placeholder whose content
 * is not on this computer (OneDrive files-on-demand: recall on data access, recall on open or offline).
 */
export function placeholderReply(reply: unknown, count: number): boolean[] {
  const cloud = (reply as Record<string, unknown> | null)?.cloud;
  if (!Array.isArray(cloud) || cloud.length !== count || !cloud.every(value => typeof value === 'boolean')) throw new Error('The Windows helper sent unreadable file attributes.');
  return cloud;
}

/** Whether `file`'s content is on this computer, by the helper's `ask` for its attributes. Without the helper there is no answer, and `unknown` stands for it. */
export async function localFile(file: string, ask: ((paths: string[]) => Promise<unknown>) | undefined, unknown: boolean): Promise<boolean> {
  return ask ? !placeholderReply(await ask([file]), 1)[0] : unknown;
}

/**
 * Whether `file` can be opened for writing, so it can be replaced in place: a writer still holding it (EBUSY, or EPERM and
 * EACCES on Windows while it is open) is waited for, `tries` times `delayMs` apart, as macOS checks a settled file is valid.
 */
export async function writable(file: string, { tries = 5, delayMs = 300 } = {}): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try { await (await open(file, 'r+')).close(); return true; } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= tries) return false;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Files under `root` changed since `since` (by modification or creation time), for the rescan after a watch lost changes. Hidden
 * folders, links to folders and folders `skip` names are not entered, and at most `limit` entries are looked at.
 */
export async function recentFiles(root: string, since: number, { limit = 20_000, skip }: { limit?: number; skip?: (dir: string) => boolean } = {}): Promise<string[]> {
  const found: string[] = [], folders = [root];
  let seen = 0;
  while (folders.length && seen < limit) {
    const folder = folders.shift()!;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (++seen > limit) break;
      const file = path.join(folder, entry.name);
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) { if (!skip?.(file)) folders.push(file); continue; }
      // On Windows a cloud placeholder can read as a link; a link that leads to a file counts as one, a link to a folder is not followed.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile() && Math.max(info.mtimeMs, info.birthtimeMs) >= since) found.push(file);
    }
  }
  return found;
}
