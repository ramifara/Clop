import type { MediaKind } from '../core/media/types';
import type { ImportExtra, ItemAutomation, ItemPlacement } from './items';

// Dropped and opened files are placed as macOS places every result that is not the clipboard's (`optimiseItem` in
// OptimisationUtils.swift, then `placeOutput` in ImagePipeline.swift, VideoPipeline.swift, PDFPipeline.swift and AudioPipeline.swift):
// by the `optimised…Behaviour`, `converted…Behaviour` and name-template settings, with the original backed up before a result
// takes its place. The card's Restore and "Revert last optimisations" put it back (`folderPlacement` in electron/automation.ts).

/** A result shown as it is, without optimising: a file a pipeline forked off, or a dropped file Clop optimised already. */
export const AS_IS: ItemAutomation = { skipOptimisation: true, fallback: false, run: async ({ original }) => ({ file: original, anyRan: false, warnings: [] }) };

/**
 * What happens to a copied file, as `handleClipboardChange` in ClopApp.swift decides: a copied video, PDF or audio file Clop optimised
 * already (its xattr there, the marker here) is not optimised again on an automatic copy; only the clipboard's pipelines run on it, out of
 * sight (`pipelines`), and with none it is left alone (`skip`). Anything else is imported (`import`): a manual optimisation and an aggressive
 * one show it unchanged or optimise it as a drop does, and an image is never placed (`Image.fromPasteboard` copies it into Clop's own folder).
 */
export function copiedFilePlan({ kind, marked, aggressive, manual, pipelines }: { kind: MediaKind; marked: boolean; aggressive: boolean; manual: boolean; pipelines: boolean }): 'import' | 'pipelines' | 'skip' {
  if (kind === 'image' || !marked || aggressive || manual) return 'import';
  return pipelines ? 'pipelines' : 'skip';
}

export interface DroppedFileOptions {
  /**
   * Where the file's results go, for the kind its content turns out to be (`folderPlacement`). Undefined leaves them in the shelf: a
   * file Clop owns, such as a result dragged back onto the drop zone, is never written over.
   */
  placement?: (kind: MediaKind) => ItemPlacement | undefined;
  /** The file was optimised by Clop and has not changed since (`hasOptimisationStatusXattr` on macOS). */
  marked: boolean;
  /** A Shift-drop (⌘ on macOS): optimise again even a file that was optimised already. */
  aggressive: boolean;
  /** Dropped on a preset zone, whose pipeline runs on a file that was optimised already, as macOS `skipPipelineLookup` returns it as it is and runs the preset. */
  zone: boolean;
}

/**
 * The import of a dropped or opened file: `base` (the drop zone's or a preset zone's pipelines, chosen once the content is read) with
 * the file's placement. A file that was optimised already and is not dropped with Shift is not optimised a second time, as
 * `optimiseItem` refuses it on macOS: its card shows it unchanged and nothing is written. Pipelines that skip optimisation still run
 * on it (macOS looks them up before that check), and so does a preset zone's pipeline, without optimising first.
 */
export function droppedFileExtra(base: ImportExtra | undefined, { placement, marked, aggressive, zone }: DroppedFileOptions): ImportExtra {
  return {
    ...(base?.signal ? { signal: base.signal } : {}),
    late: kind => {
      const own = { ...(base?.staged ? { staged: base.staged } : {}), ...(base?.automation ? { automation: base.automation } : {}), ...base?.late?.(kind) };
      let automation = own.automation;
      if (marked && !aggressive && !automation?.skipOptimisation) automation = zone && automation ? { ...automation, skipOptimisation: true, fallback: false } : AS_IS;
      const placed = placement?.(kind);
      return { ...own, ...(automation ? { automation } : {}), ...(placed ? { placement: placed } : {}) };
    },
  };
}
