import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centeredMaxRect, extendedCanvas, FULL, evenSide, handlePoint, keptSize, marquee, moved, oriented, reorientedAspect, resized, sizedRect, targetSize, toBox, toRect, type Box } from './crop-geometry';

const view = { width: 400, height: 200 };
const close = (actual: Record<string, number>, expected: Record<string, number>) => {
  for (const key of Object.keys(expected)) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-6, `${key}: ${actual[key]} ≠ ${expected[key]}`);
};

test('maps relative selections to view pixels and back, clamped inside the frame', () => {
  assert.deepEqual(toBox({ x: .25, y: .5, width: .5, height: .25 }, view), { x: 100, y: 100, width: 200, height: 50 });
  assert.deepEqual(toRect({ x: 100, y: 100, width: 200, height: 50 }, view), { x: .25, y: .5, width: .5, height: .25 });
  close(toRect({ x: 350, y: -10, width: 100, height: 300 }, view), { x: .75, y: 0, width: .25, height: 1 });
  assert.deepEqual(handlePoint('bottomRight', { x: 10, y: 20, width: 30, height: 40 }), { x: 40, y: 60 });
  assert.deepEqual(handlePoint('top', { x: 10, y: 20, width: 30, height: 40 }), { x: 25, y: 20 });
  assert.deepEqual(handlePoint('left', { x: 10, y: 20, width: 30, height: 40 }), { x: 10, y: 40 });
});

test('moves a selection without leaving the view', () => {
  const start: Box = { x: 100, y: 50, width: 100, height: 100 };
  assert.deepEqual(moved(start, 20, -10, view), { x: 120, y: 40, width: 100, height: 100 });
  assert.deepEqual(moved(start, 1000, 1000, view), { x: 300, y: 100, width: 100, height: 100 });
  assert.deepEqual(moved(start, -1000, -1000, view), { x: 0, y: 0, width: 100, height: 100 });
});

test('resizes from a handle around the opposite side, keeping a locked aspect and the view bounds', () => {
  const start: Box = { x: 100, y: 50, width: 100, height: 100 };
  // A free corner follows the pointer and keeps the opposite corner.
  assert.deepEqual(resized(start, 'bottomRight', 40, 20, view), { x: 100, y: 50, width: 140, height: 120 });
  assert.deepEqual(resized(start, 'topLeft', -40, -20, view), { x: 60, y: 30, width: 140, height: 120 });
  // Edges keep their centre line; growing past the view stops at its edge, shrinking at 24 pixels.
  assert.deepEqual(resized(start, 'right', 500, 0, view), { x: 100, y: 50, width: 300, height: 100 });
  assert.deepEqual(resized(start, 'left', 500, 0, view), { x: 176, y: 50, width: 24, height: 100 });
  assert.deepEqual(resized(start, 'top', 0, -100, view), { x: 100, y: 0, width: 100, height: 150 });
  // A locked aspect follows the dominant axis, and a horizontal edge grows the width symmetrically.
  assert.deepEqual(resized(start, 'bottomRight', 60, 10, view, 2), { x: 100, y: 50, width: 160, height: 80 });
  assert.deepEqual(resized(start, 'bottomRight', 10, 40, view, 1), { x: 100, y: 50, width: 140, height: 140 });
  const bottom = resized(start, 'bottom', 0, 40, view, 1);
  assert.deepEqual(bottom, { x: 80, y: 50, width: 140, height: 140 });
  // Room runs out on one axis: both sides shrink to keep the aspect.
  assert.deepEqual(resized(start, 'bottomRight', 300, 300, view, 1), { x: 100, y: 50, width: 150, height: 150 });
});

test('draws a new selection by marquee, at the locked aspect, ignoring tiny drags', () => {
  assert.deepEqual(marquee({ x: 50, y: 50 }, { x: 150, y: 100 }, view), { x: 50, y: 50, width: 100, height: 50 });
  assert.deepEqual(marquee({ x: 150, y: 100 }, { x: 50, y: 50 }, view), { x: 50, y: 50, width: 100, height: 50 });
  assert.deepEqual(marquee({ x: 50, y: 50 }, { x: 150, y: 60 }, view, 1), { x: 50, y: 50, width: 100, height: 100 });
  assert.deepEqual(marquee({ x: 350, y: 150 }, { x: 450, y: 250 }, view), { x: 350, y: 150, width: 50, height: 50 });
  assert.equal(marquee({ x: 50, y: 50 }, { x: 55, y: 90 }, view), undefined);
  // At an edge both sides shrink together, so a locked square stays square (view is 400 × 200).
  assert.deepEqual(marquee({ x: 350, y: 100 }, { x: 450, y: 200 }, view, 1), { x: 350, y: 100, width: 50, height: 50 });
  assert.deepEqual(marquee({ x: 100, y: 150 }, { x: 40, y: 230 }, view, 1), { x: 50, y: 150, width: 50, height: 50 });
});

test('fits presets: centred largest regions, orientations, typed sizes and the result size', () => {
  close(centeredMaxRect(1, { width: 400, height: 200 }), { x: .25, y: 0, width: .5, height: 1 });
  close(centeredMaxRect(4, { width: 400, height: 200 }), { x: 0, y: .25, width: 1, height: .5 });
  assert.deepEqual(oriented({ width: 16, height: 9 }, 'portrait', view), { width: 9, height: 16 });
  assert.deepEqual(oriented({ width: 9, height: 16 }, 'landscape', view), { width: 16, height: 9 });
  assert.deepEqual(oriented({ width: 9, height: 16 }, 'adaptive', view), { width: 16, height: 9 });
  assert.deepEqual(oriented({ width: 16, height: 9 }, 'adaptive', { width: 100, height: 300 }), { width: 9, height: 16 });
  // A preset's size is the output while the selection is at least that big.
  assert.deepEqual(targetSize(FULL, { width: 2000, height: 1000 }, { width: 1280, height: 720 }), { width: 1280, height: 720 });
  assert.deepEqual(targetSize({ x: 0, y: 0, width: .5, height: .5 }, { width: 2000, height: 1000 }, { width: 1280, height: 720 }), { width: 1000, height: 500 });
  // Typed dimensions resize around the centre, following a locked aspect.
  close(sizedRect({ x: .25, y: .25, width: .5, height: .5 }, { width: 1000, height: 1000 }, { width: 200, height: 500 }, 'width'), { x: .4, y: .25, width: .2, height: .5 });
  close(sizedRect({ x: .25, y: .25, width: .5, height: .5 }, { width: 1000, height: 1000 }, { width: 200, height: 500 }, 'width', 1), { x: .4, y: .4, width: .2, height: .2 });
  // Extending a landscape page to 1:2 doubles its width; a portrait one grows taller.
  assert.deepEqual(extendedCanvas({ width: 300, height: 300 }, .5, 'landscape'), { width: 600, height: 300 });
  assert.deepEqual(extendedCanvas({ width: 300, height: 300 }, .5, 'portrait'), { width: 300, height: 600 });
});

test('a cropped result is downscaled from the area its crop keeps', () => {
  assert.deepEqual(keptSize(undefined, 400, 200), { width: 400, height: 200 });
  assert.deepEqual(keptSize({ width: 200, height: 200, name: '', longEdge: false, smartCrop: false }, 400, 200), { width: 200, height: 200 });
  assert.deepEqual(keptSize({ width: 300, height: 300, name: '', longEdge: false, smartCrop: false, cropRect: { x: 0, y: 0, width: .5, height: 1 } }, 400, 200), { width: 200, height: 200 });
  assert.deepEqual(keptSize({ width: 0, height: 0, name: '', longEdge: false, smartCrop: false }, 400, 200), { width: 400, height: 200 });
});

test('rounds a side to an even size without passing the limit', () => {
  assert.deepEqual([evenSide(201), evenSide(200), evenSide(199.6), evenSide(1)], [202, 200, 200, 2]);
  assert.deepEqual([evenSide(16382), evenSide(16383), evenSide(16384), evenSide(20000)], [16382, 16382, 16382, 16382]);
});

test('going back to adaptive turns the preset to the page\'s own orientation', () => {
  const portrait = { width: 612, height: 792 }, a4 = { width: 297, height: 210 };
  assert.equal(reorientedAspect(297 / 210, 'portrait', portrait), 210 / 297, 'a forced orientation turns the locked aspect');
  assert.equal(reorientedAspect(210 / 297, 'landscape', portrait), 297 / 210);
  assert.equal(reorientedAspect(297 / 210, 'adaptive', portrait, a4), 210 / 297, 'adaptive on a portrait page is portrait again');
  assert.equal(reorientedAspect(210 / 297, 'adaptive', { width: 792, height: 612 }, a4), 297 / 210);
  assert.equal(reorientedAspect(1.4, 'adaptive', portrait), undefined, 'no preset to return to');
});
