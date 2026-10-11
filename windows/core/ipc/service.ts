import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as pump } from 'node:stream/promises';
import { copyTo, exists, moveTo, pathKey, samePath } from '../fileops';
import { agentPathRefusal } from '../local-path';
import type { OptimisedMarker } from '../marker';
import { detectKind, probe } from '../media/detect';
import { cropPDF, optimisePDF, PDF_DPI_NO_DOWNSAMPLE } from '../media/pdf';
import type { MediaKind } from '../media/types';
import { isReadable } from '../pipeline/codec';
import { runPipeline, type PipelineEffects, type PipelineRunOptions } from '../pipeline/executor';
import { applyLocation } from '../pipeline/files';
import { makeStep, resolvePipeline, stepPaths, type Pipeline, type PipelineStep } from '../pipeline/model';
import { parseSteps } from '../pipeline/parser';
import { RunState } from '../pipeline/run-state';
import { effectiveBehaviour, placeOutput, type PlacementEnv } from '../placement';
import type { ClopSettings, CropSize } from '../settings/schema';
import type { Workdir } from '../workdir';
import { urlPath, type ClientMessage, type OptimisationRequest, type OptimisationResponse, type ServerMessage, type Size, type StopOptimisationRequest } from './protocol';
import { handleSettingsRequest, mcpRefusal, type SettingsAccess } from './settings';

// What the app does with a request from the pipe (`processOptimisationRequest` in Clop/OptimisationUtils.swift), as a
// headless service: the app runs it behind the pipe, and the CLI runs the same code in its own process when the app is
// not running. Plain requests become pipeline steps, so crop, downscale, speed and compression share one encode with
// the optimisation; a `pipeline` request runs that pipeline. Each input answers with a response or an error.

export interface ServiceDeps {
  store: SettingsAccess;
  workdir: Workdir;
  /**
   * What pipeline steps do outside the files. A function gets whether this run may open programs by path (`allowExe`), which
   * is the user's own pipelines only: an agent's, unless the user allows script steps, may only open apps Windows knows.
   */
  effects: PipelineEffects | ((options: { allowExe: boolean }) => PipelineEffects | Promise<PipelineEffects>);
  marker?: OptimisedMarker;
  home?: string;
  /** Puts files on the clipboard, for `copyToClipboard`. */
  copyFiles?(files: string[]): Promise<void>;
  /**
   * The app's own optimisation with a result card, for a request that shows its result. Returns the optimised file, or
   * undefined when the app cannot do this request itself and the service should.
   */
  withCard?(file: string, kind: MediaKind, request: OptimisationRequest, signal: AbortSignal): Promise<string | undefined>;
}

type Emit = (message: ServerMessage) => void;
/** Files of one request run this many at a time; the per-type queues in core/run.ts bound the encoders themselves. */
const CONCURRENT_FILES = 4;
const DOWNLOAD_LIMIT = 2 * 1024 ** 3;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** `factorStr`: one decimal when that is exact, else two, else three. */
export function factorText(factor: number | undefined) {
  if (factor === undefined) return '';
  return factor.toFixed(Math.abs((factor * 10) % 1) < 0.001 ? 1 : Math.abs((factor * 100) % 1) < 0.001 ? 2 : 3);
}
/** `cropSizeStr`: the even size, or one edge for a long-edge or one-sided crop. */
export function cropSizeText(size: CropSize | undefined) {
  if (!size) return '';
  const even = (n: number) => { const x = Math.round(n); return x + (x % 2); }, w = even(size.width), h = even(size.height);
  return size.longEdge || h === 0 ? String(w) : w === 0 ? String(h) : `${w}x${h}`;
}

/** The pipeline a request names: a saved one by name (any case) or id, else the text as inline steps. */
export function requestPipeline(text: string, settings: Pick<ClopSettings, 'savedPipelines'>, home?: string): Pipeline {
  const saved = settings.savedPipelines.filter(isReadable);
  const found = saved.find(p => p.name?.localeCompare(text, undefined, { sensitivity: 'accent' }) === 0 || p.id === text);
  if (found) return resolvePipeline(found, saved);
  // Inline text runs exactly the steps written, with no optimisation first.
  return { id: 'inline', steps: parseSteps(text, { home }), rawText: text, skipOptimisation: true, hideResult: false };
}

/** A request's crop as step parameters. */
function cropParams(size: CropSize) {
  if (size.isAspectRatio) return { aspectRatio: `${size.width}:${size.height}`, smartCrop: size.smartCrop };
  if (size.longEdge) return { longEdge: Math.max(size.width, size.height), smartCrop: size.smartCrop };
  return { ...(size.width ? { width: size.width } : {}), ...(size.height ? { height: size.height } : {}), smartCrop: size.smartCrop };
}

/** The steps a plain request means for one file, ending in an optimise whose result stays in the work folder for placement. */
export function requestSteps(req: OptimisationRequest, kind: Exclude<MediaKind, 'pdf'>): PipelineStep[] {
  const steps: PipelineStep[] = [], visual = kind === 'image' || kind === 'video';
  if (req.size && visual) steps.push(makeStep('crop', cropParams(req.size)));
  // `clop crop` also sends a downscale factor, which only applies without a size: an audio file in a crop keeps its bitrate.
  else if (!req.size && req.downscaleFactor !== undefined && req.downscaleFactor < 1) steps.push(makeStep('downscale', { factor: req.downscaleFactor }));
  if (req.changePlaybackSpeedFactor !== undefined && req.changePlaybackSpeedFactor !== 1 && kind !== 'image') {
    const frames = req.changePlaybackSpeedFrames === 'keep' ? 'keepFrames' : req.changePlaybackSpeedFrames === 'drop' ? 'dropFrames' : undefined;
    steps.push(makeStep('changeSpeed', { factor: req.changePlaybackSpeedFactor, ...(frames ? { frames } : {}) }));
  }
  if (req.removeAudio && kind === 'video') steps.push(makeStep('removeAudio', {}));
  if (req.audioBitrate !== undefined && kind === 'audio') steps.push(makeStep('lowerBitrate', { kbps: req.audioBitrate }));
  steps.push(makeStep('optimise', { encoder: req.aggressiveOptimisation ? 'aggressive' : 'medium', adaptive: !!req.adaptiveOptimisation, ...(req.compression ? { compression: req.compression } : {}), location: 'temporaryFolder' }));
  return steps;
}

/** The settings one request runs with: its compression replaces the configured one for the file's type. */
function requestSettings(settings: ClopSettings, req: OptimisationRequest, kind: MediaKind): ClopSettings {
  if (!req.compression || kind === 'pdf') return settings;
  return { ...settings, [`${kind}Compression`]: req.compression };
}

interface Facts { bytes: number; size?: Size; bitrate?: number }
async function facts(file: string, kind: MediaKind): Promise<Facts> {
  const bytes = (await stat(file)).size;
  if (kind === 'pdf') return { bytes };
  const info = await probe(file).catch(() => undefined);
  if (!info) return { bytes };
  if (info.kind === 'audio') return { bytes, bitrate: info.bitrate ? Math.round(info.bitrate / 1000) : undefined };
  return 'width' in info && info.width && info.height ? { bytes, size: [info.width, info.height] } : { bytes };
}

async function download(url: string, workdir: Workdir, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${url} answered ${response.status}`);
  if (Number(response.headers.get('content-length')) > DOWNLOAD_LIMIT) throw new Error(`Download failed: ${url} is larger than 2 GB`);
  const dir = path.join(workdir.temp, `download-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const name = decodeURIComponent(path.posix.basename(new URL(url).pathname)).replace(/[\\/:*?"<>|\x00-\x1F]/g, '_') || 'download';
  const file = path.join(dir, name);
  let received = 0;
  const body = Readable.fromWeb(response.body as never).on('data', (chunk: Buffer) => { received += chunk.length; if (received > DOWNLOAD_LIMIT) body.destroy(new Error(`Download failed: ${url} is larger than 2 GB`)); });
  await pump(body, createWriteStream(file), { signal });
  return file;
}

/** The location an `optimise` step needs to place its result where the optimised-file setting (or the request) says. */
function optimisedLocation(env: PlacementEnv, kind: MediaKind, placement: OptimisationRequest['placement']): string {
  const suffix = { image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF' }[kind], s = env.settings as unknown as Record<string, string>;
  switch (effectiveBehaviour(env, kind, 'optimised', placement)) {
    case 'temporary': return 'temporaryFolder';
    case 'sameFolder': return placement?.sameFolderTemplate || s[`sameFolderNameTemplate${suffix}`] || '%f-optimised';
    case 'specificFolder': return placement?.specificFolderTemplate || s[`specificFolderNameTemplate${suffix}`] || '%P/optimised/%f';
    default: return 'inPlace';
  }
}

const SAME_FORMAT = [['jpg', 'jpeg', 'jpe'], ['tif', 'tiff'], ['heic', 'heif'], ['aif', 'aiff'], ['mpg', 'mpeg']];
/**
 * A result in the input's format under another spelling of its extension (the encoders write `.jpeg` for a `.jpg`) takes
 * the input's spelling, so optimising `photo.jpg` gives `photo.jpg`, not a second file.
 */
async function keepExtension(produced: string, input: string): Promise<string> {
  const [from, to] = [path.extname(produced).slice(1), path.extname(input).slice(1)];
  if (from.toLowerCase() === to.toLowerCase() || !SAME_FORMAT.some(names => names.includes(from.toLowerCase()) && names.includes(to.toLowerCase()))) return produced;
  const renamed = path.join(path.dirname(produced), `${path.parse(produced).name}.${to}`);
  // The service's own work files move; anything else (the app's card file) is copied, so it stays where its owner left it.
  return path.basename(path.dirname(path.dirname(produced))).startsWith('pipeline-') ? moveTo(produced, renamed) : copyTo(produced, renamed);
}

/** Removes the work folder of a result that has been placed elsewhere. Only the service's own run folders: the app's card files stay. */
async function discard(produced: string, final: string) {
  const step = path.dirname(produced), runRoot = path.dirname(step);
  if (!path.basename(runRoot).startsWith('pipeline-') || samePath(path.dirname(final), step)) return;
  await rm(step, { recursive: true, force: true });
  await rmdir(runRoot).catch(() => {});
}

/** The key requests on one file take turns by: the same file under different spellings (case on Windows) is one. */
const turnKey = (url: string) => { const file = urlPath(url); return file === undefined ? url : pathKey(file); };

export class ClopService {
  private readonly running = new Map<string, Set<AbortController>>();
  /** The files of each request that no worker has taken yet, so a stop reaches them too. */
  private readonly waiting = new Set<{ queue: [number, string][]; stopped: (index: number, url: string) => void }>();
  /** `takeCLITurn`: requests on one file, from one request or several, run one after the other. */
  private readonly turns = new Map<string, Promise<void>>();
  constructor(private readonly deps: ServiceDeps) {}

  /** The pipe server's handler. */
  readonly handle = async (message: ClientMessage, emit: Emit): Promise<void> => {
    switch (message.kind) {
      case 'settings': emit({ kind: 'settings', response: await handleSettingsRequest(message.request, this.deps.store) }); return;
      case 'stop': this.stop(message.request); return;
      case 'optimise': return this.optimise(message.request, emit);
    }
  };

  /** `handleStopOptimisationRequest`: the ids are the request's URL strings. */
  stop({ ids }: StopOptimisationRequest) {
    for (const { queue, stopped } of this.waiting) for (const entry of queue.filter(([, url]) => ids.includes(url))) { queue.splice(queue.indexOf(entry), 1); stopped(...entry); }
    for (const id of ids) for (const controller of this.running.get(id) ?? []) controller.abort(new Error('Stopped.'));
  }

  async optimise(req: OptimisationRequest, emit: Emit): Promise<void> {
    const { store } = this.deps, settings = store.get();
    const fail = (error: string) => { for (const forURL of req.urls) emit({ kind: 'error', error: { error, forURL } }); emit({ kind: 'done' }); };
    // The MCP gate, before any file is touched. A refusal travels like a per-file error, so a client counting answers gets one per input.
    const refusal = mcpRefusal(req.origin, req.pipeline, settings);
    if (refusal) return fail(refusal);
    if (req.prepareInBatch) return fail('The batch optimiser window is not in this version of Clop for Windows yet. Run the command without --review.');
    let pipeline: Pipeline | undefined;
    try { pipeline = req.pipeline === undefined ? undefined : requestPipeline(req.pipeline, settings, this.deps.home); } catch (error) { return fail(message(error)); }
    // An agent's files, output, templates and pipeline steps stay on this PC's own drives, checked before any of them is looked up.
    const remote = req.origin === 'mcp' ? agentPathRefusal([...req.urls, req.output, req.placement?.sameFolderTemplate, req.placement?.specificFolderTemplate, req.placement?.specificFolderRoot, ...pipeline?.steps.flatMap(stepPaths) ?? []]) : undefined;
    if (remote) return fail(remote);

    const counter = { value: settings.lastAutoIncrementingNumber }, copied: string[] = [];
    const queue = [...req.urls.entries()];
    const waiting = { queue, stopped: (index: number, url: string) => { copied[index] = urlPath(url) ?? ''; emit({ kind: 'error', error: { error: 'Stopped.', forURL: url } }); } };
    this.waiting.add(waiting);
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [index, url] = next;
        try {
          const response = await this.file(url, req, pipeline, counter, fraction => emit({ kind: 'progress', forURL: url, fractionCompleted: fraction }));
          copied[index] = response.path;
          emit({ kind: 'response', response });
        } catch (error) {
          copied[index] = urlPath(url) ?? '';
          emit({ kind: 'error', error: { error: message(error), forURL: url } });
        }
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(CONCURRENT_FILES, queue.length) }, worker)); } finally { this.waiting.delete(waiting); }
    if (counter.value !== settings.lastAutoIncrementingNumber) await store.update(() => ({ patch: { lastAutoIncrementingNumber: counter.value }, result: undefined })).catch(() => {});
    // One file per input: the result, or the original when it failed, as macOS does for --copy.
    if (req.copyToClipboard && this.deps.copyFiles) await this.deps.copyFiles(copied.filter(Boolean)).catch(error => console.warn(`Could not copy the results: ${message(error)}`));
    emit({ kind: 'done' });
  }

  private async file(url: string, req: OptimisationRequest, pipeline: Pipeline | undefined, counter: { value: number }, progress: (fraction: number) => void): Promise<OptimisationResponse> {
    const controller = new AbortController(), { signal } = controller, { deps } = this;
    const controllers = this.running.get(url) ?? new Set();
    this.running.set(url, controllers.add(controller));
    const previous = this.turns.get(turnKey(url));
    let release!: () => void;
    const turn = new Promise<void>(resolve => { release = resolve; });
    this.turns.set(turnKey(url), turn);
    try {
      await previous;
      signal.throwIfAborted();
      const input = urlPath(url) ?? await download(url, deps.workdir, signal);
      if (!await exists(input)) throw new Error(`File not found: ${input}`);
      if (!(await stat(input)).isFile()) throw new Error(`Not a file: ${input}`);
      const kind = await detectKind(input, { signal });
      if (!kind) throw new Error(`Clop cannot optimise ${path.basename(input)}: it is not an image, video, audio file or PDF.`);
      const before = await facts(input, kind), settings = deps.store.get();
      const env: PlacementEnv = { settings: requestSettings(settings, req, kind), workdir: deps.workdir, counter, marker: deps.marker, home: deps.home };
      // Agents only run script steps, and open programs by path, when the user allowed them; anyone else runs their own pipelines.
      const allowScripts = req.origin !== 'mcp' || settings.mcpAllowScriptSteps;
      const settingsStep = pipeline && !pipeline.skipOptimisation ? makeStep('optimise', { encoder: req.aggressiveOptimisation ? 'aggressive' : 'medium', adaptive: false, location: optimisedLocation(env, kind, req.placement) }) : undefined;
      const opts: PipelineRunOptions = {
        fileType: kind, env, effects: typeof deps.effects === 'function' ? await deps.effects({ allowExe: allowScripts }) : deps.effects, placementOverride: req.placement, signal, allowScripts,
        // An explicit output from an agent may not replace a file, as the user's placement settings may.
        refuseExisting: req.origin === 'mcp' ? { settingsStep } : undefined,
        onProgress: p => progress(Math.min(1, (p.step + p.fraction) / Math.max(1, p.steps))),
      };
      const run = new RunState(input, opts);
      let final: string, dpi: { old?: number; new?: number } = {};
      try {
        if (pipeline) {
          const steps = [...(kind === 'audio' && req.audioBitrate !== undefined ? [makeStep('lowerBitrate', { kbps: req.audioBitrate })] : []), ...pipeline.steps];
          // A saved pipeline optimises first unless it says to skip that; the optimise joins the pipeline's first pass.
          if (settingsStep) steps.unshift(settingsStep);
          final = (await runPipeline({ ...pipeline, steps }, input, opts)).file;
        } else {
          let produced = !req.hideFloatingResult && deps.withCard ? await deps.withCard(input, kind, req, signal) : undefined;
          if (!produced && kind === 'pdf') ({ produced, dpi } = await this.pdf(run, input, req, settings, progress));
          produced ??= (await runPipeline({ id: 'request', steps: requestSteps(req, kind as Exclude<MediaKind, 'pdf'>), skipOptimisation: true, hideResult: req.hideFloatingResult }, input, opts)).file;
          final = await this.place(run, produced, input, kind, req, env);
          await discard(produced, final);
        }
        run.current = final;
      } finally { await run.cleanup(); }
      const after = await facts(final, kind);
      const converted = path.extname(final).toLowerCase() !== path.extname(input).toLowerCase();
      const response: OptimisationResponse = { path: final, forURL: url, oldBytes: before.bytes, newBytes: after.bytes };
      if (converted) response.convertedFrom = input;
      if (before.size && after.size) { response.oldWidthHeight = before.size; response.newWidthHeight = after.size; }
      if (before.bitrate !== undefined && after.bitrate !== undefined) { response.oldBitrate = before.bitrate; response.newBitrate = after.bitrate; }
      if (dpi.old !== undefined) response.oldDPI = dpi.old;
      if (dpi.new !== undefined) response.newDPI = dpi.new;
      progress(1);
      return response;
    } finally {
      release();
      if (this.turns.get(turnKey(url)) === turn) this.turns.delete(turnKey(url));
      controllers.delete(controller);
      if (!controllers.size) this.running.delete(url);
    }
  }

  /** A PDF: cropped to the request's aspect ratio when it has a size, then compressed at the request's DPI or the configured one. */
  private async pdf(run: RunState, input: string, req: OptimisationRequest, settings: ClopSettings, progress: (fraction: number) => void) {
    let source = input;
    if (req.size) {
      const { width, height } = req.size;
      const ratio = width && height ? Math.min(width, height) / Math.max(width, height) : 0;
      if (ratio > 0) source = (await cropPDF(input, await run.scratch(), { aspectRatio: ratio })).path;
    }
    const output = await optimisePDF(source, await run.scratch(), { dpiSetting: settings.pdfDPI, dpi: req.pdfDPI, aggressive: req.aggressiveOptimisation, signal: run.signal, onProgress: progress });
    const dpi = { old: output.sourceDPI, new: output.dpi < PDF_DPI_NO_DOWNSAMPLE ? output.dpi : undefined };
    return { produced: output.unchanged ? source : output.path, dpi };
  }

  /**
   * Where a produced file goes: the request's output template (with `%z`, `%s` and `%x` filled in), else the placement
   * settings or the request's override. A temporary result is copied next to the original, as the macOS app does for the CLI.
   */
  private async place(run: RunState, produced: string, input: string, kind: MediaKind, req: OptimisationRequest, env: PlacementEnv): Promise<string> {
    produced = await keepExtension(produced, input);
    if (req.output) {
      const template = req.output.replaceAll('%s', factorText(req.downscaleFactor)).replaceAll('%z', cropSizeText(req.size)).replaceAll('%x', factorText(req.changePlaybackSpeedFactor));
      return applyLocation(run, template, produced, input);
    }
    if (samePath(produced, input)) return input;
    const outputKind = path.extname(produced).toLowerCase() !== path.extname(input).toLowerCase() ? 'autoConvert' : 'optimised';
    if (effectiveBehaviour(env, kind, outputKind, req.placement) === 'temporary') return applyLocation(run, 'sameFolder', produced, input);
    return (await placeOutput(env, { produced, original: input, type: kind, kind: outputKind, overrides: req.placement })).path;
  }
}
