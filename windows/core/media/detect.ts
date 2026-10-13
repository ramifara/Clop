import { open } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ToolError } from '../run';
import { ffprobe, probeNumber, probeRate, type FFprobeResult, type FFprobeStream } from './ffprobe';
import type { MediaKind } from './types';

// IMAGE_FORMATS, VIDEO_FORMATS and AUDIO_FORMATS in Shared.swift, with each type's usual extensions. SVG is rasterised as an image.
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'heic', 'heif', 'jxl', 'bmp', 'tif', 'tiff', 'svg'];
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'qt', 'm4v', 'webm', 'mkv', 'avi', 'm2v', 'mpg', 'mpeg'];
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'aif', 'aiff', 'flac', 'ogg', 'opus'];

const KIND_BY_EXTENSION = new Map<string, MediaKind>([
  ...IMAGE_EXTENSIONS.map(ext => [ext, 'image'] as const), ...VIDEO_EXTENSIONS.map(ext => [ext, 'video'] as const),
  ...AUDIO_EXTENSIONS.map(ext => [ext, 'audio'] as const), ['pdf', 'pdf'],
]);
// ffprobe reads still images through these demuxers; they are images, not one-frame videos.
const IMAGE_DEMUXER = /^(image2|.+_pipe|gif|webp|apng)$/;
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

export interface VideoInfo {
  kind: 'video'; format: string; width: number; height: number; durationMs?: number; fps?: number; hasAudio: boolean;
  /** ffprobe's codec name (`h264`, `hevc`, `av1`, `vp9`) and the container's tag for it (`avc1`, `hvc1`). */
  codec?: string; codecTag?: string; pixelFormat?: string; bitDepth: number; bitrate?: number;
  /** Transfer characteristic; `smpte2084` (PQ) and `arib-std-b67` (HLG) are HDR. */
  transfer?: string; hdr: boolean;
}
export interface AudioInfo { kind: 'audio'; format: string; durationMs?: number; codec?: string; bitrate?: number; sampleRate?: number; channels?: number; hasCoverArt: boolean }
export interface ImageInfo { kind: 'image'; format: string; width?: number; height?: number; pages?: number }
export interface PdfInfo { kind: 'pdf'; format: 'pdf' }
export type MediaInfo = VideoInfo | AudioInfo | ImageInfo | PdfInfo;

const extension = (file: string) => path.extname(file).slice(1).toLowerCase();
const isCoverArt = (stream: FFprobeStream) => stream.disposition?.attached_pic === 1;
const mainStream = (probe: FFprobeResult, type: 'video' | 'audio') => probe.streams.find(stream => stream.codec_type === type && !isCoverArt(stream));
const ms = (seconds: number | undefined) => seconds === undefined ? undefined : Math.round(seconds * 1000);

async function startsWithPDF(file: string) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(5);
    await handle.read(header, 0, 5, 0);
    return header.toString('latin1') === '%PDF-';
  } finally { await handle.close(); }
}

/** Probes a file ffmpeg can read, or undefined when it cannot. */
const tryProbe = (file: string, signal?: AbortSignal) => ffprobe(file, { signal }).catch(error => { if (error instanceof ToolError || error instanceof SyntaxError) return undefined; throw error; });

function kindOfProbe(probe: FFprobeResult): MediaKind | undefined {
  if (IMAGE_DEMUXER.test(probe.format.format_name)) return 'image';
  if (mainStream(probe, 'video')) return 'video';
  if (mainStream(probe, 'audio')) return 'audio';
}

/** The media type of a file: by its extension, or for an unknown one by its content. Undefined when Clop cannot handle it. */
export async function detectKind(file: string, { signal }: { signal?: AbortSignal } = {}): Promise<MediaKind | undefined> {
  const known = KIND_BY_EXTENSION.get(extension(file));
  if (known) return known;
  if (await startsWithPDF(file)) return 'pdf';
  const probe = await tryProbe(file, signal);
  return probe && kindOfProbe(probe);
}

/** Width, height, duration and the other facts Clop needs about a file before processing it. */
export async function probe(file: string, { signal }: { signal?: AbortSignal } = {}): Promise<MediaInfo> {
  const kind = await detectKind(file, { signal });
  if (!kind) throw new Error(`Clop cannot read ${path.basename(file)}: it is not an image, video, audio file or PDF.`);
  if (kind === 'pdf') return { kind, format: 'pdf' };
  if (kind === 'image') {
    const meta = await sharp(file, { animated: true }).metadata().catch(() => undefined);
    return { kind, format: meta?.format ?? extension(file), width: meta?.width, height: meta?.pageHeight ?? meta?.height, pages: meta?.pages };
  }
  const result = await ffprobe(file, { signal });
  return kind === 'video' ? videoInfo(result) : audioInfo(result);
}

/** `getVideoMetadata` (Video.swift): the first video track's displayed size, frame rate and codec, and whether there is audio. */
export function videoInfo(result: FFprobeResult): VideoInfo {
  const video = mainStream(result, 'video');
  if (!video) throw new Error(`${path.basename(result.format.filename)} has no video track.`);
  const rotation = video.side_data_list?.find(data => data.rotation !== undefined)?.rotation ?? probeNumber(video.tags?.rotate) ?? 0;
  const sideways = Math.abs(rotation) % 180 === 90;
  const width = video.width ?? 0, height = video.height ?? 0;
  const pixelFormat = video.pix_fmt;
  return {
    kind: 'video', format: result.format.format_name, width: sideways ? height : width, height: sideways ? width : height,
    durationMs: ms(probeNumber(result.format.duration) ?? probeNumber(video.duration)), fps: probeRate(video.avg_frame_rate) ?? probeRate(video.r_frame_rate),
    hasAudio: !!mainStream(result, 'audio'), codec: video.codec_name, codecTag: video.codec_tag_string, pixelFormat,
    bitDepth: probeNumber(video.bits_per_raw_sample) ?? Number(/(\d+)[lb]e$/.exec(pixelFormat ?? '')?.[1] ?? 8),
    bitrate: probeNumber(video.bit_rate) ?? probeNumber(result.format.bit_rate),
    transfer: video.color_transfer, hdr: HDR_TRANSFERS.has(video.color_transfer ?? ''),
  };
}

export function audioInfo(result: FFprobeResult): AudioInfo {
  const audio = mainStream(result, 'audio');
  if (!audio) throw new Error(`${path.basename(result.format.filename)} has no audio track.`);
  return {
    kind: 'audio', format: result.format.format_name, durationMs: ms(probeNumber(result.format.duration) ?? probeNumber(audio.duration)),
    codec: audio.codec_name, bitrate: probeNumber(audio.bit_rate) ?? probeNumber(result.format.bit_rate),
    sampleRate: probeNumber(audio.sample_rate), channels: audio.channels, hasCoverArt: result.streams.some(isCoverArt),
  };
}
