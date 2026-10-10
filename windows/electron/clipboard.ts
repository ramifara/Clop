import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../core/media/detect';
import type { MediaKind } from '../core/media/types';
import type { ClopSettings } from '../core/settings/schema';
import type { ClipboardChange } from './pickup';

/** `DEFAULT_NAME_TEMPLATE` in SettingsView.swift, for clipboard images when the custom template is empty. */
export const DEFAULT_NAME_TEMPLATE = 'clop_%y-%m-%d_%i';
const MAX_FILES = 64, MAX_PATH = 32_767;
/** Base64 for a 128 MB file, the engine's input limit. */
const MAX_DATA_URL = Math.ceil(128 * 1024 * 1024 / 3) * 4 + 256;
const KIND = new Map<string, MediaKind>([...IMAGE_EXTENSIONS.map(e => [e, 'image'] as const), ...VIDEO_EXTENSIONS.map(e => [e, 'video'] as const), ...AUDIO_EXTENSIONS.map(e => [e, 'audio'] as const), ['pdf', 'pdf']]);
/** Extensions that name the same format, so `tif` is skipped with `tiff` in `imageFormatsToSkip`. */
const ALIASES: Record<string, string> = { jpg: 'jpeg', tif: 'tiff', heif: 'heic', aif: 'aiff', qt: 'mov', mpg: 'mpeg' };
const format = (ext: string) => { ext = ext.toLowerCase().replace(/^\./, ''); return ALIASES[ext] ?? ext; };
/** Media files made by core/fileops while it copies; never inputs. */
const TEMPORARY = /^\.clop-.*\.tmp$/i;

export const mediaKind = (file: string) => KIND.get(path.extname(file).slice(1).toLowerCase());
export type ClipboardSettings = Pick<ClopSettings, 'optimiseVideoClipboard' | 'optimisePDFClipboard' | 'optimiseAudioClipboard' | 'optimiseImagePathClipboard' | 'imageFormatsToSkip' | 'videoFormatsToSkip' | 'audioFormatsToSkip'>;

/** Whether an automatic clipboard optimisation takes a file of this kind, by the per-type clipboard settings (`handleClipboardChange` in ClopApp.swift). */
export function takesFile(kind: MediaKind, file: string, settings: ClipboardSettings, { bitmap = false } = {}) {
  const skips = (list: readonly string[]) => list.some(item => format(item) === format(path.extname(file)));
  switch (kind) {
    // A copied image file with no image data beside it is only a reference, as Explorer copies it (`optimiseImagePathClipboard`).
    case 'image': return (bitmap || settings.optimiseImagePathClipboard) && !skips(settings.imageFormatsToSkip);
    case 'video': return settings.optimiseVideoClipboard && !skips(settings.videoFormatsToSkip);
    case 'pdf': return settings.optimisePDFClipboard;
    case 'audio': return settings.optimiseAudioClipboard && !skips(settings.audioFormatsToSkip);
  }
}

/**
 * The files of a clipboard file list to optimise. A manual optimisation takes every media file; an automatic one only what the
 * per-type settings allow, and never Clop's own results. `media` says whether the list held any media file at all: then the
 * image data that apps put beside a file is not optimised on its own.
 */
export function clipboardFiles(files: readonly string[], { manual, bitmap, settings, owns }: { manual: boolean; bitmap: boolean; settings: ClipboardSettings; owns: (file: string) => boolean }) {
  const media = files.filter(file => !TEMPORARY.test(path.basename(file)) && mediaKind(file));
  const take = media.filter(file => manual || (!owns(file) && takesFile(mediaKind(file)!, file, settings, { bitmap })));
  return { files: take, media: media.length > 0 };
}

export type ClipboardText = { type: 'path'; path: string } | { type: 'image'; bytes: Buffer; ext: string } | { type: 'url'; url: string };
const DATA_URL = /^(?:url\(\s*["']?)?data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)["']?\s*\)?$/i;
/**
 * What copied text holds, as `ClipboardType.fromString` reads it: a base64 data URL of an image, an absolute file path
 * (quoted or as a `file:` URL), or an http(s) link. A path must be absolute: a drive or UNC path on Windows.
 */
export function parseClipboardText(text: string, platform: NodeJS.Platform = process.platform): ClipboardText | undefined {
  if (text.length > MAX_DATA_URL) return;
  const value = text.trim().replace(/^"(.*)"$/s, '$1').trim();
  const data = DATA_URL.exec(value);
  if (data) {
    const bytes = Buffer.from(data[2].replace(/\s+/g, ''), 'base64');
    return bytes.length ? { type: 'image', bytes, ext: data[1].toLowerCase() === 'svg+xml' ? 'svg' : data[1].toLowerCase() } : undefined;
  }
  if (!value || value.length > MAX_PATH || /[\r\n]/.test(value)) return;
  if (/^file:/i.test(value)) { try { return { type: 'path', path: fileURLToPath(value, { windows: platform === 'win32' }) }; } catch { return; } }
  if (platform === 'win32' ? /^([a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value) : value.startsWith('/')) return { type: 'path', path: value };
  if (/^https?:\/\/\S+$/i.test(value)) { try { return { type: 'url', url: new URL(value).href }; } catch { return; } }
}

/** A clipboard change or snapshot from the Windows helper, checked field by field. Undefined when it is malformed. */
export function clipboardChange(event: unknown): ClipboardChange & { owned?: boolean; transient?: boolean } | undefined {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  const flag = (key: string) => e[key] === undefined || typeof e[key] === 'boolean';
  if (!Number.isSafeInteger(e.sequence) || (e.sequence as number) < 0 || !Array.isArray(e.paths) || e.paths.length > MAX_FILES) return;
  if (!e.paths.every(file => typeof file === 'string' && file.length > 0 && file.length <= MAX_PATH && path.isAbsolute(file))) return;
  if (!['image', 'bitmap', 'text', 'owned', 'transient'].every(flag)) return;
  if (e.process !== undefined && !Number.isSafeInteger(e.process)) return;
  if (e.app !== undefined && typeof e.app !== 'string') return;
  return {
    sequence: e.sequence as number, paths: e.paths as string[], image: e.image === true, bitmap: e.bitmap === true, text: e.text === true,
    ...(e.process === undefined ? {} : { process: e.process as number }), ...(e.app === undefined ? {} : { app: e.app as string }),
    ...(e.owned === undefined ? {} : { owned: e.owned as boolean }), ...(e.transient === undefined ? {} : { transient: e.transient as boolean }),
  };
}
