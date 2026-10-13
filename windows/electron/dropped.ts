import { stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_BATCH_ENTRIES, MAX_BATCH_FILES, scanBatch, type ScanOptions } from '../core/batch/scan';

// A drop can hold folders as well as files (the native helper offers Explorer's selected folders to the drop zone). The batch
// window takes them whole; this is what the one-by-one import does with them when `useBatchModeForFolders` is off or a drop is
// small, as optimiseDir does on macOS: every supported file inside, recursive, hidden files and `.clopignore-<type>` rules skipped.

const isDirectory = (file: string) => stat(file).then(info => info.isDirectory(), () => false);

/** Splits a drop into its folders and everything else, in the order given. Undefined when it is not a list of absolute paths. */
export async function splitFolders(files: unknown): Promise<{ folders: string[]; files: string[] } | undefined> {
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) return undefined;
  const flags = await Promise.all((files as string[]).map(isDirectory));
  return { folders: (files as string[]).filter((_, i) => flags[i]), files: (files as string[]).filter((_, i) => !flags[i]) };
}

export interface Expanded {
  /** The files to optimise: the dropped files, then those found in the folders. */
  files: string[];
  /** Notices to show: folders without supported files, and what a limit left out. */
  notices: string[];
}

/** Replaces each dropped folder with the supported files inside it. */
export async function expandDroppedFolders(files: readonly string[], options: ScanOptions = {}): Promise<Expanded> {
  const { folders, files: plain } = (await splitFolders([...files])) ?? { folders: [], files: [...files] };
  const notices: string[] = [], found: string[] = [];
  for (const folder of folders) {
    const scanned = await scanBatch([folder], { ...options, limit: Math.min(options.limit ?? MAX_BATCH_FILES, MAX_BATCH_FILES - found.length), maxEntries: options.maxEntries ?? MAX_BATCH_ENTRIES });
    const name = path.basename(folder) || folder;
    if (!scanned.files.length && !scanned.truncated && !scanned.entriesCapped) notices.push(`${name}: no images, videos, audio or PDFs to optimise.`);
    if (scanned.truncated) notices.push(`${name}: only the first ${MAX_BATCH_FILES.toLocaleString('en-US')} files were optimised.`);
    if (scanned.entriesCapped) notices.push(`${name}: Clop stopped looking after ${MAX_BATCH_ENTRIES.toLocaleString('en-US')} folders and files.`);
    if (scanned.cloud) notices.push(`${name}: ${scanned.cloud} ${scanned.cloud === 1 ? 'file that is' : 'files that are'} only in the cloud ${scanned.cloud === 1 ? 'was' : 'were'} skipped.`);
    found.push(...scanned.files.map(file => file.path));
  }
  const seen = new Set<string>(), key = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  return { files: [...plain, ...found].filter(file => !seen.has(key(file)) && seen.add(key(file))), notices };
}
