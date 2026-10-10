import { randomInt } from 'node:crypto';
import { type FileBehaviour, type OptimisationRequest, type PlacementOverride } from '../core/ipc/protocol';
import { parseCompression } from '../core/pipeline/parser';
import { PDF_DPI_STOPS } from '../core/media/pdf';
import type { CompressionQuality, CropSize } from '../core/settings/schema';
import { kebab, ValidationError, type OptionSpec, type Values } from './args';
import { ALL_TYPES_HELP, AUDIO_TYPES, checkOutputIsDir, chosenTypes, IMAGE_TYPES, normalizeOutput, PDF_TYPES, validateItems, VIDEO_TYPES } from './items';
import { flag, list, on, option, str, type ClopCommand, type Context } from './context';
import { checkPipelineArgument } from './read-settings';
import { ProgressPrinter } from './results';

// The commands that send files to be processed: optimise and its type subcommands, crop, downscale, convert image/video/
// audio and pipeline run (ClopCLI/main.swift). Each builds an `OptimisationRequest` and hands it to the backend.

export const OUTPUT_TEMPLATE_HELP = `Output file path or template (defaults to modifying the file in place). In case of cropping multiple files, this needs to be a folder or a template.

The template may contain the following tokens on the filename:
          Date       |      Time
---------------------|--------------
Year              %y | Hour       %H
Month (numeric)   %m | Minutes    %M
Month (name)      %n | Seconds    %S
Day               %d | AM/PM      %p
Weekday           %w |

Source file path (without name)        %P
Source file name (without extension)   %f
Source file extension                  %e

Crop size                  %z
Scale factor               %s
Playback speed factor      %x
Random characters          %r
Auto-incrementing number   %i

For example \`--output "~/Desktop/%f_optimised.png" image.png\` will generate the file \`~/Desktop/image_optimised.png\`.
`;
const BEHAVIOUR_HELP = 'temp | inplace | samefolder | specificfolder';
const DPI_HELP = `PDF aggressive DPI: 'adaptive' or one of ${PDF_DPI_STOPS.join(', ')}. Overrides the app's stored aggressive DPI setting for this run.`;
const TYPES_HELP = `Types of files to optimise (e.g. generic types like \`image\`, \`video\`, \`pdf\` or specific ones like \`jpeg\`, \`png\`, \`mp4\`) (default: ${ALL_TYPES_HELP})`;
const EXCLUDE_TYPES_HELP = 'Types of files to exclude from optimisation (e.g. generic types like `image`, `video`, `pdf` or specific ones like `jpeg`, `png`, `mp4`)';

/** `CommonOptimisationOptions`. */
export const COMMON_OPTIONS: OptionSpec[] = [
  flag('gui', 'Whether to show or hide the floating result (the usual Clop UI)', 'g'),
  flag('noProgress', "Don't print progress to stderr", 'n'),
  flag('async', 'Process files and items in the background'),
  flag('recursive', 'Optimise all files in subfolders (when using a folder as input)', 'r'),
  flag('copy', 'Copy file to clipboard after optimisation', 'c'),
  flag('skipErrors', 'Skips missing files and unreachable URLs', 's'),
  flag('json', 'Output results as a JSON', 'j'),
  flag('review', 'Open the batch adjustment window to review/tweak the per-type knobs before optimising, instead of starting immediately'),
  option('output', OUTPUT_TEMPLATE_HELP, 'o'),
  option('behaviour', `Where optimised files go: ${BEHAVIOUR_HELP}`),
  option('autoConvertBehaviour', `Where auto-compatibility-converted files go: ${BEHAVIOUR_HELP}`),
  option('sameFolderTemplate', "Same-folder name template override (e.g. '%f_optimised.%e')"),
  option('specificFolderTemplate', "Specific-folder path template override (e.g. '~/Desktop/optimised/%f.%e')"),
];
const TYPE_OPTIONS = [option('types', TYPES_HELP, undefined, { repeated: true }), option('excludeTypes', EXCLUDE_TYPES_HELP, undefined, { repeated: true })];

const invalid = (value: string, name: string): never => { throw new ValidationError(`The value '${value}' is invalid for '--${kebab(name)} <${kebab(name)}>'`); };

/** `FileBehaviour(argument:)`. */
export function behaviour(value: string | undefined, name: string): FileBehaviour | undefined {
  if (value === undefined) return undefined;
  switch (value.toLowerCase()) {
    case 'temp': case 'temporary': return 'temporary';
    case 'inplace': case 'in-place': return 'inPlace';
    case 'samefolder': case 'same-folder': return 'sameFolder';
    case 'specificfolder': case 'specific-folder': case 'specific': return 'specificFolder';
    default: return invalid(value, name);
  }
}

export function number(values: Values, name: string): number | undefined {
  const value = str(values, name);
  if (value === undefined) return undefined;
  return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : invalid(value, name);
}

const SIZE = /(\d+)\s*[xX×]\s*(\d+)/, RATIO = /(\d+)[.,]?(\d*)\s*:\s*(\d+)[.,]?(\d*)/;
/** `NSSize(argument:)`: `128` or `1200x630`. */
export function pixelSize(value: string | undefined, name: string): CropSize | undefined {
  if (value === undefined) return undefined;
  const square = /^\d+$/.test(value) ? Number(value) : undefined, match = SIZE.exec(value);
  if (square === undefined && !match) return invalid(value, name);
  const [width, height] = square !== undefined ? [square, square] : [Number(match![1]), Number(match![2])];
  return { width, height, name: '', longEdge: false, smartCrop: false };
}

/** `CropSize(argument:)`: a number, `16:9` (decimals scaled to whole numbers) or `1200x630`. */
export function cropSize(value: string, name: string): CropSize {
  if (/^\d+$/.test(value)) return { width: Number(value), height: Number(value), name: '', longEdge: false, smartCrop: false };
  const ratio = RATIO.exec(value);
  if (ratio) {
    const [, w, wd, h, hd] = ratio;
    let width = Number(w + wd), height = Number(h + hd);
    if (wd.length > hd.length) height *= 10 ** (wd.length - hd.length); else if (hd.length > wd.length) width *= 10 ** (hd.length - wd.length);
    return { width, height, name: '', longEdge: false, smartCrop: false, isAspectRatio: true };
  }
  return pixelSize(value, name)!;
}

/** `parsePDFDPIArgument`. */
export function pdfDPI(value: string | undefined, flagName = '--pdf-dpi'): number | undefined {
  if (!value) return undefined;
  if (value.toLowerCase() === 'adaptive') return 0;
  const allowed = PDF_DPI_STOPS.join(', ');
  if (!/^-?\d+$/.test(value)) throw new ValidationError(`Invalid ${flagName} value '${value}': expected 'adaptive' or one of ${allowed}`);
  if (!PDF_DPI_STOPS.includes(Number(value))) throw new ValidationError(`${flagName} must be 'adaptive' or one of ${allowed}`);
  return Number(value);
}

/** `parseCompressionArgument`. */
export function compression(value: string | undefined, { adaptive, auto }: { adaptive: boolean; auto: boolean }): CompressionQuality | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if ((lower !== 'adaptive' || adaptive) && (lower !== 'auto' || auto)) { const parsed = parseCompression(value); if (parsed) return parsed; }
  const allowed = ['a factor between 5 (best quality) and 100 (smallest file)', ...(adaptive ? ["'adaptive'"] : []), ...(auto ? ["'auto'"] : [])];
  if (!/^[+-]?\d+$/.test(value)) throw new ValidationError(`Invalid --compression value '${value}': expected ${allowed.join(' or ')}`);
  throw new ValidationError('--compression factor must be between 5 (best quality) and 100 (smallest file)');
}

/** `parseVideoEncoderArgument`. */
export function videoEncoder(value: string | undefined): CompressionQuality['tier'] | undefined {
  if (!value) return undefined;
  switch (value.toLowerCase()) {
    case 'hardware': case 'fast': return 'fast';
    case 'software': case 'smaller': case 'efficient': return 'smaller';
    case 'lossless': case 'visually-lossless': return 'lossless';
    case 'adaptive': return 'adaptive';
    default: throw new ValidationError(`Invalid --encoder value '${value}': expected 'hardware', 'software', 'lossless' or 'adaptive'`);
  }
}

function playbackFrames(value: string | undefined) {
  if (value !== undefined && value !== 'keep' && value !== 'drop') throw new ValidationError('--playback-speed-frames takes keep or drop');
  return value as 'keep' | 'drop' | undefined;
}

const requestId = () => String(randomInt(1000, 100_001));
const compact = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
const placementOf = (p: PlacementOverride) => { const placement = compact(p); return Object.keys(placement).length ? placement : undefined; };

interface SendOptions { showProgress: boolean; async: boolean; gui: boolean; json: boolean; operation: string }

/** `sendRequest`: sends the request, prints progress and results, and fails only when every input failed. */
export async function sendRequest(ctx: Context, urls: string[], opts: SendOptions, request: OptimisationRequest): Promise<number> {
  const backend = await ctx.backend();
  if (opts.async) {
    if (backend.app) await backend.queue(request);
    else ctx.detach(ctx.argv.filter(arg => arg !== '--async'));
    ctx.io.err(`Queued ${urls.length} items for ${opts.operation}\n`);
    if (!opts.gui) ctx.io.err('Use the `--gui` flag to see progress\n');
    return 0;
  }
  const printer = new ProgressPrinter(urls, ctx.io, opts.showProgress);
  ctx.onInterrupt(() => backend.stop({ ids: urls, remove: false }));
  try { await backend.optimise(request, printer.onMessage); } finally { ctx.onInterrupt(undefined); }
  if (opts.showProgress) printer.print();
  printer.printResults(opts.json);
  return printer.allFailed ? 1 : 0;
}

/** `sendOptimisationCommand`: a request from the common options plus the command's own. */
async function sendOptimisation(ctx: Context, v: Values, urls: string[], extra: Partial<OptimisationRequest> & { convertBehaviour?: FileBehaviour; operation?: string }): Promise<number> {
  let output = normalizeOutput(str(v, 'output'), ctx.cwd, ctx.home);
  const single = urls.length === 1 ? urls[0] : undefined, ext = (text: string) => /\.([^.\\/]+)$/.exec(text)?.[1];
  // One file to an output with its own extension: the extension is dropped, so a conversion still gets the right one.
  if (output && single && ext(output) && ext(output) === ext(single)) output = output.replace(`.${ext(single)}`, '');
  const { convertBehaviour, operation = 'optimisation', ...fields } = extra;
  const request: OptimisationRequest = compact({
    id: requestId(), urls, hideFloatingResult: !on(v, 'gui'), copyToClipboard: on(v, 'copy'), aggressiveOptimisation: false, source: 'cli', output,
    prepareInBatch: on(v, 'review') || undefined, origin: ctx.origin,
    placement: placementOf({ optimised: behaviour(str(v, 'behaviour'), 'behaviour'), autoConvert: behaviour(str(v, 'autoConvertBehaviour'), 'autoConvertBehaviour'), manualConvert: convertBehaviour, sameFolderTemplate: str(v, 'sameFolderTemplate'), specificFolderTemplate: str(v, 'specificFolderTemplate') }),
    ...fields,
  });
  return sendRequest(ctx, urls, { showProgress: !on(v, 'noProgress'), async: on(v, 'async'), gui: on(v, 'gui'), json: on(v, 'json'), operation }, request);
}

const items = (ctx: Context, v: Values, types: readonly string[], recursive = on(v, 'recursive'), skipErrors = on(v, 'skipErrors')) =>
  validateItems(list(v, 'items') ?? [], { recursive, skipErrors, types, cwd: ctx.cwd, home: ctx.home });

function cropAndFactor(v: Values) {
  const crop = pixelSize(str(v, 'crop'), 'crop');
  if (crop && !crop.width && !crop.height) throw new ValidationError('Invalid size, must be greater than 0');
  const factor = number(v, 'downscaleFactor');
  if (factor !== undefined && (factor <= 0 || factor > 1)) throw new ValidationError('Invalid downscale factor, must be greater than 0 and at most 1');
  return { size: crop, downscaleFactor: factor };
}

const ITEMS = (help: string) => ({ name: 'items', help, variadic: true });

const files: ClopCommand = {
  name: 'files', abstract: 'Optimise mixed file types and folders (default when no subcommand is given).', hidden: true,
  options: [
    ...COMMON_OPTIONS,
    flag('aggressive', 'Use aggressive optimisation (legacy preset, same as --compression 64)', 'a'),
    option('compression', "How hard to compress images, videos and audio: a factor from 5 (best quality) to 100 (smallest file), 'adaptive' (best format per image) or 'auto' (let the video encoder pick). Above 75, HDR is converted to SDR. Takes priority over --aggressive."),
    option('pdfDpi', DPI_HELP),
    { name: 'adaptiveOptimisation', kind: 'inversion', help: 'Convert detail heavy images to JPEG and low-detail ones to PNG for better compression (legacy, same as --compression adaptive)' },
    ...TYPE_OPTIONS,
    flag('removeAudio', 'Removes audio from optimised videos'),
    option('playbackSpeedFactor', 'Speeds up or slow down the video by a certain amount (1 means no change, 2 means twice as fast, 0.5 means 2x slower)'),
    option('playbackSpeedFrames', 'keep (smoother, higher fps) or drop (smaller file). Unset follows Settings > Video'),
    option('downscaleFactor', 'Makes the image or video smaller by a certain amount (1.0 means no resize, 0.5 means half the size)'),
    option('crop', 'Downscales and crops the image, video or PDF to a specific size (e.g. 1200x630)\nExample: cropping an image from 100x120 to 50x50 will first downscale it to 50x60 and then crop it to 50x50'),
  ],
  arguments: [ITEMS('Images, videos, audio files, PDFs or URLs to optimise (can be a file, folder, or list of files)')],
  async run(v, ctx) {
    const geometry = cropAndFactor(v), frames = playbackFrames(str(v, 'playbackSpeedFrames'));
    const parsed = compression(str(v, 'compression'), { adaptive: true, auto: true }), dpi = pdfDPI(str(v, 'pdfDpi'));
    const urls = await items(ctx, v, chosenTypes(list(v, 'types'), list(v, 'excludeTypes')));
    await checkOutputIsDir(normalizeOutput(str(v, 'output'), ctx.cwd, ctx.home), urls.length);
    return sendOptimisation(ctx, v, urls, {
      ...geometry, changePlaybackSpeedFactor: number(v, 'playbackSpeedFactor'), changePlaybackSpeedFrames: frames, aggressiveOptimisation: on(v, 'aggressive'),
      adaptiveOptimisation: v.adaptiveOptimisation as boolean | undefined, removeAudio: on(v, 'removeAudio') || undefined, compression: parsed, pdfDPI: dpi,
    });
  },
};

const image: ClopCommand = {
  name: 'image', abstract: 'Optimise images with image-specific controls.',
  options: [
    ...COMMON_OPTIONS,
    option('compression', "How hard to compress: a factor from 5 (best quality) to 100 (smallest file), or 'adaptive' to let Clop pick the best format per image. Above 75, HDR is converted to SDR."),
    option('downscaleFactor', 'Makes the image smaller by a certain amount (1.0 means no resize, 0.5 means half the size)'),
    option('crop', 'Downscales and crops the image to a specific size (e.g. 1200x630)'),
  ],
  arguments: [ITEMS('Images, image folders or URLs to optimise')],
  async run(v, ctx) {
    const geometry = cropAndFactor(v), parsed = compression(str(v, 'compression'), { adaptive: true, auto: false });
    const urls = await items(ctx, v, IMAGE_TYPES);
    await checkOutputIsDir(normalizeOutput(str(v, 'output'), ctx.cwd, ctx.home), urls.length);
    return sendOptimisation(ctx, v, urls, { ...geometry, compression: parsed });
  },
};

const video: ClopCommand = {
  name: 'video', abstract: 'Optimise videos with video-specific controls.',
  options: [
    ...COMMON_OPTIONS,
    option('compression', "How hard to compress: a factor from 5 (best quality) to 100 (smallest file), or 'auto' to let the software encoder pick the quality"),
    option('encoder', "Which encoder to use: 'hardware' (fast, larger files), 'software' (slow, smaller files), 'lossless' (no perceptible quality loss) or 'adaptive' (best encoder per file)"),
    flag('removeAudio', 'Removes audio from optimised videos'),
    option('playbackSpeedFactor', 'Speeds up or slow down the video by a certain amount (1 means no change, 2 means twice as fast, 0.5 means 2x slower)'),
    option('playbackSpeedFrames', 'keep (smoother, higher fps) or drop (smaller file). Unset follows Settings > Video'),
    option('downscaleFactor', 'Makes the video smaller by a certain amount (1.0 means no resize, 0.5 means half the size)'),
    option('crop', 'Downscales and crops the video to a specific size (e.g. 1280x720)'),
  ],
  arguments: [ITEMS('Videos, video folders or URLs to optimise')],
  async run(v, ctx) {
    const geometry = cropAndFactor(v), frames = playbackFrames(str(v, 'playbackSpeedFrames'));
    const tier = videoEncoder(str(v, 'encoder')), cq = compression(str(v, 'compression'), { adaptive: false, auto: true });
    const parsed: CompressionQuality | undefined = tier || cq ? { tier: tier ?? cq?.tier ?? 'custom', factor: cq?.factor ?? 50 } : undefined;
    const urls = await items(ctx, v, VIDEO_TYPES);
    await checkOutputIsDir(normalizeOutput(str(v, 'output'), ctx.cwd, ctx.home), urls.length);
    return sendOptimisation(ctx, v, urls, { ...geometry, changePlaybackSpeedFactor: number(v, 'playbackSpeedFactor'), changePlaybackSpeedFrames: frames, removeAudio: on(v, 'removeAudio') || undefined, compression: parsed });
  },
};

const pdf: ClopCommand = {
  name: 'pdf', abstract: 'Optimise PDFs with PDF-specific controls.',
  options: [...COMMON_OPTIONS, option('dpi', `Rendering DPI: 'adaptive' (pick per document) or one of ${PDF_DPI_STOPS.join(', ')}. Lower DPI means smaller files.`), option('crop', 'Downscales and crops the PDF pages to a specific size (e.g. 1200x630)')],
  arguments: [ITEMS('PDFs, folders of PDFs or URLs to optimise')],
  async run(v, ctx) {
    const size = cropAndFactor(v).size, dpi = pdfDPI(str(v, 'dpi'), '--dpi');
    const urls = await items(ctx, v, PDF_TYPES);
    await checkOutputIsDir(normalizeOutput(str(v, 'output'), ctx.cwd, ctx.home), urls.length);
    return sendOptimisation(ctx, v, urls, { size, pdfDPI: dpi });
  },
};

function bitrate(v: Values) {
  const value = str(v, 'bitrate');
  if (value === undefined) return undefined;
  if (!/^[+-]?\d+$/.test(value)) return invalid(value, 'bitrate');
  if (Number(value) <= 0) throw new ValidationError('Invalid --bitrate, must be greater than 0');
  return Number(value);
}

const audio: ClopCommand = {
  name: 'audio', abstract: 'Optimise audio files with audio-specific controls.',
  options: [
    ...COMMON_OPTIONS,
    option('compression', 'How hard to compress: a factor from 5 (best quality) to 100 (smallest file), mapped to a bitrate for the output format'),
    option('bitrate', 'Target bitrate in kbps (e.g. 128). Takes priority over --compression. Never upscales, snaps to the allowed bitrates of the output format.', 'b'),
  ],
  arguments: [ITEMS('Audio files, folders of audio files or URLs to optimise')],
  async run(v, ctx) {
    const kbps = bitrate(v), parsed = compression(str(v, 'compression'), { adaptive: false, auto: false });
    const urls = await items(ctx, v, AUDIO_TYPES);
    await checkOutputIsDir(normalizeOutput(str(v, 'output'), ctx.cwd, ctx.home), urls.length);
    return sendOptimisation(ctx, v, urls, { compression: parsed, audioBitrate: kbps });
  },
};

export const optimiseCommand: ClopCommand = {
  name: 'optimise', abstract: 'Optimise images, videos, audio files and PDFs.',
  discussion: `Use a type subcommand for type-specific options:
    clop optimise image --compression 70 photo.png
    clop optimise video --encoder software screencast.mov
    clop optimise pdf --dpi 96 document.pdf
    clop optimise audio --bitrate 128 recording.wav

Or pass files and folders directly to optimise mixed types with shared options.`,
  subcommands: [image, video, pdf, audio, files], defaultSubcommand: 'files',
};

// Crop and downscale keep their own option sets, as on macOS.
const fileFlags = (verb: string) => [
  flag('gui', 'Whether to show or hide the floating result (the usual Clop UI)', 'g'),
  flag('noProgress', "Don't print progress to stderr", 'n'),
  flag('async', 'Process files and items in the background'),
  flag('aggressive', 'Use aggressive optimisation', 'a'),
  option('pdfDpi', DPI_HELP),
  { name: 'adaptiveOptimisation', kind: 'inversion', help: 'Convert detail heavy images to JPEG and low-detail ones to PNG for better compression' } as OptionSpec,
  ...(verb === 'crop' ? [flag('smartCrop', 'Crop by centering on features in the image')] : []),
  flag('removeAudio', 'Removes audio from optimised videos'),
  flag('recursive', 'Optimise all files in subfolders (when using a folder as input)', 'r'),
  ...TYPE_OPTIONS,
  flag('copy', 'Copy file to clipboard after optimisation', 'c'),
  flag('skipErrors', 'Skips missing files and unreachable URLs', verb === 'crop' ? undefined : 's'),
  flag('json', 'Output results as a JSON', 'j'),
];

export const cropCommand: ClopCommand = {
  name: 'crop', abstract: 'Crop and optimise images, videos and PDFs to a specific size or aspect ratio.',
  options: [
    ...fileFlags('crop'),
    flag('longEdge', 'When the size is specified as a single number, it will crop the longer of width or height to that number.\nThe shorter edge will be calculated automatically while keeping the original aspect ratio.\n\nExample: `clop crop --long-edge --size 1920` will crop a landscape 2400x1350 image to 1920x1080, and a portrait 1350x2400 image to 1080x1920', 'l'),
    option('output', OUTPUT_TEMPLATE_HELP.replace('Scale factor               %s\nPlayback speed factor      %x\n', '').replace('`--output "~/Desktop/%f_optimised.png" image.png` will generate the file `~/Desktop/image_optimised.png`', '`--size 128 --output "~/Desktop/%f @ %zpx.png" image.png` will generate the file `~/Desktop/image @ 128px.png`'), 'o'),
    option('size', 'Downscales and crops the image, video or PDF to a specific size (e.g. 1200x630) or aspect ratio (e.g. 16:9).\n\nWhen the size is specified as a single number, it will crop the longer of width or height to that number.\nExample: cropping an image from 100x120 to 50x50 will first downscale it to 50x60 and then crop it to 50x50\n\nUse 0 for width or height to have it calculated automatically while keeping the original aspect ratio. (e.g. `128x0` or `0x720`)', 's', { required: true }),
  ],
  arguments: [ITEMS('Images, videos, PDFs or URLs to crop (can be a file, folder, or list of files)')],
  async run(v, ctx) {
    const size = cropSize(str(v, 'size')!, 'size');
    if (on(v, 'longEdge') && size.width !== size.height) throw new ValidationError('When using --long-edge, the size must be a single number');
    if (!size.width && !size.height) throw new ValidationError('Invalid size, must be greater than 0');
    const urls = await items(ctx, v, chosenTypes(list(v, 'types'), list(v, 'excludeTypes')));
    const dpi = pdfDPI(str(v, 'pdfDpi'));
    return sendOptimisation(ctx, v, urls, {
      size: { ...size, longEdge: on(v, 'longEdge'), smartCrop: on(v, 'smartCrop') }, downscaleFactor: 0.9, aggressiveOptimisation: on(v, 'aggressive'),
      adaptiveOptimisation: v.adaptiveOptimisation as boolean | undefined, removeAudio: on(v, 'removeAudio') || undefined, pdfDPI: dpi, operation: 'cropping',
    });
  },
};

export const downscaleCommand: ClopCommand = {
  name: 'downscale', abstract: 'Downscale and optimise images, videos and audio files by a certain factor. For audio, the factor is applied to the bitrate.',
  options: [
    ...fileFlags('downscale'),
    option('output', OUTPUT_TEMPLATE_HELP.replace('Crop size                  %z\n', '').replace('Playback speed factor      %x\n', '').replace('`--output "~/Desktop/%f_optimised.png" image.png` will generate the file `~/Desktop/image_optimised.png`', '`--factor 0.5 --output "~/Desktop/%f @ %sx.png" image.png` will generate the file `~/Desktop/image @ 0.5x.png`'), 'o'),
    option('factor', 'Makes the image, video or audio smaller by a certain amount (1.0 means no change, 0.5 means half the size / half the bitrate)'),
  ],
  arguments: [ITEMS('Images, videos, audio files or URLs to downscale (can be a file, folder, or list of files)')],
  async run(v, ctx) {
    const factor = number(v, 'factor') ?? 0.5;
    if (factor < 0.01 || factor > 0.99) throw new ValidationError('Invalid downscale factor, must be greater than 0 and less than 1');
    const urls = await items(ctx, v, chosenTypes(list(v, 'types'), list(v, 'excludeTypes')));
    await checkOutputIsDir(normalizeOutput(str(v, 'output'), ctx.cwd, ctx.home), urls.length);
    const dpi = pdfDPI(str(v, 'pdfDpi'));
    return sendOptimisation(ctx, v, urls, { downscaleFactor: factor, aggressiveOptimisation: on(v, 'aggressive'), adaptiveOptimisation: v.adaptiveOptimisation as boolean | undefined, removeAudio: on(v, 'removeAudio') || undefined, pdfDPI: dpi, operation: 'downscaling' });
  },
};

/** `convertPipelineDSL`: the output template becomes the convert step's location. */
export function convertPipeline(to: string, output: string | undefined) {
  return output === undefined ? `convert(to: ${to})` : `convert(to: ${to}, location: "${output.replaceAll('\\', '/')}")`;
}

function convertCommand(name: 'image' | 'video' | 'audio', abstract: string, formats: string[], toHelp: string, compressionHelp: string, itemsHelp: string, types: string[]): ClopCommand {
  return {
    name, abstract,
    options: [
      ...COMMON_OPTIONS, option('to', toHelp, 't', { required: true }), option('compression', compressionHelp),
      ...(name === 'audio' ? [option('bitrate', 'Target bitrate in kbps (e.g. 128). Takes priority over --compression. Never upscales, snaps to the allowed bitrates of the target format.', 'b')] : []),
      option('convertBehaviour', `Where the converted file goes: ${BEHAVIOUR_HELP}`),
    ],
    arguments: [ITEMS(itemsHelp)],
    async run(v, ctx) {
      const to = str(v, 'to')!.toLowerCase();
      if (!formats.includes(to)) throw new ValidationError(`Invalid --to format '${to}': expected one of ${formats.join(', ')}`);
      const kbps = name === 'audio' ? bitrate(v) : undefined;
      const parsed = compression(str(v, 'compression'), { adaptive: false, auto: name === 'video' });
      const urls = await items(ctx, v, types), output = normalizeOutput(str(v, 'output'), ctx.cwd, ctx.home);
      await checkOutputIsDir(output, urls.length);
      return sendOptimisation(ctx, { ...v, output: undefined }, urls, { compression: parsed, audioBitrate: kbps, pipeline: convertPipeline(to, output), convertBehaviour: behaviour(str(v, 'convertBehaviour'), 'convertBehaviour'), operation: 'conversion' });
    },
  };
}

const IMAGE_CONVERT = ['webp', 'avif', 'heic', 'jxl', 'jpeg', 'jpg', 'png'], VIDEO_CONVERT = ['mp4', 'gif', 'webm', 'hevc', 'x265', 'av1'], AUDIO_CONVERT = ['mp3', 'aac', 'm4a', 'opus', 'ogg', 'flac', 'wav', 'aiff'];
export const convertImageCommand = convertCommand('image', 'Convert images to another format through Clop.', IMAGE_CONVERT, `Target format: ${IMAGE_CONVERT.join(', ')}`,
  "How hard to compress: a factor from 5 (best quality) to 100 (smallest file). Above 75, HDR is converted to SDR. Defaults to the app's image compression setting.", 'Images, image folders or URLs to convert', IMAGE_TYPES);
export const convertVideoCommand = convertCommand('video', 'Convert videos to another format or codec through Clop.', VIDEO_CONVERT, 'Target format or codec: mp4 (H.264), gif (animated), webm (VP9), hevc (hardware H.265), x265 (software H.265), av1 (SVT-AV1 in MKV)',
  "How hard to compress: a factor from 5 (best quality) to 100 (smallest file), or 'auto'. Only applies to mp4 (H.264); the other codecs use tuned fixed settings.", 'Videos, video folders or URLs to convert', VIDEO_TYPES);
export const convertAudioCommand = convertCommand('audio', 'Convert audio files to another format through Clop.', AUDIO_CONVERT, `Target format: ${AUDIO_CONVERT.join(', ')}`,
  'How hard to compress: a factor from 5 (best quality) to 100 (smallest file), mapped to a bitrate for the target format', 'Audio files, folders of audio files or URLs to convert', AUDIO_TYPES);

/** `pipeline run`. */
export const pipelineRunCommand: ClopCommand = {
  name: 'run', abstract: 'Run a pipeline on files: a saved pipeline name or inline steps.',
  discussion: `The pipeline argument can be the name of a saved pipeline, or inline steps like:

    clop pipeline run 'crop(width: 1600) -> convert(to: webp)' image.png

Inline pipelines run exactly the steps written (no implicit optimisation pass).
Add an explicit \`optimise\` step if you want one. Saved pipelines keep their
"skip optimisation" setting: when off, files are optimised before the steps run.`,
  options: [
    flag('showResult', 'Show the floating result thumbnail when the pipeline finishes'),
    flag('hideResult', 'Hide result. Run silently without showing the floating result thumbnail'),
    flag('gui', 'Show the floating result thumbnail (old name of --show-result)', 'g', { hidden: true }),
    flag('noProgress', "Don't print progress to stderr", 'n'),
    flag('async', 'Process files and items in the background'),
    flag('recursive', 'Optimise all files in subfolders (when using a folder as input)', 'r'),
    flag('skipErrors', 'Skips missing files and unreachable URLs', 's'),
    flag('json', 'Output results as a JSON', 'j'),
    option('types', 'Types of files to process (e.g. generic types like `image`, `video`, `pdf` or specific ones like `jpeg`, `png`, `mp4`)', undefined, { repeated: true }),
    option('optimiseBehaviour', `Where optimised files go: ${BEHAVIOUR_HELP}`),
    option('convertBehaviour', `Where converted files go: ${BEHAVIOUR_HELP}`),
    option('autoConvertBehaviour', `Where auto-compatibility-converted files go: ${BEHAVIOUR_HELP}`),
    option('sameFolderTemplate', "Same-folder name template override (e.g. '%f_optimised.%e')"),
    option('specificFolderTemplate', "Specific-folder path template override (e.g. '~/Desktop/optimised/%f.%e')"),
  ],
  arguments: [{ name: 'pipeline', help: 'Saved pipeline name or inline pipeline steps' }, ITEMS('Files to run the pipeline on (can be a file, folder, or list of files)')],
  async run(v, ctx) {
    const show = on(v, 'showResult') || on(v, 'gui');
    if (show && on(v, 'hideResult')) throw new ValidationError('Pass either --show-result (or --gui) or --hide-result, not both');
    await checkPipelineArgument(ctx, str(v, 'pipeline')!);
    const urls = await items(ctx, v, chosenTypes(list(v, 'types'), undefined));
    if (!urls.length) throw new ValidationError('At least one file or folder must be specified');
    const request: OptimisationRequest = compact({
      id: requestId(), urls, hideFloatingResult: !show, copyToClipboard: false, aggressiveOptimisation: false, source: 'cli', pipeline: str(v, 'pipeline'), origin: ctx.origin,
      placement: placementOf({ optimised: behaviour(str(v, 'optimiseBehaviour'), 'optimiseBehaviour'), autoConvert: behaviour(str(v, 'autoConvertBehaviour'), 'autoConvertBehaviour'), manualConvert: behaviour(str(v, 'convertBehaviour'), 'convertBehaviour'), sameFolderTemplate: str(v, 'sameFolderTemplate'), specificFolderTemplate: str(v, 'specificFolderTemplate') }),
    });
    return sendRequest(ctx, urls, { showProgress: !on(v, 'noProgress'), async: on(v, 'async'), gui: show, json: on(v, 'json'), operation: 'pipeline' }, request);
  },
};

