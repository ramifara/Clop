import { isReadable, storedId, type Stored, type Unreadable } from './codec';
import { resolveRunnable, type ClopFileType, type Pipeline, type PresetZone } from './model';

// Preset zones (Clop/PresetZones.swift, DropZonePresetsView in Clop/DropZone.swift): while a file is dragged and the preset zone key is
// held (or tapped), the drop zone's own content gives way to a two-by-two grid of zones inside it, each running one pipeline on what is
// dropped on it. Which zones fill the grid, which slot is under the pointer and what a drop on one runs are decided here, apart from the
// DOM, so the window and the tests agree.

export const MAX_TILES = 4;
/** The grid: two columns and two rows inside the drop zone. */
export const TILE = { columns: 2, rows: 2 } as const;

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
 * The slot under a point, relative to the top-left corner of the drop zone, `width` by `height`. Each slot owns its quarter of the
 * zone, margins and gaps included, so a drag between slots or along the zone's edge always has one under it; outside the zone there is none.
 */
export function tileAt(x: number, y: number, width: number, height: number): number | undefined {
  if (!(x >= 0 && y >= 0 && x < width && y < height)) return undefined;
  return Math.floor(y / (height / TILE.rows)) * TILE.columns + Math.floor(x / (width / TILE.columns));
}

/** A zone a drop can run, with the pipeline it runs. */
export interface ZoneTarget { zone: PresetZone; pipeline: Pipeline; /** The one type of file the zone takes, when it or its pipeline has one. */ type?: ClopFileType }

/**
 * The zone `id` and the pipeline a drop on it runs, looked up in the settings as they are now. Refuses, with a message saying what to
 * do, a zone that is gone or one whose pipeline was deleted, cannot be read by this version, or has no steps: a drop on such a zone
 * runs nothing, rather than a plain optimisation the zone was not asked for.
 */
export function zoneTarget(zones: readonly Stored<PresetZone>[], saved: readonly Stored<Pipeline>[], id: unknown): ZoneTarget {
  if (typeof id !== 'string' || !id || id.length > 100) throw new Error('Choose a preset zone.');
  const zone = zones.filter(isReadable).find(entry => entry.id === id);
  if (!zone) throw new Error('That preset zone no longer exists.');
  const pipeline = resolveRunnable(zone.pipeline, saved.filter(isReadable));
  if (!pipeline) {
    const unreadable = saved.find((entry): entry is Unreadable => !isReadable(entry) && storedId(entry) === zone.pipeline.libraryID);
    if (unreadable) throw new Error(`${zone.name} runs a pipeline this version of Clop cannot read (${unreadable.reason}), so nothing was optimised. Fix it or choose another one in the pipeline editor.`);
    throw new Error(`The pipeline ${zone.name} ran was deleted, so nothing was optimised. Choose another one in the pipeline editor.`);
  }
  if (!pipeline.steps.length) throw new Error(`${zone.name} has no pipeline to run. Choose one in the pipeline editor.`);
  const type = zone.type ?? pipeline.fileType;
  return { zone, pipeline, ...(type ? { type } : {}) };
}

/** Whether a zone takes a file of `kind`: a zone (or its pipeline) for one type takes only that type. */
export const zoneTakes = (target: ZoneTarget, kind: ClopFileType) => (target.zone.type ?? kind) === kind && (target.pipeline.fileType ?? kind) === kind;

/** What dropping on zone `id` runs for a file of `kind`; refuses a zone that is gone, cannot run, or is for another type. */
export function zonePipeline(zones: readonly Stored<PresetZone>[], saved: readonly Stored<Pipeline>[], id: unknown, kind: ClopFileType): Pipeline {
  const target = zoneTarget(zones, saved, id), { zone, pipeline } = target;
  if (zone.type && zone.type !== kind) throw new Error(`${zone.name} is for ${zone.type} files.`);
  if (pipeline.fileType && pipeline.fileType !== kind) throw new Error(`${pipeline.name ?? zone.name} works on ${pipeline.fileType} files.`);
  return pipeline;
}
