import sharp from 'sharp';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, writeFile, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { CropRequest, ImageOptions, ItemResult } from '../src/types';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { optimiseImage } from '../core/media/image';
import { probeImage } from '../core/media/image-codecs';
import { optimiseVideo } from '../core/media/video';
import { cropPDF, extendPDF, optimisePDF, uncropPDF } from '../core/media/pdf';
import { cropGeometry } from '../core/media/crop-size';
import { optimiseAudio } from '../core/media/audio';
import { detectKind, probe, type AudioInfo, type VideoInfo } from '../core/media/detect';
import type { MediaJobOptions, MediaKind, MediaOutput } from '../core/media/types';
import { safeFileName } from '../core/template';
import { imageThumbnail, mediaThumbnail } from './thumbnails';
import type { PipelinesOutcome } from '../core/pipeline/triggers';
import { imageCompression, parseOptions } from './settings';
import { mediaKind } from './clipboard';
import { exists, samePath } from '../core/fileops';

sharp.concurrency(2);
sharp.cache({ memory: 32, files: 0, items: 32 });
const INPUT = new Set(['jpeg', 'png', 'webp', 'avif', 'heic', 'jxl', 'gif', 'tiff', 'bmp', 'svg']);
/** Formats sharp cannot decode, and 16-bit images that may be HDR, are previewed from a decoded PNG. */
const DECODED = new Set(['heic', 'jxl', 'bmp']);
const LIMIT = 128 * 1024 * 1024;
const PIXELS = 60_000_000;
/** Ordinary read failures; anything else on Windows may be a OneDrive placeholder that could not download. */
const LOCAL_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EISDIR']);
/** Where a result goes besides the shelf: a watched file's result goes back in its folder. */
export interface ItemPlacement {
  /** Places a finished result; resolves with where it now is. `staged` is the shelf's copy of the original, to tell whether the file changed meanwhile. `manual` is a format the user chose on the result's card, for the settings of manual conversions. */
  place(output: MediaOutput, staged?: string, manual?: boolean): Promise<string>;
  /**
   * Puts the original back; resolves with where it now is, or undefined when the shelf's own copy is the original. `resume` is a restore
   * that a pipeline run on that file follows straight away: the placement goes on knowing the file as its result.
   */
  restore(resume?: boolean): Promise<string | undefined>;
  /** A pipeline rewrote the placed file, or replaced it with another in its folder (a conversion): restoring undoes that file as it is now. */
  follow?(file: string): void | Promise<void>;
}
/**
 * What the attached pipelines did to a file (`runPipelines` in core/pipeline/triggers.ts). `started` is the file they started
 * from: when it is outside the shelf (a watched or placed file), restoring cannot undo what they did to it.
 */
export type ItemPipelineOutcome = Pick<PipelinesOutcome, 'file' | 'anyRan' | 'warnings'> & {
  started?: string;
  /** Undoes what the pipelines did to `started` when it is outside the shelf, resolving with its path; throws when it cannot (`undoRun` in electron/pipeline-undo.ts). */
  undo?: () => Promise<string>;
};
/** The pipelines attached to where a file came from, which run once, after or instead of its optimisation. */
export interface ItemAutomation {
  /** Every pipeline skips the plain optimisation, so they start from the original. */
  skipOptimisation: boolean;
  /** When the pipelines skipped optimisation but did nothing (a filter stopped them), optimise as usual: copying is a strong intent, watching a folder is not. */
  fallback: boolean;
  /** Runs the pipelines. `optimised` is the optimised result when there is one; otherwise they start from the source (see `ItemPipelineRun`). */
  run(input: ItemPipelineRun): Promise<ItemPipelineOutcome>;
}
/** `original` is the shelf's copy of the source, which a pipeline must never change: `fresh` gives a copy of it to work on. */
export interface ItemPipelineRun {
  optimised?: string; original: string; fresh: () => Promise<string>; signal: AbortSignal;
  /** A new empty folder in the item's own, for a result to be written to. */
  scratch: () => Promise<string>;
  /** Shows how far the run is, from 0 to 1. */
  progress: (fraction: number) => void;
}
/**
 * `cancel` stops this item's running job when it is dismissed; `running` says a job is under way, `shown` that a result was ever ready to paste.
 * `jobs` holds one controller per scheduled job, so stopping also stops jobs still waiting in the queue.
 */
interface Entry {
  result: ItemResult; originalPath: string; outputPath: string; directory: string; inputFormat: string; revision: number; cancel: AbortController; running?: boolean; shown?: boolean;
  placement?: ItemPlacement; placedPath?: string; jobs: Set<AbortController>; automation?: ItemAutomation;
  /** A result is being placed outside the shelf: dismissing it now must keep what is needed to restore it. */
  placing?: boolean;
  /** A pipeline changed a file outside the shelf, which restoring cannot give back. */
  changedOutside?: string;
  /** Undoes what pipelines did to a file outside the shelf, instead of the placement's restore. */
  undoOutside?: () => Promise<string>;
}
/** `placement` puts each result back where the file came from; `staged` hears the result's id as soon as it is in the shelf; `automation` runs attached pipelines. */
export interface ImportExtra {
  placement?: ItemPlacement; staged?: (id: string) => void; automation?: ItemAutomation;
  /** Stops the import while it stages and the optimisation after it, as Stop does. */
  signal?: AbortSignal;
  /** More of the above for what the file turns out to be, once its content has been read: a dropped file's name can lie about its kind. */
  late?: (kind: MediaKind) => Pick<ImportExtra, 'staged' | 'automation' | 'placement'> | undefined;
}
/** A change to a result's current file, writing into `outputDir` under `name`. */
type Edit = (input: string, outputDir: string, name: string, signal: AbortSignal) => Promise<MediaOutput>;
/** Dismissed results kept for `bringBack`. */
const REMOVED = 40;
export type ItemSettings = Pick<ClopSettings, 'imageCompression' | 'stripMetadata' | 'preserveColorMetadata' | 'gifFrameDropBehaviour' | 'videoCompression' | 'videoEncoder' | 'capVideoFPS' | 'targetVideoFPS'
  | 'minVideoFPS' | 'removeAudioFromVideos' | 'convertAudioToAAC' | 'adaptiveVideoSize' | 'pdfDPI' | 'audioCompression' | 'formatsToConvertToAAC' | 'formatsToConvertToMP3' | 'formatsToConvertToJPEG' | 'formatsToConvertToPNG' | 'formatsToConvertToMP4' | 'formatsToConvertToOutputAudio' | 'audioFormat' | 'convertHDRToSDR' | 'audioCoverArt' | 'preserveDates'>;
/**
 * The session's results: images, videos, PDFs and audio files. Each keeps a copy of its original, so results always start
 * from it and restoring gives back its exact bytes. Sources are never written to.
 */
export class ItemEngine extends EventEmitter {
  private entries = new Map<string, Entry>();
  private queues = new Map<MediaKind, Promise<unknown>>();
  private controller = new AbortController();
  private removed: Entry[] = [];
  /** Imports still copying and probing their file, before they have a result to stop. */
  private staging = new Set<AbortController>();
  /** `settings` is read for every job, so a changed compression setting applies to the next one. */
  /**
   * `mark` records a finished result as optimised (the app's `OptimisedMarker`: on Windows a stream on the file, which Explorer copies
   * and drags carry), so a result pasted or dragged into a watched folder is not optimised a second time.
   */
  constructor(private root: string, private settings: () => ItemSettings = defaultSettings, private readonly mark: (file: string) => Promise<void> = async () => {}) { super(); }
  list() { return [...this.entries.values()].map(e => structuredClone(e.result)).reverse(); }
  get(id: string) { const entry = this.entries.get(id); if (!entry) throw new Error('This result is no longer in the shelf.'); return entry; }
  has(id: string) { return this.entries.has(id); }
  /** The result's file: where its placement put it, or the shelf's copy. */
  output(id: string) { const entry = this.get(id); if (entry.result.status !== 'ready') throw new Error('Wait for this result to finish first.'); return entry.placedPath ?? entry.outputPath; }
  private changed() { this.emit('change'); }
  /** Jobs of one kind run in order; a long video never holds up a copied image. */
  private schedule<T>(kind: MediaKind, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(kind) ?? Promise.resolve()).then(task, task);
    this.queues.set(kind, run.catch(() => {}));
    return run;
  }
  private kindOf(id: string): MediaKind { return this.entries.get(id)?.result.kind ?? 'image'; }
  private job(e: Entry) { const job = new AbortController(); e.jobs.add(job); return job; }
  /**
   * Imports a local file under `name` (its own by default). `placement` puts each result back where the file came from;
   * `staged` hears the result's id as soon as it is in the shelf, before it is optimised.
   */
  async importPath(file: string, source: ItemResult['source'], options: ImageOptions, name = path.basename(file), extra: ImportExtra = {}) {
    const info = await stat(file).catch(error => { throw unreadable(file, error); });
    if (!info.isFile()) throw new Error(`${path.basename(file)} is not a file.`);
    if (info.size > LIMIT && await detectKind(file).catch(() => undefined) === 'image') throw new Error('Choose an image file smaller than 128 MB.');
    // Copying reads the file, which makes OneDrive download a files-on-demand placeholder. One that cannot download fails here.
    // The copy keeps the source's dates, which results take with `preserveDates`.
    return this.add(name, source, options, staged => copyFile(file, staged).then(() => utimes(staged, info.atime, info.mtime)).catch(error => { throw unreadable(file, error); }), extra);
  }
  async importBuffer(buffer: Buffer, name: string, source: ItemResult['source'], options: ImageOptions, extra: ImportExtra = {}): Promise<string> {
    if (!buffer.length || buffer.length > LIMIT) throw new Error('Choose a file smaller than 128 MB.');
    return this.add(name, source, options, staged => writeFile(staged, buffer), extra);
  }
  private async add(name: string, source: ItemResult['source'], options: ImageOptions, write: (staged: string) => Promise<unknown>, extra: ImportExtra = {}) {
    options = parseOptions(options);
    const importing = new AbortController(), signal = AbortSignal.any([this.controller.signal, importing.signal, ...extra.signal ? [extra.signal] : []]);
    signal.throwIfAborted();
    this.staging.add(importing);
    // A long name loses the end of its stem, never its extension, which says what the file is.
    const base = path.basename(name), { name: stemPart, ext: extPart } = path.parse(base);
    const id = randomUUID(), directory = path.join(this.root, id), display = (base.length > 160 ? stemPart.slice(0, 160 - extPart.slice(0, 12).length) + extPart.slice(0, 12) : base) || 'Clipboard';
    let entry: Entry;
    try {
      await mkdir(path.join(directory, 'original'), { recursive: true });
      // A short name keeps the session's paths well under Windows' 260 characters, which some bundled tools need.
      const { name: stem, ext } = path.parse(safeFileName(display)), staged = path.join(directory, 'original', `${stem.slice(0, 64) || 'file'}${ext.slice(0, 12)}`);
      await write(staged);
      signal.throwIfAborted();
      const kind = await detectKind(staged, { signal });
      if (!kind) throw new Error('Use an image, a video, a PDF or an audio file.');
      const result = { id, kind, name: display, source, status: 'processing', options, animated: false, createdAt: Date.now() } as const;
      entry = kind === 'image' ? await this.stageImage(staged, directory, result, signal) : await this.stageMedia(staged, directory, { ...result, kind }, signal);
      signal.throwIfAborted();
      const late = extra.late?.(kind);
      entry.placement = extra.placement ?? late?.placement; entry.automation = extra.automation ?? late?.automation;
      this.entries.set(id, entry);
      this.emit('add', id); extra.staged?.(id); late?.staged?.(id);
      this.changed();
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    finally { this.staging.delete(importing); }
    const job = this.job(entry);
    if (extra.signal?.aborted) job.abort(); else extra.signal?.addEventListener('abort', () => job.abort(), { once: true });
    await this.schedule(entry.result.kind, () => this.process(id, options, job));
    return id;
  }
  private async stageImage(staged: string, directory: string, base: Pick<ItemResult, 'id' | 'kind' | 'name' | 'source' | 'status' | 'options' | 'animated' | 'createdAt'>, signal = this.controller.signal): Promise<Entry> {
    const info = await probeImage(staged, signal).catch(error => { if (signal.aborted) throw error; return undefined; });
    if (!info || !INPUT.has(info.format) || !info.width || !info.height) throw new Error('Use PNG, JPEG, WebP, GIF, AVIF, HEIC, JPEG XL, TIFF, BMP or SVG.');
    const { format, width, height, pages } = info;
    if (format === 'tiff' && pages > 1) throw new Error('Use a single-page TIFF image. Multi-page documents are not supported.');
    if (pages > 250 || info.pixels > PIXELS) throw new Error('This image has too many pixels or animation frames. Use an image under 60 megapixels in total.');
    const originalPath = path.join(path.dirname(staged), `${path.parse(staged).name || 'image'}.${format}`);
    await rename(staged, originalPath);
    const preview = await imageThumbnail(originalPath, DECODED.has(format) || info.deep), bytes = (await stat(originalPath)).size;
    const result: ItemResult = { ...base, originalBytes: bytes, outputBytes: bytes, originalWidth: width, originalHeight: height, width, height, format, originalPreview: preview, preview, animated: pages > 1 };
    return { result, originalPath, outputPath: originalPath, directory, inputFormat: format, revision: 0, cancel: new AbortController(), jobs: new Set() };
  }
  private async stageMedia(staged: string, directory: string, base: Pick<ItemResult, 'id' | 'name' | 'source' | 'status' | 'options' | 'animated' | 'createdAt'> & { kind: Exclude<MediaKind, 'image'> }, signal = this.controller.signal): Promise<Entry> {
    const info = base.kind === 'pdf' ? undefined : await probe(staged, { signal }) as VideoInfo | AudioInfo;
    // A download may have no extension, or the wrong one; the tools and the pasted file need one that matches the content.
    if (mediaKind(staged) !== base.kind) {
      const named = path.join(path.dirname(staged), `${path.parse(staged).name || 'file'}.${mediaExtension(info)}`);
      await rename(staged, named); staged = named;
    }
    const video = info?.kind === 'video' ? info : undefined, format = path.extname(staged).slice(1).toLowerCase();
    const preview = await mediaThumbnail(base.kind, staged, { durationMs: info?.durationMs, signal }), bytes = (await stat(staged)).size;
    const result: ItemResult = {
      ...base, originalBytes: bytes, outputBytes: bytes, originalWidth: video?.width ?? 0, originalHeight: video?.height ?? 0, width: video?.width ?? 0, height: video?.height ?? 0,
      format, originalPreview: preview, preview, durationMs: info?.durationMs, ...(info?.kind === 'audio' ? { coverArt: info.hasCoverArt } : {}),
    };
    return { result, originalPath: staged, outputPath: staged, directory, inputFormat: format, revision: 0, cancel: new AbortController(), jobs: new Set() };
  }
  /**
   * Crops a result from the crop window. Images and videos are cut from their original to the crop size, which then stays with
   * the result's other options; PDF page boxes change on the current result, so its optimisation is kept.
   */
  crop(id: string, request: CropRequest) {
    const e = this.get(id), kind = e.result.kind;
    if (kind === 'audio') throw new Error('Audio files have nothing to crop.');
    const job = this.job(e);
    if (request.type === 'size') {
      if (kind === 'pdf') throw new Error('Choose a paper size, a device or an aspect ratio for the pages.');
      const options = parseOptions({ ...e.result.options, crop: request.size, scale: 1, maxEdge: undefined });
      return this.schedule(kind, () => this.process(id, options, job));
    }
    if (kind !== 'pdf') throw new Error('Choose a crop size for this file.');
    const edit: Edit = (input, outputDir, name) => request.type === 'pdf-uncrop' ? uncropPDF(input, outputDir, { name })
      : request.type === 'pdf-rect' ? cropPDF(input, outputDir, { name, rect: request.rect })
      : (request.extend ? extendPDF : cropPDF)(input, outputDir, { name, aspectRatio: request.aspectRatio, alwaysPortrait: request.orientation === 'portrait', alwaysLandscape: request.orientation === 'landscape', ...(request.rect ? { rect: request.rect } : {}) });
    return this.schedule('pdf', () => this.process(id, e.result.options, job, edit));
  }
  apply(id: string, options: ImageOptions) {
    options = parseOptions(options);
    const e = this.get(id);
    if (e.result.kind !== 'image') throw new Error('Only images can be resized or converted from the card.');
    const job = this.job(e);
    return this.schedule('image', () => this.process(id, options, job));
  }
  /** `edit` replaces the optimisation with a change to the current result. */
  private async process(id: string, options: ImageOptions, job: AbortController, edit?: Edit) {
    // An item dismissed while its job waited has nothing left to do.
    const e = this.entries.get(id);
    if (!e) return;
    const r = e.result, signal = AbortSignal.any([this.controller.signal, e.cancel.signal, job.signal]);
    r.status = 'processing'; r.error = undefined; r.progress = undefined; r.notes = undefined; e.running = true; this.changed();
    try {
      signal.throwIfAborted();
      // Each result gets a folder of its own and keeps the original's name, so a pasted or dragged file is named like its source.
      const outputDir = path.join(e.directory, String(e.revision + 1)), name = path.parse(e.originalPath).name;
      // Attached pipelines run once, on the first job; later card actions only optimise.
      const automation = e.automation;
      e.automation = undefined;
      if (automation?.skipOptimisation) {
        const outcome = await automation.run(this.pipelineRun(e, undefined, signal));
        if (outcome.anyRan || !automation.fallback) return await this.finishPipelines(id, e, outcome, signal, options, { fresh: true });
        r.notes = outcome.warnings.length ? outcome.warnings : undefined;
      }
      let output: MediaOutput, width = r.originalWidth, height = r.originalHeight;
      // An edit starts from the current result, which a pipeline may have replaced with a file of its own.
      if (edit) output = await edit(e.placedPath ?? e.outputPath, outputDir, name, signal);
      else if (r.kind === 'image') {
        // A crop comes first, and the scale and longest edge then apply to what it keeps.
        const geometry = options.crop && cropGeometry(options.crop, r.originalWidth, r.originalHeight);
        const kept = geometry ?? { width: r.originalWidth, height: r.originalHeight };
        const factor = Math.min(options.scale, options.maxEdge ? options.maxEdge / Math.max(kept.width, kept.height) : 1);
        width = Math.max(1, Math.round(kept.width * factor)); height = Math.max(1, Math.round(kept.height * factor));
        // A region is cut out and scaled to the size; any other crop size fills the size exactly.
        const cropSize = options.crop && (geometry?.crop ? { ...options.crop, width, height } : { width, height, name: options.crop.name, longEdge: false, smartCrop: options.crop.smartCrop });
        const settings = this.settings();
        output = await optimiseImage(e.originalPath, outputDir, {
          ...(options.compression ? { compression: options.compression } : imageCompression(options.mode, settings.imageCompression)), format: options.format === 'auto' ? undefined : options.format, ...(cropSize ? { cropSize } : { width, height }),
          stripMetadata: settings.stripMetadata, preserveColorMetadata: settings.preserveColorMetadata, gifFrameDropBehaviour: settings.gifFrameDropBehaviour,
          formatsToConvertToJPEG: settings.formatsToConvertToJPEG, formatsToConvertToPNG: settings.formatsToConvertToPNG, convertHDRToSDR: settings.convertHDRToSDR, name, signal,
        });
      } else output = await this.optimiseMedia(r.kind, e.originalPath, outputDir, { aggressive: options.mode === 'aggressive', name, signal, onProgress: this.progress(r), crop: options.crop });
      signal.throwIfAborted();
      // PDF.swift gives an optimised PDF its source's dates; the audio optimiser does it itself, and macOS leaves video dates alone.
      // Before placing, so a placed copy keeps them too.
      if (r.kind === 'pdf' && !output.unchanged && this.settings().preserveDates) { const { atime, mtime } = await stat(e.originalPath); await utimes(output.path, atime, mtime); }
      // A file a pipeline left earlier is no longer the result once the card re-optimises.
      e.placedPath = undefined;
      if (e.placement) {
        // Once placing starts it finishes, even if the item is dismissed meanwhile, and the item stays restorable.
        e.placing = true;
        try { e.placedPath = await e.placement.place(output, e.originalPath, options.format !== 'auto'); e.shown = true; } finally { e.placing = false; }
      }
      if (!output.unchanged) { e.revision++; await this.mark(output.path).catch(() => {}); }
      // Keep earlier results until the session ends: other apps may still be pasting or dragging them.
      e.outputPath = output.path;
      for (const warning of output.warnings ?? []) console.warn(warning);
      // Video, PDF and audio previews show the content, which optimising leaves as it was; cropping changes it.
      const preview = output.unchanged ? r.originalPreview : r.kind === 'image' ? await imageThumbnail(output.path, DECODED.has(output.format))
        : (r.kind === 'video' && options.crop) || (r.kind === 'pdf' && edit) ? await mediaThumbnail(r.kind, output.path, { durationMs: output.durationMs ?? r.durationMs, signal }) : r.originalPreview;
      // With pipelines still to run, the result is not ready yet: copying or dragging it now would hand out the file before them.
      const following = automation && !automation.skipOptimisation;
      // Optimising can drop the cover art (the `audioCoverArt` setting).
      if (r.kind === 'audio') r.coverArt = await probe(output.path, { signal }).then(info => info.kind === 'audio' ? info.hasCoverArt : undefined, () => r.coverArt);
      Object.assign(r, { status: following ? 'processing' : 'ready', options, revision: e.revision, format: output.format, width: output.width ?? width, height: output.height ?? height, outputBytes: output.bytes, preview,
        durationMs: output.durationMs ?? r.durationMs, pages: output.pages ?? r.pages, progress: undefined, unchanged: !!output.unchanged, restored: false });
      if (following) {
        const outcome = await automation.run(this.pipelineRun(e, e.placedPath ?? (output.unchanged ? undefined : output.path), signal));
        return await this.finishPipelines(id, e, outcome, signal, options);
      }
      e.shown = true; this.changed();
      if (this.entries.get(id) === e) this.emit('ready', id);
    } catch (error) { Object.assign(r, { status: 'error', error: signal.aborted ? 'Stopped.' : message(error), progress: undefined }); this.changed(); }
    finally {
      e.running = false; e.jobs.delete(job);
      if (this.entries.get(id) !== e && !e.shown) {
        // A placement that failed left nothing to restore.
        const kept = this.removed.indexOf(e);
        if (kept >= 0) this.removed.splice(kept, 1);
        await discard(e);
      }
    }
  }
  /** What a pipeline run gets: the optimised result to work on, or a fresh copy of the source in a folder of its own. */
  private pipelineRun(e: Entry, optimised: string | undefined, signal: AbortSignal): ItemPipelineRun {
    return {
      optimised, original: e.originalPath, signal, progress: this.progress(e.result),
      scratch: async () => {
        const dir = path.join(e.directory, `edit-${randomUUID().slice(0, 8)}`);
        await mkdir(dir, { recursive: true });
        return dir;
      },
      fresh: async () => {
        const dir = path.join(e.directory, `pipeline-${randomUUID().slice(0, 8)}`);
        await mkdir(dir, { recursive: true });
        const copy = path.join(dir, path.basename(e.originalPath));
        await copyFile(e.originalPath, copy);
        return copy;
      },
    };
  }
  /**
   * Shows what the pipelines left: the card follows their final file (its size, format and preview), and lists their warnings
   * and failures. Pipelines that did nothing leave the card as it was, or, when they ran on a `fresh` item that nothing optimised,
   * show the original unchanged. A final file of another kind (a video made a GIF, a PDF page made an image) becomes the item's
   * new original, so the card's actions work on it.
   */
  private async finishPipelines(id: string, e: Entry, outcome: ItemPipelineOutcome, signal: AbortSignal, options: ImageOptions, { fresh = false } = {}) {
    const r = e.result;
    signal.throwIfAborted();
    // Pipelines that replaced optimisation work on the user's file where it is, with no placement to undo them: its original is in the backups.
    // So do pipelines that ran after an optimisation that left the file as it was: nothing was backed up for them either.
    // With an undo for that run, restoring puts things back as far as it safely can; without one, it refuses.
    if ((fresh || r.unchanged) && outcome.anyRan && outcome.started && !within(e.directory, outcome.started) && !e.changedOutside && !e.undoOutside) {
      if (outcome.undo) e.undoOutside = outcome.undo; else e.changedOutside = outcome.started;
    }
    const info = outcome.anyRan ? await stat(outcome.file).catch(() => undefined) : undefined;
    if (info?.isFile()) {
      const kind = await detectKind(outcome.file, { signal }).catch(() => undefined) ?? r.kind;
      // A conversion in place leaves the file under another name, and other steps rewrite it where it is; the placement follows either, so
      // restoring still finds the result and knows it as Clop's.
      if (e.placedPath && e.placement?.follow && samePath(path.dirname(e.placedPath), path.dirname(outcome.file)) && (samePath(e.placedPath, outcome.file) || !await exists(e.placedPath))) await e.placement.follow(outcome.file);
      e.placedPath = outcome.file;
      e.revision++;
      r.revision = e.revision;
      if (kind !== r.kind) await this.rebase(e, outcome.file, kind, signal);
      Object.assign(r, { format: path.extname(outcome.file).slice(1).toLowerCase() || r.format, outputBytes: info.size, unchanged: false, restored: false });
      if (kind === 'image') {
        // The preview is made from a copy in the item's folder, so nothing is ever written beside a file in the user's folders.
        const copy = path.join(e.directory, `preview-${e.revision}${path.extname(outcome.file)}`);
        await copyFile(outcome.file, copy);
        const probed = await probeImage(copy, signal).catch(() => undefined);
        if (probed) Object.assign(r, { width: probed.width, height: probed.height, format: probed.format, preview: await imageThumbnail(copy, DECODED.has(probed.format) || probed.deep).catch(() => r.preview) });
        await rm(copy, { force: true });
      } else if (kind === 'video' || kind === 'audio') {
        // ffprobe only reads, so the file is probed where it is; the preview stays the source's, as for optimised media.
        const media = await probe(outcome.file, { signal }).catch(() => undefined) as VideoInfo | AudioInfo | undefined;
        if (media?.kind === 'video') Object.assign(r, { width: media.width, height: media.height });
        if (media?.durationMs) r.durationMs = media.durationMs;
        if (media?.kind === 'audio') r.coverArt = media.hasCoverArt;
      }
    } else if (outcome.anyRan) {
      // The pipelines ended on a file that is gone (a final `delete`): there is no result to copy, drag or reveal.
      Object.assign(r, { status: 'error', error: 'A pipeline deleted this file, so there is no result to show.', progress: undefined, notes: outcome.warnings.length ? outcome.warnings : undefined });
      e.shown = true; this.changed();
      return;
    } else if (fresh) {
      // Nothing ran and nothing was optimised: the card shows the original as it is.
      Object.assign(r, { format: e.inputFormat, outputBytes: r.originalBytes, unchanged: true });
    }
    Object.assign(r, { status: 'ready', options, progress: undefined, notes: outcome.warnings.length ? outcome.warnings : undefined });
    e.shown = true; this.changed();
    if (this.entries.get(id) === e) this.emit('ready', id);
  }
  /** Makes a pipeline's file of another kind the item's original: a copy in the shelf, with its own size and preview. Restoring then gives back that file. */
  private async rebase(e: Entry, file: string, kind: MediaKind, signal: AbortSignal) {
    const dir = path.join(e.directory, `original-${e.revision}`);
    await mkdir(dir, { recursive: true });
    const original = path.join(dir, path.basename(file)), r = e.result;
    await copyFile(file, original);
    const staged = kind === 'image' ? await this.stageImage(original, dir, r) : await this.stageMedia(original, dir, { ...r, kind });
    Object.assign(r, { ...staged.result, kind, status: 'processing' });
    Object.assign(e, { originalPath: staged.originalPath, outputPath: staged.originalPath, inputFormat: staged.inputFormat, placement: undefined });
  }
  /** "Run pipeline…" from the card: runs on the current result, or on a fresh copy of the original when there is none. */
  runPipeline(id: string, run: (input: ItemPipelineRun) => Promise<ItemPipelineOutcome>) {
    const e = this.get(id);
    if (e.result.status !== 'ready') throw new Error('Wait for this result to finish first.');
    const job = this.job(e);
    return this.schedule(e.result.kind, async () => {
      if (this.entries.get(id) !== e) return;
      const signal = AbortSignal.any([this.controller.signal, e.cancel.signal, job.signal]), r = e.result;
      r.status = 'processing'; r.error = undefined; e.running = true; this.changed();
      try {
        const current = e.placedPath ?? e.outputPath;
        const outcome = await run(this.pipelineRun(e, current === e.originalPath ? undefined : current, signal));
        await this.finishPipelines(id, e, outcome, signal, r.options);
      } catch (error) { Object.assign(r, { status: 'error', error: signal.aborted ? 'Stopped.' : message(error), progress: undefined }); this.changed(); }
      finally { e.running = false; e.jobs.delete(job); }
    });
  }
  private optimiseMedia(kind: Exclude<MediaKind, 'image'>, file: string, outputDir: string, { crop, ...job }: MediaJobOptions & { name: string; crop?: ImageOptions['crop'] }): Promise<MediaOutput> {
    const s = this.settings();
    if (kind === 'video') return optimiseVideo(file, outputDir, { ...job, crop, compression: s.videoCompression, encoder: s.videoEncoder, capVideoFPS: s.capVideoFPS, targetVideoFPS: s.targetVideoFPS,
      minVideoFPS: s.minVideoFPS, removeAudio: s.removeAudioFromVideos, convertAudioToAAC: s.convertAudioToAAC, adaptiveVideoSize: s.adaptiveVideoSize, stripMetadata: s.stripMetadata, formatsToConvertToMP4: s.formatsToConvertToMP4 });
    if (kind === 'pdf') return optimisePDF(file, outputDir, { ...job, dpiSetting: s.pdfDPI });
    return optimiseAudio(file, outputDir, { ...job, compression: s.audioCompression, formatsToConvertToAAC: s.formatsToConvertToAAC, formatsToConvertToMP3: s.formatsToConvertToMP3,
      formatsToConvertToOutputAudio: s.formatsToConvertToOutputAudio, audioFormat: s.audioFormat, coverArt: s.audioCoverArt, preserveDates: s.preserveDates });
  }
  /** Reports progress in 2 % steps, so a long encode does not flood the windows with updates. */
  private progress(r: ItemResult) {
    return (fraction: number) => { const value = Math.floor(fraction * 50) / 50; if (value > (r.progress ?? 0)) { r.progress = value; this.changed(); } };
  }
  restore(id: string, resume = false) { return this.schedule(this.kindOf(id), async () => {
    const e = this.get(id);
    if (e.changedOutside) throw new Error(`A pipeline changed ${path.basename(e.changedOutside)}, so Clop leaves it as it is. Its original is in the backups.`);
    // A pipeline's file outside the shelf is no longer the result once the original is back.
    if (e.undoOutside) { e.placedPath = await e.undoOutside(); e.undoOutside = undefined; }
    else e.placedPath = e.placement ? await e.placement.restore(resume) : undefined;
    e.outputPath = e.originalPath;
    if (e.result.kind === 'audio') e.result.coverArt = await probe(e.originalPath).then(info => info.kind === 'audio' ? info.hasCoverArt : undefined, () => e.result.coverArt);
    Object.assign(e.result, { status: 'ready', width: e.result.originalWidth, height: e.result.originalHeight, outputBytes: e.result.originalBytes,
      format: e.inputFormat, preview: e.result.originalPreview, options: { ...e.result.options, scale: 1, speed: undefined, maxEdge: undefined, format: 'auto', crop: undefined, compression: undefined }, restored: true, unchanged: true, error: undefined, notes: undefined });
    e.shown = true; this.changed(); this.emit('restored', id); this.emit('ready', id);
  }); }
  /**
   * Removes an item at once, without waiting behind other jobs of its kind, and stops its job if one is running.
   * Dismissing an item that is already gone does nothing, so overlapping dismissals are safe.
   */
  async dismiss(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.cancel.abort();
    this.changed();
    // A result that was ready can be brought back; nothing can be pasting one that never was, so its folder goes, or a running job removes it once it stops.
    if (entry.shown || entry.placing) { this.removed.push(entry); this.removed.splice(0, this.removed.length - REMOVED); }
    else if (!entry.running) await discard(entry);
  }
  /** Puts a dismissed result (the latest by default) back in the shelf as its newest. Returns its id, or undefined when there is none. */
  bringBack(id?: string) {
    const index = id === undefined ? this.removed.length - 1 : this.removed.findIndex(e => e.result.id === id);
    if (index < 0) return;
    const [e] = this.removed.splice(index, 1);
    // Dismissing cancelled the entry for good; a brought-back result can run jobs again.
    e.cancel = new AbortController();
    this.entries.set(e.result.id, e); this.changed();
    return e.result.id;
  }
  /** Notes the downscale and playback speed a result has had, which the next card action goes on from. */
  track(id: string, tracked: Pick<Partial<ImageOptions>, 'scale' | 'speed'>) { const e = this.get(id); e.result.options = { ...e.result.options, ...tracked }; this.changed(); }
  /** Whether any result is still being optimised; cheaper than listing them (which copies each). */
  processing() { for (const e of this.entries.values()) if (e.result.status === 'processing') return true; return false; }
  /** Stops the running and queued jobs of `ids` (every result by default, and the imports still being read). Each ends with a "Stopped." error; sources stay as they are. */
  stop(ids?: readonly string[]) {
    if (!ids) for (const importing of this.staging) importing.abort();
    for (const [id, e] of this.entries) if (!ids || ids.includes(id)) for (const job of e.jobs) job.abort();
  }
  async idle() { await Promise.all(this.queues.values()); }
  /** Stops every running and queued job, for quitting. Later imports are refused. */
  abort() { this.controller.abort(); }
}
/** The usual extension for a video or audio container ffprobe names (`mov,mp4,m4a,…`, `matroska,webm`, `ogg`…); PDF without `info`. */
export function mediaExtension(info: VideoInfo | AudioInfo | undefined) {
  if (!info) return 'pdf';
  const names = info.format.split(','), has = (name: string) => names.includes(name);
  if (info.kind === 'video') return has('mp4') ? 'mp4' : has('webm') && /^(vp8|vp9|av1)$/.test(info.codec ?? '') ? 'webm' : has('matroska') ? 'mkv' : has('avi') ? 'avi' : has('mpeg') ? 'mpg' : 'mp4';
  return has('mp4') ? 'm4a' : has('mp3') ? 'mp3' : has('ogg') ? (info.codec === 'opus' ? 'opus' : 'ogg') : has('flac') ? 'flac' : has('wav') ? 'wav' : has('aiff') ? 'aiff' : has('aac') ? 'aac' : 'm4a';
}
/** Whether `file` is inside `dir`. */
function within(dir: string, file: string) {
  const relative = path.relative(dir, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
/** Removes an item's folder. One still locked (by Defender, say) is left to the working directory's cleaner. */
const discard = (entry: Entry) => rm(entry.directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
function unreadable(file: string, error: unknown) {
  const name = path.basename(file), code = (error as NodeJS.ErrnoException).code ?? '';
  if (code === 'ENOENT') return new Error(`${name} no longer exists.`);
  const cloud = process.platform === 'win32' && !LOCAL_ERRORS.has(code) ? ' If it is a OneDrive file, make it available offline or check your connection, then copy it again.' : '';
  return new Error(`Could not read ${name}: ${message(error)}.${cloud}`);
}
export function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
export async function sampleImage() {
  const svg = `<svg width="2400" height="1600" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#b0cbd5"/><stop offset="1" stop-color="#eee2cf"/></linearGradient><linearGradient id="hill" x2="0" y2="1"><stop stop-color="#65867d"/><stop offset="1" stop-color="#354e56"/></linearGradient></defs><rect width="2400" height="1600" fill="url(#sky)"/><circle cx="1670" cy="440" r="180" fill="#f8ebca"/><path d="M0 1150L540 430 1150 1220 1600 680 2400 1170V1600H0Z" fill="#94a4a0"/><path d="M0 1300L500 900 1000 1320 1550 850 2400 1330V1600H0Z" fill="url(#hill)"/><path d="M0 1450Q550 1110 1250 1450T2400 1360V1600H0Z" fill="#2a434a"/><path d="M390 635L540 430 770 725 540 640 480 705Z" fill="#eff0e6"/></svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 0 }).toBuffer();
}
