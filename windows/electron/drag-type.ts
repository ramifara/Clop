import { scanBatch, type ScanOptions } from '../core/batch/scan';
import type { ClopFileType } from '../core/pipeline/model';
import { draggedType } from '../core/pipeline/zones';
import { splitFolders } from './dropped';

// The file type of a drag, which picks the preset zones the grid shows (`DragManager.fileType` on macOS, which knows no type for a
// folder). Here a dragged folder counts as the supported files inside it, as a drop on a zone does (`planZoneDrop`), so a folder of
// images shows the zones for images, such as "to WebP", as well as those for any type. Looking inside is bounded and asynchronous: the
// grid shows the zones for any type until it is done, and the zones for the type once it is.

/** How many folders and files a drag's folders are looked through for their type, at most. */
export const DRAG_SCAN_ENTRIES = 300;

export interface DragTypeOptions extends Pick<ScanOptions, 'owns' | 'isLocal'> {
  /** The type of a file by its name, or undefined for one Clop cannot take. */
  kindOf: (file: string) => ClopFileType | undefined;
  maxEntries?: number;
}

/**
 * The type every dragged file has, looking inside folders: their supported files (subfolders included, hidden files, links and the
 * `.clopignore-<type>` rules at the top of each folder skipped, cloud-only placeholders left out, at most `maxEntries` entries), with
 * the dragged files themselves. Undefined when they are of several types, when a dragged file is not one Clop takes, or when nothing is.
 * A folder too large to look through whole gets the type of what was looked at; a drop on a zone leaves out files of other types anyway.
 */
export async function dragTypeOf(paths: readonly string[], { kindOf, owns, isLocal, maxEntries = DRAG_SCAN_ENTRIES }: DragTypeOptions): Promise<ClopFileType | undefined> {
  const split = await splitFolders([...paths]);
  if (!split) return undefined;
  if (!split.folders.length) return draggedType(split.files, kindOf);
  const plain = split.files.map(kindOf);
  if (plain.includes(undefined)) return undefined;
  const scanned = await scanBatch(split.folders, { owns, isLocal, maxEntries, limit: maxEntries });
  const kinds = new Set<ClopFileType | undefined>([...plain, ...scanned.files.map(file => file.kind)]);
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

/**
 * The type of the drag under way, for the preset grid. A drag of files gets its type at once, by their names; a drag that may hold a
 * folder is looked through in the background, and `changed` is called when its type is known, unless another drag started or the
 * drag ended meanwhile.
 */
export class DragType {
  private generation = 0;
  private current: ClopFileType | undefined;
  constructor(private readonly options: () => DragTypeOptions, private readonly changed: () => void) {}
  get type() { return this.current; }
  /** A drag of `paths` started. Resolves once its type is known (for tests; the app does not wait). */
  start(paths: readonly string[]): Promise<void> {
    const generation = ++this.generation, options = this.options();
    this.current = draggedType(paths, options.kindOf);
    // Every path named a supported file, or there is nothing: the names said all there is to know.
    if (this.current !== undefined || !paths.length || paths.every(file => options.kindOf(file) !== undefined)) return Promise.resolve();
    return dragTypeOf(paths, options).then(type => {
      if (generation !== this.generation || type === this.current) return;
      this.current = type;
      this.changed();
    }, error => console.warn(`Could not look inside the dragged folders: ${error instanceof Error ? error.message : error}`));
  }
  /** The drag ended: a look still under way is forgotten. */
  end() { this.generation++; this.current = undefined; }
}
