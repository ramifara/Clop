import sharp, { type Metadata } from 'sharp';
import { access, copyFile, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { run, type RunOptions } from '../run';
import type { CompressionQuality } from '../settings/schema';
import * as cq from './compression';
import { isHDR, probeColour, toneMapToSDR, type Colour } from './hdr';

/** An image's format from its bytes: sharp's name for what it reads (HEVC HEIF as `heic`, AV1 HEIF as `avif`), plus `jxl` and `bmp`. */
export async function sniffImage(file: string): Promise<{ format?: string; meta?: Metadata }> {
  const handle = await open(file, 'r'), head = Buffer.alloc(12);
  try { await handle.read(head, 0, 12, 0); } finally { await handle.close(); }
  if (head.readUInt16BE(0) === 0xff0a || head.equals(Buffer.from('0000000c4a584c200d0a870a', 'hex'))) return { format: 'jxl' };
  if (head.toString('latin1', 0, 2) === 'BM') return { format: 'bmp' };
  // A HEIF whose images differ in size cannot be read as one animation; its primary image still can.
  const meta = await sharp(file, { animated: true }).metadata().catch(() => sharp(file).metadata()).catch(() => undefined);
  if (!meta?.format) return {};
  return { format: meta.format === 'heif' ? (meta.compression === 'av1' ? 'avif' : 'heic') : meta.format, meta };
}

export interface ImageInfo {
  format: string; width: number; height: number; pages: number;
  /** More than 8 bits per sample, so possibly HDR. */
  deep: boolean;
  /** sharp's reading, for the formats it reads. */
  meta?: Metadata;
}

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
  return { format, width: turned ? height : width, height: turned ? width : height, pages: format === 'heic' ? 1 : meta.pages ?? 1, deep: (meta.bitsPerSample ?? 8) > 8 || meta.depth === 'ushort', meta };
}

export interface DecodeOptions {
  signal?: AbortSignal;
  /** Called once the first tool starts. */
  onStart?: () => void;
  /** Leave PQ and HLG pixels as they are and report them in `hdr` (the lossless tier keeps an HDR photo it does not change). */
  keepHDR?: boolean;
}

/** Runs a tool on bare names in `dir`, reporting the start. */
function tool(name: Parameters<typeof run>[0], args: string[], dir: string, { signal, onStart }: DecodeOptions): ReturnType<typeof run> {
  const running = run(name, args, { signal, cwd: dir } satisfies RunOptions);
  onStart?.();
  return running;
}

/**
 * A file sharp can read with the pixels to optimise: HEIC (its primary image), JXL and BMP decoded to
 * PNG, SVG rasterised at its document size, and PQ or HLG pixels tone-mapped to SDR (there is no HDR
 * output on Windows) unless `keepHDR`. `file` must sit in a folder of its own; tools run there on bare
 * names, since the Windows builds of libheif and libjxl open files through the ANSI code page. Returns
 * `file` itself when it needs nothing.
 */
export async function readableImage(file: string, format: string, opts: DecodeOptions = {}): Promise<{ file: string; decoded: boolean; hdr?: Colour }> {
  const dir = path.dirname(file), name = path.basename(file), png = path.join(dir, 'decoded.png');
  let decoded = file;
  if (format === 'heic') decoded = await decodeHEIC(file, opts);
  else if (format === 'jxl') await tool('djxl', [name, 'decoded.png'], dir, opts);
  else if (format === 'bmp') await tool('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', name, '-frames:v', '1', 'decoded.png'], dir, opts);
  else if (format === 'svg') await sharp(file).png({ compressionLevel: 1 }).toFile(png);
  if (format === 'jxl' || format === 'bmp' || format === 'svg') decoded = png;
  const meta = await sharp(decoded).metadata();
  if ((meta.bitsPerSample ?? 8) > 8 || meta.depth === 'ushort') {
    opts.signal?.throwIfAborted();
    const colour = await probeColour(file, opts.signal).catch(error => { if (opts.signal?.aborted) throw error; return {}; });
    if (isHDR(colour)) {
      if (opts.keepHDR) return { file: decoded, decoded: decoded !== file, hdr: colour };
      const sdr = path.join(dir, 'sdr.png');
      await toneMapToSDR(decoded, sdr, colour, opts.signal);
      return { file: sdr, decoded: true };
    }
  }
  return { file: decoded, decoded: decoded !== file };
}

/**
 * heif-dec writes one PNG per top-level image (`decoded-1.png`, `decoded-2.png`…) when a file holds
 * several, in the order sharp counts its pages, so sharp's `pagePrimary` picks the primary image's.
 */
async function decodeHEIC(file: string, opts: DecodeOptions) {
  const dir = path.dirname(file);
  await tool('heif-dec', ['--quiet', path.basename(file), 'decoded.png'], dir, opts);
  const single = path.join(dir, 'decoded.png');
  if (await access(single).then(() => true, () => false)) return single;
  const primary = path.join(dir, `decoded-${((await sharp(file).metadata()).pagePrimary ?? 0) + 1}.png`);
  if (!(await access(primary).then(() => true, () => false))) throw new Error('Clop could not decode the main image of this HEIC file.');
  return primary;
}

/**
 * `heif-enc -q`, as Clop on macOS runs it, from a PNG in the same folder. The lossless tier encodes
 * losslessly; a 16-bit PNG holding a deeper source's samples is encoded at that source's `bits`.
 */
export async function encodeHEIC(png: string, out: string, compression: CompressionQuality, opts: DecodeOptions & { bits?: number } = {}) {
  const quality = compression.tier === 'lossless' ? ['-L'] : ['-q', String(cq.conversionQuality(compression))];
  await tool('heif-enc', [...quality, ...(opts.bits ? ['-b', String(opts.bits)] : []), '-o', path.basename(out), path.basename(png)], path.dirname(png), opts);
  return out;
}

/** cjxl at JXLCoder's quality and effort, from a PNG in the same folder. The lossless tier encodes losslessly. */
export async function encodeJXL(png: string, out: string, compression: CompressionQuality, opts: DecodeOptions = {}) {
  const quality = compression.tier === 'lossless' ? ['-d', '0'] : ['-q', String(cq.jxlQuality(compression))];
  await tool('cjxl', [path.basename(png), path.basename(out), ...quality, '-e', String(cq.jxlEffort(compression)), '--quiet'], path.dirname(png), opts);
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
    const { file } = await readableImage(copy, format, { signal });
    await sharp(file, { limitInputPixels }).autoOrient().png().toFile(output);
  } finally { await rm(tmp, { recursive: true, force: true }); }
  return output;
}
