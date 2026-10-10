import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULT_CROP_ASPECT_RATIOS, DEFAULT_CROP_SIZES } from '../data/cropSizes';
import { cropGeometry } from '../media/crop-size';
import { defaultSettings } from '../settings/schema';
import { batchCrop, flipped, pdfAspectRatio, withOrientation } from './crop';
import { defaultBatchParams, parseBatchParams, type BatchParams } from './spec';

const parse = (value: unknown) => parseBatchParams(value, folder => path.isAbsolute(folder));
const ratio = (name: string) => DEFAULT_CROP_ASPECT_RATIOS.find(size => size.name === name)!;
const preset = (name: string) => DEFAULT_CROP_SIZES.find(size => size.name === name)!;

test('the default batch optimises each file as the settings would', () => {
  const settings = { ...defaultSettings(), pdfDPI: 150, capVideoFPS: true, targetVideoFPS: 30, videoCompression: { tier: 'custom' as const, factor: 70 } };
  const params = defaultBatchParams(settings);
  assert.deepEqual(params.output, { location: 'inPlace' });
  assert.deepEqual([params.image.compression, params.image.adaptive, params.video.encoder, params.video.compression, params.video.fps, params.pdf.dpi, params.audio.compression, params.audio.coverArt],
    [30, false, 'smaller', 70, 30, 150, 35, 'optimise']);
  assert.equal(defaultBatchParams({ ...settings, pdfDPI: 0, capVideoFPS: false, imageCompression: { tier: 'adaptive', factor: 30 } }).pdf.dpi, 'adaptive');
  assert.equal(defaultBatchParams({ ...settings, targetVideoFPS: -2 }).video.fps, undefined, 'half the source rate stays with the settings');
  assert.equal(defaultBatchParams({ ...settings, imageCompression: { tier: 'adaptive', factor: 30 } }).image.adaptive, true);
  assert.equal(defaultBatchParams(settings, true).aggressive, true);
});

test('batch parameters from the renderer round-trip and lose unknown fields', () => {
  const params: BatchParams = {
    ...defaultBatchParams(defaultSettings()), aggressive: true,
    output: { location: 'folder', folder: path.resolve('/tmp/out'), template: '%f-small' },
    image: { compression: 50, adaptive: true, convert: 'webp', downscale: 0.5, crop: batchCrop(ratio('16:9'), 'adaptive'), allowLarger: false },
    pdf: { dpi: 'stepDown', crop: batchCrop(ratio('A4'), 'portrait') },
  };
  assert.deepEqual(parse({ ...params, extra: 1, image: { ...params.image, extra: true } }), params);
  assert.deepEqual(parse({ ...params, output: { location: 'sameFolder', template: '%f-optimised', folder: 'ignored' } }).output, { location: 'sameFolder', template: '%f-optimised' });
});

test('invalid batch parameters are refused with a reason', () => {
  const base = defaultBatchParams(defaultSettings());
  const cases: [unknown, RegExp][] = [
    [undefined, /parameters/], [{ ...base, image: { ...base.image, compression: 101 } }, /image compression/], [{ ...base, image: { ...base.image, convert: 'bmp' } }, /image format/],
    [{ ...base, image: { ...base.image, downscale: 1.5 } }, /downscale/], [{ ...base, video: { ...base.video, encoder: 'nvenc' } }, /encoder/],
    [{ ...base, pdf: { dpi: 123 } }, /PDF resolution/], [{ ...base, pdf: { dpi: 'adaptive', crop: { width: 1920, height: 1080 } } }, /aspect ratio/],
    [{ ...base, audio: { ...base.audio, format: 'aiff' } }, /audio format/], [{ ...base, audio: { ...base.audio, loudnorm: -10 } }, /loudness/],
    [{ ...base, output: { location: 'folder', folder: 'relative', template: '%f' } }, /folder/], [{ ...base, output: { location: 'sameFolder', template: ' ' } }, /name template/],
    [{ ...base, output: { location: 'temporary' } }, /save location/], [{ ...base, image: { ...base.image, crop: { width: 0, height: 0 } } }, /crop size/],
  ];
  for (const [value, reason] of cases) assert.throws(() => parse(value), reason, JSON.stringify(value)?.slice(0, 120));
});

test('crop presets take the chosen orientation as BatchCropButton applies them', () => {
  assert.deepEqual(flipped(ratio('16:9')), { ...ratio('16:9'), width: 9, height: 16, name: '9:16' });
  assert.deepEqual(withOrientation(ratio('16:9'), 'portrait'), { ...ratio('16:9'), width: 9, height: 16, name: '9:16', longEdge: false });
  assert.deepEqual(withOrientation(ratio('A4'), 'landscape'), { ...ratio('A4'), width: 297, height: 210, longEdge: false });
  assert.deepEqual(withOrientation(ratio('4:3'), 'adaptive'), { ...ratio('4:3'), longEdge: true });
  // Exact sizes are cut as they are; only their sides follow the orientation.
  assert.deepEqual(batchCrop(preset('1080p'), 'portrait'), { width: 1080, height: 1920 });
  assert.deepEqual(batchCrop(preset('1080p'), 'adaptive'), { width: 1920, height: 1080 });
  assert.deepEqual(batchCrop(ratio('16:9'), 'adaptive'), { width: 16, height: 9, longEdge: true, isAspectRatio: true });
  // An adaptive ratio follows each image: a portrait photo gets a portrait 16:9 crop.
  assert.deepEqual([cropGeometry(batchCrop(ratio('16:9'), 'adaptive'), 900, 1600).width, cropGeometry(batchCrop(ratio('16:9'), 'adaptive'), 1600, 1200).height], [900, 900]);
  assert.equal(pdfAspectRatio(batchCrop(ratio('A4'), 'adaptive')), 210 / 297);
  assert.equal(pdfAspectRatio(batchCrop(ratio('A4'), 'landscape')), 297 / 210);
});
