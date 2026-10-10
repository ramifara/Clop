import { PDFDocument, type PDFPage } from '@cantoo/pdf-lib';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { retryBusy } from '../run';
import type { MediaOutput } from './types';

// Page box edits from Shared/PaperSizes.swift (the PDFDocument extension) with the size helpers from Shared.swift.
// Cropping only sets the CropBox, so the MediaBox keeps the original page and uncropping restores it.

export interface Rect { x: number; y: number; width: number; height: number }
/** Normalised (0–1) region with a top-left origin, relative to the displayed page (CropRect in Shared/CropSize.swift). */
export type CropRect = Rect;
export interface PageFit {
  /** Width over height, or short over long side with the page's own orientation (as `cropTo(aspectRatio:)` takes it). */
  aspectRatio: number;
  alwaysPortrait?: boolean; alwaysLandscape?: boolean;
}
export interface PDFEditOptions { /** Output file name without extension; the input's name when omitted. */ name?: string }

export const isFullFrame = (r: CropRect) => r.x <= 0.005 && r.y <= 0.005 && r.width >= 0.995 && r.height >= 0.995;
export function clampCropRect(r: CropRect): CropRect {
  const width = Math.min(Math.max(r.width, 0.001), 1), height = Math.min(Math.max(r.height, 0.001), 1);
  return { x: Math.min(Math.max(r.x, 0), 1 - width), y: Math.min(Math.max(r.y, 0), 1 - height), width, height };
}
/** Maps a rect from displayed (rotated) page space into unrotated MediaBox space for a page's /Rotate. */
export function rotateCropRect(r: CropRect, degrees: number): CropRect {
  switch (((degrees % 360) + 360) % 360) {
    case 90: return { x: r.y, y: 1 - r.x - r.width, width: r.height, height: r.width };
    case 180: return { x: 1 - r.x - r.width, y: 1 - r.y - r.height, width: r.width, height: r.height };
    case 270: return { x: 1 - r.y - r.height, y: r.x, width: r.height, height: r.width };
    default: return r;
  }
}

/** The largest centred rect of the aspect ratio inside `width` × `height` (NSSize.cropTo in Shared.swift). */
export function cropToAspectRatio(width: number, height: number, { aspectRatio, alwaysPortrait, alwaysLandscape }: PageFit): Rect {
  const portrait = alwaysPortrait || (!alwaysLandscape && !(width > height));
  if (portrait ? width / height > aspectRatio : height / width <= aspectRatio) {
    const w = portrait ? height * aspectRatio : height / aspectRatio;
    return { x: (width - w) / 2, y: 0, width: w, height };
  }
  const h = portrait ? width / aspectRatio : width * aspectRatio;
  return { x: 0, y: (height - h) / 2, width, height: h };
}

/** The smallest centred rect of the aspect ratio containing `width` × `height`; the origin can go negative (NSSize.extendTo). */
export function extendToAspectRatio(width: number, height: number, { aspectRatio, alwaysPortrait, alwaysLandscape }: PageFit): Rect {
  const portrait = alwaysPortrait || (!alwaysLandscape && !(width > height));
  if (portrait ? width / height > aspectRatio : height / width <= aspectRatio) {
    const h = portrait ? width / aspectRatio : width * aspectRatio;
    return { x: 0, y: (height - h) / 2, width, height: h };
  }
  const w = portrait ? height * aspectRatio : height / aspectRatio;
  return { x: (width - w) / 2, y: 0, width: w, height };
}

const rotation = (page: PDFPage) => ((page.getRotation().angle % 360) + 360) % 360;

/** Loads a PDF with pdf-lib. Encrypted PDFs are refused unless `allowEncrypted`, as Clop on macOS refuses to edit them. */
export async function loadPDF(file: string, { allowEncrypted = false } = {}) {
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(await readFile(file), { ignoreEncryption: true, updateMetadata: false }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code) throw error;
    throw new Error(`${path.basename(file)} is not a valid PDF.`);
  }
  if (doc.isEncrypted && !allowEncrypted) throw new Error(`${path.basename(file)} is encrypted. Clop cannot change password-protected PDFs.`);
  if (!doc.getPageCount()) throw new Error(`${path.basename(file)} has no pages.`);
  return doc;
}

/** `<outputDir>/<name>.<ext>`, with `suffix` added when that would overwrite the input. */
export function outputFile(input: string, outputDir: string, name: string | undefined, suffix: string, ext = 'pdf') {
  const stem = name ?? path.parse(input).name;
  const file = path.join(outputDir, `${stem}.${ext}`);
  return path.resolve(file) === path.resolve(input) ? path.join(outputDir, `${stem}-${suffix}.${ext}`) : file;
}

async function edit(input: string, outputDir: string, opts: PDFEditOptions, suffix: string, change: (page: PDFPage) => void): Promise<MediaOutput> {
  const doc = await loadPDF(input);
  for (const page of doc.getPages()) change(page);
  await mkdir(outputDir, { recursive: true });
  const output = outputFile(input, outputDir, opts.name, suffix), partial = `${output}.${process.pid}.partial`;
  try {
    await writeFile(partial, await doc.save({ updateFieldAppearances: false }));
    await retryBusy(() => rename(partial, output));
  } finally { await rm(partial, { force: true }); }
  return { path: output, bytes: (await stat(output)).size, format: 'pdf', pages: doc.getPageCount() };
}

/**
 * Crops every page's CropBox to a region of the displayed page, or to the largest centred area of an aspect ratio
 * (PDFPipeline.swift uses `rect` unless it covers the whole page).
 */
export async function cropPDF(input: string, outputDir: string, opts: PDFEditOptions & ({ rect: CropRect } | PageFit)): Promise<MediaOutput> {
  const rect = 'rect' in opts && !isFullFrame(opts.rect) ? opts.rect : undefined;
  if (!rect && !('aspectRatio' in opts && opts.aspectRatio > 0)) throw new Error('Choose a crop region or a positive aspect ratio.');
  return edit(input, outputDir, opts, 'cropped', page => {
    const media = page.getMediaBox();
    if (rect) {
      const r = clampCropRect(rotateCropRect(rect, rotation(page)));
      page.setCropBox(media.x + media.width * r.x, media.y + media.height * (1 - r.y - r.height), media.width * r.width, media.height * r.height);
    } else {
      const r = cropToAspectRatio(media.width, media.height, opts as PageFit);
      page.setCropBox(media.x + r.x, media.y + r.y, r.width, r.height);
    }
  });
}

/** Resets every page's CropBox to its MediaBox, undoing `cropPDF`. */
export async function uncropPDF(input: string, outputDir: string, opts: PDFEditOptions = {}): Promise<MediaOutput> {
  return edit(input, outputDir, opts, 'uncropped', page => {
    const media = page.getMediaBox();
    page.setCropBox(media.x, media.y, media.width, media.height);
  });
}

/**
 * Grows each page's canvas to the aspect ratio instead of cutting content away; viewers show the added area as empty paper.
 * `rect`, normalised to the extended displayed page, then selects a part of that canvas.
 */
export async function extendPDF(input: string, outputDir: string, opts: PDFEditOptions & PageFit & { rect?: CropRect }): Promise<MediaOutput> {
  if (!(opts.aspectRatio > 0)) throw new Error('Choose a positive aspect ratio.');
  return edit(input, outputDir, opts, 'extended', page => {
    const visible = page.getCropBox(), rotated = rotation(page) % 180 !== 0;
    // The orientation options refer to the displayed page, so rotated pages are extended in display space and mapped back.
    const shown = rotated ? [visible.height, visible.width] : [visible.width, visible.height];
    const extended = extendToAspectRatio(shown[0], shown[1], opts);
    const [width, height] = rotated ? [extended.height, extended.width] : [extended.width, extended.height];
    let box: Rect = { x: visible.x + visible.width / 2 - width / 2, y: visible.y + visible.height / 2 - height / 2, width, height };
    if (opts.rect && !isFullFrame(opts.rect)) {
      const r = clampCropRect(rotateCropRect(opts.rect, rotation(page)));
      box = { x: box.x + box.width * r.x, y: box.y + box.height * (1 - r.y - r.height), width: box.width * r.width, height: box.height * r.height };
    }
    page.setMediaBox(box.x, box.y, box.width, box.height);
    page.setCropBox(box.x, box.y, box.width, box.height);
  });
}
