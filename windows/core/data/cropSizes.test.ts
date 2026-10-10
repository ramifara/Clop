import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { settingsSchema } from '../settings/schema';
import { DEFAULT_CROP_ASPECT_RATIOS, DEFAULT_CROP_SIZES, groupMatches } from './cropSizes';

const swift = readFileSync(fileURLToPath(new URL('../../../Clop/Settings.swift', import.meta.url)), 'utf8');
const list = (name: string) => {
  const start = swift.indexOf(`let ${name}: [CropSize] = [`);
  assert.ok(start >= 0, name);
  return [...swift.slice(start, swift.indexOf('\n]', start)).matchAll(/CropSize\(width: (\d+), height: (\d+), name: "([^"]+)"(, isAspectRatio: true)?\)/g)]
    .map(([, w, h, name, ratio]) => ({ width: Number(w), height: Number(h), name, longEdge: false, smartCrop: false, ...(ratio ? { isAspectRatio: true } : {}) }));
};

test('the crop size tables match Clop/Settings.swift', () => {
  assert.equal(DEFAULT_CROP_SIZES.length, 8);
  assert.deepEqual(DEFAULT_CROP_SIZES, list('DEFAULT_CROP_SIZES'));
  assert.equal(DEFAULT_CROP_ASPECT_RATIOS.length, 15);
  assert.deepEqual(DEFAULT_CROP_ASPECT_RATIOS, list('DEFAULT_CROP_ASPECT_RATIOS'));
  assert.deepEqual(settingsSchema.savedCropSizes.default, DEFAULT_CROP_SIZES);
});

test('a crop size group matches its name or a member, case-insensitively', () => {
  const group = { name: 'iPhone 13 & 12 mini', width: 1080, height: 2340, members: ['iPhone 13 mini', 'iPhone 12 mini'] };
  assert.ok(groupMatches(group, 'IPHONE 12 MINI'));
  assert.ok(groupMatches(group, 'iphone 13 & 12 mini'));
  assert.ok(!groupMatches(group, 'iPhone 13'));
});
