import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyTo, exists } from '../fileops';
import type { OptimisedMarker } from '../marker';
import type { Workdir } from '../workdir';
import { COLOUR_TAGS } from './exif';
import { exiftool } from './exiftool';

/** Where a stripped file's original is kept, and what records the stripped file as Clop's. */
export interface StripKeep { workdir: Workdir; marker: OptimisedMarker }

/**
 * `StripExif.strip` (`clop strip-exif` and Explorer's "Strip EXIF"): exiftool writes a stripped copy, which then replaces the file;
 * resolution, orientation and colour stay. Like every other write over a file, the original is first copied into the work folder's
 * backups (a failed backup stops the strip), and the stripped file is marked optimised, so a watched folder does not optimise it
 * again. Throws with exiftool's message when it cannot.
 */
export async function stripExifFile(file: string, { workdir, marker }: StripKeep): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'clop-exif-')), copy = path.join(temp, path.basename(file));
  try {
    await exiftool(['-charset', 'filename=utf8', '-XResolution=72', '-YResolution=72', '-all=', '-tagsFromFile', '@', '-XResolution', '-YResolution', '-Orientation', ...COLOUR_TAGS, '-o', copy, file]);
    if (!await exists(copy)) throw new Error('exiftool wrote nothing');
    await workdir.backup(file, { force: true }).catch(error => { throw new Error(`Could not back up ${file} before replacing it: ${error instanceof Error ? error.message : error}`); });
    await copyTo(copy, file);
    await marker.markOptimised(file).catch(() => {});
  } finally { await rm(temp, { recursive: true, force: true }); }
}
