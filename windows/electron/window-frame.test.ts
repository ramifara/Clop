import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { restoredFrame, trackFrame, WindowFrames, type Rect } from './window-frame';

const screen = { x: 0, y: 0, width: 1920, height: 1040 }, right = { x: 1920, y: 0, width: 2560, height: 1400 }, min = { width: 780, height: 520 };

test('a remembered frame opens where it was left, on the display it is on', () => {
  assert.deepEqual(restoredFrame({ x: 100, y: 80, width: 1000, height: 700 }, [screen, right], min), { x: 100, y: 80, width: 1000, height: 700 });
  assert.deepEqual(restoredFrame({ x: 2100, y: 200, width: 1600, height: 900 }, [screen, right], min), { x: 2100, y: 200, width: 1600, height: 900 });
});

test('a frame is kept inside its display and within the window\'s smallest size', () => {
  // Hanging off the bottom right: moved back inside.
  assert.deepEqual(restoredFrame({ x: 1500, y: 800, width: 1000, height: 700 }, [screen], min), { x: 920, y: 340, width: 1000, height: 700 });
  // Larger than the display (it was on a bigger one): made to fit.
  assert.deepEqual(restoredFrame({ x: -50, y: -20, width: 3000, height: 2000 }, [screen], min), { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(restoredFrame({ x: 10, y: 10, width: 300, height: 200 }, [screen], min), { x: 10, y: 10, width: 780, height: 520 });
});

test('nothing is restored from a frame on a display that is gone, or from a damaged record', () => {
  assert.equal(restoredFrame({ x: 2100, y: 200, width: 1600, height: 900 }, [screen], min), undefined, 'the second display was unplugged: open centred');
  assert.equal(restoredFrame({ x: 1900, y: 1000, width: 1000, height: 700 }, [screen], min), undefined, 'only a sliver is on screen');
  for (const bad of [undefined, null, 'frame', [], { x: 1, y: 2, width: 'wide', height: 3 }, { x: NaN, y: 0, width: 900, height: 600 }, { x: 0, y: 0, width: -5, height: 600 }]) assert.equal(restoredFrame(bad, [screen], min), undefined, JSON.stringify(bad));
});

test('frames are saved to their own file and read back at the next start; a damaged file remembers nothing', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-frames-')), file = path.join(dir, 'window-frames.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await new WindowFrames(file).load()).get('crop'), undefined);
  const frames = await new WindowFrames(file, 5).load();
  await frames.remember('crop', { x: 10.4, y: 20, width: 900.6, height: 600 }, { now: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { crop: { x: 10, y: 20, width: 901, height: 600 } });
  assert.deepEqual((await new WindowFrames(file).load()).get('crop'), { x: 10, y: 20, width: 901, height: 600 });
  await writeFile(file, '{ not json');
  assert.equal((await new WindowFrames(file).load()).get('crop'), undefined);
  await writeFile(file, JSON.stringify({ crop: { x: 'left' }, compare: { x: 1, y: 2, width: 3, height: 4 } }));
  const mixed = await new WindowFrames(file).load();
  assert.deepEqual([mixed.get('crop'), mixed.get('compare')], [undefined, { x: 1, y: 2, width: 3, height: 4 }]);
});

test('a tracked window saves its frame as it moves and when it closes, never while minimised', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-frames-')), file = path.join(dir, 'window-frames.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const frames = await new WindowFrames(file, 5).load(), listeners = new Map<string, () => void>();
  let bounds: Rect = { x: 0, y: 0, width: 1020, height: 660 }, minimised = false;
  trackFrame(frames, 'crop', { getNormalBounds: () => bounds, isMinimized: () => minimised, on: (event, listener) => listeners.set(event, listener) });
  bounds = { x: 40, y: 50, width: 1100, height: 700 }; listeners.get('resize')!();
  await new Promise(resolve => setTimeout(resolve, 40));
  await frames.save();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).crop, bounds);
  minimised = true; bounds = { x: -32000, y: -32000, width: 160, height: 28 }; listeners.get('move')!();
  assert.deepEqual(frames.get('crop'), { x: 40, y: 50, width: 1100, height: 700 }, 'a minimised window keeps its frame');
  minimised = false; bounds = { x: 300, y: 200, width: 900, height: 600 }; listeners.get('close')!();
  await frames.save();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).crop, bounds);
});
