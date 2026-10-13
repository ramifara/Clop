import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { retryBusy, run } from '../core/run';
import { toPNG, sniffImage } from '../core/media/image-codecs';
import { sharpInput } from '../core/media/sharp-input';
import { renderPDFPages, uncropPDF } from '../core/media/pdf';

const PIXELS = 60_000_000;
/** Formats Chromium shows in an `<img>` as they are; the rest are previewed as PNG. */
export const DISPLAYABLE_IMAGES = new Set(['png', 'jpeg', 'webp', 'avif', 'gif', 'svg']);
/** Where a view of `file` is kept: in its result's folder, named after the file, so a changed result never shows an old view. */
export const viewFile = (directory: string, file: string, name: string) => path.join(directory, 'views', `${createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 12)}-${name}`);
const exists = (file: string) => stat(file).then(info => info.isFile(), () => false);

/** Makes `out` once with `write`, through a temporary file, so a concurrent request never reads half of it. */
async function once(out: string, write: (tmp: string) => Promise<unknown>) {
  if (await exists(out)) return out;
  await mkdir(path.dirname(out), { recursive: true });
  const tmp = await mkdtemp(path.join(path.dirname(out), '.clop-view-'));
  try {
    const file = path.join(tmp, path.basename(out));
    await write(file);
    await retryBusy(() => rename(file, out));
  } finally { await rm(tmp, { recursive: true, force: true }); }
  return out;
}

/** An upright PNG of an image, at most `maxSide` pixels on its long side (formats sharp cannot read go through the image engine's decoders). */
export function imagePreview(file: string, out: string, maxSide: number, signal?: AbortSignal) {
  return once(out, async tmp => {
    const { format } = await sniffImage(file);
    const decoded = format && ['heic', 'jxl', 'bmp'].includes(format) ? await toPNG(file, `${tmp}.decoded.png`, { signal, limitInputPixels: PIXELS }) : undefined;
    try { await sharp(decoded ?? await sharpInput(file), { limitInputPixels: PIXELS }).autoOrient().resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true }).png().toFile(tmp); }
    finally { if (decoded) await rm(decoded, { force: true }); }
  });
}

/** A PNG of the video frame at `seconds`, at most `maxSide` pixels on its long side. */
export function videoFramePreview(file: string, out: string, seconds: number, maxSide: number, signal?: AbortSignal) {
  return once(out, tmp => run('ffmpeg', ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, seconds).toFixed(3), '-i', file, '-frames:v', '1', '-update', '1',
    '-vf', `scale=w='min(${maxSide},iw)':h='min(${maxSide},ih)':force_original_aspect_ratio=decrease`, '-f', 'image2', '-c:v', 'png', tmp], { signal }));
}

/** A PNG of a PDF page at `scale` pixels per point; `wholePage` shows the full MediaBox rather than the CropBox. */
export function pdfPagePreview(file: string, out: string, page: number, scale: number, { wholePage = false, signal }: { wholePage?: boolean; signal?: AbortSignal } = {}) {
  return once(out, async tmp => {
    const dir = await mkdtemp(path.join(path.dirname(tmp), '.clop-page-'));
    try {
      const source = wholePage ? (await uncropPDF(file, dir, { name: 'page' })).path : file;
      const [rendered] = await renderPDFPages(source, dir, { firstPage: page, lastPage: page, scale, name: 'render', signal });
      await rename(rendered.path, tmp);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}
