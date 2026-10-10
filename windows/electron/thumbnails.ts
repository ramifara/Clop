import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { run } from '../core/run';
import { extractCoverArt } from '../core/media/coverArt';
import { renderPDFPages } from '../core/media/pdf';
import { toPNG } from '../core/media/image-codecs';
import type { MediaKind } from '../core/media/types';

const PIXELS = 60_000_000;
/** Cards are 196 px wide; video, PDF and audio previews never change with the result, so a small one is enough. */
const MEDIA_BOX = { width: 480, height: 360 };
const png = async (source: string | Buffer, box: { width: number; height: number }) => {
  const bytes = await sharp(source, { limitInputPixels: PIXELS }).autoOrient().resize({ ...box, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  return `data:image/png;base64,${bytes.toString('base64')}`;
};

/** A PNG data URL for the card. `decode` routes formats sharp cannot read, and HDR, through the image engine's decoders. */
export async function imageThumbnail(file: string, decode = false) {
  const source = decode ? await toPNG(file, path.join(path.dirname(file), 'preview.png'), { limitInputPixels: PIXELS }) : file;
  try { return await png(source, { width: 1000, height: 760 }); } finally { if (source !== file) await rm(source, { force: true }); }
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
    placeholders.set(kind, preview);
  }
  return preview;
}
