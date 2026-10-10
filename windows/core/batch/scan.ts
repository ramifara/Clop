import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ignoredBy } from '../clopignore';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../media/detect';
import type { MediaKind } from '../media/types';
import { BATCH_KINDS } from './spec';

// expandBatchPaths and buildBatchItems (BatchOptimiser.swift): dropped files and folders become the files of a batch.

/** A file in a batch, typed by its extension as macOS does, so a large folder scans without opening every file. */
export interface BatchFile { path: string; kind: MediaKind; bytes: number; format: string }
export interface ScanOptions {
  /** Files Clop keeps for itself (the working directory), which never join a batch. */
  owns?: (file: string) => boolean;
  /** At most this many files; the rest are left out and `truncated` is set. */
  limit?: number;
  platform?: NodeJS.Platform;
}

const KINDS = new Map<string, MediaKind>([
  ...IMAGE_EXTENSIONS.map(ext => [ext, 'image'] as const), ...VIDEO_EXTENSIONS.map(ext => [ext, 'video'] as const),
  ...AUDIO_EXTENSIONS.map(ext => [ext, 'audio'] as const), ['pdf', 'pdf'],
]);
/** The media type of a file by its extension, or undefined when a batch cannot take it. */
export const batchKind = (file: string) => KINDS.get(path.extname(file).slice(1).toLowerCase());
export const MAX_BATCH_FILES = 10_000;

/**
 * The supported files among `paths`: files as they are, folders walked with every subfolder. Hidden files, links and Clop's
 * own files are skipped, and so is whatever the `.clopignore-<type>` file at the top of a dropped folder names. A file that
 * arrives twice (a file and the folder holding it) is listed once.
 */
export async function scanBatch(paths: readonly string[], { owns = () => false, limit = MAX_BATCH_FILES, platform = process.platform }: ScanOptions = {}) {
  const files: BatchFile[] = [], seen = new Set<string>();
  let truncated = false;
  const add = async (file: string, kind: MediaKind) => {
    const key = platform === 'win32' ? file.toLowerCase() : file;
    if (seen.has(key) || owns(file)) return;
    if (files.length >= limit) { truncated = true; return; }
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return;
    seen.add(key);
    files.push({ path: file, kind, bytes: info.size, format: path.extname(file).slice(1).toUpperCase() });
  };
  const walk = async (root: string) => {
    const rules = new Map<MediaKind, string>();
    for (const kind of BATCH_KINDS) rules.set(kind, await readFile(path.join(root, `.clopignore-${kind}`), 'utf8').catch(() => ''));
    const visit = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const entry of entries) {
        if (truncated) return;
        if (entry.name.startsWith('.')) continue;
        const file = path.join(dir, entry.name);
        // Links and junctions are not followed: one could lead back up the tree or out of the dropped folder.
        if (entry.isDirectory()) { if (!owns(file)) await visit(file); continue; }
        const kind = entry.isFile() ? batchKind(file) : undefined, own = kind && rules.get(kind);
        if (kind && !(own && ignoredBy(own, path.relative(root, file).split(path.sep).join('/'), platform))) await add(file, kind);
      }
    };
    await visit(root);
  };
  for (const raw of paths) {
    if (truncated) break;
    const file = path.resolve(raw), info = await lstat(file).catch(() => undefined);
    if (info?.isDirectory()) await walk(file);
    else if (info?.isFile()) { const kind = batchKind(file); if (kind) await add(file, kind); }
  }
  return { files, truncated };
}
