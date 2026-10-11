import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, exists, samePath } from '../fileops';
import type { OptimisedMarker } from '../marker';
import { optimiseAudio } from '../media/audio';
import { probe, type AudioInfo, type VideoInfo } from '../media/detect';
import { optimiseImage } from '../media/image';
import { probeImage } from '../media/image-codecs';
import { cropPDF, optimisePDF } from '../media/pdf';
import type { MediaKind, MediaOutput } from '../media/types';
import { optimiseVideo } from '../media/video';
import { planPlacement, type PlacementOverride } from '../placement';
import { CONCURRENCY, limiter, ToolError, type Limiter } from '../run';
import type { ClopSettings } from '../settings/schema';
import type { Counter } from '../template';
import type { Workdir } from '../workdir';
import { BatchBackup } from './backup';
import { pdfAspectRatio } from './crop';
import { batchKind, type BatchFile } from './scan';
import { checkOutputTemplate, defaultBatchParams, type BatchOutput, type BatchParams } from './spec';

// The batch run of BatchOptimiser.swift (BatchManager.startRun, runItem, placeResult, restoreFromBackup) on the core engines.

export type BatchItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped' | 'reverted';
export type BatchPhase = 'running' | 'finished' | 'cancelled' | 'reverting' | 'reverted';
export interface Dimensions { width: number; height: number }
/**
 * A row of the results table. `detail` is the DPI of a PDF or the kbps of an audio file before and after. `unchanged` means
 * the result was not smaller, so the file was left as it was. `result` is where the result went.
 */
export interface BatchItem {
  path: string; name: string; kind: MediaKind; status: BatchItemStatus; error?: string; progress?: number;
  oldBytes: number; newBytes?: number; oldFormat: string; newFormat?: string; oldSize?: Dimensions; newSize?: Dimensions;
  oldDetail?: number; newDetail?: number; result?: string; unchanged?: boolean;
}
export interface BatchFailure { path: string; name: string; error: string; log?: string }
/** `backups` is the batch's backup folder; once `backupsDeleted`, nothing can be reverted. */
export interface BatchSnapshot { id: string; phase: BatchPhase; items: BatchItem[]; backups: string; backupsDeleted: boolean }
export interface BatchEnv {
  workdir: Workdir;
  settings: () => ClopSettings;
  /** Placed results are marked, so watched folders leave them alone; so are reverted originals. */
  marker: OptimisedMarker;
  /** The number behind `%i`; `saved` hears it after a name template advanced it. */
  counter: Counter;
  saved?: (value: number) => void;
  home?: string;
  platform?: NodeJS.Platform;
}

const LOSSLESS_AUDIO = new Set(['wav', 'aiff', 'aif', 'flac']);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const firstLine = (text: string) => text.split(/\r?\n/)[0];
const extension = (file: string) => path.extname(file).slice(1).toLowerCase();

function overrides(output: BatchOutput): PlacementOverride {
  if (output.location === 'inPlace') return { optimised: 'inPlace', autoConvert: 'inPlace', manualConvert: 'inPlace' };
  if (output.location === 'sameFolder') return { optimised: 'sameFolder', autoConvert: 'sameFolder', manualConvert: 'sameFolder', sameFolderTemplate: output.template };
  return { optimised: 'specificFolder', autoConvert: 'specificFolder', manualConvert: 'specificFolder', specificFolderRoot: output.folder, specificFolderTemplate: output.template };
}

/** Whether `file` is still what a backup entry kept: present with the same size and time (a copy is stamped to whole milliseconds). */
const isAsKept = (file: string, kept: { size: number; mtimeMs: number }) => stat(file).then(info => info.size === kept.size && Math.abs(info.mtimeMs - kept.mtimeMs) < 1, () => false);

/** What a media job produced, before it is placed. */
interface Produced { output: MediaOutput; converted: boolean; allowLarger: boolean; oldSize?: Dimensions; oldDetail?: number; newDetail?: number }

/**
 * One batch: every file runs through its kind's engine with the batch's parameters, kinds side by side, and its result is
 * placed where `params.output` says. A file Clop writes over or removes is first moved into the batch's backup folder, so
 * `revert` can give back every original exactly. Emits `change` whenever a row changes.
 */
export class Batch extends EventEmitter {
  readonly id: string;
  readonly items: BatchItem[];
  phase: BatchPhase = 'running';
  readonly backup: BatchBackup;
  private readonly controller = new AbortController();
  private readonly logs = new Map<BatchItem, string>();
  /** Paths results took or originals hold, so two files with one name never land on one result. */
  private readonly claimed = new Set<string>();
  private running?: Promise<void>;
  private readonly limits = new Map<MediaKind, Limiter>();
  private backupsDeleted = false;
  private deleting = false;
  private reverting?: Promise<string[]>;
  constructor(files: readonly BatchFile[], readonly params: BatchParams, private readonly env: BatchEnv, backup?: BatchBackup) {
    super();
    checkOutputTemplate(params.output);
    this.items = files.map(file => ({ path: file.path, name: path.basename(file.path), kind: file.kind, status: 'queued', oldBytes: file.bytes, oldFormat: file.format }));
    this.id = backup?.id ?? randomUUID();
    this.backup = backup ?? new BatchBackup(env.workdir, this.id, env.platform);
    for (const item of this.items) this.claimed.add(this.key(item.path));
  }
  /**
   * Opens a batch that ran before, from its manifest (`loadManifest`), as a finished batch whose rows are its results, so it can
   * be reverted. Undefined when the batch has no manifest. Rows hold only what the manifest knows: names, results and sizes.
   */
  static async restore(id: string, env: BatchEnv): Promise<Batch | undefined> {
    const backup = await BatchBackup.load(env.workdir, id, env.platform);
    if (!backup) return undefined;
    const results = backup.allResults().sort((a, b) => a.original.localeCompare(b.original, undefined, { numeric: true })), files: BatchFile[] = [];
    for (const result of results) {
      const kept = await backup.entry(result.original), kind = batchKind(result.original) ?? batchKind(result.path);
      if (kind) files.push({ path: result.original, kind, bytes: kept?.size ?? result.size, format: extension(result.original).toUpperCase() });
    }
    const batch = new Batch(files, defaultBatchParams(env.settings()), env, backup);
    batch.phase = 'finished';
    for (const item of batch.items) {
      const result = backup.result(item.path)!;
      Object.assign(item, { status: 'done', result: result.path, newBytes: result.size, newFormat: extension(result.path).toUpperCase() });
    }
    return batch;
  }
  private key(file: string) { const resolved = path.resolve(file); return (this.env.platform ?? process.platform) === 'win32' ? resolved.toLowerCase() : resolved; }
  private changed() { this.emit('change'); }
  private get workDir() { return path.join(this.backup.dir, 'work'); }

  /** Whether the batch still has originals to give back: it is over, its backups are there and a result replaced something. */
  get revertable() { return (this.phase === 'finished' || this.phase === 'cancelled') && !this.backupsDeleted && this.items.some(item => item.status === 'done' && !item.unchanged); }

  snapshot(): BatchSnapshot { return { id: this.id, phase: this.phase, items: this.items.map(item => ({ ...item })), backups: this.backup.dir, backupsDeleted: this.backupsDeleted }; }
  /** The files that failed, with the tool output behind each failure (the failures sheet). */
  failures(): BatchFailure[] { return this.items.filter(item => item.status === 'failed').map(item => ({ path: item.path, name: item.name, error: item.error ?? 'Failed', ...(this.logs.has(item) ? { log: this.logs.get(item) } : {}) })); }

  /** Runs every queued file. Resolves when all have finished, failed or been skipped. */
  run(): Promise<void> {
    return this.running ??= (async () => {
      const signal = this.controller.signal;
      await Promise.all(this.items.map(item => this.limit(item.kind)(() => this.process(item, signal))));
      await rm(this.workDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      if (this.phase === 'running') this.phase = signal.aborted ? 'cancelled' : 'finished';
      this.changed();
    })();
  }
  private limit(kind: MediaKind) { let limit = this.limits.get(kind); if (!limit) this.limits.set(kind, limit = limiter(CONCURRENCY[kind])); return limit; }

  /** Stops the run: running files stop and queued ones are skipped. Finished files keep their results. */
  cancel() {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    for (const item of this.items) if (item.status === 'queued') item.status = 'skipped';
    this.changed();
  }

  private async process(item: BatchItem, signal: AbortSignal) {
    if (item.status !== 'queued') return;
    if (signal.aborted) { item.status = 'skipped'; this.changed(); return; }
    item.status = 'running'; this.changed();
    const outputDir = path.join(this.workDir, String(this.items.indexOf(item)));
    try {
      const before = await stat(item.path);
      const produced = await this.produce(item, outputDir, signal);
      signal.throwIfAborted();
      const { output } = produced;
      Object.assign(item, { oldSize: produced.oldSize, oldDetail: produced.oldDetail });
      // A conversion that came out larger is kept only with "Keep if larger"; anything else not smaller leaves the file as it was.
      if (output.unchanged || (produced.converted && !produced.allowLarger && output.bytes >= item.oldBytes)) {
        Object.assign(item, { status: 'done', unchanged: true, newBytes: item.oldBytes, newFormat: item.oldFormat, newSize: produced.oldSize, newDetail: produced.oldDetail, progress: undefined });
      } else {
        const placed = await this.place(item, output.path, before);
        Object.assign(item, {
          status: 'done', result: placed, newBytes: output.bytes, newFormat: extension(placed).toUpperCase(), progress: undefined,
          newSize: output.width && output.height ? { width: output.width, height: output.height } : produced.oldSize, newDetail: produced.newDetail,
        });
      }
    } catch (error) {
      if (signal.aborted) Object.assign(item, { status: 'skipped', progress: undefined });
      else {
        const text = message(error);
        Object.assign(item, { status: 'failed', error: firstLine(text), progress: undefined });
        const log = error instanceof ToolError && error.stderr && !text.includes(error.stderr) ? `${text}\n\n${error.stderr}` : text;
        if (log !== item.error) this.logs.set(item, log);
      }
    } finally {
      await rm(outputDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      this.changed();
    }
  }

  /** Reports progress in 2 % steps, so a long encode does not flood the window with updates. */
  private progress(item: BatchItem) {
    return (fraction: number) => { const value = Math.floor(fraction * 50) / 50; if (value > (item.progress ?? 0)) { item.progress = value; this.changed(); } };
  }

  private async produce(item: BatchItem, outputDir: string, signal: AbortSignal): Promise<Produced> {
    const s = this.env.settings(), p = this.params, file = item.path, name = path.parse(file).name, onProgress = this.progress(item);
    const aggressive = p.aggressive || undefined, job = { name, signal, onProgress };
    switch (item.kind) {
      case 'image': {
        const ip = p.image, info = await probeImage(file, signal), oldSize = { width: info.width, height: info.height };
        const long = Math.max(info.width, info.height);
        const factor = ip.crop ? 1 : ip.maxLongEdge ? Math.min(1, ip.maxLongEdge / long) : ip.downscale ?? 1;
        const size = factor < 1 ? { width: Math.max(1, Math.round(info.width * factor)), height: Math.max(1, Math.round(info.height * factor)) } : {};
        const output = await optimiseImage(file, outputDir, {
          ...job, ...size, aggressive, compression: { tier: ip.lossless ? 'lossless' : ip.adaptive ? 'adaptive' : 'custom', factor: ip.compression }, format: ip.convert, cropSize: ip.crop,
          stripMetadata: s.stripMetadata, preserveColorMetadata: s.preserveColorMetadata, gifFrameDropBehaviour: s.gifFrameDropBehaviour,
        });
        // The engine names a JPEG result `.jpeg`; a file that kept its format keeps its own extension (`.jpg`, `.tif`).
        if (!output.unchanged && output.format === info.format && path.extname(output.path).toLowerCase() !== path.extname(file).toLowerCase()) {
          const renamed = path.join(path.dirname(output.path), path.basename(file));
          await rename(output.path, renamed);
          output.path = renamed;
        }
        return { output, converted: !!ip.convert && ip.convert !== info.format, allowLarger: ip.allowLarger, oldSize };
      }
      case 'video': {
        const vp = p.video, info = await probe(file, { signal }) as VideoInfo, oldSize = { width: info.width, height: info.height };
        const crop = vp.crop ?? (vp.maxLongEdge ? { width: vp.maxLongEdge, height: vp.maxLongEdge, longEdge: true } : undefined);
        const size = !crop && vp.downscale ? { width: Math.round(info.width * vp.downscale), height: Math.round(info.height * vp.downscale) } : {};
        const convert = vp.convert === 'mp4' ? undefined : vp.convert;
        const output = await optimiseVideo(file, outputDir, {
          ...job, ...size, aggressive, crop, compression: { tier: vp.encoder, factor: vp.compression }, encoder: s.videoEncoder,
          ...(vp.convert === 'mp4' ? { format: 'mp4' } : {}), ...(convert ? { convert: { codec: convert } } : {}),
          ...(vp.fps ? { fps: vp.fps } : { capVideoFPS: s.capVideoFPS, targetVideoFPS: s.targetVideoFPS, minVideoFPS: s.minVideoFPS }),
          removeAudio: vp.removeAudio, convertAudioToAAC: s.convertAudioToAAC, adaptiveVideoSize: s.adaptiveVideoSize, stripMetadata: s.stripMetadata,
        });
        return { output, converted: !!vp.convert && extension(output.path) !== extension(file), allowLarger: vp.allowLarger, oldSize };
      }
      case 'pdf': {
        const dp = p.pdf, dpi = dp.dpi === 'adaptive' ? { dpiSetting: 0 } : dp.dpi === 'stepDown' ? { dpiSetting: s.pdfDPI } : { dpi: dp.dpi };
        // A crop always keeps its result, even when it is not smaller (PDFPipeline.swift).
        let output: MediaOutput & { dpi?: number; sourceDPI?: number } = await optimisePDF(file, outputDir, { ...job, ...dpi, aggressive: aggressive || dp.dpi === 'stepDown' || undefined, allowLarger: !!dp.crop });
        const { dpi: newDetail, sourceDPI: oldDetail } = output;
        if (dp.crop) output = await cropPDF(output.path, path.join(outputDir, 'cropped'), { name, aspectRatio: pdfAspectRatio(dp.crop) });
        // PDF.swift gives an optimised PDF its source's dates.
        if (!output.unchanged && s.preserveDates) { const { atime, mtime } = await stat(file); await utimes(output.path, atime, mtime); }
        return { output, converted: false, allowLarger: true, oldDetail, newDetail };
      }
      case 'audio': {
        const ap = p.audio, info = await probe(file, { signal }) as AudioInfo, ext = extension(file);
        // Lossless inputs keep their format unless the batch converts them too.
        const format = LOSSLESS_AUDIO.has(ext) && !ap.convertLossless ? undefined : ap.format;
        const output = await optimiseAudio(file, outputDir, {
          ...job, aggressive, format, compression: { tier: 'custom', factor: ap.compression }, bitrate: ap.bitrate, loudnorm: ap.loudnorm, allowLarger: ap.allowLarger && !!format,
          coverArt: ap.coverArt, coverArtMaxLongEdge: ap.coverArtMaxLongEdge, coverArtSquaring: ap.coverArtSquaring, preserveDates: s.preserveDates,
          formatsToConvertToAAC: s.formatsToConvertToAAC, formatsToConvertToMP3: s.formatsToConvertToMP3,
        });
        const kbps = (bits?: number) => bits === undefined ? undefined : Math.trunc(bits / 1000);
        return { output, converted: !!format && extension(output.path) !== ext, allowLarger: true, oldDetail: kbps(info.bitrate), newDetail: output.bitrate };
      }
    }
  }

  /** A path for a result that no other file of this batch holds or took, numbering it (`name-2.jpg`) when needed. */
  private claim(dest: string, original: string) {
    if (samePath(dest, original, this.env.platform)) return dest;
    const { dir, name, ext } = path.parse(dest);
    let candidate = dest;
    for (let n = 2; this.claimed.has(this.key(candidate)); n++) candidate = path.join(dir, `${name}-${n}${ext}`);
    this.claimed.add(this.key(candidate));
    return candidate;
  }

  /**
   * Port of `placeResult`: puts `produced` where the batch's output says, by the placement rules and name templates. An
   * original that is written over, or that a converted result replaces in place, moves into the batch backup first, as does
   * a file of the user's already at the destination. The original must not have changed since the job read it (`before`).
   */
  private async place(item: BatchItem, produced: string, before: { size: number; mtimeMs: number }): Promise<string> {
    const { env } = this, original = item.path, counter = env.counter.value;
    const plan = await planPlacement({ settings: env.settings(), workdir: env.workdir, counter: env.counter, marker: env.marker, home: env.home, platform: env.platform }, { produced, original, type: item.kind, overrides: overrides(this.params.output) });
    if (env.counter.value !== counter) env.saved?.(env.counter.value);
    const dest = this.claim(plan.dest ?? original, original), over = samePath(dest, original, env.platform);
    const removes = over || this.params.output.location === 'inPlace';
    // Whatever was taken aside or created goes back if anything below fails, the manifest write included, so a failed file is exactly as it was.
    const undo: (() => Promise<void>)[] = [];
    try {
      if (!over) {
        // A file of the user's at the destination is copied, not moved, so the result replaces it atomically.
        if (await exists(dest)) { const kept = await this.backup.keep(dest, { copy: true }); undo.push(async () => { if (!await isAsKept(dest, kept)) await copyTo(kept.backup, dest); await this.backup.discard(dest); }); }
        else undo.push(() => rm(dest, { force: true }));
      }
      if (removes) {
        // An original the result replaces in its own path is copied, so the path is never empty; one that goes under another name is moved.
        const kept = await this.backup.keep(original, { copy: over, before });
        // A copy leaves the original where it is, so it is only given back if the result had already replaced it.
        undo.push(async () => { if (!over || !await isAsKept(original, kept)) await copyTo(kept.backup, original); await this.backup.discard(original); });
      }
      await copyTo(produced, dest);
      await env.marker.markOptimised(dest).catch(() => {});
      const info = await stat(dest);
      await this.backup.recordResult({ original, path: dest, size: info.size, mtimeMs: info.mtimeMs, originalRemoved: removes && !over });
    } catch (error) {
      for (const step of undo.reverse()) await step().catch(() => {});
      throw error;
    }
    return dest;
  }

  /**
   * Gives back every original of the batch (`restoreFromBackup`), stopping the run first. Like reverting watched files, a
   * result that was moved, deleted or edited since is left alone, and so is a new file where a converted original was.
   * Returns a message for each file that could not be reverted.
   */
  async revert(): Promise<string[]> {
    if (this.backupsDeleted || this.deleting) throw new Error('The backups of this batch were deleted, so its originals cannot be restored.');
    // A second request while one runs (a double click) gets the answer of the first rather than a second pass over the same files.
    return this.reverting ??= this.revertAll().finally(() => { this.reverting = undefined; });
  }

  private async revertAll(): Promise<string[]> {
    this.cancel();
    await this.running;
    this.phase = 'reverting'; this.changed();
    const failures: string[] = [];
    for (const item of this.items) {
      const result = this.backup.result(item.path);
      if (!result) continue;
      try {
        await this.revertItem(item.path, result);
        await this.backup.forgetResult(item.path);
        Object.assign(item, { status: 'reverted', result: undefined, error: undefined });
      } catch (error) { failures.push(`${item.name}: ${message(error)}`); }
      this.changed();
    }
    this.phase = 'reverted'; this.changed();
    return failures;
  }

  private async revertItem(original: string, result: NonNullable<ReturnType<BatchBackup['result']>>) {
    const name = path.basename(result.path), info = await stat(result.path).catch(() => undefined);
    if (!info) throw new Error(`${name} was moved or deleted after Clop optimised it, so its original stays in the batch backups.`);
    if (info.size !== result.size || info.mtimeMs !== result.mtimeMs) throw new Error(`${name} changed after Clop optimised it, so Clop left it as it is. Its original is in the batch backups.`);
    const over = samePath(result.path, original, this.env.platform);
    // An original that an earlier, unfinished revert already gave back is not a new file in its place.
    if (result.originalRemoved && !result.originalRestored && await exists(original)) throw new Error(`A new ${path.basename(original)} is where the original was, so Clop left both as they are. The original is in the batch backups.`);
    if ((over || result.originalRemoved) && !result.originalRestored) {
      await this.backup.restore(original);
      // Marked, so a watched folder does not optimise the original again.
      await this.env.marker.markOptimised(original).catch(() => {});
      // Remembered before the rest, so a retry after a failure below carries on from here.
      if (!over) await this.backup.recordResult({ ...result, originalRestored: true });
    }
    if (over) return;
    // A file of the user's that the result took the place of comes back; otherwise the result goes.
    if (await this.backup.entry(result.path)) await this.backup.restore(result.path);
    else await rm(result.path, { force: true });
  }

  /** Removes the batch's backups. Only once nothing is running, since running files may still need them. */
  async deleteBackups() {
    if (this.phase === 'running' || this.phase === 'reverting') throw new Error('Wait for the batch to finish before deleting its backups.');
    this.deleting = true;
    try { await this.backup.delete(); } finally { this.deleting = false; }
    this.backupsDeleted = true; this.changed();
  }
}
