import { open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { run, ToolError } from '../run';
import type { ToolName } from '../tools';
import { AUDIO_FORMATS, type AudioFormat } from './audioFormat';
import * as cq from './compression';
import { imageEntropy } from './image';

// Embedded album art, as Clop/Audio.swift handles it while re-encoding audio.
export type CoverArtBehaviour = 'optimise' | 'remove' | 'keep';
/** Square is the cover art standard, but a centre crop cuts the title off portrait book covers; landscape art is nearly always a video thumbnail. */
export type CoverArtSquaring = 'landscapeOnly' | 'always' | 'never';
export interface CoverArtOptions {
  /** The `audioCoverArt` setting; `optimise` by default. */
  coverArt?: CoverArtBehaviour;
  /** Scale optimised art down to this long edge. */
  coverArtMaxLongEdge?: number;
  /** Centre-crop optimised art to a square; `never` by default. */
  coverArtSquaring?: CoverArtSquaring;
}

/** AUDIO_COVER_JPEG_QUALITY: near-visually-lossless album art at a fraction of the size. */
export const COVER_JPEG_QUALITY = 68;
// COVER_JPEG_ENTROPY_THRESHOLD: photographic PNG art above this entropy is tried as a JPEG.
const COVER_JPEG_ENTROPY = 5;
const AGGRESSIVE = { tier: 'custom', factor: cq.COMPRESSION_FACTOR_AGGRESSIVE } as const;

async function sniff(file: string) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'jpg';
    if (bytesRead === 4 && header.readUInt32BE(0) === 0x89504e47) return 'png';
  } finally { await handle.close(); }
}

/**
 * Runs an image tool on a bare file name in the file's folder: the Windows builds of jpegoptim and
 * pngquant open paths through the ANSI code page. A failure leaves the file as it was, as `try?` does on macOS.
 */
async function tryTool(name: ToolName, args: string[], file: string, signal?: AbortSignal) {
  try { await run(name, [...args, path.basename(file)], { signal, cwd: path.dirname(file) }); } catch (error) {
    if (signal?.aborted || !(error instanceof ToolError)) throw error;
  }
}

/** `optimiseCoverJPEG`: recompresses a JPEG in place at the cover art quality. */
export const optimiseCoverJPEG = (file: string, signal?: AbortSignal) => tryTool('jpegoptim', ['--strip-all', '--force', '--max', String(COVER_JPEG_QUALITY)], file, signal);

/**
 * `extractedAudioCoverArt`: copies the first picture out of an audio file without re-encoding it, into
 * `dir` as `<stem>.jpg` or `<stem>.png` by its header (`.img` when neither). Undefined when there is none.
 */
export async function extractCoverArt(input: string, dir: string, stem: string, signal?: AbortSignal) {
  const raw = path.join(dir, `${stem}.img`);
  try {
    await run('ffmpeg', ['-y', '-nostdin', '-hide_banner', '-i', input, '-an', '-map', '0:v:0', '-c:v', 'copy', '-f', 'image2', raw], { signal });
  } catch (error) {
    if (signal?.aborted || !(error instanceof ToolError)) throw error;
    await rm(raw, { force: true });
    return undefined;
  }
  if (!(await stat(raw).catch(() => undefined))?.size) { await rm(raw, { force: true }); return undefined; }
  const ext = await sniff(raw);
  if (!ext) return raw;
  const named = path.join(dir, `${stem}.${ext}`);
  await rename(raw, named);
  return named;
}

/**
 * `resizeCoverArt`: centre-crops to a square as `squaring` asks, then scales down to `maxLongEdge`.
 * JPEG stays JPEG (at quality 100, before recompression); anything else becomes PNG. Returns the resulting file.
 */
export async function resizeCoverArt(file: string, maxLongEdge: number | undefined, squaring: CoverArtSquaring = 'never') {
  if (!(maxLongEdge && maxLongEdge > 0) && squaring === 'never') return file;
  const meta = await sharp(file).metadata();
  const width = meta.width ?? 0, height = meta.height ?? 0;
  const square = squaring === 'landscapeOnly' ? width > height : squaring === 'always' ? width !== height : false;
  let image = sharp(file), w = width, h = height;
  if (square) {
    const side = Math.min(width, height);
    image = image.extract({ left: Math.trunc((width - side) / 2), top: Math.trunc((height - side) / 2), width: side, height: side });
    w = h = side;
  }
  let targetW = w, targetH = h;
  const longEdge = Math.max(w, h);
  if (maxLongEdge && maxLongEdge > 0 && longEdge > maxLongEdge) {
    const scale = maxLongEdge / longEdge;
    targetW = Math.round(w * scale); targetH = Math.round(h * scale);
  }
  if (!square && targetW === w && targetH === h) return file;
  if (targetW !== w || targetH !== h) image = image.resize(targetW, targetH, { fit: 'fill' });
  const jpeg = (await sniff(file)) === 'jpg';
  const out = path.join(path.dirname(file), `${path.parse(file).name}-resized.${jpeg ? 'jpg' : 'png'}`);
  await (jpeg ? image.jpeg({ quality: 100 }) : image.png()).toFile(out);
  await rm(file, { force: true });
  return out;
}

/**
 * `optimisedAudioCoverArt` after extraction: JPEG art through jpegoptim at quality 68, PNG art through
 * pngquant at the aggressive factor. Opaque photographic PNG art is also tried as a JPEG, which wins when smaller.
 */
export async function optimiseCoverArt(file: string, signal?: AbortSignal) {
  const type = await sniff(file);
  if (type === 'jpg') { await optimiseCoverJPEG(file, signal); return file; }
  if (type !== 'png') return file;
  const photo = (await sharp(file).stats()).isOpaque && (await imageEntropy(file)) >= COVER_JPEG_ENTROPY;
  // The JPEG trial starts from the original PNG, not the quantized one.
  const jpeg = photo ? path.join(path.dirname(file), `${path.parse(file).name}-photo.jpg`) : undefined;
  if (jpeg) await sharp(file).jpeg({ quality: 100 }).toFile(jpeg);
  await tryTool('pngquant', ['--force', '--speed', String(cq.pngQuantSpeed(AGGRESSIVE)), '--quality', cq.pngQuantQuality(AGGRESSIVE), '--ext', '.png'], file, signal);
  if (!jpeg) return file;
  await optimiseCoverJPEG(jpeg, signal);
  return (await stat(jpeg)).size < (await stat(file)).size ? jpeg : file;
}

/**
 * `audioCoverArtArgs`: the ffmpeg arguments, placed right after `-i <input>`, that drop, copy or replace
 * the art with an optimised copy written into `tmp`. Formats that cannot hold art, and inputs without any, drop it.
 */
export async function coverArtArgs(input: string, format: AudioFormat, tmp: string, opts: CoverArtOptions, signal?: AbortSignal) {
  const behaviour = opts.coverArt ?? 'optimise';
  if (behaviour === 'remove' || !AUDIO_FORMATS[format].coverArt) return ['-vn'];
  // `?` keeps the map optional, so files without art still encode.
  if (behaviour === 'keep') return ['-map', '0:a', '-map', '0:v?', '-c:v', 'copy'];
  const extracted = await extractCoverArt(input, tmp, 'cover', signal);
  if (!extracted) return ['-vn'];
  const cover = await optimiseCoverArt(await resizeCoverArt(extracted, opts.coverArtMaxLongEdge, opts.coverArtSquaring), signal);
  return ['-i', cover, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', ...(format === 'mp3' ? ['-id3v2_version', '3'] : [])];
}

/** The scaled cover of `downscaleAudioCoverArt`: `factor` of the original's size in even pixels, JPEG recompressed at quality 68. */
export async function scaleCoverArt(original: string, factor: number, dir: string, signal?: AbortSignal) {
  const meta = await sharp(original).metadata();
  const even = (side: number | undefined) => Math.max(2, Math.trunc(factor * (side ?? 0) / 2) * 2);
  const png = (await sniff(original)) === 'png';
  const out = path.join(dir, `cover-scaled.${png ? 'png' : 'jpg'}`);
  const image = sharp(original).resize(even(meta.width), even(meta.height), { fit: 'fill' });
  await (png ? image.png() : image.jpeg({ quality: 90 })).toFile(out);
  if (!png) await optimiseCoverJPEG(out, signal);
  return out;
}
