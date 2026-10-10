import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ClopSettings } from '../core/settings/schema';
import type { MediaKind } from '../core/media/types';
import { expandHome } from '../core/settings/paths';
import { probeImage } from '../core/media/image-codecs';
import { probe } from '../core/media/detect';
import { mediaKind, skipsFormat } from './clipboard';

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
 * Clop's own files, within the size limits, not already optimised, and within the resolution limits. An image whose size
 * cannot be read is skipped; a video is optimised anyway, as macOS does.
 */
export async function qualifies(kind: MediaKind, file: string, s: ClopSettings, { owns, isOptimised }: { owns: (file: string) => boolean; isOptimised: (file: string) => Promise<boolean> }): Promise<boolean> {
  const w = watchSettings(kind, s);
  if (path.basename(file).startsWith('.') || mediaKind(file) !== kind || skipsFormat(w.skip, file) || owns(file)) return false;
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile() || !info.size || (w.maxMB && info.size >= w.maxMB * 1_000_000) || (w.minKB && info.size < w.minKB * 1000)) return false;
  if (await isOptimised(file)) return false;
  if (!w.minResolution && !w.maxResolution) return true;
  const size = await resolution(kind, file);
  if (!size) return kind !== 'image';
  const { width, height } = size, min = w.minResolution, max = w.maxResolution;
  return (!min || (width >= min && height >= min)) && (!max || (width <= max && height <= max));
}

const glob = (pattern: string) => pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/|\/\*\*|\*\*|\*|\?/g, token =>
  token === '**/' ? '(?:.*/)?' : token === '/**' ? '(?:/.*)?' : token === '**' ? '.*' : token === '*' ? '[^/]*' : '[^/]');

/**
 * Whether `relative` (a `/`-separated path inside a watched folder) is ignored by gitignore-style `rules`, as the
 * `.clopignore-<type>` file in a watched folder holds them: `#` comments, `!` to re-include, a leading or inner `/` anchors a
 * pattern to the folder, a trailing `/` matches folders only, and `*`, `?` and `**` wildcards. The last matching rule wins.
 */
export function ignoredBy(rules: string, relative: string, platform: NodeJS.Platform = process.platform): boolean {
  const parts = relative.split('/');
  let ignored = false;
  for (let line of rules.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!'); if (negate) line = line.slice(1);
    const folder = line.endsWith('/'); if (folder) line = line.slice(0, -1);
    const anchored = line.includes('/'), expression = new RegExp(`^${glob(line.replace(/^\//, ''))}$`, platform === 'win32' ? 'i' : '');
    // A folder rule matches the folders above the file; any other rule also matches the file itself.
    const candidates = parts.slice(0, folder ? -1 : undefined).map((part, i) => anchored ? parts.slice(0, i + 1).join('/') : part);
    if (candidates.some(candidate => expression.test(candidate))) ignored = !negate;
  }
  return ignored;
}

/** Whether `file` is ignored by the `.clopignore-<kind>` file in the watched folder `root`, read afresh each time as macOS does. */
export async function clopIgnored(kind: MediaKind, root: string, file: string) {
  const rules = await readFile(path.join(root, `.clopignore-${kind}`), 'utf8').catch(() => '');
  return !!rules && ignoredBy(rules, path.relative(root, file).split(path.sep).join('/'));
}
