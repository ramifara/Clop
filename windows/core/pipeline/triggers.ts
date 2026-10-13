import path from 'node:path';
import type { ClopSettings } from '../settings/schema';
import { resolveHome } from '../template';
import { isReadable } from './codec';
import { runPipeline, type PipelineRunOptions } from './executor';
import { resolveRunnable, stepEntry, type ClopFileType, type Pipeline } from './model';

// `pipelinesFor` (Clop/Pipeline.swift): the pipelines attached to a source, a watched folder's path or `clipboard`.

export const PIPELINE_SOURCE_KEYS = { image: 'pipelinesToRunOnImage', video: 'pipelinesToRunOnVideo', pdf: 'pipelinesToRunOnPdf', audio: 'pipelinesToRunOnAudio' } as const satisfies Record<ClopFileType, keyof ClopSettings>;

/** A folder key as a comparable path: `~` and `$HOME` expanded, no trailing separator, and on Windows any case and either slash. */
export function sourceKey(source: string, home?: string, platform: NodeJS.Platform = process.platform) {
  if (!/[\\/]|^~/.test(source)) return source;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const resolved = p.normalize(resolveHome(source, home, platform)).replace(/(?<=.)[\\/]+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The pipelines to run on a `type` file from `source`, each reference resolved to the saved pipeline it names. A folder
 * attached as `~/Downloads` matches its full path. Entries this version cannot read, and references to saved pipelines that
 * are gone or that it cannot read, are left out; they stay in settings.
 */
export function pipelinesFor(type: ClopFileType, source: string, settings: Pick<ClopSettings, (typeof PIPELINE_SOURCE_KEYS)[ClopFileType] | 'savedPipelines'>, { home, platform }: { home?: string; platform?: NodeJS.Platform } = {}): Pipeline[] {
  const attached = settings[PIPELINE_SOURCE_KEYS[type]] ?? {}, wanted = sourceKey(source, home, platform);
  const entries = attached[source] ?? Object.entries(attached).find(([key]) => sourceKey(key, home, platform) === wanted)?.[1] ?? [];
  const saved = settings.savedPipelines.filter(isReadable);
  return entries.filter(isReadable).flatMap(pipeline => resolveRunnable(pipeline, saved) ?? []);
}

/**
 * `leadsWithReencode`: the first step that is not a filter already re-encodes the file (convert, crop, downscale), so an
 * optimisation before it would be wasted work and an extra lossy pass.
 */
export function leadsWithReencode(pipeline: Pipeline) {
  const first = pipeline.steps.find(step => !('filterIf' in step) && !('filterIfNot' in step));
  return !!first && ['convert', 'crop', 'downscale'].includes(stepEntry(first)[0]);
}
/** `skipsPreOptimisation`: the pipeline starts from the original rather than from Clop's usual optimisation. */
export const skipsPreOptimisation = (pipeline: Pipeline) => pipeline.skipOptimisation || leadsWithReencode(pipeline);
/** `allSkip`: there are pipelines, and every one of them skips the plain optimisation, so it does not run at all. */
export const pipelinesSkipOptimisation = (pipelines: readonly Pipeline[]) => pipelines.length > 0 && pipelines.every(skipsPreOptimisation);

export interface PipelinesOutcome {
  /** The file the last pipeline that did something ended with; `file` itself when none did. */
  file: string;
  /** Whether any pipeline ran a step other than a filter. */
  anyRan: boolean;
  /** A pipeline that did something asks to keep its result out of the floating results (`hideResult`). */
  hidden: boolean;
  /** Each pipeline's warnings and failures, prefixed with its name. */
  warnings: string[];
  forks: string[];
  pages: string[];
}

/**
 * `runPipelinesAfterOptimisation`: runs each pipeline on `file` in turn, as macOS does, each starting from the same file.
 * A pipeline that fails is reported and the next one still runs; only an abort stops them all.
 */
export async function runPipelines(pipelines: readonly Pipeline[], file: string, opts: PipelineRunOptions): Promise<PipelinesOutcome> {
  const outcome: PipelinesOutcome = { file, anyRan: false, hidden: false, warnings: [], forks: [], pages: [] };
  for (const [index, pipeline] of pipelines.entries()) {
    opts.signal?.throwIfAborted();
    const name = pipeline.name ?? `Pipeline ${index + 1}`;
    try {
      const result = await runPipeline(pipeline, file, index < pipelines.length - 1 ? { ...opts, laterPipelines: true } : opts);
      // Deliberate difference from macOS: the final file moves only for a pipeline that did work, so one that a filter stopped
      // cannot replace the file an earlier pipeline left with the input it reports back, and `anyRan` stays honest.
      if (result.didWork) { outcome.anyRan = true; outcome.file = result.file; outcome.hidden ||= pipeline.hideResult; }
      outcome.warnings.push(...result.warnings.map(warning => `${name}: ${warning}`));
      outcome.forks.push(...result.forks); outcome.pages.push(...result.pages);
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      outcome.warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return outcome;
}
