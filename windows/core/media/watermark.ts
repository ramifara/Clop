import sharp, { type OverlayOptions } from 'sharp';

export type WatermarkPosition = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'center';
export interface Watermark { file: string; position?: WatermarkPosition; opacity?: number; scale?: number }

const PADDING = 20;

/** A fraction of the image's width (0.15 by default), at least 16 pixels and at most the image's width. */
const watermarkWidth = (imageWidth: number, { scale = 0.15 }: Watermark) => Math.min(imageWidth, Math.max(16, Math.round(imageWidth * scale)));

/** The ffmpeg filters that scale the watermark input and overlay it, from `watermarkWithFFmpeg` (PipelineExecution.swift). */
export function watermarkFilters(imageWidth: number, watermark: Watermark) {
  const at = { topLeft: `${PADDING}:${PADDING}`, topRight: `W-w-${PADDING}:${PADDING}`, bottomLeft: `${PADDING}:H-h-${PADDING}`, center: '(W-w)/2:(H-h)/2', bottomRight: `W-w-${PADDING}:H-h-${PADDING}` };
  return { scale: `scale=${watermarkWidth(imageWidth, watermark)}:-1,format=rgba,colorchannelmixer=aa=${watermark.opacity ?? 1}`, overlay: `overlay=${at[watermark.position ?? 'bottomRight']}` };
}

/** The watermark scaled to a `width` × `height` image and placed as `watermarked` (Images.swift) draws it, kept inside the image. */
export async function watermarkOverlay(watermark: Watermark, width: number, height: number): Promise<OverlayOptions> {
  const source = await sharp(watermark.file).metadata();
  let w = watermarkWidth(width, watermark), h = Math.max(1, Math.round((w * (source.height ?? 1)) / (source.width ?? 1)));
  if (h > height) { w = Math.max(1, Math.round((w * height) / h)); h = height; }
  const corners = { topLeft: [PADDING, PADDING], topRight: [width - w - PADDING, PADDING], bottomLeft: [PADDING, height - h - PADDING], center: [(width - w) / 2, (height - h) / 2], bottomRight: [width - w - PADDING, height - h - PADDING] };
  const [left, top] = corners[watermark.position ?? 'bottomRight'];
  const inside = (value: number, room: number) => Math.max(0, Math.min(room, Math.round(value)));
  const input = await sharp(watermark.file).resize(w, h, { fit: 'fill' }).ensureAlpha().linear([1, 1, 1, watermark.opacity ?? 1], [0, 0, 0, 0]).png().toBuffer();
  return { input, left: inside(left, width - w), top: inside(top, height - h) };
}
