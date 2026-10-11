import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from '../core/media/detect';
import type { MediaKind } from '../core/media/types';
import type { ClopSettings } from '../core/settings/schema';
import type { ItemResult } from '../src/types';
import type { ClipboardChange } from './pickup';
import { ignoredApp } from './apps';

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
/** Whether `file`'s format is in a `…FormatsToSkip` list, under any of its extensions. */
export const skipsFormat = (list: readonly string[], file: string) => list.some(item => format(item) === format(path.extname(file)));
export type ClipboardSettings = Pick<ClopSettings, 'optimiseVideoClipboard' | 'optimisePDFClipboard' | 'optimiseAudioClipboard' | 'optimiseImagePathClipboard' | 'imageFormatsToSkip' | 'videoFormatsToSkip' | 'audioFormatsToSkip' | 'clipboardIgnoredAppBundleIds'>;

/** Whether an automatic clipboard optimisation takes a file of this kind, by the per-type clipboard settings (`handleClipboardChange` in ClopApp.swift). */
export function takesFile(kind: MediaKind, file: string, settings: ClipboardSettings, { bitmap = false } = {}) {
  const skips = (list: readonly string[]) => skipsFormat(list, file);
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
export function clipboardFiles(files: readonly string[], { manual, bitmap, settings, owns, platform = process.platform }: { manual: boolean; bitmap: boolean; settings: ClipboardSettings; owns: (file: string) => boolean; platform?: NodeJS.Platform }) {
  const media = files.filter(file => !TEMPORARY.test(path.basename(file)) && mediaKind(file));
  const wanted = media.filter(file => manual || (!owns(file) && takesFile(mediaKind(file)!, file, settings, { bitmap })));
  // Any app can put a network path in a file list, and following one makes Windows authenticate to that host, so automatic
  // optimisation takes drive paths only, mapped network drives included. `remote` lists the rest for a notice.
  const take = wanted.filter(file => manual || isLocalPath(file, platform));
  return { files: take, media: media.length > 0, remote: wanted.filter(file => !take.includes(file)) };
}

export type ClipboardText = { type: 'path'; path: string } | { type: 'image'; bytes: Buffer; ext: string } | { type: 'url'; url: string };
const DATA_URL = /^(?:url\(\s*["']?)?data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)["']?\s*\)?$/i;
const BASE64 = /^[a-z0-9+/\s]+={0,2}$/i;
/** The image format of decoded base64 text by its signature, for text that is an image without a data URL around it. */
function imageSignature(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (bytes.toString('latin1', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(bytes.toString('latin1', 8, 12))) return 'avif';
  if (bytes.toString('latin1', 4, 8) === 'ftyp' && /^(heic|heix|mif1)$/.test(bytes.toString('latin1', 8, 12))) return 'heic';
}
/**
 * What copied text holds, as `ClipboardType.fromString` reads it: an absolute file path (quoted or as a `file:` URL) and,
 * for a `manual` optimisation only, an image as a base64 data URL or bare base64, or an http(s) link. Automatic
 * optimisation never decodes long text: a path is short.
 */
export function parseClipboardText(text: string, platform: NodeJS.Platform = process.platform, { manual = false } = {}): ClipboardText | undefined {
  if (text.length > (manual ? MAX_DATA_URL : MAX_PATH + 2)) return;
  const value = text.trim().replace(/^"(.*)"$/s, '$1').trim();
  if (manual) {
    const data = DATA_URL.exec(value);
    if (data) {
      const bytes = Buffer.from(data[2].replace(/\s+/g, ''), 'base64');
      return bytes.length ? { type: 'image', bytes, ext: data[1].toLowerCase() === 'svg+xml' ? 'svg' : data[1].toLowerCase() } : undefined;
    }
    if (value.length >= 16 && BASE64.test(value)) {
      const bytes = Buffer.from(value.replace(/\s+/g, ''), 'base64'), ext = imageSignature(bytes);
      if (ext) return { type: 'image', bytes, ext };
    }
  }
  if (!value || value.length > MAX_PATH || /[\r\n]/.test(value)) return;
  if (/^file:/i.test(value)) { try { return { type: 'path', path: fileURLToPath(value, { windows: platform === 'win32' }) }; } catch { return; } }
  if (platform === 'win32' ? /^([a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value) : value.startsWith('/')) return { type: 'path', path: value };
  if (manual && /^https?:\/\/\S+$/i.test(value)) { try { return { type: 'url', url: new URL(value).href }; } catch { return; } }
}

/**
 * Whether a path is on this computer: a drive path on Windows. UNC paths (`\\host\share`, also from `file://host/…`) and
 * device paths (`\\.\…`, `\\?\…`) are not; merely looking one up makes Windows contact that host and offer it the user's
 * credentials, so automatic optimisation never touches them.
 */
export const isLocalPath = (file: string, platform: NodeJS.Platform = process.platform) => platform === 'win32' ? /^[a-z]:[\\/]/i.test(file) : file.startsWith('/') && !file.startsWith('//');

/**
 * The media kind of a copied path when it should be optimised, decided without touching the file system: a manual
 * optimisation takes any media path, an automatic one only a local path that is not Clop's own and whose type its setting allows.
 */
export function textPathKind(file: string, { manual, settings, owns, platform = process.platform }: { manual: boolean; settings: ClipboardSettings; owns: (file: string) => boolean; platform?: NodeJS.Platform }) {
  const kind = mediaKind(file);
  if (!kind || TEMPORARY.test(path.basename(file))) return;
  if (manual) return kind;
  return isLocalPath(file, platform) && !owns(file) && takesFile(kind, file, settings) ? kind : undefined;
}

export type ClipboardSnapshot = ClipboardChange & { owned?: boolean; transient?: boolean };
/** A clipboard change or snapshot from the Windows helper, checked field by field. Undefined when it is malformed. */
export function clipboardChange(event: unknown): ClipboardSnapshot | undefined {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  const flag = (key: string) => e[key] === undefined || typeof e[key] === 'boolean';
  if (!isSequence(e.sequence) || !Array.isArray(e.paths) || e.paths.length > MAX_FILES) return;
  if (!e.paths.every(file => typeof file === 'string' && file.length > 0 && file.length <= MAX_PATH && path.isAbsolute(file))) return;
  if (!['image', 'bitmap', 'text', 'owned', 'transient'].every(flag)) return;
  if (e.process !== undefined && !Number.isSafeInteger(e.process)) return;
  if (e.app !== undefined && typeof e.app !== 'string') return;
  if (![e.owner, e.aumid].every(value => value === undefined || (typeof value === 'string' && value.length <= MAX_PATH))) return;
  return {
    sequence: e.sequence as number, paths: e.paths as string[], image: e.image === true, bitmap: e.bitmap === true, text: e.text === true,
    ...(e.process === undefined ? {} : { process: e.process as number }), ...(e.app === undefined ? {} : { app: e.app as string }),
    ...(e.owner ? { owner: e.owner as string } : {}), ...(e.aumid ? { aumid: e.aumid as string } : {}),
    ...(e.owned === undefined ? {} : { owned: e.owned as boolean }), ...(e.transient === undefined ? {} : { transient: e.transient as boolean }),
  };
}
const isSequence = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** The clipboard sequence number in a `sequence` reply from the Windows helper. */
export function sequenceReply(reply: unknown): number {
  const sequence = (reply as Record<string, unknown> | null)?.sequence;
  if (!isSequence(sequence)) throw new Error('The Windows helper sent an unreadable clipboard sequence.');
  return sequence;
}
/** A `copy` reply: skipped because the clipboard changed meanwhile, or written with the clipboard's new sequence number. */
export function copyReply(reply: unknown): { skipped: true } | { skipped: false; sequence: number } {
  const r = reply as Record<string, unknown> | null;
  if (r?.skipped === true) return { skipped: true };
  if (r?.skipped !== undefined && r?.skipped !== false) throw new Error('The Windows helper sent an unreadable clipboard reply.');
  return { skipped: false, sequence: sequenceReply(reply) };
}

/** What the clipboard watcher remembers between changes: the last sequence it handled, and what it last optimised and wrote. */
export interface ClipboardMemory { sequence?: number; fingerprint: string; own: string }
export interface IntakeSources {
  settings: ClipboardSettings;
  owns: (file: string) => boolean;
  platform?: NodeJS.Platform;
  /** A snapshot from the Windows helper; undefined without one. */
  read: () => Promise<ClipboardSnapshot | undefined>;
  image: () => Promise<Buffer>;
  text: () => Promise<string>;
  isFile: (file: string) => Promise<boolean>;
  /** Recognises files by path, size and modification time. */
  fingerprint: (files: string[]) => Promise<string>;
  hash: (bytes: Buffer) => string;
}
export type ClipboardPlan =
  | { type: 'files'; files: string[]; sequence?: number; text?: boolean }
  | { type: 'image'; bytes: Buffer; ext: string; sequence?: number }
  | { type: 'url'; url: string; sequence?: number }
  /** The clipboard changed while it was read; look at the newer change instead. */
  | { type: 'retry'; change: ClipboardSnapshot }
  | { type: 'none'; notice?: string };

const pathSettings = (s: ClipboardSettings) => s.optimiseImagePathClipboard || s.optimiseVideoClipboard || s.optimisePDFClipboard || s.optimiseAudioClipboard;
/**
 * Decides what to optimise from the clipboard, in the order of `handleClipboardChange` (ClopApp.swift): files of each
 * type the settings allow, then image data, then a copied path. A manual optimisation takes any media file and also
 * copied data-URL images and links. Settings are checked before a copied path is looked up. An automatic optimisation
 * leaves alone what an app in `clipboardIgnoredAppBundleIds` copied.
 */
export async function clipboardIntake(change: ClipboardSnapshot | undefined, manual: boolean, memory: ClipboardMemory, sources: IntakeSources): Promise<ClipboardPlan> {
  const { settings, owns } = sources, none = { type: 'none' } as const;
  let snapshot = change;
  if (!snapshot) {
    snapshot = await sources.read();
    // Content its app marked private, as password managers do, is never read, even on request.
    if (snapshot?.transient) return manual ? { type: 'none', notice: 'The app that copied this marked it private, so Clop leaves it alone.' } : none;
    if (!manual && snapshot?.owned) return none;
  }
  const sequence = snapshot?.sequence;
  if (!manual && sequence !== undefined && sequence === memory.sequence) return none;
  if (sequence !== undefined) memory.sequence = sequence;
  if (!manual && snapshot && ignoredApp(snapshot, settings.clipboardIgnoredAppBundleIds)) return none;
  const listed = clipboardFiles(snapshot?.paths ?? [], { manual, bitmap: !!snapshot?.bitmap, settings, owns, platform: sources.platform });
  if (listed.files.length) {
    if (!manual) {
      const hash = await sources.fingerprint(listed.files);
      if (hash === memory.fingerprint) return none;
      memory.fingerprint = hash;
    }
    return { type: 'files', files: listed.files, sequence };
  }
  if (listed.media && !manual) {
    // Another copy came between, so copying the last optimised file again optimises it again.
    memory.fingerprint = ''; memory.own = '';
    return listed.remote.length ? { type: 'none', notice: `${path.basename(listed.remote[0])} is on a network share. Clop only opens network paths when asked: press Ctrl+Shift+C to optimise it.` } : none;
  }
  const bytes = !snapshot || snapshot.bitmap ? await sources.image() : Buffer.alloc(0);
  const text = !bytes.length && (!snapshot || snapshot.text) && (manual || pathSettings(settings)) ? parseClipboardText(await sources.text(), sources.platform, { manual }) : undefined;
  const file = text?.type === 'path' && textPathKind(text.path, { manual, settings, owns, platform: sources.platform }) && await sources.isFile(text.path) ? text.path : undefined;
  let pathHash = '';
  if (!manual && !bytes.length) {
    // Anything else on the clipboard, such as text between two copies of one image, lets that image be optimised again.
    if (!file) { memory.fingerprint = ''; memory.own = ''; return none; }
    pathHash = await sources.fingerprint([file]);
    if (pathHash === memory.fingerprint) return none;
  }
  // Reading a delayed image format can change the sequence, and a new copy may arrive while the clipboard is read.
  if (!manual && sequence !== undefined) {
    const now = await sources.read();
    if (now && (now.owned || now.transient)) return none;
    if (now && now.sequence !== sequence) return { type: 'retry', change: now };
  }
  if (bytes.length) {
    const hash = sources.hash(bytes);
    if (!manual && (hash === memory.fingerprint || hash === memory.own || !takesFile('image', 'clipboard.png', settings, { bitmap: true }))) return none;
    memory.fingerprint = hash;
    return { type: 'image', bytes, ext: 'png', sequence };
  }
  if (file) {
    if (!manual) { memory.fingerprint = pathHash; memory.own = ''; }
    return { type: 'files', files: [file], sequence, text: true };
  }
  if (text?.type === 'image') return { type: 'image', bytes: text.bytes, ext: text.ext, sequence };
  if (text?.type === 'url') return { type: 'url', url: text.url, sequence };
  return manual ? { type: 'none', notice: 'Copy an image, a video, a PDF or an audio file, or its path or link, then try again.' } : none;
}

/**
 * Reads the clipboard one change at a time and never drops a change. The import a read starts runs on its own, so a
 * long video encode never holds up the next copy; each kind's queue in the engine orders the work.
 */
export class ClipboardIntake {
  private chain: Promise<void> = Promise.resolve();
  private running = new Set<Promise<void>>();
  constructor(private report: (error: unknown) => void) {}
  /** Queues `read`, which returns the import to start, if any. Resolves once the read is done. */
  submit(read: () => Promise<(() => Promise<unknown>) | void>): Promise<void> {
    const step = this.chain.then(async () => {
      const work = await read();
      if (!work) return;
      const job: Promise<void> = work().then(() => {}, this.report).finally(() => this.running.delete(job));
      this.running.add(job);
    }).catch(this.report);
    return this.chain = step;
  }
  /** Resolves when every queued read and the imports they started have finished. */
  async idle() { while (true) { const pending = [this.chain, ...this.running]; await Promise.all(pending); if (!this.running.size && pending[0] === this.chain) return; } }
}

/** Runs tasks one after another; one that fails does not stop the next. */
export function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => { const run = chain.then(task, task); chain = run.catch(() => {}); return run; };
}
/**
 * The earlier clipboard images a new one replaces, as macOS reuses its one clipboard result: all of them, unless
 * `appendClipboardResults` keeps them, and then only once `clipboardAccumulationTimeout` seconds passed since the newest.
 */
export function replacedClipboardImages(items: readonly Pick<ItemResult, 'id' | 'source' | 'kind' | 'createdAt'>[], settings: Pick<ClopSettings, 'appendClipboardResults' | 'clipboardAccumulationTimeout'>, now = Date.now()) {
  const previous = items.filter(item => item.source === 'clipboard' && item.kind === 'image');
  const timeout = settings.clipboardAccumulationTimeout * 1000;
  if (!previous.length || (settings.appendClipboardResults && !(timeout > 0 && now - Math.max(...previous.map(item => item.createdAt)) > timeout))) return [];
  return previous.map(item => item.id);
}

export interface ClipboardListSteps {
  /** The clipboard images' turn (see `serial`). */
  turn: <T>(task: () => Promise<T>) => Promise<T>;
  /** Makes way for new clipboard images. */
  prepare: () => Promise<void>;
  /** Imports files, returning the results that finished. */
  load: (files: string[]) => Promise<string[]>;
  /** Puts finished results back on the clipboard. */
  writeBack: (ids: string[]) => Promise<void>;
}
/** Imports clipboard images in their turn: earlier clipboard images make way, then `load` imports, then, unless `writeBack` is false, the results go back on the clipboard before the next turn. */
export function importClipboardImages(steps: ClipboardListSteps, load: () => Promise<string[]>, { writeBack = true } = {}) {
  return steps.turn(async () => {
    await steps.prepare();
    const ids = await load();
    if (writeBack) await steps.writeBack(ids);
    return ids;
  });
}
/**
 * Imports a copied file list. Its images take the clipboard images' turn (`importClipboardImages`). Videos, PDFs and
 * audio import outside it, so a long video in the list never holds up a later screenshot; a mixed list goes back on the
 * clipboard together once all of it is done.
 */
export async function importClipboardList(files: string[], steps: ClipboardListSteps) {
  const images = files.filter(file => mediaKind(file) === 'image'), others = files.filter(file => mediaKind(file) !== 'image');
  const [imageIds, otherIds] = await Promise.all([
    images.length ? importClipboardImages(steps, () => steps.load(images), { writeBack: !others.length }) : [],
    others.length ? steps.load(others) : [],
  ]);
  if (others.length) await steps.writeBack([...imageIds, ...otherIds]);
}
