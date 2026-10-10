import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computedSize, cropGeometry, pixelRect } from './crop-size';

test('exact sizes fill around the centre, or the attention region with smart crop', () => {
  assert.deepEqual(cropGeometry({ width: 1920, height: 1080 }, 4000, 3000), { width: 1920, height: 1080, fill: 'centre' });
  assert.deepEqual(cropGeometry({ width: 128, height: 128, smartCrop: true }, 4000, 3000), { width: 128, height: 128, fill: 'attention' });
});

test('long edge and single-side sizes scale, rounding to even pixels as Swift does', () => {
  assert.deepEqual(computedSize({ width: 1000, height: 0, longEdge: true }, 4000, 3000), { width: 1000, height: 750 });
  assert.deepEqual(computedSize({ width: 1000, height: 0, longEdge: true }, 3000, 4000), { width: 750, height: 1000 });
  assert.deepEqual(computedSize({ width: 0, height: 500 }, 4000, 3000), { width: 668, height: 500 });
  assert.deepEqual(computedSize({ width: 333, height: 0 }, 1000, 1000), { width: 334, height: 334 });
});

test('aspect ratios cut the largest centred region, in their own orientation unless long edge', () => {
  assert.deepEqual(computedSize({ width: 16, height: 9, isAspectRatio: true }, 4000, 3000), { width: 4000, height: 2250 });
  assert.deepEqual(computedSize({ width: 9, height: 16, isAspectRatio: true }, 4000, 3000), { width: 1687.5, height: 3000 });
  assert.deepEqual(cropGeometry({ width: 9, height: 16, isAspectRatio: true }, 4000, 3000), { width: 1688, height: 3000, fill: 'centre' });
  // Long edge follows the image: a portrait photo gets a portrait 16:9 cut.
  assert.deepEqual(computedSize({ width: 16, height: 9, isAspectRatio: true, longEdge: true }, 3000, 4000), { width: 2250, height: 4000 });
  assert.deepEqual(computedSize({ width: 1, height: 1, isAspectRatio: true }, 3000, 4000), { width: 3000, height: 3000 });
});

test('relative rectangles become clamped pixel crops, scaled down only to the size', () => {
  const quarter = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  assert.deepEqual(cropGeometry({ width: 1000, height: 750, cropRect: quarter }, 4000, 3000), { crop: { left: 1000, top: 750, width: 2000, height: 1500 }, width: 1000, height: 750 });
  assert.deepEqual(cropGeometry({ width: 4000, height: 3000, cropRect: quarter }, 4000, 3000), { crop: { left: 1000, top: 750, width: 2000, height: 1500 }, width: 2000, height: 1500 });
  assert.deepEqual(pixelRect({ x: 0.9, y: -1, width: 0.5, height: 2 }, 100, 50), { left: 50, top: 0, width: 50, height: 50 });
  // A full-frame rectangle is no crop: the size applies as usual.
  assert.deepEqual(cropGeometry({ width: 200, height: 100, cropRect: { x: 0, y: 0, width: 1, height: 1 } }, 400, 200), { width: 200, height: 100, fill: 'centre' });
  assert.throws(() => cropGeometry({ width: 0, height: 0 }, 400, 200), /width or a height/);
});
