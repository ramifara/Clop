import { settingsSchema, type CompressionQuality } from '../settings/schema';

// Shared/AudioFormat.swift and the bitrate helpers at the top of Clop/Audio.swift. Bitrates are kbps.
export type AudioFormat = 'aac' | 'mp3' | 'opus' | 'wav' | 'flac' | 'aiff';
export interface AudioFormatSpec {
  name: string; ext: string;
  /** ffmpeg encoder. macOS encodes AAC with Apple's `aac_at`; Windows uses ffmpeg's own `aac`. */
  codec: string;
  lossless: boolean;
  /** Whether ffmpeg can write an attached cover picture into the container. */
  coverArt: boolean;
  /** Bitrates a target snaps down to; empty for formats without a bitrate. */
  allowedBitrates: readonly number[];
  defaultBitrate: number;
  /** The compression slider's range: `hi` at factor 5, `lo` at factor 100. */
  bitrateRange?: { lo: number; hi: number };
}

export const AUDIO_FORMATS: Record<AudioFormat, AudioFormatSpec> = {
  aac: { name: 'AAC (M4A)', ext: 'm4a', codec: 'aac', lossless: false, coverArt: true, allowedBitrates: [56, 64, 80, 96, 128, 160, 192, 256], defaultBitrate: 192, bitrateRange: { lo: 48, hi: 256 } },
  mp3: { name: 'MP3', ext: 'mp3', codec: 'libmp3lame', lossless: false, coverArt: true, allowedBitrates: [56, 64, 80, 96, 128, 160, 192, 256, 320], defaultBitrate: 192, bitrateRange: { lo: 64, hi: 320 } },
  opus: { name: 'Opus (OGG)', ext: 'ogg', codec: 'libopus', lossless: false, coverArt: false, allowedBitrates: [32, 48, 64, 80, 96, 128], defaultBitrate: 128, bitrateRange: { lo: 32, hi: 160 } },
  wav: { name: 'WAV', ext: 'wav', codec: 'pcm_s16le', lossless: true, coverArt: false, allowedBitrates: [], defaultBitrate: 0 },
  flac: { name: 'FLAC', ext: 'flac', codec: 'flac', lossless: true, coverArt: true, allowedBitrates: [], defaultBitrate: 0 },
  aiff: { name: 'AIFF', ext: 'aiff', codec: 'pcm_s16be', lossless: true, coverArt: false, allowedBitrates: [], defaultBitrate: 0 },
};
export const AUDIO_FORMAT_NAMES = Object.keys(AUDIO_FORMATS) as AudioFormat[];
/** Index of the last allowed bitrate at or under `cap`, or -1. */
const lastAtMost = (allowed: readonly number[], cap: number) => { let i = allowed.length - 1; while (i >= 0 && allowed[i] > cap) i--; return i; };

/** Round to the nearest 16 kbps, so the slider lands on familiar bitrates. */
export const roundedAudioBitrate = (raw: number) => Math.max(8, Math.round(raw / 16) * 16);

/** `CompressionQuality.audioBitrate(for:)`: factor 5 gives the format's highest bitrate, 100 its lowest. Undefined for lossless formats. */
export function audioBitrate({ factor }: Pick<CompressionQuality, 'factor'>, format: AudioFormat) {
  const range = AUDIO_FORMATS[format].bitrateRange;
  if (!range || range.hi <= range.lo) return undefined;
  const t = (Math.min(100, Math.max(5, factor)) - 5) / 95;
  return Math.min(range.hi, Math.max(range.lo, roundedAudioBitrate(range.hi - t * (range.hi - range.lo))));
}

/** `audioCompressionFactor(forBitrate:format:)`: the nearest factor for a bitrate, 35 when the format has none. */
export function audioCompressionFactor(bitrate: number, format: AudioFormat) {
  const range = AUDIO_FORMATS[format].bitrateRange;
  if (!range || range.hi <= range.lo || bitrate <= 0) return 35;
  const t = (range.hi - Math.min(range.hi, Math.max(range.lo, bitrate))) / (range.hi - range.lo);
  return Math.min(100, Math.max(5, Math.round(5 + t * 95)));
}

/**
 * `resolveBitrate`: a positive target is capped at the input's bitrate and snapped down to an allowed
 * one, so a file is never re-encoded above its source. -1 and -2 mean one or two allowed steps below the input.
 */
export function resolveBitrate(format: AudioFormat, bitrate: number, inputBitrate: number | undefined) {
  const { allowedBitrates: allowed, defaultBitrate } = AUDIO_FORMATS[format];
  if (bitrate >= 0) {
    if (!inputBitrate || inputBitrate <= 0) return bitrate;
    const capped = Math.min(bitrate, inputBitrate);
    const at = lastAtMost(allowed, capped);
    return at < 0 ? capped : allowed[at];
  }
  const input = inputBitrate ?? defaultBitrate;
  if (!allowed.length) return input;
  const at = lastAtMost(allowed, input);
  return allowed[Math.max(0, (at < 0 ? allowed.length - 1 : at) + bitrate)];
}

/**
 * `loweredBitrate(target:inputBitrate:)`: the allowed bitrate at or under both the target and the input.
 * Undefined when that would not lower the bitrate, or for formats without one.
 */
export function loweredBitrate(format: AudioFormat, target: number, inputBitrate: number | undefined) {
  const { allowedBitrates: allowed, defaultBitrate } = AUDIO_FORMATS[format];
  if (!allowed.length) return undefined;
  const input = inputBitrate ?? defaultBitrate;
  const cap = input > 0 ? Math.min(target, input) : target;
  if (cap <= 0) return undefined;
  const resolved = allowed[Math.max(0, lastAtMost(allowed, cap))];
  return input > 0 && resolved >= input ? undefined : resolved;
}

/** `Audio.loweredBitrate(factor:)`: the input's bitrate scaled by a factor under 1, then lowered as above. */
export function loweredBitrateByFactor(format: AudioFormat, factor: number, inputBitrate: number | undefined) {
  if (!(factor > 0 && factor < 1)) return undefined;
  const input = inputBitrate ?? AUDIO_FORMATS[format].defaultBitrate;
  if (input <= 0) return undefined;
  return loweredBitrate(format, Math.round(input * factor), input);
}

/** LAME VBR quality (0 best, 9 worst) for a target bitrate. */
function lameVBRQuality(bitrate: number) {
  for (const [upTo, quality] of [[64, 9], [80, 8], [96, 7], [128, 5], [160, 4], [192, 2]] as const) if (bitrate <= upTo) return quality;
  return 0;
}

/**
 * `encodingArgs`: VBR where the codec has it. WAV and AIFF become 16-bit at no more than 48 kHz, and
 * aggressive WAV becomes IMA ADPCM (about 4:1); aggressive FLAC uses the slowest compression level.
 */
export function audioEncodingArgs(format: AudioFormat, bitrate: number, { aggressive = false, inputSampleRate }: { aggressive?: boolean; inputSampleRate?: number } = {}) {
  const { codec } = AUDIO_FORMATS[format];
  const capRate = inputSampleRate !== undefined && inputSampleRate > 48000 ? ['-ar', '48000'] : [];
  switch (format) {
    // macOS adds `-aac_at_mode cvbr`; ffmpeg's encoder takes the bitrate as an average.
    case 'aac': return ['-c:a', codec, '-b:a', `${bitrate}k`];
    case 'mp3': return ['-c:a', codec, '-q:a', String(lameVBRQuality(bitrate))];
    case 'opus': return ['-c:a', codec, '-b:a', `${bitrate}k`, '-vbr', 'on'];
    case 'wav': return aggressive ? ['-c:a', 'adpcm_ima_wav'] : ['-c:a', codec, ...capRate];
    case 'flac': return ['-c:a', codec, '-compression_level', aggressive ? '12' : '8'];
    case 'aiff': return ['-c:a', codec, ...capRate];
  }
}

// UTType conformance makes .aif and .aifc AIFF on macOS.
const normalisedExtension = (ext: string) => { const lower = ext.replace(/^\./, '').toLowerCase(); return lower === 'aif' || lower === 'aifc' ? 'aiff' : lower; };

/** `AudioFormat.sameAsInput.resolved(forInputExtension:)`: the format whose extension the input has, else AAC. */
export const audioFormatForExtension = (ext: string): AudioFormat => AUDIO_FORMAT_NAMES.find(f => AUDIO_FORMATS[f].ext === ext.toLowerCase()) ?? 'aac';

/** `AudioFormat.from(conversionTarget:)`: a format by name (`aac`, `opus`) or extension (`m4a`, `ogg`). */
export function audioFormatFromName(target: string): AudioFormat | undefined {
  const lower = target.toLowerCase();
  return AUDIO_FORMAT_NAMES.find(f => f === lower) ?? AUDIO_FORMAT_NAMES.find(f => AUDIO_FORMATS[f].ext === lower);
}

export interface AudioConversionSettings { formatsToConvertToAAC?: readonly string[]; formatsToConvertToMP3?: readonly string[] }

/** `audioConversionTarget(forInput:)`: AAC or MP3 when the settings list the input's type, AAC first; otherwise undefined. */
export function audioConversionTarget(ext: string, settings: AudioConversionSettings = {}): AudioFormat | undefined {
  const type = normalisedExtension(ext);
  const listed = (list: readonly string[]) => list.some(item => normalisedExtension(item) === type);
  if (listed(settings.formatsToConvertToAAC ?? settingsSchema.formatsToConvertToAAC.default as string[])) return 'aac';
  if (listed(settings.formatsToConvertToMP3 ?? settingsSchema.formatsToConvertToMP3.default as string[])) return 'mp3';
}

/** The format an optimisation writes: the assigned conversion target, else the input's own format. */
export const outputAudioFormat = (ext: string, settings?: AudioConversionSettings) => audioConversionTarget(ext, settings) ?? audioFormatForExtension(ext);
