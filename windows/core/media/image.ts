import sharp, { type Metadata } from 'sharp';
import { availableParallelism } from 'node:os';
import { copyFile, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { queue, retryBusy, run } from '../run';
import type { ToolName } from '../tools';
import type { CompressionQuality } from '../settings/schema';
import * as cq from './compression';
import { centreRect, cropGeometry, type CropSpec, type Rect } from './crop-size';
import { copyMetadata } from './exif';
import { encodeHEIC, encodeJXL, probeImage, readableImage } from './image-codecs';
import { toneMapToSDR } from './hdr';
import type { MediaJobOptions, MediaOutput } from './types';
import { watermarkFilters, watermarkOverlay, type Watermark } from './watermark';

// Windows cannot delete or rename a file that sharp's file cache still holds open.
sharp.cache({ files: 0 });
/** Every decode refuses corrupt data and stays under the engine's 60-megapixel budget, counted across all frames. */
const MAX_PIXELS = 60_000_000;
const decode = (file: string, animated = false) => sharp(file, { failOn: 'error', limitInputPixels: MAX_PIXELS, animated });

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'gif' | 'heic' | 'jxl';
export const IMAGE_FORMATS: readonly ImageFormat[] = ['png', 'jpeg', 'webp', 'avif', 'gif', 'heic', 'jxl'];
export interface ImageOptimiseOptions {
  /** The `imageCompression` setting. The Windows-only `lossless` tier optimises without changing pixels. */
  compression: CompressionQuality;
  /** Output format; the input's own when omitted, with TIFF and SVG becoming PNG, HEIC and BMP JPEG (PNG when transparent). */
  format?: ImageFormat;
  /** Displayed size to scale to; the input's own when omitted. */
  width?: number; height?: number;
  /** A crop instead of `width` and `height`: smart crops cut around sharp's attention region, except in GIFs and animations, which keep the centre. */
  cropSize?: CropSpec;
  /** Overlaid after scaling (`watermarked` in Images.swift). */
  watermark?: Watermark;
  stripMetadata?: boolean; preserveColorMetadata?: boolean;
  gifFrameDropBehaviour?: 'playFaster' | 'keepDuration';
  /** Output file name without extension; the input's name when omitted. */
  name?: string;
}
type Options = ImageOptimiseOptions & MediaJobOptions;
type Source = ImageFormat | 'tiff' | 'bmp' | 'svg';
interface Job {
  input: string; tmp: string; source: Source; meta: Metadata; width: number; height: number; crop?: Rect; fill?: 'attention' | 'centre';
  /** `width` × `height` differs from the source or crop size. */
  resized: boolean;
  /** Scaled, cropped or watermarked. */
  edited: boolean;
  /** `input` is a PNG decoded or tone-mapped from the source, not the source itself. */
  decoded: boolean;
  compression: CompressionQuality; lossless: boolean; adaptive: boolean; opts: Options; warnings: string[];
  /** Bits per sample of the source when deeper than 8, for a lossless HEIC. */
  bits?: number;
  /** Reports progress 0 the first time a tool runs. */
  start: () => void;
}
/**
 * An optimiser's result; `quantized` is the PNG pngquant started from, `stored` means the source's
 * pixels went through untouched by sharp, and `size` is set for the formats sharp cannot read back.
 */
interface Encoded { file: string; format: ImageFormat; quantized?: string; stored?: boolean; size?: [number, number] }

const SOURCES = new Set<string>([...IMAGE_FORMATS, 'tiff', 'bmp', 'svg']);
// Above this many bytes saved, the adaptive tier keeps the other format (optimisePNG and optimiseJPEG in Images.swift).
const ADAPTIVE_GAIN = 100_000;
const threads = () => `--threads=${availableParallelism()}`;
/**
 * Runs a tool in the job's temporary folder on bare file names. The Windows builds of jpegoptim,
 * pngquant and gifsicle open files through the ANSI code page, so a path with other characters
 * (a profile folder such as C:\Users\Zoë) would fail; every file a tool sees lives in that folder.
 */
function tool(job: Job, name: ToolName, args: string[]) {
  const running = run(name, args, { signal: job.opts.signal, cwd: job.tmp });
  job.start();
  return running;
}
const local = (file: string) => path.basename(file);
const size = async (file: string) => (await stat(file)).size;

/** Width and height as displayed, after EXIF orientation. */
function displaySize(meta: Metadata): [number, number] {
  const width = meta.width ?? 0, height = meta.pageHeight ?? meta.height ?? 0;
  return (meta.orientation ?? 1) >= 5 ? [height, width] : [width, height];
}

/**
 * Optimises an image the way Clop on macOS does: sharp only decodes, crops, scales and converts, then
 * jpegoptim, pngquant, gifsicle or ffmpeg compress with the arguments the CompressionQuality factor
 * maps to; heif-enc and cjxl write HEIC and JPEG XL. A result that is not smaller than an unedited,
 * unconverted input keeps the input. `onProgress` gets 0 once the first tool is running and 1 when the result is ready.
 */
export function optimiseImage(input: string, outputDir: string, opts: Options): Promise<MediaOutput> {
  return queue('image')(() => optimise(input, outputDir, opts));
}

async function optimise(input: string, outputDir: string, opts: Options): Promise<MediaOutput> {
  opts.signal?.throwIfAborted();
  const info = await probeImage(input, opts.signal).catch(() => undefined), source = info?.format, sourceMeta = info?.meta;
  if (!info || !source || !SOURCES.has(source)) throw new Error(`Clop cannot optimise ${source?.toUpperCase() ?? 'this'} images. Use PNG, JPEG, GIF, WebP, AVIF, HEIC, JPEG XL, TIFF, BMP or SVG.`);
  // Checked before anything is decoded or rasterised.
  if (info.width * info.height * info.pages > MAX_PIXELS) throw new Error('This image has too many pixels or animation frames. Use an image under 60 megapixels in total.');
  // HEIC and JPEG XL files are read for their primary image only.
  const animated = (sourceMeta?.pages ?? 1) > 1 && source !== 'heic';
  if (animated && source !== 'gif' && source !== 'webp') throw new Error('Clop can only optimise animated GIF and WebP images.');
  const compression = cq.effectiveImageCompression(opts.aggressive, opts.compression);
  const lossless = compression.tier === 'lossless';
  if (animated && opts.format && opts.format !== 'gif' && opts.format !== 'webp') throw new Error('Choose GIF or WebP to keep all animation frames.');

  await mkdir(outputDir, { recursive: true });
  const tmp = await mkdtemp(path.join(outputDir, '.clop-'));
  try {
    const copy = path.join(tmp, `source.${source}`);
    await copyFile(input, copy);
    let started = false;
    const start = () => { if (!started) { started = true; opts.onProgress?.(0); } };
    const readable = await readableImage(copy, source, { signal: opts.signal, onStart: start, keepHDR: lossless });
    let meta = readable.decoded ? await decode(readable.file).metadata() : sourceMeta!;
    const [sourceWidth, sourceHeight] = displaySize(meta);
    const geometry = opts.cropSize ? cropGeometry(opts.cropSize, sourceWidth, sourceHeight) : undefined;
    const width = geometry?.width ?? opts.width ?? sourceWidth, height = geometry?.height ?? opts.height ?? sourceHeight;
    let crop = geometry?.crop, fill = geometry?.fill;
    // gifsicle and ffmpeg cut GIFs and animations, and only take rectangles.
    if (fill && (animated || source === 'gif')) {
      const rect = centreRect(sourceWidth, sourceHeight, { width, height });
      crop = rect.width < sourceWidth || rect.height < sourceHeight ? rect : undefined;
      fill = undefined;
    }
    const resized = width !== (crop?.width ?? sourceWidth) || height !== (crop?.height ?? sourceHeight);
    const edited = resized || !!crop || !!opts.watermark;
    const originalBytes = await size(input);
    if (readable.hdr) {
      // Lossless keeps an HDR photo it is not asked to change; a requested edit or conversion is written as SDR, since nothing Clop writes on Windows holds HDR.
      if (!edited && (!opts.format || opts.format === source)) { opts.onProgress?.(1); return { path: input, bytes: originalBytes, format: source, width: sourceWidth, height: sourceHeight, unchanged: true }; }
      const sdr = path.join(tmp, 'sdr.png');
      await toneMapToSDR(readable.file, sdr, readable.hdr, opts.signal);
      Object.assign(readable, { file: sdr, decoded: true });
      meta = await decode(sdr).metadata();
    }
    let format = opts.format ?? await defaultFormat(source as Source, readable.file);
    // A JPEG keeps its pixels only when jpegoptim works on it as it is; edited or converted, it becomes PNG.
    if (lossless && format === 'jpeg' && (edited || source !== 'jpeg')) format = 'png';
    // x265 encodes at most 12 bits per sample, so a lossless HEIC of a 16-bit source would lose precision.
    const bits = meta.depth === 'ushort' ? sourceMeta?.bitsPerSample ?? 16 : undefined;
    if (lossless && format === 'heic' && bits && bits > 12) format = 'png';
    // GIF's 256-colour palette only keeps the pixels of a GIF that is not edited. Anything else stays in a format that can hold them.
    if (lossless && format === 'gif' && (source !== 'gif' || edited)) format = animated ? 'webp' : 'png';
    const converting = format !== source;
    const job: Job = { input: readable.file, tmp, source: source as Source, meta, width, height, crop, fill, resized, edited, decoded: readable.decoded, compression, lossless, adaptive: compression.tier === 'adaptive' && !opts.format, opts, warnings: [], bits, start };
    const done = (output: MediaOutput): MediaOutput => { opts.onProgress?.(1); return job.warnings.length ? { ...output, warnings: job.warnings } : output; };
    const unchanged = () => done({ path: input, bytes: originalBytes, format: source, width: sourceWidth, height: sourceHeight, unchanged: true });
    let result = animated ? await optimiseAnimation(job, format) : await optimiseStill(job, format);
    const metadata = { strip: opts.stripMetadata ?? true, preserveColour: opts.preserveColorMetadata ?? true, animated, signal: opts.signal };
    // jpegoptim runs with --keep-all, so a JPEG it optimised as stored already holds every tag of its input.
    if (metadata.strip || !(result.stored && result.format === 'jpeg')) await copyMetadata(result.file, input, { ...metadata, sameOrientation: result.stored });
    // A downscaled flat PNG can come out larger than its original: requantize toward the original's colours, or keep the original.
    if (resized && !crop && !fill && !opts.watermark && source === 'png' && result.quantized && await size(result.file) > originalBytes) {
      const smaller = await requantizeUnder(job, result.quantized, originalBytes, input);
      if (!smaller) return unchanged();
      result = { file: smaller, format: 'png' };
    }
    const bytes = await size(result.file);
    if (!edited && !converting && bytes >= originalBytes) return unchanged();
    let output = path.join(outputDir, `${opts.name ?? path.parse(input).name}.${result.format}`);
    if (path.resolve(output) === path.resolve(input)) output = path.join(outputDir, `${opts.name ?? path.parse(input).name}-optimised.${result.format}`);
    await retryBusy(() => rename(result.file, output));
    const [outWidth, outHeight] = result.size ?? displaySize(await decode(output, true).metadata());
    return done({ path: output, bytes, format: result.format, width: outWidth, height: outHeight });
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

/** Formats without an optimiser of their own become what macOS converts them to by default (`formatsToConvertToJPEG`/`PNG`), keeping transparency (`formatKeepingTransparency`). */
async function defaultFormat(source: Source, file: string): Promise<ImageFormat> {
  if (source === 'tiff' || source === 'svg') return 'png';
  if (source !== 'heic' && source !== 'bmp') return source;
  const meta = await decode(file).metadata();
  return meta.hasAlpha && !(await decode(file).stats()).isOpaque ? 'png' : 'jpeg';
}

async function optimiseStill(job: Job, format: ImageFormat): Promise<Encoded> {
  const direct = !job.edited && !job.decoded && format === job.source;
  // The adaptive tier's other format is always re-encoded.
  const stored = (result: Encoded): Encoded => ({ ...result, stored: result.format === job.source });
  switch (format) {
    case 'jpeg': return direct ? stored(await optimiseJPEG(job, job.input)) : optimiseJPEG(job, await encode(job, 'jpeg'));
    case 'png': {
      if (job.lossless) return { file: await encode(job, 'png'), format };
      return direct ? stored(await optimisePNG(job, job.input)) : optimisePNG(job, await encode(job, 'png'));
    }
    // gifsicle crops and scales a GIF itself.
    case 'gif': return job.source === 'gif' && !job.opts.watermark ? { ...await optimiseGIF(job, job.input), stored: !job.edited } : optimiseGIF(job, await encode(job, 'gif'), false);
    case 'heic': case 'jxl': {
      const png = await encode(job, 'png'), size = displaySize(await decode(png).metadata()), out = path.join(job.tmp, `encoded.${format}`);
      const coded = { signal: job.opts.signal, onStart: job.start };
      return { file: await (format === 'heic' ? encodeHEIC(png, out, job.compression, { ...coded, bits: job.lossless ? job.bits : undefined }) : encodeJXL(png, out, job.compression, coded)), format, size };
    }
    default: return { file: await encode(job, format), format };
  }
}

async function optimiseAnimation(job: Job, format: ImageFormat): Promise<Encoded> {
  const watermark = job.opts.watermark;
  if (format === 'gif' && job.source === 'gif' && !watermark) return { ...await optimiseGIF(job, job.input), stored: !job.edited };
  const out = path.join(job.tmp, `ffmpeg.${format}`);
  const loop = job.meta.loop ?? 0;
  const geometry = [
    ...(job.crop ? [`crop=${job.crop.width}:${job.crop.height}:${job.crop.left}:${job.crop.top}`] : []),
    ...(job.resized ? [`scale=${job.width}:${job.height}:flags=lanczos`] : []),
  ];
  const mark = watermark && path.join(job.tmp, `watermark${path.extname(watermark.file).toLowerCase()}`);
  if (mark) await copyFile(watermark.file, mark);
  const inputs = ['-i', local(job.input), ...(mark ? ['-i', local(mark)] : [])];
  const filters = watermark && watermarkFilters(job.width, watermark, job.height);
  const graph = (tail: string[]) => filters
    ? ['-filter_complex', [`[0:v]${[...geometry, 'null'].join(',')}[base]`, `[1:v]${filters.scale}[wm]`, `[base][wm]${[filters.overlay, ...tail].join(',')}`].join(';')]
    : (geometry.length || tail.length ? ['-vf', [...geometry, ...tail].join(',')] : []);
  if (format === 'webp' && job.lossless && !watermark) {
    // ffmpeg's libwebp_anim has no exact mode, so it would change the colour under transparent pixels; sharp keeps it, with the timing and loop count.
    let image = decode(job.input, true);
    if (job.crop) image = image.extract(job.crop);
    if (job.resized) image = image.resize(job.width, job.height, { fit: 'inside', withoutEnlargement: true });
    await image.webp({ lossless: true, exact: true, effort: 4 }).toFile(out);
  } else if (format === 'webp') {
    // optimiseAnimatedWebP and convertAnimatedGIFToWebP in Images.swift.
    const quality = job.lossless ? ['-lossless', '1'] : ['-q:v', String(cq.conversionQuality(job.compression))];
    await tool(job, 'ffmpeg', ['-y', '-nostdin', ...inputs, ...graph([]), '-an', '-c:v', 'libwebp_anim', ...quality, '-compression_level', '6', '-loop', String(loop), local(out)]);
    await restoreLastFrameDuration(out, job.meta.delay ?? []);
  } else {
    // convertAnimatedWebPToGIF: one palette across the whole animation. sharp counts plays, the GIF muxer repeats.
    const palette = 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer';
    await tool(job, 'ffmpeg', ['-y', '-nostdin', ...inputs, '-an', ...graph([palette]), '-loop', String(loop === 0 ? 0 : loop - 1 || -1), local(out)]);
  }
  await keepAnimated(out);
  // A watermarked GIF still goes through gifsicle, which must not crop or scale it again.
  return format === 'gif' ? optimiseGIF(job, out, false) : { file: out, format };
}

/** Decodes, orients, crops, scales, watermarks and encodes with sharp: an intermediate for the optimisers, or the result for WebP and AVIF. */
async function encode(job: Job, format: Exclude<ImageFormat, 'heic' | 'jxl'>, file = path.join(job.tmp, `encoded.${format}`)) {
  // The metadata is copied from the original with exiftool afterwards (copyMetadata); only the colour profile has to travel with the pixels.
  let image = decode(job.input).autoOrient().keepIccProfile();
  if (job.crop) image = image.extract(job.crop);
  if (job.resized) image = image.resize(job.width, job.height, job.fill ? { fit: 'cover', position: job.fill === 'attention' ? sharp.strategy.attention : 'centre' } : { fit: 'inside', withoutEnlargement: true });
  if (job.opts.watermark) {
    // The overlay is placed on the final size, which a proportional scale can round by a pixel.
    const { data, info } = await image.png({ compressionLevel: 0 }).toBuffer({ resolveWithObject: true });
    image = sharp(data).keepIccProfile().composite([await watermarkOverlay(job.opts.watermark, info.width, info.height)]);
  }
  const quality = cq.conversionQuality(job.compression), lossless = job.lossless;
  // sharp writes 8-bit PNG unless the pipeline is 16-bit.
  if (format === 'png' && lossless && job.meta.depth === 'ushort') image = image.toColourspace((job.meta.channels ?? 3) <= 2 ? 'grey16' : 'rgb16');
  switch (format) {
    // The intermediates are as close to lossless as the format allows, like vipsthumbnail's Q=100.
    case 'jpeg': image = image.flatten({ background: '#ffffff' }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }); break;
    case 'png': image = image.png({ compressionLevel: lossless ? 9 : 1 }); break;
    case 'gif': image = image.gif({ effort: 7 }); break;
    // exact keeps the colour under fully transparent pixels, which lossless must not drop.
    case 'webp': image = image.webp({ quality, lossless, exact: lossless, smartSubsample: true, effort: 4 }); break;
    case 'avif': image = image.avif({ quality, lossless, effort: 4 }); break;
  }
  await image.toFile(file);
  return file;
}

// Without --auto-mode, as the Intel build of Clop runs it: jpegoptim 1.5.6 never finishes with --auto-mode and a --max above the input's quality.
function jpegoptim(job: Job, file: string, max: number | undefined) {
  const dest = path.join(job.tmp, `jpegoptim-${path.basename(file)}`);
  return mkdir(dest).then(() => tool(job, 'jpegoptim', ['--keep-all', '--force', ...(max === undefined ? [] : ['--max', String(max)]), '--overwrite', '--dest', local(dest), local(file)]))
    .then(() => path.join(dest, path.basename(file)));
}

async function pngquant(job: Job, file: string, out: string, args?: string[]) {
  const colors = cq.pngQuantColors(job.compression);
  args ??= ['--force', '--speed', String(cq.pngQuantSpeed(job.compression)), '--quality', cq.pngQuantQuality(job.compression), ...(colors ? [String(colors)] : [])];
  await tool(job, 'pngquant', [...args, '--output', local(out), local(file)]);
  return out;
}

/**
 * Runs both candidates of an adaptive test to completion, so neither still writes into the temporary
 * folder once it is removed. The other format failing only costs the comparison, so it becomes a warning.
 */
async function both(job: Job, main: Promise<string>, other: Promise<string> | undefined, otherFormat: string) {
  const [a, b] = await Promise.allSettled([main, other]);
  if (a.status === 'rejected') throw a.reason;
  // Cancelling the job is not a failed comparison.
  if (b.status === 'rejected' && job.opts.signal?.aborted) throw b.reason;
  if (b.status === 'rejected') job.warnings.push(`Clop could not try ${otherFormat} for this image: ${b.reason instanceof Error ? b.reason.message : String(b.reason)}`);
  return [a.value, b.status === 'fulfilled' ? b.value : undefined] as const;
}

/** optimiseJPEG: jpegoptim capped at the factor's quality; adaptive also tries PNG on low-entropy photos. */
async function optimiseJPEG(job: Job, file: string): Promise<Encoded> {
  const testPNG = job.adaptive && ((await largeAreaEntropy(file)) ?? 0) < 5;
  const [jpeg, png] = await both(job, jpegoptim(job, file, job.lossless ? undefined : cq.jpegMaxQuality(job.compression)),
    testPNG ? encode(job, 'png', path.join(job.tmp, 'adaptive.png')).then(png => pngquant(job, png, path.join(job.tmp, 'adaptive-pngquant.png'))) : undefined, 'PNG');
  if (png && await size(jpeg) - await size(png) > ADAPTIVE_GAIN) return { file: png, format: 'png' };
  return { file: jpeg, format: 'jpeg' };
}

/** optimisePNG: pngquant at the factor's speed, quality and palette; adaptive also tries JPEG on opaque images. */
async function optimisePNG(job: Job, file: string): Promise<Encoded> {
  const testJPEG = job.adaptive && (await decode(file).stats()).isOpaque;
  const [png, jpeg] = await both(job, pngquant(job, file, path.join(job.tmp, 'pngquant.png')),
    testJPEG ? encode(job, 'jpeg', path.join(job.tmp, 'adaptive.jpeg')).then(jpeg => jpegoptim(job, jpeg, cq.jpegSecondaryMaxQuality(job.compression))) : undefined, 'JPEG');
  if (jpeg && await size(png) - await size(jpeg) > ADAPTIVE_GAIN) return { file: jpeg, format: 'jpeg' };
  return { file: png, format: 'png', quantized: file };
}

/**
 * optimiseGIF: gifsicle crops and scales the source GIF first if needed (`geometry`), then optimises
 * with the factor's level, lossiness, palette and frame dropping.
 */
async function optimiseGIF(job: Job, file: string, geometry = true): Promise<Encoded> {
  if (geometry && (job.resized || job.crop)) {
    const resized = path.join(job.tmp, 'resized.gif'), { crop } = job;
    await tool(job, 'gifsicle', ['--unoptimize', threads(), '--resize-method=box', '--resize-colors=256',
      ...(crop ? ['--crop', `${crop.left},${crop.top}+${crop.width}x${crop.height}`] : []), ...(job.resized ? ['--resize', `${job.width}x${job.height}`] : []), '--output', local(resized), local(file)]);
    file = resized;
  }
  const out = path.join(job.tmp, 'gifsicle.gif');
  const meta = await decode(file, true).metadata();
  const drop = job.lossless ? [] : gifFrameDropArgs(meta.delay ?? Array(meta.pages ?? 1).fill(0), cq.gifFrameDropEveryNth(job.compression), job.opts.gifFrameDropBehaviour);
  const args = [...(job.lossless ? ['-O3'] : cq.gifsicleArgs(job.compression)), threads(), '--output', local(out)];
  // Frame selections apply to the input before them; --unoptimize keeps frame-diffed inputs whole through deletion.
  await tool(job, 'gifsicle', drop.length ? ['--unoptimize', local(file), ...drop, ...args] : [...args, local(file)]);
  if ((meta.pages ?? 1) > 1) await keepAnimated(out);
  return { file: out, format: 'gif' };
}

/**
 * `gifsicleFrameDropArgs`: drops every Nth frame of a GIF with more than 8 frames, never the first.
 * `playFaster` leaves the other delays alone; `keepDuration` adds each dropped delay to the kept frame before it.
 */
export function gifFrameDropArgs(delaysMs: number[], everyNth: number | undefined, behaviour: 'playFaster' | 'keepDuration' = 'playFaster') {
  const count = delaysMs.length;
  if (!everyNth || everyNth < 2 || count <= 8) return [];
  if (behaviour !== 'keepDuration') return ['--delete', ...Array.from({ length: count }, (_, i) => i).filter(i => i > 0 && i % everyNth === 0).map(i => `#${i}`)];
  // GIF delays are centiseconds.
  const delays = delaysMs.map(ms => Math.round(ms / 10)), args: string[] = [];
  for (let index = 0; index < count;) {
    let delay = delays[index], next = index + 1;
    for (; next < count && next % everyNth === 0; next++) delay += delays[next];
    args.push(`-d${delay}`, `#${index}`);
    index = next;
  }
  return args;
}

/** `downscaledPNGUnderOriginal`: the original's own colour count first, then smaller palettes, until one beats the original. */
async function requantizeUnder(job: Job, resized: string, originalBytes: number, original: string) {
  const own = Math.min(Math.max(await uniqueColours(job.input, 256), 2), 256);
  for (const colors of [own, ...[128, 64, 32, 16].filter(c => c !== own)]) {
    const out = await pngquant(job, resized, path.join(job.tmp, `requantized-${colors}.png`), [String(colors), '--force', '--speed', '1']).catch(error => { if (job.opts.signal?.aborted) throw error; });
    if (!out || await size(out) >= originalBytes) continue;
    await copyMetadata(out, original, { strip: job.opts.stripMetadata ?? true, preserveColour: job.opts.preserveColorMetadata ?? true, signal: job.opts.signal });
    return out;
  }
}

/** Distinct colours up to `cap` + 1, from a nearest-neighbour sample of at most 256K pixels so no new colours are blended in. */
async function uniqueColours(file: string, cap: number) {
  const meta = await decode(file).metadata(), max = 256 * 1024;
  const scale = Math.min(1, Math.sqrt(max / ((meta.width ?? 1) * (meta.height ?? 1))));
  const { data } = await decode(file).resize(Math.max(1, Math.round((meta.width ?? 1) * scale)), Math.max(1, Math.round((meta.height ?? 1) * scale)), { kernel: 'nearest', fit: 'fill' })
    .ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  const seen = new Set<number>();
  for (let i = 0; i < data.length && seen.size <= cap; i += 4) seen.add(data.readUInt32LE(i));
  return seen.size;
}

/** `largeAreaEntropy`: Shannon entropy of the joined R, G and B histograms, only for images over a megapixel. */
async function largeAreaEntropy(file: string) {
  const meta = await decode(file).metadata();
  if ((meta.width ?? 0) * (meta.height ?? 0) <= 1_000_000) return undefined;
  const { data } = await decode(file).removeAlpha().toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  const histogram = new Float64Array(768);
  for (let i = 0; i + 2 < data.length; i += 3) { histogram[data[i]]++; histogram[256 + data[i + 1]]++; histogram[512 + data[i + 2]]++; }
  const total = data.length - data.length % 3;
  let entropy = 0;
  for (const count of histogram) if (count) { const p = count / total; entropy -= p * Math.log2(p); }
  return entropy;
}

/** Never hand back a still in place of an animation (the checks after gifsicle and ffmpeg in Images.swift). */
async function keepAnimated(file: string) {
  if (((await decode(file, true).metadata()).pages ?? 1) < 2) throw new Error('The animation would have been flattened to a single frame.');
}

/**
 * ffmpeg's libwebp_anim encoder guesses the last frame's duration from the earlier ones. Write the
 * source's back into the last ANMF chunk when every frame came through. ffmpeg reads GIF delays
 * under 20 ms as 100 ms, so those are left as ffmpeg timed them.
 */
async function restoreLastFrameDuration(file: string, delays: number[]) {
  const wanted = delays.at(-1) ?? 0;
  if (wanted < 20 || wanted > 0xffffff) return;
  const handle = await open(file, 'r+');
  try {
    const { size: length } = await handle.stat(), header = Buffer.alloc(8);
    let offset = 12, frames = 0, last = -1;
    while (offset + 8 <= length) {
      await handle.read(header, 0, 8, offset);
      const bytes = header.readUInt32LE(4);
      // An ANMF payload starts with X, Y, width and height (3 bytes each), then the 3-byte duration.
      if (header.toString('latin1', 0, 4) === 'ANMF') { frames++; last = offset + 8 + 12; }
      offset += 8 + bytes + (bytes % 2);
    }
    if (last < 0 || frames !== delays.length) return;
    const duration = Buffer.alloc(3);
    duration.writeUIntLE(wanted, 0, 3);
    await handle.write(duration, 0, 3, last);
  } finally { await handle.close(); }
}
