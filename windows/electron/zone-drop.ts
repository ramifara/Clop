import { MAX_BATCH_FILES, type ScanOptions } from '../core/batch/scan';
import type { ClopFileType, Pipeline, PresetZone } from '../core/pipeline/model';
import type { Stored } from '../core/pipeline/codec';
import { zoneTakes, zoneTarget } from '../core/pipeline/zones';
import { expandDroppedFolders, splitFolders } from './dropped';

// A drop on a preset zone (DropZonePresetsViewDelegate.performDrop on macOS) always runs the zone's pipeline on what was dropped.
// macOS hands a dropped folder to optimiseDir, which takes no pipeline, so the zone is ignored there; here a folder becomes the
// files inside it, as on the drop zone, and each of them runs the zone's pipeline as if the files had been dropped on it together.
// A drop on a zone never goes to the batch window.

export interface ZoneDropSettings { presetZones: readonly Stored<PresetZone>[]; savedPipelines: readonly Stored<Pipeline>[] }
export interface ZoneDropPlan {
  /** The files to run the zone's pipeline on: the dropped files, then those found in the folders. */
  files: string[];
  /** One notice for the drop, when something was left out (a folder with nothing in it, files of a type the zone does not take, a limit). */
  notice?: string;
}

/**
 * What a drop of `files` on the zone `id` runs on, by the settings as they are now. Refuses (throws) a zone that cannot run at all, before
 * anything is read. Folders are expanded (`expandDroppedFolders`: recursive, hidden files and `.clopignore-<type>` skipped, cloud
 * placeholders left alone, at most `MAX_BATCH_FILES`), and files of a type the zone does not take (by their extension, `kindOf`) are left
 * out with one notice saying how many and why. A file whose type the name does not tell is kept; its content decides when it is read.
 */
export async function planZoneDrop(settings: ZoneDropSettings, id: unknown, files: unknown, { kindOf, ...scan }: ScanOptions & { kindOf: (file: string) => ClopFileType | undefined }): Promise<ZoneDropPlan> {
  const target = zoneTarget(settings.presetZones, settings.savedPipelines, id);
  if (!await splitFolders(files)) throw new Error('Drop files or folders on a preset zone.');
  const expanded = await expandDroppedFolders(files as string[], scan);
  const taken = expanded.files.filter(file => { const kind = kindOf(file); return kind === undefined || zoneTakes(target, kind); });
  const skipped = expanded.files.length - taken.length, notices = [...expanded.notices];
  if (taken.length > MAX_BATCH_FILES) { notices.push(`Only the first ${MAX_BATCH_FILES.toLocaleString('en-US')} files ran ${target.zone.name}.`); taken.length = MAX_BATCH_FILES; }
  if (skipped) notices.push(`${target.zone.name} runs on ${target.type} files only, so ${skipped} ${skipped === 1 ? 'file of another type was' : 'files of other types were'} skipped.`);
  if (!expanded.files.length && !notices.length) notices.push(`Nothing to run ${target.zone.name} on.`);
  return { files: taken, ...(notices.length ? { notice: notices.join(' ') } : {}) };
}

/**
 * Whether a drop runs pipelines: those attached to the drop zone, which a Shift-drop's explicit aggressive optimisation skips (⌘ on
 * macOS, `wantsPipelineLookup`), or a preset zone's, which always runs; Shift then only makes its optimisation aggressive.
 */
export const dropRunsPipelines = ({ aggressive, zone }: { aggressive: boolean; zone?: unknown }) => zone !== undefined || !aggressive;
