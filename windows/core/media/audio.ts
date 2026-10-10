import { rename, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { queue, retryBusy, run } from '../run';
import { settingsSchema, type CompressionQuality } from '../settings/schema';
import { AUDIO_FORMATS, audioBitrate, audioEncodingArgs, loweredBitrate, loweredBitrateByFactor, outputAudioFormat, resolveBitrate, type AudioConversionSettings, type AudioFormat } from './audioFormat';
import { coverArtArgs, extractCoverArt, scaleCoverArt, type CoverArtOptions } from './coverArt';
import { audioInfo, type AudioInfo } from './detect';
import { ffprobe, probeNumber } from './ffprobe';
import { moveResult, withTemp } from './output';
import type { MediaJobOptions, MediaOutput } from './types';
import { atempoChain, ffmpegProgress, PROGRESS } from './video';

/** A result, with the bitrate (kbps) it was encoded at; undefined for lossless formats. */
export interface AudioOutput extends MediaOutput { bitrate?: number }
interface Naming {
  /** Output file name without extension. */
  name?: string;
}
export interface AudioOptimiseOptions extends AudioConversionSettings, CoverArtOptions, Naming {
  /** The `audioCompression` setting, or a result's own; its factor picks the bitrate. */
  compression?: CompressionQuality;
  /** Bitrate in kbps instead of the compression's. Like it, capped at the input's bitrate. */
  bitrate?: number;
  /** Output format. By default `formatsToConvertToAAC` and `formatsToConvertToMP3` pick AAC or MP3, and other inputs keep their format. */
  format?: AudioFormat;
  /** Normalise loudness to this many LUFS. The result is kept even when it is not smaller. */
  loudnorm?: number;
  /** Keep a result that is not smaller when the format changes. A same-format result never replaces a smaller input. */
  allowLarger?: boolean;
  /** Give the result the input's modification time (the `preserveDates` setting); on by default. */
  preserveDates?: boolean;
}
type Options<T> = T & MediaJobOptions;

const extension = (file: string) => path.extname(file).slice(1).toLowerCase();
/** The bitrate in whole kbps, as macOS reads it from AVFoundation. */
const kbps = (info: AudioInfo) => info.bitrate === undefined ? undefined : Math.trunc(info.bitrate / 1000);
const totalUs = (info: AudioInfo, factor = 1) => info.durationMs ? info.durationMs * 1000 / factor : undefined;

/**
 * `getAudioMetadata`: the main audio track's duration, codec, sample rate and own bitrate (bits per second).
 * FLAC and Ogg streams state no bitrate, and the container's that ffprobe falls back to also counts the
 * embedded cover art, so for those the audio packets are measured instead.
 */
export async function audioMetadata(file: string, { signal }: { signal?: AbortSignal } = {}): Promise<AudioInfo> {
  const result = await ffprobe(file, { signal });
  const info = audioInfo(result);
  const stream = result.streams.find(s => s.codec_type === 'audio' && s.disposition?.attached_pic !== 1);
  if (!stream || probeNumber(stream.bit_rate) !== undefined || !info.hasCoverArt || !info.durationMs) return info;
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', String(stream.index), '-show_entries', 'packet=size', '-of', 'csv=p=0', file], { signal });
  const bytes = stdout.toString('utf8').split(/\r?\n/).reduce((sum, line) => sum + (Number(line) || 0), 0);
  return bytes ? { ...info, bitrate: Math.round(bytes * 8 / (info.durationMs / 1000)) } : info;
}

function ffmpeg(args: string[], out: string, info: AudioInfo, opts: MediaJobOptions, factor = 1) {
  return run('ffmpeg', ['-y', '-nostdin', '-hide_banner', ...args, ...PROGRESS, out], { signal: opts.signal, onStderrLine: ffmpegProgress(totalUs(info, factor), opts.onProgress) });
}

/** Moves a finished file next to the input's name in `outputDir` and reports what it holds, with its probed bitrate. */
async function finish(input: string, file: string, outputDir: string, stem: string, opts: MediaJobOptions & { preserveDates?: boolean }): Promise<AudioOutput> {
  const ext = extension(file);
  const output = await moveResult(input, file, outputDir, stem, ext);
  if (opts.preserveDates) { const { atime, mtime } = await stat(input); await utimes(output, atime, mtime); }
  const info = await audioMetadata(output, opts);
  opts.onProgress?.(1);
  return { path: output, bytes: (await stat(output)).size, format: ext, durationMs: info.durationMs, bitrate: kbps(info) };
}

/**
 * `Audio.optimise`: re-encodes at the bitrate the compression factor maps to, capped at the input's,
 * converts to AAC or MP3 where the settings say so, optimises the cover art and can normalise loudness.
 * Aggressive mode goes at least one allowed bitrate below the input. A result that is not smaller keeps the input.
 */
export function optimiseAudio(input: string, outputDir: string, opts: Options<AudioOptimiseOptions> = {}): Promise<AudioOutput> {
  return queue('audio')(async () => optimise(input, outputDir, opts, await audioMetadata(input, opts)));
}

async function optimise(input: string, outputDir: string, opts: Options<AudioOptimiseOptions>, info: AudioInfo): Promise<AudioOutput> {
  const { signal } = opts;
  signal?.throwIfAborted();
  const inputExt = extension(input), inputBytes = (await stat(input)).size, inputKbps = kbps(info);
  const format = opts.format ?? outputAudioFormat(inputExt, opts), spec = AUDIO_FORMATS[format];
  const compression = opts.compression ?? settingsSchema.audioCompression.default as CompressionQuality;
  let bitrate = resolveBitrate(format, opts.bitrate ?? audioBitrate(compression, format) ?? 0, inputKbps);
  // Re-encoding at the input's own bitrate would change nothing, so aggressive steps below it.
  if (opts.aggressive && spec.allowedBitrates.length) bitrate = Math.min(bitrate, resolveBitrate(format, -1, inputKbps));
  const sameFormat = inputExt === spec.ext || (inputExt === 'opus' && format === 'opus');

  return withTemp(outputDir, async tmp => {
    const out = path.join(tmp, `audio.${spec.ext}`);
    // Single-pass loudnorm resamples to 192 kHz; resample back to the input's rate.
    const rate = info.sampleRate && info.sampleRate > 0 ? Math.trunc(info.sampleRate) : 48000;
    const loudnorm = opts.loudnorm === undefined ? [] : ['-af', `loudnorm=I=${opts.loudnorm}:TP=-1.5:LRA=11,aresample=${rate}`];
    const args = ['-i', input, ...await coverArtArgs(input, format, tmp, opts, signal), ...audioEncodingArgs(format, bitrate, { aggressive: opts.aggressive, inputSampleRate: info.sampleRate }), ...loudnorm];
    await ffmpeg(args, out, info, opts);
    // A requested loudness change is kept whatever its size; dropping it would ignore the request.
    if (opts.loudnorm === undefined && (await stat(out)).size >= inputBytes && (sameFormat || !opts.allowLarger)) {
      opts.onProgress?.(1);
      return { path: input, bytes: inputBytes, format: inputExt, durationMs: info.durationMs, bitrate: inputKbps, unchanged: true };
    }
    const result = await finish(input, out, outputDir, opts.name ?? path.parse(input).name, { ...opts, preserveDates: opts.preserveDates ?? true });
    return { ...result, bitrate: spec.lossless || bitrate <= 0 ? undefined : bitrate };
  });
}

/**
 * The lower-bitrate action and pipeline step: optimises at `kbps`, or at `factor` (under 1) of the
 * input's bitrate, snapped to an allowed bitrate. When that would not lower the bitrate the input is kept.
 */
export function lowerAudioBitrate(input: string, outputDir: string, target: { kbps: number } | { factor: number }, opts: Options<Omit<AudioOptimiseOptions, 'bitrate' | 'allowLarger'>> = {}): Promise<AudioOutput> {
  return queue('audio')(async () => {
    const info = await audioMetadata(input, opts), inputKbps = kbps(info);
    const format = opts.format ?? outputAudioFormat(extension(input), opts);
    const bitrate = 'kbps' in target ? loweredBitrate(format, target.kbps, inputKbps) : loweredBitrateByFactor(format, target.factor, inputKbps);
    if (bitrate === undefined) {
      opts.onProgress?.(1);
      return { path: input, bytes: (await stat(input)).size, format: extension(input), durationMs: info.durationMs, bitrate: inputKbps, unchanged: true };
    }
    return optimise(input, outputDir, { ...opts, bitrate, allowLarger: true }, info);
  });
}

/** Encoders that keep the input's codec through a speed change; ffmpeg's default for the container would turn Ogg Opus into Vorbis or 24-bit WAV into 16-bit. */
const SPEED_ENCODERS: Record<string, string> = { mp3: 'libmp3lame', opus: 'libopus', vorbis: 'libvorbis', aac: 'aac', alac: 'alac', flac: 'flac' };
const speedEncoder = (codec = '') => SPEED_ENCODERS[codec] ?? (codec.startsWith('pcm_') ? codec : undefined);

/** Swift prints a whole Double with one decimal: 2 becomes `2.0`. */
const swiftDouble = (value: number) => Number.isInteger(value) ? value.toFixed(1) : String(value);

/**
 * `Audio.changeSpeed`: re-times the audio with chained `atempo` filters into `<name>-speed<factor>x`, in the
 * input's format and codec at the encoder's default bitrate, without cover art.
 */
export function changeAudioSpeed(input: string, outputDir: string, factor: number, opts: Options<Naming & { preserveDates?: boolean }> = {}): Promise<AudioOutput> {
  return queue('audio')(async () => {
    if (!(factor > 0) || !Number.isFinite(factor)) throw new Error('Choose a playback speed above 0.');
    const info = await audioMetadata(input, opts);
    const ext = extension(input) || 'm4a', stem = opts.name ?? `${path.parse(input).name}-speed${swiftDouble(factor)}x`;
    return withTemp(outputDir, async tmp => {
      const out = path.join(tmp, `audio.${ext}`);
      const encoder = speedEncoder(info.codec);
      await ffmpeg(['-i', input, '-vn', '-filter:a', atempoChain(factor), ...(encoder ? ['-c:a', encoder] : [])], out, info, opts, factor);
      return finish(input, out, outputDir, stem, { ...opts, preserveDates: opts.preserveDates ?? true });
    });
  });
}

/** `Audio.convert`: encodes to another format at its default bitrate, applying the cover art behaviour. */
export function convertAudio(input: string, outputDir: string, format: AudioFormat, opts: Options<CoverArtOptions & Naming> = {}): Promise<AudioOutput> {
  return queue('audio')(async () => {
    const info = await audioMetadata(input, opts), spec = AUDIO_FORMATS[format];
    return withTemp(outputDir, async tmp => {
      const out = path.join(tmp, `audio.${spec.ext}`);
      await ffmpeg(['-i', input, ...await coverArtArgs(input, format, tmp, opts, opts.signal), ...audioEncodingArgs(format, spec.defaultBitrate)], out, info, opts);
      const result = await finish(input, out, outputDir, opts.name ?? path.parse(input).name, opts);
      return { ...result, bitrate: spec.lossless ? undefined : spec.defaultBitrate };
    });
  });
}

/** `extractAudioCoverArt`: saves the embedded art as it is, as `<name>-cover.jpg` (or `.png`). Rejects when there is none. */
export function extractAudioCoverArt(input: string, outputDir: string, opts: Omit<MediaJobOptions, 'aggressive'> & Naming = {}): Promise<MediaOutput> {
  return queue('audio')(() => withTemp(outputDir, async tmp => {
    const cover = await extractCoverArt(input, tmp, 'cover', opts.signal);
    if (!cover) throw new Error(`${path.basename(input)} has no cover art.`);
    const output = path.join(outputDir, `${opts.name ?? `${path.parse(input).name}-cover`}${path.extname(cover)}`);
    await retryBusy(() => rename(cover, output));
    const meta = await sharp(output).metadata().catch(() => undefined);
    opts.onProgress?.(1);
    return { path: output, bytes: (await stat(output)).size, format: meta?.format ?? extension(output), width: meta?.width, height: meta?.height };
  }));
}

/**
 * `downscaleAudioCoverArt`: re-embeds the cover at `factor` of its original size and copies the audio
 * as it is. Pass the first extraction as `original` so repeated downscales start from the full-size art.
 */
export function downscaleAudioCoverArt(input: string, outputDir: string, factor: number, opts: Omit<MediaJobOptions, 'aggressive'> & Naming & { original?: string } = {}): Promise<AudioOutput> {
  return queue('audio')(async () => {
    if (!(factor > 0)) throw new Error('Choose a cover art scale above 0.');
    const ext = extension(input) || 'm4a';
    if (!Object.values(AUDIO_FORMATS).some(f => f.coverArt && f.ext === ext)) throw new Error(`${ext.toUpperCase()} files cannot hold cover art.`);
    const info = await audioMetadata(input, opts);
    return withTemp(outputDir, async tmp => {
      const original = opts.original ?? await extractCoverArt(input, tmp, 'cover', opts.signal);
      if (!original) throw new Error(`${path.basename(input)} has no cover art.`);
      const cover = factor >= 0.999 ? original : await scaleCoverArt(original, factor, tmp, opts.signal);
      const out = path.join(tmp, `audio.${ext}`);
      await ffmpeg(['-i', input, '-i', cover, '-map', '0:a', '-map', '1:v', '-c:a', 'copy', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', ...(ext === 'mp3' ? ['-id3v2_version', '3'] : [])], out, info, opts);
      return finish(input, out, outputDir, opts.name ?? path.parse(input).name, opts);
    });
  });
}
