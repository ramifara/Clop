import type { AudioFormat } from '../media/audioFormat';
import type { CoverArtBehaviour, CoverArtSquaring } from '../media/coverArt';
import type { CropSpec } from '../media/crop-size';
import type { MediaKind } from '../media/types';
import type { ClopSettings } from '../settings/schema';

// BatchParams in BatchOptimiser.swift with the knobs of BatchParamsModel (BatchPrepView.swift). Pure data, so the
// renderer can build one and the main process can check it.

export type ImageConvert = 'jpeg' | 'png' | 'webp' | 'jxl';
export type VideoConvert = 'mp4' | 'hevc' | 'av1' | 'webm';
/** VideoEncoderChoice: adaptive, faster (hardware), smaller file (software) and visually lossless. */
export type VideoEncoderTier = 'adaptive' | 'fast' | 'smaller' | 'lossless';
/** PDFDPIMode: adapt to the PDF's images, a fixed DPI, or one stop below each file's own. */
export type PDFDPIMode = 'adaptive' | 'stepDown' | number;
export type BatchAudioFormat = Exclude<AudioFormat, 'aiff'>;
/**
 * Where results go: over the originals, next to them under a name template, or into a folder under a name template.
 * The templates are the placement templates (`%f-optimised`, `%f`), so `%i` and the date tokens work here too.
 */
export type BatchOutput = { location: 'inPlace' } | { location: 'sameFolder'; template: string } | { location: 'folder'; folder: string; template: string };

export interface ImageBatchParams {
  /** Compression factor 0–100. */
  compression: number;
  /** PNG ↔ JPEG, whichever is smaller (the adaptive tier). */
  adaptive: boolean;
  /** The lossless tier: the compression factor does not apply. */
  lossless?: boolean;
  convert?: ImageConvert;
  /** Scale factor under 1. */
  downscale?: number;
  maxLongEdge?: number;
  /** An exact crop, which wins over the long edge and the factor. */
  crop?: CropSpec;
  /** Keep a converted result even when it is larger. */
  allowLarger: boolean;
}
export interface VideoBatchParams {
  compression: number; encoder: VideoEncoderTier; convert?: VideoConvert; downscale?: number; maxLongEdge?: number; crop?: CropSpec;
  /** A frame rate cap; without one the `capVideoFPS` settings apply. */
  fps?: number;
  removeAudio: boolean; allowLarger: boolean;
}
/** A PDF crop is an aspect ratio applied to every page. */
export interface PDFBatchParams { dpi: PDFDPIMode; crop?: CropSpec }
export interface AudioBatchParams {
  compression: number;
  /** kbps, overriding the compression factor. */
  bitrate?: number;
  format?: BatchAudioFormat;
  /** Also convert WAV, AIFF and FLAC inputs to `format`. */
  convertLossless: boolean;
  /** Loudness target in LUFS. */
  loudnorm?: number;
  coverArt: CoverArtBehaviour; coverArtMaxLongEdge?: number; coverArtSquaring: CoverArtSquaring;
  allowLarger: boolean;
}
export interface BatchParams {
  /** The aggressive flag of an aggressive drop. */
  aggressive?: boolean;
  output: BatchOutput;
  image: ImageBatchParams; video: VideoBatchParams; pdf: PDFBatchParams; audio: AudioBatchParams;
}

export const IMAGE_CONVERTS: readonly ImageConvert[] = ['jpeg', 'png', 'webp', 'jxl'];
export const VIDEO_CONVERTS: readonly VideoConvert[] = ['mp4', 'hevc', 'av1', 'webm'];
export const VIDEO_ENCODER_TIERS: readonly VideoEncoderTier[] = ['adaptive', 'fast', 'smaller', 'lossless'];
export const PDF_DPIS: readonly number[] = [300, 250, 200, 150, 100, 72, 48];
export const BATCH_AUDIO_FORMATS: readonly BatchAudioFormat[] = ['aac', 'mp3', 'opus', 'wav', 'flac'];
/** LoudnessChoice: streaming, Apple Music, podcast and broadcast targets. */
export const LOUDNESS_TARGETS: readonly number[] = [-14, -16, -19, -23];
const COVER_ART: readonly CoverArtBehaviour[] = ['optimise', 'remove', 'keep'];
const SQUARING: readonly CoverArtSquaring[] = ['landscapeOnly', 'always', 'never'];

/** `BatchParamsModel.seedFromDefaults` then `toBatchParams`: the batch as the current settings would optimise each file. */
export function defaultBatchParams(s: Pick<ClopSettings, 'imageCompression' | 'adaptiveImageSize' | 'videoCompression' | 'capVideoFPS' | 'targetVideoFPS' | 'removeAudioFromVideos' | 'pdfDPI' | 'audioCompression' | 'audioCoverArt'>, aggressive?: boolean): BatchParams {
  const tier = s.videoCompression.tier;
  return {
    ...(aggressive === undefined ? {} : { aggressive }),
    output: { location: 'inPlace' },
    image: { compression: s.imageCompression.factor, adaptive: s.adaptiveImageSize || s.imageCompression.tier === 'adaptive', ...(s.imageCompression.tier === 'lossless' ? { lossless: true } : {}), allowLarger: true },
    video: {
      compression: s.videoCompression.factor, encoder: tier === 'custom' ? 'smaller' : tier, removeAudio: s.removeAudioFromVideos, allowLarger: true,
      ...(s.capVideoFPS && s.targetVideoFPS > 0 ? { fps: Math.round(s.targetVideoFPS) } : {}),
    },
    pdf: { dpi: s.pdfDPI === 0 ? 'adaptive' : s.pdfDPI },
    audio: { compression: s.audioCompression.factor, convertLossless: false, coverArt: s.audioCoverArt, coverArtSquaring: 'landscapeOnly', allowLarger: true },
  };
}

/** The kinds of files a batch can hold, in the order the table groups them. */
export const BATCH_KINDS: readonly MediaKind[] = ['image', 'video', 'pdf', 'audio'];

type Fields = Record<string, unknown>;
const isRecord = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const fail = (what: string): never => { throw new Error(`The batch settings are not valid: ${what}.`); };
function record(value: unknown, what: string) { return isRecord(value) ? value : fail(what); }
function bool(value: unknown, what: string) { return typeof value === 'boolean' ? value : fail(what); }
function int(value: unknown, what: string, min: number, max: number) { return Number.isInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fail(what); }
function optional<T>(value: unknown, parse: (value: unknown) => T): T | undefined { return value === undefined || value === null ? undefined : parse(value); }
function oneOf<T>(value: unknown, list: readonly T[], what: string): T { return list.includes(value as T) ? value as T : fail(what); }
const factor = (value: unknown, what: string) => typeof value === 'number' && value > 0.04 && value < 1 ? value : fail(what);
const template = (value: unknown, what: string) => typeof value === 'string' && value.trim() && value.length <= 512 ? value : fail(what);

/**
 * Checks the name template of a batch's output, which is expanded into a path: next to the original it is a file name, so it
 * cannot hold a separator; in a folder it may add subfolders, but never reach out of that folder (`..`), start somewhere else
 * (a root, a drive, a share) or name another file's folder (`%P`, `%F`). Throws a reason; used for requests from the window
 * and by `Batch` itself, so no caller can place a result outside the folder it was given.
 */
export function checkOutputTemplate(output: BatchOutput) {
  if (output.location === 'inPlace') return;
  const text = template(output.template, 'name template');
  if (output.location === 'sameFolder') { if (/[\\/]/.test(text)) fail('name template, which names a file and cannot hold a folder'); return; }
  if (text.split(/[\\/]/).includes('..') || /^[\\/]|:|%[PF]/.test(text)) fail('name template, which must stay inside the chosen folder');
}

/** A crop size with whole-pixel width and height (0 for one side scales to the other) and an optional relative rectangle. */
export function parseCrop(value: unknown): CropSpec {
  const c = record(value, 'crop size');
  const width = int(c.width, 'crop width', 0, 16383), height = int(c.height, 'crop height', 0, 16383);
  if (!width && !height) fail('crop size without a width or height');
  const flag = (key: string) => optional(c[key], v => bool(v, key));
  const rect = optional(c.cropRect, v => {
    const r = record(v, 'crop rectangle'), n = (key: string) => typeof r[key] === 'number' && Number.isFinite(r[key]) && (r[key] as number) >= 0 && (r[key] as number) <= 1 ? r[key] as number : fail('crop rectangle');
    return { x: n('x'), y: n('y'), width: n('width'), height: n('height') };
  });
  return { width, height, ...strip({ longEdge: flag('longEdge'), smartCrop: flag('smartCrop'), isAspectRatio: flag('isAspectRatio'), cropRect: rect }) };
}
const strip = <T extends Fields>(value: T) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };

const checked = (output: BatchOutput) => { checkOutputTemplate(output); return output; };
function parseOutput(value: unknown, isAbsolute: (folder: string) => boolean): BatchOutput {
  const o = record(value, 'save location');
  switch (o.location) {
    case 'inPlace': return { location: 'inPlace' };
    case 'sameFolder': return checked({ location: 'sameFolder', template: template(o.template, 'name template') });
    case 'folder': {
      const folder = typeof o.folder === 'string' && isAbsolute(o.folder) ? o.folder : fail('folder');
      return checked({ location: 'folder', folder, template: template(o.template, 'name template') });
    }
    default: return fail('save location');
  }
}

/** Checks batch parameters from the renderer, keeping only known fields. `isAbsolute` decides what counts as a folder path. */
export function parseBatchParams(value: unknown, isAbsolute: (folder: string) => boolean): BatchParams {
  const p = record(value, 'parameters');
  const i = record(p.image, 'image parameters'), v = record(p.video, 'video parameters'), d = record(p.pdf, 'PDF parameters'), a = record(p.audio, 'audio parameters');
  const compression = (value: unknown, what: string) => int(value, what, 0, 100);
  const edge = (value: unknown) => optional(value, v => int(v, 'long edge', 1, 16383));
  const image: ImageBatchParams = {
    compression: compression(i.compression, 'image compression'), adaptive: bool(i.adaptive, 'adaptive'), allowLarger: bool(i.allowLarger, 'keep if larger'),
    ...strip({ lossless: optional(i.lossless, x => bool(x, 'lossless')) || undefined, convert: optional(i.convert, x => oneOf(x, IMAGE_CONVERTS, 'image format')), downscale: optional(i.downscale, x => factor(x, 'image downscale')), maxLongEdge: edge(i.maxLongEdge), crop: optional(i.crop, parseCrop) }),
  };
  const video: VideoBatchParams = {
    compression: compression(v.compression, 'video compression'), encoder: oneOf(v.encoder, VIDEO_ENCODER_TIERS, 'video encoder'), removeAudio: bool(v.removeAudio, 'remove audio'), allowLarger: bool(v.allowLarger, 'keep if larger'),
    ...strip({ convert: optional(v.convert, x => oneOf(x, VIDEO_CONVERTS, 'video format')), downscale: optional(v.downscale, x => factor(x, 'video downscale')), maxLongEdge: edge(v.maxLongEdge), crop: optional(v.crop, parseCrop), fps: optional(v.fps, x => int(x, 'frame rate', 1, 240)) }),
  };
  const pdf: PDFBatchParams = {
    dpi: d.dpi === 'adaptive' || d.dpi === 'stepDown' ? d.dpi : oneOf(d.dpi, PDF_DPIS, 'PDF resolution'),
    ...strip({ crop: optional(d.crop, x => { const crop = parseCrop(x); return crop.isAspectRatio && crop.width && crop.height ? crop : fail('PDF crop, which must be an aspect ratio'); }) }),
  };
  const audio: AudioBatchParams = {
    compression: compression(a.compression, 'audio compression'), convertLossless: bool(a.convertLossless, 'convert lossless'), coverArt: oneOf(a.coverArt, COVER_ART, 'cover art'),
    coverArtSquaring: oneOf(a.coverArtSquaring, SQUARING, 'cover art squaring'), allowLarger: bool(a.allowLarger, 'keep if larger'),
    ...strip({ bitrate: optional(a.bitrate, x => int(x, 'bitrate', 8, 512)), format: optional(a.format, x => oneOf(x, BATCH_AUDIO_FORMATS, 'audio format')), loudnorm: optional(a.loudnorm, x => oneOf(x, LOUDNESS_TARGETS, 'loudness')), coverArtMaxLongEdge: edge(a.coverArtMaxLongEdge) }),
  };
  return { ...strip({ aggressive: optional(p.aggressive, x => bool(x, 'aggressive')) }), output: parseOutput(p.output, isAbsolute), image, video, pdf, audio };
}
