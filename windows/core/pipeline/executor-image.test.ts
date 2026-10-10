import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { graphic, photo } from '../media/image.fixtures';
import { run } from '../run';
import { pipelineWorkspace } from './executor.fixtures';
import { PipelineStepError } from './executor';

const size = async (file: string) => (await stat(file)).size;
const dims = async (file: string) => { const { width, height } = await sharp(file).metadata(); return [width, height]; };

test('optimise replaces the image in place, keeps the original in the backups and marks the result', async t => {
  const w = await pipelineWorkspace(t, 'pngquant'); if (!w) return;
  const input = w.file('shot.png');
  await graphic(400, 300).png({ compressionLevel: 0 }).toFile(input);
  const before = await size(input);
  const result = await w.run('optimise', input);
  assert.deepEqual([result.file, result.didWork, result.stopped], [input, true, false]);
  assert.ok(await size(input) < before);
  assert.equal((await w.backups()).length, 1);
  assert.equal(await w.marker.isOptimised(input), true);
  assert.deepEqual(await w.temp(), [], 'the run leaves nothing in temp');
});

test('steps that run as one pass leave the original alone and place only the final file', async t => {
  const w = await pipelineWorkspace(t, 'pngquant'); if (!w) return;
  const input = w.file('photo.png');
  await photo(400, 300).png().toFile(input);
  const original = await readFile(input);
  const result = await w.run('crop(width: 100, height: 100) -> convert(to: webp)', input);
  assert.equal(result.file, w.file('photo.webp'));
  assert.deepEqual(await dims(result.file), [100, 100]);
  assert.deepEqual(await readFile(input), original, 'the crop never touched the original');
  assert.equal((await sharp(result.file).metadata()).format, 'webp');
});

test('a location template names a new file, and a convert follows the manual conversion setting', async t => {
  const w = await pipelineWorkspace(t, 'pngquant'); if (!w) return;
  const input = w.file('logo.png');
  await graphic(200, 100).png().toFile(input);
  const half = await w.run('downscale(factor: 0.5, location: "%f-half")', input);
  assert.equal(half.file, w.file('logo-half.png'));
  assert.deepEqual(await dims(half.file), [100, 50]);
  assert.deepEqual(await dims(input), [200, 100]);

  w.settings.manualConvertedImageBehaviour = 'specificFolder';
  const converted = await w.run('convert(to: jpg)', input);
  assert.equal(converted.file, path.join(w.files, 'converted', 'logo.jpeg'));
  const temporary = await w.run('convert(to: webp)', input, { placementOverride: { manualConvert: 'temporary' } });
  assert.ok(w.workdir.owns(temporary.file), 'a request override wins over the setting');
});

test('a crop the image already fits leaves it as it is', async t => {
  const w = await pipelineWorkspace(t); if (!w) return;
  const input = w.file('small.png');
  await graphic(120, 80).png().toFile(input);
  const original = await readFile(input);
  const result = await w.run('crop(longEdge: 500)', input);
  assert.equal(result.file, input);
  assert.deepEqual(await readFile(input), original);
  assert.deepEqual(await w.backups(), []);
});

test('targetSize, stripExif and watermark run on their own', async t => {
  const w = await pipelineWorkspace(t, 'jpegoptim', 'exiftool', 'pngquant'); if (!w) return;
  const input = w.file('holiday.jpg');
  await photo(800, 600).withExif({ IFD0: { Artist: 'Someone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } }).jpeg({ quality: 98 }).toFile(input);
  const fitted = await w.run('targetSize(size: 40KB)', input);
  assert.ok(await size(fitted.file) <= 40_000, `${await size(fitted.file)} bytes`);

  const tags = async () => JSON.parse((await run('exiftool', ['-j', '-GPS:all', '-Artist', input])).stdout.toString())[0];
  await photo(400, 300).withExif({ IFD0: { Artist: 'Someone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } }).jpeg().toFile(input);
  assert.equal((await tags()).Artist, 'Someone');
  await w.run('stripExif', input);
  assert.deepEqual(Object.keys(await tags()), ['SourceFile']);

  await assert.rejects(w.run('stripExif -> watermark(image: "%P/watermark.png")', input), (error: PipelineStepError) => {
    assert.ok(error instanceof PipelineStepError);
    assert.equal(error.step, 1);
    assert.match(error.message, /^Step 2, watermark\(image: "%P\/watermark.png"\), failed: Watermark image not found: .*watermark\.png$/);
    return true;
  });
  await sharp({ create: { width: 60, height: 30, channels: 4, background: '#ff0000ff' } }).png().toFile(w.file('watermark.png'));
  await writeFile(w.file('plain.png'), await sharp({ create: { width: 400, height: 300, channels: 3, background: '#ffffff' } }).png().toBuffer());
  const marked = await w.run('watermark(image: "%P/watermark.png", position: bottomRight, scale: 0.25)', w.file('plain.png'));
  const { data, info } = await sharp(marked.file).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  assert.deepEqual([info.width, info.height], [400, 300]);
  assert.ok(pixel(400 - 20 - 10, 300 - 20 - 10)[0] > 200 && pixel(400 - 20 - 10, 300 - 20 - 10)[1] < 60, 'red in the bottom right corner');
  assert.deepEqual(pixel(10, 10), [255, 255, 255]);
});
