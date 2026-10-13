import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyTo, exists } from '../fileops';
import { run } from '../run';
import { COLOUR_TAGS } from './exif';

/**
 * `StripExif.strip` (`clop strip-exif` and Explorer's "Strip EXIF"): exiftool writes a stripped copy, which then replaces the file;
 * resolution, orientation and colour stay. Throws with exiftool's message when it cannot.
 */
export async function stripExifFile(file: string): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'clop-exif-')), copy = path.join(temp, path.basename(file));
  try {
    await run('exiftool', ['-charset', 'filename=utf8', '-XResolution=72', '-YResolution=72', '-all=', '-tagsFromFile', '@', '-XResolution', '-YResolution', '-Orientation', ...COLOUR_TAGS, '-o', copy, file]);
    if (!await exists(copy)) throw new Error('exiftool wrote nothing');
    await copyTo(copy, file);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
