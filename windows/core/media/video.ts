import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { queue, retryBusy, run, ToolError, type RunOptions } from '../run';
import type { CompressionQuality } from '../settings/schema';
import { clampRect, computedSize, even, isFullFrame, pixelRect, type CropSpec } from './crop-size';
import { videoInfo, type VideoInfo } from './detect';
import { ffprobe } from './ffprobe';
import { CONVERSION_EXTENSIONS, encoderFamily, videoConversionArgs, videoEncoderArgs, type VideoCodecConversion, type VideoEncoderSetting } from './videoCompression';
import { chooseEncoder, hevcHardware } from './videoEncoders';
import type { MediaJobOptions, MediaOutput } from './types';

/** A crop or resize target; `smartCrop` does not apply to video. */
export type VideoCrop = CropSpec;
export interface VideoOptimiseOptions {
  /** The `videoCompression` setting, or a result's own compression. */
  compression: CompressionQuality;
  /** The `videoEncoder` setting; `auto` by default. */
  encoder?: VideoEncoderSetting;
  /** Output container extension; the input's own when omitted. */
  format?: string;
  /** Re-encode to another codec (`videoConversionArgs`). Without a compression the historical fixed arguments apply. */
  convert?: { codec: VideoCodecConversion; compression?: CompressionQuality };
  /** Size to scale to. */
  width?: number; height?: number;
  crop?: VideoCrop;
  /** Playback speed factor, and whether a speed-up keeps every frame or drops back to the source frame rate. */
  speed?: number; playbackSpeedFrameBehaviour?: 'keepFrames' | 'dropFrames';
  /** A frame rate cap that overrides the settings below. */
  fps?: number;
  capVideoFPS?: boolean; targetVideoFPS?: number; minVideoFPS?: number;
  removeAudio?: boolean; convertAudioToAAC?: boolean;
  /** Lets the adaptive tier pick hardware for small or short clips and software for the rest. On by default. */
  adaptiveVideoSize?: boolean;
  /** Tone map HDR to SDR. By default HDR becomes SDR when the output is H.264, which has no useful HDR form. */
  hdrToSdr?: boolean;
  stripMetadata?: boolean;
  /** Keep a plain optimisation even when it is not smaller. */
  allowLarger?: boolean;
  /** Output file name without extension; the input's name when omitted. */
  name?: string;
}
type Options = VideoOptimiseOptions & MediaJobOptions;

/** Makes ffmpeg write `-progress` lines such as `out_time_us=…` to stderr ten times a second. */
export const PROGRESS = ['-progress', 'pipe:2', '-nostats', '-stats_period', '0.1'];
const ENCODED_CONTAINERS = new Set(['mp4', 'mov', 'hevc']);
// Linear light, BT.709 primaries, Hable's curve, then back to 8-bit BT.709 video. Needs ffmpeg built with zimg.
const TONE_MAP = ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p'];
const SDR_TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];

const extension = (file: string) => path.extname(file).slice(1).toLowerCase();
const int = Math.trunc;

/**
 * Parses `-progress pipe:2` output into fractions of `totalUs`. Without a known duration it takes the
 * one ffmpeg prints for its input (`updateProgressFFmpeg` in Video.swift).
 */
export function ffmpegProgress(totalUs: number | undefined, onProgress?: (fraction: number) => void, scale = (f: number) => f) {
  let total = totalUs;
  return (line: string) => {
    if (!onProgress) return;
    const duration = total ? undefined : /^\s*Duration: (\d{2,}):(\d{2}):(\d{2})\.(\d{2})/.exec(line);
    if (duration) total = ((+duration[1] * 3600 + +duration[2] * 60 + +duration[3]) * 1000 + +duration[4] * 10) * 1000;
    const time = /^out_time_us=(\d+)$/.exec(line);
    if (time && total && +time[1] > 0) onProgress(scale(Math.min(+time[1] / total, 1)));
  };
}

/** `atempo` only takes 0.5 to 100, so other factors chain several (Audio.swift `changeSpeed`). */
export function atempoChain(factor: number) {
  const filters: string[] = [];
  let remaining = factor;
  for (; remaining < 0.5; remaining /= 0.5) filters.push('atempo=0.5');
  for (; remaining > 100; remaining /= 100) filters.push('atempo=100.0');
  filters.push(`atempo=${remaining}`);
  return filters.join(',');
}

/** `CropSize.computedSize`, or a crop rectangle's pixel size. Aspect-ratio sizes are rounded to even, as encoders need. */
export function croppedSize(crop: VideoCrop, width: number, height: number): [number, number] {
  if (crop.cropRect) { const r = pixelRect(crop.cropRect, width, height); return [r.width, r.height]; }
  const size = computedSize(crop, width, height);
  return crop.isAspectRatio ? [even(size.width), even(size.height)] : [size.width, size.height];
}

/** `getScaleFilters` (Video.swift): crop and scale filters for a crop target or a plain resize. */
export function scaleFilters(source: { width: number; height: number } | undefined, crop?: VideoCrop, size?: [number, number]): string[] {
  if (!crop || !source) return size ? [`scale=w=${int(size[0])}:h=${int(size[1])}`] : [];
  if (crop.cropRect && !isFullFrame(crop.cropRect)) {
    // Relative expressions crop the original whatever its pixel size; most encoders need even dimensions.
    const r = clampRect(crop.cropRect), f = (n: number) => n.toFixed(6);
    const filters = [`crop=floor(in_w*${f(r.width)}/2)*2:floor(in_h*${f(r.height)}/2)*2:in_w*${f(r.x)}:in_h*${f(r.y)}`];
    if (crop.width > 0 && crop.height > 0) filters.push(`scale=w=${even(crop.width)}:h=${even(crop.height)}`);
    return filters;
  }
  const [w, h] = crop.isAspectRatio ? croppedSize(crop, source.width, source.height) : [crop.width, crop.height];
  if (!(w > 0 && h > 0) || (crop.longEdge && !crop.isAspectRatio)) {
    // One side given: keep the aspect ratio.
    if (!crop.longEdge) return [`scale=w=${w === 0 ? '-2' : even(w)}:h=${h === 0 ? '-2' : even(h)}`];
    return source.width > source.height ? [`scale=w=${even(crop.width || crop.height)}:h=-2`] : [`scale=w=-2:h=${even(crop.height || crop.width)}`];
  }
  let cropString: string;
  if (source.width / w > source.height / h) {
    const diff = int((source.width - (w / h) * source.height) / 2);
    cropString = `in_w-${diff * 2}:in_h:${diff}:0`;
  } else {
    const diff = int((source.height - (h / w) * source.width) / 2);
    cropString = `in_w:in_h-${diff * 2}:0:${diff}`;
  }
  // Even sizes, which yuv420p and NV12 encoders require; Swift truncates and can produce odd ones.
  return [`crop=${cropString}`, `scale=w=${even(w)}:h=${even(h)}`];
}

/**
 * `useAggressiveOptimisation` (Video.swift, Apple Silicon): whether the adaptive tier picks the
 * software encoder. The size, duration and byte count are multiplied with the same wrapping 64-bit
 * arithmetic as the Swift.
 */
export function adaptiveUsesSoftware(info: Pick<VideoInfo, 'width' | 'height' | 'durationMs'> | undefined, bytes: number, adaptiveVideoSize = true) {
  if (!adaptiveVideoSize) return false;
  if (info?.width && info.height && info.durationMs !== undefined && bytes > 0) {
    const bits = BigInt.asIntN(64, BigInt(info.width * info.height) * BigInt(Math.max(Math.round(info.durationMs / 1000), 0)) * BigInt(bytes));
    return bits < 1920n * 1080n * 10n * 5_000_000n && bits > 500_000n;
  }
  return (info?.width && info.height ? info.width * info.height : Infinity) < 1920 * 1080 || (info?.durationMs ?? 999_999_000) < 10_000 || bytes < 5_000_000;
}

/**
 * Runs each argument set in turn until one succeeds, as `tryProc(argArray:)` and `tryProc(tries:)` do.
 * Only tool failures are retried, never an abort. `before` prepares each attempt.
 */
async function firstWorking(tool: 'ffmpeg' | 'gifski', argSets: string[][], opts: RunOptions, before?: () => Promise<void>) {
  let failure: unknown;
  for (const args of argSets) {
    try { await before?.(); return await run(tool, args, opts); } catch (error) {
      if (!(error instanceof ToolError)) throw error;
      failure = error;
    }
  }
  throw failure;
}
const TRIES = 3;
const tries = (args: string[]) => Array<string[]>(TRIES).fill(args);

/** Progress that never goes backwards, also when a failed attempt is retried. */
function rising(onProgress?: (fraction: number) => void) {
  let last = 0;
  return onProgress && ((fraction: number) => { if (fraction > last) onProgress(last = fraction); });
}

const without = (args: string[], part: string[]) => {
  const at = args.findIndex((_, i) => part.every((value, j) => args[i + j] === value));
  return at < 0 ? args : [...args.slice(0, at), ...args.slice(at + part.length)];
};

async function finish(input: string, file: string, outputDir: string, name: string | undefined, ext: string, signal?: AbortSignal): Promise<MediaOutput> {
  const stem = name ?? path.parse(input).name;
  let output = path.join(outputDir, `${stem}.${ext}`);
  if (path.resolve(output) === path.resolve(input)) output = path.join(outputDir, `${stem}-optimised.${ext}`);
  await retryBusy(() => rename(file, output));
  const info = videoInfo(await ffprobe(output, { signal }));
  return { path: output, bytes: (await stat(output)).size, format: ext, width: info.width, height: info.height, durationMs: info.durationMs };
}

/** Runs `task` with a temporary folder inside `outputDir`, removed afterwards, so results can be renamed into place. */
export async function withTemp<T>(outputDir: string, task: (tmp: string) => Promise<T>) {
  await mkdir(outputDir, { recursive: true });
  const tmp = await mkdtemp(path.join(outputDir, '.clop-'));
  try { return await task(tmp); } finally { await rm(tmp, { recursive: true, force: true }); }
}

/**
 * Optimises, scales, crops, speeds up or converts a video with ffmpeg in one pass, as `Video.optimise`
 * does on macOS. A plain optimisation that is not smaller than the input keeps the input.
 */
export function optimiseVideo(input: string, outputDir: string, opts: Options): Promise<MediaOutput> {
  return queue('video')(() => optimise(input, outputDir, opts));
}

async function optimise(input: string, outputDir: string, opts: Options): Promise<MediaOutput> {
  const { signal } = opts;
  signal?.throwIfAborted();
  const info = videoInfo(await ffprobe(input, { signal }));
  const inputBytes = (await stat(input)).size, inputExt = extension(input);
  const convert = opts.convert, wantsHardwareHEVC = convert?.codec === 'hevc' && (!convert.compression || convert.compression.tier === 'fast');
  const ext = (convert && CONVERSION_EXTENSIONS[convert.codec]) ?? (opts.format ?? (inputExt || 'mp4')).toLowerCase();
  const useEncoder = !!convert || ENCODED_CONTAINERS.has(ext);
  const family = encoderFamily(opts.encoder ?? 'auto');
  const outputCodec = convert?.codec ?? (useEncoder ? family : ext === 'webm' ? 'vp9' : 'h264');
  const toneMap = info.hdr && (opts.hdrToSdr ?? outputCodec === 'h264');
  // Tone mapping ends in 8-bit video, so hardware encoders take 8-bit input then too.
  const tenBit = info.bitDepth > 8 && !toneMap;
  const conversion = convert && videoConversionArgs(convert.codec, convert.compression, wantsHardwareHEVC ? await hevcHardware(opts.encoder) : undefined, tenBit);
  const fps = info.fps;

  const extra: string[] = [];
  let fpsCap: number | undefined;
  if (opts.fps !== undefined) fpsCap = opts.fps;
  else if (opts.capVideoFPS ?? true) {
    let target = opts.targetVideoFPS ?? 60;
    const min = opts.minVideoFPS ?? 30;
    // -2 and -4 mean half and a quarter of the source rate.
    if (target === -2 && fps) target = Math.max(fps / 2, min);
    else if (target === -4 && fps) target = Math.max(fps / 4, min);
    else if (target < 0) target = 60;
    fpsCap = target;
  }
  // A cap at or above the source rate has nothing to drop.
  const capsBelowSource = fpsCap !== undefined && (fps === undefined || fpsCap < fps);
  if (capsBelowSource) extra.push('-fpsmax', String(fpsCap));

  // A long-edge target larger than the source would upscale; that is a no-op (runVideoPipeline).
  let crop = opts.crop;
  if (crop?.longEdge && !crop.isAspectRatio && !crop.cropRect && Math.max(...croppedSize(crop, info.width, info.height)) >= Math.max(info.width, info.height)) crop = undefined;
  const size = opts.width && opts.height ? [even(opts.width), even(opts.height)] as [number, number] : undefined;
  const filters = scaleFilters(info, crop, size);
  const rounded = Number((opts.speed ?? 1).toFixed(2)), speed = rounded > 0 && rounded !== 1 ? rounded : undefined;
  if (speed) {
    filters.push(`setpts=PTS/${speed.toFixed(2)}`);
    // setpts alone keeps every frame, so the rate scales with the speed; resampling to the source rate drops frames instead.
    if (opts.playbackSpeedFrameBehaviour === 'dropFrames' && fps) filters.push(`fps=${fps.toFixed(3)}`);
  }
  // The adaptive tier picks hardware for small or short clips and software for the rest.
  const tier = opts.compression.tier === 'adaptive' ? (adaptiveUsesSoftware(info, inputBytes, opts.adaptiveVideoSize) ? 'smaller' : 'fast') : opts.compression.tier;
  if (toneMap) filters.push(...TONE_MAP);
  if (filters.length) extra.push('-vf', filters.join(','));
  // Variable frame rate sources report their average rate; passing frames through keeps the ones that move.
  if (!capsBelowSource) extra.push('-fps_mode', 'passthrough', '-enc_time_base', filters.length ? 'filter' : 'demux');

  let encoder: string[] = [];
  if (conversion) encoder = conversion.args;
  else if (useEncoder) {
    // Only the fast tier uses hardware, so only it waits for encoder detection.
    const hardware = tier === 'fast' && !opts.aggressive ? (await chooseEncoder(opts.encoder)).hardware : undefined;
    encoder = videoEncoderArgs({ ...opts.compression, tier }, { family, hardware, tenBit }, opts.aggressive);
  }

  const isWebm = ext === 'webm';
  const maps = ['-map', '0:v', '-map', '0:a?'];
  // A speed change has to re-time the audio as well, so it cannot be copied.
  const audioCopy = speed ? ['-c:a', 'aac', '-b:a', '192k'] : ['-c:a', 'copy'];
  const audio = opts.removeAudio ? ['-an']
    : [...(isWebm ? ['-c:a', 'libopus', '-b:a', '128k'] : opts.convertAudioToAAC ? ['-c:a', 'aac', '-b:a', '192k'] : audioCopy), ...maps, ...(speed && info.hasAudio ? ['-af', atempoChain(speed)] : [])];
  const strip = opts.stripMetadata ?? true;
  const metadata = strip ? ['-map_metadata', '-1'] : [];
  const movflags = isWebm ? [] : ['-movflags', strip ? '+faststart' : '+faststart+use_metadata_tags'];

  return withTemp(outputDir, async tmp => {
    const out = path.join(tmp, `video.${ext}`);
    const args = ['-y', '-nostdin', '-hide_banner', '-i', input, ...(useEncoder ? encoder : []), ...audio, ...extra, ...metadata, ...movflags, ...(toneMap ? SDR_TAGS : []), ...PROGRESS, out];
    // Without the stream maps, then also without copying the audio, for inputs those trip up.
    const argSets = [args, without(args, maps), without(args, ['-c:a', 'copy', ...maps])].filter((set, i, all) => all.findIndex(other => other.join('\0') === set.join('\0')) === i);
    const totalUs = info.durationMs ? info.durationMs * 1000 / (speed ?? 1) : undefined;
    const onProgress = rising(opts.onProgress);
    await firstWorking('ffmpeg', argSets, { signal, onStderrLine: ffmpegProgress(totalUs, onProgress) });
    // Only a plain optimisation may hand back the input: an explicitly requested change would be silently dropped.
    // convertAudioToAAC is a standing setting, so like macOS it does not stop the input being kept.
    const plain = !size && !crop && !speed && !conversion && ext === inputExt && !opts.removeAudio && !(toneMap && opts.hdrToSdr);
    if (plain && !opts.allowLarger && (await stat(out)).size >= inputBytes) {
      onProgress?.(1);
      return { path: input, bytes: inputBytes, format: inputExt, width: info.width, height: info.height, durationMs: info.durationMs, unchanged: true };
    }
    const result = await finish(input, out, outputDir, opts.name, ext, signal);
    onProgress?.(1);
    return result;
  });
}

/** `Video.removeAudio`: drops every audio track and copies the video stream as it is. */
export function removeVideoAudio(input: string, outputDir: string, opts: MediaJobOptions & { stripMetadata?: boolean; name?: string } = {}): Promise<MediaOutput> {
  return queue('video')(async () => {
    opts.signal?.throwIfAborted();
    const info = videoInfo(await ffprobe(input, { signal: opts.signal }));
    const ext = extension(input) || 'mp4';
    return withTemp(outputDir, async tmp => {
      const out = path.join(tmp, `video.${ext}`);
      const strip = opts.stripMetadata ?? true;
      const movflags = ext === 'webm' ? [] : ['-movflags', strip ? '+faststart' : '+faststart+use_metadata_tags'];
      const onProgress = rising(opts.onProgress);
      await firstWorking('ffmpeg', tries(['-y', '-nostdin', '-hide_banner', '-i', input, '-an', '-vcodec', 'copy', ...(strip ? ['-map_metadata', '-1'] : []), ...movflags, ...PROGRESS, out]),
        { signal: opts.signal, onStderrLine: ffmpegProgress(info.durationMs && info.durationMs * 1000, onProgress) });
      const result = await finish(input, out, outputDir, opts.name, ext, opts.signal);
      onProgress?.(1);
      return result;
    });
  });
}

export interface VideoToGIFOptions {
  /** Largest GIF width; 960 as on macOS. */
  maxWidth?: number;
  /** Frames per second; 15 as on macOS. */
  fps?: number;
  /** gifski quality 60 instead of 90, for the `useAggressiveOptimisationGIF` setting. */
  aggressive?: boolean;
  name?: string;
}

/**
 * `Video.convertToGIF`: ffmpeg writes the frames as PNG at most `fps` per second, then gifski joins them.
 * Progress runs to one half while ffmpeg extracts frames and to one while gifski encodes them.
 */
export function convertVideoToGIF(input: string, outputDir: string, opts: VideoToGIFOptions & Omit<MediaJobOptions, 'aggressive'> = {}): Promise<MediaOutput> {
  const { maxWidth = 960, fps = 15, signal } = opts;
  const onProgress = rising(opts.onProgress);
  return queue('video')(async () => {
    signal?.throwIfAborted();
    const info = videoInfo(await ffprobe(input, { signal }));
    return withTemp(outputDir, async tmp => {
      const frames = path.join(tmp, 'frames');
      // Each attempt starts from an empty folder, so a failed one leaves no stray frames.
      const emptyFrames = async () => { await rm(frames, { recursive: true, force: true }); await mkdir(frames); };
      await firstWorking('ffmpeg', tries(['-y', '-nostdin', '-hide_banner', '-i', input, ...PROGRESS, '-fpsmax', String(fps), path.join(frames, 'frame%04d.png')]),
        { signal, onStderrLine: ffmpegProgress(info.durationMs && info.durationMs * 1000, onProgress, f => f / 2) }, emptyFrames);
      const pngs = (await readdir(frames)).filter(name => name.endsWith('.png'));
      if (!pngs.length) throw new Error(`${path.basename(input)} has no frames to make a GIF from.`);
      const out = path.join(tmp, 'video.gif');
      // gifski expands the pattern itself on Windows, whose command line could not hold thousands of frame names.
      const files = process.platform === 'win32' ? ['frame*.png'] : pngs;
      await firstWorking('gifski', tries(['-o', out, '--width', String(maxWidth), '--fps', String(fps), '--quality', opts.aggressive ? '60' : '90', ...files]), {
        signal, cwd: frames, onStdoutLine: line => {
          for (const [, frame, total] of line.matchAll(/Frame (\d+) \/ (\d+)/g)) if (+frame > 0) onProgress?.(0.5 + Math.min(+frame / +total, 1) / 2);
        },
      });
      const stem = opts.name ?? path.parse(input).name;
      const output = path.join(outputDir, `${stem}.gif`);
      await retryBusy(() => rename(out, output));
      const meta = await sharp(output, { animated: true }).metadata();
      onProgress?.(1);
      return { path: output, bytes: (await stat(output)).size, format: 'gif', width: meta.width, height: meta.pageHeight ?? meta.height, durationMs: meta.delay?.reduce((sum, delay) => sum + delay, 0) };
    });
  });
}
