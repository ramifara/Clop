import { stat } from 'node:fs/promises';
import path from 'node:path';
import { copyTo, exists } from '../fileops';
import { lowerAudioBitrate, audioMetadata, changeAudioSpeed, optimiseAudio } from '../media/audio';
import { audioFormatFromName, loweredBitrate, outputAudioFormat } from '../media/audioFormat';
import { computedSize, even, type CropSpec } from '../media/crop-size';
import { VIDEO_EXTENSIONS, videoInfo } from '../media/detect';
import { stripExif } from '../media/exif';
import { ffprobe } from '../media/ffprobe';
import { optimiseImage, type ImageFormat } from '../media/image';
import { probeImage } from '../media/image-codecs';
import { fitUnderSize } from '../media/image-ops';
import { optimisePDF, PDF_DPI_ADAPTIVE, PDF_DPI_NO_DOWNSAMPLE, PDF_DPI_STOPS, renderPDFPages } from '../media/pdf';
import { convertVideoToGIF, optimiseVideo, removeVideoAudio, watermarkVideo } from '../media/video';
import { videoEncoderToCompression, type VideoCodecConversion } from '../media/videoCompression';
import type { WatermarkPosition } from '../media/watermark';
import { effectiveBehaviour } from '../placement';
import type { CompressionQuality } from '../settings/schema';
import { applyLocation } from './files';
import { effectiveCompression, parseAspectRatio, stepEntry, stepKind, WATERMARK_POSITIONS, type EncoderQuality, type PipelineStep, type StepKind, type StepParamMap } from './model';
import type { RunState } from './run-state';

// The processing and media steps (PipelineExecution.swift). Consecutive steps the executor batches run as one pass where
// the engine can do them at once (`handleCompiledBatch`): only the batch's result is placed, so `crop -> convert(to: webp)`
// leaves the original alone. Each encode writes into the run's temporary folder; the location then places the result.

type Progress = (fraction: number) => void;
type Params<K extends StepKind> = StepParamMap[K];
const PROCESSING: readonly StepKind[] = ['optimise', 'downscale', 'lowerBitrate', 'convert', 'crop', 'extractPagesAsImages', 'targetSize', 'stripExif', 'watermark'];
const MEDIA: readonly StepKind[] = ['removeAudio', 'changeSpeed', 'capFps', 'normalize'];
/** Iterative or external-tool steps, which run on their own. `extractPagesAsImages` too: macOS would drop it from a batch. */
const SOLO: readonly StepKind[] = ['targetSize', 'stripExif', 'watermark', 'capFps', 'normalize', 'extractPagesAsImages'];
const VIDEO_CODECS: readonly string[] = ['hevc', 'x265', 'av1', 'webm'];

export const isProcessing = (step: PipelineStep) => PROCESSING.includes(stepKind(step)) || MEDIA.includes(stepKind(step));
/** `PipelineStep.location`: processing steps only. */
export const stepLocation = (step: PipelineStep) => { const [kind, p] = stepEntry(step); return PROCESSING.includes(kind) ? (p as { location: string }).location : undefined; };
export const isCompilable = (step: PipelineStep, fileType: string) => {
  const [kind, p] = stepEntry(step);
  return isProcessing(step) && !SOLO.includes(kind) && !(kind === 'convert' && fileType === 'video' && (p as Params<'convert'>).to.toLowerCase() === 'gif');
};

/** `PipelineStep.cropSize`: an aspect ratio wins over pixel sizes; `longEdge` puts the edge in both. */
export function cropSpec({ width, height, longEdge, aspectRatio, smartCrop }: Params<'crop'>): CropSpec {
  const ratio = aspectRatio === undefined ? undefined : parseAspectRatio(aspectRatio);
  if (ratio) return { ...ratio, isAspectRatio: true, longEdge: false, smartCrop };
  return longEdge !== undefined ? { width: longEdge, height: longEdge, longEdge: true, smartCrop } : { width: width ?? 0, height: height ?? 0, longEdge: false, smartCrop };
}

/** `cropChangesSize`: pixel crops only apply to a bigger source, ratio crops to a source of another shape. */
export function cropChangesSize(crop: CropSpec, width: number, height: number) {
  if (!(width > 0 && height > 0)) return false;
  if (crop.isAspectRatio) { const target = computedSize(crop, width, height); return even(target.width) < even(width) || even(target.height) < even(height); }
  if (crop.longEdge) return crop.width > 0 && Math.max(width, height) > crop.width;
  return (crop.width > 0 && width > crop.width) || (crop.height > 0 && height > crop.height);
}

/** `pdfDPIForEncoder`: each encoder preset fixes a DPI; an explicit `dpi:` wins. */
const pdfDPIForEncoder = (encoder?: EncoderQuality) => encoder === 'lossless' ? PDF_DPI_NO_DOWNSAMPLE : encoder === 'medium' ? PDF_DPI_ADAPTIVE : encoder === 'aggressive' ? 100 : undefined;

/** Where a convert step's result goes: an unset (`sameFolder`) location follows the manual conversion setting or the request's override. */
export function convertLocation(run: RunState, location: string): string {
  if (location !== 'sameFolder') return location;
  const { env, placementOverride } = run.opts;
  switch (effectiveBehaviour(env, run.fileType, 'manualConvert', placementOverride)) {
    case 'inPlace': return 'inPlace';
    case 'temporary': return 'temporaryFolder';
    case 'specificFolder': {
      const key = `convertedSpecificFolderNameTemplate${({ image: 'Image', video: 'Video', audio: 'Audio' } as Record<string, string>)[run.fileType] ?? ''}`;
      return placementOverride?.specificFolderTemplate ?? (run.settings as unknown as Record<string, string | undefined>)[key] ?? location;
    }
    default: return location;
  }
}

/** Splits a batch into passes the engine can encode at once: a second step of one exclusive group starts the next pass. */
function passes(batch: PipelineStep[], group: (kind: StepKind) => string | undefined): PipelineStep[][] {
  const out: PipelineStep[][] = [];
  let current: PipelineStep[] = [], taken = new Set<string>();
  for (const step of batch) {
    const key = group(stepKind(step));
    if (key && taken.has(key)) { out.push(current); current = []; taken = new Set(); }
    if (key) taken.add(key);
    current.push(step);
  }
  return [...out, current];
}
const params = <K extends StepKind>(steps: PipelineStep[], kind: K) => steps.filter(step => stepKind(step) === kind).map(step => (step as Record<K, Params<K>>)[kind]);

/** The compression, aggressiveness and encoder an `optimise` sets, over the setting's compression. */
function optimiseSettings(steps: PipelineStep[], fallback: CompressionQuality) {
  let compression = fallback, aggressive = false, encoder: EncoderQuality | undefined, dpi: number | undefined;
  const optimise = params(steps, 'optimise');
  for (const p of optimise) {
    if (p.compression) compression = effectiveCompression(p.compression);
    aggressive ||= p.encoder === 'aggressive';
    encoder = p.encoder; dpi = p.dpi ?? dpi;
  }
  return { compression, aggressive, encoder, dpi, adaptive: optimise.some(p => p.adaptive), videoEncoder: optimise.filter(p => p.videoEncoder).at(-1)?.videoEncoder, optimises: optimise.length > 0 };
}

const settingsOf = (run: RunState) => run.settings;
const imageBase = (run: RunState) => { const s = settingsOf(run); return { stripMetadata: s.stripMetadata, preserveColorMetadata: s.preserveColorMetadata, gifFrameDropBehaviour: s.gifFrameDropBehaviour, signal: run.signal }; };
const videoBase = (run: RunState) => {
  const s = settingsOf(run);
  return {
    compression: s.videoCompression, encoder: s.videoEncoder, capVideoFPS: s.capVideoFPS, targetVideoFPS: s.targetVideoFPS, minVideoFPS: s.minVideoFPS, removeAudio: s.removeAudioFromVideos,
    convertAudioToAAC: s.convertAudioToAAC, adaptiveVideoSize: s.adaptiveVideoSize, stripMetadata: s.stripMetadata, playbackSpeedFrameBehaviour: s.playbackSpeedFrameBehaviour, signal: run.signal,
  };
};
const audioBase = (run: RunState) => {
  const s = settingsOf(run);
  return { compression: s.audioCompression, formatsToConvertToAAC: s.formatsToConvertToAAC, formatsToConvertToMP3: s.formatsToConvertToMP3, coverArt: s.audioCoverArt, preserveDates: s.preserveDates, signal: run.signal };
};

function imageFormat(to: string): ImageFormat {
  const format = to.toLowerCase() === 'jpg' ? 'jpeg' : to.toLowerCase();
  if (!['png', 'jpeg', 'webp', 'avif', 'gif', 'heic', 'jxl'].includes(format)) throw new Error(`Clop cannot convert images to ${to}. Use webp, avif, heic, jxl, jpeg, png or gif.`);
  return format as ImageFormat;
}

async function encodeImage(run: RunState, batch: PipelineStep[], progress: Progress): Promise<string> {
  let file = run.current;
  const all = passes(batch, kind => kind === 'crop' || kind === 'downscale' ? 'geometry' : undefined);
  for (const [n, steps] of all.entries()) {
    const { compression, aggressive, encoder, adaptive, optimises } = optimiseSettings(steps, run.settings.imageCompression);
    const converts = params(steps, 'convert'), crop = params(steps, 'crop')[0], factor = params(steps, 'downscale')[0]?.factor;
    const info = await probeImage(file, run.signal);
    const cropSize = crop && cropChangesSize(cropSpec(crop), info.width, info.height) ? cropSpec(crop) : undefined;
    // A crop the image already fits does nothing on its own (`handleCrop`).
    if (crop && !cropSize && !optimises && !converts.length) continue;
    const size = factor !== undefined && factor < 1 ? { width: Math.max(1, Math.round(info.width * factor)), height: Math.max(1, Math.round(info.height * factor)) } : {};
    // Windows has a truly lossless image tier, so `encoder: lossless` uses it.
    const tier = encoder === 'lossless' ? { tier: 'lossless' as const, factor: compression.factor } : adaptive ? { tier: 'adaptive' as const, factor: compression.factor } : compression;
    const output = await optimiseImage(file, await run.scratch(), {
      ...imageBase(run), compression: tier, aggressive, format: converts.length ? imageFormat(converts.at(-1)!.to) : undefined, cropSize, ...size,
      onProgress: f => progress((n + f) / all.length),
    });
    file = output.path;
  }
  return file;
}

function videoConversion(to: string): { convert?: { codec: VideoCodecConversion }; format?: string } {
  const lower = to.toLowerCase();
  if (VIDEO_CODECS.includes(lower)) return { convert: { codec: lower as VideoCodecConversion } };
  if (VIDEO_EXTENSIONS.includes(lower)) return { format: lower };
  throw new Error(`Clop cannot convert videos to ${to}. Use mp4, mov, hevc, x265, av1, webm or gif.`);
}

async function encodeVideo(run: RunState, batch: PipelineStep[], progress: Progress): Promise<string> {
  let file = run.current;
  const all = passes(batch, kind => kind === 'crop' || kind === 'downscale' ? 'geometry' : kind === 'changeSpeed' ? 'speed' : undefined);
  for (const [n, steps] of all.entries()) {
    const onProgress = (f: number) => progress((n + f) / all.length), dir = await run.scratch();
    if (steps.every(step => 'removeAudio' in step)) { file = (await removeVideoAudio(file, dir, { stripMetadata: run.settings.stripMetadata, signal: run.signal, onProgress })).path; continue; }
    const info = videoInfo(await ffprobe(file, { signal: run.signal }));
    const { compression, aggressive, videoEncoder, optimises } = optimiseSettings(steps, run.settings.videoCompression);
    const crop = params(steps, 'crop')[0], factor = params(steps, 'downscale')[0]?.factor, speed = params(steps, 'changeSpeed')[0], converts = params(steps, 'convert');
    const cropSize = crop && cropChangesSize(cropSpec(crop), info.width, info.height) ? cropSpec(crop) : undefined;
    if (steps.every(step => 'crop' in step) && !cropSize) continue;
    const size = factor !== undefined && factor < 1 ? { width: info.width * factor, height: info.height * factor } : {};
    const output = await optimiseVideo(file, dir, {
      ...videoBase(run), compression: optimises && !params(steps, 'optimise').some(p => p.compression) && videoEncoder ? videoEncoderToCompression(videoEncoder) : compression, aggressive,
      ...(converts.length ? videoConversion(converts.at(-1)!.to) : {}), crop: cropSize, ...size,
      ...(speed ? { speed: speed.factor, playbackSpeedFrameBehaviour: speed.frames ?? run.settings.playbackSpeedFrameBehaviour } : {}),
      removeAudio: steps.some(step => 'removeAudio' in step) || run.settings.removeAudioFromVideos, onProgress,
    });
    file = output.path;
  }
  return file;
}

async function encodeAudio(run: RunState, batch: PipelineStep[], progress: Progress): Promise<string> {
  let file = run.current;
  // A speed change is its own encode; the steps between speed changes share one.
  const all: PipelineStep[][] = [];
  for (const step of batch) {
    const last = all.at(-1);
    if (!last || 'changeSpeed' in step || 'changeSpeed' in last[0]) all.push([step]); else last.push(step);
  }
  for (const [n, steps] of all.entries()) {
    const onProgress = (f: number) => progress((n + f) / all.length), dir = await run.scratch();
    const speed = params(steps, 'changeSpeed')[0];
    if (speed) { file = (await changeAudioSpeed(file, dir, speed.factor, { name: path.parse(file).name, preserveDates: run.settings.preserveDates, signal: run.signal, onProgress })).path; continue; }
    const { compression, aggressive } = optimiseSettings(steps, run.settings.audioCompression);
    const to = params(steps, 'convert').at(-1)?.to, format = to === undefined ? undefined : audioFormatFromName(to);
    if (to !== undefined && !format) throw new Error(`Clop cannot convert audio to ${to}. Use m4a, mp3, ogg, opus, flac, wav or aiff.`);
    // lowerBitrate wins over downscale; the last of each counts.
    const kbps = params(steps, 'lowerBitrate').at(-1)?.kbps, factor = params(steps, 'downscale').at(-1)?.factor;
    const opts = { ...audioBase(run), compression, aggressive, format, onProgress };
    const output = kbps !== undefined || factor !== undefined
      ? await lowerAudioBitrate(file, dir, kbps !== undefined ? { kbps } : { factor: factor! }, opts)
      : await optimiseAudio(file, dir, { ...opts, allowLarger: format !== undefined });
    file = output.path;
  }
  return file;
}

async function encodePDF(run: RunState, batch: PipelineStep[], progress: Progress): Promise<string> {
  const { aggressive, encoder, dpi } = optimiseSettings(batch, run.settings.imageCompression);
  const output = await optimisePDF(run.current, await run.scratch(), { dpiSetting: run.settings.pdfDPI, dpi: dpi ?? pdfDPIForEncoder(encoder), aggressive, signal: run.signal, onProgress: progress });
  return output.path;
}

/** `handleCompiledBatch`: runs consecutive processing and media steps, then places the result where the last located step says. */
export async function runBatch(run: RunState, batch: PipelineStep[], progress: Progress) {
  let location = batch.map(stepLocation).filter(where => where !== undefined && where !== 'inPlace').at(-1) ?? 'inPlace';
  if (batch.some(step => 'convert' in step)) location = convertLocation(run, location);
  const input = run.current;
  const encode = { image: encodeImage, video: encodeVideo, audio: encodeAudio, pdf: encodePDF }[run.fileType];
  run.current = await applyLocation(run, location, await encode(run, batch, progress), input);
}

/** The steps that run on their own. */
export async function runSolo(run: RunState, step: PipelineStep, progress: Progress) {
  const [kind, p] = stepEntry(step), input = run.current, { signal } = run;
  const place = async (location: string, result: string) => { run.current = await applyLocation(run, location, result, input); };
  switch (kind) {
    case 'convert': {
      // Only a video to GIF gets here: gifski makes it, outside the ffmpeg pass.
      const gif = await convertVideoToGIF(input, await run.scratch(), { maxWidth: 960, fps: 15, aggressive: run.settings.useAggressiveOptimisationGIF, signal, onProgress: progress });
      return place(convertLocation(run, p.location), gif.path);
    }
    case 'targetSize': {
      if ((await stat(input)).size <= p.bytes) return p.location !== 'inPlace' ? place(p.location, input) : undefined;
      return place(p.location, await fitUnder(run, p.bytes, progress));
    }
    case 'stripExif': {
      const copy = await copyTo(input, path.join(await run.scratch(), path.basename(input)));
      await stripExif(copy, { preserveColour: run.settings.preserveColorMetadata, signal });
      return place('inPlace', copy);
    }
    case 'watermark': {
      const file = run.resolve(p.image);
      if (!await exists(file)) throw new Error(`Watermark image not found: ${file}`);
      const watermark = { file, position: (WATERMARK_POSITIONS.includes(p.position as WatermarkPosition) ? p.position : 'bottomRight') as WatermarkPosition, opacity: p.opacity, scale: p.scale };
      const dir = await run.scratch();
      const output = run.fileType === 'image'
        ? await optimiseImage(input, dir, { ...imageBase(run), compression: run.settings.imageCompression, watermark, onProgress: progress })
        : await watermarkVideo(input, dir, { watermark, signal, onProgress: progress });
      return place(p.location, output.path);
    }
    case 'capFps': return place('inPlace', (await optimiseVideo(input, await run.scratch(), { ...videoBase(run), fps: p.fps, allowLarger: true, onProgress: progress })).path);
    case 'normalize': return place('inPlace', (await optimiseAudio(input, await run.scratch(), { ...audioBase(run), loudnorm: p.lufs, allowLarger: true, onProgress: progress })).path);
    case 'extractPagesAsImages': return extractPages(run, p, progress);
  }
}

/** `handleExtractPagesAsImages`: renders every page, optimises each image, and carries on with the image of a one-page PDF. */
async function extractPages(run: RunState, { format, quality, location }: Params<'extractPagesAsImages'>, progress: Progress) {
  const input = run.current;
  const dir = location === 'temporaryFolder' ? await run.scratch()
    : location !== 'sameFolder' && /[\\/]/.test(location) ? path.resolve(path.dirname(input), run.resolve(location)) : path.dirname(input);
  const pages = await renderPDFPages(input, dir, {
    format: format === 'png' ? 'png' : 'jpeg', scale: quality === 'low' ? 1 : quality === 'high' ? 3 : 2, optimise: run.settings.imageCompression, signal: run.signal, onProgress: progress,
  });
  for (const page of pages) { await run.mark(page.path); run.pages.push(page.path); }
  if (pages.length === 1) run.current = pages[0].path;
}

/** `handleTargetSize`: compresses until the file fits under `bytes`, by the strategy of each type. */
async function fitUnder(run: RunState, bytes: number, progress: Progress): Promise<string> {
  const input = run.current, { signal } = run;
  switch (run.fileType) {
    case 'image': return (await fitUnderSize(input, await run.scratch(), { ...imageBase(run), bytes, onProgress: progress })).path;
    case 'pdf': {
      // Bisects the DPI stops below 300 for the highest that fits, then re-encodes the winner if a later probe overshot.
      const stops = [...PDF_DPI_STOPS].sort((a, b) => b - a).slice(1);
      const encode = async (dpi: number) => (await optimisePDF(input, await run.scratch(), { dpi, aggressive: true, allowLarger: true, signal })).path;
      let low = 0, high = stops.length - 1, chosen: number | undefined, last: number | undefined, result: string | undefined;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        result = await encode(stops[mid]); last = stops[mid];
        if ((await stat(result)).size <= bytes) { chosen = stops[mid]; high = mid - 1; } else low = mid + 1;
        progress(1 - (high - low + 1) / stops.length);
      }
      return chosen !== undefined && chosen !== last ? encode(chosen) : result!;
    }
    case 'audio': {
      const info = await audioMetadata(input, { signal });
      if (!info.durationMs) throw new Error(`Clop cannot read how long ${path.basename(input)} is, so it cannot fit it under a size.`);
      const kbps = Math.trunc(bytes * 8 * 0.95 / (info.durationMs / 1000) / 1000);
      const format = outputAudioFormat(path.extname(input).slice(1), run.settings);
      const bitrate = loweredBitrate(format, kbps, info.bitrate === undefined ? undefined : Math.trunc(info.bitrate / 1000)) ?? kbps;
      return (await optimiseAudio(input, await run.scratch(), { ...audioBase(run), bitrate, allowLarger: true, onProgress: progress })).path;
    }
    case 'video': return fitVideoUnder(run, bytes, progress);
  }
}

/**
 * `targetSizeVideo`: libx264 at the average bitrate that fits (7 % container margin, 128 kbps for audio), dropping to 30 fps and
 * then scaling down when the bits per pixel get too low, with one retry aimed lower when the encoder overshoots.
 */
async function fitVideoUnder(run: RunState, bytes: number, progress: Progress): Promise<string> {
  const input = run.current, info = videoInfo(await ffprobe(input, { signal: run.signal }));
  const ext = path.extname(input).slice(1).toLowerCase(), format = ['mp4', 'mov', 'm4v', 'mkv'].includes(ext) ? ext : 'mp4';
  const base = { ...videoBase(run), format, allowLarger: true };
  if (!info.durationMs) return (await optimiseVideo(input, await run.scratch(), { ...base, aggressive: true, onProgress: progress })).path;
  const encode = async (target: number, half: number) => {
    const videoKbps = Math.max(40, target * 8 * 0.93 / (info.durationMs! / 1000) / 1000 - 128);
    const encoderArgs = ['-vcodec', 'libx264', '-preset', 'fast', '-b:v', `${Math.trunc(videoKbps)}k`, '-maxrate', `${Math.trunc(videoKbps * 1.2)}k`, '-bufsize', `${Math.trunc(videoKbps * 2)}k`];
    let size = {};
    if (info.width > 0 && info.height > 0) {
      const fps = info.fps ?? 30;
      let bpp = videoKbps * 1000 / (info.width * info.height * Math.max(fps, 1));
      if (bpp < 0.04 && fps > 30) { encoderArgs.push('-r', '30'); bpp *= fps / 30; }
      if (bpp < 0.04) { const scale = Math.max(0.25, Math.sqrt(bpp / 0.04)); size = { width: info.width * scale, height: info.height * scale }; }
    }
    return optimiseVideo(input, await run.scratch(), { ...base, encoderArgs, ...size, onProgress: f => progress((half + f) / 2) });
  };
  let result = await encode(bytes, 0);
  if (result.bytes > bytes) result = await encode(Math.trunc(bytes * bytes / result.bytes * 0.95), 1);
  return result.path;
}
