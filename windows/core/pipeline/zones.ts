import { isReadable, type Stored } from './codec';
import { resolveRunnable, type ClopFileType, type Pipeline, type PresetZone } from './model';

// Preset zones (Clop/PresetZones.swift, DropZonePresetsView in Clop/DropZone.swift): while a file is dragged and Ctrl or Alt is
// held, up to four tiles show beside the drop target, each running one pipeline on what is dropped on it. Which tiles show,
// where each one is and what a drop on it runs are decided here, apart from the DOM, so the window and the tests agree.

export const MAX_TILES = 4;
/** The tile grid, in CSS pixels: two columns, rows from the top, `gap` between tiles. */
export const TILE = { columns: 2, width: 96, height: 56, gap: 2 } as const;

export interface PresetTile { id: string; name: string; icon: string; type?: ClopFileType }
export interface TileSet {
  tiles: PresetTile[];
  /** A "new preset" tile follows the zones, as on macOS, while there is room for one. */
  add: boolean;
}

/** The type every dragged file shares, or undefined when the files differ or one is not a media file (`DragManager.fileType`). */
export function draggedType(files: readonly string[], kindOf: (file: string) => ClopFileType | undefined): ClopFileType | undefined {
  const kinds = new Set(files.map(kindOf));
  return kinds.size === 1 && !kinds.has(undefined) ? [...kinds][0] : undefined;
}

/** A zone that can run: its pipeline exists and has something to do. */
const runnable = (zone: PresetZone, saved: readonly Pipeline[]) => (resolveRunnable(zone.pipeline, saved)?.steps.length ?? 0) > 0;

/**
 * The tiles for a drag of `fileType`: zones of that type first, then those for any type (`cachePresetZones`). With no common
 * type only the any-type zones show. Zones that cannot run (their library pipeline is gone) are left out.
 */
export function tilesFor(zones: readonly Stored<PresetZone>[], saved: readonly Stored<Pipeline>[], fileType: ClopFileType | undefined): TileSet {
  const library = saved.filter(isReadable), usable = zones.filter(isReadable).filter(zone => runnable(zone, library));
  const matching = [...usable.filter(zone => zone.type !== undefined && zone.type === fileType), ...usable.filter(zone => zone.type === undefined)];
  const tiles = matching.slice(0, MAX_TILES).map(({ id, name, icon, type }): PresetTile => ({ id, name, icon, ...(type ? { type } : {}) }));
  return { tiles, add: tiles.length < MAX_TILES };
}

export const cellCount = ({ tiles, add }: TileSet) => tiles.length + (add ? 1 : 0);
/** The height of the grid for `cells` tiles. */
export const gridHeight = (cells: number) => cells <= 0 ? 0 : Math.ceil(cells / TILE.columns) * (TILE.height + TILE.gap) - TILE.gap;

/** The top-left corner of cell `index` in the grid. */
export const tileOrigin = (index: number) => ({ x: (index % TILE.columns) * (TILE.width + TILE.gap), y: Math.floor(index / TILE.columns) * (TILE.height + TILE.gap) });

/**
 * The cell under a point, relative to the grid's top-left corner. A gap between tiles belongs to the tile before it, so
 * a drag that crosses the gap never leaves every tile; outside the grid, or on an empty cell, there is none.
 */
export function tileAt(x: number, y: number, cells: number): number | undefined {
  const pitchX = TILE.width + TILE.gap, pitchY = TILE.height + TILE.gap;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= TILE.columns * pitchX || y >= Math.ceil(cells / TILE.columns) * pitchY) return undefined;
  const index = Math.floor(y / pitchY) * TILE.columns + Math.floor(x / pitchX);
  return index < cells ? index : undefined;
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
