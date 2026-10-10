import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { run } from '../run';
import { needTools } from '../testing';
import { detectKind, probe } from './detect';
import { ffprobe } from './ffprobe';
import { clip, hdrClip } from './video.fixtures';

async function workspace(t: TestContext) {
  if (!needTools(t, 'ffmpeg', 'ffprobe')) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clop-detect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return (name: string) => path.join(dir, name);
}

test('detects the kind by extension, and by content for unknown extensions', async t => {
  const file = await workspace(t); if (!file) return;
  const video = await clip(file('clip.mp4'));
  const audio = await clip(file('tone.m4a'), { video: ['-vn'] });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toFile(file('pixel.png'));
  await writeFile(file('doc.pdf'), '%PDF-1.7\n%%EOF\n');
  for (const [name, kind] of [['clip.mp4', 'video'], ['tone.m4a', 'audio'], ['pixel.png', 'image'], ['doc.pdf', 'pdf'], ['photo.JPG', 'image'], ['Song.FLAC', 'audio']] as const) assert.equal(await detectKind(file(name)), kind, name);
  await copyFile(video, file('clip.bin')); await copyFile(audio, file('tone.dat')); await copyFile(file('pixel.png'), file('pixel.blob')); await copyFile(file('doc.pdf'), file('doc.download'));
  await writeFile(file('notes.xyz'), 'just some text, not media');
  for (const [name, kind] of [['clip.bin', 'video'], ['tone.dat', 'audio'], ['pixel.blob', 'image'], ['doc.download', 'pdf'], ['notes.xyz', undefined]] as const) assert.equal(await detectKind(file(name)), kind, name);
});

test('probes video size, rate, duration, audio, codec and HDR', async t => {
  const file = await workspace(t); if (!file) return;
  const info = await probe(await clip(file('clip.mp4'), { width: 320, height: 240, fps: 25, seconds: 0.4 }));
  assert.deepEqual(info, { kind: 'video', format: info.kind === 'video' ? info.format : '', width: 320, height: 240, durationMs: 400, fps: 25, hasAudio: true, codec: 'h264', codecTag: 'avc1', pixelFormat: 'yuv420p', bitDepth: 8, bitrate: info.kind === 'video' ? info.bitrate : 0, transfer: undefined, hdr: false });
  assert.ok(info.kind === 'video' && info.bitrate! > 0);
  const silent = await probe(await clip(file('silent.mp4'), { audio: false }));
  assert.equal(silent.kind === 'video' && silent.hasAudio, false);
  const hdr = await probe(await hdrClip(file('hdr.mp4')));
  assert.ok(hdr.kind === 'video');
  assert.deepEqual([hdr.codec, hdr.codecTag, hdr.bitDepth, hdr.transfer, hdr.hdr], ['hevc', 'hvc1', 10, 'smpte2084', true]);
});

test('a rotated video reports its displayed size', async t => {
  const file = await workspace(t); if (!file) return;
  const source = await clip(file('wide.mp4'), { width: 320, height: 240 });
  await run('ffmpeg', ['-y', '-nostdin', '-loglevel', 'error', '-display_rotation', '90', '-i', source, '-c', 'copy', file('rotated.mp4')]);
  const info = await probe(file('rotated.mp4'));
  assert.deepEqual(info.kind === 'video' && [info.width, info.height], [240, 320]);
});

test('probes audio and images; ffprobe rejects what it cannot read', async t => {
  const file = await workspace(t); if (!file) return;
  const audio = await probe(await clip(file('tone.m4a'), { video: ['-vn'], seconds: 0.5 }));
  assert.ok(audio.kind === 'audio');
  assert.deepEqual([audio.codec, audio.sampleRate, audio.channels, audio.hasCoverArt], ['aac', 48000, 1, false]);
  assert.ok(Math.abs(audio.durationMs! - 500) < 50);
  await sharp({ create: { width: 12, height: 7, channels: 4, background: '#ff000080' } }).png().toFile(file('pixel.png'));
  assert.deepEqual(await probe(file('pixel.png')), { kind: 'image', format: 'png', width: 12, height: 7, pages: undefined });
  await writeFile(file('broken.mp4'), 'not a video');
  await assert.rejects(ffprobe(file('broken.mp4')), /ffprobe exited/);
  await assert.rejects(probe(file('broken.mp4')), /ffprobe exited/);
});
