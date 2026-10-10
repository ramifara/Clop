import { stat } from 'node:fs/promises';
import path from 'node:path';
import { copyTo } from '../fileops';
import { detectKind } from '../media/detect';
import { applyLocation } from './files';
import { stepEntry, type PipelineStep, type StepParamMap } from './model';
import { stepLocation } from './processing';
import type { RunState } from './run-state';

// The action steps (PipelineExecution.swift) other than scripts (scripts.ts): the clipboard and fork. Windows has no shelf
// apps or Dropshare, so `shelveWith` and `uploadWith` open the file with the named app (executor.ts).

/** `handleCopyToClipboard`: the path, the image itself, or a Markdown link, with `relativeTo` taken off the front of the path. */
export async function copyToClipboard(run: RunState, { format, relativeTo }: StepParamMap['copyToClipboard']) {
  const file = run.current;
  const shown = relativeTo === undefined ? file : file.replaceAll(run.resolve(relativeTo), '');
  if (format === 'imageData' && run.fileType === 'image') await run.opts.effects.copyToClipboard({ image: file });
  // Markdown links use forward slashes, which every renderer reads.
  else if (format === 'markdown') await run.opts.effects.copyToClipboard({ text: `[${path.parse(file).name}](${shown.replaceAll('\\', '/')})` });
  else await run.opts.effects.copyToClipboard({ text: shown });
  await run.mark(file);
}

/** Whether a later step would overwrite, move or delete the current file, so a fork has to keep its own copy. */
function forkNeedsCopy(following: PipelineStep[]) {
  return following.some(step => {
    const [kind] = stepEntry(step);
    if (kind === 'delete' || kind === 'move' || kind === 'rename') return true;
    if (kind === 'convert') return stepLocation(step) === 'inPlace';
    return ['optimise', 'downscale', 'lowerBitrate', 'crop', 'targetSize', 'stripExif', 'watermark', 'capFps', 'normalize', 'removeAudio', 'changeSpeed'].includes(kind) && (stepLocation(step) ?? 'inPlace') === 'inPlace';
  });
}

/**
 * `handleFork`: hands back the result so far as a second result, leaving the file the pipeline carries on with alone. With a
 * location it is saved there; otherwise it is the current file itself, or a temporary copy when a later step would change it.
 */
export async function fork(run: RunState, location: string | undefined, following: PipelineStep[]) {
  const source = run.current;
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile() || !info.size || !await detectKind(source, { signal: run.signal }).catch(() => undefined)) return;
  const copy = async () => copyTo(source, path.join(await run.scratch(), path.basename(source)));
  let file = source;
  if (location && location !== 'temporaryFolder' && location !== 'inPlace') file = await applyLocation(run, location, await copy(), run.original);
  else if (forkNeedsCopy(following)) file = await copy();
  run.forks.push(file);
}
