import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../core/run';
import { extractCoverArt } from '../core/media/coverArt';
import { renderPDFPages } from '../core/media/pdf';
import { toPNG } from '../core/media/image-codecs';
import { sharpInput } from '../core/media/sharp-input';
import type { MediaKind } from '../core/media/types';

const PIXELS = 60_000_000;
/**
 * Cards are 196 × 148 px and fill that box with the preview (`object-fit: cover`), so what matters is the preview's short side: it
 * covers the box at 200 % display scaling, and a panorama is not shrunk below the card's height, nor kept longer than `LONGEST`.
 */
const IMAGE_BOX = { width: 392, height: 296 };
const LONGEST = 2000;
/** Video, PDF and audio previews never change with the result, so a small one is enough. */
const MEDIA_BOX = { width: 480, height: 360 };
/** A preview is made twice per image and sent to the windows with every change: zlib's fastest levels write it in a fraction of the default's time, for a little more size. */
const PREVIEW_COMPRESSION = 2;
const png = async (source: string | Buffer, box: { width: number; height: number }) => {
  const bytes = await sharp(source, { limitInputPixels: PIXELS }).autoOrient().resize({ ...box, fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: PREVIEW_COMPRESSION }).toBuffer();
  return `data:image/png;base64,${bytes.toString('base64')}`;
};

/** The size a `width` × `height` image is previewed at for a card: covering `IMAGE_BOX`, never enlarged, at most `LONGEST` on its long side. */
export function cardPreviewSize(width: number, height: number) {
  let scale = Math.min(1, Math.max(IMAGE_BOX.width / width, IMAGE_BOX.height / height));
  scale = Math.min(scale, LONGEST / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A card preview of an image sharp reads, at `cardPreviewSize`. */
async function cardPNG(source: string | Buffer) {
  const image = sharp(source, { limitInputPixels: PIXELS }).autoOrient(), meta = await image.metadata();
  // `autoOrient` turns the pixels, so the size is the displayed one.
  const turned = (meta.orientation ?? 1) >= 5, width = (turned ? meta.height : meta.width) ?? 1, height = (turned ? meta.width : meta.height) ?? 1;
  const bytes = await image.resize({ ...cardPreviewSize(width, height), fit: 'fill' }).png({ compressionLevel: PREVIEW_COMPRESSION }).toBuffer();
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

/** A PNG data URL for the card. `decode` routes formats sharp cannot read, and HDR, through the image engine's decoders, which write no more than the preview needs. */
export async function imageThumbnail(file: string, decode = false) {
  const decoded = decode ? await toPNG(file, path.join(path.dirname(file), 'preview.png'), { limitInputPixels: PIXELS, box: { width: LONGEST, height: LONGEST }, compressionLevel: 1 }) : undefined;
  try { return await cardPNG(decoded ?? await sharpInput(file)); } finally { if (decoded) await rm(decoded, { force: true }); }
}

/**
 * The card preview of a video (a frame a second in, or a third of the way through a shorter clip), a PDF (its first page)
 * or an audio file (its cover art). Anything that cannot be rendered gets a drawn placeholder; only an abort rejects.
 */
export async function mediaThumbnail(kind: Exclude<MediaKind, 'image'>, file: string, { durationMs, signal }: { durationMs?: number; signal?: AbortSignal } = {}) {
  const scratch = await mkdtemp(path.join(path.dirname(file), '.clop-preview-'));
  try {
    const source = kind === 'video' ? await videoFrame(file, scratch, durationMs, signal)
      : kind === 'pdf' ? (await renderPDFPages(file, scratch, { firstPage: 1, lastPage: 1, scale: 1, signal }))[0].path
      : await extractCoverArt(file, scratch, 'cover', signal);
    if (source) return await png(source, MEDIA_BOX);
  } catch (error) { if (signal?.aborted) throw error; }
  finally { await rm(scratch, { recursive: true, force: true }); }
  return placeholder(kind);
}

async function videoFrame(file: string, dir: string, durationMs: number | undefined, signal?: AbortSignal) {
  const at = Math.min(1, (durationMs ?? 0) / 3000), out = path.join(dir, 'frame.png');
  await run('ffmpeg', ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-update', '1', '-vf', `scale=w='min(${MEDIA_BOX.width},iw)':h='min(${MEDIA_BOX.height},ih)':force_original_aspect_ratio=decrease`, out], { signal });
  return out;
}

// Drawn without text: librsvg would need fonts, which differ from machine to machine.
const GLYPHS: Record<Exclude<MediaKind, 'image'>, string> = {
  video: '<rect x="170" y="125" width="140" height="110" rx="14" fill="none" stroke="#f1e8d2" stroke-width="10"/><path d="M225 155v50l42-25z" fill="#ffc46e"/>',
  pdf: '<path d="M190 105h70l40 40v110a10 10 0 0 1-10 10H190a10 10 0 0 1-10-10V115a10 10 0 0 1 10-10z" fill="none" stroke="#f1e8d2" stroke-width="10"/><path d="M205 175h70M205 200h70M205 225h45" stroke="#ffc46e" stroke-width="9" stroke-linecap="round"/>',
  audio: `<path d="M212 230V130l70-15v95" fill="none" stroke="#f1e8d2" stroke-width="10"/><circle cx="196" cy="232" r="20" fill="#ffc46e"/><circle cx="266" cy="212" r="20" fill="#ffc46e"/>${[60, 90, 120, 330, 360, 390].map((x, i) => `<rect x="${x}" y="${180 - [20, 45, 30, 35, 50, 25][i]}" width="12" height="${[40, 90, 60, 70, 100, 50][i]}" rx="6" fill="#f1e8d255"/>`).join('')}`,
};
const placeholders = new Map<string, Promise<string>>();
/** A drawn preview for a file without a picture: a film frame, a page or a note over a waveform. */
export function placeholder(kind: Exclude<MediaKind, 'image'>) {
  let preview = placeholders.get(kind);
  if (!preview) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${MEDIA_BOX.width}" height="${MEDIA_BOX.height}"><defs><linearGradient id="g" x2="0" y2="1"><stop stop-color="#4a4150"/><stop offset="1" stop-color="#231f26"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${GLYPHS[kind]}</svg>`;
    preview = png(Buffer.from(svg), MEDIA_BOX);
    preview.catch(() => placeholders.delete(kind));
    placeholders.set(kind, preview);
  }
  return preview;
}
