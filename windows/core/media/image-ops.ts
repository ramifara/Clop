import { copyFile, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { queue, retryBusy } from '../run';
import { COMPRESSION_FACTOR_AGGRESSIVE } from './compression';
import type { CropSpec } from './crop-size';
import { stripExif } from './exif';
import { optimiseImage, type ImageFormat, type ImageOptimiseOptions } from './image';
import { probeImage, sniffImage } from './image-codecs';
import type { MediaJobOptions, MediaOutput } from './types';
import type { Watermark } from './watermark';

type Options = ImageOptimiseOptions & MediaJobOptions;

/** `Image.convert(to:)`: re-encodes into `format` and optimises the result; converting to the image's own format is refused. */
export async function convertImage(input: string, outputDir: string, opts: Options & { format: ImageFormat }): Promise<MediaOutput> {
  const { format } = await sniffImage(input);
  if (format === opts.format) throw new Error(`This image is already ${opts.format === 'jpeg' ? 'JPEG' : opts.format.toUpperCase()}.`);
  return optimiseImage(input, outputDir, opts);
}

/** `Image.resize(toSize:)`: crops to a `CropSize` (exact rectangle, size with smart or centre crop, long edge or aspect ratio), then optimises. */
export function cropImage(input: string, outputDir: string, opts: Options & { cropSize: CropSpec }): Promise<MediaOutput> {
  return optimiseImage(input, outputDir, opts);
}

/** `Image.watermarked`: overlays another image in a corner or the centre, then optimises in the image's own format. */
export async function watermarkImage(input: string, outputDir: string, opts: Options & { watermark: Watermark }): Promise<MediaOutput> {
  if (!(await stat(opts.watermark.file).then(info => info.isFile(), () => false))) throw new Error(`Watermark image not found: ${opts.watermark.file}`);
  return optimiseImage(input, outputDir, opts);
}

/** Copies the image and strips its identifying metadata (`FilePath.stripExif`), keeping resolution, orientation and, with `preserveColour`, the colour profile. */
export function stripImageMetadata(input: string, outputDir: string, { preserveColour = true, name, signal }: { preserveColour?: boolean; name?: string; signal?: AbortSignal } = {}): Promise<MediaOutput> {
  return queue('image')(async () => {
    const { format, width, height } = await probeImage(input, signal);
    await mkdir(outputDir, { recursive: true });
    let output = path.join(outputDir, `${name ?? path.parse(input).name}${path.extname(input)}`);
    if (path.resolve(output) === path.resolve(input)) output = path.join(outputDir, `${name ?? path.parse(input).name}-stripped${path.extname(input)}`);
    await copyFile(input, output);
    await stripExif(output, { preserveColour, signal });
    return { path: output, bytes: (await stat(output)).size, format, width, height };
  });
}

/**
 * Fits an image under `bytes`, as the targetSize pipeline step does (`targetSizeImage` in
 * PipelineExecution.swift): the aggressive factor first, then a binary search over the factors up to
 * 100 for the gentlest one that fits, and when even 100 is too large, scaling down at factor 100 by the
 * square root of the overshoot (at least to 20 % each time, at most 5 times). Every attempt starts
 * from the original. The result can still be over `bytes` when nothing fits.
 */
export async function fitUnderSize(input: string, outputDir: string, opts: Omit<Options, 'compression' | 'aggressive' | 'width' | 'height' | 'cropSize'> & { bytes: number }): Promise<MediaOutput> {
  if (!(opts.bytes > 0)) throw new Error('Choose a size limit above zero.');
  await mkdir(outputDir, { recursive: true });
  const tmp = await mkdtemp(path.join(outputDir, '.clop-fit-'));
  try {
    let attempt = 0;
    const tryAt = (factor: number, size?: { width: number; height: number }) => optimiseImage(input, tmp, { ...opts, ...size, compression: { tier: 'custom', factor }, name: `attempt-${attempt++}` });
    const fits = (output: MediaOutput) => output.bytes <= opts.bytes;
    let best = await tryAt(COMPRESSION_FACTOR_AGGRESSIVE);
    if (!fits(best)) {
      const strongest = await tryAt(100);
      if (fits(strongest)) {
        best = strongest;
        for (let low = COMPRESSION_FACTOR_AGGRESSIVE, high = 100; high - low > 4;) {
          const factor = Math.round((low + high) / 2), output = await tryAt(factor);
          if (fits(output)) { best = output; high = factor; } else low = factor;
        }
      } else {
        best = strongest;
        const width = best.width ?? 0, height = best.height ?? 0;
        let scale = 1;
        for (let tries = 0; !fits(best) && tries < 5 && width && height; tries++) {
          scale *= Math.max(0.2, Math.sqrt(opts.bytes / best.bytes) * 0.92);
          best = await tryAt(100, { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
        }
      }
    }
    if (best.unchanged) return best;
    const output = path.join(outputDir, `${opts.name ?? path.parse(input).name}.${best.format}`);
    const final = path.resolve(output) === path.resolve(input) ? path.join(outputDir, `${opts.name ?? path.parse(input).name}-optimised.${best.format}`) : output;
    await retryBusy(() => rename(best.path, final));
    return { ...best, path: final };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

