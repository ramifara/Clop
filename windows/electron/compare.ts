import { audioMetadata } from '../core/media/audio';
import { loadPDF } from '../core/media/pdf';
import type { CompareSide, CompareSources } from '../src/types';
import type { ViewEntry } from './crop';
import type { MediaFiles } from './media-files';
import { DISPLAYABLE_IMAGES, imagePreview, pdfPagePreview, viewFile } from './previews';

/** The compare window's page: a whole number from 1. */
export function parseCompareView(value: unknown): { page: number } {
  if (value === undefined) return { page: 1 };
  const page = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { page?: unknown }).page ?? 1 : undefined;
  if (!Number.isInteger(page) || (page as number) < 1) throw new Error('Choose a page to compare.');
  return { page: page as number };
}

/**
 * The original and the current result, for the compare window. Images the window cannot show as they are (HEIC, JPEG XL, BMP,
 * TIFF) are shown as full-size PNGs, PDFs as a rendered page each (the whole page, not its crop box), and videos and audio files play as they are.
 */
export async function compareSources(entry: ViewEntry, view: { page: number }, files: MediaFiles, signal?: AbortSignal): Promise<CompareSources> {
  const { result: item } = entry;
  if (item.status !== 'ready') throw new Error('Wait for this result to finish first.');
  const pages = item.kind === 'pdf' ? (await loadPDF(entry.outputPath, { allowEncrypted: true })).getPageCount() : undefined;
  const page = Math.min(view.page, pages ?? 1);
  async function side(file: string, format: string, facts: Omit<CompareSide, 'url' | 'kind' | 'format'>): Promise<CompareSide> {
    let shown = file;
    if (item.kind === 'image' && !DISPLAYABLE_IMAGES.has(format)) shown = await imagePreview(file, viewFile(entry.directory, file, 'compare.png'), 16383, signal);
    if (item.kind === 'pdf') {
      // The original can have fewer pages than a result that gained some; its last page stands in.
      const count = (await loadPDF(file, { allowEncrypted: true })).getPageCount(), number = Math.min(page, count);
      // The whole page on both sides, as CompareView.swift's `displayBox = .mediaBox` does: a result's crop box would otherwise misalign the split.
      shown = await pdfPagePreview(file, viewFile(entry.directory, file, `compare-page${number}.png`), number, 2, { wholePage: true, signal });
    }
    const bitrate = item.kind === 'audio' ? await audioMetadata(file, { signal }).then(info => info.bitrate && Math.round(info.bitrate / 1000), () => undefined) : undefined;
    return { url: files.url(shown), kind: item.kind, format, ...facts, ...(bitrate ? { bitrate } : {}) };
  }
  const sized = item.kind === 'image' || item.kind === 'video';
  const original = await side(entry.originalPath, entry.inputFormat, { bytes: item.originalBytes, ...(sized ? { width: item.originalWidth, height: item.originalHeight } : {}), durationMs: item.durationMs });
  const result = await side(entry.outputPath, item.format, { bytes: item.outputBytes, ...(sized ? { width: item.width, height: item.height } : {}), durationMs: item.durationMs });
  return { item, original, result, ...(pages ? { page, pages } : {}) };
}
