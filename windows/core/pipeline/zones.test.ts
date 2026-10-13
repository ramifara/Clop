import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePipelines, decodePresetZones } from './codec';
import { referenceTo, type Pipeline, type PresetZone } from './model';
import { parseSteps } from './parser';
import { MAX_TILES, draggedType, slotsFor, tileAt, tilesFor, zonePipeline } from './zones';

const pipeline = (id: string, text: string, fileType?: Pipeline['fileType']): Pipeline => ({ id, name: id, steps: parseSteps(text), skipOptimisation: false, hideResult: false, fileType });
const library = [pipeline('WEBP', 'convert(to: webp)', 'image'), pipeline('HALF', 'downscale(factor: 0.5)'), pipeline('MP3', 'convert(to: mp3)', 'audio')];
const zone = (id: string, type: PresetZone['type'], saved: Pipeline): PresetZone => ({ id, name: id, icon: 'photo', type, pipeline: referenceTo(saved) });

test('a drag has a type when every file shares one', () => {
  const kind = (file: string) => ({ png: 'image', jpg: 'image', mp4: 'video' } as const)[file.split('.').pop()!];
  assert.equal(draggedType(['a.png', 'b.jpg'], kind), 'image');
  assert.equal(draggedType(['a.png', 'b.mp4'], kind), undefined);
  assert.equal(draggedType(['a.png', 'notes.txt'], kind), undefined, 'a file Clop does not handle means no type');
  assert.equal(draggedType([], kind), undefined);
});

test('the grid holds the zones for the dragged type followed by those for any type, the first four of them (cachePresetZones)', () => {
  const zones = [zone('ANY1', undefined, library[1]), zone('IMG1', 'image', library[0]), zone('AUD', 'audio', library[2]), zone('IMG2', 'image', library[1]), zone('ANY2', undefined, library[1]), zone('IMG3', 'image', library[1])];
  const names = (type: Parameters<typeof tilesFor>[2]) => tilesFor(zones, library, type).tiles.map(tile => tile.id);
  assert.deepEqual(names('image'), ['IMG1', 'IMG2', 'IMG3', 'ANY1'], 'image zones first, cut at four');
  assert.deepEqual(names('audio'), ['AUD', 'ANY1', 'ANY2'], 'no image zone leaks into an audio drag');
  assert.deepEqual(names('video'), ['ANY1', 'ANY2']);
  assert.deepEqual(names(undefined), ['ANY1', 'ANY2'], 'with no common type only the zones for any type show');
  assert.deepEqual(tilesFor([], library, 'video'), { tiles: [] });
  assert.equal(MAX_TILES, 4);
});

test('four slots: the zones, then one slot that adds a zone, then empty slots (zoneView)', () => {
  const tiles = (count: number) => ({ tiles: Array.from({ length: count }, (_, i) => ({ id: `Z${i}`, name: `Z${i}`, icon: 'x' })) });
  const kinds = (count: number) => slotsFor(tiles(count)).map(slot => slot.kind);
  assert.deepEqual(kinds(0), ['add', 'empty', 'empty', 'empty']);
  assert.deepEqual(kinds(2), ['zone', 'zone', 'add', 'empty']);
  assert.deepEqual(kinds(4), ['zone', 'zone', 'zone', 'zone'], 'a full grid has no add slot');
  assert.deepEqual(slotsFor(tiles(4)).map(slot => slot.kind === 'zone' && slot.tile.id), ['Z0', 'Z1', 'Z2', 'Z3']);
});

test('a zone that cannot run has no tile: its pipeline is deleted, unreadable, or has no steps', () => {
  const unreadable = decodePresetZones([{ id: 'NEW', name: 'x', icon: 'x', pipeline: { id: 'P', steps: [{ teleport: {} }] } }]);
  const saved = [...library, ...decodePipelines([{ id: 'FUTURE', name: 'f', steps: [{ teleport: {} }] }])!];
  const zones = [zone('GONE', 'image', pipeline('DELETED', 'optimise')), zone('FUTURE', 'image', pipeline('FUTURE', 'optimise')), { ...zone('EMPTY', 'image', library[1]), pipeline: { id: 'E', steps: [], skipOptimisation: false, hideResult: false } }, zone('OK', 'image', library[0]), ...unreadable!];
  assert.deepEqual(tilesFor(zones, saved, 'image').tiles.map(tile => tile.id), ['OK']);
});

test('the grid sits in the drop zone in two rows of two, and every point of the zone finds its slot, margins and gaps included', () => {
  // The drop zone is 196 by 148; each slot owns a quarter of it.
  const hit = (x: number, y: number) => tileAt(x, y, 196, 148);
  assert.deepEqual([hit(0, 0), hit(97, 73), hit(98, 0), hit(0, 74), hit(195, 147)], [0, 0, 1, 2, 3]);
  assert.deepEqual([hit(2, 2), hit(194, 2), hit(2, 146)], [0, 1, 2], 'the margin around the slots belongs to the nearest one');
  for (const [x, y] of [[-1, 5], [5, -1], [196, 5], [5, 148], [NaN, 0], [0, Infinity]]) assert.equal(hit(x, y), undefined, `${x}, ${y} is outside`);
  assert.equal(tileAt(5, 5, 0, 0), undefined, 'no grid, no slot');
});

test('dropping on a zone runs its pipeline; a zone that is gone, for another type, or empty is refused', () => {
  const zones = [zone('IMG', 'image', library[0]), zone('ANY', undefined, library[1]), zone('TYPED-ANY', undefined, library[0]), zone('GONE', 'image', pipeline('DELETED', 'optimise'))];
  assert.equal(zonePipeline(zones, library, 'IMG', 'image').id, 'WEBP');
  assert.equal(zonePipeline(zones, library, 'ANY', 'video').id, 'HALF', 'a zone for any type takes any file');
  assert.throws(() => zonePipeline(zones, library, 'IMG', 'video'), /IMG is for image files/);
  assert.throws(() => zonePipeline(zones, library, 'TYPED-ANY', 'video'), /works on image files/);
  assert.throws(() => zonePipeline(zones, library, 'GONE', 'image'), /no pipeline to run/);
  assert.throws(() => zonePipeline(zones, library, 'NOPE', 'image'), /no longer exists/);
  for (const bad of [undefined, 7, '', 'x'.repeat(101), {}]) assert.throws(() => zonePipeline(zones, library, bad, 'image'), /Choose a preset zone/);
});

test('a dragged folder has no common type, so only the any-type zones show for it', () => {
  const kindOf = (file: string) => file.endsWith('.png') ? 'image' as const : undefined;
  assert.equal(draggedType(['C:\\Photos'], kindOf), undefined);
  assert.equal(draggedType(['C:\\Photos', 'C:\\a.png'], kindOf), undefined);
});
