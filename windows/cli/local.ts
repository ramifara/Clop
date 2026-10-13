import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { findDeviceSize, DEVICE_SIZE_GROUPS } from '../core/data/deviceSizes';
import { findPaperSize, PAPER_SIZE_GROUPS } from '../core/data/paperSizes';
import type { CropSizeGroup } from '../core/data/cropSizes';
import { copyTo, exists, moveTo } from '../core/fileops';
import { factorText } from '../core/ipc/service';
import { markOptimised } from '../core/marker';
import { COLOUR_TAGS } from '../core/media/exif';
import { toPNG } from '../core/media/image-codecs';
import { cropPDF, extendPDF, uncropPDF } from '../core/media/pdf';
import { run } from '../core/run';
import { expandPathTemplate, expandTemplate, type Counter } from '../core/template';
import { ExitCode, ValidationError } from './args';
import { ARROW, bold, CHECKMARK, CIRCLE, dim, ERROR_X, EXCLAMATION, underline } from './colors';
import { flag, list, on, option, str, type ClopCommand, type Context } from './context';
import { checkOutputIsDir, chosenTypes, folderFiles, localPath, normalizeOutput } from './items';
import { cropSize } from './optimise';
import { readSettings } from './read-settings';
import { shellString } from './results';

// The commands that work in this process without the app (ClopCLI/main.swift): `convert` (legacy), `strip-exif`,
// `crop-pdf` and `uncrop-pdf`. For agents the app's MCP gate is still asked first.

/** `refuseUnallowedMCPRequest`: an agent's request asks the gate; anyone else needs no permission. */
async function gate(ctx: Context, pipeline?: string) {
  if (ctx.origin !== 'mcp') return;
  const response = await (await ctx.backend()).settings({ action: 'gate', origin: ctx.origin, pipeline });
  if (!response.ok) throw new ValidationError(response.error ?? 'Clop refused the request.');
}

/** The `%i` counter, read from and written back to `lastAutoIncrementingNumber`. */
async function withCounter<T>(ctx: Context, task: (counter: Counter) => Promise<T>): Promise<T> {
  const start = (await readSettings(ctx)).lastAutoIncrementingNumber, counter = { value: start };
  try { return await task(counter); } finally {
    if (counter.value !== start) await (await ctx.backend()).settings({ action: 'update', values: { lastAutoIncrementingNumber: counter.value } }).catch(() => {});
  }
}

export const convertLegacyCommand: ClopCommand = {
  name: 'legacy', abstract: 'Converts images to HEIC, WebP or AVIF locally, without the Clop app.', hidden: true,
  options: [
    option('format', 'Output format (avif, heic, webp)', 'f', { required: true }),
    option('quality', 'Quality of the output image (0-100)', 'q'),
    option('output', `Output file path or template (defaults to placing the converted file in the same folder as the original).

The template may contain the following tokens on the filename:

%y    Year
%m    Month (numeric)
%n    Month (name)
%d    Day
%w    Weekday

%H    Hour
%M    Minutes
%S    Seconds
%p    AM/PM

%P    Source file path (without name)
%f    Source file name (without extension)
%e    Source file extension
%q    Quality

%r    Random characters
%i    Auto-incrementing number

For example \`~/Desktop/%f[converted-from-%e]\` on a file like \`~/Desktop/image.png\` will generate the file \`~/Desktop/image[converted-from-png].webp\`.
The extension of the conversion format is automatically added.`, 'o'),
    flag('force', 'Replace output file if it already exists'),
  ],
  arguments: [{ name: 'files', help: 'Files to convert (can be an image or list of images)', variadic: true }],
  async run(v, ctx) {
    const format = str(v, 'format')!, quality = str(v, 'quality') ?? '60';
    if (!['avif', 'heic', 'webp'].includes(format)) throw new ValidationError(`The value '${format}' is invalid for '-f <format>'`);
    if (!/^\d+$/.test(quality) || Number(quality) > 100) throw new ValidationError(`The value '${quality}' is invalid for '-q <quality>'`);
    const given = (list(v, 'files') ?? []).map(file => localPath(file, ctx.cwd, ctx.home));
    if (!given.length) throw new ValidationError('At least one image must be specified');
    const files: string[] = [];
    for (const file of given) if ((await stat(file).catch(() => undefined))?.isFile()) files.push(file);
    const output = normalizeOutput(str(v, 'output'), ctx.cwd, ctx.home)?.replaceAll('%q', quality);
    let converted = 0;
    await withCounter(ctx, async counter => {
      await Promise.all(files.map(async file => {
        try { if (await convert(ctx, file, format, Number(quality), output, on(v, 'force'), counter)) converted++; }
        catch (error) { ctx.io.err(`${ERROR_X()} ${underline(shellString(file))} ${ARROW()} ${(error as Error).message}\n`); }
      }));
    });
    // Non-zero only when every file failed, so callers do not retry work that partly succeeded.
    if (!converted && files.length) throw new ExitCode(1);
  },
};

/** `ConvertLegacyCommand.convert`: AVIF and WebP through sharp, HEIC through heif-enc (the macOS CLI uses heif-enc and cwebp). */
async function convert(ctx: Context, file: string, format: string, quality: number, output: string | undefined, force: boolean, counter: Counter) {
  const { dir, name } = path.parse(file);
  let target = output ? expandPathTemplate(output, { path: file, counter }).replace(/\.[^.\\/]*$/, '') : path.join(dir, name);
  if (output && (/[\\/]$/.test(output) || (await stat(target).catch(() => undefined))?.isDirectory())) target = path.join(target, name);
  target = `${target}.${format}`;
  ctx.io.out(`${dim(`${CIRCLE()} Converting ${underline(shellString(file))} to ${bold(format)}`)}\n`);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'clop-convert-')), produced = path.join(temp, path.basename(target));
  try {
    if (format === 'heic') {
      const png = await toPNG(file, path.join(temp, 'input.png'));
      await run('heif-enc', ['-q', String(quality), '-o', produced, png]);
    } else {
      const image = sharp(file).keepMetadata();
      await (format === 'avif' ? image.avif({ quality }) : image.webp({ quality, smartSubsample: true })).toFile(produced);
    }
    if (await exists(target)) {
      if (!force) {
        const kept = path.join(os.tmpdir(), path.basename(target));
        await moveTo(produced, kept);
        ctx.io.err(`${ERROR_X()} ${underline(shellString(target))} already exists, use \`--force\` to replace\n${dim(`    ${ARROW()} converted file kept at ${underline(shellString(kept))}`)}\n`);
        return false;
      }
    }
    await moveTo(produced, target);
    await markOptimised(target).catch(() => {});
    ctx.io.out(`${CHECKMARK()} ${underline(shellString(file))} ${ARROW()} ${underline(shellString(target))}\n`);
    return true;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

const stripExif: ClopCommand = {
  name: 'strip-exif', abstract: 'Deletes EXIF metadata from images and videos.',
  options: [
    flag('recursive', 'Strip EXIF metadata from all files in subfolders (when using a folder as input)', 'r'),
    option('types', 'Types of files to optimise (e.g. generic types like `image`, `video`, `pdf` or specific ones like `jpeg`, `png`, `mp4`)', undefined, { repeated: true }),
    option('excludeTypes', 'Types of files to exclude from optimisation (e.g. generic types like `image`, `video`, `pdf` or specific ones like `jpeg`, `png`, `mp4`)', undefined, { repeated: true }),
  ],
  arguments: [{ name: 'files', help: 'Images and videos to strip EXIF metadata from (can be a file, folder, or list of files)', variadic: true }],
  async run(v, ctx) {
    const given = (list(v, 'files') ?? []).map(file => localPath(file, ctx.cwd, ctx.home));
    if (!given.length) throw new ValidationError('At least one file or folder must be specified');
    const first = await stat(given[0]).catch(() => undefined);
    const files = first?.isDirectory() ? await folderFiles(given[0], on(v, 'recursive'), chosenTypes(list(v, 'types'), list(v, 'excludeTypes'))) : given;
    await gate(ctx);
    const results = await Promise.all(files.map(file => strip(ctx, file)));
    if (files.length && !results.some(Boolean)) throw new ExitCode(1);
  },
};

/** `StripExif.strip`: exiftool writes a stripped copy, which then replaces the file; resolution, orientation and colour stay. */
async function strip(ctx: Context, file: string): Promise<boolean> {
  if (!await exists(file)) { ctx.io.err(`${ERROR_X()} ${underline(file)} does not exist\n`); return false; }
  if (path.extname(file).toLowerCase() === '.pdf') { ctx.io.err(`${EXCLAMATION()} ${underline(file)} is a PDF and \`strip-exif\` does not work on this type of file\n`); return false; }
  const temp = await mkdtemp(path.join(os.tmpdir(), 'clop-exif-')), copy = path.join(temp, path.basename(file));
  try {
    await run('exiftool', ['-charset', 'filename=utf8', '-XResolution=72', '-YResolution=72', '-all=', '-tagsFromFile', '@', '-XResolution', '-YResolution', '-Orientation', ...COLOUR_TAGS, '-o', copy, file]);
    if (!await exists(copy)) throw new Error('exiftool wrote nothing');
    await copyTo(copy, file);
    ctx.io.out(`${dim(`${CHECKMARK()} ${underline(file)} done`)}\n`);
    return true;
  } catch (error) {
    ctx.io.err(`${ERROR_X()} ${underline(file)} failed\n${(error as Error).message}\n`);
    return false;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/** `groupListing`. */
const groupListing = (categories: { category: string; groups: CropSizeGroup[] }[]) => categories.map(({ category, groups }) =>
  `${category}:\n${groups.map(group => group.members.length > 1 ? `  ${group.name}\n      ${group.members.map(m => `"${m}"`).join(', ')}` : `  ${group.name}`).join('\n')}`).join('\n\n');
export const DEVICES_TEXT = `Devices, grouped by screen aspect ratio.\nDevices in a group share the same exact ratio, so cropping for any of them gives the same result.\nBoth group names and device names are accepted.\n\n${groupListing(DEVICE_SIZE_GROUPS)}`;
export const PAPER_SIZES_TEXT = `Paper sizes, grouped by aspect ratio.\nSizes in a group share the same ratio, so cropping to any of them gives the same result.\nBoth group names and paper size names are accepted.\n\n${groupListing(PAPER_SIZE_GROUPS)}`;

const fractional = (size: { width: number; height: number }) => { const ratio = size.width / size.height; return ratio > 1 ? 1 / ratio : ratio; };

/** The PDFs a `crop-pdf`/`uncrop-pdf` call names: the PDFs in a folder given first, else the files as given. */
async function pdfs(ctx: Context, items: string[], recursive: boolean) {
  const given = items.map(item => localPath(item, ctx.cwd, ctx.home));
  if (!given.length) throw new ValidationError('At least one PDF file or folder must be specified');
  return (await stat(given[0]).catch(() => undefined))?.isDirectory() ? folderFiles(given[0], recursive, ['pdf']) : given;
}

/**
 * Where an edited PDF goes: into a folder output, beside it under a template name, or over the original. The template's
 * own `.pdf` is dropped, since the extension is added after it (macOS writes `-o a4.pdf` as `a4.pdf.pdf`).
 */
async function pdfOutput(pdf: string, output: string | undefined, ctx: Context, counter: Counter) {
  if (output === undefined) return pdf;
  output = output.replace(/\.pdf$/i, '');
  if (/[\\/]/.test(output)) {
    const target = normalizeOutput(output, ctx.cwd, ctx.home)!;
    if ((await stat(target).catch(() => undefined))?.isDirectory()) return path.join(target, path.basename(pdf));
    return path.join(path.dirname(target), expandTemplate(path.basename(target), { path: pdf, counter }));
  }
  return path.join(path.dirname(pdf), expandTemplate(output, { path: pdf, counter }));
}

async function checkOutput(output: string | undefined, count: number, ctx: Context) {
  if (output !== undefined && !output) throw new ValidationError('Output path cannot be empty');
  await checkOutputIsDir(normalizeOutput(output, ctx.cwd, ctx.home), count);
}

/** Runs a PDF edit into a work folder, then moves the result where it goes. */
async function editPDF(dest: string, edit: (dir: string) => Promise<{ path: string }>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'clop-pdf-'));
  try { await moveTo((await edit(temp)).path, dest); } finally { await rm(temp, { recursive: true, force: true }); }
}

const cropPdf: ClopCommand = {
  name: 'crop-pdf', abstract: 'Crops PDFs to a specific aspect ratio without optimising them. The operation is non-destructive and can be reversed with the `uncrop-pdf` command.',
  options: [
    option('forDevice', 'Crops pages to fit the screen of a specific device (e.g. iPad Air)'),
    option('paperSize', 'Crops pages to fit a specific paper size (e.g. A4, Letter)'),
    option('aspectRatio', 'Crops pages to fit the aspect ratio of a resolution (e.g. 1640x2360) or a specific aspect ratio (e.g. 16:9)'),
    flag('recursive', 'Crop all PDFs in subfolders (when using a folder as input)', 'r'),
    flag('extend', 'Extend pages with empty paper instead of clipping content, keeping everything visible (e.g. fit a book to a phone screen without cutting off text)', 'e'),
    flag('listDevices', 'List possible devices that can be passed to --for-device'),
    flag('listPaperSizes', 'List possible paper sizes that can be passed to --paper-size'),
    option('pageLayout', `Allows forcing a page layout on all PDF pages:
    auto: Crop pages based on their longest edge, so that horizontal pages stay horizontal and vertical pages stay vertical
    portrait: Force all pages to be cropped to vertical or portrait layout
    landscape: Force all pages to be cropped to horizontal or landscape layout`),
    option('output', 'Output file path (defaults to modifying the PDF in place). In case of cropping multiple files, this needs to be a folder.', 'o'),
  ],
  arguments: [{ name: 'pdfs', help: 'PDFs to crop (can be a file, folder, or list of files)', variadic: true }],
  async run(v, ctx) {
    if (on(v, 'listDevices')) { ctx.io.out(`${DEVICES_TEXT}\n`); return; }
    if (on(v, 'listPaperSizes')) { ctx.io.out(`${PAPER_SIZES_TEXT}\n`); return; }
    const device = str(v, 'forDevice'), paper = str(v, 'paperSize'), aspect = str(v, 'aspectRatio'), layout = str(v, 'pageLayout') ?? 'auto';
    if (device !== undefined && !findDeviceSize(device)) throw new ValidationError(`Unknown device "${device}", use --list-devices to see possible values`);
    if (paper !== undefined && !findPaperSize(paper)) throw new ValidationError(`Unknown paper size "${paper}", use --list-paper-sizes to see possible values`);
    if (!['auto', 'portrait', 'landscape'].includes(layout)) throw new ValidationError(`The value '${layout}' is invalid for '--page-layout <page-layout>'`);
    const size = (device !== undefined && findDeviceSize(device)) || (paper !== undefined && findPaperSize(paper)) || (aspect !== undefined ? cropSize(aspect, 'aspectRatio') : undefined);
    if (!size) throw new ValidationError('Invalid aspect ratio, at least one of --for-device, --paper-size or --aspect-ratio must be specified');
    const ratio = fractional(size);
    if (!(ratio > 0)) throw new ValidationError('Invalid aspect ratio, must be greater than 0');
    const output = str(v, 'output'), files = await pdfs(ctx, list(v, 'pdfs') ?? [], on(v, 'recursive'));
    await checkOutput(output, files.length, ctx);
    await gate(ctx);
    const fit = { aspectRatio: ratio, alwaysPortrait: layout === 'portrait', alwaysLandscape: layout === 'landscape' };
    await withCounter(ctx, async counter => {
      for (const pdf of files) {
        if (!await exists(pdf)) continue;
        const dest = await pdfOutput(pdf, output, ctx, counter);
        ctx.io.out(`${on(v, 'extend') ? 'Extending' : 'Cropping'} ${pdf} to aspect ratio ${factorText(ratio)}`);
        await editPDF(dest, dir => on(v, 'extend') ? extendPDF(pdf, dir, fit) : cropPDF(pdf, dir, fit));
        ctx.io.out(` -> saved to ${dest}\n`);
      }
    });
  },
};

const uncropPdf: ClopCommand = {
  name: 'uncrop-pdf', abstract: 'Brings back PDFs to their original size by removing the crop box from PDFs that were cropped non-destructively.',
  options: [
    option('output', 'Output file path (defaults to modifying the PDF in place). In case of uncropping multiple files, this needs to be a folder.', 'o'),
    flag('recursive', 'Uncrop all PDFs in subfolders (when using a folder as input)', 'r'),
  ],
  arguments: [{ name: 'pdfs', help: 'PDFs to uncrop (can be a file, folder, or list of files)', variadic: true }],
  async run(v, ctx) {
    const output = str(v, 'output'), files = await pdfs(ctx, list(v, 'pdfs') ?? [], on(v, 'recursive'));
    await checkOutput(output, files.length, ctx);
    await gate(ctx);
    await withCounter(ctx, async counter => {
      for (const pdf of files) {
        if (!await exists(pdf)) continue;
        const dest = await pdfOutput(pdf, output, ctx, counter);
        ctx.io.out(`Uncropping ${pdf}`);
        await editPDF(dest, dir => uncropPDF(pdf, dir));
        ctx.io.out(` -> saved to ${dest}\n`);
      }
    });
  },
};

export const localCommands = { stripExif, cropPdf, uncropPdf };
