import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Batch, type BatchEnv } from '../core/batch/engine';
import { MAX_BATCH_FILES, scanBatch, type BatchFile } from '../core/batch/scan';
import { BATCH_AUDIO_FORMATS, defaultBatchParams, parseBatchParams } from '../core/batch/spec';
import { AUDIO_FORMATS } from '../core/media/audioFormat';
import type { ClopSettings } from '../core/settings/schema';
import type { BatchViewState } from '../src/batch/types';

// The batch optimiser behind its window: BatchManager.prepare/add/beginProcessing/cancel/restoreFromBackup and the drop-zone
// routing of DropZone.swift. Every request from the window is checked here; the window only ever names paths this listed.

export interface BatchHostOptions {
  settings: () => ClopSettings;
  env: () => BatchEnv;
  /** Files in Clop's working directory, which never join a batch. */
  owns: (file: string) => boolean;
  /** Shows the batch window. */
  show: () => void;
  /** Sends a new state to the window. */
  publish: (state: BatchViewState) => void;
  reveal: (file: string) => void;
  native?: boolean;
}

const isPathList = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= max && value.every(item => typeof item === 'string' && item.length < 32_768 && path.isAbsolute(item));
const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const key = (file: string) => { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };

export class BatchHost {
  private files: BatchFile[] = [];
  private scanning = false;
  private truncated = false;
  private aggressive?: boolean;
  private batch?: Batch;
  private timer?: NodeJS.Timeout;
  constructor(private options: BatchHostOptions) {}

  state(): BatchViewState {
    const settings = this.options.settings();
    return {
      files: this.files, scanning: this.scanning, truncated: this.truncated, batch: this.batch?.snapshot(), native: this.options.native ?? true,
      defaults: defaultBatchParams(settings, this.aggressive), cropSizes: settings.savedCropSizes,
      audioFormats: BATCH_AUDIO_FORMATS.map(format => { const spec = AUDIO_FORMATS[format]; return { format, name: spec.name, lossless: spec.lossless, coverArt: spec.coverArt, ...(spec.bitrateRange ? { bitrates: spec.bitrateRange } : {}) }; }),
    };
  }
  private publish() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.options.publish(this.state()); }
  /** Rows change many times a second while files encode, so the window hears at most ten states a second (BatchManager's 100 ms flush). */
  private publishSoon() { this.timer ??= setTimeout(() => this.publish(), 100); }
  private get running() { return this.batch?.phase === 'running' || this.batch?.phase === 'reverting'; }

  /**
   * Whether a drop goes to the batch window instead of the floating results: with `useBatchModeForFolders`, a drop holding a
   * folder or more files than `batchModeFileCountThreshold`. Such a drop is prepared in the window and true is returned.
   */
  async drop(files: unknown, aggressive = false): Promise<boolean> {
    const s = this.options.settings();
    if (!s.useBatchModeForFolders || !isPathList(files, MAX_BATCH_FILES)) return false;
    const folder = (await Promise.all(files.map(file => stat(file).then(info => info.isDirectory(), () => false)))).some(Boolean);
    if (!folder && files.length <= s.batchModeFileCountThreshold) return false;
    await this.add(files, aggressive);
    return true;
  }

  /** Adds files and folders to the batch being prepared; after a batch ran, they start a new one. Refused while a batch runs. */
  async add(files: unknown, aggressive?: boolean) {
    this.options.show();
    if (this.running) throw new Error('A batch is running. Wait for it to finish or cancel it before adding files.');
    if (!isPathList(files, MAX_BATCH_FILES)) throw new Error(`Drop up to ${MAX_BATCH_FILES} files and folders at a time.`);
    if (this.batch) this.reset();
    if (aggressive !== undefined) this.aggressive = aggressive || undefined;
    this.scanning = true; this.publish();
    try {
      const { files: found, truncated } = await scanBatch([...this.files.map(file => file.path), ...files], { owns: this.options.owns, limit: MAX_BATCH_FILES });
      this.files = found; this.truncated = truncated;
    } finally { this.scanning = false; this.publish(); }
  }

  /** Starts the prepared files named in `request.files` with `request.params` (`beginProcessing`). */
  async start(request: unknown) {
    if (this.running) throw new Error('A batch is already running.');
    const { files, params } = (typeof request === 'object' && request !== null ? request : {}) as { files?: unknown; params?: unknown };
    if (!isPathList(files, MAX_BATCH_FILES)) throw new Error('Choose the files to optimise.');
    const prepared = new Map(this.files.map(file => [key(file.path), file]));
    const chosen = [...new Set(files.map(key))].map(file => prepared.get(file));
    if (chosen.some(file => !file)) throw new Error('Only files listed in the batch window can be optimised.');
    const batch = new Batch(chosen as BatchFile[], parseBatchParams(params, folder => path.isAbsolute(folder)), this.options.env());
    this.batch = batch; this.files = []; this.truncated = false;
    batch.on('change', () => this.publishSoon());
    this.publish();
    void batch.run().finally(() => this.publish());
  }

  private current(id: unknown) {
    if (!isId(id) || this.batch?.id !== id) throw new Error('This batch is no longer open.');
    return this.batch;
  }
  cancel(id: unknown) { this.current(id).cancel(); }
  async revert(id: unknown) { const failures = await this.current(id).revert(); this.publish(); return failures; }
  async deleteBackups(id: unknown) { await this.current(id).deleteBackups(); this.publish(); }
  failures(id: unknown) { return this.current(id).failures(); }

  /** Shows a file of the batch, its result or its backup folder in Explorer. Any other path is refused. */
  reveal(file: unknown) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Choose a file of this batch.');
    const known = [...this.files.map(f => f.path), ...(this.batch ? [this.batch.backup.dir, ...this.batch.items.flatMap(item => [item.path, ...(item.result ? [item.result] : [])])] : [])];
    if (!known.some(other => key(other) === key(file))) throw new Error('Choose a file of this batch.');
    this.options.reveal(file);
  }

  /** Empties the window for a new batch. A running batch carries on and stays in the window. */
  clear() {
    if (this.running) throw new Error('Wait for the batch to finish or cancel it first.');
    this.reset(); this.publish();
  }
  private reset() { this.batch?.removeAllListeners(); this.batch = undefined; this.files = []; this.truncated = false; this.aggressive = undefined; }

  /** Stops a running batch, for quitting. */
  stop() { this.batch?.cancel(); if (this.timer) clearTimeout(this.timer); }
}
