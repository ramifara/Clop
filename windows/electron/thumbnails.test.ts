import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { cardPreviewSize, imageThumbnail } from './thumbnails';

test('a card preview covers the card at twice its size, is never enlarged, and never longer than 2000 px', () => {
  // Landscape and portrait photos: the short side reaches 296 or the long side 392, whichever covers the box.
  assert.deepEqual(cardPreviewSize(4000, 3000), { width: 395, height: 296 });
  assert.deepEqual(cardPreviewSize(3000, 4000), { width: 392, height: 523 });
  assert.deepEqual(cardPreviewSize(2560, 1440), { width: 526, height: 296 });
  // Small images stay as they are.
  assert.deepEqual(cardPreviewSize(100, 100), { width: 100, height: 100 });
  assert.deepEqual(cardPreviewSize(392, 296), { width: 392, height: 296 });
  // A strip keeps its full height up to the long-side cap, so it is never shipped at full size.
  assert.deepEqual(cardPreviewSize(4000, 500), { width: 2000, height: 250 });
  assert.deepEqual(cardPreviewSize(12000, 250), { width: 2000, height: 42 });
  assert.deepEqual(cardPreviewSize(300, 3000), { width: 200, height: 2000 });
});

test('imageThumbnail writes the preview at that size, upright', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-thumb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wide = path.join(dir, 'wide.jpg'), turned = path.join(dir, 'turned.jpg');
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#48c' } }).jpeg().toFile(wide);
  // Stored sideways with an orientation tag: displayed as 900 × 1600.
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#c84' } }).jpeg().withMetadata({ orientation: 6 }).toFile(turned);
  const size = async (dataUrl: string) => { const meta = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).metadata(); return { width: meta.width, height: meta.height }; };
  assert.deepEqual(await size(await imageThumbnail(wide)), { width: 526, height: 296 });
  assert.deepEqual(await size(await imageThumbnail(turned)), { width: 392, height: 697 });
});
