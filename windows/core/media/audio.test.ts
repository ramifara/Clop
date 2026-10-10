import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../run';
import { needTools } from '../testing';
import type { ToolName } from '../tools';
import { audioMetadata, changeAudioSpeed, convertAudio, downscaleAudioCoverArt, extractAudioCoverArt, lowerAudioBitrate, optimiseAudio } from './audio';
import { coverImage, tone } from './audio.fixtures';
import { probe, type AudioInfo } from './detect';
import { ffprobe, probeNumber } from './ffprobe';
import { atempoChain } from './video';

async function workspace(t: TestContext, ...tools: ToolName[]) {
  if (!needTools(t, 'ffmpeg', 'ffprobe', ...tools)) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-audio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { file: (name: string) => path.join(dir, name), out: path.join(dir, 'out') };
}
async function audio(file: string) {
  const info = await probe(file);
  assert.equal(info.kind, 'audio');
  return info as AudioInfo;
}
const streams = async (file: string) => (await ffprobe(file)).streams;
const art = async (file: string) => (await streams(file)).find(s => s.disposition?.attached_pic === 1);
const size = async (file: string) => (await stat(file)).size;
const mp3 = (kbps: number) => ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`];
const near = (actual: number | undefined, expected: number, tolerance: number, what: string) => assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected} ± ${tolerance}`);

test('an MP3 is re-encoded at the bitrate the compression factor maps to, with progress', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await tone(w.file('song.mp3'), { codec: mp3(320) });
  const when = new Date(2024, 1, 2, 3, 4, 5); await utimes(input, when, when);
  const progress: number[] = [];
  const output = await optimiseAudio(input, w.out, { onProgress: f => progress.push(f) });
  assert.deepEqual([output.path, output.format, output.bitrate, output.unchanged], [path.join(w.out, 'song.mp3'), 'mp3', 192, undefined]);
  assert.ok(output.bytes < await size(input) && output.bytes === await size(output.path));
  near(output.durationMs, 2000, 60, 'duration');
  assert.ok(progress.length >= 2 && progress.every((f, i) => f > 0 && f <= 1 && (i === 0 || f >= progress[i - 1])), `progress rises to 1: ${progress.join(' ')}`);
  assert.equal(progress.at(-1), 1);
  assert.equal((await stat(output.path)).mtimeMs, when.getTime(), 'the modification date is kept');
  assert.deepEqual(await readdir(w.out), ['song.mp3'], 'temporary files are removed');
});

test('formats listed in the settings become AAC or MP3; others keep their format', async t => {
  const w = await workspace(t); if (!w) return;
  const wav = await tone(w.file('take.wav')), flac = await tone(w.file('album.flac'));
  const opus = await tone(w.file('voice.ogg'), { codec: ['-c:a', 'libopus', '-b:a', '128k'] });
  const results = await Promise.all([optimiseAudio(wav, w.out), optimiseAudio(flac, w.out), optimiseAudio(opus, w.out, { compression: { tier: 'custom', factor: 100 } })]);
  assert.deepEqual(results.map(r => [path.basename(r.path), r.format, r.bitrate]), [['take.mp3', 'mp3', 192], ['album.m4a', 'm4a', 192], ['voice.ogg', 'ogg', 32]]);
  assert.deepEqual(await Promise.all(results.map(async r => (await audio(r.path)).codec)), ['mp3', 'aac', 'opus']);
  // Without a conversion, WAV stays 16-bit PCM and a high sample rate drops to 48 kHz.
  const hiRes = await tone(w.file('master.wav'), { sampleRate: 96000, codec: ['-c:a', 'pcm_s24le'] });
  const kept = await optimiseAudio(hiRes, w.out, { formatsToConvertToMP3: [] });
  const info = await audio(kept.path);
  assert.deepEqual([path.basename(kept.path), info.codec, info.sampleRate, kept.bitrate], ['master.wav', 'pcm_s16le', 48000, undefined]);
});

test('aggressive goes a bitrate step below the input; a result that is not smaller keeps the input', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await tone(w.file('aac.m4a'), { codec: ['-c:a', 'aac', '-b:a', '192k'] });
  const inputKbps = Math.trunc((await audio(input)).bitrate! / 1000);
  assert.ok(inputKbps >= 160 && inputKbps < 192, `fixture bitrate ${inputKbps}`);
  const normal = await optimiseAudio(input, w.out, { name: 'normal' });
  const aggressive = await optimiseAudio(input, w.out, { name: 'aggressive', aggressive: true });
  assert.deepEqual([normal.bitrate, aggressive.bitrate], [160, 128]);
  assert.ok(aggressive.bytes < normal.bytes && normal.bytes < await size(input), `${aggressive.bytes} < ${normal.bytes}`);

  const wav = await tone(w.file('pcm.wav'));
  const same = await optimiseAudio(wav, w.out, { formatsToConvertToMP3: [], allowLarger: true });
  assert.deepEqual(same, { path: wav, bytes: await size(wav), format: 'wav', durationMs: same.durationMs, bitrate: same.bitrate, unchanged: true }, 'the same format never grows, even when larger is allowed');
  const adpcm = await optimiseAudio(wav, w.out, { formatsToConvertToMP3: [], aggressive: true });
  assert.equal((await audio(adpcm.path)).codec, 'adpcm_ima_wav');
  assert.ok(adpcm.bytes < (await size(wav)) / 3);

  const small = await tone(w.file('small.mp3'), { codec: mp3(64) });
  const larger = await optimiseAudio(small, w.out, { format: 'wav' });
  assert.equal(larger.unchanged, true, 'a larger conversion keeps the input');
  const allowed = await optimiseAudio(small, w.out, { format: 'wav', allowLarger: true });
  assert.deepEqual([path.basename(allowed.path), allowed.unchanged], ['small.wav', undefined]);
  assert.ok(allowed.bytes > await size(small));
});

test('lowering the bitrate snaps below the input and keeps the input when it would not go lower', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await tone(w.file('song.mp3'), { codec: mp3(320) });
  const byKbps = await lowerAudioBitrate(input, w.out, { kbps: 130 }, { name: 'kbps' });
  const byFactor = await lowerAudioBitrate(input, w.out, { factor: 0.5 }, { name: 'factor' });
  assert.deepEqual([byKbps.bitrate, byFactor.bitrate], [128, 160]);
  assert.ok(byKbps.bytes < byFactor.bytes && byFactor.bytes < await size(input));
  const noop = await lowerAudioBitrate(input, w.out, { kbps: 400 });
  assert.deepEqual([noop.path, noop.unchanged, noop.bitrate], [input, true, 320]);
});

test('speed changes chain atempo filters and scale the duration', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await tone(w.file('talk.m4a'), { codec: ['-c:a', 'aac'] });
  const progress: number[] = [];
  const fast = await changeAudioSpeed(input, w.out, 2, { onProgress: f => progress.push(f) });
  const slow = await changeAudioSpeed(input, w.out, 0.25);
  assert.deepEqual([path.basename(fast.path), path.basename(slow.path)], ['talk-speed2.0x.m4a', 'talk-speed0.25x.m4a']);
  near(fast.durationMs, 1000, 60, 'double speed');
  near(slow.durationMs, 8000, 100, 'quarter speed');
  assert.equal(progress.at(-1), 1);
  await assert.rejects(changeAudioSpeed(input, w.out, 0), /above 0/);
});

test('MP3 and Ogg Opus keep their codec through chained speed changes and report the bitrate they got', async t => {
  const w = await workspace(t); if (!w) return;
  const cases = [['song.mp3', mp3(192), 0.25, 'mp3', 8000], ['voice.ogg', ['-c:a', 'libopus', '-b:a', '96k'], 0.4, 'opus', 5000]] as const;
  // Below 0.5 atempo needs a chain: 0.25 is two halvings, 0.4 a halving and 0.8.
  assert.deepEqual(cases.map(([, , factor]) => atempoChain(factor)), ['atempo=0.5,atempo=0.5', 'atempo=0.5,atempo=0.8']);
  for (const [name, codec, factor, expected, durationMs] of cases) {
    const output = await changeAudioSpeed(await tone(w.file(name), { codec: [...codec] }), w.out, factor);
    const info = await audio(output.path);
    assert.equal(info.codec, expected, name);
    near(output.durationMs, durationMs, 100, name);
    assert.ok(output.bitrate && output.bitrate === Math.trunc((await audioMetadata(output.path)).bitrate! / 1000), `${name} reports its probed bitrate ${output.bitrate}`);
  }
});

test('the audio bitrate leaves out embedded cover art when the stream states none', async t => {
  const w = await workspace(t); if (!w) return;
  const cover = await coverImage(w.file('big.jpg'), 1500, 1500);
  const [bare, withArt] = [await tone(w.file('bare.flac')), await tone(w.file('art.flac'), { cover })];
  const [plain, measured, container] = [(await audioMetadata(bare)).bitrate!, (await audioMetadata(withArt)).bitrate!, (await audio(withArt)).bitrate!];
  near(measured, plain, plain * 0.05, 'FLAC with art');
  assert.ok(container > plain * 2, `the container bitrate ${container} counts the art`);
  const mp3WithArt = await tone(w.file('art.mp3'), { codec: mp3(320), cover });
  assert.equal((await audioMetadata(mp3WithArt)).bitrate, 320000, 'MP3 states its own bitrate');
});

test('converts to every format with its encoder', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await tone(w.file('source.wav'));
  const expected = { aac: ['m4a', 'aac', 192], mp3: ['mp3', 'mp3', 192], opus: ['ogg', 'opus', 128], flac: ['flac', 'flac', undefined], wav: ['wav', 'pcm_s16le', undefined], aiff: ['aiff', 'pcm_s16be', undefined] } as const;
  for (const [format, [ext, codec, bitrate]] of Object.entries(expected)) {
    const output = await convertAudio(input, w.out, format as keyof typeof expected);
    assert.deepEqual([output.format, (await audio(output.path)).codec, output.bitrate], [ext, codec, bitrate], format);
    near(output.durationMs, 2000, 60, format);
  }
  const beside = await convertAudio(input, path.dirname(input), 'wav');
  assert.equal(path.basename(beside.path), 'source-optimised.wav', 'a result never overwrites its input');
});

test('loudness normalisation reaches the target and keeps the sample rate', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await tone(w.file('quiet.m4a'), { volume: -25, codec: ['-c:a', 'aac', '-b:a', '192k'] });
  const output = await optimiseAudio(input, w.out, { loudnorm: -16, allowLarger: true });
  const { stderr } = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', output.path, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
  const measured = Number(JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)).input_i);
  near(measured, -16, 2, 'integrated loudness');
  assert.equal((await audio(output.path)).sampleRate, 44100);
});

test('a loudness change is kept even when the file does not get smaller', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await tone(w.file('quiet.wav'), { volume: -25 });
  const output = await optimiseAudio(input, w.out, { loudnorm: -16, formatsToConvertToMP3: [] });
  assert.equal(output.unchanged, undefined);
  assert.equal(output.format, 'wav');
  const { stderr } = await run('ffmpeg', ['-nostdin', '-hide_banner', '-i', output.path, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
  near(Number(JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)).input_i), -16, 2, 'integrated loudness');
});

test('cover art is optimised, kept, removed or dropped by format', async t => {
  const w = await workspace(t, 'jpegoptim', 'pngquant'); if (!w) return;
  const cover = await coverImage(w.file('cover.jpg'), 800, 800);
  const input = await tone(w.file('song.mp3'), { codec: mp3(320), cover });
  const optimised = await optimiseAudio(input, w.out, { name: 'optimised' });
  const extracted = await extractAudioCoverArt(optimised.path, w.out);
  assert.deepEqual([extracted.format, extracted.width, extracted.height], ['jpeg', 800, 800]);
  assert.ok(extracted.bytes < await size(cover), `cover ${extracted.bytes} < ${await size(cover)}`);

  const kept = await optimiseAudio(input, w.out, { name: 'kept', coverArt: 'keep' });
  assert.ok((await readFile((await extractAudioCoverArt(kept.path, w.out, { name: 'kept-cover' })).path)).equals(await readFile(cover)), 'kept art is byte for byte the original');
  assert.equal((await art(kept.path))?.codec_name, 'mjpeg');
  const removed = await optimiseAudio(input, w.out, { name: 'removed', coverArt: 'remove' });
  const opus = await optimiseAudio(input, w.out, { name: 'opus', format: 'opus' });
  for (const output of [removed, opus]) assert.deepEqual((await streams(output.path)).map(s => s.codec_type), ['audio'], output.path);

  const m4a = await tone(w.file('song.m4a'), { codec: ['-c:a', 'aac', '-b:a', '256k'], cover });
  assert.equal((await art((await optimiseAudio(m4a, w.out, { coverArt: 'keep' })).path))?.codec_name, 'mjpeg', 'M4A keeps its art too');
});

test('photographic PNG art becomes JPEG when smaller; flat PNG art is quantized', async t => {
  const w = await workspace(t, 'jpegoptim', 'pngquant'); if (!w) return;
  const photo = await tone(w.file('photo.flac'), { cover: await coverImage(w.file('photo.png'), 400, 400) });
  const flatCover = await coverImage(w.file('flat.png'), 400, 400, { photo: false });
  const flat = await tone(w.file('flat.flac'), { cover: flatCover });
  const results = await Promise.all([optimiseAudio(photo, w.out, { format: 'flac' }), optimiseAudio(flat, w.out, { format: 'flac' })]);
  const [photoArt, flatPicture] = await Promise.all(results.map(r => art(r.path)));
  assert.deepEqual([photoArt?.codec_name, flatPicture?.codec_name, flatPicture?.pix_fmt], ['mjpeg', 'png', 'pal8']);
  const flatArt = await extractAudioCoverArt(results[1].path, w.out);
  assert.ok(flatArt.bytes <= await size(flatCover), `${flatArt.bytes} <= ${await size(flatCover)}`);
});

test('cover art can be squared and capped at a long edge', async t => {
  const w = await workspace(t, 'jpegoptim', 'pngquant'); if (!w) return;
  const landscape = await tone(w.file('landscape.mp3'), { codec: mp3(128), cover: await coverImage(w.file('wide.jpg'), 900, 600) });
  const portrait = await tone(w.file('portrait.mp3'), { codec: mp3(128), cover: await coverImage(w.file('tall.jpg'), 600, 900) });
  const dims = async (input: string, name: string, options: Parameters<typeof optimiseAudio>[2]) => {
    const output = await optimiseAudio(input, w.out, { name, allowLarger: true, ...options });
    const picture = await art(output.path);
    return [picture?.width, picture?.height];
  };
  assert.deepEqual(await dims(landscape, 'a', { coverArtSquaring: 'landscapeOnly', coverArtMaxLongEdge: 300 }), [300, 300]);
  assert.deepEqual(await dims(portrait, 'b', { coverArtSquaring: 'landscapeOnly', coverArtMaxLongEdge: 300 }), [200, 300]);
  assert.deepEqual(await dims(portrait, 'c', { coverArtSquaring: 'always' }), [600, 600]);
  assert.deepEqual(await dims(portrait, 'd', {}), [600, 900]);
});

test('cover art extracts as it is and downscales from the original without re-encoding the audio', async t => {
  const w = await workspace(t, 'jpegoptim'); if (!w) return;
  const cover = await coverImage(w.file('cover.jpg'), 800, 600);
  const input = await tone(w.file('song.m4a'), { codec: ['-c:a', 'aac', '-b:a', '192k'], cover });
  const extracted = await extractAudioCoverArt(input, w.out);
  assert.deepEqual([path.basename(extracted.path), extracted.format, extracted.width, extracted.height], ['song-cover.jpg', 'jpeg', 800, 600]);
  assert.ok((await readFile(extracted.path)).equals(await readFile(cover)));

  const half = await downscaleAudioCoverArt(input, w.out, 0.5);
  assert.deepEqual([path.basename(half.path), (await art(half.path))?.width, (await art(half.path))?.height], ['song.m4a', 400, 300]);
  const [before, after] = [(await streams(input))[0], (await streams(half.path))[0]];
  assert.deepEqual([after.codec_name, probeNumber(after.bit_rate)], [before.codec_name, probeNumber(before.bit_rate)], 'the audio is copied');
  // From the full-size original, not the already halved art.
  const quarter = await downscaleAudioCoverArt(half.path, w.out, 0.25, { original: extracted.path, name: 'quarter' });
  assert.deepEqual([(await art(quarter.path))?.width, (await art(quarter.path))?.height], [200, 150]);
  const full = await downscaleAudioCoverArt(half.path, w.out, 1, { original: extracted.path, name: 'full' });
  assert.ok((await readFile((await extractAudioCoverArt(full.path, w.out, { name: 'full-cover' })).path)).equals(await readFile(cover)), 'at 100% the original is embedded as it is');

  const bare = await tone(w.file('bare.mp3'), { codec: mp3(128) });
  await assert.rejects(extractAudioCoverArt(bare, w.out), /no cover art/);
  await assert.rejects(downscaleAudioCoverArt(bare, w.out, 0.5), /no cover art/);
  await assert.rejects(downscaleAudioCoverArt(await tone(w.file('pcm.wav')), w.out, 0.5), /WAV files cannot hold cover art/);
});

test('cover art sharp cannot decode is re-embedded untouched', async t => {
  const w = await workspace(t, 'jpegoptim', 'pngquant'); if (!w) return;
  const bmp = w.file('cover.bmp');
  await run('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=300x200', '-frames:v', '1', bmp]);
  const input = await tone(w.file('song.mp3'), { codec: mp3(320), cover: bmp });
  const output = await optimiseAudio(input, w.out, { coverArtSquaring: 'always', coverArtMaxLongEdge: 100 });
  const picture = await art(output.path);
  assert.deepEqual([picture?.codec_name, picture?.width, picture?.height], ['bmp', 300, 200]);
  assert.ok((await readFile((await extractAudioCoverArt(output.path, w.out)).path)).equals(await readFile(bmp)));
});
