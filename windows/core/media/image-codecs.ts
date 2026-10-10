import sharp, { type Metadata } from 'sharp';
import { copyFile, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../run';
import type { CompressionQuality } from '../settings/schema';
import * as cq from './compression';
import { isHDR, probeColour, toneMapToSDR } from './hdr';

/** Formats sharp cannot decode itself: HEVC HEIF and JPEG XL through libheif and libjxl, BMP through ffmpeg. */
const TOOL_DECODED = new Set(['heic', 'jxl', 'bmp']);

/** An image's format from its bytes: sharp's name for what it reads (HEVC HEIF as `heic`, AV1 HEIF as `avif`), plus `jxl` and `bmp`. */
export async function sniffImage(file: string): Promise<{ format?: string; meta?: Metadata }> {
  const handle = await open(file, 'r'), head = Buffer.alloc(12);
  try { await handle.read(head, 0, 12, 0); } finally { await handle.close(); }
  if (head.readUInt16BE(0) === 0xff0a || head.equals(Buffer.from('0000000c4a584c200d0a870a', 'hex'))) return { format: 'jxl' };
  if (head.toString('latin1', 0, 2) === 'BM') return { format: 'bmp' };
  const meta = await sharp(file, { animated: true }).metadata().catch(() => undefined);
  if (!meta?.format) return {};
  return { format: meta.format === 'heif' ? (meta.compression === 'av1' ? 'avif' : 'heic') : meta.format, meta };
}

export interface ImageInfo { format: string; width: number; height: number; pages: number; /** More than 8 bits per sample, so possibly HDR. */ deep: boolean }

/** Format, displayed size and frame count, read from the header without decoding (exiftool for JXL and BMP). */
export async function probeImage(file: string, signal?: AbortSignal): Promise<ImageInfo> {
  const { format, meta } = await sniffImage(file);
  if (!format) throw new Error('This is not an image Clop can read.');
  if (!meta) {
    const { stdout } = await run('exiftool', ['-charset', 'filename=utf8', '-j', '-n', '-ImageWidth', '-ImageHeight', file], { signal });
    const { ImageWidth: width, ImageHeight: height } = JSON.parse(stdout.toString())[0];
    return { format, width: Math.abs(width ?? 0), height: Math.abs(height ?? 0), pages: 1, deep: false };
  }
  const width = meta.width ?? 0, height = meta.pageHeight ?? meta.height ?? 0, turned = (meta.orientation ?? 1) >= 5;
  return { format, width: turned ? height : width, height: turned ? width : height, pages: format === 'heic' ? 1 : meta.pages ?? 1, deep: (meta.bitsPerSample ?? 8) > 8 || meta.depth === 'ushort' };
}

/**
 * A file sharp can read with the pixels to optimise: HEIC, JXL and BMP decoded to PNG, SVG rasterised
 * at its document size, and PQ or HLG pixels tone-mapped to SDR (there is no HDR output on Windows).
 * `file` must sit in a folder of its own; tools run there on bare names, since the Windows builds of
 * libheif and libjxl open files through the ANSI code page. Returns `file` itself when it needs nothing.
 */
export async function readableImage(file: string, format: string, signal?: AbortSignal): Promise<{ file: string; decoded: boolean }> {
  const dir = path.dirname(file), name = path.basename(file), png = path.join(dir, 'decoded.png');
  const local = { signal, cwd: dir };
  let decoded = file;
  if (format === 'heic') await run('heif-dec', ['--quiet', name, 'decoded.png'], local);
  else if (format === 'jxl') await run('djxl', [name, 'decoded.png'], local);
  else if (format === 'bmp') await run('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', name, '-frames:v', '1', 'decoded.png'], local);
  else if (format === 'svg') await sharp(file).png({ compressionLevel: 1 }).toFile(png);
  if (TOOL_DECODED.has(format) || format === 'svg') decoded = png;
  const meta = await sharp(decoded).metadata();
  if ((meta.bitsPerSample ?? 8) > 8 || meta.depth === 'ushort') {
    signal?.throwIfAborted();
    const colour = await probeColour(file, signal).catch(error => { if (signal?.aborted) throw error; return {}; });
    if (isHDR(colour)) {
      const sdr = path.join(dir, 'sdr.png');
      await toneMapToSDR(decoded, sdr, colour);
      return { file: sdr, decoded: true };
    }
  }
  return { file: decoded, decoded: decoded !== file };
}

/** `heif-enc -q`, as Clop on macOS runs it, from a PNG in the same folder. The lossless tier encodes losslessly. */
export async function encodeHEIC(png: string, out: string, compression: CompressionQuality, signal?: AbortSignal) {
  const quality = compression.tier === 'lossless' ? ['-L'] : ['-q', String(cq.conversionQuality(compression))];
  await run('heif-enc', [...quality, '-o', path.basename(out), path.basename(png)], { signal, cwd: path.dirname(png) });
  return out;
}

/** cjxl at JXLCoder's quality and effort, from a PNG in the same folder. The lossless tier encodes losslessly. */
export async function encodeJXL(png: string, out: string, compression: CompressionQuality, signal?: AbortSignal) {
  const quality = compression.tier === 'lossless' ? ['-d', '0'] : ['-q', String(cq.jxlQuality(compression))];
  await run('cjxl', [path.basename(png), path.basename(out), ...quality, '-e', String(cq.jxlEffort(compression)), '--quiet'], { signal, cwd: path.dirname(png) });
  return out;
}

/** Writes any image Clop accepts as an oriented SDR PNG, for previews and the clipboard. */
export async function toPNG(input: string, output: string, { signal, limitInputPixels }: { signal?: AbortSignal; limitInputPixels?: number } = {}) {
  const { format } = await sniffImage(input);
  if (!format) throw new Error('This is not an image Clop can read.');
  const tmp = await mkdtemp(path.join(path.dirname(output), '.clop-png-'));
  try {
    const copy = path.join(tmp, `source.${format}`);
    await copyFile(input, copy);
    const { file } = await readableImage(copy, format, signal);
    await sharp(file, { limitInputPixels }).autoOrient().png().toFile(output);
  } finally { await rm(tmp, { recursive: true, force: true }); }
  return output;
}
