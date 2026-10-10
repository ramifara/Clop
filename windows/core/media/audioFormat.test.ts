import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_FORMAT_NAMES, AUDIO_FORMATS, audioBitrate, audioCompressionFactor, audioConversionTarget, audioEncodingArgs, audioFormatForExtension, audioFormatFromName,
  loweredBitrate, loweredBitrateByFactor, outputAudioFormat, resolveBitrate, roundedAudioBitrate, type AudioFormat,
} from './audioFormat';

const swift = readFileSync(fileURLToPath(new URL('../../../Shared/AudioFormat.swift', import.meta.url)), 'utf8');
/** The `case .a, .b: value` lines of one Swift switch property, as format → value text. */
function cases(property: string) {
  const start = swift.indexOf(`var ${property}`);
  assert.ok(start >= 0, property);
  const body = swift.slice(start, swift.indexOf('\n    }\n', start));
  const values = new Map<string, string>();
  for (const [, names, value] of body.matchAll(/case ((?:\.\w+(?:, )?)+): (.+)/g)) for (const [, name] of names.matchAll(/\.(\w+)/g)) values.set(name, value.trim());
  values.delete('sameAsInput');
  return values;
}
const numbers = (text: string) => [...text.matchAll(/\d+/g)].map(m => Number(m[0]));

test('the format table matches Shared/AudioFormat.swift', () => {
  const [names, exts, codecs, art, allowed, defaults, ranges] = ['name', 'fileExtension', 'ffmpegCodec', 'supportsCoverArt', 'allowedBitrates', 'defaultBitrate', 'bitrateRange'].map(cases);
  assert.deepEqual([...exts.keys()].sort(), [...AUDIO_FORMAT_NAMES].sort());
  const lossless = [.../self == \.(\w+) \|\| self == \.(\w+) \|\| self == \.(\w+)/.exec(swift)!.slice(1)];
  for (const format of AUDIO_FORMAT_NAMES) {
    const spec = AUDIO_FORMATS[format];
    assert.equal(JSON.stringify(spec.name), names.get(format), format);
    assert.equal(JSON.stringify(spec.ext), exts.get(format), format);
    // aac_at is Apple's AudioToolbox encoder; Windows uses ffmpeg's own.
    assert.equal(JSON.stringify(spec.codec), format === 'aac' ? JSON.stringify('aac') : codecs.get(format), format);
    assert.equal(String(spec.coverArt), art.get(format), format);
    assert.deepEqual(spec.allowedBitrates, numbers(allowed.get(format)!), format);
    assert.equal(String(spec.defaultBitrate), defaults.get(format), format);
    assert.deepEqual(spec.bitrateRange ? [spec.bitrateRange.lo, spec.bitrateRange.hi] : 'nil', ranges.get(format) === 'nil' ? 'nil' : numbers(ranges.get(format)!), format);
    assert.equal(spec.lossless, lossless.includes(format), format);
  }
});

test('the compression factor maps to a bitrate in steps of 16 kbps, and back', () => {
  assert.deepEqual(AUDIO_FORMAT_NAMES.map(f => audioBitrate({ factor: 35 }, f)), [192, 240, 112, undefined, undefined, undefined]);
  assert.deepEqual((['aac', 'mp3', 'opus'] as const).map(f => [audioBitrate({ factor: 5 }, f), audioBitrate({ factor: 100 }, f), audioBitrate({ factor: 0 }, f)]), [[256, 48, 256], [320, 64, 320], [160, 32, 160]]);
  assert.equal(roundedAudioBitrate(4), 8);
  assert.equal(roundedAudioBitrate(200), 208);
  assert.equal(audioCompressionFactor(192, 'aac'), 34);
  assert.equal(audioBitrate({ factor: 34 }, 'aac'), 192);
  assert.deepEqual([audioCompressionFactor(400, 'mp3'), audioCompressionFactor(10, 'mp3'), audioCompressionFactor(0, 'mp3'), audioCompressionFactor(900, 'wav')], [5, 100, 35, 35]);
});

test('a target bitrate is capped at the input and snapped to an allowed one; negative targets step below the input', () => {
  assert.equal(resolveBitrate('mp3', 240, 320), 192);
  assert.equal(resolveBitrate('mp3', 240, undefined), 240);
  assert.equal(resolveBitrate('mp3', 240, 100), 96);
  assert.equal(resolveBitrate('aac', 30, 300), 30);
  assert.equal(resolveBitrate('flac', 192, 900), 192);
  assert.equal(resolveBitrate('mp3', -1, 320), 256);
  assert.equal(resolveBitrate('mp3', -2, 192), 128);
  assert.equal(resolveBitrate('mp3', -1, undefined), 160);
  assert.equal(resolveBitrate('opus', -9, 128), 32);
  assert.equal(resolveBitrate('wav', -1, 1411), 1411);
});

test('lowering a bitrate never raises it and reports a no-op as undefined', () => {
  assert.equal(loweredBitrate('mp3', 130, 320), 128);
  assert.equal(loweredBitrate('mp3', 400, 320), undefined);
  assert.equal(loweredBitrate('mp3', 40, 320), 56, 'below the lowest allowed bitrate the lowest is used');
  assert.equal(loweredBitrate('mp3', 40, 56), undefined);
  assert.equal(loweredBitrate('aac', 100, undefined), 96, 'an unknown input bitrate counts as the default');
  assert.equal(loweredBitrate('mp3', 0, 320), undefined);
  assert.equal(loweredBitrate('flac', 128, 900), undefined);
  assert.equal(loweredBitrateByFactor('mp3', 0.5, 320), 160);
  assert.equal(loweredBitrateByFactor('mp3', 0.5, undefined), 96);
  assert.equal(loweredBitrateByFactor('mp3', 1, 320), undefined);
  assert.equal(loweredBitrateByFactor('opus', 0.9, 128), 96);
});

test('encoder arguments use VBR, 16-bit PCM up to 48 kHz, ADPCM for aggressive WAV', () => {
  assert.deepEqual(audioEncodingArgs('aac', 192), ['-c:a', 'aac', '-b:a', '192k']);
  assert.deepEqual([64, 80, 96, 100, 128, 160, 192, 256, 320].map(b => audioEncodingArgs('mp3', b)[3]), ['9', '8', '7', '5', '5', '4', '2', '0', '0']);
  assert.deepEqual(audioEncodingArgs('opus', 96), ['-c:a', 'libopus', '-b:a', '96k', '-vbr', 'on']);
  assert.deepEqual(audioEncodingArgs('wav', 0, { inputSampleRate: 44100 }), ['-c:a', 'pcm_s16le']);
  assert.deepEqual(audioEncodingArgs('wav', 0, { inputSampleRate: 96000 }), ['-c:a', 'pcm_s16le', '-ar', '48000']);
  assert.deepEqual(audioEncodingArgs('wav', 0, { aggressive: true, inputSampleRate: 96000 }), ['-c:a', 'adpcm_ima_wav']);
  assert.deepEqual(audioEncodingArgs('aiff', 0, { aggressive: true, inputSampleRate: 88200 }), ['-c:a', 'pcm_s16be', '-ar', '48000']);
  assert.deepEqual([audioEncodingArgs('flac', 0), audioEncodingArgs('flac', 0, { aggressive: true })], [['-c:a', 'flac', '-compression_level', '8'], ['-c:a', 'flac', '-compression_level', '12']]);
});

test('formats resolve from extensions, names and the conversion settings', () => {
  const byExtension = Object.fromEntries(['MP3', 'm4a', 'ogg', 'wav', 'aiff', 'flac', 'opus', 'aif', 'aac'].map(ext => [ext, audioFormatForExtension(ext)]));
  // Like macOS, an extension no format writes (.opus, .aif, .aac) resolves to AAC.
  assert.deepEqual(byExtension, { MP3: 'mp3', m4a: 'aac', ogg: 'opus', wav: 'wav', aiff: 'aiff', flac: 'flac', opus: 'aac', aif: 'aac', aac: 'aac' });
  assert.deepEqual(['m4a', 'aac', 'OGG', 'opus', 'flac', 'aiff', 'sameAsInput', 'xyz'].map(audioFormatFromName), ['aac', 'aac', 'opus', 'opus', 'flac', 'aiff', undefined, undefined]);
  assert.deepEqual(['flac', 'aiff', 'AIF', 'wav', 'mp3', 'm4a'].map(ext => audioConversionTarget(ext)), ['aac', 'aac', 'aac', 'mp3', undefined, undefined]);
  assert.equal(audioConversionTarget('wav', { formatsToConvertToAAC: ['wav'], formatsToConvertToMP3: ['wav'] }), 'aac', 'AAC wins an overlap');
  assert.equal(audioConversionTarget('flac', { formatsToConvertToAAC: [], formatsToConvertToMP3: [] }), undefined);
  const outputs: [string, AudioFormat][] = [['flac', 'aac'], ['ogg', 'opus'], ['mp3', 'mp3'], ['wav', 'mp3']];
  for (const [ext, format] of outputs) assert.equal(outputAudioFormat(ext), format, ext);
  assert.equal(outputAudioFormat('wav', { formatsToConvertToMP3: [] }), 'wav');
});
