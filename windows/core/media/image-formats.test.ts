import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { run } from '../run';
import { needTools } from '../testing';
import { optimiseImage } from './image';
import { sniffImage, toPNG } from './image-codecs';
import { graphic, photo } from './image.fixtures';

const at = (factor: number) => ({ tier: 'custom', factor }) as const;
const lossless = { tier: 'lossless', factor: 30 } as const;
async function workspace(t: TestContext) {
  if (!needTools(t, 'jpegoptim', 'pngquant', 'exiftool', 'ffmpeg', 'ffprobe', 'heif-dec', 'heif-enc', 'cjxl', 'djxl')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-formats-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out');
  const file = async (name: string, data: Buffer | Sharp) => { const target = path.join(dir, name); await writeFile(target, Buffer.isBuffer(data) ? data : await data.toBuffer()); return target; };
  return { dir, out, file };
}
/** Decoded through the tools, since sharp reads neither HEVC nor JPEG XL. */
async function decode(file: string, dir: string) {
  return sharp(await toPNG(file, path.join(dir, `${path.basename(file)}-check.png`))).raw().toBuffer({ resolveWithObject: true });
}
/** Mean absolute difference per channel value between two images of the same size. */
async function difference(a: string, b: string, dir: string) {
  const [x, y] = [await decode(a, dir), await decode(b, dir)];
  assert.deepEqual([x.info.width, x.info.height], [y.info.width, y.info.height]);
  let sum = 0;
  for (let i = 0; i < x.data.length; i++) sum += Math.abs(x.data[i] - y.data[i * y.info.channels / x.info.channels | 0]);
  return sum / x.data.length;
}

test('HEIC and JPEG XL round-trip through heif-enc, heif-dec, cjxl and djxl', async t => {
  const w = await workspace(t); if (!w) return;
  const png = await w.file('photo.png', photo(320, 240).png());
  const heic = await optimiseImage(png, w.out, { compression: at(30), format: 'heic', name: 'photo' });
  const jxl = await optimiseImage(png, w.out, { compression: at(30), format: 'jxl', name: 'photo' });
  assert.deepEqual([heic.format, (await sniffImage(heic.path)).format, heic.width, heic.height], ['heic', 'heic', 320, 240]);
  assert.deepEqual([jxl.format, (await sniffImage(jxl.path)).format, jxl.width, jxl.height], ['jxl', 'jxl', 320, 240]);
  assert.ok(await difference(heic.path, png, w.dir) < 6 && await difference(jxl.path, png, w.dir) < 6, 'lossy encodes stay close to the source');
  // Read back: HEIC becomes JPEG as macOS converts it by default; JPEG XL stays JPEG XL.
  const fromHEIC = await optimiseImage(heic.path, w.out, { compression: at(30), name: 'from-heic' });
  assert.deepEqual([fromHEIC.format, fromHEIC.width, fromHEIC.height], ['jpeg', 320, 240]);
  const toPNGAgain = await optimiseImage(jxl.path, w.out, { compression: lossless, format: 'png', name: 'from-jxl' });
  assert.equal(await difference(toPNGAgain.path, jxl.path, w.dir), 0);
  // Lossless encodes keep every pixel.
  const exact = await optimiseImage(png, w.out, { compression: lossless, format: 'jxl', name: 'exact' });
  assert.equal(await difference(exact.path, png, w.dir), 0);
  // A JPEG XL that would grow keeps its bytes.
  const rough = path.join(w.dir, 'rough.jxl');
  await run('cjxl', [png, rough, '-q', '20', '--quiet']);
  const again = await optimiseImage(rough, w.out, { compression: at(30), name: 'again' });
  assert.deepEqual([again.unchanged, again.path, again.format], [true, rough, 'jxl']);
});

test('HEIC and JPEG XL quality follows the compression factor', async t => {
  const w = await workspace(t); if (!w) return;
  const png = await w.file('photo.png', photo(320, 240).png());
  for (const format of ['heic', 'jxl'] as const) {
    const gentle = await optimiseImage(png, w.out, { compression: at(10), format, name: `${format}-10` });
    const harsh = await optimiseImage(png, w.out, { compression: at(90), format, name: `${format}-90` });
    assert.ok(harsh.bytes < gentle.bytes, `${format}: factor 90 gave ${harsh.bytes} bytes, factor 10 ${gentle.bytes}`);
  }
});

test('a HEIC keeps its orientation, transparency and metadata rules when read', async t => {
  const w = await workspace(t); if (!w) return;
  const jpeg = await w.file('turned.jpg', photo(64, 32).withMetadata({ orientation: 6, density: 144 }).withExif({ IFD0: { Artist: 'Someone' } }).jpeg({ quality: 95 }));
  const heic = path.join(w.dir, 'turned.heic');
  await run('heif-enc', ['-q', '90', '-o', heic, jpeg]);
  const stripped = await optimiseImage(heic, w.out, { compression: at(30), name: 'stripped' });
  assert.deepEqual([stripped.width, stripped.height], [32, 64]);
  const { stdout } = await run('exiftool', ['-j', '-n', '-Artist', '-Orientation', '-XResolution', stripped.path]);
  const { SourceFile: _, ...strippedTags } = JSON.parse(stdout.toString())[0];
  assert.deepEqual(strippedTags, { XResolution: 144 });
  const kept = await optimiseImage(heic, w.out, { compression: at(30), stripMetadata: false, name: 'kept' });
  const tags = JSON.parse((await run('exiftool', ['-j', '-n', '-Artist', '-Orientation', kept.path])).stdout.toString())[0];
  assert.deepEqual([tags.Artist, tags.Orientation, kept.width, kept.height], ['Someone', undefined, 32, 64], 'upright pixels carry no rotation');
  const alpha = await w.file('alpha.png', graphic(64, 48, { alpha: true }).png());
  const transparent = path.join(w.dir, 'alpha.heic');
  await run('heif-enc', ['-q', '90', '-o', transparent, alpha]);
  assert.equal((await optimiseImage(transparent, w.out, { compression: at(30), name: 'alpha' })).format, 'png', 'transparency keeps it out of JPEG');
});

test('BMP and SVG inputs are read and converted', async t => {
  const w = await workspace(t); if (!w) return;
  const source = await w.file('graphic.png', graphic(160, 120).png());
  const bmp = path.join(w.dir, 'graphic.bmp');
  await run('ffmpeg', ['-v', 'error', '-i', source, bmp]);
  assert.equal((await sniffImage(bmp)).format, 'bmp');
  const fromBMP = await optimiseImage(bmp, w.out, { compression: at(30), name: 'bmp' });
  assert.deepEqual([fromBMP.format, fromBMP.width, fromBMP.height], ['jpeg', 160, 120]);
  assert.ok(fromBMP.bytes < (await stat(bmp)).size);
  assert.equal(await difference((await optimiseImage(bmp, w.out, { compression: lossless, format: 'png', name: 'bmp-png' })).path, source, w.dir), 0);
  // An SVG is rasterised at its document size.
  const svg = await w.file('shape.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#fff"/><circle cx="150" cy="100" r="80" fill="#36c"/></svg>'));
  const fromSVG = await optimiseImage(svg, w.out, { compression: at(30), name: 'svg' });
  assert.deepEqual([fromSVG.format, fromSVG.width, fromSVG.height], ['png', 300, 200]);
  const { data } = await sharp(fromSVG.path).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data.subarray((100 * 300 + 150) * 3, (100 * 300 + 150) * 3 + 3)], [0x33, 0x66, 0xcc]);
});

// BT.2100 PQ: absolute luminance in nits to a signal value.
function pq(nits: number) {
  const m1 = 2610 / 16384, m2 = (2523 / 4096) * 128, c1 = 3424 / 4096, c2 = (2413 / 4096) * 32, c3 = (2392 / 4096) * 32, y = Math.pow(nits / 10000, m1);
  return Math.pow((c1 + c2 * y) / (1 + c3 * y), m2);
}
/** A 16-bit PNG of grey patches, one per signal value, 16 pixels each. */
function patches(signals: number[]) {
  const width = 16 * signals.length, height = 8, data = new Uint16Array(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(signals[Math.floor((i / 3) % width / 16)] * 65535);
  return sharp(data, { raw: { width, height, channels: 3 } }).toColourspace('rgb16').png();
}
async function patchValues(file: string, count: number) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return Array.from({ length: count }, (_, i) => data[(4 * info.width + 16 * i + 8) * info.channels]);
}

test('PQ and HLG HDR photos are tone-mapped to SDR with SDR white at the reference level', async t => {
  const w = await workspace(t); if (!w) return;
  // Dark, 100 nits, the 203-nit reference white and a 1000-nit highlight.
  const pqSource = await w.file('pq.png', patches([pq(0), pq(100), pq(203), pq(1000)]));
  const pqHEIC = path.join(w.dir, 'pq.heic');
  await run('heif-enc', ['-L', '-b', '10', '--colour_primaries', '9', '--transfer_characteristic', '16', '--matrix_coefficients', '0', '-o', pqHEIC, pqSource]);
  const pqOut = await optimiseImage(pqHEIC, w.out, { compression: lossless, format: 'png', name: 'pq' });
  const [black, hundred, white, highlight] = await patchValues(pqOut.path, 4);
  assert.equal(black, 0);
  // 100 nits is half the reference white in linear light, below the roll-off: sRGB 186.
  assert.ok(Math.abs(hundred - 186) <= 3, `100 nits became ${hundred}`);
  assert.ok(white > 225 && white < highlight && highlight === 255, `reference white ${white}, highlight ${highlight}`);
  // Read as SDR, the PQ signal for 100 nits would be about 130.
  assert.ok(Math.abs(Math.round(pq(100) * 255) - hundred) > 40);

  // HLG at 50 % and 75 % signal: about 51 and 203 nits on a 1000-nit display, with the peak at 100 %.
  const hlgSource = await w.file('hlg.png', patches([0.5, 0.75, 1]));
  const hlgAVIF = path.join(w.dir, 'hlg.avif');
  await run('heif-enc', ['--avif', '-L', '-b', '10', '--colour_primaries', '9', '--transfer_characteristic', '18', '--matrix_coefficients', '0', '-o', hlgAVIF, hlgSource]);
  const hlgOut = await optimiseImage(hlgAVIF, w.out, { compression: lossless, format: 'png', name: 'hlg' });
  const [mid, reference, peak] = await patchValues(hlgOut.path, 3);
  assert.ok(Math.abs(mid - 137) <= 4 && Math.abs(reference - white) <= 4 && peak === 255, `HLG became ${mid}, ${reference}, ${peak}`);

  // An SDR 16-bit PNG passes through as it is.
  const sdr = await w.file('sdr.png', patches([0.5]));
  const sdrOut = await optimiseImage(sdr, w.out, { compression: lossless, format: 'png', name: 'sdr' });
  assert.deepEqual(await patchValues(sdrOut.path, 1), [128]);
});
