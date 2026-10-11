import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Batch, type BatchEnv } from '../core/batch/engine';
import { BatchBackup } from '../core/batch/backup';
import { MAX_BATCH_ENTRIES, MAX_BATCH_FILES, scanBatch, type BatchFile } from '../core/batch/scan';
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
  /** Whether a file's content is on this computer rather than a cloud placeholder; those are left out of a batch. */
  isLocal?: (file: string) => Promise<boolean>;
  native?: boolean;
}

const isPathList = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= max && value.every(item => typeof item === 'string' && item.length < 32_768 && path.isAbsolute(item));
const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const key = (file: string) => { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };

export class BatchHost {
  private files: BatchFile[] = [];
  private scans = 0;
  /** Scans run one after another, so overlapping drops each add to the files the last one left. */
  private scanning: Promise<void> = Promise.resolve();
  /** Moves on when the window is emptied, so a scan that was already reading finds nothing to add to. */
  private generation = 0;
  private truncated = false;
  private entriesCapped = false;
  private cloud = 0;
  private aggressive?: boolean;
  private batch?: Batch;
  /** A drop onto a finished batch that can still be reverted, or a request to open an earlier batch over prepared files, waiting for the window to say it should replace them. */
  private pending?: { files: string[]; aggressive?: boolean } | { reopen: string };
  /** The newest earlier batch that can still be reverted, which the window can open again. */
  private previous?: { id: string; files: number };
  /** Folders the user picked in the folder chooser; results go only to these, never to a path the window names on its own. */
  private readonly chosen = new Set<string>();
  private timer?: NodeJS.Timeout;
  constructor(private options: BatchHostOptions) {}

  state(): BatchViewState {
    const settings = this.options.settings();
    return {
      files: this.files, scanning: this.scans > 0, notices: this.notices(), batch: this.batch?.snapshot(), native: this.options.native ?? true,
      ...(this.pending && 'files' in this.pending ? { pendingAdd: this.pending.files.length } : {}), ...(this.pending && 'reopen' in this.pending ? { pendingReopen: this.files.length } : {}), ...(this.previous ? { previous: this.previous } : {}),
      defaults: defaultBatchParams(settings, this.aggressive), cropSizes: settings.savedCropSizes,
      audioFormats: BATCH_AUDIO_FORMATS.map(format => { const spec = AUDIO_FORMATS[format]; return { format, name: spec.name, lossless: spec.lossless, coverArt: spec.coverArt, ...(spec.bitrateRange ? { bitrates: spec.bitrateRange } : {}) }; }),
    };
  }
  private notices() {
    const notices: string[] = [];
    if (this.truncated) notices.push(`Only the first ${MAX_BATCH_FILES.toLocaleString('en-US')} files were added.`);
    if (this.entriesCapped) notices.push(`Clop stopped looking after ${MAX_BATCH_ENTRIES.toLocaleString('en-US')} folders and files. Drop smaller folders to add the rest.`);
    if (this.cloud) notices.push(`${this.cloud} ${this.cloud === 1 ? 'file that is' : 'files that are'} only in the cloud ${this.cloud === 1 ? 'was' : 'were'} skipped, since reading ${this.cloud === 1 ? 'it' : 'them'} would download ${this.cloud === 1 ? 'it' : 'them'}.`);
    return notices;
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

  /**
   * Adds files and folders to the batch being prepared. After a batch ran, they start a new one; when that batch can still
   * be reverted the window is asked first (`pendingAdd`), and `confirmAdd` or `cancelAdd` answers. Refused while a batch runs.
   */
  async add(files: unknown, aggressive?: boolean) {
    this.options.show();
    if (this.running) throw new Error('A batch is running. Wait for it to finish or cancel it before adding files.');
    if (!isPathList(files, MAX_BATCH_FILES)) throw new Error(`Drop up to ${MAX_BATCH_FILES} files and folders at a time.`);
    if (this.batch?.revertable) { this.pending = { files, aggressive }; this.publish(); return; }
    await this.scan(files, aggressive);
  }

  /**
   * Answers yes to what the window was asked: replaces the finished batch with the files of the drop that asked (it stays on
   * disk and can be opened again, see `previous`), or opens the earlier batch over the prepared files.
   */
  async confirmAdd() {
    const pending = this.pending;
    if (!pending) throw new Error('Nothing is waiting to be added.');
    if (this.running) throw new Error('A batch is running. Wait for it to finish or cancel it before adding files.');
    this.pending = undefined;
    if ('reopen' in pending) await this.open(pending.reopen);
    else await this.scan(pending.files, pending.aggressive);
  }
  cancelAdd() { this.pending = undefined; this.publish(); }

  private async scan(files: string[], aggressive?: boolean) {
    if (this.batch) this.reset();
    if (aggressive !== undefined) this.aggressive = aggressive || undefined;
    const generation = this.generation;
    this.scans++; this.publish();
    const job = this.scanning.then(async () => {
      await this.findPrevious();
      if (generation !== this.generation) return;
      const found = await scanBatch(files, { owns: this.options.owns, limit: MAX_BATCH_FILES, isLocal: this.options.isLocal });
      if (generation !== this.generation) return;
      const known = new Set(this.files.map(file => key(file.path))), merged = [...this.files, ...found.files.filter(file => !known.has(key(file.path)))];
      this.files = merged.slice(0, MAX_BATCH_FILES);
      this.truncated ||= found.truncated || merged.length > MAX_BATCH_FILES;
      this.entriesCapped ||= found.entriesCapped; this.cloud += found.cloud;
    });
    this.scanning = job.catch(() => {});
    try { await job; } finally { this.scans--; this.publish(); }
  }

  private async findPrevious() {
    const latest = await BatchBackup.latest(this.options.env().workdir, this.batch?.id, this.options.env().platform).catch(() => undefined);
    this.previous = latest && { id: latest.id, files: latest.results };
  }

  /** Opens an earlier batch again from its manifest, so its originals can be given back. Prepared files or a batch in the window are only given up once the window confirms (`confirmAdd`). */
  async reopen(id: unknown) {
    if (this.running) throw new Error('Wait for the batch to finish or cancel it first.');
    if (this.scans) throw new Error('Wait until the files are read first.');
    if (!isId(id) || this.previous?.id !== id) throw new Error('That batch is no longer available.');
    if (this.files.length || this.batch?.revertable) { this.pending = { reopen: id }; this.publish(); return; }
    await this.open(id);
  }

  private async open(id: string) {
    if (this.running) throw new Error('Wait for the batch to finish or cancel it first.');
    if (this.scans) throw new Error('Wait until the files are read first.');
    if (this.previous?.id !== id) throw new Error('That batch is no longer available.');
    const batch = await Batch.restore(id, this.options.env());
    if (!batch) throw new Error('That batch is no longer available.');
    this.reset();
    this.batch = batch; this.previous = undefined;
    batch.on('change', () => this.publishSoon());
    this.publish();
  }

  /** Starts the prepared files named in `request.files` with `request.params` (`beginProcessing`). */
  async start(request: unknown) {
    if (this.running) throw new Error('A batch is already running.');
    if (this.scans) throw new Error('The files are still being read. Start once they are listed.');
    const { files, params } = (typeof request === 'object' && request !== null ? request : {}) as { files?: unknown; params?: unknown };
    if (!isPathList(files, MAX_BATCH_FILES)) throw new Error('Choose the files to optimise.');
    const prepared = new Map(this.files.map(file => [key(file.path), file]));
    const chosen = [...new Set(files.map(key))].map(file => prepared.get(file));
    if (chosen.some(file => !file)) throw new Error('Only files listed in the batch window can be optimised.');
    const parsed = parseBatchParams(params, folder => path.isAbsolute(folder));
    if (parsed.output.location === 'folder' && !this.chosen.has(key(parsed.output.folder))) throw new Error('Choose the folder for the results with the folder button first.');
    const batch = new Batch(chosen as BatchFile[], parsed, this.options.env());
    this.batch = batch; this.files = []; this.truncated = this.entriesCapped = false; this.cloud = 0;
    batch.on('change', () => this.publishSoon());
    this.publish();
    void batch.run().finally(() => this.publish());
  }

  /** Asks `pick` for a results folder and remembers what it returns: the only folders a batch may save into. */
  async chooseFolder(pick: () => Promise<string | undefined>) {
    const folder = await pick();
    if (folder && path.isAbsolute(folder)) this.chosen.add(key(folder));
    return folder;
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
  async clear() {
    if (this.running) throw new Error('Wait for the batch to finish or cancel it first.');
    this.reset();
    await this.findPrevious();
    this.publish();
  }
  private reset() {
    this.batch?.removeAllListeners(); this.batch = undefined; this.files = []; this.pending = undefined; this.generation++;
    this.truncated = this.entriesCapped = false; this.cloud = 0; this.aggressive = undefined;
  }

  /**
   * Stops a running batch, for quitting. Resolves once its files have settled, since a file being placed finishes
   * (an original moved to the backups must not be left without its result); there is nothing to wait for otherwise.
   */
  stop(): Promise<void> | undefined {
    if (this.timer) clearTimeout(this.timer);
    const batch = this.batch;
    if (!batch) return undefined;
    batch.cancel();
    return batch.phase === 'running' ? batch.run().catch(() => {}) : undefined;
  }
}
