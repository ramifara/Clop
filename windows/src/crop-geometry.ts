import { clampRect, cropGeometry, even, extendToAspectRatio } from '../core/media/crop-size';
import type { CropOrientation, CropRect, CropSize } from './types';

// The crop window's selection model, ported from CropSelectionOverlay and CropView in CropWindow.swift.
export interface Size { width: number; height: number }
/** A selection in view pixels, top-left origin. */
export interface Box { x: number; y: number; width: number; height: number }
export type Handle = 'topLeft' | 'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left';
export const HANDLES: readonly Handle[] = ['topLeft', 'top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left'];
export const FULL: CropRect = { x: 0, y: 0, width: 1, height: 1 };
/** The smallest side a selection keeps while resizing, in view pixels. */
const MIN_SIDE = 24;

const isCorner = (handle: Handle) => handle === 'topLeft' || handle === 'topRight' || handle === 'bottomRight' || handle === 'bottomLeft';
const isHorizontalEdge = (handle: Handle) => handle === 'top' || handle === 'bottom';
export const orientationOf = (size: Size): Exclude<CropOrientation, 'adaptive'> => size.width >= size.height ? 'landscape' : 'portrait';
export const sameRect = (a: CropRect, b: CropRect) => (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(a[key] - b[key]) < 1e-6);

export function handlePoint(handle: Handle, b: Box) {
  const x = handle.endsWith('Left') || handle === 'left' ? b.x : handle.endsWith('Right') || handle === 'right' ? b.x + b.width : b.x + b.width / 2;
  const y = handle.startsWith('top') ? b.y : handle.startsWith('bottom') ? b.y + b.height : b.y + b.height / 2;
  return { x, y };
}
export const toBox = (r: CropRect, view: Size): Box => ({ x: r.x * view.width, y: r.y * view.height, width: r.width * view.width, height: r.height * view.height });
/** `commit`: a view selection back to a clamped relative rectangle. */
export const toRect = (b: Box, view: Size): CropRect => clampRect({ x: b.x / view.width, y: b.y / view.height, width: b.width / view.width, height: b.height / view.height });

/** `moveGesture`: the selection dragged by `dx`, `dy`, kept inside the view. */
export function moved(start: Box, dx: number, dy: number, view: Size): Box {
  return { ...start, x: Math.min(Math.max(start.x + dx, 0), view.width - start.width), y: Math.min(Math.max(start.y + dy, 0), view.height - start.height) };
}

/** `marqueeGesture`: a new selection drawn from `from` to `to`, at `aspect` (width over height) when locked. Undefined while under 8 pixels. */
export function marquee(from: { x: number; y: number }, to: { x: number; y: number }, view: Size, aspect?: number): Box | undefined {
  let w = to.x - from.x, h = to.y - from.y;
  if (aspect) {
    if (Math.abs(w) / aspect >= Math.abs(h)) h = (Math.abs(w) / aspect) * (h < 0 ? -1 : 1);
    else w = Math.abs(h) * aspect * (w < 0 ? -1 : 1);
    // Reaching an edge shrinks both sides together, so the locked aspect holds (macOS clips each side alone and loses it).
    const fit = Math.min(1, (w < 0 ? from.x : view.width - from.x) / Math.abs(w), (h < 0 ? from.y : view.height - from.y) / Math.abs(h));
    if (fit < 1) { w *= fit; h *= fit; }
  }
  const x0 = Math.max(w < 0 ? from.x + w : from.x, 0), y0 = Math.max(h < 0 ? from.y + h : from.y, 0);
  const x1 = Math.min((w < 0 ? from.x + w : from.x) + Math.abs(w), view.width), y1 = Math.min((h < 0 ? from.y + h : from.y) + Math.abs(h), view.height);
  return x1 - x0 >= 8 && y1 - y0 >= 8 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : undefined;
}

/** `resized(start:handle:translation:)`: the selection with `handle` dragged by `dx`, `dy`; the opposite side (or edge centre) stays put. */
export function resized(start: Box, handle: Handle, dx: number, dy: number, view: Size, aspect?: number): Box {
  const anchor = {
    x: isHorizontalEdge(handle) ? start.x + start.width / 2 : handle.endsWith('Left') || handle === 'left' ? start.x + start.width : start.x,
    y: handle === 'left' || handle === 'right' ? start.y + start.height / 2 : handle.startsWith('top') ? start.y + start.height : start.y,
  };
  const growsLeft = handle === 'topLeft' || handle === 'left' || handle === 'bottomLeft', growsUp = handle === 'topLeft' || handle === 'top' || handle === 'topRight';
  let w = isHorizontalEdge(handle) ? start.width : start.width + (growsLeft ? -dx : dx);
  let h = handle === 'left' || handle === 'right' ? start.height : start.height + (growsUp ? -dy : dy);
  // The room from the anchor towards where the selection can grow.
  const availableWidth = isHorizontalEdge(handle) ? 2 * Math.min(anchor.x, view.width - anchor.x) : growsLeft ? anchor.x : view.width - anchor.x;
  const availableHeight = handle === 'left' || handle === 'right' ? 2 * Math.min(anchor.y, view.height - anchor.y) : growsUp ? anchor.y : view.height - anchor.y;
  if (aspect) {
    if (isCorner(handle)) { if (Math.abs(dx) * start.height >= Math.abs(dy) * start.width) h = w / aspect; else w = h * aspect; }
    else if (isHorizontalEdge(handle)) w = h * aspect;
    else h = w / aspect;
    w = Math.max(w, MIN_SIDE); h = w / aspect;
    if (h < MIN_SIDE) { h = MIN_SIDE; w = h * aspect; }
    if (w > availableWidth) { w = availableWidth; h = w / aspect; }
    if (h > availableHeight) { h = availableHeight; w = h * aspect; }
  } else {
    w = Math.min(Math.max(w, MIN_SIDE), availableWidth);
    h = Math.min(Math.max(h, MIN_SIDE), availableHeight);
  }
  const x = isHorizontalEdge(handle) ? anchor.x - w / 2 : growsLeft ? anchor.x - w : anchor.x;
  const y = handle === 'left' || handle === 'right' ? anchor.y - h / 2 : growsUp ? anchor.y - h : anchor.y;
  return { x, y, width: w, height: h };
}

/** `centeredMaxRect(aspect:)`: the largest centred selection of `aspect` (width over height) in `space`. */
export function centeredMaxRect(aspect: number, space: Size): CropRect {
  const w = Math.min(space.width, space.height * aspect), h = w / aspect, rw = w / space.width, rh = h / space.height;
  return clampRect({ x: (1 - rw) / 2, y: (1 - rh) / 2, width: rw, height: rh });
}

/** `CropSize.withOrientation(_:for:)`, without the name and flags: the size turned to the orientation (adaptive: the source's). */
export function oriented(size: Size, orientation: CropOrientation, source: Size): Size {
  const want = orientation === 'adaptive' ? orientationOf(source) : orientation;
  return orientationOf(size) === want || size.width === size.height ? { width: size.width, height: size.height } : { width: size.height, height: size.width };
}

/**
 * The locked aspect after the orientation changes to `next`: a forced one turns the current aspect, and adaptive turns the chosen
 * preset (`adaptive`) back to the source's own orientation. Undefined when adaptive has no preset to go back to.
 */
export function reorientedAspect(locked: number, next: CropOrientation, source: Size, adaptive?: Size): number | undefined {
  if (next === 'adaptive') { if (!adaptive) return undefined; const size = oriented(adaptive, next, source); return size.width / size.height; }
  return next === 'landscape' ? Math.max(locked, 1 / locked) : Math.min(locked, 1 / locked);
}

/** `CropRect.computedSize(from:)`: the selection's size in the source's pixels (points for a PDF). */
export const selectionSize = (r: CropRect, space: Size): Size => ({ width: r.width * space.width, height: r.height * space.height });

/** `effectiveTargetSize()`: the size the result will have, the preset's when the selection is at least that big. */
export function targetSize(r: CropRect, space: Size, target?: Size): Size {
  const selection = selectionSize(r, space);
  return target && target.width <= selection.width && target.height <= selection.height ? target : selection;
}

/** `setPixelSize(width:height:)`: the selection resized around its centre to typed dimensions, keeping a locked aspect. */
export function sizedRect(r: CropRect, space: Size, size: Size, changed: 'width' | 'height', aspect?: number): CropRect {
  let { width: w, height: h } = size;
  if (aspect) { if (changed === 'width') h = w / aspect; else w = h * aspect; }
  w = Math.min(Math.max(w, 8), space.width); h = Math.min(Math.max(h, 8), space.height);
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  return clampRect({ x: cx - w / space.width / 2, y: cy - h / space.height / 2, width: w / space.width, height: h / space.height });
}

/** `extendedCanvasSize(aspect:)`: the page grown to the aspect (short over long side) with empty paper. */
export function extendedCanvas(source: Size, fractional: number, orientation: CropOrientation): Size {
  const box = extendToAspectRatio(source.width, source.height, { aspectRatio: fractional, alwaysPortrait: orientation === 'portrait', alwaysLandscape: orientation === 'landscape' });
  return { width: box.width, height: box.height };
}

export const fractionalAspect = (size: Size) => Math.min(size.width, size.height) / Math.max(size.width, size.height);
/** The area the size presets sort by (`CropSize.area`), an auto side counting as the other. */
export const area = (size: CropSize) => (size.width || size.height) * (size.height || size.width);

/** What a result's downscale and longest edge apply to: the original's size, or the area its crop keeps of it. */
export function keptSize(crop: CropSize | undefined, width: number, height: number): Size {
  if (!crop) return { width, height };
  try { const kept = cropGeometry(crop, width, height); return { width: kept.width, height: kept.height }; } catch { return { width, height }; }
}

/** The most pixels a side can have, Clop's longest written edge (WebP's limit). */
export const MAX_SIDE = 16383;
/** `even` for a side to write: odd sizes round up to the next even one, except at the limit, where that would pass it and the previous even one is used. */
export const evenSide = (value: number) => Math.min(even(value), MAX_SIDE - 1);
