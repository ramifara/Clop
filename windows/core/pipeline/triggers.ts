import path from 'node:path';
import type { ClopSettings } from '../settings/schema';
import { resolveHome } from '../template';
import { isReadable, storedId } from './codec';
import { resolvePipeline, type ClopFileType, type Pipeline } from './model';

// `pipelinesFor` (Clop/Pipeline.swift): the pipelines attached to a source, a watched folder's path or `clipboard`.

export const PIPELINE_SOURCE_KEYS = { image: 'pipelinesToRunOnImage', video: 'pipelinesToRunOnVideo', pdf: 'pipelinesToRunOnPdf', audio: 'pipelinesToRunOnAudio' } as const satisfies Record<ClopFileType, keyof ClopSettings>;

/** A folder key as a comparable path: `~` and `$HOME` expanded, no trailing separator, and on Windows any case and either slash. */
function sourceKey(source: string, home?: string, platform: NodeJS.Platform = process.platform) {
  if (!/[\\/]|^~/.test(source)) return source;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const resolved = p.normalize(resolveHome(source, home, platform)).replace(/(?<=.)[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The pipelines to run on a `type` file from `source`, each reference resolved to the saved pipeline it names. A folder
 * attached as `~/Downloads` matches its full path. Entries this version cannot read, and references to saved pipelines it
 * cannot read, are left out; they stay in settings.
 */
export function pipelinesFor(type: ClopFileType, source: string, settings: Pick<ClopSettings, (typeof PIPELINE_SOURCE_KEYS)[ClopFileType] | 'savedPipelines'>, { home, platform }: { home?: string; platform?: NodeJS.Platform } = {}): Pipeline[] {
  const attached = settings[PIPELINE_SOURCE_KEYS[type]] ?? {}, wanted = sourceKey(source, home, platform);
  const entries = attached[source] ?? Object.entries(attached).find(([key]) => sourceKey(key, home, platform) === wanted)?.[1] ?? [];
  const saved = settings.savedPipelines.filter(isReadable);
  // A reference to a saved pipeline this version cannot read is skipped; resolving it would run the empty reference instead.
  const unreadable = new Set(settings.savedPipelines.filter(entry => !isReadable(entry)).map(storedId));
  return entries.filter(isReadable).filter(pipeline => pipeline.libraryID === undefined || !unreadable.has(pipeline.libraryID)).map(pipeline => resolvePipeline(pipeline, saved));
}
