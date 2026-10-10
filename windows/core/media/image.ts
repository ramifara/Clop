import sharp, { type Metadata } from 'sharp';
import { availableParallelism } from 'node:os';
import { copyFile, mkdir, mkdtemp, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { queue, retryBusy, run } from '../run';
import type { ToolName } from '../tools';
import type { CompressionQuality } from '../settings/schema';
import * as cq from './compression';
import { stripExif } from './exif';
import type { MediaJobOptions, MediaOutput } from './types';

// Windows cannot delete or rename a file that sharp's file cache still holds open.
sharp.cache({ files: 0 });

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif' | 'gif';
export const IMAGE_FORMATS: readonly ImageFormat[] = ['png', 'jpeg', 'webp', 'avif', 'gif'];
export interface ImageOptimiseOptions {
  /** The `imageCompression` setting. The Windows-only `lossless` tier optimises without changing pixels. */
  compression: CompressionQuality;
  /** Output format; the input's own when omitted, with TIFF becoming PNG. */
  format?: ImageFormat;
  /** Displayed size to scale to; the input's own when omitted. */
  width?: number; height?: number;
  stripMetadata?: boolean; preserveColorMetadata?: boolean;
  gifFrameDropBehaviour?: 'playFaster' | 'keepDuration';
  /** Output file name without extension; the input's name when omitted. */
  name?: string;
}
type Options = ImageOptimiseOptions & MediaJobOptions;
type Source = ImageFormat | 'tiff';
interface Job { input: string; tmp: string; source: Source; meta: Metadata; width: number; height: number; resized: boolean; compression: CompressionQuality; lossless: boolean; adaptive: boolean; opts: Options }
/** An optimiser's result; `quantized` is the PNG pngquant started from. */
interface Encoded { file: string; format: ImageFormat; quantized?: string }

const SOURCES = new Set<string>([...IMAGE_FORMATS, 'tiff']);
// Above this many bytes saved, the adaptive tier keeps the other format (optimisePNG and optimiseJPEG in Images.swift).
const ADAPTIVE_GAIN = 100_000;
const threads = () => `--threads=${availableParallelism()}`;
/**
 * Runs a tool in the job's temporary folder on bare file names. The Windows builds of jpegoptim,
 * pngquant and gifsicle open files through the ANSI code page, so a path with other characters
 * (a profile folder such as C:\Users\Zoë) would fail; every file a tool sees lives in that folder.
 */
const tool = (job: Job, name: ToolName, args: string[]) => run(name, args, { signal: job.opts.signal, cwd: job.tmp });
const local = (file: string) => path.basename(file);
const size = async (file: string) => (await stat(file)).size;

const sourceFormat = (meta: Metadata) => meta.format === 'heif' ? (meta.compression === 'av1' ? 'avif' : 'heic') : meta.format;
/** Width and height as displayed, after EXIF orientation. */
function displaySize(meta: Metadata): [number, number] {
  const width = meta.width ?? 0, height = meta.pageHeight ?? meta.height ?? 0;
  return (meta.orientation ?? 1) >= 5 ? [height, width] : [width, height];
}

/**
 * Optimises an image the way Clop on macOS does: sharp only decodes, scales and converts, then
 * jpegoptim, pngquant, gifsicle or ffmpeg compress with the arguments the CompressionQuality factor
 * maps to. A result that is not smaller than an unscaled, unconverted input keeps the input.
 */
export function optimiseImage(input: string, outputDir: string, opts: Options): Promise<MediaOutput> {
  return queue('image')(() => optimise(input, outputDir, opts));
}

async function optimise(input: string, outputDir: string, opts: Options): Promise<MediaOutput> {
  opts.signal?.throwIfAborted();
  const meta = await sharp(input, { animated: true }).metadata();
  const source = sourceFormat(meta);
  if (!source || !SOURCES.has(source)) throw new Error(`Clop cannot optimise ${source?.toUpperCase() ?? 'this'} images. Use PNG, JPEG, GIF, WebP, AVIF or TIFF.`);
  const animated = (meta.pages ?? 1) > 1;
  if (animated && source !== 'gif' && source !== 'webp') throw new Error('Clop can only optimise animated GIF and WebP images.');
  const [sourceWidth, sourceHeight] = displaySize(meta);
  const width = opts.width ?? sourceWidth, height = opts.height ?? sourceHeight;
  const resized = width !== sourceWidth || height !== sourceHeight;
  const compression = cq.effectiveImageCompression(opts.aggressive, opts.compression);
  const lossless = compression.tier === 'lossless';
  let format = opts.format ?? (source === 'tiff' ? 'png' : source as ImageFormat);
  if (animated && format !== 'gif' && format !== 'webp') throw new Error('Choose GIF or WebP to keep all animation frames.');
  // A JPEG keeps its pixels only when jpegoptim works on it as it is; scaled or converted, it becomes PNG.
  if (lossless && format === 'jpeg' && (resized || source !== 'jpeg')) format = 'png';
  const converting = format !== source;

  await mkdir(outputDir, { recursive: true });
  const tmp = await mkdtemp(path.join(outputDir, '.clop-'));
  try {
    const copy = path.join(tmp, `source.${source}`);
    await copyFile(input, copy);
    const job: Job = { input: copy, tmp, source: source as Source, meta, width, height, resized, compression, lossless, adaptive: compression.tier === 'adaptive' && !opts.format, opts };
    const originalBytes = await size(input);
    const unchanged = (): MediaOutput => ({ path: input, bytes: originalBytes, format: source, width: sourceWidth, height: sourceHeight, unchanged: true });
    let result = animated ? await optimiseAnimation(job, format) : await optimiseStill(job, format);
    if (opts.stripMetadata ?? true) await stripExif(result.file, { preserveColour: opts.preserveColorMetadata ?? true, signal: opts.signal });
    // A downscaled flat PNG can come out larger than its original: requantize toward the original's colours, or keep the original.
    if (resized && source === 'png' && result.quantized && await size(result.file) > originalBytes) {
      const smaller = await requantizeUnder(job, result.quantized, originalBytes);
      if (!smaller) return unchanged();
      result = { file: smaller, format: 'png' };
    }
    const bytes = await size(result.file);
    if (!resized && !converting && bytes >= originalBytes) return unchanged();
    let output = path.join(outputDir, `${opts.name ?? path.parse(input).name}.${result.format}`);
    if (path.resolve(output) === path.resolve(input)) output = path.join(outputDir, `${opts.name ?? path.parse(input).name}-optimised.${result.format}`);
    await retryBusy(() => rename(result.file, output));
    const [outWidth, outHeight] = displaySize(await sharp(output, { animated: true }).metadata());
    return { path: output, bytes, format: result.format, width: outWidth, height: outHeight };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

async function optimiseStill(job: Job, format: ImageFormat): Promise<Encoded> {
  const direct = !job.resized && format === job.source;
  switch (format) {
    case 'jpeg': return optimiseJPEG(job, direct ? job.input : await encode(job, 'jpeg'));
    case 'png': {
      const file = direct && !job.lossless ? job.input : await encode(job, 'png');
      return job.lossless ? { file, format } : optimisePNG(job, file);
    }
    // gifsicle scales a GIF itself.
    case 'gif': return optimiseGIF(job, job.source === 'gif' ? job.input : await encode(job, 'gif'));
    default: return { file: await encode(job, format), format };
  }
}

async function optimiseAnimation(job: Job, format: ImageFormat): Promise<Encoded> {
  if (format === 'gif' && job.source === 'gif') return optimiseGIF(job, job.input);
  const out = path.join(job.tmp, `ffmpeg.${format}`);
  const scale = job.resized ? [`scale=${job.width}:${job.height}:flags=lanczos`] : [];
  const loop = job.meta.loop ?? 0;
  if (format === 'webp') {
    // optimiseAnimatedWebP and convertAnimatedGIFToWebP in Images.swift.
    const quality = job.lossless ? ['-lossless', '1'] : ['-q:v', String(cq.conversionQuality(job.compression))];
    await tool(job, 'ffmpeg', ['-y', '-nostdin', '-i', local(job.input), ...(scale.length ? ['-vf', scale.join(',')] : []), '-an', '-c:v', 'libwebp_anim', ...quality, '-compression_level', '6', '-loop', String(loop), local(out)]);
    await restoreLastFrameDuration(out, job.meta.delay ?? []);
  } else {
    // convertAnimatedWebPToGIF: one palette across the whole animation. sharp counts plays, the GIF muxer repeats.
    const palette = 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer';
    await tool(job, 'ffmpeg', ['-y', '-nostdin', '-i', local(job.input), '-an', '-vf', [...scale, palette].join(','), '-loop', String(loop === 0 ? 0 : loop - 1 || -1), local(out)]);
  }
  await keepAnimated(out);
  return { file: out, format };
}

/** Decodes, orients, scales and encodes with sharp: an intermediate for the optimisers, or the result for WebP and AVIF. */
async function encode(job: Job, format: ImageFormat, file = path.join(job.tmp, `encoded.${format}`)) {
  let image = sharp(job.input).autoOrient().keepIccProfile();
  if (job.resized) image = image.resize(job.width, job.height, { fit: 'inside', withoutEnlargement: true });
  const quality = cq.conversionQuality(job.compression), lossless = job.lossless;
  switch (format) {
    // The intermediates are as close to lossless as the format allows, like vipsthumbnail's Q=100.
    case 'jpeg': image = image.flatten({ background: '#ffffff' }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }); break;
    case 'png': image = image.png({ compressionLevel: lossless ? 9 : 1 }); break;
    case 'gif': image = image.gif({ effort: 7 }); break;
    case 'webp': image = image.webp({ quality, lossless, smartSubsample: true, effort: 4 }); break;
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

/** Runs both candidates of an adaptive test to completion, so neither still writes into the temporary folder once it is removed. */
async function both(main: Promise<string>, other: Promise<string> | undefined) {
  const [a, b] = await Promise.allSettled([main, other]);
  if (a.status === 'rejected') throw a.reason;
  return [a.value, b.status === 'fulfilled' ? b.value : undefined] as const;
}

/** optimiseJPEG: jpegoptim capped at the factor's quality; adaptive also tries PNG on low-entropy photos. */
async function optimiseJPEG(job: Job, file: string): Promise<Encoded> {
  const testPNG = job.adaptive && ((await largeAreaEntropy(file)) ?? 0) < 5;
  const [jpeg, png] = await both(jpegoptim(job, file, job.lossless ? undefined : cq.jpegMaxQuality(job.compression)),
    testPNG ? encode(job, 'png', path.join(job.tmp, 'adaptive.png')).then(png => pngquant(job, png, path.join(job.tmp, 'adaptive-pngquant.png'))) : undefined);
  if (png && await size(jpeg) - await size(png) > ADAPTIVE_GAIN) return { file: png, format: 'png' };
  return { file: jpeg, format: 'jpeg' };
}

/** optimisePNG: pngquant at the factor's speed, quality and palette; adaptive also tries JPEG on opaque images. */
async function optimisePNG(job: Job, file: string): Promise<Encoded> {
  const testJPEG = job.adaptive && (await sharp(file).stats()).isOpaque;
  const [png, jpeg] = await both(pngquant(job, file, path.join(job.tmp, 'pngquant.png')),
    testJPEG ? encode(job, 'jpeg', path.join(job.tmp, 'adaptive.jpeg')).then(jpeg => jpegoptim(job, jpeg, cq.jpegSecondaryMaxQuality(job.compression))) : undefined);
  if (jpeg && await size(png) - await size(jpeg) > ADAPTIVE_GAIN) return { file: jpeg, format: 'jpeg' };
  return { file: png, format: 'png', quantized: file };
}

/** optimiseGIF: gifsicle scales first if needed, then optimises with the factor's level, lossiness, palette and frame dropping. */
async function optimiseGIF(job: Job, file: string): Promise<Encoded> {
  if (job.resized && job.source === 'gif') {
    const resized = path.join(job.tmp, 'resized.gif');
    await tool(job, 'gifsicle', ['--unoptimize', threads(), '--resize-method=box', '--resize-colors=256', '--resize', `${job.width}x${job.height}`, '--output', local(resized), local(file)]);
    file = resized;
  }
  const out = path.join(job.tmp, 'gifsicle.gif');
  const meta = await sharp(file, { animated: true }).metadata();
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
async function requantizeUnder(job: Job, resized: string, originalBytes: number) {
  const own = Math.min(Math.max(await uniqueColours(job.input, 256), 2), 256);
  for (const colors of [own, ...[128, 64, 32, 16].filter(c => c !== own)]) {
    const out = await pngquant(job, resized, path.join(job.tmp, `requantized-${colors}.png`), [String(colors), '--force', '--speed', '1']).catch(error => { if (job.opts.signal?.aborted) throw error; });
    if (!out || await size(out) >= originalBytes) continue;
    if (job.opts.stripMetadata ?? true) await stripExif(out, { preserveColour: job.opts.preserveColorMetadata ?? true, signal: job.opts.signal });
    return out;
  }
}

/** Distinct colours up to `cap` + 1, from a nearest-neighbour sample of at most 256K pixels so no new colours are blended in. */
async function uniqueColours(file: string, cap: number) {
  const meta = await sharp(file).metadata(), max = 256 * 1024;
  const scale = Math.min(1, Math.sqrt(max / ((meta.width ?? 1) * (meta.height ?? 1))));
  const { data } = await sharp(file).resize(Math.max(1, Math.round((meta.width ?? 1) * scale)), Math.max(1, Math.round((meta.height ?? 1) * scale)), { kernel: 'nearest', fit: 'fill' })
    .ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  const seen = new Set<number>();
  for (let i = 0; i < data.length && seen.size <= cap; i += 4) seen.add(data.readUInt32LE(i));
  return seen.size;
}

/** `largeAreaEntropy`: Shannon entropy of the joined R, G and B histograms, only for images over a megapixel. */
async function largeAreaEntropy(file: string) {
  const meta = await sharp(file).metadata();
  if ((meta.width ?? 0) * (meta.height ?? 0) <= 1_000_000) return undefined;
  const { data } = await sharp(file).removeAlpha().toColourspace('srgb').raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
  const histogram = new Float64Array(768);
  for (let i = 0; i + 2 < data.length; i += 3) { histogram[data[i]]++; histogram[256 + data[i + 1]]++; histogram[512 + data[i + 2]]++; }
  const total = data.length - data.length % 3;
  let entropy = 0;
  for (const count of histogram) if (count) { const p = count / total; entropy -= p * Math.log2(p); }
  return entropy;
}

/** Never hand back a still in place of an animation (the checks after gifsicle and ffmpeg in Images.swift). */
async function keepAnimated(file: string) {
  if (((await sharp(file, { animated: true }).metadata()).pages ?? 1) < 2) throw new Error('The animation would have been flattened to a single frame.');
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
