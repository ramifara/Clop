import type { CropSpec } from '../media/crop-size';
import type { CropSize } from '../settings/schema';

// The batch crop of BatchCropButton.swift with CropSize.flipped and CropSize.withOrientation from Shared/CropSize.swift.

export type CropOrientation = 'landscape' | 'portrait' | 'adaptive';

/** `CropSize.flipped`: swaps the sides, and the sides of a ratio's name (`16:9` becomes `9:16`). */
export function flipped(size: CropSize): CropSize {
  const name = size.name.includes(':') ? size.name.split(':').reverse().join(':') : size.name;
  return { ...size, width: size.height, height: size.width, name };
}

/** `CropSize.withOrientation` without an image size: landscape and portrait turn the size their way; adaptive keeps it and lets each file's orientation decide. */
export function withOrientation(size: CropSize, orientation: CropOrientation): CropSize {
  if (orientation === 'adaptive') return { ...size, longEdge: true };
  const landscape = size.width >= size.height;
  return { ...(landscape === (orientation === 'landscape') ? size : flipped(size)), longEdge: false };
}

/**
 * The crop a batch applies for a preset, as BatchCropButton builds it: an aspect ratio with the chosen orientation, or the
 * oriented width and height of an exact size, cut exactly from every file. A width or height of 0 scales to the other side.
 */
export function batchCrop(size: CropSize, orientation: CropOrientation): CropSpec {
  const oriented = withOrientation(size, orientation);
  return size.isAspectRatio ? { width: oriented.width, height: oriented.height, longEdge: oriented.longEdge, isAspectRatio: true } : { width: oriented.width, height: oriented.height };
}

/** The aspect ratio a PDF page is cut to (PDFPipeline.swift): short over long side for an adaptive ratio, width over height otherwise. */
export const pdfAspectRatio = (crop: CropSpec) => crop.longEdge ? Math.min(crop.width, crop.height) / Math.max(crop.width, crop.height) : crop.width / crop.height;
