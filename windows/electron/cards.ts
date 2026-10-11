import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { NEW_CARD_EDITS, runEdit } from '../core/cards/edits';
import type { Plan } from '../core/cards/actions';
import { isLauncher } from '../core/pipeline/app-resolve';
import type { PipelineStep } from '../core/pipeline/model';
import { formatSteps } from '../core/pipeline/parser';
import { markedAsDownloaded } from '../core/pipeline/scripts';
import type { ClopSettings } from '../core/settings/schema';
import type { ImageOptions } from '../src/types';
import type { ItemEngine } from './items';
import { runForApp, type PipelineHost } from './pipelines';

// Carrying out a card action (core/cards/actions.ts `planFor`) on a result: re-optimising an image from its original, running
// pipeline steps or a direct media operation on its current file, and the launches the menu has ("Open with…", "Edit with").

export interface CardHost {
  engine: ItemEngine;
  settings: () => ClopSettings;
  pipeline: PipelineHost;
}

/** An ad-hoc pipeline of `steps`, as the card's menu runs it. */
const adHoc = (steps: PipelineStep[]) => ({ id: 'CARD', steps, rawText: formatSteps(steps), skipOptimisation: true, hideResult: false });

/** Runs an `apply`, `steps` or `edit` plan on result `id`. A step that fails fails the run, so the card shows why. */
export async function runPlan(host: CardHost, id: string, plan: Extract<Plan, { type: 'apply' | 'steps' | 'edit' }>): Promise<void> {
  const { engine } = host, entry = engine.get(id), { kind } = entry.result;
  if (plan.type === 'apply') {
    const options = { ...entry.result.options, ...plan.options } as ImageOptions;
    for (const key of Object.keys(options) as (keyof ImageOptions)[]) if (options[key] === undefined) delete options[key];
    await engine.apply(id, options);
    return;
  }
  await engine.runPipeline(id, async input => {
    const file = input.optimised ?? await input.fresh();
    if (plan.type === 'steps') {
      const outcome = await runForApp(host.pipeline, [adHoc(plan.steps)], file, { kind }, input.signal, input.progress);
      if (!outcome.anyRan && outcome.warnings.length) throw new Error(outcome.warnings[0].replace(/^Pipeline 1: /, ''));
      return { file: outcome.file, anyRan: outcome.anyRan, warnings: outcome.warnings };
    }
    const output = await runEdit(plan.edit, plan.arg, {
      input: file, dir: await input.scratch(), name: path.parse(entry.originalPath).name, original: entry.originalPath, settings: host.settings(), signal: input.signal, onProgress: input.progress,
    });
    return { file: output.path, anyRan: true, warnings: output.warnings ?? [] };
  });
}

/** Whether an edit's result becomes a card of its own. */
export const makesNewCard = (plan: Plan) => plan.type === 'edit' && NEW_CARD_EDITS.includes(plan.edit);

const system32 = (...parts: string[]) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts);
/**
 * Windows' "Open with" chooser for `file`, through `rundll32 shell32.dll,OpenAs_RunDLL` by its absolute System32 path, with no
 * shell and the file as a single argument. It only shows a chooser: the user picks what runs.
 */
export async function openWithDialog(file: string, platform = process.platform, launch: (program: string, args: string[]) => Promise<void> = start) {
  if (platform !== 'win32') throw new Error('The Open with chooser works on Windows only.');
  if (!path.isAbsolute(file) || !(await stat(file).catch(() => undefined))?.isFile()) throw new Error('This file is no longer there.');
  await launch(system32('rundll32.exe'), ['shell32.dll,OpenAs_RunDLL', file]);
}
const start = (program: string, args: string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
  child.once('spawn', () => { child.unref(); resolve(); }).once('error', reject);
});

/**
 * The program "Edit with" starts for `editor` (the `editorAppImage`… setting): never an interpreter or launcher, and never one
 * Windows marked as downloaded from the internet (a stream that cannot be read refuses it, as for scripts).
 */
export async function checkedEditor(editor: string, { platform = process.platform, marked = markedAsDownloaded }: { platform?: NodeJS.Platform; marked?: (file: string) => Promise<boolean> } = {}): Promise<string> {
  const program = editor.trim().replace(/^"(.*)"$/, '$1');
  if (!program) throw new Error('No editor app is set for this kind of file.');
  if (isLauncher(program)) throw new Error(`${path.win32.basename(program)} runs other programs, so Clop does not use it as an editor.`);
  if (platform === 'win32' && /\.exe$/i.test(program) && path.win32.isAbsolute(program) && await marked(program)) throw new Error(`Windows marked ${path.win32.basename(program)} as downloaded from the internet. Unblock it in its file properties first.`);
  return program;
}
