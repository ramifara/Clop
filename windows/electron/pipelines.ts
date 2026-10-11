import path from 'node:path';
import type { MediaKind } from '../core/media/types';
import { isReadable } from '../core/pipeline/codec';
import type { PipelineEffects } from '../core/pipeline/executor';
import { isBuiltin, type Pipeline } from '../core/pipeline/model';
import { formatSteps } from '../core/pipeline/parser';
import { pipelinesFor, pipelinesSkipOptimisation, runPipelines, type PipelinesOutcome } from '../core/pipeline/triggers';
import type { PlacementEnv } from '../core/placement';
import { expandHome } from '../core/settings/paths';
import type { ClopSettings } from '../core/settings/schema';
import type { AppEntry, PipelineChoice } from '../src/types';
import type { ItemAutomation, ItemPipelineOutcome, ItemPipelineRun } from './items';

// The app's side of pipelines (spec step 21): the pipelines attached to the clipboard and to watched folders run after, or
// instead of, Clop's usual optimisation, as ClopApp.swift and FileOptimisationWatcher.swift run them, and the card can run
// a saved pipeline. `PipelineEffects` is implemented here for the executor: the clipboard, opening apps and the Recycle Bin.

/** What the app gives a pipeline run: settings, work directory and counter, the effects, and how the run went. */
export interface PipelineHost {
  env: () => PlacementEnv;
  effects: (options: { allowExe: boolean }) => PipelineEffects | Promise<PipelineEffects>;
  /** The `%i` counter moved; save it as `lastAutoIncrementingNumber`. */
  counterChanged: (value: number) => void;
  /** Files a run left in the work directory's temp folder that a card still shows, kept from the cleaner. */
  keep: (files: string[]) => void;
}
/** Where a run came from: `clipboard` or a watched folder. Saved and attached pipelines are the user's own, so they may run scripts and programs. */
export interface RunContext { kind: MediaKind; sourceApp?: { id?: string; name?: string } }

/** Runs `pipelines` on `file` with the app's settings and effects, then saves the counter and keeps the files cards show. */
export async function runForApp(host: PipelineHost, pipelines: readonly Pipeline[], file: string, context: RunContext, signal?: AbortSignal): Promise<PipelinesOutcome> {
  const env = host.env(), before = env.counter.value;
  // Pipelines from the user's own settings may run scripts, and so may open any program they name.
  const outcome = await runPipelines(pipelines, file, { fileType: context.kind, env, effects: await host.effects({ allowExe: true }), allowScripts: true, sourceApp: context.sourceApp, signal })
    .finally(() => { if (env.counter.value !== before) host.counterChanged(env.counter.value); });
  host.keep([outcome.file, ...outcome.forks, ...outcome.pages]);
  return outcome;
}

/** The card's notes for an outcome: warnings and failures, and where extracted pages went. */
export function outcomeNotes(outcome: PipelinesOutcome): string[] {
  const pages = outcome.pages.length ? [`Saved ${outcome.pages.length} page${outcome.pages.length === 1 ? '' : 's'} as images in ${path.dirname(outcome.pages[0])}.`] : [];
  return [...outcome.warnings, ...pages];
}

export interface AutomationOptions {
  host: PipelineHost;
  context: RunContext;
  /** Copying is a strong intent to optimise: when every pipeline skips optimisation and none does anything, Clop still optimises. Watching a folder is not. */
  fallback: boolean;
  /** The file the pipelines start from when they skip optimisation: a watched file itself; for the clipboard, a fresh copy in the shelf. */
  source?: string;
  /** Hears the outcome before the card is ready, to hide it (`hideResult`) or add forked results. */
  done?: (outcome: PipelinesOutcome) => void;
  /** Optimise first even when every pipeline would skip it: macOS skips it for copied images only, never for copied videos, PDFs or audio. */
  alwaysOptimise?: boolean;
}
/**
 * The automation for a file from a source with attached `pipelines`, or undefined when there are none: they run after the usual
 * optimisation, or instead of it when every one skips it (`skipsPreOptimisation`).
 */
export function attachedAutomation(pipelines: readonly Pipeline[], { host, context, fallback, source, done, alwaysOptimise = false }: AutomationOptions): ItemAutomation | undefined {
  if (!pipelines.length) return;
  return {
    skipOptimisation: !alwaysOptimise && pipelinesSkipOptimisation(pipelines), fallback,
    run: async (input: ItemPipelineRun): Promise<ItemPipelineOutcome> => {
      const file = input.optimised ?? source ?? await input.fresh();
      const outcome = await runForApp(host, pipelines, file, context, input.signal);
      done?.(outcome);
      return { file: outcome.file, anyRan: outcome.anyRan, warnings: outcomeNotes(outcome), started: file };
    },
  };
}

/** The attached pipelines for a file of `kind` from `source` (`clipboard` or a watched folder as stored). */
export const attachedPipelines = (kind: MediaKind, source: string, settings: ClopSettings, home?: string) => pipelinesFor(kind, source, settings, { home });

/** The saved pipelines the card offers for a result of `kind`: those for every type and those for its type, built-ins last. */
export function pipelineChoices(settings: Pick<ClopSettings, 'savedPipelines'>, kind: MediaKind): PipelineChoice[] {
  return settings.savedPipelines.filter(isReadable).filter(pipeline => !pipeline.fileType || pipeline.fileType === kind)
    .sort((a, b) => Number(isBuiltin(a)) - Number(isBuiltin(b)))
    .map(pipeline => ({ id: pipeline.id, name: pipeline.name ?? (pipeline.rawText || formatSteps(pipeline.steps)), text: pipeline.rawText ?? formatSteps(pipeline.steps) }));
}
/** The saved pipeline the card asked for by id, refused unless the card offers it for this result. */
export function chosenPipeline(settings: Pick<ClopSettings, 'savedPipelines'>, kind: MediaKind, id: unknown): Pipeline {
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Choose a saved pipeline.');
  const pipeline = settings.savedPipelines.filter(isReadable).find(entry => entry.id === id);
  if (!pipeline) throw new Error('That pipeline is no longer saved.');
  if (pipeline.fileType && pipeline.fileType !== kind) throw new Error(`${pipeline.name ?? 'That pipeline'} works on ${pipeline.fileType} files.`);
  return pipeline;
}

/** Folders of the work directory's temp folder that hold `files`, apart from the session's own, to keep from the cleaner. */
export function tempRoots(temp: string, session: string, files: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const file of files) {
    const relative = path.relative(temp, path.resolve(file));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const root = path.join(temp, relative.split(path.sep)[0]);
    if (path.resolve(root) !== path.resolve(session) && root !== path.resolve(file)) roots.add(root);
  }
  return [...roots];
}

// openWith: a pipeline can only open a file with an app Windows knows (a running app, a Start menu app or packaged app, an
// App Paths entry), or, for the user's own pipelines, with a program it names by full path.

export interface AppLookup {
  apps: () => Promise<AppEntry[]>;
  /** The program an App Paths registry entry (`HKCU`/`HKLM\…\App Paths\<name>.exe`) names. */
  appPath: (exeName: string) => Promise<string | undefined>;
  isFile: (file: string) => Promise<boolean>;
  /** Watched folders, where a program is never run from: a file arriving there could be loaded into it. */
  watched: string[];
  allowExe: boolean;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const exeName = (file: string) => path.win32.basename(file).replace(/\.exe$/i, '');
/** The exe path or AUMID that `openWith(app:)` means, or an error saying the app was not found. */
export async function resolveApp(app: string, lookup: AppLookup): Promise<string> {
  const wanted = app.trim().replace(/^"(.*)"$/, '$1');
  if (!wanted) throw new Error('openWith needs the name of an app.');
  // Whatever names a program, it is never run from a watched folder: a file arriving there could be loaded into it. AUMIDs are not paths.
  const checked = (target: string) => {
    const inside = isAumid(target) ? undefined : lookup.watched.find(dir => { const relative = path.win32.relative(dir.toLowerCase(), target.toLowerCase()); return !!relative && !relative.startsWith('..') && !path.win32.isAbsolute(relative); });
    if (inside) throw new Error(`${target} is inside the watched folder ${inside}, so Clop does not run it.`);
    return target;
  };
  const apps = await lookup.apps();
  const known = apps.find(entry => same(entry.path, wanted)) ?? apps.find(entry => same(entry.name, wanted))
    ?? apps.find(entry => !isAumid(entry.path) && same(exeName(entry.path), exeName(wanted)) && !/[\\/]/.test(wanted));
  if (known) return checked(known.path);
  if (/^[\w .+-]+$/.test(exeName(wanted)) && !/[\\/]/.test(wanted)) {
    const registered = await lookup.appPath(`${exeName(wanted)}.exe`);
    if (registered && await lookup.isFile(registered)) return checked(registered);
  }
  if (path.win32.isAbsolute(wanted) && /\.exe$/i.test(wanted)) {
    if (!lookup.allowExe) throw new Error(`This pipeline cannot open programs by path: ${wanted}. Use an app's name from the Start menu.`);
    checked(wanted);
    if (await lookup.isFile(wanted)) return wanted;
  }
  throw new Error(`App '${app}' not found. Use the name of an app in the Start menu, or one you have running.`);
}
/** A packaged app's ID (`Publisher.App_hash!App`), as opposed to a program's path. */
export const isAumid = (target: string) => !path.win32.isAbsolute(target);
/** Watched folders of every kind, expanded. */
export const watchedFolders = (settings: Pick<ClopSettings, 'imageDirs' | 'videoDirs' | 'pdfDirs' | 'audioDirs'>, home?: string) =>
  [...settings.imageDirs, ...settings.videoDirs, ...settings.pdfDirs, ...settings.audioDirs].map(dir => path.resolve(expandHome(dir, home)));

/** The program an `app-path` reply from the Windows helper names, or undefined when there is no entry or it is not a full path. */
export function appPathReply(reply: unknown): string | undefined {
  const value = (reply as Record<string, unknown> | null)?.path;
  return typeof value === 'string' && path.win32.isAbsolute(value) ? value : undefined;
}
