import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A4_RATIO, boxes, leftovers, round, textPDF, workspace } from './pdf.fixtures';
import { cropPDF, cropToAspectRatio, extendPDF, extendToAspectRatio, rotateCropRect, uncropPDF } from './pdfBoxes';

test('crop and extend rects follow the Swift size helpers', () => {
  // A Letter page cropped to A4 keeps its height; a landscape page forced to portrait keeps its height too.
  assert.deepEqual(round(cropToAspectRatio(612, 792, { aspectRatio: A4_RATIO })), { x: 26, y: 0, width: 560, height: 792 });
  assert.deepEqual(round(cropToAspectRatio(792, 612, { aspectRatio: A4_RATIO })), { x: 0, y: 26, width: 792, height: 560 });
  assert.deepEqual(round(cropToAspectRatio(792, 612, { aspectRatio: A4_RATIO, alwaysPortrait: true })), { x: 179.64, y: 0, width: 432.73, height: 612 });
  assert.deepEqual(round(cropToAspectRatio(612, 792, { aspectRatio: A4_RATIO, alwaysLandscape: true })), { x: 0, y: 179.64, width: 612, height: 432.73 });
  assert.deepEqual(round(extendToAspectRatio(612, 792, { aspectRatio: 1 })), { x: -90, y: 0, width: 792, height: 792 });
  assert.deepEqual(round(extendToAspectRatio(612, 792, { aspectRatio: A4_RATIO })), { x: 0, y: -36.77, width: 612, height: 865.54 });
  assert.deepEqual(round(extendToAspectRatio(792, 612, { aspectRatio: 0.5 })), { x: -216, y: 0, width: 1224, height: 612 });
  const r = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  assert.deepEqual(round(rotateCropRect(r, 90)), { x: 0.2, y: 0.6, width: 0.4, height: 0.3 });
  assert.deepEqual(round(rotateCropRect(r, -90)), round(rotateCropRect(r, 270)));
  assert.deepEqual(round(rotateCropRect(rotateCropRect(r, 90), 270)), round(r));
});

test('cropping to A4 sets only the CropBox and uncropping restores the original page', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await w.file('letter.pdf', await textPDF(2));
  const cropped = await cropPDF(input, w.out, { aspectRatio: A4_RATIO });
  assert.equal(cropped.pages, 2);
  for (const { media, crop } of await boxes(cropped.path)) {
    assert.deepEqual(round(media), { x: 0, y: 0, width: 612, height: 792 });
    assert.deepEqual(round(crop), { x: 26, y: 0, width: 560, height: 792 });
  }
  const restored = await uncropPDF(cropped.path, w.out, { name: 'restored' });
  for (const { media, crop } of await boxes(restored.path)) assert.deepEqual(crop, media);

  // A normalised region with a top-left origin, mapped into the unrotated page for a /Rotate 90 page.
  const rotated = await w.file('rotated.pdf', await textPDF(1, { rotate: 90 }));
  const region = await cropPDF(rotated, w.out, { rect: { x: 0, y: 0, width: 0.5, height: 1 } });
  assert.deepEqual(round((await boxes(region.path))[0].crop), { x: 0, y: 0, width: 612, height: 396 });
  assert.deepEqual(await leftovers(w.out), []);
});

test('extending grows the page to the aspect ratio around the visible area', async t => {
  const w = await workspace(t); if (!w) return;
  const square = await extendPDF(await w.file('letter.pdf', await textPDF(1)), w.out, { aspectRatio: 1 });
  const [{ media, crop }] = await boxes(square.path);
  assert.deepEqual(round(media), { x: -90, y: 0, width: 792, height: 792 });
  assert.deepEqual(crop, media);
  // Orientation refers to the displayed page: a portrait page shown landscape grows its displayed width.
  const rotated = await extendPDF(await w.file('rotated.pdf', await textPDF(1, { rotate: 90 })), w.out, { aspectRatio: 0.5 });
  assert.deepEqual(round((await boxes(rotated.path))[0].media), { x: 0, y: -216, width: 612, height: 1224 });
});
