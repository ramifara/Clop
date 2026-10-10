import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hardwareArgs, videoAV1CRF, videoConversionArgs, videoEncoderArgs, videoEncoderToCompression, videoH264CRF, videoH264HardwareQuality, videoH264Preset, videoH265CRF, videoHEVCHardwareQuality, videoVP9CRF } from './videoCompression';

const at = (factor: number, tier: 'custom' | 'smaller' | 'fast' | 'lossless' = 'custom') => ({ tier, factor });

test('the factor maps to the CRF, preset and quality values of Shared.swift', () => {
  assert.deepEqual([0, 5, 30, 50, 70, 85, 100].map(f => videoH264CRF(at(f))), [18, 18, 21, 24, 26, 32, 38]);
  assert.deepEqual([5, 50, 64, 100].map(f => videoH265CRF(at(f))), [18, 26, 28, 40]);
  assert.deepEqual([5, 50, 70, 100].map(f => videoAV1CRF(at(f))), [22, 35, 41, 55]);
  assert.deepEqual([5, 50, 100].map(f => videoVP9CRF(at(f))), [18, 31, 50]);
  assert.deepEqual([5, 50, 100].map(f => videoH264HardwareQuality(at(f))), [70, 49, 18]);
  assert.deepEqual([5, 55, 64, 100].map(f => videoHEVCHardwareQuality(at(f))), [65, 44, 40, 18]);
  assert.deepEqual([5, 20, 40, 60, 85].map(f => videoH264Preset(at(f))), ['veryfast', 'fast', 'medium', 'slow', 'slower']);
});

test('tiers pick the encoder: hardware for fast, libx264 at the factor otherwise, CRF 17 for lossless', () => {
  const h264 = { family: 'h264' } as const;
  assert.deepEqual(videoEncoderArgs(at(50, 'smaller'), h264), ['-vcodec', 'libx264', '-tag:v', 'avc1', '-preset', 'medium', '-crf', '24']);
  assert.deepEqual(videoEncoderArgs(at(0, 'custom'), h264), ['-vcodec', 'libx264', '-tag:v', 'avc1', '-preset', 'slower'], 'auto lets libx264 pick the CRF');
  assert.deepEqual(videoEncoderArgs(at(5, 'lossless'), h264), ['-vcodec', 'libx264', '-tag:v', 'avc1', '-crf', '17']);
  assert.deepEqual(videoEncoderArgs(at(50, 'fast'), h264), ['-vcodec', 'libx264', '-tag:v', 'avc1', '-preset', 'veryfast', '-crf', '24'], 'no hardware encoder');
  assert.deepEqual(videoEncoderArgs(at(50, 'fast'), { ...h264, hardware: 'h264_nvenc' }), ['-vcodec', 'h264_nvenc', '-rc', 'vbr', '-cq', '24', '-b:v', '0', '-tag:v', 'avc1', '-pix_fmt', 'nv12']);
  assert.deepEqual(videoEncoderArgs(at(50, 'fast'), { ...h264, hardware: 'h264_nvenc' }, true), ['-vcodec', 'libx264', '-tag:v', 'avc1', '-preset', 'veryslow', '-crf', '28'], 'aggressive');
  const hevc = { family: 'hevc' } as const;
  assert.deepEqual(videoEncoderArgs(at(50, 'smaller'), hevc), ['-vcodec', 'libx265', '-crf', '26', '-tag:v', 'hvc1', '-preset', 'medium']);
  assert.deepEqual(videoEncoderArgs(at(5, 'lossless'), hevc), ['-vcodec', 'libx265', '-crf', '18', '-tag:v', 'hvc1', '-preset', 'medium']);
  assert.deepEqual(videoEncoderArgs(at(50, 'smaller'), hevc, true), ['-vcodec', 'libx265', '-crf', '28', '-tag:v', 'hvc1', '-preset', 'slow']);
});

test('each hardware vendor gets its own constant-quality arguments', () => {
  const cq = at(50, 'fast');
  assert.deepEqual(hardwareArgs('h264_qsv', cq), ['-vcodec', 'h264_qsv', '-global_quality', '24', '-tag:v', 'avc1', '-pix_fmt', 'nv12']);
  assert.deepEqual(hardwareArgs('h264_amf', cq), ['-vcodec', 'h264_amf', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '24', '-qp_b', '24', '-tag:v', 'avc1', '-pix_fmt', 'nv12']);
  assert.deepEqual(hardwareArgs('hevc_amf', cq, true), ['-vcodec', 'hevc_amf', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '26', '-tag:v', 'hvc1', '-pix_fmt', 'p010le']);
  assert.deepEqual(hardwareArgs('h264_mf', cq), ['-vcodec', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', '49', '-tag:v', 'avc1', '-pix_fmt', 'nv12']);
  assert.deepEqual(hardwareArgs('h264_nvenc', at(0, 'fast'), true), ['-vcodec', 'h264_nvenc', '-tag:v', 'avc1', '-pix_fmt', 'nv12'], 'auto keeps the encoder default; H.264 stays 8-bit');
});

test('codec conversions keep the historical fixed arguments until a compression is chosen', () => {
  assert.deepEqual(videoConversionArgs('hevc', undefined), { args: ['-vcodec', 'libx265', '-crf', '28', '-tag:v', 'hvc1', '-preset', 'medium'], ext: 'mp4' });
  assert.deepEqual(videoConversionArgs('hevc', undefined, 'hevc_nvenc'), { args: ['-vcodec', 'hevc_nvenc', '-rc', 'vbr', '-cq', '28', '-b:v', '0', '-tag:v', 'hvc1', '-pix_fmt', 'nv12'], ext: 'mp4' });
  assert.deepEqual(videoConversionArgs('hevc', at(50, 'fast'), 'hevc_qsv').args, ['-vcodec', 'hevc_qsv', '-global_quality', '26', '-tag:v', 'hvc1', '-pix_fmt', 'nv12']);
  assert.deepEqual(videoConversionArgs('hevc', at(50, 'smaller'), 'hevc_qsv').args, ['-vcodec', 'libx265', '-crf', '26', '-tag:v', 'hvc1', '-preset', 'medium']);
  assert.deepEqual(videoConversionArgs('x265', at(5, 'lossless')).args, ['-vcodec', 'libx265', '-crf', '18', '-tag:v', 'hvc1', '-preset', 'medium']);
  assert.deepEqual(videoConversionArgs('av1', undefined), { args: ['-vcodec', 'libsvtav1'], ext: 'mkv' });
  assert.deepEqual(videoConversionArgs('av1', at(70)).args, ['-vcodec', 'libsvtav1', '-crf', '41', '-preset', '6']);
  assert.deepEqual(videoConversionArgs('webm', undefined), { args: ['-vcodec', 'libvpx-vp9', '-crf', '31', '-b:v', '0', '-row-mt', '1'], ext: 'webm' });
  assert.deepEqual(videoConversionArgs('webm', at(5, 'lossless')).args, ['-vcodec', 'libvpx-vp9', '-crf', '15', '-b:v', '0', '-row-mt', '1']);
});

test('the legacy macOS presets map to compression tiers', () => {
  assert.deepEqual(videoEncoderToCompression('fast'), { tier: 'fast', factor: 50 });
  assert.deepEqual(videoEncoderToCompression('slowHighQuality'), { tier: 'smaller', factor: 50 });
  assert.deepEqual(videoEncoderToCompression('visuallyLossless'), { tier: 'lossless', factor: 5 });
});
