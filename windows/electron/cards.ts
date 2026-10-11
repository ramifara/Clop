import { spawn } from 'node:child_process';
import { realpath as fsRealpath } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { NEW_CARD_EDITS, runEdit } from '../core/cards/edits';
import type { Facts, Plan } from '../core/cards/actions';
import { AUDIO_FORMATS, audioFormatForExtension } from '../core/media/audioFormat';
import { extractAudioCoverArt } from '../core/media/audio';
import { probe } from '../core/media/detect';
import { optimiseImage } from '../core/media/image';
import { renderPDFPages } from '../core/media/pdf';
import type { MediaKind } from '../core/media/types';
import { isLauncher } from '../core/pipeline/app-resolve';
import type { PipelineStep } from '../core/pipeline/model';
import { formatSteps } from '../core/pipeline/parser';
import { markedAsDownloaded } from '../core/pipeline/scripts';
import type { ClopSettings } from '../core/settings/schema';
import type { ImageOptions } from '../src/types';
import { message, type ItemEngine } from './items';
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
  const change = plan.type === 'steps' ? totalChange(plan.steps, entry.result.options) : undefined;
  if (change && !change.steps.length) return;
  // A video can't get its pixels back: going up from a smaller size starts again from the original.
  if (change?.restoreFirst) await engine.restore(id);
  let ran = false;
  await engine.runPipeline(id, async input => {
    const file = input.optimised ?? await input.fresh();
    if (plan.type === 'steps') {
      const outcome = await runForApp(host.pipeline, [adHoc(change?.steps ?? plan.steps)], file, { kind }, input.signal, input.progress);
      if (!outcome.anyRan && outcome.warnings.length) throw new Error(outcome.warnings[0].replace(/^Pipeline 1: /, ''));
      ran = outcome.anyRan;
      return { file: outcome.file, anyRan: outcome.anyRan, warnings: outcome.warnings };
    }
    const output = await runEdit(plan.edit, plan.arg, {
      input: file, dir: await input.scratch(), name: path.parse(entry.originalPath).name, original: entry.originalPath, settings: host.settings(), signal: input.signal, onProgress: input.progress,
    });
    return { file: output.path, anyRan: true, warnings: output.warnings ?? [] };
  });
  if (change?.tracked && ran && engine.get(id).result.status === 'ready') engine.track(id, change.tracked);
}

/**
 * The card names a downscale or a playback speed by its total (50%, 2x), but a step works on the file the card has now. For a video's
 * downscale or a video's or audio file's speed, the steps to run for that total given the `scale` and `speed` the result has had so far,
 * the totals to note once they have run, and whether a video has to start from its original again (a bigger size than it has now; a
 * speed is undone by the opposite change). No steps means the result already is at that total. Other plans are left as they are.
 */
export function totalChange(steps: PipelineStep[], { scale = 1, speed }: Pick<ImageOptions, 'scale' | 'speed'>): { steps: PipelineStep[]; tracked?: { scale?: number; speed?: number }; restoreFirst?: boolean } | undefined {
  const [only] = steps, had = speed ?? 1, near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  if (steps.length !== 1) return undefined;
  if ('downscale' in only) {
    const target = only.downscale.factor;
    if (near(target, scale)) return { steps: [] };
    if (target < scale) return { steps: [{ downscale: { ...only.downscale, factor: target / scale } }], tracked: { scale: target } };
    // From the original the speed it had is added again, in the same encode.
    return { steps: [...(target < 1 ? [{ downscale: only.downscale }] : []), ...(had !== 1 ? [{ changeSpeed: { factor: had } }] : []), ...(target < 1 || had !== 1 ? [] : [{ optimise: {} }])] as PipelineStep[], tracked: { scale: target, speed: had }, restoreFirst: true };
  }
  if ('changeSpeed' in only) {
    const target = only.changeSpeed.factor;
    if (near(target, had)) return { steps: [] };
    return { steps: [{ changeSpeed: { ...only.changeSpeed, factor: target / had } }], tracked: { speed: target } };
  }
  return undefined;
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

/** The canonical path of `file` as Windows names it: links and junctions followed, short names expanded. */
const nativeRealpath = (file: string) => new Promise<string>((resolve, reject) => fsRealpath.native(file, (error, resolved) => error ? reject(error) : resolve(resolved)));

/** Whether an editor setting is the form "Edit with" accepts: the full path of a .exe file. A name is never looked up (no App Paths, no Start menu). */
export const isEditorPath = (value: string) => {
  const program = value.trim().replace(/^"(.*)"$/, '$1');
  // A drive path only: no network share or device path (`\\host\x`, `\\?\`), and no `:` past the drive letter (an NTFS stream such as `a.txt:evil.exe`).
  return path.win32.isAbsolute(program) && /^[a-z]:[\\/]/i.test(program) && !program.slice(2).includes(':') && /\.exe$/i.test(program);
};

/** The name the menu shows for "Edit with": the program's name when the setting is the full path of an existing .exe, else undefined (no entry). */
export async function editorLabel(editor: string, isFile: (file: string) => Promise<boolean>) {
  const program = editor.trim().replace(/^"(.*)"$/, '$1');
  return isEditorPath(program) && await isFile(program) ? path.win32.basename(program).replace(/\.exe$/i, '') : undefined;
}

/**
 * The program "Edit with" starts for the `editorApp…` setting `editor`, or an error that says why not. It fails closed: the setting must be the
 * absolute path of an existing .exe that is not an interpreter or launcher, is not inside a watched folder (a file arriving there could be loaded
 * into it) and was not marked as downloaded from the internet (Zone.Identifier; a stream that cannot be read refuses too). Every check runs on the
 * canonical path (links, junctions and short names resolved), which is also the one returned to start.
 */
export async function editorProgram(editor: string, { platform = process.platform, marked = markedAsDownloaded, isFile = (file: string) => stat(file).then(info => info.isFile(), () => false), watched = [], canonical = platform === 'win32' ? nativeRealpath : async (file: string) => file }: {
  platform?: NodeJS.Platform; marked?: (file: string) => Promise<boolean>; isFile?: (file: string) => Promise<boolean>; watched?: readonly string[];
  /** The canonical form of a path: what it names once links, junctions and short names are resolved. */
  canonical?: (file: string) => Promise<string>;
} = {}): Promise<string> {
  const given = editor.trim().replace(/^"(.*)"$/, '$1');
  if (!given) throw new Error('No editor app is set for this kind of file.');
  if (!isEditorPath(given)) throw new Error('The editor app must be the full path of a .exe file on a local drive. Choose it again in Settings.');
  const name = path.win32.basename(given);
  if (!await isFile(given)) throw new Error(`The editor app ${name} was not found.`);
  const program = await canonical(given).catch(() => undefined);
  if (program === undefined || !isEditorPath(program)) throw new Error(`The editor app ${name} is not a program on a local drive. Choose it again in Settings.`);
  if (isLauncher(program)) throw new Error(`${name} runs other programs, so Clop does not use it as an editor.`);
  const inside = (await Promise.all(watched.map(async dir => await canonical(dir).catch(() => dir)))).find(dir => { const relative = path.win32.relative(dir.toLowerCase(), program.toLowerCase()); return !!relative && !relative.startsWith('..') && !path.win32.isAbsolute(relative); });
  if (inside) throw new Error(`${name} is inside the watched folder ${inside}, so Clop does not run it.`);
  if (platform === 'win32' && await marked(program)) throw new Error(`Windows marked ${name} as downloaded from the internet. Unblock it in its file properties first.`);
  return program;
}
/** The selected results that are finished: saving or copying a selection leaves out one still processing or failed, and says so when none is ready. */
export function readyIds(engine: Pick<ItemEngine, 'has' | 'get'>, ids: readonly string[]) {
  const ready = ids.filter(id => engine.has(id) && engine.get(id).result.status === 'ready');
  if (!ready.length) throw new Error('Wait for the selected results to finish first.');
  return ready;
}
/**
 * Runs an action on each of several results, one after another. A result `skip` says the action does not fit is left out without a word;
 * a failure is reported with the result's name and does not stop the rest. `done` holds the results the action ran on and finished.
 */
export async function eachResult(ids: readonly string[], { skip, run, name }: { skip(id: string): Promise<boolean>; run(id: string): Promise<void>; name(id: string): string }) {
  const done: string[] = [], failures: string[] = [];
  for (const id of ids) {
    try {
      if (await skip(id)) continue;
      await run(id); done.push(id);
    } catch (error) { failures.push(`${name(id)}: ${message(error)}`); }
  }
  return { done, failures };
}

/** Starts `program` with `file` as its only argument, from its own folder, with no shell. */
export const startProgram = (program: string, file: string) => new Promise<void>((resolve, reject) => {
  const child = spawn(program, [file], { cwd: path.dirname(program), detached: true, stdio: 'ignore', shell: false });
  child.once('spawn', () => { child.unref(); resolve(); }).once('error', reject);
});

/** What a menu needs from a video or audio file: whether it has audio or is HDR, its cover art, and the bitrates its format allows. */
export async function mediaFacts(file: string, kind: MediaKind): Promise<Pick<Facts, 'hasAudio' | 'hdr' | 'hasCoverArt' | 'bitrates'>> {
  if (kind !== 'video' && kind !== 'audio') return {};
  const info = await probe(file).catch(() => undefined);
  if (info?.kind === 'video') return { hasAudio: info.hasAudio, hdr: info.hdr };
  if (info?.kind === 'audio') return { hasCoverArt: info.hasCoverArt, bitrates: AUDIO_FORMATS[audioFormatForExtension(path.extname(file).slice(1))].allowedBitrates };
  return {};
}

export interface CardCreation { engine: ItemEngine; settings: () => ClopSettings; defaults: () => ImageOptions; makeRoom: () => Promise<void>; scratchRoot: string }
/** The audio file's cover picture becomes a card of its own. */
export async function coverArtCard({ engine, defaults, makeRoom, scratchRoot }: CardCreation, id: string) {
  const scratch = await mkdtemp(path.join(scratchRoot, 'cover-'));
  try {
    const cover = await extractAudioCoverArt(engine.output(id), scratch);
    await makeRoom();
    return await engine.importPath(cover.path, 'file', defaults());
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
/** A one-page PDF's page becomes a card of its own. */
export async function pageCard({ engine, defaults, makeRoom, scratchRoot }: CardCreation, id: string, format: 'jpeg' | 'png') {
  const scratch = await mkdtemp(path.join(scratchRoot, 'pages-'));
  try {
    const [page] = await renderPDFPages(engine.output(id), scratch, { format, scale: 2, name: path.parse(engine.get(id).result.name).name });
    await makeRoom();
    return await engine.importPath(page.path, 'file', defaults());
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
/** Every page of a PDF, rendered and optimised into `folder`. Returns the files written. */
export async function savePages({ engine, settings, scratchRoot }: CardCreation, id: string, format: 'jpeg' | 'png', folder: string) {
  const scratch = await mkdtemp(path.join(scratchRoot, 'pages-')), s = settings();
  try {
    const rendered = await renderPDFPages(engine.output(id), scratch, { format, scale: 2, name: path.parse(engine.get(id).result.name).name });
    const written: string[] = [];
    for (const page of rendered) written.push((await optimiseImage(page.path, folder, { compression: s.imageCompression, stripMetadata: s.stripMetadata, preserveColorMetadata: s.preserveColorMetadata, name: path.parse(page.path).name })).path);
    return written;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
