import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { needTools } from '../testing';
import type { ToolName } from '../tools';
import { probe, type VideoInfo } from './detect';
import { ffprobe, probeNumber } from './ffprobe';
import { adaptiveUsesSoftware, atempoChain, convertVideoToGIF, croppedSize, ffmpegProgress, optimiseVideo, removeVideoAudio, scaleFilters } from './video';
import { clip, hdrClip } from './video.fixtures';

const smaller = (factor = 50) => ({ tier: 'smaller', factor }) as const;
async function workspace(t: TestContext, ...tools: ToolName[]) {
  if (!needTools(t, 'ffmpeg', 'ffprobe', ...tools)) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-video-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { file: (name: string) => path.join(dir, name), out: path.join(dir, 'out') };
}
async function video(file: string) {
  const info = await probe(file);
  assert.equal(info.kind, 'video');
  return info as VideoInfo;
}
async function stream(file: string, type: 'video' | 'audio') {
  return (await ffprobe(file)).streams.find(s => s.codec_type === type);
}
const near = (actual: number | undefined, expected: number, tolerance: number, what: string) => assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${what}: ${actual}, expected ${expected} ± ${tolerance}`);

test('a 1080p clip optimises on the default fast tier with progress events', async t => {
  const w = await workspace(t); if (!w) return;
  // Two seconds, so ffmpeg reports progress before it finishes.
  const input = await clip(w.file('screen.mp4'), { width: 1920, height: 1080, seconds: 2 });
  const progress: number[] = [];
  const output = await optimiseVideo(input, w.out, { compression: { tier: 'fast', factor: 50 }, onProgress: f => progress.push(f) });
  t.diagnostic(`${(await stat(input)).size} -> ${output.bytes} bytes, progress ${progress.map(f => f.toFixed(2)).join(' ')}`);
  assert.deepEqual([output.path, output.format, output.width, output.height, output.durationMs, output.unchanged], [path.join(w.out, 'screen.mp4'), 'mp4', 1920, 1080, 2000, undefined]);
  assert.ok(output.bytes < (await stat(input)).size && output.bytes === (await stat(output.path)).size);
  assert.ok(progress.length >= 2 && progress.every((f, i) => f > 0 && f <= 1 && (i === 0 || f > progress[i - 1])), 'progress rises from above 0 to 1');
  assert.equal(progress.at(-1), 1);
  const info = await video(output.path);
  assert.deepEqual([info.codec, info.codecTag, info.hasAudio, info.fps], ['h264', 'avc1', true, 30]);
  assert.deepEqual(await readdir(w.out), ['screen.mp4'], 'temporary files are removed');
});

test('aggressive compresses harder; a result that is not smaller keeps the input unless larger is allowed', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await clip(w.file('clip.mp4'));
  const normal = await optimiseVideo(input, w.out, { compression: smaller(30), name: 'normal' });
  const aggressive = await optimiseVideo(input, w.out, { compression: smaller(30), aggressive: true, name: 'aggressive' });
  assert.ok(aggressive.bytes < normal.bytes && normal.bytes < (await stat(input)).size, `${aggressive.bytes} < ${normal.bytes}`);
  const again = await optimiseVideo(aggressive.path, w.out, { compression: { tier: 'lossless', factor: 5 }, name: 'again' });
  assert.deepEqual(again, { path: aggressive.path, bytes: aggressive.bytes, format: 'mp4', width: 320, height: 240, durationMs: 500, unchanged: true });
  const forced = await optimiseVideo(aggressive.path, w.out, { compression: { tier: 'lossless', factor: 5 }, name: 'forced', allowLarger: true });
  assert.ok(!forced.unchanged && forced.bytes > aggressive.bytes);
  // Asked-for changes are never dropped by keeping the input, even when the result is larger.
  const muted = await optimiseVideo(aggressive.path, w.out, { compression: { tier: 'lossless', factor: 5 }, removeAudio: true, name: 'muted' });
  assert.ok(!muted.unchanged && !(await video(muted.path)).hasAudio);
  const aac = await optimiseVideo(aggressive.path, w.out, { compression: { tier: 'lossless', factor: 5 }, convertAudioToAAC: true, name: 'aac' });
  assert.ok(!aac.unchanged && aac.bytes > aggressive.bytes);
});

test('the encoder setting chooses H.264 or HEVC and keeps software tiers in software', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await clip(w.file('clip.mp4'), { audio: false });
  const codec = async (name: string, options: Partial<Parameters<typeof optimiseVideo>[2]>) => (await video((await optimiseVideo(input, w.out, { compression: smaller(), name, allowLarger: true, ...options })).path)).codec;
  assert.equal(await codec('lossless', { compression: { tier: 'lossless', factor: 5 } }), 'h264');
  assert.equal(await codec('x264-fast', { compression: { tier: 'fast', factor: 50 }, encoder: 'libx264' }), 'h264');
  assert.equal(await codec('x265', { encoder: 'libx265' }), 'hevc');
  assert.equal(await codec('adaptive', { compression: { tier: 'adaptive', factor: 30 } }), 'h264');
});

test('the adaptive tier uses software for mid-sized clips and hardware for large or tiny ones', () => {
  assert.equal(adaptiveUsesSoftware({ width: 1280, height: 720, durationMs: 10_000 }, 5_000_000), true);
  assert.equal(adaptiveUsesSoftware({ width: 1920, height: 1080, durationMs: 60_000 }, 200_000_000), false);
  assert.equal(adaptiveUsesSoftware({ width: 1, height: 1, durationMs: 1000 }, 1000), false, 'too small to bother');
  assert.equal(adaptiveUsesSoftware({ width: 1280, height: 720, durationMs: 10_000 }, 5_000_000, false), false, 'adaptiveVideoSize off');
  assert.equal(adaptiveUsesSoftware(undefined, 1_000_000), true, 'without metadata, small files use software');
  assert.equal(adaptiveUsesSoftware({ width: 3840, height: 2160, durationMs: undefined }, 900_000_000), false);
});

test('removing audio copies the video stream untouched', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await clip(w.file('talk.mp4'));
  const progress: number[] = [];
  const output = await removeVideoAudio(input, w.out, { onProgress: f => progress.push(f) });
  assert.equal(output.path, path.join(w.out, 'talk.mp4'));
  assert.equal(await stream(output.path, 'audio'), undefined);
  const [before, after] = [await stream(input, 'video'), await stream(output.path, 'video')];
  assert.deepEqual([after?.codec_name, after?.nb_frames, after?.bit_rate], [before?.codec_name, before?.nb_frames, before?.bit_rate]);
  assert.equal(progress.at(-1), 1);
  const optimised = await optimiseVideo(input, w.out, { compression: smaller(), removeAudio: true, name: 'optimised' });
  assert.equal((await video(optimised.path)).hasAudio, false);
});

test('a speed change keeps or drops frames and re-times the audio', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await clip(w.file('clip.mp4'), { seconds: 1 });
  const keep = await optimiseVideo(input, w.out, { compression: smaller(), speed: 2, name: 'keep' });
  const drop = await optimiseVideo(input, w.out, { compression: smaller(), speed: 2, playbackSpeedFrameBehaviour: 'dropFrames', name: 'drop' });
  for (const [output, fps, frames] of [[keep, 60, 30], [drop, 30, 15]] as const) {
    const [v, a] = [await stream(output.path, 'video'), await stream(output.path, 'audio')];
    near(probeNumber(v?.duration), 0.5, 0.05, `${output.path} video duration`);
    near(probeNumber(a?.duration), 0.5, 0.05, `${output.path} audio duration`);
    near((await video(output.path)).fps, fps, 3, `${output.path} frame rate`);
    assert.equal(Number(v?.nb_frames), frames);
  }
  assert.equal(atempoChain(2), 'atempo=2');
  assert.equal(atempoChain(0.2), 'atempo=0.5,atempo=0.5,atempo=0.8');
  assert.equal(atempoChain(250), 'atempo=100.0,atempo=2.5');
});

test('the frame rate cap follows the target, half and quarter rates, the minimum and an explicit override', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await clip(w.file('clip.mp4'), { fps: 60, audio: false });
  const fps = async (name: string, options: Partial<Parameters<typeof optimiseVideo>[2]>) => (await video((await optimiseVideo(input, w.out, { compression: smaller(), name, ...options })).path)).fps;
  assert.equal(await fps('default', {}), 60, 'the default 60 fps cap has nothing to drop');
  assert.equal(await fps('thirty', { targetVideoFPS: 30 }), 30);
  assert.equal(await fps('half', { targetVideoFPS: -2 }), 30);
  assert.equal(await fps('quarter', { targetVideoFPS: -4, minVideoFPS: 20 }), 20);
  assert.equal(await fps('override', { fps: 24, capVideoFPS: false }), 24);
  assert.equal(await fps('uncapped', { capVideoFPS: false, targetVideoFPS: 30 }), 60);
});

test('scale and crop filters match getScaleFilters', () => {
  const landscape = { width: 320, height: 240 }, portrait = { width: 240, height: 320 };
  assert.deepEqual(scaleFilters(landscape), []);
  assert.deepEqual(scaleFilters(landscape, undefined, [160, 120]), ['scale=w=160:h=120']);
  assert.deepEqual(scaleFilters(landscape, { width: 100, height: 100 }), ['crop=in_w-80:in_h:40:0', 'scale=w=100:h=100']);
  assert.deepEqual(scaleFilters(portrait, { width: 100, height: 100 }), ['crop=in_w:in_h-80:0:40', 'scale=w=100:h=100']);
  assert.deepEqual(scaleFilters(landscape, { width: 160, height: 0 }), ['scale=w=160:h=-2']);
  assert.deepEqual(scaleFilters(landscape, { width: 200, height: 0, longEdge: true }), ['scale=w=200:h=-2']);
  assert.deepEqual(scaleFilters(portrait, { width: 200, height: 0, longEdge: true }), ['scale=w=-2:h=200']);
  assert.deepEqual(scaleFilters(landscape, { width: 16, height: 9, isAspectRatio: true }), ['crop=in_w:in_h-60:0:30', 'scale=w=320:h=180']);
  assert.deepEqual(scaleFilters(landscape, { width: 0, height: 0, cropRect: { x: 0.25, y: 0.1, width: 0.5, height: 0.5 } }), ['crop=floor(in_w*0.500000/2)*2:floor(in_h*0.500000/2)*2:in_w*0.250000:in_h*0.100000']);
  assert.deepEqual(scaleFilters(landscape, { width: 64, height: 47, cropRect: { x: 0.25, y: 0.1, width: 0.5, height: 0.5 } }).at(-1), 'scale=w=64:h=48');
  assert.deepEqual(scaleFilters(landscape, { width: 0, height: 0, cropRect: { x: 0, y: 0, width: 1, height: 1 } }), ['scale=w=-2:h=-2']);
  assert.deepEqual(croppedSize({ width: 9, height: 16, isAspectRatio: true }, 320, 240), [136, 240]);
  assert.deepEqual(scaleFilters(landscape, { width: 9, height: 16, isAspectRatio: true }), ['crop=in_w-184:in_h:92:0', 'scale=w=136:h=240']);
  assert.deepEqual(scaleFilters(landscape, { width: 161, height: 0 }), ['scale=w=162:h=-2']);
  assert.deepEqual(croppedSize({ width: 0, height: 0, cropRect: { x: 0.5, y: 0.5, width: 0.9, height: 0.9 } }, 320, 240), [288, 216]);
});

test('videos scale and crop to the requested size, but never upscale to a long edge', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await clip(w.file('clip.mp4'), { audio: false });
  const size = async (name: string, options: Partial<Parameters<typeof optimiseVideo>[2]>) => {
    const output = await optimiseVideo(input, w.out, { compression: smaller(), name, ...options });
    return [output.width, output.height];
  };
  assert.deepEqual(await size('half', { width: 160, height: 120 }), [160, 120]);
  assert.deepEqual(await size('rect', { crop: { width: 0, height: 0, cropRect: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } } }), [160, 120]);
  assert.deepEqual(await size('square', { crop: { width: 1, height: 1, isAspectRatio: true } }), [240, 240]);
  assert.deepEqual(await size('story', { crop: { width: 9, height: 16, isAspectRatio: true } }), [136, 240], 'odd crop widths are rounded to even for the encoder');
  assert.deepEqual(await size('long-edge', { crop: { width: 160, height: 0, longEdge: true } }), [160, 120]);
  assert.deepEqual(await size('no-upscale', { crop: { width: 640, height: 0, longEdge: true } }), [320, 240]);
});

test('WebM keeps Opus audio, and codec conversions encode HEVC, AV1 and VP9', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await clip(w.file('clip.mp4'));
  const codecs = async (output: { path: string }) => [(await stream(output.path, 'video'))?.codec_name, (await stream(output.path, 'audio'))?.codec_name];
  const webm = await optimiseVideo(input, w.out, { compression: smaller(), format: 'webm', name: 'web' });
  assert.equal(path.extname(webm.path), '.webm');
  assert.equal((await codecs(webm))[1], 'opus');
  const hevc = await optimiseVideo(input, w.out, { compression: smaller(), convert: { codec: 'hevc' }, name: 'hevc' });
  assert.deepEqual([path.extname(hevc.path), ...await codecs(hevc), (await video(hevc.path)).codecTag], ['.mp4', 'hevc', 'aac', 'hvc1']);
  const av1 = await optimiseVideo(input, w.out, { compression: smaller(), convert: { codec: 'av1', compression: smaller(70) }, name: 'av1' });
  assert.deepEqual([path.extname(av1.path), ...await codecs(av1)], ['.mkv', 'av1', 'aac']);
  const vp9 = await optimiseVideo(input, w.out, { compression: smaller(), convert: { codec: 'webm' }, name: 'vp9' });
  assert.deepEqual([path.extname(vp9.path), ...await codecs(vp9)], ['.webm', 'vp9', 'opus']);
});

test('audio is copied, converted to AAC on request, and re-encoded when the container cannot hold it', async t => {
  const w = await workspace(t); if (!w) return;
  const pcm = await clip(w.file('pcm.mov'), { audio: 'pcm_s16le' });
  const audio = async (file: string, options: Partial<Parameters<typeof optimiseVideo>[2]>, name: string) => (await stream((await optimiseVideo(file, w.out, { compression: smaller(), allowLarger: true, name, ...options })).path, 'audio'))?.codec_name;
  assert.equal(await audio(pcm, {}, 'copied'), 'pcm_s16le');
  assert.equal(await audio(pcm, { convertAudioToAAC: true }, 'aac'), 'aac');
  // MP4 cannot hold A-law audio, so the copy fails and the encode is retried without copying (`tryProc(argArray:)`).
  const alaw = await clip(w.file('alaw.mov'), { audio: 'pcm_alaw' });
  const progress: number[] = [];
  assert.equal(await audio(alaw, { format: 'mp4', onProgress: f => progress.push(f) }, 'alaw'), 'aac');
  assert.ok(progress.length && progress.every((f, i) => i === 0 || f > progress[i - 1]), `progress never goes back across attempts: ${progress.join(' ')}`);
});

test('HDR becomes SDR for H.264 but stays HDR in an HEVC conversion', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await hdrClip(w.file('hdr.mp4'));
  const sdr = await video((await optimiseVideo(input, w.out, { compression: smaller(), allowLarger: true, name: 'sdr' })).path);
  assert.deepEqual([sdr.codec, sdr.pixelFormat, sdr.transfer, sdr.hdr], ['h264', 'yuv420p', 'bt709', false]);
  const kept = await video((await optimiseVideo(input, w.out, { compression: smaller(), convert: { codec: 'x265' }, name: 'kept' })).path);
  assert.deepEqual([kept.codec, kept.bitDepth, kept.transfer, kept.hdr], ['hevc', 10, 'smpte2084', true]);
  const asked = await video((await optimiseVideo(input, w.out, { compression: smaller(), convert: { codec: 'x265' }, hdrToSdr: true, name: 'asked' })).path);
  assert.deepEqual([asked.transfer, asked.hdr], ['bt709', false]);
  // The fast tier may use a hardware HEVC encoder; tone-mapped video stays 8-bit there too.
  const fast = await video((await optimiseVideo(input, w.out, { compression: smaller(), convert: { codec: 'hevc', compression: { tier: 'fast', factor: 50 } }, hdrToSdr: true, name: 'fast' })).path);
  assert.deepEqual([fast.codec, fast.bitDepth, fast.transfer], ['hevc', 8, 'bt709']);
});

test('identifying metadata is stripped unless asked to keep it', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await clip(w.file('trip.mp4'), { metadata: { title: 'Holiday', location: '+48.8577+002.2950/' } });
  const tags = async (file: string) => (await ffprobe(file)).format.tags ?? {};
  const stripped = await optimiseVideo(input, w.out, { compression: smaller(), name: 'stripped' });
  assert.equal((await tags(stripped.path)).title, undefined);
  assert.equal((await tags(stripped.path)).location, undefined);
  const kept = await optimiseVideo(input, w.out, { compression: smaller(), stripMetadata: false, name: 'kept' });
  assert.equal((await tags(kept.path)).title, 'Holiday');
  const noAudio = await removeVideoAudio(input, w.out, { name: 'no-audio' });
  assert.equal((await tags(noAudio.path)).title, undefined);
});

test('converts to GIF through gifski at the requested width and frame rate', async t => {
  const w = await workspace(t, 'gifski'); if (!w) return;
  const input = await clip(w.file('clip.mp4'), { width: 640, height: 480, seconds: 1 });
  const progress: number[] = [];
  const gif = await convertVideoToGIF(input, w.out, { maxWidth: 160, fps: 10, onProgress: f => progress.push(f) });
  assert.deepEqual([gif.path, gif.format, gif.width, gif.height], [path.join(w.out, 'clip.gif'), 'gif', 160, 120]);
  const meta = await sharp(gif.path, { animated: true }).metadata();
  near(meta.pages, 10, 2, 'frames');
  assert.ok(progress.some(f => f > 0 && f <= 0.5) && progress.some(f => f > 0.5 && f < 1), `progress from both tools: ${progress.join(' ')}`);
  assert.equal(progress.at(-1), 1);
  const smallerGIF = await convertVideoToGIF(input, w.out, { maxWidth: 160, fps: 10, aggressive: true, name: 'aggressive' });
  assert.ok(smallerGIF.bytes < gif.bytes);
  assert.deepEqual((await readdir(w.out)).sort(), ['aggressive.gif', 'clip.gif']);
});

test('aborting stops ffmpeg and leaves no temporary files', async t => {
  const w = await workspace(t); if (!w) return;
  const input = await clip(w.file('long.mp4'), { width: 1280, height: 720, seconds: 4 });
  const controller = new AbortController();
  const running = optimiseVideo(input, w.out, { compression: smaller(95), signal: controller.signal, onProgress: () => controller.abort() });
  await assert.rejects(running, { name: 'AbortError' });
  assert.deepEqual(await readdir(w.out), []);
});

test('progress reads ffmpeg out_time_us against the duration, or the duration ffmpeg prints', () => {
  const seen: number[] = [];
  const known = ffmpegProgress(2_000_000, f => seen.push(f));
  ['frame=10', 'out_time_us=0', 'out_time_us=500000', 'out_time_us=2500000', 'progress=end'].forEach(known);
  assert.deepEqual(seen, [0.25, 1]);
  seen.length = 0;
  const unknown = ffmpegProgress(undefined, f => seen.push(f), f => f / 2);
  ['out_time_us=100', '  Duration: 00:00:04.00, start: 0.000000, bitrate: 512 kb/s', 'out_time_us=1000000'].forEach(unknown);
  assert.deepEqual(seen, [0.125]);
});
