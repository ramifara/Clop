import type { PDFPage } from '@cantoo/pdf-lib';
import { clampRect, isFullFrame } from '../core/media/crop-size';
import { loadPDF, rotateCropRect } from '../core/media/pdf';
import type { MediaKind } from '../core/media/types';
import type { CropSize } from '../core/settings/schema';
import type { CropRect, CropRequest, CropSource, ItemResult } from '../src/types';
import type { ItemEngine } from './items';
import type { MediaFiles } from './media-files';
import { imagePreview, pdfPagePreview, videoFramePreview, viewFile } from './previews';

/** Longest side Clop writes (WebP's limit), and the most crop sizes kept. */
const MAX_SIDE = 16383, MAX_SAVED = 200;
const ORIENTATIONS = ['portrait', 'landscape', 'adaptive'] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const fraction = (value: unknown, positive = false) => typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0) && value <= 1;

/** A crop region from the renderer: four fractions of the frame, clamped inside it. */
export function parseCropRect(value: unknown): CropRect {
  if (!isRecord(value) || !fraction(value.x) || !fraction(value.y) || !fraction(value.width, true) || !fraction(value.height, true)) throw new Error('Choose a crop region inside the picture.');
  return clampRect({ x: value.x as number, y: value.y as number, width: value.width as number, height: value.height as number });
}

/** A crop size from the renderer, as `savedCropSizes` stores one: whole-pixel sides up to 16383 (0 for one side means auto), a short name, and the flags. */
export function parseCropSize(value: unknown): CropSize {
  if (!isRecord(value)) throw new Error('Choose a crop size.');
  const { width, height, name, longEdge = false, smartCrop = false, isAspectRatio, cropRect } = value;
  const side = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_SIDE;
  if (!side(width) || !side(height) || (width === 0 && height === 0)) throw new Error(`Use a width and a height between 1 and ${MAX_SIDE} pixels.`);
  if (typeof name !== 'string' || name.length > 100) throw new Error('Use a crop size name under 100 characters.');
  if (typeof longEdge !== 'boolean' || typeof smartCrop !== 'boolean' || (isAspectRatio !== undefined && typeof isAspectRatio !== 'boolean')) throw new Error('Choose a valid crop size.');
  return { width: width as number, height: height as number, name, longEdge, smartCrop, ...(isAspectRatio === undefined ? {} : { isAspectRatio }), ...(cropRect === undefined ? {} : { cropRect: parseCropRect(cropRect) }) };
}

/** The renderer's new `savedCropSizes`: named sizes, at most 200. */
export function parseSavedCropSizes(value: unknown): CropSize[] {
  if (!Array.isArray(value) || value.length > MAX_SAVED) throw new Error(`Keep up to ${MAX_SAVED} crop sizes.`);
  return value.map(item => {
    const size = parseCropSize(item);
    if (!size.name.trim()) throw new Error('Name each saved crop size.');
    return size;
  });
}

/** Checks what the crop window asks for against the result's kind: images and videos take a crop size, PDFs page box edits, audio nothing. */
export function parseCropRequest(value: unknown, kind: MediaKind): CropRequest {
  if (kind === 'audio') throw new Error('Audio files have nothing to crop.');
  if (!isRecord(value)) throw new Error('Choose how to crop first.');
  if (kind !== 'pdf') {
    if (value.type !== 'size') throw new Error('Choose a crop size for this file.');
    return { type: 'size', size: parseCropSize(value.size) };
  }
  switch (value.type) {
    case 'pdf-rect': return { type: 'pdf-rect', rect: parseCropRect(value.rect) };
    case 'pdf-uncrop': return { type: 'pdf-uncrop' };
    case 'pdf-aspect': {
      // The short side over the long side, as `fractionalAspectRatio` gives it.
      if (!fraction(value.aspectRatio, true)) throw new Error('Choose an aspect ratio for the pages.');
      if (!(ORIENTATIONS as readonly unknown[]).includes(value.orientation) || typeof value.extend !== 'boolean') throw new Error('Choose an orientation for the pages.');
      return { type: 'pdf-aspect', aspectRatio: value.aspectRatio as number, orientation: value.orientation as (typeof ORIENTATIONS)[number], extend: value.extend, ...(value.rect === undefined ? {} : { rect: parseCropRect(value.rect) }) };
    }
    default: throw new Error('Choose how to crop the pages.');
  }
}

/** The crop window's view: a 1-based PDF page and a fraction of a video's duration. */
export function parseCropView(value: unknown): { page: number; time: number } {
  if (value === undefined) return { page: 1, time: 0 };
  if (!isRecord(value)) throw new Error('Choose a page or a video frame.');
  const { page = 1, time = 0 } = value;
  if (!Number.isInteger(page) || (page as number) < 1 || !fraction(time)) throw new Error('Choose a page or a video frame.');
  return { page: page as number, time: time as number };
}

const rotation = (page: PDFPage) => ((page.getRotation().angle % 360) + 360) % 360;
const same = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) < 0.01);

/** The parts of a result the crop and compare windows read. */
export interface ViewEntry { result: ItemResult; originalPath: string; outputPath: string; placedPath?: string; revision?: number; directory: string; inputFormat: string }

/**
 * The crop window's picture. Images and videos are cropped from their original, so the original (or one of its frames) is shown.
 * PDF page boxes change on the current result: its page is shown whole, with the current crop box as the starting region.
 */
export async function cropSource(entry: ViewEntry, view: { page: number; time: number }, files: MediaFiles, signal?: AbortSignal): Promise<CropSource> {
  const { result: item } = entry;
  if (item.status !== 'ready') throw new Error('Wait for this result to finish first.');
  switch (item.kind) {
    case 'audio': throw new Error('Audio files have nothing to crop.');
    case 'image': {
      const preview = await imagePreview(entry.originalPath, viewFile(entry.directory, entry.originalPath, 'crop.png'), 2600, signal);
      return { item, preview: files.url(preview), width: item.originalWidth, height: item.originalHeight };
    }
    case 'video': {
      const seconds = Math.max(0, ((item.durationMs ?? 0) / 1000) * view.time - 0.05);
      const preview = await videoFramePreview(entry.originalPath, viewFile(entry.directory, entry.originalPath, `crop-${view.time.toFixed(3)}.png`), seconds, 2000, signal);
      return { item, preview: files.url(preview), width: item.originalWidth, height: item.originalHeight };
    }
    case 'pdf': {
      // The current result: a pipeline's file when one replaced the optimised one.
      const current = entry.placedPath ?? entry.outputPath;
      const doc = await loadPDF(current), pages = doc.getPages(), number = Math.min(view.page, pages.length), page = pages[number - 1];
      const media = page.getMediaBox(), box = page.getCropBox(), turned = rotation(page) % 180 !== 0;
      const [width, height] = turned ? [media.height, media.width] : [media.width, media.height];
      const inMedia = { x: (box.x - media.x) / media.width, y: (media.y + media.height - box.y - box.height) / media.height, width: box.width / media.width, height: box.height / media.height };
      const initialRect = clampRect(rotateCropRect(inMedia, 360 - rotation(page)));
      const cropped = pages.some(p => !same(p.getCropBox(), p.getMediaBox()));
      const scale = Math.min(4, 2200 / Math.max(width, height));
      const preview = await pdfPagePreview(current, viewFile(entry.directory, current, `crop-r${entry.revision ?? 0}-page${number}.png`), number, scale, { wholePage: true, signal });
      return { item, preview: files.url(preview), width, height, page: number, pages: pages.length, ...(isFullFrame(initialRect) ? {} : { initialRect }), ...(cropped ? { uncropped: { width, height } } : {}) };
    }
  }
}

/** Crops a result and waits for it. The engine records a failure on the item rather than throwing, so it is raised here for the crop window to show. */
export async function applyCrop(engine: ItemEngine, id: string, request: CropRequest) {
  await engine.crop(id, request);
  // A result dismissed meanwhile has nothing to report.
  const result = engine.has(id) ? engine.get(id).result : undefined;
  if (result?.status === 'error') throw new Error(result.error ?? 'Could not crop this file.');
}

/** The window key `crop:<id>` or `compare:<id>` names a result; its window is sent that one and no other. */
export const viewItems = (items: ItemResult[], key: string) => items.filter(item => item.id === key.slice(key.indexOf(':') + 1));
