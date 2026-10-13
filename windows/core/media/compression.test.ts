import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cq from './compression';

const at = (factor: number) => ({ tier: 'custom', factor }) as const;

test('factor 30 reproduces the legacy normal preset and 64 the aggressive one', () => {
  assert.equal(cq.jpegMaxQuality(at(30)), 85);
  assert.equal(cq.jpegSecondaryMaxQuality(at(30)), 90);
  assert.equal(cq.pngQuantQuality(at(30)), '0-100');
  assert.equal(cq.pngQuantColors(at(30)), undefined);
  assert.equal(cq.pngQuantSpeed(at(30)), 4);
  assert.deepEqual(cq.gifsicleArgs(at(30)), ['-O2', '--lossy=30']);
  assert.equal(cq.conversionQuality(at(30)), 60);
  assert.deepEqual(cq.gifsicleArgs(at(64)), ['-O3', '--lossy=80', '--colors=202']);
  assert.equal(cq.jpegMaxQuality(at(64)), 58);
  assert.equal(cq.pngQuantQuality(at(64)), '0-64');
  assert.equal(cq.pngQuantSpeed(at(64)), 2);
});

test('the top of the scale follows the steeper curves', () => {
  assert.equal(cq.jpegMaxQuality(at(100)), 18);
  assert.equal(cq.jpegSecondaryMaxQuality(at(100)), 20);
  assert.equal(cq.pngQuantQuality(at(100)), '0-25');
  assert.equal(cq.pngQuantColors(at(80)), 224);
  assert.equal(cq.pngQuantColors(at(100)), 64);
  assert.equal(cq.pngQuantSpeed(at(100)), 1);
  assert.deepEqual(cq.gifsicleArgs(at(100)), ['-O3', '--lossy=2000', '--colors=64']);
  assert.deepEqual(cq.gifsicleArgs(at(71)), ['-O3', '--lossy=99', '--colors=175']);
  assert.equal(cq.conversionQuality(at(100)), 15);
  assert.equal(cq.conversionQuality(at(5)), 73);
});

test('frames are dropped only from factor 80', () => {
  assert.deepEqual([79, 80, 89, 90, 97, 98, 100].map(factor => cq.gifFrameDropEveryNth(at(factor))), [undefined, 4, 4, 3, 3, 2, 2]);
});

test('an explicit aggressive flag picks the anchors, otherwise the setting applies', () => {
  const adaptive = { tier: 'adaptive', factor: 80 } as const;
  assert.deepEqual(cq.effectiveImageCompression(undefined, adaptive), adaptive);
  assert.deepEqual(cq.effectiveImageCompression(true, adaptive), at(64));
  assert.deepEqual(cq.effectiveImageCompression(false, at(90)), at(30));
  assert.equal(cq.imageIsAggressive(adaptive), false);
  assert.equal(cq.imageIsAggressive(at(50)), true);
  assert.equal(cq.imageIsAggressive(at(49)), false);
});
