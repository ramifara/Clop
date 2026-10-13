import sharp from 'sharp';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, writeFile, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { ImageOptions, ItemResult } from '../src/types';
import { defaultSettings, type ClopSettings } from '../core/settings/schema';
import { optimiseImage } from '../core/media/image';
import { probeImage } from '../core/media/image-codecs';
import { optimiseVideo } from '../core/media/video';
import { optimisePDF } from '../core/media/pdf';
import { optimiseAudio } from '../core/media/audio';
import { detectKind, probe, type AudioInfo, type VideoInfo } from '../core/media/detect';
import type { MediaJobOptions, MediaKind, MediaOutput } from '../core/media/types';
import { safeFileName } from '../core/template';
import { imageThumbnail, mediaThumbnail } from './thumbnails';
import { imageCompression, parseOptions } from './settings';
import { mediaKind } from './clipboard';

sharp.concurrency(2);
sharp.cache({ memory: 32, files: 0, items: 32 });
const INPUT = new Set(['jpeg', 'png', 'webp', 'avif', 'heic', 'jxl', 'gif', 'tiff', 'bmp', 'svg']);
/** Formats sharp cannot decode, and 16-bit images that may be HDR, are previewed from a decoded PNG. */
const DECODED = new Set(['heic', 'jxl', 'bmp']);
const LIMIT = 128 * 1024 * 1024;
const PIXELS = 60_000_000;
/** Ordinary read failures; anything else on Windows may be a OneDrive placeholder that could not download. */
const LOCAL_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'EISDIR']);
/** `cancel` stops this item's running job when it is dismissed; `running` says a job is under way, `shown` that a result was ever ready to paste. */
interface Entry { result: ItemResult; originalPath: string; outputPath: string; directory: string; inputFormat: string; revision: number; cancel: AbortController; running?: boolean; shown?: boolean }
export type ItemSettings = Pick<ClopSettings, 'imageCompression' | 'stripMetadata' | 'preserveColorMetadata' | 'gifFrameDropBehaviour' | 'videoCompression' | 'videoEncoder' | 'capVideoFPS' | 'targetVideoFPS'
  | 'minVideoFPS' | 'removeAudioFromVideos' | 'convertAudioToAAC' | 'adaptiveVideoSize' | 'pdfDPI' | 'audioCompression' | 'formatsToConvertToAAC' | 'formatsToConvertToMP3' | 'audioCoverArt' | 'preserveDates'>;
/**
 * The session's results: images, videos, PDFs and audio files. Each keeps a copy of its original, so results always start
 * from it and restoring gives back its exact bytes. Sources are never written to.
 */
export class ItemEngine extends EventEmitter {
  private entries = new Map<string, Entry>();
  private queues = new Map<MediaKind, Promise<unknown>>();
  private controller = new AbortController();
  /** `settings` is read for every job, so a changed compression setting applies to the next one. */
  constructor(private root: string, private settings: () => ItemSettings = defaultSettings) { super(); }
  list() { return [...this.entries.values()].map(e => structuredClone(e.result)).reverse(); }
  get(id: string) { const entry = this.entries.get(id); if (!entry) throw new Error('This result is no longer in the shelf.'); return entry; }
  output(id: string) { const entry = this.get(id); if (entry.result.status !== 'ready') throw new Error('Wait for this result to finish first.'); return entry.outputPath; }
  private changed() { this.emit('change'); }
  /** Jobs of one kind run in order; a long video never holds up a copied image. */
  private schedule<T>(kind: MediaKind, task: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(kind) ?? Promise.resolve()).then(task, task);
    this.queues.set(kind, run.catch(() => {}));
    return run;
  }
  private kindOf(id: string): MediaKind { return this.entries.get(id)?.result.kind ?? 'image'; }
  /** Imports a local file under `name` (its own by default). */
  async importPath(file: string, source: ItemResult['source'], options: ImageOptions, name = path.basename(file)) {
    const info = await stat(file).catch(error => { throw unreadable(file, error); });
    if (!info.isFile()) throw new Error(`${path.basename(file)} is not a file.`);
    if (info.size > LIMIT && await detectKind(file).catch(() => undefined) === 'image') throw new Error('Choose an image file smaller than 128 MB.');
    // Copying reads the file, which makes OneDrive download a files-on-demand placeholder. One that cannot download fails here.
    // The copy keeps the source's dates, which results take with `preserveDates`.
    return this.add(name, source, options, staged => copyFile(file, staged).then(() => utimes(staged, info.atime, info.mtime)).catch(error => { throw unreadable(file, error); }));
  }
  async importBuffer(buffer: Buffer, name: string, source: ItemResult['source'], options: ImageOptions): Promise<string> {
    if (!buffer.length || buffer.length > LIMIT) throw new Error('Choose a file smaller than 128 MB.');
    return this.add(name, source, options, staged => writeFile(staged, buffer));
  }
  private async add(name: string, source: ItemResult['source'], options: ImageOptions, write: (staged: string) => Promise<unknown>) {
    options = parseOptions(options);
    const signal = this.controller.signal;
    signal.throwIfAborted();
    // A long name loses the end of its stem, never its extension, which says what the file is.
    const base = path.basename(name), { name: stemPart, ext: extPart } = path.parse(base);
    const id = randomUUID(), directory = path.join(this.root, id), display = (base.length > 160 ? stemPart.slice(0, 160 - extPart.slice(0, 12).length) + extPart.slice(0, 12) : base) || 'Clipboard';
    await mkdir(path.join(directory, 'original'), { recursive: true });
    let entry: Entry;
    try {
      // A short name keeps the session's paths well under Windows' 260 characters, which some bundled tools need.
      const { name: stem, ext } = path.parse(safeFileName(display)), staged = path.join(directory, 'original', `${stem.slice(0, 64) || 'file'}${ext.slice(0, 12)}`);
      await write(staged);
      const kind = await detectKind(staged, { signal });
      if (!kind) throw new Error('Use an image, a video, a PDF or an audio file.');
      const result = { id, kind, name: display, source, status: 'processing', options, animated: false, createdAt: Date.now() } as const;
      entry = kind === 'image' ? await this.stageImage(staged, directory, result) : await this.stageMedia(staged, directory, { ...result, kind });
      this.entries.set(id, entry);
      this.changed();
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    await this.schedule(entry.result.kind, () => this.process(id, options));
    return id;
  }
  private async stageImage(staged: string, directory: string, base: Pick<ItemResult, 'id' | 'kind' | 'name' | 'source' | 'status' | 'options' | 'animated' | 'createdAt'>): Promise<Entry> {
    const signal = this.controller.signal;
    const info = await probeImage(staged, signal).catch(error => { if (signal.aborted) throw error; return undefined; });
    if (!info || !INPUT.has(info.format) || !info.width || !info.height) throw new Error('Use PNG, JPEG, WebP, GIF, AVIF, HEIC, JPEG XL, TIFF, BMP or SVG.');
    const { format, width, height, pages } = info;
    if (format === 'tiff' && pages > 1) throw new Error('Use a single-page TIFF image. Multi-page documents are not supported.');
    if (pages > 250 || info.pixels > PIXELS) throw new Error('This image has too many pixels or animation frames. Use an image under 60 megapixels in total.');
    const originalPath = path.join(path.dirname(staged), `${path.parse(staged).name || 'image'}.${format}`);
    await rename(staged, originalPath);
    const preview = await imageThumbnail(originalPath, DECODED.has(format) || info.deep), bytes = (await stat(originalPath)).size;
    const result: ItemResult = { ...base, originalBytes: bytes, outputBytes: bytes, originalWidth: width, originalHeight: height, width, height, format, originalPreview: preview, preview, animated: pages > 1 };
    return { result, originalPath, outputPath: originalPath, directory, inputFormat: format, revision: 0, cancel: new AbortController() };
  }
  private async stageMedia(staged: string, directory: string, base: Pick<ItemResult, 'id' | 'name' | 'source' | 'status' | 'options' | 'animated' | 'createdAt'> & { kind: Exclude<MediaKind, 'image'> }): Promise<Entry> {
    const signal = this.controller.signal;
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
      format, originalPreview: preview, preview, durationMs: info?.durationMs,
    };
    return { result, originalPath: staged, outputPath: staged, directory, inputFormat: format, revision: 0, cancel: new AbortController() };
  }
  apply(id: string, options: ImageOptions) {
    options = parseOptions(options);
    if (this.get(id).result.kind !== 'image') throw new Error('Only images can be resized or converted from the card.');
    return this.schedule('image', () => this.process(id, options));
  }
  private async process(id: string, options: ImageOptions) {
    // An item dismissed while its job waited has nothing left to do.
    const e = this.entries.get(id);
    if (!e) return;
    const r = e.result, signal = AbortSignal.any([this.controller.signal, e.cancel.signal]);
    r.status = 'processing'; r.error = undefined; r.progress = undefined; e.running = true; this.changed();
    try {
      // Each result gets a folder of its own and keeps the original's name, so a pasted or dragged file is named like its source.
      const outputDir = path.join(e.directory, String(e.revision + 1)), name = path.parse(e.originalPath).name;
      let output: MediaOutput, width = r.originalWidth, height = r.originalHeight;
      if (r.kind === 'image') {
        const factor = Math.min(options.scale, options.maxEdge ? options.maxEdge / Math.max(r.originalWidth, r.originalHeight) : 1);
        width = Math.max(1, Math.round(r.originalWidth * factor)); height = Math.max(1, Math.round(r.originalHeight * factor));
        const settings = this.settings();
        output = await optimiseImage(e.originalPath, outputDir, {
          ...imageCompression(options.mode, settings.imageCompression), format: options.format === 'auto' ? undefined : options.format, width, height,
          stripMetadata: settings.stripMetadata, preserveColorMetadata: settings.preserveColorMetadata, gifFrameDropBehaviour: settings.gifFrameDropBehaviour, name, signal,
        });
      } else output = await this.optimiseMedia(r.kind, e.originalPath, outputDir, { aggressive: options.mode === 'aggressive', name, signal, onProgress: this.progress(r) });
      if (!output.unchanged) e.revision++;
      // PDF.swift gives an optimised PDF its source's dates; the audio optimiser does it itself, and macOS leaves video dates alone.
      if (r.kind === 'pdf' && !output.unchanged && this.settings().preserveDates) { const { atime, mtime } = await stat(e.originalPath); await utimes(output.path, atime, mtime); }
      // Keep earlier results until the session ends: other apps may still be pasting or dragging them.
      e.outputPath = output.path;
      for (const warning of output.warnings ?? []) console.warn(warning);
      // Video, PDF and audio previews show the content, which optimising leaves as it was.
      const preview = r.kind !== 'image' || output.unchanged ? r.originalPreview : await imageThumbnail(output.path, DECODED.has(output.format));
      Object.assign(r, { status: 'ready', options, format: output.format, width: output.width ?? width, height: output.height ?? height, outputBytes: output.bytes, preview,
        durationMs: output.durationMs ?? r.durationMs, pages: output.pages ?? r.pages, progress: undefined, unchanged: !!output.unchanged, restored: false });
      e.shown = true; this.changed();
      if (this.entries.get(id) === e) this.emit('ready', id);
    } catch (error) { Object.assign(r, { status: 'error', error: message(error), progress: undefined }); this.changed(); }
    finally {
      e.running = false;
      if (this.entries.get(id) !== e && !e.shown) await discard(e);
    }
  }
  private optimiseMedia(kind: Exclude<MediaKind, 'image'>, file: string, outputDir: string, job: MediaJobOptions & { name: string }): Promise<MediaOutput> {
    const s = this.settings();
    if (kind === 'video') return optimiseVideo(file, outputDir, { ...job, compression: s.videoCompression, encoder: s.videoEncoder, capVideoFPS: s.capVideoFPS, targetVideoFPS: s.targetVideoFPS,
      minVideoFPS: s.minVideoFPS, removeAudio: s.removeAudioFromVideos, convertAudioToAAC: s.convertAudioToAAC, adaptiveVideoSize: s.adaptiveVideoSize, stripMetadata: s.stripMetadata });
    if (kind === 'pdf') return optimisePDF(file, outputDir, { ...job, dpiSetting: s.pdfDPI });
    return optimiseAudio(file, outputDir, { ...job, compression: s.audioCompression, formatsToConvertToAAC: s.formatsToConvertToAAC, formatsToConvertToMP3: s.formatsToConvertToMP3, coverArt: s.audioCoverArt, preserveDates: s.preserveDates });
  }
  /** Reports progress in 2 % steps, so a long encode does not flood the windows with updates. */
  private progress(r: ItemResult) {
    return (fraction: number) => { const value = Math.floor(fraction * 50) / 50; if (value > (r.progress ?? 0)) { r.progress = value; this.changed(); } };
  }
  restore(id: string) { return this.schedule(this.kindOf(id), async () => {
    const e = this.get(id);
    e.outputPath = e.originalPath;
    Object.assign(e.result, { status: 'ready', width: e.result.originalWidth, height: e.result.originalHeight, outputBytes: e.result.originalBytes,
      format: e.inputFormat, preview: e.result.originalPreview, options: { ...e.result.options, scale: 1, maxEdge: undefined, format: 'auto' }, restored: true, unchanged: true, error: undefined });
    e.shown = true; this.changed(); this.emit('ready', id);
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
    // Nothing can be pasting a result that was never ready, so its folder goes; a running job removes it once it stops.
    if (!entry.shown && !entry.running) await discard(entry);
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
