import type { BatchFailure, BatchSnapshot } from '../../core/batch/engine';
import type { BatchFile } from '../../core/batch/scan';
import type { BatchParams } from '../../core/batch/spec';
import type { CropSize } from '../../core/settings/schema';

export type { BatchFailure, BatchFile, BatchParams, BatchSnapshot };
/** An output format the audio card offers, with the bitrates it takes. */
export interface AudioFormatOption { format: NonNullable<BatchParams['audio']['format']>; name: string; lossless: boolean; coverArt: boolean; bitrates?: { lo: number; hi: number } }
/**
 * What the batch window shows: the files being prepared (`files`), or the batch that ran (`batch`). `defaults` seeds the
 * parameter cards from the settings, `cropSizes` are the saved crop sizes, and `truncated` says a drop held more files than a batch takes.
 */
export interface BatchViewState {
  files: BatchFile[]; scanning: boolean; truncated: boolean; batch?: BatchSnapshot;
  defaults: BatchParams; cropSizes: CropSize[]; audioFormats: AudioFormatOption[]; native: boolean;
}
/** The batch window's narrow API (`window.clopBatch`). Files are only ever paths the main process listed itself. */
export interface BatchApi {
  state(): Promise<BatchViewState>; subscribe(callback: (state: BatchViewState) => void): () => void;
  /** Adds dropped files and folders to the batch being prepared, or starts a new one. */
  add(files: File[]): Promise<void>;
  /** Starts optimising `files` (a selection of the prepared ones) with `params`. */
  start(files: string[], params: BatchParams): Promise<void>;
  cancel(id: string): Promise<void>;
  /** Gives back the batch's originals; resolves with a message for each file that could not be reverted. */
  revert(id: string): Promise<string[]>;
  deleteBackups(id: string): Promise<void>;
  failures(id: string): Promise<BatchFailure[]>;
  reveal(file: string): Promise<void>;
  /** A folder for results, or undefined when the dialog was cancelled. */
  chooseFolder(): Promise<string | undefined>;
  /** Empties the window for a new batch. */
  clear(): Promise<void>;
  close(): Promise<void>;
}
declare global { interface Window { clopBatch?: BatchApi } }
