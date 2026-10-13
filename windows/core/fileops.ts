import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { retryBusy } from './run';

/** Whether two paths name the same file. Windows ignores case, so `C:\\A\\x.png` and `c:\\a\\X.PNG` are one file there. */
export const samePath = (a: string, b: string, platform: NodeJS.Platform = process.platform) => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

export const exists = (file: string) => stat(file).then(() => true, () => false);

/** Copies `source` to `dest` through a sibling temporary file, so `dest` is either the old file or the whole new one. Keeps the modification time. Returns `dest`; with `force: false` an existing `dest` is left alone. */
export async function copyTo(source: string, dest: string, { force = true } = {}): Promise<string> {
  if (path.resolve(source) === path.resolve(dest)) return dest;
  if (!force && await exists(dest)) return dest;
  await mkdir(path.dirname(dest), { recursive: true });
  const temporary = path.join(path.dirname(dest), `.clop-${randomUUID()}.tmp`);
  try {
    await retryBusy(() => copyFile(source, temporary));
    const info = await stat(source);
    await utimes(temporary, info.atime, info.mtime);
    await retryBusy(() => rename(temporary, dest));
  } finally { await rm(temporary, { force: true }); }
  return dest;
}

/** Renames `source` to `dest`, copying across volumes when a rename cannot cross them. */
export async function moveTo(source: string, dest: string, { force = true } = {}): Promise<string> {
  if (path.resolve(source) === path.resolve(dest)) return dest;
  if (!force && await exists(dest)) return dest;
  await mkdir(path.dirname(dest), { recursive: true });
  try { await retryBusy(() => rename(source, dest)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyTo(source, dest);
    await retryBusy(() => rm(source));
  }
  return dest;
}
