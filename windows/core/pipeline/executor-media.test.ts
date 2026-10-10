import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { audioMetadata } from '../media/audio';
import { tone } from '../media/audio.fixtures';
import { probe } from '../media/detect';
import { photoPDF, textPDF } from '../media/pdf.fixtures';
import { clip } from '../media/video.fixtures';
import { run } from '../run';
import { pipelineWorkspace } from './executor.fixtures';

const size = async (file: string) => (await stat(file)).size;
const video = async (file: string) => { const info = await probe(file); assert.equal(info.kind, 'video'); return info as Extract<typeof info, { kind: 'video' }>; };

test('video: a speed change, audio removal and optimisation run as one pass', async t => {
  const w = await pipelineWorkspace(t, 'ffmpeg', 'ffprobe'); if (!w) return;
  const input = await clip(w.file('talk.mp4'), { seconds: 1 });
  const result = await w.run('changeSpeed(factor: 2.0) -> removeAudio -> optimise(encoder: slowHighQuality)', input);
  const info = await video(result.file);
  assert.equal(result.file, input);
  assert.equal(info.hasAudio, false);
  assert.ok(Math.abs(info.durationMs! - 500) < 80, `${info.durationMs} ms`);
  assert.equal((await w.backups()).length, 1, 'one pass, one replacement');
});

test('video: GIF, frame rate cap, watermark and target size', async t => {
  const w = await pipelineWorkspace(t, 'ffmpeg', 'ffprobe', 'gifski'); if (!w) return;
  const input = await clip(w.file('demo.mp4'), { width: 320, height: 240, seconds: 1, fps: 30 });
  const gif = await w.run('crop(longEdge: 160) -> convert(to: gif)', input);
  assert.equal(gif.file, w.file('demo.gif'));
  const meta = await sharp(gif.file, { animated: true }).metadata();
  assert.equal(meta.format, 'gif');
  assert.ok((meta.pages ?? 1) > 1);
  // As on macOS, the crop is a step of its own (gifski is not part of an ffmpeg pass), so it resizes the source in place.
  assert.equal((await video(input)).width, 160);
  assert.equal((await w.backups()).length, 1);

  await w.run('capFps(fps: 10)', input);
  assert.ok(Math.abs((await video(input)).fps! - 10) < 0.5);

  await sharp({ create: { width: 64, height: 32, channels: 4, background: '#00ff00ff' } }).png().toFile(w.file('mark.png'));
  const marked = await w.run('watermark(image: "%P/mark.png", position: topLeft, location: "%f-marked")', input);
  assert.equal(marked.file, w.file('demo-marked.mp4'));
  const frame = w.file('frame.png');
  await run('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-i', marked.file, '-frames:v', '1', frame]);
  const { data, info } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
  const at = (25 * info.width + 25) * info.channels;
  assert.ok(data[at + 1] > 180 && data[at] < 80, 'green in the top left corner');

  const big = await clip(w.file('big.mp4'), { width: 320, height: 240, seconds: 1 });
  assert.ok(await size(big) > 60_000);
  const fitted = await w.run('targetSize(size: 60KB)', big);
  assert.ok(await size(fitted.file) <= 60_000, `${await size(fitted.file)} bytes`);
});

test('audio: convert, lower the bitrate, normalise and change speed', async t => {
  const w = await pipelineWorkspace(t, 'ffmpeg', 'ffprobe'); if (!w) return;
  const wav = await tone(w.file('quiet.wav'), { volume: -25 });
  const mp3 = await w.run('convert(to: mp3)', wav);
  assert.equal(mp3.file, w.file('quiet.mp3'));
  assert.equal((await audioMetadata(mp3.file)).codec, 'mp3');

  const m4a = await tone(w.file('song.m4a'), { codec: ['-c:a', 'aac', '-b:a', '192k'] });
  await w.run('lowerBitrate(kbps: 64)', m4a);
  assert.ok((await audioMetadata(m4a)).bitrate! < 80_000);

  // WAV is in formatsToConvertToMP3, so the normalised file is an MP3 in its place.
  const normalised = await w.run('normalize(lufs: -16)', wav);
  assert.equal(normalised.file, w.file('quiet.mp3'));
  const { stderr } = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', normalised.file, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
  const loudness = Number(JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)).input_i);
  assert.ok(Math.abs(loudness + 16) < 2, `${loudness} LUFS`);

  const fast = await w.run('changeSpeed(factor: 2)', m4a);
  assert.equal(fast.file, m4a, 'the result keeps the name');
  assert.ok(Math.abs((await audioMetadata(m4a)).durationMs! - 1000) < 80);
});

test('pdf: optimise, fit under a size and extract pages', async t => {
  const w = await pipelineWorkspace(t, 'gs', 'jpegoptim', 'pngquant'); if (!w) return;
  const input = w.file('scan.pdf');
  await writeFile(input, await photoPDF({ pages: 2, dpi: 285 }));
  const before = await size(input);
  await w.run('optimise(encoder: aggressive)', input);
  assert.ok(await size(input) < before);

  await writeFile(input, await photoPDF({ pages: 2, dpi: 285 }));
  const fitted = await w.run('targetSize(size: 60KB)', input);
  assert.ok(await size(fitted.file) <= 60_000, `${await size(fitted.file)} of ${before} bytes`);

  const doc = w.file('doc.pdf');
  await writeFile(doc, await textPDF(2));
  const pages = await w.run('extractPagesAsImages(format: png, quality: low, location: temporaryFolder)', doc);
  assert.equal(pages.file, doc, 'a document of several pages carries on as the PDF');
  assert.deepEqual(pages.pages.map(page => path.basename(page)), ['doc-page1.png', 'doc-page2.png']);
  assert.ok(pages.pages.every(page => w.workdir.owns(page)));
  assert.deepEqual((await sharp(pages.pages[0]).metadata()).width, 612);

  const single = w.file('one.pdf');
  await writeFile(single, await textPDF(1));
  const image = await w.run('extractPagesAsImages', single);
  assert.equal(image.file, w.file('one-page1.jpg'), 'a one-page PDF carries on as its image');
  assert.equal((await readFile(image.file)).subarray(0, 2).toString('hex'), 'ffd8');
});
