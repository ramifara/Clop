import type { CropSize } from '../settings/schema';

/** A `CropSize` (Shared/CropSize.swift) without its display name. */
export type CropSpec = Pick<CropSize, 'width' | 'height'> & Partial<Pick<CropSize, 'longEdge' | 'smartCrop' | 'isAspectRatio' | 'cropRect'>>;
/** Pixels of the displayed (upright) image. */
export interface Rect { left: number; top: number; width: number; height: number }
/** What a crop does to a `width` × `height` image: cut `crop` out, or fill `width` × `height` around the `fill` region. */
export interface Geometry { width: number; height: number; crop?: Rect; fill?: 'attention' | 'centre' }

/** The centred region of a `width` × `height` source with the aspect ratio of `target` (gifsicle's and ffmpeg's crops in Images.swift). */
export function centreRect(width: number, height: number, target: { width: number; height: number }): Rect {
  if (width / target.width > height / target.height) {
    const w = Math.max(1, Math.round((target.width / target.height) * height));
    return { left: Math.floor((width - w) / 2), top: 0, width: w, height };
  }
  const h = Math.max(1, Math.round((target.height / target.width) * width));
  return { left: 0, top: Math.floor((height - h) / 2), width, height: h };
}

/** Swift's `evenInt`: rounded, then odd values up to the next even one. */
export const even = (value: number) => { const x = Math.round(value); return x + (x % 2); };

/**
 * The geometry `Image.resize(toSize:)` gives a CropSize: a relative `cropRect` is cut out and scaled
 * down (never up) to the size when one is set; any other size is filled exactly, cutting around the
 * attention region with `smartCrop` and the centre otherwise, like `vipsthumbnail --smartcrop`.
 */
export function cropGeometry(size: CropSpec, width: number, height: number): Geometry {
  if (size.cropRect && !isFullFrame(size.cropRect)) {
    const crop = pixelRect(size.cropRect, width, height);
    const smaller = size.width > 0 && size.height > 0 && (size.width < crop.width || size.height < crop.height);
    return { crop, width: smaller ? size.width : crop.width, height: smaller ? size.height : crop.height };
  }
  const target = computedSize(size, width, height);
  const geometry = { width: even(target.width), height: even(target.height), fill: size.smartCrop ? 'attention' as const : 'centre' as const };
  if (geometry.width < 1 || geometry.height < 1) throw new Error('Choose a crop size with a width or a height.');
  return geometry;
}

export const isFullFrame = (r: NonNullable<CropSpec['cropRect']>) => r.x <= 0.005 && r.y <= 0.005 && r.width >= 0.995 && r.height >= 0.995;

/** `CropRect.clamped()`: at least 0.1 % wide and high, and inside the frame. */
export function clampRect(rect: NonNullable<CropSpec['cropRect']>) {
  const width = Math.min(Math.max(rect.width, 0.001), 1), height = Math.min(Math.max(rect.height, 0.001), 1);
  return { x: Math.min(Math.max(rect.x, 0), 1 - width), y: Math.min(Math.max(rect.y, 0), 1 - height), width, height };
}

/** `CropRect.pixelRect(in:)`: the clamped relative rectangle in whole pixels, at least one pixel wide and inside the image. */
export function pixelRect(rect: NonNullable<CropSpec['cropRect']>, width: number, height: number): Rect {
  const { x: rx, y: ry, width: w, height: h } = clampRect(rect);
  const left = Math.min(Math.max(Math.round(rx * width), 0), Math.max(width - 1, 0)), top = Math.min(Math.max(Math.round(ry * height), 0), Math.max(height - 1, 0));
  return { left, top, width: Math.min(Math.max(Math.round(w * width), 1), width - left), height: Math.min(Math.max(Math.round(h * height), 1), height - top) };
}

/** `CropSize.factor(from:)`: how much of the image's area (or long edge) the size keeps. */
function factor(size: CropSpec, width: number, height: number) {
  if (size.isAspectRatio) { const c = computedSize(size, width, height); return (c.width * c.height) / (width * height); }
  if (size.longEdge) return (size.width === 0 ? size.height : size.width) / Math.max(width, height);
  if (size.width === 0) return size.height / height;
  if (size.height === 0) return size.width / width;
  return (size.width * size.height) / (width * height);
}

/** `CropSize.computedSize(from:)`: an exact size as it is, a ratio cut to the image's orientation (or the ratio's own unless `longEdge`), anything else scaled. */
export function computedSize(size: CropSpec, width: number, height: number): { width: number; height: number } {
  if (size.width !== 0 && size.height !== 0 && !size.longEdge && !size.isAspectRatio) return { width: size.width, height: size.height };
  if (size.isAspectRatio) {
    const ratio = Math.min(size.width, size.height) / Math.max(size.width, size.height);
    const portrait = !size.longEdge && size.width < size.height ? true : !size.longEdge && size.height < size.width ? false : height >= width;
    return portrait ? cutPortrait(width, height, ratio) : cutLandscape(width, height, ratio);
  }
  const f = factor(size, width, height);
  return { width: even(width * f), height: even(height * f) };
}

/** `NSSize.cropToPortrait(aspectRatio:)`: the largest centred region whose width over height is `ratio`. */
export function cutPortrait(width: number, height: number, ratio: number) {
  return width / height > ratio ? { width: height * ratio, height } : { width, height: width / ratio };
}

/** `NSSize.cropToLandscape(aspectRatio:)`: the largest centred region whose height over width is `ratio`. */
export function cutLandscape(width: number, height: number, ratio: number) {
  return height / width > ratio ? { width, height: width * ratio } : { width: height / ratio, height };
}
