import { copyToClipboard, fork } from './actions';
import { copyStep, deleteStep, moveStep, renameStep } from './files';
import { evaluateFilter } from './filters';
import { blockingProblems, stepEntry, textName, type Pipeline, type PipelineStep } from './model';
import { formatStep, formatSteps } from './parser';
import { isCompilable, isProcessing, runBatch, runSolo, stepLocation } from './processing';
import { RunState, type PipelineRunOptions } from './run-state';
import { runScript, runShortcut } from './scripts';
import { stepTemplate } from './templates';

export type { PipelineEffects, PipelineProgress, PipelineRunOptions } from './run-state';

// `executePipeline` (Clop/Pipeline.swift) without the UI: each step takes the current file and leaves the file the next
// step works on. A filter that does not match stops the pipeline quietly; a step that fails stops it with a
// `PipelineStepError` naming the step. Result cards, the clipboard watcher and the menus are the app's part.

export interface PipelineResult {
  /** The file the pipeline ended with. */
  file: string;
  /** Whether any step other than a filter ran: false when a leading filter stopped it, so the caller can optimise as usual. */
  didWork: boolean;
  /** A filter did not match and ended the pipeline early. */
  stopped: boolean;
  /** Files `fork` handed back as extra results. */
  forks: string[];
  /** Images `extractPagesAsImages` wrote. */
  pages: string[];
  /** Problems that did not stop the run, such as a script printing a path that does not exist. */
  warnings: string[];
}

/**
 * A step failed. `step` is its index in the pipeline and `text` the step as pipeline text. Steps that ran as one pass fail
 * together: `step` is the first, `lastStep` the last, and `text` all of them.
 */
export class PipelineStepError extends Error {
  constructor(readonly step: number, readonly text: string, readonly cause: unknown, readonly lastStep = step) {
    super(`${lastStep > step ? `Steps ${step + 1}–${lastStep + 1}` : `Step ${step + 1}`}, ${text}, failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PipelineStepError';
  }
}

/** Processing and media steps only run on the file types they apply to; the rest are skipped, as macOS skips them. */
const applies = (step: PipelineStep, fileType: string) => !isProcessing(step) || (stepTemplate(textName(stepEntry(step)[0]))?.applicableTypes.includes(fileType as never) ?? true);

async function runStep(run: RunState, step: PipelineStep, following: PipelineStep[], progress: (fraction: number) => void): Promise<'stop' | void> {
  const [kind, p] = stepEntry(step), { effects } = run.opts;
  switch (kind) {
    case 'copy': return copyStep(run, p.to);
    case 'move': return moveStep(run, p.to);
    case 'rename': return renameStep(run, p.to);
    case 'delete': return deleteStep(run, p.path);
    case 'filterIf': case 'filterIfNot': {
      const { matches, captures } = await evaluateFilter(p._0, run.current, run.opts.sourceApp);
      if (matches !== (kind === 'filterIf')) return 'stop';
      if (kind === 'filterIf' && captures.length) run.captures = captures;
      return;
    }
    case 'runScript': return runScript(run, p);
    case 'runShortcut': return runShortcut(run, p._0.name);
    case 'copyToClipboard': return copyToClipboard(run, p);
    case 'copyLinkForSending': throw new Error('Share links need an upload target in Settings.');
    case 'fork': return fork(run, p.location, following);
    case 'openWith': case 'shelveWith': case 'uploadWith': return effects.openWith(run.current, p.app);
    default: return runSolo(run, step, progress);
  }
}

/**
 * Runs `pipeline` on `input`. Pass a resolved pipeline (`resolveRunnable`), not a reference. Rejects with a
 * `PipelineStepError`, or with the abort reason when `signal` fires; files made before that stay where they were placed.
 */
export async function runPipeline(pipeline: Pipeline, input: string, opts: PipelineRunOptions): Promise<PipelineResult> {
  const run = new RunState(input, opts), { steps } = pipeline, { fileType, signal } = opts;
  let didWork = false, stopped = false;
  // A stored step with a value out of range or empty would do damage (a 1-pixel image in place, a file renamed to ".png"),
  // so the whole pipeline is checked before anything runs.
  for (const [index, step] of steps.entries()) {
    const problems = applies(step, fileType) ? blockingProblems(step) : [];
    if (problems.length) throw new PipelineStepError(index, formatStep(step), new Error(problems.map(problem => problem.message).join('; ')));
  }
  try {
    for (let i = 0; i < steps.length;) {
      signal?.throwIfAborted();
      const step = steps[i], index = i;
      if (!applies(step, fileType)) { i++; continue; }
      const progress = (fraction: number) => opts.onProgress?.({ step: index, steps: steps.length, text: formatStep(step), fraction });
      // Consecutive processing steps run as one pass; a step with a location other than inPlace ends the pass.
      const batch = [step], indices = [index], compiled = isCompilable(step, fileType);
      i++;
      while (compiled && i < steps.length && (stepLocation(batch.at(-1)!) ?? 'inPlace') === 'inPlace') {
        if (applies(steps[i], fileType)) { if (!isCompilable(steps[i], fileType)) break; batch.push(steps[i]); indices.push(i); }
        i++;
      }
      progress(0);
      try {
        const outcome = compiled ? await runBatch(run, batch, progress) : await runStep(run, step, steps.slice(index + 1), progress);
        if (outcome === 'stop') { stopped = true; break; }
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw new PipelineStepError(index, formatSteps(batch), error, indices.at(-1));
      }
      progress(1);
      if (!('filterIf' in step) && !('filterIfNot' in step)) didWork = true;
    }
  } finally { await run.cleanup(); }
  return { file: run.current, didWork, stopped, forks: [...run.forks], pages: [...run.pages], warnings: [...run.warnings] };
}
