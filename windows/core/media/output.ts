import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { retryBusy } from '../run';

/** Runs `task` with a temporary folder inside `outputDir`, removed afterwards, so results can be renamed into place. */
export async function withTemp<T>(outputDir: string, task: (tmp: string) => Promise<T>) {
  await mkdir(outputDir, { recursive: true });
  const tmp = await mkdtemp(path.join(outputDir, '.clop-'));
  try { return await task(tmp); } finally { await rm(tmp, { recursive: true, force: true }); }
}

/** Moves a finished file to `<outputDir>/<stem>.<ext>`, or `<stem>-optimised.<ext>` when that is the input itself. Returns the new path. */
export async function moveResult(input: string, file: string, outputDir: string, stem: string, ext: string) {
  let output = path.join(outputDir, `${stem}.${ext}`);
  if (path.resolve(output) === path.resolve(input)) output = path.join(outputDir, `${stem}-optimised.${ext}`);
  await retryBusy(() => rename(file, output));
  return output;
}
