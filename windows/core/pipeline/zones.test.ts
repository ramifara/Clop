import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePipelines, decodePresetZones } from './codec';
import { referenceTo, type Pipeline, type PresetZone } from './model';
import { parseSteps } from './parser';
import { MAX_TILES, TILE, cellCount, draggedType, gridHeight, tileAt, tileOrigin, tilesFor, zonePipeline } from './zones';

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

test('tiles are the zones for the dragged type, then those for any type, at most four, with an add tile while there is room', () => {
  const zones = [zone('ANY1', undefined, library[1]), zone('IMG1', 'image', library[0]), zone('AUD', 'audio', library[2]), zone('IMG2', 'image', library[1]), zone('ANY2', undefined, library[1]), zone('IMG3', 'image', library[1])];
  const names = (type: Parameters<typeof tilesFor>[2]) => tilesFor(zones, library, type).tiles.map(tile => tile.id);
  assert.deepEqual(names('image'), ['IMG1', 'IMG2', 'IMG3', 'ANY1'], 'image zones first, cut at four');
  assert.equal(tilesFor(zones, library, 'image').add, false);
  assert.deepEqual(names('audio'), ['AUD', 'ANY1', 'ANY2']);
  assert.equal(tilesFor(zones, library, 'audio').add, true);
  assert.deepEqual(names(undefined), ['ANY1', 'ANY2'], 'with no common type only the zones for any type show');
  assert.deepEqual(tilesFor([], library, 'video'), { tiles: [], add: true });
  assert.equal(MAX_TILES, 4);
});

test('a zone that cannot run has no tile: its pipeline is deleted, unreadable, or has no steps', () => {
  const unreadable = decodePresetZones([{ id: 'NEW', name: 'x', icon: 'x', pipeline: { id: 'P', steps: [{ teleport: {} }] } }]);
  const saved = [...library, ...decodePipelines([{ id: 'FUTURE', name: 'f', steps: [{ teleport: {} }] }])!];
  const zones = [zone('GONE', 'image', pipeline('DELETED', 'optimise')), zone('FUTURE', 'image', pipeline('FUTURE', 'optimise')), { ...zone('EMPTY', 'image', library[1]), pipeline: { id: 'E', steps: [], skipOptimisation: false, hideResult: false } }, zone('OK', 'image', library[0]), ...unreadable!];
  assert.deepEqual(tilesFor(zones, saved, 'image').tiles.map(tile => tile.id), ['OK']);
});

test('cells sit in two columns and a point finds its cell, gaps included', () => {
  assert.equal(cellCount({ tiles: [], add: true }), 1);
  assert.deepEqual([tileOrigin(0), tileOrigin(1), tileOrigin(2), tileOrigin(3)], [{ x: 0, y: 0 }, { x: 98, y: 0 }, { x: 0, y: 58 }, { x: 98, y: 58 }]);
  assert.deepEqual([gridHeight(0), gridHeight(1), gridHeight(2), gridHeight(3), gridHeight(4)], [0, 56, 56, 114, 114]);
  const hit = (x: number, y: number, cells = 4) => tileAt(x, y, cells);
  assert.deepEqual([hit(0, 0), hit(95, 55), hit(98, 0), hit(97, 10), hit(10, 60), hit(150, 100)], [0, 0, 1, 0, 2, 3], 'the gap after a tile belongs to it');
  assert.equal(hit(-1, 5), undefined);
  assert.equal(hit(5, -1), undefined);
  assert.equal(hit(2 * (TILE.width + TILE.gap), 5), undefined, 'right of the grid');
  assert.equal(hit(5, 2 * (TILE.height + TILE.gap)), undefined, 'below the grid');
  assert.equal(hit(100, 70, 3), undefined, 'the empty fourth cell');
  assert.equal(hit(10, 70, 3), 2);
  assert.equal(hit(10, 10, 0), undefined);
  assert.equal(hit(NaN, 0), undefined);
  for (let cell = 0; cell < 4; cell++) { const { x, y } = tileOrigin(cell); assert.equal(hit(x + TILE.width / 2, y + TILE.height / 2), cell); }
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
