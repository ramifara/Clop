import { isReadable, type Stored } from './codec';
import { resolveRunnable, type ClopFileType, type Pipeline, type PresetZone } from './model';

// Preset zones (Clop/PresetZones.swift, DropZonePresetsView in Clop/DropZone.swift): while a file is dragged and the preset zone key is
// held (or tapped), the drop zone's own content gives way to a two-by-two grid of zones inside it, each running one pipeline on what is
// dropped on it. Which zones fill the grid, which slot is under the pointer and what a drop on one runs are decided here, apart from the
// DOM, so the window and the tests agree.

export const MAX_TILES = 4;
/** The grid: two columns and two rows filling the drop zone, `gap` CSS pixels between slots (`Grid(horizontalSpacing: 2, verticalSpacing: 2)`). */
export const TILE = { columns: 2, rows: 2, gap: 2 } as const;

export interface PresetTile { id: string; name: string; icon: string; type?: ClopFileType }
export interface TileSet { tiles: PresetTile[] }
/** A slot of the grid: a zone, the slot that adds one (right after the zones, while there is room), or an empty slot. */
export type Slot = { kind: 'zone'; tile: PresetTile } | { kind: 'add' } | { kind: 'empty' };

/** The type every dragged file shares, or undefined when the files differ or one is not a media file (`DragManager.fileType`). */
export function draggedType(files: readonly string[], kindOf: (file: string) => ClopFileType | undefined): ClopFileType | undefined {
  const kinds = new Set(files.map(kindOf));
  return kinds.size === 1 && !kinds.has(undefined) ? [...kinds][0] : undefined;
}

/** A zone that can run: its pipeline exists and has something to do. */
const runnable = (zone: PresetZone, saved: readonly Pipeline[]) => (resolveRunnable(zone.pipeline, saved)?.steps.length ?? 0) > 0;

/**
 * The zones in the grid for a drag of `fileType`, as `cachePresetZones` sorts them: the zones of that type, then the zones for any
 * type, which belong to every type's grid. With no common type only the zones for any type show. Zones that cannot run (their library
 * pipeline is gone) are left out. The grid has four slots, so only the first four show.
 */
export function tilesFor(zones: readonly Stored<PresetZone>[], saved: readonly Stored<Pipeline>[], fileType: ClopFileType | undefined): TileSet {
  const library = saved.filter(isReadable), usable = zones.filter(isReadable).filter(zone => runnable(zone, library));
  const matching = [...usable.filter(zone => zone.type !== undefined && zone.type === fileType), ...usable.filter(zone => zone.type === undefined)];
  return { tiles: matching.slice(0, MAX_TILES).map(({ id, name, icon, type }): PresetTile => ({ id, name, icon, ...(type ? { type } : {}) })) };
}

/** The four slots, in reading order (`zoneView(index:)`): the zones, then "Add preset" at the first free slot, then empty slots. */
export const slotsFor = ({ tiles }: TileSet): Slot[] =>
  Array.from({ length: MAX_TILES }, (_, index): Slot => index < tiles.length ? { kind: 'zone', tile: tiles[index] } : index === tiles.length ? { kind: 'add' } : { kind: 'empty' });

/**
 * The slot under a point, relative to the top-left corner of a grid `width` by `height`. A gap between slots belongs to the slot before
 * it, so a drag that crosses the gap never leaves every slot; outside the grid there is none.
 */
export function tileAt(x: number, y: number, width: number, height: number): number | undefined {
  if (!(x >= 0 && y >= 0 && x < width && y < height)) return undefined;
  const pitchX = (width + TILE.gap) / TILE.columns, pitchY = (height + TILE.gap) / TILE.rows;
  return Math.min(TILE.rows - 1, Math.floor(y / pitchY)) * TILE.columns + Math.min(TILE.columns - 1, Math.floor(x / pitchX));
}

/** What dropping on zone `id` runs for a file of `kind`; refuses a zone that is gone, cannot run, or is for another type. */
export function zonePipeline(zones: readonly Stored<PresetZone>[], saved: readonly Stored<Pipeline>[], id: unknown, kind: ClopFileType): Pipeline {
  if (typeof id !== 'string' || !id || id.length > 100) throw new Error('Choose a preset zone.');
  const zone = zones.filter(isReadable).find(entry => entry.id === id);
  if (!zone) throw new Error('That preset zone no longer exists.');
  if (zone.type && zone.type !== kind) throw new Error(`${zone.name} is for ${zone.type} files.`);
  const pipeline = resolveRunnable(zone.pipeline, saved.filter(isReadable));
  if (!pipeline?.steps.length) throw new Error(`${zone.name} has no pipeline to run. Choose one in the pipeline editor.`);
  if (pipeline.fileType && pipeline.fileType !== kind) throw new Error(`${pipeline.name ?? zone.name} works on ${pipeline.fileType} files.`);
  return pipeline;
}
