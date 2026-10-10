import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream } from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { queue, retryBusy, run } from '../run';
import { toolPath } from '../tools';
import type { CompressionQuality } from '../settings/schema';
import { optimiseImage } from './image';
import { loadPDF, outputFile } from './pdfBoxes';
import type { MediaJobOptions, MediaOutput } from './types';

export { clampCropRect, cropPDF, cropToAspectRatio, extendPDF, extendToAspectRatio, isFullFrame, loadPDF, rotateCropRect, uncropPDF, type CropRect, type PageFit, type PDFEditOptions, type Rect } from './pdfBoxes';

// Shared.swift: at 300 DPI Ghostscript keeps image resolution; below it downsamples.
export const PDF_DPI_NO_DOWNSAMPLE = 300, PDF_DPI_MIN = 48, PDF_DPI_MAX = 300;
/** The `pdfDPI` value that picks a DPI per PDF from its images. */
export const PDF_DPI_ADAPTIVE = 0;
export const PDF_DPI_STOPS: readonly number[] = [300, 250, 200, 150, 100, 72, 48];
// PDF.swift: PDFs above this many pages run as chunks of Ghostscript processes in parallel.
const PARALLEL_PAGE_THRESHOLD = 150, PARALLEL_CHUNK_SIZE = 100, PARALLEL_CONCURRENCY = 4;
const MIN_IMAGES_AT_DPI_STOP = 3;

// The Ghostscript argument sets are copied from PDF.swift.
const gsLossyArgs = (downsample: boolean) => [
  '-dAutoFilterColorImages=false', '-dAutoFilterGrayImages=false', '-dAutoFilterMonoImages=true', '-dColorImageFilter=/DCTEncode',
  `-dDownsampleColorImages=${downsample}`, `-dDownsampleGrayImages=${downsample}`, `-dDownsampleMonoImages=${downsample}`,
  '-dGrayImageFilter=/DCTEncode', '-dPassThroughJPEGImages=false', '-dPassThroughJPXImages=false', '-dShowAcroForm=false',
];
const gsLosslessArgs = (downsample: boolean) => [
  '-dAutoFilterColorImages=false', '-dAutoFilterGrayImages=false', '-dAutoFilterMonoImages=false', '-dColorImageFilter=/DCTEncode',
  `-dDownsampleColorImages=${downsample}`, `-dDownsampleGrayImages=${downsample}`, `-dDownsampleMonoImages=${downsample}`,
  // PassThrough only works when not downsampling; it keeps the original JPEGs byte for byte.
  '-dGrayImageFilter=/DCTEncode', `-dPassThroughJPEGImages=${!downsample}`, `-dPassThroughJPXImages=${!downsample}`, '-dShowAcroForm=true',
];
const gsResolutionArgs = (dpi: number) => [
  '-dColorImageDownsampleThreshold=1.0', '-dColorImageDownsampleType=/Bicubic', `-dColorImageResolution=${dpi}`,
  '-dGrayImageDownsampleThreshold=1.0', '-dGrayImageDownsampleType=/Bicubic', `-dGrayImageResolution=${dpi}`,
  // Mono (1-bit) images compress poorly below 300 DPI.
  '-dMonoImageDownsampleThreshold=1.0', '-dMonoImageDownsampleType=/Bicubic', `-dMonoImageResolution=${Math.max(dpi, 300)}`,
];
const GS_BASE_ARGS = [
  '-dALLOWPSTRANSPARENCY', '-dAutoRotatePages=/None', '-dBATCH', '-dCannotEmbedFontPolicy=/Warning',
  // /RGB, not /sRGB: Ghostscript's sRGB conversion drops isolated transparency-group form XObjects.
  '-dColorConversionStrategy=/RGB', '-dCompatibilityLevel=1.6', '-dCompressFonts=true', '-dCompressPages=true', '-dCompressStreams=true',
  '-dConvertCMYKImagesToRGB=true', '-dConvertImagesToIndexed=false', '-dCreateJobTicket=false', '-dDetectDuplicateImages=true', '-dDoThumbnails=false',
  '-dEmbedAllFonts=true', '-dEncodeColorImages=true', '-dEncodeGrayImages=true', '-dEncodeMonoImages=true', '-dFastWebView=false', '-dGrayDetection=true',
  '-dHaveTransparency=true', '-dLZWEncodePages=true', '-dMaxBitmap=0', '-dMonoImageFilter=/CCITTFaxEncode', '-dNOPAUSE', '-dNOPROMPT', '-dOptimize=true',
  '-dParseDSCComments=false', '-dParseDSCCommentsForDocInfo=false', '-dPDFNOCIDFALLBACK', '-dPDFSETTINGS=/screen', '-dPreserveAnnots=true',
  '-dPreserveCopyPage=false', '-dPreserveDeviceN=true', '-dPreserveEPSInfo=false', '-dPreserveHalftoneInfo=false', '-dPreserveOPIComments=false',
  '-dPreserveOverprintSettings=true', '-dPreserveSeparation=true', '-dPrinted=false', '-dProcessColorModel=/DeviceRGB', '-dSAFER', '-dSubsetFonts=true',
  // /Preserve, not /Apply: pdfwrite mis-applies a /TR on an /Alpha soft mask and erases the masked image.
  '-dTransferFunctionInfo=/Preserve', '-dUCRandBGInfo=/Remove',
];
const imageDict = (qFactor: string) => `<< /QFactor ${qFactor} /Blend 1 /HSamples [2 1 1 2] /VSamples [2 1 1 2] >>`;
const GS_PRE_ARGS = [
  '-c', `<< /ColorImageDict ${imageDict('0.68')} >> setdistillerparams << /ColorACSImageDict ${imageDict('0.68')} >> setdistillerparams << /GrayImageDict ${imageDict('0.68')} >> setdistillerparams << /GrayACSImageDict ${imageDict('0.68')} >> setdistillerparams << /AlwaysEmbed [ ] >> setdistillerparams << /NeverEmbed [/Courier /Courier-Bold /Courier-Oblique /Courier-BoldOblique /Helvetica /Helvetica-Bold /Helvetica-Oblique /Helvetica-BoldOblique /Times-Roman /Times-Bold /Times-Italic /Times-BoldItalic /Symbol /ZapfDingbats /Arial] >> setdistillerparams`,
  '-f',
  '-c', '/originalpdfmark { //pdfmark } bind def /pdfmark { { { counttomark pop } stopped { /pdfmark errordict /unmatchedmark get exec stop } if dup type /nametype ne { /pdfmark errordict /typecheck get exec stop } if dup /DOCINFO eq { (Skipping DOCINFO pdfmark\n) print cleartomark exit } if originalpdfmark exit } loop } def',
  '-f',
];
const GS_POST_ARGS = ['-c', '/pdfmark { originalpdfmark } bind def', '-f', '-c', '[ /Producer () /ModDate () /CreationDate () /DOCINFO pdfmark', '-f'];

/** Font folders Ghostscript may embed from, like FONT_PATH in PDF.swift. */
function fontDirs() {
  const dirs = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts'), ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts')] : [])]
    : process.platform === 'darwin' ? [path.join(homedir(), 'Library/Fonts'), '/Library/Fonts/', '/System/Library/Fonts/', '/Library/Fonts/Microsoft/', '/Library/Application Support/Adobe/Fonts/'] : [];
  return dirs.filter(dir => existsSync(dir));
}

/** The pdfwrite arguments PDF.swift's gsArgs builds for one pass. */
export function gsArgs(input: string, output: string, { lossy, dpi }: { lossy: boolean; dpi: number }): string[] {
  const clamped = Math.min(Math.max(dpi, PDF_DPI_MIN), PDF_DPI_MAX);
  const downsample = clamped < PDF_DPI_NO_DOWNSAMPLE;
  // At the lowest stops images are also re-encoded at a lower JPEG quality (QFactor is inverse).
  const qFactor = lossy && clamped <= 100 ? (clamped <= 48 ? '1.3' : clamped <= 72 ? '1.0' : '0.76') : undefined;
  const qFactorArgs = qFactor ? ['-c', `<< /ColorImageDict ${imageDict(qFactor)} /GrayImageDict ${imageDict(qFactor)} >> setdistillerparams`, '-f'] : [];
  const fonts = fontDirs();
  // ColorConversionStrategy is repeated after PDFSETTINGS=/screen, which would otherwise force sRGB.
  const outArgs = ['-dColorConversionStrategy=/RGB', '-sDEVICE=pdfwrite', ...(fonts.length ? [`-sFONTPATH=${fonts.join(path.delimiter)}`] : []), '-o', output];
  return [...GS_BASE_ARGS, ...gsResolutionArgs(clamped), ...(lossy ? gsLossyArgs(downsample) : gsLosslessArgs(downsample)), ...outArgs, ...qFactorArgs, ...GS_PRE_ARGS, input, ...GS_POST_ARGS];
}

/**
 * Runs Ghostscript with its stdout (where page progress goes) sent to stderr, so progress arrives line by line.
 * The Windows build reads its init files from the bundled lib and Resource folders next to gswin64c.exe.
 */
function gs(args: string[], { signal, cwd, onLine }: { signal?: AbortSignal; cwd?: string; onLine?: (line: string) => void }) {
  const lib: string[] = [];
  if (process.platform === 'win32') {
    const dir = path.dirname(toolPath('gs'));
    lib.push(...[path.join(dir, 'Resource', 'Init'), path.join(dir, 'lib'), path.join(dir, 'Resource', 'Font')].filter(d => existsSync(d)));
  }
  return run('gs', [...(lib.length ? [`-I${lib.join(';')}`] : []), '-sstdout=%stderr', ...args], { signal, cwd, onStderrLine: onLine });
}
const isPageLine = (line: string) => /^Page \d+/.test(line);

// DPI detection (PDF.swift): each image XObject's pixel size over its page's MediaBox in inches. This assumes
// every image fills its page, as Clop on macOS does; partial-page images read low and the outlier filter drops them.

/** The estimated DPI of every image XObject in each page's resources. */
export function imageDPIs(doc: PDFDocument): number[] {
  const dpis: number[] = [];
  const number = (dict: PDFDict, key: string) => { const value = dict.lookup(PDFName.of(key)); return value instanceof PDFNumber ? value.asNumber() : undefined; };
  for (const page of doc.getPages()) {
    const { width, height } = page.getMediaBox();
    if (!(width > 0 && height > 0)) continue;
    const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'));
    if (!(xobjects instanceof PDFDict)) continue;
    for (const ref of xobjects.values()) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFStream) || stream.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
      const w = number(stream.dict, 'Width'), h = number(stream.dict, 'Height');
      if (w === undefined || h === undefined) continue;
      dpis.push((w / (width / 72) + h / (height / 72)) / 2);
    }
  }
  return dpis;
}

/** Drops abnormally low values below the lower Tukey fence: small partial-page images miscounted by the full-page estimate. */
export function dropLowDPIOutliers(values: number[]) {
  if (values.length < 4) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => {
    const idx = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * p)), lo = Math.floor(idx), hi = Math.ceil(idx), frac = idx - lo;
    return sorted[lo] * (1 - frac) + sorted[hi] * frac;
  };
  const q1 = percentile(0.25), q3 = percentile(0.75), fence = q1 - 1.5 * (q3 - q1);
  return values.filter(v => v >= fence);
}

export interface PDFDPIAnalysis { chosen: number; maxSourceDPI?: number }
const maxDPI = (dpis: number[]) => dpis.length ? Math.round(Math.max(...dpis)) : undefined;

/** The highest stop ≤ `cap` with more than three images at or above it; `cap` when no images or no stop qualify (analyseAggressivePDFDPI). */
export function analysePDFDPI(imageDPIs: number[], cap: number): PDFDPIAnalysis {
  const dpis = dropLowDPIOutliers(imageDPIs);
  if (!dpis.length) return { chosen: cap };
  const stops = PDF_DPI_STOPS.filter(stop => stop <= cap);
  const freq = new Map<number, number>();
  for (const dpi of dpis) {
    const bucket = stops.find(stop => stop <= dpi);
    if (bucket !== undefined) freq.set(bucket, (freq.get(bucket) ?? 0) + 1);
  }
  let atOrAbove = 0;
  for (const stop of stops) {
    atOrAbove += freq.get(stop) ?? 0;
    if (atOrAbove > MIN_IMAGES_AT_DPI_STOP) return { chosen: stop, maxSourceDPI: maxDPI(dpis) };
  }
  return { chosen: cap, maxSourceDPI: maxDPI(dpis) };
}

/** The next stop below `dpi`, staying at the lowest stop. */
export const nextPDFDPIStepDown = (dpi: number) => PDF_DPI_STOPS.find(stop => stop < dpi) ?? PDF_DPI_STOPS.at(-1)!;

/**
 * The DPI a pass runs at (resolvePDFDPI). An explicit `dpi` is used as is; otherwise the `pdfDPI` setting decides,
 * adaptive or a fixed stop, and aggressive goes one stop lower so it always beats a normal pass.
 */
export function resolvePDFDPI(imageDPIs: number[], { dpi, setting = PDF_DPI_ADAPTIVE, aggressive = false }: { dpi?: number; setting?: number; aggressive?: boolean }): PDFDPIAnalysis {
  const resolved = dpi ?? setting;
  let chosen: number, maxSourceDPI: number | undefined;
  if (resolved === PDF_DPI_ADAPTIVE) ({ chosen, maxSourceDPI } = analysePDFDPI(imageDPIs, PDF_DPI_NO_DOWNSAMPLE));
  else chosen = resolved;
  if (aggressive && dpi === undefined) chosen = nextPDFDPIStepDown(chosen);
  if (resolved !== PDF_DPI_ADAPTIVE && (dpi !== undefined || chosen < PDF_DPI_NO_DOWNSAMPLE)) maxSourceDPI = maxDPI(dropLowDPIOutliers(imageDPIs));
  return { chosen, maxSourceDPI };
}

/** Runs tasks with at most `limit` at once; the first failure stops the rest and is rethrown once all have settled. */
async function inParallel<T>(items: T[], limit: number, signal: AbortSignal | undefined, task: (item: T, signal: AbortSignal) => Promise<void>) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal!.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let next = 0, failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      try { await task(items[next++], controller.signal); } catch (error) { failure ??= error; controller.abort(error); }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)); } finally { signal?.removeEventListener('abort', abort); }
  signal?.throwIfAborted();
  if (failure !== undefined) throw failure;
}

export interface PDFOptimiseOptions {
  /** The `pdfDPI` setting: 0 adapts to the PDF's images, otherwise a DPI from 48 to 300. Adaptive when omitted. */
  dpiSetting?: number;
  /** An explicit DPI (CLI, pipeline, DPI stepper) used as is, even when aggressive. */
  dpi?: number;
  /** Keep a result that is not smaller than the input. */
  allowLarger?: boolean;
  /** Output file name without extension; the input's name when omitted. */
  name?: string;
}
/** `dpi` is the DPI Ghostscript ran at; `sourceDPI` the highest image DPI found in the input, when it was scanned. */
export interface PDFOutput extends MediaOutput { dpi: number; sourceDPI?: number }

/**
 * Compresses a PDF with Ghostscript the way Clop on macOS does: lossy image re-encoding at the resolved DPI below 300,
 * lossless above. PDFs over 150 pages are split into 100-page chunks optimised four at a time and merged.
 * A result that is not smaller keeps the input unless `allowLarger`.
 */
export function optimisePDF(input: string, outputDir: string, opts: PDFOptimiseOptions & MediaJobOptions = {}): Promise<PDFOutput> {
  return queue('pdf')(() => optimise(input, outputDir, opts));
}

async function optimise(input: string, outputDir: string, opts: PDFOptimiseOptions & MediaJobOptions): Promise<PDFOutput> {
  opts.signal?.throwIfAborted();
  const doc = await loadPDF(input);
  const pages = doc.getPageCount();
  const { chosen: dpi, maxSourceDPI: sourceDPI } = resolvePDFDPI(imageDPIs(doc), { dpi: opts.dpi, setting: opts.dpiSetting, aggressive: opts.aggressive });
  const args = (output: string) => gsArgs(input, output, { lossy: dpi < PDF_DPI_NO_DOWNSAMPLE, dpi });
  let done = 0;
  const onLine = (line: string) => { if (isPageLine(line)) opts.onProgress?.(Math.min(++done, pages) / pages); };

  await mkdir(outputDir, { recursive: true });
  const tmp = await mkdtemp(path.join(outputDir, '.clop-'));
  try {
    const result = path.join(tmp, 'optimised.pdf');
    if (pages <= PARALLEL_PAGE_THRESHOLD) await gs(args(result), { signal: opts.signal, cwd: tmp, onLine });
    else await optimiseInChunks(pages, tmp, result, args, opts.signal, onLine);
    const [bytes, originalBytes] = [(await stat(result)).size, (await stat(input)).size];
    if (!opts.allowLarger && bytes >= originalBytes) return { path: input, bytes: originalBytes, format: 'pdf', pages, unchanged: true, dpi, sourceDPI };
    const output = outputFile(input, outputDir, opts.name, 'optimised');
    await retryBusy(() => rename(result, output));
    return { path: output, bytes, format: 'pdf', pages, dpi, sourceDPI };
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

async function optimiseInChunks(pages: number, tmp: string, result: string, args: (output: string) => string[], signal: AbortSignal | undefined, onLine: (line: string) => void) {
  const chunks: { first: number; last: number; file: string }[] = [];
  for (let first = 1; first <= pages; first += PARALLEL_CHUNK_SIZE) chunks.push({ first, last: Math.min(first + PARALLEL_CHUNK_SIZE - 1, pages), file: path.join(tmp, `chunk-${chunks.length}.pdf`) });
  await inParallel(chunks, PARALLEL_CONCURRENCY, signal, (chunk, signal) => gs([`-dFirstPage=${chunk.first}`, `-dLastPage=${chunk.last}`, ...args(chunk.file)], { signal, cwd: tmp, onLine }).then(() => {}));
  // Like PDFKit's page-by-page merge on macOS, this keeps the pages and drops document-level outlines.
  const merged = await PDFDocument.create({ updateMetadata: false });
  for (const chunk of chunks) {
    const part = await loadPDF(chunk.file);
    for (const page of await merged.copyPages(part, part.getPageIndices())) merged.addPage(page);
  }
  await writeFile(result, await merged.save());
}

export interface PDFRenderOptions {
  format?: 'png' | 'jpeg';
  /** Pixels per PDF point; 2 (144 DPI) as on macOS. */
  scale?: number;
  /** 1-based page range; every page when omitted. */
  firstPage?: number; lastPage?: number;
  /** Optimise each page image with the image optimiser at this compression. */
  optimise?: CompressionQuality;
  /** File name stem; pages are written as `<name>-page<n>.<ext>`. The input's name when omitted. */
  name?: string;
}

/**
 * Renders PDF pages to PNG or JPEG (quality 90 on white, as renderPage in PDF.swift) through Ghostscript, honouring each
 * page's CropBox. Page ranges render in parallel, one Ghostscript process per core.
 */
export function renderPDFPages(input: string, outputDir: string, opts: PDFRenderOptions & MediaJobOptions = {}): Promise<MediaOutput[]> {
  return queue('pdf')(() => render(input, outputDir, opts));
}

async function render(input: string, outputDir: string, opts: PDFRenderOptions & MediaJobOptions): Promise<MediaOutput[]> {
  opts.signal?.throwIfAborted();
  const count = (await loadPDF(input, { allowEncrypted: true })).getPageCount();
  const first = Math.max(1, opts.firstPage ?? 1), last = Math.min(count, opts.lastPage ?? count);
  if (first > last) throw new Error(`${path.basename(input)} has ${count} page${count === 1 ? '' : 's'}; choose pages 1 to ${count}.`);
  const format = opts.format ?? 'png', ext = format === 'png' ? 'png' : 'jpg';
  const device = format === 'png' ? ['-sDEVICE=png16m'] : ['-sDEVICE=jpeg', '-dJPEGQ=90'];
  const stem = opts.name ?? path.parse(input).name, total = last - first + 1;
  const workers = Math.min(availableParallelism(), PARALLEL_CONCURRENCY, total), size = Math.ceil(total / workers);
  const ranges = Array.from({ length: Math.ceil(total / size) }, (_, i) => ({ first: first + i * size, last: Math.min(first + (i + 1) * size - 1, last) }));
  let done = 0;

  await mkdir(outputDir, { recursive: true });
  const tmp = await mkdtemp(path.join(outputDir, '.clop-'));
  try {
    await inParallel(ranges, workers, opts.signal, (range, signal) => gs([
      '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dUseCropBox', `-r${72 * (opts.scale ?? 2)}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', ...device,
      `-dFirstPage=${range.first}`, `-dLastPage=${range.last}`, '-o', `${range.first}-%d.${ext}`, input,
    ], { signal, cwd: tmp, onLine: line => { if (isPageLine(line) && !opts.optimise) opts.onProgress?.(++done / total); } }).then(() => {}));
    const pages = ranges.flatMap(range => Array.from({ length: range.last - range.first + 1 }, (_, i) => ({ page: range.first + i, rendered: path.join(tmp, `${range.first}-${i + 1}.${ext}`) })));
    // The image queue limits how many optimise at once; every page settles before the temporary folder goes.
    const settled = await Promise.allSettled(pages.map(async ({ page, rendered }): Promise<MediaOutput> => {
      const name = `${stem}-page${page}`, target = path.join(outputDir, `${name}.${ext}`);
      if (opts.optimise) {
        // The format stays fixed, so the adaptive tier cannot switch it; the optimiser names JPEGs .jpeg, pages keep .jpg.
        const output = await optimiseImage(rendered, outputDir, { compression: opts.optimise, format, aggressive: opts.aggressive, name, signal: opts.signal });
        opts.onProgress?.(++done / total);
        if (!output.unchanged) {
          if (output.path !== target) await retryBusy(() => rename(output.path, target));
          return { ...output, path: target };
        }
      }
      await retryBusy(() => rename(rendered, target));
      const meta = await sharp(target).metadata();
      return { path: target, bytes: (await stat(target)).size, format, width: meta.width, height: meta.height };
    }));
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const outputs = settled.map(result => (result as PromiseFulfilledResult<MediaOutput>).value);
    return outputs;
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
