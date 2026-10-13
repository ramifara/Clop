import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needTools } from '../testing';
import { chooseEncoder, encoderWorks, ffmpegEncoders, HARDWARE_ENCODERS, hevcHardware, parseEncoderList } from './videoEncoders';

test('reads encoder names from ffmpeg -encoders', () => {
  const text = 'Encoders:\n V..... = Video\n A..... = Audio\n ------\n V....D libx264              libx264 H.264 / AVC\n V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n A....D aac                  AAC (Advanced Audio Coding)\n';
  assert.deepEqual([...parseEncoderList(text)], ['libx264', 'h264_nvenc', 'aac']);
});

test('the bundled ffmpeg has the software encoders Clop falls back to', async t => {
  if (!needTools(t, 'ffmpeg')) return;
  const names = await ffmpegEncoders();
  for (const name of ['libx264', 'libx265', 'libsvtav1', 'libvpx-vp9', 'libopus', 'aac']) assert.ok(names.has(name), `ffmpeg lacks ${name}`);
  assert.equal(ffmpegEncoders(), ffmpegEncoders(), 'asked once per process');
});

test('auto picks the first hardware encoder that can really encode, or none', async t => {
  if (!needTools(t, 'ffmpeg')) return;
  const works = await Promise.all(HARDWARE_ENCODERS.h264.map(encoderWorks));
  const choice = await chooseEncoder('auto');
  assert.deepEqual(choice, { family: 'h264', hardware: HARDWARE_ENCODERS.h264[works.indexOf(true)] });
  t.diagnostic(`hardware H.264 encoder: ${choice.hardware ?? 'none'}`);
  // A build without the encoder answers without a test encode.
  assert.equal(await encoderWorks('no_such_encoder'), false);
});

test('a named encoder is used when it works, otherwise its software family; software names stay in software', async t => {
  if (!needTools(t, 'ffmpeg')) return;
  assert.deepEqual(await chooseEncoder('libx264'), { family: 'h264' });
  assert.deepEqual(await chooseEncoder('libx265'), { family: 'hevc' });
  for (const name of ['h264_nvenc', 'hevc_amf'] as const) {
    const choice = await chooseEncoder(name);
    assert.deepEqual(choice, { family: name.startsWith('hevc') ? 'hevc' : 'h264', hardware: await encoderWorks(name) ? name : undefined });
  }
  assert.equal(await hevcHardware('libx264'), undefined);
  assert.equal(await hevcHardware('hevc_amf'), await encoderWorks('hevc_amf') ? 'hevc_amf' : undefined);
});
